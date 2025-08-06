package mobile

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/mux"
	"github.com/gorilla/websocket"
	"github.com/shizukutanaka/Otedama/internal/analytics"
	"github.com/shizukutanaka/Otedama/internal/mining"
	"github.com/shizukutanaka/Otedama/internal/pool"
	"github.com/shizukutanaka/Otedama/internal/profit"
	"go.uber.org/zap"
)

// MobileAPI provides API endpoints for mobile applications
type MobileAPI struct {
	logger         *zap.Logger
	config         MobileAPIConfig
	
	// Dependencies
	poolManager    *pool.Manager
	miningEngine   *mining.Engine
	analytics      *analytics.AnalyticsEngine
	profitSwitcher *profit.ProfitSwitcher
	
	// WebSocket
	upgrader       websocket.Upgrader
	wsConnections  map[string]*WSConnection
	
	// Rate limiting
	rateLimiter    *RateLimiter
	
	// Authentication
	authManager    *AuthManager
}

// MobileAPIConfig contains mobile API configuration
type MobileAPIConfig struct {
	// Server settings
	ListenAddress     string
	EnableTLS         bool
	TLSCertFile       string
	TLSKeyFile        string
	
	// Authentication
	JWTSecret         string
	TokenExpiry       time.Duration
	
	// Rate limiting
	RateLimit         int           // Requests per minute
	BurstLimit        int           // Burst capacity
	
	// WebSocket
	WSReadTimeout     time.Duration
	WSWriteTimeout    time.Duration
	WSMaxMessageSize  int64
}

// WSConnection represents a WebSocket connection
type WSConnection struct {
	ID         string
	UserID     string
	Conn       *websocket.Conn
	Send       chan []byte
	LastActive time.Time
}

// AuthManager handles authentication
type AuthManager struct {
	jwtSecret []byte
	expiry    time.Duration
}

// RateLimiter implements rate limiting
type RateLimiter struct {
	requests map[string]*UserRateLimit
}

// UserRateLimit tracks rate limit for a user
type UserRateLimit struct {
	Tokens    int
	LastReset time.Time
}

// MobileAPIDeps contains dependencies for mobile API
type MobileAPIDeps struct {
	PoolManager    *pool.Manager
	MiningEngine   *mining.Engine
	Analytics      *analytics.AnalyticsEngine
	ProfitSwitcher *profit.ProfitSwitcher
}

// Response structures

// APIResponse is the standard API response format
type APIResponse struct {
	Success bool        `json:"success"`
	Data    interface{} `json:"data,omitempty"`
	Error   string      `json:"error,omitempty"`
}

// DashboardData contains dashboard information
type DashboardData struct {
	Overview      OverviewData           `json:"overview"`
	Workers       []WorkerSummary        `json:"workers"`
	Earnings      EarningsData           `json:"earnings"`
	PoolStats     PoolStatistics         `json:"pool_stats"`
	Notifications []Notification         `json:"notifications"`
}

// OverviewData contains overview metrics
type OverviewData struct {
	TotalHashrate    float64 `json:"total_hashrate"`
	ActiveWorkers    int     `json:"active_workers"`
	UnpaidBalance    float64 `json:"unpaid_balance"`
	EstimatedEarning float64 `json:"estimated_earning"` // 24h estimate
	Currency         string  `json:"currency"`
}

// WorkerSummary contains worker summary data
type WorkerSummary struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	Hashrate     float64   `json:"hashrate"`
	Status       string    `json:"status"`
	LastSeen     time.Time `json:"last_seen"`
	Shares       ShareInfo `json:"shares"`
	Efficiency   float64   `json:"efficiency"`
}

// ShareInfo contains share statistics
type ShareInfo struct {
	Valid    uint64 `json:"valid"`
	Invalid  uint64 `json:"invalid"`
	Stale    uint64 `json:"stale"`
	Ratio    float64 `json:"ratio"`
}

// EarningsData contains earnings information
type EarningsData struct {
	Today        float64               `json:"today"`
	Yesterday    float64               `json:"yesterday"`
	ThisWeek     float64               `json:"this_week"`
	ThisMonth    float64               `json:"this_month"`
	History      []EarningHistoryPoint `json:"history"`
}

// EarningHistoryPoint represents a point in earning history
type EarningHistoryPoint struct {
	Date     time.Time `json:"date"`
	Amount   float64   `json:"amount"`
	Currency string    `json:"currency"`
	TxID     string    `json:"tx_id,omitempty"`
}

// PoolStatistics contains pool-wide statistics
type PoolStatistics struct {
	TotalHashrate  float64 `json:"total_hashrate"`
	ActiveMiners   int     `json:"active_miners"`
	BlocksFound24h int     `json:"blocks_found_24h"`
	PoolFee        float64 `json:"pool_fee"`
	MinPayout      float64 `json:"min_payout"`
}

// Notification represents a user notification
type Notification struct {
	ID        string    `json:"id"`
	Type      string    `json:"type"`
	Title     string    `json:"title"`
	Message   string    `json:"message"`
	Timestamp time.Time `json:"timestamp"`
	Read      bool      `json:"read"`
}

// NewMobileAPI creates a new mobile API instance
func NewMobileAPI(logger *zap.Logger, config MobileAPIConfig, deps MobileAPIDeps) *MobileAPI {
	api := &MobileAPI{
		logger:         logger,
		config:         config,
		poolManager:    deps.PoolManager,
		miningEngine:   deps.MiningEngine,
		analytics:      deps.Analytics,
		profitSwitcher: deps.ProfitSwitcher,
		wsConnections:  make(map[string]*WSConnection),
		upgrader: websocket.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
			CheckOrigin: func(r *http.Request) bool {
				// Allow connections from mobile apps
				return true
			},
		},
		rateLimiter: &RateLimiter{
			requests: make(map[string]*UserRateLimit),
		},
		authManager: &AuthManager{
			jwtSecret: []byte(config.JWTSecret),
			expiry:    config.TokenExpiry,
		},
	}
	
	return api
}

// Start starts the mobile API server
func (api *MobileAPI) Start() error {
	router := mux.NewRouter()
	
	// Setup routes
	api.setupRoutes(router)
	
	// Start WebSocket handler
	go api.handleWebSocketMessages()
	
	// Start server
	api.logger.Info("Starting mobile API server",
		zap.String("address", api.config.ListenAddress),
		zap.Bool("tls", api.config.EnableTLS),
	)
	
	if api.config.EnableTLS {
		return http.ListenAndServeTLS(
			api.config.ListenAddress,
			api.config.TLSCertFile,
			api.config.TLSKeyFile,
			router,
		)
	}
	
	return http.ListenAndServe(api.config.ListenAddress, router)
}

// setupRoutes sets up all API routes
func (api *MobileAPI) setupRoutes(router *mux.Router) {
	// API v1 routes
	v1 := router.PathPrefix("/api/v1").Subrouter()
	
	// Public routes
	v1.HandleFunc("/auth/login", api.handleLogin).Methods("POST")
	v1.HandleFunc("/auth/register", api.handleRegister).Methods("POST")
	v1.HandleFunc("/auth/refresh", api.handleRefreshToken).Methods("POST")
	
	// Protected routes (require authentication)
	protected := v1.PathPrefix("").Subrouter()
	protected.Use(api.authMiddleware)
	protected.Use(api.rateLimitMiddleware)
	
	// Dashboard
	protected.HandleFunc("/dashboard", api.handleGetDashboard).Methods("GET")
	protected.HandleFunc("/dashboard/refresh", api.handleRefreshDashboard).Methods("POST")
	
	// Workers
	protected.HandleFunc("/workers", api.handleGetWorkers).Methods("GET")
	protected.HandleFunc("/workers/{id}", api.handleGetWorker).Methods("GET")
	protected.HandleFunc("/workers/{id}/restart", api.handleRestartWorker).Methods("POST")
	
	// Earnings
	protected.HandleFunc("/earnings", api.handleGetEarnings).Methods("GET")
	protected.HandleFunc("/earnings/history", api.handleGetEarningHistory).Methods("GET")
	protected.HandleFunc("/payouts", api.handleGetPayouts).Methods("GET")
	
	// Settings
	protected.HandleFunc("/settings", api.handleGetSettings).Methods("GET")
	protected.HandleFunc("/settings", api.handleUpdateSettings).Methods("PUT")
	protected.HandleFunc("/settings/payout", api.handleUpdatePayoutSettings).Methods("PUT")
	
	// Notifications
	protected.HandleFunc("/notifications", api.handleGetNotifications).Methods("GET")
	protected.HandleFunc("/notifications/{id}/read", api.handleMarkNotificationRead).Methods("POST")
	protected.HandleFunc("/notifications/settings", api.handleUpdateNotificationSettings).Methods("PUT")
	
	// Statistics
	protected.HandleFunc("/stats/pool", api.handleGetPoolStats).Methods("GET")
	protected.HandleFunc("/stats/profit", api.handleGetProfitStats).Methods("GET")
	protected.HandleFunc("/stats/performance", api.handleGetPerformanceStats).Methods("GET")
	
	// WebSocket endpoint
	protected.HandleFunc("/ws", api.handleWebSocket)
	
	// Health check
	router.HandleFunc("/health", api.handleHealthCheck).Methods("GET")
}

// Authentication handlers

func (api *MobileAPI) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
		DeviceID string `json:"device_id"`
	}
	
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		api.sendError(w, http.StatusBadRequest, "Invalid request")
		return
	}
	
	// Authenticate user (simplified)
	user, err := api.authenticateUser(req.Username, req.Password)
	if err != nil {
		api.sendError(w, http.StatusUnauthorized, "Invalid credentials")
		return
	}
	
	// Generate token
	token, err := api.authManager.GenerateToken(user.ID, req.DeviceID)
	if err != nil {
		api.sendError(w, http.StatusInternalServerError, "Failed to generate token")
		return
	}
	
	api.sendSuccess(w, map[string]interface{}{
		"token":      token,
		"user_id":    user.ID,
		"expires_at": time.Now().Add(api.config.TokenExpiry),
	})
}

func (api *MobileAPI) handleRegister(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Email    string `json:"email"`
		Password string `json:"password"`
		WalletAddress string `json:"wallet_address"`
	}
	
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		api.sendError(w, http.StatusBadRequest, "Invalid request")
		return
	}
	
	// Create user (simplified)
	user, err := api.createUser(req.Username, req.Email, req.Password, req.WalletAddress)
	if err != nil {
		api.sendError(w, http.StatusBadRequest, err.Error())
		return
	}
	
	api.sendSuccess(w, map[string]interface{}{
		"user_id": user.ID,
		"message": "Registration successful. Please login.",
	})
}

func (api *MobileAPI) handleRefreshToken(w http.ResponseWriter, r *http.Request) {
	// Extract token from header
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		api.sendError(w, http.StatusUnauthorized, "Missing authorization header")
		return
	}
	
	// Refresh token
	newToken, err := api.authManager.RefreshToken(authHeader)
	if err != nil {
		api.sendError(w, http.StatusUnauthorized, "Invalid token")
		return
	}
	
	api.sendSuccess(w, map[string]interface{}{
		"token":      newToken,
		"expires_at": time.Now().Add(api.config.TokenExpiry),
	})
}

// Dashboard handlers

func (api *MobileAPI) handleGetDashboard(w http.ResponseWriter, r *http.Request) {
	userID := api.getUserID(r)
	
	// Get dashboard data
	dashboard, err := api.getDashboardData(userID)
	if err != nil {
		api.sendError(w, http.StatusInternalServerError, "Failed to get dashboard data")
		return
	}
	
	api.sendSuccess(w, dashboard)
}

func (api *MobileAPI) handleRefreshDashboard(w http.ResponseWriter, r *http.Request) {
	userID := api.getUserID(r)
	
	// Force refresh of dashboard data
	dashboard, err := api.getDashboardData(userID)
	if err != nil {
		api.sendError(w, http.StatusInternalServerError, "Failed to refresh dashboard")
		return
	}
	
	// Send update via WebSocket too
	api.broadcastToUser(userID, "dashboard_update", dashboard)
	
	api.sendSuccess(w, dashboard)
}

// Worker handlers

func (api *MobileAPI) handleGetWorkers(w http.ResponseWriter, r *http.Request) {
	userID := api.getUserID(r)
	
	// Get query parameters
	status := r.URL.Query().Get("status")
	sortBy := r.URL.Query().Get("sort_by")
	
	workers, err := api.getWorkers(userID, status, sortBy)
	if err != nil {
		api.sendError(w, http.StatusInternalServerError, "Failed to get workers")
		return
	}
	
	api.sendSuccess(w, workers)
}

func (api *MobileAPI) handleGetWorker(w http.ResponseWriter, r *http.Request) {
	userID := api.getUserID(r)
	workerID := mux.Vars(r)["id"]
	
	worker, err := api.getWorkerDetails(userID, workerID)
	if err != nil {
		api.sendError(w, http.StatusNotFound, "Worker not found")
		return
	}
	
	api.sendSuccess(w, worker)
}

func (api *MobileAPI) handleRestartWorker(w http.ResponseWriter, r *http.Request) {
	userID := api.getUserID(r)
	workerID := mux.Vars(r)["id"]
	
	if err := api.restartWorker(userID, workerID); err != nil {
		api.sendError(w, http.StatusInternalServerError, "Failed to restart worker")
		return
	}
	
	api.sendSuccess(w, map[string]string{
		"message": "Worker restart initiated",
	})
}

// Earnings handlers

func (api *MobileAPI) handleGetEarnings(w http.ResponseWriter, r *http.Request) {
	userID := api.getUserID(r)
	
	// Get time range
	period := r.URL.Query().Get("period")
	if period == "" {
		period = "week"
	}
	
	earnings, err := api.getEarnings(userID, period)
	if err != nil {
		api.sendError(w, http.StatusInternalServerError, "Failed to get earnings")
		return
	}
	
	api.sendSuccess(w, earnings)
}

func (api *MobileAPI) handleGetEarningHistory(w http.ResponseWriter, r *http.Request) {
	userID := api.getUserID(r)
	
	// Get pagination
	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil {
			limit = parsed
		}
	}
	
	offset := 0
	if o := r.URL.Query().Get("offset"); o != "" {
		if parsed, err := strconv.Atoi(o); err == nil {
			offset = parsed
		}
	}
	
	history, err := api.getEarningHistory(userID, limit, offset)
	if err != nil {
		api.sendError(w, http.StatusInternalServerError, "Failed to get earning history")
		return
	}
	
	api.sendSuccess(w, history)
}

func (api *MobileAPI) handleGetPayouts(w http.ResponseWriter, r *http.Request) {
	userID := api.getUserID(r)
	
	payouts, err := api.getPayouts(userID)
	if err != nil {
		api.sendError(w, http.StatusInternalServerError, "Failed to get payouts")
		return
	}
	
	api.sendSuccess(w, payouts)
}

// Settings handlers

func (api *MobileAPI) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	userID := api.getUserID(r)
	
	settings, err := api.getUserSettings(userID)
	if err != nil {
		api.sendError(w, http.StatusInternalServerError, "Failed to get settings")
		return
	}
	
	api.sendSuccess(w, settings)
}

func (api *MobileAPI) handleUpdateSettings(w http.ResponseWriter, r *http.Request) {
	userID := api.getUserID(r)
	
	var settings map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&settings); err != nil {
		api.sendError(w, http.StatusBadRequest, "Invalid request")
		return
	}
	
	if err := api.updateUserSettings(userID, settings); err != nil {
		api.sendError(w, http.StatusInternalServerError, "Failed to update settings")
		return
	}
	
	api.sendSuccess(w, map[string]string{
		"message": "Settings updated successfully",
	})
}

func (api *MobileAPI) handleUpdatePayoutSettings(w http.ResponseWriter, r *http.Request) {
	userID := api.getUserID(r)
	
	var req struct {
		WalletAddress string  `json:"wallet_address"`
		MinPayout     float64 `json:"min_payout"`
		PayoutCurrency string `json:"payout_currency"`
	}
	
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		api.sendError(w, http.StatusBadRequest, "Invalid request")
		return
	}
	
	if err := api.updatePayoutSettings(userID, req.WalletAddress, req.MinPayout, req.PayoutCurrency); err != nil {
		api.sendError(w, http.StatusInternalServerError, "Failed to update payout settings")
		return
	}
	
	api.sendSuccess(w, map[string]string{
		"message": "Payout settings updated successfully",
	})
}

// Statistics handlers

func (api *MobileAPI) handleGetPoolStats(w http.ResponseWriter, r *http.Request) {
	stats := api.poolManager.GetStats()
	api.sendSuccess(w, stats)
}

func (api *MobileAPI) handleGetProfitStats(w http.ResponseWriter, r *http.Request) {
	stats := api.profitSwitcher.GetStats()
	api.sendSuccess(w, stats)
}

func (api *MobileAPI) handleGetPerformanceStats(w http.ResponseWriter, r *http.Request) {
	userID := api.getUserID(r)
	period := r.URL.Query().Get("period")
	
	stats, err := api.getPerformanceStats(userID, period)
	if err != nil {
		api.sendError(w, http.StatusInternalServerError, "Failed to get performance stats")
		return
	}
	
	api.sendSuccess(w, stats)
}

// Notification handlers

func (api *MobileAPI) handleGetNotifications(w http.ResponseWriter, r *http.Request) {
	userID := api.getUserID(r)
	
	// Get filter
	unreadOnly := r.URL.Query().Get("unread_only") == "true"
	
	notifications, err := api.getNotifications(userID, unreadOnly)
	if err != nil {
		api.sendError(w, http.StatusInternalServerError, "Failed to get notifications")
		return
	}
	
	api.sendSuccess(w, notifications)
}

func (api *MobileAPI) handleMarkNotificationRead(w http.ResponseWriter, r *http.Request) {
	userID := api.getUserID(r)
	notificationID := mux.Vars(r)["id"]
	
	if err := api.markNotificationRead(userID, notificationID); err != nil {
		api.sendError(w, http.StatusInternalServerError, "Failed to mark notification as read")
		return
	}
	
	api.sendSuccess(w, map[string]string{
		"message": "Notification marked as read",
	})
}

func (api *MobileAPI) handleUpdateNotificationSettings(w http.ResponseWriter, r *http.Request) {
	userID := api.getUserID(r)
	
	var settings struct {
		WorkerOffline   bool `json:"worker_offline"`
		PayoutSent      bool `json:"payout_sent"`
		BlockFound      bool `json:"block_found"`
		ProfitSwitch    bool `json:"profit_switch"`
		LowHashrate     bool `json:"low_hashrate"`
		HighRejects     bool `json:"high_rejects"`
	}
	
	if err := json.NewDecoder(r.Body).Decode(&settings); err != nil {
		api.sendError(w, http.StatusBadRequest, "Invalid request")
		return
	}
	
	if err := api.updateNotificationSettings(userID, settings); err != nil {
		api.sendError(w, http.StatusInternalServerError, "Failed to update notification settings")
		return
	}
	
	api.sendSuccess(w, map[string]string{
		"message": "Notification settings updated",
	})
}

// WebSocket handler

func (api *MobileAPI) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	userID := api.getUserID(r)
	
	// Upgrade connection
	conn, err := api.upgrader.Upgrade(w, r, nil)
	if err != nil {
		api.logger.Error("Failed to upgrade WebSocket",
			zap.String("user_id", userID),
			zap.Error(err),
		)
		return
	}
	
	// Create WebSocket connection
	wsConn := &WSConnection{
		ID:         fmt.Sprintf("%s-%d", userID, time.Now().Unix()),
		UserID:     userID,
		Conn:       conn,
		Send:       make(chan []byte, 256),
		LastActive: time.Now(),
	}
	
	// Register connection
	api.wsConnections[wsConn.ID] = wsConn
	
	// Start handlers
	go wsConn.readPump(api)
	go wsConn.writePump(api)
	
	// Send initial data
	dashboard, _ := api.getDashboardData(userID)
	api.sendWSMessage(wsConn, "connected", dashboard)
}

// Health check

func (api *MobileAPI) handleHealthCheck(w http.ResponseWriter, r *http.Request) {
	health := map[string]interface{}{
		"status": "healthy",
		"timestamp": time.Now(),
		"services": map[string]bool{
			"pool": api.poolManager != nil,
			"mining": api.miningEngine != nil,
			"analytics": api.analytics != nil,
			"profit": api.profitSwitcher != nil,
		},
	}
	
	api.sendSuccess(w, health)
}

// Helper methods

func (api *MobileAPI) sendSuccess(w http.ResponseWriter, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(APIResponse{
		Success: true,
		Data:    data,
	})
}

func (api *MobileAPI) sendError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(APIResponse{
		Success: false,
		Error:   message,
	})
}

func (api *MobileAPI) getUserID(r *http.Request) string {
	// Extract from context (set by auth middleware)
	if userID, ok := r.Context().Value("user_id").(string); ok {
		return userID
	}
	return ""
}

// Middleware

func (api *MobileAPI) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			api.sendError(w, http.StatusUnauthorized, "Missing authorization header")
			return
		}
		
		// Validate token
		userID, err := api.authManager.ValidateToken(authHeader)
		if err != nil {
			api.sendError(w, http.StatusUnauthorized, "Invalid token")
			return
		}
		
		// Add user ID to context
		ctx := context.WithValue(r.Context(), "user_id", userID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (api *MobileAPI) rateLimitMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		userID := api.getUserID(r)
		
		if !api.rateLimiter.Allow(userID) {
			api.sendError(w, http.StatusTooManyRequests, "Rate limit exceeded")
			return
		}
		
		next.ServeHTTP(w, r)
	})
}

// Data retrieval methods (simplified implementations)

func (api *MobileAPI) getDashboardData(userID string) (*DashboardData, error) {
	// Get user data from various sources
	workers, _ := api.getWorkers(userID, "", "")
	earnings, _ := api.getEarnings(userID, "today")
	poolStats := api.poolManager.GetStats()
	
	// Calculate totals
	totalHashrate := 0.0
	activeWorkers := 0
	for _, w := range workers {
		totalHashrate += w.Hashrate
		if w.Status == "active" {
			activeWorkers++
		}
	}
	
	dashboard := &DashboardData{
		Overview: OverviewData{
			TotalHashrate:    totalHashrate,
			ActiveWorkers:    activeWorkers,
			UnpaidBalance:    100.5, // Example
			EstimatedEarning: 25.3,  // Example
			Currency:         api.profitSwitcher.GetCurrentCurrency(),
		},
		Workers: workers[:5], // Top 5 workers
		Earnings: *earnings,
		PoolStats: PoolStatistics{
			TotalHashrate:  poolStats["total_hashrate"].(float64),
			ActiveMiners:   poolStats["active_miners"].(int),
			BlocksFound24h: poolStats["blocks_found_24h"].(int),
			PoolFee:        2.0,
			MinPayout:      0.01,
		},
		Notifications: []Notification{}, // Recent notifications
	}
	
	return dashboard, nil
}

func (api *MobileAPI) getWorkers(userID, status, sortBy string) ([]WorkerSummary, error) {
	// Example implementation
	return []WorkerSummary{
		{
			ID:       "worker-1",
			Name:     "RIG-01",
			Hashrate: 125.5,
			Status:   "active",
			LastSeen: time.Now(),
			Shares: ShareInfo{
				Valid:   1250,
				Invalid: 12,
				Stale:   5,
				Ratio:   99.1,
			},
			Efficiency: 98.5,
		},
	}, nil
}

func (api *MobileAPI) getEarnings(userID, period string) (*EarningsData, error) {
	// Example implementation
	return &EarningsData{
		Today:     25.3,
		Yesterday: 24.8,
		ThisWeek:  175.2,
		ThisMonth: 750.5,
		History:   []EarningHistoryPoint{},
	}, nil
}

// Stub implementations for other methods
func (api *MobileAPI) authenticateUser(username, password string) (*User, error) {
	// Implementation needed
	return &User{ID: "user123"}, nil
}

func (api *MobileAPI) createUser(username, email, password, wallet string) (*User, error) {
	// Implementation needed
	return &User{ID: "user456"}, nil
}

func (api *MobileAPI) getWorkerDetails(userID, workerID string) (interface{}, error) {
	// Implementation needed
	return nil, nil
}

func (api *MobileAPI) restartWorker(userID, workerID string) error {
	// Implementation needed
	return nil
}

func (api *MobileAPI) getEarningHistory(userID string, limit, offset int) (interface{}, error) {
	// Implementation needed
	return nil, nil
}

func (api *MobileAPI) getPayouts(userID string) (interface{}, error) {
	// Implementation needed
	return nil, nil
}

func (api *MobileAPI) getUserSettings(userID string) (interface{}, error) {
	// Implementation needed
	return nil, nil
}

func (api *MobileAPI) updateUserSettings(userID string, settings map[string]interface{}) error {
	// Implementation needed
	return nil
}

func (api *MobileAPI) updatePayoutSettings(userID, wallet string, minPayout float64, currency string) error {
	// Implementation needed
	return nil
}

func (api *MobileAPI) getPerformanceStats(userID, period string) (interface{}, error) {
	// Implementation needed
	return nil, nil
}

func (api *MobileAPI) getNotifications(userID string, unreadOnly bool) ([]Notification, error) {
	// Implementation needed
	return []Notification{}, nil
}

func (api *MobileAPI) markNotificationRead(userID, notificationID string) error {
	// Implementation needed
	return nil
}

func (api *MobileAPI) updateNotificationSettings(userID string, settings interface{}) error {
	// Implementation needed
	return nil
}

// User struct
type User struct {
	ID string
}

// WebSocket methods

func (api *MobileAPI) handleWebSocketMessages() {
	// Handle incoming WebSocket messages
}

func (api *MobileAPI) broadcastToUser(userID string, event string, data interface{}) {
	message, _ := json.Marshal(map[string]interface{}{
		"event": event,
		"data":  data,
		"timestamp": time.Now(),
	})
	
	for _, conn := range api.wsConnections {
		if conn.UserID == userID {
			select {
			case conn.Send <- message:
			default:
				close(conn.Send)
				delete(api.wsConnections, conn.ID)
			}
		}
	}
}

func (api *MobileAPI) sendWSMessage(conn *WSConnection, event string, data interface{}) {
	message, _ := json.Marshal(map[string]interface{}{
		"event": event,
		"data":  data,
		"timestamp": time.Now(),
	})
	
	select {
	case conn.Send <- message:
	default:
		close(conn.Send)
		delete(api.wsConnections, conn.ID)
	}
}

// WebSocket connection methods

func (conn *WSConnection) readPump(api *MobileAPI) {
	defer func() {
		conn.Conn.Close()
		delete(api.wsConnections, conn.ID)
	}()
	
	conn.Conn.SetReadLimit(api.config.WSMaxMessageSize)
	conn.Conn.SetReadDeadline(time.Now().Add(api.config.WSReadTimeout))
	conn.Conn.SetPongHandler(func(string) error {
		conn.Conn.SetReadDeadline(time.Now().Add(api.config.WSReadTimeout))
		return nil
	})
	
	for {
		var message map[string]interface{}
		err := conn.Conn.ReadJSON(&message)
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				api.logger.Error("WebSocket error", zap.Error(err))
			}
			break
		}
		
		conn.LastActive = time.Now()
		
		// Handle message
		if event, ok := message["event"].(string); ok {
			api.handleWSEvent(conn, event, message["data"])
		}
	}
}

func (conn *WSConnection) writePump(api *MobileAPI) {
	ticker := time.NewTicker(54 * time.Second)
	defer func() {
		ticker.Stop()
		conn.Conn.Close()
	}()
	
	for {
		select {
		case message, ok := <-conn.Send:
			conn.Conn.SetWriteDeadline(time.Now().Add(api.config.WSWriteTimeout))
			if !ok {
				conn.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			
			conn.Conn.WriteMessage(websocket.TextMessage, message)
			
		case <-ticker.C:
			conn.Conn.SetWriteDeadline(time.Now().Add(api.config.WSWriteTimeout))
			if err := conn.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (api *MobileAPI) handleWSEvent(conn *WSConnection, event string, data interface{}) {
	switch event {
	case "subscribe":
		// Handle subscription to real-time updates
		if channel, ok := data.(string); ok {
			api.subscribeToChannel(conn, channel)
		}
		
	case "unsubscribe":
		// Handle unsubscription
		if channel, ok := data.(string); ok {
			api.unsubscribeFromChannel(conn, channel)
		}
		
	case "ping":
		// Respond with pong
		api.sendWSMessage(conn, "pong", nil)
		
	default:
		api.logger.Warn("Unknown WebSocket event",
			zap.String("event", event),
			zap.String("user_id", conn.UserID),
		)
	}
}

func (api *MobileAPI) subscribeToChannel(conn *WSConnection, channel string) {
	// Implementation for channel subscription
}

func (api *MobileAPI) unsubscribeFromChannel(conn *WSConnection, channel string) {
	// Implementation for channel unsubscription
}

// Rate limiter methods

func (rl *RateLimiter) Allow(userID string) bool {
	now := time.Now()
	
	limit, exists := rl.requests[userID]
	if !exists {
		rl.requests[userID] = &UserRateLimit{
			Tokens:    60, // 60 requests per minute
			LastReset: now,
		}
		return true
	}
	
	// Reset if minute has passed
	if now.Sub(limit.LastReset) > time.Minute {
		limit.Tokens = 60
		limit.LastReset = now
	}
	
	if limit.Tokens > 0 {
		limit.Tokens--
		return true
	}
	
	return false
}

// Auth manager methods

func (am *AuthManager) GenerateToken(userID, deviceID string) (string, error) {
	// Simple token generation (use JWT in production)
	token := fmt.Sprintf("%s:%s:%d", userID, deviceID, time.Now().Unix())
	return token, nil
}

func (am *AuthManager) ValidateToken(token string) (string, error) {
	// Simple validation (use JWT in production)
	parts := strings.Split(token, ":")
	if len(parts) != 3 {
		return "", errors.New("invalid token format")
	}
	return parts[0], nil
}

func (am *AuthManager) RefreshToken(oldToken string) (string, error) {
	userID, err := am.ValidateToken(oldToken)
	if err != nil {
		return "", err
	}
	
	return am.GenerateToken(userID, "refreshed")
}