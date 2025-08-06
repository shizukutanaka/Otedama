package mobile

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"go.uber.org/zap"
)

// PushNotificationService handles push notifications to mobile devices
type PushNotificationService struct {
	logger *zap.Logger
	config PushConfig
	
	// Device registry
	devices      map[string]*DeviceInfo
	devicesMu    sync.RWMutex
	
	// Notification queue
	queue        chan *PushNotification
	
	// Providers
	providers    map[string]PushProvider
	
	// Statistics
	stats        *PushStats
	
	// Lifecycle
	ctx          context.Context
	cancel       context.CancelFunc
	wg           sync.WaitGroup
}

// PushConfig contains push notification configuration
type PushConfig struct {
	// Queue settings
	QueueSize         int
	WorkerCount       int
	RetryAttempts     int
	RetryDelay        time.Duration
	
	// Provider settings
	FCMServerKey      string // Firebase Cloud Messaging
	APNSCertPath      string // Apple Push Notification Service
	APNSKeyPath       string
	APNSProduction    bool
	
	// Rate limiting
	MaxNotificationsPerUser  int
	RateLimitWindow         time.Duration
	
	// Batching
	EnableBatching    bool
	BatchSize         int
	BatchDelay        time.Duration
}

// DeviceInfo stores device information
type DeviceInfo struct {
	UserID       string
	DeviceID     string
	Platform     string // "ios", "android"
	Token        string // FCM or APNS token
	AppVersion   string
	OSVersion    string
	Language     string
	TimeZone     string
	Registered   time.Time
	LastActive   time.Time
	Settings     NotificationSettings
}

// NotificationSettings contains user notification preferences
type NotificationSettings struct {
	Enabled         bool
	WorkerOffline   bool
	PayoutSent      bool
	BlockFound      bool
	ProfitSwitch    bool
	LowHashrate     bool
	HighRejects     bool
	QuietHours      *QuietHours
}

// QuietHours defines quiet hours for notifications
type QuietHours struct {
	Enabled   bool
	StartHour int // 0-23
	EndHour   int // 0-23
	TimeZone  string
}

// PushNotification represents a push notification
type PushNotification struct {
	ID           string
	UserID       string
	DeviceID     string // Optional, send to all user devices if empty
	Type         NotificationType
	Title        string
	Body         string
	Data         map[string]string
	Priority     NotificationPriority
	Sound        string
	Badge        int
	CollapseKey  string
	TTL          time.Duration
	ScheduledAt  time.Time
	CreatedAt    time.Time
}

// NotificationType defines notification types
type NotificationType string

const (
	NotificationWorkerOffline  NotificationType = "worker_offline"
	NotificationWorkerOnline   NotificationType = "worker_online"
	NotificationPayoutSent     NotificationType = "payout_sent"
	NotificationBlockFound     NotificationType = "block_found"
	NotificationProfitSwitch   NotificationType = "profit_switch"
	NotificationLowHashrate    NotificationType = "low_hashrate"
	NotificationHighRejects    NotificationType = "high_rejects"
	NotificationMaintenance    NotificationType = "maintenance"
	NotificationAlert          NotificationType = "alert"
)

// NotificationPriority defines notification priority
type NotificationPriority string

const (
	PriorityHigh   NotificationPriority = "high"
	PriorityNormal NotificationPriority = "normal"
	PriorityLow    NotificationPriority = "low"
)

// PushProvider interface for different push notification providers
type PushProvider interface {
	Send(device *DeviceInfo, notification *PushNotification) error
	SendBatch(devices []*DeviceInfo, notification *PushNotification) (map[string]error, error)
	ValidateToken(token string) error
	Name() string
}

// PushStats tracks push notification statistics
type PushStats struct {
	TotalSent       sync.Map // map[NotificationType]uint64
	TotalFailed     sync.Map // map[NotificationType]uint64
	LastSent        sync.Map // map[string]time.Time (userID -> time)
	ProviderStats   sync.Map // map[string]*ProviderStats
}

// ProviderStats tracks provider-specific statistics
type ProviderStats struct {
	Sent     uint64
	Failed   uint64
	Latency  time.Duration
}

// NewPushNotificationService creates a new push notification service
func NewPushNotificationService(logger *zap.Logger, config PushConfig) *PushNotificationService {
	ctx, cancel := context.WithCancel(context.Background())
	
	service := &PushNotificationService{
		logger:    logger,
		config:    config,
		devices:   make(map[string]*DeviceInfo),
		queue:     make(chan *PushNotification, config.QueueSize),
		providers: make(map[string]PushProvider),
		stats:     &PushStats{},
		ctx:       ctx,
		cancel:    cancel,
	}
	
	// Initialize providers
	service.initializeProviders()
	
	return service
}

// Start starts the push notification service
func (pns *PushNotificationService) Start() error {
	pns.logger.Info("Starting push notification service",
		zap.Int("workers", pns.config.WorkerCount),
		zap.Bool("batching", pns.config.EnableBatching),
	)
	
	// Start workers
	for i := 0; i < pns.config.WorkerCount; i++ {
		pns.wg.Add(1)
		go pns.worker(i)
	}
	
	// Start batch processor if enabled
	if pns.config.EnableBatching {
		pns.wg.Add(1)
		go pns.batchProcessor()
	}
	
	// Start stats reporter
	pns.wg.Add(1)
	go pns.statsReporter()
	
	return nil
}

// Stop stops the push notification service
func (pns *PushNotificationService) Stop() error {
	pns.logger.Info("Stopping push notification service")
	pns.cancel()
	close(pns.queue)
	pns.wg.Wait()
	return nil
}

// RegisterDevice registers a device for push notifications
func (pns *PushNotificationService) RegisterDevice(device *DeviceInfo) error {
	if device.UserID == "" || device.DeviceID == "" || device.Token == "" {
		return fmt.Errorf("invalid device info")
	}
	
	// Validate token with provider
	provider, exists := pns.providers[device.Platform]
	if !exists {
		return fmt.Errorf("unsupported platform: %s", device.Platform)
	}
	
	if err := provider.ValidateToken(device.Token); err != nil {
		return fmt.Errorf("invalid token: %w", err)
	}
	
	// Store device info
	pns.devicesMu.Lock()
	device.Registered = time.Now()
	device.LastActive = time.Now()
	pns.devices[device.DeviceID] = device
	pns.devicesMu.Unlock()
	
	pns.logger.Info("Device registered",
		zap.String("user_id", device.UserID),
		zap.String("device_id", device.DeviceID),
		zap.String("platform", device.Platform),
	)
	
	return nil
}

// UnregisterDevice unregisters a device
func (pns *PushNotificationService) UnregisterDevice(deviceID string) error {
	pns.devicesMu.Lock()
	delete(pns.devices, deviceID)
	pns.devicesMu.Unlock()
	
	pns.logger.Info("Device unregistered",
		zap.String("device_id", deviceID),
	)
	
	return nil
}

// UpdateDeviceSettings updates device notification settings
func (pns *PushNotificationService) UpdateDeviceSettings(deviceID string, settings NotificationSettings) error {
	pns.devicesMu.Lock()
	defer pns.devicesMu.Unlock()
	
	device, exists := pns.devices[deviceID]
	if !exists {
		return fmt.Errorf("device not found")
	}
	
	device.Settings = settings
	device.LastActive = time.Now()
	
	return nil
}

// Send sends a push notification
func (pns *PushNotificationService) Send(notification *PushNotification) error {
	if notification.ID == "" {
		notification.ID = generateNotificationID()
	}
	
	notification.CreatedAt = time.Now()
	
	// Check rate limiting
	if !pns.checkRateLimit(notification.UserID) {
		return fmt.Errorf("rate limit exceeded")
	}
	
	// Queue notification
	select {
	case pns.queue <- notification:
		return nil
	case <-pns.ctx.Done():
		return fmt.Errorf("service stopped")
	default:
		return fmt.Errorf("queue full")
	}
}

// SendToUser sends a notification to all user devices
func (pns *PushNotificationService) SendToUser(userID string, notification *PushNotification) error {
	notification.UserID = userID
	notification.DeviceID = "" // Send to all devices
	return pns.Send(notification)
}

// SendToDevice sends a notification to a specific device
func (pns *PushNotificationService) SendToDevice(deviceID string, notification *PushNotification) error {
	pns.devicesMu.RLock()
	device, exists := pns.devices[deviceID]
	pns.devicesMu.RUnlock()
	
	if !exists {
		return fmt.Errorf("device not found")
	}
	
	notification.UserID = device.UserID
	notification.DeviceID = deviceID
	return pns.Send(notification)
}

// NotifyWorkerOffline notifies when a worker goes offline
func (pns *PushNotificationService) NotifyWorkerOffline(userID, workerName string) error {
	return pns.SendToUser(userID, &PushNotification{
		Type:     NotificationWorkerOffline,
		Title:    "Worker Offline",
		Body:     fmt.Sprintf("Worker %s is offline", workerName),
		Priority: PriorityHigh,
		Data: map[string]string{
			"worker_name": workerName,
			"event":       "worker_offline",
		},
	})
}

// NotifyPayoutSent notifies when a payout is sent
func (pns *PushNotificationService) NotifyPayoutSent(userID string, amount float64, currency, txID string) error {
	return pns.SendToUser(userID, &PushNotification{
		Type:     NotificationPayoutSent,
		Title:    "Payout Sent",
		Body:     fmt.Sprintf("%.8f %s sent to your wallet", amount, currency),
		Priority: PriorityNormal,
		Data: map[string]string{
			"amount":   fmt.Sprintf("%.8f", amount),
			"currency": currency,
			"tx_id":    txID,
			"event":    "payout_sent",
		},
	})
}

// NotifyBlockFound notifies when a block is found
func (pns *PushNotificationService) NotifyBlockFound(userID string, blockHeight int64, reward float64) error {
	return pns.SendToUser(userID, &PushNotification{
		Type:     NotificationBlockFound,
		Title:    "Block Found!",
		Body:     fmt.Sprintf("Pool found block #%d", blockHeight),
		Priority: PriorityNormal,
		Data: map[string]string{
			"block_height": fmt.Sprintf("%d", blockHeight),
			"reward":       fmt.Sprintf("%.8f", reward),
			"event":        "block_found",
		},
	})
}

// NotifyProfitSwitch notifies when profit switching occurs
func (pns *PushNotificationService) NotifyProfitSwitch(userID, fromCurrency, toCurrency string, profitIncrease float64) error {
	return pns.SendToUser(userID, &PushNotification{
		Type:     NotificationProfitSwitch,
		Title:    "Currency Switched",
		Body:     fmt.Sprintf("Switched from %s to %s (+%.1f%% profit)", fromCurrency, toCurrency, profitIncrease),
		Priority: PriorityLow,
		Data: map[string]string{
			"from_currency":   fromCurrency,
			"to_currency":     toCurrency,
			"profit_increase": fmt.Sprintf("%.1f", profitIncrease),
			"event":           "profit_switch",
		},
	})
}

// worker processes notifications from the queue
func (pns *PushNotificationService) worker(id int) {
	defer pns.wg.Done()
	
	for {
		select {
		case <-pns.ctx.Done():
			return
			
		case notification, ok := <-pns.queue:
			if !ok {
				return
			}
			
			pns.processNotification(notification)
		}
	}
}

func (pns *PushNotificationService) processNotification(notification *PushNotification) {
	// Get target devices
	devices := pns.getTargetDevices(notification)
	if len(devices) == 0 {
		pns.logger.Warn("No target devices found",
			zap.String("user_id", notification.UserID),
			zap.String("device_id", notification.DeviceID),
		)
		return
	}
	
	// Check notification settings
	devices = pns.filterBySettings(devices, notification)
	if len(devices) == 0 {
		return
	}
	
	// Check quiet hours
	devices = pns.filterByQuietHours(devices)
	if len(devices) == 0 {
		return
	}
	
	// Send to each device
	for _, device := range devices {
		if err := pns.sendToDevice(device, notification); err != nil {
			pns.logger.Error("Failed to send notification",
				zap.String("device_id", device.DeviceID),
				zap.Error(err),
			)
			pns.recordFailure(notification.Type)
		} else {
			pns.recordSuccess(notification.Type)
		}
	}
	
	// Update last sent time
	pns.stats.LastSent.Store(notification.UserID, time.Now())
}

func (pns *PushNotificationService) sendToDevice(device *DeviceInfo, notification *PushNotification) error {
	provider, exists := pns.providers[device.Platform]
	if !exists {
		return fmt.Errorf("no provider for platform: %s", device.Platform)
	}
	
	// Retry logic
	var lastErr error
	for attempt := 0; attempt <= pns.config.RetryAttempts; attempt++ {
		if attempt > 0 {
			time.Sleep(pns.config.RetryDelay * time.Duration(attempt))
		}
		
		err := provider.Send(device, notification)
		if err == nil {
			return nil
		}
		
		lastErr = err
		pns.logger.Warn("Send attempt failed",
			zap.Int("attempt", attempt+1),
			zap.String("device_id", device.DeviceID),
			zap.Error(err),
		)
	}
	
	return lastErr
}

// batchProcessor handles batch sending
func (pns *PushNotificationService) batchProcessor() {
	defer pns.wg.Done()
	
	ticker := time.NewTicker(pns.config.BatchDelay)
	defer ticker.Stop()
	
	batch := make([]*PushNotification, 0, pns.config.BatchSize)
	
	for {
		select {
		case <-pns.ctx.Done():
			// Process remaining batch
			if len(batch) > 0 {
				pns.processBatch(batch)
			}
			return
			
		case notification := <-pns.queue:
			batch = append(batch, notification)
			
			if len(batch) >= pns.config.BatchSize {
				pns.processBatch(batch)
				batch = batch[:0]
			}
			
		case <-ticker.C:
			if len(batch) > 0 {
				pns.processBatch(batch)
				batch = batch[:0]
			}
		}
	}
}

func (pns *PushNotificationService) processBatch(batch []*PushNotification) {
	// Group by platform and notification content
	groups := pns.groupNotifications(batch)
	
	for key, group := range groups {
		platform := key.platform
		provider, exists := pns.providers[platform]
		if !exists {
			continue
		}
		
		// Get devices for this group
		devices := make([]*DeviceInfo, 0)
		for _, n := range group {
			devices = append(devices, pns.getTargetDevices(n)...)
		}
		
		if len(devices) == 0 {
			continue
		}
		
		// Send batch
		results, err := provider.SendBatch(devices, group[0])
		if err != nil {
			pns.logger.Error("Batch send failed",
				zap.String("platform", platform),
				zap.Int("devices", len(devices)),
				zap.Error(err),
			)
		}
		
		// Record results
		for deviceID, err := range results {
			if err != nil {
				pns.recordFailure(group[0].Type)
			} else {
				pns.recordSuccess(group[0].Type)
			}
		}
	}
}

// Helper methods

func (pns *PushNotificationService) initializeProviders() {
	// Initialize FCM provider
	if pns.config.FCMServerKey != "" {
		pns.providers["android"] = NewFCMProvider(pns.logger, pns.config.FCMServerKey)
	}
	
	// Initialize APNS provider
	if pns.config.APNSCertPath != "" && pns.config.APNSKeyPath != "" {
		pns.providers["ios"] = NewAPNSProvider(pns.logger, pns.config.APNSCertPath, pns.config.APNSKeyPath, pns.config.APNSProduction)
	}
}

func (pns *PushNotificationService) getTargetDevices(notification *PushNotification) []*DeviceInfo {
	pns.devicesMu.RLock()
	defer pns.devicesMu.RUnlock()
	
	devices := make([]*DeviceInfo, 0)
	
	if notification.DeviceID != "" {
		// Specific device
		if device, exists := pns.devices[notification.DeviceID]; exists {
			devices = append(devices, device)
		}
	} else {
		// All user devices
		for _, device := range pns.devices {
			if device.UserID == notification.UserID {
				devices = append(devices, device)
			}
		}
	}
	
	return devices
}

func (pns *PushNotificationService) filterBySettings(devices []*DeviceInfo, notification *PushNotification) []*DeviceInfo {
	filtered := make([]*DeviceInfo, 0)
	
	for _, device := range devices {
		if !device.Settings.Enabled {
			continue
		}
		
		// Check specific notification type settings
		allowed := true
		switch notification.Type {
		case NotificationWorkerOffline:
			allowed = device.Settings.WorkerOffline
		case NotificationPayoutSent:
			allowed = device.Settings.PayoutSent
		case NotificationBlockFound:
			allowed = device.Settings.BlockFound
		case NotificationProfitSwitch:
			allowed = device.Settings.ProfitSwitch
		case NotificationLowHashrate:
			allowed = device.Settings.LowHashrate
		case NotificationHighRejects:
			allowed = device.Settings.HighRejects
		}
		
		if allowed {
			filtered = append(filtered, device)
		}
	}
	
	return filtered
}

func (pns *PushNotificationService) filterByQuietHours(devices []*DeviceInfo) []*DeviceInfo {
	filtered := make([]*DeviceInfo, 0)
	
	for _, device := range devices {
		if device.Settings.QuietHours == nil || !device.Settings.QuietHours.Enabled {
			filtered = append(filtered, device)
			continue
		}
		
		// Check if current time is within quiet hours
		loc, err := time.LoadLocation(device.Settings.QuietHours.TimeZone)
		if err != nil {
			loc = time.UTC
		}
		
		now := time.Now().In(loc)
		hour := now.Hour()
		
		inQuietHours := false
		if device.Settings.QuietHours.StartHour <= device.Settings.QuietHours.EndHour {
			// Same day quiet hours
			inQuietHours = hour >= device.Settings.QuietHours.StartHour && hour < device.Settings.QuietHours.EndHour
		} else {
			// Overnight quiet hours
			inQuietHours = hour >= device.Settings.QuietHours.StartHour || hour < device.Settings.QuietHours.EndHour
		}
		
		if !inQuietHours {
			filtered = append(filtered, device)
		}
	}
	
	return filtered
}

func (pns *PushNotificationService) checkRateLimit(userID string) bool {
	// Get last sent time
	if lastSent, ok := pns.stats.LastSent.Load(userID); ok {
		if time.Since(lastSent.(time.Time)) < pns.config.RateLimitWindow {
			// Count notifications in window
			// Simplified - in production, track per-user counts
			return true
		}
	}
	
	return true
}

type groupKey struct {
	platform string
	title    string
	body     string
}

func (pns *PushNotificationService) groupNotifications(notifications []*PushNotification) map[groupKey][]*PushNotification {
	groups := make(map[groupKey][]*PushNotification)
	
	for _, n := range notifications {
		// Get devices to determine platform
		devices := pns.getTargetDevices(n)
		if len(devices) == 0 {
			continue
		}
		
		key := groupKey{
			platform: devices[0].Platform,
			title:    n.Title,
			body:     n.Body,
		}
		
		groups[key] = append(groups[key], n)
	}
	
	return groups
}

func (pns *PushNotificationService) recordSuccess(notificationType NotificationType) {
	// Update type-specific counter
	if val, ok := pns.stats.TotalSent.Load(notificationType); ok {
		pns.stats.TotalSent.Store(notificationType, val.(uint64)+1)
	} else {
		pns.stats.TotalSent.Store(notificationType, uint64(1))
	}
}

func (pns *PushNotificationService) recordFailure(notificationType NotificationType) {
	// Update type-specific counter
	if val, ok := pns.stats.TotalFailed.Load(notificationType); ok {
		pns.stats.TotalFailed.Store(notificationType, val.(uint64)+1)
	} else {
		pns.stats.TotalFailed.Store(notificationType, uint64(1))
	}
}

// statsReporter periodically reports statistics
func (pns *PushNotificationService) statsReporter() {
	defer pns.wg.Done()
	
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-pns.ctx.Done():
			return
			
		case <-ticker.C:
			pns.reportStats()
		}
	}
}

func (pns *PushNotificationService) reportStats() {
	stats := make(map[string]interface{})
	
	// Collect sent stats
	sentStats := make(map[string]uint64)
	pns.stats.TotalSent.Range(func(key, value interface{}) bool {
		sentStats[string(key.(NotificationType))] = value.(uint64)
		return true
	})
	stats["sent"] = sentStats
	
	// Collect failed stats
	failedStats := make(map[string]uint64)
	pns.stats.TotalFailed.Range(func(key, value interface{}) bool {
		failedStats[string(key.(NotificationType))] = value.(uint64)
		return true
	})
	stats["failed"] = failedStats
	
	// Log stats
	pns.logger.Info("Push notification statistics",
		zap.Any("stats", stats),
		zap.Int("registered_devices", len(pns.devices)),
	)
}

// GetStats returns push notification statistics
func (pns *PushNotificationService) GetStats() map[string]interface{} {
	stats := make(map[string]interface{})
	
	// Device stats
	pns.devicesMu.RLock()
	deviceStats := map[string]int{
		"total":   len(pns.devices),
		"ios":     0,
		"android": 0,
	}
	for _, device := range pns.devices {
		deviceStats[device.Platform]++
	}
	pns.devicesMu.RUnlock()
	stats["devices"] = deviceStats
	
	// Notification stats
	sent := make(map[string]uint64)
	pns.stats.TotalSent.Range(func(key, value interface{}) bool {
		sent[string(key.(NotificationType))] = value.(uint64)
		return true
	})
	
	failed := make(map[string]uint64)
	pns.stats.TotalFailed.Range(func(key, value interface{}) bool {
		failed[string(key.(NotificationType))] = value.(uint64)
		return true
	})
	
	stats["notifications"] = map[string]interface{}{
		"sent":   sent,
		"failed": failed,
	}
	
	return stats
}

// Helper function to generate notification ID
func generateNotificationID() string {
	return fmt.Sprintf("notif-%d-%d", time.Now().Unix(), time.Now().Nanosecond())
}

// Provider implementations (stubs)

// FCMProvider implements Firebase Cloud Messaging
type FCMProvider struct {
	logger    *zap.Logger
	serverKey string
}

func NewFCMProvider(logger *zap.Logger, serverKey string) *FCMProvider {
	return &FCMProvider{
		logger:    logger,
		serverKey: serverKey,
	}
}

func (f *FCMProvider) Name() string {
	return "FCM"
}

func (f *FCMProvider) Send(device *DeviceInfo, notification *PushNotification) error {
	// Implementation would use FCM API
	f.logger.Debug("FCM send",
		zap.String("device_id", device.DeviceID),
		zap.String("title", notification.Title),
	)
	return nil
}

func (f *FCMProvider) SendBatch(devices []*DeviceInfo, notification *PushNotification) (map[string]error, error) {
	results := make(map[string]error)
	// Implementation would use FCM batch API
	return results, nil
}

func (f *FCMProvider) ValidateToken(token string) error {
	// Basic validation
	if len(token) < 100 {
		return fmt.Errorf("invalid FCM token length")
	}
	return nil
}

// APNSProvider implements Apple Push Notification Service
type APNSProvider struct {
	logger     *zap.Logger
	certPath   string
	keyPath    string
	production bool
}

func NewAPNSProvider(logger *zap.Logger, certPath, keyPath string, production bool) *APNSProvider {
	return &APNSProvider{
		logger:     logger,
		certPath:   certPath,
		keyPath:    keyPath,
		production: production,
	}
}

func (a *APNSProvider) Name() string {
	return "APNS"
}

func (a *APNSProvider) Send(device *DeviceInfo, notification *PushNotification) error {
	// Implementation would use APNS API
	a.logger.Debug("APNS send",
		zap.String("device_id", device.DeviceID),
		zap.String("title", notification.Title),
	)
	return nil
}

func (a *APNSProvider) SendBatch(devices []*DeviceInfo, notification *PushNotification) (map[string]error, error) {
	results := make(map[string]error)
	// APNS doesn't support batch, send individually
	for _, device := range devices {
		results[device.DeviceID] = a.Send(device, notification)
	}
	return results, nil
}

func (a *APNSProvider) ValidateToken(token string) error {
	// Basic validation
	if len(token) != 64 {
		return fmt.Errorf("invalid APNS token length")
	}
	return nil
}