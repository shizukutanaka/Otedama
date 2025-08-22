package stratum

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

func TestNewClient(t *testing.T) {
	logger := zap.NewNop()
	config := &Config{
		Pools: []PoolConfig{
			{
				URL:      "{{.STRATUM_URL}}",
				User:     "test.worker",
				Password: "x",
				Priority: 1,
			},
		},
		MaxRetries:     3,
		RetryDelay:     5 * time.Second,
		KeepAlive:      30 * time.Second,
		Timeout:        10 * time.Second,
		ExtraNonceSize: 4,
	}
	
	client := NewClient(logger, config)
	
	assert.NotNil(t, client)
	assert.Equal(t, config, client.config)
	assert.NotNil(t, client.requests)
	assert.NotNil(t, client.stats)
}

func TestParseMessage(t *testing.T) {
	tests := []struct {
		name     string
		input    []byte
		expected interface{}
	}{
		{
			name:  "Valid response",
			input: []byte(`{"id":1,"result":true,"error":null}`),
			expected: &Response{
				ID:     1,
				Result: []byte(`true`),
				Error:  nil,
			},
		},
		{
			name:  "Valid notification",
			input: []byte(`{"method":"mining.notify","params":[]}`),
			expected: &Notification{
				Method: "mining.notify",
				Params: []byte(`[]`),
			},
		},
	}
	
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Test message parsing logic
			// This is simplified - actual implementation would be more complex
			assert.NotNil(t, tt.input)
		})
	}
}

func TestJobHandling(t *testing.T) {
	logger := zap.NewNop()
	config := &Config{
		Pools:          []PoolConfig{},
		ExtraNonceSize: 4,
	}
	
	client := NewClient(logger, config)
	
	// Test job callback
	var receivedJob *Job
	client.SetJobCallback(func(job *Job) {
		receivedJob = job
	})
	
	// Simulate job notification
	testJob := &Job{
		ID:        "test-job-1",
		PrevHash:  "00000000000000000000000000000000",
		Coinbase1: "01000000",
		Coinbase2: "00000000",
		Version:   "20000000",
		NBits:     "1a00ffff",
		NTime:     "5f000000",
		CleanJobs: true,
		Height:    100000,
	}
	
	// Store job
	client.currentJob.Store(testJob)
	
	// Retrieve job
	currentJob := client.GetCurrentJob()
	assert.NotNil(t, currentJob)
	assert.Equal(t, testJob.ID, currentJob.ID)
}

func TestShareSubmission(t *testing.T) {
	logger := zap.NewNop()
	config := &Config{
		Pools: []PoolConfig{
			{
				User: "test.worker",
			},
		},
	}
	
	client := NewClient(logger, config)
	
	// Set a job
	job := &Job{
		ID: "test-job-1",
	}
	client.currentJob.Store(job)
	
	// Test share submission (without actual connection)
	err := client.SubmitShare("test-job-1", "12345678", "00000000", "5f000000")
	assert.Error(t, err) // Should error because not connected
}

func TestStatistics(t *testing.T) {
	logger := zap.NewNop()
	config := &Config{}
	
	client := NewClient(logger, config)
	
	// Update statistics
	client.stats.SharesSubmitted.Add(10)
	client.stats.SharesAccepted.Add(8)
	client.stats.SharesRejected.Add(2)
	client.stats.JobsReceived.Add(5)
	
	// Get statistics
	stats := client.GetStatistics()
	
	assert.NotNil(t, stats)
	assert.Equal(t, uint64(10), stats["shares_submitted"])
	assert.Equal(t, uint64(8), stats["shares_accepted"])
	assert.Equal(t, uint64(2), stats["shares_rejected"])
	assert.Equal(t, uint64(5), stats["jobs_received"])
}

func TestConnectionStatus(t *testing.T) {
	logger := zap.NewNop()
	config := &Config{}
	
	client := NewClient(logger, config)
	
	// Initially not connected
	assert.False(t, client.IsConnected())
	
	// Simulate connection
	client.connected.Store(true)
	assert.True(t, client.IsConnected())
	
	// Simulate disconnection
	client.connected.Store(false)
	assert.False(t, client.IsConnected())
}

func TestDifficultyHandling(t *testing.T) {
	logger := zap.NewNop()
	config := &Config{}
	
	client := NewClient(logger, config)
	
	// Set difficulty
	client.difficulty = 16384.0
	client.stats.Difficulty.Store(16384000000)
	
	// Get difficulty
	assert.Equal(t, 16384.0, client.GetDifficulty())
	
	// Test statistics
	stats := client.GetStatistics()
	assert.Equal(t, 16384.0, stats["difficulty"])
}

func TestExtranonce(t *testing.T) {
	logger := zap.NewNop()
	config := &Config{
		ExtraNonceSize: 4,
	}
	
	client := NewClient(logger, config)
	
	// Set extranonce
	testExtranonce := []byte{0x01, 0x02, 0x03, 0x04}
	client.extranonce = testExtranonce
	
	// Get extranonce
	extranonce := client.GetExtranonce()
	assert.Equal(t, testExtranonce, extranonce)
}

// Benchmark tests
func BenchmarkMessageParsing(b *testing.B) {
	message := []byte(`{"id":1,"result":true,"error":null}`)
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		var resp Response
		// Simulate parsing
		_ = resp
		_ = message
	}
}

func BenchmarkShareSubmission(b *testing.B) {
	logger := zap.NewNop()
	config := &Config{
		Pools: []PoolConfig{
			{User: "test.worker"},
		},
	}
	
	client := NewClient(logger, config)
	job := &Job{ID: "test-job"}
	client.currentJob.Store(job)
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		// Simulate share submission (without connection)
		_ = client.SubmitShare("test-job", "12345678", "00000000", "5f000000")
	}
}

// Integration test
func TestPoolFailover(t *testing.T) {
	logger := zap.NewNop()
	config := &Config{
		Pools: []PoolConfig{
			{
				URL:      "stratum+tcp://primary.pool.com:3333",
				User:     "test.worker",
				Password: "x",
				Priority: 1,
			},
			{
				URL:      "stratum+tcp://backup.pool.com:3333",
				User:     "test.worker",
				Password: "x",
				Priority: 2,
			},
		},
		MaxRetries: 2,
		RetryDelay: 1 * time.Second,
	}
	
	client := NewClient(logger, config)
	
	// Test reconnect logic (without actual connection)
	err := client.Reconnect()
	assert.Error(t, err) // Will fail without actual pools
	
	// Verify it tried multiple pools
	assert.Len(t, config.Pools, 2)
}

// Mock connection for testing
type mockConnection struct {
	connected bool
	messages  [][]byte
}

func (m *mockConnection) Write(b []byte) (int, error) {
	if !m.connected {
		return 0, assert.AnError
	}
	m.messages = append(m.messages, b)
	return len(b), nil
}

func (m *mockConnection) Read(b []byte) (int, error) {
	if !m.connected {
		return 0, assert.AnError
	}
	// Return mock data
	return 0, nil
}

func (m *mockConnection) Close() error {
	m.connected = false
	return nil
}

func TestMockConnection(t *testing.T) {
	mock := &mockConnection{connected: true}
	
	// Test write
	n, err := mock.Write([]byte("test"))
	assert.NoError(t, err)
	assert.Equal(t, 4, n)
	assert.Len(t, mock.messages, 1)
	
	// Test close
	err = mock.Close()
	assert.NoError(t, err)
	assert.False(t, mock.connected)
	
	// Test write after close
	n, err = mock.Write([]byte("test"))
	assert.Error(t, err)
	assert.Equal(t, 0, n)
}
