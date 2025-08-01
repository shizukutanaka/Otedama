package consensus

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// RaftConsensus implements the Raft consensus algorithm for distributed P2P pools
// Following Rob Pike's principle: "Don't communicate by sharing memory; share memory by communicating"
type RaftConsensus struct {
	logger *zap.Logger
	
	// Node identity
	nodeID      string
	nodes       map[string]*Node
	nodesMu     sync.RWMutex
	
	// Raft state
	currentTerm atomic.Uint64
	votedFor    atomic.Value // string
	state       atomic.Value // NodeState
	
	// Leader state
	leader      atomic.Value // string
	nextIndex   map[string]uint64
	matchIndex  map[string]uint64
	
	// Log entries
	log         []LogEntry
	logMu       sync.RWMutex
	commitIndex atomic.Uint64
	lastApplied atomic.Uint64
	
	// Election state
	electionTimer   *time.Timer
	heartbeatTimer  *time.Timer
	electionTimeout time.Duration
	
	// Channels
	appendEntriesCh chan AppendEntriesRequest
	requestVoteCh   chan RequestVoteRequest
	applyCh         chan ApplyMsg
	
	// Configuration
	config ConsensusConfig
	
	// State machine
	stateMachine StateMachine
	
	// Metrics
	metrics struct {
		elections     atomic.Uint64
		termChanges   atomic.Uint64
		logEntries    atomic.Uint64
		commitLatency atomic.Uint64 // microseconds
	}
	
	// Lifecycle
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// ConsensusConfig configures the consensus system
type ConsensusConfig struct {
	// Timing
	ElectionTimeoutMin  time.Duration
	ElectionTimeoutMax  time.Duration
	HeartbeatInterval   time.Duration
	
	// Replication
	MaxLogEntries       int
	SnapshotThreshold   int
	
	// Network
	RPCTimeout          time.Duration
	MaxRetries          int
	
	// Performance
	BatchSize           int
	BatchTimeout        time.Duration
}

// NodeState represents the state of a Raft node
type NodeState int

const (
	Follower NodeState = iota
	Candidate
	Leader
)

// Node represents a node in the Raft cluster
type Node struct {
	ID        string
	Address   string
	PublicKey []byte
	
	// Health
	Healthy   bool
	LastSeen  time.Time
	RTT       time.Duration
}

// LogEntry represents an entry in the Raft log
type LogEntry struct {
	Term      uint64
	Index     uint64
	Command   interface{}
	Timestamp time.Time
}

// AppendEntriesRequest is the RPC request for AppendEntries
type AppendEntriesRequest struct {
	Term         uint64
	LeaderID     string
	PrevLogIndex uint64
	PrevLogTerm  uint64
	Entries      []LogEntry
	LeaderCommit uint64
}

// AppendEntriesResponse is the RPC response for AppendEntries
type AppendEntriesResponse struct {
	Term    uint64
	Success bool
	
	// Optimization: help leader find the correct next index faster
	ConflictIndex uint64
	ConflictTerm  uint64
}

// RequestVoteRequest is the RPC request for RequestVote
type RequestVoteRequest struct {
	Term         uint64
	CandidateID  string
	LastLogIndex uint64
	LastLogTerm  uint64
}

// RequestVoteResponse is the RPC response for RequestVote
type RequestVoteResponse struct {
	Term        uint64
	VoteGranted bool
}

// ApplyMsg is a message to apply to the state machine
type ApplyMsg struct {
	CommandValid bool
	Command      interface{}
	CommandIndex uint64
}

// StateMachine interface for applying committed log entries
type StateMachine interface {
	Apply(command interface{}) (interface{}, error)
	Snapshot() ([]byte, error)
	Restore(snapshot []byte) error
}

// NewRaftConsensus creates a new Raft consensus instance
func NewRaftConsensus(nodeID string, logger *zap.Logger, config ConsensusConfig, sm StateMachine) *RaftConsensus {
	ctx, cancel := context.WithCancel(context.Background())
	
	rc := &RaftConsensus{
		logger:          logger,
		nodeID:          nodeID,
		nodes:           make(map[string]*Node),
		nextIndex:       make(map[string]uint64),
		matchIndex:      make(map[string]uint64),
		log:             make([]LogEntry, 0),
		appendEntriesCh: make(chan AppendEntriesRequest, 100),
		requestVoteCh:   make(chan RequestVoteRequest, 100),
		applyCh:         make(chan ApplyMsg, 100),
		config:          config,
		stateMachine:    sm,
		ctx:             ctx,
		cancel:          cancel,
	}
	
	// Initialize state
	rc.state.Store(Follower)
	rc.votedFor.Store("")
	rc.leader.Store("")
	
	// Set random election timeout
	rc.electionTimeout = rc.randomElectionTimeout()
	
	return rc
}

// Start begins the consensus protocol
func (rc *RaftConsensus) Start() error {
	rc.logger.Info("Starting Raft consensus", 
		zap.String("node_id", rc.nodeID),
		zap.Duration("election_timeout", rc.electionTimeout))
	
	// Start main loop
	rc.wg.Add(1)
	go rc.mainLoop()
	
	// Start apply loop
	rc.wg.Add(1)
	go rc.applyLoop()
	
	// Start election timer
	rc.resetElectionTimer()
	
	return nil
}

// Stop stops the consensus protocol
func (rc *RaftConsensus) Stop() error {
	rc.logger.Info("Stopping Raft consensus")
	
	rc.cancel()
	rc.wg.Wait()
	
	if rc.electionTimer != nil {
		rc.electionTimer.Stop()
	}
	if rc.heartbeatTimer != nil {
		rc.heartbeatTimer.Stop()
	}
	
	return nil
}

// Propose proposes a new command to the cluster
func (rc *RaftConsensus) Propose(command interface{}) error {
	state := rc.state.Load().(NodeState)
	if state != Leader {
		leader := rc.leader.Load().(string)
		if leader == "" {
			return errors.New("no leader elected")
		}
		return fmt.Errorf("not leader, current leader: %s", leader)
	}
	
	// Append to log
	rc.logMu.Lock()
	entry := LogEntry{
		Term:      rc.currentTerm.Load(),
		Index:     uint64(len(rc.log)) + 1,
		Command:   command,
		Timestamp: time.Now(),
	}
	rc.log = append(rc.log, entry)
	rc.logMu.Unlock()
	
	rc.metrics.logEntries.Add(1)
	
	// Replicate to followers
	rc.replicateEntries()
	
	return nil
}

// AddNode adds a new node to the cluster
func (rc *RaftConsensus) AddNode(node *Node) error {
	rc.nodesMu.Lock()
	defer rc.nodesMu.Unlock()
	
	rc.nodes[node.ID] = node
	
	// If leader, initialize indices
	if rc.state.Load().(NodeState) == Leader {
		rc.nextIndex[node.ID] = rc.getLastLogIndex() + 1
		rc.matchIndex[node.ID] = 0
	}
	
	rc.logger.Info("Added node to cluster", zap.String("node_id", node.ID))
	return nil
}

// RemoveNode removes a node from the cluster
func (rc *RaftConsensus) RemoveNode(nodeID string) error {
	rc.nodesMu.Lock()
	defer rc.nodesMu.Unlock()
	
	delete(rc.nodes, nodeID)
	delete(rc.nextIndex, nodeID)
	delete(rc.matchIndex, nodeID)
	
	rc.logger.Info("Removed node from cluster", zap.String("node_id", nodeID))
	return nil
}

// GetLeader returns the current leader ID
func (rc *RaftConsensus) GetLeader() string {
	return rc.leader.Load().(string)
}

// GetState returns the current node state
func (rc *RaftConsensus) GetState() NodeState {
	return rc.state.Load().(NodeState)
}

// Internal methods

func (rc *RaftConsensus) mainLoop() {
	defer rc.wg.Done()
	
	for {
		select {
		case <-rc.ctx.Done():
			return
			
		case req := <-rc.appendEntriesCh:
			resp := rc.handleAppendEntries(req)
			// Send response back (implementation depends on transport layer)
			_ = resp
			
		case req := <-rc.requestVoteCh:
			resp := rc.handleRequestVote(req)
			// Send response back
			_ = resp
			
		case <-rc.electionTimer.C:
			rc.startElection()
		}
	}
}

func (rc *RaftConsensus) applyLoop() {
	defer rc.wg.Done()
	
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	
	for {
		select {
		case <-rc.ctx.Done():
			return
			
		case <-ticker.C:
			rc.applyCommittedEntries()
		}
	}
}

func (rc *RaftConsensus) handleAppendEntries(req AppendEntriesRequest) AppendEntriesResponse {
	rc.logMu.Lock()
	defer rc.logMu.Unlock()
	
	currentTerm := rc.currentTerm.Load()
	
	// Reply false if term < currentTerm
	if req.Term < currentTerm {
		return AppendEntriesResponse{
			Term:    currentTerm,
			Success: false,
		}
	}
	
	// Update term and convert to follower
	if req.Term > currentTerm {
		rc.currentTerm.Store(req.Term)
		rc.votedFor.Store("")
		rc.state.Store(Follower)
		rc.metrics.termChanges.Add(1)
	}
	
	// Reset election timer
	rc.resetElectionTimer()
	
	// Update leader
	rc.leader.Store(req.LeaderID)
	
	// Check log consistency
	if req.PrevLogIndex > 0 {
		if req.PrevLogIndex > uint64(len(rc.log)) {
			return AppendEntriesResponse{
				Term:          currentTerm,
				Success:       false,
				ConflictIndex: uint64(len(rc.log)) + 1,
			}
		}
		
		if rc.log[req.PrevLogIndex-1].Term != req.PrevLogTerm {
			conflictTerm := rc.log[req.PrevLogIndex-1].Term
			conflictIndex := req.PrevLogIndex
			
			// Find first entry with conflict term
			for i := req.PrevLogIndex - 1; i > 0; i-- {
				if rc.log[i-1].Term != conflictTerm {
					conflictIndex = i
					break
				}
			}
			
			return AppendEntriesResponse{
				Term:          currentTerm,
				Success:       false,
				ConflictIndex: conflictIndex,
				ConflictTerm:  conflictTerm,
			}
		}
	}
	
	// Append new entries
	for i, entry := range req.Entries {
		index := req.PrevLogIndex + uint64(i) + 1
		if index <= uint64(len(rc.log)) {
			// Check for conflicts
			if rc.log[index-1].Term != entry.Term {
				// Delete conflicting entries
				rc.log = rc.log[:index-1]
				rc.log = append(rc.log, entry)
			}
		} else {
			// Append new entry
			rc.log = append(rc.log, entry)
		}
	}
	
	// Update commit index
	if req.LeaderCommit > rc.commitIndex.Load() {
		newCommitIndex := req.LeaderCommit
		if uint64(len(rc.log)) < newCommitIndex {
			newCommitIndex = uint64(len(rc.log))
		}
		rc.commitIndex.Store(newCommitIndex)
	}
	
	return AppendEntriesResponse{
		Term:    currentTerm,
		Success: true,
	}
}

func (rc *RaftConsensus) handleRequestVote(req RequestVoteRequest) RequestVoteResponse {
	currentTerm := rc.currentTerm.Load()
	
	// Reply false if term < currentTerm
	if req.Term < currentTerm {
		return RequestVoteResponse{
			Term:        currentTerm,
			VoteGranted: false,
		}
	}
	
	// Update term if necessary
	if req.Term > currentTerm {
		rc.currentTerm.Store(req.Term)
		rc.votedFor.Store("")
		rc.state.Store(Follower)
		rc.metrics.termChanges.Add(1)
	}
	
	// Check if already voted
	votedFor := rc.votedFor.Load().(string)
	if votedFor != "" && votedFor != req.CandidateID {
		return RequestVoteResponse{
			Term:        currentTerm,
			VoteGranted: false,
		}
	}
	
	// Check log up-to-date
	lastLogIndex, lastLogTerm := rc.getLastLogIndexAndTerm()
	logUpToDate := req.LastLogTerm > lastLogTerm ||
		(req.LastLogTerm == lastLogTerm && req.LastLogIndex >= lastLogIndex)
	
	if logUpToDate {
		rc.votedFor.Store(req.CandidateID)
		rc.resetElectionTimer()
		
		return RequestVoteResponse{
			Term:        currentTerm,
			VoteGranted: true,
		}
	}
	
	return RequestVoteResponse{
		Term:        currentTerm,
		VoteGranted: false,
	}
}

func (rc *RaftConsensus) startElection() {
	rc.state.Store(Candidate)
	rc.currentTerm.Add(1)
	currentTerm := rc.currentTerm.Load()
	rc.votedFor.Store(rc.nodeID)
	rc.metrics.elections.Add(1)
	
	rc.logger.Info("Starting election", 
		zap.Uint64("term", currentTerm),
		zap.String("candidate", rc.nodeID))
	
	// Vote for self
	votes := 1
	
	// Request votes from other nodes
	rc.nodesMu.RLock()
	totalNodes := len(rc.nodes) + 1 // including self
	rc.nodesMu.RUnlock()
	
	voteCh := make(chan bool, totalNodes-1)
	
	rc.nodesMu.RLock()
	for nodeID, node := range rc.nodes {
		go func(id string, n *Node) {
			lastLogIndex, lastLogTerm := rc.getLastLogIndexAndTerm()
			req := RequestVoteRequest{
				Term:         currentTerm,
				CandidateID:  rc.nodeID,
				LastLogIndex: lastLogIndex,
				LastLogTerm:  lastLogTerm,
			}
			
			// Send request (implementation depends on transport)
			// For now, simulate response
			resp := RequestVoteResponse{
				Term:        currentTerm,
				VoteGranted: true, // Simplified
			}
			
			if resp.Term > currentTerm {
				rc.currentTerm.Store(resp.Term)
				rc.state.Store(Follower)
				rc.votedFor.Store("")
				voteCh <- false
				return
			}
			
			voteCh <- resp.VoteGranted
		}(nodeID, node)
	}
	rc.nodesMu.RUnlock()
	
	// Count votes
	electionTimer := time.NewTimer(rc.config.ElectionTimeoutMin)
	defer electionTimer.Stop()
	
	for i := 0; i < totalNodes-1; i++ {
		select {
		case vote := <-voteCh:
			if vote {
				votes++
				if votes > totalNodes/2 {
					// Won election
					rc.becomeLeader()
					return
				}
			}
		case <-electionTimer.C:
			// Election timeout
			rc.state.Store(Follower)
			return
		case <-rc.ctx.Done():
			return
		}
	}
	
	// Did not win election
	rc.state.Store(Follower)
}

func (rc *RaftConsensus) becomeLeader() {
	rc.state.Store(Leader)
	rc.leader.Store(rc.nodeID)
	
	rc.logger.Info("Became leader", 
		zap.String("node_id", rc.nodeID),
		zap.Uint64("term", rc.currentTerm.Load()))
	
	// Initialize leader state
	rc.nodesMu.RLock()
	lastLogIndex := rc.getLastLogIndex()
	for nodeID := range rc.nodes {
		rc.nextIndex[nodeID] = lastLogIndex + 1
		rc.matchIndex[nodeID] = 0
	}
	rc.nodesMu.RUnlock()
	
	// Send initial heartbeats
	rc.sendHeartbeats()
	
	// Start heartbeat timer
	rc.heartbeatTimer = time.NewTimer(rc.config.HeartbeatInterval)
	go rc.heartbeatLoop()
}

func (rc *RaftConsensus) heartbeatLoop() {
	for rc.state.Load().(NodeState) == Leader {
		select {
		case <-rc.heartbeatTimer.C:
			rc.sendHeartbeats()
			rc.replicateEntries()
			rc.heartbeatTimer.Reset(rc.config.HeartbeatInterval)
			
		case <-rc.ctx.Done():
			return
		}
	}
}

func (rc *RaftConsensus) sendHeartbeats() {
	rc.nodesMu.RLock()
	defer rc.nodesMu.RUnlock()
	
	for nodeID, node := range rc.nodes {
		go func(id string, n *Node) {
			req := AppendEntriesRequest{
				Term:         rc.currentTerm.Load(),
				LeaderID:     rc.nodeID,
				PrevLogIndex: rc.matchIndex[id],
				PrevLogTerm:  rc.getLogTerm(rc.matchIndex[id]),
				Entries:      []LogEntry{},
				LeaderCommit: rc.commitIndex.Load(),
			}
			
			// Send heartbeat (implementation depends on transport)
			_ = req
		}(nodeID, node)
	}
}

func (rc *RaftConsensus) replicateEntries() {
	rc.nodesMu.RLock()
	defer rc.nodesMu.RUnlock()
	
	for nodeID := range rc.nodes {
		go rc.replicateToNode(nodeID)
	}
}

func (rc *RaftConsensus) replicateToNode(nodeID string) {
	rc.logMu.RLock()
	defer rc.logMu.RUnlock()
	
	nextIdx := rc.nextIndex[nodeID]
	if nextIdx <= 0 {
		nextIdx = 1
	}
	
	// Get entries to send
	var entries []LogEntry
	if nextIdx <= uint64(len(rc.log)) {
		entries = rc.log[nextIdx-1:]
	}
	
	prevLogIndex := nextIdx - 1
	prevLogTerm := uint64(0)
	if prevLogIndex > 0 && prevLogIndex <= uint64(len(rc.log)) {
		prevLogTerm = rc.log[prevLogIndex-1].Term
	}
	
	req := AppendEntriesRequest{
		Term:         rc.currentTerm.Load(),
		LeaderID:     rc.nodeID,
		PrevLogIndex: prevLogIndex,
		PrevLogTerm:  prevLogTerm,
		Entries:      entries,
		LeaderCommit: rc.commitIndex.Load(),
	}
	
	// Send entries (implementation depends on transport)
	// Simulate response
	resp := AppendEntriesResponse{
		Term:    req.Term,
		Success: true,
	}
	
	if resp.Success {
		// Update indices
		rc.matchIndex[nodeID] = prevLogIndex + uint64(len(entries))
		rc.nextIndex[nodeID] = rc.matchIndex[nodeID] + 1
		
		// Check if we can commit
		rc.checkCommit()
	} else {
		// Decrement nextIndex and retry
		if rc.nextIndex[nodeID] > 1 {
			rc.nextIndex[nodeID]--
		}
	}
}

func (rc *RaftConsensus) checkCommit() {
	rc.logMu.RLock()
	defer rc.logMu.RUnlock()
	
	currentTerm := rc.currentTerm.Load()
	
	// Find highest index that a majority has
	for i := rc.commitIndex.Load() + 1; i <= uint64(len(rc.log)); i++ {
		if rc.log[i-1].Term != currentTerm {
			continue
		}
		
		count := 1 // self
		rc.nodesMu.RLock()
		for nodeID := range rc.nodes {
			if rc.matchIndex[nodeID] >= i {
				count++
			}
		}
		totalNodes := len(rc.nodes) + 1
		rc.nodesMu.RUnlock()
		
		if count > totalNodes/2 {
			rc.commitIndex.Store(i)
		}
	}
}

func (rc *RaftConsensus) applyCommittedEntries() {
	lastApplied := rc.lastApplied.Load()
	commitIndex := rc.commitIndex.Load()
	
	if lastApplied >= commitIndex {
		return
	}
	
	rc.logMu.RLock()
	entries := make([]LogEntry, 0)
	for i := lastApplied + 1; i <= commitIndex && i <= uint64(len(rc.log)); i++ {
		entries = append(entries, rc.log[i-1])
	}
	rc.logMu.RUnlock()
	
	for _, entry := range entries {
		start := time.Now()
		
		msg := ApplyMsg{
			CommandValid: true,
			Command:      entry.Command,
			CommandIndex: entry.Index,
		}
		
		// Apply to state machine
		_, err := rc.stateMachine.Apply(msg.Command)
		if err != nil {
			rc.logger.Error("Failed to apply command",
				zap.Uint64("index", entry.Index),
				zap.Error(err))
			continue
		}
		
		rc.lastApplied.Store(entry.Index)
		
		// Update metrics
		latency := time.Since(start).Microseconds()
		rc.metrics.commitLatency.Store(uint64(latency))
		
		// Send to apply channel for external observers
		select {
		case rc.applyCh <- msg:
		default:
		}
	}
}

func (rc *RaftConsensus) resetElectionTimer() {
	if rc.electionTimer != nil {
		rc.electionTimer.Stop()
	}
	rc.electionTimer = time.NewTimer(rc.randomElectionTimeout())
}

func (rc *RaftConsensus) randomElectionTimeout() time.Duration {
	min := rc.config.ElectionTimeoutMin.Milliseconds()
	max := rc.config.ElectionTimeoutMax.Milliseconds()
	
	// Generate random timeout between min and max
	var randomBytes [8]byte
	rand.Read(randomBytes[:])
	randomMs := binary.BigEndian.Uint64(randomBytes[:]) % uint64(max-min)
	
	return time.Duration(min+int64(randomMs)) * time.Millisecond
}

func (rc *RaftConsensus) getLastLogIndex() uint64 {
	return uint64(len(rc.log))
}

func (rc *RaftConsensus) getLastLogIndexAndTerm() (uint64, uint64) {
	if len(rc.log) == 0 {
		return 0, 0
	}
	lastEntry := rc.log[len(rc.log)-1]
	return lastEntry.Index, lastEntry.Term
}

func (rc *RaftConsensus) getLogTerm(index uint64) uint64 {
	if index == 0 || index > uint64(len(rc.log)) {
		return 0
	}
	return rc.log[index-1].Term
}

// GetMetrics returns consensus metrics
func (rc *RaftConsensus) GetMetrics() map[string]interface{} {
	rc.logMu.RLock()
	logSize := len(rc.log)
	rc.logMu.RUnlock()
	
	rc.nodesMu.RLock()
	clusterSize := len(rc.nodes) + 1
	rc.nodesMu.RUnlock()
	
	return map[string]interface{}{
		"node_id":        rc.nodeID,
		"state":          rc.state.Load().(NodeState).String(),
		"term":           rc.currentTerm.Load(),
		"leader":         rc.leader.Load().(string),
		"log_size":       logSize,
		"commit_index":   rc.commitIndex.Load(),
		"last_applied":   rc.lastApplied.Load(),
		"cluster_size":   clusterSize,
		"elections":      rc.metrics.elections.Load(),
		"term_changes":   rc.metrics.termChanges.Load(),
		"log_entries":    rc.metrics.logEntries.Load(),
		"commit_latency": rc.metrics.commitLatency.Load(),
	}
}

// String returns the string representation of NodeState
func (s NodeState) String() string {
	switch s {
	case Follower:
		return "Follower"
	case Candidate:
		return "Candidate"
	case Leader:
		return "Leader"
	default:
		return "Unknown"
	}
}

// MarshalJSON implements json.Marshaler
func (s NodeState) MarshalJSON() ([]byte, error) {
	return json.Marshal(s.String())
}