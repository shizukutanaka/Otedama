package consensus

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// ConsensusEngine manages distributed consensus for the P2P pool
type ConsensusEngine struct {
	logger *zap.Logger
	config Config
	
	// Node information
	nodeID   string
	peers    map[string]*Peer
	peerLock sync.RWMutex
	
	// Consensus state
	currentRound   atomic.Uint64
	currentLeader  atomic.Value // string
	consensusState ConsensusState
	stateLock      sync.RWMutex
	
	// Voting
	votes      map[string]*Vote
	voteLock   sync.RWMutex
	
	// Proposals
	proposals  map[string]*Proposal
	propLock   sync.RWMutex
	
	// Callbacks
	onConsensus    func(*Block)
	onStateChange  func(ConsensusState)
	
	// Channels
	proposalChan   chan *Proposal
	voteChan       chan *Vote
	stopChan       chan struct{}
}

// Config defines consensus configuration
type Config struct {
	// Timing
	RoundDuration    time.Duration `yaml:"round_duration"`
	ProposalTimeout  time.Duration `yaml:"proposal_timeout"`
	VoteTimeout      time.Duration `yaml:"vote_timeout"`
	
	// Thresholds
	MinPeers         int     `yaml:"min_peers"`
	QuorumPercentage float64 `yaml:"quorum_percentage"`
	
	// Byzantine fault tolerance
	ByzantineFaultTolerance bool    `yaml:"byzantine_fault_tolerance"`
	MaxByzantineNodes       float64 `yaml:"max_byzantine_nodes"` // As percentage
	
	// Performance
	MaxProposalSize  int `yaml:"max_proposal_size"`
	MaxVotesPerRound int `yaml:"max_votes_per_round"`
}

// ConsensusState represents the current state
type ConsensusState int

const (
	StateIdle ConsensusState = iota
	StateProposing
	StateVoting
	StateCommitting
	StateSyncing
)

// Peer represents a peer in the consensus network
type Peer struct {
	ID            string
	Address       string
	PublicKey     []byte
	Reputation    float64
	LastSeen      time.Time
	VotingPower   uint64
	IsValidator   bool
}

// Proposal represents a block proposal
type Proposal struct {
	Round       uint64
	ProposerID  string
	Block       *Block
	Timestamp   time.Time
	Signature   []byte
}

// Block represents a block in the chain
type Block struct {
	Height       uint64
	PreviousHash string
	Timestamp    time.Time
	Shares       []Share
	StateRoot    string
	ProposerID   string
}

// Share represents a mining share
type Share struct {
	MinerID    string
	Nonce      uint64
	Hash       string
	Difficulty uint64
	Timestamp  time.Time
	Valid      bool
}

// Vote represents a vote on a proposal
type Vote struct {
	Round      uint64
	VoterID    string
	BlockHash  string
	Accept     bool
	Timestamp  time.Time
	Signature  []byte
}

// NewConsensusEngine creates a new consensus engine
func NewConsensusEngine(logger *zap.Logger, config Config, nodeID string) *ConsensusEngine {
	// Set defaults
	if config.RoundDuration == 0 {
		config.RoundDuration = 10 * time.Second
	}
	if config.ProposalTimeout == 0 {
		config.ProposalTimeout = 5 * time.Second
	}
	if config.VoteTimeout == 0 {
		config.VoteTimeout = 3 * time.Second
	}
	if config.MinPeers == 0 {
		config.MinPeers = 3
	}
	if config.QuorumPercentage == 0 {
		config.QuorumPercentage = 0.67 // 2/3 majority
	}
	if config.MaxByzantineNodes == 0 {
		config.MaxByzantineNodes = 0.33 // 1/3 Byzantine nodes
	}
	
	ce := &ConsensusEngine{
		logger:       logger,
		config:       config,
		nodeID:       nodeID,
		peers:        make(map[string]*Peer),
		votes:        make(map[string]*Vote),
		proposals:    make(map[string]*Proposal),
		proposalChan: make(chan *Proposal, 100),
		voteChan:     make(chan *Vote, 1000),
		stopChan:     make(chan struct{}),
	}
	
	ce.currentLeader.Store("")
	
	return ce
}

// Start begins the consensus engine
func (ce *ConsensusEngine) Start(ctx context.Context) error {
	ce.logger.Info("Starting consensus engine",
		zap.String("node_id", ce.nodeID),
		zap.Duration("round_duration", ce.config.RoundDuration),
	)
	
	// Start consensus rounds
	go ce.consensusLoop(ctx)
	
	// Start message handlers
	go ce.handleProposals(ctx)
	go ce.handleVotes(ctx)
	
	return nil
}

// Stop halts the consensus engine
func (ce *ConsensusEngine) Stop() error {
	ce.logger.Info("Stopping consensus engine")
	close(ce.stopChan)
	return nil
}

// AddPeer adds a peer to the consensus network
func (ce *ConsensusEngine) AddPeer(peer *Peer) {
	ce.peerLock.Lock()
	defer ce.peerLock.Unlock()
	
	ce.peers[peer.ID] = peer
	ce.logger.Info("Added peer to consensus",
		zap.String("peer_id", peer.ID),
		zap.Uint64("voting_power", peer.VotingPower),
	)
}

// RemovePeer removes a peer from the consensus network
func (ce *ConsensusEngine) RemovePeer(peerID string) {
	ce.peerLock.Lock()
	defer ce.peerLock.Unlock()
	
	delete(ce.peers, peerID)
	ce.logger.Info("Removed peer from consensus", zap.String("peer_id", peerID))
}

// SubmitShare submits a share for inclusion in the next block
func (ce *ConsensusEngine) SubmitShare(share Share) error {
	// Validate share
	if !ce.validateShare(share) {
		return fmt.Errorf("invalid share")
	}
	
	// Add to pending shares
	// (Implementation depends on share pool management)
	
	return nil
}

// Main consensus loop
func (ce *ConsensusEngine) consensusLoop(ctx context.Context) {
	roundTicker := time.NewTicker(ce.config.RoundDuration)
	defer roundTicker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ce.stopChan:
			return
		case <-roundTicker.C:
			ce.startNewRound()
		}
	}
}

// Start a new consensus round
func (ce *ConsensusEngine) startNewRound() {
	round := ce.currentRound.Add(1)
	
	ce.logger.Debug("Starting new consensus round", zap.Uint64("round", round))
	
	// Clear previous round data
	ce.clearRoundData()
	
	// Select leader for this round
	leader := ce.selectLeader(round)
	ce.currentLeader.Store(leader)
	
	// Check if we are the leader
	if leader == ce.nodeID {
		ce.proposeBlock(round)
	}
	
	// Update state
	ce.updateState(StateProposing)
}

// Select leader using deterministic algorithm
func (ce *ConsensusEngine) selectLeader(round uint64) string {
	ce.peerLock.RLock()
	defer ce.peerLock.RUnlock()
	
	// Simple round-robin for now
	// In production, use VRF or weighted selection based on stake
	validators := ce.getValidators()
	if len(validators) == 0 {
		return ""
	}
	
	index := round % uint64(len(validators))
	return validators[index].ID
}

// Propose a new block
func (ce *ConsensusEngine) proposeBlock(round uint64) {
	ce.updateState(StateProposing)
	
	// Collect pending shares
	shares := ce.collectPendingShares()
	
	// Create block
	block := &Block{
		Height:       round,
		PreviousHash: ce.getPreviousBlockHash(),
		Timestamp:    time.Now(),
		Shares:       shares,
		StateRoot:    ce.calculateStateRoot(shares),
		ProposerID:   ce.nodeID,
	}
	
	// Create proposal
	proposal := &Proposal{
		Round:      round,
		ProposerID: ce.nodeID,
		Block:      block,
		Timestamp:  time.Now(),
		Signature:  ce.signProposal(block),
	}
	
	// Broadcast proposal
	ce.broadcastProposal(proposal)
	
	// Add to our proposals
	ce.propLock.Lock()
	ce.proposals[ce.getProposalKey(round, ce.nodeID)] = proposal
	ce.propLock.Unlock()
	
	ce.logger.Info("Proposed block",
		zap.Uint64("round", round),
		zap.Int("shares", len(shares)),
	)
}

// Handle incoming proposals
func (ce *ConsensusEngine) handleProposals(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-ce.stopChan:
			return
		case proposal := <-ce.proposalChan:
			ce.processProposal(proposal)
		}
	}
}

// Process a proposal
func (ce *ConsensusEngine) processProposal(proposal *Proposal) {
	// Validate proposal
	if !ce.validateProposal(proposal) {
		ce.logger.Warn("Invalid proposal received",
			zap.Uint64("round", proposal.Round),
			zap.String("proposer", proposal.ProposerID),
		)
		return
	}
	
	// Check if proposer is the valid leader
	expectedLeader := ce.selectLeader(proposal.Round)
	if proposal.ProposerID != expectedLeader {
		ce.logger.Warn("Proposal from non-leader",
			zap.String("proposer", proposal.ProposerID),
			zap.String("expected_leader", expectedLeader),
		)
		return
	}
	
	// Store proposal
	ce.propLock.Lock()
	ce.proposals[ce.getProposalKey(proposal.Round, proposal.ProposerID)] = proposal
	ce.propLock.Unlock()
	
	// Vote on proposal
	ce.voteOnProposal(proposal)
}

// Vote on a proposal
func (ce *ConsensusEngine) voteOnProposal(proposal *Proposal) {
	ce.updateState(StateVoting)
	
	// Validate block
	accept := ce.validateBlock(proposal.Block)
	
	// Create vote
	vote := &Vote{
		Round:     proposal.Round,
		VoterID:   ce.nodeID,
		BlockHash: ce.hashBlock(proposal.Block),
		Accept:    accept,
		Timestamp: time.Now(),
		Signature: ce.signVote(proposal.Round, ce.hashBlock(proposal.Block), accept),
	}
	
	// Broadcast vote
	ce.broadcastVote(vote)
	
	// Store our vote
	ce.voteLock.Lock()
	ce.votes[ce.getVoteKey(vote.Round, vote.VoterID)] = vote
	ce.voteLock.Unlock()
	
	ce.logger.Debug("Voted on proposal",
		zap.Uint64("round", proposal.Round),
		zap.Bool("accept", accept),
	)
}

// Handle incoming votes
func (ce *ConsensusEngine) handleVotes(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-ce.stopChan:
			return
		case vote := <-ce.voteChan:
			ce.processVote(vote)
		}
	}
}

// Process a vote
func (ce *ConsensusEngine) processVote(vote *Vote) {
	// Validate vote
	if !ce.validateVote(vote) {
		ce.logger.Warn("Invalid vote received",
			zap.Uint64("round", vote.Round),
			zap.String("voter", vote.VoterID),
		)
		return
	}
	
	// Store vote
	ce.voteLock.Lock()
	ce.votes[ce.getVoteKey(vote.Round, vote.VoterID)] = vote
	votesCount := len(ce.votes)
	ce.voteLock.Unlock()
	
	// Check if we have enough votes
	ce.checkConsensus(vote.Round)
}

// Check if consensus is reached
func (ce *ConsensusEngine) checkConsensus(round uint64) {
	ce.voteLock.RLock()
	defer ce.voteLock.RUnlock()
	
	// Count votes by block hash
	voteCounts := make(map[string]int)
	totalVotes := 0
	
	for _, vote := range ce.votes {
		if vote.Round == round && vote.Accept {
			voteCounts[vote.BlockHash]++
			totalVotes++
		}
	}
	
	// Check if any block has quorum
	requiredVotes := ce.calculateQuorum()
	
	for blockHash, count := range voteCounts {
		if count >= requiredVotes {
			// Consensus reached!
			ce.commitBlock(round, blockHash)
			return
		}
	}
}

// Commit a block after consensus
func (ce *ConsensusEngine) commitBlock(round uint64, blockHash string) {
	ce.updateState(StateCommitting)
	
	// Find the proposal for this block
	var block *Block
	ce.propLock.RLock()
	for _, proposal := range ce.proposals {
		if proposal.Round == round && ce.hashBlock(proposal.Block) == blockHash {
			block = proposal.Block
			break
		}
	}
	ce.propLock.RUnlock()
	
	if block == nil {
		ce.logger.Error("Block not found for consensus", zap.String("block_hash", blockHash))
		return
	}
	
	// Execute block (update state, distribute rewards, etc.)
	ce.executeBlock(block)
	
	// Notify consensus achieved
	if ce.onConsensus != nil {
		ce.onConsensus(block)
	}
	
	ce.logger.Info("Block committed",
		zap.Uint64("height", block.Height),
		zap.String("hash", blockHash),
		zap.Int("shares", len(block.Shares)),
	)
	
	ce.updateState(StateIdle)
}

// Utility functions

func (ce *ConsensusEngine) getValidators() []*Peer {
	var validators []*Peer
	
	for _, peer := range ce.peers {
		if peer.IsValidator {
			validators = append(validators, peer)
		}
	}
	
	// Include self if validator
	validators = append(validators, &Peer{
		ID:          ce.nodeID,
		IsValidator: true,
	})
	
	return validators
}

func (ce *ConsensusEngine) calculateQuorum() int {
	ce.peerLock.RLock()
	totalValidators := len(ce.getValidators())
	ce.peerLock.RUnlock()
	
	quorum := int(float64(totalValidators) * ce.config.QuorumPercentage)
	if quorum < 1 {
		quorum = 1
	}
	
	return quorum
}

func (ce *ConsensusEngine) validateShare(share Share) bool {
	// Implement share validation logic
	return share.Valid
}

func (ce *ConsensusEngine) validateProposal(proposal *Proposal) bool {
	// Check round
	currentRound := ce.currentRound.Load()
	if proposal.Round != currentRound {
		return false
	}
	
	// Check signature
	// TODO: Implement signature verification
	
	// Check block validity
	return ce.validateBlock(proposal.Block)
}

func (ce *ConsensusEngine) validateBlock(block *Block) bool {
	// Validate block structure
	if block == nil {
		return false
	}
	
	// Validate shares
	for _, share := range block.Shares {
		if !ce.validateShare(share) {
			return false
		}
	}
	
	// Validate state root
	expectedRoot := ce.calculateStateRoot(block.Shares)
	if block.StateRoot != expectedRoot {
		return false
	}
	
	return true
}

func (ce *ConsensusEngine) validateVote(vote *Vote) bool {
	// Check round
	currentRound := ce.currentRound.Load()
	if vote.Round != currentRound {
		return false
	}
	
	// Check voter is valid
	ce.peerLock.RLock()
	_, exists := ce.peers[vote.VoterID]
	ce.peerLock.RUnlock()
	
	if !exists && vote.VoterID != ce.nodeID {
		return false
	}
	
	// TODO: Verify signature
	
	return true
}

func (ce *ConsensusEngine) hashBlock(block *Block) string {
	// Simple hash implementation
	data := fmt.Sprintf("%d:%s:%d:%s",
		block.Height,
		block.PreviousHash,
		block.Timestamp.Unix(),
		block.StateRoot,
	)
	
	hash := sha256.Sum256([]byte(data))
	return hex.EncodeToString(hash[:])
}

func (ce *ConsensusEngine) calculateStateRoot(shares []Share) string {
	// Calculate merkle root of shares
	if len(shares) == 0 {
		return ""
	}
	
	// Simple implementation - in production use proper merkle tree
	combined := ""
	for _, share := range shares {
		combined += share.Hash
	}
	
	hash := sha256.Sum256([]byte(combined))
	return hex.EncodeToString(hash[:])
}

func (ce *ConsensusEngine) getPreviousBlockHash() string {
	// Get hash of previous block
	// TODO: Implement blockchain storage
	return "0000000000000000000000000000000000000000000000000000000000000000"
}

func (ce *ConsensusEngine) collectPendingShares() []Share {
	// Collect shares from share pool
	// TODO: Implement share pool integration
	return []Share{}
}

func (ce *ConsensusEngine) signProposal(block *Block) []byte {
	// Sign proposal with node's private key
	// TODO: Implement cryptographic signing
	return []byte("signature")
}

func (ce *ConsensusEngine) signVote(round uint64, blockHash string, accept bool) []byte {
	// Sign vote
	// TODO: Implement cryptographic signing
	return []byte("vote_signature")
}

func (ce *ConsensusEngine) broadcastProposal(proposal *Proposal) {
	// Broadcast to all peers
	// TODO: Implement P2P broadcasting
}

func (ce *ConsensusEngine) broadcastVote(vote *Vote) {
	// Broadcast to all peers
	// TODO: Implement P2P broadcasting
}

func (ce *ConsensusEngine) executeBlock(block *Block) {
	// Execute block transactions
	// Update state
	// Distribute rewards
	// TODO: Implement block execution
}

func (ce *ConsensusEngine) clearRoundData() {
	ce.voteLock.Lock()
	ce.votes = make(map[string]*Vote)
	ce.voteLock.Unlock()
	
	ce.propLock.Lock()
	ce.proposals = make(map[string]*Proposal)
	ce.propLock.Unlock()
}

func (ce *ConsensusEngine) updateState(newState ConsensusState) {
	ce.stateLock.Lock()
	ce.consensusState = newState
	ce.stateLock.Unlock()
	
	if ce.onStateChange != nil {
		ce.onStateChange(newState)
	}
}

func (ce *ConsensusEngine) getProposalKey(round uint64, proposerID string) string {
	return fmt.Sprintf("%d:%s", round, proposerID)
}

func (ce *ConsensusEngine) getVoteKey(round uint64, voterID string) string {
	return fmt.Sprintf("%d:%s", round, voterID)
}

// GetState returns current consensus state
func (ce *ConsensusEngine) GetState() ConsensusState {
	ce.stateLock.RLock()
	defer ce.stateLock.RUnlock()
	return ce.consensusState
}

// GetCurrentRound returns current round
func (ce *ConsensusEngine) GetCurrentRound() uint64 {
	return ce.currentRound.Load()
}

// GetCurrentLeader returns current round leader
func (ce *ConsensusEngine) GetCurrentLeader() string {
	if leader := ce.currentLeader.Load(); leader != nil {
		return leader.(string)
	}
	return ""
}