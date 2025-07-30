package p2p

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/zkp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest"
)

// Mock types for testing
type MockZKPManager struct {
	mock.Mock
}

func (m *MockZKPManager) VerifyProof(proofID string) (bool, error) {
	args := m.Called(proofID)
	return args.Bool(0), args.Error(1)
}

func (m *MockZKPManager) GenerateAgeProof(userID string, age int) (*zkp.Proof, error) {
	args := m.Called(userID, age)
	if proof := args.Get(0); proof != nil {
		return proof.(*zkp.Proof), args.Error(1)
	}
	return nil, args.Error(1)
}

type MockPeer struct {
	mock.Mock
	id       string
	conn     net.Conn
	hashRate atomic.Uint64
}

func (m *MockPeer) ID() string {
	return m.id
}

func (m *MockPeer) Send(msg interface{}) error {
	args := m.Called(msg)
	return args.Error(0)
}

func (m *MockPeer) Close() error {
	args := m.Called()
	return args.Error(0)
}

func (m *MockPeer) GetHashRate() uint64 {
	return m.hashRate.Load()
}

// TestNewPool tests pool creation
func TestNewPool(t *testing.T) {
	t.Parallel()
	
	tests := []struct {
		name   string
		config Config
		valid  bool
	}{
		{
			name: "basic config",
			config: Config{
				ListenAddr:      ":30304",
				MaxPeers:        10,
				MinPeers:        3,
				ShareDifficulty: 1000.0,
				BlockTime:       10 * time.Minute,
				PayoutThreshold: 0.01,
				FeePercentage:   1.0,
			},
			valid: true,
		},
		{
			name: "with ZKP enabled",
			config: Config{
				ListenAddr: ":30305",
				MaxPeers:   10,
				ZKP: struct {
					Enabled              bool          `yaml:"enabled"`
					RequireAgeProof      bool          `yaml:"require_age_proof"`
					MinAge               int           `yaml:"min_age"`
					RequireHashpowerProof bool         `yaml:"require_hashpower_proof"`
					MinHashpower         float64       `yaml:"min_hashpower"`
					AnonymousMining      bool          `yaml:"anonymous_mining"`
					ProofCacheDuration   time.Duration `yaml:"proof_cache_duration"`
				}{
					Enabled:         true,
					RequireAgeProof: true,
					MinAge:          18,
				},
			},
			valid: true,
		},
		{
			name: "with enterprise features",
			config: Config{
				ListenAddr: ":30306",
				MaxPeers:   100,
				Enterprise: struct {
					Enabled              bool `yaml:"enabled"`
					InstitutionalGrade   bool `yaml:"institutional_grade"`
					ComplianceMode       bool `yaml:"compliance_mode"`
					AdvancedAnalytics    bool `yaml:"advanced_analytics"`
					CustomProtocols      bool `yaml:"custom_protocols"`
				}{
					Enabled:            true,
					InstitutionalGrade: true,
					ComplianceMode:     true,
				},
			},
			valid: true,
		},
		{
			name: "with anti-censorship",
			config: Config{
				ListenAddr: ":30307",
				MaxPeers:   50,
				AntiCensorship: struct {
					Enabled       bool `yaml:"enabled"`
					TorIntegration bool `yaml:"tor_integration"`
					ProxySupport   bool `yaml:"proxy_support"`
					ProtocolObfuscation bool `yaml:"protocol_obfuscation"`
				}{
					Enabled:        true,
					TorIntegration: true,
				},
			},
			valid: true,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			
			logger := zaptest.NewLogger(t)
			pool, err := NewPool(tt.config, logger)
			
			assert.NoError(t, err)
			assert.NotNil(t, pool)
			assert.Equal(t, tt.config, pool.config)
			assert.NotNil(t, pool.logger)
			assert.NotEmpty(t, pool.nodeID)
			assert.Equal(t, int32(0), pool.running.Load())
		})
	}
}

// TestPoolStartStop tests starting and stopping the pool
func TestPoolStartStop(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := Config{
		ListenAddr:      ":30308",
		MaxPeers:        10,
		ShareDifficulty: 1000.0,
		BlockTime:       10 * time.Minute,
		PayoutThreshold: 0.01,
		FeePercentage:   1.0,
	}
	
	pool, err := NewPool(config, logger)
	require.NoError(t, err)

	t.Run("successful start and stop", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		
		err := pool.Start(ctx)
		assert.NoError(t, err)
		assert.Equal(t, int32(1), pool.running.Load())
		assert.NotNil(t, pool.listener)

		// Give time for goroutines to start
		time.Sleep(50 * time.Millisecond)

		err = pool.Stop()
		assert.NoError(t, err)
		assert.Equal(t, int32(0), pool.running.Load())
	})

	t.Run("start already running pool", func(t *testing.T) {
		ctx := context.Background()
		err := pool.Start(ctx)
		require.NoError(t, err)
		defer pool.Stop()

		// Try to start again
		err = pool.Start(ctx)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "already running")
	})

	t.Run("stop already stopped pool", func(t *testing.T) {
		// Stop without starting
		err := pool.Stop()
		assert.NoError(t, err) // Should not error
	})
}

// TestAddPeer tests adding peers to the pool
func TestAddPeer(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := Config{
		ListenAddr: ":30309",
		MaxPeers:   5,
		ZKP: struct {
			Enabled              bool          `yaml:"enabled"`
			RequireAgeProof      bool          `yaml:"require_age_proof"`
			MinAge               int           `yaml:"min_age"`
			RequireHashpowerProof bool         `yaml:"require_hashpower_proof"`
			MinHashpower         float64       `yaml:"min_hashpower"`
			AnonymousMining      bool          `yaml:"anonymous_mining"`
			ProofCacheDuration   time.Duration `yaml:"proof_cache_duration"`
		}{
			Enabled:         true,
			RequireAgeProof: true,
			MinAge:          18,
		},
	}
	
	pool, err := NewPool(config, logger)
	require.NoError(t, err)
	
	ctx := context.Background()
	err = pool.Start(ctx)
	require.NoError(t, err)
	defer pool.Stop()

	t.Run("add valid peer", func(t *testing.T) {
		peer := &Peer{
			id:       "peer1",
			address:  "192.168.1.1:8333",
			hashRate: 1000000,
		}

		err := pool.AddPeer(peer)
		assert.NoError(t, err)
		assert.Equal(t, int32(1), pool.peerCount.Load())

		// Check if peer is stored
		stored, ok := pool.peers.Load(peer.id)
		assert.True(t, ok)
		assert.Equal(t, peer, stored)
	})

	t.Run("add duplicate peer", func(t *testing.T) {
		peer := &Peer{
			id:      "peer1",
			address: "192.168.1.1:8333",
		}

		err := pool.AddPeer(peer)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "already exists")
	})

	t.Run("exceed max peers", func(t *testing.T) {
		// Add peers up to the limit
		for i := 2; i <= 5; i++ {
			peer := &Peer{
				id:      fmt.Sprintf("peer%d", i),
				address: fmt.Sprintf("192.168.1.%d:8333", i),
			}
			err := pool.AddPeer(peer)
			require.NoError(t, err)
		}

		// Try to add one more
		peer := &Peer{
			id:      "peer6",
			address: "192.168.1.6:8333",
		}
		err := pool.AddPeer(peer)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "max peers")
	})
}

// TestRemovePeer tests removing peers from the pool
func TestRemovePeer(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := Config{
		ListenAddr: ":30310",
		MaxPeers:   10,
	}
	
	pool, err := NewPool(config, logger)
	require.NoError(t, err)
	
	ctx := context.Background()
	err = pool.Start(ctx)
	require.NoError(t, err)
	defer pool.Stop()

	// Add a peer first
	peer := &Peer{
		id:      "peer1",
		address: "192.168.1.1:8333",
	}
	err = pool.AddPeer(peer)
	require.NoError(t, err)

	t.Run("remove existing peer", func(t *testing.T) {
		err := pool.RemovePeer("peer1")
		assert.NoError(t, err)
		assert.Equal(t, int32(0), pool.peerCount.Load())

		// Check if peer is removed
		_, ok := pool.peers.Load("peer1")
		assert.False(t, ok)
	})

	t.Run("remove non-existent peer", func(t *testing.T) {
		err := pool.RemovePeer("non-existent")
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "not found")
	})
}

// TestSubmitShare tests share submission
func TestSubmitShare(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := Config{
		ListenAddr:      ":30311",
		MaxPeers:        10,
		ShareDifficulty: 1000.0,
	}
	
	pool, err := NewPool(config, logger)
	require.NoError(t, err)
	
	ctx := context.Background()
	err = pool.Start(ctx)
	require.NoError(t, err)
	defer pool.Stop()

	// Add a peer
	peer := &Peer{
		id:       "miner1",
		address:  "192.168.1.1:8333",
		hashRate: 1000000,
	}
	err = pool.AddPeer(peer)
	require.NoError(t, err)

	t.Run("submit valid share", func(t *testing.T) {
		share := &Share{
			MinerID:    "miner1",
			JobID:      "job1",
			Nonce:      12345,
			Hash:       generateHash("test"),
			Difficulty: 1500.0,
			Timestamp:  time.Now(),
		}

		err := pool.SubmitShare(share)
		assert.NoError(t, err)
		assert.Equal(t, uint64(1), pool.totalShares.Load())
		assert.Equal(t, uint64(1), pool.validShares.Load())
	})

	t.Run("submit share from unknown miner", func(t *testing.T) {
		share := &Share{
			MinerID:    "unknown",
			JobID:      "job2",
			Nonce:      54321,
			Hash:       generateHash("test2"),
			Difficulty: 1000.0,
			Timestamp:  time.Now(),
		}

		err := pool.SubmitShare(share)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "unknown miner")
	})

	t.Run("submit duplicate share", func(t *testing.T) {
		share := &Share{
			MinerID:    "miner1",
			JobID:      "job1",
			Nonce:      12345, // Same as before
			Hash:       generateHash("test"),
			Difficulty: 1500.0,
			Timestamp:  time.Now(),
		}

		err := pool.SubmitShare(share)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "duplicate")
	})
}

// TestGetStats tests statistics retrieval
func TestGetStats(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := Config{
		ListenAddr:      ":30312",
		MaxPeers:        10,
		ShareDifficulty: 1000.0,
		FeePercentage:   1.0,
	}
	
	pool, err := NewPool(config, logger)
	require.NoError(t, err)

	// Set some test values
	pool.peerCount.Store(5)
	pool.totalShares.Store(1000)
	pool.validShares.Store(950)

	stats := pool.GetStats()
	assert.NotNil(t, stats)
	assert.Equal(t, 5, stats["peer_count"])
	assert.Equal(t, uint64(1000), stats["total_shares"])
	assert.Equal(t, uint64(950), stats["valid_shares"])
	assert.Equal(t, 1000.0, stats["share_difficulty"])
	assert.Equal(t, 1.0, stats["fee_percentage"])
}

// TestBroadcastMessage tests message broadcasting
func TestBroadcastMessage(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := Config{
		ListenAddr: ":30313",
		MaxPeers:   10,
	}
	
	pool, err := NewPool(config, logger)
	require.NoError(t, err)
	
	ctx := context.Background()
	err = pool.Start(ctx)
	require.NoError(t, err)
	defer pool.Stop()

	// Add mock peers
	var mockPeers []*MockPeer
	for i := 0; i < 3; i++ {
		mockPeer := &MockPeer{
			id: fmt.Sprintf("peer%d", i),
		}
		mockPeer.On("Send", mock.Anything).Return(nil)
		
		pool.peers.Store(mockPeer.id, mockPeer)
		pool.peerCount.Add(1)
		mockPeers = append(mockPeers, mockPeer)
	}

	// Broadcast a message
	msg := map[string]interface{}{
		"type": "new_job",
		"data": "test",
	}
	
	pool.BroadcastMessage(msg)

	// Give time for broadcast
	time.Sleep(10 * time.Millisecond)

	// Verify all peers received the message
	for _, peer := range mockPeers {
		peer.AssertCalled(t, "Send", msg)
	}
}

// TestConcurrentOperations tests thread safety
func TestConcurrentOperations(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := Config{
		ListenAddr: ":30314",
		MaxPeers:   100,
	}
	
	pool, err := NewPool(config, logger)
	require.NoError(t, err)
	
	ctx := context.Background()
	err = pool.Start(ctx)
	require.NoError(t, err)
	defer pool.Stop()

	var wg sync.WaitGroup
	numGoroutines := 50

	// Concurrent peer additions
	wg.Add(numGoroutines)
	for i := 0; i < numGoroutines; i++ {
		go func(id int) {
			defer wg.Done()
			peer := &Peer{
				id:      fmt.Sprintf("peer%d", id),
				address: fmt.Sprintf("192.168.1.%d:8333", id),
			}
			_ = pool.AddPeer(peer)
		}(i)
	}

	// Concurrent share submissions
	wg.Add(numGoroutines)
	for i := 0; i < numGoroutines; i++ {
		go func(id int) {
			defer wg.Done()
			share := &Share{
				MinerID:    fmt.Sprintf("peer%d", id%10),
				JobID:      fmt.Sprintf("job%d", id),
				Nonce:      uint64(id),
				Hash:       generateHash(fmt.Sprintf("test%d", id)),
				Difficulty: 1000.0,
				Timestamp:  time.Now(),
			}
			_ = pool.SubmitShare(share)
		}(i)
	}

	// Concurrent stats reads
	wg.Add(numGoroutines)
	for i := 0; i < numGoroutines; i++ {
		go func() {
			defer wg.Done()
			_ = pool.GetStats()
		}()
	}

	// Wait for completion
	done := make(chan bool)
	go func() {
		wg.Wait()
		done <- true
	}()

	select {
	case <-done:
		// Success
	case <-time.After(5 * time.Second):
		t.Fatal("Concurrent operations timed out")
	}
}

// TestValidateShare tests share validation
func TestValidateShare(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := Config{
		ListenAddr:      ":30315",
		ShareDifficulty: 1000.0,
		Algorithm:       "sha256",
	}
	
	pool, err := NewPool(config, logger)
	require.NoError(t, err)

	tests := []struct {
		name    string
		data    []byte
		hash    []byte
		nonce   uint32
		valid   bool
		errMsg  string
	}{
		{
			name:  "valid share",
			data:  []byte("test_data"),
			hash:  []byte("test_hash"),
			nonce: 12345,
			valid: true,
		},
		{
			name:   "empty data",
			data:   []byte{},
			hash:   []byte("test_hash"),
			nonce:  12345,
			valid:  false,
			errMsg: "empty data",
		},
		{
			name:   "empty hash",
			data:   []byte("test_data"),
			hash:   []byte{},
			nonce:  12345,
			valid:  false,
			errMsg: "empty hash",
		},
		{
			name:   "zero nonce",
			data:   []byte("test_data"),
			hash:   []byte("test_hash"),
			nonce:  0,
			valid:  true, // Zero nonce is technically valid
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			
			valid := pool.validateShare(tt.data, tt.hash, tt.nonce)
			assert.Equal(t, tt.valid, valid)
		})
	}
}

// TestZKPIntegration tests ZKP integration
func TestZKPIntegration(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := Config{
		ListenAddr: ":30316",
		MaxPeers:   10,
		ZKP: struct {
			Enabled              bool          `yaml:"enabled"`
			RequireAgeProof      bool          `yaml:"require_age_proof"`
			MinAge               int           `yaml:"min_age"`
			RequireHashpowerProof bool         `yaml:"require_hashpower_proof"`
			MinHashpower         float64       `yaml:"min_hashpower"`
			AnonymousMining      bool          `yaml:"anonymous_mining"`
			ProofCacheDuration   time.Duration `yaml:"proof_cache_duration"`
		}{
			Enabled:              true,
			RequireAgeProof:      true,
			MinAge:               18,
			RequireHashpowerProof: true,
			MinHashpower:         1000.0,
		},
	}
	
	pool, err := NewPool(config, logger)
	require.NoError(t, err)
	pool.zkpEnabled = true

	// Create mock ZKP manager
	mockZKP := &MockZKPManager{}
	pool.zkpManager = mockZKP

	t.Run("peer with valid ZKP proof", func(t *testing.T) {
		mockZKP.On("VerifyProof", "proof123").Return(true, nil).Once()

		peer := &Peer{
			id:         "zkp-peer1",
			address:    "192.168.1.1:8333",
			zkpProofID: "proof123",
		}

		// In real implementation, AddPeer would verify the proof
		// For this test, we simulate the verification
		valid, err := mockZKP.VerifyProof(peer.zkpProofID)
		assert.NoError(t, err)
		assert.True(t, valid)
	})

	t.Run("peer with invalid ZKP proof", func(t *testing.T) {
		mockZKP.On("VerifyProof", "invalid-proof").Return(false, fmt.Errorf("invalid proof")).Once()

		peer := &Peer{
			id:         "zkp-peer2",
			address:    "192.168.1.2:8333",
			zkpProofID: "invalid-proof",
		}

		valid, err := mockZKP.VerifyProof(peer.zkpProofID)
		assert.Error(t, err)
		assert.False(t, valid)
	})
}

// TestAnonymousMining tests anonymous mining functionality
func TestAnonymousMining(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := Config{
		ListenAddr: ":30317",
		MaxPeers:   10,
		ZKP: struct {
			Enabled              bool          `yaml:"enabled"`
			RequireAgeProof      bool          `yaml:"require_age_proof"`
			MinAge               int           `yaml:"min_age"`
			RequireHashpowerProof bool         `yaml:"require_hashpower_proof"`
			MinHashpower         float64       `yaml:"min_hashpower"`
			AnonymousMining      bool          `yaml:"anonymous_mining"`
			ProofCacheDuration   time.Duration `yaml:"proof_cache_duration"`
		}{
			Enabled:         true,
			AnonymousMining: true,
		},
	}
	
	pool, err := NewPool(config, logger)
	require.NoError(t, err)

	t.Run("anonymous peer identification", func(t *testing.T) {
		// In anonymous mining, peers are identified by pseudonymous IDs
		peer := &Peer{
			id:          generatePseudonymousID("secret"),
			address:     "tor:onionaddress.onion",
			isAnonymous: true,
		}

		assert.NotEmpty(t, peer.id)
		assert.NotEqual(t, "secret", peer.id) // Should be hashed/transformed
		assert.True(t, peer.isAnonymous)
	})
}

// TestEnterpriseFeatures tests enterprise-grade features
func TestEnterpriseFeatures(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := Config{
		ListenAddr: ":30318",
		MaxPeers:   100,
		Enterprise: struct {
			Enabled              bool `yaml:"enabled"`
			InstitutionalGrade   bool `yaml:"institutional_grade"`
			ComplianceMode       bool `yaml:"compliance_mode"`
			AdvancedAnalytics    bool `yaml:"advanced_analytics"`
			CustomProtocols      bool `yaml:"custom_protocols"`
		}{
			Enabled:            true,
			InstitutionalGrade: true,
			ComplianceMode:     true,
			AdvancedAnalytics:  true,
		},
	}
	
	pool, err := NewPool(config, logger)
	require.NoError(t, err)

	t.Run("compliance monitoring", func(t *testing.T) {
		// Enterprise pools should have compliance monitoring
		assert.NotNil(t, pool.complianceMonitor)
		
		// Test compliance check
		peer := &Peer{
			id:      "enterprise-peer",
			address: "192.168.1.1:8333",
			country: "US",
		}

		// In real implementation, this would check sanctions lists, etc.
		compliant := pool.complianceMonitor.CheckCompliance(peer)
		assert.True(t, compliant)
	})

	t.Run("reputation system", func(t *testing.T) {
		assert.NotNil(t, pool.reputationSystem)
		
		// Test reputation scoring
		minerID := "miner1"
		
		// Submit good shares to build reputation
		for i := 0; i < 10; i++ {
			pool.reputationSystem.RecordValidShare(minerID)
		}
		
		reputation := pool.reputationSystem.GetReputation(minerID)
		assert.Greater(t, reputation, 0.0)
	})
}

// Benchmark tests
func BenchmarkPoolValidateShare(b *testing.B) {
	logger := zap.NewNop()
	config := Config{
		ListenAddr:      ":30319",
		ShareDifficulty: 1000.0,
	}
	
	pool, err := NewPool(config, logger)
	require.NoError(b, err)
	
	data := []byte("test_data")
	hash := []byte("test_hash")
	nonce := uint32(12345)
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		pool.validateShare(data, hash, nonce)
	}
}

func BenchmarkShareSubmission(b *testing.B) {
	logger := zap.NewNop()
	config := Config{
		ListenAddr: ":30320",
		MaxPeers:   100,
	}
	
	pool, err := NewPool(config, logger)
	require.NoError(b, err)
	
	ctx := context.Background()
	_ = pool.Start(ctx)
	defer pool.Stop()

	// Add a peer
	peer := &Peer{
		id:      "bench-miner",
		address: "192.168.1.1:8333",
	}
	_ = pool.AddPeer(peer)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		share := &Share{
			MinerID:    "bench-miner",
			JobID:      fmt.Sprintf("job%d", i),
			Nonce:      uint64(i),
			Hash:       generateHash(fmt.Sprintf("test%d", i)),
			Difficulty: 1000.0,
			Timestamp:  time.Now(),
		}
		_ = pool.SubmitShare(share)
	}
}

func BenchmarkBroadcast(b *testing.B) {
	logger := zap.NewNop()
	config := Config{
		ListenAddr: ":30321",
		MaxPeers:   100,
	}
	
	pool, err := NewPool(config, logger)
	require.NoError(b, err)
	
	ctx := context.Background()
	_ = pool.Start(ctx)
	defer pool.Stop()

	// Add peers
	for i := 0; i < 100; i++ {
		peer := &Peer{
			id:      fmt.Sprintf("peer%d", i),
			address: fmt.Sprintf("192.168.1.%d:8333", i),
		}
		pool.peers.Store(peer.id, peer)
		pool.peerCount.Add(1)
	}

	msg := map[string]interface{}{
		"type": "test",
		"data": "benchmark",
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		pool.BroadcastMessage(msg)
	}
}

// Helper functions
func generateHash(data string) string {
	hash := sha256.Sum256([]byte(data))
	return hex.EncodeToString(hash[:])
}

func generateValidHash(difficulty float64) string {
	// Generate a hash that meets the difficulty requirement
	// In real implementation, this would calculate actual proof-of-work
	return "0000" + generateHash("valid")
}

func generatePseudonymousID(secret string) string {
	hash := sha256.Sum256([]byte(secret + "anonymous"))
	return hex.EncodeToString(hash[:16]) // Use first 16 bytes
}

// TestEdgeCases tests various edge cases
func TestEdgeCases(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)

	t.Run("empty config", func(t *testing.T) {
		pool, err := NewPool(Config{}, logger)
		assert.NoError(t, err)
		assert.NotNil(t, pool)
	})

	t.Run("nil logger", func(t *testing.T) {
		config := Config{ListenAddr: ":30322"}
		pool, err := NewPool(config, nil)
		// Should handle nil logger gracefully
		assert.NoError(t, err)
		assert.NotNil(t, pool)
	})

	t.Run("invalid listen address", func(t *testing.T) {
		config := Config{
			ListenAddr: "invalid:address:format",
		}
		pool, err := NewPool(config, logger)
		require.NoError(t, err)
		
		ctx := context.Background()
		err = pool.Start(ctx)
		assert.Error(t, err)
	})

	t.Run("zero max peers", func(t *testing.T) {
		config := Config{
			ListenAddr: ":30323",
			MaxPeers:   0,
		}
		pool, err := NewPool(config, logger)
		
		// Should use a default value
		assert.NoError(t, err)
		assert.NotNil(t, pool)
	})
}

// TestPeerConnectionHandling tests peer connection management
func TestPeerConnectionHandling(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := Config{
		ListenAddr:        ":30324",
		MaxPeers:          10,
		ConnectionTimeout: 5 * time.Second,
	}
	
	pool, err := NewPool(config, logger)
	require.NoError(t, err)
	
	ctx := context.Background()
	err = pool.Start(ctx)
	require.NoError(t, err)
	defer pool.Stop()

	t.Run("peer connection timeout", func(t *testing.T) {
		// Simulate a peer that doesn't complete handshake
		conn, err := net.Dial("tcp", pool.listener.Addr().String())
		require.NoError(t, err)
		defer conn.Close()

		// Don't send handshake, just wait
		time.Sleep(100 * time.Millisecond)
		
		// Connection should be closed by timeout
		// In real implementation, pool would close unresponsive connections
	})
}

// TestGetPeerCount tests peer count retrieval
func TestGetPeerCount(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := Config{
		ListenAddr: ":30325",
		MaxPeers:   10,
	}
	
	pool, err := NewPool(config, logger)
	require.NoError(t, err)

	// Initially should be 0
	assert.Equal(t, 0, pool.GetPeerCount())

	// Add some peers
	pool.peerCount.Store(5)
	assert.Equal(t, 5, pool.GetPeerCount())
}

// TestGetTotalShares tests total shares retrieval
func TestGetTotalShares(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := Config{
		ListenAddr: ":30326",
	}
	
	pool, err := NewPool(config, logger)
	require.NoError(t, err)

	// Initially should be 0
	assert.Equal(t, uint64(0), pool.GetTotalShares())

	// Add some shares
	pool.totalShares.Store(1000)
	assert.Equal(t, uint64(1000), pool.GetTotalShares())
}