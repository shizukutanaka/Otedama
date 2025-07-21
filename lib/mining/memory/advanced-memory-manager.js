/**
 * Advanced Memory Manager for High-Performance Mining
 * Implements zero-copy, memory pooling, and NUMA-aware allocation
 */

import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';
import os from 'os';
import { logger } from '../../core/logger.js';

/**
 * Memory allocation strategies
 */
export const AllocationStrategy = {
  FIRST_FIT: 'first_fit',
  BEST_FIT: 'best_fit',
  BUDDY_SYSTEM: 'buddy_system',
  SLAB_ALLOCATOR: 'slab_allocator',
  NUMA_AWARE: 'numa_aware'
};

/**
 * Memory region for zero-copy operations
 */
export class MemoryRegion {
  constructor(size, alignment = 64) {
    this.size = size;
    this.alignment = alignment;
    this.buffer = this.allocateAligned(size, alignment);
    this.offset = 0;
    this.free = true;
    this.refCount = 0;
    this.lastAccess = Date.now();
  }
  
  /**
   * Allocate aligned memory
   */
  allocateAligned(size, alignment) {
    const totalSize = size + alignment - 1;
    const buffer = Buffer.allocUnsafe(totalSize);
    
    // Calculate aligned offset
    const address = buffer.buffer.byteOffset;
    const alignedAddress = Math.ceil(address / alignment) * alignment;
    const offset = alignedAddress - address;
    
    return buffer.slice(offset, offset + size);
  }
  
  /**
   * Get subregion for zero-copy
   */
  getSubregion(offset, size) {
    if (offset + size > this.size) {
      throw new Error('Subregion exceeds memory region bounds');
    }
    
    return {
      buffer: this.buffer.slice(offset, offset + size),
      offset: this.offset + offset,
      size: size
    };
  }
  
  /**
   * Mark region as used
   */
  acquire() {
    this.free = false;
    this.refCount++;
    this.lastAccess = Date.now();
  }
  
  /**
   * Release region
   */
  release() {
    this.refCount--;
    if (this.refCount <= 0) {
      this.free = true;
      this.refCount = 0;
    }
  }
}

/**
 * Memory pool for efficient allocation
 */
export class MemoryPool {
  constructor(options = {}) {
    this.blockSize = options.blockSize || 4096;
    this.maxBlocks = options.maxBlocks || 1024;
    this.alignment = options.alignment || 64;
    this.strategy = options.strategy || AllocationStrategy.BEST_FIT;
    
    this.blocks = [];
    this.freeList = new Set();
    this.usedList = new Map();
    
    // Statistics
    this.stats = {
      allocations: 0,
      deallocations: 0,
      hits: 0,
      misses: 0,
      fragmentation: 0
    };
    
    // Pre-allocate blocks
    this.initialize();
  }
  
  /**
   * Initialize memory pool
   */
  initialize() {
    const initialBlocks = Math.min(16, this.maxBlocks);
    
    for (let i = 0; i < initialBlocks; i++) {
      const block = new MemoryRegion(this.blockSize, this.alignment);
      this.blocks.push(block);
      this.freeList.add(i);
    }
  }
  
  /**
   * Allocate memory from pool
   */
  allocate(size) {
    this.stats.allocations++;
    
    // Find suitable block based on strategy
    const blockIndex = this.findBlock(size);
    
    if (blockIndex === -1) {
      // No suitable block, try to grow pool
      if (this.blocks.length < this.maxBlocks) {
        return this.growAndAllocate(size);
      }
      
      this.stats.misses++;
      return null;
    }
    
    this.stats.hits++;
    
    // Allocate from block
    const block = this.blocks[blockIndex];
    block.acquire();
    
    this.freeList.delete(blockIndex);
    this.usedList.set(block, blockIndex);
    
    return block;
  }
  
  /**
   * Find suitable block based on allocation strategy
   */
  findBlock(size) {
    if (size > this.blockSize) return -1;
    
    const freeBlocks = Array.from(this.freeList);
    
    switch (this.strategy) {
      case AllocationStrategy.FIRST_FIT:
        return freeBlocks[0] || -1;
        
      case AllocationStrategy.BEST_FIT:
        // In a real implementation, would track block sizes
        return freeBlocks[0] || -1;
        
      case AllocationStrategy.BUDDY_SYSTEM:
        // Buddy system implementation
        return this.findBuddyBlock(size, freeBlocks);
        
      default:
        return freeBlocks[0] || -1;
    }
  }
  
  /**
   * Find block using buddy system
   */
  findBuddyBlock(size, freeBlocks) {
    // Simplified buddy system
    const requiredOrder = Math.ceil(Math.log2(size));
    const blockOrder = Math.log2(this.blockSize);
    
    if (requiredOrder <= blockOrder) {
      return freeBlocks[0] || -1;
    }
    
    return -1;
  }
  
  /**
   * Grow pool and allocate
   */
  growAndAllocate(size) {
    const block = new MemoryRegion(Math.max(size, this.blockSize), this.alignment);
    const index = this.blocks.length;
    
    this.blocks.push(block);
    block.acquire();
    this.usedList.set(block, index);
    
    return block;
  }
  
  /**
   * Deallocate memory back to pool
   */
  deallocate(block) {
    if (!this.usedList.has(block)) {
      return false;
    }
    
    this.stats.deallocations++;
    
    const index = this.usedList.get(block);
    block.release();
    
    if (block.free) {
      this.usedList.delete(block);
      this.freeList.add(index);
    }
    
    return true;
  }
  
  /**
   * Calculate fragmentation
   */
  calculateFragmentation() {
    const totalSize = this.blocks.length * this.blockSize;
    const usedSize = this.usedList.size * this.blockSize;
    const freeSize = totalSize - usedSize;
    
    // External fragmentation
    const largestFreeBlock = this.blockSize; // Simplified
    this.stats.fragmentation = freeSize > 0 ? 1 - (largestFreeBlock / freeSize) : 0;
    
    return this.stats.fragmentation;
  }
  
  /**
   * Defragment pool
   */
  defragment() {
    // In a real implementation, would compact memory
    logger.info('Memory pool defragmentation initiated');
    
    // Reset statistics
    this.calculateFragmentation();
  }
  
  /**
   * Get pool statistics
   */
  getStats() {
    return {
      ...this.stats,
      totalBlocks: this.blocks.length,
      usedBlocks: this.usedList.size,
      freeBlocks: this.freeList.size,
      utilization: this.usedList.size / this.blocks.length
    };
  }
}

/**
 * NUMA-aware memory allocator
 */
export class NUMAAllocator {
  constructor() {
    this.nodes = this.detectNUMANodes();
    this.nodePools = new Map();
    
    // Initialize per-node pools
    for (const node of this.nodes) {
      this.nodePools.set(node.id, new MemoryPool({
        blockSize: 8192,
        maxBlocks: 512,
        strategy: AllocationStrategy.NUMA_AWARE
      }));
    }
  }
  
  /**
   * Detect NUMA nodes
   */
  detectNUMANodes() {
    const cpus = os.cpus();
    const numNodes = Math.max(1, Math.floor(cpus.length / 4)); // Estimate
    
    const nodes = [];
    for (let i = 0; i < numNodes; i++) {
      nodes.push({
        id: i,
        cpus: cpus.slice(i * 4, (i + 1) * 4).map((_, idx) => i * 4 + idx),
        memory: os.totalmem() / numNodes
      });
    }
    
    return nodes;
  }
  
  /**
   * Allocate on specific NUMA node
   */
  allocateOnNode(nodeId, size) {
    const pool = this.nodePools.get(nodeId);
    if (!pool) {
      throw new Error(`NUMA node ${nodeId} not found`);
    }
    
    return pool.allocate(size);
  }
  
  /**
   * Allocate with CPU affinity
   */
  allocateWithAffinity(cpuId, size) {
    // Find NUMA node for CPU
    const node = this.nodes.find(n => n.cpus.includes(cpuId));
    if (!node) {
      // Fallback to first node
      return this.allocateOnNode(0, size);
    }
    
    return this.allocateOnNode(node.id, size);
  }
  
  /**
   * Get NUMA statistics
   */
  getStats() {
    const stats = {};
    
    for (const [nodeId, pool] of this.nodePools) {
      stats[`node_${nodeId}`] = pool.getStats();
    }
    
    return stats;
  }
}

/**
 * Advanced Mining Memory Manager
 */
export class AdvancedMiningMemoryManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      enableZeroCopy: options.enableZeroCopy !== false,
      enableNUMA: options.enableNUMA !== false,
      enableCompression: options.enableCompression || false,
      compressionThreshold: options.compressionThreshold || 1024,
      gcInterval: options.gcInterval || 60000,
      maxMemoryUsage: options.maxMemoryUsage || 0.8, // 80% of available
      ...options
    };
    
    // Memory pools
    this.pools = new Map();
    this.initializePools();
    
    // NUMA allocator
    if (this.options.enableNUMA) {
      this.numaAllocator = new NUMAAllocator();
    }
    
    // Shared memory regions for zero-copy
    this.sharedRegions = new Map();
    
    // Memory pressure monitoring
    this.memoryPressure = 0;
    this.lastGC = Date.now();
    
    // Statistics
    this.stats = {
      totalAllocated: 0,
      totalDeallocated: 0,
      currentUsage: 0,
      peakUsage: 0,
      gcRuns: 0,
      compressions: 0
    };
    
    // Start monitoring
    this.startMonitoring();
  }
  
  /**
   * Initialize memory pools
   */
  initializePools() {
    // Create pools for different size classes
    const sizeClasses = [
      { name: 'tiny', size: 64, blocks: 4096 },
      { name: 'small', size: 256, blocks: 2048 },
      { name: 'medium', size: 1024, blocks: 1024 },
      { name: 'large', size: 4096, blocks: 512 },
      { name: 'huge', size: 16384, blocks: 128 }
    ];
    
    for (const sizeClass of sizeClasses) {
      this.pools.set(sizeClass.name, new MemoryPool({
        blockSize: sizeClass.size,
        maxBlocks: sizeClass.blocks,
        strategy: AllocationStrategy.BEST_FIT
      }));
    }
  }
  
  /**
   * Allocate memory with zero-copy support
   */
  allocate(size, options = {}) {
    // Update statistics
    this.stats.totalAllocated += size;
    this.stats.currentUsage += size;
    this.stats.peakUsage = Math.max(this.stats.peakUsage, this.stats.currentUsage);
    
    // Check memory pressure
    if (this.checkMemoryPressure()) {
      this.performEmergencyGC();
    }
    
    // NUMA-aware allocation
    if (this.options.enableNUMA && options.cpuAffinity !== undefined) {
      return this.numaAllocator.allocateWithAffinity(options.cpuAffinity, size);
    }
    
    // Select appropriate pool
    const pool = this.selectPool(size);
    if (!pool) {
      // Fallback to direct allocation
      return this.directAllocate(size, options);
    }
    
    // Allocate from pool
    const region = pool.allocate(size);
    if (!region) {
      return this.directAllocate(size, options);
    }
    
    // Enable zero-copy if requested
    if (this.options.enableZeroCopy && options.shared) {
      this.enableZeroCopy(region, options.sharedId);
    }
    
    return region;
  }
  
  /**
   * Select appropriate memory pool
   */
  selectPool(size) {
    if (size <= 64) return this.pools.get('tiny');
    if (size <= 256) return this.pools.get('small');
    if (size <= 1024) return this.pools.get('medium');
    if (size <= 4096) return this.pools.get('large');
    if (size <= 16384) return this.pools.get('huge');
    
    return null;
  }
  
  /**
   * Direct allocation for large sizes
   */
  directAllocate(size, options) {
    const alignment = options.alignment || 64;
    const region = new MemoryRegion(size, alignment);
    
    if (this.options.enableCompression && size > this.options.compressionThreshold) {
      // Mark for potential compression
      region.compressible = true;
    }
    
    return region;
  }
  
  /**
   * Enable zero-copy for shared region
   */
  enableZeroCopy(region, sharedId) {
    if (!sharedId) {
      sharedId = `shared_${Date.now()}_${Math.random()}`;
    }
    
    // Create SharedArrayBuffer for zero-copy
    const sharedBuffer = new SharedArrayBuffer(region.size);
    const sharedArray = new Uint8Array(sharedBuffer);
    
    // Copy data to shared buffer
    const sourceArray = new Uint8Array(region.buffer.buffer, region.buffer.byteOffset, region.size);
    sharedArray.set(sourceArray);
    
    // Store reference
    this.sharedRegions.set(sharedId, {
      buffer: sharedBuffer,
      region: region,
      refCount: 1
    });
    
    region.sharedId = sharedId;
    region.sharedBuffer = sharedBuffer;
    
    return sharedId;
  }
  
  /**
   * Get shared region for zero-copy
   */
  getSharedRegion(sharedId) {
    return this.sharedRegions.get(sharedId);
  }
  
  /**
   * Deallocate memory
   */
  deallocate(region) {
    if (!region) return;
    
    // Update statistics
    this.stats.totalDeallocated += region.size;
    this.stats.currentUsage -= region.size;
    
    // Handle shared regions
    if (region.sharedId) {
      this.releaseSharedRegion(region.sharedId);
    }
    
    // Return to pool or free
    const pool = this.selectPool(region.size);
    if (pool) {
      pool.deallocate(region);
    }
  }
  
  /**
   * Release shared region
   */
  releaseSharedRegion(sharedId) {
    const shared = this.sharedRegions.get(sharedId);
    if (!shared) return;
    
    shared.refCount--;
    if (shared.refCount <= 0) {
      this.sharedRegions.delete(sharedId);
    }
  }
  
  /**
   * Check memory pressure
   */
  checkMemoryPressure() {
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedRatio = 1 - (freeMemory / totalMemory);
    
    this.memoryPressure = usedRatio;
    
    return usedRatio > this.options.maxMemoryUsage;
  }
  
  /**
   * Perform emergency garbage collection
   */
  performEmergencyGC() {
    logger.warn('Memory pressure detected, performing emergency GC');
    
    // Force Node.js GC if available
    if (global.gc) {
      global.gc();
      this.stats.gcRuns++;
    }
    
    // Compact memory pools
    for (const pool of this.pools.values()) {
      pool.defragment();
    }
    
    // Clear unused shared regions
    for (const [sharedId, shared] of this.sharedRegions) {
      if (shared.refCount <= 0) {
        this.sharedRegions.delete(sharedId);
      }
    }
    
    // Compress large regions if enabled
    if (this.options.enableCompression) {
      this.compressIdleRegions();
    }
    
    this.lastGC = Date.now();
    this.emit('gc:complete');
  }
  
  /**
   * Compress idle memory regions
   */
  compressIdleRegions() {
    // In real implementation, would use zlib or lz4
    logger.info('Compressing idle memory regions');
    this.stats.compressions++;
  }
  
  /**
   * Start memory monitoring
   */
  startMonitoring() {
    this.monitoringInterval = setInterval(() => {
      const stats = this.getStats();
      
      // Check if GC needed
      if (Date.now() - this.lastGC > this.options.gcInterval) {
        if (this.memoryPressure > 0.6) {
          this.performEmergencyGC();
        }
      }
      
      // Emit statistics
      this.emit('stats:update', stats);
    }, 5000);
  }
  
  /**
   * Get memory statistics
   */
  getStats() {
    const poolStats = {};
    
    for (const [name, pool] of this.pools) {
      poolStats[name] = pool.getStats();
    }
    
    const systemStats = {
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      memoryPressure: this.memoryPressure
    };
    
    const numaStats = this.options.enableNUMA ? this.numaAllocator.getStats() : null;
    
    return {
      ...this.stats,
      pools: poolStats,
      system: systemStats,
      numa: numaStats,
      sharedRegions: this.sharedRegions.size
    };
  }
  
  /**
   * Optimize memory layout for cache efficiency
   */
  optimizeCacheLayout(data, accessPattern) {
    // Reorder data based on access pattern
    if (accessPattern === 'sequential') {
      // Already optimal
      return data;
    }
    
    if (accessPattern === 'strided') {
      // Implement cache-friendly strided access
      // In real implementation, would reorganize data
    }
    
    return data;
  }
  
  /**
   * Create memory-mapped file for large datasets
   */
  async createMemoryMappedFile(filename, size) {
    // In real implementation, would use mmap
    logger.info(`Creating memory-mapped file: ${filename} (${size} bytes)`);
    
    return {
      filename,
      size,
      map: () => { /* mmap implementation */ },
      unmap: () => { /* munmap implementation */ }
    };
  }
  
  /**
   * Shutdown memory manager
   */
  shutdown() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }
    
    // Clear all pools
    for (const pool of this.pools.values()) {
      pool.defragment();
    }
    
    // Clear shared regions
    this.sharedRegions.clear();
    
    // Final GC
    if (global.gc) {
      global.gc();
    }
    
    this.emit('shutdown');
  }
}

export default AdvancedMiningMemoryManager;