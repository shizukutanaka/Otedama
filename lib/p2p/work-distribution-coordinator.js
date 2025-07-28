/**
 * Work Distribution Coordinator for Otedama P2P Pool
 * Coordinates work between share chain, node discovery, and stratum proxy
 * 
 * Design principles:
 * - Carmack: Maximum efficiency in work distribution
 * - Martin: Clean separation of concerns
 * - Pike: Simple coordination logic
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('WorkDistributionCoordinator');

/**
 * Block template cache
 */
class BlockTemplateCache {
  constructor(maxAge = 30000) {
    this.templates = new Map();
    this.maxAge = maxAge;
  }

  set(height, template) {
    this.templates.set(height, {
      template,
      timestamp: Date.now()
    });
    
    // Clean old templates
    this.cleanup();
  }

  get(height) {
    const entry = this.templates.get(height);
    if (!entry) return null;
    
    if (Date.now() - entry.timestamp > this.maxAge) {
      this.templates.delete(height);
      return null;
    }
    
    return entry.template;
  }

  getLatest() {
    let latest = null;
    let latestTime = 0;
    
    for (const [height, entry] of this.templates) {
      if (entry.timestamp > latestTime) {
        latest = entry.template;
        latestTime = entry.timestamp;
      }
    }
    
    return latest;
  }

  cleanup() {
    const now = Date.now();
    for (const [height, entry] of this.templates) {
      if (now - entry.timestamp > this.maxAge) {
        this.templates.delete(height);
      }
    }
  }
}

/**
 * Work Distribution Coordinator
 */
export class WorkDistributionCoordinator extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Template refresh settings
      templateRefreshInterval: config.templateRefreshInterval || 30000,
      templateMaxAge: config.templateMaxAge || 60000,
      
      // Work distribution settings
      workQueueSize: config.workQueueSize || 1000,
      jobIdLength: config.jobIdLength || 8,
      extraNonceSize: config.extraNonceSize || 4,
      
      // Network settings
      minPeersForConsensus: config.minPeersForConsensus || 3,
      consensusTimeout: config.consensusTimeout || 5000,
      
      // Share verification
      shareVerificationQuorum: config.shareVerificationQuorum || 0.51,
      maxShareAge: config.maxShareAge || 120000,
      
      ...config
    };
    
    // Core components (injected)
    this.shareChain = null;
    this.nodeDiscovery = null;
    this.stratumProxy = null;
    this.blockchainRPC = null;
    
    // State management
    this.currentTemplate = null;
    this.templateCache = new BlockTemplateCache(this.config.templateMaxAge);
    this.activeJobs = new Map();
    this.pendingShares = new Map();
    
    // Work distribution
    this.workQueue = [];
    this.jobCounter = 0;
    
    // Statistics
    this.stats = {
      templatesReceived: 0,
      jobsCreated: 0,
      sharesSubmitted: 0,
      blocksFound: 0,
      orphanedBlocks: 0,
      consensusRounds: 0
    };
    
    // Timers
    this.templateTimer = null;
    this.consensusTimer = null;
  }

  /**
   * Initialize coordinator with dependencies
   */
  async initialize(dependencies) {
    if (!dependencies.shareChain || !dependencies.nodeDiscovery || !dependencies.stratumProxy) {
      throw new Error('Missing required dependencies');
    }
    
    this.shareChain = dependencies.shareChain;
    this.nodeDiscovery = dependencies.nodeDiscovery;
    this.stratumProxy = dependencies.stratumProxy;
    this.blockchainRPC = dependencies.blockchainRPC;
    
    // Setup event handlers
    this.setupEventHandlers();
    
    // Start template refresh
    this.startTemplateRefresh();
    
    logger.info('Work distribution coordinator initialized');
    this.emit('initialized');
  }

  /**
   * Setup event handlers
   */
  setupEventHandlers() {
    // Handle stratum proxy events
    this.stratumProxy.on('job:needed', () => {
      this.handleJobRequest();
    });
    
    this.stratumProxy.on('share:accepted', (share) => {
      this.handleShareSubmission(share);
    });
    
    this.stratumProxy.on('block:found', (block) => {
      this.handleBlockFound(block);
    });
    
    // Handle share chain events
    this.shareChain.on('block', (block) => {
      this.handleShareChainBlock(block);
    });
    
    this.shareChain.on('reorganization', (reorg) => {
      this.handleReorganization(reorg);
    });
    
    // Handle P2P network events
    this.nodeDiscovery.on('peer:message', (message, peer) => {
      this.handlePeerMessage(message, peer);
    });
  }

  /**
   * Start template refresh timer
   */
  startTemplateRefresh() {
    this.templateTimer = setInterval(async () => {
      try {
        await this.refreshBlockTemplate();
      } catch (error) {
        logger.error('Template refresh failed', { error: error.message });
      }
    }, this.config.templateRefreshInterval);
    
    // Initial refresh
    this.refreshBlockTemplate().catch(err => {
      logger.error('Initial template refresh failed', { error: err.message });
    });
  }

  /**
   * Refresh block template from blockchain
   */
  async refreshBlockTemplate() {
    if (!this.blockchainRPC) {
      logger.warn('No blockchain RPC configured');
      return;
    }
    
    try {
      // Get new block template
      const template = await this.blockchainRPC.getBlockTemplate();
      
      if (!template) {
        throw new Error('Empty block template received');
      }
      
      // Validate template
      if (!this.validateBlockTemplate(template)) {
        throw new Error('Invalid block template');
      }
      
      // Check if template changed
      if (this.currentTemplate && 
          this.currentTemplate.previousblockhash === template.previousblockhash &&
          this.currentTemplate.height === template.height) {
        return; // No change
      }
      
      // Store new template
      this.currentTemplate = template;
      this.templateCache.set(template.height, template);
      this.stats.templatesReceived++;
      
      // Create new job
      const job = await this.createMiningJob(template);
      
      // Update stratum proxy
      await this.stratumProxy.updateBlockTemplate(template);
      
      // Broadcast to P2P network
      this.broadcastTemplate(template);
      
      logger.info('Block template refreshed', {
        height: template.height,
        previousHash: template.previousblockhash.substring(0, 16) + '...'
      });
      
      this.emit('template:updated', template);
      
    } catch (error) {
      logger.error('Failed to refresh block template', { error: error.message });
      this.emit('template:error', error);
      
      // Try to get template from peers
      await this.requestTemplateFromPeers();
    }
  }

  /**
   * Validate block template
   */
  validateBlockTemplate(template) {
    return template.height && 
           template.previousblockhash && 
           template.bits && 
           template.coinbasevalue && 
           template.transactions;
  }

  /**
   * Create mining job from template
   */
  async createMiningJob(template) {
    const jobId = this.generateJobId();
    
    // Get payout addresses from share chain
    const payouts = await this.calculatePayouts(template);
    
    const job = {
      id: jobId,
      height: template.height,
      previousHash: template.previousblockhash,
      coinbaseValue: template.coinbasevalue,
      transactions: template.transactions,
      bits: template.bits,
      target: template.target,
      payouts,
      createdAt: Date.now()
    };
    
    this.activeJobs.set(jobId, job);
    this.stats.jobsCreated++;
    
    // Clean old jobs
    this.cleanupJobs();
    
    return job;
  }

  /**
   * Calculate payouts based on share chain
   */
  async calculatePayouts(template) {
    const blockReward = BigInt(template.coinbasevalue);
    const poolFee = this.config.poolFee || 0.01;
    const poolReward = blockReward * BigInt(Math.floor(poolFee * 1000)) / 1000n;
    const minerReward = blockReward - poolReward;
    
    // Get expected payouts from share chain
    const sharePayouts = this.shareChain.lastBlock?.coinbasePayouts || new Map();
    
    const payouts = [];
    let totalAllocated = 0n;
    
    // Add miner payouts based on shares
    for (const [minerId, amount] of sharePayouts) {
      const scaledAmount = (amount * minerReward) / blockReward;
      if (scaledAmount > 0n) {
        payouts.push({
          address: minerId, // In real implementation, map to actual addresses
          amount: scaledAmount
        });
        totalAllocated += scaledAmount;
      }
    }
    
    // Add pool fee
    if (poolReward > 0n && this.config.poolAddress) {
      payouts.push({
        address: this.config.poolAddress,
        amount: poolReward
      });
    }
    
    // Handle rounding (give remainder to pool or largest miner)
    const remainder = blockReward - totalAllocated - poolReward;
    if (remainder > 0n && payouts.length > 0) {
      payouts[0].amount += remainder;
    }
    
    return payouts;
  }

  /**
   * Handle job request from stratum
   */
  async handleJobRequest() {
    if (!this.currentTemplate) {
      await this.refreshBlockTemplate();
    }
    
    if (this.currentTemplate) {
      const job = await this.createMiningJob(this.currentTemplate);
      this.emit('job:created', job);
    }
  }

  /**
   * Handle share submission
   */
  async handleShareSubmission(share) {
    this.stats.sharesSubmitted++;
    
    // Add to pending shares for verification
    const shareId = crypto.randomBytes(16).toString('hex');
    this.pendingShares.set(shareId, {
      share,
      timestamp: Date.now(),
      verifications: new Map()
    });
    
    // Request verification from peers
    const verificationRequest = {
      type: 'verify_share',
      shareId,
      share: {
        jobId: share.jobId,
        nonce: share.nonce,
        extraNonce1: share.extraNonce1,
        extraNonce2: share.extraNonce2,
        nTime: share.nTime,
        difficulty: share.difficulty,
        hash: share.hash
      }
    };
    
    // Broadcast to connected peers
    const peers = this.nodeDiscovery.getConnectedPeers();
    const selectedPeers = this.selectVerificationPeers(peers);
    
    for (const peer of selectedPeers) {
      this.nodeDiscovery.sendToPeer(peer.id, verificationRequest);
    }
    
    // Set timeout for consensus
    setTimeout(() => {
      this.checkShareConsensus(shareId);
    }, this.config.consensusTimeout);
  }

  /**
   * Select peers for share verification
   */
  selectVerificationPeers(peers) {
    // Select reliable peers with good reputation
    const reliablePeers = peers
      .filter(p => p.isReliable())
      .sort((a, b) => b.reputation - a.reputation);
    
    // Select top N peers
    const count = Math.min(
      Math.max(this.config.minPeersForConsensus, Math.floor(peers.length * 0.3)),
      reliablePeers.length
    );
    
    return reliablePeers.slice(0, count);
  }

  /**
   * Check share consensus
   */
  async checkShareConsensus(shareId) {
    const pending = this.pendingShares.get(shareId);
    if (!pending) return;
    
    const verifications = pending.verifications;
    const totalPeers = verifications.size;
    
    if (totalPeers < this.config.minPeersForConsensus) {
      // Not enough verifications, accept locally
      logger.warn('Insufficient peer verifications for share', { shareId, peers: totalPeers });
      this.acceptShare(pending.share);
      this.pendingShares.delete(shareId);
      return;
    }
    
    // Count valid/invalid votes
    let validVotes = 0;
    let invalidVotes = 0;
    
    for (const [peerId, result] of verifications) {
      if (result.valid) validVotes++;
      else invalidVotes++;
    }
    
    const validRatio = validVotes / totalPeers;
    
    if (validRatio >= this.config.shareVerificationQuorum) {
      // Consensus reached - share is valid
      this.acceptShare(pending.share);
      this.stats.consensusRounds++;
    } else {
      // Share rejected by consensus
      logger.warn('Share rejected by peer consensus', {
        shareId,
        validVotes,
        invalidVotes,
        ratio: validRatio
      });
    }
    
    this.pendingShares.delete(shareId);
  }

  /**
   * Accept verified share
   */
  acceptShare(share) {
    // Add to share chain
    this.shareChain.addShare({
      minerId: share.minerId,
      difficulty: share.difficulty,
      jobId: share.jobId,
      timestamp: Date.now()
    });
    
    this.emit('share:verified', share);
  }

  /**
   * Handle block found
   */
  async handleBlockFound(block) {
    logger.info('Block found!', {
      height: block.template.height,
      hash: block.hash,
      miner: block.share.minerId
    });
    
    try {
      // Submit block to blockchain
      if (this.blockchainRPC) {
        const result = await this.blockchainRPC.submitBlock(block.hex);
        
        if (result.accepted) {
          this.stats.blocksFound++;
          
          // Create share chain block
          const shareBlock = await this.shareChain.createBlock(
            block.share.minerId,
            block.hash
          );
          
          // Mine share chain block
          const minedBlock = await this.shareChain.mineBlock(
            shareBlock,
            this.shareChain.currentDifficulty
          );
          
          // Add to share chain
          await this.shareChain.addBlock(minedBlock);
          
          // Broadcast block found
          this.broadcastBlockFound(block, minedBlock);
          
          this.emit('block:accepted', { block, shareBlock: minedBlock });
        } else {
          this.stats.orphanedBlocks++;
          logger.warn('Block rejected by network', { reason: result.reason });
          this.emit('block:rejected', { block, reason: result.reason });
        }
      }
      
    } catch (error) {
      logger.error('Failed to submit block', { error: error.message });
      this.emit('block:error', { block, error });
    }
  }

  /**
   * Handle peer message
   */
  handlePeerMessage(message, peer) {
    switch (message.type) {
      case 'template_request':
        this.handleTemplateRequest(peer);
        break;
        
      case 'template_response':
        this.handleTemplateResponse(message, peer);
        break;
        
      case 'verify_share':
        this.handleVerifyShareRequest(message, peer);
        break;
        
      case 'share_verification':
        this.handleShareVerification(message, peer);
        break;
        
      case 'block_found':
        this.handlePeerBlockFound(message, peer);
        break;
        
      default:
        // Unknown message type
        break;
    }
  }

  /**
   * Handle template request from peer
   */
  handleTemplateRequest(peer) {
    if (this.currentTemplate) {
      const response = {
        type: 'template_response',
        template: {
          height: this.currentTemplate.height,
          previousblockhash: this.currentTemplate.previousblockhash,
          bits: this.currentTemplate.bits,
          target: this.currentTemplate.target,
          timestamp: Date.now()
        }
      };
      
      this.nodeDiscovery.sendToPeer(peer.id, response);
    }
  }

  /**
   * Handle template response from peer
   */
  handleTemplateResponse(message, peer) {
    const template = message.template;
    
    // Validate template
    if (!this.validateBlockTemplate(template)) {
      peer.updateReputation(-1);
      return;
    }
    
    // Check if newer than current
    if (!this.currentTemplate || template.height > this.currentTemplate.height) {
      // Verify with multiple peers before accepting
      // For now, accept if from reliable peer
      if (peer.isReliable()) {
        this.currentTemplate = template;
        this.templateCache.set(template.height, template);
        peer.updateReputation(1);
        
        logger.info('Accepted template from peer', {
          height: template.height,
          peer: peer.id
        });
      }
    }
  }

  /**
   * Handle share verification request
   */
  async handleVerifyShareRequest(message, peer) {
    const { shareId, share } = message;
    
    // Verify share locally
    const job = this.activeJobs.get(share.jobId);
    let valid = false;
    let reason = 'Unknown job';
    
    if (job) {
      // Perform share validation
      // This is simplified - real implementation would fully validate
      valid = share.difficulty && share.nonce && share.hash;
      if (!valid) reason = 'Invalid share parameters';
    }
    
    // Send verification response
    const response = {
      type: 'share_verification',
      shareId,
      valid,
      reason,
      verifier: this.nodeDiscovery.config.nodeId
    };
    
    this.nodeDiscovery.sendToPeer(peer.id, response);
  }

  /**
   * Handle share verification response
   */
  handleShareVerification(message, peer) {
    const { shareId, valid, reason, verifier } = message;
    
    const pending = this.pendingShares.get(shareId);
    if (!pending) return;
    
    // Record verification
    pending.verifications.set(peer.id, {
      valid,
      reason,
      verifier,
      timestamp: Date.now()
    });
    
    // Update peer reputation based on consensus later
    if (valid) {
      peer.updateReputation(0.1);
    }
  }

  /**
   * Request template from peers
   */
  async requestTemplateFromPeers() {
    const request = {
      type: 'template_request',
      timestamp: Date.now()
    };
    
    const peers = this.nodeDiscovery.getConnectedPeers();
    const sent = this.nodeDiscovery.broadcast(request);
    
    if (sent > 0) {
      logger.info('Requested template from peers', { count: sent });
    }
  }

  /**
   * Broadcast template to peers
   */
  broadcastTemplate(template) {
    const message = {
      type: 'template_update',
      template: {
        height: template.height,
        previousblockhash: template.previousblockhash,
        bits: template.bits,
        timestamp: Date.now()
      }
    };
    
    this.nodeDiscovery.broadcast(message);
  }

  /**
   * Broadcast block found
   */
  broadcastBlockFound(block, shareBlock) {
    const message = {
      type: 'block_found',
      block: {
        height: block.template.height,
        hash: block.hash,
        shareBlockHash: shareBlock.hash,
        timestamp: Date.now()
      }
    };
    
    this.nodeDiscovery.broadcast(message);
  }

  /**
   * Handle block found by peer
   */
  handlePeerBlockFound(message, peer) {
    logger.info('Peer found block', {
      peer: peer.id,
      height: message.block.height,
      hash: message.block.hash
    });
    
    // Update share chain if needed
    // Reputation will be updated based on blockchain confirmation
    
    this.emit('peer:block', { peer, block: message.block });
  }

  /**
   * Handle share chain reorganization
   */
  handleReorganization(reorg) {
    logger.warn('Share chain reorganization', reorg);
    
    // May need to recalculate payouts for active jobs
    this.emit('reorganization', reorg);
  }

  /**
   * Handle new share chain block
   */
  handleShareChainBlock(block) {
    // Update current payout expectations
    this.emit('sharechain:block', block);
  }

  /**
   * Generate unique job ID
   */
  generateJobId() {
    return (++this.jobCounter).toString(16).padStart(this.config.jobIdLength, '0');
  }

  /**
   * Cleanup old jobs
   */
  cleanupJobs() {
    const maxAge = 300000; // 5 minutes
    const now = Date.now();
    
    for (const [jobId, job] of this.activeJobs) {
      if (now - job.createdAt > maxAge) {
        this.activeJobs.delete(jobId);
      }
    }
  }

  /**
   * Cleanup old pending shares
   */
  cleanupPendingShares() {
    const now = Date.now();
    
    for (const [shareId, pending] of this.pendingShares) {
      if (now - pending.timestamp > this.config.maxShareAge) {
        this.pendingShares.delete(shareId);
      }
    }
  }

  /**
   * Get coordinator statistics
   */
  getStats() {
    const connectedPeers = this.nodeDiscovery.getConnectedPeers();
    
    return {
      ...this.stats,
      currentHeight: this.currentTemplate?.height || 0,
      activeJobs: this.activeJobs.size,
      pendingShares: this.pendingShares.size,
      connectedPeers: connectedPeers.length,
      reliablePeers: connectedPeers.filter(p => p.isReliable()).length
    };
  }

  /**
   * Shutdown coordinator
   */
  async shutdown() {
    if (this.templateTimer) {
      clearInterval(this.templateTimer);
      this.templateTimer = null;
    }
    
    if (this.consensusTimer) {
      clearInterval(this.consensusTimer);
      this.consensusTimer = null;
    }
    
    logger.info('Work distribution coordinator shut down');
  }
}

export default WorkDistributionCoordinator;