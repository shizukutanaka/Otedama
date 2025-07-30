package logging

import (
	"context"
	"fmt"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

// contextKey is the type for context keys
type contextKey string

const (
	// Context keys
	loggerKey     contextKey = "logger"
	requestIDKey  contextKey = "request_id"
	operationKey  contextKey = "operation"
	workerIDKey   contextKey = "worker_id"
)

// Context provides structured logging context
// Following Rob Pike's principle: "Don't just check errors, handle them gracefully"
type Context struct {
	logger    *zap.Logger
	fields    []zap.Field
	requestID string
}

// NewContext creates a new logging context
func NewContext(logger *zap.Logger) *Context {
	return &Context{
		logger:    logger,
		fields:    []zap.Field{},
		requestID: generateRequestID(),
	}
}

// WithContext returns a context with embedded logger
func WithContext(ctx context.Context, logger *zap.Logger) context.Context {
	return context.WithValue(ctx, loggerKey, logger)
}

// FromContext extracts logger from context
func FromContext(ctx context.Context) *zap.Logger {
	if logger, ok := ctx.Value(loggerKey).(*zap.Logger); ok {
		return logger
	}
	return zap.L() // Return global logger as fallback
}

// WithRequestID adds request ID to context
func WithRequestID(ctx context.Context, requestID string) context.Context {
	return context.WithValue(ctx, requestIDKey, requestID)
}

// WithOperation adds operation name to context
func WithOperation(ctx context.Context, operation string) context.Context {
	return context.WithValue(ctx, operationKey, operation)
}

// WithWorkerID adds worker ID to context
func WithWorkerID(ctx context.Context, workerID string) context.Context {
	return context.WithValue(ctx, workerIDKey, workerID)
}

// ExtractFields extracts logging fields from context
func ExtractFields(ctx context.Context) []zap.Field {
	fields := []zap.Field{}
	
	if requestID, ok := ctx.Value(requestIDKey).(string); ok {
		fields = append(fields, zap.String("request_id", requestID))
	}
	
	if operation, ok := ctx.Value(operationKey).(string); ok {
		fields = append(fields, zap.String("operation", operation))
	}
	
	if workerID, ok := ctx.Value(workerIDKey).(string); ok {
		fields = append(fields, zap.String("worker_id", workerID))
	}
	
	return fields
}

// Operation logs an operation with timing
func Operation(ctx context.Context, name string, fn func() error) error {
	logger := FromContext(ctx).With(ExtractFields(ctx)...)
	
	start := time.Now()
	logger.Debug("Starting operation", zap.String("operation", name))
	
	err := fn()
	
	duration := time.Since(start)
	fields := []zap.Field{
		zap.String("operation", name),
		zap.Duration("duration", duration),
	}
	
	if err != nil {
		logger.Error("Operation failed", append(fields, zap.Error(err))...)
	} else {
		logger.Debug("Operation completed", fields...)
	}
	
	return err
}

// Trace provides detailed tracing for debugging
type Trace struct {
	logger    *zap.Logger
	name      string
	fields    []zap.Field
	start     time.Time
	steps     []TraceStep
}

// TraceStep represents a step in a trace
type TraceStep struct {
	Name     string
	Duration time.Duration
	Error    error
}

// StartTrace starts a new trace
func StartTrace(ctx context.Context, name string) *Trace {
	logger := FromContext(ctx).With(ExtractFields(ctx)...)
	
	trace := &Trace{
		logger: logger,
		name:   name,
		fields: []zap.Field{zap.String("trace", name)},
		start:  time.Now(),
		steps:  []TraceStep{},
	}
	
	if logger.Core().Enabled(zapcore.DebugLevel) {
		logger.Debug("Trace started", trace.fields...)
	}
	
	return trace
}

// Step records a trace step
func (t *Trace) Step(name string, fn func() error) error {
	stepStart := time.Now()
	err := fn()
	duration := time.Since(stepStart)
	
	t.steps = append(t.steps, TraceStep{
		Name:     name,
		Duration: duration,
		Error:    err,
	})
	
	if t.logger.Core().Enabled(zapcore.DebugLevel) {
		fields := append(t.fields,
			zap.String("step", name),
			zap.Duration("step_duration", duration),
		)
		
		if err != nil {
			t.logger.Debug("Trace step failed", append(fields, zap.Error(err))...)
		} else {
			t.logger.Debug("Trace step completed", fields...)
		}
	}
	
	return err
}

// Complete completes the trace
func (t *Trace) Complete() {
	totalDuration := time.Since(t.start)
	
	if !t.logger.Core().Enabled(zapcore.DebugLevel) {
		return
	}
	
	fields := append(t.fields,
		zap.Duration("total_duration", totalDuration),
		zap.Int("steps", len(t.steps)),
	)
	
	// Add step summary
	var failedSteps []string
	for _, step := range t.steps {
		if step.Error != nil {
			failedSteps = append(failedSteps, step.Name)
		}
	}
	
	if len(failedSteps) > 0 {
		fields = append(fields, zap.Strings("failed_steps", failedSteps))
	}
	
	t.logger.Debug("Trace completed", fields...)
}

// Metrics provides structured metrics logging
type Metrics struct {
	logger *zap.Logger
}

// NewMetrics creates a new metrics logger
func NewMetrics(logger *zap.Logger) *Metrics {
	return &Metrics{
		logger: logger.With(zap.String("type", "metrics")),
	}
}

// RecordMining logs mining metrics
func (m *Metrics) RecordMining(algorithm string, hashRate float64, shares uint64, accepted uint64) {
	m.logger.Info("Mining metrics",
		zap.String("algorithm", algorithm),
		zap.Float64("hash_rate", hashRate),
		zap.Uint64("shares_submitted", shares),
		zap.Uint64("shares_accepted", accepted),
		zap.Float64("acceptance_rate", float64(accepted)/float64(shares)*100),
	)
}

// RecordNetwork logs network metrics
func (m *Metrics) RecordNetwork(peers int, bytesIn, bytesOut uint64, latency time.Duration) {
	m.logger.Info("Network metrics",
		zap.Int("peer_count", peers),
		zap.Uint64("bytes_in", bytesIn),
		zap.Uint64("bytes_out", bytesOut),
		zap.Duration("avg_latency", latency),
	)
}

// RecordPerformance logs performance metrics
func (m *Metrics) RecordPerformance(cpu float64, memoryMB uint64, goroutines int) {
	m.logger.Info("Performance metrics",
		zap.Float64("cpu_percent", cpu),
		zap.Uint64("memory_mb", memoryMB),
		zap.Int("goroutines", goroutines),
	)
}

// Audit provides audit logging
type Audit struct {
	logger *zap.Logger
}

// NewAudit creates a new audit logger
func NewAudit(logger *zap.Logger) *Audit {
	return &Audit{
		logger: logger.With(zap.String("type", "audit")),
	}
}

// LogAuthentication logs authentication events
func (a *Audit) LogAuthentication(userID, method string, success bool, reason string) {
	fields := []zap.Field{
		zap.String("user_id", userID),
		zap.String("auth_method", method),
		zap.Bool("success", success),
		zap.Time("timestamp", time.Now()),
	}
	
	if reason != "" {
		fields = append(fields, zap.String("reason", reason))
	}
	
	if success {
		a.logger.Info("Authentication successful", fields...)
	} else {
		a.logger.Warn("Authentication failed", fields...)
	}
}

// LogShareSubmission logs share submissions
func (a *Audit) LogShareSubmission(workerID, jobID string, accepted bool, difficulty float64) {
	fields := []zap.Field{
		zap.String("worker_id", workerID),
		zap.String("job_id", jobID),
		zap.Bool("accepted", accepted),
		zap.Float64("difficulty", difficulty),
		zap.Time("timestamp", time.Now()),
	}
	
	a.logger.Info("Share submitted", fields...)
}

// LogConfigChange logs configuration changes
func (a *Audit) LogConfigChange(component, setting string, oldValue, newValue interface{}, changedBy string) {
	a.logger.Info("Configuration changed",
		zap.String("component", component),
		zap.String("setting", setting),
		zap.Any("old_value", oldValue),
		zap.Any("new_value", newValue),
		zap.String("changed_by", changedBy),
		zap.Time("timestamp", time.Now()),
	)
}

// Helper functions

var requestCounter atomic.Uint64

func generateRequestID() string {
	timestamp := time.Now().UnixNano() / 1000000 // milliseconds
	counter := requestCounter.Add(1)
	return fmt.Sprintf("%d-%d", timestamp, counter)
}

// StructuredError provides structured error logging
type StructuredError struct {
	Op      string      // Operation
	Kind    string      // Error kind
	Err     error       // Underlying error
	Details interface{} // Additional details
}

func (e *StructuredError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%s: %s: %v", e.Op, e.Kind, e.Err)
	}
	return fmt.Sprintf("%s: %s", e.Op, e.Kind)
}

// LogStructuredError logs a structured error
func LogStructuredError(logger *zap.Logger, err *StructuredError) {
	fields := []zap.Field{
		zap.String("operation", err.Op),
		zap.String("error_kind", err.Kind),
	}
	
	if err.Err != nil {
		fields = append(fields, zap.Error(err.Err))
	}
	
	if err.Details != nil {
		fields = append(fields, zap.Any("details", err.Details))
	}
	
	logger.Error("Operation failed", fields...)
}