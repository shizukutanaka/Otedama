/**
 * Request Logger Middleware
 * Comprehensive logging for API requests with security and performance tracking
 * 
 * Design principles:
 * - Martin: Clean separation of logging concerns
 * - Pike: Simple but comprehensive logging
 * - Carmack: Minimal performance impact
 */

import { createStructuredLogger } from '../core/structured-logger.js';
import crypto from 'crypto';
import { performance } from 'perf_hooks';

const logger = createStructuredLogger('RequestLogger');

/**
 * Request logger configuration
 */
export const loggerConfig = {
  // What to log
  logBody: true,
  logHeaders: true,
  logQuery: true,
  logResponse: true,
  
  // Sensitive data masking
  sensitiveHeaders: [
    'authorization',
    'cookie',
    'x-api-key',
    'x-auth-token',
    'x-csrf-token'
  ],
  
  // Body fields to mask
  sensitiveFields: [
    'password',
    'secret',
    'token',
    'apiKey',
    'privateKey',
    'creditCard',
    'ssn'
  ],
  
  // Size limits
  maxBodySize: 10000, // 10KB
  maxResponseSize: 10000, // 10KB
  
  // Performance thresholds
  slowRequestThreshold: 1000, // 1 second
  
  // Sampling (log percentage of requests)
  samplingRate: 1.0 // Log 100% by default
};

/**
 * Generate request ID
 */
function generateRequestId() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Mask sensitive data
 */
function maskSensitive(obj, sensitiveFields) {
  if (!obj || typeof obj !== 'object') return obj;
  
  const masked = Array.isArray(obj) ? [...obj] : { ...obj };
  
  for (const [key, value] of Object.entries(masked)) {
    // Check if field name indicates sensitive data
    const isSensitive = sensitiveFields.some(field => 
      key.toLowerCase().includes(field.toLowerCase())
    );
    
    if (isSensitive) {
      masked[key] = '***REDACTED***';
    } else if (typeof value === 'object' && value !== null) {
      // Recursively mask nested objects
      masked[key] = maskSensitive(value, sensitiveFields);
    }
  }
  
  return masked;
}

/**
 * Extract relevant request data
 */
function extractRequestData(req, config) {
  const data = {
    method: req.method,
    url: req.url,
    path: req.path,
    ip: req.ip || req.connection.remoteAddress,
    userAgent: req.get('user-agent'),
    referer: req.get('referer'),
    protocol: req.protocol,
    httpVersion: req.httpVersion
  };
  
  // Add query parameters
  if (config.logQuery && req.query && Object.keys(req.query).length > 0) {
    data.query = maskSensitive(req.query, config.sensitiveFields);
  }
  
  // Add headers (with sensitive headers masked)
  if (config.logHeaders) {
    data.headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (config.sensitiveHeaders.includes(key.toLowerCase())) {
        data.headers[key] = '***REDACTED***';
      } else {
        data.headers[key] = value;
      }
    }
  }
  
  // Add body (with size limit and sensitive data masked)
  if (config.logBody && req.body) {
    const bodyStr = JSON.stringify(req.body);
    if (bodyStr.length <= config.maxBodySize) {
      data.body = maskSensitive(req.body, config.sensitiveFields);
    } else {
      data.body = `[Body too large: ${bodyStr.length} bytes]`;
    }
  }
  
  // Add user info if authenticated
  if (req.user) {
    data.user = {
      id: req.user.id,
      role: req.user.role
    };
  }
  
  return data;
}

/**
 * Request logger middleware
 */
export function requestLogger(config = {}) {
  const finalConfig = { ...loggerConfig, ...config };
  
  return (req, res, next) => {
    // Sampling check
    if (Math.random() > finalConfig.samplingRate) {
      return next();
    }
    
    // Generate request ID
    const requestId = generateRequestId();
    req.id = requestId;
    res.setHeader('X-Request-ID', requestId);
    
    // Start timing
    const startTime = performance.now();
    const startCpuUsage = process.cpuUsage();
    const startMemory = process.memoryUsage();
    
    // Extract request data
    const requestData = extractRequestData(req, finalConfig);
    
    // Log request
    logger.info('Request received', {
      requestId,
      ...requestData
    });
    
    // Capture response data
    const originalSend = res.send;
    const originalJson = res.json;
    let responseBody;
    
    res.send = function(body) {
      responseBody = body;
      return originalSend.call(this, body);
    };
    
    res.json = function(obj) {
      responseBody = obj;
      return originalJson.call(this, obj);
    };
    
    // Log response when finished
    res.on('finish', () => {
      const endTime = performance.now();
      const duration = endTime - startTime;
      const endCpuUsage = process.cpuUsage(startCpuUsage);
      const endMemory = process.memoryUsage();
      
      // Build response log data
      const responseData = {
        requestId,
        method: req.method,
        url: req.url,
        statusCode: res.statusCode,
        statusMessage: res.statusMessage,
        duration: Math.round(duration),
        cpuUsage: {
          user: endCpuUsage.user,
          system: endCpuUsage.system
        },
        memoryDelta: {
          rss: endMemory.rss - startMemory.rss,
          heapUsed: endMemory.heapUsed - startMemory.heapUsed
        }
      };
      
      // Add response body if configured
      if (finalConfig.logResponse && responseBody) {
        const bodyStr = typeof responseBody === 'string' 
          ? responseBody 
          : JSON.stringify(responseBody);
          
        if (bodyStr.length <= finalConfig.maxResponseSize) {
          responseData.responseBody = typeof responseBody === 'object'
            ? maskSensitive(responseBody, finalConfig.sensitiveFields)
            : responseBody;
        } else {
          responseData.responseBody = `[Response too large: ${bodyStr.length} bytes]`;
        }
      }
      
      // Check if slow request
      if (duration > finalConfig.slowRequestThreshold) {
        responseData.slow = true;
        logger.warn('Slow request detected', responseData);
      } else {
        logger.info('Request completed', responseData);
      }
      
      // Emit metrics event
      if (req.app && req.app.emit) {
        req.app.emit('request:completed', responseData);
      }
    });
    
    // Log errors
    res.on('error', (error) => {
      logger.error('Request error', {
        requestId,
        method: req.method,
        url: req.url,
        error: error.message,
        stack: error.stack
      });
    });
    
    next();
  };
}

/**
 * Error logger middleware
 */
export function errorLogger(config = {}) {
  return (err, req, res, next) => {
    const requestId = req.id || generateRequestId();
    
    // Log error details
    logger.error('Request error', {
      requestId,
      method: req.method,
      url: req.url,
      error: {
        name: err.name,
        message: err.message,
        stack: err.stack,
        code: err.code,
        statusCode: err.statusCode || err.status
      },
      user: req.user ? { id: req.user.id } : undefined
    });
    
    // Pass to next error handler
    next(err);
  };
}

/**
 * Security event logger
 */
export function securityLogger() {
  return (req, res, next) => {
    // Log potential security events
    const securityEvents = [];
    
    // Check for SQL injection attempts
    const sqlPattern = /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION)\b)/i;
    if (sqlPattern.test(req.url) || sqlPattern.test(JSON.stringify(req.body || {}))) {
      securityEvents.push({
        type: 'SQL_INJECTION_ATTEMPT',
        url: req.url,
        ip: req.ip
      });
    }
    
    // Check for XSS attempts
    const xssPattern = /<script|javascript:|onerror=/i;
    if (xssPattern.test(req.url) || xssPattern.test(JSON.stringify(req.body || {}))) {
      securityEvents.push({
        type: 'XSS_ATTEMPT',
        url: req.url,
        ip: req.ip
      });
    }
    
    // Check for path traversal
    if (req.url.includes('../')) {
      securityEvents.push({
        type: 'PATH_TRAVERSAL_ATTEMPT',
        url: req.url,
        ip: req.ip
      });
    }
    
    // Log security events
    securityEvents.forEach(event => {
      logger.warn('Security event detected', {
        ...event,
        requestId: req.id,
        userAgent: req.get('user-agent'),
        timestamp: new Date().toISOString()
      });
    });
    
    next();
  };
}

/**
 * Performance metrics aggregator
 */
export class RequestMetricsAggregator {
  constructor() {
    this.metrics = {
      totalRequests: 0,
      statusCodes: {},
      methods: {},
      paths: {},
      slowRequests: 0,
      errors: 0,
      avgDuration: 0,
      durations: []
    };
    
    this.interval = null;
  }
  
  /**
   * Start collecting metrics
   */
  start(app, intervalMs = 60000) {
    // Listen for request completed events
    app.on('request:completed', (data) => {
      this.updateMetrics(data);
    });
    
    // Periodically log aggregated metrics
    this.interval = setInterval(() => {
      this.logMetrics();
      this.resetMetrics();
    }, intervalMs);
  }
  
  /**
   * Update metrics with request data
   */
  updateMetrics(data) {
    this.metrics.totalRequests++;
    
    // Status codes
    this.metrics.statusCodes[data.statusCode] = 
      (this.metrics.statusCodes[data.statusCode] || 0) + 1;
    
    // Methods
    this.metrics.methods[data.method] = 
      (this.metrics.methods[data.method] || 0) + 1;
    
    // Paths (aggregate by base path)
    const basePath = data.url.split('?')[0].split('/').slice(0, 3).join('/');
    this.metrics.paths[basePath] = 
      (this.metrics.paths[basePath] || 0) + 1;
    
    // Duration tracking
    this.metrics.durations.push(data.duration);
    
    // Slow requests
    if (data.slow) {
      this.metrics.slowRequests++;
    }
    
    // Errors
    if (data.statusCode >= 400) {
      this.metrics.errors++;
    }
  }
  
  /**
   * Log aggregated metrics
   */
  logMetrics() {
    if (this.metrics.totalRequests === 0) return;
    
    // Calculate averages
    const avgDuration = this.metrics.durations.reduce((a, b) => a + b, 0) / 
      this.metrics.durations.length;
    
    const p95Duration = this.calculatePercentile(this.metrics.durations, 0.95);
    const p99Duration = this.calculatePercentile(this.metrics.durations, 0.99);
    
    logger.info('Request metrics summary', {
      totalRequests: this.metrics.totalRequests,
      avgDuration: Math.round(avgDuration),
      p95Duration: Math.round(p95Duration),
      p99Duration: Math.round(p99Duration),
      slowRequests: this.metrics.slowRequests,
      errorRate: (this.metrics.errors / this.metrics.totalRequests).toFixed(3),
      statusCodes: this.metrics.statusCodes,
      methods: this.metrics.methods,
      topPaths: this.getTopPaths(5)
    });
  }
  
  /**
   * Calculate percentile
   */
  calculatePercentile(arr, percentile) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.ceil(sorted.length * percentile) - 1;
    return sorted[index];
  }
  
  /**
   * Get top paths by request count
   */
  getTopPaths(count) {
    return Object.entries(this.metrics.paths)
      .sort(([, a], [, b]) => b - a)
      .slice(0, count)
      .map(([path, requests]) => ({ path, requests }));
  }
  
  /**
   * Reset metrics
   */
  resetMetrics() {
    this.metrics = {
      totalRequests: 0,
      statusCodes: {},
      methods: {},
      paths: {},
      slowRequests: 0,
      errors: 0,
      avgDuration: 0,
      durations: []
    };
  }
  
  /**
   * Stop collecting metrics
   */
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

export default {
  requestLogger,
  errorLogger,
  securityLogger,
  RequestMetricsAggregator
};