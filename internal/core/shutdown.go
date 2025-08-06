package core

import (
	"context"
	"fmt"
	"sync"
	"time"

	"go.uber.org/zap"
)

// ShutdownHandler manages graceful shutdown
type ShutdownHandler struct {
	logger         *zap.Logger
	hooks          []ShutdownHook
	mu             sync.RWMutex
	shutdownOnce   sync.Once
	isShuttingDown bool
}

// ShutdownHook is a function called during shutdown
type ShutdownHook struct {
	Name     string
	Priority int // Lower number = higher priority
	Hook     func(context.Context) error
}

// NewShutdownHandler creates a new shutdown handler
func NewShutdownHandler(logger *zap.Logger) *ShutdownHandler {
	return &ShutdownHandler{
		logger: logger,
		hooks:  make([]ShutdownHook, 0),
	}
}

// RegisterHook registers a shutdown hook
func (sh *ShutdownHandler) RegisterHook(hook ShutdownHook) {
	sh.mu.Lock()
	defer sh.mu.Unlock()
	
	// Insert hook in priority order
	inserted := false
	for i, h := range sh.hooks {
		if hook.Priority < h.Priority {
			// Insert at this position
			sh.hooks = append(sh.hooks[:i], append([]ShutdownHook{hook}, sh.hooks[i:]...)...)
			inserted = true
			break
		}
	}
	
	if !inserted {
		sh.hooks = append(sh.hooks, hook)
	}
	
	sh.logger.Debug("Shutdown hook registered",
		zap.String("name", hook.Name),
		zap.Int("priority", hook.Priority),
	)
}

// Shutdown executes all shutdown hooks
func (sh *ShutdownHandler) Shutdown(ctx context.Context) error {
	var finalErr error
	
	sh.shutdownOnce.Do(func() {
		sh.mu.Lock()
		sh.isShuttingDown = true
		hooks := make([]ShutdownHook, len(sh.hooks))
		copy(hooks, sh.hooks)
		sh.mu.Unlock()
		
		sh.logger.Info("Executing shutdown hooks",
			zap.Int("count", len(hooks)),
		)
		
		// Execute hooks in priority order
		for _, hook := range hooks {
			select {
			case <-ctx.Done():
				sh.logger.Warn("Shutdown context cancelled",
					zap.String("hook", hook.Name),
				)
				finalErr = ctx.Err()
				return
			default:
			}
			
			sh.logger.Info("Executing shutdown hook",
				zap.String("name", hook.Name),
			)
			
			// Create a sub-context with timeout for this hook
			hookCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := hook.Hook(hookCtx)
			cancel()
			
			if err != nil {
				sh.logger.Error("Shutdown hook failed",
					zap.String("name", hook.Name),
					zap.Error(err),
				)
				if finalErr == nil {
					finalErr = fmt.Errorf("hook %s failed: %w", hook.Name, err)
				}
			} else {
				sh.logger.Info("Shutdown hook completed",
					zap.String("name", hook.Name),
				)
			}
		}
	})
	
	return finalErr
}

// IsShuttingDown returns true if shutdown is in progress
func (sh *ShutdownHandler) IsShuttingDown() bool {
	sh.mu.RLock()
	defer sh.mu.RUnlock()
	return sh.isShuttingDown
}

// GracefulShutdown provides a helper for graceful shutdown with timeout
type GracefulShutdown struct {
	logger  *zap.Logger
	timeout time.Duration
	tasks   []GracefulTask
	mu      sync.Mutex
}

// GracefulTask represents a task to complete during shutdown
type GracefulTask struct {
	Name string
	Task func(context.Context) error
}

// NewGracefulShutdown creates a new graceful shutdown helper
func NewGracefulShutdown(logger *zap.Logger, timeout time.Duration) *GracefulShutdown {
	return &GracefulShutdown{
		logger:  logger,
		timeout: timeout,
		tasks:   make([]GracefulTask, 0),
	}
}

// AddTask adds a task to complete during shutdown
func (gs *GracefulShutdown) AddTask(task GracefulTask) {
	gs.mu.Lock()
	defer gs.mu.Unlock()
	
	gs.tasks = append(gs.tasks, task)
}

// Execute performs graceful shutdown
func (gs *GracefulShutdown) Execute() error {
	gs.mu.Lock()
	tasks := make([]GracefulTask, len(gs.tasks))
	copy(tasks, gs.tasks)
	gs.mu.Unlock()
	
	gs.logger.Info("Starting graceful shutdown",
		zap.Duration("timeout", gs.timeout),
		zap.Int("tasks", len(tasks)),
	)
	
	ctx, cancel := context.WithTimeout(context.Background(), gs.timeout)
	defer cancel()
	
	// Execute tasks concurrently
	var wg sync.WaitGroup
	errChan := make(chan error, len(tasks))
	
	for _, task := range tasks {
		wg.Add(1)
		go func(t GracefulTask) {
			defer wg.Done()
			
			gs.logger.Info("Executing shutdown task",
				zap.String("task", t.Name),
			)
			
			if err := t.Task(ctx); err != nil {
				gs.logger.Error("Shutdown task failed",
					zap.String("task", t.Name),
					zap.Error(err),
				)
				errChan <- fmt.Errorf("%s: %w", t.Name, err)
			} else {
				gs.logger.Info("Shutdown task completed",
					zap.String("task", t.Name),
				)
			}
		}(task)
	}
	
	// Wait for all tasks to complete
	doneChan := make(chan struct{})
	go func() {
		wg.Wait()
		close(doneChan)
	}()
	
	select {
	case <-doneChan:
		// All tasks completed
		close(errChan)
		
		// Collect errors
		var errors []error
		for err := range errChan {
			errors = append(errors, err)
		}
		
		if len(errors) > 0 {
			return fmt.Errorf("shutdown completed with %d errors: %v", len(errors), errors[0])
		}
		
		gs.logger.Info("Graceful shutdown completed successfully")
		return nil
		
	case <-ctx.Done():
		// Timeout
		gs.logger.Error("Graceful shutdown timed out")
		return fmt.Errorf("graceful shutdown timed out after %v", gs.timeout)
	}
}

// SaveState saves application state before shutdown
func SaveState(logger *zap.Logger, stateFile string, state interface{}) error {
	logger.Info("Saving application state",
		zap.String("file", stateFile),
	)
	
	// This would serialize and save the state
	// For now, just log
	
	return nil
}

// CleanupResources performs resource cleanup
func CleanupResources(logger *zap.Logger) error {
	logger.Info("Cleaning up resources")
	
	// This would clean up temporary files, close handles, etc.
	// For now, just log
	
	return nil
}