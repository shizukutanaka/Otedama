/**
 * Setup Distributed Tracing for Otedama
 * Initializes and configures the tracing system
 * 
 * Design principles:
 * - Carmack: Minimal setup overhead
 * - Martin: Clean configuration
 * - Pike: Simple integration
 */

import { Tracer, getTracer, setGlobalTracer } from './tracer.js';
import { createExporter, CompositeExporter } from './exporters.js';
import { instrumentExpress, instrumentDatabase, instrumentCache } from './instrumentation.js';
import { createTraceMiddleware, createTraceErrorMiddleware } from './trace-middleware.js';
import { logger } from '../core/logger.js';

/**
 * Setup tracing for the application
 */
export async function setupTracing(app, config = {}) {
  try {
    // Create tracer
    const tracer = new Tracer({
      serviceName: config.serviceName || process.env.OTEL_SERVICE_NAME || 'otedama',
      serviceVersion: config.serviceVersion || process.env.OTEL_SERVICE_VERSION || '1.0.0',
      
      // Sampling configuration
      samplingRate: config.samplingRate || parseFloat(process.env.OTEL_SAMPLING_RATE || '1.0'),
      samplingStrategy: config.samplingStrategy || process.env.OTEL_SAMPLING_STRATEGY || 'probabilistic',
      
      // Export configuration
      exportInterval: config.exportInterval || parseInt(process.env.OTEL_EXPORT_INTERVAL || '5000'),
      maxExportBatchSize: config.maxExportBatchSize || parseInt(process.env.OTEL_BATCH_SIZE || '512'),
      
      // Performance options
      enableAutoInstrumentation: config.enableAutoInstrumentation !== false,
      recordStackTraces: config.recordStackTraces || process.env.OTEL_RECORD_STACK_TRACES === 'true'
    });
    
    // Set as global tracer
    setGlobalTracer(tracer);
    
    // Configure exporters
    const exporters = [];
    
    // Console exporter (development)
    if (config.enableConsoleExporter || process.env.OTEL_CONSOLE_EXPORTER === 'true') {
      exporters.push(createExporter('console', {
        pretty: process.env.NODE_ENV === 'development'
      }));
    }
    
    // File exporter
    if (config.enableFileExporter || process.env.OTEL_FILE_EXPORTER === 'true') {
      exporters.push(createExporter('file', {
        outputDir: config.traceOutputDir || process.env.OTEL_TRACE_DIR || './traces',
        compress: true,
        rotateSize: 100 * 1024 * 1024, // 100MB
        rotateInterval: 3600000 // 1 hour
      }));
    }
    
    // OTLP exporter
    if (config.otlpEndpoint || process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
      exporters.push(createExporter('otlp', {
        endpoint: config.otlpEndpoint || process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
        headers: config.otlpHeaders || parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
        compression: 'gzip'
      }));
    }
    
    // Metrics exporter
    if (config.metricsCollector) {
      exporters.push(createExporter('metrics', {
        metricsCollector: config.metricsCollector
      }));
    }
    
    // Add composite exporter if we have multiple exporters
    if (exporters.length > 0) {
      const compositeExporter = new CompositeExporter(exporters);
      tracer.addExporter(compositeExporter);
    }
    
    // Add Express middleware
    if (app && config.enableHttpTracing !== false) {
      app.use(createTraceMiddleware({
        tracer,
        serviceName: config.serviceName,
        skipPaths: config.skipPaths || ['/health', '/metrics', '/favicon.ico'],
        recordBody: config.recordRequestBody || false,
        recordHeaders: config.recordHeaders || false
      }));
      
      // Add error middleware (should be last)
      app.use(createTraceErrorMiddleware({
        recordStackTrace: config.recordStackTraces !== false
      }));
      
      logger.info('HTTP tracing middleware installed');
    }
    
    // Instrument modules if requested
    if (config.instrumentModules) {
      await instrumentModules(tracer, config.instrumentModules);
    }
    
    // Log configuration
    logger.info('Distributed tracing initialized', {
      serviceName: tracer.options.serviceName,
      serviceVersion: tracer.options.serviceVersion,
      samplingRate: tracer.options.samplingRate,
      exporters: exporters.length,
      exportInterval: tracer.options.exportInterval
    });
    
    // Register shutdown handler
    process.on('SIGTERM', async () => {
      logger.info('Shutting down tracer...');
      await tracer.shutdown();
    });
    
    return tracer;
    
  } catch (error) {
    logger.error('Failed to setup tracing', error);
    // Return a no-op tracer if setup fails
    return {
      startSpan: () => ({ end: () => {} }),
      trace: async (name, fn) => fn({ end: () => {} }),
      shutdown: async () => {}
    };
  }
}

/**
 * Instrument modules
 */
async function instrumentModules(tracer, modules) {
  for (const [moduleName, moduleConfig] of Object.entries(modules)) {
    try {
      switch (moduleName) {
        case 'database':
          if (moduleConfig.instance) {
            instrumentDatabase(moduleConfig.instance, {
              tracer,
              dbType: moduleConfig.type || 'sql',
              dbName: moduleConfig.name || 'otedama'
            });
            logger.info(`Instrumented database: ${moduleConfig.name}`);
          }
          break;
          
        case 'cache':
          if (moduleConfig.instance) {
            instrumentCache(moduleConfig.instance, {
              tracer,
              cacheName: moduleConfig.name || 'cache'
            });
            logger.info(`Instrumented cache: ${moduleConfig.name}`);
          }
          break;
          
        case 'http':
          // Instrument outgoing HTTP requests
          const http = await import('http');
          const https = await import('https');
          instrumentHttp(http.default, { tracer });
          instrumentHttp(https.default, { tracer });
          logger.info('Instrumented HTTP/HTTPS modules');
          break;
          
        default:
          logger.warn(`Unknown module for instrumentation: ${moduleName}`);
      }
    } catch (error) {
      logger.error(`Failed to instrument ${moduleName}`, error);
    }
  }
}

/**
 * Parse headers from environment variable
 */
function parseHeaders(headerString) {
  if (!headerString) return {};
  
  const headers = {};
  const pairs = headerString.split(',');
  
  for (const pair of pairs) {
    const [key, value] = pair.split('=');
    if (key && value) {
      headers[key.trim()] = value.trim();
    }
  }
  
  return headers;
}

/**
 * Create traced route handler
 */
export function tracedRoute(name, handler) {
  const tracer = getTracer();
  
  return async (req, res, next) => {
    return tracer.trace(name, async (span) => {
      // Add route-specific attributes
      span.setAttributes({
        'route.params': JSON.stringify(req.params),
        'route.query': JSON.stringify(req.query)
      });
      
      // Attach span to request
      const originalSpan = req.span;
      req.span = span;
      
      try {
        await handler(req, res, next);
      } finally {
        req.span = originalSpan;
      }
    });
  };
}

/**
 * Create traced middleware
 */
export function tracedMiddleware(name, middleware) {
  const tracer = getTracer();
  
  return async (req, res, next) => {
    return tracer.trace(name, async (span) => {
      span.setAttribute('middleware.name', name);
      
      // Attach span to request
      const originalSpan = req.span;
      req.span = span;
      
      try {
        await middleware(req, res, next);
      } finally {
        req.span = originalSpan;
      }
    });
  };
}

/**
 * Trace async function
 */
export function traced(name, options = {}) {
  const tracer = getTracer();
  
  return function decorator(target, propertyKey, descriptor) {
    const originalMethod = descriptor.value;
    
    descriptor.value = async function(...args) {
      return tracer.trace(name || `${target.constructor.name}.${propertyKey}`, async (span) => {
        if (options.recordArgs) {
          span.setAttribute('function.args', JSON.stringify(args));
        }
        
        return originalMethod.apply(this, args);
      });
    };
    
    return descriptor;
  };
}

/**
 * Manual span creation helper
 */
export function createSpan(name, options = {}) {
  const tracer = getTracer();
  return tracer.startSpan(name, options);
}

/**
 * Get current span from request
 */
export function getCurrentSpan(req) {
  return req?.span || null;
}

/**
 * Add attributes to current span
 */
export function addSpanAttributes(req, attributes) {
  if (req?.span) {
    req.span.setAttributes(attributes);
  }
}

/**
 * Record event on current span
 */
export function addSpanEvent(req, name, attributes) {
  if (req?.span) {
    req.span.addEvent(name, attributes);
  }
}

export default {
  setupTracing,
  tracedRoute,
  tracedMiddleware,
  traced,
  createSpan,
  getCurrentSpan,
  addSpanAttributes,
  addSpanEvent
};