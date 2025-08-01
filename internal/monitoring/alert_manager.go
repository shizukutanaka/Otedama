package monitoring

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/smtp"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// AlertManager handles monitoring alerts and notifications
type AlertManager struct {
	logger   *zap.Logger
	config   AlertConfig
	
	// Alert rules
	rules    map[string]*AlertRule
	rulesMu  sync.RWMutex
	
	// Active alerts
	alerts   map[string]*Alert
	alertsMu sync.RWMutex
	
	// Notification channels
	notifiers []Notifier
	
	// Metrics provider
	metricProvider MetricProvider
	
	// Metrics
	alertsTriggered atomic.Uint64
	alertsSent      atomic.Uint64
	
	// Context
	ctx      context.Context
	cancel   context.CancelFunc
	wg       sync.WaitGroup
}

// AlertConfig configures the alert manager
type AlertConfig struct {
	// Alert evaluation
	EvaluationInterval time.Duration `yaml:"evaluation_interval"`
	
	// Notification settings
	NotificationChannels []NotificationChannel `yaml:"notification_channels"`
	
	// Global settings
	RepeatInterval      time.Duration `yaml:"repeat_interval"`    // How often to repeat alerts
	GroupWait           time.Duration `yaml:"group_wait"`        // Wait time before sending grouped alerts
	GroupInterval       time.Duration `yaml:"group_interval"`     // How long to wait for grouping
	
	// SMTP settings (for email)
	SMTPHost            string        `yaml:"smtp_host"`
	SMTPPort            int           `yaml:"smtp_port"`
	SMTPUsername        string        `yaml:"smtp_username"`
	SMTPPassword        string        `yaml:"smtp_password"`
	SMTPFrom            string        `yaml:"smtp_from"`
	
	// Webhook settings
	WebhookURL          string        `yaml:"webhook_url"`
	WebhookToken        string        `yaml:"webhook_token"`
	
	// Telegram settings
	TelegramBotToken    string        `yaml:"telegram_bot_token"`
	TelegramChatID      string        `yaml:"telegram_chat_id"`
}

// NotificationChannel defines a notification channel
type NotificationChannel struct {
	Name     string            `yaml:"name"`
	Type     string            `yaml:"type"` // email, webhook, telegram, discord
	Enabled  bool              `yaml:"enabled"`
	Config   map[string]string `yaml:"config"`
}

// AlertRule defines conditions for triggering alerts
type AlertRule struct {
	Name        string            `yaml:"name"`
	Enabled     bool              `yaml:"enabled"`
	
	// Conditions
	Metric      string            `yaml:"metric"`
	Operator    string            `yaml:"operator"` // >, <, ==, !=, >=, <=
	Threshold   float64           `yaml:"threshold"`
	Duration    time.Duration     `yaml:"duration"` // How long condition must be true
	
	// Alert details
	Severity    AlertSeverity     `yaml:"severity"`
	Description string            `yaml:"description"`
	Labels      map[string]string `yaml:"labels"`
	Annotations map[string]string `yaml:"annotations"`
	
	// Notification settings
	Channels    []string          `yaml:"channels"` // Specific channels for this rule
	Throttle    time.Duration     `yaml:"throttle"` // Minimum time between alerts
	
	// State
	lastTriggered time.Time
	conditionMet  time.Time
}

// Alert represents an active alert
type Alert struct {
	ID          string
	Rule        *AlertRule
	
	// Alert data
	Value       float64
	Timestamp   time.Time
	
	// State
	State       AlertState
	Since       time.Time
	LastSent    time.Time
	SendCount   int
	
	// Resolution
	ResolvedAt  *time.Time
	ResolvedBy  string
}

// Common metrics for alerts
const (
	MetricHashrate      = "hashrate"
	MetricTemperature   = "temperature"
	MetricPower         = "power"
	MetricSharesRejected = "shares_rejected"
	MetricErrors        = "errors"
	MetricMemoryUsage   = "memory_usage"
	MetricPoolConnection = "pool_connection"
)

// AlertSeverity represents alert severity levels
type AlertSeverity int

const (
	SeverityInfo AlertSeverity = iota
	SeverityWarning
	SeverityCritical
	SeverityEmergency
)

// AlertState represents the state of an alert
type AlertState int

const (
	AlertStatePending AlertState = iota
	AlertStateFiring
	AlertStateResolved
)

// Notifier interface for sending notifications
type Notifier interface {
	Send(alert *Alert) error
	Name() string
}

// MetricProvider provides metrics for alert evaluation
type MetricProvider interface {
	GetMetric(name string) (float64, error)
	GetMetrics() map[string]float64
}

// NewAlertManager creates a new alert manager
func NewAlertManager(logger *zap.Logger, config AlertConfig, provider MetricProvider) *AlertManager {
	ctx, cancel := context.WithCancel(context.Background())
	
	am := &AlertManager{
		logger:    logger,
		config:    config,
		rules:     make(map[string]*AlertRule),
		alerts:    make(map[string]*Alert),
		notifiers: make([]Notifier, 0),
		ctx:       ctx,
		cancel:    cancel,
	}
	
	// Initialize notifiers
	am.initializeNotifiers()
	
	// Set up metric provider
	am.metricProvider = provider
	
	return am
}

// Start begins alert monitoring
func (am *AlertManager) Start() error {
	am.logger.Info("Starting alert manager",
		zap.Duration("evaluation_interval", am.config.EvaluationInterval),
		zap.Int("rules", len(am.rules)),
		zap.Int("notifiers", len(am.notifiers)),
	)
	
	// Start evaluation loop
	am.wg.Add(1)
	go am.evaluationLoop()
	
	// Start notification loop
	am.wg.Add(1)
	go am.notificationLoop()
	
	return nil
}

// Stop stops alert monitoring
func (am *AlertManager) Stop() error {
	am.logger.Info("Stopping alert manager")
	
	am.cancel()
	am.wg.Wait()
	
	return nil
}

// AddRule adds an alert rule
func (am *AlertManager) AddRule(rule *AlertRule) error {
	if rule.Name == "" {
		return fmt.Errorf("rule name cannot be empty")
	}
	
	am.rulesMu.Lock()
	defer am.rulesMu.Unlock()
	
	am.rules[rule.Name] = rule
	
	am.logger.Info("Added alert rule",
		zap.String("name", rule.Name),
		zap.String("metric", rule.Metric),
		zap.String("severity", am.severityString(rule.Severity)),
	)
	
	return nil
}

// RemoveRule removes an alert rule
func (am *AlertManager) RemoveRule(name string) error {
	am.rulesMu.Lock()
	defer am.rulesMu.Unlock()
	
	delete(am.rules, name)
	
	// Also remove any active alerts for this rule
	am.alertsMu.Lock()
	for id, alert := range am.alerts {
		if alert.Rule.Name == name {
			delete(am.alerts, id)
		}
	}
	am.alertsMu.Unlock()
	
	return nil
}

// GetRules returns all alert rules
func (am *AlertManager) GetRules() map[string]*AlertRule {
	am.rulesMu.RLock()
	defer am.rulesMu.RUnlock()
	
	rules := make(map[string]*AlertRule)
	for k, v := range am.rules {
		rules[k] = v
	}
	
	return rules
}

// GetAlerts returns active alerts
func (am *AlertManager) GetAlerts(state ...AlertState) []*Alert {
	am.alertsMu.RLock()
	defer am.alertsMu.RUnlock()
	
	alerts := make([]*Alert, 0)
	
	for _, alert := range am.alerts {
		if len(state) == 0 || am.containsState(state, alert.State) {
			alerts = append(alerts, alert)
		}
	}
	
	return alerts
}

// AcknowledgeAlert acknowledges an alert
func (am *AlertManager) AcknowledgeAlert(alertID string) error {
	am.alertsMu.Lock()
	defer am.alertsMu.Unlock()
	
	alert, exists := am.alerts[alertID]
	if !exists {
		return fmt.Errorf("alert not found: %s", alertID)
	}
	
	now := time.Now()
	alert.ResolvedAt = &now
	alert.State = AlertStateResolved
	
	return nil
}

// evaluationLoop evaluates alert rules
func (am *AlertManager) evaluationLoop() {
	defer am.wg.Done()
	
	ticker := time.NewTicker(am.config.EvaluationInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-am.ctx.Done():
			return
		case <-ticker.C:
			am.evaluateRules()
		}
	}
}

// evaluateRules evaluates all alert rules
func (am *AlertManager) evaluateRules() {
	metrics := am.metricProvider.GetMetrics()
	
	am.rulesMu.RLock()
	rules := make([]*AlertRule, 0, len(am.rules))
	for _, rule := range am.rules {
		if rule.Enabled {
			rules = append(rules, rule)
		}
	}
	am.rulesMu.RUnlock()
	
	for _, rule := range rules {
		am.evaluateRule(rule, metrics)
	}
}

// evaluateRule evaluates a single alert rule
func (am *AlertManager) evaluateRule(rule *AlertRule, metrics map[string]float64) {
	value, exists := metrics[rule.Metric]
	if !exists {
		am.logger.Warn("Metric not found for rule",
			zap.String("rule", rule.Name),
			zap.String("metric", rule.Metric),
		)
		return
	}
	
	// Check condition
	conditionMet := am.checkCondition(value, rule.Operator, rule.Threshold)
	
	// Get or create alert
	alertID := fmt.Sprintf("%s_%s", rule.Name, rule.Metric)
	
	am.alertsMu.Lock()
	alert, exists := am.alerts[alertID]
	
	if conditionMet {
		if !exists {
			// New alert
			alert = &Alert{
				ID:        alertID,
				Rule:      rule,
				Value:     value,
				Timestamp: time.Now(),
				State:     AlertStatePending,
				Since:     time.Now(),
			}
			am.alerts[alertID] = alert
		} else {
			// Update existing alert
			alert.Value = value
			alert.Timestamp = time.Now()
		}
		
		// Check duration requirement
		if time.Since(alert.Since) >= rule.Duration {
			if alert.State == AlertStatePending {
				alert.State = AlertStateFiring
				am.alertsTriggered.Add(1)
			}
		}
	} else {
		// Condition not met
		if exists && alert.State != AlertStateResolved {
			// Resolve alert
			now := time.Now()
			alert.ResolvedAt = &now
			alert.State = AlertStateResolved
		}
	}
	
	am.alertsMu.Unlock()
}

// checkCondition checks if a condition is met
func (am *AlertManager) checkCondition(value float64, operator string, threshold float64) bool {
	switch operator {
	case ">":
		return value > threshold
	case "<":
		return value < threshold
	case ">=":
		return value >= threshold
	case "<=":
		return value <= threshold
	case "==":
		return value == threshold
	case "!=":
		return value != threshold
	default:
		am.logger.Warn("Unknown operator", zap.String("operator", operator))
		return false
	}
}

// notificationLoop handles sending notifications
func (am *AlertManager) notificationLoop() {
	defer am.wg.Done()
	
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-am.ctx.Done():
			return
		case <-ticker.C:
			am.sendPendingNotifications()
		}
	}
}

// sendPendingNotifications sends notifications for firing alerts
func (am *AlertManager) sendPendingNotifications() {
	am.alertsMu.RLock()
	alerts := make([]*Alert, 0)
	for _, alert := range am.alerts {
		if alert.State == AlertStateFiring {
			// Check throttling
			if time.Since(alert.LastSent) >= alert.Rule.Throttle {
				alerts = append(alerts, alert)
			}
		}
	}
	am.alertsMu.RUnlock()
	
	// Group alerts if configured
	if am.config.GroupWait > 0 {
		am.sendGroupedAlerts(alerts)
	} else {
		// Send individual alerts
		for _, alert := range alerts {
			am.sendAlert(alert)
		}
	}
}

// sendAlert sends a single alert
func (am *AlertManager) sendAlert(alert *Alert) {
	// Select notifiers
	notifiers := am.selectNotifiers(alert)
	
	for _, notifier := range notifiers {
		if err := notifier.Send(alert); err != nil {
			am.logger.Error("Failed to send alert",
				zap.String("alert", alert.ID),
				zap.String("notifier", notifier.Name()),
				zap.Error(err),
			)
		} else {
			am.alertsSent.Add(1)
		}
	}
	
	// Update alert state
	am.alertsMu.Lock()
	alert.LastSent = time.Now()
	alert.SendCount++
	am.alertsMu.Unlock()
}

// sendGroupedAlerts sends alerts in groups
func (am *AlertManager) sendGroupedAlerts(alerts []*Alert) {
	// Group by severity
	groups := make(map[AlertSeverity][]*Alert)
	for _, alert := range alerts {
		groups[alert.Rule.Severity] = append(groups[alert.Rule.Severity], alert)
	}
	
	// Send each group
	for severity, group := range groups {
		if len(group) > 0 {
			am.logger.Info("Sending grouped alerts",
				zap.String("severity", am.severityString(severity)),
				zap.Int("count", len(group)),
			)
			
			// Send as batch to each notifier
			for _, notifier := range am.notifiers {
				if batchNotifier, ok := notifier.(BatchNotifier); ok {
					if err := batchNotifier.SendBatch(group); err != nil {
						am.logger.Error("Failed to send batch alerts",
							zap.String("notifier", notifier.Name()),
							zap.Error(err),
						)
					}
				} else {
					// Send individually
					for _, alert := range group {
						if err := notifier.Send(alert); err != nil {
							am.logger.Error("Failed to send alert",
								zap.String("alert", alert.ID),
								zap.String("notifier", notifier.Name()),
								zap.Error(err),
							)
						}
					}
				}
			}
		}
	}
}

// selectNotifiers selects appropriate notifiers for an alert
func (am *AlertManager) selectNotifiers(alert *Alert) []Notifier {
	if len(alert.Rule.Channels) > 0 {
		// Use specific channels
		notifiers := make([]Notifier, 0)
		for _, channel := range alert.Rule.Channels {
			for _, notifier := range am.notifiers {
				if notifier.Name() == channel {
					notifiers = append(notifiers, notifier)
				}
			}
		}
		return notifiers
	}
	
	// Use all notifiers
	return am.notifiers
}

// initializeNotifiers sets up notification channels
func (am *AlertManager) initializeNotifiers() {
	for _, channel := range am.config.NotificationChannels {
		if !channel.Enabled {
			continue
		}
		
		switch channel.Type {
		case "email":
			notifier := NewEmailNotifier(am.logger, EmailConfig{
				Host:     am.config.SMTPHost,
				Port:     am.config.SMTPPort,
				Username: am.config.SMTPUsername,
				Password: am.config.SMTPPassword,
				From:     am.config.SMTPFrom,
				To:       channel.Config["to"],
			})
			am.notifiers = append(am.notifiers, notifier)
			
		case "webhook":
			notifier := NewWebhookNotifier(am.logger, WebhookConfig{
				URL:   channel.Config["url"],
				Token: channel.Config["token"],
			})
			am.notifiers = append(am.notifiers, notifier)
			
		case "telegram":
			notifier := NewTelegramNotifier(am.logger, TelegramConfig{
				BotToken: channel.Config["bot_token"],
				ChatID:   channel.Config["chat_id"],
			})
			am.notifiers = append(am.notifiers, notifier)
			
		default:
			am.logger.Warn("Unknown notification channel type",
				zap.String("type", channel.Type),
			)
		}
	}
}

// Helper methods

func (am *AlertManager) severityString(severity AlertSeverity) string {
	switch severity {
	case SeverityInfo:
		return "info"
	case SeverityWarning:
		return "warning"
	case SeverityCritical:
		return "critical"
	case SeverityEmergency:
		return "emergency"
	default:
		return "unknown"
	}
}

func (am *AlertManager) containsState(states []AlertState, state AlertState) bool {
	for _, s := range states {
		if s == state {
			return true
		}
	}
	return false
}

// Notifier implementations

// EmailNotifier sends alerts via email
type EmailNotifier struct {
	logger *zap.Logger
	config EmailConfig
}

type EmailConfig struct {
	Host     string
	Port     int
	Username string
	Password string
	From     string
	To       string
}

func NewEmailNotifier(logger *zap.Logger, config EmailConfig) *EmailNotifier {
	return &EmailNotifier{
		logger: logger,
		config: config,
	}
}

func (n *EmailNotifier) Send(alert *Alert) error {
	subject := fmt.Sprintf("[%s] %s", n.severityString(alert.Rule.Severity), alert.Rule.Name)
	body := fmt.Sprintf(
		"Alert: %s\nMetric: %s\nValue: %.2f\nThreshold: %.2f\nDescription: %s\nTime: %s",
		alert.Rule.Name,
		alert.Rule.Metric,
		alert.Value,
		alert.Rule.Threshold,
		alert.Rule.Description,
		alert.Timestamp.Format(time.RFC3339),
	)
	
	// Send email
	auth := smtp.PlainAuth("", n.config.Username, n.config.Password, n.config.Host)
	to := []string{n.config.To}
	msg := []byte(fmt.Sprintf("To: %s\r\nSubject: %s\r\n\r\n%s", n.config.To, subject, body))
	
	addr := fmt.Sprintf("%s:%d", n.config.Host, n.config.Port)
	return smtp.SendMail(addr, auth, n.config.From, to, msg)
}

func (n *EmailNotifier) Name() string {
	return "email"
}

func (n *EmailNotifier) severityString(severity AlertSeverity) string {
	switch severity {
	case SeverityInfo:
		return "INFO"
	case SeverityWarning:
		return "WARNING"
	case SeverityCritical:
		return "CRITICAL"
	case SeverityEmergency:
		return "EMERGENCY"
	default:
		return "UNKNOWN"
	}
}

// WebhookNotifier sends alerts via webhook
type WebhookNotifier struct {
	logger *zap.Logger
	config WebhookConfig
	client *http.Client
}

type WebhookConfig struct {
	URL   string
	Token string
}

func NewWebhookNotifier(logger *zap.Logger, config WebhookConfig) *WebhookNotifier {
	return &WebhookNotifier{
		logger: logger,
		config: config,
		client: &http.Client{Timeout: 10 * time.Second},
	}
}

func (n *WebhookNotifier) Send(alert *Alert) error {
	payload := map[string]interface{}{
		"alert_id":    alert.ID,
		"rule_name":   alert.Rule.Name,
		"metric":      alert.Rule.Metric,
		"value":       alert.Value,
		"threshold":   alert.Rule.Threshold,
		"severity":    alert.Rule.Severity,
		"description": alert.Rule.Description,
		"timestamp":   alert.Timestamp,
		"labels":      alert.Rule.Labels,
		"annotations": alert.Rule.Annotations,
	}
	
	data, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal payload: %w", err)
	}
	
	req, err := http.NewRequest("POST", n.config.URL, bytes.NewBuffer(data))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	
	req.Header.Set("Content-Type", "application/json")
	if n.config.Token != "" {
		req.Header.Set("Authorization", "Bearer "+n.config.Token)
	}
	
	resp, err := n.client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send webhook: %w", err)
	}
	defer resp.Body.Close()
	
	if resp.StatusCode >= 400 {
		return fmt.Errorf("webhook returned status %d", resp.StatusCode)
	}
	
	return nil
}

func (n *WebhookNotifier) Name() string {
	return "webhook"
}

// TelegramNotifier sends alerts via Telegram
type TelegramNotifier struct {
	logger *zap.Logger
	config TelegramConfig
	client *http.Client
}

type TelegramConfig struct {
	BotToken string
	ChatID   string
}

func NewTelegramNotifier(logger *zap.Logger, config TelegramConfig) *TelegramNotifier {
	return &TelegramNotifier{
		logger: logger,
		config: config,
		client: &http.Client{Timeout: 10 * time.Second},
	}
}

func (n *TelegramNotifier) Send(alert *Alert) error {
	// Format message
	severity := n.severityEmoji(alert.Rule.Severity)
	message := fmt.Sprintf(
		"%s *%s*\n\n*Metric:* %s\n*Value:* %.2f\n*Threshold:* %.2f\n*Description:* %s\n*Time:* %s",
		severity,
		alert.Rule.Name,
		alert.Rule.Metric,
		alert.Value,
		alert.Rule.Threshold,
		alert.Rule.Description,
		alert.Timestamp.Format("15:04:05"),
	)
	
	// Send to Telegram API
	url := fmt.Sprintf("https://api.telegram.org/bot%s/sendMessage", n.config.BotToken)
	
	payload := map[string]interface{}{
		"chat_id":    n.config.ChatID,
		"text":       message,
		"parse_mode": "Markdown",
	}
	
	data, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal payload: %w", err)
	}
	
	resp, err := n.client.Post(url, "application/json", bytes.NewBuffer(data))
	if err != nil {
		return fmt.Errorf("failed to send telegram message: %w", err)
	}
	defer resp.Body.Close()
	
	if resp.StatusCode >= 400 {
		return fmt.Errorf("telegram API returned status %d", resp.StatusCode)
	}
	
	return nil
}

func (n *TelegramNotifier) Name() string {
	return "telegram"
}

func (n *TelegramNotifier) severityEmoji(severity AlertSeverity) string {
	switch severity {
	case SeverityInfo:
		return "ℹ️"
	case SeverityWarning:
		return "⚠️"
	case SeverityCritical:
		return "🚨"
	case SeverityEmergency:
		return "🆘"
	default:
		return "❓"
	}
}

// BatchNotifier interface for notifiers that support batch sending
type BatchNotifier interface {
	Notifier
	SendBatch(alerts []*Alert) error
}

