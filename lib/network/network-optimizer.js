import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import net from 'net';
import dgram from 'dgram';
import { promisify } from 'util';

export class NetworkOptimizer extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      enableOptimization: options.enableOptimization !== false,
      enableCompression: options.enableCompression !== false,
      enableKeepAlive: options.enableKeepAlive !== false,
      enableBatching: options.enableBatching !== false,
      maxConnections: options.maxConnections || 10000,
      connectionTimeout: options.connectionTimeout || 30000,
      keepAliveInterval: options.keepAliveInterval || 60000,
      batchSize: options.batchSize || 100,
      batchTimeout: options.batchTimeout || 10, // ms
      bufferSize: options.bufferSize || 64 * 1024, // 64KB
      ...options
    };

    this.connections = new Map();
    this.messageQueue = new Map();
    this.batchQueues = new Map();
    this.compressionCache = new Map();
    
    this.stats = {
      totalConnections: 0,
      activeConnections: 0,
      bytesTransmitted: 0,
      bytesReceived: 0,
      messagesProcessed: 0,
      compressionRatio: 0,
      latencyStats: {
        min: Infinity,
        max: 0,
        avg: 0,
        samples: []
      }
    };

    this.initializeNetworkOptimizer();
  }

  async initializeNetworkOptimizer() {
    try {
      this.setupConnectionPooling();
      this.setupMessageBatching();
      this.setupCompressionSystem();
      this.setupLatencyOptimization();
      this.startNetworkMonitoring();
      
      this.emit('networkOptimizerInitialized', {
        optimization: this.options.enableOptimization,
        compression: this.options.enableCompression,
        batching: this.options.enableBatching,
        maxConnections: this.options.maxConnections,
        timestamp: Date.now()
      });
      
      console.log('🌐 Network Optimizer initialized');
    } catch (error) {
      this.emit('networkOptimizerError', { error: error.message, timestamp: Date.now() });
      throw error;
    }
  }

  setupConnectionPooling() {
    if (!this.options.enableOptimization) return;

    this.connectionPool = {
      pools: new Map(),
      
      getConnection: (host, port) => {
        const poolKey = `${host}:${port}`;
        let pool = this.connectionPool.pools.get(poolKey);
        
        if (!pool) {
          pool = {
            available: [],
            busy: new Set(),
            host,
            port,
            created: 0,
            maxConnections: Math.min(100, this.options.maxConnections / 10)
          };
          this.connectionPool.pools.set(poolKey, pool);
        }
        
        return this.getPooledConnection(pool);
      },
      
      releaseConnection: (connection, pool) => {
        if (pool.busy.has(connection)) {
          pool.busy.delete(connection);
          
          if (pool.available.length < pool.maxConnections / 2) {
            pool.available.push(connection);
            this.resetConnection(connection);
          } else {
            connection.destroy();
          }
        }
      }
    };
  }

  async getPooledConnection(pool) {
    // Try to get available connection
    if (pool.available.length > 0) {
      const connection = pool.available.pop();
      pool.busy.add(connection);
      return connection;
    }
    
    // Create new connection if under limit
    if (pool.created < pool.maxConnections) {
      const connection = await this.createOptimizedConnection(pool.host, pool.port);
      pool.busy.add(connection);
      pool.created++;
      
      // Handle connection cleanup
      connection.on('close', () => {
        pool.busy.delete(connection);
        const availableIndex = pool.available.indexOf(connection);
        if (availableIndex !== -1) {
          pool.available.splice(availableIndex, 1);
        }
        pool.created--;
      });
      
      return connection;
    }
    
    // Wait for available connection
    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        if (pool.available.length > 0) {
          clearInterval(checkInterval);
          const connection = pool.available.pop();
          pool.busy.add(connection);
          resolve(connection);
        }
      }, 10);
      
      setTimeout(() => {
        clearInterval(checkInterval);
        reject(new Error('Connection pool timeout'));
      }, this.options.connectionTimeout);
    });
  }

  async createOptimizedConnection(host, port) {
    const connection = net.createConnection({ host, port });
    
    // Optimize socket settings
    connection.setKeepAlive(this.options.enableKeepAlive, this.options.keepAliveInterval);
    connection.setNoDelay(true); // Disable Nagle's algorithm
    connection.setTimeout(this.options.connectionTimeout);
    
    // Set buffer sizes
    if (connection.setRecvBufferSize) {
      connection.setRecvBufferSize(this.options.bufferSize);
    }
    if (connection.setSendBufferSize) {
      connection.setSendBufferSize(this.options.bufferSize);
    }
    
    // Track connection
    this.connections.set(connection.remoteAddress + ':' + connection.remotePort, {
      connection,
      created: Date.now(),
      bytesTransmitted: 0,
      bytesReceived: 0,
      messagesProcessed: 0
    });
    
    this.stats.totalConnections++;
    this.stats.activeConnections++;
    
    connection.on('close', () => {
      this.stats.activeConnections--;
    });
    
    return connection;
  }

  resetConnection(connection) {
    // Reset connection state for reuse
    connection.removeAllListeners('data');
    connection.removeAllListeners('error');
    connection.setTimeout(this.options.connectionTimeout);
  }

  setupMessageBatching() {
    if (!this.options.enableBatching) return;

    this.batchProcessor = {
      queues: new Map(),
      
      addMessage: (connectionId, message) => {
        let queue = this.batchProcessor.queues.get(connectionId);
        
        if (!queue) {
          queue = {
            messages: [],
            timer: null,
            lastFlush: Date.now()
          };
          this.batchProcessor.queues.set(connectionId, queue);
        }
        
        queue.messages.push(message);
        
        // Flush if batch size reached
        if (queue.messages.length >= this.options.batchSize) {
          this.flushBatch(connectionId, queue);
        } else if (!queue.timer) {
          // Set timer for batch timeout
          queue.timer = setTimeout(() => {
            this.flushBatch(connectionId, queue);
          }, this.options.batchTimeout);
        }
      },
      
      flush: (connectionId) => {
        const queue = this.batchProcessor.queues.get(connectionId);
        if (queue && queue.messages.length > 0) {
          this.flushBatch(connectionId, queue);
        }
      }
    };
  }

  flushBatch(connectionId, queue) {
    if (queue.messages.length === 0) return;
    
    const connection = this.getConnectionById(connectionId);
    if (!connection) return;
    
    // Create batch message
    const batchMessage = {
      type: 'batch',
      count: queue.messages.length,
      messages: queue.messages,
      timestamp: Date.now()
    };
    
    const serialized = JSON.stringify(batchMessage);
    let data = Buffer.from(serialized + '\n');
    
    // Compress if enabled
    if (this.options.enableCompression) {
      data = this.compressData(data);
    }
    
    // Send batch
    connection.write(data);
    
    this.updateStats('transmitted', data.length, queue.messages.length);
    
    // Reset queue
    queue.messages = [];
    queue.lastFlush = Date.now();
    
    if (queue.timer) {
      clearTimeout(queue.timer);
      queue.timer = null;
    }
    
    this.emit('batchFlushed', {
      connectionId,
      messageCount: batchMessage.count,
      dataSize: data.length,
      timestamp: Date.now()
    });
  }

  setupCompressionSystem() {
    if (!this.options.enableCompression) return;

    // Simple compression using repetition detection and dictionary
    this.compressionSystem = {
      dictionary: new Map(),
      
      compress: (data) => {
        // Simple compression: replace common patterns with shorter codes
        let compressed = data.toString();
        
        // Replace common JSON patterns
        const patterns = {
          '{"method":"': '\x01',
          '","params":': '\x02',
          ',"result":': '\x03',
          ',"error":null': '\x04',
          '"timestamp":': '\x05'
        };
        
        for (const [pattern, code] of Object.entries(patterns)) {
          compressed = compressed.replace(new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), code);
        }
        
        const compressedBuffer = Buffer.from(compressed);
        const originalSize = data.length;
        const compressedSize = compressedBuffer.length;
        
        this.updateCompressionStats(originalSize, compressedSize);
        
        return compressedBuffer;
      },
      
      decompress: (data) => {
        let decompressed = data.toString();
        
        // Restore patterns
        const patterns = {
          '\x01': '{"method":"',
          '\x02': '","params":',
          '\x03': ',"result":',
          '\x04': ',"error":null',
          '\x05': '"timestamp":'
        };
        
        for (const [code, pattern] of Object.entries(patterns)) {
          decompressed = decompressed.replace(new RegExp(code, 'g'), pattern);
        }
        
        return Buffer.from(decompressed);
      }
    };
  }

  compressData(data) {
    if (!this.options.enableCompression) return data;
    return this.compressionSystem.compress(data);
  }

  decompressData(data) {
    if (!this.options.enableCompression) return data;
    return this.compressionSystem.decompress(data);
  }

  updateCompressionStats(originalSize, compressedSize) {
    const compressionRatio = compressedSize / originalSize;
    
    // Update rolling average
    if (this.stats.compressionRatio === 0) {
      this.stats.compressionRatio = compressionRatio;
    } else {
      this.stats.compressionRatio = (this.stats.compressionRatio * 0.9) + (compressionRatio * 0.1);
    }
  }

  setupLatencyOptimization() {
    this.latencyOptimizer = {
      measureLatency: (connectionId, callback) => {
        const startTime = performance.now();
        
        return (...args) => {
          const latency = performance.now() - startTime;
          this.updateLatencyStats(latency);
          
          this.emit('latencyMeasured', {
            connectionId,
            latency,
            timestamp: Date.now()
          });
          
          if (callback) callback(...args);
        };
      },
      
      optimizeForLatency: (connection) => {
        // Disable Nagle's algorithm for low latency
        connection.setNoDelay(true);
        
        // Set TCP_NODELAY and TCP_QUICKACK if available
        if (connection._handle && connection._handle.setNoDelay) {
          connection._handle.setNoDelay(true);
        }
      }
    };
  }

  updateLatencyStats(latency) {
    const stats = this.stats.latencyStats;
    
    stats.min = Math.min(stats.min, latency);
    stats.max = Math.max(stats.max, latency);
    
    stats.samples.push(latency);
    
    // Keep only last 1000 samples
    if (stats.samples.length > 1000) {
      stats.samples = stats.samples.slice(-1000);
    }
    
    // Calculate average
    stats.avg = stats.samples.reduce((sum, sample) => sum + sample, 0) / stats.samples.length;
  }

  startNetworkMonitoring() {
    // Monitor network statistics every 30 seconds
    setInterval(() => {
      this.updateNetworkStats();
    }, 30000);
    
    // Optimize connections every 5 minutes
    setInterval(() => {
      this.optimizeConnections();
    }, 300000);
    
    // Clean up old connections every 10 minutes
    setInterval(() => {
      this.cleanupConnections();
    }, 600000);
  }

  updateNetworkStats() {
    let totalBytesTransmitted = 0;
    let totalBytesReceived = 0;
    let totalMessagesProcessed = 0;
    
    for (const connectionInfo of this.connections.values()) {
      totalBytesTransmitted += connectionInfo.bytesTransmitted;
      totalBytesReceived += connectionInfo.bytesReceived;
      totalMessagesProcessed += connectionInfo.messagesProcessed;
    }
    
    this.stats.bytesTransmitted = totalBytesTransmitted;
    this.stats.bytesReceived = totalBytesReceived;
    this.stats.messagesProcessed = totalMessagesProcessed;
    
    this.emit('networkStatsUpdated', {
      stats: this.getNetworkStats(),
      timestamp: Date.now()
    });
  }

  optimizeConnections() {
    for (const [key, connectionInfo] of this.connections) {
      const connection = connectionInfo.connection;
      const age = Date.now() - connectionInfo.created;
      
      // Optimize long-lived connections
      if (age > 300000) { // 5 minutes
        this.latencyOptimizer.optimizeForLatency(connection);
      }
      
      // Adjust buffer sizes based on usage
      const avgMessageSize = connectionInfo.bytesTransmitted / Math.max(1, connectionInfo.messagesProcessed);
      
      if (avgMessageSize > this.options.bufferSize / 2) {
        // Increase buffer size for large messages
        if (connection.setRecvBufferSize) {
          connection.setRecvBufferSize(this.options.bufferSize * 2);
        }
      }
    }
  }

  cleanupConnections() {
    const now = Date.now();
    const timeout = this.options.connectionTimeout * 2;
    
    for (const [key, connectionInfo] of this.connections) {
      if (now - connectionInfo.created > timeout && connectionInfo.connection.readyState !== 'open') {
        connectionInfo.connection.destroy();
        this.connections.delete(key);
      }
    }
  }

  // Public API
  async sendMessage(connectionId, message) {
    if (this.options.enableBatching) {
      this.batchProcessor.addMessage(connectionId, message);
      return;
    }
    
    const connection = this.getConnectionById(connectionId);
    if (!connection) {
      throw new Error('Connection not found');
    }
    
    const serialized = JSON.stringify(message);
    let data = Buffer.from(serialized + '\n');
    
    if (this.options.enableCompression) {
      data = this.compressData(data);
    }
    
    const callback = this.latencyOptimizer.measureLatency(connectionId);
    
    connection.write(data, callback);
    
    this.updateStats('transmitted', data.length, 1);
  }

  async sendBatch(connectionId, messages) {
    const connection = this.getConnectionById(connectionId);
    if (!connection) {
      throw new Error('Connection not found');
    }
    
    const batchMessage = {
      type: 'batch',
      count: messages.length,
      messages: messages,
      timestamp: Date.now()
    };
    
    const serialized = JSON.stringify(batchMessage);
    let data = Buffer.from(serialized + '\n');
    
    if (this.options.enableCompression) {
      data = this.compressData(data);
    }
    
    connection.write(data);
    
    this.updateStats('transmitted', data.length, messages.length);
  }

  flushConnection(connectionId) {
    if (this.options.enableBatching) {
      this.batchProcessor.flush(connectionId);
    }
  }

  flushAllConnections() {
    if (this.options.enableBatching) {
      for (const connectionId of this.batchProcessor.queues.keys()) {
        this.batchProcessor.flush(connectionId);
      }
    }
  }

  getConnectionById(connectionId) {
    const connectionInfo = this.connections.get(connectionId);
    return connectionInfo ? connectionInfo.connection : null;
  }

  updateStats(type, bytes, messages) {
    if (type === 'transmitted') {
      this.stats.bytesTransmitted += bytes;
    } else if (type === 'received') {
      this.stats.bytesReceived += bytes;
    }
    
    this.stats.messagesProcessed += messages;
  }

  // Statistics and Monitoring
  getNetworkStats() {
    const compressionEfficiency = this.options.enableCompression 
      ? Math.round((1 - this.stats.compressionRatio) * 100)
      : 0;
    
    return {
      connections: {
        total: this.stats.totalConnections,
        active: this.stats.activeConnections,
        pools: this.connectionPool ? this.connectionPool.pools.size : 0
      },
      throughput: {
        bytesTransmitted: this.stats.bytesTransmitted,
        bytesReceived: this.stats.bytesReceived,
        messagesProcessed: this.stats.messagesProcessed,
        compressionEfficiency: compressionEfficiency + '%'
      },
      latency: {
        min: Math.round(this.stats.latencyStats.min * 100) / 100,
        max: Math.round(this.stats.latencyStats.max * 100) / 100,
        avg: Math.round(this.stats.latencyStats.avg * 100) / 100,
        samples: this.stats.latencyStats.samples.length
      },
      batching: this.options.enableBatching ? {
        queues: this.batchProcessor ? this.batchProcessor.queues.size : 0,
        batchSize: this.options.batchSize,
        batchTimeout: this.options.batchTimeout
      } : null,
      optimization: {
        keepAlive: this.options.enableKeepAlive,
        compression: this.options.enableCompression,
        batching: this.options.enableBatching,
        pooling: this.connectionPool !== null
      },
      timestamp: Date.now()
    };
  }

  getBandwidthUsage() {
    const uptime = process.uptime();
    
    return {
      transmitted: {
        total: `${Math.round(this.stats.bytesTransmitted / 1024 / 1024 * 100) / 100} MB`,
        rate: `${Math.round(this.stats.bytesTransmitted / uptime / 1024 * 100) / 100} KB/s`
      },
      received: {
        total: `${Math.round(this.stats.bytesReceived / 1024 / 1024 * 100) / 100} MB`,
        rate: `${Math.round(this.stats.bytesReceived / uptime / 1024 * 100) / 100} KB/s`
      },
      compression: this.options.enableCompression ? {
        ratio: `${Math.round(this.stats.compressionRatio * 100)}%`,
        savings: `${Math.round((1 - this.stats.compressionRatio) * 100)}%`
      } : null
    };
  }

  async performNetworkDiagnostic() {
    const diagnostic = {
      connections: {
        total: this.connections.size,
        healthy: 0,
        stale: 0,
        errors: 0
      },
      performance: {
        avgLatency: this.stats.latencyStats.avg,
        throughput: this.stats.messagesProcessed / Math.max(1, process.uptime()),
        compressionRatio: this.stats.compressionRatio
      },
      issues: []
    };
    
    // Check connection health
    for (const [key, connectionInfo] of this.connections) {
      const age = Date.now() - connectionInfo.created;
      const connection = connectionInfo.connection;
      
      if (connection.readyState === 'open') {
        diagnostic.connections.healthy++;
      } else if (age > this.options.connectionTimeout) {
        diagnostic.connections.stale++;
        diagnostic.issues.push(`Stale connection: ${key}`);
      } else if (connection.destroyed) {
        diagnostic.connections.errors++;
        diagnostic.issues.push(`Destroyed connection: ${key}`);
      }
    }
    
    // Performance issues
    if (this.stats.latencyStats.avg > 100) {
      diagnostic.issues.push(`High average latency: ${Math.round(this.stats.latencyStats.avg)}ms`);
    }
    
    if (this.options.enableCompression && this.stats.compressionRatio > 0.9) {
      diagnostic.issues.push(`Low compression efficiency: ${Math.round(this.stats.compressionRatio * 100)}%`);
    }
    
    return diagnostic;
  }

  async shutdown() {
    // Flush all pending batches
    this.flushAllConnections();
    
    // Close all connections
    for (const connectionInfo of this.connections.values()) {
      if (connectionInfo.connection && !connectionInfo.connection.destroyed) {
        connectionInfo.connection.destroy();
      }
    }
    
    this.connections.clear();
    
    this.emit('networkOptimizerShutdown', { timestamp: Date.now() });
    console.log('🌐 Network Optimizer shutdown complete');
  }
}

export default NetworkOptimizer;