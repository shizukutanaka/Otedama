const tls = require('tls');
const https = require('https');
const { EventEmitter } = require('events');
const MTLSImplementation = require('./mtls-implementation');

class MTLSClient extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Client identification
      clientId: config.clientId || 'otedama-client',
      
      // Connection settings
      reconnect: config.reconnect !== false,
      reconnectDelay: config.reconnectDelay || 5000,
      reconnectMaxDelay: config.reconnectMaxDelay || 60000,
      reconnectAttempts: config.reconnectAttempts || Infinity,
      connectionTimeout: config.connectionTimeout || 30000,
      
      // Keep alive
      keepAlive: config.keepAlive !== false,
      keepAliveDelay: config.keepAliveDelay || 30000,
      
      // Protocol options
      protocols: config.protocols || ['h2', 'http/1.1'],
      preferHttp2: config.preferHttp2 !== false,
      
      // Request options
      requestTimeout: config.requestTimeout || 30000,
      maxRedirects: config.maxRedirects || 5,
      
      // Connection pooling
      enablePool: config.enablePool !== false,
      maxSockets: config.maxSockets || 10,
      maxFreeSockets: config.maxFreeSockets || 5,
      socketTimeout: config.socketTimeout || 300000, // 5 minutes
      
      // Monitoring
      enableMetrics: config.enableMetrics !== false,
      metricsInterval: config.metricsInterval || 60000,
      
      // mTLS configuration
      mtlsConfig: config.mtlsConfig || {}
    };
    
    this.mtls = new MTLSImplementation(this.config.mtlsConfig);
    this.connections = new Map();
    this.connectionPool = new Map();
    this.pendingRequests = new Map();
    this.metrics = {
      connectionsTotal: 0,
      connectionsActive: 0,
      requestsTotal: 0,
      requestsSuccess: 0,
      requestsFailed: 0,
      bytesReceived: 0,
      bytesSent: 0,
      connectionTime: [],
      requestTime: []
    };
    
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.metricsTimer = null;
  }
  
  async initialize() {
    await this.mtls.initialize();
    
    if (this.config.enableMetrics) {
      this.startMetricsCollection();
    }
    
    this.emit('initialized');
  }
  
  async connect(host, port, options = {}) {
    const startTime = Date.now();
    const connectionId = this.generateConnectionId();
    
    try {
      const tlsOptions = {
        ...this.mtls.getClientOptions(this.config.clientId),
        host,
        port,
        ALPNProtocols: this.config.protocols,
        servername: options.servername || host,
        timeout: this.config.connectionTimeout
      };
      
      const socket = await new Promise((resolve, reject) => {
        const client = tls.connect(tlsOptions, () => {
          if (!client.authorized) {
            reject(new Error(`Server certificate verification failed: ${client.authorizationError}`));
            return;
          }
          resolve(client);
        });
        
        client.on('error', reject);
        
        // Timeout handling
        const timeout = setTimeout(() => {
          client.destroy();
          reject(new Error('Connection timeout'));
        }, this.config.connectionTimeout);
        
        client.on('connect', () => clearTimeout(timeout));
      });
      
      // Track connection
      const connection = {
        id: connectionId,
        host,
        port,
        socket,
        protocol: socket.alpnProtocol,
        authorized: socket.authorized,
        peerCertificate: socket.getPeerCertificate(),
        connectedAt: new Date(),
        lastActivity: new Date(),
        bytesReceived: 0,
        bytesSent: 0,
        requests: 0
      };
      
      this.connections.set(connectionId, connection);
      this.metrics.connectionsTotal++;
      this.metrics.connectionsActive++;
      
      // Setup socket handlers
      socket.on('data', (data) => this.handleData(connectionId, data));
      socket.on('error', (error) => this.handleError(connectionId, error));
      socket.on('close', () => this.handleClose(connectionId));
      
      // Keep alive
      if (this.config.keepAlive) {
        socket.setKeepAlive(true, this.config.keepAliveDelay);
      }
      
      // Record connection time
      const connectionTime = Date.now() - startTime;
      this.metrics.connectionTime.push(connectionTime);
      if (this.metrics.connectionTime.length > 1000) {
        this.metrics.connectionTime.shift();
      }
      
      this.emit('connected', {
        connectionId,
        host,
        port,
        protocol: socket.alpnProtocol,
        connectionTime
      });
      
      // Reset reconnect attempts
      this.reconnectAttempt = 0;
      
      // Add to connection pool if enabled
      if (this.config.enablePool) {
        const poolKey = `${host}:${port}`;
        let pool = this.connectionPool.get(poolKey);
        if (!pool) {
          pool = [];
          this.connectionPool.set(poolKey, pool);
        }
        pool.push(connection);
      }
      
      return connection;
      
    } catch (error) {
      this.metrics.connectionsTotal++;
      this.emit('connection_error', { host, port, error });
      
      // Handle reconnection
      if (this.config.reconnect && this.reconnectAttempt < this.config.reconnectAttempts) {
        await this.scheduleReconnect(host, port, options);
      }
      
      throw error;
    }
  }
  
  async scheduleReconnect(host, port, options) {
    this.reconnectAttempt++;
    const delay = Math.min(
      this.config.reconnectDelay * Math.pow(2, this.reconnectAttempt - 1),
      this.config.reconnectMaxDelay
    );
    
    this.emit('reconnecting', {
      host,
      port,
      attempt: this.reconnectAttempt,
      delay
    });
    
    await new Promise(resolve => setTimeout(resolve, delay));
    
    try {
      await this.connect(host, port, options);
    } catch (error) {
      // Reconnection failed, will be retried if attempts remaining
    }
  }
  
  async request(url, options = {}) {
    const startTime = Date.now();
    this.metrics.requestsTotal++;
    
    try {
      const parsedUrl = new URL(url);
      const requestOptions = {
        ...this.mtls.getClientOptions(this.config.clientId),
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || 'GET',
        headers: {
          'Host': parsedUrl.hostname,
          'User-Agent': 'Otedama-mTLS-Client/1.0',
          ...options.headers
        },
        timeout: this.config.requestTimeout,
        ALPNProtocols: this.config.protocols
      };
      
      // Use connection pool if available
      const poolKey = `${parsedUrl.hostname}:${parsedUrl.port || 443}`;
      const pooledConnection = this.getPooledConnection(poolKey);
      
      if (pooledConnection) {
        requestOptions.socket = pooledConnection.socket;
        requestOptions.createConnection = () => pooledConnection.socket;
      }
      
      const response = await new Promise((resolve, reject) => {
        const req = https.request(requestOptions, (res) => {
          let data = '';
          
          res.on('data', (chunk) => {
            data += chunk;
            if (pooledConnection) {
              pooledConnection.bytesReceived += chunk.length;
            }
            this.metrics.bytesReceived += chunk.length;
          });
          
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode,
              headers: res.headers,
              data,
              protocol: res.socket.alpnProtocol
            });
          });
        });
        
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Request timeout'));
        });
        
        if (options.body) {
          const body = typeof options.body === 'string' 
            ? options.body 
            : JSON.stringify(options.body);
          req.write(body);
          
          if (pooledConnection) {
            pooledConnection.bytesSent += Buffer.byteLength(body);
          }
          this.metrics.bytesSent += Buffer.byteLength(body);
        }
        
        req.end();
      });
      
      // Update connection activity
      if (pooledConnection) {
        pooledConnection.lastActivity = new Date();
        pooledConnection.requests++;
      }
      
      // Record request time
      const requestTime = Date.now() - startTime;
      this.metrics.requestTime.push(requestTime);
      if (this.metrics.requestTime.length > 1000) {
        this.metrics.requestTime.shift();
      }
      
      this.metrics.requestsSuccess++;
      
      this.emit('response', {
        url,
        statusCode: response.statusCode,
        protocol: response.protocol,
        requestTime
      });
      
      return response;
      
    } catch (error) {
      this.metrics.requestsFailed++;
      this.emit('request_error', { url, error });
      throw error;
    }
  }
  
  getPooledConnection(poolKey) {
    const pool = this.connectionPool.get(poolKey);
    if (!pool || pool.length === 0) return null;
    
    // Find an available connection
    const now = Date.now();
    for (let i = 0; i < pool.length; i++) {
      const conn = pool[i];
      if (conn.socket.destroyed || conn.socket.readyState !== 'open') {
        // Remove dead connection
        pool.splice(i, 1);
        i--;
        continue;
      }
      
      // Check if connection is idle
      const idleTime = now - conn.lastActivity.getTime();
      if (idleTime < this.config.socketTimeout) {
        return conn;
      }
    }
    
    return null;
  }
  
  createRawConnection(host, port, options = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        const connection = await this.connect(host, port, options);
        const socket = connection.socket;
        
        // Remove default handlers
        socket.removeAllListeners('data');
        socket.removeAllListeners('error');
        socket.removeAllListeners('close');
        
        resolve({
          socket,
          connection,
          send: (data) => {
            socket.write(data);
            connection.bytesSent += data.length;
            this.metrics.bytesSent += data.length;
          },
          close: () => {
            socket.end();
          },
          destroy: () => {
            socket.destroy();
          }
        });
        
      } catch (error) {
        reject(error);
      }
    });
  }
  
  handleData(connectionId, data) {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    
    connection.lastActivity = new Date();
    connection.bytesReceived += data.length;
    this.metrics.bytesReceived += data.length;
    
    this.emit('data', { connectionId, data });
  }
  
  handleError(connectionId, error) {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    
    this.emit('connection_error', { connectionId, error });
    
    // Remove from pool
    if (this.config.enablePool) {
      const poolKey = `${connection.host}:${connection.port}`;
      const pool = this.connectionPool.get(poolKey);
      if (pool) {
        const index = pool.indexOf(connection);
        if (index > -1) {
          pool.splice(index, 1);
        }
      }
    }
  }
  
  handleClose(connectionId) {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    
    this.connections.delete(connectionId);
    this.metrics.connectionsActive--;
    
    // Remove from pool
    if (this.config.enablePool) {
      const poolKey = `${connection.host}:${connection.port}`;
      const pool = this.connectionPool.get(poolKey);
      if (pool) {
        const index = pool.indexOf(connection);
        if (index > -1) {
          pool.splice(index, 1);
        }
      }
    }
    
    this.emit('disconnected', { connectionId });
  }
  
  generateConnectionId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
  
  startMetricsCollection() {
    this.metricsTimer = setInterval(() => {
      const metrics = this.getMetrics();
      this.emit('metrics', metrics);
      
      // Cleanup idle connections
      this.cleanupIdleConnections();
    }, this.config.metricsInterval);
  }
  
  cleanupIdleConnections() {
    const now = Date.now();
    
    for (const [poolKey, pool] of this.connectionPool) {
      for (let i = pool.length - 1; i >= 0; i--) {
        const conn = pool[i];
        const idleTime = now - conn.lastActivity.getTime();
        
        if (idleTime > this.config.socketTimeout || 
            conn.socket.destroyed || 
            conn.socket.readyState !== 'open') {
          // Close and remove idle connection
          conn.socket.destroy();
          pool.splice(i, 1);
          this.connections.delete(conn.id);
          this.metrics.connectionsActive--;
        }
      }
      
      // Remove empty pools
      if (pool.length === 0) {
        this.connectionPool.delete(poolKey);
      }
    }
  }
  
  getMetrics() {
    const avgConnectionTime = this.metrics.connectionTime.length > 0
      ? this.metrics.connectionTime.reduce((a, b) => a + b, 0) / this.metrics.connectionTime.length
      : 0;
    
    const avgRequestTime = this.metrics.requestTime.length > 0
      ? this.metrics.requestTime.reduce((a, b) => a + b, 0) / this.metrics.requestTime.length
      : 0;
    
    return {
      ...this.metrics,
      avgConnectionTime,
      avgRequestTime,
      connectionPools: Array.from(this.connectionPool.entries()).map(([key, pool]) => ({
        endpoint: key,
        connections: pool.length,
        active: pool.filter(c => !c.socket.destroyed).length
      })),
      activeConnections: Array.from(this.connections.values()).map(conn => ({
        id: conn.id,
        host: conn.host,
        port: conn.port,
        protocol: conn.protocol,
        connectedAt: conn.connectedAt,
        requests: conn.requests,
        bytesReceived: conn.bytesReceived,
        bytesSent: conn.bytesSent
      })),
      timestamp: new Date()
    };
  }
  
  closeConnection(connectionId) {
    const connection = this.connections.get(connectionId);
    if (connection) {
      connection.socket.destroy();
    }
  }
  
  closeAllConnections() {
    for (const connection of this.connections.values()) {
      connection.socket.destroy();
    }
    
    this.connections.clear();
    this.connectionPool.clear();
  }
  
  async destroy() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }
    
    this.closeAllConnections();
    
    await this.mtls.destroy();
    
    this.emit('destroyed');
  }
}

module.exports = MTLSClient;