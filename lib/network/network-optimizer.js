/**
 * Otedama High-Performance Network Optimizer
 * Advanced network optimizations for maximum throughput
 * 
 * Design:
 * - Carmack: Zero-copy, minimal allocations
 * - Martin: Clean network abstraction
 * - Pike: Simple but efficient
 */

import { createLogger } from '../core/logger.js';
import net from 'net';
import dgram from 'dgram';
import { EventEmitter } from 'events';
import { Buffer } from 'buffer';

const logger = createLogger('NetworkOptimizer');

/**
 * TCP socket options for optimization
 */
const TCP_OPTIMIZATIONS = {
  // Disable Nagle's algorithm for low latency
  TCP_NODELAY: true,
  
  // Keep connections alive
  SO_KEEPALIVE: true,
  
  // Reuse addresses
  SO_REUSEADDR: true,
  
  // Increase socket buffers
  SO_RCVBUF: 1024 * 1024 * 4,  // 4MB receive buffer
  SO_SNDBUF: 1024 * 1024 * 4,  // 4MB send buffer
  
  // TCP keep-alive parameters
  TCP_KEEPIDLE: 60,    // Start keepalive after 60s
  TCP_KEEPINTVL: 10,   // Interval between keepalive probes
  TCP_KEEPCNT: 6       // Number of keepalive probes
};

/**
 * Buffer allocation strategies
 */
export const BufferStrategy = {
  ZERO_COPY: 'zero_copy',
  POOL: 'pool',
  DIRECT: 'direct',
  SHARED: 'shared'
};

/**
 * Network Optimizer
 */
export class NetworkOptimizer extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      bufferStrategy: config.bufferStrategy || BufferStrategy.ZERO_COPY,
      enableTCPOptimizations: config.enableTCPOptimizations !== false,
      enableUDPOptimizations: config.enableUDPOptimizations !== false,
      maxBufferSize: config.maxBufferSize || 65536,
      bufferPoolSize: config.bufferPoolSize || 1000,
      socketTimeout: config.socketTimeout || 30000,
      enableNagleAlgorithm: config.enableNagleAlgorithm || false
    };
    
    // Buffer pools for zero-copy operations
    this.bufferPools = {
      small: [],   // 1KB buffers
      medium: [],  // 16KB buffers
      large: []    // 64KB buffers
    };
    
    // Pre-allocated buffers
    this.sharedBuffers = new Map();
    
    // Socket optimization cache
    this.optimizedSockets = new WeakSet();
    
    // Statistics
    this.stats = {
      buffersAllocated: 0,
      buffersReused: 0,
      zeroCopyOperations: 0,
      tcpOptimizations: 0,
      udpOptimizations: 0
    };
    
    // Initialize buffer pools
    this.initializeBufferPools();
  }
  
  /**
   * Initialize buffer pools
   */
  initializeBufferPools() {
    const poolSizes = {
      small: { size: 1024, count: this.config.bufferPoolSize },
      medium: { size: 16384, count: Math.floor(this.config.bufferPoolSize / 2) },
      large: { size: 65536, count: Math.floor(this.config.bufferPoolSize / 4) }
    };
    
    for (const [pool, config] of Object.entries(poolSizes)) {
      for (let i = 0; i < config.count; i++) {
        this.bufferPools[pool].push(Buffer.allocUnsafe(config.size));
      }
    }
    
    logger.info(`Initialized buffer pools: ${Object.keys(poolSizes).map(p => `${p}=${poolSizes[p].count}`).join(', ')}`);
  }
  
  /**
   * Optimize TCP socket
   */
  optimizeTCPSocket(socket) {
    if (this.optimizedSockets.has(socket)) return;
    
    if (!this.config.enableTCPOptimizations) return;
    
    try {
      // Disable Nagle's algorithm for low latency
      if (!this.config.enableNagleAlgorithm) {
        socket.setNoDelay(true);
      }
      
      // Enable keep-alive
      socket.setKeepAlive(true, TCP_OPTIMIZATIONS.TCP_KEEPIDLE * 1000);
      
      // Set socket timeout
      socket.setTimeout(this.config.socketTimeout);
      
      // Platform-specific optimizations
      if (socket._handle && socket._handle.setsockopt) {
        // Set socket buffer sizes
        try {
          socket._handle.setsockopt(socket._handle.SOL_SOCKET, socket._handle.SO_RCVBUF, TCP_OPTIMIZATIONS.SO_RCVBUF);
          socket._handle.setsockopt(socket._handle.SOL_SOCKET, socket._handle.SO_SNDBUF, TCP_OPTIMIZATIONS.SO_SNDBUF);
        } catch (e) {
          // Platform doesn't support these options
        }
      }
      
      // Mark as optimized
      this.optimizedSockets.add(socket);
      this.stats.tcpOptimizations++;
      
      logger.debug('TCP socket optimized');
      
    } catch (error) {
      logger.error('Failed to optimize TCP socket:', error);
    }
  }
  
  /**
   * Optimize UDP socket
   */
  optimizeUDPSocket(socket) {
    if (this.optimizedSockets.has(socket)) return;
    
    if (!this.config.enableUDPOptimizations) return;
    
    try {
      // Set receive buffer size
      socket.setRecvBufferSize(TCP_OPTIMIZATIONS.SO_RCVBUF);
      
      // Set send buffer size
      socket.setSendBufferSize(TCP_OPTIMIZATIONS.SO_SNDBUF);
      
      // Enable address reuse
      socket.on('listening', () => {
        const address = socket.address();
        logger.debug(`UDP socket optimized on ${address.address}:${address.port}`);
      });
      
      // Mark as optimized
      this.optimizedSockets.add(socket);
      this.stats.udpOptimizations++;
      
    } catch (error) {
      logger.error('Failed to optimize UDP socket:', error);
    }
  }
  
  /**
   * Get buffer from pool (zero-copy)
   */
  getBuffer(size) {
    let pool;
    let actualSize;
    
    // Select appropriate pool
    if (size <= 1024) {
      pool = 'small';
      actualSize = 1024;
    } else if (size <= 16384) {
      pool = 'medium';
      actualSize = 16384;
    } else {
      pool = 'large';
      actualSize = 65536;
    }
    
    // Try to get from pool
    const buffer = this.bufferPools[pool].pop();
    
    if (buffer) {
      this.stats.buffersReused++;
      return { buffer, size: actualSize, fromPool: true };
    }
    
    // Allocate new buffer if pool is empty
    this.stats.buffersAllocated++;
    return { 
      buffer: Buffer.allocUnsafe(actualSize), 
      size: actualSize, 
      fromPool: false 
    };
  }
  
  /**
   * Return buffer to pool
   */
  returnBuffer(buffer, size) {
    if (!Buffer.isBuffer(buffer)) return;
    
    // Clear sensitive data
    buffer.fill(0);
    
    // Return to appropriate pool
    if (size <= 1024 && this.bufferPools.small.length < this.config.bufferPoolSize) {
      this.bufferPools.small.push(buffer.slice(0, 1024));
    } else if (size <= 16384 && this.bufferPools.medium.length < Math.floor(this.config.bufferPoolSize / 2)) {
      this.bufferPools.medium.push(buffer.slice(0, 16384));
    } else if (size <= 65536 && this.bufferPools.large.length < Math.floor(this.config.bufferPoolSize / 4)) {
      this.bufferPools.large.push(buffer.slice(0, 65536));
    }
  }
  
  /**
   * Create optimized server
   */
  createOptimizedServer(options = {}) {
    const server = net.createServer(options);
    
    server.on('connection', (socket) => {
      this.optimizeTCPSocket(socket);
      
      // Emit optimized connection
      server.emit('optimizedConnection', socket);
    });
    
    // Optimize server socket
    server.on('listening', () => {
      if (server._handle && server._handle.setsockopt) {
        try {
          // Enable SO_REUSEADDR
          server._handle.setsockopt(server._handle.SOL_SOCKET, server._handle.SO_REUSEADDR, 1);
        } catch (e) {
          // Platform doesn't support
        }
      }
    });
    
    return server;
  }
  
  /**
   * Create zero-copy write stream
   */
  createZeroCopyStream(socket) {
    const stream = {
      socket,
      writeQueue: [],
      writing: false,
      
      write: (data) => {
        return new Promise((resolve, reject) => {
          stream.writeQueue.push({ data, resolve, reject });
          stream.processQueue();
        });
      },
      
      processQueue: async () => {
        if (stream.writing || stream.writeQueue.length === 0) return;
        
        stream.writing = true;
        
        while (stream.writeQueue.length > 0) {
          const { data, resolve, reject } = stream.writeQueue.shift();
          
          try {
            // Use zero-copy if possible
            if (Buffer.isBuffer(data)) {
              // Direct write without copying
              await new Promise((res, rej) => {
                socket.write(data, (err) => {
                  if (err) rej(err);
                  else res();
                });
              });
              this.stats.zeroCopyOperations++;
            } else {
              // Convert to buffer first
              const { buffer } = this.getBuffer(Buffer.byteLength(data));
              buffer.write(data);
              
              await new Promise((res, rej) => {
                socket.write(buffer, (err) => {
                  this.returnBuffer(buffer, buffer.length);
                  if (err) rej(err);
                  else res();
                });
              });
            }
            
            resolve();
          } catch (error) {
            reject(error);
          }
        }
        
        stream.writing = false;
      }
    };
    
    return stream;
  }
  
  /**
   * Batch write operations
   */
  createBatchWriter(socket, options = {}) {
    const batchSize = options.batchSize || 100;
    const flushInterval = options.flushInterval || 10;
    
    const writer = {
      socket,
      batch: [],
      timer: null,
      
      write: (data) => {
        writer.batch.push(data);
        
        if (writer.batch.length >= batchSize) {
          writer.flush();
        } else if (!writer.timer) {
          writer.timer = setTimeout(() => writer.flush(), flushInterval);
        }
      },
      
      flush: () => {
        if (writer.timer) {
          clearTimeout(writer.timer);
          writer.timer = null;
        }
        
        if (writer.batch.length === 0) return;
        
        // Combine all data into single buffer
        const totalSize = writer.batch.reduce((sum, data) => {
          return sum + (Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data));
        }, 0);
        
        const { buffer } = this.getBuffer(totalSize);
        let offset = 0;
        
        for (const data of writer.batch) {
          if (Buffer.isBuffer(data)) {
            data.copy(buffer, offset);
            offset += data.length;
          } else {
            offset += buffer.write(data, offset);
          }
        }
        
        // Single write operation
        socket.write(buffer.slice(0, offset), () => {
          this.returnBuffer(buffer, totalSize);
        });
        
        writer.batch = [];
        this.stats.zeroCopyOperations++;
      },
      
      end: () => {
        writer.flush();
        socket.end();
      }
    };
    
    return writer;
  }
  
  /**
   * Create connection pool
   */
  createConnectionPool(options = {}) {
    const pool = {
      host: options.host || 'localhost',
      port: options.port || 80,
      minConnections: options.minConnections || 5,
      maxConnections: options.maxConnections || 20,
      idleTimeout: options.idleTimeout || 30000,
      connections: [],
      pending: [],
      
      acquire: () => {
        return new Promise((resolve, reject) => {
          // Try to find idle connection
          const idle = pool.connections.find(conn => !conn.busy && conn.socket.readyState === 'open');
          
          if (idle) {
            idle.busy = true;
            idle.lastUsed = Date.now();
            resolve(idle.socket);
            return;
          }
          
          // Create new connection if under limit
          if (pool.connections.length < pool.maxConnections) {
            const socket = new net.Socket();
            const conn = {
              socket,
              busy: true,
              lastUsed: Date.now()
            };
            
            this.optimizeTCPSocket(socket);
            
            socket.connect(pool.port, pool.host, () => {
              pool.connections.push(conn);
              resolve(socket);
            });
            
            socket.on('error', (err) => {
              pool.connections = pool.connections.filter(c => c !== conn);
              reject(err);
            });
            
            socket.on('close', () => {
              pool.connections = pool.connections.filter(c => c !== conn);
            });
          } else {
            // Queue the request
            pool.pending.push({ resolve, reject });
          }
        });
      },
      
      release: (socket) => {
        const conn = pool.connections.find(c => c.socket === socket);
        if (conn) {
          conn.busy = false;
          conn.lastUsed = Date.now();
          
          // Process pending requests
          if (pool.pending.length > 0) {
            const { resolve } = pool.pending.shift();
            conn.busy = true;
            resolve(socket);
          }
        }
      },
      
      destroy: (socket) => {
        pool.connections = pool.connections.filter(c => c.socket !== socket);
        socket.destroy();
      },
      
      // Cleanup idle connections
      cleanup: () => {
        const now = Date.now();
        pool.connections = pool.connections.filter(conn => {
          if (!conn.busy && now - conn.lastUsed > pool.idleTimeout) {
            conn.socket.destroy();
            return false;
          }
          return true;
        });
      }
    };
    
    // Maintain minimum connections
    const maintainMinConnections = () => {
      const activeCount = pool.connections.filter(c => c.socket.readyState === 'open').length;
      const needed = pool.minConnections - activeCount;
      
      for (let i = 0; i < needed; i++) {
        pool.acquire().then(socket => pool.release(socket)).catch(() => {});
      }
    };
    
    // Setup maintenance
    setInterval(() => {
      pool.cleanup();
      maintainMinConnections();
    }, 10000);
    
    // Initial connections
    maintainMinConnections();
    
    return pool;
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      bufferPools: {
        small: this.bufferPools.small.length,
        medium: this.bufferPools.medium.length,
        large: this.bufferPools.large.length
      }
    };
  }
  
  /**
   * Clear buffer pools
   */
  clearBufferPools() {
    this.bufferPools.small = [];
    this.bufferPools.medium = [];
    this.bufferPools.large = [];
    this.initializeBufferPools();
  }
}

export default NetworkOptimizer;
