package queue

import (
	"container/heap"
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"
)

// PriorityQueue implements a priority job queue
type PriorityQueue struct {
	items      *priorityHeap
	itemsMu    sync.RWMutex
	
	// Channels
	jobChan    chan Job
	resultChan chan Result
	
	// Configuration
	maxSize    int
	maxWorkers int
	
	// Statistics
	totalJobs      atomic.Uint64
	completedJobs  atomic.Uint64
	failedJobs     atomic.Uint64
	droppedJobs    atomic.Uint64
	avgWaitTime    atomic.Int64 // nanoseconds
	
	// Control
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// Job represents a prioritized job
type Job interface {
	ID() string
	Priority() int
	Execute(context.Context) (interface{}, error)
	Deadline() time.Time
	Weight() int
}

// Result represents job execution result
type Result struct {
	JobID    string
	Success  bool
	Data     interface{}
	Error    error
	Duration time.Duration
}

// BaseJob provides common job implementation
type BaseJob struct {
	id       string
	priority int
	deadline time.Time
	weight   int
	fn       func(context.Context) (interface{}, error)
}

// priorityItem wraps a job for the heap
type priorityItem struct {
	job       Job
	index     int
	timestamp time.Time
}

// priorityHeap implements heap.Interface
type priorityHeap []*priorityItem

// PriorityQueueConfig holds queue configuration
type PriorityQueueConfig struct {
	MaxSize    int
	MaxWorkers int
}

// DefaultPriorityQueueConfig returns default configuration
func DefaultPriorityQueueConfig() *PriorityQueueConfig {
	return &PriorityQueueConfig{
		MaxSize:    10000,
		MaxWorkers: 10,
	}
}

// NewPriorityQueue creates a new priority queue
func NewPriorityQueue(ctx context.Context, config *PriorityQueueConfig) *PriorityQueue {
	if config == nil {
		config = DefaultPriorityQueueConfig()
	}
	
	ctx, cancel := context.WithCancel(ctx)
	
	pq := &PriorityQueue{
		items:      &priorityHeap{},
		jobChan:    make(chan Job, config.MaxWorkers),
		resultChan: make(chan Result, config.MaxWorkers),
		maxSize:    config.MaxSize,
		maxWorkers: config.MaxWorkers,
		ctx:        ctx,
		cancel:     cancel,
	}
	
	heap.Init(pq.items)
	
	// Start workers
	for i := 0; i < config.MaxWorkers; i++ {
		pq.wg.Add(1)
		go pq.worker(i)
	}
	
	// Start dispatcher
	pq.wg.Add(1)
	go pq.dispatcher()
	
	return pq
}

// Submit submits a job to the queue
func (pq *PriorityQueue) Submit(job Job) error {
	pq.itemsMu.Lock()
	defer pq.itemsMu.Unlock()
	
	// Check queue size
	if pq.items.Len() >= pq.maxSize {
		pq.droppedJobs.Add(1)
		return errors.New("queue full")
	}
	
	// Add to heap
	item := &priorityItem{
		job:       job,
		timestamp: time.Now(),
	}
	
	heap.Push(pq.items, item)
	pq.totalJobs.Add(1)
	
	return nil
}

// dispatcher dispatches jobs to workers
func (pq *PriorityQueue) dispatcher() {
	defer pq.wg.Done()
	
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			pq.dispatchNext()
			
		case <-pq.ctx.Done():
			return
		}
	}
}

// dispatchNext dispatches the next job
func (pq *PriorityQueue) dispatchNext() {
	pq.itemsMu.Lock()
	
	if pq.items.Len() == 0 {
		pq.itemsMu.Unlock()
		return
	}
	
	// Get highest priority job
	item := heap.Pop(pq.items).(*priorityItem)
	pq.itemsMu.Unlock()
	
	// Update wait time statistics
	waitTime := time.Since(item.timestamp)
	pq.updateAvgWaitTime(waitTime)
	
	// Check deadline
	if !item.job.Deadline().IsZero() && time.Now().After(item.job.Deadline()) {
		pq.droppedJobs.Add(1)
		return
	}
	
	// Send to worker
	select {
	case pq.jobChan <- item.job:
	case <-pq.ctx.Done():
		return
	default:
		// Workers busy, re-queue
		pq.itemsMu.Lock()
		heap.Push(pq.items, item)
		pq.itemsMu.Unlock()
	}
}

// worker processes jobs
func (pq *PriorityQueue) worker(id int) {
	defer pq.wg.Done()
	
	for {
		select {
		case job := <-pq.jobChan:
			pq.executeJob(job)
			
		case <-pq.ctx.Done():
			return
		}
	}
}

// executeJob executes a job
func (pq *PriorityQueue) executeJob(job Job) {
	startTime := time.Now()
	
	// Create job context with deadline
	ctx := pq.ctx
	if !job.Deadline().IsZero() {
		var cancel context.CancelFunc
		ctx, cancel = context.WithDeadline(pq.ctx, job.Deadline())
		defer cancel()
	}
	
	// Execute job
	data, err := job.Execute(ctx)
	duration := time.Since(startTime)
	
	// Create result
	result := Result{
		JobID:    job.ID(),
		Success:  err == nil,
		Data:     data,
		Error:    err,
		Duration: duration,
	}
	
	// Update statistics
	if err == nil {
		pq.completedJobs.Add(1)
	} else {
		pq.failedJobs.Add(1)
	}
	
	// Send result
	select {
	case pq.resultChan <- result:
	case <-pq.ctx.Done():
	}
}

// updateAvgWaitTime updates average wait time
func (pq *PriorityQueue) updateAvgWaitTime(waitTime time.Duration) {
	// Exponential moving average
	alpha := 0.1
	current := pq.avgWaitTime.Load()
	new := int64(float64(current)*(1-alpha) + float64(waitTime.Nanoseconds())*alpha)
	pq.avgWaitTime.Store(new)
}

// GetResult gets a job result
func (pq *PriorityQueue) GetResult() (Result, bool) {
	select {
	case result := <-pq.resultChan:
		return result, true
	default:
		return Result{}, false
	}
}

// Size returns queue size
func (pq *PriorityQueue) Size() int {
	pq.itemsMu.RLock()
	defer pq.itemsMu.RUnlock()
	return pq.items.Len()
}

// GetStatistics returns queue statistics
func (pq *PriorityQueue) GetStatistics() map[string]interface{} {
	stats := make(map[string]interface{})
	
	stats["queue_size"] = pq.Size()
	stats["total_jobs"] = pq.totalJobs.Load()
	stats["completed_jobs"] = pq.completedJobs.Load()
	stats["failed_jobs"] = pq.failedJobs.Load()
	stats["dropped_jobs"] = pq.droppedJobs.Load()
	stats["avg_wait_time_ms"] = float64(pq.avgWaitTime.Load()) / 1e6
	
	completionRate := float64(0)
	if total := pq.totalJobs.Load(); total > 0 {
		completionRate = float64(pq.completedJobs.Load()) / float64(total) * 100
	}
	stats["completion_rate"] = completionRate
	
	return stats
}

// Stop stops the priority queue
func (pq *PriorityQueue) Stop() {
	pq.cancel()
	pq.wg.Wait()
}

// Heap interface implementation
func (h priorityHeap) Len() int { return len(h) }

func (h priorityHeap) Less(i, j int) bool {
	// Higher priority = lower number
	if h[i].job.Priority() != h[j].job.Priority() {
		return h[i].job.Priority() < h[j].job.Priority()
	}
	// For same priority, older jobs first (FIFO)
	return h[i].timestamp.Before(h[j].timestamp)
}

func (h priorityHeap) Swap(i, j int) {
	h[i], h[j] = h[j], h[i]
	h[i].index = i
	h[j].index = j
}

func (h *priorityHeap) Push(x interface{}) {
	item := x.(*priorityItem)
	item.index = len(*h)
	*h = append(*h, item)
}

func (h *priorityHeap) Pop() interface{} {
	old := *h
	n := len(old)
	item := old[n-1]
	item.index = -1
	*h = old[0 : n-1]
	return item
}

// BaseJob implementation
func NewBaseJob(id string, priority int, fn func(context.Context) (interface{}, error)) *BaseJob {
	return &BaseJob{
		id:       id,
		priority: priority,
		fn:       fn,
		weight:   1,
	}
}

func (j *BaseJob) ID() string        { return j.id }
func (j *BaseJob) Priority() int     { return j.priority }
func (j *BaseJob) Deadline() time.Time { return j.deadline }
func (j *BaseJob) Weight() int       { return j.weight }

func (j *BaseJob) Execute(ctx context.Context) (interface{}, error) {
	return j.fn(ctx)
}

func (j *BaseJob) SetDeadline(deadline time.Time) {
	j.deadline = deadline
}

func (j *BaseJob) SetWeight(weight int) {
	j.weight = weight
}

// WeightedFairQueue provides weighted fair queuing
type WeightedFairQueue struct {
	queues   map[string]*PriorityQueue
	weights  map[string]int
	queuesMu sync.RWMutex
	
	// Round-robin state
	currentQueue int
	tokens       map[string]int
	
	ctx    context.Context
	cancel context.CancelFunc
}

// NewWeightedFairQueue creates weighted fair queue
func NewWeightedFairQueue(ctx context.Context) *WeightedFairQueue {
	ctx, cancel := context.WithCancel(ctx)
	
	return &WeightedFairQueue{
		queues:  make(map[string]*PriorityQueue),
		weights: make(map[string]int),
		tokens:  make(map[string]int),
		ctx:     ctx,
		cancel:  cancel,
	}
}

// AddQueue adds a queue with weight
func (wfq *WeightedFairQueue) AddQueue(name string, weight int, queue *PriorityQueue) {
	wfq.queuesMu.Lock()
	defer wfq.queuesMu.Unlock()
	
	wfq.queues[name] = queue
	wfq.weights[name] = weight
	wfq.tokens[name] = weight
}

// GetNextJob gets next job using weighted fair queuing
func (wfq *WeightedFairQueue) GetNextJob() (Job, bool) {
	wfq.queuesMu.Lock()
	defer wfq.queuesMu.Unlock()
	
	// Find queue with tokens
	for name, tokens := range wfq.tokens {
		if tokens > 0 {
			queue := wfq.queues[name]
			
			// Try to get job from queue
			if queue.Size() > 0 {
				wfq.tokens[name]--
				
				// Refill tokens if all exhausted
				allZero := true
				for _, t := range wfq.tokens {
					if t > 0 {
						allZero = false
						break
					}
				}
				
				if allZero {
					// Refill all queues
					for n := range wfq.tokens {
						wfq.tokens[n] = wfq.weights[n]
					}
				}
				
				// Get job from queue (simplified)
				// In production, would properly dequeue
				return nil, false
			}
		}
	}
	
	return nil, false
}

// DynamicPriorityQueue adjusts priorities dynamically
type DynamicPriorityQueue struct {
	*PriorityQueue
	ageBoost    int
	ageInterval time.Duration
}

// NewDynamicPriorityQueue creates dynamic priority queue
func NewDynamicPriorityQueue(ctx context.Context, config *PriorityQueueConfig) *DynamicPriorityQueue {
	return &DynamicPriorityQueue{
		PriorityQueue: NewPriorityQueue(ctx, config),
		ageBoost:      1,
		ageInterval:   1 * time.Second,
	}
}

// adjustPriorities adjusts priorities based on age
func (dpq *DynamicPriorityQueue) adjustPriorities() {
	dpq.itemsMu.Lock()
	defer dpq.itemsMu.Unlock()
	
	now := time.Now()
	
	// Rebuild heap with adjusted priorities
	newHeap := &priorityHeap{}
	for _, item := range *dpq.items {
		age := now.Sub(item.timestamp)
		ageBoost := int(age / dpq.ageInterval) * dpq.ageBoost
		
		// Create wrapper job with boosted priority
		// This is simplified - in production would properly wrap
		item.job = &BaseJob{
			id:       item.job.ID(),
			priority: item.job.Priority() - ageBoost, // Lower value = higher priority
			fn:       item.job.Execute,
		}
		
		heap.Push(newHeap, item)
	}
	
	dpq.items = newHeap
}