package optimization

import (
	"context"
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// WorkerPool manages a pool of workers for parallel task execution
type WorkerPool struct {
	logger   *zap.Logger
	config   WorkerPoolConfig
	
	// Workers
	workers  []*Worker
	workerWG sync.WaitGroup
	
	// Task management
	taskQueue chan Task
	
	// State
	running  atomic.Bool
	paused   atomic.Bool
	
	// Statistics
	stats    *WorkerPoolStats
	
	// Control channels
	stopChan chan struct{}
	doneChan chan struct{}
}

// WorkerPoolConfig defines worker pool configuration
type WorkerPoolConfig struct {
	MinWorkers       int           `yaml:"min_workers"`
	MaxWorkers       int           `yaml:"max_workers"`
	QueueSize        int           `yaml:"queue_size"`
	IdleTimeout      time.Duration `yaml:"idle_timeout"`
	ScaleUpThreshold float64       `yaml:"scale_up_threshold"`
	ScaleDownThreshold float64     `yaml:"scale_down_threshold"`
	ScaleInterval    time.Duration `yaml:"scale_interval"`
	EnableProfiling  bool          `yaml:"enable_profiling"`
}

// Task represents a unit of work
type Task interface {
	ID() string
	Execute(ctx context.Context) error
	OnComplete(result interface{}, err error)
	Priority() int
	Timeout() time.Duration
}

// Worker represents a worker in the pool
type Worker struct {
	id       int
	pool     *WorkerPool
	taskChan chan Task
	stopChan chan struct{}
	
	// Statistics
	tasksCompleted atomic.Uint64
	tasksErrored   atomic.Uint64
	lastTaskTime   atomic.Value // time.Time
	busy           atomic.Bool
}

// WorkerPoolStats tracks pool statistics
type WorkerPoolStats struct {
	TasksQueued     atomic.Uint64
	TasksCompleted  atomic.Uint64
	TasksErrored    atomic.Uint64
	TasksTimeout    atomic.Uint64
	ActiveWorkers   atomic.Int32
	TotalWorkers    atomic.Int32
	QueueDepth      atomic.Int32
	AvgTaskDuration atomic.Value // time.Duration
}

// NewWorkerPool creates a new worker pool
func NewWorkerPool(logger *zap.Logger, config WorkerPoolConfig) *WorkerPool {
	// Set defaults
	if config.MinWorkers == 0 {
		config.MinWorkers = runtime.NumCPU()
	}
	if config.MaxWorkers == 0 {
		config.MaxWorkers = runtime.NumCPU() * 4
	}
	if config.QueueSize == 0 {
		config.QueueSize = config.MaxWorkers * 100
	}
	if config.IdleTimeout == 0 {
		config.IdleTimeout = 30 * time.Second
	}
	if config.ScaleUpThreshold == 0 {
		config.ScaleUpThreshold = 0.8
	}
	if config.ScaleDownThreshold == 0 {
		config.ScaleDownThreshold = 0.2
	}
	if config.ScaleInterval == 0 {
		config.ScaleInterval = 10 * time.Second
	}
	
	pool := &WorkerPool{
		logger:    logger,
		config:    config,
		taskQueue: make(chan Task, config.QueueSize),
		stats:     &WorkerPoolStats{},
		stopChan:  make(chan struct{}),
		doneChan:  make(chan struct{}),
		workers:   make([]*Worker, 0, config.MaxWorkers),
	}
	
	return pool
}

// Start initializes and starts the worker pool
func (wp *WorkerPool) Start(ctx context.Context) error {
	if !wp.running.CompareAndSwap(false, true) {
		return fmt.Errorf("worker pool already running")
	}
	
	wp.logger.Info("Starting worker pool",
		zap.Int("min_workers", wp.config.MinWorkers),
		zap.Int("max_workers", wp.config.MaxWorkers),
	)
	
	// Start initial workers
	for i := 0; i < wp.config.MinWorkers; i++ {
		wp.addWorker()
	}
	
	// Start auto-scaler
	go wp.autoScaler(ctx)
	
	// Start statistics collector
	go wp.statsCollector(ctx)
	
	return nil
}

// Stop gracefully shuts down the worker pool
func (wp *WorkerPool) Stop() error {
	if !wp.running.CompareAndSwap(true, false) {
		return fmt.Errorf("worker pool not running")
	}
	
	wp.logger.Info("Stopping worker pool")
	
	// Signal stop
	close(wp.stopChan)
	
	// Stop accepting new tasks
	close(wp.taskQueue)
	
	// Wait for all workers to finish
	wp.workerWG.Wait()
	
	// Signal completion
	close(wp.doneChan)
	
	wp.logger.Info("Worker pool stopped",
		zap.Uint64("tasks_completed", wp.stats.TasksCompleted.Load()),
		zap.Uint64("tasks_errored", wp.stats.TasksErrored.Load()),
	)
	
	return nil
}

// Submit adds a task to the pool
func (wp *WorkerPool) Submit(task Task) error {
	if !wp.running.Load() {
		return fmt.Errorf("worker pool not running")
	}
	
	if wp.paused.Load() {
		return fmt.Errorf("worker pool is paused")
	}
	
	select {
	case wp.taskQueue <- task:
		wp.stats.TasksQueued.Add(1)
		wp.stats.QueueDepth.Store(int32(len(wp.taskQueue)))
		return nil
	default:
		return fmt.Errorf("task queue full")
	}
}

// SubmitWithTimeout submits a task with timeout
func (wp *WorkerPool) SubmitWithTimeout(task Task, timeout time.Duration) error {
	if !wp.running.Load() {
		return fmt.Errorf("worker pool not running")
	}
	
	if wp.paused.Load() {
		return fmt.Errorf("worker pool is paused")
	}
	
	select {
	case wp.taskQueue <- task:
		wp.stats.TasksQueued.Add(1)
		wp.stats.QueueDepth.Store(int32(len(wp.taskQueue)))
		return nil
	case <-time.After(timeout):
		return fmt.Errorf("timeout submitting task")
	}
}

// Pause pauses task processing
func (wp *WorkerPool) Pause() {
	wp.paused.Store(true)
	wp.logger.Info("Worker pool paused")
}

// Resume resumes task processing
func (wp *WorkerPool) Resume() {
	wp.paused.Store(false)
	wp.logger.Info("Worker pool resumed")
}

// GetStats returns pool statistics
func (wp *WorkerPool) GetStats() map[string]interface{} {
	avgDuration := time.Duration(0)
	if v := wp.stats.AvgTaskDuration.Load(); v != nil {
		avgDuration = v.(time.Duration)
	}
	
	return map[string]interface{}{
		"tasks_queued":     wp.stats.TasksQueued.Load(),
		"tasks_completed":  wp.stats.TasksCompleted.Load(),
		"tasks_errored":    wp.stats.TasksErrored.Load(),
		"tasks_timeout":    wp.stats.TasksTimeout.Load(),
		"active_workers":   wp.stats.ActiveWorkers.Load(),
		"total_workers":    wp.stats.TotalWorkers.Load(),
		"queue_depth":      wp.stats.QueueDepth.Load(),
		"avg_task_duration": avgDuration,
		"running":          wp.running.Load(),
		"paused":           wp.paused.Load(),
	}
}

// Worker management

func (wp *WorkerPool) addWorker() {
	worker := &Worker{
		id:       len(wp.workers),
		pool:     wp,
		taskChan: wp.taskQueue,
		stopChan: make(chan struct{}),
	}
	
	wp.workers = append(wp.workers, worker)
	wp.stats.TotalWorkers.Add(1)
	
	wp.workerWG.Add(1)
	go worker.run()
	
	wp.logger.Debug("Added worker", zap.Int("worker_id", worker.id))
}

func (wp *WorkerPool) removeWorker() {
	if len(wp.workers) <= wp.config.MinWorkers {
		return
	}
	
	// Find idle worker
	for i, worker := range wp.workers {
		if !worker.busy.Load() {
			close(worker.stopChan)
			wp.workers = append(wp.workers[:i], wp.workers[i+1:]...)
			wp.stats.TotalWorkers.Add(-1)
			wp.logger.Debug("Removed worker", zap.Int("worker_id", worker.id))
			return
		}
	}
}

// Worker implementation

func (w *Worker) run() {
	defer w.pool.workerWG.Done()
	
	w.pool.logger.Debug("Worker started", zap.Int("worker_id", w.id))
	
	idleTimer := time.NewTimer(w.pool.config.IdleTimeout)
	defer idleTimer.Stop()
	
	for {
		select {
		case task, ok := <-w.taskChan:
			if !ok {
				return // Channel closed
			}
			
			// Reset idle timer
			if !idleTimer.Stop() {
				<-idleTimer.C
			}
			idleTimer.Reset(w.pool.config.IdleTimeout)
			
			// Process task
			w.processTask(task)
			
		case <-idleTimer.C:
			// Worker idle for too long
			if w.pool.stats.TotalWorkers.Load() > int32(w.pool.config.MinWorkers) {
				w.pool.logger.Debug("Worker idle timeout", zap.Int("worker_id", w.id))
				return
			}
			idleTimer.Reset(w.pool.config.IdleTimeout)
			
		case <-w.stopChan:
			return
			
		case <-w.pool.stopChan:
			return
		}
	}
}

func (w *Worker) processTask(task Task) {
	// Mark as busy
	w.busy.Store(true)
	w.pool.stats.ActiveWorkers.Add(1)
	defer func() {
		w.busy.Store(false)
		w.pool.stats.ActiveWorkers.Add(-1)
	}()
	
	// Create context with timeout
	ctx := context.Background()
	if timeout := task.Timeout(); timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	
	// Execute task
	start := time.Now()
	err := task.Execute(ctx)
	duration := time.Since(start)
	
	// Update statistics
	w.lastTaskTime.Store(time.Now())
	
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			w.pool.stats.TasksTimeout.Add(1)
		} else {
			w.tasksErrored.Add(1)
			w.pool.stats.TasksErrored.Add(1)
		}
	} else {
		w.tasksCompleted.Add(1)
		w.pool.stats.TasksCompleted.Add(1)
	}
	
	// Update average duration
	w.updateAvgDuration(duration)
	
	// Notify completion
	task.OnComplete(nil, err)
	
	// Update queue depth
	w.pool.stats.QueueDepth.Store(int32(len(w.pool.taskQueue)))
}

func (w *Worker) updateAvgDuration(duration time.Duration) {
	// Simple moving average
	current := w.pool.stats.AvgTaskDuration.Load()
	if current == nil {
		w.pool.stats.AvgTaskDuration.Store(duration)
		return
	}
	
	avgDuration := current.(time.Duration)
	newAvg := (avgDuration*9 + duration) / 10
	w.pool.stats.AvgTaskDuration.Store(newAvg)
}

// Auto-scaler

func (wp *WorkerPool) autoScaler(ctx context.Context) {
	ticker := time.NewTicker(wp.config.ScaleInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-wp.stopChan:
			return
		case <-ticker.C:
			wp.scale()
		}
	}
}

func (wp *WorkerPool) scale() {
	queueDepth := float64(wp.stats.QueueDepth.Load())
	totalWorkers := float64(wp.stats.TotalWorkers.Load())
	activeWorkers := float64(wp.stats.ActiveWorkers.Load())
	
	if totalWorkers == 0 {
		return
	}
	
	// Calculate utilization
	utilization := activeWorkers / totalWorkers
	queuePressure := queueDepth / float64(wp.config.QueueSize)
	
	// Scale up if high utilization or queue pressure
	if (utilization > wp.config.ScaleUpThreshold || queuePressure > 0.5) && 
	   int(totalWorkers) < wp.config.MaxWorkers {
		wp.addWorker()
		wp.logger.Info("Scaled up",
			zap.Float64("utilization", utilization),
			zap.Float64("queue_pressure", queuePressure),
		)
	}
	
	// Scale down if low utilization
	if utilization < wp.config.ScaleDownThreshold && 
	   queuePressure < 0.1 &&
	   int(totalWorkers) > wp.config.MinWorkers {
		wp.removeWorker()
		wp.logger.Info("Scaled down",
			zap.Float64("utilization", utilization),
			zap.Float64("queue_pressure", queuePressure),
		)
	}
}

// Statistics collector

func (wp *WorkerPool) statsCollector(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-wp.stopChan:
			return
		case <-ticker.C:
			if wp.config.EnableProfiling {
				stats := wp.GetStats()
				wp.logger.Info("Worker pool statistics",
					zap.Any("stats", stats),
				)
			}
		}
	}
}

// PriorityTask implements Task with priority
type PriorityTask struct {
	id       string
	priority int
	timeout  time.Duration
	fn       func(context.Context) error
	callback func(interface{}, error)
}

func NewPriorityTask(id string, priority int, fn func(context.Context) error) *PriorityTask {
	return &PriorityTask{
		id:       id,
		priority: priority,
		timeout:  5 * time.Minute,
		fn:       fn,
		callback: func(interface{}, error) {},
	}
}

func (t *PriorityTask) ID() string                              { return t.id }
func (t *PriorityTask) Priority() int                            { return t.priority }
func (t *PriorityTask) Timeout() time.Duration                   { return t.timeout }
func (t *PriorityTask) Execute(ctx context.Context) error        { return t.fn(ctx) }
func (t *PriorityTask) OnComplete(result interface{}, err error) { t.callback(result, err) }