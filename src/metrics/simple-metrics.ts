/**
 * Simple Metrics - Lightweight Performance Monitoring
 * Design: John Carmack (Performance-focused) + Rob Pike (Simple)
 */

import { createComponentLogger } from '../logging/simple-logger';

interface MetricValue {
  value: number;
  timestamp: number;
  labels?: Record<string, string>;
}

interface HistogramBucket {
  le: number; // less than or equal
  count: number;
}

class Counter {
  private value: number = 0;
  private labels: Record<string, string>;
  
  constructor(labels: Record<string, string> = {}) {
    this.labels = labels;
  }
  
  inc(value: number = 1): void {
    this.value += value;
  }
  
  get(): number {
    return this.value;
  }
  
  reset(): void {
    this.value = 0;
  }
  
  getLabels(): Record<string, string> {
    return this.labels;
  }
}

class Gauge {
  private value: number = 0;
  private labels: Record<string, string>;
  
  constructor(labels: Record<string, string> = {}) {
    this.labels = labels;
  }
  
  set(value: number): void {
    this.value = value;
  }
  
  inc(value: number = 1): void {
    this.value += value;
  }
  
  dec(value: number = 1): void {
    this.value -= value;
  }
  
  get(): number {
    return this.value;
  }
  
  getLabels(): Record<string, string> {
    return this.labels;
  }
}

class Histogram {
  private buckets: HistogramBucket[];
  private sum: number = 0;
  private count: number = 0;
  private labels: Record<string, string>;
  
  constructor(buckets: number[] = [0.1, 0.5, 1, 2, 5, 10], labels: Record<string, string> = {}) {
    this.buckets = buckets.map(le => ({ le, count: 0 }));
    this.buckets.push({ le: Infinity, count: 0 }); // +Inf bucket
    this.labels = labels;
  }
  
  observe(value: number): void {
    this.sum += value;
    this.count++;
    
    for (const bucket of this.buckets) {
      if (value <= bucket.le) {
        bucket.count++;
      }
    }
  }
  
  getBuckets(): HistogramBucket[] {
    return this.buckets;
  }
  
  getSum(): number {
    return this.sum;
  }
  
  getCount(): number {
    return this.count;
  }
  
  getLabels(): Record<string, string> {
    return this.labels;
  }
}

class SimpleMetrics {
  private counters: Map<string, Counter> = new Map();
  private gauges: Map<string, Gauge> = new Map();
  private histograms: Map<string, Histogram> = new Map();
  private logger = createComponentLogger('Metrics');
  
  // Counter methods
  counter(name: string, labels?: Record<string, string>): Counter {
    const key = this.getMetricKey(name, labels);
    
    if (!this.counters.has(key)) {
      this.counters.set(key, new Counter(labels));
    }
    
    return this.counters.get(key)!;
  }
  
  incCounter(name: string, value: number = 1, labels?: Record<string, string>): void {
    this.counter(name, labels).inc(value);
  }
  
  // Gauge methods
  gauge(name: string, labels?: Record<string, string>): Gauge {
    const key = this.getMetricKey(name, labels);
    
    if (!this.gauges.has(key)) {
      this.gauges.set(key, new Gauge(labels));
    }
    
    return this.gauges.get(key)!;
  }
  
  setGauge(name: string, value: number, labels?: Record<string, string>): void {
    this.gauge(name, labels).set(value);
  }
  
  // Histogram methods
  histogram(name: string, buckets?: number[], labels?: Record<string, string>): Histogram {
    const key = this.getMetricKey(name, labels);
    
    if (!this.histograms.has(key)) {
      this.histograms.set(key, new Histogram(buckets, labels));
    }
    
    return this.histograms.get(key)!;
  }
  
  observeHistogram(name: string, value: number, labels?: Record<string, string>): void {
    this.histogram(name, undefined, labels).observe(value);
  }
  
  // Timing helper
  time<T>(name: string, fn: () => T, labels?: Record<string, string>): T {
    const start = process.hrtime.bigint();
    try {
      return fn();
    } finally {
      const end = process.hrtime.bigint();
      const duration = Number(end - start) / 1e6; // Convert to milliseconds
      this.observeHistogram(name, duration, labels);
    }
  }
  
  async timeAsync<T>(name: string, fn: () => Promise<T>, labels?: Record<string, string>): Promise<T> {
    const start = process.hrtime.bigint();
    try {
      return await fn();
    } finally {
      const end = process.hrtime.bigint();
      const duration = Number(end - start) / 1e6; // Convert to milliseconds
      this.observeHistogram(name, duration, labels);
    }
  }
  
  private getMetricKey(name: string, labels?: Record<string, string>): string {
    if (!labels || Object.keys(labels).length === 0) {
      return name;
    }
    
    const labelStr = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
    
    return `${name}{${labelStr}}`;
  }
  
  // Export metrics in Prometheus format
  export(): string {
    const lines: string[] = [];
    
    // Export counters
    for (const [key, counter] of this.counters) {
      const labels = this.formatLabels(counter.getLabels());
      lines.push(`# TYPE ${this.getMetricName(key)} counter`);
      lines.push(`${this.getMetricName(key)}${labels} ${counter.get()}`);
    }
    
    // Export gauges
    for (const [key, gauge] of this.gauges) {
      const labels = this.formatLabels(gauge.getLabels());
      lines.push(`# TYPE ${this.getMetricName(key)} gauge`);
      lines.push(`${this.getMetricName(key)}${labels} ${gauge.get()}`);
    }
    
    // Export histograms
    for (const [key, histogram] of this.histograms) {
      const metricName = this.getMetricName(key);
      const labels = histogram.getLabels();
      
      lines.push(`# TYPE ${metricName} histogram`);
      
      // Buckets
      for (const bucket of histogram.getBuckets()) {
        const bucketLabels = { ...labels, le: bucket.le === Infinity ? '+Inf' : bucket.le.toString() };
        lines.push(`${metricName}_bucket${this.formatLabels(bucketLabels)} ${bucket.count}`);
      }
      
      // Count and sum
      lines.push(`${metricName}_count${this.formatLabels(labels)} ${histogram.getCount()}`);
      lines.push(`${metricName}_sum${this.formatLabels(labels)} ${histogram.getSum()}`);
    }
    
    return lines.join('\n') + '\n';
  }
  
  private getMetricName(key: string): string {
    return key.split('{')[0];
  }
  
  private formatLabels(labels: Record<string, string>): string {
    if (!labels || Object.keys(labels).length === 0) {
      return '';
    }
    
    const labelPairs = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
    
    return `{${labelPairs}}`;
  }
  
  // Get current metric values as JSON
  getStats(): any {
    const stats: any = {
      counters: {},
      gauges: {},
      histograms: {}
    };
    
    for (const [key, counter] of this.counters) {
      stats.counters[key] = counter.get();
    }
    
    for (const [key, gauge] of this.gauges) {
      stats.gauges[key] = gauge.get();
    }
    
    for (const [key, histogram] of this.histograms) {
      stats.histograms[key] = {
        count: histogram.getCount(),
        sum: histogram.getSum(),
        buckets: histogram.getBuckets()
      };
    }
    
    return stats;
  }
  
  // Reset all metrics
  reset(): void {
    for (const counter of this.counters.values()) {
      counter.reset();
    }
    
    this.gauges.clear();
    this.histograms.clear();
    
    this.logger.info('All metrics reset');
  }
  
  // Log current stats
  logStats(): void {
    const stats = this.getStats();
    this.logger.info('Current metrics', stats);
  }
}

// Pool-specific metrics
class PoolMetrics {
  private metrics: SimpleMetrics;
  
  constructor(metrics: SimpleMetrics) {
    this.metrics = metrics;
  }
  
  // Connection metrics
  recordConnection(action: 'connected' | 'disconnected'): void {
    this.metrics.incCounter('pool_connections_total', 1, { action });
  }
  
  updateActiveConnections(count: number): void {
    this.metrics.setGauge('pool_connections_active', count);
  }
  
  // Share metrics
  recordShare(valid: boolean, minerId?: string): void {
    const labels = { valid: valid.toString() };
    if (minerId) labels['miner'] = minerId;
    
    this.metrics.incCounter('pool_shares_total', 1, labels);
  }
  
  updateHashrate(hashrate: number, minerId?: string): void {
    const labels = minerId ? { miner: minerId } : {};
    this.metrics.setGauge('pool_hashrate', hashrate, labels);
  }
  
  // Block metrics
  recordBlock(found: boolean): void {
    this.metrics.incCounter('pool_blocks_total', 1, { found: found.toString() });
  }
  
  // Payout metrics
  recordPayout(amount: number, minerId: string): void {
    this.metrics.incCounter('pool_payouts_total', 1, { miner: minerId });
    this.metrics.incCounter('pool_payouts_amount', amount, { miner: minerId });
  }
  
  // Performance metrics
  recordShareProcessingTime(duration: number): void {
    this.metrics.observeHistogram('pool_share_processing_duration_ms', duration);
  }
  
  recordDatabaseQueryTime(operation: string, duration: number): void {
    this.metrics.observeHistogram('pool_database_query_duration_ms', duration, { operation });
  }
  
  // System metrics
  updateMemoryUsage(): void {
    const memUsage = process.memoryUsage();
    this.metrics.setGauge('pool_memory_heap_used_bytes', memUsage.heapUsed);
    this.metrics.setGauge('pool_memory_heap_total_bytes', memUsage.heapTotal);
    this.metrics.setGauge('pool_memory_rss_bytes', memUsage.rss);
  }
  
  updateCpuUsage(usage: number): void {
    this.metrics.setGauge('pool_cpu_usage_percent', usage);
  }
}

// Singleton instance
let instance: SimpleMetrics | null = null;

export function getMetrics(): SimpleMetrics {
  if (!instance) {
    instance = new SimpleMetrics();
  }
  return instance;
}

export function createPoolMetrics(): PoolMetrics {
  return new PoolMetrics(getMetrics());
}

export { SimpleMetrics, PoolMetrics, Counter, Gauge, Histogram };
