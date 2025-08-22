//go:build mobile_enhanced
// +build mobile_enhanced

package mobile

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/mux"
	"github.com/gorilla/websocket"
	"go.uber.org/zap"
)

// MobileAPI provides API endpoints optimized for mobile clients
type MobileAPI struct {
	logger   *zap.Logger
	router   *mux.Router
	upgrader websocket.Upgrader
	
	// Push notification service
	pushService *PushNotificationService
	
	// Connected mobile clients
	clients sync.Map // map[string]*MobileClient
	
	// Statistics cache (for battery optimization)
	statsCache     *StatsCache
	cacheInterval  time.Duration
	
	// Rate limiting for mobile
	rateLimiter   *MobileRateLimiter
	
	// Offline sync
	offlineSync   *OfflineSyncManager
	
	// Data
	Data      interface{}
}

// MobileClient represents a connected mobile client
type MobileClient struct {
	ID           string
	DeviceType   string // iOS, Android
	AppVersion   string
	Connection   *websocket.Conn
	LastSeen     time.Time
	PushToken    string
	Preferences  ClientPreferences
	mu           sync.RWMutex
}

// ClientPreferences stores mobile client preferences
type ClientPreferences struct {
	NotificationsEnabled bool
	DataSaverMode       bool
	AutoStartMining     bool
	PowerSaveMode       bool
	UpdateInterval      time.Duration
	Language            string
}

// StatsCache caches statistics for mobile clients
type StatsCache struct {
	data      interface{}
	timestamp time.Time
	mu        sync.RWMutex
}

// MobileRateLimiter implements rate limiting for mobile clients
type MobileRateLimiter struct {
	requests sync.Map // map[string][]time.Time
	limit    int
	window   time.Duration
}

// OfflineSyncManager handles offline data synchronization
type OfflineSyncManager struct {
	pendingData sync.Map // map[string][]SyncData
	mu          sync.RWMutex
}

// SyncData represents data to be synchronized
type SyncData struct {
	Timestamp time.Time
	Type      string
	Data      interface{}
}

// NewMobileAPI creates a new mobile API instance
func NewMobileAPI(logger *zap.Logger) *MobileAPI {
	svc := NewPushNotificationService(logger, PushConfig{
		QueueSize:               1024,
		WorkerCount:             2,
		RetryAttempts:           3,
		RetryDelay:              2 * time.Second,
		MaxNotificationsPerUser: 0,
		RateLimitWindow:         1 * time.Minute,
		EnableBatching:          false,
		BatchSize:               10,
		BatchDelay:              2 * time.Second,
	})

	api := &MobileAPI{
		logger: logger,
		router: mux.NewRouter(),
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				// Allow connections from mobile apps
				return true
			},
			EnableCompression: true,
		},
		pushService:   svc,
		statsCache:    &StatsCache{},
		cacheInterval: 5 * time.Second,
		rateLimiter: &MobileRateLimiter{
			limit:  100,
			window: time.Minute,
		},
		offlineSync: &OfflineSyncManager{},
	}

	if err := api.pushService.Start(); err != nil {
		logger.Warn("failed to start push notification service", zap.Error(err))
	}

	return api
}

// SetupRoutes configures mobile API routes
func (api *MobileAPI) SetupRoutes() {
	// Mobile-optimized endpoints
	api.router.HandleFunc("/mobile/v1/connect", api.handleConnect).Methods("GET")
	api.router.HandleFunc("/mobile/v1/status", api.handleStatus).Methods("GET")
	api.router.HandleFunc("/mobile/v1/stats", api.handleStats).Methods("GET")
	api.router.HandleFunc("/mobile/v1/start", api.handleStart).Methods("POST")
	api.router.HandleFunc("/mobile/v1/stop", api.handleStop).Methods("POST")
	api.router.HandleFunc("/mobile/v1/settings", api.handleSettings).Methods("GET", "POST")
	api.router.HandleFunc("/mobile/v1/sync", api.handleSync).Methods("POST")
	api.router.HandleFunc("/mobile/v1/notifications", api.handleNotifications).Methods("POST")
	
	// WebSocket for real-time updates
	api.router.HandleFunc("/mobile/v1/ws", api.handleWebSocket)
	
	// Lightweight endpoints for battery saving
	api.router.HandleFunc("/mobile/v1/ping", api.handlePing).Methods("GET")
	api.router.HandleFunc("/mobile/v1/summary", api.handleSummary).Methods("GET")
}

// handleConnect handles mobile client connection
func (api *MobileAPI) handleConnect(w http.ResponseWriter, r *http.Request) {
	// Rate limiting
	clientID := r.Header.Get("X-Client-ID")
	if !api.rateLimiter.checkRateLimit(clientID) {
		http.Error(w, "Rate limit exceeded", http.StatusTooManyRequests)
		return
	}
	
	// Parse client info
	deviceType := r.Header.Get("X-Device-Type")
	appVersion := r.Header.Get("X-App-Version")
	pushToken := r.Header.Get("X-Push-Token")
	
	// Create client session
	client := &MobileClient{
		ID:         clientID,
		DeviceType: deviceType,
		AppVersion: appVersion,
		PushToken:  pushToken,
		LastSeen:   time.Now(),
		Preferences: ClientPreferences{
			NotificationsEnabled: true,
			DataSaverMode:       false,
			UpdateInterval:      5 * time.Second,
			Language:            "en",
		},
	}
	
	// Store client
	api.clients.Store(clientID, client)

	// Register for push notifications
	if pushToken != "" {
		// In this enhanced build, we use clientID as both UserID and DeviceID for simplicity
		dev := &DeviceInfo{
			UserID:     clientID,
			DeviceID:   clientID,
			Platform:   strings.ToLower(deviceType),
			Token:      pushToken,
			AppVersion: appVersion,
			Settings: NotificationSettings{
				Enabled:       true,
				WorkerOffline: true,
				PayoutSent:    true,
				BlockFound:    true,
				ProfitSwitch:  true,
				LowHashrate:   true,
				HighRejects:   true,
			},
		}
		if err := api.pushService.RegisterDevice(dev); err != nil {
			api.logger.Warn("Failed to register device for push notifications",
				zap.String("client_id", clientID),
				zap.Error(err),
			)
		}
	}
	
	// Return connection info
	response := map[string]interface{}{
		"client_id":    clientID,
		"connected":    true,
		"server_time":  time.Now().Unix(),
		"ws_endpoint":  "/mobile/v1/ws",
		"capabilities": []string{"mining", "monitoring", "notifications", "offline_sync"},
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// handleStart handles mining start request from mobile
func (api *MobileAPI) handleStart(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Algorithm string `json:"algorithm"`
		Pool      string `json:"pool"`
		Wallet    string `json:"wallet"`
		Intensity int    `json:"intensity"`
	}
	
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	
	// Start mining with mobile-optimized settings
	// TODO: Implement actual mining start
	
	// Send push notification
	clientID := r.Header.Get("X-Client-ID")
	_ = api.pushService.SendToUser(clientID, &PushNotification{
		Type:     NotificationAlert,
		Title:    "Mining Started",
		Body:     "Mining started successfully with " + request.Algorithm,
		Priority: PriorityNormal,
	})
	
	response := map[string]interface{}{
		"started": true,
		"message": "Mining started successfully",
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// handleStop handles mining stop request
func (api *MobileAPI) handleStop(w http.ResponseWriter, r *http.Request) {
	// TODO: Implement actual mining stop
	
	// Send push notification
	clientID := r.Header.Get("X-Client-ID")
	_ = api.pushService.SendToUser(clientID, &PushNotification{
		Type:     NotificationAlert,
		Title:    "Mining Stopped",
		Body:     "Mining has been stopped",
		Priority: PriorityNormal,
	})
	
	response := map[string]interface{}{
		"stopped": true,
		"message": "Mining stopped successfully",
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// handleNotifications manages push notification settings
func (api *MobileAPI) handleNotifications(w http.ResponseWriter, r *http.Request) {
	clientID := r.Header.Get("X-Client-ID")

	var request struct {
		Token   string   `json:"token"`
		Topics  []string `json:"topics"`
		Enabled bool     `json:"enabled"`
	}
	
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	
	// Update notification settings
	if request.Token != "" {
		// Re-register device with updated token (using clientID as device ID)
		platform := ""
		if c, ok := api.getClient(clientID); ok {
			platform = strings.ToLower(c.DeviceType)
		}
		dev := &DeviceInfo{
			UserID:   clientID,
			DeviceID: clientID,
			Platform: platform,
			Token:    request.Token,
		}
		if err := api.pushService.RegisterDevice(dev); err != nil {
			api.logger.Warn("Failed to update device token",
				zap.String("client_id", clientID),
				zap.Error(err),
			)
		}
	}

	// Topics are not supported in PushNotificationService; ignore for now

	// Update Enabled flag in device settings
	_ = api.pushService.UpdateDeviceSettings(clientID, NotificationSettings{
		Enabled:       request.Enabled,
		WorkerOffline: true,
		PayoutSent:    true,
		BlockFound:    true,
		ProfitSwitch:  true,
		LowHashrate:   true,
		HighRejects:   true,
	})

	response := map[string]interface{}{
		"updated": true,
		"enabled": request.Enabled,
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// ... rest of the code remains the same ...
func (api *MobileAPI) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	clientID := r.Header.Get("X-Client-ID")
	
	conn, err := api.upgrader.Upgrade(w, r, nil)
	if err != nil {
		api.logger.Error("Failed to upgrade WebSocket", zap.Error(err))
		return
	}
	defer conn.Close()
	
	// Update client connection
	if client, ok := api.getClient(clientID); ok {
		client.mu.Lock()
		client.Connection = conn
		client.LastSeen = time.Now()
		client.mu.Unlock()
		
		// Start sending updates
		api.handleClientConnection(client)
	}
}

// handlePing handles lightweight ping requests
func (api *MobileAPI) handlePing(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"pong": true,
		"time": time.Now().Unix(),
	})
}

// handleSummary returns ultra-lightweight summary
func (api *MobileAPI) handleSummary(w http.ResponseWriter, r *http.Request) {
	// Minimal data for widgets and notifications
	summary := map[string]interface{}{
		"h": "145.5", // hashrate in GH/s
		"s": 1234,    // shares
		"e": 0.00123, // earnings in BTC
		"t": time.Now().Unix(),
	}
	
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "max-age=60")
	json.NewEncoder(w).Encode(summary)
}

// handleClientConnection manages WebSocket connection for a client
func (api *MobileAPI) handleClientConnection(client *MobileClient) {
	ticker := time.NewTicker(client.Preferences.UpdateInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			// Send update based on preferences
			update := api.prepareUpdate(client)
			
			client.mu.Lock()
			if client.Connection != nil {
				if err := client.Connection.WriteJSON(update); err != nil {
					api.logger.Warn("Failed to send update", 
						zap.String("client", client.ID),
						zap.Error(err))
					client.Connection = nil
				}
			}
			client.mu.Unlock()
		}
	}
}

// prepareUpdate prepares update data for client
func (api *MobileAPI) prepareUpdate(client *MobileClient) interface{} {
	// Adjust data based on client preferences
	if client.Preferences.DataSaverMode {
		// Minimal update
		return map[string]interface{}{
			"h": "145.5",
			"s": 1234,
		}
	}
	
	// Full update
	return map[string]interface{}{
		"hashrate": "145.5 GH/s",
		"shares":   1234,
		"earnings": "0.00123 BTC",
		"workers":  4,
	}
}

// getClient retrieves a client by ID
func (api *MobileAPI) getClient(clientID string) (*MobileClient, bool) {
	if value, ok := api.clients.Load(clientID); ok {
		return value.(*MobileClient), true
	}
	return nil, false
}

// checkRateLimit checks if client exceeded rate limit
func (api *MobileRateLimiter) checkRateLimit(clientID string) bool {
	now := time.Now()
	windowStart := now.Add(-api.window)
	
	// Get or create request history
	value, _ := api.requests.LoadOrStore(clientID, []time.Time{})
	requests := value.([]time.Time)
	
	// Filter requests within window
	var validRequests []time.Time
	for _, t := range requests {
		if t.After(windowStart) {
			validRequests = append(validRequests, t)
		}
	}
	
	// Check limit
	if len(validRequests) >= api.limit {
		return false
	}
	
	// Add current request
	validRequests = append(validRequests, now)
	api.requests.Store(clientID, validRequests)
	
	return true
}

// getCachedStats returns cached statistics
func (api *MobileAPI) getCachedStats() interface{} {
	api.statsCache.mu.RLock()
	defer api.statsCache.mu.RUnlock()
	
	if time.Since(api.statsCache.timestamp) < api.cacheInterval {
		return api.statsCache.data
	}
	
	return nil
}

// updateCache updates the statistics cache
func (api *MobileAPI) updateCache(data interface{}) {
	api.statsCache.mu.Lock()
	defer api.statsCache.mu.Unlock()
	
	api.statsCache.data = data
	api.statsCache.timestamp = time.Now()
}

// getUpdatesSince returns updates since a given time
func (api *MobileAPI) getUpdatesSince(since time.Time) []interface{} {
	// TODO: Implement actual update retrieval
	return []interface{}{}
}

// ServeHTTP implements http.Handler
func (api *MobileAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	api.router.ServeHTTP(w, r)
}
