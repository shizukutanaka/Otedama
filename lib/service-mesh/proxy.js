/**
 * Service Mesh Proxy for Otedama
 * Sidecar proxy with Istio-like features
 * 
 * Design principles:
 * - Carmack: Low-latency service communication
 * - Martin: Clean proxy architecture
 * - Pike: Simple service mesh
 */

import { EventEmitter } from 'events';
import { createServer, request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { URL } from 'url';
import { promisify } from 'util';
import { getLogger } from '../core/logger.js';
import { CircuitBreaker } from '../core/circuit-breaker.js';
import { TraceContext } from '../tracing/tracer.js';

const logger = getLogger('Proxy');

/**
 * Proxy modes
 */
export const ProxyMode = {
  TRANSPARENT: 'transparent',  // Transparent proxy
  EXPLICIT: 'explicit',        // Explicit proxy
  REVERSE: 'reverse'          // Reverse proxy
};

/**
 * Load balancing algorithms
 */
export const LoadBalancer = {
  ROUND_ROBIN: 'round_robin',
  LEAST_CONN: 'least_conn',
  RANDOM: 'random',
  WEIGHTED: 'weighted',
  IP_HASH: 'ip_hash'
};

/**
 * Service mesh sidecar proxy
 */
export class ServiceMeshProxy extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      port: options.port || 15001,
      adminPort: options.adminPort || 15000,
      mode: options.mode || ProxyMode.TRANSPARENT,
      
      // Service discovery
      serviceRegistry: options.serviceRegistry,
      healthCheckInterval: options.healthCheckInterval || 10000,
      
      // Load balancing
      loadBalancer: options.loadBalancer || LoadBalancer.ROUND_ROBIN,
      
      // Circuit breaking
      circuitBreaker: {
        failureThreshold: options.circuitBreaker?.failureThreshold || 5,
        resetTimeout: options.circuitBreaker?.resetTimeout || 60000,
        ...options.circuitBreaker
      },
      
      // Retry policy
      retry: {
        maxAttempts: options.retry?.maxAttempts || 3,
        backoff: options.retry?.backoff || 'exponential',
        baseDelay: options.retry?.baseDelay || 100,
        maxDelay: options.retry?.maxDelay || 10000,
        ...options.retry
      },
      
      // Timeout
      timeout: options.timeout || 30000,
      
      // Rate limiting
      rateLimit: {
        enabled: options.rateLimit?.enabled !== false,
        windowMs: options.rateLimit?.windowMs || 60000,
        maxRequests: options.rateLimit?.maxRequests || 1000,
        ...options.rateLimit
      },
      
      // Security
      mtls: {
        enabled: options.mtls?.enabled || false,
        cert: options.mtls?.cert,
        key: options.mtls?.key,
        ca: options.mtls?.ca,
        ...options.mtls
      },
      
      // Observability
      metrics: options.metrics !== false,
      tracing: options.tracing !== false,
      logging: options.logging !== false,
      
      ...options
    };
    
    // Service state
    this.services = new Map();
    this.endpoints = new Map();
    this.circuitBreakers = new Map();
    this.connectionPools = new Map();
    
    // Rate limiting
    this.rateLimitWindows = new Map();
    
    // Metrics
    this.metrics = {
      requests: 0,
      successes: 0,
      failures: 0,
      retries: 0,
      circuitBreaks: 0,
      rateLimits: 0,
      latencies: []
    };
    
    // Proxy server
    this.proxyServer = null;
    this.adminServer = null;
  }
  
  /**
   * Start proxy
   */
  async start() {
    // Start service discovery
    if (this.options.serviceRegistry) {
      await this._startServiceDiscovery();
    }
    
    // Create proxy server
    this.proxyServer = createServer((req, res) => {
      this._handleProxyRequest(req, res);
    });
    
    // Create admin server
    this.adminServer = createServer((req, res) => {
      this._handleAdminRequest(req, res);
    });
    
    // Start servers
    await Promise.all([
      new Promise(resolve => {
        this.proxyServer.listen(this.options.port, () => {
          logger.info(`Service mesh proxy listening on port ${this.options.port}`);
          resolve();
        });
      }),
      new Promise(resolve => {
        this.adminServer.listen(this.options.adminPort, () => {
          logger.info(`Admin interface listening on port ${this.options.adminPort}`);
          resolve();
        });
      })
    ]);
    
    this.emit('started');
  }
  
  /**
   * Stop proxy
   */
  async stop() {
    // Stop servers
    if (this.proxyServer) {
      await new Promise(resolve => this.proxyServer.close(resolve));
    }
    
    if (this.adminServer) {
      await new Promise(resolve => this.adminServer.close(resolve));
    }
    
    // Clear intervals
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    
    this.emit('stopped');
  }
  
  /**
   * Handle proxy request
   */
  async _handleProxyRequest(req, res) {
    const startTime = Date.now();
    this.metrics.requests++;
    
    try {
      // Extract service name from request
      const serviceName = this._extractServiceName(req);
      if (!serviceName) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request: Service not specified');
        return;
      }
      
      // Check rate limit
      if (this.options.rateLimit.enabled && !this._checkRateLimit(req)) {
        this.metrics.rateLimits++;
        res.writeHead(429, { 'Content-Type': 'text/plain' });
        res.end('Too Many Requests');
        return;
      }
      
      // Get service endpoints
      const endpoints = this._getHealthyEndpoints(serviceName);
      if (endpoints.length === 0) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('Service Unavailable');
        return;
      }
      
      // Select endpoint
      const endpoint = this._selectEndpoint(serviceName, endpoints, req);
      
      // Get circuit breaker
      const circuitBreaker = this._getCircuitBreaker(endpoint);
      
      // Execute request with circuit breaker
      await circuitBreaker.execute(async () => {
        await this._proxyRequest(req, res, endpoint);
      });
      
      this.metrics.successes++;
      
    } catch (error) {
      this.metrics.failures++;
      
      if (error.code === 'CIRCUIT_OPEN') {
        this.metrics.circuitBreaks++;
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('Service Unavailable (Circuit Open)');
      } else {
        logger.error('Proxy request failed', error);
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Bad Gateway');
      }
    } finally {
      // Record latency
      const latency = Date.now() - startTime;
      this.metrics.latencies.push(latency);
      
      // Emit metrics
      this.emit('request', {
        service: this._extractServiceName(req),
        method: req.method,
        path: req.url,
        status: res.statusCode,
        latency
      });
    }
  }
  
  /**
   * Proxy request to endpoint
   */
  async _proxyRequest(req, res, endpoint, attempt = 1) {
    const { host, port, protocol = 'http' } = endpoint;
    
    // Prepare headers
    const headers = { ...req.headers };
    
    // Add tracing headers
    if (this.options.tracing) {
      const traceContext = TraceContext.extract(req.headers);
      TraceContext.inject(headers, traceContext);
    }
    
    // Add service mesh headers
    headers['x-forwarded-for'] = req.connection.remoteAddress;
    headers['x-forwarded-host'] = req.headers.host;
    headers['x-forwarded-proto'] = protocol;
    headers['x-mesh-attempt'] = attempt;
    
    // Create proxy request
    const proxyReq = (protocol === 'https' ? httpsRequest : httpRequest)({
      hostname: host,
      port,
      path: req.url,
      method: req.method,
      headers,
      timeout: this.options.timeout,
      // mTLS options
      ...(this.options.mtls.enabled && {
        cert: this.options.mtls.cert,
        key: this.options.mtls.key,
        ca: this.options.mtls.ca,
        rejectUnauthorized: true
      })
    });
    
    // Handle response
    proxyReq.on('response', (proxyRes) => {
      // Copy status and headers
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      
      // Pipe response
      proxyRes.pipe(res);
      
      // Handle errors during streaming
      proxyRes.on('error', (error) => {
        logger.error('Proxy response error', error);
        res.end();
      });
    });
    
    // Handle errors
    proxyReq.on('error', async (error) => {
      logger.error('Proxy request error', error);
      
      // Retry logic
      if (attempt < this.options.retry.maxAttempts) {
        this.metrics.retries++;
        
        // Calculate backoff
        const delay = this._calculateBackoff(attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
        
        // Retry with different endpoint if available
        const endpoints = this._getHealthyEndpoints(endpoint.service);
        const nextEndpoint = this._selectEndpoint(endpoint.service, endpoints, req);
        
        return this._proxyRequest(req, res, nextEndpoint, attempt + 1);
      }
      
      // Max retries reached
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway');
    });
    
    // Handle timeout
    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      res.writeHead(504, { 'Content-Type': 'text/plain' });
      res.end('Gateway Timeout');
    });
    
    // Pipe request body
    req.pipe(proxyReq);
  }
  
  /**
   * Handle admin request
   */
  _handleAdminRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    res.setHeader('Content-Type', 'application/json');
    
    switch (url.pathname) {
      case '/health':
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'healthy' }));
        break;
        
      case '/metrics':
        res.writeHead(200);
        res.end(JSON.stringify(this._getMetrics()));
        break;
        
      case '/config':
        res.writeHead(200);
        res.end(JSON.stringify(this._getConfig()));
        break;
        
      case '/services':
        res.writeHead(200);
        res.end(JSON.stringify(this._getServices()));
        break;
        
      case '/endpoints':
        res.writeHead(200);
        res.end(JSON.stringify(this._getEndpoints()));
        break;
        
      default:
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not Found' }));
    }
  }
  
  /**
   * Start service discovery
   */
  async _startServiceDiscovery() {
    // Initial discovery
    await this._discoverServices();
    
    // Periodic discovery
    this.healthCheckInterval = setInterval(async () => {
      await this._discoverServices();
      await this._healthCheckEndpoints();
    }, this.options.healthCheckInterval);
  }
  
  /**
   * Discover services
   */
  async _discoverServices() {
    try {
      const services = await this.options.serviceRegistry.listServices();
      
      for (const service of services) {
        this.services.set(service.name, service);
        
        // Discover endpoints
        const endpoints = await this.options.serviceRegistry.getEndpoints(service.name);
        this.endpoints.set(service.name, endpoints.map(ep => ({
          ...ep,
          service: service.name,
          healthy: true,
          connections: 0
        })));
      }
      
      this.emit('services:discovered', { count: services.length });
      
    } catch (error) {
      logger.error('Service discovery failed', error);
    }
  }
  
  /**
   * Health check endpoints
   */
  async _healthCheckEndpoints() {
    for (const [serviceName, endpoints] of this.endpoints) {
      for (const endpoint of endpoints) {
        try {
          const healthy = await this._checkEndpointHealth(endpoint);
          endpoint.healthy = healthy;
          
          if (!healthy && endpoint.healthy) {
            logger.warn(`Endpoint ${endpoint.host}:${endpoint.port} marked unhealthy`);
          } else if (healthy && !endpoint.healthy) {
            logger.info(`Endpoint ${endpoint.host}:${endpoint.port} marked healthy`);
          }
        } catch (error) {
          endpoint.healthy = false;
        }
      }
    }
  }
  
  /**
   * Check endpoint health
   */
  async _checkEndpointHealth(endpoint) {
    return new Promise((resolve) => {
      const req = httpRequest({
        hostname: endpoint.host,
        port: endpoint.port,
        path: endpoint.healthPath || '/health',
        method: 'GET',
        timeout: 5000
      });
      
      req.on('response', (res) => {
        resolve(res.statusCode >= 200 && res.statusCode < 300);
        res.resume(); // Consume response
      });
      
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      
      req.end();
    });
  }
  
  /**
   * Extract service name from request
   */
  _extractServiceName(req) {
    // From Host header (service.mesh.local)
    const host = req.headers.host;
    if (host && host.endsWith('.mesh.local')) {
      return host.replace('.mesh.local', '');
    }
    
    // From path (/service/...)
    const match = req.url.match(/^\/([^\/]+)/);
    if (match) {
      return match[1];
    }
    
    // From header
    return req.headers['x-service-name'];
  }
  
  /**
   * Get healthy endpoints
   */
  _getHealthyEndpoints(serviceName) {
    const endpoints = this.endpoints.get(serviceName) || [];
    return endpoints.filter(ep => ep.healthy);
  }
  
  /**
   * Select endpoint based on load balancing algorithm
   */
  _selectEndpoint(serviceName, endpoints, req) {
    if (endpoints.length === 0) return null;
    if (endpoints.length === 1) return endpoints[0];
    
    switch (this.options.loadBalancer) {
      case LoadBalancer.ROUND_ROBIN:
        return this._roundRobinSelect(serviceName, endpoints);
        
      case LoadBalancer.LEAST_CONN:
        return this._leastConnectionsSelect(endpoints);
        
      case LoadBalancer.RANDOM:
        return endpoints[Math.floor(Math.random() * endpoints.length)];
        
      case LoadBalancer.WEIGHTED:
        return this._weightedSelect(endpoints);
        
      case LoadBalancer.IP_HASH:
        return this._ipHashSelect(endpoints, req);
        
      default:
        return endpoints[0];
    }
  }
  
  /**
   * Round-robin selection
   */
  _roundRobinSelect(serviceName, endpoints) {
    const key = `rr:${serviceName}`;
    const index = (this[key] || 0) % endpoints.length;
    this[key] = index + 1;
    return endpoints[index];
  }
  
  /**
   * Least connections selection
   */
  _leastConnectionsSelect(endpoints) {
    return endpoints.reduce((selected, endpoint) => 
      endpoint.connections < selected.connections ? endpoint : selected
    );
  }
  
  /**
   * Weighted selection
   */
  _weightedSelect(endpoints) {
    const totalWeight = endpoints.reduce((sum, ep) => sum + (ep.weight || 1), 0);
    let random = Math.random() * totalWeight;
    
    for (const endpoint of endpoints) {
      random -= endpoint.weight || 1;
      if (random <= 0) return endpoint;
    }
    
    return endpoints[endpoints.length - 1];
  }
  
  /**
   * IP hash selection
   */
  _ipHashSelect(endpoints, req) {
    const ip = req.connection.remoteAddress;
    const hash = ip.split('.').reduce((h, octet) => h * 256 + parseInt(octet), 0);
    return endpoints[hash % endpoints.length];
  }
  
  /**
   * Get or create circuit breaker
   */
  _getCircuitBreaker(endpoint) {
    const key = `${endpoint.host}:${endpoint.port}`;
    
    if (!this.circuitBreakers.has(key)) {
      this.circuitBreakers.set(key, new CircuitBreaker({
        name: key,
        ...this.options.circuitBreaker
      }));
    }
    
    return this.circuitBreakers.get(key);
  }
  
  /**
   * Check rate limit
   */
  _checkRateLimit(req) {
    const key = req.connection.remoteAddress;
    const now = Date.now();
    const windowStart = Math.floor(now / this.options.rateLimit.windowMs) * this.options.rateLimit.windowMs;
    
    const windowKey = `${key}:${windowStart}`;
    const requests = this.rateLimitWindows.get(windowKey) || 0;
    
    if (requests >= this.options.rateLimit.maxRequests) {
      return false;
    }
    
    this.rateLimitWindows.set(windowKey, requests + 1);
    
    // Clean old windows
    for (const [k] of this.rateLimitWindows) {
      const [, timestamp] = k.split(':');
      if (parseInt(timestamp) < windowStart - this.options.rateLimit.windowMs) {
        this.rateLimitWindows.delete(k);
      }
    }
    
    return true;
  }
  
  /**
   * Calculate backoff delay
   */
  _calculateBackoff(attempt) {
    if (this.options.retry.backoff === 'exponential') {
      const delay = this.options.retry.baseDelay * Math.pow(2, attempt - 1);
      return Math.min(delay, this.options.retry.maxDelay);
    } else {
      return this.options.retry.baseDelay;
    }
  }
  
  /**
   * Get metrics
   */
  _getMetrics() {
    const latencies = this.metrics.latencies.slice(-1000); // Last 1000 requests
    const sortedLatencies = latencies.sort((a, b) => a - b);
    
    return {
      requests: this.metrics.requests,
      successes: this.metrics.successes,
      failures: this.metrics.failures,
      successRate: this.metrics.requests > 0 ? 
        (this.metrics.successes / this.metrics.requests * 100).toFixed(2) + '%' : '0%',
      retries: this.metrics.retries,
      circuitBreaks: this.metrics.circuitBreaks,
      rateLimits: this.metrics.rateLimits,
      latency: {
        p50: sortedLatencies[Math.floor(sortedLatencies.length * 0.5)] || 0,
        p95: sortedLatencies[Math.floor(sortedLatencies.length * 0.95)] || 0,
        p99: sortedLatencies[Math.floor(sortedLatencies.length * 0.99)] || 0,
        avg: latencies.length > 0 ? 
          latencies.reduce((a, b) => a + b, 0) / latencies.length : 0
      }
    };
  }
  
  /**
   * Get configuration
   */
  _getConfig() {
    return {
      mode: this.options.mode,
      loadBalancer: this.options.loadBalancer,
      circuitBreaker: this.options.circuitBreaker,
      retry: this.options.retry,
      rateLimit: this.options.rateLimit,
      mtls: {
        enabled: this.options.mtls.enabled
      }
    };
  }
  
  /**
   * Get services
   */
  _getServices() {
    return Array.from(this.services.values());
  }
  
  /**
   * Get endpoints
   */
  _getEndpoints() {
    const result = {};
    
    for (const [service, endpoints] of this.endpoints) {
      result[service] = endpoints.map(ep => ({
        host: ep.host,
        port: ep.port,
        healthy: ep.healthy,
        weight: ep.weight,
        connections: ep.connections
      }));
    }
    
    return result;
  }
}

export default ServiceMeshProxy;