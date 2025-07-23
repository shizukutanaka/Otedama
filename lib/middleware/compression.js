const zlib = require('zlib');
const { createLogger } = require('../core/logger');

/**
 * Compression Middleware
 * Provides response compression for better performance
 */
class CompressionMiddleware {
  constructor(config = {}) {
    this.logger = createLogger('compression');
    
    this.config = {
      // Compression level (0-9, where 9 is best compression)
      level: config.level !== undefined ? config.level : 6,
      
      // Minimum response size to compress (bytes)
      threshold: config.threshold || 1024,
      
      // Chunk size for streaming
      chunkSize: config.chunkSize || 16 * 1024,
      
      // Memory level (1-9, where 9 uses most memory)
      memLevel: config.memLevel || 8,
      
      // Strategy
      strategy: config.strategy || zlib.constants.Z_DEFAULT_STRATEGY,
      
      // Window bits
      windowBits: config.windowBits || zlib.constants.Z_DEFAULT_WINDOWBITS,
      
      // Filter function to determine if response should be compressed
      filter: config.filter || this.defaultFilter,
      
      // Supported encodings in order of preference
      encodings: config.encodings || ['br', 'gzip', 'deflate'],
      
      // Brotli options
      brotli: {
        params: {
          [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
          [zlib.constants.BROTLI_PARAM_QUALITY]: config.brotli?.quality || 4,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: config.brotli?.sizeHint || 0
        }
      },
      
      // Cache compressed responses
      cache: config.cache !== false,
      cacheMaxAge: config.cacheMaxAge || 3600000, // 1 hour
      
      ...config
    };
    
    // Compression cache
    this.cache = new Map();
    
    // Statistics
    this.stats = {
      totalRequests: 0,
      compressedRequests: 0,
      totalBytesIn: 0,
      totalBytesOut: 0,
      cacheHits: 0,
      cacheMisses: 0
    };
    
    // Start cache cleanup
    if (this.config.cache) {
      this.startCacheCleanup();
    }
  }
  
  /**
   * Compression middleware
   */
  middleware() {
    return (req, res, next) => {
      this.stats.totalRequests++;
      
      // Check if compression should be applied
      const acceptEncoding = req.headers['accept-encoding'] || '';
      
      if (!acceptEncoding) {
        return next();
      }
      
      // Parse accepted encodings
      const accepted = this.parseAcceptEncoding(acceptEncoding);
      const encoding = this.selectEncoding(accepted);
      
      if (!encoding) {
        return next();
      }
      
      // Store original methods
      const originalWrite = res.write;
      const originalEnd = res.end;
      const originalOn = res.on;
      
      // Compression state
      let stream;
      let ended = false;
      let buffers = [];
      let totalLength = 0;
      
      // Override write method
      res.write = function(chunk, encoding) {
        if (ended) {
          return false;
        }
        
        if (!stream) {
          // First write - decide if we should compress
          if (!this.shouldCompress(req, res, chunk)) {
            // Restore original methods and continue
            res.write = originalWrite;
            res.end = originalEnd;
            return originalWrite.call(res, chunk, encoding);
          }
          
          // Initialize compression
          stream = this.createCompressionStream(encoding);
          this.setupCompressionHeaders(res, encoding);
          this.stats.compressedRequests++;
          
          // Pipe compressed data to response
          stream.on('data', (compressed) => {
            this.stats.totalBytesOut += compressed.length;
            originalWrite.call(res, compressed);
          });
          
          stream.on('error', (err) => {
            this.logger.error('Compression error:', err);
            res.removeHeader('content-encoding');
            res.statusCode = 500;
            originalEnd.call(res);
          });
        }
        
        // Convert chunk to buffer
        if (!Buffer.isBuffer(chunk)) {
          chunk = Buffer.from(chunk, encoding);
        }
        
        // Track input size
        this.stats.totalBytesIn += chunk.length;
        totalLength += chunk.length;
        
        // Add to buffers for potential caching
        if (this.config.cache) {
          buffers.push(chunk);
        }
        
        // Write to compression stream
        return stream.write(chunk);
      }.bind(this);
      
      // Override end method
      res.end = function(chunk, encoding) {
        if (ended) {
          return;
        }
        ended = true;
        
        if (chunk) {
          res.write(chunk, encoding);
        }
        
        if (!stream) {
          // No compression was applied
          return originalEnd.call(res);
        }
        
        // End compression stream
        stream.end();
        
        stream.on('finish', () => {
          // Cache compressed response if applicable
          if (this.config.cache && res.statusCode === 200 && totalLength > 0) {
            this.cacheResponse(req, buffers, encoding);
          }
          
          originalEnd.call(res);
        });
      }.bind(this);
      
      // Check cache first
      if (this.config.cache && req.method === 'GET') {
        const cached = this.getCachedResponse(req, encoding);
        if (cached) {
          this.stats.cacheHits++;
          this.setupCompressionHeaders(res, encoding);
          res.setHeader('X-Compression-Cache', 'HIT');
          return res.end(cached);
        }
        this.stats.cacheMisses++;
      }
      
      next();
    };
  }
  
  /**
   * Default filter function
   */
  defaultFilter(req, res) {
    // Don't compress for Cache-Control: no-transform
    if (res.getHeader('cache-control')?.includes('no-transform')) {
      return false;
    }
    
    // Compress based on content type
    const contentType = res.getHeader('content-type') || '';
    
    // Compressible content types
    const compressible = [
      /^text\//i,
      /^application\/json/i,
      /^application\/javascript/i,
      /^application\/xml/i,
      /^application\/.*\+json/i,
      /^application\/.*\+xml/i,
      /^image\/svg\+xml/i
    ];
    
    return compressible.some(pattern => pattern.test(contentType));
  }
  
  /**
   * Parse Accept-Encoding header
   */
  parseAcceptEncoding(acceptEncoding) {
    const encodings = {};
    
    acceptEncoding.split(',').forEach(part => {
      const [encoding, q] = part.trim().split(';q=');
      encodings[encoding] = q ? parseFloat(q) : 1.0;
    });
    
    return encodings;
  }
  
  /**
   * Select best encoding
   */
  selectEncoding(accepted) {
    // Special cases
    if (accepted['*']) {
      return this.config.encodings[0];
    }
    
    // Find best match
    for (const encoding of this.config.encodings) {
      if (accepted[encoding] && accepted[encoding] > 0) {
        // Check if Node.js supports this encoding
        if (encoding === 'br' && !zlib.createBrotliCompress) {
          continue;
        }
        return encoding;
      }
    }
    
    return null;
  }
  
  /**
   * Check if response should be compressed
   */
  shouldCompress(req, res, firstChunk) {
    // Check filter
    if (!this.config.filter(req, res)) {
      return false;
    }
    
    // Check if already encoded
    if (res.getHeader('content-encoding')) {
      return false;
    }
    
    // Check threshold
    const contentLength = res.getHeader('content-length');
    if (contentLength && parseInt(contentLength) < this.config.threshold) {
      return false;
    }
    
    // If no content-length, check first chunk size
    if (!contentLength && firstChunk && firstChunk.length < this.config.threshold) {
      // Might be a small response
      return false;
    }
    
    return true;
  }
  
  /**
   * Create compression stream
   */
  createCompressionStream(encoding) {
    const options = {
      level: this.config.level,
      memLevel: this.config.memLevel,
      strategy: this.config.strategy,
      chunkSize: this.config.chunkSize
    };
    
    switch (encoding) {
      case 'gzip':
        return zlib.createGzip(options);
        
      case 'deflate':
        return zlib.createDeflate(options);
        
      case 'br':
        if (zlib.createBrotliCompress) {
          return zlib.createBrotliCompress({
            chunkSize: this.config.chunkSize,
            params: this.config.brotli.params
          });
        }
        // Fall through if Brotli not supported
        
      default:
        throw new Error(`Unsupported encoding: ${encoding}`);
    }
  }
  
  /**
   * Setup compression headers
   */
  setupCompressionHeaders(res, encoding) {
    // Remove content-length as it will change
    res.removeHeader('content-length');
    
    // Set content-encoding
    res.setHeader('content-encoding', encoding);
    
    // Add Vary header
    const vary = res.getHeader('vary');
    if (!vary) {
      res.setHeader('vary', 'Accept-Encoding');
    } else if (!vary.includes('Accept-Encoding')) {
      res.setHeader('vary', `${vary}, Accept-Encoding`);
    }
  }
  
  /**
   * Cache compressed response
   */
  cacheResponse(req, buffers, encoding) {
    if (buffers.length === 0) {
      return;
    }
    
    const key = this.getCacheKey(req, encoding);
    const content = Buffer.concat(buffers);
    
    // Compress content for cache
    const compressor = this.createCompressionStream(encoding);
    const compressed = [];
    
    compressor.on('data', chunk => compressed.push(chunk));
    compressor.on('end', () => {
      const compressedContent = Buffer.concat(compressed);
      
      this.cache.set(key, {
        content: compressedContent,
        timestamp: Date.now(),
        size: compressedContent.length,
        originalSize: content.length
      });
      
      // Log compression ratio
      const ratio = ((1 - compressedContent.length / content.length) * 100).toFixed(2);
      this.logger.debug(`Cached compressed response: ${key} (${ratio}% reduction)`);
    });
    
    compressor.end(content);
  }
  
  /**
   * Get cached response
   */
  getCachedResponse(req, encoding) {
    const key = this.getCacheKey(req, encoding);
    const cached = this.cache.get(key);
    
    if (!cached) {
      return null;
    }
    
    // Check if expired
    if (Date.now() - cached.timestamp > this.config.cacheMaxAge) {
      this.cache.delete(key);
      return null;
    }
    
    return cached.content;
  }
  
  /**
   * Generate cache key
   */
  getCacheKey(req, encoding) {
    return `${req.method}:${req.url}:${encoding}`;
  }
  
  /**
   * Start cache cleanup interval
   */
  startCacheCleanup() {
    setInterval(() => {
      const now = Date.now();
      let removed = 0;
      
      for (const [key, value] of this.cache.entries()) {
        if (now - value.timestamp > this.config.cacheMaxAge) {
          this.cache.delete(key);
          removed++;
        }
      }
      
      if (removed > 0) {
        this.logger.debug(`Removed ${removed} expired cache entries`);
      }
      
      // Also limit cache size
      if (this.cache.size > 1000) {
        // Remove oldest entries
        const entries = Array.from(this.cache.entries())
          .sort((a, b) => a[1].timestamp - b[1].timestamp);
        
        const toRemove = entries.slice(0, entries.length - 1000);
        toRemove.forEach(([key]) => this.cache.delete(key));
      }
    }, 300000); // Every 5 minutes
  }
  
  /**
   * Get compression statistics
   */
  getStats() {
    const compressionRatio = this.stats.totalBytesIn > 0
      ? 1 - (this.stats.totalBytesOut / this.stats.totalBytesIn)
      : 0;
    
    return {
      ...this.stats,
      compressionRatio,
      compressionPercentage: (compressionRatio * 100).toFixed(2) + '%',
      cacheHitRate: this.stats.cacheHits + this.stats.cacheMisses > 0
        ? (this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses))
        : 0,
      cacheSize: this.cache.size
    };
  }
  
  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
    this.logger.info('Compression cache cleared');
  }
  
  /**
   * Factory method with presets
   */
  static create(preset = 'default') {
    const presets = {
      default: {
        level: 6,
        threshold: 1024
      },
      speed: {
        level: 1,
        threshold: 2048,
        cache: true
      },
      size: {
        level: 9,
        threshold: 512,
        brotli: { quality: 11 }
      },
      api: {
        level: 6,
        threshold: 860, // Typical MTU minus headers
        encodings: ['gzip', 'deflate'] // Wider compatibility
      }
    };
    
    const config = presets[preset] || presets.default;
    return new CompressionMiddleware(config).middleware();
  }
}

module.exports = {
  CompressionMiddleware,
  compression: CompressionMiddleware.create
};