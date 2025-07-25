/**
 * Stratum Client - Otedama
 * Stratum protocol client for pool connection
 * 
 * Design principles:
 * - Robust connection handling (Carmack)
 * - Clean protocol abstraction (Martin)
 * - Simple, reliable implementation (Pike)
 */

import { EventEmitter } from 'events';
import net from 'net';
import tls from 'tls';
import { URL } from 'url';
import { createLogger } from '../core/logger.js';

const logger = createLogger('StratumClient');

export class StratumClient extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      url: config.url || 'stratum+tcp://localhost:3333',
      user: config.user || 'worker',
      password: config.password || 'x',
      algorithm: config.algorithm || 'sha256',
      reconnectDelay: config.reconnectDelay || 5000,
      maxReconnects: config.maxReconnects || 10,
      timeout: config.timeout || 30000,
      ...config
    };
    
    // Parse URL
    const parsed = new URL(this.config.url.replace('stratum+tcp://', 'tcp://'));
    this.host = parsed.hostname;
    this.port = parseInt(parsed.port) || 3333;
    this.ssl = this.config.url.includes('stratum+ssl://');
    
    // Connection state
    this.socket = null;
    this.connected = false;
    this.authorized = false;
    this.reconnectAttempts = 0;
    
    // Protocol state
    this.messageId = 1;
    this.pendingMessages = new Map();
    this.extraNonce1 = null;
    this.extraNonce2Size = 4;
    this.sessionId = null;
    
    // Current work
    this.currentJob = null;
    this.difficulty = 1;
    
    // Buffer for incomplete messages
    this.dataBuffer = '';
  }
  
  /**
   * Connect to pool
   */
  async connect() {
    return new Promise((resolve, reject) => {
      logger.info(`Connecting to ${this.host}:${this.port}${this.ssl ? ' (SSL)' : ''}`);
      
      // Create socket
      if (this.ssl) {
        this.socket = tls.connect({
          host: this.host,
          port: this.port,
          rejectUnauthorized: false
        });
      } else {
        this.socket = net.createConnection({
          host: this.host,
          port: this.port
        });
      }
      
      // Set timeout
      this.socket.setTimeout(this.config.timeout);
      
      // Socket event handlers
      this.socket.on('connect', () => {
        logger.info('Connected to pool');
        this.connected = true;
        this.reconnectAttempts = 0;
        this.subscribe();
        resolve();
      });
      
      this.socket.on('data', (data) => {
        this.handleData(data);
      });
      
      this.socket.on('error', (error) => {
        logger.error('Socket error:', error.message);
        this.emit('error', error);
        
        if (!this.connected) {
          reject(error);
        }
      });
      
      this.socket.on('close', () => {
        logger.warn('Connection closed');
        this.handleDisconnect();
      });
      
      this.socket.on('timeout', () => {
        logger.error('Connection timeout');
        this.socket.destroy();
      });
    });
  }
  
  /**
   * Disconnect from pool
   */
  async disconnect() {
    this.connected = false;
    this.authorized = false;
    
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
  
  /**
   * Handle incoming data
   */
  handleData(data) {
    this.dataBuffer += data.toString();
    
    // Process complete messages
    let newlineIndex;
    while ((newlineIndex = this.dataBuffer.indexOf('\n')) !== -1) {
      const message = this.dataBuffer.substring(0, newlineIndex);
      this.dataBuffer = this.dataBuffer.substring(newlineIndex + 1);
      
      if (message.length > 0) {
        this.handleMessage(message);
      }
    }
  }
  
  /**
   * Handle stratum message
   */
  handleMessage(message) {
    try {
      const data = JSON.parse(message);
      
      // Handle responses
      if (data.id !== null && data.id !== undefined) {
        const pending = this.pendingMessages.get(data.id);
        if (pending) {
          this.pendingMessages.delete(data.id);
          
          if (data.error) {
            pending.reject(new Error(data.error[1] || 'Unknown error'));
          } else {
            pending.resolve(data.result);
          }
        }
      }
      
      // Handle notifications
      if (data.method) {
        this.handleNotification(data);
      }
      
    } catch (error) {
      logger.error('Failed to parse message:', error);
    }
  }
  
  /**
   * Handle stratum notification
   */
  handleNotification(data) {
    switch (data.method) {
      case 'mining.notify':
        this.handleNewJob(data.params);
        break;
        
      case 'mining.set_difficulty':
        this.handleSetDifficulty(data.params);
        break;
        
      case 'mining.set_extranonce':
        this.handleSetExtranonce(data.params);
        break;
        
      case 'client.reconnect':
        this.handleReconnect(data.params);
        break;
        
      case 'client.show_message':
        logger.info(`Pool message: ${data.params[0]}`);
        break;
    }
  }
  
  /**
   * Subscribe to pool
   */
  async subscribe() {
    try {
      const result = await this.sendMessage('mining.subscribe', [
        `Otedama/${this.config.algorithm}`,
        this.sessionId
      ]);
      
      if (Array.isArray(result) && result.length >= 2) {
        // Extract subscription info
        this.sessionId = result[0]?.[0]?.[1];
        this.extraNonce1 = result[1];
        this.extraNonce2Size = result[2] || 4;
        
        logger.info(`Subscribed with extra nonce: ${this.extraNonce1}`);
        
        // Authorize worker
        await this.authorize();
      }
      
    } catch (error) {
      logger.error('Subscription failed:', error);
      throw error;
    }
  }
  
  /**
   * Authorize worker
   */
  async authorize() {
    try {
      const result = await this.sendMessage('mining.authorize', [
        this.config.user,
        this.config.password
      ]);
      
      if (result === true) {
        logger.info('Worker authorized');
        this.authorized = true;
        this.emit('authorized');
      } else {
        throw new Error('Authorization failed');
      }
      
    } catch (error) {
      logger.error('Authorization failed:', error);
      throw error;
    }
  }
  
  /**
   * Submit share
   */
  async submitShare(share) {
    if (!this.authorized) {
      throw new Error('Not authorized');
    }
    
    const params = [
      this.config.user,
      share.jobId,
      share.extraNonce2,
      share.ntime,
      share.nonce
    ];
    
    try {
      const result = await this.sendMessage('mining.submit', params);
      
      if (result === true) {
        this.emit('accepted', share);
      } else {
        this.emit('rejected', share, 'Unknown reason');
      }
      
      return result;
      
    } catch (error) {
      this.emit('rejected', share, error.message);
      throw error;
    }
  }
  
  /**
   * Handle new job
   */
  handleNewJob(params) {
    const [
      jobId,
      prevHash,
      coinbase1,
      coinbase2,
      merkleBranch,
      version,
      nbits,
      ntime,
      cleanJobs
    ] = params;
    
    this.currentJob = {
      jobId,
      prevHash,
      coinbase1,
      coinbase2,
      merkleBranch,
      version,
      nbits,
      ntime,
      cleanJobs,
      extraNonce1: this.extraNonce1
    };
    
    logger.debug(`New job: ${jobId}`);
    
    this.emit('job', this.currentJob);
  }
  
  /**
   * Handle difficulty change
   */
  handleSetDifficulty(params) {
    this.difficulty = params[0];
    logger.info(`Difficulty set to ${this.difficulty}`);
    this.emit('difficulty', this.difficulty);
  }
  
  /**
   * Handle extranonce change
   */
  handleSetExtranonce(params) {
    this.extraNonce1 = params[0];
    this.extraNonce2Size = params[1];
    logger.info(`Extra nonce updated: ${this.extraNonce1}`);
  }
  
  /**
   * Handle reconnect request
   */
  handleReconnect(params) {
    const [host, port, wait] = params;
    
    logger.info(`Pool requested reconnect to ${host}:${port} in ${wait} seconds`);
    
    setTimeout(() => {
      this.config.url = `stratum+tcp://${host}:${port}`;
      this.reconnect();
    }, wait * 1000);
  }
  
  /**
   * Send message to pool
   */
  sendMessage(method, params = []) {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error('Not connected'));
        return;
      }
      
      const id = this.messageId++;
      const message = {
        id,
        method,
        params
      };
      
      // Store callback
      this.pendingMessages.set(id, { resolve, reject });
      
      // Send message
      this.socket.write(JSON.stringify(message) + '\n');
      
      // Timeout
      setTimeout(() => {
        if (this.pendingMessages.has(id)) {
          this.pendingMessages.delete(id);
          reject(new Error('Request timeout'));
        }
      }, this.config.timeout);
    });
  }
  
  /**
   * Handle disconnect
   */
  handleDisconnect() {
    this.connected = false;
    this.authorized = false;
    
    // Clear pending messages
    for (const [id, pending] of this.pendingMessages) {
      pending.reject(new Error('Connection lost'));
    }
    this.pendingMessages.clear();
    
    this.emit('disconnected');
    
    // Attempt reconnect
    if (this.reconnectAttempts < this.config.maxReconnects) {
      this.reconnect();
    }
  }
  
  /**
   * Reconnect to pool
   */
  reconnect() {
    this.reconnectAttempts++;
    
    logger.info(`Reconnecting... (attempt ${this.reconnectAttempts}/${this.config.maxReconnects})`);
    
    setTimeout(() => {
      this.connect().catch(error => {
        logger.error('Reconnection failed:', error);
      });
    }, this.config.reconnectDelay);
  }
  
  /**
   * Get current job
   */
  getCurrentJob() {
    return this.currentJob;
  }
  
  /**
   * Get current difficulty
   */
  getDifficulty() {
    return this.difficulty;
  }
  
  /**
   * Get extra nonce info
   */
  getExtraNonce() {
    return {
      extraNonce1: this.extraNonce1,
      extraNonce2Size: this.extraNonce2Size
    };
  }
}

export default StratumClient;