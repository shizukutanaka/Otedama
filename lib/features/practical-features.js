/**
 * Practical Features Module
 * Realistic and implementable features only
 */

const EventEmitter = require('events');
const os = require('os');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process').promises;

class PracticalFeatures extends EventEmitter {
  constructor() {
    super();
    
    this.features = {
      monitoring: new SystemMonitoring(),
      optimization: new PerformanceOptimization(),
      poolManagement: new PoolManagement(),
      configuration: new ConfigurationManager(),
      logging: new AdvancedLogging(),
      backup: new SimpleBackup()
    };
  }

  async initialize() {
    console.log('Initializing practical features...');
    
    for (const [name, feature] of Object.entries(this.features)) {
      await feature.initialize();
      console.log(`✓ ${name} initialized`);
    }
  }
}

/**
 * System Monitoring - Real hardware monitoring
 */
class SystemMonitoring {
  constructor() {
    this.metrics = {
      cpu: { usage: 0, temperature: 0 },
      memory: { used: 0, total: 0, percentage: 0 },
      gpu: { usage: 0, temperature: 0, memory: 0 },
      network: { sent: 0, received: 0 },
      uptime: 0
    };
  }

  async initialize() {
    // Start monitoring
    this.startMonitoring();
  }

  startMonitoring() {
    // CPU and Memory monitoring
    setInterval(async () => {
      await this.updateCPUMetrics();
      this.updateMemoryMetrics();
    }, 5000);

    // GPU monitoring (if available)
    setInterval(async () => {
      await this.updateGPUMetrics();
    }, 10000);
  }

  async updateCPUMetrics() {
    const cpus = os.cpus();
    
    // Calculate CPU usage
    let totalIdle = 0;
    let totalTick = 0;
    
    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    });
    
    const idle = totalIdle / cpus.length;
    const total = totalTick / cpus.length;
    const usage = 100 - ~~(100 * idle / total);
    
    this.metrics.cpu.usage = usage;
    
    // Try to get CPU temperature (platform specific)
    try {
      if (process.platform === 'win32') {
        const temp = await this.getWindowsCPUTemp();
        this.metrics.cpu.temperature = temp;
      } else if (process.platform === 'linux') {
        const temp = await this.getLinuxCPUTemp();
        this.metrics.cpu.temperature = temp;
      }
    } catch (error) {
      // Temperature reading not available
    }
  }

  updateMemoryMetrics() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    
    this.metrics.memory = {
      total: totalMem,
      used: usedMem,
      percentage: Math.round((usedMem / totalMem) * 100)
    };
  }

  async updateGPUMetrics() {
    try {
      if (process.platform === 'win32' || process.platform === 'linux') {
        // Try nvidia-smi for NVIDIA GPUs
        const { stdout } = await exec('nvidia-smi --query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total --format=csv,noheader,nounits');
        const [usage, temp, memUsed, memTotal] = stdout.trim().split(', ').map(Number);
        
        this.metrics.gpu = {
          usage,
          temperature: temp,
          memory: Math.round((memUsed / memTotal) * 100)
        };
      }
    } catch (error) {
      // GPU monitoring not available
    }
  }

  async getWindowsCPUTemp() {
    try {
      const { stdout } = await exec('wmic /namespace:\\\\root\\wmi PATH MSAcpi_ThermalZoneTemperature get CurrentTemperature');
      const temp = parseInt(stdout.split('\n')[1]) / 10 - 273.15; // Kelvin to Celsius
      return Math.round(temp);
    } catch (error) {
      return 0;
    }
  }

  async getLinuxCPUTemp() {
    try {
      const temp = await fs.readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8');
      return Math.round(parseInt(temp) / 1000);
    } catch (error) {
      return 0;
    }
  }

  getMetrics() {
    return this.metrics;
  }
}

/**
 * Performance Optimization - Practical optimizations
 */
class PerformanceOptimization {
  constructor() {
    this.settings = {
      cpuAffinity: {
        enabled: false,
        miningCores: [],
        systemCores: [0]
      },
      processPrority: {
        enabled: true,
        priority: 'normal' // low, normal, high
      },
      memoryLimit: {
        enabled: true,
        maxMemoryMB: 4096
      }
    };
  }

  async initialize() {
    // Apply initial optimizations
    await this.applyOptimizations();
  }

  async applyOptimizations() {
    // Set process priority
    if (this.settings.processPrority.enabled) {
      this.setProcessPriority(this.settings.processPrority.priority);
    }

    // Configure CPU affinity if supported
    if (this.settings.cpuAffinity.enabled && process.platform === 'linux') {
      await this.setCPUAffinity();
    }
  }

  setProcessPriority(priority) {
    try {
      const pid = process.pid;
      
      if (process.platform === 'win32') {
        const priorityClass = {
          low: 'BELOW_NORMAL_PRIORITY_CLASS',
          normal: 'NORMAL_PRIORITY_CLASS',
          high: 'ABOVE_NORMAL_PRIORITY_CLASS'
        };
        
        exec(`wmic process where processid=${pid} CALL setpriority "${priorityClass[priority]}"`);
      } else if (process.platform === 'linux') {
        const nice = { low: 10, normal: 0, high: -10 };
        exec(`renice -n ${nice[priority]} -p ${pid}`);
      }
    } catch (error) {
      console.error('Failed to set process priority:', error);
    }
  }

  async setCPUAffinity() {
    try {
      const cpuCount = os.cpus().length;
      const miningCores = [];
      
      // Reserve first core for system, use rest for mining
      for (let i = 1; i < cpuCount; i++) {
        miningCores.push(i);
      }
      
      const mask = miningCores.reduce((acc, core) => acc | (1 << core), 0);
      await exec(`taskset -p ${mask.toString(16)} ${process.pid}`);
      
      this.settings.cpuAffinity.miningCores = miningCores;
    } catch (error) {
      console.error('Failed to set CPU affinity:', error);
    }
  }

  optimizeForMining() {
    const recommendations = [];
    
    // Check available memory
    const freeMem = os.freemem();
    if (freeMem < 2 * 1024 * 1024 * 1024) { // Less than 2GB
      recommendations.push({
        type: 'memory',
        action: 'Close unnecessary applications to free up memory'
      });
    }
    
    // Check CPU usage
    const loadAvg = os.loadavg()[0];
    const cpuCount = os.cpus().length;
    if (loadAvg > cpuCount * 0.8) {
      recommendations.push({
        type: 'cpu',
        action: 'System is under heavy load, consider reducing CPU mining threads'
      });
    }
    
    return recommendations;
  }
}

/**
 * Pool Management - Practical pool features
 */
class PoolManagement {
  constructor() {
    this.pools = new Map();
    this.activePool = null;
    this.failoverEnabled = true;
  }

  async initialize() {
    // Load saved pools
    await this.loadPools();
  }

  async loadPools() {
    try {
      const poolsFile = path.join(process.env.APPDATA || '.', 'otedama', 'pools.json');
      const data = await fs.readFile(poolsFile, 'utf8');
      const pools = JSON.parse(data);
      
      pools.forEach(pool => {
        this.pools.set(pool.id, pool);
      });
    } catch (error) {
      // Use default pools
      this.addDefaultPools();
    }
  }

  addDefaultPools() {
    const defaultPools = [
      {
        id: 'otedama-main',
        name: 'Otedama Main Pool',
        url: 'stratum+tcp://pool.otedama.io:3333',
        priority: 1
      },
      {
        id: 'otedama-backup',
        name: 'Otedama Backup Pool',
        url: 'stratum+tcp://backup.otedama.io:3333',
        priority: 2
      }
    ];
    
    defaultPools.forEach(pool => {
      this.pools.set(pool.id, pool);
    });
  }

  async addPool(poolData) {
    const pool = {
      id: crypto.randomBytes(8).toString('hex'),
      ...poolData,
      added: Date.now(),
      stats: {
        connected: false,
        latency: 0,
        shares: { accepted: 0, rejected: 0 }
      }
    };
    
    this.pools.set(pool.id, pool);
    await this.savePools();
    
    return pool;
  }

  async removePool(poolId) {
    this.pools.delete(poolId);
    await this.savePools();
  }

  async savePools() {
    try {
      const poolsDir = path.join(process.env.APPDATA || '.', 'otedama');
      await fs.mkdir(poolsDir, { recursive: true });
      
      const poolsFile = path.join(poolsDir, 'pools.json');
      const pools = Array.from(this.pools.values());
      await fs.writeFile(poolsFile, JSON.stringify(pools, null, 2));
    } catch (error) {
      console.error('Failed to save pools:', error);
    }
  }

  async testPool(poolUrl) {
    const net = require('net');
    const url = new URL(poolUrl.replace('stratum+tcp://', 'tcp://'));
    
    return new Promise((resolve) => {
      const startTime = Date.now();
      const socket = new net.Socket();
      
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve({ success: false, error: 'Timeout' });
      }, 5000);
      
      socket.connect(parseInt(url.port), url.hostname, () => {
        const latency = Date.now() - startTime;
        clearTimeout(timeout);
        socket.destroy();
        resolve({ success: true, latency });
      });
      
      socket.on('error', (error) => {
        clearTimeout(timeout);
        resolve({ success: false, error: error.message });
      });
    });
  }

  async switchPool(poolId) {
    const pool = this.pools.get(poolId);
    if (!pool) {
      throw new Error('Pool not found');
    }
    
    this.activePool = pool;
    return pool;
  }

  enableFailover(enabled = true) {
    this.failoverEnabled = enabled;
  }

  async checkPoolHealth() {
    const results = new Map();
    
    for (const [id, pool] of this.pools) {
      const health = await this.testPool(pool.url);
      results.set(id, health);
      
      // Update pool stats
      pool.stats.connected = health.success;
      pool.stats.latency = health.latency || 0;
    }
    
    return results;
  }
}

/**
 * Configuration Manager - Settings management
 */
class ConfigurationManager {
  constructor() {
    this.config = {
      mining: {
        algorithm: 'sha256',
        intensity: 'auto',
        threads: 0 // 0 = auto
      },
      hardware: {
        useCPU: true,
        useGPU: true,
        gpuPlatform: 0 // 0 = auto detect
      },
      advanced: {
        workSize: 256,
        vectorSize: 1,
        lookupGap: 2
      }
    };
  }

  async initialize() {
    await this.loadConfig();
  }

  async loadConfig() {
    try {
      const configFile = path.join(process.env.APPDATA || '.', 'otedama', 'config.json');
      const data = await fs.readFile(configFile, 'utf8');
      this.config = { ...this.config, ...JSON.parse(data) };
    } catch (error) {
      // Use default config
      await this.saveConfig();
    }
  }

  async saveConfig() {
    try {
      const configDir = path.join(process.env.APPDATA || '.', 'otedama');
      await fs.mkdir(configDir, { recursive: true });
      
      const configFile = path.join(configDir, 'config.json');
      await fs.writeFile(configFile, JSON.stringify(this.config, null, 2));
    } catch (error) {
      console.error('Failed to save config:', error);
    }
  }

  async updateConfig(updates) {
    this.config = this.deepMerge(this.config, updates);
    await this.saveConfig();
    return this.config;
  }

  deepMerge(target, source) {
    const output = { ...target };
    
    for (const key in source) {
      if (source[key] instanceof Object && key in target) {
        output[key] = this.deepMerge(target[key], source[key]);
      } else {
        output[key] = source[key];
      }
    }
    
    return output;
  }

  getConfig() {
    return this.config;
  }

  async exportConfig(filepath) {
    await fs.writeFile(filepath, JSON.stringify(this.config, null, 2));
  }

  async importConfig(filepath) {
    const data = await fs.readFile(filepath, 'utf8');
    this.config = JSON.parse(data);
    await this.saveConfig();
  }
}

/**
 * Advanced Logging - Comprehensive logging system
 */
class AdvancedLogging {
  constructor() {
    this.logDir = path.join(process.env.APPDATA || '.', 'otedama', 'logs');
    this.currentLogFile = null;
    this.logStream = null;
    this.logLevel = 'info'; // debug, info, warn, error
    this.maxLogSize = 10 * 1024 * 1024; // 10MB
    this.maxLogFiles = 5;
  }

  async initialize() {
    await fs.mkdir(this.logDir, { recursive: true });
    await this.rotateLogFile();
  }

  async rotateLogFile() {
    // Close current stream
    if (this.logStream) {
      this.logStream.end();
    }
    
    // Create new log file
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.currentLogFile = path.join(this.logDir, `otedama-${timestamp}.log`);
    
    // Create write stream
    const { createWriteStream } = require('fs');
    this.logStream = createWriteStream(this.currentLogFile, { flags: 'a' });
    
    // Clean old logs
    await this.cleanOldLogs();
  }

  async cleanOldLogs() {
    try {
      const files = await fs.readdir(this.logDir);
      const logFiles = files
        .filter(f => f.startsWith('otedama-') && f.endsWith('.log'))
        .sort()
        .reverse();
      
      // Remove old files
      for (let i = this.maxLogFiles; i < logFiles.length; i++) {
        await fs.unlink(path.join(this.logDir, logFiles[i]));
      }
    } catch (error) {
      console.error('Failed to clean old logs:', error);
    }
  }

  log(level, message, data = {}) {
    const levels = { debug: 0, info: 1, warn: 2, error: 3 };
    
    if (levels[level] < levels[this.logLevel]) {
      return;
    }
    
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      data,
      pid: process.pid
    };
    
    // Write to file
    if (this.logStream) {
      this.logStream.write(JSON.stringify(logEntry) + '\n');
    }
    
    // Also log to console in development
    if (process.env.NODE_ENV === 'development') {
      console.log(`[${level.toUpperCase()}] ${message}`, data);
    }
  }

  debug(message, data) {
    this.log('debug', message, data);
  }

  info(message, data) {
    this.log('info', message, data);
  }

  warn(message, data) {
    this.log('warn', message, data);
  }

  error(message, data) {
    this.log('error', message, data);
  }

  async getLogs(options = {}) {
    const { lines = 100, level = null, search = null } = options;
    const logs = [];
    
    try {
      const content = await fs.readFile(this.currentLogFile, 'utf8');
      const allLines = content.trim().split('\n');
      
      for (let i = Math.max(0, allLines.length - lines); i < allLines.length; i++) {
        try {
          const log = JSON.parse(allLines[i]);
          
          // Filter by level
          if (level && log.level !== level) continue;
          
          // Filter by search
          if (search && !JSON.stringify(log).includes(search)) continue;
          
          logs.push(log);
        } catch (error) {
          // Skip invalid JSON lines
        }
      }
    } catch (error) {
      console.error('Failed to read logs:', error);
    }
    
    return logs;
  }
}

/**
 * Simple Backup - Basic backup functionality
 */
class SimpleBackup {
  constructor() {
    this.backupDir = path.join(process.env.APPDATA || '.', 'otedama', 'backups');
    this.autoBackupEnabled = true;
    this.backupInterval = 24 * 60 * 60 * 1000; // 24 hours
  }

  async initialize() {
    await fs.mkdir(this.backupDir, { recursive: true });
    
    if (this.autoBackupEnabled) {
      // Schedule automatic backups
      setInterval(() => {
        this.createBackup();
      }, this.backupInterval);
    }
  }

  async createBackup() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `backup-${timestamp}`;
    const backupPath = path.join(this.backupDir, backupName);
    
    try {
      // Create backup directory
      await fs.mkdir(backupPath, { recursive: true });
      
      // Backup configuration files
      const configDir = path.join(process.env.APPDATA || '.', 'otedama');
      const filesToBackup = ['config.json', 'pools.json', 'wallets.json'];
      
      for (const file of filesToBackup) {
        try {
          const sourcePath = path.join(configDir, file);
          const destPath = path.join(backupPath, file);
          await fs.copyFile(sourcePath, destPath);
        } catch (error) {
          // File might not exist
        }
      }
      
      // Create backup info
      const backupInfo = {
        timestamp: Date.now(),
        version: '1.0.4',
        files: filesToBackup
      };
      
      await fs.writeFile(
        path.join(backupPath, 'backup-info.json'),
        JSON.stringify(backupInfo, null, 2)
      );
      
      console.log(`Backup created: ${backupName}`);
      
      // Clean old backups
      await this.cleanOldBackups();
      
      return backupPath;
    } catch (error) {
      console.error('Failed to create backup:', error);
      throw error;
    }
  }

  async restoreBackup(backupName) {
    const backupPath = path.join(this.backupDir, backupName);
    const configDir = path.join(process.env.APPDATA || '.', 'otedama');
    
    try {
      // Read backup info
      const infoPath = path.join(backupPath, 'backup-info.json');
      const info = JSON.parse(await fs.readFile(infoPath, 'utf8'));
      
      // Restore files
      for (const file of info.files) {
        try {
          const sourcePath = path.join(backupPath, file);
          const destPath = path.join(configDir, file);
          await fs.copyFile(sourcePath, destPath);
        } catch (error) {
          console.error(`Failed to restore ${file}:`, error);
        }
      }
      
      console.log(`Backup restored: ${backupName}`);
      return true;
    } catch (error) {
      console.error('Failed to restore backup:', error);
      throw error;
    }
  }

  async listBackups() {
    try {
      const entries = await fs.readdir(this.backupDir, { withFileTypes: true });
      const backups = [];
      
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('backup-')) {
          try {
            const infoPath = path.join(this.backupDir, entry.name, 'backup-info.json');
            const info = JSON.parse(await fs.readFile(infoPath, 'utf8'));
            
            backups.push({
              name: entry.name,
              timestamp: info.timestamp,
              version: info.version,
              size: await this.getDirectorySize(path.join(this.backupDir, entry.name))
            });
          } catch (error) {
            // Invalid backup
          }
        }
      }
      
      return backups.sort((a, b) => b.timestamp - a.timestamp);
    } catch (error) {
      console.error('Failed to list backups:', error);
      return [];
    }
  }

  async cleanOldBackups() {
    const maxBackups = 5;
    const backups = await this.listBackups();
    
    if (backups.length > maxBackups) {
      // Remove oldest backups
      for (let i = maxBackups; i < backups.length; i++) {
        try {
          const backupPath = path.join(this.backupDir, backups[i].name);
          await fs.rmdir(backupPath, { recursive: true });
        } catch (error) {
          console.error(`Failed to remove old backup ${backups[i].name}:`, error);
        }
      }
    }
  }

  async getDirectorySize(dirPath) {
    let size = 0;
    
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        
        if (entry.isDirectory()) {
          size += await this.getDirectorySize(fullPath);
        } else {
          const stats = await fs.stat(fullPath);
          size += stats.size;
        }
      }
    } catch (error) {
      // Ignore errors
    }
    
    return size;
  }
}

module.exports = PracticalFeatures;