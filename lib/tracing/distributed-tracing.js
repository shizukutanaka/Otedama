/**
 * Distributed Tracing Implementation for Otedama
 * Provides comprehensive observability across services
 * 
 * Design principles:
 * - Carmack: Minimal performance overhead
 * - Martin: Clean instrumentation boundaries
 * - Pike: Simple, automatic tracing
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { 
  BasicTracerProvider,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  BatchSpanProcessor,
  TraceIdRatioBasedSampler,
  AlwaysOnSampler,
  AlwaysOffSampler
} from '@opentelemetry/sdk-trace-base';
import { JaegerExporter } from '@opentelemetry/exporter-jaeger';
import { ZipkinExporter } from '@opentelemetry/exporter-zipkin';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { 
  trace, 
  context, 
  SpanStatusCode, 
  SpanKind,
  propagation,
  metrics
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { getLogger } from '../core/logger.js';

const logger = getLogger('DistributedTracing');

/**
 * Distributed Tracing Manager
 */
export class DistributedTracingManager {
  constructor(options = {}) {
    this.options = {
      // Service identification
      serviceName: options.serviceName || 'otedama',
      serviceVersion: options.serviceVersion || '1.0.0',
      environment: options.environment || process.env.NODE_ENV || 'development',
      
      // Tracing configuration
      enabled: options.enabled !== false,
      endpoint: options.endpoint || process.env.OTEL_EXPORTER_JAEGER_ENDPOINT || 'http://localhost:14268/api/traces',
      exporterType: options.exporterType || 'jaeger', // jaeger, zipkin, console
      
      // Sampling configuration
      samplingStrategy: options.samplingStrategy || 'ratio', // ratio, always, never, adaptive
      samplingRatio: options.samplingRatio || 0.1, // 10% sampling by default
      
      // Performance configuration
      batchSize: options.batchSize || 512,
      batchTimeout: options.batchTimeout || 5000, // 5 seconds
      maxQueueSize: options.maxQueueSize || 2048,
      
      // Auto-instrumentation
      autoInstrument: options.autoInstrument !== false,
      instrumentations: options.instrumentations || [
        'http',
        'express',
        'dns',
        'fs'
      ],
      
      // Metrics configuration
      enableMetrics: options.enableMetrics !== false,
      metricsPort: options.metricsPort || 9090,
      
      // Custom attributes
      defaultAttributes: {
        'deployment.environment': options.environment,
        'service.namespace': 'otedama',
        ...options.defaultAttributes
      },
      
      ...options
    };
    
    // Initialize tracer provider
    this.tracerProvider = null;
    this.tracer = null;
    this.meterProvider = null;
    this.meter = null;
    
    // Active spans registry
    this.activeSpans = new Map();
    
    // Statistics
    this.stats = {
      spansCreated: 0,
      spansEnded: 0,
      spansExported: 0,
      spansFailed: 0,
      tracesStarted: 0
    };
    
    if (this.options.enabled) {
      this.initialize();
    }
  }
  
  /**
   * Initialize tracing
   */
  initialize() {
    try {
      // Create resource
      const resource = Resource.default().merge(
        new Resource({
          [SemanticResourceAttributes.SERVICE_NAME]: this.options.serviceName,
          [SemanticResourceAttributes.SERVICE_VERSION]: this.options.serviceVersion,
          [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: this.options.environment,
          ...this.options.defaultAttributes
        })
      );
      
      // Create tracer provider
      this.tracerProvider = new BasicTracerProvider({
        resource,
        sampler: this._createSampler()
      });
      
      // Configure exporter
      const exporter = this._createExporter();
      
      // Configure span processor
      const spanProcessor = this.options.environment === 'production' ?
        new BatchSpanProcessor(exporter, {
          maxQueueSize: this.options.maxQueueSize,
          maxExportBatchSize: this.options.batchSize,
          scheduledDelayMillis: this.options.batchTimeout
        }) :
        new SimpleSpanProcessor(exporter);
      
      this.tracerProvider.addSpanProcessor(spanProcessor);
      
      // Register provider
      this.tracerProvider.register();
      
      // Set global propagator
      propagation.setGlobalPropagator(new W3CTraceContextPropagator());
      
      // Get tracer
      this.tracer = trace.getTracer(
        this.options.serviceName,
        this.options.serviceVersion
      );
      
      // Initialize metrics if enabled
      if (this.options.enableMetrics) {
        this._initializeMetrics();
      }
      
      // Setup auto-instrumentation if enabled
      if (this.options.autoInstrument) {
        this._setupAutoInstrumentation();
      }
      
      logger.info('Distributed tracing initialized', {
        serviceName: this.options.serviceName,
        exporter: this.options.exporterType,
        sampling: this.options.samplingRatio
      });
      
    } catch (error) {
      logger.error('Failed to initialize distributed tracing:', error);
      this.options.enabled = false;
    }
  }
  
  /**
   * Create sampler based on strategy
   */
  _createSampler() {
    switch (this.options.samplingStrategy) {
      case 'always':
        return new AlwaysOnSampler();
        
      case 'never':
        return new AlwaysOffSampler();
        
      case 'ratio':
        return new TraceIdRatioBasedSampler(this.options.samplingRatio);
        
      case 'adaptive':
        // Custom adaptive sampler
        return new AdaptiveSampler(this.options.samplingRatio);
        
      default:
        return new TraceIdRatioBasedSampler(this.options.samplingRatio);
    }
  }
  
  /**
   * Create exporter based on type
   */
  _createExporter() {
    switch (this.options.exporterType) {
      case 'jaeger':
        return new JaegerExporter({
          endpoint: this.options.endpoint,
          username: this.options.username,
          password: this.options.password
        });
        
      case 'zipkin':
        return new ZipkinExporter({
          url: this.options.endpoint,
          serviceName: this.options.serviceName
        });
        
      case 'console':
        return new ConsoleSpanExporter();
        
      default:
        throw new Error(`Unknown exporter type: ${this.options.exporterType}`);
    }
  }
  
  /**
   * Initialize metrics
   */
  _initializeMetrics() {
    // Create meter provider
    this.meterProvider = new MeterProvider({
      resource: Resource.default().merge(
        new Resource({
          [SemanticResourceAttributes.SERVICE_NAME]: this.options.serviceName
        })
      )
    });
    
    // Add Prometheus exporter
    const prometheusExporter = new PrometheusExporter({
      port: this.options.metricsPort,
      endpoint: '/metrics'
    }, () => {
      logger.info(`Prometheus metrics available at http://localhost:${this.options.metricsPort}/metrics`);
    });
    
    this.meterProvider.addMetricReader(prometheusExporter);
    
    // Register meter provider
    metrics.setGlobalMeterProvider(this.meterProvider);
    
    // Get meter
    this.meter = metrics.getMeter(this.options.serviceName, this.options.serviceVersion);
    
    // Create default metrics
    this._createDefaultMetrics();
  }
  
  /**
   * Create default metrics
   */
  _createDefaultMetrics() {
    // Request duration histogram
    this.requestDuration = this.meter.createHistogram('http_request_duration_ms', {
      description: 'HTTP request duration in milliseconds',
      unit: 'ms'
    });
    
    // Active requests gauge
    this.activeRequests = this.meter.createUpDownCounter('http_active_requests', {
      description: 'Number of active HTTP requests'
    });
    
    // Request counter
    this.requestCounter = this.meter.createCounter('http_requests_total', {
      description: 'Total number of HTTP requests'
    });
    
    // Error counter
    this.errorCounter = this.meter.createCounter('errors_total', {
      description: 'Total number of errors'
    });
  }
  
  /**
   * Setup auto-instrumentation
   */
  _setupAutoInstrumentation() {
    const instrumentations = getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-http': {
        enabled: this.options.instrumentations.includes('http')
      },
      '@opentelemetry/instrumentation-express': {
        enabled: this.options.instrumentations.includes('express')
      },
      '@opentelemetry/instrumentation-dns': {
        enabled: this.options.instrumentations.includes('dns')
      },
      '@opentelemetry/instrumentation-fs': {
        enabled: this.options.instrumentations.includes('fs')
      }
    });
    
    logger.info('Auto-instrumentation configured');
  }
  
  /**
   * Start a new trace span
   */
  startSpan(name, options = {}) {
    if (!this.options.enabled || !this.tracer) {
      return null;
    }
    
    const spanOptions = {
      kind: options.kind || SpanKind.INTERNAL,
      attributes: {
        ...this.options.defaultAttributes,
        ...options.attributes
      }
    };
    
    // Get parent context if available
    const parentContext = options.parentContext || context.active();
    
    // Start span
    const span = this.tracer.startSpan(name, spanOptions, parentContext);
    
    // Track span
    const spanId = span.spanContext().spanId;
    this.activeSpans.set(spanId, span);
    this.stats.spansCreated++;
    
    // Return span with context
    return {
      span,
      context: trace.setSpan(parentContext, span),
      end: (status) => this.endSpan(span, status)
    };
  }
  
  /**
   * End a span
   */
  endSpan(span, status) {
    if (!span) return;
    
    try {
      // Set status if provided
      if (status) {
        if (status.error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: status.error.message || 'Unknown error'
          });
          
          span.recordException(status.error);
        } else {
          span.setStatus({
            code: SpanStatusCode.OK
          });
        }
      }
      
      // End span
      span.end();
      
      // Remove from active spans
      const spanId = span.spanContext().spanId;
      this.activeSpans.delete(spanId);
      this.stats.spansEnded++;
      
    } catch (error) {
      logger.error('Error ending span:', error);
      this.stats.spansFailed++;
    }
  }
  
  /**
   * Create traced function wrapper
   */
  trace(name, fn, options = {}) {
    const self = this;
    
    return async function traced(...args) {
      const spanData = self.startSpan(name, options);
      
      if (!spanData) {
        // Tracing disabled, just execute function
        return await fn.apply(this, args);
      }
      
      const { span, context: spanContext } = spanData;
      
      try {
        // Execute function with span context
        const result = await context.with(spanContext, () => fn.apply(this, args));
        
        // End span successfully
        self.endSpan(span, { success: true });
        
        return result;
        
      } catch (error) {
        // Record error
        self.endSpan(span, { error });
        throw error;
      }
    };
  }
  
  /**
   * Express middleware for tracing
   */
  expressMiddleware() {
    const self = this;
    
    return (req, res, next) => {
      if (!self.options.enabled) {
        return next();
      }
      
      // Extract trace context from headers
      const parentContext = propagation.extract(context.active(), req.headers);
      
      // Start span
      const spanData = self.startSpan(`${req.method} ${req.path}`, {
        kind: SpanKind.SERVER,
        attributes: {
          'http.method': req.method,
          'http.url': req.url,
          'http.target': req.path,
          'http.host': req.hostname,
          'http.scheme': req.protocol,
          'http.user_agent': req.headers['user-agent'],
          'net.peer.ip': req.ip
        },
        parentContext
      });
      
      if (!spanData) {
        return next();
      }
      
      const { span, context: spanContext } = spanData;
      
      // Track request
      self.stats.tracesStarted++;
      if (self.activeRequests) {
        self.activeRequests.add(1, { method: req.method, path: req.path });
      }
      
      // Store span in request
      req.span = span;
      req.spanContext = spanContext;
      
      // Capture response
      const originalSend = res.send;
      res.send = function(data) {
        // Set response attributes
        span.setAttributes({
          'http.status_code': res.statusCode,
          'http.response_content_length': data ? data.length : 0
        });
        
        // End span
        self.endSpan(span, {
          success: res.statusCode < 400
        });
        
        // Update metrics
        if (self.requestDuration) {
          const duration = Date.now() - req._startTime;
          self.requestDuration.record(duration, {
            method: req.method,
            path: req.path,
            status: res.statusCode
          });
        }
        
        if (self.requestCounter) {
          self.requestCounter.add(1, {
            method: req.method,
            path: req.path,
            status: res.statusCode
          });
        }
        
        if (self.activeRequests) {
          self.activeRequests.add(-1, { method: req.method, path: req.path });
        }
        
        if (res.statusCode >= 400 && self.errorCounter) {
          self.errorCounter.add(1, {
            method: req.method,
            path: req.path,
            status: res.statusCode
          });
        }
        
        return originalSend.call(this, data);
      };
      
      // Continue with context
      req._startTime = Date.now();
      context.with(spanContext, () => next());
    };
  }
  
  /**
   * Database query tracing
   */
  traceDatabaseQuery(query, operation = 'query') {
    if (!this.options.enabled) {
      return async (fn) => fn();
    }
    
    return async (fn) => {
      const span = this.startSpan(`db.${operation}`, {
        kind: SpanKind.CLIENT,
        attributes: {
          'db.system': 'sqlite',
          'db.statement': query.substring(0, 100), // Truncate for security
          'db.operation': operation
        }
      });
      
      if (!span) {
        return await fn();
      }
      
      try {
        const result = await fn();
        this.endSpan(span.span, { success: true });
        return result;
      } catch (error) {
        this.endSpan(span.span, { error });
        throw error;
      }
    };
  }
  
  /**
   * External service call tracing
   */
  traceExternalCall(serviceName, operation) {
    if (!this.options.enabled) {
      return async (fn) => fn();
    }
    
    return async (fn) => {
      const span = this.startSpan(`external.${serviceName}.${operation}`, {
        kind: SpanKind.CLIENT,
        attributes: {
          'peer.service': serviceName,
          'operation': operation
        }
      });
      
      if (!span) {
        return await fn();
      }
      
      try {
        const result = await fn();
        this.endSpan(span.span, { success: true });
        return result;
      } catch (error) {
        this.endSpan(span.span, { error });
        throw error;
      }
    };
  }
  
  /**
   * Get current trace ID
   */
  getCurrentTraceId() {
    const span = trace.getActiveSpan();
    if (span) {
      return span.spanContext().traceId;
    }
    return null;
  }
  
  /**
   * Inject trace context into headers
   */
  injectTraceContext(headers = {}) {
    if (!this.options.enabled) {
      return headers;
    }
    
    const activeContext = context.active();
    propagation.inject(activeContext, headers);
    return headers;
  }
  
  /**
   * Extract trace context from headers
   */
  extractTraceContext(headers) {
    if (!this.options.enabled) {
      return context.active();
    }
    
    return propagation.extract(context.active(), headers);
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      activeSpans: this.activeSpans.size,
      enabled: this.options.enabled,
      sampling: this.options.samplingRatio
    };
  }
  
  /**
   * Shutdown tracing
   */
  async shutdown() {
    logger.info('Shutting down distributed tracing');
    
    // End all active spans
    for (const span of this.activeSpans.values()) {
      try {
        span.end();
      } catch (error) {
        logger.error('Error ending span during shutdown:', error);
      }
    }
    
    this.activeSpans.clear();
    
    // Shutdown providers
    if (this.tracerProvider) {
      await this.tracerProvider.shutdown();
    }
    
    if (this.meterProvider) {
      await this.meterProvider.shutdown();
    }
  }
}

/**
 * Adaptive sampler that adjusts sampling rate based on load
 */
class AdaptiveSampler {
  constructor(baseRate = 0.1) {
    this.baseRate = baseRate;
    this.currentRate = baseRate;
    this.requestCount = 0;
    this.lastAdjustment = Date.now();
    this.adjustmentInterval = 60000; // 1 minute
  }
  
  shouldSample(context, traceId, spanName, spanKind, attributes, links) {
    this.requestCount++;
    
    // Adjust rate periodically
    if (Date.now() - this.lastAdjustment > this.adjustmentInterval) {
      this.adjustRate();
    }
    
    // Always sample errors
    if (attributes['error'] === true) {
      return { decision: true };
    }
    
    // Sample based on current rate
    const hash = parseInt(traceId.substring(0, 8), 16);
    const threshold = this.currentRate * 0xffffffff;
    
    return {
      decision: hash < threshold,
      attributes: {
        'sampling.rate': this.currentRate,
        'sampling.adaptive': true
      }
    };
  }
  
  adjustRate() {
    const requestsPerMinute = this.requestCount;
    this.requestCount = 0;
    this.lastAdjustment = Date.now();
    
    // Adjust rate based on load
    if (requestsPerMinute > 10000) {
      // High load: reduce sampling
      this.currentRate = Math.max(0.01, this.currentRate * 0.8);
    } else if (requestsPerMinute < 1000) {
      // Low load: increase sampling
      this.currentRate = Math.min(1.0, this.currentRate * 1.2);
    } else {
      // Normal load: trend toward base rate
      this.currentRate = this.currentRate * 0.9 + this.baseRate * 0.1;
    }
  }
}

// Global tracing instance
let globalTracer = null;

/**
 * Initialize global tracer
 */
export function initializeTracing(options) {
  if (!globalTracer) {
    globalTracer = new DistributedTracingManager(options);
  }
  return globalTracer;
}

/**
 * Get global tracer
 */
export function getTracer() {
  if (!globalTracer) {
    globalTracer = new DistributedTracingManager();
  }
  return globalTracer;
}

export default DistributedTracingManager;