package unit

import (
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/zkp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap/zaptest"
)

func TestZKP_AgeProof(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := &zkp.ZKPConfig{
		MinAge:           18,
		RequiredHashRate: 1000000,
		CacheSize:        100,
		ProofExpiration:  1 * time.Hour,
	}

	zkpSystem, err := zkp.NewEnhancedZKPKYC(logger, config)
	require.NoError(t, err)

	tests := []struct {
		name    string
		age     int
		wantErr bool
	}{
		{
			name:    "Valid age above minimum",
			age:     25,
			wantErr: false,
		},
		{
			name:    "Valid age at minimum",
			age:     18,
			wantErr: false,
		},
		{
			name:    "Invalid age below minimum",
			age:     16,
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			request := &zkp.ProofRequest{
				UserID:    "test-user",
				ProofType: "age",
				Data: map[string]interface{}{
					"age": tt.age,
				},
				Nonce: "test-nonce",
			}

			response, err := zkpSystem.GenerateProof(request)
			if tt.wantErr {
				assert.Error(t, err)
				return
			}

			require.NoError(t, err)
			assert.NotNil(t, response)
			assert.Equal(t, "age", response.ProofType)
			assert.True(t, response.Valid)

			// Verify the proof
			valid, err := zkpSystem.VerifyProof(response)
			require.NoError(t, err)
			assert.True(t, valid)
		})
	}
}

func TestZKP_HashpowerProof(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := &zkp.ZKPConfig{
		MinAge:           18,
		RequiredHashRate: 1000000, // 1 MH/s
		CacheSize:        100,
		ProofExpiration:  1 * time.Hour,
	}

	zkpSystem, err := zkp.NewEnhancedZKPKYC(logger, config)
	require.NoError(t, err)

	tests := []struct {
		name     string
		hashrate uint64
		wantErr  bool
	}{
		{
			name:     "Valid hashrate above minimum",
			hashrate: 2000000, // 2 MH/s
			wantErr:  false,
		},
		{
			name:     "Valid hashrate at minimum",
			hashrate: 1000000, // 1 MH/s
			wantErr:  false,
		},
		{
			name:     "Invalid hashrate below minimum",
			hashrate: 500000, // 0.5 MH/s
			wantErr:  true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			request := &zkp.ProofRequest{
				UserID:    "test-user",
				ProofType: "hashpower",
				Data: map[string]interface{}{
					"hashrate": tt.hashrate,
				},
				Nonce: "test-nonce",
			}

			response, err := zkpSystem.GenerateProof(request)
			if tt.wantErr {
				assert.Error(t, err)
				return
			}

			require.NoError(t, err)
			assert.NotNil(t, response)
			assert.Equal(t, "hashpower", response.ProofType)
			assert.True(t, response.Valid)

			// Verify the proof
			valid, err := zkpSystem.VerifyProof(response)
			require.NoError(t, err)
			assert.True(t, valid)
		})
	}
}

func TestZKP_ProofCaching(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := &zkp.ZKPConfig{
		MinAge:           18,
		RequiredHashRate: 1000000,
		CacheSize:        10,
		ProofExpiration:  1 * time.Hour,
	}

	zkpSystem, err := zkp.NewEnhancedZKPKYC(logger, config)
	require.NoError(t, err)

	// Generate first proof
	request := &zkp.ProofRequest{
		UserID:    "cache-test-user",
		ProofType: "age",
		Data: map[string]interface{}{
			"age": 25,
		},
		Nonce: "cache-test-nonce",
	}

	// First call should generate new proof
	response1, err := zkpSystem.GenerateProof(request)
	require.NoError(t, err)
	assert.NotNil(t, response1)

	// Get initial stats
	stats1 := zkpSystem.GetStats()
	initialMisses := stats1.CacheMisses

	// Second call with same parameters should hit cache
	response2, err := zkpSystem.GenerateProof(request)
	require.NoError(t, err)
	assert.NotNil(t, response2)

	// Check cache hit
	stats2 := zkpSystem.GetStats()
	assert.Equal(t, stats1.CacheHits+1, stats2.CacheHits)
	assert.Equal(t, initialMisses, stats2.CacheMisses)
}

func TestZKP_UserVerification(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := zkp.DefaultZKPConfig()

	zkpSystem, err := zkp.NewEnhancedZKPKYC(logger, config)
	require.NoError(t, err)

	userID := "verification-test-user"

	// User should not be verified initially
	assert.False(t, zkpSystem.IsVerified(userID))

	// Generate and verify age proof
	ageRequest := &zkp.ProofRequest{
		UserID:    userID,
		ProofType: "age",
		Data: map[string]interface{}{
			"age": 25,
		},
		Nonce: "test-nonce",
	}

	ageResponse, err := zkpSystem.GenerateProof(ageRequest)
	require.NoError(t, err)

	valid, err := zkpSystem.VerifyProof(ageResponse)
	require.NoError(t, err)
	assert.True(t, valid)

	// User should now be verified
	assert.True(t, zkpSystem.IsVerified(userID))
}

func TestZKP_ProofExpiration(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := &zkp.ZKPConfig{
		MinAge:           18,
		RequiredHashRate: 1000000,
		CacheSize:        10,
		ProofExpiration:  100 * time.Millisecond, // Short expiration for testing
	}

	zkpSystem, err := zkp.NewEnhancedZKPKYC(logger, config)
	require.NoError(t, err)

	userID := "expiration-test-user"

	// Generate and verify proof
	request := &zkp.ProofRequest{
		UserID:    userID,
		ProofType: "age",
		Data: map[string]interface{}{
			"age": 25,
		},
		Nonce: "test-nonce",
	}

	response, err := zkpSystem.GenerateProof(request)
	require.NoError(t, err)

	valid, err := zkpSystem.VerifyProof(response)
	require.NoError(t, err)
	assert.True(t, valid)

	// User should be verified
	assert.True(t, zkpSystem.IsVerified(userID))

	// Wait for expiration
	time.Sleep(150 * time.Millisecond)

	// User should no longer be verified
	assert.False(t, zkpSystem.IsVerified(userID))
}

// Benchmark tests

func BenchmarkZKP_AgeProofGeneration(b *testing.B) {
	logger := zaptest.NewLogger(b)
	config := zkp.DefaultZKPConfig()

	zkpSystem, err := zkp.NewEnhancedZKPKYC(logger, config)
	require.NoError(b, err)

	request := &zkp.ProofRequest{
		UserID:    "bench-user",
		ProofType: "age",
		Data: map[string]interface{}{
			"age": 25,
		},
		Nonce: "bench-nonce",
	}

	b.ResetTimer()

	for i := 0; i < b.N; i++ {
		// Change nonce to avoid cache
		request.Nonce = fmt.Sprintf("bench-nonce-%d", i)
		_, err := zkpSystem.GenerateProof(request)
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkZKP_ProofVerification(b *testing.B) {
	logger := zaptest.NewLogger(b)
	config := zkp.DefaultZKPConfig()

	zkpSystem, err := zkp.NewEnhancedZKPKYC(logger, config)
	require.NoError(b, err)

	// Generate a proof to verify
	request := &zkp.ProofRequest{
		UserID:    "bench-user",
		ProofType: "age",
		Data: map[string]interface{}{
			"age": 25,
		},
		Nonce: "bench-nonce",
	}

	response, err := zkpSystem.GenerateProof(request)
	require.NoError(b, err)

	b.ResetTimer()

	for i := 0; i < b.N; i++ {
		valid, err := zkpSystem.VerifyProof(response)
		if err != nil {
			b.Fatal(err)
		}
		if !valid {
			b.Fatal("proof verification failed")
		}
	}
}