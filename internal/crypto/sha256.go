package crypto

import (
	"crypto/sha256"
)

// SHA256Optimized provides SHA256 hashing for mining
type SHA256Optimized struct{}

// NewSHA256Optimized creates a new SHA256 hasher
func NewSHA256Optimized() *SHA256Optimized {
	return &SHA256Optimized{}
}

// Hash computes SHA256 hash of data
func (s *SHA256Optimized) Hash(data []byte) [32]byte {
	return sha256.Sum256(data)
}

// HashDouble computes double SHA256 hash (SHA256(SHA256(data)))
func (s *SHA256Optimized) HashDouble(data []byte) [32]byte {
	first := sha256.Sum256(data)
	return sha256.Sum256(first[:])
}

// SIMDHasher provides SIMD-accelerated hashing (fallback to standard implementation)
type SIMDHasher struct {
	algorithm string
}

// NewSIMDHasher creates a new SIMD hasher
func NewSIMDHasher(algorithm string) *SIMDHasher {
	return &SIMDHasher{
		algorithm: algorithm,
	}
}

// Hash computes hash using the specified algorithm
func (s *SIMDHasher) Hash(data []byte) [32]byte {
	switch s.algorithm {
	case "sha256d":
		// Double SHA256 for Bitcoin mining
		first := sha256.Sum256(data)
		return sha256.Sum256(first[:])
	default:
		return sha256.Sum256(data)
	}
}