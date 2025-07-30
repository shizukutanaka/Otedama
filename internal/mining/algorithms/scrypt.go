package algorithms

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"golang.org/x/crypto/scrypt"
)

// ScryptAlgorithm implements Scrypt mining (Litecoin)
type ScryptAlgorithm struct {
	*Algorithm
}

// ScryptParams contains Scrypt parameters
type ScryptParams struct {
	N      int // CPU/memory cost parameter
	R      int // Block size parameter
	P      int // Parallelization parameter
	KeyLen int // Length of derived key
}

// NewScrypt creates a new Scrypt algorithm instance
func NewScrypt() *ScryptAlgorithm {
	return &ScryptAlgorithm{
		Algorithm: &Algorithm{
			Name:         "scrypt",
			DisplayName:  "Scrypt",
			Type:         TypeMemoryHard,
			HashFunction: scryptHash,
			ValidateFunc: sha256Validate,
			DifficultyFunc: calculateDifficulty,
			Config: AlgorithmConfig{
				MemorySize:     128 * 1024, // 128 KB
				MemoryHardness: true,
				GPUOptimized:   true,
				ASICResistant:  false,
				CPUFriendly:    false,
				Params: map[string]interface{}{
					"N":      1024, // 2^10
					"r":      1,
					"p":      1,
					"keyLen": 32,
				},
			},
		},
	}
}

// scryptHash performs Scrypt hashing
func scryptHash(data []byte, nonce uint64) ([]byte, error) {
	// Default Scrypt parameters for Litecoin
	params := ScryptParams{
		N:      1024, // N = 2^10
		R:      1,    // r = 1
		P:      1,    // p = 1
		KeyLen: 32,   // 32 bytes output
	}
	
	// Append nonce to data
	nonceBytes := make([]byte, 8)
	binary.LittleEndian.PutUint64(nonceBytes, nonce)
	
	input := append(data, nonceBytes...)
	
	// Apply Scrypt
	hash, err := scrypt.Key(input, input, params.N, params.R, params.P, params.KeyLen)
	if err != nil {
		return nil, err
	}
	
	return hash, nil
}

// NeoScryptAlgorithm implements NeoScrypt mining
type NeoScryptAlgorithm struct {
	*Algorithm
}

// NewNeoScrypt creates a new NeoScrypt algorithm instance
func NewNeoScrypt() *NeoScryptAlgorithm {
	return &NeoScryptAlgorithm{
		Algorithm: &Algorithm{
			Name:         "neoscrypt",
			DisplayName:  "NeoScrypt",
			Type:         TypeMemoryHard,
			HashFunction: neoscryptHash,
			ValidateFunc: sha256Validate,
			DifficultyFunc: calculateDifficulty,
			Config: AlgorithmConfig{
				MemorySize:     256 * 1024, // 256 KB
				MemoryHardness: true,
				GPUOptimized:   true,
				ASICResistant:  true,
				CPUFriendly:    false,
			},
		},
	}
}

// neoscryptHash performs NeoScrypt hashing
func neoscryptHash(data []byte, nonce uint64) ([]byte, error) {
	// NeoScrypt parameters
	params := ScryptParams{
		N:      128,  // Lower N for faster computation
		R:      2,    // Higher R for more memory usage
		P:      1,    // Single thread
		KeyLen: 32,   // 32 bytes output
	}
	
	// Append nonce to data
	nonceBytes := make([]byte, 8)
	binary.LittleEndian.PutUint64(nonceBytes, nonce)
	
	input := append(data, nonceBytes...)
	
	// First scrypt round
	firstRound, err := scrypt.Key(input, input, params.N, params.R, params.P, 64)
	if err != nil {
		return nil, err
	}
	
	// Second scrypt round with different parameters
	secondRound, err := scrypt.Key(firstRound, firstRound, params.N, params.R, params.P, params.KeyLen)
	if err != nil {
		return nil, err
	}
	
	// Additional mixing with SHA-256
	finalHash := sha256.Sum256(secondRound)
	
	return finalHash[:], nil
}

// AdaptiveNFactorScrypt implements adaptive N-factor Scrypt
type AdaptiveNFactorScrypt struct {
	*Algorithm
	startTime uint64
}

// NewAdaptiveNFactorScrypt creates adaptive N-factor Scrypt
func NewAdaptiveNFactorScrypt(startTime uint64) *AdaptiveNFactorScrypt {
	return &AdaptiveNFactorScrypt{
		Algorithm: &Algorithm{
			Name:         "scrypt_adaptive",
			DisplayName:  "Adaptive N-Factor Scrypt",
			Type:         TypeMemoryHard,
			HashFunction: nil, // Will be set dynamically
			ValidateFunc: sha256Validate,
			DifficultyFunc: calculateDifficulty,
			Config: AlgorithmConfig{
				MemorySize:     128 * 1024, // Initial size
				MemoryHardness: true,
				GPUOptimized:   true,
				ASICResistant:  true,
				CPUFriendly:    false,
			},
		},
		startTime: startTime,
	}
}

// GetCurrentNFactor calculates current N-factor based on time
func (a *AdaptiveNFactorScrypt) GetCurrentNFactor(currentTime uint64) int {
	// N-factor increases every certain period (e.g., every 2 weeks)
	const incrementPeriod = 14 * 24 * 60 * 60 // 2 weeks in seconds
	const initialNFactor = 10                 // 2^10 = 1024
	
	if currentTime < a.startTime {
		return initialNFactor
	}
	
	periods := (currentTime - a.startTime) / incrementPeriod
	return initialNFactor + int(periods)
}

// Hash performs adaptive N-factor Scrypt hashing
func (a *AdaptiveNFactorScrypt) Hash(data []byte, nonce uint64, timestamp uint64) ([]byte, error) {
	nFactor := a.GetCurrentNFactor(timestamp)
	n := 1 << uint(nFactor)
	
	// Update memory size based on N-factor
	a.Config.MemorySize = uint64(n * 128) // 128 bytes per iteration
	
	// Append nonce to data
	nonceBytes := make([]byte, 8)
	binary.LittleEndian.PutUint64(nonceBytes, nonce)
	
	input := append(data, nonceBytes...)
	
	// Apply Scrypt with current N
	hash, err := scrypt.Key(input, input, n, 1, 1, 32)
	if err != nil {
		return nil, err
	}
	
	return hash, nil
}

// ScryptJane implements Scrypt-Jane (Yacoin variant)
type ScryptJaneAlgorithm struct {
	*Algorithm
}

// NewScryptJane creates a new Scrypt-Jane algorithm
func NewScryptJane() *ScryptJaneAlgorithm {
	return &ScryptJaneAlgorithm{
		Algorithm: &Algorithm{
			Name:         "scryptjane",
			DisplayName:  "Scrypt-Jane",
			Type:         TypeMemoryHard,
			HashFunction: scryptJaneHash,
			ValidateFunc: sha256Validate,
			DifficultyFunc: calculateDifficulty,
			Config: AlgorithmConfig{
				MemorySize:     256 * 1024, // Variable
				MemoryHardness: true,
				GPUOptimized:   false,
				ASICResistant:  true,
				CPUFriendly:    true,
			},
		},
	}
}

// scryptJaneHash performs Scrypt-Jane hashing
func scryptJaneHash(data []byte, nonce uint64) ([]byte, error) {
	// Scrypt-Jane uses different parameters and mixing
	// This is a simplified implementation
	
	// Base parameters
	n := 1024
	r := 1
	p := 1
	
	// Append nonce to data
	nonceBytes := make([]byte, 8)
	binary.LittleEndian.PutUint64(nonceBytes, nonce)
	
	input := append(data, nonceBytes...)
	
	// First Scrypt round
	intermediate, err := scrypt.Key(input, input, n, r, p, 80)
	if err != nil {
		return nil, err
	}
	
	// Jane mixing (simplified)
	mixed := make([]byte, 32)
	for i := 0; i < 32; i++ {
		mixed[i] = intermediate[i] ^ intermediate[i+32] ^ intermediate[i+48]
	}
	
	// Final hash
	finalHash := sha256.Sum256(mixed)
	
	return finalHash[:], nil
}

// ValidateScryptParams validates Scrypt parameters
func ValidateScryptParams(n, r, p int) error {
	if n <= 0 || (n&(n-1)) != 0 {
		return errors.New("N must be a power of 2 greater than 0")
	}
	
	if r <= 0 {
		return errors.New("r must be greater than 0")
	}
	
	if p <= 0 {
		return errors.New("p must be greater than 0")
	}
	
	// Check for potential integer overflow
	maxInt := int(^uint(0) >> 1)
	if n > maxInt/(128*r) {
		return errors.New("parameters too large")
	}
	
	if r > maxInt/(128*p) {
		return errors.New("parameters too large")
	}
	
	return nil
}

// EstimateScryptMemory estimates memory usage for Scrypt parameters
func EstimateScryptMemory(n, r, p int) uint64 {
	return uint64(128 * r * n * p)
}

// GetOptimalScryptParams returns optimal parameters for given memory limit
func GetOptimalScryptParams(memoryLimit uint64, targetTime float64) ScryptParams {
	// Start with safe defaults
	params := ScryptParams{
		N:      1024,
		R:      1,
		P:      1,
		KeyLen: 32,
	}
	
	// Adjust N based on memory limit
	maxN := int(memoryLimit / (128 * uint64(params.R) * uint64(params.P)))
	
	// Find largest power of 2 that fits
	n := 1
	for n*2 <= maxN {
		n *= 2
	}
	
	params.N = n
	
	return params
}