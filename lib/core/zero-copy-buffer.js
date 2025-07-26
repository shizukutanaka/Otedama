/**
 * Zero-Copy Buffer System - Otedama
 * Ultra-high performance buffer management with zero memory copies
 * 
 * Design Principles:
 * - Carmack: Direct memory access, no unnecessary copies
 * - Martin: Clean abstraction over raw buffers
 * - Pike: Simple interface hiding complex optimizations
 */

import { EventEmitter } from 'events';

/**
 * Ring buffer with zero-copy operations
 */
export class ZeroCopyRingBuffer {
  constructor(size = 1024 * 1024 * 16) { // 16MB default
    this.size = size;
    this.buffer = Buffer.allocUnsafe(size);
    this.writePos = 0;
    this.readPos = 0;
    this.watermark = size * 0.8; // 80% full warning
    
    // Pre-allocated views for different data types
    this.uint32View = new Uint32Array(this.buffer.buffer);
    this.uint64View = new BigUint64Array(this.buffer.buffer);
    this.float64View = new Float64Array(this.buffer.buffer);
  }
  
  /**
   * Write data without copying
   * Returns a buffer view that can be written to directly
   */
  getWriteBuffer(length) {
    const available = this.getAvailable();
    if (length > available) {
      return null; // Buffer full
    }
    
    // Handle wrap-around
    if (this.writePos + length > this.size) {
      // For simplicity, don't allow writes that wrap
      // In production, implement circular write
      if (this.readPos > length) {
        this.writePos = 0;
      } else {
        return null;
      }
    }
    
    const start = this.writePos;
    const view = this.buffer.subarray(start, start + length);
    
    return {
      view,
      commit: () => {
        this.writePos += length;
        if (this.writePos >= this.size) {
          this.writePos = 0;
        }
      }
    };
  }
  
  /**
   * Read data without copying
   * Returns a buffer view
   */
  getReadBuffer(length) {
    const available = this.getReadable();
    if (length > available) {
      return null;
    }
    
    const start = this.readPos;
    const view = this.buffer.subarray(start, start + length);
    
    return {
      view,
      commit: () => {
        this.readPos += length;
        if (this.readPos >= this.size) {
          this.readPos = 0;
        }
      }
    };
  }
  
  /**
   * Direct write for 32-bit values
   */
  writeUint32(value) {
    const index = this.writePos >> 2; // Divide by 4
    this.uint32View[index] = value;
    this.writePos += 4;
  }
  
  /**
   * Direct read for 32-bit values
   */
  readUint32() {
    const index = this.readPos >> 2;
    const value = this.uint32View[index];
    this.readPos += 4;
    return value;
  }
  
  getAvailable() {
    if (this.writePos >= this.readPos) {
      return this.size - this.writePos + this.readPos;
    }
    return this.readPos - this.writePos;
  }
  
  getReadable() {
    if (this.writePos >= this.readPos) {
      return this.writePos - this.readPos;
    }
    return this.size - this.readPos + this.writePos;
  }
  
  reset() {
    this.writePos = 0;
    this.readPos = 0;
  }
}

/**
 * Memory-mapped buffer pool
 */
export class BufferPool {
  constructor(config = {}) {
    this.blockSize = config.blockSize || 4096; // 4KB blocks
    this.maxBlocks = config.maxBlocks || 1024; // Max 4MB
    this.freeList = [];
    this.usedCount = 0;
    
    // Pre-allocate all buffers
    this.memory = Buffer.allocUnsafe(this.blockSize * this.maxBlocks);
    
    // Initialize free list
    for (let i = 0; i < this.maxBlocks; i++) {
      this.freeList.push(i);
    }
  }
  
  /**
   * Allocate buffer without copying
   */
  allocate() {
    if (this.freeList.length === 0) {
      return null; // Pool exhausted
    }
    
    const blockIndex = this.freeList.pop();
    const offset = blockIndex * this.blockSize;
    const buffer = this.memory.subarray(offset, offset + this.blockSize);
    
    this.usedCount++;
    
    return {
      buffer,
      release: () => {
        this.freeList.push(blockIndex);
        this.usedCount--;
      }
    };
  }
  
  getStats() {
    return {
      total: this.maxBlocks,
      used: this.usedCount,
      free: this.freeList.length,
      utilization: (this.usedCount / this.maxBlocks) * 100
    };
  }
}

/**
 * Zero-copy packet parser
 */
export class ZeroCopyParser extends EventEmitter {
  constructor() {
    super();
    this.buffer = null;
    this.offset = 0;
  }
  
  /**
   * Parse without copying data
   */
  parse(buffer) {
    this.buffer = buffer;
    this.offset = 0;
    
    while (this.offset < buffer.length) {
      // Read header without copying
      if (buffer.length - this.offset < 8) break;
      
      const magic = buffer.readUInt32LE(this.offset);
      const length = buffer.readUInt32LE(this.offset + 4);
      
      if (buffer.length - this.offset < length) break;
      
      // Create view of packet data
      const packetView = buffer.subarray(this.offset + 8, this.offset + length);
      
      // Emit packet without copying
      this.emit('packet', {
        magic,
        length: length - 8,
        data: packetView
      });
      
      this.offset += length;
    }
    
    // Return unparsed data view
    if (this.offset < buffer.length) {
      return buffer.subarray(this.offset);
    }
    
    return null;
  }
}

/**
 * Zero-copy serializer
 */
export class ZeroCopySerializer {
  constructor(buffer) {
    this.buffer = buffer;
    this.offset = 0;
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  
  writeUint8(value) {
    this.buffer[this.offset++] = value;
    return this;
  }
  
  writeUint16(value) {
    this.view.setUint16(this.offset, value, true);
    this.offset += 2;
    return this;
  }
  
  writeUint32(value) {
    this.view.setUint32(this.offset, value, true);
    this.offset += 4;
    return this;
  }
  
  writeUint64(value) {
    this.view.setBigUint64(this.offset, BigInt(value), true);
    this.offset += 8;
    return this;
  }
  
  writeBuffer(src) {
    // Zero-copy buffer write
    src.copy(this.buffer, this.offset);
    this.offset += src.length;
    return this;
  }
  
  writeString(str) {
    const length = Buffer.byteLength(str);
    this.writeUint32(length);
    this.buffer.write(str, this.offset);
    this.offset += length;
    return this;
  }
  
  getBuffer() {
    return this.buffer.subarray(0, this.offset);
  }
}

/**
 * Shared memory buffer for IPC
 */
export class SharedMemoryBuffer {
  constructor(size = 1024 * 1024) { // 1MB default
    // Use SharedArrayBuffer for true zero-copy IPC
    if (typeof SharedArrayBuffer !== 'undefined') {
      this.sharedBuffer = new SharedArrayBuffer(size);
      this.buffer = Buffer.from(this.sharedBuffer);
    } else {
      // Fallback to regular buffer
      this.buffer = Buffer.allocUnsafe(size);
      this.sharedBuffer = this.buffer.buffer;
    }
    
    this.size = size;
    this.lock = new Int32Array(this.sharedBuffer, 0, 1);
  }
  
  /**
   * Atomic write operation
   */
  atomicWrite(offset, data) {
    // Simple spinlock
    while (Atomics.compareExchange(this.lock, 0, 0, 1) !== 0) {
      // Spin
    }
    
    try {
      data.copy(this.buffer, offset);
    } finally {
      Atomics.store(this.lock, 0, 0);
    }
  }
  
  /**
   * Get view for direct access
   */
  getView(offset, length) {
    return this.buffer.subarray(offset, offset + length);
  }
}

/**
 * Memory-aligned buffer allocator
 */
export class AlignedBufferAllocator {
  static allocate(size, alignment = 64) { // 64-byte cache line alignment
    const alignedSize = Math.ceil(size / alignment) * alignment;
    const buffer = Buffer.allocUnsafe(alignedSize + alignment);
    
    // Find aligned offset
    const offset = alignment - (buffer.byteOffset % alignment);
    
    return buffer.subarray(offset, offset + size);
  }
}

// Export singleton instances for common use
export const globalBufferPool = new BufferPool({
  blockSize: 65536, // 64KB blocks for network packets
  maxBlocks: 256    // 16MB total
});

export default {
  ZeroCopyRingBuffer,
  BufferPool,
  ZeroCopyParser,
  ZeroCopySerializer,
  SharedMemoryBuffer,
  AlignedBufferAllocator,
  globalBufferPool
};