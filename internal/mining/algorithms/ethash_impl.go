package algorithms

import (
	"encoding/binary"
	"math/big"
	"sync"

	"golang.org/x/crypto/sha3"
)

const (
	// Ethash constants
	ethashEpochLength    = 30000
	ethashCacheSize      = 16777216 // 16 MB
	ethashDatasetSize    = 1073741824 // 1 GB initial
	ethashMixBytes       = 128
	ethashHashBytes      = 64
	ethashHashWords      = 16
	ethashDatasetParents = 256
	ethashCacheRounds    = 3
	ethashAccesses       = 64
)

// EthashImpl implements Ethash algorithm
type EthashImpl struct {
	epoch     uint64
	cache     []uint32
	cacheLock sync.RWMutex
	
	// Light mode - generates dataset on demand
	lightMode bool
}

// NewEthashImpl creates a new Ethash implementation
func NewEthashImpl(lightMode bool) *EthashImpl {
	return &EthashImpl{
		lightMode: lightMode,
	}
}

// Hash implements the Ethash hash function
func (e *EthashImpl) Hash(data []byte, nonce uint64) ([]byte, error) {
	// Prepare header
	header := make([]byte, len(data)+8)
	copy(header, data)
	binary.LittleEndian.PutUint64(header[len(data):], nonce)
	
	// Get seed hash
	seedHash := e.getSeedHash(header)
	
	// Initialize if needed
	blockNumber := e.getBlockNumber(header)
	epoch := blockNumber / ethashEpochLength
	if err := e.ensureInitialized(epoch); err != nil {
		return nil, err
	}
	
	// Run ethash
	digest, result := e.hashimoto(seedHash, nonce)
	
	// Return Keccak256 of result
	return crypto.Keccak256(append(digest, result...)), nil
}

// Validate checks if a hash meets the target difficulty
func (e *EthashImpl) Validate(hash []byte, target *big.Int) bool {
	hashInt := new(big.Int).SetBytes(hash)
	return hashInt.Cmp(target) <= 0
}

// ensureInitialized ensures cache is initialized for epoch
func (e *EthashImpl) ensureInitialized(epoch uint64) error {
	e.cacheLock.Lock()
	defer e.cacheLock.Unlock()
	
	if e.epoch == epoch && e.cache != nil {
		return nil
	}
	
	// Generate cache
	cacheSize := e.getCacheSize(epoch)
	e.cache = make([]uint32, cacheSize/4)
	
	// Generate seed
	seed := make([]byte, 32)
	for i := uint64(0); i < epoch; i++ {
		seed = crypto.Keccak256(seed)
	}
	
	// Initialize cache
	e.generateCache(seed, cacheSize)
	e.epoch = epoch
	
	return nil
}

// generateCache generates the ethash cache
func (e *EthashImpl) generateCache(seed []byte, size uint64) {
	// Initial hash
	hash := crypto.Keccak512(seed)
	
	// Fill cache
	words := size / 64
	e.cache[0] = binary.LittleEndian.Uint32(hash[:4])
	
	for i := uint64(1); i < words*16; i++ {
		hash = crypto.Keccak512(hash)
		e.cache[i] = binary.LittleEndian.Uint32(hash[i%16*4 : i%16*4+4])
	}
	
	// Memory-hard loop
	for round := 0; round < ethashCacheRounds; round++ {
		for i := uint64(0); i < words; i++ {
			// Random access pattern
			v := e.cache[i]
			for j := 0; j < ethashDatasetParents; j++ {
				idx := fnv1a(uint32(i)^uint32(j), v) % uint32(words)
				v = fnvHash(v, e.cache[idx])
			}
			e.cache[i] = v
		}
	}
}

// hashimoto implements the main ethash mining function
func (e *EthashImpl) hashimoto(seedHash []byte, nonce uint64) ([]byte, []byte) {
	// Initialize mix
	mix := make([]uint32, ethashMixBytes/4)
	for i := 0; i < len(mix); i++ {
		mix[i] = binary.LittleEndian.Uint32(seedHash[i%8*4 : i%8*4+4])
	}
	
	// Mix with nonce
	nonceBytes := make([]byte, 8)
	binary.LittleEndian.PutUint64(nonceBytes, nonce)
	s := append(seedHash, nonceBytes...)
	s = crypto.Keccak512(s)
	
	for i := 0; i < len(mix); i++ {
		mix[i] ^= binary.LittleEndian.Uint32(s[i%16*4 : i%16*4+4])
	}
	
	// Memory access loop
	for i := 0; i < ethashAccesses; i++ {
		p := fnv1a(uint32(i)^mix[i%len(mix)], mix[i%len(mix)]) % uint32(len(e.cache))
		
		// In full mode, would access full dataset here
		// In light mode, calculate dataset item on-the-fly
		datasetItem := e.calcDatasetItem(p)
		
		for j := 0; j < len(mix); j++ {
			mix[j] = fnvHash(mix[j], datasetItem[j])
		}
	}
	
	// Compress mix
	compressed := make([]uint32, len(mix)/4)
	for i := 0; i < len(compressed); i++ {
		compressed[i] = fnvHash(fnvHash(fnvHash(mix[i*4], mix[i*4+1]), mix[i*4+2]), mix[i*4+3])
	}
	
	// Convert to bytes
	digest := make([]byte, 32)
	for i, v := range compressed[:8] {
		binary.LittleEndian.PutUint32(digest[i*4:], v)
	}
	
	result := crypto.Keccak256(append(s[:32], digest...))
	
	return digest, result
}

// calcDatasetItem calculates a dataset item from cache
func (e *EthashImpl) calcDatasetItem(index uint32) []uint32 {
	// In light mode, calculate dataset item from cache
	r := ethashHashWords
	mix := make([]uint32, r)
	
	// Initialize from cache
	offset := index % uint32(len(e.cache)/r)
	for i := 0; i < r; i++ {
		mix[i] = e.cache[offset*uint32(r)+uint32(i)]
	}
	mix[0] ^= index
	
	// FNV hash with parents
	for i := 0; i < ethashDatasetParents; i++ {
		parent := fnv1a(index^uint32(i), mix[i%r]) % uint32(len(e.cache)/r)
		for j := 0; j < r; j++ {
			mix[j] = fnvHash(mix[j], e.cache[parent*uint32(r)+uint32(j)])
		}
	}
	
	return mix
}

// Helper functions

func (e *EthashImpl) getSeedHash(header []byte) []byte {
	return crypto.Keccak256(header)
}

func (e *EthashImpl) getBlockNumber(header []byte) uint64 {
	// Extract block number from header
	// This is simplified - actual implementation would parse header properly
	if len(header) >= 8 {
		return binary.BigEndian.Uint64(header[:8])
	}
	return 0
}

func (e *EthashImpl) getCacheSize(epoch uint64) uint64 {
	size := ethashCacheSize + ethashCacheSize/1024*int(epoch)
	
	// Ensure size is prime
	for !isPrime(size) {
		size -= 2 * ethashMixBytes
	}
	
	return uint64(size)
}

func (e *EthashImpl) getDatasetSize(epoch uint64) uint64 {
	size := ethashDatasetSize + ethashDatasetSize/1024*int(epoch)
	
	// Ensure size is multiple of mix bytes
	size -= size % ethashMixBytes
	
	return uint64(size)
}

// FNV hash functions
func fnv1a(a, b uint32) uint32 {
	return a*0x01000193 ^ b
}

func fnvHash(a, b uint32) uint32 {
	return a*0x01000193 ^ b
}

// isPrime checks if a number is prime
func isPrime(n int) bool {
	if n <= 1 {
		return false
	}
	if n <= 3 {
		return true
	}
	if n%2 == 0 || n%3 == 0 {
		return false
	}
	
	i := 5
	for i*i <= n {
		if n%i == 0 || n%(i+2) == 0 {
			return false
		}
		i += 6
	}
	
	return true
}

// Crypto helpers (using sha3)
var crypto = cryptoHelper{}

type cryptoHelper struct{}

func (cryptoHelper) Keccak256(data []byte) []byte {
	hash := sha3.NewLegacyKeccak256()
	hash.Write(data)
	return hash.Sum(nil)
}

func (cryptoHelper) Keccak512(data []byte) []byte {
	hash := sha3.NewLegacyKeccak512()
	hash.Write(data)
	return hash.Sum(nil)
}

// RegisterEthash registers Ethash implementation
func RegisterEthash() {
	algo, _ := Get("ethash")
	if algo != nil {
		algo.HashFunction = func(data []byte, nonce uint64) ([]byte, error) {
			impl := NewEthashImpl(true) // Light mode
			return impl.Hash(data, nonce)
		}
		
		algo.ValidateFunc = func(hash []byte, difficulty uint64) bool {
			target := new(big.Int).Lsh(big.NewInt(1), 256)
			target.Div(target, new(big.Int).SetUint64(difficulty))
			
			hashInt := new(big.Int).SetBytes(hash)
			return hashInt.Cmp(target) <= 0
		}
	}
	
	// Also register Etchash
	algo, _ = Get("etchash")
	if algo != nil {
		algo.HashFunction = func(data []byte, nonce uint64) ([]byte, error) {
			// Etchash is similar to Ethash with modified parameters
			impl := NewEthashImpl(true)
			return impl.Hash(data, nonce)
		}
		
		algo.ValidateFunc = func(hash []byte, difficulty uint64) bool {
			target := new(big.Int).Lsh(big.NewInt(1), 256)
			target.Div(target, new(big.Int).SetUint64(difficulty))
			
			hashInt := new(big.Int).SetBytes(hash)
			return hashInt.Cmp(target) <= 0
		}
	}
}