package logging

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"gopkg.in/natefinch/lumberjack.v2"
)

// LogLevel represents log levels
type LogLevel string

const (
	LevelDebug LogLevel = "debug"
	LevelInfo  LogLevel = "info" 
	LevelWarn  LogLevel = "warn"
	LevelError LogLevel = "error"
	LevelFatal LogLevel = "fatal"
)

// LogFormat represents log output formats
type LogFormat string

const (
	FormatJSON LogFormat = "json"
	FormatText LogFormat = "text"
)

// LogOutput represents log output destinations
type LogOutput string

const (
	OutputStdout LogOutput = "stdout"
	OutputStderr LogOutput = "stderr"
	OutputFile   LogOutput = "file"
	OutputBoth   LogOutput = "both"
)

// Config represents logging configuration
type Config struct {
	Level    LogLevel  `yaml:"level" json:"level"`
	Format   LogFormat `yaml:"format" json:"format"`
	Output   LogOutput `yaml:"output" json:"output"`
	
	// File logging options
	File FileConfig `yaml:"file" json:"file"`
	
	// Development options
	Development bool `yaml:"development" json:"development"`
	
	// Sampling configuration
	Sampling SamplingConfig `yaml:"sampling" json:"sampling"`
	
	// Structured logging
	EnableCaller     bool `yaml:"enable_caller" json:"enable_caller"`
	EnableStacktrace bool `yaml:"enable_stacktrace" json:"enable_stacktrace"`
}

// FileConfig represents file logging configuration
type FileConfig struct {
	Enabled    bool   `yaml:"enabled" json:"enabled"`
	Path       string `yaml:"path" json:"path"`
	MaxSize    int    `yaml:"max_size" json:"max_size"`       // MB
	MaxBackups int    `yaml:"max_backups" json:"max_backups"`
	MaxAge     int    `yaml:"max_age" json:"max_age"`         // Days
	Compress   bool   `yaml:"compress" json:"compress"`
}

// SamplingConfig represents log sampling configuration
type SamplingConfig struct {
	Enabled    bool `yaml:"enabled" json:"enabled"`
	Initial    int  `yaml:"initial" json:"initial"`
	Thereafter int  `yaml:"thereafter" json:"thereafter"`
}

// Logger represents the unified logger
type Logger struct {
	*zap.Logger
	config     Config
	lumberjack *lumberjack.Logger
	mu         sync.RWMutex
	
	// Metrics
	logCount map[LogLevel]int64
	errors   int64
	warnings int64
}

// NewLogger creates a new unified logger
func NewLogger(config Config) (*Logger, error) {
	if config.Level == "" {
		config.Level = LevelInfo
	}
	if config.Format == "" {
		config.Format = FormatJSON
	}
	if config.Output == "" {
		config.Output = OutputStdout
	}
	
	logger := &Logger{
		config:   config,
		logCount: make(map[LogLevel]int64),
	}
	
	zapLogger, err := logger.buildZapLogger()
	if err != nil {
		return nil, fmt.Errorf("failed to build zap logger: %w", err)
	}
	
	logger.Logger = zapLogger
	return logger, nil
}

// buildZapLogger constructs the zap logger with configuration
func (l *Logger) buildZapLogger() (*zap.Logger, error) {
	level := l.zapLevel(l.config.Level)
	
	// Build encoder config
	encoderConfig := l.buildEncoderConfig()
	
	// Build cores for different outputs
	cores := []zapcore.Core{}
	
	// Console/stdout output
	if l.config.Output == OutputStdout || l.config.Output == OutputBoth {
		consoleEncoder := l.buildEncoder(encoderConfig, true)
		cores = append(cores, zapcore.NewCore(consoleEncoder, zapcore.AddSync(os.Stdout), level))
	}
	
	// File output
	if (l.config.Output == OutputFile || l.config.Output == OutputBoth) && l.config.File.Enabled {
		fileCore, err := l.buildFileCore(encoderConfig, level)
		if err != nil {
			return nil, err
		}
		cores = append(cores, fileCore)
	}
	
	if len(cores) == 0 {
		return nil, fmt.Errorf("no output configured")
	}
	
	// Combine cores
	core := zapcore.NewTee(cores...)
	
	// Apply sampling if enabled
	if l.config.Sampling.Enabled {
		core = zapcore.NewSamplerWithOptions(
			core,
			time.Second,
			l.config.Sampling.Initial,
			l.config.Sampling.Thereafter,
		)
	}
	
	// Build logger with options
	options := []zap.Option{
		zap.AddStacktrace(zapcore.ErrorLevel),
	}
	
	if l.config.EnableCaller {
		options = append(options, zap.AddCaller())
	}
	
	if l.config.EnableStacktrace {
		options = append(options, zap.AddStacktrace(zapcore.WarnLevel))
	}
	
	if l.config.Development {
		options = append(options, zap.Development())
	}
	
	return zap.New(core, options...), nil
}

// buildEncoderConfig creates encoder configuration
func (l *Logger) buildEncoderConfig() zapcore.EncoderConfig {
	config := zap.NewProductionEncoderConfig()
	
	if l.config.Development {
		config = zap.NewDevelopmentEncoderConfig()
	}
	
	// Customize time format
	config.TimeKey = "timestamp"
	config.EncodeTime = zapcore.RFC3339TimeEncoder
	
	// Add caller encoding
	if l.config.EnableCaller {
		config.CallerKey = "caller"
		config.EncodeCaller = zapcore.ShortCallerEncoder
	}
	
	// Customize level encoding
	config.LevelKey = "level"
	config.EncodeLevel = zapcore.LowercaseLevelEncoder
	
	return config
}

// buildEncoder creates encoder based on format
func (l *Logger) buildEncoder(config zapcore.EncoderConfig, isConsole bool) zapcore.Encoder {
	if l.config.Format == FormatText || (isConsole && l.config.Development) {
		config.EncodeLevel = zapcore.CapitalColorLevelEncoder
		return zapcore.NewConsoleEncoder(config)
	}
	return zapcore.NewJSONEncoder(config)
}

// buildFileCore creates file logging core
func (l *Logger) buildFileCore(encoderConfig zapcore.EncoderConfig, level zapcore.Level) (zapcore.Core, error) {
	// Ensure log directory exists
	logDir := filepath.Dir(l.config.File.Path)
	if err := os.MkdirAll(logDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create log directory: %w", err)
	}
	
	// Setup lumberjack for log rotation
	l.lumberjack = &lumberjack.Logger{
		Filename:   l.config.File.Path,
		MaxSize:    l.config.File.MaxSize,
		MaxBackups: l.config.File.MaxBackups,
		MaxAge:     l.config.File.MaxAge,
		Compress:   l.config.File.Compress,
	}
	
	encoder := l.buildEncoder(encoderConfig, false)
	return zapcore.NewCore(encoder, zapcore.AddSync(l.lumberjack), level), nil
}

// zapLevel converts our LogLevel to zap level
func (l *Logger) zapLevel(level LogLevel) zapcore.Level {
	switch level {
	case LevelDebug:
		return zapcore.DebugLevel
	case LevelInfo:
		return zapcore.InfoLevel
	case LevelWarn:
		return zapcore.WarnLevel
	case LevelError:
		return zapcore.ErrorLevel
	case LevelFatal:
		return zapcore.FatalLevel
	default:
		return zapcore.InfoLevel
	}
}

// WithContext creates a logger with context fields
func (l *Logger) WithContext(ctx context.Context) *Logger {
	// Extract common context fields
	fields := []zap.Field{}
	
	if requestID := ctx.Value("request_id"); requestID != nil {
		fields = append(fields, zap.String("request_id", fmt.Sprintf("%v", requestID)))
	}
	
	if userID := ctx.Value("user_id"); userID != nil {
		fields = append(fields, zap.String("user_id", fmt.Sprintf("%v", userID)))
	}
	
	if traceID := ctx.Value("trace_id"); traceID != nil {
		fields = append(fields, zap.String("trace_id", fmt.Sprintf("%v", traceID)))
	}
	
	newLogger := *l
	newLogger.Logger = l.Logger.With(fields...)
	return &newLogger
}

// WithFields creates a logger with additional fields
func (l *Logger) WithFields(fields ...zap.Field) *Logger {
	newLogger := *l
	newLogger.Logger = l.Logger.With(fields...)
	return &newLogger
}

// WithComponent creates a logger for a specific component
func (l *Logger) WithComponent(component string) *Logger {
	return l.WithFields(zap.String("component", component))
}

// WithRequest creates a logger for HTTP request
func (l *Logger) WithRequest(method, path, clientIP string) *Logger {
	return l.WithFields(
		zap.String("method", method),
		zap.String("path", path),
		zap.String("client_ip", clientIP),
	)
}

// Structured logging methods with metrics tracking

// DebugCtx logs debug message with context
func (l *Logger) DebugCtx(ctx context.Context, msg string, fields ...zap.Field) {
	l.incrementCount(LevelDebug)
	l.WithContext(ctx).Debug(msg, fields...)
}

// InfoCtx logs info message with context
func (l *Logger) InfoCtx(ctx context.Context, msg string, fields ...zap.Field) {
	l.incrementCount(LevelInfo)
	l.WithContext(ctx).Info(msg, fields...)
}

// WarnCtx logs warning message with context
func (l *Logger) WarnCtx(ctx context.Context, msg string, fields ...zap.Field) {
	l.incrementCount(LevelWarn)
	l.warnings++
	l.WithContext(ctx).Warn(msg, fields...)
}

// ErrorCtx logs error message with context
func (l *Logger) ErrorCtx(ctx context.Context, msg string, fields ...zap.Field) {
	l.incrementCount(LevelError)
	l.errors++
	l.WithContext(ctx).Error(msg, fields...)
}

// FatalCtx logs fatal message with context
func (l *Logger) FatalCtx(ctx context.Context, msg string, fields ...zap.Field) {
	l.incrementCount(LevelFatal)
	l.WithContext(ctx).Fatal(msg, fields...)
}

// Helper methods for common logging patterns

// LogHTTPRequest logs HTTP request
func (l *Logger) LogHTTPRequest(method, path, clientIP string, statusCode int, duration time.Duration, bodySize int64) {
	l.Info("HTTP request",
		zap.String("method", method),
		zap.String("path", path),
		zap.String("client_ip", clientIP),
		zap.Int("status_code", statusCode),
		zap.Duration("duration", duration),
		zap.Int64("body_size", bodySize),
	)
}

// LogMiningEvent logs mining-related events
func (l *Logger) LogMiningEvent(event string, workerID string, algorithm string, hashrate float64) {
	l.Info("Mining event",
		zap.String("event", event),
		zap.String("worker_id", workerID),
		zap.String("algorithm", algorithm),
		zap.Float64("hashrate", hashrate),
	)
}

// LogSecurityEvent logs security-related events
func (l *Logger) LogSecurityEvent(event string, userID string, clientIP string, success bool) {
	level := l.Info
	if !success {
		level = l.Warn
	}
	
	level("Security event",
		zap.String("event", event),
		zap.String("user_id", userID),
		zap.String("client_ip", clientIP),
		zap.Bool("success", success),
	)
}

// LogPerformanceMetric logs performance metrics
func (l *Logger) LogPerformanceMetric(operation string, duration time.Duration, success bool) {
	l.Info("Performance metric",
		zap.String("operation", operation),
		zap.Duration("duration", duration),
		zap.Bool("success", success),
	)
}

// incrementCount increments log count for metrics
func (l *Logger) incrementCount(level LogLevel) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.logCount[level]++
}

// GetMetrics returns logging metrics
func (l *Logger) GetMetrics() map[string]interface{} {
	l.mu.RLock()
	defer l.mu.RUnlock()
	
	metrics := make(map[string]interface{})
	metrics["log_counts"] = l.logCount
	metrics["error_count"] = l.errors
	metrics["warning_count"] = l.warnings
	
	// Add file size if file logging is enabled
	if l.lumberjack != nil {
		if stat, err := os.Stat(l.config.File.Path); err == nil {
			metrics["file_size_bytes"] = stat.Size()
			metrics["file_path"] = l.config.File.Path
		}
	}
	
	return metrics
}

// Rotate forces log rotation (if file logging is enabled)
func (l *Logger) Rotate() error {
	if l.lumberjack != nil {
		return l.lumberjack.Rotate()
	}
	return fmt.Errorf("file logging not enabled")
}

// Close closes the logger
func (l *Logger) Close() error {
	if l.Logger != nil {
		l.Logger.Sync()
	}
	if l.lumberjack != nil {
		return l.lumberjack.Close()
	}
	return nil
}

// Recovery middleware for logging panics
func (l *Logger) RecoveryMiddleware() func() {
	return func() {
		if r := recover(); r != nil {
			// Get stack trace
			buf := make([]byte, 1024)
			n := runtime.Stack(buf, false)
			stack := string(buf[:n])
			
			l.Error("Panic recovered",
				zap.Any("panic", r),
				zap.String("stack", stack),
			)
			
			// Re-panic to maintain original behavior
			panic(r)
		}
	}
}

// DefaultConfig returns default logging configuration
func DefaultConfig() Config {
	return Config{
		Level:    LevelInfo,
		Format:   FormatJSON,
		Output:   OutputStdout,
		File: FileConfig{
			Enabled:    false,
			Path:       "logs/otedama.log",
			MaxSize:    100, // 100MB
			MaxBackups: 10,
			MaxAge:     30, // 30 days
			Compress:   true,
		},
		Development:      false,
		EnableCaller:     true,
		EnableStacktrace: true,
		Sampling: SamplingConfig{
			Enabled:    false,
			Initial:    100,
			Thereafter: 100,
		},
	}
}

// Global logger instance
var (
	globalLogger *Logger
	globalMu     sync.RWMutex
)

// InitGlobalLogger initializes the global logger
func InitGlobalLogger(config Config) error {
	logger, err := NewLogger(config)
	if err != nil {
		return err
	}
	
	globalMu.Lock()
	globalLogger = logger
	globalMu.Unlock()
	
	return nil
}

// GetGlobalLogger returns the global logger
func GetGlobalLogger() *Logger {
	globalMu.RLock()
	defer globalMu.RUnlock()
	
	if globalLogger == nil {
		// Return a default logger if none is set
		config := DefaultConfig()
		config.Development = true
		config.Format = FormatText
		
		logger, _ := NewLogger(config)
		return logger
	}
	
	return globalLogger
}

// Convenience functions using global logger
func Debug(msg string, fields ...zap.Field) {
	GetGlobalLogger().Debug(msg, fields...)
}

func Info(msg string, fields ...zap.Field) {
	GetGlobalLogger().Info(msg, fields...)
}

func Warn(msg string, fields ...zap.Field) {
	GetGlobalLogger().Warn(msg, fields...)
}

func Error(msg string, fields ...zap.Field) {
	GetGlobalLogger().Error(msg, fields...)
}

func Fatal(msg string, fields ...zap.Field) {
	GetGlobalLogger().Fatal(msg, fields...)
}