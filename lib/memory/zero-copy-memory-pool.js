const { Worker } = require('worker_threads');

class ZeroCopyMemoryPool {
    constructor(options = {}) {
        this.config = {
            poolSize: options.poolSize || 1024 * 1024 * 128, // 128MB
            chunkSize: options.chunkSize || 4096,
            maxChunks: options.maxChunks || 32768,
            enableSharedMemory: options.enableSharedMemory !== false,
            gcInterval: options.gcInterval || 60000,
            ...options
        };
        
        // Memory allocation tracking
        this.allocations = new Map();
        this.freeList = [];
        this.usedMemory = 0;
        this.peakMemory = 0;
        
        // Shared memory buffers for workers
        this.sharedBuffers = new Map();
        
        // Statistics
        this.stats = {
            allocations: 0,
            deallocations: 0,
            hits: 0,
            misses: 0,
            fragmentation: 0,
            gcRuns: 0
        };
        
        this.initialize();
    }

    initialize() {
        if (typeof SharedArrayBuffer !== 'undefined' && this.config.enableSharedMemory) {
            // Allocate shared memory buffer
            this.sharedBuffer = new SharedArrayBuffer(this.config.poolSize);
            this.memory = new Uint8Array(this.sharedBuffer);
        } else {
            // Fallback to regular ArrayBuffer
            this.buffer = new ArrayBuffer(this.config.poolSize);
            this.memory = new Uint8Array(this.buffer);
        }
        
        // Initialize free list with all chunks
        const numChunks = Math.floor(this.config.poolSize / this.config.chunkSize);
        for (let i = 0; i < numChunks; i++) {
            this.freeList.push({
                offset: i * this.config.chunkSize,
                size: this.config.chunkSize
            });
        }
        
        // Start garbage collection
        this.startGarbageCollection();
    }

    allocate(size, alignment = 8) {
        const alignedSize = this.alignSize(size, alignment);
        
        // Try to find a suitable chunk from free list
        let bestFit = null;
        let bestFitIndex = -1;
        
        for (let i = 0; i < this.freeList.length; i++) {
            const chunk = this.freeList[i];
            if (chunk.size >= alignedSize) {
                if (!bestFit || chunk.size < bestFit.size) {
                    bestFit = chunk;
                    bestFitIndex = i;
                    
                    // Perfect fit
                    if (chunk.size === alignedSize) break;
                }
            }
        }
        
        if (!bestFit) {
            this.stats.misses++;
            return this.allocateLarge(alignedSize);
        }
        
        this.stats.hits++;
        
        // Remove from free list
        this.freeList.splice(bestFitIndex, 1);
        
        // Split chunk if necessary
        if (bestFit.size > alignedSize) {
            const remaining = {
                offset: bestFit.offset + alignedSize,
                size: bestFit.size - alignedSize
            };
            this.insertIntoFreeList(remaining);
        }
        
        // Create allocation
        const allocation = {
            id: this.generateId(),
            offset: bestFit.offset,
            size: alignedSize,
            allocated: Date.now(),
            references: 1
        };
        
        this.allocations.set(allocation.id, allocation);
        this.usedMemory += alignedSize;
        this.peakMemory = Math.max(this.peakMemory, this.usedMemory);
        this.stats.allocations++;
        
        // Return view into memory
        return {
            id: allocation.id,
            buffer: this.memory.subarray(allocation.offset, allocation.offset + alignedSize),
            offset: allocation.offset,
            size: alignedSize
        };
    }

    allocateLarge(size) {
        // For large allocations, use separate buffer
        const buffer = new ArrayBuffer(size);
        const view = new Uint8Array(buffer);
        
        const allocation = {
            id: this.generateId(),
            buffer: buffer,
            size: size,
            allocated: Date.now(),
            references: 1,
            external: true
        };
        
        this.allocations.set(allocation.id, allocation);
        this.stats.allocations++;
        
        return {
            id: allocation.id,
            buffer: view,
            size: size,
            external: true
        };
    }

    deallocate(allocationId) {
        const allocation = this.allocations.get(allocationId);
        if (!allocation) return false;
        
        allocation.references--;
        
        if (allocation.references > 0) return true;
        
        this.allocations.delete(allocationId);
        this.stats.deallocations++;
        
        if (allocation.external) {
            // External allocation - just remove reference
            return true;
        }
        
        // Return chunk to free list
        this.usedMemory -= allocation.size;
        
        const chunk = {
            offset: allocation.offset,
            size: allocation.size
        };
        
        this.insertIntoFreeList(chunk);
        this.coalesceAdjacentChunks();
        
        return true;
    }

    insertIntoFreeList(chunk) {
        // Insert in sorted order by offset
        let insertIndex = 0;
        for (let i = 0; i < this.freeList.length; i++) {
            if (this.freeList[i].offset > chunk.offset) {
                insertIndex = i;
                break;
            }
            insertIndex = i + 1;
        }
        
        this.freeList.splice(insertIndex, 0, chunk);
    }

    coalesceAdjacentChunks() {
        if (this.freeList.length < 2) return;
        
        let i = 0;
        while (i < this.freeList.length - 1) {
            const current = this.freeList[i];
            const next = this.freeList[i + 1];
            
            if (current.offset + current.size === next.offset) {
                // Merge chunks
                current.size += next.size;
                this.freeList.splice(i + 1, 1);
            } else {
                i++;
            }
        }
    }

    createSharedView(size, workerId) {
        if (!this.sharedBuffer) {
            throw new Error('Shared memory not available');
        }
        
        const allocation = this.allocate(size);
        if (!allocation) return null;
        
        // Track shared allocation
        if (!this.sharedBuffers.has(workerId)) {
            this.sharedBuffers.set(workerId, []);
        }
        
        this.sharedBuffers.get(workerId).push(allocation.id);
        
        return {
            buffer: this.sharedBuffer,
            offset: allocation.offset,
            size: allocation.size,
            id: allocation.id
        };
    }

    releaseSharedView(allocationId, workerId) {
        const workerBuffers = this.sharedBuffers.get(workerId);
        if (workerBuffers) {
            const index = workerBuffers.indexOf(allocationId);
            if (index !== -1) {
                workerBuffers.splice(index, 1);
            }
        }
        
        return this.deallocate(allocationId);
    }

    copy(source, destination, length) {
        // Zero-copy operation when possible
        if (source.buffer === this.memory.buffer && 
            destination.buffer === this.memory.buffer) {
            // Both in same memory pool - use copyWithin
            this.memory.copyWithin(
                destination.byteOffset,
                source.byteOffset,
                source.byteOffset + length
            );
            return true;
        }
        
        // Fall back to regular copy
        destination.set(source.subarray(0, length));
        return true;
    }

    swap(allocation1, allocation2) {
        const alloc1 = this.allocations.get(allocation1);
        const alloc2 = this.allocations.get(allocation2);
        
        if (!alloc1 || !alloc2 || alloc1.external || alloc2.external) {
            return false;
        }
        
        // Swap metadata
        const tempOffset = alloc1.offset;
        alloc1.offset = alloc2.offset;
        alloc2.offset = tempOffset;
        
        return true;
    }

    resize(allocationId, newSize) {
        const allocation = this.allocations.get(allocationId);
        if (!allocation || allocation.external) return null;
        
        const alignedSize = this.alignSize(newSize, 8);
        
        if (alignedSize <= allocation.size) {
            // Shrink allocation
            const freedSize = allocation.size - alignedSize;
            allocation.size = alignedSize;
            this.usedMemory -= freedSize;
            
            // Return freed space to pool
            if (freedSize >= this.config.chunkSize) {
                const freedChunk = {
                    offset: allocation.offset + alignedSize,
                    size: freedSize
                };
                this.insertIntoFreeList(freedChunk);
                this.coalesceAdjacentChunks();
            }
            
            return {
                id: allocation.id,
                buffer: this.memory.subarray(allocation.offset, allocation.offset + alignedSize),
                offset: allocation.offset,
                size: alignedSize
            };
        }
        
        // Need to grow - check if adjacent space is free
        const nextOffset = allocation.offset + allocation.size;
        const additionalSize = alignedSize - allocation.size;
        
        for (let i = 0; i < this.freeList.length; i++) {
            const chunk = this.freeList[i];
            if (chunk.offset === nextOffset && chunk.size >= additionalSize) {
                // Can grow in place
                allocation.size = alignedSize;
                this.usedMemory += additionalSize;
                
                if (chunk.size === additionalSize) {
                    this.freeList.splice(i, 1);
                } else {
                    chunk.offset += additionalSize;
                    chunk.size -= additionalSize;
                }
                
                return {
                    id: allocation.id,
                    buffer: this.memory.subarray(allocation.offset, allocation.offset + alignedSize),
                    offset: allocation.offset,
                    size: alignedSize
                };
            }
        }
        
        // Cannot grow in place - need to relocate
        const newAllocation = this.allocate(newSize);
        if (!newAllocation) return null;
        
        // Copy data
        const oldView = this.memory.subarray(allocation.offset, allocation.offset + allocation.size);
        newAllocation.buffer.set(oldView);
        
        // Free old allocation
        this.deallocate(allocationId);
        
        return newAllocation;
    }

    defragment() {
        const sortedAllocations = Array.from(this.allocations.values())
            .filter(a => !a.external)
            .sort((a, b) => a.offset - b.offset);
        
        let currentOffset = 0;
        const moves = [];
        
        for (const allocation of sortedAllocations) {
            if (allocation.offset !== currentOffset) {
                moves.push({
                    allocation,
                    from: allocation.offset,
                    to: currentOffset
                });
                allocation.offset = currentOffset;
            }
            currentOffset += allocation.size;
        }
        
        // Perform moves
        for (const move of moves) {
            this.memory.copyWithin(
                move.to,
                move.from,
                move.from + move.allocation.size
            );
        }
        
        // Rebuild free list
        this.freeList = [];
        if (currentOffset < this.config.poolSize) {
            this.freeList.push({
                offset: currentOffset,
                size: this.config.poolSize - currentOffset
            });
        }
        
        this.stats.fragmentation = this.calculateFragmentation();
        
        return moves.length;
    }

    calculateFragmentation() {
        if (this.freeList.length === 0) return 0;
        if (this.freeList.length === 1) return 0;
        
        const totalFree = this.freeList.reduce((sum, chunk) => sum + chunk.size, 0);
        const largestFree = Math.max(...this.freeList.map(chunk => chunk.size));
        
        return 1 - (largestFree / totalFree);
    }

    startGarbageCollection() {
        this.gcInterval = setInterval(() => {
            this.runGarbageCollection();
        }, this.config.gcInterval);
    }

    runGarbageCollection() {
        const now = Date.now();
        const staleThreshold = now - this.config.gcInterval;
        
        // Find stale allocations
        const staleAllocations = [];
        for (const [id, allocation] of this.allocations) {
            if (allocation.allocated < staleThreshold && allocation.references === 0) {
                staleAllocations.push(id);
            }
        }
        
        // Free stale allocations
        for (const id of staleAllocations) {
            this.deallocate(id);
        }
        
        // Defragment if needed
        this.stats.fragmentation = this.calculateFragmentation();
        if (this.stats.fragmentation > 0.5) {
            this.defragment();
        }
        
        this.stats.gcRuns++;
    }

    alignSize(size, alignment) {
        return Math.ceil(size / alignment) * alignment;
    }

    generateId() {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    getStats() {
        return {
            ...this.stats,
            usedMemory: this.usedMemory,
            freeMemory: this.config.poolSize - this.usedMemory,
            peakMemory: this.peakMemory,
            utilization: (this.usedMemory / this.config.poolSize) * 100,
            allocations: this.allocations.size,
            freeChunks: this.freeList.length,
            fragmentation: this.calculateFragmentation()
        };
    }

    reset() {
        this.allocations.clear();
        this.freeList = [];
        this.usedMemory = 0;
        
        // Reinitialize free list
        const numChunks = Math.floor(this.config.poolSize / this.config.chunkSize);
        for (let i = 0; i < numChunks; i++) {
            this.freeList.push({
                offset: i * this.config.chunkSize,
                size: this.config.chunkSize
            });
        }
    }

    destroy() {
        if (this.gcInterval) {
            clearInterval(this.gcInterval);
        }
        
        this.allocations.clear();
        this.freeList = [];
        this.sharedBuffers.clear();
        this.memory = null;
        this.buffer = null;
        this.sharedBuffer = null;
    }
}

module.exports = ZeroCopyMemoryPool;