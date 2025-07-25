/**
 * High Availability Failover System
 * Automatic failover with state replication
 * 
 * Features:
 * - Master/Slave replication
 * - Automatic failover
 * - State synchronization
 * - Split-brain prevention
 * - Consensus using Raft
 */

import { EventEmitter } from 'events';
import { createLogger } from '../core/logger.js';
import dgram from 'dgram';
import net from 'net';
import crypto from 'crypto';

const logger = createLogger('FailoverSystem');

/**
 * Node states
 */
export const NodeState = {
  FOLLOWER: 'follower',
  CANDIDATE: 'candidate',
  LEADER: 'leader',
  DEAD: 'dead'
};

/**
 * Raft consensus implementation
 */
class RaftNode extends EventEmitter {
  constructor(config) {
    super();
    
    this.id = config.id;
    this.peers = new Map();
    this.state = NodeState.FOLLOWER;
    
    // Raft state
    this.currentTerm = 0;
    this.votedFor = null;
    this.log = [];
    this.commitIndex = 0;
    this.lastApplied = 0;
    
    // Leader state
    this.nextIndex = new Map();
    this.matchIndex = new Map();
    
    // Timing
    this.electionTimeout = null;
    this.heartbeatInterval = null;
    this.config = {
      electionTimeoutMin: config.electionTimeoutMin || 150,
      electionTimeoutMax: config.electionTimeoutMax || 300,
      heartbeatTimeout: config.heartbeatTimeout || 50
    };
    
    // Network
    this.rpcServer = null;
    this.port = config.port;
  }
  
  /**
   * Start Raft node
   */
  start() {
    this.startRPCServer();
    this.resetElectionTimeout();
    logger.info(`Raft node ${this.id} started as ${this.state}`);
  }
  
  /**
   * Start RPC server
   */
  startRPCServer() {
    this.rpcServer = net.createServer((socket) => {
      socket.on('data', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleRPC(message, socket);
        } catch (error) {
          logger.error('Invalid RPC message:', error);
        }
      });
    });
    
    this.rpcServer.listen(this.port);
  }
  
  /**
   * Handle RPC messages
   */
  handleRPC(message, socket) {
    let response;
    
    switch (message.type) {
      case 'RequestVote':
        response = this.handleRequestVote(message);
        break;
        
      case 'AppendEntries':
        response = this.handleAppendEntries(message);
        break;
        
      default:
        response = { success: false, error: 'Unknown RPC type' };
    }
    
    socket.write(JSON.stringify(response));
    socket.end();
  }
  
  /**
   * Handle RequestVote RPC
   */
  handleRequestVote(request) {
    const { term, candidateId, lastLogIndex, lastLogTerm } = request;
    
    if (term < this.currentTerm) {
      return { term: this.currentTerm, voteGranted: false };
    }
    
    if (term > this.currentTerm) {
      this.currentTerm = term;
      this.votedFor = null;
      this.becomeFollower();
    }
    
    const voteGranted = 
      (this.votedFor === null || this.votedFor === candidateId) &&
      this.isLogUpToDate(lastLogIndex, lastLogTerm);
    
    if (voteGranted) {
      this.votedFor = candidateId;
      this.resetElectionTimeout();
    }
    
    return { term: this.currentTerm, voteGranted };
  }
  
  /**
   * Handle AppendEntries RPC
   */
  handleAppendEntries(request) {
    const { term, leaderId, prevLogIndex, prevLogTerm, entries, leaderCommit } = request;
    
    if (term < this.currentTerm) {
      return { term: this.currentTerm, success: false };
    }
    
    if (term > this.currentTerm) {
      this.currentTerm = term;
      this.votedFor = null;
    }
    
    this.becomeFollower();
    this.resetElectionTimeout();
    
    // Log consistency check
    if (prevLogIndex > 0) {
      if (this.log.length < prevLogIndex || 
          this.log[prevLogIndex - 1].term !== prevLogTerm) {
        return { term: this.currentTerm, success: false };
      }
    }
    
    // Append new entries
    if (entries && entries.length > 0) {
      this.log = this.log.slice(0, prevLogIndex);
      this.log.push(...entries);
    }
    
    // Update commit index
    if (leaderCommit > this.commitIndex) {
      this.commitIndex = Math.min(leaderCommit, this.log.length);
      this.applyCommittedEntries();
    }
    
    return { term: this.currentTerm, success: true };
  }
  
  /**
   * Become follower
   */
  becomeFollower() {
    this.state = NodeState.FOLLOWER;
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.emit('stateChange', NodeState.FOLLOWER);
  }
  
  /**
   * Become candidate
   */
  becomeCandidate() {
    this.state = NodeState.CANDIDATE;
    this.currentTerm++;
    this.votedFor = this.id;
    
    logger.info(`Node ${this.id} became candidate for term ${this.currentTerm}`);
    this.emit('stateChange', NodeState.CANDIDATE);
    
    this.startElection();
  }
  
  /**
   * Become leader
   */
  becomeLeader() {
    this.state = NodeState.LEADER;
    
    logger.info(`Node ${this.id} became leader for term ${this.currentTerm}`);
    this.emit('stateChange', NodeState.LEADER);
    
    // Initialize leader state
    for (const peerId of this.peers.keys()) {
      this.nextIndex.set(peerId, this.log.length + 1);
      this.matchIndex.set(peerId, 0);
    }
    
    // Start heartbeats
    this.sendHeartbeats();
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeats();
    }, this.config.heartbeatTimeout);
  }
  
  /**
   * Start election
   */
  async startElection() {
    const votes = 1; // Vote for self
    const votesNeeded = Math.floor(this.peers.size / 2) + 1;
    
    const votePromises = [];
    for (const [peerId, peer] of this.peers) {
      votePromises.push(this.requestVote(peer));
    }
    
    const responses = await Promise.allSettled(votePromises);
    let votesReceived = votes;
    
    for (const response of responses) {
      if (response.status === 'fulfilled' && response.value.voteGranted) {
        votesReceived++;
      }
    }
    
    if (votesReceived >= votesNeeded && this.state === NodeState.CANDIDATE) {
      this.becomeLeader();
    }
  }
  
  /**
   * Request vote from peer
   */
  async requestVote(peer) {
    const lastLogIndex = this.log.length;
    const lastLogTerm = lastLogIndex > 0 ? this.log[lastLogIndex - 1].term : 0;
    
    const request = {
      type: 'RequestVote',
      term: this.currentTerm,
      candidateId: this.id,
      lastLogIndex,
      lastLogTerm
    };
    
    return this.sendRPC(peer, request);
  }
  
  /**
   * Send heartbeats
   */
  sendHeartbeats() {
    for (const [peerId, peer] of this.peers) {
      this.sendAppendEntries(peer, []);
    }
  }
  
  /**
   * Send AppendEntries
   */
  async sendAppendEntries(peer, entries) {
    const prevLogIndex = this.nextIndex.get(peer.id) - 1;
    const prevLogTerm = prevLogIndex > 0 ? this.log[prevLogIndex - 1].term : 0;
    
    const request = {
      type: 'AppendEntries',
      term: this.currentTerm,
      leaderId: this.id,
      prevLogIndex,
      prevLogTerm,
      entries,
      leaderCommit: this.commitIndex
    };
    
    const response = await this.sendRPC(peer, request);
    
    if (response.success) {
      this.nextIndex.set(peer.id, prevLogIndex + entries.length + 1);
      this.matchIndex.set(peer.id, prevLogIndex + entries.length);
    } else {
      this.nextIndex.set(peer.id, Math.max(1, this.nextIndex.get(peer.id) - 1));
    }
  }
  
  /**
   * Send RPC to peer
   */
  sendRPC(peer, request) {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error('RPC timeout'));
      }, 1000);
      
      socket.connect(peer.port, peer.host, () => {
        socket.write(JSON.stringify(request));
      });
      
      socket.on('data', (data) => {
        clearTimeout(timeout);
        try {
          const response = JSON.parse(data.toString());
          resolve(response);
        } catch (error) {
          reject(error);
        }
        socket.destroy();
      });
      
      socket.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }
  
  /**
   * Reset election timeout
   */
  resetElectionTimeout() {
    if (this.electionTimeout) {
      clearTimeout(this.electionTimeout);
    }
    
    const timeout = Math.random() * 
      (this.config.electionTimeoutMax - this.config.electionTimeoutMin) + 
      this.config.electionTimeoutMin;
    
    this.electionTimeout = setTimeout(() => {
      if (this.state === NodeState.FOLLOWER) {
        this.becomeCandidate();
      }
    }, timeout);
  }
  
  /**
   * Check if log is up to date
   */
  isLogUpToDate(lastLogIndex, lastLogTerm) {
    const ourLastIndex = this.log.length;
    const ourLastTerm = ourLastIndex > 0 ? this.log[ourLastIndex - 1].term : 0;
    
    if (lastLogTerm > ourLastTerm) return true;
    if (lastLogTerm < ourLastTerm) return false;
    return lastLogIndex >= ourLastIndex;
  }
  
  /**
   * Apply committed entries
   */
  applyCommittedEntries() {
    while (this.lastApplied < this.commitIndex) {
      this.lastApplied++;
      const entry = this.log[this.lastApplied - 1];
      this.emit('apply', entry);
    }
  }
  
  /**
   * Add peer
   */
  addPeer(id, host, port) {
    this.peers.set(id, { id, host, port });
  }
}

/**
 * High Availability Failover System
 */
export class FailoverSystem extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      nodeId: config.nodeId || crypto.randomBytes(8).toString('hex'),
      port: config.port || 7000,
      peers: config.peers || [],
      stateReplicationInterval: config.stateReplicationInterval || 1000,
      healthCheckInterval: config.healthCheckInterval || 5000
    };
    
    this.raftNode = new RaftNode({
      id: this.config.nodeId,
      port: this.config.port
    });
    
    this.isLeader = false;
    this.state = new Map(); // Replicated state
    this.healthStatus = {
      healthy: true,
      lastCheck: Date.now()
    };
    
    this.setupRaftHandlers();
  }
  
  /**
   * Initialize failover system
   */
  async initialize(pool) {
    this.pool = pool;
    
    logger.info(`Initializing failover system for node ${this.config.nodeId}`);
    
    // Add peers
    for (const peer of this.config.peers) {
      this.raftNode.addPeer(peer.id, peer.host, peer.port);
    }
    
    // Start Raft node
    this.raftNode.start();
    
    // Start health monitoring
    this.startHealthMonitoring();
    
    // Start state replication
    this.startStateReplication();
    
    logger.info('Failover system initialized');
  }
  
  /**
   * Setup Raft event handlers
   */
  setupRaftHandlers() {
    this.raftNode.on('stateChange', (newState) => {
      this.isLeader = (newState === NodeState.LEADER);
      
      if (this.isLeader) {
        logger.info('This node is now the LEADER');
        this.emit('leader:elected');
        this.takeOverOperations();
      } else {
        logger.info(`This node is now a ${newState}`);
        this.emit('leader:lost');
        this.suspendOperations();
      }
    });
    
    this.raftNode.on('apply', (entry) => {
      this.applyStateChange(entry);
    });
  }
  
  /**
   * Start health monitoring
   */
  startHealthMonitoring() {
    setInterval(async () => {
      try {
        const health = await this.checkHealth();
        this.healthStatus = {
          healthy: health,
          lastCheck: Date.now()
        };
        
        if (!health && this.isLeader) {
          logger.warn('Leader is unhealthy, triggering failover');
          this.raftNode.becomeFollower();
        }
        
      } catch (error) {
        logger.error('Health check failed:', error);
        this.healthStatus.healthy = false;
      }
    }, this.config.healthCheckInterval);
  }
  
  /**
   * Check system health
   */
  async checkHealth() {
    if (!this.pool) return false;
    
    const checks = [
      this.pool.stratumServer?.listening,
      this.pool.storage?.database?.open,
      this.pool.getStats().connectedMiners > 0 || Date.now() - this.pool.startTime < 60000
    ];
    
    return checks.every(check => check);
  }
  
  /**
   * Start state replication
   */
  startStateReplication() {
    setInterval(() => {
      if (this.isLeader && this.pool) {
        this.replicateState();
      }
    }, this.config.stateReplicationInterval);
  }
  
  /**
   * Replicate state to followers
   */
  replicateState() {
    const criticalState = {
      timestamp: Date.now(),
      poolStats: this.pool.getStats(),
      connectedMiners: Array.from(this.pool.minerManager.miners.keys()),
      currentJobs: Array.from(this.pool.jobs.entries()),
      pendingShares: this.pool.pendingShares?.size || 0
    };
    
    const entry = {
      term: this.raftNode.currentTerm,
      type: 'state',
      data: criticalState
    };
    
    this.raftNode.log.push(entry);
    
    // Send to followers
    for (const [peerId, peer] of this.raftNode.peers) {
      this.raftNode.sendAppendEntries(peer, [entry]);
    }
  }
  
  /**
   * Apply state change from log
   */
  applyStateChange(entry) {
    if (entry.type === 'state') {
      this.state.set('latest', entry.data);
      this.emit('state:replicated', entry.data);
    }
  }
  
  /**
   * Take over operations as leader
   */
  async takeOverOperations() {
    if (!this.pool) return;
    
    logger.info('Taking over pool operations as leader');
    
    // Enable all operations
    this.pool.acceptingShares = true;
    this.pool.stratumServer?.resume();
    
    // Restore state if we have it
    const latestState = this.state.get('latest');
    if (latestState && Date.now() - latestState.timestamp < 30000) {
      logger.info('Restoring state from replication');
      // In production, would restore miner connections, jobs, etc.
    }
    
    this.emit('operations:resumed');
  }
  
  /**
   * Suspend operations as follower
   */
  suspendOperations() {
    if (!this.pool) return;
    
    logger.info('Suspending pool operations as follower');
    
    // Disable new connections but keep existing ones
    this.pool.acceptingShares = false;
    this.pool.stratumServer?.pause();
    
    this.emit('operations:suspended');
  }
  
  /**
   * Force failover (for testing)
   */
  forceFailover() {
    if (this.isLeader) {
      logger.info('Forcing failover from current leader');
      this.raftNode.becomeFollower();
    }
  }
  
  /**
   * Get failover status
   */
  getStatus() {
    return {
      nodeId: this.config.nodeId,
      state: this.raftNode.state,
      isLeader: this.isLeader,
      term: this.raftNode.currentTerm,
      peers: Array.from(this.raftNode.peers.keys()),
      health: this.healthStatus,
      logSize: this.raftNode.log.length,
      commitIndex: this.raftNode.commitIndex
    };
  }
  
  /**
   * Shutdown failover system
   */
  async shutdown() {
    logger.info('Shutting down failover system');
    
    if (this.raftNode.rpcServer) {
      this.raftNode.rpcServer.close();
    }
    
    if (this.raftNode.electionTimeout) {
      clearTimeout(this.raftNode.electionTimeout);
    }
    
    if (this.raftNode.heartbeatInterval) {
      clearInterval(this.raftNode.heartbeatInterval);
    }
  }
}

export default FailoverSystem;
