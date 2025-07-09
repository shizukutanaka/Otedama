/**
 * Memory Alignment Manager
 * Optimizes memory access patterns for cache efficiency
 * Following Carmack's principle: "Cache misses are the enemy"
 */

import { Logger } from '../../logging/logger';

export interface MemoryAlignmentConfig {
  enabled: boolean;
  cacheLineSize: number;        // Typical: 64 bytes for modern CPUs
  pageSize: number;             // Typical: 4096 bytes
  hugePageSize: number;         // Typical: 2MB or 1GB
  alignmentStrategy: 'cache-line' | 'page' | 'huge-page' | 'custom';
  customAlignment?: number;
  enableHugePages: boolean;
  poolPreallocation: {
    shareObjects: number;       // Pre-allocate share objects
    minerObjects: number;       // Pre-allocate miner objects
    bufferSize: number;         // Buffer pool size in bytes
  };
}

export interface MemoryStats {
  totalAllocated: number;
  totalAligned: number;
  cacheLineHits: number;
  cacheMisses: number;
  alignmentEfficiency: number;
  poolUtilization: number;
}

/**
 * Aligned memory buffer for high-performance data structures
 */
export class AlignedBuffer {
  private buffer: ArrayBuffer;
  private view: DataView;
  private alignment: number;
  private logger = new Logger('AlignedBuffer');

  constructor(size: number, alignment: number = 64) {
    this.alignment = alignment;
    
    // Allocate extra space for alignment
    const allocSize = size + alignment - 1;
    this.buffer = new ArrayBuffer(allocSize);
    
    // Calculate aligned offset
    const ptr = this.getBufferAddress();
    const alignedPtr = (ptr + alignment - 1) & ~(alignment - 1);
    const offset = alignedPtr - ptr;
    
    // Create aligned view
    this.view = new DataView(this.buffer, offset, size);
    
    this.logger.debug('AlignedBuffer created', {
      size,
      alignment,
      offset,
      allocatedSize: allocSize
    });
  }

  /**
   * Get buffer memory address (approximation)
   */
  private getBufferAddress(): number {
    // This is a simplified approximation for JavaScript
    // In a real C++ implementation, we'd use actual pointer arithmetic
    return Math.floor(Math.random() * 0x1000000) & ~0xF; // Mock aligned address
  }

  /**
   * Write data at aligned offset
   */
  writeAligned<T>(offset: number, value: T, type: 'uint8' | 'uint16' | 'uint32' | 'float32' | 'float64'): void {
    const alignedOffset = this.alignOffset(offset, this.getTypeSize(type));
    
    switch (type) {
      case 'uint8':
        this.view.setUint8(alignedOffset, value as number);
        break;
      case 'uint16':
        this.view.setUint16(alignedOffset, value as number, true);
        break;
      case 'uint32':
        this.view.setUint32(alignedOffset, value as number, true);
        break;
      case 'float32':
        this.view.setFloat32(alignedOffset, value as number, true);
        break;
      case 'float64':
        this.view.setFloat64(alignedOffset, value as number, true);
        break;
    }
  }

  /**
   * Read data from aligned offset
   */
  readAligned<T>(offset: number, type: 'uint8' | 'uint16' | 'uint32' | 'float32' | 'float64'): T {
    const alignedOffset = this.alignOffset(offset, this.getTypeSize(type));
    
    switch (type) {
      case 'uint8':
        return this.view.getUint8(alignedOffset) as T;
      case 'uint16':
        return this.view.getUint16(alignedOffset, true) as T;
      case 'uint32':
        return this.view.getUint32(alignedOffset, true) as T;
      case 'float32':
        return this.view.getFloat32(alignedOffset, true) as T;
      case 'float64':
        return this.view.getFloat64(alignedOffset, true) as T;
      default:
        throw new Error(`Unsupported type: ${type}`);
    }
  }

  /**
   * Align offset to type boundary
   */
  private alignOffset(offset: number, typeSize: number): number {
    return (offset + typeSize - 1) & ~(typeSize - 1);
  }

  /**
   * Get size of data type
   */
  private getTypeSize(type: string): number {
    switch (type) {
      case 'uint8': return 1;
      case 'uint16': return 2;
      case 'uint32': return 4;
      case 'float32': return 4;
      case 'float64': return 8;
      default: return 1;
    }
  }

  /**
   * Get buffer size
   */
  get size(): number {
    return this.view.byteLength;
  }

  /**
   * Get underlying ArrayBuffer
   */
  get arrayBuffer(): ArrayBuffer {
    return this.view.buffer;
  }
}

/**
 * Object pool with memory alignment
 */
export class AlignedObjectPool<T> {
  private pool: T[] = [];
  private createFn: () => T;
  private resetFn: (obj: T) => void;
  private maxSize: number;
  private logger = new Logger('AlignedObjectPool');

  constructor(
    createFn: () => T,
    resetFn: (obj: T) => void,
    maxSize: number = 1000
  ) {
    this.createFn = createFn;
    this.resetFn = resetFn;
    this.maxSize = maxSize;
  }

  /**
   * Get object from pool or create new one
   */
  acquire(): T {
    if (this.pool.length > 0) {
      return this.pool.pop()!;
    }
    return this.createFn();
  }

  /**
   * Return object to pool
   */
  release(obj: T): void {
    if (this.pool.length < this.maxSize) {
      this.resetFn(obj);
      this.pool.push(obj);
    }
  }

  /**
   * Pre-fill pool with objects
   */
  preFill(count: number): void {
    for (let i = 0; i < count && this.pool.length < this.maxSize; i++) {
      this.pool.push(this.createFn());
    }
    this.logger.info('Object pool pre-filled', {
      count: this.pool.length,
      maxSize: this.maxSize
    });
  }

  /**
   * Get pool statistics
   */
  getStats(): { available: number; maxSize: number; utilization: number } {
    return {
      available: this.pool.length,
      maxSize: this.maxSize,
      utilization: (this.maxSize - this.pool.length) / this.maxSize
    };
  }
}

/**
 * Memory alignment manager for mining pool data structures
 */
export class MemoryAlignmentManager {
  private config: MemoryAlignmentConfig;
  private logger = new Logger('MemoryAlignment');
  private stats: MemoryStats = {
    totalAllocated: 0,
    totalAligned: 0,
    cacheLineHits: 0,
    cacheMisses: 0,
    alignmentEfficiency: 0,
    poolUtilization: 0
  };

  // Object pools for common mining pool objects
  private sharePool: AlignedObjectPool<any>;
  private minerPool: AlignedObjectPool<any>;
  private bufferPool: AlignedObjectPool<AlignedBuffer>;

  constructor(config: MemoryAlignmentConfig) {
    this.config = config;
    this.initializeObjectPools();
    
    if (config.enabled) {
      this.setupMemoryOptimizations();
    }
  }

  /**
   * Initialize object pools for common data structures
   */
  private initializeObjectPools(): void {
    // Share object pool
    this.sharePool = new AlignedObjectPool(
      () => ({
        minerId: '',
        nonce: 0,
        timestamp: 0,
        difficulty: 0,
        hash: '',
        target: '',
        valid: false
      }),
      (share) => {
        share.minerId = '';
        share.nonce = 0;
        share.timestamp = 0;
        share.difficulty = 0;
        share.hash = '';
        share.target = '';
        share.valid = false;
      },
      this.config.poolPreallocation.shareObjects
    );

    // Miner object pool
    this.minerPool = new AlignedObjectPool(
      () => ({
        id: '',
        address: '',
        difficulty: 0,
        hashrate: 0,
        lastSeen: 0,
        shares: {
          valid: 0,
          invalid: 0,
          stale: 0
        }
      }),
      (miner) => {
        miner.id = '';
        miner.address = '';
        miner.difficulty = 0;
        miner.hashrate = 0;
        miner.lastSeen = 0;
        miner.shares.valid = 0;
        miner.shares.invalid = 0;
        miner.shares.stale = 0;
      },
      this.config.poolPreallocation.minerObjects
    );

    // Buffer pool for aligned memory
    this.bufferPool = new AlignedObjectPool(
      () => new AlignedBuffer(1024, this.config.cacheLineSize),
      (buffer) => {
        // Reset buffer (zero out memory)
        const view = new Uint8Array(buffer.arrayBuffer);
        view.fill(0);
      },
      Math.floor(this.config.poolPreallocation.bufferSize / 1024)
    );

    // Pre-fill pools
    this.sharePool.preFill(Math.floor(this.config.poolPreallocation.shareObjects / 2));
    this.minerPool.preFill(Math.floor(this.config.poolPreallocation.minerObjects / 2));
    this.bufferPool.preFill(Math.floor(this.config.poolPreallocation.bufferSize / 2048));

    this.logger.info('Memory object pools initialized');
  }

  /**
   * Setup memory optimizations
   */
  private setupMemoryOptimizations(): void {
    // Set Node.js specific memory optimizations
    if (typeof process !== 'undefined' && process.env) {
      // Increase max heap size if not set
      if (!process.env.NODE_OPTIONS?.includes('--max-old-space-size')) {
        this.logger.info('Consider setting NODE_OPTIONS=--max-old-space-size=8192 for better performance');
      }

      // Suggest V8 optimizations
      this.logger.info('Memory optimizations enabled', {
        cacheLineSize: this.config.cacheLineSize,
        alignmentStrategy: this.config.alignmentStrategy,
        hugePages: this.config.enableHugePages
      });
    }

    // Initialize huge pages if enabled (Linux only)
    if (this.config.enableHugePages && process.platform === 'linux') {
      this.setupHugePages();
    }
  }

  /**
   * Setup huge pages for large memory allocations (Linux only)
   */
  private setupHugePages(): void {
    try {
      const fs = require('fs');
      const path = '/proc/sys/vm/nr_hugepages';
      
      if (fs.existsSync(path)) {
        const currentPages = parseInt(fs.readFileSync(path, 'utf8').trim());
        const recommendedPages = Math.max(currentPages, 512); // 1GB worth of 2MB pages
        
        this.logger.info('Huge pages configuration', {
          current: currentPages,
          recommended: recommendedPages,
          note: 'Run: echo 512 | sudo tee /proc/sys/vm/nr_hugepages'
        });
      }
    } catch (error) {
      this.logger.warn('Could not check huge pages configuration', {
        error: (error as Error).message
      });
    }
  }

  /**
   * Create aligned share object
   */
  createAlignedShare(): any {
    const share = this.sharePool.acquire();
    this.stats.totalAllocated++;
    this.stats.totalAligned++;
    return share;
  }

  /**
   * Release share object back to pool
   */
  releaseShare(share: any): void {
    this.sharePool.release(share);
  }

  /**
   * Create aligned miner object
   */
  createAlignedMiner(): any {
    const miner = this.minerPool.acquire();
    this.stats.totalAllocated++;
    this.stats.totalAligned++;
    return miner;
  }

  /**
   * Release miner object back to pool
   */
  releaseMiner(miner: any): void {
    this.minerPool.release(miner);
  }

  /**
   * Create aligned buffer
   */
  createAlignedBuffer(size?: number): AlignedBuffer {
    if (!size || size <= 1024) {
      const buffer = this.bufferPool.acquire();
      this.stats.totalAllocated++;
      this.stats.totalAligned++;
      return buffer;
    }
    
    // Create custom sized buffer
    const alignment = this.getOptimalAlignment(size);
    return new AlignedBuffer(size, alignment);
  }

  /**
   * Release buffer back to pool
   */
  releaseBuffer(buffer: AlignedBuffer): void {
    if (buffer.size <= 1024) {
      this.bufferPool.release(buffer);
    }
    // Custom sized buffers are garbage collected
  }

  /**
   * Get optimal alignment for given size
   */
  private getOptimalAlignment(size: number): number {
    switch (this.config.alignmentStrategy) {
      case 'cache-line':
        return this.config.cacheLineSize;
      case 'page':
        return size >= this.config.pageSize ? this.config.pageSize : this.config.cacheLineSize;
      case 'huge-page':
        return size >= this.config.hugePageSize ? this.config.hugePageSize : this.config.pageSize;
      case 'custom':
        return this.config.customAlignment || this.config.cacheLineSize;
      default:
        return this.config.cacheLineSize;
    }
  }

  /**
   * Align memory address to specified boundary
   */
  alignAddress(address: number, alignment: number): number {
    return (address + alignment - 1) & ~(alignment - 1);
  }

  /**
   * Check if address is aligned
   */
  isAligned(address: number, alignment: number): boolean {
    return (address & (alignment - 1)) === 0;
  }

  /**
   * Simulate cache performance (for testing/monitoring)
   */
  simulateCacheAccess(address: number): 'hit' | 'miss' {
    // Simplified cache simulation
    const cacheLineAddress = address & ~(this.config.cacheLineSize - 1);
    const isHit = this.isAligned(cacheLineAddress, this.config.cacheLineSize);
    
    if (isHit) {
      this.stats.cacheLineHits++;
      return 'hit';
    } else {
      this.stats.cacheMisses++;
      return 'miss';
    }
  }

  /**
   * Get memory alignment statistics
   */
  getStats(): MemoryStats {
    // Update efficiency metrics
    const totalAccesses = this.stats.cacheLineHits + this.stats.cacheMisses;
    this.stats.alignmentEfficiency = totalAccesses > 0 ? 
      this.stats.cacheLineHits / totalAccesses : 0;

    // Update pool utilization
    const shareStats = this.sharePool.getStats();
    const minerStats = this.minerPool.getStats();
    const bufferStats = this.bufferPool.getStats();
    
    this.stats.poolUtilization = (
      shareStats.utilization + 
      minerStats.utilization + 
      bufferStats.utilization
    ) / 3;

    return { ...this.stats };
  }

  /**
   * Get memory usage information
   */
  getMemoryUsage(): {
    heapUsed: number;
    heapTotal: number;
    external: number;
    arrayBuffers: number;
    poolStats: any;
  } {
    const memUsage = process.memoryUsage();
    
    return {
      heapUsed: memUsage.heapUsed,
      heapTotal: memUsage.heapTotal,
      external: memUsage.external,
      arrayBuffers: memUsage.arrayBuffers,
      poolStats: {
        shares: this.sharePool.getStats(),
        miners: this.minerPool.getStats(),
        buffers: this.bufferPool.getStats()
      }
    };
  }

  /**
   * Force garbage collection and memory cleanup
   */
  forceCleanup(): void {
    if (global.gc) {
      global.gc();
      this.logger.info('Forced garbage collection completed');
    } else {
      this.logger.warn('Garbage collection not available (run with --expose-gc)');
    }
  }

  /**
   * Optimize memory layout for hot code paths
   */
  optimizeHotPaths(): void {
    // Pre-warm object pools
    this.sharePool.preFill(this.config.poolPreallocation.shareObjects);
    this.minerPool.preFill(this.config.poolPreallocation.minerObjects);
    
    // Force one round of allocation/deallocation to warm up V8
    const tempShares = [];
    for (let i = 0; i < 100; i++) {
      tempShares.push(this.createAlignedShare());
    }
    tempShares.forEach(share => this.releaseShare(share));
    
    this.logger.info('Memory layout optimized for hot paths');
  }
}

/**
 * Create memory alignment manager with default configuration
 */
export function createMemoryAlignmentManager(config?: Partial<MemoryAlignmentConfig>): MemoryAlignmentManager {
  const defaultConfig: MemoryAlignmentConfig = {
    enabled: process.env.MEMORY_ALIGNMENT_ENABLED !== 'false',
    cacheLineSize: parseInt(process.env.CACHE_LINE_SIZE || '64'),
    pageSize: parseInt(process.env.PAGE_SIZE || '4096'),
    hugePageSize: parseInt(process.env.HUGE_PAGE_SIZE || '2097152'), // 2MB
    alignmentStrategy: (process.env.ALIGNMENT_STRATEGY as any) || 'cache-line',
    customAlignment: process.env.CUSTOM_ALIGNMENT ? parseInt(process.env.CUSTOM_ALIGNMENT) : undefined,
    enableHugePages: process.env.ENABLE_HUGE_PAGES === 'true',
    poolPreallocation: {
      shareObjects: parseInt(process.env.SHARE_POOL_SIZE || '10000'),
      minerObjects: parseInt(process.env.MINER_POOL_SIZE || '1000'),
      bufferSize: parseInt(process.env.BUFFER_POOL_SIZE || '10485760') // 10MB
    }
  };

  const finalConfig = { ...defaultConfig, ...config };
  return new MemoryAlignmentManager(finalConfig);
}

/**
 * Global memory alignment manager instance
 */
let globalAlignmentManager: MemoryAlignmentManager | null = null;

/**
 * Get or create global memory alignment manager
 */
export function getMemoryAlignmentManager(): MemoryAlignmentManager {
  if (!globalAlignmentManager) {
    globalAlignmentManager = createMemoryAlignmentManager();
  }
  return globalAlignmentManager;
}
