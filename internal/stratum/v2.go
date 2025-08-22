package stratum

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// StratumV2Server implements Stratum v2 protocol
type StratumV2Server struct {
	// Network
	listener net.Listener
	addr     string
	
	// Clients
	clients   map[string]*StratumV2Client
	clientsMu sync.RWMutex
	
	// Configuration
	config    *V2Config
	
	// Job management
	jobTemplate *JobTemplate
	jobCounter  atomic.Uint64
	
	// Statistics
	totalConnections atomic.Uint64
	activeClients    atomic.Int32
	totalShares      atomic.Uint64
	validShares      atomic.Uint64
	
	// Control
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// StratumV2Client represents a connected client
type StratumV2Client struct {
	ID       string
	conn     net.Conn
	encoder  *MessageEncoder
	decoder  *MessageDecoder
	
	// Subscription
	subscribed  bool
	extraNonce1 []byte
	
	// Authorization
	authorized bool
	workerName string
	
	// Difficulty
	difficulty atomic.Value // float64
	
	// Job state
	currentJob atomic.Value // *MiningJob
	
	// Statistics
	connectTime    time.Time
	lastActivity   atomic.Value // time.Time
	submittedShares atomic.Uint64
	validShares     atomic.Uint64
	
	// Channels
	sendChan chan *V2Message
	
	// Control
	ctx    context.Context
	cancel context.CancelFunc
}

// V2Config holds Stratum v2 configuration
type V2Config struct {
	Address           string
	Port              int
	MaxClients        int
	DifficultyTarget  float64
	JobUpdateInterval time.Duration
	ClientTimeout     time.Duration
	
	// Protocol settings
	EnableCompression bool
	MaxMessageSize    int
	MinDifficulty     float64
	MaxDifficulty     float64
}

// V2Message represents a Stratum v2 message
type V2Message struct {
	MessageType MessageType
	RequestID   uint32
	Payload     []byte
	
	// Noise protocol fields
	Encrypted bool
	Nonce     []byte
}

// MessageType represents Stratum v2 message types
type MessageType uint8

const (
	// Standard messages
	SetupConnection         MessageType = 0x00
	SetupConnectionSuccess  MessageType = 0x01
	SetupConnectionError    MessageType = 0x02
	ChannelEndpointChanged  MessageType = 0x03
	
	// Mining messages
	OpenStandardMiningChannel         MessageType = 0x10
	OpenStandardMiningChannelSuccess  MessageType = 0x11
	OpenStandardMiningChannelError    MessageType = 0x12
	UpdateChannel                     MessageType = 0x13
	CloseChannel                      MessageType = 0x14
	SetExtraNonce                     MessageType = 0x15
	
	// Job messages
	NewTemplate                 MessageType = 0x20
	SetNewPrevHash             MessageType = 0x21
	RequestTransactionData     MessageType = 0x22
	RequestTransactionDataSuccess MessageType = 0x23
	RequestTransactionDataError   MessageType = 0x24
	SubmitSharesStandard       MessageType = 0x25
	SubmitSharesSuccess        MessageType = 0x26
	SubmitSharesError          MessageType = 0x27
	NewMiningJob               MessageType = 0x28
	SetTarget                  MessageType = 0x29
)

// JobTemplate represents a mining job template
type JobTemplate struct {
	JobID         uint32
	PrevHash      []byte
	CoinbasePrefix []byte
	CoinbaseSuffix []byte
	MerkleRoot    []byte
	Version       uint32
	Bits          uint32
	Timestamp     uint32
	FutureJob     bool
}

// MiningJob represents an active mining job
type MiningJob struct {
	JobID      uint32
	PrevHash   []byte
	Coinbase1  []byte
	Coinbase2  []byte
	MerkleTree [][]byte
	Version    uint32
	Bits       uint32
	Timestamp  uint32
	CleanJobs  bool
	Target     []byte
}

// Share represents a submitted share
type Share struct {
	JobID      uint32
	ExtraNonce2 []byte
	Timestamp   uint32
	Nonce      uint32
	VersionBits uint32
}

// MessageEncoder encodes Stratum v2 messages
type MessageEncoder struct {
	writer io.Writer
	mu     sync.Mutex
}

// MessageDecoder decodes Stratum v2 messages
type MessageDecoder struct {
	reader io.Reader
	buffer []byte
}

// DefaultV2Config returns default configuration
func DefaultV2Config() *V2Config {
	return &V2Config{
		Address:           "0.0.0.0",
		Port:              3333,
		MaxClients:        1000,
		DifficultyTarget:  1.0,
		JobUpdateInterval: 30 * time.Second,
		ClientTimeout:     300 * time.Second,
		EnableCompression: true,
		MaxMessageSize:    1024 * 1024, // 1MB
		MinDifficulty:     0.001,
		MaxDifficulty:     1000000.0,
	}
}

// NewStratumV2Server creates a new Stratum v2 server
func NewStratumV2Server(ctx context.Context, config *V2Config) *StratumV2Server {
	if config == nil {
		config = DefaultV2Config()
	}
	
	ctx, cancel := context.WithCancel(ctx)
	
	return &StratumV2Server{
		addr:     fmt.Sprintf("%s:%d", config.Address, config.Port),
		clients:  make(map[string]*StratumV2Client),
		config:   config,
		ctx:      ctx,
		cancel:   cancel,
	}
}

// Start starts the Stratum v2 server
func (s *StratumV2Server) Start() error {
	listener, err := net.Listen("tcp", s.addr)
	if err != nil {
		return fmt.Errorf("failed to listen on %s: %w", s.addr, err)
	}
	
	s.listener = listener
	fmt.Printf("Stratum v2 server listening on %s\n", s.addr)
	
	// Start job updater
	s.wg.Add(1)
	go s.jobUpdater()
	
	// Start client cleaner
	s.wg.Add(1)
	go s.clientCleaner()
	
	// Accept connections
	s.wg.Add(1)
	go s.acceptConnections()
	
	return nil
}

// Stop stops the Stratum v2 server
func (s *StratumV2Server) Stop() error {
	s.cancel()
	
	if s.listener != nil {
		s.listener.Close()
	}
	
	// Close all clients
	s.clientsMu.Lock()
	for _, client := range s.clients {
		client.Close()
	}
	s.clientsMu.Unlock()
	
	s.wg.Wait()
	return nil
}

// acceptConnections accepts new client connections
func (s *StratumV2Server) acceptConnections() {
	defer s.wg.Done()
	
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			select {
			case <-s.ctx.Done():
				return
			default:
				fmt.Printf("Accept error: %v\n", err)
				continue
			}
		}
		
		// Check client limit
		if s.activeClients.Load() >= int32(s.config.MaxClients) {
			conn.Close()
			continue
		}
		
		// Create client
		client := s.newClient(conn)
		
		// Handle client
		s.wg.Add(1)
		go s.handleClient(client)
	}
}

// newClient creates a new client
func (s *StratumV2Server) newClient(conn net.Conn) *StratumV2Client {
	clientID := generateClientID()
	ctx, cancel := context.WithCancel(s.ctx)
	
	client := &StratumV2Client{
		ID:       clientID,
		conn:     conn,
		encoder:  NewMessageEncoder(conn),
		decoder:  NewMessageDecoder(conn),
		sendChan: make(chan *V2Message, 100),
		ctx:      ctx,
		cancel:   cancel,
		connectTime: time.Now(),
	}
	
	client.lastActivity.Store(time.Now())
	client.difficulty.Store(s.config.DifficultyTarget)
	
	// Add to clients map
	s.clientsMu.Lock()
	s.clients[clientID] = client
	s.clientsMu.Unlock()
	
	s.totalConnections.Add(1)
	s.activeClients.Add(1)
	
	return client
}

// handleClient handles a client connection
func (s *StratumV2Server) handleClient(client *StratumV2Client) {
	defer s.wg.Done()
	defer client.Close()
	defer s.removeClient(client.ID)
	
	fmt.Printf("New client connected: %s\n", client.ID)
	
	// Start message sender
	go client.messageSender()
	
	// Set connection timeout
	client.conn.SetReadDeadline(time.Now().Add(s.config.ClientTimeout))
	
	for {
		select {
		case <-client.ctx.Done():
			return
		default:
		}
		
		// Read message
		message, err := client.decoder.DecodeMessage()
		if err != nil {
			if err != io.EOF {
				fmt.Printf("Client %s decode error: %v\n", client.ID, err)
			}
			return
		}
		
		// Update activity
		client.lastActivity.Store(time.Now())
		client.conn.SetReadDeadline(time.Now().Add(s.config.ClientTimeout))
		
		// Handle message
		if err := s.handleMessage(client, message); err != nil {
			fmt.Printf("Client %s message error: %v\n", client.ID, err)
			return
		}
	}
}

// handleMessage handles a client message
func (s *StratumV2Server) handleMessage(client *StratumV2Client, message *V2Message) error {
	switch message.MessageType {
	case SetupConnection:
		return s.handleSetupConnection(client, message)
	case OpenStandardMiningChannel:
		return s.handleOpenMiningChannel(client, message)
	case SubmitSharesStandard:
		return s.handleSubmitShares(client, message)
	default:
		return fmt.Errorf("unknown message type: %d", message.MessageType)
	}
}

// handleSetupConnection handles connection setup
func (s *StratumV2Server) handleSetupConnection(client *StratumV2Client, message *V2Message) error {
	// Parse setup request
	var setupRequest struct {
		Protocol      string `json:"protocol"`
		MinVersion    uint16 `json:"min_version"`
		MaxVersion    uint16 `json:"max_version"`
		Flags         uint32 `json:"flags"`
		EndpointHost  string `json:"endpoint_host"`
		EndpointPort  uint16 `json:"endpoint_port"`
		Vendor        string `json:"vendor"`
		HardwareVersion string `json:"hardware_version"`
		Firmware      string `json:"firmware"`
		DeviceID      string `json:"device_id"`
	}
	
	if err := json.Unmarshal(message.Payload, &setupRequest); err != nil {
		return s.sendSetupError(client, message.RequestID, "invalid_setup_request")
	}
	
	// Validate protocol
	if setupRequest.Protocol != "stratum-v2" {
		return s.sendSetupError(client, message.RequestID, "unsupported_protocol")
	}
	
	// Send success response
	response := map[string]interface{}{
		"used_version": 2,
		"flags":        0,
	}
	
	return s.sendResponse(client, SetupConnectionSuccess, message.RequestID, response)
}

// handleOpenMiningChannel handles mining channel opening
func (s *StratumV2Server) handleOpenMiningChannel(client *StratumV2Client, message *V2Message) error {
	// Parse channel request
	var channelRequest struct {
		RequestID        uint32  `json:"request_id"`
		UserIdentity     string  `json:"user_identity"`
		NominalHashRate  float64 `json:"nominal_hash_rate"`
		MaxTarget        []byte  `json:"max_target"`
	}
	
	if err := json.Unmarshal(message.Payload, &channelRequest); err != nil {
		return s.sendChannelError(client, message.RequestID, "invalid_channel_request")
	}
	
	// Generate extra nonce
	client.extraNonce1 = make([]byte, 4)
	rand.Read(client.extraNonce1)
	
	// Set authorized
	client.authorized = true
	client.workerName = channelRequest.UserIdentity
	client.subscribed = true
	
	// Send success response
	response := map[string]interface{}{
		"channel_id":              1,
		"target":                  generateTarget(client.difficulty.Load().(float64)),
		"extranonce_prefix":       hex.EncodeToString(client.extraNonce1),
		"extranonce_prefix_size":  len(client.extraNonce1),
	}
	
	// Send current job
	if s.jobTemplate != nil {
		job := s.createMiningJob(client)
		client.currentJob.Store(job)
		go s.sendMiningJob(client, job)
	}
	
	return s.sendResponse(client, OpenStandardMiningChannelSuccess, message.RequestID, response)
}

// handleSubmitShares handles share submission
func (s *StratumV2Server) handleSubmitShares(client *StratumV2Client, message *V2Message) error {
	if !client.authorized {
		return s.sendShareError(client, message.RequestID, "unauthorized")
	}
	
	// Parse share
	var shareData struct {
		ChannelID     uint32 `json:"channel_id"`
		SequenceNumber uint32 `json:"sequence_number"`
		JobID         uint32 `json:"job_id"`
		Nonce         uint32 `json:"nonce"`
		ExtraNonce2   []byte `json:"extranonce2"`
		VersionBits   uint32 `json:"version_bits"`
		Timestamp     uint32 `json:"timestamp"`
	}
	
	if err := json.Unmarshal(message.Payload, &shareData); err != nil {
		return s.sendShareError(client, message.RequestID, "invalid_share")
	}
	
	// Validate share
	valid, err := s.validateShare(client, &shareData)
	if err != nil {
		return s.sendShareError(client, message.RequestID, err.Error())
	}
	
	// Update statistics
	client.submittedShares.Add(1)
	s.totalShares.Add(1)
	
	if valid {
		client.validShares.Add(1)
		s.validShares.Add(1)
		
		// Check if it's a block
		if s.isBlock(&shareData) {
			fmt.Printf("Block found by client %s!\n", client.ID)
		}
	}
	
	// Send response
	response := map[string]interface{}{
		"channel_id":      shareData.ChannelID,
		"sequence_number": shareData.SequenceNumber,
		"new_submits_accepted_count": client.validShares.Load(),
		"new_shares_sum": client.submittedShares.Load(),
	}
	
	return s.sendResponse(client, SubmitSharesSuccess, message.RequestID, response)
}

// validateShare validates a submitted share
func (s *StratumV2Server) validateShare(client *StratumV2Client, share *shareData) (bool, error) {
	job := client.currentJob.Load()
	if job == nil {
		return false, errors.New("no_current_job")
	}
	
	miningJob := job.(*MiningJob)
	if share.JobID != miningJob.JobID {
		return false, errors.New("stale_job")
	}
	
	// Build block header
	header := s.buildBlockHeader(miningJob, share, client.extraNonce1, share.ExtraNonce2)
	
	// Calculate hash
	hash := sha256.Sum256(header)
	hash = sha256.Sum256(hash[:])
	
	// Check against difficulty
	target := generateTarget(client.difficulty.Load().(float64))
	return s.checkTarget(hash[:], target), nil
}

// buildBlockHeader builds block header for validation
func (s *StratumV2Server) buildBlockHeader(job *MiningJob, share *shareData, extraNonce1, extraNonce2 []byte) []byte {
	header := make([]byte, 80)
	
	// Version
	binary.LittleEndian.PutUint32(header[0:4], job.Version)
	
	// Previous block hash
	copy(header[4:36], job.PrevHash)
	
	// Merkle root (calculated from coinbase + merkle tree)
	merkleRoot := s.calculateMerkleRoot(job, extraNonce1, extraNonce2)
	copy(header[36:68], merkleRoot)
	
	// Timestamp
	binary.LittleEndian.PutUint32(header[68:72], share.Timestamp)
	
	// Bits
	binary.LittleEndian.PutUint32(header[72:76], job.Bits)
	
	// Nonce
	binary.LittleEndian.PutUint32(header[76:80], share.Nonce)
	
	return header
}

// calculateMerkleRoot calculates merkle root
func (s *StratumV2Server) calculateMerkleRoot(job *MiningJob, extraNonce1, extraNonce2 []byte) []byte {
	// Build coinbase transaction
	coinbase := append(job.Coinbase1, extraNonce1...)
	coinbase = append(coinbase, extraNonce2...)
	coinbase = append(coinbase, job.Coinbase2...)
	
	// Hash coinbase
	hash := sha256.Sum256(coinbase)
	hash = sha256.Sum256(hash[:])
	
	// Calculate merkle root using merkle tree
	current := hash[:]
	for _, branch := range job.MerkleTree {
		combined := append(current, branch...)
		hash = sha256.Sum256(combined)
		hash = sha256.Sum256(hash[:])
		current = hash[:]
	}
	
	return current
}

// checkTarget checks if hash meets target
func (s *StratumV2Server) checkTarget(hash []byte, target []byte) bool {
	// Compare hash against target (big-endian)
	for i := 31; i >= 0; i-- {
		if hash[i] > target[i] {
			return false
		} else if hash[i] < target[i] {
			return true
		}
	}
	return true
}

// isBlock checks if share is a block
func (s *StratumV2Server) isBlock(share *shareData) bool {
	// Check against network difficulty
	// This would be implemented based on current network target
	return false
}

// jobUpdater updates mining jobs
func (s *StratumV2Server) jobUpdater() {
	defer s.wg.Done()
	
	ticker := time.NewTicker(s.config.JobUpdateInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			s.updateJobs()
			
		case <-s.ctx.Done():
			return
		}
	}
}

// updateJobs updates jobs for all clients
func (s *StratumV2Server) updateJobs() {
	// Generate new job template
	s.jobTemplate = s.generateJobTemplate()
	
	// Send to all clients
	s.clientsMu.RLock()
	for _, client := range s.clients {
		if client.subscribed {
			job := s.createMiningJob(client)
			client.currentJob.Store(job)
			go s.sendMiningJob(client, job)
		}
	}
	s.clientsMu.RUnlock()
}

// generateJobTemplate generates a new job template
func (s *StratumV2Server) generateJobTemplate() *JobTemplate {
	jobID := s.jobCounter.Add(1)
	
	// Generate placeholder values
	prevHash := make([]byte, 32)
	rand.Read(prevHash)
	
	return &JobTemplate{
		JobID:    uint32(jobID),
		PrevHash: prevHash,
		Version:  0x20000000,
		Bits:     0x1d00ffff,
		Timestamp: uint32(time.Now().Unix()),
	}
}

// createMiningJob creates a mining job for a client
func (s *StratumV2Server) createMiningJob(client *StratumV2Client) *MiningJob {
	template := s.jobTemplate
	
	return &MiningJob{
		JobID:     template.JobID,
		PrevHash:  template.PrevHash,
		Coinbase1: []byte{0x01, 0x00, 0x00, 0x00}, // Placeholder
		Coinbase2: []byte{0xff, 0xff, 0xff, 0xff}, // Placeholder
		MerkleTree: [][]byte{}, // Placeholder
		Version:   template.Version,
		Bits:      template.Bits,
		Timestamp: template.Timestamp,
		CleanJobs: true,
		Target:    generateTarget(client.difficulty.Load().(float64)),
	}
}

// sendMiningJob sends a mining job to a client
func (s *StratumV2Server) sendMiningJob(client *StratumV2Client, job *MiningJob) {
	payload := map[string]interface{}{
		"channel_id":  1,
		"job_id":      job.JobID,
		"prev_hash":   hex.EncodeToString(job.PrevHash),
		"coinbase1":   hex.EncodeToString(job.Coinbase1),
		"coinbase2":   hex.EncodeToString(job.Coinbase2),
		"merkle_tree": job.MerkleTree,
		"version":     job.Version,
		"bits":        job.Bits,
		"timestamp":   job.Timestamp,
		"clean_jobs":  job.CleanJobs,
	}
	
	s.sendNotification(client, NewMiningJob, payload)
}

// clientCleaner removes inactive clients
func (s *StratumV2Server) clientCleaner() {
	defer s.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			s.cleanInactiveClients()
			
		case <-s.ctx.Done():
			return
		}
	}
}

// cleanInactiveClients removes inactive clients
func (s *StratumV2Server) cleanInactiveClients() {
	now := time.Now()
	timeout := s.config.ClientTimeout
	
	s.clientsMu.Lock()
	defer s.clientsMu.Unlock()
	
	for id, client := range s.clients {
		lastActivity := client.lastActivity.Load().(time.Time)
		if now.Sub(lastActivity) > timeout {
			client.Close()
			delete(s.clients, id)
			s.activeClients.Add(-1)
		}
	}
}

// removeClient removes a client
func (s *StratumV2Server) removeClient(clientID string) {
	s.clientsMu.Lock()
	defer s.clientsMu.Unlock()
	
	if _, exists := s.clients[clientID]; exists {
		delete(s.clients, clientID)
		s.activeClients.Add(-1)
	}
}

// sendResponse sends a response message
func (s *StratumV2Server) sendResponse(client *StratumV2Client, msgType MessageType, requestID uint32, data interface{}) error {
	payload, err := json.Marshal(data)
	if err != nil {
		return err
	}
	
	message := &V2Message{
		MessageType: msgType,
		RequestID:   requestID,
		Payload:     payload,
	}
	
	select {
	case client.sendChan <- message:
		return nil
	default:
		return errors.New("send buffer full")
	}
}

// sendNotification sends a notification message
func (s *StratumV2Server) sendNotification(client *StratumV2Client, msgType MessageType, data interface{}) {
	payload, err := json.Marshal(data)
	if err != nil {
		return
	}
	
	message := &V2Message{
		MessageType: msgType,
		RequestID:   0, // Notifications have no request ID
		Payload:     payload,
	}
	
	select {
	case client.sendChan <- message:
	default:
		// Drop if buffer full
	}
}

// sendSetupError sends setup error
func (s *StratumV2Server) sendSetupError(client *StratumV2Client, requestID uint32, errorCode string) error {
	data := map[string]interface{}{
		"error_code": errorCode,
		"error_msg":  "Setup connection failed",
	}
	return s.sendResponse(client, SetupConnectionError, requestID, data)
}

// sendChannelError sends channel error
func (s *StratumV2Server) sendChannelError(client *StratumV2Client, requestID uint32, errorCode string) error {
	data := map[string]interface{}{
		"error_code": errorCode,
		"error_msg":  "Channel open failed",
	}
	return s.sendResponse(client, OpenStandardMiningChannelError, requestID, data)
}

// sendShareError sends share error
func (s *StratumV2Server) sendShareError(client *StratumV2Client, requestID uint32, errorCode string) error {
	data := map[string]interface{}{
		"error_code": errorCode,
		"error_msg":  "Share submission failed",
	}
	return s.sendResponse(client, SubmitSharesError, requestID, data)
}

// Close closes the client connection
func (c *StratumV2Client) Close() {
	c.cancel()
	if c.conn != nil {
		c.conn.Close()
	}
}

// messageSender handles sending messages to client
func (c *StratumV2Client) messageSender() {
	for {
		select {
		case message := <-c.sendChan:
			if err := c.encoder.EncodeMessage(message); err != nil {
				return
			}
			
		case <-c.ctx.Done():
			return
		}
	}
}

// NewMessageEncoder creates a message encoder
func NewMessageEncoder(writer io.Writer) *MessageEncoder {
	return &MessageEncoder{writer: writer}
}

// EncodeMessage encodes a message
func (e *MessageEncoder) EncodeMessage(message *V2Message) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	
	// Calculate message length
	payloadLen := len(message.Payload)
	totalLen := 6 + payloadLen // header + payload
	
	// Write message length
	if err := binary.Write(e.writer, binary.LittleEndian, uint16(totalLen)); err != nil {
		return err
	}
	
	// Write message type
	if err := binary.Write(e.writer, binary.LittleEndian, message.MessageType); err != nil {
		return err
	}
	
	// Write request ID
	if err := binary.Write(e.writer, binary.LittleEndian, message.RequestID); err != nil {
		return err
	}
	
	// Write reserved byte
	if err := binary.Write(e.writer, binary.LittleEndian, uint8(0)); err != nil {
		return err
	}
	
	// Write payload
	_, err := e.writer.Write(message.Payload)
	return err
}

// NewMessageDecoder creates a message decoder
func NewMessageDecoder(reader io.Reader) *MessageDecoder {
	return &MessageDecoder{
		reader: reader,
		buffer: make([]byte, 4096),
	}
}

// DecodeMessage decodes a message
func (d *MessageDecoder) DecodeMessage() (*V2Message, error) {
	// Read message length
	var length uint16
	if err := binary.Read(d.reader, binary.LittleEndian, &length); err != nil {
		return nil, err
	}
	
	if length < 6 {
		return nil, errors.New("invalid message length")
	}
	
	// Read message type
	var msgType MessageType
	if err := binary.Read(d.reader, binary.LittleEndian, &msgType); err != nil {
		return nil, err
	}
	
	// Read request ID
	var requestID uint32
	if err := binary.Read(d.reader, binary.LittleEndian, &requestID); err != nil {
		return nil, err
	}
	
	// Read reserved byte
	var reserved uint8
	if err := binary.Read(d.reader, binary.LittleEndian, &reserved); err != nil {
		return nil, err
	}
	
	// Read payload
	payloadLen := int(length) - 6
	payload := make([]byte, payloadLen)
	if _, err := io.ReadFull(d.reader, payload); err != nil {
		return nil, err
	}
	
	return &V2Message{
		MessageType: msgType,
		RequestID:   requestID,
		Payload:     payload,
	}, nil
}

// generateTarget generates target from difficulty
func generateTarget(difficulty float64) []byte {
	target := make([]byte, 32)
	
	// Calculate target = max_target / difficulty
	// This is simplified - production code would use proper big number arithmetic
	maxTarget := make([]byte, 32)
	for i := range maxTarget {
		maxTarget[i] = 0xff
	}
	
	// Simple approximation
	scale := 1.0 / difficulty
	for i := 0; i < 4; i++ {
		target[28+i] = byte(uint32(scale) >> (8 * i))
	}
	
	return target
}

// generateClientID generates a unique client ID
func generateClientID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// GetStatistics returns server statistics
func (s *StratumV2Server) GetStatistics() map[string]interface{} {
	stats := make(map[string]interface{})
	
	stats["total_connections"] = s.totalConnections.Load()
	stats["active_clients"] = s.activeClients.Load()
	stats["total_shares"] = s.totalShares.Load()
	stats["valid_shares"] = s.validShares.Load()
	
	if total := s.totalShares.Load(); total > 0 {
		stats["share_acceptance_rate"] = float64(s.validShares.Load()) / float64(total) * 100
	} else {
		stats["share_acceptance_rate"] = 0.0
	}
	
	return stats
}