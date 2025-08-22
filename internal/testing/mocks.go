package testing

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// MockMiningEngine provides a mock mining engine for testing
type MockMiningEngine struct {
	mu              sync.RWMutex
	running         atomic.Bool
	initialized     atomic.Bool
	stats           map[string]interface{}
	workers         []interface{}
	currentJob      interface{}
	powerLimit      float64
	tempLimit       float64
	shouldFailStart bool
	shouldFailStop  bool
}

// NewMockMiningEngine creates a new mock mining engine
func NewMockMiningEngine() *MockMiningEngine {
	return &MockMiningEngine{
		stats: map[string]interface{}{
			"hashrate":        uint64(1000000),
			"shares_accepted": uint64(100),
			"shares_rejected": uint64(5),
			"workers":         int32(4),
			"algorithm":       "sha256d",
			"uptime":          time.Hour,
		},
		workers: []interface{}{
			map[string]interface{}{"id": "worker-1", "active": true},
			map[string]interface{}{"id": "worker-2", "active": true},
		},
	}
}

// Initialize initializes the mock engine
func (m *MockMiningEngine) Initialize() error {
	m.initialized.Store(true)
	return nil
}

// Start starts the mock engine
func (m *MockMiningEngine) Start() error {
	if m.shouldFailStart {
		return errors.New("mock start failure")
	}
	if m.running.Load() {
		return errors.New("already running")
	}
	m.running.Store(true)
	return nil
}

// Stop stops the mock engine
func (m *MockMiningEngine) Stop() error {
	if m.shouldFailStop {
		return errors.New("mock stop failure")
	}
	if !m.running.Load() {
		return errors.New("not running")
	}
	m.running.Store(false)
	return nil
}

// IsRunning returns if the engine is running
func (m *MockMiningEngine) IsRunning() bool {
	return m.running.Load()
}

// GetStatistics returns mock statistics
func (m *MockMiningEngine) GetStatistics() map[string]interface{} {
	m.mu.RLock()
	defer m.mu.RUnlock()
	
	result := make(map[string]interface{})
	for k, v := range m.stats {
		result[k] = v
	}
	result["running"] = m.running.Load()
	return result
}

// SetStatistic sets a mock statistic
func (m *MockMiningEngine) SetStatistic(key string, value interface{}) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stats[key] = value
}

// GetWorkers returns mock workers
func (m *MockMiningEngine) GetWorkers() []interface{} {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.workers
}

// SetPowerLimit sets power limit
func (m *MockMiningEngine) SetPowerLimit(watts float64) error {
	m.powerLimit = watts
	return nil
}

// SetTemperatureLimit sets temperature limit
func (m *MockMiningEngine) SetTemperatureLimit(celsius float64) error {
	m.tempLimit = celsius
	return nil
}

// SetJob sets current mining job
func (m *MockMiningEngine) SetJob(job interface{}) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.currentJob = job
}

// GetJob returns current job
func (m *MockMiningEngine) GetJob() interface{} {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.currentJob
}

// SetShouldFail configures mock to fail operations
func (m *MockMiningEngine) SetShouldFail(start, stop bool) {
	m.shouldFailStart = start
	m.shouldFailStop = stop
}

// MockSecurityManager provides a mock security manager for testing
type MockSecurityManager struct {
	mu                sync.RWMutex
	validTokens       map[string]bool
	rateLimitAllowed  bool
	ipAllowed         bool
	encryptionEnabled bool
	sessions          map[string]interface{}
	permissions       map[string][]string
}

// NewMockSecurityManager creates a new mock security manager
func NewMockSecurityManager() *MockSecurityManager {
	return &MockSecurityManager{
		validTokens:       make(map[string]bool),
		rateLimitAllowed:  true,
		ipAllowed:         true,
		encryptionEnabled: true,
		sessions:          make(map[string]interface{}),
		permissions:       make(map[string][]string),
	}
}

// ValidateJWT validates a JWT token
func (m *MockSecurityManager) ValidateJWT(token string) (*JWTClaims, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	
	if m.validTokens[token] {
		return &JWTClaims{
			UserID:    "test-user",
			Username:  "testuser",
			Role:      "admin",
			ExpiresAt: time.Now().Add(1 * time.Hour),
		}, nil
	}
	return nil, errors.New("invalid token")
}

// GenerateJWT generates a JWT token
func (m *MockSecurityManager) GenerateJWT(userID string, claims map[string]interface{}) (string, error) {
	token := "mock-jwt-token-" + userID
	m.mu.Lock()
	m.validTokens[token] = true
	m.mu.Unlock()
	return token, nil
}

// CheckRateLimit checks rate limiting
func (m *MockSecurityManager) CheckRateLimit(identifier string) bool {
	return m.rateLimitAllowed
}

// IsIPAllowed checks if IP is allowed
func (m *MockSecurityManager) IsIPAllowed(ip string) bool {
	return m.ipAllowed
}

// Encrypt encrypts data
func (m *MockSecurityManager) Encrypt(data []byte) ([]byte, error) {
	if !m.encryptionEnabled {
		return nil, errors.New("encryption disabled")
	}
	// Mock encryption - just reverse the bytes
	result := make([]byte, len(data))
	for i, b := range data {
		result[len(data)-1-i] = b
	}
	return result, nil
}

// Decrypt decrypts data
func (m *MockSecurityManager) Decrypt(data []byte) ([]byte, error) {
	if !m.encryptionEnabled {
		return nil, errors.New("encryption disabled")
	}
	// Mock decryption - reverse the bytes back
	result := make([]byte, len(data))
	for i, b := range data {
		result[len(data)-1-i] = b
	}
	return result, nil
}

// SetTokenValid sets whether a token should be valid
func (m *MockSecurityManager) SetTokenValid(token string, valid bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.validTokens[token] = valid
}

// SetRateLimitAllowed sets whether rate limiting should allow requests
func (m *MockSecurityManager) SetRateLimitAllowed(allowed bool) {
	m.rateLimitAllowed = allowed
}

// SetIPAllowed sets whether IP should be allowed
func (m *MockSecurityManager) SetIPAllowed(allowed bool) {
	m.ipAllowed = allowed
}

// SetEncryptionEnabled sets whether encryption should work
func (m *MockSecurityManager) SetEncryptionEnabled(enabled bool) {
	m.encryptionEnabled = enabled
}

// JWTClaims represents JWT claims for testing
type JWTClaims struct {
	UserID    string    `json:"user_id"`
	Username  string    `json:"username"`
	Role      string    `json:"role"`
	ExpiresAt time.Time `json:"expires_at"`
}

// MockHardwareManager provides a mock hardware manager for testing
type MockHardwareManager struct {
	mu           sync.RWMutex
	initialized  bool
	running      bool
	devices      []interface{}
	metrics      map[string]interface{}
	jobs         []interface{}
	shouldFail   bool
	algorithm    string
	powerLimit   float64
	tempLimit    float64
}

// NewMockHardwareManager creates a new mock hardware manager
func NewMockHardwareManager() *MockHardwareManager {
	return &MockHardwareManager{
		devices: []interface{}{
			map[string]interface{}{"id": "gpu-0", "type": "nvidia", "memory": 8192},
			map[string]interface{}{"id": "cpu-0", "type": "x86_64", "cores": 8},
		},
		metrics: map[string]interface{}{
			"devices_total": 2,
			"hashrate":      uint64(5000000),
			"temperature":   65.0,
			"power_usage":   150.0,
		},
	}
}

// Initialize initializes the mock hardware
func (m *MockHardwareManager) Initialize() error {
	if m.shouldFail {
		return errors.New("mock initialization failure")
	}
	m.initialized = true
	return nil
}

// Start starts the mock hardware
func (m *MockHardwareManager) Start(algorithm string) error {
	if m.shouldFail {
		return errors.New("mock start failure")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.running = true
	m.algorithm = algorithm
	return nil
}

// Stop stops the mock hardware
func (m *MockHardwareManager) Stop() error {
	if m.shouldFail {
		return errors.New("mock stop failure")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.running = false
	return nil
}

// GetDevices returns mock devices
func (m *MockHardwareManager) GetDevices() []interface{} {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.devices
}

// GetMetrics returns mock metrics
func (m *MockHardwareManager) GetMetrics() map[string]interface{} {
	m.mu.RLock()
	defer m.mu.RUnlock()
	
	result := make(map[string]interface{})
	for k, v := range m.metrics {
		result[k] = v
	}
	result["running"] = m.running
	result["algorithm"] = m.algorithm
	return result
}

// SubmitJob submits a job to mock hardware
func (m *MockHardwareManager) SubmitJob(job interface{}) error {
	if m.shouldFail {
		return errors.New("mock job submission failure")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.jobs = append(m.jobs, job)
	return nil
}

// SetPowerLimit sets power limit
func (m *MockHardwareManager) SetPowerLimit(watts float64) error {
	m.powerLimit = watts
	return nil
}

// SetTemperatureLimit sets temperature limit
func (m *MockHardwareManager) SetTemperatureLimit(celsius float64) error {
	m.tempLimit = celsius
	return nil
}

// SetShouldFail configures mock to fail operations
func (m *MockHardwareManager) SetShouldFail(fail bool) {
	m.shouldFail = fail
}

// GetJobs returns submitted jobs
func (m *MockHardwareManager) GetJobs() []interface{} {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return append([]interface{}{}, m.jobs...)
}

// MockHTTPClient provides a mock HTTP client for testing
type MockHTTPClient struct {
	mu        sync.RWMutex
	responses map[string]*http.Response
	errors    map[string]error
	requests  []*http.Request
}

// NewMockHTTPClient creates a new mock HTTP client
func NewMockHTTPClient() *MockHTTPClient {
	return &MockHTTPClient{
		responses: make(map[string]*http.Response),
		errors:    make(map[string]error),
		requests:  make([]*http.Request, 0),
	}
}

// Do performs a mock HTTP request
func (m *MockHTTPClient) Do(req *http.Request) (*http.Response, error) {
	m.mu.Lock()
	m.requests = append(m.requests, req)
	m.mu.Unlock()
	
	key := req.Method + " " + req.URL.String()
	
	m.mu.RLock()
	defer m.mu.RUnlock()
	
	if err, exists := m.errors[key]; exists {
		return nil, err
	}
	
	if resp, exists := m.responses[key]; exists {
		return resp, nil
	}
	
	// Default response
	return &http.Response{
		StatusCode: 200,
		Header:     make(http.Header),
		Body:       http.NoBody,
	}, nil
}

// SetResponse sets a mock response for a request
func (m *MockHTTPClient) SetResponse(method, url string, response *http.Response) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := method + " " + url
	m.responses[key] = response
}

// SetError sets a mock error for a request
func (m *MockHTTPClient) SetError(method, url string, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := method + " " + url
	m.errors[key] = err
}

// GetRequests returns all recorded requests
func (m *MockHTTPClient) GetRequests() []*http.Request {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return append([]*http.Request{}, m.requests...)
}

// ClearRequests clears recorded requests
func (m *MockHTTPClient) ClearRequests() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.requests = m.requests[:0]
}

// MockDatabase provides a mock database for testing
type MockDatabase struct {
	mu      sync.RWMutex
	data    map[string]interface{}
	queries []string
	errors  map[string]error
}

// NewMockDatabase creates a new mock database
func NewMockDatabase() *MockDatabase {
	return &MockDatabase{
		data:    make(map[string]interface{}),
		queries: make([]string, 0),
		errors:  make(map[string]error),
	}
}

// Query executes a mock query
func (m *MockDatabase) Query(ctx context.Context, query string, args ...interface{}) (interface{}, error) {
	m.mu.Lock()
	m.queries = append(m.queries, query)
	m.mu.Unlock()
	
	m.mu.RLock()
	defer m.mu.RUnlock()
	
	if err, exists := m.errors[query]; exists {
		return nil, err
	}
	
	return m.data[query], nil
}

// Exec executes a mock command
func (m *MockDatabase) Exec(ctx context.Context, query string, args ...interface{}) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	
	m.queries = append(m.queries, query)
	
	if err, exists := m.errors[query]; exists {
		return err
	}
	
	return nil
}

// SetData sets mock data for a query
func (m *MockDatabase) SetData(query string, data interface{}) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.data[query] = data
}

// SetError sets a mock error for a query
func (m *MockDatabase) SetError(query string, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.errors[query] = err
}

// GetQueries returns all executed queries
func (m *MockDatabase) GetQueries() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return append([]string{}, m.queries...)
}

// ClearQueries clears recorded queries
func (m *MockDatabase) ClearQueries() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.queries = m.queries[:0]
}