package mining

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// ShareManager manages mining shares with TTL and deduplication
type ShareManager struct {
	logger       *zap.Logger
	shares       map[string]*Share  // share hash -> share
	minerShares  map[string][]*Share // miner ID -> shares
	sharesByJob  map[string][]*Share // job ID -> shares
	ttl          time.Duration
	mu           sync.RWMutex
	
	// Statistics
	totalShares   atomic.Uint64
	validShares   atomic.Uint64
	invalidShares atomic.Uint64
	duplicates    atomic.Uint64
	
	// Cleanup
	stopChan     chan struct{}
	cleanupInterval time.Duration
}

// ShareConfig contains share manager configuration
type ShareConfig struct {
	TTL             time.Duration `yaml:"ttl"`
	CleanupInterval time.Duration `yaml:"cleanup_interval"`
	MaxSharesPerMiner int         `yaml:"max_shares_per_miner"`
}

// NewShareManager creates a new share manager
func NewShareManager(logger *zap.Logger, config ShareConfig) *ShareManager {
	// Set defaults
	if config.TTL <= 0 {
		config.TTL = 24 * time.Hour
	}
	if config.CleanupInterval <= 0 {
		config.CleanupInterval = time.Hour
	}
	
	sm := &ShareManager{
		logger:          logger,
		shares:          make(map[string]*Share),
		minerShares:     make(map[string][]*Share),
		sharesByJob:     make(map[string][]*Share),
		ttl:             config.TTL,
		cleanupInterval: config.CleanupInterval,
		stopChan:        make(chan struct{}),
	}
	
	// Start cleanup goroutine
	go sm.cleanupLoop()
	
	return sm
}

// SubmitShare submits a new share for validation and storage
func (sm *ShareManager) SubmitShare(share *Share) error {
	// Calculate share hash for deduplication
	share.Hash = sm.calculateShareHash(share)
	shareHashStr := hex.EncodeToString(share.Hash[:])

	sm.mu.Lock()
	defer sm.mu.Unlock()

	// Check for duplicate
	if existingShare, exists := sm.shares[shareHashStr]; exists {
		sm.duplicates.Add(1)
		return fmt.Errorf("duplicate share: %s (original timestamp: %v)",
			shareHashStr, time.Unix(existingShare.Timestamp, 0))
	}

	// Validate share
	if err := sm.validateShare(share); err != nil {
		share.Valid = false
		sm.invalidShares.Add(1)
		sm.logger.Warn("Invalid share submitted",
			zap.String("worker_id", share.WorkerID),
			zap.String("job_id", share.JobID),
			zap.Error(err),
		)
		// Store invalid shares for auditing
	} else {
		share.Valid = true
		sm.validShares.Add(1)
	}

	// Store share
	sm.shares[shareHashStr] = share
	sm.totalShares.Add(1)

	// Index by miner
	sm.minerShares[share.WorkerID] = append(sm.minerShares[share.WorkerID], share)

	// Index by job
	sm.sharesByJob[share.JobID] = append(sm.sharesByJob[share.JobID], share)

	sm.logger.Debug("Share submitted",
		zap.String("worker_id", share.WorkerID),
		zap.String("job_id", share.JobID),
		zap.Uint64("nonce", share.Nonce),
		zap.Uint64("difficulty", share.Difficulty),
		zap.Bool("valid", share.Valid),
	)

	return nil
}

// GetShare retrieves a share by its hash
func (sm *ShareManager) GetShare(hash string) (*Share, error) {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	
	share, exists := sm.shares[hash]
	if !exists {
		return nil, fmt.Errorf("share not found: %s", hash)
	}
	
	return share, nil
}

// GetMinerShares retrieves all shares for a specific miner
func (sm *ShareManager) GetMinerShares(minerID string, since time.Time) []*Share {
	sm.mu.RLock()
	defer sm.mu.RUnlock()

	allShares := sm.minerShares[minerID]
	if len(allShares) == 0 {
		return nil
	}

	// Filter by time
	sinceUnix := since.Unix()
	var filteredShares []*Share
	for _, share := range allShares {
		if share.Timestamp > sinceUnix {
			filteredShares = append(filteredShares, share)
		}
	}

	return filteredShares
}

// GetJobShares retrieves all shares for a specific job
func (sm *ShareManager) GetJobShares(jobID string) []*Share {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	
	shares := sm.sharesByJob[jobID]
	result := make([]*Share, len(shares))
	copy(result, shares)
	
	return result
}

// GetValidSharesCount returns the count of valid shares for a miner
func (sm *ShareManager) GetValidSharesCount(minerID string, since time.Time) int {
	shares := sm.GetMinerShares(minerID, since)
	
	validCount := 0
	for _, share := range shares {
		if share.Valid {
			validCount++
		}
	}
	
	return validCount
}

// GetShareStatistics returns share statistics
func (sm *ShareManager) GetShareStatistics() map[string]interface{} {
	sm.mu.RLock()
	minerCount := len(sm.minerShares)
	jobCount := len(sm.sharesByJob)
	shareCount := len(sm.shares)
	sm.mu.RUnlock()
	
	return map[string]interface{}{
		"total_shares":   sm.totalShares.Load(),
		"valid_shares":   sm.validShares.Load(),
		"invalid_shares": sm.invalidShares.Load(),
		"duplicates":     sm.duplicates.Load(),
		"active_miners":  minerCount,
		"active_jobs":    jobCount,
		"stored_shares":  shareCount,
		"share_ttl":      sm.ttl.String(),
	}
}

// Stop stops the share manager
func (sm *ShareManager) Stop() {
	close(sm.stopChan)
}

// Private methods

// calculateShareHash calculates a unique hash for a share
func (sm *ShareManager) calculateShareHash(share *Share) [32]byte {
	data := struct {
		WorkerID   string
		JobID      string
		Nonce      uint64
		Timestamp  int64
		Difficulty uint64
	}{
		WorkerID:   share.WorkerID,
		JobID:      share.JobID,
		Nonce:      share.Nonce,
		Timestamp:  share.Timestamp,
		Difficulty: share.Difficulty,
	}

	serialized, _ := json.Marshal(data)
	return sha256.Sum256(serialized)
}

// validateShare validates share difficulty and other parameters
func (sm *ShareManager) validateShare(share *Share) error {
	// Check timestamp
	if share.Timestamp == 0 {
		return fmt.Errorf("share has no timestamp")
	}

	now := time.Now()
	shareTime := time.Unix(share.Timestamp, 0)

	// Check if timestamp is not in the future
	if shareTime.After(now.Add(5 * time.Minute)) {
		return fmt.Errorf("share timestamp is in the future")
	}

	// Check if timestamp is not too old
	if now.Sub(shareTime) > sm.ttl {
		return fmt.Errorf("share is too old: %v", shareTime)
	}

	// Check difficulty
	if share.Difficulty == 0 {
		return fmt.Errorf("invalid difficulty: %d", share.Difficulty)
	}

	// Check worker ID
	if share.WorkerID == "" {
		return fmt.Errorf("share has no worker ID")
	}

	// Check job ID
	if share.JobID == "" {
		return fmt.Errorf("share has no job ID")
	}

	// TODO: Add actual proof-of-work validation here
	// This would involve checking if the share meets the difficulty target

	return nil
}

// cleanupLoop periodically removes expired shares
func (sm *ShareManager) cleanupLoop() {
	ticker := time.NewTicker(sm.cleanupInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			sm.cleanupExpiredShares()
		case <-sm.stopChan:
			return
		}
	}
}

// cleanupExpiredShares removes shares older than TTL
func (sm *ShareManager) cleanupExpiredShares() {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	now := time.Now()
	expiredCount := 0

	// Find expired shares
	for hash, share := range sm.shares {
		shareTime := time.Unix(share.Timestamp, 0)
		if now.Sub(shareTime) > sm.ttl {
			delete(sm.shares, hash)
			expiredCount++

			// Remove from miner index
			minerShares := sm.minerShares[share.WorkerID]
			for i, s := range minerShares {
				if hex.EncodeToString(s.Hash[:]) == hash {
					sm.minerShares[share.WorkerID] = append(minerShares[:i], minerShares[i+1:]...)
					break
				}
			}

			// Remove from job index
			jobShares := sm.sharesByJob[share.JobID]
			for i, s := range jobShares {
				if hex.EncodeToString(s.Hash[:]) == hash {
					sm.sharesByJob[share.JobID] = append(jobShares[:i], jobShares[i+1:]...)
					break
				}
			}
		}
	}

	// Clean up empty entries
	for minerID, shares := range sm.minerShares {
		if len(shares) == 0 {
			delete(sm.minerShares, minerID)
		}
	}

	for jobID, shares := range sm.sharesByJob {
		if len(shares) == 0 {
			delete(sm.sharesByJob, jobID)
		}
	}

	if expiredCount > 0 {
		sm.logger.Info("Cleaned up expired shares",
			zap.Int("expired_count", expiredCount),
			zap.Int("remaining_shares", len(sm.shares)),
		)
	}
}

// ShareDifficulty calculates the difficulty of a share
type ShareDifficulty struct {
	Target     []byte
	Difficulty float64
}

// CalculateShareDifficulty calculates share difficulty from hash
func CalculateShareDifficulty(hash []byte) float64 {
	// Simple difficulty calculation
	// Count leading zeros
	leadingZeros := 0
	for _, b := range hash {
		if b == 0 {
			leadingZeros += 8
		} else {
			// Count leading zeros in the byte
			for i := 7; i >= 0; i-- {
				if b&(1<<i) == 0 {
					leadingZeros++
				} else {
					break
				}
			}
			break
		}
	}
	
	// Difficulty is approximately 2^leadingZeros
	return float64(uint64(1) << leadingZeros)
}

// ShareValidator provides additional share validation methods
type ShareValidator struct {
	minDifficulty float64
	maxDifficulty float64
}

// NewShareValidator creates a new share validator
func NewShareValidator(minDiff, maxDiff float64) *ShareValidator {
	return &ShareValidator{
		minDifficulty: minDiff,
		maxDifficulty: maxDiff,
	}
}

// ValidateDifficulty validates share difficulty is within acceptable range
func (sv *ShareValidator) ValidateDifficulty(difficulty float64) error {
	if difficulty < sv.minDifficulty {
		return fmt.Errorf("difficulty too low: %f < %f", difficulty, sv.minDifficulty)
	}
	if difficulty > sv.maxDifficulty {
		return fmt.Errorf("difficulty too high: %f > %f", difficulty, sv.maxDifficulty)
	}
	return nil
}