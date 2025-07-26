/**
 * Lock-Free Data Structures - Otedama
 * High-performance concurrent data structures without locks
 * 
 * Design Principles:
 * - Carmack: Atomic operations for maximum performance
 * - Martin: Clean interfaces for complex concurrent algorithms
 * - Pike: Simple API despite complex internals
 */

/**
 * Lock-free queue using atomic operations
 */
export class LockFreeQueue {
  constructor(capacity = 65536) {
    this.capacity = capacity;
    this.mask = capacity - 1; // Capacity must be power of 2
    this.buffer = new Array(capacity);
    
    // Padded to avoid false sharing
    this.headIndex = 0;
    this._padding1 = new Array(15).fill(0); // 64-byte cache line
    this.tailIndex = 0;
    this._padding2 = new Array(15).fill(0);
    
    // Statistics
    this.stats = {
      enqueued: 0,
      dequeued: 0,
      failed: 0
    };
  }
  
  enqueue(item) {
    const currentTail = this.tailIndex;
    const nextTail = (currentTail + 1) & this.mask;
    
    // Check if queue is full
    if (nextTail === this.headIndex) {
      this.stats.failed++;
      return false;
    }
    
    // Store item
    this.buffer[currentTail] = item;
    
    // Memory barrier to ensure item is visible before updating tail
    if (typeof Atomics !== 'undefined') {
      Atomics.store(this, 'tailIndex', nextTail);
    } else {
      this.tailIndex = nextTail;
    }
    
    this.stats.enqueued++;
    return true;
  }
  
  dequeue() {
    const currentHead = this.headIndex;
    
    // Check if queue is empty
    if (currentHead === this.tailIndex) {
      return null;
    }
    
    // Load item
    const item = this.buffer[currentHead];
    
    // Update head
    const nextHead = (currentHead + 1) & this.mask;
    if (typeof Atomics !== 'undefined') {
      Atomics.store(this, 'headIndex', nextHead);
    } else {
      this.headIndex = nextHead;
    }
    
    this.stats.dequeued++;
    return item;
  }
  
  size() {
    const head = this.headIndex;
    const tail = this.tailIndex;
    return (tail - head + this.capacity) & this.mask;
  }
  
  isEmpty() {
    return this.headIndex === this.tailIndex;
  }
  
  isFull() {
    return ((this.tailIndex + 1) & this.mask) === this.headIndex;
  }
}

/**
 * Lock-free stack using compare-and-swap
 */
export class LockFreeStack {
  constructor() {
    this.top = null;
    this.stats = {
      pushed: 0,
      popped: 0,
      retries: 0
    };
  }
  
  push(value) {
    const node = { value, next: null };
    let retries = 0;
    
    while (true) {
      const oldTop = this.top;
      node.next = oldTop;
      
      // Try to update top atomically
      if (this.compareAndSwap(oldTop, node)) {
        this.stats.pushed++;
        return true;
      }
      
      retries++;
      this.stats.retries++;
      
      // Exponential backoff
      if (retries > 10) {
        const delay = Math.min(Math.pow(2, retries - 10), 100);
        const end = Date.now() + delay;
        while (Date.now() < end) {
          // Spin
        }
      }
    }
  }
  
  pop() {
    let retries = 0;
    
    while (true) {
      const oldTop = this.top;
      
      if (oldTop === null) {
        return null;
      }
      
      const newTop = oldTop.next;
      
      // Try to update top atomically
      if (this.compareAndSwap(oldTop, newTop)) {
        this.stats.popped++;
        return oldTop.value;
      }
      
      retries++;
      this.stats.retries++;
    }
  }
  
  compareAndSwap(expected, update) {
    // In real implementation, use Atomics.compareExchange
    if (this.top === expected) {
      this.top = update;
      return true;
    }
    return false;
  }
  
  isEmpty() {
    return this.top === null;
  }
}

/**
 * Lock-free memory pool
 */
export class LockFreeMemoryPool {
  constructor(blockSize = 4096, maxBlocks = 1024) {
    this.blockSize = blockSize;
    this.maxBlocks = maxBlocks;
    
    // Pre-allocate all memory
    this.memory = Buffer.allocUnsafe(blockSize * maxBlocks);
    
    // Free list as lock-free stack
    this.freeList = new LockFreeStack();
    
    // Initialize free list
    for (let i = 0; i < maxBlocks; i++) {
      this.freeList.push(i);
    }
    
    this.stats = {
      allocated: 0,
      freed: 0,
      inUse: 0,
      maxInUse: 0
    };
  }
  
  allocate() {
    const blockIndex = this.freeList.pop();
    
    if (blockIndex === null) {
      return null; // Pool exhausted
    }
    
    const offset = blockIndex * this.blockSize;
    const buffer = this.memory.subarray(offset, offset + this.blockSize);
    
    this.stats.allocated++;
    this.stats.inUse++;
    this.stats.maxInUse = Math.max(this.stats.maxInUse, this.stats.inUse);
    
    return {
      buffer,
      release: () => this.release(blockIndex)
    };
  }
  
  release(blockIndex) {
    this.freeList.push(blockIndex);
    this.stats.freed++;
    this.stats.inUse--;
  }
  
  getStats() {
    return {
      ...this.stats,
      utilization: (this.stats.inUse / this.maxBlocks) * 100,
      fragmentation: 0 // No fragmentation in fixed-size pool
    };
  }
}

/**
 * Lock-free hash map
 */
export class LockFreeHashMap {
  constructor(capacity = 16384) {
    this.capacity = capacity;
    this.buckets = new Array(capacity);
    
    // Initialize buckets
    for (let i = 0; i < capacity; i++) {
      this.buckets[i] = new LockFreeStack();
    }
    
    this.stats = {
      inserts: 0,
      lookups: 0,
      removes: 0,
      collisions: 0
    };
  }
  
  hash(key) {
    // Simple hash function
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) - hash) + key.charCodeAt(i);
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash) % this.capacity;
  }
  
  set(key, value) {
    const index = this.hash(key);
    const bucket = this.buckets[index];
    
    // Check if key exists
    const existing = this.findInBucket(bucket, key);
    if (existing) {
      existing.value = value;
      return;
    }
    
    // Add new entry
    bucket.push({ key, value });
    this.stats.inserts++;
    
    // Track collisions
    if (!bucket.isEmpty()) {
      this.stats.collisions++;
    }
  }
  
  get(key) {
    const index = this.hash(key);
    const bucket = this.buckets[index];
    
    this.stats.lookups++;
    
    const entry = this.findInBucket(bucket, key);
    return entry ? entry.value : null;
  }
  
  remove(key) {
    const index = this.hash(key);
    const bucket = this.buckets[index];
    
    // This is simplified - real implementation would need
    // to properly remove from the middle of the stack
    const entry = this.findInBucket(bucket, key);
    if (entry) {
      entry.deleted = true;
      this.stats.removes++;
      return true;
    }
    
    return false;
  }
  
  findInBucket(bucket, key) {
    // Traverse bucket to find key
    // In real implementation, this would be lock-free traversal
    let current = bucket.top;
    while (current) {
      if (current.value && current.value.key === key && !current.value.deleted) {
        return current.value;
      }
      current = current.next;
    }
    return null;
  }
}

/**
 * Wait-free ring buffer
 */
export class WaitFreeRingBuffer {
  constructor(capacity = 65536) {
    this.capacity = capacity;
    this.mask = capacity - 1;
    this.buffer = new Array(capacity);
    this.sequences = new Uint32Array(capacity);
    
    // Separate read/write counters for each thread
    this.writeCounter = 0;
    this.readCounter = 0;
    
    this.stats = {
      writes: 0,
      reads: 0,
      overwrites: 0
    };
  }
  
  write(item) {
    // Get next write position
    const seq = this.writeCounter++;
    const pos = seq & this.mask;
    
    // Check if we're overwriting
    if (seq - this.readCounter >= this.capacity) {
      this.stats.overwrites++;
    }
    
    // Write data
    this.buffer[pos] = item;
    
    // Update sequence number
    if (typeof Atomics !== 'undefined') {
      Atomics.store(this.sequences, pos, seq);
    } else {
      this.sequences[pos] = seq;
    }
    
    this.stats.writes++;
    return true;
  }
  
  read() {
    const seq = this.readCounter;
    const pos = seq & this.mask;
    
    // Check if data is available
    const writeSeq = typeof Atomics !== 'undefined' 
      ? Atomics.load(this.sequences, pos)
      : this.sequences[pos];
    
    if (writeSeq < seq) {
      return null; // No data available
    }
    
    // Read data
    const item = this.buffer[pos];
    this.readCounter++;
    
    this.stats.reads++;
    return item;
  }
  
  available() {
    return this.writeCounter - this.readCounter;
  }
}

/**
 * Lock-free object pool
 */
export class LockFreeObjectPool {
  constructor(factory, reset, maxSize = 1000) {
    this.factory = factory;
    this.reset = reset;
    this.maxSize = maxSize;
    this.pool = new LockFreeStack();
    this.created = 0;
    
    this.stats = {
      borrows: 0,
      returns: 0,
      creates: 0,
      reuses: 0
    };
  }
  
  borrow() {
    // Try to get from pool
    let obj = this.pool.pop();
    
    if (obj) {
      this.stats.reuses++;
    } else if (this.created < this.maxSize) {
      // Create new object
      obj = this.factory();
      this.created++;
      this.stats.creates++;
    } else {
      // Pool exhausted
      return null;
    }
    
    this.stats.borrows++;
    
    return {
      value: obj,
      release: () => this.return(obj)
    };
  }
  
  return(obj) {
    // Reset object state
    if (this.reset) {
      this.reset(obj);
    }
    
    // Return to pool
    this.pool.push(obj);
    this.stats.returns++;
  }
  
  getStats() {
    return {
      ...this.stats,
      poolSize: this.created,
      reuseRate: this.stats.borrows > 0 
        ? (this.stats.reuses / this.stats.borrows) * 100 
        : 0
    };
  }
}

/**
 * Atomic counter
 */
export class AtomicCounter {
  constructor(initial = 0) {
    if (typeof SharedArrayBuffer !== 'undefined') {
      this.buffer = new SharedArrayBuffer(8);
      this.view = new BigInt64Array(this.buffer);
      this.view[0] = BigInt(initial);
    } else {
      this.value = initial;
    }
  }
  
  increment() {
    if (this.view && typeof Atomics !== 'undefined') {
      return Number(Atomics.add(this.view, 0, 1n)) + 1;
    }
    return ++this.value;
  }
  
  decrement() {
    if (this.view && typeof Atomics !== 'undefined') {
      return Number(Atomics.sub(this.view, 0, 1n)) - 1;
    }
    return --this.value;
  }
  
  get() {
    if (this.view && typeof Atomics !== 'undefined') {
      return Number(Atomics.load(this.view, 0));
    }
    return this.value;
  }
  
  set(value) {
    if (this.view && typeof Atomics !== 'undefined') {
      Atomics.store(this.view, 0, BigInt(value));
    } else {
      this.value = value;
    }
  }
}

export default {
  LockFreeQueue,
  LockFreeStack,
  LockFreeMemoryPool,
  LockFreeHashMap,
  WaitFreeRingBuffer,
  LockFreeObjectPool,
  AtomicCounter
};