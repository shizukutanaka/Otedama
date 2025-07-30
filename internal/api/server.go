package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/gorilla/mux"
	"github.com/gorilla/websocket"
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
func NewServer(config Config, logger *zap.Logger) (*Server, error) {
	if !config.Enabled {
		return nil, fmt.Errorf("API server disabled")
	}

	server := &Server{
		logger:  logger,
		config:  config,
		clients: make(map[*websocket.Conn]bool),
		stats:   make(map[string]interface{}),
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				// Allow all origins for now - in production would check config.AllowOrigins
				return true
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

	// Pool endpoints
	api.HandleFunc("/pool/stats", s.handlePoolStats).Methods("GET")
	api.HandleFunc("/pool/peers", s.handlePoolPeers).Methods("GET")
	api.HandleFunc("/pool/shares", s.handlePoolShares).Methods("GET")

	// WebSocket endpoint
	api.HandleFunc("/ws", s.handleWebSocket)

	// Static dashboard (if needed)
	s.router.PathPrefix("/").Handler(http.FileServer(http.Dir("./web/static/")))
}

// Middleware

func (s *Server) corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

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
			"version": "3.0.0",
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
