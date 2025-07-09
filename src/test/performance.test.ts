// Performance tests for Otedama Pool
import { performance } from 'perf_hooks';
import { EnhancedMiningPoolCore } from '../core/enhanced-pool';
import { ParallelShareValidator } from '../performance/parallel-validation';
import { MemoryPool } from '../performance/memory-pool';
import { Share } from '../domain/share';
import { Miner } from '../domain/miner';
import * as os from 'os';

// Test helpers
class PerformanceMetrics {
  private startTime: number = 0;
  private endTime: number = 0;
  private measurements: Map<string, number[]> = new Map();
  
  start(): void {
    this.startTime = performance.now();
  }
  
  end(): void {
    this.endTime = performance.now();
  }
  
  measure(name: string, fn: () => void): void {
    const start = performance.now();
    fn();
    const duration = performance.now() - start;
    
    if (!this.measurements.has(name)) {
      this.measurements.set(name, []);
    }
    this.measurements.get(name)!.push(duration);
  }
  
  async measureAsync(name: string, fn: () => Promise<void>): Promise<void> {
    const start = performance.now();
    await fn();
    const duration = performance.now() - start;
    
    if (!this.measurements.has(name)) {
      this.measurements.set(name, []);
    }
    this.measurements.get(name)!.push(duration);
  }
  
  getStats(name: string): {
    count: number;
    min: number;
    max: number;
    avg: number;
    p50: number;
    p95: number;
    p99: number;
  } | null {
    const values = this.measurements.get(name);
    if (!values || values.length === 0) return null;
    
    const sorted = [...values].sort((a, b) => a - b);
    const count = sorted.length;
    
    return {
      count,
      min: sorted[0],
      max: sorted[count - 1],
      avg: values.reduce((a, b) => a + b, 0) / count,
      p50: sorted[Math.floor(count * 0.5)],
      p95: sorted[Math.floor(count * 0.95)],
      p99: sorted[Math.floor(count * 0.99)]
    };
  }
  
  report(): void {
    console.log('\n=== Performance Test Results ===\n');
    console.log(`Total Duration: ${(this.endTime - this.startTime).toFixed(2)}ms`);
    console.log(`CPU Cores: ${os.cpus().length}`);
    console.log(`Total Memory: ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(2)}GB`);
    console.log('\n');
    
    for (const [name, _] of this.measurements) {
      const stats = this.getStats(name);
      if (stats) {
        console.log(`${name}:`);
        console.log(`  Count: ${stats.count}`);
        console.log(`  Min: ${stats.min.toFixed(2)}ms`);
        console.log(`  Max: ${stats.max.toFixed(2)}ms`);
        console.log(`  Avg: ${stats.avg.toFixed(2)}ms`);
        console.log(`  P50: ${stats.p50.toFixed(2)}ms`);
        console.log(`  P95: ${stats.p95.toFixed(2)}ms`);
        console.log(`  P99: ${stats.p99.toFixed(2)}ms`);
        console.log(`  Throughput: ${(1000 / stats.avg).toFixed(2)} ops/sec`);
        console.log('');
      }
    }
  }
}

// Generate mock data
function generateMockShare(): Share {
  const share = new Share();
  share.minerId = `miner-${Math.random().toString(36).substr(2, 9)}`;
  share.jobId = `job-${Math.random().toString(36).substr(2, 9)}`;
  share.nonce = Math.floor(Math.random() * 0xffffffff);
  share.timestamp = Date.now();
  share.difficulty = Math.pow(2, Math.floor(Math.random() * 10) + 10);
  return share;
}

function generateMockMiner(): Miner {
  return {
    id: `miner-${Math.random().toString(36).substr(2, 9)}`,
    address: `1${Math.random().toString(36).substr(2, 33)}`,
    hashrate: Math.floor(Math.random() * 1e15), // Up to 1 PH/s
    shares: Math.floor(Math.random() * 1000),
    lastShare: Date.now() - Math.floor(Math.random() * 60000)
  };
}

// Performance tests
describe('Performance Tests', () => {
  const metrics = new PerformanceMetrics();
  
  beforeAll(() => {
    metrics.start();
  });
  
  afterAll(() => {
    metrics.end();
    metrics.report();
  });
  
  describe('Share Validation Performance', () => {
    let validator: ParallelShareValidator;
    const shares: Share[] = [];
    const shareCount = 100000;
    
    beforeAll(() => {
      validator = new ParallelShareValidator();
      
      // Generate test shares
      for (let i = 0; i < shareCount; i++) {
        shares.push(generateMockShare());
      }
    });
    
    test('Sequential validation baseline', async () => {
      const batchSize = 1000;
      
      for (let i = 0; i < shares.length; i += batchSize) {
        const batch = shares.slice(i, i + batchSize);
        
        await metrics.measureAsync('sequential-validation', async () => {
          for (const share of batch) {
            // Simulate validation work
            const hash = share.calculateHash();
            const isValid = share.difficulty > 0;
          }
        });
      }
    });
    
    test('Parallel validation (4 workers)', async () => {
      const batchSize = 1000;
      
      for (let i = 0; i < shares.length; i += batchSize) {
        const batch = shares.slice(i, i + batchSize);
        
        await metrics.measureAsync('parallel-validation-4', async () => {
          await validator.validateBatch(batch);
        });
      }
    });
    
    test('Parallel validation (8 workers)', async () => {
      validator.setWorkerCount(8);
      const batchSize = 1000;
      
      for (let i = 0; i < shares.length; i += batchSize) {
        const batch = shares.slice(i, i + batchSize);
        
        await metrics.measureAsync('parallel-validation-8', async () => {
          await validator.validateBatch(batch);
        });
      }
    });
  });
  
  describe('Memory Pool Performance', () => {
    let memoryPool: MemoryPool<Share>;
    const poolSize = 10000;
    
    beforeAll(() => {
      memoryPool = new MemoryPool(Share, poolSize);
    });
    
    test('Object allocation without pool', () => {
      const iterations = 100000;
      
      for (let i = 0; i < iterations; i++) {
        metrics.measure('allocation-without-pool', () => {
          const share = new Share();
          share.minerId = 'test';
          share.jobId = 'test';
          share.nonce = i;
          // Object becomes garbage
        });
      }
    });
    
    test('Object allocation with pool', () => {
      const iterations = 100000;
      
      for (let i = 0; i < iterations; i++) {
        metrics.measure('allocation-with-pool', () => {
          const share = memoryPool.acquire();
          share.minerId = 'test';
          share.jobId = 'test';
          share.nonce = i;
          memoryPool.release(share);
        });
      }
    });
  });
  
  describe('Database Performance', () => {
    let pool: EnhancedMiningPoolCore;
    const miners: Miner[] = [];
    const minerCount = 1000;
    
    beforeAll(async () => {
      // Create test pool with in-memory database
      pool = new EnhancedMiningPoolCore(
        '1TestPoolAddress',
        'http://localhost:8332',
        'test',
        'test',
        13333
      );
      
      // Generate test miners
      for (let i = 0; i < minerCount; i++) {
        miners.push(generateMockMiner());
      }
    });
    
    afterAll(async () => {
      await pool.stop();
    });
    
    test('Miner insertion performance', async () => {
      for (const miner of miners) {
        await metrics.measureAsync('db-insert-miner', async () => {
          await pool.getDatabase().saveMiner(miner);
        });
      }
    });
    
    test('Miner query performance', async () => {
      for (let i = 0; i < 1000; i++) {
        const randomMiner = miners[Math.floor(Math.random() * miners.length)];
        
        await metrics.measureAsync('db-query-miner', async () => {
          await pool.getDatabase().getMiner(randomMiner.id);
        });
      }
    });
    
    test('Bulk miner query performance', async () => {
      await metrics.measureAsync('db-query-all-miners', async () => {
        await pool.getDatabase().getActiveMiners(Date.now() - 3600000);
      });
    });
    
    test('Share insertion performance', async () => {
      const shares = Array.from({ length: 10000 }, generateMockShare);
      
      for (const share of shares) {
        await metrics.measureAsync('db-insert-share', async () => {
          await pool.getDatabase().saveShare(share);
        });
      }
    });
  });
  
  describe('Network Performance', () => {
    test('JSON serialization performance', () => {
      const data = {
        miners: Array.from({ length: 1000 }, generateMockMiner),
        shares: Array.from({ length: 1000 }, generateMockShare)
      };
      
      for (let i = 0; i < 100; i++) {
        metrics.measure('json-serialize', () => {
          JSON.stringify(data);
        });
      }
    });
    
    test('JSON deserialization performance', () => {
      const data = {
        miners: Array.from({ length: 1000 }, generateMockMiner),
        shares: Array.from({ length: 1000 }, generateMockShare)
      };
      const serialized = JSON.stringify(data);
      
      for (let i = 0; i < 100; i++) {
        metrics.measure('json-deserialize', () => {
          JSON.parse(serialized);
        });
      }
    });
    
    test('Binary protocol performance', () => {
      const share = generateMockShare();
      
      for (let i = 0; i < 10000; i++) {
        metrics.measure('binary-serialize', () => {
          // Simulate binary serialization
          const buffer = Buffer.allocUnsafe(64);
          buffer.write(share.minerId, 0, 16);
          buffer.write(share.jobId, 16, 16);
          buffer.writeUInt32LE(share.nonce, 32);
          buffer.writeBigUInt64LE(BigInt(share.timestamp), 36);
          buffer.writeDoubleLE(share.difficulty, 44);
        });
      }
    });
  });
  
  describe('Concurrent Connection Handling', () => {
    test('Connection creation overhead', async () => {
      const connectionCount = 10000;
      const connections: any[] = [];
      
      for (let i = 0; i < connectionCount; i++) {
        await metrics.measureAsync('connection-create', async () => {
          // Simulate connection creation
          const conn = {
            id: `conn-${i}`,
            created: Date.now(),
            lastActivity: Date.now(),
            buffer: Buffer.allocUnsafe(4096)
          };
          connections.push(conn);
        });
      }
      
      // Cleanup
      connections.length = 0;
    });
  });
  
  describe('Hashrate Calculation Performance', () => {
    test('Moving average calculation', () => {
      const windowSize = 300; // 5 minutes
      const samples: number[] = [];
      
      // Fill initial window
      for (let i = 0; i < windowSize; i++) {
        samples.push(Math.random() * 1e15);
      }
      
      for (let i = 0; i < 10000; i++) {
        metrics.measure('hashrate-moving-avg', () => {
          // Add new sample
          samples.push(Math.random() * 1e15);
          samples.shift();
          
          // Calculate average
          const sum = samples.reduce((a, b) => a + b, 0);
          const avg = sum / samples.length;
        });
      }
    });
  });
  
  describe('Payment Calculation Performance', () => {
    test('PPLNS share calculation', async () => {
      const shares = Array.from({ length: 10000 }, generateMockShare);
      const blockReward = 6.25;
      
      await metrics.measureAsync('pplns-calculation', async () => {
        // Calculate total difficulty
        const totalDifficulty = shares.reduce((sum, s) => sum + s.difficulty, 0);
        
        // Calculate rewards per miner
        const rewards = new Map<string, number>();
        
        for (const share of shares) {
          const minerReward = (share.difficulty / totalDifficulty) * blockReward;
          const current = rewards.get(share.minerId) || 0;
          rewards.set(share.minerId, current + minerReward);
        }
      });
    });
  });
});

// Stress test for finding system limits
describe('Stress Tests', () => {
  test.skip('Maximum concurrent connections', async () => {
    let connections = 0;
    const maxConnections: any[] = [];
    
    try {
      while (true) {
        // Simulate connection
        maxConnections.push({
          id: connections++,
          socket: { fd: connections }
        });
        
        if (connections % 1000 === 0) {
          console.log(`Created ${connections} connections`);
        }
      }
    } catch (error) {
      console.log(`Maximum connections reached: ${connections}`);
    }
  });
  
  test.skip('Maximum shares per second', async () => {
    const startTime = Date.now();
    let shareCount = 0;
    const duration = 10000; // 10 seconds
    
    while (Date.now() - startTime < duration) {
      const share = generateMockShare();
      // Minimal processing
      shareCount++;
    }
    
    const sharesPerSecond = shareCount / (duration / 1000);
    console.log(`Maximum shares per second: ${sharesPerSecond.toFixed(0)}`);
  });
});
