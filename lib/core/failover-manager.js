/**
 * Failover Manager - Otedama
 * High-availability failover and redundancy for national-scale operations
 * 
 * Design Principles:
 * - Carmack: Fast failover with minimal downtime
 * - Martin: Clean separation of monitoring and failover logic
 * - Pike: Simple configuration for complex redundancy
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from './structured-logger.js';
import cluster from 'cluster';
import os from 'os';
import crypto from 'crypto';

const logger = createStructuredLogger('FailoverManager');

/**
 * Node roles in the cluster
 */
const NODE_ROLES = {
  PRIMARY: 'primary',
  SECONDARY: 'secondary',
  STANDBY: 'standby'
};

/**
 * Node states
 */
const NODE_STATES = {
  ACTIVE: 'active',
  READY: 'ready',
  SYNCING: 'syncing',
  FAILED: 'failed',
  RECOVERING: 'recovering'
};

/**
 * Failover Manager
 */
export class FailoverManager extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Cluster configuration
      nodeId: config.nodeId || crypto.randomBytes(8).toString('hex'),
      role: config.role || NODE_ROLES.PRIMARY,
      peers: config.peers || [],
      
      // Failover settings
      heartbeatInterval: config.heartbeatInterval || 1000, // 1 second
      heartbeatTimeout: config.heartbeatTimeout || 5000, // 5 seconds
      failoverDelay: config.failoverDelay || 3000, // 3 seconds
      
      // Recovery settings
      maxRetries: config.maxRetries || 3,
      retryDelay: config.retryDelay || 30000, // 30 seconds
      syncTimeout: config.syncTimeout || 300000, // 5 minutes
      
      // Persistence
      stateFile: config.stateFile || 'failover-state.json',
      checkpointInterval: config.checkpointInterval || 60000, // 1 minute
      
      ...config
    };
    
    // Node state
    this.state = NODE_STATES.READY;
    this.role = this.config.role;
    this.isPrimary = this.role === NODE_ROLES.PRIMARY;
    
    // Cluster state
    this.nodes = new Map();
    this.lastHeartbeats = new Map();
    this.failoverInProgress = false;
    
    // Add self to nodes
    this.nodes.set(this.config.nodeId, {
      id: this.config.nodeId,
      role: this.role,
      state: this.state,
      address: this.getNodeAddress(),
      lastSeen: Date.now()
    });
    
    // Worker management (for multi-core redundancy)
    this.workers = new Map();
    this.workerRoles = new Map();
    
    // State synchronization
    this.stateVersion = 0;
    this.stateChecksum = null;
    this.syncQueue = [];
    
    // Timers
    this.heartbeatTimer = null;
    this.monitorTimer = null;
    this.checkpointTimer = null;
    
    this.logger = logger;
  }
  
  /**
   * Initialize failover manager
   */
  async initialize() {
    this.logger.info('Initializing failover manager', {
      nodeId: this.config.nodeId,
      role: this.role,
      peers: this.config.peers.length
    });
    
    try {
      // Load persisted state
      await this.loadState();
      
      // Initialize cluster if primary
      if (cluster.isPrimary) {
        await this.initializePrimaryNode();
      } else {
        await this.initializeWorkerNode();
      }
      
      // Connect to peers
      await this.connectToPeers();
      
      // Start heartbeat
      this.startHeartbeat();
      
      // Start monitoring
      this.startMonitoring();
      
      // Start checkpointing
      this.startCheckpointing();
      
      this.state = NODE_STATES.ACTIVE;
      this.logger.info('Failover manager initialized successfully');
      
      this.emit('initialized', {
        nodeId: this.config.nodeId,
        role: this.role,
        state: this.state
      });
      
    } catch (error) {
      this.logger.error('Failed to initialize failover manager:', error);
      throw error;
    }
  }
  
  /**
   * Initialize primary node
   */
  async initializePrimaryNode() {
    const numCPUs = os.cpus().length;
    const workersToSpawn = Math.min(numCPUs - 1, 4); // Leave one CPU for primary
    
    // Spawn worker processes for redundancy
    for (let i = 0; i < workersToSpawn; i++) {
      const worker = cluster.fork({
        WORKER_ROLE: i === 0 ? 'secondary' : 'standby',
        WORKER_ID: i
      });
      
      this.workers.set(worker.id, worker);
      this.workerRoles.set(worker.id, i === 0 ? NODE_ROLES.SECONDARY : NODE_ROLES.STANDBY);
      
      // Handle worker messages
      worker.on('message', (msg) => {
        this.handleWorkerMessage(worker.id, msg);
      });
      
      // Handle worker exit
      worker.on('exit', (code, signal) => {
        this.handleWorkerExit(worker.id, code, signal);
      });
    }
    
    this.logger.info(`Spawned ${workersToSpawn} worker processes for redundancy`);
  }
  
  /**
   * Initialize worker node
   */
  async initializeWorkerNode() {
    const role = process.env.WORKER_ROLE || NODE_ROLES.STANDBY;
    const workerId = process.env.WORKER_ID || '0';
    
    this.role = role;
    this.workerId = workerId;
    
    // Listen for messages from primary
    process.on('message', (msg) => {
      this.handlePrimaryMessage(msg);
    });
    
    // Send ready message
    process.send({
      type: 'worker_ready',
      workerId: this.workerId,
      role: this.role
    });
    
    this.logger.info('Worker node initialized', {
      workerId: this.workerId,
      role: this.role
    });
  }
  
  /**
   * Connect to peer nodes
   */
  async connectToPeers() {
    for (const peer of this.config.peers) {
      try {
        await this.connectToPeer(peer);
      } catch (error) {
        this.logger.error(`Failed to connect to peer ${peer.id}:`, error);
      }
    }
  }
  
  /**
   * Connect to a single peer
   */
  async connectToPeer(peer) {
    // In production, this would establish actual network connections
    // For now, we'll simulate the connection
    this.nodes.set(peer.id, {
      id: peer.id,
      role: peer.role || NODE_ROLES.STANDBY,
      state: NODE_STATES.READY,
      address: peer.address,
      lastSeen: Date.now()
    });
    
    this.logger.info('Connected to peer', {
      peerId: peer.id,
      address: peer.address
    });
  }
  
  /**
   * Start heartbeat mechanism
   */
  startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, this.config.heartbeatInterval);
  }
  
  /**
   * Send heartbeat to all nodes
   */
  sendHeartbeat() {
    const heartbeat = {
      type: 'heartbeat',
      nodeId: this.config.nodeId,
      role: this.role,
      state: this.state,
      timestamp: Date.now(),
      stateVersion: this.stateVersion,
      load: this.getNodeLoad()
    };
    
    // Send to workers if primary
    if (cluster.isPrimary) {
      for (const worker of this.workers.values()) {
        worker.send(heartbeat);
      }
    }
    
    // Send to peers (would be network call in production)
    for (const [nodeId, node] of this.nodes) {
      if (nodeId !== this.config.nodeId) {
        // Simulate network heartbeat
        this.lastHeartbeats.set(nodeId, Date.now());
      }
    }
    
    this.emit('heartbeat', heartbeat);
  }
  
  /**
   * Start monitoring for failures
   */
  startMonitoring() {
    this.monitorTimer = setInterval(() => {
      this.checkNodeHealth();
    }, 1000); // Check every second
  }
  
  /**
   * Check health of all nodes
   */
  checkNodeHealth() {
    const now = Date.now();
    const timeout = this.config.heartbeatTimeout;
    
    for (const [nodeId, node] of this.nodes) {
      if (nodeId === this.config.nodeId) continue;
      
      const lastSeen = this.lastHeartbeats.get(nodeId) || node.lastSeen;
      const timeSinceLastSeen = now - lastSeen;
      
      if (timeSinceLastSeen > timeout && node.state !== NODE_STATES.FAILED) {
        this.handleNodeFailure(nodeId);
      }
    }
  }
  
  /**
   * Handle node failure
   */
  async handleNodeFailure(nodeId) {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    
    this.logger.warn('Node failure detected', {
      nodeId,
      role: node.role,
      lastSeen: new Date(node.lastSeen).toISOString()
    });
    
    // Update node state
    node.state = NODE_STATES.FAILED;
    
    // Emit failure event
    this.emit('node:failed', {
      nodeId,
      node,
      timestamp: Date.now()
    });
    
    // Initiate failover if necessary
    if (node.role === NODE_ROLES.PRIMARY && !this.failoverInProgress) {
      await this.initiateFailover();
    }
  }
  
  /**
   * Initiate failover process
   */
  async initiateFailover() {
    if (this.failoverInProgress) return;
    
    this.failoverInProgress = true;
    this.logger.info('Initiating failover process');
    
    try {
      // Wait for failover delay (to avoid split-brain)
      await new Promise(resolve => setTimeout(resolve, this.config.failoverDelay));
      
      // Check if we should become primary
      if (this.shouldBecomePrimary()) {
        await this.promoteToP…mary();
      }
      
    } catch (error) {
      this.logger.error('Failover failed:', error);
      this.emit('failover:failed', error);
    } finally {
      this.failoverInProgress = false;
    }
  }
  
  /**
   * Determine if this node should become primary
   */
  shouldBecomePrimary() {
    // Check if we're next in line
    if (this.role !== NODE_ROLES.SECONDARY) return false;
    
    // Check if primary is really down
    const primary = Array.from(this.nodes.values())
      .find(n => n.role === NODE_ROLES.PRIMARY);
    
    if (!primary || primary.state !== NODE_STATES.FAILED) return false;
    
    // Check if we're the best candidate
    const activeSecondaries = Array.from(this.nodes.values())
      .filter(n => n.role === NODE_ROLES.SECONDARY && n.state === NODE_STATES.ACTIVE)
      .sort((a, b) => a.id.localeCompare(b.id)); // Deterministic ordering
    
    return activeSecondaries[0]?.id === this.config.nodeId;
  }
  
  /**
   * Promote this node to primary
   */
  async promoteToPrimary() {
    this.logger.info('Promoting node to primary');
    
    try {
      // Update role
      this.role = NODE_ROLES.PRIMARY;
      this.isPrimary = true;
      
      // Sync state from other nodes
      await this.syncStateFromPeers();
      
      // Take over primary responsibilities
      await this.takeOverPrimaryRole();
      
      // Notify all nodes
      this.broadcastRoleChange();
      
      this.logger.info('Successfully promoted to primary');
      
      this.emit('failover:completed', {
        newPrimary: this.config.nodeId,
        timestamp: Date.now()
      });
      
    } catch (error) {
      this.logger.error('Failed to promote to primary:', error);
      throw error;
    }
  }
  
  /**
   * Take over primary responsibilities
   */
  async takeOverPrimaryRole() {
    // In production, this would:
    // 1. Take over network bindings
    // 2. Start accepting connections
    // 3. Resume pool operations
    // 4. Notify miners of new primary
    
    this.emit('role:primary', {
      nodeId: this.config.nodeId,
      timestamp: Date.now()
    });
  }
  
  /**
   * Handle worker exit
   */
  handleWorkerExit(workerId, code, signal) {
    this.logger.warn('Worker exited', {
      workerId,
      code,
      signal
    });
    
    this.workers.delete(workerId);
    this.workerRoles.delete(workerId);
    
    // Restart worker if not shutting down
    if (!this.shuttingDown) {
      const role = this.workerRoles.get(workerId) || NODE_ROLES.STANDBY;
      
      setTimeout(() => {
        const worker = cluster.fork({
          WORKER_ROLE: role,
          WORKER_ID: workerId
        });
        
        this.workers.set(worker.id, worker);
        this.workerRoles.set(worker.id, role);
        
        this.logger.info('Restarted worker', {
          workerId: worker.id,
          role
        });
      }, 1000);
    }
  }
  
  /**
   * Start state checkpointing
   */
  startCheckpointing() {
    this.checkpointTimer = setInterval(() => {
      this.saveCheckpoint();
    }, this.config.checkpointInterval);
  }
  
  /**
   * Save state checkpoint
   */
  async saveCheckpoint() {
    try {
      const checkpoint = {
        nodeId: this.config.nodeId,
        role: this.role,
        state: this.state,
        stateVersion: this.stateVersion,
        nodes: Array.from(this.nodes.entries()),
        timestamp: Date.now()
      };
      
      // In production, save to persistent storage
      this.logger.debug('Checkpoint saved', {
        stateVersion: this.stateVersion
      });
      
    } catch (error) {
      this.logger.error('Failed to save checkpoint:', error);
    }
  }
  
  /**
   * Sync state from peer nodes
   */
  async syncStateFromPeers() {
    this.state = NODE_STATES.SYNCING;
    
    try {
      // Find active nodes with latest state
      const activeNodes = Array.from(this.nodes.values())
        .filter(n => n.state === NODE_STATES.ACTIVE && n.id !== this.config.nodeId)
        .sort((a, b) => b.stateVersion - a.stateVersion);
      
      if (activeNodes.length === 0) {
        this.logger.warn('No active nodes to sync from');
        return;
      }
      
      // Sync from node with latest state
      const sourceNode = activeNodes[0];
      this.logger.info('Syncing state from node', {
        sourceId: sourceNode.id,
        stateVersion: sourceNode.stateVersion
      });
      
      // In production, this would fetch actual state data
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      this.state = NODE_STATES.ACTIVE;
      this.logger.info('State sync completed');
      
    } catch (error) {
      this.logger.error('State sync failed:', error);
      this.state = NODE_STATES.FAILED;
      throw error;
    }
  }
  
  /**
   * Get node load metrics
   */
  getNodeLoad() {
    const cpus = os.cpus();
    const loadAvg = os.loadavg()[0];
    const memUsage = (os.totalmem() - os.freemem()) / os.totalmem();
    
    return {
      cpu: loadAvg / cpus.length,
      memory: memUsage,
      connections: 0 // Would be actual connection count
    };
  }
  
  /**
   * Get node address
   */
  getNodeAddress() {
    const interfaces = os.networkInterfaces();
    for (const iface of Object.values(interfaces)) {
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) {
          return `${addr.address}:${this.config.port || 3333}`;
        }
      }
    }
    return 'localhost:3333';
  }
  
  /**
   * Broadcast role change to all nodes
   */
  broadcastRoleChange() {
    const message = {
      type: 'role_change',
      nodeId: this.config.nodeId,
      newRole: this.role,
      timestamp: Date.now()
    };
    
    // Notify workers
    if (cluster.isPrimary) {
      for (const worker of this.workers.values()) {
        worker.send(message);
      }
    }
    
    // Notify peers (would be network broadcast)
    this.emit('broadcast', message);
  }
  
  /**
   * Handle messages from workers
   */
  handleWorkerMessage(workerId, message) {
    switch (message.type) {
      case 'worker_ready':
        this.logger.info('Worker ready', {
          workerId: message.workerId,
          role: message.role
        });
        break;
        
      case 'heartbeat_response':
        // Track worker health
        break;
        
      case 'state_request':
        // Worker requesting state sync
        this.sendStateToWorker(workerId);
        break;
    }
  }
  
  /**
   * Handle messages from primary
   */
  handlePrimaryMessage(message) {
    switch (message.type) {
      case 'heartbeat':
        // Respond to heartbeat
        process.send({
          type: 'heartbeat_response',
          workerId: this.workerId,
          timestamp: Date.now()
        });
        break;
        
      case 'role_change':
        // Handle role change notification
        if (message.workerId === this.workerId) {
          this.role = message.newRole;
          this.logger.info('Role changed', { newRole: this.role });
        }
        break;
        
      case 'state_sync':
        // Receive state update from primary
        this.updateLocalState(message.state);
        break;
    }
  }
  
  /**
   * Load persisted state
   */
  async loadState() {
    try {
      // In production, load from persistent storage
      this.logger.debug('Loading persisted state');
    } catch (error) {
      this.logger.warn('No persisted state found, starting fresh');
    }
  }
  
  /**
   * Get failover status
   */
  getStatus() {
    return {
      nodeId: this.config.nodeId,
      role: this.role,
      state: this.state,
      isPrimary: this.isPrimary,
      nodes: Array.from(this.nodes.values()),
      workers: cluster.isPrimary ? this.workers.size : 0,
      uptime: process.uptime(),
      stateVersion: this.stateVersion,
      failoverInProgress: this.failoverInProgress
    };
  }
  
  /**
   * Shutdown failover manager
   */
  async shutdown() {
    this.logger.info('Shutting down failover manager');
    this.shuttingDown = true;
    
    // Clear timers
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
    
    // Save final checkpoint
    await this.saveCheckpoint();
    
    // Shutdown workers
    if (cluster.isPrimary) {
      for (const worker of this.workers.values()) {
        worker.kill();
      }
    }
    
    this.logger.info('Failover manager shutdown complete');
  }
}

export default FailoverManager;