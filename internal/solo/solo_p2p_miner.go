package solo

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// SoloP2PMiner implements a P2P mining system that works efficiently for a single user
// Can operate in complete isolation or join existing P2P networks seamlessly
type SoloP2PMiner struct {
	logger *zap.Logger
	config Config
	
	// Identity
	minerID    string
	wallet     string
	
	// Mining engine
	miner      *MiningEngine
	difficulty atomic.Value // float64
	
	// P2P capabilities (optional)
	p2pEnabled atomic.Bool
	peers      sync.Map // map[string]*Peer
	peerCount  atomic.Int32
	listener   net.Listener
	
	// Work management
	currentWork *Work
	workMu      sync.RWMutex
	submissions chan *Share
	
	// Solo mining stats
	hashRate    atomic.Uint64
	shares      atomic.Uint64
	blocks      atomic.Uint64
	earnings    atomic.Value // float64
	
	// Chain management
	blockchain  *LocalBlockchain
	shareChain  *ShareChain
	
	// Lifecycle
	ctx        context.Context
	cancel     context.CancelFunc
	wg         sync.WaitGroup
}

// Config for solo P2P miner
type Config struct {
	// Basic settings
	Wallet         string `yaml:"wallet"`
	WorkerName     string `yaml:"worker_name"`
	
	// Mining settings
	Algorithm      string `yaml:"algorithm"`
	Threads        int    `yaml:"threads"`
	Intensity      int    `yaml:"intensity"`
	
	// Solo settings
	NodeRPC        string        `yaml:"node_rpc"`
	BlockPolling   time.Duration `yaml:"block_polling"`
	MinDifficulty  float64       `yaml:"min_difficulty"`
	
	// P2P settings (optional)
	EnableP2P      bool     `yaml:"enable_p2p"`
	P2PPort        int      `yaml:"p2p_port"`
	BootstrapPeers []string `yaml:"bootstrap_peers"`
	MaxPeers       int      `yaml:"max_peers"`
	
	// Share settings
	LocalShares    bool          `yaml:"local_shares"`
	ShareInterval  time.Duration `yaml:"share_interval"`
	ShareWindow    int           `yaml:"share_window"`
	
	// Performance
	CPUAffinity    []int  `yaml:"cpu_affinity"`
	GPUDevices     []int  `yaml:"gpu_devices"`
	AutoTune       bool   `yaml:"auto_tune"`
}

// Work represents mining work
type Work struct {
	JobID      string    `json:"job_id"`
	PrevHash   string    `json:"prev_hash"`
	Target     string    `json:"target"`
	Height     uint64    `json:"height"`
	Difficulty float64   `json:"difficulty"`
	Timestamp  time.Time `json:"timestamp"`
}

// Share represents a mining share/solution
type Share struct {
	ID         string    `json:"id"`
	JobID      string    `json:"job_id"`
	Nonce      uint64    `json:"nonce"`
	Hash       string    `json:"hash"`
	Difficulty float64   `json:"difficulty"`
	Timestamp  time.Time `json:"timestamp"`
	IsBlock    bool      `json:"is_block"`
}

// MiningEngine handles actual mining operations
type MiningEngine struct {
	algorithm   string
	threads     int
	intensity   int
	hashCounter atomic.Uint64
	running     atomic.Bool
}

// LocalBlockchain manages local chain state
type LocalBlockchain struct {
	mu         sync.RWMutex
	blocks     []*Block
	pending    []*Transaction
	difficulty float64
}

// Block represents a blockchain block
type Block struct {
	Height       uint64         `json:"height"`
	Hash         string         `json:"hash"`
	PrevHash     string         `json:"prev_hash"`
	Timestamp    time.Time      `json:"timestamp"`
	Nonce        uint64         `json:"nonce"`
	Difficulty   float64        `json:"difficulty"`
	Transactions []*Transaction `json:"transactions"`
	Miner        string         `json:"miner"`
}

// Transaction represents a blockchain transaction
type Transaction struct {
	ID        string  `json:"id"`
	From      string  `json:"from"`
	To        string  `json:"to"`
	Amount    float64 `json:"amount"`
	Fee       float64 `json:"fee"`
	Timestamp time.Time `json:"timestamp"`
}

// ShareChain manages local share accounting
type ShareChain struct {
	mu       sync.RWMutex
	shares   []*Share
	window   int
	stats    ShareStats
}

// ShareStats tracks share statistics
type ShareStats struct {
	Total      uint64
	Valid      uint64
	Blocks     uint64
	AvgTime    time.Duration
	LastShare  time.Time
	Efficiency float64
}

// NewSoloP2PMiner creates a new solo P2P miner instance
func NewSoloP2PMiner(logger *zap.Logger, config Config) (*SoloP2PMiner, error) {
	// Validate configuration
	if config.Wallet == "" {
		return nil, fmt.Errorf("wallet address required")
	}
	
	// Generate miner ID
	minerID := generateMinerID()
	
	// Set defaults
	if config.Threads <= 0 {
		config.Threads = 1
	}
	if config.ShareWindow <= 0 {
		config.ShareWindow = 100
	}
	if config.MinDifficulty <= 0 {
		config.MinDifficulty = 1.0
	}
	if config.BlockPolling <= 0 {
		config.BlockPolling = 5 * time.Second
	}
	if config.ShareInterval <= 0 {
		config.ShareInterval = 10 * time.Second
	}
	
	miner := &SoloP2PMiner{
		logger:      logger,
		config:      config,
		minerID:     minerID,
		wallet:      config.Wallet,
		submissions: make(chan *Share, 1000),
		blockchain:  NewLocalBlockchain(),
		shareChain:  NewShareChain(config.ShareWindow),
	}
	
	// Initialize mining engine
	miner.miner = &MiningEngine{
		algorithm: config.Algorithm,
		threads:   config.Threads,
		intensity: config.Intensity,
	}
	
	// Set initial difficulty
	miner.difficulty.Store(config.MinDifficulty)
	
	// Initialize earnings
	miner.earnings.Store(0.0)
	
	return miner, nil
}

// Start begins mining operations
func (m *SoloP2PMiner) Start() error {
	m.logger.Info("Starting solo P2P miner",
		zap.String("miner_id", m.minerID),
		zap.String("wallet", m.wallet),
		zap.Bool("p2p_enabled", m.config.EnableP2P),
	)
	
	// Create context
	m.ctx, m.cancel = context.WithCancel(context.Background())
	
	// Start mining engine
	if err := m.miner.Start(); err != nil {
		return fmt.Errorf("failed to start mining engine: %w", err)
	}
	
	// Start work fetcher
	m.wg.Add(1)
	go m.workFetcher()
	
	// Start share processor
	m.wg.Add(1)
	go m.shareProcessor()
	
	// Start mining workers
	for i := 0; i < m.config.Threads; i++ {
		m.wg.Add(1)
		go m.miningWorker(i)
	}
	
	// Start hashrate calculator
	m.wg.Add(1)
	go m.hashRateCalculator()
	
	// Start local share generator if enabled
	if m.config.LocalShares {
		m.wg.Add(1)
		go m.localShareGenerator()
	}
	
	// Start P2P if enabled
	if m.config.EnableP2P {
		if err := m.startP2P(); err != nil {
			m.logger.Warn("Failed to start P2P", zap.Error(err))
			// Continue in solo mode
		}
	}
	
	// Start statistics reporter
	m.wg.Add(1)
	go m.statsReporter()
	
	m.logger.Info("Solo P2P miner started successfully")
	return nil
}

// Stop halts mining operations
func (m *SoloP2PMiner) Stop() error {
	m.logger.Info("Stopping solo P2P miner")
	
	// Stop mining engine
	m.miner.Stop()
	
	// Cancel context
	if m.cancel != nil {
		m.cancel()
	}
	
	// Stop P2P if running
	if m.listener != nil {
		m.listener.Close()
	}
	
	// Disconnect peers
	m.peers.Range(func(key, value interface{}) bool {
		if peer, ok := value.(*Peer); ok {
			peer.Disconnect()
		}
		return true
	})
	
	// Wait for workers
	m.wg.Wait()
	
	// Close channels
	close(m.submissions)
	
	m.logger.Info("Solo P2P miner stopped")
	return nil
}

// GetStats returns current mining statistics
func (m *SoloP2PMiner) GetStats() map[string]interface{} {
	stats := map[string]interface{}{
		"miner_id":    m.minerID,
		"wallet":      m.wallet,
		"algorithm":   m.config.Algorithm,
		"threads":     m.config.Threads,
		"hashrate":    m.hashRate.Load(),
		"shares":      m.shares.Load(),
		"blocks":      m.blocks.Load(),
		"earnings":    m.earnings.Load(),
		"difficulty":  m.difficulty.Load(),
		"p2p_enabled": m.p2pEnabled.Load(),
		"peer_count":  m.peerCount.Load(),
	}
	
	// Add share chain stats
	shareStats := m.shareChain.GetStats()
	stats["share_stats"] = shareStats
	
	// Add blockchain info
	if m.blockchain != nil {
		stats["chain_height"] = m.blockchain.GetHeight()
		stats["chain_difficulty"] = m.blockchain.GetDifficulty()
	}
	
	// Add P2P peer list if enabled
	if m.p2pEnabled.Load() {
		peers := make([]map[string]interface{}, 0)
		m.peers.Range(func(key, value interface{}) bool {
			if peer, ok := value.(*Peer); ok {
				peers = append(peers, peer.GetInfo())
			}
			return true
		})
		stats["peers"] = peers
	}
	
	return stats
}

// SubmitShare processes a share (can be called externally in P2P mode)
func (m *SoloP2PMiner) SubmitShare(share *Share) error {
	select {
	case m.submissions <- share:
		return nil
	case <-m.ctx.Done():
		return fmt.Errorf("miner stopped")
	default:
		return fmt.Errorf("submission queue full")
	}
}

// Private methods

func (m *SoloP2PMiner) workFetcher() {
	defer m.wg.Done()
	
	ticker := time.NewTicker(m.config.BlockPolling)
	defer ticker.Stop()
	
	// Fetch initial work
	m.fetchWork()
	
	for {
		select {
		case <-ticker.C:
			m.fetchWork()
		case <-m.ctx.Done():
			return
		}
	}
}

func (m *SoloP2PMiner) fetchWork() {
	// In a real implementation, this would connect to a node RPC
	// For now, generate mock work
	work := &Work{
		JobID:      generateID(),
		PrevHash:   m.blockchain.GetTipHash(),
		Target:     generateTarget(m.difficulty.Load().(float64)),
		Height:     m.blockchain.GetHeight() + 1,
		Difficulty: m.difficulty.Load().(float64),
		Timestamp:  time.Now(),
	}
	
	m.workMu.Lock()
	m.currentWork = work
	m.workMu.Unlock()
	
	m.logger.Debug("New work fetched",
		zap.String("job_id", work.JobID),
		zap.Uint64("height", work.Height),
		zap.Float64("difficulty", work.Difficulty),
	)
}

func (m *SoloP2PMiner) miningWorker(id int) {
	defer m.wg.Done()
	
	m.logger.Info("Mining worker started", zap.Int("worker_id", id))
	
	for {
		select {
		case <-m.ctx.Done():
			return
		default:
			// Get current work
			m.workMu.RLock()
			work := m.currentWork
			m.workMu.RUnlock()
			
			if work == nil {
				time.Sleep(100 * time.Millisecond)
				continue
			}
			
			// Mine
			nonce := uint64(id) << 56 // Partition nonce space by worker
			for i := 0; i < 100000; i++ {
				if m.ctx.Err() != nil {
					return
				}
				
				// Calculate hash
				hash := m.calculateHash(work, nonce)
				m.miner.hashCounter.Add(1)
				
				// Check difficulty
				if m.checkDifficulty(hash, work.Difficulty) {
					share := &Share{
						ID:         generateID(),
						JobID:      work.JobID,
						Nonce:      nonce,
						Hash:       hex.EncodeToString(hash),
						Difficulty: work.Difficulty,
						Timestamp:  time.Now(),
					}
					
					// Check if it's a block
					if m.checkDifficulty(hash, work.Difficulty*1000) {
						share.IsBlock = true
					}
					
					// Submit share
					m.SubmitShare(share)
				}
				
				nonce++
			}
		}
	}
}

func (m *SoloP2PMiner) shareProcessor() {
	defer m.wg.Done()
	
	for {
		select {
		case share := <-m.submissions:
			if share == nil {
				return
			}
			
			// Add to share chain
			m.shareChain.AddShare(share)
			
			// Update stats
			m.shares.Add(1)
			
			if share.IsBlock {
				m.handleBlockFound(share)
			}
			
			// Broadcast to P2P network if enabled
			if m.p2pEnabled.Load() {
				m.broadcastShare(share)
			}
			
		case <-m.ctx.Done():
			return
		}
	}
}

func (m *SoloP2PMiner) handleBlockFound(share *Share) {
	m.blocks.Add(1)
	
	// Calculate reward (mock)
	reward := 6.25 // BTC example
	currentEarnings := m.earnings.Load().(float64)
	m.earnings.Store(currentEarnings + reward)
	
	// Add block to local chain
	block := &Block{
		Height:     m.blockchain.GetHeight() + 1,
		Hash:       share.Hash,
		PrevHash:   m.blockchain.GetTipHash(),
		Timestamp:  time.Now(),
		Nonce:      share.Nonce,
		Difficulty: share.Difficulty,
		Miner:      m.wallet,
	}
	m.blockchain.AddBlock(block)
	
	m.logger.Info("Block found!",
		zap.String("hash", share.Hash),
		zap.Uint64("height", block.Height),
		zap.Float64("reward", reward),
	)
}

func (m *SoloP2PMiner) hashRateCalculator() {
	defer m.wg.Done()
	
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	
	var lastCount uint64
	
	for {
		select {
		case <-ticker.C:
			currentCount := m.miner.hashCounter.Load()
			rate := (currentCount - lastCount) / 10 // per second
			m.hashRate.Store(rate)
			lastCount = currentCount
			
		case <-m.ctx.Done():
			return
		}
	}
}

func (m *SoloP2PMiner) localShareGenerator() {
	defer m.wg.Done()
	
	ticker := time.NewTicker(m.config.ShareInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			// Generate a local share for tracking
			share := &Share{
				ID:         generateID(),
				JobID:      "local",
				Difficulty: m.config.MinDifficulty,
				Timestamp:  time.Now(),
			}
			m.shareChain.AddShare(share)
			
		case <-m.ctx.Done():
			return
		}
	}
}

func (m *SoloP2PMiner) statsReporter() {
	defer m.wg.Done()
	
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			stats := m.GetStats()
			m.logger.Info("Mining statistics",
				zap.Any("stats", stats),
			)
			
		case <-m.ctx.Done():
			return
		}
	}
}

// P2P methods

func (m *SoloP2PMiner) startP2P() error {
	addr := fmt.Sprintf(":%d", m.config.P2PPort)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("failed to start P2P listener: %w", err)
	}
	
	m.listener = listener
	m.p2pEnabled.Store(true)
	
	// Start accepting connections
	m.wg.Add(1)
	go m.acceptPeers()
	
	// Bootstrap if peers configured
	if len(m.config.BootstrapPeers) > 0 {
		m.wg.Add(1)
		go m.bootstrapPeers()
	}
	
	m.logger.Info("P2P network started", zap.String("address", addr))
	return nil
}

func (m *SoloP2PMiner) acceptPeers() {
	defer m.wg.Done()
	
	for {
		conn, err := m.listener.Accept()
		if err != nil {
			if m.ctx.Err() != nil {
				return
			}
			m.logger.Error("Failed to accept peer", zap.Error(err))
			continue
		}
		
		// Check peer limit
		if m.peerCount.Load() >= int32(m.config.MaxPeers) {
			conn.Close()
			continue
		}
		
		go m.handlePeer(conn)
	}
}

func (m *SoloP2PMiner) handlePeer(conn net.Conn) {
	peer := NewPeer(conn)
	
	// Handshake
	if err := m.performHandshake(peer); err != nil {
		m.logger.Debug("Peer handshake failed", zap.Error(err))
		peer.Disconnect()
		return
	}
	
	// Add peer
	m.peers.Store(peer.ID, peer)
	m.peerCount.Add(1)
	
	m.logger.Info("Peer connected",
		zap.String("peer_id", peer.ID),
		zap.String("address", peer.Address),
	)
	
	// Handle peer messages
	defer func() {
		m.peers.Delete(peer.ID)
		m.peerCount.Add(-1)
		peer.Disconnect()
	}()
	
	for {
		msg, err := peer.ReadMessage()
		if err != nil {
			return
		}
		
		switch msg.Type {
		case "share":
			// Handle share from peer
			var share Share
			if err := json.Unmarshal(msg.Data, &share); err == nil {
				m.shareChain.AddShare(&share)
			}
			
		case "block":
			// Handle block announcement
			var block Block
			if err := json.Unmarshal(msg.Data, &block); err == nil {
				m.logger.Info("Peer found block",
					zap.String("peer_id", peer.ID),
					zap.Uint64("height", block.Height),
				)
			}
			
		case "ping":
			peer.SendMessage(&Message{Type: "pong"})
		}
	}
}

func (m *SoloP2PMiner) performHandshake(peer *Peer) error {
	// Send handshake
	handshake := &Message{
		Type: "handshake",
		Data: mustMarshal(map[string]interface{}{
			"miner_id":   m.minerID,
			"version":    "1.0.0",
			"algorithm":  m.config.Algorithm,
			"difficulty": m.difficulty.Load(),
		}),
	}
	
	if err := peer.SendMessage(handshake); err != nil {
		return err
	}
	
	// Receive response
	msg, err := peer.ReadMessage()
	if err != nil {
		return err
	}
	
	if msg.Type != "handshake" {
		return fmt.Errorf("invalid handshake response")
	}
	
	return nil
}

func (m *SoloP2PMiner) bootstrapPeers() {
	defer m.wg.Done()
	
	for _, addr := range m.config.BootstrapPeers {
		if m.peerCount.Load() >= int32(m.config.MaxPeers) {
			break
		}
		
		conn, err := net.DialTimeout("tcp", addr, 10*time.Second)
		if err != nil {
			m.logger.Debug("Failed to connect to bootstrap peer",
				zap.String("address", addr),
				zap.Error(err),
			)
			continue
		}
		
		go m.handlePeer(conn)
	}
}

func (m *SoloP2PMiner) broadcastShare(share *Share) {
	msg := &Message{
		Type: "share",
		Data: mustMarshal(share),
	}
	
	m.peers.Range(func(key, value interface{}) bool {
		if peer, ok := value.(*Peer); ok {
			peer.SendMessage(msg)
		}
		return true
	})
}

// Helper methods

func (m *SoloP2PMiner) calculateHash(work *Work, nonce uint64) []byte {
	data := fmt.Sprintf("%s:%s:%d:%d", work.JobID, work.PrevHash, work.Height, nonce)
	hash := sha256.Sum256([]byte(data))
	return hash[:]
}

func (m *SoloP2PMiner) checkDifficulty(hash []byte, difficulty float64) bool {
	// Simple difficulty check - count leading zeros
	leadingZeros := 0
	for _, b := range hash {
		if b == 0 {
			leadingZeros += 8
		} else {
			for i := 7; i >= 0; i-- {
				if b&(1<<uint(i)) == 0 {
					leadingZeros++
				} else {
					goto done
				}
			}
		}
	}
done:
	
	requiredZeros := int(difficulty)
	return leadingZeros >= requiredZeros
}

// Helper functions

func generateMinerID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func generateID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func generateTarget(difficulty float64) string {
	// Generate target based on difficulty
	target := make([]byte, 32)
	// Fill with 0xFF and adjust based on difficulty
	for i := range target {
		target[i] = 0xFF
	}
	// Adjust leading bytes based on difficulty
	zerosNeeded := int(difficulty / 8)
	for i := 0; i < zerosNeeded && i < 32; i++ {
		target[i] = 0
	}
	return hex.EncodeToString(target)
}

func mustMarshal(v interface{}) []byte {
	data, _ := json.Marshal(v)
	return data
}

// Supporting types

// MiningEngine methods
func (me *MiningEngine) Start() error {
	me.running.Store(true)
	return nil
}

func (me *MiningEngine) Stop() {
	me.running.Store(false)
}

// LocalBlockchain methods
func NewLocalBlockchain() *LocalBlockchain {
	return &LocalBlockchain{
		blocks:     make([]*Block, 0),
		pending:    make([]*Transaction, 0),
		difficulty: 1.0,
	}
}

func (lb *LocalBlockchain) GetHeight() uint64 {
	lb.mu.RLock()
	defer lb.mu.RUnlock()
	return uint64(len(lb.blocks))
}

func (lb *LocalBlockchain) GetTipHash() string {
	lb.mu.RLock()
	defer lb.mu.RUnlock()
	if len(lb.blocks) == 0 {
		return "0000000000000000000000000000000000000000000000000000000000000000"
	}
	return lb.blocks[len(lb.blocks)-1].Hash
}

func (lb *LocalBlockchain) GetDifficulty() float64 {
	lb.mu.RLock()
	defer lb.mu.RUnlock()
	return lb.difficulty
}

func (lb *LocalBlockchain) AddBlock(block *Block) {
	lb.mu.Lock()
	defer lb.mu.Unlock()
	lb.blocks = append(lb.blocks, block)
}

// ShareChain methods
func NewShareChain(window int) *ShareChain {
	return &ShareChain{
		shares: make([]*Share, 0),
		window: window,
	}
}

func (sc *ShareChain) AddShare(share *Share) {
	sc.mu.Lock()
	defer sc.mu.Unlock()
	
	sc.shares = append(sc.shares, share)
	
	// Update stats
	sc.stats.Total++
	if share.IsBlock {
		sc.stats.Blocks++
	}
	sc.stats.LastShare = share.Timestamp
	
	// Maintain window size
	if len(sc.shares) > sc.window {
		sc.shares = sc.shares[len(sc.shares)-sc.window:]
	}
	
	// Calculate efficiency
	if sc.stats.Total > 0 {
		sc.stats.Efficiency = float64(sc.stats.Valid) / float64(sc.stats.Total) * 100
	}
}

func (sc *ShareChain) GetStats() ShareStats {
	sc.mu.RLock()
	defer sc.mu.RUnlock()
	return sc.stats
}

// Peer represents a P2P network peer
type Peer struct {
	ID        string
	Address   string
	conn      net.Conn
	mu        sync.Mutex
}

// Message represents a P2P message
type Message struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

func NewPeer(conn net.Conn) *Peer {
	return &Peer{
		ID:      generateID(),
		Address: conn.RemoteAddr().String(),
		conn:    conn,
	}
}

func (p *Peer) SendMessage(msg *Message) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	
	encoder := json.NewEncoder(p.conn)
	return encoder.Encode(msg)
}

func (p *Peer) ReadMessage() (*Message, error) {
	decoder := json.NewDecoder(p.conn)
	var msg Message
	err := decoder.Decode(&msg)
	return &msg, err
}

func (p *Peer) Disconnect() {
	p.conn.Close()
}

func (p *Peer) GetInfo() map[string]interface{} {
	return map[string]interface{}{
		"id":      p.ID,
		"address": p.Address,
	}
}