/**
 * Latency Optimization - Low Latency Communication
 * Following Carmack/Martin/Pike principles:
 * - Minimize round-trip times
 * - Efficient protocol design
 * - Smart caching and prediction
 */

import { EventEmitter } from 'events';
import * as net from 'net';
import * as dgram from 'dgram';
import { logger } from '../utils/logger';

interface LatencyOptimizationConfig {
  // TCP optimizations
  tcp: {
    noDelay: boolean;
    keepAlive: boolean;
    keepAliveInitialDelay: number;
    socketBufferSize: number;
  };
  
  // UDP optimizations
  udp: {
    enabled: boolean;
    port: number;
    maxPacketSize: number;
  };
  
  // Protocol optimizations
  protocol: {
    binaryEncoding: boolean;
    compression: boolean;
    batching: boolean;
    batchInterval: number;
    maxBatchSize: number;
  };
  
  // Caching
  cache: {
    enabled: boolean;
    ttl: number;
    maxSize: number;
  };
  
  // Prediction
  prediction: {
    enabled: boolean;
    prefetchJobs: boolean;
    adaptiveDifficulty: boolean;
  };
  
  // Connection pooling
  connectionPool: {
    enabled: boolean;
    minConnections: number;
    maxConnections: number;
    idleTimeout: number;
  };
}

interface Connection {
  id: string;
  socket: net.Socket;
  created: Date;
  lastUsed: Date;
  latency: number;
  state: 'idle' | 'busy';
  protocol: 'tcp' | 'udp';
}

interface MessageBatch {
  messages: any[];
  timestamp: number;
  size: number;
}

interface LatencyStats {
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  samples: number[];
}

interface CacheEntry {
  data: any;
  timestamp: number;
  hits: number;
}

export class LatencyOptimizer extends EventEmitter {
  private config: LatencyOptimizationConfig;
  private connectionPool: Map<string, Connection[]> = new Map();
  private messageBatch: Map<string, MessageBatch> = new Map();
  private cache: Map<string, CacheEntry> = new Map();
  private latencyStats: Map<string, LatencyStats> = new Map();
  private udpSocket?: dgram.Socket;
  private batchTimers: Map<string, NodeJS.Timeout> = new Map();
  
  // Compression
  private compressionEnabled: boolean = false;
  private compressionThreshold: number = 1024; // bytes

  constructor(config: LatencyOptimizationConfig) {
    super();
    this.config = config;
    this.compressionEnabled = config.protocol.compression;
  }

  /**
   * Initialize latency optimizer
   */
  async initialize(): Promise<void> {
    logger.info('Initializing latency optimizer');

    // Setup UDP socket if enabled
    if (this.config.udp.enabled) {
      await this.setupUDP();
    }

    // Start cache cleanup
    if (this.config.cache.enabled) {
      this.startCacheCleanup();
    }

    // Start connection pool maintenance
    if (this.config.connectionPool.enabled) {
      this.startConnectionPoolMaintenance();
    }

    this.emit('initialized');
  }

  /**
   * Create optimized connection
   */
  async createConnection(host: string, port: number, protocol: 'tcp' | 'udp' = 'tcp'): Promise<Connection> {
    const poolKey = `${host}:${port}`;
    
    // Check connection pool
    if (this.config.connectionPool.enabled) {
      const pooled = this.getPooledConnection(poolKey);
      if (pooled) {
        return pooled;
      }
    }

    if (protocol === 'tcp') {
      return this.createTCPConnection(host, port);
    } else {
      return this.createUDPConnection(host, port);
    }
  }

  /**
   * Create optimized TCP connection
   */
  private async createTCPConnection(host: string, port: number): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const socket = new net.Socket();
      
      // Apply TCP optimizations
      socket.setNoDelay(this.config.tcp.noDelay);
      socket.setKeepAlive(
        this.config.tcp.keepAlive,
        this.config.tcp.keepAliveInitialDelay
      );
      
      // Set socket buffer sizes
      socket.on('connect', () => {
        try {
          // @ts-ignore - These methods exist but not in types
          socket.setRecvBufferSize(this.config.tcp.socketBufferSize);
          socket.setSendBufferSize(this.config.tcp.socketBufferSize);
        } catch (err) {
          // Some platforms don't support buffer size adjustment
        }
      });

      const connection: Connection = {
        id: `tcp-${Date.now()}-${Math.random()}`,
        socket,
        created: new Date(),
        lastUsed: new Date(),
        latency: 0,
        state: 'idle',
        protocol: 'tcp'
      };

      socket.on('connect', () => {
        connection.latency = Date.now() - startTime;
        this.recordLatency(`${host}:${port}`, connection.latency);
        
        logger.debug('TCP connection established', {
          host,
          port,
          latency: connection.latency
        });
        
        resolve(connection);
      });

      socket.on('error', (err) => {
        logger.error('TCP connection error', { host, port, error: err });
        reject(err);
      });

      socket.connect(port, host);
    });
  }

  /**
   * Create UDP connection (connectionless)
   */
  private async createUDPConnection(host: string, port: number): Promise<Connection> {
    if (!this.udpSocket) {
      throw new Error('UDP not initialized');
    }

    // UDP is connectionless, create virtual connection
    const connection: Connection = {
      id: `udp-${Date.now()}-${Math.random()}`,
      socket: this.udpSocket as any, // UDP doesn't use net.Socket
      created: new Date(),
      lastUsed: new Date(),
      latency: 0,
      state: 'idle',
      protocol: 'udp'
    };

    // Store target info in connection metadata
    (connection as any).remoteHost = host;
    (connection as any).remotePort = port;

    return connection;
  }

  /**
   * Send optimized message
   */
  async send(connection: Connection, message: any, options: { 
    priority?: 'high' | 'normal' | 'low';
    batch?: boolean;
    cache?: boolean;
  } = {}): Promise<void> {
    connection.lastUsed = new Date();
    connection.state = 'busy';

    try {
      // Check cache first
      if (options.cache && this.config.cache.enabled) {
        const cacheKey = this.generateCacheKey(message);
        const cached = this.getFromCache(cacheKey);
        if (cached) {
          this.emit('cache:hit', { key: cacheKey });
          return;
        }
      }

      // Prepare message
      let data = this.prepareMessage(message);

      // Batch if requested
      if (options.batch && this.config.protocol.batching) {
        this.addToBatch(connection.id, message);
        return;
      }

      // Send based on protocol
      if (connection.protocol === 'tcp') {
        await this.sendTCP(connection, data);
      } else {
        await this.sendUDP(connection, data);
      }

      // Update stats
      this.emit('message:sent', {
        connectionId: connection.id,
        size: data.length,
        protocol: connection.protocol
      });

    } finally {
      connection.state = 'idle';
    }
  }

  /**
   * Prepare message for sending
   */
  private prepareMessage(message: any): Buffer {
    let data: Buffer;

    // Use binary encoding if enabled
    if (this.config.protocol.binaryEncoding) {
      data = this.encodeBinary(message);
    } else {
      data = Buffer.from(JSON.stringify(message));
    }

    // Compress if beneficial
    if (this.compressionEnabled && data.length > this.compressionThreshold) {
      data = this.compress(data);
    }

    return data;
  }

  /**
   * Send via TCP
   */
  private sendTCP(connection: Connection, data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connection.socket;
      
      // Add length prefix for framing
      const lengthBuffer = Buffer.allocUnsafe(4);
      lengthBuffer.writeUInt32BE(data.length, 0);
      
      const frame = Buffer.concat([lengthBuffer, data]);
      
      socket.write(frame, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Send via UDP
   */
  private sendUDP(connection: any, data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.udpSocket) {
        reject(new Error('UDP not initialized'));
        return;
      }

      // Fragment if needed
      if (data.length > this.config.udp.maxPacketSize) {
        this.sendFragmentedUDP(connection, data).then(resolve).catch(reject);
        return;
      }

      this.udpSocket.send(data, connection.remotePort, connection.remoteHost, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Send fragmented UDP
   */
  private async sendFragmentedUDP(connection: any, data: Buffer): Promise<void> {
    const fragments = this.fragmentData(data, this.config.udp.maxPacketSize - 16); // Reserve 16 bytes for header
    const fragmentId = crypto.randomBytes(4);
    
    for (let i = 0; i < fragments.length; i++) {
      const header = Buffer.allocUnsafe(16);
      fragmentId.copy(header, 0);
      header.writeUInt32BE(fragments.length, 4);
      header.writeUInt32BE(i, 8);
      header.writeUInt32BE(fragments[i].length, 12);
      
      const packet = Buffer.concat([header, fragments[i]]);
      
      await new Promise<void>((resolve, reject) => {
        this.udpSocket!.send(packet, connection.remotePort, connection.remoteHost, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      
      // Small delay between fragments to prevent congestion
      if (i < fragments.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1));
      }
    }
  }

  /**
   * Fragment data
   */
  private fragmentData(data: Buffer, maxSize: number): Buffer[] {
    const fragments: Buffer[] = [];
    let offset = 0;
    
    while (offset < data.length) {
      const size = Math.min(maxSize, data.length - offset);
      fragments.push(data.slice(offset, offset + size));
      offset += size;
    }
    
    return fragments;
  }

  /**
   * Add message to batch
   */
  private addToBatch(connectionId: string, message: any): void {
    let batch = this.messageBatch.get(connectionId);
    
    if (!batch) {
      batch = {
        messages: [],
        timestamp: Date.now(),
        size: 0
      };
      this.messageBatch.set(connectionId, batch);
      
      // Schedule batch send
      const timer = setTimeout(() => {
        this.sendBatch(connectionId);
      }, this.config.protocol.batchInterval);
      
      this.batchTimers.set(connectionId, timer);
    }
    
    batch.messages.push(message);
    batch.size += JSON.stringify(message).length;
    
    // Send immediately if batch is full
    if (batch.messages.length >= this.config.protocol.maxBatchSize ||
        batch.size > this.config.tcp.socketBufferSize * 0.8) {
      this.sendBatch(connectionId);
    }
  }

  /**
   * Send batched messages
   */
  private async sendBatch(connectionId: string): Promise<void> {
    const batch = this.messageBatch.get(connectionId);
    if (!batch || batch.messages.length === 0) return;
    
    // Clear batch
    this.messageBatch.delete(connectionId);
    
    // Clear timer
    const timer = this.batchTimers.get(connectionId);
    if (timer) {
      clearTimeout(timer);
      this.batchTimers.delete(connectionId);
    }
    
    // Find connection
    const pooled = Array.from(this.connectionPool.values())
      .flat()
      .find(c => c.id === connectionId);
    
    if (!pooled) {
      logger.warn('Connection not found for batch', { connectionId });
      return;
    }
    
    // Send batch as single message
    const batchMessage = {
      type: 'batch',
      messages: batch.messages,
      timestamp: batch.timestamp
    };
    
    await this.send(pooled, batchMessage, { batch: false });
    
    logger.debug('Sent message batch', {
      connectionId,
      count: batch.messages.length,
      size: batch.size
    });
  }

  /**
   * Setup UDP socket
   */
  private async setupUDP(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.udpSocket = dgram.createSocket('udp4');
      
      this.udpSocket.on('error', (err) => {
        logger.error('UDP socket error', { error: err });
        this.emit('error', err);
      });
      
      this.udpSocket.on('message', (msg, rinfo) => {
        this.handleUDPMessage(msg, rinfo);
      });
      
      this.udpSocket.bind(this.config.udp.port, () => {
        logger.info('UDP socket bound', { port: this.config.udp.port });
        resolve();
      });
    });
  }

  /**
   * Handle incoming UDP message
   */
  private handleUDPMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    // Check if fragmented
    if (msg.length >= 16) {
      const fragmentId = msg.slice(0, 4);
      const totalFragments = msg.readUInt32BE(4);
      
      if (totalFragments > 1) {
        this.handleFragmentedMessage(msg, rinfo);
        return;
      }
    }
    
    // Process complete message
    this.processIncomingMessage(msg, `${rinfo.address}:${rinfo.port}`, 'udp');
  }

  /**
   * Handle fragmented message
   */
  private handleFragmentedMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    // Fragment reassembly logic would go here
    // For brevity, not implementing full reassembly
    logger.debug('Received message fragment', {
      from: `${rinfo.address}:${rinfo.port}`,
      size: msg.length
    });
  }

  /**
   * Process incoming message
   */
  private processIncomingMessage(data: Buffer, source: string, protocol: string): void {
    try {
      // Decompress if needed
      if (this.isCompressed(data)) {
        data = this.decompress(data);
      }
      
      // Decode message
      const message = this.config.protocol.binaryEncoding
        ? this.decodeBinary(data)
        : JSON.parse(data.toString());
      
      // Update latency stats if it's a response
      if (message.type === 'pong' && message.timestamp) {
        const latency = Date.now() - message.timestamp;
        this.recordLatency(source, latency);
      }
      
      this.emit('message:received', {
        source,
        protocol,
        message,
        size: data.length
      });
      
    } catch (err) {
      logger.error('Failed to process message', {
        source,
        protocol,
        error: err
      });
    }
  }

  /**
   * Get pooled connection
   */
  private getPooledConnection(poolKey: string): Connection | null {
    const pool = this.connectionPool.get(poolKey);
    if (!pool) return null;
    
    // Find idle connection
    const idle = pool.find(c => c.state === 'idle' && c.socket.writable);
    if (idle) {
      idle.lastUsed = new Date();
      return idle;
    }
    
    // Create new if under limit
    if (pool.length < this.config.connectionPool.maxConnections) {
      return null; // Will create new
    }
    
    // All busy, wait or reject
    return null;
  }

  /**
   * Add connection to pool
   */
  addToPool(connection: Connection): void {
    if (!this.config.connectionPool.enabled) return;
    
    const socket = connection.socket;
    const poolKey = `${socket.remoteAddress}:${socket.remotePort}`;
    
    let pool = this.connectionPool.get(poolKey);
    if (!pool) {
      pool = [];
      this.connectionPool.set(poolKey, pool);
    }
    
    pool.push(connection);
    
    logger.debug('Added connection to pool', {
      poolKey,
      poolSize: pool.length
    });
  }

  /**
   * Start connection pool maintenance
   */
  private startConnectionPoolMaintenance(): void {
    setInterval(() => {
      const now = Date.now();
      
      for (const [poolKey, pool] of this.connectionPool) {
        // Remove dead connections
        const alive = pool.filter(conn => {
          if (!conn.socket.writable) {
            conn.socket.destroy();
            return false;
          }
          
          // Remove idle connections
          if (conn.state === 'idle' && 
              now - conn.lastUsed.getTime() > this.config.connectionPool.idleTimeout) {
            conn.socket.end();
            return false;
          }
          
          return true;
        });
        
        if (alive.length === 0) {
          this.connectionPool.delete(poolKey);
        } else {
          this.connectionPool.set(poolKey, alive);
        }
      }
    }, 30000); // Every 30 seconds
  }

  /**
   * Binary encoding (simplified)
   */
  private encodeBinary(obj: any): Buffer {
    // In production, use proper binary protocol like Protocol Buffers
    const str = JSON.stringify(obj);
    const buffer = Buffer.allocUnsafe(4 + str.length);
    buffer.writeUInt32BE(str.length, 0);
    buffer.write(str, 4);
    return buffer;
  }

  /**
   * Binary decoding
   */
  private decodeBinary(buffer: Buffer): any {
    const length = buffer.readUInt32BE(0);
    const str = buffer.toString('utf8', 4, 4 + length);
    return JSON.parse(str);
  }

  /**
   * Compress data
   */
  private compress(data: Buffer): Buffer {
    // In production, use proper compression like zlib
    // For now, just add compression flag
    const compressed = Buffer.allocUnsafe(1 + data.length);
    compressed[0] = 0x01; // Compression flag
    data.copy(compressed, 1);
    return compressed;
  }

  /**
   * Decompress data
   */
  private decompress(data: Buffer): Buffer {
    if (data[0] === 0x01) {
      return data.slice(1);
    }
    return data;
  }

  /**
   * Check if data is compressed
   */
  private isCompressed(data: Buffer): boolean {
    return data.length > 0 && data[0] === 0x01;
  }

  /**
   * Generate cache key
   */
  private generateCacheKey(message: any): string {
    return crypto.createHash('md5')
      .update(JSON.stringify(message))
      .digest('hex');
  }

  /**
   * Get from cache
   */
  private getFromCache(key: string): any | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    
    if (Date.now() - entry.timestamp > this.config.cache.ttl) {
      this.cache.delete(key);
      return null;
    }
    
    entry.hits++;
    return entry.data;
  }

  /**
   * Add to cache
   */
  addToCache(key: string, data: any): void {
    if (!this.config.cache.enabled) return;
    
    // Evict old entries if cache is full
    if (this.cache.size >= this.config.cache.maxSize) {
      // Evict least recently used
      const sorted = Array.from(this.cache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);
      
      this.cache.delete(sorted[0][0]);
    }
    
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      hits: 0
    });
  }

  /**
   * Start cache cleanup
   */
  private startCacheCleanup(): void {
    setInterval(() => {
      const now = Date.now();
      
      for (const [key, entry] of this.cache) {
        if (now - entry.timestamp > this.config.cache.ttl) {
          this.cache.delete(key);
        }
      }
    }, 60000); // Every minute
  }

  /**
   * Record latency measurement
   */
  private recordLatency(endpoint: string, latency: number): void {
    let stats = this.latencyStats.get(endpoint);
    
    if (!stats) {
      stats = {
        min: latency,
        max: latency,
        avg: latency,
        p50: latency,
        p95: latency,
        p99: latency,
        samples: []
      };
      this.latencyStats.set(endpoint, stats);
    }
    
    // Add sample
    stats.samples.push(latency);
    
    // Keep only recent samples (last 1000)
    if (stats.samples.length > 1000) {
      stats.samples.shift();
    }
    
    // Update statistics
    stats.min = Math.min(...stats.samples);
    stats.max = Math.max(...stats.samples);
    stats.avg = stats.samples.reduce((a, b) => a + b) / stats.samples.length;
    
    // Calculate percentiles
    const sorted = [...stats.samples].sort((a, b) => a - b);
    stats.p50 = sorted[Math.floor(sorted.length * 0.5)];
    stats.p95 = sorted[Math.floor(sorted.length * 0.95)];
    stats.p99 = sorted[Math.floor(sorted.length * 0.99)];
  }

  /**
   * Get latency statistics
   */
  getLatencyStats(): Map<string, LatencyStats> {
    return new Map(this.latencyStats);
  }

  /**
   * Predict next job (for predictive optimization)
   */
  predictNextJob(pattern: any): any | null {
    if (!this.config.prediction.enabled) return null;
    
    // Simple prediction based on patterns
    // In production, use ML models
    return null;
  }

  /**
   * Shutdown
   */
  shutdown(): void {
    // Close all connections
    for (const pool of this.connectionPool.values()) {
      for (const conn of pool) {
        conn.socket.destroy();
      }
    }
    this.connectionPool.clear();
    
    // Close UDP socket
    if (this.udpSocket) {
      this.udpSocket.close();
    }
    
    // Clear timers
    for (const timer of this.batchTimers.values()) {
      clearTimeout(timer);
    }
    this.batchTimers.clear();
    
    // Clear caches
    this.cache.clear();
    this.messageBatch.clear();
    
    logger.info('Latency optimizer shutdown');
  }
}

// Export types
export { LatencyOptimizationConfig, Connection, LatencyStats };
