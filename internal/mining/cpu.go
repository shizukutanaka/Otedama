package mining

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// CPUMiner represents a CPU mining worker - optimized for performance
type CPUMiner struct {
	ID       int
	logger   *zap.Logger
	
	// Hot data - frequently accessed, cache-aligned
	hashRate    atomic.Uint64
	validShares atomic.Uint64
	running     atomic.Bool
	paused      atomic.Bool
	
	// Cold data - less frequently accessed
	ctx    context.Context
	cancel context.CancelFunc
	
	// Work data
	currentWork atomic.Value // stores *MiningJob
	difficulty  atomic.Uint32
	
	// Thread management
	wg sync.WaitGroup
}

// CPUEngine provides CPU mining capability - simplified interface
type CPUEngine struct {
	logger   *zap.Logger
	miners   []*CPUMiner
	config   CPUConfig
	running  atomic.Bool
	
	// Aggregated metrics
	totalHashRate   atomic.Uint64
	totalShares     atomic.Uint64
}

// CPUConfig defines CPU mining configuration
type CPUConfig struct {
	Algorithm   string `yaml:"algorithm"`
	Threads     int    `yaml:"threads"`
	CPUAffinity []int  `yaml:"cpu_affinity"`
}

// MiningJob represents a unit of mining work
type MiningJob struct {
	ID        string
	Algorithm Algorithm
	Data      []byte
	Target    []byte
	Height    uint64
	Timestamp time.Time
}

// Share represents a valid mining share
type Share struct {
	JobID      string
	Nonce      uint64
	Hash       []byte
	Difficulty uint64
	Timestamp  int64
}

// NewCPUMiner creates a new CPU miner worker
func NewCPUMiner(id int, logger *zap.Logger) *CPUMiner {
	ctx, cancel := context.WithCancel(context.Background())
	
	return &CPUMiner{
		ID:     id,
		logger: logger,
		ctx:    ctx,
		cancel: cancel,
	}
}

// Start begins CPU mining
func (m *CPUMiner) Start() error {
	if !m.running.CompareAndSwap(false, true) {
		return nil // Already running
	}
	
	m.wg.Add(1)
	go m.miningLoop()
	
	m.logger.Debug("CPU miner started", zap.Int("id", m.ID))
	return nil
}

// Stop halts CPU mining
func (m *CPUMiner) Stop() {
	if !m.running.CompareAndSwap(true, false) {
		return // Already stopped
	}
	
	m.cancel()
	m.wg.Wait()
	
	m.logger.Debug("CPU miner stopped", zap.Int("id", m.ID))
}

// Pause temporarily pauses mining
func (m *CPUMiner) Pause() {
	m.paused.Store(true)
}

// Resume resumes mining
func (m *CPUMiner) Resume() {
	m.paused.Store(false)
}

// SubmitJob submits new mining work
func (m *CPUMiner) SubmitJob(job *MiningJob) {
	m.currentWork.Store(job)
}

// GetHashRate returns current hash rate
func (m *CPUMiner) GetHashRate() uint64 {
	return m.hashRate.Load()
}

// miningLoop is the core mining loop - highly optimized
func (m *CPUMiner) miningLoop() {
	defer m.wg.Done()
	
	var nonce uint64
	var hashes uint64
	buffer := make([]byte, 80) // Standard block header size
	
	// Performance: batch hash reporting
	const batchSize = 100000
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	
	for m.running.Load() {
		// Check for pause
		if m.paused.Load() {
			time.Sleep(100 * time.Millisecond)
			continue
		}
		
		// Get current job
		job := m.getCurrentJob()
		if job == nil {
			time.Sleep(100 * time.Millisecond)
			continue
		}
		
		// Prepare mining data
		if len(job.Data) > len(buffer) {
			buffer = make([]byte, len(job.Data))
		}
		copy(buffer, job.Data)
		
		// Mine batch of nonces
		batchHashes := m.mineBatch(buffer, job, &nonce, batchSize)
		hashes += batchHashes
		
		// Update metrics periodically
		select {
		case <-ticker.C:
			m.hashRate.Store(hashes)
			hashes = 0 // Reset counter
		default:
		}
		
		// Check for context cancellation
		select {
		case <-m.ctx.Done():
			return
		default:
		}
	}
}

// mineBatch mines a batch of nonces efficiently
func (m *CPUMiner) mineBatch(buffer []byte, job *MiningJob, nonce *uint64, batchSize uint64) uint64 {
	algorithm := job.Algorithm
	target := job.Target
	
	for i := uint64(0); i < batchSize && m.running.Load(); i++ {
		// Set nonce in buffer
		noncePos := len(buffer) - 8 // Assume nonce is at the end
		if noncePos >= 0 {
			binary.LittleEndian.PutUint64(buffer[noncePos:], *nonce)
		}
		
		// Calculate hash based on algorithm
		hash := m.calculateHash(buffer, algorithm)
		
		// Check if hash meets target
		if m.meetsTarget(hash, target) {
			share := &Share{
				JobID:      job.ID,
				Nonce:      *nonce,
				Hash:       hash,
				Difficulty: m.calculateDifficulty(hash),
				Timestamp:  time.Now().Unix(),
			}
			
			m.validShares.Add(1)
			m.submitShare(share)
		}
		
		*nonce++
	}
	
	return batchSize
}

// calculateHash calculates hash based on algorithm - optimized
func (m *CPUMiner) calculateHash(data []byte, algorithm Algorithm) []byte {
	switch algorithm {
	case AlgorithmSHA256d:
		// Double SHA256
		h1 := sha256.Sum256(data)
		h2 := sha256.Sum256(h1[:])
		return h2[:]
	case AlgorithmSHA256:
		// Single SHA256
		h := sha256.Sum256(data)
		return h[:]
	default:
		// Default to SHA256d
		h1 := sha256.Sum256(data)
		h2 := sha256.Sum256(h1[:])
		return h2[:]
	}
}

// meetsTarget checks if hash meets difficulty target
func (m *CPUMiner) meetsTarget(hash, target []byte) bool {
	if len(hash) != len(target) {
		return false
	}
	
	// Compare hash with target (big-endian)
	for i := 0; i < len(hash); i++ {
		if hash[i] < target[i] {
			return true
		} else if hash[i] > target[i] {
			return false
		}
	}
	return true
}

// calculateDifficulty calculates difficulty from hash
func (m *CPUMiner) calculateDifficulty(hash []byte) uint64 {
	if len(hash) < 8 {
		return 0
	}
	
	// Count leading zero bits (simplified)
	leadingZeros := uint64(0)
	for _, b := range hash {
		if b == 0 {
			leadingZeros += 8
		} else {
			for bit := 7; bit >= 0; bit-- {
				if (b>>bit)&1 == 0 {
					leadingZeros++
				} else {
					break
				}
			}
			break
		}
	}
	
	return 1 << leadingZeros
}

// getCurrentJob gets current mining job
func (m *CPUMiner) getCurrentJob() *MiningJob {
	if job := m.currentWork.Load(); job != nil {
		return job.(*MiningJob)
	}
	return nil
}

// submitShare submits found share
func (m *CPUMiner) submitShare(share *Share) {
	// In a real implementation, this would submit to a pool
	m.logger.Debug("Share found",
		zap.Int("miner_id", m.ID),
		zap.String("job_id", share.JobID),
		zap.Uint64("nonce", share.Nonce),
		zap.String("hash", binary.BigEndian.AppendUint64(nil, binary.BigEndian.Uint64(share.Hash[:8]))[:4]),
	)
}

// NewCPUEngine creates a new CPU mining engine
func NewCPUEngine(logger *zap.Logger, config CPUConfig) *CPUEngine {
	if config.Threads <= 0 {
		config.Threads = 4 // Default to 4 threads
	}
	
	engine := &CPUEngine{
		logger: logger,
		config: config,
		miners: make([]*CPUMiner, config.Threads),
	}
	
	// Create CPU miners
	for i := 0; i < config.Threads; i++ {
		engine.miners[i] = NewCPUMiner(i, logger)
	}
	
	return engine
}

// Start starts all CPU miners
func (e *CPUEngine) Start(ctx context.Context) error {
	if !e.running.CompareAndSwap(false, true) {
		return nil // Already running
	}
	
	// Start all miners
	for _, miner := range e.miners {
		if err := miner.Start(); err != nil {
			return err
		}
	}
	
	// Start metrics aggregation
	go e.metricsLoop(ctx)
	
	e.logger.Info("CPU engine started",
		zap.Int("threads", len(e.miners)),
		zap.String("algorithm", e.config.Algorithm))
	
	return nil
}

// Stop stops all CPU miners
func (e *CPUEngine) Stop() error {
	if !e.running.CompareAndSwap(true, false) {
		return nil // Already stopped
	}
	
	// Stop all miners
	for _, miner := range e.miners {
		miner.Stop()
	}
	
	e.logger.Info("CPU engine stopped")
	return nil
}

// SubmitWork submits work to all miners
func (e *CPUEngine) SubmitWork(work *Work) error {
	if !e.running.Load() {
		return nil
	}
	
	// Convert Work to MiningJob
	job := &MiningJob{
		ID:        fmt.Sprintf("job_%d", time.Now().UnixNano()),
		Algorithm: AlgorithmSHA256d, // Default
		Data:      work.Data,
		Target:    work.Target,
		Height:    work.Height,
		Timestamp: work.Timestamp,
	}
	
	// Submit to all miners
	for _, miner := range e.miners {
		miner.SubmitJob(job)
	}
	
	return nil
}

// GetHashRate returns total hash rate
func (e *CPUEngine) GetHashRate() uint64 {
	return e.totalHashRate.Load()
}

// GetTemperature returns CPU temperature (placeholder)
func (e *CPUEngine) GetTemperature() float64 {
	return 65.0 // CPU mining typically runs cooler
}

// GetPowerUsage returns power usage (placeholder) 
func (e *CPUEngine) GetPowerUsage() float64 {
	return float64(len(e.miners)) * 50.0 // ~50W per thread
}

// metricsLoop aggregates metrics from all miners
func (e *CPUEngine) metricsLoop(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if !e.running.Load() {
				return
			}
			
			totalHashRate := uint64(0)
			totalShares := uint64(0)
			
			for _, miner := range e.miners {
				totalHashRate += miner.GetHashRate()
				totalShares += miner.validShares.Load()
			}
			
			e.totalHashRate.Store(totalHashRate)
			e.totalShares.Store(totalShares)
		}
	}
}

// GetStats returns detailed CPU mining statistics
func (e *CPUEngine) GetStats() map[string]interface{} {
	stats := map[string]interface{}{
		"algorithm":      e.config.Algorithm,
		"threads":        len(e.miners),
		"total_hashrate": e.totalHashRate.Load(),
		"total_shares":   e.totalShares.Load(),
		"running":        e.running.Load(),
	}
	
	// Per-miner stats
	miners := make([]map[string]interface{}, len(e.miners))
	for i, miner := range e.miners {
		miners[i] = map[string]interface{}{
			"id":           miner.ID,
			"hashrate":     miner.GetHashRate(),
			"valid_shares": miner.validShares.Load(),
			"running":      miner.running.Load(),
		}
	}
	stats["miners"] = miners
	
	return stats
}

// DefaultCPUConfig returns default CPU configuration
func DefaultCPUConfig() CPUConfig {
	return CPUConfig{
		Algorithm: "sha256d",
		Threads:   4,
	}
}
