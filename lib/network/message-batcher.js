/**
 * Message Batcher for Otedama Network Layer
 * Optimizes network performance by batching messages and reducing syscalls
 * 
 * Design: Zero-copy message aggregation with intelligent flushing
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('MessageBatcher');

/**
 * Message batching strategies
 */
export const BatchingStrategy = {
  TIME_BASED: 'time_based',      // Flush every N milliseconds
  SIZE_BASED: 'size_based',      // Flush when batch reaches size limit
  COUNT_BASED: 'count_based',    // Flush when message count reached
  ADAPTIVE: 'adaptive'           // Dynamic strategy based on load
};

/**
 * High-performance message batcher
 */
export class MessageBatcher extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      strategy: options.strategy || BatchingStrategy.ADAPTIVE,
      maxBatchSize: options.maxBatchSize || 64 * 1024, // 64KB
      maxMessages: options.maxMessages || 100,
      flushInterval: options.flushInterval || 5, // 5ms
      adaptiveThreshold: options.adaptiveThreshold || 0.8,
      ...options
    };
    
    // Batch storage
    this.batches = new Map(); // connectionId -> batch
    this.flushTimers = new Map(); // connectionId -> timer
    
    // Pre-allocated buffers for efficiency
    this.bufferPool = [];
    this.maxPoolSize = 50;
    this.preallocateBuffers();
    
    // Statistics
    this.stats = {
      messagesQueued: 0,
      batchesFlushed: 0,
      bytesQueued: 0,
      bytesFlushed: 0,
      avgBatchSize: 0,
      avgMessagesPerBatch: 0
    };
    
    // Performance tracking
    this.loadHistory = [];
    this.maxLoadHistory = 100;
  }
  
  /**
   * Pre-allocate buffers for zero-allocation operation
   */
  preallocateBuffers() {
    for (let i = 0; i < this.maxPoolSize; i++) {
      this.bufferPool.push(Buffer.allocUnsafe(this.options.maxBatchSize));
    }
  }
  
  /**
   * Get buffer from pool
   */
  getBuffer() {
    return this.bufferPool.pop() || Buffer.allocUnsafe(this.options.maxBatchSize);
  }
  
  /**
   * Return buffer to pool
   */
  returnBuffer(buffer) {
    if (buffer && this.bufferPool.length < this.maxPoolSize) {
      this.bufferPool.push(buffer);
    }
  }
  
  /**
   * Queue message for batching
   */
  queueMessage(connectionId, message, priority = 'normal') {
    const messageBuffer = this.serializeMessage(message);
    const messageSize = messageBuffer.length;
    
    // Get or create batch for connection
    let batch = this.batches.get(connectionId);
    if (!batch) {
      batch = this.createBatch(connectionId);
      this.batches.set(connectionId, batch);
    }
    
    // Check if message fits in current batch
    if (batch.size + messageSize > this.options.maxBatchSize || 
        batch.messages.length >= this.options.maxMessages) {
      // Flush current batch and create new one
      this.flushBatch(connectionId);
      batch = this.createBatch(connectionId);
      this.batches.set(connectionId, batch);
    }
    
    // Add message to batch
    batch.messages.push({
      data: messageBuffer,
      size: messageSize,
      priority,
      timestamp: Date.now()
    });
    batch.size += messageSize;
    
    // Update statistics
    this.stats.messagesQueued++;
    this.stats.bytesQueued += messageSize;
    
    // Schedule flush based on strategy
    this.scheduleBatchFlush(connectionId, batch);
    
    this.emit('message:queued', { connectionId, messageSize, batchSize: batch.size });
  }
  
  /**
   * Create new batch
   */
  createBatch(connectionId) {
    return {
      connectionId,
      messages: [],
      size: 0,
      createdAt: Date.now(),
      buffer: this.getBuffer()
    };
  }
  
  /**
   * Schedule batch flush based on strategy
   */
  scheduleBatchFlush(connectionId, batch) {
    const strategy = this.determineStrategy(connectionId);
    
    switch (strategy) {
      case BatchingStrategy.TIME_BASED:
        this.scheduleTimeBased(connectionId);
        break;
        
      case BatchingStrategy.SIZE_BASED:
        if (batch.size >= this.options.maxBatchSize * 0.8) {
          this.flushBatch(connectionId);
        }
        break;
        
      case BatchingStrategy.COUNT_BASED:
        if (batch.messages.length >= this.options.maxMessages) {
          this.flushBatch(connectionId);
        }
        break;
        
      case BatchingStrategy.ADAPTIVE:
        this.scheduleAdaptive(connectionId, batch);
        break;
    }
  }
  
  /**
   * Determine optimal batching strategy
   */
  determineStrategy(connectionId) {
    if (this.options.strategy !== BatchingStrategy.ADAPTIVE) {
      return this.options.strategy;
    }
    
    // Analyze connection load pattern
    const loadMetrics = this.getConnectionLoadMetrics(connectionId);
    
    if (loadMetrics.messageRate > 100) { // High frequency
      return BatchingStrategy.TIME_BASED;
    } else if (loadMetrics.avgMessageSize > 1024) { // Large messages
      return BatchingStrategy.SIZE_BASED;
    } else {
      return BatchingStrategy.COUNT_BASED;
    }
  }
  
  /**
   * Schedule time-based flush
   */
  scheduleTimeBased(connectionId) {
    if (this.flushTimers.has(connectionId)) return;
    
    const timer = setTimeout(() => {
      this.flushBatch(connectionId);
    }, this.options.flushInterval);
    
    this.flushTimers.set(connectionId, timer);
  }
  
  /**
   * Schedule adaptive flush
   */
  scheduleAdaptive(connectionId, batch) {
    const loadMetrics = this.getConnectionLoadMetrics(connectionId);
    const utilizationRatio = batch.size / this.options.maxBatchSize;
    
    if (utilizationRatio >= this.options.adaptiveThreshold) {
      // High utilization, flush immediately
      this.flushBatch(connectionId);
    } else if (loadMetrics.messageRate > 50) {
      // Medium frequency, short timer
      this.scheduleTimeBased(connectionId);
    } else {
      // Low frequency, wait for more messages or longer timer
      const timer = setTimeout(() => {
        this.flushBatch(connectionId);
      }, this.options.flushInterval * 2);
      
      this.flushTimers.set(connectionId, timer);
    }
  }
  
  /**
   * Flush batch for connection
   */
  flushBatch(connectionId) {
    const batch = this.batches.get(connectionId);
    if (!batch || batch.messages.length === 0) return;
    
    // Clear flush timer
    const timer = this.flushTimers.get(connectionId);
    if (timer) {
      clearTimeout(timer);
      this.flushTimers.delete(connectionId);
    }
    
    // Serialize batch efficiently
    const batchData = this.serializeBatch(batch);
    
    // Update statistics
    this.stats.batchesFlushed++;
    this.stats.bytesFlushed += batch.size;
    this.updateBatchStats(batch);
    
    // Emit flush event
    this.emit('batch:flush', {
      connectionId,
      data: batchData,
      messageCount: batch.messages.length,
      totalSize: batch.size,
      duration: Date.now() - batch.createdAt
    });
    
    // Return buffer to pool
    this.returnBuffer(batch.buffer);
    
    // Clean up batch
    this.batches.delete(connectionId);
    
    logger.debug('Batch flushed', {
      connectionId,
      messages: batch.messages.length,
      size: batch.size
    });
  }
  
  /**
   * Serialize batch efficiently
   */
  serializeBatch(batch) {
    const buffer = batch.buffer;
    let offset = 0;
    
    // Write batch header
    buffer.writeUInt32BE(batch.messages.length, offset);
    offset += 4;
    
    // Write messages
    for (const message of batch.messages) {
      // Write message length
      buffer.writeUInt32BE(message.size, offset);
      offset += 4;
      
      // Write message data
      message.data.copy(buffer, offset);
      offset += message.size;
    }
    
    return buffer.slice(0, offset);
  }
  
  /**
   * Serialize individual message
   */
  serializeMessage(message) {
    if (Buffer.isBuffer(message)) {
      return message;
    }
    
    if (typeof message === 'string') {
      return Buffer.from(message, 'utf8');
    }
    
    // JSON serialize objects
    return Buffer.from(JSON.stringify(message), 'utf8');
  }
  
  /**
   * Force flush all batches
   */
  flushAll() {
    const connectionIds = Array.from(this.batches.keys());
    
    for (const connectionId of connectionIds) {
      this.flushBatch(connectionId);
    }
  }
  
  /**
   * Force flush specific connection
   */
  flush(connectionId) {
    this.flushBatch(connectionId);
  }
  
  /**
   * Get connection load metrics
   */
  getConnectionLoadMetrics(connectionId) {
    // Simplified metrics - in production would track per-connection
    const now = Date.now();
    const recentPeriod = 10000; // 10 seconds
    
    const recentLoad = this.loadHistory.filter(load => 
      now - load.timestamp < recentPeriod
    );
    
    if (recentLoad.length === 0) {
      return { messageRate: 0, avgMessageSize: 0 };
    }
    
    const messageCount = recentLoad.reduce((sum, load) => sum + load.messages, 0);
    const totalBytes = recentLoad.reduce((sum, load) => sum + load.bytes, 0);
    const timeSpan = (now - recentLoad[0].timestamp) / 1000; // seconds
    
    return {
      messageRate: messageCount / Math.max(timeSpan, 1),
      avgMessageSize: totalBytes / Math.max(messageCount, 1)
    };
  }
  
  /**
   * Update batch statistics
   */
  updateBatchStats(batch) {
    const batchCount = this.stats.batchesFlushed;
    
    // Update average batch size
    this.stats.avgBatchSize = 
      ((this.stats.avgBatchSize * (batchCount - 1)) + batch.size) / batchCount;
    
    // Update average messages per batch
    this.stats.avgMessagesPerBatch = 
      ((this.stats.avgMessagesPerBatch * (batchCount - 1)) + batch.messages.length) / batchCount;
    
    // Record load for adaptive strategy
    this.loadHistory.push({
      timestamp: Date.now(),
      messages: batch.messages.length,
      bytes: batch.size
    });
    
    if (this.loadHistory.length > this.maxLoadHistory) {
      this.loadHistory.shift();
    }
  }
  
  /**
   * Get batching statistics
   */
  getStats() {
    return {
      ...this.stats,
      activeBatches: this.batches.size,
      queuedMessages: Array.from(this.batches.values())
        .reduce((sum, batch) => sum + batch.messages.length, 0),
      queuedBytes: Array.from(this.batches.values())
        .reduce((sum, batch) => sum + batch.size, 0),
      efficiency: this.stats.messagesQueued > 0 ? 
        this.stats.avgMessagesPerBatch / this.options.maxMessages : 0
    };
  }
  
  /**
   * Cleanup resources
   */
  cleanup() {
    // Flush all pending batches
    this.flushAll();
    
    // Clear timers
    for (const timer of this.flushTimers.values()) {
      clearTimeout(timer);
    }
    this.flushTimers.clear();
    
    // Clear batches
    for (const batch of this.batches.values()) {
      this.returnBuffer(batch.buffer);
    }
    this.batches.clear();
  }
}

/**
 * Connection-aware message batcher
 */
export class ConnectionBatcher {
  constructor(connection, options = {}) {
    this.connection = connection;
    this.batcher = new MessageBatcher(options);
    
    // Forward flush events to connection
    this.batcher.on('batch:flush', (data) => {
      this.connection.write(data.data);
    });
  }
  
  send(message, priority) {
    this.batcher.queueMessage(this.connection.id, message, priority);
  }
  
  flush() {
    this.batcher.flush(this.connection.id);
  }
  
  getStats() {
    return this.batcher.getStats();
  }
  
  cleanup() {
    this.batcher.cleanup();
  }
}

export default MessageBatcher;