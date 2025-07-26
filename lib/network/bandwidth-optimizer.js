/**
 * Bandwidth Optimizer - Otedama
 * Optimizes network bandwidth usage for low-latency mining
 * 
 * Design Principles:
 * - Carmack: Minimize network overhead, maximize throughput
 * - Martin: Clean separation of optimization strategies
 * - Pike: Simple protocols for complex optimizations
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import zlib from 'zlib';
import { promisify } from 'util';

const logger = createStructuredLogger('BandwidthOptimizer');

const gzip = promisify(zlib.gzip);
const brotli = promisify(zlib.brotliCompress);

/**
 * Optimization strategies
 */
const OPTIMIZATION_STRATEGIES = {
  COMPRESSION: 'compression',
  BATCHING: 'batching',
  DELTA_ENCODING: 'delta_encoding',
  BINARY_PROTOCOL: 'binary_protocol',
  MULTIPLEXING: 'multiplexing',
  PRIORITIZATION: 'prioritization',
  CACHING: 'caching'
};

/**
 * Message priorities
 */
const MESSAGE_PRIORITY = {
  CRITICAL: 0,    // Share submissions, block notifications
  HIGH: 1,        // Job updates, difficulty adjustments
  NORMAL: 2,      // Statistics, miner updates
  LOW: 3          // Debugging, logging
};

/**
 * Network Quality of Service levels
 */
const QOS_LEVELS = {
  REALTIME: { latency: 10, jitter: 5, loss: 0.001 },
  INTERACTIVE: { latency: 50, jitter: 20, loss: 0.01 },
  STREAMING: { latency: 200, jitter: 50, loss: 0.02 },
  BULK: { latency: 1000, jitter: 500, loss: 0.05 }
};

/**
 * Message batch for efficient transmission
 */
class MessageBatch {
  constructor(maxSize = 65536, maxDelay = 10) {
    this.messages = [];
    this.currentSize = 0;
    this.maxSize = maxSize;
    this.maxDelay = maxDelay;
    this.createdAt = Date.now();
    this.priority = MESSAGE_PRIORITY.LOW;
  }
  
  add(message, priority = MESSAGE_PRIORITY.NORMAL) {
    const msgSize = Buffer.byteLength(JSON.stringify(message));
    
    if (this.currentSize + msgSize > this.maxSize) {
      return false;
    }
    
    this.messages.push({ message, priority, size: msgSize });
    this.currentSize += msgSize;
    this.priority = Math.min(this.priority, priority);
    
    return true;
  }
  
  shouldFlush() {
    const age = Date.now() - this.createdAt;
    return this.currentSize >= this.maxSize * 0.8 || 
           age >= this.maxDelay ||
           this.priority === MESSAGE_PRIORITY.CRITICAL;
  }
  
  flush() {
    const batch = {
      messages: this.messages.map(m => m.message),
      count: this.messages.length,
      size: this.currentSize,
      priority: this.priority
    };
    
    this.messages = [];
    this.currentSize = 0;
    this.createdAt = Date.now();
    this.priority = MESSAGE_PRIORITY.LOW;
    
    return batch;
  }
}

/**
 * Delta encoder for repetitive data
 */
class DeltaEncoder {
  constructor() {
    this.baseStates = new Map();
    this.deltaHistory = new Map();
  }
  
  encode(key, data) {
    const baseState = this.baseStates.get(key);
    
    if (!baseState) {
      // First time, send full data
      this.baseStates.set(key, { ...data });
      return { type: 'full', data };
    }
    
    // Calculate delta
    const delta = this.calculateDelta(baseState, data);
    
    if (delta.changes === 0) {
      return { type: 'no_change' };
    }
    
    // Check if delta is worth it
    const deltaSize = JSON.stringify(delta).length;
    const fullSize = JSON.stringify(data).length;
    
    if (deltaSize < fullSize * 0.7) {
      // Update base state with changed fields
      for (const field of delta.changed) {
        baseState[field] = data[field];
      }
      
      return { type: 'delta', delta };
    } else {
      // Send full data and update base
      this.baseStates.set(key, { ...data });
      return { type: 'full', data };
    }
  }
  
  decode(key, encoded) {
    switch (encoded.type) {
      case 'full':
        this.baseStates.set(key, { ...encoded.data });
        return encoded.data;
        
      case 'delta':
        const baseState = this.baseStates.get(key);
        if (!baseState) {
          throw new Error('No base state for delta decoding');
        }
        
        const decoded = { ...baseState };
        for (const field of encoded.delta.changed) {
          decoded[field] = encoded.delta.values[field];
          baseState[field] = encoded.delta.values[field];
        }
        
        return decoded;
        
      case 'no_change':
        return this.baseStates.get(key);
        
      default:
        throw new Error(`Unknown encoding type: ${encoded.type}`);
    }
  }
  
  calculateDelta(oldData, newData) {
    const delta = { changed: [], values: {}, changes: 0 };
    
    for (const key in newData) {
      if (oldData[key] !== newData[key]) {
        delta.changed.push(key);
        delta.values[key] = newData[key];
        delta.changes++;
      }
    }
    
    return delta;
  }
}

/**
 * Binary protocol encoder/decoder
 */
class BinaryProtocol {
  constructor() {
    this.messageTypes = new Map();
    this.typeCounter = 0;
    
    // Register common message types
    this.registerType('share', ['nonce:u32', 'difficulty:u64', 'timestamp:u64']);
    this.registerType('job', ['id:str', 'prevHash:hex', 'target:hex', 'height:u32']);
    this.registerType('stats', ['hashrate:f64', 'shares:u32', 'uptime:u64']);
  }
  
  registerType(name, fields) {
    this.messageTypes.set(name, {
      id: this.typeCounter++,
      fields: fields.map(f => {
        const [fieldName, fieldType] = f.split(':');
        return { name: fieldName, type: fieldType };
      })
    });
  }
  
  encode(type, data) {
    const msgType = this.messageTypes.get(type);
    if (!msgType) {
      throw new Error(`Unknown message type: ${type}`);
    }
    
    const buffer = Buffer.allocUnsafe(1024); // Pre-allocate
    let offset = 0;
    
    // Write message type ID
    buffer.writeUInt8(msgType.id, offset);
    offset += 1;
    
    // Write fields
    for (const field of msgType.fields) {
      offset = this.writeField(buffer, offset, field, data[field.name]);
    }
    
    return buffer.slice(0, offset);
  }
  
  decode(buffer) {
    let offset = 0;
    
    // Read message type ID
    const typeId = buffer.readUInt8(offset);
    offset += 1;
    
    // Find message type
    let msgType = null;
    let typeName = null;
    
    for (const [name, type] of this.messageTypes) {
      if (type.id === typeId) {
        msgType = type;
        typeName = name;
        break;
      }
    }
    
    if (!msgType) {
      throw new Error(`Unknown message type ID: ${typeId}`);
    }
    
    // Read fields
    const data = { _type: typeName };
    
    for (const field of msgType.fields) {
      const result = this.readField(buffer, offset, field);
      data[field.name] = result.value;
      offset = result.offset;
    }
    
    return data;
  }
  
  writeField(buffer, offset, field, value) {
    switch (field.type) {
      case 'u8':
        buffer.writeUInt8(value, offset);
        return offset + 1;
        
      case 'u16':
        buffer.writeUInt16LE(value, offset);
        return offset + 2;
        
      case 'u32':
        buffer.writeUInt32LE(value, offset);
        return offset + 4;
        
      case 'u64':
        buffer.writeBigUInt64LE(BigInt(value), offset);
        return offset + 8;
        
      case 'f32':
        buffer.writeFloatLE(value, offset);
        return offset + 4;
        
      case 'f64':
        buffer.writeDoubleLE(value, offset);
        return offset + 8;
        
      case 'str':
        const strLen = Buffer.byteLength(value);
        buffer.writeUInt16LE(strLen, offset);
        buffer.write(value, offset + 2);
        return offset + 2 + strLen;
        
      case 'hex':
        const hexBuf = Buffer.from(value, 'hex');
        buffer.writeUInt8(hexBuf.length, offset);
        hexBuf.copy(buffer, offset + 1);
        return offset + 1 + hexBuf.length;
        
      default:
        throw new Error(`Unknown field type: ${field.type}`);
    }
  }
  
  readField(buffer, offset, field) {
    switch (field.type) {
      case 'u8':
        return { value: buffer.readUInt8(offset), offset: offset + 1 };
        
      case 'u16':
        return { value: buffer.readUInt16LE(offset), offset: offset + 2 };
        
      case 'u32':
        return { value: buffer.readUInt32LE(offset), offset: offset + 4 };
        
      case 'u64':
        return { value: Number(buffer.readBigUInt64LE(offset)), offset: offset + 8 };
        
      case 'f32':
        return { value: buffer.readFloatLE(offset), offset: offset + 4 };
        
      case 'f64':
        return { value: buffer.readDoubleLE(offset), offset: offset + 8 };
        
      case 'str':
        const strLen = buffer.readUInt16LE(offset);
        const str = buffer.toString('utf8', offset + 2, offset + 2 + strLen);
        return { value: str, offset: offset + 2 + strLen };
        
      case 'hex':
        const hexLen = buffer.readUInt8(offset);
        const hex = buffer.toString('hex', offset + 1, offset + 1 + hexLen);
        return { value: hex, offset: offset + 1 + hexLen };
        
      default:
        throw new Error(`Unknown field type: ${field.type}`);
    }
  }
}

/**
 * Bandwidth Optimizer
 */
export class BandwidthOptimizer extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Optimization settings
      enableCompression: config.enableCompression !== false,
      compressionAlgorithm: config.compressionAlgorithm || 'gzip',
      compressionLevel: config.compressionLevel || 6,
      
      enableBatching: config.enableBatching !== false,
      batchSize: config.batchSize || 65536, // 64KB
      batchDelay: config.batchDelay || 10, // 10ms
      
      enableDeltaEncoding: config.enableDeltaEncoding !== false,
      enableBinaryProtocol: config.enableBinaryProtocol !== false,
      
      // QoS settings
      qosLevel: config.qosLevel || QOS_LEVELS.INTERACTIVE,
      priorityQueues: config.priorityQueues !== false,
      
      // Bandwidth limits
      maxBandwidth: config.maxBandwidth || Infinity,
      burstSize: config.burstSize || 1048576, // 1MB
      
      ...config
    };
    
    // Components
    this.deltaEncoder = new DeltaEncoder();
    this.binaryProtocol = new BinaryProtocol();
    
    // Message batching
    this.batches = new Map(); // connection -> batch
    this.batchTimers = new Map();
    
    // Priority queues
    this.priorityQueues = new Map(); // priority -> queue
    for (let i = 0; i <= MESSAGE_PRIORITY.LOW; i++) {
      this.priorityQueues.set(i, []);
    }
    
    // Bandwidth tracking
    this.bandwidthStats = {
      sent: 0,
      received: 0,
      compressed: 0,
      uncompressed: 0,
      compressionRatio: 1.0
    };
    
    // Network conditions
    this.networkConditions = {
      latency: 50,
      jitter: 10,
      packetLoss: 0.001,
      bandwidth: 100 * 1024 * 1024 // 100 Mbps
    };
    
    this.logger = logger;
  }
  
  /**
   * Initialize optimizer
   */
  async initialize() {
    // Start bandwidth monitoring
    this.startBandwidthMonitoring();
    
    // Start queue processing
    this.startQueueProcessing();
    
    this.logger.info('Bandwidth optimizer initialized', {
      compression: this.config.enableCompression,
      batching: this.config.enableBatching,
      binaryProtocol: this.config.enableBinaryProtocol
    });
  }
  
  /**
   * Optimize message for transmission
   */
  async optimizeMessage(message, options = {}) {
    const {
      connectionId,
      priority = MESSAGE_PRIORITY.NORMAL,
      messageType,
      forceSend = false
    } = options;
    
    let optimized = message;
    let stats = {
      originalSize: Buffer.byteLength(JSON.stringify(message)),
      optimizedSize: 0,
      optimizations: []
    };
    
    // Apply delta encoding
    if (this.config.enableDeltaEncoding && messageType) {
      const deltaKey = `${connectionId}:${messageType}`;
      const encoded = this.deltaEncoder.encode(deltaKey, message);
      
      if (encoded.type !== 'full') {
        optimized = encoded;
        stats.optimizations.push('delta');
      }
    }
    
    // Apply binary protocol
    if (this.config.enableBinaryProtocol && messageType) {
      try {
        const binary = this.binaryProtocol.encode(messageType, optimized);
        optimized = binary;
        stats.optimizations.push('binary');
      } catch (error) {
        // Fall back to JSON if binary encoding fails
        this.logger.debug('Binary encoding failed, using JSON', { error: error.message });
      }
    }
    
    // Apply batching
    if (this.config.enableBatching && !forceSend && priority >= MESSAGE_PRIORITY.NORMAL) {
      const batched = await this.batchMessage(connectionId, optimized, priority);
      if (batched) {
        stats.optimizations.push('batched');
        return { batched: true, stats };
      }
    }
    
    // Apply compression
    if (this.config.enableCompression) {
      const compressed = await this.compressData(optimized);
      if (compressed.ratio < 0.9) { // Only use if >10% reduction
        optimized = compressed.data;
        stats.optimizations.push('compressed');
        stats.compressionRatio = compressed.ratio;
      }
    }
    
    stats.optimizedSize = Buffer.isBuffer(optimized) 
      ? optimized.length 
      : Buffer.byteLength(JSON.stringify(optimized));
    
    // Update bandwidth stats
    this.bandwidthStats.uncompressed += stats.originalSize;
    this.bandwidthStats.compressed += stats.optimizedSize;
    this.bandwidthStats.compressionRatio = 
      this.bandwidthStats.compressed / this.bandwidthStats.uncompressed;
    
    return { data: optimized, stats };
  }
  
  /**
   * Batch message for later transmission
   */
  async batchMessage(connectionId, message, priority) {
    if (!this.batches.has(connectionId)) {
      this.batches.set(connectionId, new MessageBatch(
        this.config.batchSize,
        this.config.batchDelay
      ));
    }
    
    const batch = this.batches.get(connectionId);
    const added = batch.add(message, priority);
    
    if (!added || batch.shouldFlush()) {
      // Flush current batch
      const flushed = batch.flush();
      
      // Send flushed batch
      if (flushed.count > 0) {
        this.emit('batch:ready', {
          connectionId,
          batch: flushed
        });
      }
      
      // Try adding to new batch if it didn't fit
      if (!added) {
        batch.add(message, priority);
      }
    }
    
    // Set flush timer
    if (!this.batchTimers.has(connectionId)) {
      const timer = setTimeout(() => {
        this.flushBatch(connectionId);
        this.batchTimers.delete(connectionId);
      }, this.config.batchDelay);
      
      this.batchTimers.set(connectionId, timer);
    }
    
    return true;
  }
  
  /**
   * Flush pending batch
   */
  flushBatch(connectionId) {
    const batch = this.batches.get(connectionId);
    if (!batch) return;
    
    const flushed = batch.flush();
    if (flushed.count > 0) {
      this.emit('batch:ready', {
        connectionId,
        batch: flushed
      });
    }
  }
  
  /**
   * Compress data
   */
  async compressData(data) {
    const input = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
    
    let compressed;
    switch (this.config.compressionAlgorithm) {
      case 'brotli':
        compressed = await brotli(input, {
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: this.config.compressionLevel
          }
        });
        break;
        
      case 'gzip':
      default:
        compressed = await gzip(input, { level: this.config.compressionLevel });
        break;
    }
    
    return {
      data: compressed,
      ratio: compressed.length / input.length,
      algorithm: this.config.compressionAlgorithm
    };
  }
  
  /**
   * Queue message by priority
   */
  queueMessage(message, priority = MESSAGE_PRIORITY.NORMAL) {
    const queue = this.priorityQueues.get(priority);
    if (queue) {
      queue.push({
        message,
        timestamp: Date.now(),
        priority
      });
    }
  }
  
  /**
   * Process priority queues
   */
  async processQueues() {
    const bandwidth = this.getAvailableBandwidth();
    let bytesProcessed = 0;
    
    // Process queues in priority order
    for (let priority = MESSAGE_PRIORITY.CRITICAL; priority <= MESSAGE_PRIORITY.LOW; priority++) {
      const queue = this.priorityQueues.get(priority);
      if (!queue || queue.length === 0) continue;
      
      while (queue.length > 0 && bytesProcessed < bandwidth) {
        const item = queue.shift();
        
        // Check if message is too old
        const age = Date.now() - item.timestamp;
        if (age > 5000 && priority === MESSAGE_PRIORITY.LOW) {
          // Drop old low-priority messages
          continue;
        }
        
        // Send message
        this.emit('message:send', item);
        
        const size = Buffer.byteLength(JSON.stringify(item.message));
        bytesProcessed += size;
        this.bandwidthStats.sent += size;
      }
    }
  }
  
  /**
   * Get available bandwidth
   */
  getAvailableBandwidth() {
    // Simple token bucket algorithm
    const elapsed = Date.now() - (this.lastBandwidthCheck || Date.now());
    const tokens = (elapsed / 1000) * this.config.maxBandwidth;
    
    this.lastBandwidthCheck = Date.now();
    
    return Math.min(tokens, this.config.burstSize);
  }
  
  /**
   * Measure network conditions
   */
  async measureNetworkConditions(remoteHost) {
    // In production, would use actual network measurements
    // For now, simulate measurements
    
    const measurements = {
      latency: 20 + Math.random() * 30,
      jitter: Math.random() * 20,
      packetLoss: Math.random() * 0.01,
      bandwidth: 50 * 1024 * 1024 + Math.random() * 50 * 1024 * 1024
    };
    
    // Update network conditions
    this.networkConditions = {
      latency: this.networkConditions.latency * 0.9 + measurements.latency * 0.1,
      jitter: this.networkConditions.jitter * 0.9 + measurements.jitter * 0.1,
      packetLoss: this.networkConditions.packetLoss * 0.9 + measurements.packetLoss * 0.1,
      bandwidth: this.networkConditions.bandwidth * 0.9 + measurements.bandwidth * 0.1
    };
    
    return this.networkConditions;
  }
  
  /**
   * Adjust optimization based on network conditions
   */
  adjustOptimization() {
    const conditions = this.networkConditions;
    
    // High latency: enable more aggressive batching
    if (conditions.latency > 100) {
      this.config.batchDelay = Math.min(50, this.config.batchDelay * 1.5);
      this.config.batchSize = Math.min(131072, this.config.batchSize * 1.5);
    }
    
    // High packet loss: enable stronger compression
    if (conditions.packetLoss > 0.02) {
      this.config.compressionLevel = Math.min(9, this.config.compressionLevel + 1);
    }
    
    // Low bandwidth: enable all optimizations
    if (conditions.bandwidth < 10 * 1024 * 1024) { // < 10 Mbps
      this.config.enableCompression = true;
      this.config.enableBatching = true;
      this.config.enableDeltaEncoding = true;
      this.config.enableBinaryProtocol = true;
    }
    
    this.emit('optimization:adjusted', {
      conditions,
      config: this.config
    });
  }
  
  /**
   * Start bandwidth monitoring
   */
  startBandwidthMonitoring() {
    this.monitoringInterval = setInterval(() => {
      // Reset bandwidth counters
      const stats = { ...this.bandwidthStats };
      
      this.emit('bandwidth:stats', {
        ...stats,
        interval: 60000,
        throughput: {
          sent: stats.sent / 60, // bytes per second
          received: stats.received / 60
        }
      });
      
      // Reset counters
      this.bandwidthStats.sent = 0;
      this.bandwidthStats.received = 0;
      
      // Adjust optimization based on conditions
      this.adjustOptimization();
      
    }, 60000); // Every minute
  }
  
  /**
   * Start queue processing
   */
  startQueueProcessing() {
    this.queueInterval = setInterval(() => {
      this.processQueues();
    }, 10); // Every 10ms
  }
  
  /**
   * Handle incoming data
   */
  async handleIncomingData(data, connectionId) {
    this.bandwidthStats.received += Buffer.isBuffer(data) 
      ? data.length 
      : Buffer.byteLength(data);
    
    // Decompress if needed
    let decompressed = data;
    if (Buffer.isBuffer(data) && data[0] === 0x1f && data[1] === 0x8b) {
      // Gzip magic number
      decompressed = await promisify(zlib.gunzip)(data);
    }
    
    // Decode binary protocol if used
    if (Buffer.isBuffer(decompressed) && this.config.enableBinaryProtocol) {
      try {
        decompressed = this.binaryProtocol.decode(decompressed);
      } catch (error) {
        // Not binary protocol, try JSON
        decompressed = JSON.parse(decompressed.toString());
      }
    }
    
    // Handle delta decoding
    if (decompressed._type && this.config.enableDeltaEncoding) {
      const deltaKey = `${connectionId}:${decompressed._type}`;
      decompressed = this.deltaEncoder.decode(deltaKey, decompressed);
    }
    
    return decompressed;
  }
  
  /**
   * Get optimization statistics
   */
  getStats() {
    return {
      bandwidth: this.bandwidthStats,
      network: this.networkConditions,
      queues: {
        critical: this.priorityQueues.get(MESSAGE_PRIORITY.CRITICAL)?.length || 0,
        high: this.priorityQueues.get(MESSAGE_PRIORITY.HIGH)?.length || 0,
        normal: this.priorityQueues.get(MESSAGE_PRIORITY.NORMAL)?.length || 0,
        low: this.priorityQueues.get(MESSAGE_PRIORITY.LOW)?.length || 0
      },
      batches: this.batches.size,
      optimizations: {
        compression: this.config.enableCompression,
        batching: this.config.enableBatching,
        deltaEncoding: this.config.enableDeltaEncoding,
        binaryProtocol: this.config.enableBinaryProtocol
      }
    };
  }
  
  /**
   * Shutdown optimizer
   */
  shutdown() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }
    
    if (this.queueInterval) {
      clearInterval(this.queueInterval);
    }
    
    // Clear batch timers
    for (const timer of this.batchTimers.values()) {
      clearTimeout(timer);
    }
    
    this.batches.clear();
    this.batchTimers.clear();
  }
}

// Export constants
export {
  OPTIMIZATION_STRATEGIES,
  MESSAGE_PRIORITY,
  QOS_LEVELS
};

export default BandwidthOptimizer;