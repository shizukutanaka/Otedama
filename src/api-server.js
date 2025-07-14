import { EventEmitter } from 'events';
import { createServer } from 'http';
import { createServer as createHTTPSServer } from 'https';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import Logger from './logger.js';
import SecurityManager from './security-manager.js';
import { RateLimiter } from './rate-limiter.js';

// ==================== API Server ====================
export default class APIServer extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.logger = new Logger('API');
    this.security = new SecurityManager();
    this.rateLimiter = new RateLimiter(config.rateLimits);
    this.wsClients = new Set();
    this.cache = new Map();
    this.corsOrigins = config.security?.corsOrigins || ['*'];
    this.enableSSL = config.security?.enableSSL || false;
    this.sslOptions = null;
    
    // Initialize SSL if enabled
    if (this.enableSSL && config.security?.sslCert && config.security?.sslKey) {
      try {
        this.sslOptions = {
          cert: fs.readFileSync(config.security.sslCert),
          key: fs.readFileSync(config.security.sslKey)
        };
        this.logger.info('SSL/TLS enabled');
      } catch (e) {
        this.logger.error('Failed to load SSL certificates:', e.message);
        this.enableSSL = false;
      }
    }
  }

  async start() {
    // Create server with or without SSL
    if (this.enableSSL && this.sslOptions) {
      this.server = createHTTPSServer(this.sslOptions, (req, res) => this.handleRequest(req, res));
    } else {
      this.server = createServer((req, res) => this.handleRequest(req, res));
    }
    
    this.ws = new WebSocketServer({ server: this.server });
    
    this.ws.on('connection', (ws, req) => {
      const ip = req.socket.remoteAddress;
      
      // Check stratum connection limit
      const connectionCheck = this.rateLimiter.checkStratumConnection(ip);
      if (!connectionCheck.allowed || this.security.isBlocked(ip)) {
        ws.close();
        return;
      }
      
      const client = {
        ws,
        ip,
        subscriptions: new Set(),
        authenticated: false
      };
      
      this.wsClients.add(client);
      
      ws.on('message', (data) => this.handleWSMessage(client, data));
      ws.on('close', () => {
        this.wsClients.delete(client);
        this.rateLimiter.releaseStratumConnection(ip);
      });
      ws.on('error', (err) => this.logger.debug(`WS error: ${err.message}`));
    });

    await new Promise(resolve => this.server.listen(this.config.network.apiPort, resolve));
    
    // Start metrics server if enabled
    if (this.config.monitoring.enableMetrics) {
      this.startMetricsServer();
    }
    
    // Cache cleanup
    setInterval(() => this.cleanupCache(), 60000);
    
    this.logger.info(`API started on port ${this.config.network.apiPort}`);
  }

  async handleRequest(req, res) {
    global.globalProfiler?.start('api.request');
    const startTime = Date.now();
    const ip = req.socket.remoteAddress;
    
    // Check rate limit first
    const rateLimitResult = this.rateLimiter.checkAPILimit({ ip, url: req.url });
    if (!rateLimitResult.allowed) {
      res.statusCode = 429;
      res.setHeader('X-RateLimit-Limit', rateLimitResult.limit || 1000);
      res.setHeader('X-RateLimit-Remaining', rateLimitResult.remaining || 0);
      res.setHeader('X-RateLimit-Reset', rateLimitResult.reset || new Date());
      res.setHeader('Retry-After', rateLimitResult.retryAfter || 60);
      res.end(JSON.stringify({ 
        error: 'Too many requests',
        reason: rateLimitResult.reason,
        retryAfter: rateLimitResult.retryAfter
      }));
      return;
    }
    
    // Add rate limit headers
    res.setHeader('X-RateLimit-Limit', rateLimitResult.limit);
    res.setHeader('X-RateLimit-Remaining', rateLimitResult.remaining);
    res.setHeader('X-RateLimit-Reset', rateLimitResult.reset);
    
    // Enhanced CORS headers
    const origin = req.headers.origin || '*';
    if (this.corsOrigins.includes('*') || this.corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', this.corsOrigins[0]);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    
    if (req.method === 'OPTIONS') {
      res.end();
      return;
    }
    
    // Security checks
    if (this.security.isBlocked(ip) || this.rateLimiter.isBlocked(ip)) {
      res.statusCode = 403;
      res.end('{"error":"Forbidden"}');
      return;
    }
    
    const rateLimit = this.config.security.enableRateLimit;
    const maxRequests = this.config.security.maxRequestsPerMinute;
    
    if (rateLimit && !this.security.checkRateLimit(ip, maxRequests)) {
      res.statusCode = 429;
      res.end('{"error":"Too many requests"}');
      return;
    }
    
    // Parse URL
    const url = new URL(req.url, `http://localhost`);
    
    try {
      // Authentication check for protected endpoints
      if (this.config.security.enableAuth && url.pathname.startsWith('/api/')) {
        const apiKey = req.headers['x-api-key'];
        if (!this.security.validateAPIKey(apiKey)) {
          res.statusCode = 401;
          res.end('{"error":"Unauthorized"}');
          return;
        }
      }
      
      // Route request
      let handled = false;
      
      switch (url.pathname) {
        case '/':
          this.sendDashboard(res);
          handled = true;
          break;
          
        case '/api/stats':
          this.sendJSON(res, this.getCachedStats());
          handled = true;
          break;
          
        case '/api/info':
          this.sendJSON(res, this.getInfo());
          handled = true;
          break;
          
        case '/api/health':
          this.sendJSON(res, this.getHealth());
          handled = true;
          break;
          
        case '/api/security/metrics':
          if (this.config.security.enableAuth && !req.headers['x-api-key']) {
            res.statusCode = 401;
            res.end('{"error":"Authentication required"}');
          } else {
            const metrics = this.security.getSecurityMetrics();
            this.sendJSON(res, metrics);
          }
          handled = true;
          break;
          
        case '/api/performance/profile':
          if (this.config.security.enableAuth && !req.headers['x-api-key']) {
            res.statusCode = 401;
            res.end('{"error":"Authentication required"}');
          } else {
            const profile = global.globalProfiler.getReport();
            this.sendJSON(res, profile);
          }
          handled = true;
          break;
          
        case '/api/tuning/status':
          const tuningStatus = {
            enabled: global.autoTuner?.enabled || false,
            metrics: global.autoTuner?.metrics || {},
            lastTune: global.autoTuner?.lastCheck || null
          };
          this.sendJSON(res, tuningStatus);
          handled = true;
          break;
          
        case '/api/mining/stats':
          this.sendJSON(res, global.mining?.getStats() || { enabled: false });
          handled = true;
          break;
          
        case '/api/stratum/stats':
          this.sendJSON(res, global.stratum?.getStats() || { miners: 0 });
          handled = true;
          break;
          
        case '/api/p2p/peers':
          this.sendJSON(res, {
            count: global.p2p?.getPeerCount() || 0,
            peers: global.p2p?.getPeerList() || []
          });
          handled = true;
          break;
          
        case '/api/rate-limits/stats':
          if (this.config.security.enableAuth && !req.headers['x-api-key']) {
            res.statusCode = 401;
            res.end('{"error":"Authentication required"}');
          } else {
            const rateLimitStats = this.rateLimiter.getStats();
            this.sendJSON(res, rateLimitStats);
          }
          handled = true;
          break;
          
        case '/api/dex/pools':
          this.sendJSON(res, global.dex?.getAllPools() || []);
          handled = true;
          break;
          
        case '/api/miners':
          this.sendJSON(res, this.getMiners());
          handled = true;
          break;
      }
      
      // Handle pool-specific endpoints
      if (url.pathname.startsWith('/api/dex/pool/')) {
        const parts = url.pathname.split('/');
        const poolId = parts[4];
        const action = parts[5];
        
        if (!poolId) {
          res.statusCode = 400;
          res.end('{"error":"Pool ID required"}');
          handled = true;
        } else if (!action) {
          const pool = global.dex?.getPool(poolId);
          if (pool) {
            this.sendJSON(res, pool);
          } else {
            res.statusCode = 404;
            res.end('{"error":"Pool not found"}');
          }
          handled = true;
        } else {
          // Handle pool-specific actions
          switch (action) {
            case 'twap':
              const token = url.searchParams.get('token');
              const duration = parseInt(url.searchParams.get('duration') || '300000');
              const twap = global.dex?.getTWAP(poolId, token, duration);
              if (twap !== null) {
                this.sendJSON(res, { poolId, token, twap, duration });
              } else {
                res.statusCode = 404;
                res.end('{"error":"TWAP data not available"}');
              }
              handled = true;
              break;
              
            case 'impermanent-loss':
              const provider = url.searchParams.get('provider') || 'default';
              const il = global.dex?.getImpermanentLoss(poolId, provider);
              if (il) {
                this.sendJSON(res, { poolId, provider, ...il });
              } else {
                res.statusCode = 404;
                res.end('{"error":"No position found"}');
              }
              handled = true;
              break;
              
            default:
              res.statusCode = 404;
              res.end('{"error":"Unknown action"}');
              handled = true;
          }
        }
      }
      
      // Handle miner-specific endpoints
      if (url.pathname.startsWith('/api/miner/')) {
        const minerId = url.pathname.split('/').pop();
        const miner = global.db?.getMiner(minerId);
        if (miner) {
          this.sendJSON(res, miner);
        } else {
          res.statusCode = 404;
          res.end('{"error":"Miner not found"}');
        }
        handled = true;
      }
      
      // Handle POST requests
      if (req.method === 'POST') {
        const body = await this.getRequestBody(req);
        handled = await this.handlePOST(url.pathname, body, res);
      }
      
      if (!handled) {
        res.statusCode = 404;
        res.end('{"error":"Not found"}');
      }
      
    } catch (e) {
      this.logger.error(`Request error: ${e.message}`);
      res.statusCode = 500;
      res.end(`{"error":"Internal server error"}`);
    }
    
    // Log request
    const duration = Date.now() - startTime;
    this.logger.debug(`${req.method} ${url.pathname} ${res.statusCode} ${duration}ms`);
    
    global.globalProfiler?.end('api.request');
    global.globalProfiler?.mark('api.requests.total');
    if (duration > 100) {
      global.globalProfiler?.mark('api.requests.slow');
    }
  }

  async handlePOST(pathname, body, res) {
    try {
      const data = JSON.parse(body);
      
      switch (pathname) {
        case '/api/dex/swap':
          if (!global.dex) throw new Error('DEX not enabled');
          
          // Check DEX transaction limit
          const dexCheck = this.rateLimiter.checkDEXTransaction(data.recipient || 'anonymous', data.amountIn);
          if (!dexCheck.allowed) {
            res.statusCode = 429;
            res.end(JSON.stringify({ 
              error: 'Transaction limit exceeded',
              reason: dexCheck.reason,
              cooldown: dexCheck.cooldownRemaining
            }));
            return true;
          }
          
          const swapResult = global.dex.swap(
            data.poolId,
            data.tokenIn,
            data.amountIn,
            data.minAmountOut || 0,
            data.recipient
          );
          
          this.sendJSON(res, {
            success: true,
            amountOut: swapResult.toString(),
            timestamp: Date.now()
          });
          return true;
          
        case '/api/dex/liquidity/add':
          if (!global.dex) throw new Error('DEX not enabled');
          
          const liquidity = global.dex.addLiquidity(
            data.poolId,
            data.amount0,
            data.amount1,
            data.provider,
            data.minLiquidity
          );
          
          this.sendJSON(res, {
            success: true,
            liquidity: liquidity.toString(),
            timestamp: Date.now()
          });
          return true;
          
        case '/api/dex/liquidity/remove':
          if (!global.dex) throw new Error('DEX not enabled');
          
          const amounts = global.dex.removeLiquidity(
            data.poolId,
            data.liquidity,
            data.provider,
            data.minAmount0,
            data.minAmount1
          );
          
          this.sendJSON(res, {
            success: true,
            amount0: amounts.amount0.toString(),
            amount1: amounts.amount1.toString(),
            timestamp: Date.now()
          });
          return true;
      }
      
      return false;
    } catch (e) {
      res.statusCode = 400;
      res.end(`{"error":"${e.message}"}`);
      return true;
    }
  }

  async getRequestBody(req) {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', chunk => body += chunk.toString());
      req.on('end', () => resolve(body));
    });
  }

  handleWSMessage(client, data) {
    try {
      const msg = JSON.parse(data.toString());
      
      switch (msg.type) {
        case 'subscribe':
          if (msg.channel) {
            client.subscriptions.add(msg.channel);
            this.sendToClient(client, {
              type: 'subscribed',
              channel: msg.channel
            });
          }
          break;
          
        case 'unsubscribe':
          if (msg.channel) {
            client.subscriptions.delete(msg.channel);
          }
          break;
          
        case 'auth':
          if (this.security.validateAPIKey(msg.apiKey)) {
            client.authenticated = true;
            this.sendToClient(client, { type: 'authenticated' });
          } else {
            this.sendToClient(client, { type: 'auth_failed' });
          }
          break;
      }
    } catch (e) {
      // Ignore parse errors
    }
  }

  sendToClient(client, data) {
    if (client.ws.readyState === 1) { // OPEN
      client.ws.send(JSON.stringify(data));
    }
  }

  broadcast(channel, data) {
    const payload = JSON.stringify({ channel, data });
    for (const client of this.wsClients) {
      if (client.subscriptions.has(channel)) {
        this.sendToClient(client, payload);
      }
    }
  }

  getCachedStats() {
    if (this.cache.has('stats') && (Date.now() - this.cache.get('stats').timestamp < 5000)) {
      return this.cache.get('stats').data;
    }
    
    const stats = {
      poolHashrate: this.calculatePoolHashrate(),
      miners: global.stratum?.getStats().miners || 0,
      workers: global.stratum?.getStats().workers?.length || 0,
      totalTVL: this.calculateTotalTVL(),
      volume24h: this.calculate24hVolume(),
      timestamp: Date.now()
    };
    
    this.cache.set('stats', { data: stats, timestamp: Date.now() });
    return stats;
  }

  calculatePoolHashrate() {
    // Sum hashrates from all stratum servers
    return global.stratum?.getStats().workers?.reduce((sum, w) => sum + w.hashrate, 0) || 0;
  }

  calculateTotalTVL() {
    return global.dex?.getAllPools().reduce((sum, p) => sum + p.tvl, 0) || 0;
  }

  calculate24hVolume() {
    // Simplified - would need better historical data
    return global.dex?.getAllPools().reduce((sum, p) => sum + Number(p.volume24h), 0) || 0;
  }

  getInfo() {
    return {
      product: PRODUCT.name,
      version: PRODUCT.version,
      uptime: Date.now() - global.startTime,
      memory: process.memoryUsage(),
      config: {
        mining: this.config.get('mining'),
        dex: this.config.get('dex'),
        p2p: this.config.get('p2p')
      }
    };
  }

  getHealth() {
    return {
      status: 'ok',
      timestamp: Date.now(),
      dependencies: {
        database: global.db?.getStatus() || 'disconnected',
        rpc: 'ok' // TODO: Add RPC health check
      }
    };
  }

  getMiners() {
    return global.stratum?.getStats().workers || [];
  }

  startMetricsServer() {
    const metricsServer = createServer((req, res) => {
      if (req.url === '/metrics') {
        res.setHeader('Content-Type', 'text/plain');
        res.end(this.generateMetrics());
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    metricsServer.listen(this.config.monitoring.metricsPort, () => {
      this.logger.info(`Metrics server listening on port ${this.config.monitoring.metricsPort}`);
    });
  }

  generateMetrics() {
    const stats = this.getCachedStats();
    const lines = [
      '# HELP otedama_pool_hashrate_total Total pool hashrate',
      '# TYPE otedama_pool_hashrate_total gauge',
      `otedama_pool_hashrate_total ${stats.poolHashrate}`,
      
      '# HELP otedama_miners_connected_total Number of connected miners',
      '# TYPE otedama_miners_connected_total gauge',
      `otedama_miners_connected_total ${stats.miners}`,
      
      '# HELP otedama_dex_tvl_total Total value locked in DEX pools',
      '# TYPE otedama_dex_tvl_total gauge',
      `otedama_dex_tvl_total ${stats.totalTVL}`
    ];
    return lines.join('\n');
  }

  cleanupCache() {
    const now = Date.now();
    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp > 300000) { // 5 min expiry
        this.cache.delete(key);
      }
    }
  }

  sendJSON(res, data) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data, (key, value) => 
      typeof value === 'bigint' ? value.toString() : value
    ));
  }

  sendDashboard(res) {
    // Basic HTML dashboard
    res.setHeader('Content-Type', 'text/html');
    res.end(`
      <!DOCTYPE html>
      <html>
      <head><title>Otedama Status</title></head>
      <body>
        <h1>Otedama v${PRODUCT.version}</h1>
        <pre id="stats"></pre>
        <script>
          const ws = new WebSocket(window.location.href.replace('http', 'ws'));
          ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', channel: 'stats' }));
          ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.channel === 'stats') {
              document.getElementById('stats').textContent = JSON.stringify(data.data, null, 2);
            }
          };
        </script>
      </body>
      </html>
    `);
  }

  async stop() {
    if (this.ws) {
      for (const client of this.wsClients) {
        client.ws.close();
      }
    }
    if (this.server) {
      await new Promise(resolve => this.server.close(resolve));
    }
    if (this.rateLimiter) {
      this.rateLimiter.stop();
    }
  }
}
