package mining

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
)

// ValidateAlgorithm validates if an algorithm is supported
func ValidateAlgorithm(algo Algorithm) error {
	switch algo {
	case AlgorithmSHA256, AlgorithmSHA256D, AlgorithmEthash, AlgorithmRandomX, AlgorithmKawpow:
		return nil
	default:
		return errors.New("unsupported algorithm")
	}
}

// NewShareValidator creates a share validator
func NewShareValidator() *ShareValidator {
	return &ShareValidator{}
}

// ValidateShare validates a mining share
func (v *ShareValidator) ValidateShare(share *Share) bool {
	if share == nil || share.JobID == "" {
		return false
	}
	
	// Simple difficulty check (hash must start with zeros)
	requiredZeros := int(share.Difficulty)
	if requiredZeros < 1 {
		requiredZeros = 1
	}
	
	return strings.HasPrefix(share.Hash, strings.Repeat("0", requiredZeros))
}

// HashSHA256 computes SHA256 hash
func HashSHA256(data []byte) string {
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

// HashSHA256D computes double SHA256 hash
func HashSHA256D(data []byte) string {
	hash1 := sha256.Sum256(data)
	hash2 := sha256.Sum256(hash1[:])
	return hex.EncodeToString(hash2[:])
}

// NewEngine creates a test mining engine
func NewEngine(logger *zap.Logger, config *Config) (Engine, error) {
	return &UnifiedEngine{
		logger: logger,
		config: config,
	}, nil
}