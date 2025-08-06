package pool

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"
	"time"

	"go.uber.org/zap"
)

// JobManager manages mining jobs
type JobManager struct {
	logger    *zap.Logger
	jobs      map[string]*MiningJob
	jobsMu    sync.RWMutex
	currentJob *MiningJob
	
	// Job generation
	jobCounter uint64
	
	// Configuration
	jobExpiry  time.Duration
	maxJobs    int
}

// MiningJob represents a mining job
type MiningJob struct {
	ID                string
	Algorithm         string
	Target            string
	BlockTemplate     []byte
	CreatedAt         time.Time
	ExpiresAt         time.Time
	NetworkDifficulty float64
	Height            int64
	BlockReward       float64
	PreviousHash      string
	CoinbaseData      []byte
}

// NewJobManager creates a new job manager
func NewJobManager(logger *zap.Logger, jobExpiry time.Duration) *JobManager {
	if jobExpiry <= 0 {
		jobExpiry = 2 * time.Minute
	}
	
	jm := &JobManager{
		logger:    logger,
		jobs:      make(map[string]*MiningJob),
		jobExpiry: jobExpiry,
		maxJobs:   1000,
	}
	
	// Start cleanup routine
	go jm.cleanupRoutine()
	
	return jm
}

// CreateJob creates a new mining job
func (jm *JobManager) CreateJob(
	algorithm string,
	target string,
	blockTemplate []byte,
	networkDifficulty float64,
	height int64,
	blockReward float64,
	previousHash string,
) *MiningJob {
	jm.jobCounter++
	
	// Generate job ID
	jobID := jm.generateJobID()
	
	job := &MiningJob{
		ID:                jobID,
		Algorithm:         algorithm,
		Target:            target,
		BlockTemplate:     blockTemplate,
		CreatedAt:         time.Now(),
		ExpiresAt:         time.Now().Add(jm.jobExpiry),
		NetworkDifficulty: networkDifficulty,
		Height:            height,
		BlockReward:       blockReward,
		PreviousHash:      previousHash,
		CoinbaseData:      jm.generateCoinbaseData(),
	}
	
	// Store job
	jm.jobsMu.Lock()
	jm.jobs[jobID] = job
	jm.currentJob = job
	
	// Enforce max jobs
	if len(jm.jobs) > jm.maxJobs {
		jm.removeOldestJob()
	}
	jm.jobsMu.Unlock()
	
	jm.logger.Info("Created new job",
		zap.String("job_id", jobID),
		zap.String("algorithm", algorithm),
		zap.Int64("height", height),
		zap.Float64("difficulty", networkDifficulty),
	)
	
	return job
}

// GetJob retrieves a job by ID
func (jm *JobManager) GetJob(jobID string) *MiningJob {
	jm.jobsMu.RLock()
	defer jm.jobsMu.RUnlock()
	
	job, exists := jm.jobs[jobID]
	if !exists {
		return nil
	}
	
	// Check if expired
	if time.Now().After(job.ExpiresAt) {
		return nil
	}
	
	return job
}

// GetCurrentJob returns the current job
func (jm *JobManager) GetCurrentJob() *MiningJob {
	jm.jobsMu.RLock()
	defer jm.jobsMu.RUnlock()
	
	if jm.currentJob == nil {
		return nil
	}
	
	// Check if expired
	if time.Now().After(jm.currentJob.ExpiresAt) {
		return nil
	}
	
	return jm.currentJob
}

// RemoveJob removes a job
func (jm *JobManager) RemoveJob(jobID string) {
	jm.jobsMu.Lock()
	defer jm.jobsMu.Unlock()
	
	delete(jm.jobs, jobID)
}

// GetActiveJobs returns all active (non-expired) jobs
func (jm *JobManager) GetActiveJobs() []*MiningJob {
	jm.jobsMu.RLock()
	defer jm.jobsMu.RUnlock()
	
	now := time.Now()
	activeJobs := make([]*MiningJob, 0)
	
	for _, job := range jm.jobs {
		if now.Before(job.ExpiresAt) {
			activeJobs = append(activeJobs, job)
		}
	}
	
	return activeJobs
}

// GetStats returns job manager statistics
func (jm *JobManager) GetStats() map[string]interface{} {
	jm.jobsMu.RLock()
	defer jm.jobsMu.RUnlock()
	
	activeCount := 0
	now := time.Now()
	
	for _, job := range jm.jobs {
		if now.Before(job.ExpiresAt) {
			activeCount++
		}
	}
	
	return map[string]interface{}{
		"total_jobs":    len(jm.jobs),
		"active_jobs":   activeCount,
		"expired_jobs":  len(jm.jobs) - activeCount,
		"jobs_created":  jm.jobCounter,
		"current_job_id": func() string {
			if jm.currentJob != nil {
				return jm.currentJob.ID
			}
			return ""
		}(),
	}
}

// Private methods

func (jm *JobManager) generateJobID() string {
	// Generate random bytes
	bytes := make([]byte, 4)
	rand.Read(bytes)
	
	// Format: counter-random
	return fmt.Sprintf("%d-%s", jm.jobCounter, hex.EncodeToString(bytes))
}

func (jm *JobManager) generateCoinbaseData() []byte {
	// Generate coinbase data
	// This would include pool signature, extra nonce space, etc.
	data := make([]byte, 100)
	rand.Read(data)
	return data
}

func (jm *JobManager) removeOldestJob() {
	var oldestID string
	var oldestTime time.Time
	
	first := true
	for id, job := range jm.jobs {
		if first || job.CreatedAt.Before(oldestTime) {
			oldestID = id
			oldestTime = job.CreatedAt
			first = false
		}
	}
	
	if oldestID != "" {
		delete(jm.jobs, oldestID)
	}
}

func (jm *JobManager) cleanupRoutine() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for range ticker.C {
		jm.cleanupExpiredJobs()
	}
}

func (jm *JobManager) cleanupExpiredJobs() {
	jm.jobsMu.Lock()
	defer jm.jobsMu.Unlock()
	
	now := time.Now()
	expiredCount := 0
	
	for id, job := range jm.jobs {
		if now.After(job.ExpiresAt) {
			delete(jm.jobs, id)
			expiredCount++
		}
	}
	
	if expiredCount > 0 {
		jm.logger.Debug("Cleaned up expired jobs",
			zap.Int("count", expiredCount),
		)
	}
}