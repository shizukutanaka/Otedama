package testing

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest"
)

// TestFramework provides unified testing utilities
type TestFramework struct {
	T      *testing.T
	Logger *zap.Logger
	Assert *assert.Assertions
	Require *require.Assertions
	Ctx    context.Context
	Cancel context.CancelFunc
}

// NewTestFramework creates a new test framework instance
func NewTestFramework(t *testing.T) *TestFramework {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	
	return &TestFramework{
		T:       t,
		Logger:  zaptest.NewLogger(t),
		Assert:  assert.New(t),
		Require: require.New(t),
		Ctx:     ctx,
		Cancel:  cancel,
	}
}

// Cleanup performs test cleanup
func (tf *TestFramework) Cleanup() {
	tf.Cancel()
}

// HTTPRequest creates a test HTTP request
func (tf *TestFramework) HTTPRequest(method, url string, body interface{}) *http.Request {
	var req *http.Request
	var err error
	
	if body != nil {
		// Handle JSON body if needed
		req, err = http.NewRequestWithContext(tf.Ctx, method, url, nil)
	} else {
		req, err = http.NewRequestWithContext(tf.Ctx, method, url, nil)
	}
	
	tf.Require.NoError(err)
	return req
}

// HTTPRecorder creates a test HTTP response recorder
func (tf *TestFramework) HTTPRecorder() *httptest.ResponseRecorder {
	return httptest.NewRecorder()
}

// AssertHTTPResponse asserts HTTP response properties
func (tf *TestFramework) AssertHTTPResponse(recorder *httptest.ResponseRecorder, expectedStatus int) {
	tf.Assert.Equal(expectedStatus, recorder.Code)
}

// AssertNoError asserts no error occurred
func (tf *TestFramework) AssertNoError(err error) {
	tf.Assert.NoError(err)
}

// AssertError asserts an error occurred
func (tf *TestFramework) AssertError(err error) {
	tf.Assert.Error(err)
}

// AssertEqual asserts two values are equal
func (tf *TestFramework) AssertEqual(expected, actual interface{}) {
	tf.Assert.Equal(expected, actual)
}

// AssertNotNil asserts value is not nil
func (tf *TestFramework) AssertNotNil(value interface{}) {
	tf.Assert.NotNil(value)
}

// AssertNil asserts value is nil
func (tf *TestFramework) AssertNil(value interface{}) {
	tf.Assert.Nil(value)
}

// AssertTrue asserts condition is true
func (tf *TestFramework) AssertTrue(condition bool) {
	tf.Assert.True(condition)
}

// AssertFalse asserts condition is false
func (tf *TestFramework) AssertFalse(condition bool) {
	tf.Assert.False(condition)
}

// AssertContains asserts container contains element
func (tf *TestFramework) AssertContains(container, element interface{}) {
	tf.Assert.Contains(container, element)
}

// RequireNoError requires no error occurred
func (tf *TestFramework) RequireNoError(err error) {
	tf.Require.NoError(err)
}

// RequireNotNil requires value is not nil
func (tf *TestFramework) RequireNotNil(value interface{}) {
	tf.Require.NotNil(value)
}

// RequireEqual requires two values are equal
func (tf *TestFramework) RequireEqual(expected, actual interface{}) {
	tf.Require.Equal(expected, actual)
}

// TestCase represents a test case for table-driven tests
type TestCase struct {
	Name     string
	Setup    func(*TestFramework)
	Execute  func(*TestFramework) error
	Assert   func(*TestFramework, error)
	Cleanup  func(*TestFramework)
}

// RunTestCases runs table-driven test cases
func (tf *TestFramework) RunTestCases(cases []TestCase) {
	for _, tc := range cases {
		tf.T.Run(tc.Name, func(t *testing.T) {
			subTF := NewTestFramework(t)
			defer subTF.Cleanup()
			
			// Setup
			if tc.Setup != nil {
				tc.Setup(subTF)
			}
			
			// Execute
			var err error
			if tc.Execute != nil {
				err = tc.Execute(subTF)
			}
			
			// Assert
			if tc.Assert != nil {
				tc.Assert(subTF, err)
			}
			
			// Cleanup
			if tc.Cleanup != nil {
				tc.Cleanup(subTF)
			}
		})
	}
}

// BenchmarkFramework provides utilities for benchmark tests
type BenchmarkFramework struct {
	B      *testing.B
	Logger *zap.Logger
}

// NewBenchmarkFramework creates a new benchmark framework
func NewBenchmarkFramework(b *testing.B) *BenchmarkFramework {
	return &BenchmarkFramework{
		B:      b,
		Logger: zap.NewNop(), // Silent logger for benchmarks
	}
}

// ResetTimer resets the benchmark timer
func (bf *BenchmarkFramework) ResetTimer() {
	bf.B.ResetTimer()
}

// StartTimer starts the benchmark timer
func (bf *BenchmarkFramework) StartTimer() {
	bf.B.StartTimer()
}

// StopTimer stops the benchmark timer
func (bf *BenchmarkFramework) StopTimer() {
	bf.B.StopTimer()
}

// ReportAllocs enables allocation reporting
func (bf *BenchmarkFramework) ReportAllocs() {
	bf.B.ReportAllocs()
}

// Integration test framework
type IntegrationTestFramework struct {
	*TestFramework
	Services map[string]interface{}
	Servers  map[string]*httptest.Server
}

// NewIntegrationTestFramework creates integration test framework
func NewIntegrationTestFramework(t *testing.T) *IntegrationTestFramework {
	return &IntegrationTestFramework{
		TestFramework: NewTestFramework(t),
		Services:      make(map[string]interface{}),
		Servers:       make(map[string]*httptest.Server),
	}
}

// AddService adds a service to the integration test
func (itf *IntegrationTestFramework) AddService(name string, service interface{}) {
	itf.Services[name] = service
}

// GetService retrieves a service from the integration test
func (itf *IntegrationTestFramework) GetService(name string) interface{} {
	return itf.Services[name]
}

// AddTestServer adds a test HTTP server
func (itf *IntegrationTestFramework) AddTestServer(name string, handler http.Handler) {
	server := httptest.NewServer(handler)
	itf.Servers[name] = server
}

// GetTestServer retrieves a test server
func (itf *IntegrationTestFramework) GetTestServer(name string) *httptest.Server {
	return itf.Servers[name]
}

// Cleanup performs integration test cleanup
func (itf *IntegrationTestFramework) Cleanup() {
	// Close all test servers
	for _, server := range itf.Servers {
		server.Close()
	}
	
	// Call parent cleanup
	itf.TestFramework.Cleanup()
}

// TestHelper provides common test utilities
type TestHelper struct {
	// Configuration helpers
	DefaultTimeout time.Duration
	DefaultRetries int
}

// NewTestHelper creates a new test helper
func NewTestHelper() *TestHelper {
	return &TestHelper{
		DefaultTimeout: 5 * time.Second,
		DefaultRetries: 3,
	}
}

// WaitForCondition waits for a condition to be true
func (th *TestHelper) WaitForCondition(tf *TestFramework, condition func() bool, timeout time.Duration) bool {
	ctx, cancel := context.WithTimeout(tf.Ctx, timeout)
	defer cancel()
	
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return false
		case <-ticker.C:
			if condition() {
				return true
			}
		}
	}
}

// RetryOperation retries an operation with exponential backoff
func (th *TestHelper) RetryOperation(tf *TestFramework, operation func() error, maxRetries int) error {
	var lastErr error
	
	for i := 0; i < maxRetries; i++ {
		if err := operation(); err == nil {
			return nil
		} else {
			lastErr = err
			time.Sleep(time.Duration(i+1) * 100 * time.Millisecond)
		}
	}
	
	return lastErr
}

// CreateTempFile creates a temporary file for testing
func (th *TestHelper) CreateTempFile(tf *TestFramework, content string) string {
	// Implementation would create temp file
	// Simplified for now
	return "/tmp/test-file"
}

// LoadTestData loads test data from file
func (th *TestHelper) LoadTestData(tf *TestFramework, filename string) []byte {
	// Implementation would load test data
	// Simplified for now
	return []byte("test data")
}