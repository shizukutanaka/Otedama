package algorithms

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"sync"
	"time"
)

// GPUOptimizedAlgorithm represents GPU-friendly mining algorithms
type GPUOptimizedAlgorithm struct {
	*Algorithm
	deviceCount    int
	memoryPerGPU   uint64
	computeUnits   int
	optimizations  GPUOptimizations
}

// GPUOptimizations contains GPU-specific optimizations
type GPUOptimizations struct {
	UseVectorized    bool
	UseTensorCores   bool
	UseSharedMemory  bool
	UseConstantCache bool
	UseTexureCache   bool
	OptimizeMemCoal  bool
	MaxBlockSize     int
	MaxGridSize      int
}

// NewGPUOptimized creates a GPU-optimized algorithm
func NewGPUOptimized(baseAlgorithm *Algorithm) *GPUOptimizedAlgorithm {
	return &GPUOptimizedAlgorithm{
		Algorithm:    baseAlgorithm,
		deviceCount:  detectGPUCount(),
		memoryPerGPU: 8 * 1024 * 1024 * 1024, // 8 GB default
		computeUnits: 2048, // Default CUDA cores
		optimizations: GPUOptimizations{
			UseVectorized:    true,
			UseTensorCores:   false,
			UseSharedMemory:  true,
			UseConstantCache: true,
			UseTexureCache:   true,
			OptimizeMemCoal:  true,
			MaxBlockSize:     1024,
			MaxGridSize:      65535,
		},
	}
}

// detectGPUCount detects available GPU devices
func detectGPUCount() int {
	// Simplified GPU detection - real implementation would use CUDA/OpenCL
	return 1
}

// EthashGPUAlgorithm implements GPU-optimized Ethash
type EthashGPUAlgorithm struct {
	*GPUOptimizedAlgorithm
	dag          []byte
	dagMu        sync.RWMutex
	dagEpoch     uint64
	gpuMemoryMap map[int][]byte // GPU device memory mappings
}

// NewEthashGPU creates GPU-optimized Ethash
func NewEthashGPU() *EthashGPUAlgorithm {
	baseAlgo := &Algorithm{
		Name:         "ethash_gpu",
		DisplayName:  "Ethash (GPU Optimized)",
		Type:         TypeGPUOptimized,
		HashFunction: nil,
		ValidateFunc: sha256Validate,
		DifficultyFunc: calculateDifficulty,
		Config: AlgorithmConfig{
			MemorySize:     4 * 1024 * 1024 * 1024, // 4 GB DAG
			MemoryHardness: true,
			GPUOptimized:   true,
			ASICResistant:  false,
			CPUFriendly:    false,
			ThreadsPerHash: 256, // GPU threads per workgroup
		},
	}
	
	return &EthashGPUAlgorithm{
		GPUOptimizedAlgorithm: NewGPUOptimized(baseAlgo),
		dagEpoch:              ^uint64(0),
		gpuMemoryMap:          make(map[int][]byte),
	}
}

// InitializeGPUDAG initializes DAG on GPU memory
func (eg *EthashGPUAlgorithm) InitializeGPUDAG(epoch uint64) error {
	eg.dagMu.Lock()
	defer eg.dagMu.Unlock()
	
	if eg.dagEpoch == epoch && eg.dag != nil {
		return nil
	}
	
	// Calculate DAG size
	dagSize := eg.calculateDAGSize(epoch)
	eg.dag = make([]byte, dagSize)
	
	// Generate DAG with GPU-optimized pattern
	seed := make([]byte, 32)
	binary.LittleEndian.PutUint64(seed, epoch)
	
	// Generate in chunks optimized for GPU memory alignment
	chunkSize := 1024 * 1024 // 1 MB chunks
	current := seed
	
	for i := 0; i < len(eg.dag); i += chunkSize {
		end := i + chunkSize
		if end > len(eg.dag) {
			end = len(eg.dag)
		}
		
		// Generate chunk with vectorized operations
		eg.generateDAGChunk(eg.dag[i:end], current)
		
		// Update seed for next chunk
		hash := sha256.Sum256(current)
		current = hash[:]
	}
	
	// Copy to GPU memory for each device
	for deviceID := 0; deviceID < eg.deviceCount; deviceID++ {
		if err := eg.copyDAGToGPU(deviceID, eg.dag); err != nil {
			return fmt.Errorf("failed to copy DAG to GPU %d: %v", deviceID, err)
		}
	}
	
	eg.dagEpoch = epoch
	return nil
}

// generateDAGChunk generates DAG chunk with GPU-optimized pattern
func (eg *EthashGPUAlgorithm) generateDAGChunk(chunk []byte, seed []byte) {
	current := seed
	
	// Generate with 64-byte alignment for GPU coalesced access
	for i := 0; i < len(chunk); i += 64 {
		hash := sha256.Sum256(current)
		
		// Copy with alignment
		copyLen := 64
		if i+copyLen > len(chunk) {
			copyLen = len(chunk) - i
		}
		
		copy(chunk[i:i+copyLen], hash[:copyLen])
		current = hash[:]
	}
}

// copyDAGToGPU copies DAG to GPU memory
func (eg *EthashGPUAlgorithm) copyDAGToGPU(deviceID int, dag []byte) error {
	// Simplified GPU memory allocation
	// Real implementation would use CUDA/OpenCL memory allocation
	eg.gpuMemoryMap[deviceID] = make([]byte, len(dag))
	copy(eg.gpuMemoryMap[deviceID], dag)
	return nil
}

// calculateDAGSize calculates DAG size for epoch
func (eg *EthashGPUAlgorithm) calculateDAGSize(epoch uint64) uint64 {
	baseSize := uint64(1073741824) // 1 GB
	growth := epoch * 8388608      // 8 MB per epoch
	
	// Align to GPU memory boundaries (256 bytes)
	size := baseSize + growth
	return (size + 255) &^ 255
}

// Hash performs GPU-optimized Ethash hashing
func (eg *EthashGPUAlgorithm) Hash(data []byte, nonce uint64, blockNumber uint64) ([]byte, error) {
	epoch := blockNumber / 30000
	
	if err := eg.InitializeGPUDAG(epoch); err != nil {
		return nil, err
	}
	
	// Prepare input for GPU
	nonceBytes := make([]byte, 8)
	binary.LittleEndian.PutUint64(nonceBytes, nonce)
	input := append(data, nonceBytes...)
	
	// Execute on GPU with optimized kernel
	return eg.executeGPUKernel(input, 0), nil
}

// executeGPUKernel executes GPU kernel for hash computation
func (eg *EthashGPUAlgorithm) executeGPUKernel(input []byte, deviceID int) []byte {
	// Simplified GPU kernel simulation
	// Real implementation would use CUDA/OpenCL kernels
	
	hash := sha256.Sum256(input)
	dag := eg.gpuMemoryMap[deviceID]
	
	// Simulate GPU parallel processing
	for i := 0; i < 64; i++ {
		// Calculate DAG index with GPU-optimized pattern
		index := binary.LittleEndian.Uint64(hash[:8]) % (uint64(len(dag)) / 64)
		index = (index / 64) * 64 // Align to cache line
		
		// Vectorized memory access simulation
		for j := 0; j < 32; j++ {
			if j < len(hash) && index*64+uint64(j) < uint64(len(dag)) {
				hash[j] ^= dag[index*64+uint64(j)]
			}
		}
		
		// Re-hash with GPU optimizations
		hash = sha256.Sum256(hash[:])
	}
	
	return hash[:]
}

// KawPowGPUAlgorithm implements GPU-optimized KawPow
type KawPowGPUAlgorithm struct {
	*GPUOptimizedAlgorithm
	dag          []byte
	dagMu        sync.RWMutex
	dagEpoch     uint64
	programCache map[uint64][]KawPowInstruction
	cacheMu      sync.RWMutex
}

// KawPowInstruction represents KawPow GPU instruction
type KawPowInstruction struct {
	Opcode   uint8
	Dst      uint8
	Src1     uint8
	Src2     uint8
	Imm      uint32
}

// NewKawPowGPU creates GPU-optimized KawPow
func NewKawPowGPU() *KawPowGPUAlgorithm {
	baseAlgo := &Algorithm{
		Name:         "kawpow_gpu",
		DisplayName:  "KawPow (GPU Optimized)",
		Type:         TypeGPUOptimized,
		HashFunction: nil,
		ValidateFunc: sha256Validate,
		DifficultyFunc: calculateDifficulty,
		Config: AlgorithmConfig{
			MemorySize:     256 * 1024 * 1024, // 256 MB
			MemoryHardness: true,
			GPUOptimized:   true,
			ASICResistant:  true,
			CPUFriendly:    false,
			ThreadsPerHash: 1024, // GPU threads
		},
	}
	
	return &KawPowGPUAlgorithm{
		GPUOptimizedAlgorithm: NewGPUOptimized(baseAlgo),
		dagEpoch:              ^uint64(0),
		programCache:          make(map[uint64][]KawPowInstruction),
	}
}

// Hash performs GPU-optimized KawPow hashing
func (kg *KawPowGPUAlgorithm) Hash(data []byte, nonce uint64, blockHeight uint64) ([]byte, error) {
	epoch := blockHeight / 7500
	
	if err := kg.initializeDAG(epoch); err != nil {
		return nil, err
	}
	
	// Get or generate program
	progPeriod := blockHeight / 8
	program := kg.getOrGenerateProgram(progPeriod)
	
	// Execute on GPU
	nonceBytes := make([]byte, 8)
	binary.LittleEndian.PutUint64(nonceBytes, nonce)
	input := append(data, nonceBytes...)
	
	return kg.executeKawPowGPU(input, program), nil
}

// initializeDAG initializes KawPow DAG
func (kg *KawPowGPUAlgorithm) initializeDAG(epoch uint64) error {
	kg.dagMu.Lock()
	defer kg.dagMu.Unlock()
	
	if kg.dagEpoch == epoch && kg.dag != nil {
		return nil
	}
	
	dagSize := kg.Config.MemorySize
	kg.dag = make([]byte, dagSize)
	
	// Generate DAG optimized for GPU access patterns
	seed := make([]byte, 32)
	binary.LittleEndian.PutUint64(seed, epoch)
	
	current := seed
	for i := 0; i < len(kg.dag); i += 32 {
		hash := sha256.Sum256(current)
		copy(kg.dag[i:], hash[:])
		current = hash[:]
	}
	
	kg.dagEpoch = epoch
	return nil
}

// getOrGenerateProgram gets cached program or generates new one
func (kg *KawPowGPUAlgorithm) getOrGenerateProgram(period uint64) []KawPowInstruction {
	kg.cacheMu.RLock()
	if program, exists := kg.programCache[period]; exists {
		kg.cacheMu.RUnlock()
		return program
	}
	kg.cacheMu.RUnlock()
	
	kg.cacheMu.Lock()
	defer kg.cacheMu.Unlock()
	
	// Double-check after acquiring write lock
	if program, exists := kg.programCache[period]; exists {
		return program
	}
	
	// Generate new program
	program := kg.generateGPUProgram(period)
	kg.programCache[period] = program
	
	// Limit cache size
	if len(kg.programCache) > 100 {
		// Remove oldest entries
		for k := range kg.programCache {
			if k < period-50 {
				delete(kg.programCache, k)
			}
		}
	}
	
	return program
}

// generateGPUProgram generates GPU-optimized KawPow program
func (kg *KawPowGPUAlgorithm) generateGPUProgram(period uint64) []KawPowInstruction {
	program := make([]KawPowInstruction, 64) // GPU-optimized program size
	
	seed := make([]byte, 8)
	binary.LittleEndian.PutUint64(seed, period)
	hash := sha256.Sum256(seed)
	
	for i := 0; i < 64; i++ {
		offset := (i * 4) % 32
		instrData := binary.LittleEndian.Uint32(hash[offset:offset+4])
		
		program[i] = KawPowInstruction{
			Opcode: uint8(instrData % 16),        // 16 GPU-optimized opcodes
			Dst:    uint8((instrData >> 8) % 32), // 32 registers for GPU
			Src1:   uint8((instrData >> 12) % 32),
			Src2:   uint8((instrData >> 16) % 32),
			Imm:    instrData >> 20,
		}
		
		// Re-hash every 8 instructions
		if i%8 == 7 {
			hash = sha256.Sum256(hash[:])
		}
	}
	
	return program
}

// executeKawPowGPU executes KawPow program on GPU
func (kg *KawPowGPUAlgorithm) executeKawPowGPU(input []byte, program []KawPowInstruction) []byte {
	// Simulate GPU execution with parallel processing
	headerHash := sha256.Sum256(input)
	
	// Initialize GPU registers (32 registers for better parallelization)
	registers := make([]uint32, 32)
	for i := 0; i < 8; i++ {
		if i*4+4 <= len(headerHash) {
			registers[i] = binary.LittleEndian.Uint32(headerHash[i*4:])
		}
	}
	
	// Execute program with GPU optimizations
	for loop := 0; loop < 32; loop++ { // Reduced loops for GPU efficiency
		// Execute instructions in parallel batches
		for i := 0; i < len(program); i += 4 { // Process 4 instructions per batch
			batchEnd := i + 4
			if batchEnd > len(program) {
				batchEnd = len(program)
			}
			
			// Simulate SIMD execution
			for j := i; j < batchEnd; j++ {
				instr := program[j]
				kg.executeGPUInstruction(&registers, instr)
			}
		}
		
		// DAG access with coalesced memory access
		dagIndex := uint64(registers[0]) % (uint64(len(kg.dag)) / 64)
		dagData := kg.dag[dagIndex*64 : dagIndex*64+64]
		
		// Vectorized mixing
		for i := 0; i < 16; i++ {
			if i*4+4 <= len(dagData) {
				registers[i] ^= binary.LittleEndian.Uint32(dagData[i*4:])
			}
		}
	}
	
	// Extract final hash
	result := make([]byte, 32)
	for i := 0; i < 8; i++ {
		binary.LittleEndian.PutUint32(result[i*4:], registers[i])
	}
	
	return result
}

// executeGPUInstruction executes single GPU instruction
func (kg *KawPowGPUAlgorithm) executeGPUInstruction(registers *[]uint32, instr KawPowInstruction) {
	regs := *registers
	
	switch instr.Opcode % 16 {
	case 0: // ADD
		regs[instr.Dst] = regs[instr.Src1] + regs[instr.Src2]
	case 1: // SUB
		regs[instr.Dst] = regs[instr.Src1] - regs[instr.Src2]
	case 2: // MUL (GPU-optimized)
		regs[instr.Dst] = regs[instr.Src1] * regs[instr.Src2]
	case 3: // XOR
		regs[instr.Dst] = regs[instr.Src1] ^ regs[instr.Src2]
	case 4: // OR
		regs[instr.Dst] = regs[instr.Src1] | regs[instr.Src2]
	case 5: // AND
		regs[instr.Dst] = regs[instr.Src1] & regs[instr.Src2]
	case 6: // ROTL
		shift := regs[instr.Src2] % 32
		regs[instr.Dst] = (regs[instr.Src1] << shift) | (regs[instr.Src1] >> (32 - shift))
	case 7: // ROTR
		shift := regs[instr.Src2] % 32
		regs[instr.Dst] = (regs[instr.Src1] >> shift) | (regs[instr.Src1] << (32 - shift))
	case 8: // MADD (GPU multiply-add)
		regs[instr.Dst] = regs[instr.Src1]*regs[instr.Src2] + regs[instr.Dst]
	case 9: // MSUB (GPU multiply-subtract)
		regs[instr.Dst] = regs[instr.Src1]*regs[instr.Src2] - regs[instr.Dst]
	default:
		// Fallback operations
		regs[instr.Dst] ^= instr.Imm
	}
}

// GPUMemoryManager manages GPU memory allocation
type GPUMemoryManager struct {
	devices     []GPUDevice
	allocations map[int][]GPUAllocation
	mu          sync.RWMutex
}

// GPUDevice represents a GPU device
type GPUDevice struct {
	ID          int
	Name        string
	Memory      uint64
	ComputeUnits int
	Available   bool
}

// GPUAllocation represents a GPU memory allocation
type GPUAllocation struct {
	Size    uint64
	Offset  uint64
	InUse   bool
	Purpose string
}

// NewGPUMemoryManager creates GPU memory manager
func NewGPUMemoryManager() *GPUMemoryManager {
	return &GPUMemoryManager{
		devices:     detectGPUDevices(),
		allocations: make(map[int][]GPUAllocation),
	}
}

// detectGPUDevices detects available GPU devices
func detectGPUDevices() []GPUDevice {
	// Simplified GPU detection
	devices := []GPUDevice{
		{
			ID:           0,
			Name:         "NVIDIA GeForce RTX 4090",
			Memory:       24 * 1024 * 1024 * 1024, // 24 GB
			ComputeUnits: 16384,
			Available:    true,
		},
	}
	
	return devices
}

// AllocateMemory allocates GPU memory
func (gmm *GPUMemoryManager) AllocateMemory(deviceID int, size uint64, purpose string) (*GPUAllocation, error) {
	gmm.mu.Lock()
	defer gmm.mu.Unlock()
	
	if deviceID >= len(gmm.devices) {
		return nil, fmt.Errorf("device %d not found", deviceID)
	}
	
	device := gmm.devices[deviceID]
	if !device.Available {
		return nil, fmt.Errorf("device %d not available", deviceID)
	}
	
	// Find available space
	allocations := gmm.allocations[deviceID]
	offset := uint64(0)
	
	for _, alloc := range allocations {
		if !alloc.InUse && alloc.Size >= size {
			// Reuse existing allocation
			alloc.InUse = true
			alloc.Purpose = purpose
			return &alloc, nil
		}
		if alloc.InUse {
			offset = alloc.Offset + alloc.Size
		}
	}
	
	// Create new allocation
	if offset+size > device.Memory {
		return nil, fmt.Errorf("insufficient GPU memory")
	}
	
	allocation := GPUAllocation{
		Size:    size,
		Offset:  offset,
		InUse:   true,
		Purpose: purpose,
	}
	
	gmm.allocations[deviceID] = append(gmm.allocations[deviceID], allocation)
	
	return &allocation, nil
}

// FreeMemory frees GPU memory allocation
func (gmm *GPUMemoryManager) FreeMemory(deviceID int, allocation *GPUAllocation) {
	gmm.mu.Lock()
	defer gmm.mu.Unlock()
	
	allocation.InUse = false
	allocation.Purpose = ""
}

// GetMemoryUsage returns GPU memory usage
func (gmm *GPUMemoryManager) GetMemoryUsage(deviceID int) (uint64, uint64) {
	gmm.mu.RLock()
	defer gmm.mu.RUnlock()
	
	if deviceID >= len(gmm.devices) {
		return 0, 0
	}
	
	device := gmm.devices[deviceID]
	allocations := gmm.allocations[deviceID]
	
	var used uint64
	for _, alloc := range allocations {
		if alloc.InUse {
			used += alloc.Size
		}
	}
	
	return used, device.Memory
}

// GPUBenchmark benchmarks GPU performance
type GPUBenchmark struct {
	deviceID    int
	algorithm   *GPUOptimizedAlgorithm
	results     []BenchmarkResult
	mu          sync.RWMutex
}

// BenchmarkResult represents benchmark result
type BenchmarkResult struct {
	Timestamp   time.Time
	HashRate    float64
	Temperature float64
	PowerUsage  float64
	Memory      uint64
}

// NewGPUBenchmark creates GPU benchmark
func NewGPUBenchmark(deviceID int, algorithm *GPUOptimizedAlgorithm) *GPUBenchmark {
	return &GPUBenchmark{
		deviceID:  deviceID,
		algorithm: algorithm,
		results:   make([]BenchmarkResult, 0, 1000),
	}
}

// RunBenchmark runs GPU benchmark
func (gb *GPUBenchmark) RunBenchmark(duration time.Duration) BenchmarkResult {
	startTime := time.Now()
	var hashCount uint64
	
	// Simulate GPU mining for benchmark
	testData := make([]byte, 80) // Block header size
	
	for time.Since(startTime) < duration {
		// Simulate hash computation
		_ = sha256.Sum256(testData)
		hashCount++
		
		// Update test data to prevent optimization
		binary.LittleEndian.PutUint64(testData[:8], hashCount)
	}
	
	elapsed := time.Since(startTime).Seconds()
	hashRate := float64(hashCount) / elapsed
	
	result := BenchmarkResult{
		Timestamp:   time.Now(),
		HashRate:    hashRate,
		Temperature: gb.getGPUTemperature(),
		PowerUsage:  gb.getGPUPowerUsage(),
		Memory:      gb.getGPUMemoryUsage(),
	}
	
	gb.mu.Lock()
	gb.results = append(gb.results, result)
	if len(gb.results) > 1000 {
		gb.results = gb.results[1:]
	}
	gb.mu.Unlock()
	
	return result
}

// getGPUTemperature gets GPU temperature
func (gb *GPUBenchmark) getGPUTemperature() float64 {
	// Placeholder - real implementation would query GPU
	return 75.0 // 75°C
}

// getGPUPowerUsage gets GPU power usage
func (gb *GPUBenchmark) getGPUPowerUsage() float64 {
	// Placeholder - real implementation would query GPU
	return 350.0 // 350W
}

// getGPUMemoryUsage gets GPU memory usage
func (gb *GPUBenchmark) getGPUMemoryUsage() uint64 {
	// Placeholder - real implementation would query GPU
	return 8 * 1024 * 1024 * 1024 // 8 GB
}

// GetAverageHashRate returns average hash rate
func (gb *GPUBenchmark) GetAverageHashRate() float64 {
	gb.mu.RLock()
	defer gb.mu.RUnlock()
	
	if len(gb.results) == 0 {
		return 0
	}
	
	var total float64
	for _, result := range gb.results {
		total += result.HashRate
	}
	
	return total / float64(len(gb.results))
}

// GPUOptimizationHints provides GPU optimization recommendations
func GPUOptimizationHints(algorithm *Algorithm) []string {
	hints := []string{}
	
	if algorithm.Config.MemoryHardness {
		hints = append(hints, "Use high-bandwidth memory (HBM) GPUs")
		hints = append(hints, "Optimize memory coalescing patterns")
		hints = append(hints, "Minimize memory bank conflicts")
	}
	
	if algorithm.Config.ThreadsPerHash > 1 {
		hints = append(hints, "Optimize thread block size for occupancy")
		hints = append(hints, "Use shared memory for inter-thread communication")
	}
	
	if algorithm.Config.HashesPerNonce > 10 {
		hints = append(hints, "Pipeline multiple hash operations")
		hints = append(hints, "Use vectorized instructions (SIMD)")
	}
	
	hints = append(hints, "Profile with GPU profiler tools")
	hints = append(hints, "Monitor thermal throttling")
	hints = append(hints, "Optimize kernel launch parameters")
	
	return hints
}

// EstimateGPUHashRate estimates hash rate for GPU
func EstimateGPUHashRate(algorithm *Algorithm, device GPUDevice) float64 {
	// Base estimation factors
	memoryBandwidth := float64(device.Memory) / (1024 * 1024 * 1024) * 100 // GB/s estimate
	computePower := float64(device.ComputeUnits)
	
	// Algorithm-specific factors
	memoryFactor := 1.0
	if algorithm.Config.MemoryHardness {
		memoryFactor = memoryBandwidth / 500.0 // 500 GB/s reference
	}
	
	computeFactor := computePower / 2048.0 // 2048 cores reference
	
	// Base hash rate (H/s)
	baseRate := 50000000.0 // 50 MH/s
	
	return baseRate * memoryFactor * computeFactor
}

// Utility functions

// alignToGPUMemory aligns size to GPU memory boundaries
func alignToGPUMemory(size uint64, alignment uint64) uint64 {
	return (size + alignment - 1) &^ (alignment - 1)
}

// isGPUMemoryAligned checks if address is aligned for GPU access
func isGPUMemoryAligned(addr uintptr, alignment uintptr) bool {
	return addr%alignment == 0
}

// optimizeForGPU optimizes data layout for GPU access
func optimizeForGPU(data []byte) []byte {
	// Align to 256-byte boundaries for optimal GPU memory access
	alignment := 256
	size := len(data)
	alignedSize := (size + alignment - 1) &^ (alignment - 1)
	
	aligned := make([]byte, alignedSize)
	copy(aligned, data)
	
	return aligned
}

// detectGPUCapabilities detects GPU capabilities
func detectGPUCapabilities() GPUOptimizations {
	return GPUOptimizations{
		UseVectorized:    true,
		UseTensorCores:   false, // Requires specific GPU architectures
		UseSharedMemory:  true,
		UseConstantCache: true,
		UseTexureCache:   true,
		OptimizeMemCoal:  true,
		MaxBlockSize:     1024,
		MaxGridSize:      65535,
	}
}

// validateGPUMemorySize validates GPU memory requirements
func validateGPUMemorySize(required uint64, available uint64) error {
	if required > available {
		return fmt.Errorf("insufficient GPU memory: required %d MB, available %d MB",
			required/(1024*1024), available/(1024*1024))
	}
	
	// Reserve 10% for GPU operations
	if required > available*90/100 {
		return fmt.Errorf("insufficient GPU memory after reserving overhead")
	}
	
	return nil
}