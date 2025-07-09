/**
 * Load Balancing - Intelligent Load Distribution
 * Following Carmack/Martin/Pike principles:
 * - Efficient request distribution
 * - Real-time performance monitoring
 * - Adaptive routing strategies
 */

import { EventEmitter } from 'events';
import * as net from 'net';
import * as http from 'http';
import { logger } from '../utils/logger';

interface Backend {
  id: string;
  host: string;
  port: number;
  weight: number;
  maxConnections: number;
  
  // Runtime state
  connections: number;
  totalRequests: number;
  failedRequests: number;
  responseTime: number; // Moving average
  cpuUsage?: number;
  memoryUsage?: number;
  
  // Health
  healthy: boolean;
  lastHealthCheck: Date;
  consecutiveFailures: number;
  
  // Circuit breaker
  circuitBreaker: {
    state: 'closed' | 'open' | 'half-open';
    failures: number;
    lastFailure?: Date;
    nextRetry?: Date;
  };
}

interface LoadBalancerConfig {
  algorithm: 'round-robin' | 'least-connections' | 'weighted' | 'ip-hash' | 'least-response-time' | 'adaptive';
  healthCheck: {
    enabled: boolean;
    interval: number;
    timeout: number;
    path: string;
    successThreshold: number;
    failureThreshold: number;
  };
  circuitBreaker: {
    enabled: boolean;
    failureThreshold: number;
    resetTimeout: number;
    halfOpenRequests: number;
  };
  sticky: {
    enabled: boolean;
    cookieName?: string;
    headerName?: string;
    ttl: number;
  };
  rateLimit?: {
    enabled: boolean;
    windowMs: number;
    maxRequests: number;
  };
}

interface Session {
  id: string;
  backendId: string;
  created: Date;
  lastAccess: Date;
}

interface RequestMetrics {
  timestamp: number;
  backendId: string;
  responseTime: number;
  statusCode?: number;
  success: boolean;
}

export class LoadBalancer extends EventEmitter {
  private config: LoadBalancerConfig;
  private backends: Map<string, Backend> = new Map();
  private sessions: Map<string, Session> = new Map();
  private metrics: RequestMetrics[] = [];
  private server?: net.Server | http.Server;
  private healthCheckInterval?: NodeJS.Timer;
  private currentIndex: number = 0;
  private ipHashSeed: number = Date.now();
  
  // Rate limiting
  private requestCounts: Map<string, { count: number; resetTime: number }> = new Map();

  constructor(config: LoadBalancerConfig) {
    super();
    this.config = config;
  }

  /**
   * Add backend server
   */
  addBackend(backend: Omit<Backend, 'connections' | 'totalRequests' | 'failedRequests' | 'responseTime' | 'healthy' | 'lastHealthCheck' | 'consecutiveFailures' | 'circuitBreaker'>): void {
    const fullBackend: Backend = {
      ...backend,
      connections: 0,
      totalRequests: 0,
      failedRequests: 0,
      responseTime: 0,
      healthy: true,
      lastHealthCheck: new Date(),
      consecutiveFailures: 0,
      circuitBreaker: {
        state: 'closed',
        failures: 0
      }
    };

    this.backends.set(backend.id, fullBackend);
    
    logger.info('Added backend', {
      backendId: backend.id,
      host: backend.host,
      port: backend.port,
      weight: backend.weight
    });
  }

  /**
   * Remove backend server
   */
  removeBackend(backendId: string): void {
    const backend = this.backends.get(backendId);
    if (!backend) return;

    // Remove associated sessions
    for (const [sessionId, session] of this.sessions) {
      if (session.backendId === backendId) {
        this.sessions.delete(sessionId);
      }
    }

    this.backends.delete(backendId);
    
    logger.info('Removed backend', { backendId });
  }

  /**
   * Start load balancer
   */
  async start(port: number, host: string = '0.0.0.0'): Promise<void> {
    // Create server based on protocol
    this.server = this.createServer();

    // Start health checks
    if (this.config.healthCheck.enabled) {
      this.startHealthChecks();
    }

    // Start metrics cleanup
    this.startMetricsCleanup();

    // Listen
    return new Promise((resolve, reject) => {
      this.server!.listen(port, host, () => {
        logger.info('Load balancer started', { port, host });
        this.emit('started', { port, host });
        resolve();
      });

      this.server!.on('error', (err) => {
        logger.error('Load balancer error', { error: err });
        reject(err);
      });
    });
  }

  /**
   * Stop load balancer
   */
  async stop(): Promise<void> {
    // Stop health checks
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    // Close server
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          logger.info('Load balancer stopped');
          this.emit('stopped');
          resolve();
        });
      });
    }
  }

  /**
   * Create server
   */
  private createServer(): net.Server | http.Server {
    // For HTTP load balancing
    if (this.config.sticky.enabled || this.config.healthCheck.path.startsWith('/')) {
      return http.createServer((req, res) => {
        this.handleHttpRequest(req, res);
      });
    }
    
    // For TCP load balancing
    return net.createServer((clientSocket) => {
      this.handleTcpConnection(clientSocket);
    });
  }

  /**
   * Handle HTTP request
   */
  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const startTime = Date.now();
    
    // Rate limiting
    if (this.config.rateLimit?.enabled) {
      const clientIp = this.getClientIp(req);
      if (!this.checkRateLimit(clientIp)) {
        res.writeHead(429, { 'Content-Type': 'text/plain' });
        res.end('Too Many Requests');
        return;
      }
    }

    // Select backend
    const backend = this.selectBackend(req);
    if (!backend) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Service Unavailable');
      return;
    }

    backend.connections++;
    backend.totalRequests++;

    // Proxy request
    const proxyReq = http.request({
      hostname: backend.host,
      port: backend.port,
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        'X-Forwarded-For': this.getClientIp(req),
        'X-Real-IP': this.getClientIp(req),
        'X-Forwarded-Host': req.headers.host || '',
        'X-Forwarded-Proto': 'http'
      }
    }, (proxyRes) => {
      // Copy status and headers
      res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
      
      // Pipe response
      proxyRes.pipe(res);
      
      // Record metrics
      const responseTime = Date.now() - startTime;
      this.recordMetrics({
        timestamp: Date.now(),
        backendId: backend.id,
        responseTime,
        statusCode: proxyRes.statusCode,
        success: (proxyRes.statusCode || 0) < 500
      });

      // Update backend stats
      this.updateBackendStats(backend, responseTime, true);
    });

    proxyReq.on('error', (err) => {
      logger.error('Proxy request error', {
        backendId: backend.id,
        error: err
      });

      backend.failedRequests++;
      this.updateBackendStats(backend, Date.now() - startTime, false);
      this.handleBackendFailure(backend);

      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Bad Gateway');
      }
    });

    // Handle client disconnect
    req.on('close', () => {
      proxyReq.destroy();
    });

    // Pipe request
    req.pipe(proxyReq);
  }

  /**
   * Handle TCP connection
   */
  private handleTcpConnection(clientSocket: net.Socket): void {
    const backend = this.selectBackend();
    if (!backend) {
      clientSocket.end();
      return;
    }

    backend.connections++;
    backend.totalRequests++;

    const serverSocket = net.connect({
      host: backend.host,
      port: backend.port
    });

    const startTime = Date.now();

    serverSocket.on('connect', () => {
      // Pipe sockets
      clientSocket.pipe(serverSocket);
      serverSocket.pipe(clientSocket);
    });

    serverSocket.on('error', (err) => {
      logger.error('Backend connection error', {
        backendId: backend.id,
        error: err
      });

      backend.failedRequests++;
      this.handleBackendFailure(backend);
      clientSocket.destroy();
    });

    const cleanup = () => {
      backend.connections--;
      const responseTime = Date.now() - startTime;
      this.updateBackendStats(backend, responseTime, true);
    };

    clientSocket.on('close', () => {
      serverSocket.destroy();
      cleanup();
    });

    serverSocket.on('close', () => {
      clientSocket.destroy();
      cleanup();
    });
  }

  /**
   * Select backend based on algorithm
   */
  private selectBackend(req?: http.IncomingMessage): Backend | null {
    const healthyBackends = Array.from(this.backends.values())
      .filter(b => b.healthy && b.circuitBreaker.state !== 'open' && b.connections < b.maxConnections);

    if (healthyBackends.length === 0) {
      logger.warn('No healthy backends available');
      return null;
    }

    // Check sticky session
    if (this.config.sticky.enabled && req) {
      const sessionId = this.getSessionId(req);
      if (sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
          const backend = this.backends.get(session.backendId);
          if (backend && backend.healthy) {
            session.lastAccess = new Date();
            return backend;
          }
        }
      }
    }

    let selected: Backend | null = null;

    switch (this.config.algorithm) {
      case 'round-robin':
        selected = this.roundRobinSelect(healthyBackends);
        break;
        
      case 'least-connections':
        selected = this.leastConnectionsSelect(healthyBackends);
        break;
        
      case 'weighted':
        selected = this.weightedSelect(healthyBackends);
        break;
        
      case 'ip-hash':
        selected = this.ipHashSelect(healthyBackends, req);
        break;
        
      case 'least-response-time':
        selected = this.leastResponseTimeSelect(healthyBackends);
        break;
        
      case 'adaptive':
        selected = this.adaptiveSelect(healthyBackends);
        break;
        
      default:
        selected = healthyBackends[0];
    }

    // Create sticky session if needed
    if (selected && this.config.sticky.enabled && req) {
      const sessionId = this.createSession(selected.id);
      this.setSessionCookie(req, sessionId);
    }

    return selected;
  }

  /**
   * Round-robin selection
   */
  private roundRobinSelect(backends: Backend[]): Backend {
    const selected = backends[this.currentIndex % backends.length];
    this.currentIndex++;
    return selected;
  }

  /**
   * Least connections selection
   */
  private leastConnectionsSelect(backends: Backend[]): Backend {
    return backends.reduce((min, backend) => 
      backend.connections < min.connections ? backend : min
    );
  }

  /**
   * Weighted selection
   */
  private weightedSelect(backends: Backend[]): Backend {
    const totalWeight = backends.reduce((sum, b) => sum + b.weight, 0);
    let random = Math.random() * totalWeight;

    for (const backend of backends) {
      random -= backend.weight;
      if (random <= 0) {
        return backend;
      }
    }

    return backends[0];
  }

  /**
   * IP hash selection
   */
  private ipHashSelect(backends: Backend[], req?: http.IncomingMessage): Backend {
    const ip = req ? this.getClientIp(req) : '0.0.0.0';
    const hash = this.hashString(ip + this.ipHashSeed);
    return backends[hash % backends.length];
  }

  /**
   * Least response time selection
   */
  private leastResponseTimeSelect(backends: Backend[]): Backend {
    return backends.reduce((min, backend) => 
      backend.responseTime < min.responseTime ? backend : min
    );
  }

  /**
   * Adaptive selection based on multiple factors
   */
  private adaptiveSelect(backends: Backend[]): Backend {
    // Calculate scores based on multiple metrics
    const scores = backends.map(backend => {
      const connectionScore = 1 - (backend.connections / backend.maxConnections);
      const responseTimeScore = backend.responseTime > 0 ? 1 / backend.responseTime : 1;
      const errorRateScore = backend.totalRequests > 0 
        ? 1 - (backend.failedRequests / backend.totalRequests)
        : 1;
      const cpuScore = backend.cpuUsage ? 1 - (backend.cpuUsage / 100) : 0.5;
      const memoryScore = backend.memoryUsage ? 1 - (backend.memoryUsage / 100) : 0.5;

      return {
        backend,
        score: (
          connectionScore * 0.3 +
          responseTimeScore * 0.3 +
          errorRateScore * 0.2 +
          cpuScore * 0.1 +
          memoryScore * 0.1
        ) * backend.weight
      };
    });

    // Select backend with highest score
    return scores.reduce((max, item) => 
      item.score > max.score ? item : max
    ).backend;
  }

  /**
   * Update backend statistics
   */
  private updateBackendStats(backend: Backend, responseTime: number, success: boolean): void {
    // Update response time (exponential moving average)
    const alpha = 0.3;
    backend.responseTime = backend.responseTime * (1 - alpha) + responseTime * alpha;

    // Update circuit breaker
    if (this.config.circuitBreaker.enabled) {
      if (!success) {
        backend.circuitBreaker.failures++;
        backend.circuitBreaker.lastFailure = new Date();

        if (backend.circuitBreaker.failures >= this.config.circuitBreaker.failureThreshold) {
          this.openCircuitBreaker(backend);
        }
      } else if (backend.circuitBreaker.state === 'half-open') {
        this.closeCircuitBreaker(backend);
      }
    }
  }

  /**
   * Handle backend failure
   */
  private handleBackendFailure(backend: Backend): void {
    backend.consecutiveFailures++;

    if (backend.consecutiveFailures >= this.config.healthCheck.failureThreshold) {
      backend.healthy = false;
      logger.warn('Backend marked unhealthy', { backendId: backend.id });
      this.emit('backend:unhealthy', backend.id);
    }
  }

  /**
   * Open circuit breaker
   */
  private openCircuitBreaker(backend: Backend): void {
    backend.circuitBreaker.state = 'open';
    backend.circuitBreaker.nextRetry = new Date(Date.now() + this.config.circuitBreaker.resetTimeout);
    
    logger.warn('Circuit breaker opened', { backendId: backend.id });
    this.emit('circuit:open', backend.id);
  }

  /**
   * Close circuit breaker
   */
  private closeCircuitBreaker(backend: Backend): void {
    backend.circuitBreaker.state = 'closed';
    backend.circuitBreaker.failures = 0;
    
    logger.info('Circuit breaker closed', { backendId: backend.id });
    this.emit('circuit:closed', backend.id);
  }

  /**
   * Start health checks
   */
  private startHealthChecks(): void {
    this.healthCheckInterval = setInterval(async () => {
      for (const backend of this.backends.values()) {
        await this.checkBackendHealth(backend);
      }
    }, this.config.healthCheck.interval);

    // Initial health check
    this.backends.forEach(backend => this.checkBackendHealth(backend));
  }

  /**
   * Check backend health
   */
  private async checkBackendHealth(backend: Backend): Promise<void> {
    try {
      const startTime = Date.now();
      
      await new Promise<void>((resolve, reject) => {
        const req = http.get({
          hostname: backend.host,
          port: backend.port,
          path: this.config.healthCheck.path,
          timeout: this.config.healthCheck.timeout
        }, (res) => {
          if (res.statusCode === 200) {
            resolve();
          } else {
            reject(new Error(`Health check failed: ${res.statusCode}`));
          }
          res.resume();
        });

        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Health check timeout'));
        });
      });

      // Health check passed
      const responseTime = Date.now() - startTime;
      backend.lastHealthCheck = new Date();
      backend.consecutiveFailures = 0;

      if (!backend.healthy) {
        backend.healthy = true;
        logger.info('Backend recovered', { backendId: backend.id });
        this.emit('backend:healthy', backend.id);
      }

      // Check circuit breaker
      if (backend.circuitBreaker.state === 'open' && 
          backend.circuitBreaker.nextRetry && 
          new Date() >= backend.circuitBreaker.nextRetry) {
        backend.circuitBreaker.state = 'half-open';
        logger.info('Circuit breaker half-open', { backendId: backend.id });
      }

    } catch (err) {
      this.handleBackendFailure(backend);
    }
  }

  /**
   * Get client IP
   */
  private getClientIp(req: http.IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      return (forwarded as string).split(',')[0].trim();
    }
    return req.socket.remoteAddress || '0.0.0.0';
  }

  /**
   * Hash string to number
   */
  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }

  /**
   * Check rate limit
   */
  private checkRateLimit(clientIp: string): boolean {
    if (!this.config.rateLimit?.enabled) return true;

    const now = Date.now();
    const record = this.requestCounts.get(clientIp);

    if (!record || now > record.resetTime) {
      this.requestCounts.set(clientIp, {
        count: 1,
        resetTime: now + this.config.rateLimit.windowMs
      });
      return true;
    }

    if (record.count >= this.config.rateLimit.maxRequests) {
      return false;
    }

    record.count++;
    return true;
  }

  /**
   * Get or create session ID
   */
  private getSessionId(req: http.IncomingMessage): string | null {
    // Check cookie
    if (this.config.sticky.cookieName) {
      const cookies = this.parseCookies(req.headers.cookie || '');
      const sessionId = cookies[this.config.sticky.cookieName];
      if (sessionId) return sessionId;
    }

    // Check header
    if (this.config.sticky.headerName) {
      const sessionId = req.headers[this.config.sticky.headerName.toLowerCase()];
      if (sessionId) return sessionId as string;
    }

    return null;
  }

  /**
   * Parse cookies
   */
  private parseCookies(cookieHeader: string): { [key: string]: string } {
    const cookies: { [key: string]: string } = {};
    cookieHeader.split(';').forEach(cookie => {
      const [name, value] = cookie.trim().split('=');
      if (name && value) {
        cookies[name] = value;
      }
    });
    return cookies;
  }

  /**
   * Create session
   */
  private createSession(backendId: string): string {
    const sessionId = crypto.randomBytes(16).toString('hex');
    const session: Session = {
      id: sessionId,
      backendId,
      created: new Date(),
      lastAccess: new Date()
    };

    this.sessions.set(sessionId, session);
    
    // Clean old sessions
    this.cleanupSessions();
    
    return sessionId;
  }

  /**
   * Set session cookie
   */
  private setSessionCookie(req: http.IncomingMessage, sessionId: string): void {
    // This would be implemented properly in the response
    // For now, just store the session
  }

  /**
   * Cleanup old sessions
   */
  private cleanupSessions(): void {
    const now = Date.now();
    const ttl = this.config.sticky.ttl;

    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastAccess.getTime() > ttl) {
        this.sessions.delete(sessionId);
      }
    }
  }

  /**
   * Record metrics
   */
  private recordMetrics(metric: RequestMetrics): void {
    this.metrics.push(metric);
    
    // Keep only recent metrics (last hour)
    const cutoff = Date.now() - 3600000;
    this.metrics = this.metrics.filter(m => m.timestamp > cutoff);
  }

  /**
   * Start metrics cleanup
   */
  private startMetricsCleanup(): void {
    setInterval(() => {
      this.cleanupSessions();
      
      // Clean old rate limit records
      const now = Date.now();
      for (const [ip, record] of this.requestCounts) {
        if (now > record.resetTime) {
          this.requestCounts.delete(ip);
        }
      }
    }, 60000); // Every minute
  }

  /**
   * Get statistics
   */
  getStatistics(): any {
    const backends = Array.from(this.backends.values()).map(backend => ({
      id: backend.id,
      host: `${backend.host}:${backend.port}`,
      weight: backend.weight,
      connections: backend.connections,
      totalRequests: backend.totalRequests,
      failedRequests: backend.failedRequests,
      errorRate: backend.totalRequests > 0 
        ? (backend.failedRequests / backend.totalRequests * 100).toFixed(2) + '%'
        : '0%',
      responseTime: Math.round(backend.responseTime),
      healthy: backend.healthy,
      circuitBreaker: backend.circuitBreaker.state
    }));

    const totalRequests = this.metrics.length;
    const successfulRequests = this.metrics.filter(m => m.success).length;
    const avgResponseTime = totalRequests > 0
      ? this.metrics.reduce((sum, m) => sum + m.responseTime, 0) / totalRequests
      : 0;

    return {
      algorithm: this.config.algorithm,
      backends,
      sessions: this.sessions.size,
      metrics: {
        totalRequests,
        successfulRequests,
        errorRate: totalRequests > 0 
          ? ((totalRequests - successfulRequests) / totalRequests * 100).toFixed(2) + '%'
          : '0%',
        avgResponseTime: Math.round(avgResponseTime)
      }
    };
  }
}

// Export types
export { Backend, LoadBalancerConfig, Session, RequestMetrics };
