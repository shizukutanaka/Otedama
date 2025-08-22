// Package stratum implements Stratum v2 protocol for mining pools
// Designed for simplicity, reliability, and performance
package stratum

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// Client represents a Stratum v2 client
type Client struct {
	logger *zap.Logger
	config *Config
	
	// Connection
	conn      net.Conn
	reader    *bufio.Reader
	writer    *bufio.Writer
	connected atomic.Bool
	
	// Protocol state
	sessionID    string
	extraNonce1  string
	extraNonce2Size int
	difficulty   float64
	
	// Channels
	sendChan chan *Request
	recvChan chan *Response
	jobChan  chan *Job
	
	// Callbacks
	jobCallback func(*Job)
	
	// Lifecycle
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
	mu     sync.RWMutex
	
	// Statistics
	stats struct {
		sync.RWMutex
		submitted   uint64
		accepted    uint64
		rejected    uint64
		lastSubmit  time.Time
		lastAccept  time.Time
		connectTime time.Time
	}
}

// Config holds Stratum configuration
type Config struct {
	Pools           []PoolConfig
	MaxRetries      int
	RetryDelay      time.Duration
	KeepAlive       time.Duration
	Timeout         time.Duration
	UseTLS          bool
	TLSSkipVerify   bool
	ExtraNonceSize  int
}

// PoolConfig represents a mining pool configuration
type PoolConfig struct {
	URL      string
	User     string
	Password string
	Priority int
}

// Request represents a Stratum request
type Request struct {
	ID     interface{} `json:"id"`
	Method string      `json:"method"`
	Params interface{} `json:"params"`
}

// Response represents a Stratum response
type Response struct {
	ID     interface{}     `json:"id"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  interface{}     `json:"error,omitempty"`
}

// Job represents a mining job from the pool
type Job struct {
	ID            string
	PrevHash      string
	CoinBase1     string
	CoinBase2     string
	MerkleBranch  []string
	Version       string
	NBits         string
	NTime         string
	CleanJobs     bool
	Difficulty    float64
	ExtraNonce1   string
	ExtraNonce2Size int
}

// NewClient creates a new Stratum client
func NewClient(logger *zap.Logger, config *Config) *Client {
	c := &Client{
		logger:   logger,
		config:   config,
		sendChan: make(chan *Request, 100),
		recvChan: make(chan *Response, 100),
		jobChan:  make(chan *Job, 10),
	}
	
	c.ctx, c.cancel = context.WithCancel(context.Background())
	return c
}

// Connect establishes connection to the pool
func (c *Client) Connect(poolURL string) error {
	if c.connected.Load() {
		return errors.New("already connected")
	}
	
	// Parse URL
	u, err := url.Parse(poolURL)
	if err != nil {
		return fmt.Errorf("invalid pool URL: %w", err)
	}
	
	// Determine protocol
	network := "tcp"
	address := u.Host
	useTLS := false
	
	switch u.Scheme {
	case "stratum+tcp":
		// Standard Stratum
	case "stratum+ssl", "stratum+tls", "stratum2+tcp":
		useTLS = true
	default:
		return fmt.Errorf("unsupported scheme: %s", u.Scheme)
	}
	
	// Establish connection
	var conn net.Conn
	if useTLS {
		tlsConfig := &tls.Config{
			InsecureSkipVerify: c.config.TLSSkipVerify,
		}
		conn, err = tls.Dial(network, address, tlsConfig)
	} else {
		conn, err = net.Dial(network, address)
	}
	
	if err != nil {
		return fmt.Errorf("connection failed: %w", err)
	}
	
	c.conn = conn
	c.reader = bufio.NewReader(conn)
	c.writer = bufio.NewWriter(conn)
	c.connected.Store(true)
	c.stats.connectTime = time.Now()
	
	// Start workers
	c.wg.Add(3)
	go c.sendWorker()
	go c.recvWorker()
	go c.keepAliveWorker()
	
	c.logger.Info("Connected to pool",
		zap.String("url", poolURL),
		zap.Bool("tls", useTLS))
	
	return nil
}

// Disconnect closes the connection
func (c *Client) Disconnect() {
	if !c.connected.Load() {
		return
	}
	
	c.connected.Store(false)
	c.cancel()
	
	if c.conn != nil {
		c.conn.Close()
	}
	
	c.wg.Wait()
	
	close(c.sendChan)
	close(c.recvChan)
	close(c.jobChan)
	
	c.logger.Info("Disconnected from pool")
}

// Subscribe to mining notifications
func (c *Client) Subscribe(userAgent string) error {
	if !c.connected.Load() {
		return errors.New("not connected")
	}
	
	req := &Request{
		ID:     1,
		Method: "mining.subscribe",
		Params: []string{userAgent},
	}
	
	resp, err := c.sendRequest(req)
	if err != nil {
		return err
	}
	
	// Parse subscription result
	var result []interface{}
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		return fmt.Errorf("invalid subscription response: %w", err)
	}
	
	// Extract session ID and nonces
	if len(result) >= 2 {
		if sessionID, ok := result[0].(string); ok {
			c.sessionID = sessionID
		}
		
		if nonceData, ok := result[1].([]interface{}); ok && len(nonceData) >= 2 {
			if extraNonce1, ok := nonceData[0].(string); ok {
				c.extraNonce1 = extraNonce1
			}
			if extraNonce2Size, ok := nonceData[1].(float64); ok {
				c.extraNonce2Size = int(extraNonce2Size)
			}
		}
	}
	
	c.logger.Info("Subscribed to pool",
		zap.String("session_id", c.sessionID),
		zap.String("extra_nonce1", c.extraNonce1),
		zap.Int("extra_nonce2_size", c.extraNonce2Size))
	
	return nil
}

// Authorize worker with the pool
func (c *Client) Authorize(username, password string) error {
	if !c.connected.Load() {
		return errors.New("not connected")
	}
	
	req := &Request{
		ID:     2,
		Method: "mining.authorize",
		Params: []string{username, password},
	}
	
	resp, err := c.sendRequest(req)
	if err != nil {
		return err
	}
	
	// Check authorization result
	var authorized bool
	if err := json.Unmarshal(resp.Result, &authorized); err != nil {
		return fmt.Errorf("invalid authorization response: %w", err)
	}
	
	if !authorized {
		return errors.New("authorization failed")
	}
	
	c.logger.Info("Authorized with pool", zap.String("username", username))
	
	return nil
}

// Submit submits a share to the pool
func (c *Client) Submit(jobID, nonce, ntime, extraNonce2 string) error {
	if !c.connected.Load() {
		return errors.New("not connected")
	}
	
	c.mu.RLock()
	username := ""
	if len(c.config.Pools) > 0 {
		username = c.config.Pools[0].User
	}
	c.mu.RUnlock()
	
	req := &Request{
		ID:     time.Now().UnixNano(),
		Method: "mining.submit",
		Params: []interface{}{
			username,
			jobID,
			extraNonce2,
			ntime,
			nonce,
		},
	}
	
	c.stats.Lock()
	c.stats.submitted++
	c.stats.lastSubmit = time.Now()
	c.stats.Unlock()
	
	resp, err := c.sendRequest(req)
	if err != nil {
		c.stats.Lock()
		c.stats.rejected++
		c.stats.Unlock()
		return err
	}
	
	// Check submission result
	var accepted bool
	if resp.Result != nil {
		json.Unmarshal(resp.Result, &accepted)
	}
	
	c.stats.Lock()
	if accepted {
		c.stats.accepted++
		c.stats.lastAccept = time.Now()
	} else {
		c.stats.rejected++
	}
	c.stats.Unlock()
	
	if accepted {
		c.logger.Debug("Share accepted", zap.String("job_id", jobID))
	} else {
		c.logger.Warn("Share rejected", zap.String("job_id", jobID))
	}
	
	return nil
}

// SetJobCallback sets the callback for new jobs
func (c *Client) SetJobCallback(callback func(*Job)) {
	c.jobCallback = callback
}

// GetStatistics returns connection statistics
func (c *Client) GetStatistics() map[string]interface{} {
	c.stats.RLock()
	defer c.stats.RUnlock()
	
	uptime := time.Since(c.stats.connectTime).Seconds()
	acceptRate := float64(c.stats.accepted) / float64(c.stats.submitted) * 100
	
	return map[string]interface{}{
		"connected":    c.connected.Load(),
		"uptime":       uptime,
		"submitted":    c.stats.submitted,
		"accepted":     c.stats.accepted,
		"rejected":     c.stats.rejected,
		"accept_rate":  acceptRate,
		"last_submit":  c.stats.lastSubmit,
		"last_accept":  c.stats.lastAccept,
		"difficulty":   c.difficulty,
	}
}

// Internal methods

func (c *Client) sendRequest(req *Request) (*Response, error) {
	// Send request
	data, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	
	if _, err := c.writer.Write(append(data, '\n')); err != nil {
		return nil, err
	}
	
	if err := c.writer.Flush(); err != nil {
		return nil, err
	}
	
	// Wait for response with timeout
	timeout := time.NewTimer(c.config.Timeout)
	defer timeout.Stop()
	
	for {
		select {
		case resp := <-c.recvChan:
			if resp.ID == req.ID {
				return resp, nil
			}
		case <-timeout.C:
			return nil, errors.New("request timeout")
		case <-c.ctx.Done():
			return nil, context.Canceled
		}
	}
}

func (c *Client) sendWorker() {
	defer c.wg.Done()
	
	for {
		select {
		case req := <-c.sendChan:
			if req == nil {
				return
			}
			
			data, err := json.Marshal(req)
			if err != nil {
				c.logger.Error("Failed to marshal request", zap.Error(err))
				continue
			}
			
			if _, err := c.writer.Write(append(data, '\n')); err != nil {
				c.logger.Error("Failed to send request", zap.Error(err))
				c.handleError(err)
				return
			}
			
			if err := c.writer.Flush(); err != nil {
				c.logger.Error("Failed to flush writer", zap.Error(err))
				c.handleError(err)
				return
			}
			
		case <-c.ctx.Done():
			return
		}
	}
}

func (c *Client) recvWorker() {
	defer c.wg.Done()
	
	for {
		select {
		case <-c.ctx.Done():
			return
		default:
			// Read line
			line, err := c.reader.ReadBytes('\n')
			if err != nil {
				c.logger.Error("Failed to read response", zap.Error(err))
				c.handleError(err)
				return
			}
			
			// Parse response
			var resp Response
			if err := json.Unmarshal(line, &resp); err != nil {
				c.logger.Error("Failed to parse response", zap.Error(err))
				continue
			}
			
			// Handle notification
			if resp.ID == nil {
				c.handleNotification(&resp)
				continue
			}
			
			// Send to response channel
			select {
			case c.recvChan <- &resp:
			default:
				// Channel full
			}
		}
	}
}

func (c *Client) keepAliveWorker() {
	defer c.wg.Done()
	
	ticker := time.NewTicker(c.config.KeepAlive)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			// Send ping
			req := &Request{
				ID:     "ping",
				Method: "mining.ping",
				Params: []interface{}{},
			}
			
			select {
			case c.sendChan <- req:
			default:
				// Channel full
			}
			
		case <-c.ctx.Done():
			return
		}
	}
}

func (c *Client) handleNotification(resp *Response) {
	// Parse method from response
	var notification struct {
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	
	// Notification responses have the method in a different format
	// This is a simplified handler - extend based on pool requirements
	c.logger.Debug("Received notification", zap.Any("response", resp))
}

func (c *Client) handleError(err error) {
	c.connected.Store(false)
	c.logger.Error("Connection error", zap.Error(err))
	
	// Trigger reconnection
	go c.reconnect()
}

func (c *Client) reconnect() {
	if len(c.config.Pools) == 0 {
		return
	}
	
	for i := 0; i < c.config.MaxRetries; i++ {
		time.Sleep(c.config.RetryDelay)
		
		c.logger.Info("Attempting reconnection", zap.Int("attempt", i+1))
		
		// Try each pool in order of priority
		for _, pool := range c.config.Pools {
			if err := c.Connect(pool.URL); err != nil {
				c.logger.Warn("Reconnection failed", zap.Error(err))
				continue
			}
			
			// Re-subscribe and authorize
			if err := c.Subscribe("Otedama"); err != nil {
				c.logger.Warn("Re-subscription failed", zap.Error(err))
				c.Disconnect()
				continue
			}
			
			if err := c.Authorize(pool.User, pool.Password); err != nil {
				c.logger.Warn("Re-authorization failed", zap.Error(err))
				c.Disconnect()
				continue
			}
			
			c.logger.Info("Reconnected successfully")
			return
		}
	}
	
	c.logger.Error("Failed to reconnect after maximum retries")
}
