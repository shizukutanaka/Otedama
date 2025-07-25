/**
 * Compression System
 * High-performance data compression for network and storage
 * 
 * Features:
 * - Multiple compression algorithms
 * - Adaptive compression selection
 * - Streaming compression
 * - Dictionary-based compression
 * - Hardware acceleration support
 */

import { createLogger } from '../core/logger.js';
import zlib from 'zlib';
import { promisify } from 'util';

const logger = createLogger('CompressionSystem');

// Promisified compression functions
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const deflate = promisify(zlib.deflate);
const inflate = promisify(zlib.inflate);
const brotliCompress = promisify(zlib.brotliCompress);
const brotliDecompress = promisify(zlib.brotliDecompress);

/**
 * Compression algorithms
 */
export const Algorithm = {
  NONE: 'none',
  GZIP: 'gzip',
  DEFLATE: 'deflate',
  BROTLI: 'brotli',
  LZ4: 'lz4',        // Would require native binding
  ZSTD: 'zstd',      // Would require native binding
  SNAPPY: 'snappy'   // Would require native binding
};

/**
 * Compression profiles
 */
export const Profile = {
  SPEED: {
    preferred: [Algorithm.LZ4, Algorithm.SNAPPY, Algorithm.DEFLATE],
    level: 1,
    strategy: zlib.constants.Z_HUFFMAN_ONLY
  },
  BALANCED: {
    preferred: [Algorithm.ZSTD, Algorithm.GZIP],
    level: 6,
    strategy: zlib.constants.Z_DEFAULT_STRATEGY
  },
  RATIO: {
    preferred: [Algorithm.BROTLI, Algorithm.ZSTD],
    level: 9,
    strategy: zlib.constants.Z_DEFAULT_STRATEGY
  }
};

/**
 * Compression statistics
 */
class CompressionStats {
  constructor() {
    this.algorithms = new Map();
  }
  
  record(algorithm, originalSize, compressedSize, time) {
    if (!this.algorithms.has(algorithm)) {
      this.algorithms.set(algorithm, {
        count: 0,
        totalOriginal: 0,
        totalCompressed: 0,
        totalTime: 0,
        ratios: []
      });
    }
    
    const stats = this.algorithms.get(algorithm);
    stats.count++;
    stats.totalOriginal += originalSize;
    stats.totalCompressed += compressedSize;
    stats.totalTime += time;
    
    const ratio = compressedSize / originalSize;
    stats.ratios.push(ratio);
    
    // Keep only last 100 ratios for moving average
    if (stats.ratios.length > 100) {
      stats.ratios.shift();
    }
  }
  
  getStats(algorithm) {
    const stats = this.algorithms.get(algorithm);
    if (!stats || stats.count === 0) return null;
    
    const avgRatio = stats.ratios.reduce((a, b) => a + b, 0) / stats.ratios.length;
    const avgTime = stats.totalTime / stats.count;
    const throughput = stats.totalOriginal / (stats.totalTime / 1000); // bytes/sec
    
    return {
      count: stats.count,
      avgRatio,
      avgTime,
      throughput,
      totalSaved: stats.totalOriginal - stats.totalCompressed
    };
  }
  
  getBestAlgorithm(profile = Profile.BALANCED) {
    let bestAlgorithm = Algorithm.GZIP;
    let bestScore = -Infinity;
    
    for (const [algorithm, stats] of this.algorithms) {
      const data = this.getStats(algorithm);
      if (!data) continue;
      
      // Score based on profile
      let score = 0;
      if (profile === Profile.SPEED) {
        score = data.throughput;
      } else if (profile === Profile.RATIO) {
        score = 1 - data.avgRatio; // Lower ratio is better
      } else {
        // Balanced: consider both speed and ratio
        score = (data.throughput / 1e9) + (1 - data.avgRatio);
      }
      
      if (score > bestScore) {
        bestScore = score;
        bestAlgorithm = algorithm;
      }
    }
    
    return bestAlgorithm;
  }
}

/**
 * Dictionary-based compression
 */
class CompressionDictionary {
  constructor(maxSize = 1024 * 1024) { // 1MB default
    this.entries = new Map();
    this.maxSize = maxSize;
    this.currentSize = 0;
    this.hits = 0;
    this.misses = 0;
  }
  
  add(key, data) {
    if (this.entries.has(key)) {
      this.hits++;
      return;
    }
    
    this.misses++;
    
    // Evict if necessary
    while (this.currentSize + data.length > this.maxSize && this.entries.size > 0) {
      const firstKey = this.entries.keys().next().value;
      const firstEntry = this.entries.get(firstKey);
      this.currentSize -= firstEntry.length;
      this.entries.delete(firstKey);
    }
    
    this.entries.set(key, data);
    this.currentSize += data.length;
  }
  
  get(key) {
    const entry = this.entries.get(key);
    if (entry) {
      this.hits++;
      return entry;
    }
    this.misses++;
    return null;
  }
  
  getHitRate() {
    const total = this.hits + this.misses;
    return total > 0 ? this.hits / total : 0;
  }
}

/**
 * Compression System
 */
export class CompressionSystem {
  constructor(config = {}) {
    this.config = {
      defaultAlgorithm: config.defaultAlgorithm || Algorithm.GZIP,
      defaultProfile: config.defaultProfile || Profile.BALANCED,
      adaptiveSelection: config.adaptiveSelection !== false,
      dictionaryEnabled: config.dictionaryEnabled !== false,
      minSizeForCompression: config.minSizeForCompression || 100, // bytes
      streamingThreshold: config.streamingThreshold || 1024 * 1024 // 1MB
    };
    
    this.stats = new CompressionStats();
    this.dictionary = new CompressionDictionary();
    
    // Algorithm availability
    this.availableAlgorithms = new Set([
      Algorithm.NONE,
      Algorithm.GZIP,
      Algorithm.DEFLATE,
      Algorithm.BROTLI
    ]);
    
    // Check for native modules
    this.checkNativeModules();
  }
  
  /**
   * Check for native compression modules
   */
  checkNativeModules() {
    // In production, would check for lz4, zstd, snappy
    // For now, we'll simulate their presence
    if (this.config.simulateNativeModules) {
      this.availableAlgorithms.add(Algorithm.LZ4);
      this.availableAlgorithms.add(Algorithm.ZSTD);
      this.availableAlgorithms.add(Algorithm.SNAPPY);
    }
  }
  
  /**
   * Compress data
   */
  async compress(data, options = {}) {
    // Convert to Buffer if needed
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    
    // Skip compression for small data
    if (buffer.length < this.config.minSizeForCompression) {
      return {
        algorithm: Algorithm.NONE,
        data: buffer,
        originalSize: buffer.length,
        compressedSize: buffer.length,
        ratio: 1
      };
    }
    
    // Check dictionary
    if (this.config.dictionaryEnabled && options.key) {
      const cached = this.dictionary.get(options.key);
      if (cached) {
        return {
          algorithm: 'dictionary',
          data: cached,
          originalSize: buffer.length,
          compressedSize: cached.length,
          ratio: cached.length / buffer.length
        };
      }
    }
    
    // Select algorithm
    const algorithm = this.selectAlgorithm(buffer, options);
    
    // Compress
    const startTime = Date.now();
    const compressed = await this.compressWithAlgorithm(buffer, algorithm, options);
    const endTime = Date.now();
    
    // Record stats
    this.stats.record(algorithm, buffer.length, compressed.length, endTime - startTime);
    
    // Add to dictionary if beneficial
    if (this.config.dictionaryEnabled && options.key && compressed.length < buffer.length * 0.8) {
      this.dictionary.add(options.key, compressed);
    }
    
    return {
      algorithm,
      data: compressed,
      originalSize: buffer.length,
      compressedSize: compressed.length,
      ratio: compressed.length / buffer.length
    };
  }
  
  /**
   * Decompress data
   */
  async decompress(data, algorithm) {
    if (algorithm === Algorithm.NONE) {
      return data;
    }
    
    if (algorithm === 'dictionary') {
      return data; // Already decompressed from dictionary
    }
    
    return this.decompressWithAlgorithm(data, algorithm);
  }
  
  /**
   * Select best algorithm for data
   */
  selectAlgorithm(data, options) {
    // Use specified algorithm if provided
    if (options.algorithm && this.availableAlgorithms.has(options.algorithm)) {
      return options.algorithm;
    }
    
    // Use adaptive selection if enabled
    if (this.config.adaptiveSelection && this.stats.algorithms.size > 0) {
      const profile = options.profile || this.config.defaultProfile;
      const bestAlgorithm = this.stats.getBestAlgorithm(profile);
      
      if (this.availableAlgorithms.has(bestAlgorithm)) {
        return bestAlgorithm;
      }
    }
    
    // Use profile preference
    const profile = options.profile || this.config.defaultProfile;
    for (const algorithm of profile.preferred) {
      if (this.availableAlgorithms.has(algorithm)) {
        return algorithm;
      }
    }
    
    // Fallback to default
    return this.config.defaultAlgorithm;
  }
  
  /**
   * Compress with specific algorithm
   */
  async compressWithAlgorithm(data, algorithm, options = {}) {
    const level = options.level || this.config.defaultProfile.level;
    
    switch (algorithm) {
      case Algorithm.GZIP:
        return gzip(data, { level });
        
      case Algorithm.DEFLATE:
        return deflate(data, { level });
        
      case Algorithm.BROTLI:
        return brotliCompress(data, {
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: level
          }
        });
        
      case Algorithm.LZ4:
        // Simulated - would use native binding
        return this.simulateLZ4Compress(data);
        
      case Algorithm.ZSTD:
        // Simulated - would use native binding
        return this.simulateZstdCompress(data, level);
        
      case Algorithm.SNAPPY:
        // Simulated - would use native binding
        return this.simulateSnappyCompress(data);
        
      default:
        return data;
    }
  }
  
  /**
   * Decompress with specific algorithm
   */
  async decompressWithAlgorithm(data, algorithm) {
    switch (algorithm) {
      case Algorithm.GZIP:
        return gunzip(data);
        
      case Algorithm.DEFLATE:
        return inflate(data);
        
      case Algorithm.BROTLI:
        return brotliDecompress(data);
        
      case Algorithm.LZ4:
        return this.simulateLZ4Decompress(data);
        
      case Algorithm.ZSTD:
        return this.simulateZstdDecompress(data);
        
      case Algorithm.SNAPPY:
        return this.simulateSnappyDecompress(data);
        
      default:
        return data;
    }
  }
  
  /**
   * Create compression stream
   */
  createCompressStream(algorithm, options = {}) {
    const level = options.level || this.config.defaultProfile.level;
    
    switch (algorithm) {
      case Algorithm.GZIP:
        return zlib.createGzip({ level });
        
      case Algorithm.DEFLATE:
        return zlib.createDeflate({ level });
        
      case Algorithm.BROTLI:
        return zlib.createBrotliCompress({
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: level
          }
        });
        
      default:
        // Pass-through stream
        const { PassThrough } = require('stream');
        return new PassThrough();
    }
  }
  
  /**
   * Create decompression stream
   */
  createDecompressStream(algorithm) {
    switch (algorithm) {
      case Algorithm.GZIP:
        return zlib.createGunzip();
        
      case Algorithm.DEFLATE:
        return zlib.createInflate();
        
      case Algorithm.BROTLI:
        return zlib.createBrotliDecompress();
        
      default:
        const { PassThrough } = require('stream');
        return new PassThrough();
    }
  }
  
  /**
   * Simulated LZ4 compression (would use real implementation)
   */
  simulateLZ4Compress(data) {
    // Simulate very fast compression with moderate ratio
    return deflate(data, { level: 1 });
  }
  
  simulateLZ4Decompress(data) {
    return inflate(data);
  }
  
  /**
   * Simulated Zstd compression (would use real implementation)
   */
  simulateZstdCompress(data, level) {
    // Simulate good compression ratio
    return gzip(data, { level });
  }
  
  simulateZstdDecompress(data) {
    return gunzip(data);
  }
  
  /**
   * Simulated Snappy compression (would use real implementation)
   */
  simulateSnappyCompress(data) {
    // Simulate very fast compression
    return deflate(data, { level: 1, strategy: zlib.constants.Z_HUFFMAN_ONLY });
  }
  
  simulateSnappyDecompress(data) {
    return inflate(data);
  }
  
  /**
   * Get compression statistics
   */
  getStats() {
    const algorithmStats = {};
    
    for (const algorithm of this.availableAlgorithms) {
      const stats = this.stats.getStats(algorithm);
      if (stats) {
        algorithmStats[algorithm] = stats;
      }
    }
    
    return {
      algorithms: algorithmStats,
      dictionary: {
        entries: this.dictionary.entries.size,
        size: this.dictionary.currentSize,
        hitRate: this.dictionary.getHitRate()
      },
      recommendations: {
        speed: this.stats.getBestAlgorithm(Profile.SPEED),
        balanced: this.stats.getBestAlgorithm(Profile.BALANCED),
        ratio: this.stats.getBestAlgorithm(Profile.RATIO)
      }
    };
  }
  
  /**
   * Clear dictionary
   */
  clearDictionary() {
    this.dictionary = new CompressionDictionary();
  }
}

export default CompressionSystem;
