package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"go.uber.org/zap"
)

// WebSocketManager manages WebSocket connections for real-time updates
type WebSocketManager struct {
	logger    *zap.Logger
	
	// Connection management
	connections  sync.Map // ConnectionID -> *WebSocketConnection
	subscribers  sync.Map // Topic -> map[ConnectionID]*WebSocketConnection
	
	// Message broadcasting
	broadcast    chan BroadcastMessage
	
	// Statistics
	totalConnections    atomic.Uint64
	activeConnections   atomic.Uint64
	messagesSent        atomic.Uint64
	messagesReceived    atomic.Uint64
	
	// Configuration
	config       WebSocketConfig
	
	// Upgrader for HTTP to WebSocket
	upgrader     websocket.Upgrader
	
	// Lifecycle
	running      atomic.Bool
	ctx          context.Context
	cancel       context.CancelFunc
	wg           sync.WaitGroup
}

// WebSocketConfig contains WebSocket configuration
type WebSocketConfig struct {
	ReadBufferSize    int
	WriteBufferSize   int
	HandshakeTimeout  time.Duration
	ReadTimeout       time.Duration
	WriteTimeout      time.Duration
	PingInterval      time.Duration
	PongTimeout       time.Duration
	MaxMessageSize    int64
	AllowedOrigins    []string
	CompressionLevel  int
}

// WebSocketConnection represents a WebSocket connection
type WebSocketConnection struct {
	ID           string
	UserID       string
	IPAddress    string
	UserAgent    string
	ConnectedAt  time.Time
	LastActivity time.Time
	
	// WebSocket connection
	conn         *websocket.Conn
	connMu       sync.Mutex
	
	// Message channels
	send         chan []byte
	
	// Subscriptions
	subscriptions map[string]bool
	subsMu        sync.RWMutex
	
	// State
	authenticated bool
	permissions   []string
	
	// Statistics
	messagesSent     atomic.Uint64
	messagesReceived atomic.Uint64
	
	// Context for this connection
	ctx          context.Context
	cancel       context.CancelFunc
}

// BroadcastMessage represents a message to broadcast
type BroadcastMessage struct {
	Topic   string
	Message interface{}
	Filter  func(*WebSocketConnection) bool
}

// IncomingMessage represents an incoming WebSocket message
type IncomingMessage struct {
	Type    string      `json:"type"`
	Topic   string      `json:"topic,omitempty"`
	Data    interface{} `json:"data,omitempty"`
	ID      string      `json:"id,omitempty"`
}

// OutgoingMessage represents an outgoing WebSocket message
type OutgoingMessage struct {
	Type      string      `json:"type"`
	Topic     string      `json:"topic,omitempty"`
	Data      interface{} `json:"data,omitempty"`
	Timestamp time.Time   `json:"timestamp"`
	ID        string      `json:"id,omitempty"`
}

// MessageHandler handles incoming WebSocket messages
type MessageHandler func(*WebSocketConnection, IncomingMessage) error

// NewWebSocketManager creates a new WebSocket manager
func NewWebSocketManager(logger *zap.Logger, config WebSocketConfig) *WebSocketManager {
	ctx, cancel := context.WithCancel(context.Background())
	
	return &WebSocketManager{
		logger:    logger,
		config:    config,
		broadcast: make(chan BroadcastMessage, 1000),
		upgrader: websocket.Upgrader{
			ReadBufferSize:   config.ReadBufferSize,
			WriteBufferSize:  config.WriteBufferSize,
			HandshakeTimeout: config.HandshakeTimeout,
			CheckOrigin:      checkOrigin(config.AllowedOrigins),
		},
		ctx:    ctx,
		cancel: cancel,
	}
}

// Start starts the WebSocket manager
func (wsm *WebSocketManager) Start() error {
	if wsm.running.Swap(true) {
		return nil // Already running
	}
	
	wsm.logger.Info("Starting WebSocket manager")
	
	// Start broadcast goroutine
	wsm.wg.Add(1)
	go wsm.broadcastLoop()
	
	// Start cleanup goroutine
	wsm.wg.Add(1)
	go wsm.cleanupLoop()
	
	return nil
}

// Stop stops the WebSocket manager
func (wsm *WebSocketManager) Stop() error {
	if !wsm.running.Swap(false) {
		return nil // Already stopped
	}
	
	wsm.logger.Info("Stopping WebSocket manager")
	
	// Close all connections
	wsm.connections.Range(func(key, value interface{}) bool {
		conn := value.(*WebSocketConnection)
		conn.Close()
		return true
	})
	
	wsm.cancel()
	wsm.wg.Wait()
	
	close(wsm.broadcast)
	
	return nil
}

// HandleConnection handles a new WebSocket connection
func (wsm *WebSocketManager) HandleConnection(w http.ResponseWriter, r *http.Request, userID string) error {
	// Upgrade HTTP connection to WebSocket
	conn, err := wsm.upgrader.Upgrade(w, r, nil)
	if err != nil {
		wsm.logger.Error("Failed to upgrade connection", zap.Error(err))
		return err
	}
	
	// Create WebSocket connection wrapper
	ctx, cancel := context.WithCancel(wsm.ctx)
	wsConn := &WebSocketConnection{
		ID:            generateConnectionID(),
		UserID:        userID,
		IPAddress:     getClientIP(r),
		UserAgent:     r.UserAgent(),
		ConnectedAt:   time.Now(),
		LastActivity:  time.Now(),
		conn:          conn,
		send:          make(chan []byte, 256),
		subscriptions: make(map[string]bool),
		authenticated: userID != "",
		ctx:           ctx,
		cancel:        cancel,
	}
	
	// Configure connection
	conn.SetReadLimit(wsm.config.MaxMessageSize)
	conn.SetReadDeadline(time.Now().Add(wsm.config.ReadTimeout))
	conn.SetPongHandler(wsConn.pongHandler)
	
	// Store connection
	wsm.connections.Store(wsConn.ID, wsConn)
	wsm.totalConnections.Add(1)
	wsm.activeConnections.Add(1)
	
	wsm.logger.Info("New WebSocket connection",
		zap.String("id", wsConn.ID),
		zap.String("user_id", userID),
		zap.String("ip", wsConn.IPAddress),
	)
	
	// Start connection handlers
	go wsConn.readPump(wsm)
	go wsConn.writePump(wsm)
	
	return nil
}

// Subscribe subscribes a connection to a topic
func (wsm *WebSocketManager) Subscribe(connectionID, topic string) error {
	value, exists := wsm.connections.Load(connectionID)
	if !exists {
		return fmt.Errorf("connection not found: %s", connectionID)
	}
	
	conn := value.(*WebSocketConnection)
	
	// Add to connection subscriptions
	conn.subsMu.Lock()
	conn.subscriptions[topic] = true
	conn.subsMu.Unlock()
	
	// Add to topic subscribers
	subscribers, _ := wsm.subscribers.LoadOrStore(topic, &sync.Map{})
	subscriberMap := subscribers.(*sync.Map)
	subscriberMap.Store(connectionID, conn)
	
	wsm.logger.Debug("Connection subscribed to topic",
		zap.String("connection_id", connectionID),
		zap.String("topic", topic),
	)
	
	return nil
}

// Unsubscribe unsubscribes a connection from a topic
func (wsm *WebSocketManager) Unsubscribe(connectionID, topic string) error {
	value, exists := wsm.connections.Load(connectionID)
	if !exists {
		return fmt.Errorf("connection not found: %s", connectionID)
	}
	
	conn := value.(*WebSocketConnection)
	
	// Remove from connection subscriptions
	conn.subsMu.Lock()
	delete(conn.subscriptions, topic)
	conn.subsMu.Unlock()
	
	// Remove from topic subscribers
	if subscribers, exists := wsm.subscribers.Load(topic); exists {
		subscriberMap := subscribers.(*sync.Map)
		subscriberMap.Delete(connectionID)
	}
	
	wsm.logger.Debug("Connection unsubscribed from topic",
		zap.String("connection_id", connectionID),
		zap.String("topic", topic),
	)
	
	return nil
}

// Broadcast broadcasts a message to all subscribers of a topic
func (wsm *WebSocketManager) Broadcast(topic string, message interface{}) {
	select {
	case wsm.broadcast <- BroadcastMessage{Topic: topic, Message: message}:
	default:
		wsm.logger.Warn("Broadcast channel full, dropping message",
			zap.String("topic", topic),
		)
	}
}

// BroadcastToUser sends a message to all connections of a specific user
func (wsm *WebSocketManager) BroadcastToUser(userID string, message interface{}) {
	wsm.BroadcastWithFilter("user_message", message, func(conn *WebSocketConnection) bool {
		return conn.UserID == userID
	})
}

// BroadcastWithFilter broadcasts with a custom filter function
func (wsm *WebSocketManager) BroadcastWithFilter(topic string, message interface{}, filter func(*WebSocketConnection) bool) {
	select {
	case wsm.broadcast <- BroadcastMessage{Topic: topic, Message: message, Filter: filter}:
	default:
		wsm.logger.Warn("Broadcast channel full, dropping filtered message",
			zap.String("topic", topic),
		)
	}
}

// broadcastLoop handles message broadcasting
func (wsm *WebSocketManager) broadcastLoop() {
	defer wsm.wg.Done()
	
	for {
		select {
		case <-wsm.ctx.Done():
			return
		case msg := <-wsm.broadcast:
			wsm.handleBroadcast(msg)
		}
	}
}

// handleBroadcast handles a single broadcast message
func (wsm *WebSocketManager) handleBroadcast(msg BroadcastMessage) {
	outMsg := OutgoingMessage{
		Type:      "broadcast",
		Topic:     msg.Topic,
		Data:      msg.Message,
		Timestamp: time.Now(),
	}
	
	msgBytes, err := json.Marshal(outMsg)
	if err != nil {
		wsm.logger.Error("Failed to marshal broadcast message", zap.Error(err))
		return
	}
	
	var recipients []*WebSocketConnection
	
	if msg.Filter != nil {
		// Use custom filter
		wsm.connections.Range(func(key, value interface{}) bool {
			conn := value.(*WebSocketConnection)
			if msg.Filter(conn) {
				recipients = append(recipients, conn)
			}
			return true
		})
	} else {
		// Use topic subscribers
		if subscribers, exists := wsm.subscribers.Load(msg.Topic); exists {
			subscriberMap := subscribers.(*sync.Map)
			subscriberMap.Range(func(key, value interface{}) bool {
				conn := value.(*WebSocketConnection)
				recipients = append(recipients, conn)
				return true
			})
		}
	}
	
	// Send to all recipients
	for _, conn := range recipients {
		select {
		case conn.send <- msgBytes:
			wsm.messagesSent.Add(1)
		default:
			// Connection's send channel is full, close it
			wsm.logger.Warn("Connection send channel full, closing connection",
				zap.String("connection_id", conn.ID),
			)
			conn.Close()
		}
	}
}

// cleanupLoop performs periodic cleanup
func (wsm *WebSocketManager) cleanupLoop() {
	defer wsm.wg.Done()
	
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-wsm.ctx.Done():
			return
		case <-ticker.C:
			wsm.cleanup()
		}
	}
}

// cleanup removes stale connections and topics
func (wsm *WebSocketManager) cleanup() {
	// Remove closed connections
	wsm.connections.Range(func(key, value interface{}) bool {
		conn := value.(*WebSocketConnection)
		select {
		case <-conn.ctx.Done():
			wsm.removeConnection(conn)
		default:
		}
		return true
	})
	
	// Remove empty topics
	wsm.subscribers.Range(func(key, value interface{}) bool {
		topic := key.(string)
		subscriberMap := value.(*sync.Map)
		
		hasSubscribers := false
		subscriberMap.Range(func(k, v interface{}) bool {
			hasSubscribers = true
			return false // Stop iteration
		})
		
		if !hasSubscribers {
			wsm.subscribers.Delete(topic)
		}
		
		return true
	})
}

// removeConnection removes a connection from all data structures
func (wsm *WebSocketManager) removeConnection(conn *WebSocketConnection) {
	// Remove from connections
	wsm.connections.Delete(conn.ID)
	wsm.activeConnections.Add(^uint64(0)) // Atomic decrement
	
	// Remove from all subscriptions
	conn.subsMu.RLock()
	subscriptions := make([]string, 0, len(conn.subscriptions))
	for topic := range conn.subscriptions {
		subscriptions = append(subscriptions, topic)
	}
	conn.subsMu.RUnlock()
	
	for _, topic := range subscriptions {
		if subscribers, exists := wsm.subscribers.Load(topic); exists {
			subscriberMap := subscribers.(*sync.Map)
			subscriberMap.Delete(conn.ID)
		}
	}
	
	wsm.logger.Info("Connection removed",
		zap.String("connection_id", conn.ID),
		zap.String("user_id", conn.UserID),
		zap.Duration("duration", time.Since(conn.ConnectedAt)),
		zap.Uint64("messages_sent", conn.messagesSent.Load()),
		zap.Uint64("messages_received", conn.messagesReceived.Load()),
	)
}

// GetStats returns WebSocket statistics
func (wsm *WebSocketManager) GetStats() map[string]interface{} {
	activeConns := wsm.activeConnections.Load()
	topicCount := uint64(0)
	
	wsm.subscribers.Range(func(key, value interface{}) bool {
		topicCount++
		return true
	})
	
	return map[string]interface{}{
		"total_connections":    wsm.totalConnections.Load(),
		"active_connections":   activeConns,
		"total_topics":         topicCount,
		"messages_sent":        wsm.messagesSent.Load(),
		"messages_received":    wsm.messagesReceived.Load(),
	}
}

// Connection methods

// readPump handles reading messages from the WebSocket connection
func (conn *WebSocketConnection) readPump(wsm *WebSocketManager) {
	defer func() {
		conn.Close()
		wsm.removeConnection(conn)
	}()
	
	for {
		select {
		case <-conn.ctx.Done():
			return
		default:
		}
		
		conn.conn.SetReadDeadline(time.Now().Add(wsm.config.ReadTimeout))
		
		var msg IncomingMessage
		err := conn.conn.ReadJSON(&msg)
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				wsm.logger.Error("WebSocket read error", zap.Error(err))
			}
			break
		}
		
		conn.LastActivity = time.Now()
		conn.messagesReceived.Add(1)
		wsm.messagesReceived.Add(1)
		
		// Handle the message
		wsm.handleIncomingMessage(conn, msg)
	}
}

// writePump handles writing messages to the WebSocket connection
func (conn *WebSocketConnection) writePump(wsm *WebSocketManager) {
	ticker := time.NewTicker(wsm.config.PingInterval)
	defer func() {
		ticker.Stop()
		conn.conn.Close()
	}()
	
	for {
		select {
		case message, ok := <-conn.send:
			conn.conn.SetWriteDeadline(time.Now().Add(wsm.config.WriteTimeout))
			if !ok {
				conn.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			
			if err := conn.conn.WriteMessage(websocket.TextMessage, message); err != nil {
				wsm.logger.Error("WebSocket write error", zap.Error(err))
				return
			}
			
			conn.messagesSent.Add(1)
			
		case <-ticker.C:
			conn.conn.SetWriteDeadline(time.Now().Add(wsm.config.WriteTimeout))
			if err := conn.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
			
		case <-conn.ctx.Done():
			return
		}
	}
}

// pongHandler handles pong messages
func (conn *WebSocketConnection) pongHandler(string) error {
	conn.LastActivity = time.Now()
	return nil
}

// Close closes the WebSocket connection
func (conn *WebSocketConnection) Close() {
	conn.cancel()
	close(conn.send)
}

// handleIncomingMessage handles incoming WebSocket messages
func (wsm *WebSocketManager) handleIncomingMessage(conn *WebSocketConnection, msg IncomingMessage) {
	switch msg.Type {
	case "subscribe":
		if msg.Topic != "" {
			wsm.Subscribe(conn.ID, msg.Topic)
		}
	case "unsubscribe":
		if msg.Topic != "" {
			wsm.Unsubscribe(conn.ID, msg.Topic)
		}
	case "ping":
		// Send pong response
		response := OutgoingMessage{
			Type:      "pong",
			Timestamp: time.Now(),
			ID:        msg.ID,
		}
		wsm.sendToConnection(conn, response)
	default:
		wsm.logger.Debug("Unknown message type",
			zap.String("type", msg.Type),
			zap.String("connection_id", conn.ID),
		)
	}
}

// sendToConnection sends a message to a specific connection
func (wsm *WebSocketManager) sendToConnection(conn *WebSocketConnection, msg OutgoingMessage) {
	msgBytes, err := json.Marshal(msg)
	if err != nil {
		wsm.logger.Error("Failed to marshal message", zap.Error(err))
		return
	}
	
	select {
	case conn.send <- msgBytes:
	default:
		wsm.logger.Warn("Connection send channel full",
			zap.String("connection_id", conn.ID),
		)
	}
}

// Utility functions

// generateConnectionID generates a unique connection ID
func generateConnectionID() string {
	return fmt.Sprintf("conn_%d", time.Now().UnixNano())
}

// getClientIP extracts client IP from request
func getClientIP(r *http.Request) string {
	ip := r.Header.Get("X-Forwarded-For")
	if ip == "" {
		ip = r.Header.Get("X-Real-IP")
	}
	if ip == "" {
		ip = r.RemoteAddr
	}
	return ip
}

// checkOrigin creates an origin checker for WebSocket upgrade
func checkOrigin(allowedOrigins []string) func(*http.Request) bool {
	if len(allowedOrigins) == 0 {
		return func(*http.Request) bool { return true }
	}
	
	return func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		for _, allowed := range allowedOrigins {
			if origin == allowed {
				return true
			}
		}
		return false
	}
}