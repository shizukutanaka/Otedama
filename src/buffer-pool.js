// ==================== Buffer Pool ====================
export class BufferPool {
  constructor(initialSize = 50, bufferSize = 4096) {
    this.buffers = [];
    this.bufferSize = bufferSize;
    this.maxSize = 200;
    this.minSize = 20;
    this.stats = { acquired: 0, released: 0, created: 0 };
    
    // Pre-allocate initial buffers
    for (let i = 0; i < initialSize; i++) {
      this.buffers.push(Buffer.allocUnsafe(bufferSize));
    }
    
    // Dynamic size adjustment
    this.adjustInterval = setInterval(() => this.adjustSize(), 30000);
  }

  acquire() {
    this.stats.acquired++;
    const buffer = this.buffers.pop();
    if (buffer) return buffer;
    
    this.stats.created++;
    return Buffer.allocUnsafe(this.bufferSize);
  }

  release(buffer) {
    if (!buffer || buffer.length !== this.bufferSize) return;
    
    this.stats.released++;
    if (this.buffers.length < this.maxSize) {
      buffer.fill(0); // Clear sensitive data
      this.buffers.push(buffer);
    }
  }
  
  adjustSize() {
    const usage = this.stats.acquired - this.stats.released;
    const currentSize = this.buffers.length;
    
    if (usage > currentSize * 0.8 && currentSize < this.maxSize) {
      // Grow pool
      const growBy = Math.min(10, this.maxSize - currentSize);
      for (let i = 0; i < growBy; i++) {
        this.buffers.push(Buffer.allocUnsafe(this.bufferSize));
      }
    } else if (usage < currentSize * 0.2 && currentSize > this.minSize) {
      // Shrink pool
      const shrinkBy = Math.min(10, currentSize - this.minSize);
      this.buffers.splice(0, shrinkBy);
    }
    
    // Reset stats
    this.stats = { acquired: 0, released: 0, created: 0 };
  }

  destroy() {
    clearInterval(this.adjustInterval);
    this.buffers = [];
  }
}

export const globalBufferPool = new BufferPool();
