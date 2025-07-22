// Practical Byzantine Fault Tolerance (PBFT) Consensus Implementation
// For distributed share validation in P2P mining pools

import EventEmitter from 'events';
import crypto from 'crypto';
import { createLogger } from '../core/logger.js';

const logger = createLogger('pbft-consensus');

export class PBFTConsensus extends EventEmitter {
  constructor(nodeId, options = {}) {
    super();
    
    this.nodeId = nodeId;
    this.config = {
      byzantineNodes: options.byzantineNodes || 0.33, // f = (n-1)/3
      requestTimeout: options.requestTimeout || 5000,
      viewChangeTimeout: options.viewChangeTimeout || 10000,
      checkpointInterval: options.checkpointInterval || 100,
      maxLogSize: options.maxLogSize || 1000,
      ...options
    };
    
    // PBFT state
    this.view = 0;
    this.sequenceNumber = 0;
    this.isPrimary = false;
    this.nodes = new Map();
    this.state = 'normal'; // normal, view-change, recovering
    
    // Message logs
    this.messageLog = new Map();
    this.prepareLog = new Map();
    this.commitLog = new Map();
    this.checkpoints = new Map();
    this.stableCheckpoint = 0;
    
    // Pending requests
    this.pendingRequests = new Map();
    this.executedRequests = new Set();
    
    // View change state
    this.viewChangeLog = new Map();
    this.newViewLog = new Map();
    
    // Timers
    this.timers = new Map();
  }

  async initialize(nodes) {
    logger.info(`Initializing PBFT consensus for node ${this.nodeId}`);
    
    // Register nodes
    for (const node of nodes) {
      this.nodes.set(node.id, {
        id: node.id,
        publicKey: node.publicKey,
        endpoint: node.endpoint,
        reputation: node.reputation || 1.0,
        isActive: true
      });
    }
    
    // Determine if this node is primary
    this.updatePrimary();
    
    // Start view change timer
    this.startViewChangeTimer();
    
    return this;
  }

  updatePrimary() {
    const nodeIds = Array.from(this.nodes.keys()).sort();
    const primaryIndex = this.view % nodeIds.length;
    const primaryId = nodeIds[primaryIndex];
    
    this.isPrimary = primaryId === this.nodeId;
    this.primaryId = primaryId;
    
    logger.info(`View ${this.view}: Primary is ${primaryId} (isPrimary: ${this.isPrimary})`);
  }

  // Client request handling
  async handleShareValidation(share) {
    const request = {
      type: 'share-validation',
      share: share,
      timestamp: Date.now(),
      client: share.minerId,
      id: this.generateRequestId(share)
    };
    
    if (this.isPrimary) {
      return this.handleClientRequest(request);
    } else {
      // Forward to primary
      return this.forwardToPrimary(request);
    }
  }

  async handleClientRequest(request) {
    if (!this.isPrimary) {
      throw new Error('Only primary can handle client requests');
    }
    
    // Check if already executed
    if (this.executedRequests.has(request.id)) {
      return this.getExecutionResult(request.id);
    }
    
    // Assign sequence number
    const sequenceNumber = ++this.sequenceNumber;
    
    // Create pre-prepare message
    const prePrepare = {
      view: this.view,
      sequenceNumber: sequenceNumber,
      digest: this.computeDigest(request),
      request: request,
      timestamp: Date.now()
    };
    
    // Sign pre-prepare
    prePrepare.signature = this.signMessage(prePrepare);
    
    // Log pre-prepare
    this.messageLog.set(sequenceNumber, prePrepare);
    this.pendingRequests.set(request.id, {
      request: request,
      sequenceNumber: sequenceNumber,
      phase: 'pre-prepare',
      startTime: Date.now()
    });
    
    // Broadcast pre-prepare to all replicas
    await this.broadcast('pre-prepare', prePrepare);
    
    // Handle pre-prepare locally
    await this.handlePrePrepare(prePrepare, this.nodeId);
    
    // Wait for consensus
    return this.waitForConsensus(request.id);
  }

  async handlePrePrepare(message, senderId) {
    // Validate message
    if (!this.validatePrePrepare(message, senderId)) {
      logger.warn(`Invalid pre-prepare from ${senderId}`);
      return;
    }
    
    const key = `${message.view}-${message.sequenceNumber}`;
    
    // Check if already processed
    if (this.prepareLog.has(key)) {
      return;
    }
    
    // Log pre-prepare
    this.messageLog.set(message.sequenceNumber, message);
    
    // Create prepare message
    const prepare = {
      view: message.view,
      sequenceNumber: message.sequenceNumber,
      digest: message.digest,
      nodeId: this.nodeId,
      timestamp: Date.now()
    };
    
    // Sign prepare
    prepare.signature = this.signMessage(prepare);
    
    // Log prepare
    if (!this.prepareLog.has(key)) {
      this.prepareLog.set(key, new Map());
    }
    this.prepareLog.get(key).set(this.nodeId, prepare);
    
    // Broadcast prepare
    await this.broadcast('prepare', prepare);
    
    // Check if prepared
    this.checkPrepared(message.view, message.sequenceNumber);
  }

  async handlePrepare(message, senderId) {
    // Validate message
    if (!this.validatePrepare(message, senderId)) {
      logger.warn(`Invalid prepare from ${senderId}`);
      return;
    }
    
    const key = `${message.view}-${message.sequenceNumber}`;
    
    // Log prepare
    if (!this.prepareLog.has(key)) {
      this.prepareLog.set(key, new Map());
    }
    this.prepareLog.get(key).set(senderId, message);
    
    // Check if prepared
    this.checkPrepared(message.view, message.sequenceNumber);
  }

  checkPrepared(view, sequenceNumber) {
    const key = `${view}-${sequenceNumber}`;
    const prepares = this.prepareLog.get(key);
    
    if (!prepares) return;
    
    // Need 2f prepares (including own)
    const f = this.getMaxByzantineNodes();
    if (prepares.size < 2 * f) return;
    
    // Check if already committed
    if (this.commitLog.has(key)) return;
    
    // Create commit message
    const commit = {
      view: view,
      sequenceNumber: sequenceNumber,
      digest: this.messageLog.get(sequenceNumber).digest,
      nodeId: this.nodeId,
      timestamp: Date.now()
    };
    
    // Sign commit
    commit.signature = this.signMessage(commit);
    
    // Log commit
    if (!this.commitLog.has(key)) {
      this.commitLog.set(key, new Map());
    }
    this.commitLog.get(key).set(this.nodeId, commit);
    
    // Broadcast commit
    this.broadcast('commit', commit);
    
    // Check if committed
    this.checkCommitted(view, sequenceNumber);
  }

  async handleCommit(message, senderId) {
    // Validate message
    if (!this.validateCommit(message, senderId)) {
      logger.warn(`Invalid commit from ${senderId}`);
      return;
    }
    
    const key = `${message.view}-${message.sequenceNumber}`;
    
    // Log commit
    if (!this.commitLog.has(key)) {
      this.commitLog.set(key, new Map());
    }
    this.commitLog.get(key).set(senderId, message);
    
    // Check if committed
    this.checkCommitted(message.view, message.sequenceNumber);
  }

  checkCommitted(view, sequenceNumber) {
    const key = `${view}-${sequenceNumber}`;
    const commits = this.commitLog.get(key);
    
    if (!commits) return;
    
    // Need 2f+1 commits
    const f = this.getMaxByzantineNodes();
    if (commits.size < 2 * f + 1) return;
    
    // Execute request
    const prePrepare = this.messageLog.get(sequenceNumber);
    if (prePrepare && prePrepare.request) {
      this.executeRequest(prePrepare.request);
    }
    
    // Check for checkpoint
    if (sequenceNumber % this.config.checkpointInterval === 0) {
      this.createCheckpoint(sequenceNumber);
    }
  }

  executeRequest(request) {
    if (this.executedRequests.has(request.id)) {
      return;
    }
    
    logger.info(`Executing request ${request.id} (type: ${request.type})`);
    
    let result;
    switch (request.type) {
      case 'share-validation':
        result = this.executeShareValidation(request.share);
        break;
      default:
        result = { error: 'Unknown request type' };
    }
    
    // Mark as executed
    this.executedRequests.add(request.id);
    
    // Store result
    if (this.pendingRequests.has(request.id)) {
      const pending = this.pendingRequests.get(request.id);
      pending.result = result;
      pending.phase = 'executed';
      pending.executionTime = Date.now();
    }
    
    // Emit execution event
    this.emit('executed', {
      requestId: request.id,
      type: request.type,
      result: result
    });
    
    return result;
  }

  executeShareValidation(share) {
    // Validate share
    const isValid = this.validateShare(share);
    
    // Calculate reward if valid
    let reward = 0;
    if (isValid) {
      reward = this.calculateShareReward(share);
    }
    
    return {
      valid: isValid,
      shareId: share.id,
      minerId: share.minerId,
      reward: reward,
      timestamp: Date.now()
    };
  }

  validateShare(share) {
    // Comprehensive share validation
    try {
      // Check share structure
      if (!share.nonce || !share.hash || !share.difficulty) {
        return false;
      }
      
      // Verify hash meets difficulty
      const hashBuffer = Buffer.from(share.hash, 'hex');
      const targetBuffer = Buffer.from(share.difficulty, 'hex');
      
      for (let i = 0; i < 32; i++) {
        if (hashBuffer[i] < targetBuffer[i]) return true;
        if (hashBuffer[i] > targetBuffer[i]) return false;
      }
      
      return true;
    } catch (error) {
      logger.error('Share validation error:', error);
      return false;
    }
  }

  calculateShareReward(share) {
    // Calculate reward based on share difficulty
    const baseDifficulty = BigInt('0x00000000ffff0000000000000000000000000000000000000000000000000000');
    const shareDifficulty = BigInt('0x' + share.difficulty);
    
    // Reward proportional to difficulty
    const reward = Number(baseDifficulty / shareDifficulty) / 1000000;
    
    return Math.max(reward, 0.00000001); // Minimum reward
  }

  // View change protocol
  async initiateViewChange() {
    if (this.state === 'view-change') return;
    
    logger.info(`Initiating view change from view ${this.view}`);
    
    this.state = 'view-change';
    this.view++;
    
    // Create view-change message
    const viewChange = {
      view: this.view,
      nodeId: this.nodeId,
      stableCheckpoint: this.stableCheckpoint,
      preparedMessages: this.getPreparedMessages(),
      timestamp: Date.now()
    };
    
    // Sign view-change
    viewChange.signature = this.signMessage(viewChange);
    
    // Log view-change
    if (!this.viewChangeLog.has(this.view)) {
      this.viewChangeLog.set(this.view, new Map());
    }
    this.viewChangeLog.get(this.view).set(this.nodeId, viewChange);
    
    // Broadcast view-change
    await this.broadcast('view-change', viewChange);
    
    // Check if new primary
    this.updatePrimary();
    if (this.isPrimary) {
      this.checkViewChange(this.view);
    }
  }

  async handleViewChange(message, senderId) {
    // Validate message
    if (!this.validateViewChange(message, senderId)) {
      logger.warn(`Invalid view-change from ${senderId}`);
      return;
    }
    
    // Log view-change
    if (!this.viewChangeLog.has(message.view)) {
      this.viewChangeLog.set(message.view, new Map());
    }
    this.viewChangeLog.get(message.view).set(senderId, message);
    
    // Check if new primary and have enough view-changes
    this.updatePrimary();
    if (this.isPrimary) {
      this.checkViewChange(message.view);
    }
  }

  checkViewChange(view) {
    const viewChanges = this.viewChangeLog.get(view);
    if (!viewChanges) return;
    
    // Need 2f+1 view-changes
    const f = this.getMaxByzantineNodes();
    if (viewChanges.size < 2 * f + 1) return;
    
    // Create new-view message
    const newView = {
      view: view,
      viewChanges: Array.from(viewChanges.values()),
      preprepares: this.computeNewViewPreprepares(viewChanges),
      timestamp: Date.now()
    };
    
    // Sign new-view
    newView.signature = this.signMessage(newView);
    
    // Broadcast new-view
    this.broadcast('new-view', newView);
    
    // Process new-view locally
    this.handleNewView(newView, this.nodeId);
  }

  // Utility methods
  getMaxByzantineNodes() {
    const n = this.nodes.size;
    return Math.floor((n - 1) / 3);
  }

  generateRequestId(request) {
    const data = JSON.stringify({
      type: request.type,
      client: request.client || request.minerId,
      timestamp: request.timestamp
    });
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  computeDigest(message) {
    const data = JSON.stringify({
      type: message.type,
      data: message.share || message.data,
      timestamp: message.timestamp
    });
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  signMessage(message) {
    // In production, use proper cryptographic signatures
    const data = JSON.stringify(message);
    return crypto.createHmac('sha256', this.nodeId).update(data).digest('hex');
  }

  validatePrePrepare(message, senderId) {
    // Validate signature
    // Validate view number
    // Validate sequence number
    // Validate digest
    return true; // Simplified for now
  }

  validatePrepare(message, senderId) {
    // Validate signature
    // Validate matching pre-prepare exists
    return true; // Simplified for now
  }

  validateCommit(message, senderId) {
    // Validate signature
    // Validate matching prepared state
    return true; // Simplified for now
  }

  validateViewChange(message, senderId) {
    // Validate signature
    // Validate view number
    return true; // Simplified for now
  }

  async broadcast(type, message) {
    const promises = [];
    
    for (const [nodeId, node] of this.nodes) {
      if (nodeId === this.nodeId || !node.isActive) continue;
      
      promises.push(this.sendToNode(nodeId, type, message));
    }
    
    await Promise.allSettled(promises);
  }

  async sendToNode(nodeId, type, message) {
    // In production, implement actual network communication
    this.emit('message-sent', {
      to: nodeId,
      type: type,
      message: message
    });
  }

  async waitForConsensus(requestId, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      
      const checkInterval = setInterval(() => {
        const pending = this.pendingRequests.get(requestId);
        
        if (pending && pending.phase === 'executed') {
          clearInterval(checkInterval);
          resolve(pending.result);
        } else if (Date.now() - startTime > timeout) {
          clearInterval(checkInterval);
          reject(new Error('Consensus timeout'));
        }
      }, 100);
    });
  }

  startViewChangeTimer() {
    this.viewChangeTimer = setTimeout(() => {
      if (this.state === 'normal') {
        this.initiateViewChange();
      }
      this.startViewChangeTimer();
    }, this.config.viewChangeTimeout);
  }

  getPreparedMessages() {
    // Get all prepared messages for view change
    const prepared = [];
    
    for (const [key, prepares] of this.prepareLog) {
      if (prepares.size >= 2 * this.getMaxByzantineNodes()) {
        const [view, seq] = key.split('-').map(Number);
        prepared.push({
          view: view,
          sequenceNumber: seq,
          prepares: Array.from(prepares.values())
        });
      }
    }
    
    return prepared;
  }

  computeNewViewPreprepares(viewChanges) {
    // Compute pre-prepares for new view
    // This is simplified - in production, need to handle gaps and conflicts
    return [];
  }

  createCheckpoint(sequenceNumber) {
    const checkpoint = {
      sequenceNumber: sequenceNumber,
      stateDigest: this.computeStateDigest(),
      timestamp: Date.now()
    };
    
    checkpoint.signature = this.signMessage(checkpoint);
    
    this.checkpoints.set(sequenceNumber, checkpoint);
    
    // Garbage collect old messages
    this.garbageCollect(sequenceNumber);
  }

  computeStateDigest() {
    // Compute digest of current state
    const state = {
      executedRequests: Array.from(this.executedRequests),
      sequenceNumber: this.sequenceNumber
    };
    
    return crypto.createHash('sha256')
      .update(JSON.stringify(state))
      .digest('hex');
  }

  garbageCollect(stableCheckpoint) {
    // Remove old messages before stable checkpoint
    for (const [seq] of this.messageLog) {
      if (seq < stableCheckpoint) {
        this.messageLog.delete(seq);
      }
    }
    
    // Clean prepare and commit logs
    for (const [key] of this.prepareLog) {
      const [, seq] = key.split('-').map(Number);
      if (seq < stableCheckpoint) {
        this.prepareLog.delete(key);
        this.commitLog.delete(key);
      }
    }
  }

  getStatistics() {
    return {
      nodeId: this.nodeId,
      view: this.view,
      isPrimary: this.isPrimary,
      primaryId: this.primaryId,
      sequenceNumber: this.sequenceNumber,
      state: this.state,
      pendingRequests: this.pendingRequests.size,
      executedRequests: this.executedRequests.size,
      nodes: this.nodes.size,
      maxByzantineNodes: this.getMaxByzantineNodes()
    };
  }
}

export default PBFTConsensus;