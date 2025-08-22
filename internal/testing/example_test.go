package testing

import (
	"net/http"
	"testing"
	"time"
)

// Example demonstrating unified testing framework usage
func TestUnifiedFrameworkExample(t *testing.T) {
	// Create test framework instance
	tf := NewTestFramework(t)
	defer tf.Cleanup()
	
	// Example of basic assertions
	tf.AssertEqual("expected", "expected")
	tf.AssertNotNil(tf.Logger)
	tf.AssertTrue(true)
	tf.AssertFalse(false)
	
	// Example of error handling
	err := someOperation()
	tf.AssertNoError(err)
	
	// Example with mock
	mockEngine := NewMockMiningEngine()
	tf.RequireNotNil(mockEngine)
	
	// Test mining engine operations
	err = mockEngine.Initialize()
	tf.AssertNoError(err)
	
	err = mockEngine.Start()
	tf.AssertNoError(err)
	tf.AssertTrue(mockEngine.IsRunning())
	
	stats := mockEngine.GetStatistics()
	tf.AssertContains(stats, "hashrate")
	tf.AssertEqual(uint64(1000000), stats["hashrate"])
	
	err = mockEngine.Stop()
	tf.AssertNoError(err)
	tf.AssertFalse(mockEngine.IsRunning())
}

// Example of table-driven tests using the framework
func TestTableDrivenExample(t *testing.T) {
	tf := NewTestFramework(t)
	defer tf.Cleanup()
	
	testCases := []TestCase{
		{
			Name: "Valid Mining Operation",
			Setup: func(tf *TestFramework) {
				tf.Logger.Info("Setting up valid mining test")
			},
			Execute: func(tf *TestFramework) error {
				mockEngine := NewMockMiningEngine()
				return mockEngine.Start()
			},
			Assert: func(tf *TestFramework, err error) {
				tf.AssertNoError(err)
			},
		},
		{
			Name: "Invalid Mining Operation",
			Setup: func(tf *TestFramework) {
				tf.Logger.Info("Setting up invalid mining test")
			},
			Execute: func(tf *TestFramework) error {
				mockEngine := NewMockMiningEngine()
				mockEngine.SetShouldFail(true, false)
				return mockEngine.Start()
			},
			Assert: func(tf *TestFramework, err error) {
				tf.AssertError(err)
			},
		},
		{
			Name: "Security Token Validation",
			Setup: func(tf *TestFramework) {
				tf.Logger.Info("Setting up security test")
			},
			Execute: func(tf *TestFramework) error {
				mockSecurity := NewMockSecurityManager()
				mockSecurity.SetTokenValid("valid-token", true)
				
				_, err := mockSecurity.ValidateJWT("valid-token")
				return err
			},
			Assert: func(tf *TestFramework, err error) {
				tf.AssertNoError(err)
			},
		},
	}
	
	tf.RunTestCases(testCases)
}

// Example of integration test
func TestIntegrationExample(t *testing.T) {
	// Skip if integration tests are disabled
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}
	
	itf := NewIntegrationTestFramework(t)
	defer itf.Cleanup()
	
	// Setup services
	mockEngine := NewMockMiningEngine()
	mockSecurity := NewMockSecurityManager()
	
	itf.AddService("mining", mockEngine)
	itf.AddService("security", mockSecurity)
	
	// Test service integration
	engine := itf.GetService("mining").(*MockMiningEngine)
	security := itf.GetService("security").(*MockSecurityManager)
	
	// Initialize services
	err := engine.Initialize()
	itf.AssertNoError(err)
	
	// Generate auth token
	token, err := security.GenerateJWT("test-user", map[string]interface{}{
		"role": "miner",
	})
	itf.AssertNoError(err)
	itf.AssertNotNil(token)
	
	// Validate token
	claims, err := security.ValidateJWT(token)
	itf.AssertNoError(err)
	itf.AssertEqual("test-user", claims.UserID)
	
	// Start mining with authentication
	err = engine.Start()
	itf.AssertNoError(err)
	
	// Check mining stats
	stats := engine.GetStatistics()
	itf.AssertTrue(stats["running"].(bool))
}

// Example of benchmark test
func BenchmarkMiningOperations(b *testing.B) {
	bf := NewBenchmarkFramework(b)
	bf.ReportAllocs()
	
	mockEngine := NewMockMiningEngine()
	mockEngine.Initialize()
	
	bf.ResetTimer()
	for i := 0; i < b.N; i++ {
		mockEngine.Start()
		_ = mockEngine.GetStatistics()
		mockEngine.Stop()
	}
}

// Example of security test with mock
func TestSecurityExample(t *testing.T) {
	tf := NewTestFramework(t)
	defer tf.Cleanup()
	
	mockSecurity := NewMockSecurityManager()
	
	// Test encryption/decryption
	plaintext := []byte("sensitive mining data")
	
	encrypted, err := mockSecurity.Encrypt(plaintext)
	tf.AssertNoError(err)
	tf.AssertNotNil(encrypted)
	
	decrypted, err := mockSecurity.Decrypt(encrypted)
	tf.AssertNoError(err)
	tf.AssertEqual(plaintext, decrypted)
	
	// Test rate limiting
	tf.AssertTrue(mockSecurity.CheckRateLimit("client-1"))
	
	// Test IP filtering
	tf.AssertTrue(mockSecurity.IsIPAllowed("192.168.1.1"))
	
	// Test with disabled features
	mockSecurity.SetEncryptionEnabled(false)
	_, err = mockSecurity.Encrypt(plaintext)
	tf.AssertError(err)
	
	mockSecurity.SetRateLimitAllowed(false)
	tf.AssertFalse(mockSecurity.CheckRateLimit("client-2"))
}

// Example of HTTP API test
func TestHTTPAPIExample(t *testing.T) {
	tf := NewTestFramework(t)
	defer tf.Cleanup()
	
	// Create HTTP request
	req := tf.HTTPRequest("GET", "/api/v1/status", nil)
	tf.AssertNotNil(req)
	tf.AssertEqual("GET", req.Method)
	
	// Create response recorder
	recorder := tf.HTTPRecorder()
	tf.AssertNotNil(recorder)
	
	// Mock handler for testing
	handler := func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	}
	
	// Execute request
	handler(recorder, req)
	
	// Assert response
	tf.AssertHTTPResponse(recorder, http.StatusOK)
	tf.AssertContains(recorder.Body.String(), "status")
}

// Example of test suite usage
func TestSuiteExample(t *testing.T) {
	// Create test environment
	env := GetEnvironment("unit")
	
	// Create test runner
	runner := NewTestRunner(
		NewTestFramework(t).Logger,
		env,
	)
	
	// Create test suite
	suite := NewTestSuite("Mining Engine Tests", "Comprehensive mining engine test suite").
		WithCategory("unit").
		WithTags("mining", "fast").
		WithTimeout(30 * time.Second).
		WithSetup(func() error {
			// Suite setup logic
			return nil
		}).
		WithTeardown(func() error {
			// Suite cleanup logic
			return nil
		})
	
	// Add tests to suite
	suite.AddTest(TestCase{
		Name: "Engine Initialization",
		Execute: func(tf *TestFramework) error {
			mockEngine := NewMockMiningEngine()
			return mockEngine.Initialize()
		},
		Assert: func(tf *TestFramework, err error) {
			tf.AssertNoError(err)
		},
	})
	
	suite.AddTest(TestCase{
		Name: "Engine Start/Stop",
		Execute: func(tf *TestFramework) error {
			mockEngine := NewMockMiningEngine()
			if err := mockEngine.Initialize(); err != nil {
				return err
			}
			if err := mockEngine.Start(); err != nil {
				return err
			}
			return mockEngine.Stop()
		},
		Assert: func(tf *TestFramework, err error) {
			tf.AssertNoError(err)
		},
	})
	
	// Run the suite
	result, err := runner.RunSuite(suite)
	if err != nil {
		t.Fatalf("Suite execution failed: %v", err)
	}
	
	if result.Failed > 0 {
		t.Errorf("Suite had %d failures", result.Failed)
	}
}

// Helper function for testing
func someOperation() error {
	// Simulate some operation that might fail
	return nil
}

// Example of hardware-specific test
func TestHardwareExample(t *testing.T) {
	tf := NewTestFramework(t)
	defer tf.Cleanup()
	
	mockHardware := NewMockHardwareManager()
	
	// Test hardware initialization
	err := mockHardware.Initialize()
	tf.AssertNoError(err)
	
	// Test device detection
	devices := mockHardware.GetDevices()
	tf.AssertNotNil(devices)
	tf.AssertTrue(len(devices) > 0)
	
	// Test hardware start with algorithm
	err = mockHardware.Start("sha256d")
	tf.AssertNoError(err)
	
	// Test metrics collection
	metrics := mockHardware.GetMetrics()
	tf.AssertContains(metrics, "hashrate")
	tf.AssertTrue(metrics["running"].(bool))
	
	// Test job submission
	job := map[string]interface{}{
		"algorithm": "sha256d",
		"target":    "0000ffff",
		"header":    "block_header_data",
	}
	
	err = mockHardware.SubmitJob(job)
	tf.AssertNoError(err)
	
	// Test power management
	err = mockHardware.SetPowerLimit(150.0)
	tf.AssertNoError(err)
	
	err = mockHardware.SetTemperatureLimit(80.0)
	tf.AssertNoError(err)
	
	// Test hardware stop
	err = mockHardware.Stop()
	tf.AssertNoError(err)
}

// Example showing error scenarios
func TestErrorScenariosExample(t *testing.T) {
	tf := NewTestFramework(t)
	defer tf.Cleanup()
	
	// Test engine failure scenarios
	mockEngine := NewMockMiningEngine()
	mockEngine.SetShouldFail(true, true)
	
	// Should fail to start
	err := mockEngine.Start()
	tf.AssertError(err)
	tf.AssertContains(err.Error(), "mock start failure")
	
	// Test hardware failure scenarios
	mockHardware := NewMockHardwareManager()
	mockHardware.SetShouldFail(true)
	
	// Should fail to initialize
	err = mockHardware.Initialize()
	tf.AssertError(err)
	tf.AssertContains(err.Error(), "mock initialization failure")
	
	// Test security failure scenarios
	mockSecurity := NewMockSecurityManager()
	
	// Invalid token should fail
	_, err = mockSecurity.ValidateJWT("invalid-token")
	tf.AssertError(err)
	tf.AssertContains(err.Error(), "invalid token")
}