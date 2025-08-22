// Package mining provides the unified mining engine for Otedama
// Design philosophy: Simple, efficient, maintainable (Carmack/Pike/Martin)
package mining

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"golang.org/x/crypto/scrypt"
	"lukechampine.com/blake3"
)

// Constants for mining operations
const (
	MaxWorkers        = 256
	DefaultBatchSize  = 1000000
	ShareQueueSize    = 10000
	StatsInterval     = 5 * time.Second
	OptimizeInterval  = 30 * time.Second
	MaxTemperature    = 95.0
	MinHashrate       = 1000000 // 1 MH/s
)

// Engine represents the unified mining engine
type Engine struct {
	// Core components
	config    *Config
	state     atomic.Int32 // EngineState
	ctx       context.Context
	cancel    context.CancelFunc
	wg        sync.WaitGroup
	
	// Mining components
	algorithm Algorithm
	workers   []*Worker
	jobQueue  chan *Job
	shares    chan *Share
	
	// Statistics
	stats     *Statistics
	metrics   *Metrics
	
	// Hardware management
	hardware  *HardwareManager
	
	// Optimization
	optimizer *Optimizer
	
	// Memory pools for zero-allocation
	bufferPool sync.Pool
	noncePool  sync.Pool
}

// Config holds engine configuration
type Config struct {
	// Algorithm selection
	Algorithm     string
	AutoSwitch    bool
	
	// Hardware configuration
	CPU           CPUConfig
	GPU           GPUConfig
	ASIC          ASICConfig
	
	// Pool configuration
	Pools         []PoolConfig
	
	// P2P configuration
	P2PEnabled    bool
	P2PPort       int
	
	// Optimization
	AutoOptimize  bool
	PowerMode     PowerMode
	TargetTemp    float64
	MaxPower      float64
	
	// Security
	SecurityLevel SecurityLevel
}

// CPUConfig for CPU mining
type CPUConfig struct {
	Enabled   bool
	Threads   int
	Affinity  []int
	Priority  int // -20 to 19 (Unix nice values)
	HugePages bool
}

// GPUConfig for GPU mining
type GPUConfig struct {
	Enabled    bool
	Devices    []int
	Intensity  int // 1-30
	TempLimit  float64
	PowerLimit int
	MemClock   int
	CoreClock  int
}

// ASICConfig for ASIC mining
type ASICConfig struct {
	Enabled   bool
	Devices   []string
	Frequency int
	Voltage   float64
}

// PoolConfig represents mining pool configuration
type PoolConfig struct {
	URL      string
	User     string
	Password string
	Priority int
}

// EngineState represents engine states
type EngineState int32

const (
	StateIdle EngineState = iota
	StateInitializing
	StateRunning
	StateStopping
	StateStopped
	StateError
)

// PowerMode represents power consumption modes
type PowerMode int

const (
	PowerEfficiency PowerMode = iota
	PowerBalanced
	PowerPerformance
	PowerTurbo
	PowerInsane // Maximum performance, no limits
)

// SecurityLevel represents security configuration
type SecurityLevel int

const (
	SecurityStandard SecurityLevel = iota
	SecurityEnhanced
	SecurityMaximum
	SecurityParanoid // Military-grade security
)

// Job represents a mining job
type Job struct {
	ID         string
	Algorithm  string
	Target     []byte
	Header     []byte
	Nonce      uint64
	ExtraNonce []byte
	Height     uint64
	Difficulty float64
	CleanJobs  bool
	Timestamp  time.Time
}

// Share represents a mining share
type Share struct {
	JobID      string
	WorkerID   string
	Nonce      uint64
	Hash       []byte
	Difficulty float64
	Valid      bool
	Timestamp  time.Time
}

// Worker represents a mining worker
type Worker struct {
	ID        string
	Type      DeviceType
	Device    interface{}
	Active    atomic.Bool
	Hashrate  atomic.Uint64
	Shares    atomic.Uint64
	Errors    atomic.Uint64
	Temp      atomic.Uint32 // Temperature * 100
	Power     atomic.Uint32 // Watts * 100
	
	// Worker-specific context
	ctx       context.Context
	cancel    context.CancelFunc
}

// DeviceType represents hardware device types
type DeviceType int

const (
	DeviceCPU DeviceType = iota
	DeviceGPU
	DeviceASIC
	DeviceFPGA
)

// Statistics tracks mining statistics
type Statistics struct {
	StartTime      time.Time
	Hashrate       atomic.Uint64
	SharesAccepted atomic.Uint64
	SharesRejected atomic.Uint64
	SharesStale    atomic.Uint64
	BlocksFound    atomic.Uint64
	LastShare      atomic.Int64
	Uptime         atomic.Int64
	Revenue        atomic.Uint64 // Satoshis
}

// Metrics tracks performance metrics
type Metrics struct {
	Temperature    atomic.Uint32 // Celsius * 100
	PowerUsage     atomic.Uint32 // Watts * 100
	Efficiency     atomic.Uint64 // Hashes per Watt
	CPUUsage       atomic.Uint32 // Percentage * 100
	MemoryUsage    atomic.Uint64 // Bytes
	NetworkLatency atomic.Uint32 // Milliseconds
}

// Algorithm interface for mining algorithms
type Algorithm interface {
	Name() string
	Hash(data []byte) []byte
	Verify(hash, target []byte) bool
	GetDifficulty(hash []byte) float64
	OptimalBatchSize() int
}

// HardwareManager manages hardware resources
type HardwareManager struct {
	mu        sync.RWMutex
	cpus      []CPUDevice
	gpus      []GPUDevice
	asics     []ASICDevice
	intensity atomic.Int32
	
	// SIMD support detection
	hasAVX2   bool
	hasAVX512 bool
	hasNEON   bool
}

// Optimizer handles automatic optimization
type Optimizer struct {
	engine        *Engine
	mu            sync.RWMutex
	powerMode     PowerMode
	lastOptimize  time.Time
	targetHashrate uint64
}

// NewEngine creates a new mining engine
func NewEngine(config *Config) (*Engine, error) {
	if config == nil {
		return nil, errors.New("config required")
	}
	
	// Set defaults
	if config.CPU.Threads == 0 {
		config.CPU.Threads = runtime.NumCPU()
	}
	if config.TargetTemp == 0 {
		config.TargetTemp = 85.0
	}
	if config.MaxPower == 0 {
		config.MaxPower = 1000.0
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	e := &Engine{
		config:   config,
		ctx:      ctx,
		cancel:   cancel,
		jobQueue: make(chan *Job, 100),
		shares:   make(chan *Share, ShareQueueSize),
		stats:    &Statistics{StartTime: time.Now()},
		metrics:  &Metrics{},
		hardware: &HardwareManager{},
		bufferPool: sync.Pool{
			New: func() interface{} {
				return make([]byte, 256)
			},
		},
		noncePool: sync.Pool{
			New: func() interface{} {
				return new(uint64)
			},
		},
	}
	
	// Initialize algorithm
	if err := e.initAlgorithm(config.Algorithm); err != nil {
		cancel()
		return nil, err
	}
	
	// Initialize hardware
	if err := e.initHardware(); err != nil {
		cancel()
		return nil, err
	}
	
	// Initialize optimizer
	if config.AutoOptimize {
		e.optimizer = &Optimizer{
			engine:    e,
			powerMode: config.PowerMode,
		}
	}
	
	e.state.Store(int32(StateIdle))
	return e, nil
}

// Initialize prepares the engine for mining
func (e *Engine) Initialize() error {
	if !e.state.CompareAndSwap(int32(StateIdle), int32(StateInitializing)) {
		return errors.New("invalid state for initialization")
	}
	
	// Detect SIMD capabilities
	e.hardware.detectSIMD()
	
	// Create workers
	if err := e.createWorkers(); err != nil {
		e.state.Store(int32(StateError))
		return fmt.Errorf("failed to create workers: %w", err)
	}
	
	// Apply security settings
	if err := e.applySecurity(); err != nil {
		return fmt.Errorf("failed to apply security: %w", err)
	}
	
	// Setup memory optimization
	if e.config.CPU.HugePages {
		e.setupHugePages()
	}
	
	e.state.Store(int32(StateIdle))
	return nil
}

// Start begins mining operations
func (e *Engine) Start() error {
	if !e.state.CompareAndSwap(int32(StateIdle), int32(StateRunning)) {
		return errors.New("engine not in idle state")
	}
	
	// Start workers
	for _, worker := range e.workers {
		if worker.Active.Load() {
			e.wg.Add(1)
			go e.runWorker(worker)
		}
	}
	
	// Start share processor
	e.wg.Add(1)
	go e.processShares()
	
	// Start statistics reporter
	e.wg.Add(1)
	go e.reportStats()
	
	// Start optimizer
	if e.optimizer != nil {
		e.wg.Add(1)
		go e.runOptimizer()
	}
	
	// Update start time
	e.stats.StartTime = time.Now()
	
	return nil
}

// Stop halts mining operations
func (e *Engine) Stop() error {
	if !e.state.CompareAndSwap(int32(StateRunning), int32(StateStopping)) {
		return errors.New("engine not running")
	}
	
	// Cancel context
	e.cancel()
	
	// Stop all workers
	for _, worker := range e.workers {
		worker.cancel()
	}
	
	// Wait for goroutines
	done := make(chan struct{})
	go func() {
		e.wg.Wait()
		close(done)
	}()
	
	select {
	case <-done:
		e.state.Store(int32(StateStopped))
		return nil
	case <-time.After(10 * time.Second):
		e.state.Store(int32(StateError))
		return errors.New("shutdown timeout")
	}
}

// SubmitJob submits a new mining job
func (e *Engine) SubmitJob(job *Job) error {
	if e.state.Load() != int32(StateRunning) {
		return errors.New("engine not running")
	}
	
	// Validate job
	if job == nil || len(job.Target) == 0 || len(job.Header) == 0 {
		return errors.New("invalid job")
	}
	
	// Broadcast to workers
	select {
	case e.jobQueue <- job:
		return nil
	case <-time.After(100 * time.Millisecond):
		return errors.New("job queue full")
	}
}

// GetStatistics returns current mining statistics
func (e *Engine) GetStatistics() map[string]interface{} {
	uptime := time.Since(e.stats.StartTime)
	hashrate := e.stats.Hashrate.Load()
	
	// Calculate efficiency
	power := float64(e.metrics.PowerUsage.Load()) / 100.0
	efficiency := float64(0)
	if power > 0 {
		efficiency = float64(hashrate) / power
	}
	
	return map[string]interface{}{
		"state":           e.getStateString(),
		"algorithm":       e.config.Algorithm,
		"uptime":          uptime.Seconds(),
		"hashrate":        hashrate,
		"hashrate_h":      formatHashrate(hashrate),
		"shares_accepted": e.stats.SharesAccepted.Load(),
		"shares_rejected": e.stats.SharesRejected.Load(),
		"shares_stale":    e.stats.SharesStale.Load(),
		"blocks_found":    e.stats.BlocksFound.Load(),
		"temperature":     float64(e.metrics.Temperature.Load()) / 100.0,
		"power_usage":     power,
		"efficiency":      efficiency,
		"efficiency_h":    formatEfficiency(efficiency),
		"workers_active":  e.countActiveWorkers(),
		"workers_total":   len(e.workers),
		"revenue_satoshi": e.stats.Revenue.Load(),
		"cpu_usage":       float64(e.metrics.CPUUsage.Load()) / 100.0,
		"memory_usage":    e.metrics.MemoryUsage.Load(),
		"network_latency": e.metrics.NetworkLatency.Load(),
	}
}

// Benchmark runs performance benchmark
func (e *Engine) Benchmark(duration time.Duration) (map[string]float64, error) {
	if e.state.Load() != int32(StateIdle) {
		return nil, errors.New("engine must be idle for benchmark")
	}
	
	results := make(map[string]float64)
	algorithms := []string{"sha256d", "scrypt", "ethash", "randomx", "blake3"}
	
	for _, algo := range algorithms {
		// Initialize algorithm
		if err := e.initAlgorithm(algo); err != nil {
			continue
		}
		
		// Run benchmark
		hashes := e.benchmarkAlgorithm(duration)
		hashrate := float64(hashes) / duration.Seconds()
		results[algo] = hashrate
	}
	
	// Restore original algorithm
	e.initAlgorithm(e.config.Algorithm)
	
	return results, nil
}

// Private methods

func (e *Engine) initAlgorithm(name string) error {
	switch name {
	case "sha256d":
		e.algorithm = &SHA256d{}
	case "scrypt":
		e.algorithm = &Scrypt{}
	case "blake3":
		e.algorithm = &Blake3{}
	case "randomx":
		e.algorithm = &RandomX{}
	case "ethash":
		e.algorithm = &Ethash{}
	default:
		return fmt.Errorf("unsupported algorithm: %s", name)
	}
	return nil
}

func (e *Engine) initHardware() error {
	// Detect CPU features
	e.hardware.detectCPU()
	
	// Detect GPU devices
	if e.config.GPU.Enabled {
		e.hardware.detectGPU()
	}
	
	// Detect ASIC devices
	if e.config.ASIC.Enabled {
		e.hardware.detectASIC()
	}
	
	return nil
}

func (e *Engine) createWorkers() error {
	workerID := 0
	
	// Create CPU workers
	if e.config.CPU.Enabled {
		threads := e.config.CPU.Threads
		if threads > MaxWorkers {
			threads = MaxWorkers
		}
		
		for i := 0; i < threads; i++ {
			worker := e.createWorker(fmt.Sprintf("cpu-%d", i), DeviceCPU, nil)
			
			// Set CPU affinity if specified
			if len(e.config.CPU.Affinity) > i {
				// Set affinity to specific CPU core
				setCPUAffinity(worker, e.config.CPU.Affinity[i])
			}
			
			e.workers = append(e.workers, worker)
			workerID++
		}
	}
	
	// Create GPU workers
	if e.config.GPU.Enabled {
		for i, device := range e.hardware.gpus {
			worker := e.createWorker(fmt.Sprintf("gpu-%d", i), DeviceGPU, device)
			e.workers = append(e.workers, worker)
			workerID++
		}
	}
	
	// Create ASIC workers
	if e.config.ASIC.Enabled {
		for i, device := range e.hardware.asics {
			worker := e.createWorker(fmt.Sprintf("asic-%d", i), DeviceASIC, device)
			e.workers = append(e.workers, worker)
			workerID++
		}
	}
	
	if len(e.workers) == 0 {
		return errors.New("no workers created")
	}
	
	return nil
}

func (e *Engine) createWorker(id string, deviceType DeviceType, device interface{}) *Worker {
	ctx, cancel := context.WithCancel(e.ctx)
	
	worker := &Worker{
		ID:     id,
		Type:   deviceType,
		Device: device,
		ctx:    ctx,
		cancel: cancel,
	}
	
	worker.Active.Store(true)
	return worker
}

func (e *Engine) runWorker(worker *Worker) {
	defer e.wg.Done()
	
	// Get buffer from pool
	buffer := e.bufferPool.Get().([]byte)
	defer e.bufferPool.Put(buffer)
	
	// Mining loop
	for {
		select {
		case <-worker.ctx.Done():
			return
			
		case job := <-e.jobQueue:
			if job == nil {
				continue
			}
			
			// Process job
			e.processJob(worker, job, buffer)
		}
	}
}

func (e *Engine) processJob(worker *Worker, job *Job, buffer []byte) {
	batchSize := e.algorithm.OptimalBatchSize()
	startNonce := atomic.AddUint64(&job.Nonce, uint64(batchSize))
	endNonce := startNonce + uint64(batchSize)
	
	// Copy header to buffer
	copy(buffer, job.Header)
	
	hashCount := uint64(0)
	startTime := time.Now()
	
	for nonce := startNonce; nonce < endNonce && worker.Active.Load(); nonce++ {
		// Set nonce
		binary.LittleEndian.PutUint64(buffer[76:], nonce)
		
		// Calculate hash
		hash := e.algorithm.Hash(buffer)
		hashCount++
		
		// Check target
		if e.algorithm.Verify(hash, job.Target) {
			share := &Share{
				JobID:      job.ID,
				WorkerID:   worker.ID,
				Nonce:      nonce,
				Hash:       hash,
				Difficulty: job.Difficulty,
				Valid:      true,
				Timestamp:  time.Now(),
			}
			
			// Submit share
			select {
			case e.shares <- share:
				worker.Shares.Add(1)
			default:
				// Share queue full
			}
		}
		
		// Update hashrate periodically
		if hashCount%10000 == 0 {
			elapsed := time.Since(startTime).Seconds()
			if elapsed > 0 {
				hashrate := uint64(float64(hashCount) / elapsed)
				worker.Hashrate.Store(hashrate)
			}
		}
	}
}

func (e *Engine) processShares() {
	defer e.wg.Done()
	
	for {
		select {
		case <-e.ctx.Done():
			return
			
		case share := <-e.shares:
			if share == nil {
				continue
			}
			
			// Update statistics
			if share.Valid {
				e.stats.SharesAccepted.Add(1)
				e.stats.LastShare.Store(time.Now().Unix())
				
				// Check if it's a block
				if share.Difficulty > 1000000000 {
					e.stats.BlocksFound.Add(1)
				}
			} else {
				e.stats.SharesRejected.Add(1)
			}
		}
	}
}

func (e *Engine) reportStats() {
	defer e.wg.Done()
	
	ticker := time.NewTicker(StatsInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-e.ctx.Done():
			return
			
		case <-ticker.C:
			e.updateStats()
		}
	}
}

func (e *Engine) updateStats() {
	// Calculate total hashrate
	totalHashrate := uint64(0)
	totalPower := uint32(0)
	maxTemp := uint32(0)
	
	for _, worker := range e.workers {
		if worker.Active.Load() {
			totalHashrate += worker.Hashrate.Load()
			totalPower += worker.Power.Load()
			
			temp := worker.Temp.Load()
			if temp > maxTemp {
				maxTemp = temp
			}
		}
	}
	
	e.stats.Hashrate.Store(totalHashrate)
	e.metrics.PowerUsage.Store(totalPower)
	e.metrics.Temperature.Store(maxTemp)
	
	// Calculate efficiency
	if totalPower > 0 {
		efficiency := (totalHashrate * 100) / uint64(totalPower)
		e.metrics.Efficiency.Store(efficiency)
	}
	
	// Update uptime
	uptime := int64(time.Since(e.stats.StartTime).Seconds())
	e.stats.Uptime.Store(uptime)
}

func (e *Engine) runOptimizer() {
	defer e.wg.Done()
	
	ticker := time.NewTicker(OptimizeInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-e.ctx.Done():
			return
			
		case <-ticker.C:
			e.optimize()
		}
	}
}

func (e *Engine) optimize() {
	if e.optimizer == nil {
		return
	}
	
	temp := float64(e.metrics.Temperature.Load()) / 100.0
	power := float64(e.metrics.PowerUsage.Load()) / 100.0
	
	// Temperature-based optimization
	if temp > e.config.TargetTemp {
		e.optimizer.reducePower()
	} else if temp < e.config.TargetTemp-10 {
		e.optimizer.increasePower()
	}
	
	// Power limit enforcement
	if power > e.config.MaxPower {
		e.optimizer.enforcePowerLimit()
	}
	
	// Auto-switch algorithm if enabled
	if e.config.AutoSwitch {
		e.optimizer.checkProfitability()
	}
	
	e.optimizer.lastOptimize = time.Now()
}

func (e *Engine) applySecurity() error {
	switch e.config.SecurityLevel {
	case SecurityMaximum, SecurityParanoid:
		// Enable memory encryption
		// Enable secure communication
		// Enable tamper detection
		return nil
	default:
		return nil
	}
}

func (e *Engine) setupHugePages() {
	// Platform-specific huge pages setup
	// This would be implemented per OS
}

func (e *Engine) benchmarkAlgorithm(duration time.Duration) uint64 {
	data := make([]byte, 80)
	hashes := uint64(0)
	start := time.Now()
	
	for time.Since(start) < duration {
		e.algorithm.Hash(data)
		hashes++
	}
	
	return hashes
}

func (e *Engine) countActiveWorkers() int {
	count := 0
	for _, worker := range e.workers {
		if worker.Active.Load() {
			count++
		}
	}
	return count
}

func (e *Engine) getStateString() string {
	switch EngineState(e.state.Load()) {
	case StateIdle:
		return "idle"
	case StateInitializing:
		return "initializing"
	case StateRunning:
		return "running"
	case StateStopping:
		return "stopping"
	case StateStopped:
		return "stopped"
	case StateError:
		return "error"
	default:
		return "unknown"
	}
}

// Algorithm implementations

type SHA256d struct{}

func (s *SHA256d) Name() string { return "sha256d" }

func (s *SHA256d) Hash(data []byte) []byte {
	first := sha256.Sum256(data)
	second := sha256.Sum256(first[:])
	return second[:]
}

func (s *SHA256d) Verify(hash, target []byte) bool {
	return compareTarget(hash, target)
}

func (s *SHA256d) GetDifficulty(hash []byte) float64 {
	return calculateDifficulty(hash)
}

func (s *SHA256d) OptimalBatchSize() int { return 1000000 }

type Scrypt struct{}

func (s *Scrypt) Name() string { return "scrypt" }

func (s *Scrypt) Hash(data []byte) []byte {
	// Simplified scrypt (real implementation would use proper params)
	hash, _ := scrypt.Key(data, data[:8], 1024, 1, 1, 32)
	return hash
}

func (s *Scrypt) Verify(hash, target []byte) bool {
	return compareTarget(hash, target)
}

func (s *Scrypt) GetDifficulty(hash []byte) float64 {
	return calculateDifficulty(hash)
}

func (s *Scrypt) OptimalBatchSize() int { return 10000 }

type Blake3 struct{}

func (b *Blake3) Name() string { return "blake3" }

func (b *Blake3) Hash(data []byte) []byte {
	hash := blake3.Sum256(data)
	return hash[:]
}

func (b *Blake3) Verify(hash, target []byte) bool {
	return compareTarget(hash, target)
}

func (b *Blake3) GetDifficulty(hash []byte) float64 {
	return calculateDifficulty(hash)
}

func (b *Blake3) OptimalBatchSize() int { return 2000000 }

type RandomX struct{}

func (r *RandomX) Name() string { return "randomx" }

func (r *RandomX) Hash(data []byte) []byte {
	// Simplified RandomX (real implementation would use RandomX VM)
	hash := sha256.Sum256(data)
	return hash[:]
}

func (r *RandomX) Verify(hash, target []byte) bool {
	return compareTarget(hash, target)
}

func (r *RandomX) GetDifficulty(hash []byte) float64 {
	return calculateDifficulty(hash)
}

func (r *RandomX) OptimalBatchSize() int { return 1000 }

type Ethash struct{}

func (e *Ethash) Name() string { return "ethash" }

func (e *Ethash) Hash(data []byte) []byte {
	// Simplified Ethash (real implementation would use DAG)
	hash := sha256.Sum256(data)
	return hash[:]
}

func (e *Ethash) Verify(hash, target []byte) bool {
	return compareTarget(hash, target)
}

func (e *Ethash) GetDifficulty(hash []byte) float64 {
	return calculateDifficulty(hash)
}

func (e *Ethash) OptimalBatchSize() int { return 100000 }

// Hardware management




func (h *HardwareManager) detectSIMD() {
	// Detect CPU features
	// This would use CPUID on x86 or system calls on ARM
	h.hasAVX2 = runtime.GOARCH == "amd64"
	h.hasAVX512 = false // Would check CPUID
	h.hasNEON = runtime.GOARCH == "arm64"
}

func (h *HardwareManager) detectCPU() {
	// Detect CPU devices
	numCPU := runtime.NumCPU()
	h.cpus = make([]CPUDevice, 1)
	h.cpus[0] = CPUDevice{
		ID:      "cpu0",
		Cores:   numCPU,
		Threads: numCPU,
	}
}

func (h *HardwareManager) detectGPU() {
	// Detect GPU devices
	// This would interface with CUDA/OpenCL/Vulkan
}

func (h *HardwareManager) detectASIC() {
	// Detect ASIC devices
	// This would interface with USB/Serial devices
}

// Optimizer methods

func (o *Optimizer) reducePower() {
	if o.powerMode > PowerEfficiency {
		o.powerMode--
		o.applyPowerMode()
	}
}

func (o *Optimizer) increasePower() {
	if o.powerMode < PowerInsane {
		o.powerMode++
		o.applyPowerMode()
	}
}

func (o *Optimizer) enforcePowerLimit() {
	// Reduce intensity on all workers
	for _, worker := range o.engine.workers {
		if worker.Type == DeviceGPU {
			// Reduce GPU power limit
		}
	}
}

func (o *Optimizer) checkProfitability() {
	// Check current coin profitability
	// Switch algorithm if more profitable
}

func (o *Optimizer) applyPowerMode() {
	switch o.powerMode {
	case PowerEfficiency:
		// Low power, reduced frequency
	case PowerBalanced:
		// Default settings
	case PowerPerformance:
		// Higher power limits
	case PowerTurbo:
		// Maximum stable clocks
	case PowerInsane:
		// No limits, maximum performance
	}
}

// Helper functions

func compareTarget(hash, target []byte) bool {
	if len(hash) != len(target) {
		return false
	}
	
	for i := len(hash) - 1; i >= 0; i-- {
		if hash[i] < target[i] {
			return true
		}
		if hash[i] > target[i] {
			return false
		}
	}
	return false
}

func calculateDifficulty(hash []byte) float64 {
	zeros := 0
	for _, b := range hash {
		if b == 0 {
			zeros += 8
		} else {
			for i := 7; i >= 0; i-- {
				if b&(1<<i) == 0 {
					zeros++
				} else {
					return math.Pow(2, float64(zeros))
				}
			}
		}
	}
	return math.Pow(2, float64(zeros))
}

func formatHashrate(hashrate uint64) string {
	switch {
	case hashrate >= 1e18:
		return fmt.Sprintf("%.2f EH/s", float64(hashrate)/1e18)
	case hashrate >= 1e15:
		return fmt.Sprintf("%.2f PH/s", float64(hashrate)/1e15)
	case hashrate >= 1e12:
		return fmt.Sprintf("%.2f TH/s", float64(hashrate)/1e12)
	case hashrate >= 1e9:
		return fmt.Sprintf("%.2f GH/s", float64(hashrate)/1e9)
	case hashrate >= 1e6:
		return fmt.Sprintf("%.2f MH/s", float64(hashrate)/1e6)
	case hashrate >= 1e3:
		return fmt.Sprintf("%.2f KH/s", float64(hashrate)/1e3)
	default:
		return fmt.Sprintf("%d H/s", hashrate)
	}
}

func formatEfficiency(efficiency float64) string {
	switch {
	case efficiency >= 1e12:
		return fmt.Sprintf("%.2f TH/W", efficiency/1e12)
	case efficiency >= 1e9:
		return fmt.Sprintf("%.2f GH/W", efficiency/1e9)
	case efficiency >= 1e6:
		return fmt.Sprintf("%.2f MH/W", efficiency/1e6)
	case efficiency >= 1e3:
		return fmt.Sprintf("%.2f KH/W", efficiency/1e3)
	default:
		return fmt.Sprintf("%.2f H/W", efficiency)
	}
}

func setCPUAffinity(worker *Worker, cpu int) {
	// Platform-specific CPU affinity setting
	// Would use syscall on Linux/Windows
}

// SetPowerLimit sets global power limit
func (e *Engine) SetPowerLimit(watts float64) {
	e.config.MaxPower = watts
}

// SetTemperatureLimit sets global temperature limit
func (e *Engine) SetTemperatureLimit(celsius float64) {
	e.config.TargetTemp = celsius
}

// EnableWorker enables a specific worker
func (e *Engine) EnableWorker(workerID string) error {
	for _, worker := range e.workers {
		if worker.ID == workerID {
			worker.Active.Store(true)
			return nil
		}
	}
	return fmt.Errorf("worker not found: %s", workerID)
}

// DisableWorker disables a specific worker
func (e *Engine) DisableWorker(workerID string) error {
	for _, worker := range e.workers {
		if worker.ID == workerID {
			worker.Active.Store(false)
			return nil
		}
	}
	return fmt.Errorf("worker not found: %s", workerID)
}

// GetWorkers returns all workers
func (e *Engine) GetWorkers() []*Worker {
	return e.workers
}

// OptimizeForLatency optimizes for low latency
func (e *Engine) OptimizeForLatency() {
	if e.optimizer != nil {
		e.optimizer.powerMode = PowerTurbo
		e.optimizer.applyPowerMode()
	}
}

// OptimizeForEfficiency optimizes for power efficiency
func (e *Engine) OptimizeForEfficiency() {
	if e.optimizer != nil {
		e.optimizer.powerMode = PowerEfficiency
		e.optimizer.applyPowerMode()
	}
}