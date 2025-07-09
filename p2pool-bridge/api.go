// API Server for P2Pool Bridge
//
// Lightweight REST API and WebSocket endpoints

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/rs/cors"
	"github.com/sirupsen/logrus"
)

// APIServer provides REST API and WebSocket endpoints
type APIServer struct {
	config   *Config
	router   *gin.Engine
	server   *http.Server
	upgrader websocket.Upgrader
	clients  map[*websocket.Conn]bool
	broadcast chan []byte
}

// PoolStats represents current pool statistics
type PoolStats struct {
	HashRate        uint64    `json:"hash_rate"`
	Difficulty      float64   `json:"difficulty"`
	ConnectedPeers  int       `json:"connected_peers"`
	SharesPerSecond uint64    `json:"shares_per_second"`
	BlocksFound     uint64    `json:"blocks_found"`
	LastBlockTime   *time.Time `json:"last_block_time,omitempty"`
	Uptime          int64     `json:"uptime"`
	Version         string    `json:"version"`
}

// ShareInfo represents share information
type ShareInfo struct {
	ID           string    `json:"id"`
	MinerAddress string    `json:"miner_address"`
	Difficulty   float64   `json:"difficulty"`
	Timestamp    time.Time `json:"timestamp"`
	Valid        bool      `json:"valid"`
}

// BlockInfo represents block information
type BlockInfo struct {
	Hash       string    `json:"hash"`
	Height     uint64    `json:"height"`
	Difficulty float64   `json:"difficulty"`
	Timestamp  time.Time `json:"timestamp"`
	Reward     uint64    `json:"reward"`
	Confirmed  bool      `json:"confirmed"`
}

// APIResponse represents standard API response
type APIResponse struct {
	Success bool        `json:"success"`
	Data    interface{} `json:"data,omitempty"`
	Error   string      `json:"error,omitempty"`
	Message string      `json:"message,omitempty"`
}

// NewAPIServer creates a new API server instance
func NewAPIServer(cfg *Config) *APIServer {
	if !cfg.API.Debug {
		gin.SetMode(gin.ReleaseMode)
	}

	router := gin.New()
	router.Use(gin.Logger())
	router.Use(gin.Recovery())

	upgrader := websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			return true // Allow all origins for development
		},
	}

	return &APIServer{
		config:   cfg,
		router:   router,
		upgrader: upgrader,
		clients:  make(map[*websocket.Conn]bool),
		broadcast: make(chan []byte),
	}
}

// Start starts the API server
func (s *APIServer) Start(ctx context.Context) error {
	s.setupRoutes()
	s.setupWebSocket()

	// Setup CORS
	c := cors.New(cors.Options{
		AllowedOrigins: []string{"*"},
		AllowedMethods: []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders: []string{"*"},
	})

	handler := c.Handler(s.router)

	s.server = &http.Server{
		Addr:    fmt.Sprintf("%s:%d", s.config.API.Host, s.config.API.Port),
		Handler: handler,
	}

	log.WithField("address", s.server.Addr).Info("Starting API server")

	// Start WebSocket message broadcaster
	go s.handleWebSocketMessages()

	// Start server in goroutine
	go func() {
		if err := s.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.WithError(err).Error("API server failed")
		}
	}()

	// Wait for context cancellation
	<-ctx.Done()
	return s.shutdown()
}

// shutdown gracefully shuts down the server
func (s *APIServer) shutdown() error {
	log.Info("Shutting down API server")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Close all WebSocket connections
	for client := range s.clients {
		client.Close()
		delete(s.clients, client)
	}

	return s.server.Shutdown(ctx)
}

// setupRoutes configures API routes
func (s *APIServer) setupRoutes() {
	api := s.router.Group("/api/v1")
	{
		// Pool statistics
		api.GET("/stats", s.getPoolStats)
		api.GET("/stats/history", s.getStatsHistory)

		// Shares
		api.GET("/shares", s.getShares)
		api.GET("/shares/:id", s.getShare)

		// Blocks
		api.GET("/blocks", s.getBlocks)
		api.GET("/blocks/:hash", s.getBlock)

		// Miners
		api.GET("/miners", s.getMiners)
		api.GET("/miners/:address", s.getMiner)
		api.GET("/miners/:address/shares", s.getMinerShares)

		// Payouts
		api.GET("/payouts", s.getPayouts)
		api.GET("/payouts/:address", s.getMinerPayouts)

		// System
		api.GET("/health", s.healthCheck)
		api.GET("/version", s.getVersion)
	}

	// Static web interface
	s.router.Static("/static", "./web/static")
	s.router.StaticFile("/", "./web/index.html")
	s.router.StaticFile("/favicon.ico", "./web/favicon.ico")

	// WebSocket endpoint
	s.router.GET("/ws", s.handleWebSocket)
}

// API Handlers

func (s *APIServer) getPoolStats(c *gin.Context) {
	// In a real implementation, this would fetch from the core client
	stats := PoolStats{
		HashRate:        1000000,
		Difficulty:      1000.0,
		ConnectedPeers:  5,
		SharesPerSecond: 10,
		BlocksFound:     1,
		Uptime:          3600,
		Version:         "0.1.0",
	}

	c.JSON(http.StatusOK, APIResponse{
		Success: true,
		Data:    stats,
	})
}

func (s *APIServer) getStatsHistory(c *gin.Context) {
	// Return mock historical data
	history := []PoolStats{
		{HashRate: 900000, Difficulty: 950.0, ConnectedPeers: 4},
		{HashRate: 950000, Difficulty: 975.0, ConnectedPeers: 4},
		{HashRate: 1000000, Difficulty: 1000.0, ConnectedPeers: 5},
	}

	c.JSON(http.StatusOK, APIResponse{
		Success: true,
		Data:    history,
	})
}

func (s *APIServer) getShares(c *gin.Context) {
	shares := []ShareInfo{
		{
			ID:           "share123",
			MinerAddress: "1MinerAddress",
			Difficulty:   1000.0,
			Timestamp:    time.Now(),
			Valid:        true,
		},
	}

	c.JSON(http.StatusOK, APIResponse{
		Success: true,
		Data:    shares,
	})
}

func (s *APIServer) getShare(c *gin.Context) {
	shareID := c.Param("id")

	share := ShareInfo{
		ID:           shareID,
		MinerAddress: "1MinerAddress",
		Difficulty:   1000.0,
		Timestamp:    time.Now(),
		Valid:        true,
	}

	c.JSON(http.StatusOK, APIResponse{
		Success: true,
		Data:    share,
	})
}

func (s *APIServer) getBlocks(c *gin.Context) {
	blocks := []BlockInfo{
		{
			Hash:       "blockhash123",
			Height:     100,
			Difficulty: 1000.0,
			Timestamp:  time.Now(),
			Reward:     5000000000,
			Confirmed:  true,
		},
	}

	c.JSON(http.StatusOK, APIResponse{
		Success: true,
		Data:    blocks,
	})
}

func (s *APIServer) getBlock(c *gin.Context) {
	blockHash := c.Param("hash")

	block := BlockInfo{
		Hash:       blockHash,
		Height:     100,
		Difficulty: 1000.0,
		Timestamp:  time.Now(),
		Reward:     5000000000,
		Confirmed:  true,
	}

	c.JSON(http.StatusOK, APIResponse{
		Success: true,
		Data:    block,
	})
}

func (s *APIServer) getMiners(c *gin.Context) {
	miners := []map[string]interface{}{
		{
			"address":    "1MinerAddress1",
			"hash_rate":  500000,
			"shares":     100,
			"last_seen":  time.Now(),
		},
		{
			"address":    "1MinerAddress2", 
			"hash_rate":  300000,
			"shares":     60,
			"last_seen":  time.Now(),
		},
	}

	c.JSON(http.StatusOK, APIResponse{
		Success: true,
		Data:    miners,
	})
}

func (s *APIServer) getMiner(c *gin.Context) {
	address := c.Param("address")

	miner := map[string]interface{}{
		"address":     address,
		"hash_rate":   500000,
		"shares":      100,
		"last_seen":   time.Now(),
		"total_paid":  1000000,
		"pending":     50000,
	}

	c.JSON(http.StatusOK, APIResponse{
		Success: true,
		Data:    miner,
	})
}

func (s *APIServer) getMinerShares(c *gin.Context) {
	address := c.Param("address")

	shares := []ShareInfo{
		{
			ID:           "share123",
			MinerAddress: address,
			Difficulty:   1000.0,
			Timestamp:    time.Now(),
			Valid:        true,
		},
	}

	c.JSON(http.StatusOK, APIResponse{
		Success: true,
		Data:    shares,
	})
}

func (s *APIServer) getPayouts(c *gin.Context) {
	payouts := []map[string]interface{}{
		{
			"address":   "1MinerAddress1",
			"amount":    1000000,
			"timestamp": time.Now(),
			"tx_hash":   "txhash123",
		},
	}

	c.JSON(http.StatusOK, APIResponse{
		Success: true,
		Data:    payouts,
	})
}

func (s *APIServer) getMinerPayouts(c *gin.Context) {
	address := c.Param("address")

	payouts := []map[string]interface{}{
		{
			"address":   address,
			"amount":    1000000,
			"timestamp": time.Now(),
			"tx_hash":   "txhash123",
		},
	}

	c.JSON(http.StatusOK, APIResponse{
		Success: true,
		Data:    payouts,
	})
}

func (s *APIServer) healthCheck(c *gin.Context) {
	c.JSON(http.StatusOK, APIResponse{
		Success: true,
		Message: "P2Pool Bridge API is healthy",
		Data: map[string]interface{}{
			"timestamp": time.Now(),
			"uptime":    time.Since(time.Now()).Seconds(),
		},
	})
}

func (s *APIServer) getVersion(c *gin.Context) {
	c.JSON(http.StatusOK, APIResponse{
		Success: true,
		Data: map[string]interface{}{
			"version":    "0.1.0",
			"build_time": "2025-01-06T00:00:00Z",
			"git_commit": "dev",
		},
	})
}

// WebSocket implementation

func (s *APIServer) setupWebSocket() {
	// This would be called from main event loop to send updates
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-ticker.C:
				// Send periodic updates
				stats := PoolStats{
					HashRate:       1000000 + uint64(time.Now().Unix()%100000),
					Difficulty:     1000.0,
					ConnectedPeers: 5,
					Uptime:         time.Now().Unix(),
				}

				data, _ := json.Marshal(map[string]interface{}{
					"type": "stats_update",
					"data": stats,
				})

				select {
				case s.broadcast <- data:
				default:
				}
			}
		}
	}()
}

func (s *APIServer) handleWebSocket(c *gin.Context) {
	conn, err := s.upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.WithError(err).Error("WebSocket upgrade failed")
		return
	}
	defer conn.Close()

	s.clients[conn] = true
	log.WithField("clients", len(s.clients)).Debug("WebSocket client connected")

	// Send initial data
	stats := PoolStats{
		HashRate:       1000000,
		Difficulty:     1000.0,
		ConnectedPeers: 5,
		Uptime:         3600,
		Version:        "0.1.0",
	}

	initialData, _ := json.Marshal(map[string]interface{}{
		"type": "initial_stats",
		"data": stats,
	})

	conn.WriteMessage(websocket.TextMessage, initialData)

	// Handle client messages
	for {
		messageType, p, err := conn.ReadMessage()
		if err != nil {
			break
		}

		// Echo back for now
		if err := conn.WriteMessage(messageType, p); err != nil {
			break
		}
	}

	delete(s.clients, conn)
	log.WithField("clients", len(s.clients)).Debug("WebSocket client disconnected")
}

func (s *APIServer) handleWebSocketMessages() {
	for {
		select {
		case message := <-s.broadcast:
			// Send to all connected clients
			for client := range s.clients {
				err := client.WriteMessage(websocket.TextMessage, message)
				if err != nil {
					log.WithError(err).Debug("WebSocket write failed")
					client.Close()
					delete(s.clients, client)
				}
			}
		}
	}
}
