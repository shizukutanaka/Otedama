/**
 * Trace Exporters for Otedama
 * Export spans to various backends
 * 
 * Design principles:
 * - Carmack: Efficient batching and compression
 * - Martin: Clean exporter interfaces
 * - Pike: Simple export protocols
 */

import { createWriteStream, promises as fs } from 'fs';
import { join } from 'path';
import { gzip } from 'zlib';
import { promisify } from 'util';
import { logger } from '../core/logger.js';

const gzipAsync = promisify(gzip);

/**
 * Base trace exporter
 */
export class TraceExporter {
  constructor(options = {}) {
    this.name = options.name || 'base-exporter';
    this.options = options;
    this.metrics = {
      exported: 0,
      failed: 0,
      batches: 0
    };
  }
  
  async export(spans) {
    throw new Error('export() must be implemented by subclass');
  }
  
  async shutdown() {
    // Override in subclass if needed
  }
}

/**
 * Console exporter for debugging
 */
export class ConsoleExporter extends TraceExporter {
  constructor(options = {}) {
    super({ name: 'console-exporter', ...options });
    this.pretty = options.pretty !== false;
  }
  
  async export(spans) {
    try {
      for (const span of spans) {
        const output = this.pretty ? 
          JSON.stringify(span.toJSON(), null, 2) : 
          JSON.stringify(span.toJSON());
        
        console.log(`[TRACE] ${output}`);
      }
      
      this.metrics.exported += spans.length;
      this.metrics.batches++;
    } catch (error) {
      this.metrics.failed += spans.length;
      throw error;
    }
  }
}

/**
 * File exporter - writes traces to files
 */
export class FileExporter extends TraceExporter {
  constructor(options = {}) {
    super({ name: 'file-exporter', ...options });
    
    this.outputDir = options.outputDir || './traces';
    this.fileFormat = options.fileFormat || 'jsonl'; // json, jsonl, csv
    this.compress = options.compress !== false;
    this.rotateSize = options.rotateSize || 100 * 1024 * 1024; // 100MB
    this.rotateInterval = options.rotateInterval || 3600000; // 1 hour
    
    this.currentFile = null;
    this.currentStream = null;
    this.currentSize = 0;
    this.lastRotation = Date.now();
  }
  
  async export(spans) {
    try {
      // Ensure output directory exists
      await fs.mkdir(this.outputDir, { recursive: true });
      
      // Check if rotation needed
      if (this._shouldRotate()) {
        await this._rotate();
      }
      
      // Get or create stream
      const stream = await this._getStream();
      
      // Write spans
      for (const span of spans) {
        const line = this._formatSpan(span);
        const data = Buffer.from(line + '\n');
        
        stream.write(data);
        this.currentSize += data.length;
      }
      
      this.metrics.exported += spans.length;
      this.metrics.batches++;
    } catch (error) {
      this.metrics.failed += spans.length;
      throw error;
    }
  }
  
  async shutdown() {
    if (this.currentStream) {
      await new Promise((resolve, reject) => {
        this.currentStream.end(error => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
  
  _shouldRotate() {
    return !this.currentFile ||
           this.currentSize >= this.rotateSize ||
           (Date.now() - this.lastRotation) >= this.rotateInterval;
  }
  
  async _rotate() {
    // Close current stream
    if (this.currentStream) {
      await new Promise(resolve => this.currentStream.end(resolve));
    }
    
    // Generate new filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const extension = this.compress ? `.${this.fileFormat}.gz` : `.${this.fileFormat}`;
    this.currentFile = join(this.outputDir, `traces-${timestamp}${extension}`);
    
    // Create new stream
    this.currentStream = null;
    this.currentSize = 0;
    this.lastRotation = Date.now();
  }
  
  async _getStream() {
    if (!this.currentStream) {
      this.currentStream = createWriteStream(this.currentFile, {
        flags: 'a',
        encoding: 'utf8'
      });
    }
    return this.currentStream;
  }
  
  _formatSpan(span) {
    switch (this.fileFormat) {
      case 'json':
      case 'jsonl':
        return JSON.stringify(span.toJSON());
        
      case 'csv':
        return this._formatCSV(span);
        
      default:
        return JSON.stringify(span.toJSON());
    }
  }
  
  _formatCSV(span) {
    const data = span.toJSON();
    return [
      data.traceId,
      data.spanId,
      data.parentSpanId || '',
      data.name,
      data.kind,
      data.startTime,
      data.endTime || '',
      data.duration || '',
      data.status,
      JSON.stringify(data.attributes)
    ].join(',');
  }
}

/**
 * OTLP (OpenTelemetry Protocol) exporter
 */
export class OTLPExporter extends TraceExporter {
  constructor(options = {}) {
    super({ name: 'otlp-exporter', ...options });
    
    this.endpoint = options.endpoint || 'http://localhost:4318/v1/traces';
    this.headers = options.headers || {};
    this.timeout = options.timeout || 10000;
    this.compression = options.compression || 'gzip';
    
    // Add default headers
    this.headers['Content-Type'] = 'application/x-protobuf';
    if (this.compression === 'gzip') {
      this.headers['Content-Encoding'] = 'gzip';
    }
  }
  
  async export(spans) {
    try {
      const payload = this._convertToOTLP(spans);
      const body = JSON.stringify(payload);
      
      // Compress if needed
      const data = this.compression === 'gzip' ? 
        await gzipAsync(body) : Buffer.from(body);
      
      // Send to collector
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: this.headers,
        body: data,
        signal: AbortSignal.timeout(this.timeout)
      });
      
      if (!response.ok) {
        throw new Error(`OTLP export failed: ${response.status} ${response.statusText}`);
      }
      
      this.metrics.exported += spans.length;
      this.metrics.batches++;
    } catch (error) {
      this.metrics.failed += spans.length;
      throw error;
    }
  }
  
  _convertToOTLP(spans) {
    // Convert to OTLP JSON format
    const resourceSpans = {
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: spans[0]?.attributes.get('service.name') || 'unknown' } },
          { key: 'service.version', value: { stringValue: spans[0]?.attributes.get('service.version') || '1.0.0' } }
        ]
      },
      scopeSpans: [{
        scope: {
          name: 'otedama-tracer',
          version: '1.0.0'
        },
        spans: spans.map(span => this._spanToOTLP(span))
      }]
    };
    
    return { resourceSpans: [resourceSpans] };
  }
  
  _spanToOTLP(span) {
    const data = span.toJSON();
    
    return {
      traceId: this._hexToBase64(data.traceId),
      spanId: this._hexToBase64(data.spanId),
      parentSpanId: data.parentSpanId ? this._hexToBase64(data.parentSpanId) : undefined,
      name: data.name,
      kind: this._mapSpanKind(data.kind),
      startTimeUnixNano: String(data.startTime * 1000000),
      endTimeUnixNano: data.endTime ? String(data.endTime * 1000000) : undefined,
      attributes: this._mapAttributes(data.attributes),
      events: data.events.map(e => this._eventToOTLP(e)),
      status: {
        code: this._mapStatusCode(data.status),
        message: data.statusMessage
      }
    };
  }
  
  _hexToBase64(hex) {
    return Buffer.from(hex, 'hex').toString('base64');
  }
  
  _mapSpanKind(kind) {
    const kinds = {
      'INTERNAL': 1,
      'SERVER': 2,
      'CLIENT': 3,
      'PRODUCER': 4,
      'CONSUMER': 5
    };
    return kinds[kind] || 0;
  }
  
  _mapStatusCode(status) {
    const codes = {
      'UNSET': 0,
      'OK': 1,
      'ERROR': 2
    };
    return codes[status] || 0;
  }
  
  _mapAttributes(attributes) {
    return Object.entries(attributes).map(([key, value]) => ({
      key,
      value: this._attributeValue(value)
    }));
  }
  
  _attributeValue(value) {
    if (typeof value === 'string') {
      return { stringValue: value };
    } else if (typeof value === 'number') {
      return Number.isInteger(value) ? 
        { intValue: String(value) } : 
        { doubleValue: value };
    } else if (typeof value === 'boolean') {
      return { boolValue: value };
    } else if (Array.isArray(value)) {
      return { arrayValue: { values: value.map(v => this._attributeValue(v)) } };
    } else {
      return { stringValue: String(value) };
    }
  }
  
  _eventToOTLP(event) {
    return {
      timeUnixNano: String(event.timestamp * 1000000),
      name: event.name,
      attributes: this._mapAttributes(event.attributes)
    };
  }
}

/**
 * Metrics exporter - converts traces to metrics
 */
export class MetricsExporter extends TraceExporter {
  constructor(options = {}) {
    super({ name: 'metrics-exporter', ...options });
    
    this.metricsCollector = options.metricsCollector;
    this.buckets = options.buckets || [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
  }
  
  async export(spans) {
    try {
      for (const span of spans) {
        const data = span.toJSON();
        
        // Record span duration
        if (data.duration) {
          this.metricsCollector?.histogram('span_duration_seconds', data.duration / 1000, {
            service: data.attributes['service.name'],
            operation: data.name,
            kind: data.kind,
            status: data.status
          });
        }
        
        // Count spans by status
        this.metricsCollector?.increment('spans_total', {
          service: data.attributes['service.name'],
          operation: data.name,
          status: data.status
        });
        
        // Track errors
        if (data.status === 'ERROR') {
          this.metricsCollector?.increment('span_errors_total', {
            service: data.attributes['service.name'],
            operation: data.name
          });
        }
      }
      
      this.metrics.exported += spans.length;
    } catch (error) {
      this.metrics.failed += spans.length;
      throw error;
    }
  }
}

/**
 * Composite exporter - sends to multiple exporters
 */
export class CompositeExporter extends TraceExporter {
  constructor(exporters = []) {
    super({ name: 'composite-exporter' });
    this.exporters = exporters;
  }
  
  async export(spans) {
    const results = await Promise.allSettled(
      this.exporters.map(exporter => exporter.export(spans))
    );
    
    // Count successes and failures
    let exported = 0;
    let failed = 0;
    
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        exported++;
      } else {
        failed++;
        logger.error('Exporter failed', {
          exporter: this.exporters[index].name,
          error: result.reason
        });
      }
    });
    
    this.metrics.exported += exported;
    this.metrics.failed += failed;
    
    // Throw if all exporters failed
    if (failed === this.exporters.length) {
      throw new Error('All exporters failed');
    }
  }
  
  async shutdown() {
    await Promise.all(
      this.exporters.map(exporter => 
        exporter.shutdown().catch(error => {
          logger.error('Failed to shutdown exporter', { 
            exporter: exporter.name, 
            error 
          });
        })
      )
    );
  }
  
  addExporter(exporter) {
    this.exporters.push(exporter);
  }
}

/**
 * Create exporter based on configuration
 */
export function createExporter(type, options = {}) {
  switch (type) {
    case 'console':
      return new ConsoleExporter(options);
      
    case 'file':
      return new FileExporter(options);
      
    case 'otlp':
      return new OTLPExporter(options);
      
    case 'metrics':
      return new MetricsExporter(options);
      
    case 'composite':
      return new CompositeExporter(options.exporters || []);
      
    default:
      throw new Error(`Unknown exporter type: ${type}`);
  }
}

export default {
  TraceExporter,
  ConsoleExporter,
  FileExporter,
  OTLPExporter,
  MetricsExporter,
  CompositeExporter,
  createExporter
};