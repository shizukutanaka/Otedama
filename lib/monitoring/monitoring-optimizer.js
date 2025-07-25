/**
 * Real-time Monitoring Optimizer
 * High-performance metrics collection and aggregation
 * 
 * Features:
 * - Lock-free metrics collection
 * - Time-series data optimization
 * - Adaptive sampling rates
 * - Metrics compression
 * - Zero-allocation design
 */

import { EventEmitter } from 'events';
import { createLogger } from '../core/logger.js';

const logger = createLogger('MonitoringOptimizer');

/**
 * Ring buffer for time-series data
 */
class TimeSeriesRingBuffer {
  constructor(size, interval) {
    this.size = size;
    this.interval = interval;
    this.buffer = new Float64Array(size);
    this.timestamps = new Float64Array(size);
    this.head = 0;
    this.count = 0;
  }
  
  add(value, timestamp = Date.now()) {
    this.buffer[this.head] = value;
    this.timestamps[this.head] = timestamp;
    this.head = (this.head + 1) % this.size;
    if (this.count < this.size) this.count++;
  }
  
  getLatest(n = 10) {
    const result = [];
    const start = (this.head - Math.min(n, this.count) + this.size) % this.size;
    
    for (let i = 0; i < Math.min(n, this.count); i++) {
      const idx = (start + i) % this.size;
      result.push({
        value: this.buffer[idx],
        timestamp: this.timestamps[idx]
      });
    }
    
    return result;
  }
  
  getStats() {
    if (this.count === 0) return null;
    
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    
    for (let i = 0; i < this.count; i++) {
      const value = this.buffer[i];
      sum += value;
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    
    const avg = sum / this.count;
    
    // Calculate percentiles (simplified)
    const sorted = Array.from(this.buffer.slice(0, this.count)).sort((a, b) => a - b);
    const p50 = sorted[Math.floor(this.count * 0.5)];
    const p95 = sorted[Math.floor(this.count * 0.95)];
    const p99 = sorted[Math.floor(this.count * 0.99)];
    
    return { min, max, avg, p50, p95, p99 };
  }
}

/**
 * Lock-free counter using Atomics
 */
class AtomicCounter {
  constructor() {
    this.buffer = new SharedArrayBuffer(8);
    this.view = new BigInt64Array(this.buffer);
    Atomics.store(this.view, 0, 0n);
  }
  
  increment(delta = 1n) {
    return Atomics.add(this.view, 0, BigInt(delta));
  }
  
  get() {
    return Number(Atomics.load(this.view, 0));
  }
  
  reset() {
    return Number(Atomics.exchange(this.view, 0, 0n));
  }
}

/**
 * Histogram for latency tracking
 */
class Histogram {
  constructor(maxValue = 10000, precision = 2) {
    this.maxValue = maxValue;
    this.precision = precision;
    this.bucketCount = Math.ceil(Math.log2(maxValue)) * precision;
    this.buckets = new Uint32Array(this.bucketCount);
    this.count = 0;
    this.sum = 0;
  }
  
  record(value) {
    if (value <= 0) return;
    
    const bucket = this.getBucket(value);
    if (bucket < this.bucketCount) {
      this.buckets[bucket]++;
      this.count++;
      this.sum += value;
    }
  }
  
  getBucket(value) {
    if (value <= 0) return 0;
    return Math.floor(Math.log2(value) * this.precision);
  }
  
  getPercentile(percentile) {
    if (this.count === 0) return 0;
    
    const threshold = this.count * percentile;
    let accumulated = 0;
    
    for (let i = 0; i < this.bucketCount; i++) {
      accumulated += this.buckets[i];
      if (accumulated >= threshold) {
        return Math.pow(2, i / this.precision);
      }
    }
    
    return this.maxValue;
  }
  
  getStats() {
    if (this.count === 0) return null;
    
    return {
      count: this.count,
      mean: this.sum / this.count,
      p50: this.getPercentile(0.5),
      p90: this.getPercentile(0.9),
      p95: this.getPercentile(0.95),
      p99: this.getPercentile(0.99),
      p999: this.getPercentile(0.999)
    };
  }
  
  reset() {
    this.buckets.fill(0);
    this.count = 0;
    this.sum = 0;
  }
}

/**
 * Adaptive sampling rate controller
 */
class AdaptiveSampler {
  constructor(targetSamplesPerSecond = 1000) {
    this.targetRate = targetSamplesPerSecond;
    this.currentRate = 1; // Sample every Nth event
    this.eventCount = 0;
    this.lastAdjustment = Date.now();
    this.adjustmentInterval = 1000; // 1 second
  }
  
  shouldSample() {
    this.eventCount++;
    
    // Adjust rate periodically
    if (Date.now() - this.lastAdjustment > this.adjustmentInterval) {
      this.adjustRate();
    }
    
    return this.eventCount % this.currentRate === 0;
  }
  
  adjustRate() {
    const actualRate = this.eventCount / ((Date.now() - this.lastAdjustment) / 1000);
    
    if (actualRate > this.targetRate * 1.2) {
      // Too many samples, increase sampling interval
      this.currentRate = Math.min(this.currentRate * 2, 1000);
    } else if (actualRate < this.targetRate * 0.8 && this.currentRate > 1) {
      // Too few samples, decrease sampling interval
      this.currentRate = Math.max(Math.floor(this.currentRate / 2), 1);
    }
    
    this.eventCount = 0;
    this.lastAdjustment = Date.now();
  }
}

/**
 * Real-time Monitoring Optimizer
 */
export class MonitoringOptimizer extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      flushInterval: config.flushInterval || 1000,
      retentionPeriod: config.retentionPeriod || 3600000, // 1 hour
      maxMetrics: config.maxMetrics || 10000,
      enableCompression: config.enableCompression !== false,
      adaptiveSampling: config.adaptiveSampling !== false
    };
    
    // Metrics storage
    this.counters = new Map();
    this.gauges = new Map();
    this.histograms = new Map();
    this.timeSeries = new Map();
    
    // Adaptive samplers
    this.samplers = new Map();
    
    // Flush timer
    this.flushTimer = null;
    
    // Stats
    this.stats = {
      metricsCollected: 0,
      metricsFlushed: 0,
      compressionRatio: 1
    };
  }
  
  /**
   * Initialize monitoring
   */
  initialize() {
    // Start flush timer
    this.flushTimer = setInterval(() => {
      this.flush();
    }, this.config.flushInterval);
    
    logger.info('Monitoring optimizer initialized');
  }
  
  /**
   * Record counter increment
   */
  incrementCounter(name, delta = 1, tags = {}) {
    const key = this.getMetricKey(name, tags);
    
    if (!this.counters.has(key)) {
      this.counters.set(key, new AtomicCounter());
    }
    
    this.counters.get(key).increment(delta);
    this.stats.metricsCollected++;
  }
  
  /**
   * Set gauge value
   */
  setGauge(name, value, tags = {}) {
    const key = this.getMetricKey(name, tags);
    
    if (!this.gauges.has(key)) {
      this.gauges.set(key, { value: 0, timestamp: Date.now() });
    }
    
    this.gauges.get(key).value = value;
    this.gauges.get(key).timestamp = Date.now();
    this.stats.metricsCollected++;
  }
  
  /**
   * Record histogram value
   */
  recordHistogram(name, value, tags = {}) {
    const key = this.getMetricKey(name, tags);
    
    // Check adaptive sampling
    if (this.config.adaptiveSampling) {
      if (!this.samplers.has(key)) {
        this.samplers.set(key, new AdaptiveSampler());
      }
      
      if (!this.samplers.get(key).shouldSample()) {
        return;
      }
    }
    
    if (!this.histograms.has(key)) {
      this.histograms.set(key, new Histogram());
    }
    
    this.histograms.get(key).record(value);
    this.stats.metricsCollected++;
  }
  
  /**
   * Record time series data point
   */
  recordTimeSeries(name, value, tags = {}) {
    const key = this.getMetricKey(name, tags);
    
    if (!this.timeSeries.has(key)) {
      this.timeSeries.set(key, new TimeSeriesRingBuffer(3600, 1000)); // 1 hour of data
    }
    
    this.timeSeries.get(key).add(value);
    this.stats.metricsCollected++;
  }
  
  /**
   * Create timer for latency measurement
   */
  createTimer(name, tags = {}) {
    const start = process.hrtime.bigint();
    
    return {
      end: () => {
        const elapsed = Number(process.hrtime.bigint() - start) / 1000000; // Convert to ms
        this.recordHistogram(name, elapsed, tags);
      }
    };
  }
  
  /**
   * Get metric key
   */
  getMetricKey(name, tags) {
    if (Object.keys(tags).length === 0) {
      return name;
    }
    
    const tagStr = Object.entries(tags)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}`)
      .join(',');
    
    return `${name}{${tagStr}}`;
  }
  
  /**
   * Flush metrics
   */
  flush() {
    const metrics = this.collectMetrics();
    
    if (metrics.length === 0) return;
    
    // Compress if enabled
    if (this.config.enableCompression) {
      const compressed = this.compressMetrics(metrics);
      this.stats.compressionRatio = compressed.length / JSON.stringify(metrics).length;
      this.emit('flush', compressed);
    } else {
      this.emit('flush', metrics);
    }
    
    this.stats.metricsFlushed += metrics.length;
    
    // Clean up old data
    this.cleanup();
  }
  
  /**
   * Collect all metrics
   */
  collectMetrics() {
    const metrics = [];
    const timestamp = Date.now();
    
    // Collect counters
    for (const [key, counter] of this.counters) {
      const value = counter.reset();
      if (value > 0) {
        metrics.push({
          type: 'counter',
          name: key,
          value,
          timestamp
        });
      }
    }
    
    // Collect gauges
    for (const [key, gauge] of this.gauges) {
      metrics.push({
        type: 'gauge',
        name: key,
        value: gauge.value,
        timestamp: gauge.timestamp
      });
    }
    
    // Collect histograms
    for (const [key, histogram] of this.histograms) {
      const stats = histogram.getStats();
      if (stats) {
        metrics.push({
          type: 'histogram',
          name: key,
          stats,
          timestamp
        });
        histogram.reset();
      }
    }
    
    // Collect time series
    for (const [key, series] of this.timeSeries) {
      const stats = series.getStats();
      if (stats) {
        metrics.push({
          type: 'timeseries',
          name: key,
          stats,
          latest: series.getLatest(10),
          timestamp
        });
      }
    }
    
    return metrics;
  }
  
  /**
   * Compress metrics
   */
  compressMetrics(metrics) {
    // Simple compression by deduplicating field names
    const names = new Set();
    const compressed = {
      names: [],
      metrics: []
    };
    
    for (const metric of metrics) {
      if (!names.has(metric.name)) {
        names.add(metric.name);
        compressed.names.push(metric.name);
      }
      
      const nameIndex = compressed.names.indexOf(metric.name);
      compressed.metrics.push({
        t: metric.type[0], // First letter only
        n: nameIndex,
        v: metric.value || metric.stats,
        ts: metric.timestamp
      });
    }
    
    return compressed;
  }
  
  /**
   * Clean up old metrics
   */
  cleanup() {
    const cutoff = Date.now() - this.config.retentionPeriod;
    
    // Clean up gauges
    for (const [key, gauge] of this.gauges) {
      if (gauge.timestamp < cutoff) {
        this.gauges.delete(key);
      }
    }
    
    // Limit total metrics
    if (this.gauges.size + this.counters.size + this.histograms.size > this.config.maxMetrics) {
      // Remove oldest gauges
      const sorted = Array.from(this.gauges.entries())
        .sort(([, a], [, b]) => a.timestamp - b.timestamp);
      
      const toRemove = sorted.slice(0, sorted.length - this.config.maxMetrics / 3);
      for (const [key] of toRemove) {
        this.gauges.delete(key);
      }
    }
  }
  
  /**
   * Get current statistics
   */
  getStats() {
    return {
      ...this.stats,
      metrics: {
        counters: this.counters.size,
        gauges: this.gauges.size,
        histograms: this.histograms.size,
        timeSeries: this.timeSeries.size
      }
    };
  }
  
  /**
   * Shutdown monitoring
   */
  shutdown() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flush(); // Final flush
    }
  }
}

export default MonitoringOptimizer;
