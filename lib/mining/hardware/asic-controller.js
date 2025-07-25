/**
 * ASIC Controller - Otedama
 * ASIC mining hardware controller
 * 
 * Design principles:
 * - Hardware abstraction for various ASICs (Carmack)
 * - Clean command interface (Martin)
 * - Simple, reliable communication (Pike)
 */

import { EventEmitter } from 'events';
import { SerialPort } from 'serialport';
import net from 'net';
import { createLogger } from '../../core/logger.js';

const logger = createLogger('ASICController');

// Common ASIC models and their characteristics
const ASIC_MODELS = {
  'Antminer S19': {
    hashrate: 95000000000000, // 95 TH/s
    power: 3250, // Watts
    algorithm: 'sha256',
    interface: 'network'
  },
  'Antminer L7': {
    hashrate: 9500000000, // 9.5 GH/s
    power: 3425,
    algorithm: 'scrypt',
    interface: 'network'
  },
  'Whatsminer M30S': {
    hashrate: 100000000000000, // 100 TH/s
    power: 3400,
    algorithm: 'sha256',
    interface: 'network'
  },
  'USB Block Erupter': {
    hashrate: 333000000, // 333 MH/s
    power: 2.5,
    algorithm: 'sha256',
    interface: 'usb'
  }
};

export class ASICController extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      device: config.device || {},
      algorithm: config.algorithm || 'sha256',
      ...config
    };
    
    this.id = `asic-${this.config.device.id || Date.now()}`;
    this.name = this.config.device.model || 'Unknown ASIC';
    this.connection = null;
    this.currentJob = null;
    this.difficulty = 1;
    this.isRunning = false;
    
    // Get model info
    this.modelInfo = ASIC_MODELS[this.name] || {
      hashrate: 1000000000, // 1 GH/s default
      power: 100,
      algorithm: 'sha256',
      interface: 'usb'
    };
    
    // Statistics
    this.stats = {
      hashes: 0,
      shares: 0,
      hashrate: 0,
      temperature: 0,
      fanSpeed: 0,
      powerDraw: this.modelInfo.power,
      chipStatus: [],
      lastUpdate: Date.now()
    };
  }
  
  /**
   * Initialize ASIC controller
   */
  async initialize() {
    logger.info(`Initializing ASIC controller for ${this.name}`);
    
    try {
      // Connect based on interface type
      if (this.modelInfo.interface === 'network') {
        await this.connectNetwork();
      } else if (this.modelInfo.interface === 'usb') {
        await this.connectUSB();
      }
      
      // Get ASIC info
      await this.getDeviceInfo();
      
      // Start monitoring
      this.startMonitoring();
      
      logger.info(`ASIC ${this.name} initialized`);
    } catch (error) {
      logger.error(`Failed to initialize ASIC ${this.name}:`, error);
      throw error;
    }
  }
  
  /**
   * Connect to network ASIC
   */
  async connectNetwork() {
    return new Promise((resolve, reject) => {
      const host = this.config.device.host || '192.168.1.100';
      const port = this.config.device.port || 4028;
      
      logger.info(`Connecting to ASIC at ${host}:${port}`);
      
      this.connection = net.createConnection(port, host);
      
      this.connection.on('connect', () => {
        logger.info(`Connected to ASIC at ${host}:${port}`);
        resolve();
      });
      
      this.connection.on('data', (data) => {
        this.handleData(data);
      });
      
      this.connection.on('error', (error) => {
        logger.error(`ASIC connection error:`, error);
        reject(error);
      });
      
      this.connection.on('close', () => {
        logger.warn(`ASIC connection closed`);
        if (this.isRunning) {
          this.reconnect();
        }
      });
    });
  }
  
  /**
   * Connect to USB ASIC
   */
  async connectUSB() {
    const path = this.config.device.path || '/dev/ttyUSB0';
    const baudRate = this.config.device.baudRate || 115200;
    
    logger.info(`Connecting to USB ASIC at ${path}`);
    
    return new Promise((resolve, reject) => {
      this.connection = new SerialPort({
        path,
        baudRate,
        autoOpen: false
      });
      
      this.connection.on('open', () => {
        logger.info(`Connected to USB ASIC at ${path}`);
        resolve();
      });
      
      this.connection.on('data', (data) => {
        this.handleData(data);
      });
      
      this.connection.on('error', (error) => {
        logger.error(`USB ASIC error:`, error);
        reject(error);
      });
      
      this.connection.open();
    });
  }
  
  /**
   * Get device information
   */
  async getDeviceInfo() {
    // Send version command
    const response = await this.sendCommand('version');
    
    if (response) {
      logger.info(`ASIC info: ${JSON.stringify(response)}`);
      
      // Update stats with device info
      if (response.chips) {
        this.stats.chipStatus = new Array(response.chips).fill('OK');
      }
    }
  }
  
  /**
   * Start mining
   */
  async start() {
    if (this.isRunning) {
      return;
    }
    
    logger.info(`Starting ASIC ${this.name} mining`);
    
    this.isRunning = true;
    
    // Enable mining
    await this.sendCommand('enable');
    
    // Set initial work if available
    if (this.currentJob) {
      await this.sendWork(this.currentJob);
    }
    
    this.emit('started');
  }
  
  /**
   * Stop mining
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }
    
    logger.info(`Stopping ASIC ${this.name} mining`);
    
    this.isRunning = false;
    
    // Disable mining
    await this.sendCommand('disable');
    
    this.emit('stopped');
  }
  
  /**
   * Set new job
   */
  async setJob(job) {
    this.currentJob = job;
    
    if (this.isRunning) {
      await this.sendWork(job);
    }
  }
  
  /**
   * Send work to ASIC
   */
  async sendWork(job) {
    // Format work for ASIC
    const work = {
      jobId: job.jobId,
      prevHash: job.prevHash,
      coinbase1: job.coinbase1,
      coinbase2: job.coinbase2,
      merkleBranch: job.merkleBranch,
      version: job.version,
      nbits: job.nbits,
      ntime: job.ntime,
      target: this.difficultyToTarget(this.difficulty)
    };
    
    // Send work command
    await this.sendCommand('work', work);
  }
  
  /**
   * Set difficulty
   */
  setDifficulty(difficulty) {
    this.difficulty = difficulty;
    
    if (this.isRunning && this.currentJob) {
      // Update target on ASIC
      this.sendCommand('target', {
        target: this.difficultyToTarget(difficulty)
      });
    }
  }
  
  /**
   * Send command to ASIC
   */
  async sendCommand(command, params = {}) {
    return new Promise((resolve, reject) => {
      const request = {
        command,
        parameter: params,
        id: Date.now()
      };
      
      const data = JSON.stringify(request) + '\n';
      
      // Store callback
      this.pendingCommands = this.pendingCommands || {};
      this.pendingCommands[request.id] = { resolve, reject };
      
      // Send command
      if (this.connection) {
        if (this.modelInfo.interface === 'network') {
          this.connection.write(data);
        } else {
          this.connection.write(data);
        }
      }
      
      // Timeout
      setTimeout(() => {
        if (this.pendingCommands[request.id]) {
          delete this.pendingCommands[request.id];
          reject(new Error('Command timeout'));
        }
      }, 5000);
    });
  }
  
  /**
   * Handle data from ASIC
   */
  handleData(data) {
    const messages = data.toString().split('\n').filter(m => m.length > 0);
    
    for (const message of messages) {
      try {
        const parsed = JSON.parse(message);
        
        if (parsed.id && this.pendingCommands && this.pendingCommands[parsed.id]) {
          // Response to command
          const callback = this.pendingCommands[parsed.id];
          delete this.pendingCommands[parsed.id];
          callback.resolve(parsed);
        } else if (parsed.result) {
          // Share result
          this.handleResult(parsed);
        } else if (parsed.stats) {
          // Status update
          this.handleStats(parsed.stats);
        }
      } catch (error) {
        logger.debug('Failed to parse ASIC message:', message);
      }
    }
  }
  
  /**
   * Handle mining result
   */
  handleResult(result) {
    if (result.status === 'accepted') {
      this.stats.shares++;
      
      const share = {
        nonce: result.nonce,
        difficulty: result.difficulty || this.difficulty,
        timestamp: Date.now()
      };
      
      logger.info(`ASIC ${this.name} found share with difficulty ${share.difficulty}`);
      
      this.emit('share', {
        ...share,
        miner: this.name,
        device: 'ASIC'
      });
    }
  }
  
  /**
   * Handle statistics update
   */
  handleStats(stats) {
    // Update stats
    if (stats.hashrate !== undefined) {
      this.stats.hashrate = stats.hashrate;
    }
    
    if (stats.temperature !== undefined) {
      this.stats.temperature = stats.temperature;
      this.emit('temperature', stats.temperature);
    }
    
    if (stats.fanSpeed !== undefined) {
      this.stats.fanSpeed = stats.fanSpeed;
    }
    
    if (stats.chips !== undefined) {
      // Update chip status
      for (let i = 0; i < stats.chips.length; i++) {
        this.stats.chipStatus[i] = stats.chips[i].status || 'OK';
      }
    }
    
    this.stats.lastUpdate = Date.now();
    this.emit('hashrate', this.stats.hashrate);
  }
  
  /**
   * Start monitoring
   */
  startMonitoring() {
    // Poll for stats
    this.monitoringInterval = setInterval(async () => {
      if (this.isRunning) {
        try {
          await this.sendCommand('stats');
        } catch (error) {
          logger.debug('Failed to get ASIC stats:', error.message);
        }
      }
    }, 5000);
    
    // Simulate stats for testing
    if (this.config.simulate) {
      this.simulateStats();
    }
  }
  
  /**
   * Simulate statistics
   */
  simulateStats() {
    setInterval(() => {
      // Simulate based on model
      this.stats.hashrate = this.modelInfo.hashrate * (0.95 + Math.random() * 0.1);
      this.stats.temperature = 65 + Math.random() * 15;
      this.stats.fanSpeed = 70 + Math.random() * 20;
      
      this.emit('hashrate', this.stats.hashrate);
      this.emit('temperature', this.stats.temperature);
      
      // Simulate finding shares
      if (Math.random() < 0.001) {
        this.handleResult({
          status: 'accepted',
          nonce: Math.floor(Math.random() * 0xFFFFFFFF),
          difficulty: this.difficulty
        });
      }
    }, 1000);
  }
  
  /**
   * Convert difficulty to target
   */
  difficultyToTarget(difficulty) {
    const maxTarget = BigInt('0x00000000ffff0000000000000000000000000000000000000000000000000000');
    const target = maxTarget / BigInt(Math.floor(difficulty));
    return '0x' + target.toString(16).padStart(64, '0');
  }
  
  /**
   * Reconnect to ASIC
   */
  async reconnect() {
    logger.info(`Reconnecting to ASIC ${this.name}...`);
    
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    try {
      if (this.modelInfo.interface === 'network') {
        await this.connectNetwork();
      } else {
        await this.connectUSB();
      }
      
      if (this.isRunning) {
        await this.start();
      }
    } catch (error) {
      logger.error('Reconnection failed:', error);
      setTimeout(() => this.reconnect(), 30000);
    }
  }
  
  /**
   * Apply settings
   */
  async applySettings(settings) {
    // ASICs typically have limited configurability
    if (settings.frequency !== undefined) {
      await this.setFrequency(settings.frequency);
    }
    
    if (settings.voltage !== undefined) {
      await this.setVoltage(settings.voltage);
    }
  }
  
  /**
   * Set chip frequency
   */
  async setFrequency(frequency) {
    await this.sendCommand('setfreq', { frequency });
    logger.info(`ASIC ${this.name} frequency set to ${frequency} MHz`);
  }
  
  /**
   * Set voltage
   */
  async setVoltage(voltage) {
    await this.sendCommand('setvoltage', { voltage });
    logger.info(`ASIC ${this.name} voltage set to ${voltage}V`);
  }
  
  /**
   * Throttle ASIC
   */
  throttle() {
    logger.warn(`Throttling ASIC ${this.name}`);
    // Most ASICs auto-throttle, but we can reduce frequency
    this.setFrequency(550); // Lower frequency
  }
  
  /**
   * Get hashrate
   */
  getHashrate() {
    return this.stats.hashrate;
  }
  
  /**
   * Get statistics
   */
  getStats() {
    const deadChips = this.stats.chipStatus.filter(s => s !== 'OK').length;
    
    return {
      id: this.id,
      name: this.name,
      type: 'ASIC',
      algorithm: this.modelInfo.algorithm,
      ...this.stats,
      chipCount: this.stats.chipStatus.length,
      deadChips,
      efficiency: this.stats.shares > 0 ? this.stats.hashes / this.stats.shares : 0
    };
  }
  
  /**
   * Cleanup
   */
  async cleanup() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }
    
    await this.stop();
    
    if (this.connection) {
      if (this.modelInfo.interface === 'network') {
        this.connection.destroy();
      } else {
        this.connection.close();
      }
    }
  }
}

export default ASICController;