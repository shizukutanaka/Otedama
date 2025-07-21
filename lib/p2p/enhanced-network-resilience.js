/**
 * Enhanced Network Resilience for P2P Mining Pool
 * Advanced network partition detection and recovery mechanisms
 */

import { EventEmitter } from 'events';
import { getErrorHandler, OtedamaError, ErrorCategory, safeExecute } from '../error-handler.js';

// Network health states
export const NetworkHealth = {
  OPTIMAL: 'optimal',       // All peers connected, low latency
  STABLE: 'stable',         // Most peers connected, acceptable latency
  DEGRADED: 'degraded',     // Some peer loss, higher latency
  UNSTABLE: 'unstable',     // Significant peer loss, high latency
  CRITICAL: 'critical'      // Major network issues, partition likely
};

// Partition detection strategies
export const DetectionStrategy = {
  PEER_COUNT: 'peer_count',           // Based on peer count threshold
  CONSENSUS: 'consensus',             // Based on consensus disagreement
  LATENCY: 'latency',                 // Based on network latency
  HYBRID: 'hybrid'                    // Combination of multiple strategies
};

export class EnhancedNetworkResilience extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Detection settings
      detectionStrategy: options.detectionStrategy || DetectionStrategy.HYBRID,
      peerCountThreshold: options.peerCountThreshold || 0.3,
      latencyThreshold: options.latencyThreshold || 1000,
      consensusThreshold: options.consensusThreshold || 0.6,
      consensusHeightThreshold: options.consensusHeightThreshold || 3,
      
      // Health monitoring
      healthCheckInterval: options.healthCheckInterval || 5000,
      peerTimeoutThreshold: options.peerTimeoutThreshold || 30000,
      networkStabilityWindow: options.networkStabilityWindow || 60000,
      
      // Recovery settings
      autoRecovery: options.autoRecovery !== false,
      recoveryTimeout: options.recoveryTimeout || 300000,
      maxRecoveryAttempts: options.maxRecoveryAttempts || 5,
      
      // Adaptive settings
      adaptiveThresholds: options.adaptiveThresholds !== false,
      learningRate: options.learningRate || 0.1,
      
      ...options
    };
    
    this.state = {
      networkHealth: NetworkHealth.OPTIMAL,
      activePeers: new Set(),
      peerLatencies: new Map(),
      peerReliability: new Map(),
      partitionDetected: false,
      lastPartitionTime: 0,
      recoveryAttempts: 0,
      networkMetrics: {
        averageLatency: 0,
        packetLoss: 0,
        throughput: 0,
        stability: 1.0
      }
    };
    
    this.history = {
      healthHistory: [],
      partitionHistory: [],
      recoveryHistory: [],
      peerHistory: new Map()
    };
    
    this.timers = new Map();
    this.errorHandler = getErrorHandler();
    // External consensus data provider
    this.consensusProvider = null;
    
    this.startNetworkMonitoring();
  }
  
  /**
   * Start network monitoring
   */
  startNetworkMonitoring() {
    const healthTimer = setInterval(() => {
      this.performHealthCheck();
    }, this.options.healthCheckInterval);
    
    this.timers.set('health', healthTimer);
    
    // Start peer timeout monitoring
    const timeoutTimer = setInterval(() => {
      this.checkPeerTimeouts();
    }, this.options.peerTimeoutThreshold / 2);
    
    this.timers.set('timeout', timeoutTimer);
  }
  
  /**
   * Perform comprehensive health check
   */
  async performHealthCheck() {
    try {
      const now = Date.now();
      
      // Update network metrics
      this.updateNetworkMetrics();
      
      // Detect network health
      const newHealth = this.detectNetworkHealth();
      
      // Check for partition
      const partitionDetected = this.detectPartition();
      
      // Update state
      if (newHealth !== this.state.networkHealth) {
        const oldHealth = this.state.networkHealth;
        this.state.networkHealth = newHealth;
        
        this.emit('healthChange', {
          oldHealth,
          newHealth,
          metrics: this.state.networkMetrics,
          timestamp: now
        });
        
        // Record health history
        this.history.healthHistory.push({
          health: newHealth,
          timestamp: now,
          metrics: { ...this.state.networkMetrics }
        });
        
        // Keep history limited
        if (this.history.healthHistory.length > 1000) {
          this.history.healthHistory.shift();
        }
      }
      
      // Handle partition detection
      if (partitionDetected && !this.state.partitionDetected) {
        this.handlePartitionDetected();
      } else if (!partitionDetected && this.state.partitionDetected) {
        this.handlePartitionRecovered();
      }
      
      // Adaptive threshold adjustment
      if (this.options.adaptiveThresholds) {
        this.adjustThresholds();
      }
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        context: 'network_health_check',
        category: ErrorCategory.NETWORK
      });
    }
  }
  
  /**
   * Update network metrics
   */
  updateNetworkMetrics() {
    const activePeerCount = this.state.activePeers.size;
    
    if (activePeerCount === 0) {
      this.state.networkMetrics = {
        averageLatency: Infinity,
        packetLoss: 1.0,
        throughput: 0,
        stability: 0
      };
      return;
    }
    
    // Calculate average latency
    let totalLatency = 0;
    let latencyCount = 0;
    
    for (const [peerId, latency] of this.state.peerLatencies) {
      if (this.state.activePeers.has(peerId)) {
        totalLatency += latency;
        latencyCount++;
      }
    }
    
    const averageLatency = latencyCount > 0 ? totalLatency / latencyCount : 0;
    
    // Calculate packet loss (simplified)
    let totalReliability = 0;
    for (const [peerId, reliability] of this.state.peerReliability) {
      if (this.state.activePeers.has(peerId)) {
        totalReliability += reliability;
      }
    }
    
    const averageReliability = activePeerCount > 0 ? totalReliability / activePeerCount : 0;
    const packetLoss = Math.max(0, 1 - averageReliability);
    
    // Calculate stability based on peer consistency
    const stability = this.calculateNetworkStability();
    
    this.state.networkMetrics = {
      averageLatency,
      packetLoss,
      throughput: this.calculateThroughput(),
      stability
    };
  }
  
  /**
   * Detect network health based on metrics
   */
  detectNetworkHealth() {
    const { averageLatency, packetLoss, stability } = this.state.networkMetrics;
    const peerCount = this.state.activePeers.size;
    
    // Critical conditions
    if (peerCount === 0 || packetLoss > 0.5 || stability < 0.2) {
      return NetworkHealth.CRITICAL;
    }
    
    // Unstable conditions
    if (peerCount < 3 || packetLoss > 0.2 || stability < 0.4 || averageLatency > 2000) {
      return NetworkHealth.UNSTABLE;
    }
    
    // Degraded conditions
    if (peerCount < 5 || packetLoss > 0.1 || stability < 0.6 || averageLatency > 1000) {
      return NetworkHealth.DEGRADED;
    }
    
    // Stable conditions
    if (peerCount < 10 || packetLoss > 0.05 || stability < 0.8 || averageLatency > 500) {
      return NetworkHealth.STABLE;
    }
    
    // Optimal conditions
    return NetworkHealth.OPTIMAL;
  }
  
  /**
   * Detect network partition using hybrid strategy
   */
  detectPartition() {
    switch (this.options.detectionStrategy) {
      case DetectionStrategy.PEER_COUNT:
        return this.detectPartitionByPeerCount();
      case DetectionStrategy.CONSENSUS:
        return this.detectPartitionByConsensus();
      case DetectionStrategy.LATENCY:
        return this.detectPartitionByLatency();
      case DetectionStrategy.HYBRID:
      default:
        return this.detectPartitionHybrid();
    }
  }
  
  /**
   * Detect partition by peer count
   */
  detectPartitionByPeerCount() {
    const currentPeerCount = this.state.activePeers.size;
    const historicalAverage = this.getHistoricalAveragePeerCount();
    
    if (historicalAverage === 0) return false;
    
    const peerLossRatio = 1 - (currentPeerCount / historicalAverage);
    return peerLossRatio > this.options.peerCountThreshold;
  }
  
  /**
   * Detect partition by consensus disagreement
   */
  detectPartitionByConsensus() {
    if (!this.consensusProvider) return false;
    const heights = this.consensusProvider(); // array of block heights from peers
    if (!Array.isArray(heights) || heights.length === 0) return false;
    // Compute median height
    const sorted = [...heights].sort((a,b)=>a-b);
    const median = sorted[Math.floor(sorted.length/2)];
    // Count peers diverging beyond threshold
    const divergent = heights.filter(h => Math.abs(h - median) > this.options.consensusHeightThreshold).length;
    const ratio = divergent / heights.length;
    return ratio > this.options.consensusThreshold;
  }
  
  /**
   * Detect partition by latency
   */
  detectPartitionByLatency() {
    const { averageLatency } = this.state.networkMetrics;
    return averageLatency > this.options.latencyThreshold;
  }
  
  /**
   * Hybrid partition detection
   */
  detectPartitionHybrid() {
    const peerPartition = this.detectPartitionByPeerCount();
    const latencyPartition = this.detectPartitionByLatency();
    const consensusPartition = this.detectPartitionByConsensus();
    
    // Require at least 2 indicators for partition detection
    const indicators = [peerPartition, latencyPartition, consensusPartition];
    const positiveIndicators = indicators.filter(Boolean).length;
    
    return positiveIndicators >= 2;
  }
  
  /**
   * Handle partition detected
   */
  async handlePartitionDetected() {
    const now = Date.now();
    
    this.state.partitionDetected = true;
    this.state.lastPartitionTime = now;
    
    // Record partition event
    this.history.partitionHistory.push({
      timestamp: now,
      networkHealth: this.state.networkHealth,
      activePeers: this.state.activePeers.size,
      metrics: { ...this.state.networkMetrics }
    });
    
    this.emit('partitionDetected', {
      timestamp: now,
      networkHealth: this.state.networkHealth,
      metrics: this.state.networkMetrics
    });
    
    // Start recovery if enabled
    if (this.options.autoRecovery) {
      this.startRecoveryProcess();
    }
  }
  
  /**
   * Handle partition recovered
   */
  async handlePartitionRecovered() {
    const now = Date.now();
    const partitionDuration = now - this.state.lastPartitionTime;
    
    this.state.partitionDetected = false;
    this.state.recoveryAttempts = 0;
    
    // Record recovery event
    this.history.recoveryHistory.push({
      timestamp: now,
      partitionDuration,
      networkHealth: this.state.networkHealth,
      activePeers: this.state.activePeers.size,
      metrics: { ...this.state.networkMetrics }
    });
    
    this.emit('partitionRecovered', {
      timestamp: now,
      partitionDuration,
      networkHealth: this.state.networkHealth,
      metrics: this.state.networkMetrics
    });
  }
  
  /**
   * Start recovery process
   */
  async startRecoveryProcess() {
    if (this.state.recoveryAttempts >= this.options.maxRecoveryAttempts) {
      this.emit('recoveryFailed', {
        attempts: this.state.recoveryAttempts,
        maxAttempts: this.options.maxRecoveryAttempts
      });
      return;
    }
    
    this.state.recoveryAttempts++;
    
    this.emit('recoveryStarted', {
      attempt: this.state.recoveryAttempts,
      maxAttempts: this.options.maxRecoveryAttempts
    });
    
    try {
      // Implement recovery strategies
      await this.executeRecoveryStrategies();
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        context: 'network_recovery',
        category: ErrorCategory.NETWORK
      });
      
      // Retry after delay
      setTimeout(() => {
        this.startRecoveryProcess();
      }, 5000 * this.state.recoveryAttempts);
    }
  }
  
  /**
   * Execute recovery strategies
   */
  async executeRecoveryStrategies() {
    // Strategy 1: Reconnect to known peers
    await this.reconnectToKnownPeers();
    
    // Strategy 2: Discover new peers
    await this.discoverNewPeers();
    
    // Strategy 3: Adjust network parameters
    this.adjustNetworkParameters();
  }
  
  /**
   * Reconnect to known peers
   */
  async reconnectToKnownPeers() {
    // This would integrate with the P2P controller
    this.emit('reconnectPeers');
  }
  
  /**
   * Discover new peers
   */
  async discoverNewPeers() {
    // This would integrate with peer discovery
    this.emit('discoverPeers');
  }
  
  /**
   * Adjust network parameters
   */
  adjustNetworkParameters() {
    // Temporarily relax thresholds during recovery
    this.options.peerCountThreshold *= 0.8;
    this.options.latencyThreshold *= 1.2;
  }
  
  /**
   * Calculate network stability
   */
  calculateNetworkStability() {
    const recentHistory = this.history.healthHistory.slice(-10);
    if (recentHistory.length < 2) return 1.0;
    
    let stabilityScore = 1.0;
    
    // Penalize frequent health changes
    let healthChanges = 0;
    for (let i = 1; i < recentHistory.length; i++) {
      if (recentHistory[i].health !== recentHistory[i-1].health) {
        healthChanges++;
      }
    }
    
    stabilityScore -= (healthChanges / recentHistory.length) * 0.5;
    
    return Math.max(0, Math.min(1, stabilityScore));
  }
  
  /**
   * Calculate throughput
   */
  calculateThroughput() {
    // Simplified throughput calculation
    const activePeers = this.state.activePeers.size;
    const { averageLatency, packetLoss } = this.state.networkMetrics;
    
    if (activePeers === 0 || averageLatency === 0) return 0;
    
    const basethroughput = activePeers * 1000; // Base throughput per peer
    const latencyPenalty = Math.max(0, 1 - (averageLatency / 1000));
    const lossPenalty = Math.max(0, 1 - packetLoss);
    
    return basethroughput * latencyPenalty * lossPenalty;
  }
  
  /**
   * Get historical average peer count
   */
  getHistoricalAveragePeerCount() {
    const recentHistory = this.history.healthHistory.slice(-50);
    if (recentHistory.length === 0) return 0;
    
    const totalPeers = recentHistory.reduce((sum, entry) => {
      return sum + (entry.activePeers || 0);
    }, 0);
    
    return totalPeers / recentHistory.length;
  }
  
  /**
   * Adjust thresholds based on network behavior
   */
  adjustThresholds() {
    const { learningRate } = this.options;
    const recentPartitions = this.history.partitionHistory.slice(-10);
    
    if (recentPartitions.length > 5) {
      // Too many partitions, relax thresholds
      this.options.peerCountThreshold = Math.min(0.8, this.options.peerCountThreshold * (1 + learningRate));
      this.options.latencyThreshold = Math.min(5000, this.options.latencyThreshold * (1 + learningRate));
    } else if (recentPartitions.length === 0) {
      // No recent partitions, tighten thresholds
      this.options.peerCountThreshold = Math.max(0.1, this.options.peerCountThreshold * (1 - learningRate));
      this.options.latencyThreshold = Math.max(500, this.options.latencyThreshold * (1 - learningRate));
    }
  }
  
  /**
   * Check peer timeouts
   */
  checkPeerTimeouts() {
    const now = Date.now();
    const timeoutThreshold = this.options.peerTimeoutThreshold;
    
    for (const [peerId, lastSeen] of this.history.peerHistory) {
      if (now - lastSeen > timeoutThreshold && this.state.activePeers.has(peerId)) {
        this.removePeer(peerId);
      }
    }
  }
  
  /**
   * Add peer
   */
  addPeer(peerId, latency = 0, reliability = 1.0) {
    this.state.activePeers.add(peerId);
    this.state.peerLatencies.set(peerId, latency);
    this.state.peerReliability.set(peerId, reliability);
    this.history.peerHistory.set(peerId, Date.now());
    
    this.emit('peerAdded', { peerId, latency, reliability });
  }
  
  /**
   * Remove peer
   */
  removePeer(peerId) {
    this.state.activePeers.delete(peerId);
    this.state.peerLatencies.delete(peerId);
    this.state.peerReliability.delete(peerId);
    
    this.emit('peerRemoved', { peerId });
  }
  
  /**
   * Update peer metrics
   */
  updatePeer(peerId, latency, reliability) {
    if (this.state.activePeers.has(peerId)) {
      this.state.peerLatencies.set(peerId, latency);
      this.state.peerReliability.set(peerId, reliability);
      this.history.peerHistory.set(peerId, Date.now());
    }
  }
  
  /**
   * Get network status
   */
  getNetworkStatus() {
    return {
      health: this.state.networkHealth,
      partitionDetected: this.state.partitionDetected,
      activePeers: this.state.activePeers.size,
      metrics: { ...this.state.networkMetrics },
      recoveryAttempts: this.state.recoveryAttempts,
      lastPartitionTime: this.state.lastPartitionTime
    };
  }
  
  /**
   * Get detailed metrics
   */
  getDetailedMetrics() {
    return {
      state: { ...this.state },
      history: {
        healthHistory: this.history.healthHistory.slice(-100),
        partitionHistory: this.history.partitionHistory.slice(-50),
        recoveryHistory: this.history.recoveryHistory.slice(-50)
      },
      options: { ...this.options }
    };
  }
  
  /**
   * Get current network state
   */
  getNetworkState() {
    return this.state.partitionDetected ? 'partitioned' : 'healthy';
  }
  
  /**
   * Handle network state change
   */
  handleNetworkStateChange(newState) {
    if (newState === 'partitioned') {
      this.state.partitionDetected = true;
      this.state.lastPartitionTime = Date.now();
      this.handlePartitionDetected();
    } else if (newState === 'healthy') {
      this.state.partitionDetected = false;
      this.handlePartitionRecovered();
    }
  }
  
  /**
   * Cleanup resources
   */
  cleanup() {
    // Clear all timers
    for (const [name, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();
    
    // Clear state
    this.state.activePeers.clear();
    this.state.peerLatencies.clear();
    this.state.peerReliability.clear();
    this.history.peerHistory.clear();
    
    // Remove all listeners
    this.removeAllListeners();
  }
}

export default EnhancedNetworkResilience;
