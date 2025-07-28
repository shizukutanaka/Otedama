/**
 * Distributed Hash Validator - Otedama
 * Validates mining shares and blocks across P2P network
 * 
 * Design: Rob Pike - Simple consensus mechanism
 * Performance: John Carmack - Fast validation with minimal overhead
 */

import { EventEmitter } from 'events';
import { createHash, randomBytes } from 'crypto';
import { createStructuredLogger } from '../core/structured-logger.js';
import { ShareValidator } from './share-validator.js';
import { P2PNetwork } from '../network/p2p-network.js';

const logger = createStructuredLogger('DistributedValidator');

/**
 * Validation request types
 */
export const ValidationRequestType = {
  SHARE: 'share',
  BLOCK: 'block',
  TRANSACTION: 'transaction',
  CHAIN: 'chain'
};

/**
 * Consensus mechanisms
 */
export const ConsensusMechanism = {
  MAJORITY: 'majority',        // >50% agreement
  SUPERMAJORITY: 'supermajority', // >66% agreement
  UNANIMOUS: 'unanimous',      // 100% agreement
  WEIGHTED: 'weighted'         // Weighted by hash power
};

/**
 * Distributed Hash Validator
 */
export class DistributedValidator extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      consensusMechanism: config.consensusMechanism || ConsensusMechanism.SUPERMAJORITY,
      validationTimeout: config.validationTimeout || 5000, // 5 seconds
      minValidators: config.minValidators || 3,
      maxValidators: config.maxValidators || 10,
      cacheExpiry: config.cacheExpiry || 300000, // 5 minutes
      trustScoreThreshold: config.trustScoreThreshold || 0.8,
      penaltyDecay: config.penaltyDecay || 0.95, // Trust recovery rate
      ...config
    };
    
    // Components
    this.shareValidator = new ShareValidator();
    this.p2pNetwork = config.p2pNetwork || null;
    
    // State
    this.validationRequests = new Map();
    this.validationCache = new Map();
    this.peerTrustScores = new Map();
    this.validationHistory = [];
    
    // Statistics
    this.stats = {
      totalValidations: 0,
      successfulValidations: 0,
      failedValidations: 0,
      consensusReached: 0,
      consensusFailed: 0,
      cacheHits: 0,
      avgValidationTime: 0,
      peerResponses: new Map()
    };
    
    this.initialize();
  }
  
  /**
   * Initialize validator
   */
  initialize() {
    // Set up P2P message handlers
    if (this.p2pNetwork) {
      this.setupP2PHandlers();
    }
    
    // Start cache cleanup
    this.startCacheCleanup();
    
    logger.info('Distributed validator initialized', {
      consensus: this.config.consensusMechanism,
      minValidators: this.config.minValidators
    });
  }
  
  /**
   * Validate share across network
   */
  async validateShare(share, options = {}) {
    const validationId = this.generateValidationId();
    
    // Check cache first
    const cacheKey = this.getCacheKey('share', share);
    const cached = this.validationCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.config.cacheExpiry) {
      this.stats.cacheHits++;
      return cached.result;
    }
    
    // Local validation first
    const localResult = await this.performLocalValidation('share', share);
    
    // If no peers available, use local result
    const availablePeers = this.getAvailableValidators();
    if (availablePeers.length < this.config.minValidators - 1) {
      logger.warn('Insufficient validators available', {
        required: this.config.minValidators,
        available: availablePeers.length
      });
      
      return this.createValidationResult(validationId, [localResult]);
    }
    
    // Create validation request
    const request = {
      id: validationId,
      type: ValidationRequestType.SHARE,
      data: share,
      timestamp: Date.now(),
      requester: this.getNodeId(),
      responses: new Map(),
      timeout: null
    };
    
    // Add local result
    request.responses.set('local', localResult);
    
    this.validationRequests.set(validationId, request);
    
    // Request validation from peers
    const validationPromise = this.requestPeerValidation(request, availablePeers);
    
    try {
      const result = await validationPromise;
      
      // Cache result
      this.validationCache.set(cacheKey, {
        result,
        timestamp: Date.now()
      });
      
      // Update statistics
      this.updateStatistics(request, result);
      
      return result;
      
    } finally {
      this.validationRequests.delete(validationId);
    }
  }
  
  /**
   * Validate block across network
   */
  async validateBlock(block, options = {}) {
    const validationId = this.generateValidationId();
    
    // Check cache
    const cacheKey = this.getCacheKey('block', block);
    const cached = this.validationCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.config.cacheExpiry) {
      this.stats.cacheHits++;
      return cached.result;
    }
    
    // Local validation
    const localResult = await this.performLocalValidation('block', block);
    
    // Get validators
    const availablePeers = this.getAvailableValidators();
    
    // For blocks, we want more validators
    const requiredValidators = Math.min(
      this.config.maxValidators,
      Math.max(this.config.minValidators, availablePeers.length)
    );
    
    if (availablePeers.length < requiredValidators - 1) {
      logger.warn('Insufficient validators for block', {
        required: requiredValidators,
        available: availablePeers.length
      });
    }
    
    // Create request
    const request = {
      id: validationId,
      type: ValidationRequestType.BLOCK,
      data: block,
      timestamp: Date.now(),
      requester: this.getNodeId(),
      responses: new Map(),
      timeout: null
    };
    
    request.responses.set('local', localResult);
    this.validationRequests.set(validationId, request);
    
    // Request validation
    const selectedPeers = availablePeers.slice(0, requiredValidators - 1);
    const validationPromise = this.requestPeerValidation(request, selectedPeers);
    
    try {
      const result = await validationPromise;
      
      // Cache result
      this.validationCache.set(cacheKey, {
        result,
        timestamp: Date.now()
      });
      
      // Update statistics
      this.updateStatistics(request, result);
      
      // Emit block validation event
      if (result.valid) {
        this.emit('block:valid', { block, validators: result.validators });
      } else {
        this.emit('block:invalid', { block, reason: result.reason });
      }
      
      return result;
      
    } finally {
      this.validationRequests.delete(validationId);
    }
  }
  
  /**
   * Perform local validation
   */
  async performLocalValidation(type, data) {
    const startTime = Date.now();
    
    try {
      let valid = false;
      let details = {};
      
      switch (type) {
        case ValidationRequestType.SHARE:
          const shareResult = await this.shareValidator.validateShare(data);
          valid = shareResult.valid;
          details = shareResult;
          break;
          
        case ValidationRequestType.BLOCK:
          const blockResult = await this.validateBlockLocal(data);
          valid = blockResult.valid;
          details = blockResult;
          break;
          
        default:
          throw new Error(`Unknown validation type: ${type}`);
      }
      
      return {
        validator: 'local',
        valid,
        timestamp: Date.now(),
        duration: Date.now() - startTime,
        details,
        signature: this.signValidation({ type, data, valid })
      };
      
    } catch (error) {
      logger.error('Local validation failed:', error);
      
      return {
        validator: 'local',
        valid: false,
        timestamp: Date.now(),
        duration: Date.now() - startTime,
        error: error.message
      };
    }
  }
  
  /**
   * Validate block locally
   */
  async validateBlockLocal(block) {
    // Basic block validation
    const checks = {
      hasRequiredFields: true,
      validHash: false,
      validDifficulty: false,
      validTransactions: true,
      validTimestamp: false
    };
    
    // Check required fields
    const requiredFields = ['hash', 'previousHash', 'timestamp', 'nonce', 'difficulty'];
    for (const field of requiredFields) {
      if (!block[field]) {
        checks.hasRequiredFields = false;
        break;
      }
    }
    
    // Validate hash
    const calculatedHash = this.calculateBlockHash(block);
    checks.validHash = calculatedHash === block.hash;
    
    // Check difficulty
    const hashBinary = parseInt(block.hash.substring(0, 8), 16).toString(2);
    const leadingZeros = hashBinary.match(/^0*/)[0].length;
    checks.validDifficulty = leadingZeros >= block.difficulty;
    
    // Check timestamp
    const now = Date.now();
    const blockTime = new Date(block.timestamp).getTime();
    checks.validTimestamp = blockTime <= now && blockTime > now - 7200000; // Within 2 hours
    
    // Overall validity
    const valid = Object.values(checks).every(check => check === true);
    
    return {
      valid,
      checks,
      hash: calculatedHash
    };
  }
  
  /**
   * Request validation from peers
   */
  async requestPeerValidation(request, peers) {
    return new Promise((resolve) => {
      // Set timeout
      request.timeout = setTimeout(() => {
        resolve(this.evaluateConsensus(request));
      }, this.config.validationTimeout);
      
      // Send validation requests to peers
      for (const peer of peers) {
        this.sendValidationRequest(peer, request);
      }
      
      // Check if we already have enough responses
      if (request.responses.size >= this.config.minValidators) {
        clearTimeout(request.timeout);
        resolve(this.evaluateConsensus(request));
      }
    });
  }
  
  /**
   * Send validation request to peer
   */
  sendValidationRequest(peer, request) {
    if (!this.p2pNetwork) return;
    
    const message = {
      type: 'validation:request',
      id: request.id,
      validationType: request.type,
      data: request.data,
      requester: request.requester
    };
    
    this.p2pNetwork.sendToPeer(peer, message);
  }
  
  /**
   * Handle validation response
   */
  handleValidationResponse(peerId, response) {
    const request = this.validationRequests.get(response.requestId);
    if (!request) return;
    
    // Verify response signature
    if (!this.verifyValidationSignature(peerId, response)) {
      logger.warn('Invalid validation signature from peer', { peerId });
      this.updatePeerTrust(peerId, -0.1);
      return;
    }
    
    // Add response
    request.responses.set(peerId, response);
    
    // Update peer statistics
    const peerStats = this.stats.peerResponses.get(peerId) || {
      total: 0,
      valid: 0,
      invalid: 0,
      avgResponseTime: 0
    };
    
    peerStats.total++;
    if (response.valid) peerStats.valid++;
    else peerStats.invalid++;
    
    const responseTime = Date.now() - request.timestamp;
    peerStats.avgResponseTime = 
      (peerStats.avgResponseTime * (peerStats.total - 1) + responseTime) / peerStats.total;
    
    this.stats.peerResponses.set(peerId, peerStats);
    
    // Check if we have enough responses
    if (request.responses.size >= this.config.minValidators) {
      clearTimeout(request.timeout);
      const result = this.evaluateConsensus(request);
      
      // Resolve any waiting promises
      if (request.resolve) {
        request.resolve(result);
      }
    }
  }
  
  /**
   * Evaluate consensus
   */
  evaluateConsensus(request) {
    const responses = Array.from(request.responses.values());
    const validCount = responses.filter(r => r.valid).length;
    const totalCount = responses.length;
    
    let consensusReached = false;
    let consensusThreshold = 0;
    
    switch (this.config.consensusMechanism) {
      case ConsensusMechanism.MAJORITY:
        consensusThreshold = 0.5;
        break;
        
      case ConsensusMechanism.SUPERMAJORITY:
        consensusThreshold = 0.66;
        break;
        
      case ConsensusMechanism.UNANIMOUS:
        consensusThreshold = 1.0;
        break;
        
      case ConsensusMechanism.WEIGHTED:
        return this.evaluateWeightedConsensus(request);
    }
    
    consensusReached = (validCount / totalCount) >= consensusThreshold;
    
    // Update trust scores based on consensus
    this.updateTrustScores(request, consensusReached);
    
    const result = {
      id: request.id,
      type: request.type,
      valid: consensusReached,
      consensus: {
        mechanism: this.config.consensusMechanism,
        threshold: consensusThreshold,
        achieved: validCount / totalCount,
        validCount,
        totalCount
      },
      validators: responses.map(r => ({
        id: r.validator,
        valid: r.valid,
        duration: r.duration
      })),
      timestamp: Date.now()
    };
    
    // Add to history
    this.addToHistory(result);
    
    return result;
  }
  
  /**
   * Evaluate weighted consensus
   */
  evaluateWeightedConsensus(request) {
    const responses = Array.from(request.responses.entries());
    let totalWeight = 0;
    let validWeight = 0;
    
    for (const [peerId, response] of responses) {
      const weight = this.getPeerWeight(peerId);
      totalWeight += weight;
      
      if (response.valid) {
        validWeight += weight;
      }
    }
    
    const consensusRatio = totalWeight > 0 ? validWeight / totalWeight : 0;
    const consensusReached = consensusRatio >= 0.66; // Weighted supermajority
    
    return {
      id: request.id,
      type: request.type,
      valid: consensusReached,
      consensus: {
        mechanism: ConsensusMechanism.WEIGHTED,
        threshold: 0.66,
        achieved: consensusRatio,
        validWeight,
        totalWeight
      },
      validators: responses.map(([peerId, response]) => ({
        id: peerId,
        valid: response.valid,
        weight: this.getPeerWeight(peerId),
        duration: response.duration
      })),
      timestamp: Date.now()
    };
  }
  
  /**
   * Get peer weight for consensus
   */
  getPeerWeight(peerId) {
    // Weight based on trust score and response history
    const trustScore = this.peerTrustScores.get(peerId) || 0.5;
    const peerStats = this.stats.peerResponses.get(peerId);
    
    if (!peerStats || peerStats.total < 10) {
      return trustScore; // New peer, use trust score only
    }
    
    // Factor in accuracy and response time
    const accuracy = peerStats.valid / peerStats.total;
    const speedBonus = Math.max(0, 1 - (peerStats.avgResponseTime / this.config.validationTimeout));
    
    return trustScore * accuracy * (1 + speedBonus * 0.2);
  }
  
  /**
   * Update trust scores
   */
  updateTrustScores(request, consensusValid) {
    const responses = Array.from(request.responses.entries());
    
    for (const [peerId, response] of responses) {
      if (peerId === 'local') continue;
      
      let adjustment = 0;
      
      // Peer agreed with consensus
      if (response.valid === consensusValid) {
        adjustment = 0.01; // Small positive adjustment
      } else {
        adjustment = -0.05; // Larger negative adjustment
      }
      
      // Bonus for fast response
      const responseTime = response.timestamp - request.timestamp;
      if (responseTime < this.config.validationTimeout * 0.5) {
        adjustment += 0.005;
      }
      
      this.updatePeerTrust(peerId, adjustment);
    }
  }
  
  /**
   * Update peer trust score
   */
  updatePeerTrust(peerId, adjustment) {
    const currentTrust = this.peerTrustScores.get(peerId) || 0.5;
    const newTrust = Math.max(0, Math.min(1, currentTrust + adjustment));
    
    this.peerTrustScores.set(peerId, newTrust);
    
    // Apply decay to move towards neutral
    if (newTrust < 0.5) {
      const decayed = newTrust + (0.5 - newTrust) * (1 - this.config.penaltyDecay);
      this.peerTrustScores.set(peerId, decayed);
    }
  }
  
  /**
   * Get available validators
   */
  getAvailableValidators() {
    if (!this.p2pNetwork) return [];
    
    const peers = this.p2pNetwork.getConnectedPeers();
    
    // Filter by trust score
    return peers.filter(peer => {
      const trustScore = this.peerTrustScores.get(peer.id) || 0.5;
      return trustScore >= this.config.trustScoreThreshold;
    }).sort((a, b) => {
      // Sort by trust score and response time
      const trustA = this.peerTrustScores.get(a.id) || 0.5;
      const trustB = this.peerTrustScores.get(b.id) || 0.5;
      
      return trustB - trustA;
    });
  }
  
  /**
   * Setup P2P handlers
   */
  setupP2PHandlers() {
    // Handle validation requests
    this.p2pNetwork.on('validation:request', async (peerId, message) => {
      try {
        const result = await this.performLocalValidation(
          message.validationType,
          message.data
        );
        
        const response = {
          requestId: message.id,
          ...result
        };
        
        this.p2pNetwork.sendToPeer(peerId, {
          type: 'validation:response',
          ...response
        });
        
      } catch (error) {
        logger.error('Failed to handle validation request:', error);
      }
    });
    
    // Handle validation responses
    this.p2pNetwork.on('validation:response', (peerId, message) => {
      this.handleValidationResponse(peerId, message);
    });
  }
  
  /**
   * Calculate block hash
   */
  calculateBlockHash(block) {
    const data = {
      previousHash: block.previousHash,
      timestamp: block.timestamp,
      transactions: block.transactions || [],
      nonce: block.nonce
    };
    
    return createHash('sha256')
      .update(JSON.stringify(data))
      .digest('hex');
  }
  
  /**
   * Sign validation result
   */
  signValidation(data) {
    // In production, use proper cryptographic signing
    return createHash('sha256')
      .update(JSON.stringify(data) + this.getNodeId())
      .digest('hex');
  }
  
  /**
   * Verify validation signature
   */
  verifyValidationSignature(peerId, response) {
    // In production, verify with peer's public key
    // For now, basic check
    return response.signature && response.signature.length === 64;
  }
  
  /**
   * Get cache key
   */
  getCacheKey(type, data) {
    const hash = createHash('sha256')
      .update(type + JSON.stringify(data))
      .digest('hex');
    
    return `${type}_${hash}`;
  }
  
  /**
   * Get node ID
   */
  getNodeId() {
    return this.config.nodeId || 'local';
  }
  
  /**
   * Generate validation ID
   */
  generateValidationId() {
    return `val_${Date.now()}_${randomBytes(8).toString('hex')}`;
  }
  
  /**
   * Add to history
   */
  addToHistory(result) {
    this.validationHistory.push({
      ...result,
      timestamp: Date.now()
    });
    
    // Keep only recent history
    const maxHistory = 1000;
    if (this.validationHistory.length > maxHistory) {
      this.validationHistory = this.validationHistory.slice(-maxHistory);
    }
  }
  
  /**
   * Update statistics
   */
  updateStatistics(request, result) {
    this.stats.totalValidations++;
    
    if (result.valid) {
      this.stats.successfulValidations++;
    } else {
      this.stats.failedValidations++;
    }
    
    if (result.consensus.achieved >= result.consensus.threshold) {
      this.stats.consensusReached++;
    } else {
      this.stats.consensusFailed++;
    }
    
    // Update average validation time
    const validationTime = Date.now() - request.timestamp;
    this.stats.avgValidationTime = 
      (this.stats.avgValidationTime * (this.stats.totalValidations - 1) + validationTime) / 
      this.stats.totalValidations;
  }
  
  /**
   * Start cache cleanup
   */
  startCacheCleanup() {
    setInterval(() => {
      const now = Date.now();
      const expiry = this.config.cacheExpiry;
      
      for (const [key, entry] of this.validationCache.entries()) {
        if (now - entry.timestamp > expiry) {
          this.validationCache.delete(key);
        }
      }
    }, 60000); // Clean every minute
  }
  
  /**
   * Create validation result
   */
  createValidationResult(id, responses) {
    const validCount = responses.filter(r => r.valid).length;
    
    return {
      id,
      valid: validCount > 0,
      consensus: {
        mechanism: 'local',
        threshold: 1,
        achieved: validCount,
        validCount,
        totalCount: responses.length
      },
      validators: responses.map(r => ({
        id: r.validator,
        valid: r.valid,
        duration: r.duration
      })),
      timestamp: Date.now()
    };
  }
  
  /**
   * Get statistics
   */
  getStatistics() {
    return {
      ...this.stats,
      cacheSize: this.validationCache.size,
      activeRequests: this.validationRequests.size,
      trustedPeers: Array.from(this.peerTrustScores.entries())
        .filter(([_, score]) => score >= this.config.trustScoreThreshold)
        .length,
      peerResponses: Object.fromEntries(this.stats.peerResponses),
      recentHistory: this.validationHistory.slice(-10)
    };
  }
  
  /**
   * Export trust scores
   */
  exportTrustScores() {
    return Object.fromEntries(this.peerTrustScores);
  }
  
  /**
   * Import trust scores
   */
  importTrustScores(scores) {
    for (const [peerId, score] of Object.entries(scores)) {
      this.peerTrustScores.set(peerId, score);
    }
  }
  
  /**
   * Shutdown validator
   */
  shutdown() {
    // Clear requests
    for (const request of this.validationRequests.values()) {
      if (request.timeout) {
        clearTimeout(request.timeout);
      }
    }
    
    this.validationRequests.clear();
    this.validationCache.clear();
    
    this.removeAllListeners();
    logger.info('Distributed validator shutdown');
  }
}

/**
 * Create distributed validator
 */
export function createDistributedValidator(config) {
  return new DistributedValidator(config);
}

export default DistributedValidator;