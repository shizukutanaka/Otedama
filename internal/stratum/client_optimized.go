// Package stratum implements the Stratum mining protocol
// High-performance implementation with automatic failover
package stratum

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"sync"
	"sync/atomic"
	"time"

	"github.com/otedama/otedama/internal/config"
	"go.uber.org/zap"
)

// Client represents a Stratum client with high-performance design
type Client struct {
	logger     *zap.Logger
	config     *config.StratumConfig
	
	// Connection management
	conn       net.Conn
	reader     *bufio.Reader
	writer     *bufio.Writer
	
	// State management
	connected  atomic.Bool
	authorized atomic.Bool
	sessionID  atomic.Value // string
	
	// Request tracking
	requestID  atomic.Uint64
	pending    sync.Map // map[uint64]chan *Response
	
	// Job management
	currentJob atomic.Value // *Job
	extraNonce atomic.Value // []byte
	
	// Callbacks
	onJob      func(*Job)
	onConnect  func()
	onDisconnect func()
	
	// Control
	ctx        context.Context
	cancel     context.CancelFunc
	wg         sync.WaitGroup
	
	// Statistics
	stats      Statistics
	
	// Reconnection
	reconnectDelay time.Duration
	maxReconnect   int
}

// Job represents a mining job from the pool
type Job struct {
	ID         string
	PrevHash   string
	Coinbase1  string
	Coinbase2  string
	MerkleBranch []string
	Version    string
	NBits      string
	NTime      string
	CleanJobs  bool
	Target     string
	Height     uint64
}

// Request represents a JSON-RPC request
type Request struct {
	ID     uint64      `json:"id"`
	Method string      `json:"method"`
	Params interface{} `json:"params"`
}

// Response represents a JSON-RPC response
type Response struct {
	ID     uint64          `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  interface{}     `json:"error"`
}

// Notification represents a server notification
type Notification struct {
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

// Statistics tracks client statistics
type Statistics struct {
	Connected      atomic.Bool
	JobsReceived   atomic.Uint64
	SharesSubmitted atomic.Uint64
	SharesAccepted atomic.Uint64
	SharesRejected atomic.Uint64
	Reconnects     atomic.Uint64
	LastJobTime    atomic.Int64
	LastShareTime  atomic.Int64
}

// NewClient creates a new Stratum client
func NewClient(logger *zap.Logger, config *config.StratumConfig) *Client {
	ctx, cancel := context.WithCancel(context.Background())
	
	client := &Client{
		logger:         logger,
		config:         config,
		ctx:            ctx,
		cancel:         cancel,
		reconnectDelay: 5 * time.Second,
		maxReconnect:   10,
	}
	
	// Initialize atomic values
	client.sessionID.Store("")
	client.extraNonce.Store([]byte{})
	
	return client
}

// Connect connects to the Stratum server
func (c *Client) Connect(poolURL string) error {
	// Parse URL
	u, err := url.Parse(poolURL)
	if err != nil {
		return fmt.Errorf("invalid pool URL: %w", err)
	}
	
	host := u.Host
	if u.Port() == "" {
		// Add default port
		switch u.Scheme {
		case "stratum+tcp":
			host += ":3333"
		case "stratum+ssl", "stratum+tls":
			host += ":3443"
		}
	}
	
	// Establish connection
	var conn net.Conn
	if u.Scheme == "stratum+ssl" || u.Scheme == "stratum+tls" {
		// TLS connection with security validation
		tlsConfig := &tls.Config{
			InsecureSkipVerify: false, // Security: Always verify certificates
			MinVersion:         tls.VersionTLS12,
			ServerName:         u.Hostname(),
		}
		conn, err = tls.Dial("tcp", host, tlsConfig)
	} else {
		// Plain TCP connection
		conn, err = net.DialTimeout("tcp", host, 10*time.Second)
	}
	
	if err != nil {
		return fmt.Errorf("connection failed: %w", err)
	}
	
	// Set connection options
	if tcpConn, ok := conn.(*net.TCPConn); ok {
		tcpConn.SetKeepAlive(true)
		tcpConn.SetKeepAlivePeriod(30 * time.Second)
		tcpConn.SetNoDelay(true) // Disable Nagle's algorithm
	}
	
	c.conn = conn
	c.reader = bufio.NewReader(conn)
	c.writer = bufio.NewWriter(conn)
	c.connected.Store(true)
	
	// Start message handlers
	c.wg.Add(2)
	go c.readLoop()
	go c.keepAlive()
	
	// Call connect callback
	if c.onConnect != nil {
		c.onConnect()
	}
	
	c.logger.Info("Connected to Stratum pool", zap.String("url", poolURL))
	return nil
}

// Disconnect disconnects from the server
func (c *Client) Disconnect() {
	if !c.connected.CompareAndSwap(true, false) {
		return
	}
	
	c.cancel()
	
	if c.conn != nil {
		c.conn.Close()
	}
	
	// Wait for goroutines
	c.wg.Wait()
	
	// Call disconnect callback
	if c.onDisconnect != nil {
		c.onDisconnect()
	}
	
	c.logger.Info("Disconnected from Stratum pool")
}

// Authorize authorizes the worker
func (c *Client) Authorize(username, password string) error {
	params := []interface{}{username, password}
	
	resp, err := c.call("mining.authorize", params)
	if err != nil {
		return err
	}
	
	var result bool
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		return err
	}
	
	if !result {
		return fmt.Errorf("authorization failed")
	}
	
	c.authorized.Store(true)
	c.logger.Info("Worker authorized", zap.String("username", username))
	return nil
}

// Subscribe subscribes to mining notifications
func (c *Client) Subscribe(userAgent string) error {
	params := []interface{}{userAgent}
	
	resp, err := c.call("mining.subscribe", params)
	if err != nil {
		return err
	}
	
	// Parse subscription result
	var result []json.RawMessage
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		return err
	}
	
	// Extract session ID and extra nonce
	if len(result) > 0 {
		var subscriptions [][]string
		if err := json.Unmarshal(result[0], &subscriptions); err == nil {
			// Find mining.notify subscription
			for _, sub := range subscriptions {
				if len(sub) > 0 && sub[0] == "mining.notify" {
					if len(sub) > 1 {
						c.sessionID.Store(sub[1])
					}
				}
			}
		}
	}
	
	if len(result) > 1 {
		var extraNonce1 string
		if err := json.Unmarshal(result[1], &extraNonce1); err == nil {
			c.extraNonce.Store([]byte(extraNonce1))
		}
	}
	
	c.logger.Info("Subscribed to mining notifications")
	return nil
}

// SubmitShare submits a share to the pool
func (c *Client) SubmitShare(jobID string, extraNonce2, ntime, nonce string) error {
	job := c.currentJob.Load()
	if job == nil {
		return fmt.Errorf("no current job")
	}
	
	currentJob := job.(*Job)
	if currentJob.ID != jobID {
		return fmt.Errorf("job ID mismatch")
	}
	
	// Get worker credentials from config
	username := c.config.Pools[0].User
	
	params := []interface{}{
		username,
		jobID,
		extraNonce2,
		ntime,
		nonce,
	}
	
	c.stats.SharesSubmitted.Add(1)
	
	resp, err := c.call("mining.submit", params)
	if err != nil {
		c.stats.SharesRejected.Add(1)
		return err
	}
	
	var result bool
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		c.stats.SharesRejected.Add(1)
		return err
	}
	
	if result {
		c.stats.SharesAccepted.Add(1)
		c.stats.LastShareTime.Store(time.Now().Unix())
		c.logger.Debug("Share accepted")
	} else {
		c.stats.SharesRejected.Add(1)
		c.logger.Warn("Share rejected")
	}
	
	return nil
}

// SetDifficulty sets the mining difficulty
func (c *Client) SetDifficulty(difficulty float64) error {
	params := []interface{}{difficulty}
	_, err := c.call("mining.set_difficulty", params)
	return err
}

// GetJob returns the current job
func (c *Client) GetJob() *Job {
	job := c.currentJob.Load()
	if job != nil {
		return job.(*Job)
	}
	return nil
}

// SetJobCallback sets the job notification callback
func (c *Client) SetJobCallback(callback func(*Job)) {
	c.onJob = callback
}

// SetConnectCallback sets the connect callback
func (c *Client) SetConnectCallback(callback func()) {
	c.onConnect = callback
}

// SetDisconnectCallback sets the disconnect callback
func (c *Client) SetDisconnectCallback(callback func()) {
	c.onDisconnect = callback
}

// Internal methods

// call makes an RPC call
func (c *Client) call(method string, params interface{}) (*Response, error) {
	if !c.connected.Load() {
		return nil, fmt.Errorf("not connected")
	}
	
	// Generate request ID
	id := c.requestID.Add(1)
	
	// Create request
	req := Request{
		ID:     id,
		Method: method,
		Params: params,
	}
	
	// Marshal request
	data, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	
	// Create response channel
	respChan := make(chan *Response, 1)
	c.pending.Store(id, respChan)
	defer c.pending.Delete(id)
	
	// Send request
	if err := c.send(data); err != nil {
		return nil, err
	}
	
	// Wait for response with timeout
	select {
	case resp := <-respChan:
		if resp.Error != nil {
			return nil, fmt.Errorf("RPC error: %v", resp.Error)
		}
		return resp, nil
	case <-time.After(30 * time.Second):
		return nil, fmt.Errorf("request timeout")
	case <-c.ctx.Done():
		return nil, fmt.Errorf("client closed")
	}
}

// send sends data to the server
func (c *Client) send(data []byte) error {
	c.writer.Write(data)
	c.writer.WriteByte('\n')
	return c.writer.Flush()
}

// readLoop reads messages from the server
func (c *Client) readLoop() {
	defer c.wg.Done()
	
	for {
		select {
		case <-c.ctx.Done():
			return
		default:
			// Set read deadline
			c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
			
			// Read line
			line, err := c.reader.ReadBytes('\n')
			if err != nil {
				if c.connected.Load() {
					c.logger.Error("Read error", zap.Error(err))
					c.handleDisconnect()
				}
				return
			}
			
			// Process message
			c.processMessage(line)
		}
	}
}

// processMessage processes a message from the server
func (c *Client) processMessage(data []byte) {
	// Try to parse as response
	var resp Response
	if err := json.Unmarshal(data, &resp); err == nil && resp.ID > 0 {
		// Handle response
		if ch, ok := c.pending.Load(resp.ID); ok {
			respChan := ch.(chan *Response)
			select {
			case respChan <- &resp:
			default:
			}
		}
		return
	}
	
	// Try to parse as notification
	var notif Notification
	if err := json.Unmarshal(data, &notif); err == nil && notif.Method != "" {
		c.handleNotification(&notif)
	}
}

// handleNotification handles a server notification
func (c *Client) handleNotification(notif *Notification) {
	switch notif.Method {
	case "mining.notify":
		c.handleJobNotification(notif.Params)
	case "mining.set_difficulty":
		c.handleDifficultyNotification(notif.Params)
	case "mining.set_extranonce":
		c.handleExtraNonceNotification(notif.Params)
	}
}

// handleJobNotification handles a new job notification
func (c *Client) handleJobNotification(params json.RawMessage) {
	var jobParams []json.RawMessage
	if err := json.Unmarshal(params, &jobParams); err != nil {
		c.logger.Error("Failed to parse job params", zap.Error(err))
		return
	}
	
	if len(jobParams) < 9 {
		c.logger.Error("Invalid job params")
		return
	}
	
	job := &Job{}
	json.Unmarshal(jobParams[0], &job.ID)
	json.Unmarshal(jobParams[1], &job.PrevHash)
	json.Unmarshal(jobParams[2], &job.Coinbase1)
	json.Unmarshal(jobParams[3], &job.Coinbase2)
	json.Unmarshal(jobParams[4], &job.MerkleBranch)
	json.Unmarshal(jobParams[5], &job.Version)
	json.Unmarshal(jobParams[6], &job.NBits)
	json.Unmarshal(jobParams[7], &job.NTime)
	json.Unmarshal(jobParams[8], &job.CleanJobs)
	
	// Store job
	c.currentJob.Store(job)
	c.stats.JobsReceived.Add(1)
	c.stats.LastJobTime.Store(time.Now().Unix())
	
	// Call job callback
	if c.onJob != nil {
		c.onJob(job)
	}
	
	c.logger.Debug("New job received", zap.String("id", job.ID))
}

// handleDifficultyNotification handles a difficulty change
func (c *Client) handleDifficultyNotification(params json.RawMessage) {
	var difficulty float64
	if err := json.Unmarshal(params, &difficulty); err != nil {
		c.logger.Error("Failed to parse difficulty", zap.Error(err))
		return
	}
	
	c.logger.Info("Difficulty changed", zap.Float64("difficulty", difficulty))
}

// handleExtraNonceNotification handles extra nonce update
func (c *Client) handleExtraNonceNotification(params json.RawMessage) {
	var extraNonce string
	if err := json.Unmarshal(params, &extraNonce); err != nil {
		c.logger.Error("Failed to parse extra nonce", zap.Error(err))
		return
	}
	
	c.extraNonce.Store([]byte(extraNonce))
	c.logger.Debug("Extra nonce updated")
}

// keepAlive sends periodic pings
func (c *Client) keepAlive() {
	defer c.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-c.ctx.Done():
			return
		case <-ticker.C:
			if c.connected.Load() {
				// Send ping (get version)
				c.call("mining.get_version", nil)
			}
		}
	}
}

// handleDisconnect handles disconnection
func (c *Client) handleDisconnect() {
	if !c.connected.CompareAndSwap(true, false) {
		return
	}
	
	c.logger.Warn("Disconnected from pool")
	
	// Close connection
	if c.conn != nil {
		c.conn.Close()
	}
	
	// Call disconnect callback
	if c.onDisconnect != nil {
		c.onDisconnect()
	}
	
	// Attempt reconnection
	go c.reconnect()
}

// reconnect attempts to reconnect to the pool
func (c *Client) reconnect() {
	c.stats.Reconnects.Add(1)
	
	for i := 0; i < c.maxReconnect; i++ {
		select {
		case <-c.ctx.Done():
			return
		case <-time.After(c.reconnectDelay):
			c.logger.Info("Attempting reconnection", zap.Int("attempt", i+1))
			
			// Try primary pools
			for _, pool := range c.config.Pools {
				if err := c.Connect(pool.URL); err == nil {
					// Reauthorize
					if err := c.Authorize(pool.User, pool.Password); err == nil {
						c.logger.Info("Reconnected successfully")
						return
					}
				}
			}
			
			// Try backup pools
			for _, pool := range c.config.BackupPools {
				if err := c.Connect(pool.URL); err == nil {
					if err := c.Authorize(pool.User, pool.Password); err == nil {
						c.logger.Info("Connected to backup pool")
						return
					}
				}
			}
		}
		
		// Exponential backoff
		c.reconnectDelay = c.reconnectDelay * 2
		if c.reconnectDelay > 5*time.Minute {
			c.reconnectDelay = 5 * time.Minute
		}
	}
	
	c.logger.Error("Failed to reconnect after maximum attempts")
}

// GetStatistics returns client statistics
func (c *Client) GetStatistics() map[string]interface{} {
	return map[string]interface{}{
		"connected":        c.connected.Load(),
		"authorized":       c.authorized.Load(),
		"jobs_received":    c.stats.JobsReceived.Load(),
		"shares_submitted": c.stats.SharesSubmitted.Load(),
		"shares_accepted":  c.stats.SharesAccepted.Load(),
		"shares_rejected":  c.stats.SharesRejected.Load(),
		"reconnects":       c.stats.Reconnects.Load(),
		"last_job_time":    c.stats.LastJobTime.Load(),
		"last_share_time":  c.stats.LastShareTime.Load(),
	}
}
