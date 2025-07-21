/**
 * Distributed Tracing System for Otedama
 * Tracks requests across multiple services and components
 * 
 * Design principles:
 * - Carmack: Minimal overhead, zero-allocation where possible
 * - Martin: Clean separation of tracing concerns
 * - Pike: Simple and efficient tracing
 */

import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import { performance } from 'perf_hooks';
import { logger } from '../core/logger.js';

// Trace context version
const TRACE_VERSION = '00';

// Trace flags
export const TraceFlags = {
  NONE: 0x00,
  SAMPLED: 0x01,
  DEBUG: 0x02
};

// Span kinds
export const SpanKind = {
  INTERNAL: 'INTERNAL',
  SERVER: 'SERVER',
  CLIENT: 'CLIENT',
  PRODUCER: 'PRODUCER',
  CONSUMER: 'CONSUMER'
};

// Span status
export const SpanStatus = {
  UNSET: 'UNSET',
  OK: 'OK',
  ERROR: 'ERROR'
};

/**
 * Trace context following W3C Trace Context specification
 */
export class TraceContext {
  constructor(traceId = null, spanId = null, flags = TraceFlags.NONE) {
    this.traceId = traceId || this.generateTraceId();
    this.spanId = spanId || this.generateSpanId();
    this.flags = flags;
    this.version = TRACE_VERSION;
  }
  
  generateTraceId() {
    return randomBytes(16).toString('hex');
  }
  
  generateSpanId() {
    return randomBytes(8).toString('hex');
  }
  
  toString() {
    return `${this.version}-${this.traceId}-${this.spanId}-${this.flags.toString(16).padStart(2, '0')}`;
  }
  
  static fromString(traceParent) {
    if (!traceParent) return null;
    
    const parts = traceParent.split('-');
    if (parts.length !== 4) return null;
    
    return new TraceContext(
      parts[1],
      parts[2],
      parseInt(parts[3], 16)
    );
  }
  
  createChild() {
    return new TraceContext(this.traceId, this.generateSpanId(), this.flags);
  }
  
  isSampled() {
    return (this.flags & TraceFlags.SAMPLED) !== 0;
  }
}

/**
 * Span represents a unit of work in a trace
 */
export class Span {
  constructor(tracer, context, name, options = {}) {
    this.tracer = tracer;
    this.context = context;
    this.name = name;
    this.kind = options.kind || SpanKind.INTERNAL;
    this.parentSpanId = options.parentSpanId;
    
    // Timing
    this.startTime = performance.now();
    this.startTimestamp = Date.now();
    this.endTime = null;
    this.duration = null;
    
    // Status
    this.status = SpanStatus.UNSET;
    this.statusMessage = null;
    
    // Attributes and events
    this.attributes = new Map();
    this.events = [];
    this.links = [];
    
    // Set initial attributes
    if (options.attributes) {
      for (const [key, value] of Object.entries(options.attributes)) {
        this.setAttribute(key, value);
      }
    }
  }
  
  setAttribute(key, value) {
    if (this.endTime) return this;
    
    // Validate attribute
    if (typeof key !== 'string' || key.length === 0) return this;
    
    // Convert value to appropriate type
    if (value === null || value === undefined) {
      this.attributes.delete(key);
    } else {
      this.attributes.set(key, this._sanitizeValue(value));
    }
    
    return this;
  }
  
  setAttributes(attributes) {
    for (const [key, value] of Object.entries(attributes)) {
      this.setAttribute(key, value);
    }
    return this;
  }
  
  addEvent(name, attributes = {}) {
    if (this.endTime) return this;
    
    this.events.push({
      name,
      timestamp: Date.now(),
      attributes: this._sanitizeAttributes(attributes)
    });
    
    return this;
  }
  
  setStatus(status, message = null) {
    if (this.endTime) return this;
    
    this.status = status;
    this.statusMessage = message;
    
    return this;
  }
  
  recordException(error, attributes = {}) {
    this.setStatus(SpanStatus.ERROR, error.message);
    
    this.addEvent('exception', {
      'exception.type': error.constructor.name,
      'exception.message': error.message,
      'exception.stacktrace': error.stack,
      ...attributes
    });
    
    return this;
  }
  
  end(endTime = null) {
    if (this.endTime) return;
    
    this.endTime = endTime || performance.now();
    this.duration = this.endTime - this.startTime;
    
    // Export span
    this.tracer.export(this);
  }
  
  toJSON() {
    return {
      traceId: this.context.traceId,
      spanId: this.context.spanId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      kind: this.kind,
      startTime: this.startTimestamp,
      endTime: this.endTime ? this.startTimestamp + this.duration : null,
      duration: this.duration,
      status: this.status,
      statusMessage: this.statusMessage,
      attributes: Object.fromEntries(this.attributes),
      events: this.events,
      links: this.links
    };
  }
  
  _sanitizeValue(value) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(v => this._sanitizeValue(v));
    }
    return String(value);
  }
  
  _sanitizeAttributes(attributes) {
    const sanitized = {};
    for (const [key, value] of Object.entries(attributes)) {
      if (typeof key === 'string' && key.length > 0) {
        sanitized[key] = this._sanitizeValue(value);
      }
    }
    return sanitized;
  }
}

/**
 * Tracer manages spans and exports them
 */
export class Tracer extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      serviceName: options.serviceName || 'otedama',
      serviceVersion: options.serviceVersion || '1.0.0',
      
      // Sampling
      samplingRate: options.samplingRate !== undefined ? options.samplingRate : 1.0,
      samplingStrategy: options.samplingStrategy || 'probabilistic',
      
      // Export
      exportInterval: options.exportInterval || 5000,
      maxExportBatchSize: options.maxExportBatchSize || 512,
      maxQueueSize: options.maxQueueSize || 2048,
      
      // Performance
      enableAutoInstrumentation: options.enableAutoInstrumentation !== false,
      recordStackTraces: options.recordStackTraces || false,
      
      ...options
    };
    
    // Span storage
    this.activeSpans = new Map();
    this.completedSpans = [];
    this.spanIdCounter = 0;
    
    // Exporters
    this.exporters = [];
    
    // Context storage
    this.contextStorage = new Map();
    
    // Metrics
    this.metrics = {
      spansCreated: 0,
      spansCompleted: 0,
      spansExported: 0,
      spansSampled: 0,
      spansDropped: 0
    };
    
    // Start export timer
    this.exportTimer = setInterval(() => {
      this.flush().catch(error => {
        logger.error('Failed to export traces', error);
      });
    }, this.options.exportInterval);
  }
  
  /**
   * Start a new span
   */
  startSpan(name, options = {}) {
    // Get parent context
    const parentContext = options.parent || this.getCurrentContext();
    
    // Create new context
    let context;
    if (parentContext) {
      context = parentContext.createChild();
    } else {
      context = new TraceContext();
      
      // Apply sampling decision
      if (this.shouldSample(name, options)) {
        context.flags |= TraceFlags.SAMPLED;
        this.metrics.spansSampled++;
      }
    }
    
    // Create span
    const span = new Span(this, context, name, {
      ...options,
      parentSpanId: parentContext?.spanId
    });
    
    // Set service attributes
    span.setAttributes({
      'service.name': this.options.serviceName,
      'service.version': this.options.serviceVersion
    });
    
    // Track active span
    this.activeSpans.set(context.spanId, span);
    this.metrics.spansCreated++;
    
    // Set as current context if requested
    if (options.setAsCurrent !== false) {
      this.setCurrentContext(context);
    }
    
    return span;
  }
  
  /**
   * Create a span and execute function within its context
   */
  async trace(name, fn, options = {}) {
    const span = this.startSpan(name, options);
    
    try {
      const result = await fn(span);
      span.setStatus(SpanStatus.OK);
      return result;
    } catch (error) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  }
  
  /**
   * Export completed span
   */
  export(span) {
    // Remove from active spans
    this.activeSpans.delete(span.context.spanId);
    
    // Only export sampled spans
    if (!span.context.isSampled()) {
      return;
    }
    
    // Add to export queue
    this.completedSpans.push(span);
    this.metrics.spansCompleted++;
    
    // Check queue size
    if (this.completedSpans.length >= this.options.maxExportBatchSize) {
      this.flush().catch(error => {
        logger.error('Failed to export traces', error);
      });
    } else if (this.completedSpans.length > this.options.maxQueueSize) {
      // Drop oldest spans
      const dropped = this.completedSpans.splice(0, 
        this.completedSpans.length - this.options.maxQueueSize
      );
      this.metrics.spansDropped += dropped.length;
    }
  }
  
  /**
   * Flush completed spans to exporters
   */
  async flush() {
    if (this.completedSpans.length === 0) return;
    
    const spans = this.completedSpans.splice(0, this.options.maxExportBatchSize);
    
    // Export to all exporters
    const exportPromises = this.exporters.map(exporter => 
      exporter.export(spans).catch(error => {
        logger.error('Exporter failed', { exporter: exporter.name, error });
      })
    );
    
    await Promise.all(exportPromises);
    this.metrics.spansExported += spans.length;
  }
  
  /**
   * Add an exporter
   */
  addExporter(exporter) {
    this.exporters.push(exporter);
  }
  
  /**
   * Sampling decision
   */
  shouldSample(name, options) {
    // Always sample if debug flag is set
    if (options.debug) return true;
    
    // Apply sampling strategy
    switch (this.options.samplingStrategy) {
      case 'always':
        return true;
        
      case 'never':
        return false;
        
      case 'probabilistic':
        return Math.random() < this.options.samplingRate;
        
      case 'adaptive':
        // Implement adaptive sampling based on load
        return this.adaptiveSample(name);
        
      default:
        return true;
    }
  }
  
  adaptiveSample(name) {
    // Simple adaptive sampling - reduce rate under load
    const activeCount = this.activeSpans.size;
    const targetRate = this.options.samplingRate;
    
    if (activeCount < 100) {
      return Math.random() < targetRate;
    } else if (activeCount < 500) {
      return Math.random() < (targetRate * 0.5);
    } else {
      return Math.random() < (targetRate * 0.1);
    }
  }
  
  /**
   * Context management
   */
  getCurrentContext() {
    // In a real implementation, this would use AsyncLocalStorage
    return this.contextStorage.get('current');
  }
  
  setCurrentContext(context) {
    this.contextStorage.set('current', context);
  }
  
  /**
   * Extract context from carrier (e.g., HTTP headers)
   */
  extract(carrier, getter = defaultGetter) {
    const traceParent = getter(carrier, 'traceparent');
    if (!traceParent) return null;
    
    const context = TraceContext.fromString(traceParent);
    
    // Extract trace state if present
    const traceState = getter(carrier, 'tracestate');
    if (traceState && context) {
      context.traceState = traceState;
    }
    
    return context;
  }
  
  /**
   * Inject context into carrier
   */
  inject(context, carrier, setter = defaultSetter) {
    if (!context) return;
    
    setter(carrier, 'traceparent', context.toString());
    
    if (context.traceState) {
      setter(carrier, 'tracestate', context.traceState);
    }
  }
  
  /**
   * Get tracer metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      activeSpans: this.activeSpans.size,
      queuedSpans: this.completedSpans.length,
      exporters: this.exporters.length
    };
  }
  
  /**
   * Shutdown tracer
   */
  async shutdown() {
    // Stop export timer
    if (this.exportTimer) {
      clearInterval(this.exportTimer);
    }
    
    // Export remaining spans
    await this.flush();
    
    // Shutdown exporters
    await Promise.all(
      this.exporters.map(exporter => 
        exporter.shutdown?.().catch(error => {
          logger.error('Failed to shutdown exporter', error);
        })
      )
    );
    
    this.emit('shutdown');
  }
}

// Default getter/setter for context propagation
const defaultGetter = (carrier, key) => carrier[key];
const defaultSetter = (carrier, key, value) => { carrier[key] = value; };

// Global tracer instance
let globalTracer = null;

/**
 * Get or create global tracer
 */
export function getTracer(options) {
  if (!globalTracer) {
    globalTracer = new Tracer(options);
  }
  return globalTracer;
}

/**
 * Set global tracer
 */
export function setGlobalTracer(tracer) {
  globalTracer = tracer;
}

export default Tracer;