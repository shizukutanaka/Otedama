/**
 * Service Mesh Control Plane for Otedama
 * Centralized management for service mesh
 * 
 * Design principles:
 * - Carmack: Efficient service coordination
 * - Martin: Clean control plane architecture
 * - Pike: Simple mesh management
 */

import { EventEmitter } from 'events';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { logger } from '../core/logger.js';

/**
 * Service mesh configuration
 */
export class MeshConfig {
  constructor(config = {}) {
    this.version = config.version || '1.0.0';
    this.services = new Map();
    this.policies = new Map();
    this.routes = new Map();
    this.certificates = new Map();
  }
  
  addService(service) {
    this.services.set(service.name, {
      ...service,
      version: service.version || '1.0.0',
      endpoints: service.endpoints || [],
      metadata: service.metadata || {}
    });
  }
  
  addPolicy(policy) {
    this.policies.set(policy.name, {
      ...policy,
      type: policy.type || 'traffic',
      rules: policy.rules || []
    });
  }
  
  addRoute(route) {
    this.routes.set(route.name, {
      ...route,
      match: route.match || {},
      destination: route.destination || {}
    });
  }
  
  toJSON() {
    return {
      version: this.version,
      services: Array.from(this.services.values()),
      policies: Array.from(this.policies.values()),
      routes: Array.from(this.routes.values()),
      certificates: Array.from(this.certificates.values())
    };
  }
}

/**
 * Service mesh control plane
 */
export class ServiceMeshControlPlane extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      port: options.port || 15010,
      grpcPort: options.grpcPort || 15011,
      
      // Service registry
      serviceRegistry: options.serviceRegistry,
      
      // Configuration
      configStore: options.configStore,
      syncInterval: options.syncInterval || 30000,
      
      // Security
      mtls: {
        enabled: options.mtls?.enabled || true,
        ca: options.mtls?.ca,
        cert: options.mtls?.cert,
        key: options.mtls?.key
      },
      
      // Telemetry
      telemetry: {
        enabled: options.telemetry?.enabled !== false,
        metricsPort: options.telemetry?.metricsPort || 15014,
        tracingPort: options.telemetry?.tracingPort || 15015
      },
      
      ...options
    };
    
    // State
    this.config = new MeshConfig();
    this.proxies = new Map(); // Connected sidecar proxies
    this.services = new Map();
    this.endpoints = new Map();
    
    // Servers
    this.httpServer = null;
    this.wsServer = null;
    
    // Metrics
    this.metrics = {
      proxiesConnected: 0,
      configPushes: 0,
      servicesRegistered: 0,
      policiesApplied: 0
    };
  }
  
  /**
   * Start control plane
   */
  async start() {
    // Load initial configuration
    await this._loadConfiguration();
    
    // Start HTTP server
    this.httpServer = createServer((req, res) => {
      this._handleHttpRequest(req, res);
    });
    
    // Start WebSocket server for proxy connections
    this.wsServer = new WebSocketServer({
      server: this.httpServer,
      path: '/v1/xds'
    });
    
    this.wsServer.on('connection', (ws, req) => {
      this._handleProxyConnection(ws, req);
    });
    
    // Start configuration sync
    this._startConfigSync();
    
    // Start telemetry collection
    if (this.options.telemetry.enabled) {
      await this._startTelemetry();
    }
    
    // Listen
    await new Promise(resolve => {
      this.httpServer.listen(this.options.port, () => {
        logger.info(`Service mesh control plane listening on port ${this.options.port}`);
        resolve();
      });
    });
    
    this.emit('started');
  }
  
  /**
   * Stop control plane
   */
  async stop() {
    // Stop config sync
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
    }
    
    // Close proxy connections
    for (const [proxyId, proxy] of this.proxies) {
      proxy.ws.close();
    }
    
    // Stop servers
    if (this.wsServer) {
      await new Promise(resolve => this.wsServer.close(resolve));
    }
    
    if (this.httpServer) {
      await new Promise(resolve => this.httpServer.close(resolve));
    }
    
    this.emit('stopped');
  }
  
  /**
   * Handle HTTP requests
   */
  _handleHttpRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    res.setHeader('Content-Type', 'application/json');
    
    // API routes
    if (req.method === 'GET') {
      switch (url.pathname) {
        case '/v1/config':
          this._handleGetConfig(req, res);
          break;
          
        case '/v1/services':
          this._handleGetServices(req, res);
          break;
          
        case '/v1/endpoints':
          this._handleGetEndpoints(req, res);
          break;
          
        case '/v1/policies':
          this._handleGetPolicies(req, res);
          break;
          
        case '/v1/routes':
          this._handleGetRoutes(req, res);
          break;
          
        case '/v1/metrics':
          this._handleGetMetrics(req, res);
          break;
          
        case '/health':
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'healthy' }));
          break;
          
        default:
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Not found' }));
      }
    } else if (req.method === 'POST') {
      switch (url.pathname) {
        case '/v1/services':
          this._handleCreateService(req, res);
          break;
          
        case '/v1/policies':
          this._handleCreatePolicy(req, res);
          break;
          
        case '/v1/routes':
          this._handleCreateRoute(req, res);
          break;
          
        default:
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Not found' }));
      }
    } else {
      res.writeHead(405);
      res.end(JSON.stringify({ error: 'Method not allowed' }));
    }
  }
  
  /**
   * Handle proxy connection
   */
  _handleProxyConnection(ws, req) {
    const proxyId = req.headers['x-proxy-id'] || this._generateProxyId();
    const nodeInfo = {
      id: proxyId,
      address: req.socket.remoteAddress,
      metadata: JSON.parse(req.headers['x-proxy-metadata'] || '{}')
    };
    
    logger.info(`Proxy connected: ${proxyId}`);
    
    // Register proxy
    this.proxies.set(proxyId, {
      ws,
      nodeInfo,
      connectedAt: Date.now(),
      lastHeartbeat: Date.now()
    });
    
    this.metrics.proxiesConnected++;
    
    // Send initial configuration
    this._pushConfiguration(proxyId);
    
    // Handle messages
    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        this._handleProxyMessage(proxyId, data);
      } catch (error) {
        logger.error('Invalid proxy message', error);
      }
    });
    
    // Handle disconnection
    ws.on('close', () => {
      logger.info(`Proxy disconnected: ${proxyId}`);
      this.proxies.delete(proxyId);
      this.metrics.proxiesConnected--;
    });
    
    ws.on('error', (error) => {
      logger.error(`Proxy error: ${proxyId}`, error);
    });
  }
  
  /**
   * Handle proxy message
   */
  _handleProxyMessage(proxyId, message) {
    const proxy = this.proxies.get(proxyId);
    if (!proxy) return;
    
    switch (message.type) {
      case 'heartbeat':
        proxy.lastHeartbeat = Date.now();
        break;
        
      case 'telemetry':
        this._processTelemetry(proxyId, message.data);
        break;
        
      case 'discovery':
        this._handleDiscoveryRequest(proxyId, message);
        break;
        
      case 'error':
        logger.error(`Proxy error from ${proxyId}:`, message.error);
        break;
        
      default:
        logger.warn(`Unknown message type from ${proxyId}: ${message.type}`);
    }
  }
  
  /**
   * Push configuration to proxy
   */
  _pushConfiguration(proxyId, config = null) {
    const proxy = this.proxies.get(proxyId);
    if (!proxy || proxy.ws.readyState !== 1) return;
    
    const configData = config || this.config.toJSON();
    
    proxy.ws.send(JSON.stringify({
      type: 'config',
      version: configData.version,
      data: configData
    }));
    
    this.metrics.configPushes++;
    
    logger.debug(`Configuration pushed to proxy ${proxyId}`);
  }
  
  /**
   * Broadcast configuration to all proxies
   */
  _broadcastConfiguration(config = null) {
    for (const [proxyId] of this.proxies) {
      this._pushConfiguration(proxyId, config);
    }
  }
  
  /**
   * Handle discovery request
   */
  _handleDiscoveryRequest(proxyId, request) {
    const proxy = this.proxies.get(proxyId);
    if (!proxy) return;
    
    let response;
    
    switch (request.resource) {
      case 'endpoints':
        response = {
          type: 'discovery',
          resource: 'endpoints',
          data: this._getEndpointsForService(request.service)
        };
        break;
        
      case 'clusters':
        response = {
          type: 'discovery',
          resource: 'clusters',
          data: this._getClusters()
        };
        break;
        
      case 'routes':
        response = {
          type: 'discovery',
          resource: 'routes',
          data: this._getRoutes()
        };
        break;
        
      default:
        response = {
          type: 'error',
          error: `Unknown resource: ${request.resource}`
        };
    }
    
    proxy.ws.send(JSON.stringify(response));
  }
  
  /**
   * Process telemetry data
   */
  _processTelemetry(proxyId, telemetry) {
    // Store metrics
    this.emit('telemetry', {
      proxyId,
      timestamp: Date.now(),
      metrics: telemetry.metrics,
      traces: telemetry.traces,
      logs: telemetry.logs
    });
  }
  
  /**
   * Load configuration
   */
  async _loadConfiguration() {
    if (!this.options.configStore) return;
    
    try {
      const config = await this.options.configStore.load();
      
      // Load services
      for (const service of config.services || []) {
        this.config.addService(service);
        this.services.set(service.name, service);
      }
      
      // Load policies
      for (const policy of config.policies || []) {
        this.config.addPolicy(policy);
      }
      
      // Load routes
      for (const route of config.routes || []) {
        this.config.addRoute(route);
      }
      
      logger.info('Configuration loaded', {
        services: config.services?.length || 0,
        policies: config.policies?.length || 0,
        routes: config.routes?.length || 0
      });
      
    } catch (error) {
      logger.error('Failed to load configuration', error);
    }
  }
  
  /**
   * Start configuration sync
   */
  _startConfigSync() {
    this.syncTimer = setInterval(async () => {
      // Sync with service registry
      if (this.options.serviceRegistry) {
        await this._syncServices();
      }
      
      // Check proxy health
      this._checkProxyHealth();
      
    }, this.options.syncInterval);
  }
  
  /**
   * Sync services with registry
   */
  async _syncServices() {
    try {
      const services = await this.options.serviceRegistry.listServices();
      let updated = false;
      
      for (const service of services) {
        const existing = this.services.get(service.name);
        
        if (!existing || JSON.stringify(existing) !== JSON.stringify(service)) {
          this.config.addService(service);
          this.services.set(service.name, service);
          updated = true;
          
          // Get endpoints
          const endpoints = await this.options.serviceRegistry.getEndpoints(service.name);
          this.endpoints.set(service.name, endpoints);
        }
      }
      
      if (updated) {
        this._broadcastConfiguration();
      }
      
    } catch (error) {
      logger.error('Service sync failed', error);
    }
  }
  
  /**
   * Check proxy health
   */
  _checkProxyHealth() {
    const now = Date.now();
    const timeout = 60000; // 1 minute
    
    for (const [proxyId, proxy] of this.proxies) {
      if (now - proxy.lastHeartbeat > timeout) {
        logger.warn(`Proxy ${proxyId} is unhealthy, disconnecting`);
        proxy.ws.close();
        this.proxies.delete(proxyId);
      }
    }
  }
  
  /**
   * Start telemetry collection
   */
  async _startTelemetry() {
    // Telemetry server for metrics
    const metricsServer = createServer((req, res) => {
      if (req.url === '/metrics') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(this._exportMetrics());
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });
    
    await new Promise(resolve => {
      metricsServer.listen(this.options.telemetry.metricsPort, () => {
        logger.info(`Metrics server listening on port ${this.options.telemetry.metricsPort}`);
        resolve();
      });
    });
  }
  
  /**
   * API handlers
   */
  _handleGetConfig(req, res) {
    res.writeHead(200);
    res.end(JSON.stringify(this.config.toJSON()));
  }
  
  _handleGetServices(req, res) {
    res.writeHead(200);
    res.end(JSON.stringify(Array.from(this.services.values())));
  }
  
  _handleGetEndpoints(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const service = url.searchParams.get('service');
    
    if (service) {
      const endpoints = this.endpoints.get(service) || [];
      res.writeHead(200);
      res.end(JSON.stringify(endpoints));
    } else {
      const all = {};
      for (const [name, endpoints] of this.endpoints) {
        all[name] = endpoints;
      }
      res.writeHead(200);
      res.end(JSON.stringify(all));
    }
  }
  
  _handleGetPolicies(req, res) {
    res.writeHead(200);
    res.end(JSON.stringify(Array.from(this.config.policies.values())));
  }
  
  _handleGetRoutes(req, res) {
    res.writeHead(200);
    res.end(JSON.stringify(Array.from(this.config.routes.values())));
  }
  
  _handleGetMetrics(req, res) {
    res.writeHead(200);
    res.end(JSON.stringify(this.metrics));
  }
  
  async _handleCreateService(req, res) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const service = JSON.parse(body);
        this.config.addService(service);
        this.services.set(service.name, service);
        this.metrics.servicesRegistered++;
        
        // Broadcast update
        this._broadcastConfiguration();
        
        res.writeHead(201);
        res.end(JSON.stringify({ success: true, service }));
      } catch (error) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: error.message }));
      }
    });
  }
  
  async _handleCreatePolicy(req, res) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const policy = JSON.parse(body);
        this.config.addPolicy(policy);
        this.metrics.policiesApplied++;
        
        // Broadcast update
        this._broadcastConfiguration();
        
        res.writeHead(201);
        res.end(JSON.stringify({ success: true, policy }));
      } catch (error) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: error.message }));
      }
    });
  }
  
  async _handleCreateRoute(req, res) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const route = JSON.parse(body);
        this.config.addRoute(route);
        
        // Broadcast update
        this._broadcastConfiguration();
        
        res.writeHead(201);
        res.end(JSON.stringify({ success: true, route }));
      } catch (error) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: error.message }));
      }
    });
  }
  
  /**
   * Utility methods
   */
  _generateProxyId() {
    return `proxy-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
  
  _getEndpointsForService(serviceName) {
    return this.endpoints.get(serviceName) || [];
  }
  
  _getClusters() {
    const clusters = [];
    
    for (const [name, service] of this.services) {
      clusters.push({
        name,
        type: service.type || 'STRICT_DNS',
        endpoints: this.endpoints.get(name) || [],
        loadBalancer: service.loadBalancer || 'ROUND_ROBIN',
        healthCheck: service.healthCheck || {
          path: '/health',
          interval: 10000,
          timeout: 5000
        }
      });
    }
    
    return clusters;
  }
  
  _getRoutes() {
    return Array.from(this.config.routes.values());
  }
  
  _exportMetrics() {
    const lines = [];
    
    lines.push('# HELP mesh_proxies_connected Number of connected proxies');
    lines.push('# TYPE mesh_proxies_connected gauge');
    lines.push(`mesh_proxies_connected ${this.metrics.proxiesConnected}`);
    
    lines.push('# HELP mesh_config_pushes_total Total configuration pushes');
    lines.push('# TYPE mesh_config_pushes_total counter');
    lines.push(`mesh_config_pushes_total ${this.metrics.configPushes}`);
    
    lines.push('# HELP mesh_services_registered Number of registered services');
    lines.push('# TYPE mesh_services_registered gauge');
    lines.push(`mesh_services_registered ${this.metrics.servicesRegistered}`);
    
    lines.push('# HELP mesh_policies_applied Number of applied policies');
    lines.push('# TYPE mesh_policies_applied gauge');
    lines.push(`mesh_policies_applied ${this.metrics.policiesApplied}`);
    
    return lines.join('\n');
  }
}

export default ServiceMeshControlPlane;