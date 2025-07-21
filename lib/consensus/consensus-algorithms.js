/**
 * Consensus Algorithms for Otedama
 * Raft and PBFT implementation for distributed consensus
 * 
 * Design principles:
 * - Carmack: High-performance consensus with minimal overhead
 * - Martin: Clean consensus protocol architecture
 * - Pike: Simple consensus API for distributed mining
 */

import { EventEmitter } from 'events';
import { createHash, randomBytes } from 'crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { logger } from '../core/logger.js';

/**
 * Consensus protocols
 */
export const ConsensusProtocol = {
  RAFT: 'raft',
  PBFT: 'pbft',
  POW: 'pow',
  POS: 'pos'
};

/**
 * Node states for Raft
 */
export const RaftState = {
  FOLLOWER: 'follower',
  CANDIDATE: 'candidate',
  LEADER: 'leader'
};

/**
 * Message types
 */
export const MessageType = {
  // Raft messages
  VOTE_REQUEST: 'vote_request',
  VOTE_RESPONSE: 'vote_response',
  APPEND_ENTRIES: 'append_entries',
  APPEND_RESPONSE: 'append_response',
  
  // PBFT messages
  PRE_PREPARE: 'pre_prepare',
  PREPARE: 'prepare',
  COMMIT: 'commit',
  VIEW_CHANGE: 'view_change',
  NEW_VIEW: 'new_view',
  
  // Common messages
  HEARTBEAT: 'heartbeat',
  CLIENT_REQUEST: 'client_request'
};

/**
 * Log entry structure
 */
export class LogEntry {
  constructor(data) {
    this.index = data.index;
    this.term = data.term;
    this.command = data.command;
    this.timestamp = data.timestamp || Date.now();
    this.hash = data.hash || this._calculateHash();
    this.committed = data.committed || false;
  }
  
  _calculateHash() {
    const content = JSON.stringify({
      index: this.index,
      term: this.term,
      command: this.command,
      timestamp: this.timestamp
    });
    return createHash('sha256').update(content).digest('hex');
  }
  
  toJSON() {
    return {
      index: this.index,
      term: this.term,
      command: this.command,
      timestamp: this.timestamp,
      hash: this.hash,
      committed: this.committed
    };
  }
}

/**
 * Raft consensus implementation
 */
export class RaftConsensus extends EventEmitter {
  constructor(nodeId, peers, options = {}) {
    super();
    
    this.nodeId = nodeId;
    this.peers = new Set(peers);
    
    this.options = {
      electionTimeout: options.electionTimeout || 150, // 150-300ms
      heartbeatInterval: options.heartbeatInterval || 50, // 50ms
      rpcTimeout: options.rpcTimeout || 100, // 100ms
      maxLogEntries: options.maxLogEntries || 10000,
      snapshotThreshold: options.snapshotThreshold || 1000,
      ...options
    };
    
    // Persistent state
    this.currentTerm = 0;
    this.votedFor = null;
    this.log = []; // Log entries
    
    // Volatile state
    this.commitIndex = 0;
    this.lastApplied = 0;
    this.state = RaftState.FOLLOWER;
    
    // Leader state
    this.nextIndex = new Map(); // For each server, index of next log entry to send
    this.matchIndex = new Map(); // For each server, index of highest log entry known to be replicated
    
    // Timers
    this.electionTimer = null;
    this.heartbeatTimer = null;
    
    // Network connections
    this.connections = new Map();
    this.server = null;
    
    // Metrics
    this.metrics = {
      totalRequests: 0,
      successfulRequests: 0,
      leaderElections: 0,
      logEntries: 0,
      snapshots: 0
    };
  }
  
  /**
   * Initialize Raft node
   */
  async initialize(port) {
    logger.info(`Initializing Raft node: ${this.nodeId}`);
    
    // Start server
    await this._startServer(port);
    
    // Connect to peers
    await this._connectToPeers();
    
    // Start as follower
    this._becomeFollower(0);
    
    this.emit('initialized');
  }
  
  /**
   * Start server for incoming connections
   */
  async _startServer(port) {
    this.server = new WebSocketServer({ port });
    
    this.server.on('connection', (ws, req) => {
      const peerId = req.headers['x-node-id'];
      if (peerId && this.peers.has(peerId)) {
        this.connections.set(peerId, ws);
        this._handleConnection(ws, peerId);
        logger.info(`Peer connected: ${peerId}`);
      } else {
        ws.close();
      }
    });
    
    logger.info(`Raft server listening on port ${port}`);
  }
  
  /**
   * Connect to peer nodes
   */
  async _connectToPeers() {
    for (const peerId of this.peers) {
      try {
        const ws = new WebSocket(`ws://localhost:${this._getPeerPort(peerId)}`, {
          headers: { 'x-node-id': this.nodeId }
        });
        
        ws.on('open', () => {
          this.connections.set(peerId, ws);
          this._handleConnection(ws, peerId);
          logger.info(`Connected to peer: ${peerId}`);
        });
        
        ws.on('error', (error) => {
          logger.warn(`Failed to connect to peer ${peerId}:`, error.message);
        });
        
      } catch (error) {
        logger.warn(`Connection error to ${peerId}:`, error.message);
      }
    }
  }
  
  /**
   * Handle peer connection
   */
  _handleConnection(ws, peerId) {
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        this._handleMessage(message, peerId);
      } catch (error) {
        logger.error(`Error parsing message from ${peerId}:`, error);
      }
    });
    
    ws.on('close', () => {
      this.connections.delete(peerId);
      logger.info(`Peer disconnected: ${peerId}`);
    });
  }
  
  /**
   * Handle incoming messages
   */
  async _handleMessage(message, fromPeer) {
    switch (message.type) {
      case MessageType.VOTE_REQUEST:
        await this._handleVoteRequest(message, fromPeer);
        break;
        
      case MessageType.VOTE_RESPONSE:
        await this._handleVoteResponse(message, fromPeer);
        break;
        
      case MessageType.APPEND_ENTRIES:
        await this._handleAppendEntries(message, fromPeer);
        break;
        
      case MessageType.APPEND_RESPONSE:
        await this._handleAppendResponse(message, fromPeer);
        break;
        
      case MessageType.CLIENT_REQUEST:
        await this._handleClientRequest(message, fromPeer);
        break;
    }
  }
  
  /**
   * Become follower
   */
  _becomeFollower(term) {
    this.state = RaftState.FOLLOWER;
    this.currentTerm = Math.max(this.currentTerm, term);
    this.votedFor = null;
    
    this._clearHeartbeatTimer();
    this._resetElectionTimer();
    
    this.emit('state:changed', { state: this.state, term: this.currentTerm });
  }
  
  /**
   * Become candidate and start election
   */
  async _becomeCandidate() {
    this.state = RaftState.CANDIDATE;
    this.currentTerm++;
    this.votedFor = this.nodeId;
    this.metrics.leaderElections++;
    
    this._resetElectionTimer();
    
    logger.info(`Starting election for term ${this.currentTerm}`);
    
    // Request votes from all peers
    const votes = await this._requestVotes();
    const majority = Math.floor(this.peers.size / 2) + 1;
    
    if (votes >= majority) {
      await this._becomeLeader();
    } else {
      this._becomeFollower(this.currentTerm);
    }
    
    this.emit('state:changed', { state: this.state, term: this.currentTerm });
  }
  
  /**
   * Become leader
   */
  async _becomeLeader() {
    this.state = RaftState.LEADER;
    
    this._clearElectionTimer();
    this._startHeartbeat();
    
    // Initialize leader state
    const lastLogIndex = this.log.length;
    for (const peerId of this.peers) {
      this.nextIndex.set(peerId, lastLogIndex + 1);
      this.matchIndex.set(peerId, 0);
    }
    
    logger.info(`Became leader for term ${this.currentTerm}`);
    
    // Send initial heartbeat
    await this._sendHeartbeat();
    
    this.emit('state:changed', { state: this.state, term: this.currentTerm });
    this.emit('leader:elected', { nodeId: this.nodeId, term: this.currentTerm });
  }
  
  /**
   * Request votes from peers
   */
  async _requestVotes() {
    const lastLogIndex = this.log.length;
    const lastLogTerm = lastLogIndex > 0 ? this.log[lastLogIndex - 1].term : 0;
    
    const voteRequest = {
      type: MessageType.VOTE_REQUEST,
      term: this.currentTerm,
      candidateId: this.nodeId,
      lastLogIndex,
      lastLogTerm
    };
    
    const promises = [];
    for (const peerId of this.peers) {
      promises.push(this._sendRPC(peerId, voteRequest));
    }
    
    const responses = await Promise.allSettled(promises);
    let votes = 1; // Vote for self
    
    for (const response of responses) {
      if (response.status === 'fulfilled' && response.value?.voteGranted) {
        votes++;
      }
    }
    
    return votes;
  }
  
  /**
   * Handle vote request
   */
  async _handleVoteRequest(message, fromPeer) {
    const { term, candidateId, lastLogIndex, lastLogTerm } = message;
    
    let voteGranted = false;
    
    if (term > this.currentTerm) {
      this._becomeFollower(term);
    }
    
    if (term === this.currentTerm && 
        (this.votedFor === null || this.votedFor === candidateId)) {
      
      // Check if candidate's log is at least as up-to-date as receiver's log
      const ourLastIndex = this.log.length;
      const ourLastTerm = ourLastIndex > 0 ? this.log[ourLastIndex - 1].term : 0;
      
      const logUpToDate = lastLogTerm > ourLastTerm || 
                         (lastLogTerm === ourLastTerm && lastLogIndex >= ourLastIndex);
      
      if (logUpToDate) {
        this.votedFor = candidateId;
        voteGranted = true;
        this._resetElectionTimer();
      }
    }
    
    const response = {
      type: MessageType.VOTE_RESPONSE,
      term: this.currentTerm,
      voteGranted
    };
    
    await this._sendMessage(fromPeer, response);
  }
  
  /**
   * Handle vote response
   */
  async _handleVoteResponse(message, fromPeer) {
    if (this.state !== RaftState.CANDIDATE) return;
    
    const { term, voteGranted } = message;
    
    if (term > this.currentTerm) {
      this._becomeFollower(term);
    }
    
    // Votes are counted in _requestVotes method
  }
  
  /**
   * Send heartbeat to all followers
   */
  async _sendHeartbeat() {
    if (this.state !== RaftState.LEADER) return;
    
    const promises = [];
    for (const peerId of this.peers) {
      const prevLogIndex = this.nextIndex.get(peerId) - 1;
      const prevLogTerm = prevLogIndex > 0 ? this.log[prevLogIndex - 1].term : 0;
      
      const message = {
        type: MessageType.APPEND_ENTRIES,
        term: this.currentTerm,
        leaderId: this.nodeId,
        prevLogIndex,
        prevLogTerm,
        entries: [], // Heartbeat has empty entries
        leaderCommit: this.commitIndex
      };
      
      promises.push(this._sendMessage(peerId, message));
    }
    
    await Promise.allSettled(promises);
  }
  
  /**
   * Handle append entries (log replication and heartbeat)
   */
  async _handleAppendEntries(message, fromPeer) {
    const { term, leaderId, prevLogIndex, prevLogTerm, entries, leaderCommit } = message;
    
    let success = false;
    
    if (term >= this.currentTerm) {
      this._becomeFollower(term);
      this._resetElectionTimer();
      
      // Check if log contains an entry at prevLogIndex whose term matches prevLogTerm
      if (prevLogIndex === 0 || 
          (prevLogIndex <= this.log.length && 
           this.log[prevLogIndex - 1].term === prevLogTerm)) {
        
        success = true;
        
        // If an existing entry conflicts with a new one, delete the existing entry and all that follow it
        if (entries.length > 0) {
          const conflictIndex = this._findConflictIndex(entries, prevLogIndex);
          
          if (conflictIndex !== -1) {
            this.log = this.log.slice(0, conflictIndex);
          }
          
          // Append new entries
          for (let i = conflictIndex === -1 ? prevLogIndex : conflictIndex; i < prevLogIndex + entries.length; i++) {
            const entryIndex = i - prevLogIndex;
            if (entryIndex < entries.length) {
              this.log[i] = new LogEntry(entries[entryIndex]);
            }
          }
          
          this.metrics.logEntries += entries.length;
        }
        
        // Update commit index
        if (leaderCommit > this.commitIndex) {
          this.commitIndex = Math.min(leaderCommit, this.log.length);
          await this._applyCommittedEntries();
        }
      }
    }
    
    const response = {
      type: MessageType.APPEND_RESPONSE,
      term: this.currentTerm,
      success,
      matchIndex: success ? prevLogIndex + entries.length : 0
    };
    
    await this._sendMessage(fromPeer, response);
  }
  
  /**
   * Handle append response
   */
  async _handleAppendResponse(message, fromPeer) {
    if (this.state !== RaftState.LEADER) return;
    
    const { term, success, matchIndex } = message;
    
    if (term > this.currentTerm) {
      this._becomeFollower(term);
      return;
    }
    
    if (success) {
      this.nextIndex.set(fromPeer, matchIndex + 1);
      this.matchIndex.set(fromPeer, matchIndex);
      
      // Update commit index
      await this._updateCommitIndex();
    } else {
      // Decrement nextIndex and retry
      const nextIdx = this.nextIndex.get(fromPeer);
      this.nextIndex.set(fromPeer, Math.max(nextIdx - 1, 1));
    }
  }
  
  /**
   * Handle client request
   */
  async _handleClientRequest(message, fromPeer) {
    this.metrics.totalRequests++;
    
    if (this.state !== RaftState.LEADER) {
      const response = {
        type: 'client_response',
        success: false,
        error: 'Not leader',
        leaderId: this._getLeaderId()
      };
      await this._sendMessage(fromPeer, response);
      return;
    }
    
    // Append entry to log
    const entry = new LogEntry({
      index: this.log.length + 1,
      term: this.currentTerm,
      command: message.command
    });
    
    this.log.push(entry);
    
    // Replicate to followers
    await this._replicateEntry(entry);
    
    this.metrics.successfulRequests++;
    
    const response = {
      type: 'client_response',
      success: true,
      index: entry.index
    };
    
    await this._sendMessage(fromPeer, response);
  }
  
  /**
   * Replicate log entry to followers
   */
  async _replicateEntry(entry) {
    const promises = [];
    
    for (const peerId of this.peers) {
      const prevLogIndex = this.nextIndex.get(peerId) - 1;
      const prevLogTerm = prevLogIndex > 0 ? this.log[prevLogIndex - 1].term : 0;
      
      const message = {
        type: MessageType.APPEND_ENTRIES,
        term: this.currentTerm,
        leaderId: this.nodeId,
        prevLogIndex,
        prevLogTerm,
        entries: [entry],
        leaderCommit: this.commitIndex
      };
      
      promises.push(this._sendMessage(peerId, message));
    }
    
    await Promise.allSettled(promises);
  }
  
  /**
   * Find conflict index in entries
   */
  _findConflictIndex(entries, prevLogIndex) {
    for (let i = 0; i < entries.length; i++) {
      const logIndex = prevLogIndex + i;
      if (logIndex < this.log.length && 
          this.log[logIndex].term !== entries[i].term) {
        return logIndex;
      }
    }
    return -1;
  }
  
  /**
   * Update commit index based on majority replication
   */
  async _updateCommitIndex() {
    const matchIndexes = Array.from(this.matchIndex.values()).sort((a, b) => b - a);
    const majority = Math.floor(this.peers.size / 2);
    
    if (matchIndexes.length > majority) {
      const newCommitIndex = matchIndexes[majority];
      
      if (newCommitIndex > this.commitIndex && 
          newCommitIndex <= this.log.length &&
          this.log[newCommitIndex - 1].term === this.currentTerm) {
        
        this.commitIndex = newCommitIndex;
        await this._applyCommittedEntries();
      }
    }
  }
  
  /**
   * Apply committed entries to state machine
   */
  async _applyCommittedEntries() {
    while (this.lastApplied < this.commitIndex) {
      this.lastApplied++;
      const entry = this.log[this.lastApplied - 1];
      entry.committed = true;
      
      this.emit('entry:committed', entry);
    }
  }
  
  /**
   * Start heartbeat timer
   */
  _startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      this._sendHeartbeat();
    }, this.options.heartbeatInterval);
  }
  
  /**
   * Clear heartbeat timer
   */
  _clearHeartbeatTimer() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
  
  /**
   * Reset election timer
   */
  _resetElectionTimer() {
    this._clearElectionTimer();
    
    const timeout = this.options.electionTimeout + 
                   Math.floor(Math.random() * this.options.electionTimeout);
    
    this.electionTimer = setTimeout(() => {
      if (this.state !== RaftState.LEADER) {
        this._becomeCandidate();
      }
    }, timeout);
  }
  
  /**
   * Clear election timer
   */
  _clearElectionTimer() {
    if (this.electionTimer) {
      clearTimeout(this.electionTimer);
      this.electionTimer = null;
    }
  }
  
  /**
   * Send RPC message and wait for response
   */
  async _sendRPC(peerId, message) {
    return new Promise((resolve, reject) => {
      const connection = this.connections.get(peerId);
      if (!connection || connection.readyState !== WebSocket.OPEN) {
        reject(new Error(`No connection to peer: ${peerId}`));
        return;
      }
      
      const requestId = randomBytes(8).toString('hex');
      message.requestId = requestId;
      
      const timeout = setTimeout(() => {
        reject(new Error('RPC timeout'));
      }, this.options.rpcTimeout);
      
      const responseHandler = (data) => {
        try {
          const response = JSON.parse(data);
          if (response.requestId === requestId) {
            clearTimeout(timeout);
            connection.off('message', responseHandler);
            resolve(response);
          }
        } catch (error) {
          // Ignore parsing errors for other messages
        }
      };
      
      connection.on('message', responseHandler);
      connection.send(JSON.stringify(message));
    });
  }
  
  /**
   * Send message to peer
   */
  async _sendMessage(peerId, message) {
    const connection = this.connections.get(peerId);
    if (connection && connection.readyState === WebSocket.OPEN) {
      connection.send(JSON.stringify(message));
    }
  }
  
  /**
   * Get peer port (simplified mapping)
   */
  _getPeerPort(peerId) {
    // Simple port mapping - in real implementation would use service discovery
    const basePort = 9000;
    const nodeNumber = parseInt(peerId.replace(/\D/g, '')) || 0;
    return basePort + nodeNumber;
  }
  
  /**
   * Get current leader ID
   */
  _getLeaderId() {
    // In real implementation, would track current leader
    return this.state === RaftState.LEADER ? this.nodeId : null;
  }
  
  /**
   * Submit command to cluster
   */
  async submitCommand(command) {
    if (this.state !== RaftState.LEADER) {
      throw new Error('Only leader can accept commands');
    }
    
    const entry = new LogEntry({
      index: this.log.length + 1,
      term: this.currentTerm,
      command
    });
    
    this.log.push(entry);
    await this._replicateEntry(entry);
    
    return entry;
  }
  
  /**
   * Get cluster status
   */
  getStatus() {
    return {
      nodeId: this.nodeId,
      state: this.state,
      currentTerm: this.currentTerm,
      votedFor: this.votedFor,
      logLength: this.log.length,
      commitIndex: this.commitIndex,
      lastApplied: this.lastApplied,
      peers: Array.from(this.peers),
      connections: this.connections.size,
      metrics: this.metrics
    };
  }
  
  /**
   * Shutdown node
   */
  async shutdown() {
    logger.info(`Shutting down Raft node: ${this.nodeId}`);
    
    this._clearElectionTimer();
    this._clearHeartbeatTimer();
    
    // Close all connections
    for (const connection of this.connections.values()) {
      connection.close();
    }
    
    if (this.server) {
      this.server.close();
    }
    
    this.emit('shutdown');
  }
}

/**
 * PBFT (Practical Byzantine Fault Tolerance) consensus
 */
export class PBFTConsensus extends EventEmitter {
  constructor(nodeId, replicas, options = {}) {
    super();
    
    this.nodeId = nodeId;
    this.replicas = new Set(replicas);
    this.f = Math.floor((this.replicas.size - 1) / 3); // Maximum Byzantine faults
    
    this.options = {
      viewTimeout: options.viewTimeout || 2000,
      requestTimeout: options.requestTimeout || 1000,
      checkpointInterval: options.checkpointInterval || 100,
      ...options
    };
    
    // PBFT state
    this.view = 0;
    this.sequenceNumber = 0;
    this.checkpointSequence = 0;
    
    // Message logs
    this.clientRequests = new Map();
    this.prePrepares = new Map();
    this.prepares = new Map();
    this.commits = new Map();
    this.checkpoints = new Map();
    
    // Network
    this.connections = new Map();
    this.server = null;
    
    // Timers
    this.viewTimer = null;
    
    // Metrics
    this.metrics = {
      totalRequests: 0,
      processedRequests: 0,
      viewChanges: 0,
      checkpoints: 0
    };
  }
  
  /**
   * Initialize PBFT node
   */
  async initialize(port) {
    logger.info(`Initializing PBFT node: ${this.nodeId}`);
    
    // Initialize Byzantine fault tolerance
    this._initializeByzantineTolerance();
    
    await this._startServer(port);
    await this._connectToReplicas();
    
    this._startViewTimer();
    
    this.emit('initialized');
  }
  
  /**
   * Start server for incoming connections
   */
  async _startServer(port) {
    this.server = new WebSocketServer({ port });
    
    this.server.on('connection', (ws, req) => {
      const replicaId = req.headers['x-replica-id'];
      if (replicaId && this.replicas.has(replicaId)) {
        this.connections.set(replicaId, ws);
        this._handleConnection(ws, replicaId);
      } else {
        ws.close();
      }
    });
  }
  
  /**
   * Connect to other replicas
   */
  async _connectToReplicas() {
    for (const replicaId of this.replicas) {
      if (replicaId === this.nodeId) continue;
      
      try {
        const ws = new WebSocket(`ws://localhost:${this._getReplicaPort(replicaId)}`, {
          headers: { 'x-replica-id': this.nodeId }
        });
        
        ws.on('open', () => {
          this.connections.set(replicaId, ws);
          this._handleConnection(ws, replicaId);
        });
        
      } catch (error) {
        logger.warn(`Failed to connect to replica ${replicaId}:`, error.message);
      }
    }
  }
  
  /**
   * Handle replica connection
   */
  _handleConnection(ws, replicaId) {
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        
        // Byzantine fault detection: verify message authenticity
        if (this.options.byzantineDetection !== false) {
          const isValid = this._validateMessage(message, replicaId);
          if (!isValid) {
            this._recordSuspiciousActivity(replicaId, 'invalid_message');
            return;
          }
          
          // Check for Byzantine behavior patterns
          const byzantineCheck = this._checkByzantineBehavior(message, replicaId);
          if (!byzantineCheck.valid) {
            this._recordSuspiciousActivity(replicaId, byzantineCheck.reason);
            return;
          }
        }
        
        this._handleMessage(message, replicaId);
      } catch (error) {
        logger.error(`Error parsing message from ${replicaId}:`, error);
        this._recordSuspiciousActivity(replicaId, 'malformed_message');
      }
    });
    
    ws.on('close', () => {
      this.connections.delete(replicaId);
    });
  }
  
  /**
   * Handle incoming messages
   */
  async _handleMessage(message, fromReplica) {
    switch (message.type) {
      case MessageType.CLIENT_REQUEST:
        await this._handleClientRequest(message);
        break;
        
      case MessageType.PRE_PREPARE:
        await this._handlePrePrepare(message, fromReplica);
        break;
        
      case MessageType.PREPARE:
        await this._handlePrepare(message, fromReplica);
        break;
        
      case MessageType.COMMIT:
        await this._handleCommit(message, fromReplica);
        break;
        
      case MessageType.VIEW_CHANGE:
        await this._handleViewChange(message, fromReplica);
        break;
    }
  }
  
  /**
   * Handle client request
   */
  async _handleClientRequest(message) {
    this.metrics.totalRequests++;
    
    if (!this._isPrimary()) {
      // Forward to primary or reject
      return;
    }
    
    const { clientId, timestamp, operation } = message;
    const requestDigest = this._calculateDigest(message);
    
    // Check for duplicate requests
    if (this.clientRequests.has(requestDigest)) {
      return;
    }
    
    this.clientRequests.set(requestDigest, message);
    this.sequenceNumber++;
    
    // Send pre-prepare to all backups
    const prePrepare = {
      type: MessageType.PRE_PREPARE,
      view: this.view,
      sequenceNumber: this.sequenceNumber,
      digest: requestDigest,
      request: message
    };
    
    await this._broadcast(prePrepare);
    this.prePrepares.set(this._getMessageKey(this.view, this.sequenceNumber), prePrepare);
  }
  
  /**
   * Handle pre-prepare message
   */
  async _handlePrePrepare(message, fromReplica) {
    const { view, sequenceNumber, digest, request } = message;
    
    // Validate message
    if (view !== this.view || !this._isPrimary(fromReplica)) {
      return;
    }
    
    const messageKey = this._getMessageKey(view, sequenceNumber);
    
    // Check if we already have this pre-prepare
    if (this.prePrepares.has(messageKey)) {
      return;
    }
    
    // Verify digest
    if (this._calculateDigest(request) !== digest) {
      return;
    }
    
    this.prePrepares.set(messageKey, message);
    
    // Send prepare message
    const prepare = {
      type: MessageType.PREPARE,
      view,
      sequenceNumber,
      digest,
      nodeId: this.nodeId
    };
    
    await this._broadcast(prepare);
  }
  
  /**
   * Handle prepare message
   */
  async _handlePrepare(message, fromReplica) {
    const { view, sequenceNumber, digest, nodeId } = message;
    
    if (view !== this.view) return;
    
    const messageKey = this._getMessageKey(view, sequenceNumber);
    
    if (!this.prepares.has(messageKey)) {
      this.prepares.set(messageKey, new Map());
    }
    
    this.prepares.get(messageKey).set(nodeId, message);
    
    // Check if we have enough prepare messages (2f)
    if (this.prepares.get(messageKey).size >= 2 * this.f) {
      // Send commit message
      const commit = {
        type: MessageType.COMMIT,
        view,
        sequenceNumber,
        digest,
        nodeId: this.nodeId
      };
      
      await this._broadcast(commit);
    }
  }
  
  /**
   * Handle commit message
   */
  async _handleCommit(message, fromReplica) {
    const { view, sequenceNumber, digest, nodeId } = message;
    
    if (view !== this.view) return;
    
    const messageKey = this._getMessageKey(view, sequenceNumber);
    
    if (!this.commits.has(messageKey)) {
      this.commits.set(messageKey, new Map());
    }
    
    this.commits.get(messageKey).set(nodeId, message);
    
    // Check if we have enough commit messages (2f + 1)
    if (this.commits.get(messageKey).size >= 2 * this.f + 1) {
      await this._executeRequest(messageKey, sequenceNumber);
    }
  }
  
  /**
   * Execute committed request
   */
  async _executeRequest(messageKey, sequenceNumber) {
    const prePrepare = this.prePrepares.get(messageKey);
    if (!prePrepare) return;
    
    const request = prePrepare.request;
    
    // Execute the operation
    this.emit('request:executed', {
      sequenceNumber,
      request,
      timestamp: Date.now()
    });
    
    this.metrics.processedRequests++;
    
    // Check if we need to create a checkpoint
    if (sequenceNumber % this.options.checkpointInterval === 0) {
      await this._createCheckpoint(sequenceNumber);
    }
    
    // Clean up old messages
    this._cleanupMessages(sequenceNumber);
  }
  
  /**
   * Create checkpoint
   */
  async _createCheckpoint(sequenceNumber) {
    const checkpoint = {
      type: 'checkpoint',
      sequenceNumber,
      digest: this._calculateStateDigest(),
      nodeId: this.nodeId
    };
    
    await this._broadcast(checkpoint);
    this.metrics.checkpoints++;
    
    this.checkpointSequence = sequenceNumber;
  }
  
  /**
   * Handle view change
   */
  async _handleViewChange(message, fromReplica) {
    // Simplified view change handling
    this.metrics.viewChanges++;
  }
  
  /**
   * Start view change
   */
  async _startViewChange() {
    this.view++;
    
    const viewChange = {
      type: MessageType.VIEW_CHANGE,
      newView: this.view,
      nodeId: this.nodeId,
      checkpointSequence: this.checkpointSequence
    };
    
    await this._broadcast(viewChange);
    this._startViewTimer();
  }
  
  /**
   * Broadcast message to all replicas
   */
  async _broadcast(message) {
    const promises = [];
    for (const [replicaId, connection] of this.connections) {
      if (connection.readyState === WebSocket.OPEN) {
        promises.push(this._sendMessage(replicaId, message));
      }
    }
    await Promise.allSettled(promises);
  }
  
  /**
   * Send message to specific replica
   */
  async _sendMessage(replicaId, message) {
    const connection = this.connections.get(replicaId);
    if (connection && connection.readyState === WebSocket.OPEN) {
      connection.send(JSON.stringify(message));
    }
  }
  
  /**
   * Check if this node is primary
   */
  _isPrimary(nodeId = this.nodeId) {
    const sortedReplicas = Array.from(this.replicas).sort();
    const primaryIndex = this.view % sortedReplicas.length;
    return sortedReplicas[primaryIndex] === nodeId;
  }
  
  /**
   * Calculate message digest
   */
  _calculateDigest(message) {
    const content = JSON.stringify(message);
    return createHash('sha256').update(content).digest('hex');
  }
  
  /**
   * Calculate state digest
   */
  _calculateStateDigest() {
    // In real implementation, would hash the application state
    return createHash('sha256')
      .update(this.sequenceNumber.toString())
      .update(this.view.toString())
      .digest('hex');
  }
  
  /**
   * Get message key
   */
  _getMessageKey(view, sequenceNumber) {
    return `${view}:${sequenceNumber}`;
  }
  
  /**
   * Get replica port
   */
  _getReplicaPort(replicaId) {
    const basePort = 9100;
    const nodeNumber = parseInt(replicaId.replace(/\D/g, '')) || 0;
    return basePort + nodeNumber;
  }
  
  /**
   * Start view timer
   */
  _startViewTimer() {
    this._clearViewTimer();
    this.viewTimer = setTimeout(() => {
      this._startViewChange();
    }, this.options.viewTimeout);
  }
  
  /**
   * Clear view timer
   */
  _clearViewTimer() {
    if (this.viewTimer) {
      clearTimeout(this.viewTimer);
      this.viewTimer = null;
    }
  }
  
  /**
   * Clean up old messages
   */
  _cleanupMessages(sequenceNumber) {
    // Remove messages older than checkpoint
    const cutoff = Math.max(sequenceNumber - this.options.checkpointInterval, 0);
    
    for (const [key, value] of this.prePrepares) {
      const [view, seq] = key.split(':').map(Number);
      if (seq < cutoff) {
        this.prePrepares.delete(key);
        this.prepares.delete(key);
        this.commits.delete(key);
      }
    }
  }
  
  /**
   * Get cluster status
   */
  getStatus() {
    return {
      nodeId: this.nodeId,
      view: this.view,
      sequenceNumber: this.sequenceNumber,
      checkpointSequence: this.checkpointSequence,
      replicas: Array.from(this.replicas),
      connections: this.connections.size,
      isPrimary: this._isPrimary(),
      faultTolerance: this.f,
      byzantineStatus: this.getByzantineStatus(),
      metrics: this.metrics
    };
  }
  
  /**
   * Shutdown node
   */
  async shutdown() {
    logger.info(`Shutting down PBFT node: ${this.nodeId}`);
    
    this._clearViewTimer();
    
    for (const connection of this.connections.values()) {
      connection.close();
    }
    
    if (this.server) {
      this.server.close();
    }
    
    this.emit('shutdown');
  }
  
  /**
   * Enhanced Byzantine fault tolerance methods
   */
  
  /**
   * Validate message for Byzantine fault detection
   */
  _validateMessage(message, fromNode) {
    // Check if node is already marked as Byzantine
    if (this.byzantineNodes && this.byzantineNodes.has(fromNode)) {
      logger.warn(`Ignoring message from Byzantine node: ${fromNode}`);
      return false;
    }
    
    // Verify message structure
    if (!message.type || message.view === undefined || message.sequence === undefined) {
      return false;
    }
    
    // Check message age if timestamp provided
    if (message.timestamp) {
      const age = Date.now() - message.timestamp;
      if (age > (this.options.maxMessageAge || 60000)) {
        logger.warn(`Message too old from ${fromNode}: ${age}ms`);
        return false;
      }
      
      // Check for future timestamps (clock manipulation)
      if (message.timestamp > Date.now() + 5000) { // 5 second tolerance
        logger.warn(`Future timestamp from ${fromNode}`);
        return false;
      }
    }
    
    return true;
  }
  
  /**
   * Initialize Byzantine fault tolerance
   */
  _initializeByzantineTolerance() {
    // Verify we have enough replicas for Byzantine fault tolerance
    const totalReplicas = this.replicas.size;
    this.f = Math.floor((totalReplicas - 1) / 3);
    
    if (totalReplicas < 4) {
      throw new Error(`PBFT requires at least 4 replicas for Byzantine fault tolerance, got ${totalReplicas}`);
    }
    
    if (totalReplicas < 3 * this.f + 1) {
      throw new Error(`Need at least ${3 * this.f + 1} replicas to tolerate ${this.f} Byzantine faults`);
    }
    
    // Initialize Byzantine detection structures
    this.byzantineNodes = new Set();
    this.suspiciousActivity = new Map();
    this.messageHashes = new Map();
    
    // Start Byzantine detection cleanup
    setInterval(() => this._cleanupByzantineData(), 60000); // Every minute
  }
  
  /**
   * Record suspicious activity for Byzantine detection
   */
  _recordSuspiciousActivity(nodeId, reason) {
    if (!this.suspiciousActivity) {
      this.suspiciousActivity = new Map();
    }
    
    if (!this.suspiciousActivity.has(nodeId)) {
      this.suspiciousActivity.set(nodeId, { count: 0, reasons: [] });
    }
    
    const activity = this.suspiciousActivity.get(nodeId);
    activity.count++;
    activity.reasons.push({ reason, timestamp: Date.now() });
    activity.lastSeen = Date.now();
    
    // Mark as Byzantine if threshold exceeded
    if (activity.count >= 5) {
      if (!this.byzantineNodes) {
        this.byzantineNodes = new Set();
      }
      
      this.byzantineNodes.add(nodeId);
      logger.error(`Node ${nodeId} marked as Byzantine: ${reason}`);
      this.emit('byzantine:detected', { nodeId, activity });
      
      // Disconnect from Byzantine node
      const connection = this.connections.get(nodeId);
      if (connection) {
        connection.close();
        this.connections.delete(nodeId);
      }
    }
  }
  
  /**
   * Check for Byzantine behavior patterns
   */
  _checkByzantineBehavior(message, fromNode) {
    if (!this.messageHashes) {
      this.messageHashes = new Map();
    }
    
    // Check for equivocation (sending different messages for same view/sequence)
    const messageKey = `${message.type}-${message.view}-${message.sequence}`;
    const existingHash = this.messageHashes.get(messageKey);
    
    if (existingHash) {
      const currentHash = this._calculateMessageHash(message);
      if (existingHash.hash !== currentHash && existingHash.nodeId === fromNode) {
        return {
          valid: false,
          reason: 'equivocation_detected'
        };
      }
    } else {
      this.messageHashes.set(messageKey, {
        hash: this._calculateMessageHash(message),
        nodeId: fromNode,
        timestamp: Date.now()
      });
    }
    
    // Check for view/sequence number consistency
    if (message.view < this.view - 1 || message.view > this.view + 2) {
      return {
        valid: false,
        reason: 'inconsistent_view_number'
      };
    }
    
    // Detect flooding attacks
    const recentMessages = Array.from(this.messageHashes.values())
      .filter(m => m.nodeId === fromNode && Date.now() - m.timestamp < 1000);
    
    if (recentMessages.length > 50) { // More than 50 messages per second
      return {
        valid: false,
        reason: 'flooding_attack'
      };
    }
    
    return { valid: true };
  }
  
  /**
   * Calculate message hash for integrity
   */
  _calculateMessageHash(message) {
    const content = JSON.stringify({
      type: message.type,
      view: message.view,
      sequence: message.sequence,
      digest: message.digest,
      nodeId: message.nodeId
    });
    return createHash('sha256').update(content).digest('hex');
  }
  
  /**
   * Clean up old Byzantine detection data
   */
  _cleanupByzantineData() {
    if (!this.messageHashes || !this.suspiciousActivity) {
      return;
    }
    
    const now = Date.now();
    const maxAge = 300000; // 5 minutes
    
    // Clean message hashes
    for (const [key, data] of this.messageHashes) {
      if (now - data.timestamp > maxAge) {
        this.messageHashes.delete(key);
      }
    }
    
    // Clean suspicious activity
    for (const [nodeId, activity] of this.suspiciousActivity) {
      if (now - activity.lastSeen > maxAge) {
        this.suspiciousActivity.delete(nodeId);
      }
    }
  }
  
  /**
   * Get Byzantine fault tolerance status
   */
  getByzantineStatus() {
    const totalNodes = this.replicas.size;
    const byzantineCount = this.byzantineNodes ? this.byzantineNodes.size : 0;
    const maxTolerable = this.f;
    
    return {
      totalNodes,
      byzantineDetected: byzantineCount,
      maxTolerable,
      isHealthy: byzantineCount <= maxTolerable,
      byzantineNodes: this.byzantineNodes ? Array.from(this.byzantineNodes) : [],
      suspiciousNodes: this.suspiciousActivity ? Array.from(this.suspiciousActivity.keys()) : []
    };
  }
}

/**
 * Consensus manager
 */
export class ConsensusManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      protocol: options.protocol || ConsensusProtocol.RAFT,
      nodeId: options.nodeId || `node-${Date.now()}`,
      peers: options.peers || [],
      port: options.port || 9000,
      ...options
    };
    
    this.consensus = null;
    this.metrics = {
      startTime: Date.now(),
      totalCommands: 0,
      successfulCommands: 0
    };
  }
  
  /**
   * Initialize consensus
   */
  async initialize() {
    logger.info(`Initializing consensus with protocol: ${this.options.protocol}`);
    
    switch (this.options.protocol) {
      case ConsensusProtocol.RAFT:
        this.consensus = new RaftConsensus(
          this.options.nodeId,
          this.options.peers,
          this.options
        );
        break;
        
      case ConsensusProtocol.PBFT:
        this.consensus = new PBFTConsensus(
          this.options.nodeId,
          this.options.peers,
          this.options
        );
        break;
        
      default:
        throw new Error(`Unsupported protocol: ${this.options.protocol}`);
    }
    
    // Forward events
    this.consensus.on('entry:committed', (entry) => {
      this.emit('command:committed', entry);
    });
    
    this.consensus.on('request:executed', (request) => {
      this.emit('command:executed', request);
    });
    
    await this.consensus.initialize(this.options.port);
    
    this.emit('initialized');
  }
  
  /**
   * Submit command
   */
  async submitCommand(command) {
    this.metrics.totalCommands++;
    
    try {
      let result;
      
      if (this.options.protocol === ConsensusProtocol.RAFT) {
        result = await this.consensus.submitCommand(command);
      } else if (this.options.protocol === ConsensusProtocol.PBFT) {
        // PBFT handles commands differently
        result = { success: true, command };
      }
      
      this.metrics.successfulCommands++;
      return result;
      
    } catch (error) {
      logger.error('Command submission failed:', error);
      throw error;
    }
  }
  
  /**
   * Get consensus status
   */
  getStatus() {
    const baseStatus = {
      protocol: this.options.protocol,
      nodeId: this.options.nodeId,
      uptime: Date.now() - this.metrics.startTime,
      metrics: this.metrics
    };
    
    if (this.consensus) {
      return {
        ...baseStatus,
        ...this.consensus.getStatus()
      };
    }
    
    return baseStatus;
  }
  
  /**
   * Shutdown
   */
  async shutdown() {
    logger.info('Shutting down consensus manager');
    
    if (this.consensus) {
      await this.consensus.shutdown();
    }
    
    this.emit('shutdown');
  }
}

export default { RaftConsensus, PBFTConsensus, ConsensusManager };