/**
 * Atomic Buffer Implementation
 * Provides atomic operations on shared memory buffers
 * Uses SharedArrayBuffer and Atomics for true lock-free operations
 */

/**
 * Atomic buffer wrapper for concurrent access
 */
export class AtomicBuffer {
  constructor(size, options = {}) {
    this.size = size;
    this.options = {
      useSharedMemory: options.useSharedMemory !== false,
      alignment: options.alignment || 8, // 64-bit alignment
      ...options
    };
    
    // Use SharedArrayBuffer if available and requested
    if (this.options.useSharedMemory && typeof SharedArrayBuffer !== 'undefined') {
      this.buffer = new SharedArrayBuffer(size);
      this.isShared = true;
    } else {
      this.buffer = new ArrayBuffer(size);
      this.isShared = false;
    }
    
    // Create typed array views
    this.int32View = new Int32Array(this.buffer);
    this.uint32View = new Uint32Array(this.buffer);
    this.float64View = new Float64Array(this.buffer);
    
    // Allocation state
    this.allocated = 0;
  }
  
  /**
   * Atomic compare and swap for 32-bit integers
   */
  compareAndSwapInt32(offset, expected, replacement) {
    if (this.isShared) {
      return Atomics.compareExchange(this.int32View, offset / 4, expected, replacement);
    } else {
      // Fallback for non-shared memory
      const current = this.int32View[offset / 4];
      if (current === expected) {
        this.int32View[offset / 4] = replacement;
        return expected;
      }
      return current;
    }
  }
  
  /**
   * Atomic add for 32-bit integers
   */
  addInt32(offset, value) {
    if (this.isShared) {
      return Atomics.add(this.int32View, offset / 4, value);
    } else {
      const index = offset / 4;
      const old = this.int32View[index];
      this.int32View[index] += value;
      return old;
    }
  }
  
  /**
   * Atomic load for 32-bit integers
   */
  loadInt32(offset) {
    if (this.isShared) {
      return Atomics.load(this.int32View, offset / 4);
    } else {
      return this.int32View[offset / 4];
    }
  }
  
  /**
   * Atomic store for 32-bit integers
   */
  storeInt32(offset, value) {
    if (this.isShared) {
      return Atomics.store(this.int32View, offset / 4, value);
    } else {
      this.int32View[offset / 4] = value;
      return value;
    }
  }
  
  /**
   * Atomic compare and swap for 64-bit floats
   * Note: JavaScript doesn't have native 64-bit atomic operations
   * This uses a lock-based approach for floats
   */
  compareAndSwapFloat64(offset, expected, replacement) {
    const index = offset / 8;
    const lockOffset = this.getLockOffset(offset);
    
    // Acquire lock
    while (!this.tryAcquireLock(lockOffset)) {
      // Spin
    }
    
    try {
      const current = this.float64View[index];
      if (Math.abs(current - expected) < Number.EPSILON) {
        this.float64View[index] = replacement;
        return expected;
      }
      return current;
    } finally {
      this.releaseLock(lockOffset);
    }
  }
  
  /**
   * Allocate aligned memory region
   */
  allocate(size) {
    const alignedSize = this.alignSize(size);
    
    if (this.isShared) {
      // Atomic allocation
      let oldAllocated;
      let newAllocated;
      
      do {
        oldAllocated = Atomics.load(this.int32View, 0);
        newAllocated = oldAllocated + alignedSize;
        
        if (newAllocated > this.size) {
          return null; // Out of memory
        }
      } while (Atomics.compareExchange(this.int32View, 0, oldAllocated, newAllocated) !== oldAllocated);
      
      return oldAllocated;
    } else {
      // Non-atomic allocation
      const offset = this.allocated;
      this.allocated += alignedSize;
      
      if (this.allocated > this.size) {
        this.allocated = offset;
        return null;
      }
      
      return offset;
    }
  }
  
  /**
   * Get lock offset for a memory location
   */
  getLockOffset(dataOffset) {
    // Reserve first 1KB for locks
    const lockIndex = (dataOffset / this.options.alignment) % 256;
    return lockIndex * 4;
  }
  
  /**
   * Try to acquire lock
   */
  tryAcquireLock(lockOffset) {
    if (this.isShared) {
      return Atomics.compareExchange(this.int32View, lockOffset / 4, 0, 1) === 0;
    } else {
      const index = lockOffset / 4;
      if (this.int32View[index] === 0) {
        this.int32View[index] = 1;
        return true;
      }
      return false;
    }
  }
  
  /**
   * Release lock
   */
  releaseLock(lockOffset) {
    if (this.isShared) {
      Atomics.store(this.int32View, lockOffset / 4, 0);
      Atomics.notify(this.int32View, lockOffset / 4, 1);
    } else {
      this.int32View[lockOffset / 4] = 0;
    }
  }
  
  /**
   * Wait for value change
   */
  wait(offset, expectedValue, timeout) {
    if (this.isShared) {
      return Atomics.wait(this.int32View, offset / 4, expectedValue, timeout);
    } else {
      // Fallback polling for non-shared memory
      const startTime = Date.now();
      while (this.int32View[offset / 4] === expectedValue) {
        if (timeout && Date.now() - startTime > timeout) {
          return 'timed-out';
        }
      }
      return 'ok';
    }
  }
  
  /**
   * Notify waiting threads
   */
  notify(offset, count = 1) {
    if (this.isShared) {
      return Atomics.notify(this.int32View, offset / 4, count);
    }
    return 0;
  }
  
  /**
   * Align size to boundary
   */
  alignSize(size) {
    const alignment = this.options.alignment;
    return Math.ceil(size / alignment) * alignment;
  }
  
  /**
   * Create a view of the buffer
   */
  createView(offset, length, type = 'uint8') {
    const TypedArray = {
      'int8': Int8Array,
      'uint8': Uint8Array,
      'int16': Int16Array,
      'uint16': Uint16Array,
      'int32': Int32Array,
      'uint32': Uint32Array,
      'float32': Float32Array,
      'float64': Float64Array
    }[type];
    
    if (!TypedArray) {
      throw new Error(`Unknown type: ${type}`);
    }
    
    return new TypedArray(this.buffer, offset, length);
  }
  
  /**
   * Memory fence (full barrier)
   */
  fence() {
    if (this.isShared) {
      // Atomics operations act as memory fences
      Atomics.load(this.int32View, 0);
    }
  }
  
  /**
   * Get buffer statistics
   */
  getStats() {
    return {
      size: this.size,
      allocated: this.isShared ? Atomics.load(this.int32View, 0) : this.allocated,
      utilization: this.allocated / this.size,
      isShared: this.isShared,
      alignment: this.options.alignment
    };
  }
}

/**
 * Atomic ring buffer for lock-free queues
 */
export class AtomicRingBuffer {
  constructor(capacity, itemSize) {
    this.capacity = capacity;
    this.itemSize = itemSize;
    
    // Allocate buffer with extra space for metadata
    const metadataSize = 16; // head, tail, size
    const dataSize = capacity * itemSize;
    
    this.buffer = new AtomicBuffer(metadataSize + dataSize, {
      useSharedMemory: true
    });
    
    // Metadata offsets
    this.HEAD_OFFSET = 0;
    this.TAIL_OFFSET = 4;
    this.SIZE_OFFSET = 8;
    this.DATA_OFFSET = metadataSize;
    
    // Initialize
    this.buffer.storeInt32(this.HEAD_OFFSET, 0);
    this.buffer.storeInt32(this.TAIL_OFFSET, 0);
    this.buffer.storeInt32(this.SIZE_OFFSET, 0);
  }
  
  /**
   * Enqueue item (lock-free)
   */
  enqueue(data) {
    let tail, newTail, size;
    
    do {
      tail = this.buffer.loadInt32(this.TAIL_OFFSET);
      size = this.buffer.loadInt32(this.SIZE_OFFSET);
      
      if (size >= this.capacity) {
        return false; // Queue full
      }
      
      newTail = (tail + 1) % this.capacity;
    } while (this.buffer.compareAndSwapInt32(this.TAIL_OFFSET, tail, newTail) !== tail);
    
    // Write data
    const offset = this.DATA_OFFSET + tail * this.itemSize;
    const view = this.buffer.createView(offset, this.itemSize);
    view.set(data);
    
    // Increment size
    this.buffer.addInt32(this.SIZE_OFFSET, 1);
    
    return true;
  }
  
  /**
   * Dequeue item (lock-free)
   */
  dequeue() {
    let head, newHead, size;
    
    do {
      head = this.buffer.loadInt32(this.HEAD_OFFSET);
      size = this.buffer.loadInt32(this.SIZE_OFFSET);
      
      if (size === 0) {
        return null; // Queue empty
      }
      
      newHead = (head + 1) % this.capacity;
    } while (this.buffer.compareAndSwapInt32(this.HEAD_OFFSET, head, newHead) !== head);
    
    // Read data
    const offset = this.DATA_OFFSET + head * this.itemSize;
    const view = this.buffer.createView(offset, this.itemSize);
    const data = new Uint8Array(this.itemSize);
    data.set(view);
    
    // Decrement size
    this.buffer.addInt32(this.SIZE_OFFSET, -1);
    
    return data;
  }
  
  /**
   * Get current size
   */
  size() {
    return this.buffer.loadInt32(this.SIZE_OFFSET);
  }
  
  /**
   * Check if empty
   */
  isEmpty() {
    return this.size() === 0;
  }
  
  /**
   * Check if full
   */
  isFull() {
    return this.size() >= this.capacity;
  }
}

/**
 * Atomic counter for statistics
 */
export class AtomicCounter {
  constructor(initialValue = 0) {
    this.buffer = new AtomicBuffer(8, { useSharedMemory: true });
    this.buffer.storeInt32(0, initialValue);
  }
  
  increment() {
    return this.buffer.addInt32(0, 1);
  }
  
  decrement() {
    return this.buffer.addInt32(0, -1);
  }
  
  get() {
    return this.buffer.loadInt32(0);
  }
  
  set(value) {
    return this.buffer.storeInt32(0, value);
  }
  
  compareAndSwap(expected, newValue) {
    return this.buffer.compareAndSwapInt32(0, expected, newValue);
  }
}

export default AtomicBuffer;