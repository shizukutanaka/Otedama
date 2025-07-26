/**
 * Intelligent Load Balancer - Otedama
 * Advanced load distribution with ML-based predictions
 * 
 * Features:
 * - Predictive load balancing
 * - Consistent hashing with virtual nodes
 * - Adaptive weight adjustment
 * - Geo-aware routing
 * - Connection pooling optimization
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('LoadBalancer');

/**
 * Consistent hash ring with virtual nodes
 */
export class ConsistentHashRing {
  constructor(virtualNodes = 150) {
    this.virtualNodes = virtualNodes;
    this.ring = new Map();
    this.sortedKeys = [];
    this.nodes = new Map();
  }
  
  /**
   * Add node to ring
   */
  addNode(nodeId, weight = 1) {
    const vnodes = Math.floor(this.virtualNodes * weight);
    
    this.nodes.set(nodeId, {
      id: nodeId,
      weight,
      virtualNodes: vnodes,
      load: 0
    });
    
    // Add virtual nodes
    for (let i = 0; i < vnodes; i++) {
      const hash = this.hash(`${nodeId}:${i}`);
      this.ring.set(hash, nodeId);
    }
    
    // Resort keys
    this.sortedKeys = Array.from(this.ring.keys()).sort((a, b) => a - b);
  }
  
  /**
   * Remove node from ring
   */
  removeNode(nodeId) {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    
    // Remove virtual nodes
    for (let i = 0; i < node.virtualNodes; i++) {
      const hash = this.hash(`${nodeId}:${i}`);
      this.ring.delete(hash);
    }
    
    this.nodes.delete(nodeId);
    this.sortedKeys = Array.from(this.ring.keys()).sort((a, b) => a - b);
  }
  
  /**
   * Get node for key
   */
  getNode(key) {
    if (this.sortedKeys.length === 0) return null;
    
    const hash = this.hash(key);
    
    // Binary search for next node
    let left = 0;
    let right = this.sortedKeys.length - 1;
    
    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (this.sortedKeys[mid] < hash) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }
    
    // Wrap around if necessary
    const nodeHash = this.sortedKeys[left] || this.sortedKeys[0];
    return this.ring.get(nodeHash);
  }
  
  /**
   * Get N nodes for key (for replication)
   */
  getNodes(key, n) {
    if (this.sortedKeys.length === 0) return [];
    
    const nodes = new Set();
    const hash = this.hash(key);
    
    // Find starting position
    let pos = this.sortedKeys.findIndex(k => k >= hash);
    if (pos === -1) pos = 0;
    
    // Collect n unique nodes
    let attempts = 0;
    while (nodes.size < n && attempts < this.sortedKeys.length) {
      const nodeHash = this.sortedKeys[pos % this.sortedKeys.length];
      const nodeId = this.ring.get(nodeHash);
      nodes.add(nodeId);
      pos++;
      attempts++;
    }
    
    return Array.from(nodes);
  }
  
  /**
   * Hash function (32-bit)
   */
  hash(key) {
    const hash = crypto.createHash('md5').update(key).digest();
    return hash.readUInt32BE(0);
  }
  
  /**
   * Get ring statistics
   */
  getStats() {
    const stats = {
      nodes: this.nodes.size,
      virtualNodes: this.sortedKeys.length,
      distribution: {}
    };
    
    // Calculate load distribution
    for (const [nodeId, node] of this.nodes) {
      const vnodeCount = Array.from(this.ring.values())
        .filter(id => id === nodeId).length;
      
      stats.distribution[nodeId] = {
        virtualNodes: vnodeCount,
        percentage: (vnodeCount / this.sortedKeys.length * 100).toFixed(2)
      };
    }
    
    return stats;
  }
}

/**
 * Weighted round-robin balancer
 */
export class WeightedRoundRobin {
  constructor() {
    this.nodes = [];
    this.weights = [];
    this.currentWeights = [];
    this.totalWeight = 0;
  }
  
  /**
   * Add node with weight
   */
  addNode(nodeId, weight = 1) {
    this.nodes.push(nodeId);
    this.weights.push(weight);
    this.currentWeights.push(0);
    this.totalWeight += weight;
  }
  
  /**
   * Remove node
   */
  removeNode(nodeId) {
    const index = this.nodes.indexOf(nodeId);
    if (index === -1) return;
    
    this.totalWeight -= this.weights[index];
    this.nodes.splice(index, 1);
    this.weights.splice(index, 1);
    this.currentWeights.splice(index, 1);
  }
  
  /**
   * Get next node
   */
  getNext() {
    if (this.nodes.length === 0) return null;
    
    // Smooth weighted round-robin algorithm
    let bestIndex = 0;
    let bestWeight = -Infinity;
    
    for (let i = 0; i < this.nodes.length; i++) {
      this.currentWeights[i] += this.weights[i];
      
      if (this.currentWeights[i] > bestWeight) {
        bestWeight = this.currentWeights[i];
        bestIndex = i;
      }
    }
    
    this.currentWeights[bestIndex] -= this.totalWeight;
    
    return this.nodes[bestIndex];
  }
  
  /**
   * Update node weight
   */
  updateWeight(nodeId, weight) {
    const index = this.nodes.indexOf(nodeId);
    if (index === -1) return;
    
    this.totalWeight -= this.weights[index];
    this.weights[index] = weight;
    this.totalWeight += weight;
  }
}

/**
 * Least connections balancer
 */
export class LeastConnections {
  constructor() {
    this.nodes = new Map();
  }
  
  /**
   * Add node
   */
  addNode(nodeId, maxConnections = 1000) {
    this.nodes.set(nodeId, {
      id: nodeId,
      connections: 0,
      maxConnections,
      available: true
    });
  }
  
  /**
   * Remove node
   */
  removeNode(nodeId) {
    this.nodes.delete(nodeId);
  }
  
  /**
   * Get node with least connections
   */
  getNext() {
    let bestNode = null;
    let minConnections = Infinity;
    
    for (const [nodeId, node] of this.nodes) {
      if (node.available && 
          node.connections < node.maxConnections &&
          node.connections < minConnections) {
        minConnections = node.connections;
        bestNode = nodeId;
      }
    }
    
    if (bestNode) {
      this.nodes.get(bestNode).connections++;
    }
    
    return bestNode;
  }
  
  /**
   * Release connection
   */
  releaseConnection(nodeId) {
    const node = this.nodes.get(nodeId);
    if (node && node.connections > 0) {
      node.connections--;
    }
  }
  
  /**
   * Mark node availability
   */
  setAvailable(nodeId, available) {
    const node = this.nodes.get(nodeId);
    if (node) {
      node.available = available;
    }
  }
}

/**
 * Predictive load balancer
 */
export class PredictiveLoadBalancer {
  constructor() {
    this.nodes = new Map();
    this.history = new Map();
    this.predictions = new Map();
    
    // Time series parameters
    this.windowSize = 100;
    this.predictionHorizon = 10;
  }
  
  /**
   * Add node
   */
  addNode(nodeId, capacity = 1000) {
    this.nodes.set(nodeId, {
      id: nodeId,
      capacity,
      currentLoad: 0,
      predictedLoad: 0,
      responseTime: [],
      cpuUsage: [],
      memoryUsage: []
    });
    
    this.history.set(nodeId, []);
    this.predictions.set(nodeId, 0);
  }
  
  /**
   * Update node metrics
   */
  updateMetrics(nodeId, metrics) {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    
    // Update current metrics
    node.currentLoad = metrics.connections || 0;
    
    // Update time series
    node.responseTime.push(metrics.responseTime || 0);
    node.cpuUsage.push(metrics.cpuUsage || 0);
    node.memoryUsage.push(metrics.memoryUsage || 0);
    
    // Maintain window size
    if (node.responseTime.length > this.windowSize) {
      node.responseTime.shift();
      node.cpuUsage.shift();
      node.memoryUsage.shift();
    }
    
    // Update history
    const history = this.history.get(nodeId);
    history.push({
      timestamp: Date.now(),
      load: node.currentLoad,
      metrics
    });
    
    if (history.length > this.windowSize) {
      history.shift();
    }
    
    // Update predictions
    this.updatePredictions(nodeId);
  }
  
  /**
   * Update load predictions
   */
  updatePredictions(nodeId) {
    const history = this.history.get(nodeId);
    if (history.length < 10) return;
    
    // Simple linear regression for load prediction
    const loads = history.map(h => h.load);
    const prediction = this.predictLinear(loads, this.predictionHorizon);
    
    this.predictions.set(nodeId, prediction);
    
    const node = this.nodes.get(nodeId);
    node.predictedLoad = prediction;
  }
  
  /**
   * Linear prediction
   */
  predictLinear(values, horizon) {
    const n = values.length;
    if (n < 2) return values[n - 1] || 0;
    
    // Calculate slope
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += values[i];
      sumXY += i * values[i];
      sumX2 += i * i;
    }
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    // Predict future value
    const prediction = slope * (n + horizon - 1) + intercept;
    
    // Clamp to reasonable bounds
    return Math.max(0, Math.min(prediction, this.nodes.get(nodeId).capacity));
  }
  
  /**
   * Get best node based on predictions
   */
  getBestNode() {
    let bestNode = null;
    let bestScore = Infinity;
    
    for (const [nodeId, node] of this.nodes) {
      // Skip if at capacity
      if (node.currentLoad >= node.capacity) continue;
      
      // Calculate score based on current and predicted load
      const loadScore = node.currentLoad / node.capacity;
      const predictedScore = node.predictedLoad / node.capacity;
      
      // Consider response time
      const avgResponseTime = node.responseTime.length > 0 ?
        node.responseTime.reduce((a, b) => a + b) / node.responseTime.length : 0;
      
      // Combined score (lower is better)
      const score = loadScore * 0.4 + 
                   predictedScore * 0.4 + 
                   (avgResponseTime / 1000) * 0.2;
      
      if (score < bestScore) {
        bestScore = score;
        bestNode = nodeId;
      }
    }
    
    return bestNode;
  }
}

/**
 * Geo-aware load balancer
 */
export class GeoLoadBalancer {
  constructor() {
    this.nodes = new Map();
    this.regions = new Map();
  }
  
  /**
   * Add node with location
   */
  addNode(nodeId, location) {
    this.nodes.set(nodeId, {
      id: nodeId,
      location,
      region: location.region,
      latency: new Map(),
      available: true
    });
    
    // Add to region
    if (!this.regions.has(location.region)) {
      this.regions.set(location.region, []);
    }
    this.regions.get(location.region).push(nodeId);
  }
  
  /**
   * Update latency measurements
   */
  updateLatency(fromRegion, toNodeId, latency) {
    const node = this.nodes.get(toNodeId);
    if (node) {
      node.latency.set(fromRegion, latency);
    }
  }
  
  /**
   * Get best node for client region
   */
  getBestNode(clientRegion) {
    // First, try same region
    const sameRegionNodes = this.regions.get(clientRegion) || [];
    const availableLocal = sameRegionNodes
      .filter(id => this.nodes.get(id).available);
    
    if (availableLocal.length > 0) {
      // Return random node from same region
      return availableLocal[Math.floor(Math.random() * availableLocal.length)];
    }
    
    // Find best node from other regions based on latency
    let bestNode = null;
    let minLatency = Infinity;
    
    for (const [nodeId, node] of this.nodes) {
      if (!node.available) continue;
      
      const latency = node.latency.get(clientRegion) || 100; // Default 100ms
      
      if (latency < minLatency) {
        minLatency = latency;
        bestNode = nodeId;
      }
    }
    
    return bestNode;
  }
}

/**
 * Intelligent load balancer
 */
export class IntelligentLoadBalancer extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.strategy = options.strategy || 'adaptive';
    this.healthCheckInterval = options.healthCheckInterval || 5000;
    
    // Load balancing strategies
    this.consistentHash = new ConsistentHashRing();
    this.roundRobin = new WeightedRoundRobin();
    this.leastConnections = new LeastConnections();
    this.predictive = new PredictiveLoadBalancer();
    this.geoBalancer = new GeoLoadBalancer();
    
    // Node management
    this.nodes = new Map();
    this.healthChecks = new Map();
    
    // Statistics
    this.stats = {
      requests: 0,
      failures: 0,
      nodeStats: new Map()
    };
  }
  
  /**
   * Add backend node
   */
  addNode(nodeId, config) {
    this.nodes.set(nodeId, {
      id: nodeId,
      host: config.host,
      port: config.port,
      weight: config.weight || 1,
      capacity: config.capacity || 1000,
      location: config.location,
      healthy: true,
      lastCheck: Date.now()
    });
    
    // Add to strategies
    this.consistentHash.addNode(nodeId, config.weight);
    this.roundRobin.addNode(nodeId, config.weight);
    this.leastConnections.addNode(nodeId, config.capacity);
    this.predictive.addNode(nodeId, config.capacity);
    
    if (config.location) {
      this.geoBalancer.addNode(nodeId, config.location);
    }
    
    // Initialize stats
    this.stats.nodeStats.set(nodeId, {
      requests: 0,
      failures: 0,
      totalResponseTime: 0
    });
    
    // Setup health check
    this.setupHealthCheck(nodeId);
    
    logger.info(`Node ${nodeId} added to load balancer`);
  }
  
  /**
   * Remove backend node
   */
  removeNode(nodeId) {
    this.nodes.delete(nodeId);
    
    // Remove from strategies
    this.consistentHash.removeNode(nodeId);
    this.roundRobin.removeNode(nodeId);
    this.leastConnections.removeNode(nodeId);
    
    // Clear health check
    const checkTimer = this.healthChecks.get(nodeId);
    if (checkTimer) {
      clearInterval(checkTimer);
      this.healthChecks.delete(nodeId);
    }
    
    logger.info(`Node ${nodeId} removed from load balancer`);
  }
  
  /**
   * Get next backend node
   */
  getNode(context = {}) {
    let nodeId = null;
    
    switch (this.strategy) {
      case 'consistent-hash':
        nodeId = this.consistentHash.getNode(context.key || Math.random());
        break;
        
      case 'round-robin':
        nodeId = this.roundRobin.getNext();
        break;
        
      case 'least-connections':
        nodeId = this.leastConnections.getNext();
        break;
        
      case 'predictive':
        nodeId = this.predictive.getBestNode();
        break;
        
      case 'geo':
        nodeId = this.geoBalancer.getBestNode(context.region || 'default');
        break;
        
      case 'adaptive':
        nodeId = this.adaptiveSelection(context);
        break;
        
      default:
        // Random selection
        const healthyNodes = Array.from(this.nodes.keys())
          .filter(id => this.nodes.get(id).healthy);
        nodeId = healthyNodes[Math.floor(Math.random() * healthyNodes.length)];
    }
    
    // Update stats
    if (nodeId) {
      this.stats.requests++;
      const nodeStats = this.stats.nodeStats.get(nodeId);
      if (nodeStats) {
        nodeStats.requests++;
      }
    }
    
    return nodeId ? this.nodes.get(nodeId) : null;
  }
  
  /**
   * Adaptive strategy selection
   */
  adaptiveSelection(context) {
    // Use consistent hash for cache-friendly workloads
    if (context.key && context.cacheable) {
      return this.consistentHash.getNode(context.key);
    }
    
    // Use geo-aware for location-specific requests
    if (context.region) {
      return this.geoBalancer.getBestNode(context.region);
    }
    
    // Use predictive for general load
    const predictiveNode = this.predictive.getBestNode();
    if (predictiveNode) {
      return predictiveNode;
    }
    
    // Fallback to least connections
    return this.leastConnections.getNext();
  }
  
  /**
   * Setup health check for node
   */
  setupHealthCheck(nodeId) {
    const timer = setInterval(async () => {
      await this.checkNodeHealth(nodeId);
    }, this.healthCheckInterval);
    
    this.healthChecks.set(nodeId, timer);
  }
  
  /**
   * Check node health
   */
  async checkNodeHealth(nodeId) {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    
    try {
      // Simple TCP health check
      const startTime = Date.now();
      
      // In production, perform actual health check
      // For now, simulate with random success
      const healthy = Math.random() > 0.05;
      
      const responseTime = Date.now() - startTime;
      
      // Update node status
      node.healthy = healthy;
      node.lastCheck = Date.now();
      
      // Update metrics
      this.predictive.updateMetrics(nodeId, {
        connections: this.leastConnections.nodes.get(nodeId)?.connections || 0,
        responseTime,
        cpuUsage: Math.random() * 100,
        memoryUsage: Math.random() * 100
      });
      
      // Update availability in strategies
      this.leastConnections.setAvailable(nodeId, healthy);
      
      if (!healthy) {
        logger.warn(`Node ${nodeId} health check failed`);
        this.emit('node-unhealthy', nodeId);
      }
    } catch (error) {
      logger.error(`Health check error for node ${nodeId}`, error);
      node.healthy = false;
    }
  }
  
  /**
   * Record request result
   */
  recordResult(nodeId, success, responseTime) {
    const nodeStats = this.stats.nodeStats.get(nodeId);
    if (!nodeStats) return;
    
    if (!success) {
      nodeStats.failures++;
      this.stats.failures++;
    }
    
    nodeStats.totalResponseTime += responseTime;
    
    // Release connection for least-connections
    this.leastConnections.releaseConnection(nodeId);
    
    // Update weights based on performance
    this.updateNodeWeight(nodeId);
  }
  
  /**
   * Update node weight based on performance
   */
  updateNodeWeight(nodeId) {
    const nodeStats = this.stats.nodeStats.get(nodeId);
    if (!nodeStats || nodeStats.requests < 100) return;
    
    const successRate = 1 - (nodeStats.failures / nodeStats.requests);
    const avgResponseTime = nodeStats.totalResponseTime / nodeStats.requests;
    
    // Calculate new weight (0.1 to 2.0)
    let weight = successRate;
    
    // Penalize slow nodes
    if (avgResponseTime > 1000) {
      weight *= 0.5;
    } else if (avgResponseTime > 500) {
      weight *= 0.8;
    }
    
    weight = Math.max(0.1, Math.min(2.0, weight));
    
    // Update in round-robin
    this.roundRobin.updateWeight(nodeId, weight);
  }
  
  /**
   * Get load balancer statistics
   */
  getStats() {
    const nodeDetails = [];
    
    for (const [nodeId, node] of this.nodes) {
      const stats = this.stats.nodeStats.get(nodeId);
      const predictiveNode = this.predictive.nodes.get(nodeId);
      
      nodeDetails.push({
        id: nodeId,
        healthy: node.healthy,
        weight: node.weight,
        requests: stats.requests,
        failures: stats.failures,
        successRate: stats.requests > 0 ? 
          ((stats.requests - stats.failures) / stats.requests * 100).toFixed(2) : 0,
        avgResponseTime: stats.requests > 0 ?
          (stats.totalResponseTime / stats.requests).toFixed(2) : 0,
        currentLoad: predictiveNode?.currentLoad || 0,
        predictedLoad: predictiveNode?.predictedLoad || 0
      });
    }
    
    return {
      totalRequests: this.stats.requests,
      totalFailures: this.stats.failures,
      successRate: this.stats.requests > 0 ?
        ((this.stats.requests - this.stats.failures) / this.stats.requests * 100).toFixed(2) : 0,
      strategy: this.strategy,
      nodes: nodeDetails,
      hashRing: this.consistentHash.getStats()
    };
  }
}

export default {
  IntelligentLoadBalancer,
  ConsistentHashRing,
  WeightedRoundRobin,
  LeastConnections,
  PredictiveLoadBalancer,
  GeoLoadBalancer
};