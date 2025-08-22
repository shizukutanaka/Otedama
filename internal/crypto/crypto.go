package crypto

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"

	"golang.org/x/crypto/sha3"
	"lukechampine.com/blake3"
)

// SHA256 computes SHA-256 hash
func SHA256(data []byte) []byte {
	hash := sha256.Sum256(data)
	return hash[:]
}

// DoubleSHA256 computes double SHA-256 (used in Bitcoin)
func DoubleSHA256(data []byte) []byte {
	first := sha256.Sum256(data)
	second := sha256.Sum256(first[:])
	return second[:]
}

// SHA3_256 computes SHA3-256 hash
func SHA3_256(data []byte) []byte {
	hash := sha3.Sum256(data)
	return hash[:]
}

// Keccak256 computes Keccak-256 hash (used in Ethereum)
func Keccak256(data []byte) []byte {
	hash := sha3.NewLegacyKeccak256()
	hash.Write(data)
	return hash.Sum(nil)
}

// Blake3 computes BLAKE3 hash
func Blake3(data []byte) []byte {
	hash := blake3.Sum256(data)
	return hash[:]
}

// HashToHex converts hash bytes to hex string
func HashToHex(hash []byte) string {
	return hex.EncodeToString(hash)
}

// HexToHash converts hex string to hash bytes
func HexToHash(hexStr string) ([]byte, error) {
	return hex.DecodeString(hexStr)
}

// VerifyDifficulty checks if hash meets difficulty target
func VerifyDifficulty(hash []byte, target []byte) bool {
	if len(hash) != len(target) {
		return false
	}
	
	for i := 0; i < len(hash); i++ {
		if hash[i] > target[i] {
			return false
		}
		if hash[i] < target[i] {
			return true
		}
	}
	
	return true
}

// DifficultyToTarget converts difficulty to target bytes
func DifficultyToTarget(difficulty float64) []byte {
	// Simplified implementation
	// Real implementation would depend on the specific cryptocurrency
	target := make([]byte, 32)
	for i := range target {
		target[i] = 0xFF
	}
	
	// Adjust based on difficulty
	leadingZeros := int(difficulty / 16)
	if leadingZeros > 32 {
		leadingZeros = 32
	}
	
	for i := 0; i < leadingZeros; i++ {
		target[i] = 0x00
	}
	
	return target
}

// NonceToBytes converts nonce to bytes
func NonceToBytes(nonce uint64) []byte {
	bytes := make([]byte, 8)
	for i := 0; i < 8; i++ {
		bytes[i] = byte(nonce >> (8 * i))
	}
	return bytes
}

// ComputeBlockHash computes hash for mining
func ComputeBlockHash(header []byte, nonce uint64) []byte {
	data := append(header, NonceToBytes(nonce)...)
	return DoubleSHA256(data)
}

// MerkleRoot computes Merkle root of transactions
func MerkleRoot(txHashes [][]byte) []byte {
	if len(txHashes) == 0 {
		return nil
	}
	
	if len(txHashes) == 1 {
		return txHashes[0]
	}
	
	// Build Merkle tree
	level := txHashes
	for len(level) > 1 {
		nextLevel := make([][]byte, 0)
		
		for i := 0; i < len(level); i += 2 {
			var hash []byte
			if i+1 < len(level) {
				combined := append(level[i], level[i+1]...)
				hash = DoubleSHA256(combined)
			} else {
				combined := append(level[i], level[i]...)
				hash = DoubleSHA256(combined)
			}
			nextLevel = append(nextLevel, hash)
		}
		
		level = nextLevel
	}
	
	return level[0]
}

// GenerateCoinbase generates coinbase transaction
func GenerateCoinbase(address string, value uint64, height uint64) ([]byte, error) {
	// Simplified coinbase generation
	// Real implementation would create proper transaction structure
	data := fmt.Sprintf("coinbase:%s:%d:%d", address, value, height)
	return []byte(data), nil
}