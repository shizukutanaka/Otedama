package algorithms

import (
	"crypto/sha256"
	"encoding/binary"
	"runtime"
	"sync"
	"time"
	"unsafe"
)

// CPUOptimizedAlgorithm represents CPU-friendly mining algorithms
type CPUOptimizedAlgorithm struct {
	*Algorithm
	numThreads    int
	affinityMask  uint64
	optimizations CPUOptimizations
}

// CPUOptimizations contains CPU-specific optimizations
type CPUOptimizations struct {
	UseAVX2      bool
	UseAVX512    bool
	UseAESNI     bool
	UsePrefetch  bool
	CacheAlign   bool
	NUMA         bool
}

// NewCPUOptimized creates a CPU-optimized algorithm
func NewCPUOptimized(baseAlgorithm *Algorithm) *CPUOptimizedAlgorithm {
	return &CPUOptimizedAlgorithm{
		Algorithm:  baseAlgorithm,
		numThreads: runtime.NumCPU(),
		optimizations: CPUOptimizations{
			UseAVX2:     supportsBitset(cpuFeatureAVX2),
			UseAVX512:   supportsBitset(cpuFeatureAVX512),
			UseAESNI:    supportsBitset(cpuFeatureAESNI),
			UsePrefetch: true,
			CacheAlign:  true,
			NUMA:        runtime.NumCPU() > 8,
		},
	}
}

// CPU feature flags (simplified)
const (
	cpuFeatureAVX2   = 1 << 0
	cpuFeatureAVX512 = 1 << 1
	cpuFeatureAESNI  = 1 << 2
)

// supportsBitset checks if CPU supports specific features
func supportsBitset(feature uint64) bool {
	// Simplified CPU feature detection
	// In real implementation, this would use CPUID instruction
	return true // Assume modern CPU for demonstration
}

// CryptoNightAlgorithm implements CryptoNight (CPU-optimized)
type CryptoNightAlgorithm struct {
	*CPUOptimizedAlgorithm
	scratchpad    []byte
	scratchpadMu  sync.RWMutex
	variant       CryptoNightVariant
}

// CryptoNightVariant represents different CryptoNight variants
type CryptoNightVariant int

const (
	CryptoNightV0 CryptoNightVariant = iota
	CryptoNightV1
	CryptoNightV2
	CryptoNightR
	CryptoNightRTO // ReverseToOrigin
)

// NewCryptoNight creates a new CryptoNight algorithm
func NewCryptoNight(variant CryptoNightVariant) *CryptoNightAlgorithm {
	baseAlgo := &Algorithm{
		Name:         "cryptonight",
		DisplayName:  "CryptoNight",
		Type:         TypeCPUOptimized,
		HashFunction: nil, // Set after initialization
		ValidateFunc: sha256Validate,
		DifficultyFunc: calculateDifficulty,
		Config: AlgorithmConfig{
			MemorySize:     2 * 1024 * 1024, // 2 MB
			MemoryHardness: true,
			GPUOptimized:   false,
			ASICResistant:  variant >= CryptoNightV2,
			CPUFriendly:    true,
		},
	}
	
	return &CryptoNightAlgorithm{
		CPUOptimizedAlgorithm: NewCPUOptimized(baseAlgo),
		scratchpad:            make([]byte, 2*1024*1024), // 2 MB scratchpad
		variant:               variant,
	}
}

// Hash performs CryptoNight hashing
func (cn *CryptoNightAlgorithm) Hash(data []byte, nonce uint64) ([]byte, error) {
	cn.scratchpadMu.Lock()
	defer cn.scratchpadMu.Unlock()
	
	// Prepare input
	nonceBytes := make([]byte, 8)
	binary.LittleEndian.PutUint64(nonceBytes, nonce)
	input := append(data, nonceBytes...)
	
	// Initialize state
	state := sha256.Sum256(input)
	
	// Initialize scratchpad
	cn.initializeScratchpad(state[:])
	
	// Main loop (2^20 iterations)
	a := binary.LittleEndian.Uint64(state[:8])
	b := binary.LittleEndian.Uint64(state[8:16])
	
	for i := 0; i < 1048576; i++ { // 2^20
		// Memory access
		addr := a & 0x1FFFF0 // Align to 16 bytes
		
		if cn.optimizations.UsePrefetch {
			// Prefetch next cache line
			cn.prefetchMemory(unsafe.Pointer(&cn.scratchpad[addr+64]))
		}
		
		// Load from scratchpad
		c := binary.LittleEndian.Uint64(cn.scratchpad[addr:])
		d := binary.LittleEndian.Uint64(cn.scratchpad[addr+8:])
		
		// AES round (if AESNI available)
		if cn.optimizations.UseAESNI {
			a ^= cn.aesRound(a, c)
		} else {
			a ^= c
		}
		
		// Store to scratchpad
		binary.LittleEndian.PutUint64(cn.scratchpad[addr:], a)
		binary.LittleEndian.PutUint64(cn.scratchpad[addr+8:], b)
		
		// Update state
		a, b = b, a^d
		
		// Variant-specific modifications
		switch cn.variant {
		case CryptoNightV1:
			if addr&0x10 != 0 {
				a ^= ((a>>24)&0xFF)<<8 | ((a>>16)&0xFF)<<16 | ((a>>8)&0xFF)<<24 | (a&0xFF)<<32
			}
		case CryptoNightV2:
			// Additional shuffling
			if i%1024 == 0 {
				cn.shuffleScratchpad()
			}
		case CryptoNightR:
			// Random math operations
			if i%256 == 0 {
				a = cn.randomMath(a, b, uint64(i))
			}
		}
	}
	
	// Final hash
	finalState := make([]byte, 32)
	binary.LittleEndian.PutUint64(finalState[:8], a)
	binary.LittleEndian.PutUint64(finalState[8:16], b)
	copy(finalState[16:], state[16:])
	
	finalHashArray := sha256.Sum256(finalState)
	return finalHashArray[:], nil
}

// initializeScratchpad initializes the CryptoNight scratchpad
func (cn *CryptoNightAlgorithm) initializeScratchpad(state []byte) {
	// Use AES encryption to fill scratchpad
	current := state
	
	for i := 0; i < len(cn.scratchpad); i += 32 {
		if cn.optimizations.UseAESNI {
			// Use hardware AES if available
			result := cn.aesExpand(current)
			copy(cn.scratchpad[i:], result)
			current = result
		} else {
			// Software fallback
			hash := sha256.Sum256(current)
			copy(cn.scratchpad[i:], hash[:])
			current = hash[:]
		}
	}
}

// aesRound performs AES round (simplified)
func (cn *CryptoNightAlgorithm) aesRound(a, k uint64) uint64 {
	// Simplified AES round - real implementation would use hardware AES
	return ((a << 13) | (a >> 51)) ^ k
}

// aesExpand expands key using AES (simplified)
func (cn *CryptoNightAlgorithm) aesExpand(key []byte) []byte {
	// Simplified AES key expansion
	result := make([]byte, 32)
	
	for i := 0; i < 32; i++ {
		result[i] = key[i%len(key)] ^ byte(i)
	}
	
	return result
}

// shuffleScratchpad shuffles scratchpad for CryptoNight v2
func (cn *CryptoNightAlgorithm) shuffleScratchpad() {
	// Simple shuffle to prevent ASIC optimization
	for i := 0; i < 1024; i += 16 {
		offset1 := i * 2048
		offset2 := ((i + 512) % 1024) * 2048
		
		if offset1+16 < len(cn.scratchpad) && offset2+16 < len(cn.scratchpad) {
			// Swap 16-byte blocks
			for j := 0; j < 16; j++ {
				cn.scratchpad[offset1+j], cn.scratchpad[offset2+j] = 
					cn.scratchpad[offset2+j], cn.scratchpad[offset1+j]
			}
		}
	}
}

// randomMath performs random math operations for CryptoNight-R
func (cn *CryptoNightAlgorithm) randomMath(a, b, seed uint64) uint64 {
	// Generate pseudo-random math operations
	op := seed % 4
	
	switch op {
	case 0:
		return a + b
	case 1:
		return a - b
	case 2:
		return a ^ b
	case 3:
		return a * (b | 1) // Ensure b is odd for multiplication
	default:
		return a
	}
}

// prefetchMemory prefetches memory for better cache performance
func (cn *CryptoNightAlgorithm) prefetchMemory(addr unsafe.Pointer) {
	// CPU-specific prefetch instructions would go here
	// This is a placeholder for the concept
	_ = addr
}

// RandomXCPUAlgorithm implements CPU-optimized RandomX
type RandomXCPUAlgorithm struct {
	*CPUOptimizedAlgorithm
	vmPool    sync.Pool
	jitEnable bool
}

// NewRandomXCPU creates CPU-optimized RandomX
func NewRandomXCPU() *RandomXCPUAlgorithm {
	baseAlgo := &Algorithm{
		Name:         "randomx_cpu",
		DisplayName:  "RandomX (CPU Optimized)",
		Type:         TypeCPUOptimized,
		HashFunction: nil,
		ValidateFunc: sha256Validate,
		DifficultyFunc: calculateDifficulty,
		Config: AlgorithmConfig{
			MemorySize:     2 * 1024 * 1024 * 1024, // 2 GB
			MemoryHardness: true,
			GPUOptimized:   false,
			ASICResistant:  true,
			CPUFriendly:    true,
			ThreadsPerHash: 1,
		},
	}
	
	return &RandomXCPUAlgorithm{
		CPUOptimizedAlgorithm: NewCPUOptimized(baseAlgo),
		jitEnable:             true, // Enable JIT compilation for better performance
		vmPool: sync.Pool{
			New: func() interface{} {
				return &OptimizedRandomXVM{}
			},
		},
	}
}

// OptimizedRandomXVM represents optimized RandomX VM
type OptimizedRandomXVM struct {
	registers     [8]uint64
	memory        []byte
	program       []RandomXInstruction
	compiledCode  []byte // JIT compiled code
}

// Hash performs optimized RandomX hashing
func (rx *RandomXCPUAlgorithm) Hash(data []byte, nonce uint64) ([]byte, error) {
	vm := rx.vmPool.Get().(*OptimizedRandomXVM)
	defer rx.vmPool.Put(vm)
	
	// Initialize VM with optimizations
	if err := rx.initializeOptimizedVM(vm, data, nonce); err != nil {
		return nil, err
	}
	
	// Execute with JIT if enabled
	if rx.jitEnable && len(vm.compiledCode) > 0 {
		return rx.executeJITCode(vm), nil
	} else {
		return rx.executeInterpreted(vm), nil
	}
}

// initializeOptimizedVM initializes optimized RandomX VM
func (rx *RandomXCPUAlgorithm) initializeOptimizedVM(vm *OptimizedRandomXVM, data []byte, nonce uint64) error {
	nonceBytes := make([]byte, 8)
	binary.LittleEndian.PutUint64(nonceBytes, nonce)
	input := append(data, nonceBytes...)
	
	// Initialize with cache-aligned memory
	if rx.optimizations.CacheAlign && len(vm.memory) == 0 {
		vm.memory = make([]byte, 2*1024*1024+64) // Extra for alignment
		// Align to cache line (64 bytes)
		offset := 64 - (uintptr(unsafe.Pointer(&vm.memory[0])) % 64)
		vm.memory = vm.memory[offset : offset+2*1024*1024]
	}
	
	// Initialize registers
	inputHash := sha256.Sum256(input)
	for i := 0; i < 8; i++ {
		if i*8+8 <= len(inputHash) {
			vm.registers[i] = binary.LittleEndian.Uint64(inputHash[i*8:])
		}
	}
	
	// Generate optimized program
	vm.program = rx.generateOptimizedProgram(inputHash[:])
	
	// JIT compile if enabled
	if rx.jitEnable {
		vm.compiledCode = rx.jitCompile(vm.program)
	}
	
	return nil
}

// generateOptimizedProgram generates optimized RandomX program
func (rx *RandomXCPUAlgorithm) generateOptimizedProgram(seed []byte) []RandomXInstruction {
	program := make([]RandomXInstruction, 256)
	
	// Generate with CPU-specific optimizations
	for i := 0; i < 256; i++ {
		offset := i * 4
		if offset+4 > len(seed) {
			offset = (i % (len(seed) / 4)) * 4
		}
		
		instruction := RandomXInstruction{
			opcode: seed[offset] % 32,      // More opcodes for CPU optimization
			dst:    seed[offset+1] % 8,
			src:    seed[offset+2] % 8,
			imm32:  binary.LittleEndian.Uint32(seed[offset:offset+4]),
		}
		
		// Optimize instruction for CPU execution
		instruction = rx.optimizeInstruction(instruction)
		program[i] = instruction
	}
	
	return program
}

// optimizeInstruction optimizes instruction for CPU
func (rx *RandomXCPUAlgorithm) optimizeInstruction(instr RandomXInstruction) RandomXInstruction {
	// Prefer CPU-friendly operations
	switch instr.opcode % 8 {
	case 0, 1: // Arithmetic operations (CPU-friendly)
		return instr
	case 2, 3: // Bitwise operations (CPU-friendly)
		return instr
	case 4, 5: // Memory operations (optimize for cache)
		if rx.optimizations.UsePrefetch {
			// Add prefetch hint
			instr.imm32 |= 0x80000000 // Flag for prefetch
		}
		return instr
	default:
		// Convert to CPU-friendly operation
		instr.opcode = instr.opcode % 6 // Limit to CPU-friendly opcodes
		return instr
	}
}

// jitCompile performs JIT compilation of RandomX program
func (rx *RandomXCPUAlgorithm) jitCompile(program []RandomXInstruction) []byte {
	// Simplified JIT compilation - real implementation would generate
	// native machine code for better performance
	
	// For demonstration, we'll create a bytecode representation
	compiled := make([]byte, 0, len(program)*8)
	
	for _, instr := range program {
		// Encode instruction in optimized format
		instrBytes := make([]byte, 8)
		instrBytes[0] = instr.opcode
		instrBytes[1] = instr.dst
		instrBytes[2] = instr.src
		binary.LittleEndian.PutUint32(instrBytes[4:], instr.imm32)
		
		compiled = append(compiled, instrBytes...)
	}
	
	return compiled
}

// executeJITCode executes JIT compiled code
func (rx *RandomXCPUAlgorithm) executeJITCode(vm *OptimizedRandomXVM) []byte {
	// Execute compiled code with optimizations
	for i := 0; i < 1024; i++ { // 1024 iterations
		instrOffset := (i % (len(vm.compiledCode) / 8)) * 8
		
		// Decode instruction
		opcode := vm.compiledCode[instrOffset]
		dst := vm.compiledCode[instrOffset+1]
		src := vm.compiledCode[instrOffset+2]
		imm32 := binary.LittleEndian.Uint32(vm.compiledCode[instrOffset+4:])
		
		// Execute with CPU optimizations
		rx.executeOptimizedInstruction(vm, opcode, dst, src, imm32)
	}
	
	// Extract hash
	hash := make([]byte, 32)
	for i := 0; i < 4; i++ {
		binary.LittleEndian.PutUint64(hash[i*8:], vm.registers[i])
	}
	
	return hash
}

// executeInterpreted executes program in interpreted mode
func (rx *RandomXCPUAlgorithm) executeInterpreted(vm *OptimizedRandomXVM) []byte {
	// Standard interpretation with CPU optimizations
	for i := 0; i < 1024; i++ {
		instrIdx := i % len(vm.program)
		instr := vm.program[instrIdx]
		
		rx.executeOptimizedInstruction(vm, instr.opcode, instr.dst, instr.src, instr.imm32)
	}
	
	// Extract hash
	hash := make([]byte, 32)
	for i := 0; i < 4; i++ {
		binary.LittleEndian.PutUint64(hash[i*8:], vm.registers[i])
	}
	
	return hash
}

// executeOptimizedInstruction executes instruction with CPU optimizations
func (rx *RandomXCPUAlgorithm) executeOptimizedInstruction(vm *OptimizedRandomXVM, opcode, dst, src uint8, imm32 uint32) {
	switch opcode % 16 {
	case 0: // ADD
		vm.registers[dst] += vm.registers[src]
	case 1: // SUB
		vm.registers[dst] -= vm.registers[src]
	case 2: // MUL (optimized for CPU)
		if rx.optimizations.UseAVX2 {
			// Use vectorized multiplication if available
			vm.registers[dst] *= vm.registers[src]
		} else {
			vm.registers[dst] *= vm.registers[src]
		}
	case 3: // XOR
		vm.registers[dst] ^= vm.registers[src]
	case 4: // ROR with CPU-specific optimization
		shift := vm.registers[src] % 64
		vm.registers[dst] = (vm.registers[dst] >> shift) | (vm.registers[dst] << (64 - shift))
	case 5: // ROL with CPU-specific optimization
		shift := vm.registers[src] % 64
		vm.registers[dst] = (vm.registers[dst] << shift) | (vm.registers[dst] >> (64 - shift))
	case 6: // LOAD with prefetch
		addr := vm.registers[src] % uint64(len(vm.memory)-8)
		if rx.optimizations.UsePrefetch && imm32&0x80000000 != 0 {
			// Prefetch next cache line
			nextAddr := (addr + 64) % uint64(len(vm.memory)-8)
			rx.prefetchMemory(unsafe.Pointer(&vm.memory[nextAddr]))
		}
		vm.registers[dst] = binary.LittleEndian.Uint64(vm.memory[addr:])
	case 7: // STORE with cache optimization
		addr := vm.registers[src] % uint64(len(vm.memory)-8)
		binary.LittleEndian.PutUint64(vm.memory[addr:], vm.registers[dst])
	default:
		// CPU-friendly fallback operations
		vm.registers[dst] ^= uint64(imm32)
	}
}

// prefetchMemory performs memory prefetching for better cache performance
func (rx *RandomXCPUAlgorithm) prefetchMemory(ptr unsafe.Pointer) {
	// This is a stub implementation since Go doesn't have direct prefetch instructions
	// In a real implementation, this would use assembly or C code with prefetch instructions
	// For now, we just do a dummy read to trigger cache loading
	_ = *(*byte)(ptr)
}

// CPUAffinityManager manages CPU affinity for mining threads
type CPUAffinityManager struct {
	coreCount    int
	assignments  map[int]int // threadID -> coreID
	numaNodes    []NUMANode
	mu           sync.RWMutex
}

// NUMANode represents a NUMA node
type NUMANode struct {
	ID         int
	Cores      []int
	MemorySize uint64
}

// NewCPUAffinityManager creates CPU affinity manager
func NewCPUAffinityManager() *CPUAffinityManager {
	return &CPUAffinityManager{
		coreCount:   runtime.NumCPU(),
		assignments: make(map[int]int),
		numaNodes:   detectNUMANodes(),
	}
}

// detectNUMANodes detects NUMA topology
func detectNUMANodes() []NUMANode {
	// Simplified NUMA detection
	coreCount := runtime.NumCPU()
	
	if coreCount <= 8 {
		// Single NUMA node
		cores := make([]int, coreCount)
		for i := 0; i < coreCount; i++ {
			cores[i] = i
		}
		return []NUMANode{{ID: 0, Cores: cores, MemorySize: 8 * 1024 * 1024 * 1024}}
	} else {
		// Multiple NUMA nodes (simplified)
		nodesCount := (coreCount + 7) / 8 // 8 cores per node
		nodes := make([]NUMANode, nodesCount)
		
		for i := 0; i < nodesCount; i++ {
			startCore := i * 8
			endCore := min(startCore+8, coreCount)
			
			cores := make([]int, endCore-startCore)
			for j := startCore; j < endCore; j++ {
				cores[j-startCore] = j
			}
			
			nodes[i] = NUMANode{
				ID:         i,
				Cores:      cores,
				MemorySize: 16 * 1024 * 1024 * 1024, // 16 GB per node
			}
		}
		
		return nodes
	}
}

// AssignThread assigns thread to optimal CPU core
func (cam *CPUAffinityManager) AssignThread(threadID int) int {
	cam.mu.Lock()
	defer cam.mu.Unlock()
	
	// Round-robin assignment across NUMA nodes
	nodeID := threadID % len(cam.numaNodes)
	node := cam.numaNodes[nodeID]
	
	coreID := node.Cores[threadID%len(node.Cores)]
	cam.assignments[threadID] = coreID
	
	return coreID
}

// GetAssignment returns assigned core for thread
func (cam *CPUAffinityManager) GetAssignment(threadID int) (int, bool) {
	cam.mu.RLock()
	defer cam.mu.RUnlock()
	
	coreID, exists := cam.assignments[threadID]
	return coreID, exists
}

// CPUCacheOptimizer optimizes for CPU cache usage
type CPUCacheOptimizer struct {
	l1CacheSize  int
	l2CacheSize  int
	l3CacheSize  int
	cacheLineSize int
}

// NewCPUCacheOptimizer creates cache optimizer
func NewCPUCacheOptimizer() *CPUCacheOptimizer {
	return &CPUCacheOptimizer{
		l1CacheSize:   32 * 1024,  // 32 KB L1
		l2CacheSize:   256 * 1024, // 256 KB L2
		l3CacheSize:   8 * 1024 * 1024, // 8 MB L3
		cacheLineSize: 64, // 64 bytes
	}
}

// OptimizeDataLayout optimizes data layout for cache
func (cco *CPUCacheOptimizer) OptimizeDataLayout(data []byte) []byte {
	// Align data to cache line boundaries
	aligned := make([]byte, len(data)+cco.cacheLineSize-1)
	
	// Calculate alignment offset
	addr := uintptr(unsafe.Pointer(&aligned[0]))
	alignedAddr := (addr + uintptr(cco.cacheLineSize-1)) & ^uintptr(cco.cacheLineSize-1)
	offset := alignedAddr - addr
	
	// Copy data to aligned location
	copy(aligned[offset:], data)
	
	return aligned[offset : offset+uintptr(len(data))]
}

// PrefetchData prefetches data for better cache performance
func (cco *CPUCacheOptimizer) PrefetchData(addr unsafe.Pointer, size int) {
	// Prefetch in cache line sized chunks
	current := uintptr(addr)
	end := current + uintptr(size)
	
	for current < end {
		// CPU-specific prefetch instruction would go here
		current += uintptr(cco.cacheLineSize)
	}
}

// CalculateOptimalChunkSize calculates optimal processing chunk size
func (cco *CPUCacheOptimizer) CalculateOptimalChunkSize(algorithm *Algorithm) int {
	// Base chunk size on L2 cache size for optimal performance
	baseSize := cco.l2CacheSize / 2 // Use half of L2 cache
	
	if algorithm.Config.MemoryHardness {
		// For memory-hard algorithms, use smaller chunks
		return min(baseSize, int(algorithm.Config.MemorySize/1024))
	}
	
	return baseSize
}

// CPUPerformanceProfiler profiles CPU-specific performance
type CPUPerformanceProfiler struct {
	samples      []CPUPerfSample
	samplingRate time.Duration
	mu           sync.RWMutex
}

// CPUPerfSample represents a performance sample
type CPUPerfSample struct {
	Timestamp     time.Time
	HashRate      float64
	CPUUsage      float64
	CacheHitRate  float64
	BranchMisses  uint64
	Instructions  uint64
	Cycles        uint64
}

// NewCPUPerformanceProfiler creates performance profiler
func NewCPUPerformanceProfiler() *CPUPerformanceProfiler {
	return &CPUPerformanceProfiler{
		samples:      make([]CPUPerfSample, 0, 1000),
		samplingRate: 1 * time.Second,
	}
}

// StartProfiling starts performance profiling
func (cpp *CPUPerformanceProfiler) StartProfiling() {
	go func() {
		ticker := time.NewTicker(cpp.samplingRate)
		defer ticker.Stop()
		
		for range ticker.C {
			sample := cpp.collectSample()
			
			cpp.mu.Lock()
			cpp.samples = append(cpp.samples, sample)
			if len(cpp.samples) > 1000 {
				cpp.samples = cpp.samples[1:]
			}
			cpp.mu.Unlock()
		}
	}()
}

// collectSample collects performance sample
func (cpp *CPUPerformanceProfiler) collectSample() CPUPerfSample {
	// Collect CPU performance metrics
	// In real implementation, this would use performance counters
	
	return CPUPerfSample{
		Timestamp:     time.Now(),
		HashRate:      cpp.getCurrentHashRate(),
		CPUUsage:      cpp.getCPUUsage(),
		CacheHitRate:  0.95, // Placeholder
		BranchMisses:  1000, // Placeholder
		Instructions:  1000000, // Placeholder
		Cycles:        800000,   // Placeholder
	}
}

// getCurrentHashRate gets current hash rate
func (cpp *CPUPerformanceProfiler) getCurrentHashRate() float64 {
	// Placeholder implementation
	return 1000.0 // H/s
}

// getCPUUsage gets current CPU usage
func (cpp *CPUPerformanceProfiler) getCPUUsage() float64 {
	// Placeholder implementation
	return 75.0 // 75%
}

// GetPerformanceReport generates performance report
func (cpp *CPUPerformanceProfiler) GetPerformanceReport() CPUPerformanceReport {
	cpp.mu.RLock()
	defer cpp.mu.RUnlock()
	
	if len(cpp.samples) == 0 {
		return CPUPerformanceReport{}
	}
	
	// Calculate statistics
	var totalHashRate, totalCPUUsage, totalCacheHitRate float64
	var totalBranchMisses, totalInstructions, totalCycles uint64
	
	for _, sample := range cpp.samples {
		totalHashRate += sample.HashRate
		totalCPUUsage += sample.CPUUsage
		totalCacheHitRate += sample.CacheHitRate
		totalBranchMisses += sample.BranchMisses
		totalInstructions += sample.Instructions
		totalCycles += sample.Cycles
	}
	
	count := float64(len(cpp.samples))
	
	return CPUPerformanceReport{
		AvgHashRate:      totalHashRate / count,
		AvgCPUUsage:      totalCPUUsage / count,
		AvgCacheHitRate:  totalCacheHitRate / count,
		TotalBranchMisses: totalBranchMisses,
		TotalInstructions: totalInstructions,
		TotalCycles:       totalCycles,
		IPC:              float64(totalInstructions) / float64(totalCycles), // Instructions per cycle
		SampleCount:      len(cpp.samples),
	}
}

// CPUPerformanceReport contains performance analysis
type CPUPerformanceReport struct {
	AvgHashRate       float64
	AvgCPUUsage       float64
	AvgCacheHitRate   float64
	TotalBranchMisses uint64
	TotalInstructions uint64
	TotalCycles       uint64
	IPC               float64 // Instructions per cycle
	SampleCount       int
}

// RecommendCPUOptimizations recommends CPU optimizations
func RecommendCPUOptimizations(report CPUPerformanceReport) []string {
	recommendations := []string{}
	
	if report.AvgCacheHitRate < 0.9 {
		recommendations = append(recommendations, "Improve cache locality")
		recommendations = append(recommendations, "Reduce memory access patterns")
	}
	
	if report.IPC < 1.0 {
		recommendations = append(recommendations, "Optimize instruction selection")
		recommendations = append(recommendations, "Reduce pipeline stalls")
	}
	
	if report.AvgCPUUsage < 80 {
		recommendations = append(recommendations, "Increase parallelization")
		recommendations = append(recommendations, "Optimize thread utilization")
	}
	
	if report.TotalBranchMisses > report.TotalInstructions/20 { // >5% branch misses
		recommendations = append(recommendations, "Reduce conditional branches")
		recommendations = append(recommendations, "Improve branch prediction")
	}
	
	return recommendations
}

// min utility function
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}