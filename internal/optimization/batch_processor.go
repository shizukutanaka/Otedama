package optimization

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// BatchProcessor handles efficient batch processing of items
type BatchProcessor struct {
	logger    *zap.Logger
	config    BatchConfig
	
	// Processing
	processor BatchHandler
	workers   int
	
	// Batching
	batch     []interface{}
	batchLock sync.Mutex
	batchCond *sync.Cond
	
	// State
	running   atomic.Bool
	processed atomic.Uint64
	errors    atomic.Uint64
	
	// Channels
	itemChan  chan interface{}
	stopChan  chan struct{}
	doneChan  chan struct{}
}

// BatchConfig defines batch processing configuration
type BatchConfig struct {
	MaxBatchSize    int           `yaml:"max_batch_size"`
	MaxWaitTime     time.Duration `yaml:"max_wait_time"`
	Workers         int           `yaml:"workers"`
	ChannelSize     int           `yaml:"channel_size"`
	RetryAttempts   int           `yaml:"retry_attempts"`
	RetryDelay      time.Duration `yaml:"retry_delay"`
	FlushOnStop     bool          `yaml:"flush_on_stop"`
	ConcurrentBatch bool          `yaml:"concurrent_batch"`
}

// BatchHandler processes batches of items
type BatchHandler interface {
	ProcessBatch(ctx context.Context, items []interface{}) error
	OnError(ctx context.Context, items []interface{}, err error)
}

// NewBatchProcessor creates a new batch processor
func NewBatchProcessor(logger *zap.Logger, config BatchConfig, handler BatchHandler) *BatchProcessor {
	// Set defaults
	if config.MaxBatchSize == 0 {
		config.MaxBatchSize = 100
	}
	if config.MaxWaitTime == 0 {
		config.MaxWaitTime = 100 * time.Millisecond
	}
	if config.Workers == 0 {
		config.Workers = 4
	}
	if config.ChannelSize == 0 {
		config.ChannelSize = 10000
	}
	
	bp := &BatchProcessor{
		logger:    logger,
		config:    config,
		processor: handler,
		workers:   config.Workers,
		batch:     make([]interface{}, 0, config.MaxBatchSize),
		itemChan:  make(chan interface{}, config.ChannelSize),
		stopChan:  make(chan struct{}),
		doneChan:  make(chan struct{}),
	}
	
	bp.batchCond = sync.NewCond(&bp.batchLock)
	
	return bp
}

// Start begins batch processing
func (bp *BatchProcessor) Start(ctx context.Context) error {
	if !bp.running.CompareAndSwap(false, true) {
		return fmt.Errorf("batch processor already running")
	}
	
	bp.logger.Info("Starting batch processor",
		zap.Int("workers", bp.workers),
		zap.Int("batch_size", bp.config.MaxBatchSize),
	)
	
	// Start worker goroutines
	var wg sync.WaitGroup
	
	// Batch collector
	wg.Add(1)
	go func() {
		defer wg.Done()
		bp.batchCollector(ctx)
	}()
	
	// Batch processors
	for i := 0; i < bp.workers; i++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			bp.batchWorker(ctx, workerID)
		}(i)
	}
	
	// Wait for completion
	go func() {
		wg.Wait()
		close(bp.doneChan)
	}()
	
	return nil
}

// Stop halts batch processing
func (bp *BatchProcessor) Stop() error {
	if !bp.running.CompareAndSwap(true, false) {
		return fmt.Errorf("batch processor not running")
	}
	
	bp.logger.Info("Stopping batch processor")
	
	// Signal stop
	close(bp.stopChan)
	
	// Flush remaining items if configured
	if bp.config.FlushOnStop {
		bp.Flush()
	}
	
	// Wait for completion
	<-bp.doneChan
	
	bp.logger.Info("Batch processor stopped",
		zap.Uint64("total_processed", bp.processed.Load()),
		zap.Uint64("total_errors", bp.errors.Load()),
	)
	
	return nil
}

// Add adds an item for batch processing
func (bp *BatchProcessor) Add(item interface{}) error {
	if !bp.running.Load() {
		return fmt.Errorf("batch processor not running")
	}
	
	select {
	case bp.itemChan <- item:
		return nil
	default:
		return fmt.Errorf("batch processor queue full")
	}
}

// AddWithTimeout adds an item with timeout
func (bp *BatchProcessor) AddWithTimeout(item interface{}, timeout time.Duration) error {
	if !bp.running.Load() {
		return fmt.Errorf("batch processor not running")
	}
	
	select {
	case bp.itemChan <- item:
		return nil
	case <-time.After(timeout):
		return fmt.Errorf("timeout adding item to batch processor")
	}
}

// Flush processes any pending items immediately
func (bp *BatchProcessor) Flush() {
	bp.batchLock.Lock()
	defer bp.batchLock.Unlock()
	
	if len(bp.batch) > 0 {
		bp.batchCond.Signal()
	}
}

// GetStats returns processing statistics
func (bp *BatchProcessor) GetStats() map[string]interface{} {
	return map[string]interface{}{
		"processed":    bp.processed.Load(),
		"errors":       bp.errors.Load(),
		"queue_size":   len(bp.itemChan),
		"batch_size":   len(bp.batch),
		"running":      bp.running.Load(),
		"workers":      bp.workers,
		"max_batch":    bp.config.MaxBatchSize,
	}
}

// Batch collector goroutine
func (bp *BatchProcessor) batchCollector(ctx context.Context) {
	timer := time.NewTimer(bp.config.MaxWaitTime)
	defer timer.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-bp.stopChan:
			return
		case item := <-bp.itemChan:
			bp.addToBatch(item)
			
			// Reset timer
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(bp.config.MaxWaitTime)
			
		case <-timer.C:
			bp.processPendingBatch()
			timer.Reset(bp.config.MaxWaitTime)
		}
	}
}

// Batch worker goroutine
func (bp *BatchProcessor) batchWorker(ctx context.Context, workerID int) {
	for {
		bp.batchLock.Lock()
		
		// Wait for batch
		for len(bp.batch) == 0 && bp.running.Load() {
			bp.batchCond.Wait()
		}
		
		// Check if we should exit
		if !bp.running.Load() && len(bp.batch) == 0 {
			bp.batchLock.Unlock()
			return
		}
		
		// Get batch
		batch := bp.batch
		bp.batch = make([]interface{}, 0, bp.config.MaxBatchSize)
		bp.batchLock.Unlock()
		
		// Process batch
		if len(batch) > 0 {
			bp.processBatchWithRetry(ctx, batch)
		}
	}
}

func (bp *BatchProcessor) addToBatch(item interface{}) {
	bp.batchLock.Lock()
	defer bp.batchLock.Unlock()
	
	bp.batch = append(bp.batch, item)
	
	// Process if batch is full
	if len(bp.batch) >= bp.config.MaxBatchSize {
		bp.batchCond.Signal()
	}
}

func (bp *BatchProcessor) processPendingBatch() {
	bp.batchLock.Lock()
	defer bp.batchLock.Unlock()
	
	if len(bp.batch) > 0 {
		bp.batchCond.Signal()
	}
}

func (bp *BatchProcessor) processBatchWithRetry(ctx context.Context, batch []interface{}) {
	var err error
	
	for attempt := 0; attempt <= bp.config.RetryAttempts; attempt++ {
		if attempt > 0 {
			time.Sleep(bp.config.RetryDelay)
		}
		
		err = bp.processor.ProcessBatch(ctx, batch)
		if err == nil {
			bp.processed.Add(uint64(len(batch)))
			return
		}
		
		bp.logger.Warn("Batch processing failed",
			zap.Error(err),
			zap.Int("attempt", attempt+1),
			zap.Int("batch_size", len(batch)),
		)
	}
	
	// All retries failed
	bp.errors.Add(uint64(len(batch)))
	bp.processor.OnError(ctx, batch, err)
}

// ParallelBatchProcessor processes batches in parallel
type ParallelBatchProcessor struct {
	logger     *zap.Logger
	processors []*BatchProcessor
	
	// Load balancing
	current    atomic.Uint64
	strategy   LoadBalanceStrategy
}

// LoadBalanceStrategy defines how to distribute items
type LoadBalanceStrategy int

const (
	RoundRobin LoadBalanceStrategy = iota
	LeastLoaded
	Hash
)

// NewParallelBatchProcessor creates a parallel batch processor
func NewParallelBatchProcessor(logger *zap.Logger, count int, config BatchConfig, handler BatchHandler) *ParallelBatchProcessor {
	processors := make([]*BatchProcessor, count)
	
	for i := 0; i < count; i++ {
		processors[i] = NewBatchProcessor(
			logger.With(zap.Int("processor", i)),
			config,
			handler,
		)
	}
	
	return &ParallelBatchProcessor{
		logger:     logger,
		processors: processors,
		strategy:   RoundRobin,
	}
}

// Start starts all processors
func (pbp *ParallelBatchProcessor) Start(ctx context.Context) error {
	for i, processor := range pbp.processors {
		if err := processor.Start(ctx); err != nil {
			return fmt.Errorf("failed to start processor %d: %w", i, err)
		}
	}
	return nil
}

// Stop stops all processors
func (pbp *ParallelBatchProcessor) Stop() error {
	var firstErr error
	
	for i, processor := range pbp.processors {
		if err := processor.Stop(); err != nil && firstErr == nil {
			firstErr = fmt.Errorf("failed to stop processor %d: %w", i, err)
		}
	}
	
	return firstErr
}

// Add distributes items based on strategy
func (pbp *ParallelBatchProcessor) Add(item interface{}) error {
	processor := pbp.selectProcessor(item)
	return processor.Add(item)
}

func (pbp *ParallelBatchProcessor) selectProcessor(item interface{}) *BatchProcessor {
	switch pbp.strategy {
	case RoundRobin:
		index := pbp.current.Add(1) % uint64(len(pbp.processors))
		return pbp.processors[index]
		
	case LeastLoaded:
		// Find processor with smallest queue
		minLoad := int(^uint(0) >> 1) // Max int
		minIndex := 0
		
		for i, processor := range pbp.processors {
			stats := processor.GetStats()
			queueSize := stats["queue_size"].(int)
			if queueSize < minLoad {
				minLoad = queueSize
				minIndex = i
			}
		}
		
		return pbp.processors[minIndex]
		
	case Hash:
		// Hash-based distribution (implement based on item type)
		hash := uint64(0) // Calculate hash of item
		index := hash % uint64(len(pbp.processors))
		return pbp.processors[index]
		
	default:
		return pbp.processors[0]
	}
}

// GetStats returns aggregated statistics
func (pbp *ParallelBatchProcessor) GetStats() map[string]interface{} {
	totalProcessed := uint64(0)
	totalErrors := uint64(0)
	totalQueueSize := 0
	
	for _, processor := range pbp.processors {
		stats := processor.GetStats()
		totalProcessed += stats["processed"].(uint64)
		totalErrors += stats["errors"].(uint64)
		totalQueueSize += stats["queue_size"].(int)
	}
	
	return map[string]interface{}{
		"processors":    len(pbp.processors),
		"processed":     totalProcessed,
		"errors":        totalErrors,
		"queue_size":    totalQueueSize,
		"strategy":      pbp.strategy,
	}
}