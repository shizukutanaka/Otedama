package pool

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// UnifiedPool provides a generic, high-performance object pool
// Following Rob Pike's principle: "Don't communicate by sharing memory; share memory by communicating"
type UnifiedPool[T any] struct {
	name       string
	factory    Factory[T]
	reset      Reset[T]
	validator  Validator[T]
	destructor Destructor[T]
	
	// Pool configuration
	minSize    int
	maxSize    int
	maxIdle    int
	idleTime   time.Duration
	
	// Pool state
	items      chan *PoolItem[T]
	numOpen    atomic.Int32
	numIdle    atomic.Int32
	closed     atomic.Bool
	
	// Metrics
	stats      PoolStats
	
	// Lifecycle
	ctx        context.Context
	cancel     context.CancelFunc
	wg         sync.WaitGroup
	
	logger     *zap.Logger
}

// PoolItem wraps an item with metadata
type PoolItem[T any] struct {
	value      T
	createdAt  time.Time
	lastUsedAt time.Time
	useCount   uint64
}

// Factory creates new items
type Factory[T any] func() (T, error)

// Reset resets an item before returning to pool
type Reset[T any] func(T) error

// Validator validates an item is still usable
type Validator[T any] func(T) bool

// Destructor cleans up an item
type Destructor[T any] func(T)

// PoolStats tracks pool statistics
type PoolStats struct {
	Gets       atomic.Uint64
	Puts       atomic.Uint64
	Creates    atomic.Uint64
	Destroys   atomic.Uint64
	Timeouts   atomic.Uint64
	Errors     atomic.Uint64
}

// PoolConfig contains pool configuration
type PoolConfig struct {
	Name       string
	MinSize    int
	MaxSize    int
	MaxIdle    int
	IdleTime   time.Duration
}

// NewUnifiedPool creates a new unified pool
func NewUnifiedPool[T any](config PoolConfig, factory Factory[T], logger *zap.Logger) *UnifiedPool[T] {
	ctx, cancel := context.WithCancel(context.Background())
	
	// Validate config
	if config.MinSize < 0 {
		config.MinSize = 0
	}
	if config.MaxSize < 1 {
		config.MaxSize = 10
	}
	if config.MaxSize < config.MinSize {
		config.MaxSize = config.MinSize
	}
	if config.MaxIdle < 0 || config.MaxIdle > config.MaxSize {
		config.MaxIdle = config.MaxSize
	}
	if config.IdleTime <= 0 {
		config.IdleTime = 5 * time.Minute
	}
	
	pool := &UnifiedPool[T]{
		name:     config.Name,
		factory:  factory,
		minSize:  config.MinSize,
		maxSize:  config.MaxSize,
		maxIdle:  config.MaxIdle,
		idleTime: config.IdleTime,
		items:    make(chan *PoolItem[T], config.MaxSize),
		ctx:      ctx,
		cancel:   cancel,
		logger:   logger,
	}
	
	// Pre-create minimum items
	pool.wg.Add(1)
	go pool.maintainer()
	
	return pool
}

// SetReset sets the reset function
func (p *UnifiedPool[T]) SetReset(reset Reset[T]) {
	p.reset = reset
}

// SetValidator sets the validator function
func (p *UnifiedPool[T]) SetValidator(validator Validator[T]) {
	p.validator = validator
}

// SetDestructor sets the destructor function
func (p *UnifiedPool[T]) SetDestructor(destructor Destructor[T]) {
	p.destructor = destructor
}

// Get retrieves an item from the pool
func (p *UnifiedPool[T]) Get(ctx context.Context) (T, error) {
	var zero T
	
	if p.closed.Load() {
		return zero, errors.New("pool is closed")
	}
	
	p.stats.Gets.Add(1)
	
	// Try to get from pool
	select {
	case item := <-p.items:
		p.numIdle.Add(-1)
		
		// Validate item
		if p.validator != nil && !p.validator(item.value) {
			p.destroyItem(item)
			// Fall through to create new
		} else {
			item.lastUsedAt = time.Now()
			item.useCount++
			return item.value, nil
		}
		
	case <-ctx.Done():
		p.stats.Timeouts.Add(1)
		return zero, ctx.Err()
		
	default:
		// No items available
	}
	
	// Check if we can create new item
	if int(p.numOpen.Load()) >= p.maxSize {
		// Wait for available item
		select {
		case item := <-p.items:
			p.numIdle.Add(-1)
			item.lastUsedAt = time.Now()
			item.useCount++
			return item.value, nil
			
		case <-ctx.Done():
			p.stats.Timeouts.Add(1)
			return zero, ctx.Err()
		}
	}
	
	// Create new item
	return p.createItem()
}

// Put returns an item to the pool
func (p *UnifiedPool[T]) Put(value T) error {
	if p.closed.Load() {
		if p.destructor != nil {
			p.destructor(value)
		}
		return errors.New("pool is closed")
	}
	
	p.stats.Puts.Add(1)
	
	// Reset item if needed
	if p.reset != nil {
		if err := p.reset(value); err != nil {
			p.stats.Errors.Add(1)
			p.destroyValue(value)
			return err
		}
	}
	
	// Find the item wrapper
	item := &PoolItem[T]{
		value:      value,
		lastUsedAt: time.Now(),
	}
	
	// Try to return to pool
	select {
	case p.items <- item:
		p.numIdle.Add(1)
		return nil
	default:
		// Pool is full, destroy item
		p.destroyItem(item)
		return nil
	}
}

// Close closes the pool
func (p *UnifiedPool[T]) Close() error {
	if !p.closed.CompareAndSwap(false, true) {
		return errors.New("pool already closed")
	}
	
	// Cancel context
	p.cancel()
	
	// Wait for maintainer
	p.wg.Wait()
	
	// Close channel
	close(p.items)
	
	// Destroy all items
	for item := range p.items {
		p.destroyItem(item)
	}
	
	p.logger.Info("Pool closed",
		zap.String("name", p.name),
		zap.Uint64("total_gets", p.stats.Gets.Load()),
		zap.Uint64("total_puts", p.stats.Puts.Load()),
		zap.Uint64("total_creates", p.stats.Creates.Load()),
		zap.Uint64("total_destroys", p.stats.Destroys.Load()),
	)
	
	return nil
}

// GetStats returns pool statistics
func (p *UnifiedPool[T]) GetStats() PoolStatsSnapshot {
	return PoolStatsSnapshot{
		Name:     p.name,
		Open:     int(p.numOpen.Load()),
		Idle:     int(p.numIdle.Load()),
		MaxSize:  p.maxSize,
		Gets:     p.stats.Gets.Load(),
		Puts:     p.stats.Puts.Load(),
		Creates:  p.stats.Creates.Load(),
		Destroys: p.stats.Destroys.Load(),
		Timeouts: p.stats.Timeouts.Load(),
		Errors:   p.stats.Errors.Load(),
	}
}

// Private methods

func (p *UnifiedPool[T]) createItem() (T, error) {
	value, err := p.factory()
	if err != nil {
		p.stats.Errors.Add(1)
		return value, err
	}
	
	p.numOpen.Add(1)
	p.stats.Creates.Add(1)
	
	return value, nil
}

func (p *UnifiedPool[T]) destroyItem(item *PoolItem[T]) {
	p.destroyValue(item.value)
}

func (p *UnifiedPool[T]) destroyValue(value T) {
	p.numOpen.Add(-1)
	p.stats.Destroys.Add(1)
	
	if p.destructor != nil {
		p.destructor(value)
	}
}

func (p *UnifiedPool[T]) maintainer() {
	defer p.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	// Pre-create minimum items
	for i := 0; i < p.minSize; i++ {
		if value, err := p.factory(); err == nil {
			item := &PoolItem[T]{
				value:     value,
				createdAt: time.Now(),
			}
			select {
			case p.items <- item:
				p.numOpen.Add(1)
				p.numIdle.Add(1)
				p.stats.Creates.Add(1)
			default:
				p.destroyValue(value)
			}
		}
	}
	
	for {
		select {
		case <-p.ctx.Done():
			return
			
		case <-ticker.C:
			p.cleanup()
			p.ensureMinimum()
		}
	}
}

func (p *UnifiedPool[T]) cleanup() {
	// Remove idle items
	now := time.Now()
	toRemove := int(p.numIdle.Load()) - p.maxIdle
	
	for i := 0; i < toRemove; i++ {
		select {
		case item := <-p.items:
			if now.Sub(item.lastUsedAt) > p.idleTime {
				p.numIdle.Add(-1)
				p.destroyItem(item)
			} else {
				// Put it back
				p.items <- item
				break
			}
		default:
			break
		}
	}
}

func (p *UnifiedPool[T]) ensureMinimum() {
	// Ensure minimum items
	current := int(p.numOpen.Load())
	if current < p.minSize {
		for i := current; i < p.minSize; i++ {
			if value, err := p.factory(); err == nil {
				item := &PoolItem[T]{
					value:     value,
					createdAt: time.Now(),
				}
				select {
				case p.items <- item:
					p.numOpen.Add(1)
					p.numIdle.Add(1)
					p.stats.Creates.Add(1)
				default:
					p.destroyValue(value)
					break
				}
			}
		}
	}
}

// PoolStatsSnapshot represents a snapshot of pool statistics
type PoolStatsSnapshot struct {
	Name     string
	Open     int
	Idle     int
	MaxSize  int
	Gets     uint64
	Puts     uint64
	Creates  uint64
	Destroys uint64
	Timeouts uint64
	Errors   uint64
}

// Specialized pool implementations

// ByteSlicePool is a pool for byte slices
type ByteSlicePool struct {
	*UnifiedPool[[]byte]
	size int
}

// NewByteSlicePool creates a pool for byte slices
func NewByteSlicePool(name string, size int, maxItems int, logger *zap.Logger) *ByteSlicePool {
	config := PoolConfig{
		Name:    name,
		MinSize: 10,
		MaxSize: maxItems,
		MaxIdle: maxItems / 2,
	}
	
	factory := func() ([]byte, error) {
		return make([]byte, size), nil
	}
	
	pool := &ByteSlicePool{
		UnifiedPool: NewUnifiedPool(config, factory, logger),
		size:        size,
	}
	
	// Set reset function to clear the buffer
	pool.SetReset(func(b []byte) error {
		for i := range b {
			b[i] = 0
		}
		return nil
	})
	
	return pool
}

// ConnectionPool is a pool for network connections
type ConnectionPool struct {
	*UnifiedPool[net.Conn]
	address string
	dialer  func() (net.Conn, error)
}

// NewConnectionPool creates a pool for network connections
func NewConnectionPool(name, address string, config PoolConfig, logger *zap.Logger) *ConnectionPool {
	dialer := func() (net.Conn, error) {
		return net.DialTimeout("tcp", address, 30*time.Second)
	}
	
	factory := func() (net.Conn, error) {
		return dialer()
	}
	
	pool := &ConnectionPool{
		UnifiedPool: NewUnifiedPool(config, factory, logger),
		address:     address,
		dialer:      dialer,
	}
	
	// Set validator to check connection health
	pool.SetValidator(func(conn net.Conn) bool {
		// Set short deadline for health check
		conn.SetReadDeadline(time.Now().Add(1 * time.Millisecond))
		defer conn.SetReadDeadline(time.Time{})
		
		// Try to read 0 bytes
		buf := make([]byte, 0)
		_, err := conn.Read(buf)
		
		// Timeout means connection is still alive
		if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
			return true
		}
		
		return err == nil
	})
	
	// Set destructor to close connections
	pool.SetDestructor(func(conn net.Conn) {
		conn.Close()
	})
	
	return pool
}

// WorkerPool manages a pool of workers
type WorkerPool struct {
	name      string
	workers   []*Worker
	workQueue chan WorkItem
	logger    *zap.Logger
	
	running   atomic.Bool
	ctx       context.Context
	cancel    context.CancelFunc
	wg        sync.WaitGroup
}

// Worker represents a worker in the pool
type Worker struct {
	id        int
	pool      *WorkerPool
	
	processed atomic.Uint64
	errors    atomic.Uint64
}

// WorkItem represents a unit of work
type WorkItem interface {
	Process(context.Context) error
}

// NewWorkerPool creates a new worker pool
func NewWorkerPool(name string, numWorkers, queueSize int, logger *zap.Logger) *WorkerPool {
	ctx, cancel := context.WithCancel(context.Background())
	
	pool := &WorkerPool{
		name:      name,
		workers:   make([]*Worker, numWorkers),
		workQueue: make(chan WorkItem, queueSize),
		logger:    logger,
		ctx:       ctx,
		cancel:    cancel,
	}
	
	// Create workers
	for i := 0; i < numWorkers; i++ {
		pool.workers[i] = &Worker{
			id:   i,
			pool: pool,
		}
	}
	
	return pool
}

// Start starts the worker pool
func (wp *WorkerPool) Start() error {
	if !wp.running.CompareAndSwap(false, true) {
		return errors.New("worker pool already running")
	}
	
	// Start workers
	for _, worker := range wp.workers {
		wp.wg.Add(1)
		go worker.run(&wp.wg)
	}
	
	wp.logger.Info("Worker pool started",
		zap.String("name", wp.name),
		zap.Int("workers", len(wp.workers)),
	)
	
	return nil
}

// Submit submits work to the pool
func (wp *WorkerPool) Submit(item WorkItem) error {
	if !wp.running.Load() {
		return errors.New("worker pool not running")
	}
	
	select {
	case wp.workQueue <- item:
		return nil
	case <-wp.ctx.Done():
		return wp.ctx.Err()
	}
}

// Stop stops the worker pool
func (wp *WorkerPool) Stop() {
	if wp.running.CompareAndSwap(true, false) {
		wp.cancel()
		close(wp.workQueue)
		wp.wg.Wait()
		
		wp.logger.Info("Worker pool stopped",
			zap.String("name", wp.name),
		)
	}
}

// GetStats returns worker pool statistics
func (wp *WorkerPool) GetStats() WorkerPoolStats {
	stats := WorkerPoolStats{
		Name:        wp.name,
		NumWorkers:  len(wp.workers),
		QueueLength: len(wp.workQueue),
		QueueCap:    cap(wp.workQueue),
	}
	
	for _, worker := range wp.workers {
		stats.TotalProcessed += worker.processed.Load()
		stats.TotalErrors += worker.errors.Load()
	}
	
	return stats
}

func (w *Worker) run(wg *sync.WaitGroup) {
	defer wg.Done()
	
	for {
		select {
		case item, ok := <-w.pool.workQueue:
			if !ok {
				return
			}
			
			if err := item.Process(w.pool.ctx); err != nil {
				w.errors.Add(1)
				w.pool.logger.Error("Work item failed",
					zap.Int("worker_id", w.id),
					zap.Error(err),
				)
			} else {
				w.processed.Add(1)
			}
			
		case <-w.pool.ctx.Done():
			return
		}
	}
}

// WorkerPoolStats contains worker pool statistics
type WorkerPoolStats struct {
	Name           string
	NumWorkers     int
	QueueLength    int
	QueueCap       int
	TotalProcessed uint64
	TotalErrors    uint64
}

// PoolManager manages multiple pools
type PoolManager struct {
	pools  map[string]interface{}
	mu     sync.RWMutex
	logger *zap.Logger
}

// NewPoolManager creates a new pool manager
func NewPoolManager(logger *zap.Logger) *PoolManager {
	return &PoolManager{
		pools:  make(map[string]interface{}),
		logger: logger,
	}
}

// RegisterPool registers a pool
func (pm *PoolManager) RegisterPool(name string, pool interface{}) {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	
	pm.pools[name] = pool
}

// GetPool retrieves a pool by name
func (pm *PoolManager) GetPool(name string) (interface{}, bool) {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	
	pool, exists := pm.pools[name]
	return pool, exists
}

// CloseAll closes all managed pools
func (pm *PoolManager) CloseAll() {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	
	for name, pool := range pm.pools {
		switch p := pool.(type) {
		case interface{ Close() error }:
			if err := p.Close(); err != nil {
				pm.logger.Error("Failed to close pool",
					zap.String("name", name),
					zap.Error(err),
				)
			}
		case interface{ Stop() }:
			p.Stop()
		}
	}
	
	pm.pools = make(map[string]interface{})
}