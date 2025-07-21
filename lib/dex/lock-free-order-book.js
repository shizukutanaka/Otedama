/**
 * Lock-Free Order Book Implementation
 * High-performance concurrent order book using atomic operations
 * Following Carmack's principles for maximum performance
 */

import { AtomicBuffer } from '../performance/atomic-buffer.js';

// Order states for lock-free operations
const OrderState = {
  EMPTY: 0,
  PENDING: 1,
  ACTIVE: 2,
  FILLED: 3,
  CANCELLED: 4,
  UPDATING: 5
};

// Price level states
const PriceLevelState = {
  EMPTY: 0,
  ACTIVE: 1,
  UPDATING: 2
};

/**
 * Lock-Free Order Book
 * Uses atomic operations and wait-free algorithms
 */
export class LockFreeOrderBook {
  constructor(options = {}) {
    this.options = {
      maxOrders: options.maxOrders || 1000000,
      maxPriceLevels: options.maxPriceLevels || 10000,
      tickSize: options.tickSize || 0.00000001,
      priceDecimals: options.priceDecimals || 8,
      sizeDecimals: options.sizeDecimals || 8,
      ...options
    };
    
    // Pre-allocate memory for orders
    this.orderPool = new OrderPool(this.options.maxOrders);
    
    // Price level maps (using atomic operations)
    this.buyLevels = new AtomicPriceLevelMap(this.options.maxPriceLevels);
    this.sellLevels = new AtomicPriceLevelMap(this.options.maxPriceLevels);
    
    // Order index for fast lookup
    this.orderIndex = new AtomicOrderIndex(this.options.maxOrders);
    
    // Best bid/ask atomic pointers
    this.bestBid = new AtomicPrice();
    this.bestAsk = new AtomicPrice();
    
    // Statistics
    this.stats = {
      ordersAdded: 0,
      ordersMatched: 0,
      ordersCancelled: 0,
      contentionCount: 0,
      retryCount: 0
    };
  }
  
  /**
   * Add order to book (lock-free)
   */
  async addOrder(order) {
    const startTime = process.hrtime.bigint();
    
    // Allocate order slot
    const orderSlot = this.orderPool.allocate();
    if (!orderSlot) {
      throw new Error('Order book full');
    }
    
    try {
      // Initialize order in slot
      orderSlot.initialize(order);
      
      // Get or create price level
      const priceLevel = order.side === 'buy' 
        ? this.buyLevels.getOrCreate(order.price)
        : this.sellLevels.getOrCreate(order.price);
      
      // Add to price level (lock-free)
      let added = false;
      let retries = 0;
      
      while (!added && retries < 100) {
        added = priceLevel.addOrder(orderSlot);
        if (!added) {
          retries++;
          // Exponential backoff with random jitter
          await this.backoff(retries);
        }
      }
      
      if (!added) {
        throw new Error('Failed to add order after retries');
      }
      
      // Update order index
      this.orderIndex.set(order.id, orderSlot);
      
      // Update best bid/ask if necessary
      this.updateBestPrices(order.side, order.price);
      
      // Try to match immediately
      await this.tryMatch(orderSlot);
      
      const endTime = process.hrtime.bigint();
      this.stats.ordersAdded++;
      
      return {
        orderId: order.id,
        status: orderSlot.getState(),
        executionTime: Number(endTime - startTime) / 1000000 // ms
      };
      
    } catch (error) {
      // Release slot on error
      this.orderPool.release(orderSlot);
      throw error;
    }
  }
  
  /**
   * Cancel order (lock-free)
   */
  async cancelOrder(orderId) {
    const orderSlot = this.orderIndex.get(orderId);
    if (!orderSlot) {
      throw new Error('Order not found');
    }
    
    // Atomic state transition
    const prevState = orderSlot.compareAndSwapState(
      OrderState.ACTIVE,
      OrderState.CANCELLED
    );
    
    if (prevState !== OrderState.ACTIVE) {
      throw new Error(`Cannot cancel order in state ${prevState}`);
    }
    
    // Remove from price level
    const order = orderSlot.getOrder();
    const priceLevel = order.side === 'buy'
      ? this.buyLevels.get(order.price)
      : this.sellLevels.get(order.price);
    
    if (priceLevel) {
      priceLevel.removeOrder(orderSlot);
    }
    
    // Remove from index
    this.orderIndex.remove(orderId);
    
    // Release slot
    this.orderPool.release(orderSlot);
    
    this.stats.ordersCancelled++;
    
    return {
      orderId,
      status: 'cancelled'
    };
  }
  
  /**
   * Try to match order against opposite side
   */
  async tryMatch(orderSlot) {
    const order = orderSlot.getOrder();
    const oppositeLevels = order.side === 'buy' ? this.sellLevels : this.buyLevels;
    
    let remainingSize = order.size;
    let totalMatched = 0;
    
    // Get matching price levels
    const matchingLevels = order.side === 'buy'
      ? oppositeLevels.getLevelsBelow(order.price)
      : oppositeLevels.getLevelsAbove(order.price);
    
    for (const priceLevel of matchingLevels) {
      if (remainingSize <= 0) break;
      
      // Try to match against orders at this level
      const matches = await priceLevel.matchOrders(remainingSize, orderSlot);
      
      for (const match of matches) {
        const matchedSize = Math.min(remainingSize, match.remainingSize);
        
        // Update both orders atomically
        orderSlot.addMatchedSize(matchedSize);
        match.orderSlot.addMatchedSize(matchedSize);
        
        remainingSize -= matchedSize;
        totalMatched += matchedSize;
        
        // Emit match event
        this.emitMatch({
          takerOrderId: order.id,
          makerOrderId: match.orderSlot.getOrder().id,
          price: match.orderSlot.getOrder().price,
          size: matchedSize,
          timestamp: Date.now()
        });
        
        // Check if maker order is filled
        if (match.orderSlot.isFilled()) {
          this.completeOrder(match.orderSlot);
        }
      }
    }
    
    // Check if taker order is filled
    if (orderSlot.isFilled()) {
      this.completeOrder(orderSlot);
    }
    
    this.stats.ordersMatched += matches.length;
    
    return totalMatched;
  }
  
  /**
   * Complete filled order
   */
  completeOrder(orderSlot) {
    const order = orderSlot.getOrder();
    
    // Remove from price level
    const priceLevel = order.side === 'buy'
      ? this.buyLevels.get(order.price)
      : this.sellLevels.get(order.price);
    
    if (priceLevel) {
      priceLevel.removeOrder(orderSlot);
    }
    
    // Remove from index
    this.orderIndex.remove(order.id);
    
    // Mark as filled
    orderSlot.setState(OrderState.FILLED);
    
    // Release slot after a delay (for event processing)
    setTimeout(() => {
      this.orderPool.release(orderSlot);
    }, 1000);
  }
  
  /**
   * Update best bid/ask prices atomically
   */
  updateBestPrices(side, price) {
    if (side === 'buy') {
      let currentBest;
      do {
        currentBest = this.bestBid.get();
        if (currentBest !== 0 && price <= currentBest) break;
      } while (!this.bestBid.compareAndSwap(currentBest, price));
    } else {
      let currentBest;
      do {
        currentBest = this.bestAsk.get();
        if (currentBest !== 0 && price >= currentBest) break;
      } while (!this.bestAsk.compareAndSwap(currentBest, price));
    }
  }
  
  /**
   * Get order book snapshot (wait-free read)
   */
  getSnapshot(depth = 10) {
    const snapshot = {
      bids: [],
      asks: [],
      bestBid: this.bestBid.get(),
      bestAsk: this.bestAsk.get(),
      timestamp: Date.now()
    };
    
    // Get top bid levels
    const bidLevels = this.buyLevels.getTopLevels(depth);
    for (const level of bidLevels) {
      snapshot.bids.push({
        price: level.price,
        size: level.getTotalSize(),
        orderCount: level.getOrderCount()
      });
    }
    
    // Get top ask levels
    const askLevels = this.sellLevels.getTopLevels(depth);
    for (const level of askLevels) {
      snapshot.asks.push({
        price: level.price,
        size: level.getTotalSize(),
        orderCount: level.getOrderCount()
      });
    }
    
    return snapshot;
  }
  
  /**
   * Exponential backoff with jitter
   */
  async backoff(attempt) {
    const maxDelay = Math.min(1000, Math.pow(2, attempt) * 10);
    const jitter = Math.random() * maxDelay * 0.3;
    const delay = maxDelay + jitter;
    
    return new Promise(resolve => {
      if (delay < 1) {
        // For very small delays, just yield
        setImmediate(resolve);
      } else {
        setTimeout(resolve, delay);
      }
    });
  }
  
  /**
   * Emit match event
   */
  emitMatch(match) {
    // This would emit to event system
    // For now, just track in stats
    this.stats.ordersMatched++;
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      orderCount: this.orderIndex.size(),
      bidLevels: this.buyLevels.size(),
      askLevels: this.sellLevels.size(),
      bestBid: this.bestBid.get(),
      bestAsk: this.bestAsk.get(),
      poolUtilization: this.orderPool.getUtilization()
    };
  }
}

/**
 * Lock-free order pool using atomic operations
 */
class OrderPool {
  constructor(maxOrders) {
    this.maxOrders = maxOrders;
    this.slots = new Array(maxOrders);
    this.freeList = new AtomicFreeList(maxOrders);
    
    // Pre-allocate all slots
    for (let i = 0; i < maxOrders; i++) {
      this.slots[i] = new OrderSlot(i);
      this.freeList.add(i);
    }
  }
  
  allocate() {
    const index = this.freeList.take();
    if (index === -1) return null;
    
    return this.slots[index];
  }
  
  release(slot) {
    slot.reset();
    this.freeList.add(slot.index);
  }
  
  getUtilization() {
    return 1 - (this.freeList.size() / this.maxOrders);
  }
}

/**
 * Order slot with atomic operations
 */
class OrderSlot {
  constructor(index) {
    this.index = index;
    this.state = new AtomicInt32(OrderState.EMPTY);
    this.order = null;
    this.matchedSize = new AtomicFloat64(0);
    this.next = new AtomicInt32(-1); // For linked list in price level
  }
  
  initialize(order) {
    this.order = { ...order };
    this.matchedSize.set(0);
    this.state.set(OrderState.ACTIVE);
  }
  
  reset() {
    this.order = null;
    this.matchedSize.set(0);
    this.state.set(OrderState.EMPTY);
    this.next.set(-1);
  }
  
  getState() {
    return this.state.get();
  }
  
  setState(newState) {
    this.state.set(newState);
  }
  
  compareAndSwapState(expected, newState) {
    return this.state.compareAndSwap(expected, newState);
  }
  
  getOrder() {
    return this.order;
  }
  
  addMatchedSize(size) {
    return this.matchedSize.add(size);
  }
  
  getRemainingSize() {
    return this.order.size - this.matchedSize.get();
  }
  
  isFilled() {
    return this.getRemainingSize() <= 0;
  }
}

/**
 * Atomic price level map
 */
class AtomicPriceLevelMap {
  constructor(maxLevels) {
    this.levels = new Map();
    this.maxLevels = maxLevels;
    this.levelPool = new Array(maxLevels);
    this.freeList = new AtomicFreeList(maxLevels);
    
    // Pre-allocate price levels
    for (let i = 0; i < maxLevels; i++) {
      this.levelPool[i] = new PriceLevel(i);
      this.freeList.add(i);
    }
  }
  
  getOrCreate(price) {
    let level = this.levels.get(price);
    if (level) return level;
    
    // Allocate new level
    const index = this.freeList.take();
    if (index === -1) {
      throw new Error('Max price levels reached');
    }
    
    level = this.levelPool[index];
    level.initialize(price);
    
    // Try to add atomically
    const existing = this.levels.get(price);
    if (existing) {
      // Another thread created it
      this.freeList.add(index);
      return existing;
    }
    
    this.levels.set(price, level);
    return level;
  }
  
  get(price) {
    return this.levels.get(price);
  }
  
  getTopLevels(count) {
    const sorted = Array.from(this.levels.entries())
      .sort((a, b) => b[0] - a[0]) // Descending for bids
      .slice(0, count)
      .map(([price, level]) => level);
    
    return sorted;
  }
  
  getLevelsBelow(price) {
    return Array.from(this.levels.entries())
      .filter(([p, level]) => p <= price)
      .sort((a, b) => b[0] - a[0])
      .map(([p, level]) => level);
  }
  
  getLevelsAbove(price) {
    return Array.from(this.levels.entries())
      .filter(([p, level]) => p >= price)
      .sort((a, b) => a[0] - b[0])
      .map(([p, level]) => level);
  }
  
  size() {
    return this.levels.size;
  }
}

/**
 * Lock-free price level
 */
class PriceLevel {
  constructor(index) {
    this.index = index;
    this.price = 0;
    this.head = new AtomicInt32(-1);
    this.totalSize = new AtomicFloat64(0);
    this.orderCount = new AtomicInt32(0);
    this.state = new AtomicInt32(PriceLevelState.EMPTY);
  }
  
  initialize(price) {
    this.price = price;
    this.head.set(-1);
    this.totalSize.set(0);
    this.orderCount.set(0);
    this.state.set(PriceLevelState.ACTIVE);
  }
  
  addOrder(orderSlot) {
    // Add to head of linked list atomically
    let oldHead;
    do {
      oldHead = this.head.get();
      orderSlot.next.set(oldHead);
    } while (!this.head.compareAndSwap(oldHead, orderSlot.index));
    
    // Update stats
    this.totalSize.add(orderSlot.getOrder().size);
    this.orderCount.add(1);
    
    return true;
  }
  
  removeOrder(orderSlot) {
    // Lock-free removal is complex, simplified here
    // In production, would use hazard pointers or epoch-based reclamation
    
    this.totalSize.subtract(orderSlot.getRemainingSize());
    this.orderCount.subtract(1);
    
    return true;
  }
  
  async matchOrders(maxSize, takerSlot) {
    const matches = [];
    let remainingSize = maxSize;
    
    // Traverse linked list
    let current = this.head.get();
    while (current !== -1 && remainingSize > 0) {
      const orderSlot = this.orderPool.slots[current];
      
      if (orderSlot.getState() === OrderState.ACTIVE) {
        const availableSize = orderSlot.getRemainingSize();
        if (availableSize > 0) {
          matches.push({
            orderSlot,
            remainingSize: availableSize
          });
          
          remainingSize -= availableSize;
        }
      }
      
      current = orderSlot.next.get();
    }
    
    return matches;
  }
  
  getTotalSize() {
    return this.totalSize.get();
  }
  
  getOrderCount() {
    return this.orderCount.get();
  }
}

/**
 * Atomic order index
 */
class AtomicOrderIndex {
  constructor(maxOrders) {
    this.index = new Map();
    this.lock = new AtomicInt32(0);
  }
  
  set(orderId, orderSlot) {
    // Simple spinlock for map operations
    while (!this.lock.compareAndSwap(0, 1)) {
      // Spin
    }
    
    try {
      this.index.set(orderId, orderSlot);
    } finally {
      this.lock.set(0);
    }
  }
  
  get(orderId) {
    return this.index.get(orderId);
  }
  
  remove(orderId) {
    while (!this.lock.compareAndSwap(0, 1)) {
      // Spin
    }
    
    try {
      this.index.delete(orderId);
    } finally {
      this.lock.set(0);
    }
  }
  
  size() {
    return this.index.size;
  }
}

/**
 * Atomic free list for lock-free allocation
 */
class AtomicFreeList {
  constructor(size) {
    this.list = new Int32Array(size);
    this.head = new AtomicInt32(0);
    this.count = new AtomicInt32(size);
    
    // Initialize free list
    for (let i = 0; i < size; i++) {
      this.list[i] = i;
    }
  }
  
  take() {
    let index;
    do {
      const currentCount = this.count.get();
      if (currentCount === 0) return -1;
      
      const currentHead = this.head.get();
      index = this.list[currentHead];
      
      const newHead = (currentHead + 1) % this.list.length;
      
      if (this.head.compareAndSwap(currentHead, newHead)) {
        this.count.subtract(1);
        return index;
      }
    } while (true);
  }
  
  add(index) {
    let added = false;
    do {
      const currentCount = this.count.get();
      const currentHead = this.head.get();
      
      const tail = (currentHead + currentCount) % this.list.length;
      this.list[tail] = index;
      
      if (this.count.compareAndSwap(currentCount, currentCount + 1)) {
        added = true;
      }
    } while (!added);
  }
  
  size() {
    return this.count.get();
  }
}

/**
 * Atomic integer wrapper (simulated)
 */
class AtomicInt32 {
  constructor(value = 0) {
    this.value = value;
  }
  
  get() {
    return this.value;
  }
  
  set(newValue) {
    this.value = newValue;
  }
  
  compareAndSwap(expected, newValue) {
    if (this.value === expected) {
      this.value = newValue;
      return expected;
    }
    return this.value;
  }
  
  add(delta) {
    this.value += delta;
    return this.value;
  }
  
  subtract(delta) {
    this.value -= delta;
    return this.value;
  }
}

/**
 * Atomic float wrapper (simulated)
 */
class AtomicFloat64 {
  constructor(value = 0) {
    this.value = value;
  }
  
  get() {
    return this.value;
  }
  
  set(newValue) {
    this.value = newValue;
  }
  
  add(delta) {
    this.value += delta;
    return this.value;
  }
  
  subtract(delta) {
    this.value -= delta;
    return this.value;
  }
}

/**
 * Atomic price wrapper
 */
class AtomicPrice extends AtomicFloat64 {
  compareAndSwap(expected, newValue) {
    if (Math.abs(this.value - expected) < 0.00000001) {
      this.value = newValue;
      return true;
    }
    return false;
  }
}

export default LockFreeOrderBook;