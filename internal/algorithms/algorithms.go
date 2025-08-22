// Package algorithms implements cryptocurrency mining algorithms for Otedama
package algorithms

import (
	"crypto/sha256"
	"encoding/binary"
	"hash"
	"math/big"
	"sync"
	"time"
	
	"golang.org/x/crypto/blake2b"
	"golang.org/x/crypto/scrypt"
	"golang.org/x/crypto/sha3"
)

// Algorithm represents a mining algorithm
type Algorithm struct {
	Name        string
	Description string
	HashFunc    func(data []byte, nonce uint64) []byte
	Difficulty  float64
}

// SupportedAlgorithms contains all supported mining algorithms
var SupportedAlgorithms = map[string]*Algorithm{
	"sha256d": {
		Name:        "SHA256d",
		Description: "Double SHA-256 (Bitcoin)",
		HashFunc:    SHA256d,
		Difficulty:  1.0,
	},
	"scrypt": {
		Name:        "Scrypt",
		Description: "Scrypt (Litecoin)",
		HashFunc:    Scrypt,
		Difficulty:  1.0,
	},
	"ethash": {
		Name:        "Ethash",
		Description: "Ethash (Ethereum)",
		HashFunc:    EthashLight,
		Difficulty:  1.0,
	},
	"randomx": {
		Name:        "RandomX",
		Description: "RandomX (Monero)",
		HashFunc:    RandomXLight,
		Difficulty:  1.0,
	},
	"cryptonight": {
		Name:        "CryptoNight",
		Description: "CryptoNight v2",
		HashFunc:    CryptoNightV2,
		Difficulty:  1.0,
	},
	"x11": {
		Name:        "X11",
		Description: "X11 (Dash)",
		HashFunc:    X11,
		Difficulty:  1.0,
	},
	"blake2b": {
		Name:        "Blake2b",
		Description: "Blake2b-256",
		HashFunc:    Blake2b256,
		Difficulty:  1.0,
	},
	"keccak": {
		Name:        "Keccak",
		Description: "Keccak-256",
		HashFunc:    Keccak256,
		Difficulty:  1.0,
	},
}

// Hash pools for reuse
var (
	sha256Pool = sync.Pool{
		New: func() interface{} {
			return sha256.New()
		},
	}
	blake2bPool = sync.Pool{
		New: func() interface{} {
			h, _ := blake2b.New256(nil)
			return h
		},
	}
	keccakPool = sync.Pool{
		New: func() interface{} {
			return sha3.NewLegacyKeccak256()
		},
	}
)

// SHA256d implements double SHA-256 hashing
func SHA256d(data []byte, nonce uint64) []byte {
	// Get hasher from pool
	h1 := sha256Pool.Get().(hash.Hash)
	h2 := sha256Pool.Get().(hash.Hash)
	defer sha256Pool.Put(h1)
	defer sha256Pool.Put(h2)
	
	h1.Reset()
	h2.Reset()
	
	// Prepare data with nonce
	fullData := make([]byte, len(data)+8)
	copy(fullData, data)
	binary.LittleEndian.PutUint64(fullData[len(data):], nonce)
	
	// First SHA-256
	h1.Write(fullData)
	firstHash := h1.Sum(nil)
	
	// Second SHA-256
	h2.Write(firstHash)
	return h2.Sum(nil)
}

// Scrypt implements the Scrypt algorithm
func Scrypt(data []byte, nonce uint64) []byte {
	// Prepare data with nonce
	fullData := make([]byte, len(data)+8)
	copy(fullData, data)
	binary.LittleEndian.PutUint64(fullData[len(data):], nonce)
	
	// Scrypt parameters (Litecoin settings)
	N := 1024
	r := 1
	p := 1
	keyLen := 32
	
	// Generate hash
	hash, err := scrypt.Key(fullData, fullData[:32], N, r, p, keyLen)
	if err != nil {
		return make([]byte, 32)
	}
	
	return hash
}

// EthashLight implements a simplified Ethash (for demonstration)
func EthashLight(data []byte, nonce uint64) []byte {
	// This is a simplified version
	// Real Ethash requires DAG generation and memory-hard computation
	h := keccakPool.Get().(hash.Hash)
	defer keccakPool.Put(h)
	
	h.Reset()
	
	// Prepare data with nonce
	fullData := make([]byte, len(data)+8)
	copy(fullData, data)
	binary.LittleEndian.PutUint64(fullData[len(data):], nonce)
	
	// Multiple rounds of hashing (simplified)
	currentHash := fullData
	for i := 0; i < 64; i++ {
		h.Reset()
		h.Write(currentHash)
		currentHash = h.Sum(nil)
	}
	
	return currentHash
}

// RandomXLight implements a simplified RandomX (for demonstration)
func RandomXLight(data []byte, nonce uint64) []byte {
	// This is a simplified version
	// Real RandomX requires VM execution and random program generation
	h := blake2bPool.Get().(hash.Hash)
	defer blake2bPool.Put(h)
	
	h.Reset()
	
	// Prepare data with nonce
	fullData := make([]byte, len(data)+8)
	copy(fullData, data)
	binary.LittleEndian.PutUint64(fullData[len(data):], nonce)
	
	// Multiple rounds with pseudo-random operations (simplified)
	currentData := fullData
	for i := 0; i < 8; i++ {
		h.Reset()
		h.Write(currentData)
		hash := h.Sum(nil)
		
		// Simulate some RandomX operations
		for j := 0; j < len(hash); j++ {
			hash[j] ^= byte(i * j)
		}
		
		currentData = hash
	}
	
	return currentData
}

// CryptoNightV2 implements a simplified CryptoNight v2
func CryptoNightV2(data []byte, nonce uint64) []byte {
	// This is a simplified version
	// Real CryptoNight requires memory-hard operations and AES
	h := keccakPool.Get().(hash.Hash)
	defer keccakPool.Put(h)
	
	h.Reset()
	
	// Prepare data with nonce
	fullData := make([]byte, len(data)+8)
	copy(fullData, data)
	binary.LittleEndian.PutUint64(fullData[len(data):], nonce)
	
	// Initial hash
	h.Write(fullData)
	state := h.Sum(nil)
	
	// Simulate memory-hard loop (simplified)
	scratchpad := make([]byte, 2097152) // 2MB
	copy(scratchpad, state)
	
	// Main loop (simplified)
	for i := 0; i < 524288; i++ {
		// Simulate memory access pattern
		idx := int(state[0]) * 16
		if idx < len(scratchpad)-32 {
			for j := 0; j < 32; j++ {
				scratchpad[idx+j] ^= state[j%len(state)]
			}
		}
		
		h.Reset()
		h.Write(scratchpad[idx : idx+32])
		state = h.Sum(nil)
	}
	
	return state
}

// X11 implements a simplified X11 algorithm
func X11(data []byte, nonce uint64) []byte {
	// X11 uses 11 different hash functions in sequence
	// This is a simplified version
	
	// Prepare data with nonce
	fullData := make([]byte, len(data)+8)
	copy(fullData, data)
	binary.LittleEndian.PutUint64(fullData[len(data):], nonce)
	
	currentHash := fullData
	
	// Chain of different hash functions (simplified to 3 for demonstration)
	// 1. Blake
	h1 := blake2bPool.Get().(hash.Hash)
	h1.Reset()
	h1.Write(currentHash)
	currentHash = h1.Sum(nil)
	blake2bPool.Put(h1)
	
	// 2. SHA256
	h2 := sha256Pool.Get().(hash.Hash)
	h2.Reset()
	h2.Write(currentHash)
	currentHash = h2.Sum(nil)
	sha256Pool.Put(h2)
	
	// 3. Keccak
	h3 := keccakPool.Get().(hash.Hash)
	h3.Reset()
	h3.Write(currentHash)
	currentHash = h3.Sum(nil)
	keccakPool.Put(h3)
	
	// Return 32 bytes
	if len(currentHash) > 32 {
		return currentHash[:32]
	}
	return currentHash
}

// Blake2b256 implements Blake2b-256 hashing
func Blake2b256(data []byte, nonce uint64) []byte {
	h := blake2bPool.Get().(hash.Hash)
	defer blake2bPool.Put(h)
	
	h.Reset()
	
	// Prepare data with nonce
	fullData := make([]byte, len(data)+8)
	copy(fullData, data)
	binary.LittleEndian.PutUint64(fullData[len(data):], nonce)
	
	h.Write(fullData)
	return h.Sum(nil)
}

// Keccak256 implements Keccak-256 hashing
func Keccak256(data []byte, nonce uint64) []byte {
	h := keccakPool.Get().(hash.Hash)
	defer keccakPool.Put(h)
	
	h.Reset()
	
	// Prepare data with nonce
	fullData := make([]byte, len(data)+8)
	copy(fullData, data)
	binary.LittleEndian.PutUint64(fullData[len(data):], nonce)
	
	h.Write(fullData)
	return h.Sum(nil)
}

// MeetsTarget checks if a hash meets the target difficulty
func MeetsTarget(hash []byte, target []byte) bool {
	if len(hash) != len(target) {
		return false
	}
	
	// Compare as big-endian numbers
	for i := 0; i < len(hash); i++ {
		if hash[i] < target[i] {
			return true
		}
		if hash[i] > target[i] {
			return false
		}
	}
	
	return false
}

// CalculateDifficulty calculates difficulty from target
func CalculateDifficulty(target []byte) float64 {
	// Maximum target (difficulty 1)
	maxTarget := new(big.Int)
	maxTarget.SetString("00000000FFFF0000000000000000000000000000000000000000000000000000", 16)
	
	// Current target
	currentTarget := new(big.Int).SetBytes(target)
	
	if currentTarget.Cmp(big.NewInt(0)) == 0 {
		return 0
	}
	
	// Difficulty = maxTarget / currentTarget
	difficulty := new(big.Float).SetInt(maxTarget)
	divisor := new(big.Float).SetInt(currentTarget)
	difficulty.Quo(difficulty, divisor)
	
	result, _ := difficulty.Float64()
	return result
}

// GetOptimalSettings returns optimal settings for an algorithm and device type
func GetOptimalSettings(algorithm string, deviceType string) map[string]interface{} {
	settings := make(map[string]interface{})
	
	switch algorithm {
	case "sha256d":
		switch deviceType {
		case "CPU":
			settings["threads"] = 0 // Auto
			settings["batch_size"] = 1000000
		case "GPU":
			settings["intensity"] = 24
			settings["work_size"] = 256
		case "ASIC":
			settings["frequency"] = 700
		}
		
	case "scrypt":
		switch deviceType {
		case "CPU":
			settings["threads"] = 0 // Auto
			settings["batch_size"] = 1000
		case "GPU":
			settings["intensity"] = 20
			settings["lookup_gap"] = 2
		case "ASIC":
			settings["frequency"] = 800
		}
		
	case "ethash":
		switch deviceType {
		case "CPU":
			settings["threads"] = 0
			settings["cache_size"] = 64
		case "GPU":
			settings["intensity"] = 22
			settings["dag_load_mode"] = "single"
		}
		
	case "randomx":
		switch deviceType {
		case "CPU":
			settings["threads"] = 0
			settings["huge_pages"] = true
			settings["jit"] = true
		case "GPU":
			// RandomX is CPU-optimized
			settings["intensity"] = 8
		}
		
	case "cryptonight":
		switch deviceType {
		case "CPU":
			settings["threads"] = 0
			settings["huge_pages"] = true
		case "GPU":
			settings["intensity"] = 18
			settings["worksize"] = 8
		}
		
	default:
		// Default settings
		switch deviceType {
		case "CPU":
			settings["threads"] = 0
			settings["batch_size"] = 10000
		case "GPU":
			settings["intensity"] = 20
			settings["work_size"] = 128
		case "ASIC":
			settings["frequency"] = 650
		}
	}
	
	return settings
}

// Benchmark runs a benchmark for an algorithm
func Benchmark(algorithm string, duration int) float64 {
	alg, exists := SupportedAlgorithms[algorithm]
	if !exists {
		return 0
	}
	
	// Test data
	data := make([]byte, 80)
	for i := range data {
		data[i] = byte(i)
	}
	
	// Run benchmark
	start := time.Now()
	hashes := uint64(0)
	nonce := uint64(0)
	
	for time.Since(start).Seconds() < float64(duration) {
		alg.HashFunc(data, nonce)
		nonce++
		hashes++
	}
	
	elapsed := time.Since(start).Seconds()
	return float64(hashes) / elapsed
}

// ValidateAlgorithm checks if an algorithm is supported
func ValidateAlgorithm(name string) bool {
	_, exists := SupportedAlgorithms[name]
	return exists
}

// GetAlgorithmList returns a list of supported algorithms
func GetAlgorithmList() []string {
	list := make([]string, 0, len(SupportedAlgorithms))
	for name := range SupportedAlgorithms {
		list = append(list, name)
	}
	return list
}
