/**
 * API Gateway for Otedama
 * Centralized API management with rate limiting
 * 
 * Design principles:
 * - Carmack: High-performance request routing
 * - Martin: Clean gateway architecture
 * - Pike: Simple gateway configuration
 */

import { EventEmitter } from 'events';
import { createServer } from 'http';
import httpProxy from 'http-proxy';
import { URL } from 'url';
import { getLogger } from '../core/logger.js';
import { RateLimiter } from './rate-limiter.js';
import { CircuitBreaker } from '../core/circuit-breaker.js';
import { TraceContext } from '../tracing/tracer.js';

const logger = getLogger('ApiGateway');

/**
 * Route types
 */
export const RouteType = {
  PROXY: 'proxy',
  REDIRECT: 'redirect',
  REWRITE: 'rewrite',
  MOCK: 'mock',
  AGGREGATE: 'aggregate'
};

/**
 * Authentication types
 */
export const AuthType = {
  NONE: 'none',
  API_KEY: 'api_key',
  JWT: 'jwt',
  OAUTH2: 'oauth2',
  BASIC: 'basic',
  CUSTOM: 'custom'
};

/**
 * Load balancing algorithms
 */
export const LoadBalancingAlgorithm = {
  ROUND_ROBIN: 'round_robin',
  LEAST_CONNECTIONS: 'least_connections',
  WEIGHTED: 'weighted',
  IP_HASH: 'ip_hash',
  RANDOM: 'random'
};

/**
 * API route configuration
 */
export class ApiRoute {
  constructor(config) {
    this.id = config.id;
    this.path = config.path;
    this.method = config.method || '*';
    this.type = config.type || RouteType.PROXY;
    this.upstream = config.upstream;
    this.auth = config.auth || { type: AuthType.NONE };
    this.rateLimit = config.rateLimit;
    this.timeout = config.timeout || 30000;
    this.retries = config.retries || 3;
    this.circuitBreaker = config.circuitBreaker || {
      enabled: true,
      failureThreshold: 5,
      resetTimeout: 60000
    };
    this.transforms = config.transforms || [];
    this.cache = config.cache || { enabled: false };
    this.cors = config.cors || { enabled: true };
    this.validation = config.validation || { enabled: false };
  }
  
  matches(req) {
    // Check method
    if (this.method !== '*' && this.method !== req.method) {
      return false;
    }
    
    // Check path
    const pathRegex = this._pathToRegex(this.path);
    return pathRegex.test(req.url);
  }
  
  _pathToRegex(path) {
    // Convert path pattern to regex
    const pattern = path
      .replace(/\*/g, '.*')
      .replace(/:(\w+)/g, '(?<$1>[^/]+)')
      .replace(/\{(\w+)\}/g, '(?<$1>[^/]+)');
    
    return new RegExp(`^${pattern}$`);
  }
  
  extractParams(url) {
    const pathRegex = this._pathToRegex(this.path);
    const match = url.match(pathRegex);
    return match?.groups || {};
  }
}

/**
 * Upstream service
 */
export class UpstreamService {
  constructor(config) {
    this.id = config.id;
    this.url = config.url;
    this.weight = config.weight || 1;
    this.maxConnections = config.maxConnections || 100;
    this.healthCheck = config.healthCheck || {
      enabled: true,
      path: '/health',
      interval: 30000
    };
    
    this.healthy = true;
    this.connections = 0;
    this.metrics = {
      requests: 0,
      errors: 0,
      latency: []
    };
  }
  
  updateLatency(value) {
    this.metrics.latency.push(value);
    if (this.metrics.latency.length > 100) {
      this.metrics.latency.shift();
    }
  }
  
  getAverageLatency() {
    if (this.metrics.latency.length === 0) return 0;
    return this.metrics.latency.reduce((a, b) => a + b, 0) / this.metrics.latency.length;
  }
}

/**
 * API Gateway
 */
export class ApiGateway extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      port: options.port || 8080,
      host: options.host || '0.0.0.0',
      
      // Security
      trustProxy: options.trustProxy !== false,
      
      // Rate limiting
      globalRateLimit: options.globalRateLimit || {
        windowMs: 60000,
        max: 1000
      },
      
      // Load balancing
      loadBalancingAlgorithm: options.loadBalancingAlgorithm || LoadBalancingAlgorithm.ROUND_ROBIN,
      
      // Timeouts
      requestTimeout: options.requestTimeout || 30000,
      keepAliveTimeout: options.keepAliveTimeout || 5000,
      
      // Monitoring
      enableMetrics: options.enableMetrics !== false,
      enableTracing: options.enableTracing !== false,
      
      // Error handling
      errorHandler: options.errorHandler,
      
      ...options
    };
    
    // State
    this.routes = new Map();
    this.upstreams = new Map();
    this.circuitBreakers = new Map();
    this.rateLimiters = new Map();
    
    // Proxy
    this.proxy = httpProxy.createProxyServer({
      changeOrigin: true,
      ws: true,
      xfwd: true
    });
    
    // Server
    this.server = null;
    
    // Middleware pipeline
    this.middleware = [];
    
    // Metrics
    this.metrics = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      activeConnections: 0,
      routeMetrics: new Map()
    };
  }
  
  /**
   * Start API Gateway
   */
  async start() {
    logger.info('Starting API Gateway');
    
    // Create server
    this.server = createServer((req, res) => {
      this._handleRequest(req, res);
    });
    
    // Handle proxy errors
    this.proxy.on('error', (err, req, res) => {
      this._handleProxyError(err, req, res);
    });
    
    // Handle WebSocket upgrades
    this.server.on('upgrade', (req, socket, head) => {
      this._handleWebSocketUpgrade(req, socket, head);
    });
    
    // Start health checks
    this._startHealthChecks();
    
    // Listen
    await new Promise((resolve) => {
      this.server.listen(this.options.port, this.options.host, () => {
        logger.info(`API Gateway listening on ${this.options.host}:${this.options.port}`);
        resolve();
      });
    });
    
    this.emit('started');
  }
  
  /**
   * Stop API Gateway
   */
  async stop() {
    logger.info('Stopping API Gateway');
    
    if (this.server) {
      await new Promise((resolve) => {
        this.server.close(resolve);
      });
    }
    
    this.emit('stopped');
  }
  
  /**
   * Add route
   */
  addRoute(config) {
    const route = new ApiRoute(config);
    this.routes.set(route.id, route);
    
    // Create rate limiter for route
    if (route.rateLimit) {
      this.rateLimiters.set(route.id, new RateLimiter(route.rateLimit));
    }
    
    // Add upstreams
    if (route.upstream) {
      for (const upstream of route.upstream) {
        this.addUpstream(upstream);
      }
    }
    
    logger.info(`Added route: ${route.method} ${route.path}`);
    
    this.emit('route:added', route);
  }
  
  /**
   * Remove route
   */
  removeRoute(routeId) {
    const route = this.routes.get(routeId);
    if (!route) return;
    
    this.routes.delete(routeId);
    this.rateLimiters.delete(routeId);
    
    logger.info(`Removed route: ${route.method} ${route.path}`);
    
    this.emit('route:removed', route);
  }
  
  /**
   * Add upstream
   */
  addUpstream(config) {
    const upstream = new UpstreamService(config);
    this.upstreams.set(upstream.id, upstream);
    
    // Create circuit breaker
    this.circuitBreakers.set(upstream.id, new CircuitBreaker({
      name: upstream.id,
      failureThreshold: 5,
      resetTimeout: 60000
    }));
    
    logger.info(`Added upstream: ${upstream.id} (${upstream.url})`);
  }
  
  /**
   * Use middleware
   */
  use(middleware) {
    this.middleware.push(middleware);
  }
  
  /**
   * Handle request
   */
  async _handleRequest(req, res) {
    const startTime = Date.now();
    this.metrics.totalRequests++;
    this.metrics.activeConnections++;
    
    // Add request ID
    req.id = this._generateRequestId();
    
    // Add tracing
    if (this.options.enableTracing) {
      req.traceContext = TraceContext.extract(req.headers);
    }
    
    res.on('finish', () => {
      this.metrics.activeConnections--;
      const duration = Date.now() - startTime;
      
      // Emit metrics
      this.emit('request:completed', {
        id: req.id,
        method: req.method,
        path: req.url,
        status: res.statusCode,
        duration
      });
    });
    
    try {
      // Run middleware pipeline
      await this._runMiddleware(req, res);
      
      // If response not sent, continue with routing
      if (!res.headersSent) {
        await this._routeRequest(req, res);
      }
      
    } catch (error) {
      this._handleError(error, req, res);
    }
  }
  
  /**
   * Run middleware pipeline
   */
  async _runMiddleware(req, res) {
    for (const middleware of this.middleware) {
      await new Promise((resolve, reject) => {
        middleware(req, res, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      
      if (res.headersSent) break;
    }
  }
  
  /**
   * Route request
   */
  async _routeRequest(req, res) {
    // Find matching route
    const route = this._findRoute(req);
    
    if (!route) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    
    // Check authentication
    if (!await this._authenticate(req, route)) {
      res.writeHead(401);
      res.end('Unauthorized');
      return;
    }
    
    // Check rate limit
    if (!await this._checkRateLimit(req, route)) {
      res.writeHead(429);
      res.end('Too Many Requests');
      return;
    }
    
    // Apply transforms
    await this._applyTransforms(req, res, route);
    
    // Handle request based on route type
    switch (route.type) {
      case RouteType.PROXY:
        await this._proxyRequest(req, res, route);
        break;
        
      case RouteType.REDIRECT:
        this._redirectRequest(req, res, route);
        break;
        
      case RouteType.REWRITE:
        await this._rewriteRequest(req, res, route);
        break;
        
      case RouteType.MOCK:
        this._mockRequest(req, res, route);
        break;
        
      case RouteType.AGGREGATE:
        await this._aggregateRequest(req, res, route);
        break;
    }
    
    // Update metrics
    this.metrics.successfulRequests++;
    this._updateRouteMetrics(route, true);
  }
  
  /**
   * Find matching route
   */
  _findRoute(req) {
    for (const route of this.routes.values()) {
      if (route.matches(req)) {
        return route;
      }
    }
    return null;
  }
  
  /**
   * Authenticate request
   */
  async _authenticate(req, route) {
    const auth = route.auth;
    
    switch (auth.type) {
      case AuthType.NONE:
        return true;
        
      case AuthType.API_KEY:
        return this._authenticateApiKey(req, auth);
        
      case AuthType.JWT:
        return this._authenticateJWT(req, auth);
        
      case AuthType.OAUTH2:
        return this._authenticateOAuth2(req, auth);
        
      case AuthType.BASIC:
        return this._authenticateBasic(req, auth);
        
      case AuthType.CUSTOM:
        return auth.handler(req);
        
      default:
        return false;
    }
  }
  
  /**
   * Check rate limit
   */
  async _checkRateLimit(req, route) {
    // Global rate limit
    const globalLimiter = this._getGlobalRateLimiter();
    if (!await globalLimiter.check(this._getClientId(req))) {
      return false;
    }
    
    // Route-specific rate limit
    const routeLimiter = this.rateLimiters.get(route.id);
    if (routeLimiter && !await routeLimiter.check(this._getClientId(req))) {
      return false;
    }
    
    return true;
  }
  
  /**
   * Proxy request
   */
  async _proxyRequest(req, res, route) {
    const upstream = this._selectUpstream(route);
    
    if (!upstream) {
      res.writeHead(503);
      res.end('Service Unavailable');
      return;
    }
    
    const circuitBreaker = this.circuitBreakers.get(upstream.id);
    
    try {
      await circuitBreaker.execute(async () => {
        const startTime = Date.now();
        upstream.connections++;
        
        // Set timeout
        const timeout = setTimeout(() => {
          req.destroy();
          res.writeHead(504);
          res.end('Gateway Timeout');
        }, route.timeout);
        
        // Add headers
        this._addProxyHeaders(req, route);
        
        // Proxy request
        this.proxy.web(req, res, {
          target: upstream.url,
          timeout: route.timeout
        }, (error) => {
          clearTimeout(timeout);
          upstream.connections--;
          
          if (error) {
            throw error;
          }
          
          // Update metrics
          const duration = Date.now() - startTime;
          upstream.updateLatency(duration);
          upstream.metrics.requests++;
        });
      });
      
    } catch (error) {
      upstream.metrics.errors++;
      
      if (route.retries > 0) {
        // Retry with different upstream
        route.retries--;
        await this._proxyRequest(req, res, route);
      } else {
        throw error;
      }
    }
  }
  
  /**
   * Select upstream
   */
  _selectUpstream(route) {
    const upstreamIds = route.upstream;
    if (!upstreamIds || upstreamIds.length === 0) return null;
    
    const availableUpstreams = upstreamIds
      .map(id => this.upstreams.get(id))
      .filter(upstream => upstream && upstream.healthy);
    
    if (availableUpstreams.length === 0) return null;
    
    switch (this.options.loadBalancingAlgorithm) {
      case LoadBalancingAlgorithm.ROUND_ROBIN:
        return this._roundRobinSelect(availableUpstreams);
        
      case LoadBalancingAlgorithm.LEAST_CONNECTIONS:
        return this._leastConnectionsSelect(availableUpstreams);
        
      case LoadBalancingAlgorithm.WEIGHTED:
        return this._weightedSelect(availableUpstreams);
        
      case LoadBalancingAlgorithm.IP_HASH:
        return this._ipHashSelect(availableUpstreams, req);
        
      case LoadBalancingAlgorithm.RANDOM:
        return availableUpstreams[Math.floor(Math.random() * availableUpstreams.length)];
        
      default:
        return availableUpstreams[0];
    }
  }
  
  /**
   * Redirect request
   */
  _redirectRequest(req, res, route) {
    const location = route.redirect || route.upstream[0];
    res.writeHead(route.redirectCode || 302, { Location: location });
    res.end();
  }
  
  /**
   * Rewrite request
   */
  async _rewriteRequest(req, res, route) {
    // Apply URL rewrite rules
    const originalUrl = req.url;
    req.url = route.rewrite(req.url, route.extractParams(req.url));
    
    logger.debug(`Rewrite: ${originalUrl} -> ${req.url}`);
    
    // Continue with proxy
    await this._proxyRequest(req, res, route);
  }
  
  /**
   * Mock request
   */
  _mockRequest(req, res, route) {
    const mockResponse = route.mockResponse || {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: { message: 'Mock response' }
    };
    
    res.writeHead(mockResponse.status, mockResponse.headers);
    res.end(JSON.stringify(mockResponse.body));
  }
  
  /**
   * Aggregate request
   */
  async _aggregateRequest(req, res, route) {
    const requests = route.aggregate || [];
    const results = await Promise.all(
      requests.map(request => this._makeSubRequest(request, req))
    );
    
    const aggregatedResponse = route.aggregator ?
      route.aggregator(results) :
      { results };
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(aggregatedResponse));
  }
  
  /**
   * Apply transforms
   */
  async _applyTransforms(req, res, route) {
    for (const transform of route.transforms) {
      await transform(req, res);
    }
  }
  
  /**
   * Add proxy headers
   */
  _addProxyHeaders(req, route) {
    // Add X-Forwarded headers
    const clientIp = this._getClientIp(req);
    req.headers['x-forwarded-for'] = clientIp;
    req.headers['x-forwarded-proto'] = req.connection.encrypted ? 'https' : 'http';
    req.headers['x-forwarded-host'] = req.headers.host;
    
    // Add request ID
    req.headers['x-request-id'] = req.id;
    
    // Add tracing headers
    if (req.traceContext) {
      TraceContext.inject(req.headers, req.traceContext);
    }
    
    // Remove hop-by-hop headers
    delete req.headers['connection'];
    delete req.headers['keep-alive'];
    delete req.headers['proxy-authenticate'];
    delete req.headers['proxy-authorization'];
    delete req.headers['te'];
    delete req.headers['trailer'];
    delete req.headers['transfer-encoding'];
    delete req.headers['upgrade'];
  }
  
  /**
   * Handle WebSocket upgrade
   */
  _handleWebSocketUpgrade(req, socket, head) {
    const route = this._findRoute(req);
    if (!route) {
      socket.end();
      return;
    }
    
    const upstream = this._selectUpstream(route);
    if (!upstream) {
      socket.end();
      return;
    }
    
    this.proxy.ws(req, socket, head, {
      target: upstream.url
    });
  }
  
  /**
   * Handle proxy error
   */
  _handleProxyError(err, req, res) {
    logger.error('Proxy error:', err);
    
    if (!res.headersSent) {
      res.writeHead(502);
      res.end('Bad Gateway');
    }
    
    this.metrics.failedRequests++;
  }
  
  /**
   * Handle error
   */
  _handleError(error, req, res) {
    logger.error('Request error:', error);
    
    if (this.options.errorHandler) {
      this.options.errorHandler(error, req, res);
    } else {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    }
    
    this.metrics.failedRequests++;
  }
  
  /**
   * Authentication methods
   */
  _authenticateApiKey(req, auth) {
    const apiKey = req.headers[auth.header || 'x-api-key'];
    return auth.validator ? auth.validator(apiKey) : apiKey === auth.key;
  }
  
  _authenticateJWT(req, auth) {
    const token = this._extractBearerToken(req);
    return auth.validator ? auth.validator(token) : false;
  }
  
  _authenticateOAuth2(req, auth) {
    const token = this._extractBearerToken(req);
    return auth.validator ? auth.validator(token) : false;
  }
  
  _authenticateBasic(req, auth) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      return false;
    }
    
    const credentials = Buffer.from(authHeader.slice(6), 'base64').toString();
    return auth.validator ? auth.validator(credentials) : false;
  }
  
  _extractBearerToken(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return null;
    }
    return authHeader.slice(7);
  }
  
  /**
   * Load balancing algorithms
   */
  _roundRobinSelect(upstreams) {
    const key = upstreams.map(u => u.id).join(':');
    const index = (this._roundRobinCounters?.get(key) || 0) % upstreams.length;
    
    if (!this._roundRobinCounters) {
      this._roundRobinCounters = new Map();
    }
    this._roundRobinCounters.set(key, index + 1);
    
    return upstreams[index];
  }
  
  _leastConnectionsSelect(upstreams) {
    return upstreams.reduce((selected, upstream) =>
      upstream.connections < selected.connections ? upstream : selected
    );
  }
  
  _weightedSelect(upstreams) {
    const totalWeight = upstreams.reduce((sum, u) => sum + u.weight, 0);
    let random = Math.random() * totalWeight;
    
    for (const upstream of upstreams) {
      random -= upstream.weight;
      if (random <= 0) return upstream;
    }
    
    return upstreams[upstreams.length - 1];
  }
  
  _ipHashSelect(upstreams, req) {
    const ip = this._getClientIp(req);
    const hash = ip.split('.').reduce((h, octet) => h * 256 + parseInt(octet), 0);
    return upstreams[hash % upstreams.length];
  }
  
  /**
   * Health checks
   */
  _startHealthChecks() {
    setInterval(() => {
      for (const upstream of this.upstreams.values()) {
        if (upstream.healthCheck.enabled) {
          this._checkUpstreamHealth(upstream);
        }
      }
    }, 30000);
  }
  
  async _checkUpstreamHealth(upstream) {
    try {
      const url = new URL(upstream.healthCheck.path, upstream.url);
      const response = await fetch(url, { 
        method: 'GET',
        timeout: 5000
      });
      
      upstream.healthy = response.ok;
      
    } catch (error) {
      upstream.healthy = false;
      logger.warn(`Upstream ${upstream.id} health check failed:`, error.message);
    }
  }
  
  /**
   * Utilities
   */
  _generateRequestId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
  
  _getClientIp(req) {
    if (this.options.trustProxy && req.headers['x-forwarded-for']) {
      return req.headers['x-forwarded-for'].split(',')[0].trim();
    }
    return req.connection.remoteAddress;
  }
  
  _getClientId(req) {
    // Use API key if available, otherwise IP
    const apiKey = req.headers['x-api-key'];
    return apiKey || this._getClientIp(req);
  }
  
  _getGlobalRateLimiter() {
    if (!this._globalRateLimiter) {
      this._globalRateLimiter = new RateLimiter(this.options.globalRateLimit);
    }
    return this._globalRateLimiter;
  }
  
  _updateRouteMetrics(route, success) {
    if (!this.metrics.routeMetrics.has(route.id)) {
      this.metrics.routeMetrics.set(route.id, {
        requests: 0,
        successes: 0,
        failures: 0
      });
    }
    
    const metrics = this.metrics.routeMetrics.get(route.id);
    metrics.requests++;
    
    if (success) {
      metrics.successes++;
    } else {
      metrics.failures++;
    }
  }
  
  /**
   * Make sub-request for aggregation
   */
  async _makeSubRequest(request, originalReq) {
    // Implementation would make actual HTTP request
    // For demo, return mock data
    return {
      status: 200,
      data: { message: 'Sub-request response' }
    };
  }
  
  /**
   * Get gateway status
   */
  getStatus() {
    const upstreamStatus = {};
    
    for (const [id, upstream] of this.upstreams) {
      upstreamStatus[id] = {
        url: upstream.url,
        healthy: upstream.healthy,
        connections: upstream.connections,
        averageLatency: upstream.getAverageLatency(),
        metrics: upstream.metrics
      };
    }
    
    return {
      routes: this.routes.size,
      upstreams: upstreamStatus,
      metrics: {
        ...this.metrics,
        routeMetrics: Object.fromEntries(this.metrics.routeMetrics)
      }
    };
  }
}

export default ApiGateway;