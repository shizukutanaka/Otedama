package config

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"go.uber.org/zap"
	"gopkg.in/yaml.v3"
)

// Manager handles the lifecycle of the application's configuration.
// It is responsible for loading, saving, and coordinating updates.
// This follows the Single Responsibility Principle, focusing only on management tasks.
type Manager struct {
	logger     *zap.Logger
	configPath string

	config   *Config
	configMu sync.RWMutex

	validator *Validator
	envLoader *EnvLoader
	watcher   *ConfigWatcher

	onChangeCallbacks []func(*Config)
}

// NewManager creates and initializes a new configuration manager.
// It performs the initial load of the configuration.
func NewManager(logger *zap.Logger, configPath string) (*Manager, error) {
	m := &Manager{
		logger:     logger.Named("config_manager"),
		configPath: configPath,
		validator:  NewValidator(),
		envLoader:  NewEnvLoader("OTEDAMA"), // Environment variable prefix
	}

	// Perform the initial configuration load.
	if err := m.Load(); err != nil {
		return nil, fmt.Errorf("initial config load failed: %w", err)
	}

	return m, nil
}

// Load reads configuration from the specified file, overrides with environment
// variables, validates it, and applies it.
func (m *Manager) Load() error {
	// Start with default values.
	cfg := DefaultConfig()

	// Load from YAML file if it exists.
	data, err := os.ReadFile(m.configPath)
	if err != nil {
		if !os.IsNotExist(err) {
			return fmt.Errorf("failed to read config file: %w", err)
		}
		// If the file doesn't exist, we proceed with defaults and env vars.
	} else {
		if err := yaml.Unmarshal(data, cfg); err != nil {
			return fmt.Errorf("failed to parse YAML config: %w", err)
		}
	}

	// Override with values from environment variables.
	if err := m.envLoader.Load(cfg); err != nil {
		return fmt.Errorf("failed to load config from environment: %w", err)
	}

	// Validate the final configuration.
	if err := m.validator.Validate(cfg); err != nil {
		return fmt.Errorf("configuration validation failed: %w", err)
	}

	// Atomically update the current configuration.
	m.configMu.Lock()
	m.config = cfg
	m.configMu.Unlock()

	// Notify all registered callbacks about the change.
	m.notifyChange(cfg)

	m.logger.Info("Configuration loaded and applied successfully")
	return nil
}

// Save writes the current configuration to the file.
func (m *Manager) Save() error {
	m.configMu.RLock()
	configToSave := m.config
	m.configMu.RUnlock()

	data, err := yaml.Marshal(configToSave)
	if err != nil {
		return fmt.Errorf("failed to marshal config to YAML: %w", err)
	}

	// Ensure the directory exists.
	dir := filepath.Dir(m.configPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create config directory: %w", err)
	}

	// Write to a temporary file first for atomicity.
	tempFile := m.configPath + ".tmp"
	if err := os.WriteFile(tempFile, data, 0644); err != nil {
		return fmt.Errorf("failed to write to temporary config file: %w", err)
	}

	// Atomically rename the temporary file to the final destination.
	if err := os.Rename(tempFile, m.configPath); err != nil {
		return fmt.Errorf("failed to rename temp config file: %w", err)
	}

	m.logger.Info("Configuration saved successfully", zap.String("path", m.configPath))
	return nil
}

// Get returns a thread-safe copy of the current configuration.
func (m *Manager) Get() *Config {
	m.configMu.RLock()
	defer m.configMu.RUnlock()

	// Return a deep copy to prevent modification of the live config.
	cfgCopy := *m.config
	return &cfgCopy
}

// OnChange registers a callback function to be executed when the configuration changes.
func (m *Manager) OnChange(callback func(*Config)) {
	m.configMu.Lock()
	defer m.configMu.Unlock()
	m.onChangeCallbacks = append(m.onChangeCallbacks, callback)
}

// notifyChange executes all registered callbacks with the new configuration.
func (m *Manager) notifyChange(newConfig *Config) {
	m.configMu.RLock()
	callbacks := m.onChangeCallbacks
	m.configMu.RUnlock()

	for _, callback := range callbacks {
		// Run callbacks in goroutines to avoid blocking.
		go callback(newConfig)
	}
}

// StartWatcher initializes and starts the file watcher for hot-reloading.
func (m *Manager) StartWatcher() error {
	var err error
	m.watcher, err = NewConfigWatcher(m.logger, m.configPath)
	if err != nil {
		return fmt.Errorf("failed to create config watcher: %w", err)
	}

	// The callback passed to the watcher will trigger a reload.
	return m.watcher.Start(func() {
		if err := m.Load(); err != nil {
			m.logger.Error("Failed to hot-reload configuration", zap.Error(err))
		}
	})
}

// StopWatcher stops the file watcher.
func (m *Manager) StopWatcher() {
	if m.watcher != nil {
		m.watcher.Stop()
	}
}
