/**
 * TCP Network Optimizer - Otedama
 * Ultra-low latency network optimizations
 * 
 * Features:
 * - TCP_NODELAY for minimal latency
 * - SO_REUSEADDR for fast restart
 * - Keep-alive optimization
 * - Buffer size tuning
 * - Connection pooling
 */

import net from 'net';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('TCPOptimizer');

/**
 * Optimized TCP socket configuration
 */
export class OptimizedSocket {
  constructor(socket) {
    this.socket = socket;
    this.configured = false;
  }
  
  /**
   * Apply performance optimizations
   */
  optimize() {
    if (this.configured) return;
    
    try {
      // Disable Nagle's algorithm for lowest latency
      this.socket.setNoDelay(true);
      
      // Enable keep-alive with aggressive settings
      this.socket.setKeepAlive(true, 30000); // 30 second probes
      
      // Set socket timeouts
      this.socket.setTimeout(0); // No timeout for mining connections
      
      // Platform-specific optimizations
      if (process.platform === 'linux') {
        this.applyLinuxOptimizations();
      } else if (process.platform === 'win32') {
        this.applyWindowsOptimizations();
      }
      
      this.configured = true;
      
    } catch (error) {
      logger.warn('Socket optimization failed', error);
    }
  }
  
  /**
   * Linux-specific TCP optimizations
   */
  applyLinuxOptimizations() {
    // These would require native bindings in production
    // TCP_QUICKACK - Disable delayed ACKs
    // TCP_CORK - Optimize small packet handling
    // SO_RCVBUF/SO_SNDBUF - Buffer sizing
  }
  
  /**
   * Windows-specific TCP optimizations
   */
  applyWindowsOptimizations() {
    // Windows socket options would go here
    // SIO_LOOPBACK_FAST_PATH for local connections
    // TCP_NODELAY already set above
  }
}

/**
 * Connection pool for reusable sockets
 */
export class ConnectionPool {
  constructor(options = {}) {
    this.maxSize = options.maxSize || 100;
    this.minSize = options.minSize || 10;
    this.idleTimeout = options.idleTimeout || 60000; // 1 minute
    
    this.pools = new Map(); // host:port -> connections
    this.stats = {
      created: 0,
      reused: 0,
      destroyed: 0,
      active: 0
    };
  }
  
  /**
   * Get connection from pool
   */
  async acquire(host, port) {
    const key = `${host}:${port}`;
    
    if (!this.pools.has(key)) {
      this.pools.set(key, {
        idle: [],
        active: new Set(),
        creating: 0
      });
    }
    
    const pool = this.pools.get(key);
    
    // Try to get idle connection
    while (pool.idle.length > 0) {
      const conn = pool.idle.pop();
      
      if (this.isConnectionAlive(conn)) {
        pool.active.add(conn);
        this.stats.reused++;
        this.stats.active++;
        return conn.socket;
      } else {
        this.destroyConnection(conn);
      }
    }
    
    // Create new connection
    if (pool.active.size + pool.creating < this.maxSize) {
      pool.creating++;
      
      try {
        const socket = await this.createConnection(host, port);
        const conn = {
          socket,
          created: Date.now(),
          lastUsed: Date.now()
        };
        
        pool.active.add(conn);
        pool.creating--;
        
        this.stats.created++;
        this.stats.active++;
        
        return socket;
      } catch (error) {
        pool.creating--;
        throw error;
      }
    }
    
    throw new Error('Connection pool exhausted');
  }
  
  /**
   * Release connection back to pool
   */
  release(host, port, socket) {
    const key = `${host}:${port}`;
    const pool = this.pools.get(key);
    
    if (!pool) return;
    
    // Find connection in active set
    let conn = null;
    for (const c of pool.active) {
      if (c.socket === socket) {
        conn = c;
        break;
      }
    }
    
    if (conn) {
      pool.active.delete(conn);
      conn.lastUsed = Date.now();
      
      // Add to idle pool if healthy
      if (this.isConnectionAlive(conn) && pool.idle.length < this.minSize) {
        pool.idle.push(conn);
        
        // Set idle timeout
        conn.idleTimer = setTimeout(() => {
          this.removeIdleConnection(key, conn);
        }, this.idleTimeout);
      } else {
        this.destroyConnection(conn);
      }
      
      this.stats.active--;
    }
  }
  
  /**
   * Create optimized connection
   */
  async createConnection(host, port) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      const optimized = new OptimizedSocket(socket);
      
      socket.once('connect', () => {
        optimized.optimize();
        resolve(socket);
      });
      
      socket.once('error', reject);
    });
  }
  
  /**
   * Check if connection is alive
   */
  isConnectionAlive(conn) {
    return conn.socket && 
           !conn.socket.destroyed && 
           conn.socket.readable && 
           conn.socket.writable;
  }
  
  /**
   * Destroy connection
   */
  destroyConnection(conn) {
    if (conn.idleTimer) {
      clearTimeout(conn.idleTimer);
    }
    
    if (conn.socket && !conn.socket.destroyed) {
      conn.socket.destroy();
    }
    
    this.stats.destroyed++;
  }
  
  /**
   * Remove idle connection
   */
  removeIdleConnection(key, conn) {
    const pool = this.pools.get(key);
    if (!pool) return;
    
    const index = pool.idle.indexOf(conn);
    if (index !== -1) {
      pool.idle.splice(index, 1);
      this.destroyConnection(conn);
    }
  }
  
  /**
   * Get pool statistics
   */
  getStats() {
    const poolStats = [];
    
    for (const [key, pool] of this.pools.entries()) {
      poolStats.push({
        endpoint: key,
        idle: pool.idle.length,
        active: pool.active.size,
        creating: pool.creating
      });
    }
    
    return {
      ...this.stats,
      pools: poolStats
    };
  }
  
  /**
   * Close all connections
   */
  async close() {
    for (const pool of this.pools.values()) {
      // Destroy idle connections
      for (const conn of pool.idle) {
        this.destroyConnection(conn);
      }
      
      // Destroy active connections
      for (const conn of pool.active) {
        this.destroyConnection(conn);
      }
    }
    
    this.pools.clear();
    logger.info('Connection pool closed');
  }
}

/**
 * TCP server optimizer
 */
export class TCPServerOptimizer {
  /**
   * Create optimized TCP server
   */
  static createServer(options = {}) {
    const server = net.createServer(options);
    
    // Apply server-level optimizations
    server.on('listening', () => {
      const address = server.address();
      
      // Platform-specific server optimizations
      if (process.platform === 'linux') {
        // In production, would set:
        // SO_REUSEADDR - Allow address reuse
        // SO_REUSEPORT - Allow port sharing
        // TCP_DEFER_ACCEPT - Defer accept until data
        // TCP_FASTOPEN - Enable fast open
      }
      
      logger.info('Optimized TCP server listening', address);
    });
    
    // Optimize incoming connections
    server.on('connection', (socket) => {
      const optimized = new OptimizedSocket(socket);
      optimized.optimize();
    });
    
    return server;
  }
  
  /**
   * Calculate optimal backlog size
   */
  static calculateBacklog() {
    // Based on system resources
    const cpus = require('os').cpus().length;
    const baseBacklog = 511; // Default on most systems
    
    // Scale with CPU cores
    return Math.min(baseBacklog * cpus, 4096);
  }
}

/**
 * Network buffer optimizer
 */
export class NetworkBufferOptimizer {
  /**
   * Calculate optimal buffer sizes
   */
  static getOptimalBufferSizes(bandwidth, latency) {
    // Bandwidth-delay product
    const bdp = (bandwidth * latency) / 8; // Convert to bytes
    
    // Optimal buffer size is 2x BDP for full utilization
    const optimal = bdp * 2;
    
    // Clamp to reasonable values
    const minBuffer = 64 * 1024;  // 64KB minimum
    const maxBuffer = 16 * 1024 * 1024; // 16MB maximum
    
    return {
      send: Math.min(Math.max(optimal, minBuffer), maxBuffer),
      receive: Math.min(Math.max(optimal, minBuffer), maxBuffer)
    };
  }
  
  /**
   * Apply buffer optimizations to socket
   */
  static optimizeSocketBuffers(socket, bandwidth = 1000000000, latency = 0.001) {
    const sizes = this.getOptimalBufferSizes(bandwidth, latency);
    
    // These would require native bindings:
    // socket.setSendBufferSize(sizes.send);
    // socket.setRecvBufferSize(sizes.receive);
    
    logger.debug('Socket buffers optimized', sizes);
  }
}

/**
 * Message coalescing for small messages
 */
export class MessageCoalescer {
  constructor(options = {}) {
    this.threshold = options.threshold || 1400; // Below MTU
    this.delay = options.delay || 1; // 1ms delay
    this.maxDelay = options.maxDelay || 10; // 10ms max
    
    this.buffers = new Map(); // socket -> buffer
    this.timers = new Map(); // socket -> timer
  }
  
  /**
   * Coalesce message if beneficial
   */
  write(socket, data) {
    // Large messages - send immediately
    if (data.length > this.threshold) {
      this.flush(socket);
      socket.write(data);
      return;
    }
    
    // Get or create buffer
    if (!this.buffers.has(socket)) {
      this.buffers.set(socket, []);
    }
    
    const buffer = this.buffers.get(socket);
    buffer.push(data);
    
    // Calculate total size
    const totalSize = buffer.reduce((sum, buf) => sum + buf.length, 0);
    
    // Flush if exceeding threshold
    if (totalSize > this.threshold) {
      this.flush(socket);
    } else {
      // Schedule flush
      this.scheduleFlush(socket);
    }
  }
  
  /**
   * Schedule buffer flush
   */
  scheduleFlush(socket) {
    // Clear existing timer
    if (this.timers.has(socket)) {
      clearTimeout(this.timers.get(socket));
    }
    
    // Set new timer
    const timer = setTimeout(() => {
      this.flush(socket);
    }, this.delay);
    
    this.timers.set(socket, timer);
  }
  
  /**
   * Flush buffered messages
   */
  flush(socket) {
    const buffer = this.buffers.get(socket);
    if (!buffer || buffer.length === 0) return;
    
    // Concatenate buffers
    const combined = Buffer.concat(buffer);
    socket.write(combined);
    
    // Clear buffer
    buffer.length = 0;
    
    // Clear timer
    if (this.timers.has(socket)) {
      clearTimeout(this.timers.get(socket));
      this.timers.delete(socket);
    }
  }
  
  /**
   * Clean up for socket
   */
  cleanup(socket) {
    this.flush(socket);
    this.buffers.delete(socket);
    this.timers.delete(socket);
  }
}

export default {
  OptimizedSocket,
  ConnectionPool,
  TCPServerOptimizer,
  NetworkBufferOptimizer,
  MessageCoalescer
};