package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/mux"
	"github.com/gorilla/websocket"
	"github.com/shizukutanaka/Otedama/internal/mining"
	"go.uber.org/zap"
	"golang.org/x/time/rate"
)

// RemoteManagementServer provides remote management capabilities
type RemoteManagementServer struct {
	logger   *zap.Logger
	config   RemoteConfig
	engine   mining.Engine
	
	// HTTP server
	server   *http.Server
	router   *mux.Router
	
	// WebSocket management
	upgrader websocket.Upgrader
	clients  map[string]*WebSocketClient
	clientMu sync.RWMutex
	
	// Authentication
	apiKeys  map[string]*APIKey
	keysMu   sync.RWMutex
	
	// Rate limiting
	limiter  *rate.Limiter
	
	// Metrics
	metrics  *RemoteMetrics
	
	// Context
	ctx      context.Context
	cancel   context.CancelFunc
}

// RemoteConfig configures remote management
type RemoteConfig struct {
	Enabled         bool              `yaml:"enabled"`
	ListenAddr      string            `yaml:"listen_addr"`
	TLSEnabled      bool              `yaml:"tls_enabled"`
	CertFile        string            `yaml:"cert_file"`
	KeyFile         string            `yaml:"key_file"`
	
	// Authentication
	RequireAuth     bool              `yaml:"require_auth"`
	APIKeys         []APIKeyConfig    `yaml:"api_keys"`
	
	// CORS settings
	AllowedOrigins  []string          `yaml:"allowed_origins"`
	
	// Rate limiting
	RateLimit       int               `yaml:"rate_limit"`       // Requests per minute
	BurstLimit      int               `yaml:"burst_limit"`
	
	// WebSocket
	WSEnabled       bool              `yaml:"ws_enabled"`
	WSPingInterval  time.Duration     `yaml:"ws_ping_interval"`
}

// APIKeyConfig configures an API key
type APIKeyConfig struct {
	Name        string   `yaml:"name"`
	Key         string   `yaml:"key"`
	Permissions []string `yaml:"permissions"`
}

// APIKey represents an authenticated API key
type APIKey struct {
	Name        string
	Key         string
	Permissions map[string]bool
	LastUsed    time.Time
	CreatedAt   time.Time
}

// WebSocketClient represents a connected WebSocket client
type WebSocketClient struct {
	ID         string
	Conn       *websocket.Conn
	APIKey     *APIKey
	Send       chan []byte
	LastPing   time.Time
	mu         sync.Mutex
}

// RemoteMetrics tracks API usage metrics
type RemoteMetrics struct {
	TotalRequests   uint64
	AuthFailures    uint64
	RateLimitHits   uint64
	ActiveWS        int32
	mu              sync.RWMutex
}

// NewRemoteManagementServer creates a new remote management server
func NewRemoteManagementServer(logger *zap.Logger, config RemoteConfig, engine mining.Engine) *RemoteManagementServer {
	ctx, cancel := context.WithCancel(context.Background())
	
	rms := &RemoteManagementServer{
		logger:   logger,
		config:   config,
		engine:   engine,
		clients:  make(map[string]*WebSocketClient),
		apiKeys:  make(map[string]*APIKey),
		metrics:  &RemoteMetrics{},
		ctx:      ctx,
		cancel:   cancel,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				// Check CORS in production
				return true
			},
		},
	}
	
	// Initialize rate limiter
	if config.RateLimit > 0 {
		rms.limiter = rate.NewLimiter(rate.Limit(config.RateLimit/60.0), config.BurstLimit)
	}
	
	// Load API keys
	rms.loadAPIKeys()
	
	// Setup routes
	rms.setupRoutes()
	
	return rms
}

// Start starts the remote management server
func (rms *RemoteManagementServer) Start() error {
	if !rms.config.Enabled {
		return nil
	}
	
	rms.server = &http.Server{
		Addr:         rms.config.ListenAddr,
		Handler:      rms.router,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}
	
	rms.logger.Info("Starting remote management server",
		zap.String("addr", rms.config.ListenAddr),
		zap.Bool("tls", rms.config.TLSEnabled),
		zap.Bool("auth", rms.config.RequireAuth),
	)
	
	// Start WebSocket ping loop
	if rms.config.WSEnabled {
		go rms.websocketPingLoop()
	}
	
	// Start server
	go func() {
		var err error
		if rms.config.TLSEnabled {
			err = rms.server.ListenAndServeTLS(rms.config.CertFile, rms.config.KeyFile)
		} else {
			err = rms.server.ListenAndServe()
		}
		if err != nil && err != http.ErrServerClosed {
			rms.logger.Error("Server error", zap.Error(err))
		}
	}()
	
	return nil
}

// Stop stops the remote management server
func (rms *RemoteManagementServer) Stop() error {
	rms.cancel()
	
	// Close WebSocket connections
	rms.clientMu.Lock()
	for _, client := range rms.clients {
		client.Conn.Close()
	}
	rms.clientMu.Unlock()
	
	// Shutdown HTTP server
	if rms.server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return rms.server.Shutdown(ctx)
	}
	
	return nil
}

// setupRoutes configures API routes
func (rms *RemoteManagementServer) setupRoutes() {
	rms.router = mux.NewRouter()
	
	// Apply middleware
	rms.router.Use(rms.loggingMiddleware)
	rms.router.Use(rms.corsMiddleware)
	rms.router.Use(rms.rateLimitMiddleware)
	
	// API routes
	api := rms.router.PathPrefix("/api/v1").Subrouter()
	
	// Public endpoints
	api.HandleFunc("/health", rms.handleHealth).Methods("GET")
	api.HandleFunc("/version", rms.handleVersion).Methods("GET")
	
	// Protected endpoints
	protected := api.PathPrefix("").Subrouter()
	if rms.config.RequireAuth {
		protected.Use(rms.authMiddleware)
	}
	
	// Mining control
	protected.HandleFunc("/mining/status", rms.handleMiningStatus).Methods("GET")
	protected.HandleFunc("/mining/start", rms.handleMiningStart).Methods("POST")
	protected.HandleFunc("/mining/stop", rms.handleMiningStop).Methods("POST")
	protected.HandleFunc("/mining/restart", rms.handleMiningRestart).Methods("POST")
	
	// Configuration
	protected.HandleFunc("/config", rms.handleGetConfig).Methods("GET")
	protected.HandleFunc("/config", rms.handleUpdateConfig).Methods("PUT")
	protected.HandleFunc("/config/algorithm", rms.handleSetAlgorithm).Methods("PUT")
	protected.HandleFunc("/config/pool", rms.handleSetPool).Methods("PUT")
	
	// Hardware control
	protected.HandleFunc("/hardware/status", rms.handleHardwareStatus).Methods("GET")
	protected.HandleFunc("/hardware/tune", rms.handleHardwareTune).Methods("POST")
	protected.HandleFunc("/hardware/profile", rms.handleSetProfile).Methods("PUT")
	
	// Statistics
	protected.HandleFunc("/stats", rms.handleStats).Methods("GET")
	protected.HandleFunc("/stats/history", rms.handleStatsHistory).Methods("GET")
	protected.HandleFunc("/stats/reset", rms.handleStatsReset).Methods("POST")
	
	// Profit switching
	protected.HandleFunc("/profit/status", rms.handleProfitStatus).Methods("GET")
	protected.HandleFunc("/profit/switch", rms.handleProfitSwitch).Methods("POST")
	protected.HandleFunc("/profit/coins", rms.handleProfitCoins).Methods("GET")
	
	// WebSocket
	if rms.config.WSEnabled {
		protected.HandleFunc("/ws", rms.handleWebSocket)
	}
}

// API Handlers

func (rms *RemoteManagementServer) handleHealth(w http.ResponseWriter, r *http.Request) {
	rms.writeJSON(w, map[string]interface{}{
		"status": "healthy",
		"uptime": time.Since(rms.engine.GetStartTime()).Seconds(),
	})
}

func (rms *RemoteManagementServer) handleVersion(w http.ResponseWriter, r *http.Request) {
	rms.writeJSON(w, map[string]interface{}{
		"version": "2.1.0",
		"api_version": "v1",
	})
}

func (rms *RemoteManagementServer) handleMiningStatus(w http.ResponseWriter, r *http.Request) {
	status := rms.engine.GetStatus()
	stats := rms.engine.GetStats()
	
	rms.writeJSON(w, map[string]interface{}{
		"running":    status.Running,
		"algorithm":  status.Algorithm,
		"pool":       status.Pool,
		"hashrate":   stats.CurrentHashRate,
		"shares": map[string]interface{}{
			"accepted":  stats.SharesAccepted,
			"rejected":  stats.SharesRejected,
			"submitted": stats.SharesSubmitted,
		},
		"uptime":     status.Uptime.Seconds(),
		"errors":     stats.Errors,
	})
}

func (rms *RemoteManagementServer) handleMiningStart(w http.ResponseWriter, r *http.Request) {
	if err := rms.engine.Start(); err != nil {
		rms.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	
	rms.writeJSON(w, map[string]interface{}{
		"status": "started",
	})
}

func (rms *RemoteManagementServer) handleMiningStop(w http.ResponseWriter, r *http.Request) {
	if err := rms.engine.Stop(); err != nil {
		rms.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	
	rms.writeJSON(w, map[string]interface{}{
		"status": "stopped",
	})
}

func (rms *RemoteManagementServer) handleMiningRestart(w http.ResponseWriter, r *http.Request) {
	if err := rms.engine.Stop(); err != nil {
		rms.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	
	time.Sleep(1 * time.Second)
	
	if err := rms.engine.Start(); err != nil {
		rms.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	
	rms.writeJSON(w, map[string]interface{}{
		"status": "restarted",
	})
}

func (rms *RemoteManagementServer) handleGetConfig(w http.ResponseWriter, r *http.Request) {
	config := rms.engine.GetConfig()
	rms.writeJSON(w, config)
}

func (rms *RemoteManagementServer) handleUpdateConfig(w http.ResponseWriter, r *http.Request) {
	var config map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&config); err != nil {
		rms.writeError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}
	
	// Apply configuration changes
	for key, value := range config {
		if err := rms.engine.SetConfig(key, value); err != nil {
			rms.writeError(w, http.StatusBadRequest, fmt.Sprintf("Failed to set %s: %v", key, err))
			return
		}
	}
	
	rms.writeJSON(w, map[string]interface{}{
		"status": "updated",
	})
}

func (rms *RemoteManagementServer) handleSetAlgorithm(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Algorithm string `json:"algorithm"`
	}
	
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		rms.writeError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}
	
	algo := mining.ParseAlgorithm(req.Algorithm)
	if algo == mining.AlgorithmUnknown {
		rms.writeError(w, http.StatusBadRequest, "Unknown algorithm")
		return
	}
	
	if err := rms.engine.SetAlgorithm(algo); err != nil {
		rms.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	
	rms.writeJSON(w, map[string]interface{}{
		"status": "algorithm updated",
		"algorithm": req.Algorithm,
	})
}

func (rms *RemoteManagementServer) handleSetPool(w http.ResponseWriter, r *http.Request) {
	var req struct {
		URL    string `json:"url"`
		Wallet string `json:"wallet"`
	}
	
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		rms.writeError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}
	
	if err := rms.engine.SetPool(req.URL, req.Wallet); err != nil {
		rms.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	
	rms.writeJSON(w, map[string]interface{}{
		"status": "pool updated",
		"pool": req.URL,
	})
}

func (rms *RemoteManagementServer) handleHardwareStatus(w http.ResponseWriter, r *http.Request) {
	hardware := rms.engine.GetHardwareInfo()
	rms.writeJSON(w, hardware)
}

func (rms *RemoteManagementServer) handleHardwareTune(w http.ResponseWriter, r *http.Request) {
	// Trigger auto-tuning
	go func() {
		if tuner := rms.engine.GetAutoTuner(); tuner != nil {
			if _, err := tuner.TuneHardware(); err != nil {
				rms.logger.Error("Auto-tuning failed", zap.Error(err))
			}
		}
	}()
	
	rms.writeJSON(w, map[string]interface{}{
		"status": "tuning started",
	})
}

func (rms *RemoteManagementServer) handleSetProfile(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Profile string `json:"profile"`
	}
	
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		rms.writeError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}
	
	// Apply profile through auto-tuner
	if tuner := rms.engine.GetAutoTuner(); tuner != nil {
		profiles := tuner.GetProfiles()
		if profile, exists := profiles[req.Profile]; exists {
			if err := tuner.ApplyProfile(profile); err != nil {
				rms.writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
		} else {
			rms.writeError(w, http.StatusNotFound, "Profile not found")
			return
		}
	}
	
	rms.writeJSON(w, map[string]interface{}{
		"status": "profile applied",
		"profile": req.Profile,
	})
}

func (rms *RemoteManagementServer) handleStats(w http.ResponseWriter, r *http.Request) {
	stats := rms.engine.GetStats()
	rms.writeJSON(w, stats)
}

func (rms *RemoteManagementServer) handleStatsHistory(w http.ResponseWriter, r *http.Request) {
	// Get time range from query params
	duration := 24 * time.Hour
	if d := r.URL.Query().Get("duration"); d != "" {
		if parsed, err := time.ParseDuration(d); err == nil {
			duration = parsed
		}
	}
	
	history := rms.engine.GetStatsHistory(duration)
	rms.writeJSON(w, history)
}

func (rms *RemoteManagementServer) handleStatsReset(w http.ResponseWriter, r *http.Request) {
	rms.engine.ResetStats()
	rms.writeJSON(w, map[string]interface{}{
		"status": "stats reset",
	})
}

func (rms *RemoteManagementServer) handleProfitStatus(w http.ResponseWriter, r *http.Request) {
	if switcher := rms.engine.GetProfitSwitcher(); switcher != nil {
		current := switcher.GetCurrentCoin()
		coins := switcher.GetCoinInfo()
		
		rms.writeJSON(w, map[string]interface{}{
			"enabled": true,
			"current_coin": current,
			"coins": coins,
		})
	} else {
		rms.writeJSON(w, map[string]interface{}{
			"enabled": false,
		})
	}
}

func (rms *RemoteManagementServer) handleProfitSwitch(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Coin string `json:"coin"`
	}
	
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		rms.writeError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}
	
	if switcher := rms.engine.GetProfitSwitcher(); switcher != nil {
		if err := switcher.ManualSwitch(req.Coin); err != nil {
			rms.writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	} else {
		rms.writeError(w, http.StatusNotFound, "Profit switching not enabled")
		return
	}
	
	rms.writeJSON(w, map[string]interface{}{
		"status": "switched",
		"coin": req.Coin,
	})
}

func (rms *RemoteManagementServer) handleProfitCoins(w http.ResponseWriter, r *http.Request) {
	if switcher := rms.engine.GetProfitSwitcher(); switcher != nil {
		coins := switcher.GetCoinInfo()
		performance := switcher.GetPerformanceHistory()
		
		rms.writeJSON(w, map[string]interface{}{
			"coins": coins,
			"performance": performance,
		})
	} else {
		rms.writeError(w, http.StatusNotFound, "Profit switching not enabled")
	}
}

// WebSocket handler
func (rms *RemoteManagementServer) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := rms.upgrader.Upgrade(w, r, nil)
	if err != nil {
		rms.logger.Error("WebSocket upgrade failed", zap.Error(err))
		return
	}
	
	client := &WebSocketClient{
		ID:       generateClientID(),
		Conn:     conn,
		Send:     make(chan []byte, 256),
		LastPing: time.Now(),
	}
	
	// Get API key from request
	if apiKey := rms.getAPIKeyFromRequest(r); apiKey != nil {
		client.APIKey = apiKey
	}
	
	rms.clientMu.Lock()
	rms.clients[client.ID] = client
	rms.clientMu.Unlock()
	
	rms.metrics.mu.Lock()
	rms.metrics.ActiveWS++
	rms.metrics.mu.Unlock()
	
	// Start client handlers
	go client.writePump()
	go client.readPump(rms)
	
	// Send initial status
	rms.sendStatusUpdate(client)
}

// Middleware

func (rms *RemoteManagementServer) loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		
		rms.metrics.mu.Lock()
		rms.metrics.TotalRequests++
		rms.metrics.mu.Unlock()
		
		next.ServeHTTP(w, r)
		
		rms.logger.Debug("HTTP request",
			zap.String("method", r.Method),
			zap.String("path", r.URL.Path),
			zap.String("remote", r.RemoteAddr),
			zap.Duration("duration", time.Since(start)),
		)
	})
}

func (rms *RemoteManagementServer) corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Set CORS headers
		origin := r.Header.Get("Origin")
		allowed := false
		
		for _, allowedOrigin := range rms.config.AllowedOrigins {
			if allowedOrigin == "*" || allowedOrigin == origin {
				allowed = true
				break
			}
		}
		
		if allowed {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		}
		
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		
		next.ServeHTTP(w, r)
	})
}

func (rms *RemoteManagementServer) rateLimitMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if rms.limiter != nil {
			if !rms.limiter.Allow() {
				rms.metrics.mu.Lock()
				rms.metrics.RateLimitHits++
				rms.metrics.mu.Unlock()
				
				rms.writeError(w, http.StatusTooManyRequests, "Rate limit exceeded")
				return
			}
		}
		
		next.ServeHTTP(w, r)
	})
}

func (rms *RemoteManagementServer) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		apiKey := rms.getAPIKeyFromRequest(r)
		if apiKey == nil {
			rms.metrics.mu.Lock()
			rms.metrics.AuthFailures++
			rms.metrics.mu.Unlock()
			
			w.Header().Set("WWW-Authenticate", "Bearer")
			rms.writeError(w, http.StatusUnauthorized, "Unauthorized")
			return
		}
		
		// Update last used
		apiKey.LastUsed = time.Now()
		
		// Store in context
		ctx := context.WithValue(r.Context(), "api_key", apiKey)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// Helper functions

func (rms *RemoteManagementServer) getAPIKeyFromRequest(r *http.Request) *APIKey {
	// Check Authorization header
	auth := r.Header.Get("Authorization")
	if auth != "" && len(auth) > 7 && auth[:7] == "Bearer " {
		key := auth[7:]
		
		rms.keysMu.RLock()
		apiKey, exists := rms.apiKeys[key]
		rms.keysMu.RUnlock()
		
		if exists {
			return apiKey
		}
	}
	
	// Check query parameter
	if key := r.URL.Query().Get("api_key"); key != "" {
		rms.keysMu.RLock()
		apiKey, exists := rms.apiKeys[key]
		rms.keysMu.RUnlock()
		
		if exists {
			return apiKey
		}
	}
	
	return nil
}

func (rms *RemoteManagementServer) writeJSON(w http.ResponseWriter, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}

func (rms *RemoteManagementServer) writeError(w http.ResponseWriter, code int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"error": message,
		"code":  code,
	})
}

func (rms *RemoteManagementServer) loadAPIKeys() {
	for _, keyConfig := range rms.config.APIKeys {
		perms := make(map[string]bool)
		for _, perm := range keyConfig.Permissions {
			perms[perm] = true
		}
		
		rms.apiKeys[keyConfig.Key] = &APIKey{
			Name:        keyConfig.Name,
			Key:         keyConfig.Key,
			Permissions: perms,
			CreatedAt:   time.Now(),
		}
	}
}

func (rms *RemoteManagementServer) websocketPingLoop() {
	ticker := time.NewTicker(rms.config.WSPingInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-rms.ctx.Done():
			return
		case <-ticker.C:
			rms.pingClients()
		}
	}
}

func (rms *RemoteManagementServer) pingClients() {
	rms.clientMu.RLock()
	clients := make([]*WebSocketClient, 0, len(rms.clients))
	for _, client := range rms.clients {
		clients = append(clients, client)
	}
	rms.clientMu.RUnlock()
	
	for _, client := range clients {
		if time.Since(client.LastPing) > rms.config.WSPingInterval*2 {
			// Client timeout
			rms.removeClient(client)
			continue
		}
		
		client.mu.Lock()
		client.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if err := client.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
			client.mu.Unlock()
			rms.removeClient(client)
			continue
		}
		client.mu.Unlock()
	}
}

func (rms *RemoteManagementServer) removeClient(client *WebSocketClient) {
	rms.clientMu.Lock()
	delete(rms.clients, client.ID)
	rms.clientMu.Unlock()
	
	rms.metrics.mu.Lock()
	rms.metrics.ActiveWS--
	rms.metrics.mu.Unlock()
	
	close(client.Send)
	client.Conn.Close()
}

func (rms *RemoteManagementServer) sendStatusUpdate(client *WebSocketClient) {
	status := rms.engine.GetStatus()
	stats := rms.engine.GetStats()
	
	update := map[string]interface{}{
		"type": "status",
		"data": map[string]interface{}{
			"running":  status.Running,
			"hashrate": stats.CurrentHashRate,
			"shares": map[string]interface{}{
				"accepted": stats.SharesAccepted,
				"rejected": stats.SharesRejected,
			},
		},
	}
	
	data, _ := json.Marshal(update)
	select {
	case client.Send <- data:
	default:
		// Client send buffer full
		rms.removeClient(client)
	}
}

// WebSocket client methods

func (c *WebSocketClient) writePump() {
	ticker := time.NewTicker(54 * time.Second)
	defer func() {
		ticker.Stop()
		c.Conn.Close()
	}()
	
	for {
		select {
		case message, ok := <-c.Send:
			c.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			
			if err := c.Conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}
			
		case <-ticker.C:
			c.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *WebSocketClient) readPump(rms *RemoteManagementServer) {
	defer func() {
		rms.removeClient(c)
	}()
	
	c.Conn.SetReadLimit(512 * 1024)
	c.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.Conn.SetPongHandler(func(string) error {
		c.LastPing = time.Now()
		c.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})
	
	for {
		_, message, err := c.Conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				rms.logger.Error("WebSocket error", zap.Error(err))
			}
			break
		}
		
		// Process message
		var msg map[string]interface{}
		if err := json.Unmarshal(message, &msg); err != nil {
			continue
		}
		
		// Handle different message types
		switch msg["type"] {
		case "subscribe":
			// Subscribe to updates
		case "unsubscribe":
			// Unsubscribe from updates
		case "command":
			// Execute command
		}
	}
}

func generateClientID() string {
	return fmt.Sprintf("client_%d", time.Now().UnixNano())
}