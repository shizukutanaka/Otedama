package logging

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"gopkg.in/natefinch/lumberjack.v2"
)

// StructuredLogger provides enhanced structured logging
type StructuredLogger struct {
	logger    *zap.Logger
	sugar     *zap.SugaredLogger
	config    Config
	fields    map[string]interface{}
	fieldsMu  sync.RWMutex
	
	// Log rotation
	rotator   *lumberjack.Logger
	
	// Performance tracking
	slowLogThreshold time.Duration
	
	// Context enrichment
	contextEnrichers []ContextEnricher
}

// Config defines logger configuration
type Config struct {
	Level           string        `yaml:"level"`
	Format          string        `yaml:"format"`
	OutputPath      string        `yaml:"output_path"`
	ErrorOutputPath string        `yaml:"error_output_path"`
	MaxSize         int           `yaml:"max_size_mb"`
	MaxBackups      int           `yaml:"max_backups"`
	MaxAge          int           `yaml:"max_age_days"`
	Compress        bool          `yaml:"compress"`
	EnableCaller    bool          `yaml:"enable_caller"`
	EnableStacktrace bool          `yaml:"enable_stacktrace"`
	SlowLogThreshold string        `yaml:"slow_log_threshold"`
	SamplingEnabled  bool          `yaml:"sampling_enabled"`
	SamplingInitial  int           `yaml:"sampling_initial"`
	SamplingThereafter int         `yaml:"sampling_thereafter"`
}

// ContextEnricher enriches log entries with context
type ContextEnricher interface {
	Enrich(ctx context.Context) []zapcore.Field
}

// NewStructuredLogger creates a new structured logger
func NewStructuredLogger(config Config) (*StructuredLogger, error) {
	// Parse log level
	level := zapcore.InfoLevel
	if err := level.UnmarshalText([]byte(config.Level)); err != nil {
		return nil, fmt.Errorf("invalid log level: %w", err)
	}
	
	// Create encoder config
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
		EncodeDuration: zapcore.MillisDurationEncoder,
		EncodeCaller:   zapcore.ShortCallerEncoder,
	}
	
	// Create encoder
	var encoder zapcore.Encoder
	switch config.Format {
	case "json":
		encoder = zapcore.NewJSONEncoder(encoderConfig)
	case "console":
		encoder = zapcore.NewConsoleEncoder(encoderConfig)
	default:
		encoder = zapcore.NewJSONEncoder(encoderConfig)
	}
	
	// Create log rotator
	rotator := &lumberjack.Logger{
		Filename:   config.OutputPath,
		MaxSize:    config.MaxSize,
		MaxBackups: config.MaxBackups,
		MaxAge:     config.MaxAge,
		Compress:   config.Compress,
	}
	
	// Create write syncers
	writeSyncer := zapcore.AddSync(rotator)
	errorSyncer := zapcore.AddSync(os.Stderr)
	
	// Create core with level filtering
	core := zapcore.NewTee(
		zapcore.NewCore(encoder, writeSyncer, level),
		zapcore.NewCore(encoder, errorSyncer, zapcore.ErrorLevel),
	)
	
	// Apply sampling if enabled
	if config.SamplingEnabled {
		core = zapcore.NewSamplerWithOptions(
			core,
			time.Second,
			config.SamplingInitial,
			config.SamplingThereafter,
		)
	}
	
	// Build logger options
	opts := []zap.Option{
		zap.AddStacktrace(zapcore.ErrorLevel),
		zap.AddCallerSkip(1),
	}
	
	if config.EnableCaller {
		opts = append(opts, zap.AddCaller())
	}
	
	// Create logger
	logger := zap.New(core, opts...)
	
	// Parse slow log threshold
	slowLogThreshold := 100 * time.Millisecond
	if config.SlowLogThreshold != "" {
		if d, err := time.ParseDuration(config.SlowLogThreshold); err == nil {
			slowLogThreshold = d
		}
	}
	
	return &StructuredLogger{
		logger:           logger,
		sugar:            logger.Sugar(),
		config:           config,
		fields:           make(map[string]interface{}),
		rotator:          rotator,
		slowLogThreshold: slowLogThreshold,
		contextEnrichers: []ContextEnricher{},
	}, nil
}

// WithContext creates a logger with context fields
func (l *StructuredLogger) WithContext(ctx context.Context) *zap.Logger {
	fields := l.extractContextFields(ctx)
	return l.logger.With(fields...)
}

// WithFields creates a logger with additional fields
func (l *StructuredLogger) WithFields(fields map[string]interface{}) *zap.Logger {
	zapFields := make([]zapcore.Field, 0, len(fields))
	for k, v := range fields {
		zapFields = append(zapFields, zap.Any(k, v))
	}
	return l.logger.With(zapFields...)
}

// SetGlobalFields sets global fields for all log entries
func (l *StructuredLogger) SetGlobalFields(fields map[string]interface{}) {
	l.fieldsMu.Lock()
	defer l.fieldsMu.Unlock()
	
	for k, v := range fields {
		l.fields[k] = v
	}
	
	// Rebuild logger with new fields
	zapFields := make([]zapcore.Field, 0, len(l.fields))
	for k, v := range l.fields {
		zapFields = append(zapFields, zap.Any(k, v))
	}
	
	l.logger = l.logger.With(zapFields...)
	l.sugar = l.logger.Sugar()
}

// AddContextEnricher adds a context enricher
func (l *StructuredLogger) AddContextEnricher(enricher ContextEnricher) {
	l.contextEnrichers = append(l.contextEnrichers, enricher)
}

// LogOperation logs an operation with timing
func (l *StructuredLogger) LogOperation(operation string, fn func() error) error {
	start := time.Now()
	
	// Log start
	l.logger.Info("Operation started",
		zap.String("operation", operation),
		zap.Time("start_time", start),
	)
	
	// Execute operation
	err := fn()
	
	// Calculate duration
	duration := time.Since(start)
	
	// Prepare fields
	fields := []zapcore.Field{
		zap.String("operation", operation),
		zap.Duration("duration", duration),
		zap.Time("end_time", time.Now()),
	}
	
	// Log based on result and duration
	if err != nil {
		fields = append(fields, zap.Error(err))
		l.logger.Error("Operation failed", fields...)
	} else if duration > l.slowLogThreshold {
		l.logger.Warn("Slow operation completed", fields...)
	} else {
		l.logger.Info("Operation completed", fields...)
	}
	
	return err
}

// LogRequest logs an HTTP request
func (l *StructuredLogger) LogRequest(method, path string, statusCode int, duration time.Duration, fields ...zapcore.Field) {
	baseFields := []zapcore.Field{
		zap.String("method", method),
		zap.String("path", path),
		zap.Int("status_code", statusCode),
		zap.Duration("duration", duration),
	}
	
	allFields := append(baseFields, fields...)
	
	// Choose log level based on status code
	switch {
	case statusCode >= 500:
		l.logger.Error("Request failed", allFields...)
	case statusCode >= 400:
		l.logger.Warn("Request client error", allFields...)
	case duration > l.slowLogThreshold:
		l.logger.Warn("Slow request", allFields...)
	default:
		l.logger.Info("Request completed", allFields...)
	}
}

// LogMetric logs a metric value
func (l *StructuredLogger) LogMetric(name string, value float64, tags map[string]string) {
	fields := []zapcore.Field{
		zap.String("metric_name", name),
		zap.Float64("metric_value", value),
		zap.Any("tags", tags),
	}
	
	l.logger.Info("Metric", fields...)
}

// LogSecurityEvent logs a security-related event
func (l *StructuredLogger) LogSecurityEvent(event string, severity string, details map[string]interface{}) {
	fields := []zapcore.Field{
		zap.String("security_event", event),
		zap.String("severity", severity),
		zap.Any("details", details),
		zap.Time("event_time", time.Now()),
	}
	
	switch severity {
	case "critical":
		l.logger.Error("Security event", fields...)
	case "high":
		l.logger.Warn("Security event", fields...)
	default:
		l.logger.Info("Security event", fields...)
	}
}

// extractContextFields extracts fields from context
func (l *StructuredLogger) extractContextFields(ctx context.Context) []zapcore.Field {
	var fields []zapcore.Field
	
	// Extract from context enrichers
	for _, enricher := range l.contextEnrichers {
		fields = append(fields, enricher.Enrich(ctx)...)
	}
	
	// Extract common context values
	if requestID := ctx.Value("request_id"); requestID != nil {
		fields = append(fields, zap.String("request_id", fmt.Sprintf("%v", requestID)))
	}
	
	if userID := ctx.Value("user_id"); userID != nil {
		fields = append(fields, zap.String("user_id", fmt.Sprintf("%v", userID)))
	}
	
	if traceID := ctx.Value("trace_id"); traceID != nil {
		fields = append(fields, zap.String("trace_id", fmt.Sprintf("%v", traceID)))
	}
	
	return fields
}

// Rotate forces log rotation
func (l *StructuredLogger) Rotate() error {
	return l.rotator.Rotate()
}

// Sync flushes any buffered log entries
func (l *StructuredLogger) Sync() error {
	return l.logger.Sync()
}

// GetLogger returns the underlying zap logger
func (l *StructuredLogger) GetLogger() *zap.Logger {
	return l.logger
}

// GetSugaredLogger returns the sugared logger
func (l *StructuredLogger) GetSugaredLogger() *zap.SugaredLogger {
	return l.sugar
}

// LogWriter provides an io.Writer interface for the logger
type LogWriter struct {
	logger *zap.Logger
	level  zapcore.Level
}

// NewLogWriter creates a new log writer
func NewLogWriter(logger *zap.Logger, level zapcore.Level) *LogWriter {
	return &LogWriter{
		logger: logger,
		level:  level,
	}
}

// Write implements io.Writer
func (w *LogWriter) Write(p []byte) (n int, err error) {
	if ce := w.logger.Check(w.level, string(p)); ce != nil {
		ce.Write()
	}
	return len(p), nil
}

// RequestIDEnricher enriches logs with request ID
type RequestIDEnricher struct{}

// Enrich adds request ID to log fields
func (e *RequestIDEnricher) Enrich(ctx context.Context) []zapcore.Field {
	if requestID := ctx.Value("request_id"); requestID != nil {
		return []zapcore.Field{zap.String("request_id", fmt.Sprintf("%v", requestID))}
	}
	return nil
}

// UserEnricher enriches logs with user information
type UserEnricher struct{}

// Enrich adds user information to log fields
func (e *UserEnricher) Enrich(ctx context.Context) []zapcore.Field {
	var fields []zapcore.Field
	
	if userID := ctx.Value("user_id"); userID != nil {
		fields = append(fields, zap.String("user_id", fmt.Sprintf("%v", userID)))
	}
	
	if userName := ctx.Value("user_name"); userName != nil {
		fields = append(fields, zap.String("user_name", fmt.Sprintf("%v", userName)))
	}
	
	return fields
}

// CreateDevelopmentLogger creates a logger suitable for development
func CreateDevelopmentLogger() (*StructuredLogger, error) {
	config := Config{
		Level:            "debug",
		Format:           "console",
		OutputPath:       "stdout",
		ErrorOutputPath:  "stderr",
		EnableCaller:     true,
		EnableStacktrace: true,
	}
	
	return NewStructuredLogger(config)
}

// CreateProductionLogger creates a logger suitable for production
func CreateProductionLogger(logDir string) (*StructuredLogger, error) {
	config := Config{
		Level:            "info",
		Format:           "json",
		OutputPath:       filepath.Join(logDir, "otedama.log"),
		ErrorOutputPath:  filepath.Join(logDir, "otedama-error.log"),
		MaxSize:          100,
		MaxBackups:       10,
		MaxAge:           30,
		Compress:         true,
		EnableCaller:     false,
		EnableStacktrace: true,
		SlowLogThreshold: "100ms",
		SamplingEnabled:  true,
		SamplingInitial:  100,
		SamplingThereafter: 100,
	}
	
	return NewStructuredLogger(config)
}