// src/performance/network-profiler.ts
import { Logger } from '../logging/logger';
import { RedisCache } from '../cache/redis-cache';
import { performance } from 'perf_hooks';
import { EventEmitter } from 'events';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';

export interface NetworkRequest {
  id: string;
  method: string;
  url: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  requestSize: number;
  responseSize: number;
  statusCode?: number;
  error?: string;
  headers: Record<string, string>;
  timing: {
    dns?: number;
    connect?: number;
    tls?: number;
    firstByte?: number;
    download?: number;
  };
  retries: number;
  cached: boolean;
}

export interface ConnectionMetrics {
  timestamp: number;
  activeConnections: number;
  totalConnections: number;
  connectionErrors: number;
  averageLatency: number;
  bandwidth: {
    bytesIn: number;
    bytesOut: number;
    requestsPerSecond: number;
  };
  poolStats: {
    total: number;
    active: number;
    idle: number;
    pending: number;
  };
}

export interface NetworkProfilerConfig {
  enabled: boolean;
  trackRequests: boolean;
  trackConnections: boolean;
  maxRequests: number;
  sampleRate: number; // 0.0 to 1.0
  thresholds: {
    latency: number; // milliseconds
    errorRate: number; // percentage
    throughput: number; // requests per second
  };
  analysis: {
    enabled: boolean;
    windowSize: number; // minutes
    patterns: boolean;
  };
}

export interface NetworkAnalysis {
  totalRequests: number;
  successRate: number;
  averageLatency: number;
  p95Latency: number;
  p99Latency: number;
  throughput: number; // requests per second
  bandwidth: {
    avgBytesIn: number;
    avgBytesOut: number;
    peakBytesIn: number;
    peakBytesOut: number;
  };
  errors: {
    total: number;
    byType: Record<string, number>;
    rate: number;
  };
  slowQueries: NetworkRequest[];
  patterns: NetworkPattern[];
  recommendations: string[];
}

export interface NetworkPattern {
  type: 'burst' | 'steady' | 'sporadic' | 'periodic';
  description: string;
  frequency: number;
  impact: 'low' | 'medium' | 'high';
  recommendations: string[];
}

export interface BandwidthMetrics {
  timestamp: number;
  bytesIn: number;
  bytesOut: number;
  packetsIn: number;
  packetsOut: number;
  connectionsOpened: number;
  connectionsClosed: number;
  retransmissions: number;
}

export interface NetworkAlert {
  type: 'high_latency' | 'high_error_rate' | 'connection_limit' | 'bandwidth_spike';
  timestamp: number;
  value: number;
  threshold: number;
  message: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

export class NetworkProfiler extends EventEmitter {
  private logger: Logger;
  private cache: RedisCache;
  private config: NetworkProfilerConfig;
  private isActive: boolean = false;
  private requests: Map<string, NetworkRequest> = new Map();
  private completedRequests: NetworkRequest[] = [];
  private connectionMetrics: ConnectionMetrics[] = [];
  private bandwidthMetrics: BandwidthMetrics[] = [];
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private connectionPool: Map<string, net.Socket[]> = new Map();
  private requestInterceptors: Map<string, Function> = new Map();

  constructor(config: NetworkProfilerConfig, logger: Logger, cache: RedisCache) {
    super();
    this.config = config;
    this.logger = logger;
    this.cache = cache;

    if (config.enabled) {
      this.initialize();
    }
  }

  private initialize(): void {
    if (this.config.trackRequests) {
      this.setupRequestInterception();
    }

    if (this.config.trackConnections) {
      this.startConnectionMonitoring();
    }

    this.startMetricsCollection();

    this.logger.info('Network profiler initialized', {
      trackRequests: this.config.trackRequests,
      trackConnections: this.config.trackConnections,
      sampleRate: this.config.sampleRate
    });
  }

  private setupRequestInterception(): void {
    // Intercept HTTP requests
    this.interceptHttpRequests();
    
    // Intercept HTTPS requests
    this.interceptHttpsRequests();
  }

  private interceptHttpRequests(): void {
    const originalRequest = http.request;
    const self = this;

    http.request = function(options: any, callback?: any): http.ClientRequest {
      // Sample requests based on sample rate
      if (Math.random() > self.config.sampleRate) {
        return originalRequest.call(this, options, callback);
      }

      const requestId = self.generateRequestId();
      const startTime = performance.now();

      const req = originalRequest.call(this, options, callback);
      
      // Track request start
      self.trackRequestStart(requestId, req, options, startTime);

      // Track response
      req.on('response', (res) => {
        self.trackRequestResponse(requestId, res);
      });

      // Track error
      req.on('error', (error) => {
        self.trackRequestError(requestId, error);
      });

      return req;
    } as any;
  }

  private interceptHttpsRequests(): void {
    const originalRequest = https.request;
    const self = this;

    https.request = function(options: any, callback?: any): https.ClientRequest {
      // Sample requests based on sample rate
      if (Math.random() > self.config.sampleRate) {
        return originalRequest.call(this, options, callback);
      }

      const requestId = self.generateRequestId();
      const startTime = performance.now();

      const req = originalRequest.call(this, options, callback);
      
      // Track request start
      self.trackRequestStart(requestId, req, options, startTime);

      // Track response
      req.on('response', (res) => {
        self.trackRequestResponse(requestId, res);
      });

      // Track error
      req.on('error', (error) => {
        self.trackRequestError(requestId, error);
      });

      return req;
    } as any;
  }

  private trackRequestStart(
    requestId: string,
    req: http.ClientRequest,
    options: any,
    startTime: number
  ): void {
    const url = this.buildUrl(options);
    const method = options.method || 'GET';

    const networkRequest: NetworkRequest = {
      id: requestId,
      method,
      url,
      startTime,
      requestSize: this.calculateRequestSize(req, options),
      responseSize: 0,
      headers: options.headers || {},
      timing: {},
      retries: 0,
      cached: false
    };

    this.requests.set(requestId, networkRequest);

    // Track request timing
    this.trackRequestTiming(requestId, req);
  }

  private trackRequestResponse(requestId: string, res: http.IncomingMessage): void {
    const request = this.requests.get(requestId);
    if (!request) return;

    request.endTime = performance.now();
    request.duration = request.endTime - request.startTime;
    request.statusCode = res.statusCode;
    request.responseSize = this.calculateResponseSize(res);

    // Calculate timing details
    request.timing.firstByte = request.duration; // Simplified
    request.timing.download = 0; // Would be calculated during data events

    // Track response data
    let responseSize = 0;
    res.on('data', (chunk) => {
      responseSize += chunk.length;
    });

    res.on('end', () => {
      request.responseSize = responseSize;
      this.completeRequest(request);
    });

    // Check thresholds
    this.checkNetworkThresholds(request);
  }

  private trackRequestError(requestId: string, error: Error): void {
    const request = this.requests.get(requestId);
    if (!request) return;

    request.endTime = performance.now();
    request.duration = request.endTime - request.startTime;
    request.error = error.message;

    this.completeRequest(request);

    // Emit network alert for errors
    this.emit('network-alert', {
      type: 'high_error_rate',
      timestamp: Date.now(),
      value: 1,
      threshold: 0,
      message: `Network request failed: ${error.message}`,
      severity: 'medium'
    } as NetworkAlert);
  }

  private trackRequestTiming(requestId: string, req: http.ClientRequest): void {
    const request = this.requests.get(requestId);
    if (!request) return;

    // Track DNS resolution (simplified)
    req.on('socket', (socket) => {
      const dnsStart = performance.now();
      
      socket.on('lookup', () => {
        request.timing.dns = performance.now() - dnsStart;
      });

      socket.on('connect', () => {
        request.timing.connect = performance.now() - request.startTime;
      });

      if (socket.encrypted) {
        socket.on('secureConnect', () => {
          request.timing.tls = performance.now() - request.startTime;
        });
      }
    });
  }

  private completeRequest(request: NetworkRequest): void {
    this.requests.delete(request.id);
    this.completedRequests.push(request);

    // Limit completed requests
    if (this.completedRequests.length > this.config.maxRequests) {
      this.completedRequests = this.completedRequests.slice(-this.config.maxRequests);
    }

    this.emit('request-completed', request);
  }

  private startConnectionMonitoring(): void {
    const timer = setInterval(() => {
      if (!this.isActive) return;

      const metrics = this.collectConnectionMetrics();
      this.connectionMetrics.push(metrics);

      // Limit metrics
      if (this.connectionMetrics.length > 1000) {
        this.connectionMetrics = this.connectionMetrics.slice(-1000);
      }

      this.emit('connection-metrics', metrics);
    }, 5000); // Every 5 seconds

    this.timers.set('connection-monitoring', timer);
  }

  private collectConnectionMetrics(): ConnectionMetrics {
    // Get active handles (simplified approach)
    const handles = (process as any)._getActiveHandles?.() || [];
    const sockets = handles.filter((h: any) => h instanceof net.Socket);

    // Calculate bandwidth (simplified)
    const recentRequests = this.completedRequests.filter(
      r => r.endTime && (Date.now() - r.endTime) < 60000 // Last minute
    );

    const bytesIn = recentRequests.reduce((sum, r) => sum + r.responseSize, 0);
    const bytesOut = recentRequests.reduce((sum, r) => sum + r.requestSize, 0);
    const requestsPerSecond = recentRequests.length / 60;

    const latencies = recentRequests
      .filter(r => r.duration !== undefined)
      .map(r => r.duration!);
    
    const averageLatency = latencies.length > 0 
      ? latencies.reduce((sum, l) => sum + l, 0) / latencies.length 
      : 0;

    return {
      timestamp: Date.now(),
      activeConnections: sockets.length,
      totalConnections: sockets.length, // Simplified
      connectionErrors: 0, // Would track connection errors
      averageLatency,
      bandwidth: {
        bytesIn,
        bytesOut,
        requestsPerSecond
      },
      poolStats: {
        total: sockets.length,
        active: sockets.filter((s: any) => !s.destroyed).length,
        idle: 0, // Would track idle connections
        pending: 0 // Would track pending connections
      }
    };
  }

  private startMetricsCollection(): void {
    const timer = setInterval(() => {
      if (!this.isActive) return;

      const bandwidth = this.collectBandwidthMetrics();
      this.bandwidthMetrics.push(bandwidth);

      // Limit metrics
      if (this.bandwidthMetrics.length > 1000) {
        this.bandwidthMetrics = this.bandwidthMetrics.slice(-1000);
      }

      // Analyze patterns if enabled
      if (this.config.analysis.enabled) {
        this.analyzeNetworkPatterns();
      }
    }, 10000); // Every 10 seconds

    this.timers.set('metrics-collection', timer);
  }

  private collectBandwidthMetrics(): BandwidthMetrics {
    const recentRequests = this.completedRequests.filter(
      r => r.endTime && (Date.now() - r.endTime) < 10000 // Last 10 seconds
    );

    return {
      timestamp: Date.now(),
      bytesIn: recentRequests.reduce((sum, r) => sum + r.responseSize, 0),
      bytesOut: recentRequests.reduce((sum, r) => sum + r.requestSize, 0),
      packetsIn: recentRequests.length, // Simplified
      packetsOut: recentRequests.length, // Simplified
      connectionsOpened: 0, // Would track new connections
      connectionsClosed: 0, // Would track closed connections
      retransmissions: 0 // Would track retransmissions
    };
  }

  private checkNetworkThresholds(request: NetworkRequest): void {
    // Check latency threshold
    if (request.duration && request.duration > this.config.thresholds.latency) {
      this.emit('network-alert', {
        type: 'high_latency',
        timestamp: Date.now(),
        value: request.duration,
        threshold: this.config.thresholds.latency,
        message: `High latency detected: ${request.duration.toFixed(2)}ms for ${request.url}`,
        severity: request.duration > this.config.thresholds.latency * 2 ? 'high' : 'medium'
      } as NetworkAlert);
    }

    // Check error rate
    this.checkErrorRate();
  }

  private checkErrorRate(): void {
    const recentRequests = this.completedRequests.filter(
      r => r.endTime && (Date.now() - r.endTime) < 60000 // Last minute
    );

    if (recentRequests.length === 0) return;

    const errorCount = recentRequests.filter(r => r.error || (r.statusCode && r.statusCode >= 400)).length;
    const errorRate = (errorCount / recentRequests.length) * 100;

    if (errorRate > this.config.thresholds.errorRate) {
      this.emit('network-alert', {
        type: 'high_error_rate',
        timestamp: Date.now(),
        value: errorRate,
        threshold: this.config.thresholds.errorRate,
        message: `High error rate: ${errorRate.toFixed(1)}% (${errorCount}/${recentRequests.length})`,
        severity: errorRate > this.config.thresholds.errorRate * 2 ? 'critical' : 'high'
      } as NetworkAlert);
    }
  }

  private analyzeNetworkPatterns(): void {
    // Simplified pattern analysis
    const windowMs = this.config.analysis.windowSize * 60 * 1000;
    const cutoff = Date.now() - windowMs;
    const windowRequests = this.completedRequests.filter(r => 
      r.endTime && r.endTime >= cutoff
    );

    if (windowRequests.length < 10) return;

    // Detect burst patterns
    const burstThreshold = windowRequests.length / (windowMs / 60000) * 3; // 3x average rate
    this.detectBurstPattern(windowRequests, burstThreshold);
  }

  private detectBurstPattern(requests: NetworkRequest[], threshold: number): void {
    // Group requests by minute
    const requestsByMinute = new Map<number, number>();
    
    requests.forEach(request => {
      if (!request.endTime) return;
      const minute = Math.floor(request.endTime / 60000);
      requestsByMinute.set(minute, (requestsByMinute.get(minute) || 0) + 1);
    });

    // Find bursts
    const bursts = Array.from(requestsByMinute.values()).filter(count => count > threshold);
    
    if (bursts.length > 0) {
      this.emit('pattern-detected', {
        type: 'burst',
        description: `Request burst detected: ${Math.max(...bursts)} requests in one minute`,
        frequency: bursts.length,
        impact: Math.max(...bursts) > threshold * 2 ? 'high' : 'medium',
        recommendations: [
          'Consider implementing rate limiting',
          'Check for retry storms',
          'Monitor client behavior'
        ]
      } as NetworkPattern);
    }
  }

  // Utility methods
  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private buildUrl(options: any): string {
    const protocol = options.protocol || 'http:';
    const hostname = options.hostname || options.host || 'localhost';
    const port = options.port ? `:${options.port}` : '';
    const path = options.path || '/';
    
    return `${protocol}//${hostname}${port}${path}`;
  }

  private calculateRequestSize(req: http.ClientRequest, options: any): number {
    // Estimate request size (headers + body)
    let size = 0;
    
    // Headers
    const headers = options.headers || {};
    for (const [key, value] of Object.entries(headers)) {
      size += key.length + String(value).length + 4; // ": " + "\r\n"
    }
    
    // Method and path
    size += (options.method || 'GET').length;
    size += (options.path || '/').length;
    size += 20; // HTTP version and other overhead
    
    return size;
  }

  private calculateResponseSize(res: http.IncomingMessage): number {
    // Estimate response headers size
    let size = 0;
    
    if (res.headers) {
      for (const [key, value] of Object.entries(res.headers)) {
        size += key.length + String(value).length + 4;
      }
    }
    
    size += 20; // Status line overhead
    return size;
  }

  // Public API
  public start(): void {
    this.isActive = true;
    this.logger.info('Network profiler started');
  }

  public stop(): void {
    this.isActive = false;
    this.logger.info('Network profiler stopped');
  }

  public getRequests(count?: number): NetworkRequest[] {
    if (count) {
      return this.completedRequests.slice(-count);
    }
    return [...this.completedRequests];
  }

  public getActiveRequests(): NetworkRequest[] {
    return Array.from(this.requests.values());
  }

  public getConnectionMetrics(count?: number): ConnectionMetrics[] {
    if (count) {
      return this.connectionMetrics.slice(-count);
    }
    return [...this.connectionMetrics];
  }

  public getBandwidthMetrics(count?: number): BandwidthMetrics[] {
    if (count) {
      return this.bandwidthMetrics.slice(-count);
    }
    return [...this.bandwidthMetrics];
  }

  public analyzeNetwork(timeWindowMinutes: number = 30): NetworkAnalysis {
    const windowMs = timeWindowMinutes * 60 * 1000;
    const cutoff = Date.now() - windowMs;
    const relevantRequests = this.completedRequests.filter(r => 
      r.endTime && r.endTime >= cutoff
    );

    if (relevantRequests.length === 0) {
      return this.createEmptyAnalysis();
    }

    // Calculate success rate
    const successfulRequests = relevantRequests.filter(r => 
      !r.error && r.statusCode && r.statusCode < 400
    );
    const successRate = (successfulRequests.length / relevantRequests.length) * 100;

    // Calculate latency statistics
    const latencies = relevantRequests
      .filter(r => r.duration !== undefined)
      .map(r => r.duration!);
    
    const averageLatency = latencies.reduce((sum, l) => sum + l, 0) / latencies.length;
    const p95Latency = this.percentile(latencies, 95);
    const p99Latency = this.percentile(latencies, 99);

    // Calculate throughput
    const throughput = relevantRequests.length / (timeWindowMinutes * 60);

    // Calculate bandwidth
    const totalBytesIn = relevantRequests.reduce((sum, r) => sum + r.responseSize, 0);
    const totalBytesOut = relevantRequests.reduce((sum, r) => sum + r.requestSize, 0);
    const avgBytesIn = totalBytesIn / relevantRequests.length;
    const avgBytesOut = totalBytesOut / relevantRequests.length;

    // Analyze errors
    const errorRequests = relevantRequests.filter(r => 
      r.error || (r.statusCode && r.statusCode >= 400)
    );
    
    const errorsByType: Record<string, number> = {};
    errorRequests.forEach(r => {
      const errorType = r.error || `HTTP_${r.statusCode}`;
      errorsByType[errorType] = (errorsByType[errorType] || 0) + 1;
    });

    // Identify slow requests
    const slowQueries = relevantRequests
      .filter(r => r.duration && r.duration > this.config.thresholds.latency)
      .sort((a, b) => (b.duration || 0) - (a.duration || 0))
      .slice(0, 10);

    // Generate recommendations
    const recommendations = this.generateNetworkRecommendations(
      successRate, averageLatency, throughput, errorRequests.length
    );

    return {
      totalRequests: relevantRequests.length,
      successRate,
      averageLatency,
      p95Latency,
      p99Latency,
      throughput,
      bandwidth: {
        avgBytesIn,
        avgBytesOut,
        peakBytesIn: Math.max(...relevantRequests.map(r => r.responseSize), 0),
        peakBytesOut: Math.max(...relevantRequests.map(r => r.requestSize), 0)
      },
      errors: {
        total: errorRequests.length,
        byType: errorsByType,
        rate: (errorRequests.length / relevantRequests.length) * 100
      },
      slowQueries,
      patterns: [], // Would contain detected patterns
      recommendations
    };
  }

  private percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  private generateNetworkRecommendations(
    successRate: number,
    avgLatency: number,
    throughput: number,
    errorCount: number
  ): string[] {
    const recommendations: string[] = [];

    if (successRate < 95) {
      recommendations.push('Low success rate detected - investigate error causes');
    }

    if (avgLatency > this.config.thresholds.latency) {
      recommendations.push('High average latency - consider caching or CDN');
    }

    if (throughput < this.config.thresholds.throughput * 0.5) {
      recommendations.push('Low throughput - check for bottlenecks');
    }

    if (errorCount > 0) {
      recommendations.push('Network errors detected - implement retry logic');
    }

    return recommendations;
  }

  private createEmptyAnalysis(): NetworkAnalysis {
    return {
      totalRequests: 0,
      successRate: 0,
      averageLatency: 0,
      p95Latency: 0,
      p99Latency: 0,
      throughput: 0,
      bandwidth: {
        avgBytesIn: 0,
        avgBytesOut: 0,
        peakBytesIn: 0,
        peakBytesOut: 0
      },
      errors: {
        total: 0,
        byType: {},
        rate: 0
      },
      slowQueries: [],
      patterns: [],
      recommendations: ['Insufficient data for analysis']
    };
  }

  public getNetworkReport(): string {
    const analysis = this.analyzeNetwork(30);
    const latest = this.connectionMetrics[this.connectionMetrics.length - 1];

    return `Network Report:
- Total Requests (30m): ${analysis.totalRequests}
- Success Rate: ${analysis.successRate.toFixed(1)}%
- Average Latency: ${analysis.averageLatency.toFixed(2)}ms
- P95 Latency: ${analysis.p95Latency.toFixed(2)}ms
- Throughput: ${analysis.throughput.toFixed(2)} req/s
- Active Connections: ${latest?.activeConnections || 0}
- Error Rate: ${analysis.errors.rate.toFixed(1)}%
- Bandwidth In: ${(analysis.bandwidth.avgBytesIn / 1024).toFixed(2)} KB/req
- Bandwidth Out: ${(analysis.bandwidth.avgBytesOut / 1024).toFixed(2)} KB/req`;
  }

  public clearOldData(maxAge: number = 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAge;
    const originalLength = this.completedRequests.length;
    
    this.completedRequests = this.completedRequests.filter(req => 
      req.endTime && req.endTime >= cutoff
    );

    this.connectionMetrics = this.connectionMetrics.filter(metric => 
      metric.timestamp >= cutoff
    );

    this.bandwidthMetrics = this.bandwidthMetrics.filter(metric => 
      metric.timestamp >= cutoff
    );

    const removed = originalLength - this.completedRequests.length;
    if (removed > 0) {
      this.logger.info(`Cleared ${removed} old network requests`);
    }
    
    return removed;
  }

  public destroy(): void {
    this.isActive = false;
    
    // Clear timers
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();

    // Restore original HTTP methods (simplified)
    // In production, would properly restore original functions

    // Clear data
    this.requests.clear();
    this.completedRequests = [];
    this.connectionMetrics = [];
    this.bandwidthMetrics = [];

    this.logger.info('Network profiler destroyed');
  }
}
