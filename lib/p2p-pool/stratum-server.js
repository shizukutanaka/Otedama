const EventEmitter = require('events');
const net = require('net');
const crypto = require('crypto');

class StratumServer extends EventEmitter {
  constructor(pool, options = {}) {
    super();
    
    this.pool = pool;
    this.config = {
      port: options.port || 3333,
      host: options.host || '0.0.0.0',
      maxConnections: options.maxConnections || 1000,
      connectionTimeout: options.connectionTimeout || 300000, // 5 minutes
      // Stratum protocol settings
      extraNonce1Size: options.extraNonce1Size || 4,
      extraNonce2Size: options.extraNonce2Size || 4,
      // Difficulty adjustment
      retargetInterval: options.retargetInterval || 60000, // 1 minute
      targetTime: options.targetTime || 10000, // 10 seconds per share
      variancePercent: options.variancePercent || 30
    };
    
    this.server = null;
    this.connections = new Map();
    this.subscriptions = new Map();
    this.extraNonce1Counter = 0;
  }
  
  async start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });
      
      this.server.on('error', (error) => {
        this.emit('error', error);
        reject(error);
      });
      
      this.server.listen(this.config.port, this.config.host, () => {
        this.emit('started', {
          port: this.config.port,
          host: this.config.host
        });
        resolve();
      });
      
      // Set up pool event listeners
      this.setupPoolListeners();
    });
  }
  
  handleConnection(socket) {
    const connectionId = crypto.randomBytes(16).toString('hex');
    
    const connection = {
      id: connectionId,
      socket,
      authorized: false,
      subscribed: false,
      miner: null,
      extraNonce1: null,
      difficulty: this.pool.config.pool.minShareDifficulty,
      shares: {
        submitted: 0,
        accepted: 0,
        rejected: 0,
        lastSubmit: null
      },
      jobs: new Map(),
      connected: Date.now()
    };
    
    this.connections.set(connectionId, connection);
    
    // Set up socket handlers
    socket.setEncoding('utf8');
    socket.setKeepAlive(true, 60000);
    
    let dataBuffer = '';
    
    socket.on('data', (data) => {
      dataBuffer += data;
      
      // Process complete messages
      let newlineIndex;
      while ((newlineIndex = dataBuffer.indexOf('\n')) !== -1) {
        const message = dataBuffer.substring(0, newlineIndex);
        dataBuffer = dataBuffer.substring(newlineIndex + 1);
        
        if (message.length > 0) {
          this.handleMessage(connection, message);
        }
      }
    });
    
    socket.on('error', (error) => {
      this.emit('socketError', { connectionId, error });
    });
    
    socket.on('close', () => {
      this.handleDisconnection(connection);
    });
    
    // Set connection timeout
    socket.setTimeout(this.config.connectionTimeout);
    socket.on('timeout', () => {
      socket.end();
    });
  }
  
  handleMessage(connection, message) {
    try {
      const data = JSON.parse(message);
      
      if (!data.id || !data.method) {
        this.sendError(connection, null, -32600, 'Invalid Request');
        return;
      }
      
      // Handle stratum methods
      switch (data.method) {
        case 'mining.subscribe':
          this.handleSubscribe(connection, data);
          break;
          
        case 'mining.authorize':
          this.handleAuthorize(connection, data);
          break;
          
        case 'mining.submit':
          this.handleSubmit(connection, data);
          break;
          
        case 'mining.get_transactions':
          this.handleGetTransactions(connection, data);
          break;
          
        case 'mining.extranonce.subscribe':
          this.handleExtranonceSubscribe(connection, data);
          break;
          
        default:
          this.sendError(connection, data.id, -32601, 'Method not found');
      }
    } catch (error) {
      this.sendError(connection, null, -32700, 'Parse error');
    }
  }
  
  handleSubscribe(connection, message) {
    // Generate unique extraNonce1
    connection.extraNonce1 = this.generateExtraNonce1();
    connection.subscribed = true;
    
    // Response format: [[mining.notify, subscription_id], extraNonce1, extraNonce2Size]
    const subscriptionId = crypto.randomBytes(8).toString('hex');
    this.subscriptions.set(subscriptionId, connection.id);
    
    const response = {
      id: message.id,
      result: [
        [['mining.notify', subscriptionId]],
        connection.extraNonce1,
        this.config.extraNonce2Size
      ],
      error: null
    };
    
    this.sendMessage(connection, response);
    
    // Send current job
    if (this.pool.currentJob) {
      this.sendJob(connection, this.pool.currentJob, true);
    }
    
    this.emit('minerSubscribed', {
      connectionId: connection.id,
      extraNonce1: connection.extraNonce1
    });
  }
  
  handleAuthorize(connection, message) {
    const [username, password] = message.params;
    
    // Parse username format: address.worker
    const parts = username.split('.');
    const address = parts[0];
    const worker = parts[1] || 'default';
    
    // Validate address
    if (!this.validateAddress(address)) {
      this.sendResponse(connection, message.id, false);
      return;
    }
    
    // Register miner with pool
    const minerId = `${connection.id}_${worker}`;
    connection.miner = this.pool.registerMiner(minerId, {
      address,
      worker,
      password
    });
    
    connection.authorized = true;
    
    this.sendResponse(connection, message.id, true);
    
    // Send difficulty
    this.sendDifficulty(connection);
    
    this.emit('minerAuthorized', {
      connectionId: connection.id,
      address,
      worker
    });
  }
  
  async handleSubmit(connection, message) {
    if (!connection.authorized) {
      this.sendError(connection, message.id, -32500, 'Not authorized');
      return;
    }
    
    const [username, jobId, extraNonce2, nTime, nonce] = message.params;
    
    // Validate parameters
    if (!this.validateSubmitParams(jobId, extraNonce2, nTime, nonce)) {
      this.sendResponse(connection, message.id, false);
      connection.shares.rejected++;
      return;
    }
    
    try {
      // Submit share to pool
      const result = await this.pool.submitShare(connection.miner.id, {
        jobId,
        extraNonce1: connection.extraNonce1,
        extraNonce2,
        nTime: parseInt(nTime, 16),
        nonce: parseInt(nonce, 16)
      });
      
      if (result.status === 'valid') {
        connection.shares.accepted++;
        connection.shares.lastSubmit = Date.now();
        this.sendResponse(connection, message.id, true);
        
        // Adjust difficulty
        this.adjustDifficulty(connection);
      } else {
        connection.shares.rejected++;
        this.sendResponse(connection, message.id, false);
        
        this.emit('shareRejected', {
          connectionId: connection.id,
          reason: result.reason
        });
      }
    } catch (error) {
      this.sendError(connection, message.id, -32500, 'Internal error');
      this.emit('error', { type: 'submit', error });
    }
    
    connection.shares.submitted++;
  }
  
  handleGetTransactions(connection, message) {
    // Return transactions for current job
    const job = this.pool.currentJob;
    if (!job) {
      this.sendResponse(connection, message.id, []);
      return;
    }
    
    const transactions = job.transactions.map(tx => 
      this.serializeTransaction(tx).toString('hex')
    );
    
    this.sendResponse(connection, message.id, transactions);
  }
  
  handleExtranonceSubscribe(connection, message) {
    // Enable extranonce updates
    connection.extranonceSubscribe = true;
    this.sendResponse(connection, message.id, true);
  }
  
  handleDisconnection(connection) {
    this.connections.delete(connection.id);
    
    if (connection.miner) {
      this.pool.unregisterMiner(connection.miner.id);
    }
    
    this.emit('minerDisconnected', {
      connectionId: connection.id
    });
  }
  
  // Job notification
  
  sendJob(connection, job, clean = false) {
    if (!connection.subscribed) return;
    
    const jobForConnection = {
      id: job.id,
      prevHash: job.previousHash,
      coinbase1: this.createCoinbase1(job),
      coinbase2: this.createCoinbase2(job),
      merkleBranches: this.getMerkleBranches(job),
      version: job.version || this.pool.config.mining.blockVersion,
      nbits: job.bits.toString(16),
      ntime: job.timestamp.toString(16),
      cleanJobs: clean
    };
    
    connection.jobs.set(job.id, jobForConnection);
    
    const notification = {
      id: null,
      method: 'mining.notify',
      params: [
        jobForConnection.id,
        jobForConnection.prevHash,
        jobForConnection.coinbase1,
        jobForConnection.coinbase2,
        jobForConnection.merkleBranches,
        jobForConnection.version.toString(16).padStart(8, '0'),
        jobForConnection.nbits,
        jobForConnection.ntime,
        jobForConnection.cleanJobs
      ]
    };
    
    this.sendMessage(connection, notification);
  }
  
  createCoinbase1(job) {
    // First part of coinbase transaction (before extraNonce)
    const coinbase = job.coinbase;
    const script = coinbase.inputs[0].script;
    
    // Find extraNonce position
    const extraNonceStart = 42; // Simplified position
    
    return script.slice(0, extraNonceStart).toString('hex');
  }
  
  createCoinbase2(job) {
    // Second part of coinbase transaction (after extraNonce)
    const coinbase = job.coinbase;
    const script = coinbase.inputs[0].script;
    
    // Find extraNonce position
    const extraNonceStart = 42;
    const extraNonceLength = this.config.extraNonce1Size + this.config.extraNonce2Size;
    
    const scriptEnd = script.slice(extraNonceStart + extraNonceLength);
    const outputs = this.serializeOutputs(coinbase.outputs);
    
    return Buffer.concat([scriptEnd, outputs]).toString('hex');
  }
  
  getMerkleBranches(job) {
    // Calculate merkle branches for transactions
    const branches = [];
    const txHashes = job.transactions.map(tx => {
      const serialized = this.serializeTransaction(tx);
      return this.pool.calculateHash(serialized);
    });
    
    // Build merkle tree branches
    let level = txHashes;
    while (level.length > 1) {
      branches.push(level[1] ? level[1].toString('hex') : level[0].toString('hex'));
      
      const nextLevel = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i];
        const right = level[i + 1] || left;
        const combined = Buffer.concat([left, right]);
        nextLevel.push(this.pool.calculateHash(combined));
      }
      level = nextLevel;
    }
    
    return branches;
  }
  
  // Difficulty management
  
  sendDifficulty(connection) {
    const notification = {
      id: null,
      method: 'mining.set_difficulty',
      params: [connection.difficulty]
    };
    
    this.sendMessage(connection, notification);
  }
  
  adjustDifficulty(connection) {
    const shares = connection.shares;
    const timeSinceLastShare = Date.now() - (shares.lastSubmit || connection.connected);
    
    // Skip if not enough data
    if (shares.accepted < 5) return;
    
    // Calculate actual time per share
    const actualTime = timeSinceLastShare / shares.accepted;
    
    // Calculate adjustment ratio
    const ratio = this.config.targetTime / actualTime;
    
    // Apply variance limit
    const maxChange = 1 + (this.config.variancePercent / 100);
    const minChange = 1 - (this.config.variancePercent / 100);
    const limitedRatio = Math.max(minChange, Math.min(maxChange, ratio));
    
    // Calculate new difficulty
    const newDifficulty = Math.floor(connection.difficulty * limitedRatio);
    
    // Apply min/max limits
    const minDiff = this.pool.config.pool.minShareDifficulty;
    const maxDiff = minDiff * 1000;
    connection.difficulty = Math.max(minDiff, Math.min(maxDiff, newDifficulty));
    
    // Send new difficulty
    this.sendDifficulty(connection);
    
    // Reset share counter
    connection.shares.accepted = 0;
    connection.shares.rejected = 0;
  }
  
  // Pool event listeners
  
  setupPoolListeners() {
    this.pool.on('newJob', (job) => {
      this.broadcastJob(job);
    });
    
    this.pool.on('blockFound', (block) => {
      this.broadcastBlockFound(block);
    });
  }
  
  broadcastJob(job) {
    for (const connection of this.connections.values()) {
      if (connection.subscribed) {
        this.sendJob(connection, job, true);
      }
    }
  }
  
  broadcastBlockFound(block) {
    // Notify miners about found block
    const message = {
      id: null,
      method: 'client.show_message',
      params: [`Block found! Height: ${block.height}, Reward: ${block.reward}`]
    };
    
    for (const connection of this.connections.values()) {
      if (connection.subscribed) {
        this.sendMessage(connection, message);
      }
    }
  }
  
  // Utility functions
  
  generateExtraNonce1() {
    this.extraNonce1Counter++;
    const buffer = Buffer.alloc(this.config.extraNonce1Size);
    buffer.writeUInt32BE(this.extraNonce1Counter, 0);
    return buffer.toString('hex');
  }
  
  validateAddress(address) {
    // Basic address validation
    return /^[a-zA-Z0-9]{26,35}$/.test(address);
  }
  
  validateSubmitParams(jobId, extraNonce2, nTime, nonce) {
    // Validate hex strings
    if (!/^[0-9a-fA-F]+$/.test(extraNonce2) ||
        !/^[0-9a-fA-F]+$/.test(nTime) ||
        !/^[0-9a-fA-F]+$/.test(nonce)) {
      return false;
    }
    
    // Validate lengths
    if (extraNonce2.length !== this.config.extraNonce2Size * 2) {
      return false;
    }
    
    return true;
  }
  
  serializeTransaction(tx) {
    // Simplified transaction serialization
    return Buffer.from(JSON.stringify(tx));
  }
  
  serializeOutputs(outputs) {
    // Simplified output serialization
    const buffers = outputs.map(output => {
      const value = Buffer.alloc(8);
      value.writeBigInt64LE(BigInt(output.value), 0);
      const scriptLen = Buffer.alloc(1);
      scriptLen.writeUInt8(output.script.length, 0);
      return Buffer.concat([value, scriptLen, output.script]);
    });
    
    return Buffer.concat(buffers);
  }
  
  // Message sending
  
  sendMessage(connection, message) {
    try {
      const data = JSON.stringify(message) + '\n';
      connection.socket.write(data);
    } catch (error) {
      this.emit('error', { type: 'send', connectionId: connection.id, error });
    }
  }
  
  sendResponse(connection, id, result) {
    this.sendMessage(connection, {
      id,
      result,
      error: null
    });
  }
  
  sendError(connection, id, code, message) {
    this.sendMessage(connection, {
      id,
      result: null,
      error: { code, message }
    });
  }
  
  // Public API
  
  getConnections() {
    const connections = [];
    
    for (const [id, conn] of this.connections) {
      connections.push({
        id,
        authorized: conn.authorized,
        address: conn.miner?.address,
        worker: conn.miner?.worker,
        difficulty: conn.difficulty,
        shares: conn.shares,
        connected: conn.connected
      });
    }
    
    return connections;
  }
  
  async stop() {
    return new Promise((resolve) => {
      // Close all connections
      for (const connection of this.connections.values()) {
        connection.socket.end();
      }
      
      // Close server
      this.server.close(() => {
        this.emit('stopped');
        resolve();
      });
    });
  }
}

module.exports = StratumServer;