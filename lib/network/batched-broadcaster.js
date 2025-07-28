/**
 * Batched Message Broadcasting with Compression
 * Optimizes network throughput by batching and compressing messages
 */

import zlib from 'zlib';
import { createStructuredLogger } from '../core/structured-logger.js';
import { EventEmitter } from 'events';

const logger = createStructuredLogger('BatchedBroadcaster');

export class BatchedBroadcaster extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      batchSize: options.batchSize || 100,
      flushInterval: options.flushInterval || 10, // ms
      compressionThreshold: options.compressionThreshold || 1024, // bytes
      maxBatchBytes: options.maxBatchBytes || 65536, // 64KB
      enableCompression: options.enableCompression !== false
    };
    
    // Message batches per connection
    this.batches = new Map();
    this.batchSizes = new Map(); // Track batch sizes in bytes
    
    // Connections map
    this.connections = new Map();
    
    // Statistics
    this.stats = {
      messagesSent: 0,
      batchesSent: 0,
      bytesOriginal: 0,
      bytesCompressed: 0,
      compressionRatio: 0
    };
    
    // Flush timer
    this.flushTimer = null;
    this.isRunning = false;
  }

  start() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    this.startBatchTimer();
    
    logger.info('Batched broadcaster started', this.config);
  }

  stop() {
    if (!this.isRunning) return;
    
    this.isRunning = false;
    
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    
    // Flush all pending batches
    this.flushAll();
    
    logger.info('Batched broadcaster stopped');
  }

  addConnection(id, connection) {
    this.connections.set(id, connection);
    this.batches.set(id, []);
    this.batchSizes.set(id, 0);
    
    // Setup connection event handlers
    connection.on('close', () => {
      this.removeConnection(id);
    });
    
    connection.on('error', (error) => {
      logger.error(`Connection ${id} error:`, error);
      this.removeConnection(id);
    });
  }

  removeConnection(id) {
    // Flush any pending messages
    if (this.batches.has(id)) {
      this.flush(id);
    }
    
    this.connections.delete(id);
    this.batches.delete(id);
    this.batchSizes.delete(id);
  }

  broadcast(message, options = {}) {
    if (!this.isRunning) {
      logger.warn('Broadcaster not running, message dropped');
      return;
    }
    
    const serialized = this.serializeMessage(message);
    const messageSize = Buffer.byteLength(serialized);
    
    for (const [id, connection] of this.connections) {
      // Skip specific connections if excluded
      if (options.exclude && options.exclude.includes(id)) {
        continue;
      }
      
      // Add to batch
      this.addToBatch(id, serialized, messageSize);
    }
  }

  unicast(connectionId, message) {
    if (!this.connections.has(connectionId)) {
      logger.warn(`Connection ${connectionId} not found`);
      return;
    }
    
    const serialized = this.serializeMessage(message);
    const messageSize = Buffer.byteLength(serialized);
    
    this.addToBatch(connectionId, serialized, messageSize);
  }

  multicast(connectionIds, message) {
    const serialized = this.serializeMessage(message);
    const messageSize = Buffer.byteLength(serialized);
    
    for (const id of connectionIds) {
      if (this.connections.has(id)) {
        this.addToBatch(id, serialized, messageSize);
      }
    }
  }

  addToBatch(connectionId, message, messageSize) {
    const batch = this.batches.get(connectionId);
    if (!batch) return;
    
    const currentSize = this.batchSizes.get(connectionId) || 0;
    
    // Check if adding this message would exceed max batch size
    if (currentSize + messageSize > this.config.maxBatchBytes) {
      this.flush(connectionId);
    }
    
    batch.push(message);
    this.batchSizes.set(connectionId, currentSize + messageSize);
    
    // Check if batch is full
    if (batch.length >= this.config.batchSize) {
      this.flush(connectionId);
    }
  }

  startBatchTimer() {
    this.flushTimer = setInterval(() => {
      this.flushAll();
    }, this.config.flushInterval);
  }

  flushAll() {
    for (const [id] of this.batches) {
      this.flush(id);
    }
  }

  flush(connectionId) {
    const batch = this.batches.get(connectionId);
    const connection = this.connections.get(connectionId);
    
    if (!batch || batch.length === 0 || !connection) {
      return;
    }
    
    try {
      const batchSize = this.batchSizes.get(connectionId) || 0;
      
      // Create batch message
      const batchMessage = {
        type: 'batch',
        messages: batch,
        count: batch.length,
        timestamp: Date.now()
      };
      
      const serialized = JSON.stringify(batchMessage);
      const originalSize = Buffer.byteLength(serialized);
      
      // Compress if beneficial
      let payload = serialized;
      let isCompressed = false;
      
      if (this.config.enableCompression && originalSize > this.config.compressionThreshold) {
        const compressed = zlib.deflateSync(serialized);
        
        if (compressed.length < originalSize * 0.9) { // Only use if >10% savings
          payload = compressed;
          isCompressed = true;
        }
      }
      
      // Send batch with compression flag
      const frame = {
        compressed: isCompressed,
        payload: isCompressed ? payload.toString('base64') : payload
      };
      
      connection.send(JSON.stringify(frame));
      
      // Update statistics
      this.stats.messagesSent += batch.length;
      this.stats.batchesSent++;
      this.stats.bytesOriginal += originalSize;
      this.stats.bytesCompressed += Buffer.byteLength(JSON.stringify(frame));
      this.updateCompressionRatio();
      
      // Clear batch
      this.batches.set(connectionId, []);
      this.batchSizes.set(connectionId, 0);
      
      // Emit event
      this.emit('batch:sent', {
        connectionId,
        messageCount: batch.length,
        originalSize,
        compressedSize: payload.length,
        compressed: isCompressed
      });
      
    } catch (error) {
      logger.error(`Failed to flush batch for ${connectionId}:`, error);
      
      // Clear batch to prevent memory leak
      this.batches.set(connectionId, []);
      this.batchSizes.set(connectionId, 0);
    }
  }

  serializeMessage(message) {
    if (typeof message === 'string') {
      return message;
    }
    
    return JSON.stringify(message);
  }

  updateCompressionRatio() {
    if (this.stats.bytesOriginal > 0) {
      this.stats.compressionRatio = 1 - (this.stats.bytesCompressed / this.stats.bytesOriginal);
    }
  }

  getStats() {
    return {
      ...this.stats,
      activeConnections: this.connections.size,
      pendingBatches: Array.from(this.batches.values())
        .reduce((sum, batch) => sum + batch.length, 0),
      avgBatchSize: this.stats.batchesSent > 0 
        ? this.stats.messagesSent / this.stats.batchesSent 
        : 0
    };
  }

  // Helper method to decode messages on client side
  static decodeFrame(frame) {
    try {
      const parsed = JSON.parse(frame);
      
      if (!parsed.compressed) {
        return JSON.parse(parsed.payload);
      }
      
      // Decompress
      const compressed = Buffer.from(parsed.payload, 'base64');
      const decompressed = zlib.inflateSync(compressed);
      return JSON.parse(decompressed.toString());
      
    } catch (error) {
      logger.error('Failed to decode frame:', error);
      return null;
    }
  }
}

/**
 * Message priority queue for important messages
 */
export class PriorityBatchedBroadcaster extends BatchedBroadcaster {
  constructor(options = {}) {
    super(options);
    
    // Priority levels
    this.priorities = {
      critical: 0,
      high: 1,
      normal: 2,
      low: 3
    };
    
    // Priority queues per connection
    this.priorityQueues = new Map();
  }

  addConnection(id, connection) {
    super.addConnection(id, connection);
    
    // Initialize priority queues
    this.priorityQueues.set(id, {
      critical: [],
      high: [],
      normal: [],
      low: []
    });
  }

  removeConnection(id) {
    super.removeConnection(id);
    this.priorityQueues.delete(id);
  }

  broadcast(message, options = {}) {
    const priority = options.priority || 'normal';
    
    if (!this.priorities.hasOwnProperty(priority)) {
      logger.warn(`Invalid priority: ${priority}, using normal`);
      options.priority = 'normal';
    }
    
    // Critical messages bypass batching
    if (priority === 'critical') {
      this.broadcastImmediate(message, options);
      return;
    }
    
    super.broadcast(message, options);
  }

  broadcastImmediate(message, options = {}) {
    const serialized = this.serializeMessage(message);
    
    for (const [id, connection] of this.connections) {
      if (options.exclude && options.exclude.includes(id)) {
        continue;
      }
      
      try {
        connection.send(serialized);
        this.stats.messagesSent++;
      } catch (error) {
        logger.error(`Failed to send immediate message to ${id}:`, error);
      }
    }
  }

  flush(connectionId) {
    const queues = this.priorityQueues.get(connectionId);
    if (!queues) {
      super.flush(connectionId);
      return;
    }
    
    // Merge priority queues in order
    const batch = this.batches.get(connectionId) || [];
    const priorityBatch = [
      ...queues.critical,
      ...queues.high,
      ...batch, // Normal priority
      ...queues.low
    ];
    
    // Temporarily replace batch
    this.batches.set(connectionId, priorityBatch);
    
    // Flush merged batch
    super.flush(connectionId);
    
    // Clear priority queues
    for (const queue of Object.values(queues)) {
      queue.length = 0;
    }
  }
}

// Export singleton instances
export const broadcaster = new BatchedBroadcaster();
export const priorityBroadcaster = new PriorityBatchedBroadcaster();