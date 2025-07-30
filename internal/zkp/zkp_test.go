package zkp

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest"
)

// TestNewManager tests ZKP manager creation
func TestNewManager(t *testing.T) {
	t.Parallel()
	
	tests := []struct {
		name   string
		config Config
		valid  bool
	}{
		{
			name: "basic config",
			config: Config{
				Enabled:     true,
				ProofExpiry: 24 * time.Hour,
			},
			valid: true,
		},
		{
			name: "with age verification",
			config: Config{
				Enabled:         true,
				ProofExpiry:     24 * time.Hour,
				RequireAgeProof: true,
				MinAge:          18,
			},
			valid: true,
		},
		{
			name: "with location verification",
			config: Config{
				Enabled:              true,
				RequireLocationProof: true,
				AllowedCountries:     []string{"US", "CA", "GB"},
				BlockedCountries:     []string{"CN", "RU"},
			},
			valid: true,
		},
		{
			name: "with all verifications",
			config: Config{
				Enabled:                true,
				ProofExpiry:            24 * time.Hour,
				RequireAgeProof:        true,
				RequireIdentityProof:   true,
				RequireLocationProof:   true,
				RequireHashpowerProof:  true,
				RequireSanctionsProof:  true,
				MinAge:                 18,
				MinHashpower:           1000.0,
			},
			valid: true,
		},
		{
			name:   "disabled zkp",
			config: Config{Enabled: false},
			valid:  true,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			
			logger := zaptest.NewLogger(t)
			manager := NewManager(logger, tt.config)
			
			assert.NotNil(t, manager)
			assert.Equal(t, tt.config, manager.config)
			assert.NotNil(t, manager.logger)
			assert.NotNil(t, manager.metrics)
		})
	}
}

// TestGenerateAgeProof tests age proof generation
func TestGenerateAgeProof(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := Config{
		Enabled:         true,
		ProofExpiry:     24 * time.Hour,
		RequireAgeProof: true,
		MinAge:          18,
	}
	
	manager := NewManager(logger, config)

	tests := []struct {
		name    string
		userID  string
		age     int
		wantErr bool
		errMsg  string
	}{
		{
			name:    "valid age",
			userID:  "user123",
			age:     25,
			wantErr: false,
		},
		{
			name:    "minimum age",
			userID:  "user456",
			age:     18,
			wantErr: false,
		},
		{
			name:    "underage",
			userID:  "user789",
			age:     16,
			wantErr: true,
			errMsg:  "age requirement",
		},
		{
			name:    "elderly user",
			userID:  "user999",
			age:     75,
			wantErr: false,
		},
		{
			name:    "empty user ID",
			userID:  "",
			age:     25,
			wantErr: true,
			errMsg:  "user ID",
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			
			proof, err := manager.GenerateAgeProof(tt.userID, tt.age)
			
			if tt.wantErr {
				assert.Error(t, err)
				assert.Nil(t, proof)
				if tt.errMsg != "" {
					assert.Contains(t, err.Error(), tt.errMsg)
				}
			} else {
				assert.NoError(t, err)
				assert.NotNil(t, proof)
				assert.Equal(t, ProofTypeAge, proof.Type)
				assert.NotEmpty(t, proof.ID)
				assert.NotEmpty(t, proof.ProofData)
				assert.False(t, proof.Timestamp.IsZero())
			}
		})
	}
}

// TestGenerateIdentityProof tests identity proof generation
func TestGenerateIdentityProof(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := Config{
		Enabled:              true,
		RequireIdentityProof: true,
		IdentityProtocol:     "bulletproofs",
	}
	
	manager := NewManager(logger, config)

	t.Run("valid identity", func(t *testing.T) {
		identityHash := hex.EncodeToString([]byte("test-identity"))
		proof, err := manager.GenerateIdentityProof("user123", identityHash)
		
		assert.NoError(t, err)
		assert.NotNil(t, proof)
		assert.Equal(t, ProofTypeIdentity, proof.Type)
		assert.NotEmpty(t, proof.ProofData)
	})

	t.Run("empty identity hash", func(t *testing.T) {
		proof, err := manager.GenerateIdentityProof("user123", "")
		
		assert.Error(t, err)
		assert.Nil(t, proof)
	})
}

// TestGenerateLocationProof tests location proof generation
func TestGenerateLocationProof(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := Config{
		Enabled:              true,
		RequireLocationProof: true,
		AllowedCountries:     []string{"US", "CA", "GB"},
		BlockedCountries:     []string{"CN", "RU"},
	}
	
	manager := NewManager(logger, config)

	tests := []struct {
		name    string
		userID  string
		country string
		wantErr bool
		errMsg  string
	}{
		{
			name:    "allowed country",
			userID:  "user123",
			country: "US",
			wantErr: false,
		},
		{
			name:    "another allowed country",
			userID:  "user456",
			country: "CA",
			wantErr: false,
		},
		{
			name:    "blocked country",
			userID:  "user789",
			country: "CN",
			wantErr: true,
			errMsg:  "blocked",
		},
		{
			name:    "unlisted country",
			userID:  "user999",
			country: "FR",
			wantErr: true,
			errMsg:  "not allowed",
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			
			proof, err := manager.GenerateLocationProof(tt.userID, tt.country)
			
			if tt.wantErr {
				assert.Error(t, err)
				assert.Nil(t, proof)
				if tt.errMsg != "" {
					assert.Contains(t, err.Error(), tt.errMsg)
				}
			} else {
				assert.NoError(t, err)
				assert.NotNil(t, proof)
				assert.Equal(t, ProofTypeLocation, proof.Type)
			}
		})
	}
}

// TestGenerateHashpowerProof tests hashpower proof generation
func TestGenerateHashpowerProof(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := Config{
		Enabled:               true,
		RequireHashpowerProof: true,
		MinHashpower:          1000.0, // 1 GH/s
	}
	
	manager := NewManager(logger, config)

	tests := []struct {
		name      string
		userID    string
		hashpower float64
		wantErr   bool
	}{
		{
			name:      "sufficient hashpower",
			userID:    "user123",
			hashpower: 2000.0,
			wantErr:   false,
		},
		{
			name:      "minimum hashpower",
			userID:    "user456",
			hashpower: 1000.0,
			wantErr:   false,
		},
		{
			name:      "insufficient hashpower",
			userID:    "user789",
			hashpower: 500.0,
			wantErr:   true,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			
			proof, err := manager.GenerateHashpowerProof(tt.userID, tt.hashpower)
			
			if tt.wantErr {
				assert.Error(t, err)
				assert.Nil(t, proof)
			} else {
				assert.NoError(t, err)
				assert.NotNil(t, proof)
				assert.Equal(t, ProofTypeHashpower, proof.Type)
			}
		})
	}
}

// TestVerifyProof tests proof verification
func TestVerifyProof(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := Config{
		Enabled:         true,
		ProofExpiry:     24 * time.Hour,
		RequireAgeProof: true,
		MinAge:          18,
	}
	
	manager := NewManager(logger, config)

	t.Run("verify valid proof", func(t *testing.T) {
		// Generate proof
		proof, err := manager.GenerateAgeProof("user123", 25)
		require.NoError(t, err)
		
		// Verify proof
		valid, err := manager.VerifyProof(proof.ID)
		assert.NoError(t, err)
		assert.True(t, valid)
	})

	t.Run("verify non-existent proof", func(t *testing.T) {
		valid, err := manager.VerifyProof("non-existent")
		assert.Error(t, err)
		assert.False(t, valid)
	})

	t.Run("verify expired proof", func(t *testing.T) {
		// Generate proof
		proof, err := manager.GenerateAgeProof("user456", 30)
		require.NoError(t, err)
		
		// Manually expire the proof
		if p, ok := manager.proofs.Load(proof.ID); ok {
			storedProof := p.(*Proof)
			storedProof.Timestamp = time.Now().Add(-48 * time.Hour)
		}
		
		// Verify should fail
		valid, err := manager.VerifyProof(proof.ID)
		assert.Error(t, err)
		assert.False(t, valid)
		assert.Contains(t, err.Error(), "expired")
	})
}

// TestGetUserProofs tests retrieving user proofs
func TestGetUserProofs(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := Config{
		Enabled:          true,
		MaxProofsPerUser: 5,
	}
	
	manager := NewManager(logger, config)
	userID := "test-user"

	// Generate multiple proofs
	for i := 0; i < 3; i++ {
		_, err := manager.GenerateAgeProof(userID, 25)
		require.NoError(t, err)
	}

	// Get user proofs
	proofs := manager.GetUserProofs(userID)
	assert.Len(t, proofs, 3)
	
	// All should be age proofs
	for _, proof := range proofs {
		assert.Equal(t, ProofTypeAge, proof.Type)
		assert.Equal(t, userID, proof.UserID)
	}
}

// TestConcurrentOperations tests thread safety
func TestConcurrentOperations(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := Config{
		Enabled:     true,
		ProofExpiry: 24 * time.Hour,
	}
	
	manager := NewManager(logger, config)
	
	var wg sync.WaitGroup
	numGoroutines := 50

	// Concurrent proof generation
	wg.Add(numGoroutines)
	for i := 0; i < numGoroutines; i++ {
		go func(id int) {
			defer wg.Done()
			
			userID := fmt.Sprintf("user%d", id)
			_, err := manager.GenerateAgeProof(userID, 25)
			assert.NoError(t, err)
		}(i)
	}

	// Concurrent proof verification
	wg.Add(numGoroutines)
	for i := 0; i < numGoroutines; i++ {
		go func(id int) {
			defer wg.Done()
			
			// Try to verify a proof (may not exist)
			proofID := fmt.Sprintf("proof%d", id)
			_, _ = manager.VerifyProof(proofID)
		}(i)
	}

	// Concurrent stats reading
	wg.Add(numGoroutines)
	for i := 0; i < numGoroutines; i++ {
		go func() {
			defer wg.Done()
			
			stats := manager.GetStats()
			assert.NotNil(t, stats)
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

// TestProofStorage tests proof storage and retrieval
func TestProofStorage(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := Config{
		Enabled:          true,
		MaxProofsPerUser: 3,
	}
	
	manager := NewManager(logger, config)
	userID := "storage-test-user"

	t.Run("store and retrieve proof", func(t *testing.T) {
		proof, err := manager.GenerateAgeProof(userID, 25)
		require.NoError(t, err)
		
		// Retrieve by ID
		stored, ok := manager.proofs.Load(proof.ID)
		assert.True(t, ok)
		assert.NotNil(t, stored)
		
		storedProof := stored.(*Proof)
		assert.Equal(t, proof.ID, storedProof.ID)
		assert.Equal(t, proof.Type, storedProof.Type)
	})

	t.Run("max proofs per user limit", func(t *testing.T) {
		// Generate more proofs than the limit
		for i := 0; i < 5; i++ {
			_, err := manager.GenerateAgeProof(userID, 25)
			require.NoError(t, err)
		}
		
		// Should only keep the configured maximum
		proofs := manager.GetUserProofs(userID)
		assert.LessOrEqual(t, len(proofs), config.MaxProofsPerUser)
	})
}

// TestMetrics tests metrics collection
func TestMetrics(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := Config{
		Enabled: true,
	}
	
	manager := NewManager(logger, config)

	// Generate some activity
	for i := 0; i < 10; i++ {
		userID := fmt.Sprintf("metric-user%d", i)
		proof, err := manager.GenerateAgeProof(userID, 25)
		require.NoError(t, err)
		
		// Verify half of them
		if i%2 == 0 {
			_, _ = manager.VerifyProof(proof.ID)
		}
	}

	// Check metrics
	stats := manager.GetStats()
	assert.NotNil(t, stats)
	assert.Equal(t, true, stats["enabled"])
	assert.Greater(t, stats["total_proofs"].(int), 0)
	assert.GreaterOrEqual(t, stats["active_proofs"].(int), 0)
}

// TestBlacklist tests blacklist functionality
func TestBlacklist(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := Config{
		Enabled: true,
	}
	
	manager := NewManager(logger, config)
	userID := "blacklist-user"

	t.Run("blacklist user", func(t *testing.T) {
		// Generate proof before blacklisting
		proof1, err := manager.GenerateAgeProof(userID, 25)
		assert.NoError(t, err)
		assert.NotNil(t, proof1)
		
		// Blacklist user
		manager.blacklist.Store(userID, time.Now())
		
		// Try to generate proof after blacklisting
		proof2, err := manager.GenerateAgeProof(userID, 25)
		assert.Error(t, err)
		assert.Nil(t, proof2)
		assert.Contains(t, err.Error(), "blacklisted")
	})
}

// TestEdgeCases tests edge cases
func TestEdgeCases(t *testing.T) {
	t.Parallel()
	
	tests := []struct {
		name string
		test func(t *testing.T)
	}{
		{
			name: "nil logger",
			test: func(t *testing.T) {
				config := Config{Enabled: true}
				manager := NewManager(nil, config)
				// Should handle nil logger gracefully
				assert.NotNil(t, manager)
			},
		},
		{
			name: "empty config",
			test: func(t *testing.T) {
				logger := zaptest.NewLogger(t)
				manager := NewManager(logger, Config{})
				assert.NotNil(t, manager)
			},
		},
		{
			name: "disabled manager operations",
			test: func(t *testing.T) {
				logger := zaptest.NewLogger(t)
				config := Config{Enabled: false}
				manager := NewManager(logger, config)
				
				// Operations should fail gracefully
				proof, err := manager.GenerateAgeProof("user", 25)
				assert.Error(t, err)
				assert.Nil(t, proof)
				assert.Contains(t, err.Error(), "disabled")
			},
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			tt.test(t)
		})
	}
}

// Benchmark tests
func BenchmarkGenerateAgeProof(b *testing.B) {
	logger := zap.NewNop()
	config := Config{
		Enabled:         true,
		ProofExpiry:     24 * time.Hour,
		RequireAgeProof: true,
		MinAge:          18,
	}
	
	manager := NewManager(logger, config)
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		userID := fmt.Sprintf("user%d", i)
		_, _ = manager.GenerateAgeProof(userID, 25)
	}
}

func BenchmarkVerifyProof(b *testing.B) {
	logger := zap.NewNop()
	config := Config{
		Enabled:     true,
		ProofExpiry: 24 * time.Hour,
	}
	
	manager := NewManager(logger, config)
	
	// Generate a proof to verify
	proof, err := manager.GenerateAgeProof("bench-user", 25)
	require.NoError(b, err)
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _ = manager.VerifyProof(proof.ID)
	}
}

func BenchmarkConcurrentProofGeneration(b *testing.B) {
	logger := zap.NewNop()
	config := Config{
		Enabled: true,
	}
	
	manager := NewManager(logger, config)
	
	b.RunParallel(func(pb *testing.PB) {
		counter := 0
		for pb.Next() {
			userID := fmt.Sprintf("user%d", counter)
			_, _ = manager.GenerateAgeProof(userID, 25)
			counter++
		}
	})
}

// TestProofExpiry tests proof expiration
func TestProofExpiry(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := Config{
		Enabled:     true,
		ProofExpiry: 100 * time.Millisecond, // Short expiry for testing
	}
	
	manager := NewManager(logger, config)

	// Generate proof
	proof, err := manager.GenerateAgeProof("expiry-user", 25)
	require.NoError(t, err)

	// Verify immediately - should work
	valid, err := manager.VerifyProof(proof.ID)
	assert.NoError(t, err)
	assert.True(t, valid)

	// Wait for expiry
	time.Sleep(150 * time.Millisecond)

	// Verify again - should fail
	valid, err = manager.VerifyProof(proof.ID)
	assert.Error(t, err)
	assert.False(t, valid)
	assert.Contains(t, err.Error(), "expired")
}

// Helper to generate test ECDSA key pair
func generateTestKeyPair(t *testing.T) (*ecdsa.PrivateKey, *ecdsa.PublicKey) {
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)
	return privateKey, &privateKey.PublicKey
}

// TestCompleteUserFlow tests complete user registration and verification flow
func TestCompleteUserFlow(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := Config{
		Enabled:              true,
		RequireAgeProof:      true,
		RequireLocationProof: true,
		MinAge:               18,
		AllowedCountries:     []string{"US", "CA"},
	}
	
	manager := NewManager(logger, config)
	userID := "complete-flow-user"

	// Step 1: Generate age proof
	ageProof, err := manager.GenerateAgeProof(userID, 25)
	require.NoError(t, err)

	// Step 2: Generate location proof
	locationProof, err := manager.GenerateLocationProof(userID, "US")
	require.NoError(t, err)

	// Step 3: Verify both proofs
	valid1, err := manager.VerifyProof(ageProof.ID)
	assert.NoError(t, err)
	assert.True(t, valid1)

	valid2, err := manager.VerifyProof(locationProof.ID)
	assert.NoError(t, err)
	assert.True(t, valid2)

	// Step 4: Check user has both proofs
	proofs := manager.GetUserProofs(userID)
	assert.Len(t, proofs, 2)
	
	hasAge := false
	hasLocation := false
	for _, p := range proofs {
		if p.Type == ProofTypeAge {
			hasAge = true
		}
		if p.Type == ProofTypeLocation {
			hasLocation = true
		}
	}
	assert.True(t, hasAge)
	assert.True(t, hasLocation)
}

// TestProofCounter tests atomic counter operations
func TestProofCounter(t *testing.T) {
	var counter atomic.Uint64
	
	// Test concurrent increments
	var wg sync.WaitGroup
	increments := 1000
	goroutines := 10
	
	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			for j := 0; j < increments; j++ {
				counter.Add(1)
			}
		}()
	}
	
	wg.Wait()
	
	expected := uint64(increments * goroutines)
	assert.Equal(t, expected, counter.Load())
}
