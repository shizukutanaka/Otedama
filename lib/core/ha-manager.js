/**
 * High Availability Manager for Otedama
 * Ensures pool continuity with automatic failover
 * 
 * Design:
 * - Carmack: Fast failover with minimal downtime
 * - Martin: Clean separation of monitoring and action
 * - Pike: Simple but reliable HA implementation
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import axios from 'axios';
import os from 'os';

const logger = createStructuredLogger('HAManager');

export const NodeRole = {
  PRIMARY: 'PRIMARY',
  SECONDARY: 'SECONDARY',
  OBSERVER: 'OBSERVER'
};

export const NodeState = {
  ACTIVE: 'ACTIVE',
  STANDBY: 'STANDBY',
  FAILED: 'FAILED',
  RECOVERING: 'RECOVERING'
};

/**
 * High Availability Manager
 */
export class HAManager extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      nodeId: config.nodeId || os.hostname(),
      role: config.role || NodeRole.PRIMARY,
      peers: config.peers || [],
      heartbeatInterval: config.heartbeatInterval || 1000,
      failoverTimeout: config.failoverTimeout || 5000,
      recoveryTimeout: config.recoveryTimeout || 30000,
      dataDir: config.dataDir || './data/ha',
      ...config
    };
    
    this.state = NodeState.ACTIVE;
    this.peers = new Map();
    this.lastHeartbeat = Date.now();
    this.failoverInProgress = false;
    
    // Heartbeat timers
    this.heartbeatTimer = null;
    this.monitorTimer = null;
    
    // Statistics
    this.stats = {
      failovers: 0,
      recoveries: 0,
      downtime: 0,
      lastFailover: null
    };
  }
  
  /**
   * Initialize HA manager
   */
  async initialize() {
    logger.info('Initializing HA manager', {
      nodeId: this.config.nodeId,
      role: this.config.role,
      peers: this.config.peers.length
    });
    
    // Initialize peer connections
    for (const peer of this.config.peers) {
      this.peers.set(peer.id, {
        ...peer,
        state: NodeState.STANDBY,
        lastSeen: 0,
        latency: 0
      });
    }
    
    // Start heartbeat
    this.startHeartbeat();
    
    // Start monitoring
    this.startMonitoring();
    
    this.emit('initialized');
  }
  
  /**
   * Start heartbeat broadcasting
   */
  startHeartbeat() {
    this.heartbeatTimer = setInterval(async () => {
      await this.sendHeartbeat();
    }, this.config.heartbeatInterval);
  }
  
  /**
   * Send heartbeat to peers
   */
  async sendHeartbeat() {
    const heartbeat = {
      nodeId: this.config.nodeId,
      role: this.config.role,
      state: this.state,
      timestamp: Date.now(),
      load: this.getSystemLoad(),
      metadata: await this.getNodeMetadata()
    };
    
    // Broadcast to all peers
    const promises = [];
    
    for (const [peerId, peer] of this.peers) {
      promises.push(this.sendToPeer(peer, 'heartbeat', heartbeat));
    }
    
    await Promise.allSettled(promises);
  }
  
  /**
   * Send message to peer
   */
  async sendToPeer(peer, type, data) {
    try {
      const startTime = Date.now();
      
      const response = await axios.post(
        `http://${peer.host}:${peer.port}/ha/${type}`,
        data,
        {
          timeout: 1000,
          headers: {
            'X-Node-Id': this.config.nodeId,
            'X-Auth-Token': peer.authToken
          }
        }
      );
      
      // Update peer status
      peer.state = NodeState.ACTIVE;
      peer.lastSeen = Date.now();
      peer.latency = Date.now() - startTime;
      
      return response.data;
      
    } catch (error) {
      // Mark peer as potentially failed
      if (peer.state === NodeState.ACTIVE) {
        logger.warn('Peer heartbeat failed', {
          peerId: peer.id,
          error: error.message
        });
      }
      
      return null;
    }
  }
  
  /**
   * Handle incoming heartbeat
   */
  handleHeartbeat(nodeId, heartbeat) {
    const peer = this.peers.get(nodeId);
    
    if (!peer) {
      logger.warn('Heartbeat from unknown peer', { nodeId });
      return;
    }
    
    // Update peer info
    peer.state = heartbeat.state;
    peer.lastSeen = Date.now();
    peer.load = heartbeat.load;
    peer.metadata = heartbeat.metadata;
    
    // Check for role conflicts
    if (heartbeat.role === NodeRole.PRIMARY && 
        this.config.role === NodeRole.PRIMARY && 
        heartbeat.state === NodeState.ACTIVE &&
        this.state === NodeState.ACTIVE) {
      
      // Split-brain situation!
      this.handleSplitBrain(nodeId, heartbeat);
    }
  }
  
  /**
   * Start monitoring peers
   */
  startMonitoring() {
    this.monitorTimer = setInterval(() => {
      this.checkPeerHealth();
    }, this.config.heartbeatInterval * 2);
  }
  
  /**
   * Check peer health
   */
  checkPeerHealth() {
    const now = Date.now();
    
    for (const [peerId, peer] of this.peers) {
      const timeSinceLastSeen = now - peer.lastSeen;
      
      // Check if peer has failed
      if (peer.state === NodeState.ACTIVE && 
          timeSinceLastSeen > this.config.failoverTimeout) {
        
        peer.state = NodeState.FAILED;
        
        logger.error('Peer failure detected', {
          peerId: peer.id,
          lastSeen: peer.lastSeen,
          timeout: timeSinceLastSeen
        });
        
        this.emit('peer:failed', peer);
        
        // Initiate failover if this was the primary
        if (peer.role === NodeRole.PRIMARY && 
            this.config.role === NodeRole.SECONDARY) {
          this.initiateFailover();
        }
      }
      
      // Check if peer has recovered
      if (peer.state === NodeState.FAILED && 
          timeSinceLastSeen < this.config.failoverTimeout) {
        
        peer.state = NodeState.RECOVERING;
        
        logger.info('Peer recovery detected', { peerId: peer.id });
        
        this.emit('peer:recovered', peer);
      }
    }
  }
  
  /**
   * Initiate failover process
   */
  async initiateFailover() {
    if (this.failoverInProgress) {
      logger.warn('Failover already in progress');
      return;
    }
    
    logger.info('Initiating failover process');
    
    this.failoverInProgress = true;
    this.stats.failovers++;
    this.stats.lastFailover = Date.now();
    
    try {
      // Step 1: Verify primary is really down
      const primaryDown = await this.verifyPrimaryFailure();
      
      if (!primaryDown) {
        logger.info('Primary is still active, aborting failover');
        this.failoverInProgress = false;
        return;
      }
      
      // Step 2: Check if we should become primary
      const shouldPromote = await this.shouldPromoteToPrimary();
      
      if (!shouldPromote) {
        logger.info('Another node has higher priority');
        this.failoverInProgress = false;
        return;
      }
      
      // Step 3: Promote to primary
      await this.promoteToPrimary();
      
      // Step 4: Notify other nodes
      await this.notifyPromotion();
      
      logger.info('Failover completed successfully');
      
      this.emit('failover:complete', {
        newPrimary: this.config.nodeId,
        timestamp: Date.now()
      });
      
    } catch (error) {
      logger.error('Failover failed', error);
      
      this.emit('failover:failed', error);
      
    } finally {
      this.failoverInProgress = false;
    }
  }
  
  /**
   * Verify primary failure
   */
  async verifyPrimaryFailure() {
    const primary = Array.from(this.peers.values())
      .find(p => p.role === NodeRole.PRIMARY);
    
    if (!primary) return true;
    
    // Try direct connection
    try {
      const response = await axios.get(
        `http://${primary.host}:${primary.port}/ha/status`,
        { timeout: 2000 }
      );
      
      return response.data.state !== NodeState.ACTIVE;
      
    } catch (error) {
      // Primary is not responding
      return true;
    }
  }
  
  /**
   * Check if this node should become primary
   */
  async shouldPromoteToPrimary() {
    // Get all active secondary nodes
    const secondaries = Array.from(this.peers.values())
      .filter(p => p.role === NodeRole.SECONDARY && p.state === NodeState.ACTIVE);
    
    // Add ourselves
    secondaries.push({
      id: this.config.nodeId,
      priority: this.config.priority || 0,
      load: this.getSystemLoad()
    });
    
    // Sort by priority and load
    secondaries.sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      return a.load.cpu - b.load.cpu;
    });
    
    // Check if we're the best candidate
    return secondaries[0].id === this.config.nodeId;
  }
  
  /**
   * Promote to primary role
   */
  async promoteToPrimary() {
    logger.info('Promoting to primary role');
    
    // Update role and state
    this.config.role = NodeRole.PRIMARY;
    this.state = NodeState.ACTIVE;
    
    // Perform promotion tasks
    await this.onPromoteToPrimary();
  }
  
  /**
   * Notify other nodes of promotion
   */
  async notifyPromotion() {
    const notification = {
      nodeId: this.config.nodeId,
      newRole: NodeRole.PRIMARY,
      timestamp: Date.now()
    };
    
    const promises = [];
    
    for (const [peerId, peer] of this.peers) {
      if (peer.state === NodeState.ACTIVE) {
        promises.push(this.sendToPeer(peer, 'promotion', notification));
      }
    }
    
    await Promise.allSettled(promises);
  }
  
  /**
   * Handle split-brain situation
   */
  handleSplitBrain(otherId, otherHeartbeat) {
    logger.error('Split-brain detected!', {
      ourNode: this.config.nodeId,
      otherNode: otherId
    });
    
    // Resolution strategy: Higher priority wins
    const ourPriority = this.config.priority || 0;
    const otherPriority = otherHeartbeat.metadata?.priority || 0;
    
    if (otherPriority > ourPriority) {
      // Step down
      logger.info('Stepping down due to split-brain resolution');
      this.stepDown();
    } else if (otherPriority === ourPriority) {
      // Tie-breaker: Lower node ID wins
      if (otherId < this.config.nodeId) {
        logger.info('Stepping down due to split-brain tie-breaker');
        this.stepDown();
      }
    }
    
    // Otherwise, we remain primary
  }
  
  /**
   * Step down from primary role
   */
  stepDown() {
    this.config.role = NodeRole.SECONDARY;
    this.state = NodeState.STANDBY;
    
    this.emit('stepped-down');
    
    // Perform step-down tasks
    this.onStepDown();
  }
  
  /**
   * Get system load information
   */
  getSystemLoad() {
    const cpus = os.cpus();
    const totalCpu = cpus.reduce((acc, cpu) => {
      const times = cpu.times;
      return acc + times.user + times.nice + times.sys + times.idle;
    }, 0);
    
    const idleCpu = cpus.reduce((acc, cpu) => acc + cpu.times.idle, 0);
    const cpuUsage = 1 - (idleCpu / totalCpu);
    
    return {
      cpu: cpuUsage,
      memory: 1 - (os.freemem() / os.totalmem()),
      loadAvg: os.loadavg()[0]
    };
  }
  
  /**
   * Get node metadata
   */
  async getNodeMetadata() {
    return {
      priority: this.config.priority || 0,
      version: process.env.npm_package_version || '1.0.0',
      uptime: process.uptime(),
      connections: await this.getConnectionCount()
    };
  }
  
  /**
   * Get current connection count
   */
  async getConnectionCount() {
    // Override in implementation
    return 0;
  }
  
  /**
   * Override: Called when promoted to primary
   */
  async onPromoteToPrimary() {
    // Override in implementation
  }
  
  /**
   * Override: Called when stepping down
   */
  async onStepDown() {
    // Override in implementation
  }
  
  /**
   * Get HA status
   */
  getStatus() {
    const peers = Array.from(this.peers.values()).map(peer => ({
      id: peer.id,
      state: peer.state,
      lastSeen: peer.lastSeen,
      latency: peer.latency,
      load: peer.load
    }));
    
    return {
      nodeId: this.config.nodeId,
      role: this.config.role,
      state: this.state,
      peers,
      stats: this.stats,
      failoverInProgress: this.failoverInProgress
    };
  }
  
  /**
   * Shutdown HA manager
   */
  async shutdown() {
    logger.info('Shutting down HA manager');
    
    // Stop timers
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
    }
    
    // Notify peers
    const notification = {
      nodeId: this.config.nodeId,
      state: NodeState.FAILED,
      timestamp: Date.now()
    };
    
    const promises = [];
    
    for (const [peerId, peer] of this.peers) {
      promises.push(this.sendToPeer(peer, 'shutdown', notification));
    }
    
    await Promise.allSettled(promises);
    
    this.emit('shutdown');
  }
}

export default HAManager;
