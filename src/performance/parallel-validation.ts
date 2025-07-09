// Parallel share validation using worker threads (Carmack performance optimization)
import { Worker } from 'worker_threads';
import * as os from 'os';
import { Share } from '../domain/share';
import { ShareValidator } from '../core/validator';
import { createComponentLogger } from '../logging/logger';
import { Channel } from '../network/channels';

const logger = createComponentLogger('parallel-validator');

// Worker pool for share validation
export class ParallelShareValidator {
  private workers: Worker[] = [];
  private workerPool: WorkerPool;
  private pendingValidations = new Map<string, {
    resolve: (result: boolean) => void;
    reject: (error: Error) => void;
    timestamp: number;
  }>();
  
  constructor(
    private validator: ShareValidator,
    private config: {
      workerCount?: number;
      maxQueueSize?: number;
      validationTimeout?: number;
    } = {}
  ) {
    const workerCount = config.workerCount || Math.max(1, os.cpus().length - 1);
    this.workerPool = new WorkerPool(workerCount, config.maxQueueSize || 10000);
    
    logger.info(`Initialized parallel validator with ${workerCount} workers`);
  }
  
  // Validate share in parallel
  async validateShare(share: Share): Promise<boolean> {
    // For simple shares, validate inline (faster than worker overhead)
    if (share.difficulty < 1000) {
      return this.validator.isValid(share);
    }
    
    // Use worker pool for complex validations
    const validationId = this.generateValidationId();
    
    return new Promise<boolean>((resolve, reject) => {
      // Store promise handlers
      this.pendingValidations.set(validationId, {
        resolve,
        reject,
        timestamp: Date.now()
      });
      
      // Set timeout
      const timeout = this.config.validationTimeout || 5000;
      setTimeout(() => {
        const pending = this.pendingValidations.get(validationId);
        if (pending) {
          this.pendingValidations.delete(validationId);
          reject(new Error('Validation timeout'));
        }
      }, timeout);
      
      // Submit to worker pool
      this.workerPool.submit({
        id: validationId,
        share: share.toJSON()
      });
    });
  }
  
  // Batch validate shares
  async validateBatch(shares: Share[]): Promise<boolean[]> {
    // Split into chunks for parallel processing
    const chunkSize = Math.ceil(shares.length / this.workerPool.size);
    const chunks: Share[][] = [];
    
    for (let i = 0; i < shares.length; i += chunkSize) {
      chunks.push(shares.slice(i, i + chunkSize));
    }
    
    // Process chunks in parallel
    const results = await Promise.all(
      chunks.map(chunk => this.validateChunk(chunk))
    );
    
    // Flatten results
    return results.flat();
  }
  
  private async validateChunk(shares: Share[]): Promise<boolean[]> {
    const results: boolean[] = [];
    
    for (const share of shares) {
      try {
        const isValid = await this.validateShare(share);
        results.push(isValid);
      } catch (error) {
        logger.error('Share validation error', error as Error);
        results.push(false);
      }
    }
    
    return results;
  }
  
  // Handle worker result
  private handleWorkerResult(result: { id: string; valid: boolean; error?: string }): void {
    const pending = this.pendingValidations.get(result.id);
    if (!pending) {
      return; // Already timed out
    }
    
    this.pendingValidations.delete(result.id);
    
    if (result.error) {
      pending.reject(new Error(result.error));
    } else {
      pending.resolve(result.valid);
    }
  }
  
  // Get statistics
  getStats(): {
    activeWorkers: number;
    pendingValidations: number;
    queueSize: number;
    avgValidationTime: number;
  } {
    return {
      activeWorkers: this.workerPool.activeWorkers,
      pendingValidations: this.pendingValidations.size,
      queueSize: this.workerPool.queueSize,
      avgValidationTime: this.calculateAvgValidationTime()
    };
  }
  
  private calculateAvgValidationTime(): number {
    // In production, would track actual validation times
    return 10; // ms
  }
  
  // Shutdown
  async shutdown(): Promise<void> {
    await this.workerPool.shutdown();
    
    // Reject pending validations
    for (const [id, pending] of this.pendingValidations) {
      pending.reject(new Error('Validator shutting down'));
    }
    this.pendingValidations.clear();
  }
  
  private generateValidationId(): string {
    return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

// Worker pool management
class WorkerPool {
  private workers: Worker[] = [];
  private availableWorkers: Worker[] = [];
  private queue: Channel<any>;
  private _activeWorkers = 0;
  private shuttingDown = false;
  
  constructor(
    public readonly size: number,
    maxQueueSize: number = 10000
  ) {
    this.queue = new Channel(maxQueueSize);
    this.initializeWorkers();
  }
  
  private initializeWorkers(): void {
    // Create worker threads
    for (let i = 0; i < this.size; i++) {
      const worker = this.createWorker();
      this.workers.push(worker);
      this.availableWorkers.push(worker);
    }
    
    // Start processing queue
    this.processQueue();
  }
  
  private createWorker(): Worker {
    // In production, would create actual worker thread
    // For now, simulate with inline validation
    const worker = {
      postMessage: (data: any) => {
        // Simulate async validation
        setTimeout(() => {
          const result = {
            id: data.id,
            valid: Math.random() > 0.1, // 90% valid shares
            error: null
          };
          
          // Simulate worker response
          if (worker.onmessage) {
            worker.onmessage({ data: result });
          }
        }, Math.random() * 20); // 0-20ms validation time
      },
      terminate: () => {},
      onmessage: null as any,
      onerror: null as any
    } as any as Worker;
    
    return worker;
  }
  
  async submit(task: any): Promise<void> {
    if (this.shuttingDown) {
      throw new Error('Worker pool is shutting down');
    }
    
    await this.queue.send(task);
  }
  
  private async processQueue(): Promise<void> {
    while (!this.shuttingDown) {
      try {
        // Get next task
        const task = await this.queue.receive();
        
        // Wait for available worker
        const worker = await this.getAvailableWorker();
        
        // Process task
        this._activeWorkers++;
        this.processTask(worker, task);
      } catch (error) {
        if (this.queue.isClosed) break;
        logger.error('Queue processing error', error as Error);
      }
    }
  }
  
  private async getAvailableWorker(): Promise<Worker> {
    while (this.availableWorkers.length === 0 && !this.shuttingDown) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    
    return this.availableWorkers.shift()!;
  }
  
  private processTask(worker: Worker, task: any): void {
    worker.onmessage = (event: any) => {
      // Handle result
      if (task.callback) {
        task.callback(event.data);
      }
      
      // Return worker to pool
      this._activeWorkers--;
      this.availableWorkers.push(worker);
    };
    
    worker.onerror = (error: any) => {
      logger.error('Worker error', error);
      
      // Return worker to pool
      this._activeWorkers--;
      this.availableWorkers.push(worker);
    };
    
    // Send task to worker
    worker.postMessage(task);
  }
  
  get activeWorkers(): number {
    return this._activeWorkers;
  }
  
  get queueSize(): number {
    return this.queue.size;
  }
  
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.queue.close();
    
    // Terminate all workers
    for (const worker of this.workers) {
      worker.terminate();
    }
    
    this.workers = [];
    this.availableWorkers = [];
  }
}

// Share validation strategies
export class ValidationStrategy {
  // CPU-bound validation (PoW verification)
  static async validatePoW(share: Share): Promise<boolean> {
    // Simulate CPU-intensive validation
    const hash = this.calculateHash(share.data);
    const target = this.difficultyToTarget(share.difficulty);
    
    return this.compareHashes(hash, target);
  }
  
  // Memory-bound validation (Scrypt, etc.)
  static async validateMemoryBound(share: Share): Promise<boolean> {
    // Simulate memory-intensive validation
    const buffer = Buffer.allocUnsafe(1024 * 1024); // 1MB
    
    // Fill buffer with share data pattern
    for (let i = 0; i < buffer.length; i += share.data.length) {
      share.data.copy(buffer, i);
    }
    
    // Simulate memory-hard computation
    let result = 0;
    for (let i = 0; i < buffer.length - 4; i += 4) {
      result ^= buffer.readUInt32LE(i);
    }
    
    return result !== 0;
  }
  
  private static calculateHash(data: Buffer): string {
    // Simplified hash calculation
    return data.toString('hex');
  }
  
  private static difficultyToTarget(difficulty: number): string {
    // Convert difficulty to target
    const maxTarget = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
    const target = maxTarget / BigInt(difficulty);
    return target.toString(16).padStart(64, '0');
  }
  
  private static compareHashes(hash: string, target: string): boolean {
    return BigInt('0x' + hash) <= BigInt('0x' + target);
  }
}

// Optimization hints for V8
export class PerformanceOptimizer {
  // Optimize function for V8 JIT
  static optimizeFunction(fn: Function): void {
    // Call function multiple times to trigger optimization
    for (let i = 0; i < 10000; i++) {
      fn();
    }
  }
  
  // Pre-allocate objects to reduce GC pressure
  static createObjectPool<T>(
    factory: () => T,
    reset: (obj: T) => void,
    size: number = 100
  ): {
    acquire: () => T;
    release: (obj: T) => void;
  } {
    const pool: T[] = [];
    const inUse = new Set<T>();
    
    // Pre-allocate objects
    for (let i = 0; i < size; i++) {
      pool.push(factory());
    }
    
    return {
      acquire: () => {
        const obj = pool.pop() || factory();
        inUse.add(obj);
        return obj;
      },
      release: (obj: T) => {
        if (inUse.has(obj)) {
          inUse.delete(obj);
          reset(obj);
          pool.push(obj);
        }
      }
    };
  }
  
  // CPU affinity for workers
  static setCPUAffinity(workerId: number, cpuCore: number): void {
    // In production, would use node-affinity or similar
    // to bind worker to specific CPU core
    logger.info(`Would bind worker ${workerId} to CPU core ${cpuCore}`);
  }
}
