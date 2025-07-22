/**
 * Automatic Instrumentation for Otedama
 * Adds tracing to common operations automatically
 * 
 * Design principles:
 * - Carmack: Zero overhead when disabled
 * - Martin: Non-invasive instrumentation
 * - Pike: Simple wrapping patterns
 */

import { getTracer } from './tracer.js';
import { SpanKind, SpanStatus } from './tracer.js';
import { getLogger } from '../core/logger.js';

const logger = getLogger('Instrumentation');

/**
 * Instrument a class or object
 */
export function instrument(target, options = {}) {
  const tracer = options.tracer || getTracer();
  const prefix = options.prefix || target.constructor?.name || 'unknown';
  const skipMethods = new Set(options.skipMethods || ['constructor']);
  
  // Get all methods
  const methods = getAllMethods(target);
  
  // Instrument each method
  for (const methodName of methods) {
    if (skipMethods.has(methodName)) continue;
    
    const original = target[methodName];
    if (typeof original !== 'function') continue;
    
    target[methodName] = createInstrumentedMethod(
      original,
      `${prefix}.${methodName}`,
      tracer,
      options
    );
  }
  
  return target;
}

/**
 * Instrument a single function
 */
export function instrumentFunction(fn, name, options = {}) {
  const tracer = options.tracer || getTracer();
  return createInstrumentedMethod(fn, name, tracer, options);
}

/**
 * Create instrumented method
 */
function createInstrumentedMethod(original, name, tracer, options = {}) {
  const spanKind = options.spanKind || SpanKind.INTERNAL;
  const attributes = options.attributes || {};
  
  // Preserve function name and properties
  const instrumented = {
    [original.name || 'anonymous']: function(...args) {
      // Fast path if tracing is disabled
      if (!tracer || options.enabled === false) {
        return original.apply(this, args);
      }
      
      const span = tracer.startSpan(name, {
        kind: spanKind,
        attributes: {
          ...attributes,
          'function.name': name,
          'function.args.count': args.length
        }
      });
      
      try {
        // Handle both sync and async functions
        const result = original.apply(this, args);
        
        if (result && typeof result.then === 'function') {
          // Async function
          return result
            .then(value => {
              span.setStatus(SpanStatus.OK);
              return value;
            })
            .catch(error => {
              span.recordException(error);
              throw error;
            })
            .finally(() => {
              span.end();
            });
        } else {
          // Sync function
          span.setStatus(SpanStatus.OK);
          return result;
        }
      } catch (error) {
        span.recordException(error);
        throw error;
      } finally {
        // End span for sync functions
        if (!span.endTime) {
          span.end();
        }
      }
    }
  }[original.name || 'anonymous'];
  
  // Copy properties
  Object.setPrototypeOf(instrumented, Object.getPrototypeOf(original));
  Object.getOwnPropertyNames(original).forEach(name => {
    if (name !== 'length' && name !== 'name' && name !== 'prototype') {
      instrumented[name] = original[name];
    }
  });
  
  return instrumented;
}

/**
 * Instrument HTTP requests
 */
export function instrumentHttp(http, options = {}) {
  const tracer = options.tracer || getTracer();
  
  // Instrument request
  const originalRequest = http.request;
  http.request = function(url, opts, callback) {
    // Normalize arguments
    if (typeof url === 'string') {
      url = new URL(url);
    }
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    
    const method = opts.method || 'GET';
    const host = url.hostname || opts.hostname || 'localhost';
    const path = url.pathname || opts.path || '/';
    
    const span = tracer.startSpan(`HTTP ${method} ${host}${path}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        'http.method': method,
        'http.url': url.href || `${host}${path}`,
        'http.target': path,
        'http.host': host,
        'http.scheme': url.protocol?.replace(':', '') || 'http',
        'net.peer.name': host,
        'net.peer.port': url.port || (url.protocol === 'https:' ? 443 : 80)
      }
    });
    
    // Inject trace context
    const headers = opts.headers || {};
    tracer.inject(span.context, headers);
    opts.headers = headers;
    
    // Make request
    const req = originalRequest.call(http, url, opts, callback);
    
    // Handle response
    req.on('response', (res) => {
      span.setAttributes({
        'http.status_code': res.statusCode,
        'http.response_content_length': res.headers['content-length'] || 0
      });
      
      if (res.statusCode >= 400) {
        span.setStatus(SpanStatus.ERROR, `HTTP ${res.statusCode}`);
      } else {
        span.setStatus(SpanStatus.OK);
      }
    });
    
    // Handle errors
    req.on('error', (error) => {
      span.recordException(error);
    });
    
    // End span when request completes
    req.on('close', () => {
      span.end();
    });
    
    return req;
  };
  
  return http;
}

/**
 * Instrument Express middleware
 */
export function instrumentExpress(app, options = {}) {
  const tracer = options.tracer || getTracer();
  
  // Add tracing middleware
  app.use((req, res, next) => {
    // Extract parent context from headers
    const parentContext = tracer.extract(req.headers);
    
    const span = tracer.startSpan(`${req.method} ${req.path}`, {
      parent: parentContext,
      kind: SpanKind.SERVER,
      attributes: {
        'http.method': req.method,
        'http.url': req.url,
        'http.target': req.path,
        'http.host': req.hostname,
        'http.scheme': req.protocol,
        'http.user_agent': req.headers['user-agent'],
        'net.host.name': req.hostname,
        'net.peer.ip': req.ip
      }
    });
    
    // Attach span to request
    req.span = span;
    
    // Override res.json to capture response
    const originalJson = res.json.bind(res);
    res.json = function(data) {
      span.setAttributes({
        'http.status_code': res.statusCode,
        'http.response_content_type': 'application/json'
      });
      
      if (res.statusCode >= 400) {
        span.setStatus(SpanStatus.ERROR, `HTTP ${res.statusCode}`);
      } else {
        span.setStatus(SpanStatus.OK);
      }
      
      return originalJson(data);
    };
    
    // Handle response finish
    res.on('finish', () => {
      span.setAttributes({
        'http.status_code': res.statusCode
      });
      
      if (res.statusCode >= 400) {
        span.setStatus(SpanStatus.ERROR, `HTTP ${res.statusCode}`);
      } else {
        span.setStatus(SpanStatus.OK);
      }
      
      span.end();
    });
    
    // Handle errors
    res.on('error', (error) => {
      span.recordException(error);
      span.end();
    });
    
    next();
  });
  
  return app;
}

/**
 * Instrument database operations
 */
export function instrumentDatabase(db, options = {}) {
  const tracer = options.tracer || getTracer();
  const dbType = options.dbType || 'sql';
  const dbName = options.dbName || 'unknown';
  
  // Common database methods to instrument
  const methods = ['query', 'execute', 'prepare', 'all', 'get', 'run'];
  
  for (const method of methods) {
    if (typeof db[method] !== 'function') continue;
    
    const original = db[method];
    db[method] = function(sql, ...args) {
      const span = tracer.startSpan(`${dbType}.${method}`, {
        kind: SpanKind.CLIENT,
        attributes: {
          'db.type': dbType,
          'db.name': dbName,
          'db.operation': method,
          'db.statement': truncateSQL(sql)
        }
      });
      
      try {
        const result = original.apply(this, [sql, ...args]);
        
        if (result && typeof result.then === 'function') {
          return result
            .then(value => {
              span.setStatus(SpanStatus.OK);
              if (value && typeof value === 'object') {
                span.setAttribute('db.rows_affected', value.changes || 0);
              }
              return value;
            })
            .catch(error => {
              span.recordException(error);
              throw error;
            })
            .finally(() => {
              span.end();
            });
        } else {
          span.setStatus(SpanStatus.OK);
          if (result && typeof result === 'object') {
            span.setAttribute('db.rows_affected', result.changes || 0);
          }
          span.end();
          return result;
        }
      } catch (error) {
        span.recordException(error);
        span.end();
        throw error;
      }
    };
  }
  
  return db;
}

/**
 * Instrument cache operations
 */
export function instrumentCache(cache, options = {}) {
  const tracer = options.tracer || getTracer();
  const cacheName = options.cacheName || 'cache';
  
  // Instrument get
  if (cache.get) {
    cache.get = instrumentFunction(cache.get, `${cacheName}.get`, {
      tracer,
      spanKind: SpanKind.CLIENT,
      attributes: { 'cache.name': cacheName }
    });
  }
  
  // Instrument set
  if (cache.set) {
    cache.set = instrumentFunction(cache.set, `${cacheName}.set`, {
      tracer,
      spanKind: SpanKind.CLIENT,
      attributes: { 'cache.name': cacheName }
    });
  }
  
  // Instrument delete
  if (cache.delete) {
    cache.delete = instrumentFunction(cache.delete, `${cacheName}.delete`, {
      tracer,
      spanKind: SpanKind.CLIENT,
      attributes: { 'cache.name': cacheName }
    });
  }
  
  return cache;
}

/**
 * Create traced class
 */
export function createTracedClass(BaseClass, options = {}) {
  const tracer = options.tracer || getTracer();
  const className = options.className || BaseClass.name;
  
  return class TracedClass extends BaseClass {
    constructor(...args) {
      super(...args);
      
      // Instrument all methods
      instrument(this, {
        tracer,
        prefix: className,
        skipMethods: ['constructor', ...options.skipMethods || []]
      });
    }
  };
}

/**
 * Helper functions
 */
function getAllMethods(obj) {
  const methods = new Set();
  
  // Get own methods
  Object.getOwnPropertyNames(obj).forEach(name => {
    if (typeof obj[name] === 'function') {
      methods.add(name);
    }
  });
  
  // Get prototype methods
  let proto = Object.getPrototypeOf(obj);
  while (proto && proto !== Object.prototype) {
    Object.getOwnPropertyNames(proto).forEach(name => {
      if (typeof proto[name] === 'function') {
        methods.add(name);
      }
    });
    proto = Object.getPrototypeOf(proto);
  }
  
  return methods;
}

function truncateSQL(sql, maxLength = 1000) {
  if (!sql || typeof sql !== 'string') return sql;
  
  if (sql.length <= maxLength) return sql;
  
  return sql.substring(0, maxLength) + '...';
}

export default {
  instrument,
  instrumentFunction,
  instrumentHttp,
  instrumentExpress,
  instrumentDatabase,
  instrumentCache,
  createTracedClass
};