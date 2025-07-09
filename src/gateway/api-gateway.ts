// src/gateway/api-gateway.ts
import express from 'express';
import rateLimit from 'express-rate-limit';
import { Logger } from '../logging/logger';
import { RedisCache } from '../cache/redis-cache';
import { OAuth2JWTProvider } from '../auth/oauth2-jwt-provider';
import crypto from 'crypto';
import http from 'http';
import https from 'https';
import { URL } from 'url';

export interface ServiceRoute {
  path: string;
  target: string;
  stripPrefix?: boolean;
  authRequired?: boolean;
  roles?: string[];
  permissions?: string[];
  rateLimit?: {
    windowMs: number;
    max: number;
  };
  timeout?: number;
  retries?: number;
  healthCheck?: string;
  loadBalancer?: {
    strategy: 'round-robin' | 'least-connections' | 'random';
    targets: string[];
  };
}

export interface GatewayConfig {
  port: number;
  cors: {
    enabled: boolean;
    origins: string[];
  };
  rateLimit: {
    windowMs: number;
    max: number;
  };
  circuitBreaker: {
    enabled: boolean;
    failureThreshold: number;
    resetTimeout: number;
  };
  monitoring: {
    enabled: boolean;
    metricsPath: string;
  };
}

export interface ServiceHealth {
  service: string;
  status: 'healthy' | 'unhealthy' | 'unknown';
  responseTime: number;
  lastCheck: Date;
  consecutiveFailures: number;
}

export class APIGateway {
  private app: express.Application;
  private logger: Logger;
  private cache: RedisCache;
  private authProvider: OAuth2JWTProvider;
  private config: GatewayConfig;
  private routes: Map<string, ServiceRoute> = new Map();
  private serviceHealth: Map<string, ServiceHealth> = new Map();
  private loadBalancerState: Map<string, { index: number; connections: number[] }> = new Map();
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();
  private metrics: GatewayMetrics;

  constructor(
    config: GatewayConfig,
    logger: Logger,
    cache: RedisCache,
    authProvider: OAuth2JWTProvider
  ) {
    this.app = express();
    this.config = config;
    this.logger = logger;
    this.cache = cache;
    this.authProvider = authProvider;
    this.metrics = new GatewayMetrics(cache);

    this.setupMiddleware();
    this.startHealthChecks();
  }

  private setupMiddleware(): void {
    // Request ID middleware
    this.app.use((req, res, next) => {
      req.headers['x-request-id'] = req.headers['x-request-id'] || crypto.randomUUID();
      res.setHeader('x-request-id', req.headers['x-request-id']);
      next();
    });

    // CORS
    if (this.config.cors.enabled) {
      this.app.use((req, res, next) => {
        const origin = req.headers.origin as string;
        if (this.config.cors.origins.includes('*') || this.config.cors.origins.includes(origin)) {
          res.header('Access-Control-Allow-Origin', origin);
          res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
          res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
        }
        next();
      });
    }

    // Global rate limiting
    const globalRateLimit = rateLimit({
      windowMs: this.config.rateLimit.windowMs,
      max: this.config.rateLimit.max,
      message: { error: 'Too many requests from this IP' },
      standardHeaders: true,
      legacyHeaders: false
    });
    this.app.use(globalRateLimit);

    // Request logging
    this.app.use((req, res, next) => {
      const startTime = Date.now();
      
      res.on('finish', () => {
        const duration = Date.now() - startTime;
        this.logger.info(`${req.method} ${req.path}`, {
          statusCode: res.statusCode,
          duration,
          requestId: req.headers['x-request-id'],
          userAgent: req.headers['user-agent'],
          ip: req.ip
        });

        // Record metrics
        this.metrics.recordRequest(req.method, req.path, res.statusCode, duration);
      });

      next();
    });

    // Health check endpoint
    this.app.get('/gateway/health', async (req, res) => {
      const health = await this.getGatewayHealth();
      const status = health.status === 'healthy' ? 200 : 503;
      res.status(status).json(health);
    });

    // Metrics endpoint
    if (this.config.monitoring.enabled) {
      this.app.get(this.config.monitoring.metricsPath, async (req, res) => {
        const metrics = await this.metrics.getMetrics();
        res.set('Content-Type', 'text/plain');
        res.send(metrics);
      });
    }

    // Routes info endpoint
    this.app.get('/gateway/routes', (req, res) => {
      const routes = Array.from(this.routes.entries()).map(([path, route]) => ({
        path,
        target: route.target,
        authRequired: route.authRequired,
        roles: route.roles,
        permissions: route.permissions
      }));
      res.json({ routes });
    });

    // Service health endpoint
    this.app.get('/gateway/services/health', (req, res) => {
      const services = Array.from(this.serviceHealth.entries()).map(([service, health]) => ({
        service,
        ...health
      }));
      res.json({ services });
    });
  }

  public addRoute(route: ServiceRoute): void {
    this.routes.set(route.path, route);
    
    // Initialize load balancer state
    if (route.loadBalancer) {
      this.loadBalancerState.set(route.path, {
        index: 0,
        connections: new Array(route.loadBalancer.targets.length).fill(0)
      });
    }

    // Initialize circuit breaker
    if (this.config.circuitBreaker.enabled) {
      this.circuitBreakers.set(route.path, new CircuitBreaker(
        this.config.circuitBreaker.failureThreshold,
        this.config.circuitBreaker.resetTimeout,
        this.logger
      ));
    }

    // Create proxy middleware with simplified implementation
    const middlewares: express.RequestHandler[] = [];

    // Route-specific rate limiting
    if (route.rateLimit) {
      const routeRateLimit = rateLimit({
        windowMs: route.rateLimit.windowMs,
        max: route.rateLimit.max,
        message: { error: `Rate limit exceeded for ${route.path}` }
      });
      middlewares.push(routeRateLimit);
    }

    // Authentication middleware
    if (route.authRequired) {
      middlewares.push(this.authProvider.authenticateJWT());
      
      if (route.roles && route.roles.length > 0) {
        middlewares.push(this.authProvider.requireRoles(route.roles));
      }
      
      if (route.permissions && route.permissions.length > 0) {
        middlewares.push(this.authProvider.requirePermissions(route.permissions));
      }
    }

    // Circuit breaker middleware
    if (this.config.circuitBreaker.enabled) {
      middlewares.push((req, res, next) => {
        const circuitBreaker = this.circuitBreakers.get(route.path);
        if (circuitBreaker && circuitBreaker.isOpen()) {
          return res.status(503).json({
            error: 'Service circuit breaker is open',
            requestId: req.headers['x-request-id']
          });
        }
        next();
      });
    }

    // Health check middleware
    middlewares.push((req, res, next) => {
      const health = this.serviceHealth.get(route.target);
      if (health && health.status === 'unhealthy') {
        return res.status(503).json({
          error: 'Service is unhealthy',
          requestId: req.headers['x-request-id']
        });
      }
      next();
    });

    // Proxy middleware (simplified implementation)
    middlewares.push(async (req, res, next) => {
      try {
        const target = this.selectTarget(route);
        const targetUrl = new URL(target);
        
        // Build the proxy request URL
        let path = req.path;
        if (route.stripPrefix && req.path.startsWith(route.path)) {
          path = req.path.substring(route.path.length);
        }
        
        const proxyUrl = `${targetUrl.protocol}//${targetUrl.host}${path}${req.url.includes('?') ? '?' + req.url.split('?')[1] : ''}`;
        
        // Set up proxy request options
        const options = {
          method: req.method,
          headers: {
            ...req.headers,
            'host': targetUrl.host,
            'X-Gateway-Request-ID': req.headers['x-request-id'],
            'X-Gateway-Source': 'otedama-gateway'
          },
          timeout: route.timeout || 30000
        };

        // Forward user context if authenticated
        if ((req as any).user) {
          options.headers['X-User-ID'] = (req as any).user.id;
          options.headers['X-User-Roles'] = JSON.stringify((req as any).user.roles);
        }

        // Make the proxy request
        await this.makeProxyRequest(proxyUrl, options, req, res, route);

      } catch (error) {
        this.logger.error(`Proxy error for ${route.path}:`, error);
        this.metrics.recordError(route.path);
        
        if (!res.headersSent) {
          res.status(502).json({
            error: 'Service temporarily unavailable',
            requestId: req.headers['x-request-id']
          });
        }
      }
    });

    // Register route
    this.app.use(route.path, ...middlewares);

    this.logger.info(`Route registered: ${route.path} -> ${route.target}`, {
      authRequired: route.authRequired,
      roles: route.roles,
      permissions: route.permissions
    });
  }

  private async makeProxyRequest(
    url: string,
    options: any,
    req: express.Request,
    res: express.Response,
    route: ServiceRoute
  ): Promise<void> {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    const proxyReq = httpModule.request(url, options, (proxyRes) => {
      // Set response headers
      res.status(proxyRes.statusCode || 200);
      
      Object.keys(proxyRes.headers).forEach(key => {
        const value = proxyRes.headers[key];
        if (value) {
          res.setHeader(key, value);
        }
      });

      // Add security headers
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-XSS-Protection', '1; mode=block');

      // Pipe response
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (error) => {
      this.logger.error(`Proxy request error:`, error);
      if (!res.headersSent) {
        res.status(502).json({
          error: 'Bad gateway',
          requestId: req.headers['x-request-id']
        });
      }
    });

    // Handle request body
    if (req.body && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH')) {
      proxyReq.write(JSON.stringify(req.body));
    }

    proxyReq.end();
  }

  private selectTarget(route: ServiceRoute): string {
    if (!route.loadBalancer) {
      return route.target;
    }

    const state = this.loadBalancerState.get(route.path)!;
    const targets = route.loadBalancer.targets;

    switch (route.loadBalancer.strategy) {
      case 'round-robin':
        const target = targets[state.index];
        state.index = (state.index + 1) % targets.length;
        return target;

      case 'least-connections':
        let minConnections = Math.min(...state.connections);
        let minIndex = state.connections.indexOf(minConnections);
        state.connections[minIndex]++;
        
        // Decrement connection count after response (simplified)
        setTimeout(() => {
          state.connections[minIndex]--;
        }, 5000);
        
        return targets[minIndex];

      case 'random':
        const randomIndex = Math.floor(Math.random() * targets.length);
        return targets[randomIndex];

      default:
        return targets[0];
    }
  }

  private startHealthChecks(): void {
    setInterval(async () => {
      for (const [path, route] of this.routes.entries()) {
        await this.checkServiceHealth(route);
        
        // Check load balancer targets
        if (route.loadBalancer) {
          for (const target of route.loadBalancer.targets) {
            await this.checkServiceHealth({ ...route, target });
          }
        }
      }
    }, 30000); // Check every 30 seconds
  }

  private async checkServiceHealth(route: ServiceRoute): Promise<void> {
    const startTime = Date.now();
    const healthUrl = route.healthCheck || `${route.target}/health`;
    
    try {
      const response = await fetch(healthUrl, {
        method: 'GET',
        // @ts-ignore - signal is supported in newer versions
        signal: AbortSignal.timeout(5000),
        headers: {
          'User-Agent': 'Otedama-Gateway-HealthCheck/1.0'
        }
      });

      const responseTime = Date.now() - startTime;
      const isHealthy = response.ok;

      const currentHealth = this.serviceHealth.get(route.target) || {
        service: route.target,
        status: 'unknown' as const,
        responseTime: 0,
        lastCheck: new Date(),
        consecutiveFailures: 0
      };

      this.serviceHealth.set(route.target, {
        service: route.target,
        status: isHealthy ? 'healthy' : 'unhealthy',
        responseTime,
        lastCheck: new Date(),
        consecutiveFailures: isHealthy ? 0 : currentHealth.consecutiveFailures + 1
      });

      // Update circuit breaker
      const circuitBreaker = this.circuitBreakers.get(route.path);
      if (circuitBreaker) {
        if (isHealthy) {
          circuitBreaker.recordSuccess();
        } else {
          circuitBreaker.recordFailure();
        }
      }

    } catch (error) {
      const responseTime = Date.now() - startTime;
      const currentHealth = this.serviceHealth.get(route.target);
      
      this.serviceHealth.set(route.target, {
        service: route.target,
        status: 'unhealthy',
        responseTime,
        lastCheck: new Date(),
        consecutiveFailures: (currentHealth?.consecutiveFailures || 0) + 1
      });

      // Update circuit breaker
      const circuitBreaker = this.circuitBreakers.get(route.path);
      if (circuitBreaker) {
        circuitBreaker.recordFailure();
      }

      this.logger.debug(`Health check failed for ${route.target}:`, error);
    }
  }

  private async getGatewayHealth(): Promise<any> {
    const services = Array.from(this.serviceHealth.values());
    const healthyServices = services.filter(s => s.status === 'healthy').length;
    const totalServices = services.length;
    
    const overallStatus = totalServices === 0 ? 'unknown' : 
      (healthyServices / totalServices >= 0.8 ? 'healthy' : 'unhealthy');

    return {
      status: overallStatus,
      timestamp: new Date(),
      services: {
        total: totalServices,
        healthy: healthyServices,
        unhealthy: services.filter(s => s.status === 'unhealthy').length
      },
      routes: this.routes.size,
      uptime: process.uptime()
    };
  }

  public async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = this.app.listen(this.config.port, (error?: Error) => {
        if (error) {
          this.logger.error('Failed to start API Gateway:', error);
          reject(error);
        } else {
          this.logger.info(`API Gateway started on port ${this.config.port}`);
          resolve();
        }
      });

      // Graceful shutdown
      process.on('SIGTERM', () => {
        this.logger.info('SIGTERM received, shutting down API Gateway...');
        server.close(() => {
          this.logger.info('API Gateway shut down gracefully');
          process.exit(0);
        });
      });
    });
  }

  public getApp(): express.Application {
    return this.app;
  }
}

// Circuit Breaker implementation
class CircuitBreaker {
  private failures: number = 0;
  private lastFailureTime: number = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';

  constructor(
    private failureThreshold: number,
    private resetTimeout: number,
    private logger: Logger
  ) {}

  public recordSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  public recordFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    
    if (this.failures >= this.failureThreshold) {
      this.state = 'open';
      this.logger.warn(`Circuit breaker opened after ${this.failures} failures`);
    }
  }

  public isOpen(): boolean {
    if (this.state === 'closed') {
      return false;
    }

    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime >= this.resetTimeout) {
        this.state = 'half-open';
        this.logger.info('Circuit breaker moved to half-open state');
        return false;
      }
      return true;
    }

    // half-open state
    return false;
  }
}

// Gateway Metrics
class GatewayMetrics {
  private cache: RedisCache;
  private metrics: Map<string, number> = new Map();

  constructor(cache: RedisCache) {
    this.cache = cache;
  }

  public recordRequest(method: string, path: string, statusCode: number, duration: number): void {
    const key = `gateway_requests_total`;
    this.incrementMetric(key, { method, path, status: statusCode.toString() });
    
    const durationKey = `gateway_request_duration_ms`;
    this.observeMetric(durationKey, duration, { method, path });
  }

  public recordError(path: string): void {
    const key = `gateway_errors_total`;
    this.incrementMetric(key, { path });
  }

  private incrementMetric(name: string, labels: Record<string, string> = {}): void {
    const key = this.createMetricKey(name, labels);
    const current = this.metrics.get(key) || 0;
    this.metrics.set(key, current + 1);
  }

  private observeMetric(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.createMetricKey(name, labels);
    // For simplicity, just store the latest value
    this.metrics.set(key, value);
  }

  private createMetricKey(name: string, labels: Record<string, string>): string {
    const labelString = Object.entries(labels)
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
    return labelString ? `${name}{${labelString}}` : name;
  }

  public async getMetrics(): Promise<string> {
    const lines: string[] = [];
    
    for (const [key, value] of this.metrics.entries()) {
      lines.push(`${key} ${value}`);
    }
    
    return lines.join('\n');
  }
}