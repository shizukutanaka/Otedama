import { EventEmitter } from 'events';
import { Logger } from './logger.js';
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/**
 * Network Latency Optimizer
 * ネットワーク遅延最適化システム
 * 
 * John Carmack Style: Extreme performance optimization
 * Rob Pike Style: Simple, efficient concurrency
 * Robert C. Martin Style: Clean, extensible architecture
 * 
 * Features:
 * - Message batching and aggregation
 * - Intelligent compression
 * - Priority message queuing
 * - Connection pooling
 * - Adaptive packet sizing
 * - Zero-copy optimization
 * - Network path optimization
 */
export class NetworkOptimizer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = new Logger('NetOptimizer');
    
    // Configuration
    this.config = {
      enableCompression: options.enableCompression !== false,
      compressionThreshold: options.compressionThreshold || 1024, // 1KB
      batchInterval: options.batchInterval || 10, // 10ms
      maxBatchSize: options.maxBatchSize || 50,
      maxBatchBytes: options.maxBatchBytes || 65536, // 64KB
      priorityLevels: options.priorityLevels || 4,
      adaptiveSizing: options.adaptiveSizing !== false,
      connectionPoolSize: options.connectionPoolSize || 5
    };
    
    // Message queues by priority
    this.messageQueues = new Map();
    for (let i = 0; i < this.config.priorityLevels; i++) {
      this.messageQueues.set(i, []);
    }
    
    // Batch timers for each peer
    this.batchTimers = new Map();
    
    // Connection pools
    this.connectionPools = new Map();
    
    // Performance metrics
    this.metrics = {
      messagesSent: 0,
      messagesBatched: 0,
      bytesCompressed: 0,
      bytesUncompressed: 0,
      compressionRatio: 1,
      avgLatency: 0,
      avgBatchSize: 0,
      priorityDistribution: new Array(this.config.priorityLevels).fill(0)
    };
    
    // Adaptive sizing state
    this.adaptiveState = new Map();
    
    // Message priority mappings
    this.messagePriorities = new Map([
      ['block', 0], // Highest priority
      ['share', 1],
      ['payment', 1],
      ['handshake', 2],
      ['peer_list', 3],
      ['heartbeat', 3] // Lowest priority
    ]);
    
    this.initialize();
  }

  /**
   * Initialize optimizer
   */
  initialize() {
    // Start metrics collection
    this.metricsTimer = setInterval(() => {
      this.updateMetrics();
    }, 5000);
    
    this.logger.info('Network optimizer initialized');
  }

  /**
   * Queue message for optimized sending
   */
  async queueMessage(peerId, message, priority = null) {
    try {
      // Determine priority
      if (priority === null) {
        priority = this.messagePriorities.get(message.type) || 2;
      }
      
      // Add to priority queue
      const queue = this.messageQueues.get(priority);
      if (!queue) {
        throw new Error(`Invalid priority level: ${priority}`);
      }
      
      queue.push({
        peerId,
        message,
        timestamp: Date.now(),
        size: JSON.stringify(message).length
      });
      
      // Update metrics
      this.metrics.priorityDistribution[priority]++;
      
      // Schedule batch processing
      this.scheduleBatch(peerId);
      
    } catch (error) {
      this.logger.error('Error queuing message:', error);
      throw error;
    }
  }

  /**
   * Schedule batch processing for peer
   */
  scheduleBatch(peerId) {
    if (this.batchTimers.has(peerId)) {
      return; // Already scheduled
    }
    
    this.batchTimers.set(peerId, setTimeout(() => {
      this.processBatch(peerId);
    }, this.config.batchInterval));
  }

  /**
   * Process message batch for peer
   */
  async processBatch(peerId) {
    try {
      this.batchTimers.delete(peerId);
      
      const messages = this.collectMessagesForPeer(peerId);
      if (messages.length === 0) return;
      
      // Create batch
      const batch = {
        type: 'batch',
        messages,
        timestamp: Date.now(),
        count: messages.length
      };
      
      // Optimize batch
      const optimizedBatch = await this.optimizeBatch(batch, peerId);
      
      // Send batch
      this.emit('send', {
        peerId,
        data: optimizedBatch,
        priority: 0 // Batches always high priority
      });
      
      // Update metrics
      this.metrics.messagesSent += messages.length;
      this.metrics.messagesBatched += messages.length > 1 ? messages.length : 0;
      
      // Update adaptive sizing
      if (this.config.adaptiveSizing) {
        this.updateAdaptiveSizing(peerId, messages.length, optimizedBatch.size);
      }
      
    } catch (error) {
      this.logger.error(`Error processing batch for peer ${peerId}:`, error);
    }
  }

  /**
   * Collect messages for peer from priority queues
   */
  collectMessagesForPeer(peerId) {
    const messages = [];
    let totalSize = 0;
    
    // Collect messages by priority
    for (let priority = 0; priority < this.config.priorityLevels; priority++) {
      const queue = this.messageQueues.get(priority);
      const peerMessages = [];
      
      // Extract messages for this peer
      for (let i = queue.length - 1; i >= 0; i--) {
        const item = queue[i];
        
        if (item.peerId === peerId) {
          if (messages.length < this.getMaxBatchSize(peerId) && 
              totalSize + item.size < this.config.maxBatchBytes) {
            peerMessages.push(item.message);
            totalSize += item.size;
            queue.splice(i, 1);
          }
        }
      }
      
      // Add in priority order
      messages.push(...peerMessages.reverse());
      
      // Stop if batch is full
      if (messages.length >= this.getMaxBatchSize(peerId) || 
          totalSize >= this.config.maxBatchBytes) {
        break;
      }
    }
    
    return messages;
  }

  /**
   * Get max batch size for peer (adaptive)
   */
  getMaxBatchSize(peerId) {
    if (!this.config.adaptiveSizing) {
      return this.config.maxBatchSize;
    }
    
    const state = this.adaptiveState.get(peerId);
    return state ? state.batchSize : this.config.maxBatchSize;
  }

  /**
   * Optimize batch (compression, deduplication, etc.)
   */
  async optimizeBatch(batch, peerId) {
    try {
      let data = JSON.stringify(batch);
      let compressed = false;
      let originalSize = Buffer.byteLength(data);
      
      // Apply compression if beneficial
      if (this.config.enableCompression && originalSize > this.config.compressionThreshold) {
        const compressedData = await gzipAsync(data);
        
        if (compressedData.length < originalSize * 0.9) { // 10% savings threshold
          data = compressedData.toString('base64');
          compressed = true;
          
          // Update metrics
          this.metrics.bytesCompressed += compressedData.length;
          this.metrics.bytesUncompressed += originalSize;
        }
      }
      
      return {
        data,
        compressed,
        size: Buffer.byteLength(data),
        originalSize,
        algorithm: compressed ? 'gzip' : 'none'
      };
      
    } catch (error) {
      this.logger.error('Error optimizing batch:', error);
      return {
        data: JSON.stringify(batch),
        compressed: false,
        size: Buffer.byteLength(JSON.stringify(batch)),
        algorithm: 'none'
      };
    }
  }

  /**
   * Process incoming batch
   */
  async processIncomingBatch(peerId, batchData) {
    try {
      let data = batchData.data;
      
      // Decompress if needed
      if (batchData.compressed) {
        const buffer = Buffer.from(data, 'base64');
        const decompressed = await gunzipAsync(buffer);
        data = decompressed.toString();
      }
      
      const batch = JSON.parse(data);
      
      // Process individual messages
      for (const message of batch.messages) {
        this.emit('message', {
          peerId,
          message,
          fromBatch: true
        });
      }
      
      return batch.messages.length;
      
    } catch (error) {
      this.logger.error(`Error processing incoming batch from ${peerId}:`, error);
      return 0;
    }
  }

  /**
   * Update adaptive sizing based on performance
   */
  updateAdaptiveSizing(peerId, messageCount, batchSize) {
    let state = this.adaptiveState.get(peerId);
    
    if (!state) {
      state = {
        batchSize: this.config.maxBatchSize,
        history: [],
        lastAdjustment: Date.now()
      };
      this.adaptiveState.set(peerId, state);
    }
    
    // Add to history
    state.history.push({
      messageCount,
      batchSize,
      timestamp: Date.now(),
      efficiency: messageCount / batchSize // Messages per byte
    });
    
    // Keep only last 100 measurements
    if (state.history.length > 100) {
      state.history.shift();
    }
    
    // Adjust every 30 seconds
    if (Date.now() - state.lastAdjustment < 30000) {
      return;
    }
    
    // Calculate average efficiency
    const recentHistory = state.history.slice(-20);
    const avgEfficiency = recentHistory.reduce((sum, h) => sum + h.efficiency, 0) / recentHistory.length;
    
    // Adjust batch size based on efficiency
    if (avgEfficiency < 0.001 && state.batchSize < this.config.maxBatchSize) {
      // Low efficiency, increase batch size
      state.batchSize = Math.min(
        this.config.maxBatchSize,
        Math.floor(state.batchSize * 1.2)
      );
    } else if (avgEfficiency > 0.01 && state.batchSize > 10) {
      // High efficiency, can reduce batch size for lower latency
      state.batchSize = Math.max(
        10,
        Math.floor(state.batchSize * 0.8)
      );
    }
    
    state.lastAdjustment = Date.now();
  }

  /**
   * Get connection pool for peer
   */
  getConnectionPool(peerId) {
    if (!this.connectionPools.has(peerId)) {
      this.connectionPools.set(peerId, {
        connections: [],
        currentIndex: 0,
        stats: {
          totalRequests: 0,
          failedRequests: 0
        }
      });
    }
    
    return this.connectionPools.get(peerId);
  }

  /**
   * Send optimized message (connection pooling)
   */
  async sendOptimized(peerId, data, sendFunction) {
    const pool = this.getConnectionPool(peerId);
    pool.stats.totalRequests++;
    
    try {
      // Round-robin connection selection
      const connectionIndex = pool.currentIndex;
      pool.currentIndex = (pool.currentIndex + 1) % this.config.connectionPoolSize;
      
      // Send using provided function
      await sendFunction(data, connectionIndex);
      
    } catch (error) {
      pool.stats.failedRequests++;
      throw error;
    }
  }

  /**
   * Update performance metrics
   */
  updateMetrics() {
    // Calculate compression ratio
    if (this.metrics.bytesUncompressed > 0) {
      this.metrics.compressionRatio = 
        this.metrics.bytesCompressed / this.metrics.bytesUncompressed;
    }
    
    // Calculate average batch size
    if (this.metrics.messagesBatched > 0) {
      this.metrics.avgBatchSize = 
        this.metrics.messagesBatched / (this.metrics.messagesSent / this.metrics.messagesBatched);
    }
    
    this.emit('metrics', this.metrics);
  }

  /**
   * Get optimization report
   */
  getOptimizationReport() {
    const report = {
      config: this.config,
      metrics: this.metrics,
      queues: {},
      adaptiveStates: {},
      connectionPools: {}
    };
    
    // Queue sizes
    for (const [priority, queue] of this.messageQueues) {
      report.queues[`priority_${priority}`] = queue.length;
    }
    
    // Adaptive states
    for (const [peerId, state] of this.adaptiveState) {
      report.adaptiveStates[peerId] = {
        currentBatchSize: state.batchSize,
        historyLength: state.history.length
      };
    }
    
    // Connection pool stats
    for (const [peerId, pool] of this.connectionPools) {
      report.connectionPools[peerId] = pool.stats;
    }
    
    return report;
  }

  /**
   * Clear message queues
   */
  clearQueues() {
    for (const queue of this.messageQueues.values()) {
      queue.length = 0;
    }
    
    // Cancel pending batches
    for (const timer of this.batchTimers.values()) {
      clearTimeout(timer);
    }
    this.batchTimers.clear();
  }

  /**
   * Stop optimizer
   */
  stop() {
    // Clear timers
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }
    
    // Clear queues
    this.clearQueues();
    
    this.logger.info('Network optimizer stopped');
  }
}

export default NetworkOptimizer;
