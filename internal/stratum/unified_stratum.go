package stratum

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shizukutanaka/Otedama/internal/config"
	"go.uber.org/zap"
)

// Protocol versions
const (
	StratumV1 = "stratum/1.0"
	StratumV2 = "stratum/2.0"
)

// Client represents a unified stratum client supporting V1 and V2
type Client struct {
	logger *zap.Logger
	config config.PoolConfig
	
	// Connection
	conn       net.Conn
	reader     *bufio.Reader
	writer     *bufio.Writer
	connected  atomic.Bool
	
	// Protocol
	version    string
	sessionID  string
	authorized bool
	
	// Mining
	extraNonce1 string
	extraNonce2Size int
	difficulty  float64
	target      *big.Int
	
	// Job management
	currentJob  *Job
	jobMu       sync.RWMutex
	submitChan  chan *Share
	
	// Callbacks
	onNewJob    func(*Job)
	onSubmit    func(*Share)
	
	// Lifecycle
	ctx        context.Context
	cancel     context.CancelFunc
	wg         sync.WaitGroup
}

// Server represents a unified stratum server supporting V1 and V2
type Server struct {
	logger *zap.Logger
	config config.StratumConfig
	
	// Network
	listener   net.Listener
	clients    map[string]*ClientConnection
	clientsMu  sync.RWMutex
	
	// Protocol
	version    string
	
	// Job management
	jobManager *JobManager
	difficulty *DifficultyManager
	
	// Mining
	currentJob *Job
	jobCounter uint64
	
	// Statistics
	stats      *ServerStats
	
	// Lifecycle
	running    atomic.Bool
	ctx        context.Context
	cancel     context.CancelFunc
	wg         sync.WaitGroup
}

// Job represents a mining job
type Job struct {
	ID            string    `json:"job_id"`
	PrevHash      string    `json:"prevhash"`
	CoinBase1     string    `json:"coinb1"`
	CoinBase2     string    `json:"coinb2"`
	MerkleBranch  []string  `json:"merkle_branch"`
	Version       string    `json:"version"`
	NBits         string    `json:"nbits"`
	NTime         string    `json:"ntime"`
	CleanJobs     bool      `json:"clean_jobs"`
	Target        *big.Int  `json:"-"`
	Difficulty    float64   `json:"-"`
	Height        uint64    `json:"-"`
	Algorithm     string    `json:"-"`
	CreatedAt     time.Time `json:"-"`
}

// Share represents a submitted share
type Share struct {
	WorkerID    string
	JobID       string
	Nonce       string
	NTime       string
	ExtraNonce2 string
	Hash        string
	Difficulty  float64
	Valid       bool
	SubmittedAt time.Time
}

// ClientConnection represents a connected client
type ClientConnection struct {
	ID           string
	WorkerName   string
	WalletAddr   string
	Conn         net.Conn
	Reader       *bufio.Reader
	Writer       *bufio.Writer
	Authorized   bool
	ExtraNonce1  string
	Difficulty   float64
	SubmitCount  uint64
	ValidShares  uint64
	StaleShares  uint64
	InvalidShares uint64
	ConnectedAt  time.Time
	LastSeen     time.Time
	UserAgent    string
	Version      string
}

// Message represents a stratum message
type Message struct {
	ID     interface{}     `json:"id"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result interface{}     `json:"result,omitempty"`
	Error  interface{}     `json:"error,omitempty"`
}

// JobManager manages mining jobs
type JobManager struct {
	jobs      map[string]*Job
	jobsMu    sync.RWMutex
	current   *Job
	counter   uint64
	logger    *zap.Logger
}

// DifficultyManager manages mining difficulty
type DifficultyManager struct {
	baseDiff     float64
	minDiff      float64
	maxDiff      float64
	targetTime   time.Duration
	adjustWindow int
	shareHistory map[string][]time.Time
	historyMu    sync.RWMutex
	logger       *zap.Logger
}

// ServerStats tracks server statistics
type ServerStats struct {
	ConnectedClients atomic.Int32
	TotalShares     atomic.Uint64
	ValidShares     atomic.Uint64
	InvalidShares   atomic.Uint64
	StaleShares     atomic.Uint64
	HashRate        atomic.Uint64
	StartTime       time.Time
}

// NewClient creates a new stratum client
func NewClient(logger *zap.Logger, config config.PoolConfig) (*Client, error) {
	ctx, cancel := context.WithCancel(context.Background())
	
	c := &Client{
		logger:     logger,
		config:     config,
		version:    StratumV1,
		submitChan: make(chan *Share, 100),
		ctx:        ctx,
		cancel:     cancel,
	}
	
	// Parse URL to determine protocol version
	if strings.Contains(config.URL, "stratum2") {
		c.version = StratumV2
	}
	
	return c, nil
}

// Connect connects to the stratum server
func (c *Client) Connect() error {
	// Parse URL
	address := c.config.URL
	address = strings.TrimPrefix(address, "stratum+tcp://")
	address = strings.TrimPrefix(address, "stratum2+tcp://")
	
	// Connect
	conn, err := net.DialTimeout("tcp", address, 30*time.Second)
	if err != nil {
		return fmt.Errorf("failed to connect: %w", err)
	}
	
	c.conn = conn
	c.reader = bufio.NewReader(conn)
	c.writer = bufio.NewWriter(conn)
	c.connected.Store(true)
	
	// Start workers
	c.wg.Add(2)
	go c.readWorker()
	go c.submitWorker()
	
	// Subscribe and authorize
	if err := c.subscribe(); err != nil {
		c.Disconnect()
		return err
	}
	
	if err := c.authorize(); err != nil {
		c.Disconnect()
		return err
	}
	
	c.logger.Info("Connected to stratum server",
		zap.String("url", c.config.URL),
	)
	
	return nil
}

// Disconnect disconnects from the stratum server
func (c *Client) Disconnect() {
	if !c.connected.CompareAndSwap(true, false) {
		return
	}
	
	c.cancel()
	
	if c.conn != nil {
		c.conn.Close()
	}
	
	c.wg.Wait()
	close(c.submitChan)
	
	c.logger.Info("Disconnected from stratum server")
}

// Reconnect reconnects with new configuration
func (c *Client) Reconnect(config config.PoolConfig) {
	c.Disconnect()
	c.config = config
	c.Connect()
}

// SubmitShare submits a share to the pool
func (c *Client) SubmitShare(share *Share) error {
	if !c.connected.Load() {
		return errors.New("not connected")
	}
	
	select {
	case c.submitChan <- share:
		return nil
	case <-c.ctx.Done():
		return errors.New("client shutting down")
	default:
		return errors.New("submit queue full")
	}
}

// GetCurrentJob returns the current mining job
func (c *Client) GetCurrentJob() *Job {
	c.jobMu.RLock()
	defer c.jobMu.RUnlock()
	return c.currentJob
}

// SetJobCallback sets the new job callback
func (c *Client) SetJobCallback(fn func(*Job)) {
	c.onNewJob = fn
}

// readWorker handles incoming messages
func (c *Client) readWorker() {
	defer c.wg.Done()
	
	for c.connected.Load() {
		line, err := c.reader.ReadString('\n')
		if err != nil {
			if err != io.EOF && c.connected.Load() {
				c.logger.Error("Read error", zap.Error(err))
			}
			break
		}
		
		var msg Message
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			c.logger.Error("Failed to parse message", zap.Error(err))
			continue
		}
		
		c.handleMessage(&msg)
	}
}

// submitWorker handles share submissions
func (c *Client) submitWorker() {
	defer c.wg.Done()
	
	for {
		select {
		case share := <-c.submitChan:
			if share != nil {
				c.submitShareInternal(share)
			}
		case <-c.ctx.Done():
			return
		}
	}
}

// handleMessage handles incoming stratum messages
func (c *Client) handleMessage(msg *Message) {
	// Handle notifications
	if msg.ID == nil && msg.Method != "" {
		switch msg.Method {
		case "mining.notify":
			c.handleMiningNotify(msg.Params)
		case "mining.set_difficulty":
			c.handleSetDifficulty(msg.Params)
		case "mining.set_extranonce":
			c.handleSetExtranonce(msg.Params)
		case "client.reconnect":
			c.handleReconnect(msg.Params)
		}
		return
	}
	
	// Handle responses
	if msg.Result != nil {
		c.logger.Debug("Received result", zap.Any("result", msg.Result))
	}
	
	if msg.Error != nil {
		c.logger.Error("Received error", zap.Any("error", msg.Error))
	}
}

// Protocol methods
func (c *Client) subscribe() error {
	msg := &Message{
		ID:     1,
		Method: "mining.subscribe",
		Params: json.RawMessage(`["` + c.config.WorkerName + `"]`),
	}
	
	return c.sendMessage(msg)
}

func (c *Client) authorize() error {
	params := []interface{}{
		c.config.WalletAddress + "." + c.config.WorkerName,
		c.config.Password,
	}
	
	paramsJSON, _ := json.Marshal(params)
	
	msg := &Message{
		ID:     2,
		Method: "mining.authorize",
		Params: paramsJSON,
	}
	
	return c.sendMessage(msg)
}

func (c *Client) submitShareInternal(share *Share) {
	params := []interface{}{
		c.config.WorkerName,
		share.JobID,
		share.ExtraNonce2,
		share.NTime,
		share.Nonce,
	}
	
	paramsJSON, _ := json.Marshal(params)
	
	msg := &Message{
		ID:     time.Now().Unix(),
		Method: "mining.submit",
		Params: paramsJSON,
	}
	
	if err := c.sendMessage(msg); err != nil {
		c.logger.Error("Failed to submit share", zap.Error(err))
	}
}

func (c *Client) sendMessage(msg *Message) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	
	if _, err := c.writer.Write(append(data, '\n')); err != nil {
		return err
	}
	
	return c.writer.Flush()
}

// Message handlers
func (c *Client) handleMiningNotify(params json.RawMessage) {
	var jobParams []interface{}
	if err := json.Unmarshal(params, &jobParams); err != nil {
		c.logger.Error("Failed to parse mining.notify", zap.Error(err))
		return
	}
	
	if len(jobParams) < 9 {
		c.logger.Error("Invalid mining.notify params")
		return
	}
	
	job := &Job{
		ID:           jobParams[0].(string),
		PrevHash:     jobParams[1].(string),
		CoinBase1:    jobParams[2].(string),
		CoinBase2:    jobParams[3].(string),
		Version:      jobParams[5].(string),
		NBits:        jobParams[6].(string),
		NTime:        jobParams[7].(string),
		CleanJobs:    jobParams[8].(bool),
		Difficulty:   c.difficulty,
		CreatedAt:    time.Now(),
	}
	
	// Parse merkle branch
	if branches, ok := jobParams[4].([]interface{}); ok {
		job.MerkleBranch = make([]string, len(branches))
		for i, branch := range branches {
			job.MerkleBranch[i] = branch.(string)
		}
	}
	
	c.jobMu.Lock()
	c.currentJob = job
	c.jobMu.Unlock()
	
	if c.onNewJob != nil {
		c.onNewJob(job)
	}
	
	c.logger.Info("New job received",
		zap.String("job_id", job.ID),
		zap.Bool("clean", job.CleanJobs))
}

func (c *Client) handleSetDifficulty(params json.RawMessage) {
	var diffParams []float64
	if err := json.Unmarshal(params, &diffParams); err != nil {
		c.logger.Error("Failed to parse set_difficulty", zap.Error(err))
		return
	}
	
	if len(diffParams) > 0 {
		c.difficulty = diffParams[0]
		c.logger.Info("Difficulty updated", zap.Float64("difficulty", c.difficulty))
	}
}

func (c *Client) handleSetExtranonce(params json.RawMessage) {
	var extraParams []string
	if err := json.Unmarshal(params, &extraParams); err != nil {
		c.logger.Error("Failed to parse set_extranonce", zap.Error(err))
		return
	}
	
	if len(extraParams) >= 2 {
		c.extraNonce1 = extraParams[0]
		fmt.Sscanf(extraParams[1], "%d", &c.extraNonce2Size)
		c.logger.Info("Extranonce updated",
			zap.String("extranonce1", c.extraNonce1),
			zap.Int("extranonce2_size", c.extraNonce2Size))
	}
}

func (c *Client) handleReconnect(params json.RawMessage) {
	c.logger.Info("Server requested reconnect")
	go func() {
		time.Sleep(5 * time.Second)
		c.Reconnect(c.config)
	}()
}

// NewServer creates a new stratum server
func NewServer(logger *zap.Logger, config config.StratumConfig) (*Server, error) {
	ctx, cancel := context.WithCancel(context.Background())
	
	s := &Server{
		logger:     logger,
		config:     config,
		version:    StratumV1,
		clients:    make(map[string]*ClientConnection),
		stats:      &ServerStats{StartTime: time.Now()},
		ctx:        ctx,
		cancel:     cancel,
	}
	
	// Initialize managers
	s.jobManager = &JobManager{
		jobs:   make(map[string]*Job),
		logger: logger,
	}
	
	s.difficulty = &DifficultyManager{
		baseDiff:     config.Difficulty,
		minDiff:      config.MinDifficulty,
		maxDiff:      config.MaxDifficulty,
		targetTime:   func() time.Duration { if config.TargetTime == 0 { return 15 * time.Second }; return config.TargetTime }(),
		adjustWindow: config.VarDiffWindow,
		shareHistory: make(map[string][]time.Time),
		logger:       logger,
	}
	
	return s, nil
}

// Start starts the stratum server
func (s *Server) Start() error {
	if !s.running.CompareAndSwap(false, true) {
		return errors.New("server already running")
	}
	
	listener, err := net.Listen("tcp", s.config.ListenAddr)
	if err != nil {
		return fmt.Errorf("failed to listen: %w", err)
	}
	
	s.listener = listener
	
	s.wg.Add(1)
	go s.acceptConnections()
	
	s.logger.Info("Stratum server started",
		zap.String("addr", s.config.ListenAddr),
	)
	
	return nil
}

// Stop stops the stratum server
func (s *Server) Stop() error {
	if !s.running.CompareAndSwap(true, false) {
		return errors.New("server not running")
	}
	
	s.cancel()
	
	if s.listener != nil {
		s.listener.Close()
	}
	
	// Disconnect all clients
	s.clientsMu.Lock()
	for _, client := range s.clients {
		client.Conn.Close()
	}
	s.clientsMu.Unlock()
	
	s.wg.Wait()
	
	s.logger.Info("Stratum server stopped")
	return nil
}

// acceptConnections accepts incoming connections
func (s *Server) acceptConnections() {
	defer s.wg.Done()
	
	for s.running.Load() {
		conn, err := s.listener.Accept()
		if err != nil {
			if s.running.Load() {
				s.logger.Error("Accept error", zap.Error(err))
			}
			continue
		}
		
		s.wg.Add(1)
		go s.handleClient(conn)
	}
}

// handleClient handles a client connection
func (s *Server) handleClient(conn net.Conn) {
	defer s.wg.Done()
	defer conn.Close()
	
	client := &ClientConnection{
		ID:          generateID(),
		Conn:        conn,
		Reader:      bufio.NewReader(conn),
		Writer:      bufio.NewWriter(conn),
		ConnectedAt: time.Now(),
		LastSeen:    time.Now(),
	}
	
	// Add client
	s.clientsMu.Lock()
	s.clients[client.ID] = client
	s.stats.ConnectedClients.Add(1)
	s.clientsMu.Unlock()
	
	// Remove client on disconnect
	defer func() {
		s.clientsMu.Lock()
		delete(s.clients, client.ID)
		s.stats.ConnectedClients.Add(-1)
		s.clientsMu.Unlock()
	}()
	
	s.logger.Info("Client connected",
		zap.String("id", client.ID),
		zap.String("addr", conn.RemoteAddr().String()))
	
	// Handle client messages
	for {
		line, err := client.Reader.ReadString('\n')
		if err != nil {
			if err != io.EOF {
				s.logger.Error("Read error", zap.Error(err))
			}
			break
		}
		
		var msg Message
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			s.logger.Error("Failed to parse message", zap.Error(err))
			continue
		}
		
		s.handleClientMessage(client, &msg)
		client.LastSeen = time.Now()
	}
	
	s.logger.Info("Client disconnected",
		zap.String("id", client.ID))
}

// handleClientMessage handles a message from a client
func (s *Server) handleClientMessage(client *ClientConnection, msg *Message) {
	switch msg.Method {
	case "mining.subscribe":
		s.handleSubscribe(client, msg)
	case "mining.authorize":
		s.handleAuthorize(client, msg)
	case "mining.submit":
		s.handleSubmit(client, msg)
	case "mining.get_transactions":
		s.handleGetTransactions(client, msg)
	case "mining.extranonce.subscribe":
		s.handleExtranonceSubscribe(client, msg)
	default:
		s.sendError(client, msg.ID, "Unknown method")
	}
}

// Protocol handlers
func (s *Server) handleSubscribe(client *ClientConnection, msg *Message) {
	// Generate extranonce1
	client.ExtraNonce1 = generateExtranonce1()
	
	// Send response
	result := []interface{}{
		[][]string{
			{"mining.set_difficulty", "1"},
			{"mining.notify", "1"},
		},
		client.ExtraNonce1,
		4, // extranonce2 size
	}
	
	s.sendResult(client, msg.ID, result)
	
	// Send initial difficulty
	s.sendDifficulty(client, s.difficulty.baseDiff)
	
	// Send current job
	if s.currentJob != nil {
		s.sendJob(client, s.currentJob, true)
	}
}

func (s *Server) handleAuthorize(client *ClientConnection, msg *Message) {
	var params []string
	if err := json.Unmarshal(msg.Params, &params); err != nil {
		s.sendError(client, msg.ID, "Invalid params")
		return
	}
	
	if len(params) < 1 {
		s.sendError(client, msg.ID, "Missing worker name")
		return
	}
	
	// Parse worker name and wallet
	parts := strings.Split(params[0], ".")
	if len(parts) > 0 {
		client.WalletAddr = parts[0]
		if len(parts) > 1 {
			client.WorkerName = parts[1]
		}
	}
	
	client.Authorized = true
	s.sendResult(client, msg.ID, true)
	
	s.logger.Info("Worker authorized",
		zap.String("worker", client.WorkerName),
		zap.String("wallet", client.WalletAddr))
}

func (s *Server) handleSubmit(client *ClientConnection, msg *Message) {
	if !client.Authorized {
		s.sendError(client, msg.ID, "Not authorized")
		return
	}
	
	var params []interface{}
	if err := json.Unmarshal(msg.Params, &params); err != nil {
		s.sendError(client, msg.ID, "Invalid params")
		return
	}
	
	if len(params) < 5 {
		s.sendError(client, msg.ID, "Missing params")
		return
	}
	
	share := &Share{
		WorkerID:    client.WorkerName,
		JobID:       params[1].(string),
		ExtraNonce2: params[2].(string),
		NTime:       params[3].(string),
		Nonce:       params[4].(string),
		Difficulty:  client.Difficulty,
		SubmittedAt: time.Now(),
	}
	
	// Validate share
	valid := s.validateShare(share)
	share.Valid = valid
	
	client.SubmitCount++
	s.stats.TotalShares.Add(1)
	
	if valid {
		client.ValidShares++
		s.stats.ValidShares.Add(1)
		s.sendResult(client, msg.ID, true)
	} else {
		client.InvalidShares++
		s.stats.InvalidShares.Add(1)
		s.sendError(client, msg.ID, "Invalid share")
	}
	
	// Adjust difficulty
	s.adjustDifficulty(client)
}

func (s *Server) handleGetTransactions(client *ClientConnection, msg *Message) {
	// Return empty transactions for now
	s.sendResult(client, msg.ID, []string{})
}

func (s *Server) handleExtranonceSubscribe(client *ClientConnection, msg *Message) {
	s.sendResult(client, msg.ID, true)
}

// Helper methods
func (s *Server) sendResult(client *ClientConnection, id interface{}, result interface{}) {
	msg := &Message{
		ID:     id,
		Result: result,
		Error:  nil,
	}
	s.sendMessage(client, msg)
}

func (s *Server) sendError(client *ClientConnection, id interface{}, err string) {
	msg := &Message{
		ID:     id,
		Result: nil,
		Error:  []interface{}{20, err, nil},
	}
	s.sendMessage(client, msg)
}

func (s *Server) sendMessage(client *ClientConnection, msg *Message) {
	data, err := json.Marshal(msg)
	if err != nil {
		s.logger.Error("Failed to marshal message", zap.Error(err))
		return
	}
	
	if _, err := client.Writer.Write(append(data, '\n')); err != nil {
		s.logger.Error("Failed to write message", zap.Error(err))
		return
	}
	
	client.Writer.Flush()
}

func (s *Server) sendDifficulty(client *ClientConnection, difficulty float64) {
	msg := &Message{
		ID:     nil,
		Method: "mining.set_difficulty",
		Params: json.RawMessage(fmt.Sprintf("[%f]", difficulty)),
	}
	s.sendMessage(client, msg)
	client.Difficulty = difficulty
}

func (s *Server) sendJob(client *ClientConnection, job *Job, clean bool) {
	params := []interface{}{
		job.ID,
		job.PrevHash,
		job.CoinBase1,
		job.CoinBase2,
		job.MerkleBranch,
		job.Version,
		job.NBits,
		job.NTime,
		clean,
	}
	
	paramsJSON, _ := json.Marshal(params)
	
	msg := &Message{
		ID:     nil,
		Method: "mining.notify",
		Params: paramsJSON,
	}
	s.sendMessage(client, msg)
}

// BroadcastJob broadcasts a new job to all clients
func (s *Server) BroadcastJob(job *Job, clean bool) {
	s.currentJob = job
	s.jobManager.AddJob(job)
	
	s.clientsMu.RLock()
	defer s.clientsMu.RUnlock()
	
	for _, client := range s.clients {
		if client.Authorized {
			s.sendJob(client, job, clean)
		}
	}
	
	s.logger.Info("Job broadcasted",
		zap.String("job_id", job.ID),
		zap.Int("clients", len(s.clients)))
}

// validateShare validates a submitted share
func (s *Server) validateShare(share *Share) bool {
	// Get job
	job := s.jobManager.GetJob(share.JobID)
	if job == nil {
		return false // Job not found
	}
	
	// Check if job is not too old
	if time.Since(job.CreatedAt) > 5*time.Minute {
		return false // Stale share
	}
	
	// Additional validation would go here
	// - Check PoW
	// - Check difficulty target
	// - Check for duplicate
	
	return true
}

// adjustDifficulty adjusts client difficulty based on share rate
func (s *Server) adjustDifficulty(client *ClientConnection) {
	s.difficulty.AdjustForClient(client.ID, client.Difficulty)
}

// JobManager methods
func (jm *JobManager) AddJob(job *Job) {
	jm.jobsMu.Lock()
	jm.jobs[job.ID] = job
	jm.current = job
	jm.counter++
	jm.jobsMu.Unlock()
	
	// Clean old jobs
	go jm.cleanOldJobs()
}

func (jm *JobManager) GetJob(id string) *Job {
	jm.jobsMu.RLock()
	defer jm.jobsMu.RUnlock()
	return jm.jobs[id]
}

func (jm *JobManager) GetCurrentJob() *Job {
	jm.jobsMu.RLock()
	defer jm.jobsMu.RUnlock()
	return jm.current
}

func (jm *JobManager) cleanOldJobs() {
	jm.jobsMu.Lock()
	defer jm.jobsMu.Unlock()
	
	cutoff := time.Now().Add(-10 * time.Minute)
	for id, job := range jm.jobs {
		if job.CreatedAt.Before(cutoff) {
			delete(jm.jobs, id)
		}
	}
}

// DifficultyManager methods
func (dm *DifficultyManager) AdjustForClient(clientID string, currentDiff float64) float64 {
	dm.historyMu.Lock()
	defer dm.historyMu.Unlock()
	
	// Get share history
	history := dm.shareHistory[clientID]
	if len(history) < dm.adjustWindow {
		return currentDiff
	}
	
	// Calculate share rate
	oldest := history[0]
	newest := history[len(history)-1]
	duration := newest.Sub(oldest)
	shareRate := float64(len(history)) / duration.Seconds()
	
	// Calculate target share rate
	targetRate := 1.0 / dm.targetTime.Seconds()
	
	// Adjust difficulty
	newDiff := currentDiff
	if shareRate > targetRate*1.5 {
		newDiff = currentDiff * 2
	} else if shareRate < targetRate*0.5 {
		newDiff = currentDiff / 2
	}
	
	// Apply limits
	if newDiff < dm.minDiff {
		newDiff = dm.minDiff
	}
	if newDiff > dm.maxDiff {
		newDiff = dm.maxDiff
	}
	
	// Clear old history
	if len(history) > dm.adjustWindow*2 {
		dm.shareHistory[clientID] = history[len(history)-dm.adjustWindow:]
	}
	
	return newDiff
}

func (dm *DifficultyManager) RecordShare(clientID string) {
	dm.historyMu.Lock()
	defer dm.historyMu.Unlock()
	
	if dm.shareHistory[clientID] == nil {
		dm.shareHistory[clientID] = make([]time.Time, 0, dm.adjustWindow*2)
	}
	
	dm.shareHistory[clientID] = append(dm.shareHistory[clientID], time.Now())
}

// Utility functions
func generateID() string {
	return fmt.Sprintf("%d", time.Now().UnixNano())
}

func generateExtranonce1() string {
	return fmt.Sprintf("%08x", time.Now().Unix())
}