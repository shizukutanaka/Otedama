const { EventEmitter } = require('events');
const crypto = require('crypto');
const { performance } = require('perf_hooks');

class DistributedTracing extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Service identification
      serviceName: config.serviceName || 'otedama-pool',
      serviceVersion: config.serviceVersion || process.env.npm_package_version || '0.1.7',
      environment: config.environment || process.env.NODE_ENV || 'development',
      
      // Tracing configuration
      samplingRate: config.samplingRate || 1.0, // 100% sampling by default
      maxTraceDepth: config.maxTraceDepth || 20,
      maxSpansPerTrace: config.maxSpansPerTrace || 1000,
      propagationFormat: config.propagationFormat || 'w3c', // 'w3c', 'b3', 'jaeger'
      
      // Context propagation
      baggageMaxSize: config.baggageMaxSize || 8192, // bytes
      baggageMaxItems: config.baggageMaxItems || 64,
      
      // Performance
      batchSize: config.batchSize || 100,
      flushInterval: config.flushInterval || 5000, // 5 seconds
      maxQueueSize: config.maxQueueSize || 10000,
      
      // Exporters
      exporters: config.exporters || {
        console: {
          enabled: false,
          format: 'json' // 'json', 'pretty'
        },
        jaeger: {
          enabled: true,
          endpoint: 'http://localhost:14268/api/traces',
          serviceName: config.serviceName || 'otedama-pool'
        },
        zipkin: {
          enabled: false,
          endpoint: 'http://localhost:9411/api/v2/spans'
        },
        otlp: {
          enabled: true,
          endpoint: 'http://localhost:4318/v1/traces',
          headers: {}
        },
        datadog: {
          enabled: false,
          agentHost: 'localhost',
          agentPort: 8126
        }
      },
      
      // Span processors
      processors: config.processors || {
        attributeFilter: {
          enabled: true,
          allowedKeys: [],
          blockedKeys: ['password', 'secret', 'token', 'key']
        },
        spanFilter: {
          enabled: true,
          minDuration: 0, // ms
          excludeOperations: []
        },
        sampler: {
          type: 'probabilistic', // 'always', 'never', 'probabilistic', 'ratelimited'
          param: 1.0
        }
      },
      
      // Resource attributes
      resource: config.resource || {
        'service.name': config.serviceName || 'otedama-pool',
        'service.version': config.serviceVersion || '0.1.7',
        'service.namespace': 'mining',
        'deployment.environment': config.environment || 'development',
        'telemetry.sdk.name': 'otedama-tracing',
        'telemetry.sdk.version': '1.0.0',
        'telemetry.sdk.language': 'nodejs'
      },
      
      // Instrumentation
      autoInstrument: config.autoInstrument !== false,
      instrumentations: config.instrumentations || [
        'http',
        'grpc',
        'redis',
        'postgresql',
        'mysql',
        'mongodb',
        'express',
        'ws'
      ],
      
      // Error handling
      errorHandler: config.errorHandler || this.defaultErrorHandler.bind(this),
      
      // Monitoring
      enableMetrics: config.enableMetrics !== false,
      metricsInterval: config.metricsInterval || 60000
    };
    
    this.traces = new Map();
    this.spans = new Map();
    this.spanQueue = [];
    this.exporters = new Map();
    this.instrumentations = new Map();
    this.metrics = {
      tracesCreated: 0,
      tracesCompleted: 0,
      spansCreated: 0,
      spansCompleted: 0,
      spansDropped: 0,
      exportSuccesses: 0,
      exportFailures: 0,
      queueSize: 0,
      averageSpanDuration: 0,
      samplingDecisions: {
        sampled: 0,
        notSampled: 0
      }
    };
    
    this.flushTimer = null;
    this.metricsTimer = null;
    this.initialized = false;
  }
  
  async initialize() {
    if (this.initialized) return;
    
    try {
      // Initialize exporters
      await this.initializeExporters();
      
      // Setup auto-instrumentation
      if (this.config.autoInstrument) {
        await this.setupAutoInstrumentation();
      }
      
      // Start flush timer
      this.startFlushTimer();
      
      // Start metrics collection
      if (this.config.enableMetrics) {
        this.startMetricsCollection();
      }
      
      this.initialized = true;
      this.emit('initialized');
      
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
  
  async initializeExporters() {
    // Console exporter
    if (this.config.exporters.console?.enabled) {
      this.exporters.set('console', {
        type: 'console',
        export: async (spans) => {
          for (const span of spans) {
            if (this.config.exporters.console.format === 'pretty') {
              console.log(this.formatSpanPretty(span));
            } else {
              console.log(JSON.stringify(span));
            }
          }
        }
      });
    }
    
    // Jaeger exporter
    if (this.config.exporters.jaeger?.enabled) {
      this.exporters.set('jaeger', {
        type: 'jaeger',
        export: async (spans) => {
          const batch = this.convertToJaegerFormat(spans);
          await this.sendToJaeger(batch);
        }
      });
    }
    
    // Zipkin exporter
    if (this.config.exporters.zipkin?.enabled) {
      this.exporters.set('zipkin', {
        type: 'zipkin',
        export: async (spans) => {
          const batch = this.convertToZipkinFormat(spans);
          await this.sendToZipkin(batch);
        }
      });
    }
    
    // OTLP exporter
    if (this.config.exporters.otlp?.enabled) {
      this.exporters.set('otlp', {
        type: 'otlp',
        export: async (spans) => {
          const batch = this.convertToOTLPFormat(spans);
          await this.sendToOTLP(batch);
        }
      });
    }
    
    // Datadog exporter
    if (this.config.exporters.datadog?.enabled) {
      this.exporters.set('datadog', {
        type: 'datadog',
        export: async (spans) => {
          const batch = this.convertToDatadogFormat(spans);
          await this.sendToDatadog(batch);
        }
      });
    }
  }
  
  async setupAutoInstrumentation() {
    for (const lib of this.config.instrumentations) {
      try {
        switch (lib) {
          case 'http':
            this.instrumentHTTP();
            break;
          case 'grpc':
            this.instrumentGRPC();
            break;
          case 'redis':
            this.instrumentRedis();
            break;
          case 'postgresql':
            this.instrumentPostgreSQL();
            break;
          case 'express':
            this.instrumentExpress();
            break;
          case 'ws':
            this.instrumentWebSocket();
            break;
        }
        
        this.instrumentations.set(lib, true);
        this.emit('instrumentation_loaded', { library: lib });
        
      } catch (error) {
        console.error(`Failed to instrument ${lib}:`, error);
        this.emit('instrumentation_error', { library: lib, error });
      }
    }
  }
  
  createTracer(name = 'default') {
    return {
      startSpan: (operationName, options = {}) => {
        return this.startSpan(operationName, {
          ...options,
          tracer: name
        });
      },
      
      startActiveSpan: (operationName, fn, options = {}) => {
        const span = this.startSpan(operationName, {
          ...options,
          tracer: name
        });
        
        try {
          const result = fn(span);
          if (result instanceof Promise) {
            return result.finally(() => span.end());
          }
          span.end();
          return result;
        } catch (error) {
          span.recordException(error);
          span.setStatus({ code: 'ERROR', message: error.message });
          span.end();
          throw error;
        }
      }
    };
  }
  
  startSpan(name, options = {}) {
    // Check sampling decision
    if (!this.shouldSample(name, options)) {
      return this.createNoOpSpan();
    }
    
    const span = {
      traceId: options.traceId || this.generateTraceId(),
      spanId: this.generateSpanId(),
      parentSpanId: options.parentSpanId || null,
      operationName: name,
      serviceName: this.config.serviceName,
      startTime: performance.now(),
      endTime: null,
      duration: null,
      status: { code: 'UNSET' },
      attributes: {
        ...this.config.resource,
        ...options.attributes
      },
      events: [],
      links: options.links || [],
      kind: options.kind || 'INTERNAL', // INTERNAL, SERVER, CLIENT, PRODUCER, CONSUMER
      baggage: options.baggage || {}
    };
    
    // Check trace depth
    const traceDepth = this.getTraceDepth(span.traceId);
    if (traceDepth >= this.config.maxTraceDepth) {
      this.metrics.spansDropped++;
      return this.createNoOpSpan();
    }
    
    // Check spans per trace limit
    const spansInTrace = this.getSpansInTrace(span.traceId);
    if (spansInTrace >= this.config.maxSpansPerTrace) {
      this.metrics.spansDropped++;
      return this.createNoOpSpan();
    }
    
    // Store span
    this.spans.set(span.spanId, span);
    
    // Track trace
    if (!this.traces.has(span.traceId)) {
      this.traces.set(span.traceId, {
        traceId: span.traceId,
        startTime: span.startTime,
        spans: new Set(),
        rootSpan: span.parentSpanId ? null : span.spanId
      });
      this.metrics.tracesCreated++;
    }
    this.traces.get(span.traceId).spans.add(span.spanId);
    
    this.metrics.spansCreated++;
    
    // Return span interface
    return {
      spanContext: () => ({
        traceId: span.traceId,
        spanId: span.spanId,
        traceFlags: 1, // Sampled
        traceState: ''
      }),
      
      setAttribute: (key, value) => {
        if (this.isAllowedAttribute(key)) {
          span.attributes[key] = value;
        }
        return this;
      },
      
      setAttributes: (attributes) => {
        for (const [key, value] of Object.entries(attributes)) {
          this.setAttribute(key, value);
        }
        return this;
      },
      
      addEvent: (name, attributes = {}, timestamp) => {
        span.events.push({
          name,
          attributes,
          timestamp: timestamp || performance.now()
        });
        return this;
      },
      
      setStatus: (status) => {
        span.status = status;
        return this;
      },
      
      recordException: (exception, attributes = {}) => {
        const error = exception instanceof Error ? exception : new Error(String(exception));
        
        this.addEvent('exception', {
          'exception.type': error.constructor.name,
          'exception.message': error.message,
          'exception.stacktrace': error.stack,
          ...attributes
        });
        
        this.setStatus({
          code: 'ERROR',
          message: error.message
        });
        
        return this;
      },
      
      updateName: (name) => {
        span.operationName = name;
        return this;
      },
      
      end: (endTime) => {
        if (span.endTime) return; // Already ended
        
        span.endTime = endTime || performance.now();
        span.duration = span.endTime - span.startTime;
        
        this.metrics.spansCompleted++;
        this.updateAverageSpanDuration(span.duration);
        
        // Process span
        this.processSpan(span);
        
        // Check if trace is complete
        this.checkTraceCompletion(span.traceId);
      },
      
      isRecording: () => true,
      
      // Baggage operations
      setBaggageItem: (key, value) => {
        const size = Buffer.byteLength(JSON.stringify(span.baggage));
        const newSize = size + Buffer.byteLength(key) + Buffer.byteLength(value);
        
        if (newSize <= this.config.baggageMaxSize && 
            Object.keys(span.baggage).length < this.config.baggageMaxItems) {
          span.baggage[key] = value;
        }
        return this;
      },
      
      getBaggageItem: (key) => span.baggage[key],
      
      // Context propagation
      inject: (carrier, format = 'w3c') => {
        this.inject(span.spanContext(), carrier, format);
      }
    };
  }
  
  createNoOpSpan() {
    const noOp = {
      spanContext: () => ({
        traceId: '00000000000000000000000000000000',
        spanId: '0000000000000000',
        traceFlags: 0,
        traceState: ''
      }),
      setAttribute: () => noOp,
      setAttributes: () => noOp,
      addEvent: () => noOp,
      setStatus: () => noOp,
      recordException: () => noOp,
      updateName: () => noOp,
      end: () => {},
      isRecording: () => false,
      setBaggageItem: () => noOp,
      getBaggageItem: () => undefined,
      inject: () => {}
    };
    
    return noOp;
  }
  
  extract(carrier, format = 'w3c') {
    switch (format) {
      case 'w3c':
        return this.extractW3C(carrier);
      case 'b3':
        return this.extractB3(carrier);
      case 'jaeger':
        return this.extractJaeger(carrier);
      default:
        return null;
    }
  }
  
  inject(spanContext, carrier, format = 'w3c') {
    switch (format) {
      case 'w3c':
        this.injectW3C(spanContext, carrier);
        break;
      case 'b3':
        this.injectB3(spanContext, carrier);
        break;
      case 'jaeger':
        this.injectJaeger(spanContext, carrier);
        break;
    }
  }
  
  extractW3C(carrier) {
    const traceparent = carrier['traceparent'] || carrier['Traceparent'];
    if (!traceparent) return null;
    
    const parts = traceparent.split('-');
    if (parts.length !== 4) return null;
    
    return {
      traceId: parts[1],
      spanId: parts[2],
      traceFlags: parseInt(parts[3], 16),
      traceState: carrier['tracestate'] || carrier['Tracestate'] || ''
    };
  }
  
  injectW3C(spanContext, carrier) {
    const { traceId, spanId, traceFlags } = spanContext;
    carrier['traceparent'] = `00-${traceId}-${spanId}-${traceFlags.toString(16).padStart(2, '0')}`;
    
    if (spanContext.traceState) {
      carrier['tracestate'] = spanContext.traceState;
    }
  }
  
  extractB3(carrier) {
    const traceId = carrier['X-B3-TraceId'] || carrier['x-b3-traceid'];
    const spanId = carrier['X-B3-SpanId'] || carrier['x-b3-spanid'];
    const sampled = carrier['X-B3-Sampled'] || carrier['x-b3-sampled'];
    
    if (!traceId || !spanId) return null;
    
    return {
      traceId: traceId.padStart(32, '0'),
      spanId: spanId.padStart(16, '0'),
      traceFlags: sampled === '1' ? 1 : 0,
      traceState: ''
    };
  }
  
  injectB3(spanContext, carrier) {
    carrier['X-B3-TraceId'] = spanContext.traceId;
    carrier['X-B3-SpanId'] = spanContext.spanId;
    carrier['X-B3-Sampled'] = spanContext.traceFlags & 1 ? '1' : '0';
    
    if (spanContext.parentSpanId) {
      carrier['X-B3-ParentSpanId'] = spanContext.parentSpanId;
    }
  }
  
  extractJaeger(carrier) {
    const uber = carrier['uber-trace-id'];
    if (!uber) return null;
    
    const parts = uber.split(':');
    if (parts.length !== 4) return null;
    
    return {
      traceId: parts[0].padStart(32, '0'),
      spanId: parts[1].padStart(16, '0'),
      traceFlags: parseInt(parts[3], 10),
      traceState: ''
    };
  }
  
  injectJaeger(spanContext, carrier) {
    const { traceId, spanId, traceFlags } = spanContext;
    carrier['uber-trace-id'] = `${traceId}:${spanId}:0:${traceFlags}`;
  }
  
  shouldSample(operationName, options) {
    // Check span filter
    if (this.config.processors.spanFilter?.enabled) {
      if (this.config.processors.spanFilter.excludeOperations.includes(operationName)) {
        this.metrics.samplingDecisions.notSampled++;
        return false;
      }
    }
    
    // Apply sampler
    const sampler = this.config.processors.sampler;
    let sampled = false;
    
    switch (sampler.type) {
      case 'always':
        sampled = true;
        break;
        
      case 'never':
        sampled = false;
        break;
        
      case 'probabilistic':
        sampled = Math.random() < sampler.param;
        break;
        
      case 'ratelimited':
        // Simple rate limiting - would be more sophisticated in production
        const now = Date.now();
        const window = 1000; // 1 second
        const key = `${operationName}:${Math.floor(now / window)}`;
        
        if (!this.rateLimits) this.rateLimits = new Map();
        const count = this.rateLimits.get(key) || 0;
        
        if (count < sampler.param) {
          this.rateLimits.set(key, count + 1);
          sampled = true;
        }
        break;
        
      default:
        sampled = true;
    }
    
    if (sampled) {
      this.metrics.samplingDecisions.sampled++;
    } else {
      this.metrics.samplingDecisions.notSampled++;
    }
    
    return sampled;
  }
  
  isAllowedAttribute(key) {
    const filter = this.config.processors.attributeFilter;
    if (!filter?.enabled) return true;
    
    // Check blocked keys
    if (filter.blockedKeys.some(blocked => key.includes(blocked))) {
      return false;
    }
    
    // Check allowed keys if specified
    if (filter.allowedKeys.length > 0) {
      return filter.allowedKeys.some(allowed => key.includes(allowed));
    }
    
    return true;
  }
  
  processSpan(span) {
    // Apply processors
    if (this.config.processors.spanFilter?.enabled) {
      const minDuration = this.config.processors.spanFilter.minDuration;
      if (span.duration < minDuration) {
        return; // Skip short spans
      }
    }
    
    // Add to queue
    this.spanQueue.push(span);
    this.metrics.queueSize = this.spanQueue.length;
    
    // Check if we should flush
    if (this.spanQueue.length >= this.config.batchSize) {
      this.flush();
    }
  }
  
  async flush() {
    if (this.spanQueue.length === 0) return;
    
    const batch = this.spanQueue.splice(0, this.config.batchSize);
    this.metrics.queueSize = this.spanQueue.length;
    
    // Export to all configured exporters
    const exportPromises = [];
    
    for (const [name, exporter] of this.exporters) {
      exportPromises.push(
        exporter.export(batch)
          .then(() => {
            this.metrics.exportSuccesses++;
          })
          .catch((error) => {
            this.metrics.exportFailures++;
            this.emit('export_error', { exporter: name, error });
          })
      );
    }
    
    await Promise.allSettled(exportPromises);
  }
  
  checkTraceCompletion(traceId) {
    const trace = this.traces.get(traceId);
    if (!trace) return;
    
    // Check if all spans in trace are completed
    let allCompleted = true;
    for (const spanId of trace.spans) {
      const span = this.spans.get(spanId);
      if (span && !span.endTime) {
        allCompleted = false;
        break;
      }
    }
    
    if (allCompleted) {
      this.metrics.tracesCompleted++;
      
      // Clean up completed trace
      setTimeout(() => {
        for (const spanId of trace.spans) {
          this.spans.delete(spanId);
        }
        this.traces.delete(traceId);
      }, 60000); // Keep for 1 minute for late spans
    }
  }
  
  getTraceDepth(traceId) {
    let maxDepth = 0;
    const trace = this.traces.get(traceId);
    
    if (!trace) return 0;
    
    for (const spanId of trace.spans) {
      const span = this.spans.get(spanId);
      if (span) {
        const depth = this.calculateSpanDepth(span);
        maxDepth = Math.max(maxDepth, depth);
      }
    }
    
    return maxDepth;
  }
  
  calculateSpanDepth(span, depth = 0) {
    if (!span.parentSpanId) return depth;
    
    const parent = this.spans.get(span.parentSpanId);
    if (!parent) return depth;
    
    return this.calculateSpanDepth(parent, depth + 1);
  }
  
  getSpansInTrace(traceId) {
    const trace = this.traces.get(traceId);
    return trace ? trace.spans.size : 0;
  }
  
  updateAverageSpanDuration(duration) {
    const count = this.metrics.spansCompleted;
    this.metrics.averageSpanDuration = 
      (this.metrics.averageSpanDuration * (count - 1) + duration) / count;
  }
  
  // Format converters
  convertToJaegerFormat(spans) {
    const processes = new Map();
    const jaegerSpans = [];
    
    for (const span of spans) {
      // Get or create process
      if (!processes.has(span.serviceName)) {
        processes.set(span.serviceName, {
          serviceName: span.serviceName,
          tags: Object.entries(this.config.resource).map(([key, value]) => ({
            key,
            type: typeof value === 'string' ? 'STRING' : 'DOUBLE',
            value: String(value)
          }))
        });
      }
      
      jaegerSpans.push({
        traceID: span.traceId,
        spanID: span.spanId,
        parentSpanID: span.parentSpanId || '',
        operationName: span.operationName,
        startTime: Math.floor(span.startTime * 1000), // microseconds
        duration: Math.floor(span.duration * 1000),
        tags: Object.entries(span.attributes).map(([key, value]) => ({
          key,
          type: typeof value === 'string' ? 'STRING' : 'DOUBLE',
          value: String(value)
        })),
        logs: span.events.map(event => ({
          timestamp: Math.floor(event.timestamp * 1000),
          fields: Object.entries(event.attributes).map(([key, value]) => ({
            key,
            value: String(value)
          }))
        })),
        process: span.serviceName,
        warnings: null
      });
    }
    
    return {
      data: Array.from(processes.entries()).map(([serviceName, process]) => ({
        traceID: spans[0].traceId,
        spans: jaegerSpans.filter(s => s.process === serviceName),
        process
      }))
    };
  }
  
  convertToZipkinFormat(spans) {
    return spans.map(span => ({
      traceId: span.traceId,
      name: span.operationName,
      parentId: span.parentSpanId,
      id: span.spanId,
      kind: span.kind,
      timestamp: Math.floor(span.startTime * 1000), // microseconds
      duration: Math.floor(span.duration * 1000),
      debug: false,
      shared: false,
      localEndpoint: {
        serviceName: span.serviceName,
        ipv4: '127.0.0.1'
      },
      tags: span.attributes,
      annotations: span.events.map(event => ({
        timestamp: Math.floor(event.timestamp * 1000),
        value: event.name
      }))
    }));
  }
  
  convertToOTLPFormat(spans) {
    const resourceSpans = new Map();
    
    for (const span of spans) {
      const key = span.serviceName;
      
      if (!resourceSpans.has(key)) {
        resourceSpans.set(key, {
          resource: {
            attributes: Object.entries(this.config.resource).map(([key, value]) => ({
              key,
              value: { stringValue: String(value) }
            }))
          },
          instrumentationLibrarySpans: [{
            instrumentationLibrary: {
              name: 'otedama-tracing',
              version: '1.0.0'
            },
            spans: []
          }]
        });
      }
      
      const otlpSpan = {
        traceId: Buffer.from(span.traceId, 'hex').toString('base64'),
        spanId: Buffer.from(span.spanId, 'hex').toString('base64'),
        parentSpanId: span.parentSpanId ? 
          Buffer.from(span.parentSpanId, 'hex').toString('base64') : undefined,
        name: span.operationName,
        kind: this.mapSpanKind(span.kind),
        startTimeUnixNano: BigInt(Math.floor(span.startTime * 1000000)).toString(),
        endTimeUnixNano: BigInt(Math.floor(span.endTime * 1000000)).toString(),
        attributes: Object.entries(span.attributes).map(([key, value]) => ({
          key,
          value: this.convertAttributeValue(value)
        })),
        events: span.events.map(event => ({
          timeUnixNano: BigInt(Math.floor(event.timestamp * 1000000)).toString(),
          name: event.name,
          attributes: Object.entries(event.attributes).map(([key, value]) => ({
            key,
            value: this.convertAttributeValue(value)
          }))
        })),
        status: {
          code: this.mapStatusCode(span.status.code),
          message: span.status.message || ''
        }
      };
      
      resourceSpans.get(key).instrumentationLibrarySpans[0].spans.push(otlpSpan);
    }
    
    return {
      resourceSpans: Array.from(resourceSpans.values())
    };
  }
  
  convertToDatadogFormat(spans) {
    return spans.map(span => ({
      trace_id: parseInt(span.traceId.substring(0, 16), 16),
      span_id: parseInt(span.spanId, 16),
      parent_id: span.parentSpanId ? parseInt(span.parentSpanId, 16) : 0,
      name: span.operationName,
      resource: span.attributes['http.target'] || span.operationName,
      service: span.serviceName,
      type: span.kind === 'SERVER' ? 'web' : 'custom',
      start: Math.floor(span.startTime * 1000000), // nanoseconds
      duration: Math.floor(span.duration * 1000000),
      error: span.status.code === 'ERROR' ? 1 : 0,
      meta: {
        ...span.attributes,
        'span.kind': span.kind
      },
      metrics: {
        '_sampling_priority_v1': 1
      }
    }));
  }
  
  mapSpanKind(kind) {
    const kinds = {
      'INTERNAL': 1,
      'SERVER': 2,
      'CLIENT': 3,
      'PRODUCER': 4,
      'CONSUMER': 5
    };
    return kinds[kind] || 0;
  }
  
  mapStatusCode(code) {
    const codes = {
      'UNSET': 0,
      'OK': 1,
      'ERROR': 2
    };
    return codes[code] || 0;
  }
  
  convertAttributeValue(value) {
    if (typeof value === 'string') {
      return { stringValue: value };
    } else if (typeof value === 'boolean') {
      return { boolValue: value };
    } else if (typeof value === 'number') {
      if (Number.isInteger(value)) {
        return { intValue: value };
      } else {
        return { doubleValue: value };
      }
    } else if (Array.isArray(value)) {
      return { arrayValue: { values: value.map(v => this.convertAttributeValue(v)) } };
    } else {
      return { stringValue: JSON.stringify(value) };
    }
  }
  
  // Export functions
  async sendToJaeger(batch) {
    const response = await fetch(this.config.exporters.jaeger.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(batch)
    });
    
    if (!response.ok) {
      throw new Error(`Jaeger export failed: ${response.statusText}`);
    }
  }
  
  async sendToZipkin(batch) {
    const response = await fetch(this.config.exporters.zipkin.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(batch)
    });
    
    if (!response.ok) {
      throw new Error(`Zipkin export failed: ${response.statusText}`);
    }
  }
  
  async sendToOTLP(batch) {
    const response = await fetch(this.config.exporters.otlp.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-protobuf',
        ...this.config.exporters.otlp.headers
      },
      body: JSON.stringify(batch) // Would be protobuf in production
    });
    
    if (!response.ok) {
      throw new Error(`OTLP export failed: ${response.statusText}`);
    }
  }
  
  async sendToDatadog(batch) {
    const dgram = require('dgram');
    const client = dgram.createSocket('udp4');
    
    const message = JSON.stringify(batch);
    
    return new Promise((resolve, reject) => {
      client.send(
        message,
        this.config.exporters.datadog.agentPort,
        this.config.exporters.datadog.agentHost,
        (error) => {
          client.close();
          if (error) reject(error);
          else resolve();
        }
      );
    });
  }
  
  // Instrumentation methods
  instrumentHTTP() {
    const http = require('http');
    const https = require('https');
    
    // Instrument http.request
    const originalRequest = http.request;
    http.request = (options, callback) => {
      const span = this.startSpan('http.request', {
        kind: 'CLIENT',
        attributes: {
          'http.method': options.method || 'GET',
          'http.url': options.href || `${options.protocol}//${options.host}${options.path}`,
          'http.target': options.path,
          'net.peer.name': options.hostname,
          'net.peer.port': options.port
        }
      });
      
      const req = originalRequest.call(http, options, (res) => {
        span.setAttributes({
          'http.status_code': res.statusCode,
          'http.status_text': res.statusMessage
        });
        
        if (res.statusCode >= 400) {
          span.setStatus({ code: 'ERROR', message: `HTTP ${res.statusCode}` });
        }
        
        if (callback) callback(res);
      });
      
      req.on('error', (error) => {
        span.recordException(error);
        span.end();
      });
      
      req.on('finish', () => {
        span.end();
      });
      
      // Propagate context
      span.inject(req.headers || {});
      
      return req;
    };
    
    // Similar for https
    https.request = http.request;
  }
  
  instrumentExpress() {
    // Would instrument Express middleware
    // This is a simplified example
    return (req, res, next) => {
      const spanContext = this.extract(req.headers);
      
      const span = this.startSpan(`${req.method} ${req.path}`, {
        kind: 'SERVER',
        parentSpanId: spanContext?.spanId,
        traceId: spanContext?.traceId,
        attributes: {
          'http.method': req.method,
          'http.target': req.path,
          'http.url': req.url,
          'http.scheme': req.protocol,
          'net.host.name': req.hostname,
          'user_agent.original': req.headers['user-agent']
        }
      });
      
      // Store span in request
      req.span = span;
      
      // Wrap res.end
      const originalEnd = res.end;
      res.end = function(...args) {
        span.setAttributes({
          'http.status_code': res.statusCode,
          'http.response_content_length': res.get('content-length')
        });
        
        if (res.statusCode >= 400) {
          span.setStatus({ code: 'ERROR', message: `HTTP ${res.statusCode}` });
        }
        
        span.end();
        originalEnd.apply(res, args);
      };
      
      next();
    };
  }
  
  instrumentWebSocket() {
    const WebSocket = require('ws');
    
    // Instrument WebSocket constructor
    const OriginalWebSocket = WebSocket;
    WebSocket = function(...args) {
      const ws = new OriginalWebSocket(...args);
      
      const span = this.startSpan('websocket.connect', {
        kind: 'CLIENT',
        attributes: {
          'ws.url': args[0]
        }
      });
      
      ws.on('open', () => {
        span.addEvent('websocket.open');
      });
      
      ws.on('error', (error) => {
        span.recordException(error);
      });
      
      ws.on('close', () => {
        span.addEvent('websocket.close');
        span.end();
      });
      
      return ws;
    }.bind(this);
    
    // Copy properties
    Object.setPrototypeOf(WebSocket, OriginalWebSocket);
    Object.setPrototypeOf(WebSocket.prototype, OriginalWebSocket.prototype);
  }
  
  instrumentRedis() {
    // Would instrument Redis client
    // Implementation depends on specific Redis library
  }
  
  instrumentPostgreSQL() {
    // Would instrument PostgreSQL client
    // Implementation depends on specific PG library
  }
  
  instrumentGRPC() {
    // Would instrument gRPC client/server
    // Implementation depends on specific gRPC library
  }
  
  // Utility methods
  generateTraceId() {
    return crypto.randomBytes(16).toString('hex');
  }
  
  generateSpanId() {
    return crypto.randomBytes(8).toString('hex');
  }
  
  formatSpanPretty(span) {
    const indent = '  ';
    let output = `Span: ${span.operationName}\n`;
    output += `${indent}TraceID: ${span.traceId}\n`;
    output += `${indent}SpanID: ${span.spanId}\n`;
    if (span.parentSpanId) {
      output += `${indent}ParentID: ${span.parentSpanId}\n`;
    }
    output += `${indent}Duration: ${span.duration.toFixed(2)}ms\n`;
    output += `${indent}Status: ${span.status.code}\n`;
    
    if (Object.keys(span.attributes).length > 0) {
      output += `${indent}Attributes:\n`;
      for (const [key, value] of Object.entries(span.attributes)) {
        output += `${indent}${indent}${key}: ${value}\n`;
      }
    }
    
    if (span.events.length > 0) {
      output += `${indent}Events:\n`;
      for (const event of span.events) {
        output += `${indent}${indent}${event.name} @ ${event.timestamp.toFixed(2)}ms\n`;
      }
    }
    
    return output;
  }
  
  startFlushTimer() {
    this.flushTimer = setInterval(() => {
      this.flush();
    }, this.config.flushInterval);
  }
  
  startMetricsCollection() {
    this.metricsTimer = setInterval(() => {
      const metrics = this.getMetrics();
      this.emit('metrics', metrics);
    }, this.config.metricsInterval);
  }
  
  getMetrics() {
    return {
      ...this.metrics,
      activeTraces: this.traces.size,
      activeSpans: this.spans.size,
      exporters: Array.from(this.exporters.keys()),
      instrumentations: Array.from(this.instrumentations.keys()),
      timestamp: new Date()
    };
  }
  
  defaultErrorHandler(error) {
    console.error('Tracing error:', error);
  }
  
  async shutdown() {
    // Flush remaining spans
    await this.flush();
    
    // Clear timers
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }
    
    // Clear data
    this.traces.clear();
    this.spans.clear();
    this.spanQueue = [];
    this.exporters.clear();
    this.instrumentations.clear();
    
    this.initialized = false;
    this.emit('shutdown');
  }
}

module.exports = DistributedTracing;