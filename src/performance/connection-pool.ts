// Database connection pooling for efficient resource usage (Uncle Bob clean architecture)
import { Database as SQLiteDB } from 'sqlite3';
import { open, Database as SQLiteDatabase } from 'sqlite';
import { EventEmitter } from 'events';
import { createComponentLogger } from '../logging/logger';

const logger = createComponentLogger('connection-pool');

// Connection pool configuration
export interface PoolConfig {
  minConnections: number;
  maxConnections: number;
  acquireTimeout: number;    // ms to wait for connection
  idleTimeout: number;       // ms before closing idle connection
  reapInterval: number;      // ms between idle connection checks
  retryDelay: number;        // ms between connection retries
  validateOnAcquire: boolean;
}

// Default configuration
const DEFAULT_POOL_CONFIG: PoolConfig = {
  minConnections: 2,
  maxConnections: 10,
  acquireTimeout: 30000,
  idleTimeout: 300000,      // 5 minutes
  reapInterval: 60000,       // 1 minute
  retryDelay: 1000,
  validateOnAcquire: true
};

// Connection wrapper
interface PooledConnection {
  id: string;
  connection: SQLiteDatabase<SQLiteDB>;
  inUse: boolean;
  lastUsed: number;
  created: number;
  queryCount: number;
}

// Connection pool implementation
export class ConnectionPool extends EventEmitter {
  private connections: PooledConnection[] = [];
  private waitQueue: Array<{
    resolve: (conn: PooledConnection) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = [];
  
  private reapInterval: NodeJS.Timeout | null = null;
  private closed = false;
  private stats = {
    connectionsCreated: 0,
    connectionsDestroyed: 0,
    acquireCount: 0,
    releaseCount: 0,
    timeouts: 0,
    errors: 0
  };
  
  constructor(
    private dbPath: string,
    private config: PoolConfig = DEFAULT_POOL_CONFIG
  ) {
    super();
    this.initialize();
  }
  
  private async initialize(): Promise<void> {
    // Create minimum connections
    for (let i = 0; i < this.config.minConnections; i++) {
      try {
        await this.createConnection();
      } catch (error) {
        logger.error('Failed to create initial connection', error as Error);
      }
    }
    
    // Start reaper for idle connections
    this.startReaper();
    
    logger.info('Connection pool initialized', {
      minConnections: this.config.minConnections,
      maxConnections: this.config.maxConnections
    });
  }
  
  // Create new database connection
  private async createConnection(): Promise<PooledConnection> {
    const connection = await open({
      filename: this.dbPath,
      driver: SQLiteDB
    });
    
    // Configure connection
    await connection.exec('PRAGMA journal_mode = WAL');
    await connection.exec('PRAGMA synchronous = NORMAL');
    await connection.exec('PRAGMA cache_size = -64000');
    await connection.exec('PRAGMA temp_store = MEMORY');
    
    const pooledConnection: PooledConnection = {
      id: `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      connection,
      inUse: false,
      lastUsed: Date.now(),
      created: Date.now(),
      queryCount: 0
    };
    
    this.connections.push(pooledConnection);
    this.stats.connectionsCreated++;
    
    this.emit('connectionCreated', pooledConnection.id);
    
    return pooledConnection;
  }
  
  // Acquire connection from pool
  async acquire(): Promise<PooledConnection> {
    if (this.closed) {
      throw new Error('Connection pool is closed');
    }
    
    this.stats.acquireCount++;
    
    // Try to find available connection
    let connection = await this.findAvailableConnection();
    
    if (connection) {
      return connection;
    }
    
    // Create new connection if under limit
    if (this.connections.length < this.config.maxConnections) {
      try {
        connection = await this.createConnection();
        connection.inUse = true;
        return connection;
      } catch (error) {
        logger.error('Failed to create new connection', error as Error);
        this.stats.errors++;
      }
    }
    
    // Wait for available connection
    return this.waitForConnection();
  }
  
  // Find available connection
  private async findAvailableConnection(): Promise<PooledConnection | null> {
    for (const conn of this.connections) {
      if (!conn.inUse) {
        // Validate connection if configured
        if (this.config.validateOnAcquire) {
          try {
            await conn.connection.get('SELECT 1');
          } catch (error) {
            logger.warn(`Connection ${conn.id} failed validation`, error as Error);
            await this.destroyConnection(conn);
            continue;
          }
        }
        
        conn.inUse = true;
        conn.lastUsed = Date.now();
        return conn;
      }
    }
    
    return null;
  }
  
  // Wait for connection to become available
  private waitForConnection(): Promise<PooledConnection> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        // Remove from wait queue
        const index = this.waitQueue.findIndex(w => w.timeout === timeout);
        if (index !== -1) {
          this.waitQueue.splice(index, 1);
        }
        
        this.stats.timeouts++;
        reject(new Error('Connection acquire timeout'));
      }, this.config.acquireTimeout);
      
      this.waitQueue.push({ resolve, reject, timeout });
    });
  }
  
  // Release connection back to pool
  release(connection: PooledConnection): void {
    const conn = this.connections.find(c => c.id === connection.id);
    
    if (!conn) {
      logger.warn('Attempted to release unknown connection', { id: connection.id });
      return;
    }
    
    conn.inUse = false;
    conn.lastUsed = Date.now();
    this.stats.releaseCount++;
    
    // Check wait queue
    if (this.waitQueue.length > 0) {
      const waiter = this.waitQueue.shift()!;
      clearTimeout(waiter.timeout);
      
      conn.inUse = true;
      waiter.resolve(conn);
    }
    
    this.emit('connectionReleased', conn.id);
  }
  
  // Destroy connection
  private async destroyConnection(connection: PooledConnection): Promise<void> {
    const index = this.connections.indexOf(connection);
    if (index !== -1) {
      this.connections.splice(index, 1);
    }
    
    try {
      await connection.connection.close();
    } catch (error) {
      logger.error(`Failed to close connection ${connection.id}`, error as Error);
    }
    
    this.stats.connectionsDestroyed++;
    this.emit('connectionDestroyed', connection.id);
  }
  
  // Start idle connection reaper
  private startReaper(): void {
    this.reapInterval = setInterval(async () => {
      const now = Date.now();
      const toDestroy: PooledConnection[] = [];
      
      // Find idle connections above minimum
      for (const conn of this.connections) {
        if (!conn.inUse && 
            this.connections.length > this.config.minConnections &&
            now - conn.lastUsed > this.config.idleTimeout) {
          toDestroy.push(conn);
        }
      }
      
      // Destroy idle connections
      for (const conn of toDestroy) {
        await this.destroyConnection(conn);
        logger.debug(`Reaped idle connection ${conn.id}`);
      }
      
      if (toDestroy.length > 0) {
        logger.info(`Reaped ${toDestroy.length} idle connections`);
      }
    }, this.config.reapInterval);
  }
  
  // Get pool statistics
  getStats(): {
    total: number;
    available: number;
    inUse: number;
    waitQueueLength: number;
    stats: typeof this.stats;
  } {
    const available = this.connections.filter(c => !c.inUse).length;
    const inUse = this.connections.filter(c => c.inUse).length;
    
    return {
      total: this.connections.length,
      available,
      inUse,
      waitQueueLength: this.waitQueue.length,
      stats: { ...this.stats }
    };
  }
  
  // Get connection details
  getConnectionDetails(): Array<{
    id: string;
    inUse: boolean;
    age: number;
    idleTime: number;
    queryCount: number;
  }> {
    const now = Date.now();
    
    return this.connections.map(conn => ({
      id: conn.id,
      inUse: conn.inUse,
      age: now - conn.created,
      idleTime: conn.inUse ? 0 : now - conn.lastUsed,
      queryCount: conn.queryCount
    }));
  }
  
  // Execute query with automatic connection management
  async execute<T>(
    operation: (conn: SQLiteDatabase<SQLiteDB>) => Promise<T>
  ): Promise<T> {
    const connection = await this.acquire();
    
    try {
      connection.queryCount++;
      const result = await operation(connection.connection);
      return result;
    } finally {
      this.release(connection);
    }
  }
  
  // Close pool
  async close(): Promise<void> {
    this.closed = true;
    
    // Stop reaper
    if (this.reapInterval) {
      clearInterval(this.reapInterval);
      this.reapInterval = null;
    }
    
    // Reject waiting requests
    for (const waiter of this.waitQueue) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error('Connection pool closing'));
    }
    this.waitQueue = [];
    
    // Close all connections
    await Promise.all(
      this.connections.map(conn => this.destroyConnection(conn))
    );
    
    logger.info('Connection pool closed', this.stats);
  }
}

// Connection pool with retry logic
export class ResilientConnectionPool extends ConnectionPool {
  private retryCount = 0;
  private maxRetries = 3;
  
  async acquire(): Promise<PooledConnection> {
    try {
      const connection = await super.acquire();
      this.retryCount = 0; // Reset on success
      return connection;
    } catch (error) {
      if (this.retryCount < this.maxRetries) {
        this.retryCount++;
        logger.warn(`Connection acquire failed, retrying (${this.retryCount}/${this.maxRetries})`);
        
        // Wait before retry
        await new Promise(resolve => 
          setTimeout(resolve, this.config.retryDelay * this.retryCount)
        );
        
        return this.acquire();
      }
      
      throw error;
    }
  }
}

// Query builder with connection pooling
export class PooledQueryBuilder {
  constructor(private pool: ConnectionPool) {}
  
  // Run query
  async run(sql: string, params?: any[]): Promise<any> {
    return this.pool.execute(async (conn) => {
      return conn.run(sql, params);
    });
  }
  
  // Get single result
  async get<T>(sql: string, params?: any[]): Promise<T | undefined> {
    return this.pool.execute(async (conn) => {
      return conn.get<T>(sql, params);
    });
  }
  
  // Get all results
  async all<T>(sql: string, params?: any[]): Promise<T[]> {
    return this.pool.execute(async (conn) => {
      return conn.all<T>(sql, params);
    });
  }
  
  // Execute transaction
  async transaction<T>(
    operations: (conn: SQLiteDatabase<SQLiteDB>) => Promise<T>
  ): Promise<T> {
    return this.pool.execute(async (conn) => {
      await conn.run('BEGIN TRANSACTION');
      
      try {
        const result = await operations(conn);
        await conn.run('COMMIT');
        return result;
      } catch (error) {
        await conn.run('ROLLBACK');
        throw error;
      }
    });
  }
}

// Export factory function
export function createConnectionPool(
  dbPath: string,
  config?: Partial<PoolConfig>
): ConnectionPool {
  return new ResilientConnectionPool(dbPath, {
    ...DEFAULT_POOL_CONFIG,
    ...config
  });
}
