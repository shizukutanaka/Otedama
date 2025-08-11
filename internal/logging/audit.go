package logging

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"go.uber.org/zap"
)

// AuditLogger is responsible for logging security-sensitive audit trails.
// It writes to a separate, dedicated log file to ensure audit events are isolated.
type AuditLogger struct {
	logger *zap.Logger
}

// NewAuditLogger creates a new logger specifically for audit trails.
// It uses a separate logger instance to ensure audit logs are not mixed with general application logs.
func NewAuditLogger(config *Config) (*AuditLogger, error) {
	// Create a dedicated configuration for the audit logger.
	// This ensures audit logs are always written to a specific file in JSON format.
	auditConfig := *config // Copy the base config
	auditConfig.OutputPath = "logs/audit.log"
	auditConfig.Format = "json"
	auditConfig.EnableCaller = false      // Caller is not relevant for audit logs
	auditConfig.EnableStacktrace = false // Stacktraces are not relevant
	auditConfig.Sampling = nil            // Do not sample audit logs

	// Create the logger instance using the main logger creation logic.
	logger, err := createLogger(&auditConfig, "info") // Audit logs are always at INFO level
	if err != nil {
		return nil, fmt.Errorf("failed to create audit logger: %w", err)
	}

	return &AuditLogger{
		logger: logger.Named("audit"),
	}, nil
}

// LogEvent records a structured audit event.
// It includes essential information like who did what, from where, and when.
func (al *AuditLogger) LogEvent(ctx context.Context, eventType, action, result string, details map[string]interface{}) {
	if al.logger == nil {
		return
	}

	// Enrich details with context information (e.g., user ID, request ID).
	enrichedDetails := enrichDetailsFromContext(ctx, details)

	// Generate a unique ID for the event for traceability.
	eventID, _ := uuid.NewRandom()

	// Create the log fields.
	fields := []zap.Field{
		zap.String("event_id", eventID.String()),
		zap.String("event_type", eventType),
		zap.String("action", action),
		zap.String("result", result),
		zap.Any("details", enrichedDetails),
	}

	al.logger.Info("AuditEvent", fields...)
}

// enrichDetailsFromContext extracts relevant information from the context
// and adds it to the details map for a more comprehensive audit log.
func enrichDetailsFromContext(ctx context.Context, details map[string]interface{}) map[string]interface{} {
	if details == nil {
		details = make(map[string]interface{})
	}

	// Example of extracting values from context. The actual keys would depend on
	// how they are set elsewhere in the application.
	if userID := ctx.Value("user_id"); userID != nil {
		details["user_id"] = userID
	}
	if clientIP := ctx.Value("client_ip"); clientIP != nil {
		details["client_ip"] = clientIP
	}
	if requestID := ctx.Value("request_id"); requestID != nil {
		details["request_id"] = requestID
	}

	return details
}

// Sync flushes any buffered audit log entries.
func (al *AuditLogger) Sync() error {
	if al.logger == nil {
		return nil
	}
	return al.logger.Sync()
}

// AuthEvent represents a detailed authentication event.
func (al *AuditLogger) AuthEvent(ctx context.Context, userID, method, result string, extraDetails map[string]interface{}) {
	details := map[string]interface{}{
		"user_id": userID,
		"method":  method,
	}
	for k, v := range extraDetails {
		details[k] = v
	}
	al.LogEvent(ctx, "AUTHENTICATION", "user_login", result, details)
}

// SystemEvent logs a significant system-level event.
func (al *AuditLogger) SystemEvent(ctx context.Context, action, result string, extraDetails map[string]interface{}) {
	al.LogEvent(ctx, "SYSTEM", action, result, extraDetails)
}

// ConfigChangeEvent logs when a configuration change occurs.
func (al *AuditLogger) ConfigChangeEvent(ctx context.Context, changedBy, setting string, oldValue, newValue interface{}) {
	details := map[string]interface{}{
		"changed_by": changedBy,
		"setting":    setting,
		"old_value":  oldValue,
		"new_value":  newValue,
	}
	al.LogEvent(ctx, "CONFIGURATION", "config_update", "success", details)
}
