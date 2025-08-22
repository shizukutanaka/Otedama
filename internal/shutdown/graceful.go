package shutdown

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// GracefulShutdown manages graceful application shutdown
type GracefulShutdown struct {
	ctx           context.Context
	cancel        context.CancelFunc
	shutdownFuncs []ShutdownFunc
	funcsMu       sync.RWMutex
	
	// State tracking
	isShuttingDown atomic.Bool
	shutdownOnce   sync.Once
	
	// Configuration
	timeout        time.Duration
	forceTimeout   time.Duration
	
	// Statistics
	startTime      time.Time
	shutdownTime   atomic.Value
	
	// Channels
	done          chan struct{}
	errorChan     chan error
}

// ShutdownFunc represents a shutdown function
type ShutdownFunc struct {
	Name     string
	Priority int // Lower values have higher priority
	Timeout  time.Duration
	Handler  func(context.Context) error
}

// NewGracefulShutdown creates a new graceful shutdown manager
func NewGracefulShutdown(timeout time.Duration) *GracefulShutdown {
	ctx, cancel := context.WithCancel(context.Background())
	
	gs := &GracefulShutdown{
		ctx:          ctx,
		cancel:       cancel,
		timeout:      timeout,
		forceTimeout: timeout * 2,
		startTime:    time.Now(),
		done:         make(chan struct{}),
		errorChan:    make(chan error, 10),
	}
	
	// Register signal handlers
	gs.registerSignalHandlers()
	
	return gs
}

// Register registers a shutdown function
func (gs *GracefulShutdown) Register(name string, priority int, handler func(context.Context) error) {
	gs.RegisterWithTimeout(name, priority, gs.timeout, handler)
}

// RegisterWithTimeout registers a shutdown function with custom timeout
func (gs *GracefulShutdown) RegisterWithTimeout(name string, priority int, timeout time.Duration, handler func(context.Context) error) {
	gs.funcsMu.Lock()
	defer gs.funcsMu.Unlock()
	
	gs.shutdownFuncs = append(gs.shutdownFuncs, ShutdownFunc{
		Name:     name,
		Priority: priority,
		Timeout:  timeout,
		Handler:  handler,
	})
	
	// Sort by priority
	gs.sortShutdownFuncs()
}

// sortShutdownFuncs sorts shutdown functions by priority
func (gs *GracefulShutdown) sortShutdownFuncs() {
	// Simple bubble sort for small lists
	n := len(gs.shutdownFuncs)
	for i := 0; i < n-1; i++ {
		for j := 0; j < n-i-1; j++ {
			if gs.shutdownFuncs[j].Priority > gs.shutdownFuncs[j+1].Priority {
				gs.shutdownFuncs[j], gs.shutdownFuncs[j+1] = gs.shutdownFuncs[j+1], gs.shutdownFuncs[j]
			}
		}
	}
}

// registerSignalHandlers registers OS signal handlers
func (gs *GracefulShutdown) registerSignalHandlers() {
	sigChan := make(chan os.Signal, 2)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM, syscall.SIGQUIT)
	
	go func() {
		sig := <-sigChan
		fmt.Printf("\nReceived signal: %v\n", sig)
		gs.Shutdown()
		
		// If second signal received, force shutdown
		sig = <-sigChan
		fmt.Printf("\nReceived second signal: %v, forcing shutdown\n", sig)
		gs.ForceShutdown()
	}()
}

// Shutdown initiates graceful shutdown
func (gs *GracefulShutdown) Shutdown() error {
	var shutdownErr error
	
	gs.shutdownOnce.Do(func() {
		gs.isShuttingDown.Store(true)
		gs.shutdownTime.Store(time.Now())
		
		fmt.Println("Starting graceful shutdown...")
		
		// Create shutdown context with timeout
		ctx, cancel := context.WithTimeout(context.Background(), gs.timeout)
		defer cancel()
		
		// Execute shutdown functions
		shutdownErr = gs.executeShutdown(ctx)
		
		// Signal completion
		close(gs.done)
		gs.cancel()
		
		if shutdownErr != nil {
			fmt.Printf("Shutdown completed with errors: %v\n", shutdownErr)
		} else {
			fmt.Println("Graceful shutdown completed successfully")
		}
	})
	
	return shutdownErr
}

// executeShutdown executes all shutdown functions
func (gs *GracefulShutdown) executeShutdown(ctx context.Context) error {
	gs.funcsMu.RLock()
	funcs := make([]ShutdownFunc, len(gs.shutdownFuncs))
	copy(funcs, gs.shutdownFuncs)
	gs.funcsMu.RUnlock()
	
	var wg sync.WaitGroup
	errChan := make(chan error, len(funcs))
	
	// Group functions by priority
	priorityGroups := gs.groupByPriority(funcs)
	
	// Execute each priority group
	for priority, group := range priorityGroups {
		fmt.Printf("Executing shutdown priority %d (%d tasks)...\n", priority, len(group))
		
		// Execute functions in same priority concurrently
		for _, fn := range group {
			wg.Add(1)
			go func(f ShutdownFunc) {
				defer wg.Done()
				
				// Create context with function-specific timeout
				fnCtx, fnCancel := context.WithTimeout(ctx, f.Timeout)
				defer fnCancel()
				
				fmt.Printf("  Shutting down: %s\n", f.Name)
				start := time.Now()
				
				if err := f.Handler(fnCtx); err != nil {
					errChan <- fmt.Errorf("%s: %w", f.Name, err)
					fmt.Printf("  ✗ %s failed: %v (took %v)\n", f.Name, err, time.Since(start))
				} else {
					fmt.Printf("  ✓ %s completed (took %v)\n", f.Name, time.Since(start))
				}
			}(fn)
		}
		
		// Wait for priority group to complete
		wg.Wait()
	}
	
	// Collect errors
	close(errChan)
	var errs []error
	for err := range errChan {
		errs = append(errs, err)
	}
	
	if len(errs) > 0 {
		return fmt.Errorf("shutdown errors: %v", errs)
	}
	
	return nil
}

// groupByPriority groups shutdown functions by priority
func (gs *GracefulShutdown) groupByPriority(funcs []ShutdownFunc) map[int][]ShutdownFunc {
	groups := make(map[int][]ShutdownFunc)
	
	for _, fn := range funcs {
		groups[fn.Priority] = append(groups[fn.Priority], fn)
	}
	
	return groups
}

// ForceShutdown forces immediate shutdown
func (gs *GracefulShutdown) ForceShutdown() {
	fmt.Println("Forcing immediate shutdown...")
	os.Exit(1)
}

// Wait waits for shutdown to complete
func (gs *GracefulShutdown) Wait() {
	<-gs.done
}

// IsShuttingDown returns true if shutdown is in progress
func (gs *GracefulShutdown) IsShuttingDown() bool {
	return gs.isShuttingDown.Load()
}

// Context returns the shutdown context
func (gs *GracefulShutdown) Context() context.Context {
	return gs.ctx
}

// GetStatistics returns shutdown statistics
func (gs *GracefulShutdown) GetStatistics() map[string]interface{} {
	stats := make(map[string]interface{})
	stats["uptime"] = time.Since(gs.startTime).String()
	stats["is_shutting_down"] = gs.isShuttingDown.Load()
	
	if shutdownTime := gs.shutdownTime.Load(); shutdownTime != nil {
		st := shutdownTime.(time.Time)
		stats["shutdown_time"] = st
		stats["shutdown_duration"] = time.Since(st).String()
	}
	
	gs.funcsMu.RLock()
	stats["registered_handlers"] = len(gs.shutdownFuncs)
	gs.funcsMu.RUnlock()
	
	return stats
}

// StateManager manages application state for recovery
type StateManager struct {
	mu         sync.RWMutex
	state      map[string]interface{}
	persistent bool
	filename   string
}

// NewStateManager creates a new state manager
func NewStateManager(filename string) *StateManager {
	return &StateManager{
		state:      make(map[string]interface{}),
		persistent: filename != "",
		filename:   filename,
	}
}

// Save saves state to persistent storage
func (sm *StateManager) Save() error {
	if !sm.persistent {
		return nil
	}
	
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	
	// In production, serialize to JSON and save to file
	// For now, this is a placeholder
	return nil
}

// Load loads state from persistent storage
func (sm *StateManager) Load() error {
	if !sm.persistent {
		return nil
	}
	
	// In production, load from file and deserialize
	// For now, this is a placeholder
	return nil
}

// Set sets a state value
func (sm *StateManager) Set(key string, value interface{}) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	sm.state[key] = value
}

// Get gets a state value
func (sm *StateManager) Get(key string) (interface{}, bool) {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	val, exists := sm.state[key]
	return val, exists
}

// ShutdownCoordinator coordinates shutdown across multiple services
type ShutdownCoordinator struct {
	services map[string]Service
	mu       sync.RWMutex
	timeout  time.Duration
}

// Service represents a service that can be shutdown
type Service interface {
	Name() string
	Shutdown(context.Context) error
}

// NewShutdownCoordinator creates a new shutdown coordinator
func NewShutdownCoordinator(timeout time.Duration) *ShutdownCoordinator {
	return &ShutdownCoordinator{
		services: make(map[string]Service),
		timeout:  timeout,
	}
}

// RegisterService registers a service
func (sc *ShutdownCoordinator) RegisterService(service Service) {
	sc.mu.Lock()
	defer sc.mu.Unlock()
	sc.services[service.Name()] = service
}

// Shutdown shuts down all services
func (sc *ShutdownCoordinator) Shutdown(ctx context.Context) error {
	sc.mu.RLock()
	services := make([]Service, 0, len(sc.services))
	for _, svc := range sc.services {
		services = append(services, svc)
	}
	sc.mu.RUnlock()
	
	var wg sync.WaitGroup
	errChan := make(chan error, len(services))
	
	for _, svc := range services {
		wg.Add(1)
		go func(s Service) {
			defer wg.Done()
			
			svcCtx, cancel := context.WithTimeout(ctx, sc.timeout)
			defer cancel()
			
			if err := s.Shutdown(svcCtx); err != nil {
				errChan <- fmt.Errorf("%s: %w", s.Name(), err)
			}
		}(svc)
	}
	
	wg.Wait()
	close(errChan)
	
	var errs []error
	for err := range errChan {
		errs = append(errs, err)
	}
	
	if len(errs) > 0 {
		return errors.New("shutdown errors occurred")
	}
	
	return nil
}

// ResourceCleanup handles resource cleanup during shutdown
type ResourceCleanup struct {
	cleanupFuncs []func() error
	mu           sync.Mutex
}

// NewResourceCleanup creates a new resource cleanup manager
func NewResourceCleanup() *ResourceCleanup {
	return &ResourceCleanup{
		cleanupFuncs: make([]func() error, 0),
	}
}

// Register registers a cleanup function
func (rc *ResourceCleanup) Register(fn func() error) {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	rc.cleanupFuncs = append(rc.cleanupFuncs, fn)
}

// Cleanup executes all cleanup functions
func (rc *ResourceCleanup) Cleanup() error {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	
	var errs []error
	
	// Execute cleanup in reverse order (LIFO)
	for i := len(rc.cleanupFuncs) - 1; i >= 0; i-- {
		if err := rc.cleanupFuncs[i](); err != nil {
			errs = append(errs, err)
		}
	}
	
	if len(errs) > 0 {
		return fmt.Errorf("cleanup errors: %v", errs)
	}
	
	return nil
}