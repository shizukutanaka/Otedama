package algorithms

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"hash"
	"sync"
)

// Algorithm represents a mining algorithm interface
type Algorithm interface {
	// Name returns the algorithm name
	Name() string
	
	// Hash computes the hash for given input
	Hash(input []byte, nonce uint64) []byte
	
	// Verify checks if a hash meets the target difficulty
	Verify(hash []byte, target []byte) bool
	
	// GetBlockReward returns the block reward for a given height
	GetBlockReward(height uint64) float64
	
	// GetDifficulty returns the current difficulty
	GetDifficulty() float64
	
	// Initialize prepares the algorithm (e.g., DAG generation)
	Initialize() error
}

// AlgorithmFactory creates algorithm instances
type AlgorithmFactory struct {
	algorithms map[string]func() Algorithm
	mu         sync.RWMutex
}

// NewAlgorithmFactory creates a new algorithm factory
func NewAlgorithmFactory() *AlgorithmFactory {
	factory := &AlgorithmFactory{
		algorithms: make(map[string]func() Algorithm),
	}
	
	// Register default algorithms
	factory.Register("sha256d", func() Algorithm { return NewSHA256D() })
	factory.Register("scrypt", func() Algorithm { return NewScrypt() })
	factory.Register("ethash", func() Algorithm { return NewEthash() })
	factory.Register("kawpow", func() Algorithm { return NewKawpow() })
	factory.Register("randomx", func() Algorithm { return NewRandomX() })
	factory.Register("x11", func() Algorithm { return NewX11() })
	factory.Register("equihash", func() Algorithm { return NewEquihash() })
	
	return factory
}

// Register adds a new algorithm
func (af *AlgorithmFactory) Register(name string, creator func() Algorithm) {
	af.mu.Lock()
	defer af.mu.Unlock()
	af.algorithms[name] = creator
}

// Create creates an algorithm instance
func (af *AlgorithmFactory) Create(name string) (Algorithm, error) {
	af.mu.RLock()
	creator, exists := af.algorithms[name]
	af.mu.RUnlock()
	
	if !exists {
		return nil, fmt.Errorf("unknown algorithm: %s", name)
	}
	
	return creator(), nil
}

// List returns available algorithms
func (af *AlgorithmFactory) List() []string {
	af.mu.RLock()
	defer af.mu.RUnlock()
	
	names := make([]string, 0, len(af.algorithms))
	for name := range af.algorithms {
		names = append(names, name)
	}
	return names
}

// SHA256D implementation (Bitcoin)
type SHA256D struct {
	difficulty float64
}

func NewSHA256D() Algorithm {
	return &SHA256D{
		difficulty: 1.0,
	}
}

func (s *SHA256D) Name() string {
	return "sha256d"
}

func (s *SHA256D) Hash(input []byte, nonce uint64) []byte {
	// Prepare data with nonce
	data := make([]byte, len(input)+8)
	copy(data, input)
	binary.LittleEndian.PutUint64(data[len(input):], nonce)
	
	// Double SHA256
	hash1 := sha256.Sum256(data)
	hash2 := sha256.Sum256(hash1[:])
	
	return hash2[:]
}

func (s *SHA256D) Verify(hash []byte, target []byte) bool {
	// Check if hash is less than target
	for i := 0; i < len(hash) && i < len(target); i++ {
		if hash[i] < target[i] {
			return true
		}
		if hash[i] > target[i] {
			return false
		}
	}
	return true
}

func (s *SHA256D) GetBlockReward(height uint64) float64 {
	// Bitcoin halving schedule
	halvings := height / 210000
	if halvings >= 64 {
		return 0
	}
	
	reward := 50.0
	for i := uint64(0); i < halvings; i++ {
		reward /= 2
	}
	return reward
}

func (s *SHA256D) GetDifficulty() float64 {
	return s.difficulty
}

func (s *SHA256D) Initialize() error {
	return nil
}

// Scrypt implementation (Litecoin, Dogecoin)
type Scrypt struct {
	n          int
	r          int
	p          int
	difficulty float64
}

func NewScrypt() Algorithm {
	return &Scrypt{
		n:          1024,
		r:          1,
		p:          1,
		difficulty: 1.0,
	}
}

func (sc *Scrypt) Name() string {
	return "scrypt"
}

func (sc *Scrypt) Hash(input []byte, nonce uint64) []byte {
	// Prepare data with nonce
	data := make([]byte, len(input)+8)
	copy(data, input)
	binary.LittleEndian.PutUint64(data[len(input):], nonce)
	
	// Simplified scrypt - in production, use proper scrypt library
	// This is a placeholder implementation
	hash := sha256.Sum256(data)
	
	// Simulate memory-hard function
	scratchpad := make([]byte, 128*sc.r*sc.n)
	for i := 0; i < len(scratchpad); i++ {
		scratchpad[i] = hash[i%32]
	}
	
	// Mix function (simplified)
	for i := 0; i < sc.n; i++ {
		offset := (int(hash[0]) + i) % len(scratchpad)
		if offset+32 <= len(scratchpad) {
			copy(hash[:], scratchpad[offset:offset+32])
		}
		hash = sha256.Sum256(hash[:])
	}
	
	return hash[:]
}

func (sc *Scrypt) Verify(hash []byte, target []byte) bool {
	return verifyHash(hash, target)
}

func (sc *Scrypt) GetBlockReward(height uint64) float64 {
	// Litecoin reward schedule
	halvings := height / 840000
	if halvings >= 64 {
		return 0
	}
	
	reward := 50.0
	for i := uint64(0); i < halvings; i++ {
		reward /= 2
	}
	return reward
}

func (sc *Scrypt) GetDifficulty() float64 {
	return sc.difficulty
}

func (sc *Scrypt) Initialize() error {
	return nil
}

// Ethash implementation (Ethereum Classic)
type Ethash struct {
	dagSize    uint64
	cacheSize  uint64
	epoch      uint64
	difficulty float64
	cache      []byte
	dag        []byte
	mu         sync.RWMutex
}

func NewEthash() Algorithm {
	return &Ethash{
		difficulty: 1.0,
	}
}

func (e *Ethash) Name() string {
	return "ethash"
}

func (e *Ethash) Hash(input []byte, nonce uint64) []byte {
	// Prepare data with nonce
	data := make([]byte, len(input)+8)
	copy(data, input)
	binary.LittleEndian.PutUint64(data[len(input):], nonce)
	
	// Simplified Ethash - in production, use proper implementation
	// This is a placeholder
	e.mu.RLock()
	defer e.mu.RUnlock()
	
	// Mix with DAG (simplified)
	hash := sha256.Sum256(data)
	
	if len(e.dag) > 0 {
		// Simulate DAG lookup
		for i := 0; i < 64; i++ {
			index := binary.LittleEndian.Uint32(hash[i*4:]) % uint32(len(e.dag)/64)
			if int(index+64) <= len(e.dag) {
				for j := 0; j < 32; j++ {
					hash[j] ^= e.dag[index+uint32(j)]
				}
			}
		}
	}
	
	return hash[:]
}

func (e *Ethash) Verify(hash []byte, target []byte) bool {
	return verifyHash(hash, target)
}

func (e *Ethash) GetBlockReward(height uint64) float64 {
	// Ethereum Classic reward schedule
	era := height / 5000000
	
	switch era {
	case 0:
		return 5.0
	case 1:
		return 4.0
	case 2:
		return 3.2
	case 3:
		return 2.56
	case 4:
		return 2.048
	default:
		// Continue reducing by 20% every era
		reward := 2.048
		for i := uint64(5); i <= era; i++ {
			reward *= 0.8
		}
		return reward
	}
}

func (e *Ethash) GetDifficulty() float64 {
	return e.difficulty
}

func (e *Ethash) Initialize() error {
	// Initialize DAG
	e.mu.Lock()
	defer e.mu.Unlock()
	
	// Calculate epoch
	e.epoch = 0 // Simplified
	
	// Create cache (simplified)
	e.cacheSize = 16 * 1024 * 1024 // 16MB
	e.cache = make([]byte, e.cacheSize)
	
	// Fill cache with pseudo-random data
	seed := sha256.Sum256([]byte("ethash"))
	for i := 0; i < len(e.cache); i += 32 {
		copy(e.cache[i:], seed[:])
		seed = sha256.Sum256(seed[:])
	}
	
	// Create DAG (simplified - real DAG is much larger)
	e.dagSize = 128 * 1024 * 1024 // 128MB (real is ~4GB)
	e.dag = make([]byte, e.dagSize)
	
	// Generate DAG from cache
	for i := uint64(0); i < e.dagSize/64; i++ {
		e.generateDAGItem(i)
	}
	
	return nil
}

func (e *Ethash) generateDAGItem(index uint64) {
	// Simplified DAG generation
	offset := index * 64
	if offset+64 <= e.dagSize {
		seed := sha256.Sum256(binary.LittleEndian.AppendUint64(nil, index))
		copy(e.dag[offset:], seed[:])
		copy(e.dag[offset+32:], seed[:])
	}
}

// KawPow implementation (Ravencoin)
type KawPow struct {
	difficulty float64
}

func NewKawPow() Algorithm {
	return &KawPow{
		difficulty: 1.0,
	}
}

func (k *KawPow) Name() string {
	return "kawpow"
}

func (k *KawPow) Hash(input []byte, nonce uint64) []byte {
	// KawPow is based on ProgPoW
	// This is a simplified implementation
	data := make([]byte, len(input)+8)
	copy(data, input)
	binary.LittleEndian.PutUint64(data[len(input):], nonce)
	
	// Multiple rounds of hashing
	hash := sha256.Sum256(data)
	
	// Simulate random program execution
	for i := 0; i < 8; i++ {
		// Mix with pseudo-random operations
		hash = sha256.Sum256(hash[:])
		
		// Rotate bytes
		temp := hash[0]
		for j := 0; j < 31; j++ {
			hash[j] = hash[j+1]
		}
		hash[31] = temp
	}
	
	return hash[:]
}

func (k *KawPow) Verify(hash []byte, target []byte) bool {
	return verifyHash(hash, target)
}

func (k *KawPow) GetBlockReward(height uint64) float64 {
	// Ravencoin reward schedule
	halvings := height / 2100000
	if halvings >= 64 {
		return 0
	}
	
	reward := 5000.0
	for i := uint64(0); i < halvings; i++ {
		reward /= 2
	}
	return reward
}

func (k *KawPow) GetDifficulty() float64 {
	return k.difficulty
}

func (k *KawPow) Initialize() error {
	return nil
}

// RandomX implementation (Monero)
type RandomX struct {
	cache      []byte
	dataset    []byte
	difficulty float64
	mu         sync.RWMutex
}

func NewRandomX() Algorithm {
	return &RandomX{
		difficulty: 1.0,
	}
}

func (r *RandomX) Name() string {
	return "randomx"
}

func (r *RandomX) Hash(input []byte, nonce uint64) []byte {
	// RandomX is a complex algorithm with VM execution
	// This is a simplified implementation
	data := make([]byte, len(input)+8)
	copy(data, input)
	binary.LittleEndian.PutUint64(data[len(input):], nonce)
	
	r.mu.RLock()
	defer r.mu.RUnlock()
	
	// Initialize VM state
	hash := sha256.Sum256(data)
	
	// Simulate VM execution with dataset
	if len(r.dataset) > 0 {
		for i := 0; i < 8; i++ {
			// Random memory access
			index := binary.LittleEndian.Uint32(hash[i*4:]) % uint32(len(r.dataset)/64)
			if int(index+64) <= len(r.dataset) {
				for j := 0; j < 32; j++ {
					hash[j] ^= r.dataset[index+uint32(j)]
				}
			}
			
			// Simulate math operations
			a := binary.LittleEndian.Uint64(hash[0:8])
			b := binary.LittleEndian.Uint64(hash[8:16])
			c := a * b
			binary.LittleEndian.PutUint64(hash[16:24], c)
			
			hash = sha256.Sum256(hash[:])
		}
	}
	
	return hash[:]
}

func (r *RandomX) Verify(hash []byte, target []byte) bool {
	return verifyHash(hash, target)
}

func (r *RandomX) GetBlockReward(height uint64) float64 {
	// Monero has a tail emission
	baseReward := 0.6
	
	// Smooth emission curve
	supply := float64(height) * baseReward
	maxSupply := 18132000.0
	
	if supply >= maxSupply {
		return baseReward // Tail emission
	}
	
	// Calculate reward based on emission curve
	reward := (maxSupply - supply) / 100000.0
	if reward < baseReward {
		reward = baseReward
	}
	
	return reward
}

func (r *RandomX) GetDifficulty() float64 {
	return r.difficulty
}

func (r *RandomX) Initialize() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	
	// Initialize cache
	r.cache = make([]byte, 256*1024*1024) // 256MB
	seed := sha256.Sum256([]byte("randomx"))
	for i := 0; i < len(r.cache); i += 32 {
		copy(r.cache[i:], seed[:])
		seed = sha256.Sum256(seed[:])
	}
	
	// Initialize dataset (simplified - real is 2GB+)
	r.dataset = make([]byte, 256*1024*1024) // 256MB
	for i := 0; i < len(r.dataset); i += 64 {
		copy(r.dataset[i:], r.cache[i%len(r.cache):])
	}
	
	return nil
}

// X11 implementation
type X11 struct {
	difficulty float64
	hashFuncs  []hash.Hash
}

func NewX11() Algorithm {
	return &X11{
		difficulty: 1.0,
	}
}

func (x *X11) Name() string {
	return "x11"
}

func (x *X11) Hash(input []byte, nonce uint64) []byte {
	// X11 uses 11 different hash functions in sequence
	// This is a simplified implementation
	data := make([]byte, len(input)+8)
	copy(data, input)
	binary.LittleEndian.PutUint64(data[len(input):], nonce)
	
	// Chain 11 hash functions (using SHA256 as placeholder)
	result := data
	for i := 0; i < 11; i++ {
		hash := sha256.Sum256(result)
		result = hash[:]
	}
	
	return result
}

func (x *X11) Verify(hash []byte, target []byte) bool {
	return verifyHash(hash, target)
}

func (x *X11) GetBlockReward(height uint64) float64 {
	// Generic X11 coin reward
	halvings := height / 210000
	if halvings >= 64 {
		return 0
	}
	
	reward := 50.0
	for i := uint64(0); i < halvings; i++ {
		reward /= 2
	}
	return reward
}

func (x *X11) GetDifficulty() float64 {
	return x.difficulty
}

func (x *X11) Initialize() error {
	return nil
}

// Equihash implementation (Zcash)
type Equihash struct {
	n          int
	k          int
	difficulty float64
}

func NewEquihash() Algorithm {
	return &Equihash{
		n:          200,
		k:          9,
		difficulty: 1.0,
	}
}

func (e *Equihash) Name() string {
	return "equihash"
}

func (e *Equihash) Hash(input []byte, nonce uint64) []byte {
	// Equihash is a memory-hard proof-of-work
	// This is a simplified implementation
	data := make([]byte, len(input)+8)
	copy(data, input)
	binary.LittleEndian.PutUint64(data[len(input):], nonce)
	
	// Generate initial hashes
	hashes := make([][]byte, 1<<uint(e.k))
	for i := range hashes {
		personalData := append(data, byte(i))
		hash := sha256.Sum256(personalData)
		hashes[i] = hash[:]
	}
	
	// Wagner's algorithm simulation (simplified)
	for round := 0; round < e.k; round++ {
		newHashes := make([][]byte, len(hashes)/2)
		for i := 0; i < len(newHashes); i++ {
			combined := append(hashes[i*2], hashes[i*2+1]...)
			hash := sha256.Sum256(combined)
			newHashes[i] = hash[:]
		}
		hashes = newHashes
	}
	
	return hashes[0]
}

func (e *Equihash) Verify(hash []byte, target []byte) bool {
	return verifyHash(hash, target)
}

func (e *Equihash) GetBlockReward(height uint64) float64 {
	// Zcash reward schedule
	halvings := height / 840000
	if halvings >= 64 {
		return 0
	}
	
	reward := 12.5
	for i := uint64(0); i < halvings; i++ {
		reward /= 2
	}
	return reward
}

func (e *Equihash) GetDifficulty() float64 {
	return e.difficulty
}

func (e *Equihash) Initialize() error {
	return nil
}

// Helper functions

func verifyHash(hash []byte, target []byte) bool {
	// Check if hash is less than target
	for i := 0; i < len(hash) && i < len(target); i++ {
		if hash[i] < target[i] {
			return true
		}
		if hash[i] > target[i] {
			return false
		}
	}
	return true
}

// AlgorithmInfo provides information about an algorithm
type AlgorithmInfo struct {
	Name            string  `json:"name"`
	DisplayName     string  `json:"display_name"`
	Type            string  `json:"type"` // ASIC, GPU, CPU
	MemoryRequired  int64   `json:"memory_required"`
	Description     string  `json:"description"`
	Coins           []string `json:"coins"`
	Hashrate        float64 `json:"hashrate"` // Expected hashrate
}

// GetAlgorithmInfo returns information about available algorithms
func GetAlgorithmInfo() []AlgorithmInfo {
	return []AlgorithmInfo{
		{
			Name:           "sha256d",
			DisplayName:    "SHA256D",
			Type:           "ASIC",
			MemoryRequired: 0,
			Description:    "Double SHA256 used by Bitcoin",
			Coins:          []string{"BTC", "BCH", "BSV"},
			Hashrate:       100e12, // 100 TH/s for modern ASIC
		},
		{
			Name:           "scrypt",
			DisplayName:    "Scrypt",
			Type:           "ASIC",
			MemoryRequired: 128 * 1024,
			Description:    "Memory-hard algorithm used by Litecoin",
			Coins:          []string{"LTC", "DOGE"},
			Hashrate:       1e9, // 1 GH/s for ASIC
		},
		{
			Name:           "ethash",
			DisplayName:    "Ethash",
			Type:           "GPU",
			MemoryRequired: 4 * 1024 * 1024 * 1024, // 4GB
			Description:    "Memory-hard algorithm for Ethereum Classic",
			Coins:          []string{"ETC"},
			Hashrate:       100e6, // 100 MH/s for GPU
		},
		{
			Name:           "kawpow",
			DisplayName:    "KawPow",
			Type:           "GPU",
			MemoryRequired: 4 * 1024 * 1024 * 1024,
			Description:    "ProgPoW variant used by Ravencoin",
			Coins:          []string{"RVN"},
			Hashrate:       30e6, // 30 MH/s for GPU
		},
		{
			Name:           "randomx",
			DisplayName:    "RandomX",
			Type:           "CPU",
			MemoryRequired: 2 * 1024 * 1024 * 1024, // 2GB
			Description:    "CPU-optimized algorithm used by Monero",
			Coins:          []string{"XMR"},
			Hashrate:       10e3, // 10 KH/s for CPU
		},
		{
			Name:           "x11",
			DisplayName:    "X11",
			Type:           "ASIC",
			MemoryRequired: 0,
			Description:    "Chain of 11 hash functions",
			Coins:          []string{"DASH"},
			Hashrate:       1e9, // 1 GH/s
		},
		{
			Name:           "equihash",
			DisplayName:    "Equihash",
			Type:           "ASIC",
			MemoryRequired: 512 * 1024 * 1024,
			Description:    "Memory-hard algorithm used by Zcash",
			Coins:          []string{"ZEC"},
			Hashrate:       1e6, // 1 MH/s
		},
	}
}
