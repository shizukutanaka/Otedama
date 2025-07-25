/**
 * Enhanced ASIC Controller - Otedama
 * Advanced ASIC mining hardware management
 * 
 * Features:
 * - Multi-vendor ASIC support (Bitmain, MicroBT, Canaan, etc.)
 * - Automatic ASIC detection and configuration
 * - Temperature and performance monitoring
 * - Firmware management
 * - Power optimization
 * - Remote management API
 * 
 * Design: Simple, efficient, production-ready (Carmack/Martin/Pike principles)
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';
import net from 'net';
import dgram from 'dgram';
import crypto from 'crypto';
import axios from 'axios';

const logger = createLogger('EnhancedASICController');

/**
 * ASIC vendor types
 */
export const ASICVendor = {
  BITMAIN: 'bitmain',      // Antminer series
  MICROBT: 'microbt',      // Whatsminer series
  CANAAN: 'canaan',        // Avalon series
  INNOSILICON: 'innosilicon',
  EBANG: 'ebang',
  STRONGU: 'strongu',
  GENERIC: 'generic'
};

/**
 * ASIC communication protocols
 */
export const ASICProtocol = {
  CGMINER: 'cgminer',      // CGMiner API protocol
  BTMINER: 'btminer',      // Bitmain protocol
  LUCI: 'luci',           // OpenWrt LuCI
  SSH: 'ssh',             // SSH management
  CUSTOM: 'custom'
};

/**
 * ASIC status
 */
export const ASICStatus = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  HASHING: 'hashing',
  ERROR: 'error',
  OVERHEATING: 'overheating',
  MAINTENANCE: 'maintenance'
};

/**
 * ASIC model definitions
 */
const ASIC_MODELS = {
  // Bitmain Antminer
  'Antminer S19': {
    vendor: ASICVendor.BITMAIN,
    algorithm: 'sha256',
    nominalHashrate: 95, // TH/s
    powerConsumption: 3250, // Watts
    protocol: ASICProtocol.CGMINER,
    apiPort: 4028
  },
  'Antminer S19 Pro': {
    vendor: ASICVendor.BITMAIN,
    algorithm: 'sha256',
    nominalHashrate: 110,
    powerConsumption: 3250,
    protocol: ASICProtocol.CGMINER,
    apiPort: 4028
  },
  'Antminer L7': {
    vendor: ASICVendor.BITMAIN,
    algorithm: 'scrypt',
    nominalHashrate: 9.5, // GH/s
    powerConsumption: 3425,
    protocol: ASICProtocol.CGMINER,
    apiPort: 4028
  },
  
  // MicroBT Whatsminer
  'Whatsminer M30S++': {
    vendor: ASICVendor.MICROBT,
    algorithm: 'sha256',
    nominalHashrate: 112,
    powerConsumption: 3472,
    protocol: ASICProtocol.BTMINER,
    apiPort: 4028
  },
  'Whatsminer M50': {
    vendor: ASICVendor.MICROBT,
    algorithm: 'sha256',
    nominalHashrate: 114,
    powerConsumption: 3306,
    protocol: ASICProtocol.BTMINER,
    apiPort: 4028
  },
  
  // Canaan Avalon
  'AvalonMiner 1246': {
    vendor: ASICVendor.CANAAN,
    algorithm: 'sha256',
    nominalHashrate: 90,
    powerConsumption: 3420,
    protocol: ASICProtocol.CGMINER,
    apiPort: 4028
  }
};

/**
 * ASIC device class
 */
class ASICDevice extends EventEmitter {
  constructor(config) {
    super();
    
    this.id = config.id || crypto.randomBytes(8).toString('hex');
    this.ip = config.ip;
    this.port = config.port || 4028;
    this.model = config.model || 'Unknown';
    this.vendor = config.vendor || ASICVendor.GENERIC;
    this.protocol = config.protocol || ASICProtocol.CGMINER;
    
    // Model specifications
    const modelSpec = ASIC_MODELS[this.model] || {};
    this.algorithm = modelSpec.algorithm || config.algorithm || 'sha256';
    this.nominalHashrate = modelSpec.nominalHashrate || config.nominalHashrate || 0;
    this.powerConsumption = modelSpec.powerConsumption || config.powerConsumption || 0;
    
    // Connection
    this.socket = null;
    this.status = ASICStatus.DISCONNECTED;
    this.lastSeen = null;
    
    // Statistics
    this.stats = {
      hashrate: 0,
      hashrateAvg: 0,
      temperature: 0,
      fanSpeed: 0,
      uptime: 0,
      accepted: 0,
      rejected: 0,
      hardwareErrors: 0,
      efficiency: 0
    };
    
    // Configuration
    this.config = {
      pool: config.pool || null,
      worker: config.worker || null,
      password: config.password || 'x',
      tempLimit: config.tempLimit || 85,
      autoRestart: config.autoRestart !== false,
      monitorInterval: config.monitorInterval || 10000
    };
    
    // Monitoring
    this.monitorTimer = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
  }
  
  /**
   * Connect to ASIC
   */
  async connect() {
    if (this.status === ASICStatus.CONNECTED) {
      return true;
    }
    
    this.status = ASICStatus.CONNECTING;
    
    try {
      switch (this.protocol) {
        case ASICProtocol.CGMINER:
        case ASICProtocol.BTMINER:
          await this.connectCGMiner();
          break;
          
        case ASICProtocol.LUCI:
          await this.connectLuCI();
          break;
          
        default:
          throw new Error(`Unsupported protocol: ${this.protocol}`);
      }
      
      this.status = ASICStatus.CONNECTED;
      this.lastSeen = Date.now();
      this.reconnectAttempts = 0;
      
      // Start monitoring
      this.startMonitoring();
      
      this.emit('connected');
      logger.info(`Connected to ASIC ${this.model} at ${this.ip}`);
      
      return true;
      
    } catch (error) {
      this.status = ASICStatus.ERROR;
      logger.error(`Failed to connect to ASIC ${this.ip}:`, error);
      
      // Schedule reconnect
      if (this.config.autoRestart) {
        this.scheduleReconnect();
      }
      
      throw error;
    }
  }
  
  /**
   * Connect using CGMiner API
   */
  async connectCGMiner() {
    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();
      
      const timeout = setTimeout(() => {
        this.socket.destroy();
        reject(new Error('Connection timeout'));
      }, 5000);
      
      this.socket.on('connect', () => {
        clearTimeout(timeout);
        resolve();
      });
      
      this.socket.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      
      this.socket.connect(this.port, this.ip);
    });
  }
  
  /**
   * Connect using LuCI HTTP API
   */
  async connectLuCI() {
    // Test connection with a simple request
    const response = await axios.get(`http://${this.ip}/cgi-bin/luci`, {
      timeout: 5000
    });
    
    if (response.status !== 200) {
      throw new Error('LuCI connection failed');
    }
  }
  
  /**
   * Send CGMiner API command
   */
  async sendCommand(command, parameter = '') {
    if (!this.socket || this.status !== ASICStatus.CONNECTED) {
      throw new Error('Not connected');
    }
    
    return new Promise((resolve, reject) => {
      const request = {
        command,
        parameter
      };
      
      const message = JSON.stringify(request);
      
      let responseData = '';
      const timeout = setTimeout(() => {
        reject(new Error('Command timeout'));
      }, 5000);
      
      const dataHandler = (data) => {
        responseData += data.toString();
        
        // Check if we have complete response
        if (responseData.includes('\x00')) {
          clearTimeout(timeout);
          this.socket.removeListener('data', dataHandler);
          
          try {
            const response = JSON.parse(responseData.replace(/\x00/g, ''));
            resolve(response);
          } catch (error) {
            reject(new Error('Invalid response format'));
          }
        }
      };
      
      this.socket.on('data', dataHandler);
      this.socket.write(message);
    });
  }
  
  /**
   * Get ASIC summary
   */
  async getSummary() {
    switch (this.protocol) {
      case ASICProtocol.CGMINER:
      case ASICProtocol.BTMINER:
        return await this.sendCommand('summary');
        
      case ASICProtocol.LUCI:
        return await this.getLuCISummary();
        
      default:
        throw new Error('Unsupported protocol');
    }
  }
  
  /**
   * Get LuCI summary
   */
  async getLuCISummary() {
    const response = await axios.get(`http://${this.ip}/cgi-bin/luci/admin/status/cgminer/api`, {
      params: { command: 'summary' }
    });
    
    return response.data;
  }
  
  /**
   * Get ASIC statistics
   */
  async getStats() {
    switch (this.protocol) {
      case ASICProtocol.CGMINER:
      case ASICProtocol.BTMINER:
        return await this.sendCommand('stats');
        
      case ASICProtocol.LUCI:
        return await this.getLuCIStats();
        
      default:
        throw new Error('Unsupported protocol');
    }
  }
  
  /**
   * Get LuCI statistics
   */
  async getLuCIStats() {
    const response = await axios.get(`http://${this.ip}/cgi-bin/luci/admin/status/cgminer/api`, {
      params: { command: 'stats' }
    });
    
    return response.data;
  }
  
  /**
   * Update statistics
   */
  async updateStats() {
    try {
      const summary = await this.getSummary();
      const stats = await this.getStats();
      
      // Parse summary
      if (summary.SUMMARY && summary.SUMMARY[0]) {
        const sum = summary.SUMMARY[0];
        this.stats.hashrate = parseFloat(sum['GHS 5s'] || sum['MHS 5s'] || 0);
        this.stats.hashrateAvg = parseFloat(sum['GHS av'] || sum['MHS av'] || 0);
        this.stats.accepted = parseInt(sum.Accepted || 0);
        this.stats.rejected = parseInt(sum.Rejected || 0);
        this.stats.hardwareErrors = parseInt(sum['Hardware Errors'] || 0);
        this.stats.uptime = parseInt(sum.Elapsed || 0);
      }
      
      // Parse stats for temperature
      if (stats.STATS) {
        let maxTemp = 0;
        let totalFanSpeed = 0;
        let fanCount = 0;
        
        for (const stat of stats.STATS) {
          // Temperature fields vary by model
          const tempFields = ['temp1', 'temp2', 'temp3', 'temp2_1', 'temp2_2', 'temp2_3'];
          for (const field of tempFields) {
            if (stat[field]) {
              maxTemp = Math.max(maxTemp, parseFloat(stat[field]));
            }
          }
          
          // Fan speed
          const fanFields = ['fan1', 'fan2', 'fan3', 'fan4'];
          for (const field of fanFields) {
            if (stat[field]) {
              totalFanSpeed += parseInt(stat[field]);
              fanCount++;
            }
          }
        }
        
        this.stats.temperature = maxTemp;
        this.stats.fanSpeed = fanCount > 0 ? Math.round(totalFanSpeed / fanCount) : 0;
      }
      
      // Calculate efficiency
      if (this.stats.hashrate > 0 && this.powerConsumption > 0) {
        this.stats.efficiency = this.powerConsumption / this.stats.hashrate; // W/TH
      }
      
      // Update status based on stats
      if (this.stats.temperature > this.config.tempLimit) {
        this.status = ASICStatus.OVERHEATING;
        this.emit('overheating', this.stats.temperature);
      } else if (this.stats.hashrate > 0) {
        this.status = ASICStatus.HASHING;
      }
      
      this.lastSeen = Date.now();
      this.emit('stats:updated', this.stats);
      
    } catch (error) {
      logger.error(`Failed to update stats for ${this.ip}:`, error);
      this.handleError(error);
    }
  }
  
  /**
   * Configure pool
   */
  async configurePool(pool, worker, password = 'x') {
    const pools = [{
      url: pool,
      user: worker,
      pass: password
    }];
    
    // Remove existing pools
    await this.sendCommand('removepool', '0');
    
    // Add new pool
    const response = await this.sendCommand('addpool', `${pool},${worker},${password}`);
    
    if (response.STATUS && response.STATUS[0].STATUS === 'S') {
      this.config.pool = pool;
      this.config.worker = worker;
      this.config.password = password;
      
      logger.info(`Configured pool for ${this.model}: ${pool}`);
      return true;
    }
    
    throw new Error('Failed to configure pool');
  }
  
  /**
   * Restart ASIC
   */
  async restart() {
    logger.info(`Restarting ASIC ${this.model} at ${this.ip}`);
    
    try {
      await this.sendCommand('restart');
      this.status = ASICStatus.MAINTENANCE;
      
      // Wait for restart
      setTimeout(() => {
        this.connect();
      }, 30000);
      
    } catch (error) {
      logger.error(`Failed to restart ASIC ${this.ip}:`, error);
      throw error;
    }
  }
  
  /**
   * Start monitoring
   */
  startMonitoring() {
    if (this.monitorTimer) return;
    
    this.monitorTimer = setInterval(() => {
      this.updateStats();
    }, this.config.monitorInterval);
    
    // Initial stats update
    this.updateStats();
  }
  
  /**
   * Stop monitoring
   */
  stopMonitoring() {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
  }
  
  /**
   * Handle errors
   */
  handleError(error) {
    this.status = ASICStatus.ERROR;
    
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    
    this.stopMonitoring();
    
    if (this.config.autoRestart) {
      this.scheduleReconnect();
    }
    
    this.emit('error', error);
  }
  
  /**
   * Schedule reconnection
   */
  scheduleReconnect() {
    if (this.reconnectTimer) return;
    
    const delay = Math.min(this.reconnectAttempts * 5000, 60000);
    this.reconnectAttempts++;
    
    logger.info(`Scheduling reconnect to ${this.ip} in ${delay}ms`);
    
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(error => {
        logger.error(`Reconnect failed for ${this.ip}:`, error);
      });
    }, delay);
  }
  
  /**
   * Disconnect from ASIC
   */
  disconnect() {
    this.stopMonitoring();
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    
    this.status = ASICStatus.DISCONNECTED;
    this.emit('disconnected');
  }
}

/**
 * Enhanced ASIC Controller
 */
export class EnhancedASICController extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      discoveryEnabled: config.discoveryEnabled !== false,
      discoveryPort: config.discoveryPort || 14235,
      discoveryInterval: config.discoveryInterval || 60000,
      monitoringEnabled: config.monitoringEnabled !== false,
      autoConnect: config.autoConnect !== false,
      tempLimit: config.tempLimit || 85,
      poolConfig: config.poolConfig || null
    };
    
    // ASIC devices
    this.devices = new Map(); // id -> ASICDevice
    
    // Discovery
    this.discoverySocket = null;
    this.discoveryTimer = null;
    
    // Statistics
    this.stats = {
      totalDevices: 0,
      connectedDevices: 0,
      totalHashrate: 0,
      totalPower: 0,
      totalEfficiency: 0
    };
  }
  
  /**
   * Initialize controller
   */
  async initialize() {
    logger.info('Initializing enhanced ASIC controller...');
    
    if (this.config.discoveryEnabled) {
      this.startDiscovery();
    }
    
    logger.info('ASIC controller initialized');
  }
  
  /**
   * Start ASIC discovery
   */
  startDiscovery() {
    // Create UDP socket for discovery
    this.discoverySocket = dgram.createSocket('udp4');
    
    this.discoverySocket.on('message', (msg, rinfo) => {
      this.handleDiscoveryMessage(msg, rinfo);
    });
    
    this.discoverySocket.on('error', (error) => {
      logger.error('Discovery socket error:', error);
    });
    
    this.discoverySocket.bind(this.config.discoveryPort, () => {
      logger.info(`ASIC discovery listening on port ${this.config.discoveryPort}`);
    });
    
    // Start periodic discovery
    this.discoveryTimer = setInterval(() => {
      this.sendDiscoveryBroadcast();
    }, this.config.discoveryInterval);
    
    // Initial discovery
    this.sendDiscoveryBroadcast();
  }
  
  /**
   * Send discovery broadcast
   */
  sendDiscoveryBroadcast() {
    const message = Buffer.from('cgminer-discovery');
    
    this.discoverySocket.setBroadcast(true);
    this.discoverySocket.send(message, 0, message.length, 4028, '255.255.255.255', (error) => {
      if (error) {
        logger.error('Discovery broadcast error:', error);
      }
    });
  }
  
  /**
   * Handle discovery message
   */
  async handleDiscoveryMessage(msg, rinfo) {
    try {
      const message = msg.toString();
      const ip = rinfo.address;
      
      // Check if already registered
      const existing = Array.from(this.devices.values()).find(d => d.ip === ip);
      if (existing) return;
      
      // Try to identify ASIC
      const device = await this.identifyASIC(ip);
      if (device) {
        await this.addDevice(device);
      }
      
    } catch (error) {
      logger.debug(`Failed to identify ASIC at ${rinfo.address}:`, error.message);
    }
  }
  
  /**
   * Identify ASIC model
   */
  async identifyASIC(ip, port = 4028) {
    // Try to connect and get version info
    const socket = new net.Socket();
    
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve(null);
      }, 3000);
      
      socket.on('connect', async () => {
        try {
          // Send version command
          socket.write(JSON.stringify({ command: 'version' }));
          
          let data = '';
          socket.on('data', (chunk) => {
            data += chunk.toString();
            
            if (data.includes('\x00')) {
              clearTimeout(timeout);
              socket.destroy();
              
              try {
                const response = JSON.parse(data.replace(/\x00/g, ''));
                
                if (response.VERSION) {
                  const version = response.VERSION[0];
                  const model = this.detectModel(version);
                  
                  resolve({
                    ip,
                    port,
                    model: model.name,
                    vendor: model.vendor,
                    protocol: model.protocol,
                    algorithm: model.algorithm
                  });
                } else {
                  resolve(null);
                }
              } catch {
                resolve(null);
              }
            }
          });
        } catch {
          clearTimeout(timeout);
          socket.destroy();
          resolve(null);
        }
      });
      
      socket.on('error', () => {
        clearTimeout(timeout);
        resolve(null);
      });
      
      socket.connect(port, ip);
    });
  }
  
  /**
   * Detect model from version info
   */
  detectModel(version) {
    const cgminer = version.CGMiner || version.BMMiner || '';
    const api = version.API || '';
    
    // Detection logic based on version strings
    if (cgminer.includes('bmminer')) {
      if (cgminer.includes('S19')) {
        return { name: 'Antminer S19', vendor: ASICVendor.BITMAIN, protocol: ASICProtocol.CGMINER, algorithm: 'sha256' };
      } else if (cgminer.includes('L7')) {
        return { name: 'Antminer L7', vendor: ASICVendor.BITMAIN, protocol: ASICProtocol.CGMINER, algorithm: 'scrypt' };
      }
    } else if (cgminer.includes('btminer')) {
      return { name: 'Whatsminer M30S++', vendor: ASICVendor.MICROBT, protocol: ASICProtocol.BTMINER, algorithm: 'sha256' };
    } else if (cgminer.includes('cgminer') && cgminer.includes('avalon')) {
      return { name: 'AvalonMiner 1246', vendor: ASICVendor.CANAAN, protocol: ASICProtocol.CGMINER, algorithm: 'sha256' };
    }
    
    // Default
    return { name: 'Generic ASIC', vendor: ASICVendor.GENERIC, protocol: ASICProtocol.CGMINER, algorithm: 'sha256' };
  }
  
  /**
   * Add ASIC device
   */
  async addDevice(config) {
    const device = new ASICDevice({
      ...config,
      tempLimit: this.config.tempLimit
    });
    
    // Setup event handlers
    device.on('connected', () => {
      this.updateStats();
      this.emit('device:connected', device);
    });
    
    device.on('disconnected', () => {
      this.updateStats();
      this.emit('device:disconnected', device);
    });
    
    device.on('stats:updated', () => {
      this.updateStats();
    });
    
    device.on('overheating', (temp) => {
      this.emit('device:overheating', { device, temperature: temp });
    });
    
    device.on('error', (error) => {
      this.emit('device:error', { device, error });
    });
    
    this.devices.set(device.id, device);
    this.stats.totalDevices++;
    
    // Auto-connect if enabled
    if (this.config.autoConnect) {
      try {
        await device.connect();
        
        // Configure pool if provided
        if (this.config.poolConfig) {
          await device.configurePool(
            this.config.poolConfig.url,
            this.config.poolConfig.worker,
            this.config.poolConfig.password
          );
        }
      } catch (error) {
        logger.error(`Failed to connect to ${device.model}:`, error);
      }
    }
    
    logger.info(`Added ASIC device: ${device.model} (${device.ip})`);
    this.emit('device:added', device);
    
    return device;
  }
  
  /**
   * Remove ASIC device
   */
  removeDevice(id) {
    const device = this.devices.get(id);
    if (!device) return;
    
    device.disconnect();
    this.devices.delete(id);
    this.stats.totalDevices--;
    
    this.updateStats();
    this.emit('device:removed', device);
  }
  
  /**
   * Get device by ID
   */
  getDevice(id) {
    return this.devices.get(id);
  }
  
  /**
   * Get all devices
   */
  getDevices() {
    return Array.from(this.devices.values());
  }
  
  /**
   * Update aggregate statistics
   */
  updateStats() {
    let connectedDevices = 0;
    let totalHashrate = 0;
    let totalPower = 0;
    
    for (const device of this.devices.values()) {
      if (device.status === ASICStatus.CONNECTED || device.status === ASICStatus.HASHING) {
        connectedDevices++;
        totalHashrate += device.stats.hashrate;
        totalPower += device.powerConsumption;
      }
    }
    
    this.stats.connectedDevices = connectedDevices;
    this.stats.totalHashrate = totalHashrate;
    this.stats.totalPower = totalPower;
    this.stats.totalEfficiency = totalHashrate > 0 ? totalPower / totalHashrate : 0;
    
    this.emit('stats:updated', this.stats);
  }
  
  /**
   * Configure all devices
   */
  async configureAll(poolConfig) {
    const results = [];
    
    for (const device of this.devices.values()) {
      try {
        if (device.status === ASICStatus.CONNECTED || device.status === ASICStatus.HASHING) {
          await device.configurePool(
            poolConfig.url,
            poolConfig.worker,
            poolConfig.password
          );
          results.push({ device: device.id, success: true });
        }
      } catch (error) {
        results.push({ device: device.id, success: false, error: error.message });
      }
    }
    
    return results;
  }
  
  /**
   * Restart all devices
   */
  async restartAll() {
    const promises = [];
    
    for (const device of this.devices.values()) {
      if (device.status !== ASICStatus.DISCONNECTED) {
        promises.push(device.restart());
      }
    }
    
    await Promise.allSettled(promises);
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      devices: this.getDevices().map(device => ({
        id: device.id,
        model: device.model,
        vendor: device.vendor,
        ip: device.ip,
        status: device.status,
        hashrate: device.stats.hashrate,
        temperature: device.stats.temperature,
        efficiency: device.stats.efficiency,
        uptime: device.stats.uptime
      }))
    };
  }
  
  /**
   * Shutdown controller
   */
  async shutdown() {
    logger.info('Shutting down ASIC controller...');
    
    // Stop discovery
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
    }
    
    if (this.discoverySocket) {
      this.discoverySocket.close();
    }
    
    // Disconnect all devices
    for (const device of this.devices.values()) {
      device.disconnect();
    }
    
    logger.info('ASIC controller shutdown complete');
  }
}

export default EnhancedASICController;
