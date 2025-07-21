/**
 * Trace Middleware for Otedama
 * Express middleware for distributed tracing
 * 
 * Design principles:
 * - Carmack: Minimal request overhead
 * - Martin: Clean middleware integration
 * - Pike: Simple trace propagation
 */

import { getTracer, SpanKind, SpanStatus } from './tracer.js';
import { logger } from '../core/logger.js';

/**
 * Create tracing middleware
 */
export function createTraceMiddleware(options = {}) {
  const tracer = options.tracer || getTracer();
  const serviceName = options.serviceName || 'otedama-api';
  const skipPaths = new Set(options.skipPaths || ['/health', '/metrics']);
  const recordBody = options.recordBody || false;
  const recordHeaders = options.recordHeaders || false;
  
  return (req, res, next) => {
    // Skip tracing for certain paths
    if (skipPaths.has(req.path)) {
      return next();
    }
    
    // Extract parent context from headers
    const parentContext = tracer.extract(req.headers);
    
    // Start span
    const span = tracer.startSpan(`${req.method} ${req.route?.path || req.path}`, {
      parent: parentContext,
      kind: SpanKind.SERVER,
      attributes: {
        'service.name': serviceName,
        'http.method': req.method,
        'http.url': req.url,
        'http.target': req.path,
        'http.host': req.hostname,
        'http.scheme': req.protocol,
        'http.user_agent': req.headers['user-agent'],
        'http.request_content_length': req.headers['content-length'] || 0,
        'http.request_content_type': req.headers['content-type'],
        'net.host.name': req.hostname,
        'net.host.port': req.socket.localPort,
        'net.peer.ip': req.ip || req.connection.remoteAddress,
        'net.peer.port': req.connection.remotePort
      }
    });
    
    // Record headers if enabled
    if (recordHeaders) {
      for (const [key, value] of Object.entries(req.headers)) {
        if (!key.toLowerCase().includes('authorization')) {
          span.setAttribute(`http.request.header.${key}`, value);
        }
      }
    }
    
    // Record body if enabled
    if (recordBody && req.body) {
      span.setAttribute('http.request.body', JSON.stringify(req.body));
    }
    
    // Attach to request
    req.span = span;
    req.traceContext = span.context;
    
    // Inject trace context into response headers
    res.setHeader('X-Trace-Id', span.context.traceId);
    
    // Track response
    const originalSend = res.send;
    const originalJson = res.json;
    const originalEnd = res.end;
    
    // Helper to finish span
    const finishSpan = () => {
      if (span.endTime) return; // Already ended
      
      span.setAttributes({
        'http.status_code': res.statusCode,
        'http.response_content_length': res.get('content-length') || 0,
        'http.response_content_type': res.get('content-type')
      });
      
      // Set status based on HTTP status code
      if (res.statusCode >= 400) {
        span.setStatus(SpanStatus.ERROR, `HTTP ${res.statusCode}`);
      } else {
        span.setStatus(SpanStatus.OK);
      }
      
      span.end();
    };
    
    // Override response methods
    res.send = function(data) {
      finishSpan();
      return originalSend.call(this, data);
    };
    
    res.json = function(data) {
      finishSpan();
      return originalJson.call(this, data);
    };
    
    res.end = function(...args) {
      finishSpan();
      return originalEnd.call(this, ...args);
    };
    
    // Handle errors
    const errorHandler = (error) => {
      span.recordException(error);
      span.setStatus(SpanStatus.ERROR);
      finishSpan();
    };
    
    res.on('error', errorHandler);
    res.on('close', finishSpan);
    
    next();
  };
}

/**
 * Create error handling middleware for traces
 */
export function createTraceErrorMiddleware(options = {}) {
  const recordStackTrace = options.recordStackTrace !== false;
  
  return (err, req, res, next) => {
    if (req.span) {
      req.span.recordException(err, {
        'http.request.method': req.method,
        'http.request.url': req.url,
        'exception.escaped': true
      });
      
      if (recordStackTrace && err.stack) {
        req.span.setAttribute('exception.stacktrace', err.stack);
      }
    }
    
    next(err);
  };
}

/**
 * Create route-specific tracing middleware
 */
export function traceRoute(name, options = {}) {
  const tracer = options.tracer || getTracer();
  
  return (req, res, next) => {
    // Create child span if parent exists
    const parentSpan = req.span;
    
    const span = tracer.startSpan(name, {
      parent: parentSpan?.context,
      kind: SpanKind.INTERNAL,
      attributes: {
        'route.name': name,
        'route.path': req.route?.path || req.path,
        'route.method': req.method,
        ...options.attributes
      }
    });
    
    // Store original span and replace with new one
    const originalSpan = req.span;
    req.span = span;
    
    // Restore original span when done
    const cleanup = () => {
      span.end();
      req.span = originalSpan;
    };
    
    // Hook into response
    res.on('finish', cleanup);
    res.on('close', cleanup);
    res.on('error', (error) => {
      span.recordException(error);
      cleanup();
    });
    
    next();
  };
}

/**
 * Create async route wrapper with tracing
 */
export function traceAsyncRoute(name, handler, options = {}) {
  const tracer = options.tracer || getTracer();
  
  return async (req, res, next) => {
    const span = tracer.startSpan(name, {
      parent: req.span?.context,
      kind: SpanKind.INTERNAL,
      attributes: {
        'route.name': name,
        'route.async': true,
        ...options.attributes
      }
    });
    
    try {
      await handler(req, res, next);
      span.setStatus(SpanStatus.OK);
    } catch (error) {
      span.recordException(error);
      next(error);
    } finally {
      span.end();
    }
  };
}

/**
 * Trace database query middleware
 */
export function traceDatabaseQuery(queryName, options = {}) {
  const tracer = options.tracer || getTracer();
  
  return (req, res, next) => {
    req.traceQuery = (sql, params) => {
      const span = tracer.startSpan(`db.${queryName}`, {
        parent: req.span?.context,
        kind: SpanKind.CLIENT,
        attributes: {
          'db.operation': queryName,
          'db.statement': sql.substring(0, 1000),
          'db.params.count': Array.isArray(params) ? params.length : 0
        }
      });
      
      return {
        span,
        end: (result, error) => {
          if (error) {
            span.recordException(error);
          } else {
            span.setStatus(SpanStatus.OK);
            if (result && typeof result === 'object') {
              span.setAttribute('db.rows_affected', result.changes || result.affectedRows || 0);
            }
          }
          span.end();
        }
      };
    };
    
    next();
  };
}

/**
 * Create cache tracing middleware
 */
export function traceCacheOperation(cacheName, options = {}) {
  const tracer = options.tracer || getTracer();
  
  return (req, res, next) => {
    req.traceCache = {
      get: (key) => {
        const span = tracer.startSpan(`cache.get`, {
          parent: req.span?.context,
          kind: SpanKind.CLIENT,
          attributes: {
            'cache.name': cacheName,
            'cache.operation': 'get',
            'cache.key': key
          }
        });
        
        return {
          span,
          hit: () => {
            span.setAttribute('cache.hit', true);
            span.setStatus(SpanStatus.OK);
            span.end();
          },
          miss: () => {
            span.setAttribute('cache.hit', false);
            span.setStatus(SpanStatus.OK);
            span.end();
          },
          error: (error) => {
            span.recordException(error);
            span.end();
          }
        };
      },
      
      set: (key, ttl) => {
        const span = tracer.startSpan(`cache.set`, {
          parent: req.span?.context,
          kind: SpanKind.CLIENT,
          attributes: {
            'cache.name': cacheName,
            'cache.operation': 'set',
            'cache.key': key,
            'cache.ttl': ttl
          }
        });
        
        return {
          span,
          success: () => {
            span.setStatus(SpanStatus.OK);
            span.end();
          },
          error: (error) => {
            span.recordException(error);
            span.end();
          }
        };
      }
    };
    
    next();
  };
}

/**
 * Propagate trace context to outgoing requests
 */
export function propagateTrace(req, headers = {}) {
  if (req.span && req.span.context) {
    const tracer = getTracer();
    tracer.inject(req.span.context, headers);
  }
  return headers;
}

/**
 * Extract trace context from incoming request
 */
export function extractTrace(req) {
  const tracer = getTracer();
  return tracer.extract(req.headers);
}

export default {
  createTraceMiddleware,
  createTraceErrorMiddleware,
  traceRoute,
  traceAsyncRoute,
  traceDatabaseQuery,
  traceCacheOperation,
  propagateTrace,
  extractTrace
};