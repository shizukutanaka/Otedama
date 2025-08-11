package logging

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"gopkg.in/natefinch/lumberjack.v2"
)

// global state
var (
	globalFactory *Factory
	once          sync.Once
)

// Factory is responsible for creating and managing loggers.
// It ensures that loggers are configured consistently according to the provided settings.
// This follows the Factory pattern and Single Responsibility Principle.
type Factory struct {
	config    *Config
	rootLogger *zap.Logger
	loggers    map[string]*zap.Logger
	mu         sync.RWMutex
}

// InitGlobalFactory initializes the global logger factory with the given configuration.
// This function should be called once at the application's startup.
func InitGlobalFactory(config *Config) (*Factory, error) {
	var err error
	once.Do(func() {
		globalFactory, err = newFactory(config)
	})
	if err != nil {
		return nil, err
	}
	return globalFactory, nil
}

// GetLogger returns a logger for a specific module/component.
// If a logger for the module doesn't exist, it creates one.
// This allows for different log levels and settings per module.
func GetLogger(module string) *zap.Logger {
	if globalFactory == nil {
		// Fallback to a default logger if the factory is not initialized.
		// This is not ideal but prevents panics.
		fallback, _ := zap.NewProduction()
		return fallback.Named(module)
	}
	return globalFactory.GetLogger(module)
}

// Sync flushes any buffered log entries in all created loggers.
// It's crucial to call this before the application exits.
func Sync() error {
	if globalFactory == nil {
		return nil
	}
	return globalFactory.Sync()
}

// newFactory creates a new logger factory instance.
func newFactory(config *Config) (*Factory, error) {
	if config == nil {
		config = DefaultConfig()
	}

	// Create the root logger based on the configuration.
	rootLogger, err := createLogger(config, config.Level)
	if err != nil {
		return nil, fmt.Errorf("failed to create root logger: %w", err)
	}

	factory := &Factory{
		config:    config,
		rootLogger: rootLogger,
		loggers:    make(map[string]*zap.Logger),
	}

	// Replace the global zap logger with our root logger.
	zap.ReplaceGlobals(rootLogger)

	return factory, nil
}

// GetLogger retrieves a logger for a given module from the factory.
func (f *Factory) GetLogger(module string) *zap.Logger {
	f.mu.RLock()
	if logger, exists := f.loggers[module]; exists {
		f.mu.RUnlock()
		return logger
	}
	f.mu.RUnlock()

	f.mu.Lock()
	defer f.mu.Unlock()

	// Double-check after acquiring the write lock.
	if logger, exists := f.loggers[module]; exists {
		return logger
	}

	// Determine the log level for this specific module.
	levelStr, ok := f.config.ModuleLevels[module]
	if !ok {
		// If no specific level is set, use the root logger's level.
		logger := f.rootLogger.Named(module)
		f.loggers[module] = logger
		return logger
	}

	// Create a new logger with the module-specific level.
	logger, err := createLogger(f.config, levelStr)
	if err != nil {
		// If creation fails, fall back to the root logger.
		zap.L().Error("failed to create module logger", zap.String("module", module), zap.Error(err))
		logger = f.rootLogger.Named(module)
	}

	f.loggers[module] = logger
	return logger
}

// Sync flushes all managed loggers.
func (f *Factory) Sync() error {
	var firstErr error

	if err := f.rootLogger.Sync(); err != nil {
		firstErr = err
	}

	f.mu.RLock()
	defer f.mu.RUnlock()
	for _, logger := range f.loggers {
		if err := logger.Sync(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// createLogger builds a zap.Logger instance based on the provided configuration and level.
func createLogger(config *Config, levelStr string) (*zap.Logger, error) {
	// Parse the log level string.
	level, err := zapcore.ParseLevel(levelStr)
	if err != nil {
		return nil, fmt.Errorf("invalid log level '%s': %w", levelStr, err)
	}

	// Create the encoder.
	encoder := createEncoder(config)

	// Create the write syncer (destination for logs).
	writer, err := createWriteSyncer(config)
	if err != nil {
		return nil, err
	}

	// Build the zap core.
	core := zapcore.NewCore(encoder, writer, level)

	// Apply sampling if it's enabled.
	if config.Sampling != nil && config.Sampling.Enabled {
		core = zapcore.NewSamplerWithOptions(
			core,
			time.Second,
			config.Sampling.Initial,
			config.Sampling.Thereafter,
		)
	}

	// Assemble the logger options.
	opts := buildOptions(config)

	// Create the final logger.
	logger := zap.New(core, opts...)

	return logger, nil
}

// createEncoder selects and configures the log encoder.
func createEncoder(config *Config) zapcore.Encoder {
	encoderConfig := config.buildEncoderConfig()
	if config.Format == "console" {
		return zapcore.NewConsoleEncoder(encoderConfig)
	}
	return zapcore.NewJSONEncoder(encoderConfig)
}

// createWriteSyncer sets up the destination for log output (file, stdout, etc.).
func createWriteSyncer(config *Config) (zapcore.WriteSyncer, error) {
	// Ensure the log directory exists.
	if config.OutputPath != "stdout" && config.OutputPath != "stderr" {
		dir := filepath.Dir(config.OutputPath)
		if err := os.MkdirAll(dir, 0755); err != nil {
			return nil, fmt.Errorf("failed to create log directory: %w", err)
		}
	}

	// Set up file-based logging with rotation.
	lumberjackLogger := &lumberjack.Logger{
		Filename:   config.OutputPath,
		MaxSize:    config.Rotation.MaxSize,
		MaxAge:     config.Rotation.MaxAge,
		MaxBackups: config.Rotation.MaxBackups,
		LocalTime:  config.Rotation.LocalTime,
		Compress:   config.Rotation.Compress,
	}

	// Combine outputs if necessary (e.g., file and stdout).
	syncers := []zapcore.WriteSyncer{zapcore.AddSync(lumberjackLogger)}
	if config.Development {
		syncers = append(syncers, zapcore.AddSync(os.Stdout))
	}

	return zapcore.NewMultiWriteSyncer(syncers...), nil
}

// buildOptions constructs the zap.Option slice from the configuration.
func buildOptions(config *Config) []zap.Option {
	var opts []zap.Option

	if config.EnableCaller {
		opts = append(opts, zap.AddCaller())
	}

	if config.EnableStacktrace {
		opts = append(opts, zap.AddStacktrace(zapcore.ErrorLevel))
	}

	if config.Development {
		opts = append(opts, zap.Development())
	}

	if len(config.InitialFields) > 0 {
		fields := make([]zap.Field, 0, len(config.InitialFields))
		for k, v := range config.InitialFields {
			fields = append(fields, zap.Any(k, v))
		}
		opts = append(opts, zap.Fields(fields...))
	}

	return opts
}
