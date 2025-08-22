// Package p2p provides P2P mining pool functionality for Otedama
// Design: Decentralized, resilient, efficient (Carmack/Pike/Martin)
package p2p

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// Constants
const (
	ProtocolVersion = 1
	MaxPeers        = 100
	MaxMessageSize  = 10 * 1024 * 1024 // 10MB
	HandshakeTimeout = 10 * time.Second
	PingInterval    = 30 * time.Second
	ShareWindow     = 3600 // 1 hour in seconds
	MinShareDiff    = 1000000
)

// P2PPool represents a decentralized mining pool
type P2PPool struct {
	mu       sync.RWMutex
	ctx      context.Context
	cancel   context.CancelFunc
	
	// Network
	listener net.Listener
	peers    map[string]*Peer
	peerLock sync.RWMutex
	
	// Pool state
	currentJob    atomic.Pointer[PoolJob]
	shares        *ShareManager
	blockchain    *BlockchainState
	
	// Statistics
	stats         *PoolStats
	
	// Configuration
	config        P2PConfig
	
	// Channels
	jobChan       chan *PoolJob
	shareChan     chan *Share
	blockChan     chan *Block
	
	// Consensus
	consensus     *Consensus
}

// P2PConfig contains P2P pool configuration
type P2PConfig struct {
	ListenAddr    string
	BootstrapPeers []string
	MaxPeers      int
	ShareDifficulty *big.Int
	BlockReward   *big.Int
	FeePercent    float64
	PayoutInterval time.Duration
	MinPayout     *big.Int
}

// Peer represents a connected peer
type Peer struct {
	ID           string
	Address      string
	Conn         net.Conn
	Version      int
	Hashrate     atomic.Uint64
	ShareCount   atomic.Uint64
	LastSeen     atomic.Int64
	Reputation   atomic.Int32
	mu           sync.RWMutex
	sendQueue    chan Message
	ctx          context.Context
	cancel       context.CancelFunc
}

// PoolJob represents a mining job in the pool
type PoolJob struct {
	ID            string
	Height        uint64
	PreviousHash  []byte
	Coinbase      []byte
	MerkleRoot    []byte
	Timestamp     int64
	Bits          uint32
	Target        *big.Int
	Transactions  []Transaction
	CreatedAt     time.Time
}

// Share represents a mining share
type Share struct {
	ID           string
	JobID        string
	MinerID      string
	Nonce        uint64
	Hash         []byte
	Difficulty   *big.Int
	Timestamp    time.Time
	Valid        bool
}

// Block represents a found block
type Block struct {
	Height       uint64
	Hash         []byte
	PreviousHash []byte
	Timestamp    int64
	Nonce        uint64
	Difficulty   *big.Int
	Reward       *big.Int
	Shares       []Share
	FinderID     string
}

// Transaction represents a blockchain transaction
type Transaction struct {
	ID       string
	From     string
	To       string
	Amount   *big.Int
	Fee      *big.Int
	Data     []byte
}

// ShareManager manages share accounting
type ShareManager struct {
	mu           sync.RWMutex
	shares       map[string][]*Share
	window       time.Duration
	totalShares  atomic.Uint64
	validShares  atomic.Uint64
}

// BlockchainState tracks blockchain state
type BlockchainState struct {
	mu           sync.RWMutex
	height       atomic.Uint64
	difficulty   atomic.Pointer[big.Int]
	lastBlock    atomic.Pointer[Block]
	chainTip     []byte
}

// PoolStats tracks pool statistics
type PoolStats struct {
	StartTime       time.Time
	TotalHashrate   atomic.Uint64
	ActiveMiners    atomic.Uint32
	TotalShares     atomic.Uint64
	ValidShares     atomic.Uint64
	BlocksFound     atomic.Uint64
	TotalRewards    atomic.Pointer[big.Int]
	LastBlockTime   atomic.Int64
}

// Consensus manages pool consensus
type Consensus struct {
	mu           sync.RWMutex
	validators   map[string]*Validator
	currentRound uint64
	votes        map[string]int
}

// Validator represents a consensus validator
type Validator struct {
	ID         string
	Stake      *big.Int
	Reputation int32
	LastVote   time.Time
}

// Message types
type MessageType uint8

const (
	MsgHandshake MessageType = iota
	MsgJob
	MsgShare
	MsgBlock
	MsgTransaction
	MsgPing
	MsgPong
	MsgGetPeers
	MsgPeers
	MsgConsensus
)

// Message represents a P2P message
type Message struct {
	Type      MessageType
	Version   int
	Timestamp int64
	Payload   []byte
}

// NewP2PPool creates a new P2P mining pool
func NewP2PPool(config P2PConfig) (*P2PPool, error) {
	if config.MaxPeers == 0 {
		config.MaxPeers = MaxPeers
	}
	if config.ShareDifficulty == nil {
		config.ShareDifficulty = big.NewInt(MinShareDiff)
	}
	if config.PayoutInterval == 0 {
		config.PayoutInterval = 24 * time.Hour
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	pool := &P2PPool{
		ctx:       ctx,
		cancel:    cancel,
		config:    config,
		peers:     make(map[string]*Peer),
		jobChan:   make(chan *PoolJob, 10),
		shareChan: make(chan *Share, 1000),
		blockChan: make(chan *Block, 10),
		shares:    NewShareManager(time.Hour),
		blockchain: &BlockchainState{},
		stats:     &PoolStats{StartTime: time.Now()},
		consensus: &Consensus{
			validators: make(map[string]*Validator),
			votes:      make(map[string]int),
		},
	}
	
	// Initialize blockchain state
	pool.blockchain.difficulty.Store(config.ShareDifficulty)
	pool.blockchain.height.Store(0)
	
	// Initialize total rewards
	pool.stats.TotalRewards.Store(big.NewInt(0))
	
	return pool, nil
}

// Start starts the P2P pool
func (p *P2PPool) Start() error {
	// Start listening
	listener, err := net.Listen("tcp", p.config.ListenAddr)
	if err != nil {
		return fmt.Errorf("failed to listen: %w", err)
	}
	p.listener = listener
	
	// Accept connections
	go p.acceptLoop()
	
	// Connect to bootstrap peers
	go p.connectBootstrapPeers()
	
	// Start maintenance routines
	go p.peerMaintenance()
	go p.shareProcessor()
	go p.blockProcessor()
	go p.consensusLoop()
	go p.payoutLoop()
	
	return nil
}

// Stop stops the P2P pool
func (p *P2PPool) Stop() error {
	p.cancel()
	
	// Close listener
	if p.listener != nil {
		p.listener.Close()
	}
	
	// Disconnect all peers
	p.peerLock.Lock()
	for _, peer := range p.peers {
		peer.cancel()
		peer.Conn.Close()
	}
	p.peerLock.Unlock()
	
	return nil
}

// SubmitShare submits a share to the pool
func (p *P2PPool) SubmitShare(share *Share) error {
	// Validate share
	if err := p.validateShare(share); err != nil {
		return err
	}
	
	// Queue for processing
	select {
	case p.shareChan <- share:
		return nil
	case <-time.After(time.Second):
		return errors.New("share queue full")
	}
}

// GetCurrentJob returns the current mining job
func (p *P2PPool) GetCurrentJob() *PoolJob {
	return p.currentJob.Load()
}

// GetStatistics returns pool statistics
func (p *P2PPool) GetStatistics() map[string]interface{} {
	uptime := time.Since(p.stats.StartTime)
	
	return map[string]interface{}{
		"version":        ProtocolVersion,
		"peers":          len(p.peers),
		"hashrate":       p.stats.TotalHashrate.Load(),
		"active_miners":  p.stats.ActiveMiners.Load(),
		"total_shares":   p.stats.TotalShares.Load(),
		"valid_shares":   p.stats.ValidShares.Load(),
		"blocks_found":   p.stats.BlocksFound.Load(),
		"total_rewards":  p.stats.TotalRewards.Load().String(),
		"uptime":         uptime.Seconds(),
		"blockchain_height": p.blockchain.height.Load(),
		"difficulty":     p.blockchain.difficulty.Load().String(),
	}
}

// Private methods

func (p *P2PPool) acceptLoop() {
	for {
		conn, err := p.listener.Accept()
		if err != nil {
			select {
			case <-p.ctx.Done():
				return
			default:
				continue
			}
		}
		
		go p.handleConnection(conn)
	}
}

func (p *P2PPool) handleConnection(conn net.Conn) {
	// Set deadline for handshake
	conn.SetDeadline(time.Now().Add(HandshakeTimeout))
	
	// Perform handshake
	peer, err := p.handshake(conn)
	if err != nil {
		conn.Close()
		return
	}
	
	// Clear deadline
	conn.SetDeadline(time.Time{})
	
	// Add peer
	p.addPeer(peer)
	
	// Start peer handlers
	go p.handlePeerMessages(peer)
	go p.handlePeerSend(peer)
	go p.pingPeer(peer)
}

func (p *P2PPool) handshake(conn net.Conn) (*Peer, error) {
	// Send handshake
	msg := Message{
		Type:      MsgHandshake,
		Version:   ProtocolVersion,
		Timestamp: time.Now().Unix(),
		Payload:   []byte(p.getNodeID()),
	}
	
	if err := p.sendMessage(conn, msg); err != nil {
		return nil, err
	}
	
	// Receive handshake
	response, err := p.receiveMessage(conn)
	if err != nil {
		return nil, err
	}
	
	if response.Type != MsgHandshake {
		return nil, errors.New("invalid handshake")
	}
	
	// Create peer
	ctx, cancel := context.WithCancel(p.ctx)
	peer := &Peer{
		ID:        string(response.Payload),
		Address:   conn.RemoteAddr().String(),
		Conn:      conn,
		Version:   response.Version,
		sendQueue: make(chan Message, 100),
		ctx:       ctx,
		cancel:    cancel,
	}
	
	peer.LastSeen.Store(time.Now().Unix())
	peer.Reputation.Store(100) // Start with neutral reputation
	
	return peer, nil
}

func (p *P2PPool) connectBootstrapPeers() {
	for _, addr := range p.config.BootstrapPeers {
		go p.connectPeer(addr)
	}
}

func (p *P2PPool) connectPeer(addr string) {
	conn, err := net.DialTimeout("tcp", addr, 10*time.Second)
	if err != nil {
		return
	}
	
	go p.handleConnection(conn)
}

func (p *P2PPool) addPeer(peer *Peer) {
	p.peerLock.Lock()
	defer p.peerLock.Unlock()
	
	// Check max peers
	if len(p.peers) >= p.config.MaxPeers {
		peer.Conn.Close()
		return
	}
	
	p.peers[peer.ID] = peer
	p.stats.ActiveMiners.Add(1)
}

func (p *P2PPool) removePeer(peer *Peer) {
	p.peerLock.Lock()
	defer p.peerLock.Unlock()
	
	delete(p.peers, peer.ID)
	p.stats.ActiveMiners.Add(^uint32(0)) // Subtract 1
	
	peer.cancel()
	peer.Conn.Close()
}

func (p *P2PPool) handlePeerMessages(peer *Peer) {
	defer p.removePeer(peer)
	
	for {
		msg, err := p.receiveMessage(peer.Conn)
		if err != nil {
			return
		}
		
		peer.LastSeen.Store(time.Now().Unix())
		
		switch msg.Type {
		case MsgShare:
			p.handleShareMessage(peer, msg)
		case MsgBlock:
			p.handleBlockMessage(peer, msg)
		case MsgTransaction:
			p.handleTransactionMessage(peer, msg)
		case MsgPing:
			p.handlePingMessage(peer, msg)
		case MsgGetPeers:
			p.handleGetPeersMessage(peer, msg)
		case MsgConsensus:
			p.handleConsensusMessage(peer, msg)
		}
	}
}

func (p *P2PPool) handlePeerSend(peer *Peer) {
	for {
		select {
		case <-peer.ctx.Done():
			return
		case msg := <-peer.sendQueue:
			if err := p.sendMessage(peer.Conn, msg); err != nil {
				return
			}
		}
	}
}

func (p *P2PPool) pingPeer(peer *Peer) {
	ticker := time.NewTicker(PingInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-peer.ctx.Done():
			return
		case <-ticker.C:
			msg := Message{
				Type:      MsgPing,
				Timestamp: time.Now().Unix(),
			}
			
			select {
			case peer.sendQueue <- msg:
			default:
			}
		}
	}
}

func (p *P2PPool) peerMaintenance() {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-p.ctx.Done():
			return
		case <-ticker.C:
			p.cleanupPeers()
			p.updateHashrate()
		}
	}
}

func (p *P2PPool) cleanupPeers() {
	now := time.Now().Unix()
	timeout := int64(120) // 2 minutes
	
	p.peerLock.RLock()
	peers := make([]*Peer, 0, len(p.peers))
	for _, peer := range p.peers {
		if now-peer.LastSeen.Load() > timeout {
			peers = append(peers, peer)
		}
	}
	p.peerLock.RUnlock()
	
	for _, peer := range peers {
		p.removePeer(peer)
	}
}

func (p *P2PPool) updateHashrate() {
	total := uint64(0)
	
	p.peerLock.RLock()
	for _, peer := range p.peers {
		total += peer.Hashrate.Load()
	}
	p.peerLock.RUnlock()
	
	p.stats.TotalHashrate.Store(total)
}

func (p *P2PPool) shareProcessor() {
	for {
		select {
		case <-p.ctx.Done():
			return
		case share := <-p.shareChan:
			p.processShare(share)
		}
	}
}

func (p *P2PPool) processShare(share *Share) {
	// Update statistics
	p.stats.TotalShares.Add(1)
	
	if share.Valid {
		p.stats.ValidShares.Add(1)
		p.shares.AddShare(share)
		
		// Check if it's a block
		if p.isBlock(share) {
			block := p.createBlock(share)
			select {
			case p.blockChan <- block:
			default:
			}
		}
		
		// Broadcast to peers
		p.broadcastShare(share)
	}
}

func (p *P2PPool) blockProcessor() {
	for {
		select {
		case <-p.ctx.Done():
			return
		case block := <-p.blockChan:
			p.processBlock(block)
		}
	}
}

func (p *P2PPool) processBlock(block *Block) {
	// Update blockchain state
	p.blockchain.mu.Lock()
	p.blockchain.height.Store(block.Height)
	p.blockchain.lastBlock.Store(block)
	p.blockchain.chainTip = block.Hash
	p.blockchain.mu.Unlock()
	
	// Update statistics
	p.stats.BlocksFound.Add(1)
	p.stats.LastBlockTime.Store(time.Now().Unix())
	
	// Add reward
	currentRewards := p.stats.TotalRewards.Load()
	newRewards := new(big.Int).Add(currentRewards, block.Reward)
	p.stats.TotalRewards.Store(newRewards)
	
	// Broadcast block
	p.broadcastBlock(block)
	
	// Trigger payout calculation
	p.calculatePayouts(block)
}

func (p *P2PPool) consensusLoop() {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-p.ctx.Done():
			return
		case <-ticker.C:
			p.runConsensusRound()
		}
	}
}

func (p *P2PPool) runConsensusRound() {
	p.consensus.mu.Lock()
	defer p.consensus.mu.Unlock()
	
	p.consensus.currentRound++
	p.consensus.votes = make(map[string]int)
	
	// Request votes from validators
	// Implement BFT or other consensus mechanism
}

func (p *P2PPool) payoutLoop() {
	ticker := time.NewTicker(p.config.PayoutInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-p.ctx.Done():
			return
		case <-ticker.C:
			p.executePayouts()
		}
	}
}

func (p *P2PPool) executePayouts() {
	// Calculate share percentages
	shares := p.shares.GetShares()
	if len(shares) == 0 {
		return
	}
	
	// Get total rewards
	totalRewards := p.stats.TotalRewards.Load()
	if totalRewards.Cmp(big.NewInt(0)) == 0 {
		return
	}
	
	// Calculate payouts based on shares
	payouts := p.calculateSharePayouts(shares, totalRewards)
	
	// Execute payouts
	for minerID, amount := range payouts {
		if amount.Cmp(p.config.MinPayout) >= 0 {
			// Create payout transaction
			p.createPayoutTransaction(minerID, amount)
		}
	}
	
	// Reset rewards
	p.stats.TotalRewards.Store(big.NewInt(0))
}

func (p *P2PPool) calculateSharePayouts(shares map[string][]*Share, total *big.Int) map[string]*big.Int {
	payouts := make(map[string]*big.Int)
	totalShares := uint64(0)
	
	// Count total shares
	minerShares := make(map[string]uint64)
	for minerID, minerShareList := range shares {
		count := uint64(len(minerShareList))
		minerShares[minerID] = count
		totalShares += count
	}
	
	if totalShares == 0 {
		return payouts
	}
	
	// Calculate payouts
	for minerID, count := range minerShares {
		percentage := new(big.Int).SetUint64(count)
		percentage.Mul(percentage, total)
		percentage.Div(percentage, new(big.Int).SetUint64(totalShares))
		
		// Apply pool fee
		fee := new(big.Int).Set(percentage)
		fee.Mul(fee, big.NewInt(int64(p.config.FeePercent*100)))
		fee.Div(fee, big.NewInt(10000))
		
		payout := new(big.Int).Sub(percentage, fee)
		payouts[minerID] = payout
	}
	
	return payouts
}

func (p *P2PPool) createPayoutTransaction(minerID string, amount *big.Int) {
	// Create transaction
	tx := Transaction{
		ID:     p.generateTxID(),
		From:   "pool",
		To:     minerID,
		Amount: amount,
		Fee:    big.NewInt(0),
	}
	
	// Broadcast transaction
	p.broadcastTransaction(tx)
}

// Message handling

func (p *P2PPool) handleShareMessage(peer *Peer, msg Message) {
	var share Share
	if err := json.Unmarshal(msg.Payload, &share); err != nil {
		return
	}
	
	share.MinerID = peer.ID
	peer.ShareCount.Add(1)
	
	// Submit share
	p.SubmitShare(&share)
}

func (p *P2PPool) handleBlockMessage(peer *Peer, msg Message) {
	var block Block
	if err := json.Unmarshal(msg.Payload, &block); err != nil {
		return
	}
	
	// Process block
	select {
	case p.blockChan <- &block:
	default:
	}
}

func (p *P2PPool) handleTransactionMessage(peer *Peer, msg Message) {
	var tx Transaction
	if err := json.Unmarshal(msg.Payload, &tx); err != nil {
		return
	}
	
	// Process transaction
	// Add to mempool
}

func (p *P2PPool) handlePingMessage(peer *Peer, msg Message) {
	// Send pong
	pong := Message{
		Type:      MsgPong,
		Timestamp: time.Now().Unix(),
	}
	
	select {
	case peer.sendQueue <- pong:
	default:
	}
}

func (p *P2PPool) handleGetPeersMessage(peer *Peer, msg Message) {
	// Send peer list
	p.peerLock.RLock()
	peerList := make([]string, 0, len(p.peers))
	for _, p := range p.peers {
		if p.ID != peer.ID {
			peerList = append(peerList, p.Address)
		}
	}
	p.peerLock.RUnlock()
	
	data, _ := json.Marshal(peerList)
	response := Message{
		Type:      MsgPeers,
		Timestamp: time.Now().Unix(),
		Payload:   data,
	}
	
	select {
	case peer.sendQueue <- response:
	default:
	}
}

func (p *P2PPool) handleConsensusMessage(peer *Peer, msg Message) {
	// Handle consensus voting
}

// Broadcasting

func (p *P2PPool) broadcastShare(share *Share) {
	data, _ := json.Marshal(share)
	msg := Message{
		Type:      MsgShare,
		Timestamp: time.Now().Unix(),
		Payload:   data,
	}
	
	p.broadcast(msg)
}

func (p *P2PPool) broadcastBlock(block *Block) {
	data, _ := json.Marshal(block)
	msg := Message{
		Type:      MsgBlock,
		Timestamp: time.Now().Unix(),
		Payload:   data,
	}
	
	p.broadcast(msg)
}

func (p *P2PPool) broadcastTransaction(tx Transaction) {
	data, _ := json.Marshal(tx)
	msg := Message{
		Type:      MsgTransaction,
		Timestamp: time.Now().Unix(),
		Payload:   data,
	}
	
	p.broadcast(msg)
}

func (p *P2PPool) broadcast(msg Message) {
	p.peerLock.RLock()
	defer p.peerLock.RUnlock()
	
	for _, peer := range p.peers {
		select {
		case peer.sendQueue <- msg:
		default:
		}
	}
}

// Validation

func (p *P2PPool) validateShare(share *Share) error {
	// Check if share meets minimum difficulty
	if share.Difficulty.Cmp(p.config.ShareDifficulty) < 0 {
		return errors.New("share difficulty too low")
	}
	
	// Verify hash
	if !p.verifyHash(share) {
		return errors.New("invalid share hash")
	}
	
	// Check timestamp
	if time.Since(share.Timestamp) > time.Hour {
		return errors.New("share too old")
	}
	
	share.Valid = true
	return nil
}

func (p *P2PPool) verifyHash(share *Share) bool {
	// Verify that hash meets claimed difficulty
	// This would check the actual hash calculation
	return true
}

func (p *P2PPool) isBlock(share *Share) bool {
	// Check if share hash meets network difficulty
	networkDiff := p.blockchain.difficulty.Load()
	return share.Difficulty.Cmp(networkDiff) >= 0
}

func (p *P2PPool) createBlock(share *Share) *Block {
	return &Block{
		Height:       p.blockchain.height.Load() + 1,
		Hash:         share.Hash,
		PreviousHash: p.blockchain.chainTip,
		Timestamp:    share.Timestamp.Unix(),
		Nonce:        share.Nonce,
		Difficulty:   share.Difficulty,
		Reward:       p.config.BlockReward,
		FinderID:     share.MinerID,
	}
}

func (p *P2PPool) calculatePayouts(block *Block) {
	// Calculate payouts for block finder and share contributors
}

// Helper functions

func (p *P2PPool) sendMessage(conn net.Conn, msg Message) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	
	// Write length prefix
	length := uint32(len(data))
	if err := binary.Write(conn, binary.BigEndian, length); err != nil {
		return err
	}
	
	// Write data
	_, err = conn.Write(data)
	return err
}

func (p *P2PPool) receiveMessage(conn net.Conn) (*Message, error) {
	// Read length prefix
	var length uint32
	if err := binary.Read(conn, binary.BigEndian, &length); err != nil {
		return nil, err
	}
	
	if length > MaxMessageSize {
		return nil, errors.New("message too large")
	}
	
	// Read data
	data := make([]byte, length)
	if _, err := conn.Read(data); err != nil {
		return nil, err
	}
	
	var msg Message
	if err := json.Unmarshal(data, &msg); err != nil {
		return nil, err
	}
	
	return &msg, nil
}

func (p *P2PPool) getNodeID() string {
	// Generate unique node ID
	h := sha256.New()
	h.Write([]byte(p.config.ListenAddr))
	h.Write([]byte(time.Now().String()))
	return fmt.Sprintf("%x", h.Sum(nil))[:16]
}

func (p *P2PPool) generateTxID() string {
	// Generate unique transaction ID
	h := sha256.New()
	h.Write([]byte(time.Now().String()))
	return fmt.Sprintf("%x", h.Sum(nil))
}

// ShareManager implementation

func NewShareManager(window time.Duration) *ShareManager {
	return &ShareManager{
		shares: make(map[string][]*Share),
		window: window,
	}
}

func (sm *ShareManager) AddShare(share *Share) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	
	sm.shares[share.MinerID] = append(sm.shares[share.MinerID], share)
	sm.totalShares.Add(1)
	if share.Valid {
		sm.validShares.Add(1)
	}
	
	// Clean old shares
	sm.cleanOldShares()
}

func (sm *ShareManager) GetShares() map[string][]*Share {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	
	result := make(map[string][]*Share)
	for k, v := range sm.shares {
		result[k] = v
	}
	return result
}

func (sm *ShareManager) cleanOldShares() {
	cutoff := time.Now().Add(-sm.window)
	
	for minerID, shares := range sm.shares {
		filtered := make([]*Share, 0)
		for _, share := range shares {
			if share.Timestamp.After(cutoff) {
				filtered = append(filtered, share)
			}
		}
		
		if len(filtered) > 0 {
			sm.shares[minerID] = filtered
		} else {
			delete(sm.shares, minerID)
		}
	}
}