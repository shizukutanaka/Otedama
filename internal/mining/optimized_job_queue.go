package mining

import (
	"container/heap"
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"go.uber.org/zap"
)

// OptimizedJobQueue implements a high-performance job queue with advanced features
// John Carmack's cache-aware design with Rob Pike's channel patterns
type OptimizedJobQueue struct {
	logger *zap.Logger
	
	// Ring buffers for lock-free operations
	rings      [3]*RingBuffer // High, Normal, Low priority
	
	// Priority heap for complex scheduling
	heap       *JobHeap
	heapMu     sync.Mutex
	
	// Job tracking
	jobMap     sync.Map // map[string]*Job
	
	// Worker notification
	notify     chan struct{}
	
	// Metrics - cache-aligned
	metrics    QueueMetrics
	
	// Configuration
	config     QueueConfig
	
	// Lifecycle
	ctx        context.Context
	cancel     context.CancelFunc
	wg         sync.WaitGroup
}

// RingBuffer provides lock-free job queue
type RingBuffer struct {
	buffer    []JobLike // Store interface type
	mask      uint64
	head      atomic.Uint64
	tail      atomic.Uint64
	_padding0 [64 - unsafe.Sizeof(atomic.Uint64{})*2]byte // Avoid false sharing
}

// JobHeap implements a priority queue for JobLike items
type JobHeap []JobLike

// QueueMetrics tracks performance metrics
type QueueMetrics struct {
	enqueued      atomic.Uint64
	dequeued      atomic.Uint64
	completed     atomic.Uint64
	expired       atomic.Uint64
	rejected      atomic.Uint64
	avgWaitTime   atomic.Uint64 // nanoseconds
	maxQueueDepth atomic.Uint64
	_padding      [64 - unsafe.Sizeof(atomic.Uint64{})*6]byte
}

// QueueConfig defines queue configuration
type QueueConfig struct {
	RingSize          int           `json:"ring_size"`
	MaxJobs           int           `json:"max_jobs"`
	JobTimeout        time.Duration `json:"job_timeout"`
	CleanupInterval   time.Duration `json:"cleanup_interval"`
	EnablePriorityAge bool          `json:"enable_priority_age"`
	MaxJobAge         time.Duration `json:"max_job_age"`
}

// NewOptimizedJobQueue creates an optimized job queue
func NewOptimizedJobQueue(logger *zap.Logger, config QueueConfig) *OptimizedJobQueue {
	// Set defaults
	if config.RingSize == 0 {
		config.RingSize = 4096
	}
	if config.JobTimeout == 0 {
		config.JobTimeout = 30 * time.Second
	}
	if config.CleanupInterval == 0 {
		config.CleanupInterval = 5 * time.Second
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	q := &OptimizedJobQueue{
		logger: logger,
		heap:   &JobHeap{},
		notify: make(chan struct{}, 1),
		config: config,
		ctx:    ctx,
		cancel: cancel,
	}
	
	// Initialize ring buffers
	for i := 0; i < 3; i++ {
		q.rings[i] = newRingBuffer(config.RingSize)
	}
	
	// Initialize heap
	heap.Init(q.heap)
	
	// Start background workers
	q.wg.Add(2)
	go q.cleanupWorker()
	go q.metricsWorker()
	
	return q
}

// newRingBuffer creates a new ring buffer
func newRingBuffer(size int) *RingBuffer {
	// Ensure size is power of 2
	actualSize := 1
	for actualSize < size {
		actualSize <<= 1
	}
	
	return &RingBuffer{
		buffer: make([]JobLike, actualSize),
		mask:   uint64(actualSize - 1),
	}
}

// Enqueue adds a job to the queue (supports batch, handles MiningJob/Job)
func (q *OptimizedJobQueue) Enqueue(jobOrBatch interface{}) error {
	switch v := jobOrBatch.(type) {
	case *MiningJob:
		return q.enqueueMiningJob(v)
	case []*MiningJob:
		var firstErr error
		for _, mj := range v {
			err := q.enqueueMiningJob(mj)
			if err != nil && firstErr == nil {
				firstErr = err
			}
		}
		return firstErr
	case *Job:
		return q.enqueueOne(v)
	case []*Job:
		var firstErr error
		for _, job := range v {
			err := q.enqueueOne(job)
			if err != nil && firstErr == nil {
				firstErr = err
			}
		}
		return firstErr
	default:
		return errors.New("invalid job type")
	}
}

// enqueueMiningJob handles MiningJob with retry/priority
func (q *OptimizedJobQueue) enqueueMiningJob(mj *MiningJob) error {
	if mj == nil || mj.ID == "" {
		return errors.New("invalid mining job")
	}
	currentJobs := q.metrics.enqueued.Load() - q.metrics.dequeued.Load() - q.metrics.expired.Load()
	if currentJobs >= uint64(q.config.MaxJobs) {
		q.metrics.rejected.Add(1)
		return errors.New("queue full")
	}
	if mj.CreatedAt.IsZero() {
		mj.CreatedAt = time.Now()
	}
	if mj.ExpiresAt.IsZero() {
		mj.ExpiresAt = mj.CreatedAt.Add(q.config.JobTimeout)
	}
	q.jobMap.Store(mj.GetID(), mj)
	priority := mj.GetPriority()
	if priority >= 0 && priority < 3 {
		if q.rings[priority].Push(mj) {
			q.metrics.enqueued.Add(1)
			q.notifyWorkers()
			return nil
		}
	}
	q.heapMu.Lock()
	heap.Push(q.heap, mj)
	q.heapMu.Unlock()
	q.metrics.enqueued.Add(1)
	q.updateMaxDepth(currentJobs + 1)
	q.notifyWorkers()
	return nil
}

// enqueueOne is legacy Job logic
func (q *OptimizedJobQueue) enqueueOne(job *Job) error {
	if job == nil || job.ID == "" {
		return errors.New("invalid job")
	}
	currentJobs := q.metrics.enqueued.Load() - q.metrics.dequeued.Load() - q.metrics.expired.Load()
	if currentJobs >= uint64(q.config.MaxJobs) {
		q.metrics.rejected.Add(1)
		return errors.New("queue full")
	}
	// No CreatedAt/ExpiresAt/RetryCount for legacy Job
	q.jobMap.Store(job.GetID(), job)
	priority := job.GetPriority()
	if priority >= 0 && priority < 3 {
		if q.rings[priority].Push(job) {
			q.metrics.enqueued.Add(1)
			q.notifyWorkers()
			return nil
		}
	}
	q.heapMu.Lock()
	heap.Push(q.heap, job)
	q.heapMu.Unlock()
	q.metrics.enqueued.Add(1)
	q.updateMaxDepth(currentJobs + 1)
	q.notifyWorkers()
	return nil
}

// isValidJob checks if a job is valid
func (q *OptimizedJobQueue) isValidJob(job JobLike) bool {
	if job == nil || job.GetID() == "" {
		return false
	}
	currentJobs := q.metrics.enqueued.Load() - q.metrics.dequeued.Load() - q.metrics.expired.Load()
	if currentJobs >= uint64(q.config.MaxJobs) {
		return false
	}
	return true
}

// Dequeue retrieves the next job (supports batch and retry)
func (q *OptimizedJobQueue) Dequeue(ctx context.Context) (interface{}, error) {
	return q.dequeueBatch(ctx, 1)
}

// DequeueBatch retrieves up to batchSize jobs (returns first job for compatibility)
func (q *OptimizedJobQueue) dequeueBatch(ctx context.Context, batchSize int) (interface{}, error) {
	startTime := time.Now()
	var jobs []JobLike
	for {
		// Check context
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}
		// Try each priority ring
		for p := 0; p < 3; p++ {
			for i := 0; i < batchSize; i++ {
				if job := q.rings[p].Pop(); job != nil && q.isValidJob(job) {
					jobs = append(jobs, job)
					if len(jobs) == batchSize {
						break
					}
				}
			}
			if len(jobs) == batchSize {
				break
			}
		}
		if len(jobs) > 0 {
			for _, job := range jobs {
				q.recordDequeue(job, startTime)
			}
			return jobs[0], nil // for compatibility
		}
		// Try heap
		q.heapMu.Lock()
		for i := 0; i < batchSize && q.heap.Len() > 0; i++ {
			job := heap.Pop(q.heap).(JobLike)
			if q.isValidJob(job) {
				jobs = append(jobs, job)
			}
		}
		q.heapMu.Unlock()
		if len(jobs) > 0 {
			for _, job := range jobs {
				q.recordDequeue(job, startTime)
			}
			return jobs[0], nil
		}
		// Wait for notification or timeout
		select {
		case <-q.notify:
			continue
		case <-time.After(10 * time.Millisecond):
			continue
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// Retry logic (called externally if job fails)
func (q *OptimizedJobQueue) Retry(job interface{}) {
	switch j := job.(type) {
	case *MiningJob:
		j.IncRetryCount()
		q.Enqueue(j)
	case *Job:
		// No retry logic for legacy Job
		q.metrics.expired.Add(1)
		q.logger.Warn("Legacy Job expired after retries", zap.String("id", j.ID))
	}
}

// CompleteJob marks a job as completed
func (q *OptimizedJobQueue) CompleteJob(job interface{}) {
	if job == nil {
		return
	}

	switch j := job.(type) {
	case *MiningJob:
		q.metrics.completed.Add(1)
		q.jobMap.Delete(j.GetID())
		if j.OnComplete != nil {
			j.OnComplete(&JobResult{JobID: j.GetID(), Success: true})
		}
	case *Job:
		q.metrics.completed.Add(1)
		q.jobMap.Delete(j.GetID())
		// No OnComplete for legacy Job
	default:
		// To handle the case where job is JobLike but not a pointer type
		if jobLike, ok := job.(JobLike); ok {
			q.jobMap.Delete(jobLike.GetID())
		}
	}
}

// Cancel removes a job from the queue
func (q *OptimizedJobQueue) Cancel(jobID string) bool {
	if _, exists := q.jobMap.Load(jobID); exists {
		q.jobMap.Delete(jobID)
		return true
	}
	return false
}

// GetStats returns queue statistics
func (q *OptimizedJobQueue) GetStats() QueueStats {
	enqueued := q.metrics.enqueued.Load()
	dequeued := q.metrics.dequeued.Load()
	completed := q.metrics.completed.Load()
	expired := q.metrics.expired.Load()
	rejected := q.metrics.rejected.Load()
	
	return QueueStats{
		Enqueued:      enqueued,
		Dequeued:      dequeued,
		Completed:     completed,
		Expired:       expired,
		Rejected:      rejected,
		Pending:       enqueued - dequeued - expired,
		AvgWaitTime:   time.Duration(q.metrics.avgWaitTime.Load()),
		MaxQueueDepth: q.metrics.maxQueueDepth.Load(),
	}
}

// RingBuffer methods

// Push adds a job to the ring buffer
func (rb *RingBuffer) Push(job JobLike) bool {
	for {
		head := rb.head.Load()
		tail := rb.tail.Load()
		
		// Check if full
		if head-tail >= uint64(len(rb.buffer)) {
			return false
		}
		
		// Try to claim slot
		if rb.head.CompareAndSwap(head, head+1) {
			rb.buffer[head&rb.mask] = job
			return true
		}
	}
}

// Pop removes a job from the ring buffer
func (rb *RingBuffer) Pop() JobLike {
	for {
		tail := rb.tail.Load()
		head := rb.head.Load()
		
		// Check if empty
		if tail >= head {
			return nil
		}
		
		// Try to claim slot
		if rb.tail.CompareAndSwap(tail, tail+1) {
			job := rb.buffer[tail&rb.mask]
			rb.buffer[tail&rb.mask] = nil // Help GC
			return job
		}
	}
}

// JobHeap methods for heap.Interface

func (h JobHeap) Len() int           { return len(h) }
func (h JobHeap) Less(i, j int) bool {
	// Higher priority value means more important
	p1 := h[i].GetPriority()
	p2 := h[j].GetPriority()
	if p1 != p2 {
		return p1 > p2
	}
	// If priority is the same, older job is more important
	return h[i].GetCreationTime().Before(h[j].GetCreationTime())
}
func (h JobHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }

func (h *JobHeap) Push(x interface{}) {
	*h = append(*h, x.(JobLike))
}

func (h *JobHeap) Pop() interface{} {
	old := *h
	n := len(old)
	x := old[n-1]
	*h = old[0 : n-1]
	return x
}

func (q *OptimizedJobQueue) recordDequeue(job JobLike, startTime time.Time) {
	q.metrics.dequeued.Add(1)
	
	// Update average wait time
	waitTime := uint64(time.Since(startTime).Nanoseconds())
	oldAvg := q.metrics.avgWaitTime.Load()
	count := q.metrics.dequeued.Load()
	newAvg := (oldAvg*(count-1) + waitTime) / count
	q.metrics.avgWaitTime.Store(newAvg)
}

func (q *OptimizedJobQueue) updateMaxDepth(depth uint64) {
	for {
		current := q.metrics.maxQueueDepth.Load()
		if depth <= current || q.metrics.maxQueueDepth.CompareAndSwap(current, depth) {
			break
		}
	}
}

func (q *OptimizedJobQueue) notifyWorkers() {
	select {
	case q.notify <- struct{}{}:
	default:
	}
}

// Background workers

func (q *OptimizedJobQueue) cleanupWorker() {
	defer q.wg.Done()
	
	ticker := time.NewTicker(q.config.CleanupInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			q.cleanupExpiredJobs()
		case <-q.ctx.Done():
			return
		}
	}
}

func (q *OptimizedJobQueue) cleanupExpiredJobs() {
	var expired []string
	
	q.jobMap.Range(func(key, value interface{}) bool {
		job := value.(*Job)
		if time.Now().After(job.ExpiresAt) {
			expired = append(expired, key.(string))
		}
		return true
	})
	
	for _, id := range expired {
		q.jobMap.Delete(id)
		q.metrics.expired.Add(1)
	}
	
	if len(expired) > 0 {
		q.logger.Debug("Cleaned up expired jobs", zap.Int("count", len(expired)))
	}
}

func (q *OptimizedJobQueue) metricsWorker() {
	defer q.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			stats := q.GetStats()
			q.logger.Info("Queue statistics",
				zap.Uint64("pending", stats.Pending),
				zap.Uint64("completed", stats.Completed),
				zap.Duration("avg_wait", stats.AvgWaitTime),
			)
		case <-q.ctx.Done():
			return
		}
	}
}

// Close shuts down the queue
func (q *OptimizedJobQueue) Close() error {
	q.cancel()
	q.wg.Wait()
	
	// Clear remaining jobs
	q.jobMap.Range(func(key, value interface{}) bool {
		q.jobMap.Delete(key)
		return true
	})
	
	return nil
}



// Job priority helpers

func (j *Job) Priority() int {
    // Map algorithm priorities
    switch j.Algorithm {
    case SHA256D:
        return 0 // High priority
    case Scrypt:
        return 1 // Normal priority
    default:
        return 2 // Low priority
    }
}

func (j *Job) ComparePriority(other *Job) int {
	// Higher priority first
	if j.Priority() != other.Priority() {
		return j.Priority() - other.Priority()
	}
	
	// Earlier jobs first
	if j.CreatedAt.Before(other.CreatedAt) {
		return -1
	} else if j.CreatedAt.After(other.CreatedAt) {
		return 1
	}
	
	return 0
}