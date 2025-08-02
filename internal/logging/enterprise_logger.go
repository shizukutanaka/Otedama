package logging

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"gopkg.in/natefinch/lumberjack.v2"
)

// EnterpriseLogger provides enterprise-grade logging with audit trails
type EnterpriseLogger struct {
	core         *zap.Logger
	auditLogger  *zap.Logger
	securityLogger *zap.Logger
	
	config       LoggerConfig
	
	// Log storage
	storage      LogStorage
	
	// Log shipping
	shippers     []LogShipper
	shippersMu   sync.RWMutex
	
	// Metrics
	logCount     atomic.Uint64
	errorCount   atomic.Uint64
	
	// Buffering
	buffer       *LogBuffer
	
	// Control
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// LoggerConfig configures enterprise logging
type LoggerConfig struct {
	// Core settings
	Level           string        `yaml:"level"`
	Development     bool          `yaml:"development"`
	Encoding        string        `yaml:"encoding"` // json, console
	
	// Output settings
	OutputPaths     []string      `yaml:"output_paths"`
	ErrorOutputPaths []string     `yaml:"error_output_paths"`
	
	// File rotation
	MaxSize         int           `yaml:"max_size"`     // MB
	MaxAge          int           `yaml:"max_age"`      // days
	MaxBackups      int           `yaml:"max_backups"`
	Compress        bool          `yaml:"compress"`
	
	// Audit logging
	EnableAudit     bool          `yaml:"enable_audit"`
	AuditFile       string        `yaml:"audit_file"`
	
	// Security logging
	EnableSecurity  bool          `yaml:"enable_security"`
	SecurityFile    string        `yaml:"security_file"`
	
	// Remote logging
	EnableRemote    bool          `yaml:"enable_remote"`
	RemoteEndpoints []string      `yaml:"remote_endpoints"`
	
	// Buffering
	BufferSize      int           `yaml:"buffer_size"`
	FlushInterval   time.Duration `yaml:"flush_interval"`
	
	// Filtering
	SamplingEnabled bool          `yaml:"sampling_enabled"`
	SamplingInitial int           `yaml:"sampling_initial"`
	SamplingThereafter int        `yaml:"sampling_thereafter"`
}

// LogStorage interface for log persistence
type LogStorage interface {
	Store(entry LogEntry) error
	Query(filter LogFilter) ([]LogEntry, error)
	Delete(before time.Time) error
}

// LogShipper interface for shipping logs to external systems
type LogShipper interface {
	Ship(entries []LogEntry) error
	Name() string
}

// LogEntry represents a structured log entry
type LogEntry struct {
	Timestamp    time.Time              `json:"timestamp"`
	Level        string                 `json:"level"`
	Message      string                 `json:"message"`
	Logger       string                 `json:"logger"`
	Caller       string                 `json:"caller"`
	Fields       map[string]interface{} `json:"fields"`
	StackTrace   string                 `json:"stack_trace,omitempty"`
	
	// Audit fields
	UserID       string                 `json:"user_id,omitempty"`
	SessionID    string                 `json:"session_id,omitempty"`
	IP           string                 `json:"ip,omitempty"`
	Action       string                 `json:"action,omitempty"`
	Resource     string                 `json:"resource,omitempty"`
	Result       string                 `json:"result,omitempty"`
	
	// Security fields
	ThreatLevel  string                 `json:"threat_level,omitempty"`
	Attack       string                 `json:"attack,omitempty"`
}

// LogFilter for querying logs
type LogFilter struct {
	StartTime    time.Time
	EndTime      time.Time
	Level        string
	Logger       string
	UserID       string
	SessionID    string
	Action       string
	Contains     string
	Limit        int
}

// LogBuffer provides buffered log writing
type LogBuffer struct {
	entries      []LogEntry
	mu           sync.Mutex
	flushSize    int
	flushChan    chan struct{}
}

// AuditEvent represents an audit event
type AuditEvent struct {
	Timestamp    time.Time
	UserID       string
	Action       string
	Resource     string
	Result       string
	Details      map[string]interface{}
	IP           string
	SessionID    string
}

// SecurityEvent represents a security event
type SecurityEvent struct {
	Timestamp    time.Time
	Type         string
	Severity     string
	Source       string
	Target       string
	Action       string
	Result       string
	Details      map[string]interface{}
}

// NewEnterpriseLogger creates a new enterprise logger
func NewEnterpriseLogger(config LoggerConfig) (*EnterpriseLogger, error) {
	ctx, cancel := context.WithCancel(context.Background())
	
	el := &EnterpriseLogger{
		config: config,
		ctx:    ctx,
		cancel: cancel,
		buffer: &LogBuffer{
			entries:   make([]LogEntry, 0, config.BufferSize),
			flushSize: config.BufferSize,
			flushChan: make(chan struct{}, 1),
		},
	}
	
	// Initialize core logger
	core, err := el.buildLogger("core", config.OutputPaths, config.ErrorOutputPaths)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("failed to create core logger: %w", err)
	}
	el.core = core
	
	// Initialize audit logger
	if config.EnableAudit {
		auditPaths := []string{config.AuditFile}
		audit, err := el.buildLogger("audit", auditPaths, auditPaths)
		if err != nil {
			cancel()
			return nil, fmt.Errorf("failed to create audit logger: %w", err)
		}
		el.auditLogger = audit
	}
	
	// Initialize security logger
	if config.EnableSecurity {
		securityPaths := []string{config.SecurityFile}
		security, err := el.buildLogger("security", securityPaths, securityPaths)
		if err != nil {
			cancel()
			return nil, fmt.Errorf("failed to create security logger: %w", err)
		}
		el.securityLogger = security
	}
	
	// Initialize storage
	storage, err := NewLogStorage(config)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("failed to create log storage: %w", err)
	}
	el.storage = storage
	
	// Start background workers
	el.wg.Add(2)
	go el.bufferFlusher()
	go el.logShipper()
	
	return el, nil
}

// GetLogger returns the core zap logger
func (el *EnterpriseLogger) GetLogger() *zap.Logger {
	return el.core
}

// LogAudit logs an audit event
func (el *EnterpriseLogger) LogAudit(event AuditEvent) {
	if el.auditLogger == nil {
		return
	}
	
	fields := []zap.Field{
		zap.Time("timestamp", event.Timestamp),
		zap.String("user_id", event.UserID),
		zap.String("action", event.Action),
		zap.String("resource", event.Resource),
		zap.String("result", event.Result),
		zap.String("ip", event.IP),
		zap.String("session_id", event.SessionID),
		zap.Any("details", event.Details),
	}
	
	el.auditLogger.Info("Audit Event", fields...)
	
	// Store in buffer
	el.addToBuffer(LogEntry{
		Timestamp: event.Timestamp,
		Level:     "AUDIT",
		Message:   fmt.Sprintf("Audit: %s %s", event.Action, event.Resource),
		Logger:    "audit",
		UserID:    event.UserID,
		SessionID: event.SessionID,
		IP:        event.IP,
		Action:    event.Action,
		Resource:  event.Resource,
		Result:    event.Result,
		Fields:    event.Details,
	})
}

// LogSecurity logs a security event
func (el *EnterpriseLogger) LogSecurity(event SecurityEvent) {
	if el.securityLogger == nil {
		return
	}
	
	fields := []zap.Field{
		zap.Time("timestamp", event.Timestamp),
		zap.String("type", event.Type),
		zap.String("severity", event.Severity),
		zap.String("source", event.Source),
		zap.String("target", event.Target),
		zap.String("action", event.Action),
		zap.String("result", event.Result),
		zap.Any("details", event.Details),
	}
	
	// Log based on severity
	switch event.Severity {
	case "critical":
		el.securityLogger.Error("Security Event", fields...)
	case "high":
		el.securityLogger.Warn("Security Event", fields...)
	default:
		el.securityLogger.Info("Security Event", fields...)
	}
	
	// Store in buffer
	el.addToBuffer(LogEntry{
		Timestamp:   event.Timestamp,
		Level:       "SECURITY",
		Message:     fmt.Sprintf("Security: %s from %s", event.Type, event.Source),
		Logger:      "security",
		ThreatLevel: event.Severity,
		Attack:      event.Type,
		Fields:      event.Details,
	})
}

// QueryLogs queries historical logs
func (el *EnterpriseLogger) QueryLogs(filter LogFilter) ([]LogEntry, error) {
	return el.storage.Query(filter)
}

// AddShipper adds a log shipper
func (el *EnterpriseLogger) AddShipper(shipper LogShipper) {
	el.shippersMu.Lock()
	defer el.shippersMu.Unlock()
	
	el.shippers = append(el.shippers, shipper)
	el.core.Info("Added log shipper", zap.String("name", shipper.Name()))
}

// GetMetrics returns logging metrics
func (el *EnterpriseLogger) GetMetrics() map[string]interface{} {
	return map[string]interface{}{
		"total_logs":   el.logCount.Load(),
		"error_count":  el.errorCount.Load(),
		"buffer_size":  len(el.buffer.entries),
		"shipper_count": len(el.shippers),
	}
}

// Shutdown gracefully shuts down the logger
func (el *EnterpriseLogger) Shutdown() error {
	el.cancel()
	
	// Flush buffer
	el.flushBuffer()
	
	// Wait for workers
	el.wg.Wait()
	
	// Sync loggers
	el.core.Sync()
	if el.auditLogger != nil {
		el.auditLogger.Sync()
	}
	if el.securityLogger != nil {
		el.securityLogger.Sync()
	}
	
	return nil
}

// Private methods

func (el *EnterpriseLogger) buildLogger(name string, outputPaths, errorOutputPaths []string) (*zap.Logger, error) {
	// Parse log level
	level, err := zapcore.ParseLevel(el.config.Level)
	if err != nil {
		return nil, err
	}
	
	// Build encoder config
	encoderConfig := zapcore.EncoderConfig{
		TimeKey:        "timestamp",
		LevelKey:       "level",
		NameKey:        "logger",
		CallerKey:      "caller",
		FunctionKey:    zapcore.OmitKey,
		MessageKey:     "message",
		StacktraceKey:  "stacktrace",
		LineEnding:     zapcore.DefaultLineEnding,
		EncodeLevel:    zapcore.CapitalLevelEncoder,
		EncodeTime:     zapcore.ISO8601TimeEncoder,
		EncodeDuration: zapcore.StringDurationEncoder,
		EncodeCaller:   zapcore.ShortCallerEncoder,
	}
	
	// Create encoder
	var encoder zapcore.Encoder
	if el.config.Encoding == "json" {
		encoder = zapcore.NewJSONEncoder(encoderConfig)
	} else {
		encoder = zapcore.NewConsoleEncoder(encoderConfig)
	}
	
	// Create writers
	writers := make([]zapcore.WriteSyncer, 0)
	
	for _, path := range outputPaths {
		if path == "stdout" {
			writers = append(writers, zapcore.AddSync(os.Stdout))
		} else if path == "stderr" {
			writers = append(writers, zapcore.AddSync(os.Stderr))
		} else {
			// Create file writer with rotation
			writer := &lumberjack.Logger{
				Filename:   path,
				MaxSize:    el.config.MaxSize,
				MaxAge:     el.config.MaxAge,
				MaxBackups: el.config.MaxBackups,
				Compress:   el.config.Compress,
			}
			writers = append(writers, zapcore.AddSync(writer))
		}
	}
	
	// Create core
	core := zapcore.NewCore(
		encoder,
		zapcore.NewMultiWriteSyncer(writers...),
		level,
	)
	
	// Add sampling if enabled
	if el.config.SamplingEnabled {
		core = zapcore.NewSamplerWithOptions(
			core,
			time.Second,
			el.config.SamplingInitial,
			el.config.SamplingThereafter,
		)
	}
	
	// Build logger
	logger := zap.New(core,
		zap.AddCaller(),
		zap.AddStacktrace(zapcore.ErrorLevel),
		zap.Fields(zap.String("component", name)),
	)
	
	return logger, nil
}

func (el *EnterpriseLogger) addToBuffer(entry LogEntry) {
	el.buffer.mu.Lock()
	el.buffer.entries = append(el.buffer.entries, entry)
	
	if len(el.buffer.entries) >= el.buffer.flushSize {
		select {
		case el.buffer.flushChan <- struct{}{}:
		default:
		}
	}
	el.buffer.mu.Unlock()
	
	el.logCount.Add(1)
	if entry.Level == "ERROR" || entry.Level == "FATAL" {
		el.errorCount.Add(1)
	}
}

func (el *EnterpriseLogger) bufferFlusher() {
	defer el.wg.Done()
	
	ticker := time.NewTicker(el.config.FlushInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-el.ctx.Done():
			return
		case <-ticker.C:
			el.flushBuffer()
		case <-el.buffer.flushChan:
			el.flushBuffer()
		}
	}
}

func (el *EnterpriseLogger) flushBuffer() {
	el.buffer.mu.Lock()
	if len(el.buffer.entries) == 0 {
		el.buffer.mu.Unlock()
		return
	}
	
	entries := make([]LogEntry, len(el.buffer.entries))
	copy(entries, el.buffer.entries)
	el.buffer.entries = el.buffer.entries[:0]
	el.buffer.mu.Unlock()
	
	// Store entries
	for _, entry := range entries {
		if err := el.storage.Store(entry); err != nil {
			el.core.Error("Failed to store log entry", zap.Error(err))
		}
	}
	
	// Ship entries if remote logging enabled
	if el.config.EnableRemote && len(el.shippers) > 0 {
		el.shipLogs(entries)
	}
}

func (el *EnterpriseLogger) logShipper() {
	defer el.wg.Done()
	
	if !el.config.EnableRemote {
		return
	}
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-el.ctx.Done():
			return
		case <-ticker.C:
			// Ship any buffered logs
			el.flushBuffer()
		}
	}
}

func (el *EnterpriseLogger) shipLogs(entries []LogEntry) {
	el.shippersMu.RLock()
	shippers := make([]LogShipper, len(el.shippers))
	copy(shippers, el.shippers)
	el.shippersMu.RUnlock()
	
	for _, shipper := range shippers {
		go func(s LogShipper) {
			if err := s.Ship(entries); err != nil {
				el.core.Error("Failed to ship logs",
					zap.String("shipper", s.Name()),
					zap.Error(err),
				)
			}
		}(shipper)
	}
}

// LogStorage implementations

// FileLogStorage stores logs in files
type FileLogStorage struct {
	baseDir string
	mu      sync.RWMutex
}

func NewLogStorage(config LoggerConfig) (LogStorage, error) {
	baseDir := filepath.Join("logs", "storage")
	if err := os.MkdirAll(baseDir, 0755); err != nil {
		return nil, err
	}
	
	return &FileLogStorage{
		baseDir: baseDir,
	}, nil
}

func (fs *FileLogStorage) Store(entry LogEntry) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	
	// Create daily file
	date := entry.Timestamp.Format("2006-01-02")
	filename := filepath.Join(fs.baseDir, fmt.Sprintf("%s.jsonl", date))
	
	file, err := os.OpenFile(filename, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer file.Close()
	
	// Write entry as JSON line
	data, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	
	_, err = file.Write(append(data, '\n'))
	return err
}

func (fs *FileLogStorage) Query(filter LogFilter) ([]LogEntry, error) {
	fs.mu.RLock()
	defer fs.mu.RUnlock()
	
	var results []LogEntry
	
	// Iterate through daily files
	startDate := filter.StartTime.Format("2006-01-02")
	endDate := filter.EndTime.Format("2006-01-02")
	
	for date := startDate; date <= endDate; {
		filename := filepath.Join(fs.baseDir, fmt.Sprintf("%s.jsonl", date))
		
		entries, err := fs.readFile(filename, filter)
		if err != nil && !os.IsNotExist(err) {
			return nil, err
		}
		
		results = append(results, entries...)
		
		// Next day
		t, _ := time.Parse("2006-01-02", date)
		t = t.AddDate(0, 0, 1)
		date = t.Format("2006-01-02")
	}
	
	// Apply limit
	if filter.Limit > 0 && len(results) > filter.Limit {
		results = results[:filter.Limit]
	}
	
	return results, nil
}

func (fs *FileLogStorage) readFile(filename string, filter LogFilter) ([]LogEntry, error) {
	file, err := os.Open(filename)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	
	var results []LogEntry
	decoder := json.NewDecoder(file)
	
	for {
		var entry LogEntry
		if err := decoder.Decode(&entry); err != nil {
			if err == io.EOF {
				break
			}
			return nil, err
		}
		
		// Apply filters
		if fs.matchesFilter(entry, filter) {
			results = append(results, entry)
		}
	}
	
	return results, nil
}

func (fs *FileLogStorage) matchesFilter(entry LogEntry, filter LogFilter) bool {
	// Time filter
	if !filter.StartTime.IsZero() && entry.Timestamp.Before(filter.StartTime) {
		return false
	}
	if !filter.EndTime.IsZero() && entry.Timestamp.After(filter.EndTime) {
		return false
	}
	
	// Level filter
	if filter.Level != "" && entry.Level != filter.Level {
		return false
	}
	
	// Logger filter
	if filter.Logger != "" && entry.Logger != filter.Logger {
		return false
	}
	
	// User filter
	if filter.UserID != "" && entry.UserID != filter.UserID {
		return false
	}
	
	// Session filter
	if filter.SessionID != "" && entry.SessionID != filter.SessionID {
		return false
	}
	
	// Action filter
	if filter.Action != "" && entry.Action != filter.Action {
		return false
	}
	
	// Contains filter
	if filter.Contains != "" {
		// Search in message and fields
		if !contains(entry.Message, filter.Contains) {
			// Check fields
			found := false
			for _, v := range entry.Fields {
				if contains(fmt.Sprintf("%v", v), filter.Contains) {
					found = true
					break
				}
			}
			if !found {
				return false
			}
		}
	}
	
	return true
}

func (fs *FileLogStorage) Delete(before time.Time) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	
	entries, err := os.ReadDir(fs.baseDir)
	if err != nil {
		return err
	}
	
	beforeDate := before.Format("2006-01-02")
	
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		
		// Extract date from filename
		name := entry.Name()
		if len(name) < 10 {
			continue
		}
		
		date := name[:10]
		if date < beforeDate {
			if err := os.Remove(filepath.Join(fs.baseDir, name)); err != nil {
				return err
			}
		}
	}
	
	return nil
}

// Helper functions

func contains(s, substr string) bool {
	return len(substr) > 0 && len(s) >= len(substr) && 
		(s == substr || len(s) > len(substr) && 
		(s[:len(substr)] == substr || s[len(s)-len(substr):] == substr || 
		len(s) > len(substr) && containsMiddle(s[1:len(s)-1], substr)))
}

func containsMiddle(s, substr string) bool {
	if len(s) < len(substr) {
		return false
	}
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}