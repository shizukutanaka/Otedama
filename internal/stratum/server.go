package stratum

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// Server defines the Stratum server interface - Robert C. Martin's interface segregation
type Server interface {
	Start() error
	Stop() error
	SetCallbacks(*Callbacks) error
	GetStats() *Stats
}

// Config contains Stratum server configuration
type Config struct {
	// Network settings
	Port           int           `validate:"min=1024,max=65535"`
	Host           string        `validate:"required"`
	MaxClients     int           `validate:"min=1,max=100000"`
	
	// Protocol settings
	StratumVersion string        `validate:"required"`
	EnableTLS      bool
	CertFile       string
	KeyFile        string
	
	// Mining settings
	Difficulty     float64       `validate:"min=0.001"`
	VarDiff        bool
	MinDifficulty  float64       `validate:"min=0.001"`
	MaxDifficulty  float64       `validate:"min=1"`
	TargetTime     time.Duration `validate:"min=1s,max=60s"`
	
	// Performance settings
	ReadTimeout    time.Duration `validate:"min=5s,max=300s"`
	WriteTimeout   time.Duration `validate:"min=1s,max=60s"`
	BufferSize     int           `validate:"min=1024,max=65536"`
	
	// Security settings
	RateLimit      int           `validate:"min=1,max=10000"`
	MaxMessageSize int           `validate:"min=1024,max=1048576"`
}

// Callbacks contains callback functions for Stratum events
type Callbacks struct {
	OnShare  func(*Share) error
	OnGetJob func() *Job
	OnAuth   func(string, string) error
}

// Message represents a Stratum message - optimized for JSON-RPC
type Message struct {
	ID     interface{} `json:"id"`
	Method string      `json:"method,omitempty"`
	Params interface{} `json:"params,omitempty"`
	Result interface{} `json:"result,omitempty"`
	Error  *Error      `json:"error,omitempty"`
}

// Error represents a Stratum error
type Error struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// Job represents a mining job - cache-aligned for performance
type Job struct {
	ID           string   `json:"id"`
	PrevHash     string   `json:"prevhash"`
	CoinbaseA    string   `json:"coinb1"`
	CoinbaseB    string   `json:"coinb2"`
	MerkleBranch []string `json:"merkle_branch"`
	Version      string   `json:"version"`
	NBits        string   `json:"nbits"`
	NTime        string   `json:"ntime"`
	CleanJobs    bool     `json:"clean_jobs"`
	
	// Internal fields
	Height       uint64    `json:"height,omitempty"`
	Target       string    `json:"target,omitempty"`
	Difficulty   float64   `json:"difficulty,omitempty"`
	CreatedAt    time.Time `json:"created_at,omitempty"`
}

// Share represents a submitted share - optimized for validation
type Share struct {
	JobID      string    `json:"job_id"`
	WorkerName string    `json:"worker_name"`
	Nonce      string    `json:"nonce"`
	Hash       string    `json:"hash,omitempty"`
	Difficulty float64   `json:"difficulty"`
	Timestamp  int64     `json:"timestamp"`
	
	// Validation results
	Valid      bool      `json:"valid,omitempty"`
	Reason     string    `json:"reason,omitempty"`
	IsBlock    bool      `json:"is_block,omitempty"`
}

// Client represents a connected Stratum client
type Client struct {
	ID         string    `json:"id"`
	RemoteAddr string    `json:"remote_addr"`
	WorkerName string    `json:"worker_name"`
	UserAgent  string    `json:"user_agent"`
	
	// Connection state - atomic for lock-free access
	Connected    atomic.Bool   `json:"connected"`
	Authorized   atomic.Bool   `json:"authorized"`
	ConnectedAt  time.Time     `json:"connected_at"`
	LastActivity atomic.Int64  `json:"last_activity"`
	
	// Statistics - atomic for performance
	SharesSubmitted atomic.Uint64 `json:"shares_submitted"`
	SharesAccepted  atomic.Uint64 `json:"shares_accepted"`
	SharesRejected  atomic.Uint64 `json:"shares_rejected"`
	CurrentHashRate atomic.Uint64 `json:"current_hash_rate"`
	
	// Variable difficulty
	Difficulty      atomic.Value  // stores float64
	LastDiffAdjust  atomic.Int64  // Unix timestamp
	
	// Connection
	conn         net.Conn      `json:"-"`
	reader       *bufio.Reader `json:"-"`
	writer       *bufio.Writer `json:"-"`
	
	// Synchronization
	writeMutex   sync.Mutex    `json:"-"`
	
	// Rate limiting
	messageCount atomic.Uint64 `json:"message_count"`
	lastReset    atomic.Int64  `json:"last_reset"`
}

// Stats contains Stratum server statistics - atomic for lock-free access
type Stats struct {
	// Connection statistics
	TotalConnections   atomic.Uint64 `json:"total_connections"`
	ActiveConnections  atomic.Int32  `json:"active_connections"`
	AuthorizedClients  atomic.Int32  `json:"authorized_clients"`
	
	// Share statistics
	TotalShares        atomic.Uint64 `json:"total_shares"`
	AcceptedShares     atomic.Uint64 `json:"accepted_shares"`
	RejectedShares     atomic.Uint64 `json:"rejected_shares"`
	BlocksFound        atomic.Uint64 `json:"blocks_found"`
	
	// Job statistics
	JobsCreated        atomic.Uint64 `json:"jobs_created"`
	JobsDistributed    atomic.Uint64 `json:"jobs_distributed"`
	
	// Performance
	AvgResponseTime    atomic.Uint64 `json:"avg_response_time_ms"`
	NetworkHashRate    atomic.Uint64 `json:"network_hash_rate"`
	
	// Uptime
	StartTime          time.Time     `json:"start_time"`
}

// StratumServer implements high-performance Stratum server - John Carmack's optimization
type StratumServer struct {
	logger *zap.Logger
	config *Config
	
	// Core state - hot path optimization
	stats      *Stats
	running    atomic.Bool
	
	// Callbacks
	callbacks  *Callbacks
	
	// Client management - lock-free where possible
	clients    sync.Map // map[string]*Client
	clientCount atomic.Int32
	
	// Job management
	currentJob atomic.Value // stores *Job
	jobCounter atomic.Uint64
	
	// Network
	listener   net.Listener
	
	// Rate limiting
	rateLimiter *StratumRateLimiter
	
	// Lifecycle
	ctx        context.Context
	cancel     context.CancelFunc
	wg         sync.WaitGroup
}

// StratumRateLimiter implements rate limiting for Stratum connections
type StratumRateLimiter struct {
	maxRate    int
	clients    sync.Map // map[string]*ClientRateLimit
	logger     *zap.Logger
}

// ClientRateLimit tracks rate limiting per client
type ClientRateLimit struct {
	messageCount atomic.Uint64
	lastReset    atomic.Int64
	blocked      atomic.Bool
}

// NewServer creates new Stratum server - Rob Pike's clear constructor
func NewServer(logger *zap.Logger, config *Config) (Server, error) {
	if config == nil {
		config = DefaultConfig()
	}
	
	if err := validateConfig(config); err != nil {
		return nil, fmt.Errorf("invalid config: %w", err)
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	server := &StratumServer{
		logger:    logger,
		config:    config,
		stats:     &Stats{StartTime: time.Now()},
		ctx:       ctx,
		cancel:    cancel,
	}
	
	// Initialize rate limiter
	server.rateLimiter = &StratumRateLimiter{
		maxRate: config.RateLimit,
		logger:  logger.With(zap.String("component", "rate_limiter")),
	}
	
	// Initialize default job
	server.currentJob.Store(&Job{
		ID:        "default",
		CleanJobs: false,
		CreatedAt: time.Now(),
	})
	
	return server, nil
}

// Start starts the Stratum server
func (s *StratumServer) Start() error {
	if !s.running.CompareAndSwap(false, true) {
		return errors.New("server already running")
	}
	
	s.logger.Info("Starting Stratum server",
		zap.String("address", fmt.Sprintf("%s:%d", s.config.Host, s.config.Port)),
		zap.Int("max_clients", s.config.MaxClients),
		zap.Bool("var_diff", s.config.VarDiff),
	)
	
	// Start listener
	if err := s.startListener(); err != nil {
		s.running.Store(false)
		return fmt.Errorf("failed to start listener: %w", err)
	}
	
	// Start job broadcaster
	s.wg.Add(1)
	go s.jobBroadcaster()
	
	// Start statistics updater
	s.wg.Add(1)
	go s.statsUpdater()
	
	// Start client cleaner
	s.wg.Add(1)
	go s.clientCleaner()
	
	// Start difficulty adjuster if enabled
	if s.config.VarDiff {
		s.wg.Add(1)
		go s.difficultyAdjuster()
	}
	
	s.logger.Info("Stratum server started successfully")
	return nil
}

// Stop stops the Stratum server
func (s *StratumServer) Stop() error {
	if !s.running.CompareAndSwap(true, false) {
		return errors.New("server not running")
	}
	
	s.logger.Info("Stopping Stratum server")
	
	// Cancel context
	s.cancel()
	
	// Close listener
	if s.listener != nil {
		s.listener.Close()
	}
	
	// Close all client connections
	s.closeAllClients()
	
	// Wait for goroutines
	s.wg.Wait()
	
	s.logger.Info("Stratum server stopped")
	return nil
}

// SetCallbacks sets callback functions
func (s *StratumServer) SetCallbacks(callbacks *Callbacks) error {
	if callbacks == nil {
		return errors.New("callbacks cannot be nil")
	}
	
	s.callbacks = callbacks
	s.logger.Debug("Stratum callbacks set")
	return nil
}

// GetStats returns server statistics
func (s *StratumServer) GetStats() *Stats {
	stats := &Stats{
		StartTime: s.stats.StartTime,
	}
	
	// Copy atomic values
	stats.TotalConnections.Store(s.stats.TotalConnections.Load())
	stats.ActiveConnections.Store(s.clientCount.Load())
	stats.TotalShares.Store(s.stats.TotalShares.Load())
	stats.AcceptedShares.Store(s.stats.AcceptedShares.Load())
	stats.RejectedShares.Store(s.stats.RejectedShares.Load())
	stats.BlocksFound.Store(s.stats.BlocksFound.Load())
	stats.JobsCreated.Store(s.stats.JobsCreated.Load())
	stats.JobsDistributed.Store(s.stats.JobsDistributed.Load())
	stats.AvgResponseTime.Store(s.stats.AvgResponseTime.Load())
	stats.NetworkHashRate.Store(s.stats.NetworkHashRate.Load())
	
	// Count authorized clients
	var authorizedCount int32
	s.clients.Range(func(key, value interface{}) bool {
		client := value.(*Client)
		if client.Authorized.Load() {
			authorizedCount++
		}
		return true
	})
	stats.AuthorizedClients.Store(authorizedCount)
	
	return stats
}

// Private methods

func (s *StratumServer) startListener() error {
	addr := fmt.Sprintf("%s:%d", s.config.Host, s.config.Port)
	
	var listener net.Listener
	var err error
	
	if s.config.EnableTLS {
		// TLS listener would be implemented here
		return errors.New("TLS not implemented yet")
	} else {
		listener, err = net.Listen("tcp", addr)
		if err != nil {
			return fmt.Errorf("failed to listen on %s: %w", addr, err)
		}
	}
	
	s.listener = listener
	
	// Accept connections
	go s.acceptConnections()
	
	return nil
}

func (s *StratumServer) acceptConnections() {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			select {
			case <-s.ctx.Done():
				return
			default:
				s.logger.Error("Accept failed", zap.Error(err))
				continue
			}
		}
		
		// Check client limit
		if s.clientCount.Load() >= int32(s.config.MaxClients) {
			s.logger.Debug("Client limit reached, rejecting connection")
			conn.Close()
			continue
		}
		
		// Handle new client
		go s.handleClient(conn)
	}
}

func (s *StratumServer) handleClient(conn net.Conn) {
	defer conn.Close()
	
	// Set timeouts
	conn.SetReadDeadline(time.Now().Add(s.config.ReadTimeout))
	conn.SetWriteDeadline(time.Now().Add(s.config.WriteTimeout))
	
	// Create client
	client := &Client{
		ID:         generateClientID(),
		RemoteAddr: conn.RemoteAddr().String(),
		ConnectedAt: time.Now(),
		conn:       conn,
		reader:     bufio.NewReaderSize(conn, s.config.BufferSize),
		writer:     bufio.NewWriterSize(conn, s.config.BufferSize),
	}
	
	client.Connected.Store(true)
	client.LastActivity.Store(time.Now().Unix())
	client.Difficulty.Store(s.config.Difficulty)
	
	// Add to clients map
	s.clients.Store(client.ID, client)
	s.clientCount.Add(1)
	s.stats.TotalConnections.Add(1)
	
	s.logger.Debug("New client connected", 
		zap.String("client_id", client.ID),
		zap.String("remote_addr", client.RemoteAddr),
	)
	
	// Handle client messages
	s.clientMessageLoop(client)
	
	// Cleanup on disconnect
	s.clients.Delete(client.ID)
	s.clientCount.Add(-1)
	client.Connected.Store(false)
	
	s.logger.Debug("Client disconnected", zap.String("client_id", client.ID))
}

func (s *StratumServer) clientMessageLoop(client *Client) {
	for {
		select {
		case <-s.ctx.Done():
			return
		default:
		}
		
		// Read message
		message, err := s.readMessage(client)
		if err != nil {
			s.logger.Debug("Read message failed", 
				zap.String("client_id", client.ID),
				zap.Error(err),
			)
			return
		}
		
		// Rate limiting
		if !s.rateLimiter.Allow(client.ID) {
			s.logger.Debug("Client rate limited", zap.String("client_id", client.ID))
			continue
		}
		
		// Process message
		response := s.processMessage(client, message)
		
		// Send response if needed
		if response != nil {
			if err := s.sendMessage(client, response); err != nil {
				s.logger.Error("Send response failed", 
					zap.String("client_id", client.ID),
					zap.Error(err),
				)
				return
			}
		}
		
		// Update activity
		client.LastActivity.Store(time.Now().Unix())
	}
}

func (s *StratumServer) readMessage(client *Client) (*Message, error) {
	// Set read deadline
	if err := client.conn.SetReadDeadline(time.Now().Add(s.config.ReadTimeout)); err != nil {
		return nil, err
	}
	
	// Read line
	line, err := client.reader.ReadBytes('\n')
	if err != nil {
		return nil, err
	}
	
	// Check message size
	if len(line) > s.config.MaxMessageSize {
		return nil, fmt.Errorf("message too large: %d bytes", len(line))
	}
	
	// Parse JSON
	var message Message
	if err := json.Unmarshal(line, &message); err != nil {
		return nil, fmt.Errorf("invalid JSON: %w", err)
	}
	
	return &message, nil
}

func (s *StratumServer) sendMessage(client *Client, message *Message) error {
	// Serialize message
	data, err := json.Marshal(message)
	if err != nil {
		return err
	}
	
	// Add newline
	data = append(data, '\n')
	
	// Set write deadline
	if err := client.conn.SetWriteDeadline(time.Now().Add(s.config.WriteTimeout)); err != nil {
		return err
	}
	
	// Write with mutex protection
	client.writeMutex.Lock()
	defer client.writeMutex.Unlock()
	
	if _, err := client.writer.Write(data); err != nil {
		return err
	}
	
	return client.writer.Flush()
}

func (s *StratumServer) processMessage(client *Client, message *Message) *Message {
	start := time.Now()
	
	switch message.Method {
	case "mining.subscribe":
		return s.handleSubscribe(client, message)
	case "mining.authorize":
		return s.handleAuthorize(client, message)
	case "mining.submit":
		return s.handleSubmit(client, message)
	case "mining.suggest_difficulty":
		return s.handleSuggestDifficulty(client, message)
	default:
		return &Message{
			ID:    message.ID,
			Error: &Error{Code: -1, Message: "Unknown method"},
		}
	}
	
	// Update response time
	responseTime := time.Since(start)
	s.updateAvgResponseTime(responseTime)
}

func (s *StratumServer) handleSubscribe(client *Client, message *Message) *Message {
	// Extract subscription parameters
	params, ok := message.Params.([]interface{})
	if ok && len(params) > 0 {
		if userAgent, ok := params[0].(string); ok {
			client.UserAgent = userAgent
		}
	}
	
	// Send current mining job
	job := s.currentJob.Load().(*Job)
	s.sendJob(client, job, true)
	
	// Return subscription result
	return &Message{
		ID:     message.ID,
		Result: []interface{}{
			[]interface{}{
				[]interface{}{"mining.set_difficulty", client.ID},
				[]interface{}{"mining.notify", client.ID},
			},
			client.ID, // Extra nonce 1
			4,         // Extra nonce 2 size
		},
	}
}

func (s *StratumServer) handleAuthorize(client *Client, message *Message) *Message {
	params, ok := message.Params.([]interface{})
	if !ok || len(params) < 2 {
		return &Message{
			ID:    message.ID,
			Error: &Error{Code: -1, Message: "Invalid parameters"},
		}
	}
	
	username, ok1 := params[0].(string)
	password, ok2 := params[1].(string)
	
	if !ok1 || !ok2 {
		return &Message{
			ID:    message.ID,
			Error: &Error{Code: -1, Message: "Invalid parameters"},
		}
	}
	
	// Authenticate via callback
	var authError error
	if s.callbacks != nil && s.callbacks.OnAuth != nil {
		authError = s.callbacks.OnAuth(username, password)
	}
	
	if authError != nil {
		s.logger.Debug("Authorization failed", 
			zap.String("client_id", client.ID),
			zap.String("username", username),
			zap.Error(authError),
		)
		
		return &Message{
			ID:    message.ID,
			Error: &Error{Code: -1, Message: "Authorization failed"},
		}
	}
	
	// Authorization successful
	client.WorkerName = username
	client.Authorized.Store(true)
	
	s.logger.Debug("Client authorized", 
		zap.String("client_id", client.ID),
		zap.String("worker_name", username),
	)
	
	return &Message{
		ID:     message.ID,
		Result: true,
	}
}

func (s *StratumServer) handleSubmit(client *Client, message *Message) *Message {
	if !client.Authorized.Load() {
		return &Message{
			ID:    message.ID,
			Error: &Error{Code: -1, Message: "Not authorized"},
		}
	}
	
	params, ok := message.Params.([]interface{})
	if !ok || len(params) < 5 {
		return &Message{
			ID:    message.ID,
			Error: &Error{Code: -1, Message: "Invalid parameters"},
		}
	}
	
	// Extract share parameters
	workerName, _ := params[0].(string)
	jobID, _ := params[1].(string)
	nonce, _ := params[4].(string)
	
	// Create share
	share := &Share{
		JobID:      jobID,
		WorkerName: workerName,
		Nonce:      nonce,
		Difficulty: client.Difficulty.Load().(float64),
		Timestamp:  time.Now().Unix(),
	}
	
	// Submit share via callback
	var shareError error
	if s.callbacks != nil && s.callbacks.OnShare != nil {
		shareError = s.callbacks.OnShare(share)
	}
	
	client.SharesSubmitted.Add(1)
	s.stats.TotalShares.Add(1)
	
	if shareError != nil {
		client.SharesRejected.Add(1)
		s.stats.RejectedShares.Add(1)
		
		s.logger.Debug("Share rejected", 
			zap.String("client_id", client.ID),
			zap.String("reason", shareError.Error()),
		)
		
		return &Message{
			ID:    message.ID,
			Error: &Error{Code: -1, Message: shareError.Error()},
		}
	}
	
	client.SharesAccepted.Add(1)
	s.stats.AcceptedShares.Add(1)
	
	if share.IsBlock {
		s.stats.BlocksFound.Add(1)
		s.logger.Info("Block found!", 
			zap.String("client_id", client.ID),
			zap.String("worker", workerName),
		)
	}
	
	return &Message{
		ID:     message.ID,
		Result: true,
	}
}

func (s *StratumServer) handleSuggestDifficulty(client *Client, message *Message) *Message {
	params, ok := message.Params.([]interface{})
	if !ok || len(params) < 1 {
		return &Message{
			ID:    message.ID,
			Error: &Error{Code: -1, Message: "Invalid parameters"},
		}
	}
	
	difficulty, ok := params[0].(float64)
	if !ok {
		return &Message{
			ID:    message.ID,
			Error: &Error{Code: -1, Message: "Invalid difficulty"},
		}
	}
	
	// Validate difficulty range
	if difficulty < s.config.MinDifficulty {
		difficulty = s.config.MinDifficulty
	} else if difficulty > s.config.MaxDifficulty {
		difficulty = s.config.MaxDifficulty
	}
	
	// Update client difficulty
	client.Difficulty.Store(difficulty)
	client.LastDiffAdjust.Store(time.Now().Unix())
	
	// Send difficulty notification
	s.sendDifficulty(client, difficulty)
	
	return &Message{
		ID:     message.ID,
		Result: true,
	}
}

func (s *StratumServer) sendJob(client *Client, job *Job, cleanJobs bool) {
	notification := &Message{
		Method: "mining.notify",
		Params: []interface{}{
			job.ID,
			job.PrevHash,
			job.CoinbaseA,
			job.CoinbaseB,
			job.MerkleBranch,
			job.Version,
			job.NBits,
			job.NTime,
			cleanJobs,
		},
	}
	
	if err := s.sendMessage(client, notification); err != nil {
		s.logger.Error("Failed to send job", 
			zap.String("client_id", client.ID),
			zap.Error(err),
		)
	} else {
		s.stats.JobsDistributed.Add(1)
	}
}

func (s *StratumServer) sendDifficulty(client *Client, difficulty float64) {
	notification := &Message{
		Method: "mining.set_difficulty",
		Params: []interface{}{difficulty},
	}
	
	if err := s.sendMessage(client, notification); err != nil {
		s.logger.Error("Failed to send difficulty", 
			zap.String("client_id", client.ID),
			zap.Error(err),
		)
	}
}

func (s *StratumServer) jobBroadcaster() {
	defer s.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			s.broadcastNewJob()
		case <-s.ctx.Done():
			return
		}
	}
}

func (s *StratumServer) broadcastNewJob() {
	// Get new job from callback
	var job *Job
	if s.callbacks != nil && s.callbacks.OnGetJob != nil {
		job = s.callbacks.OnGetJob()
	}
	
	if job == nil {
		return
	}
	
	// Update current job
	s.currentJob.Store(job)
	s.stats.JobsCreated.Add(1)
	
	// Broadcast to all authorized clients
	s.clients.Range(func(key, value interface{}) bool {
		client := value.(*Client)
		if client.Authorized.Load() && client.Connected.Load() {
			s.sendJob(client, job, true)
		}
		return true
	})
	
	s.logger.Debug("Broadcasted new job", zap.String("job_id", job.ID))
}

func (s *StratumServer) statsUpdater() {
	defer s.wg.Done()
	
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			s.updateNetworkHashRate()
		case <-s.ctx.Done():
			return
		}
	}
}

func (s *StratumServer) updateNetworkHashRate() {
	var totalHashRate uint64
	
	s.clients.Range(func(key, value interface{}) bool {
		client := value.(*Client)
		if client.Authorized.Load() {
			hashRate := client.CurrentHashRate.Load()
			totalHashRate += hashRate
		}
		return true
	})
	
	s.stats.NetworkHashRate.Store(totalHashRate)
}

func (s *StratumServer) clientCleaner() {
	defer s.wg.Done()
	
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			s.cleanupStaleClients()
		case <-s.ctx.Done():
			return
		}
	}
}

func (s *StratumServer) cleanupStaleClients() {
	now := time.Now().Unix()
	staleThreshold := int64(300) // 5 minutes
	
	s.clients.Range(func(key, value interface{}) bool {
		client := value.(*Client)
		
		if now-client.LastActivity.Load() > staleThreshold {
			s.logger.Debug("Removing stale client", zap.String("client_id", client.ID))
			client.conn.Close()
		}
		
		return true
	})
}

func (s *StratumServer) difficultyAdjuster() {
	defer s.wg.Done()
	
	ticker := time.NewTicker(s.config.TargetTime)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			s.adjustDifficulties()
		case <-s.ctx.Done():
			return
		}
	}
}

func (s *StratumServer) adjustDifficulties() {
	now := time.Now().Unix()
	
	s.clients.Range(func(key, value interface{}) bool {
		client := value.(*Client)
		
		if !client.Authorized.Load() {
			return true
		}
		
		// Check if adjustment is needed
		lastAdjust := client.LastDiffAdjust.Load()
		if now-lastAdjust < int64(s.config.TargetTime.Seconds()*2) {
			return true // Too soon for adjustment
		}
		
		// Calculate new difficulty based on share rate
		currentDiff := client.Difficulty.Load().(float64)
		shareRate := calculateShareRate(client)
		
		targetRate := 1.0 / s.config.TargetTime.Seconds()
		newDiff := currentDiff * (shareRate / targetRate)
		
		// Clamp to limits
		if newDiff < s.config.MinDifficulty {
			newDiff = s.config.MinDifficulty
		} else if newDiff > s.config.MaxDifficulty {
			newDiff = s.config.MaxDifficulty
		}
		
		// Apply if significantly different
		if abs(newDiff-currentDiff)/currentDiff > 0.1 { // 10% threshold
			client.Difficulty.Store(newDiff)
			client.LastDiffAdjust.Store(now)
			s.sendDifficulty(client, newDiff)
			
			s.logger.Debug("Adjusted difficulty", 
				zap.String("client_id", client.ID),
				zap.Float64("old_diff", currentDiff),
				zap.Float64("new_diff", newDiff),
			)
		}
		
		return true
	})
}

func (s *StratumServer) closeAllClients() {
	s.clients.Range(func(key, value interface{}) bool {
		client := value.(*Client)
		client.conn.Close()
		return true
	})
}

func (s *StratumServer) updateAvgResponseTime(duration time.Duration) {
	ms := uint64(duration.Milliseconds())
	
	current := s.stats.AvgResponseTime.Load()
	if current == 0 {
		s.stats.AvgResponseTime.Store(ms)
	} else {
		// Exponential moving average
		newAvg := (current*9 + ms) / 10
		s.stats.AvgResponseTime.Store(newAvg)
	}
}

// Rate limiter implementation
func (rl *StratumRateLimiter) Allow(clientID string) bool {
	limit, _ := rl.clients.LoadOrStore(clientID, &ClientRateLimit{})
	clientLimit := limit.(*ClientRateLimit)
	
	now := time.Now().Unix()
	lastReset := clientLimit.lastReset.Load()
	
	// Reset counter every minute
	if now-lastReset > 60 {
		clientLimit.messageCount.Store(0)
		clientLimit.lastReset.Store(now)
		clientLimit.blocked.Store(false)
	}
	
	// Check rate limit
	count := clientLimit.messageCount.Add(1)
	if count > uint64(rl.maxRate) {
		clientLimit.blocked.Store(true)
		return false
	}
	
	return true
}

// Utility functions

func validateConfig(config *Config) error {
	if config.Port < 1024 || config.Port > 65535 {
		return errors.New("invalid port")
	}
	
	if config.MaxClients < 1 || config.MaxClients > 100000 {
		return errors.New("invalid max clients")
	}
	
	if config.Difficulty < 0.001 {
		return errors.New("invalid difficulty")
	}
	
	return nil
}

// DefaultConfig returns default Stratum configuration
func DefaultConfig() *Config {
	return &Config{
		Port:           3333,
		Host:           "0.0.0.0",
		MaxClients:     10000,
		StratumVersion: "EthereumStratum/1.0.0",
		EnableTLS:      false,
		Difficulty:     1.0,
		VarDiff:        true,
		MinDifficulty:  0.001,
		MaxDifficulty:  1000000.0,
		TargetTime:     15 * time.Second,
		ReadTimeout:    300 * time.Second,
		WriteTimeout:   30 * time.Second,
		BufferSize:     4096,
		RateLimit:      100,
		MaxMessageSize: 64 * 1024,
	}
}

func generateClientID() string {
	return fmt.Sprintf("client_%d", time.Now().UnixNano())
}

func calculateShareRate(client *Client) float64 {
	// Simplified share rate calculation
	shares := client.SharesSubmitted.Load()
	duration := time.Since(client.ConnectedAt).Seconds()
	
	if duration < 60 {
		return 0.1 // Default for new clients
	}
	
	return float64(shares) / duration
}

func abs(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}
