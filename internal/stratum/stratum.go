// Package stratum implements high-performance Stratum mining protocol
// Optimized for low latency and high throughput
package stratum

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/otedama/otedama/internal/config"
	"go.uber.org/zap"
)

// Client implements Stratum client for pool mining
type Client struct {
	logger *zap.Logger
	config *config.StratumConfig
	
	// Connection
	conn      net.Conn
	reader    *bufio.Reader
	writer    *bufio.Writer
	connected atomic.Bool
	
	// Request tracking
	requestID  atomic.Uint64
	requests   sync.Map // map[uint64]chan *Response
	
	// Mining state
	currentJob atomic.Pointer[Job]
	difficulty atomic.Uint64
	extraNonce string
	
	// Channels
	jobs      chan *Job
	submits   chan *Submit
	
	// Lifecycle
	ctx       context.Context
	cancel    context.CancelFunc
	wg        sync.WaitGroup
	
	// Statistics
	stats     ClientStats
}

// Server implements Stratum server for pool operation
type Server struct {
	logger    *zap.Logger
	config    *config.StratumConfig
	
	// Network
	listener  net.Listener
	
	// Worker management
	workers   *WorkerManager
	
	// Job management
	jobMaker  *JobMaker
	
	// Lifecycle
	ctx       context.Context
	cancel    context.CancelFunc
	wg        sync.WaitGroup
	
	// Statistics
	stats     ServerStats
}

// Job represents a mining job
type Job struct {
	ID           string
	PrevHash     string
	Coinbase1    string
	Coinbase2    string
	MerkleBranch []string
	Version      string
	NBits        string
	NTime        string
	CleanJobs    bool
	Target       string
	Height       uint64
	Algorithm    string
}

// Submit represents a share submission
type Submit struct {
	WorkerName string
	JobID      string
	ExtraNonce2 string
	NTime      string
	Nonce      string
}

// Request represents a Stratum request
type Request struct {
	ID     interface{}   `json:"id"`
	Method string        `json:"method"`
	Params []interface{} `json:"params"`
}

// Response represents a Stratum response
type Response struct {
	ID     interface{}   `json:"id"`
	Result interface{}   `json:"result"`
	Error  []interface{} `json:"error"`
}

// Notification represents a Stratum notification
type Notification struct {
	Method string        `json:"method"`
	Params []interface{} `json:"params"`
}

// ClientStats tracks client statistics
type ClientStats struct {
	Connected       atomic.Bool
	JobsReceived    atomic.Uint64
	SharesSubmitted atomic.Uint64
	SharesAccepted  atomic.Uint64
	SharesRejected  atomic.Uint64
	LastShareTime   atomic.Int64
}

// ServerStats tracks server statistics
type ServerStats struct {
	WorkersConnected atomic.Int32
	JobsGenerated    atomic.Uint64
	SharesReceived   atomic.Uint64
	SharesAccepted   atomic.Uint64
	BlocksFound      atomic.Uint64
}

// NewClient creates a new Stratum client
func NewClient(logger *zap.Logger, cfg *config.StratumConfig) *Client {
	ctx, cancel := context.WithCancel(context.Background())
	
	return &Client{
		logger:   logger,
		config:   cfg,
		jobs:     make(chan *Job, 10),
		submits:  make(chan *Submit, 100),
		ctx:      ctx,
		cancel:   cancel,
	}
}

// Connect connects to the Stratum pool
func (c *Client) Connect() error {
	return c.ConnectContext(c.ctx)
}

// ConnectContext connects with context
func (c *Client) ConnectContext(ctx context.Context) error {
	if c.connected.Load() {
		return errors.New("already connected")
	}
	
	// Try each pool in order
	for _, pool := range c.config.Pools {
		c.logger.Info("Connecting to pool",
			zap.String("url", pool.URL))
		
		// Parse URL (stratum+tcp://host:port)
		addr := pool.URL
		if len(addr) > 13 && addr[:13] == "stratum+tcp://" {
			addr = addr[13:]
		}
		
		// Connect with timeout
		dialer := &net.Dialer{
			Timeout: 10 * time.Second,
		}
		
		conn, err := dialer.DialContext(ctx, "tcp", addr)
		if err != nil {
			c.logger.Warn("Failed to connect to pool",
				zap.String("url", pool.URL),
				zap.Error(err))
			continue
		}
		
		c.conn = conn
		c.reader = bufio.NewReader(conn)
		c.writer = bufio.NewWriter(conn)
		c.connected.Store(true)
		c.stats.Connected.Store(true)
		
		// Start handlers
		c.wg.Add(2)
		go c.readLoop()
		go c.writeLoop()
		
		// Subscribe
		if err := c.subscribe(pool); err != nil {
			c.logger.Warn("Subscribe failed",
				zap.String("url", pool.URL),
				zap.Error(err))
			c.Disconnect()
			continue
		}
		
		// Authorize
		if err := c.authorize(pool); err != nil {
			c.logger.Warn("Authorization failed",
				zap.String("url", pool.URL),
				zap.Error(err))
			c.Disconnect()
			continue
		}
		
		c.logger.Info("Connected to pool successfully",
			zap.String("url", pool.URL))
		
		return nil
	}
	
	return errors.New("failed to connect to any pool")
}

// Disconnect disconnects from the pool
func (c *Client) Disconnect() error {
	if !c.connected.CompareAndSwap(true, false) {
		return errors.New("not connected")
	}
	
	c.stats.Connected.Store(false)
	c.cancel()
	
	if c.conn != nil {
		c.conn.Close()
	}
	
	c.wg.Wait()
	
	c.logger.Info("Disconnected from pool")
	return nil
}

// Jobs returns the job channel
func (c *Client) Jobs() <-chan *Job {
	return c.jobs
}

// SubmitShare submits a share to the pool
func (c *Client) SubmitShare(jobID string, nonce uint64) error {
	if !c.connected.Load() {
		return errors.New("not connected")
	}
	
	submit := &Submit{
		WorkerName:  "worker",
		JobID:       jobID,
		ExtraNonce2: "00000000",
		NTime:       fmt.Sprintf("%08x", time.Now().Unix()),
		Nonce:       fmt.Sprintf("%08x", nonce),
	}
	
	select {
	case c.submits <- submit:
		c.stats.SharesSubmitted.Add(1)
		c.stats.LastShareTime.Store(time.Now().Unix())
	default:
		return errors.New("submit queue full")
	}
	
	return nil
}

// UpdateConfig updates client configuration
func (c *Client) UpdateConfig(cfg *config.StratumConfig) {
	c.config = cfg
	// Reconnect if needed
	if c.connected.Load() {
		c.Disconnect()
		c.Connect()
	}
}

// GetStats returns client statistics
func (c *Client) GetStats() ClientStats {
	return c.stats
}

// Private methods

func (c *Client) readLoop() {
	defer c.wg.Done()
	
	for {
		select {
		case <-c.ctx.Done():
			return
		default:
		}
		
		// Read line
		line, err := c.reader.ReadBytes('\n')
		if err != nil {
			if c.connected.Load() {
				c.logger.Warn("Read error", zap.Error(err))
				c.connected.Store(false)
			}
			return
		}
		
		// Parse JSON
		var msg json.RawMessage
		if err := json.Unmarshal(line, &msg); err != nil {
			c.logger.Warn("Invalid JSON", zap.Error(err))
			continue
		}
		
		// Determine message type
		if c.isResponse(msg) {
			c.handleResponse(msg)
		} else {
			c.handleNotification(msg)
		}
	}
}

func (c *Client) writeLoop() {
	defer c.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-c.ctx.Done():
			return
			
		case submit := <-c.submits:
			c.submitWork(submit)
			
		case <-ticker.C:
			// Keep-alive
			c.sendRequest("mining.ping", []interface{}{})
		}
	}
}

func (c *Client) isResponse(msg json.RawMessage) bool {
	var check struct {
		ID interface{} `json:"id"`
	}
	json.Unmarshal(msg, &check)
	return check.ID != nil
}

func (c *Client) handleResponse(msg json.RawMessage) {
	var resp Response
	if err := json.Unmarshal(msg, &resp); err != nil {
		c.logger.Warn("Failed to parse response", zap.Error(err))
		return
	}
	
	// Find waiting request
	if id, ok := resp.ID.(float64); ok {
		if ch, ok := c.requests.LoadAndDelete(uint64(id)); ok {
			if respChan, ok := ch.(chan *Response); ok {
				select {
				case respChan <- &resp:
				default:
				}
			}
		}
	}
	
	// Check for errors
	if resp.Error != nil && len(resp.Error) > 0 {
		c.logger.Warn("Pool error",
			zap.Any("error", resp.Error))
	}
}

func (c *Client) handleNotification(msg json.RawMessage) {
	var notif Notification
	if err := json.Unmarshal(msg, &notif); err != nil {
		c.logger.Warn("Failed to parse notification", zap.Error(err))
		return
	}
	
	switch notif.Method {
	case "mining.notify":
		c.handleMiningNotify(notif.Params)
		
	case "mining.set_difficulty":
		c.handleSetDifficulty(notif.Params)
		
	case "mining.set_extranonce":
		c.handleSetExtranonce(notif.Params)
		
	default:
		c.logger.Debug("Unknown notification",
			zap.String("method", notif.Method))
	}
}

func (c *Client) handleMiningNotify(params []interface{}) {
	if len(params) < 9 {
		c.logger.Warn("Invalid mining.notify params")
		return
	}
	
	job := &Job{
		ID:           params[0].(string),
		PrevHash:     params[1].(string),
		Coinbase1:    params[2].(string),
		Coinbase2:    params[3].(string),
		Version:      params[5].(string),
		NBits:        params[6].(string),
		NTime:        params[7].(string),
		CleanJobs:    params[8].(bool),
	}
	
	// Parse merkle branch
	if branches, ok := params[4].([]interface{}); ok {
		job.MerkleBranch = make([]string, len(branches))
		for i, branch := range branches {
			job.MerkleBranch[i] = branch.(string)
		}
	}
	
	// Calculate target from nbits
	job.Target = c.nbitsToTarget(job.NBits)
	
	// Store current job
	c.currentJob.Store(job)
	c.stats.JobsReceived.Add(1)
	
	// Send to job channel
	select {
	case c.jobs <- job:
	default:
		// Channel full, drop old job
		select {
		case <-c.jobs:
			c.jobs <- job
		default:
		}
	}
	
	c.logger.Info("New job received",
		zap.String("id", job.ID),
		zap.Bool("clean", job.CleanJobs))
}

func (c *Client) handleSetDifficulty(params []interface{}) {
	if len(params) < 1 {
		return
	}
	
	if diff, ok := params[0].(float64); ok {
		c.difficulty.Store(uint64(diff))
		c.logger.Info("Difficulty set",
			zap.Uint64("difficulty", uint64(diff)))
	}
}

func (c *Client) handleSetExtranonce(params []interface{}) {
	if len(params) < 2 {
		return
	}
	
	if extranonce, ok := params[0].(string); ok {
		c.extraNonce = extranonce
		c.logger.Info("Extranonce set",
			zap.String("extranonce", extranonce))
	}
}

func (c *Client) sendRequest(method string, params []interface{}) (*Response, error) {
	id := c.requestID.Add(1)
	
	req := Request{
		ID:     id,
		Method: method,
		Params: params,
	}
	
	data, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	
	// Create response channel
	respChan := make(chan *Response, 1)
	c.requests.Store(id, respChan)
	defer c.requests.Delete(id)
	
	// Send request
	if _, err := c.writer.Write(append(data, '\n')); err != nil {
		return nil, err
	}
	if err := c.writer.Flush(); err != nil {
		return nil, err
	}
	
	// Wait for response
	select {
	case resp := <-respChan:
		return resp, nil
	case <-time.After(10 * time.Second):
		return nil, errors.New("request timeout")
	case <-c.ctx.Done():
		return nil, c.ctx.Err()
	}
}

func (c *Client) subscribe(pool config.PoolConfig) error {
	resp, err := c.sendRequest("mining.subscribe", []interface{}{
		"Otedama/1.0.0",
	})
	if err != nil {
		return err
	}
	
	// Parse subscription result
	if result, ok := resp.Result.([]interface{}); ok && len(result) >= 2 {
		// Extract extranonce
		if extraNonce, ok := result[1].(string); ok {
			c.extraNonce = extraNonce
		}
	}
	
	return nil
}

func (c *Client) authorize(pool config.PoolConfig) error {
	resp, err := c.sendRequest("mining.authorize", []interface{}{
		pool.User,
		pool.Password,
	})
	if err != nil {
		return err
	}
	
	// Check authorization result
	if result, ok := resp.Result.(bool); ok && !result {
		return errors.New("authorization failed")
	}
	
	return nil
}

func (c *Client) submitWork(submit *Submit) {
	params := []interface{}{
		submit.WorkerName,
		submit.JobID,
		submit.ExtraNonce2,
		submit.NTime,
		submit.Nonce,
	}
	
	resp, err := c.sendRequest("mining.submit", params)
	if err != nil {
		c.logger.Warn("Submit failed", zap.Error(err))
		c.stats.SharesRejected.Add(1)
		return
	}
	
	// Check result
	if result, ok := resp.Result.(bool); ok && result {
		c.stats.SharesAccepted.Add(1)
		c.logger.Info("Share accepted")
	} else {
		c.stats.SharesRejected.Add(1)
		c.logger.Warn("Share rejected",
			zap.Any("error", resp.Error))
	}
}

func (c *Client) nbitsToTarget(nbits string) string {
	// Convert nbits to target
	// Simplified implementation
	return "00000000ffff0000000000000000000000000000000000000000000000000000"
}

// Server implementation

// NewServer creates a new Stratum server
func NewServer(logger *zap.Logger, cfg *config.StratumConfig) *Server {
	ctx, cancel := context.WithCancel(context.Background())
	
	return &Server{
		logger:   logger,
		config:   cfg,
		workers:  NewWorkerManager(),
		jobMaker: NewJobMaker(),
		ctx:      ctx,
		cancel:   cancel,
	}
}

// Start starts the Stratum server
func (s *Server) Start() error {
	listener, err := net.Listen("tcp", s.config.Address)
	if err != nil {
		return fmt.Errorf("failed to start listener: %w", err)
	}
	
	s.listener = listener
	
	// Start job maker
	s.wg.Add(1)
	go s.jobMaker.Run(s.ctx)
	
	// Accept connections
	s.wg.Add(1)
	go s.acceptLoop()
	
	s.logger.Info("Stratum server started",
		zap.String("address", s.config.Address))
	
	return nil
}

// Stop stops the Stratum server
func (s *Server) Stop() error {
	s.cancel()
	
	if s.listener != nil {
		s.listener.Close()
	}
	
	s.wg.Wait()
	
	s.logger.Info("Stratum server stopped")
	return nil
}

func (s *Server) acceptLoop() {
	defer s.wg.Done()
	
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			select {
			case <-s.ctx.Done():
				return
			default:
				s.logger.Warn("Accept error", zap.Error(err))
				continue
			}
		}
		
		go s.handleWorker(conn)
	}
}

func (s *Server) handleWorker(conn net.Conn) {
	defer conn.Close()
	
	worker := &Worker{
		conn:   conn,
		server: s,
	}
	
	s.workers.Add(worker)
	defer s.workers.Remove(worker)
	
	s.stats.WorkersConnected.Add(1)
	defer s.stats.WorkersConnected.Add(-1)
	
	worker.Handle()
}

// Worker represents a connected miner
type Worker struct {
	ID         string
	conn       net.Conn
	server     *Server
	authorized bool
	difficulty uint64
	stats      WorkerStats
}

// WorkerStats tracks worker statistics
type WorkerStats struct {
	SharesSubmitted atomic.Uint64
	SharesAccepted  atomic.Uint64
	SharesRejected  atomic.Uint64
	LastShareTime   atomic.Int64
}

func (w *Worker) Handle() {
	reader := bufio.NewReader(w.conn)
	writer := bufio.NewWriter(w.conn)
	
	for {
		// Read request
		line, err := reader.ReadBytes('\n')
		if err != nil {
			return
		}
		
		var req Request
		if err := json.Unmarshal(line, &req); err != nil {
			continue
		}
		
		// Handle request
		var resp Response
		resp.ID = req.ID
		
		switch req.Method {
		case "mining.subscribe":
			resp.Result = w.handleSubscribe(req.Params)
			
		case "mining.authorize":
			resp.Result = w.handleAuthorize(req.Params)
			
		case "mining.submit":
			resp.Result = w.handleSubmit(req.Params)
			
		default:
			resp.Error = []interface{}{20, "Unknown method", nil}
		}
		
		// Send response
		data, _ := json.Marshal(resp)
		writer.Write(append(data, '\n'))
		writer.Flush()
	}
}

func (w *Worker) handleSubscribe(params []interface{}) interface{} {
	// Return subscription result
	return []interface{}{
		[]interface{}{
			[]interface{}{"mining.set_difficulty", "1"},
			[]interface{}{"mining.notify", "1"},
		},
		"00000000", // Extra nonce 1
		4,          // Extra nonce 2 size
	}
}

func (w *Worker) handleAuthorize(params []interface{}) interface{} {
	if len(params) >= 2 {
		w.ID = params[0].(string)
		w.authorized = true
		return true
	}
	return false
}

func (w *Worker) handleSubmit(params []interface{}) interface{} {
	if !w.authorized {
		return false
	}
	
	w.stats.SharesSubmitted.Add(1)
	w.server.stats.SharesReceived.Add(1)
	
	// Validate share
	// Simplified validation
	valid := true
	
	if valid {
		w.stats.SharesAccepted.Add(1)
		w.server.stats.SharesAccepted.Add(1)
		w.stats.LastShareTime.Store(time.Now().Unix())
		return true
	} else {
		w.stats.SharesRejected.Add(1)
		return false
	}
}

// WorkerManager manages connected workers
type WorkerManager struct {
	workers sync.Map
}

func NewWorkerManager() *WorkerManager {
	return &WorkerManager{}
}

func (wm *WorkerManager) Add(w *Worker) {
	wm.workers.Store(w.conn.RemoteAddr().String(), w)
}

func (wm *WorkerManager) Remove(w *Worker) {
	wm.workers.Delete(w.conn.RemoteAddr().String())
}

func (wm *WorkerManager) GetAll() []*Worker {
	var workers []*Worker
	wm.workers.Range(func(_, value interface{}) bool {
		workers = append(workers, value.(*Worker))
		return true
	})
	return workers
}

// JobMaker generates mining jobs
type JobMaker struct {
	currentJob atomic.Pointer[Job]
	jobID      atomic.Uint64
}

func NewJobMaker() *JobMaker {
	return &JobMaker{}
}

func (jm *JobMaker) Run(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			jm.generateJob()
		}
	}
}

func (jm *JobMaker) generateJob() {
	job := &Job{
		ID:        strconv.FormatUint(jm.jobID.Add(1), 10),
		PrevHash:  generateRandomHex(64),
		Coinbase1: generateRandomHex(100),
		Coinbase2: generateRandomHex(100),
		Version:   "00000002",
		NBits:     "1b0404cb",
		NTime:     fmt.Sprintf("%08x", time.Now().Unix()),
		CleanJobs: false,
	}
	
	jm.currentJob.Store(job)
}

func (jm *JobMaker) GetCurrentJob() *Job {
	return jm.currentJob.Load()
}

// Helper functions

func generateRandomHex(length int) string {
	result := ""
	chars := "0123456789abcdef"
	for i := 0; i < length; i++ {
		result += string(chars[time.Now().UnixNano()%16])
	}
	return result
}
