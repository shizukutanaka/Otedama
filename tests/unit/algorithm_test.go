package unit

import (
	"testing"

	"github.com/shizukutanaka/Otedama/internal/mining"
	"github.com/stretchr/testify/assert"
)

// TestAlgorithmSelection tests mining algorithm selection
func TestAlgorithmSelection(t *testing.T) {
	tests := []struct {
		name      string
		algorithm mining.Algorithm
		valid     bool
	}{
		{"SHA256", mining.AlgorithmSHA256, true},
		{"Ethash", mining.AlgorithmEthash, true},
		{"RandomX", mining.AlgorithmRandomX, true},
		{"Invalid", mining.Algorithm("invalid"), false},
	}
	
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := mining.ValidateAlgorithm(tt.algorithm)
			if tt.valid {
				assert.NoError(t, err)
			} else {
				assert.Error(t, err)
			}
		})
	}
}

// TestShareValidation tests share validation logic
func TestShareValidation(t *testing.T) {
	validator := mining.NewShareValidator()
	
	tests := []struct {
		name     string
		share    *mining.Share
		expected bool
	}{
		{
			name: "ValidShare",
			share: &mining.Share{
				JobID:      "test-job",
				Nonce:      12345,
				Hash:       "00000000abcdef",
				Difficulty: 1.0,
			},
			expected: true,
		},
		{
			name: "InvalidDifficulty",
			share: &mining.Share{
				JobID:      "test-job",
				Nonce:      12345,
				Hash:       "ffffffff",
				Difficulty: 1.0,
			},
			expected: false,
		},
	}
	
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			valid := validator.ValidateShare(tt.share)
			assert.Equal(t, tt.expected, valid)
		})
	}
}

// BenchmarkHashing benchmarks different hashing algorithms
func BenchmarkHashing(b *testing.B) {
	data := []byte("test data for hashing")
	
	b.Run("SHA256", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			mining.HashSHA256(data)
		}
	})
	
	b.Run("SHA256D", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			mining.HashSHA256D(data)
		}
	})
}