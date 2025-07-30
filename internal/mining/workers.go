package mining

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"runtime"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// CPUWorker implements CPU mining - John Carmack's performance optimization
type CPUWorker struct {
	id         int
	logger     *zap.Logger
	
	// Performance tracking - atomic for lock-free access
	hashRate   atomic.Uint64
	hashes     atomic.Uint64
	lastUpdate atomic.Int64
	
	// Control
	running    atomic.Bool
	ctx        context.Context
	cancel     context.CancelFunc
}

// NewCPUWorker creates optimized CPU worker
func NewCPUWorker(id int, logger *zap.Logger) Worker {
	return &CPUWorker{
		id:     id,
		logger: logger.With(zap.String("worker", fmt.Sprintf("cpu-%d", id))),
	}
}

// Start starts the CPU worker - Rob Pike's clear interface
func (w *CPUWorker) Start(ctx context.Context, jobs <-chan *Job, shares chan<- *Share) error {
	if !w.running.CompareAndSwap(false, true) {
		return fmt.Errorf("worker already running")
	}
	
	w.ctx, w.cancel = context.WithCancel(ctx)
	
	// Start hash rate updater
	go w.hashRateUpdater()
	
	// Start main mining loop
	go w.miningLoop(jobs, shares)
	
	w.logger.Debug("CPU worker started")
	return nil
}

// Stop stops the CPU worker
func (w *CPUWorker) Stop() error {
	if !w.running.CompareAndSwap(true, false) {
		return fmt.Errorf("worker not running")
	}
	
	if w.cancel != nil {
		w.cancel()
	}
	
	w.logger.Debug("CPU worker stopped")
	return nil
}

// GetHashRate returns current hash rate - lock-free
func (w *CPUWorker) GetHashRate() uint64 {
	return w.hashRate.Load()
}

// GetType returns worker type
func (w *CPUWorker) GetType() WorkerType {
	return WorkerCPU
}

// ID returns worker identifier
func (w *CPUWorker) ID() string {
	return fmt.Sprintf("cpu-%d", w.id)
}

// miningLoop is the main mining loop - optimized hot path
func (w *CPUWorker) miningLoop(jobs <-chan *Job, shares chan<- *Share) {
	buffer := make([]byte, 80) // Pre-allocated buffer
	
	for {
		select {
		case job, ok := <-jobs:
			if !ok {
				return
			}
			
			// Mine the job
			if share := w.mineJob(job, buffer); share != nil {
				select {
				case shares <- share:
					// Share submitted
				case <-w.ctx.Done():
					return
				}
			}
			
		case <-w.ctx.Done():
			return
		}
	}
}

// mineJob mines a single job - CPU-optimized implementation
func (w *CPUWorker) mineJob(job *Job, buffer []byte) *Share {
	// Prepare block header
	w.prepareHeader(job, buffer)
	
	// Mining parameters
	const batchSize = 1000000 // Process in batches
	startNonce := uint32(w.id * batchSize)
	
	// Mine in batches
	for batch := 0; batch < 1000; batch++ { // Limit to prevent blocking
		select {
		case <-w.ctx.Done():
			return nil
		default:
		}
		
		baseNonce := startNonce + uint32(batch*batchSize)
		
		if share := w.mineBatch(job, buffer, baseNonce, batchSize); share != nil {
			return share
		}
	}
	
	return nil
}

// mineBatch mines a batch of nonces - vectorized where possible
func (w *CPUWorker) mineBatch(job *Job, buffer []byte, startNonce uint32, count int) *Share {
	target := calculateTarget(job.Bits)
	
	for i := 0; i < count; i++ {
		nonce := startNonce + uint32(i)
		
		// Update nonce in buffer
		binary.LittleEndian.PutUint32(buffer[76:80], nonce)
		
		// Double SHA-256
		hash1 := sha256.Sum256(buffer)
		hash2 := sha256.Sum256(hash1[:])
		
		// Update hash counter
		w.hashes.Add(1)
		
		// Check if hash meets target
		if w.checkTarget(hash2[:], target) {
			return &Share{
				JobID:     job.ID,
				WorkerID:  w.ID(),
				Nonce:     uint64(nonce),
				Hash:      hash2,
				Timestamp: time.Now().Unix(),
				Algorithm: job.Algorithm,
				Valid:     true,
			}
		}
		
		// Periodic context check
		if i%10000 == 0 {
			select {
			case <-w.ctx.Done():
				return nil
			default:
			}
		}
	}
	
	return nil
}

// prepareHeader prepares block header for mining
func (w *CPUWorker) prepareHeader(job *Job, buffer []byte) {
	// Version (4 bytes)
	binary.LittleEndian.PutUint32(buffer[0:4], 0x20000000)
	
	// Previous block hash (32 bytes)
	copy(buffer[4:36], job.PrevHash[:])
	
	// Merkle root (32 bytes)
	copy(buffer[36:68], job.MerkleRoot[:])
	
	// Timestamp (4 bytes)
	binary.LittleEndian.PutUint32(buffer[68:72], job.Timestamp)
	
	// Bits/Target (4 bytes)
	binary.LittleEndian.PutUint32(buffer[72:76], job.Bits)
	
	// Nonce will be updated during mining (4 bytes at offset 76)
}

// checkTarget checks if hash meets difficulty target
func (w *CPUWorker) checkTarget(hash []byte, target []byte) bool {
	// Compare hash with target (little-endian)
	for i := 31; i >= 0; i-- {
		if hash[i] > target[i] {
			return false
		} else if hash[i] < target[i] {
			return true
		}
	}
	return true
}

// hashRateUpdater updates hash rate statistics
func (w *CPUWorker) hashRateUpdater() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	
	lastHashes := uint64(0)
	
	for {
		select {
		case <-ticker.C:
			currentHashes := w.hashes.Load()
			hashRate := currentHashes - lastHashes
			w.hashRate.Store(hashRate)
			lastHashes = currentHashes
			w.lastUpdate.Store(time.Now().Unix())
			
		case <-w.ctx.Done():
			return
		}
	}
}

// GPUWorker implements GPU mining - placeholder for GPU implementation
type GPUWorker struct {
	id       int
	deviceID int
	logger   *zap.Logger
	
	hashRate atomic.Uint64
	running  atomic.Bool
	ctx      context.Context
	cancel   context.CancelFunc
}

// NewGPUWorker creates GPU worker
func NewGPUWorker(id, deviceID int, logger *zap.Logger) Worker {
	return &GPUWorker{
		id:       id,
		deviceID: deviceID,
		logger:   logger.With(zap.String("worker", fmt.Sprintf("gpu-%d", id))),
	}
}

// Start starts GPU worker - placeholder implementation
func (w *GPUWorker) Start(ctx context.Context, jobs <-chan *Job, shares chan<- *Share) error {
	if !w.running.CompareAndSwap(false, true) {
		return fmt.Errorf("worker already running")
	}
	
	w.ctx, w.cancel = context.WithCancel(ctx)
	
	// GPU initialization would go here
	w.logger.Info("GPU worker started", zap.Int("device", w.deviceID))
	
	// Placeholder: simulate GPU mining
	go w.simulateGPUMining(jobs, shares)
	
	return nil
}

// Stop stops GPU worker
func (w *GPUWorker) Stop() error {
	if !w.running.CompareAndSwap(true, false) {
		return fmt.Errorf("worker not running")
	}
	
	if w.cancel != nil {
		w.cancel()
	}
	
	w.logger.Info("GPU worker stopped")
	return nil
}

// GetHashRate returns GPU hash rate
func (w *GPUWorker) GetHashRate() uint64 {
	return w.hashRate.Load()
}

// GetType returns worker type
func (w *GPUWorker) GetType() WorkerType {
	return WorkerGPU
}

// ID returns worker identifier
func (w *GPUWorker) ID() string {
	return fmt.Sprintf("gpu-%d-%d", w.id, w.deviceID)
}

// simulateGPUMining simulates GPU mining for testing
func (w *GPUWorker) simulateGPUMining(jobs <-chan *Job, shares chan<- *Share) {
	// Simulate GPU hash rate (much higher than CPU)
	simulatedRate := uint64(100000000) // 100 MH/s
	w.hashRate.Store(simulatedRate)
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case job, ok := <-jobs:
			if !ok {
				return
			}
			
			// Simulate finding a share occasionally
			if time.Now().Unix()%10 == 0 {
				share := &Share{
					JobID:     job.ID,
					WorkerID:  w.ID(),
					Nonce:     uint64(time.Now().UnixNano()),
					Timestamp: time.Now().Unix(),
					Algorithm: job.Algorithm,
					Valid:     true,
				}
				
				select {
				case shares <- share:
				case <-w.ctx.Done():
					return
				}
			}
			
		case <-w.ctx.Done():
			return
		}
	}
}

// ASICWorker implements ASIC mining - placeholder for ASIC implementation
type ASICWorker struct {
	id         int
	devicePath string
	logger     *zap.Logger
	
	hashRate atomic.Uint64
	running  atomic.Bool
	ctx      context.Context
	cancel   context.CancelFunc
}

// NewASICWorker creates ASIC worker
func NewASICWorker(id int, devicePath string, logger *zap.Logger) Worker {
	return &ASICWorker{
		id:         id,
		devicePath: devicePath,
		logger:     logger.With(zap.String("worker", fmt.Sprintf("asic-%d", id))),
	}
}

// Start starts ASIC worker
func (w *ASICWorker) Start(ctx context.Context, jobs <-chan *Job, shares chan<- *Share) error {
	if !w.running.CompareAndSwap(false, true) {
		return fmt.Errorf("worker already running")
	}
	
	w.ctx, w.cancel = context.WithCancel(ctx)
	
	w.logger.Info("ASIC worker started", zap.String("device", w.devicePath))
	
	// Placeholder: simulate ASIC mining
	go w.simulateASICMining(jobs, shares)
	
	return nil
}

// Stop stops ASIC worker
func (w *ASICWorker) Stop() error {
	if !w.running.CompareAndSwap(true, false) {
		return fmt.Errorf("worker not running")
	}
	
	if w.cancel != nil {
		w.cancel()
	}
	
	w.logger.Info("ASIC worker stopped")
	return nil
}

// GetHashRate returns ASIC hash rate
func (w *ASICWorker) GetHashRate() uint64 {
	return w.hashRate.Load()
}

// GetType returns worker type
func (w *ASICWorker) GetType() WorkerType {
	return WorkerASIC
}

// ID returns worker identifier
func (w *ASICWorker) ID() string {
	return fmt.Sprintf("asic-%d", w.id)
}

// simulateASICMining simulates ASIC mining for testing
func (w *ASICWorker) simulateASICMining(jobs <-chan *Job, shares chan<- *Share) {
	// Simulate ASIC hash rate (very high)
	simulatedRate := uint64(100000000000) // 100 GH/s
	w.hashRate.Store(simulatedRate)
	
	for {
		select {
		case job, ok := <-jobs:
			if !ok {
				return
			}
			
			// Simulate finding shares frequently
			if time.Now().Unix()%5 == 0 {
				share := &Share{
					JobID:     job.ID,
					WorkerID:  w.ID(),
					Nonce:     uint64(time.Now().UnixNano()),
					Timestamp: time.Now().Unix(),
					Algorithm: job.Algorithm,
					Valid:     true,
				}
				
				select {
				case shares <- share:
				case <-w.ctx.Done():
					return
				}
			}
			
		case <-w.ctx.Done():
			return
		}
	}
}

// AlgorithmSwitcher handles algorithm switching
type AlgorithmSwitcher struct {
	logger        *zap.Logger
	current       atomic.Value // stores Algorithm
	profitability map[Algorithm]float64
	lastSwitch    time.Time
}

// NewAlgorithmSwitcher creates algorithm switcher
func NewAlgorithmSwitcher(logger *zap.Logger) *AlgorithmSwitcher {
	switcher := &AlgorithmSwitcher{
		logger:        logger,
		profitability: make(map[Algorithm]float64),
		lastSwitch:    time.Now(),
	}
	
	// Set default algorithm
	switcher.current.Store(AlgorithmSHA256d)
	
	// Initialize profitability data
	switcher.profitability[AlgorithmSHA256d] = 1.0
	switcher.profitability[AlgorithmScrypt] = 0.8
	switcher.profitability[AlgorithmEthash] = 1.2
	switcher.profitability[AlgorithmRandomX] = 0.9
	switcher.profitability[AlgorithmKawPow] = 1.1
	
	return switcher
}

// Switch switches to new algorithm
func (as *AlgorithmSwitcher) Switch(algo Algorithm) error {
	if as.current.Load().(Algorithm) == algo {
		return nil
	}
	
	as.logger.Info("Switching algorithm", zap.String("algorithm", string(algo)))
	as.current.Store(algo)
	as.lastSwitch = time.Now()
	
	return nil
}

// GetCurrentAlgorithm returns current algorithm
func (as *AlgorithmSwitcher) GetCurrentAlgorithm() Algorithm {
	return as.current.Load().(Algorithm)
}

// GetBestAlgorithm returns most profitable algorithm
func (as *AlgorithmSwitcher) GetBestAlgorithm() Algorithm {
	// Prevent frequent switching
	if time.Since(as.lastSwitch) < 5*time.Minute {
		return as.current.Load().(Algorithm)
	}
	
	bestAlgo := AlgorithmSHA256d
	bestProfit := 0.0
	
	for algo, profit := range as.profitability {
		if profit > bestProfit {
			bestProfit = profit
			bestAlgo = algo
		}
	}
	
	return bestAlgo
}

// Utility functions

// calculateTarget calculates mining target from bits
func calculateTarget(bits uint32) []byte {
	target := make([]byte, 32)
	
	// Extract exponent and mantissa
	exponent := bits >> 24
	mantissa := bits & 0x00ffffff
	
	// Calculate target
	if exponent <= 3 {
		mantissa >>= (8 * (3 - exponent))
		binary.LittleEndian.PutUint32(target, mantissa)
	} else {
		binary.LittleEndian.PutUint32(target[exponent-3:], mantissa)
	}
	
	return target
}

// Hardware detection and optimization
func init() {
	// Set optimal GOMAXPROCS for mining
	if runtime.GOMAXPROCS(0) < runtime.NumCPU() {
		runtime.GOMAXPROCS(runtime.NumCPU())
	}
	
	// Enable optimizations
	runtime.GC() // Clean start
}
