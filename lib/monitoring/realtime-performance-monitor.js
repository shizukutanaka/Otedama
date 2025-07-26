/**
 * Realtime Performance Monitor - Otedama
 * Ultra-low overhead performance monitoring
 * 
 * Features:
 * - Lock-free metrics collection
 * - Ring buffer for time-series data
 * - Statistical analysis in real-time
 * - Anomaly detection
 * - Auto-scaling triggers
 */

import { performance } from 'perf_hooks';
import v8 from 'v8';
import os from 'os';
import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('RealtimeMonitor');

/**
 * High-resolution timer
 */
class HRTimer {
  static now() {
    return performance.now();
  }
  
  static hrtime() {
    return process.hrtime.bigint();
  }
  
  static toMillis(hrtime) {
    return Number(hrtime / 1000000n);
  }
  
  static toMicros(hrtime) {
    return Number(hrtime / 1000n);
  }
}

/**
 * Lock-free metric collector
 */
export class MetricCollector {
  constructor(name, windowSize = 1000) {
    this.name = name;
    this.windowSize = windowSize;
    
    // Ring buffer for values
    this.values = new Float64Array(windowSize);
    this.timestamps = new Float64Array(windowSize);
    this.index = 0;
    this.count = 0;
    
    // Running statistics
    this.sum = 0;
    this.sumSquares = 0;
    this.min = Infinity;
    this.max = -Infinity;
    
    // Percentile estimation (P-Square algorithm)
    this.percentiles = new P2Quantile([0.5, 0.9, 0.95, 0.99]);
  }
  
  /**
   * Record metric value
   */
  record(value, timestamp = HRTimer.now()) {
    const idx = this.index % this.windowSize;
    
    // Remove old value from statistics
    if (this.count >= this.windowSize) {
      const oldValue = this.values[idx];
      this.sum -= oldValue;
      this.sumSquares -= oldValue * oldValue;
    }
    
    // Add new value
    this.values[idx] = value;
    this.timestamps[idx] = timestamp;
    
    // Update statistics
    this.sum += value;
    this.sumSquares += value * value;
    this.min = Math.min(this.min, value);
    this.max = Math.max(this.max, value);
    
    // Update percentiles
    this.percentiles.update(value);
    
    this.index++;
    this.count = Math.min(this.count + 1, this.windowSize);
  }
  
  /**
   * Get current statistics
   */
  getStats() {
    if (this.count === 0) {
      return {
        count: 0,
        mean: 0,
        stddev: 0,
        min: 0,
        max: 0,
        p50: 0,
        p90: 0,
        p95: 0,
        p99: 0
      };
    }
    
    const mean = this.sum / this.count;
    const variance = (this.sumSquares / this.count) - (mean * mean);
    const stddev = Math.sqrt(Math.max(0, variance));
    
    const percentiles = this.percentiles.getQuantiles();
    
    return {
      count: this.count,
      mean,
      stddev,
      min: this.min,
      max: this.max,
      p50: percentiles[0.5],
      p90: percentiles[0.9],
      p95: percentiles[0.95],
      p99: percentiles[0.99]
    };
  }
  
  /**
   * Get rate (values per second)
   */
  getRate(duration = 1000) {
    if (this.count < 2) return 0;
    
    const now = HRTimer.now();
    let valueCount = 0;
    
    for (let i = 0; i < this.count; i++) {
      const idx = (this.index - 1 - i + this.windowSize) % this.windowSize;
      if (now - this.timestamps[idx] <= duration) {
        valueCount++;
      } else {
        break;
      }
    }
    
    return valueCount / (duration / 1000);
  }
}

/**
 * P-Square algorithm for online quantile estimation
 */
class P2Quantile {
  constructor(quantiles) {
    this.quantiles = quantiles;
    this.markers = quantiles.map(() => ({
      positions: [1, 2, 3, 4, 5],
      values: [0, 0, 0, 0, 0],
      desiredPositions: [1, 1 + 2 * quantiles[0], 1 + 4 * quantiles[0], 3 + 2 * quantiles[0], 5],
      initialized: false,
      count: 0
    }));
  }
  
  update(value) {
    this.markers.forEach((marker, i) => {
      this.updateMarker(marker, value, this.quantiles[i]);
    });
  }
  
  updateMarker(marker, value, quantile) {
    marker.count++;
    
    if (marker.count <= 5) {
      marker.values[marker.count - 1] = value;
      if (marker.count === 5) {
        marker.values.sort((a, b) => a - b);
        marker.initialized = true;
      }
      return;
    }
    
    // Find cell k
    let k = -1;
    if (value < marker.values[0]) {
      marker.values[0] = value;
      k = 0;
    } else if (value >= marker.values[4]) {
      marker.values[4] = value;
      k = 3;
    } else {
      for (let i = 0; i < 4; i++) {
        if (value >= marker.values[i] && value < marker.values[i + 1]) {
          k = i;
          break;
        }
      }
    }
    
    // Update positions
    for (let i = k + 1; i < 5; i++) {
      marker.positions[i]++;
    }
    
    // Update desired positions
    for (let i = 0; i < 5; i++) {
      marker.desiredPositions[i] = 1 + 2 * quantile * i;
    }
    
    // Adjust heights
    for (let i = 1; i < 4; i++) {
      const d = marker.desiredPositions[i] - marker.positions[i];
      
      if ((d >= 1 && marker.positions[i + 1] - marker.positions[i] > 1) ||
          (d <= -1 && marker.positions[i - 1] - marker.positions[i] < -1)) {
        const sign = d > 0 ? 1 : -1;
        
        // Try parabolic interpolation
        const qi = this.parabolic(marker, i, sign);
        
        if (marker.values[i - 1] < qi && qi < marker.values[i + 1]) {
          marker.values[i] = qi;
        } else {
          // Linear interpolation
          marker.values[i] = this.linear(marker, i, sign);
        }
        
        marker.positions[i] += sign;
      }
    }
  }
  
  parabolic(marker, i, sign) {
    const qi = marker.values[i];
    const qim1 = marker.values[i - 1];
    const qip1 = marker.values[i + 1];
    const ni = marker.positions[i];
    const nim1 = marker.positions[i - 1];
    const nip1 = marker.positions[i + 1];
    
    const a = (ni - nim1 + sign) * (qip1 - qi) / (nip1 - ni);
    const b = (nip1 - ni - sign) * (qi - qim1) / (ni - nim1);
    
    return qi + sign * (a + b) / (nip1 - nim1);
  }
  
  linear(marker, i, sign) {
    const qi = marker.values[i];
    const qj = marker.values[i + sign];
    const ni = marker.positions[i];
    const nj = marker.positions[i + sign];
    
    return qi + sign * (qj - qi) / (nj - ni);
  }
  
  getQuantiles() {
    const result = {};
    
    this.quantiles.forEach((q, i) => {
      const marker = this.markers[i];
      result[q] = marker.initialized ? marker.values[2] : 0;
    });
    
    return result;
  }
}

/**
 * System resource monitor
 */
export class SystemResourceMonitor {
  constructor() {
    this.cpuUsage = new MetricCollector('cpu_usage');
    this.memoryUsage = new MetricCollector('memory_usage');
    this.diskIO = new MetricCollector('disk_io');
    this.networkIO = new MetricCollector('network_io');
    
    this.lastCpuInfo = process.cpuUsage();
    this.lastNetworkStats = this.getNetworkStats();
  }
  
  /**
   * Collect system metrics
   */
  collect() {
    // CPU usage
    const cpuInfo = process.cpuUsage(this.lastCpuInfo);
    const cpuPercent = (cpuInfo.user + cpuInfo.system) / 1000000 * 100;
    this.cpuUsage.record(cpuPercent);
    this.lastCpuInfo = cpuInfo;
    
    // Memory usage
    const memInfo = process.memoryUsage();
    const totalMem = os.totalmem();
    const memPercent = (memInfo.rss / totalMem) * 100;
    this.memoryUsage.record(memPercent);
    
    // Network I/O (simplified)
    const networkStats = this.getNetworkStats();
    const networkDelta = networkStats - this.lastNetworkStats;
    this.networkIO.record(networkDelta);
    this.lastNetworkStats = networkStats;
    
    // V8 heap statistics
    const heapStats = v8.getHeapStatistics();
    
    return {
      cpu: this.cpuUsage.getStats(),
      memory: this.memoryUsage.getStats(),
      network: this.networkIO.getStats(),
      heap: {
        used: heapStats.used_heap_size,
        total: heapStats.total_heap_size,
        limit: heapStats.heap_size_limit,
        usage: heapStats.used_heap_size / heapStats.heap_size_limit
      }
    };
  }
  
  /**
   * Get network statistics (simplified)
   */
  getNetworkStats() {
    // In production, read from /proc/net/dev or similar
    return Date.now(); // Placeholder
  }
}

/**
 * Performance anomaly detector
 */
export class AnomalyDetector {
  constructor(sensitivity = 3) {
    this.sensitivity = sensitivity; // Standard deviations
    this.metrics = new Map();
    this.anomalies = [];
  }
  
  /**
   * Check for anomalies
   */
  check(metricName, value, stats) {
    if (!this.metrics.has(metricName)) {
      this.metrics.set(metricName, {
        baselineMean: stats.mean,
        baselineStddev: stats.stddev,
        samples: 0
      });
    }
    
    const metric = this.metrics.get(metricName);
    
    // Update baseline with exponential moving average
    const alpha = 0.1;
    metric.baselineMean = alpha * stats.mean + (1 - alpha) * metric.baselineMean;
    metric.baselineStddev = alpha * stats.stddev + (1 - alpha) * metric.baselineStddev;
    metric.samples++;
    
    // Skip anomaly detection until we have enough samples
    if (metric.samples < 100) return null;
    
    // Z-score test
    const zScore = Math.abs(value - metric.baselineMean) / metric.baselineStddev;
    
    if (zScore > this.sensitivity) {
      const anomaly = {
        metric: metricName,
        value,
        expected: metric.baselineMean,
        zScore,
        timestamp: Date.now(),
        severity: this.calculateSeverity(zScore)
      };
      
      this.anomalies.push(anomaly);
      
      // Keep only recent anomalies
      const cutoff = Date.now() - 300000; // 5 minutes
      this.anomalies = this.anomalies.filter(a => a.timestamp > cutoff);
      
      return anomaly;
    }
    
    return null;
  }
  
  /**
   * Calculate anomaly severity
   */
  calculateSeverity(zScore) {
    if (zScore > 6) return 'critical';
    if (zScore > 4) return 'high';
    if (zScore > 3) return 'medium';
    return 'low';
  }
  
  /**
   * Get recent anomalies
   */
  getRecentAnomalies(duration = 60000) {
    const cutoff = Date.now() - duration;
    return this.anomalies.filter(a => a.timestamp > cutoff);
  }
}

/**
 * Real-time performance monitor
 */
export class RealtimePerformanceMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.interval = options.interval || 100; // 100ms sampling
    this.historySize = options.historySize || 10000;
    
    // Metrics
    this.metrics = new Map();
    this.systemMonitor = new SystemResourceMonitor();
    this.anomalyDetector = new AnomalyDetector();
    
    // Monitoring state
    this.monitoring = false;
    this.timer = null;
    
    // Performance thresholds
    this.thresholds = {
      cpu: { warning: 70, critical: 90 },
      memory: { warning: 80, critical: 95 },
      latency: { warning: 100, critical: 500 },
      errorRate: { warning: 0.01, critical: 0.05 }
    };
  }
  
  /**
   * Start monitoring
   */
  start() {
    if (this.monitoring) return;
    
    this.monitoring = true;
    this.timer = setInterval(() => this.collect(), this.interval);
    
    logger.info('Realtime performance monitoring started', {
      interval: this.interval
    });
  }
  
  /**
   * Stop monitoring
   */
  stop() {
    if (!this.monitoring) return;
    
    this.monitoring = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    
    logger.info('Realtime performance monitoring stopped');
  }
  
  /**
   * Register metric
   */
  registerMetric(name, windowSize = 1000) {
    if (!this.metrics.has(name)) {
      this.metrics.set(name, new MetricCollector(name, windowSize));
    }
    return this.metrics.get(name);
  }
  
  /**
   * Record metric
   */
  record(name, value) {
    const metric = this.registerMetric(name);
    metric.record(value);
    
    // Check for anomalies
    const stats = metric.getStats();
    const anomaly = this.anomalyDetector.check(name, value, stats);
    
    if (anomaly) {
      this.emit('anomaly', anomaly);
    }
    
    // Check thresholds
    this.checkThresholds(name, value);
  }
  
  /**
   * Record timing
   */
  recordTiming(name, duration) {
    this.record(name + '_timing', duration);
  }
  
  /**
   * Collect all metrics
   */
  collect() {
    // System metrics
    const systemStats = this.systemMonitor.collect();
    
    // Record system metrics
    this.record('system.cpu', systemStats.cpu.mean);
    this.record('system.memory', systemStats.memory.mean);
    this.record('system.heap', systemStats.heap.usage * 100);
    
    // Emit periodic update
    this.emit('update', this.getSnapshot());
  }
  
  /**
   * Check metric thresholds
   */
  checkThresholds(name, value) {
    const threshold = this.getThreshold(name);
    if (!threshold) return;
    
    if (value >= threshold.critical) {
      this.emit('alert', {
        metric: name,
        value,
        threshold: threshold.critical,
        level: 'critical'
      });
    } else if (value >= threshold.warning) {
      this.emit('alert', {
        metric: name,
        value,
        threshold: threshold.warning,
        level: 'warning'
      });
    }
  }
  
  /**
   * Get threshold for metric
   */
  getThreshold(name) {
    if (name.includes('cpu')) return this.thresholds.cpu;
    if (name.includes('memory')) return this.thresholds.memory;
    if (name.includes('latency')) return this.thresholds.latency;
    if (name.includes('error')) return this.thresholds.errorRate;
    return null;
  }
  
  /**
   * Get current snapshot
   */
  getSnapshot() {
    const snapshot = {
      timestamp: Date.now(),
      metrics: {},
      anomalies: this.anomalyDetector.getRecentAnomalies()
    };
    
    for (const [name, collector] of this.metrics) {
      snapshot.metrics[name] = {
        stats: collector.getStats(),
        rate: collector.getRate()
      };
    }
    
    return snapshot;
  }
  
  /**
   * Get metric history
   */
  getHistory(metricName, duration = 60000) {
    const metric = this.metrics.get(metricName);
    if (!metric) return [];
    
    const now = HRTimer.now();
    const history = [];
    
    for (let i = 0; i < metric.count; i++) {
      const idx = (metric.index - 1 - i + metric.windowSize) % metric.windowSize;
      const timestamp = metric.timestamps[idx];
      
      if (now - timestamp <= duration) {
        history.unshift({
          timestamp,
          value: metric.values[idx]
        });
      } else {
        break;
      }
    }
    
    return history;
  }
  
  /**
   * Performance timer helper
   */
  timer(name) {
    const start = HRTimer.hrtime();
    
    return {
      end: () => {
        const duration = HRTimer.toMicros(HRTimer.hrtime() - start);
        this.recordTiming(name, duration);
        return duration;
      }
    };
  }
}

/**
 * Performance optimization advisor
 */
export class PerformanceAdvisor {
  constructor(monitor) {
    this.monitor = monitor;
    this.recommendations = [];
  }
  
  /**
   * Analyze performance and provide recommendations
   */
  analyze() {
    const snapshot = this.monitor.getSnapshot();
    this.recommendations = [];
    
    // Analyze each metric
    for (const [name, data] of Object.entries(snapshot.metrics)) {
      this.analyzeMetric(name, data);
    }
    
    // Analyze anomalies
    this.analyzeAnomalies(snapshot.anomalies);
    
    return this.recommendations;
  }
  
  /**
   * Analyze individual metric
   */
  analyzeMetric(name, data) {
    const stats = data.stats;
    
    // High latency
    if (name.includes('latency') && stats.p95 > 100) {
      this.recommendations.push({
        metric: name,
        issue: 'High latency detected',
        suggestion: 'Consider optimizing slow operations or adding caching',
        severity: stats.p95 > 500 ? 'high' : 'medium'
      });
    }
    
    // High CPU usage
    if (name.includes('cpu') && stats.mean > 80) {
      this.recommendations.push({
        metric: name,
        issue: 'High CPU usage',
        suggestion: 'Profile CPU usage and optimize hot paths',
        severity: 'high'
      });
    }
    
    // Memory issues
    if (name.includes('memory') && stats.mean > 85) {
      this.recommendations.push({
        metric: name,
        issue: 'High memory usage',
        suggestion: 'Check for memory leaks and optimize data structures',
        severity: 'high'
      });
    }
    
    // High variance
    if (stats.stddev > stats.mean * 0.5) {
      this.recommendations.push({
        metric: name,
        issue: 'High performance variance',
        suggestion: 'Investigate sources of performance instability',
        severity: 'medium'
      });
    }
  }
  
  /**
   * Analyze anomalies
   */
  analyzeAnomalies(anomalies) {
    const anomalyCount = {};
    
    for (const anomaly of anomalies) {
      anomalyCount[anomaly.metric] = (anomalyCount[anomaly.metric] || 0) + 1;
    }
    
    for (const [metric, count] of Object.entries(anomalyCount)) {
      if (count > 5) {
        this.recommendations.push({
          metric,
          issue: `Frequent anomalies detected (${count} in last 5 minutes)`,
          suggestion: 'Investigate root cause of performance instability',
          severity: 'high'
        });
      }
    }
  }
}

export default {
  RealtimePerformanceMonitor,
  MetricCollector,
  SystemResourceMonitor,
  AnomalyDetector,
  PerformanceAdvisor,
  HRTimer
};