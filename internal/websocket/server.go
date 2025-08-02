package websocket

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"go.uber.org/zap"
)

// Server manages WebSocket connections for real-time updates
type Server struct {
	logger      *zap.Logger
	config      Config
	
	// Connection management
	clients     sync.Map // map[string]*Client
	clientCount atomic.Int32
	
	// Message broadcasting
	broadcast   chan Message
	
	// Data sources
	dataSources sync.Map // map[string]DataSource
	
	// Lifecycle
	ctx         context.Context
	cancel      context.CancelFunc
	wg          sync.WaitGroup
}

// Config defines WebSocket server configuration
type Config struct {
	// Server settings
	ReadBufferSize  int           `yaml:"read_buffer_size"`
	WriteBufferSize int           `yaml:"write_buffer_size"`
	
	// Timeouts
	HandshakeTimeout time.Duration `yaml:"handshake_timeout"`
	WriteTimeout     time.Duration `yaml:"write_timeout"`
	PingInterval     time.Duration `yaml:"ping_interval"`
	PongTimeout      time.Duration `yaml:"pong_timeout"`
	
	// Limits
	MaxClients       int           `yaml:"max_clients"`
	MaxMessageSize   int64         `yaml:"max_message_size"`
	
	// Security
	CheckOrigin      bool          `yaml:"check_origin"`
	AllowedOrigins   []string      `yaml:"allowed_origins"`
}

// Client represents a WebSocket client connection
type Client struct {
	ID          string
	conn        *websocket.Conn
	send        chan []byte
	
	// Subscriptions
	subscriptions map[string]bool
	subMu         sync.RWMutex
	
	// Rate limiting
	lastMessage   time.Time
	messageCount  int
	
	// Stats
	connected     time.Time
	messagesSent  atomic.Uint64
	messagesRecv  atomic.Uint64
}

// Message represents a WebSocket message
type Message struct {
	Type      string          `json:"type"`
	Channel   string          `json:"channel,omitempty"`
	Data      json.RawMessage `json:"data"`
	Timestamp time.Time       `json:"timestamp"`
}

// DataSource provides data for real-time updates
type DataSource interface {
	Subscribe(clientID string, params map[string]interface{}) error
	Unsubscribe(clientID string) error
	GetSnapshot() (interface{}, error)
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
}

// NewServer creates a new WebSocket server
func NewServer(logger *zap.Logger, config Config) *Server {
	// Set defaults
	if config.ReadBufferSize <= 0 {
		config.ReadBufferSize = 1024
	}
	if config.WriteBufferSize <= 0 {
		config.WriteBufferSize = 1024
	}
	if config.HandshakeTimeout <= 0 {
		config.HandshakeTimeout = 10 * time.Second
	}
	if config.WriteTimeout <= 0 {
		config.WriteTimeout = 10 * time.Second
	}
	if config.PingInterval <= 0 {
		config.PingInterval = 30 * time.Second
	}
	if config.PongTimeout <= 0 {
		config.PongTimeout = 60 * time.Second
	}
	if config.MaxClients <= 0 {
		config.MaxClients = 1000
	}
	if config.MaxMessageSize <= 0 {
		config.MaxMessageSize = 512 * 1024 // 512KB
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	s := &Server{
		logger:    logger,
		config:    config,
		broadcast: make(chan Message, 100),
		ctx:       ctx,
		cancel:    cancel,
	}
	
	// Configure upgrader
	upgrader.HandshakeTimeout = config.HandshakeTimeout
	upgrader.ReadBufferSize = config.ReadBufferSize
	upgrader.WriteBufferSize = config.WriteBufferSize
	
	if !config.CheckOrigin {
		upgrader.CheckOrigin = func(r *http.Request) bool {
			return true
		}
	} else {
		upgrader.CheckOrigin = s.checkOrigin
	}
	
	return s
}

// Start begins WebSocket server operations
func (s *Server) Start() error {
	s.logger.Info("Starting WebSocket server")
	
	// Start broadcast loop
	s.wg.Add(1)
	go s.broadcastLoop()
	
	// Start stats reporter
	s.wg.Add(1)
	go s.statsReporter()
	
	return nil
}

// Stop halts WebSocket server operations
func (s *Server) Stop() error {
	s.logger.Info("Stopping WebSocket server")
	s.cancel()
	
	// Close all client connections
	s.clients.Range(func(key, value interface{}) bool {
		if client, ok := value.(*Client); ok {
			client.conn.Close()
		}
		return true
	})
	
	close(s.broadcast)
	s.wg.Wait()
	
	return nil
}

// HandleConnection handles WebSocket upgrade requests
func (s *Server) HandleConnection(w http.ResponseWriter, r *http.Request) {
	// Check client limit
	if s.clientCount.Load() >= int32(s.config.MaxClients) {
		http.Error(w, "Server full", http.StatusServiceUnavailable)
		return
	}
	
	// Upgrade connection
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.logger.Error("Failed to upgrade connection", zap.Error(err))
		return
	}
	
	// Create client
	client := &Client{
		ID:            generateClientID(),
		conn:          conn,
		send:          make(chan []byte, 256),
		subscriptions: make(map[string]bool),
		connected:     time.Now(),
	}
	
	// Register client
	s.clients.Store(client.ID, client)
	s.clientCount.Add(1)
	
	s.logger.Info("Client connected",
		zap.String("client_id", client.ID),
		zap.String("remote_addr", conn.RemoteAddr().String()),
	)
	
	// Start client handlers
	s.wg.Add(2)
	go s.handleClientRead(client)
	go s.handleClientWrite(client)
	
	// Send welcome message
	welcome := Message{
		Type:      "welcome",
		Data:      json.RawMessage(fmt.Sprintf(`{"client_id":"%s"}`, client.ID)),
		Timestamp: time.Now(),
	}
	s.sendToClient(client, welcome)
}

// RegisterDataSource registers a data source for a channel
func (s *Server) RegisterDataSource(channel string, source DataSource) {
	s.dataSources.Store(channel, source)
}

// Broadcast sends a message to all subscribed clients
func (s *Server) Broadcast(channel string, data interface{}) error {
	jsonData, err := json.Marshal(data)
	if err != nil {
		return err
	}
	
	msg := Message{
		Type:      "update",
		Channel:   channel,
		Data:      jsonData,
		Timestamp: time.Now(),
	}
	
	select {
	case s.broadcast <- msg:
		return nil
	case <-s.ctx.Done():
		return fmt.Errorf("server stopped")
	default:
		return fmt.Errorf("broadcast queue full")
	}
}

// GetStats returns WebSocket server statistics
func (s *Server) GetStats() map[string]interface{} {
	stats := map[string]interface{}{
		"client_count": s.clientCount.Load(),
		"channels":     s.getChannelCount(),
	}
	
	// Add per-client stats
	clients := make([]map[string]interface{}, 0)
	s.clients.Range(func(key, value interface{}) bool {
		client := value.(*Client)
		clients = append(clients, map[string]interface{}{
			"id":            client.ID,
			"connected":     client.connected,
			"messages_sent": client.messagesSent.Load(),
			"messages_recv": client.messagesRecv.Load(),
			"subscriptions": len(client.subscriptions),
		})
		return true
	})
	stats["clients"] = clients
	
	return stats
}

// Private methods

func (s *Server) handleClientRead(client *Client) {
	defer s.wg.Done()
	defer s.disconnectClient(client)
	
	client.conn.SetReadLimit(s.config.MaxMessageSize)
	client.conn.SetReadDeadline(time.Now().Add(s.config.PongTimeout))
	client.conn.SetPongHandler(func(string) error {
		client.conn.SetReadDeadline(time.Now().Add(s.config.PongTimeout))
		return nil
	})
	
	for {
		var msg Message
		err := client.conn.ReadJSON(&msg)
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				s.logger.Error("WebSocket read error", zap.Error(err))
			}
			break
		}
		
		client.messagesRecv.Add(1)
		client.lastMessage = time.Now()
		
		// Handle message
		s.handleMessage(client, msg)
	}
}

func (s *Server) handleClientWrite(client *Client) {
	defer s.wg.Done()
	
	ticker := time.NewTicker(s.config.PingInterval)
	defer ticker.Stop()
	
	for {
		select {
		case message, ok := <-client.send:
			client.conn.SetWriteDeadline(time.Now().Add(s.config.WriteTimeout))
			if !ok {
				// Channel closed
				client.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			
			if err := client.conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}
			
			client.messagesSent.Add(1)
			
			// Send queued messages
			n := len(client.send)
			for i := 0; i < n; i++ {
				if err := client.conn.WriteMessage(websocket.TextMessage, <-client.send); err != nil {
					return
				}
				client.messagesSent.Add(1)
			}
			
		case <-ticker.C:
			client.conn.SetWriteDeadline(time.Now().Add(s.config.WriteTimeout))
			if err := client.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
			
		case <-s.ctx.Done():
			return
		}
	}
}

func (s *Server) handleMessage(client *Client, msg Message) {
	switch msg.Type {
	case "subscribe":
		s.handleSubscribe(client, msg)
	case "unsubscribe":
		s.handleUnsubscribe(client, msg)
	case "ping":
		s.handlePing(client)
	default:
		s.logger.Warn("Unknown message type",
			zap.String("type", msg.Type),
			zap.String("client_id", client.ID),
		)
	}
}

func (s *Server) handleSubscribe(client *Client, msg Message) {
	var params struct {
		Channel string                 `json:"channel"`
		Options map[string]interface{} `json:"options,omitempty"`
	}
	
	if err := json.Unmarshal(msg.Data, &params); err != nil {
		s.sendError(client, "Invalid subscribe message")
		return
	}
	
	// Check if data source exists
	sourceVal, ok := s.dataSources.Load(params.Channel)
	if !ok {
		s.sendError(client, fmt.Sprintf("Unknown channel: %s", params.Channel))
		return
	}
	
	source := sourceVal.(DataSource)
	
	// Subscribe to data source
	if err := source.Subscribe(client.ID, params.Options); err != nil {
		s.sendError(client, fmt.Sprintf("Subscribe failed: %v", err))
		return
	}
	
	// Track subscription
	client.subMu.Lock()
	client.subscriptions[params.Channel] = true
	client.subMu.Unlock()
	
	// Send current snapshot
	if snapshot, err := source.GetSnapshot(); err == nil {
		data, _ := json.Marshal(snapshot)
		s.sendToClient(client, Message{
			Type:      "snapshot",
			Channel:   params.Channel,
			Data:      data,
			Timestamp: time.Now(),
		})
	}
	
	// Confirm subscription
	s.sendToClient(client, Message{
		Type:      "subscribed",
		Channel:   params.Channel,
		Timestamp: time.Now(),
	})
}

func (s *Server) handleUnsubscribe(client *Client, msg Message) {
	var params struct {
		Channel string `json:"channel"`
	}
	
	if err := json.Unmarshal(msg.Data, &params); err != nil {
		s.sendError(client, "Invalid unsubscribe message")
		return
	}
	
	// Remove subscription
	client.subMu.Lock()
	delete(client.subscriptions, params.Channel)
	client.subMu.Unlock()
	
	// Unsubscribe from data source
	if sourceVal, ok := s.dataSources.Load(params.Channel); ok {
		source := sourceVal.(DataSource)
		source.Unsubscribe(client.ID)
	}
	
	// Confirm unsubscription
	s.sendToClient(client, Message{
		Type:      "unsubscribed",
		Channel:   params.Channel,
		Timestamp: time.Now(),
	})
}

func (s *Server) handlePing(client *Client) {
	s.sendToClient(client, Message{
		Type:      "pong",
		Timestamp: time.Now(),
	})
}

func (s *Server) broadcastLoop() {
	defer s.wg.Done()
	
	for {
		select {
		case msg, ok := <-s.broadcast:
			if !ok {
				return
			}
			
			// Marshal message once
			data, err := json.Marshal(msg)
			if err != nil {
				s.logger.Error("Failed to marshal broadcast message", zap.Error(err))
				continue
			}
			
			// Send to all subscribed clients
			s.clients.Range(func(key, value interface{}) bool {
				client := value.(*Client)
				
				// Check if client is subscribed to this channel
				if msg.Channel != "" {
					client.subMu.RLock()
					subscribed := client.subscriptions[msg.Channel]
					client.subMu.RUnlock()
					
					if !subscribed {
						return true
					}
				}
				
				// Send message
				select {
				case client.send <- data:
				default:
					// Client buffer full, skip
					s.logger.Warn("Client buffer full, skipping message",
						zap.String("client_id", client.ID),
						zap.String("channel", msg.Channel),
					)
				}
				
				return true
			})
			
		case <-s.ctx.Done():
			return
		}
	}
}

func (s *Server) disconnectClient(client *Client) {
	// Unsubscribe from all channels
	client.subMu.RLock()
	channels := make([]string, 0, len(client.subscriptions))
	for ch := range client.subscriptions {
		channels = append(channels, ch)
	}
	client.subMu.RUnlock()
	
	for _, ch := range channels {
		if sourceVal, ok := s.dataSources.Load(ch); ok {
			source := sourceVal.(DataSource)
			source.Unsubscribe(client.ID)
		}
	}
	
	// Remove client
	s.clients.Delete(client.ID)
	s.clientCount.Add(-1)
	close(client.send)
	
	s.logger.Info("Client disconnected",
		zap.String("client_id", client.ID),
		zap.Duration("connected_time", time.Since(client.connected)),
		zap.Uint64("messages_sent", client.messagesSent.Load()),
		zap.Uint64("messages_recv", client.messagesRecv.Load()),
	)
}

func (s *Server) sendToClient(client *Client, msg Message) {
	data, err := json.Marshal(msg)
	if err != nil {
		s.logger.Error("Failed to marshal message", zap.Error(err))
		return
	}
	
	select {
	case client.send <- data:
	default:
		// Buffer full, log and drop
		s.logger.Warn("Client send buffer full",
			zap.String("client_id", client.ID),
			zap.String("message_type", msg.Type),
		)
	}
}

func (s *Server) sendError(client *Client, errMsg string) {
	s.sendToClient(client, Message{
		Type:      "error",
		Data:      json.RawMessage(fmt.Sprintf(`{"error":"%s"}`, errMsg)),
		Timestamp: time.Now(),
	})
}

func (s *Server) checkOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	
	for _, allowed := range s.config.AllowedOrigins {
		if allowed == "*" || allowed == origin {
			return true
		}
	}
	
	return false
}

func (s *Server) getChannelCount() int {
	channels := make(map[string]bool)
	s.clients.Range(func(key, value interface{}) bool {
		client := value.(*Client)
		client.subMu.RLock()
		for ch := range client.subscriptions {
			channels[ch] = true
		}
		client.subMu.RUnlock()
		return true
	})
	return len(channels)
}

func (s *Server) statsReporter() {
	defer s.wg.Done()
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			stats := s.GetStats()
			s.logger.Info("WebSocket server stats", zap.Any("stats", stats))
		}
	}
}

// Helper functions

func generateClientID() string {
	return fmt.Sprintf("ws_%d_%d", time.Now().UnixNano(), rand.Int63())
}