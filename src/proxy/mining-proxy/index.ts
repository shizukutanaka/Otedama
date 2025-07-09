/**
 * Mining Proxy Server
 * Efficient relay server between miners and pools
 * Following Pike's principle: "Simple, reliable, and fast"
 */

import { EventEmitter } from 'events';
import * as net from 'net';
import * as crypto from 'crypto';
import { Logger } from '../../logging/logger';
import { getMemoryAlignmentManager } from '../../performance/memory-alignment';
import { createCPUAffinityManager } from '../../performance/cpu-affinity';

const logger = new Logger('MiningProxy');

// Proxy configuration
export interface ProxyConfig {
  listenPort: number;
  listenHost: string;
  upstreamPools: UpstreamPool[];
  loadBalancing: 'round-robin' | 'least-connections' | 'hashrate-weighted' | 'latency-based';
  failoverEnabled: boolean;
  connectionPooling: boolean;
  maxConnections: number;
  connectionTimeout: number;
  keepAliveInterval: number;
  bufferSize: number;
  compressionEnabled: boolean;
  statisticsEnabled: boolean;
  geoDNS?: {
    enabled: boolean;
    regions: { [region: string]: UpstreamPool[] };
  };
}

// Upstream pool configuration
export interface UpstreamPool {
  id: string;
  name: string;
  host: string;
  port: number;
  protocol: 'stratum' | 'stratum-v2' | 'getwork';
  priority: number;
  weight: number;
  region?: string;
  ssl?: boolean;
  auth?: {
    username: string;
    password: string;
  };
  healthCheck: {
    enabled: boolean;
    interval: number;
    timeout: number;
    retries: number;
  };
  stats: {
    totalConnections: number;
    activeConnections: number;
    totalShares: number;
    acceptedShares: number;
    rejectedShares: number;
    latency: number;
    uptime: number;
    lastSeen: number;
  };
}

// Miner connection
export interface MinerConnection {
  id: string;
  socket: net.Socket;
  remoteAddress: string;
  remotePort: number;
  userAgent?: string;
  minerId?: string;
  upstreamPool?: UpstreamPool;
  upstreamSocket?: net.Socket;
  connectedAt: number;
  lastActivity: number;
  bytesReceived: number;
  bytesSent: number;
  sharesSubmitted: number;
  sharesAccepted: number;
  hashrate: number;
  difficulty: number;
  state: 'connecting' | 'connected' | 'authenticated' | 'mining' | 'disconnected';
  buffer: Buffer;
}

// Load balancer
export class LoadBalancer {
  private currentIndex = 0;
  private connectionCounts = new Map<string, number>();

  constructor(private config: ProxyConfig) {}

  /**
   * Select best upstream pool for new connection
   */
  selectUpstreamPool(
    availablePools: UpstreamPool[],
    minerConnection?: MinerConnection
  ): UpstreamPool | null {
    const healthyPools = availablePools.filter(pool => this.isPoolHealthy(pool));
    
    if (healthyPools.length === 0) {
      return null;
    }

    switch (this.config.loadBalancing) {
      case 'round-robin':
        return this.roundRobinSelection(healthyPools);
      case 'least-connections':
        return this.leastConnectionsSelection(healthyPools);
      case 'hashrate-weighted':
        return this.hashrateWeightedSelection(healthyPools, minerConnection);
      case 'latency-based':
        return this.latencyBasedSelection(healthyPools);
      default:
        return healthyPools[0];
    }
  }

  private roundRobinSelection(pools: UpstreamPool[]): UpstreamPool {
    const pool = pools[this.currentIndex % pools.length];
    this.currentIndex++;
    return pool;
  }

  private leastConnectionsSelection(pools: UpstreamPool[]): UpstreamPool {
    return pools.reduce((least, current) => {
      const leastConnections = this.connectionCounts.get(least.id) || 0;
      const currentConnections = this.connectionCounts.get(current.id) || 0;
      return currentConnections < leastConnections ? current : least;
    });
  }

  private hashrateWeightedSelection(
    pools: UpstreamPool[],
    minerConnection?: MinerConnection
  ): UpstreamPool {
    // Select pool based on weight and miner hashrate
    const totalWeight = pools.reduce((sum, pool) => sum + pool.weight, 0);
    const random = Math.random() * totalWeight;
    
    let currentWeight = 0;
    for (const pool of pools) {
      currentWeight += pool.weight;
      if (random <= currentWeight) {
        return pool;
      }
    }
    
    return pools[0];
  }

  private latencyBasedSelection(pools: UpstreamPool[]): UpstreamPool {
    return pools.reduce((lowest, current) => 
      current.stats.latency < lowest.stats.latency ? current : lowest
    );
  }

  private isPoolHealthy(pool: UpstreamPool): boolean {
    const now = Date.now();
    const healthTimeout = pool.healthCheck.timeout || 30000;
    return (now - pool.stats.lastSeen) < healthTimeout;
  }

  updateConnectionCount(poolId: string, change: number): void {
    const current = this.connectionCounts.get(poolId) || 0;
    this.connectionCounts.set(poolId, Math.max(0, current + change));
  }
}

// Pool health monitor
export class PoolHealthMonitor extends EventEmitter {
  private healthChecks = new Map<string, NodeJS.Timeout>();
  private memoryManager = getMemoryAlignmentManager();

  constructor(private pools: UpstreamPool[]) {
    super();
    this.startHealthChecks();
  }

  private startHealthChecks(): void {
    for (const pool of this.pools) {
      if (pool.healthCheck.enabled) {
        this.startPoolHealthCheck(pool);
      }
    }
  }

  private startPoolHealthCheck(pool: UpstreamPool): void {
    const interval = setInterval(async () => {
      await this.checkPoolHealth(pool);
    }, pool.healthCheck.interval);

    this.healthChecks.set(pool.id, interval);
  }

  private async checkPoolHealth(pool: UpstreamPool): Promise<void> {
    const startTime = Date.now();
    
    try {
      const socket = net.createConnection({
        host: pool.host,
        port: pool.port,
        timeout: pool.healthCheck.timeout
      });

      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => {
          pool.stats.latency = Date.now() - startTime;
          pool.stats.lastSeen = Date.now();
          socket.end();
          resolve();
        });

        socket.once('error', reject);
        socket.once('timeout', () => reject(new Error('Connection timeout')));
      });

      logger.debug('Pool health check passed', {
        poolId: pool.id,
        latency: pool.stats.latency
      });

      this.emit('poolHealthy', pool);
    } catch (error) {
      logger.warn('Pool health check failed', {
        poolId: pool.id,
        error: (error as Error).message
      });

      this.emit('poolUnhealthy', pool);
    }
  }

  stop(): void {
    for (const [poolId, interval] of this.healthChecks) {
      clearInterval(interval);
    }
    this.healthChecks.clear();
  }
}

// Connection pool manager
export class ConnectionPoolManager {
  private poolConnections = new Map<string, net.Socket[]>();
  private memoryManager = getMemoryAlignmentManager();

  constructor(
    private pools: UpstreamPool[],
    private maxConnectionsPerPool: number = 10
  ) {}

  /**
   * Get or create connection to upstream pool
   */
  async getConnection(pool: UpstreamPool): Promise<net.Socket> {
    const poolConnections = this.poolConnections.get(pool.id) || [];
    
    // Try to reuse existing connection
    for (const socket of poolConnections) {
      if (!socket.destroyed && socket.readyState === 'open') {
        return socket;
      }
    }

    // Create new connection
    const socket = await this.createConnection(pool);
    poolConnections.push(socket);
    this.poolConnections.set(pool.id, poolConnections);

    // Clean up when connection closes
    socket.once('close', () => {
      const connections = this.poolConnections.get(pool.id) || [];
      const index = connections.indexOf(socket);
      if (index > -1) {
        connections.splice(index, 1);
      }
    });

    return socket;
  }

  private async createConnection(pool: UpstreamPool): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({
        host: pool.host,
        port: pool.port,
        timeout: 10000
      });

      socket.once('connect', () => {
        // Configure socket
        socket.setKeepAlive(true, 30000);
        socket.setNoDelay(true);
        
        logger.debug('Connected to upstream pool', {
          poolId: pool.id,
          host: pool.host,
          port: pool.port
        });

        resolve(socket);
      });

      socket.once('error', reject);
    });
  }

  /**
   * Close all connections to a pool
   */
  closePoolConnections(poolId: string): void {
    const connections = this.poolConnections.get(poolId) || [];
    for (const socket of connections) {
      socket.destroy();
    }
    this.poolConnections.delete(poolId);
  }

  /**
   * Close all connections
   */
  closeAllConnections(): void {
    for (const [poolId, connections] of this.poolConnections) {
      for (const socket of connections) {
        socket.destroy();
      }
    }
    this.poolConnections.clear();
  }
}

/**
 * Main Mining Proxy Server
 */
export class MiningProxyServer extends EventEmitter {
  private server: net.Server | null = null;
  private connections = new Map<string, MinerConnection>();
  private loadBalancer: LoadBalancer;
  private healthMonitor: PoolHealthMonitor;
  private connectionPool: ConnectionPoolManager;
  private memoryManager = getMemoryAlignmentManager();
  private cpuAffinity = createCPUAffinityManager();
  private statistics = {
    totalConnections: 0,
    activeConnections: 0,
    totalShares: 0,
    acceptedShares: 0,
    rejectedShares: 0,
    bytesTransferred: 0,
    uptime: 0,
    startTime: Date.now()
  };

  constructor(private config: ProxyConfig) {
    super();
    
    this.loadBalancer = new LoadBalancer(config);
    this.healthMonitor = new PoolHealthMonitor(config.upstreamPools);
    this.connectionPool = new ConnectionPoolManager(config.upstreamPools);
    
    this.setupEventHandlers();
    
    logger.info('Mining proxy server initialized', {
      listenPort: config.listenPort,
      upstreamPools: config.upstreamPools.length,
      loadBalancing: config.loadBalancing
    });
  }

  /**
   * Start the proxy server
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleMinerConnection(socket);
      });

      this.server.listen(this.config.listenPort, this.config.listenHost, () => {
        logger.info('Mining proxy server started', {
          host: this.config.listenHost,
          port: this.config.listenPort
        });
        
        this.statistics.startTime = Date.now();
        this.startPeriodicTasks();
        resolve();
      });

      this.server.once('error', reject);
    });
  }

  /**
   * Handle new miner connection
   */
  private handleMinerConnection(socket: net.Socket): void {
    const connectionId = crypto.randomUUID();
    const remoteAddress = socket.remoteAddress || 'unknown';
    const remotePort = socket.remotePort || 0;

    // Check connection limit
    if (this.connections.size >= this.config.maxConnections) {
      logger.warn('Connection limit exceeded', { remoteAddress });
      socket.end();
      return;
    }

    // Create miner connection object
    const minerConnection: MinerConnection = {
      id: connectionId,
      socket,
      remoteAddress,
      remotePort,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      bytesReceived: 0,
      bytesSent: 0,
      sharesSubmitted: 0,
      sharesAccepted: 0,
      hashrate: 0,
      difficulty: 1,
      state: 'connecting',
      buffer: Buffer.alloc(0)
    };

    this.connections.set(connectionId, minerConnection);
    this.statistics.totalConnections++;
    this.statistics.activeConnections++;

    // Set CPU affinity for networking
    this.cpuAffinity.setProcessAffinity('networking');

    // Configure socket
    socket.setKeepAlive(true, this.config.keepAliveInterval);
    socket.setNoDelay(true);
    socket.setTimeout(this.config.connectionTimeout);

    // Setup event handlers
    socket.on('data', (data) => {
      this.handleMinerData(connectionId, data);
    });

    socket.on('close', () => {
      this.handleMinerDisconnect(connectionId);
    });

    socket.on('error', (error) => {
      logger.warn('Miner connection error', {
        connectionId,
        remoteAddress,
        error: error.message
      });
      this.handleMinerDisconnect(connectionId);
    });

    socket.on('timeout', () => {
      logger.warn('Miner connection timeout', { connectionId, remoteAddress });
      socket.destroy();
    });

    logger.debug('New miner connection', {
      connectionId,
      remoteAddress,
      remotePort,
      totalConnections: this.connections.size
    });

    this.emit('minerConnected', minerConnection);
  }

  /**
   * Handle data from miner
   */
  private async handleMinerData(connectionId: string, data: Buffer): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    connection.lastActivity = Date.now();
    connection.bytesReceived += data.length;
    this.statistics.bytesTransferred += data.length;

    // Buffer the data
    connection.buffer = Buffer.concat([connection.buffer, data]);

    // Process complete messages
    while (connection.buffer.length > 0) {
      const messageEnd = connection.buffer.indexOf('\n');
      if (messageEnd === -1) break;

      const messageBuffer = connection.buffer.slice(0, messageEnd);
      connection.buffer = connection.buffer.slice(messageEnd + 1);

      try {
        const message = JSON.parse(messageBuffer.toString());
        await this.processMessage(connection, message);
      } catch (error) {
        logger.warn('Invalid message from miner', {
          connectionId,
          error: (error as Error).message
        });
      }
    }

    // Prevent buffer overflow
    if (connection.buffer.length > this.config.bufferSize) {
      logger.warn('Buffer overflow, disconnecting miner', { connectionId });
      connection.socket.destroy();
    }
  }

  /**
   * Process message from miner
   */
  private async processMessage(connection: MinerConnection, message: any): Promise<void> {
    // Handle different message types
    switch (message.method) {
      case 'mining.subscribe':
        await this.handleMiningSubscribe(connection, message);
        break;
      case 'mining.authorize':
        await this.handleMiningAuthorize(connection, message);
        break;
      case 'mining.submit':
        await this.handleMiningSubmit(connection, message);
        break;
      default:
        // Forward unknown messages to upstream
        await this.forwardToUpstream(connection, message);
    }
  }

  /**
   * Handle mining.subscribe
   */
  private async handleMiningSubscribe(connection: MinerConnection, message: any): Promise<void> {
    // Select upstream pool
    const pool = this.loadBalancer.selectUpstreamPool(
      this.config.upstreamPools,
      connection
    );

    if (!pool) {
      const errorResponse = {
        id: message.id,
        result: null,
        error: [21, 'No healthy upstream pools available', null]
      };
      this.sendToMiner(connection, errorResponse);
      return;
    }

    // Connect to upstream pool
    try {
      const upstreamSocket = await this.connectionPool.getConnection(pool);
      connection.upstreamPool = pool;
      connection.upstreamSocket = upstreamSocket;
      connection.state = 'connected';

      // Setup upstream event handlers
      this.setupUpstreamHandlers(connection, upstreamSocket);

      // Forward subscribe message
      await this.forwardToUpstream(connection, message);

      this.loadBalancer.updateConnectionCount(pool.id, 1);
      pool.stats.activeConnections++;

      logger.debug('Miner connected to upstream pool', {
        connectionId: connection.id,
        poolId: pool.id
      });
    } catch (error) {
      logger.error('Failed to connect to upstream pool', error as Error, {
        connectionId: connection.id,
        poolId: pool.id
      });

      const errorResponse = {
        id: message.id,
        result: null,
        error: [20, 'Failed to connect to upstream pool', null]
      };
      this.sendToMiner(connection, errorResponse);
    }
  }

  /**
   * Handle mining.authorize
   */
  private async handleMiningAuthorize(connection: MinerConnection, message: any): Promise<void> {
    connection.minerId = message.params[0];
    connection.state = 'authenticated';
    
    await this.forwardToUpstream(connection, message);
    
    logger.debug('Miner authenticated', {
      connectionId: connection.id,
      minerId: connection.minerId
    });
  }

  /**
   * Handle mining.submit
   */
  private async handleMiningSubmit(connection: MinerConnection, message: any): Promise<void> {
    connection.sharesSubmitted++;
    this.statistics.totalShares++;
    
    if (connection.upstreamPool) {
      connection.upstreamPool.stats.totalShares++;
    }

    await this.forwardToUpstream(connection, message);

    // Update hashrate estimation
    this.updateHashrateEstimate(connection);
  }

  /**
   * Setup upstream socket handlers
   */
  private setupUpstreamHandlers(connection: MinerConnection, upstreamSocket: net.Socket): void {
    upstreamSocket.on('data', (data) => {
      this.handleUpstreamData(connection, data);
    });

    upstreamSocket.on('close', () => {
      logger.debug('Upstream connection closed', {
        connectionId: connection.id,
        poolId: connection.upstreamPool?.id
      });
      
      if (connection.upstreamPool) {
        connection.upstreamPool.stats.activeConnections--;
        this.loadBalancer.updateConnectionCount(connection.upstreamPool.id, -1);
      }
      
      // Try failover if enabled
      if (this.config.failoverEnabled) {
        this.attemptFailover(connection);
      } else {
        connection.socket.destroy();
      }
    });

    upstreamSocket.on('error', (error) => {
      logger.warn('Upstream connection error', {
        connectionId: connection.id,
        poolId: connection.upstreamPool?.id,
        error: error.message
      });
    });
  }

  /**
   * Handle data from upstream pool
   */
  private handleUpstreamData(connection: MinerConnection, data: Buffer): void {
    connection.bytesSent += data.length;
    this.statistics.bytesTransferred += data.length;

    // Parse and potentially modify responses
    const messages = data.toString().split('\n').filter(line => line.trim());
    
    for (const messageStr of messages) {
      try {
        const message = JSON.parse(messageStr);
        
        // Track share acceptance
        if (message.result === true && connection.sharesSubmitted > 0) {
          connection.sharesAccepted++;
          this.statistics.acceptedShares++;
          
          if (connection.upstreamPool) {
            connection.upstreamPool.stats.acceptedShares++;
          }
        }

        // Forward to miner
        this.sendToMiner(connection, message);
      } catch (error) {
        // Forward raw data if not JSON
        connection.socket.write(messageStr + '\n');
      }
    }
  }

  /**
   * Forward message to upstream pool
   */
  private async forwardToUpstream(connection: MinerConnection, message: any): Promise<void> {
    if (!connection.upstreamSocket || connection.upstreamSocket.destroyed) {
      logger.warn('No upstream connection available', {
        connectionId: connection.id
      });
      return;
    }

    const messageStr = JSON.stringify(message) + '\n';
    connection.upstreamSocket.write(messageStr);
  }

  /**
   * Send message to miner
   */
  private sendToMiner(connection: MinerConnection, message: any): void {
    if (connection.socket.destroyed) return;

    const messageStr = JSON.stringify(message) + '\n';
    connection.socket.write(messageStr);
  }

  /**
   * Attempt failover to another pool
   */
  private async attemptFailover(connection: MinerConnection): Promise<void> {
    logger.info('Attempting failover', {
      connectionId: connection.id,
      currentPool: connection.upstreamPool?.id
    });

    // Select different pool
    const availablePools = this.config.upstreamPools.filter(
      pool => pool.id !== connection.upstreamPool?.id
    );

    const newPool = this.loadBalancer.selectUpstreamPool(availablePools, connection);
    if (!newPool) {
      logger.warn('No failover pools available', {
        connectionId: connection.id
      });
      connection.socket.destroy();
      return;
    }

    try {
      const newSocket = await this.connectionPool.getConnection(newPool);
      
      // Close old connection
      if (connection.upstreamSocket) {
        connection.upstreamSocket.destroy();
      }

      // Update connection
      connection.upstreamPool = newPool;
      connection.upstreamSocket = newSocket;
      this.setupUpstreamHandlers(connection, newSocket);

      // Re-authenticate with new pool
      if (connection.minerId) {
        const subscribeMessage = {
          id: 1,
          method: 'mining.subscribe',
          params: []
        };
        await this.forwardToUpstream(connection, subscribeMessage);

        const authorizeMessage = {
          id: 2,
          method: 'mining.authorize',
          params: [connection.minerId, 'x']
        };
        await this.forwardToUpstream(connection, authorizeMessage);
      }

      logger.info('Failover successful', {
        connectionId: connection.id,
        newPool: newPool.id
      });
    } catch (error) {
      logger.error('Failover failed', error as Error, {
        connectionId: connection.id
      });
      connection.socket.destroy();
    }
  }

  /**
   * Update hashrate estimate for connection
   */
  private updateHashrateEstimate(connection: MinerConnection): void {
    const now = Date.now();
    const timeWindow = 300000; // 5 minutes
    const timeElapsed = (now - connection.connectedAt) / 1000;
    
    if (timeElapsed > 0) {
      // Simplified hashrate calculation
      connection.hashrate = (connection.sharesSubmitted * connection.difficulty * Math.pow(2, 32)) / timeElapsed;
    }
  }

  /**
   * Handle miner disconnect
   */
  private handleMinerDisconnect(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    // Clean up upstream connection
    if (connection.upstreamSocket) {
      connection.upstreamSocket.destroy();
    }

    if (connection.upstreamPool) {
      connection.upstreamPool.stats.activeConnections--;
      this.loadBalancer.updateConnectionCount(connection.upstreamPool.id, -1);
    }

    this.connections.delete(connectionId);
    this.statistics.activeConnections--;

    logger.debug('Miner disconnected', {
      connectionId,
      sessionDuration: Date.now() - connection.connectedAt,
      sharesSubmitted: connection.sharesSubmitted,
      bytesTransferred: connection.bytesReceived + connection.bytesSent
    });

    this.emit('minerDisconnected', connection);
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers(): void {
    this.healthMonitor.on('poolUnhealthy', (pool) => {
      logger.warn('Pool marked as unhealthy', { poolId: pool.id });
      this.emit('poolUnhealthy', pool);
    });

    this.healthMonitor.on('poolHealthy', (pool) => {
      logger.debug('Pool marked as healthy', { poolId: pool.id });
      this.emit('poolHealthy', pool);
    });
  }

  /**
   * Start periodic tasks
   */
  private startPeriodicTasks(): void {
    // Update statistics
    setInterval(() => {
      this.statistics.uptime = Date.now() - this.statistics.startTime;
      this.emit('statistics', this.getStatistics());
    }, 60000); // Every minute

    // Clean up stale connections
    setInterval(() => {
      this.cleanupStaleConnections();
    }, 300000); // Every 5 minutes
  }

  /**
   * Clean up stale connections
   */
  private cleanupStaleConnections(): void {
    const now = Date.now();
    const timeout = 600000; // 10 minutes

    for (const [connectionId, connection] of this.connections) {
      if (now - connection.lastActivity > timeout) {
        logger.info('Cleaning up stale connection', {
          connectionId,
          lastActivity: new Date(connection.lastActivity)
        });
        connection.socket.destroy();
      }
    }
  }

  /**
   * Get comprehensive statistics
   */
  getStatistics(): {
    proxy: typeof this.statistics;
    pools: Array<{
      id: string;
      name: string;
      stats: UpstreamPool['stats'];
      healthy: boolean;
    }>;
    connections: {
      total: number;
      byState: { [state: string]: number };
      averageHashrate: number;
    };
  } {
    // Connection statistics by state
    const byState: { [state: string]: number } = {};
    let totalHashrate = 0;

    for (const connection of this.connections.values()) {
      byState[connection.state] = (byState[connection.state] || 0) + 1;
      totalHashrate += connection.hashrate;
    }

    // Pool statistics
    const poolStats = this.config.upstreamPools.map(pool => ({
      id: pool.id,
      name: pool.name,
      stats: pool.stats,
      healthy: this.healthMonitor['isPoolHealthy'](pool)
    }));

    return {
      proxy: this.statistics,
      pools: poolStats,
      connections: {
        total: this.connections.size,
        byState,
        averageHashrate: this.connections.size > 0 ? totalHashrate / this.connections.size : 0
      }
    };
  }

  /**
   * Stop the proxy server
   */
  async stop(): Promise<void> {
    logger.info('Stopping mining proxy server...');

    // Close all miner connections
    for (const connection of this.connections.values()) {
      connection.socket.destroy();
    }

    // Close upstream connections
    this.connectionPool.closeAllConnections();

    // Stop health monitor
    this.healthMonitor.stop();

    // Close server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
    }

    logger.info('Mining proxy server stopped');
  }
}

export {
  ProxyConfig,
  UpstreamPool,
  MinerConnection,
  LoadBalancer,
  PoolHealthMonitor,
  ConnectionPoolManager
};
