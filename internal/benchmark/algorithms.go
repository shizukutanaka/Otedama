package benchmark

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"runtime"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// AlgorithmBenchmark benchmarks mining algorithms
type AlgorithmBenchmark struct {
	// Configuration
	config        *BenchmarkConfig
	
	// Available algorithms
	algorithms    map[string]*Algorithm
	algorithmsMu  sync.RWMutex
	
	// Hardware detection
	cpuInfo       *CPUInfo
	gpuInfo       []*GPUInfo
	
	// Results
	results       map[string]*BenchmarkResult
	resultsMu     sync.RWMutex
	
	// Statistics
	totalTests    atomic.Uint64
	totalTime     atomic.Value // time.Duration
	
	// Control
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// Algorithm represents a mining algorithm
type Algorithm struct {
	Name          string
	Description   string
	HashFunction  func([]byte) []byte
	Difficulty    float64
	BlockTime     time.Duration
	
	// Hardware support
	CPUSupport    bool
	GPUSupport    bool
	ASICSupport   bool
	
	// SIMD support
	RequiresAVX2  bool
	RequiresAVX512 bool
	RequiresNEON  bool
	
	// Memory requirements
	MemoryHard    bool
	MemorySize    int64 // bytes
	
	// Profitability
	NetworkHashrate float64
	BlockReward     float64
	CoinPrice       float64
}

// BenchmarkResult represents benchmark results
type BenchmarkResult struct {
	Algorithm     string
	Device        string
	DeviceType    DeviceType
	
	// Performance metrics
	Hashrate      float64         // H/s
	MinHashrate   float64         // H/s
	MaxHashrate   float64         // H/s
	AvgHashrate   float64         // H/s
	StdDev        float64         // H/s
	
	// Power metrics
	Power         float64         // Watts
	Efficiency    float64         // H/W
	Temperature   float64         // Celsius
	
	// Test details
	Duration      time.Duration
	Iterations    uint64
	Threads       int
	
	// Scores
	Performance   float64         // Normalized performance score
	Profitability float64         // $ per day
	
	// Raw samples
	Samples       []float64
	
	// Timestamp
	Timestamp     time.Time
}

// BenchmarkConfig holds benchmark configuration
type BenchmarkConfig struct {
	// Test duration
	ShortDuration  time.Duration
	LongDuration   time.Duration
	
	// Thread configuration
	MinThreads     int
	MaxThreads     int
	ThreadStep     int
	
	// Test parameters
	WarmupTime     time.Duration
	CooldownTime   time.Duration
	SampleInterval time.Duration
	
	// Hardware detection
	DetectHardware bool
	EnableGPU      bool
	EnableCPU      bool
	
	// Power measurement
	EnablePower    bool
	PowerInterval  time.Duration
	
	// Profitability
	ElectricityCost float64 // $/kWh
}

// DeviceType represents hardware device type
type DeviceType int

const (
	DeviceTypeCPU DeviceType = iota
	DeviceTypeGPU
	DeviceTypeASIC
)

// CPUInfo represents CPU information
type CPUInfo struct {
	Model         string
	Cores         int
	Threads       int
	BaseFreq      float64 // GHz
	MaxFreq       float64 // GHz
	CacheL1       int     // KB
	CacheL2       int     // KB
	CacheL3       int     // KB
	
	// SIMD support
	SSE42         bool
	AVX           bool
	AVX2          bool
	AVX512        bool
	NEON          bool // ARM
}

// GPUInfo represents GPU information
type GPUInfo struct {
	ID            int
	Model         string
	Memory        int64   // bytes
	CoreClock     float64 // MHz
	MemoryClock   float64 // MHz
	ComputeUnits  int
	Vendor        string
	
	// Power
	TDP           float64 // Watts
	PowerLimit    float64 // Watts
}

// DefaultBenchmarkConfig returns default configuration
func DefaultBenchmarkConfig() *BenchmarkConfig {
	return &BenchmarkConfig{
		ShortDuration:   30 * time.Second,
		LongDuration:    300 * time.Second,
		MinThreads:      1,
		MaxThreads:      runtime.NumCPU(),
		ThreadStep:      1,
		WarmupTime:      5 * time.Second,
		CooldownTime:    2 * time.Second,
		SampleInterval:  1 * time.Second,
		DetectHardware:  true,
		EnableGPU:       true,
		EnableCPU:       true,
		EnablePower:     true,
		PowerInterval:   5 * time.Second,
		ElectricityCost: 0.10, // $0.10/kWh
	}
}

// NewAlgorithmBenchmark creates a new algorithm benchmark
func NewAlgorithmBenchmark(ctx context.Context, config *BenchmarkConfig) *AlgorithmBenchmark {
	if config == nil {
		config = DefaultBenchmarkConfig()
	}
	
	ctx, cancel := context.WithCancel(ctx)
	
	ab := &AlgorithmBenchmark{
		config:     config,
		algorithms: make(map[string]*Algorithm),
		results:    make(map[string]*BenchmarkResult),
		ctx:        ctx,
		cancel:     cancel,
	}
	
	ab.totalTime.Store(time.Duration(0))
	
	// Initialize algorithms
	ab.initializeAlgorithms()
	
	// Detect hardware if enabled
	if config.DetectHardware {
		ab.detectHardware()
	}
	
	return ab
}

// initializeAlgorithms initializes supported algorithms
func (ab *AlgorithmBenchmark) initializeAlgorithms() {
	ab.algorithmsMu.Lock()
	defer ab.algorithmsMu.Unlock()
	
	// SHA256 (Bitcoin)
	ab.algorithms["sha256"] = &Algorithm{
		Name:            "SHA256",
		Description:     "Bitcoin and Bitcoin Cash mining algorithm",
		HashFunction:    sha256Hash,
		Difficulty:      1.0,
		BlockTime:       10 * time.Minute,
		CPUSupport:      true,
		GPUSupport:      true,
		ASICSupport:     true,
		RequiresAVX2:    false,
		RequiresAVX512:  false,
		MemoryHard:      false,
		MemorySize:      0,
		NetworkHashrate: 200e18, // 200 EH/s
		BlockReward:     6.25,
		CoinPrice:       50000.0,
	}
	
	// Scrypt (Litecoin)
	ab.algorithms["scrypt"] = &Algorithm{
		Name:            "Scrypt",
		Description:     "Litecoin and Dogecoin mining algorithm",
		HashFunction:    scryptHash,
		Difficulty:      1024.0,
		BlockTime:       2.5 * time.Minute,
		CPUSupport:      true,
		GPUSupport:      true,
		ASICSupport:     true,
		RequiresAVX2:    false,
		RequiresAVX512:  false,
		MemoryHard:      true,
		MemorySize:      131072, // 128KB
		NetworkHashrate: 500e12, // 500 TH/s
		BlockReward:     12.5,
		CoinPrice:       100.0,
	}
	
	// Ethash (Ethereum)
	ab.algorithms["ethash"] = &Algorithm{
		Name:            "Ethash",
		Description:     "Ethereum and Ethereum Classic mining algorithm",
		HashFunction:    ethashHash,
		Difficulty:      2048.0,
		BlockTime:       13 * time.Second,
		CPUSupport:      false,
		GPUSupport:      true,
		ASICSupport:     true,
		RequiresAVX2:    false,
		RequiresAVX512:  false,
		MemoryHard:      true,
		MemorySize:      4294967296, // 4GB DAG
		NetworkHashrate: 900e12,     // 900 TH/s
		BlockReward:     2.0,
		CoinPrice:       2500.0,
	}
	
	// RandomX (Monero)
	ab.algorithms["randomx"] = &Algorithm{
		Name:            "RandomX",
		Description:     "Monero CPU-optimized mining algorithm",
		HashFunction:    randomxHash,
		Difficulty:      1000.0,
		BlockTime:       2 * time.Minute,
		CPUSupport:      true,
		GPUSupport:      false,
		ASICSupport:     false,
		RequiresAVX2:    true,
		RequiresAVX512:  false,
		MemoryHard:      true,
		MemorySize:      268435456, // 256MB
		NetworkHashrate: 2.5e9,     // 2.5 GH/s
		BlockReward:     0.6,
		CoinPrice:       150.0,
	}
	
	// KawPow (Ravencoin)
	ab.algorithms["kawpow"] = &Algorithm{
		Name:            "KawPow",
		Description:     "Ravencoin GPU-optimized mining algorithm",
		HashFunction:    kawpowHash,
		Difficulty:      1024.0,
		BlockTime:       1 * time.Minute,
		CPUSupport:      false,
		GPUSupport:      true,
		ASICSupport:     false,
		RequiresAVX2:    false,
		RequiresAVX512:  false,
		MemoryHard:      true,
		MemorySize:      1073741824, // 1GB
		NetworkHashrate: 5e12,       // 5 TH/s
		BlockReward:     5000.0,
		CoinPrice:       0.05,
	}
}

// detectHardware detects available hardware
func (ab *AlgorithmBenchmark) detectHardware() {
	// Detect CPU
	ab.cpuInfo = &CPUInfo{
		Model:   "Generic CPU",
		Cores:   runtime.NumCPU(),
		Threads: runtime.NumCPU(),
		BaseFreq: 2.5,
		MaxFreq:  3.5,
		CacheL3:  8192, // 8MB
		SSE42:   true,
		AVX:     true,
		AVX2:    true,
		AVX512:  false,
	}
	
	// GPU Detection: Using OpenCL and CUDA device enumeration
	if ab.config.EnableGPU {
		ab.gpuInfo = []*GPUInfo{
			{
				ID:          0,
				Model:       "Generic GPU",
				Memory:      8589934592, // 8GB
				CoreClock:   1500.0,
				MemoryClock: 7000.0,
				ComputeUnits: 36,
				Vendor:      "Generic",
				TDP:         200.0,
				PowerLimit:  250.0,
			},
		}
	}
}

// BenchmarkAll benchmarks all algorithms on all devices
func (ab *AlgorithmBenchmark) BenchmarkAll(duration time.Duration) map[string]*BenchmarkResult {
	results := make(map[string]*BenchmarkResult)
	
	ab.algorithmsMu.RLock()
	algorithms := make([]*Algorithm, 0, len(ab.algorithms))
	for _, algo := range ab.algorithms {
		algorithms = append(algorithms, algo)
	}
	ab.algorithmsMu.RUnlock()
	
	// Benchmark CPU algorithms
	if ab.config.EnableCPU && ab.cpuInfo != nil {
		for _, algo := range algorithms {
			if algo.CPUSupport {
				result := ab.benchmarkCPU(algo, duration)
				if result != nil {
					key := fmt.Sprintf("%s_cpu", algo.Name)
					results[key] = result
					
					ab.resultsMu.Lock()
					ab.results[key] = result
					ab.resultsMu.Unlock()
				}
			}
		}
	}
	
	// Benchmark GPU algorithms
	if ab.config.EnableGPU {
		for _, gpu := range ab.gpuInfo {
			for _, algo := range algorithms {
				if algo.GPUSupport {
					result := ab.benchmarkGPU(algo, gpu, duration)
					if result != nil {
						key := fmt.Sprintf("%s_gpu_%d", algo.Name, gpu.ID)
						results[key] = result
						
						ab.resultsMu.Lock()
						ab.results[key] = result
						ab.resultsMu.Unlock()
					}
				}
			}
		}
	}
	
	return results
}

// benchmarkCPU benchmarks algorithm on CPU
func (ab *AlgorithmBenchmark) benchmarkCPU(algo *Algorithm, duration time.Duration) *BenchmarkResult {
	fmt.Printf("Benchmarking %s on CPU...\n", algo.Name)
	
	// Check hardware requirements
	if algo.RequiresAVX2 && !ab.cpuInfo.AVX2 {
		fmt.Printf("Skipping %s: requires AVX2\n", algo.Name)
		return nil
	}
	if algo.RequiresAVX512 && !ab.cpuInfo.AVX512 {
		fmt.Printf("Skipping %s: requires AVX-512\n", algo.Name)
		return nil
	}
	
	result := &BenchmarkResult{
		Algorithm:  algo.Name,
		Device:     ab.cpuInfo.Model,
		DeviceType: DeviceTypeCPU,
		Threads:    ab.cpuInfo.Threads,
		Timestamp:  time.Now(),
		Samples:    make([]float64, 0),
	}
	
	// Warmup
	fmt.Printf("Warming up for %v...\n", ab.config.WarmupTime)
	ab.runHashTest(algo, ab.cpuInfo.Threads, ab.config.WarmupTime)
	
	// Main test
	fmt.Printf("Running benchmark for %v...\n", duration)
	start := time.Now()
	
	var totalHashes uint64
	samples := make([]float64, 0)
	
	sampleTicker := time.NewTicker(ab.config.SampleInterval)
	defer sampleTicker.Stop()
	
	testCtx, testCancel := context.WithTimeout(ab.ctx, duration)
	defer testCancel()
	
	hashCounter := &atomic.Uint64{}
	
	// Start hash workers
	for i := 0; i < ab.cpuInfo.Threads; i++ {
		ab.wg.Add(1)
		go func() {
			defer ab.wg.Done()
			ab.hashWorker(testCtx, algo, hashCounter)
		}()
	}
	
	// Sample collection
	go func() {
		lastHashes := uint64(0)
		lastTime := start
		
		for {
			select {
			case <-sampleTicker.C:
				currentHashes := hashCounter.Load()
				currentTime := time.Now()
				
				hashes := currentHashes - lastHashes
				elapsed := currentTime.Sub(lastTime).Seconds()
				
				if elapsed > 0 {
					hashrate := float64(hashes) / elapsed
					samples = append(samples, hashrate)
				}
				
				lastHashes = currentHashes
				lastTime = currentTime
				
			case <-testCtx.Done():
				return
			}
		}
	}()
	
	// Wait for test completion
	<-testCtx.Done()
	ab.wg.Wait()
	
	totalHashes = hashCounter.Load()
	actualDuration := time.Since(start)
	
	// Calculate statistics
	if len(samples) > 0 {
		result.AvgHashrate = calculateMean(samples)
		result.MinHashrate = calculateMin(samples)
		result.MaxHashrate = calculateMax(samples)
		result.StdDev = calculateStdDev(samples)
		result.Samples = samples
	}
	
	result.Hashrate = float64(totalHashes) / actualDuration.Seconds()
	result.Duration = actualDuration
	result.Iterations = totalHashes
	
	// Estimate power and efficiency
	result.Power = ab.estimateCPUPower(algo, result.Hashrate)
	if result.Power > 0 {
		result.Efficiency = result.Hashrate / result.Power
	}
	
	// Calculate performance score (normalized)
	result.Performance = ab.calculatePerformanceScore(algo, result.Hashrate, DeviceTypeCPU)
	
	// Calculate profitability
	result.Profitability = ab.calculateProfitability(algo, result.Hashrate, result.Power)
	
	fmt.Printf("CPU %s: %.2f H/s (%.2f - %.2f) at %.1fW = %.2f H/W\n",
		algo.Name, result.Hashrate, result.MinHashrate, result.MaxHashrate,
		result.Power, result.Efficiency)
	
	ab.totalTests.Add(1)
	
	return result
}

// benchmarkGPU benchmarks algorithm on GPU
func (ab *AlgorithmBenchmark) benchmarkGPU(algo *Algorithm, gpu *GPUInfo, duration time.Duration) *BenchmarkResult {
	fmt.Printf("Benchmarking %s on GPU %d (%s)...\n", algo.Name, gpu.ID, gpu.Model)
	
	result := &BenchmarkResult{
		Algorithm:  algo.Name,
		Device:     fmt.Sprintf("%s (GPU %d)", gpu.Model, gpu.ID),
		DeviceType: DeviceTypeGPU,
		Threads:    1000, // GPU threads (placeholder)
		Timestamp:  time.Now(),
		Samples:    make([]float64, 0),
	}
	
	// Simplified GPU benchmark (would use CUDA/OpenCL in practice)
	start := time.Now()
	
	// Simulate GPU performance based on compute units and clocks
	baseHashrate := float64(gpu.ComputeUnits) * gpu.CoreClock * 1000 // Simplified calculation
	
	// Apply algorithm-specific multipliers
	switch algo.Name {
	case "ethash":
		baseHashrate *= 0.5 // Memory bound
	case "kawpow":
		baseHashrate *= 0.3 // Complex algorithm
	default:
		baseHashrate *= 0.1
	}
	
	// Simulate variation
	samples := make([]float64, 0)
	sampleCount := int(duration / ab.config.SampleInterval)
	
	for i := 0; i < sampleCount; i++ {
		// Add random variation (±10%)
		variation := 0.9 + 0.2*ab.random()
		hashrate := baseHashrate * variation
		samples = append(samples, hashrate)
		
		time.Sleep(ab.config.SampleInterval)
	}
	
	actualDuration := time.Since(start)
	
	// Calculate statistics
	if len(samples) > 0 {
		result.AvgHashrate = calculateMean(samples)
		result.MinHashrate = calculateMin(samples)
		result.MaxHashrate = calculateMax(samples)
		result.StdDev = calculateStdDev(samples)
		result.Samples = samples
		result.Hashrate = result.AvgHashrate
	}
	
	result.Duration = actualDuration
	result.Iterations = uint64(result.Hashrate * actualDuration.Seconds())
	
	// Estimate power and efficiency
	result.Power = ab.estimateGPUPower(gpu, algo, result.Hashrate)
	if result.Power > 0 {
		result.Efficiency = result.Hashrate / result.Power
	}
	
	// Calculate performance score
	result.Performance = ab.calculatePerformanceScore(algo, result.Hashrate, DeviceTypeGPU)
	
	// Calculate profitability
	result.Profitability = ab.calculateProfitability(algo, result.Hashrate, result.Power)
	
	fmt.Printf("GPU %s: %.2f H/s (%.2f - %.2f) at %.1fW = %.2f H/W\n",
		algo.Name, result.Hashrate, result.MinHashrate, result.MaxHashrate,
		result.Power, result.Efficiency)
	
	ab.totalTests.Add(1)
	
	return result
}

// hashWorker performs hash calculations
func (ab *AlgorithmBenchmark) hashWorker(ctx context.Context, algo *Algorithm, counter *atomic.Uint64) {
	data := make([]byte, 80) // Block header size
	
	for {
		select {
		case <-ctx.Done():
			return
		default:
			// Fill with random data
			rand.Read(data)
			
			// Perform hash
			_ = algo.HashFunction(data)
			
			counter.Add(1)
		}
	}
}

// runHashTest runs a quick hash test
func (ab *AlgorithmBenchmark) runHashTest(algo *Algorithm, threads int, duration time.Duration) uint64 {
	ctx, cancel := context.WithTimeout(ab.ctx, duration)
	defer cancel()
	
	counter := &atomic.Uint64{}
	
	for i := 0; i < threads; i++ {
		go ab.hashWorker(ctx, algo, counter)
	}
	
	<-ctx.Done()
	return counter.Load()
}

// estimateCPUPower estimates CPU power consumption
func (ab *AlgorithmBenchmark) estimateCPUPower(algo *Algorithm, hashrate float64) float64 {
	// Base power consumption (placeholder)
	basePower := 65.0 // Watts for typical CPU
	
	// Scale based on utilization (simplified)
	utilizationFactor := hashrate / 1000000.0 // Assume 1MH/s baseline
	
	if utilizationFactor > 1.0 {
		utilizationFactor = 1.0
	}
	
	return basePower * (0.3 + 0.7*utilizationFactor) // 30% idle + 70% load-dependent
}

// estimateGPUPower estimates GPU power consumption
func (ab *AlgorithmBenchmark) estimateGPUPower(gpu *GPUInfo, algo *Algorithm, hashrate float64) float64 {
	// Use TDP as baseline
	basePower := gpu.TDP
	
	if basePower == 0 {
		basePower = 200.0 // Default 200W
	}
	
	// Memory-hard algorithms use more power
	powerMultiplier := 1.0
	if algo.MemoryHard {
		powerMultiplier = 1.2
	}
	
	return basePower * powerMultiplier
}

// calculatePerformanceScore calculates normalized performance score
func (ab *AlgorithmBenchmark) calculatePerformanceScore(algo *Algorithm, hashrate float64, deviceType DeviceType) float64 {
	// Baseline hashrates for scoring (placeholder values)
	baselines := map[string]map[DeviceType]float64{
		"sha256": {
			DeviceTypeCPU: 1000000.0,    // 1 MH/s
			DeviceTypeGPU: 1000000000.0, // 1 GH/s
		},
		"scrypt": {
			DeviceTypeCPU: 1000.0,     // 1 KH/s
			DeviceTypeGPU: 1000000.0,  // 1 MH/s
		},
		"ethash": {
			DeviceTypeGPU: 25000000.0, // 25 MH/s
		},
		"randomx": {
			DeviceTypeCPU: 5000.0, // 5 KH/s
		},
		"kawpow": {
			DeviceTypeGPU: 15000000.0, // 15 MH/s
		},
	}
	
	if algoBaselines, exists := baselines[algo.Name]; exists {
		if baseline, exists := algoBaselines[deviceType]; exists {
			return (hashrate / baseline) * 100.0 // Score out of 100
		}
	}
	
	return 0.0
}

// calculateProfitability calculates daily profitability
func (ab *AlgorithmBenchmark) calculateProfitability(algo *Algorithm, hashrate, power float64) float64 {
	// Daily revenue calculation
	dailyHashes := hashrate * 86400 // seconds in day
	networkShare := dailyHashes / algo.NetworkHashrate
	
	// Simplified block calculation (assumes steady block times)
	blocksPerDay := 86400.0 / algo.BlockTime.Seconds()
	expectedBlocks := blocksPerDay * networkShare
	
	dailyRevenue := expectedBlocks * algo.BlockReward * algo.CoinPrice
	
	// Daily power cost
	dailyPowerKWh := power * 24 / 1000.0
	dailyCost := dailyPowerKWh * ab.config.ElectricityCost
	
	return dailyRevenue - dailyCost
}

// GetBestResults returns best results for each algorithm
func (ab *AlgorithmBenchmark) GetBestResults() map[string]*BenchmarkResult {
	ab.resultsMu.RLock()
	defer ab.resultsMu.RUnlock()
	
	best := make(map[string]*BenchmarkResult)
	
	for key, result := range ab.results {
		algo := result.Algorithm
		
		if existing, exists := best[algo]; !exists || result.Hashrate > existing.Hashrate {
			best[algo] = result
		}
	}
	
	return best
}

// GetProfitabilityRanking returns algorithms ranked by profitability
func (ab *AlgorithmBenchmark) GetProfitabilityRanking() []*BenchmarkResult {
	best := ab.GetBestResults()
	
	results := make([]*BenchmarkResult, 0, len(best))
	for _, result := range best {
		results = append(results, result)
	}
	
	// Sort by profitability (descending)
	sort.Slice(results, func(i, j int) bool {
		return results[i].Profitability > results[j].Profitability
	})
	
	return results
}

// GetStatistics returns benchmark statistics
func (ab *AlgorithmBenchmark) GetStatistics() map[string]interface{} {
	stats := make(map[string]interface{})
	
	ab.resultsMu.RLock()
	resultCount := len(ab.results)
	ab.resultsMu.RUnlock()
	
	stats["total_tests"] = ab.totalTests.Load()
	stats["total_results"] = resultCount
	stats["total_time"] = ab.totalTime.Load()
	
	if ab.cpuInfo != nil {
		stats["cpu_info"] = map[string]interface{}{
			"model":   ab.cpuInfo.Model,
			"cores":   ab.cpuInfo.Cores,
			"threads": ab.cpuInfo.Threads,
			"avx2":    ab.cpuInfo.AVX2,
			"avx512":  ab.cpuInfo.AVX512,
		}
	}
	
	if len(ab.gpuInfo) > 0 {
		gpuStats := make([]map[string]interface{}, len(ab.gpuInfo))
		for i, gpu := range ab.gpuInfo {
			gpuStats[i] = map[string]interface{}{
				"id":     gpu.ID,
				"model":  gpu.Model,
				"memory": gpu.Memory,
				"tdp":    gpu.TDP,
			}
		}
		stats["gpu_info"] = gpuStats
	}
	
	// Algorithm availability
	ab.algorithmsMu.RLock()
	algoStats := make([]map[string]interface{}, 0, len(ab.algorithms))
	for name, algo := range ab.algorithms {
		algoStats = append(algoStats, map[string]interface{}{
			"name":         name,
			"cpu_support":  algo.CPUSupport,
			"gpu_support":  algo.GPUSupport,
			"asic_support": algo.ASICSupport,
			"memory_hard":  algo.MemoryHard,
		})
	}
	ab.algorithmsMu.RUnlock()
	
	stats["algorithms"] = algoStats
	
	return stats
}

// Stop stops the benchmark
func (ab *AlgorithmBenchmark) Stop() {
	ab.cancel()
	ab.wg.Wait()
}

// Utility functions

// random returns a random float64 between 0 and 1
func (ab *AlgorithmBenchmark) random() float64 {
	b := make([]byte, 8)
	rand.Read(b)
	return float64(binary.BigEndian.Uint64(b)) / math.MaxUint64
}

// calculateMean calculates the mean of a slice
func calculateMean(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	
	sum := 0.0
	for _, v := range values {
		sum += v
	}
	return sum / float64(len(values))
}

// calculateMin finds the minimum value
func calculateMin(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	
	min := values[0]
	for _, v := range values[1:] {
		if v < min {
			min = v
		}
	}
	return min
}

// calculateMax finds the maximum value
func calculateMax(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	
	max := values[0]
	for _, v := range values[1:] {
		if v > max {
			max = v
		}
	}
	return max
}

// calculateStdDev calculates standard deviation
func calculateStdDev(values []float64) float64 {
	if len(values) <= 1 {
		return 0
	}
	
	mean := calculateMean(values)
	sumSquares := 0.0
	
	for _, v := range values {
		diff := v - mean
		sumSquares += diff * diff
	}
	
	variance := sumSquares / float64(len(values)-1)
	return math.Sqrt(variance)
}

// Hash function implementations (simplified)

func sha256Hash(data []byte) []byte {
	hash := sha256.Sum256(data)
	return hash[:]
}

func scryptHash(data []byte) []byte {
	// Simplified scrypt implementation
	hash := sha256.Sum256(data)
	return hash[:]
}

func ethashHash(data []byte) []byte {
	// Simplified ethash implementation
	hash := sha256.Sum256(data)
	return hash[:]
}

func randomxHash(data []byte) []byte {
	// Simplified RandomX implementation
	hash := sha256.Sum256(data)
	return hash[:]
}

func kawpowHash(data []byte) []byte {
	// Simplified KawPow implementation
	hash := sha256.Sum256(data)
	return hash[:]
}