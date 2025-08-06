package testing

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/otedama/otedama/internal/config"
	"github.com/otedama/otedama/internal/database"
	"github.com/otedama/otedama/internal/logging"
	"github.com/stretchr/testify/require"
	"github.com/stretchr/testify/suite"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest"

	// Test database drivers
	_ "github.com/lib/pq"
	_ "github.com/mattn/go-sqlite3"
)

// TestFramework provides comprehensive testing utilities
type TestFramework struct {
	// Core components
	T      *testing.T
	Logger *zap.Logger
	Config *config.Config
	
	// Test environment
	TempDir    string
	TestDB     *sql.DB
	TestServer *TestServer
	
	// Mocks and fixtures
	Mocks    *MockManager
	Fixtures *FixtureManager
	
	// Test data
	TestData map[string]interface{}
	
	// Cleanup functions
	cleanupFuncs []func()
	mu           sync.Mutex
}

// NewTestFramework creates a new test framework instance
func NewTestFramework(t *testing.T) *TestFramework {
	// Create test logger
	logger := zaptest.NewLogger(t)
	
	// Create temp directory
	tempDir, err := os.MkdirTemp("", "otedama-test-*")
	require.NoError(t, err)
	
	tf := &TestFramework{
		T:        t,
		Logger:   logger,
		TempDir:  tempDir,
		TestData: make(map[string]interface{}),
		Mocks:    NewMockManager(),
		Fixtures: NewFixtureManager(),
	}
	
	// Register cleanup
	tf.RegisterCleanup(func() {
		os.RemoveAll(tempDir)
	})
	
	// Initialize test config
	tf.initializeTestConfig()
	
	return tf
}

// initializeTestConfig creates test configuration
func (tf *TestFramework) initializeTestConfig() {
	tf.Config = &config.Config{
		Server: config.ServerConfig{
			Host: "localhost",
			Port: 0, // Random port
		},
		Database: config.DatabaseConfig{
			Driver: "sqlite3",
			DSN:    ":memory:",
		},
		Mining: config.MiningConfig{
			Algorithm: "sha256",
			Threads:   2,
		},
		Pool: config.PoolConfig{
			MinPayout: 0.001,
			FeePercent: 1.0,
		},
		P2P: config.P2PConfig{
			ListenAddrs: []string{"/ip4/127.0.0.1/tcp/0"},
			MaxPeers:    10,
		},
		Security: config.SecurityConfig{
			RateLimit: 100,
			EnableTLS: false,
		},
	}
}

// SetupTestDB sets up test database
func (tf *TestFramework) SetupTestDB(driver string) error {
	var err error
	
	switch driver {
	case "postgres":
		tf.TestDB, err = tf.setupPostgresDB()
	case "mysql":
		tf.TestDB, err = tf.setupMySQLDB()
	default:
		tf.TestDB, err = tf.setupSQLiteDB()
	}
	
	if err != nil {
		return fmt.Errorf("failed to setup test database: %w", err)
	}
	
	// Run migrations
	if err := tf.runMigrations(); err != nil {
		return fmt.Errorf("failed to run migrations: %w", err)
	}
	
	// Register cleanup
	tf.RegisterCleanup(func() {
		tf.TestDB.Close()
	})
	
	return nil
}

// setupSQLiteDB sets up SQLite test database
func (tf *TestFramework) setupSQLiteDB() (*sql.DB, error) {
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		return nil, err
	}
	
	// Configure SQLite
	db.SetMaxOpenConns(1)
	
	return db, nil
}

// setupPostgresDB sets up PostgreSQL test database
func (tf *TestFramework) setupPostgresDB() (*sql.DB, error) {
	// Use test container or local test database
	dsn := os.Getenv("TEST_POSTGRES_DSN")
	if dsn == "" {
		dsn = "postgres://test:test@localhost:5432/otedama_test?sslmode=disable"
	}
	
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, err
	}
	
	// Create test schema
	dbName := fmt.Sprintf("otedama_test_%d", time.Now().Unix())
	_, err = db.Exec(fmt.Sprintf("CREATE DATABASE %s", dbName))
	if err != nil {
		db.Close()
		return nil, err
	}
	
	// Connect to test database
	testDSN := fmt.Sprintf("postgres://test:test@localhost:5432/%s?sslmode=disable", dbName)
	testDB, err := sql.Open("postgres", testDSN)
	if err != nil {
		db.Close()
		return nil, err
	}
	
	// Register cleanup
	tf.RegisterCleanup(func() {
		testDB.Close()
		db.Exec(fmt.Sprintf("DROP DATABASE %s", dbName))
		db.Close()
	})
	
	return testDB, nil
}

// setupMySQLDB sets up MySQL test database
func (tf *TestFramework) setupMySQLDB() (*sql.DB, error) {
	// Similar to PostgreSQL setup
	return nil, fmt.Errorf("MySQL not implemented")
}

// runMigrations runs database migrations
func (tf *TestFramework) runMigrations() error {
	// Load migration files
	migrations, err := filepath.Glob("../../database/migrations/*.sql")
	if err != nil {
		return err
	}
	
	// Execute migrations
	for _, migration := range migrations {
		content, err := os.ReadFile(migration)
		if err != nil {
			return fmt.Errorf("failed to read migration %s: %w", migration, err)
		}
		
		if _, err := tf.TestDB.Exec(string(content)); err != nil {
			return fmt.Errorf("failed to execute migration %s: %w", migration, err)
		}
	}
	
	return nil
}

// StartTestServer starts a test server
func (tf *TestFramework) StartTestServer() (*TestServer, error) {
	// Get random port
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	
	// Update config with test port
	tf.Config.Server.Port = port
	
	// Create test server
	ts := &TestServer{
		Framework: tf,
		Port:      port,
		URL:       fmt.Sprintf("http://localhost:%d", port),
	}
	
	// Start server
	if err := ts.Start(); err != nil {
		return nil, err
	}
	
	tf.TestServer = ts
	
	// Register cleanup
	tf.RegisterCleanup(func() {
		ts.Stop()
	})
	
	return ts, nil
}

// CreateTestFile creates a test file
func (tf *TestFramework) CreateTestFile(name string, content []byte) string {
	path := filepath.Join(tf.TempDir, name)
	
	// Create directory if needed
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		tf.T.Fatalf("Failed to create test directory: %v", err)
	}
	
	// Write file
	if err := os.WriteFile(path, content, 0644); err != nil {
		tf.T.Fatalf("Failed to create test file: %v", err)
	}
	
	return path
}

// LoadFixture loads test fixture
func (tf *TestFramework) LoadFixture(name string) error {
	return tf.Fixtures.Load(name, tf.TestDB)
}

// AssertEventually asserts condition eventually becomes true
func (tf *TestFramework) AssertEventually(condition func() bool, timeout time.Duration, msg string) {
	deadline := time.Now().Add(timeout)
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	
	for {
		if condition() {
			return
		}
		
		select {
		case <-ticker.C:
			if time.Now().After(deadline) {
				tf.T.Fatalf("Condition not met within %v: %s", timeout, msg)
			}
		}
	}
}

// RegisterCleanup registers cleanup function
func (tf *TestFramework) RegisterCleanup(fn func()) {
	tf.mu.Lock()
	defer tf.mu.Unlock()
	
	tf.cleanupFuncs = append(tf.cleanupFuncs, fn)
}

// Cleanup runs all cleanup functions
func (tf *TestFramework) Cleanup() {
	tf.mu.Lock()
	funcs := tf.cleanupFuncs
	tf.mu.Unlock()
	
	// Run cleanup in reverse order
	for i := len(funcs) - 1; i >= 0; i-- {
		funcs[i]()
	}
}

// TestServer represents a test server instance
type TestServer struct {
	Framework *TestFramework
	Port      int
	URL       string
	server    interface{} // Actual server instance
	cancel    context.CancelFunc
}

// Start starts the test server
func (ts *TestServer) Start() error {
	ctx, cancel := context.WithCancel(context.Background())
	ts.cancel = cancel
	
	// Start server in background
	go func() {
		// Server implementation would go here
		<-ctx.Done()
	}()
	
	// Wait for server to be ready
	ts.Framework.AssertEventually(func() bool {
		conn, err := net.Dial("tcp", fmt.Sprintf("localhost:%d", ts.Port))
		if err != nil {
			return false
		}
		conn.Close()
		return true
	}, 5*time.Second, "Server failed to start")
	
	return nil
}

// Stop stops the test server
func (ts *TestServer) Stop() {
	if ts.cancel != nil {
		ts.cancel()
	}
}

// TestSuite provides base test suite functionality
type TestSuite struct {
	suite.Suite
	Framework *TestFramework
}

// SetupSuite runs before all tests
func (ts *TestSuite) SetupSuite() {
	ts.Framework = NewTestFramework(ts.T())
}

// TearDownSuite runs after all tests
func (ts *TestSuite) TearDownSuite() {
	ts.Framework.Cleanup()
}

// SetupTest runs before each test
func (ts *TestSuite) SetupTest() {
	// Reset test data
	ts.Framework.TestData = make(map[string]interface{})
}

// TearDownTest runs after each test
func (ts *TestSuite) TearDownTest() {
	// Clean up test-specific resources
}

// MockManager manages test mocks
type MockManager struct {
	mocks map[string]interface{}
	mu    sync.RWMutex
}

func NewMockManager() *MockManager {
	return &MockManager{
		mocks: make(map[string]interface{}),
	}
}

// Register registers a mock
func (mm *MockManager) Register(name string, mock interface{}) {
	mm.mu.Lock()
	defer mm.mu.Unlock()
	mm.mocks[name] = mock
}

// Get retrieves a mock
func (mm *MockManager) Get(name string) (interface{}, bool) {
	mm.mu.RLock()
	defer mm.mu.RUnlock()
	mock, ok := mm.mocks[name]
	return mock, ok
}

// FixtureManager manages test fixtures
type FixtureManager struct {
	fixtures map[string]FixtureLoader
	mu       sync.RWMutex
}

func NewFixtureManager() *FixtureManager {
	fm := &FixtureManager{
		fixtures: make(map[string]FixtureLoader),
	}
	
	// Register default fixtures
	fm.RegisterDefaults()
	
	return fm
}

// FixtureLoader loads fixture data
type FixtureLoader func(db *sql.DB) error

// RegisterDefaults registers default fixtures
func (fm *FixtureManager) RegisterDefaults() {
	// User fixtures
	fm.Register("users", func(db *sql.DB) error {
		_, err := db.Exec(`
			INSERT INTO users (id, username, email, created_at) VALUES
			($1, 'test_user', 'test@example.com', NOW()),
			($2, 'admin', 'admin@example.com', NOW())
		`, GenerateID(), GenerateID())
		return err
	})
	
	// Worker fixtures
	fm.Register("workers", func(db *sql.DB) error {
		_, err := db.Exec(`
			INSERT INTO workers (id, name, user_id, created_at) VALUES
			($1, 'test_worker', $2, NOW())
		`, GenerateID(), GenerateID())
		return err
	})
}

// Register registers a fixture
func (fm *FixtureManager) Register(name string, loader FixtureLoader) {
	fm.mu.Lock()
	defer fm.mu.Unlock()
	fm.fixtures[name] = loader
}

// Load loads a fixture
func (fm *FixtureManager) Load(name string, db *sql.DB) error {
	fm.mu.RLock()
	loader, ok := fm.fixtures[name]
	fm.mu.RUnlock()
	
	if !ok {
		return fmt.Errorf("fixture %s not found", name)
	}
	
	return loader(db)
}

// Helper functions

// GenerateID generates a test ID
func GenerateID() string {
	return fmt.Sprintf("test_%d", time.Now().UnixNano())
}

// CaptureOutput captures stdout/stderr output
func CaptureOutput(fn func()) string {
	old := os.Stdout
	r, w, _ := os.Pipe()
	os.Stdout = w
	
	fn()
	
	w.Close()
	os.Stdout = old
	
	out, _ := io.ReadAll(r)
	return string(out)
}

// WaitForCondition waits for condition with timeout
func WaitForCondition(condition func() bool, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	
	for {
		if condition() {
			return nil
		}
		
		select {
		case <-ticker.C:
			if time.Now().After(deadline) {
				return fmt.Errorf("condition not met within %v", timeout)
			}
		}
	}
}