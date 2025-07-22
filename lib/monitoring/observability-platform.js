/**
 * Comprehensive Observability Platform
 * Metrics, logging, tracing, and monitoring in one unified system
 */

import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import { logger as baseLogger } from '../core/logger.js';
import crypto from 'crypto';

/**
 * Metrics collector with multiple backends
 */
export class MetricsCollector extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      flushInterval: 10000, // 10 seconds
      backends: ['prometheus', 'statsd', 'cloudwatch'],
      defaultLabels: {},
      histogramBuckets: [0.001, 0.01, 0.1, 0.5, 1, 5, 10],
      ...options
    };
    
    this.metrics = new Map();
    this.backends = new Map();
    this.timers = new Map();
    
    this.initializeBackends();
    this.startFlushing();
  }

  /**
   * Initialize metric backends
   */
  initializeBackends() {
    const { backends } = this.options;
    
    if (backends.includes('prometheus') && this.options.prometheus) {
      this.backends.set('prometheus', new PrometheusBackend(this.options.prometheus));
    }
    
    if (backends.includes('statsd') && this.options.statsd) {
      this.backends.set('statsd', new StatsdBackend(this.options.statsd));
    }
    
    if (backends.includes('cloudwatch') && this.options.cloudwatch) {
      this.backends.set('cloudwatch', new CloudWatchBackend(this.options.cloudwatch));
    }
  }

  /**
   * Start metric flushing
   */
  startFlushing() {
    setInterval(() => {
      this.flush();
    }, this.options.flushInterval);
  }

  /**
   * Record a counter metric
   */
  counter(name, value = 1, labels = {}) {
    const key = this.makeKey(name, labels);
    const metric = this.getOrCreateMetric(key, 'counter', labels);
    
    metric.value += value;
    metric.lastUpdate = Date.now();
    
    this.emit('metric', { type: 'counter', name, value, labels });
  }

  /**
   * Record a gauge metric
   */
  gauge(name, value, labels = {}) {
    const key = this.makeKey(name, labels);
    const metric = this.getOrCreateMetric(key, 'gauge', labels);
    
    metric.value = value;
    metric.lastUpdate = Date.now();
    
    this.emit('metric', { type: 'gauge', name, value, labels });
  }

  /**
   * Record a histogram metric
   */
  histogram(name, value, labels = {}) {
    const key = this.makeKey(name, labels);
    const metric = this.getOrCreateMetric(key, 'histogram', labels);
    
    metric.values.push(value);
    metric.sum += value;
    metric.count++;
    metric.lastUpdate = Date.now();
    
    // Update buckets
    for (let i = 0; i < this.options.histogramBuckets.length; i++) {
      if (value <= this.options.histogramBuckets[i]) {
        metric.buckets[i]++;
      }
    }
    
    this.emit('metric', { type: 'histogram', name, value, labels });
  }

  /**
   * Start a timer
   */
  timer(name, labels = {}) {
    const id = crypto.randomBytes(16).toString('hex');
    const start = performance.now();
    
    this.timers.set(id, { name, labels, start });
    
    return {
      end: () => {
        const timer = this.timers.get(id);
        if (!timer) return;
        
        const duration = (performance.now() - timer.start) / 1000; // Convert to seconds
        this.histogram(timer.name, duration, timer.labels);
        this.timers.delete(id);
        
        return duration;
      }
    };
  }

  /**
   * Get or create metric
   */
  getOrCreateMetric(key, type, labels) {
    if (!this.metrics.has(key)) {
      const metric = {
        type,
        labels: { ...this.options.defaultLabels, ...labels },
        created: Date.now(),
        lastUpdate: Date.now()
      };
      
      switch (type) {
        case 'counter':
          metric.value = 0;
          break;
        case 'gauge':
          metric.value = 0;
          break;
        case 'histogram':
          metric.values = [];
          metric.sum = 0;
          metric.count = 0;
          metric.buckets = new Array(this.options.histogramBuckets.length).fill(0);
          break;
      }
      
      this.metrics.set(key, metric);
    }
    
    return this.metrics.get(key);
  }

  /**
   * Make metric key
   */
  makeKey(name, labels) {
    const sortedLabels = Object.keys(labels).sort()
      .map(k => `${k}="${labels[k]}"`)
      .join(',');
    
    return `${name}{${sortedLabels}}`;
  }

  /**
   * Calculate histogram percentiles
   */
  calculatePercentiles(values, percentiles = [0.5, 0.9, 0.95, 0.99]) {
    if (values.length === 0) return {};
    
    const sorted = values.slice().sort((a, b) => a - b);
    const result = {};
    
    for (const p of percentiles) {
      const index = Math.ceil(sorted.length * p) - 1;
      result[`p${p * 100}`] = sorted[index];
    }
    
    return result;
  }

  /**
   * Flush metrics to backends
   */
  async flush() {
    const metricsToFlush = new Map();
    
    // Prepare metrics for flushing
    for (const [key, metric] of this.metrics) {
      if (metric.type === 'histogram' && metric.values.length > 0) {
        // Calculate percentiles
        metric.percentiles = this.calculatePercentiles(metric.values);
        metric.min = Math.min(...metric.values);
        metric.max = Math.max(...metric.values);
        metric.avg = metric.sum / metric.count;
        
        // Clear values to save memory
        metric.values = [];
      }
      
      metricsToFlush.set(key, { ...metric });
    }
    
    // Send to backends
    const flushPromises = [];
    
    for (const [name, backend] of this.backends) {
      flushPromises.push(
        backend.flush(metricsToFlush)
          .catch(error => {
            baseLogger.error(`Failed to flush metrics to ${name}:`, error);
          })
      );
    }
    
    await Promise.all(flushPromises);
    
    // Clear counters
    for (const [key, metric] of this.metrics) {
      if (metric.type === 'counter') {
        metric.value = 0;
      }
    }
  }

  /**
   * Get current metrics
   */
  getMetrics() {
    const result = {};
    
    for (const [key, metric] of this.metrics) {
      result[key] = { ...metric };
    }
    
    return result;
  }
}

/**
 * Distributed tracing system
 */
export class TracingSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      serviceName: 'otedama',
      sampleRate: 1.0,
      backends: ['jaeger', 'zipkin', 'opentelemetry'],
      propagators: ['w3c', 'b3'],
      ...options
    };
    
    this.traces = new Map();
    this.activeSpans = new Map();
    this.backends = new Map();
    
    this.initializeBackends();
  }

  /**
   * Initialize tracing backends
   */
  initializeBackends() {
    const { backends } = this.options;
    
    if (backends.includes('jaeger') && this.options.jaeger) {
      this.backends.set('jaeger', new JaegerBackend(this.options.jaeger));
    }
    
    if (backends.includes('zipkin') && this.options.zipkin) {
      this.backends.set('zipkin', new ZipkinBackend(this.options.zipkin));
    }
    
    if (backends.includes('opentelemetry') && this.options.opentelemetry) {
      this.backends.set('opentelemetry', new OpenTelemetryBackend(this.options.opentelemetry));
    }
  }

  /**
   * Start a new trace
   */
  startTrace(operationName, context = {}) {
    // Sampling decision
    if (Math.random() > this.options.sampleRate) {
      return new NoopSpan();
    }
    
    const traceId = this.generateTraceId();
    const spanId = this.generateSpanId();
    
    const span = new Span({
      traceId,
      spanId,
      operationName,
      serviceName: this.options.serviceName,
      startTime: Date.now(),
      tags: {
        'service.name': this.options.serviceName,
        ...context.tags
      }
    });
    
    this.activeSpans.set(spanId, span);
    
    if (!this.traces.has(traceId)) {
      this.traces.set(traceId, {
        traceId,
        spans: [],
        startTime: Date.now()
      });
    }
    
    return span;
  }

  /**
   * Start a child span
   */
  startSpan(operationName, parentSpan) {
    if (!parentSpan || parentSpan instanceof NoopSpan) {
      return this.startTrace(operationName);
    }
    
    const spanId = this.generateSpanId();
    
    const span = new Span({
      traceId: parentSpan.traceId,
      spanId,
      parentSpanId: parentSpan.spanId,
      operationName,
      serviceName: this.options.serviceName,
      startTime: Date.now(),
      tags: {
        'service.name': this.options.serviceName
      }
    });
    
    this.activeSpans.set(spanId, span);
    
    return span;
  }

  /**
   * Finish a span
   */
  finishSpan(span) {
    if (span instanceof NoopSpan) return;
    
    span.finish();
    
    this.activeSpans.delete(span.spanId);
    
    const trace = this.traces.get(span.traceId);
    if (trace) {
      trace.spans.push(span.toJSON());
      
      // Send to backends if trace is complete
      if (this.isTraceComplete(trace)) {
        this.sendTrace(trace);
        this.traces.delete(span.traceId);
      }
    }
  }

  /**
   * Check if trace is complete
   */
  isTraceComplete(trace) {
    // Simple heuristic: no active spans for this trace
    for (const span of this.activeSpans.values()) {
      if (span.traceId === trace.traceId) {
        return false;
      }
    }
    
    return true;
  }

  /**
   * Send trace to backends
   */
  async sendTrace(trace) {
    const sendPromises = [];
    
    for (const [name, backend] of this.backends) {
      sendPromises.push(
        backend.sendTrace(trace)
          .catch(error => {
            baseLogger.error(`Failed to send trace to ${name}:`, error);
          })
      );
    }
    
    await Promise.all(sendPromises);
    
    this.emit('trace', trace);
  }

  /**
   * Extract trace context from headers
   */
  extract(headers) {
    // W3C Trace Context
    if (headers['traceparent']) {
      const parts = headers['traceparent'].split('-');
      if (parts.length === 4) {
        return {
          traceId: parts[1],
          parentSpanId: parts[2],
          flags: parts[3]
        };
      }
    }
    
    // B3 Propagation
    if (headers['x-b3-traceid']) {
      return {
        traceId: headers['x-b3-traceid'],
        parentSpanId: headers['x-b3-spanid'],
        sampled: headers['x-b3-sampled']
      };
    }
    
    return null;
  }

  /**
   * Inject trace context into headers
   */
  inject(span, headers = {}) {
    if (span instanceof NoopSpan) return headers;
    
    // W3C Trace Context
    headers['traceparent'] = `00-${span.traceId}-${span.spanId}-01`;
    
    // B3 Propagation
    headers['x-b3-traceid'] = span.traceId;
    headers['x-b3-spanid'] = span.spanId;
    headers['x-b3-sampled'] = '1';
    
    return headers;
  }

  /**
   * Generate trace ID
   */
  generateTraceId() {
    return crypto.randomBytes(16).toString('hex');
  }

  /**
   * Generate span ID
   */
  generateSpanId() {
    return crypto.randomBytes(8).toString('hex');
  }
}

/**
 * Span implementation
 */
class Span {
  constructor(options) {
    this.traceId = options.traceId;
    this.spanId = options.spanId;
    this.parentSpanId = options.parentSpanId;
    this.operationName = options.operationName;
    this.serviceName = options.serviceName;
    this.startTime = options.startTime;
    this.endTime = null;
    this.tags = options.tags || {};
    this.logs = [];
    this.baggage = {};
  }

  /**
   * Set tag
   */
  setTag(key, value) {
    this.tags[key] = value;
    return this;
  }

  /**
   * Set multiple tags
   */
  setTags(tags) {
    Object.assign(this.tags, tags);
    return this;
  }

  /**
   * Add log
   */
  log(fields) {
    this.logs.push({
      timestamp: Date.now(),
      fields
    });
    return this;
  }

  /**
   * Set baggage item
   */
  setBaggageItem(key, value) {
    this.baggage[key] = value;
    return this;
  }

  /**
   * Get baggage item
   */
  getBaggageItem(key) {
    return this.baggage[key];
  }

  /**
   * Finish span
   */
  finish() {
    this.endTime = Date.now();
  }

  /**
   * Convert to JSON
   */
  toJSON() {
    return {
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      operationName: this.operationName,
      serviceName: this.serviceName,
      startTime: this.startTime,
      endTime: this.endTime,
      duration: this.endTime - this.startTime,
      tags: this.tags,
      logs: this.logs,
      baggage: this.baggage
    };
  }
}

/**
 * No-op span for when sampling is disabled
 */
class NoopSpan {
  setTag() { return this; }
  setTags() { return this; }
  log() { return this; }
  setBaggageItem() { return this; }
  getBaggageItem() { return null; }
  finish() {}
}

/**
 * Centralized logging system
 */
export class LoggingSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      level: 'info',
      format: 'json',
      outputs: ['console', 'file', 'elasticsearch'],
      bufferSize: 1000,
      flushInterval: 5000,
      ...options
    };
    
    this.levels = {
      error: 0,
      warn: 1,
      info: 2,
      debug: 3,
      trace: 4
    };
    
    this.buffer = [];
    this.outputs = new Map();
    
    this.initializeOutputs();
    this.startFlushing();
  }

  /**
   * Initialize log outputs
   */
  initializeOutputs() {
    const { outputs } = this.options;
    
    if (outputs.includes('console')) {
      this.outputs.set('console', new ConsoleOutput(this.options));
    }
    
    if (outputs.includes('file') && this.options.file) {
      this.outputs.set('file', new FileOutput(this.options.file));
    }
    
    if (outputs.includes('elasticsearch') && this.options.elasticsearch) {
      this.outputs.set('elasticsearch', new ElasticsearchOutput(this.options.elasticsearch));
    }
  }

  /**
   * Start log flushing
   */
  startFlushing() {
    setInterval(() => {
      this.flush();
    }, this.options.flushInterval);
  }

  /**
   * Log a message
   */
  log(level, message, context = {}) {
    if (this.levels[level] > this.levels[this.options.level]) {
      return;
    }
    
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: {
        ...this.enrichContext(),
        ...context
      }
    };
    
    this.buffer.push(entry);
    
    if (this.buffer.length >= this.options.bufferSize) {
      this.flush();
    }
    
    this.emit('log', entry);
  }

  /**
   * Log methods
   */
  error(message, context) {
    this.log('error', message, context);
  }

  warn(message, context) {
    this.log('warn', message, context);
  }

  info(message, context) {
    this.log('info', message, context);
  }

  debug(message, context) {
    this.log('debug', message, context);
  }

  trace(message, context) {
    this.log('trace', message, context);
  }

  /**
   * Enrich log context
   */
  enrichContext() {
    return {
      service: this.options.serviceName,
      hostname: require('os').hostname(),
      pid: process.pid,
      timestamp: Date.now()
    };
  }

  /**
   * Flush logs to outputs
   */
  async flush() {
    if (this.buffer.length === 0) return;
    
    const logs = this.buffer.slice();
    this.buffer = [];
    
    const flushPromises = [];
    
    for (const [name, output] of this.outputs) {
      flushPromises.push(
        output.write(logs)
          .catch(error => {
            console.error(`Failed to flush logs to ${name}:`, error);
          })
      );
    }
    
    await Promise.all(flushPromises);
  }

  /**
   * Create child logger
   */
  child(context) {
    const childLogger = Object.create(this);
    
    childLogger.log = (level, message, ctx = {}) => {
      this.log(level, message, { ...context, ...ctx });
    };
    
    return childLogger;
  }
}

/**
 * Alerting system
 */
export class AlertingSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      channels: ['email', 'slack', 'pagerduty', 'webhook'],
      rules: [],
      cooldown: 300000, // 5 minutes
      ...options
    };
    
    this.channels = new Map();
    this.alerts = new Map();
    this.cooldowns = new Map();
    
    this.initializeChannels();
    this.loadRules();
  }

  /**
   * Initialize alert channels
   */
  initializeChannels() {
    const { channels } = this.options;
    
    if (channels.includes('email') && this.options.email) {
      this.channels.set('email', new EmailChannel(this.options.email));
    }
    
    if (channels.includes('slack') && this.options.slack) {
      this.channels.set('slack', new SlackChannel(this.options.slack));
    }
    
    if (channels.includes('pagerduty') && this.options.pagerduty) {
      this.channels.set('pagerduty', new PagerDutyChannel(this.options.pagerduty));
    }
    
    if (channels.includes('webhook') && this.options.webhook) {
      this.channels.set('webhook', new WebhookChannel(this.options.webhook));
    }
  }

  /**
   * Load alert rules
   */
  loadRules() {
    this.rules = this.options.rules.map(rule => ({
      id: rule.id || crypto.randomBytes(8).toString('hex'),
      name: rule.name,
      condition: rule.condition,
      severity: rule.severity || 'warning',
      channels: rule.channels || Array.from(this.channels.keys()),
      cooldown: rule.cooldown || this.options.cooldown,
      metadata: rule.metadata || {}
    }));
  }

  /**
   * Check alert conditions
   */
  async check(metrics) {
    for (const rule of this.rules) {
      try {
        const triggered = await this.evaluateCondition(rule.condition, metrics);
        
        if (triggered) {
          await this.triggerAlert(rule, metrics);
        } else {
          this.resolveAlert(rule.id);
        }
      } catch (error) {
        baseLogger.error(`Failed to check alert rule ${rule.name}:`, error);
      }
    }
  }

  /**
   * Evaluate alert condition
   */
  async evaluateCondition(condition, metrics) {
    // Simple expression evaluation
    // In production, use a proper expression evaluator
    if (typeof condition === 'function') {
      return condition(metrics);
    }
    
    // Parse simple conditions like "cpu > 80"
    const match = condition.match(/(\w+)\s*([><=]+)\s*(\d+)/);
    if (match) {
      const [, metric, operator, threshold] = match;
      const value = metrics[metric];
      
      switch (operator) {
        case '>':
          return value > parseFloat(threshold);
        case '<':
          return value < parseFloat(threshold);
        case '>=':
          return value >= parseFloat(threshold);
        case '<=':
          return value <= parseFloat(threshold);
        case '=':
        case '==':
          return value == parseFloat(threshold);
      }
    }
    
    return false;
  }

  /**
   * Trigger alert
   */
  async triggerAlert(rule, metrics) {
    const alertId = rule.id;
    
    // Check cooldown
    if (this.isInCooldown(alertId)) {
      return;
    }
    
    const alert = {
      id: alertId,
      rule: rule.name,
      severity: rule.severity,
      triggered: Date.now(),
      metrics,
      metadata: rule.metadata
    };
    
    this.alerts.set(alertId, alert);
    this.setCooldown(alertId, rule.cooldown);
    
    // Send to channels
    const sendPromises = [];
    
    for (const channelName of rule.channels) {
      const channel = this.channels.get(channelName);
      if (channel) {
        sendPromises.push(
          channel.send(alert)
            .catch(error => {
              baseLogger.error(`Failed to send alert to ${channelName}:`, error);
            })
        );
      }
    }
    
    await Promise.all(sendPromises);
    
    this.emit('alert', alert);
  }

  /**
   * Resolve alert
   */
  resolveAlert(alertId) {
    if (this.alerts.has(alertId)) {
      const alert = this.alerts.get(alertId);
      alert.resolved = Date.now();
      
      this.emit('resolve', alert);
      this.alerts.delete(alertId);
    }
  }

  /**
   * Check if alert is in cooldown
   */
  isInCooldown(alertId) {
    const cooldown = this.cooldowns.get(alertId);
    return cooldown && Date.now() < cooldown;
  }

  /**
   * Set cooldown
   */
  setCooldown(alertId, duration) {
    this.cooldowns.set(alertId, Date.now() + duration);
  }
}

/**
 * Unified observability platform
 */
export class ObservabilityPlatform extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      serviceName: 'otedama',
      environment: process.env.NODE_ENV || 'development',
      ...options
    };
    
    // Initialize subsystems
    this.metrics = new MetricsCollector({
      ...options.metrics,
      defaultLabels: {
        service: this.options.serviceName,
        environment: this.options.environment
      }
    });
    
    this.tracing = new TracingSystem({
      ...options.tracing,
      serviceName: this.options.serviceName
    });
    
    this.logging = new LoggingSystem({
      ...options.logging,
      serviceName: this.options.serviceName
    });
    
    this.alerting = new AlertingSystem(options.alerting);
    
    // Health checks
    this.healthChecks = new Map();
    
    // Connect subsystems
    this.connectSubsystems();
    
    // Start monitoring
    this.startMonitoring();
  }

  /**
   * Connect subsystems
   */
  connectSubsystems() {
    // Log metrics
    this.metrics.on('metric', metric => {
      this.logging.debug('Metric recorded', metric);
    });
    
    // Log traces
    this.tracing.on('trace', trace => {
      this.logging.debug('Trace completed', {
        traceId: trace.traceId,
        spanCount: trace.spans.length,
        duration: Math.max(...trace.spans.map(s => s.endTime)) - trace.startTime
      });
    });
    
    // Alert on metrics
    setInterval(() => {
      const metrics = this.metrics.getMetrics();
      this.alerting.check(metrics);
    }, 30000); // Every 30 seconds
  }

  /**
   * Start monitoring
   */
  startMonitoring() {
    // System metrics
    setInterval(() => {
      this.collectSystemMetrics();
    }, 10000); // Every 10 seconds
    
    // Health checks
    setInterval(() => {
      this.runHealthChecks();
    }, 30000); // Every 30 seconds
  }

  /**
   * Collect system metrics
   */
  collectSystemMetrics() {
    const usage = process.cpuUsage();
    const memory = process.memoryUsage();
    
    // CPU metrics
    this.metrics.gauge('system.cpu.user', usage.user / 1000000);
    this.metrics.gauge('system.cpu.system', usage.system / 1000000);
    
    // Memory metrics
    this.metrics.gauge('system.memory.rss', memory.rss);
    this.metrics.gauge('system.memory.heap.total', memory.heapTotal);
    this.metrics.gauge('system.memory.heap.used', memory.heapUsed);
    this.metrics.gauge('system.memory.external', memory.external);
    
    // Event loop metrics
    const lag = this.measureEventLoopLag();
    this.metrics.histogram('system.eventloop.lag', lag);
    
    // GC metrics
    if (global.gc) {
      const before = process.memoryUsage();
      global.gc();
      const after = process.memoryUsage();
      
      this.metrics.counter('system.gc.count');
      this.metrics.histogram('system.gc.duration', (after.heapUsed - before.heapUsed) / 1000000);
    }
  }

  /**
   * Measure event loop lag
   */
  measureEventLoopLag() {
    const start = process.hrtime.bigint();
    
    setImmediate(() => {
      const end = process.hrtime.bigint();
      const lag = Number(end - start) / 1000000; // Convert to milliseconds
      return lag;
    });
    
    return 0; // Placeholder
  }

  /**
   * Register health check
   */
  registerHealthCheck(name, check) {
    this.healthChecks.set(name, check);
  }

  /**
   * Run health checks
   */
  async runHealthChecks() {
    const results = {};
    const overallHealthy = true;
    
    for (const [name, check] of this.healthChecks) {
      try {
        const result = await check();
        results[name] = {
          status: result.healthy ? 'healthy' : 'unhealthy',
          message: result.message,
          timestamp: Date.now()
        };
        
        if (!result.healthy) {
          overallHealthy = false;
        }
      } catch (error) {
        results[name] = {
          status: 'unhealthy',
          message: error.message,
          timestamp: Date.now()
        };
        overallHealthy = false;
      }
    }
    
    this.emit('health', {
      healthy: overallHealthy,
      checks: results
    });
    
    // Record health metrics
    this.metrics.gauge('health.status', overallHealthy ? 1 : 0);
  }

  /**
   * Create context for request
   */
  createContext(req) {
    const span = this.tracing.extract(req.headers)
      ? this.tracing.startSpan('http.request', this.tracing.extract(req.headers))
      : this.tracing.startTrace('http.request');
    
    span.setTags({
      'http.method': req.method,
      'http.url': req.url,
      'http.remote_addr': req.ip,
      'user.id': req.user?.id
    });
    
    const logger = this.logging.child({
      traceId: span.traceId,
      spanId: span.spanId,
      requestId: req.id
    });
    
    return {
      span,
      logger,
      metrics: this.metrics,
      startTimer: (name) => this.metrics.timer(name, { traceId: span.traceId })
    };
  }

  /**
   * Express middleware
   */
  middleware() {
    return (req, res, next) => {
      const context = this.createContext(req);
      req.observability = context;
      
      // Track request
      this.metrics.counter('http.requests', 1, {
        method: req.method,
        path: req.route?.path || req.path
      });
      
      // Time request
      const timer = context.startTimer('http.request.duration');
      
      // Intercept response
      const originalSend = res.send;
      res.send = function(data) {
        // Finish timing
        const duration = timer.end();
        
        // Track response
        context.metrics.counter('http.responses', 1, {
          method: req.method,
          path: req.route?.path || req.path,
          status: res.statusCode
        });
        
        // Finish span
        context.span.setTag('http.status_code', res.statusCode);
        context.span.finish();
        req.observability.tracing.finishSpan(context.span);
        
        // Log request
        context.logger.info('Request completed', {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          duration: duration * 1000 // Convert to ms
        });
        
        return originalSend.call(this, data);
      };
      
      next();
    };
  }

  /**
   * Get dashboard data
   */
  getDashboardData() {
    return {
      metrics: this.metrics.getMetrics(),
      traces: Array.from(this.tracing.traces.values()),
      alerts: Array.from(this.alerting.alerts.values()),
      health: this.lastHealth || { healthy: true, checks: {} }
    };
  }
}

// Backend implementations would go here...
// For brevity, these are placeholder classes

class PrometheusBackend {
  async flush(metrics) {
    // Implementation would format and send metrics to Prometheus
  }
}

class StatsdBackend {
  async flush(metrics) {
    // Implementation would send metrics to StatsD
  }
}

class CloudWatchBackend {
  async flush(metrics) {
    // Implementation would send metrics to AWS CloudWatch
  }
}

class JaegerBackend {
  async sendTrace(trace) {
    // Implementation would send trace to Jaeger
  }
}

class ZipkinBackend {
  async sendTrace(trace) {
    // Implementation would send trace to Zipkin
  }
}

class OpenTelemetryBackend {
  async sendTrace(trace) {
    // Implementation would send trace via OpenTelemetry
  }
}

class ConsoleOutput {
  async write(logs) {
    logs.forEach(log => console.log(JSON.stringify(log)));
  }
}

class FileOutput {
  async write(logs) {
    // Implementation would write to file
  }
}

class ElasticsearchOutput {
  async write(logs) {
    // Implementation would send to Elasticsearch
  }
}

class EmailChannel {
  async send(alert) {
    // Implementation would send email
  }
}

class SlackChannel {
  async send(alert) {
    // Implementation would send to Slack
  }
}

class PagerDutyChannel {
  async send(alert) {
    // Implementation would send to PagerDuty
  }
}

class WebhookChannel {
  async send(alert) {
    // Implementation would call webhook
  }
}

export default ObservabilityPlatform;