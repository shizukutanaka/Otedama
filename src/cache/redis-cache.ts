/**
 * Redis cache implementation for performance optimization
 * Following principles: efficient, minimal overhead, fail-safe
 */

import Redis, { Redis as RedisClient } from 'ioredis';
import { EventEmitter } from 'events';
import { Logger } from '../logging/logger';

export interface CacheConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
  keyPrefix?: string;
  ttl?: number; // Default TTL in seconds
  maxRetriesPerRequest?: number;
  enableOfflineQueue?: boolean;
}

export interface CacheStats {
  hits: number;
  misses: number;
  errors: number;
  size: number;
  hitRate: number;
}

export class RedisCache extends EventEmitter {
  private client: RedisClient;
  private subscriber?: RedisClient;
  private logger: Logger;
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    errors: 0,
    size: 0,
    hitRate: 0
  };
  private connected = false;

  constructor(private config: CacheConfig) {
    super();
    this.logger = Logger.getInstance('RedisCache');

    const redisOptions: any = {
      host: config.host,
      port: config.port,
      db: config.db || 0,
      ...(this.config.password && { password: this.config.password }),
      keyPrefix: config.keyPrefix || 'pool:',
      maxRetriesPerRequest: config.maxRetriesPerRequest || 3,
      enableOfflineQueue: config.enableOfflineQueue !== false,
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 50, 2000);
        this.logger.warn(`Redis connection retry attempt ${times}, delay ${delay}ms`);
        return delay;
      }
    };

    if (config.password) {
      redisOptions.password = config.password;
    }

    this.client = new Redis(redisOptions);

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.client.on('connect', () => {
      this.connected = true;
      this.logger.info('Redis connected');
      this.emit('connected');
    });

    this.client.on('ready', () => {
      this.logger.info('Redis ready');
      this.emit('ready');
    });

    this.client.on('error', (error) => {
      this.logger.error('Redis error', error);
      this.emit('error', error);
    });

    this.client.on('close', () => {
      this.connected = false;
      this.logger.warn('Redis connection closed');
      this.emit('disconnected');
    });
  }

  public disconnect(): void {
    this.client.disconnect();
  }

  // Basic cache operations
  async get<T = any>(key: string): Promise<T | null> {
    try {
      const value = await this.client.get(key);
      
      if (value === null) {
        this.stats.misses++;
        this.updateHitRate();
        return null;
      }

      this.stats.hits++;
      this.updateHitRate();
      
      try {
        return JSON.parse(value) as T;
      } catch {
        // If not JSON, return as string
        return value as any;
      }
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Cache get error', error, { key });
      return null;
    }
  }

  async set(key: string, value: any, ttl?: number): Promise<boolean> {
    try {
      const serialized = typeof value === 'string' ? value : JSON.stringify(value);
      const expiry = ttl || this.config.ttl;

      if (expiry) {
        await this.client.setex(key, expiry, serialized);
      } else {
        await this.client.set(key, serialized);
      }

      return true;
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Cache set error', error, { key });
      return false;
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      const result = await this.client.del(key);
      return result > 0;
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Cache delete error', error, { key });
      return false;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const result = await this.client.exists(key);
      return result === 1;
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Cache exists error', error, { key });
      return false;
    }
  }

  async expire(key: string, seconds: number): Promise<boolean> {
    try {
      const result = await this.client.expire(key, seconds);
      return result === 1;
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Cache expire error', error, { key });
      return false;
    }
  }

  // Bulk operations
  async mget<T = any>(keys: string[]): Promise<(T | null)[]> {
    try {
      const values = await this.client.mget(...keys);
      return values.map(value => {
        if (value === null) return null;
        try {
          return JSON.parse(value) as T;
        } catch {
          return value as any;
        }
      });
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Cache mget error', error);
      return keys.map(() => null);
    }
  }

  async mset(items: Array<{ key: string; value: any; ttl?: number }>): Promise<boolean> {
    try {
      const pipeline = this.client.pipeline();
      
      for (const item of items) {
        const serialized = typeof item.value === 'string' ? 
          item.value : JSON.stringify(item.value);
        
        const expiry = item.ttl || this.config.ttl;
        if (expiry) {
          pipeline.setex(item.key, expiry, serialized);
        } else {
          pipeline.set(item.key, serialized);
        }
      }

      await pipeline.exec();
      return true;
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Cache mset error', error);
      return false;
    }
  }

  // Hash operations
  async hget<T = any>(key: string, field: string): Promise<T | null> {
    try {
      const value = await this.client.hget(key, field);
      if (value === null) return null;
      
      try {
        return JSON.parse(value) as T;
      } catch {
        return value as any;
      }
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Cache hget error', error, { key, field });
      return null;
    }
  }

  async hset(key: string, field: string, value: any): Promise<boolean> {
    try {
      const serialized = typeof value === 'string' ? value : JSON.stringify(value);
      await this.client.hset(key, field, serialized);
      return true;
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Cache hset error', error, { key, field });
      return false;
    }
  }

  async hgetall<T = any>(key: string): Promise<Record<string, T> | null> {
    try {
      const hash = await this.client.hgetall(key);
      if (Object.keys(hash).length === 0) return null;

      const result: Record<string, T> = {};
      for (const [field, value] of Object.entries(hash)) {
        try {
          result[field] = JSON.parse(value) as T;
        } catch {
          result[field] = value as any;
        }
      }
      
      return result;
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Cache hgetall error', error, { key });
      return null;
    }
  }

  // List operations
  async lpush(key: string, ...values: any[]): Promise<number> {
    try {
      const serialized = values.map(v => 
        typeof v === 'string' ? v : JSON.stringify(v)
      );
      return await this.client.lpush(key, ...serialized);
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Cache lpush error', error, { key });
      return 0;
    }
  }

  async lrange<T = any>(key: string, start: number, stop: number): Promise<T[]> {
    try {
      const values = await this.client.lrange(key, start, stop);
      return values.map(value => {
        try {
          return JSON.parse(value) as T;
        } catch {
          return value as any;
        }
      });
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Cache lrange error', error, { key });
      return [];
    }
  }

  // Set operations
  async sadd(key: string, ...members: any[]): Promise<number> {
    try {
      const serialized = members.map(m => 
        typeof m === 'string' ? m : JSON.stringify(m)
      );
      return await this.client.sadd(key, ...serialized);
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Cache sadd error', error, { key });
      return 0;
    }
  }

  async smembers<T = any>(key: string): Promise<T[]> {
    try {
      const members = await this.client.smembers(key);
      return members.map(member => {
        try {
          return JSON.parse(member) as T;
        } catch {
          return member as any;
        }
      });
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Cache smembers error', error, { key });
      return [];
    }
  }

  // Sorted set operations
  async zadd(key: string, ...scoreMembers: Array<[number, any]>): Promise<number> {
    try {
      const args: (string | number)[] = [];
      for (const [score, member] of scoreMembers) {
        args.push(score);
        args.push(typeof member === 'string' ? member : JSON.stringify(member));
      }
      return await this.client.zadd(key, ...args);
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Cache zadd error', error, { key });
      return 0;
    }
  }

  async zrange<T = any>(
    key: string, 
    start: number, 
    stop: number, 
    withScores = false
  ): Promise<T[] | Array<[T, number]>> {
    try {
      const args = withScores ? [key, start, stop, 'WITHSCORES'] : [key, start, stop];
      const result = await this.client.zrange(...args as [string, number, number]);
      
      if (!withScores) {
        return result.map(member => {
          try {
            return JSON.parse(member) as T;
          } catch {
            return member as any;
          }
        });
      }

      // With scores, results come in pairs
      const pairs: Array<[T, number]> = [];
      for (let i = 0; i < result.length; i += 2) {
        const member = result[i];
        const score = parseFloat(result[i + 1]);
        
        try {
          pairs.push([JSON.parse(member) as T, score]);
        } catch {
          pairs.push([member as any, score]);
        }
      }
      
      return pairs;
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Cache zrange error', error, { key });
      return [];
    }
  }

  // Pub/Sub
  async publish(channel: string, message: any): Promise<number> {
    try {
      const serialized = typeof message === 'string' ? 
        message : JSON.stringify(message);
      return await this.client.publish(channel, serialized);
    } catch (error) {
      this.logger.error('Cache publish error', error, { channel });
      return 0;
    }
  }

  async subscribe(
    channels: string[], 
    handler: (channel: string, message: any) => void
  ): Promise<void> {
    if (!this.subscriber) {
      this.subscriber = this.client.duplicate();
    }

    this.subscriber.on('message', (channel, message) => {
      try {
        const parsed = JSON.parse(message);
        handler(channel, parsed);
      } catch {
        handler(channel, message);
      }
    });

    await this.subscriber.subscribe(...channels);
  }

  // Cache patterns
  async getOrSet<T>(
    key: string, 
    factory: () => Promise<T>, 
    ttl?: number
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    const value = await factory();
    await this.set(key, value, ttl);
    return value;
  }

  async remember<T>(
    key: string,
    ttl: number,
    factory: () => Promise<T>
  ): Promise<T> {
    return this.getOrSet(key, factory, ttl);
  }

  // Utility methods
  async flush(): Promise<void> {
    try {
      await this.client.flushdb();
      this.logger.warn('Cache flushed');
    } catch (error) {
      this.logger.error('Cache flush error', error);
    }
  }

  async ping(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch (error) {
      return false;
    }
  }

  private updateHitRate(): void {
    const total = this.stats.hits + this.stats.misses;
    this.stats.hitRate = total > 0 ? this.stats.hits / total : 0;
  }

  getStats(): CacheStats {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = {
      hits: 0,
      misses: 0,
      errors: 0,
      size: 0,
      hitRate: 0
    };
  }

  async close(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.quit();
    }
    await this.client.quit();
    this.logger.info('Redis connection closed');
  }

  isConnected(): boolean {
    return this.connected;
  }
}

// In-memory fallback cache
export class MemoryCache extends EventEmitter {
  private cache = new Map<string, { value: any; expires?: number }>();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private defaultTTL?: number) {
    super();

  }

  async get<T = any>(key: string): Promise<T | null> {
    const item = this.cache.get(key);
    
    if (!item) {
      return null;
    }

    if (item.expires && item.expires < Date.now()) {
      this.delete(key);
      return null;
    }

    return item.value as T;
  }

  async set(key: string, value: any, ttl?: number): Promise<boolean> {
    // Clear existing timer
    const existingTimer = this.timers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.timers.delete(key);
    }

    const ttlMs = (ttl || this.defaultTTL) ? (ttl || this.defaultTTL!) * 1000 : undefined;
    const cacheEntry: { value: any; expires?: number } = { value };
    if (ttl) {
      cacheEntry.expires = Date.now() + ttl * 1000;
    }
    this.cache.set(key, cacheEntry);

    // Set expiration timer
    if (ttlMs) {
      const timer = setTimeout(() => {
        this.delete(key);
      }, ttlMs);
      this.timers.set(key, timer);
    }

    return true;
  }

  async delete(key: string): Promise<boolean> {
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }

    return this.cache.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    const item = this.cache.get(key);
    if (!item) return false;
    
    if (item.expires && item.expires < Date.now()) {
      this.delete(key);
      return false;
    }
    
    return true;
  }

  async flush(): Promise<void> {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.cache.clear();
  }

  async close(): Promise<void> {
    await this.flush();
  }

  getSize(): number {
    return this.cache.size;
  }
}

// Cache factory with fallback
export class CacheFactory {
  static async create(config: CacheConfig & { fallbackToMemory?: boolean }): Promise<RedisCache | MemoryCache> {
    if (config.fallbackToMemory) {
      const redis = new RedisCache(config);
      
      // Test connection
      try {
        await redis.ping();
        return redis;
      } catch {
        await redis.close();
        const memory = new MemoryCache(config.ttl);
        console.warn('Redis unavailable, falling back to memory cache');
        return memory;
      }
    }

    return new RedisCache(config);
  }
}
