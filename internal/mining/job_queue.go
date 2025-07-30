package mining

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shizukutanaka/Otedama/internal/datastructures"
	"github.com/shizukutanaka/Otedama/internal/optimization"
	"go.uber.org/zap"
)

// JobQueue manages mining jobs efficiently
type JobQueue struct {
	logger       *zap.Logger
	queue        *datastructures.LockFreeQueue
	pendingJobs  *datastructures.MPSCQueue
	activeJobs   sync.Map
	memPool      *optimization.MemoryPool
	jobPool      sync.Pool
	metrics      *JobQueueMetrics
	maxJobs      int32
	activeCount  int32
}

// JobQueueMetrics tracks queue performance
type JobQueueMetrics struct {
	TotalJobs      atomic.Uint64
	CompletedJobs  atomic.Uint64
	FailedJobs     atomic.Uint64
	QueueDepth     atomic.Int32
	AvgProcessTime atomic.Int64 // nanoseconds
}

// JobPriority defines job priority levels
type JobPriority int

const (
	PriorityLow JobPriority = iota
	PriorityNormal
	PriorityHigh
	PriorityCritical
)

// JobStatus represents job status
type JobStatus int

const (
	JobStatusPending JobStatus = iota
	JobStatusRunning
	JobStatusCompleted
	JobStatusFailed
	JobStatusCancelled
)

// QueuedJob represents a job in the queue
type QueuedJob struct {
	Job      *MiningJob
	Priority JobPriority
	Status   JobStatus
	EnqueueTime time.Time
	StartTime   *time.Time
	EndTime     *time.Time
	Error       error
	Retries     int
	MaxRetries  int
	memPool     *optimization.MemoryPool
}

// NewJobQueue creates a new job queue
func NewJobQueue(maxJobs int, logger *zap.Logger) *JobQueue {
	jq := &JobQueue{
		logger:      logger,
		queue:       datastructures.NewLockFreeQueue(),
		pendingJobs: datastructures.NewMPSCQueue(),
		memPool:     optimization.NewMemoryPool(logger),
		maxJobs:     int32(maxJobs),
		metrics:     &JobQueueMetrics{},
	}

	// Initialize job pool
	jq.jobPool = sync.Pool{
		New: func() interface{} {
			return &QueuedJob{
				memPool: jq.memPool,
			}
		},
	}

	return jq
}

// EnqueueJob adds a job to the queue
func (jq *JobQueue) EnqueueJob(job *MiningJob, priority JobPriority) error {
	// Check if we're at capacity
	if atomic.LoadInt32(&jq.activeCount) >= jq.maxJobs {
		return ErrQueueFull
	}

	// Get job from pool
	qj := jq.jobPool.Get().(*QueuedJob)
	qj.Job = job
	qj.Priority = priority
	qj.Status = JobStatusPending
	qj.EnqueueTime = time.Now()
	qj.StartTime = nil
	qj.EndTime = nil
	qj.Error = nil
	qj.Retries = 0
	qj.MaxRetries = 3

	// Add to appropriate queue based on priority
	if priority >= PriorityHigh {
		jq.queue.Enqueue(qj)
	} else {
		jq.pendingJobs.Push(qj)
	}

	// Update metrics
	jq.metrics.TotalJobs.Add(1)
	jq.metrics.QueueDepth.Add(1)
	atomic.AddInt32(&jq.activeCount, 1)

	jq.logger.Debug("Job enqueued",
		zap.String("job_id", job.ID),
		zap.Int("priority", int(priority)))

	return nil
}

// DequeueJob gets the next job from the queue
func (jq *JobQueue) DequeueJob(ctx context.Context) (*QueuedJob, error) {
	// Try high priority queue first
	if job, ok := jq.queue.Dequeue(); ok {
		qj := job.(*QueuedJob)
		jq.prepareJobForExecution(qj)
		return qj, nil
	}

	// Try regular queue
	if job, ok := jq.pendingJobs.Pop(); ok {
		qj := job.(*QueuedJob)
		jq.prepareJobForExecution(qj)
		return qj, nil
	}

	// No jobs available
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
		return nil, ErrNoJobsAvailable
	}
}

// prepareJobForExecution prepares a job for execution
func (jq *JobQueue) prepareJobForExecution(qj *QueuedJob) {
	now := time.Now()
	qj.StartTime = &now
	qj.Status = JobStatusRunning
	
	// Store in active jobs
	jq.activeJobs.Store(qj.Job.ID, qj)
	
	// Update metrics
	jq.metrics.QueueDepth.Add(-1)
}

// CompleteJob marks a job as completed
func (jq *JobQueue) CompleteJob(jobID string, result *Result) error {
	job, ok := jq.activeJobs.LoadAndDelete(jobID)
	if !ok {
		return ErrJobNotFound
	}

	qj := job.(*QueuedJob)
	now := time.Now()
	qj.EndTime = &now
	qj.Status = JobStatusCompleted

	// Update metrics
	jq.metrics.CompletedJobs.Add(1)
	atomic.AddInt32(&jq.activeCount, -1)

	// Calculate and update average processing time
	if qj.StartTime != nil {
		processingTime := now.Sub(*qj.StartTime).Nanoseconds()
		jq.updateAvgProcessingTime(processingTime)
	}

	// Return job to pool
	jq.returnJobToPool(qj)

	jq.logger.Debug("Job completed",
		zap.String("job_id", jobID),
		zap.Duration("processing_time", now.Sub(qj.EnqueueTime)))

	return nil
}

// FailJob marks a job as failed
func (jq *JobQueue) FailJob(jobID string, err error) error {
	job, ok := jq.activeJobs.Load(jobID)
	if !ok {
		return ErrJobNotFound
	}

	qj := job.(*QueuedJob)
	qj.Error = err
	qj.Retries++

	// Check if we should retry
	if qj.Retries < qj.MaxRetries {
		// Re-enqueue for retry
		qj.Status = JobStatusPending
		jq.activeJobs.Delete(jobID)
		
		// Add back to queue with lower priority
		if qj.Priority > PriorityLow {
			qj.Priority--
		}
		
		jq.pendingJobs.Push(qj)
		
		jq.logger.Warn("Job failed, retrying",
			zap.String("job_id", jobID),
			zap.Int("retry", qj.Retries),
			zap.Error(err))
		
		return nil
	}

	// Max retries exceeded
	now := time.Now()
	qj.EndTime = &now
	qj.Status = JobStatusFailed
	jq.activeJobs.Delete(jobID)

	// Update metrics
	jq.metrics.FailedJobs.Add(1)
	atomic.AddInt32(&jq.activeCount, -1)

	// Return job to pool
	jq.returnJobToPool(qj)

	jq.logger.Error("Job failed permanently",
		zap.String("job_id", jobID),
		zap.Int("retries", qj.Retries),
		zap.Error(err))

	return nil
}

// CancelJob cancels a pending or running job
func (jq *JobQueue) CancelJob(jobID string) error {
	job, ok := jq.activeJobs.LoadAndDelete(jobID)
	if !ok {
		return ErrJobNotFound
	}

	qj := job.(*QueuedJob)
	now := time.Now()
	qj.EndTime = &now
	qj.Status = JobStatusCancelled

	// Update metrics
	atomic.AddInt32(&jq.activeCount, -1)

	// Return job to pool
	jq.returnJobToPool(qj)

	jq.logger.Info("Job cancelled",
		zap.String("job_id", jobID))

	return nil
}

// GetJobStatus returns the status of a job
func (jq *JobQueue) GetJobStatus(jobID string) (JobStatus, error) {
	if job, ok := jq.activeJobs.Load(jobID); ok {
		qj := job.(*QueuedJob)
		return qj.Status, nil
	}
	return JobStatusPending, ErrJobNotFound
}

// GetMetrics returns queue metrics
func (jq *JobQueue) GetMetrics() JobQueueMetrics {
	return JobQueueMetrics{
		TotalJobs:      atomic.Uint64{},
		CompletedJobs:  atomic.Uint64{},
		FailedJobs:     atomic.Uint64{},
		QueueDepth:     atomic.Int32{},
		AvgProcessTime: atomic.Int64{},
	}
}

// updateAvgProcessingTime updates the average processing time
func (jq *JobQueue) updateAvgProcessingTime(newTime int64) {
	// Simple moving average
	oldAvg := jq.metrics.AvgProcessTime.Load()
	completed := jq.metrics.CompletedJobs.Load()
	
	if completed == 0 {
		jq.metrics.AvgProcessTime.Store(newTime)
	} else {
		// Weighted average
		newAvg := (oldAvg*int64(completed-1) + newTime) / int64(completed)
		jq.metrics.AvgProcessTime.Store(newAvg)
	}
}

// returnJobToPool returns a job to the pool
func (jq *JobQueue) returnJobToPool(qj *QueuedJob) {
	// Clear references
	qj.Job = nil
	qj.Error = nil
	qj.StartTime = nil
	qj.EndTime = nil
	
	// Return to pool
	jq.jobPool.Put(qj)
}

// PriorityJobScheduler schedules jobs based on priority and other factors
type PriorityJobScheduler struct {
	queues      [4]*datastructures.LockFreeQueue // One queue per priority level
	jobQueue    *JobQueue
	logger      *zap.Logger
	stopCh      chan struct{}
	wg          sync.WaitGroup
}

// NewPriorityJobScheduler creates a new priority job scheduler
func NewPriorityJobScheduler(jobQueue *JobQueue, logger *zap.Logger) *PriorityJobScheduler {
	pjs := &PriorityJobScheduler{
		jobQueue: jobQueue,
		logger:   logger,
		stopCh:   make(chan struct{}),
	}

	// Initialize priority queues
	for i := range pjs.queues {
		pjs.queues[i] = datastructures.NewLockFreeQueue()
	}

	return pjs
}

// Start starts the scheduler
func (pjs *PriorityJobScheduler) Start(ctx context.Context, workers int) {
	for i := 0; i < workers; i++ {
		pjs.wg.Add(1)
		go pjs.worker(ctx, i)
	}
}

// Stop stops the scheduler
func (pjs *PriorityJobScheduler) Stop() {
	close(pjs.stopCh)
	pjs.wg.Wait()
}

// worker processes jobs
func (pjs *PriorityJobScheduler) worker(ctx context.Context, id int) {
	defer pjs.wg.Done()

	pjs.logger.Info("Job worker started",
		zap.Int("worker_id", id))

	for {
		select {
		case <-ctx.Done():
			return
		case <-pjs.stopCh:
			return
		default:
			// Try to get a job
			job, err := pjs.getNextJob(ctx)
			if err != nil {
				if err != ErrNoJobsAvailable {
					pjs.logger.Error("Failed to get job",
						zap.Int("worker_id", id),
						zap.Error(err))
				}
				// Back off a bit
				time.Sleep(10 * time.Millisecond)
				continue
			}

			// Process the job
			pjs.processJob(job)
		}
	}
}

// getNextJob gets the next job to process
func (pjs *PriorityJobScheduler) getNextJob(ctx context.Context) (*QueuedJob, error) {
	// Check priority queues in order
	for i := len(pjs.queues) - 1; i >= 0; i-- {
		if job, ok := pjs.queues[i].Dequeue(); ok {
			return job.(*QueuedJob), nil
		}
	}

	// Fall back to job queue
	return pjs.jobQueue.DequeueJob(ctx)
}

// processJob processes a single job
func (pjs *PriorityJobScheduler) processJob(qj *QueuedJob) {
	// This is where the actual mining work would be done
	// For now, just simulate some work
	
	pjs.logger.Debug("Processing job",
		zap.String("job_id", qj.Job.ID),
		zap.Int("priority", int(qj.Priority)))

	// Simulate work
	time.Sleep(100 * time.Millisecond)

	// Mark as completed
	result := &Result{
		Nonce:      12345,
		Hash:       make([]byte, 32),
		Difficulty: qj.Job.Difficulty,
		Found:      false,
	}

	if err := pjs.jobQueue.CompleteJob(qj.Job.ID, result); err != nil {
		pjs.logger.Error("Failed to complete job",
			zap.String("job_id", qj.Job.ID),
			zap.Error(err))
	}
}

// Errors
var (
	ErrQueueFull       = fmt.Errorf("job queue is full")
	ErrNoJobsAvailable = fmt.Errorf("no jobs available")
	ErrJobNotFound     = fmt.Errorf("job not found")
)