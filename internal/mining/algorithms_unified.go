package mining

import (
    "crypto/sha256"
    "encoding/hex"
    "fmt"
)

// UnifiedAlgorithm represents all mining algorithms in one compact implementation
type UnifiedAlgorithm struct {
    name string
}

// NewAlgorithm creates a new mining algorithm instance
func NewAlgorithm(name string) *UnifiedAlgorithm {
    return &UnifiedAlgorithm{name: name}
}

// Hash performs the mining hash calculation
func (a *UnifiedAlgorithm) Hash(data []byte, nonce uint64) ([]byte, error) {
    // Combine data with nonce
    input := append(data, []byte(fmt.Sprintf("%d", nonce))...)
    
    switch a.name {
    case "SHA256d":
        // Double SHA256
        first := sha256.Sum256(input)
        second := sha256.Sum256(first[:])
        return second[:], nil
    default:
        // Default to SHA256d
        first := sha256.Sum256(input)
        second := sha256.Sum256(first[:])
        return second[:], nil
    }
}

// Verify checks if a hash meets the difficulty target
func (a *UnifiedAlgorithm) Verify(hash []byte, target []byte) bool {
    // Simple comparison - hash must be less than target
    for i := 0; i < len(hash) && i < len(target); i++ {
        if hash[i] < target[i] {
            return true
        }
        if hash[i] > target[i] {
            return false
        }
    }
    return false
}

// GetName returns the algorithm name
func (a *UnifiedAlgorithm) GetName() string {
    return a.name
}

// HexToBytes converts hex string to bytes
func HexToBytes(s string) ([]byte, error) {
    return hex.DecodeString(s)
}

// BytesToHex converts bytes to hex string
func BytesToHex(b []byte) string {
    return hex.EncodeToString(b)
}