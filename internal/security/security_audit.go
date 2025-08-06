package security

import (
	"context"
	"fmt"
	"sync"
	"time"

	"go.uber.org/zap"
)

// SecurityAudit provides comprehensive security auditing
type SecurityAudit struct {
	logger *zap.Logger
	config AuditConfig
	
	// Audit log storage
	logs      []AuditLog
	logsMu    sync.RWMutex
	
	// Alert channels
	alerts    chan SecurityAlert
	
	// Statistics
	stats     AuditStats
	statsMu   sync.RWMutex
	
	// Lifecycle
	ctx       context.Context
	cancel    context.CancelFunc
	wg        sync.WaitGroup
}

// AuditConfig contains audit configuration
type AuditConfig struct {
	// Log retention
	RetentionPeriod   time.Duration
	MaxLogs           int
	
	// Alert thresholds
	FailedAuthThreshold    int
	RateLimitThreshold     int
	SuspiciousIPThreshold  int
	
	// Alert settings
	AlertCooldown          time.Duration
	EnableRealTimeAlerts   bool
	
	// Storage
	PersistLogs           bool
	LogPath               string
}

// AuditLog represents a security audit log entry
type AuditLog struct {
	ID          string
	Timestamp   time.Time
	EventType   AuditEventType
	Severity    AuditSeverity
	
	// Event details
	UserID      string
	IPAddress   string
	Action      string
	Resource    string
	Result      string
	
	// Additional context
	Details     map[string]interface{}
	
	// Threat indicators
	ThreatScore int
	Anomalies   []string
}

// AuditEventType represents types of audit events
type AuditEventType string

const (
	EventTypeAuth          AuditEventType = "authentication"
	EventTypeAccess        AuditEventType = "access"
	EventTypeModification  AuditEventType = "modification"
	EventTypeRateLimit     AuditEventType = "rate_limit"
	EventTypeSecurityAlert AuditEventType = "security_alert"
	EventTypeSystemEvent   AuditEventType = "system_event"
)

// AuditSeverity represents event severity levels
type AuditSeverity string

const (
	SeverityInfo     AuditSeverity = "info"
	SeverityWarning  AuditSeverity = "warning"
	SeverityError    AuditSeverity = "error"
	SeverityCritical AuditSeverity = "critical"
)

// SecurityAlert represents a security alert
type SecurityAlert struct {
	ID          string
	Timestamp   time.Time
	Type        AlertType
	Severity    AuditSeverity
	
	// Alert details
	Title       string
	Description string
	Source      string
	
	// Affected resources
	UserID      string
	IPAddress   string
	Resource    string
	
	// Response actions
	Actions     []string
	Resolved    bool
}

// AlertType represents types of security alerts
type AlertType string

const (
	AlertTypeBruteForce      AlertType = "brute_force"
	AlertTypeDDoS            AlertType = "ddos"
	AlertTypeUnauthorized    AlertType = "unauthorized_access"
	AlertTypeSuspiciousIP    AlertType = "suspicious_ip"
	AlertTypeAnomalous       AlertType = "anomalous_behavior"
	AlertTypeConfigChange    AlertType = "config_change"
)

// AuditStats tracks audit statistics
type AuditStats struct {
	TotalEvents      int64
	EventsByType     map[AuditEventType]int64
	EventsBySeverity map[AuditSeverity]int64
	
	// Security metrics
	FailedAuths      int64
	RateLimitHits    int64
	SecurityAlerts   int64
	
	// Time-based metrics
	EventsLastHour   int64
	EventsLastDay    int64
	
	// Top offenders
	TopIPs           map[string]int64
	TopUsers         map[string]int64
}

// NewSecurityAudit creates a new security audit system
func NewSecurityAudit(logger *zap.Logger, config AuditConfig) *SecurityAudit {
	ctx, cancel := context.WithCancel(context.Background())
	
	// Set defaults
	if config.RetentionPeriod <= 0 {
		config.RetentionPeriod = 30 * 24 * time.Hour // 30 days
	}
	if config.MaxLogs <= 0 {
		config.MaxLogs = 1000000
	}
	if config.AlertCooldown <= 0 {
		config.AlertCooldown = 5 * time.Minute
	}
	
	audit := &SecurityAudit{
		logger: logger,
		config: config,
		logs:   make([]AuditLog, 0, 10000),
		alerts: make(chan SecurityAlert, 100),
		stats: AuditStats{
			EventsByType:     make(map[AuditEventType]int64),
			EventsBySeverity: make(map[AuditSeverity]int64),
			TopIPs:           make(map[string]int64),
			TopUsers:         make(map[string]int64),
		},
		ctx:    ctx,
		cancel: cancel,
	}
	
	return audit
}

// Start starts the security audit system
func (sa *SecurityAudit) Start() {
	// Start cleanup routine
	sa.wg.Add(1)
	go sa.cleanupRoutine()
	
	// Start alert processor
	if sa.config.EnableRealTimeAlerts {
		sa.wg.Add(1)
		go sa.alertProcessor()
	}
	
	// Start anomaly detector
	sa.wg.Add(1)
	go sa.anomalyDetector()
	
	sa.logger.Info("Security audit system started")
}

// Stop stops the security audit system
func (sa *SecurityAudit) Stop() {
	sa.cancel()
	close(sa.alerts)
	sa.wg.Wait()
	
	// Persist remaining logs if configured
	if sa.config.PersistLogs {
		sa.persistLogs()
	}
	
	sa.logger.Info("Security audit system stopped")
}

// LogEvent logs a security event
func (sa *SecurityAudit) LogEvent(event AuditLog) {
	// Set timestamp if not provided
	if event.Timestamp.IsZero() {
		event.Timestamp = time.Now()
	}
	
	// Generate ID if not provided
	if event.ID == "" {
		event.ID = generateAuditID()
	}
	
	// Calculate threat score
	event.ThreatScore = sa.calculateThreatScore(&event)
	
	// Store log
	sa.logsMu.Lock()
	sa.logs = append(sa.logs, event)
	
	// Enforce max logs
	if len(sa.logs) > sa.config.MaxLogs {
		sa.logs = sa.logs[len(sa.logs)-sa.config.MaxLogs:]
	}
	sa.logsMu.Unlock()
	
	// Update statistics
	sa.updateStats(&event)
	
	// Check for alerts
	sa.checkAlerts(&event)
	
	// Log high severity events
	if event.Severity == SeverityCritical {
		sa.logger.Error("Critical security event",
			zap.String("event_id", event.ID),
			zap.String("type", string(event.EventType)),
			zap.String("user", event.UserID),
			zap.String("ip", event.IPAddress),
			zap.String("action", event.Action),
		)
	}
}

// LogAuthEvent logs an authentication event
func (sa *SecurityAudit) LogAuthEvent(userID, ipAddress string, success bool, details map[string]interface{}) {
	severity := SeverityInfo
	if !success {
		severity = SeverityWarning
	}
	
	result := "success"
	if !success {
		result = "failure"
	}
	
	event := AuditLog{
		EventType:  EventTypeAuth,
		Severity:   severity,
		UserID:     userID,
		IPAddress:  ipAddress,
		Action:     "login",
		Result:     result,
		Details:    details,
	}
	
	sa.LogEvent(event)
}

// LogAccessEvent logs an access event
func (sa *SecurityAudit) LogAccessEvent(userID, ipAddress, resource, action string, allowed bool) {
	severity := SeverityInfo
	if !allowed {
		severity = SeverityWarning
	}
	
	result := "allowed"
	if !allowed {
		result = "denied"
	}
	
	event := AuditLog{
		EventType:  EventTypeAccess,
		Severity:   severity,
		UserID:     userID,
		IPAddress:  ipAddress,
		Action:     action,
		Resource:   resource,
		Result:     result,
	}
	
	sa.LogEvent(event)
}

// LogSecurityAlert logs a security alert
func (sa *SecurityAudit) LogSecurityAlert(alertType AlertType, severity AuditSeverity, details map[string]interface{}) {
	event := AuditLog{
		EventType:  EventTypeSecurityAlert,
		Severity:   severity,
		Action:     string(alertType),
		Details:    details,
	}
	
	sa.LogEvent(event)
}

// GetStats returns current audit statistics
func (sa *SecurityAudit) GetStats() AuditStats {
	sa.statsMu.RLock()
	defer sa.statsMu.RUnlock()
	
	// Return copy
	stats := sa.stats
	stats.EventsByType = make(map[AuditEventType]int64)
	stats.EventsBySeverity = make(map[AuditSeverity]int64)
	stats.TopIPs = make(map[string]int64)
	stats.TopUsers = make(map[string]int64)
	
	for k, v := range sa.stats.EventsByType {
		stats.EventsByType[k] = v
	}
	for k, v := range sa.stats.EventsBySeverity {
		stats.EventsBySeverity[k] = v
	}
	
	// Get top 10 IPs
	for ip, count := range sa.stats.TopIPs {
		if len(stats.TopIPs) < 10 {
			stats.TopIPs[ip] = count
		}
	}
	
	// Get top 10 users
	for user, count := range sa.stats.TopUsers {
		if len(stats.TopUsers) < 10 {
			stats.TopUsers[user] = count
		}
	}
	
	return stats
}

// GetRecentEvents returns recent audit events
func (sa *SecurityAudit) GetRecentEvents(limit int, filter *AuditFilter) []AuditLog {
	sa.logsMu.RLock()
	defer sa.logsMu.RUnlock()
	
	if limit <= 0 || limit > len(sa.logs) {
		limit = len(sa.logs)
	}
	
	// Get recent events
	start := len(sa.logs) - limit
	if start < 0 {
		start = 0
	}
	
	events := make([]AuditLog, 0, limit)
	for i := len(sa.logs) - 1; i >= start; i-- {
		event := sa.logs[i]
		
		// Apply filter
		if filter != nil {
			if filter.EventType != "" && event.EventType != filter.EventType {
				continue
			}
			if filter.Severity != "" && event.Severity != filter.Severity {
				continue
			}
			if filter.UserID != "" && event.UserID != filter.UserID {
				continue
			}
			if filter.IPAddress != "" && event.IPAddress != filter.IPAddress {
				continue
			}
			if !filter.StartTime.IsZero() && event.Timestamp.Before(filter.StartTime) {
				continue
			}
			if !filter.EndTime.IsZero() && event.Timestamp.After(filter.EndTime) {
				continue
			}
		}
		
		events = append(events, event)
		
		if len(events) >= limit {
			break
		}
	}
	
	return events
}

// Private methods

func (sa *SecurityAudit) updateStats(event *AuditLog) {
	sa.statsMu.Lock()
	defer sa.statsMu.Unlock()
	
	sa.stats.TotalEvents++
	sa.stats.EventsByType[event.EventType]++
	sa.stats.EventsBySeverity[event.Severity]++
	
	// Update specific counters
	switch event.EventType {
	case EventTypeAuth:
		if event.Result == "failure" {
			sa.stats.FailedAuths++
		}
	case EventTypeRateLimit:
		sa.stats.RateLimitHits++
	case EventTypeSecurityAlert:
		sa.stats.SecurityAlerts++
	}
	
	// Update top IPs
	if event.IPAddress != "" {
		sa.stats.TopIPs[event.IPAddress]++
	}
	
	// Update top users
	if event.UserID != "" {
		sa.stats.TopUsers[event.UserID]++
	}
}

func (sa *SecurityAudit) calculateThreatScore(event *AuditLog) int {
	score := 0
	
	// Base score by severity
	switch event.Severity {
	case SeverityInfo:
		score = 1
	case SeverityWarning:
		score = 3
	case SeverityError:
		score = 5
	case SeverityCritical:
		score = 10
	}
	
	// Increase for failed auth
	if event.EventType == EventTypeAuth && event.Result == "failure" {
		score += 2
	}
	
	// Increase for rate limit
	if event.EventType == EventTypeRateLimit {
		score += 3
	}
	
	// Increase for security alerts
	if event.EventType == EventTypeSecurityAlert {
		score += 5
	}
	
	// Check for suspicious patterns
	if sa.isSuspiciousIP(event.IPAddress) {
		score += 5
		event.Anomalies = append(event.Anomalies, "suspicious_ip")
	}
	
	return score
}

func (sa *SecurityAudit) isSuspiciousIP(ip string) bool {
	sa.statsMu.RLock()
	defer sa.statsMu.RUnlock()
	
	count, exists := sa.stats.TopIPs[ip]
	if exists && count > int64(sa.config.SuspiciousIPThreshold) {
		return true
	}
	
	return false
}

func (sa *SecurityAudit) checkAlerts(event *AuditLog) {
	// Check for brute force
	if event.EventType == EventTypeAuth && event.Result == "failure" {
		sa.checkBruteForce(event)
	}
	
	// Check for high threat score
	if event.ThreatScore >= 8 {
		alert := SecurityAlert{
			ID:          generateAlertID(),
			Timestamp:   time.Now(),
			Type:        AlertTypeAnomalous,
			Severity:    event.Severity,
			Title:       "High Threat Score Event",
			Description: fmt.Sprintf("Event with threat score %d detected", event.ThreatScore),
			Source:      string(event.EventType),
			UserID:      event.UserID,
			IPAddress:   event.IPAddress,
			Resource:    event.Resource,
		}
		
		select {
		case sa.alerts <- alert:
		default:
			// Alert channel full
		}
	}
}

func (sa *SecurityAudit) checkBruteForce(event *AuditLog) {
	sa.statsMu.RLock()
	ipCount := sa.stats.TopIPs[event.IPAddress]
	sa.statsMu.RUnlock()
	
	if ipCount >= int64(sa.config.FailedAuthThreshold) {
		alert := SecurityAlert{
			ID:          generateAlertID(),
			Timestamp:   time.Now(),
			Type:        AlertTypeBruteForce,
			Severity:    SeverityWarning,
			Title:       "Potential Brute Force Attack",
			Description: fmt.Sprintf("Multiple failed authentication attempts from IP %s", event.IPAddress),
			Source:      "authentication",
			UserID:      event.UserID,
			IPAddress:   event.IPAddress,
			Actions:     []string{"block_ip", "notify_admin"},
		}
		
		select {
		case sa.alerts <- alert:
		default:
			// Alert channel full
		}
	}
}

func (sa *SecurityAudit) cleanupRoutine() {
	defer sa.wg.Done()
	
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			sa.cleanup()
			
		case <-sa.ctx.Done():
			return
		}
	}
}

func (sa *SecurityAudit) cleanup() {
	sa.logsMu.Lock()
	defer sa.logsMu.Unlock()
	
	cutoff := time.Now().Add(-sa.config.RetentionPeriod)
	
	// Find cutoff index
	cutoffIdx := 0
	for i, log := range sa.logs {
		if log.Timestamp.After(cutoff) {
			cutoffIdx = i
			break
		}
	}
	
	// Remove old logs
	if cutoffIdx > 0 {
		sa.logs = sa.logs[cutoffIdx:]
	}
}

func (sa *SecurityAudit) alertProcessor() {
	defer sa.wg.Done()
	
	for {
		select {
		case alert, ok := <-sa.alerts:
			if !ok {
				return
			}
			
			sa.processAlert(alert)
			
		case <-sa.ctx.Done():
			return
		}
	}
}

func (sa *SecurityAudit) processAlert(alert SecurityAlert) {
	// Log the alert
	sa.logger.Warn("Security alert",
		zap.String("alert_id", alert.ID),
		zap.String("type", string(alert.Type)),
		zap.String("severity", string(alert.Severity)),
		zap.String("title", alert.Title),
		zap.String("ip", alert.IPAddress),
		zap.String("user", alert.UserID),
	)
	
	// Execute actions
	for _, action := range alert.Actions {
		switch action {
		case "block_ip":
			// Would integrate with DDoS protection to block IP
		case "notify_admin":
			// Would send notification to admin
		case "increase_monitoring":
			// Would increase monitoring level
		}
	}
}

func (sa *SecurityAudit) anomalyDetector() {
	defer sa.wg.Done()
	
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			sa.detectAnomalies()
			
		case <-sa.ctx.Done():
			return
		}
	}
}

func (sa *SecurityAudit) detectAnomalies() {
	// This would implement various anomaly detection algorithms
	// For now, just check basic patterns
	
	sa.statsMu.RLock()
	defer sa.statsMu.RUnlock()
	
	// Check for unusual spike in events
	if sa.stats.EventsLastHour > sa.stats.EventsLastDay/24*3 {
		alert := SecurityAlert{
			ID:          generateAlertID(),
			Timestamp:   time.Now(),
			Type:        AlertTypeAnomalous,
			Severity:    SeverityWarning,
			Title:       "Unusual Activity Spike",
			Description: "Detected 3x normal activity in the last hour",
			Source:      "anomaly_detector",
		}
		
		select {
		case sa.alerts <- alert:
		default:
		}
	}
}

func (sa *SecurityAudit) persistLogs() {
	// This would implement log persistence to disk
	// For now, just log the action
	sa.logger.Info("Persisting audit logs",
		zap.Int("count", len(sa.logs)),
		zap.String("path", sa.config.LogPath),
	)
}

// Helper types

// AuditFilter provides filtering options for audit logs
type AuditFilter struct {
	EventType  AuditEventType
	Severity   AuditSeverity
	UserID     string
	IPAddress  string
	StartTime  time.Time
	EndTime    time.Time
}

// Helper functions

func generateAuditID() string {
	return fmt.Sprintf("audit_%d", time.Now().UnixNano())
}

func generateAlertID() string {
	return fmt.Sprintf("alert_%d", time.Now().UnixNano())
}