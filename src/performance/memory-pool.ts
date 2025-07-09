// Memory pool optimization for efficient memory usage (Carmack style)
import { createComponentLogger } from '../logging/logger';

const logger = createComponentLogger('memory-pool');

// Generic object pool for reusable objects
export class ObjectPool<T> {
  private pool: T[] = [];
  private activeObjects = new WeakSet<T>();
  private createCount = 0;
  private reuseCount = 0;
  
  constructor(
    private factory: () => T,
    private reset: (obj: T) => void,
    private initialSize: number = 100,
    private maxSize: number = 10000
  ) {
    // Pre-allocate initial objects
    this.preallocate(initialSize);
  }
  
  private preallocate(size: number): void {
    for (let i = 0; i < size; i++) {
      this.pool.push(this.factory());
      this.createCount++;
    }
    logger.info(`Pre-allocated ${size} objects`);
  }
  
  // Acquire object from pool
  acquire(): T {
    let obj: T;
    
    if (this.pool.length > 0) {
      obj = this.pool.pop()!;
      this.reuseCount++;
    } else {
      obj = this.factory();
      this.createCount++;
    }
    
    this.activeObjects.add(obj);
    return obj;
  }
  
  // Release object back to pool
  release(obj: T): void {
    if (!this.activeObjects.has(obj)) {
      return; // Not from this pool
    }
    
    this.activeObjects.delete(obj);
    this.reset(obj);
    
    if (this.pool.length < this.maxSize) {
      this.pool.push(obj);
    }
  }
  
  // Get pool statistics
  getStats(): {
    poolSize: number;
    created: number;
    reused: number;
    reuseRatio: number;
  } {
    const total = this.createCount + this.reuseCount;
    return {
      poolSize: this.pool.length,
      created: this.createCount,
      reused: this.reuseCount,
      reuseRatio: total > 0 ? this.reuseCount / total : 0
    };
  }
  
  // Clear pool
  clear(): void {
    this.pool = [];
  }
}

// Specialized buffer pool for network operations
export class BufferPool {
  private pools = new Map<number, ObjectPool<Buffer>>();
  
  // Get buffer of specific size
  acquire(size: number): Buffer {
    // Round up to nearest power of 2 for better pooling
    const poolSize = this.nextPowerOf2(size);
    
    if (!this.pools.has(poolSize)) {
      this.pools.set(poolSize, new ObjectPool(
        () => Buffer.allocUnsafe(poolSize),
        (buf) => buf.fill(0), // Reset buffer
        100,
        1000
      ));
    }
    
    const buffer = this.pools.get(poolSize)!.acquire();
    return size === poolSize ? buffer : buffer.slice(0, size);
  }
  
  // Release buffer back to pool
  release(buffer: Buffer): void {
    const poolSize = this.nextPowerOf2(buffer.length);
    const pool = this.pools.get(poolSize);
    
    if (pool) {
      pool.release(buffer);
    }
  }
  
  private nextPowerOf2(n: number): number {
    if (n <= 0) return 1;
    n--;
    n |= n >> 1;
    n |= n >> 2;
    n |= n >> 4;
    n |= n >> 8;
    n |= n >> 16;
    return n + 1;
  }
  
  // Get statistics for all pools
  getStats(): { [size: number]: any } {
    const stats: { [size: number]: any } = {};
    
    for (const [size, pool] of this.pools) {
      stats[size] = pool.getStats();
    }
    
    return stats;
  }
}

// Memory-efficient ring buffer
export class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private head = 0;
  private tail = 0;
  private count = 0;
  
  constructor(private capacity: number) {
    this.buffer = new Array(capacity);
  }
  
  push(item: T): boolean {
    if (this.count === this.capacity) {
      return false; // Buffer full
    }
    
    this.buffer[this.tail] = item;
    this.tail = (this.tail + 1) % this.capacity;
    this.count++;
    return true;
  }
  
  pop(): T | undefined {
    if (this.count === 0) {
      return undefined;
    }
    
    const item = this.buffer[this.head];
    this.buffer[this.head] = undefined; // Help GC
    this.head = (this.head + 1) % this.capacity;
    this.count--;
    return item;
  }
  
  peek(): T | undefined {
    return this.count > 0 ? this.buffer[this.head] : undefined;
  }
  
  get size(): number {
    return this.count;
  }
  
  get isFull(): boolean {
    return this.count === this.capacity;
  }
  
  get isEmpty(): boolean {
    return this.count === 0;
  }
  
  clear(): void {
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }
}

// Slab allocator for fixed-size objects
export class SlabAllocator<T> {
  private slabs: Array<{
    data: T[];
    freeList: number[];
  }> = [];
  private slabSize: number;
  private currentSlab = 0;
  
  constructor(
    private factory: () => T,
    private reset: (obj: T) => void,
    slabSize: number = 1024
  ) {
    this.slabSize = slabSize;
    this.allocateSlab();
  }
  
  private allocateSlab(): void {
    const data: T[] = [];
    const freeList: number[] = [];
    
    for (let i = 0; i < this.slabSize; i++) {
      data.push(this.factory());
      freeList.push(i);
    }
    
    this.slabs.push({ data, freeList });
  }
  
  allocate(): T {
    // Find slab with free objects
    for (let i = this.currentSlab; i < this.slabs.length; i++) {
      const slab = this.slabs[i];
      if (slab.freeList.length > 0) {
        const index = slab.freeList.pop()!;
        this.currentSlab = i;
        return slab.data[index];
      }
    }
    
    // No free objects, allocate new slab
    this.allocateSlab();
    this.currentSlab = this.slabs.length - 1;
    return this.allocate();
  }
  
  free(obj: T): void {
    // Find which slab this object belongs to
    for (let i = 0; i < this.slabs.length; i++) {
      const slab = this.slabs[i];
      const index = slab.data.indexOf(obj);
      
      if (index !== -1) {
        this.reset(obj);
        slab.freeList.push(index);
        
        // Update current slab if this one has more free space
        if (i < this.currentSlab) {
          this.currentSlab = i;
        }
        return;
      }
    }
  }
  
  getStats(): {
    slabCount: number;
    totalObjects: number;
    freeObjects: number;
    utilization: number;
  } {
    let freeCount = 0;
    for (const slab of this.slabs) {
      freeCount += slab.freeList.length;
    }
    
    const totalObjects = this.slabs.length * this.slabSize;
    
    return {
      slabCount: this.slabs.length,
      totalObjects,
      freeObjects: freeCount,
      utilization: (totalObjects - freeCount) / totalObjects
    };
  }
}

// Memory pool manager
export class MemoryPoolManager {
  private static instance: MemoryPoolManager;
  
  public readonly buffers: BufferPool;
  public readonly shares: ObjectPool<any>;
  public readonly connections: ObjectPool<any>;
  public readonly messages: ObjectPool<any>;
  
  private constructor() {
    this.buffers = new BufferPool();
    
    // Share object pool
    this.shares = new ObjectPool(
      () => ({ 
        minerId: '', 
        jobId: '', 
        nonce: 0, 
        timestamp: 0, 
        difficulty: 0,
        data: null 
      }),
      (share) => {
        share.minerId = '';
        share.jobId = '';
        share.nonce = 0;
        share.timestamp = 0;
        share.difficulty = 0;
        share.data = null;
      },
      1000,
      50000
    );
    
    // Connection object pool
    this.connections = new ObjectPool(
      () => ({
        id: '',
        socket: null,
        authorized: false,
        subscribed: false,
        difficulty: 1,
        extraNonce1: '',
        workerName: ''
      }),
      (conn) => {
        conn.id = '';
        conn.socket = null;
        conn.authorized = false;
        conn.subscribed = false;
        conn.difficulty = 1;
        conn.extraNonce1 = '';
        conn.workerName = '';
      },
      100,
      10000
    );
    
    // Message object pool
    this.messages = new ObjectPool(
      () => ({
        id: 0,
        method: '',
        params: null,
        result: null,
        error: null
      }),
      (msg) => {
        msg.id = 0;
        msg.method = '';
        msg.params = null;
        msg.result = null;
        msg.error = null;
      },
      1000,
      50000
    );
    
    logger.info('Memory pool manager initialized');
  }
  
  static getInstance(): MemoryPoolManager {
    if (!this.instance) {
      this.instance = new MemoryPoolManager();
    }
    return this.instance;
  }
  
  // Get overall statistics
  getStats(): any {
    return {
      buffers: this.buffers.getStats(),
      shares: this.shares.getStats(),
      connections: this.connections.getStats(),
      messages: this.messages.getStats(),
      memory: {
        heapUsed: process.memoryUsage().heapUsed,
        heapTotal: process.memoryUsage().heapTotal,
        external: process.memoryUsage().external,
        rss: process.memoryUsage().rss
      }
    };
  }
}

// Export singleton instance
export const memoryPool = MemoryPoolManager.getInstance();
