/**
 * Async Utilities - Otedama
 * Optimized async operations and patterns
 * 
 * Design: Don't block the event loop (Carmack)
 */

import { TimeoutError } from './errors.js';
import { createLogger } from './logger.js';

const logger = createLogger('AsyncUtils');

/**
 * Retry with exponential backoff
 */
export async function retry(fn, options = {}) {
  const {
    maxAttempts = 3,
    initialDelay = 100,
    maxDelay = 10000,
    factor = 2,
    onRetry = null,
    shouldRetry = () => true
  } = options;
  
  let lastError;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      
      if (attempt === maxAttempts || !shouldRetry(error, attempt)) {
        throw error;
      }
      
      const delay = Math.min(
        initialDelay * Math.pow(factor, attempt - 1),
        maxDelay
      );
      
      if (onRetry) {
        onRetry(error, attempt, delay);
      }
      
      await sleep(delay);
    }
  }
  
  throw lastError;
}

/**
 * Timeout wrapper
 */
export async function withTimeout(promise, timeout, message = 'Operation timed out') {
  let timeoutId;
  
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new TimeoutError(message));
    }, timeout);
  });
  
  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId);
    return result;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

/**
 * Sleep utility
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Parallel execution with concurrency limit
 */
export async function parallel(tasks, concurrency = Infinity) {
  const results = [];
  const executing = [];
  
  for (const [index, task] of tasks.entries()) {
    const promise = Promise.resolve().then(() => task()).then(
      result => results[index] = { status: 'fulfilled', value: result },
      error => results[index] = { status: 'rejected', reason: error }
    );
    
    executing.push(promise);
    
    if (executing.length >= concurrency) {
      await Promise.race(executing);
      executing.splice(executing.findIndex(p => p === promise), 1);
    }
  }
  
  await Promise.all(executing);
  return results;
}

/**
 * Batch processor
 */
export class BatchProcessor {
  constructor(processor, options = {}) {
    this.processor = processor;
    this.options = {
      batchSize: options.batchSize || 100,
      flushInterval: options.flushInterval || 1000,
      maxRetries: options.maxRetries || 3,
      ...options
    };
    
    this.batch = [];
    this.flushTimer = null;
    this.processing = false;
  }
  
  add(item) {
    this.batch.push(item);
    
    if (this.batch.length >= this.options.batchSize) {
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flush();
      }, this.options.flushInterval);
    }
  }
  
  async flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    
    if (this.batch.length === 0 || this.processing) {
      return;
    }
    
    this.processing = true;
    const items = this.batch.splice(0);
    
    try {
      await retry(
        () => this.processor(items),
        { maxAttempts: this.options.maxRetries }
      );
    } catch (error) {
      logger.error(`Batch processing failed: ${error.message}`);
      
      if (this.options.onError) {
        this.options.onError(error, items);
      }
    } finally {
      this.processing = false;
    }
  }
  
  async stop() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    
    await this.flush();
  }
}

/**
 * Async queue with backpressure
 */
export class AsyncQueue {
  constructor(worker, concurrency = 1) {
    this.worker = worker;
    this.concurrency = concurrency;
    this.queue = [];
    this.running = 0;
    this.paused = false;
    
    this.resolvers = [];
    this.pushResolvers = [];
  }
  
  async push(item) {
    if (this.paused) {
      await new Promise(resolve => this.pushResolvers.push(resolve));
    }
    
    return new Promise((resolve, reject) => {
      this.queue.push({ item, resolve, reject });
      this.process();
    });
  }
  
  async process() {
    if (this.paused || this.running >= this.concurrency) {
      return;
    }
    
    const task = this.queue.shift();
    if (!task) {
      if (this.running === 0 && this.resolvers.length > 0) {
        this.resolvers.forEach(resolve => resolve());
        this.resolvers = [];
      }
      return;
    }
    
    this.running++;
    
    try {
      const result = await this.worker(task.item);
      task.resolve(result);
    } catch (error) {
      task.reject(error);
    } finally {
      this.running--;
      this.process();
    }
  }
  
  pause() {
    this.paused = true;
  }
  
  resume() {
    this.paused = false;
    this.pushResolvers.forEach(resolve => resolve());
    this.pushResolvers = [];
    this.process();
  }
  
  async drain() {
    if (this.queue.length === 0 && this.running === 0) {
      return;
    }
    
    return new Promise(resolve => {
      this.resolvers.push(resolve);
    });
  }
  
  size() {
    return this.queue.length;
  }
  
  clear() {
    const cleared = this.queue.splice(0);
    cleared.forEach(task => {
      task.reject(new Error('Queue cleared'));
    });
  }
}

/**
 * Debounce function
 */
export function debounce(fn, delay) {
  let timeoutId;
  
  const debounced = function(...args) {
    clearTimeout(timeoutId);
    
    return new Promise((resolve, reject) => {
      timeoutId = setTimeout(async () => {
        try {
          const result = await fn.apply(this, args);
          resolve(result);
        } catch (error) {
          reject(error);
        }
      }, delay);
    });
  };
  
  debounced.cancel = () => {
    clearTimeout(timeoutId);
  };
  
  return debounced;
}

/**
 * Throttle function
 */
export function throttle(fn, limit) {
  let inThrottle;
  let lastResult;
  
  const throttled = function(...args) {
    if (!inThrottle) {
      inThrottle = true;
      
      setTimeout(() => {
        inThrottle = false;
      }, limit);
      
      lastResult = fn.apply(this, args);
    }
    
    return lastResult;
  };
  
  return throttled;
}

/**
 * Promise pool for resource management
 */
export class PromisePool {
  constructor(factory, size = 10) {
    this.factory = factory;
    this.size = size;
    this.available = [];
    this.pending = [];
    
    // Pre-create resources
    for (let i = 0; i < size; i++) {
      this.available.push(this.createResource());
    }
  }
  
  async createResource() {
    return {
      resource: await this.factory(),
      inUse: false
    };
  }
  
  async acquire() {
    // Find available resource
    let wrapper = this.available.find(w => !w.inUse);
    
    if (!wrapper) {
      // Wait for resource to become available
      await new Promise(resolve => this.pending.push(resolve));
      wrapper = this.available.find(w => !w.inUse);
    }
    
    wrapper.inUse = true;
    return wrapper.resource;
  }
  
  release(resource) {
    const wrapper = this.available.find(w => w.resource === resource);
    if (wrapper) {
      wrapper.inUse = false;
      
      // Notify waiting acquirers
      const resolver = this.pending.shift();
      if (resolver) {
        resolver();
      }
    }
  }
  
  async use(fn) {
    const resource = await this.acquire();
    
    try {
      return await fn(resource);
    } finally {
      this.release(resource);
    }
  }
  
  async destroy() {
    // Wait for all resources to be released
    await Promise.all(
      this.available
        .filter(w => w.inUse)
        .map(w => new Promise(resolve => {
          const checkInterval = setInterval(() => {
            if (!w.inUse) {
              clearInterval(checkInterval);
              resolve();
            }
          }, 100);
        }))
    );
    
    // Destroy all resources
    for (const wrapper of this.available) {
      if (wrapper.resource.destroy) {
        await wrapper.resource.destroy();
      }
    }
    
    this.available = [];
    this.pending = [];
  }
}

/**
 * Async event emitter
 */
export class AsyncEventEmitter {
  constructor() {
    this.events = new Map();
  }
  
  on(event, handler) {
    if (!this.events.has(event)) {
      this.events.set(event, []);
    }
    
    this.events.get(event).push(handler);
    
    return () => this.off(event, handler);
  }
  
  off(event, handler) {
    const handlers = this.events.get(event);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index !== -1) {
        handlers.splice(index, 1);
      }
    }
  }
  
  async emit(event, ...args) {
    const handlers = this.events.get(event);
    if (!handlers || handlers.length === 0) {
      return [];
    }
    
    const results = await Promise.allSettled(
      handlers.map(handler => handler(...args))
    );
    
    return results;
  }
  
  async emitSerial(event, ...args) {
    const handlers = this.events.get(event);
    if (!handlers || handlers.length === 0) {
      return [];
    }
    
    const results = [];
    
    for (const handler of handlers) {
      try {
        const result = await handler(...args);
        results.push({ status: 'fulfilled', value: result });
      } catch (error) {
        results.push({ status: 'rejected', reason: error });
      }
    }
    
    return results;
  }
}

/**
 * Channel for async communication
 */
export class Channel {
  constructor(capacity = Infinity) {
    this.capacity = capacity;
    this.queue = [];
    this.receivers = [];
    this.closed = false;
  }
  
  async send(value) {
    if (this.closed) {
      throw new Error('Channel is closed');
    }
    
    if (this.receivers.length > 0) {
      const receiver = this.receivers.shift();
      receiver.resolve({ value, done: false });
      return;
    }
    
    if (this.queue.length >= this.capacity) {
      await new Promise(resolve => {
        this.senders = this.senders || [];
        this.senders.push({ value, resolve });
      });
    } else {
      this.queue.push(value);
    }
  }
  
  async receive() {
    if (this.queue.length > 0) {
      const value = this.queue.shift();
      
      // Unblock waiting senders
      if (this.senders && this.senders.length > 0) {
        const sender = this.senders.shift();
        this.queue.push(sender.value);
        sender.resolve();
      }
      
      return { value, done: false };
    }
    
    if (this.closed) {
      return { done: true };
    }
    
    return new Promise(resolve => {
      this.receivers.push({ resolve });
    });
  }
  
  close() {
    this.closed = true;
    
    // Resolve all waiting receivers
    this.receivers.forEach(receiver => {
      receiver.resolve({ done: true });
    });
    
    this.receivers = [];
  }
  
  [Symbol.asyncIterator]() {
    return {
      next: () => this.receive()
    };
  }
}

export default {
  retry,
  withTimeout,
  sleep,
  parallel,
  BatchProcessor,
  AsyncQueue,
  debounce,
  throttle,
  PromisePool,
  AsyncEventEmitter,
  Channel
};
