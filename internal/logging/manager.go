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

// LogLevel represents logging levels
type LogLevel string

const (
	LevelDebug LogLevel = "debug"
	LevelInfo  LogLevel = "info"
	LevelWarn  LogLevel = "warn"
	LevelError LogLevel = "error"
	LevelPanic LogLevel = "panic"
	LevelFatal LogLevel = "fatal"
)

// Config logging configuration
type Config struct {
	Level            LogLevel    `mapstructure:"level"`
	OutputPaths      []string    `mapstructure:"output_paths"`
	ErrorOutputPaths []string    `mapstructure:"error_output_paths"`
	Encoding         string      `mapstructure:"encoding"` // "json" or "console"
	
	// File rotation settings
	Filename   string `mapstructure:"filename"`
	MaxSize    int    `mapstructure:"max_size"`    // megabytes
	MaxBackups int    `mapstructure:"max_backups"`
	MaxAge     int    `mapstructure:"max_age"`     // days
	Compress   bool   `mapstructure:"compress"`
	
	// Performance settings
	EnableSampling bool `mapstructure:"enable_sampling"`
	SampleInitial  int  `mapstructure:"sample_initial"`
	SampleInterval int  `mapstructure:"sample_interval"`
	
	// Security and audit
	AuditConfig AuditConfig `mapstructure:"audit"`
}

// Manager manages all logging operations
type Manager struct {
	logger      *zap.Logger
	auditLogger *AuditLogger
	config      Config
	mu          sync.RWMutex
}

// NewManager creates a new logging manager
func NewManager(config Config) (*Manager, error) {
	// Ensure log directory exists
	if config.Filename != "" {
		logDir := filepath.Dir(config.Filename)
		if err := os.MkdirAll(logDir, 0755); err != nil {
			return nil, fmt.Errorf("failed to create log directory: %w", err)
		}
	}
	
	// Configure zap logger
	logger, err := createZapLogger(config)
	if err != nil {
		return nil, fmt.Errorf("failed to create logger: %w", err)
	}
	
	// Create audit logger
	auditLogger, err := NewAuditLogger(config.AuditConfig, logger)
	if err != nil {
		return nil, fmt.Errorf("failed to create audit logger: %w", err)
	}
	
	manager := &Manager{
		logger:      logger,
		auditLogger: auditLogger,
		config:      config,
	}
	
	return manager, nil
}

// GetLogger returns the main logger instance
func (m *Manager) GetLogger() *zap.Logger {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.logger
}

// GetAuditLogger returns the audit logger instance
func (m *Manager) GetAuditLogger() *AuditLogger {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.auditLogger
}

// LogStartup logs application startup events
func (m *Manager) LogStartup(version, mode string, config map[string]interface{}) {
	m.logger.Info("Application starting",
		zap.String("version", version),
		zap.String("mode", mode),
		zap.Any("config", config),
	)
	
	m.auditLogger.LogSystemEvent("startup", "success", map[string]interface{}{
		"version": version,
		"mode":    mode,
	})
}

// LogShutdown logs application shutdown events
func (m *Manager) LogShutdown(reason string) {
	m.logger.Info("Application shutting down",
		zap.String("reason", reason),
	)
	
	m.auditLogger.LogSystemEvent("shutdown", "success", map[string]interface{}{
		"reason": reason,
	})
}

// LogError logs error events with context
func (m *Manager) LogError(component, operation string, err error, fields map[string]interface{}) {
	zapFields := []zap.Field{
		zap.String("component", component),
		zap.String("operation", operation),
		zap.Error(err),
	}
	
	for k, v := range fields {
		zapFields = append(zapFields, zap.Any(k, v))
	}
	
	m.logger.Error("Operation failed", zapFields...)
	
	m.auditLogger.LogEvent("ERROR", "ERROR", component, operation, "failure", fields)
}

// LogPerformance logs performance metrics
func (m *Manager) LogPerformance(component, operation string, duration time.Duration, fields map[string]interface{}) {
	if fields == nil {
		fields = make(map[string]interface{})
	}
	fields["duration_ms"] = duration.Milliseconds()
	
	zapFields := []zap.Field{
		zap.String("component", component),
		zap.String("operation", operation),
		zap.Duration("duration", duration),
	}
	
	for k, v := range fields {
		zapFields = append(zapFields, zap.Any(k, v))
	}
	
	m.logger.Info("Performance metric", zapFields...)
}

// LogSecurity logs security-related events
func (m *Manager) LogSecurity(event, clientIP, userID, action, result string, details map[string]interface{}) {
	m.logger.Warn("Security event",
		zap.String("event", event),
		zap.String("client_ip", clientIP),
		zap.String("user_id", userID),
		zap.String("action", action),
		zap.String("result", result),
		zap.Any("details", details),
	)
	
	m.auditLogger.LogSecurityEvent(clientIP, action, result, details)
}

// LogMining logs mining-related operations
func (m *Manager) LogMining(workerName, clientIP, action string, success bool, details map[string]interface{}) {
	result := "success"
	if !success {
		result = "failure"
	}
	
	m.logger.Info("Mining operation",
		zap.String("worker", workerName),
		zap.String("client_ip", clientIP),
		zap.String("action", action),
		zap.Bool("success", success),
		zap.Any("details", details),
	)
	
	m.auditLogger.LogMiningEvent(workerName, clientIP, action, result, details)
}

// LogConnection logs connection events
func (m *Manager) LogConnection(clientIP, protocol, action string, success bool) {
	result := "success"
	if !success {
		result = "failure"
	}
	
	m.logger.Info("Connection event",
		zap.String("client_ip", clientIP),
		zap.String("protocol", protocol),
		zap.String("action", action),
		zap.Bool("success", success),
	)
	
	m.auditLogger.LogEvent("CONNECTION", "INFO", protocol, action, result, map[string]interface{}{
		"client_ip": clientIP,
		"protocol":  protocol,
	})
}

// LogAPIAccess logs API access events
func (m *Manager) LogAPIAccess(clientIP, method, path, userAgent string, statusCode int, duration time.Duration) {
	m.logger.Info("API access",
		zap.String("client_ip", clientIP),
		zap.String("method", method),
		zap.String("path", path),
		zap.String("user_agent", userAgent),
		zap.Int("status_code", statusCode),
		zap.Duration("duration", duration),
	)
	
	result := "success"
	if statusCode >= 400 {
		result = "failure"
	}
	
	m.auditLogger.LogEvent("API_ACCESS", "INFO", "api", fmt.Sprintf("%s %s", method, path), result, map[string]interface{}{
		"client_ip":   clientIP,
		"method":      method,
		"path":        path,
		"user_agent":  userAgent,
		"status_code": statusCode,
		"duration_ms": duration.Milliseconds(),
	})
}

// Sync flushes any buffered log entries
func (m *Manager) Sync() error {
	return m.logger.Sync()
}

// Close gracefully closes the logging manager
func (m *Manager) Close() error {
	if err := m.auditLogger.Close(); err != nil {
		return err
	}
	return m.logger.Sync()
}

// createZapLogger creates a configured zap logger
func createZapLogger(config Config) (*zap.Logger, error) {
	// Configure encoder
	var encoderConfig zapcore.EncoderConfig
	if config.Encoding == "json" {
		encoderConfig = zap.NewProductionEncoderConfig()
	} else {
		encoderConfig = zap.NewDevelopmentEncoderConfig()
	}
	
	encoderConfig.TimeKey = "timestamp"
	encoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder
	encoderConfig.LevelKey = "level"
	encoderConfig.NameKey = "logger"
	encoderConfig.CallerKey = "caller"
	encoderConfig.MessageKey = "message"
	encoderConfig.StacktraceKey = "stacktrace"
	
	// Create encoder
	var encoder zapcore.Encoder
	if config.Encoding == "json" {
		encoder = zapcore.NewJSONEncoder(encoderConfig)
	} else {
		encoder = zapcore.NewConsoleEncoder(encoderConfig)
	}
	
	// Configure log level
	level := zapcore.InfoLevel
	switch config.Level {
	case LevelDebug:
		level = zapcore.DebugLevel
	case LevelInfo:
		level = zapcore.InfoLevel
	case LevelWarn:
		level = zapcore.WarnLevel
	case LevelError:
		level = zapcore.ErrorLevel
	case LevelPanic:
		level = zapcore.PanicLevel
	case LevelFatal:
		level = zapcore.FatalLevel
	}
	
	// Configure writers
	var writers []zapcore.WriteSyncer
	
	// Console output
	writers = append(writers, zapcore.AddSync(os.Stdout))
	
	// File output with rotation
	if config.Filename != "" {
		fileWriter := &lumberjack.Logger{
			Filename:   config.Filename,
			MaxSize:    config.MaxSize,
			MaxBackups: config.MaxBackups,
			MaxAge:     config.MaxAge,
			Compress:   config.Compress,
		}
		writers = append(writers, zapcore.AddSync(fileWriter))
	}
	
	// Create core
	core := zapcore.NewCore(
		encoder,
		zapcore.NewMultiWriteSyncer(writers...),
		level,
	)
	
	// Enable sampling if configured
	if config.EnableSampling {
		core = zapcore.NewSamplerWithOptions(
			core,
			time.Second,
			config.SampleInitial,
			config.SampleInterval,
		)
	}
	
	// Create logger with options
	logger := zap.New(core,
		zap.AddCaller(),
		zap.AddStacktrace(zapcore.ErrorLevel),
		zap.AddCallerSkip(1),
	)
	
	return logger, nil
}