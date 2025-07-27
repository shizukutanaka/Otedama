/**
 * High Availability Clustering System - Otedama
 * Multi-node clustering with automatic failover and load balancing
 * 
 * Design principles:
 * - Carmack: Zero-downtime failover with minimal latency
 * - Martin: Clean distributed architecture
 * - Pike: Simple cluster management
 */

import { EventEmitter } from 'events';
import cluster from 'cluster';
import os from 'os';
import { createServer, createConnection } from 'net';
import { WebSocketServer } from 'ws';
import Redis from 'ioredis';
import { createStructuredLogger } from '../core/structured-logger.js';
import { createHash, randomBytes } from 'crypto';

const logger = createStructuredLogger('HighAvailabilityCluster');

/**
 * Node states
 */
export const NodeState = {
  INITIALIZING: 'initializing',
  JOINING: 'joining',
  ACTIVE: 'active',
  STANDBY: 'standby',
  LEAVING: 'leaving',
  FAILED: 'failed'
};

/**
 * Node roles
 */
export const NodeRole = {
  MASTER: 'master',
  WORKER: 'worker',
  CANDIDATE: 'candidate'
};

/**
 * Consensus states
 */
export const ConsensusState = {
  FOLLOWER: 'follower',
  CANDIDATE: 'candidate',
  LEADER: 'leader'
};

/**
 * High Availability Cluster Node
 */
export class HAClusterNode extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Node identification
      nodeId: config.nodeId || randomBytes(16).toString('hex'),
      nodeName: config.nodeName || os.hostname(),
      
      // Cluster configuration
      clusterName: config.clusterName || 'otedama-cluster',
      clusterSecret: config.clusterSecret || randomBytes(32).toString('hex'),
      
      // Network configuration
      host: config.host || '0.0.0.0',
      port: config.port || 7000,
      discoveryPort: config.discoveryPort || 7001,
      
      // Redis configuration for shared state
      redis: config.redis || {
        host: 'localhost',
        port: 6379,
        db: 0,
        keyPrefix: 'otedama:cluster:'
      },
      
      // Timeouts and intervals
      heartbeatInterval: config.heartbeatInterval || 1000,
      heartbeatTimeout: config.heartbeatTimeout || 5000,
      electionTimeout: config.electionTimeout || 3000,
      syncInterval: config.syncInterval || 5000,
      
      // Cluster settings
      minNodes: config.minNodes || 3,
      maxNodes: config.maxNodes || 100,
      replicationFactor: config.replicationFactor || 3,
      
      // Performance settings
      workerProcesses: config.workerProcesses || os.cpus().length,
      loadBalancingStrategy: config.loadBalancingStrategy || 'round-robin',
      
      ...config
    };
    
    this.nodeId = this.config.nodeId;
    this.state = NodeState.INITIALIZING;
    this.role = NodeRole.WORKER;
    this.consensusState = ConsensusState.FOLLOWER;
    
    this.nodes = new Map();
    this.connections = new Map();
    this.workers = new Map();
    
    this.currentTerm = 0;
    this.votedFor = null;
    this.commitIndex = 0;
    this.lastApplied = 0;
    
    this.metrics = {
      messagesReceived: 0,
      messagesSent: 0,
      failovers: 0,
      elections: 0,
      uptime: Date.now()
    };
  }
  
  /**
   * Initialize cluster node
   */
  async initialize() {
    try {
      logger.info('Initializing HA cluster node', {
        nodeId: this.nodeId,
        nodeName: this.config.nodeName
      });
      
      // Initialize Redis connection
      await this.initializeRedis();
      
      // Setup network
      await this.setupNetwork();
      
      // Start discovery
      await this.startDiscovery();
      
      // Initialize workers if master
      if (cluster.isMaster) {
        await this.initializeWorkers();
      }
      
      // Start heartbeat
      this.startHeartbeat();
      
      // Start monitoring
      this.startMonitoring();
      
      this.state = NodeState.ACTIVE;
      
      logger.info('HA cluster node initialized', {
        nodeId: this.nodeId,
        state: this.state
      });
      
      this.emit('initialized');
      
    } catch (error) {
      logger.error('Failed to initialize cluster node', { error });
      this.state = NodeState.FAILED;
      throw error;
    }
  }
  
  /**
   * Initialize Redis connection
   */
  async initializeRedis() {
    // Primary Redis for shared state
    this.redis = new Redis(this.config.redis);
    
    // Pub/Sub Redis for cluster communication
    this.redisPub = new Redis(this.config.redis);
    this.redisSub = new Redis(this.config.redis);
    
    // Subscribe to cluster channels
    await this.redisSub.subscribe(
      `${this.config.clusterName}:broadcast`,
      `${this.config.clusterName}:${this.nodeId}`
    );
    
    // Handle messages
    this.redisSub.on('message', (channel, message) => {
      this.handleClusterMessage(channel, message);
    });
    
    // Register node
    await this.registerNode();
  }
  
  /**
   * Register node in cluster
   */
  async registerNode() {
    const nodeInfo = {
      id: this.nodeId,
      name: this.config.nodeName,
      host: this.config.host,
      port: this.config.port,
      state: this.state,
      role: this.role,
      lastHeartbeat: Date.now(),
      metrics: {
        cpu: os.loadavg()[0],
        memory: process.memoryUsage().heapUsed,
        connections: this.connections.size
      }
    };
    
    await this.redis.setex(
      `${this.config.redis.keyPrefix}node:${this.nodeId}`,
      30, // 30 second TTL
      JSON.stringify(nodeInfo)
    );
    
    // Add to node set
    await this.redis.sadd(`${this.config.redis.keyPrefix}nodes`, this.nodeId);
  }
  
  /**
   * Setup network servers
   */
  async setupNetwork() {
    // Main cluster server
    this.server = createServer((socket) => {
      this.handleConnection(socket);
    });
    
    // WebSocket server for real-time updates
    this.wss = new WebSocketServer({ 
      port: this.config.port + 1,
      perMessageDeflate: false
    });
    
    this.wss.on('connection', (ws) => {
      this.handleWebSocketConnection(ws);
    });
    
    // Start listening
    await new Promise((resolve, reject) => {
      this.server.listen(this.config.port, this.config.host, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    
    logger.info('Cluster network started', {
      host: this.config.host,
      port: this.config.port
    });
  }
  
  /**
   * Handle incoming connections
   */
  handleConnection(socket) {
    const connectionId = randomBytes(16).toString('hex');
    
    logger.debug('New cluster connection', {
      connectionId,
      remoteAddress: socket.remoteAddress
    });
    
    this.connections.set(connectionId, {
      socket,
      nodeId: null,
      authenticated: false,
      lastActivity: Date.now()
    });
    
    socket.on('data', (data) => {
      this.handleSocketData(connectionId, data);
    });
    
    socket.on('close', () => {
      this.connections.delete(connectionId);
    });
    
    socket.on('error', (error) => {
      logger.error('Socket error', { connectionId, error });
      this.connections.delete(connectionId);
    });
  }
  
  /**
   * Handle socket data
   */
  handleSocketData(connectionId, data) {
    try {
      const message = JSON.parse(data.toString());
      
      // Verify message signature
      if (!this.verifyMessage(message)) {
        logger.warn('Invalid message signature', { connectionId });
        return;
      }
      
      // Handle message based on type
      switch (message.type) {
        case 'auth':
          this.handleAuth(connectionId, message);
          break;
          
        case 'heartbeat':
          this.handleHeartbeat(connectionId, message);
          break;
          
        case 'vote_request':
          this.handleVoteRequest(connectionId, message);
          break;
          
        case 'vote_response':
          this.handleVoteResponse(connectionId, message);
          break;
          
        case 'append_entries':
          this.handleAppendEntries(connectionId, message);
          break;
          
        case 'sync_request':
          this.handleSyncRequest(connectionId, message);
          break;
          
        default:
          logger.warn('Unknown message type', { type: message.type });
      }
      
      this.metrics.messagesReceived++;
      
    } catch (error) {
      logger.error('Failed to handle socket data', { connectionId, error });
    }
  }
  
  /**
   * Start discovery process
   */
  async startDiscovery() {
    // Discover existing nodes
    const nodeIds = await this.redis.smembers(`${this.config.redis.keyPrefix}nodes`);
    
    for (const nodeId of nodeIds) {
      if (nodeId === this.nodeId) continue;
      
      const nodeData = await this.redis.get(`${this.config.redis.keyPrefix}node:${nodeId}`);
      if (nodeData) {
        const node = JSON.parse(nodeData);
        this.nodes.set(nodeId, node);
        
        // Connect to node
        this.connectToNode(node);
      }
    }
    
    // Periodic discovery
    this.discoveryInterval = setInterval(() => {
      this.discoverNodes();
    }, 10000); // Every 10 seconds
  }
  
  /**
   * Connect to another node
   */
  connectToNode(node) {
    if (node.id === this.nodeId) return;
    
    const socket = new createConnection({
      host: node.host,
      port: node.port
    });
    
    socket.on('connect', () => {
      logger.info('Connected to cluster node', { nodeId: node.id });
      
      // Authenticate
      this.sendMessage(socket, {
        type: 'auth',
        nodeId: this.nodeId,
        clusterName: this.config.clusterName
      });
    });
    
    socket.on('error', (error) => {
      logger.error('Failed to connect to node', { nodeId: node.id, error });
    });
  }
  
  /**
   * Initialize worker processes
   */
  async initializeWorkers() {
    const numWorkers = this.config.workerProcesses;
    
    for (let i = 0; i < numWorkers; i++) {
      const worker = cluster.fork();
      
      this.workers.set(worker.id, {
        id: worker.id,
        process: worker,
        state: 'starting',
        lastHeartbeat: Date.now(),
        metrics: {}
      });
      
      worker.on('message', (message) => {
        this.handleWorkerMessage(worker.id, message);
      });
      
      worker.on('exit', (code, signal) => {
        logger.warn('Worker exited', { workerId: worker.id, code, signal });
        this.workers.delete(worker.id);
        
        // Restart worker
        if (this.state === NodeState.ACTIVE) {
          this.initializeWorkers();
        }
      });
    }
    
    logger.info('Workers initialized', { count: numWorkers });
  }
  
  /**
   * Start heartbeat
   */
  startHeartbeat() {
    this.heartbeatInterval = setInterval(async () => {
      // Update node info
      await this.registerNode();
      
      // Send heartbeat to all nodes
      this.broadcast({
        type: 'heartbeat',
        nodeId: this.nodeId,
        state: this.state,
        role: this.role,
        term: this.currentTerm,
        metrics: this.getMetrics()
      });
      
      // Check node health
      this.checkNodeHealth();
      
    }, this.config.heartbeatInterval);
  }
  
  /**
   * Check node health
   */
  checkNodeHealth() {
    const now = Date.now();
    
    for (const [nodeId, node] of this.nodes) {
      const timeSinceHeartbeat = now - node.lastHeartbeat;
      
      if (timeSinceHeartbeat > this.config.heartbeatTimeout) {
        logger.warn('Node heartbeat timeout', {
          nodeId,
          lastHeartbeat: node.lastHeartbeat
        });
        
        // Mark node as failed
        node.state = NodeState.FAILED;
        
        // Trigger failover if needed
        if (node.role === NodeRole.MASTER) {
          this.triggerElection();
        }
      }
    }
  }
  
  /**
   * Trigger leader election (Raft consensus)
   */
  async triggerElection() {
    if (this.consensusState === ConsensusState.LEADER) return;
    
    logger.info('Triggering leader election', {
      nodeId: this.nodeId,
      currentTerm: this.currentTerm
    });
    
    // Increment term
    this.currentTerm++;
    this.consensusState = ConsensusState.CANDIDATE;
    this.votedFor = this.nodeId;
    
    let votes = 1; // Vote for self
    const majority = Math.floor(this.nodes.size / 2) + 1;
    
    // Request votes from all nodes
    const votePromises = Array.from(this.nodes.values()).map(async (node) => {
      if (node.id === this.nodeId) return;
      
      const response = await this.requestVote(node);
      if (response && response.voteGranted) {
        votes++;
      }
    });
    
    // Wait for votes
    await Promise.race([
      Promise.all(votePromises),
      new Promise(resolve => setTimeout(resolve, this.config.electionTimeout))
    ]);
    
    // Check if won election
    if (votes >= majority && this.consensusState === ConsensusState.CANDIDATE) {
      this.becomeLeader();
    } else {
      this.consensusState = ConsensusState.FOLLOWER;
    }
    
    this.metrics.elections++;
  }
  
  /**
   * Become leader
   */
  becomeLeader() {
    logger.info('Node became leader', {
      nodeId: this.nodeId,
      term: this.currentTerm
    });
    
    this.consensusState = ConsensusState.LEADER;
    this.role = NodeRole.MASTER;
    
    // Send initial heartbeat
    this.sendAppendEntries();
    
    // Start leader duties
    this.leaderInterval = setInterval(() => {
      this.sendAppendEntries();
    }, this.config.heartbeatInterval / 2);
    
    this.emit('becameLeader');
  }
  
  /**
   * Send append entries (heartbeat)
   */
  sendAppendEntries() {
    this.broadcast({
      type: 'append_entries',
      term: this.currentTerm,
      leaderId: this.nodeId,
      prevLogIndex: this.commitIndex,
      prevLogTerm: this.currentTerm,
      entries: [],
      leaderCommit: this.commitIndex
    });
  }
  
  /**
   * Handle failover
   */
  async handleFailover(failedNodeId) {
    logger.info('Handling failover', { failedNodeId });
    
    const failedNode = this.nodes.get(failedNodeId);
    if (!failedNode) return;
    
    // Redistribute work from failed node
    if (this.role === NodeRole.MASTER) {
      await this.redistributeWork(failedNodeId);
    }
    
    // Remove failed node
    this.nodes.delete(failedNodeId);
    await this.redis.srem(`${this.config.redis.keyPrefix}nodes`, failedNodeId);
    
    this.metrics.failovers++;
    this.emit('failover', { failedNodeId });
  }
  
  /**
   * Redistribute work from failed node
   */
  async redistributeWork(failedNodeId) {
    // Get work assignments from failed node
    const workKey = `${this.config.redis.keyPrefix}work:${failedNodeId}`;
    const work = await this.redis.smembers(workKey);
    
    if (work.length === 0) return;
    
    logger.info('Redistributing work', {
      failedNodeId,
      workItems: work.length
    });
    
    // Distribute work among healthy nodes
    const healthyNodes = Array.from(this.nodes.values())
      .filter(n => n.state === NodeState.ACTIVE && n.id !== failedNodeId);
    
    let nodeIndex = 0;
    for (const workItem of work) {
      const targetNode = healthyNodes[nodeIndex % healthyNodes.length];
      
      // Assign work to target node
      await this.redis.sadd(
        `${this.config.redis.keyPrefix}work:${targetNode.id}`,
        workItem
      );
      
      nodeIndex++;
    }
    
    // Clear failed node's work
    await this.redis.del(workKey);
  }
  
  /**
   * Get cluster status
   */
  async getClusterStatus() {
    const nodes = [];
    
    // Add self
    nodes.push({
      id: this.nodeId,
      name: this.config.nodeName,
      state: this.state,
      role: this.role,
      isSelf: true,
      metrics: this.getMetrics()
    });
    
    // Add other nodes
    for (const [nodeId, node] of this.nodes) {
      nodes.push({
        ...node,
        isSelf: false
      });
    }
    
    return {
      clusterId: this.config.clusterName,
      nodes,
      leader: this.getLeaderNode(),
      term: this.currentTerm,
      health: this.calculateClusterHealth(),
      metrics: {
        totalNodes: nodes.length,
        activeNodes: nodes.filter(n => n.state === NodeState.ACTIVE).length,
        failedNodes: nodes.filter(n => n.state === NodeState.FAILED).length,
        totalFailovers: this.metrics.failovers,
        totalElections: this.metrics.elections
      }
    };
  }
  
  /**
   * Get leader node
   */
  getLeaderNode() {
    if (this.role === NodeRole.MASTER) {
      return this.nodeId;
    }
    
    for (const [nodeId, node] of this.nodes) {
      if (node.role === NodeRole.MASTER) {
        return nodeId;
      }
    }
    
    return null;
  }
  
  /**
   * Calculate cluster health
   */
  calculateClusterHealth() {
    const activeNodes = Array.from(this.nodes.values())
      .filter(n => n.state === NodeState.ACTIVE).length + 1; // +1 for self
    
    const totalNodes = this.nodes.size + 1;
    const healthRatio = activeNodes / totalNodes;
    
    if (healthRatio >= 0.9) return 'healthy';
    if (healthRatio >= 0.7) return 'degraded';
    return 'critical';
  }
  
  /**
   * Get metrics
   */
  getMetrics() {
    return {
      cpu: os.loadavg()[0],
      memory: process.memoryUsage(),
      connections: this.connections.size,
      workers: this.workers.size,
      uptime: Date.now() - this.metrics.uptime,
      messagesReceived: this.metrics.messagesReceived,
      messagesSent: this.metrics.messagesSent
    };
  }
  
  /**
   * Broadcast message to all nodes
   */
  broadcast(message) {
    const signedMessage = this.signMessage(message);
    
    this.redisPub.publish(
      `${this.config.clusterName}:broadcast`,
      JSON.stringify(signedMessage)
    );
    
    this.metrics.messagesSent++;
  }
  
  /**
   * Send message to specific node
   */
  sendToNode(nodeId, message) {
    const signedMessage = this.signMessage(message);
    
    this.redisPub.publish(
      `${this.config.clusterName}:${nodeId}`,
      JSON.stringify(signedMessage)
    );
    
    this.metrics.messagesSent++;
  }
  
  /**
   * Sign message
   */
  signMessage(message) {
    const payload = {
      ...message,
      timestamp: Date.now(),
      nodeId: this.nodeId
    };
    
    const signature = createHash('sha256')
      .update(JSON.stringify(payload) + this.config.clusterSecret)
      .digest('hex');
    
    return {
      payload,
      signature
    };
  }
  
  /**
   * Verify message signature
   */
  verifyMessage(message) {
    if (!message.payload || !message.signature) return false;
    
    const expectedSignature = createHash('sha256')
      .update(JSON.stringify(message.payload) + this.config.clusterSecret)
      .digest('hex');
    
    return message.signature === expectedSignature;
  }
  
  /**
   * Handle cluster message
   */
  handleClusterMessage(channel, message) {
    try {
      const parsedMessage = JSON.parse(message);
      
      if (!this.verifyMessage(parsedMessage)) {
        logger.warn('Invalid cluster message signature');
        return;
      }
      
      const { payload } = parsedMessage;
      
      // Skip own messages
      if (payload.nodeId === this.nodeId) return;
      
      // Update node info
      if (payload.type === 'heartbeat') {
        this.nodes.set(payload.nodeId, {
          id: payload.nodeId,
          state: payload.state,
          role: payload.role,
          lastHeartbeat: Date.now(),
          metrics: payload.metrics
        });
      }
      
      // Handle other message types
      this.emit('clusterMessage', payload);
      
    } catch (error) {
      logger.error('Failed to handle cluster message', { error });
    }
  }
  
  /**
   * Shutdown cluster node
   */
  async shutdown() {
    logger.info('Shutting down cluster node', { nodeId: this.nodeId });
    
    // Update state
    this.state = NodeState.LEAVING;
    await this.registerNode();
    
    // Stop intervals
    clearInterval(this.heartbeatInterval);
    clearInterval(this.discoveryInterval);
    clearInterval(this.leaderInterval);
    
    // Close connections
    for (const conn of this.connections.values()) {
      conn.socket.end();
    }
    
    // Close servers
    this.server.close();
    this.wss.close();
    
    // Remove from cluster
    await this.redis.srem(`${this.config.redis.keyPrefix}nodes`, this.nodeId);
    await this.redis.del(`${this.config.redis.keyPrefix}node:${this.nodeId}`);
    
    // Close Redis connections
    this.redis.disconnect();
    this.redisPub.disconnect();
    this.redisSub.disconnect();
    
    // Terminate workers
    for (const worker of this.workers.values()) {
      worker.process.kill();
    }
    
    this.emit('shutdown');
  }
}

/**
 * Factory function
 */
export function createHACluster(config) {
  return new HAClusterNode(config);
}

export default HAClusterNode;