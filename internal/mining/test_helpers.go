package mining

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"go.uber.org/zap"
)

// MockEngine is a mock implementation of the Engine for testing
type MockEngine struct {
	config       Config
	logger       *zap.Logger
	running      atomic.Bool
	hashRate     atomic.Uint64
	startCalled  int
	stopCalled   int
	jobsReceived []*MiningJob
	mu           sync.Mutex
}

// NewMockEngine creates a new mock engine
func NewMockEngine(config Config, logger *zap.Logger) *MockEngine {
	return &MockEngine{
		config:       config,
		logger:       logger,
		jobsReceived: make([]*MiningJob, 0),
	}
}

// Start mock implementation
func (m *MockEngine) Start(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	
	if m.running.Load() {
		return fmt.Errorf("engine already running")
	}
	
	m.startCalled++
	m.running.Store(true)
	return nil
}

// Stop mock implementation
func (m *MockEngine) Stop() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	
	m.stopCalled++
	m.running.Store(false)
	return nil
}

// SubmitJob mock implementation
func (m *MockEngine) SubmitJob(job *MiningJob) {
	m.mu.Lock()
	defer m.mu.Unlock()
	
	m.jobsReceived = append(m.jobsReceived, job)
}

// GetHashRate mock implementation
func (m *MockEngine) GetHashRate() uint64 {
	return m.hashRate.Load()
}

// SetHashRate sets the mock hash rate
func (m *MockEngine) SetHashRate(rate uint64) {
	m.hashRate.Store(rate)
}

// GetJobsReceived returns all jobs received by the mock
func (m *MockEngine) GetJobsReceived() []*MiningJob {
	m.mu.Lock()
	defer m.mu.Unlock()
	
	jobs := make([]*MiningJob, len(m.jobsReceived))
	copy(jobs, m.jobsReceived)
	return jobs
}

// TestJobGenerator generates test mining jobs
type TestJobGenerator struct {
	idCounter   uint64
	nonceStart  uint64
	nonceRange  uint64
}

// NewTestJobGenerator creates a new test job generator
func NewTestJobGenerator() *TestJobGenerator {
	return &TestJobGenerator{
		nonceRange: 1000000,
	}
}

// GenerateJob generates a test mining job
func (g *TestJobGenerator) GenerateJob() *MiningJob {
	id := atomic.AddUint64(&g.idCounter, 1)
	start := atomic.AddUint64(&g.nonceStart, g.nonceRange)
	
	return &MiningJob{
		ID:         fmt.Sprintf("test-job-%d", id),
		Header:     []byte(fmt.Sprintf("header-%d", id)),
		Target:     []byte{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff},
		Coinbase1:  []byte("coinbase1"),
		Coinbase2:  []byte("coinbase2"),
		Difficulty: 0x1d00ffff,
		StartNonce: start,
		EndNonce:   start + g.nonceRange,
	}
}

// WaitForCondition waits for a condition to be true with timeout
func WaitForCondition(t *testing.T, timeout time.Duration, check func() bool, msg string) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if check() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("Timeout waiting for condition: %s", msg)
}

// AssertEventually asserts that a condition becomes true eventually
func AssertEventually(t *testing.T, condition func() bool, timeout time.Duration, msg string) {
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	
	timeoutCh := time.After(timeout)
	
	for {
		select {
		case <-ticker.C:
			if condition() {
				return
			}
		case <-timeoutCh:
			t.Fatalf("Condition not met within timeout: %s", msg)
		}
	}
}

// MockHardwareDetector is a mock implementation of HardwareDetector
type MockHardwareDetector struct {
	hardware []HardwareInfo
	mu       sync.Mutex
}

// NewMockHardwareDetector creates a new mock hardware detector
func NewMockHardwareDetector() *MockHardwareDetector {
	return &MockHardwareDetector{
		hardware: []HardwareInfo{
			{
				Type:         HardwareCPU,
				Name:         "Test CPU",
				Vendor:       "TestVendor",
				Memory:       8 * 1024 * 1024 * 1024, // 8GB
				ComputeUnits: 8,
				MaxThreads:   16,
				IsAvailable:  true,
			},
		},
	}
}

// DetectHardware mock implementation
func (m *MockHardwareDetector) DetectHardware() error {
	return nil
}

// GetAvailableHardware mock implementation
func (m *MockHardwareDetector) GetAvailableHardware() []HardwareInfo {
	m.mu.Lock()
	defer m.mu.Unlock()
	
	hw := make([]HardwareInfo, len(m.hardware))
	copy(hw, m.hardware)
	return hw
}

// GetHardwareByType mock implementation
func (m *MockHardwareDetector) GetHardwareByType(hwType HardwareType) []HardwareInfo {
	m.mu.Lock()
	defer m.mu.Unlock()
	
	var result []HardwareInfo
	for _, hw := range m.hardware {
		if hw.Type == hwType {
			result = append(result, hw)
		}
	}
	return result
}

// AddHardware adds hardware to the mock detector
func (m *MockHardwareDetector) AddHardware(hw HardwareInfo) {
	m.mu.Lock()
	defer m.mu.Unlock()
	
	m.hardware = append(m.hardware, hw)
}

// TestLogger creates a test logger that captures log entries
type TestLogger struct {
	*zap.Logger
	entries []string
	mu      sync.Mutex
}

// NewTestLogger creates a new test logger
func NewTestLogger(t *testing.T) *TestLogger {
	logger := &TestLogger{
		Logger:  zap.NewNop(),
		entries: make([]string, 0),
	}
	return logger
}

// CaptureLog captures a log entry
func (l *TestLogger) CaptureLog(msg string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.entries = append(l.entries, msg)
}

// GetLogs returns all captured log entries
func (l *TestLogger) GetLogs() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	
	logs := make([]string, len(l.entries))
	copy(logs, l.entries)
	return logs
}

// BenchmarkHelper provides utilities for benchmarking
type BenchmarkHelper struct {
	startTime time.Time
	hashes    uint64
}

// NewBenchmarkHelper creates a new benchmark helper
func NewBenchmarkHelper() *BenchmarkHelper {
	return &BenchmarkHelper{
		startTime: time.Now(),
	}
}

// AddHashes adds to the hash counter
func (b *BenchmarkHelper) AddHashes(count uint64) {
	atomic.AddUint64(&b.hashes, count)
}

// GetHashRate calculates the current hash rate
func (b *BenchmarkHelper) GetHashRate() float64 {
	elapsed := time.Since(b.startTime).Seconds()
	if elapsed == 0 {
		return 0
	}
	return float64(atomic.LoadUint64(&b.hashes)) / elapsed
}

// Reset resets the benchmark
func (b *BenchmarkHelper) Reset() {
	b.startTime = time.Now()
	atomic.StoreUint64(&b.hashes, 0)
}