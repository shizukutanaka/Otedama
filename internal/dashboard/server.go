package dashboard

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/gorilla/mux"
	"github.com/gorilla/websocket"
	"go.uber.org/zap"
	
	"github.com/shizukutanaka/Otedama/internal/core"
	"github.com/shizukutanaka/Otedama/internal/mining"
	"github.com/shizukutanaka/Otedama/internal/monitoring"
	"github.com/shizukutanaka/Otedama/internal/currency"
)

//go:embed static/*
var staticFiles embed.FS

// Server represents the dashboard web server
type Server struct {
	logger *zap.Logger
	config Config
	router *mux.Router
	
	// Core components
	system    *core.System
	mining    *mining.Engine
	monitor   *monitoring.HealthMonitor
	currency  *currency.MultiCurrencyManager
	
	// WebSocket
	upgrader  websocket.Upgrader
	clients   map[*Client]bool
	broadcast chan []byte
	
	// Server
	server *http.Server
}

// Config defines dashboard configuration
type Config struct {
	Enabled       bool   `yaml:"enabled"`
	ListenAddress string `yaml:"listen_address"`
	EnableAuth    bool   `yaml:"enable_auth"`
	Username      string `yaml:"username"`
	Password      string `yaml:"password"`
	EnableTLS     bool   `yaml:"enable_tls"`
	CertFile      string `yaml:"cert_file"`
	KeyFile       string `yaml:"key_file"`
}

// Client represents a WebSocket client
type Client struct {
	conn   *websocket.Conn
	send   chan []byte
	server *Server
}

// NewServer creates a new dashboard server
func NewServer(logger *zap.Logger, config Config, system *core.System, mining *mining.Engine, monitor *monitoring.HealthMonitor, currency *currency.MultiCurrencyManager) *Server {
	s := &Server{
		logger:    logger,
		config:    config,
		system:    system,
		mining:    mining,
		monitor:   monitor,
		currency:  currency,
		clients:   make(map[*Client]bool),
		broadcast: make(chan []byte),
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				return true // Allow connections from any origin
			},
		},
	}
	
	s.setupRoutes()
	
	return s
}

// Start begins the dashboard server
func (s *Server) Start(ctx context.Context) error {
	if !s.config.Enabled {
		s.logger.Info("Dashboard server disabled")
		return nil
	}
	
	s.server = &http.Server{
		Addr:    s.config.ListenAddress,
		Handler: s.router,
	}
	
	// Start WebSocket hub
	go s.runHub()
	
	// Start metrics broadcaster
	go s.metricsBroadcaster(ctx)
	
	s.logger.Info("Starting dashboard server", 
		zap.String("address", s.config.ListenAddress),
		zap.Bool("auth", s.config.EnableAuth),
		zap.Bool("tls", s.config.EnableTLS),
	)
	
	if s.config.EnableTLS {
		return s.server.ListenAndServeTLS(s.config.CertFile, s.config.KeyFile)
	}
	
	return s.server.ListenAndServe()
}

// Stop gracefully shuts down the server
func (s *Server) Stop() error {
	if s.server == nil {
		return nil
	}
	
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	
	return s.server.Shutdown(ctx)
}

// Setup routes
func (s *Server) setupRoutes() {
	s.router = mux.NewRouter()
	
	// API routes
	api := s.router.PathPrefix("/api/v1").Subrouter()
	if s.config.EnableAuth {
		api.Use(s.authMiddleware)
	}
	
	// System info
	api.HandleFunc("/system/info", s.handleSystemInfo).Methods("GET")
	api.HandleFunc("/system/stats", s.handleSystemStats).Methods("GET")
	
	// Mining
	api.HandleFunc("/mining/stats", s.handleMiningStats).Methods("GET")
	api.HandleFunc("/mining/workers", s.handleMiningWorkers).Methods("GET")
	api.HandleFunc("/mining/shares", s.handleMiningShares).Methods("GET")
	api.HandleFunc("/mining/control", s.handleMiningControl).Methods("POST")
	
	// Health
	api.HandleFunc("/health/status", s.handleHealthStatus).Methods("GET")
	api.HandleFunc("/health/checks", s.handleHealthChecks).Methods("GET")
	
	// Currency
	api.HandleFunc("/currency/list", s.handleCurrencyList).Methods("GET")
	api.HandleFunc("/currency/balances", s.handleCurrencyBalances).Methods("GET")
	api.HandleFunc("/currency/rates", s.handleExchangeRates).Methods("GET")
	
	// Configuration
	api.HandleFunc("/config", s.handleGetConfig).Methods("GET")
	api.HandleFunc("/config", s.handleUpdateConfig).Methods("PUT")
	
	// WebSocket
	s.router.HandleFunc("/ws", s.handleWebSocket)
	
	// Static files
	s.router.PathPrefix("/").Handler(http.FileServer(http.FS(staticFiles)))
}

// Authentication middleware
func (s *Server) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok := r.BasicAuth()
		if !ok || user != s.config.Username || pass != s.config.Password {
			w.Header().Set("WWW-Authenticate", `Basic realm="Otedama Dashboard"`)
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// API Handlers

func (s *Server) handleSystemInfo(w http.ResponseWriter, r *http.Request) {
	info := map[string]interface{}{
		"version":    "2.0.0",
		"name":       "Otedama",
		"uptime":     time.Since(s.system.StartTime()).String(),
		"node_id":    s.system.NodeID(),
		"network":    s.system.NetworkType(),
	}
	
	s.respondJSON(w, info)
}

func (s *Server) handleSystemStats(w http.ResponseWriter, r *http.Request) {
	stats := s.system.GetStats()
	s.respondJSON(w, stats)
}

func (s *Server) handleMiningStats(w http.ResponseWriter, r *http.Request) {
	stats := s.mining.GetStats()
	s.respondJSON(w, stats)
}

func (s *Server) handleMiningWorkers(w http.ResponseWriter, r *http.Request) {
	workers := s.mining.GetWorkers()
	s.respondJSON(w, workers)
}

func (s *Server) handleMiningShares(w http.ResponseWriter, r *http.Request) {
	shares := s.mining.GetRecentShares(100)
	s.respondJSON(w, shares)
}

func (s *Server) handleMiningControl(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Action string `json:"action"`
	}
	
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	
	switch req.Action {
	case "start":
		if err := s.mining.Start(context.Background()); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	case "stop":
		if err := s.mining.Stop(); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	case "pause":
		s.mining.Pause()
	case "resume":
		s.mining.Resume()
	default:
		http.Error(w, "Invalid action", http.StatusBadRequest)
		return
	}
	
	s.respondJSON(w, map[string]string{"status": "ok"})
}

func (s *Server) handleHealthStatus(w http.ResponseWriter, r *http.Request) {
	status := s.monitor.GetOverallStatus()
	s.respondJSON(w, status)
}

func (s *Server) handleHealthChecks(w http.ResponseWriter, r *http.Request) {
	checks := s.monitor.GetHealthChecks()
	s.respondJSON(w, checks)
}

func (s *Server) handleCurrencyList(w http.ResponseWriter, r *http.Request) {
	currencies := s.currency.GetSupportedCurrencies()
	s.respondJSON(w, currencies)
}

func (s *Server) handleCurrencyBalances(w http.ResponseWriter, r *http.Request) {
	balances := make(map[string]string)
	
	for _, currency := range s.currency.GetSupportedCurrencies() {
		balance, err := s.currency.GetBalance(currency)
		if err == nil {
			balances[currency] = balance.String()
		}
	}
	
	s.respondJSON(w, balances)
}

func (s *Server) handleExchangeRates(w http.ResponseWriter, r *http.Request) {
	rates := make(map[string]interface{})
	
	// Get rates for common pairs
	pairs := []struct{ From, To string }{
		{"BTC", "USD"},
		{"ETH", "USD"},
		{"LTC", "USD"},
	}
	
	for _, pair := range pairs {
		rate, err := s.currency.GetExchangeRate(pair.From, pair.To)
		if err == nil {
			rates[fmt.Sprintf("%s_%s", pair.From, pair.To)] = rate.Rate
		}
	}
	
	s.respondJSON(w, rates)
}

func (s *Server) handleGetConfig(w http.ResponseWriter, r *http.Request) {
	// Return sanitized config (without sensitive data)
	config := map[string]interface{}{
		"mining": map[string]interface{}{
			"algorithm": s.mining.GetAlgorithm(),
			"threads":   s.mining.GetThreadCount(),
		},
		"pool": map[string]interface{}{
			"address": s.system.PoolAddress(),
			"fee":     s.system.PoolFee(),
		},
	}
	
	s.respondJSON(w, config)
}

func (s *Server) handleUpdateConfig(w http.ResponseWriter, r *http.Request) {
	// This is a placeholder - implement based on your needs
	http.Error(w, "Not implemented", http.StatusNotImplemented)
}

// WebSocket handling

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.logger.Error("WebSocket upgrade failed", zap.Error(err))
		return
	}
	
	client := &Client{
		conn:   conn,
		send:   make(chan []byte, 256),
		server: s,
	}
	
	s.clients[client] = true
	
	go client.writePump()
	go client.readPump()
}

func (s *Server) runHub() {
	for {
		select {
		case message := <-s.broadcast:
			for client := range s.clients {
				select {
				case client.send <- message:
				default:
					close(client.send)
					delete(s.clients, client)
				}
			}
		}
	}
}

func (s *Server) metricsBroadcaster(ctx context.Context) {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			metrics := s.collectMetrics()
			data, _ := json.Marshal(metrics)
			s.broadcast <- data
		}
	}
}

func (s *Server) collectMetrics() map[string]interface{} {
	return map[string]interface{}{
		"timestamp": time.Now().Unix(),
		"mining":    s.mining.GetStats(),
		"health":    s.monitor.GetOverallStatus(),
		"system":    s.system.GetStats(),
	}
}

// Client methods

func (c *Client) readPump() {
	defer func() {
		delete(c.server.clients, c)
		c.conn.Close()
	}()
	
	c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})
	
	for {
		_, _, err := c.conn.ReadMessage()
		if err != nil {
			break
		}
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(54 * time.Second)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()
	
	for {
		select {
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			
			c.conn.WriteMessage(websocket.TextMessage, message)
			
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// Utility methods

func (s *Server) respondJSON(w http.ResponseWriter, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}