package core

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

func TestNewRecoveryManager(t *testing.T) {
	logger := zap.NewNop()
	rm := NewRecoveryManager(logger)
	
	assert.NotNil(t, rm)
	assert.NotNil(t, rm.logger)
	assert.NotNil(t, rm.components)
	assert.NotNil(t, rm.healthChecks)
}

func TestRecoveryManager_RegisterComponent(t *testing.T) {
	logger := zap.NewNop()
	rm := NewRecoveryManager(logger)
	
	err := rm.RegisterComponent("test-component")
	assert.NoError(t, err)
	
	// Register same component again should fail
	err = rm.RegisterComponent("test-component")
	assert.Error(t, err)
}

func TestRecoveryManager_RecoverComponent(t *testing.T) {
	logger := zap.NewNop()
	rm := NewRecoveryManager(logger)
	
	// Register component first
	err := rm.RegisterComponent("test-component")
	require.NoError(t, err)
	
	// Set recovery handler
	rm.SetRecoveryHandler("test-component", func(ctx context.Context) error {
		return nil
	})
	
	// Test recovery
	ctx := context.Background()
	err = rm.RecoverComponent(ctx, "test-component")
	assert.NoError(t, err)
}

func TestRecoveryManager_RecoverWithRetry(t *testing.T) {
	logger := zap.NewNop()
	rm := NewRecoveryManager(logger)
	
	attempts := 0
	recoverFunc := func() error {
		attempts++
		if attempts < 2 {
			return errors.New("recovery failed")
		}
		return nil
	}
	
	ctx := context.Background()
	err := rm.RecoverWithRetry(ctx, recoverFunc, 3)
	
	assert.NoError(t, err)
	assert.Equal(t, 2, attempts)
}

func TestRecoveryManager_RecoverWithRetry_MaxAttempts(t *testing.T) {
	logger := zap.NewNop()
	rm := NewRecoveryManager(logger)
	
	recoverFunc := func() error {
		return errors.New("always fails")
	}
	
	ctx := context.Background()
	err := rm.RecoverWithRetry(ctx, recoverFunc, 3)
	
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "max retry attempts")
}

func TestRecoveryManager_StartHealthMonitoring(t *testing.T) {
	logger := zap.NewNop()
	rm := NewRecoveryManager(logger)
	
	// Register component
	err := rm.RegisterComponent("test-component")
	require.NoError(t, err)
	
	// Set health check
	healthy := true
	rm.SetHealthCheck("test-component", func(ctx context.Context) error {
		if !healthy {
			return errors.New("unhealthy")
		}
		return nil
	})
	
	// Start monitoring
	rm.StartHealthMonitoring()
	
	// Let it run
	time.Sleep(100 * time.Millisecond)
	
	// Stop monitoring
	rm.Shutdown()
}

func TestCircuitBreaker_Allow(t *testing.T) {
	cb := &CircuitBreaker{
		maxFailures:  3,
		timeout:      100 * time.Millisecond,
		state:        StateClosed,
		failures:     0,
	}
	
	// Should allow when closed
	assert.True(t, cb.Allow())
	
	// Record failures
	cb.RecordFailure()
	cb.RecordFailure()
	cb.RecordFailure()
	
	// Should not allow when open
	assert.False(t, cb.Allow())
	
	// Wait for timeout
	time.Sleep(150 * time.Millisecond)
	
	// Should allow in half-open state
	assert.True(t, cb.Allow())
}

func TestCircuitBreaker_RecordSuccess(t *testing.T) {
	cb := &CircuitBreaker{
		maxFailures:  3,
		timeout:      100 * time.Millisecond,
		state:        StateOpen,
		failures:     3,
		lastFailTime: time.Now(),
	}
	
	// Wait for timeout to move to half-open
	time.Sleep(150 * time.Millisecond)
	
	// Allow should return true (half-open)
	assert.True(t, cb.Allow())
	
	// Record success
	cb.RecordSuccess()
	
	// Should be closed now
	assert.Equal(t, StateClosed, cb.state)
	assert.Equal(t, 0, cb.failures)
}

func TestErrorClassifier_Classify(t *testing.T) {
	ec := NewErrorClassifier()
	
	tests := []struct {
		err      error
		expected ErrorSeverity
	}{
		{errors.New("connection refused"), SeverityHigh},
		{errors.New("timeout"), SeverityMedium},
		{errors.New("invalid input"), SeverityLow},
		{context.Canceled, SeverityLow},
	}
	
	for _, tt := range tests {
		severity := ec.Classify(tt.err)
		assert.Equal(t, tt.expected, severity)
	}
}

func TestErrorClassifier_ShouldRecover(t *testing.T) {
	ec := NewErrorClassifier()
	
	tests := []struct {
		err      error
		expected bool
	}{
		{errors.New("connection refused"), true},
		{errors.New("timeout"), true},
		{errors.New("invalid configuration"), false},
		{context.Canceled, false},
	}
	
	for _, tt := range tests {
		shouldRecover := ec.ShouldRecover(tt.err)
		assert.Equal(t, tt.expected, shouldRecover)
	}
}

func TestComponent_UpdateHealth(t *testing.T) {
	comp := &Component{
		Name:           "test",
		State:          StateHealthy,
		CircuitBreaker: NewCircuitBreaker(3, 100*time.Millisecond),
	}
	
	// Update to unhealthy
	comp.UpdateHealth(StateUnhealthy, errors.New("test error"))
	assert.Equal(t, StateUnhealthy, comp.State)
	assert.NotNil(t, comp.LastError)
	assert.Equal(t, 1, comp.ErrorCount)
	
	// Update to healthy
	comp.UpdateHealth(StateHealthy, nil)
	assert.Equal(t, StateHealthy, comp.State)
	assert.Equal(t, 0, comp.ErrorCount)
}

func BenchmarkRecoveryManager_RecoverWithRetry(b *testing.B) {
	logger := zap.NewNop()
	rm := NewRecoveryManager(logger)
	
	recoverFunc := func() error {
		return nil
	}
	
	ctx := context.Background()
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = rm.RecoverWithRetry(ctx, recoverFunc, 3)
	}
}

func BenchmarkCircuitBreaker_Allow(b *testing.B) {
	cb := NewCircuitBreaker(3, 100*time.Millisecond)
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = cb.Allow()
	}
}