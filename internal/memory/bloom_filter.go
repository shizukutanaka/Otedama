package memory

import (
	"hash/fnv"
	"sync"
)

// BloomFilter is a space-efficient probabilistic data structure
type BloomFilter struct {
	bits     []uint64
	size     uint
	hashFunc uint
	mutex    sync.RWMutex
}

// NewBloomFilter creates a new bloom filter
func NewBloomFilter(size uint, hashFunctions uint) *BloomFilter {
	// Round up to nearest multiple of 64 for uint64 storage
	bitSize := (size + 63) / 64
	
	return &BloomFilter{
		bits:     make([]uint64, bitSize),
		size:     size,
		hashFunc: hashFunctions,
	}
}

// Add adds an element to the bloom filter
func (bf *BloomFilter) Add(key string) {
	bf.mutex.Lock()
	defer bf.mutex.Unlock()
	
	h1, h2 := bf.hash(key)
	
	for i := uint(0); i < bf.hashFunc; i++ {
		pos := (h1 + i*h2) % bf.size
		wordIndex := pos / 64
		bitIndex := pos % 64
		bf.bits[wordIndex] |= 1 << bitIndex
	}
}

// MightContain checks if an element might be in the set
func (bf *BloomFilter) MightContain(key string) bool {
	bf.mutex.RLock()
	defer bf.mutex.RUnlock()
	
	h1, h2 := bf.hash(key)
	
	for i := uint(0); i < bf.hashFunc; i++ {
		pos := (h1 + i*h2) % bf.size
		wordIndex := pos / 64
		bitIndex := pos % 64
		
		if bf.bits[wordIndex]&(1<<bitIndex) == 0 {
			return false
		}
	}
	
	return true
}

// Clear resets the bloom filter
func (bf *BloomFilter) Clear() {
	bf.mutex.Lock()
	defer bf.mutex.Unlock()
	
	for i := range bf.bits {
		bf.bits[i] = 0
	}
}

// EstimateFalsePositiveRate estimates the false positive rate
func (bf *BloomFilter) EstimateFalsePositiveRate() float64 {
	bf.mutex.RLock()
	defer bf.mutex.RUnlock()
	
	setBits := 0
	for _, word := range bf.bits {
		setBits += popcount(word)
	}
	
	// Using the formula: (1 - e^(-kn/m))^k
	// Where k = hash functions, n = inserted elements, m = bit array size
	// This is an approximation based on set bits
	ratio := float64(setBits) / float64(bf.size)
	return ratio // Simplified - actual calculation would be more complex
}

// hash generates two hash values using FNV-1a
func (bf *BloomFilter) hash(key string) (uint, uint) {
	h := fnv.New64a()
	h.Write([]byte(key))
	sum := h.Sum64()
	
	h1 := uint(sum & 0xFFFFFFFF)
	h2 := uint(sum >> 32)
	
	return h1, h2
}

// popcount counts the number of set bits in a uint64
func popcount(x uint64) int {
	// Brian Kernighan's algorithm
	count := 0
	for x != 0 {
		x &= x - 1
		count++
	}
	return count
}

// MultiLevelBloomFilter provides multiple bloom filters for different time windows
type MultiLevelBloomFilter struct {
	filters  []*BloomFilter
	current  int
	size     uint
	hashFunc uint
	levels   int
	mutex    sync.RWMutex
}

// NewMultiLevelBloomFilter creates a multi-level bloom filter
func NewMultiLevelBloomFilter(size uint, hashFunctions uint, levels int) *MultiLevelBloomFilter {
	filters := make([]*BloomFilter, levels)
	for i := 0; i < levels; i++ {
		filters[i] = NewBloomFilter(size, hashFunctions)
	}
	
	return &MultiLevelBloomFilter{
		filters:  filters,
		current:  0,
		size:     size,
		hashFunc: hashFunctions,
		levels:   levels,
	}
}

// Add adds to current level
func (mlbf *MultiLevelBloomFilter) Add(key string) {
	mlbf.mutex.Lock()
	defer mlbf.mutex.Unlock()
	
	mlbf.filters[mlbf.current].Add(key)
}

// MightContain checks all levels
func (mlbf *MultiLevelBloomFilter) MightContain(key string) bool {
	mlbf.mutex.RLock()
	defer mlbf.mutex.RUnlock()
	
	for _, filter := range mlbf.filters {
		if filter.MightContain(key) {
			return true
		}
	}
	
	return false
}

// Rotate moves to next level and clears oldest
func (mlbf *MultiLevelBloomFilter) Rotate() {
	mlbf.mutex.Lock()
	defer mlbf.mutex.Unlock()
	
	mlbf.current = (mlbf.current + 1) % mlbf.levels
	mlbf.filters[mlbf.current].Clear()
}

// CountingBloomFilter supports deletion by using counters instead of bits
type CountingBloomFilter struct {
	counters []uint16
	size     uint
	hashFunc uint
	mutex    sync.RWMutex
}

// NewCountingBloomFilter creates a counting bloom filter
func NewCountingBloomFilter(size uint, hashFunctions uint) *CountingBloomFilter {
	return &CountingBloomFilter{
		counters: make([]uint16, size),
		size:     size,
		hashFunc: hashFunctions,
	}
}

// Add increments counters
func (cbf *CountingBloomFilter) Add(key string) {
	cbf.mutex.Lock()
	defer cbf.mutex.Unlock()
	
	h := fnv.New64a()
	h.Write([]byte(key))
	sum := h.Sum64()
	
	h1 := uint(sum & 0xFFFFFFFF)
	h2 := uint(sum >> 32)
	
	for i := uint(0); i < cbf.hashFunc; i++ {
		pos := (h1 + i*h2) % cbf.size
		if cbf.counters[pos] < 65535 { // Prevent overflow
			cbf.counters[pos]++
		}
	}
}

// Remove decrements counters
func (cbf *CountingBloomFilter) Remove(key string) {
	cbf.mutex.Lock()
	defer cbf.mutex.Unlock()
	
	h := fnv.New64a()
	h.Write([]byte(key))
	sum := h.Sum64()
	
	h1 := uint(sum & 0xFFFFFFFF)
	h2 := uint(sum >> 32)
	
	for i := uint(0); i < cbf.hashFunc; i++ {
		pos := (h1 + i*h2) % cbf.size
		if cbf.counters[pos] > 0 {
			cbf.counters[pos]--
		}
	}
}

// MightContain checks if all counters are non-zero
func (cbf *CountingBloomFilter) MightContain(key string) bool {
	cbf.mutex.RLock()
	defer cbf.mutex.RUnlock()
	
	h := fnv.New64a()
	h.Write([]byte(key))
	sum := h.Sum64()
	
	h1 := uint(sum & 0xFFFFFFFF)
	h2 := uint(sum >> 32)
	
	for i := uint(0); i < cbf.hashFunc; i++ {
		pos := (h1 + i*h2) % cbf.size
		if cbf.counters[pos] == 0 {
			return false
		}
	}
	
	return true
}

// ScalableBloomFilter automatically grows as needed
type ScalableBloomFilter struct {
	filters       []*BloomFilter
	size          uint
	hashFunc      uint
	growthFactor  float64
	targetFPR     float64
	itemsInserted uint64
	mutex         sync.RWMutex
}

// NewScalableBloomFilter creates a scalable bloom filter
func NewScalableBloomFilter(initialSize uint, hashFunctions uint, targetFPR float64) *ScalableBloomFilter {
	return &ScalableBloomFilter{
		filters:      []*BloomFilter{NewBloomFilter(initialSize, hashFunctions)},
		size:         initialSize,
		hashFunc:     hashFunctions,
		growthFactor: 2.0,
		targetFPR:    targetFPR,
	}
}

// Add adds to the filter, growing if necessary
func (sbf *ScalableBloomFilter) Add(key string) {
	sbf.mutex.Lock()
	defer sbf.mutex.Unlock()
	
	// Add to current filter
	currentFilter := sbf.filters[len(sbf.filters)-1]
	currentFilter.Add(key)
	sbf.itemsInserted++
	
	// Check if we need to grow
	if sbf.shouldGrow() {
		newSize := uint(float64(sbf.size) * sbf.growthFactor)
		newFilter := NewBloomFilter(newSize, sbf.hashFunc)
		sbf.filters = append(sbf.filters, newFilter)
		sbf.size = newSize
	}
}

// MightContain checks all filters
func (sbf *ScalableBloomFilter) MightContain(key string) bool {
	sbf.mutex.RLock()
	defer sbf.mutex.RUnlock()
	
	for _, filter := range sbf.filters {
		if filter.MightContain(key) {
			return true
		}
	}
	
	return false
}

func (sbf *ScalableBloomFilter) shouldGrow() bool {
	// Simplified growth logic
	// In practice, would calculate actual FPR
	itemsPerFilter := sbf.itemsInserted / uint64(len(sbf.filters))
	return itemsPerFilter > uint64(sbf.size)/10
}