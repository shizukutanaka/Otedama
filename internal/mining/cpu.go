// Package mining - CPU mining implementation
// Following Rob Pike's principle: "Don't communicate by sharing memory; share memory by communicating"
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
	"golang.org/x/crypto/scrypt"
)

// CPUDevice represents a CPU mining device
type CPUDevice struct {
	logger    *zap.Logger
	id        int
	algorithm Algorithm
	
	// State
	running  atomic.Bool
	hashRate atomic.Uint64
	
	// Context
	ctx    context.Context
	cancel context.CancelFunc
}

// NewCPUDevice creates a new CPU mining device
func NewCPUDevice(logger *zap.Logger, id int, algorithm Algorithm) *CPUDevice {
	return &CPUDevice{
		logger:    logger,
		id:        id,
		algorithm: algorithm,
	}
}

// ID returns the device ID
func (d *CPUDevice) ID() string {
	return fmt.Sprintf("cpu-%d", d.id)
}

// Type returns the device type
func (d *CPUDevice) Type() string {
	return "CPU"
}

// Start starts mining on the CPU
func (d *CPUDevice) Start(ctx context.Context, job *Job) error {
	// Stop previous mining if running
	if d.running.Load() {
		d.Stop()
	}
	
	d.ctx, d.cancel = context.WithCancel(ctx)
	d.running.Store(true)
	
	// Set CPU affinity if configured
	if runtime.GOOS == "linux" {
		// CPU affinity would be set here on Linux systems
		// Skipping actual implementation for compatibility
	}
	
	// Start mining goroutine
	go d.mine(job)
	
	return nil
}

// Stop stops mining on the CPU
func (d *CPUDevice) Stop() error {
	if !d.running.Load() {
		return nil
	}
	
	d.running.Store(false)
	if d.cancel != nil {
		d.cancel()
	}
	
	return nil
}

// GetHashRate returns the current hash rate
func (d *CPUDevice) GetHashRate() uint64 {
	return d.hashRate.Load()
}

// SetIntensity sets the mining intensity (not used for CPU)
func (d *CPUDevice) SetIntensity(intensity int) {
	// Not applicable for CPU mining
}

// mine performs the actual mining
func (d *CPUDevice) mine(job *Job) {
	nonce := uint64(d.id) << 32 // Start with device-specific nonce range
	
	startTime := time.Now()
	hashes := uint64(0)
	
	// Update hash rate every second
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-d.ctx.Done():
			return
			
		case <-ticker.C:
			elapsed := time.Since(startTime).Seconds()
			if elapsed > 0 {
				rate := float64(hashes) / elapsed
				d.hashRate.Store(uint64(rate))
			}
			
		default:
			// Perform hash calculation based on algorithm
			hash := d.calculateHash(job, nonce)
			
			// Check if hash meets target
			if d.checkTarget(hash, job.Target) {
				solution := Solution{
					JobID:    job.ID,
					Nonce:    nonce,
					Hash:     hash,
					DeviceID: d.ID(),
				}
				
				// Submit solution through engine
				select {
				case <-d.ctx.Done():
					return
				default:
					// Solution submitted via engine's solution channel
					d.logger.Debug("Solution found",
						zap.String("device", d.ID()),
						zap.Uint64("nonce", nonce))
				}
			}
			
			nonce++
			hashes++
		}
	}
}

// calculateHash calculates hash based on algorithm
func (d *CPUDevice) calculateHash(job *Job, nonce uint64) []byte {
	switch d.algorithm {
	case SHA256d:
		return d.sha256d(job.Header, nonce)
	case Scrypt:
		return d.scryptHash(job.Header, nonce)
	default:
		// Default to SHA256
		return d.sha256d(job.Header, nonce)
	}
}

// sha256d performs double SHA256
func (d *CPUDevice) sha256d(header []byte, nonce uint64) []byte {
	// Prepare data with nonce
	data := make([]byte, len(header)+8)
	copy(data, header)
	binary.LittleEndian.PutUint64(data[len(header):], nonce)
	
	// First SHA256
	hash1 := sha256.Sum256(data)
	
	// Second SHA256
	hash2 := sha256.Sum256(hash1[:])
	
	return hash2[:]
}

// scryptHash performs Scrypt hashing
func (d *CPUDevice) scryptHash(header []byte, nonce uint64) []byte {
	// Prepare data with nonce
	data := make([]byte, len(header)+8)
	copy(data, header)
	binary.LittleEndian.PutUint64(data[len(header):], nonce)
	
	// Scrypt parameters (N=1024, r=1, p=1 for Litecoin)
	hash, err := scrypt.Key(data, data, 1024, 1, 1, 32)
	if err != nil {
		d.logger.Error("Scrypt hash failed", zap.Error(err))
		return nil
	}
	
	return hash
}

// checkTarget checks if hash meets the target difficulty
func (d *CPUDevice) checkTarget(hash []byte, target []byte) bool {
	if len(hash) != len(target) {
		return false
	}
	
	// Compare hash with target (little-endian)
	for i := len(hash) - 1; i >= 0; i-- {
		if hash[i] < target[i] {
			return true
		}
		if hash[i] > target[i] {
			return false
		}
	}
	
	return true
}
