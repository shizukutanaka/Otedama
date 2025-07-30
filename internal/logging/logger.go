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

// LoggerFactory provides centralized logger creation
// Following Robert C. Martin's single responsibility principle
type LoggerFactory struct {
	config      *LogConfig
	rootLogger  *zap.Logger
	loggers     map[string]*zap.Logger
	loggersMu   sync.RWMutex
}

// LogConfig contains logging configuration
type LogConfig struct {
	// Output settings
	OutputPath      string `json:"output_path"`
	ErrorOutputPath string `json:"error_output_path"`
	
	// Log levels
	Level      string            `json:"level"`
	ModuleLevels map[string]string `json:"module_levels"`
	
	// Format settings
	Encoding    string `json:"encoding"` // json or console
	Development bool   `json:"development"`
	
	// Rotation settings
	MaxSizeMB    int  `json:"max_size_mb"`
	MaxBackups   int  `json:"max_backups"`
	MaxAgeDays   int  `json:"max_age_days"`
	Compress     bool `json:"compress"`
	
	// Performance settings
	DisableCaller     bool `json:"disable_caller"`
	DisableStacktrace bool `json:"disable_stacktrace"`
	Sampling          bool `json:"sampling"`
	
	// Fields to include
	IncludeHost    bool `json:"include_host"`
	IncludeVersion bool `json:"include_version"`
}

// NewLoggerFactory creates a new logger factory
func NewLoggerFactory(config *LogConfig) (*LoggerFactory, error) {
	if config == nil {
		config = DefaultLogConfig()
	}
	
	// Create log directory if needed
	logDir := filepath.Dir(config.OutputPath)
	if err := os.MkdirAll(logDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create log directory: %w", err)
	}
	
	// Build encoder config
	encoderConfig := buildEncoderConfig(config)
	
	// Build core
	core, err := buildCore(config, encoderConfig)
	if err != nil {
		return nil, fmt.Errorf("failed to build logger core: %w", err)
	}
	
	// Create root logger
	rootLogger := zap.New(
		core,
		buildOptions(config)...,
	)
	
	factory := &LoggerFactory{
		config:     config,
		rootLogger: rootLogger,
		loggers:    make(map[string]*zap.Logger),
	}
	
	// Set global logger
	zap.ReplaceGlobals(rootLogger)
	
	return factory, nil
}

// GetLogger returns a logger for the specified module
func (f *LoggerFactory) GetLogger(module string) *zap.Logger {
	f.loggersMu.RLock()
	if logger, exists := f.loggers[module]; exists {
		f.loggersMu.RUnlock()
		return logger
	}
	f.loggersMu.RUnlock()
	
	// Create new logger for module
	f.loggersMu.Lock()
	defer f.loggersMu.Unlock()
	
	// Double-check after acquiring write lock
	if logger, exists := f.loggers[module]; exists {
		return logger
	}
	
	// Create module logger with custom level if configured
	logger := f.rootLogger.Named(module)
	
	if levelStr, hasLevel := f.config.ModuleLevels[module]; hasLevel {
		level, err := zapcore.ParseLevel(levelStr)
		if err == nil {
			// Create new core with module-specific level
			core, _ := buildCoreWithLevel(f.config, level)
			logger = logger.WithOptions(zap.WrapCore(func(zapcore.Core) zapcore.Core {
				return core
			}))
		}
	}
	
	f.loggers[module] = logger
	return logger
}

// Sync flushes all loggers
func (f *LoggerFactory) Sync() error {
	var firstErr error
	
	// Sync root logger
	if err := f.rootLogger.Sync(); err != nil && firstErr == nil {
		firstErr = err
	}
	
	// Sync all module loggers
	f.loggersMu.RLock()
	defer f.loggersMu.RUnlock()
	
	for _, logger := range f.loggers {
		if err := logger.Sync(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	
	return firstErr
}

// buildEncoderConfig builds the encoder configuration
func buildEncoderConfig(config *LogConfig) zapcore.EncoderConfig {
	encoderConfig := zapcore.EncoderConfig{
		TimeKey:        "timestamp",
		LevelKey:       "level",
		NameKey:        "logger",
		CallerKey:      "caller",
		FunctionKey:    zapcore.OmitKey,
		MessageKey:     "msg",
		StacktraceKey:  "stacktrace",
		LineEnding:     zapcore.DefaultLineEnding,
		EncodeLevel:    zapcore.LowercaseLevelEncoder,
		EncodeTime:     zapcore.ISO8601TimeEncoder,
		EncodeDuration: zapcore.SecondsDurationEncoder,
		EncodeCaller:   zapcore.ShortCallerEncoder,
	}
	
	if config.Development {
		encoderConfig.EncodeLevel = zapcore.CapitalColorLevelEncoder
		encoderConfig.EncodeCaller = zapcore.FullCallerEncoder
	}
	
	if config.DisableCaller {
		encoderConfig.CallerKey = zapcore.OmitKey
	}
	
	if config.DisableStacktrace {
		encoderConfig.StacktraceKey = zapcore.OmitKey
	}
	
	return encoderConfig
}

// buildCore builds the logger core
func buildCore(config *LogConfig, encoderConfig zapcore.EncoderConfig) (zapcore.Core, error) {
	level, err := zapcore.ParseLevel(config.Level)
	if err != nil {
		return nil, fmt.Errorf("invalid log level: %w", err)
	}
	
	return buildCoreWithLevel(config, level)
}

// buildCoreWithLevel builds a core with specific level
func buildCoreWithLevel(config *LogConfig, level zapcore.Level) (zapcore.Core, error) {
	encoderConfig := buildEncoderConfig(config)
	
	// Create encoder
	var encoder zapcore.Encoder
	if config.Encoding == "json" {
		encoder = zapcore.NewJSONEncoder(encoderConfig)
	} else {
		encoder = zapcore.NewConsoleEncoder(encoderConfig)
	}
	
	// Create output writers
	writers := []zapcore.WriteSyncer{}
	
	// File output with rotation
	if config.OutputPath != "" && config.OutputPath != "stdout" {
		fileWriter := &lumberjack.Logger{
			Filename:   config.OutputPath,
			MaxSize:    config.MaxSizeMB,
			MaxBackups: config.MaxBackups,
			MaxAge:     config.MaxAgeDays,
			Compress:   config.Compress,
		}
		writers = append(writers, zapcore.AddSync(fileWriter))
	}
	
	// Console output
	if config.OutputPath == "stdout" || config.Development {
		writers = append(writers, zapcore.AddSync(os.Stdout))
	}
	
	// Combine writers
	writer := zapcore.NewMultiWriteSyncer(writers...)
	
	// Create core
	core := zapcore.NewCore(encoder, writer, level)
	
	// Add sampling if enabled
	if config.Sampling {
		core = zapcore.NewSamplerWithOptions(
			core,
			time.Second,
			100, // first 100 messages per second
			10,  // thereafter 10 messages per second
		)
	}
	
	return core, nil
}

// buildOptions builds logger options
func buildOptions(config *LogConfig) []zap.Option {
	options := []zap.Option{}
	
	if !config.DisableCaller {
		options = append(options, zap.AddCaller())
	}
	
	if !config.DisableStacktrace {
		options = append(options, zap.AddStacktrace(zapcore.ErrorLevel))
	}
	
	if config.Development {
		options = append(options, zap.Development())
	}
	
	// Add default fields
	fields := []zap.Field{}
	
	if config.IncludeHost {
		if hostname, err := os.Hostname(); err == nil {
			fields = append(fields, zap.String("host", hostname))
		}
	}
	
	if config.IncludeVersion {
		fields = append(fields, zap.String("version", "1.0.0")) // Would get from build info
	}
	
	if len(fields) > 0 {
		options = append(options, zap.Fields(fields...))
	}
	
	return options
}

// DefaultLogConfig returns default logging configuration
func DefaultLogConfig() *LogConfig {
	return &LogConfig{
		OutputPath:      "logs/otedama.log",
		ErrorOutputPath: "logs/otedama_error.log",
		Level:           "info",
		ModuleLevels:    make(map[string]string),
		Encoding:        "json",
		Development:     false,
		MaxSizeMB:       100,
		MaxBackups:      7,
		MaxAgeDays:      30,
		Compress:        true,
		DisableCaller:   false,
		DisableStacktrace: false,
		Sampling:        true,
		IncludeHost:     true,
		IncludeVersion:  true,
	}
}

// Helper functions for common logging patterns

// WithMining adds mining-related fields
func WithMining(logger *zap.Logger, algorithm string, hashRate float64) *zap.Logger {
	return logger.With(
		zap.String("algorithm", algorithm),
		zap.Float64("hash_rate", hashRate),
	)
}

// WithNetwork adds network-related fields
func WithNetwork(logger *zap.Logger, peerID string, address string) *zap.Logger {
	return logger.With(
		zap.String("peer_id", peerID),
		zap.String("address", address),
	)
}

// WithComponent adds component context
func WithComponent(logger *zap.Logger, component string) *zap.Logger {
	return logger.With(zap.String("component", component))
}

// WithRequestID adds request tracking
func WithRequestID(logger *zap.Logger, requestID string) *zap.Logger {
	return logger.With(zap.String("request_id", requestID))
}

// Performance-optimized logging helpers

// LogIf logs only if error is not nil
func LogIf(logger *zap.Logger, err error, msg string, fields ...zap.Field) {
	if err != nil {
		logger.Error(msg, append(fields, zap.Error(err))...)
	}
}

// DebugSampled logs debug messages with sampling
var debugSampler = &Sampler{
	interval: time.Second,
	first:    10,
	thereafter: 1,
}

func DebugSampled(logger *zap.Logger, msg string, fields ...zap.Field) {
	if debugSampler.Check() {
		logger.Debug(msg, fields...)
	}
}

// Sampler implements simple sampling logic
type Sampler struct {
	interval   time.Duration
	first      int
	thereafter int
	
	mu         sync.Mutex
	lastTick   time.Time
	count      int
}

func (s *Sampler) Check() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	
	now := time.Now()
	if now.Sub(s.lastTick) > s.interval {
		s.lastTick = now
		s.count = 0
	}
	
	s.count++
	
	if s.count <= s.first {
		return true
	}
	
	return (s.count-s.first)%s.thereafter == 0
}