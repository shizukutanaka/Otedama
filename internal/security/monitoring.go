package security

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// SecurityMonitor monitors security events and triggers alerts
type SecurityMonitor struct {
	logger    *zap.Logger
	alerters  []SecurityAlerter
	rules     []SecurityRule
	metrics   *SecurityMetrics
	events    chan SecurityEvent
	ctx       context.Context
	cancel    context.CancelFunc
	wg        sync.WaitGroup
}

// SecurityEvent represents a security event
type SecurityEvent struct {
	Type        SecurityEventType     `json:"type"`
	Severity    SeveritLevel         `json:"severity"`
	Source      string               `json:"source"`
	UserID      string               `json:"user_id,omitempty"`
	IPAddress   string               `json:"ip_address,omitempty"`
	UserAgent   string               `json:"user_agent,omitempty"`
	Message     string               `json:"message"`
	Metadata    map[string]interface{} `json:"metadata,omitempty"`
	Timestamp   time.Time            `json:"timestamp"`
}

// SecurityEventType defines types of security events
type SecurityEventType string

const (
	EventAuthenticationFailure SecurityEventType = "authentication_failure"
	EventAuthenticationSuccess SecurityEventType = "authentication_success"
	EventAuthorizationFailure  SecurityEventType = "authorization_failure"
	EventSuspiciousActivity    SecurityEventType = "suspicious_activity"
	EventBruteForceAttempt     SecurityEventType = "brute_force_attempt"
	EventSQLInjectionAttempt   SecurityEventType = "sql_injection_attempt"
	EventXSSAttempt           SecurityEventType = "xss_attempt"
	EventPathTraversalAttempt  SecurityEventType = "path_traversal_attempt"
	EventRateLimitExceeded     SecurityEventType = "rate_limit_exceeded"
	EventSessionAnomalies      SecurityEventType = "session_anomalies"
	EventPrivilegeEscalation   SecurityEventType = "privilege_escalation"
	EventDataBreach           SecurityEventType = "data_breach"
	EventSystemIntrusion      SecurityEventType = "system_intrusion"
)

// SeveritLevel defines severity levels
type SeveritLevel string

const (
	SeverityLow      SeveritLevel = "low"
	SeverityMedium   SeveritLevel = "medium"
	SeverityHigh     SeveritLevel = "high"
	SeverityCritical SeveritLevel = "critical"
)

// SecurityRule defines when to trigger alerts
type SecurityRule struct {
	ID              string                `json:"id"`
	Name            string                `json:"name"`
	EventTypes      []SecurityEventType   `json:"event_types"`
	MinSeverity     SeveritLevel         `json:"min_severity"`
	ThresholdCount  int                  `json:"threshold_count"`
	TimeWindow      time.Duration        `json:"time_window"`
	Conditions      []RuleCondition      `json:"conditions"`
	Actions         []RuleAction         `json:"actions"`
	Enabled         bool                 `json:"enabled"`
}

// RuleCondition defines conditions for rule activation
type RuleCondition struct {
	Field    string      `json:"field"`
	Operator string      `json:"operator"` // "equals", "contains", "matches", "greater_than", etc.
	Value    interface{} `json:"value"`
}

// RuleAction defines actions to take when rule triggers
type RuleAction struct {
	Type   string                 `json:"type"` // "alert", "block", "log", "email", "webhook"
	Config map[string]interface{} `json:"config"`
}

// SecurityMetrics tracks security-related metrics
type SecurityMetrics struct {
	// Authentication metrics
	AuthenticationAttempts   atomic.Uint64 `json:"authentication_attempts"`
	AuthenticationFailures   atomic.Uint64 `json:"authentication_failures"`
	AuthenticationSuccesses  atomic.Uint64 `json:"authentication_successes"`
	
	// Attack metrics
	SQLInjectionAttempts     atomic.Uint64 `json:"sql_injection_attempts"`
	XSSAttempts             atomic.Uint64 `json:"xss_attempts"`
	PathTraversalAttempts   atomic.Uint64 `json:"path_traversal_attempts"`
	BruteForceAttempts      atomic.Uint64 `json:"brute_force_attempts"`
	
	// System metrics
	BlockedIPs              atomic.Uint64 `json:"blocked_ips"`
	SuspiciousActivities    atomic.Uint64 `json:"suspicious_activities"`
	PrivilegeEscalations    atomic.Uint64 `json:"privilege_escalations"`
	
	// Timing metrics
	LastIncident            time.Time     `json:"last_incident"`
	LastSecurityScan        time.Time     `json:"last_security_scan"`
	
	mu sync.RWMutex
}

// SecurityAlerter interface for sending security alerts
type SecurityAlerter interface {
	SendAlert(event SecurityEvent, rule SecurityRule) error
	Name() string
}

// NewSecurityMonitor creates a new security monitor
func NewSecurityMonitor(logger *zap.Logger) *SecurityMonitor {
	ctx, cancel := context.WithCancel(context.Background())
	
	return &SecurityMonitor{
		logger:   logger,
		alerters: make([]SecurityAlerter, 0),
		rules:    make([]SecurityRule, 0),
		metrics:  &SecurityMetrics{},
		events:   make(chan SecurityEvent, 1000),
		ctx:      ctx,
		cancel:   cancel,
	}
}

// AddAlerter adds a security alerter
func (sm *SecurityMonitor) AddAlerter(alerter SecurityAlerter) {
	sm.alerters = append(sm.alerters, alerter)
}

// AddRule adds a security monitoring rule
func (sm *SecurityMonitor) AddRule(rule SecurityRule) {
	sm.rules = append(sm.rules, rule)
}

// Start starts the security monitor
func (sm *SecurityMonitor) Start() {
	sm.wg.Add(1)
	go sm.processEvents()
	
	sm.wg.Add(1)
	go sm.periodicTasks()
}

// Stop stops the security monitor
func (sm *SecurityMonitor) Stop() {
	sm.cancel()
	close(sm.events)
	sm.wg.Wait()
}

// RecordEvent records a security event
func (sm *SecurityMonitor) RecordEvent(event SecurityEvent) {
	event.Timestamp = time.Now()
	
	select {
	case sm.events <- event:
		// Event queued successfully
	default:
		// Event queue full, log warning
		sm.logger.Warn("Security event queue full, dropping event",
			zap.String("event_type", string(event.Type)),
			zap.String("severity", string(event.Severity)))
	}
}

// processEvents processes security events
func (sm *SecurityMonitor) processEvents() {
	defer sm.wg.Done()
	
	eventBuffer := make([]SecurityEvent, 0, 100)
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case event, ok := <-sm.events:
			if !ok {
				// Channel closed, process remaining events
				sm.processEventBatch(eventBuffer)
				return
			}
			
			// Update metrics
			sm.updateMetrics(event)
			
			// Add to buffer
			eventBuffer = append(eventBuffer, event)
			
			// Process buffer if full
			if len(eventBuffer) >= 100 {
				sm.processEventBatch(eventBuffer)
				eventBuffer = eventBuffer[:0]
			}
			
		case <-ticker.C:
			// Process buffer periodically
			if len(eventBuffer) > 0 {
				sm.processEventBatch(eventBuffer)
				eventBuffer = eventBuffer[:0]
			}
			
		case <-sm.ctx.Done():
			return
		}
	}
}

// processEventBatch processes a batch of events
func (sm *SecurityMonitor) processEventBatch(events []SecurityEvent) {
	for _, event := range events {
		sm.evaluateRules(event)
	}
}

// evaluateRules evaluates security rules against an event
func (sm *SecurityMonitor) evaluateRules(event SecurityEvent) {
	for _, rule := range sm.rules {
		if !rule.Enabled {
			continue
		}
		
		if sm.ruleMatches(rule, event) {
			sm.triggerRule(rule, event)
		}
	}
}

// ruleMatches checks if a rule matches an event
func (sm *SecurityMonitor) ruleMatches(rule SecurityRule, event SecurityEvent) bool {
	// Check event type
	eventTypeMatches := false
	for _, eventType := range rule.EventTypes {
		if eventType == event.Type {
			eventTypeMatches = true
			break
		}
	}
	
	if !eventTypeMatches {
		return false
	}
	
	// Check severity
	if !sm.severityMeetsThreshold(event.Severity, rule.MinSeverity) {
		return false
	}
	
	// Check conditions
	for _, condition := range rule.Conditions {
		if !sm.evaluateCondition(condition, event) {
			return false
		}
	}
	
	return true
}

// triggerRule triggers actions for a matched rule
func (sm *SecurityMonitor) triggerRule(rule SecurityRule, event SecurityEvent) {
	sm.logger.Warn("Security rule triggered",
		zap.String("rule_id", rule.ID),
		zap.String("rule_name", rule.Name),
		zap.String("event_type", string(event.Type)),
		zap.String("severity", string(event.Severity)))
	
	for _, action := range rule.Actions {
		sm.executeAction(action, event, rule)
	}
	
	// Send alerts
	for _, alerter := range sm.alerters {
		if err := alerter.SendAlert(event, rule); err != nil {
			sm.logger.Error("Failed to send security alert",
				zap.String("alerter", alerter.Name()),
				zap.Error(err))
		}
	}
}

// executeAction executes a rule action
func (sm *SecurityMonitor) executeAction(action RuleAction, event SecurityEvent, rule SecurityRule) {
	switch action.Type {
	case "log":
		sm.logger.Error("Security incident",
			zap.String("rule", rule.Name),
			zap.String("event_type", string(event.Type)),
			zap.String("severity", string(event.Severity)),
			zap.String("source", event.Source),
			zap.String("user_id", event.UserID),
			zap.String("ip_address", event.IPAddress),
			zap.String("message", event.Message))
		
	case "block":
		// Implement IP blocking logic
		sm.logger.Info("Blocking IP address due to security rule",
			zap.String("ip_address", event.IPAddress),
			zap.String("rule", rule.Name))
		
	case "alert":
		// Additional alerting logic
		sm.logger.Error("SECURITY ALERT",
			zap.String("rule", rule.Name),
			zap.Any("event", event))
	}
}

// updateMetrics updates security metrics
func (sm *SecurityMonitor) updateMetrics(event SecurityEvent) {
	switch event.Type {
	case EventAuthenticationFailure:
		sm.metrics.AuthenticationAttempts.Add(1)
		sm.metrics.AuthenticationFailures.Add(1)
	case EventAuthenticationSuccess:
		sm.metrics.AuthenticationAttempts.Add(1)
		sm.metrics.AuthenticationSuccesses.Add(1)
	case EventSQLInjectionAttempt:
		sm.metrics.SQLInjectionAttempts.Add(1)
	case EventXSSAttempt:
		sm.metrics.XSSAttempts.Add(1)
	case EventPathTraversalAttempt:
		sm.metrics.PathTraversalAttempts.Add(1)
	case EventBruteForceAttempt:
		sm.metrics.BruteForceAttempts.Add(1)
	case EventSuspiciousActivity:
		sm.metrics.SuspiciousActivities.Add(1)
	case EventPrivilegeEscalation:
		sm.metrics.PrivilegeEscalations.Add(1)
	}
	
	// Update last incident time for critical events
	if event.Severity == SeverityCritical || event.Severity == SeverityHigh {
		sm.metrics.mu.Lock()
		sm.metrics.LastIncident = event.Timestamp
		sm.metrics.mu.Unlock()
	}
}

// periodicTasks runs periodic security tasks
func (sm *SecurityMonitor) periodicTasks() {
	defer sm.wg.Done()
	
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			sm.performSecurityScan()
		case <-sm.ctx.Done():
			return
		}
	}
}

// performSecurityScan performs periodic security scans
func (sm *SecurityMonitor) performSecurityScan() {
	sm.metrics.mu.Lock()
	sm.metrics.LastSecurityScan = time.Now()
	sm.metrics.mu.Unlock()
	
	sm.logger.Info("Performing security scan")
	
	// Generate security report event
	event := SecurityEvent{
		Type:      "security_scan",
		Severity:  SeverityLow,
		Source:    "security_monitor",
		Message:   "Periodic security scan completed",
		Timestamp: time.Now(),
		Metadata: map[string]interface{}{
			"scan_type": "periodic",
		},
	}
	
	sm.RecordEvent(event)
}

// GetMetrics returns current security metrics
func (sm *SecurityMonitor) GetMetrics() *SecurityMetrics {
	return sm.metrics
}

// GetMetricsSnapshot returns a snapshot of security metrics
func (sm *SecurityMonitor) GetMetricsSnapshot() map[string]interface{} {
	sm.metrics.mu.RLock()
	defer sm.metrics.mu.RUnlock()
	
	return map[string]interface{}{
		"authentication_attempts":   sm.metrics.AuthenticationAttempts.Load(),
		"authentication_failures":  sm.metrics.AuthenticationFailures.Load(),
		"authentication_successes": sm.metrics.AuthenticationSuccesses.Load(),
		"sql_injection_attempts":   sm.metrics.SQLInjectionAttempts.Load(),
		"xss_attempts":             sm.metrics.XSSAttempts.Load(),
		"path_traversal_attempts":  sm.metrics.PathTraversalAttempts.Load(),
		"brute_force_attempts":     sm.metrics.BruteForceAttempts.Load(),
		"blocked_ips":              sm.metrics.BlockedIPs.Load(),
		"suspicious_activities":    sm.metrics.SuspiciousActivities.Load(),
		"privilege_escalations":    sm.metrics.PrivilegeEscalations.Load(),
		"last_incident":            sm.metrics.LastIncident,
		"last_security_scan":       sm.metrics.LastSecurityScan,
	}
}

// Helper methods

func (sm *SecurityMonitor) severityMeetsThreshold(eventSeverity, minSeverity SeveritLevel) bool {
	severityLevels := map[SeveritLevel]int{
		SeverityLow:      1,
		SeverityMedium:   2,
		SeverityHigh:     3,
		SeverityCritical: 4,
	}
	
	return severityLevels[eventSeverity] >= severityLevels[minSeverity]
}

func (sm *SecurityMonitor) evaluateCondition(condition RuleCondition, event SecurityEvent) bool {
	// Get field value from event
	var fieldValue interface{}
	switch condition.Field {
	case "user_id":
		fieldValue = event.UserID
	case "ip_address":
		fieldValue = event.IPAddress
	case "source":
		fieldValue = event.Source
	case "message":
		fieldValue = event.Message
	default:
		if event.Metadata != nil {
			fieldValue = event.Metadata[condition.Field]
		}
	}
	
	// Evaluate condition based on operator
	switch condition.Operator {
	case "equals":
		return fieldValue == condition.Value
	case "contains":
		if str, ok := fieldValue.(string); ok {
			if substr, ok := condition.Value.(string); ok {
				return strings.Contains(str, substr)
			}
		}
	case "matches":
		if str, ok := fieldValue.(string); ok {
			if pattern, ok := condition.Value.(string); ok {
				matched, _ := regexp.MatchString(pattern, str)
				return matched
			}
		}
	}
	
	return false
}

// EmailAlerter sends security alerts via email
type EmailAlerter struct {
	name string
	// Email configuration would go here
}

// NewEmailAlerter creates a new email alerter
func NewEmailAlerter() *EmailAlerter {
	return &EmailAlerter{name: "email"}
}

// SendAlert sends an email alert
func (ea *EmailAlerter) SendAlert(event SecurityEvent, rule SecurityRule) error {
	// Implement email sending logic
	fmt.Printf("EMAIL ALERT: %s - %s\n", rule.Name, event.Message)
	return nil
}

// Name returns the alerter name
func (ea *EmailAlerter) Name() string {
	return ea.name
}

// WebhookAlerter sends security alerts via webhook
type WebhookAlerter struct {
	name string
	url  string
}

// NewWebhookAlerter creates a new webhook alerter
func NewWebhookAlerter(url string) *WebhookAlerter {
	return &WebhookAlerter{
		name: "webhook",
		url:  url,
	}
}

// SendAlert sends a webhook alert
func (wa *WebhookAlerter) SendAlert(event SecurityEvent, rule SecurityRule) error {
	// Implement webhook sending logic
	fmt.Printf("WEBHOOK ALERT to %s: %s - %s\n", wa.url, rule.Name, event.Message)
	return nil
}

// Name returns the alerter name
func (wa *WebhookAlerter) Name() string {
	return wa.name
}

// DefaultSecurityRules returns a set of default security rules
func DefaultSecurityRules() []SecurityRule {
	return []SecurityRule{
		{
			ID:             "brute_force_detection",
			Name:           "Brute Force Attack Detection",
			EventTypes:     []SecurityEventType{EventAuthenticationFailure},
			MinSeverity:    SeverityMedium,
			ThresholdCount: 5,
			TimeWindow:     5 * time.Minute,
			Actions: []RuleAction{
				{Type: "log"},
				{Type: "alert"},
				{Type: "block"},
			},
			Enabled: true,
		},
		{
			ID:          "sql_injection_detection",
			Name:        "SQL Injection Detection",
			EventTypes:  []SecurityEventType{EventSQLInjectionAttempt},
			MinSeverity: SeverityHigh,
			Actions: []RuleAction{
				{Type: "log"},
				{Type: "alert"},
			},
			Enabled: true,
		},
		{
			ID:          "privilege_escalation_detection",
			Name:        "Privilege Escalation Detection",
			EventTypes:  []SecurityEventType{EventPrivilegeEscalation},
			MinSeverity: SeverityCritical,
			Actions: []RuleAction{
				{Type: "log"},
				{Type: "alert"},
				{Type: "block"},
			},
			Enabled: true,
		},
	}
}