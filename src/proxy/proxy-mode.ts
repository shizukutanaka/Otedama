/**
 * Proxy Mode - Mining Proxy Server
 * Following Carmack/Martin/Pike principles:
 * - Efficient connection multiplexing
 * - Low-latency forwarding
 * - Smart routing and load balancing
 */

import { EventEmitter } from 'events';
import * as net from 'net';
import * as tls from 'tls';
import { logger } from '../utils/logger';

interface UpstreamPool {
  id: string;
  host: string;
  port: number;
  ssl?: boolean;
  priority: number;
  weight: number;
  
  // Authentication
  user?: string;
  password?: string;
  
  // Status
  connected: boolean;
  lastSeen: Date;
  shares: {
    accepted: number;
    rejected: number;
    stale: number;
  };
  
  // Connection
  socket?: net.Socket | tls.TLSSocket;
  miners: Set<string>;
}

interface DownstreamMiner {
  id: string;
  socket: net.Socket;
  address: string;
  
  // Authentication
  authorized: boolean;
  username?: string;
  
  // Subscription
  subscribed: boolean;
  extraNonce1?: string;
  
  // Difficulty
  difficulty: number;
  vardiff?: {
    min: number;
    max: number;
    target: number;
    window: number;
    shares: number[];
  };
  
  // Pool assignment
  poolId?: string;
  
  // Statistics
  connectTime: Date;
  shares: {
    submitted: number;
    accepted: number;
    rejected: number;
  };
  hashRate: number;
}

interface ProxyConfig {
  listenHost: string;
  listenPort: number;
  ssl?: {
    cert: string;
    key: string;
  };
  
  // Pool selection
  strategy: 'priority' | 'roundrobin' | 'leastconn' | 'weighted';
  
  // Vardiff
  vardiff: {
    enabled: boolean;
    minDiff: number;
    maxDiff: number;
    targetTime: number;
    retargetTime: number;
    variancePercent: number;
  };
  
  // Connection limits
  maxMinersPerPool: number;
  maxTotalMiners: number;
  
  // Timeouts
  minerTimeout: number;
  poolTimeout: number;
}

export class ProxyMode extends EventEmitter {
  private config: ProxyConfig;
  private server?: net.Server;
  private pools: Map<string, UpstreamPool> = new Map();
  private miners: Map<string, DownstreamMiner> = new Map();
  private nextMinerId: number = 1;
  private nextPoolIndex: number = 0;
  private stats = {
    totalShares: 0,
    acceptedShares: 0,
    rejectedShares: 0,
    staleShares: 0,
    uptimeStart: new Date()
  };

  constructor(config: ProxyConfig) {
    super();
    this.config = config;
  }

  /**
   * Add upstream pool
   */
  addPool(pool: Omit<UpstreamPool, 'connected' | 'lastSeen' | 'shares' | 'miners'>): void {
    const fullPool: UpstreamPool = {
      ...pool,
      connected: false,
      lastSeen: new Date(),
      shares: {
        accepted: 0,
        rejected: 0,
        stale: 0
      },
      miners: new Set()
    };

    this.pools.set(pool.id, fullPool);
    this.connectToPool(fullPool);
    
    logger.info('Added upstream pool', {
      poolId: pool.id,
      host: pool.host,
      port: pool.port
    });
  }

  /**
   * Remove upstream pool
   */
  removePool(poolId: string): void {
    const pool = this.pools.get(poolId);
    if (!pool) return;

    // Migrate miners to other pools
    for (const minerId of pool.miners) {
      const miner = this.miners.get(minerId);
      if (miner) {
        this.assignMinerToPool(miner);
      }
    }

    // Close pool connection
    if (pool.socket) {
      pool.socket.destroy();
    }

    this.pools.delete(poolId);
    
    logger.info('Removed upstream pool', { poolId });
  }

  /**
   * Start proxy server
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer();

      this.server.on('connection', (socket) => {
        this.handleMinerConnection(socket);
      });

      this.server.on('error', (err) => {
        logger.error('Proxy server error', { error: err });
        reject(err);
      });

      this.server.on('listening', () => {
        const addr = this.server!.address();
        logger.info('Proxy server listening', addr);
        this.emit('listening', addr);
        resolve();
      });

      this.server.listen(this.config.listenPort, this.config.listenHost);
    });
  }

  /**
   * Stop proxy server
   */
  stop(): void {
    // Close all miner connections
    for (const miner of this.miners.values()) {
      miner.socket.destroy();
    }
    this.miners.clear();

    // Close all pool connections
    for (const pool of this.pools.values()) {
      if (pool.socket) {
        pool.socket.destroy();
      }
    }

    // Close server
    if (this.server) {
      this.server.close();
      this.server = undefined;
    }

    logger.info('Proxy server stopped');
    this.emit('stopped');
  }

  /**
   * Handle new miner connection
   */
  private handleMinerConnection(socket: net.Socket): void {
    const minerId = `miner-${this.nextMinerId++}`;
    const address = `${socket.remoteAddress}:${socket.remotePort}`;

    const miner: DownstreamMiner = {
      id: minerId,
      socket,
      address,
      authorized: false,
      subscribed: false,
      difficulty: this.config.vardiff.minDiff,
      connectTime: new Date(),
      shares: {
        submitted: 0,
        accepted: 0,
        rejected: 0
      },
      hashRate: 0
    };

    // Setup vardiff if enabled
    if (this.config.vardiff.enabled) {
      miner.vardiff = {
        min: this.config.vardiff.minDiff,
        max: this.config.vardiff.maxDiff,
        target: this.config.vardiff.targetTime,
        window: this.config.vardiff.retargetTime,
        shares: []
      };
    }

    this.miners.set(minerId, miner);

    logger.info('Miner connected', { minerId, address });

    // Setup socket handlers
    let buffer = '';
    
    socket.on('data', (data) => {
      buffer += data.toString();
      let newlineIndex;
      
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.substring(0, newlineIndex);
        buffer = buffer.substring(newlineIndex + 1);
        
        if (line.trim()) {
          this.handleMinerMessage(miner, line);
        }
      }
    });

    socket.on('error', (err) => {
      logger.error('Miner socket error', { minerId, error: err });
    });

    socket.on('close', () => {
      this.handleMinerDisconnect(miner);
    });

    // Set timeout
    socket.setTimeout(this.config.minerTimeout);
    socket.on('timeout', () => {
      logger.warn('Miner timeout', { minerId });
      socket.destroy();
    });
  }

  /**
   * Handle miner message
   */
  private handleMinerMessage(miner: DownstreamMiner, message: string): void {
    try {
      const data = JSON.parse(message);
      
      logger.debug('Miner message', {
        minerId: miner.id,
        method: data.method,
        id: data.id
      });

      // Handle different methods
      switch (data.method) {
        case 'mining.subscribe':
          this.handleMinerSubscribe(miner, data);
          break;
          
        case 'mining.authorize':
          this.handleMinerAuthorize(miner, data);
          break;
          
        case 'mining.submit':
          this.handleMinerSubmit(miner, data);
          break;
          
        case 'mining.get_transactions':
          this.handleMinerGetTransactions(miner, data);
          break;
          
        default:
          // Forward to upstream pool
          this.forwardToPool(miner, data);
      }
    } catch (err) {
      logger.error('Invalid miner message', {
        minerId: miner.id,
        message,
        error: err
      });
    }
  }

  /**
   * Handle mining.subscribe
   */
  private handleMinerSubscribe(miner: DownstreamMiner, data: any): void {
    // Assign miner to pool
    this.assignMinerToPool(miner);
    
    if (!miner.poolId) {
      this.sendToMiner(miner, {
        id: data.id,
        result: null,
        error: [20, 'No pools available', null]
      });
      return;
    }

    // Generate extra nonce for miner
    miner.extraNonce1 = crypto.randomBytes(4).toString('hex');
    miner.subscribed = true;

    // Send subscription response
    this.sendToMiner(miner, {
      id: data.id,
      result: [
        [
          ['mining.set_difficulty', miner.id],
          ['mining.notify', miner.id]
        ],
        miner.extraNonce1,
        4 // extraNonce2 size
      ],
      error: null
    });

    // Send initial difficulty
    this.sendToMiner(miner, {
      id: null,
      method: 'mining.set_difficulty',
      params: [miner.difficulty]
    });

    // Forward subscription to pool
    this.forwardToPool(miner, data);
  }

  /**
   * Handle mining.authorize
   */
  private handleMinerAuthorize(miner: DownstreamMiner, data: any): void {
    const [username, password] = data.params;
    
    miner.username = username;
    miner.authorized = true;

    this.sendToMiner(miner, {
      id: data.id,
      result: true,
      error: null
    });

    logger.info('Miner authorized', {
      minerId: miner.id,
      username
    });

    // Forward to pool with proxy credentials
    const pool = this.pools.get(miner.poolId!);
    if (pool && pool.user) {
      data.params = [pool.user, pool.password || ''];
    }
    
    this.forwardToPool(miner, data);
  }

  /**
   * Handle mining.submit
   */
  private handleMinerSubmit(miner: DownstreamMiner, data: any): void {
    miner.shares.submitted++;
    this.stats.totalShares++;

    // Update vardiff
    if (miner.vardiff) {
      this.updateVardiff(miner);
    }

    // Forward to pool
    this.forwardToPool(miner, data);

    // Track submission time for vardiff
    if (miner.vardiff) {
      miner.vardiff.shares.push(Date.now());
    }
  }

  /**
   * Handle mining.get_transactions
   */
  private handleMinerGetTransactions(miner: DownstreamMiner, data: any): void {
    // Forward to pool
    this.forwardToPool(miner, data);
  }

  /**
   * Assign miner to pool
   */
  private assignMinerToPool(miner: DownstreamMiner): void {
    const availablePools = Array.from(this.pools.values())
      .filter(p => p.connected && p.miners.size < this.config.maxMinersPerPool)
      .sort((a, b) => a.priority - b.priority);

    if (availablePools.length === 0) {
      logger.warn('No available pools for miner', { minerId: miner.id });
      return;
    }

    let selectedPool: UpstreamPool;

    switch (this.config.strategy) {
      case 'priority':
        selectedPool = availablePools[0];
        break;
        
      case 'roundrobin':
        selectedPool = availablePools[this.nextPoolIndex % availablePools.length];
        this.nextPoolIndex++;
        break;
        
      case 'leastconn':
        selectedPool = availablePools.reduce((min, pool) => 
          pool.miners.size < min.miners.size ? pool : min
        );
        break;
        
      case 'weighted':
        selectedPool = this.selectWeightedPool(availablePools);
        break;
        
      default:
        selectedPool = availablePools[0];
    }

    // Remove from old pool if any
    if (miner.poolId) {
      const oldPool = this.pools.get(miner.poolId);
      if (oldPool) {
        oldPool.miners.delete(miner.id);
      }
    }

    miner.poolId = selectedPool.id;
    selectedPool.miners.add(miner.id);

    logger.debug('Assigned miner to pool', {
      minerId: miner.id,
      poolId: selectedPool.id
    });
  }

  /**
   * Select pool by weight
   */
  private selectWeightedPool(pools: UpstreamPool[]): UpstreamPool {
    const totalWeight = pools.reduce((sum, pool) => sum + pool.weight, 0);
    let random = Math.random() * totalWeight;
    
    for (const pool of pools) {
      random -= pool.weight;
      if (random <= 0) {
        return pool;
      }
    }
    
    return pools[0];
  }

  /**
   * Connect to upstream pool
   */
  private connectToPool(pool: UpstreamPool): void {
    const connect = () => {
      const socket = pool.ssl
        ? tls.connect({
            host: pool.host,
            port: pool.port,
            rejectUnauthorized: false
          })
        : net.connect({
            host: pool.host,
            port: pool.port
          });

      pool.socket = socket;
      let buffer = '';

      socket.on('connect', () => {
        pool.connected = true;
        pool.lastSeen = new Date();
        
        logger.info('Connected to upstream pool', {
          poolId: pool.id,
          host: pool.host,
          port: pool.port
        });
        
        this.emit('pool:connected', pool.id);
      });

      socket.on('data', (data) => {
        buffer += data.toString();
        let newlineIndex;
        
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.substring(0, newlineIndex);
          buffer = buffer.substring(newlineIndex + 1);
          
          if (line.trim()) {
            this.handlePoolMessage(pool, line);
          }
        }
      });

      socket.on('error', (err) => {
        logger.error('Pool socket error', {
          poolId: pool.id,
          error: err
        });
      });

      socket.on('close', () => {
        pool.connected = false;
        
        logger.warn('Disconnected from pool', { poolId: pool.id });
        
        this.emit('pool:disconnected', pool.id);
        
        // Reconnect after delay
        setTimeout(() => {
          if (this.pools.has(pool.id)) {
            connect();
          }
        }, 5000);
      });

      // Set timeout
      socket.setTimeout(this.config.poolTimeout);
    };

    connect();
  }

  /**
   * Handle pool message
   */
  private handlePoolMessage(pool: UpstreamPool, message: string): void {
    try {
      const data = JSON.parse(message);
      
      // Update pool last seen
      pool.lastSeen = new Date();

      // Handle notifications
      if (data.method) {
        switch (data.method) {
          case 'mining.notify':
            this.broadcastToPoolMiners(pool, data);
            break;
            
          case 'mining.set_difficulty':
            // Don't forward pool difficulty directly, use vardiff
            break;
            
          case 'client.reconnect':
            this.handlePoolReconnect(pool, data);
            break;
            
          default:
            this.broadcastToPoolMiners(pool, data);
        }
      }
      
      // Handle responses
      else if (data.id) {
        // Find miner by request ID
        // In production, would maintain request ID mapping
        for (const minerId of pool.miners) {
          const miner = this.miners.get(minerId);
          if (miner) {
            // Update share statistics
            if (data.result === true) {
              miner.shares.accepted++;
              pool.shares.accepted++;
              this.stats.acceptedShares++;
            } else if (data.error) {
              miner.shares.rejected++;
              pool.shares.rejected++;
              this.stats.rejectedShares++;
            }
            
            this.sendToMiner(miner, data);
          }
        }
      }
    } catch (err) {
      logger.error('Invalid pool message', {
        poolId: pool.id,
        message,
        error: err
      });
    }
  }

  /**
   * Handle pool reconnect request
   */
  private handlePoolReconnect(pool: UpstreamPool, data: any): void {
    const [hostname, port, waitTime] = data.params;
    
    logger.warn('Pool requested reconnect', {
      poolId: pool.id,
      newHost: hostname,
      newPort: port,
      waitTime
    });

    // Update pool connection info
    pool.host = hostname;
    pool.port = port;

    // Reconnect after wait time
    setTimeout(() => {
      if (pool.socket) {
        pool.socket.destroy();
      }
    }, (waitTime || 0) * 1000);
  }

  /**
   * Broadcast message to all miners on pool
   */
  private broadcastToPoolMiners(pool: UpstreamPool, data: any): void {
    for (const minerId of pool.miners) {
      const miner = this.miners.get(minerId);
      if (miner) {
        this.sendToMiner(miner, data);
      }
    }
  }

  /**
   * Forward message to pool
   */
  private forwardToPool(miner: DownstreamMiner, data: any): void {
    if (!miner.poolId) return;

    const pool = this.pools.get(miner.poolId);
    if (!pool || !pool.socket || !pool.connected) {
      logger.warn('Cannot forward to pool - not connected', {
        minerId: miner.id,
        poolId: miner.poolId
      });
      return;
    }

    pool.socket.write(JSON.stringify(data) + '\n');
  }

  /**
   * Send message to miner
   */
  private sendToMiner(miner: DownstreamMiner, data: any): void {
    if (miner.socket.writable) {
      miner.socket.write(JSON.stringify(data) + '\n');
    }
  }

  /**
   * Update vardiff for miner
   */
  private updateVardiff(miner: DownstreamMiner): void {
    if (!miner.vardiff) return;

    const now = Date.now();
    const window = miner.vardiff.window * 1000;
    
    // Remove old shares outside window
    miner.vardiff.shares = miner.vardiff.shares.filter(
      time => now - time < window
    );

    // Need enough shares to adjust
    if (miner.vardiff.shares.length < 10) return;

    // Calculate average time between shares
    const times = miner.vardiff.shares.sort((a, b) => a - b);
    const intervals: number[] = [];
    
    for (let i = 1; i < times.length; i++) {
      intervals.push((times[i] - times[i - 1]) / 1000);
    }

    const avgInterval = intervals.reduce((a, b) => a + b) / intervals.length;
    const variance = Math.sqrt(
      intervals.reduce((sum, interval) => 
        sum + Math.pow(interval - avgInterval, 2), 0
      ) / intervals.length
    );

    // Check if adjustment needed
    const variancePercent = (variance / avgInterval) * 100;
    
    if (variancePercent > this.config.vardiff.variancePercent) {
      const targetInterval = miner.vardiff.target;
      const ratio = targetInterval / avgInterval;
      
      // Calculate new difficulty
      let newDiff = miner.difficulty * ratio;
      
      // Apply limits
      newDiff = Math.max(miner.vardiff.min, newDiff);
      newDiff = Math.min(miner.vardiff.max, newDiff);
      
      // Round to nice number
      const magnitude = Math.pow(10, Math.floor(Math.log10(newDiff)));
      newDiff = Math.round(newDiff / magnitude) * magnitude;
      
      if (newDiff !== miner.difficulty) {
        miner.difficulty = newDiff;
        
        // Send new difficulty
        this.sendToMiner(miner, {
          id: null,
          method: 'mining.set_difficulty',
          params: [miner.difficulty]
        });
        
        logger.debug('Adjusted miner difficulty', {
          minerId: miner.id,
          oldDiff: miner.difficulty,
          newDiff,
          avgInterval
        });
      }
    }
  }

  /**
   * Handle miner disconnect
   */
  private handleMinerDisconnect(miner: DownstreamMiner): void {
    logger.info('Miner disconnected', {
      minerId: miner.id,
      shares: miner.shares,
      uptime: Date.now() - miner.connectTime.getTime()
    });

    // Remove from pool
    if (miner.poolId) {
      const pool = this.pools.get(miner.poolId);
      if (pool) {
        pool.miners.delete(miner.id);
      }
    }

    // Remove miner
    this.miners.delete(miner.id);
    
    this.emit('miner:disconnected', {
      minerId: miner.id,
      stats: miner.shares
    });
  }

  /**
   * Get proxy statistics
   */
  getStatistics(): any {
    const uptime = Date.now() - this.stats.uptimeStart.getTime();
    
    return {
      uptime,
      miners: {
        connected: this.miners.size,
        authorized: Array.from(this.miners.values()).filter(m => m.authorized).length
      },
      pools: {
        total: this.pools.size,
        connected: Array.from(this.pools.values()).filter(p => p.connected).length
      },
      shares: {
        total: this.stats.totalShares,
        accepted: this.stats.acceptedShares,
        rejected: this.stats.rejectedShares,
        efficiency: this.stats.totalShares > 0 
          ? (this.stats.acceptedShares / this.stats.totalShares * 100).toFixed(2) + '%'
          : '0%'
      },
      poolStats: Array.from(this.pools.values()).map(pool => ({
        id: pool.id,
        connected: pool.connected,
        miners: pool.miners.size,
        shares: pool.shares
      }))
    };
  }
}

// Export types
export { UpstreamPool, DownstreamMiner, ProxyConfig };
