/**
 * Bandwidth Optimization - Data Compression
 * Following Carmack/Martin/Pike principles:
 * - Efficient data compression
 * - Smart protocol optimization
 * - Adaptive compression strategies
 */

import { EventEmitter } from 'events';
import * as zlib from 'zlib';
import * as crypto from 'crypto';
import { logger } from '../utils/logger';

interface BandwidthConfig {
  compression: {
    enabled: boolean;
    algorithm: 'gzip' | 'deflate' | 'brotli' | 'lz4' | 'adaptive';
    level: number; // 1-9 for most algorithms
    threshold: number; // Minimum size to compress (bytes)
    dictionary?: Buffer; // Pre-shared dictionary for better compression
  };
  
  deduplication: {
    enabled: boolean;
    cacheSize: number;
    ttl: number;
  };
  
  delta: {
    enabled: boolean;
    baselineSize: number;
    maxReferences: number;
  };
  
  protocols: {
    binary: boolean;
    messagepack: boolean;
    protobuf: boolean;
    customEncoding: boolean;
  };
  
  streaming: {
    enabled: boolean;
    chunkSize: number;
    windowSize: number;
  };
  
  qos: {
    enabled: boolean;
    priorities: number; // Number of priority levels
    maxBandwidth?: number; // bytes/sec
  };
}

interface CompressionStats {
  algorithm: string;
  originalSize: number;
  compressedSize: number;
  ratio: number;
  time: number;
  count: number;
}

interface DeltaReference {
  id: string;
  data: Buffer;
  timestamp: number;
  useCount: number;
}

interface QoSQueue {
  priority: number;
  messages: QueuedMessage[];
  bandwidth: number;
  lastSent: number;
}

interface QueuedMessage {
  data: Buffer;
  timestamp: number;
  callback?: (err?: Error) => void;
}

export class BandwidthOptimizer extends EventEmitter {
  private config: BandwidthConfig;
  private compressionStats: Map<string, CompressionStats> = new Map();
  private dedupeCache: Map<string, Buffer> = new Map();
  private deltaReferences: Map<string, DeltaReference> = new Map();
  private qosQueues: QoSQueue[] = [];
  private currentBandwidth: number = 0;
  private bandwidthMeasurements: number[] = [];
  
  // Compression contexts
  private gzipEncoder?: zlib.Gzip;
  private gzipDecoder?: zlib.Gunzip;
  private brotliEncoder?: zlib.BrotliCompress;
  private brotliDecoder?: zlib.BrotliDecompress;
  
  // Streaming state
  private streamBuffers: Map<string, Buffer[]> = new Map();
  private streamWindows: Map<string, Buffer> = new Map();

  constructor(config: BandwidthConfig) {
    super();
    this.config = config;
    
    // Initialize QoS queues
    if (config.qos.enabled) {
      for (let i = 0; i < config.qos.priorities; i++) {
        this.qosQueues.push({
          priority: i,
          messages: [],
          bandwidth: 0,
          lastSent: 0
        });
      }
    }
  }

  /**
   * Initialize bandwidth optimizer
   */
  async initialize(): Promise<void> {
    logger.info('Initializing bandwidth optimizer', {
      compression: this.config.compression.algorithm,
      deduplication: this.config.deduplication.enabled,
      delta: this.config.delta.enabled
    });

    // Initialize compression contexts
    if (this.config.compression.enabled) {
      await this.initializeCompression();
    }

    // Start cleanup timers
    if (this.config.deduplication.enabled) {
      this.startDedupeCleanup();
    }

    if (this.config.delta.enabled) {
      this.startDeltaCleanup();
    }

    // Start QoS scheduler
    if (this.config.qos.enabled) {
      this.startQoSScheduler();
    }

    // Start bandwidth monitoring
    this.startBandwidthMonitoring();

    this.emit('initialized');
  }

  /**
   * Optimize data for transmission
   */
  async optimize(data: any, options: {
    priority?: number;
    dedupe?: boolean;
    delta?: boolean;
    reference?: string;
    stream?: string;
  } = {}): Promise<Buffer> {
    const startTime = Date.now();
    let buffer: Buffer;

    // Convert to buffer
    if (Buffer.isBuffer(data)) {
      buffer = data;
    } else if (typeof data === 'string') {
      buffer = Buffer.from(data);
    } else {
      buffer = this.serialize(data);
    }

    const originalSize = buffer.length;

    // Apply optimizations in order
    if (options.dedupe !== false && this.config.deduplication.enabled) {
      const deduped = this.deduplicate(buffer);
      if (deduped) {
        this.emit('deduplication:hit', { size: originalSize });
        return deduped;
      }
    }

    if (options.delta !== false && this.config.delta.enabled && options.reference) {
      buffer = await this.deltaEncode(buffer, options.reference);
    }

    if (this.config.compression.enabled && buffer.length >= this.config.compression.threshold) {
      buffer = await this.compress(buffer);
    }

    // Record stats
    const optimizationTime = Date.now() - startTime;
    const ratio = buffer.length / originalSize;

    this.emit('optimization:complete', {
      originalSize,
      optimizedSize: buffer.length,
      ratio,
      time: optimizationTime
    });

    return buffer;
  }

  /**
   * Restore optimized data
   */
  async restore(buffer: Buffer, options: {
    reference?: string;
    stream?: string;
  } = {}): Promise<Buffer> {
    // Check if compressed
    if (this.isCompressed(buffer)) {
      buffer = await this.decompress(buffer);
    }

    // Check if delta encoded
    if (this.isDeltaEncoded(buffer) && options.reference) {
      buffer = await this.deltaDecode(buffer, options.reference);
    }

    return buffer;
  }

  /**
   * Serialize data
   */
  private serialize(data: any): Buffer {
    if (this.config.protocols.messagepack) {
      // Use MessagePack for efficient serialization
      // const msgpack = require('msgpack');
      // return msgpack.pack(data);
    }

    if (this.config.protocols.protobuf) {
      // Use Protocol Buffers
      // Would need schema definition
    }

    if (this.config.protocols.binary) {
      return this.binaryEncode(data);
    }

    // Default to JSON
    return Buffer.from(JSON.stringify(data));
  }

  /**
   * Binary encoding
   */
  private binaryEncode(obj: any): Buffer {
    const buffers: Buffer[] = [];
    
    // Simple binary protocol
    // Type byte + length + data
    const encode = (value: any): Buffer => {
      if (typeof value === 'number') {
        const buf = Buffer.allocUnsafe(9);
        buf[0] = 0x01; // Type: number
        buf.writeDoubleBE(value, 1);
        return buf;
      } else if (typeof value === 'string') {
        const strBuf = Buffer.from(value);
        const buf = Buffer.allocUnsafe(5 + strBuf.length);
        buf[0] = 0x02; // Type: string
        buf.writeUInt32BE(strBuf.length, 1);
        strBuf.copy(buf, 5);
        return buf;
      } else if (Buffer.isBuffer(value)) {
        const buf = Buffer.allocUnsafe(5 + value.length);
        buf[0] = 0x03; // Type: buffer
        buf.writeUInt32BE(value.length, 1);
        value.copy(buf, 5);
        return buf;
      } else if (Array.isArray(value)) {
        const arrayBuffers: Buffer[] = [Buffer.from([0x04, value.length])];
        for (const item of value) {
          arrayBuffers.push(encode(item));
        }
        return Buffer.concat(arrayBuffers);
      } else if (typeof value === 'object' && value !== null) {
        const entries = Object.entries(value);
        const objBuffers: Buffer[] = [Buffer.from([0x05, entries.length])];
        for (const [key, val] of entries) {
          objBuffers.push(encode(key));
          objBuffers.push(encode(val));
        }
        return Buffer.concat(objBuffers);
      }
      
      return Buffer.from([0x00]); // Type: null
    };

    return encode(obj);
  }

  /**
   * Initialize compression
   */
  private async initializeCompression(): Promise<void> {
    switch (this.config.compression.algorithm) {
      case 'gzip':
        this.gzipEncoder = zlib.createGzip({ level: this.config.compression.level });
        this.gzipDecoder = zlib.createGunzip();
        break;
        
      case 'brotli':
        this.brotliEncoder = zlib.createBrotliCompress({
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: this.config.compression.level
          }
        });
        this.brotliDecoder = zlib.createBrotliDecompress();
        break;
        
      case 'deflate':
        // Use built-in deflate
        break;
        
      case 'lz4':
        // Would use lz4 library
        break;
        
      case 'adaptive':
        // Initialize all algorithms for adaptive selection
        await this.initializeAdaptiveCompression();
        break;
    }

    // Load dictionary if provided
    if (this.config.compression.dictionary) {
      // Apply dictionary to compressors
    }
  }

  /**
   * Initialize adaptive compression
   */
  private async initializeAdaptiveCompression(): Promise<void> {
    // Initialize stats for each algorithm
    ['gzip', 'deflate', 'brotli'].forEach(algo => {
      this.compressionStats.set(algo, {
        algorithm: algo,
        originalSize: 0,
        compressedSize: 0,
        ratio: 1,
        time: 0,
        count: 0
      });
    });
  }

  /**
   * Compress data
   */
  private async compress(data: Buffer): Promise<Buffer> {
    const startTime = Date.now();
    let compressed: Buffer;
    let algorithm = this.config.compression.algorithm;

    if (algorithm === 'adaptive') {
      algorithm = this.selectBestAlgorithm(data);
    }

    switch (algorithm) {
      case 'gzip':
        compressed = await new Promise<Buffer>((resolve, reject) => {
          zlib.gzip(data, { level: this.config.compression.level }, (err, result) => {
            if (err) reject(err);
            else resolve(result);
          });
        });
        break;
        
      case 'deflate':
        compressed = await new Promise<Buffer>((resolve, reject) => {
          zlib.deflate(data, { level: this.config.compression.level }, (err, result) => {
            if (err) reject(err);
            else resolve(result);
          });
        });
        break;
        
      case 'brotli':
        compressed = await new Promise<Buffer>((resolve, reject) => {
          zlib.brotliCompress(data, {
            params: {
              [zlib.constants.BROTLI_PARAM_QUALITY]: this.config.compression.level
            }
          }, (err, result) => {
            if (err) reject(err);
            else resolve(result);
          });
        });
        break;
        
      default:
        compressed = data;
    }

    // Update stats
    const compressionTime = Date.now() - startTime;
    this.updateCompressionStats(algorithm, data.length, compressed.length, compressionTime);

    // Add compression header
    const header = Buffer.allocUnsafe(2);
    header[0] = 0xC0; // Compression marker
    header[1] = this.getAlgorithmByte(algorithm);
    
    return Buffer.concat([header, compressed]);
  }

  /**
   * Decompress data
   */
  private async decompress(data: Buffer): Promise<Buffer> {
    if (data.length < 2 || data[0] !== 0xC0) {
      return data; // Not compressed
    }

    const algorithm = this.getAlgorithmFromByte(data[1]);
    const compressed = data.slice(2);

    switch (algorithm) {
      case 'gzip':
        return new Promise<Buffer>((resolve, reject) => {
          zlib.gunzip(compressed, (err, result) => {
            if (err) reject(err);
            else resolve(result);
          });
        });
        
      case 'deflate':
        return new Promise<Buffer>((resolve, reject) => {
          zlib.inflate(compressed, (err, result) => {
            if (err) reject(err);
            else resolve(result);
          });
        });
        
      case 'brotli':
        return new Promise<Buffer>((resolve, reject) => {
          zlib.brotliDecompress(compressed, (err, result) => {
            if (err) reject(err);
            else resolve(result);
          });
        });
        
      default:
        return compressed;
    }
  }

  /**
   * Check if data is compressed
   */
  private isCompressed(data: Buffer): boolean {
    return data.length >= 2 && data[0] === 0xC0;
  }

  /**
   * Select best compression algorithm
   */
  private selectBestAlgorithm(data: Buffer): string {
    // Use historical stats to select best algorithm
    let bestAlgo = 'gzip';
    let bestScore = 0;

    for (const [algo, stats] of this.compressionStats) {
      if (stats.count === 0) continue;
      
      // Score based on compression ratio and speed
      const avgRatio = stats.compressedSize / stats.originalSize;
      const avgTime = stats.time / stats.count;
      
      // Balance between compression and speed
      const score = (1 - avgRatio) * 1000 / (avgTime + 1);
      
      if (score > bestScore) {
        bestScore = score;
        bestAlgo = algo;
      }
    }

    // Sample different algorithms occasionally
    if (Math.random() < 0.1) {
      const algorithms = ['gzip', 'deflate', 'brotli'];
      bestAlgo = algorithms[Math.floor(Math.random() * algorithms.length)];
    }

    return bestAlgo;
  }

  /**
   * Update compression statistics
   */
  private updateCompressionStats(
    algorithm: string,
    originalSize: number,
    compressedSize: number,
    time: number
  ): void {
    const stats = this.compressionStats.get(algorithm) || {
      algorithm,
      originalSize: 0,
      compressedSize: 0,
      ratio: 1,
      time: 0,
      count: 0
    };

    stats.originalSize += originalSize;
    stats.compressedSize += compressedSize;
    stats.time += time;
    stats.count++;
    stats.ratio = stats.compressedSize / stats.originalSize;

    this.compressionStats.set(algorithm, stats);
  }

  /**
   * Deduplicate data
   */
  private deduplicate(data: Buffer): Buffer | null {
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    
    // Check cache
    const cached = this.dedupeCache.get(hash);
    if (cached) {
      // Return reference instead of data
      const ref = Buffer.allocUnsafe(33);
      ref[0] = 0xDE; // Deduplication marker
      Buffer.from(hash, 'hex').copy(ref, 1);
      return ref;
    }

    // Add to cache
    if (this.dedupeCache.size < this.config.deduplication.cacheSize) {
      this.dedupeCache.set(hash, data);
    }

    return null;
  }

  /**
   * Delta encode data
   */
  private async deltaEncode(data: Buffer, referenceId: string): Promise<Buffer> {
    const reference = this.deltaReferences.get(referenceId);
    if (!reference) {
      // No reference, store as new baseline
      this.storeDeltaReference(referenceId, data);
      return data;
    }

    // Simple XOR delta encoding
    const delta = Buffer.allocUnsafe(data.length);
    const minLength = Math.min(data.length, reference.data.length);
    
    let differences = 0;
    for (let i = 0; i < minLength; i++) {
      delta[i] = data[i] ^ reference.data[i];
      if (delta[i] !== 0) differences++;
    }

    // Only use delta if it's beneficial
    if (differences < data.length * 0.5) {
      const header = Buffer.allocUnsafe(37);
      header[0] = 0xDE; // Delta marker
      header[1] = 0x1A; // Delta type
      header.writeUInt32BE(reference.data.length, 2);
      header.writeUInt32BE(data.length, 6);
      Buffer.from(referenceId, 'hex').copy(header, 10);
      
      reference.useCount++;
      return Buffer.concat([header, delta]);
    }

    // Update reference if new data is better
    if (data.length <= reference.data.length) {
      this.storeDeltaReference(referenceId, data);
    }

    return data;
  }

  /**
   * Delta decode data
   */
  private async deltaDecode(data: Buffer, referenceId: string): Promise<Buffer> {
    if (data.length < 37 || data[0] !== 0xDE || data[1] !== 0x1A) {
      return data;
    }

    const reference = this.deltaReferences.get(referenceId);
    if (!reference) {
      throw new Error('Delta reference not found');
    }

    const originalLength = data.readUInt32BE(6);
    const delta = data.slice(37);
    const restored = Buffer.allocUnsafe(originalLength);

    // Apply delta
    const minLength = Math.min(originalLength, reference.data.length);
    for (let i = 0; i < minLength; i++) {
      restored[i] = delta[i] ^ reference.data[i];
    }

    return restored;
  }

  /**
   * Check if data is delta encoded
   */
  private isDeltaEncoded(data: Buffer): boolean {
    return data.length >= 2 && data[0] === 0xDE && data[1] === 0x1A;
  }

  /**
   * Store delta reference
   */
  private storeDeltaReference(id: string, data: Buffer): void {
    // Limit reference size
    if (data.length > this.config.delta.baselineSize) {
      return;
    }

    // Evict old references if needed
    if (this.deltaReferences.size >= this.config.delta.maxReferences) {
      // Remove least used
      let leastUsed: string | null = null;
      let minUseCount = Infinity;
      
      for (const [refId, ref] of this.deltaReferences) {
        if (ref.useCount < minUseCount) {
          minUseCount = ref.useCount;
          leastUsed = refId;
        }
      }
      
      if (leastUsed) {
        this.deltaReferences.delete(leastUsed);
      }
    }

    this.deltaReferences.set(id, {
      id,
      data: Buffer.from(data), // Copy to prevent mutations
      timestamp: Date.now(),
      useCount: 0
    });
  }

  /**
   * Start deduplication cleanup
   */
  private startDedupeCleanup(): void {
    setInterval(() => {
      const now = Date.now();
      const ttl = this.config.deduplication.ttl;
      
      // This is simplified - in practice, need to track timestamps
      if (this.dedupeCache.size > this.config.deduplication.cacheSize * 0.9) {
        // Clear oldest entries
        const entriesToRemove = Math.floor(this.dedupeCache.size * 0.2);
        const keys = Array.from(this.dedupeCache.keys());
        
        for (let i = 0; i < entriesToRemove; i++) {
          this.dedupeCache.delete(keys[i]);
        }
      }
    }, 60000); // Every minute
  }

  /**
   * Start delta cleanup
   */
  private startDeltaCleanup(): void {
    setInterval(() => {
      const now = Date.now();
      const maxAge = 3600000; // 1 hour
      
      for (const [id, ref] of this.deltaReferences) {
        if (now - ref.timestamp > maxAge && ref.useCount === 0) {
          this.deltaReferences.delete(id);
        }
      }
    }, 300000); // Every 5 minutes
  }

  /**
   * Queue message with QoS
   */
  async queueMessage(
    data: Buffer,
    priority: number = 0,
    callback?: (err?: Error) => void
  ): Promise<void> {
    if (!this.config.qos.enabled) {
      callback?.();
      return;
    }

    const queue = this.qosQueues[Math.min(priority, this.qosQueues.length - 1)];
    queue.messages.push({
      data,
      timestamp: Date.now(),
      callback
    });

    this.emit('message:queued', { priority, size: data.length });
  }

  /**
   * Start QoS scheduler
   */
  private startQoSScheduler(): void {
    setInterval(() => {
      this.processQoSQueues();
    }, 10); // Run every 10ms for smooth bandwidth usage
  }

  /**
   * Process QoS queues
   */
  private processQoSQueues(): void {
    const now = Date.now();
    const availableBandwidth = this.config.qos.maxBandwidth || Infinity;
    let usedBandwidth = 0;

    // Process queues by priority
    for (const queue of this.qosQueues) {
      if (queue.messages.length === 0) continue;

      // Calculate queue's bandwidth allocation
      const queueBandwidth = this.calculateQueueBandwidth(
        queue.priority,
        availableBandwidth - usedBandwidth
      );

      // Send messages up to bandwidth limit
      let queueUsed = 0;
      while (queue.messages.length > 0 && queueUsed < queueBandwidth) {
        const message = queue.messages[0];
        
        if (queueUsed + message.data.length <= queueBandwidth) {
          queue.messages.shift();
          queueUsed += message.data.length;
          
          // Simulate sending
          this.sendWithBandwidthTracking(message.data);
          message.callback?.();
        } else {
          break;
        }
      }

      queue.bandwidth = queueUsed;
      queue.lastSent = now;
      usedBandwidth += queueUsed;
    }
  }

  /**
   * Calculate queue bandwidth allocation
   */
  private calculateQueueBandwidth(priority: number, availableBandwidth: number): number {
    // Higher priority gets more bandwidth
    const weight = Math.pow(2, this.qosQueues.length - priority - 1);
    const totalWeight = Math.pow(2, this.qosQueues.length) - 1;
    
    return Math.floor(availableBandwidth * weight / totalWeight);
  }

  /**
   * Send with bandwidth tracking
   */
  private sendWithBandwidthTracking(data: Buffer): void {
    this.currentBandwidth += data.length;
    
    // Track bandwidth usage
    this.bandwidthMeasurements.push(data.length);
    if (this.bandwidthMeasurements.length > 100) {
      this.bandwidthMeasurements.shift();
    }
    
    this.emit('data:sent', { size: data.length });
  }

  /**
   * Start bandwidth monitoring
   */
  private startBandwidthMonitoring(): void {
    setInterval(() => {
      const totalBytes = this.bandwidthMeasurements.reduce((sum, size) => sum + size, 0);
      const bandwidth = totalBytes; // bytes per second (measurements are per second)
      
      this.emit('bandwidth:update', {
        current: bandwidth,
        average: totalBytes / this.bandwidthMeasurements.length
      });
      
      // Reset for next period
      this.currentBandwidth = 0;
    }, 1000); // Every second
  }

  /**
   * Get algorithm byte
   */
  private getAlgorithmByte(algorithm: string): number {
    const algorithms: { [key: string]: number } = {
      'gzip': 0x01,
      'deflate': 0x02,
      'brotli': 0x03,
      'lz4': 0x04
    };
    return algorithms[algorithm] || 0x00;
  }

  /**
   * Get algorithm from byte
   */
  private getAlgorithmFromByte(byte: number): string {
    const algorithms: { [key: number]: string } = {
      0x01: 'gzip',
      0x02: 'deflate',
      0x03: 'brotli',
      0x04: 'lz4'
    };
    return algorithms[byte] || 'none';
  }

  /**
   * Get statistics
   */
  getStatistics(): any {
    const stats = {
      compression: Array.from(this.compressionStats.values()).map(stat => ({
        algorithm: stat.algorithm,
        ratio: stat.ratio.toFixed(3),
        avgTime: stat.count > 0 ? (stat.time / stat.count).toFixed(2) + 'ms' : '0ms',
        totalSaved: stat.originalSize - stat.compressedSize,
        count: stat.count
      })),
      deduplication: {
        cacheSize: this.dedupeCache.size,
        hitRate: 0 // Would need to track hits
      },
      delta: {
        references: this.deltaReferences.size,
        totalUses: Array.from(this.deltaReferences.values())
          .reduce((sum, ref) => sum + ref.useCount, 0)
      },
      bandwidth: {
        current: this.currentBandwidth,
        average: this.bandwidthMeasurements.length > 0
          ? this.bandwidthMeasurements.reduce((a, b) => a + b, 0) / this.bandwidthMeasurements.length
          : 0
      },
      qos: this.qosQueues.map(queue => ({
        priority: queue.priority,
        queued: queue.messages.length,
        bandwidth: queue.bandwidth
      }))
    };

    return stats;
  }

  /**
   * Shutdown
   */
  shutdown(): void {
    // Clear caches
    this.dedupeCache.clear();
    this.deltaReferences.clear();
    this.streamBuffers.clear();
    this.streamWindows.clear();
    
    // Clear queues
    for (const queue of this.qosQueues) {
      for (const message of queue.messages) {
        message.callback?.(new Error('Shutdown'));
      }
      queue.messages = [];
    }
    
    logger.info('Bandwidth optimizer shutdown');
  }
}

// Export types
export { BandwidthConfig, CompressionStats };
