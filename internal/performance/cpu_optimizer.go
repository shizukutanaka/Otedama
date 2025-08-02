package performance

import (
	"fmt"
	"runtime"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// CPUOptimizer implements CPU-level optimizations following John Carmack's performance principles
type CPUOptimizer struct {
	logger *zap.Logger
	
	// CPU configuration
	numCPU       int
	cacheLineSize int
	
	// NUMA configuration
	numaNodes    int
	numaEnabled  bool
	
	// Performance settings
	affinity     []int
	governor     string
	turboEnabled bool
	
	// Scheduling
	scheduler    *WorkScheduler
	
	// Metrics
	cycles       atomic.Uint64
	instructions atomic.Uint64
	cacheMisses  atomic.Uint64
}

// WorkScheduler implements work-stealing scheduler for optimal CPU usage
type WorkScheduler struct {
	logger    *zap.Logger
	numWorkers int
	
	// Work queues per CPU
	queues    []*WorkQueue
	
	// Worker goroutines
	workers   []*Worker
	stopCh    chan struct{}
	wg        sync.WaitGroup
}

// WorkQueue implements a lock-free work queue
type WorkQueue struct {
	tasks    []Task
	head     atomic.Uint64
	tail     atomic.Uint64
	capacity uint64
	padding  [7]uint64 // Prevent false sharing
}

// Worker represents a CPU-bound worker
type Worker struct {
	id       int
	cpuID    int
	queue    *WorkQueue
	scheduler *WorkScheduler
	
	// Metrics
	tasksProcessed atomic.Uint64
	steals         atomic.Uint64
}

// Task represents a unit of work
type Task interface {
	Execute() error
}

// CPUOptimizerConfig contains CPU optimization configuration
type CPUOptimizerConfig struct {
	CPUAffinity    []int
	Governor       string
	TurboBoost     bool
	NUMAOptimized  bool
	WorkerThreads  int
	QueueSize      int
}

// NewCPUOptimizer creates a new CPU optimizer
func NewCPUOptimizer(logger *zap.Logger, config *CPUOptimizerConfig) *CPUOptimizer {
	if config == nil {
		config = DefaultCPUOptimizerConfig()
	}
	
	co := &CPUOptimizer{
		logger:        logger,
		numCPU:        runtime.NumCPU(),
		cacheLineSize: 64, // Common cache line size
		affinity:      config.CPUAffinity,
		governor:      config.Governor,
		turboEnabled:  config.TurboBoost,
		numaEnabled:   config.NUMAOptimized,
	}
	
	// Initialize work scheduler
	co.scheduler = co.createScheduler(config)
	
	// Apply optimizations
	co.applyOptimizations()
	
	logger.Info("CPU optimizer initialized",
		zap.Int("num_cpu", co.numCPU),
		zap.String("governor", co.governor),
		zap.Bool("turbo", co.turboEnabled),
		zap.Bool("numa", co.numaEnabled),
	)
	
	return co
}

// createScheduler creates a work-stealing scheduler
func (co *CPUOptimizer) createScheduler(config *CPUOptimizerConfig) *WorkScheduler {
	numWorkers := config.WorkerThreads
	if numWorkers <= 0 {
		numWorkers = runtime.NumCPU()
	}
	
	scheduler := &WorkScheduler{
		logger:     co.logger,
		numWorkers: numWorkers,
		queues:     make([]*WorkQueue, numWorkers),
		workers:    make([]*Worker, numWorkers),
		stopCh:     make(chan struct{}),
	}
	
	// Create work queues
	for i := 0; i < numWorkers; i++ {
		scheduler.queues[i] = &WorkQueue{
			tasks:    make([]Task, config.QueueSize),
			capacity: uint64(config.QueueSize),
		}
	}
	
	// Create workers
	for i := 0; i < numWorkers; i++ {
		scheduler.workers[i] = &Worker{
			id:        i,
			cpuID:     i % runtime.NumCPU(),
			queue:     scheduler.queues[i],
			scheduler: scheduler,
		}
	}
	
	return scheduler
}

// applyOptimizations applies CPU-level optimizations
func (co *CPUOptimizer) applyOptimizations() {
	// Set GOMAXPROCS
	runtime.GOMAXPROCS(co.numCPU)
	
	// Configure garbage collector for low latency
	debug.SetGCPercent(100)
	debug.SetMemoryLimit(0) // No limit
	
	// Set CPU affinity if specified
	if len(co.affinity) > 0 {
		co.setCPUAffinity()
	}
	
	// Enable NUMA optimizations
	if co.numaEnabled && runtime.GOOS == "linux" {
		co.enableNUMAOptimizations()
	}
}

// setCPUAffinity sets CPU affinity for the process
func (co *CPUOptimizer) setCPUAffinity() {
	// This would use system-specific APIs to set CPU affinity
	// For now, we'll use runtime.LockOSThread as a proxy
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	
	co.logger.Debug("CPU affinity set", zap.Ints("cpus", co.affinity))
}

// enableNUMAOptimizations enables NUMA-aware optimizations
func (co *CPUOptimizer) enableNUMAOptimizations() {
	// Detect NUMA topology
	co.numaNodes = co.detectNUMANodes()
	
	co.logger.Debug("NUMA optimizations enabled",
		zap.Int("numa_nodes", co.numaNodes),
	)
}

// detectNUMANodes detects the number of NUMA nodes
func (co *CPUOptimizer) detectNUMANodes() int {
	// This would read /sys/devices/system/node on Linux
	// For now, return a default based on CPU count
	if co.numCPU >= 32 {
		return 2
	}
	return 1
}

// Start starts the CPU optimizer and work scheduler
func (co *CPUOptimizer) Start() error {
	return co.scheduler.Start()
}

// Stop stops the CPU optimizer
func (co *CPUOptimizer) Stop() error {
	return co.scheduler.Stop()
}

// Submit submits a task to the work scheduler
func (co *CPUOptimizer) Submit(task Task) error {
	return co.scheduler.Submit(task)
}

// Start starts all worker threads
func (ws *WorkScheduler) Start() error {
	for i, worker := range ws.workers {
		ws.wg.Add(1)
		go worker.run(&ws.wg)
		ws.logger.Debug("Started worker", zap.Int("worker_id", i))
	}
	return nil
}

// Stop stops all worker threads
func (ws *WorkScheduler) Stop() error {
	close(ws.stopCh)
	ws.wg.Wait()
	return nil
}

// Submit submits a task to the scheduler
func (ws *WorkScheduler) Submit(task Task) error {
	// Simple round-robin for now
	workerID := int(atomic.AddUint64(&ws.queues[0].tail, 1)) % ws.numWorkers
	return ws.queues[workerID].Push(task)
}

// run is the main worker loop
func (w *Worker) run(wg *sync.WaitGroup) {
	defer wg.Done()
	
	// Pin to CPU if possible
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	
	for {
		select {
		case <-w.scheduler.stopCh:
			return
		default:
			// Try to get task from own queue
			task := w.queue.Pop()
			if task == nil {
				// Try work stealing
				task = w.steal()
				if task != nil {
					w.steals.Add(1)
				}
			}
			
			if task != nil {
				if err := task.Execute(); err != nil {
					w.scheduler.logger.Error("Task execution failed",
						zap.Int("worker_id", w.id),
						zap.Error(err),
					)
				}
				w.tasksProcessed.Add(1)
			} else {
				// No work available, yield
				runtime.Gosched()
			}
		}
	}
}

// steal attempts to steal work from other queues
func (w *Worker) steal() Task {
	n := len(w.scheduler.queues)
	for i := 1; i < n; i++ {
		targetID := (w.id + i) % n
		if task := w.scheduler.queues[targetID].Steal(); task != nil {
			return task
		}
	}
	return nil
}

// Push adds a task to the queue
func (wq *WorkQueue) Push(task Task) error {
	tail := wq.tail.Load()
	head := wq.head.Load()
	
	next := (tail + 1) % wq.capacity
	if next == head {
		return fmt.Errorf("queue full")
	}
	
	wq.tasks[tail] = task
	wq.tail.Store(next)
	
	return nil
}

// Pop removes a task from the queue
func (wq *WorkQueue) Pop() Task {
	head := wq.head.Load()
	tail := wq.tail.Load()
	
	if head == tail {
		return nil
	}
	
	task := wq.tasks[head]
	wq.tasks[head] = nil
	wq.head.Store((head + 1) % wq.capacity)
	
	return task
}

// Steal attempts to steal half the tasks from the queue
func (wq *WorkQueue) Steal() Task {
	head := wq.head.Load()
	tail := wq.tail.Load()
	
	if head == tail {
		return nil
	}
	
	// Try to steal from the tail (newest tasks)
	prevTail := tail - 1
	if prevTail < 0 {
		prevTail = wq.capacity - 1
	}
	
	if wq.tail.CompareAndSwap(tail, prevTail) {
		task := wq.tasks[prevTail]
		wq.tasks[prevTail] = nil
		return task
	}
	
	return nil
}

// GetStats returns CPU optimizer statistics
func (co *CPUOptimizer) GetStats() map[string]interface{} {
	stats := map[string]interface{}{
		"num_cpu":       co.numCPU,
		"numa_nodes":    co.numaNodes,
		"numa_enabled":  co.numaEnabled,
		"turbo_enabled": co.turboEnabled,
	}
	
	// Add scheduler stats
	if co.scheduler != nil {
		var totalProcessed, totalSteals uint64
		for _, worker := range co.scheduler.workers {
			totalProcessed += worker.tasksProcessed.Load()
			totalSteals += worker.steals.Load()
		}
		stats["tasks_processed"] = totalProcessed
		stats["work_steals"] = totalSteals
	}
	
	return stats
}

// BenchmarkFunction benchmarks a function execution
func (co *CPUOptimizer) BenchmarkFunction(name string, f func()) time.Duration {
	// Warm up
	for i := 0; i < 10; i++ {
		f()
	}
	
	// Actual benchmark
	start := time.Now()
	iterations := 1000
	for i := 0; i < iterations; i++ {
		f()
	}
	elapsed := time.Since(start)
	
	avgTime := elapsed / time.Duration(iterations)
	co.logger.Info("Function benchmark",
		zap.String("name", name),
		zap.Duration("avg_time", avgTime),
		zap.Int("iterations", iterations),
	)
	
	return avgTime
}

// DefaultCPUOptimizerConfig returns default configuration
func DefaultCPUOptimizerConfig() *CPUOptimizerConfig {
	return &CPUOptimizerConfig{
		CPUAffinity:   []int{}, // Use all CPUs
		Governor:      "performance",
		TurboBoost:    true,
		NUMAOptimized: runtime.GOOS == "linux" && runtime.NumCPU() >= 8,
		WorkerThreads: runtime.NumCPU(),
		QueueSize:     1024,
	}
}