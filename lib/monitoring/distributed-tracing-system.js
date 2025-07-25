/**
 * Distributed Tracing System
 * 分散トレーシングシステム
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');

class DistributedTracingSystem extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Service information
            serviceName: config.serviceName || 'otedama-pool',
            serviceVersion: config.serviceVersion || '1.0.6',
            environment: config.environment || 'production',
            
            // Sampling configuration
            samplingRate: config.samplingRate || 0.1, // 10% sampling
            alwaysSample: config.alwaysSample || ['error', 'slow'],
            
            // Performance thresholds
            slowThreshold: config.slowThreshold || 1000, // 1 second
            errorSampleRate: config.errorSampleRate || 1.0, // 100% for errors
            
            // Span limits
            maxSpansPerTrace: config.maxSpansPerTrace || 1000,
            maxAttributesPerSpan: config.maxAttributesPerSpan || 100,
            maxEventsPerSpan: config.maxEventsPerSpan || 50,
            
            // Batching
            batchSize: config.batchSize || 100,
            batchInterval: config.batchInterval || 5000, // 5 seconds
            
            // Storage
            enableLocalStorage: config.enableLocalStorage || false,
            storageRetention: config.storageRetention || 86400000, // 24 hours
            
            // Export configuration
            exporters: config.exporters || ['console'], // console, jaeger, zipkin
            exportEndpoint: config.exportEndpoint || `http://${process.env.JAEGER_HOST || 'localhost'}:${process.env.JAEGER_PORT || 14268}/api/traces`,
            
            // Context propagation
            propagationHeaders: config.propagationHeaders || [
                'x-trace-id',
                'x-span-id',
                'x-parent-span-id',
                'x-sampling-decision'
            ],
            
            ...config
        };
        
        // Trace storage
        this.traces = new Map();
        this.spans = new Map();
        this.pendingSpans = [];
        
        // Sampling decisions cache
        this.samplingCache = new Map();
        
        // Statistics
        this.stats = {
            tracesCreated: 0,
            spansCreated: 0,
            spansSampled: 0,
            spansDropped: 0,
            errorsTraced: 0,
            slowOperations: 0
        };
        
        // Initialize
        this.initialize();
    }
    
    initialize() {
        console.log('分散トレーシングシステムを初期化中...');
        
        // Setup exporters
        this.setupExporters();
        
        // Start batch processing
        this.startBatchProcessing();
        
        // Setup context propagation
        this.setupContextPropagation();
        
        console.log('✓ 分散トレーシングシステムの初期化完了');
    }
    
    /**
     * Create a new trace
     */
    createTrace(operationName, options = {}) {
        const traceId = this.generateTraceId();
        const rootSpan = this.createSpan(traceId, null, operationName, options);
        
        const trace = {
            traceId,
            rootSpan,
            spans: [rootSpan],
            startTime: Date.now(),
            service: this.config.serviceName,
            environment: this.config.environment
        };
        
        this.traces.set(traceId, trace);
        this.stats.tracesCreated++;
        
        return {
            traceId,
            spanId: rootSpan.spanId,
            end: (status = 'ok', attributes = {}) => this.endSpan(rootSpan.spanId, status, attributes),
            trace: (operationName, options) => this.createChildSpan(traceId, rootSpan.spanId, operationName, options)
        };
    }
    
    /**
     * Create a span
     */
    createSpan(traceId, parentSpanId, operationName, options = {}) {
        const spanId = this.generateSpanId();
        
        // Make sampling decision
        const sampled = this.shouldSample(traceId, operationName, options);
        
        const span = {
            traceId,
            spanId,
            parentSpanId,
            operationName,
            serviceName: this.config.serviceName,
            startTime: Date.now(),
            endTime: null,
            duration: null,
            status: 'in_progress',
            sampled,
            attributes: {},
            events: [],
            links: []
        };
        
        // Add default attributes
        this.addDefaultAttributes(span);
        
        // Add custom attributes
        if (options.attributes) {
            this.addAttributes(span, options.attributes);
        }
        
        this.spans.set(spanId, span);
        this.stats.spansCreated++;
        
        if (sampled) {
            this.stats.spansSampled++;
        }
        
        return span;
    }
    
    /**
     * Create a child span
     */
    createChildSpan(traceId, parentSpanId, operationName, options = {}) {
        const span = this.createSpan(traceId, parentSpanId, operationName, options);
        
        // Add to trace
        const trace = this.traces.get(traceId);
        if (trace && trace.spans.length < this.config.maxSpansPerTrace) {
            trace.spans.push(span);
        } else {
            this.stats.spansDropped++;
        }
        
        return {
            spanId: span.spanId,
            end: (status = 'ok', attributes = {}) => this.endSpan(span.spanId, status, attributes),
            addEvent: (name, attributes) => this.addSpanEvent(span.spanId, name, attributes),
            setAttributes: (attributes) => this.addAttributes(span, attributes),
            setStatus: (status) => this.setSpanStatus(span.spanId, status),
            trace: (operationName, options) => this.createChildSpan(traceId, span.spanId, operationName, options)
        };
    }
    
    /**
     * End a span
     */
    endSpan(spanId, status = 'ok', attributes = {}) {
        const span = this.spans.get(spanId);
        if (!span) return;
        
        span.endTime = Date.now();
        span.duration = span.endTime - span.startTime;
        span.status = status;
        
        // Add final attributes
        this.addAttributes(span, attributes);
        
        // Check if slow
        if (span.duration > this.config.slowThreshold) {
            this.stats.slowOperations++;
            this.addSpanEvent(spanId, 'slow_operation', {
                duration: span.duration,
                threshold: this.config.slowThreshold
            });
        }
        
        // Check if error
        if (status === 'error') {
            this.stats.errorsTraced++;
        }
        
        // Queue for export if sampled
        if (span.sampled) {
            this.pendingSpans.push(span);
        }
        
        // Emit span completion
        this.emit('span-completed', span);
    }
    
    /**
     * Add event to span
     */
    addSpanEvent(spanId, name, attributes = {}) {
        const span = this.spans.get(spanId);
        if (!span || span.events.length >= this.config.maxEventsPerSpan) return;
        
        span.events.push({
            name,
            timestamp: Date.now(),
            attributes
        });
    }
    
    /**
     * Add attributes to span
     */
    addAttributes(span, attributes) {
        const currentCount = Object.keys(span.attributes).length;
        const newAttributes = Object.entries(attributes);
        
        for (const [key, value] of newAttributes) {
            if (currentCount >= this.config.maxAttributesPerSpan) break;
            span.attributes[key] = value;
        }
    }
    
    /**
     * Set span status
     */
    setSpanStatus(spanId, status) {
        const span = this.spans.get(spanId);
        if (span) {
            span.status = status;
        }
    }
    
    /**
     * Add default attributes
     */
    addDefaultAttributes(span) {
        span.attributes = {
            'service.name': this.config.serviceName,
            'service.version': this.config.serviceVersion,
            'service.environment': this.config.environment,
            'process.pid': process.pid,
            'host.name': require('os').hostname(),
            'span.kind': 'internal'
        };
    }
    
    /**
     * Determine if span should be sampled
     */
    shouldSample(traceId, operationName, options) {
        // Check cache first
        if (this.samplingCache.has(traceId)) {
            return this.samplingCache.get(traceId);
        }
        
        // Always sample certain operations
        if (this.config.alwaysSample.includes(operationName)) {
            this.samplingCache.set(traceId, true);
            return true;
        }
        
        // Always sample errors
        if (options.error) {
            this.samplingCache.set(traceId, true);
            return true;
        }
        
        // Probabilistic sampling
        const sampled = Math.random() < this.config.samplingRate;
        this.samplingCache.set(traceId, sampled);
        
        // Clean cache periodically
        if (this.samplingCache.size > 10000) {
            const entriesToDelete = Array.from(this.samplingCache.keys()).slice(0, 5000);
            entriesToDelete.forEach(key => this.samplingCache.delete(key));
        }
        
        return sampled;
    }
    
    /**
     * Setup exporters
     */
    setupExporters() {
        this.exporters = [];
        
        for (const exporterType of this.config.exporters) {
            switch (exporterType) {
                case 'console':
                    this.exporters.push(new ConsoleExporter());
                    break;
                    
                case 'jaeger':
                    this.exporters.push(new JaegerExporter(this.config));
                    break;
                    
                case 'zipkin':
                    this.exporters.push(new ZipkinExporter(this.config));
                    break;
                    
                case 'otlp':
                    this.exporters.push(new OTLPExporter(this.config));
                    break;
            }
        }
    }
    
    /**
     * Start batch processing
     */
    startBatchProcessing() {
        setInterval(() => {
            if (this.pendingSpans.length > 0) {
                this.exportSpans();
            }
        }, this.config.batchInterval);
    }
    
    /**
     * Export spans
     */
    async exportSpans() {
        if (this.pendingSpans.length === 0) return;
        
        const spansToExport = this.pendingSpans.splice(0, this.config.batchSize);
        
        for (const exporter of this.exporters) {
            try {
                await exporter.export(spansToExport);
            } catch (error) {
                console.error('エクスポートエラー:', error);
            }
        }
        
        // Clean up old spans
        this.cleanupOldSpans();
    }
    
    /**
     * Setup context propagation
     */
    setupContextPropagation() {
        // HTTP context propagation
        this.httpPropagator = {
            inject: (span, headers) => {
                headers['x-trace-id'] = span.traceId;
                headers['x-span-id'] = span.spanId;
                headers['x-parent-span-id'] = span.parentSpanId || '';
                headers['x-sampling-decision'] = span.sampled ? '1' : '0';
            },
            
            extract: (headers) => {
                return {
                    traceId: headers['x-trace-id'],
                    parentSpanId: headers['x-span-id'],
                    sampled: headers['x-sampling-decision'] === '1'
                };
            }
        };
    }
    
    /**
     * Continue trace from context
     */
    continueTrace(context, operationName, options = {}) {
        const { traceId, parentSpanId, sampled } = context;
        
        if (!traceId) {
            return this.createTrace(operationName, options);
        }
        
        // Set sampling decision
        this.samplingCache.set(traceId, sampled);
        
        const span = this.createSpan(traceId, parentSpanId, operationName, options);
        
        return {
            spanId: span.spanId,
            end: (status = 'ok', attributes = {}) => this.endSpan(span.spanId, status, attributes),
            addEvent: (name, attributes) => this.addSpanEvent(span.spanId, name, attributes),
            setAttributes: (attributes) => this.addAttributes(span, attributes),
            trace: (operationName, options) => this.createChildSpan(traceId, span.spanId, operationName, options)
        };
    }
    
    /**
     * Clean up old spans
     */
    cleanupOldSpans() {
        const cutoff = Date.now() - this.config.storageRetention;
        
        for (const [spanId, span] of this.spans) {
            if (span.endTime && span.endTime < cutoff) {
                this.spans.delete(spanId);
            }
        }
        
        for (const [traceId, trace] of this.traces) {
            if (trace.startTime < cutoff) {
                this.traces.delete(traceId);
            }
        }
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
    
    /**
     * Get trace by ID
     */
    getTrace(traceId) {
        return this.traces.get(traceId);
    }
    
    /**
     * Get span by ID
     */
    getSpan(spanId) {
        return this.spans.get(spanId);
    }
    
    /**
     * Get statistics
     */
    getStatistics() {
        return {
            ...this.stats,
            activeTraces: this.traces.size,
            activeSpans: this.spans.size,
            pendingExport: this.pendingSpans.length,
            samplingCacheSize: this.samplingCache.size
        };
    }
    
    /**
     * Create middleware for Express
     */
    expressMiddleware() {
        return (req, res, next) => {
            // Extract context from headers
            const context = this.httpPropagator.extract(req.headers);
            
            // Start span
            const span = this.continueTrace(context, `${req.method} ${req.path}`, {
                attributes: {
                    'http.method': req.method,
                    'http.url': req.url,
                    'http.target': req.path,
                    'http.host': req.hostname,
                    'http.scheme': req.protocol,
                    'http.user_agent': req.headers['user-agent'],
                    'http.remote_addr': req.ip
                }
            });
            
            // Attach to request
            req.span = span;
            
            // Hook into response
            const originalEnd = res.end;
            res.end = function(...args) {
                span.setAttributes({
                    'http.status_code': res.statusCode,
                    'http.response_size': res.get('content-length') || 0
                });
                
                const status = res.statusCode >= 400 ? 'error' : 'ok';
                span.end(status);
                
                originalEnd.apply(res, args);
            };
            
            next();
        };
    }
}

/**
 * Console Exporter
 */
class ConsoleExporter {
    async export(spans) {
        console.log('=== Distributed Traces ===');
        for (const span of spans) {
            console.log({
                traceId: span.traceId,
                spanId: span.spanId,
                operation: span.operationName,
                duration: `${span.duration}ms`,
                status: span.status,
                attributes: span.attributes
            });
        }
    }
}

/**
 * Jaeger Exporter (placeholder)
 */
class JaegerExporter {
    constructor(config) {
        this.endpoint = config.exportEndpoint;
    }
    
    async export(spans) {
        // Convert to Jaeger format and send
        const batch = this.convertToJaegerFormat(spans);
        // await this.sendToJaeger(batch);
    }
    
    convertToJaegerFormat(spans) {
        // Convert spans to Jaeger Thrift format
        return spans.map(span => ({
            traceID: span.traceId,
            spanID: span.spanId,
            operationName: span.operationName,
            startTime: span.startTime * 1000, // microseconds
            duration: span.duration * 1000,
            tags: Object.entries(span.attributes).map(([key, value]) => ({
                key,
                value: String(value)
            }))
        }));
    }
}

/**
 * Zipkin Exporter (placeholder)
 */
class ZipkinExporter {
    constructor(config) {
        this.endpoint = config.exportEndpoint;
    }
    
    async export(spans) {
        // Convert to Zipkin format and send
        const batch = this.convertToZipkinFormat(spans);
        // await this.sendToZipkin(batch);
    }
    
    convertToZipkinFormat(spans) {
        return spans.map(span => ({
            traceId: span.traceId,
            id: span.spanId,
            parentId: span.parentSpanId,
            name: span.operationName,
            timestamp: span.startTime * 1000,
            duration: span.duration * 1000,
            localEndpoint: {
                serviceName: span.serviceName
            },
            tags: span.attributes
        }));
    }
}

/**
 * OpenTelemetry Protocol Exporter (placeholder)
 */
class OTLPExporter {
    constructor(config) {
        this.endpoint = config.exportEndpoint;
    }
    
    async export(spans) {
        // Convert to OTLP format and send
        // Implementation would use protobuf or JSON encoding
    }
}

module.exports = DistributedTracingSystem;