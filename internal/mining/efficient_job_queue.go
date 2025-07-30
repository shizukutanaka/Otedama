package mining

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// EfficientJobQueue provides high-performance job queue management
// Following Rob Pike's principle: "Don't communicate by sharing memory; share memory by communicating"
type EfficientJobQueue struct {
	logger *zap.Logger
	
	// Job channels for different priorities
	highPriority   chan *MiningJob
	normalPriority chan *MiningJob
	lowPriority    chan *MiningJob
	
	// Active jobs tracking
	activeJobs  map[string]*MiningJob
	jobsMutex   sync.RWMutex
	
	// Performance metrics
	stats struct {
		enqueued   atomic.Uint64
		dequeued   atomic.Uint64
		completed  atomic.Uint64
		expired    atomic.Uint64
		inProgress atomic.Int32
	}
	
	// Configuration
	maxQueueSize int
	jobTimeout   time.Duration
	
	// Lifecycle
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// MiningJob represents a mining job
type MiningJob struct {
	ID         string
	Algorithm  Algorithm
	Target     []byte
	BlockData  []byte
	ExtraNonce uint32
	Height     uint64
	Difficulty uint64
	Priority   JobPriority
	CreatedAt  time.Time
	ExpiresAt  time.Time
	
	// Callback for completion
	OnComplete func(*JobResult)
}

// JobPriority defines job priority levels
type JobPriority int

const (
	PriorityLow JobPriority = iota
	PriorityNormal
	PriorityHigh
)

// JobResult contains the result of a mining job
type JobResult struct {
	JobID     string
	Success   bool
	Nonce     uint64
	Hash      []byte
	Timestamp time.Time
}

// NewEfficientJobQueue creates a new job queue
func NewEfficientJobQueue(logger *zap.Logger) *EfficientJobQueue {
	ctx, cancel := context.WithCancel(context.Background())
	
	jq := &EfficientJobQueue{
		logger:         logger,
		highPriority:   make(chan *MiningJob, 100),
		normalPriority: make(chan *MiningJob, 1000),
		lowPriority:    make(chan *MiningJob, 5000),
		activeJobs:     make(map[string]*MiningJob),
		maxQueueSize:   10000,
		jobTimeout:     30 * time.Second,
		ctx:            ctx,
		cancel:         cancel,
	}
	
	// Start background workers
	jq.wg.Add(1)
	go jq.expirationWorker()
	
	return jq
}

// Enqueue adds a job to the queue
func (jq *EfficientJobQueue) Enqueue(job *MiningJob) error {
	if job == nil || job.ID == "" {
		return errors.New("invalid job")
	}
	
	// Set default expiration if not set
	if job.ExpiresAt.IsZero() {
		job.ExpiresAt = time.Now().Add(jq.jobTimeout)
	}
	
	// Check queue capacity
	if jq.getQueueSize() >= jq.maxQueueSize {
		return errors.New("queue full")
	}
	
	// Select appropriate queue based on priority
	var targetQueue chan *MiningJob
	switch job.Priority {
	case PriorityHigh:
		targetQueue = jq.highPriority
	case PriorityNormal:
		targetQueue = jq.normalPriority
	case PriorityLow:
		targetQueue = jq.lowPriority
	default:
		targetQueue = jq.normalPriority
	}
	
	// Try to enqueue with timeout
	select {
	case targetQueue <- job:
		jq.stats.enqueued.Add(1)
		
		// Track active job
		jq.jobsMutex.Lock()
		jq.activeJobs[job.ID] = job
		jq.jobsMutex.Unlock()
		
		jq.logger.Debug("Job enqueued",
			zap.String("job_id", job.ID),
			zap.String("priority", job.Priority.String()),
		)
		return nil
		
	case <-time.After(100 * time.Millisecond):
		return errors.New("enqueue timeout")
	}
}

// Dequeue retrieves the next job from the queue
func (jq *EfficientJobQueue) Dequeue(ctx context.Context) (*MiningJob, error) {
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
			
		// High priority first
		case job := <-jq.highPriority:
			if jq.isJobValid(job) {
				jq.stats.dequeued.Add(1)
				jq.stats.inProgress.Add(1)
				return job, nil
			}
			
		// Then normal priority
		case job := <-jq.normalPriority:
			if jq.isJobValid(job) {
				jq.stats.dequeued.Add(1)
				jq.stats.inProgress.Add(1)
				return job, nil
			}
			
		// Finally low priority
		case job := <-jq.lowPriority:
			if jq.isJobValid(job) {
				jq.stats.dequeued.Add(1)
				jq.stats.inProgress.Add(1)
				return job, nil
			}
			
		// Non-blocking check for high priority
		default:
			select {
			case job := <-jq.highPriority:
				if jq.isJobValid(job) {
					jq.stats.dequeued.Add(1)
					jq.stats.inProgress.Add(1)
					return job, nil
				}
			case <-time.After(10 * time.Millisecond):
				// Continue loop to check all priorities
			}
		}
	}
}

// CompleteJob marks a job as completed
func (jq *EfficientJobQueue) CompleteJob(jobID string, result *JobResult) {
	jq.jobsMutex.Lock()
	job, exists := jq.activeJobs[jobID]
	if exists {
		delete(jq.activeJobs, jobID)
	}
	jq.jobsMutex.Unlock()
	
	if !exists {
		jq.logger.Warn("Completed unknown job", zap.String("job_id", jobID))
		return
	}
	
	jq.stats.completed.Add(1)
	jq.stats.inProgress.Add(-1)
	
	// Call completion callback if provided
	if job.OnComplete != nil {
		go job.OnComplete(result)
	}
	
	jq.logger.Debug("Job completed",
		zap.String("job_id", jobID),
		zap.Bool("success", result.Success),
	)
}

// CancelJob cancels a job
func (jq *EfficientJobQueue) CancelJob(jobID string) bool {
	jq.jobsMutex.Lock()
	defer jq.jobsMutex.Unlock()
	
	if _, exists := jq.activeJobs[jobID]; exists {
		delete(jq.activeJobs, jobID)
		jq.stats.inProgress.Add(-1)
		return true
	}
	
	return false
}

// GetStats returns queue statistics
func (jq *EfficientJobQueue) GetStats() QueueStats {
	jq.jobsMutex.RLock()
	activeCount := len(jq.activeJobs)
	jq.jobsMutex.RUnlock()
	
	return QueueStats{
		Enqueued:   jq.stats.enqueued.Load(),
		Dequeued:   jq.stats.dequeued.Load(),
		Completed:  jq.stats.completed.Load(),
		Expired:    jq.stats.expired.Load(),
		InProgress: jq.stats.inProgress.Load(),
		Active:     activeCount,
		QueueSizes: map[string]int{
			"high":   len(jq.highPriority),
			"normal": len(jq.normalPriority),
			"low":    len(jq.lowPriority),
		},
	}
}

// Shutdown gracefully shuts down the queue
func (jq *EfficientJobQueue) Shutdown() {
	jq.cancel()
	jq.wg.Wait()
	
	// Close channels
	close(jq.highPriority)
	close(jq.normalPriority)
	close(jq.lowPriority)
	
	jq.logger.Info("Job queue shutdown complete")
}

// Private methods

func (jq *EfficientJobQueue) getQueueSize() int {
	return len(jq.highPriority) + len(jq.normalPriority) + len(jq.lowPriority)
}

func (jq *EfficientJobQueue) isJobValid(job *MiningJob) bool {
	// Check if job has expired
	if time.Now().After(job.ExpiresAt) {
		jq.jobsMutex.Lock()
		delete(jq.activeJobs, job.ID)
		jq.jobsMutex.Unlock()
		
		jq.stats.expired.Add(1)
		return false
	}
	
	return true
}

func (jq *EfficientJobQueue) expirationWorker() {
	defer jq.wg.Done()
	
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-jq.ctx.Done():
			return
		case <-ticker.C:
			jq.cleanExpiredJobs()
		}
	}
}

func (jq *EfficientJobQueue) cleanExpiredJobs() {
	now := time.Now()
	
	jq.jobsMutex.Lock()
	defer jq.jobsMutex.Unlock()
	
	for id, job := range jq.activeJobs {
		if now.After(job.ExpiresAt) {
			delete(jq.activeJobs, id)
			jq.stats.expired.Add(1)
			
			jq.logger.Debug("Job expired",
				zap.String("job_id", id),
				zap.Time("expired_at", job.ExpiresAt),
			)
		}
	}
}

// String returns string representation of priority
func (p JobPriority) String() string {
	switch p {
	case PriorityHigh:
		return "high"
	case PriorityNormal:
		return "normal"
	case PriorityLow:
		return "low"
	default:
		return "unknown"
	}
}

// QueueStats contains queue statistics
type QueueStats struct {
	Enqueued   uint64
	Dequeued   uint64
	Completed  uint64
	Expired    uint64
	InProgress int32
	Active     int
	QueueSizes map[string]int
}

// WorkerPool manages mining workers with job assignments
type WorkerPool struct {
	logger    *zap.Logger
	queue     *EfficientJobQueue
	workers   []*Worker
	workerWg  sync.WaitGroup
	
	// Configuration
	numWorkers int
	
	// State
	running atomic.Bool
	ctx     context.Context
	cancel  context.CancelFunc
}

// Worker represents a mining worker
type Worker struct {
	id       int
	logger   *zap.Logger
	queue    *EfficientJobQueue
	ctx      context.Context
	
	// Performance tracking
	jobsCompleted atomic.Uint64
	hashesComputed atomic.Uint64
}

// NewWorkerPool creates a new worker pool
func NewWorkerPool(logger *zap.Logger, queue *EfficientJobQueue, numWorkers int) *WorkerPool {
	ctx, cancel := context.WithCancel(context.Background())
	
	wp := &WorkerPool{
		logger:     logger,
		queue:      queue,
		numWorkers: numWorkers,
		workers:    make([]*Worker, numWorkers),
		ctx:        ctx,
		cancel:     cancel,
	}
	
	// Create workers
	for i := 0; i < numWorkers; i++ {
		wp.workers[i] = &Worker{
			id:     i,
			logger: logger,
			queue:  queue,
			ctx:    ctx,
		}
	}
	
	return wp
}

// Start starts all workers
func (wp *WorkerPool) Start() error {
	if !wp.running.CompareAndSwap(false, true) {
		return errors.New("worker pool already running")
	}
	
	// Start workers
	for _, worker := range wp.workers {
		wp.workerWg.Add(1)
		go worker.run(&wp.workerWg)
	}
	
	wp.logger.Info("Worker pool started", zap.Int("workers", wp.numWorkers))
	return nil
}

// Stop stops all workers
func (wp *WorkerPool) Stop() {
	if wp.running.CompareAndSwap(true, false) {
		wp.cancel()
		wp.workerWg.Wait()
		wp.logger.Info("Worker pool stopped")
	}
}

// GetWorkerStats returns statistics for all workers
func (wp *WorkerPool) GetWorkerStats() []WorkerStats {
	stats := make([]WorkerStats, len(wp.workers))
	
	for i, worker := range wp.workers {
		stats[i] = WorkerStats{
			ID:             worker.id,
			JobsCompleted:  worker.jobsCompleted.Load(),
			HashesComputed: worker.hashesComputed.Load(),
		}
	}
	
	return stats
}

// WorkerStats contains worker statistics
type WorkerStats struct {
	ID             int
	JobsCompleted  uint64
	HashesComputed uint64
}

func (w *Worker) run(wg *sync.WaitGroup) {
	defer wg.Done()
	
	w.logger.Debug("Worker started", zap.Int("worker_id", w.id))
	
	for {
		// Get next job
		job, err := w.queue.Dequeue(w.ctx)
		if err != nil {
			if err == context.Canceled {
				break
			}
			continue
		}
		
		// Process job
		result := w.processJob(job)
		
		// Complete job
		w.queue.CompleteJob(job.ID, result)
		w.jobsCompleted.Add(1)
	}
	
	w.logger.Debug("Worker stopped", zap.Int("worker_id", w.id))
}

func (w *Worker) processJob(job *MiningJob) *JobResult {
	// Simulate mining work
	// In real implementation, this would perform actual mining
	
	startTime := time.Now()
	
	// Simulate hash computations
	hashes := uint64(1000000) // 1M hashes
	w.hashesComputed.Add(hashes)
	
	// Simulate finding a solution
	success := time.Now().UnixNano()%10 == 0 // 10% success rate
	
	return &JobResult{
		JobID:     job.ID,
		Success:   success,
		Nonce:     uint64(time.Now().UnixNano()),
		Hash:      make([]byte, 32), // Placeholder
		Timestamp: startTime,
	}
}

// JobScheduler provides intelligent job scheduling
type JobScheduler struct {
	logger *zap.Logger
	queue  *EfficientJobQueue
	
	// Scheduling policies
	policies map[string]SchedulingPolicy
	
	// Current policy
	currentPolicy atomic.Value // stores SchedulingPolicy
}

// SchedulingPolicy defines how jobs are scheduled
type SchedulingPolicy interface {
	Score(job *MiningJob) int
	Name() string
}

// ProfitabilityPolicy schedules based on profitability
type ProfitabilityPolicy struct{}

func (p *ProfitabilityPolicy) Score(job *MiningJob) int {
	// Higher difficulty = higher potential profit
	return int(job.Difficulty / 1000000)
}

func (p *ProfitabilityPolicy) Name() string {
	return "profitability"
}

// FairnessPolicy ensures fair distribution
type FairnessPolicy struct {
	workerScores map[string]int
	mu           sync.Mutex
}

func (p *FairnessPolicy) Score(job *MiningJob) int {
	// Implement round-robin or weighted fair queueing
	return 100 // Equal priority for all
}

func (p *FairnessPolicy) Name() string {
	return "fairness"
}

// NewJobScheduler creates a new job scheduler
func NewJobScheduler(logger *zap.Logger, queue *EfficientJobQueue) *JobScheduler {
	js := &JobScheduler{
		logger:   logger,
		queue:    queue,
		policies: make(map[string]SchedulingPolicy),
	}
	
	// Register default policies
	js.RegisterPolicy(&ProfitabilityPolicy{})
	js.RegisterPolicy(&FairnessPolicy{workerScores: make(map[string]int)})
	
	// Set default policy
	js.SetPolicy("profitability")
	
	return js
}

// RegisterPolicy registers a scheduling policy
func (js *JobScheduler) RegisterPolicy(policy SchedulingPolicy) {
	js.policies[policy.Name()] = policy
}

// SetPolicy sets the active scheduling policy
func (js *JobScheduler) SetPolicy(name string) error {
	policy, exists := js.policies[name]
	if !exists {
		return errors.New("unknown policy")
	}
	
	js.currentPolicy.Store(policy)
	js.logger.Info("Scheduling policy changed", zap.String("policy", name))
	return nil
}

// ScheduleJob schedules a job with the current policy
func (js *JobScheduler) ScheduleJob(job *MiningJob) error {
	policy := js.currentPolicy.Load().(SchedulingPolicy)
	
	// Calculate priority based on policy
	score := policy.Score(job)
	if score > 1000 {
		job.Priority = PriorityHigh
	} else if score > 100 {
		job.Priority = PriorityNormal
	} else {
		job.Priority = PriorityLow
	}
	
	return js.queue.Enqueue(job)
}