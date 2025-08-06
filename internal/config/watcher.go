package config

import (
	"context"
	"fmt"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"go.uber.org/zap"
)

// ConfigWatcher watches configuration files for changes
type ConfigWatcher struct {
	logger    *zap.Logger
	path      string
	watcher   *fsnotify.Watcher
	callbacks []func()
	mu        sync.Mutex
	
	// Control
	ctx       context.Context
	cancel    context.CancelFunc
	running   bool
	
	// Debouncing
	debounce  time.Duration
	timer     *time.Timer
}

// NewConfigWatcher creates a new configuration watcher
func NewConfigWatcher(logger *zap.Logger, configPath string) (*ConfigWatcher, error) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, fmt.Errorf("failed to create file watcher: %w", err)
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	return &ConfigWatcher{
		logger:    logger,
		path:      configPath,
		watcher:   watcher,
		callbacks: make([]func(), 0),
		ctx:       ctx,
		cancel:    cancel,
		debounce:  1 * time.Second, // Default debounce period
	}, nil
}

// Start starts watching the configuration file
func (cw *ConfigWatcher) Start(onChange func()) error {
	cw.mu.Lock()
	defer cw.mu.Unlock()
	
	if cw.running {
		return fmt.Errorf("watcher already running")
	}
	
	// Add callback
	if onChange != nil {
		cw.callbacks = append(cw.callbacks, onChange)
	}
	
	// Add config file to watcher
	if err := cw.watcher.Add(cw.path); err != nil {
		return fmt.Errorf("failed to watch file %s: %w", cw.path, err)
	}
	
	// Also watch the directory for file moves/renames
	dir := filepath.Dir(cw.path)
	if err := cw.watcher.Add(dir); err != nil {
		cw.logger.Warn("Failed to watch directory", 
			zap.String("dir", dir),
			zap.Error(err),
		)
	}
	
	cw.running = true
	
	// Start event handler
	go cw.handleEvents()
	
	cw.logger.Info("Configuration watcher started",
		zap.String("path", cw.path),
	)
	
	return nil
}

// Stop stops the configuration watcher
func (cw *ConfigWatcher) Stop() {
	cw.mu.Lock()
	defer cw.mu.Unlock()
	
	if !cw.running {
		return
	}
	
	cw.cancel()
	cw.watcher.Close()
	cw.running = false
	
	// Cancel any pending timer
	if cw.timer != nil {
		cw.timer.Stop()
	}
	
	cw.logger.Info("Configuration watcher stopped")
}

// AddCallback adds a callback to be called on configuration changes
func (cw *ConfigWatcher) AddCallback(callback func()) {
	cw.mu.Lock()
	defer cw.mu.Unlock()
	
	cw.callbacks = append(cw.callbacks, callback)
}

// SetDebounce sets the debounce period for configuration changes
func (cw *ConfigWatcher) SetDebounce(duration time.Duration) {
	cw.mu.Lock()
	defer cw.mu.Unlock()
	
	cw.debounce = duration
}

// handleEvents handles file system events
func (cw *ConfigWatcher) handleEvents() {
	for {
		select {
		case event, ok := <-cw.watcher.Events:
			if !ok {
				return
			}
			
			// Check if event is for our config file
			if filepath.Clean(event.Name) != filepath.Clean(cw.path) {
				// Check if it's a directory event that might affect our file
				if filepath.Dir(event.Name) != filepath.Dir(cw.path) {
					continue
				}
			}
			
			// Handle different event types
			switch {
			case event.Op&fsnotify.Write == fsnotify.Write:
				cw.logger.Debug("Config file modified",
					zap.String("path", event.Name),
				)
				cw.scheduleReload()
				
			case event.Op&fsnotify.Create == fsnotify.Create:
				// File was created (possibly after being deleted)
				if filepath.Clean(event.Name) == filepath.Clean(cw.path) {
					cw.logger.Debug("Config file created",
						zap.String("path", event.Name),
					)
					// Re-add to watcher
					cw.watcher.Add(cw.path)
					cw.scheduleReload()
				}
				
			case event.Op&fsnotify.Remove == fsnotify.Remove:
				// File was removed
				if filepath.Clean(event.Name) == filepath.Clean(cw.path) {
					cw.logger.Warn("Config file removed",
						zap.String("path", event.Name),
					)
				}
				
			case event.Op&fsnotify.Rename == fsnotify.Rename:
				// File was renamed
				if filepath.Clean(event.Name) == filepath.Clean(cw.path) {
					cw.logger.Debug("Config file renamed",
						zap.String("path", event.Name),
					)
					// Try to re-add the file
					go func() {
						time.Sleep(100 * time.Millisecond)
						cw.watcher.Add(cw.path)
					}()
				}
			}
			
		case err, ok := <-cw.watcher.Errors:
			if !ok {
				return
			}
			cw.logger.Error("File watcher error", zap.Error(err))
			
		case <-cw.ctx.Done():
			return
		}
	}
}

// scheduleReload schedules a configuration reload with debouncing
func (cw *ConfigWatcher) scheduleReload() {
	cw.mu.Lock()
	defer cw.mu.Unlock()
	
	// Cancel existing timer
	if cw.timer != nil {
		cw.timer.Stop()
	}
	
	// Schedule new reload
	cw.timer = time.AfterFunc(cw.debounce, func() {
		cw.mu.Lock()
		callbacks := make([]func(), len(cw.callbacks))
		copy(callbacks, cw.callbacks)
		cw.mu.Unlock()
		
		cw.logger.Info("Reloading configuration",
			zap.String("path", cw.path),
		)
		
		// Call all callbacks
		for _, callback := range callbacks {
			callback()
		}
	})
}

// IsRunning returns whether the watcher is running
func (cw *ConfigWatcher) IsRunning() bool {
	cw.mu.Lock()
	defer cw.mu.Unlock()
	
	return cw.running
}

// GetWatchedPaths returns the paths being watched
func (cw *ConfigWatcher) GetWatchedPaths() []string {
	return []string{cw.path, filepath.Dir(cw.path)}
}