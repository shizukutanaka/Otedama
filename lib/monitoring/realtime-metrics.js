/**
 * Real-time Metrics System - Otedama
 * Ultra-low latency metrics collection and aggregation
 * 
 * Design Principles:
 * - Carmack: Lock-free metrics collection, zero allocation
 * - Martin: Clean separation of collection and aggregation
 * - Pike: Simple API for complex metrics
 */

import { EventEmitter } from 'events';
import { LockFreeQueue, AtomicCounter } from '../core/lock-free-structures.js';
import { ZeroCopyRingBuffer } from '../core/zero-copy-buffer.js';

/**
 * High-precision timer
 */
class HighResTimer {
  constructor() {
    // Use process.hrtime.bigint for nanosecond precision
    this.start = process.hrtime.bigint();
  }
  
  elapsed() {
    return Number(process.hrtime.bigint() - this.start);
  }
  
  elapsedMs() {
    return this.elapsed() / 1000000;
  }
  
  static now() {
    return Number(process.hrtime.bigint());
  }
  
  static nowMs() {
    return Number(process.hrtime.bigint()) / 1000000;
  }
}

/**
 * Lock-free histogram for latency tracking
 */
export class LockFreeHistogram {
  constructor(maxValue = 1000000, precision = 3) {
    this.maxValue = maxValue;
    this.precision = precision;
    this.bucketCount = Math.ceil(Math.log10(maxValue) * Math.pow(10, precision));
    this.buckets = new Array(this.bucketCount);
    
    // Initialize atomic counters for each bucket
    for (let i = 0; i < this.bucketCount; i++) {
      this.buckets[i] = new AtomicCounter(0);
    }
    
    this.count = new AtomicCounter(0);
    this.sum = new AtomicCounter(0);
    this.min = maxValue;
    this.max = 0;
  }
  
  record(value) {
    if (value < 0 || value > this.maxValue) return;
    
    // Update count and sum
    this.count.increment();
    this.sum.set(this.sum.get() + value);
    
    // Update min/max (not perfectly atomic but good enough)
    if (value < this.min) this.min = value;
    if (value > this.max) this.max = value;
    
    // Calculate bucket index (log scale)
    const bucketIndex = this.getBucketIndex(value);
    if (bucketIndex >= 0 && bucketIndex < this.bucketCount) {
      this.buckets[bucketIndex].increment();
    }
  }
  
  getBucketIndex(value) {
    if (value === 0) return 0;
    return Math.floor(Math.log10(value) * Math.pow(10, this.precision));
  }
  
  getPercentile(percentile) {
    const targetCount = Math.ceil(this.count.get() * percentile / 100);
    let accumulated = 0;
    
    for (let i = 0; i < this.bucketCount; i++) {
      accumulated += this.buckets[i].get();
      if (accumulated >= targetCount) {
        // Estimate value from bucket index
        return Math.pow(10, i / Math.pow(10, this.precision));
      }
    }
    
    return this.max;
  }
  
  getStats() {
    const total = this.count.get();
    if (total === 0) {
      return {
        count: 0,
        mean: 0,
        min: 0,
        max: 0,
        p50: 0,
        p95: 0,
        p99: 0,
        p999: 0
      };
    }
    
    return {
      count: total,
      mean: this.sum.get() / total,
      min: this.min,
      max: this.max,
      p50: this.getPercentile(50),
      p95: this.getPercentile(95),
      p99: this.getPercentile(99),
      p999: this.getPercentile(99.9)
    };
  }
  
  reset() {
    this.count.set(0);
    this.sum.set(0);
    this.min = this.maxValue;
    this.max = 0;
    
    for (let i = 0; i < this.bucketCount; i++) {
      this.buckets[i].set(0);
    }
  }
}

/**
 * Real-time counter with atomic operations
 */
export class RealtimeCounter {
  constructor(windowSizeMs = 60000) { // 1 minute window
    this.windowSize = windowSizeMs;
    this.buckets = new Map();
    this.total = new AtomicCounter(0);
  }
  
  increment(value = 1) {
    const now = Date.now();
    const bucket = Math.floor(now / 1000); // 1-second buckets
    
    if (!this.buckets.has(bucket)) {
      this.buckets.set(bucket, new AtomicCounter(0));
      this.cleanup(now);
    }
    
    this.buckets.get(bucket).increment();
    this.total.increment();
  }
  
  getRate() {
    const now = Date.now();
    this.cleanup(now);
    
    let sum = 0;
    const cutoff = now - this.windowSize;
    
    for (const [bucket, counter] of this.buckets) {
      const bucketTime = bucket * 1000;
      if (bucketTime >= cutoff) {
        sum += counter.get();
      }
    }
    
    // Return rate per second
    return sum / (this.windowSize / 1000);
  }
  
  cleanup(now) {
    const cutoff = Math.floor((now - this.windowSize) / 1000);
    
    for (const [bucket, counter] of this.buckets) {
      if (bucket < cutoff) {
        this.total.set(this.total.get() - counter.get());
        this.buckets.delete(bucket);
      }
    }
  }
}

/**
 * Real-time gauge with moving average
 */
export class RealtimeGauge {
  constructor(windowSize = 100) {
    this.windowSize = windowSize;
    this.values = new Float64Array(windowSize);
    this.timestamps = new Float64Array(windowSize);
    this.index = 0;
    this.count = 0;
  }
  
  set(value) {
    const now = HighResTimer.nowMs();
    
    this.values[this.index] = value;
    this.timestamps[this.index] = now;
    
    this.index = (this.index + 1) % this.windowSize;
    if (this.count < this.windowSize) this.count++;
  }
  
  get() {
    if (this.count === 0) return 0;
    
    // Return most recent value
    const lastIndex = (this.index - 1 + this.windowSize) % this.windowSize;
    return this.values[lastIndex];
  }
  
  getAverage() {
    if (this.count === 0) return 0;
    
    let sum = 0;
    for (let i = 0; i < this.count; i++) {
      sum += this.values[i];
    }
    
    return sum / this.count;
  }
  
  getRate() {
    if (this.count < 2) return 0;
    
    // Calculate rate of change
    const oldestIndex = this.count === this.windowSize ? this.index : 0;
    const newestIndex = (this.index - 1 + this.windowSize) % this.windowSize;
    
    const timeDiff = this.timestamps[newestIndex] - this.timestamps[oldestIndex];
    const valueDiff = this.values[newestIndex] - this.values[oldestIndex];
    
    return timeDiff > 0 ? valueDiff / (timeDiff / 1000) : 0;
  }
}

/**
 * Real-time metrics collector
 */
export class RealtimeMetrics extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      flushInterval: config.flushInterval || 1000, // 1 second
      retention: config.retention || 3600000, // 1 hour
      maxMetrics: config.maxMetrics || 10000,
      ...config
    };
    
    // Metric stores
    this.counters = new Map();
    this.gauges = new Map();
    this.histograms = new Map();
    
    // Lock-free queue for metric events
    this.eventQueue = new LockFreeQueue(65536);
    
    // Zero-copy buffer for batch operations
    this.batchBuffer = new ZeroCopyRingBuffer(1024 * 1024); // 1MB
    
    // Start processing
    this.startProcessing();
  }
  
  /**
   * Record a counter metric
   */
  counter(name, value = 1, tags = {}) {
    this.eventQueue.enqueue({
      type: 'counter',
      name,
      value,
      tags,
      timestamp: HighResTimer.nowMs()
    });
  }
  
  /**
   * Record a gauge metric
   */
  gauge(name, value, tags = {}) {
    this.eventQueue.enqueue({
      type: 'gauge',
      name,
      value,
      tags,
      timestamp: HighResTimer.nowMs()
    });
  }
  
  /**
   * Record a timing metric
   */
  timing(name, duration, tags = {}) {
    this.eventQueue.enqueue({
      type: 'histogram',
      name,
      value: duration,
      tags,
      timestamp: HighResTimer.nowMs()
    });
  }
  
  /**
   * Create a timer
   */
  timer(name, tags = {}) {
    const timer = new HighResTimer();
    
    return {
      end: () => {
        const duration = timer.elapsedMs();
        this.timing(name, duration, tags);
        return duration;
      }
    };
  }
  
  /**
   * Get or create counter
   */
  getCounter(name) {
    if (!this.counters.has(name)) {
      this.counters.set(name, new RealtimeCounter());
    }
    return this.counters.get(name);
  }
  
  /**
   * Get or create gauge
   */
  getGauge(name) {
    if (!this.gauges.has(name)) {
      this.gauges.set(name, new RealtimeGauge());
    }
    return this.gauges.get(name);
  }
  
  /**
   * Get or create histogram
   */
  getHistogram(name) {
    if (!this.histograms.has(name)) {
      this.histograms.set(name, new LockFreeHistogram());
    }
    return this.histograms.get(name);
  }
  
  /**
   * Process metric events
   */
  startProcessing() {
    // Process event queue
    const processEvents = () => {
      let processed = 0;
      let event;
      
      while ((event = this.eventQueue.dequeue()) !== null && processed < 1000) {
        switch (event.type) {
          case 'counter':
            this.getCounter(event.name).increment(event.value);
            break;
            
          case 'gauge':
            this.getGauge(event.name).set(event.value);
            break;
            
          case 'histogram':
            this.getHistogram(event.name).record(event.value);
            break;
        }
        
        processed++;
      }
      
      setImmediate(processEvents);
    };
    
    processEvents();
    
    // Periodic flush
    this.flushInterval = setInterval(() => {
      this.flush();
    }, this.config.flushInterval);
  }
  
  /**
   * Flush metrics
   */
  flush() {
    const metrics = this.getSnapshot();
    
    // Write to batch buffer
    const writeBuffer = this.batchBuffer.getWriteBuffer(4096);
    if (writeBuffer) {
      const data = JSON.stringify(metrics);
      const encoded = Buffer.from(data);
      
      if (encoded.length <= writeBuffer.view.length) {
        encoded.copy(writeBuffer.view);
        writeBuffer.commit();
        
        this.emit('metrics', metrics);
      }
    }
  }
  
  /**
   * Get metrics snapshot
   */
  getSnapshot() {
    const snapshot = {
      timestamp: Date.now(),
      counters: {},
      gauges: {},
      histograms: {}
    };
    
    // Collect counter metrics
    for (const [name, counter] of this.counters) {
      snapshot.counters[name] = {
        rate: counter.getRate(),
        total: counter.total.get()
      };
    }
    
    // Collect gauge metrics
    for (const [name, gauge] of this.gauges) {
      snapshot.gauges[name] = {
        value: gauge.get(),
        average: gauge.getAverage(),
        rate: gauge.getRate()
      };
    }
    
    // Collect histogram metrics
    for (const [name, histogram] of this.histograms) {
      snapshot.histograms[name] = histogram.getStats();
    }
    
    return snapshot;
  }
  
  /**
   * Reset all metrics
   */
  reset() {
    this.counters.clear();
    this.gauges.clear();
    
    for (const histogram of this.histograms.values()) {
      histogram.reset();
    }
  }
  
  /**
   * Stop metrics collection
   */
  stop() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
  }
}

/**
 * System metrics collector
 */
export class SystemMetrics {
  constructor(metrics) {
    this.metrics = metrics;
    this.cpuUsage = process.cpuUsage();
    this.lastCheck = Date.now();
    
    // Start collection
    this.collectInterval = setInterval(() => {
      this.collect();
    }, 1000);
  }
  
  collect() {
    const now = Date.now();
    const elapsed = now - this.lastCheck;
    
    // CPU metrics
    const cpu = process.cpuUsage(this.cpuUsage);
    this.metrics.gauge('system.cpu.user', (cpu.user / elapsed) * 100);
    this.metrics.gauge('system.cpu.system', (cpu.system / elapsed) * 100);
    this.cpuUsage = process.cpuUsage();
    
    // Memory metrics
    const mem = process.memoryUsage();
    this.metrics.gauge('system.memory.rss', mem.rss);
    this.metrics.gauge('system.memory.heapUsed', mem.heapUsed);
    this.metrics.gauge('system.memory.heapTotal', mem.heapTotal);
    this.metrics.gauge('system.memory.external', mem.external);
    
    // Event loop metrics
    const lag = this.measureEventLoopLag();
    this.metrics.timing('system.eventloop.lag', lag);
    
    // GC metrics (if available)
    if (global.gc) {
      const before = Date.now();
      global.gc();
      const gcTime = Date.now() - before;
      this.metrics.timing('system.gc.duration', gcTime);
    }
    
    this.lastCheck = now;
  }
  
  measureEventLoopLag() {
    const start = HighResTimer.nowMs();
    
    return new Promise(resolve => {
      setImmediate(() => {
        const lag = HighResTimer.nowMs() - start;
        resolve(lag);
      });
    });
  }
  
  stop() {
    if (this.collectInterval) {
      clearInterval(this.collectInterval);
      this.collectInterval = null;
    }
  }
}

// Export singleton instance
export const metrics = new RealtimeMetrics();
export const systemMetrics = new SystemMetrics(metrics);

export default {
  HighResTimer,
  LockFreeHistogram,
  RealtimeCounter,
  RealtimeGauge,
  RealtimeMetrics,
  SystemMetrics,
  metrics,
  systemMetrics
};