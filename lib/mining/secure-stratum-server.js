/**
 * Secure Stratum Server
 * Enhanced Stratum V1 server with security, performance, and reliability improvements
 */

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { createLogger } = require('../core/logger');
const { RateLimiterMemory } = require('rate-limiter-flexible');

const logger = createLogger('secure-stratum-server');

class SecureStratumServer extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      port: options.port || 3333,
      host: options.host || '0.0.0.0',
      difficulty: options.difficulty || 16,
      extraNonce1Size: options.extraNonce1Size || 4,
      extraNonce2Size: options.extraNonce2Size || 4,
      maxConnections: options.maxConnections || 10000,
      maxConnectionsPerIP: options.maxConnectionsPerIP || 10,
      shareTimeout: options.shareTimeout || 180000, // 3 minutes
      jobTimeout: options.jobTimeout || 600000, // 10 minutes
      banDuration: options.banDuration || 3600000, // 1 hour
      rateLimit: {
        points: options.rateLimitPoints || 100,
        duration: options.rateLimitDuration || 60,
        blockDuration: options.rateLimitBlockDuration || 600
      },
      ssl: options.ssl || null,
      validationStrict: options.validationStrict !== false,
      ...options
    };
    
    this.server = null;
    this.miners = new Map();
    this.jobs = new Map();
    this.currentJob = null;
    this.extraNonce1Counter = 0;
    
    // Security features
    this.ipConnections = new Map();
    this.bannedIPs = new Map();
    this.shareHistory = new Map();
    this.suspiciousActivity = new Map();
    
    // Rate limiters
    this.connectionLimiter = new RateLimiterMemory({
      points: 10,
      duration: 60,
      blockDuration: this.options.banDuration / 1000
    });
    
    this.shareLimiter = new RateLimiterMemory({
      points: this.options.rateLimit.points,
      duration: this.options.rateLimit.duration,
      blockDuration: this.options.rateLimit.blockDuration
    });
    
    // Performance tracking
    this.stats = {
      connections: 0,
      totalConnections: 0,
      miners: 0,
      shares: 0,
      validShares: 0,
      invalidShares: 0,
      duplicateShares: 0,
      blocks: 0,
      banned: 0,
      errors: 0,
      startTime: Date.now()
    };
    
    // Cleanup timers
    this.cleanupTimer = null;
    this.statsTimer = null;
  }
  
  /**
   * Start the secure stratum server
   */
  async start() {
    try {
      // Create server with SSL support if configured
      if (this.options.ssl) {
        this.server = tls.createServer(this.options.ssl, (socket) => {
          this.handleConnection(socket);
        });
      } else {
        this.server = net.createServer((socket) => {
          this.handleConnection(socket);
        });
      }
      
      // Server event handlers
      this.server.on('error', (err) => {
        logger.error('Server error:', err);
        this.stats.errors++;
      });
      
      this.server.maxConnections = this.options.maxConnections;
      
      // Start listening
      await new Promise((resolve, reject) => {
        this.server.listen(this.options.port, this.options.host, () => {
          logger.info(`Secure Stratum server listening on ${this.options.host}:${this.options.port}`);
          resolve();
        });
        
        this.server.once('error', reject);
      });
      
      // Start cleanup and monitoring
      this.startCleanup();
      this.startMonitoring();
      
      this.emit('started');
      
    } catch (error) {
      logger.error('Failed to start server:', error);
      throw error;
    }
  }
  
  /**
   * Stop the server
   */
  async stop() {
    // Stop timers
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    
    // Close all miner connections
    for (const miner of this.miners.values()) {
      miner.socket.end();
    }
    
    // Close server
    if (this.server) {
      await new Promise((resolve) => {
        this.server.close(() => {
          logger.info('Secure Stratum server stopped');
          resolve();
        });
      });
    }
    
    this.emit('stopped');
  }
  
  /**
   * Handle new connection with security checks
   */
  async handleConnection(socket) {
    const clientIP = socket.remoteAddress;
    const clientPort = socket.remotePort;
    
    try {
      // Check if IP is banned
      if (this.isBanned(clientIP)) {
        logger.warn(`Rejected connection from banned IP: ${clientIP}`);
        socket.end();
        return;
      }
      
      // Rate limit connections
      try {
        await this.connectionLimiter.consume(clientIP);
      } catch (rateLimiterRes) {
        logger.warn(`Connection rate limit exceeded for IP: ${clientIP}`);
        this.banIP(clientIP, 'Connection flooding');
        socket.end();
        return;
      }
      
      // Check per-IP connection limit
      const ipCount = this.ipConnections.get(clientIP) || 0;
      if (ipCount >= this.options.maxConnectionsPerIP) {
        logger.warn(`Max connections exceeded for IP: ${clientIP}`);
        socket.end();
        return;
      }
      
      // Generate miner ID and extra nonce
      const minerId = crypto.randomBytes(16).toString('hex');
      const extraNonce1 = this.generateExtraNonce1();
      
      // Create miner object
      const miner = {
        id: minerId,
        socket,
        ip: clientIP,
        port: clientPort,
        address: null,
        worker: null,
        extraNonce1,
        difficulty: this.options.difficulty,
        subscribed: false,
        authorized: false,
        shares: 0,
        validShares: 0,
        invalidShares: 0,
        lastShare: null,
        connectedAt: Date.now(),
        lastActivity: Date.now(),
        userAgent: null,
        version: null
      };
      
      // Update connection tracking
      this.miners.set(minerId, miner);
      this.ipConnections.set(clientIP, ipCount + 1);
      this.stats.connections++;
      this.stats.totalConnections++;
      
      // Configure socket
      socket.setKeepAlive(true, 60000);
      socket.setNoDelay(true);
      
      // Socket event handlers
      let buffer = '';
      
      socket.on('data', (data) => {
        buffer += data.toString();
        const messages = buffer.split('\n');
        buffer = messages.pop();
        
        for (const message of messages) {
          if (message.trim()) {
            this.handleMessage(miner, message);
          }
        }
      });
      
      socket.on('error', (err) => {
        logger.debug(`Socket error for miner ${minerId}:`, err.message);
        this.stats.errors++;
      });
      
      socket.on('close', () => {
        this.handleDisconnection(miner);
      });
      
      socket.on('timeout', () => {
        logger.debug(`Socket timeout for miner ${minerId}`);
        socket.end();
      });
      
      logger.debug(`New connection from ${clientIP}:${clientPort} (${minerId})`);
      
    } catch (error) {
      logger.error('Error handling connection:', error);
      socket.end();
    }
  }
  
  /**
   * Handle miner disconnection
   */
  handleDisconnection(miner) {
    // Update connection tracking
    const ipCount = this.ipConnections.get(miner.ip) || 0;
    if (ipCount > 1) {
      this.ipConnections.set(miner.ip, ipCount - 1);
    } else {
      this.ipConnections.delete(miner.ip);
    }
    
    // Remove miner
    this.miners.delete(miner.id);
    this.stats.connections--;
    
    // Clean up share history
    this.shareHistory.delete(miner.id);
    
    logger.debug(`Miner ${miner.id} disconnected`);
    this.emit('miner-disconnected', miner);
  }
  
  /**
   * Handle incoming message with validation
   */
  handleMessage(miner, message) {
    try {
      miner.lastActivity = Date.now();
      
      // Parse JSON-RPC message
      let data;
      try {
        data = JSON.parse(message);
      } catch (error) {
        logger.debug(`Invalid JSON from miner ${miner.id}: ${message}`);
        this.trackSuspiciousActivity(miner, 'invalid_json');
        return;
      }
      
      // Validate message structure
      if (!data || typeof data !== 'object') {
        this.trackSuspiciousActivity(miner, 'invalid_message');
        return;
      }
      
      // Handle different methods
      switch (data.method) {
        case 'mining.subscribe':
          this.handleSubscribe(miner, data);
          break;
        case 'mining.authorize':
          this.handleAuthorize(miner, data);
          break;
        case 'mining.submit':
          this.handleSubmit(miner, data);
          break;
        case 'mining.get_transactions':
          this.handleGetTransactions(miner, data);
          break;
        case 'mining.extranonce.subscribe':
          this.handleExtranonceSubscribe(miner, data);
          break;
        default:
          logger.debug(`Unknown method from miner ${miner.id}: ${data.method}`);
          this.sendError(miner, data.id, 'Unknown method');
      }
      
    } catch (error) {
      logger.error(`Error handling message from miner ${miner.id}:`, error);
      this.stats.errors++;
    }
  }
  
  /**
   * Handle mining.subscribe with enhanced validation
   */
  handleSubscribe(miner, data) {
    if (miner.subscribed) {
      this.sendError(miner, data.id, 'Already subscribed');
      return;
    }
    
    // Extract user agent and version
    if (data.params && data.params.length > 0) {
      miner.userAgent = data.params[0];
      if (data.params.length > 1) {
        miner.version = data.params[1];
      }
    }
    
    miner.subscribed = true;
    miner.subscribeId = data.id;
    
    // Send subscription response
    const response = {
      id: data.id,
      result: [
        [
          ['mining.set_difficulty', crypto.randomBytes(8).toString('hex')],
          ['mining.notify', crypto.randomBytes(8).toString('hex')]
        ],
        miner.extraNonce1,
        this.options.extraNonce2Size
      ],
      error: null
    };
    
    this.send(miner, response);
    
    // Send initial difficulty
    this.sendDifficulty(miner);
    
    // Send current job if available
    if (this.currentJob) {
      this.sendJob(miner, this.currentJob);
    }
    
    logger.info(`Miner ${miner.id} subscribed (${miner.userAgent || 'Unknown'})`);
  }
  
  /**
   * Handle mining.authorize with address validation
   */
  async handleAuthorize(miner, data) {
    if (!miner.subscribed) {
      this.sendError(miner, data.id, 'Not subscribed');
      return;
    }
    
    const [address, password] = data.params || [];
    
    // Validate address format
    if (!this.isValidAddress(address)) {
      this.sendError(miner, data.id, 'Invalid address format');
      this.trackSuspiciousActivity(miner, 'invalid_address');
      return;
    }
    
    // Check for address bans
    if (this.isBannedAddress(address)) {
      this.sendError(miner, data.id, 'Address not allowed');
      this.banIP(miner.ip, 'Banned address');
      miner.socket.end();
      return;
    }
    
    miner.address = address;
    miner.worker = password || 'default';
    miner.authorized = true;
    
    const response = {
      id: data.id,
      result: true,
      error: null
    };
    
    this.send(miner, response);
    
    logger.info(`Miner ${miner.id} authorized as ${address}.${miner.worker}`);
    this.emit('miner-connected', miner);
  }
  
  /**
   * Handle mining.submit with comprehensive validation
   */
  async handleSubmit(miner, data) {
    if (!miner.authorized) {
      this.sendError(miner, data.id, 'Not authorized');
      return;
    }
    
    // Rate limit share submissions
    try {
      await this.shareLimiter.consume(miner.id);
    } catch (rateLimiterRes) {
      logger.warn(`Share rate limit exceeded for miner ${miner.id}`);
      this.sendError(miner, data.id, 'Rate limit exceeded');
      this.trackSuspiciousActivity(miner, 'share_flooding');
      return;
    }
    
    const [worker, jobId, extraNonce2, ntime, nonce] = data.params || [];
    
    // Validate parameters
    if (!this.validateShareParams(worker, jobId, extraNonce2, ntime, nonce)) {
      this.sendError(miner, data.id, 'Invalid parameters');
      this.trackSuspiciousActivity(miner, 'invalid_params');
      return;
    }
    
    // Check job exists and is current
    const job = this.jobs.get(jobId);
    if (!job) {
      this.sendError(miner, data.id, 'Job not found');
      return;
    }
    
    // Check job timeout
    if (Date.now() - job.createdAt > this.options.jobTimeout) {
      this.sendError(miner, data.id, 'Job expired');
      return;
    }
    
    // Build share object
    const share = {
      worker,
      jobId,
      extraNonce1: miner.extraNonce1,
      extraNonce2,
      ntime,
      nonce,
      difficulty: miner.difficulty,
      timestamp: Date.now(),
      minerAddress: miner.address,
      ip: miner.ip
    };
    
    // Check for duplicate shares
    const shareHash = this.getShareHash(share);
    if (this.isDuplicateShare(miner.id, shareHash)) {
      this.sendError(miner, data.id, 'Duplicate share');
      this.stats.duplicateShares++;
      this.trackSuspiciousActivity(miner, 'duplicate_share');
      return;
    }
    
    // Record share
    this.recordShare(miner.id, shareHash);
    miner.shares++;
    miner.lastShare = Date.now();
    this.stats.shares++;
    
    // Emit for validation
    this.emit('share-submitted', miner, share, (isValid, isBlock, reason) => {
      if (isValid) {
        miner.validShares++;
        this.stats.validShares++;
        
        const response = {
          id: data.id,
          result: true,
          error: null
        };
        
        this.send(miner, response);
        
        if (isBlock) {
          this.stats.blocks++;
          logger.info(`🎉 Block found by ${miner.address}.${miner.worker}!`);
          this.emit('block-found', miner, share);
        }
        
        // Adjust difficulty if needed
        this.adjustDifficulty(miner);
        
      } else {
        miner.invalidShares++;
        this.stats.invalidShares++;
        this.sendError(miner, data.id, reason || 'Invalid share');
        
        // Track high invalid share rate
        const invalidRate = miner.invalidShares / miner.shares;
        if (miner.shares > 100 && invalidRate > 0.5) {
          this.trackSuspiciousActivity(miner, 'high_invalid_rate');
        }
      }
    });
  }
  
  /**
   * Validate share parameters
   */
  validateShareParams(worker, jobId, extraNonce2, ntime, nonce) {
    if (!worker || typeof worker !== 'string') return false;
    if (!jobId || typeof jobId !== 'string') return false;
    if (!extraNonce2 || typeof extraNonce2 !== 'string') return false;
    if (!ntime || typeof ntime !== 'string' || ntime.length !== 8) return false;
    if (!nonce || typeof nonce !== 'string' || nonce.length !== 8) return false;
    
    // Validate hex strings
    const hexRegex = /^[0-9a-fA-F]+$/;
    if (!hexRegex.test(extraNonce2)) return false;
    if (!hexRegex.test(ntime)) return false;
    if (!hexRegex.test(nonce)) return false;
    
    return true;
  }
  
  /**
   * Check if address is valid
   */
  isValidAddress(address) {
    if (!address || typeof address !== 'string') return false;
    
    // Bitcoin address validation (simplified)
    // P2PKH: 1...
    if (/^1[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) return true;
    // P2SH: 3...
    if (/^3[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) return true;
    // Bech32: bc1...
    if (/^bc1[a-z0-9]{39,59}$/.test(address)) return true;
    // Testnet
    if (/^[mn2][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) return true;
    if (/^tb1[a-z0-9]{39,59}$/.test(address)) return true;
    
    return false;
  }
  
  /**
   * Generate share hash for duplicate detection
   */
  getShareHash(share) {
    const data = `${share.jobId}:${share.extraNonce1}:${share.extraNonce2}:${share.ntime}:${share.nonce}`;
    return crypto.createHash('sha256').update(data).digest('hex');
  }
  
  /**
   * Check for duplicate shares
   */
  isDuplicateShare(minerId, shareHash) {
    const minerHistory = this.shareHistory.get(minerId);
    if (!minerHistory) return false;
    
    return minerHistory.has(shareHash);
  }
  
  /**
   * Record share for duplicate detection
   */
  recordShare(minerId, shareHash) {
    if (!this.shareHistory.has(minerId)) {
      this.shareHistory.set(minerId, new Set());
    }
    
    const minerHistory = this.shareHistory.get(minerId);
    minerHistory.add(shareHash);
    
    // Limit history size
    if (minerHistory.size > 1000) {
      const oldestShares = Array.from(minerHistory).slice(0, minerHistory.size - 1000);
      oldestShares.forEach(hash => minerHistory.delete(hash));
    }
  }
  
  /**
   * Adjust miner difficulty based on share rate
   */
  adjustDifficulty(miner) {
    // Calculate share rate (shares per minute)
    const timeSinceStart = Date.now() - miner.connectedAt;
    const shareRate = (miner.validShares / timeSinceStart) * 60000;
    
    // Target: 10-20 shares per minute
    let newDifficulty = miner.difficulty;
    
    if (shareRate > 30) {
      newDifficulty = Math.min(miner.difficulty * 2, 65536);
    } else if (shareRate > 20) {
      newDifficulty = Math.min(miner.difficulty * 1.5, 65536);
    } else if (shareRate < 5 && miner.difficulty > 1) {
      newDifficulty = Math.max(miner.difficulty / 2, 1);
    } else if (shareRate < 10 && miner.difficulty > 1) {
      newDifficulty = Math.max(miner.difficulty / 1.5, 1);
    }
    
    if (newDifficulty !== miner.difficulty) {
      miner.difficulty = newDifficulty;
      this.sendDifficulty(miner);
      logger.debug(`Adjusted difficulty for miner ${miner.id} to ${newDifficulty}`);
    }
  }
  
  /**
   * Track suspicious activity
   */
  trackSuspiciousActivity(miner, type) {
    const key = `${miner.ip}:${type}`;
    const count = (this.suspiciousActivity.get(key) || 0) + 1;
    this.suspiciousActivity.set(key, count);
    
    // Auto-ban after threshold
    const thresholds = {
      invalid_json: 100,
      invalid_message: 100,
      invalid_address: 10,
      invalid_params: 50,
      duplicate_share: 20,
      share_flooding: 5,
      high_invalid_rate: 1
    };
    
    if (count >= (thresholds[type] || 50)) {
      this.banIP(miner.ip, `Suspicious activity: ${type}`);
      miner.socket.end();
    }
  }
  
  /**
   * Ban IP address
   */
  banIP(ip, reason) {
    this.bannedIPs.set(ip, {
      timestamp: Date.now(),
      reason
    });
    
    this.stats.banned++;
    logger.warn(`Banned IP ${ip}: ${reason}`);
    
    // Disconnect all miners from this IP
    for (const miner of this.miners.values()) {
      if (miner.ip === ip) {
        miner.socket.end();
      }
    }
  }
  
  /**
   * Check if IP is banned
   */
  isBanned(ip) {
    const ban = this.bannedIPs.get(ip);
    if (!ban) return false;
    
    // Check if ban has expired
    if (Date.now() - ban.timestamp > this.options.banDuration) {
      this.bannedIPs.delete(ip);
      return false;
    }
    
    return true;
  }
  
  /**
   * Check if address is banned
   */
  isBannedAddress(address) {
    // Implement address blacklist if needed
    return false;
  }
  
  /**
   * Send difficulty to miner
   */
  sendDifficulty(miner) {
    const message = {
      id: null,
      method: 'mining.set_difficulty',
      params: [miner.difficulty]
    };
    
    this.send(miner, message);
  }
  
  /**
   * Send job to miner
   */
  sendJob(miner, job, clean = false) {
    if (!miner.subscribed) return;
    
    const message = {
      id: null,
      method: 'mining.notify',
      params: [
        job.id,
        job.prevHash,
        job.coinbase1,
        job.coinbase2,
        job.merkleTree,
        job.version,
        job.bits,
        job.time,
        clean
      ]
    };
    
    this.send(miner, message);
  }
  
  /**
   * Broadcast new job to all miners
   */
  broadcastJob(job, clean = false) {
    // Add timestamp to job
    job.createdAt = Date.now();
    
    this.currentJob = job;
    this.jobs.set(job.id, job);
    
    // Clean old jobs
    this.cleanOldJobs();
    
    // Send to all subscribed miners
    let sent = 0;
    for (const miner of this.miners.values()) {
      if (miner.subscribed) {
        this.sendJob(miner, job, clean);
        sent++;
      }
    }
    
    logger.info(`Broadcasted job ${job.id} to ${sent} miners`);
    this.emit('job-broadcasted', job, sent);
  }
  
  /**
   * Clean old jobs from memory
   */
  cleanOldJobs() {
    const now = Date.now();
    const maxAge = this.options.jobTimeout * 2;
    
    for (const [jobId, job] of this.jobs) {
      if (now - job.createdAt > maxAge) {
        this.jobs.delete(jobId);
      }
    }
  }
  
  /**
   * Send message to miner
   */
  send(miner, message) {
    try {
      const data = JSON.stringify(message) + '\n';
      miner.socket.write(data);
    } catch (error) {
      logger.error(`Failed to send message to miner ${miner.id}:`, error);
    }
  }
  
  /**
   * Send error to miner
   */
  sendError(miner, id, message) {
    const response = {
      id,
      result: null,
      error: [20, message, null]
    };
    
    this.send(miner, response);
  }
  
  /**
   * Generate extra nonce 1
   */
  generateExtraNonce1() {
    const buffer = Buffer.allocUnsafe(this.options.extraNonce1Size);
    buffer.writeUInt32BE(this.extraNonce1Counter++, 0);
    return buffer.toString('hex');
  }
  
  /**
   * Start cleanup timer
   */
  startCleanup() {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      
      // Clean up inactive miners
      for (const [minerId, miner] of this.miners) {
        if (now - miner.lastActivity > this.options.shareTimeout) {
          logger.debug(`Disconnecting inactive miner ${minerId}`);
          miner.socket.end();
        }
      }
      
      // Clean up old suspicious activity records
      for (const [key, count] of this.suspiciousActivity) {
        if (count === 0) {
          this.suspiciousActivity.delete(key);
        } else {
          // Decay counts over time
          this.suspiciousActivity.set(key, Math.floor(count * 0.9));
        }
      }
      
      // Clean up expired bans
      for (const [ip, ban] of this.bannedIPs) {
        if (now - ban.timestamp > this.options.banDuration) {
          this.bannedIPs.delete(ip);
        }
      }
      
    }, 60000); // Every minute
  }
  
  /**
   * Start monitoring timer
   */
  startMonitoring() {
    this.statsTimer = setInterval(() => {
      const uptime = Date.now() - this.stats.startTime;
      const shareRate = (this.stats.shares / uptime) * 1000 * 60; // per minute
      
      logger.info(`Pool Stats - Miners: ${this.stats.connections}, Shares/min: ${shareRate.toFixed(2)}, Valid: ${this.stats.validShares}, Blocks: ${this.stats.blocks}`);
      
      this.emit('stats', {
        ...this.stats,
        uptime,
        shareRate,
        miners: Array.from(this.miners.values()).map(m => ({
          id: m.id,
          address: m.address,
          worker: m.worker,
          difficulty: m.difficulty,
          shares: m.shares,
          validShares: m.validShares,
          shareRate: (m.validShares / (Date.now() - m.connectedAt)) * 1000 * 60
        }))
      });
      
    }, 30000); // Every 30 seconds
  }
  
  /**
   * Get pool statistics
   */
  getStats() {
    const uptime = Date.now() - this.stats.startTime;
    
    return {
      ...this.stats,
      uptime,
      shareRate: (this.stats.shares / uptime) * 1000 * 60,
      validShareRate: (this.stats.validShares / uptime) * 1000 * 60,
      minerList: Array.from(this.miners.values()).map(m => ({
        address: m.address,
        worker: m.worker,
        hashrate: this.estimateHashrate(m),
        shares: m.shares,
        validShares: m.validShares
      }))
    };
  }
  
  /**
   * Estimate miner hashrate
   */
  estimateHashrate(miner) {
    const timeDiff = Date.now() - miner.connectedAt;
    if (timeDiff < 60000) return 0; // Need at least 1 minute of data
    
    const sharesPerSecond = miner.validShares / (timeDiff / 1000);
    const hashrate = sharesPerSecond * miner.difficulty * Math.pow(2, 32);
    
    return hashrate;
  }
  
  /**
   * Handle extranonce.subscribe
   */
  handleExtranonceSubscribe(miner, data) {
    // This allows miners to get new extranonce1 when needed
    const response = {
      id: data.id,
      result: true,
      error: null
    };
    
    this.send(miner, response);
  }
  
  /**
   * Handle mining.get_transactions
   */
  handleGetTransactions(miner, data) {
    // Return transaction list for the current job
    const job = this.currentJob;
    const transactions = job ? job.transactions || [] : [];
    
    const response = {
      id: data.id,
      result: transactions,
      error: null
    };
    
    this.send(miner, response);
  }
}

module.exports = SecureStratumServer;