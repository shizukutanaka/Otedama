/**
 * Mining Proxy Server
 * High-performance proxy for mining pool connections
 * Reduces latency and improves network efficiency
 * Following Pike's principle: "Be a network citizen"
 */

import { EventEmitter } from 'events';
import * as net from 'net';
import * as crypto from 'crypto';
import { Logger } from '../logging/logger';
import { StratumServer } from '../network/stratum';
import { BinaryProtocolConnection, MessageType } from '../protocol/binary';
import { getMemoryAlignmentManager } from '../performance/memory-alignment';
import { createCPUAffinityManager } from '../performance/cpu-affinity';

const logger = new Logger('MiningProxy');

// Proxy configuration
export interface ProxyConfig {
  // Server settings
  listenPort: number;
  listenAddress: string;
  
  // Pool connections
  pools: PoolConfig[];
  
  // Performance settings
  maxConnections: number;
  connectionTimeout: number;
  keepAliveInterval: number;
  
  // Load balancing
  loadBalanceStrategy: 'round-robin' | 'least-connections' | 'weighted' | 'latency-based';
  healthCheckInterval: number;
  retryAttempts: number;
  
  // Caching
  workCacheEnabled: boolean;
  workCacheSize: number;
  workCacheTTL: number;
  
  // Security
  enableRateLimiting: boolean;
  maxRequestsPerSecond: number;
  enableDDoSProtection: boolean;
  
  // Optimization
  enableCompression: boolean;
  enableBinaryProtocol: boolean;
  enableConnectionPooling: boolean;
  
  // Geographic optimization
  enableGeoRouting: boolean;
  regions: ProxyRegion[];
}

// Pool configuration
export interface PoolConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  protocol: 'stratum' | 'stratum-v2' | 'binary';
  weight: number;
  priority: number;
  enabled: boolean;
  
  // Authentication
  username?: string;
  password?: string;
  
  // Connection settings
  maxConnections: number;
  connectionTimeout: number;
  
  // Performance metrics
  latency: number;
  reliability: number;
  hashrate: number;
  
  // Geographic location
  region?: string;
  location?: {
    latitude: number;
    longitude: number;
  };
}

// Proxy region for geo-routing
export interface ProxyRegion {
  id: string;
  name: string;
  location: {
    latitude: number;
    longitude: number;
  };
  pools: string[]; // Pool IDs
  priority: number;
}

// Connection statistics
export interface ConnectionStats {
  id: string;
  clientAddress: string;
  connectedAt: number;
  lastActivity: number;
  
  // Traffic stats
  bytesReceived: number;
  bytesSent: number;
  messagesReceived: number;
  messagesSent: number;
  
  // Performance stats
  averageLatency: number;
  packetLoss: number;
  
  // Mining stats
  sharesSubmitted: number;
  sharesAccepted: number;
  hashrate: number;
  
  // Current pool
  currentPool?: string;
  poolSwitches: number;
}

// Work cache entry
export interface WorkCacheEntry {
  jobId: string;
  work: any;
  poolId: string;
  timestamp: number;
  expiresAt: number;
  difficulty: number;
}

/**
 * Pool connection manager
 */
export class PoolConnectionManager {
  private connections = new Map<string, net.Socket>();
  private connectionStats = new Map<string, any>();
  private memoryManager = getMemoryAlignmentManager();

  constructor(private pools: PoolConfig[]) {}

  /**
   * Establish connection to pool
   */
  async connectToPool(poolId: string): Promise<net.Socket> {
    const pool = this.pools.find(p => p.id === poolId);
    if (!pool) {
      throw new Error(`Pool not found: ${poolId}`);
    }

    const existingConnection = this.connections.get(poolId);
    if (existingConnection && !existingConnection.destroyed) {
      return existingConnection;
    }

    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Connection timeout to pool ${poolId}`));
      }, pool.connectionTimeout || 10000);

      socket.connect(pool.port, pool.host, () => {
        clearTimeout(timeout);
        
        // Set keep-alive
        socket.setKeepAlive(true, 60000);
        socket.setNoDelay(true);
        
        // Store connection
        this.connections.set(poolId, socket);
        
        // Initialize stats
        this.connectionStats.set(poolId, {
          connectedAt: Date.now(),
          reconnects: 0,
          lastActivity: Date.now(),
          bytesReceived: 0,
          bytesSent: 0
        });

        logger.info('Connected to pool', {
          poolId,
          host: pool.host,
          port: pool.port
        });

        resolve(socket);
      });

      socket.on('error', (error) => {
        clearTimeout(timeout);
        this.connections.delete(poolId);
        logger.error(`Pool connection error: ${poolId}`, error);
        reject(error);
      });

      socket.on('close', () => {
        this.connections.delete(poolId);
        logger.warn('Pool connection closed', { poolId });
      });

      socket.on('data', (data) => {
        const stats = this.connectionStats.get(poolId);
        if (stats) {
          stats.bytesReceived += data.length;
          stats.lastActivity = Date.now();
        }
      });
    });
  }

  /**
   * Send data to pool
   */
  async sendToPool(poolId: string, data: Buffer): Promise<void> {
    const connection = await this.connectToPool(poolId);
    
    return new Promise((resolve, reject) => {
      connection.write(data, (error) => {
        if (error) {
          reject(error);
        } else {
          const stats = this.connectionStats.get(poolId);
          if (stats) {
            stats.bytesSent += data.length;
          }
          resolve();
        }
      });
    });
  }

  /**
   * Close all connections
   */
  closeAll(): void {
    for (const [poolId, socket] of this.connections) {
      socket.destroy();
      logger.info('Pool connection closed', { poolId });
    }
    this.connections.clear();
    this.connectionStats.clear();
  }

  /**
   * Get connection statistics
   */
  getStats(): { [poolId: string]: any } {
    return Object.fromEntries(this.connectionStats);
  }
}

/**
 * Load balancer for pool selection
 */
export class LoadBalancer {
  private roundRobinIndex = 0;
  private poolMetrics = new Map<string, {
    connections: number;
    latency: number;
    reliability: number;
    lastUpdate: number;
  }>();

  constructor(private pools: PoolConfig[], private strategy: string) {
    // Initialize metrics
    for (const pool of pools) {
      this.poolMetrics.set(pool.id, {
        connections: 0,
        latency: pool.latency || 100,
        reliability: pool.reliability || 1.0,
        lastUpdate: Date.now()
      });
    }
  }

  /**
   * Select best pool for new connection
   */
  selectPool(clientRegion?: string): PoolConfig | null {
    const availablePools = this.pools.filter(p => p.enabled);
    if (availablePools.length === 0) {
      return null;
    }

    switch (this.strategy) {
      case 'round-robin':
        return this.roundRobinSelection(availablePools);
      
      case 'least-connections':
        return this.leastConnectionsSelection(availablePools);
      
      case 'weighted':
        return this.weightedSelection(availablePools);
      
      case 'latency-based':
        return this.latencyBasedSelection(availablePools);
      
      default:
        return availablePools[0];
    }
  }

  /**
   * Round-robin pool selection
   */
  private roundRobinSelection(pools: PoolConfig[]): PoolConfig {
    const pool = pools[this.roundRobinIndex % pools.length];
    this.roundRobinIndex++;
    return pool;
  }

  /**
   * Least connections selection
   */
  private leastConnectionsSelection(pools: PoolConfig[]): PoolConfig {
    let selectedPool = pools[0];
    let minConnections = this.poolMetrics.get(selectedPool.id)?.connections || 0;

    for (const pool of pools) {
      const connections = this.poolMetrics.get(pool.id)?.connections || 0;
      if (connections < minConnections) {
        minConnections = connections;
        selectedPool = pool;
      }
    }

    return selectedPool;
  }

  /**
   * Weighted selection based on pool weights
   */
  private weightedSelection(pools: PoolConfig[]): PoolConfig {
    const totalWeight = pools.reduce((sum, pool) => sum + pool.weight, 0);
    const random = Math.random() * totalWeight;
    
    let currentWeight = 0;
    for (const pool of pools) {
      currentWeight += pool.weight;
      if (random <= currentWeight) {
        return pool;
      }
    }

    return pools[pools.length - 1];
  }

  /**
   * Latency-based selection
   */
  private latencyBasedSelection(pools: PoolConfig[]): PoolConfig {
    let selectedPool = pools[0];
    let minScore = this.calculateLatencyScore(selectedPool);

    for (const pool of pools) {
      const score = this.calculateLatencyScore(pool);
      if (score < minScore) {
        minScore = score;
        selectedPool = pool;
      }
    }

    return selectedPool;
  }

  /**
   * Calculate latency score for pool selection
   */
  private calculateLatencyScore(pool: PoolConfig): number {
    const metrics = this.poolMetrics.get(pool.id);
    if (!metrics) return Infinity;

    const latencyScore = metrics.latency;
    const reliabilityScore = (1 - metrics.reliability) * 1000;
    const loadScore = metrics.connections * 10;

    return latencyScore + reliabilityScore + loadScore;
  }

  /**
   * Update pool metrics
   */
  updateMetrics(poolId: string, metrics: Partial<{
    connections: number;
    latency: number;
    reliability: number;
  }>): void {
    const current = this.poolMetrics.get(poolId);
    if (current) {
      Object.assign(current, metrics, { lastUpdate: Date.now() });
    }
  }

  /**
   * Get load balancer statistics
   */
  getStats(): {
    strategy: string;
    totalPools: number;
    activePools: number;
    poolMetrics: { [poolId: string]: any };
  } {
    return {
      strategy: this.strategy,
      totalPools: this.pools.length,
      activePools: this.pools.filter(p => p.enabled).length,
      poolMetrics: Object.fromEntries(this.poolMetrics)
    };
  }
}

/**
 * Work cache for optimizing duplicate work requests
 */
export class WorkCache {
  private cache = new Map<string, WorkCacheEntry>();
  private memoryManager = getMemoryAlignmentManager();

  constructor(
    private maxSize: number,
    private defaultTTL: number
  ) {}

  /**
   * Store work in cache
   */
  store(jobId: string, work: any, poolId: string, ttl?: number): void {
    // Clean expired entries first
    this.cleanup();

    // Check size limit
    if (this.cache.size >= this.maxSize) {
      // Remove oldest entry
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }

    const entry: WorkCacheEntry = {
      jobId,
      work,
      poolId,
      timestamp: Date.now(),
      expiresAt: Date.now() + (ttl || this.defaultTTL),
      difficulty: work.difficulty || 0
    };

    this.cache.set(jobId, entry);
  }

  /**
   * Retrieve work from cache
   */
  get(jobId: string): WorkCacheEntry | null {
    const entry = this.cache.get(jobId);
    if (!entry) return null;

    // Check expiration
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(jobId);
      return null;
    }

    return entry;
  }

  /**
   * Check if work exists in cache
   */
  has(jobId: string): boolean {
    return this.get(jobId) !== null;
  }

  /**
   * Clear expired entries
   */
  cleanup(): void {
    const now = Date.now();
    for (const [jobId, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(jobId);
      }
    }
  }

  /**
   * Clear all cache
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    size: number;
    maxSize: number;
    hitRate: number;
    expiredEntries: number;
  } {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: 0, // Would track in production
      expiredEntries: 0 // Would track in production
    };
  }
}

/**
 * Main mining proxy server
 */
export class MiningProxyServer extends EventEmitter {
  private server: net.Server;
  private poolManager: PoolConnectionManager;
  private loadBalancer: LoadBalancer;
  private workCache: WorkCache;
  private memoryManager = getMemoryAlignmentManager();
  private cpuManager = createCPUAffinityManager();
  
  private connections = new Map<string, net.Socket>();
  private connectionStats = new Map<string, ConnectionStats>();
  private messageQueues = new Map<string, any[]>();

  constructor(private config: ProxyConfig) {
    super();
    
    this.poolManager = new PoolConnectionManager(config.pools);
    this.loadBalancer = new LoadBalancer(config.pools, config.loadBalanceStrategy);
    this.workCache = new WorkCache(config.workCacheSize, config.workCacheTTL);
    
    this.server = net.createServer();
    this.setupServerHandlers();
    
    logger.info('Mining proxy server initialized', {
      listenPort: config.listenPort,
      poolCount: config.pools.length,
      loadBalanceStrategy: config.loadBalanceStrategy
    });
  }

  /**
   * Start the proxy server
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.config.listenPort, this.config.listenAddress, () => {
        logger.info('Mining proxy server started', {
          address: this.config.listenAddress,
          port: this.config.listenPort
        });
        
        this.startPeriodicTasks();
        resolve();
      });

      this.server.on('error', (error) => {
        logger.error('Proxy server error', error);
        reject(error);
      });
    });
  }

  /**
   * Stop the proxy server
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      // Close all client connections
      for (const [id, socket] of this.connections) {
        socket.destroy();
      }
      this.connections.clear();
      this.connectionStats.clear();

      // Close pool connections
      this.poolManager.closeAll();

      // Close server
      this.server.close(() => {
        logger.info('Mining proxy server stopped');
        resolve();
      });
    });
  }

  /**
   * Setup server event handlers
   */
  private setupServerHandlers(): void {
    this.server.on('connection', (socket) => {
      this.handleNewConnection(socket);
    });

    this.server.on('error', (error) => {
      logger.error('Server error', error);
      this.emit('error', error);
    });
  }

  /**
   * Handle new client connection
   */
  private handleNewConnection(socket: net.Socket): void {
    // Check connection limit
    if (this.connections.size >= this.config.maxConnections) {
      logger.warn('Connection limit reached, rejecting connection');
      socket.destroy();
      return;
    }

    const connectionId = crypto.randomBytes(16).toString('hex');
    const clientAddress = `${socket.remoteAddress}:${socket.remotePort}`;

    // Set CPU affinity for networking
    this.cpuManager.setProcessAffinity('networking');

    // Configure socket
    socket.setKeepAlive(true, this.config.keepAliveInterval);
    socket.setNoDelay(true);
    socket.setTimeout(this.config.connectionTimeout);

    // Store connection
    this.connections.set(connectionId, socket);
    
    // Initialize statistics
    const stats: ConnectionStats = {
      id: connectionId,
      clientAddress,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      bytesReceived: 0,
      bytesSent: 0,
      messagesReceived: 0,
      messagesSent: 0,
      averageLatency: 0,
      packetLoss: 0,
      sharesSubmitted: 0,
      sharesAccepted: 0,
      hashrate: 0,
      poolSwitches: 0
    };
    this.connectionStats.set(connectionId, stats);
    this.messageQueues.set(connectionId, []);

    logger.info('Client connected', {
      connectionId,
      clientAddress,
      totalConnections: this.connections.size
    });

    // Setup socket handlers
    this.setupSocketHandlers(connectionId, socket);

    // Select initial pool
    this.selectAndConnectPool(connectionId);

    this.emit('clientConnected', { connectionId, clientAddress });
  }

  /**
   * Setup socket event handlers
   */
  private setupSocketHandlers(connectionId: string, socket: net.Socket): void {
    let buffer = Buffer.alloc(0);

    socket.on('data', async (data) => {
      const stats = this.connectionStats.get(connectionId);
      if (stats) {
        stats.bytesReceived += data.length;
        stats.lastActivity = Date.now();
      }

      // Buffer incoming data
      buffer = Buffer.concat([buffer, data]);

      // Process complete messages
      while (buffer.length > 0) {
        const result = this.parseMessage(buffer);
        if (!result) break;

        const { message, consumed } = result;
        buffer = buffer.slice(consumed);

        await this.handleClientMessage(connectionId, message);
      }
    });

    socket.on('error', (error) => {
      logger.error('Client socket error', error, { connectionId });
      this.removeConnection(connectionId);
    });

    socket.on('close', () => {
      logger.info('Client disconnected', {
        connectionId,
        duration: Date.now() - (this.connectionStats.get(connectionId)?.connectedAt || 0)
      });
      this.removeConnection(connectionId);
    });

    socket.on('timeout', () => {
      logger.warn('Client connection timeout', { connectionId });
      socket.destroy();
    });
  }

  /**
   * Parse incoming message
   */
  private parseMessage(buffer: Buffer): { message: any; consumed: number } | null {
    // Try to parse as JSON (Stratum)
    try {
      const text = buffer.toString('utf8');
      const lines = text.split('\n');
      
      if (lines.length < 2) return null; // Incomplete message
      
      const messageLine = lines[0];
      const message = JSON.parse(messageLine);
      const consumed = Buffer.byteLength(messageLine + '\n', 'utf8');
      
      return { message, consumed };
    } catch (error) {
      // Try binary protocol
      if (this.config.enableBinaryProtocol && buffer.length >= 16) {
        // Would implement binary parsing here
        return null;
      }
      
      return null;
    }
  }

  /**
   * Handle client message
   */
  private async handleClientMessage(connectionId: string, message: any): Promise<void> {
    const stats = this.connectionStats.get(connectionId);
    if (stats) {
      stats.messagesReceived++;
    }

    try {
      // Check work cache first
      if (message.method === 'mining.get_work' && this.config.workCacheEnabled) {
        const cachedWork = this.workCache.get(message.id);
        if (cachedWork) {
          await this.sendToClient(connectionId, {
            id: message.id,
            result: cachedWork.work,
            error: null
          });
          return;
        }
      }

      // Forward to pool
      await this.forwardToPool(connectionId, message);
      
      // Handle share submission
      if (message.method === 'mining.submit') {
        if (stats) {
          stats.sharesSubmitted++;
        }
        this.emit('shareSubmitted', { connectionId, share: message.params });
      }

    } catch (error) {
      logger.error('Error handling client message', error as Error, { connectionId });
      
      // Send error response
      await this.sendToClient(connectionId, {
        id: message.id,
        result: null,
        error: { code: -1, message: 'Internal server error' }
      });
    }
  }

  /**
   * Forward message to selected pool
   */
  private async forwardToPool(connectionId: string, message: any): Promise<void> {
    const stats = this.connectionStats.get(connectionId);
    const currentPool = stats?.currentPool;
    
    if (!currentPool) {
      throw new Error('No pool selected for connection');
    }

    // Convert to buffer
    const messageBuffer = Buffer.from(JSON.stringify(message) + '\n', 'utf8');
    
    // Send to pool
    await this.poolManager.sendToPool(currentPool, messageBuffer);
    
    logger.debug('Message forwarded to pool', {
      connectionId,
      poolId: currentPool,
      method: message.method
    });
  }

  /**
   * Send message to client
   */
  private async sendToClient(connectionId: string, message: any): Promise<void> {
    const socket = this.connections.get(connectionId);
    if (!socket || socket.destroyed) return;

    const stats = this.connectionStats.get(connectionId);
    if (stats) {
      stats.messagesSent++;
    }

    const messageBuffer = Buffer.from(JSON.stringify(message) + '\n', 'utf8');
    
    return new Promise((resolve, reject) => {
      socket.write(messageBuffer, (error) => {
        if (error) {
          reject(error);
        } else {
          if (stats) {
            stats.bytesSent += messageBuffer.length;
          }
          resolve();
        }
      });
    });
  }

  /**
   * Select and connect to best pool for connection
   */
  private async selectAndConnectPool(connectionId: string): Promise<void> {
    try {
      const pool = this.loadBalancer.selectPool();
      if (!pool) {
        throw new Error('No available pools');
      }

      // Update connection stats
      const stats = this.connectionStats.get(connectionId);
      if (stats) {
        if (stats.currentPool && stats.currentPool !== pool.id) {
          stats.poolSwitches++;
        }
        stats.currentPool = pool.id;
      }

      // Ensure connection to pool
      await this.poolManager.connectToPool(pool.id);
      
      // Update load balancer metrics
      this.loadBalancer.updateMetrics(pool.id, {
        connections: this.getPoolConnectionCount(pool.id)
      });

      logger.debug('Pool selected for connection', {
        connectionId,
        poolId: pool.id,
        poolName: pool.name
      });

    } catch (error) {
      logger.error('Failed to select pool for connection', error as Error, { connectionId });
    }
  }

  /**
   * Get number of connections for a pool
   */
  private getPoolConnectionCount(poolId: string): number {
    let count = 0;
    for (const stats of this.connectionStats.values()) {
      if (stats.currentPool === poolId) {
        count++;
      }
    }
    return count;
  }

  /**
   * Remove connection
   */
  private removeConnection(connectionId: string): void {
    const socket = this.connections.get(connectionId);
    if (socket && !socket.destroyed) {
      socket.destroy();
    }

    this.connections.delete(connectionId);
    this.connectionStats.delete(connectionId);
    this.messageQueues.delete(connectionId);

    this.emit('clientDisconnected', { connectionId });
  }

  /**
   * Start periodic maintenance tasks
   */
  private startPeriodicTasks(): void {
    // Health checks
    setInterval(() => {
      this.performHealthChecks();
    }, this.config.healthCheckInterval);

    // Cache cleanup
    setInterval(() => {
      this.workCache.cleanup();
    }, 60000); // Every minute

    // Statistics update
    setInterval(() => {
      this.updateStatistics();
    }, 30000); // Every 30 seconds

    logger.info('Periodic tasks started');
  }

  /**
   * Perform health checks on pools
   */
  private async performHealthChecks(): Promise<void> {
    for (const pool of this.config.pools) {
      if (!pool.enabled) continue;

      try {
        const start = Date.now();
        // Simple ping test
        await this.poolManager.connectToPool(pool.id);
        const latency = Date.now() - start;

        this.loadBalancer.updateMetrics(pool.id, {
          latency,
          reliability: 1.0
        });

      } catch (error) {
        logger.warn('Pool health check failed', { poolId: pool.id, error: (error as Error).message });
        
        this.loadBalancer.updateMetrics(pool.id, {
          reliability: 0.0
        });
      }
    }
  }

  /**
   * Update statistics
   */
  private updateStatistics(): void {
    const stats = this.getStatistics();
    this.emit('statistics', stats);
    
    logger.debug('Statistics updated', {
      connections: stats.connections.active,
      totalTraffic: stats.traffic.totalBytes,
      cacheHitRate: stats.cache.hitRate
    });
  }

  /**
   * Get comprehensive proxy statistics
   */
  getStatistics(): {
    connections: {
      active: number;
      total: number;
      avgLatency: number;
    };
    pools: {
      available: number;
      total: number;
      loadBalancer: any;
    };
    traffic: {
      totalBytes: number;
      messagesPerSecond: number;
      avgMessageSize: number;
    };
    cache: {
      size: number;
      hitRate: number;
    };
    performance: {
      uptime: number;
      memoryUsage: any;
    };
  } {
    const activeConnections = this.connections.size;
    const totalConnections = this.connectionStats.size;

    let totalLatency = 0;
    let totalBytes = 0;
    let totalMessages = 0;

    for (const stats of this.connectionStats.values()) {
      totalLatency += stats.averageLatency;
      totalBytes += stats.bytesReceived + stats.bytesSent;
      totalMessages += stats.messagesReceived + stats.messagesSent;
    }

    const avgLatency = totalConnections > 0 ? totalLatency / totalConnections : 0;

    return {
      connections: {
        active: activeConnections,
        total: totalConnections,
        avgLatency
      },
      pools: {
        available: this.config.pools.filter(p => p.enabled).length,
        total: this.config.pools.length,
        loadBalancer: this.loadBalancer.getStats()
      },
      traffic: {
        totalBytes,
        messagesPerSecond: 0, // Would calculate in production
        avgMessageSize: totalMessages > 0 ? totalBytes / totalMessages : 0
      },
      cache: this.workCache.getStats(),
      performance: {
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage()
      }
    };
  }
}

export {
  ProxyConfig,
  PoolConfig,
  ProxyRegion,
  ConnectionStats,
  PoolConnectionManager,
  LoadBalancer,
  WorkCache
};
