const tls = require('tls');
const net = require('net');
const https = require('https');
const { EventEmitter } = require('events');
const MTLSImplementation = require('./mtls-implementation');

class MTLSServer extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      port: config.port || 8443,
      host: config.host || '0.0.0.0',
      
      // Connection handling
      maxConnections: config.maxConnections || 1000,
      connectionTimeout: config.connectionTimeout || 300000, // 5 minutes
      keepAliveTimeout: config.keepAliveTimeout || 120000, // 2 minutes
      
      // Rate limiting
      enableRateLimit: config.enableRateLimit !== false,
      rateLimit: config.rateLimit || {
        windowMs: 60000, // 1 minute
        maxRequests: 100,
        maxConnections: 10
      },
      
      // Protocol support
      protocols: config.protocols || ['h2', 'http/1.1'],
      allowHTTP1: config.allowHTTP1 !== false,
      
      // Security headers
      securityHeaders: config.securityHeaders || {
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'X-XSS-Protection': '1; mode=block',
        'Content-Security-Policy': "default-src 'self'"
      },
      
      // Monitoring
      enableMetrics: config.enableMetrics !== false,
      metricsInterval: config.metricsInterval || 60000,
      
      // mTLS configuration
      mtlsConfig: config.mtlsConfig || {}
    };
    
    this.mtls = new MTLSImplementation(this.config.mtlsConfig);
    this.server = null;
    this.connections = new Map();
    this.connectionLimits = new Map();
    this.metrics = {
      connectionsTotal: 0,
      connectionsActive: 0,
      requestsTotal: 0,
      requestsSuccess: 0,
      requestsFailed: 0,
      bytesReceived: 0,
      bytesSent: 0,
      handshakeTime: [],
      requestTime: []
    };
    
    this.setupMTLSHandlers();
  }
  
  setupMTLSHandlers() {
    this.mtls.on('error', (error) => {
      this.emit('error', error);
    });
    
    this.mtls.on('certificate_issued', (data) => {
      this.emit('certificate_issued', data);
    });
    
    this.mtls.on('certificate_revoked', (data) => {
      // Disconnect clients using revoked certificate
      for (const [socket, conn] of this.connections) {
        if (conn.fingerprint === data.fingerprint) {
          socket.destroy();
        }
      }
    });
    
    this.mtls.on('metrics', (metrics) => {
      this.emit('mtls_metrics', metrics);
    });
  }
  
  async start() {
    await this.mtls.initialize();
    
    const tlsOptions = {
      ...this.mtls.getServerOptions(),
      ALPNProtocols: this.config.protocols,
      allowHTTP1: this.config.allowHTTP1
    };
    
    // Create TLS server
    this.server = tls.createServer(tlsOptions);
    
    // Setup event handlers
    this.server.on('secureConnection', this.handleConnection.bind(this));
    this.server.on('error', this.handleServerError.bind(this));
    this.server.on('close', this.handleServerClose.bind(this));
    
    // Start listening
    await new Promise((resolve, reject) => {
      this.server.listen(this.config.port, this.config.host, () => {
        console.log(`mTLS server listening on ${this.config.host}:${this.config.port}`);
        this.emit('listening', { host: this.config.host, port: this.config.port });
        resolve();
      });
      
      this.server.once('error', reject);
    });
    
    // Start metrics collection
    if (this.config.enableMetrics) {
      this.startMetricsCollection();
    }
  }
  
  async handleConnection(socket) {
    const startTime = Date.now();
    this.metrics.connectionsTotal++;
    this.metrics.connectionsActive++;
    
    try {
      // Verify client certificate
      const verification = await this.mtls.verifyClientCertificate(socket);
      
      if (!verification.valid) {
        console.error('Client certificate verification failed:', verification.reason);
        socket.destroy();
        return;
      }
      
      const cert = verification.certificate;
      const clientId = cert.subject.CN || cert.fingerprint256;
      
      // Check rate limits
      if (this.config.enableRateLimit && !this.checkRateLimit(clientId)) {
        socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
        socket.destroy();
        return;
      }
      
      // Track connection
      const connection = {
        id: this.generateConnectionId(),
        clientId,
        fingerprint: cert.fingerprint256,
        remoteAddress: socket.remoteAddress,
        remotePort: socket.remotePort,
        protocol: socket.alpnProtocol,
        connectedAt: new Date(),
        lastActivity: new Date(),
        bytesReceived: 0,
        bytesSent: 0
      };
      
      this.connections.set(socket, connection);
      
      // Set socket options
      socket.setKeepAlive(true, this.config.keepAliveTimeout);
      socket.setTimeout(this.config.connectionTimeout);
      
      // Handle socket events
      socket.on('data', (data) => this.handleData(socket, data));
      socket.on('error', (error) => this.handleSocketError(socket, error));
      socket.on('close', () => this.handleSocketClose(socket));
      socket.on('timeout', () => this.handleSocketTimeout(socket));
      
      // Record handshake time
      const handshakeTime = Date.now() - startTime;
      this.metrics.handshakeTime.push(handshakeTime);
      if (this.metrics.handshakeTime.length > 1000) {
        this.metrics.handshakeTime.shift();
      }
      
      this.emit('connection', {
        ...connection,
        handshakeTime
      });
      
    } catch (error) {
      console.error('Connection handling error:', error);
      socket.destroy();
      this.metrics.connectionsActive--;
    }
  }
  
  handleData(socket, data) {
    const connection = this.connections.get(socket);
    if (!connection) return;
    
    connection.lastActivity = new Date();
    connection.bytesReceived += data.length;
    this.metrics.bytesReceived += data.length;
    
    // Update mTLS session activity
    this.mtls.updateSessionActivity(connection.fingerprint);
    
    // Parse HTTP request (simplified)
    if (data.toString().startsWith('GET') || 
        data.toString().startsWith('POST') ||
        data.toString().startsWith('PUT') ||
        data.toString().startsWith('DELETE')) {
      this.handleHTTPRequest(socket, data);
    } else {
      // Handle raw TLS data
      this.emit('data', { connection, data });
    }
  }
  
  handleHTTPRequest(socket, data) {
    const startTime = Date.now();
    this.metrics.requestsTotal++;
    
    try {
      const request = this.parseHTTPRequest(data.toString());
      const connection = this.connections.get(socket);
      
      // Add security headers
      const headers = {
        ...this.config.securityHeaders,
        'Date': new Date().toUTCString(),
        'Server': 'Otedama-mTLS/1.0'
      };
      
      // Simple response for health check
      if (request.path === '/health') {
        const response = this.buildHTTPResponse(200, headers, JSON.stringify({
          status: 'ok',
          server: 'mtls',
          clientId: connection.clientId,
          protocol: connection.protocol
        }));
        
        socket.write(response);
        connection.bytesSent += response.length;
        this.metrics.bytesSent += response.length;
        this.metrics.requestsSuccess++;
      } else {
        // Emit request for handling by application
        this.emit('request', {
          connection,
          request,
          respond: (status, body, customHeaders = {}) => {
            const response = this.buildHTTPResponse(status, {
              ...headers,
              ...customHeaders
            }, body);
            
            socket.write(response);
            connection.bytesSent += response.length;
            this.metrics.bytesSent += response.length;
            this.metrics.requestsSuccess++;
          }
        });
      }
      
      // Record request time
      const requestTime = Date.now() - startTime;
      this.metrics.requestTime.push(requestTime);
      if (this.metrics.requestTime.length > 1000) {
        this.metrics.requestTime.shift();
      }
      
    } catch (error) {
      console.error('HTTP request handling error:', error);
      this.metrics.requestsFailed++;
      
      const response = this.buildHTTPResponse(500, this.config.securityHeaders, 
        'Internal Server Error');
      socket.write(response);
    }
  }
  
  parseHTTPRequest(data) {
    const lines = data.split('\r\n');
    const [method, path, version] = lines[0].split(' ');
    
    const headers = {};
    let i = 1;
    while (i < lines.length && lines[i] !== '') {
      const [key, value] = lines[i].split(': ');
      headers[key.toLowerCase()] = value;
      i++;
    }
    
    const body = lines.slice(i + 1).join('\r\n');
    
    return { method, path, version, headers, body };
  }
  
  buildHTTPResponse(status, headers, body = '') {
    const statusTexts = {
      200: 'OK',
      400: 'Bad Request',
      401: 'Unauthorized',
      403: 'Forbidden',
      404: 'Not Found',
      429: 'Too Many Requests',
      500: 'Internal Server Error'
    };
    
    let response = `HTTP/1.1 ${status} ${statusTexts[status] || 'Unknown'}\r\n`;
    
    headers['Content-Length'] = Buffer.byteLength(body);
    if (body && !headers['Content-Type']) {
      headers['Content-Type'] = 'text/plain';
    }
    
    for (const [key, value] of Object.entries(headers)) {
      response += `${key}: ${value}\r\n`;
    }
    
    response += '\r\n';
    if (body) {
      response += body;
    }
    
    return response;
  }
  
  checkRateLimit(clientId) {
    const now = Date.now();
    const limit = this.connectionLimits.get(clientId) || {
      requests: [],
      connections: 0,
      lastCleanup: now
    };
    
    // Cleanup old entries
    if (now - limit.lastCleanup > this.config.rateLimit.windowMs) {
      limit.requests = limit.requests.filter(time => 
        now - time < this.config.rateLimit.windowMs
      );
      limit.lastCleanup = now;
    }
    
    // Check request limit
    if (limit.requests.length >= this.config.rateLimit.maxRequests) {
      return false;
    }
    
    // Check connection limit
    if (limit.connections >= this.config.rateLimit.maxConnections) {
      return false;
    }
    
    // Update limits
    limit.requests.push(now);
    limit.connections++;
    this.connectionLimits.set(clientId, limit);
    
    return true;
  }
  
  handleSocketError(socket, error) {
    const connection = this.connections.get(socket);
    if (connection) {
      this.emit('connection_error', { connection, error });
    }
  }
  
  handleSocketClose(socket) {
    const connection = this.connections.get(socket);
    if (connection) {
      // Update connection limit
      const limit = this.connectionLimits.get(connection.clientId);
      if (limit) {
        limit.connections = Math.max(0, limit.connections - 1);
      }
      
      this.connections.delete(socket);
      this.metrics.connectionsActive--;
      
      this.emit('connection_closed', connection);
    }
  }
  
  handleSocketTimeout(socket) {
    const connection = this.connections.get(socket);
    if (connection) {
      this.emit('connection_timeout', connection);
    }
    socket.destroy();
  }
  
  handleServerError(error) {
    console.error('Server error:', error);
    this.emit('error', error);
  }
  
  handleServerClose() {
    console.log('Server closed');
    this.emit('close');
  }
  
  generateConnectionId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
  
  createHTTPSServer(requestHandler) {
    const options = {
      ...this.mtls.getServerOptions(),
      ALPNProtocols: this.config.protocols,
      allowHTTP1: this.config.allowHTTP1
    };
    
    const server = https.createServer(options, async (req, res) => {
      // Verify client certificate
      const socket = req.socket;
      const verification = await this.mtls.verifyClientCertificate(socket);
      
      if (!verification.valid) {
        res.statusCode = 401;
        res.end('Unauthorized: Invalid client certificate');
        return;
      }
      
      // Add certificate info to request
      req.clientCertificate = verification.certificate;
      req.clientId = verification.certificate.subject.CN || 
                     verification.certificate.fingerprint256;
      
      // Add security headers
      Object.entries(this.config.securityHeaders).forEach(([key, value]) => {
        res.setHeader(key, value);
      });
      
      // Call request handler
      requestHandler(req, res);
    });
    
    return server;
  }
  
  startMetricsCollection() {
    this.metricsTimer = setInterval(() => {
      const metrics = this.getMetrics();
      this.emit('metrics', metrics);
    }, this.config.metricsInterval);
  }
  
  getMetrics() {
    const avgHandshakeTime = this.metrics.handshakeTime.length > 0
      ? this.metrics.handshakeTime.reduce((a, b) => a + b, 0) / this.metrics.handshakeTime.length
      : 0;
    
    const avgRequestTime = this.metrics.requestTime.length > 0
      ? this.metrics.requestTime.reduce((a, b) => a + b, 0) / this.metrics.requestTime.length
      : 0;
    
    return {
      ...this.metrics,
      avgHandshakeTime,
      avgRequestTime,
      activeConnections: Array.from(this.connections.values()).map(conn => ({
        clientId: conn.clientId,
        remoteAddress: conn.remoteAddress,
        protocol: conn.protocol,
        connectedAt: conn.connectedAt,
        bytesReceived: conn.bytesReceived,
        bytesSent: conn.bytesSent
      })),
      rateLimits: Array.from(this.connectionLimits.entries()).map(([clientId, limit]) => ({
        clientId,
        requests: limit.requests.length,
        connections: limit.connections
      })),
      timestamp: new Date()
    };
  }
  
  async issueClientCertificate(clientId, metadata) {
    return await this.mtls.issueClientCertificate(clientId, metadata);
  }
  
  async revokeCertificate(fingerprint, reason) {
    await this.mtls.revokeCertificate(fingerprint, reason);
    
    // Disconnect affected connections
    for (const [socket, connection] of this.connections) {
      if (connection.fingerprint === fingerprint) {
        socket.destroy();
      }
    }
  }
  
  getActiveSessions() {
    return this.mtls.getActiveSessions();
  }
  
  async stop() {
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }
    
    // Close all connections
    for (const [socket, connection] of this.connections) {
      socket.destroy();
    }
    
    this.connections.clear();
    this.connectionLimits.clear();
    
    // Close server
    if (this.server) {
      await new Promise((resolve) => {
        this.server.close(resolve);
      });
    }
    
    // Cleanup mTLS
    await this.mtls.destroy();
    
    this.emit('stopped');
  }
}

module.exports = MTLSServer;