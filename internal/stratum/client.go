// Package stratum provides Stratum protocol client for mining pools
// Design: Robust, efficient, compatible (Carmack/Pike/Martin)
package stratum

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Constants
const (
	StratumVersion1 = 1
	StratumVersion2 = 2
	
	DefaultTimeout     = 30 * time.Second
	ReconnectDelay     = 5 * time.Second
	MaxReconnectDelay  = 5 * time.Minute
	KeepAliveInterval  = 30 * time.Second
	MaxRetries         = 10
)

// Client represents a Stratum client
type Client struct {
	mu       sync.RWMutex
	ctx      context.Context
	cancel   context.CancelFunc
	
	// Connection
	conn     net.Conn
	reader   *bufio.Reader
	writer   *bufio.Writer
	
	// State
	connected    atomic.Bool
	authorized   atomic.Bool
	sessionID    string
	extraNonce1  string
	extraNonce2Size int
	
	// Current job
	currentJob   atomic.Pointer[Job]
	
	// Pools
	pools        []PoolConfig
	currentPool  int
	
	// Statistics
	stats        *ClientStats
	
	// Channels
	submitChan   chan *Share
	responseChan map[uint64]chan *Response
	responseMu   sync.RWMutex
	
	// Request ID counter
	requestID    atomic.Uint64
	
	// Configuration
	config       ClientConfig
}

// ClientConfig contains client configuration
type ClientConfig struct {
	Version         int
	Timeout         time.Duration
	KeepAlive       bool
	AutoReconnect   bool
	UseTLS          bool
	TLSSkipVerify   bool
	Retries         int
}

// PoolConfig represents a mining pool configuration
type PoolConfig struct {
	URL           string
	User          string
	Password      string
	Priority      int
	Enabled       bool
}

// Job represents a mining job from the pool
type Job struct {
	ID            string
	PrevHash      string
	Coinbase1     string
	Coinbase2     string
	MerkleBranch  []string
	Version       string
	NBits         string
	NTime         string
	CleanJobs     bool
	Target        string
	Height        uint64
	Difficulty    float64
}

// Share represents a mining share to submit
type Share struct {
	JobID       string
	ExtraNonce2 string
	NTime       string
	Nonce       string
	WorkerName  string
}

// ClientStats tracks client statistics
type ClientStats struct {
	ConnectedAt      atomic.Int64
	SharesSubmitted  atomic.Uint64
	SharesAccepted   atomic.Uint64
	SharesRejected   atomic.Uint64
	SharesStale      atomic.Uint64
	LastShareTime    atomic.Int64
	Reconnects       atomic.Uint32
	TotalUptime      atomic.Int64
}

// Request represents a JSON-RPC request
type Request struct {
	ID     uint64        `json:"id"`
	Method string        `json:"method"`
	Params []interface{} `json:"params"`
}

// Response represents a JSON-RPC response
type Response struct {
	ID     uint64          `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  interface{}     `json:"error"`
}

// Notification represents a JSON-RPC notification
type Notification struct {
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

// Methods
const (
	MethodSubscribe       = "mining.subscribe"
	MethodAuthorize       = "mining.authorize"
	MethodSubmit          = "mining.submit"
	MethodGetTransactions = "mining.get_transactions"
	MethodNotify          = "mining.notify"
	MethodSetDifficulty   = "mining.set_difficulty"
	MethodSetExtraNonce   = "mining.set_extranonce"
	MethodSetGoal         = "mining.set_goal"
	MethodReconnect       = "client.reconnect"
	MethodGetVersion      = "client.get_version"
)

// NewClient creates a new Stratum client
func NewClient(pools []PoolConfig, config ClientConfig) (*Client, error) {
	if len(pools) == 0 {
		return nil, errors.New("no pools configured")
	}
	
	// Set defaults
	if config.Timeout == 0 {
		config.Timeout = DefaultTimeout
	}
	if config.Version == 0 {
		config.Version = StratumVersion1
	}
	if config.Retries == 0 {
		config.Retries = MaxRetries
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	client := &Client{
		ctx:          ctx,
		cancel:       cancel,
		pools:        pools,
		config:       config,
		submitChan:   make(chan *Share, 100),
		responseChan: make(map[uint64]chan *Response),
		stats:        &ClientStats{},
	}
	
	return client, nil
}

// Connect connects to the mining pool
func (c *Client) Connect() error {
	return c.connectToPool(c.currentPool)
}

// Disconnect disconnects from the pool
func (c *Client) Disconnect() error {
	c.cancel()
	
	if c.conn != nil {
		c.conn.Close()
	}
	
	c.connected.Store(false)
	c.authorized.Store(false)
	
	return nil
}

// SubmitShare submits a share to the pool
func (c *Client) SubmitShare(share *Share) error {
	if !c.connected.Load() || !c.authorized.Load() {
		return errors.New("not connected or authorized")
	}
	
	// Queue share for submission
	select {
	case c.submitChan <- share:
		return nil
	case <-time.After(time.Second):
		return errors.New("submit queue full")
	}
}

// GetCurrentJob returns the current mining job
func (c *Client) GetCurrentJob() *Job {
	return c.currentJob.Load()
}

// GetStatistics returns client statistics
func (c *Client) GetStatistics() map[string]interface{} {
	uptime := time.Since(time.Unix(c.stats.ConnectedAt.Load(), 0))
	
	return map[string]interface{}{
		"connected":        c.connected.Load(),
		"authorized":       c.authorized.Load(),
		"current_pool":     c.pools[c.currentPool].URL,
		"uptime":           uptime.Seconds(),
		"shares_submitted": c.stats.SharesSubmitted.Load(),
		"shares_accepted":  c.stats.SharesAccepted.Load(),
		"shares_rejected":  c.stats.SharesRejected.Load(),
		"shares_stale":     c.stats.SharesStale.Load(),
		"reconnects":       c.stats.Reconnects.Load(),
		"last_share":       time.Unix(c.stats.LastShareTime.Load(), 0),
	}
}

// Private methods

func (c *Client) connectToPool(poolIndex int) error {
	if poolIndex >= len(c.pools) {
		return errors.New("invalid pool index")
	}
	
	pool := c.pools[poolIndex]
	if !pool.Enabled {
		return c.connectToPool((poolIndex + 1) % len(c.pools))
	}
	
	// Parse URL
	url := pool.URL
	if !strings.Contains(url, "://") {
		url = "stratum+tcp://" + url
	}
	
	// Remove protocol prefix
	url = strings.TrimPrefix(url, "stratum+tcp://")
	url = strings.TrimPrefix(url, "stratum+ssl://")
	url = strings.TrimPrefix(url, "stratum2+tcp://")
	url = strings.TrimPrefix(url, "stratum2+ssl://")
	
	// Connect
	var conn net.Conn
	var err error
	
	if c.config.UseTLS {
		tlsConfig := &tls.Config{
			InsecureSkipVerify: c.config.TLSSkipVerify,
		}
		conn, err = tls.DialWithDialer(&net.Dialer{
			Timeout: c.config.Timeout,
		}, "tcp", url, tlsConfig)
	} else {
		conn, err = net.DialTimeout("tcp", url, c.config.Timeout)
	}
	
	if err != nil {
		return fmt.Errorf("failed to connect to %s: %w", url, err)
	}
	
	c.conn = conn
	c.reader = bufio.NewReader(conn)
	c.writer = bufio.NewWriter(conn)
	c.currentPool = poolIndex
	
	// Start handlers
	go c.readLoop()
	go c.submitLoop()
	
	// Subscribe
	if err := c.subscribe(); err != nil {
		conn.Close()
		return err
	}
	
	// Authorize
	if err := c.authorize(pool.User, pool.Password); err != nil {
		conn.Close()
		return err
	}
	
	c.connected.Store(true)
	c.stats.ConnectedAt.Store(time.Now().Unix())
	
	// Start keep-alive if enabled
	if c.config.KeepAlive {
		go c.keepAliveLoop()
	}
	
	return nil
}

func (c *Client) reconnect() {
	if !c.config.AutoReconnect {
		return
	}
	
	c.stats.Reconnects.Add(1)
	
	delay := ReconnectDelay
	for attempt := 0; attempt < c.config.Retries; attempt++ {
		// Try current pool
		if err := c.connectToPool(c.currentPool); err == nil {
			return
		}
		
		// Try next pool
		c.currentPool = (c.currentPool + 1) % len(c.pools)
		if err := c.connectToPool(c.currentPool); err == nil {
			return
		}
		
		// Wait before retry
		time.Sleep(delay)
		
		// Exponential backoff
		delay *= 2
		if delay > MaxReconnectDelay {
			delay = MaxReconnectDelay
		}
	}
}

func (c *Client) subscribe() error {
	// Send subscribe request
	req := Request{
		ID:     c.requestID.Add(1),
		Method: MethodSubscribe,
		Params: []interface{}{
			"Otedama/1.0",
			c.sessionID,
		},
	}
	
	resp, err := c.sendRequest(req)
	if err != nil {
		return err
	}
	
	// Parse response
	var result []interface{}
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		return err
	}
	
	// Extract subscription details
	if len(result) >= 2 {
		// Session ID
		if sessionID, ok := result[1].(string); ok {
			c.sessionID = sessionID
			c.extraNonce1 = sessionID
		}
		
		// Extra nonce 2 size
		if size, ok := result[2].(float64); ok {
			c.extraNonce2Size = int(size)
		}
	}
	
	return nil
}

func (c *Client) authorize(user, password string) error {
	// Send authorize request
	req := Request{
		ID:     c.requestID.Add(1),
		Method: MethodAuthorize,
		Params: []interface{}{user, password},
	}
	
	resp, err := c.sendRequest(req)
	if err != nil {
		return err
	}
	
	// Check result
	var result bool
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		return err
	}
	
	if !result {
		return errors.New("authorization failed")
	}
	
	c.authorized.Store(true)
	return nil
}

func (c *Client) readLoop() {
	defer func() {
		c.connected.Store(false)
		c.conn.Close()
		
		// Trigger reconnect
		if c.config.AutoReconnect {
			go c.reconnect()
		}
	}()
	
	for {
		line, err := c.reader.ReadString('\n')
		if err != nil {
			return
		}
		
		// Try to parse as response
		var resp Response
		if err := json.Unmarshal([]byte(line), &resp); err == nil && resp.ID != 0 {
			c.handleResponse(&resp)
			continue
		}
		
		// Try to parse as notification
		var notif Notification
		if err := json.Unmarshal([]byte(line), &notif); err == nil {
			c.handleNotification(&notif)
		}
	}
}

func (c *Client) submitLoop() {
	for {
		select {
		case <-c.ctx.Done():
			return
		case share := <-c.submitChan:
			c.submitShareInternal(share)
		}
	}
}

func (c *Client) keepAliveLoop() {
	ticker := time.NewTicker(KeepAliveInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-c.ctx.Done():
			return
		case <-ticker.C:
			// Send getversion as keep-alive
			req := Request{
				ID:     c.requestID.Add(1),
				Method: MethodGetVersion,
				Params: []interface{}{},
			}
			c.sendRequest(req)
		}
	}
}

func (c *Client) submitShareInternal(share *Share) {
	c.stats.SharesSubmitted.Add(1)
	c.stats.LastShareTime.Store(time.Now().Unix())
	
	// Get current pool
	pool := c.pools[c.currentPool]
	
	// Build submit request
	req := Request{
		ID:     c.requestID.Add(1),
		Method: MethodSubmit,
		Params: []interface{}{
			pool.User,
			share.JobID,
			share.ExtraNonce2,
			share.NTime,
			share.Nonce,
		},
	}
	
	resp, err := c.sendRequest(req)
	if err != nil {
		c.stats.SharesRejected.Add(1)
		return
	}
	
	// Check result
	var result bool
	if err := json.Unmarshal(resp.Result, &result); err == nil && result {
		c.stats.SharesAccepted.Add(1)
	} else {
		c.stats.SharesRejected.Add(1)
	}
}

func (c *Client) sendRequest(req Request) (*Response, error) {
	// Create response channel
	respChan := make(chan *Response, 1)
	
	c.responseMu.Lock()
	c.responseChan[req.ID] = respChan
	c.responseMu.Unlock()
	
	defer func() {
		c.responseMu.Lock()
		delete(c.responseChan, req.ID)
		c.responseMu.Unlock()
	}()
	
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
	
	// Wait for response
	select {
	case resp := <-respChan:
		return resp, nil
	case <-time.After(c.config.Timeout):
		return nil, errors.New("request timeout")
	}
}

func (c *Client) handleResponse(resp *Response) {
	c.responseMu.RLock()
	ch, exists := c.responseChan[resp.ID]
	c.responseMu.RUnlock()
	
	if exists {
		select {
		case ch <- resp:
		default:
		}
	}
}

func (c *Client) handleNotification(notif *Notification) {
	switch notif.Method {
	case MethodNotify:
		c.handleJobNotification(notif.Params)
	case MethodSetDifficulty:
		c.handleDifficultyNotification(notif.Params)
	case MethodSetExtraNonce:
		c.handleExtraNonceNotification(notif.Params)
	case MethodReconnect:
		c.handleReconnectNotification(notif.Params)
	}
}

func (c *Client) handleJobNotification(params json.RawMessage) {
	var jobParams []interface{}
	if err := json.Unmarshal(params, &jobParams); err != nil {
		return
	}
	
	if len(jobParams) < 9 {
		return
	}
	
	// Parse job
	job := &Job{}
	
	if id, ok := jobParams[0].(string); ok {
		job.ID = id
	}
	if prevHash, ok := jobParams[1].(string); ok {
		job.PrevHash = prevHash
	}
	if coinbase1, ok := jobParams[2].(string); ok {
		job.Coinbase1 = coinbase1
	}
	if coinbase2, ok := jobParams[3].(string); ok {
		job.Coinbase2 = coinbase2
	}
	
	// Merkle branch
	if branches, ok := jobParams[4].([]interface{}); ok {
		job.MerkleBranch = make([]string, len(branches))
		for i, branch := range branches {
			if b, ok := branch.(string); ok {
				job.MerkleBranch[i] = b
			}
		}
	}
	
	if version, ok := jobParams[5].(string); ok {
		job.Version = version
	}
	if nbits, ok := jobParams[6].(string); ok {
		job.NBits = nbits
	}
	if ntime, ok := jobParams[7].(string); ok {
		job.NTime = ntime
	}
	if clean, ok := jobParams[8].(bool); ok {
		job.CleanJobs = clean
	}
	
	// Store job
	c.currentJob.Store(job)
}

func (c *Client) handleDifficultyNotification(params json.RawMessage) {
	var difficulty float64
	if err := json.Unmarshal(params, &difficulty); err != nil {
		return
	}
	
	// Update current job difficulty
	if job := c.currentJob.Load(); job != nil {
		job.Difficulty = difficulty
		c.currentJob.Store(job)
	}
}

func (c *Client) handleExtraNonceNotification(params json.RawMessage) {
	var extraNonceParams []interface{}
	if err := json.Unmarshal(params, &extraNonceParams); err != nil {
		return
	}
	
	if len(extraNonceParams) >= 2 {
		if extraNonce1, ok := extraNonceParams[0].(string); ok {
			c.extraNonce1 = extraNonce1
		}
		if size, ok := extraNonceParams[1].(float64); ok {
			c.extraNonce2Size = int(size)
		}
	}
}

func (c *Client) handleReconnectNotification(params json.RawMessage) {
	// Server requested reconnect
	go c.reconnect()
}

// GetExtraNonce1 returns the extra nonce 1
func (c *Client) GetExtraNonce1() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.extraNonce1
}

// GetExtraNonce2Size returns the extra nonce 2 size
func (c *Client) GetExtraNonce2Size() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.extraNonce2Size
}

// GetDifficulty returns the current difficulty
func (c *Client) GetDifficulty() float64 {
	if job := c.currentJob.Load(); job != nil {
		return job.Difficulty
	}
	return 1.0
}

// IsConnected returns whether the client is connected
func (c *Client) IsConnected() bool {
	return c.connected.Load()
}

// IsAuthorized returns whether the client is authorized
func (c *Client) IsAuthorized() bool {
	return c.authorized.Load()
}

// SwitchPool switches to the next available pool
func (c *Client) SwitchPool() error {
	c.Disconnect()
	c.currentPool = (c.currentPool + 1) % len(c.pools)
	return c.Connect()
}

// Helper function to convert difficulty to target
func DifficultyToTarget(difficulty float64) string {
	// Convert pool difficulty to target
	// This is a simplified version
	if difficulty <= 0 {
		difficulty = 1
	}
	
	maxTarget := new(big.Int)
	maxTarget.SetString("00000000ffff0000000000000000000000000000000000000000000000000000", 16)
	
	target := new(big.Int).Div(maxTarget, big.NewInt(int64(difficulty)))
	return fmt.Sprintf("%064x", target)
}