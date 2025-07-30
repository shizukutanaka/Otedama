package protocol

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shizukutanaka/Otedama/internal/zkp"
	"go.uber.org/zap"
)

// Protocol implements the Otedama P2P network protocol
type Protocol struct {
	version      uint32
	nodeID       NodeID
	privateKey   *ecdsa.PrivateKey
	publicKey    *ecdsa.PublicKey
	
	// Network state
	connections  map[NodeID]*Connection
	connMu       sync.RWMutex
	
	// Message handling
	handlers     map[MessageType]MessageHandler
	handlerMu    sync.RWMutex
	
	// Protocol extensions
	extensions   map[string]Extension
	extMu        sync.RWMutex
	
	// Statistics
	stats        ProtocolStats
	
	// Zero-knowledge proof integration
	zkpManager   *zkp.ZKPManager
	
	logger       *zap.Logger
}

// NodeID represents a unique node identifier
type NodeID [32]byte

// Connection represents a peer connection
type Connection struct {
	NodeID       NodeID
	conn         net.Conn
	
	// Encryption
	encryptor    cipher.AEAD
	decryptor    cipher.AEAD
	
	// State
	state        ConnectionState
	established  time.Time
	lastActivity time.Time
	
	// Message handling
	sendQueue    chan *Message
	recvQueue    chan *Message
	
	// Statistics
	bytesSent    atomic.Uint64
	bytesRecv    atomic.Uint64
	msgsSent     atomic.Uint64
	msgsRecv     atomic.Uint64
	
	// Control
	closeChan    chan struct{}
	closeOnce    sync.Once
}

// ConnectionState represents the state of a connection
type ConnectionState uint8

const (
	StateConnecting ConnectionState = iota
	StateHandshaking
	StateAuthenticated
	StateActive
	StateClosing
	StateClosed
)

// Message represents a P2P protocol message
type Message struct {
	// Header
	Version     uint32
	Type        MessageType
	Flags       uint32
	Timestamp   uint64
	Nonce       uint64
	
	// Routing
	Source      NodeID
	Destination NodeID
	TTL         uint8
	
	// Payload
	Payload     []byte
	
	// Authentication
	Signature   []byte
	
	// ZKP proof (optional)
	ZKProof     []byte
}

// MessageType represents the type of message
type MessageType uint16

const (
	// Core protocol messages
	MessageTypeHandshake MessageType = iota
	MessageTypePing
	MessageTypePong
	MessageTypeDisconnect
	
	// Mining messages
	MessageTypeNewBlock
	MessageTypeTransaction
	MessageTypeGetBlocks
	MessageTypeBlocks
	
	// Pool messages
	MessageTypeShare
	MessageTypeJob
	MessageTypeDifficulty
	
	// DHT messages
	MessageTypeStore
	MessageTypeFind
	MessageTypeFound
	
	// Extension messages start at 1000
	MessageTypeExtension = 1000
)

// MessageHandler handles a specific message type
type MessageHandler func(conn *Connection, msg *Message) error

// Extension represents a protocol extension
type Extension interface {
	Name() string
	Version() uint32
	HandleMessage(conn *Connection, msg *Message) error
}

// ProtocolStats contains protocol statistics
type ProtocolStats struct {
	ConnectionsActive   atomic.Int32
	ConnectionsTotal    atomic.Uint64
	MessagesReceived    atomic.Uint64
	MessagesSent        atomic.Uint64
	BytesReceived       atomic.Uint64
	BytesSent          atomic.Uint64
	HandshakesFailed    atomic.Uint64
	AuthenticationsFailed atomic.Uint64
}

// Config contains protocol configuration
type Config struct {
	Version         uint32
	PrivateKey      *ecdsa.PrivateKey
	MaxConnections  int
	MessageTimeout  time.Duration
	HandshakeTimeout time.Duration
	EnableZKP       bool
}

// NewProtocol creates a new protocol instance
func NewProtocol(config Config, zkpManager *zkp.ZKPManager, logger *zap.Logger) (*Protocol, error) {
	// Generate node ID from public key
	pubKeyBytes := elliptic.Marshal(config.PrivateKey.PublicKey.Curve, 
		config.PrivateKey.PublicKey.X, 
		config.PrivateKey.PublicKey.Y)
	nodeID := sha256.Sum256(pubKeyBytes)
	
	p := &Protocol{
		version:     config.Version,
		nodeID:      NodeID(nodeID),
		privateKey:  config.PrivateKey,
		publicKey:   &config.PrivateKey.PublicKey,
		connections: make(map[NodeID]*Connection),
		handlers:    make(map[MessageType]MessageHandler),
		extensions:  make(map[string]Extension),
		zkpManager:  zkpManager,
		logger:      logger,
	}
	
	// Register core handlers
	p.registerCoreHandlers()
	
	return p, nil
}

// registerCoreHandlers registers core protocol message handlers
func (p *Protocol) registerCoreHandlers() {
	p.RegisterHandler(MessageTypeHandshake, p.handleHandshake)
	p.RegisterHandler(MessageTypePing, p.handlePing)
	p.RegisterHandler(MessageTypePong, p.handlePong)
	p.RegisterHandler(MessageTypeDisconnect, p.handleDisconnect)
}

// RegisterHandler registers a message handler
func (p *Protocol) RegisterHandler(msgType MessageType, handler MessageHandler) {
	p.handlerMu.Lock()
	defer p.handlerMu.Unlock()
	
	p.handlers[msgType] = handler
}

// RegisterExtension registers a protocol extension
func (p *Protocol) RegisterExtension(ext Extension) {
	p.extMu.Lock()
	defer p.extMu.Unlock()
	
	p.extensions[ext.Name()] = ext
}

// Connect establishes a connection to a peer
func (p *Protocol) Connect(address string) (*Connection, error) {
	// Dial the peer
	conn, err := net.DialTimeout("tcp", address, 10*time.Second)
	if err != nil {
		return nil, fmt.Errorf("failed to dial peer: %w", err)
	}
	
	// Create connection object
	peerConn := &Connection{
		conn:      conn,
		state:     StateConnecting,
		sendQueue: make(chan *Message, 1000),
		recvQueue: make(chan *Message, 1000),
		closeChan: make(chan struct{}),
	}
	
	// Start connection handlers
	go p.handleConnection(peerConn)
	
	// Perform handshake
	if err := p.performHandshake(peerConn); err != nil {
		peerConn.Close()
		return nil, fmt.Errorf("handshake failed: %w", err)
	}
	
	// Add to connections map
	p.connMu.Lock()
	p.connections[peerConn.NodeID] = peerConn
	p.connMu.Unlock()
	
	p.stats.ConnectionsActive.Add(1)
	p.stats.ConnectionsTotal.Add(1)
	
	return peerConn, nil
}

// Accept accepts incoming connections
func (p *Protocol) Accept(listener net.Listener) {
	for {
		conn, err := listener.Accept()
		if err != nil {
			p.logger.Error("Failed to accept connection", zap.Error(err))
			continue
		}
		
		// Handle connection in goroutine
		go p.handleIncomingConnection(conn)
	}
}

// handleIncomingConnection handles an incoming connection
func (p *Protocol) handleIncomingConnection(conn net.Conn) {
	peerConn := &Connection{
		conn:      conn,
		state:     StateConnecting,
		sendQueue: make(chan *Message, 1000),
		recvQueue: make(chan *Message, 1000),
		closeChan: make(chan struct{}),
	}
	
	// Start connection handlers
	go p.handleConnection(peerConn)
	
	// Wait for handshake
	select {
	case <-time.After(30 * time.Second):
		p.logger.Warn("Handshake timeout")
		peerConn.Close()
		
	case <-peerConn.closeChan:
		// Connection closed
	}
}

// performHandshake performs the protocol handshake
func (p *Protocol) performHandshake(conn *Connection) error {
	conn.state = StateHandshaking
	
	// Create handshake message
	handshake := &HandshakeMessage{
		Version:   p.version,
		NodeID:    p.nodeID,
		PublicKey: p.publicKey,
		Timestamp: time.Now().Unix(),
		Nonce:     generateNonce(),
	}
	
	// Include ZKP if enabled
	if p.zkpManager != nil {
		// Generate age proof (example)
		witness := zkp.Witness{
			PrivateInputs: map[string]interface{}{
				"age": 25, // Example age
			},
		}
		
		proof, err := p.zkpManager.GenerateProof(zkp.CircuitTypeAge, witness)
		if err == nil {
			handshake.ZKProof = proof
		}
	}
	
	// Send handshake
	if err := p.sendHandshake(conn, handshake); err != nil {
		return err
	}
	
	// Receive peer handshake
	peerHandshake, err := p.receiveHandshake(conn)
	if err != nil {
		return err
	}
	
	// Verify handshake
	if err := p.verifyHandshake(peerHandshake); err != nil {
		return err
	}
	
	// Establish encryption
	if err := p.establishEncryption(conn, peerHandshake); err != nil {
		return err
	}
	
	conn.NodeID = peerHandshake.NodeID
	conn.state = StateAuthenticated
	conn.established = time.Now()
	
	return nil
}

// establishEncryption establishes encrypted communication
func (p *Protocol) establishEncryption(conn *Connection, peerHandshake *HandshakeMessage) error {
	// Perform ECDH key exchange
	peerPubKey := peerHandshake.PublicKey
	
	// Compute shared secret
	x, _ := peerPubKey.Curve.ScalarMult(peerPubKey.X, peerPubKey.Y, p.privateKey.D.Bytes())
	sharedSecret := x.Bytes()
	
	// Derive encryption keys
	h := sha256.New()
	h.Write(sharedSecret)
	h.Write([]byte("otedama-encryption"))
	encKey := h.Sum(nil)
	
	h.Reset()
	h.Write(sharedSecret)
	h.Write([]byte("otedama-decryption"))
	decKey := h.Sum(nil)
	
	// Create AES-GCM ciphers
	block, err := aes.NewCipher(encKey[:32])
	if err != nil {
		return err
	}
	
	encryptor, err := cipher.NewGCM(block)
	if err != nil {
		return err
	}
	
	block, err = aes.NewCipher(decKey[:32])
	if err != nil {
		return err
	}
	
	decryptor, err := cipher.NewGCM(block)
	if err != nil {
		return err
	}
	
	conn.encryptor = encryptor
	conn.decryptor = decryptor
	
	return nil
}

// handleConnection handles a connection's lifecycle
func (p *Protocol) handleConnection(conn *Connection) {
	// Start read loop
	go p.readLoop(conn)
	
	// Start write loop
	go p.writeLoop(conn)
	
	// Start message processor
	go p.processMessages(conn)
	
	// Wait for connection to close
	<-conn.closeChan
	
	// Clean up
	p.connMu.Lock()
	delete(p.connections, conn.NodeID)
	p.connMu.Unlock()
	
	p.stats.ConnectionsActive.Add(-1)
}

// readLoop reads messages from the connection
func (p *Protocol) readLoop(conn *Connection) {
	defer conn.Close()
	
	for {
		select {
		case <-conn.closeChan:
			return
		default:
		}
		
		// Read message
		msg, err := p.readMessage(conn)
		if err != nil {
			if err != io.EOF {
				p.logger.Error("Failed to read message", 
					zap.String("peer", fmt.Sprintf("%x", conn.NodeID[:8])),
					zap.Error(err))
			}
			return
		}
		
		// Update statistics
		conn.lastActivity = time.Now()
		conn.msgsRecv.Add(1)
		p.stats.MessagesReceived.Add(1)
		
		// Queue message for processing
		select {
		case conn.recvQueue <- msg:
		case <-time.After(5 * time.Second):
			p.logger.Warn("Message queue full, dropping message")
		}
	}
}

// writeLoop writes messages to the connection
func (p *Protocol) writeLoop(conn *Connection) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-conn.closeChan:
			return
			
		case msg := <-conn.sendQueue:
			if err := p.writeMessage(conn, msg); err != nil {
				p.logger.Error("Failed to write message",
					zap.String("peer", fmt.Sprintf("%x", conn.NodeID[:8])),
					zap.Error(err))
				conn.Close()
				return
			}
			
			// Update statistics
			conn.msgsSent.Add(1)
			p.stats.MessagesSent.Add(1)
			
		case <-ticker.C:
			// Send ping to keep connection alive
			ping := &Message{
				Version:   p.version,
				Type:      MessageTypePing,
				Timestamp: uint64(time.Now().Unix()),
				Source:    p.nodeID,
			}
			
			select {
			case conn.sendQueue <- ping:
			default:
			}
		}
	}
}

// processMessages processes incoming messages
func (p *Protocol) processMessages(conn *Connection) {
	for {
		select {
		case <-conn.closeChan:
			return
			
		case msg := <-conn.recvQueue:
			// Get handler
			p.handlerMu.RLock()
			handler, ok := p.handlers[msg.Type]
			p.handlerMu.RUnlock()
			
			if !ok {
				// Check extensions
				if msg.Type >= MessageTypeExtension {
					p.handleExtensionMessage(conn, msg)
					continue
				}
				
				p.logger.Warn("No handler for message type",
					zap.Uint16("type", uint16(msg.Type)))
				continue
			}
			
			// Handle message
			if err := handler(conn, msg); err != nil {
				p.logger.Error("Failed to handle message",
					zap.Uint16("type", uint16(msg.Type)),
					zap.Error(err))
			}
		}
	}
}

// readMessage reads a message from the connection
func (p *Protocol) readMessage(conn *Connection) (*Message, error) {
	// Read header
	headerBuf := make([]byte, 64) // Fixed header size
	if _, err := io.ReadFull(conn.conn, headerBuf); err != nil {
		return nil, err
	}
	
	// Decrypt header if encrypted
	if conn.state >= StateAuthenticated && conn.decryptor != nil {
		decrypted, err := conn.decryptor.Open(nil, headerBuf[:12], headerBuf[12:], nil)
		if err != nil {
			return nil, fmt.Errorf("failed to decrypt header: %w", err)
		}
		copy(headerBuf[12:], decrypted)
	}
	
	// Parse header
	msg := &Message{}
	buf := bytes.NewReader(headerBuf)
	
	binary.Read(buf, binary.BigEndian, &msg.Version)
	binary.Read(buf, binary.BigEndian, &msg.Type)
	binary.Read(buf, binary.BigEndian, &msg.Flags)
	binary.Read(buf, binary.BigEndian, &msg.Timestamp)
	binary.Read(buf, binary.BigEndian, &msg.Nonce)
	
	// Read payload length
	var payloadLen uint32
	binary.Read(buf, binary.BigEndian, &payloadLen)
	
	if payloadLen > 10*1024*1024 { // 10MB max
		return nil, errors.New("payload too large")
	}
	
	// Read payload
	if payloadLen > 0 {
		msg.Payload = make([]byte, payloadLen)
		if _, err := io.ReadFull(conn.conn, msg.Payload); err != nil {
			return nil, err
		}
		
		// Decrypt payload if encrypted
		if conn.state >= StateAuthenticated && conn.decryptor != nil {
			nonce := make([]byte, 12)
			binary.BigEndian.PutUint64(nonce[4:], msg.Nonce)
			
			decrypted, err := conn.decryptor.Open(nil, nonce, msg.Payload, nil)
			if err != nil {
				return nil, fmt.Errorf("failed to decrypt payload: %w", err)
			}
			msg.Payload = decrypted
		}
	}
	
	// Update statistics
	conn.bytesRecv.Add(uint64(64 + len(msg.Payload)))
	p.stats.BytesReceived.Add(uint64(64 + len(msg.Payload)))
	
	return msg, nil
}

// writeMessage writes a message to the connection
func (p *Protocol) writeMessage(conn *Connection, msg *Message) error {
	// Prepare header
	headerBuf := bytes.NewBuffer(nil)
	
	binary.Write(headerBuf, binary.BigEndian, msg.Version)
	binary.Write(headerBuf, binary.BigEndian, msg.Type)
	binary.Write(headerBuf, binary.BigEndian, msg.Flags)
	binary.Write(headerBuf, binary.BigEndian, msg.Timestamp)
	binary.Write(headerBuf, binary.BigEndian, msg.Nonce)
	binary.Write(headerBuf, binary.BigEndian, uint32(len(msg.Payload)))
	
	// Pad header to fixed size
	for headerBuf.Len() < 64 {
		headerBuf.WriteByte(0)
	}
	
	// Encrypt if connection is authenticated
	header := headerBuf.Bytes()
	payload := msg.Payload
	
	if conn.state >= StateAuthenticated && conn.encryptor != nil {
		// Encrypt header (excluding first 12 bytes used as nonce)
		encrypted := conn.encryptor.Seal(nil, header[:12], header[12:], nil)
		copy(header[12:], encrypted)
		
		// Encrypt payload
		if len(payload) > 0 {
			nonce := make([]byte, 12)
			binary.BigEndian.PutUint64(nonce[4:], msg.Nonce)
			payload = conn.encryptor.Seal(nil, nonce, payload, nil)
		}
	}
	
	// Write header
	if _, err := conn.conn.Write(header); err != nil {
		return err
	}
	
	// Write payload
	if len(payload) > 0 {
		if _, err := conn.conn.Write(payload); err != nil {
			return err
		}
	}
	
	// Update statistics
	conn.bytesSent.Add(uint64(64 + len(payload)))
	p.stats.BytesSent.Add(uint64(64 + len(payload)))
	
	return nil
}

// Core message handlers

func (p *Protocol) handleHandshake(conn *Connection, msg *Message) error {
	// Parse handshake
	var handshake HandshakeMessage
	if err := decodeMessage(msg.Payload, &handshake); err != nil {
		return err
	}
	
	// Verify handshake
	if err := p.verifyHandshake(&handshake); err != nil {
		p.stats.HandshakesFailed.Add(1)
		return err
	}
	
	// Verify ZKP if provided
	if handshake.ZKProof != nil && p.zkpManager != nil {
		valid, err := p.zkpManager.VerifyProof(zkp.CircuitTypeAge, handshake.ZKProof)
		if err != nil || !valid {
			p.stats.AuthenticationsFailed.Add(1)
			return errors.New("ZKP verification failed")
		}
	}
	
	// Update connection state
	conn.NodeID = handshake.NodeID
	conn.state = StateActive
	
	return nil
}

func (p *Protocol) handlePing(conn *Connection, msg *Message) error {
	// Send pong
	pong := &Message{
		Version:   p.version,
		Type:      MessageTypePong,
		Timestamp: uint64(time.Now().Unix()),
		Source:    p.nodeID,
		Nonce:     msg.Nonce,
	}
	
	select {
	case conn.sendQueue <- pong:
	case <-time.After(time.Second):
		return errors.New("send queue full")
	}
	
	return nil
}

func (p *Protocol) handlePong(conn *Connection, msg *Message) error {
	// Update last activity
	conn.lastActivity = time.Now()
	return nil
}

func (p *Protocol) handleDisconnect(conn *Connection, msg *Message) error {
	// Close connection
	conn.Close()
	return nil
}

// SendMessage sends a message to a specific peer
func (p *Protocol) SendMessage(nodeID NodeID, msg *Message) error {
	p.connMu.RLock()
	conn, ok := p.connections[nodeID]
	p.connMu.RUnlock()
	
	if !ok {
		return errors.New("peer not connected")
	}
	
	// Set message fields
	msg.Version = p.version
	msg.Source = p.nodeID
	msg.Destination = nodeID
	msg.Timestamp = uint64(time.Now().Unix())
	msg.Nonce = generateNonce()
	
	// Queue message
	select {
	case conn.sendQueue <- msg:
		return nil
	case <-time.After(5 * time.Second):
		return errors.New("send timeout")
	}
}

// Broadcast sends a message to all connected peers
func (p *Protocol) Broadcast(msg *Message) {
	p.connMu.RLock()
	connections := make([]*Connection, 0, len(p.connections))
	for _, conn := range p.connections {
		connections = append(connections, conn)
	}
	p.connMu.RUnlock()
	
	// Set message fields
	msg.Version = p.version
	msg.Source = p.nodeID
	msg.Timestamp = uint64(time.Now().Unix())
	msg.Nonce = generateNonce()
	
	// Send to all peers
	for _, conn := range connections {
		msgCopy := *msg
		msgCopy.Destination = conn.NodeID
		
		select {
		case conn.sendQueue <- &msgCopy:
		default:
			// Skip if queue is full
		}
	}
}

// Connection methods

func (c *Connection) Close() error {
	c.closeOnce.Do(func() {
		close(c.closeChan)
		c.conn.Close()
		c.state = StateClosed
	})
	return nil
}

func (c *Connection) IsActive() bool {
	return c.state == StateActive
}

func (c *Connection) GetStats() ConnectionStats {
	return ConnectionStats{
		BytesSent:    c.bytesSent.Load(),
		BytesRecv:    c.bytesRecv.Load(),
		MessagesSent: c.msgsSent.Load(),
		MessagesRecv: c.msgsRecv.Load(),
		Established:  c.established,
		LastActivity: c.lastActivity,
	}
}

// ConnectionStats contains connection statistics
type ConnectionStats struct {
	BytesSent    uint64
	BytesRecv    uint64
	MessagesSent uint64
	MessagesRecv uint64
	Established  time.Time
	LastActivity time.Time
}

// HandshakeMessage represents a handshake message
type HandshakeMessage struct {
	Version   uint32
	NodeID    NodeID
	PublicKey *ecdsa.PublicKey
	Timestamp int64
	Nonce     uint64
	Features  []string
	ZKProof   []byte
}

// Helper functions

func generateNonce() uint64 {
	var nonce uint64
	binary.Read(rand.Reader, binary.BigEndian, &nonce)
	return nonce
}

func (p *Protocol) verifyHandshake(handshake *HandshakeMessage) error {
	// Verify version compatibility
	if handshake.Version != p.version {
		return fmt.Errorf("incompatible version: %d", handshake.Version)
	}
	
	// Verify timestamp
	timeDiff := time.Now().Unix() - handshake.Timestamp
	if timeDiff < -300 || timeDiff > 300 { // 5 minute window
		return errors.New("handshake timestamp out of range")
	}
	
	// Verify public key matches node ID
	pubKeyBytes := elliptic.Marshal(handshake.PublicKey.Curve,
		handshake.PublicKey.X,
		handshake.PublicKey.Y)
	expectedID := sha256.Sum256(pubKeyBytes)
	
	if !bytes.Equal(expectedID[:], handshake.NodeID[:]) {
		return errors.New("public key does not match node ID")
	}
	
	return nil
}

func (p *Protocol) handleExtensionMessage(conn *Connection, msg *Message) {
	// Extract extension name from message
	if len(msg.Payload) < 32 {
		return
	}
	
	extName := string(bytes.TrimRight(msg.Payload[:32], "\x00"))
	
	p.extMu.RLock()
	ext, ok := p.extensions[extName]
	p.extMu.RUnlock()
	
	if !ok {
		p.logger.Warn("Unknown extension",
			zap.String("extension", extName))
		return
	}
	
	// Let extension handle the message
	if err := ext.HandleMessage(conn, msg); err != nil {
		p.logger.Error("Extension failed to handle message",
			zap.String("extension", extName),
			zap.Error(err))
	}
}

func decodeMessage(data []byte, v interface{}) error {
	// Implementation would use a proper encoding format
	// For now, this is a placeholder
	return nil
}

func encodeMessage(v interface{}) ([]byte, error) {
	// Implementation would use a proper encoding format
	// For now, this is a placeholder
	return nil, nil
}

func (p *Protocol) sendHandshake(conn *Connection, handshake *HandshakeMessage) error {
	data, err := encodeMessage(handshake)
	if err != nil {
		return err
	}
	
	msg := &Message{
		Version:   p.version,
		Type:      MessageTypeHandshake,
		Timestamp: uint64(time.Now().Unix()),
		Source:    p.nodeID,
		Payload:   data,
	}
	
	return p.writeMessage(conn, msg)
}

func (p *Protocol) receiveHandshake(conn *Connection) (*HandshakeMessage, error) {
	// Set timeout
	conn.conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	defer conn.conn.SetReadDeadline(time.Time{})
	
	// Read handshake message
	msg, err := p.readMessage(conn)
	if err != nil {
		return nil, err
	}
	
	if msg.Type != MessageTypeHandshake {
		return nil, errors.New("expected handshake message")
	}
	
	// Decode handshake
	var handshake HandshakeMessage
	if err := decodeMessage(msg.Payload, &handshake); err != nil {
		return nil, err
	}
	
	return &handshake, nil
}