package mining

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// CPUEngine handles CPU mining operations
// Simple, efficient implementation following John Carmack's performance principles
type CPUEngine struct {
	logger      *zap.Logger
	config      CPUConfig
	running     int32
	hashCount   uint64
	validShares uint64
	difficulty  uint32
	work        Work
	mu          sync.RWMutex
}

// CPUConfig defines CPU mining engine configuration
type CPUConfig struct {
	Algorithm   string `yaml:"algorithm"`
	Threads     int    `yaml:"threads"`
	CPUAffinity []int  `yaml:"cpu_affinity"`
}

// Work represents mining work unit
type Work struct {
	Data      []byte    `json:"data"`
	Target    []byte    `json:"target"`
	Height    uint64    `json:"height"`
	Timestamp time.Time `json:"timestamp"`
}

// Share represents a valid mining share
type Share struct {
	Data      []byte    `json:"data"`
	Nonce     uint32    `json:"nonce"`
	Hash      []byte    `json:"hash"`
	Timestamp time.Time `json:"timestamp"`
}

// NewCPUEngine creates a new CPU mining engine
func NewCPUEngine(config CPUConfig, logger *zap.Logger) (*CPUEngine, error) {
	if config.Threads <= 0 {
		config.Threads = runtime.NumCPU()
	}

	// Validate algorithm
	if config.Algorithm != "sha256" && config.Algorithm != "sha256d" {
		return nil, fmt.Errorf("unsupported algorithm: %s", config.Algorithm)
	}

	return &CPUEngine{
		logger:     logger,
		config:     config,
		difficulty: 0x1d00ffff, // Default Bitcoin difficulty
	}, nil
}

// Start begins mining operations
func (e *CPUEngine) Start(ctx context.Context) error {
	if !atomic.CompareAndSwapInt32(&e.running, 0, 1) {
		return fmt.Errorf("engine already running")
	}

	e.logger.Info("Starting CPU mining engine",
		zap.String("algorithm", e.config.Algorithm),
		zap.Int("threads", e.config.Threads),
	)

	// Start mining threads
	for i := 0; i < e.config.Threads; i++ {
		go e.miningWorker(ctx, i)
	}

	// Start stats reporter
	go e.statsReporter(ctx)

	return nil
}

// Stop stops mining operations
func (e *CPUEngine) Stop() error {
	if !atomic.CompareAndSwapInt32(&e.running, 1, 0) {
		return fmt.Errorf("engine not running")
	}

	e.logger.Info("Stopping CPU mining engine")
	return nil
}

// SetWork updates the current mining work
func (e *CPUEngine) SetWork(work Work) {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.work = work
	e.logger.Debug("New work set",
		zap.Uint64("height", work.Height),
		zap.Int("data_size", len(work.Data)),
	)
}

// SetDifficulty updates the mining difficulty
func (e *CPUEngine) SetDifficulty(difficulty uint32) {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.difficulty = difficulty
	e.logger.Info("Difficulty updated", zap.Uint32("difficulty", difficulty))
}

// GetHashRate returns current hash rate
func (e *CPUEngine) GetHashRate() uint64 {
	return atomic.LoadUint64(&e.hashCount)
}

// GetValidShares returns number of valid shares found
func (e *CPUEngine) GetValidShares() uint64 {
	return atomic.LoadUint64(&e.validShares)
}

// GetStats returns mining statistics
func (e *CPUEngine) GetStats() map[string]interface{} {
	return map[string]interface{}{
		"algorithm":     e.config.Algorithm,
		"threads":       e.config.Threads,
		"hash_rate":     atomic.LoadUint64(&e.hashCount),
		"valid_shares":  atomic.LoadUint64(&e.validShares),
		"difficulty":    e.difficulty,
		"running":       atomic.LoadInt32(&e.running) == 1,
	}
}

// miningWorker is the core mining loop for each thread
func (e *CPUEngine) miningWorker(ctx context.Context, workerID int) {
	var nonce uint32
	var hashes uint64
	buffer := make([]byte, 80) // Standard Bitcoin block header size

	// Performance: report hashes every 100k iterations
	const reportInterval = 100000

	for atomic.LoadInt32(&e.running) == 1 {
		select {
		case <-ctx.Done():
			return
		default:
		}

		// Get current work (lock-free read)
		e.mu.RLock()
		work := e.work
		difficulty := e.difficulty
		e.mu.RUnlock()

		if len(work.Data) == 0 {
			time.Sleep(100 * time.Millisecond)
			continue
		}

		// Prepare mining data
		copy(buffer, work.Data)
		
		// Mine block of nonces
		for i := 0; i < reportInterval && atomic.LoadInt32(&e.running) == 1; i++ {
			// Set nonce
			binary.LittleEndian.PutUint32(buffer[76:80], nonce)

			// Calculate hash
			var hash []byte
			switch e.config.Algorithm {
			case "sha256":
				h := sha256.Sum256(buffer)
				hash = h[:]
			case "sha256d":
				h1 := sha256.Sum256(buffer)
				h2 := sha256.Sum256(h1[:])
				hash = h2[:]
			}

			hashes++
			nonce++

			// Check if hash meets difficulty target
			if e.checkDifficulty(hash, difficulty) {
				share := Share{
					Data:      make([]byte, len(buffer)),
					Nonce:     nonce - 1,
					Hash:      hash,
					Timestamp: time.Now(),
				}
				copy(share.Data, buffer)

				atomic.AddUint64(&e.validShares, 1)
				e.logger.Info("Valid share found",
					zap.Int("worker_id", workerID),
					zap.Uint32("nonce", share.Nonce),
					zap.String("hash", fmt.Sprintf("%x", hash[:4])),
				)

				// In a real implementation, submit share to pool here
			}
		}

		// Update hash counter
		atomic.AddUint64(&e.hashCount, hashes)
		hashes = 0
	}

	e.logger.Debug("Mining worker stopped", zap.Int("worker_id", workerID))
}

// checkDifficulty checks if hash meets the difficulty target
func (e *CPUEngine) checkDifficulty(hash []byte, difficulty uint32) bool {
	// Simplified difficulty check: count leading zeros
	if len(hash) < 4 {
		return false
	}

	// Check first 4 bytes for leading zeros (simplified)
	target := uint32(0x0000ffff) // Simplified target
	hashUint := binary.BigEndian.Uint32(hash[:4])
	
	return hashUint < target
}

// statsReporter reports mining statistics periodically
func (e *CPUEngine) statsReporter(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	var lastHashCount uint64
	var lastTime time.Time = time.Now()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if atomic.LoadInt32(&e.running) != 1 {
				return
			}

			currentHashCount := atomic.LoadUint64(&e.hashCount)
			currentTime := time.Now()
			
			if !lastTime.IsZero() {
				duration := currentTime.Sub(lastTime)
				hashDiff := currentHashCount - lastHashCount
				hashRate := float64(hashDiff) / duration.Seconds()

				e.logger.Info("Mining stats",
					zap.Float64("hash_rate_hs", hashRate),
					zap.Uint64("total_hashes", currentHashCount),
					zap.Uint64("valid_shares", atomic.LoadUint64(&e.validShares)),
					zap.Int("threads", e.config.Threads),
				)
			}

			lastHashCount = currentHashCount
			lastTime = currentTime
		}
	}
}
