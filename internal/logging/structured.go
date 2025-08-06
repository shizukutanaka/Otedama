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

// StructuredLogger provides structured logging with metrics
type StructuredLogger struct {
	*zap.Logger
	
	// Log configuration
	config LogConfig
	
	// Metrics
	metrics struct {
		mu sync.RWMutex
		
		// Log levels count
		debugCount   uint64
		infoCount    uint64
		warnCount    uint64
		errorCount   uint64
		fatalCount   uint64
		
		// Performance metrics
		logRate      float64 // logs per second
		lastLogTime  time.Time
		droppedLogs  uint64
		
		// Size metrics
		totalBytes   uint64
		currentFile  string
		fileRotations uint64
	}
	
	// Context fields
	contextFields sync.Map // map[string]interface{}
	
	// Sampling configuration
	sampling struct {
		enabled      bool
		initial      int
		thereafter   int
		maxDuration  time.Duration
	}
}

// LogConfig defines logger configuration
type LogConfig struct {
	// Output configuration
	Level          string `json:"level"`
	Format         string `json:"format"` // json, console
	Output         string `json:"output"` // stdout, file, both
	
	// File configuration
	FilePath       string `json:"file_path"`
	MaxSize        int    `json:"max_size_mb"`
	MaxBackups     int    `json:"max_backups"`
	MaxAge         int    `json:"max_age_days"`
	Compress       bool   `json:"compress"`
	
	// Performance
	BufferSize     int    `json:"buffer_size"`
	FlushInterval  time.Duration `json:"flush_interval"`
	
	// Sampling
	EnableSampling bool   `json:"enable_sampling"`
	SampleInitial  int    `json:"sample_initial"`
	SampleAfter    int    `json:"sample_after"`
	
	// Context
	AddCaller      bool   `json:"add_caller"`
	AddStacktrace  string `json:"add_stacktrace"` // error, warning, info, debug
	
	// Fields
	InitialFields  map[string]interface{} `json:"initial_fields"`
}

// NewStructuredLogger creates a new structured logger
func NewStructuredLogger(config LogConfig) (*StructuredLogger, error) {
	// Set defaults
	if config.Level == "" {
		config.Level = "info"
	}
	if config.Format == "" {
		config.Format = "json"
	}
	if config.Output == "" {
		config.Output = "stdout"
	}
	if config.MaxSize == 0 {
		config.MaxSize = 100 // 100MB
	}
	if config.MaxBackups == 0 {
		config.MaxBackups = 10
	}
	if config.MaxAge == 0 {
		config.MaxAge = 30 // 30 days
	}
	
	// Parse log level
	level, err := zapcore.ParseLevel(config.Level)
	if err != nil {
		return nil, fmt.Errorf("invalid log level: %w", err)
	}
	
	// Create encoder config
	encoderConfig := zap.NewProductionEncoderConfig()
	encoderConfig.TimeKey = "timestamp"
	encoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder
	encoderConfig.MessageKey = "message"
	encoderConfig.LevelKey = "level"
	encoderConfig.CallerKey = "caller"
	encoderConfig.StacktraceKey = "stacktrace"
	
	// Add custom fields
	encoderConfig.EncodeLevel = customLevelEncoder
	encoderConfig.EncodeDuration = zapcore.MillisDurationEncoder
	
	// Create encoder
	var encoder zapcore.Encoder
	if config.Format == "json" {
		encoder = zapcore.NewJSONEncoder(encoderConfig)
	} else {
		encoder = zapcore.NewConsoleEncoder(encoderConfig)
	}
	
	// Create output writers
	var writers []zapcore.WriteSyncer
	
	if config.Output == "stdout" || config.Output == "both" {
		writers = append(writers, zapcore.AddSync(os.Stdout))
	}
	
	if config.Output == "file" || config.Output == "both" {
		// Create log directory
		logDir := filepath.Dir(config.FilePath)
		if err := os.MkdirAll(logDir, 0755); err != nil {
			return nil, fmt.Errorf("failed to create log directory: %w", err)
		}
		
		// Create file writer with rotation
		fileWriter := &lumberjack.Logger{
			Filename:   config.FilePath,
			MaxSize:    config.MaxSize,
			MaxBackups: config.MaxBackups,
			MaxAge:     config.MaxAge,
			Compress:   config.Compress,
			LocalTime:  true,
		}
		
		writers = append(writers, zapcore.AddSync(fileWriter))
	}
	
	// Combine writers
	writer := zapcore.NewMultiWriteSyncer(writers...)
	
	// Create core with sampling if enabled
	var core zapcore.Core
	baseCore := zapcore.NewCore(encoder, writer, level)
	
	if config.EnableSampling {
		core = zapcore.NewSamplerWithOptions(
			baseCore,
			time.Second,
			config.SampleInitial,
			config.SampleAfter,
		)
	} else {
		core = baseCore
	}
	
	// Create logger options
	options := []zap.Option{
		zap.AddCaller(),
		zap.AddCallerSkip(1),
	}
	
	if config.AddStacktrace != "" {
		stackLevel, _ := zapcore.ParseLevel(config.AddStacktrace)
		options = append(options, zap.AddStacktrace(stackLevel))
	}
	
	// Add initial fields
	if len(config.InitialFields) > 0 {
		fields := make([]zap.Field, 0, len(config.InitialFields))
		for k, v := range config.InitialFields {
			fields = append(fields, zap.Any(k, v))
		}
		options = append(options, zap.Fields(fields...))
	}
	
	// Create logger
	logger := zap.New(core, options...)
	
	// Create structured logger
	sl := &StructuredLogger{
		Logger: logger,
		config: config,
	}
	
	// Initialize metrics
	sl.metrics.lastLogTime = time.Now()
	
	// Start metrics collector
	go sl.metricsCollector()
	
	return sl, nil
}

// customLevelEncoder adds color to console output
func customLevelEncoder(level zapcore.Level, enc zapcore.PrimitiveArrayEncoder) {
	switch level {
	case zapcore.DebugLevel:
		enc.AppendString("DEBUG")
	case zapcore.InfoLevel:
		enc.AppendString("INFO")
	case zapcore.WarnLevel:
		enc.AppendString("WARN")
	case zapcore.ErrorLevel:
		enc.AppendString("ERROR")
	case zapcore.DPanicLevel, zapcore.PanicLevel, zapcore.FatalLevel:
		enc.AppendString("FATAL")
	}
}

// WithContext creates a logger with context fields
func (sl *StructuredLogger) WithContext(ctx context.Context) *StructuredLogger {
	// Extract common context values
	fields := []zap.Field{}
	
	// Request ID
	if reqID := ctx.Value("request_id"); reqID != nil {
		fields = append(fields, zap.String("request_id", fmt.Sprint(reqID)))
	}
	
	// User ID
	if userID := ctx.Value("user_id"); userID != nil {
		fields = append(fields, zap.String("user_id", fmt.Sprint(userID)))
	}
	
	// Trace ID
	if traceID := ctx.Value("trace_id"); traceID != nil {
		fields = append(fields, zap.String("trace_id", fmt.Sprint(traceID)))
	}
	
	// Add custom context fields
	sl.contextFields.Range(func(key, value interface{}) bool {
		if k, ok := key.(string); ok {
			fields = append(fields, zap.Any(k, value))
		}
		return true
	})
	
	return &StructuredLogger{
		Logger: sl.Logger.With(fields...),
		config: sl.config,
	}
}

// AddContextField adds a field to be included in all logs
func (sl *StructuredLogger) AddContextField(key string, value interface{}) {
	sl.contextFields.Store(key, value)
}

// RemoveContextField removes a context field
func (sl *StructuredLogger) RemoveContextField(key string) {
	sl.contextFields.Delete(key)
}

// Log methods with metrics tracking

// Debug logs a debug message with metrics
func (sl *StructuredLogger) Debug(msg string, fields ...zap.Field) {
	sl.updateMetrics(zapcore.DebugLevel)
	sl.Logger.Debug(msg, sl.addCommonFields(fields...)...)
}

// Info logs an info message with metrics
func (sl *StructuredLogger) Info(msg string, fields ...zap.Field) {
	sl.updateMetrics(zapcore.InfoLevel)
	sl.Logger.Info(msg, sl.addCommonFields(fields...)...)
}

// Warn logs a warning message with metrics
func (sl *StructuredLogger) Warn(msg string, fields ...zap.Field) {
	sl.updateMetrics(zapcore.WarnLevel)
	sl.Logger.Warn(msg, sl.addCommonFields(fields...)...)
}

// Error logs an error message with metrics
func (sl *StructuredLogger) Error(msg string, fields ...zap.Field) {
	sl.updateMetrics(zapcore.ErrorLevel)
	sl.Logger.Error(msg, sl.addCommonFields(fields...)...)
}

// Fatal logs a fatal message with metrics
func (sl *StructuredLogger) Fatal(msg string, fields ...zap.Field) {
	sl.updateMetrics(zapcore.FatalLevel)
	sl.Logger.Fatal(msg, sl.addCommonFields(fields...)...)
}

// addCommonFields adds common fields to all log entries
func (sl *StructuredLogger) addCommonFields(fields ...zap.Field) []zap.Field {
	// Add runtime information
	_, file, line, _ := runtime.Caller(2)
	fields = append(fields,
		zap.String("file", filepath.Base(file)),
		zap.Int("line", line),
		zap.String("goroutine", fmt.Sprintf("%d", runtime.NumGoroutine())),
	)
	
	// Add memory stats periodically
	if time.Since(sl.metrics.lastLogTime) > time.Minute {
		var m runtime.MemStats
		runtime.ReadMemStats(&m)
		fields = append(fields,
			zap.Uint64("memory_alloc_mb", m.Alloc/1024/1024),
			zap.Uint64("memory_sys_mb", m.Sys/1024/1024),
			zap.Uint32("goroutines", uint32(runtime.NumGoroutine())),
		)
	}
	
	return fields
}

// updateMetrics updates logging metrics
func (sl *StructuredLogger) updateMetrics(level zapcore.Level) {
	sl.metrics.mu.Lock()
	defer sl.metrics.mu.Unlock()
	
	// Update counts
	switch level {
	case zapcore.DebugLevel:
		sl.metrics.debugCount++
	case zapcore.InfoLevel:
		sl.metrics.infoCount++
	case zapcore.WarnLevel:
		sl.metrics.warnCount++
	case zapcore.ErrorLevel:
		sl.metrics.errorCount++
	case zapcore.FatalLevel:
		sl.metrics.fatalCount++
	}
	
	// Update rate
	now := time.Now()
	if elapsed := now.Sub(sl.metrics.lastLogTime); elapsed > 0 {
		sl.metrics.logRate = 1.0 / elapsed.Seconds()
	}
	sl.metrics.lastLogTime = now
}

// metricsCollector periodically collects metrics
func (sl *StructuredLogger) metricsCollector() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for range ticker.C {
		sl.logMetrics()
	}
}

// logMetrics logs current metrics
func (sl *StructuredLogger) logMetrics() {
	sl.metrics.mu.RLock()
	defer sl.metrics.mu.RUnlock()
	
	total := sl.metrics.debugCount + sl.metrics.infoCount + 
		sl.metrics.warnCount + sl.metrics.errorCount + sl.metrics.fatalCount
	
	sl.Logger.Info("Logging metrics",
		zap.Uint64("total_logs", total),
		zap.Uint64("debug_count", sl.metrics.debugCount),
		zap.Uint64("info_count", sl.metrics.infoCount),
		zap.Uint64("warn_count", sl.metrics.warnCount),
		zap.Uint64("error_count", sl.metrics.errorCount),
		zap.Uint64("fatal_count", sl.metrics.fatalCount),
		zap.Float64("log_rate", sl.metrics.logRate),
		zap.Uint64("dropped_logs", sl.metrics.droppedLogs),
		zap.Uint64("file_rotations", sl.metrics.fileRotations),
	)
}

// GetMetrics returns current logging metrics
func (sl *StructuredLogger) GetMetrics() map[string]interface{} {
	sl.metrics.mu.RLock()
	defer sl.metrics.mu.RUnlock()
	
	total := sl.metrics.debugCount + sl.metrics.infoCount + 
		sl.metrics.warnCount + sl.metrics.errorCount + sl.metrics.fatalCount
	
	return map[string]interface{}{
		"total_logs":     total,
		"debug_count":    sl.metrics.debugCount,
		"info_count":     sl.metrics.infoCount,
		"warn_count":     sl.metrics.warnCount,
		"error_count":    sl.metrics.errorCount,
		"fatal_count":    sl.metrics.fatalCount,
		"log_rate":       sl.metrics.logRate,
		"dropped_logs":   sl.metrics.droppedLogs,
		"file_rotations": sl.metrics.fileRotations,
	}
}

// Structured logging helpers

// LogRequest logs HTTP request details
func (sl *StructuredLogger) LogRequest(method, path string, statusCode int, duration time.Duration, fields ...zap.Field) {
	baseFields := []zap.Field{
		zap.String("method", method),
		zap.String("path", path),
		zap.Int("status_code", statusCode),
		zap.Duration("duration", duration),
		zap.String("latency", duration.String()),
	}
	
	fields = append(baseFields, fields...)
	
	if statusCode >= 500 {
		sl.Error("Request failed", fields...)
	} else if statusCode >= 400 {
		sl.Warn("Request error", fields...)
	} else {
		sl.Info("Request completed", fields...)
	}
}

// LogDatabaseQuery logs database query details
func (sl *StructuredLogger) LogDatabaseQuery(query string, duration time.Duration, err error, fields ...zap.Field) {
	baseFields := []zap.Field{
		zap.String("query", query),
		zap.Duration("duration", duration),
	}
	
	fields = append(baseFields, fields...)
	
	if err != nil {
		fields = append(fields, zap.Error(err))
		sl.Error("Database query failed", fields...)
	} else if duration > 1*time.Second {
		sl.Warn("Slow database query", fields...)
	} else {
		sl.Debug("Database query executed", fields...)
	}
}

// LogMetric logs a metric value
func (sl *StructuredLogger) LogMetric(name string, value float64, unit string, fields ...zap.Field) {
	baseFields := []zap.Field{
		zap.String("metric_name", name),
		zap.Float64("metric_value", value),
		zap.String("metric_unit", unit),
		zap.Int64("timestamp", time.Now().Unix()),
	}
	
	fields = append(baseFields, fields...)
	sl.Info("Metric recorded", fields...)
}

// LogEvent logs a business event
func (sl *StructuredLogger) LogEvent(eventType string, userID string, metadata map[string]interface{}, fields ...zap.Field) {
	baseFields := []zap.Field{
		zap.String("event_type", eventType),
		zap.String("user_id", userID),
		zap.Any("metadata", metadata),
		zap.Time("event_time", time.Now()),
	}
	
	fields = append(baseFields, fields...)
	sl.Info("Event occurred", fields...)
}

// LogSecurity logs security-related events
func (sl *StructuredLogger) LogSecurity(eventType string, severity string, details map[string]interface{}, fields ...zap.Field) {
	baseFields := []zap.Field{
		zap.String("security_event", eventType),
		zap.String("severity", severity),
		zap.Any("details", details),
		zap.Time("detected_at", time.Now()),
	}
	
	fields = append(baseFields, fields...)
	
	switch severity {
	case "critical", "high":
		sl.Error("Security event detected", fields...)
	case "medium":
		sl.Warn("Security event detected", fields...)
	default:
		sl.Info("Security event detected", fields...)
	}
}

// Flush flushes any buffered log entries
func (sl *StructuredLogger) Flush() error {
	return sl.Logger.Sync()
}