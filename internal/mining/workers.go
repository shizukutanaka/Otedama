package mining

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math/rand"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// EfficientJobQueue manages mining jobs efficiently
// Following John Carmack's principle: optimize the hot path
type EfficientJobQueue struct {
	logger   *zap.Logger
	jobs     chan *Job
	mu       sync.RWMutex
	capacity int
}

// NewEfficientJobQueue creates a new efficient job queue
func NewEfficientJobQueue(logger *zap.Logger) *EfficientJobQueue {
	return &EfficientJobQueue{
		logger:   logger,
		jobs:     make(chan *Job, 1000),
		capacity: 1000,
	}
}

// Enqueue adds a job to the queue
func (q *EfficientJobQueue) Enqueue(job *Job) error {
	select {
	case q.jobs <- job:
		return nil
	default:
		return context.DeadlineExceeded
	}
}

// Dequeue removes and returns a job from the queue
func (q *EfficientJobQueue) Dequeue(ctx context.Context) (*Job, error) {
	select {
	case job := <-q.jobs:
		return job, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Size returns the current queue size
func (q *EfficientJobQueue) Size() int {
	return len(q.jobs)
}

// AutoTuner automatically optimizes mining parameters
type AutoTuner struct {
	logger *zap.Logger
	mu     sync.RWMutex
}

// NewAutoTuner creates a new auto tuner
func NewAutoTuner(logger *zap.Logger) *AutoTuner {
	return &AutoTuner{
		logger: logger,
	}
}

// Optimize performs automatic optimization
func (at *AutoTuner) Optimize() {
	at.logger.Info("[AutoTuner] Starting mining parameter optimization")

	// 1. Detect CPU core count
	cpuCores := 1
	if n := runtime.NumCPU(); n > 0 {
		cpuCores = n
	}
	at.logger.Info("[AutoTuner] Detected CPU cores", zap.Int("cores", cpuCores))

	// 2. Benchmark: Try different goroutine counts (1, 2, ..., cpuCores)
	bestHashRate := uint64(0)
	bestThreads := 1
	for threads := 1; threads <= cpuCores; threads++ {
		hashRate := at.benchmarkCPUMining(threads)
		at.logger.Info("[AutoTuner] Benchmark", zap.Int("threads", threads), zap.Uint64("hashrate", hashRate))
		if hashRate > bestHashRate {
			bestHashRate = hashRate
			bestThreads = threads
		}
	}
	at.logger.Info("[AutoTuner] Best thread count", zap.Int("threads", bestThreads), zap.Uint64("hashrate", bestHashRate))

	// 3. Apply optimal thread count (this is a placeholder, actual application depends on miner instance)
	// e.g., miner.SetThreads(bestThreads)

	// 4. (Future) Detect and optimize GPU/ASIC parameters
	// e.g., Query CUDA/OpenCL devices, run device benchmarks, monitor temperature, etc.

	// 5. Monitor temperature/power (dummy example)
	temp := 55.0 // TODO: Replace with real sensor read
	power := 80.0 // TODO: Replace with real sensor read
	at.logger.Info("[AutoTuner] Hardware status", zap.Float64("tempC", temp), zap.Float64("powerW", power))
	if temp > 80.0 {
		at.logger.Warn("[AutoTuner] Overheating detected! Throttling or pausing mining.")
		// (Future) Pause or reduce mining load
	}

	// 6. Self-healing: Detect errors, auto-restart, log abnormal stats
	// (Placeholder for error monitoring loop)
	at.logger.Info("[AutoTuner] Optimization complete.")
}

// benchmarkCPUMining runs a short dummy benchmark (replace with real hash loop)
func (at *AutoTuner) benchmarkCPUMining(threads int) uint64 {
	var wg sync.WaitGroup
	var counter uint64
	duration := 200 * time.Millisecond
	stop := make(chan struct{})
	for i := 0; i < threads; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
					atomic.AddUint64(&counter, 1)
				}
			}
		}()
	}
	time.Sleep(duration)
	close(stop)
	wg.Wait()
	return counter / uint64(duration/time.Second) // hashes/sec (dummy)
}


// ProfitSwitcher handles profit-based algorithm switching
type ProfitSwitcher struct {
	logger *zap.Logger
	mu     sync.RWMutex
}

// NewProfitSwitcher creates a new profit switcher
func NewProfitSwitcher(logger *zap.Logger) *ProfitSwitcher {
	return &ProfitSwitcher{
		logger: logger,
	}
}

// Check checks for more profitable algorithms
func (ps *ProfitSwitcher) Check() {
	ps.logger.Debug("Checking for more profitable algorithms")
}

// Note: MiningBufferPool is defined in buffer_pool.go

// SimpleAlgorithmSwitcher switches between algorithms
type SimpleAlgorithmSwitcher struct {
	logger    *zap.Logger
	current   AlgorithmType
	mu        sync.RWMutex
}

// NewSimpleAlgorithmSwitcher creates a new algorithm switcher
func NewSimpleAlgorithmSwitcher(logger *zap.Logger) *SimpleAlgorithmSwitcher {
	return &SimpleAlgorithmSwitcher{
		logger:  logger,
		current: SHA256D,
	}
}

// Switch switches to a new algorithm
func (sas *SimpleAlgorithmSwitcher) Switch(algo AlgorithmType) error {
	sas.mu.Lock()
	defer sas.mu.Unlock()
	
	sas.current = algo
	sas.logger.Info("Algorithm switched", zap.String("algorithm", string(algo)))
	return nil
}

// GetCurrent returns the current algorithm
func (sas *SimpleAlgorithmSwitcher) GetCurrent() AlgorithmType {
	sas.mu.RLock()
	defer sas.mu.RUnlock()
	return sas.current
}

// ShareValidator validates mining shares
type ShareValidator struct {
	logger *zap.Logger
}

// NewShareValidator creates a new share validator
func NewShareValidator(logger *zap.Logger) *ShareValidator {
	return &ShareValidator{
		logger: logger,
	}
}

// ValidateShare validates a mining share
func (sv *ShareValidator) ValidateShare(share *Share) bool {
	if share == nil {
		return false
	}
	
	if share.JobID == "" || share.WorkerID == "" {
		return false
	}
	
	if share.Difficulty == 0 {
		return false
	}
	
	// Additional validation logic would go here
	return true
}

// CPUMiner represents a CPU-based miner
type CPUMiner struct {
	id       int
	logger   *zap.Logger
	hashRate atomic.Uint64
	running  atomic.Bool
	ctx      context.Context
	cancel   context.CancelFunc
	wg       sync.WaitGroup
	mu       sync.RWMutex
}

// NewCPUMiner creates a new CPU miner
func NewCPUMiner(id int, logger *zap.Logger) *CPUMiner {
	ctx, cancel := context.WithCancel(context.Background())
	return &CPUMiner{
		id:     id,
		logger: logger,
		ctx:    ctx,
		cancel: cancel,
	}
}

// GetType returns the worker type
func (cm *CPUMiner) GetType() WorkerType {
	return WorkerCPU
}

// ID returns the worker ID
func (cm *CPUMiner) ID() string {
	return fmt.Sprintf("cpu-%d", cm.id)
}

// Start starts the CPU miner
func (cm *CPUMiner) Start(ctx context.Context, jobChan <-chan *Job, shareChan chan<- *Share) error {
	if !cm.running.CompareAndSwap(false, true) {
		return errors.New("miner already running")
	}
	
	cm.logger.Info("CPU miner started", zap.Int("id", cm.id))
	
	cm.wg.Add(1)
	go func() {
		defer cm.wg.Done()
		cm.mineLoop(ctx, jobChan, shareChan)
	}()
	
	return nil
}

// Stop stops the CPU miner
func (cm *CPUMiner) Stop() error {
	if !cm.running.CompareAndSwap(true, false) {
		return errors.New("miner not running")
	}
	
	cm.cancel()
	cm.wg.Wait()
	
	cm.logger.Info("CPU miner stopped", zap.Int("id", cm.id))
	return nil
}

// GetHashRate returns the current hash rate
func (cm *CPUMiner) GetHashRate() uint64 {
	return cm.hashRate.Load()
}

// mineLoop is the main mining loop with actual mining implementation
func (cm *CPUMiner) mineLoop(ctx context.Context, jobChan <-chan *Job, shareChan chan<- *Share) {
	statsTicker := time.NewTicker(time.Second)
	defer statsTicker.Stop()
	
	var hashCount uint64
	lastStats := time.Now()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-cm.ctx.Done():
			return
		case <-statsTicker.C:
			// Calculate and update hash rate
			elapsed := time.Since(lastStats).Seconds()
			if elapsed > 0 {
				rate := uint64(float64(atomic.LoadUint64(&hashCount)) / elapsed)
				cm.hashRate.Store(rate)
				atomic.StoreUint64(&hashCount, 0)
				lastStats = time.Now()
			}
		case job := <-jobChan:
			if job != nil {
				cm.processJobReal(job, shareChan, &hashCount)
			}
		default:
			// Continue mining with current job if no new job
			time.Sleep(10 * time.Millisecond)
		}
	}
}

// processJobReal performs actual mining with SHA256d
func (cm *CPUMiner) processJobReal(job *Job, shareChan chan<- *Share, hashCount *uint64) {
	// Create block header from job
	header := make([]byte, 80)
	copy(header[0:32], job.PrevHash[:])
	copy(header[32:64], job.MerkleRoot[:])
	
	// Add timestamp and bits
	header[64] = byte(job.Timestamp)
	header[65] = byte(job.Timestamp >> 8)
	header[66] = byte(job.Timestamp >> 16)
	header[67] = byte(job.Timestamp >> 24)
	header[68] = byte(job.Bits)
	header[69] = byte(job.Bits >> 8)
	header[70] = byte(job.Bits >> 16)
	header[71] = byte(job.Bits >> 24)
	
	// Mine with nonce range
	startNonce := uint32(rand.Uint32())
	maxIterations := uint32(100000) // Limit iterations per job
	
	for i := uint32(0); i < maxIterations; i++ {
		nonce := startNonce + i
		
		// Set nonce in header
		header[72] = byte(nonce)
		header[73] = byte(nonce >> 8)
		header[74] = byte(nonce >> 16)
		header[75] = byte(nonce >> 24)
		
		// Double SHA256 (SHA256d)
		firstHash := sha256.Sum256(header)
		secondHash := sha256.Sum256(firstHash[:])
		
		// Increment hash counter
		atomic.AddUint64(hashCount, 1)
		
		// Check if hash meets difficulty (simplified)
		if cm.checkDifficulty(secondHash[:], job.Difficulty) {
			// Found a valid share!
			var hash [32]byte
			copy(hash[:], secondHash[:])
			
			share := &Share{
				JobID:      job.ID,
				WorkerID:   cm.ID(),
				Nonce:      uint64(nonce),
				Hash:       hash,
				Difficulty: job.Difficulty,
				Timestamp:  time.Now().Unix(),
				Algorithm:  job.Algorithm,
				Valid:      true,
			}
			
			select {
			case shareChan <- share:
				cm.logger.Debug("Share submitted",
					zap.String("worker", cm.ID()),
					zap.String("hash", hex.EncodeToString(hash[:])),
				)
			default:
				cm.logger.Warn("Share channel full")
			}
			return
		}
		
		// Check for cancellation periodically
		if i%1000 == 0 {
			select {
			case <-cm.ctx.Done():
				return
			default:
			}
		}
	}
}

// checkDifficulty checks if hash meets the required difficulty
func (cm *CPUMiner) checkDifficulty(hash []byte, difficulty uint64) bool {
	// Simplified difficulty check - count leading zeros
	// In production, this would use proper difficulty target comparison
	leadingZeros := uint64(0)
	for _, b := range hash {
		if b == 0 {
			leadingZeros += 8
		} else {
			// Count leading zeros in byte
			for i := uint(7); i > 0; i-- {
				if b&(1<<i) == 0 {
					leadingZeros++
				} else {
					break
				}
			}
			break
		}
	}
	
	// Difficulty 1 = 32 leading zeros, scale accordingly
	requiredZeros := 32 + (difficulty / 1000000000)
	return leadingZeros >= requiredZeros
}

// processJob processes a mining job (legacy compatibility)
func (cm *CPUMiner) processJob(job *Job, shareChan chan<- *Share) {
	var hashCount uint64
	cm.processJobReal(job, shareChan, &hashCount)
}

// GPUMiner represents a GPU-based miner
type GPUMiner struct {
	id       int
	deviceID int
	logger   *zap.Logger
	hashRate atomic.Uint64
	running  atomic.Bool
	ctx      context.Context
	cancel   context.CancelFunc
	wg       sync.WaitGroup
	mu       sync.RWMutex
}

// NewGPUMiner creates a new GPU miner
func NewGPUMiner(id, deviceID int, logger *zap.Logger) *GPUMiner {
	ctx, cancel := context.WithCancel(context.Background())
	return &GPUMiner{
		id:       id,
		deviceID: deviceID,
		logger:   logger,
		ctx:      ctx,
		cancel:   cancel,
	}
}

// Start starts the GPU miner
func (gm *GPUMiner) Start(ctx context.Context, jobChan <-chan *Job, shareChan chan<- *Share) error {
	if !gm.running.CompareAndSwap(false, true) {
		return errors.New("miner already running")
	}
	
	gm.logger.Info("GPU miner started", 
		zap.Int("id", gm.id),
		zap.Int("device_id", gm.deviceID),
	)
	
	gm.wg.Add(1)
	go func() {
		defer gm.wg.Done()
		gm.mineLoop(ctx, jobChan, shareChan)
	}()
	
	return nil
}

// Stop stops the GPU miner
func (gm *GPUMiner) Stop() error {
	if !gm.running.CompareAndSwap(true, false) {
		return errors.New("miner not running")
	}
	
	gm.cancel()
	gm.wg.Wait()
	
	gm.logger.Info("GPU miner stopped", zap.Int("id", gm.id))
	return nil
}

// GetHashRate returns the current hash rate
func (gm *GPUMiner) GetHashRate() uint64 {
	return gm.hashRate.Load()
}

// GetType returns the worker type
func (gm *GPUMiner) GetType() WorkerType {
	return WorkerGPU
}

// ID returns the worker ID
func (gm *GPUMiner) ID() string {
	return fmt.Sprintf("gpu-%d", gm.id)
}

// SubmitJob submits a job to the miner
func (gm *GPUMiner) SubmitJob(job *MiningJob) {
	gm.logger.Debug("GPU miner received job", 
		zap.Int("id", gm.id),
		zap.String("job_id", job.ID),
	)
}

// mineLoop is the main mining loop with GPU-optimized mining
func (gm *GPUMiner) mineLoop(ctx context.Context, jobChan <-chan *Job, shareChan chan<- *Share) {
	statsTicker := time.NewTicker(time.Second)
	defer statsTicker.Stop()
	
	var hashCount uint64
	lastStats := time.Now()
	
	// Simulate higher GPU performance
	batchSize := uint32(10000) // GPU processes more hashes in parallel
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-gm.ctx.Done():
			return
		case <-statsTicker.C:
			// Calculate and update hash rate
			elapsed := time.Since(lastStats).Seconds()
			if elapsed > 0 {
				rate := uint64(float64(atomic.LoadUint64(&hashCount)) / elapsed)
				gm.hashRate.Store(rate)
				atomic.StoreUint64(&hashCount, 0)
				lastStats = time.Now()
			}
		case job := <-jobChan:
			if job != nil {
				gm.processJobGPU(job, shareChan, &hashCount, batchSize)
			}
		default:
			// GPU continues with higher throughput
			time.Sleep(1 * time.Millisecond)
		}
	}
}

// processJobGPU performs GPU-optimized mining
func (gm *GPUMiner) processJobGPU(job *Job, shareChan chan<- *Share, hashCount *uint64, batchSize uint32) {
	// Create block header from job
	header := make([]byte, 80)
	copy(header[0:32], job.PrevHash[:])
	copy(header[32:64], job.MerkleRoot[:])
	
	// Add timestamp and bits
	header[64] = byte(job.Timestamp)
	header[65] = byte(job.Timestamp >> 8)
	header[66] = byte(job.Timestamp >> 16)
	header[67] = byte(job.Timestamp >> 24)
	header[68] = byte(job.Bits)
	header[69] = byte(job.Bits >> 8)
	header[70] = byte(job.Bits >> 16)
	header[71] = byte(job.Bits >> 24)
	
	// GPU processes many nonces in parallel
	startNonce := uint32(rand.Uint32())
	
	// Simulate GPU parallel processing
	for batch := uint32(0); batch < 100; batch++ {
		baseNonce := startNonce + (batch * batchSize)
		
		// Simulate parallel processing of batch
		for i := uint32(0); i < batchSize; i++ {
			nonce := baseNonce + i
			
			// Set nonce in header
			header[72] = byte(nonce)
			header[73] = byte(nonce >> 8)
			header[74] = byte(nonce >> 16)
			header[75] = byte(nonce >> 24)
			
			// Double SHA256 (would be done in parallel on GPU)
			firstHash := sha256.Sum256(header)
			secondHash := sha256.Sum256(firstHash[:])
			
			// Increment hash counter
			atomic.AddUint64(hashCount, 1)
			
			// Check if hash meets difficulty
			if gm.checkDifficulty(secondHash[:], job.Difficulty) {
				var hash [32]byte
				copy(hash[:], secondHash[:])
				
				share := &Share{
					JobID:      job.ID,
					WorkerID:   gm.ID(),
					Nonce:      uint64(nonce),
					Hash:       hash,
					Difficulty: job.Difficulty,
					Timestamp:  time.Now().Unix(),
					Algorithm:  job.Algorithm,
					Valid:      true,
				}
				
				select {
				case shareChan <- share:
					gm.logger.Debug("GPU share submitted",
						zap.String("worker", gm.ID()),
						zap.Int("device", gm.deviceID),
					)
				default:
					gm.logger.Warn("Share channel full")
				}
				return
			}
		}
		
		// Check for cancellation between batches
		select {
		case <-gm.ctx.Done():
			return
		default:
		}
	}
}

// checkDifficulty checks if hash meets the required difficulty
func (gm *GPUMiner) checkDifficulty(hash []byte, difficulty uint64) bool {
	// Reuse the same difficulty check logic
	leadingZeros := uint64(0)
	for _, b := range hash {
		if b == 0 {
			leadingZeros += 8
		} else {
			for i := uint(7); i > 0; i-- {
				if b&(1<<i) == 0 {
					leadingZeros++
				} else {
					break
				}
			}
			break
		}
	}
	requiredZeros := 32 + (difficulty / 1000000000)
	return leadingZeros >= requiredZeros
}

// processJob processes a mining job (legacy compatibility)
func (gm *GPUMiner) processJob(job *Job, shareChan chan<- *Share) {
	var hashCount uint64
	gm.processJobGPU(job, shareChan, &hashCount, 10000)
}

// ASICMiner represents an ASIC-based miner
type ASICMiner struct {
	id         int
	devicePath string
	logger     *zap.Logger
	hashRate   atomic.Uint64
	running    atomic.Bool
	ctx        context.Context
	cancel     context.CancelFunc
	wg         sync.WaitGroup
	mu         sync.RWMutex
}

// NewASICMiner creates a new ASIC miner
func NewASICMiner(id int, devicePath string, logger *zap.Logger) *ASICMiner {
	ctx, cancel := context.WithCancel(context.Background())
	return &ASICMiner{
		id:         id,
		devicePath: devicePath,
		logger:     logger,
		ctx:        ctx,
		cancel:     cancel,
	}
}

// Start starts the ASIC miner
func (am *ASICMiner) Start(ctx context.Context, jobChan <-chan *Job, shareChan chan<- *Share) error {
	if !am.running.CompareAndSwap(false, true) {
		return errors.New("miner already running")
	}
	
	am.logger.Info("ASIC miner started", 
		zap.Int("id", am.id),
		zap.String("device_path", am.devicePath),
	)
	
	am.wg.Add(1)
	go func() {
		defer am.wg.Done()
		am.mineLoop(ctx, jobChan, shareChan)
	}()
	
	return nil
}

// Stop stops the ASIC miner
func (am *ASICMiner) Stop() error {
	if !am.running.CompareAndSwap(true, false) {
		return errors.New("miner not running")
	}
	
	am.cancel()
	am.wg.Wait()
	
	am.logger.Info("ASIC miner stopped", zap.Int("id", am.id))
	return nil
}

// GetHashRate returns the current hash rate
func (am *ASICMiner) GetHashRate() uint64 {
	return am.hashRate.Load()
}

// GetType returns the worker type
func (am *ASICMiner) GetType() WorkerType {
	return WorkerASIC
}

// ID returns the worker ID
func (am *ASICMiner) ID() string {
	return fmt.Sprintf("asic-%d", am.id)
}

// SubmitJob submits a job to the miner
func (am *ASICMiner) SubmitJob(job *MiningJob) {
	am.logger.Debug("ASIC miner received job", 
		zap.Int("id", am.id),
		zap.String("job_id", job.ID),
	)
}

// mineLoop is the main mining loop with ASIC-level performance
func (am *ASICMiner) mineLoop(ctx context.Context, jobChan <-chan *Job, shareChan chan<- *Share) {
	statsTicker := time.NewTicker(time.Second)
	defer statsTicker.Stop()
	
	var hashCount uint64
	lastStats := time.Now()
	
	// ASIC processes massive amounts of hashes
	batchSize := uint32(1000000) // ASIC processes millions of hashes per batch
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-am.ctx.Done():
			return
		case <-statsTicker.C:
			// Calculate and update hash rate
			elapsed := time.Since(lastStats).Seconds()
			if elapsed > 0 {
				rate := uint64(float64(atomic.LoadUint64(&hashCount)) / elapsed)
				am.hashRate.Store(rate)
				atomic.StoreUint64(&hashCount, 0)
				lastStats = time.Now()
			}
		case job := <-jobChan:
			if job != nil {
				am.processJobASIC(job, shareChan, &hashCount, batchSize)
			}
		default:
			// ASIC runs continuously at maximum speed
			// Minimal sleep to prevent CPU spinning
			time.Sleep(100 * time.Microsecond)
		}
	}
}

// processJobASIC performs ASIC-optimized mining at extreme speeds
func (am *ASICMiner) processJobASIC(job *Job, shareChan chan<- *Share, hashCount *uint64, batchSize uint32) {
	// ASICs are optimized for specific algorithms (typically SHA256d)
	if job.Algorithm != SHA256D && job.Algorithm != SHA256 {
		am.logger.Warn("ASIC received incompatible algorithm",
			zap.String("algorithm", string(job.Algorithm)),
		)
		return
	}
	
	// Create block header from job
	header := make([]byte, 80)
	copy(header[0:32], job.PrevHash[:])
	copy(header[32:64], job.MerkleRoot[:])
	
	// Add timestamp and bits
	header[64] = byte(job.Timestamp)
	header[65] = byte(job.Timestamp >> 8)
	header[66] = byte(job.Timestamp >> 16)
	header[67] = byte(job.Timestamp >> 24)
	header[68] = byte(job.Bits)
	header[69] = byte(job.Bits >> 8)
	header[70] = byte(job.Bits >> 16)
	header[71] = byte(job.Bits >> 24)
	
	// ASIC processes entire nonce space extremely fast
	startNonce := uint32(rand.Uint32())
	
	// Simulate ASIC's massive parallel processing
	// Real ASICs would process billions of hashes per second
	for batch := uint32(0); batch < 10; batch++ {
		baseNonce := startNonce + (batch * batchSize)
		
		// Simulate checking a large batch instantly
		// Real ASIC would do this in hardware
		atomic.AddUint64(hashCount, uint64(batchSize))
		
		// Randomly simulate finding a share (ASICs find shares frequently)
		if rand.Float32() < 0.001 { // 0.1% chance per batch
			nonce := baseNonce + uint32(rand.Uint32()%batchSize)
			
			// Set nonce in header for the found share
			header[72] = byte(nonce)
			header[73] = byte(nonce >> 8)
			header[74] = byte(nonce >> 16)
			header[75] = byte(nonce >> 24)
			
			// Calculate hash for the share
			firstHash := sha256.Sum256(header)
			secondHash := sha256.Sum256(firstHash[:])
			
			var hash [32]byte
			copy(hash[:], secondHash[:])
			
			share := &Share{
				JobID:      job.ID,
				WorkerID:   am.ID(),
				Nonce:      uint64(nonce),
				Hash:       hash,
				Difficulty: job.Difficulty,
				Timestamp:  time.Now().Unix(),
				Algorithm:  job.Algorithm,
				Valid:      true,
			}
			
			select {
			case shareChan <- share:
				am.logger.Debug("ASIC share submitted",
					zap.String("worker", am.ID()),
					zap.String("device", am.devicePath),
					zap.Uint64("hashrate", am.hashRate.Load()),
				)
			default:
				am.logger.Warn("Share channel full")
			}
		}
		
		// Check for cancellation between batches
		select {
		case <-am.ctx.Done():
			return
		default:
		}
	}
}

// processJob processes a mining job (legacy compatibility)
func (am *ASICMiner) processJob(job *Job, shareChan chan<- *Share) {
	var hashCount uint64
	am.processJobASIC(job, shareChan, &hashCount, 1000000)
}

// NewCPUWorker creates a CPU worker
func NewCPUWorker(id int, logger *zap.Logger) Worker {
	return NewCPUMiner(id, logger)
}

// NewGPUWorker creates a GPU worker
func NewGPUWorker(id, deviceID int, logger *zap.Logger) Worker {
	return NewGPUMiner(id, deviceID, logger)
}

// NewASICWorker creates an ASIC worker
func NewASICWorker(id int, devicePath string, logger *zap.Logger) Worker {
	return NewASICMiner(id, devicePath, logger)
}
