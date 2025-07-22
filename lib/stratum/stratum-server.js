import { EventEmitter } from 'events';
import net from 'net';
import crypto from 'crypto';
import { performance } from 'perf_hooks';

export class StratumServer extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      port: options.port || 3333,
      algorithm: options.algorithm || 'sha256',
      difficulty: options.difficulty || 1,
      vardiff: options.vardiff !== false,
      maxConnections: options.maxConnections || 10000,
      connectionTimeout: options.connectionTimeout || 300000, // 5 minutes
      shareValidationTimeout: options.shareValidationTimeout || 5000,
      ...options
    };

    this.server = null;
    this.clients = new Map();
    this.jobs = new Map();
    this.extraNonce1Counter = 0;
    
    this.stats = {
      connections: 0,
      activeConnections: 0,
      totalShares: 0,
      validShares: 0,
      invalidShares: 0,
      blocksFound: 0
    };

    this.messageQueue = new Map();
    this.shareBuffer = [];
    this.batchProcessing = true;
    
    this.initializeServer();
  }

  async initializeServer() {
    try {
      this.server = net.createServer({
        allowHalfOpen: false,
        pauseOnConnect: false
      });

      this.setupServerHandlers();
      this.startBatchProcessing();
      this.startCleanupTasks();
      
      console.log(`⚡ Stratum server for ${this.options.algorithm.toUpperCase()} ready on port ${this.options.port}`);
    } catch (error) {
      this.emit('serverError', { error: error.message, timestamp: Date.now() });
      throw error;
    }
  }

  setupServerHandlers() {
    this.server.on('connection', (socket) => {
      this.handleConnection(socket);
    });

    this.server.on('error', (error) => {
      this.emit('serverError', { error: error.message, timestamp: Date.now() });
    });

    this.server.on('close', () => {
      console.log(`📡 Stratum server on port ${this.options.port} closed`);
    });
  }

  handleConnection(socket) {
    if (this.stats.activeConnections >= this.options.maxConnections) {
      socket.destroy();
      return;
    }

    const clientId = this.generateClientId();
    const client = {
      id: clientId,
      socket: socket,
      subscribed: false,
      authorized: false,
      difficulty: this.options.difficulty,
      extraNonce1: this.generateExtraNonce1(),
      lastActivity: Date.now(),
      shares: { valid: 0, invalid: 0 },
      hashrate: 0,
      worker: null,
      address: socket.remoteAddress,
      userAgent: null,
      connectTime: Date.now(),
      buffer: ''
    };

    this.clients.set(clientId, client);
    this.stats.connections++;
    this.stats.activeConnections++;

    // Configure socket
    socket.setKeepAlive(true, 60000);
    socket.setTimeout(this.options.connectionTimeout);
    socket.setNoDelay(true);

    // Set up event handlers
    socket.on('data', (data) => {
      this.handleData(clientId, data);
    });

    socket.on('close', () => {
      this.handleDisconnection(clientId);
    });

    socket.on('error', (error) => {
      this.handleClientError(clientId, error);
    });

    socket.on('timeout', () => {
      this.handleTimeout(clientId);
    });

    this.emit('clientConnected', {
      clientId,
      address: socket.remoteAddress,
      port: socket.remotePort,
      timestamp: Date.now()
    });
  }

  handleData(clientId, data) {
    const client = this.clients.get(clientId);
    if (!client) return;

    client.lastActivity = Date.now();
    client.buffer += data.toString();

    // Process complete lines
    let lines = client.buffer.split('\n');
    client.buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (line.trim()) {
        this.processMessage(clientId, line.trim());
      }
    }
  }

  processMessage(clientId, messageStr) {
    const client = this.clients.get(clientId);
    if (!client) return;

    try {
      const message = JSON.parse(messageStr);
      
      // Queue message for batch processing if enabled
      if (this.batchProcessing && message.method === 'mining.submit') {
        this.queueShareSubmission(clientId, message);
      } else {
        this.handleMessage(clientId, message);
      }
    } catch (error) {
      this.sendError(clientId, null, 'Invalid JSON');
      this.emit('parseError', { clientId, error: error.message, message: messageStr, timestamp: Date.now() });
    }
  }

  handleMessage(clientId, message) {
    const client = this.clients.get(clientId);
    if (!client) return;

    const startTime = performance.now();

    switch (message.method) {
      case 'mining.subscribe':
        this.handleSubscribe(clientId, message);
        break;
      case 'mining.authorize':
        this.handleAuthorize(clientId, message);
        break;
      case 'mining.submit':
        this.handleSubmit(clientId, message);
        break;
      case 'mining.suggest_difficulty':
        this.handleSuggestDifficulty(clientId, message);
        break;
      default:
        this.sendError(clientId, message.id, 'Unknown method');
    }

    this.emit('messageProcessed', {
      clientId,
      method: message.method,
      processingTime: performance.now() - startTime,
      timestamp: Date.now()
    });
  }

  handleSubscribe(clientId, message) {
    const client = this.clients.get(clientId);
    if (!client) return;

    const [userAgent, sessionId] = message.params || [];
    client.userAgent = userAgent;
    client.subscribed = true;

    const response = {
      id: message.id,
      result: [
        [
          ['mining.set_difficulty', client.id],
          ['mining.notify', client.id]
        ],
        client.extraNonce1,
        4 // extraNonce2 size
      ],
      error: null
    };

    this.sendResponse(clientId, response);
    
    // Send initial difficulty
    this.sendDifficulty(clientId, client.difficulty);
    
    // Send work
    this.sendWork(clientId);

    this.emit('clientSubscribed', {
      clientId,
      userAgent,
      extraNonce1: client.extraNonce1,
      timestamp: Date.now()
    });
  }

  handleAuthorize(clientId, message) {
    const client = this.clients.get(clientId);
    if (!client) return;

    const [username, password] = message.params || [];
    
    // Parse worker information from username
    const parts = username.split('.');
    const walletAddress = parts[0];
    const workerName = parts[1] || 'default';

    // Validate wallet address format
    if (!this.isValidWalletAddress(walletAddress)) {
      this.sendError(clientId, message.id, 'Invalid wallet address');
      return;
    }

    client.authorized = true;
    client.worker = {
      address: walletAddress,
      name: workerName,
      password: password
    };

    const response = {
      id: message.id,
      result: true,
      error: null
    };

    this.sendResponse(clientId, response);

    this.emit('clientAuthorized', {
      clientId,
      walletAddress,
      workerName,
      timestamp: Date.now()
    });
  }

  handleSubmit(clientId, message) {
    const client = this.clients.get(clientId);
    if (!client) return;

    if (!client.authorized) {
      this.sendError(clientId, message.id, 'Not authorized');
      return;
    }

    const [workerName, jobId, extraNonce2, nTime, nonce] = message.params || [];
    
    // Validate share
    const validation = this.validateShare(client, jobId, extraNonce2, nTime, nonce);
    
    if (validation.valid) {
      client.shares.valid++;
      this.stats.validShares++;
      this.stats.totalShares++;
      
      this.sendResponse(clientId, {
        id: message.id,
        result: true,
        error: null
      });

      // Check if block was found
      if (validation.isBlock) {
        this.handleBlockFound(clientId, validation.block);
      }

      this.emit('validShare', {
        clientId,
        workerName,
        jobId,
        difficulty: client.difficulty,
        isBlock: validation.isBlock,
        timestamp: Date.now()
      });
    } else {
      client.shares.invalid++;
      this.stats.invalidShares++;
      this.stats.totalShares++;
      
      this.sendError(clientId, message.id, validation.reason);

      this.emit('invalidShare', {
        clientId,
        workerName,
        reason: validation.reason,
        timestamp: Date.now()
      });
    }

    // Update difficulty if vardiff enabled
    if (this.options.vardiff) {
      this.updateDifficulty(clientId);
    }
  }

  handleSuggestDifficulty(clientId, message) {
    const client = this.clients.get(clientId);
    if (!client) return;

    const [suggestedDifficulty] = message.params || [];
    
    if (this.options.vardiff && suggestedDifficulty > 0) {
      const newDifficulty = Math.max(1, Math.min(suggestedDifficulty, 1000000));
      client.difficulty = newDifficulty;
      this.sendDifficulty(clientId, newDifficulty);
    }

    this.sendResponse(clientId, {
      id: message.id,
      result: true,
      error: null
    });
  }

  validateShare(client, jobId, extraNonce2, nTime, nonce) {
    // Get job
    const job = this.jobs.get(jobId);
    if (!job) {
      return { valid: false, reason: 'Job not found' };
    }

    // Check job age
    if (Date.now() - job.timestamp > 300000) { // 5 minutes
      return { valid: false, reason: 'Stale share' };
    }

    // Validate parameters
    if (!extraNonce2 || !nTime || !nonce) {
      return { valid: false, reason: 'Missing parameters' };
    }

    // Validate extraNonce2 length
    if (extraNonce2.length !== 8) { // 4 bytes = 8 hex chars
      return { valid: false, reason: 'Invalid extraNonce2 length' };
    }

    // Validate nonce length
    if (nonce.length !== 8) { // 4 bytes = 8 hex chars
      return { valid: false, reason: 'Invalid nonce length' };
    }

    // Calculate hash based on algorithm
    const hash = this.calculateHash(client, job, extraNonce2, nTime, nonce);
    const target = this.calculateTarget(client.difficulty);
    const networkTarget = this.getNetworkTarget();

    // Check if hash meets difficulty
    const hashValue = this.hashToBigInt(hash);
    const targetValue = this.difficultyToTarget(client.difficulty);

    if (hashValue > targetValue) {
      return { valid: false, reason: 'Hash above target' };
    }

    // Check if it's a block
    const isBlock = hashValue <= this.difficultyToTarget(this.getNetworkDifficulty());

    return {
      valid: true,
      isBlock,
      hash,
      block: isBlock ? {
        hash,
        difficulty: client.difficulty,
        networkDifficulty: this.getNetworkDifficulty()
      } : null
    };
  }

  calculateHash(client, job, extraNonce2, nTime, nonce) {
    // Simplified hash calculation - implement proper algorithm-specific hashing
    const header = job.previousHash + job.merkleRoot + nTime + job.bits + nonce + client.extraNonce1 + extraNonce2;
    
    switch (this.options.algorithm) {
      case 'sha256':
        return crypto.createHash('sha256').update(header, 'hex').digest('hex');
      case 'scrypt':
        // Simplified scrypt - use proper scrypt implementation
        return crypto.createHash('sha256').update(header + 'scrypt', 'hex').digest('hex');
      default:
        return crypto.createHash('sha256').update(header, 'hex').digest('hex');
    }
  }

  hashToBigInt(hash) {
    return BigInt('0x' + hash);
  }

  difficultyToTarget(difficulty) {
    // Convert difficulty to target
    const maxTarget = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
    return maxTarget / BigInt(difficulty);
  }

  sendWork(clientId) {
    const client = this.clients.get(clientId);
    if (!client) return;

    const jobId = this.generateJobId();
    const job = {
      id: jobId,
      algorithm: this.options.algorithm,
      previousHash: this.generatePreviousHash(),
      merkleRoot: this.generateMerkleRoot(),
      timestamp: Date.now(),
      bits: this.getNetworkBits(),
      clean: true
    };

    this.jobs.set(jobId, job);

    const workMessage = {
      id: null,
      method: 'mining.notify',
      params: [
        jobId,
        job.previousHash,
        job.merkleRoot,
        job.merkleRoot, // Simplified - use proper coinbase construction
        [],
        '20000000', // version
        job.bits,
        Math.floor(Date.now() / 1000).toString(16).padStart(8, '0'),
        job.clean
      ]
    };

    this.sendResponse(clientId, workMessage);
  }

  sendDifficulty(clientId, difficulty) {
    const difficultyMessage = {
      id: null,
      method: 'mining.set_difficulty',
      params: [difficulty]
    };

    this.sendResponse(clientId, difficultyMessage);
  }

  sendResponse(clientId, response) {
    const client = this.clients.get(clientId);
    if (!client || !client.socket.writable) return;

    try {
      client.socket.write(JSON.stringify(response) + '\n');
    } catch (error) {
      this.handleClientError(clientId, error);
    }
  }

  sendError(clientId, messageId, errorMessage) {
    const response = {
      id: messageId,
      result: null,
      error: [20, errorMessage, null]
    };

    this.sendResponse(clientId, response);
  }

  // Batch processing for performance
  queueShareSubmission(clientId, message) {
    this.shareBuffer.push({
      clientId,
      message,
      timestamp: Date.now()
    });
  }

  startBatchProcessing() {
    setInterval(() => {
      if (this.shareBuffer.length === 0) return;

      const sharesToProcess = this.shareBuffer.splice(0, 100); // Process up to 100 shares
      
      for (const share of sharesToProcess) {
        if (Date.now() - share.timestamp < this.options.shareValidationTimeout) {
          this.handleSubmit(share.clientId, share.message);
        }
      }
    }, 10); // Process every 10ms
  }

  updateDifficulty(clientId) {
    const client = this.clients.get(clientId);
    if (!client) return;

    // Simple vardiff implementation
    const targetTime = 15; // seconds
    const shareHistory = client.shareHistory || [];
    
    if (shareHistory.length < 5) {
      if (!client.shareHistory) client.shareHistory = [];
      client.shareHistory.push(Date.now());
      return;
    }

    const timeDiff = (Date.now() - shareHistory[0]) / 1000; // seconds
    const avgTime = timeDiff / shareHistory.length;
    
    let newDifficulty = client.difficulty;
    
    if (avgTime < targetTime * 0.8) {
      newDifficulty *= 1.1; // Increase difficulty
    } else if (avgTime > targetTime * 1.2) {
      newDifficulty *= 0.9; // Decrease difficulty
    }

    newDifficulty = Math.max(1, Math.min(newDifficulty, 1000000));
    
    if (Math.abs(newDifficulty - client.difficulty) / client.difficulty > 0.1) {
      client.difficulty = newDifficulty;
      this.sendDifficulty(clientId, newDifficulty);
      
      this.emit('difficultyChanged', {
        clientId,
        oldDifficulty: client.difficulty,
        newDifficulty,
        timestamp: Date.now()
      });
    }

    // Keep only recent share timestamps
    client.shareHistory = shareHistory.slice(-10);
    client.shareHistory.push(Date.now());
  }

  handleBlockFound(clientId, block) {
    this.stats.blocksFound++;
    
    this.emit('blockFound', {
      clientId,
      block,
      timestamp: Date.now()
    });

    console.log(`🎉 Block found by client ${clientId}! Hash: ${block.hash}`);
  }

  handleDisconnection(clientId) {
    const client = this.clients.get(clientId);
    if (client) {
      this.clients.delete(clientId);
      this.stats.activeConnections--;
      
      this.emit('clientDisconnected', {
        clientId,
        duration: Date.now() - client.connectTime,
        shares: client.shares,
        timestamp: Date.now()
      });
    }
  }

  handleClientError(clientId, error) {
    this.emit('clientError', { clientId, error: error.message, timestamp: Date.now() });
    this.handleDisconnection(clientId);
  }

  handleTimeout(clientId) {
    this.emit('clientTimeout', { clientId, timestamp: Date.now() });
    this.handleDisconnection(clientId);
  }

  startCleanupTasks() {
    // Cleanup old jobs every minute
    setInterval(() => {
      const cutoff = Date.now() - 300000; // 5 minutes
      for (const [jobId, job] of this.jobs) {
        if (job.timestamp < cutoff) {
          this.jobs.delete(jobId);
        }
      }
    }, 60000);

    // Update statistics every 30 seconds
    setInterval(() => {
      this.updateStatistics();
    }, 30000);
  }

  updateStatistics() {
    let totalHashrate = 0;
    for (const client of this.clients.values()) {
      if (client.authorized && client.shares.valid > 0) {
        // Estimate hashrate based on shares and difficulty
        const timeConnected = (Date.now() - client.connectTime) / 1000;
        client.hashrate = (client.shares.valid * client.difficulty * Math.pow(2, 32)) / timeConnected;
        totalHashrate += client.hashrate;
      }
    }

    this.emit('statisticsUpdate', {
      ...this.stats,
      totalHashrate,
      timestamp: Date.now()
    });
  }

  // Utility functions
  generateClientId() {
    return crypto.randomBytes(8).toString('hex');
  }

  generateExtraNonce1() {
    return (++this.extraNonce1Counter).toString(16).padStart(8, '0');
  }

  generateJobId() {
    return crypto.randomBytes(4).toString('hex');
  }

  generatePreviousHash() {
    return crypto.randomBytes(32).toString('hex');
  }

  generateMerkleRoot() {
    return crypto.randomBytes(32).toString('hex');
  }

  getNetworkBits() {
    return '1d00ffff'; // Simplified - get from blockchain
  }

  getNetworkDifficulty() {
    return 1000000; // Simplified - get from blockchain
  }

  getNetworkTarget() {
    return this.difficultyToTarget(this.getNetworkDifficulty());
  }

  isValidWalletAddress(address) {
    // Simplified validation - implement proper validation for each coin
    return address && address.length >= 26 && address.length <= 62;
  }

  calculateTarget(difficulty) {
    return this.difficultyToTarget(difficulty);
  }

  // Public API
  listen() {
    return new Promise((resolve, reject) => {
      this.server.listen(this.options.port, (error) => {
        if (error) {
          reject(error);
        } else {
          console.log(`📡 Stratum server listening on port ${this.options.port}`);
          resolve();
        }
      });
    });
  }

  getStats() {
    return {
      ...this.stats,
      port: this.options.port,
      algorithm: this.options.algorithm,
      clients: this.clients.size,
      jobs: this.jobs.size,
      uptime: process.uptime(),
      timestamp: Date.now()
    };
  }

  getClients() {
    return Array.from(this.clients.values()).map(client => ({
      id: client.id,
      address: client.address,
      authorized: client.authorized,
      worker: client.worker,
      difficulty: client.difficulty,
      shares: client.shares,
      hashrate: client.hashrate || 0,
      connectTime: client.connectTime,
      lastActivity: client.lastActivity
    }));
  }

  async shutdown() {
    // Close all client connections
    for (const client of this.clients.values()) {
      if (client.socket) {
        client.socket.destroy();
      }
    }

    // Close server
    return new Promise((resolve) => {
      this.server.close(() => {
        this.emit('serverShutdown', { timestamp: Date.now() });
        console.log(`📡 Stratum server on port ${this.options.port} shutdown complete`);
        resolve();
      });
    });
  }
}

export default StratumServer;