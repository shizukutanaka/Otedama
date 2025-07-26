/**
 * Compression Optimizer - Otedama
 * High-performance data compression with adaptive algorithms
 * 
 * Features:
 * - Multiple compression algorithms
 * - Adaptive algorithm selection
 * - Streaming compression
 * - Dictionary-based optimization
 * - Hardware acceleration support
 */

import zlib from 'zlib';
import { Worker } from 'worker_threads';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('CompressionOptimizer');

/**
 * LZ4 compression implementation (simplified)
 */
export class LZ4Compressor {
  constructor() {
    this.minMatch = 4;
    this.windowSize = 65536;
    this.hashTable = new Uint32Array(4096);
  }
  
  /**
   * Fast hash function
   */
  hash(data, offset) {
    return ((data[offset] << 8) | 
            (data[offset + 1] << 16) | 
            (data[offset + 2] << 24) | 
            data[offset + 3]) >>> 0;
  }
  
  /**
   * Compress data using LZ4
   */
  compress(input) {
    const output = Buffer.allocUnsafe(input.length + Math.ceil(input.length / 255) + 16);
    let inPos = 0;
    let outPos = 0;
    let anchor = 0;
    
    // Clear hash table
    this.hashTable.fill(0);
    
    while (inPos < input.length - this.minMatch) {
      const sequence = this.hash(input, inPos);
      const hashIndex = (sequence * 2654435761) >>> 20; // Hash to 12 bits
      const ref = this.hashTable[hashIndex];
      this.hashTable[hashIndex] = inPos;
      
      // Check for match
      if (ref !== 0 && 
          inPos - ref < this.windowSize &&
          input[ref] === input[inPos] &&
          input[ref + 1] === input[inPos + 1] &&
          input[ref + 2] === input[inPos + 2] &&
          input[ref + 3] === input[inPos + 3]) {
        
        // Found match, extend it
        let matchLen = this.minMatch;
        while (inPos + matchLen < input.length && 
               input[ref + matchLen] === input[inPos + matchLen]) {
          matchLen++;
        }
        
        // Write literal length
        const literalLen = inPos - anchor;
        const token = Math.min(literalLen, 15) << 4;
        
        if (literalLen >= 15) {
          output[outPos++] = token | 15;
          let len = literalLen - 15;
          while (len >= 255) {
            output[outPos++] = 255;
            len -= 255;
          }
          output[outPos++] = len;
        } else {
          output[outPos++] = token;
        }
        
        // Copy literals
        input.copy(output, outPos, anchor, inPos);
        outPos += literalLen;
        
        // Write offset
        const offset = inPos - ref;
        output.writeUInt16LE(offset, outPos);
        outPos += 2;
        
        // Write match length
        if (matchLen >= 19) {
          output[outPos - 3] |= 15;
          let len = matchLen - 19;
          while (len >= 255) {
            output[outPos++] = 255;
            len -= 255;
          }
          output[outPos++] = len;
        } else {
          output[outPos - 3] |= (matchLen - 4);
        }
        
        inPos += matchLen;
        anchor = inPos;
      } else {
        inPos++;
      }
    }
    
    // Write remaining literals
    const remainingLen = input.length - anchor;
    if (remainingLen > 0) {
      if (remainingLen >= 15) {
        output[outPos++] = 15 << 4;
        let len = remainingLen - 15;
        while (len >= 255) {
          output[outPos++] = 255;
          len -= 255;
        }
        output[outPos++] = len;
      } else {
        output[outPos++] = remainingLen << 4;
      }
      
      input.copy(output, outPos, anchor);
      outPos += remainingLen;
    }
    
    return output.slice(0, outPos);
  }
  
  /**
   * Decompress LZ4 data
   */
  decompress(input, maxOutputSize) {
    const output = Buffer.allocUnsafe(maxOutputSize);
    let inPos = 0;
    let outPos = 0;
    
    while (inPos < input.length) {
      const token = input[inPos++];
      let literalLen = token >> 4;
      
      // Read literal length
      if (literalLen === 15) {
        let len;
        do {
          len = input[inPos++];
          literalLen += len;
        } while (len === 255);
      }
      
      // Copy literals
      input.copy(output, outPos, inPos, inPos + literalLen);
      inPos += literalLen;
      outPos += literalLen;
      
      if (inPos >= input.length) break;
      
      // Read offset
      const offset = input.readUInt16LE(inPos);
      inPos += 2;
      
      // Read match length
      let matchLen = (token & 15) + 4;
      if (matchLen === 19) {
        let len;
        do {
          len = input[inPos++];
          matchLen += len;
        } while (len === 255);
      }
      
      // Copy match
      const matchStart = outPos - offset;
      for (let i = 0; i < matchLen; i++) {
        output[outPos++] = output[matchStart + i];
      }
    }
    
    return output.slice(0, outPos);
  }
}

/**
 * Snappy compression (simplified implementation)
 */
export class SnappyCompressor {
  constructor() {
    this.maxOffset = 32768;
    this.minLength = 4;
  }
  
  /**
   * Compress using Snappy format
   */
  compress(input) {
    const output = Buffer.allocUnsafe(input.length * 1.1 + 32);
    let outPos = 0;
    let inPos = 0;
    
    // Write uncompressed length (varint)
    let len = input.length;
    while (len > 127) {
      output[outPos++] = (len & 127) | 128;
      len >>>= 7;
    }
    output[outPos++] = len;
    
    while (inPos < input.length) {
      // Find best match
      const match = this.findBestMatch(input, inPos);
      
      if (match && match.length >= this.minLength) {
        // Write literal if any
        if (match.literalLen > 0) {
          outPos = this.writeLiteral(input, inPos, match.literalLen, output, outPos);
          inPos += match.literalLen;
        }
        
        // Write copy
        outPos = this.writeCopy(match.offset, match.length, output, outPos);
        inPos += match.length;
      } else {
        // No match, write literal
        let literalLen = 1;
        while (inPos + literalLen < input.length && 
               !this.findBestMatch(input, inPos + literalLen)) {
          literalLen++;
        }
        
        outPos = this.writeLiteral(input, inPos, literalLen, output, outPos);
        inPos += literalLen;
      }
    }
    
    return output.slice(0, outPos);
  }
  
  /**
   * Find best match using hash table
   */
  findBestMatch(input, pos) {
    if (pos + this.minLength > input.length) return null;
    
    let bestMatch = null;
    const maxPos = Math.min(input.length, pos + 65536);
    
    // Simple search (in production, use hash table)
    for (let i = Math.max(0, pos - this.maxOffset); i < pos; i++) {
      let len = 0;
      while (pos + len < maxPos && input[i + len] === input[pos + len]) {
        len++;
      }
      
      if (len >= this.minLength && (!bestMatch || len > bestMatch.length)) {
        bestMatch = {
          offset: pos - i,
          length: len,
          literalLen: 0
        };
      }
    }
    
    return bestMatch;
  }
  
  /**
   * Write literal to output
   */
  writeLiteral(input, pos, len, output, outPos) {
    if (len < 60) {
      output[outPos++] = (len - 1) << 2;
    } else {
      output[outPos++] = 59 << 2;
      outPos = this.writeVarint(len - 1, output, outPos);
    }
    
    input.copy(output, outPos, pos, pos + len);
    return outPos + len;
  }
  
  /**
   * Write copy to output
   */
  writeCopy(offset, len, output, outPos) {
    if (len < 12 && offset < 2048) {
      output[outPos++] = 1 | ((len - 4) << 2) | ((offset >> 8) << 5);
      output[outPos++] = offset & 255;
    } else {
      output[outPos++] = 2 | ((len - 1) << 2);
      output.writeUInt16LE(offset, outPos);
      outPos += 2;
    }
    
    return outPos;
  }
  
  /**
   * Write variable-length integer
   */
  writeVarint(value, output, pos) {
    while (value > 127) {
      output[pos++] = (value & 127) | 128;
      value >>>= 7;
    }
    output[pos++] = value;
    return pos;
  }
}

/**
 * Dictionary-based compressor
 */
export class DictionaryCompressor {
  constructor() {
    this.dictionary = new Map();
    this.reverseDict = new Map();
    this.nextCode = 256; // Start after ASCII
  }
  
  /**
   * Build dictionary from sample data
   */
  buildDictionary(samples) {
    const frequency = new Map();
    
    // Count substrings
    for (const sample of samples) {
      for (let len = 2; len <= 32; len++) {
        for (let i = 0; i <= sample.length - len; i++) {
          const substr = sample.slice(i, i + len).toString();
          frequency.set(substr, (frequency.get(substr) || 0) + 1);
        }
      }
    }
    
    // Select most frequent substrings
    const sorted = Array.from(frequency.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 1000);
    
    // Build dictionary
    for (const [substr, freq] of sorted) {
      if (freq > 10) { // Minimum frequency threshold
        this.dictionary.set(substr, this.nextCode);
        this.reverseDict.set(this.nextCode, substr);
        this.nextCode++;
      }
    }
    
    logger.info('Dictionary built', { entries: this.dictionary.size });
  }
  
  /**
   * Compress using dictionary
   */
  compress(input) {
    const output = [];
    let pos = 0;
    
    while (pos < input.length) {
      let matchLen = 0;
      let matchCode = null;
      
      // Find longest dictionary match
      for (let len = Math.min(32, input.length - pos); len >= 2; len--) {
        const substr = input.slice(pos, pos + len).toString();
        
        if (this.dictionary.has(substr)) {
          matchLen = len;
          matchCode = this.dictionary.get(substr);
          break;
        }
      }
      
      if (matchCode) {
        // Write dictionary reference
        output.push(matchCode >> 8, matchCode & 255);
        pos += matchLen;
      } else {
        // Write literal byte
        output.push(input[pos++]);
      }
    }
    
    return Buffer.from(output);
  }
  
  /**
   * Decompress using dictionary
   */
  decompress(input) {
    const output = [];
    let pos = 0;
    
    while (pos < input.length) {
      const byte = input[pos];
      
      if (byte === 0) {
        // Dictionary reference
        const code = (input[pos + 1] << 8) | input[pos + 2];
        const substr = this.reverseDict.get(code);
        
        if (substr) {
          output.push(...Buffer.from(substr));
          pos += 3;
        } else {
          output.push(byte);
          pos++;
        }
      } else {
        output.push(byte);
        pos++;
      }
    }
    
    return Buffer.from(output);
  }
}

/**
 * Adaptive compression selector
 */
export class AdaptiveCompressor {
  constructor() {
    this.algorithms = {
      none: { ratio: 1.0, speed: Infinity },
      lz4: { ratio: 0.7, speed: 500 }, // MB/s
      snappy: { ratio: 0.75, speed: 400 },
      gzip: { ratio: 0.4, speed: 50 },
      brotli: { ratio: 0.3, speed: 10 }
    };
    
    this.history = [];
    this.maxHistory = 100;
  }
  
  /**
   * Select best algorithm based on data characteristics
   */
  selectAlgorithm(data, requirements = {}) {
    const characteristics = this.analyzeData(data);
    
    // Requirements
    const maxLatency = requirements.maxLatency || 10; // ms
    const minRatio = requirements.minRatio || 0.9;
    const dataSize = data.length;
    
    let bestAlgorithm = 'none';
    let bestScore = -Infinity;
    
    for (const [name, specs] of Object.entries(this.algorithms)) {
      // Check if algorithm meets requirements
      const compressionTime = dataSize / (specs.speed * 1024 * 1024) * 1000;
      
      if (compressionTime > maxLatency) continue;
      if (specs.ratio > minRatio) continue;
      
      // Calculate score
      let score = 0;
      
      // Compression ratio weight
      score += (1 - specs.ratio) * 100;
      
      // Speed weight
      score += Math.log(specs.speed) * 10;
      
      // Adjust for data characteristics
      if (characteristics.entropy > 0.9 && name !== 'none') {
        score -= 50; // High entropy data compresses poorly
      }
      
      if (characteristics.repetitive && (name === 'lz4' || name === 'snappy')) {
        score += 30; // LZ algorithms good for repetitive data
      }
      
      if (score > bestScore) {
        bestScore = score;
        bestAlgorithm = name;
      }
    }
    
    // Record selection
    this.recordSelection(bestAlgorithm, characteristics);
    
    return bestAlgorithm;
  }
  
  /**
   * Analyze data characteristics
   */
  analyzeData(data) {
    const bytes = new Uint8Array(data);
    const frequency = new Array(256).fill(0);
    
    // Count byte frequencies
    for (const byte of bytes) {
      frequency[byte]++;
    }
    
    // Calculate entropy
    let entropy = 0;
    const len = bytes.length;
    
    for (const count of frequency) {
      if (count > 0) {
        const p = count / len;
        entropy -= p * Math.log2(p);
      }
    }
    
    entropy /= 8; // Normalize to 0-1
    
    // Check for repetitive patterns
    let repetitive = false;
    if (len > 100) {
      const sample = bytes.slice(0, 100);
      const sample2 = bytes.slice(100, 200);
      
      let matches = 0;
      for (let i = 0; i < Math.min(sample.length, sample2.length); i++) {
        if (sample[i] === sample2[i]) matches++;
      }
      
      repetitive = matches > 50;
    }
    
    return {
      size: len,
      entropy,
      repetitive,
      compressible: entropy < 0.8
    };
  }
  
  /**
   * Record algorithm selection for learning
   */
  recordSelection(algorithm, characteristics) {
    this.history.push({
      algorithm,
      characteristics,
      timestamp: Date.now()
    });
    
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
  }
  
  /**
   * Compress with selected algorithm
   */
  async compress(data, algorithm) {
    switch (algorithm) {
      case 'none':
        return data;
        
      case 'lz4':
        const lz4 = new LZ4Compressor();
        return lz4.compress(data);
        
      case 'snappy':
        const snappy = new SnappyCompressor();
        return snappy.compress(data);
        
      case 'gzip':
        return new Promise((resolve, reject) => {
          zlib.gzip(data, { level: 6 }, (err, result) => {
            if (err) reject(err);
            else resolve(result);
          });
        });
        
      case 'brotli':
        return new Promise((resolve, reject) => {
          zlib.brotliCompress(data, { 
            params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 }
          }, (err, result) => {
            if (err) reject(err);
            else resolve(result);
          });
        });
        
      default:
        throw new Error(`Unknown algorithm: ${algorithm}`);
    }
  }
}

/**
 * Streaming compressor with parallel processing
 */
export class StreamingCompressor {
  constructor(algorithm = 'gzip', options = {}) {
    this.algorithm = algorithm;
    this.chunkSize = options.chunkSize || 65536;
    this.workers = [];
    this.workerCount = options.workers || 4;
    
    this.initializeWorkers();
  }
  
  /**
   * Initialize compression workers
   */
  async initializeWorkers() {
    for (let i = 0; i < this.workerCount; i++) {
      const worker = await this.createCompressionWorker();
      this.workers.push(worker);
    }
  }
  
  /**
   * Create compression worker
   */
  async createCompressionWorker() {
    const workerCode = `
      const { parentPort } = require('worker_threads');
      const zlib = require('zlib');
      
      parentPort.on('message', (task) => {
        const { id, algorithm, data, options } = task;
        
        let compressed;
        switch (algorithm) {
          case 'gzip':
            compressed = zlib.gzipSync(Buffer.from(data), options);
            break;
          case 'deflate':
            compressed = zlib.deflateSync(Buffer.from(data), options);
            break;
          case 'brotli':
            compressed = zlib.brotliCompressSync(Buffer.from(data), options);
            break;
          default:
            compressed = Buffer.from(data);
        }
        
        parentPort.postMessage({
          id,
          compressed: compressed.buffer.slice(
            compressed.byteOffset,
            compressed.byteOffset + compressed.byteLength
          )
        }, [compressed.buffer]);
      });
    `;
    
    return new Worker(workerCode, { eval: true });
  }
  
  /**
   * Compress stream in parallel
   */
  createCompressStream() {
    let chunkId = 0;
    let workerIndex = 0;
    const pendingChunks = new Map();
    
    const transform = new Transform({
      async transform(chunk, encoding, callback) {
        const id = chunkId++;
        const worker = this.workers[workerIndex];
        workerIndex = (workerIndex + 1) % this.workerCount;
        
        // Setup result handler
        const handler = (msg) => {
          if (msg.id === id) {
            worker.off('message', handler);
            const compressed = Buffer.from(msg.compressed);
            callback(null, compressed);
          }
        };
        
        worker.on('message', handler);
        
        // Send to worker
        worker.postMessage({
          id,
          algorithm: this.algorithm,
          data: chunk,
          options: {}
        });
      }
    });
    
    return transform;
  }
}

/**
 * Compression optimizer main class
 */
export class CompressionOptimizer {
  constructor() {
    this.adaptive = new AdaptiveCompressor();
    this.dictionary = new DictionaryCompressor();
    this.streaming = null;
    
    this.stats = {
      totalBytes: 0,
      compressedBytes: 0,
      compressionTime: 0,
      decompressionTime: 0
    };
  }
  
  /**
   * Train dictionary on sample data
   */
  async trainDictionary(samples) {
    this.dictionary.buildDictionary(samples);
  }
  
  /**
   * Compress data with optimal algorithm
   */
  async compress(data, options = {}) {
    const startTime = Date.now();
    
    // Select algorithm
    const algorithm = options.algorithm || 
                     this.adaptive.selectAlgorithm(data, options);
    
    // Compress
    const compressed = await this.adaptive.compress(data, algorithm);
    
    // Update stats
    this.stats.totalBytes += data.length;
    this.stats.compressedBytes += compressed.length;
    this.stats.compressionTime += Date.now() - startTime;
    
    return {
      algorithm,
      data: compressed,
      originalSize: data.length,
      compressedSize: compressed.length,
      ratio: compressed.length / data.length
    };
  }
  
  /**
   * Create optimized compression stream
   */
  createStream(algorithm, options) {
    if (!this.streaming) {
      this.streaming = new StreamingCompressor(algorithm, options);
    }
    
    return this.streaming.createCompressStream();
  }
  
  /**
   * Get compression statistics
   */
  getStats() {
    const ratio = this.stats.totalBytes > 0 ?
      this.stats.compressedBytes / this.stats.totalBytes : 1;
    
    return {
      ...this.stats,
      compressionRatio: ratio,
      avgCompressionTime: this.stats.compressionTime / (this.stats.totalBytes / 1024 / 1024), // ms/MB
      throughput: this.stats.totalBytes / this.stats.compressionTime * 1000 // bytes/second
    };
  }
}

export default {
  CompressionOptimizer,
  LZ4Compressor,
  SnappyCompressor,
  DictionaryCompressor,
  AdaptiveCompressor,
  StreamingCompressor
};