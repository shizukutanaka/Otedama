const EventEmitter = require('events');
const fs = require('fs').promises;
const path = require('path');
const AutoSetupWizard = require('./auto-setup-wizard');
const { spawn } = require('child_process');

class OneClickMining extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      // Quick start settings
      autoStart: options.autoStart !== false,
      autoRestart: options.autoRestart !== false,
      crashRecovery: options.crashRecovery !== false,
      
      // User preferences
      preset: options.preset || 'balanced', // conservative, balanced, aggressive
      anonymous: options.anonymous || false,
      
      // Paths
      configPath: options.configPath || './configs/auto-config.json',
      logPath: options.logPath || './logs/one-click.log',
      
      // Timeouts
      setupTimeout: options.setupTimeout || 30000,
      startTimeout: options.startTimeout || 10000
    };
    
    this.wizard = new AutoSetupWizard();
    this.miningProcess = null;
    this.status = 'idle';
    this.startTime = null;
    this.statistics = {
      totalShares: 0,
      acceptedShares: 0,
      rejectedShares: 0,
      hashrate: 0,
      uptime: 0
    };
  }
  
  async start(walletAddress) {
    try {
      this.emit('starting');
      this.status = 'starting';
      
      // Validate wallet address
      if (!this.validateWallet(walletAddress)) {
        throw new Error('Invalid wallet address');
      }
      
      // Step 1: Run auto-setup wizard
      this.emit('setupProgress', { stage: 'wizard', progress: 10 });
      const wizardResult = await this.wizard.quickStart(walletAddress);
      
      // Step 2: Save configuration
      this.emit('setupProgress', { stage: 'config', progress: 30 });
      await this.saveConfiguration(wizardResult.configuration);
      
      // Step 3: Download/update miners if needed
      this.emit('setupProgress', { stage: 'miners', progress: 50 });
      await this.ensureMiners();
      
      // Step 4: Start mining
      this.emit('setupProgress', { stage: 'launch', progress: 80 });
      await this.startMining(wizardResult.configuration);
      
      // Step 5: Verify mining is working
      this.emit('setupProgress', { stage: 'verify', progress: 90 });
      await this.verifyMining();
      
      this.status = 'mining';
      this.startTime = Date.now();
      
      this.emit('started', {
        configuration: wizardResult.configuration,
        estimatedEarnings: wizardResult.estimatedEarnings,
        hardware: this.wizard.detectedHardware
      });
      
      // Start monitoring
      this.startMonitoring();
      
      return {
        success: true,
        configuration: wizardResult.configuration,
        estimatedEarnings: wizardResult.estimatedEarnings
      };
      
    } catch (error) {
      this.status = 'error';
      this.emit('error', error);
      
      // Auto-recovery
      if (this.config.crashRecovery) {
        this.emit('recoveryAttempt');
        setTimeout(() => this.start(walletAddress), 5000);
      }
      
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  async stop() {
    this.emit('stopping');
    this.status = 'stopping';
    
    if (this.miningProcess) {
      // Graceful shutdown
      this.miningProcess.kill('SIGTERM');
      
      // Wait for process to exit
      await new Promise((resolve) => {
        this.miningProcess.on('exit', resolve);
        
        // Force kill after 5 seconds
        setTimeout(() => {
          if (this.miningProcess) {
            this.miningProcess.kill('SIGKILL');
          }
          resolve();
        }, 5000);
      });
    }
    
    this.miningProcess = null;
    this.status = 'idle';
    this.emit('stopped');
  }
  
  validateWallet(address) {
    // Basic wallet validation for common formats
    
    // Bitcoin
    if (/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) return true;
    if (/^bc1[a-z0-9]{39,59}$/.test(address)) return true;
    
    // Ethereum
    if (/^0x[a-fA-F0-9]{40}$/.test(address)) return true;
    
    // Monero
    if (/^4[0-9AB][0-9a-zA-Z]{93}$/.test(address)) return true;
    
    // Generic check for other cryptocurrencies
    if (address.length >= 20 && address.length <= 100) return true;
    
    return false;
  }
  
  async saveConfiguration(config) {
    const configDir = path.dirname(this.config.configPath);
    
    // Create directory if it doesn't exist
    await fs.mkdir(configDir, { recursive: true });
    
    // Add metadata
    const fullConfig = {
      ...config,
      metadata: {
        created: new Date().toISOString(),
        version: '0.1.5',
        wizard: 'one-click',
        preset: this.config.preset
      }
    };
    
    await fs.writeFile(
      this.config.configPath,
      JSON.stringify(fullConfig, null, 2)
    );
  }
  
  async ensureMiners() {
    // Check if miners are installed
    const minersPath = path.join(__dirname, '../../miners');
    
    try {
      await fs.access(minersPath);
    } catch (error) {
      // Miners directory doesn't exist, create it
      await fs.mkdir(minersPath, { recursive: true });
      
      // In production, would download miners here
      this.emit('minerDownload', { status: 'required' });
      
      // For now, just create placeholder
      await fs.writeFile(
        path.join(minersPath, 'README.md'),
        'Place miner executables in this directory'
      );
    }
  }
  
  async startMining(config) {
    const args = [
      path.join(__dirname, '../../index.js'),
      '--config', this.config.configPath,
      '--one-click-mode'
    ];
    
    // Add hardware-specific arguments
    if (config.cpu.enabled) {
      args.push('--cpu', config.cpu.threads);
    }
    
    if (config.gpu.enabled) {
      args.push('--gpu', config.gpu.devices.map(d => d.index).join(','));
    }
    
    // Spawn mining process
    this.miningProcess = spawn('node', args, {
      cwd: path.join(__dirname, '../..'),
      env: {
        ...process.env,
        ONE_CLICK_MODE: 'true',
        AUTO_RESTART: this.config.autoRestart ? 'true' : 'false'
      }
    });
    
    // Handle process output
    this.miningProcess.stdout.on('data', (data) => {
      const message = data.toString();
      this.emit('minerOutput', message);
      this.parseOutput(message);
    });
    
    this.miningProcess.stderr.on('data', (data) => {
      this.emit('minerError', data.toString());
    });
    
    this.miningProcess.on('exit', (code) => {
      this.emit('minerExit', code);
      
      if (this.config.autoRestart && this.status === 'mining') {
        this.emit('autoRestart');
        setTimeout(() => this.startMining(config), 3000);
      }
    });
  }
  
  async verifyMining() {
    // Wait for mining to stabilize
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Check if process is still running
    if (!this.miningProcess || this.miningProcess.exitCode !== null) {
      throw new Error('Mining process failed to start');
    }
    
    // Additional verification could be added here
    return true;
  }
  
  parseOutput(output) {
    // Parse common miner output patterns
    
    // Hashrate detection
    const hashrateMatch = output.match(/(?:hashrate|speed)[:\s]+(\d+\.?\d*)\s*([KMGT]?H\/s)/i);
    if (hashrateMatch) {
      this.statistics.hashrate = this.parseHashrate(hashrateMatch[1], hashrateMatch[2]);
    }
    
    // Share detection
    if (output.match(/share\s+accepted/i)) {
      this.statistics.acceptedShares++;
      this.statistics.totalShares++;
      this.emit('shareAccepted');
    } else if (output.match(/share\s+rejected/i)) {
      this.statistics.rejectedShares++;
      this.statistics.totalShares++;
      this.emit('shareRejected');
    }
    
    // Temperature detection
    const tempMatch = output.match(/(?:temp|temperature)[:\s]+(\d+)/i);
    if (tempMatch) {
      this.emit('temperature', parseInt(tempMatch[1]));
    }
  }
  
  parseHashrate(value, unit) {
    const multipliers = {
      'H/s': 1,
      'KH/s': 1000,
      'MH/s': 1000000,
      'GH/s': 1000000000,
      'TH/s': 1000000000000
    };
    
    return parseFloat(value) * (multipliers[unit] || 1);
  }
  
  startMonitoring() {
    // Update statistics every 10 seconds
    this.monitoringInterval = setInterval(() => {
      if (this.status === 'mining' && this.startTime) {
        this.statistics.uptime = Date.now() - this.startTime;
        
        this.emit('statistics', {
          ...this.statistics,
          efficiency: this.statistics.totalShares > 0 
            ? (this.statistics.acceptedShares / this.statistics.totalShares * 100).toFixed(2)
            : 0
        });
      }
    }, 10000);
  }
  
  stopMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
  }
  
  // Quick presets for different user types
  
  async startBeginner(wallet) {
    this.config.preset = 'conservative';
    return this.start(wallet);
  }
  
  async startAdvanced(wallet, customConfig = {}) {
    // Merge custom configuration
    const wizardResult = await this.wizard.runWizard();
    const mergedConfig = {
      ...wizardResult.configuration,
      ...customConfig,
      wallet
    };
    
    await this.saveConfiguration(mergedConfig);
    await this.startMining(mergedConfig);
    
    return {
      success: true,
      configuration: mergedConfig
    };
  }
  
  async startAnonymous() {
    // Generate temporary anonymous wallet
    const tempWallet = this.generateTempWallet();
    this.config.anonymous = true;
    
    return this.start(tempWallet);
  }
  
  generateTempWallet() {
    // Generate a temporary wallet address for anonymous mining
    // In production, this would create a real wallet
    const chars = '0123456789abcdef';
    let wallet = '0x';
    
    for (let i = 0; i < 40; i++) {
      wallet += chars[Math.floor(Math.random() * chars.length)];
    }
    
    return wallet;
  }
  
  // Status and control methods
  
  getStatus() {
    return {
      status: this.status,
      uptime: this.startTime ? Date.now() - this.startTime : 0,
      statistics: this.statistics,
      hardware: this.wizard.detectedHardware
    };
  }
  
  async restart() {
    const config = await fs.readFile(this.config.configPath, 'utf8');
    const parsedConfig = JSON.parse(config);
    
    await this.stop();
    await this.start(parsedConfig.wallet);
  }
  
  async updateConfiguration(updates) {
    const currentConfig = JSON.parse(
      await fs.readFile(this.config.configPath, 'utf8')
    );
    
    const newConfig = {
      ...currentConfig,
      ...updates
    };
    
    await this.saveConfiguration(newConfig);
    
    if (this.status === 'mining') {
      await this.restart();
    }
  }
}

module.exports = OneClickMining;