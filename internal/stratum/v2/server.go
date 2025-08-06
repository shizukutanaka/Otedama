package v2

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// Server implements Stratum v2 server
// John Carmack's performance-first design with Robert C. Martin's clean architecture
type Server struct {
	logger *zap.Logger
	config ServerConfig
	
	// Protocol handler
	protocol *ProtocolHandler
	
	// Connection management
	listener    net.Listener
	connections sync.Map // map[uint32]*Connection
	connID      atomic.Uint32
	
	// Channel management
	channels    sync.Map // map[uint32]*MiningChannel
	channelID   atomic.Uint32
	
	// Job management
	jobManager  *JobManager
	
	// Statistics
	stats       ServerStats
	
	// Callbacks
	onNewShare  func(*Share) error
	onNewBlock  func(*Block) error
	
	// Lifecycle
	ctx         context.Context
	cancel      context.CancelFunc
	wg          sync.WaitGroup
}

// ServerConfig contains server configuration
type ServerConfig struct {
	// Network
	ListenAddr      string        `json:"listen_addr"`
	EnableTLS       bool          `json:"enable_tls"`
	TLSCert         string        `json:"tls_cert"`
	TLSKey          string        `json:"tls_key"`
	
	// Protocol
	MinProtocolVersion uint16     `json:"min_protocol_version"`
	MaxProtocolVersion uint16     `json:"max_protocol_version"`
	
	// Mining
	DefaultDifficulty  float64    `json:"default_difficulty"`
	MinDifficulty      float64    `json:"min_difficulty"`
	MaxDifficulty      float64    `json:"max_difficulty"`
	VarDiffEnabled     bool       `json:"vardiff_enabled"`
	VarDiffTargetTime  time.Duration `json:"vardiff_target_time"`
	
	// Limits
	MaxConnections     int        `json:"max_connections"`
	MaxChannelsPerConn int        `json:"max_channels_per_conn"`
	ConnectionTimeout  time.Duration `json:"connection_timeout"`
	
	// Performance
	JobCacheSize       int        `json:"job_cache_size"`
	ShareBufferSize    int        `json:"share_buffer_size"`
}

// Connection represents a client connection
type Connection struct {
	id          uint32
	conn        net.Conn
	server      *Server
	
	// Protocol state
	version     uint16
	flags       uint32
	
	// Channels
	channels    map[uint32]*MiningChannel
	channelsMu  sync.RWMutex
	
	// IO
	reader      *FrameReader
	writer      *FrameWriter
	
	// Stats
	connected   time.Time
	lastSeen    time.Time
	shares      atomic.Uint64
	
	// Lifecycle
	ctx         context.Context
	cancel      context.CancelFunc
}

// MiningChannel represents a mining channel
type MiningChannel struct {
	id               uint32
	connection       *Connection
	userIdentity     string
	nominalHashRate  float32
	currentTarget    [32]byte
	extranoncePrefix []byte
	
	// Job tracking
	activeJobs       map[uint32]*MiningJob
	jobsMu           sync.RWMutex
	
	// Share tracking
	shareSequence    atomic.Uint32
	validShares      atomic.Uint64
	invalidShares    atomic.Uint64
	
	// Difficulty adjustment
	lastShareTime    time.Time
	shareTimeBuffer  []time.Duration
	difficulty       float64
}

// MiningJob represents an active mining job
type MiningJob struct {
	ID             uint32
	ChannelID      uint32
	Version        uint32
	PrevHash       [32]byte
	MerkleRoot     [32]byte
	Timestamp      uint32
	Bits           uint32
	Target         [32]byte
	Created        time.Time
}

// Share represents a submitted share
type Share struct {
	ChannelID      uint32
	JobID          uint32
	Nonce          uint32
	NTime          uint32
	Version        uint32
	Hash           [32]byte
	Difficulty     float64
	SubmittedAt    time.Time
}

// Block represents a found block
type Block struct {
	Share
	Height         uint64
	Reward         uint64
}

// ServerStats tracks server statistics
type ServerStats struct {
	StartTime         time.Time
	TotalConnections  atomic.Uint64
	ActiveConnections atomic.Int32
	TotalChannels     atomic.Uint64
	ActiveChannels    atomic.Int32
	TotalShares       atomic.Uint64
	ValidShares       atomic.Uint64
	InvalidShares     atomic.Uint64
	BlocksFound       atomic.Uint64
	NetworkHashRate   atomic.Uint64
}

// NewServer creates a new Stratum v2 server
func NewServer(logger *zap.Logger, config ServerConfig) *Server {
	ctx, cancel := context.WithCancel(context.Background())
	
	return &Server{
		logger:     logger,
		config:     config,
		protocol:   NewProtocolHandler(),
		jobManager: NewJobManager(logger),
		ctx:        ctx,
		cancel:     cancel,
		stats: ServerStats{
			StartTime: time.Now(),
		},
	}
}

// Start starts the server
func (s *Server) Start() error {
	// Create listener
	var listener net.Listener
	var err error
	
	if s.config.EnableTLS {
		cert, err := tls.LoadX509KeyPair(s.config.TLSCert, s.config.TLSKey)
		if err != nil {
			return fmt.Errorf("failed to load TLS cert: %w", err)
		}
		
		tlsConfig := &tls.Config{
			Certificates: []tls.Certificate{cert},
			MinVersion:   tls.VersionTLS12,
		}
		
		listener, err = tls.Listen("tcp", s.config.ListenAddr, tlsConfig)
	} else {
		listener, err = net.Listen("tcp", s.config.ListenAddr)
	}
	
	if err != nil {
		return fmt.Errorf("failed to listen: %w", err)
	}
	
	s.listener = listener
	
	// Start job manager
	s.jobManager.Start(s.ctx)
	
	// Start accept loop
	s.wg.Add(1)
	go s.acceptLoop()
	
	// Start maintenance
	s.wg.Add(1)
	go s.maintenanceLoop()
	
	s.logger.Info("Stratum v2 server started",
		zap.String("address", s.config.ListenAddr),
		zap.Bool("tls", s.config.EnableTLS),
	)
	
	return nil
}

// Stop stops the server
func (s *Server) Stop() error {
	s.cancel()
	
	if s.listener != nil {
		s.listener.Close()
	}
	
	// Close all connections
	s.connections.Range(func(key, value interface{}) bool {
		conn := value.(*Connection)
		conn.Close()
		return true
	})
	
	s.wg.Wait()
	
	s.logger.Info("Stratum v2 server stopped")
	return nil
}

// acceptLoop accepts new connections
func (s *Server) acceptLoop() {
	defer s.wg.Done()
	
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			select {
			case <-s.ctx.Done():
				return
			default:
				s.logger.Error("Accept error", zap.Error(err))
				continue
			}
		}
		
		// Check connection limit
		if s.stats.ActiveConnections.Load() >= int32(s.config.MaxConnections) {
			conn.Close()
			continue
		}
		
		// Handle connection
		s.wg.Add(1)
		go s.handleConnection(conn)
	}
}

// handleConnection handles a client connection
func (s *Server) handleConnection(netConn net.Conn) {
	defer s.wg.Done()
	
	// Create connection
	connID := s.connID.Add(1)
	ctx, cancel := context.WithCancel(s.ctx)
	
	conn := &Connection{
		id:        connID,
		conn:      netConn,
		server:    s,
		channels:  make(map[uint32]*MiningChannel),
		reader:    NewFrameReader(netConn),
		writer:    NewFrameWriter(netConn),
		connected: time.Now(),
		lastSeen:  time.Now(),
		ctx:       ctx,
		cancel:    cancel,
	}
	
	// Track connection
	s.connections.Store(connID, conn)
	s.stats.TotalConnections.Add(1)
	s.stats.ActiveConnections.Add(1)
	
	// Set connection timeout
	if s.config.ConnectionTimeout > 0 {
		netConn.SetDeadline(time.Now().Add(s.config.ConnectionTimeout))
	}
	
	s.logger.Info("New connection",
		zap.Uint32("conn_id", connID),
		zap.String("remote", netConn.RemoteAddr().String()),
	)
	
	// Handle connection
	conn.Handle()
	
	// Cleanup
	s.connections.Delete(connID)
	s.stats.ActiveConnections.Add(-1)
}

// Connection methods

// Handle handles the connection
func (c *Connection) Handle() {
	defer c.Close()
	
	// Read setup connection message
	frame, err := c.reader.ReadFrame()
	if err != nil {
		c.server.logger.Error("Failed to read setup frame", zap.Error(err))
		return
	}
	
	if frame.Header.MessageType != MsgSetupConnection {
		c.server.logger.Error("Expected setup connection message")
		return
	}
	
	// Parse setup message
	var setup SetupConnection
	if err := c.parseMessage(frame.Payload, &setup); err != nil {
		c.server.logger.Error("Failed to parse setup message", zap.Error(err))
		return
	}
	
	// Validate version
	if setup.MaxVersion < c.server.config.MinProtocolVersion ||
		setup.MinVersion > c.server.config.MaxProtocolVersion {
		c.sendSetupError("Unsupported protocol version")
		return
	}
	
	// Choose version
	c.version = setup.MaxVersion
	if c.version > c.server.config.MaxProtocolVersion {
		c.version = c.server.config.MaxProtocolVersion
	}
	
	c.flags = setup.Flags
	
	// Send success response
	response := SetupConnectionSuccess{
		UsedVersion: c.version,
		Flags:       c.flags,
	}
	
	if err := c.sendMessage(MsgSetupConnectionSuccess, response); err != nil {
		c.server.logger.Error("Failed to send setup response", zap.Error(err))
		return
	}
	
	// Main message loop
	for {
		// Update deadline
		if c.server.config.ConnectionTimeout > 0 {
			c.conn.SetDeadline(time.Now().Add(c.server.config.ConnectionTimeout))
		}
		
		// Read frame
		frame, err := c.reader.ReadFrame()
		if err != nil {
			if !errors.Is(err, net.ErrClosed) {
				c.server.logger.Error("Read error", zap.Error(err))
			}
			return
		}
		
		c.lastSeen = time.Now()
		
		// Handle message
		if err := c.handleMessage(frame); err != nil {
			c.server.logger.Error("Message handling error",
				zap.Error(err),
				zap.Uint8("msg_type", uint8(frame.Header.MessageType)),
			)
		}
	}
}

// handleMessage handles a protocol message
func (c *Connection) handleMessage(frame *Frame) error {
	switch frame.Header.MessageType {
	case MsgOpenStandardMiningChannel:
		return c.handleOpenChannel(frame.Payload)
		
	case MsgSubmitSharesStandard:
		return c.handleSubmitShare(frame.Payload)
		
	case MsgCloseChannel:
		return c.handleCloseChannel(frame.Payload)
		
	default:
		return fmt.Errorf("unknown message type: %d", frame.Header.MessageType)
	}
}

// handleOpenChannel handles channel open request
func (c *Connection) handleOpenChannel(payload []byte) error {
	var req OpenStandardMiningChannel
	if err := c.parseMessage(payload, &req); err != nil {
		return err
	}
	
	// Check channel limit
	c.channelsMu.RLock()
	channelCount := len(c.channels)
	c.channelsMu.RUnlock()
	
	if channelCount >= c.server.config.MaxChannelsPerConn {
		return c.sendOpenChannelError(req.RequestID, "Too many channels")
	}
	
	// Create channel
	channelID := c.server.channelID.Add(1)
	channel := &MiningChannel{
		id:               channelID,
		connection:       c,
		userIdentity:     req.UserIdentity,
		nominalHashRate:  req.NominalHashRate,
		currentTarget:    DifficultyToTarget(c.server.config.DefaultDifficulty),
		extranoncePrefix: GenerateExtranoncePrefix(4),
		activeJobs:       make(map[uint32]*MiningJob),
		difficulty:       c.server.config.DefaultDifficulty,
	}
	
	// Track channel
	c.channelsMu.Lock()
	c.channels[channelID] = channel
	c.channelsMu.Unlock()
	
	c.server.channels.Store(channelID, channel)
	c.server.stats.TotalChannels.Add(1)
	c.server.stats.ActiveChannels.Add(1)
	
	// Send response
	resp := OpenMiningChannelSuccess{
		RequestID:        req.RequestID,
		ChannelID:        channelID,
		Target:           channel.currentTarget,
		ExtranoncePrefix: channel.extranoncePrefix,
		GroupChannelID:   0, // Not using grouped channels
	}
	
	if err := c.sendMessage(MsgOpenMiningChannelSuccess, resp); err != nil {
		return err
	}
	
	// Send initial job
	c.server.jobManager.SendJobToChannel(channel)
	
	return nil
}

// handleSubmitShare handles share submission
func (c *Connection) handleSubmitShare(payload []byte) error {
	var req SubmitSharesStandard
	if err := c.parseMessage(payload, &req); err != nil {
		return err
	}
	
	// Get channel
	c.channelsMu.RLock()
	channel, ok := c.channels[req.ChannelID]
	c.channelsMu.RUnlock()
	
	if !ok {
		return c.sendSubmitShareError(req.Sequence, "Invalid channel")
	}
	
	// Get job
	channel.jobsMu.RLock()
	job, ok := channel.activeJobs[req.JobID]
	channel.jobsMu.RUnlock()
	
	if !ok {
		channel.invalidShares.Add(1)
		return c.sendSubmitShareError(req.Sequence, "Invalid job")
	}
	
	// Validate share
	share := &Share{
		ChannelID:   req.ChannelID,
		JobID:       req.JobID,
		Nonce:       req.Nonce,
		NTime:       req.NTime,
		Version:     req.Version,
		Difficulty:  channel.difficulty,
		SubmittedAt: time.Now(),
	}
	
	if err := ValidateShare(&req, &NewMiningJob{
		JobID:      job.ID,
		Version:    job.Version,
		PrevHash:   job.PrevHash,
		MerkleRoot: job.MerkleRoot,
	}, channel.currentTarget); err != nil {
		channel.invalidShares.Add(1)
		c.server.stats.InvalidShares.Add(1)
		return c.sendSubmitShareError(req.Sequence, err.Error())
	}
	
	// Update stats
	channel.validShares.Add(1)
	c.server.stats.TotalShares.Add(1)
	c.server.stats.ValidShares.Add(1)
	c.shares.Add(1)
	
	// Update difficulty if needed
	if c.server.config.VarDiffEnabled {
		channel.adjustDifficulty()
	}
	
	// Callback
	if c.server.onNewShare != nil {
		c.server.onNewShare(share)
	}
	
	// Send success
	return c.sendSubmitShareSuccess(req.Sequence)
}

// Helper methods

func (c *Connection) sendMessage(msgType MessageType, msg interface{}) error {
	payload, err := c.server.protocol.encodeMessage(msg)
	if err != nil {
		return err
	}
	
	frame := &Frame{
		Header: FrameHeader{
			MessageType:   msgType,
			MessageLength: uint32(len(payload)),
		},
		Payload: payload,
	}
	
	return c.writer.WriteFrame(frame)
}

func (c *Connection) parseMessage(payload []byte, msg interface{}) error {
	// In production, use proper binary protocol parsing
	// This is simplified for demonstration
	return nil
}

func (c *Connection) Close() error {
	c.cancel()
	
	// Close all channels
	c.channelsMu.Lock()
	for id, channel := range c.channels {
		c.server.channels.Delete(id)
		c.server.stats.ActiveChannels.Add(-1)
		_ = channel
	}
	c.channels = nil
	c.channelsMu.Unlock()
	
	return c.conn.Close()
}

// Error response helpers

func (c *Connection) sendSetupError(reason string) error {
	// Send setup error message
	return nil
}

func (c *Connection) sendOpenChannelError(requestID uint32, reason string) error {
	// Send open channel error
	return nil
}

func (c *Connection) sendSubmitShareError(sequence uint32, reason string) error {
	// Send submit share error
	return nil
}

func (c *Connection) sendSubmitShareSuccess(sequence uint32) error {
	// Send submit share success
	return nil
}

// MiningChannel methods

func (ch *MiningChannel) adjustDifficulty() {
	// Implement difficulty adjustment algorithm
	// Based on share submission rate
}

// Maintenance

func (s *Server) maintenanceLoop() {
	defer s.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			s.performMaintenance()
		case <-s.ctx.Done():
			return
		}
	}
}

func (s *Server) performMaintenance() {
	// Clean up stale connections
	var stale []uint32
	
	s.connections.Range(func(key, value interface{}) bool {
		conn := value.(*Connection)
		if time.Since(conn.lastSeen) > s.config.ConnectionTimeout*2 {
			stale = append(stale, key.(uint32))
		}
		return true
	})
	
	for _, id := range stale {
		if conn, ok := s.connections.Load(id); ok {
			conn.(*Connection).Close()
		}
	}
	
	// Log statistics
	s.logger.Info("Server statistics",
		zap.Int32("active_connections", s.stats.ActiveConnections.Load()),
		zap.Int32("active_channels", s.stats.ActiveChannels.Load()),
		zap.Uint64("total_shares", s.stats.TotalShares.Load()),
		zap.Uint64("valid_shares", s.stats.ValidShares.Load()),
	)
}

// GetStats returns server statistics
func (s *Server) GetStats() ServerStats {
	return s.stats
}

// SetShareCallback sets the share callback
func (s *Server) SetShareCallback(cb func(*Share) error) {
	s.onNewShare = cb
}

// SetBlockCallback sets the block callback
func (s *Server) SetBlockCallback(cb func(*Block) error) {
	s.onNewBlock = cb
}

// Protocol helpers

func (ph *ProtocolHandler) encodeMessage(msg interface{}) ([]byte, error) {
	// In production, use proper binary encoding
	// This is simplified for demonstration
	return nil, nil
}