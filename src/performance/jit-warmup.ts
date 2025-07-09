// JIT warmup for startup optimization (Carmack style - measure and optimize)
import { createComponentLogger } from '../logging/logger';
import { Share } from '../domain/share';
import { ShareValidator } from '../core/validator';

const logger = createComponentLogger('jit-warmup');

// V8 optimization hints
declare global {
  const v8debug: any;
}

// JIT warmup manager
export class JITWarmup {
  private static warmedUp = false;
  
  // Warm up critical functions
  static async warmup(): Promise<void> {
    if (this.warmedUp) {
      return;
    }
    
    const startTime = Date.now();
    logger.info('Starting JIT warmup...');
    
    try {
      // Warm up share validation
      await this.warmupShareValidation();
      
      // Warm up hash calculations
      await this.warmupHashCalculations();
      
      // Warm up JSON parsing
      await this.warmupJSONParsing();
      
      // Warm up buffer operations
      await this.warmupBufferOperations();
      
      // Warm up async operations
      await this.warmupAsyncOperations();
      
      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }
      
      this.warmedUp = true;
      const duration = Date.now() - startTime;
      logger.info(`JIT warmup completed in ${duration}ms`);
    } catch (error) {
      logger.error('JIT warmup failed', error as Error);
    }
  }
  
  // Warm up share validation functions
  private static async warmupShareValidation(): Promise<void> {
    const validator = new ShareValidator();
    const iterations = 10000;
    
    // Create test shares
    const shares: Share[] = [];
    for (let i = 0; i < 100; i++) {
      const share = new Share();
      share.minerId = `test_${i}`;
      share.jobId = `job_${i}`;
      share.nonce = i;
      share.difficulty = 1000 + i;
      share.data = Buffer.alloc(80);
      shares.push(share);
    }
    
    // Run validation multiple times to trigger optimization
    for (let i = 0; i < iterations; i++) {
      const share = shares[i % shares.length];
      validator.isValid(share);
      
      // Yield occasionally
      if (i % 1000 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }
    
    logger.debug(`Warmed up share validation (${iterations} iterations)`);
  }
  
  // Warm up hash calculations
  private static async warmupHashCalculations(): Promise<void> {
    const crypto = await import('crypto');
    const iterations = 5000;
    
    // Different data sizes
    const dataSizes = [32, 64, 128, 256, 512, 1024];
    const buffers = dataSizes.map(size => Buffer.allocUnsafe(size));
    
    for (let i = 0; i < iterations; i++) {
      const buffer = buffers[i % buffers.length];
      
      // SHA256 (most common in mining)
      crypto.createHash('sha256').update(buffer).digest();
      
      // Double SHA256
      const hash1 = crypto.createHash('sha256').update(buffer).digest();
      crypto.createHash('sha256').update(hash1).digest();
      
      // HMAC
      crypto.createHmac('sha256', 'key').update(buffer).digest();
      
      if (i % 1000 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }
    
    logger.debug(`Warmed up hash calculations (${iterations} iterations)`);
  }
  
  // Warm up JSON parsing
  private static async warmupJSONParsing(): Promise<void> {
    const iterations = 10000;
    
    // Common JSON patterns in mining
    const testObjects = [
      { id: 1, method: 'mining.notify', params: [] },
      { id: 2, result: true, error: null },
      { id: 3, method: 'mining.submit', params: ['worker', 'job', 'nonce'] },
      { 
        shares: 12345, 
        hashrate: 1000000000, 
        difficulty: 65536,
        timestamp: Date.now() 
      }
    ];
    
    const testStrings = testObjects.map(obj => JSON.stringify(obj));
    
    for (let i = 0; i < iterations; i++) {
      const str = testStrings[i % testStrings.length];
      const obj = JSON.parse(str);
      JSON.stringify(obj);
      
      if (i % 1000 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }
    
    logger.debug(`Warmed up JSON parsing (${iterations} iterations)`);
  }
  
  // Warm up buffer operations
  private static async warmupBufferOperations(): Promise<void> {
    const iterations = 5000;
    const sizes = [80, 256, 1024, 4096];
    
    for (let i = 0; i < iterations; i++) {
      const size = sizes[i % sizes.length];
      
      // Allocation
      const buf1 = Buffer.allocUnsafe(size);
      const buf2 = Buffer.alloc(size);
      
      // Writing
      buf1.writeUInt32LE(0x12345678, 0);
      buf1.writeUInt32BE(0x87654321, 4);
      
      // Reading
      buf1.readUInt32LE(0);
      buf1.readUInt32BE(4);
      
      // Copying
      buf1.copy(buf2);
      
      // Slicing
      buf1.slice(0, size / 2);
      
      // Comparing
      Buffer.compare(buf1, buf2);
      
      if (i % 1000 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }
    
    logger.debug(`Warmed up buffer operations (${iterations} iterations)`);
  }
  
  // Warm up async operations
  private static async warmupAsyncOperations(): Promise<void> {
    const iterations = 1000;
    
    // Promise creation and resolution
    for (let i = 0; i < iterations; i++) {
      await Promise.resolve(i);
      await new Promise(resolve => setImmediate(() => resolve(i)));
      
      // Promise.all
      await Promise.all([
        Promise.resolve(1),
        Promise.resolve(2),
        Promise.resolve(3)
      ]);
      
      // Promise.race
      await Promise.race([
        new Promise(resolve => setTimeout(() => resolve(1), 0)),
        new Promise(resolve => setTimeout(() => resolve(2), 1))
      ]);
    }
    
    logger.debug(`Warmed up async operations (${iterations} iterations)`);
  }
  
  // Get V8 optimization status for a function
  static getOptimizationStatus(fn: Function): string {
    if (typeof v8debug === 'undefined') {
      return 'unknown';
    }
    
    try {
      const status = v8debug.getOptimizationStatus(fn);
      
      // Status codes from V8
      const statusMap: { [key: number]: string } = {
        1: 'optimized',
        2: 'not optimized',
        3: 'always optimized',
        4: 'never optimized',
        6: 'maybe deoptimized',
        7: 'turbofan optimized'
      };
      
      return statusMap[status] || 'unknown';
    } catch {
      return 'unknown';
    }
  }
  
  // Prepare function for optimization
  static prepareForOptimization(fn: Function): void {
    if (typeof v8debug === 'undefined') {
      return;
    }
    
    try {
      v8debug.prepareForOptimization(fn);
    } catch {
      // Ignore if not available
    }
  }
  
  // Optimize function now
  static optimizeFunctionOnNextCall(fn: Function): void {
    if (typeof v8debug === 'undefined') {
      return;
    }
    
    try {
      v8debug.optimizeFunctionOnNextCall(fn);
    } catch {
      // Ignore if not available
    }
  }
}

// Critical path optimizer
export class CriticalPathOptimizer {
  private static measurements = new Map<string, {
    count: number;
    totalTime: number;
    minTime: number;
    maxTime: number;
  }>();
  
  // Measure function execution time
  static measure<T>(name: string, fn: () => T): T {
    const start = process.hrtime.bigint();
    
    try {
      return fn();
    } finally {
      const end = process.hrtime.bigint();
      const duration = Number(end - start) / 1000000; // Convert to milliseconds
      
      this.recordMeasurement(name, duration);
    }
  }
  
  // Measure async function execution time
  static async measureAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = process.hrtime.bigint();
    
    try {
      return await fn();
    } finally {
      const end = process.hrtime.bigint();
      const duration = Number(end - start) / 1000000; // Convert to milliseconds
      
      this.recordMeasurement(name, duration);
    }
  }
  
  // Record measurement
  private static recordMeasurement(name: string, duration: number): void {
    const existing = this.measurements.get(name);
    
    if (existing) {
      existing.count++;
      existing.totalTime += duration;
      existing.minTime = Math.min(existing.minTime, duration);
      existing.maxTime = Math.max(existing.maxTime, duration);
    } else {
      this.measurements.set(name, {
        count: 1,
        totalTime: duration,
        minTime: duration,
        maxTime: duration
      });
    }
  }
  
  // Get performance report
  static getReport(): Array<{
    name: string;
    count: number;
    avgTime: number;
    minTime: number;
    maxTime: number;
    totalTime: number;
  }> {
    const report = [];
    
    for (const [name, stats] of this.measurements) {
      report.push({
        name,
        count: stats.count,
        avgTime: stats.totalTime / stats.count,
        minTime: stats.minTime,
        maxTime: stats.maxTime,
        totalTime: stats.totalTime
      });
    }
    
    // Sort by total time (most expensive first)
    return report.sort((a, b) => b.totalTime - a.totalTime);
  }
  
  // Clear measurements
  static clear(): void {
    this.measurements.clear();
  }
}

// Startup sequence optimizer
export class StartupOptimizer {
  private static tasks: Array<{
    name: string;
    priority: number;
    fn: () => Promise<void>;
  }> = [];
  
  // Register startup task
  static register(
    name: string,
    priority: number,
    fn: () => Promise<void>
  ): void {
    this.tasks.push({ name, priority, fn });
  }
  
  // Execute startup sequence
  static async execute(): Promise<void> {
    const startTime = Date.now();
    logger.info('Starting optimized startup sequence...');
    
    // Sort by priority (higher first)
    const sortedTasks = [...this.tasks].sort((a, b) => b.priority - a.priority);
    
    // Group by priority for parallel execution
    const priorityGroups = new Map<number, typeof sortedTasks>();
    
    for (const task of sortedTasks) {
      if (!priorityGroups.has(task.priority)) {
        priorityGroups.set(task.priority, []);
      }
      priorityGroups.get(task.priority)!.push(task);
    }
    
    // Execute groups in order
    for (const [priority, tasks] of priorityGroups) {
      logger.debug(`Executing priority ${priority} tasks...`);
      
      // Execute tasks in parallel within same priority
      await Promise.all(
        tasks.map(async task => {
          const taskStart = Date.now();
          try {
            await task.fn();
            const duration = Date.now() - taskStart;
            logger.debug(`Task '${task.name}' completed in ${duration}ms`);
          } catch (error) {
            logger.error(`Task '${task.name}' failed`, error as Error);
            throw error;
          }
        })
      );
    }
    
    const totalDuration = Date.now() - startTime;
    logger.info(`Startup sequence completed in ${totalDuration}ms`);
  }
  
  // Clear registered tasks
  static clear(): void {
    this.tasks = [];
  }
}

// Memory pre-allocation
export class MemoryPreallocator {
  // Pre-allocate commonly used buffers
  static preallocateBuffers(): void {
    const sizes = [80, 256, 512, 1024, 4096, 16384];
    const pools = new Map<number, Buffer[]>();
    
    for (const size of sizes) {
      const pool: Buffer[] = [];
      for (let i = 0; i < 10; i++) {
        pool.push(Buffer.allocUnsafe(size));
      }
      pools.set(size, pool);
    }
    
    logger.debug(`Pre-allocated ${sizes.length * 10} buffers`);
  }
  
  // Pre-allocate objects
  static preallocateObjects(): void {
    // Pre-allocate shares
    const shares: any[] = [];
    for (let i = 0; i < 1000; i++) {
      shares.push({
        minerId: '',
        jobId: '',
        nonce: 0,
        difficulty: 0,
        timestamp: 0,
        data: null
      });
    }
    
    // Pre-allocate miner objects
    const miners: any[] = [];
    for (let i = 0; i < 100; i++) {
      miners.push({
        id: '',
        address: '',
        shares: 0,
        hashrate: 0,
        lastShareTime: 0
      });
    }
    
    logger.debug('Pre-allocated objects for pooling');
  }
}
