package testing

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/database"
	"github.com/stretchr/testify/suite"
	"go.uber.org/zap"
)

// TestSuite provides a base test suite with common functionality
type TestSuite struct {
	suite.Suite
	DB         *database.Database
	Logger     *zap.Logger
	Context    context.Context
	CancelFunc context.CancelFunc
	TempDir    string
}

// SetupSuite runs once before all tests
func (s *TestSuite) SetupSuite() {
	// Setup logger
	logger, err := zap.NewDevelopment()
	s.Require().NoError(err)
	s.Logger = logger

	// Create context
	s.Context, s.CancelFunc = context.WithTimeout(context.Background(), 5*time.Minute)

	// Create temp directory
	s.TempDir, err = os.MkdirTemp("", "otedama-test-*")
	s.Require().NoError(err)

	// Setup test database
	s.setupTestDatabase()
}

// TearDownSuite runs once after all tests
func (s *TestSuite) TearDownSuite() {
	// Cancel context
	if s.CancelFunc != nil {
		s.CancelFunc()
	}

	// Close database
	if s.DB != nil {
		s.DB.Close()
	}

	// Clean up temp directory
	if s.TempDir != "" {
		os.RemoveAll(s.TempDir)
	}

	// Sync logger
	if s.Logger != nil {
		s.Logger.Sync()
	}
}

// SetupTest runs before each test
func (s *TestSuite) SetupTest() {
	// Clean database tables
	s.cleanDatabase()
}

// TearDownTest runs after each test
func (s *TestSuite) TearDownTest() {
	// Additional cleanup if needed
}

// setupTestDatabase creates a test database
func (s *TestSuite) setupTestDatabase() {
	dbConfig := &database.Config{
		Type:     "postgres",
		Host:     getEnv("TEST_DB_HOST", "localhost"),
		Port:     5432,
		Database: getEnv("TEST_DB_NAME", "otedama_test"),
		User:     getEnv("TEST_DB_USER", "otedama"),
		Password: getEnv("TEST_DB_PASS", "otedama"),
		SSLMode:  "disable",
	}

	db, err := database.New(dbConfig)
	s.Require().NoError(err)
	s.DB = db

	// Run migrations
	err = s.DB.Migrate(s.Context)
	s.Require().NoError(err)
}

// cleanDatabase cleans all tables for test isolation
func (s *TestSuite) cleanDatabase() {
	tables := []string{
		"swaps",
		"liquidity_pools",
		"liquidity_positions",
		"shares",
		"blocks",
		"workers",
		"payouts",
		"users",
	}

	for _, table := range tables {
		query := fmt.Sprintf("TRUNCATE TABLE %s CASCADE", table)
		_, err := s.DB.Exec(s.Context, query)
		s.Require().NoError(err)
	}
}

// IntegrationTestSuite extends TestSuite for integration tests
type IntegrationTestSuite struct {
	TestSuite
	Services *ServiceContainer
}

// SetupSuite initializes integration test environment
func (s *IntegrationTestSuite) SetupSuite() {
	s.TestSuite.SetupSuite()
	
	// Initialize service container
	s.Services = NewServiceContainer(s.DB, s.Logger)
	
	// Start services
	err := s.Services.Start(s.Context)
	s.Require().NoError(err)
}

// TearDownSuite cleans up integration test environment
func (s *IntegrationTestSuite) TearDownSuite() {
	// Stop services
	if s.Services != nil {
		err := s.Services.Stop()
		s.Assert().NoError(err)
	}
	
	s.TestSuite.TearDownSuite()
}

// ServiceContainer holds all services for integration testing
type ServiceContainer struct {
	DB       *database.Database
	Logger   *zap.Logger
	Mining   interface{} // Mining service
	DEX      interface{} // DEX service
	P2P      interface{} // P2P service
	API      interface{} // API service
}

// NewServiceContainer creates a new service container
func NewServiceContainer(db *database.Database, logger *zap.Logger) *ServiceContainer {
	return &ServiceContainer{
		DB:     db,
		Logger: logger,
	}
}

// Start initializes and starts all services
func (sc *ServiceContainer) Start(ctx context.Context) error {
	// Initialize services here
	// This would be implemented based on actual service requirements
	return nil
}

// Stop gracefully stops all services
func (sc *ServiceContainer) Stop() error {
	// Stop services in reverse order
	// This would be implemented based on actual service requirements
	return nil
}

// BenchmarkSuite provides benchmarking utilities
type BenchmarkSuite struct {
	B       *testing.B
	DB      *database.Database
	Logger  *zap.Logger
	Context context.Context
}

// NewBenchmarkSuite creates a new benchmark suite
func NewBenchmarkSuite(b *testing.B) *BenchmarkSuite {
	logger, _ := zap.NewProduction()
	ctx := context.Background()
	
	return &BenchmarkSuite{
		B:       b,
		Logger:  logger,
		Context: ctx,
	}
}

// Setup initializes the benchmark environment
func (bs *BenchmarkSuite) Setup() {
	bs.B.Helper()
	
	// Setup database if needed
	dbConfig := &database.Config{
		Type:     "postgres",
		Host:     "localhost",
		Port:     5432,
		Database: "otedama_bench",
		User:     "otedama",
		Password: "otedama",
		SSLMode:  "disable",
	}
	
	db, err := database.New(dbConfig)
	if err != nil {
		bs.B.Fatal(err)
	}
	bs.DB = db
}

// Cleanup cleans up after benchmarks
func (bs *BenchmarkSuite) Cleanup() {
	if bs.DB != nil {
		bs.DB.Close()
	}
	if bs.Logger != nil {
		bs.Logger.Sync()
	}
}

// RunBenchmark runs a benchmark with setup and cleanup
func (bs *BenchmarkSuite) RunBenchmark(name string, fn func()) {
	bs.B.Run(name, func(b *testing.B) {
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			fn()
		}
	})
}

// TestHelpers provides common test helper functions
type TestHelpers struct{}

// NewTestHelpers creates test helpers
func NewTestHelpers() *TestHelpers {
	return &TestHelpers{}
}

// GenerateTestData generates test data
func (h *TestHelpers) GenerateTestData(count int) []interface{} {
	data := make([]interface{}, count)
	// Generate test data based on requirements
	return data
}

// AssertEventually asserts that a condition is eventually true
func (h *TestHelpers) AssertEventually(t *testing.T, condition func() bool, timeout time.Duration, msg string) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("Condition not met within %v: %s", timeout, msg)
}

// WaitForCondition waits for a condition to be true
func (h *TestHelpers) WaitForCondition(condition func() bool, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("condition not met within %v", timeout)
}

// MockData provides mock data generation
type MockData struct{}

// NewMockData creates mock data generator
func NewMockData() *MockData {
	return &MockData{}
}

// GenerateWalletAddress generates a mock wallet address
func (m *MockData) GenerateWalletAddress() string {
	return fmt.Sprintf("0x%x", time.Now().UnixNano())
}

// GenerateTransactionHash generates a mock transaction hash
func (m *MockData) GenerateTransactionHash() string {
	return fmt.Sprintf("%x", time.Now().UnixNano())
}

// Helper functions

// getEnv gets environment variable with default
func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

// mustGetEnv gets required environment variable
func mustGetEnv(key string) string {
	value := os.Getenv(key)
	if value == "" {
		panic(fmt.Sprintf("Environment variable %s is required", key))
	}
	return value
}