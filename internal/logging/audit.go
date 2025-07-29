package logging

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

// AuditEvent represents a security or operational audit event
type AuditEvent struct {
	ID          string                 `json:"id"`
	Timestamp   time.Time             `json:"timestamp"`
	EventType   string                `json:"event_type"`
	Severity    string                `json:"severity"`
	Source      string                `json:"source"`
	UserID      string                `json:"user_id,omitempty"`
	ClientIP    string                `json:"client_ip,omitempty"`
	Action      string                `json:"action"`
	Resource    string                `json:"resource,omitempty"`
	Result      string                `json:"result"`
	Details     map[string]interface{} `json:"details,omitempty"`
	MessageHash string                `json:"message_hash"`
}

// AuditLogger handles security and operational audit logging
type AuditLogger struct {
	logger    *zap.Logger
	events    []AuditEvent
	mu        sync.RWMutex
	config    AuditConfig
	eventChan chan AuditEvent
}

// AuditConfig configuration for audit logging
type AuditConfig struct {
	Enabled         bool   `mapstructure:"enabled"`
	LogFile         string `mapstructure:"log_file"`
	MaxFileSize     int    `mapstructure:"max_file_size_mb"`
	MaxBackups      int    `mapstructure:"max_backups"`
	MaxAge          int    `mapstructure:"max_age_days"`
	BufferSize      int    `mapstructure:"buffer_size"`
	FlushInterval   int    `mapstructure:"flush_interval_seconds"`
	IncludeDebug    bool   `mapstructure:"include_debug"`
	EncryptLogs     bool   `mapstructure:"encrypt_logs"`
	RemoteEndpoint  string `mapstructure:"remote_endpoint"`
}

// NewAuditLogger creates a new audit logger
func NewAuditLogger(config AuditConfig, baseLogger *zap.Logger) (*AuditLogger, error) {
	auditLogger := &AuditLogger{
		logger:    baseLogger.Named("audit"),
		config:    config,
		eventChan: make(chan AuditEvent, config.BufferSize),
	}
	
	// Start background processor
	go auditLogger.processEvents()
	
	return auditLogger, nil
}

// LogEvent logs an audit event
func (al *AuditLogger) LogEvent(eventType, severity, source, action, result string, details map[string]interface{}) {
	if !al.config.Enabled {
		return
	}
	
	event := AuditEvent{
		ID:        al.generateEventID(),
		Timestamp: time.Now().UTC(),
		EventType: eventType,
		Severity:  severity,
		Source:    source,
		Action:    action,
		Result:    result,
		Details:   details,
	}
	
	// Add message hash for integrity verification
	event.MessageHash = al.generateMessageHash(event)
	
	select {
	case al.eventChan <- event:
		// Event queued successfully
	default:
		// Buffer full, log directly
		al.writeEvent(event)
	}
}

// LogAuthEvent logs authentication-related events
func (al *AuditLogger) LogAuthEvent(userID, clientIP, action, result string, details map[string]interface{}) {
	if details == nil {
		details = make(map[string]interface{})
	}
	details["user_id"] = userID
	details["client_ip"] = clientIP
	
	al.LogEvent("AUTHENTICATION", "INFO", "stratum", action, result, details)
}

// LogMiningEvent logs mining-related events
func (al *AuditLogger) LogMiningEvent(workerName, clientIP, action, result string, details map[string]interface{}) {
	if details == nil {
		details = make(map[string]interface{})
	}
	details["worker_name"] = workerName
	details["client_ip"] = clientIP
	
	al.LogEvent("MINING", "INFO", "pool", action, result, details)
}

// LogSecurityEvent logs security-related events
func (al *AuditLogger) LogSecurityEvent(clientIP, action, result string, details map[string]interface{}) {
	if details == nil {
		details = make(map[string]interface{})
	}
	details["client_ip"] = clientIP
	
	al.LogEvent("SECURITY", "WARNING", "system", action, result, details)
}

// LogSystemEvent logs system operational events
func (al *AuditLogger) LogSystemEvent(action, result string, details map[string]interface{}) {
	al.LogEvent("SYSTEM", "INFO", "core", action, result, details)
}

// processEvents processes audit events in background
func (al *AuditLogger) processEvents() {
	ticker := time.NewTicker(time.Duration(al.config.FlushInterval) * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case event := <-al.eventChan:
			al.writeEvent(event)
		case <-ticker.C:
			al.flushBuffer()
		}
	}
}

// writeEvent writes an event to the audit log
func (al *AuditLogger) writeEvent(event AuditEvent) {
	al.mu.Lock()
	defer al.mu.Unlock()
	
	// Add to memory buffer
	al.events = append(al.events, event)
	
	// Log to zap logger
	fields := []zapcore.Field{
		zap.String("event_id", event.ID),
		zap.String("event_type", event.EventType),
		zap.String("severity", event.Severity),
		zap.String("source", event.Source),
		zap.String("action", event.Action),
		zap.String("result", event.Result),
		zap.String("message_hash", event.MessageHash),
	}
	
	if event.UserID != "" {
		fields = append(fields, zap.String("user_id", event.UserID))
	}
	
	if event.ClientIP != "" {
		fields = append(fields, zap.String("client_ip", event.ClientIP))
	}
	
	if event.Resource != "" {
		fields = append(fields, zap.String("resource", event.Resource))
	}
	
	if event.Details != nil {
		detailsJSON, _ := json.Marshal(event.Details)
		fields = append(fields, zap.String("details", string(detailsJSON)))
	}
	
	switch event.Severity {
	case "ERROR":
		al.logger.Error("Audit Event", fields...)
	case "WARNING":
		al.logger.Warn("Audit Event", fields...)
	case "INFO":
		al.logger.Info("Audit Event", fields...)
	default:
		al.logger.Info("Audit Event", fields...)
	}
}

// flushBuffer flushes the in-memory event buffer
func (al *AuditLogger) flushBuffer() {
	al.mu.Lock()
	defer al.mu.Unlock()
	
	// Keep only recent events in memory (last 1000)
	if len(al.events) > 1000 {
		al.events = al.events[len(al.events)-1000:]
	}
}

// generateEventID generates a unique event ID
func (al *AuditLogger) generateEventID() string {
	return fmt.Sprintf("audit_%d_%d", time.Now().Unix(), time.Now().Nanosecond())
}

// generateMessageHash generates integrity hash for the event
func (al *AuditLogger) generateMessageHash(event AuditEvent) string {
	data := fmt.Sprintf("%s%s%s%s%s%s", 
		event.Timestamp.Format(time.RFC3339Nano),
		event.EventType,
		event.Source,
		event.Action,
		event.Result,
		event.UserID,
	)
	
	// Simple hash for now - in production use proper cryptographic hash
	return fmt.Sprintf("%x", []byte(data))
}

// GetRecentEvents returns recent audit events
func (al *AuditLogger) GetRecentEvents(limit int) []AuditEvent {
	al.mu.RLock()
	defer al.mu.RUnlock()
	
	if limit <= 0 || limit > len(al.events) {
		limit = len(al.events)
	}
	
	start := len(al.events) - limit
	if start < 0 {
		start = 0
	}
	
	return al.events[start:]
}

// Close gracefully closes the audit logger
func (al *AuditLogger) Close() error {
	close(al.eventChan)
	al.flushBuffer()
	return nil
}