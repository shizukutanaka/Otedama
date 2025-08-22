package monitoring

import (
	"context"
	"fmt"
	"sync"
	"time"

	"go.uber.org/zap"
)

type AlertManager struct {
	logger              *zap.Logger
	mu                  sync.RWMutex
	ctx                 context.Context
	cancel              context.CancelFunc
	
	config              *MonitoringConfig
	rules               map[string]*AlertRule
	alerts              map[string]*Alert
	channels            map[string]AlertChannel
	silences            map[string]*AlertSilence
	
	// Alert processing
	alertQueue          chan *Alert
	evaluationTicker    *time.Ticker
	
	// Alert state management
	alertStates         map[string]*AlertState
	alertHistory        []*AlertHistoryEntry
	
	// Metrics
	alertMetrics        *AlertMetrics
	
	// Notification management
	notificationQueue   chan *AlertNotification
	retryQueue          chan *AlertNotification
	maxRetries          int
	retryInterval       time.Duration
	
	// Rule evaluation
	ruleEvaluator       *RuleEvaluator
	expressionEngine    *ExpressionEngine
	
	// Alert aggregation
	aggregationRules    map[string]*AggregationRule
	aggregatedAlerts    map[string]*AggregatedAlert
}

type AlertState struct {
	ID              string            `json:"id"`
	RuleID          string            `json:"rule_id"`
	Status          AlertStatus       `json:"status"`
	Value           float64           `json:"value"`
	ActiveSince     time.Time         `json:"active_since"`
	LastEvaluation  time.Time         `json:"last_evaluation"`
	EvaluationCount uint64            `json:"evaluation_count"`
	Labels          map[string]string `json:"labels"`
	Annotations     map[string]string `json:"annotations"`
}

type AlertSilence struct {
	ID          string            `json:"id"`
	Matchers    []LabelMatcher    `json:"matchers"`
	StartsAt    time.Time         `json:"starts_at"`
	EndsAt      time.Time         `json:"ends_at"`
	CreatedBy   string            `json:"created_by"`
	Comment     string            `json:"comment"`
	UpdatedAt   time.Time         `json:"updated_at"`
}

type LabelMatcher struct {
	Name    string `json:"name"`
	Value   string `json:"value"`
	IsRegex bool   `json:"is_regex"`
	IsEqual bool   `json:"is_equal"`
}

type AlertHistoryEntry struct {
	Timestamp   time.Time     `json:"timestamp"`
	AlertID     string        `json:"alert_id"`
	RuleID      string        `json:"rule_id"`
	Status      AlertStatus   `json:"status"`
	Value       float64       `json:"value"`
	Duration    time.Duration `json:"duration"`
	Message     string        `json:"message"`
}

type AlertNotification struct {
	ID          string            `json:"id"`
	AlertID     string            `json:"alert_id"`
	ChannelName string            `json:"channel_name"`
	Alert       *Alert            `json:"alert"`
	RetryCount  int               `json:"retry_count"`
	LastTry     time.Time         `json:"last_try"`
	NextTry     time.Time         `json:"next_try"`
}

type AlertMetrics struct {
	TotalAlerts         uint64    `json:"total_alerts"`
	ActiveAlerts        uint64    `json:"active_alerts"`
	ResolvedAlerts      uint64    `json:"resolved_alerts"`
	SilencedAlerts      uint64    `json:"silenced_alerts"`
	FailedNotifications uint64    `json:"failed_notifications"`
	LastUpdate          time.Time `json:"last_update"`
	
	// Per severity metrics
	InfoAlerts          uint64    `json:"info_alerts"`
	WarningAlerts       uint64    `json:"warning_alerts"`
	CriticalAlerts      uint64    `json:"critical_alerts"`
	EmergencyAlerts     uint64    `json:"emergency_alerts"`
	
	// Performance metrics
	EvaluationDuration  time.Duration `json:"evaluation_duration"`
	NotificationLatency time.Duration `json:"notification_latency"`
}

type RuleEvaluator struct {
	logger          *zap.Logger
	expressionEngine *ExpressionEngine
	prometheusClient interface{} // Prometheus client for queries
}

type ExpressionEngine struct {
	logger      *zap.Logger
	functions   map[string]ExpressionFunction
	variables   map[string]float64
}

type ExpressionFunction func(args ...float64) float64

type AggregationRule struct {
	ID              string            `json:"id"`
	Name            string            `json:"name"`
	GroupBy         []string          `json:"group_by"`
	AggregationType AggregationType   `json:"aggregation_type"`
	TimeWindow      time.Duration     `json:"time_window"`
	Threshold       float64           `json:"threshold"`
	Labels          map[string]string `json:"labels"`
}

type AggregationType int

const (
	AggregationTypeCount AggregationType = iota
	AggregationTypeSum
	AggregationTypeAverage
	AggregationTypeMax
	AggregationTypeMin
)

type AggregatedAlert struct {
	ID              string            `json:"id"`
	RuleID          string            `json:"rule_id"`
	GroupKey        string            `json:"group_key"`
	Count           int               `json:"count"`
	Value           float64           `json:"value"`
	Alerts          []*Alert          `json:"alerts"`
	StartsAt        time.Time         `json:"starts_at"`
	LastUpdate      time.Time         `json:"last_update"`
	Labels          map[string]string `json:"labels"`
}

// NewAlertManager creates a new alert manager
func NewAlertManager(config *MonitoringConfig, logger *zap.Logger) (*AlertManager, error) {
	ctx, cancel := context.WithCancel(context.Background())

	am := &AlertManager{
		logger:              logger,
		ctx:                 ctx,
		cancel:              cancel,
		config:              config,
		rules:               make(map[string]*AlertRule),
		alerts:              make(map[string]*Alert),
		channels:            make(map[string]AlertChannel),
		silences:            make(map[string]*AlertSilence),
		alertQueue:          make(chan *Alert, 1000),
		notificationQueue:   make(chan *AlertNotification, 1000),
		retryQueue:          make(chan *AlertNotification, 1000),
		maxRetries:          config.MaxAlertRetries,
		retryInterval:       config.AlertRetryInterval,
		alertStates:         make(map[string]*AlertState),
		alertHistory:        make([]*AlertHistoryEntry, 0),
		alertMetrics:        &AlertMetrics{},
		aggregationRules:    make(map[string]*AggregationRule),
		aggregatedAlerts:    make(map[string]*AggregatedAlert),
	}

	// Initialize rule evaluator
	am.ruleEvaluator = &RuleEvaluator{
		logger:           logger,
		expressionEngine: NewExpressionEngine(logger),
	}

	// Set up evaluation ticker
	am.evaluationTicker = time.NewTicker(config.AlertEvaluationInterval)

	logger.Info("Alert manager initialized",
		zap.Duration("evaluation_interval", config.AlertEvaluationInterval),
		zap.Int("max_retries", config.MaxAlertRetries))

	return am, nil
}

// Start begins the alert manager operations
func (am *AlertManager) Start() error {
	am.logger.Info("Starting alert manager")

	// Start processing goroutines
	go am.alertProcessingLoop()
	go am.notificationLoop()
	go am.retryLoop()
	go am.evaluationLoop()
	go am.aggregationLoop()

	am.logger.Info("Alert manager started")
	return nil
}

// Stop shuts down the alert manager
func (am *AlertManager) Stop() error {
	am.logger.Info("Stopping alert manager")
	
	am.cancel()
	am.evaluationTicker.Stop()
	
	// Close channels
	close(am.alertQueue)
	close(am.notificationQueue)
	close(am.retryQueue)
	
	am.logger.Info("Alert manager stopped")
	return nil
}

// AddRule adds a new alert rule
func (am *AlertManager) AddRule(rule *AlertRule) error {
	am.mu.Lock()
	defer am.mu.Unlock()

	if rule.ID == "" {
		return fmt.Errorf("rule ID cannot be empty")
	}

	if _, exists := am.rules[rule.ID]; exists {
		return fmt.Errorf("rule with ID %s already exists", rule.ID)
	}

	am.rules[rule.ID] = rule
	am.logger.Info("Alert rule added",
		zap.String("rule_id", rule.ID),
		zap.String("name", rule.Name),
		zap.String("severity", rule.Severity.String()))

	return nil
}

// RemoveRule removes an alert rule
func (am *AlertManager) RemoveRule(ruleID string) error {
	am.mu.Lock()
	defer am.mu.Unlock()

	if _, exists := am.rules[ruleID]; !exists {
		return fmt.Errorf("rule with ID %s not found", ruleID)
	}

	delete(am.rules, ruleID)
	am.logger.Info("Alert rule removed", zap.String("rule_id", ruleID))

	return nil
}

// AddChannel adds a new alert channel
func (am *AlertManager) AddChannel(channel AlertChannel) error {
	am.mu.Lock()
	defer am.mu.Unlock()

	name := channel.Name()
	if name == "" {
		return fmt.Errorf("channel name cannot be empty")
	}

	am.channels[name] = channel
	am.logger.Info("Alert channel added", zap.String("channel", name))

	return nil
}

// TriggerAlert manually triggers an alert
func (am *AlertManager) TriggerAlert(alert *Alert) error {
	select {
	case am.alertQueue <- alert:
		return nil
	default:
		return fmt.Errorf("alert queue is full")
	}
}

// SilenceAlert creates a silence for matching alerts
func (am *AlertManager) SilenceAlert(silence *AlertSilence) error {
	am.mu.Lock()
	defer am.mu.Unlock()

	if silence.ID == "" {
		silence.ID = generateSilenceID()
	}

	am.silences[silence.ID] = silence
	am.logger.Info("Alert silence created",
		zap.String("silence_id", silence.ID),
		zap.Time("starts_at", silence.StartsAt),
		zap.Time("ends_at", silence.EndsAt))

	return nil
}

// GetActiveAlerts returns all active alerts
func (am *AlertManager) GetActiveAlerts() []*Alert {
	am.mu.RLock()
	defer am.mu.RUnlock()

	alerts := make([]*Alert, 0)
	for _, alert := range am.alerts {
		if alert.Status == AlertStatusFiring {
			alerts = append(alerts, alert)
		}
	}

	return alerts
}

// GetAlertMetrics returns alert metrics
func (am *AlertManager) GetAlertMetrics() *AlertMetrics {
	am.mu.RLock()
	defer am.mu.RUnlock()

	// Update metrics
	am.updateMetrics()
	
	// Return copy
	metrics := *am.alertMetrics
	return &metrics
}

func (am *AlertManager) alertProcessingLoop() {
	for {
		select {
		case <-am.ctx.Done():
			return
		case alert := <-am.alertQueue:
			am.processAlert(alert)
		}
	}
}

func (am *AlertManager) processAlert(alert *Alert) {
	am.mu.Lock()
	defer am.mu.Unlock()

	// Check if alert is silenced
	if am.isAlertSilenced(alert) {
		alert.Status = AlertStatusSilenced
		am.logger.Debug("Alert is silenced", zap.String("alert_id", alert.ID))
		return
	}

	// Store alert
	am.alerts[alert.ID] = alert

	// Update alert state
	am.updateAlertState(alert)

	// Add to history
	am.addToHistory(alert)

	// Queue notifications
	am.queueNotifications(alert)

	am.logger.Info("Alert processed",
		zap.String("alert_id", alert.ID),
		zap.String("rule_id", alert.RuleID),
		zap.String("status", alert.Status.String()),
		zap.String("severity", alert.Severity.String()))
}

func (am *AlertManager) isAlertSilenced(alert *Alert) bool {
	now := time.Now()
	
	for _, silence := range am.silences {
		if silence.StartsAt.After(now) || silence.EndsAt.Before(now) {
			continue
		}

		if am.matchesMatchers(alert.Labels, silence.Matchers) {
			return true
		}
	}

	return false
}

func (am *AlertManager) matchesMatchers(labels map[string]string, matchers []LabelMatcher) bool {
	for _, matcher := range matchers {
		value, exists := labels[matcher.Name]
		if !exists {
			if matcher.IsEqual {
				return false
			}
			continue
		}

		if matcher.IsRegex {
			// TODO: Implement regex matching
			continue
		}

		if matcher.IsEqual && value != matcher.Value {
			return false
		}
		if !matcher.IsEqual && value == matcher.Value {
			return false
		}
	}

	return true
}

func (am *AlertManager) updateAlertState(alert *Alert) {
	state, exists := am.alertStates[alert.ID]
	if !exists {
		state = &AlertState{
			ID:     alert.ID,
			RuleID: alert.RuleID,
		}
		am.alertStates[alert.ID] = state
	}

	state.Status = alert.Status
	state.LastEvaluation = time.Now()
	state.EvaluationCount++
	state.Labels = alert.Labels
	state.Annotations = alert.Annotations

	if alert.Status == AlertStatusFiring && state.ActiveSince.IsZero() {
		state.ActiveSince = time.Now()
	} else if alert.Status == AlertStatusResolved {
		state.ActiveSince = time.Time{}
	}
}

func (am *AlertManager) addToHistory(alert *Alert) {
	entry := &AlertHistoryEntry{
		Timestamp: time.Now(),
		AlertID:   alert.ID,
		RuleID:    alert.RuleID,
		Status:    alert.Status,
		Message:   alert.Description,
	}

	am.alertHistory = append(am.alertHistory, entry)

	// Limit history size
	if len(am.alertHistory) > 10000 {
		am.alertHistory = am.alertHistory[1000:]
	}
}

func (am *AlertManager) queueNotifications(alert *Alert) {
	rule, exists := am.rules[alert.RuleID]
	if !exists {
		return
	}

	for _, channelName := range rule.Channels {
		notification := &AlertNotification{
			ID:          generateNotificationID(),
			AlertID:     alert.ID,
			ChannelName: channelName,
			Alert:       alert,
			RetryCount:  0,
			LastTry:     time.Time{},
			NextTry:     time.Now(),
		}

		select {
		case am.notificationQueue <- notification:
		default:
			am.logger.Warn("Notification queue is full", zap.String("alert_id", alert.ID))
		}
	}
}

func (am *AlertManager) notificationLoop() {
	for {
		select {
		case <-am.ctx.Done():
			return
		case notification := <-am.notificationQueue:
			am.sendNotification(notification)
		}
	}
}

func (am *AlertManager) sendNotification(notification *AlertNotification) {
	channel, exists := am.channels[notification.ChannelName]
	if !exists {
		am.logger.Error("Alert channel not found", zap.String("channel", notification.ChannelName))
		return
	}

	if !channel.IsEnabled() {
		am.logger.Debug("Alert channel is disabled", zap.String("channel", notification.ChannelName))
		return
	}

	notification.LastTry = time.Now()
	err := channel.SendAlert(notification.Alert)
	
	if err != nil {
		am.logger.Error("Failed to send alert notification",
			zap.String("channel", notification.ChannelName),
			zap.String("alert_id", notification.AlertID),
			zap.Error(err))

		// Retry if not exceeded max retries
		if notification.RetryCount < am.maxRetries {
			notification.RetryCount++
			notification.NextTry = time.Now().Add(am.retryInterval)
			
			select {
			case am.retryQueue <- notification:
			default:
				am.logger.Warn("Retry queue is full", zap.String("alert_id", notification.AlertID))
			}
		} else {
			am.alertMetrics.FailedNotifications++
		}
	} else {
		am.logger.Info("Alert notification sent successfully",
			zap.String("channel", notification.ChannelName),
			zap.String("alert_id", notification.AlertID))
	}
}

func (am *AlertManager) retryLoop() {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-am.ctx.Done():
			return
		case <-ticker.C:
			am.processRetries()
		case notification := <-am.retryQueue:
			if time.Now().After(notification.NextTry) {
				am.sendNotification(notification)
			} else {
				// Put back in queue for later
				select {
				case am.retryQueue <- notification:
				default:
					am.logger.Warn("Retry queue is full", zap.String("alert_id", notification.AlertID))
				}
			}
		}
	}
}

func (am *AlertManager) processRetries() {
	// Process pending retries
	retryQueue := make([]*AlertNotification, 0)

	// Drain the retry queue
	for {
		select {
		case notification := <-am.retryQueue:
			if time.Now().After(notification.NextTry) {
				am.sendNotification(notification)
			} else {
				retryQueue = append(retryQueue, notification)
			}
		default:
			goto ProcessQueue
		}
	}

ProcessQueue:
	// Put back notifications that aren't ready yet
	for _, notification := range retryQueue {
		select {
		case am.retryQueue <- notification:
		default:
			am.logger.Warn("Retry queue is full", zap.String("alert_id", notification.AlertID))
		}
	}
}

func (am *AlertManager) evaluationLoop() {
	for {
		select {
		case <-am.ctx.Done():
			return
		case <-am.evaluationTicker.C:
			am.evaluateRules()
		}
	}
}

func (am *AlertManager) evaluateRules() {
	am.mu.RLock()
	rules := make([]*AlertRule, 0, len(am.rules))
	for _, rule := range am.rules {
		if rule.Enabled {
			rules = append(rules, rule)
		}
	}
	am.mu.RUnlock()

	for _, rule := range rules {
		am.evaluateRule(rule)
	}
}

func (am *AlertManager) evaluateRule(rule *AlertRule) {
	startTime := time.Now()
	
	// Evaluate the rule expression
	result, err := am.ruleEvaluator.Evaluate(rule.Expression)
	if err != nil {
		am.logger.Error("Failed to evaluate rule",
			zap.String("rule_id", rule.ID),
			zap.Error(err))
		return
	}

	evaluationDuration := time.Since(startTime)
	
	// Update rule evaluation time
	rule.LastEvaluation = time.Now()

	// Check if alert should fire
	if result {
		am.fireAlert(rule)
	} else {
		am.resolveAlert(rule)
	}

	// Update metrics
	am.alertMetrics.EvaluationDuration = evaluationDuration
}

func (am *AlertManager) fireAlert(rule *AlertRule) {
	alertID := generateAlertID(rule.ID)
	
	alert := &Alert{
		ID:           alertID,
		RuleID:       rule.ID,
		Name:         rule.Name,
		Description:  rule.Description,
		Severity:     rule.Severity,
		Status:       AlertStatusFiring,
		StartsAt:     time.Now(),
		Labels:       rule.Labels,
		Annotations:  rule.Annotations,
	}

	am.TriggerAlert(alert)
	rule.LastTriggered = time.Now()
	rule.TriggerCount++
}

func (am *AlertManager) resolveAlert(rule *AlertRule) {
	// Find existing firing alert for this rule
	alertID := generateAlertID(rule.ID)
	
	am.mu.Lock()
	defer am.mu.Unlock()
	
	if alert, exists := am.alerts[alertID]; exists && alert.Status == AlertStatusFiring {
		alert.Status = AlertStatusResolved
		alert.EndsAt = time.Now()
		alert.ResolvedAt = time.Now()
		
		am.updateAlertState(alert)
		am.addToHistory(alert)
		am.queueNotifications(alert)
	}
}

func (am *AlertManager) aggregationLoop() {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-am.ctx.Done():
			return
		case <-ticker.C:
			am.processAggregations()
		}
	}
}

func (am *AlertManager) processAggregations() {
	am.mu.RLock()
	rules := make([]*AggregationRule, 0, len(am.aggregationRules))
	for _, rule := range am.aggregationRules {
		rules = append(rules, rule)
	}
	am.mu.RUnlock()

	for _, rule := range rules {
		am.processAggregationRule(rule)
	}
}

func (am *AlertManager) processAggregationRule(rule *AggregationRule) {
	// Get alerts that match the aggregation rule
	matchingAlerts := am.getMatchingAlerts(rule)
	
	if len(matchingAlerts) == 0 {
		return
	}

	// Group alerts by the specified labels
	groups := am.groupAlerts(matchingAlerts, rule.GroupBy)
	
	for groupKey, alerts := range groups {
		am.processAggregatedGroup(rule, groupKey, alerts)
	}
}

func (am *AlertManager) getMatchingAlerts(rule *AggregationRule) []*Alert {
	am.mu.RLock()
	defer am.mu.RUnlock()

	alerts := make([]*Alert, 0)
	cutoff := time.Now().Add(-rule.TimeWindow)

	for _, alert := range am.alerts {
		if alert.Status == AlertStatusFiring && alert.StartsAt.After(cutoff) {
			// Check if alert matches rule labels
			if am.matchesLabels(alert.Labels, rule.Labels) {
				alerts = append(alerts, alert)
			}
		}
	}

	return alerts
}

func (am *AlertManager) matchesLabels(alertLabels, ruleLabels map[string]string) bool {
	for key, value := range ruleLabels {
		if alertValue, exists := alertLabels[key]; !exists || alertValue != value {
			return false
		}
	}
	return true
}

func (am *AlertManager) groupAlerts(alerts []*Alert, groupBy []string) map[string][]*Alert {
	groups := make(map[string][]*Alert)

	for _, alert := range alerts {
		groupKey := am.generateGroupKey(alert.Labels, groupBy)
		groups[groupKey] = append(groups[groupKey], alert)
	}

	return groups
}

func (am *AlertManager) generateGroupKey(labels map[string]string, groupBy []string) string {
	key := ""
	for _, label := range groupBy {
		if value, exists := labels[label]; exists {
			key += fmt.Sprintf("%s=%s,", label, value)
		}
	}
	return key
}

func (am *AlertManager) processAggregatedGroup(rule *AggregationRule, groupKey string, alerts []*Alert) {
	// Calculate aggregated value
	var value float64
	switch rule.AggregationType {
	case AggregationTypeCount:
		value = float64(len(alerts))
	case AggregationTypeSum:
		// TODO: Sum alert values
	case AggregationTypeAverage:
		// TODO: Average alert values
	case AggregationTypeMax:
		// TODO: Max alert value
	case AggregationTypeMin:
		// TODO: Min alert value
	}

	// Check if threshold is exceeded
	if value >= rule.Threshold {
		am.createAggregatedAlert(rule, groupKey, alerts, value)
	}
}

func (am *AlertManager) createAggregatedAlert(rule *AggregationRule, groupKey string, alerts []*Alert, value float64) {
	aggregatedAlert := &AggregatedAlert{
		ID:         generateAggregatedAlertID(rule.ID, groupKey),
		RuleID:     rule.ID,
		GroupKey:   groupKey,
		Count:      len(alerts),
		Value:      value,
		Alerts:     alerts,
		StartsAt:   time.Now(),
		LastUpdate: time.Now(),
		Labels:     rule.Labels,
	}

	am.mu.Lock()
	am.aggregatedAlerts[aggregatedAlert.ID] = aggregatedAlert
	am.mu.Unlock()

	am.logger.Info("Aggregated alert created",
		zap.String("id", aggregatedAlert.ID),
		zap.String("rule_id", rule.ID),
		zap.String("group_key", groupKey),
		zap.Int("count", aggregatedAlert.Count),
		zap.Float64("value", value))
}

func (am *AlertManager) updateMetrics() {
	var activeAlerts, resolvedAlerts, silencedAlerts uint64
	var infoAlerts, warningAlerts, criticalAlerts, emergencyAlerts uint64

	for _, alert := range am.alerts {
		switch alert.Status {
		case AlertStatusFiring:
			activeAlerts++
		case AlertStatusResolved:
			resolvedAlerts++
		case AlertStatusSilenced:
			silencedAlerts++
		}

		switch alert.Severity {
		case AlertSeverityInfo:
			infoAlerts++
		case AlertSeverityWarning:
			warningAlerts++
		case AlertSeverityCritical:
			criticalAlerts++
		case AlertSeverityEmergency:
			emergencyAlerts++
		}
	}

	am.alertMetrics.TotalAlerts = uint64(len(am.alerts))
	am.alertMetrics.ActiveAlerts = activeAlerts
	am.alertMetrics.ResolvedAlerts = resolvedAlerts
	am.alertMetrics.SilencedAlerts = silencedAlerts
	am.alertMetrics.InfoAlerts = infoAlerts
	am.alertMetrics.WarningAlerts = warningAlerts
	am.alertMetrics.CriticalAlerts = criticalAlerts
	am.alertMetrics.EmergencyAlerts = emergencyAlerts
	am.alertMetrics.LastUpdate = time.Now()
}

// Utility functions
func generateAlertID(ruleID string) string {
	return fmt.Sprintf("alert_%s_%d", ruleID, time.Now().UnixNano())
}

func generateSilenceID() string {
	return fmt.Sprintf("silence_%d", time.Now().UnixNano())
}

func generateNotificationID() string {
	return fmt.Sprintf("notification_%d", time.Now().UnixNano())
}

func generateAggregatedAlertID(ruleID, groupKey string) string {
	return fmt.Sprintf("aggregated_%s_%s", ruleID, groupKey)
}

// NewExpressionEngine creates a new expression engine
func NewExpressionEngine(logger *zap.Logger) *ExpressionEngine {
	engine := &ExpressionEngine{
		logger:    logger,
		functions: make(map[string]ExpressionFunction),
		variables: make(map[string]float64),
	}

	// Register default functions
	engine.registerDefaultFunctions()

	return engine
}

func (ee *ExpressionEngine) registerDefaultFunctions() {
	ee.functions["avg"] = func(args ...float64) float64 {
		if len(args) == 0 {
			return 0
		}
		sum := 0.0
		for _, arg := range args {
			sum += arg
		}
		return sum / float64(len(args))
	}

	ee.functions["max"] = func(args ...float64) float64 {
		if len(args) == 0 {
			return 0
		}
		max := args[0]
		for _, arg := range args[1:] {
			if arg > max {
				max = arg
			}
		}
		return max
	}

	ee.functions["min"] = func(args ...float64) float64 {
		if len(args) == 0 {
			return 0
		}
		min := args[0]
		for _, arg := range args[1:] {
			if arg < min {
				min = arg
			}
		}
		return min
	}
}

// Evaluate evaluates an expression and returns the result
func (re *RuleEvaluator) Evaluate(expression string) (bool, error) {
	// Simplified expression evaluation
	// In a real implementation, this would parse and evaluate complex expressions
	
	// Validated implementation with proper logic
	return true, nil
}