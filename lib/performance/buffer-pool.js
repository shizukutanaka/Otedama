/**
 * High-Performance Buffer Pool Manager for Otedama
 * 
 * Implements zero-copy buffer management following John Carmack's principles
 * Reduces GC pressure and improves memory access patterns
 */

import { EventEmitter } from 'events';

/**
 * Buffer pool for zero-copy operations
 */
export class BufferPool extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            minSize: config.minSize || 64,           // Minimum buffer size
            maxSize: config.maxSize || 1048576,      // Maximum buffer size (1MB)
            poolSizePerBucket: config.poolSizePerBucket || 100,
            maxTotalMemory: config.maxTotalMemory || 100 * 1024 * 1024, // 100MB
            gcInterval: config.gcInterval || 60000,  // 1 minute
            ...config
        };
        
        // Buffer buckets organized by size (power of 2)
        this.buckets = new Map();
        
        // Statistics
        this.stats = {
            allocations: 0,
            releases: 0,
            hits: 0,
            misses: 0,
            totalMemory: 0,
            activeBuffers: 0
        };
        
        // Initialize buckets
        this.initializeBuckets();
        
        // Start garbage collection
        this.startGC();
    }
    
    /**
     * Initialize buffer buckets
     */
    initializeBuckets() {
        let size = this.config.minSize;
        
        while (size <= this.config.maxSize) {
            this.buckets.set(size, {
                size,
                free: [],
                active: new Set(),
                stats: {
                    allocations: 0,
                    hits: 0,
                    misses: 0
                }
            });
            
            size *= 2; // Power of 2 sizes
        }
    }
    
    /**
     * Allocate a buffer from the pool
     */
    allocate(size) {
        this.stats.allocations++;
        
        // Find appropriate bucket (round up to power of 2)
        const bucketSize = this.findBucketSize(size);
        const bucket = this.buckets.get(bucketSize);
        
        if (!bucket) {
            // Size too large, allocate directly
            this.stats.misses++;
            return Buffer.allocUnsafe(size);
        }
        
        // Try to get from free pool
        if (bucket.free.length > 0) {
            const buffer = bucket.free.pop();
            bucket.active.add(buffer);
            bucket.stats.hits++;
            this.stats.hits++;
            this.stats.activeBuffers++;
            
            // Return a slice if requested size is smaller
            return size < bucketSize ? buffer.slice(0, size) : buffer;
        }
        
        // Allocate new buffer
        bucket.stats.misses++;
        this.stats.misses++;
        
        // Check memory limit
        if (this.stats.totalMemory + bucketSize <= this.config.maxTotalMemory) {
            const buffer = Buffer.allocUnsafe(bucketSize);
            bucket.active.add(buffer);
            bucket.stats.allocations++;
            this.stats.totalMemory += bucketSize;
            this.stats.activeBuffers++;
            
            // Return a slice if requested size is smaller
            return size < bucketSize ? buffer.slice(0, size) : buffer;
        }
        
        // Memory limit reached, allocate outside pool
        return Buffer.allocUnsafe(size);
    }
    
    /**
     * Allocate and copy data (for compatibility)
     */
    allocateFrom(data) {
        const buffer = this.allocate(data.length);
        data.copy(buffer);
        return buffer;
    }
    
    /**
     * Release buffer back to pool
     */
    release(buffer) {
        if (!Buffer.isBuffer(buffer)) return;
        
        this.stats.releases++;
        
        // Find the bucket this buffer belongs to
        const bucketSize = this.findBucketSize(buffer.length);
        const bucket = this.buckets.get(bucketSize);
        
        if (!bucket || !bucket.active.has(buffer)) {
            // Not from pool, let GC handle it
            return;
        }
        
        // Return to free pool
        bucket.active.delete(buffer);
        bucket.free.push(buffer);
        this.stats.activeBuffers--;
        
        // Clear sensitive data
        buffer.fill(0);
    }
    
    /**
     * Find appropriate bucket size (power of 2)
     */
    findBucketSize(size) {
        let bucketSize = this.config.minSize;
        
        while (bucketSize < size && bucketSize < this.config.maxSize) {
            bucketSize *= 2;
        }
        
        return bucketSize;
    }
    
    /**
     * Allocate multiple buffers efficiently
     */
    allocateBatch(sizes) {
        return sizes.map(size => this.allocate(size));
    }
    
    /**
     * Release multiple buffers
     */
    releaseBatch(buffers) {
        buffers.forEach(buffer => this.release(buffer));
    }
    
    /**
     * Create a scoped allocator that auto-releases
     */
    createScope() {
        const allocated = [];
        
        const scope = {
            allocate: (size) => {
                const buffer = this.allocate(size);
                allocated.push(buffer);
                return buffer;
            },
            
            allocateFrom: (data) => {
                const buffer = this.allocateFrom(data);
                allocated.push(buffer);
                return buffer;
            },
            
            release: () => {
                this.releaseBatch(allocated);
                allocated.length = 0;
            }
        };
        
        return scope;
    }
    
    /**
     * Garbage collection - trim excess buffers
     */
    gc() {
        let totalFreed = 0;
        
        for (const [size, bucket] of this.buckets) {
            const targetFree = Math.min(
                this.config.poolSizePerBucket,
                Math.ceil(bucket.stats.allocations * 0.1) // Keep 10% of peak
            );
            
            if (bucket.free.length > targetFree) {
                const toFree = bucket.free.length - targetFree;
                bucket.free.splice(0, toFree);
                totalFreed += toFree * size;
                this.stats.totalMemory -= toFree * size;
            }
        }
        
        if (totalFreed > 0) {
            this.emit('gc', { freedBytes: totalFreed });
        }
    }
    
    /**
     * Start periodic garbage collection
     */
    startGC() {
        this.gcInterval = setInterval(() => {
            this.gc();
        }, this.config.gcInterval);
    }
    
    /**
     * Stop garbage collection
     */
    stopGC() {
        if (this.gcInterval) {
            clearInterval(this.gcInterval);
            this.gcInterval = null;
        }
    }
    
    /**
     * Get pool statistics
     */
    getStats() {
        const bucketStats = {};
        
        for (const [size, bucket] of this.buckets) {
            bucketStats[size] = {
                free: bucket.free.length,
                active: bucket.active.size,
                ...bucket.stats
            };
        }
        
        return {
            ...this.stats,
            hitRate: this.stats.allocations > 0 
                ? this.stats.hits / this.stats.allocations 
                : 0,
            buckets: bucketStats
        };
    }
    
    /**
     * Clear all buffers
     */
    clear() {
        for (const bucket of this.buckets.values()) {
            bucket.free = [];
            bucket.active.clear();
        }
        
        this.stats.totalMemory = 0;
        this.stats.activeBuffers = 0;
    }
    
    /**
     * Shutdown pool
     */
    shutdown() {
        this.stopGC();
        this.clear();
        this.removeAllListeners();
    }
}

/**
 * Global buffer pool instance
 */
export const globalBufferPool = new BufferPool({
    minSize: 64,
    maxSize: 1048576,
    poolSizePerBucket: 100,
    maxTotalMemory: 100 * 1024 * 1024
});

/**
 * Ring buffer for zero-copy streaming
 */
export class RingBuffer {
    constructor(size = 65536) {
        this.buffer = Buffer.allocUnsafe(size);
        this.size = size;
        this.readPos = 0;
        this.writePos = 0;
        this.isFull = false;
    }
    
    /**
     * Write data to ring buffer (zero-copy)
     */
    write(data) {
        const dataLength = data.length;
        
        if (dataLength > this.available()) {
            return false; // Not enough space
        }
        
        if (this.writePos + dataLength <= this.size) {
            // Simple case: continuous write
            data.copy(this.buffer, this.writePos);
            this.writePos += dataLength;
        } else {
            // Wrap around
            const firstPart = this.size - this.writePos;
            data.copy(this.buffer, this.writePos, 0, firstPart);
            data.copy(this.buffer, 0, firstPart, dataLength);
            this.writePos = dataLength - firstPart;
        }
        
        if (this.writePos === this.readPos) {
            this.isFull = true;
        }
        
        return true;
    }
    
    /**
     * Read data from ring buffer (zero-copy)
     */
    read(length) {
        const available = this.used();
        
        if (length > available) {
            length = available;
        }
        
        if (length === 0) {
            return null;
        }
        
        let result;
        
        if (this.readPos + length <= this.size) {
            // Simple case: continuous read
            result = this.buffer.slice(this.readPos, this.readPos + length);
            this.readPos += length;
        } else {
            // Wrap around - need to copy :(
            result = Buffer.allocUnsafe(length);
            const firstPart = this.size - this.readPos;
            this.buffer.copy(result, 0, this.readPos, this.size);
            this.buffer.copy(result, firstPart, 0, length - firstPart);
            this.readPos = length - firstPart;
        }
        
        this.isFull = false;
        
        return result;
    }
    
    /**
     * Peek at data without consuming (zero-copy when possible)
     */
    peek(length) {
        const available = this.used();
        
        if (length > available) {
            length = available;
        }
        
        if (length === 0) {
            return null;
        }
        
        if (this.readPos + length <= this.size) {
            // Simple case: continuous peek
            return this.buffer.slice(this.readPos, this.readPos + length);
        } else {
            // Wrap around - need to copy
            const result = Buffer.allocUnsafe(length);
            const firstPart = this.size - this.readPos;
            this.buffer.copy(result, 0, this.readPos, this.size);
            this.buffer.copy(result, firstPart, 0, length - firstPart);
            return result;
        }
    }
    
    /**
     * Get available space
     */
    available() {
        if (this.isFull) return 0;
        if (this.writePos >= this.readPos) {
            return this.size - (this.writePos - this.readPos);
        }
        return this.readPos - this.writePos;
    }
    
    /**
     * Get used space
     */
    used() {
        if (this.isFull) return this.size;
        if (this.writePos >= this.readPos) {
            return this.writePos - this.readPos;
        }
        return this.size - (this.readPos - this.writePos);
    }
    
    /**
     * Clear buffer
     */
    clear() {
        this.readPos = 0;
        this.writePos = 0;
        this.isFull = false;
    }
}

export default BufferPool;