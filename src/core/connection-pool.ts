/**
 * Connection Pool Management System
 * Design: Carmack (Performance) + Martin (Clean Architecture) + Pike (Simplicity)
 * 
 * Efficient connection pooling for miners, databases, and RPC endpoints
 */

import { EventEmitter } from 'events';
import net from 'net';
import { Pool as PgPool, PoolConfig as PgPoolConfig } from 'pg';
import Redis from 'ioredis';
import { createComponentLogger } from '../logging/simple-logger';

// ===== INTERFACES =====
export interface ConnectionPoolConfig {
  type: 'tcp' | 'postgresql' | 'redis' | 'rpc';
  minConnections?: number;
  maxConnections?: number;
  acquireTimeout?: number; // ms
  idleTimeout?: number; // ms
  connectionTimeout?: number; // ms
  retryAttempts?: number;
  retryDelay?: number; // ms
  healthCheckInterval?: number; // ms
}

export interface TCPPoolConfig extends ConnectionPoolConfig {
  type: 'tcp';
  host: string;
  port: number;
  keepAlive?: boolean;
  keepAliveDelay?: number;
}

export interface DatabasePoolConfig extends ConnectionPoolConfig {
  type: 'postgresql';
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean;
}

export interface RedisPoolConfig extends ConnectionPoolConfig {
  type: 'redis';
  host: string;
  port: number;
  password?: string;
  db?: number;
  keyPrefix?: string;
}

export interface PoolStats {
  type: string;
  total: number;
  active: number;
  idle: number;
  waiting: number;
  created: number;
  destroyed: number;
  errors: number;
  avgAcquireTime: number;
  avgActiveTime: number;
}

export interface Connection<T> {
  id: string;
  connection: T;
  createdAt: number;
  lastUsedAt: number;
  useCount: number;
  inUse: boolean;
  healthy: boolean;
}

// ===== BASE CONNECTION POOL =====
abstract class BaseConnectionPool<T> extends EventEmitter {
  protected config: Required<ConnectionPoolConfig>;
  protected connections = new Map<string, Connection<T>>();
  protected availableConnections: string[] = [];
  protected waitingQueue: Array<(conn: T) => void> = [];
  protected logger = createComponentLogger('ConnectionPool');
  protected stats: PoolStats = {
    type: '',
    total: 0,
    active: 0,
    idle: 0,
    waiting: 0,
    created: 0,
    destroyed: 0,
    errors: 0,
    avgAcquireTime: 0,
    avgActiveTime: 0
  };
  protected healthCheckInterval?: NodeJS.Timeout;
  protected closed = false;
  private acquireTimes: number[] = [];
  private activeTimes: number[] = [];

  constructor(config: ConnectionPoolConfig) {
    super();
    
    this.config = {
      type: config.type,
      minConnections: config.minConnections || 2,
      maxConnections: config.maxConnections || 10,
      acquireTimeout: config.acquireTimeout || 30000,
      idleTimeout: config.idleTimeout || 600000, // 10 minutes
      connectionTimeout: config.connectionTimeout || 10000,
      retryAttempts: config.retryAttempts || 3,
      retryDelay: config.retryDelay || 1000,
      healthCheckInterval: config.healthCheckInterval || 60000
    };

    this.stats.type = config.type;
  }

  abstract createConnection(): Promise<T>;
  abstract destroyConnection(connection: T): Promise<void>;
  abstract validateConnection(connection: T): Promise<boolean>;

  async initialize(): Promise<void> {
    this.logger.info('Initializing connection pool', {
      type: this.config.type,
      minConnections: this.config.minConnections,
      maxConnections: this.config.maxConnections
    });

    // Create initial connections
    const promises: Promise<void>[] = [];
    for (let i = 0; i < this.config.minConnections; i++) {
      promises.push(this.createNewConnection());
    }

    await Promise.all(promises);

    // Start health check interval
    this.startHealthCheck();

    this.logger.info('Connection pool initialized', {
      type: this.config.type,
      connections: this.connections.size
    });

    this.emit('initialized');
  }

  async acquire(): Promise<T> {
    if (this.closed) {
      throw new Error('Connection pool is closed');
    }

    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const index = this.waitingQueue.indexOf(resolve as any);
        if (index > -1) {
          this.waitingQueue.splice(index, 1);
          this.stats.waiting--;
        }
        reject(new Error('Acquire timeout'));
      }, this.config.acquireTimeout);

      const tryAcquire = async () => {
        // Check for available connection
        if (this.availableConnections.length > 0) {
          const connId = this.availableConnections.shift()!;
          const conn = this.connections.get(connId);
          
          if (conn && conn.healthy) {
            clearTimeout(timeoutId);
            
            conn.inUse = true;
            conn.lastUsedAt = Date.now();
            conn.useCount++;
            
            this.stats.active++;
            this.stats.idle--;
            
            const acquireTime = Date.now() - startTime;
            this.recordAcquireTime(acquireTime);
            
            this.logger.debug('Connection acquired', {
              connectionId: connId,
              acquireTime
            });
            
            resolve(conn.connection);
            return;
          }
        }

        // Try to create new connection if under limit
        if (this.connections.size < this.config.maxConnections) {
          try {
            await this.createNewConnection();
            // Retry acquire
            tryAcquire();
          } catch (error) {
            clearTimeout(timeoutId);
            reject(error);
          }
        } else {
          // Add to waiting queue
          this.waitingQueue.push(resolve as any);
          this.stats.waiting++;
        }
      };

      tryAcquire();
    });
  }

  async release(connection: T): Promise<void> {
    // Find connection wrapper
    let connWrapper: Connection<T> | undefined;
    let connId: string | undefined;

    for (const [id, conn] of this.connections) {
      if (conn.connection === connection) {
        connWrapper = conn;
        connId = id;
        break;
      }
    }

    if (!connWrapper || !connId) {
      this.logger.warn('Attempted to release unknown connection');
      return;
    }

    const activeTime = Date.now() - connWrapper.lastUsedAt;
    this.recordActiveTime(activeTime);

    connWrapper.inUse = false;
    this.stats.active--;
    this.stats.idle++;

    // Check if connection is still healthy
    try {
      const isHealthy = await this.validateConnection(connection);
      connWrapper.healthy = isHealthy;

      if (!isHealthy) {
        await this.removeConnection(connId);
        return;
      }
    } catch (error) {
      this.logger.warn('Connection validation failed', error as Error);
      await this.removeConnection(connId);
      return;
    }

    // Check waiting queue
    if (this.waitingQueue.length > 0) {
      const waiting = this.waitingQueue.shift()!;
      this.stats.waiting--;
      
      connWrapper.inUse = true;
      connWrapper.lastUsedAt = Date.now();
      connWrapper.useCount++;
      
      this.stats.active++;
      this.stats.idle--;
      
      waiting(connection);
    } else {
      // Add back to available pool
      this.availableConnections.push(connId);
      
      // Check if we should remove idle connections
      if (this.connections.size > this.config.minConnections && 
          Date.now() - connWrapper.lastUsedAt > this.config.idleTimeout) {
        await this.removeConnection(connId);
      }
    }

    this.logger.debug('Connection released', {
      connectionId: connId,
      activeTime
    });
  }

  private async createNewConnection(): Promise<void> {
    try {
      const connection = await this.createConnection();
      const connId = this.generateConnectionId();

      const connWrapper: Connection<T> = {
        id: connId,
        connection,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        useCount: 0,
        inUse: false,
        healthy: true
      };

      this.connections.set(connId, connWrapper);
      this.availableConnections.push(connId);
      this.stats.total++;
      this.stats.idle++;
      this.stats.created++;

      this.logger.debug('Created new connection', { connectionId: connId });
      this.emit('connection:created', connId);
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Failed to create connection', error as Error);
      throw error;
    }
  }

  private async removeConnection(connId: string): Promise<void> {
    const conn = this.connections.get(connId);
    if (!conn) return;

    try {
      await this.destroyConnection(conn.connection);
    } catch (error) {
      this.logger.warn('Error destroying connection', error as Error);
    }

    this.connections.delete(connId);
    
    const index = this.availableConnections.indexOf(connId);
    if (index > -1) {
      this.availableConnections.splice(index, 1);
    }

    this.stats.total--;
    if (conn.inUse) {
      this.stats.active--;
    } else {
      this.stats.idle--;
    }
    this.stats.destroyed++;

    this.logger.debug('Removed connection', { connectionId: connId });
    this.emit('connection:removed', connId);

    // Create replacement if below minimum
    if (this.connections.size < this.config.minConnections && !this.closed) {
      this.createNewConnection().catch(error => {
        this.logger.error('Failed to create replacement connection', error);
      });
    }
  }

  private startHealthCheck(): void {
    this.healthCheckInterval = setInterval(async () => {
      await this.performHealthCheck();
    }, this.config.healthCheckInterval);
  }

  private async performHealthCheck(): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const [connId, conn] of this.connections) {
      if (!conn.inUse) {
        promises.push(this.checkConnectionHealth(connId));
      }
    }

    await Promise.all(promises);

    // Clean up idle connections
    await this.cleanupIdleConnections();
  }

  private async checkConnectionHealth(connId: string): Promise<void> {
    const conn = this.connections.get(connId);
    if (!conn) return;

    try {
      const isHealthy = await this.validateConnection(conn.connection);
      conn.healthy = isHealthy;

      if (!isHealthy) {
        await this.removeConnection(connId);
      }
    } catch (error) {
      this.logger.warn('Health check failed', { connectionId: connId });
      await this.removeConnection(connId);
    }
  }

  private async cleanupIdleConnections(): Promise<void> {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [connId, conn] of this.connections) {
      if (!conn.inUse && 
          this.connections.size > this.config.minConnections &&
          now - conn.lastUsedAt > this.config.idleTimeout) {
        toRemove.push(connId);
      }
    }

    for (const connId of toRemove) {
      await this.removeConnection(connId);
    }
  }

  private generateConnectionId(): string {
    return `${this.config.type}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private recordAcquireTime(time: number): void {
    this.acquireTimes.push(time);
    if (this.acquireTimes.length > 1000) {
      this.acquireTimes.shift();
    }
    this.stats.avgAcquireTime = this.acquireTimes.reduce((a, b) => a + b, 0) / this.acquireTimes.length;
  }

  private recordActiveTime(time: number): void {
    this.activeTimes.push(time);
    if (this.activeTimes.length > 1000) {
      this.activeTimes.shift();
    }
    this.stats.avgActiveTime = this.activeTimes.reduce((a, b) => a + b, 0) / this.activeTimes.length;
  }

  getStats(): PoolStats {
    return { ...this.stats };
  }

  async close(): Promise<void> {
    this.closed = true;

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }

    // Destroy all connections
    const promises: Promise<void>[] = [];
    for (const [connId] of this.connections) {
      promises.push(this.removeConnection(connId));
    }

    await Promise.all(promises);

    this.logger.info('Connection pool closed', { type: this.config.type });
    this.emit('closed');
  }
}

// ===== TCP CONNECTION POOL =====
export class TCPConnectionPool extends BaseConnectionPool<net.Socket> {
  private tcpConfig: TCPPoolConfig;

  constructor(config: TCPPoolConfig) {
    super(config);
    this.tcpConfig = config;
  }

  async createConnection(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      
      const timeoutId = setTimeout(() => {
        socket.destroy();
        reject(new Error('Connection timeout'));
      }, this.config.connectionTimeout);

      socket.once('connect', () => {
        clearTimeout(timeoutId);
        
        if (this.tcpConfig.keepAlive) {
          socket.setKeepAlive(true, this.tcpConfig.keepAliveDelay || 10000);
        }
        
        resolve(socket);
      });

      socket.once('error', (error) => {
        clearTimeout(timeoutId);
        reject(error);
      });

      socket.connect(this.tcpConfig.port, this.tcpConfig.host);
    });
  }

  async destroyConnection(socket: net.Socket): Promise<void> {
    return new Promise((resolve) => {
      if (socket.destroyed) {
        resolve();
        return;
      }

      socket.once('close', () => resolve());
      socket.destroy();
    });
  }

  async validateConnection(socket: net.Socket): Promise<boolean> {
    return !socket.destroyed && socket.readable && socket.writable;
  }
}

// ===== POSTGRESQL CONNECTION POOL =====
export class PostgreSQLConnectionPool extends BaseConnectionPool<any> {
  private pgPool?: PgPool;
  private dbConfig: DatabasePoolConfig;

  constructor(config: DatabasePoolConfig) {
    super(config);
    this.dbConfig = config;
  }

  async initialize(): Promise<void> {
    const poolConfig: PgPoolConfig = {
      connectionString: this.dbConfig.connectionString,
      host: this.dbConfig.host,
      port: this.dbConfig.port,
      database: this.dbConfig.database,
      user: this.dbConfig.user,
      password: this.dbConfig.password,
      ssl: this.dbConfig.ssl,
      min: this.config.minConnections,
      max: this.config.maxConnections,
      idleTimeoutMillis: this.config.idleTimeout,
      connectionTimeoutMillis: this.config.connectionTimeout
    };

    this.pgPool = new PgPool(poolConfig);

    this.pgPool.on('error', (error) => {
      this.logger.error('PostgreSQL pool error', error);
      this.emit('error', error);
    });

    this.pgPool.on('connect', () => {
      this.stats.created++;
      this.stats.total = this.pgPool!.totalCount;
      this.stats.idle = this.pgPool!.idleCount;
      this.stats.waiting = this.pgPool!.waitingCount;
    });

    this.pgPool.on('remove', () => {
      this.stats.destroyed++;
      this.stats.total = this.pgPool!.totalCount;
    });

    // Test connection
    const client = await this.pgPool.connect();
    client.release();

    this.logger.info('PostgreSQL pool initialized');
    this.emit('initialized');
  }

  async createConnection(): Promise<any> {
    if (!this.pgPool) {
      throw new Error('Pool not initialized');
    }
    return await this.pgPool.connect();
  }

  async destroyConnection(client: any): Promise<void> {
    client.release(true); // true = destroy the connection
  }

  async validateConnection(client: any): Promise<boolean> {
    try {
      await client.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async acquire(): Promise<any> {
    if (!this.pgPool) {
      throw new Error('Pool not initialized');
    }
    
    const client = await this.pgPool.connect();
    this.stats.active++;
    this.stats.idle = this.pgPool.idleCount;
    
    return client;
  }

  async release(client: any): Promise<void> {
    client.release();
    
    if (this.pgPool) {
      this.stats.active--;
      this.stats.idle = this.pgPool.idleCount;
    }
  }

  async close(): Promise<void> {
    if (this.pgPool) {
      await this.pgPool.end();
      this.pgPool = undefined;
    }
    
    this.logger.info('PostgreSQL pool closed');
    this.emit('closed');
  }
}

// ===== REDIS CONNECTION POOL =====
export class RedisConnectionPool extends BaseConnectionPool<Redis> {
  private redisConfig: RedisPoolConfig;

  constructor(config: RedisPoolConfig) {
    super(config);
    this.redisConfig = config;
  }

  async createConnection(): Promise<Redis> {
    const redis = new Redis({
      host: this.redisConfig.host,
      port: this.redisConfig.port,
      password: this.redisConfig.password,
      db: this.redisConfig.db,
      keyPrefix: this.redisConfig.keyPrefix,
      connectTimeout: this.config.connectionTimeout,
      retryStrategy: (times) => {
        if (times > this.config.retryAttempts) {
          return null;
        }
        return Math.min(times * this.config.retryDelay, 10000);
      }
    });

    return new Promise((resolve, reject) => {
      redis.once('ready', () => resolve(redis));
      redis.once('error', reject);
    });
  }

  async destroyConnection(redis: Redis): Promise<void> {
    await redis.quit();
  }

  async validateConnection(redis: Redis): Promise<boolean> {
    try {
      const result = await redis.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }
}

// ===== CONNECTION POOL MANAGER =====
export class ConnectionPoolManager extends EventEmitter {
  private pools = new Map<string, BaseConnectionPool<any>>();
  private logger = createComponentLogger('PoolManager');

  async createPool(name: string, config: any): Promise<void> {
    if (this.pools.has(name)) {
      throw new Error(`Pool '${name}' already exists`);
    }

    let pool: BaseConnectionPool<any>;

    switch (config.type) {
      case 'tcp':
        pool = new TCPConnectionPool(config);
        break;
      case 'postgresql':
        pool = new PostgreSQLConnectionPool(config);
        break;
      case 'redis':
        pool = new RedisConnectionPool(config);
        break;
      default:
        throw new Error(`Unknown pool type: ${config.type}`);
    }

    await pool.initialize();
    this.pools.set(name, pool);

    this.logger.info('Created connection pool', { name, type: config.type });
    this.emit('pool:created', { name, type: config.type });
  }

  getPool(name: string): BaseConnectionPool<any> | undefined {
    return this.pools.get(name);
  }

  async acquire(poolName: string): Promise<any> {
    const pool = this.pools.get(poolName);
    if (!pool) {
      throw new Error(`Pool '${poolName}' not found`);
    }
    return await pool.acquire();
  }

  async release(poolName: string, connection: any): Promise<void> {
    const pool = this.pools.get(poolName);
    if (!pool) {
      throw new Error(`Pool '${poolName}' not found`);
    }
    await pool.release(connection);
  }

  getAllStats(): Map<string, PoolStats> {
    const stats = new Map<string, PoolStats>();
    
    for (const [name, pool] of this.pools) {
      stats.set(name, pool.getStats());
    }
    
    return stats;
  }

  async closePool(name: string): Promise<void> {
    const pool = this.pools.get(name);
    if (pool) {
      await pool.close();
      this.pools.delete(name);
      
      this.logger.info('Closed connection pool', { name });
      this.emit('pool:closed', { name });
    }
  }

  async closeAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    
    for (const [name] of this.pools) {
      promises.push(this.closePool(name));
    }
    
    await Promise.all(promises);
    
    this.logger.info('All connection pools closed');
    this.emit('all:closed');
  }
}

// ===== UTILITY FUNCTIONS =====
export function createTCPPool(config: Omit<TCPPoolConfig, 'type'>): TCPConnectionPool {
  return new TCPConnectionPool({ ...config, type: 'tcp' });
}

export function createPostgreSQLPool(config: Omit<DatabasePoolConfig, 'type'>): PostgreSQLConnectionPool {
  return new PostgreSQLConnectionPool({ ...config, type: 'postgresql' });
}

export function createRedisPool(config: Omit<RedisPoolConfig, 'type'>): RedisConnectionPool {
  return new RedisConnectionPool({ ...config, type: 'redis' });
}
