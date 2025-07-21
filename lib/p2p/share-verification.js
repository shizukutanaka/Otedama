/**
 * Distributed Share Verification System for P2P Mining Pool
 * Implements Byzantine Fault Tolerance for share validation
 */

import { EventEmitter } from 'events';
import { createHash, randomBytes } from 'crypto';
import { Logger } from '../logger.js';
import { getErrorHandler, OtedamaError, ErrorCategory, safeExecute } from '../error-handler.js';

export const VerificationStatus = {
  PENDING: 'pending',
  VERIFIED: 'verified',
  REJECTED: 'rejected',
  DISPUTED: 'disputed'
};

export class DistributedShareValidator extends EventEmitter {
  constructor(nodeId, options = {}) {
    super();
    this.nodeId = nodeId;
    this.logger = options.logger || new Logger('ShareValidator');
    this.options = {
      consensusThreshold: options.consensusThreshold || 0.51, // 51% agreement
      verificationTimeout: options.verificationTimeout || 5000, // 5 seconds
      minVerifiers: options.minVerifiers || 3,
      maxVerifiers: options.maxVerifiers || 10,
      reputationWeight: options.reputationWeight || 0.3,
      ...options
    };
    
    this.verificationNodes = new Map();
    this.pendingVerifications = new Map();
    this.verificationCache = new Map();
    this.nodeReputation = new Map();
    
    // Start cleanup timer
    this.startCleanupTimer();
  }
  
  /**
   * Register verification node
   */
  registerVerificationNode(nodeId, nodeInfo) {
    this.verificationNodes.set(nodeId, {
      id: nodeId,
      endpoint: nodeInfo.endpoint,
      publicKey: nodeInfo.publicKey,
      reputation: this.nodeReputation.get(nodeId) || 1.0,
      lastSeen: Date.now(),
      capabilities: nodeInfo.capabilities || []
    });
    
    this.logger.info(`Registered verification node: ${nodeId}`);
    this.emit('node:registered', { nodeId });
  }
  
  /**
   * Verify share with distributed consensus
   */
  async verifyShare(share, options = {}) {
    return await safeExecute(async () => {
      // Validate share structure
      if (!share || !share.jobId || !share.nonce || !share.hash) {
        throw new OtedamaError(
          'Invalid share structure',
          ErrorCategory.VALIDATION,
          { share }
        );
      }
      
      const shareId = this.generateShareId(share);
      
      // Check cache first
      if (this.verificationCache.has(shareId)) {
        const cached = this.verificationCache.get(shareId);
        if (Date.now() - cached.timestamp < 60000) { // 1 minute cache
          this.emit('verification:cached', { shareId });
          return cached.result;
        }
      }
      
      // Create verification request
      const verification = {
        id: shareId,
        share,
        startTime: Date.now(),
        responses: new Map(),
        status: VerificationStatus.PENDING,
        options
      };
      
      this.pendingVerifications.set(shareId, verification);
      
      try {
        // Select verification nodes with error handling
        const verifiers = await safeExecute(
          () => this.selectVerifiers(share, options),
          {
            service: 'verifier-selection',
            category: ErrorCategory.MINING,
            fallback: () => {
              // Fallback to any available verifiers
              return Array.from(this.verificationNodes.values())
                .filter(v => Date.now() - v.lastSeen < 30000)
                .slice(0, this.options.minVerifiers);
            }
          }
        );
        
        if (verifiers.length < this.options.minVerifiers) {
          throw new OtedamaError(
            `Insufficient verifiers: ${verifiers.length}/${this.options.minVerifiers}`,
            ErrorCategory.MINING,
            { 
              available: verifiers.length,
              required: this.options.minVerifiers,
              recoveryStrategy: 'retry_with_backoff'
            }
          );
        }
        
        // Broadcast verification request with timeout
        const verificationPromises = verifiers.map(verifier => 
          Promise.race([
            this.requestVerification(verifier, share, shareId),
            new Promise((_, reject) => 
              setTimeout(() => reject(new OtedamaError(
                'Verification timeout',
                ErrorCategory.NETWORK,
                { verifierId: verifier.id }
              )), this.options.verificationTimeout)
            )
          ])
        );
        
        // Wait for responses
        const responses = await Promise.allSettled(verificationPromises);
        
        // Process responses
        const result = await this.processVerificationResponses(shareId, responses, verifiers);
      
      // Cache result
      this.verificationCache.set(shareId, {
        result,
        timestamp: Date.now()
      });
      
      // Update reputation based on consensus
      this.updateNodeReputation(shareId, result);
      
      return result;
      
    } finally {
      this.pendingVerifications.delete(shareId);
    }
  }
  
  /**
   * Select verifier nodes
   */
  selectVerifiers(share, options) {
    const availableNodes = Array.from(this.verificationNodes.values())
      .filter(node => {
        // Don't verify own shares
        if (node.id === this.nodeId) return false;
        
        // Check if node is active
        if (Date.now() - node.lastSeen > 30000) return false;
        
        // Check capabilities
        if (share.algorithm && node.capabilities.length > 0) {
          return node.capabilities.includes(share.algorithm);
        }
        
        return true;
      })
      .sort((a, b) => {
        // Sort by reputation and latency
        const repDiff = b.reputation - a.reputation;
        if (Math.abs(repDiff) > 0.1) return repDiff;
        
        // If reputation is similar, prefer lower latency
        return (a.latency || 0) - (b.latency || 0);
      });
    
    // Select diverse set of verifiers
    const selected = [];
    const maxVerifiers = Math.min(
      options.verifierCount || this.options.maxVerifiers,
      availableNodes.length
    );
    
    // Always include highest reputation nodes
    const topNodes = Math.ceil(maxVerifiers * 0.4);
    selected.push(...availableNodes.slice(0, topNodes));
    
    // Add random nodes for diversity
    const remaining = availableNodes.slice(topNodes);
    while (selected.length < maxVerifiers && remaining.length > 0) {
      const idx = Math.floor(Math.random() * remaining.length);
      selected.push(remaining.splice(idx, 1)[0]);
    }
    
    return selected;
  }
  
  /**
   * Request verification from node
   */
  async requestVerification(verifier, share, shareId) {
    const request = {
      type: 'verify_share',
      shareId,
      share: {
        algorithm: share.algorithm,
        difficulty: share.difficulty,
        hash: share.hash,
        nonce: share.nonce,
        timestamp: share.timestamp,
        minerAddress: share.minerAddress
      },
      requesterId: this.nodeId,
      timestamp: Date.now()
    };
    
    // Sign request
    request.signature = this.signRequest(request);
    
    try {
      // Send verification request
      const response = await this.sendRequest(verifier, request);
      
      // Validate response
      if (!this.validateResponse(response, verifier)) {
        throw new Error('Invalid response signature');
      }
      
      return {
        nodeId: verifier.id,
        valid: response.valid,
        reason: response.reason,
        confidence: response.confidence || 1.0,
        timestamp: response.timestamp
      };
      
    } catch (error) {
      this.logger.error(`Verification request failed to ${verifier.id}:`, error);
      
      // Decrease reputation for non-responsive nodes
      this.adjustReputation(verifier.id, -0.01);
      
      throw error;
    }
  }
  
  /**
   * Process verification responses
   */
  processVerificationResponses(shareId, responses, verifiers) {
    const verification = this.pendingVerifications.get(shareId);
    if (!verification) return null;
    
    let validVotes = 0;
    let totalWeight = 0;
    const reasons = [];
    
    responses.forEach((response, index) => {
      const verifier = verifiers[index];
      
      if (response.status === 'fulfilled') {
        const result = response.value;
        verification.responses.set(result.nodeId, result);
        
        // Calculate weighted vote
        const weight = this.calculateVoteWeight(verifier, result);
        totalWeight += weight;
        
        if (result.valid) {
          validVotes += weight;
        } else if (result.reason) {
          reasons.push(result.reason);
        }
      }
    });
    
    // Calculate consensus
    const consensusRatio = totalWeight > 0 ? validVotes / totalWeight : 0;
    const hasConsensus = consensusRatio >= this.options.consensusThreshold;
    
    // Determine final status
    let status;
    if (hasConsensus && consensusRatio > 0.9) {
      status = VerificationStatus.VERIFIED;
    } else if (!hasConsensus && consensusRatio < 0.1) {
      status = VerificationStatus.REJECTED;
    } else {
      status = VerificationStatus.DISPUTED;
    }
    
    const result = {
      shareId,
      valid: hasConsensus,
      status,
      consensusRatio,
      totalResponses: verification.responses.size,
      verificationTime: Date.now() - verification.startTime,
      reasons: [...new Set(reasons)],
      timestamp: Date.now()
    };
    
    this.emit('verification:complete', result);
    
    return result;
  }
  
  /**
   * Calculate vote weight based on reputation and confidence
   */
  calculateVoteWeight(verifier, result) {
    const reputation = verifier.reputation || 1.0;
    const confidence = result.confidence || 1.0;
    
    // Weight = reputation * confidence
    let weight = reputation * confidence;
    
    // Apply reputation weight factor
    weight = (weight * this.options.reputationWeight) + 
             (1.0 * (1 - this.options.reputationWeight));
    
    return Math.max(0.1, Math.min(2.0, weight));
  }
  
  /**
   * Update node reputation based on consensus
   */
  updateNodeReputation(shareId, finalResult) {
    const verification = this.pendingVerifications.get(shareId);
    if (!verification) return;
    
    verification.responses.forEach((response, nodeId) => {
      const agreedWithConsensus = response.valid === finalResult.valid;
      
      if (finalResult.status === VerificationStatus.VERIFIED || 
          finalResult.status === VerificationStatus.REJECTED) {
        // Clear consensus - adjust reputation
        const adjustment = agreedWithConsensus ? 0.01 : -0.02;
        this.adjustReputation(nodeId, adjustment);
      }
      // For disputed shares, don't adjust reputation
    });
  }
  
  /**
   * Adjust node reputation
   */
  adjustReputation(nodeId, adjustment) {
    const current = this.nodeReputation.get(nodeId) || 1.0;
    const newRep = Math.max(0.1, Math.min(2.0, current + adjustment));
    
    this.nodeReputation.set(nodeId, newRep);
    
    // Update in verification nodes
    const node = this.verificationNodes.get(nodeId);
    if (node) {
      node.reputation = newRep;
    }
    
    this.emit('reputation:updated', { nodeId, reputation: newRep });
  }
  
  /**
   * Generate unique share ID
   */
  generateShareId(share) {
    const data = `${share.algorithm}:${share.hash}:${share.nonce}:${share.timestamp}`;
    return createHash('sha256').update(data).digest('hex').substring(0, 16);
  }
  
  /**
   * Sign request (placeholder - implement with actual crypto)
   */
  signRequest(request) {
    const data = JSON.stringify({
      type: request.type,
      shareId: request.shareId,
      timestamp: request.timestamp
    });
    
    return createHash('sha256').update(data + this.nodeId).digest('hex');
  }
  
  /**
   * Validate response signature
   */
  validateResponse(response, verifier) {
    // Placeholder - implement actual signature verification
    return response.signature && response.nodeId === verifier.id;
  }
  
  /**
   * Send request to verifier node
   */
  async sendRequest(verifier, request) {
    // Placeholder - implement actual network communication
    // This would use HTTP/WebSocket/gRPC based on verifier.endpoint
    
    return new Promise((resolve) => {
      // Simulate network delay
      setTimeout(() => {
        // Simulate verification response
        resolve({
          nodeId: verifier.id,
          shareId: request.shareId,
          valid: Math.random() > 0.1, // 90% valid for simulation
          confidence: 0.8 + Math.random() * 0.2,
          reason: null,
          timestamp: Date.now(),
          signature: 'mock-signature'
        });
      }, 10 + Math.random() * 40); // 10-50ms latency
    });
  }
  
  /**
   * Get verification statistics
   */
  getStats() {
    const stats = {
      activeNodes: this.verificationNodes.size,
      pendingVerifications: this.pendingVerifications.size,
      cacheSize: this.verificationCache.size,
      reputationDistribution: {}
    };
    
    // Calculate reputation distribution
    const repBuckets = [0.5, 1.0, 1.5, 2.0];
    repBuckets.forEach(bucket => {
      stats.reputationDistribution[`<${bucket}`] = 0;
    });
    
    this.nodeReputation.forEach(rep => {
      for (const bucket of repBuckets) {
        if (rep < bucket) {
          stats.reputationDistribution[`<${bucket}`]++;
          break;
        }
      }
    });
    
    return stats;
  }
  
  /**
   * Start cleanup timer
   */
  startCleanupTimer() {
    setInterval(() => {
      // Clean old cache entries
      const now = Date.now();
      const cacheTimeout = 300000; // 5 minutes
      
      for (const [key, value] of this.verificationCache) {
        if (now - value.timestamp > cacheTimeout) {
          this.verificationCache.delete(key);
        }
      }
      
      // Mark inactive nodes
      for (const [nodeId, node] of this.verificationNodes) {
        if (now - node.lastSeen > 60000) { // 1 minute
          this.logger.warn(`Node ${nodeId} is inactive`);
          this.adjustReputation(nodeId, -0.05);
        }
      }
    }, 30000); // Every 30 seconds
  }
  
  /**
   * Handle local verification (when selected as verifier)
   */
  async handleVerificationRequest(request) {
    try {
      const { share, shareId, requesterId } = request;
      
      // Perform actual share validation
      const isValid = await this.validateShareLocally(share);
      
      const response = {
        nodeId: this.nodeId,
        shareId,
        valid: isValid,
        confidence: 0.95, // High confidence for local validation
        reason: isValid ? null : 'Invalid hash',
        timestamp: Date.now()
      };
      
      // Sign response
      response.signature = this.signRequest(response);
      
      return response;
      
    } catch (error) {
      this.logger.error('Local verification failed:', error);
      throw error;
    }
  }
  
  /**
   * Validate share locally
   */
  async validateShareLocally(share) {
    // Implement actual share validation logic
    // This is a placeholder that validates based on difficulty
    
    const hash = createHash('sha256')
      .update(share.nonce + share.timestamp)
      .digest('hex');
    
    const hashBigInt = BigInt('0x' + hash);
    const target = BigInt('0x' + 'f'.repeat(64)) / BigInt(share.difficulty);
    
    return hashBigInt <= target;
  }
}