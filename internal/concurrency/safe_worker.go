package concurrency

import (
	"context"
	"fmt"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// SafeWorkerPool provides a thread-safe worker pool with panic recovery
type SafeWorkerPool struct {
	logger        *zap.Logger
	workers       []*Worker
	taskQueue     chan Task
	resultQueue   chan Result
	errorQueue    chan error
	
	// Worker management
	workerCount   int
	activeWorkers atomic.Int32
	
	// Lifecycle
	ctx           context.Context
	cancel        context.CancelFunc
	wg            sync.WaitGroup
	
	// Metrics
	tasksProcessed atomic.Uint64
	tasksFailed    atomic.Uint64
	panicsRecovered atomic.Uint64
}

// Task represents a unit of work
type Task interface {
	Execute(ctx context.Context) (interface{}, error)
	ID() string
}

// Result represents the result of a task execution
type Result struct {
	TaskID   string
	Data     interface{}
	Error    error
	Duration time.Duration
}

// Worker represents a worker in the pool
type Worker struct {
	id          int
	pool        *SafeWorkerPool
	taskCount   atomic.Uint64
	lastTaskTime atomic.Int64
}

// NewSafeWorkerPool creates a new safe worker pool
func NewSafeWorkerPool(logger *zap.Logger, workerCount int, queueSize int) *SafeWorkerPool {
	ctx, cancel := context.WithCancel(context.Background())
	
	pool := &SafeWorkerPool{
		logger:       logger,
		workers:      make([]*Worker, workerCount),
		taskQueue:    make(chan Task, queueSize),
		resultQueue:  make(chan Result, queueSize),
		errorQueue:   make(chan error, workerCount),
		workerCount:  workerCount,
		ctx:          ctx,
		cancel:       cancel,
	}
	
	// Create workers
	for i := 0; i < workerCount; i++ {
		pool.workers[i] = &Worker{
			id:   i,
			pool: pool,
		}
	}
	
	return pool
}

// Start begins processing tasks
func (p *SafeWorkerPool) Start() {
	p.logger.Info("Starting worker pool", zap.Int("workers", p.workerCount))
	
	// Start workers
	for _, worker := range p.workers {
		p.wg.Add(1)
		go worker.run()
	}
	
	// Start error handler
	p.wg.Add(1)
	go p.handleErrors()
}

// Submit submits a task to the pool
func (p *SafeWorkerPool) Submit(task Task) error {
	select {
	case p.taskQueue <- task:
		return nil
	case <-p.ctx.Done():
		return fmt.Errorf("worker pool is shutting down")
	default:
		return fmt.Errorf("task queue is full")
	}
}

// SubmitWithTimeout submits a task with timeout
func (p *SafeWorkerPool) SubmitWithTimeout(task Task, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(p.ctx, timeout)
	defer cancel()
	
	select {
	case p.taskQueue <- task:
		return nil
	case <-ctx.Done():
		if ctx.Err() == context.DeadlineExceeded {
			return fmt.Errorf("submission timeout")
		}
		return fmt.Errorf("worker pool is shutting down")
	}
}

// Results returns the result channel
func (p *SafeWorkerPool) Results() <-chan Result {
	return p.resultQueue
}

// Shutdown gracefully shuts down the pool
func (p *SafeWorkerPool) Shutdown(timeout time.Duration) error {
	p.logger.Info("Shutting down worker pool")
	
	// Stop accepting new tasks
	p.cancel()
	
	// Close task queue
	close(p.taskQueue)
	
	// Wait for workers to finish or timeout
	done := make(chan struct{})
	go func() {
		p.wg.Wait()
		close(done)
	}()
	
	select {
	case <-done:
		p.logger.Info("All workers stopped gracefully")
		close(p.resultQueue)
		close(p.errorQueue)
		return nil
	case <-time.After(timeout):
		active := p.activeWorkers.Load()
		return fmt.Errorf("shutdown timeout: %d workers still active", active)
	}
}

// GetStats returns pool statistics
func (p *SafeWorkerPool) GetStats() map[string]interface{} {
	stats := map[string]interface{}{
		"total_workers":    p.workerCount,
		"active_workers":   p.activeWorkers.Load(),
		"tasks_processed":  p.tasksProcessed.Load(),
		"tasks_failed":     p.tasksFailed.Load(),
		"panics_recovered": p.panicsRecovered.Load(),
		"queue_size":       len(p.taskQueue),
		"result_queue_size": len(p.resultQueue),
	}
	
	// Add per-worker stats
	workerStats := make([]map[string]interface{}, len(p.workers))
	for i, worker := range p.workers {
		workerStats[i] = map[string]interface{}{
			"id":         worker.id,
			"task_count": worker.taskCount.Load(),
			"last_task":  time.Unix(worker.lastTaskTime.Load(), 0),
		}
	}
	stats["workers"] = workerStats
	
	return stats
}

// Worker methods

func (w *Worker) run() {
	defer w.pool.wg.Done()
	defer w.recover()
	
	w.pool.activeWorkers.Add(1)
	defer w.pool.activeWorkers.Add(-1)
	
	w.pool.logger.Debug("Worker started", zap.Int("worker_id", w.id))
	
	for {
		select {
		case task, ok := <-w.pool.taskQueue:
			if !ok {
				w.pool.logger.Debug("Worker stopping", zap.Int("worker_id", w.id))
				return
			}
			
			w.executeTask(task)
			
		case <-w.pool.ctx.Done():
			w.pool.logger.Debug("Worker stopping due to context", zap.Int("worker_id", w.id))
			return
		}
	}
}

func (w *Worker) executeTask(task Task) {
	defer w.recover()
	
	startTime := time.Now()
	w.lastTaskTime.Store(startTime.Unix())
	
	// Create task context with timeout
	taskCtx, cancel := context.WithTimeout(w.pool.ctx, 5*time.Minute)
	defer cancel()
	
	// Execute task
	result, err := task.Execute(taskCtx)
	
	duration := time.Since(startTime)
	w.taskCount.Add(1)
	
	// Record result
	taskResult := Result{
		TaskID:   task.ID(),
		Data:     result,
		Error:    err,
		Duration: duration,
	}
	
	// Update metrics
	if err != nil {
		w.pool.tasksFailed.Add(1)
	} else {
		w.pool.tasksProcessed.Add(1)
	}
	
	// Send result
	select {
	case w.pool.resultQueue <- taskResult:
	case <-w.pool.ctx.Done():
		return
	}
}

func (w *Worker) recover() {
	if r := recover(); r != nil {
		w.pool.panicsRecovered.Add(1)
		
		// Get stack trace
		stack := debug.Stack()
		
		// Log panic
		w.pool.logger.Error("Worker panic recovered",
			zap.Int("worker_id", w.id),
			zap.Any("panic", r),
			zap.String("stack", string(stack)),
		)
		
		// Send error
		err := fmt.Errorf("worker %d panic: %v", w.id, r)
		select {
		case w.pool.errorQueue <- err:
		default:
			// Error queue full, log it
			w.pool.logger.Error("Error queue full, dropping panic error")
		}
		
		// Restart worker if pool is still running
		if w.pool.ctx.Err() == nil {
			w.pool.wg.Add(1)
			go w.run()
		}
	}
}

func (p *SafeWorkerPool) handleErrors() {
	defer p.wg.Done()
	
	for {
		select {
		case err, ok := <-p.errorQueue:
			if !ok {
				return
			}
			
			p.logger.Error("Worker pool error", zap.Error(err))
			
		case <-p.ctx.Done():
			return
		}
	}
}

// SafeMap provides a thread-safe map implementation
type SafeMap struct {
	mu    sync.RWMutex
	data  map[string]interface{}
}

// NewSafeMap creates a new thread-safe map
func NewSafeMap() *SafeMap {
	return &SafeMap{
		data: make(map[string]interface{}),
	}
}

// Set sets a value in the map
func (m *SafeMap) Set(key string, value interface{}) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.data[key] = value
}

// Get retrieves a value from the map
func (m *SafeMap) Get(key string) (interface{}, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	value, exists := m.data[key]
	return value, exists
}

// Delete removes a value from the map
func (m *SafeMap) Delete(key string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.data, key)
}

// Len returns the number of items in the map
func (m *SafeMap) Len() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.data)
}

// Range iterates over the map
func (m *SafeMap) Range(f func(key string, value interface{}) bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	
	for k, v := range m.data {
		if !f(k, v) {
			break
		}
	}
}

// Clear removes all items from the map
func (m *SafeMap) Clear() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.data = make(map[string]interface{})
}

// SafeCounter provides thread-safe counter operations
type SafeCounter struct {
	value atomic.Int64
}

// NewSafeCounter creates a new thread-safe counter
func NewSafeCounter() *SafeCounter {
	return &SafeCounter{}
}

// Increment increments the counter
func (c *SafeCounter) Increment() int64 {
	return c.value.Add(1)
}

// Decrement decrements the counter
func (c *SafeCounter) Decrement() int64 {
	return c.value.Add(-1)
}

// Add adds a value to the counter
func (c *SafeCounter) Add(delta int64) int64 {
	return c.value.Add(delta)
}

// Get returns the current value
func (c *SafeCounter) Get() int64 {
	return c.value.Load()
}

// Set sets the counter value
func (c *SafeCounter) Set(value int64) {
	c.value.Store(value)
}

// Reset resets the counter to zero
func (c *SafeCounter) Reset() {
	c.value.Store(0)
}