package api

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"go.uber.org/zap"
)

// WebSocketHub manages WebSocket connections and broadcasting
type WebSocketHub struct {
	logger *zap.Logger
	
	// Clients
	clients    map[*WebSocketClient]bool
	clientsMu  sync.RWMutex
	
	// Channels
	broadcast  chan BroadcastMessage
	register   chan *WebSocketClient
	unregister chan *WebSocketClient
	
	// Statistics
	stats      *WebSocketStats
	
	// Control
	ctx        context.Context
	cancel     context.CancelFunc
	wg         sync.WaitGroup
	running    atomic.Bool
}

// WebSocketClient represents a WebSocket client connection
type WebSocketClient struct {
	hub      *WebSocketHub
	conn     *websocket.Conn
	send     chan []byte
	
	// Client info
	id       string
	userID   string
	role     string
	ip       string
	
	// Rate limiting
	limiter  *RateLimiter
	
	// Statistics
	messagesSent atomic.Uint64
	messagesRecv atomic.Uint64
	bytesSent    atomic.Uint64
	bytesRecv    atomic.Uint64
	connectedAt  time.Time
	lastActivity atomic.Value // time.Time
	
	// Control
	ctx      context.Context
	cancel   context.CancelFunc
	once     sync.Once
}

// BroadcastMessage represents a message to broadcast
type BroadcastMessage struct {
	Type      string                 `json:"type"`
	Data      interface{}            `json:"data"`
	Target    string                 `json:"target,omitempty"`    // specific client ID
	Exclude   []string               `json:"exclude,omitempty"`   // client IDs to exclude
	Roles     []string               `json:"roles,omitempty"`     // target roles
	Timestamp time.Time              `json:"timestamp"`
}

// WebSocketMessage represents a client message
type WebSocketMessage struct {
	Type      string          `json:"type"`
	Action    string          `json:"action,omitempty"`
	Data      json.RawMessage `json:"data,omitempty"`
	ID        string          `json:"id,omitempty"`
	Timestamp time.Time       `json:"timestamp"`
}

// WebSocketStats tracks WebSocket statistics
type WebSocketStats struct {
	ConnectionsTotal    atomic.Uint64
	ConnectionsActive   atomic.Int32
	MessagesTotal       atomic.Uint64
	BytesTotal          atomic.Uint64
	ErrorsTotal         atomic.Uint64
	ReconnectsTotal     atomic.Uint64
}

// RateLimiter implements rate limiting for WebSocket clients
type RateLimiter struct {
	messagesPerMinute int
	messages          []time.Time
	mu                sync.Mutex
}

// Upgrader configuration for WebSocket
var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin: func(r *http.Request) bool {
		// Configure CORS as needed
		return true
	},
	EnableCompression: true,
}

// Message types
const (
	// System messages
	MessageTypeConnect    = "connect"
	MessageTypeDisconnect = "disconnect"
	MessageTypePing       = "ping"
	MessageTypePong       = "pong"
	MessageTypeError      = "error"
	
	// Mining messages
	MessageTypeStats      = "stats"
	MessageTypeHashrate   = "hashrate"
	MessageTypeShare      = "share"
	MessageTypeBlock      = "block"
	MessageTypeJob        = "job"
	
	// Control messages
	MessageTypeCommand    = "command"
	MessageTypeConfig     = "config"
	MessageTypeAlert      = "alert"
	
	// Data messages
	MessageTypeUpdate     = "update"
	MessageTypeNotification = "notification"
)

// WebSocket configuration
const (
	// Time allowed to write a message to the peer
	writeWait = 10 * time.Second
	
	// Time allowed to read the next pong message from the peer
	pongWait = 60 * time.Second
	
	// Send pings to peer with this period
	pingPeriod = (pongWait * 9) / 10
	
	// Maximum message size allowed from peer
	maxMessageSize = 1024 * 1024 // 1MB
	
	// Rate limit
	defaultRateLimit = 60 // messages per minute
)

// NewWebSocketHub creates a new WebSocket hub
func NewWebSocketHub(logger *zap.Logger) *WebSocketHub {
	ctx, cancel := context.WithCancel(context.Background())
	
	hub := &WebSocketHub{
		logger:     logger,
		clients:    make(map[*WebSocketClient]bool),
		broadcast:  make(chan BroadcastMessage, 256),
		register:   make(chan *WebSocketClient),
		unregister: make(chan *WebSocketClient),
		stats:      &WebSocketStats{},
		ctx:        ctx,
		cancel:     cancel,
	}
	
	return hub
}

// Start starts the WebSocket hub
func (h *WebSocketHub) Start() error {
	if !h.running.CompareAndSwap(false, true) {
		return nil
	}
	
	h.logger.Info("Starting WebSocket hub")
	
	h.wg.Add(1)
	go h.run()
	
	h.wg.Add(1)
	go h.statsReporter()
	
	return nil
}

// Stop stops the WebSocket hub
func (h *WebSocketHub) Stop() error {
	if !h.running.CompareAndSwap(true, false) {
		return nil
	}
	
	h.logger.Info("Stopping WebSocket hub")
	
	// Close all client connections
	h.clientsMu.Lock()
	for client := range h.clients {
		client.Close()
	}
	h.clientsMu.Unlock()
	
	h.cancel()
	h.wg.Wait()
	
	return nil
}

// HandleWebSocket handles WebSocket upgrade requests
func (h *WebSocketHub) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	// Upgrade connection
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.logger.Error("WebSocket upgrade failed", zap.Error(err))
		return
	}
	
	// Create client
	clientID := generateClientID()
	ctx, cancel := context.WithCancel(h.ctx)
	
	client := &WebSocketClient{
		hub:          h,
		conn:         conn,
		send:         make(chan []byte, 256),
		id:           clientID,
		ip:           r.RemoteAddr,
		limiter:      NewRateLimiter(defaultRateLimit),
		connectedAt:  time.Now(),
		ctx:          ctx,
		cancel:       cancel,
	}
	
	// Extract user info from request context
	if user := r.Context().Value("user"); user != nil {
		if userInfo, ok := user.(map[string]string); ok {
			client.userID = userInfo["id"]
			client.role = userInfo["role"]
		}
	}
	
	// Register client
	h.register <- client
	
	// Update statistics
	h.stats.ConnectionsTotal.Add(1)
	h.stats.ConnectionsActive.Add(1)
	
	// Start client handlers
	go client.writePump()
	go client.readPump()
	
	// Send welcome message
	h.sendWelcome(client)
	
	h.logger.Info("WebSocket client connected",
		zap.String("client_id", clientID),
		zap.String("ip", r.RemoteAddr))
}

// Broadcast sends a message to all connected clients
func (h *WebSocketHub) Broadcast(msg BroadcastMessage) {
	select {
	case h.broadcast <- msg:
	default:
		h.logger.Warn("Broadcast channel full")
	}
}

// SendToClient sends a message to a specific client
func (h *WebSocketHub) SendToClient(clientID string, data interface{}) error {
	h.clientsMu.RLock()
	defer h.clientsMu.RUnlock()
	
	for client := range h.clients {
		if client.id == clientID {
			return client.SendJSON(data)
		}
	}
	
	return errors.New("client not found")
}

// GetClients returns all connected clients
func (h *WebSocketHub) GetClients() []*WebSocketClient {
	h.clientsMu.RLock()
	defer h.clientsMu.RUnlock()
	
	clients := make([]*WebSocketClient, 0, len(h.clients))
	for client := range h.clients {
		clients = append(clients, client)
	}
	
	return clients
}

// GetStats returns WebSocket statistics
func (h *WebSocketHub) GetStats() map[string]interface{} {
	return map[string]interface{}{
		"connections_total":  h.stats.ConnectionsTotal.Load(),
		"connections_active": h.stats.ConnectionsActive.Load(),
		"messages_total":     h.stats.MessagesTotal.Load(),
		"bytes_total":        h.stats.BytesTotal.Load(),
		"errors_total":       h.stats.ErrorsTotal.Load(),
		"reconnects_total":   h.stats.ReconnectsTotal.Load(),
	}
}

// Private methods

func (h *WebSocketHub) run() {
	defer h.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-h.ctx.Done():
			return
			
		case client := <-h.register:
			h.clientsMu.Lock()
			h.clients[client] = true
			h.clientsMu.Unlock()
			
		case client := <-h.unregister:
			h.clientsMu.Lock()
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				close(client.send)
				h.stats.ConnectionsActive.Add(-1)
			}
			h.clientsMu.Unlock()
			
		case message := <-h.broadcast:
			h.handleBroadcast(message)
			
		case <-ticker.C:
			h.cleanup()
		}
	}
}

func (h *WebSocketHub) handleBroadcast(msg BroadcastMessage) {
	data, err := json.Marshal(msg)
	if err != nil {
		h.logger.Error("Failed to marshal broadcast message", zap.Error(err))
		return
	}
	
	h.clientsMu.RLock()
	defer h.clientsMu.RUnlock()
	
	for client := range h.clients {
		// Check target
		if msg.Target != "" && client.id != msg.Target {
			continue
		}
		
		// Check exclusions
		excluded := false
		for _, id := range msg.Exclude {
			if client.id == id {
				excluded = true
				break
			}
		}
		if excluded {
			continue
		}
		
		// Check roles
		if len(msg.Roles) > 0 {
			hasRole := false
			for _, role := range msg.Roles {
				if client.role == role {
					hasRole = true
					break
				}
			}
			if !hasRole {
				continue
			}
		}
		
		// Send message
		select {
		case client.send <- data:
		default:
			// Client send channel full, close it
			go client.Close()
		}
	}
	
	h.stats.MessagesTotal.Add(1)
}

func (h *WebSocketHub) cleanup() {
	h.clientsMu.RLock()
	defer h.clientsMu.RUnlock()
	
	timeout := time.Now().Add(-5 * time.Minute)
	
	for client := range h.clients {
		if lastActivity := client.lastActivity.Load(); lastActivity != nil {
			if lastTime := lastActivity.(time.Time); lastTime.Before(timeout) {
				go client.Close()
			}
		}
	}
}

func (h *WebSocketHub) statsReporter() {
	defer h.wg.Done()
	
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-h.ctx.Done():
			return
		case <-ticker.C:
			h.reportStats()
		}
	}
}

func (h *WebSocketHub) reportStats() {
	stats := map[string]interface{}{
		"type": MessageTypeStats,
		"data": h.GetStats(),
	}
	
	h.Broadcast(BroadcastMessage{
		Type:      MessageTypeStats,
		Data:      stats,
		Timestamp: time.Now(),
	})
}

func (h *WebSocketHub) sendWelcome(client *WebSocketClient) {
	welcome := map[string]interface{}{
		"type":      MessageTypeConnect,
		"client_id": client.id,
		"timestamp": time.Now(),
		"message":   "Welcome to Otedama WebSocket",
	}
	
	client.SendJSON(welcome)
}

// WebSocketClient methods

func (c *WebSocketClient) readPump() {
	defer func() {
		c.hub.unregister <- c
		c.Close()
	}()
	
	c.conn.SetReadLimit(maxMessageSize)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		c.lastActivity.Store(time.Now())
		return nil
	})
	
	for {
		select {
		case <-c.ctx.Done():
			return
		default:
		}
		
		var msg WebSocketMessage
		err := c.conn.ReadJSON(&msg)
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				c.hub.logger.Error("WebSocket read error",
					zap.String("client_id", c.id),
					zap.Error(err))
				c.hub.stats.ErrorsTotal.Add(1)
			}
			return
		}
		
		c.messagesRecv.Add(1)
		c.lastActivity.Store(time.Now())
		
		// Rate limiting
		if !c.limiter.Allow() {
			c.sendError("Rate limit exceeded")
			continue
		}
		
		// Handle message
		c.handleMessage(&msg)
	}
}

func (c *WebSocketClient) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.Close()
	}()
	
	for {
		select {
		case <-c.ctx.Done():
			return
			
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			
			c.conn.WriteMessage(websocket.TextMessage, message)
			c.messagesSent.Add(1)
			c.bytesSent.Add(uint64(len(message)))
			
			// Add queued messages to the current websocket message
			n := len(c.send)
			for i := 0; i < n; i++ {
				c.conn.WriteMessage(websocket.TextMessage, <-c.send)
			}
			
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *WebSocketClient) handleMessage(msg *WebSocketMessage) {
	c.hub.logger.Debug("Received WebSocket message",
		zap.String("client_id", c.id),
		zap.String("type", msg.Type))
	
	switch msg.Type {
	case MessageTypePing:
		c.handlePing()
		
	case MessageTypeCommand:
		c.handleCommand(msg)
		
	case MessageTypeConfig:
		c.handleConfig(msg)
		
	default:
		// Forward to application handlers
		c.hub.logger.Debug("Unknown message type",
			zap.String("type", msg.Type))
	}
}

func (c *WebSocketClient) handlePing() {
	pong := map[string]interface{}{
		"type":      MessageTypePong,
		"timestamp": time.Now(),
	}
	
	c.SendJSON(pong)
}

func (c *WebSocketClient) handleCommand(msg *WebSocketMessage) {
	// Handle commands based on action
	switch msg.Action {
	case "start":
		// Start mining command
		c.hub.logger.Info("Start command received",
			zap.String("client_id", c.id))
			
	case "stop":
		// Stop mining command
		c.hub.logger.Info("Stop command received",
			zap.String("client_id", c.id))
			
	case "restart":
		// Restart mining command
		c.hub.logger.Info("Restart command received",
			zap.String("client_id", c.id))
			
	default:
		c.sendError("Unknown command: " + msg.Action)
	}
}

func (c *WebSocketClient) handleConfig(msg *WebSocketMessage) {
	// Handle configuration updates
	var config map[string]interface{}
	if err := json.Unmarshal(msg.Data, &config); err != nil {
		c.sendError("Invalid config data")
		return
	}
	
	c.hub.logger.Info("Config update received",
		zap.String("client_id", c.id),
		zap.Any("config", config))
}

func (c *WebSocketClient) SendJSON(v interface{}) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	
	select {
	case c.send <- data:
		return nil
	case <-time.After(5 * time.Second):
		return errors.New("send timeout")
	}
}

func (c *WebSocketClient) sendError(message string) {
	errorMsg := map[string]interface{}{
		"type":    MessageTypeError,
		"message": message,
		"timestamp": time.Now(),
	}
	
	c.SendJSON(errorMsg)
}

func (c *WebSocketClient) Close() {
	c.once.Do(func() {
		c.cancel()
		c.conn.Close()
		
		c.hub.logger.Debug("WebSocket client disconnected",
			zap.String("client_id", c.id),
			zap.Duration("duration", time.Since(c.connectedAt)))
	})
}

// RateLimiter methods

func NewRateLimiter(messagesPerMinute int) *RateLimiter {
	return &RateLimiter{
		messagesPerMinute: messagesPerMinute,
		messages:          make([]time.Time, 0, messagesPerMinute),
	}
}

func (r *RateLimiter) Allow() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	
	now := time.Now()
	cutoff := now.Add(-time.Minute)
	
	// Remove old messages
	validMessages := make([]time.Time, 0, len(r.messages))
	for _, t := range r.messages {
		if t.After(cutoff) {
			validMessages = append(validMessages, t)
		}
	}
	r.messages = validMessages
	
	// Check rate limit
	if len(r.messages) >= r.messagesPerMinute {
		return false
	}
	
	// Add new message
	r.messages = append(r.messages, now)
	return true
}

// Helper functions

func generateClientID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// RealtimeBroadcaster sends real-time updates
type RealtimeBroadcaster struct {
	hub      *WebSocketHub
	logger   *zap.Logger
	interval time.Duration
	ctx      context.Context
	cancel   context.CancelFunc
	wg       sync.WaitGroup
}

// NewRealtimeBroadcaster creates a new realtime broadcaster
func NewRealtimeBroadcaster(hub *WebSocketHub, logger *zap.Logger, interval time.Duration) *RealtimeBroadcaster {
	ctx, cancel := context.WithCancel(context.Background())
	
	return &RealtimeBroadcaster{
		hub:      hub,
		logger:   logger,
		interval: interval,
		ctx:      ctx,
		cancel:   cancel,
	}
}

// Start starts the broadcaster
func (rb *RealtimeBroadcaster) Start(getStats func() map[string]interface{}) {
	rb.wg.Add(1)
	go rb.broadcastLoop(getStats)
}

// Stop stops the broadcaster
func (rb *RealtimeBroadcaster) Stop() {
	rb.cancel()
	rb.wg.Wait()
}

func (rb *RealtimeBroadcaster) broadcastLoop(getStats func() map[string]interface{}) {
	defer rb.wg.Done()
	
	ticker := time.NewTicker(rb.interval)
	defer ticker.Stop()
	
	for {
		select {
		case <-rb.ctx.Done():
			return
		case <-ticker.C:
			stats := getStats()
			rb.hub.Broadcast(BroadcastMessage{
				Type:      MessageTypeUpdate,
				Data:      stats,
				Timestamp: time.Now(),
			})
		}
	}
}
