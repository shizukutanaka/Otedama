#!/usr/bin/env node
/**
 * Otedama Universal Setup Script
 * One-click setup for all platforms (Windows/Linux/macOS)
 * 
 * Features:
 * - Automatic OS detection
 * - Dependency installation
 * - Configuration generation
 * - Database initialization
 * - SSL certificate generation
 * - Service installation (optional)
 * - Performance optimization
 */

import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import readline from 'readline';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Console colors
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m'
};

class OtedamaSetup {
  constructor() {
    this.platform = os.platform();
    this.isWindows = this.platform === 'win32';
    this.isMac = this.platform === 'darwin';
    this.isLinux = this.platform === 'linux';
    this.setupSteps = [];
    this.config = {};
  }

  log(message, color = 'reset') {
    console.log(`${colors[color]}${message}${colors.reset}`);
  }

  async prompt(question) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    return new Promise((resolve) => {
      rl.question(`${colors.cyan}${question}${colors.reset} `, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }

  async checkRequirements() {
    this.log('\n🔍 Checking system requirements...', 'bright');
    
    const requirements = {
      node: { min: '18.0.0', current: process.version.slice(1) },
      npm: { min: '8.0.0', current: '' },
      memory: { min: 4 * 1024 * 1024 * 1024, current: os.totalmem() },
      disk: { min: 50 * 1024 * 1024 * 1024, current: 0 }
    };

    // Check Node.js version
    if (this.compareVersions(requirements.node.current, requirements.node.min) < 0) {
      throw new Error(`Node.js ${requirements.node.min} or higher required. Current: ${requirements.node.current}`);
    }
    this.log(`✅ Node.js ${requirements.node.current}`, 'green');

    // Check npm version
    try {
      const { stdout } = await execAsync('npm --version');
      requirements.npm.current = stdout.trim();
      if (this.compareVersions(requirements.npm.current, requirements.npm.min) < 0) {
        throw new Error(`npm ${requirements.npm.min} or higher required. Current: ${requirements.npm.current}`);
      }
      this.log(`✅ npm ${requirements.npm.current}`, 'green');
    } catch (error) {
      throw new Error('npm not found. Please install Node.js with npm.');
    }

    // Check memory
    const memoryGB = (requirements.memory.current / (1024 * 1024 * 1024)).toFixed(1);
    if (requirements.memory.current < requirements.memory.min) {
      this.log(`⚠️  Warning: Low memory (${memoryGB}GB). Recommended: 4GB+`, 'yellow');
    } else {
      this.log(`✅ Memory: ${memoryGB}GB`, 'green');
    }

    // Check Git (optional)
    try {
      await execAsync('git --version');
      this.log('✅ Git installed', 'green');
    } catch {
      this.log('⚠️  Git not found (optional)', 'yellow');
    }

    // Check build tools
    if (this.isWindows) {
      try {
        await execAsync('where cl');
        this.log('✅ Windows Build Tools', 'green');
      } catch {
        this.log('⚠️  Windows Build Tools not found (optional for native modules)', 'yellow');
      }
    } else {
      try {
        await execAsync('which gcc');
        this.log('✅ GCC compiler', 'green');
      } catch {
        this.log('⚠️  GCC not found (optional for native modules)', 'yellow');
      }
    }
  }

  compareVersions(v1, v2) {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);
    
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const part1 = parts1[i] || 0;
      const part2 = parts2[i] || 0;
      if (part1 > part2) return 1;
      if (part1 < part2) return -1;
    }
    return 0;
  }

  async installDependencies() {
    this.log('\n📦 Installing dependencies...', 'bright');
    
    // Check if node_modules exists
    try {
      await fs.access(path.join(__dirname, 'node_modules'));
      const answer = await this.prompt('Dependencies already installed. Reinstall? (y/N)');
      if (answer.toLowerCase() !== 'y') {
        this.log('Skipping dependency installation', 'yellow');
        return;
      }
    } catch {
      // node_modules doesn't exist, proceed with installation
    }

    return new Promise((resolve, reject) => {
      const npm = this.isWindows ? 'npm.cmd' : 'npm';
      const install = spawn(npm, ['install', '--production'], {
        stdio: 'inherit',
        shell: this.isWindows
      });

      install.on('close', (code) => {
        if (code === 0) {
          this.log('✅ Dependencies installed successfully', 'green');
          resolve();
        } else {
          reject(new Error(`npm install failed with code ${code}`));
        }
      });
    });
  }

  async setupConfiguration() {
    this.log('\n⚙️  Setting up configuration...', 'bright');
    
    // Check if config exists
    const configPath = path.join(__dirname, 'otedama.config.js');
    try {
      await fs.access(configPath);
      const answer = await this.prompt('Configuration already exists. Reconfigure? (y/N)');
      if (answer.toLowerCase() !== 'y') {
        this.log('Using existing configuration', 'yellow');
        return;
      }
    } catch {
      // Config doesn't exist, create it
    }

    // Gather configuration
    this.log('\nBasic Configuration:', 'cyan');
    this.config.poolName = await this.prompt('Pool name (Otedama Mining Pool):') || 'Otedama Mining Pool';
    this.config.algorithm = await this.prompt('Default algorithm (sha256/scrypt/ethash/randomx/kawpow) [sha256]:') || 'sha256';
    this.config.coin = await this.prompt('Default coin (BTC/LTC/ETH/XMR/RVN) [BTC]:') || 'BTC';
    this.config.fee = parseFloat(await this.prompt('Pool fee % (0-5) [1]:') || '1') / 100;
    this.config.minPayout = parseFloat(await this.prompt('Minimum payout [0.001]:') || '0.001');
    
    this.log('\nNetwork Configuration:', 'cyan');
    this.config.stratumPort = parseInt(await this.prompt('Stratum port [3333]:') || '3333');
    this.config.apiPort = parseInt(await this.prompt('API port [8081]:') || '8081');
    this.config.monitoringPort = parseInt(await this.prompt('Monitoring port [8082]:') || '8082');
    
    this.log('\nSecurity Configuration:', 'cyan');
    const enableZKP = await this.prompt('Enable Zero-Knowledge Proof authentication? (Y/n)');
    this.config.zkpEnabled = enableZKP.toLowerCase() !== 'n';
    
    const enableSSL = await this.prompt('Enable SSL/TLS? (Y/n)');
    this.config.sslEnabled = enableSSL.toLowerCase() !== 'n';
    
    // Advanced options
    const advanced = await this.prompt('\nConfigure advanced options? (y/N)');
    if (advanced.toLowerCase() === 'y') {
      this.log('\nAdvanced Configuration:', 'cyan');
      this.config.maxConnections = parseInt(await this.prompt('Max connections [1000000]:') || '1000000');
      this.config.targetLatency = parseFloat(await this.prompt('Target latency (ms) [0.1]:') || '0.1');
      this.config.workersCount = parseInt(await this.prompt('Worker processes [auto]:') || '0') || 'auto';
      
      const enableEnterprise = await this.prompt('Enable enterprise features? (y/N)');
      this.config.enterpriseMode = enableEnterprise.toLowerCase() === 'y';
    }

    // Generate configuration file
    const configContent = `/**
 * Otedama Configuration
 * Generated on ${new Date().toISOString()}
 */

export default {
  // Pool settings
  pool: {
    name: '${this.config.poolName}',
    algorithm: '${this.config.algorithm}',
    coin: '${this.config.coin}',
    fee: ${this.config.fee},
    minPayout: ${this.config.minPayout}
  },
  
  // Network settings
  network: {
    stratum: {
      port: ${this.config.stratumPort},
      maxConnections: ${this.config.maxConnections || 1000000}
    },
    api: {
      port: ${this.config.apiPort},
      cors: true
    },
    monitoring: {
      port: ${this.config.monitoringPort}
    }
  },
  
  // Security settings
  security: {
    zkpEnabled: ${this.config.zkpEnabled},
    sslEnabled: ${this.config.sslEnabled},
    antiDDoS: true,
    rateLimit: {
      enabled: true,
      windowMs: 60000,
      maxRequests: 1000
    }
  },
  
  // Performance settings
  performance: {
    targetLatency: ${this.config.targetLatency || 0.1},
    workers: '${this.config.workersCount || 'auto'}',
    zeroCopyBuffers: true,
    lockFreeQueues: true
  },
  
  // Database settings
  database: {
    type: 'sqlite',
    filename: './data/otedama.db',
    wal: true,
    cache: 10000
  },
  
  // Monitoring settings
  monitoring: {
    prometheus: true,
    realtime: true,
    alerting: true
  }${this.config.enterpriseMode ? `,
  
  // Enterprise settings
  enterprise: {
    enabled: true,
    multiRegion: true,
    autoScaling: true,
    highAvailability: true
  }` : ''}
};`;

    await fs.writeFile(configPath, configContent);
    this.log('✅ Configuration saved to otedama.config.js', 'green');
  }

  async setupDatabase() {
    this.log('\n🗄️  Setting up database...', 'bright');
    
    // Create data directory
    const dataDir = path.join(__dirname, 'data');
    try {
      await fs.mkdir(dataDir, { recursive: true });
    } catch (error) {
      // Directory might already exist
    }

    // Initialize database
    try {
      const { initializeDatabase } = await import('./lib/storage/database.js');
      await initializeDatabase();
      this.log('✅ Database initialized', 'green');
    } catch (error) {
      this.log(`⚠️  Database initialization skipped: ${error.message}`, 'yellow');
    }
  }

  async generateSSLCertificates() {
    if (!this.config.sslEnabled) {
      return;
    }

    this.log('\n🔐 Generating SSL certificates...', 'bright');
    
    const certsDir = path.join(__dirname, 'certs');
    try {
      await fs.mkdir(certsDir, { recursive: true });
    } catch {
      // Directory might already exist
    }

    // Check if certificates already exist
    try {
      await fs.access(path.join(certsDir, 'server.crt'));
      const answer = await this.prompt('SSL certificates already exist. Regenerate? (y/N)');
      if (answer.toLowerCase() !== 'y') {
        this.log('Using existing certificates', 'yellow');
        return;
      }
    } catch {
      // Certificates don't exist
    }

    // Generate self-signed certificate
    try {
      const command = this.isWindows
        ? `powershell -Command "New-SelfSignedCertificate -DnsName localhost -CertStoreLocation cert:\\LocalMachine\\My"`
        : `openssl req -x509 -newkey rsa:4096 -keyout ${path.join(certsDir, 'server.key')} -out ${path.join(certsDir, 'server.crt')} -days 365 -nodes -subj "/CN=localhost"`;
      
      await execAsync(command);
      this.log('✅ SSL certificates generated', 'green');
    } catch (error) {
      this.log('⚠️  SSL certificate generation failed. You can generate them manually later.', 'yellow');
    }
  }

  async optimizeSystem() {
    this.log('\n🚀 Optimizing system settings...', 'bright');
    
    if (this.isLinux) {
      try {
        // Check if running as root
        const { stdout } = await execAsync('id -u');
        const isRoot = stdout.trim() === '0';
        
        if (isRoot) {
          // Increase file descriptor limits
          await execAsync('ulimit -n 1000000').catch(() => {});
          
          // Optimize network settings
          const sysctlCommands = [
            'sysctl -w net.core.somaxconn=65535',
            'sysctl -w net.ipv4.tcp_max_syn_backlog=65535',
            'sysctl -w net.core.netdev_max_backlog=65535',
            'sysctl -w net.ipv4.tcp_fin_timeout=10'
          ];
          
          for (const cmd of sysctlCommands) {
            await execAsync(cmd).catch(() => {});
          }
          
          this.log('✅ System optimizations applied', 'green');
        } else {
          this.log('⚠️  Run as root to apply system optimizations', 'yellow');
        }
      } catch {
        this.log('⚠️  System optimization skipped', 'yellow');
      }
    } else if (this.isWindows) {
      this.log('⚠️  Manual system optimization recommended for Windows', 'yellow');
      this.log('   See: https://docs.microsoft.com/en-us/windows-server/networking/', 'yellow');
    }
  }

  async installService() {
    const install = await this.prompt('\n📌 Install as system service? (y/N)');
    if (install.toLowerCase() !== 'y') {
      return;
    }

    this.log('\n🔧 Installing system service...', 'bright');
    
    if (this.isWindows) {
      // Windows service using node-windows (optional)
      try {
        const serviceName = 'OtedamaMiningPool';
        const serviceScript = `
@echo off
cd /d "${__dirname}"
node index.js
`;
        await fs.writeFile(path.join(__dirname, 'otedama-service.bat'), serviceScript);
        
        // Create Windows service
        await execAsync(`sc create ${serviceName} binPath= "${path.join(__dirname, 'otedama-service.bat')}" start= auto`);
        this.log(`✅ Windows service '${serviceName}' created`, 'green');
        this.log('   Start with: sc start OtedamaMiningPool', 'cyan');
      } catch (error) {
        this.log('⚠️  Service installation failed. Run as Administrator.', 'yellow');
      }
    } else if (this.isLinux) {
      // Linux systemd service
      const serviceContent = `[Unit]
Description=Otedama Mining Pool
After=network.target

[Service]
Type=simple
User=${process.env.USER}
WorkingDirectory=${__dirname}
ExecStart=/usr/bin/node ${path.join(__dirname, 'index.js')}
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
`;
      
      try {
        const servicePath = '/etc/systemd/system/otedama.service';
        await fs.writeFile(servicePath, serviceContent);
        await execAsync('systemctl daemon-reload');
        await execAsync('systemctl enable otedama');
        this.log('✅ Systemd service installed', 'green');
        this.log('   Start with: sudo systemctl start otedama', 'cyan');
      } catch {
        // Try to save service file locally
        await fs.writeFile(path.join(__dirname, 'otedama.service'), serviceContent);
        this.log('⚠️  Service file saved locally. Install manually:', 'yellow');
        this.log('   sudo cp otedama.service /etc/systemd/system/', 'cyan');
        this.log('   sudo systemctl daemon-reload && sudo systemctl enable otedama', 'cyan');
      }
    } else if (this.isMac) {
      // macOS launchd plist
      const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.otedama.miningpool</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>${path.join(__dirname, 'index.js')}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${__dirname}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>`;
      
      const plistPath = path.join(__dirname, 'com.otedama.miningpool.plist');
      await fs.writeFile(plistPath, plistContent);
      this.log('✅ LaunchAgent plist created', 'green');
      this.log('   Install with:', 'cyan');
      this.log(`   cp ${plistPath} ~/Library/LaunchAgents/`, 'cyan');
      this.log('   launchctl load ~/Library/LaunchAgents/com.otedama.miningpool.plist', 'cyan');
    }
  }

  async showNextSteps() {
    this.log('\n' + '='.repeat(60), 'bright');
    this.log('🎉 Otedama setup completed successfully!', 'green');
    this.log('='.repeat(60) + '\n', 'bright');
    
    this.log('📋 Configuration Summary:', 'cyan');
    this.log(`   Pool Name: ${this.config.poolName}`);
    this.log(`   Algorithm: ${this.config.algorithm}`);
    this.log(`   Stratum Port: ${this.config.stratumPort}`);
    this.log(`   API Port: ${this.config.apiPort}`);
    this.log(`   Monitoring Port: ${this.config.monitoringPort}`);
    this.log(`   ZKP Auth: ${this.config.zkpEnabled ? 'Enabled' : 'Disabled'}`);
    this.log(`   SSL/TLS: ${this.config.sslEnabled ? 'Enabled' : 'Disabled'}`);
    
    this.log('\n🚀 Quick Start:', 'cyan');
    this.log('   1. Start the pool:', 'bright');
    this.log('      npm start', 'green');
    this.log('\n   2. Connect miners:', 'bright');
    this.log(`      stratum+tcp://localhost:${this.config.stratumPort}`, 'green');
    this.log('\n   3. View dashboard:', 'bright');
    this.log(`      http://localhost:${this.config.monitoringPort}`, 'green');
    this.log('\n   4. API endpoint:', 'bright');
    this.log(`      http://localhost:${this.config.apiPort}/api/v1`, 'green');
    
    this.log('\n📚 Documentation:', 'cyan');
    this.log('   - README.md for detailed instructions');
    this.log('   - docs/API.md for API reference');
    this.log('   - CHANGELOG.md for version history');
    
    this.log('\n💡 Pro Tips:', 'yellow');
    this.log('   - Run "npm run benchmark" to test performance');
    this.log('   - Use "npm run start:ultra" for maximum performance');
    this.log('   - Enable monitoring at http://localhost:' + this.config.monitoringPort);
    
    if (this.config.enterpriseMode) {
      this.log('\n🏢 Enterprise Features Enabled:', 'blue');
      this.log('   - Multi-region support');
      this.log('   - Auto-scaling');
      this.log('   - High availability');
      this.log('   - Advanced monitoring');
    }
    
    this.log('\n🙏 Thank you for choosing Otedama!', 'bright');
    this.log('   GitHub: https://github.com/shizukutanaka/Otedama', 'cyan');
  }

  async run() {
    try {
      this.log('🎌 Otedama Mining Pool Setup', 'bright');
      this.log('Version 1.1.1 - Enterprise Edition\n', 'cyan');
      
      // Check system requirements
      await this.checkRequirements();
      
      // Install dependencies
      await this.installDependencies();
      
      // Setup configuration
      await this.setupConfiguration();
      
      // Setup database
      await this.setupDatabase();
      
      // Generate SSL certificates
      await this.generateSSLCertificates();
      
      // Optimize system
      await this.optimizeSystem();
      
      // Install service (optional)
      await this.installService();
      
      // Show next steps
      await this.showNextSteps();
      
    } catch (error) {
      this.log(`\n❌ Setup failed: ${error.message}`, 'red');
      this.log('Please check the error and try again.', 'yellow');
      process.exit(1);
    }
  }
}

// Run setup
const setup = new OtedamaSetup();
setup.run();