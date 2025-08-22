package monitoring

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/smtp"
	"sync"
	"time"

	"go.uber.org/zap"
)

// External integrations and notification channels

// GrafanaClient integrates with Grafana for dashboard management
type GrafanaClient struct {
	logger    *zap.Logger
	baseURL   string
	apiKey    string
	client    *http.Client
	mu        sync.RWMutex
}

type GrafanaDashboard struct {
	ID          int                    `json:"id"`
	UID         string                 `json:"uid"`
	Title       string                 `json:"title"`
	Tags        []string               `json:"tags"`
	Dashboard   map[string]interface{} `json:"dashboard"`
	FolderID    int                    `json:"folderId"`
	Overwrite   bool                   `json:"overwrite"`
	Message     string                 `json:"message"`
}

type GrafanaDataSource struct {
	ID       int                    `json:"id"`
	Name     string                 `json:"name"`
	Type     string                 `json:"type"`
	URL      string                 `json:"url"`
	Access   string                 `json:"access"`
	Database string                 `json:"database"`
	Settings map[string]interface{} `json:"jsonData"`
}

// SlackClient sends notifications to Slack
type SlackClient struct {
	logger     *zap.Logger
	webhookURL string
	client     *http.Client
	mu         sync.RWMutex
}

type SlackMessage struct {
	Text        string            `json:"text"`
	Username    string            `json:"username,omitempty"`
	IconEmoji   string            `json:"icon_emoji,omitempty"`
	Channel     string            `json:"channel,omitempty"`
	Attachments []SlackAttachment `json:"attachments,omitempty"`
}

type SlackAttachment struct {
	Color      string       `json:"color,omitempty"`
	Title      string       `json:"title,omitempty"`
	Text       string       `json:"text,omitempty"`
	Timestamp  int64        `json:"ts,omitempty"`
	Fields     []SlackField `json:"fields,omitempty"`
	Footer     string       `json:"footer,omitempty"`
	FooterIcon string       `json:"footer_icon,omitempty"`
}

type SlackField struct {
	Title string `json:"title"`
	Value string `json:"value"`
	Short bool   `json:"short"`
}

// EmailClient sends email notifications
type EmailClient struct {
	logger   *zap.Logger
	config   *EmailConfig
	client   *smtp.Auth
	mu       sync.RWMutex
}

type EmailConfig struct {
	SMTPHost     string `json:"smtp_host"`
	SMTPPort     int    `json:"smtp_port"`
	Username     string `json:"username"`
	Password     string `json:"password"`
	FromAddress  string `json:"from_address"`
	FromName     string `json:"from_name"`
	TLSEnabled   bool   `json:"tls_enabled"`
}

type EmailMessage struct {
	To          []string `json:"to"`
	CC          []string `json:"cc,omitempty"`
	BCC         []string `json:"bcc,omitempty"`
	Subject     string   `json:"subject"`
	Body        string   `json:"body"`
	HTMLBody    string   `json:"html_body,omitempty"`
	Attachments []EmailAttachment `json:"attachments,omitempty"`
}

type EmailAttachment struct {
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	Data        []byte `json:"data"`
}

// WebhookManager manages webhook notifications
type WebhookManager struct {
	logger    *zap.Logger
	webhooks  map[string]*Webhook
	client    *http.Client
	mu        sync.RWMutex
}

type Webhook struct {
	ID          string            `json:"id"`
	Name        string            `json:"name"`
	URL         string            `json:"url"`
	Method      string            `json:"method"`
	Headers     map[string]string `json:"headers"`
	Timeout     time.Duration     `json:"timeout"`
	RetryCount  int               `json:"retry_count"`
	Enabled     bool              `json:"enabled"`
	LastUsed    time.Time         `json:"last_used"`
	SuccessCount uint64           `json:"success_count"`
	FailureCount uint64           `json:"failure_count"`
}

type WebhookPayload struct {
	Event     string                 `json:"event"`
	Timestamp time.Time              `json:"timestamp"`
	Source    string                 `json:"source"`
	Data      map[string]interface{} `json:"data"`
	Metadata  map[string]interface{} `json:"metadata"`
}

// EventProcessor processes and routes monitoring events
type EventProcessor struct {
	logger          *zap.Logger
	mu              sync.RWMutex
	ctx             context.Context
	cancel          context.CancelFunc
	config          *MonitoringConfig
	
	// Event processing
	eventQueue      chan *MonitoringEvent
	processors      map[string]EventProcessorFunc
	filters         []EventFilter
	transformers    []EventTransformer
	
	// Event routing
	routes          map[string]*EventRoute
	defaultRoute    *EventRoute
	
	// Event storage
	eventStore      *EventStore
	
	// Metrics
	processedEvents uint64
	droppedEvents   uint64
	errorEvents     uint64
}

type MonitoringEvent struct {
	ID          string                 `json:"id"`
	Type        string                 `json:"type"`
	Source      string                 `json:"source"`
	Timestamp   time.Time              `json:"timestamp"`
	Severity    string                 `json:"severity"`
	Data        map[string]interface{} `json:"data"`
	Metadata    map[string]interface{} `json:"metadata"`
	Tags        []string               `json:"tags"`
	Processed   bool                   `json:"processed"`
	ProcessedAt time.Time              `json:"processed_at"`
}

type EventProcessorFunc func(*MonitoringEvent) error

type EventFilter func(*MonitoringEvent) bool

type EventTransformer func(*MonitoringEvent) *MonitoringEvent

type EventRoute struct {
	ID          string              `json:"id"`
	Name        string              `json:"name"`
	Conditions  []EventCondition    `json:"conditions"`
	Actions     []EventAction       `json:"actions"`
	Enabled     bool                `json:"enabled"`
	Priority    int                 `json:"priority"`
}

type EventCondition struct {
	Field    string      `json:"field"`
	Operator string      `json:"operator"` // eq, ne, gt, lt, contains, regex
	Value    interface{} `json:"value"`
}

type EventAction struct {
	Type   string                 `json:"type"`   // alert, webhook, email, log
	Config map[string]interface{} `json:"config"`
}

type EventStore struct {
	events   []*MonitoringEvent
	maxSize  int
	mu       sync.RWMutex
}

// LogAggregator aggregates and correlates log data
type LogAggregator struct {
	logger          *zap.Logger
	mu              sync.RWMutex
	ctx             context.Context
	cancel          context.CancelFunc
	config          *MonitoringConfig
	
	// Log processing
	logQueue        chan *LogEntry
	processors      map[string]LogProcessor
	
	// Log storage and indexing
	logStore        *LogStore
	indexer         *LogIndexer
	
	// Correlation engine
	correlator      *LogCorrelator
	patterns        []*LogPattern
	
	// Alerting
	logAlerts       []*LogAlert
	alertRules      []*LogAlertRule
}

type LogEntry struct {
	ID          string                 `json:"id"`
	Timestamp   time.Time              `json:"timestamp"`
	Level       string                 `json:"level"`
	Source      string                 `json:"source"`
	Message     string                 `json:"message"`
	Fields      map[string]interface{} `json:"fields"`
	Tags        []string               `json:"tags"`
	Raw         string                 `json:"raw"`
	Parsed      bool                   `json:"parsed"`
}

type LogProcessor interface {
	Process(*LogEntry) error
	Name() string
}

type LogStore struct {
	entries    []*LogEntry
	maxSize    int
	indexes    map[string]*LogIndex
	mu         sync.RWMutex
}

type LogIndex struct {
	Field   string                    `json:"field"`
	Values  map[string][]*LogEntry   `json:"values"`
}

type LogIndexer struct {
	indexes map[string]*LogIndex
	mu      sync.RWMutex
}

type LogCorrelator struct {
	rules       []*CorrelationRule
	windows     map[string]*CorrelationWindow
	mu          sync.RWMutex
}

type CorrelationRule struct {
	ID          string        `json:"id"`
	Name        string        `json:"name"`
	Pattern     string        `json:"pattern"`
	TimeWindow  time.Duration `json:"time_window"`
	Threshold   int           `json:"threshold"`
	Actions     []string      `json:"actions"`
	Enabled     bool          `json:"enabled"`
}

type CorrelationWindow struct {
	RuleID      string      `json:"rule_id"`
	StartTime   time.Time   `json:"start_time"`
	EndTime     time.Time   `json:"end_time"`
	Entries     []*LogEntry `json:"entries"`
	Count       int         `json:"count"`
}

type LogPattern struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Pattern     string  `json:"pattern"`
	Frequency   float64 `json:"frequency"`
	LastSeen    time.Time `json:"last_seen"`
	Examples    []*LogEntry `json:"examples"`
}

type LogAlert struct {
	ID          string    `json:"id"`
	RuleID      string    `json:"rule_id"`
	Message     string    `json:"message"`
	Severity    string    `json:"severity"`
	Entries     []*LogEntry `json:"entries"`
	Timestamp   time.Time `json:"timestamp"`
	Resolved    bool      `json:"resolved"`
	ResolvedAt  time.Time `json:"resolved_at"`
}

type LogAlertRule struct {
	ID          string        `json:"id"`
	Name        string        `json:"name"`
	Query       string        `json:"query"`
	Threshold   int           `json:"threshold"`
	TimeWindow  time.Duration `json:"time_window"`
	Severity    string        `json:"severity"`
	Enabled     bool          `json:"enabled"`
	LastFired   time.Time     `json:"last_fired"`
}

// DataRetentionManager manages data retention policies
type DataRetentionManager struct {
	logger          *zap.Logger
	mu              sync.RWMutex
	ctx             context.Context
	cancel          context.CancelFunc
	config          *MonitoringConfig
	
	// Retention policies
	policies        map[string]*RetentionPolicy
	
	// Cleanup scheduling
	cleanupTicker   *time.Ticker
	lastCleanup     time.Time
	
	// Statistics
	cleanupStats    *CleanupStats
}

type RetentionPolicy struct {
	ID              string        `json:"id"`
	Name            string        `json:"name"`
	DataType        string        `json:"data_type"`    // metrics, logs, events, alerts
	RetentionPeriod time.Duration `json:"retention_period"`
	CompressionEnabled bool       `json:"compression_enabled"`
	ArchiveEnabled  bool          `json:"archive_enabled"`
	ArchiveLocation string        `json:"archive_location"`
	Enabled         bool          `json:"enabled"`
	LastApplied     time.Time     `json:"last_applied"`
}

type CleanupStats struct {
	TotalCleaned       uint64    `json:"total_cleaned"`
	MetricsCleaned     uint64    `json:"metrics_cleaned"`
	LogsCleaned        uint64    `json:"logs_cleaned"`
	EventsCleaned      uint64    `json:"events_cleaned"`
	AlertsCleaned      uint64    `json:"alerts_cleaned"`
	SpaceReclaimed     uint64    `json:"space_reclaimed"` // bytes
	LastCleanup        time.Time `json:"last_cleanup"`
	CleanupDuration    time.Duration `json:"cleanup_duration"`
}

// RealTimeMonitor provides real-time monitoring capabilities
type RealTimeMonitor struct {
	logger          *zap.Logger
	mu              sync.RWMutex
	ctx             context.Context
	cancel          context.CancelFunc
	config          *MonitoringConfig
	
	// Real-time streams
	metricStreams   map[string]*MetricStream
	eventStreams    map[string]*EventStream
	
	// WebSocket connections
	wsConnections   map[string]*WSConnection
	
	// Live dashboards
	liveDashboards  map[string]*LiveDashboard
	
	// Streaming metrics
	streamingStats  *StreamingStats
}

type MetricStream struct {
	ID          string        `json:"id"`
	Name        string        `json:"name"`
	Source      string        `json:"source"`
	Interval    time.Duration `json:"interval"`
	BufferSize  int           `json:"buffer_size"`
	Buffer      []interface{} `json:"buffer"`
	Subscribers []string      `json:"subscribers"`
	LastUpdate  time.Time     `json:"last_update"`
}

type EventStream struct {
	ID          string            `json:"id"`
	Name        string            `json:"name"`
	Filter      string            `json:"filter"`
	BufferSize  int               `json:"buffer_size"`
	Buffer      []*MonitoringEvent `json:"buffer"`
	Subscribers []string          `json:"subscribers"`
	LastUpdate  time.Time         `json:"last_update"`
}

type WSConnection struct {
	ID          string    `json:"id"`
	UserID      string    `json:"user_id"`
	ConnectedAt time.Time `json:"connected_at"`
	LastPing    time.Time `json:"last_ping"`
	Subscriptions []string `json:"subscriptions"`
}

type LiveDashboard struct {
	ID          string      `json:"id"`
	Title       string      `json:"title"`
	Layout      interface{} `json:"layout"`
	Widgets     []*LiveWidget `json:"widgets"`
	Viewers     []string    `json:"viewers"`
	LastUpdate  time.Time   `json:"last_update"`
}

type LiveWidget struct {
	ID          string      `json:"id"`
	Type        string      `json:"type"`
	Title       string      `json:"title"`
	DataSource  string      `json:"data_source"`
	Query       string      `json:"query"`
	RefreshRate time.Duration `json:"refresh_rate"`
	Config      map[string]interface{} `json:"config"`
}

type StreamingStats struct {
	ActiveStreams    int       `json:"active_streams"`
	ActiveConnections int      `json:"active_connections"`
	MessagesPerSecond float64  `json:"messages_per_second"`
	BytesPerSecond   float64   `json:"bytes_per_second"`
	TotalMessages    uint64    `json:"total_messages"`
	DroppedMessages  uint64    `json:"dropped_messages"`
	LastUpdate       time.Time `json:"last_update"`
}

// Implementation of alert channels

// SlackAlertChannel implements AlertChannel for Slack notifications
type SlackAlertChannel struct {
	name     string
	client   *SlackClient
	config   *SlackChannelConfig
	enabled  bool
	mu       sync.RWMutex
}

type SlackChannelConfig struct {
	Channel   string `json:"channel"`
	Username  string `json:"username"`
	IconEmoji string `json:"icon_emoji"`
}

// EmailAlertChannel implements AlertChannel for email notifications
type EmailAlertChannel struct {
	name     string
	client   *EmailClient
	config   *EmailChannelConfig
	enabled  bool
	mu       sync.RWMutex
}

type EmailChannelConfig struct {
	Recipients []string `json:"recipients"`
	Subject    string   `json:"subject"`
	Template   string   `json:"template"`
}

// WebhookAlertChannel implements AlertChannel for webhook notifications
type WebhookAlertChannel struct {
	name     string
	manager  *WebhookManager
	config   *WebhookChannelConfig
	enabled  bool
	mu       sync.RWMutex
}

type WebhookChannelConfig struct {
	WebhookID string            `json:"webhook_id"`
	Headers   map[string]string `json:"headers"`
	Template  string            `json:"template"`
}

// Constructor functions

// NewGrafanaClient creates a new Grafana client
func NewGrafanaClient(baseURL, apiKey string, logger *zap.Logger) *GrafanaClient {
	return &GrafanaClient{
		logger:  logger,
		baseURL: baseURL,
		apiKey:  apiKey,
		client: &http.Client{
			Timeout: time.Second * 30,
		},
	}
}

// NewSlackClient creates a new Slack client
func NewSlackClient(webhookURL string, logger *zap.Logger) *SlackClient {
	return &SlackClient{
		logger:     logger,
		webhookURL: webhookURL,
		client: &http.Client{
			Timeout: time.Second * 30,
		},
	}
}

// NewEmailClient creates a new email client
func NewEmailClient(config *EmailConfig, logger *zap.Logger) *EmailClient {
	return &EmailClient{
		logger: logger,
		config: config,
	}
}

// NewWebhookManager creates a new webhook manager
func NewWebhookManager(config *MonitoringConfig, logger *zap.Logger) (*WebhookManager, error) {
	return &WebhookManager{
		logger:   logger,
		webhooks: make(map[string]*Webhook),
		client: &http.Client{
			Timeout: time.Second * 30,
		},
	}, nil
}

// NewEventProcessor creates a new event processor
func NewEventProcessor(config *MonitoringConfig, logger *zap.Logger) (*EventProcessor, error) {
	ctx, cancel := context.WithCancel(context.Background())

	ep := &EventProcessor{
		logger:     logger,
		ctx:        ctx,
		cancel:     cancel,
		config:     config,
		eventQueue: make(chan *MonitoringEvent, 10000),
		processors: make(map[string]EventProcessorFunc),
		filters:    make([]EventFilter, 0),
		transformers: make([]EventTransformer, 0),
		routes:     make(map[string]*EventRoute),
		eventStore: &EventStore{
			events:  make([]*MonitoringEvent, 0),
			maxSize: 100000,
		},
	}

	return ep, nil
}

// NewLogAggregator creates a new log aggregator
func NewLogAggregator(config *MonitoringConfig, logger *zap.Logger) (*LogAggregator, error) {
	ctx, cancel := context.WithCancel(context.Background())

	la := &LogAggregator{
		logger:      logger,
		ctx:         ctx,
		cancel:      cancel,
		config:      config,
		logQueue:    make(chan *LogEntry, 10000),
		processors:  make(map[string]LogProcessor),
		logStore: &LogStore{
			entries: make([]*LogEntry, 0),
			maxSize: 1000000,
			indexes: make(map[string]*LogIndex),
		},
		indexer: &LogIndexer{
			indexes: make(map[string]*LogIndex),
		},
		correlator: &LogCorrelator{
			rules:   make([]*CorrelationRule, 0),
			windows: make(map[string]*CorrelationWindow),
		},
		logAlerts:  make([]*LogAlert, 0),
		alertRules: make([]*LogAlertRule, 0),
	}

	return la, nil
}

// NewDataRetentionManager creates a new data retention manager
func NewDataRetentionManager(config *MonitoringConfig, logger *zap.Logger) (*DataRetentionManager, error) {
	ctx, cancel := context.WithCancel(context.Background())

	drm := &DataRetentionManager{
		logger:        logger,
		ctx:           ctx,
		cancel:        cancel,
		config:        config,
		policies:      make(map[string]*RetentionPolicy),
		cleanupTicker: time.NewTicker(time.Hour * 24), // Daily cleanup
		cleanupStats:  &CleanupStats{},
	}

	return drm, nil
}

// NewRealTimeMonitor creates a new real-time monitor
func NewRealTimeMonitor(config *MonitoringConfig, logger *zap.Logger) (*RealTimeMonitor, error) {
	ctx, cancel := context.WithCancel(context.Background())

	rtm := &RealTimeMonitor{
		logger:         logger,
		ctx:            ctx,
		cancel:         cancel,
		config:         config,
		metricStreams:  make(map[string]*MetricStream),
		eventStreams:   make(map[string]*EventStream),
		wsConnections:  make(map[string]*WSConnection),
		liveDashboards: make(map[string]*LiveDashboard),
		streamingStats: &StreamingStats{},
	}

	return rtm, nil
}

// Alert channel implementations

func (sac *SlackAlertChannel) Name() string {
	return sac.name
}

func (sac *SlackAlertChannel) SendAlert(alert *Alert) error {
	sac.mu.RLock()
	defer sac.mu.RUnlock()

	if !sac.enabled {
		return fmt.Errorf("slack channel is disabled")
	}

	message := &SlackMessage{
		Text:     fmt.Sprintf("Alert: %s", alert.Name),
		Username: sac.config.Username,
		Channel:  sac.config.Channel,
		Attachments: []SlackAttachment{
			{
				Color: sac.getSeverityColor(alert.Severity),
				Title: alert.Name,
				Text:  alert.Description,
				Fields: []SlackField{
					{
						Title: "Severity",
						Value: alert.Severity.String(),
						Short: true,
					},
					{
						Title: "Status",
						Value: alert.Status.String(),
						Short: true,
					},
					{
						Title: "Started",
						Value: alert.StartsAt.Format(time.RFC3339),
						Short: true,
					},
				},
				Footer:    "Enterprise Monitor",
				Timestamp: alert.StartsAt.Unix(),
			},
		},
	}

	return sac.client.SendMessage(message)
}

func (sac *SlackAlertChannel) IsEnabled() bool {
	sac.mu.RLock()
	defer sac.mu.RUnlock()
	return sac.enabled
}

func (sac *SlackAlertChannel) GetConfiguration() map[string]interface{} {
	sac.mu.RLock()
	defer sac.mu.RUnlock()
	
	return map[string]interface{}{
		"channel":    sac.config.Channel,
		"username":   sac.config.Username,
		"icon_emoji": sac.config.IconEmoji,
		"enabled":    sac.enabled,
	}
}

func (sac *SlackAlertChannel) getSeverityColor(severity AlertSeverity) string {
	switch severity {
	case AlertSeverityInfo:
		return "good"
	case AlertSeverityWarning:
		return "warning"
	case AlertSeverityCritical:
		return "danger"
	case AlertSeverityEmergency:
		return "#ff0000"
	default:
		return "#808080"
	}
}

func (eac *EmailAlertChannel) Name() string {
	return eac.name
}

func (eac *EmailAlertChannel) SendAlert(alert *Alert) error {
	eac.mu.RLock()
	defer eac.mu.RUnlock()

	if !eac.enabled {
		return fmt.Errorf("email channel is disabled")
	}

	subject := fmt.Sprintf("[%s] %s", alert.Severity.String(), alert.Name)
	if eac.config.Subject != "" {
		subject = eac.config.Subject
	}

	body := fmt.Sprintf(`
Alert: %s

Description: %s
Severity: %s
Status: %s
Started: %s

Labels:
%s

Annotations:
%s
	`,
		alert.Name,
		alert.Description,
		alert.Severity.String(),
		alert.Status.String(),
		alert.StartsAt.Format(time.RFC3339),
		formatLabels(alert.Labels),
		formatLabels(alert.Annotations),
	)

	message := &EmailMessage{
		To:      eac.config.Recipients,
		Subject: subject,
		Body:    body,
	}

	return eac.client.SendEmail(message)
}

func (eac *EmailAlertChannel) IsEnabled() bool {
	eac.mu.RLock()
	defer eac.mu.RUnlock()
	return eac.enabled
}

func (eac *EmailAlertChannel) GetConfiguration() map[string]interface{} {
	eac.mu.RLock()
	defer eac.mu.RUnlock()
	
	return map[string]interface{}{
		"recipients": eac.config.Recipients,
		"subject":    eac.config.Subject,
		"template":   eac.config.Template,
		"enabled":    eac.enabled,
	}
}

func (wac *WebhookAlertChannel) Name() string {
	return wac.name
}

func (wac *WebhookAlertChannel) SendAlert(alert *Alert) error {
	wac.mu.RLock()
	defer wac.mu.RUnlock()

	if !wac.enabled {
		return fmt.Errorf("webhook channel is disabled")
	}

	payload := &WebhookPayload{
		Event:     "alert",
		Timestamp: time.Now(),
		Source:    "enterprise_monitor",
		Data: map[string]interface{}{
			"alert": alert,
		},
		Metadata: map[string]interface{}{
			"channel": wac.name,
		},
	}

	return wac.manager.SendWebhook(wac.config.WebhookID, payload)
}

func (wac *WebhookAlertChannel) IsEnabled() bool {
	wac.mu.RLock()
	defer wac.mu.RUnlock()
	return wac.enabled
}

func (wac *WebhookAlertChannel) GetConfiguration() map[string]interface{} {
	wac.mu.RLock()
	defer wac.mu.RUnlock()
	
	return map[string]interface{}{
		"webhook_id": wac.config.WebhookID,
		"headers":    wac.config.Headers,
		"template":   wac.config.Template,
		"enabled":    wac.enabled,
	}
}

// Client method implementations

func (sc *SlackClient) SendMessage(message *SlackMessage) error {
	jsonData, err := json.Marshal(message)
	if err != nil {
		return fmt.Errorf("failed to marshal slack message: %w", err)
	}

	resp, err := sc.client.Post(sc.webhookURL, "application/json", bytes.NewBuffer(jsonData))
	if err != nil {
		return fmt.Errorf("failed to send slack message: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("slack API returned status %d", resp.StatusCode)
	}

	return nil
}

func (ec *EmailClient) SendEmail(message *EmailMessage) error {
	// Implementation would depend on the SMTP configuration
	// This is a simplified version
	return nil
}

func (wm *WebhookManager) SendWebhook(webhookID string, payload *WebhookPayload) error {
	wm.mu.RLock()
	webhook, exists := wm.webhooks[webhookID]
	wm.mu.RUnlock()

	if !exists {
		return fmt.Errorf("webhook %s not found", webhookID)
	}

	if !webhook.Enabled {
		return fmt.Errorf("webhook %s is disabled", webhookID)
	}

	jsonData, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal webhook payload: %w", err)
	}

	req, err := http.NewRequest(webhook.Method, webhook.URL, bytes.NewBuffer(jsonData))
	if err != nil {
		return fmt.Errorf("failed to create webhook request: %w", err)
	}

	// Add headers
	for key, value := range webhook.Headers {
		req.Header.Set(key, value)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := wm.client.Do(req)
	if err != nil {
		webhook.FailureCount++
		return fmt.Errorf("failed to send webhook: %w", err)
	}
	defer resp.Body.Close()

	webhook.LastUsed = time.Now()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		webhook.SuccessCount++
	} else {
		webhook.FailureCount++
		return fmt.Errorf("webhook returned status %d", resp.StatusCode)
	}

	return nil
}

// Utility functions
func formatLabels(labels map[string]string) string {
	if len(labels) == 0 {
		return "  (none)"
	}

	result := ""
	for key, value := range labels {
		result += fmt.Sprintf("  %s: %s\n", key, value)
	}
	return result
}