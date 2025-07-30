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

// SimpleStratumServer provides a lightweight Stratum protocol implementation
// Following Rob Pike's principle: "Make it correct, then make it fast"
type SimpleStratumServer struct {
	logger   *zap.Logger
	listener net.Listener
	
	// Connection management
	clients     map[string]*StratumClient
	clientMutex sync.RWMutex
	
	// Job management
	currentJob  atomic.Value // stores *StratumJob
	jobCounter  atomic.Uint64
	
	// Configuration
	address         string
	maxClients      int
	shareTargetTime int // seconds between shares
	
	// Callbacks
	onShare    func(*Share) error
	onNewBlock func() *StratumJob
	
	// State
	running atomic.Bool
	ctx     context.Context
	cancel  context.CancelFunc
	wg      sync.WaitGroup
}

// StratumClient represents a connected miner
type StratumClient struct {
	id         string
	conn       net.Conn
	reader     *bufio.Reader
	writer     *bufio.Writer
	
	// Client info
	workerName string
	userAgent  string
	
	// State
	authorized    bool
	difficulty    uint64
	extraNonce1   uint32
	
	// Performance
	sharesSubmitted atomic.Uint64
	sharesAccepted  atomic.Uint64
	lastShareTime   atomic.Int64
	
	// Connection state
	connected atomic.Bool
	mu        sync.Mutex
}

// StratumJob represents a mining job
type StratumJob struct {
	ID           string
	PrevHash     string
	CoinbaseA    string
	CoinbaseB    string
	MerkleBranch []string
	Version      string
	NBits        string
	NTime        string
	CleanJobs    bool
}

// Share represents a submitted share
type Share struct {
	ClientID   string
	WorkerName string
	JobID      string
	Nonce      string
	NTime      string
	ExtraNonce2 string
	Difficulty uint64
	Timestamp  time.Time
}

// Message types
type StratumMessage struct {
	ID     interface{}     `json:"id"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result interface{}     `json:"result,omitempty"`
	Error  interface{}     `json:"error,omitempty"`
}

// NewSimpleStratumServer creates a new Stratum server
func NewSimpleStratumServer(logger *zap.Logger, address string) *SimpleStratumServer {
	ctx, cancel := context.WithCancel(context.Background())
	
	return &SimpleStratumServer{
		logger:          logger,
		address:         address,
		clients:         make(map[string]*StratumClient),
		maxClients:      1000,
		shareTargetTime: 30,
		ctx:             ctx,
		cancel:          cancel,
	}
}

// SetCallbacks sets the server callbacks
func (s *SimpleStratumServer) SetCallbacks(onShare func(*Share) error, onNewBlock func() *StratumJob) {
	s.onShare = onShare
	s.onNewBlock = onNewBlock
}

// Start starts the Stratum server
func (s *SimpleStratumServer) Start() error {
	if !s.running.CompareAndSwap(false, true) {
		return errors.New("server already running")
	}
	
	// Start listening
	listener, err := net.Listen("tcp", s.address)
	if err != nil {
		return fmt.Errorf("failed to listen: %w", err)
	}
	s.listener = listener
	
	// Start accept loop
	s.wg.Add(1)
	go s.acceptLoop()
	
	// Start job broadcaster
	s.wg.Add(1)
	go s.jobBroadcaster()
	
	s.logger.Info("Stratum server started", zap.String("address", s.address))
	return nil
}

// Stop stops the Stratum server
func (s *SimpleStratumServer) Stop() {
	if s.running.CompareAndSwap(true, false) {
		s.cancel()
		
		if s.listener != nil {
			s.listener.Close()
		}
		
		// Disconnect all clients
		s.clientMutex.Lock()
		for _, client := range s.clients {
			client.disconnect()
		}
		s.clientMutex.Unlock()
		
		s.wg.Wait()
		s.logger.Info("Stratum server stopped")
	}
}

// BroadcastJob broadcasts a new job to all clients
func (s *SimpleStratumServer) BroadcastJob(job *StratumJob) {
	s.currentJob.Store(job)
	
	// Notify all connected clients
	s.clientMutex.RLock()
	clients := make([]*StratumClient, 0, len(s.clients))
	for _, client := range s.clients {
		if client.connected.Load() && client.authorized {
			clients = append(clients, client)
		}
	}
	s.clientMutex.RUnlock()
	
	// Send job to each client
	for _, client := range clients {
		go client.sendJob(job)
	}
	
	s.logger.Info("Broadcasted new job", zap.String("job_id", job.ID))
}

// Private methods

func (s *SimpleStratumServer) acceptLoop() {
	defer s.wg.Done()
	
	for s.running.Load() {
		conn, err := s.listener.Accept()
		if err != nil {
			if s.running.Load() {
				s.logger.Error("Accept error", zap.Error(err))
			}
			continue
		}
		
		// Check client limit
		s.clientMutex.RLock()
		numClients := len(s.clients)
		s.clientMutex.RUnlock()
		
		if numClients >= s.maxClients {
			conn.Close()
			s.logger.Warn("Rejected client - max clients reached")
			continue
		}
		
		// Handle new client
		go s.handleClient(conn)
	}
}

func (s *SimpleStratumServer) handleClient(conn net.Conn) {
	clientID := fmt.Sprintf("%s-%d", conn.RemoteAddr().String(), time.Now().UnixNano())
	
	client := &StratumClient{
		id:          clientID,
		conn:        conn,
		reader:      bufio.NewReader(conn),
		writer:      bufio.NewWriter(conn),
		difficulty:  1,
		extraNonce1: uint32(time.Now().UnixNano()),
	}
	client.connected.Store(true)
	
	// Register client
	s.clientMutex.Lock()
	s.clients[clientID] = client
	s.clientMutex.Unlock()
	
	// Cleanup on disconnect
	defer func() {
		client.disconnect()
		s.clientMutex.Lock()
		delete(s.clients, clientID)
		s.clientMutex.Unlock()
		
		s.logger.Debug("Client disconnected", zap.String("client_id", clientID))
	}()
	
	s.logger.Debug("Client connected", zap.String("client_id", clientID))
	
	// Handle client messages
	for client.connected.Load() {
		// Set read deadline
		conn.SetReadDeadline(time.Now().Add(5 * time.Minute))
		
		// Read message
		line, err := client.reader.ReadString('\n')
		if err != nil {
			if err != net.ErrClosed {
				s.logger.Debug("Read error", zap.Error(err))
			}
			break
		}
		
		// Parse and handle message
		var msg StratumMessage
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			s.logger.Warn("Invalid message", zap.String("data", line))
			continue
		}
		
		s.handleMessage(client, &msg)
	}
}

func (s *SimpleStratumServer) handleMessage(client *StratumClient, msg *StratumMessage) {
	switch msg.Method {
	case "mining.subscribe":
		s.handleSubscribe(client, msg)
		
	case "mining.authorize":
		s.handleAuthorize(client, msg)
		
	case "mining.submit":
		s.handleSubmit(client, msg)
		
	case "mining.get_version":
		s.handleGetVersion(client, msg)
		
	default:
		s.logger.Debug("Unknown method", zap.String("method", msg.Method))
	}
}

func (s *SimpleStratumServer) handleSubscribe(client *StratumClient, msg *StratumMessage) {
	// Parse params
	var params []interface{}
	if err := json.Unmarshal(msg.Params, &params); err == nil && len(params) > 0 {
		if ua, ok := params[0].(string); ok {
			client.userAgent = ua
		}
	}
	
	// Send response
	response := StratumMessage{
		ID: msg.ID,
		Result: []interface{}{
			[][]string{
				{"mining.set_difficulty", fmt.Sprintf("%x", client.extraNonce1)},
				{"mining.notify", fmt.Sprintf("%x", client.extraNonce1)},
			},
			fmt.Sprintf("%08x", client.extraNonce1),
			4, // extraNonce2 size
		},
		Error: nil,
	}
	
	client.sendMessage(&response)
	
	// Send initial difficulty
	client.sendDifficulty(client.difficulty)
}

func (s *SimpleStratumServer) handleAuthorize(client *StratumClient, msg *StratumMessage) {
	// Parse params
	var params []string
	if err := json.Unmarshal(msg.Params, &params); err == nil && len(params) > 0 {
		client.workerName = params[0]
	}
	
	// Authorize (simple implementation - always accept)
	client.authorized = true
	
	// Send response
	response := StratumMessage{
		ID:     msg.ID,
		Result: true,
		Error:  nil,
	}
	
	client.sendMessage(&response)
	
	// Send current job
	if job := s.currentJob.Load(); job != nil {
		client.sendJob(job.(*StratumJob))
	}
	
	s.logger.Info("Client authorized", 
		zap.String("client_id", client.id),
		zap.String("worker", client.workerName),
	)
}

func (s *SimpleStratumServer) handleSubmit(client *StratumClient, msg *StratumMessage) {
	// Parse params: [worker_name, job_id, extranonce2, ntime, nonce]
	var params []string
	if err := json.Unmarshal(msg.Params, &params); err != nil || len(params) < 5 {
		client.sendError(msg.ID, "Invalid parameters")
		return
	}
	
	share := &Share{
		ClientID:    client.id,
		WorkerName:  params[0],
		JobID:       params[1],
		ExtraNonce2: params[2],
		NTime:       params[3],
		Nonce:       params[4],
		Difficulty:  client.difficulty,
		Timestamp:   time.Now(),
	}
	
	// Update stats
	client.sharesSubmitted.Add(1)
	client.lastShareTime.Store(time.Now().Unix())
	
	// Validate share
	var err error
	if s.onShare != nil {
		err = s.onShare(share)
	}
	
	if err == nil {
		client.sharesAccepted.Add(1)
		
		// Send success response
		response := StratumMessage{
			ID:     msg.ID,
			Result: true,
			Error:  nil,
		}
		client.sendMessage(&response)
		
		// Adjust difficulty if needed
		s.adjustDifficulty(client)
	} else {
		// Send error response
		client.sendError(msg.ID, err.Error())
	}
}

func (s *SimpleStratumServer) handleGetVersion(client *StratumClient, msg *StratumMessage) {
	response := StratumMessage{
		ID:     msg.ID,
		Result: "Otedama/1.0",
		Error:  nil,
	}
	client.sendMessage(&response)
}

func (s *SimpleStratumServer) adjustDifficulty(client *StratumClient) {
	lastShare := client.lastShareTime.Load()
	if lastShare == 0 {
		return
	}
	
	timeSinceLastShare := time.Now().Unix() - lastShare
	
	// Adjust difficulty to target share time
	if timeSinceLastShare < int64(s.shareTargetTime/2) {
		// Too fast, increase difficulty
		newDiff := client.difficulty * 2
		client.difficulty = newDiff
		client.sendDifficulty(newDiff)
	} else if timeSinceLastShare > int64(s.shareTargetTime*2) {
		// Too slow, decrease difficulty
		newDiff := client.difficulty / 2
		if newDiff < 1 {
			newDiff = 1
		}
		client.difficulty = newDiff
		client.sendDifficulty(newDiff)
	}
}

func (s *SimpleStratumServer) jobBroadcaster() {
	defer s.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			// Request new job from callback
			if s.onNewBlock != nil {
				if job := s.onNewBlock(); job != nil {
					s.BroadcastJob(job)
				}
			}
		}
	}
}

// Client methods

func (c *StratumClient) sendMessage(msg *StratumMessage) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	
	if _, err := c.writer.Write(data); err != nil {
		return err
	}
	
	if err := c.writer.WriteByte('\n'); err != nil {
		return err
	}
	
	return c.writer.Flush()
}

func (c *StratumClient) sendJob(job *StratumJob) {
	msg := StratumMessage{
		ID:     nil,
		Method: "mining.notify",
		Params: json.RawMessage(fmt.Sprintf(
			`["%s","%s","%s","%s",%s,"%s","%s","%s",%t]`,
			job.ID,
			job.PrevHash,
			job.CoinbaseA,
			job.CoinbaseB,
			jsonArray(job.MerkleBranch),
			job.Version,
			job.NBits,
			job.NTime,
			job.CleanJobs,
		)),
	}
	
	c.sendMessage(&msg)
}

func (c *StratumClient) sendDifficulty(difficulty uint64) {
	msg := StratumMessage{
		ID:     nil,
		Method: "mining.set_difficulty",
		Params: json.RawMessage(fmt.Sprintf(`[%d]`, difficulty)),
	}
	
	c.sendMessage(&msg)
}

func (c *StratumClient) sendError(id interface{}, message string) {
	msg := StratumMessage{
		ID:     id,
		Result: nil,
		Error:  []interface{}{20, message, nil},
	}
	
	c.sendMessage(&msg)
}

func (c *StratumClient) disconnect() {
	if c.connected.CompareAndSwap(true, false) {
		c.conn.Close()
	}
}

// Helper functions

func jsonArray(items []string) string {
	result := "["
	for i, item := range items {
		if i > 0 {
			result += ","
		}
		result += fmt.Sprintf(`"%s"`, item)
	}
	result += "]"
	return result
}

// SimpleStratumClient provides a Stratum client implementation
type SimpleStratumClient struct {
	logger *zap.Logger
	
	// Connection
	conn   net.Conn
	reader *bufio.Reader
	writer *bufio.Writer
	
	// Configuration
	serverAddr string
	workerName string
	password   string
	
	// State
	connected    atomic.Bool
	subscribed   bool
	authorized   bool
	extraNonce1  string
	extraNonce2Size int
	
	// Current job
	currentJob atomic.Value // stores *StratumJob
	
	// Callbacks
	onNewJob func(*StratumJob)
	
	// Message handling
	msgID    atomic.Uint64
	pending  map[uint64]chan *StratumMessage
	pendingMu sync.Mutex
	
	// Lifecycle
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// NewSimpleStratumClient creates a new Stratum client
func NewSimpleStratumClient(logger *zap.Logger, serverAddr, workerName, password string) *SimpleStratumClient {
	ctx, cancel := context.WithCancel(context.Background())
	
	return &SimpleStratumClient{
		logger:     logger,
		serverAddr: serverAddr,
		workerName: workerName,
		password:   password,
		pending:    make(map[uint64]chan *StratumMessage),
		ctx:        ctx,
		cancel:     cancel,
	}
}

// Connect connects to the Stratum server
func (c *SimpleStratumClient) Connect() error {
	conn, err := net.DialTimeout("tcp", c.serverAddr, 30*time.Second)
	if err != nil {
		return fmt.Errorf("failed to connect: %w", err)
	}
	
	c.conn = conn
	c.reader = bufio.NewReader(conn)
	c.writer = bufio.NewWriter(conn)
	c.connected.Store(true)
	
	// Start message reader
	c.wg.Add(1)
	go c.readMessages()
	
	// Subscribe
	if err := c.subscribe(); err != nil {
		c.Disconnect()
		return err
	}
	
	// Authorize
	if err := c.authorize(); err != nil {
		c.Disconnect()
		return err
	}
	
	c.logger.Info("Connected to Stratum server", zap.String("server", c.serverAddr))
	return nil
}

// Disconnect disconnects from the server
func (c *SimpleStratumClient) Disconnect() {
	if c.connected.CompareAndSwap(true, false) {
		c.cancel()
		
		if c.conn != nil {
			c.conn.Close()
		}
		
		c.wg.Wait()
		c.logger.Info("Disconnected from Stratum server")
	}
}

// SubmitShare submits a share to the server
func (c *SimpleStratumClient) SubmitShare(jobID, extraNonce2, ntime, nonce string) error {
	if !c.connected.Load() || !c.authorized {
		return errors.New("not connected or authorized")
	}
	
	msg := StratumMessage{
		ID:     c.nextMsgID(),
		Method: "mining.submit",
		Params: json.RawMessage(fmt.Sprintf(
			`["%s","%s","%s","%s","%s"]`,
			c.workerName,
			jobID,
			extraNonce2,
			ntime,
			nonce,
		)),
	}
	
	response, err := c.sendAndWait(&msg, 30*time.Second)
	if err != nil {
		return err
	}
	
	if result, ok := response.Result.(bool); ok && result {
		return nil
	}
	
	return errors.New("share rejected")
}

// SetJobCallback sets the callback for new jobs
func (c *SimpleStratumClient) SetJobCallback(callback func(*StratumJob)) {
	c.onNewJob = callback
}

// GetCurrentJob returns the current job
func (c *SimpleStratumClient) GetCurrentJob() *StratumJob {
	if job := c.currentJob.Load(); job != nil {
		return job.(*StratumJob)
	}
	return nil
}

// Private methods

func (c *SimpleStratumClient) subscribe() error {
	msg := StratumMessage{
		ID:     c.nextMsgID(),
		Method: "mining.subscribe",
		Params: json.RawMessage(`["Otedama/1.0"]`),
	}
	
	response, err := c.sendAndWait(&msg, 10*time.Second)
	if err != nil {
		return fmt.Errorf("subscribe failed: %w", err)
	}
	
	// Parse subscription result
	if result, ok := response.Result.([]interface{}); ok && len(result) >= 3 {
		c.extraNonce1 = result[1].(string)
		c.extraNonce2Size = int(result[2].(float64))
		c.subscribed = true
		return nil
	}
	
	return errors.New("invalid subscription response")
}

func (c *SimpleStratumClient) authorize() error {
	msg := StratumMessage{
		ID:     c.nextMsgID(),
		Method: "mining.authorize",
		Params: json.RawMessage(fmt.Sprintf(`["%s","%s"]`, c.workerName, c.password)),
	}
	
	response, err := c.sendAndWait(&msg, 10*time.Second)
	if err != nil {
		return fmt.Errorf("authorize failed: %w", err)
	}
	
	if result, ok := response.Result.(bool); ok && result {
		c.authorized = true
		return nil
	}
	
	return errors.New("authorization rejected")
}

func (c *SimpleStratumClient) readMessages() {
	defer c.wg.Done()
	
	for c.connected.Load() {
		c.conn.SetReadDeadline(time.Now().Add(5 * time.Minute))
		
		line, err := c.reader.ReadString('\n')
		if err != nil {
			if c.connected.Load() {
				c.logger.Error("Read error", zap.Error(err))
			}
			break
		}
		
		var msg StratumMessage
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			c.logger.Warn("Invalid message", zap.String("data", line))
			continue
		}
		
		// Handle notification or response
		if msg.Method != "" {
			c.handleNotification(&msg)
		} else if id, ok := msg.ID.(float64); ok {
			c.handleResponse(uint64(id), &msg)
		}
	}
}

func (c *SimpleStratumClient) handleNotification(msg *StratumMessage) {
	switch msg.Method {
	case "mining.notify":
		c.handleJobNotification(msg)
	case "mining.set_difficulty":
		c.handleDifficultyNotification(msg)
	}
}

func (c *SimpleStratumClient) handleJobNotification(msg *StratumMessage) {
	// Parse job parameters
	var params []interface{}
	if err := json.Unmarshal(msg.Params, &params); err != nil || len(params) < 9 {
		c.logger.Error("Invalid job notification")
		return
	}
	
	job := &StratumJob{
		ID:           params[0].(string),
		PrevHash:     params[1].(string),
		CoinbaseA:    params[2].(string),
		CoinbaseB:    params[3].(string),
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
	
	c.currentJob.Store(job)
	
	if c.onNewJob != nil {
		c.onNewJob(job)
	}
}

func (c *SimpleStratumClient) handleDifficultyNotification(msg *StratumMessage) {
	// Parse difficulty
	var params []interface{}
	if err := json.Unmarshal(msg.Params, &params); err != nil || len(params) < 1 {
		c.logger.Error("Invalid difficulty notification")
		return
	}
	
	if diff, ok := params[0].(float64); ok {
		c.logger.Info("Difficulty changed", zap.Float64("difficulty", diff))
	}
}

func (c *SimpleStratumClient) handleResponse(id uint64, msg *StratumMessage) {
	c.pendingMu.Lock()
	ch, exists := c.pending[id]
	if exists {
		delete(c.pending, id)
	}
	c.pendingMu.Unlock()
	
	if exists {
		ch <- msg
		close(ch)
	}
}

func (c *SimpleStratumClient) sendAndWait(msg *StratumMessage, timeout time.Duration) (*StratumMessage, error) {
	ch := make(chan *StratumMessage, 1)
	
	// Register pending response
	id := msg.ID.(uint64)
	c.pendingMu.Lock()
	c.pending[id] = ch
	c.pendingMu.Unlock()
	
	// Send message
	if err := c.sendMessage(msg); err != nil {
		c.pendingMu.Lock()
		delete(c.pending, id)
		c.pendingMu.Unlock()
		return nil, err
	}
	
	// Wait for response
	select {
	case response := <-ch:
		return response, nil
	case <-time.After(timeout):
		c.pendingMu.Lock()
		delete(c.pending, id)
		c.pendingMu.Unlock()
		return nil, errors.New("timeout waiting for response")
	}
}

func (c *SimpleStratumClient) sendMessage(msg *StratumMessage) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	
	if _, err := c.writer.Write(data); err != nil {
		return err
	}
	
	if err := c.writer.WriteByte('\n'); err != nil {
		return err
	}
	
	return c.writer.Flush()
}

func (c *SimpleStratumClient) nextMsgID() uint64 {
	return c.msgID.Add(1)
}