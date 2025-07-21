/**
 * Performance Monitor for Otedama
 * Real-time performance metrics collection and analysis
 */

import { EventEmitter } from 'events';
import { performance, PerformanceObserver } from 'perf_hooks';
import os from 'os';
import { Worker } from 'worker_threads';
import { getErrorHandler, OtedamaError, ErrorCategory, safeExecute } from './error-handler.js';

export class PerformanceMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      sampleInterval: options.sampleInterval || 1000, // 1 second
      historySize: options.historySize || 300, // 5 minutes of history
      enableProfiling: options.enableProfiling || false,
      enableHotspotDetection: options.enableHotspotDetection || true,
      enableMemoryLeakDetection: options.enableMemoryLeakDetection || true,
      enableGCMonitoring: options.enableGCMonitoring || true,
      alertThresholds: {
        cpuUsage: options.alertThresholds?.cpuUsage || 80,
        memoryUsage: options.alertThresholds?.memoryUsage || 80,
        responseTime: options.alertThresholds?.responseTime || 1000,
        errorRate: options.alertThresholds?.errorRate || 5,
        gcPauseDuration: options.alertThresholds?.gcPauseDuration || 100,
        memoryGrowthRate: options.alertThresholds?.memoryGrowthRate || 10, // MB/minute
        dbConnectionPoolUsage: options.alertThresholds?.dbConnectionPoolUsage || 80
      },
      ...options
    };
    
    this.errorHandler = getErrorHandler();
    
    // Metrics storage with circular buffers for efficiency
    this.metrics = {
      system: {
        cpu: this.createCircularBuffer(this.options.historySize),
        memory: this.createCircularBuffer(this.options.historySize),
        network: this.createCircularBuffer(this.options.historySize),
        disk: this.createCircularBuffer(this.options.historySize),
        gc: this.createCircularBuffer(this.options.historySize)
      },
      application: {
        requests: this.createCircularBuffer(this.options.historySize),
        database: this.createCircularBuffer(this.options.historySize),
        cache: this.createCircularBuffer(this.options.historySize),
        websocket: this.createCircularBuffer(this.options.historySize),
        mining: this.createCircularBuffer(this.options.historySize),
        p2p: this.createCircularBuffer(this.options.historySize),
        dex: this.createCircularBuffer(this.options.historySize)
      },
      custom: new Map()
    };
    
    // Performance marks
    this.marks = new Map();
    this.measures = new Map();
    
    // Aggregated stats
    this.stats = {
      requests: {
        total: 0,
        successful: 0,
        failed: 0,
        avgResponseTime: 0,
        p95ResponseTime: 0,
        p99ResponseTime: 0
      },
      database: {
        queries: 0,
        avgQueryTime: 0,
        slowQueries: 0
      },
      cache: {
        hits: 0,
        misses: 0,
        hitRate: 0
      },
      errors: {
        total: 0,
        byType: new Map()
      }
    };
    
    // Performance observers
    this.observers = [];
    
    // Hotspot detection
    this.hotspots = new Map();
    
    // Memory leak detection
    this.memoryBaseline = process.memoryUsage();
    this.memoryGrowthHistory = [];
    
    // Initialize performance observers
    this.initializeObservers();
    
    // Start monitoring
    this.startMonitoring();
  }
  
  /**
   * Create circular buffer for efficient memory usage
   */
  createCircularBuffer(size) {
    return {
      buffer: new Array(size),
      size: size,
      head: 0,
      tail: 0,
      count: 0,
      
      push(item) {
        this.buffer[this.head] = item;
        this.head = (this.head + 1) % this.size;
        
        if (this.count < this.size) {
          this.count++;
        } else {
          this.tail = (this.tail + 1) % this.size;
        }
      },
      
      toArray() {
        const result = [];
        for (let i = 0; i < this.count; i++) {
          const index = (this.tail + i) % this.size;
          result.push(this.buffer[index]);
        }
        return result;
      },
      
      latest() {
        if (this.count === 0) return null;
        const index = (this.head - 1 + this.size) % this.size;
        return this.buffer[index];
      },
      
      average() {
        if (this.count === 0) return 0;
        let sum = 0;
        for (let i = 0; i < this.count; i++) {
          const index = (this.tail + i) % this.size;
          sum += this.buffer[index].value || this.buffer[index];
        }
        return sum / this.count;
      }
    };
  }
  
  /**
   * Initialize performance observers
   */
  initializeObservers() {
    if (this.options.enableProfiling) {
      // Function call observer
      const functionObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.recordFunctionCall(entry);
        }
      });
      functionObserver.observe({ entryTypes: ['function'] });
      this.observers.push(functionObserver);
    }
    
    if (this.options.enableGCMonitoring) {
      // GC observer
      const gcObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.recordGCEvent(entry);
        }
      });
      gcObserver.observe({ entryTypes: ['gc'] });
      this.observers.push(gcObserver);
    }
    
    // HTTP observer
    const httpObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        this.recordHTTPRequest(entry);
      }
    });
    httpObserver.observe({ entryTypes: ['http'] });
    this.observers.push(httpObserver);
  }

  /**
   * Start system monitoring
   */
  startMonitoring() {
    // System metrics collection
    this.systemInterval = setInterval(() => {
      this.collectSystemMetrics();
    }, this.options.sampleInterval);
    
    // Cleanup old data
    this.cleanupInterval = setInterval(() => {
      this.cleanupOldData();
    }, 60000); // Every minute
  }

  /**
   * Collect system metrics
   */
  collectSystemMetrics() {
    const timestamp = Date.now();
    
    // CPU usage
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;
    
    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    });
    
    const cpuUsage = 100 - ~~(100 * totalIdle / totalTick);
    
    // Memory usage
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memoryUsage = (usedMem / totalMem) * 100;
    
    // Process memory
    const processMemory = process.memoryUsage();
    
    // Store metrics
    this.metrics.system.cpu.push({ timestamp, value: cpuUsage });
    this.metrics.system.memory.push({
      timestamp,
      system: memoryUsage,
      process: {
        rss: processMemory.rss,
        heapTotal: processMemory.heapTotal,
        heapUsed: processMemory.heapUsed,
        external: processMemory.external
      }
    });
    
    // Check thresholds
    if (cpuUsage > this.options.alertThresholds.cpuUsage) {
      this.emit('alert', {
        type: 'cpu',
        message: `CPU usage high: ${cpuUsage}%`,
        value: cpuUsage,
        threshold: this.options.alertThresholds.cpuUsage
      });
    }
    
    if (memoryUsage > this.options.alertThresholds.memoryUsage) {
      this.emit('alert', {
        type: 'memory',
        message: `Memory usage high: ${memoryUsage.toFixed(2)}%`,
        value: memoryUsage,
        threshold: this.options.alertThresholds.memoryUsage
      });
    }
  }

  /**
   * Start timing an operation
   */
  startTiming(label, metadata = {}) {
    const id = `${label}_${Date.now()}_${Math.random()}`;
    this.marks.set(id, {
      label,
      startTime: performance.now(),
      metadata
    });
    return id;
  }

  /**
   * End timing an operation
   */
  endTiming(id, success = true) {
    const mark = this.marks.get(id);
    if (!mark) return;
    
    const endTime = performance.now();
    const duration = endTime - mark.startTime;
    
    // Store measure
    const measure = {
      label: mark.label,
      duration,
      success,
      timestamp: Date.now(),
      metadata: mark.metadata
    };
    
    if (!this.measures.has(mark.label)) {
      this.measures.set(mark.label, []);
    }
    this.measures.get(mark.label).push(measure);
    
    // Update stats
    this.updateStats(mark.label, duration, success);
    
    // Check threshold
    if (duration > this.options.alertThresholds.responseTime) {
      this.emit('alert', {
        type: 'response_time',
        message: `Slow operation: ${mark.label} took ${duration.toFixed(2)}ms`,
        value: duration,
        threshold: this.options.alertThresholds.responseTime
      });
    }
    
    this.marks.delete(id);
    return duration;
  }

  /**
   * Record a metric
   */
  recordMetric(category, name, value, metadata = {}) {
    if (!this.metrics.application[category]) {
      this.metrics.application[category] = new Map();
    }
    
    if (!this.metrics.application[category].has(name)) {
      this.metrics.application[category].set(name, []);
    }
    
    this.metrics.application[category].get(name).push({
      timestamp: Date.now(),
      value,
      metadata
    });
  }

  /**
   * Record custom metric
   */
  recordCustomMetric(name, value, metadata = {}) {
    if (!this.metrics.custom.has(name)) {
      this.metrics.custom.set(name, []);
    }
    
    this.metrics.custom.get(name).push({
      timestamp: Date.now(),
      value,
      metadata
    });
  }

  /**
   * Update aggregated stats
   */
  updateStats(label, duration, success) {
    if (label.startsWith('request_')) {
      this.stats.requests.total++;
      if (success) {
        this.stats.requests.successful++;
      } else {
        this.stats.requests.failed++;
      }
      
      // Update average response time
      const currentAvg = this.stats.requests.avgResponseTime;
      const total = this.stats.requests.total;
      this.stats.requests.avgResponseTime = 
        (currentAvg * (total - 1) + duration) / total;
    } else if (label.startsWith('db_')) {
      this.stats.database.queries++;
      
      // Update average query time
      const currentAvg = this.stats.database.avgQueryTime;
      const total = this.stats.database.queries;
      this.stats.database.avgQueryTime = 
        (currentAvg * (total - 1) + duration) / total;
      
      // Track slow queries
      if (duration > 100) { // 100ms threshold
        this.stats.database.slowQueries++;
      }
    }
  }

  /**
   * Get current metrics
   */
  getMetrics(category = null) {
    if (category) {
      return {
        system: category === 'system' ? this.metrics.system : undefined,
        application: category === 'application' ? this.metrics.application : undefined,
        custom: category === 'custom' ? this.metrics.custom : undefined
      };
    }
    return this.metrics;
  }

  /**
   * Get aggregated statistics
   */
  getStats() {
    // Calculate percentiles for response times
    const requestMeasures = this.measures.get('request_handler') || [];
    if (requestMeasures.length > 0) {
      const sortedDurations = requestMeasures
        .map(m => m.duration)
        .sort((a, b) => a - b);
      
      const p95Index = Math.floor(sortedDurations.length * 0.95);
      const p99Index = Math.floor(sortedDurations.length * 0.99);
      
      this.stats.requests.p95ResponseTime = sortedDurations[p95Index] || 0;
      this.stats.requests.p99ResponseTime = sortedDurations[p99Index] || 0;
    }
    
    // Calculate cache hit rate
    if (this.stats.cache.hits + this.stats.cache.misses > 0) {
      this.stats.cache.hitRate = 
        (this.stats.cache.hits / (this.stats.cache.hits + this.stats.cache.misses)) * 100;
    }
    
    // Calculate error rate
    const errorRate = this.stats.requests.total > 0
      ? (this.stats.requests.failed / this.stats.requests.total) * 100
      : 0;
    
    if (errorRate > this.options.alertThresholds.errorRate) {
      this.emit('alert', {
        type: 'error_rate',
        message: `High error rate: ${errorRate.toFixed(2)}%`,
        value: errorRate,
        threshold: this.options.alertThresholds.errorRate
      });
    }
    
    return {
      ...this.stats,
      errorRate,
      uptime: process.uptime(),
      timestamp: Date.now()
    };
  }

  /**
   * Clean up old data
   */
  cleanupOldData() {
    const cutoff = Date.now() - (this.options.historySize * this.options.sampleInterval);
    
    // Clean system metrics
    for (const key in this.metrics.system) {
      this.metrics.system[key] = this.metrics.system[key].filter(
        item => item.timestamp > cutoff
      );
    }
    
    // Clean application metrics
    for (const category of Object.values(this.metrics.application)) {
      for (const [name, data] of category) {
        category.set(name, data.filter(item => item.timestamp > cutoff));
      }
    }
    
    // Clean custom metrics
    for (const [name, data] of this.metrics.custom) {
      this.metrics.custom.set(name, data.filter(item => item.timestamp > cutoff));
    }
    
    // Clean measures
    for (const [label, measures] of this.measures) {
      this.measures.set(label, measures.filter(m => m.timestamp > cutoff));
    }
  }

  /**
   * Export metrics in Prometheus format
   */
  exportPrometheus() {
    const lines = [];
    
    // System metrics
    const latestCpu = this.metrics.system.cpu[this.metrics.system.cpu.length - 1];
    if (latestCpu) {
      lines.push(`# HELP otedama_cpu_usage CPU usage percentage`);
      lines.push(`# TYPE otedama_cpu_usage gauge`);
      lines.push(`otedama_cpu_usage ${latestCpu.value}`);
    }
    
    // Request metrics
    lines.push(`# HELP otedama_requests_total Total number of requests`);
    lines.push(`# TYPE otedama_requests_total counter`);
    lines.push(`otedama_requests_total ${this.stats.requests.total}`);
    
    lines.push(`# HELP otedama_request_duration_seconds Request duration in seconds`);
    lines.push(`# TYPE otedama_request_duration_seconds histogram`);
    lines.push(`otedama_request_duration_seconds_sum ${this.stats.requests.avgResponseTime * this.stats.requests.total / 1000}`);
    lines.push(`otedama_request_duration_seconds_count ${this.stats.requests.total}`);
    
    return lines.join('\n');
  }

  /**
   * Stop monitoring
   */
  stop() {
    if (this.systemInterval) {
      clearInterval(this.systemInterval);
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

// Singleton instance
let performanceMonitor = null;

export function getPerformanceMonitor(options) {
  if (!performanceMonitor) {
    performanceMonitor = new PerformanceMonitor(options);
  }
  return performanceMonitor;
}