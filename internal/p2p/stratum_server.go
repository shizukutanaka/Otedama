package p2p

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
)

// StratumServer handles stratum protocol connections
type StratumServer struct {
	mu             sync.RWMutex
	poolManager    *PoolManager
	listener       net.Listener
	clients        map[string]*StratumClient
	config         *StratumConfig
	ctx            context.Context
	cancel         context.CancelFunc
	isRunning      atomic.Bool
	messageID      atomic.Uint64
}

// StratumConfig contains stratum server configuration
type StratumConfig struct {
	Address            string
	Port               int
	MaxClients         int
	ShareDifficulty    uint64
	VarDiffEnabled     bool
	VarDiffMinTarget   uint64
	VarDiffMaxTarget   uint64
	VarDiffRetargetTime time.Duration
	ExtraNonceSize     int
}

// StratumClient represents a connected stratum client
type StratumClient struct {
	ID              string
	conn            net.Conn
	reader          *bufio.Reader
	writer          *bufio.Writer
	workerName      string
	workerPassword  string
	authorized      bool
	extraNonce1     string
	difficulty      uint64
	lastShareTime   time.Time
	shares          atomic.Uint64
	invalidShares   atomic.Uint64
	hashRate        atomic.Uint64
	currentJob      *MiningJob
	mu              sync.RWMutex
}

// StratumMessage represents a stratum protocol message
type StratumMessage struct {
	ID     interface{} `json:"id"`
	Method string      `json:"method,omitempty"`
	Params interface{} `json:"params,omitempty"`
	Result interface{} `json:"result,omitempty"`
	Error  interface{} `json:"error,omitempty"`
}

// NewStratumServer creates a new stratum server
func NewStratumServer(pm *PoolManager) *StratumServer {
	ctx, cancel := context.WithCancel(context.Background())
	
	return &StratumServer{
		poolManager: pm,
		clients:     make(map[string]*StratumClient),
		config: &StratumConfig{
			Address:             "0.0.0.0",
			Port:                3333,
			MaxClients:          10000,
			ShareDifficulty:     8192,
			VarDiffEnabled:      true,
			VarDiffMinTarget:    256,
			VarDiffMaxTarget:    65536,
			VarDiffRetargetTime: 60 * time.Second,
			ExtraNonceSize:      4,
		},
		ctx:    ctx,
		cancel: cancel,
	}
}

// Start starts the stratum server
func (ss *StratumServer) Start() error {
	if ss.isRunning.Load() {
		return errors.New("server already running")
	}

	addr := fmt.Sprintf("%s:%d", ss.config.Address, ss.config.Port)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("failed to listen on %s: %w", addr, err)
	}

	ss.listener = listener
	ss.isRunning.Store(true)

	// Start accepting connections
	go ss.acceptConnections()

	// Start difficulty adjustment
	if ss.config.VarDiffEnabled {
		go ss.adjustDifficulty()
	}

	return nil
}

// Stop stops the stratum server
func (ss *StratumServer) Stop() error {
	if !ss.isRunning.Load() {
		return errors.New("server not running")
	}

	ss.cancel()
	ss.isRunning.Store(false)

	if ss.listener != nil {
		ss.listener.Close()
	}

	// Close all client connections
	ss.mu.Lock()
	for _, client := range ss.clients {
		client.conn.Close()
	}
	ss.mu.Unlock()

	return nil
}

// acceptConnections accepts incoming connections
func (ss *StratumServer) acceptConnections() {
	for {
		select {
		case <-ss.ctx.Done():
			return
		default:
			conn, err := ss.listener.Accept()
			if err != nil {
				if !ss.isRunning.Load() {
					return
				}
				continue
			}

			// Check max clients
			if len(ss.clients) >= ss.config.MaxClients {
				conn.Close()
				continue
			}

			// Handle new client
			go ss.handleClient(conn)
		}
	}
}

// handleClient handles a client connection
func (ss *StratumServer) handleClient(conn net.Conn) {
	client := &StratumClient{
		ID:          generateClientID(),
		conn:        conn,
		reader:      bufio.NewReader(conn),
		writer:      bufio.NewWriter(conn),
		difficulty:  ss.config.ShareDifficulty,
		extraNonce1: generateExtraNonce1(ss.config.ExtraNonceSize),
	}

	ss.mu.Lock()
	ss.clients[client.ID] = client
	ss.mu.Unlock()

	defer func() {
		conn.Close()
		ss.mu.Lock()
		delete(ss.clients, client.ID)
		ss.mu.Unlock()
	}()

	// Send mining.subscribe response
	if err := ss.sendSubscribeResponse(client); err != nil {
		return
	}

	// Read messages from client
	for {
		select {
		case <-ss.ctx.Done():
			return
		default:
			// Set read deadline
			conn.SetReadDeadline(time.Now().Add(5 * time.Minute))

			line, err := client.reader.ReadString('\n')
			if err != nil {
				return
			}

			// Parse and handle message
			if err := ss.handleMessage(client, line); err != nil {
				ss.sendError(client, nil, err.Error())
			}
		}
	}
}

// handleMessage handles a stratum message
func (ss *StratumServer) handleMessage(client *StratumClient, data string) error {
	var msg StratumMessage
	if err := json.Unmarshal([]byte(data), &msg); err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}

	switch msg.Method {
	case "mining.subscribe":
		return ss.handleSubscribe(client, msg)
	case "mining.authorize":
		return ss.handleAuthorize(client, msg)
	case "mining.submit":
		return ss.handleSubmit(client, msg)
	case "mining.extranonce.subscribe":
		return ss.handleExtraNonceSubscribe(client, msg)
	default:
		return fmt.Errorf("unknown method: %s", msg.Method)
	}
}

// handleSubscribe handles mining.subscribe
func (ss *StratumServer) handleSubscribe(client *StratumClient, msg StratumMessage) error {
	// Already handled in connection setup
	return nil
}

// sendSubscribeResponse sends mining.subscribe response
func (ss *StratumServer) sendSubscribeResponse(client *StratumClient) error {
	response := StratumMessage{
		ID: 1,
		Result: []interface{}{
			[]interface{}{
				[]string{"mining.set_difficulty", generateSubscriptionID()},
				[]string{"mining.notify", generateSubscriptionID()},
			},
			client.extraNonce1,
			ss.config.ExtraNonceSize,
		},
		Error: nil,
	}

	return ss.sendMessage(client, response)
}

// handleAuthorize handles mining.authorize
func (ss *StratumServer) handleAuthorize(client *StratumClient, msg StratumMessage) error {
	params, ok := msg.Params.([]interface{})
	if !ok || len(params) < 2 {
		return errors.New("invalid params")
	}

	workerName, ok := params[0].(string)
	if !ok {
		return errors.New("invalid worker name")
	}

	workerPassword, ok := params[1].(string)
	if !ok {
		workerPassword = ""
	}

	client.mu.Lock()
	client.workerName = workerName
	client.workerPassword = workerPassword
	client.authorized = true
	client.mu.Unlock()

	// Send authorization response
	response := StratumMessage{
		ID:     msg.ID,
		Result: true,
		Error:  nil,
	}

	if err := ss.sendMessage(client, response); err != nil {
		return err
	}

	// Send initial difficulty
	if err := ss.sendDifficulty(client); err != nil {
		return err
	}

	// Send current job
	if job := ss.poolManager.GetCurrentJob(); job != nil {
		return ss.sendJob(client, job)
	}

	return nil
}

// handleSubmit handles mining.submit
func (ss *StratumServer) handleSubmit(client *StratumClient, msg StratumMessage) error {
	if !client.authorized {
		return errors.New("not authorized")
	}

	params, ok := msg.Params.([]interface{})
	if !ok || len(params) < 5 {
		return errors.New("invalid params")
	}

	// Parse submission parameters
	workerName := params[0].(string)
	jobID := params[1].(string)
	extraNonce2 := params[2].(string)
	ntime := params[3].(string)
	nonce := params[4].(string)

	// Create share
	share := &Share{
		ID:           generateShareID(),
		JobID:        jobID,
		MinerAddress: workerName,
		// Parse nonce from hex string
		// Additional processing needed here
		SubmittedAt:  time.Now(),
	}

	// Submit share to pool manager
	if err := ss.poolManager.SubmitShare(share); err != nil {
		client.invalidShares.Add(1)
		
		response := StratumMessage{
			ID:     msg.ID,
			Result: false,
			Error:  []interface{}{21, err.Error(), nil},
		}
		return ss.sendMessage(client, response)
	}

	// Update client statistics
	client.shares.Add(1)
	client.lastShareTime = time.Now()

	// Send success response
	response := StratumMessage{
		ID:     msg.ID,
		Result: true,
		Error:  nil,
	}

	return ss.sendMessage(client, response)
}

// handleExtraNonceSubscribe handles mining.extranonce.subscribe
func (ss *StratumServer) handleExtraNonceSubscribe(client *StratumClient, msg StratumMessage) error {
	response := StratumMessage{
		ID:     msg.ID,
		Result: true,
		Error:  nil,
	}

	return ss.sendMessage(client, response)
}

// sendDifficulty sends mining.set_difficulty
func (ss *StratumServer) sendDifficulty(client *StratumClient) error {
	msg := StratumMessage{
		ID:     nil,
		Method: "mining.set_difficulty",
		Params: []interface{}{client.difficulty},
	}

	return ss.sendMessage(client, msg)
}

// sendJob sends mining.notify
func (ss *StratumServer) sendJob(client *StratumClient, job *MiningJob) error {
	msg := StratumMessage{
		ID:     nil,
		Method: "mining.notify",
		Params: []interface{}{
			job.ID,
			job.PreviousHash,
			generateCoinbase(job, client.extraNonce1),
			job.MerkleRoot,
			[]string{}, // Merkle branches
			fmt.Sprintf("%08x", job.Height),
			"00000000", // Bits (difficulty)
			fmt.Sprintf("%08x", time.Now().Unix()),
			true, // Clean jobs
		},
	}

	client.mu.Lock()
	client.currentJob = job
	client.mu.Unlock()

	return ss.sendMessage(client, msg)
}

// sendError sends error response
func (ss *StratumServer) sendError(client *StratumClient, id interface{}, errMsg string) error {
	msg := StratumMessage{
		ID:     id,
		Result: nil,
		Error:  []interface{}{20, errMsg, nil},
	}

	return ss.sendMessage(client, msg)
}

// sendMessage sends a message to client
func (ss *StratumServer) sendMessage(client *StratumClient, msg StratumMessage) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}

	client.mu.Lock()
	defer client.mu.Unlock()

	if _, err := client.writer.Write(data); err != nil {
		return err
	}

	if _, err := client.writer.WriteString("\n"); err != nil {
		return err
	}

	return client.writer.Flush()
}

// BroadcastJob broadcasts a job to all clients
func (ss *StratumServer) BroadcastJob(job *MiningJob) {
	ss.mu.RLock()
	clients := make([]*StratumClient, 0, len(ss.clients))
	for _, client := range ss.clients {
		if client.authorized {
			clients = append(clients, client)
		}
	}
	ss.mu.RUnlock()

	for _, client := range clients {
		go ss.sendJob(client, job)
	}
}

// adjustDifficulty adjusts difficulty for clients
func (ss *StratumServer) adjustDifficulty() {
	ticker := time.NewTicker(ss.config.VarDiffRetargetTime)
	defer ticker.Stop()

	for {
		select {
		case <-ss.ctx.Done():
			return
		case <-ticker.C:
			ss.adjustClientDifficulties()
		}
	}
}

// adjustClientDifficulties adjusts difficulties for all clients
func (ss *StratumServer) adjustClientDifficulties() {
	ss.mu.RLock()
	clients := make([]*StratumClient, 0, len(ss.clients))
	for _, client := range ss.clients {
		clients = append(clients, client)
	}
	ss.mu.RUnlock()

	for _, client := range clients {
		ss.adjustClientDifficulty(client)
	}
}

// adjustClientDifficulty adjusts difficulty for a single client
func (ss *StratumServer) adjustClientDifficulty(client *StratumClient) {
	timeSinceLastShare := time.Since(client.lastShareTime)
	shares := client.shares.Load()

	if shares == 0 {
		return
	}

	// Calculate shares per minute
	sharesPerMinute := float64(shares) / timeSinceLastShare.Minutes()

	// Target: 10-20 shares per minute
	targetSharesPerMinute := 15.0

	client.mu.Lock()
	oldDiff := client.difficulty

	if sharesPerMinute > targetSharesPerMinute*1.5 {
		// Increase difficulty
		client.difficulty = min(client.difficulty*2, ss.config.VarDiffMaxTarget)
	} else if sharesPerMinute < targetSharesPerMinute*0.5 {
		// Decrease difficulty
		client.difficulty = max(client.difficulty/2, ss.config.VarDiffMinTarget)
	}

	newDiff := client.difficulty
	client.mu.Unlock()

	// Send new difficulty if changed
	if oldDiff != newDiff {
		ss.sendDifficulty(client)
	}
}

// GetStats returns stratum server statistics
func (ss *StratumServer) GetStats() map[string]interface{} {
	ss.mu.RLock()
	defer ss.mu.RUnlock()

	totalShares := uint64(0)
	totalInvalidShares := uint64(0)

	for _, client := range ss.clients {
		totalShares += client.shares.Load()
		totalInvalidShares += client.invalidShares.Load()
	}

	return map[string]interface{}{
		"connected_clients": len(ss.clients),
		"total_shares":      totalShares,
		"invalid_shares":    totalInvalidShares,
		"share_difficulty":  ss.config.ShareDifficulty,
		"vardiff_enabled":   ss.config.VarDiffEnabled,
	}
}

// Helper functions

func generateClientID() string {
	return fmt.Sprintf("client_%d", time.Now().UnixNano())
}

func generateShareID() string {
	return fmt.Sprintf("share_%d", time.Now().UnixNano())
}

func generateSubscriptionID() string {
	return fmt.Sprintf("sub_%d", time.Now().UnixNano())
}

func generateExtraNonce1(size int) string {
	// Generate random extra nonce
	return fmt.Sprintf("%0*x", size*2, time.Now().UnixNano()&0xFFFFFFFF)
}

func generateCoinbase(job *MiningJob, extraNonce1 string) string {
	// Generate coinbase transaction
	// This is simplified - actual implementation would be more complex
	return fmt.Sprintf("%s%s", job.ID, extraNonce1)
}

func min(a, b uint64) uint64 {
	if a < b {
		return a
	}
	return b
}

func max(a, b uint64) uint64 {
	if a > b {
		return a
	}
	return b
}
