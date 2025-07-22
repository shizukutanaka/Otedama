/**
 * Reputation System for P2P Mining Pool
 * Manages node trustworthiness and incentive mechanisms
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { getLogger } from '../logger.js';

const logger = getLogger('ReputationSystem');

// Reputation events and their impacts
export const ReputationEvent = {
  SHARE_VALID: { impact: 0.01, category: 'mining' },
  SHARE_INVALID: { impact: -0.05, category: 'mining' },
  SHARE_STALE: { impact: -0.01, category: 'mining' },
  BLOCK_FOUND: { impact: 0.1, category: 'mining' },
  
  MESSAGE_RELAY: { impact: 0.005, category: 'network' },
  MESSAGE_DROP: { impact: -0.02, category: 'network' },
  PROTOCOL_VIOLATION: { impact: -0.1, category: 'network' },
  
  UPTIME_GOOD: { impact: 0.002, category: 'reliability' },
  UPTIME_POOR: { impact: -0.01, category: 'reliability' },
  RESPONSE_FAST: { impact: 0.001, category: 'reliability' },
  RESPONSE_SLOW: { impact: -0.005, category: 'reliability' },
  
  VERIFICATION_CORRECT: { impact: 0.01, category: 'trust' },
  VERIFICATION_INCORRECT: { impact: -0.1, category: 'trust' },
  CONSENSUS_AGREEMENT: { impact: 0.005, category: 'trust' },
  CONSENSUS_DISAGREEMENT: { impact: -0.02, category: 'trust' },
  
  HELP_NEWBIE: { impact: 0.02, category: 'community' },
  SPAM_BEHAVIOR: { impact: -0.1, category: 'community' },
  RESOURCE_SHARING: { impact: 0.01, category: 'community' }
};

// Reputation thresholds
export const ReputationThreshold = {
  EXCELLENT: 0.9,
  GOOD: 0.7,
  AVERAGE: 0.5,
  POOR: 0.3,
  BANNED: 0.1
};

// Reputation decay parameters
const DECAY_RATE = 0.001; // Daily decay rate
const DECAY_INTERVAL = 86400000; // 24 hours

export class ReputationSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = options.logger || logger;
    this.options = {
      initialReputation: options.initialReputation || 0.5,
      maxReputation: options.maxReputation || 1.0,
      minReputation: options.minReputation || 0.0,
      decayEnabled: options.decayEnabled !== false,
      witnessRequired: options.witnessRequired !== false,
      minWitnesses: options.minWitnesses || 3,
      consensusThreshold: options.consensusThreshold || 0.6,
      banThreshold: options.banThreshold || ReputationThreshold.BANNED,
      ...options
    };
    
    // Reputation storage
    this.nodeReputations = new Map();
    this.reputationHistory = new Map();
    this.witnesses = new Map();
    this.bannedNodes = new Set();
    
    // Event tracking
    this.eventLog = [];
    this.pendingEvents = new Map();
    
    // Statistics
    this.stats = {
      totalNodes: 0,
      averageReputation: 0,
      reputationDistribution: {},
      eventsProcessed: 0,
      consensusVotes: 0,
      bannedCount: 0
    };
    
    // Start background processes
    this.startDecayProcess();
    this.startConsensusProcess();
    this.startStatisticsUpdate();
  }
  
  /**
   * Record reputation event
   */
  recordEvent(nodeId, eventType, details = {}) {
    if (!this.nodeReputations.has(nodeId)) {
      this.initializeNode(nodeId);
    }
    
    const event = ReputationEvent[eventType];
    if (!event) {
      this.logger.warn(`Unknown reputation event: ${eventType}`);
      return;
    }
    
    // Apply reputation impact
    const currentRep = this.nodeReputations.get(nodeId);
    const newRep = Math.max(
      this.options.minReputation,
      Math.min(
        this.options.maxReputation,
        currentRep + event.impact
      )
    );
    
    this.nodeReputations.set(nodeId, newRep);
    
    // Record event
    const eventRecord = {
      nodeId,
      eventType,
      impact: event.impact,
      category: event.category,
      details,
      timestamp: Date.now()
    };
    
    this.eventLog.push(eventRecord);
    
    // Add to history
    if (!this.reputationHistory.has(nodeId)) {
      this.reputationHistory.set(nodeId, []);
    }
    this.reputationHistory.get(nodeId).push({
      reputation: newRep,
      event: eventType,
      timestamp: Date.now()
    });
    
    // Check for ban
    if (newRep <= this.options.banThreshold) {
      this.bannedNodes.add(nodeId);
      this.emit('node:banned', { nodeId, reputation: newRep });
    }
    
    // Update statistics
    this.stats.eventsProcessed++;
    
    this.emit('reputation:updated', {
      nodeId,
      oldReputation: currentRep,
      newReputation: newRep,
      event: eventType
    });
  }
  
  /**
   * Initialize node reputation
   */
  initializeNode(nodeId) {
    this.nodeReputations.set(nodeId, this.options.initialReputation);
    this.reputationHistory.set(nodeId, [{
      reputation: this.options.initialReputation,
      event: 'INITIALIZED',
      timestamp: Date.now()
    }]);
    this.stats.totalNodes++;
  }
  
  /**
   * Get node reputation
   */
  getReputation(nodeId) {
    if (this.bannedNodes.has(nodeId)) {
      return 0;
    }
    return this.nodeReputations.get(nodeId) || this.options.initialReputation;
  }
  
  /**
   * Get reputation tier
   */
  getReputationTier(nodeId) {
    const reputation = this.getReputation(nodeId);
    
    if (reputation >= ReputationThreshold.EXCELLENT) return 'EXCELLENT';
    if (reputation >= ReputationThreshold.GOOD) return 'GOOD';
    if (reputation >= ReputationThreshold.AVERAGE) return 'AVERAGE';
    if (reputation >= ReputationThreshold.POOR) return 'POOR';
    return 'BANNED';
  }
  
  /**
   * Request witness validation
   */
  requestWitnessValidation(event, nodeId, details) {
    if (!this.options.witnessRequired) {
      this.recordEvent(nodeId, event, details);
      return;
    }
    
    const witnessRequest = {
      id: `witness_${Date.now()}_${Math.random()}`,
      event,
      nodeId,
      details,
      witnesses: new Map(),
      timestamp: Date.now()
    };
    
    this.pendingEvents.set(witnessRequest.id, witnessRequest);
    
    this.emit('witness:request', {
      requestId: witnessRequest.id,
      event,
      nodeId,
      details
    });
    
    // Timeout for witness collection
    setTimeout(() => {
      this.processWitnessValidation(witnessRequest.id);
    }, 30000); // 30 seconds
  }
  
  /**
   * Submit witness testimony
   */
  submitWitness(requestId, witnessId, testimony) {
    const request = this.pendingEvents.get(requestId);
    if (!request) return;
    
    // Verify witness is not the subject
    if (witnessId === request.nodeId) return;
    
    // Record witness testimony
    request.witnesses.set(witnessId, {
      agrees: testimony.agrees,
      confidence: testimony.confidence || 1.0,
      timestamp: Date.now()
    });
    
    // Add to witness tracking
    if (!this.witnesses.has(witnessId)) {
      this.witnesses.set(witnessId, {
        testimonies: 0,
        accurate: 0
      });
    }
    
    const witnessStats = this.witnesses.get(witnessId);
    witnessStats.testimonies++;
    
    // Check if we have enough witnesses
    if (request.witnesses.size >= this.options.minWitnesses) {
      this.processWitnessValidation(requestId);
    }
  }
  
  /**
   * Process witness validation
   */
  processWitnessValidation(requestId) {
    const request = this.pendingEvents.get(requestId);
    if (!request) return;
    
    const witnesses = Array.from(request.witnesses.entries());
    
    if (witnesses.length < this.options.minWitnesses) {
      // Not enough witnesses, skip event
      this.pendingEvents.delete(requestId);
      return;
    }
    
    // Calculate weighted consensus
    let agreeWeight = 0;
    let totalWeight = 0;
    
    witnesses.forEach(([witnessId, testimony]) => {
      const witnessRep = this.getReputation(witnessId);
      const weight = witnessRep * testimony.confidence;
      totalWeight += weight;
      
      if (testimony.agrees) {
        agreeWeight += weight;
      }
    });
    
    const consensus = totalWeight > 0 ? agreeWeight / totalWeight : 0;
    
    // Apply event if consensus reached
    if (consensus >= this.options.consensusThreshold) {
      this.recordEvent(request.nodeId, request.event, request.details);
      
      // Update witness accuracy
      witnesses.forEach(([witnessId, testimony]) => {
        if (testimony.agrees) {
          const stats = this.witnesses.get(witnessId);
          if (stats) stats.accurate++;
        }
      });
    }
    
    this.stats.consensusVotes++;
    this.pendingEvents.delete(requestId);
    
    this.emit('witness:consensus', {
      requestId,
      consensus,
      applied: consensus >= this.options.consensusThreshold
    });
  }
  
  /**
   * Start reputation decay process
   */
  startDecayProcess() {
    if (!this.options.decayEnabled) return;
    
    this.decayInterval = setInterval(() => {
      this.nodeReputations.forEach((reputation, nodeId) => {
        if (reputation === this.options.initialReputation) return;
        
        // Decay towards initial reputation
        const diff = reputation - this.options.initialReputation;
        const decay = diff * DECAY_RATE;
        const newRep = reputation - decay;
        
        this.nodeReputations.set(nodeId, newRep);
      });
      
      this.emit('decay:applied');
    }, DECAY_INTERVAL);
  }
  
  /**
   * Start consensus monitoring process
   */
  startConsensusProcess() {
    // Periodic cleanup of old pending events
    this.consensusInterval = setInterval(() => {
      const now = Date.now();
      const timeout = 300000; // 5 minutes
      
      for (const [requestId, request] of this.pendingEvents) {
        if (now - request.timestamp > timeout) {
          this.pendingEvents.delete(requestId);
        }
      }
    }, 60000); // Every minute
  }
  
  /**
   * Start statistics update process
   */
  startStatisticsUpdate() {
    this.statsInterval = setInterval(() => {
      this.updateStatistics();
    }, 30000); // Every 30 seconds
  }
  
  /**
   * Update statistics
   */
  updateStatistics() {
    // Calculate average reputation
    let totalRep = 0;
    let nodeCount = 0;
    
    this.nodeReputations.forEach((rep, nodeId) => {
      if (!this.bannedNodes.has(nodeId)) {
        totalRep += rep;
        nodeCount++;
      }
    });
    
    this.stats.averageReputation = nodeCount > 0 ? totalRep / nodeCount : 0;
    
    // Calculate distribution
    this.stats.reputationDistribution = {
      EXCELLENT: 0,
      GOOD: 0,
      AVERAGE: 0,
      POOR: 0,
      BANNED: 0
    };
    
    this.nodeReputations.forEach((rep, nodeId) => {
      const tier = this.getReputationTier(nodeId);
      this.stats.reputationDistribution[tier]++;
    });
    
    this.stats.bannedCount = this.bannedNodes.size;
  }
  
  /**
   * Get statistics
   */
  getStats() {
    this.updateStatistics();
    return {
      ...this.stats,
      topNodes: this.getTopNodes(10),
      recentEvents: this.eventLog.slice(-100)
    };
  }
  
  /**
   * Get top nodes by reputation
   */
  getTopNodes(limit = 10) {
    const nodes = Array.from(this.nodeReputations.entries())
      .filter(([nodeId]) => !this.bannedNodes.has(nodeId))
      .map(([nodeId, reputation]) => ({
        nodeId,
        reputation,
        tier: this.getReputationTier(nodeId)
      }))
      .sort((a, b) => b.reputation - a.reputation)
      .slice(0, limit);
    
    return nodes;
  }
  
  /**
   * Cleanup
   */
  cleanup() {
    if (this.decayInterval) clearInterval(this.decayInterval);
    if (this.consensusInterval) clearInterval(this.consensusInterval);
    if (this.statsInterval) clearInterval(this.statsInterval);
    
    this.nodeReputations.clear();
    this.reputationHistory.clear();
    this.witnesses.clear();
    this.bannedNodes.clear();
    this.pendingEvents.clear();
    this.eventLog = [];
  }
}