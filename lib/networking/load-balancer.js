const EventEmitter = require('events');
const crypto = require('crypto');
const net = require('net');
const http = require('http');
const https = require('https');

class AdvancedLoadBalancingSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      algorithm: options.algorithm || 'weighted-least-connections',
      healthCheckInterval: options.healthCheckInterval || 5000,
      healthCheckTimeout: options.healthCheckTimeout || 3000,
      maxRetries: options.maxRetries || 3,
      stickySession: options.stickySession !== false,
      sessionTimeout: options.sessionTimeout || 3600000, // 1 hour
      geoRouting: options.geoRouting !== false,
      circuitBreaker: options.circuitBreaker !== false,
      circuitBreakerThreshold: options.circuitBreakerThreshold || 0.5,
      circuitBreakerTimeout: options.circuitBreakerTimeout || 60000,
      rateLimiting: options.rateLimiting !== false,
      rateLimit: options.rateLimit || 1000, // requests per minute
      adaptiveRouting: options.adaptiveRouting !== false,
      ssl: options.ssl || false,
      compression: options.compression !== false,
      caching: options.caching !== false,
      cacheSize: options.cacheSize || 100 * 1024 * 1024 // 100MB
    };
    
    this.servers = new Map();
    this.sessions = new Map();
    this.circuitBreakers = new Map();
    this.rateLimiters = new Map();
    this.cache = new LRUCache(this.config.cacheSize);
    this.metrics = new MetricsCollector();
    this.isRunning = false;
    this.proxyServer = null;
  }
  
  async initialize() {
    try {
      // Start health checks
      this.startHealthChecks();
      
      // Initialize geo-routing if enabled
      if (this.config.geoRouting) {
        await this.initializeGeoRouting();
      }
      
      // Start metrics collection
      this.metrics.start();
      
      // Create proxy server
      await this.createProxyServer();
      
      this.isRunning = true;
      
      this.emit('initialized', {
        algorithm: this.config.algorithm,
        serverCount: this.servers.size
      });
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
  
  async addServer(id, config) {
    const server = {
      id,
      host: config.host,
      port: config.port,
      weight: config.weight || 1,
      maxConnections: config.maxConnections || 1000,
      region: config.region || 'default',
      tags: config.tags || [],
      healthy: true,
      connections: 0,
      requestCount: 0,
      errorCount: 0,
      responseTime: [],
      lastHealthCheck: null,
      metadata: config.metadata || {}
    };
    
    this.servers.set(id, server);
    
    // Initialize circuit breaker
    if (this.config.circuitBreaker) {
      this.circuitBreakers.set(id, new CircuitBreaker({
        threshold: this.config.circuitBreakerThreshold,
        timeout: this.config.circuitBreakerTimeout
      }));
    }
    
    // Initialize rate limiter
    if (this.config.rateLimiting) {
      this.rateLimiters.set(id, new RateLimiter({
        limit: this.config.rateLimit,
        window: 60000 // 1 minute
      }));
    }
    
    // Perform initial health check
    await this.checkServerHealth(server);
    
    this.emit('serverAdded', { id, server });
    
    return server;
  }
  
  async removeServer(id) {
    const server = this.servers.get(id);
    if (!server) return false;
    
    // Wait for active connections to complete
    await this.drainConnections(server);
    
    this.servers.delete(id);
    this.circuitBreakers.delete(id);
    this.rateLimiters.delete(id);
    
    this.emit('serverRemoved', { id });
    
    return true;
  }
  
  async createProxyServer() {
    const serverOptions = {
      // Additional options can be added here
    };
    
    if (this.config.ssl) {
      this.proxyServer = https.createServer(this.config.ssl, (req, res) => {
        this.handleRequest(req, res);
      });
    } else {
      this.proxyServer = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });
    }
    
    // Handle WebSocket upgrades
    this.proxyServer.on('upgrade', (req, socket, head) => {
      this.handleWebSocketUpgrade(req, socket, head);
    });
    
    // Handle errors
    this.proxyServer.on('error', (error) => {
      this.emit('error', { type: 'proxyServer', error });
    });
  }
  
  async handleRequest(req, res) {
    const startTime = Date.now();
    
    try {
      // Check cache
      if (this.config.caching && req.method === 'GET') {
        const cached = this.cache.get(req.url);
        if (cached) {
          res.writeHead(200, cached.headers);
          res.end(cached.body);
          this.metrics.recordCacheHit();
          return;
        }
      }
      
      // Get client info
      const clientInfo = this.getClientInfo(req);
      
      // Select server
      const server = await this.selectServer(req, clientInfo);
      if (!server) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('Service Unavailable');
        return;
      }
      
      // Check rate limiting
      if (this.config.rateLimiting) {
        const rateLimiter = this.rateLimiters.get(server.id);
        if (!rateLimiter.allow(clientInfo.ip)) {
          res.writeHead(429, { 'Content-Type': 'text/plain' });
          res.end('Too Many Requests');
          return;
        }
      }
      
      // Proxy request
      await this.proxyRequest(req, res, server);
      
      // Record metrics
      const duration = Date.now() - startTime;
      this.metrics.recordRequest(server.id, duration);
      
    } catch (error) {
      this.handleRequestError(res, error);
    }
  }
  
  async selectServer(req, clientInfo) {
    // Get healthy servers
    const healthyServers = Array.from(this.servers.values())
      .filter(s => s.healthy && !this.isCircuitOpen(s.id));
    
    if (healthyServers.length === 0) {
      return null;
    }
    
    // Check sticky session
    if (this.config.stickySession) {
      const sessionServer = this.getSessionServer(clientInfo.sessionId);
      if (sessionServer && sessionServer.healthy) {
        return sessionServer;
      }
    }
    
    // Apply geo-routing
    if (this.config.geoRouting && clientInfo.region) {
      const regionalServers = healthyServers.filter(s => 
        s.region === clientInfo.region || s.region === 'global'
      );
      if (regionalServers.length > 0) {
        healthyServers.splice(0, healthyServers.length, ...regionalServers);
      }
    }
    
    // Select based on algorithm
    let selected;
    switch (this.config.algorithm) {
      case 'round-robin':
        selected = this.roundRobinSelect(healthyServers);
        break;
        
      case 'least-connections':
        selected = this.leastConnectionsSelect(healthyServers);
        break;
        
      case 'weighted-least-connections':
        selected = this.weightedLeastConnectionsSelect(healthyServers);
        break;
        
      case 'ip-hash':
        selected = this.ipHashSelect(healthyServers, clientInfo.ip);
        break;
        
      case 'response-time':
        selected = this.responseTimeSelect(healthyServers);
        break;
        
      case 'adaptive':
        selected = await this.adaptiveSelect(healthyServers, req);
        break;
        
      default:
        selected = healthyServers[0];
    }
    
    // Update session
    if (this.config.stickySession && selected) {
      this.updateSession(clientInfo.sessionId, selected.id);
    }
    
    return selected;
  }
  
  roundRobinSelect(servers) {
    if (!this.roundRobinIndex) this.roundRobinIndex = 0;
    
    const selected = servers[this.roundRobinIndex % servers.length];
    this.roundRobinIndex++;
    
    return selected;
  }
  
  leastConnectionsSelect(servers) {
    return servers.reduce((min, server) => 
      server.connections < min.connections ? server : min
    );
  }
  
  weightedLeastConnectionsSelect(servers) {
    return servers.reduce((best, server) => {
      const serverScore = server.connections / server.weight;
      const bestScore = best.connections / best.weight;
      return serverScore < bestScore ? server : best;
    });
  }
  
  ipHashSelect(servers, clientIp) {
    const hash = crypto.createHash('md5').update(clientIp).digest();
    const index = hash.readUInt32BE(0) % servers.length;
    return servers[index];
  }
  
  responseTimeSelect(servers) {
    return servers.reduce((best, server) => {
      const serverAvg = this.getAverageResponseTime(server);
      const bestAvg = this.getAverageResponseTime(best);
      return serverAvg < bestAvg ? server : best;
    });
  }
  
  async adaptiveSelect(servers, req) {
    // Use machine learning or heuristics to select best server
    const scores = await Promise.all(servers.map(async server => {
      const score = await this.calculateAdaptiveScore(server, req);
      return { server, score };
    }));
    
    scores.sort((a, b) => b.score - a.score);
    return scores[0].server;
  }
  
  async calculateAdaptiveScore(server, req) {
    let score = 100;
    
    // Connection load
    score -= (server.connections / server.maxConnections) * 30;
    
    // Response time
    const avgResponseTime = this.getAverageResponseTime(server);
    score -= Math.min(avgResponseTime / 100, 20);
    
    // Error rate
    const errorRate = server.errorCount / Math.max(server.requestCount, 1);
    score -= errorRate * 50;
    
    // Geographic proximity (if applicable)
    if (this.config.geoRouting && req.clientRegion) {
      if (server.region === req.clientRegion) {
        score += 20;
      }
    }
    
    // Server weight
    score *= server.weight;
    
    return Math.max(score, 0);
  }
  
  async proxyRequest(req, res, server) {
    server.connections++;
    const startTime = Date.now();
    
    const options = {
      hostname: server.host,
      port: server.port,
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        'X-Forwarded-For': this.getClientIp(req),
        'X-Forwarded-Proto': this.config.ssl ? 'https' : 'http',
        'X-Load-Balancer': 'Otedama-Advanced-LB'
      }
    };
    
    const proxyReq = http.request(options, (proxyRes) => {
      // Handle compression
      if (this.config.compression && this.shouldCompress(proxyRes)) {
        this.compressResponse(proxyRes, res);
      } else {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      }
      
      // Cache response if applicable
      if (this.config.caching && req.method === 'GET' && proxyRes.statusCode === 200) {
        this.cacheResponse(req.url, proxyRes);
      }
      
      // Record response time
      const responseTime = Date.now() - startTime;
      server.responseTime.push(responseTime);
      if (server.responseTime.length > 100) {
        server.responseTime.shift();
      }
    });
    
    proxyReq.on('error', (error) => {
      server.errorCount++;
      server.connections--;
      
      // Handle circuit breaker
      if (this.config.circuitBreaker) {
        const breaker = this.circuitBreakers.get(server.id);
        breaker.recordFailure();
      }
      
      // Retry with different server
      this.handleProxyError(req, res, error, server);
    });
    
    proxyReq.on('close', () => {
      server.connections--;
      server.requestCount++;
    });
    
    // Forward request body
    req.pipe(proxyReq);
  }
  
  async handleWebSocketUpgrade(req, socket, head) {
    try {
      const clientInfo = this.getClientInfo(req);
      const server = await this.selectServer(req, clientInfo);
      
      if (!server) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        return;
      }
      
      const proxySocket = net.connect(server.port, server.host, () => {
        proxySocket.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
        
        for (const [key, value] of Object.entries(req.headers)) {
          proxySocket.write(`${key}: ${value}\r\n`);
        }
        
        proxySocket.write('\r\n');
        proxySocket.write(head);
        
        socket.pipe(proxySocket);
        proxySocket.pipe(socket);
      });
      
      proxySocket.on('error', (error) => {
        this.emit('error', { type: 'websocket', error });
        socket.destroy();
      });
      
      socket.on('error', (error) => {
        proxySocket.destroy();
      });
      
    } catch (error) {
      socket.end('HTTP/1.1 500 Internal Server Error\r\n\r\n');
    }
  }
  
  startHealthChecks() {
    setInterval(() => {
      for (const server of this.servers.values()) {
        this.checkServerHealth(server);
      }
    }, this.config.healthCheckInterval);
  }
  
  async checkServerHealth(server) {
    const startTime = Date.now();
    
    return new Promise((resolve) => {
      const options = {
        hostname: server.host,
        port: server.port,
        path: '/health',
        method: 'GET',
        timeout: this.config.healthCheckTimeout
      };
      
      const req = http.request(options, (res) => {
        const healthy = res.statusCode >= 200 && res.statusCode < 300;
        const wasHealthy = server.healthy;
        
        server.healthy = healthy;
        server.lastHealthCheck = Date.now();
        
        if (healthy && !wasHealthy) {
          this.emit('serverRecovered', { id: server.id });
          
          // Reset circuit breaker
          if (this.config.circuitBreaker) {
            const breaker = this.circuitBreakers.get(server.id);
            breaker.reset();
          }
        } else if (!healthy && wasHealthy) {
          this.emit('serverFailed', { id: server.id });
        }
        
        resolve(healthy);
      });
      
      req.on('error', () => {
        server.healthy = false;
        server.lastHealthCheck = Date.now();
        resolve(false);
      });
      
      req.on('timeout', () => {
        req.destroy();
        server.healthy = false;
        server.lastHealthCheck = Date.now();
        resolve(false);
      });
      
      req.end();
    });
  }
  
  async drainConnections(server) {
    server.healthy = false; // Stop new connections
    
    // Wait for existing connections to complete
    const maxWait = 30000; // 30 seconds
    const startTime = Date.now();
    
    while (server.connections > 0 && (Date.now() - startTime) < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Force close remaining connections
    if (server.connections > 0) {
      this.emit('warning', {
        message: `Force closing ${server.connections} connections for server ${server.id}`
      });
    }
  }
  
  getClientInfo(req) {
    const ip = this.getClientIp(req);
    const sessionId = this.getSessionId(req);
    const region = this.getClientRegion(ip);
    
    return { ip, sessionId, region };
  }
  
  getClientIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0] || 
           req.connection.remoteAddress;
  }
  
  getSessionId(req) {
    // Extract from cookie or generate new
    const cookies = this.parseCookies(req.headers.cookie);
    return cookies['lb-session'] || this.generateSessionId();
  }
  
  parseCookies(cookieHeader) {
    const cookies = {};
    if (!cookieHeader) return cookies;
    
    cookieHeader.split(';').forEach(cookie => {
      const [name, value] = cookie.trim().split('=');
      cookies[name] = value;
    });
    
    return cookies;
  }
  
  generateSessionId() {
    return crypto.randomBytes(16).toString('hex');
  }
  
  getClientRegion(ip) {
    // Simplified geo-location
    // In production, use a proper geo-IP service
    const firstOctet = parseInt(ip.split('.')[0]);
    
    if (firstOctet < 50) return 'us-east';
    if (firstOctet < 100) return 'us-west';
    if (firstOctet < 150) return 'eu';
    if (firstOctet < 200) return 'asia';
    
    return 'default';
  }
  
  async initializeGeoRouting() {
    // Initialize geo-routing database
    // In production, use MaxMind or similar
    this.geoDatabase = new Map();
  }
  
  getSessionServer(sessionId) {
    const serverId = this.sessions.get(sessionId);
    if (!serverId) return null;
    
    const server = this.servers.get(serverId);
    
    // Check session timeout
    const session = this.sessions.get(sessionId);
    if (session && Date.now() - session.lastAccess > this.config.sessionTimeout) {
      this.sessions.delete(sessionId);
      return null;
    }
    
    return server;
  }
  
  updateSession(sessionId, serverId) {
    this.sessions.set(sessionId, {
      serverId,
      lastAccess: Date.now()
    });
  }
  
  isCircuitOpen(serverId) {
    if (!this.config.circuitBreaker) return false;
    
    const breaker = this.circuitBreakers.get(serverId);
    return breaker && breaker.isOpen();
  }
  
  getAverageResponseTime(server) {
    if (server.responseTime.length === 0) return 0;
    
    const sum = server.responseTime.reduce((a, b) => a + b, 0);
    return sum / server.responseTime.length;
  }
  
  shouldCompress(response) {
    const contentType = response.headers['content-type'];
    const compressibleTypes = ['text/', 'application/json', 'application/javascript'];
    
    return compressibleTypes.some(type => contentType?.includes(type));
  }
  
  compressResponse(proxyRes, res) {
    const zlib = require('zlib');
    const headers = { ...proxyRes.headers };
    
    headers['content-encoding'] = 'gzip';
    delete headers['content-length'];
    
    res.writeHead(proxyRes.statusCode, headers);
    
    const gzip = zlib.createGzip();
    proxyRes.pipe(gzip).pipe(res);
  }
  
  async cacheResponse(url, response) {
    const chunks = [];
    
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => {
      const body = Buffer.concat(chunks);
      this.cache.set(url, {
        headers: response.headers,
        body,
        timestamp: Date.now()
      });
    });
  }
  
  handleProxyError(req, res, error, failedServer) {
    this.emit('proxyError', { error, server: failedServer.id });
    
    // Try another server
    this.retryRequest(req, res, failedServer);
  }
  
  async retryRequest(req, res, excludeServer) {
    const servers = Array.from(this.servers.values())
      .filter(s => s.id !== excludeServer.id && s.healthy);
    
    if (servers.length === 0) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Service Unavailable');
      return;
    }
    
    const server = servers[0]; // Simple selection for retry
    await this.proxyRequest(req, res, server);
  }
  
  handleRequestError(res, error) {
    this.emit('error', { type: 'request', error });
    
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  }
  
  // Public API methods
  
  async start(port = 80) {
    return new Promise((resolve, reject) => {
      this.proxyServer.listen(port, (error) => {
        if (error) {
          reject(error);
        } else {
          this.emit('started', { port });
          resolve();
        }
      });
    });
  }
  
  async stop() {
    return new Promise((resolve) => {
      this.proxyServer.close(() => {
        this.isRunning = false;
        this.emit('stopped');
        resolve();
      });
    });
  }
  
  getStats() {
    const stats = {
      servers: {},
      totalRequests: 0,
      totalErrors: 0,
      averageResponseTime: 0,
      cacheHitRate: this.metrics.getCacheHitRate(),
      activeConnections: 0
    };
    
    let totalResponseTime = 0;
    let responseCount = 0;
    
    for (const [id, server] of this.servers) {
      const avgResponseTime = this.getAverageResponseTime(server);
      
      stats.servers[id] = {
        healthy: server.healthy,
        connections: server.connections,
        requestCount: server.requestCount,
        errorCount: server.errorCount,
        errorRate: server.requestCount > 0 ? 
          (server.errorCount / server.requestCount) : 0,
        averageResponseTime: avgResponseTime,
        weight: server.weight,
        region: server.region
      };
      
      stats.totalRequests += server.requestCount;
      stats.totalErrors += server.errorCount;
      stats.activeConnections += server.connections;
      
      if (server.responseTime.length > 0) {
        totalResponseTime += avgResponseTime * server.responseTime.length;
        responseCount += server.responseTime.length;
      }
    }
    
    stats.averageResponseTime = responseCount > 0 ? 
      totalResponseTime / responseCount : 0;
    
    return stats;
  }
  
  updateServerWeight(serverId, weight) {
    const server = this.servers.get(serverId);
    if (!server) return false;
    
    server.weight = weight;
    this.emit('serverUpdated', { id: serverId, weight });
    
    return true;
  }
}

// Circuit Breaker implementation
class CircuitBreaker {
  constructor(options) {
    this.threshold = options.threshold;
    this.timeout = options.timeout;
    this.failures = 0;
    this.successes = 0;
    this.state = 'closed';
    this.nextAttempt = 0;
  }
  
  recordSuccess() {
    this.failures = 0;
    this.successes++;
    
    if (this.state === 'half-open' && this.successes > 5) {
      this.state = 'closed';
    }
  }
  
  recordFailure() {
    this.failures++;
    this.successes = 0;
    
    const failureRate = this.failures / (this.failures + this.successes + 1);
    
    if (failureRate > this.threshold) {
      this.state = 'open';
      this.nextAttempt = Date.now() + this.timeout;
    }
  }
  
  isOpen() {
    if (this.state === 'open' && Date.now() > this.nextAttempt) {
      this.state = 'half-open';
      return false;
    }
    
    return this.state === 'open';
  }
  
  reset() {
    this.failures = 0;
    this.successes = 0;
    this.state = 'closed';
    this.nextAttempt = 0;
  }
}

// Rate Limiter implementation
class RateLimiter {
  constructor(options) {
    this.limit = options.limit;
    this.window = options.window;
    this.requests = new Map();
  }
  
  allow(clientId) {
    const now = Date.now();
    const clientRequests = this.requests.get(clientId) || [];
    
    // Remove old requests
    const recentRequests = clientRequests.filter(time => 
      now - time < this.window
    );
    
    if (recentRequests.length >= this.limit) {
      return false;
    }
    
    recentRequests.push(now);
    this.requests.set(clientId, recentRequests);
    
    return true;
  }
}

// LRU Cache implementation
class LRUCache {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.size = 0;
    this.cache = new Map();
  }
  
  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, item);
    
    return item;
  }
  
  set(key, value) {
    // Remove if exists
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    
    // Add to end
    this.cache.set(key, value);
    this.size += value.body.length;
    
    // Evict oldest if needed
    while (this.size > this.maxSize && this.cache.size > 0) {
      const firstKey = this.cache.keys().next().value;
      const firstValue = this.cache.get(firstKey);
      this.size -= firstValue.body.length;
      this.cache.delete(firstKey);
    }
  }
}

// Metrics Collector
class MetricsCollector {
  constructor() {
    this.requests = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.responseTimes = [];
  }
  
  start() {
    // Reset counters periodically
    setInterval(() => {
      this.responseTimes = this.responseTimes.slice(-1000); // Keep last 1000
    }, 60000);
  }
  
  recordRequest(serverId, duration) {
    this.requests++;
    this.responseTimes.push({ serverId, duration, timestamp: Date.now() });
  }
  
  recordCacheHit() {
    this.cacheHits++;
  }
  
  recordCacheMiss() {
    this.cacheMisses++;
  }
  
  getCacheHitRate() {
    const total = this.cacheHits + this.cacheMisses;
    return total > 0 ? this.cacheHits / total : 0;
  }
}

module.exports = AdvancedLoadBalancingSystem;