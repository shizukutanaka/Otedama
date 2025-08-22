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
	"golang.org/x/time/rate"
)

// Server represents the API server
type Server struct {
	mu            sync.RWMutex
	ctx           context.Context
	cancel        context.CancelFunc
	router        *mux.Router
	httpServer    *http.Server
	wsUpgrader    websocket.Upgrader
	wsConnections map[string]*WSConnection
	rateLimiters  map[string]*rate.Limiter
	auth          *AuthManager
	metrics       *APIMetrics
	mining        MiningInterface
	monitoring    MonitoringInterface
}

// WSConnection represents a WebSocket connection
type WSConnection struct {
	ID         string
	Conn       *websocket.Conn
	User       string
	SendChan   chan interface{}
	ctx        context.Context
	cancel     context.CancelFunc
	subscribed map[string]bool
}

// AuthManager handles authentication
type AuthManager struct {
	mu           sync.RWMutex
	jwtSecret    []byte
	tokens       map[string]*Token
	refreshTokens map[string]*RefreshToken
	apiKeys      map[string]*APIKey
}

// Token represents an authentication token
type Token struct {
	Value     string
	UserID    string
	ExpiresAt time.Time
	Scopes    []string
}

// RefreshToken represents a refresh token
type RefreshToken struct {
	Value     string
	UserID    string
	ExpiresAt time.Time
}

// APIKey represents an API key
type APIKey struct {
	Key         string
	Name        string
	UserID      string
	Scopes      []string
	RateLimit   int
	LastUsed    time.Time
	CreatedAt   time.Time
}

// APIMetrics tracks API metrics
type APIMetrics struct {
	RequestsTotal      uint64
	RequestsSuccess    uint64
	RequestsFailed     uint64
	ResponseTimeMs     uint64
	WebSocketConns     uint32
	ActiveSessions     uint32
}

// MiningInterface defines mining operations
type MiningInterface interface {
	GetStatus() interface{}
	Start() error
	Stop() error
	GetHashrate() float64
	GetStatistics() interface{}
}

// MonitoringInterface defines monitoring operations
type MonitoringInterface interface {
	GetMetrics() interface{}
	GetHealth() interface{}
}

// Response represents API response
type Response struct {
	Success bool        `json:"success"`
	Data    interface{} `json:"data,omitempty"`
	Error   string      `json:"error,omitempty"`
	Meta    *Meta       `json:"meta,omitempty"`
}

// Meta contains response metadata
type Meta struct {
	Timestamp   time.Time `json:"timestamp"`
	RequestID   string    `json:"request_id"`
	Version     string    `json:"version"`
	RateLimit   int       `json:"rate_limit,omitempty"`
	RateRemaining int     `json:"rate_remaining,omitempty"`
}

// NewServer creates a new API server
func NewServer(port int, mining MiningInterface, monitoring MonitoringInterface) *Server {
	ctx, cancel := context.WithCancel(context.Background())
	
	s := &Server{
		ctx:           ctx,
		cancel:        cancel,
		wsConnections: make(map[string]*WSConnection),
		rateLimiters:  make(map[string]*rate.Limiter),
		auth:          NewAuthManager(),
		metrics:       &APIMetrics{},
		mining:        mining,
		monitoring:    monitoring,
		wsUpgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				// Configure CORS as needed
				return true
			},
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
		},
	}
	
	s.setupRoutes()
	
	s.httpServer = &http.Server{
		Addr:    fmt.Sprintf(":%d", port),
		Handler: s.router,
	}
	
	return s
}

// Start starts the API server
func (s *Server) Start() error {
	// Start metrics collector
	go s.collectMetrics()
	
	// Start WebSocket manager
	go s.manageWebSockets()
	
	// Start HTTP server
	go func() {
		if err := s.httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			// Log error
		}
	}()
	
	return nil
}

// Stop stops the API server
func (s *Server) Stop() error {
	s.cancel()
	
	// Close WebSocket connections
	s.mu.Lock()
	for _, conn := range s.wsConnections {
		conn.Close()
	}
	s.mu.Unlock()
	
	// Shutdown HTTP server
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	
	return s.httpServer.Shutdown(ctx)
}

// setupRoutes sets up API routes
func (s *Server) setupRoutes() {
	s.router = mux.NewRouter()
	
	// Middleware
	s.router.Use(s.loggingMiddleware)
	s.router.Use(s.corsMiddleware)
	s.router.Use(s.rateLimitMiddleware)
	
	// API v1 routes
	v1 := s.router.PathPrefix("/api/v1").Subrouter()
	
	// Public endpoints
	v1.HandleFunc("/status", s.handleStatus).Methods("GET")
	v1.HandleFunc("/health", s.handleHealth).Methods("GET")
	
	// Authentication
	v1.HandleFunc("/auth/login", s.handleLogin).Methods("POST")
	v1.HandleFunc("/auth/refresh", s.handleRefresh).Methods("POST")
	v1.HandleFunc("/auth/logout", s.handleLogout).Methods("POST")
	
	// Protected endpoints (require authentication)
	protected := v1.PathPrefix("").Subrouter()
	protected.Use(s.authMiddleware)
	
	// Mining operations
	protected.HandleFunc("/mining/start", s.handleMiningStart).Methods("POST")
	protected.HandleFunc("/mining/stop", s.handleMiningStop).Methods("POST")
	protected.HandleFunc("/mining/status", s.handleMiningStatus).Methods("GET")
	protected.HandleFunc("/mining/stats", s.handleMiningStats).Methods("GET")
	protected.HandleFunc("/mining/config", s.handleMiningConfig).Methods("GET", "PUT")
	
	// Pool management
	protected.HandleFunc("/pools", s.handlePools).Methods("GET")
	protected.HandleFunc("/pools", s.handleAddPool).Methods("POST")
	protected.HandleFunc("/pools/{id}", s.handlePool).Methods("GET", "PUT", "DELETE")
	
	// Hardware management
	protected.HandleFunc("/hardware", s.handleHardware).Methods("GET")
	protected.HandleFunc("/hardware/{id}/config", s.handleHardwareConfig).Methods("GET", "PUT")
	
	// Statistics
	protected.HandleFunc("/stats", s.handleStats).Methods("GET")
	protected.HandleFunc("/stats/history", s.handleStatsHistory).Methods("GET")
	
	// Configuration
	protected.HandleFunc("/config", s.handleConfig).Methods("GET", "PUT")
	protected.HandleFunc("/config/export", s.handleConfigExport).Methods("GET")
	protected.HandleFunc("/config/import", s.handleConfigImport).Methods("POST")
	
	// WebSocket endpoints
	v1.HandleFunc("/ws", s.handleWebSocket)
	v1.HandleFunc("/ws/stats", s.handleWebSocketStats)
	v1.HandleFunc("/ws/events", s.handleWebSocketEvents)
}

// Middleware

func (s *Server) loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		
		// Wrap response writer to capture status
		wrapped := &responseWriter{
			ResponseWriter: w,
			statusCode:     http.StatusOK,
		}
		
		next.ServeHTTP(wrapped, r)
		
		// Log request
		duration := time.Since(start)
		// Log: method, path, status, duration
	})
}

func (s *Server) corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Max-Age", "3600")
		
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		
		next.ServeHTTP(w, r)
	})
}

func (s *Server) rateLimitMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Get client IP
		ip := getClientIP(r)
		
		// Get or create rate limiter
		s.mu.Lock()
		limiter, exists := s.rateLimiters[ip]
		if !exists {
			// 60 requests per minute with burst of 10
			limiter = rate.NewLimiter(rate.Every(time.Second), 10)
			s.rateLimiters[ip] = limiter
		}
		s.mu.Unlock()
		
		// Check rate limit
		if !limiter.Allow() {
			s.sendError(w, http.StatusTooManyRequests, "Rate limit exceeded")
			return
		}
		
		next.ServeHTTP(w, r)
	})
}

func (s *Server) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Extract token from header
		token := extractToken(r)
		if token == "" {
			s.sendError(w, http.StatusUnauthorized, "Missing authentication token")
			return
		}
		
		// Validate token
		if !s.auth.ValidateToken(token) {
			s.sendError(w, http.StatusUnauthorized, "Invalid or expired token")
			return
		}
		
		next.ServeHTTP(w, r)
	})
}

// Handlers

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	status := s.mining.GetStatus()
	s.sendResponse(w, http.StatusOK, status)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	health := s.monitoring.GetHealth()
	s.sendResponse(w, http.StatusOK, health)
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
		MFA      string `json:"mfa_code,omitempty"`
	}
	
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.sendError(w, http.StatusBadRequest, "Invalid request")
		return
	}
	
	// Authenticate user
	token, refreshToken, err := s.auth.Authenticate(req.Username, req.Password, req.MFA)
	if err != nil {
		s.sendError(w, http.StatusUnauthorized, "Authentication failed")
		return
	}
	
	response := map[string]interface{}{
		"token":         token.Value,
		"refresh_token": refreshToken.Value,
		"expires_at":    token.ExpiresAt,
	}
	
	s.sendResponse(w, http.StatusOK, response)
}

func (s *Server) handleRefresh(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RefreshToken string `json:"refresh_token"`
	}
	
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.sendError(w, http.StatusBadRequest, "Invalid request")
		return
	}
	
	// Refresh token
	newToken, err := s.auth.RefreshToken(req.RefreshToken)
	if err != nil {
		s.sendError(w, http.StatusUnauthorized, "Invalid refresh token")
		return
	}
	
	response := map[string]interface{}{
		"token":      newToken.Value,
		"expires_at": newToken.ExpiresAt,
	}
	
	s.sendResponse(w, http.StatusOK, response)
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	token := extractToken(r)
	if token != "" {
		s.auth.RevokeToken(token)
	}
	
	s.sendResponse(w, http.StatusOK, map[string]string{"message": "Logged out successfully"})
}

func (s *Server) handleMiningStart(w http.ResponseWriter, r *http.Request) {
	if err := s.mining.Start(); err != nil {
		s.sendError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to start mining: %v", err))
		return
	}
	
	s.sendResponse(w, http.StatusOK, map[string]string{"message": "Mining started"})
}

func (s *Server) handleMiningStop(w http.ResponseWriter, r *http.Request) {
	if err := s.mining.Stop(); err != nil {
		s.sendError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to stop mining: %v", err))
		return
	}
	
	s.sendResponse(w, http.StatusOK, map[string]string{"message": "Mining stopped"})
}

func (s *Server) handleMiningStatus(w http.ResponseWriter, r *http.Request) {
	status := s.mining.GetStatus()
	s.sendResponse(w, http.StatusOK, status)
}

func (s *Server) handleMiningStats(w http.ResponseWriter, r *http.Request) {
	stats := s.mining.GetStatistics()
	s.sendResponse(w, http.StatusOK, stats)
}

func (s *Server) handleMiningConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		// Get config
		s.sendResponse(w, http.StatusOK, map[string]interface{}{"config": "current config"})
	} else {
		// Update config
		var config map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&config); err != nil {
			s.sendError(w, http.StatusBadRequest, "Invalid configuration")
			return
		}
		
		s.sendResponse(w, http.StatusOK, map[string]string{"message": "Configuration updated"})
	}
}

func (s *Server) handlePools(w http.ResponseWriter, r *http.Request) {
	// Get pools list
	pools := []map[string]interface{}{
		{
			"id":       "pool1",
			"url":      "{{.STRATUM_URL}}",
			"user":     "wallet.worker",
			"priority": 1,
			"enabled":  true,
		},
	}
	
	s.sendResponse(w, http.StatusOK, pools)
}

func (s *Server) handleAddPool(w http.ResponseWriter, r *http.Request) {
	var pool map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&pool); err != nil {
		s.sendError(w, http.StatusBadRequest, "Invalid pool configuration")
		return
	}
	
	s.sendResponse(w, http.StatusCreated, map[string]string{"message": "Pool added", "id": "new-pool-id"})
}

func (s *Server) handlePool(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	poolID := vars["id"]
	
	switch r.Method {
	case "GET":
		// Get pool details
		pool := map[string]interface{}{
			"id":       poolID,
			"url":      "{{.STRATUM_URL}}",
			"user":     "wallet.worker",
			"priority": 1,
			"enabled":  true,
		}
		s.sendResponse(w, http.StatusOK, pool)
		
	case "PUT":
		// Update pool
		var pool map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&pool); err != nil {
			s.sendError(w, http.StatusBadRequest, "Invalid pool configuration")
			return
		}
		s.sendResponse(w, http.StatusOK, map[string]string{"message": "Pool updated"})
		
	case "DELETE":
		// Delete pool
		s.sendResponse(w, http.StatusOK, map[string]string{"message": "Pool deleted"})
	}
}

func (s *Server) handleHardware(w http.ResponseWriter, r *http.Request) {
	hardware := []map[string]interface{}{
		{
			"id":          "cpu0",
			"type":        "CPU",
			"name":        "AMD Ryzen 9 5950X",
			"enabled":     true,
			"temperature": 65.5,
			"hashrate":    15000000,
		},
		{
			"id":          "gpu0",
			"type":        "GPU",
			"name":        "NVIDIA RTX 4090",
			"enabled":     true,
			"temperature": 72.3,
			"hashrate":    120000000,
		},
	}
	
	s.sendResponse(w, http.StatusOK, hardware)
}

func (s *Server) handleHardwareConfig(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	hardwareID := vars["id"]
	
	if r.Method == "GET" {
		config := map[string]interface{}{
			"id":               hardwareID,
			"power_limit":      250,
			"core_clock":       1850,
			"memory_clock":     5000,
			"fan_speed":        70,
			"temperature_limit": 85,
		}
		s.sendResponse(w, http.StatusOK, config)
	} else {
		var config map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&config); err != nil {
			s.sendError(w, http.StatusBadRequest, "Invalid configuration")
			return
		}
		s.sendResponse(w, http.StatusOK, map[string]string{"message": "Configuration updated"})
	}
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	stats := map[string]interface{}{
		"hashrate":        s.mining.GetHashrate(),
		"shares_accepted": 1234,
		"shares_rejected": 5,
		"uptime":          86400,
		"earnings":        0.00123456,
	}
	
	s.sendResponse(w, http.StatusOK, stats)
}

func (s *Server) handleStatsHistory(w http.ResponseWriter, r *http.Request) {
	// Parse query parameters
	period := r.URL.Query().Get("period")
	if period == "" {
		period = "24h"
	}
	
	history := []map[string]interface{}{
		{
			"timestamp": time.Now().Add(-1 * time.Hour),
			"hashrate":  100000000,
			"shares":    50,
		},
		{
			"timestamp": time.Now(),
			"hashrate":  120000000,
			"shares":    60,
		},
	}
	
	s.sendResponse(w, http.StatusOK, history)
}

func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		config := map[string]interface{}{
			"algorithm": "sha256d",
			"pools":     []string{"pool1", "pool2"},
			"hardware":  map[string]bool{"cpu": true, "gpu": true},
		}
		s.sendResponse(w, http.StatusOK, config)
	} else {
		var config map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&config); err != nil {
			s.sendError(w, http.StatusBadRequest, "Invalid configuration")
			return
		}
		s.sendResponse(w, http.StatusOK, map[string]string{"message": "Configuration updated"})
	}
}

func (s *Server) handleConfigExport(w http.ResponseWriter, r *http.Request) {
	config := map[string]interface{}{
		"version":   "1.0.0",
		"exported":  time.Now(),
		"algorithm": "sha256d",
		"pools":     []string{"pool1", "pool2"},
	}
	
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", "attachment; filename=otedama-config.json")
	json.NewEncoder(w).Encode(config)
}

func (s *Server) handleConfigImport(w http.ResponseWriter, r *http.Request) {
	var config map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&config); err != nil {
		s.sendError(w, http.StatusBadRequest, "Invalid configuration file")
		return
	}
	
	s.sendResponse(w, http.StatusOK, map[string]string{"message": "Configuration imported successfully"})
}

// WebSocket handlers

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := s.wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	
	wsConn := s.createWSConnection(conn)
	
	s.mu.Lock()
	s.wsConnections[wsConn.ID] = wsConn
	s.mu.Unlock()
	
	go wsConn.readLoop()
	go wsConn.writeLoop()
}

func (s *Server) handleWebSocketStats(w http.ResponseWriter, r *http.Request) {
	conn, err := s.wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	
	wsConn := s.createWSConnection(conn)
	wsConn.subscribed["stats"] = true
	
	s.mu.Lock()
	s.wsConnections[wsConn.ID] = wsConn
	s.mu.Unlock()
	
	go wsConn.readLoop()
	go wsConn.writeLoop()
	go s.streamStats(wsConn)
}

func (s *Server) handleWebSocketEvents(w http.ResponseWriter, r *http.Request) {
	conn, err := s.wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	
	wsConn := s.createWSConnection(conn)
	wsConn.subscribed["events"] = true
	
	s.mu.Lock()
	s.wsConnections[wsConn.ID] = wsConn
	s.mu.Unlock()
	
	go wsConn.readLoop()
	go wsConn.writeLoop()
}

// WebSocket connection management

func (s *Server) createWSConnection(conn *websocket.Conn) *WSConnection {
	ctx, cancel := context.WithCancel(s.ctx)
	
	return &WSConnection{
		ID:         generateID(),
		Conn:       conn,
		SendChan:   make(chan interface{}, 100),
		ctx:        ctx,
		cancel:     cancel,
		subscribed: make(map[string]bool),
	}
}

func (s *Server) manageWebSockets() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			s.pingWebSockets()
		}
	}
}

func (s *Server) pingWebSockets() {
	s.mu.RLock()
	connections := make([]*WSConnection, 0, len(s.wsConnections))
	for _, conn := range s.wsConnections {
		connections = append(connections, conn)
	}
	s.mu.RUnlock()
	
	for _, conn := range connections {
		if err := conn.Conn.WriteControl(websocket.PingMessage, []byte{}, time.Now().Add(10*time.Second)); err != nil {
			conn.Close()
			s.removeWSConnection(conn.ID)
		}
	}
}

func (s *Server) removeWSConnection(id string) {
	s.mu.Lock()
	delete(s.wsConnections, id)
	s.mu.Unlock()
}

func (s *Server) streamStats(conn *WSConnection) {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-conn.ctx.Done():
			return
		case <-ticker.C:
			stats := map[string]interface{}{
				"timestamp": time.Now(),
				"hashrate":  s.mining.GetHashrate(),
				"status":    s.mining.GetStatus(),
			}
			
			select {
			case conn.SendChan <- stats:
			default:
				// Channel full, skip
			}
		}
	}
}

// WebSocket connection methods

func (wsc *WSConnection) readLoop() {
	defer wsc.Close()
	
	wsc.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	wsc.Conn.SetPongHandler(func(string) error {
		wsc.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})
	
	for {
		_, message, err := wsc.Conn.ReadMessage()
		if err != nil {
			return
		}
		
		// Process message
		var msg map[string]interface{}
		if err := json.Unmarshal(message, &msg); err != nil {
			continue
		}
		
		// Handle message based on type
		if msgType, ok := msg["type"].(string); ok {
			switch msgType {
			case "subscribe":
				if topic, ok := msg["topic"].(string); ok {
					wsc.subscribed[topic] = true
				}
			case "unsubscribe":
				if topic, ok := msg["topic"].(string); ok {
					delete(wsc.subscribed, topic)
				}
			}
		}
	}
}

func (wsc *WSConnection) writeLoop() {
	ticker := time.NewTicker(54 * time.Second)
	defer func() {
		ticker.Stop()
		wsc.Close()
	}()
	
	for {
		select {
		case message, ok := <-wsc.SendChan:
			wsc.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				wsc.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			
			if err := wsc.Conn.WriteJSON(message); err != nil {
				return
			}
			
		case <-ticker.C:
			wsc.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := wsc.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (wsc *WSConnection) Close() {
	wsc.cancel()
	wsc.Conn.Close()
}

// Helper methods

func (s *Server) sendResponse(w http.ResponseWriter, status int, data interface{}) {
	response := Response{
		Success: status < 400,
		Data:    data,
		Meta: &Meta{
			Timestamp: time.Now(),
			RequestID: generateID(),
			Version:   "1.0.0",
		},
	}
	
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(response)
}

func (s *Server) sendError(w http.ResponseWriter, status int, message string) {
	response := Response{
		Success: false,
		Error:   message,
		Meta: &Meta{
			Timestamp: time.Now(),
			RequestID: generateID(),
			Version:   "1.0.0",
		},
	}
	
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(response)
}

func (s *Server) collectMetrics() {
	// Periodic metrics collection
}

// AuthManager methods

func NewAuthManager() *AuthManager {
	return &AuthManager{
		tokens:        make(map[string]*Token),
		refreshTokens: make(map[string]*RefreshToken),
		apiKeys:       make(map[string]*APIKey),
		jwtSecret:     generateSecret(),
	}
}

func (am *AuthManager) Authenticate(username, password, mfa string) (*Token, *RefreshToken, error) {
	// Simplified authentication
	token := &Token{
		Value:     generateToken(),
		UserID:    username,
		ExpiresAt: time.Now().Add(24 * time.Hour),
		Scopes:    []string{"read", "write"},
	}
	
	refreshToken := &RefreshToken{
		Value:     generateToken(),
		UserID:    username,
		ExpiresAt: time.Now().Add(7 * 24 * time.Hour),
	}
	
	am.mu.Lock()
	am.tokens[token.Value] = token
	am.refreshTokens[refreshToken.Value] = refreshToken
	am.mu.Unlock()
	
	return token, refreshToken, nil
}

func (am *AuthManager) ValidateToken(tokenValue string) bool {
	am.mu.RLock()
	defer am.mu.RUnlock()
	
	token, exists := am.tokens[tokenValue]
	if !exists {
		return false
	}
	
	return time.Now().Before(token.ExpiresAt)
}

func (am *AuthManager) RefreshToken(refreshTokenValue string) (*Token, error) {
	am.mu.Lock()
	defer am.mu.Unlock()
	
	refreshToken, exists := am.refreshTokens[refreshTokenValue]
	if !exists || time.Now().After(refreshToken.ExpiresAt) {
		return nil, fmt.Errorf("invalid refresh token")
	}
	
	// Create new token
	token := &Token{
		Value:     generateToken(),
		UserID:    refreshToken.UserID,
		ExpiresAt: time.Now().Add(24 * time.Hour),
		Scopes:    []string{"read", "write"},
	}
	
	am.tokens[token.Value] = token
	
	return token, nil
}

func (am *AuthManager) RevokeToken(tokenValue string) {
	am.mu.Lock()
	defer am.mu.Unlock()
	delete(am.tokens, tokenValue)
}

// Utility functions

type responseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.statusCode = code
	rw.ResponseWriter.WriteHeader(code)
}

func getClientIP(r *http.Request) string {
	// Check X-Forwarded-For header
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return xff
	}
	
	// Check X-Real-IP header
	if xri := r.Header.Get("X-Real-IP"); xri != "" {
		return xri
	}
	
	// Use RemoteAddr
	return r.RemoteAddr
}

func extractToken(r *http.Request) string {
	// Check Authorization header
	auth := r.Header.Get("Authorization")
	if auth != "" && len(auth) > 7 && auth[:7] == "Bearer " {
		return auth[7:]
	}
	
	// Check query parameter
	return r.URL.Query().Get("token")
}

func generateID() string {
	return fmt.Sprintf("%d", time.Now().UnixNano())
}

func generateToken() string {
	return fmt.Sprintf("token_%d", time.Now().UnixNano())
}

func generateSecret() []byte {
	return []byte("secret_key_change_in_production")
}