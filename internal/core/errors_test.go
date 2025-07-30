package core

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest"
)

// TestNewError tests error creation
func TestNewError(t *testing.T) {
	t.Parallel()
	
	tests := []struct {
		name     string
		code     string
		message  string
		category string
		severity int
		validate func(t *testing.T, err *OtedamaError)
	}{
		{
			name:     "basic error",
			code:     "TEST_ERROR",
			message:  "This is a test error",
			category: ErrorCategoryInternal,
			severity: ErrorSeverityMedium,
			validate: func(t *testing.T, err *OtedamaError) {
				assert.Equal(t, "TEST_ERROR", err.Code)
				assert.Equal(t, "This is a test error", err.Message)
				assert.Equal(t, ErrorCategoryInternal, err.Category)
				assert.Equal(t, ErrorSeverityMedium, err.Severity)
				assert.NotEmpty(t, err.StackTrace)
				assert.False(t, err.Timestamp.IsZero())
				assert.False(t, err.Retryable)
				assert.NotNil(t, err.Context)
			},
		},
		{
			name:     "network error",
			code:     "NET_CONN_FAILED",
			message:  "Failed to connect to peer",
			category: ErrorCategoryNetwork,
			severity: ErrorSeverityHigh,
			validate: func(t *testing.T, err *OtedamaError) {
				assert.Equal(t, ErrorCategoryNetwork, err.Category)
				assert.Equal(t, ErrorSeverityHigh, err.Severity)
			},
		},
		{
			name:     "mining error",
			code:     "MINING_GPU_FAILURE",
			message:  "GPU device not found",
			category: ErrorCategoryMining,
			severity: ErrorSeverityCritical,
			validate: func(t *testing.T, err *OtedamaError) {
				assert.Equal(t, ErrorCategoryMining, err.Category)
				assert.Equal(t, ErrorSeverityCritical, err.Severity)
			},
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			
			err := NewError(tt.code, tt.message, tt.category, tt.severity)
			assert.NotNil(t, err)
			tt.validate(t, err)
		})
	}
}

// TestErrorMethods tests error method chaining
func TestErrorMethods(t *testing.T) {
	t.Parallel()
	
	t.Run("with cause", func(t *testing.T) {
		cause := errors.New("underlying cause")
		err := NewError("TEST", "test error", ErrorCategoryInternal, ErrorSeverityMedium).
			WithCause(cause)
		
		assert.Equal(t, cause, err.Cause)
		assert.Contains(t, err.Error(), "underlying cause")
		assert.Equal(t, cause, err.Unwrap())
	})

	t.Run("with context", func(t *testing.T) {
		err := NewError("TEST", "test error", ErrorCategoryInternal, ErrorSeverityMedium).
			WithContext("user_id", "123").
			WithContext("operation", "mining").
			WithContext("attempts", 3)
		
		assert.Equal(t, "123", err.Context["user_id"])
		assert.Equal(t, "mining", err.Context["operation"])
		assert.Equal(t, 3, err.Context["attempts"])
	})

	t.Run("with retry", func(t *testing.T) {
		retryAfter := 5 * time.Second
		err := NewError("TEST", "test error", ErrorCategoryNetwork, ErrorSeverityMedium).
			WithRetry(retryAfter)
		
		assert.True(t, err.Retryable)
		assert.Equal(t, retryAfter, err.RetryAfter)
	})

	t.Run("method chaining", func(t *testing.T) {
		cause := errors.New("root cause")
		err := NewError("CHAIN_TEST", "chained error", ErrorCategoryP2P, ErrorSeverityHigh).
			WithCause(cause).
			WithContext("peer_id", "peer123").
			WithContext("attempt", 1).
			WithRetry(10 * time.Second)
		
		assert.Equal(t, "CHAIN_TEST", err.Code)
		assert.Equal(t, cause, err.Cause)
		assert.Equal(t, "peer123", err.Context["peer_id"])
		assert.True(t, err.Retryable)
		assert.Equal(t, 10*time.Second, err.RetryAfter)
	})
}

// TestErrorString tests error string formatting
func TestErrorString(t *testing.T) {
	t.Parallel()
	
	tests := []struct {
		name     string
		err      *OtedamaError
		expected string
	}{
		{
			name: "error without cause",
			err: NewError("TEST_ERROR", "Something went wrong", ErrorCategoryInternal, ErrorSeverityMedium),
			expected: "[internal:TEST_ERROR] Something went wrong",
		},
		{
			name: "error with cause",
			err: NewError("TEST_ERROR", "Operation failed", ErrorCategoryNetwork, ErrorSeverityHigh).
				WithCause(errors.New("connection refused")),
			expected: "[network:TEST_ERROR] Operation failed: connection refused",
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			
			assert.Equal(t, tt.expected, tt.err.Error())
		})
	}
}

// TestErrorHandler tests the error handler
func TestErrorHandler(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	handler := NewErrorHandler(logger)
	
	t.Run("basic error handling", func(t *testing.T) {
		ctx := context.Background()
		err := NewError("TEST", "test error", ErrorCategoryInternal, ErrorSeverityLow)
		
		handledErr := handler.Handle(ctx, err)
		assert.Equal(t, err, handledErr)
		
		// Check metrics
		metrics := handler.GetMetrics()
		assert.Greater(t, metrics.TotalErrors, uint64(0))
	})

	t.Run("handle with recovery", func(t *testing.T) {
		ctx := context.Background()
		
		// Register a recovery function
		handler.RegisterRecoveryFunc(ErrorCategoryNetwork, func(ctx context.Context, err error) error {
			// Simulate successful recovery
			return nil
		})
		
		err := NewError("NET_ERROR", "network error", ErrorCategoryNetwork, ErrorSeverityMedium)
		handledErr := handler.Handle(ctx, err)
		
		// Should return nil after successful recovery
		assert.Nil(t, handledErr)
	})

	t.Run("handle with failed recovery", func(t *testing.T) {
		ctx := context.Background()
		
		// Register a recovery function that fails
		handler.RegisterRecoveryFunc(ErrorCategoryStorage, func(ctx context.Context, err error) error {
			return errors.New("recovery failed")
		})
		
		err := NewError("STORAGE_ERROR", "storage error", ErrorCategoryStorage, ErrorSeverityHigh)
		handledErr := handler.Handle(ctx, err)
		
		// Should return error after failed recovery
		assert.NotNil(t, handledErr)
		assert.Contains(t, handledErr.Error(), "recovery failed")
	})
}

// TestErrorMetrics tests error metrics collection
func TestErrorMetrics(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	handler := NewErrorHandler(logger)
	ctx := context.Background()
	
	// Generate various errors
	categories := []string{
		ErrorCategoryNetwork,
		ErrorCategoryMining,
		ErrorCategoryValidation,
		ErrorCategoryP2P,
	}
	
	severities := []int{
		ErrorSeverityLow,
		ErrorSeverityMedium,
		ErrorSeverityHigh,
		ErrorSeverityCritical,
	}
	
	for i := 0; i < 100; i++ {
		category := categories[i%len(categories)]
		severity := severities[i%len(severities)]
		
		err := NewError(fmt.Sprintf("TEST_%d", i), "test error", category, severity)
		handler.Handle(ctx, err)
	}
	
	metrics := handler.GetMetrics()
	assert.Equal(t, uint64(100), metrics.TotalErrors)
	assert.Greater(t, metrics.ErrorsByCategory[ErrorCategoryNetwork], uint64(0))
	assert.Greater(t, metrics.ErrorsByCategory[ErrorCategoryMining], uint64(0))
	assert.Greater(t, metrics.ErrorsBySeverity[ErrorSeverityLow], uint64(0))
	assert.Greater(t, metrics.ErrorsBySeverity[ErrorSeverityCritical], uint64(0))
}

// TestRecoveryManager tests the recovery manager
func TestRecoveryManager(t *testing.T) {
	logger := zaptest.NewLogger(t)
	errorHandler := NewErrorHandler(logger)
	manager := NewRecoveryManager(logger, errorHandler)
	
	t.Run("register and execute health checks", func(t *testing.T) {
		// Register health checks
		check1 := &MockHealthCheck{
			name:     "test_check_1",
			healthy:  true,
			critical: false,
		}
		check2 := &MockHealthCheck{
			name:     "test_check_2",
			healthy:  true,
			critical: true,
		}
		
		manager.RegisterHealthCheck(check1)
		manager.RegisterHealthCheck(check2)
		
		ctx := context.Background()
		manager.Start(ctx)
		
		// Give time for health checks to run
		time.Sleep(100 * time.Millisecond)
		
		assert.True(t, check1.checked.Load())
		assert.True(t, check2.checked.Load())
		
		manager.Stop()
	})

	t.Run("handle unhealthy check", func(t *testing.T) {
		unhealthyCheck := &MockHealthCheck{
			name:     "unhealthy_check",
			healthy:  false,
			critical: true,
			err:      errors.New("service down"),
		}
		
		manager.RegisterHealthCheck(unhealthyCheck)
		
		ctx := context.Background()
		manager.Start(ctx)
		
		// Give time for health check to fail
		time.Sleep(100 * time.Millisecond)
		
		assert.True(t, unhealthyCheck.checked.Load())
		
		// Check if error was handled
		metrics := errorHandler.GetMetrics()
		assert.Greater(t, metrics.TotalErrors, uint64(0))
		
		manager.Stop()
	})
}

// TestPanicRecovery tests panic recovery functionality
func TestPanicRecovery(t *testing.T) {
	logger := zaptest.NewLogger(t)
	
	t.Run("recover from panic", func(t *testing.T) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatal("Panic was not recovered")
			}
		}()
		
		// Function that will panic
		dangerousFunc := func() {
			defer PanicRecovery(logger)
			panic("test panic")
		}
		
		// Should not panic due to recovery
		dangerousFunc()
	})
}

// TestConcurrentErrorHandling tests thread safety
func TestConcurrentErrorHandling(t *testing.T) {
	logger := zaptest.NewLogger(t)
	handler := NewErrorHandler(logger)
	ctx := context.Background()
	
	var wg sync.WaitGroup
	numGoroutines := 100
	
	// Concurrent error handling
	wg.Add(numGoroutines)
	for i := 0; i < numGoroutines; i++ {
		go func(id int) {
			defer wg.Done()
			
			err := NewError(
				fmt.Sprintf("CONCURRENT_%d", id),
				"concurrent error",
				ErrorCategoryInternal,
				ErrorSeverityMedium,
			).WithContext("goroutine", id)
			
			handler.Handle(ctx, err)
		}(i)
	}
	
	wg.Wait()
	
	metrics := handler.GetMetrics()
	assert.Equal(t, uint64(numGoroutines), metrics.TotalErrors)
}

// TestErrorCategories tests all error categories
func TestErrorCategories(t *testing.T) {
	t.Parallel()
	
	categories := []string{
		ErrorCategoryNetwork,
		ErrorCategoryStorage,
		ErrorCategoryMining,
		ErrorCategoryValidation,
		ErrorCategoryP2P,
		ErrorCategoryAuth,
		ErrorCategoryInternal,
		ErrorCategoryConfiguration,
	}
	
	for _, category := range categories {
		t.Run(category, func(t *testing.T) {
			err := NewError("TEST", "test error", category, ErrorSeverityMedium)
			assert.Equal(t, category, err.Category)
			assert.Contains(t, err.Error(), category)
		})
	}
}

// TestErrorSeverities tests all error severities
func TestErrorSeverities(t *testing.T) {
	t.Parallel()
	
	severities := map[string]int{
		"low":      ErrorSeverityLow,
		"medium":   ErrorSeverityMedium,
		"high":     ErrorSeverityHigh,
		"critical": ErrorSeverityCritical,
	}
	
	for name, severity := range severities {
		t.Run(name, func(t *testing.T) {
			err := NewError("TEST", "test error", ErrorCategoryInternal, severity)
			assert.Equal(t, severity, err.Severity)
		})
	}
}

// TestCommonErrors tests predefined common errors
func TestCommonErrors(t *testing.T) {
	t.Parallel()
	
	commonErrors := []error{
		ErrInvalidConfiguration,
		ErrResourceExhausted,
		ErrOperationTimeout,
		ErrServiceUnavailable,
		ErrInvalidInput,
		ErrNotFound,
		ErrAlreadyExists,
		ErrPermissionDenied,
		ErrNetworkFailure,
		ErrDataCorruption,
	}
	
	for _, err := range commonErrors {
		t.Run(err.Error(), func(t *testing.T) {
			assert.Error(t, err)
			assert.NotEmpty(t, err.Error())
		})
	}
}

// TestStackTrace tests stack trace capture
func TestStackTrace(t *testing.T) {
	t.Parallel()
	
	err := NewError("STACK_TEST", "test error", ErrorCategoryInternal, ErrorSeverityMedium)
	
	assert.NotEmpty(t, err.StackTrace)
	assert.Contains(t, err.StackTrace, "TestStackTrace")
	assert.Contains(t, err.StackTrace, "errors_test.go")
}

// TestErrorWrapping tests error wrapping with standard errors
func TestErrorWrapping(t *testing.T) {
	t.Parallel()
	
	t.Run("wrap standard error", func(t *testing.T) {
		stdErr := errors.New("standard error")
		otedamaErr := NewError("WRAP_TEST", "wrapped error", ErrorCategoryInternal, ErrorSeverityMedium).
			WithCause(stdErr)
		
		assert.True(t, errors.Is(otedamaErr, stdErr))
		assert.Equal(t, stdErr, errors.Unwrap(otedamaErr))
	})

	t.Run("wrap otedama error", func(t *testing.T) {
		innerErr := NewError("INNER", "inner error", ErrorCategoryNetwork, ErrorSeverityLow)
		outerErr := NewError("OUTER", "outer error", ErrorCategoryInternal, ErrorSeverityHigh).
			WithCause(innerErr)
		
		assert.Equal(t, innerErr, outerErr.Unwrap())
		assert.Contains(t, outerErr.Error(), "inner error")
	})
}

// Mock types for testing
type MockHealthCheck struct {
	name     string
	healthy  bool
	critical bool
	err      error
	checked  atomic.Bool
}

func (m *MockHealthCheck) Name() string {
	return m.name
}

func (m *MockHealthCheck) Check(ctx context.Context) error {
	m.checked.Store(true)
	if !m.healthy {
		return m.err
	}
	return nil
}

func (m *MockHealthCheck) Critical() bool {
	return m.critical
}

// Benchmark tests
func BenchmarkNewError(b *testing.B) {
	for i := 0; i < b.N; i++ {
		_ = NewError("BENCH_ERROR", "benchmark error", ErrorCategoryInternal, ErrorSeverityMedium)
	}
}

func BenchmarkErrorWithContext(b *testing.B) {
	for i := 0; i < b.N; i++ {
		_ = NewError("BENCH_ERROR", "benchmark error", ErrorCategoryInternal, ErrorSeverityMedium).
			WithContext("iteration", i).
			WithContext("timestamp", time.Now()).
			WithContext("data", "test data")
	}
}

func BenchmarkErrorHandling(b *testing.B) {
	logger := zap.NewNop()
	handler := NewErrorHandler(logger)
	ctx := context.Background()
	
	err := NewError("BENCH_ERROR", "benchmark error", ErrorCategoryInternal, ErrorSeverityMedium)
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = handler.Handle(ctx, err)
	}
}

func BenchmarkConcurrentErrorHandling(b *testing.B) {
	logger := zap.NewNop()
	handler := NewErrorHandler(logger)
	ctx := context.Background()
	
	b.RunParallel(func(pb *testing.PB) {
		i := 0
		for pb.Next() {
			err := NewError(
				fmt.Sprintf("BENCH_%d", i),
				"benchmark error",
				ErrorCategoryInternal,
				ErrorSeverityMedium,
			)
			_ = handler.Handle(ctx, err)
			i++
		}
	})
}

// TestEdgeCases tests edge cases
func TestEdgeCases(t *testing.T) {
	t.Parallel()
	
	t.Run("nil error handler", func(t *testing.T) {
		var handler *ErrorHandler
		err := NewError("TEST", "test", ErrorCategoryInternal, ErrorSeverityLow)
		
		// Should not panic
		result := handler.Handle(context.Background(), err)
		assert.Equal(t, err, result)
	})

	t.Run("empty error code", func(t *testing.T) {
		err := NewError("", "test error", ErrorCategoryInternal, ErrorSeverityMedium)
		assert.Empty(t, err.Code)
		assert.Contains(t, err.Error(), "test error")
	})

	t.Run("empty error message", func(t *testing.T) {
		err := NewError("TEST_CODE", "", ErrorCategoryInternal, ErrorSeverityMedium)
		assert.Empty(t, err.Message)
		assert.Contains(t, err.Error(), "TEST_CODE")
	})

	t.Run("invalid severity", func(t *testing.T) {
		err := NewError("TEST", "test", ErrorCategoryInternal, 999)
		assert.Equal(t, 999, err.Severity)
	})

	t.Run("nil context value", func(t *testing.T) {
		err := NewError("TEST", "test", ErrorCategoryInternal, ErrorSeverityMedium).
			WithContext("nil_value", nil)
		
		assert.Nil(t, err.Context["nil_value"])
	})
}