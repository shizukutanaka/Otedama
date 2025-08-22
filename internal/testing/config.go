package testing

import (
	"time"
)

// TestConfig provides standard test configuration
type TestConfig struct {
	// Timing configuration
	DefaultTimeout   time.Duration `json:"default_timeout"`
	LongTimeout      time.Duration `json:"long_timeout"`
	ShortTimeout     time.Duration `json:"short_timeout"`
	RetryDelay       time.Duration `json:"retry_delay"`
	MaxRetries       int           `json:"max_retries"`
	
	// Logging configuration
	LogLevel         string `json:"log_level"`
	EnableDebugLogs  bool   `json:"enable_debug_logs"`
	
	// Test data configuration
	TestDataDir      string `json:"test_data_dir"`
	TempDir          string `json:"temp_dir"`
	
	// Performance configuration
	BenchmarkRuns    int `json:"benchmark_runs"`
	BenchmarkTime    time.Duration `json:"benchmark_time"`
	
	// Integration test configuration
	DatabaseURL      string `json:"database_url"`
	RedisURL         string `json:"redis_url"`
	TestServerPort   int    `json:"test_server_port"`
	
	// Mining test configuration
	MiningAlgorithm  string  `json:"mining_algorithm"`
	TestHashRate     uint64  `json:"test_hash_rate"`
	TestDifficulty   float64 `json:"test_difficulty"`
	
	// Security test configuration
	TestJWTSecret    string `json:"test_jwt_secret"`
	TestEncKey       string `json:"test_encryption_key"`
	
	// Mock configuration
	MockDelay        time.Duration `json:"mock_delay"`
	MockFailureRate  float64       `json:"mock_failure_rate"`
}

// DefaultTestConfig returns default test configuration
func DefaultTestConfig() *TestConfig {
	return &TestConfig{
		// Timing
		DefaultTimeout:   10 * time.Second,
		LongTimeout:      30 * time.Second,
		ShortTimeout:     1 * time.Second,
		RetryDelay:       100 * time.Millisecond,
		MaxRetries:       3,
		
		// Logging
		LogLevel:         "error",
		EnableDebugLogs:  false,
		
		// Test data
		TestDataDir:      "./testdata",
		TempDir:          "/tmp/otedama-tests",
		
		// Performance
		BenchmarkRuns:    1000,
		BenchmarkTime:    1 * time.Second,
		
		// Integration
		DatabaseURL:      "{{.DATABASE_URL}}/otedama_test?sslmode=disable",
		RedisURL:         "{{.REDIS_URL}}/1",
		TestServerPort:   18080,
		
		// Mining
		MiningAlgorithm:  "sha256d",
		TestHashRate:     1000000,
		TestDifficulty:   1.0,
		
		// Security
		TestJWTSecret:    "test-jwt-secret-key-minimum-32-characters",
		TestEncKey:       "test-encryption-key-32-chars!!",
		
		// Mock
		MockDelay:        0,
		MockFailureRate:  0.0,
	}
}

// IntegrationTestConfig returns configuration for integration tests
func IntegrationTestConfig() *TestConfig {
	config := DefaultTestConfig()
	config.DefaultTimeout = 30 * time.Second
	config.LongTimeout = 60 * time.Second
	config.EnableDebugLogs = true
	config.LogLevel = "debug"
	return config
}

// BenchmarkTestConfig returns configuration for benchmark tests
func BenchmarkTestConfig() *TestConfig {
	config := DefaultTestConfig()
	config.BenchmarkRuns = 10000
	config.BenchmarkTime = 5 * time.Second
	config.LogLevel = "error"
	config.EnableDebugLogs = false
	return config
}

// UnitTestConfig returns configuration for unit tests
func UnitTestConfig() *TestConfig {
	config := DefaultTestConfig()
	config.DefaultTimeout = 5 * time.Second
	config.MockDelay = 1 * time.Millisecond
	return config
}

// TestEnvironment represents test environment configuration
type TestEnvironment struct {
	Name        string    `json:"name"`
	Config      *TestConfig `json:"config"`
	Services    []string  `json:"services"`
	Dependencies []string `json:"dependencies"`
}

// GetEnvironment returns test environment by name
func GetEnvironment(name string) *TestEnvironment {
	switch name {
	case "unit":
		return &TestEnvironment{
			Name:         "unit",
			Config:       UnitTestConfig(),
			Services:     []string{},
			Dependencies: []string{},
		}
	case "integration":
		return &TestEnvironment{
			Name:         "integration",
			Config:       IntegrationTestConfig(),
			Services:     []string{"database", "redis"},
			Dependencies: []string{"docker"},
		}
	case "benchmark":
		return &TestEnvironment{
			Name:         "benchmark",
			Config:       BenchmarkTestConfig(),
			Services:     []string{},
			Dependencies: []string{},
		}
	case "e2e":
		return &TestEnvironment{
			Name:         "e2e",
			Config:       IntegrationTestConfig(),
			Services:     []string{"database", "redis", "mining", "api"},
			Dependencies: []string{"docker", "mining-hardware"},
		}
	default:
		return &TestEnvironment{
			Name:         "default",
			Config:       DefaultTestConfig(),
			Services:     []string{},
			Dependencies: []string{},
		}
	}
}

// TestMetadata provides metadata for test categorization
type TestMetadata struct {
	Category     string   `json:"category"`     // unit, integration, benchmark, e2e
	Tags         []string `json:"tags"`         // slow, fast, gpu, cpu, security
	Description  string   `json:"description"`
	Author       string   `json:"author"`
	Requirements []string `json:"requirements"` // docker, gpu, specific hardware
	Timeout      time.Duration `json:"timeout"`
}

// TestSuite represents a collection of related tests
type TestSuite struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Metadata    *TestMetadata  `json:"metadata"`
	Config      *TestConfig    `json:"config"`
	Setup       func() error   `json:"-"`
	Teardown    func() error   `json:"-"`
	Tests       []TestCase     `json:"tests"`
}

// NewTestSuite creates a new test suite
func NewTestSuite(name, description string) *TestSuite {
	return &TestSuite{
		Name:        name,
		Description: description,
		Metadata:    &TestMetadata{},
		Config:      DefaultTestConfig(),
		Tests:       make([]TestCase, 0),
	}
}

// WithCategory sets the test category
func (ts *TestSuite) WithCategory(category string) *TestSuite {
	ts.Metadata.Category = category
	return ts
}

// WithTags sets test tags
func (ts *TestSuite) WithTags(tags ...string) *TestSuite {
	ts.Metadata.Tags = tags
	return ts
}

// WithTimeout sets test timeout
func (ts *TestSuite) WithTimeout(timeout time.Duration) *TestSuite {
	ts.Metadata.Timeout = timeout
	return ts
}

// WithRequirements sets test requirements
func (ts *TestSuite) WithRequirements(requirements ...string) *TestSuite {
	ts.Metadata.Requirements = requirements
	return ts
}

// WithConfig sets test configuration
func (ts *TestSuite) WithConfig(config *TestConfig) *TestSuite {
	ts.Config = config
	return ts
}

// WithSetup sets suite setup function
func (ts *TestSuite) WithSetup(setup func() error) *TestSuite {
	ts.Setup = setup
	return ts
}

// WithTeardown sets suite teardown function
func (ts *TestSuite) WithTeardown(teardown func() error) *TestSuite {
	ts.Teardown = teardown
	return ts
}

// AddTest adds a test case to the suite
func (ts *TestSuite) AddTest(test TestCase) *TestSuite {
	ts.Tests = append(ts.Tests, test)
	return ts
}

// TestPattern defines common test patterns
type TestPattern struct {
	Name        string
	Description string
	Template    func(*TestFramework) TestCase
}

// CommonTestPatterns provides reusable test patterns
var CommonTestPatterns = map[string]TestPattern{
	"crud": {
		Name:        "CRUD Operations",
		Description: "Tests create, read, update, delete operations",
		Template: func(tf *TestFramework) TestCase {
			return TestCase{
				Name: "CRUD Operations",
				Execute: func(tf *TestFramework) error {
					// Template for CRUD test
					return nil
				},
				Assert: func(tf *TestFramework, err error) {
					tf.AssertNoError(err)
				},
			}
		},
	},
	"error_handling": {
		Name:        "Error Handling",
		Description: "Tests error conditions and recovery",
		Template: func(tf *TestFramework) TestCase {
			return TestCase{
				Name: "Error Handling",
				Execute: func(tf *TestFramework) error {
					// Template for error handling test
					return nil
				},
				Assert: func(tf *TestFramework, err error) {
					tf.AssertError(err)
				},
			}
		},
	},
	"concurrency": {
		Name:        "Concurrency",
		Description: "Tests concurrent access and race conditions",
		Template: func(tf *TestFramework) TestCase {
			return TestCase{
				Name: "Concurrency",
				Execute: func(tf *TestFramework) error {
					// Template for concurrency test
					return nil
				},
				Assert: func(tf *TestFramework, err error) {
					tf.AssertNoError(err)
				},
			}
		},
	},
	"performance": {
		Name:        "Performance",
		Description: "Tests performance characteristics",
		Template: func(tf *TestFramework) TestCase {
			return TestCase{
				Name: "Performance",
				Execute: func(tf *TestFramework) error {
					// Template for performance test
					return nil
				},
				Assert: func(tf *TestFramework, err error) {
					tf.AssertNoError(err)
				},
			}
		},
	},
}