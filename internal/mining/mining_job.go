package mining

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"
)

// MiningJob represents a mining job
type MiningJob struct {
	JobID       string      `json:"job_id"`
	BlockHeader BlockHeader `json:"block_header"`
	Target      []byte      `json:"target"`
	Creator     string      `json:"creator"`
	Timestamp   time.Time   `json:"timestamp"`
	ExpiresAt   time.Time   `json:"expires_at"`
	Height      uint64      `json:"height"`
	Difficulty  float64     `json:"difficulty"`
}

// BlockHeader represents a block header for mining
type BlockHeader struct {
	PrevHash    string    `json:"prev_hash"`
	MerkleRoot  string    `json:"merkle_root"`
	Timestamp   time.Time `json:"timestamp"`
	Nonce       uint64    `json:"nonce"`
	Difficulty  float64   `json:"difficulty"`
	Height      uint64    `json:"height"`
}

// Block represents a complete block
type Block struct {
	Header       BlockHeader     `json:"header"`
	Transactions []Transaction   `json:"transactions"`
	Hash         string          `json:"hash"`
	MinerID      string          `json:"miner_id"`
	Signature    []byte          `json:"signature"`
}

// Transaction represents a transaction in the block
type Transaction struct {
	TxID      string    `json:"tx_id"`
	From      string    `json:"from"`
	To        string    `json:"to"`
	Amount    uint64    `json:"amount"`
	Fee       uint64    `json:"fee"`
	Timestamp time.Time `json:"timestamp"`
}

// JobManager manages mining jobs
type JobManager struct {
	logger       *zap.Logger
	currentJob   atomic.Value // *MiningJob
	jobs         map[string]*MiningJob
	jobHistory   []*MiningJob
	maxHistory   int
	nodeID       string
	mu           sync.RWMutex
	
	// Statistics
	jobsCreated   atomic.Uint64
	jobsCompleted atomic.Uint64
	blocksFound   atomic.Uint64
	
	// Callbacks
	onNewBlock    func(*Block)
	onJobExpired  func(*MiningJob)
}

// JobConfig contains job manager configuration
type JobConfig struct {
	JobExpiry        time.Duration `yaml:"job_expiry"`
	MaxJobHistory    int           `yaml:"max_job_history"`
	DefaultDifficulty float64      `yaml:"default_difficulty"`
}

// NewJobManager creates a new job manager
func NewJobManager(logger *zap.Logger, nodeID string, config JobConfig) *JobManager {
	// Set defaults
	if config.JobExpiry <= 0 {
		config.JobExpiry = 30 * time.Second
	}
	if config.MaxJobHistory <= 0 {
		config.MaxJobHistory = 1000
	}
	if config.DefaultDifficulty <= 0 {
		config.DefaultDifficulty = 1000000
	}
	
	jm := &JobManager{
		logger:     logger,
		jobs:       make(map[string]*MiningJob),
		jobHistory: make([]*MiningJob, 0, config.MaxJobHistory),
		maxHistory: config.MaxJobHistory,
		nodeID:     nodeID,
	}
	
	return jm
}

// GenerateMiningJob generates a new mining job based on the latest block
func (jm *JobManager) GenerateMiningJob(latestBlock Block, transactions []Transaction) (*MiningJob, error) {
	jobID := uuid.New().String()
	
	// Calculate merkle root from transactions
	merkleRoot := jm.calculateMerkleRoot(transactions)
	
	// Create block header
	header := BlockHeader{
		PrevHash:   latestBlock.Hash,
		MerkleRoot: merkleRoot,
		Timestamp:  time.Now(),
		Nonce:      0,
		Difficulty: jm.calculateNextDifficulty(latestBlock),
		Height:     latestBlock.Header.Height + 1,
	}
	
	// Calculate target from difficulty
	target := jm.calculateTarget(header.Difficulty)
	
	// Create job
	job := &MiningJob{
		JobID:       jobID,
		BlockHeader: header,
		Target:      target,
		Creator:     jm.nodeID,
		Timestamp:   time.Now(),
		ExpiresAt:   time.Now().Add(30 * time.Second),
		Height:      header.Height,
		Difficulty:  header.Difficulty,
	}
	
	// Store job
	jm.mu.Lock()
	jm.jobs[jobID] = job
	jm.currentJob.Store(job)
	jm.jobsCreated.Add(1)
	
	// Add to history
	jm.jobHistory = append(jm.jobHistory, job)
	if len(jm.jobHistory) > jm.maxHistory {
		jm.jobHistory = jm.jobHistory[1:]
	}
	jm.mu.Unlock()
	
	jm.logger.Info("Generated new mining job",
		zap.String("job_id", jobID),
		zap.Uint64("height", header.Height),
		zap.Float64("difficulty", header.Difficulty),
		zap.String("prev_hash", header.PrevHash),
	)
	
	return job, nil
}

// GetCurrentJob returns the current mining job
func (jm *JobManager) GetCurrentJob() (*MiningJob, error) {
	job := jm.currentJob.Load()
	if job == nil {
		return nil, fmt.Errorf("no current job available")
	}
	
	currentJob := job.(*MiningJob)
	
	// Check if job has expired
	if time.Now().After(currentJob.ExpiresAt) {
		return nil, fmt.Errorf("current job has expired")
	}
	
	return currentJob, nil
}

// GetJob retrieves a specific job by ID
func (jm *JobManager) GetJob(jobID string) (*MiningJob, error) {
	jm.mu.RLock()
	defer jm.mu.RUnlock()
	
	job, exists := jm.jobs[jobID]
	if !exists {
		return nil, fmt.Errorf("job not found: %s", jobID)
	}
	
	return job, nil
}

// SubmitSolution submits a mining solution for a job
func (jm *JobManager) SubmitSolution(jobID string, nonce uint64, minerID string) (*Block, error) {
	// Get job
	job, err := jm.GetJob(jobID)
	if err != nil {
		return nil, err
	}
	
	// Check if job has expired
	if time.Now().After(job.ExpiresAt) {
		return nil, fmt.Errorf("job has expired")
	}
	
	// Update header with nonce
	header := job.BlockHeader
	header.Nonce = nonce
	
	// Calculate block hash
	blockHash := jm.calculateBlockHash(header)
	
	// Verify solution meets target
	if !jm.verifySolution(blockHash, job.Target) {
		return nil, fmt.Errorf("solution does not meet difficulty target")
	}
	
	// Create block
	block := &Block{
		Header:  header,
		Hash:    hex.EncodeToString(blockHash),
		MinerID: minerID,
	}
	
	// Mark job as completed
	jm.mu.Lock()
	jm.jobsCompleted.Add(1)
	jm.blocksFound.Add(1)
	jm.mu.Unlock()
	
	// Notify block found
	if jm.onNewBlock != nil {
		jm.onNewBlock(block)
	}
	
	jm.logger.Info("Block found!",
		zap.String("job_id", jobID),
		zap.String("block_hash", block.Hash),
		zap.Uint64("height", header.Height),
		zap.String("miner_id", minerID),
		zap.Uint64("nonce", nonce),
	)
	
	return block, nil
}

// SetOnNewBlock sets the callback for when a new block is found
func (jm *JobManager) SetOnNewBlock(callback func(*Block)) {
	jm.onNewBlock = callback
}

// SetOnJobExpired sets the callback for when a job expires
func (jm *JobManager) SetOnJobExpired(callback func(*MiningJob)) {
	jm.onJobExpired = callback
}

// GetStatistics returns job manager statistics
func (jm *JobManager) GetStatistics() map[string]interface{} {
	jm.mu.RLock()
	activeJobs := len(jm.jobs)
	historySize := len(jm.jobHistory)
	jm.mu.RUnlock()
	
	return map[string]interface{}{
		"jobs_created":   jm.jobsCreated.Load(),
		"jobs_completed": jm.jobsCompleted.Load(),
		"blocks_found":   jm.blocksFound.Load(),
		"active_jobs":    activeJobs,
		"history_size":   historySize,
	}
}

// CleanupExpiredJobs removes expired jobs
func (jm *JobManager) CleanupExpiredJobs() {
	jm.mu.Lock()
	defer jm.mu.Unlock()
	
	now := time.Now()
	expiredCount := 0
	
	for jobID, job := range jm.jobs {
		if now.After(job.ExpiresAt) {
			delete(jm.jobs, jobID)
			expiredCount++
			
			// Notify expiration
			if jm.onJobExpired != nil {
				jm.onJobExpired(job)
			}
		}
	}
	
	if expiredCount > 0 {
		jm.logger.Info("Cleaned up expired jobs",
			zap.Int("expired_count", expiredCount),
			zap.Int("remaining_jobs", len(jm.jobs)),
		)
	}
}

// Private methods

// calculateMerkleRoot calculates the merkle root of transactions
func (jm *JobManager) calculateMerkleRoot(transactions []Transaction) string {
	if len(transactions) == 0 {
		return hex.EncodeToString(make([]byte, 32))
	}
	
	// Get transaction hashes
	hashes := make([][]byte, len(transactions))
	for i, tx := range transactions {
		txData, _ := json.Marshal(tx)
		hash := sha256.Sum256(txData)
		hashes[i] = hash[:]
	}
	
	// Build merkle tree
	for len(hashes) > 1 {
		if len(hashes)%2 != 0 {
			hashes = append(hashes, hashes[len(hashes)-1])
		}
		
		newLevel := make([][]byte, 0, len(hashes)/2)
		for i := 0; i < len(hashes); i += 2 {
			combined := append(hashes[i], hashes[i+1]...)
			hash := sha256.Sum256(combined)
			newLevel = append(newLevel, hash[:])
		}
		hashes = newLevel
	}
	
	return hex.EncodeToString(hashes[0])
}

// calculateTarget calculates the target from difficulty
func (jm *JobManager) calculateTarget(difficulty float64) []byte {
	// Target = MaxTarget / Difficulty
	// MaxTarget = 2^256 - 1
	maxTarget := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))
	
	// Calculate target
	diffBig := new(big.Float).SetFloat64(difficulty)
	targetFloat := new(big.Float).Quo(new(big.Float).SetInt(maxTarget), diffBig)
	
	target, _ := targetFloat.Int(nil)
	targetBytes := target.Bytes()
	
	// Pad to 32 bytes
	if len(targetBytes) < 32 {
		padded := make([]byte, 32)
		copy(padded[32-len(targetBytes):], targetBytes)
		return padded
	}
	
	return targetBytes[:32]
}

// calculateBlockHash calculates the hash of a block header
func (jm *JobManager) calculateBlockHash(header BlockHeader) []byte {
	// Serialize header
	data := make([]byte, 0, 256)
	data = append(data, []byte(header.PrevHash)...)
	data = append(data, []byte(header.MerkleRoot)...)
	
	// Add timestamp
	timeBuf := make([]byte, 8)
	binary.BigEndian.PutUint64(timeBuf, uint64(header.Timestamp.Unix()))
	data = append(data, timeBuf...)
	
	// Add nonce
	nonceBuf := make([]byte, 8)
	binary.BigEndian.PutUint64(nonceBuf, header.Nonce)
	data = append(data, nonceBuf...)
	
	// Add difficulty
	diffBuf := make([]byte, 8)
	binary.BigEndian.PutUint64(diffBuf, uint64(header.Difficulty))
	data = append(data, diffBuf...)
	
	// Add height
	heightBuf := make([]byte, 8)
	binary.BigEndian.PutUint64(heightBuf, header.Height)
	data = append(data, heightBuf...)
	
	// Calculate double SHA256
	hash := sha256.Sum256(data)
	hash = sha256.Sum256(hash[:])
	
	return hash[:]
}

// verifySolution verifies if a hash meets the target difficulty
func (jm *JobManager) verifySolution(hash []byte, target []byte) bool {
	// Hash must be less than target
	hashBig := new(big.Int).SetBytes(hash)
	targetBig := new(big.Int).SetBytes(target)
	
	return hashBig.Cmp(targetBig) < 0
}

// calculateNextDifficulty calculates the difficulty for the next block
func (jm *JobManager) calculateNextDifficulty(latestBlock Block) float64 {
	// Simple difficulty adjustment
	// In a real implementation, this would consider block times
	// and adjust to maintain target block time
	
	currentDiff := latestBlock.Header.Difficulty
	if currentDiff <= 0 {
		currentDiff = 1000000 // Default difficulty
	}
	
	// For now, keep difficulty constant
	// TODO: Implement proper difficulty adjustment algorithm
	return currentDiff
}

// JobDistributor manages job distribution to workers
type JobDistributor struct {
	currentJob   atomic.Value // *MiningJob
	jobQueue     chan *MiningJob
	workers      sync.Map
	mu           sync.RWMutex
	jobCounter   atomic.Uint64
	targetTime   time.Duration
	lastJobTime  time.Time
}

// JobQueue manages a queue of mining jobs
type JobQueue struct {
	jobs     []*MiningJob
	maxSize  int
	mu       sync.Mutex
}

// NewJobQueue creates a new job queue
func NewJobQueue(maxSize int) *JobQueue {
	return &JobQueue{
		jobs:    make([]*MiningJob, 0, maxSize),
		maxSize: maxSize,
	}
}

// Push adds a job to the queue
func (jq *JobQueue) Push(job *MiningJob) error {
	jq.mu.Lock()
	defer jq.mu.Unlock()
	
	if len(jq.jobs) >= jq.maxSize {
		return fmt.Errorf("job queue is full")
	}
	
	jq.jobs = append(jq.jobs, job)
	return nil
}

// Pop removes and returns the oldest job from the queue
func (jq *JobQueue) Pop() (*MiningJob, error) {
	jq.mu.Lock()
	defer jq.mu.Unlock()
	
	if len(jq.jobs) == 0 {
		return nil, fmt.Errorf("job queue is empty")
	}
	
	job := jq.jobs[0]
	jq.jobs = jq.jobs[1:]
	
	return job, nil
}

// Size returns the current queue size
func (jq *JobQueue) Size() int {
	jq.mu.Lock()
	defer jq.mu.Unlock()
	return len(jq.jobs)
}

// NewJobDistributor creates a new job distributor
func NewJobDistributor() *JobDistributor {
	jd := &JobDistributor{
		jobQueue:    make(chan *MiningJob, 100),
		targetTime:  30 * time.Second,
		lastJobTime: time.Now(),
	}
	
	// Set initial job
	initialJob := &MiningJob{
		JobID:       "initial",
		BlockHeader: BlockHeader{Height: 1000000},
		Target:      make([]byte, 32),
		Creator:     "system",
		Timestamp:   time.Now(),
		ExpiresAt:   time.Now().Add(30 * time.Second),
		Height:      1000000,
		Difficulty:  1000000,
	}
	jd.currentJob.Store(initialJob)
	
	return jd
}

// SubmitJobToDistributor submits a job to the distributor
func (jd *JobDistributor) SubmitJobToDistributor(job *MiningJob) {
	jd.currentJob.Store(job)
	jd.lastJobTime = time.Now()
	jd.jobCounter.Add(1)
	
	// Add to queue (non-blocking)
	select {
	case jd.jobQueue <- job:
	default:
		// Queue full, ignore
	}
}

// GetCurrentJobFromDistributor returns the current job
func (jd *JobDistributor) GetCurrentJobFromDistributor() *MiningJob {
	if job := jd.currentJob.Load(); job != nil {
		return job.(*MiningJob)
	}
	return nil
}

// RegisterWorker registers a worker with the distributor
func (jd *JobDistributor) RegisterWorker(workerID string) {
	stats := &WorkerStats{
		ID:          workerID,
		LastShare:   time.Now(),
	}
	jd.workers.Store(workerID, stats)
}

// UnregisterWorker unregisters a worker
func (jd *JobDistributor) UnregisterWorker(workerID string) {
	jd.workers.Delete(workerID)
}

// UpdateWorkerStats updates worker statistics
func (jd *JobDistributor) UpdateWorkerStats(workerID string, hashRate uint64, shareAccepted bool) {
	if value, ok := jd.workers.Load(workerID); ok {
		stats := value.(*WorkerStats)
		stats.HashRate = hashRate
		stats.SharesSubmitted++
		if shareAccepted {
			stats.SharesAccepted++
		}
		stats.LastShare = time.Now()
	}
}

// GetAllWorkerStats returns all worker statistics
func (jd *JobDistributor) GetAllWorkerStats() []WorkerStats {
	var stats []WorkerStats
	
	jd.workers.Range(func(key, value interface{}) bool {
		if workerStat, ok := value.(*WorkerStats); ok {
			stats = append(stats, *workerStat)
		}
		return true
	})
	
	return stats
}

// ShouldCreateNewJob determines if a new job should be created
func (jd *JobDistributor) ShouldCreateNewJob() bool {
	return time.Since(jd.lastJobTime) > jd.targetTime
}

// GetJobCount returns the total number of jobs processed
func (jd *JobDistributor) GetJobCount() uint64 {
	return jd.jobCounter.Load()
}