// Redis cache performance tests
// Testing cache operations critical for mining pool performance

import { perfTest } from './performance-test-framework';
import * as crypto from 'crypto';

/**
 * Mock Redis client for testing
 */
class MockRedisClient {
  private store: Map<string, any> = new Map();
  private expiry: Map<string, number> = new Map();
  
  async get(key: string): Promise<string | null> {
    this.checkExpiry(key);
    return this.store.get(key) || null;
  }
  
  async set(key: string, value: string, options?: { EX?: number }): Promise<void> {
    this.store.set(key, value);
    if (options?.EX) {
      this.expiry.set(key, Date.now() + options.EX * 1000);
    }
  }
  
  async del(key: string | string[]): Promise<number> {
    const keys = Array.isArray(key) ? key : [key];
    let deleted = 0;
    
    for (const k of keys) {
      if (this.store.delete(k)) {
        deleted++;
        this.expiry.delete(k);
      }
    }
    
    return deleted;
  }
  
  async mget(keys: string[]): Promise<(string | null)[]> {
    return keys.map(key => {
      this.checkExpiry(key);
      return this.store.get(key) || null;
    });
  }
  
  async mset(pairs: [string, string][]): Promise<void> {
    for (const [key, value] of pairs) {
      this.store.set(key, value);
    }
  }
  
  async exists(key: string): Promise<number> {
    this.checkExpiry(key);
    return this.store.has(key) ? 1 : 0;
  }
  
  async expire(key: string, seconds: number): Promise<number> {
    if (this.store.has(key)) {
      this.expiry.set(key, Date.now() + seconds * 1000);
      return 1;
    }
    return 0;
  }
  
  async hget(key: string, field: string): Promise<string | null> {
    this.checkExpiry(key);
    const hash = this.store.get(key);
    return hash?.[field] || null;
  }
  
  async hset(key: string, field: string, value: string): Promise<number> {
    let hash = this.store.get(key);
    const isNew = !hash || !hash[field];
    
    if (!hash) {
      hash = {};
      this.store.set(key, hash);
    }
    
    hash[field] = value;
    return isNew ? 1 : 0;
  }
  
  async hgetall(key: string): Promise<Record<string, string> | null> {
    this.checkExpiry(key);
    return this.store.get(key) || null;
  }
  
  async incr(key: string): Promise<number> {
    const value = parseInt(this.store.get(key) || '0', 10);
    const newValue = value + 1;
    this.store.set(key, newValue.toString());
    return newValue;
  }
  
  async zadd(key: string, score: number, member: string): Promise<number> {
    let sortedSet = this.store.get(key);
    if (!sortedSet) {
      sortedSet = new Map();
      this.store.set(key, sortedSet);
    }
    
    const isNew = !sortedSet.has(member);
    sortedSet.set(member, score);
    return isNew ? 1 : 0;
  }
  
  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    const sortedSet = this.store.get(key);
    if (!sortedSet) return [];
    
    const sorted = Array.from(sortedSet.entries())
      .sort((a, b) => a[1] - b[1])
      .map(([member]) => member);
    
    const end = stop === -1 ? sorted.length : stop + 1;
    return sorted.slice(start, end);
  }
  
  private checkExpiry(key: string): void {
    const expiryTime = this.expiry.get(key);
    if (expiryTime && Date.now() > expiryTime) {
      this.store.delete(key);
      this.expiry.delete(key);
    }
  }
  
  async flushall(): Promise<void> {
    this.store.clear();
    this.expiry.clear();
  }
}

/**
 * Cache layer for mining pool operations
 */
class MiningPoolCache {
  constructor(private redis: MockRedisClient) {}
  
  // Miner stats caching
  async getMinerStats(minerId: string): Promise<any | null> {
    const key = `miner:stats:${minerId}`;
    const data = await this.redis.get(key);
    return data ? JSON.parse(data) : null;
  }
  
  async setMinerStats(minerId: string, stats: any): Promise<void> {
    const key = `miner:stats:${minerId}`;
    await this.redis.set(key, JSON.stringify(stats), { EX: 300 }); // 5 min cache
  }
  
  // Share caching
  async cacheShare(share: any): Promise<void> {
    const key = `share:${share.id}`;
    await this.redis.set(key, JSON.stringify(share), { EX: 3600 }); // 1 hour
  }
  
  // Job caching
  async getJob(jobId: string): Promise<any | null> {
    const key = `job:${jobId}`;
    const data = await this.redis.get(key);
    return data ? JSON.parse(data) : null;
  }
  
  async setJob(jobId: string, job: any): Promise<void> {
    const key = `job:${jobId}`;
    await this.redis.set(key, JSON.stringify(job), { EX: 600 }); // 10 min
  }
  
  // Difficulty caching
  async getMinerDifficulty(minerId: string): Promise<number | null> {
    const key = `miner:difficulty:${minerId}`;
    const diff = await this.redis.get(key);
    return diff ? parseFloat(diff) : null;
  }
  
  async setMinerDifficulty(minerId: string, difficulty: number): Promise<void> {
    const key = `miner:difficulty:${minerId}`;
    await this.redis.set(key, difficulty.toString());
  }
  
  // Recent shares for duplicate detection
  async addRecentShare(shareId: string): Promise<boolean> {
    const key = 'recent:shares';
    const score = Date.now();
    const result = await this.redis.zadd(key, score, shareId);
    
    // Cleanup old entries (older than 1 hour)
    // In real implementation, this would be done periodically
    
    return result === 1; // true if new share
  }
  
  // Pool stats caching
  async getPoolStats(): Promise<any | null> {
    const data = await this.redis.get('pool:stats');
    return data ? JSON.parse(data) : null;
  }
  
  async setPoolStats(stats: any): Promise<void> {
    await this.redis.set('pool:stats', JSON.stringify(stats), { EX: 60 }); // 1 min
  }
}

/**
 * Redis cache performance tests
 */
export class RedisCachePerformance {
  private redis: MockRedisClient;
  private cache: MiningPoolCache;
  private testData: {
    minerIds: string[];
    jobIds: string[];
    shareIds: string[];
    minerStats: any[];
    jobs: any[];
  };
  
  constructor() {
    this.redis = new MockRedisClient();
    this.cache = new MiningPoolCache(this.redis);
    this.testData = this.generateTestData();
  }
  
  /**
   * Generate test data
   */
  private generateTestData() {
    const minerIds = Array.from({ length: 1000 }, (_, i) => `miner-${i}`);
    const jobIds = Array.from({ length: 100 }, (_, i) => `job-${i}`);
    const shareIds = Array.from({ length: 10000 }, (_, i) => 
      crypto.randomBytes(16).toString('hex')
    );
    
    const minerStats = minerIds.map(id => ({
      minerId: id,
      hashrate: Math.random() * 1e12,
      validShares: Math.floor(Math.random() * 1000),
      invalidShares: Math.floor(Math.random() * 10),
      lastShare: Date.now() - Math.random() * 300000
    }));
    
    const jobs = jobIds.map(id => ({
      id,
      height: 700000 + Math.floor(Math.random() * 1000),
      previousBlockHash: crypto.randomBytes(32).toString('hex'),
      merkleRoot: crypto.randomBytes(32).toString('hex'),
      timestamp: Date.now()
    }));
    
    return { minerIds, jobIds, shareIds, minerStats, jobs };
  }
  
  /**
   * Test single key operations
   */
  async testSingleKeyOperations(): Promise<void> {
    let index = 0;
    
    // Set operation
    await perfTest.run(async () => {
      const minerId = this.testData.minerIds[index % this.testData.minerIds.length];
      const stats = this.testData.minerStats[index % this.testData.minerStats.length];
      index++;
      
      await this.cache.setMinerStats(minerId, stats);
    }, {
      name: 'Cache SET (miner stats)',
      iterations: 10000,
      warmupIterations: 100,
      async: true
    });
    
    // Get operation
    index = 0;
    await perfTest.run(async () => {
      const minerId = this.testData.minerIds[index % this.testData.minerIds.length];
      index++;
      
      await this.cache.getMinerStats(minerId);
    }, {
      name: 'Cache GET (miner stats)',
      iterations: 10000,
      warmupIterations: 100,
      async: true
    });
  }
  
  /**
   * Test batch operations
   */
  async testBatchOperations(): Promise<void> {
    // Pre-populate cache
    for (let i = 0; i < 100; i++) {
      const minerId = this.testData.minerIds[i];
      const stats = this.testData.minerStats[i];
      await this.cache.setMinerStats(minerId, stats);
    }
    
    await perfTest.run(async () => {
      // Batch get 10 miners
      const keys = [];
      for (let i = 0; i < 10; i++) {
        keys.push(`miner:stats:${this.testData.minerIds[i]}`);
      }
      
      await this.redis.mget(keys);
    }, {
      name: 'Batch GET (10 keys)',
      iterations: 1000,
      warmupIterations: 100,
      async: true
    });
  }
  
  /**
   * Test share duplicate detection
   */
  async testShareDuplicateDetection(): Promise<void> {
    let shareIndex = 0;
    
    await perfTest.run(async () => {
      const shareId = this.testData.shareIds[shareIndex % this.testData.shareIds.length];
      shareIndex++;
      
      await this.cache.addRecentShare(shareId);
    }, {
      name: 'Share Duplicate Detection',
      iterations: 10000,
      warmupIterations: 100,
      async: true
    });
  }
  
  /**
   * Test job caching
   */
  async testJobCaching(): Promise<void> {
    let jobIndex = 0;
    
    // Set jobs
    await perfTest.run(async () => {
      const job = this.testData.jobs[jobIndex % this.testData.jobs.length];
      jobIndex++;
      
      await this.cache.setJob(job.id, job);
    }, {
      name: 'Job Cache SET',
      iterations: 1000,
      warmupIterations: 100,
      async: true
    });
    
    // Get jobs
    jobIndex = 0;
    await perfTest.run(async () => {
      const jobId = this.testData.jobIds[jobIndex % this.testData.jobIds.length];
      jobIndex++;
      
      await this.cache.getJob(jobId);
    }, {
      name: 'Job Cache GET',
      iterations: 10000,
      warmupIterations: 100,
      async: true
    });
  }
  
  /**
   * Test cache expiry handling
   */
  async testCacheExpiry(): Promise<void> {
    // Set items with short expiry
    for (let i = 0; i < 1000; i++) {
      await this.redis.set(`expire:test:${i}`, 'value', { EX: 1 });
    }
    
    // Test immediate access (should hit)
    let hits = 0;
    await perfTest.run(async () => {
      const key = `expire:test:${Math.floor(Math.random() * 1000)}`;
      const value = await this.redis.get(key);
      if (value) hits++;
    }, {
      name: 'Cache Access (pre-expiry)',
      iterations: 1000,
      warmupIterations: 100,
      async: true
    });
    
    console.log(`Cache hit rate (pre-expiry): ${(hits / 1000 * 100).toFixed(2)}%`);
  }
  
  /**
   * Compare caching strategies
   */
  async compareCachingStrategies(): Promise<void> {
    // Strategy A: Individual cache calls
    const individualStrategy = async () => {
      const minerIds = this.testData.minerIds.slice(0, 10);
      const results = [];
      
      for (const minerId of minerIds) {
        const stats = await this.cache.getMinerStats(minerId);
        results.push(stats);
      }
      
      return results;
    };
    
    // Strategy B: Batch cache calls
    const batchStrategy = async () => {
      const minerIds = this.testData.minerIds.slice(0, 10);
      const keys = minerIds.map(id => `miner:stats:${id}`);
      
      const values = await this.redis.mget(keys);
      return values.map(v => v ? JSON.parse(v) : null);
    };
    
    // Pre-populate cache
    for (let i = 0; i < 10; i++) {
      await this.cache.setMinerStats(
        this.testData.minerIds[i],
        this.testData.minerStats[i]
      );
    }
    
    const result = await perfTest.compare(
      'Caching Strategies',
      individualStrategy,
      batchStrategy,
      {
        iterations: 1000,
        warmupIterations: 100,
        async: true
      }
    );
    
    console.log(`\nCaching strategy comparison: ${result.comparison.winner} is ${result.comparison.speedup.toFixed(2)}x faster`);
  }
  
  /**
   * Test pool stats caching
   */
  async testPoolStatsCaching(): Promise<void> {
    const poolStats = {
      hashrate: 1.5e15,
      miners: 1234,
      workers: 3456,
      difficulty: 2.5e13,
      height: 700123,
      lastBlock: Date.now() - 300000,
      totalShares: 1234567890,
      validShares: 1234000000
    };
    
    await perfTest.run(async () => {
      await this.cache.setPoolStats(poolStats);
    }, {
      name: 'Pool Stats SET',
      iterations: 1000,
      warmupIterations: 100,
      async: true
    });
    
    await perfTest.run(async () => {
      await this.cache.getPoolStats();
    }, {
      name: 'Pool Stats GET',
      iterations: 10000,
      warmupIterations: 100,
      async: true
    });
  }
  
  /**
   * Test memory usage patterns
   */
  async testMemoryUsage(): Promise<void> {
    const initialMemory = process.memoryUsage().heapUsed;
    
    // Add 10k entries
    for (let i = 0; i < 10000; i++) {
      await this.redis.set(
        `memory:test:${i}`,
        JSON.stringify({
          data: crypto.randomBytes(100).toString('hex'),
          timestamp: Date.now()
        }),
        { EX: 300 }
      );
    }
    
    const afterAddMemory = process.memoryUsage().heapUsed;
    
    // Clear cache
    await this.redis.flushall();
    
    if (global.gc) {
      global.gc();
    }
    
    const afterClearMemory = process.memoryUsage().heapUsed;
    
    console.log('\nMemory Usage:');
    console.log(`  Initial: ${(initialMemory / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  After 10k entries: ${(afterAddMemory / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  After clear: ${(afterClearMemory / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Memory per entry: ${((afterAddMemory - initialMemory) / 10000 / 1024).toFixed(2)} KB`);
  }
  
  /**
   * Run all Redis cache performance tests
   */
  async runAll(): Promise<void> {
    await perfTest.suite('Redis Cache Performance', [
      { name: 'Single Key Ops', fn: () => this.testSingleKeyOperations() },
      { name: 'Batch Ops', fn: () => this.testBatchOperations() },
      { name: 'Share Dedup', fn: () => this.testShareDuplicateDetection() },
      { name: 'Job Caching', fn: () => this.testJobCaching() },
      { name: 'Cache Expiry', fn: () => this.testCacheExpiry() },
      { name: 'Strategy Comparison', fn: () => this.compareCachingStrategies() },
      { name: 'Pool Stats', fn: () => this.testPoolStatsCaching() },
      { name: 'Memory Usage', fn: () => this.testMemoryUsage() }
    ]);
  }
}

// Run tests if executed directly
if (require.main === module) {
  const test = new RedisCachePerformance();
  test.runAll().catch(console.error);
}
