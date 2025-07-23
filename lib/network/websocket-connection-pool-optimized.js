/**
 * Optimized WebSocket Connection Pool
 * Enhanced version with advanced features and optimizations
 */

const WebSocket = require('ws');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const BasePool = require('../common/base-pool');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

class OptimizedWebSocketConnectionPool extends BasePool {
  constructor(options = {}) {
    super('OptimizedWebSocketConnectionPool', {
      // Pool configuration
      minSize: options.minConnections || 2,
      maxSize: options.maxConnections || 100,
      acquireTimeout: options.connectionTimeout || 10000,
      
      // WebSocket specific configuration
      urls: options.urls || [options.url] || ['ws://localhost:8080'],
      protocols: options.protocols || [],
      headers: options.headers || {},
      
      // Timing
      heartbeatInterval: options.heartbeatInterval || 30000,
      reconnectDelay: options.reconnectDelay || 1000,
      maxReconnectDelay: options.maxReconnectDelay || 30000,
      reconnectDecay: options.reconnectDecay || 1.5,
      
      // Message handling
      enableCompression: options.enableCompression !== false,
      compressionThreshold: options.compressionThreshold || 1024, // Compress messages > 1KB
      enableBinary: options.enableBinary !== false,
      maxMessageSize: options.maxMessageSize || 10 * 1024 * 1024, // 10MB
      enableBatching: options.enableBatching !== false,
      batchInterval: options.batchInterval || 10, // ms
      batchSize: options.batchSize || 100,
      
      // Load balancing
      loadBalancingStrategy: options.loadBalancingStrategy || 'weighted-round-robin',
      
      // Authentication
      authHandler: options.authHandler || null,
      
      // Connection health
      healthCheckInterval: options.healthCheckInterval || 60000,
      maxIdleTime: options.maxIdleTime || 300000, // 5 minutes
      
      // Circuit breaker
      circuitBreakerThreshold: options.circuitBreakerThreshold || 5,
      circuitBreakerTimeout: options.circuitBreakerTimeout || 60000,
      
      ...options
    });
    
    // Enhanced state management
    this.messageHandlers = new Map();
    this.responseCallbacks = new Map();
    this.connectionDetails = new Map();
    this.urlStats = new Map(); // Track stats per URL for multi-endpoint support
    this.messageBatches = new Map(); // Message batching per connection
    this.circuitBreakers = new Map(); // Circuit breakers per URL
    
    // Enhanced metrics
    this.wsMetrics = {
      sent: 0,
      received: 0,
      batched: 0,
      compressed: 0,
      totalBytesIn: 0,
      totalBytesOut: 0,
      compressedBytesOut: 0,
      averageLatency: 0,
      messageRate: 0,
      compressionRatio: 1.0,
      p95Latency: 0,
      p99Latency: 0
    };
    
    // URL rotation for multi-endpoint support
    this.currentUrlIndex = 0;
  }
  
  /**
   * Initialize enhanced features
   */
  async onInitialize() {
    // Initialize URL stats
    for (const url of this.config.urls) {
      this.urlStats.set(url, {
        connections: 0,
        failures: 0,
        totalLatency: 0,
        messageCount: 0
      });
      
      this.circuitBreakers.set(url, {
        failures: 0,
        lastFailure: 0,
        state: 'closed' // closed, open, half-open
      });
    }
    
    // Start enhanced timers
    this.startTimer('heartbeat', () => this.sendHeartbeats(), this.config.heartbeatInterval);
    this.startTimer('wsStats', () => this.updateWebSocketStats(), 5000);
    this.startTimer('healthCheck', () => this.performHealthChecks(), this.config.healthCheckInterval);
    this.startTimer('batchFlush', () => this.flushBatches(), this.config.batchInterval);
  }
  
  /**
   * Create an optimized WebSocket connection
   */
  async onCreateResource() {
    const connectionId = crypto.randomBytes(16).toString('hex');
    const url = this.selectUrl();
    
    // Check circuit breaker
    const breaker = this.circuitBreakers.get(url);
    if (breaker.state === 'open') {
      const timeSinceFailure = Date.now() - breaker.lastFailure;
      if (timeSinceFailure < this.config.circuitBreakerTimeout) {
        throw new Error(`Circuit breaker open for ${url}`);
      }
      // Try half-open
      breaker.state = 'half-open';
    }
    
    const details = {
      id: connectionId,
      url,
      ws: null,
      state: 'connecting',
      createdAt: Date.now(),
      lastActivity: Date.now(),
      reconnectAttempts: 0,
      metrics: {
        messagesSent: 0,
        messagesReceived: 0,
        bytesIn: 0,
        bytesOut: 0,
        compressedMessages: 0,
        latency: [],
        compressionSavings: 0
      },
      weight: 1.0 // For weighted load balancing
    };
    
    return new Promise((resolve, reject) => {
      try {
        details.ws = new WebSocket(url, this.config.protocols, {
          headers: this.config.headers,
          perMessageDeflate: false, // We'll handle compression ourselves
          maxPayload: this.config.maxMessageSize
        });
        
        details.ws.on('open', async () => {
          details.state = 'connected';
          
          // Authenticate if handler provided
          if (this.config.authHandler) {
            try {
              await this.config.authHandler(details.ws);
            } catch (authError) {
              details.ws.close();
              reject(authError);
              return;
            }
          }
          
          this.setupEnhancedHandlers(details);
          this.connectionDetails.set(details.ws, details);
          this.messageBatches.set(connectionId, []);
          
          // Update URL stats
          const urlStat = this.urlStats.get(url);
          urlStat.connections++;
          
          // Reset circuit breaker on success
          if (breaker.state === 'half-open') {
            breaker.state = 'closed';
            breaker.failures = 0;
          }
          
          this.emit('connection:created', { id: connectionId, url });
          resolve(details.ws);
        });
        
        details.ws.on('error', (error) => {
          details.state = 'error';
          this.handleCircuitBreaker(url);
          reject(error);
        });
        
      } catch (error) {
        this.handleCircuitBreaker(url);
        reject(error);
      }
    });
  }
  
  /**
   * Select URL with load balancing and circuit breaker consideration
   */
  selectUrl() {
    const availableUrls = this.config.urls.filter(url => {
      const breaker = this.circuitBreakers.get(url);
      return breaker.state !== 'open' || 
             (Date.now() - breaker.lastFailure) >= this.config.circuitBreakerTimeout;
    });
    
    if (availableUrls.length === 0) {
      throw new Error('All URLs are circuit broken');
    }
    
    // Round-robin through available URLs
    this.currentUrlIndex = (this.currentUrlIndex + 1) % availableUrls.length;
    return availableUrls[this.currentUrlIndex];
  }
  
  /**
   * Handle circuit breaker logic
   */
  handleCircuitBreaker(url) {
    const breaker = this.circuitBreakers.get(url);
    breaker.failures++;
    breaker.lastFailure = Date.now();
    
    if (breaker.failures >= this.config.circuitBreakerThreshold) {
      breaker.state = 'open';
      this.logger.warn(`Circuit breaker opened for ${url}`);
      this.emit('circuit-breaker:open', { url, failures: breaker.failures });
    }
  }
  
  /**
   * Setup enhanced connection handlers
   */
  setupEnhancedHandlers(details) {
    const ws = details.ws;
    
    ws.on('message', async (data, isBinary) => {
      try {
        details.lastActivity = Date.now();
        details.metrics.messagesReceived++;
        details.metrics.bytesIn += data.length;
        
        this.wsMetrics.received++;
        this.wsMetrics.totalBytesIn += data.length;
        
        // Decompress if needed
        let messageData = data;
        if (isBinary && this.isCompressed(data)) {
          messageData = await gunzip(data);
        }
        
        const message = this.parseMessage(messageData, false);
        
        // Handle batched messages
        if (message.batch) {
          for (const batchedMessage of message.messages) {
            await this.processMessage(batchedMessage, details);
          }
        } else {
          await this.processMessage(message, details);
        }
        
      } catch (error) {
        this.recordFailure(error);
      }
    });
    
    ws.on('close', (code, reason) => {
      details.state = 'closed';
      this.handleConnectionClose(details, code, reason);
      
      // Update URL stats
      const urlStat = this.urlStats.get(details.url);
      urlStat.connections--;
    });
    
    ws.on('error', (error) => {
      details.state = 'error';
      this.recordFailure(error);
      this.handleCircuitBreaker(details.url);
      
      // Update URL stats
      const urlStat = this.urlStats.get(details.url);
      urlStat.failures++;
    });
    
    ws.on('ping', () => {
      details.lastActivity = Date.now();
    });
    
    ws.on('pong', () => {
      details.lastActivity = Date.now();
      // Calculate ping latency
      if (details.pingTimestamp) {
        const latency = Date.now() - details.pingTimestamp;
        details.metrics.latency.push(latency);
        if (details.metrics.latency.length > 100) {
          details.metrics.latency.shift();
        }
      }
    });
  }
  
  /**
   * Process individual message
   */
  async processMessage(message, details) {
    // Handle response callbacks
    if (message.id && this.responseCallbacks.has(message.id)) {
      const callback = this.responseCallbacks.get(message.id);
      this.responseCallbacks.delete(message.id);
      
      if (message.error) {
        callback.reject(new Error(message.error));
      } else {
        callback.resolve(message.result);
      }
      
      // Update latency
      const latency = Date.now() - callback.timestamp;
      details.metrics.latency.push(latency);
      if (details.metrics.latency.length > 100) {
        details.metrics.latency.shift();
      }
      
      // Update URL stats
      const urlStat = this.urlStats.get(details.url);
      urlStat.totalLatency += latency;
      urlStat.messageCount++;
      
      return;
    }
    
    // Handle regular messages
    this.handleMessage(message, details);
  }
  
  /**
   * Enhanced send with batching and compression
   */
  async send(message, options = {}) {
    if (this.config.enableBatching && !options.immediate) {
      return this.queueForBatch(message, options);
    }
    
    const ws = await this.getConnectionWithStrategy();
    const details = this.connectionDetails.get(ws);
    
    try {
      const messageId = options.id || crypto.randomBytes(16).toString('hex');
      const payload = await this.prepareOptimizedMessage({
        id: messageId,
        ...message,
        timestamp: Date.now()
      });
      
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.responseCallbacks.delete(messageId);
          reject(new Error('Response timeout'));
        }, options.timeout || 30000);
        
        // Store callback if expecting response
        if (options.expectResponse !== false) {
          this.responseCallbacks.set(messageId, {
            resolve: (result) => {
              clearTimeout(timeout);
              resolve(result);
            },
            reject: (error) => {
              clearTimeout(timeout);
              reject(error);
            },
            timestamp: Date.now()
          });
        }
        
        ws.send(payload.data, { binary: payload.binary }, (error) => {
          if (error) {
            this.responseCallbacks.delete(messageId);
            clearTimeout(timeout);
            reject(error);
          } else {
            details.metrics.messagesSent++;
            details.metrics.bytesOut += payload.data.length;
            
            if (payload.compressed) {
              details.metrics.compressedMessages++;
              details.metrics.compressionSavings += payload.originalSize - payload.data.length;
              this.wsMetrics.compressed++;
              this.wsMetrics.compressedBytesOut += payload.data.length;
            }
            
            this.wsMetrics.sent++;
            this.wsMetrics.totalBytesOut += payload.data.length;
            
            if (options.expectResponse === false) {
              clearTimeout(timeout);
              resolve();
            }
          }
        });
      });
      
    } finally {
      await this.release(ws);
    }
  }
  
  /**
   * Queue message for batch sending
   */
  async queueForBatch(message, options) {
    const ws = await this.getConnectionWithStrategy();
    const details = this.connectionDetails.get(ws);
    const batch = this.messageBatches.get(details.id);
    
    try {
      return new Promise((resolve, reject) => {
        const messageId = options.id || crypto.randomBytes(16).toString('hex');
        
        batch.push({
          message: {
            id: messageId,
            ...message,
            timestamp: Date.now()
          },
          resolve,
          reject,
          options,
          addedAt: Date.now()
        });
        
        // Flush if batch is full
        if (batch.length >= this.config.batchSize) {
          this.flushBatch(details.id);
        }
      });
    } finally {
      await this.release(ws);
    }
  }
  
  /**
   * Flush all batches
   */
  async flushBatches() {
    for (const [connectionId, batch] of this.messageBatches.entries()) {
      if (batch.length > 0) {
        await this.flushBatch(connectionId);
      }
    }
  }
  
  /**
   * Flush a specific batch
   */
  async flushBatch(connectionId) {
    const batch = this.messageBatches.get(connectionId);
    if (!batch || batch.length === 0) return;
    
    const details = Array.from(this.connectionDetails.values())
      .find(d => d.id === connectionId);
    
    if (!details || details.state !== 'connected') {
      // Reject all messages in batch
      for (const item of batch) {
        item.reject(new Error('Connection not available'));
      }
      batch.length = 0;
      return;
    }
    
    const messages = batch.map(item => item.message);
    batch.length = 0;
    
    try {
      const payload = await this.prepareOptimizedMessage({
        batch: true,
        messages,
        timestamp: Date.now()
      });
      
      details.ws.send(payload.data, { binary: payload.binary }, (error) => {
        if (error) {
          // Reject all messages
          for (const item of batch) {
            item.reject(error);
          }
        } else {
          // Update metrics
          details.metrics.messagesSent += messages.length;
          details.metrics.bytesOut += payload.data.length;
          
          this.wsMetrics.sent += messages.length;
          this.wsMetrics.batched += messages.length;
          this.wsMetrics.totalBytesOut += payload.data.length;
          
          if (payload.compressed) {
            details.metrics.compressedMessages++;
            this.wsMetrics.compressed++;
          }
          
          // Resolve all messages
          for (const item of batch) {
            if (item.options.expectResponse === false) {
              item.resolve();
            }
          }
        }
      });
      
    } catch (error) {
      // Reject all messages in batch
      for (const item of batch) {
        item.reject(error);
      }
    }
  }
  
  /**
   * Prepare optimized message with optional compression
   */
  async prepareOptimizedMessage(message) {
    const jsonStr = JSON.stringify(message);
    const originalSize = Buffer.byteLength(jsonStr);
    
    // Compress if enabled and message is large enough
    if (this.config.enableCompression && originalSize > this.config.compressionThreshold) {
      try {
        const compressed = await gzip(jsonStr);
        
        // Only use compression if it actually saves space
        if (compressed.length < originalSize * 0.9) {
          return {
            data: Buffer.concat([Buffer.from([0x01]), compressed]), // 0x01 = compressed flag
            binary: true,
            compressed: true,
            originalSize
          };
        }
      } catch (error) {
        this.logger.warn('Compression failed:', error);
      }
    }
    
    // Return uncompressed
    if (this.config.enableBinary) {
      return {
        data: Buffer.concat([Buffer.from([0x00]), Buffer.from(jsonStr)]), // 0x00 = uncompressed flag
        binary: true,
        compressed: false,
        originalSize
      };
    } else {
      return {
        data: jsonStr,
        binary: false,
        compressed: false,
        originalSize
      };
    }
  }
  
  /**
   * Check if data is compressed
   */
  isCompressed(data) {
    return Buffer.isBuffer(data) && data.length > 0 && data[0] === 0x01;
  }
  
  /**
   * Parse message with decompression support
   */
  parseMessage(data, isBinary) {
    if (isBinary || Buffer.isBuffer(data)) {
      // Check compression flag
      if (data.length > 0 && data[0] === 0x00) {
        // Uncompressed binary
        return JSON.parse(data.slice(1).toString());
      } else if (data.length > 0 && data[0] === 0x01) {
        // Should have been decompressed already
        throw new Error('Unexpected compressed data');
      }
      
      // Legacy format
      return JSON.parse(data.toString());
    } else {
      return JSON.parse(data);
    }
  }
  
  /**
   * Enhanced connection selection with weighted strategies
   */
  async getConnectionWithStrategy() {
    const connections = Array.from(this.connectionDetails.values())
      .filter(d => d.state === 'connected' && this.availableResources.includes(d.ws));
    
    if (connections.length === 0) {
      return await this.acquire();
    }
    
    let selected;
    
    switch (this.config.loadBalancingStrategy) {
      case 'least-loaded':
        selected = connections.reduce((min, conn) => 
          conn.metrics.messagesSent < min.metrics.messagesSent ? conn : min
        );
        break;
        
      case 'lowest-latency':
        selected = connections.reduce((min, conn) => {
          const avgLatency = conn.metrics.latency.length > 0
            ? conn.metrics.latency.reduce((a, b) => a + b, 0) / conn.metrics.latency.length
            : Infinity;
          const minAvgLatency = min.metrics.latency.length > 0
            ? min.metrics.latency.reduce((a, b) => a + b, 0) / min.metrics.latency.length
            : Infinity;
          return avgLatency < minAvgLatency ? conn : min;
        });
        break;
        
      case 'weighted-round-robin':
        // Calculate weights based on performance
        const totalWeight = connections.reduce((sum, conn) => sum + conn.weight, 0);
        let random = Math.random() * totalWeight;
        
        for (const conn of connections) {
          random -= conn.weight;
          if (random <= 0) {
            selected = conn;
            break;
          }
        }
        break;
        
      case 'random':
        selected = connections[Math.floor(Math.random() * connections.length)];
        break;
        
      default: // round-robin
        return await this.acquire();
    }
    
    if (selected) {
      // Remove from available and return
      const index = this.availableResources.indexOf(selected.ws);
      if (index !== -1) {
        this.availableResources.splice(index, 1);
        this.activeResources.add(selected.ws);
        return selected.ws;
      }
    }
    
    return await this.acquire();
  }
  
  /**
   * Perform health checks on all connections
   */
  async performHealthChecks() {
    const now = Date.now();
    
    for (const details of this.connectionDetails.values()) {
      if (details.state === 'connected') {
        // Check idle time
        if (now - details.lastActivity > this.config.maxIdleTime) {
          this.logger.info(`Closing idle connection ${details.id}`);
          details.ws.close(1000, 'Idle timeout');
          continue;
        }
        
        // Update connection weight based on performance
        if (details.metrics.latency.length > 0) {
          const avgLatency = details.metrics.latency.reduce((a, b) => a + b, 0) / 
                           details.metrics.latency.length;
          
          // Weight inversely proportional to latency
          details.weight = Math.max(0.1, Math.min(10, 100 / avgLatency));
        }
      }
    }
  }
  
  /**
   * Send heartbeats with latency measurement
   */
  sendHeartbeats() {
    const now = Date.now();
    
    for (const details of this.connectionDetails.values()) {
      if (details.state === 'connected') {
        // Check if connection is stale
        if (now - details.lastActivity > this.config.heartbeatInterval * 3) {
          details.ws.close();
          continue;
        }
        
        // Send ping with timestamp
        if (details.ws.readyState === WebSocket.OPEN) {
          details.pingTimestamp = now;
          details.ws.ping();
        }
      }
    }
  }
  
  /**
   * Update WebSocket statistics with percentiles
   */
  updateWebSocketStats() {
    // Calculate message rate
    const prevTotal = this.wsMetrics.sent + this.wsMetrics.received;
    setTimeout(() => {
      const currentTotal = this.wsMetrics.sent + this.wsMetrics.received;
      this.wsMetrics.messageRate = (currentTotal - prevTotal) / 5; // per second
    }, 0);
    
    // Calculate latency percentiles
    const allLatencies = [];
    for (const details of this.connectionDetails.values()) {
      allLatencies.push(...details.metrics.latency);
    }
    
    if (allLatencies.length > 0) {
      allLatencies.sort((a, b) => a - b);
      
      this.wsMetrics.averageLatency = allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length;
      this.wsMetrics.p95Latency = allLatencies[Math.floor(allLatencies.length * 0.95)] || 0;
      this.wsMetrics.p99Latency = allLatencies[Math.floor(allLatencies.length * 0.99)] || 0;
    }
    
    // Calculate compression ratio
    if (this.wsMetrics.totalBytesOut > 0) {
      const uncompressedEstimate = this.wsMetrics.totalBytesOut + 
        Array.from(this.connectionDetails.values())
          .reduce((sum, d) => sum + d.metrics.compressionSavings, 0);
      
      this.wsMetrics.compressionRatio = uncompressedEstimate / this.wsMetrics.totalBytesOut;
    }
  }
  
  /**
   * Get enhanced statistics
   */
  async getStats() {
    const baseStats = await super.getStats();
    
    const urlStatsArray = Array.from(this.urlStats.entries()).map(([url, stats]) => ({
      url,
      ...stats,
      averageLatency: stats.messageCount > 0 ? stats.totalLatency / stats.messageCount : 0,
      circuitBreaker: this.circuitBreakers.get(url)
    }));
    
    return {
      ...baseStats,
      websocket: {
        ...this.wsMetrics,
        connections: {
          total: this.connectionDetails.size,
          active: Array.from(this.connectionDetails.values())
            .filter(d => d.state === 'connected').length,
          connecting: Array.from(this.connectionDetails.values())
            .filter(d => d.state === 'connecting').length,
          error: Array.from(this.connectionDetails.values())
            .filter(d => d.state === 'error').length
        },
        urlStats: urlStatsArray,
        batchingStats: {
          pendingBatches: Array.from(this.messageBatches.values())
            .reduce((sum, batch) => sum + batch.length, 0),
          totalBatches: this.messageBatches.size
        }
      }
    };
  }
  
  /**
   * Custom health check
   */
  async onHealthCheck() {
    const baseHealth = await super.onHealthCheck();
    
    const healthyUrls = Array.from(this.circuitBreakers.entries())
      .filter(([url, breaker]) => breaker.state === 'closed')
      .map(([url]) => url);
    
    return {
      ...baseHealth,
      websocket: {
        activeConnections: Array.from(this.connectionDetails.values())
          .filter(d => d.state === 'connected').length,
        messageRate: this.wsMetrics.messageRate,
        averageLatency: this.wsMetrics.averageLatency,
        p95Latency: this.wsMetrics.p95Latency,
        p99Latency: this.wsMetrics.p99Latency,
        compressionRatio: this.wsMetrics.compressionRatio,
        healthyEndpoints: healthyUrls.length,
        totalEndpoints: this.config.urls.length
      }
    };
  }
  
  /**
   * Cleanup on shutdown
   */
  async onShutdown() {
    // Flush all pending batches
    await this.flushBatches();
    
    // Clear callbacks
    for (const [id, callback] of this.responseCallbacks) {
      callback.reject(new Error('Connection pool shutting down'));
    }
    this.responseCallbacks.clear();
    
    // Clear message handlers
    this.messageHandlers.clear();
    this.messageBatches.clear();
    
    // Call parent shutdown
    await super.onShutdown();
  }
  
  // Inherit message handling methods from original implementation
  on(event, handler) {
    if (!this.messageHandlers.has(event)) {
      this.messageHandlers.set(event, []);
    }
    
    this.messageHandlers.get(event).push(handler);
    return this;
  }
  
  off(event, handler) {
    if (this.messageHandlers.has(event)) {
      const handlers = this.messageHandlers.get(event);
      const index = handlers.indexOf(handler);
      
      if (index !== -1) {
        handlers.splice(index, 1);
      }
      
      if (handlers.length === 0) {
        this.messageHandlers.delete(event);
      }
    }
    
    return this;
  }
  
  handleMessage(message, details) {
    const event = message.type || message.event || 'message';
    const handlers = this.messageHandlers.get(event) || [];
    
    for (const handler of handlers) {
      try {
        handler(message, details);
      } catch (error) {
        this.recordFailure(error);
      }
    }
    
    // Emit generic message event
    this.emit('message', {
      message,
      connectionId: details.id
    });
  }
  
  /**
   * Broadcast with optimization
   */
  async broadcast(message, options = {}) {
    const connections = Array.from(this.connectionDetails.values())
      .filter(details => details.state === 'connected');
    
    if (connections.length === 0) {
      throw new Error('No active connections');
    }
    
    const payload = await this.prepareOptimizedMessage({
      ...message,
      timestamp: Date.now(),
      broadcast: true
    });
    
    const results = await Promise.allSettled(
      connections.map(details => 
        new Promise((resolve, reject) => {
          details.ws.send(payload.data, { binary: payload.binary }, (error) => {
            if (error) {
              reject(error);
            } else {
              details.metrics.messagesSent++;
              details.metrics.bytesOut += payload.data.length;
              
              if (payload.compressed) {
                details.metrics.compressedMessages++;
              }
              
              resolve(details.id);
            }
          });
        })
      )
    );
    
    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    
    this.wsMetrics.sent += successful;
    this.wsMetrics.totalBytesOut += payload.data.length * successful;
    
    if (payload.compressed) {
      this.wsMetrics.compressed += successful;
    }
    
    return {
      successful,
      failed,
      total: connections.length,
      compressionSaved: payload.compressed ? 
        (payload.originalSize - payload.data.length) * successful : 0
    };
  }
  
  /**
   * Handle connection close with enhanced reconnection
   */
  handleConnectionClose(details, code, reason) {
    this.emit('connection:closed', {
      id: details.id,
      code,
      reason,
      url: details.url
    });
    
    // Clean up batch for this connection
    this.messageBatches.delete(details.id);
    
    // Attempt reconnection
    if (details.reconnectAttempts < 10) {
      const delay = Math.min(
        this.config.reconnectDelay * Math.pow(this.config.reconnectDecay, details.reconnectAttempts),
        this.config.maxReconnectDelay
      );
      
      setTimeout(() => {
        this.executeWithRetry(
          async () => {
            const newWs = await this.onCreateResource();
            const newDetails = this.connectionDetails.get(newWs);
            
            this.emit('connection:reconnected', {
              oldId: details.id,
              newId: newDetails.id,
              attempts: details.reconnectAttempts + 1
            });
            
            return newWs;
          },
          'reconnect'
        ).catch(error => {
          this.emit('connection:reconnect:failed', {
            id: details.id,
            error,
            attempts: details.reconnectAttempts
          });
        });
      }, delay);
    }
  }
}

module.exports = OptimizedWebSocketConnectionPool;