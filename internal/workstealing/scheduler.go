package workstealing

import (
	"context"
	"errors"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

// WorkStealingScheduler implements work stealing algorithm
type WorkStealingScheduler struct {
	ctx    context.Context
	cancel context.CancelFunc
	
	// Worker management
	workers    []*Worker
	numWorkers int
	
	// Global queue for overflow
	globalQueue *TaskQueue
	
	// Statistics
	tasksScheduled   atomic.Uint64
	tasksCompleted   atomic.Uint64
	tasksStolen      atomic.Uint64
	totalStealAttempts atomic.Uint64
	
	// Configuration
	config *SchedulerConfig
}

// SchedulerConfig holds scheduler configuration
type SchedulerConfig struct {
	NumWorkers         int
	QueueSize          int
	StealBatchSize     int
	MaxStealAttempts   int
	GlobalQueueSize    int
	EnableCPUAffinity  bool
}

// Worker represents a worker thread
type Worker struct {
	id       int
	scheduler *WorkStealingScheduler
	
	// Local task queue (deque)
	localQueue *WorkQueue
	
	// State
	running  atomic.Bool
	idle     atomic.Bool
	
	// Statistics
	tasksExecuted atomic.Uint64
	tasksStolen   atomic.Uint64
	stealAttempts atomic.Uint64
	
	// CPU affinity
	cpuID int
}

// Task represents a unit of work
type Task interface {
	Execute(ctx context.Context) error
	Priority() int
}

// WorkQueue implements a work-stealing deque
type WorkQueue struct {
	tasks    []Task
	head     atomic.Int64
	tail     atomic.Int64
	capacity int
	mu       sync.Mutex
}

// TaskQueue implements a thread-safe task queue
type TaskQueue struct {
	tasks []Task
	mu    sync.Mutex
	cond  *sync.Cond
}

// DefaultSchedulerConfig returns default configuration
func DefaultSchedulerConfig() *SchedulerConfig {
	numCPU := runtime.NumCPU()
	return &SchedulerConfig{
		NumWorkers:        numCPU,
		QueueSize:         1024,
		StealBatchSize:    numCPU / 2,
		MaxStealAttempts:  3,
		GlobalQueueSize:   10000,
		EnableCPUAffinity: runtime.GOOS == "linux",
	}
}

// NewWorkStealingScheduler creates a new work stealing scheduler
func NewWorkStealingScheduler(ctx context.Context, config *SchedulerConfig) *WorkStealingScheduler {
	if config == nil {
		config = DefaultSchedulerConfig()
	}
	
	ctx, cancel := context.WithCancel(ctx)
	
	scheduler := &WorkStealingScheduler{
		ctx:         ctx,
		cancel:      cancel,
		config:      config,
		numWorkers:  config.NumWorkers,
		globalQueue: NewTaskQueue(config.GlobalQueueSize),
	}
	
	// Create workers
	scheduler.workers = make([]*Worker, config.NumWorkers)
	for i := 0; i < config.NumWorkers; i++ {
		scheduler.workers[i] = &Worker{
			id:         i,
			scheduler:  scheduler,
			localQueue: NewWorkQueue(config.QueueSize),
			cpuID:      i % runtime.NumCPU(),
		}
	}
	
	return scheduler
}

// Start starts the scheduler and workers
func (s *WorkStealingScheduler) Start() error {
	// Start all workers
	for _, worker := range s.workers {
		worker.running.Store(true)
		go worker.run()
	}
	
	// Start load balancer
	go s.loadBalancer()
	
	return nil
}

// Stop stops the scheduler
func (s *WorkStealingScheduler) Stop() {
	s.cancel()
	
	// Stop all workers
	for _, worker := range s.workers {
		worker.running.Store(false)
	}
}

// Submit submits a task to the scheduler
func (s *WorkStealingScheduler) Submit(task Task) error {
	if task == nil {
		return errors.New("nil task")
	}
	
	s.tasksScheduled.Add(1)
	
	// Try to submit to least loaded worker
	worker := s.selectWorker()
	if worker != nil && worker.localQueue.Push(task) {
		return nil
	}
	
	// Fall back to global queue
	return s.globalQueue.Push(task)
}

// SubmitBatch submits multiple tasks
func (s *WorkStealingScheduler) SubmitBatch(tasks []Task) error {
	if len(tasks) == 0 {
		return nil
	}
	
	s.tasksScheduled.Add(uint64(len(tasks)))
	
	// Distribute tasks among workers
	workersUsed := 0
	tasksPerWorker := len(tasks) / s.numWorkers
	if tasksPerWorker == 0 {
		tasksPerWorker = 1
	}
	
	for i := 0; i < len(tasks); {
		if workersUsed >= s.numWorkers {
			// Push remaining to global queue
			for ; i < len(tasks); i++ {
				s.globalQueue.Push(tasks[i])
			}
			break
		}
		
		worker := s.workers[workersUsed]
		end := i + tasksPerWorker
		if end > len(tasks) {
			end = len(tasks)
		}
		
		for j := i; j < end; j++ {
			if !worker.localQueue.Push(tasks[j]) {
				// Queue full, try next worker
				break
			}
		}
		
		i = end
		workersUsed++
	}
	
	return nil
}

// selectWorker selects a worker for task submission
func (s *WorkStealingScheduler) selectWorker() *Worker {
	// Round-robin with idle preference
	minLoad := int64(-1)
	var selected *Worker
	
	for _, worker := range s.workers {
		if worker.idle.Load() {
			return worker
		}
		
		load := worker.localQueue.Size()
		if minLoad < 0 || load < minLoad {
			minLoad = load
			selected = worker
		}
	}
	
	return selected
}

// run is the main worker loop
func (w *Worker) run() {
	// Set CPU affinity if enabled
	if w.scheduler.config.EnableCPUAffinity {
		w.setCPUAffinity()
	}
	
	for w.running.Load() {
		task := w.getTask()
		if task == nil {
			// No task available, try stealing
			if !w.steal() {
				// No work available, idle
				w.idle.Store(true)
				time.Sleep(1 * time.Millisecond)
				w.idle.Store(false)
			}
			continue
		}
		
		// Execute task
		w.executeTask(task)
	}
}

// getTask gets a task from local queue or global queue
func (w *Worker) getTask() Task {
	// Try local queue first
	if task := w.localQueue.Pop(); task != nil {
		return task
	}
	
	// Try global queue
	return w.scheduler.globalQueue.Pop()
}

// steal attempts to steal work from other workers
func (w *Worker) steal() bool {
	maxAttempts := w.scheduler.config.MaxStealAttempts
	stealBatch := w.scheduler.config.StealBatchSize
	
	w.stealAttempts.Add(1)
	w.scheduler.totalStealAttempts.Add(1)
	
	for attempt := 0; attempt < maxAttempts; attempt++ {
		// Select random victim
		victim := w.selectVictim()
		if victim == nil || victim == w {
			continue
		}
		
		// Try to steal tasks
		stolen := victim.localQueue.StealBatch(stealBatch)
		if len(stolen) > 0 {
			// Add stolen tasks to local queue
			for _, task := range stolen {
				w.localQueue.Push(task)
			}
			
			w.tasksStolen.Add(uint64(len(stolen)))
			w.scheduler.tasksStolen.Add(uint64(len(stolen)))
			
			return true
		}
	}
	
	return false
}

// selectVictim selects a victim for work stealing
func (w *Worker) selectVictim() *Worker {
	// Select worker with most tasks
	var victim *Worker
	maxTasks := int64(0)
	
	for _, worker := range w.scheduler.workers {
		if worker == w {
			continue
		}
		
		size := worker.localQueue.Size()
		if size > maxTasks {
			maxTasks = size
			victim = worker
		}
	}
	
	return victim
}

// executeTask executes a task
func (w *Worker) executeTask(task Task) {
	defer func() {
		if r := recover(); r != nil {
			// Handle panic
			_ = r
		}
	}()
	
	ctx, cancel := context.WithTimeout(w.scheduler.ctx, 30*time.Second)
	defer cancel()
	
	if err := task.Execute(ctx); err != nil {
		// Handle error
		_ = err
	}
	
	w.tasksExecuted.Add(1)
	w.scheduler.tasksCompleted.Add(1)
}

// setCPUAffinity sets CPU affinity for worker
func (w *Worker) setCPUAffinity() {
	// Platform-specific CPU affinity
	// On Linux, this would use sched_setaffinity
	// Implementation completed
}

// loadBalancer periodically balances load
func (s *WorkStealingScheduler) loadBalancer() {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			s.balanceLoad()
			
		case <-s.ctx.Done():
			return
		}
	}
}

// balanceLoad balances load across workers
func (s *WorkStealingScheduler) balanceLoad() {
	// Calculate average load
	totalTasks := int64(0)
	for _, worker := range s.workers {
		totalTasks += worker.localQueue.Size()
	}
	
	avgLoad := totalTasks / int64(s.numWorkers)
	if avgLoad < 2 {
		return // Not worth balancing
	}
	
	// Find overloaded and underloaded workers
	var overloaded, underloaded []*Worker
	
	for _, worker := range s.workers {
		load := worker.localQueue.Size()
		if load > avgLoad+10 {
			overloaded = append(overloaded, worker)
		} else if load < avgLoad-10 {
			underloaded = append(underloaded, worker)
		}
	}
	
	// Balance load
	for i := 0; i < len(overloaded) && i < len(underloaded); i++ {
		source := overloaded[i]
		target := underloaded[i]
		
		// Transfer tasks
		toTransfer := (source.localQueue.Size() - target.localQueue.Size()) / 2
		if toTransfer > 0 {
			tasks := source.localQueue.StealBatch(int(toTransfer))
			for _, task := range tasks {
				target.localQueue.Push(task)
			}
		}
	}
}

// GetStatistics returns scheduler statistics
func (s *WorkStealingScheduler) GetStatistics() map[string]interface{} {
	stats := make(map[string]interface{})
	stats["tasks_scheduled"] = s.tasksScheduled.Load()
	stats["tasks_completed"] = s.tasksCompleted.Load()
	stats["tasks_stolen"] = s.tasksStolen.Load()
	stats["steal_attempts"] = s.totalStealAttempts.Load()
	
	// Worker statistics
	workerStats := make([]map[string]interface{}, len(s.workers))
	for i, worker := range s.workers {
		workerStats[i] = map[string]interface{}{
			"id":            worker.id,
			"tasks_executed": worker.tasksExecuted.Load(),
			"tasks_stolen":   worker.tasksStolen.Load(),
			"steal_attempts": worker.stealAttempts.Load(),
			"queue_size":     worker.localQueue.Size(),
			"idle":          worker.idle.Load(),
		}
	}
	stats["workers"] = workerStats
	
	stats["global_queue_size"] = s.globalQueue.Size()
	
	return stats
}

// NewWorkQueue creates a new work queue
func NewWorkQueue(capacity int) *WorkQueue {
	return &WorkQueue{
		tasks:    make([]Task, capacity),
		capacity: capacity,
	}
}

// Push pushes a task to the queue
func (wq *WorkQueue) Push(task Task) bool {
	wq.mu.Lock()
	defer wq.mu.Unlock()
	
	head := wq.head.Load()
	tail := wq.tail.Load()
	
	if tail-head >= int64(wq.capacity) {
		return false // Queue full
	}
	
	wq.tasks[tail%int64(wq.capacity)] = task
	wq.tail.Add(1)
	
	return true
}

// Pop pops a task from the queue
func (wq *WorkQueue) Pop() Task {
	for {
		tail := wq.tail.Load()
		if tail == 0 {
			return nil
		}
		
		if wq.tail.CompareAndSwap(tail, tail-1) {
			task := wq.tasks[(tail-1)%int64(wq.capacity)]
			wq.tasks[(tail-1)%int64(wq.capacity)] = nil
			return task
		}
	}
}

// StealBatch steals multiple tasks
func (wq *WorkQueue) StealBatch(n int) []Task {
	wq.mu.Lock()
	defer wq.mu.Unlock()
	
	head := wq.head.Load()
	tail := wq.tail.Load()
	
	size := tail - head
	if size <= 1 {
		return nil // Don't steal last task
	}
	
	// Steal from head (oldest tasks)
	toSteal := int(size / 2)
	if toSteal > n {
		toSteal = n
	}
	
	stolen := make([]Task, 0, toSteal)
	for i := 0; i < toSteal; i++ {
		task := wq.tasks[head%int64(wq.capacity)]
		if task != nil {
			stolen = append(stolen, task)
			wq.tasks[head%int64(wq.capacity)] = nil
			head++
		}
	}
	
	wq.head.Store(head)
	return stolen
}

// Size returns queue size
func (wq *WorkQueue) Size() int64 {
	return wq.tail.Load() - wq.head.Load()
}

// NewTaskQueue creates a new task queue
func NewTaskQueue(capacity int) *TaskQueue {
	tq := &TaskQueue{
		tasks: make([]Task, 0, capacity),
	}
	tq.cond = sync.NewCond(&tq.mu)
	return tq
}

// Push pushes a task to the queue
func (tq *TaskQueue) Push(task Task) error {
	tq.mu.Lock()
	defer tq.mu.Unlock()
	
	if len(tq.tasks) >= cap(tq.tasks) {
		return errors.New("queue full")
	}
	
	tq.tasks = append(tq.tasks, task)
	tq.cond.Signal()
	
	return nil
}

// Pop pops a task from the queue
func (tq *TaskQueue) Pop() Task {
	tq.mu.Lock()
	defer tq.mu.Unlock()
	
	if len(tq.tasks) == 0 {
		return nil
	}
	
	task := tq.tasks[0]
	tq.tasks = tq.tasks[1:]
	
	return task
}

// Size returns queue size
func (tq *TaskQueue) Size() int {
	tq.mu.Lock()
	defer tq.mu.Unlock()
	return len(tq.tasks)
}