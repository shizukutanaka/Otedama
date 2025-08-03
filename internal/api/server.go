package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/gorilla/mux"
	"github.com/gorilla/websocket"
	"github.com/shizukutanaka/Otedama/internal/mining"
	"go.uber.org/zap"
)

// Server provides HTTP API and WebSocket interfaces
// Simple, efficient implementation focused on essential functionality
type Server struct {
	logger     *zap.Logger
	config     Config
	router     *mux.Router
	server     *http.Server
	upgrader   websocket.Upgrader
	clients    map[*websocket.Conn]bool
	stats      map[string]interface{}
	engine     mining.Engine
	validator  *InputValidator
}

// Config defines API server configuration
type Config struct {
	Enabled    bool     `yaml:"enabled"`
	ListenAddr string   `yaml:"listen_addr"`
	EnableTLS  bool     `yaml:"enable_tls"`
	CertFile   string   `yaml:"cert_file"`
	KeyFile    string   `yaml:"key_file"`
	RateLimit  int      `yaml:"rate_limit"`
	AllowOrigins []string `yaml:"allow_origins"`
}

// Response represents API response format
type Response struct {
	Success bool        `json:"success"`
	Data    interface{} `json:"data,omitempty"`
	Error   string      `json:"error,omitempty"`
	Time    time.Time   `json:"time"`
}

// NewServer creates a new API server
func NewServer(config Config, logger *zap.Logger, engine mining.Engine) (*Server, error) {
	if !config.Enabled {
		return nil, fmt.Errorf("API server disabled")
	}

	server := &Server{
		logger:    logger,
		config:    config,
		clients:   make(map[*websocket.Conn]bool),
		stats:     make(map[string]interface{}),
		engine:    engine,
		validator: NewInputValidator(),
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				// Check against allowed origins
				if len(config.AllowOrigins) == 0 {
					// No origins configured, deny all
					return false
				}
				
				origin := r.Header.Get("Origin")
				if origin == "" {
					// No origin header, deny
					return false
				}
				
				// Check if origin is in allowed list
				for _, allowed := range config.AllowOrigins {
					if allowed == "*" || allowed == origin {
						return true
					}
				}
				
				return false
			},
		},
	}

	server.setupRoutes()
	return server, nil
}

// Start begins API server operations
func (s *Server) Start(ctx context.Context) error {
	s.server = &http.Server{
		Addr:         s.config.ListenAddr,
		Handler:      s.router,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	s.logger.Info("Starting API server",
		zap.String("listen_addr", s.config.ListenAddr),
		zap.Bool("tls_enabled", s.config.EnableTLS),
	)

	go func() {
		var err error
		if s.config.EnableTLS {
			err = s.server.ListenAndServeTLS(s.config.CertFile, s.config.KeyFile)
		} else {
			err = s.server.ListenAndServe()
		}

		if err != nil && err != http.ErrServerClosed {
			s.logger.Error("API server error", zap.Error(err))
		}
	}()

	return nil
}

// Shutdown gracefully stops the API server
func (s *Server) Shutdown(ctx context.Context) error {
	s.logger.Info("Shutting down API server")

	// Close all WebSocket connections
	for client := range s.clients {
		client.Close()
	}

	if s.server != nil {
		return s.server.Shutdown(ctx)
	}

	return nil
}

// setupRoutes configures API routes
func (s *Server) setupRoutes() {
	s.router = mux.NewRouter()

	// API routes
	api := s.router.PathPrefix("/api/v1").Subrouter()
	api.Use(s.corsMiddleware)
	api.Use(s.loggingMiddleware)

	// System endpoints
	api.HandleFunc("/status", s.handleStatus).Methods("GET")
	api.HandleFunc("/stats", s.handleStats).Methods("GET")
	api.HandleFunc("/health", s.handleHealth).Methods("GET")

	// Mining endpoints
	api.HandleFunc("/mining/stats", s.handleMiningStats).Methods("GET")
	api.HandleFunc("/mining/start", s.handleMiningStart).Methods("POST")
	api.HandleFunc("/mining/stop", s.handleMiningStop).Methods("POST")
	api.HandleFunc("/mining/workers", s.handleMiningWorkers).Methods("GET")
	api.HandleFunc("/mining/workers/{id}/control", s.handleWorkerControl).Methods("POST")

	// Pool endpoints
	api.HandleFunc("/pool/stats", s.handlePoolStats).Methods("GET")
	api.HandleFunc("/pool/peers", s.handlePoolPeers).Methods("GET")
	api.HandleFunc("/pool/shares", s.handlePoolShares).Methods("GET")
	api.HandleFunc("/pool/info", s.handlePoolInfo).Methods("GET")

	// Stratum endpoints
	api.HandleFunc("/stratum/info", s.handleStratumInfo).Methods("GET")

	// Profit switching endpoints
	api.HandleFunc("/profit/status", s.handleProfitStatus).Methods("GET")
	api.HandleFunc("/profit/switch", s.handleProfitSwitch).Methods("POST")

	// Algorithm management endpoints
	s.RegisterAlgorithmRoutes(api)

	// Log management endpoints
	s.RegisterLogRoutes(api)

	// Internationalization endpoints
	s.RegisterI18nRoutes(api)

	// WebSocket endpoint
	api.HandleFunc("/ws", s.handleWebSocket)

	// Static dashboard (if needed)
	s.router.PathPrefix("/").Handler(http.FileServer(http.Dir("./web/static/")))
}

// Middleware

func (s *Server) corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		
		// Check if origin is allowed
		if origin != "" && len(s.config.AllowOrigins) > 0 {
			for _, allowed := range s.config.AllowOrigins {
				if allowed == "*" {
					w.Header().Set("Access-Control-Allow-Origin", origin)
					w.Header().Set("Access-Control-Allow-Credentials", "true")
					break
				} else if allowed == origin {
					w.Header().Set("Access-Control-Allow-Origin", origin)
					w.Header().Set("Access-Control-Allow-Credentials", "true")
					break
				}
			}
		}
		
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Max-Age", "3600")

		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func (s *Server) loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		duration := time.Since(start)

		s.logger.Debug("API request",
			zap.String("method", r.Method),
			zap.String("path", r.URL.Path),
			zap.Duration("duration", duration),
		)
	})
}

// Handlers

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	response := Response{
		Success: true,
		Data: map[string]interface{}{
			"service": "Otedama Mining Pool",
			"version": "2.1.3",
			"uptime":  time.Since(time.Now()).Seconds(), // Placeholder
			"status":  "running",
		},
		Time: time.Now(),
	}

	s.sendJSON(w, http.StatusOK, response)
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	response := Response{
		Success: true,
		Data:    s.stats,
		Time:    time.Now(),
	}

	s.sendJSON(w, http.StatusOK, response)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	response := Response{
		Success: true,
		Data: map[string]interface{}{
			"status": "healthy",
			"checks": map[string]bool{
				"api_server": true,
				"database":   true, // Placeholder
				"network":    true, // Placeholder
			},
		},
		Time: time.Now(),
	}

	s.sendJSON(w, http.StatusOK, response)
}

func (s *Server) handleMiningStats(w http.ResponseWriter, r *http.Request) {
	// Placeholder mining stats
	stats := map[string]interface{}{
		"hash_rate":     0,
		"valid_shares":  0,
		"difficulty":    0x1d00ffff,
		"algorithm":     "sha256d",
		"threads":       0,
		"running":       false,
	}

	response := Response{
		Success: true,
		Data:    stats,
		Time:    time.Now(),
	}

	s.sendJSON(w, http.StatusOK, response)
}

func (s *Server) handleMiningStart(w http.ResponseWriter, r *http.Request) {
	// TODO: Implement mining start logic
	response := Response{
		Success: true,
		Data:    map[string]interface{}{"message": "Mining started"},
		Time:    time.Now(),
	}

	s.sendJSON(w, http.StatusOK, response)
}

func (s *Server) handleMiningStop(w http.ResponseWriter, r *http.Request) {
	// TODO: Implement mining stop logic
	response := Response{
		Success: true,
		Data:    map[string]interface{}{"message": "Mining stopped"},
		Time:    time.Now(),
	}

	s.sendJSON(w, http.StatusOK, response)
}

func (s *Server) handlePoolStats(w http.ResponseWriter, r *http.Request) {
	// Placeholder pool stats
	stats := map[string]interface{}{
		"peer_count":       0,
		"total_shares":     0,
		"blocks_found":     0,
		"total_hashrate":   0,
		"share_difficulty": 1000.0,
		"fee_percentage":   1.0,
	}

	response := Response{
		Success: true,
		Data:    stats,
		Time:    time.Now(),
	}

	s.sendJSON(w, http.StatusOK, response)
}

func (s *Server) handlePoolPeers(w http.ResponseWriter, r *http.Request) {
	// Placeholder peers data
	peers := []map[string]interface{}{}

	response := Response{
		Success: true,
		Data:    peers,
		Time:    time.Now(),
	}

	s.sendJSON(w, http.StatusOK, response)
}

func (s *Server) handlePoolShares(w http.ResponseWriter, r *http.Request) {
	// Placeholder shares data
	shares := []map[string]interface{}{}

	response := Response{
		Success: true,
		Data:    shares,
		Time:    time.Now(),
	}

	s.sendJSON(w, http.StatusOK, response)
}

func (s *Server) handleMiningWorkers(w http.ResponseWriter, r *http.Request) {
	// Placeholder workers data
	workers := []map[string]interface{}{
		{
			"id":          "worker-1",
			"name":        "CPU-Worker-1",
			"type":        "CPU",
			"hashrate":    125000,
			"temperature": 65,
			"power":       100,
			"status":      "active",
			"shares_accepted": 42,
			"shares_rejected": 2,
		},
	}

	response := Response{
		Success: true,
		Data:    workers,
		Time:    time.Now(),
	}

	s.sendJSON(w, http.StatusOK, response)
}

func (s *Server) handleWorkerControl(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	workerID := vars["id"]
	
	// Validate worker ID
	if err := s.validator.ValidateWorkerID(workerID); err != nil {
		s.sendError(w, http.StatusBadRequest, fmt.Sprintf("Invalid worker ID: %v", err))
		return
	}
	
	var req struct {
		Action string `json:"action"`
	}
	
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.sendError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	
	// Validate action
	if err := s.validator.ValidateAction(req.Action); err != nil {
		s.sendError(w, http.StatusBadRequest, fmt.Sprintf("Invalid action: %v", err))
		return
	}
	
	response := Response{
		Success: true,
		Data: map[string]interface{}{
			"worker_id": workerID,
			"action":    req.Action,
			"message":   fmt.Sprintf("Worker %s %s successful", workerID, req.Action),
		},
		Time: time.Now(),
	}

	s.sendJSON(w, http.StatusOK, response)
}

func (s *Server) handlePoolInfo(w http.ResponseWriter, r *http.Request) {
	info := map[string]interface{}{
		"name":         "Otedama P2P Pool",
		"type":         "P2P",
		"fee":          1.0,
		"min_payout":   0.001,
		"payment_type": "PPLNS",
		"algorithms":   []string{"SHA256d", "Ethash", "KawPow", "RandomX", "Scrypt"},
	}

	response := Response{
		Success: true,
		Data:    info,
		Time:    time.Now(),
	}

	s.sendJSON(w, http.StatusOK, response)
}

func (s *Server) handleStratumInfo(w http.ResponseWriter, r *http.Request) {
	info := map[string]interface{}{
		"enabled":     true,
		"port":        3333,
		"difficulty":  16384,
		"connections": 0,
		"protocols":   []string{"stratum+tcp", "stratum+ssl"},
	}

	response := Response{
		Success: true,
		Data:    info,
		Time:    time.Now(),
	}

	s.sendJSON(w, http.StatusOK, response)
}

func (s *Server) handleProfitStatus(w http.ResponseWriter, r *http.Request) {
	status := map[string]interface{}{
		"enabled":          true,
		"current_algo":     "SHA256d",
		"next_switch":      time.Now().Add(15 * time.Minute),
		"profit_threshold": 5.0,
		"algorithms": []map[string]interface{}{
			{
				"name":           "SHA256d",
				"profitability":  1.0,
				"hashrate":       1250000,
				"profit_per_day": 0.00012,
			},
			{
				"name":           "Ethash",
				"profitability":  0.95,
				"hashrate":       30000000,
				"profit_per_day": 0.00011,
			},
		},
	}

	response := Response{
		Success: true,
		Data:    status,
		Time:    time.Now(),
	}

	s.sendJSON(w, http.StatusOK, response)
}

func (s *Server) handleProfitSwitch(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Algorithm string `json:"algorithm"`
		Force     bool   `json:"force"`
	}
	
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.sendError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	
	// Validate algorithm
	if err := s.validator.ValidateAlgorithm(req.Algorithm); err != nil {
		s.sendError(w, http.StatusBadRequest, fmt.Sprintf("Invalid algorithm: %v", err))
		return
	}
	
	response := Response{
		Success: true,
		Data: map[string]interface{}{
			"algorithm": req.Algorithm,
			"forced":    req.Force,
			"message":   fmt.Sprintf("Switching to %s algorithm", req.Algorithm),
		},
		Time: time.Now(),
	}

	s.sendJSON(w, http.StatusOK, response)
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.logger.Error("WebSocket upgrade failed", zap.Error(err))
		return
	}
	defer conn.Close()

	// Add client
	s.clients[conn] = true
	s.logger.Info("WebSocket client connected",
		zap.String("remote_addr", conn.RemoteAddr().String()),
	)

	// Send initial stats
	s.sendStatsToClient(conn)

	// Handle messages
	for {
		var msg map[string]interface{}
		err := conn.ReadJSON(&msg)
		if err != nil {
			s.logger.Debug("WebSocket client disconnected", zap.Error(err))
			break
		}

		// Handle client message
		s.handleWebSocketMessage(conn, msg)
	}

	// Remove client
	delete(s.clients, conn)
}

func (s *Server) handleWebSocketMessage(conn *websocket.Conn, msg map[string]interface{}) {
	msgType, ok := msg["type"].(string)
	if !ok {
		return
	}

	switch msgType {
	case "get_stats":
		s.sendStatsToClient(conn)
	case "ping":
		response := map[string]interface{}{
			"type": "pong",
			"time": time.Now(),
		}
		conn.WriteJSON(response)
	}
}

func (s *Server) sendStatsToClient(conn *websocket.Conn) {
	message := map[string]interface{}{
		"type": "stats_update",
		"data": s.stats,
		"time": time.Now(),
	}

	if err := conn.WriteJSON(message); err != nil {
		s.logger.Error("Failed to send WebSocket message", zap.Error(err))
	}
}

// UpdateStats updates the cached statistics
func (s *Server) UpdateStats(stats map[string]interface{}) {
	s.stats = stats

	// Broadcast to WebSocket clients
	s.broadcastStats()
}

// broadcastStats sends stats to all connected WebSocket clients
func (s *Server) broadcastStats() {
	message := map[string]interface{}{
		"type": "stats_update",
		"data": s.stats,
		"time": time.Now(),
	}

	for client := range s.clients {
		if err := client.WriteJSON(message); err != nil {
			s.logger.Error("Failed to broadcast stats", zap.Error(err))
			client.Close()
			delete(s.clients, client)
		}
	}
}

// sendJSON sends JSON response
func (s *Server) sendJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	if err := json.NewEncoder(w).Encode(data); err != nil {
		s.logger.Error("Failed to encode JSON response", zap.Error(err))
	}
}

// sendError sends error response
func (s *Server) sendError(w http.ResponseWriter, status int, message string) {
	response := Response{
		Success: false,
		Error:   message,
		Time:    time.Now(),
	}

	s.sendJSON(w, status, response)
}

// writeJSON writes JSON response (helper for algorithm routes)
func (s *Server) writeJSON(w http.ResponseWriter, status int, data interface{}) {
	s.sendJSON(w, status, data)
}

// writeError writes error response (helper for algorithm routes)
func (s *Server) writeError(w http.ResponseWriter, status int, message string) {
	s.sendError(w, status, message)
}
