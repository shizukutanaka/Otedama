package websocket

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// Server manages WebSocket connections
type Server struct {
	ctx    context.Context
	cancel context.CancelFunc
	
	// Connection management
	clients    map[*Client]bool
	clientsMu  sync.RWMutex
	register   chan *Client
	unregister chan *Client
	
	// Message handling
	broadcast  chan Message
	handlers   map[string]MessageHandler
	handlersMu sync.RWMutex
	
	// Configuration
	config *Config
	
	// Statistics
	totalConnections   atomic.Uint64
	activeConnections  atomic.Int32
	messagesSent       atomic.Uint64
	messagesReceived   atomic.Uint64
	bytesTransferred   atomic.Uint64
}

// Config holds WebSocket server configuration
type Config struct {
	ReadBufferSize    int
	WriteBufferSize   int
	MaxMessageSize    int64
	WriteTimeout      time.Duration
	PongTimeout       time.Duration
	PingInterval      time.Duration
	MaxConnections    int
	EnableCompression bool
}

// Client represents a WebSocket client
type Client struct {
	server   *Server
	conn     *websocket.Conn
	send     chan []byte
	id       string
	userData interface{}
	
	// Rate limiting
	lastMessage time.Time
	messageRate *RateLimiter
	
	// Statistics
	connectedAt    time.Time
	messagesSent   uint64
	messagesRecv   uint64
	bytesTransferred uint64
}

// Message represents a WebSocket message
type Message struct {
	Type      string          `json:"type"`
	Data      json.RawMessage `json:"data"`
	Timestamp int64          `json:"timestamp"`
	ID        string          `json:"id,omitempty"`
}

// MessageHandler handles specific message types
type MessageHandler func(client *Client, data json.RawMessage) error

// RateLimiter implements simple rate limiting
type RateLimiter struct {
	tokens    int
	maxTokens int
	refillRate time.Duration
	lastRefill time.Time
	mu        sync.Mutex
}

// DefaultConfig returns default WebSocket configuration
func DefaultConfig() *Config {
	return &Config{
		ReadBufferSize:    4096,
		WriteBufferSize:   4096,
		MaxMessageSize:    1024 * 1024, // 1MB
		WriteTimeout:      10 * time.Second,
		PongTimeout:       60 * time.Second,
		PingInterval:      30 * time.Second,
		MaxConnections:    1000,
		EnableCompression: true,
	}
}

// NewServer creates a new WebSocket server
func NewServer(ctx context.Context, config *Config) *Server {
	if config == nil {
		config = DefaultConfig()
	}
	
	ctx, cancel := context.WithCancel(ctx)
	
	server := &Server{
		ctx:        ctx,
		cancel:     cancel,
		clients:    make(map[*Client]bool),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		broadcast:  make(chan Message, 256),
		handlers:   make(map[string]MessageHandler),
		config:     config,
	}
	
	// Start server routines
	go server.run()
	
	return server
}

// upgrader configures WebSocket upgrade
func (s *Server) upgrader() *websocket.Upgrader {
	return &websocket.Upgrader{
		ReadBufferSize:    s.config.ReadBufferSize,
		WriteBufferSize:   s.config.WriteBufferSize,
		EnableCompression: s.config.EnableCompression,
		CheckOrigin: func(r *http.Request) bool {
			// In production, implement proper origin checking
			return true
		},
	}
}

// ServeHTTP handles WebSocket upgrade requests
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Check connection limit
	if s.activeConnections.Load() >= int32(s.config.MaxConnections) {
		http.Error(w, "Too many connections", http.StatusServiceUnavailable)
		return
	}
	
	// Upgrade connection
	conn, err := s.upgrader().Upgrade(w, r, nil)
	if err != nil {
		return
	}
	
	// Create client
	client := &Client{
		server:      s,
		conn:        conn,
		send:        make(chan []byte, 256),
		id:          generateClientID(),
		connectedAt: time.Now(),
		messageRate: NewRateLimiter(100, time.Second), // 100 messages per second
	}
	
	// Configure connection
	conn.SetReadLimit(s.config.MaxMessageSize)
	conn.SetReadDeadline(time.Now().Add(s.config.PongTimeout))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(s.config.PongTimeout))
		return nil
	})
	
	// Register client
	s.register <- client
	
	// Update statistics
	s.totalConnections.Add(1)
	s.activeConnections.Add(1)
	
	// Start client routines
	go client.writePump()
	go client.readPump()
}

// run manages client connections
func (s *Server) run() {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case client := <-s.register:
			s.clientsMu.Lock()
			s.clients[client] = true
			s.clientsMu.Unlock()
			
			// Send welcome message
			s.sendToClient(client, Message{
				Type:      "welcome",
				Timestamp: time.Now().Unix(),
				Data:      json.RawMessage(`{"message":"Connected to Otedama WebSocket"}`),
			})
			
		case client := <-s.unregister:
			s.clientsMu.Lock()
			if _, ok := s.clients[client]; ok {
				delete(s.clients, client)
				close(client.send)
				s.clientsMu.Unlock()
				s.activeConnections.Add(-1)
			} else {
				s.clientsMu.Unlock()
			}
			
		case message := <-s.broadcast:
			s.broadcastMessage(message)
			
		case <-ticker.C:
			// Periodic cleanup
			s.cleanup()
			
		case <-s.ctx.Done():
			// Shutdown
			s.shutdown()
			return
		}
	}
}

// readPump reads messages from client
func (c *Client) readPump() {
	defer func() {
		c.server.unregister <- c
		c.conn.Close()
	}()
	
	for {
		var msg Message
		err := c.conn.ReadJSON(&msg)
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				fmt.Printf("WebSocket error: %v\n", err)
			}
			break
		}
		
		// Rate limiting
		if !c.messageRate.Allow() {
			c.sendError("Rate limit exceeded")
			continue
		}
		
		// Update statistics
		c.messagesRecv++
		c.server.messagesReceived.Add(1)
		
		// Handle message
		if err := c.server.handleMessage(c, msg); err != nil {
			c.sendError(err.Error())
		}
	}
}

// writePump writes messages to client
func (c *Client) writePump() {
	ticker := time.NewTicker(c.server.config.PingInterval)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()
	
	for {
		select {
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(c.server.config.WriteTimeout))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			
			if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}
			
			// Update statistics
			c.messagesSent++
			c.bytesTransferred += uint64(len(message))
			c.server.messagesSent.Add(1)
			c.server.bytesTransferred.Add(uint64(len(message)))
			
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(c.server.config.WriteTimeout))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// handleMessage handles incoming messages
func (s *Server) handleMessage(client *Client, msg Message) error {
	s.handlersMu.RLock()
	handler, exists := s.handlers[msg.Type]
	s.handlersMu.RUnlock()
	
	if !exists {
		return fmt.Errorf("unknown message type: %s", msg.Type)
	}
	
	return handler(client, msg.Data)
}

// RegisterHandler registers a message handler
func (s *Server) RegisterHandler(msgType string, handler MessageHandler) {
	s.handlersMu.Lock()
	defer s.handlersMu.Unlock()
	s.handlers[msgType] = handler
}

// Broadcast sends a message to all clients
func (s *Server) Broadcast(msg Message) {
	select {
	case s.broadcast <- msg:
	default:
		// Broadcast queue full
	}
}

// broadcastMessage sends message to all clients
func (s *Server) broadcastMessage(msg Message) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	
	s.clientsMu.RLock()
	defer s.clientsMu.RUnlock()
	
	for client := range s.clients {
		select {
		case client.send <- data:
		default:
			// Client send buffer full, skip
		}
	}
}

// SendToClient sends a message to specific client
func (s *Server) SendToClient(clientID string, msg Message) error {
	s.clientsMu.RLock()
	defer s.clientsMu.RUnlock()
	
	for client := range s.clients {
		if client.id == clientID {
			return s.sendToClient(client, msg)
		}
	}
	
	return errors.New("client not found")
}

// sendToClient sends message to client
func (s *Server) sendToClient(client *Client, msg Message) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	
	select {
	case client.send <- data:
		return nil
	default:
		return errors.New("client send buffer full")
	}
}

// sendError sends error message to client
func (c *Client) sendError(errMsg string) {
	msg := Message{
		Type:      "error",
		Data:      json.RawMessage(fmt.Sprintf(`{"error":"%s"}`, errMsg)),
		Timestamp: time.Now().Unix(),
	}
	
	data, _ := json.Marshal(msg)
	select {
	case c.send <- data:
	default:
	}
}

// cleanup performs periodic cleanup
func (s *Server) cleanup() {
	s.clientsMu.RLock()
	defer s.clientsMu.RUnlock()
	
	now := time.Now()
	for client := range s.clients {
		// Check for idle clients
		if now.Sub(client.connectedAt) > 24*time.Hour {
			// Disconnect long-lived idle connections
			client.conn.Close()
		}
	}
}

// shutdown closes all connections
func (s *Server) shutdown() {
	s.clientsMu.Lock()
	defer s.clientsMu.Unlock()
	
	// Close all client connections
	for client := range s.clients {
		client.conn.Close()
		close(client.send)
	}
	
	s.clients = make(map[*Client]bool)
}

// GetStatistics returns server statistics
func (s *Server) GetStatistics() map[string]interface{} {
	stats := make(map[string]interface{})
	stats["total_connections"] = s.totalConnections.Load()
	stats["active_connections"] = s.activeConnections.Load()
	stats["messages_sent"] = s.messagesSent.Load()
	stats["messages_received"] = s.messagesReceived.Load()
	stats["bytes_transferred"] = s.bytesTransferred.Load()
	return stats
}

// generateClientID generates a unique client ID
func generateClientID() string {
	return fmt.Sprintf("client_%d", time.Now().UnixNano())
}

// NewRateLimiter creates a new rate limiter
func NewRateLimiter(maxTokens int, refillRate time.Duration) *RateLimiter {
	return &RateLimiter{
		tokens:     maxTokens,
		maxTokens:  maxTokens,
		refillRate: refillRate,
		lastRefill: time.Now(),
	}
}

// Allow checks if request is allowed
func (rl *RateLimiter) Allow() bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	
	// Refill tokens
	now := time.Now()
	elapsed := now.Sub(rl.lastRefill)
	tokensToAdd := int(elapsed / rl.refillRate)
	
	if tokensToAdd > 0 {
		rl.tokens = min(rl.tokens+tokensToAdd, rl.maxTokens)
		rl.lastRefill = now
	}
	
	// Check if tokens available
	if rl.tokens > 0 {
		rl.tokens--
		return true
	}
	
	return false
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// Hub manages WebSocket connections and broadcasts
type Hub struct {
	server *Server
	
	// Channels for different event types
	hashRateUpdates chan HashRateUpdate
	shareUpdates    chan ShareUpdate
	blockUpdates    chan BlockUpdate
	statusUpdates   chan StatusUpdate
}

// Event types for real-time updates
type (
	HashRateUpdate struct {
		Worker    string  `json:"worker"`
		Algorithm string  `json:"algorithm"`
		HashRate  float64 `json:"hashrate"`
	}
	
	ShareUpdate struct {
		Worker   string `json:"worker"`
		Pool     string `json:"pool"`
		Accepted bool   `json:"accepted"`
		Reason   string `json:"reason,omitempty"`
	}
	
	BlockUpdate struct {
		Height     uint64 `json:"height"`
		Hash       string `json:"hash"`
		Reward     string `json:"reward"`
		FoundBy    string `json:"found_by"`
		FoundAt    int64  `json:"found_at"`
	}
	
	StatusUpdate struct {
		Status  string                 `json:"status"`
		Details map[string]interface{} `json:"details"`
	}
)

// NewHub creates a new WebSocket hub
func NewHub(server *Server) *Hub {
	hub := &Hub{
		server:          server,
		hashRateUpdates: make(chan HashRateUpdate, 100),
		shareUpdates:    make(chan ShareUpdate, 100),
		blockUpdates:    make(chan BlockUpdate, 10),
		statusUpdates:   make(chan StatusUpdate, 50),
	}
	
	// Start event processors
	go hub.processHashRateUpdates()
	go hub.processShareUpdates()
	go hub.processBlockUpdates()
	go hub.processStatusUpdates()
	
	return hub
}

// processHashRateUpdates processes hashrate updates
func (h *Hub) processHashRateUpdates() {
	for update := range h.hashRateUpdates {
		data, _ := json.Marshal(update)
		h.server.Broadcast(Message{
			Type:      "hashrate",
			Data:      data,
			Timestamp: time.Now().Unix(),
		})
	}
}

// processShareUpdates processes share updates
func (h *Hub) processShareUpdates() {
	for update := range h.shareUpdates {
		data, _ := json.Marshal(update)
		h.server.Broadcast(Message{
			Type:      "share",
			Data:      data,
			Timestamp: time.Now().Unix(),
		})
	}
}

// processBlockUpdates processes block updates
func (h *Hub) processBlockUpdates() {
	for update := range h.blockUpdates {
		data, _ := json.Marshal(update)
		h.server.Broadcast(Message{
			Type:      "block",
			Data:      data,
			Timestamp: time.Now().Unix(),
		})
	}
}

// processStatusUpdates processes status updates
func (h *Hub) processStatusUpdates() {
	for update := range h.statusUpdates {
		data, _ := json.Marshal(update)
		h.server.Broadcast(Message{
			Type:      "status",
			Data:      data,
			Timestamp: time.Now().Unix(),
		})
	}
}

// SendHashRateUpdate sends hashrate update
func (h *Hub) SendHashRateUpdate(worker, algorithm string, hashRate float64) {
	select {
	case h.hashRateUpdates <- HashRateUpdate{
		Worker:    worker,
		Algorithm: algorithm,
		HashRate:  hashRate,
	}:
	default:
	}
}

// SendShareUpdate sends share update
func (h *Hub) SendShareUpdate(worker, pool string, accepted bool, reason string) {
	select {
	case h.shareUpdates <- ShareUpdate{
		Worker:   worker,
		Pool:     pool,
		Accepted: accepted,
		Reason:   reason,
	}:
	default:
	}
}

// SendBlockUpdate sends block update
func (h *Hub) SendBlockUpdate(height uint64, hash, reward, foundBy string) {
	select {
	case h.blockUpdates <- BlockUpdate{
		Height:  height,
		Hash:    hash,
		Reward:  reward,
		FoundBy: foundBy,
		FoundAt: time.Now().Unix(),
	}:
	default:
	}
}

// SendStatusUpdate sends status update
func (h *Hub) SendStatusUpdate(status string, details map[string]interface{}) {
	select {
	case h.statusUpdates <- StatusUpdate{
		Status:  status,
		Details: details,
	}:
	default:
	}
}