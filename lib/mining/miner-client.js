/**
 * Miner Client
 * Manages local mining operations with BTC address registration,
 * CPU/GPU selection, background running, and idle detection
 */

const { EventEmitter } = require('events');
const { createLogger } = require('../core/logger');
const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

const logger = createLogger('miner-client');

class MinerClient extends EventEmitter {
  constructor(configPath = './config/miner-client-config.json') {
    super();
    
    this.configPath = configPath;
    this.config = null;
    this.minerProcess = null;
    this.isRunning = false;
    this.isPaused = false;
    this.idleTimer = null;
    this.lastActivity = Date.now();
    
    // Hardware detection
    this.hardware = {
      cpuCores: os.cpus().length,
      gpuDevices: [],
      totalMemory: os.totalmem()
    };
    
    // Performance stats
    this.stats = {
      hashrate: 0,
      shares: {
        accepted: 0,
        rejected: 0,
        total: 0
      },
      uptime: 0,
      temperature: {
        cpu: 0,
        gpu: []
      }
    };
  }
  
  /**
   * Initialize miner client
   */
  async initialize() {
    try {
      // Load configuration
      await this.loadConfig();
      
      // Validate BTC address
      if (!this.config.miner.btcAddress) {
        throw new Error('BTC address not configured. Please set your BTC address in the config.');
      }
      
      if (!this.isValidBitcoinAddress(this.config.miner.btcAddress)) {
        throw new Error('Invalid BTC address format');
      }
      
      // Detect GPUs
      await this.detectGPUs();
      
      // Setup idle detection if enabled
      if (this.config.miner.idleMining.enabled) {
        this.setupIdleDetection();
      }
      
      // Setup system tray if running in background
      if (this.config.miner.startup.runInBackground || this.config.miner.startup.minimized) {
        await this.setupSystemTray();
      }
      
      logger.info('Miner client initialized successfully');
      logger.info(`BTC Address: ${this.config.miner.btcAddress}`);
      logger.info(`CPU Mining: ${this.config.miner.hardware.useCPU ? 'Enabled' : 'Disabled'}`);
      logger.info(`GPU Mining: ${this.config.miner.hardware.useGPU ? 'Enabled' : 'Disabled'}`);
      
      return true;
    } catch (error) {
      logger.error('Failed to initialize miner client:', error);
      throw error;
    }
  }
  
  /**
   * Load configuration from file
   */
  async loadConfig() {
    try {
      const configData = await fs.readFile(this.configPath, 'utf8');
      this.config = JSON.parse(configData);
      
      // Apply defaults
      this.applyConfigDefaults();
      
      return this.config;
    } catch (error) {
      if (error.code === 'ENOENT') {
        // Create default config if not exists
        await this.createDefaultConfig();
        return this.loadConfig();
      }
      throw error;
    }
  }
  
  /**
   * Save configuration
   */
  async saveConfig() {
    try {
      const configDir = path.dirname(this.configPath);
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2));
      logger.info('Configuration saved');
    } catch (error) {
      logger.error('Failed to save configuration:', error);
      throw error;
    }
  }
  
  /**
   * Update BTC address
   */
  async updateBTCAddress(address) {
    if (!this.isValidBitcoinAddress(address)) {
      throw new Error('Invalid BTC address format');
    }
    
    this.config.miner.btcAddress = address;
    await this.saveConfig();
    
    // Restart miner if running
    if (this.isRunning) {
      await this.restart();
    }
    
    logger.info(`BTC address updated: ${address}`);
    this.emit('btc-address-updated', address);
  }
  
  /**
   * Update hardware settings
   */
  async updateHardwareSettings(settings) {
    Object.assign(this.config.miner.hardware, settings);
    await this.saveConfig();
    
    // Restart miner if running
    if (this.isRunning) {
      await this.restart();
    }
    
    logger.info('Hardware settings updated');
    this.emit('hardware-settings-updated', settings);
  }
  
  /**
   * Start mining
   */
  async start() {
    if (this.isRunning) {
      logger.warn('Miner is already running');
      return;
    }
    
    try {
      // Build miner command
      const command = this.buildMinerCommand();
      
      logger.info('Starting miner...');
      logger.debug(`Command: ${command.cmd} ${command.args.join(' ')}`);
      
      // Spawn miner process
      this.minerProcess = spawn(command.cmd, command.args, {
        cwd: process.cwd(),
        env: { ...process.env, ...command.env },
        detached: this.config.miner.startup.runInBackground
      });
      
      // Setup process handlers
      this.setupProcessHandlers();
      
      this.isRunning = true;
      this.emit('started');
      
      logger.info('Miner started successfully');
    } catch (error) {
      logger.error('Failed to start miner:', error);
      throw error;
    }
  }
  
  /**
   * Stop mining
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }
    
    logger.info('Stopping miner...');
    
    if (this.minerProcess) {
      this.minerProcess.kill('SIGTERM');
      
      // Wait for process to exit
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          this.minerProcess.kill('SIGKILL');
          resolve();
        }, 5000);
        
        this.minerProcess.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    
    this.isRunning = false;
    this.minerProcess = null;
    this.emit('stopped');
    
    logger.info('Miner stopped');
  }
  
  /**
   * Restart miner
   */
  async restart() {
    await this.stop();
    await this.start();
  }
  
  /**
   * Pause mining
   */
  pause() {
    if (!this.isRunning || this.isPaused) {
      return;
    }
    
    if (this.minerProcess) {
      this.minerProcess.kill('SIGSTOP');
    }
    
    this.isPaused = true;
    this.emit('paused');
    logger.info('Mining paused');
  }
  
  /**
   * Resume mining
   */
  resume() {
    if (!this.isRunning || !this.isPaused) {
      return;
    }
    
    if (this.minerProcess) {
      this.minerProcess.kill('SIGCONT');
    }
    
    this.isPaused = false;
    this.emit('resumed');
    logger.info('Mining resumed');
  }
  
  /**
   * Setup idle detection
   */
  setupIdleDetection() {
    const config = this.config.miner.idleMining;
    
    // Monitor system activity
    this.idleTimer = setInterval(() => {
      const idleTime = Date.now() - this.lastActivity;
      
      if (idleTime >= config.idleTime && !this.isRunning) {
        // System is idle, start mining
        logger.info('System idle detected, starting mining...');
        this.start().catch(error => {
          logger.error('Failed to start idle mining:', error);
        });
      } else if (idleTime < config.resumeDelay && this.isRunning && config.pauseOnActivity) {
        // Activity detected, pause mining
        logger.info('Activity detected, pausing mining...');
        this.pause();
        
        // Resume after delay
        setTimeout(() => {
          if (Date.now() - this.lastActivity >= config.resumeDelay) {
            this.resume();
          }
        }, config.resumeDelay);
      }
    }, config.checkInterval);
    
    // Hook into system activity events
    if (process.platform === 'win32') {
      this.setupWindowsActivityDetection();
    } else if (process.platform === 'linux') {
      this.setupLinuxActivityDetection();
    } else if (process.platform === 'darwin') {
      this.setupMacActivityDetection();
    }
  }
  
  /**
   * Setup Windows activity detection
   */
  setupWindowsActivityDetection() {
    try {
      const ioHook = require('iohook');
      
      ioHook.on('mousemove', () => {
        this.lastActivity = Date.now();
      });
      
      ioHook.on('keydown', () => {
        this.lastActivity = Date.now();
      });
      
      ioHook.start();
    } catch (error) {
      logger.warn('Failed to setup Windows activity detection:', error);
    }
  }
  
  /**
   * Setup Linux activity detection
   */
  setupLinuxActivityDetection() {
    // Use X11 idle time
    const checkIdleTime = () => {
      const { exec } = require('child_process');
      exec('xprintidle', (error, stdout) => {
        if (!error) {
          const idleMs = parseInt(stdout.trim());
          if (idleMs < 1000) {
            this.lastActivity = Date.now();
          }
        }
      });
    };
    
    setInterval(checkIdleTime, 1000);
  }
  
  /**
   * Setup Mac activity detection
   */
  setupMacActivityDetection() {
    // Use ioreg to check idle time
    const checkIdleTime = () => {
      const { exec } = require('child_process');
      exec('ioreg -c IOHIDSystem | awk \'/HIDIdleTime/ {print $NF/1000000000; exit}\'', (error, stdout) => {
        if (!error) {
          const idleSeconds = parseFloat(stdout.trim());
          if (idleSeconds < 1) {
            this.lastActivity = Date.now();
          }
        }
      });
    };
    
    setInterval(checkIdleTime, 1000);
  }
  
  /**
   * Setup system tray
   */
  async setupSystemTray() {
    try {
      const { Tray, Menu, app } = require('electron');
      
      // Create tray icon
      this.tray = new Tray(path.join(__dirname, '../../assets/icon.png'));
      
      // Create context menu
      const contextMenu = Menu.buildFromTemplate([
        {
          label: 'Show',
          click: () => this.emit('show-window')
        },
        {
          label: 'Start Mining',
          click: () => this.start(),
          enabled: !this.isRunning
        },
        {
          label: 'Stop Mining',
          click: () => this.stop(),
          enabled: this.isRunning
        },
        { type: 'separator' },
        {
          label: 'Settings',
          click: () => this.emit('open-settings')
        },
        { type: 'separator' },
        {
          label: 'Exit',
          click: () => {
            this.stop().then(() => {
              app.quit();
            });
          }
        }
      ]);
      
      this.tray.setToolTip(`Otedama Miner\nStatus: ${this.isRunning ? 'Running' : 'Stopped'}`);
      this.tray.setContextMenu(contextMenu);
      
      // Update tray on status change
      this.on('started', () => {
        this.tray.setToolTip(`Otedama Miner\nStatus: Running\nHashrate: ${this.stats.hashrate}`);
      });
      
      this.on('stopped', () => {
        this.tray.setToolTip('Otedama Miner\nStatus: Stopped');
      });
    } catch (error) {
      logger.warn('Failed to setup system tray:', error);
    }
  }
  
  /**
   * Build miner command
   */
  buildMinerCommand() {
    const config = this.config.miner;
    const pool = this.config.pools[0]; // Use first pool
    
    // Base command (using xmrig as example)
    const cmd = 'xmrig';
    const args = [];
    const env = {};
    
    // Pool configuration
    args.push('-o', pool.url);
    args.push('-u', config.btcAddress);
    args.push('-p', config.workerName);
    
    // Hardware configuration
    if (config.hardware.useCPU) {
      if (config.hardware.cpuThreads > 0) {
        args.push('-t', config.hardware.cpuThreads.toString());
      }
    } else {
      args.push('--no-cpu');
    }
    
    if (config.hardware.useGPU) {
      if (config.hardware.gpuDevices !== 'all') {
        args.push('--cuda-devices', config.hardware.gpuDevices);
      }
    } else {
      args.push('--no-cuda');
      args.push('--no-opencl');
    }
    
    // Performance settings
    if (config.performance.priority === 'low') {
      args.push('--cpu-priority', '0');
    } else if (config.performance.priority === 'high') {
      args.push('--cpu-priority', '5');
    }
    
    args.push('--cpu-max-threads-hint', config.performance.cpuIntensity.toString());
    
    // Logging
    args.push('--log-file', path.join('logs', 'xmrig.log'));
    args.push('--print-time', '10');
    
    return { cmd, args, env };
  }
  
  /**
   * Setup process handlers
   */
  setupProcessHandlers() {
    if (!this.minerProcess) return;
    
    // Handle stdout
    this.minerProcess.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      lines.forEach(line => {
        if (line.trim()) {
          this.parseOutput(line);
        }
      });
    });
    
    // Handle stderr
    this.minerProcess.stderr.on('data', (data) => {
      logger.error('Miner error:', data.toString());
    });
    
    // Handle exit
    this.minerProcess.on('exit', (code, signal) => {
      logger.info(`Miner process exited with code ${code} and signal ${signal}`);
      this.isRunning = false;
      this.minerProcess = null;
      this.emit('exited', { code, signal });
      
      // Auto-restart if not stopped intentionally
      if (code !== 0 && this.config.miner.autoRestart) {
        setTimeout(() => {
          logger.info('Auto-restarting miner...');
          this.start().catch(error => {
            logger.error('Failed to auto-restart miner:', error);
          });
        }, 5000);
      }
    });
  }
  
  /**
   * Parse miner output
   */
  parseOutput(line) {
    // Parse hashrate
    const hashrateMatch = line.match(/speed.*?(\d+\.\d+)\s*(H\/s|KH\/s|MH\/s|GH\/s)/i);
    if (hashrateMatch) {
      let hashrate = parseFloat(hashrateMatch[1]);
      const unit = hashrateMatch[2].toLowerCase();
      
      // Convert to H/s
      if (unit === 'kh/s') hashrate *= 1000;
      else if (unit === 'mh/s') hashrate *= 1000000;
      else if (unit === 'gh/s') hashrate *= 1000000000;
      
      this.stats.hashrate = hashrate;
      this.emit('hashrate-update', hashrate);
    }
    
    // Parse shares
    if (line.includes('accepted')) {
      this.stats.shares.accepted++;
      this.stats.shares.total++;
      this.emit('share-accepted');
    } else if (line.includes('rejected')) {
      this.stats.shares.rejected++;
      this.stats.shares.total++;
      this.emit('share-rejected');
    }
    
    // Parse temperature
    const tempMatch = line.match(/temp.*?(\d+)°?C/i);
    if (tempMatch) {
      const temp = parseInt(tempMatch[1]);
      if (line.toLowerCase().includes('cpu')) {
        this.stats.temperature.cpu = temp;
      } else if (line.toLowerCase().includes('gpu')) {
        this.stats.temperature.gpu.push(temp);
      }
      
      // Check temperature limit
      if (temp > this.config.miner.performance.temperatureLimit) {
        logger.warn(`Temperature limit exceeded: ${temp}°C`);
        this.emit('temperature-warning', temp);
        
        // Pause mining if temperature is too high
        if (temp > this.config.miner.performance.temperatureLimit + 10) {
          this.pause();
          setTimeout(() => this.resume(), 60000); // Resume after 1 minute
        }
      }
    }
    
    // Log all output in debug mode
    logger.debug('Miner output:', line);
  }
  
  /**
   * Detect GPUs
   */
  async detectGPUs() {
    try {
      const { exec } = require('child_process');
      const util = require('util');
      const execPromise = util.promisify(exec);
      
      if (process.platform === 'win32') {
        // Use wmic on Windows
        const { stdout } = await execPromise('wmic path win32_VideoController get name');
        const lines = stdout.split('\n').slice(1); // Skip header
        this.hardware.gpuDevices = lines
          .map(line => line.trim())
          .filter(line => line && !line.includes('Microsoft'));
      } else if (process.platform === 'linux') {
        // Use lspci on Linux
        try {
          const { stdout } = await execPromise('lspci | grep -E "VGA|3D"');
          this.hardware.gpuDevices = stdout.split('\n')
            .filter(line => line.trim())
            .map(line => line.split(': ')[1] || line);
        } catch (error) {
          // Try nvidia-smi as fallback
          try {
            const { stdout } = await execPromise('nvidia-smi --query-gpu=name --format=csv,noheader');
            this.hardware.gpuDevices = stdout.split('\n').filter(line => line.trim());
          } catch (error) {
            logger.warn('Failed to detect NVIDIA GPUs');
          }
        }
      }
      
      logger.info(`Detected ${this.hardware.gpuDevices.length} GPU(s):`, this.hardware.gpuDevices);
    } catch (error) {
      logger.warn('Failed to detect GPUs:', error);
    }
  }
  
  /**
   * Validate Bitcoin address
   */
  isValidBitcoinAddress(address) {
    if (!address || typeof address !== 'string') return false;
    
    // P2PKH addresses (Legacy) - start with 1
    if (address.match(/^1[a-km-zA-HJ-NP-Z1-9]{25,34}$/)) {
      return true;
    }
    
    // P2SH addresses (SegWit compatible) - start with 3
    if (address.match(/^3[a-km-zA-HJ-NP-Z1-9]{25,34}$/)) {
      return true;
    }
    
    // Bech32 addresses (Native SegWit) - start with bc1
    if (address.match(/^bc1[a-z0-9]{39,59}$/)) {
      return true;
    }
    
    return false;
  }
  
  /**
   * Apply configuration defaults
   */
  applyConfigDefaults() {
    const defaults = {
      miner: {
        btcAddress: '',
        workerName: os.hostname(),
        hardware: {
          useCPU: true,
          useGPU: true,
          cpuThreads: Math.max(1, Math.floor(os.cpus().length / 2)),
          gpuDevices: 'all'
        },
        startup: {
          minimized: false,
          runInBackground: false,
          startOnBoot: false,
          hideToTray: true
        },
        idleMining: {
          enabled: false,
          idleTime: 300000,
          checkInterval: 30000,
          pauseOnActivity: true,
          resumeDelay: 5000
        },
        performance: {
          priority: 'normal',
          cpuIntensity: 50,
          gpuIntensity: 80,
          temperatureLimit: 80,
          pauseOnBattery: true
        },
        autoRestart: true
      },
      pools: [
        {
          name: 'Otedama Pool',
          url: 'stratum+tcp://localhost:3333',
          priority: 1
        }
      ],
      logging: {
        level: 'info',
        file: 'logs/miner.log',
        maxSize: '10MB',
        maxFiles: 5
      }
    };
    
    // Deep merge with defaults
    this.config = this.deepMerge(defaults, this.config || {});
  }
  
  /**
   * Deep merge objects
   */
  deepMerge(target, source) {
    const output = Object.assign({}, target);
    if (this.isObject(target) && this.isObject(source)) {
      Object.keys(source).forEach(key => {
        if (this.isObject(source[key])) {
          if (!(key in target))
            Object.assign(output, { [key]: source[key] });
          else
            output[key] = this.deepMerge(target[key], source[key]);
        } else {
          Object.assign(output, { [key]: source[key] });
        }
      });
    }
    return output;
  }
  
  /**
   * Check if value is object
   */
  isObject(item) {
    return item && typeof item === 'object' && !Array.isArray(item);
  }
  
  /**
   * Create default configuration
   */
  async createDefaultConfig() {
    this.config = {};
    this.applyConfigDefaults();
    await this.saveConfig();
  }
  
  /**
   * Get current status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      btcAddress: this.config?.miner?.btcAddress || '',
      hardware: {
        ...this.hardware,
        settings: this.config?.miner?.hardware || {}
      },
      stats: this.stats,
      uptime: this.isRunning ? Date.now() - this.startTime : 0
    };
  }
}

module.exports = MinerClient;