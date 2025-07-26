/**
 * OpenTelemetry Distributed Tracing - Otedama
 * Enterprise-grade observability and monitoring
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';

const logger = createLogger('OpenTelemetry');

// Span kinds
export const SpanKind = {
  INTERNAL: 'INTERNAL',
  SERVER: 'SERVER',
  CLIENT: 'CLIENT',
  PRODUCER: 'PRODUCER',
  CONSUMER: 'CONSUMER'
};

// Span status codes
export const SpanStatusCode = {
  UNSET: 0,
  OK: 1,
  ERROR: 2
};

/**
 * Tracer Provider
 */
export class TracerProvider extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      serviceName: options.serviceName || 'otedama',
      serviceVersion: options.serviceVersion || '1.0.0',
      exportInterval: options.exportInterval || 5000,
      maxQueueSize: options.maxQueueSize || 2048,
      maxExportBatchSize: options.maxExportBatchSize || 512,
      enableAutoInstrumentation: options.enableAutoInstrumentation !== false,
      samplingRatio: options.samplingRatio || 1.0,
      ...options
    };
    
    this.tracers = new Map();
    this.spanProcessors = [];
    this.exporters = [];
    this.resource = this.createResource();
    
    this.stats = {
      spansCreated: 0,
      spansEnded: 0,
      spansExported: 0,
      spansSampled: 0,
      exportErrors: 0
    };
  }
  
  /**
   * Initialize tracer provider
   */
  async initialize() {
    logger.info('Initializing OpenTelemetry tracer provider...');
    
    // Add default span processors
    this.addSpanProcessor(new BatchSpanProcessor(this));
    
    // Add default exporters
    if (this.config.consoleExporter) {
      this.addExporter(new ConsoleSpanExporter());
    }
    
    if (this.config.otlpEndpoint) {
      this.addExporter(new OTLPSpanExporter({
        endpoint: this.config.otlpEndpoint,
        headers: this.config.otlpHeaders
      }));
    }
    
    // Start auto-instrumentation if enabled
    if (this.config.enableAutoInstrumentation) {
      this.setupAutoInstrumentation();
    }
    
    logger.info('OpenTelemetry tracer provider initialized');
    this.emit('initialized');
  }
  
  /**
   * Get or create tracer
   */
  getTracer(name, version) {
    const key = `${name}@${version || 'latest'}`;
    
    if (!this.tracers.has(key)) {
      const tracer = new Tracer(this, name, version);
      this.tracers.set(key, tracer);
    }
    
    return this.tracers.get(key);
  }
  
  /**
   * Create resource
   */
  createResource() {
    return {
      'service.name': this.config.serviceName,
      'service.version': this.config.serviceVersion,
      'service.instance.id': this.generateInstanceId(),
      'telemetry.sdk.name': 'otedama-opentelemetry',
      'telemetry.sdk.version': '1.0.0',
      'telemetry.sdk.language': 'javascript',
      'process.pid': process.pid,
      'process.runtime.name': 'node',
      'process.runtime.version': process.version,
      ...this.config.resourceAttributes
    };
  }
  
  /**
   * Add span processor
   */
  addSpanProcessor(processor) {
    this.spanProcessors.push(processor);
    processor.initialize(this);
  }
  
  /**
   * Add exporter
   */
  addExporter(exporter) {
    this.exporters.push(exporter);
  }
  
  /**
   * Process span
   */
  processSpan(span) {
    for (const processor of this.spanProcessors) {
      processor.onStart(span);
    }
  }
  
  /**
   * Finish span
   */
  finishSpan(span) {
    for (const processor of this.spanProcessors) {
      processor.onEnd(span);
    }
  }
  
  /**
   * Setup auto-instrumentation
   */
  setupAutoInstrumentation() {
    // HTTP instrumentation
    if (this.config.instrumentHttp) {
      this.instrumentHttp();
    }
    
    // Database instrumentation
    if (this.config.instrumentDatabase) {
      this.instrumentDatabase();
    }
    
    // Mining operations instrumentation
    this.instrumentMiningOperations();
  }
  
  /**
   * Instrument HTTP
   */
  instrumentHttp() {
    // Would instrument HTTP client/server in production
    logger.debug('HTTP instrumentation enabled');
  }
  
  /**
   * Instrument database
   */
  instrumentDatabase() {
    // Would instrument database queries in production
    logger.debug('Database instrumentation enabled');
  }
  
  /**
   * Instrument mining operations
   */
  instrumentMiningOperations() {
    // Instrument share validation
    this.on('share:validate', (data) => {
      const span = this.getTracer('mining').startSpan('validate_share', {
        kind: SpanKind.INTERNAL,
        attributes: {
          'miner.id': data.minerId,
          'share.difficulty': data.difficulty
        }
      });
      
      data.span = span;
    });
    
    // Instrument block found
    this.on('block:found', (data) => {
      const span = this.getTracer('mining').startSpan('block_found', {
        kind: SpanKind.INTERNAL,
        attributes: {
          'block.height': data.height,
          'block.hash': data.hash,
          'block.reward': data.reward
        }
      });
      
      span.addEvent('block_discovered');
      span.end();
    });
  }
  
  /**
   * Generate instance ID
   */
  generateInstanceId() {
    return `${this.config.serviceName}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * Should sample
   */
  shouldSample(traceId, spanName, spanKind, attributes) {
    // Simple probability sampling
    return Math.random() < this.config.samplingRatio;
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      activeTracers: this.tracers.size,
      processors: this.spanProcessors.length,
      exporters: this.exporters.length
    };
  }
  
  /**
   * Shutdown
   */
  async shutdown() {
    logger.info('Shutting down OpenTelemetry tracer provider...');
    
    // Flush all processors
    for (const processor of this.spanProcessors) {
      await processor.shutdown();
    }
    
    // Shutdown exporters
    for (const exporter of this.exporters) {
      if (exporter.shutdown) {
        await exporter.shutdown();
      }
    }
    
    this.removeAllListeners();
    logger.info('OpenTelemetry tracer provider shutdown complete');
  }
}

/**
 * Tracer implementation
 */
export class Tracer {
  constructor(provider, name, version) {
    this.provider = provider;
    this.instrumentationName = name;
    this.instrumentationVersion = version;
  }
  
  /**
   * Start span
   */
  startSpan(name, options = {}) {
    const span = new Span(this, name, options);
    
    // Check sampling decision
    const shouldSample = this.provider.shouldSample(
      span.spanContext.traceId,
      name,
      options.kind || SpanKind.INTERNAL,
      options.attributes || {}
    );
    
    if (shouldSample) {
      span.isRecording = true;
      this.provider.stats.spansSampled++;
    }
    
    this.provider.stats.spansCreated++;
    this.provider.processSpan(span);
    
    return span;
  }
  
  /**
   * Start active span
   */
  startActiveSpan(name, options, fn) {
    const span = this.startSpan(name, options);
    
    try {
      const result = fn(span);
      
      if (result && typeof result.then === 'function') {
        return result
          .then(value => {
            span.end();
            return value;
          })
          .catch(error => {
            span.recordException(error);
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.end();
            throw error;
          });
      }
      
      span.end();
      return result;
      
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      throw error;
    }
  }
}

/**
 * Span implementation
 */
export class Span {
  constructor(tracer, name, options = {}) {
    this.tracer = tracer;
    this.name = name;
    this.kind = options.kind || SpanKind.INTERNAL;
    this.parentSpanId = options.parent?.spanContext?.spanId;
    
    this.spanContext = {
      traceId: options.parent?.spanContext?.traceId || this.generateTraceId(),
      spanId: this.generateSpanId(),
      traceFlags: 1,
      traceState: ''
    };
    
    this.attributes = options.attributes || {};
    this.events = [];
    this.links = options.links || [];
    this.status = { code: SpanStatusCode.UNSET };
    
    this.startTime = performance.now();
    this.endTime = null;
    this.isRecording = false;
    this.ended = false;
  }
  
  /**
   * Set attributes
   */
  setAttributes(attributes) {
    if (!this.isRecording || this.ended) return;
    
    Object.assign(this.attributes, attributes);
  }
  
  /**
   * Set attribute
   */
  setAttribute(key, value) {
    if (!this.isRecording || this.ended) return;
    
    this.attributes[key] = value;
  }
  
  /**
   * Add event
   */
  addEvent(name, attributes = {}) {
    if (!this.isRecording || this.ended) return;
    
    this.events.push({
      name,
      attributes,
      timestamp: performance.now()
    });
  }
  
  /**
   * Record exception
   */
  recordException(exception, attributes = {}) {
    if (!this.isRecording || this.ended) return;
    
    this.addEvent('exception', {
      'exception.type': exception.constructor.name,
      'exception.message': exception.message,
      'exception.stacktrace': exception.stack,
      ...attributes
    });
  }
  
  /**
   * Set status
   */
  setStatus(status) {
    if (!this.isRecording || this.ended) return;
    
    this.status = status;
  }
  
  /**
   * End span
   */
  end(endTime) {
    if (this.ended) return;
    
    this.ended = true;
    this.endTime = endTime || performance.now();
    
    this.tracer.provider.stats.spansEnded++;
    this.tracer.provider.finishSpan(this);
  }
  
  /**
   * Generate trace ID
   */
  generateTraceId() {
    const buffer = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      buffer[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(buffer, b => b.toString(16).padStart(2, '0')).join('');
  }
  
  /**
   * Generate span ID
   */
  generateSpanId() {
    const buffer = new Uint8Array(8);
    for (let i = 0; i < 8; i++) {
      buffer[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(buffer, b => b.toString(16).padStart(2, '0')).join('');
  }
  
  /**
   * Convert to JSON
   */
  toJSON() {
    return {
      traceId: this.spanContext.traceId,
      spanId: this.spanContext.spanId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      kind: this.kind,
      startTime: this.startTime,
      endTime: this.endTime,
      duration: this.endTime ? this.endTime - this.startTime : null,
      attributes: this.attributes,
      events: this.events,
      links: this.links,
      status: this.status,
      resource: this.tracer.provider.resource,
      instrumentationLibrary: {
        name: this.tracer.instrumentationName,
        version: this.tracer.instrumentationVersion
      }
    };
  }
}

/**
 * Batch Span Processor
 */
export class BatchSpanProcessor {
  constructor(provider) {
    this.provider = provider;
    this.queue = [];
    this.timer = null;
  }
  
  initialize(provider) {
    this.startTimer();
  }
  
  onStart(span) {
    // Called when span starts
  }
  
  onEnd(span) {
    if (!span.isRecording) return;
    
    this.queue.push(span.toJSON());
    
    if (this.queue.length >= this.provider.config.maxExportBatchSize) {
      this.flush();
    }
  }
  
  startTimer() {
    this.timer = setInterval(() => {
      if (this.queue.length > 0) {
        this.flush();
      }
    }, this.provider.config.exportInterval);
  }
  
  async flush() {
    if (this.queue.length === 0) return;
    
    const batch = this.queue.splice(0, this.provider.config.maxExportBatchSize);
    
    for (const exporter of this.provider.exporters) {
      try {
        await exporter.export(batch);
        this.provider.stats.spansExported += batch.length;
      } catch (error) {
        logger.error('Export failed:', error);
        this.provider.stats.exportErrors++;
      }
    }
  }
  
  async shutdown() {
    if (this.timer) {
      clearInterval(this.timer);
    }
    
    await this.flush();
  }
}

/**
 * Console Span Exporter
 */
export class ConsoleSpanExporter {
  export(spans) {
    for (const span of spans) {
      console.log('Span:', JSON.stringify(span, null, 2));
    }
    
    return Promise.resolve();
  }
}

/**
 * OTLP Span Exporter
 */
export class OTLPSpanExporter {
  constructor(options = {}) {
    this.endpoint = options.endpoint || 'http://localhost:4318/v1/traces';
    this.headers = {
      'Content-Type': 'application/json',
      ...options.headers
    };
  }
  
  async export(spans) {
    const payload = {
      resourceSpans: [{
        resource: {
          attributes: this.convertAttributes(spans[0].resource)
        },
        instrumentationLibrarySpans: [{
          instrumentationLibrary: spans[0].instrumentationLibrary,
          spans: spans.map(span => this.convertSpan(span))
        }]
      }]
    };
    
    // In production, would use actual HTTP client
    logger.debug(`Exporting ${spans.length} spans to ${this.endpoint}`);
    
    return Promise.resolve();
  }
  
  convertSpan(span) {
    return {
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      kind: this.convertSpanKind(span.kind),
      startTimeUnixNano: Math.floor(span.startTime * 1000000),
      endTimeUnixNano: Math.floor(span.endTime * 1000000),
      attributes: this.convertAttributes(span.attributes),
      events: span.events.map(event => ({
        timeUnixNano: Math.floor(event.timestamp * 1000000),
        name: event.name,
        attributes: this.convertAttributes(event.attributes)
      })),
      links: span.links,
      status: span.status
    };
  }
  
  convertAttributes(attributes) {
    return Object.entries(attributes).map(([key, value]) => ({
      key,
      value: this.convertAttributeValue(value)
    }));
  }
  
  convertAttributeValue(value) {
    if (typeof value === 'string') {
      return { stringValue: value };
    } else if (typeof value === 'number') {
      return Number.isInteger(value) ? { intValue: value } : { doubleValue: value };
    } else if (typeof value === 'boolean') {
      return { boolValue: value };
    } else if (Array.isArray(value)) {
      return { arrayValue: { values: value.map(v => this.convertAttributeValue(v)) } };
    } else {
      return { stringValue: JSON.stringify(value) };
    }
  }
  
  convertSpanKind(kind) {
    const kindMap = {
      [SpanKind.INTERNAL]: 1,
      [SpanKind.SERVER]: 2,
      [SpanKind.CLIENT]: 3,
      [SpanKind.PRODUCER]: 4,
      [SpanKind.CONSUMER]: 5
    };
    
    return kindMap[kind] || 0;
  }
}

/**
 * Global tracer provider instance
 */
let globalTracerProvider = null;

/**
 * Set global tracer provider
 */
export function setGlobalTracerProvider(provider) {
  globalTracerProvider = provider;
}

/**
 * Get global tracer provider
 */
export function getGlobalTracerProvider() {
  if (!globalTracerProvider) {
    globalTracerProvider = new TracerProvider();
  }
  return globalTracerProvider;
}

/**
 * Get tracer
 */
export function getTracer(name, version) {
  return getGlobalTracerProvider().getTracer(name, version);
}

/**
 * Create tracer provider
 */
export function createTracerProvider(options) {
  return new TracerProvider(options);
}

export default {
  TracerProvider,
  Tracer,
  Span,
  SpanKind,
  SpanStatusCode,
  BatchSpanProcessor,
  ConsoleSpanExporter,
  OTLPSpanExporter,
  createTracerProvider,
  setGlobalTracerProvider,
  getGlobalTracerProvider,
  getTracer
};