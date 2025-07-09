#!/usr/bin/env node
// Otedama Pool Quick Start and Feature Overview
import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

class OtedamaQuickStart {
  async run(): Promise<void> {
    console.clear();
    await this.showBanner();
    
    const action = process.argv[2];
    
    switch (action) {
      case 'check':
        await this.checkSystem();
        break;
        
      case 'features':
        await this.showFeatures();
        break;
        
      case 'setup':
        await this.setupWizard();
        break;
        
      case 'start':
        await this.quickStart();
        break;
        
      default:
        await this.showMenu();
    }
  }
  
  async showBanner(): Promise<void> {
    console.log(`${colors.cyan}
╔═══════════════════════════════════════════════════════════════════════════╗
║                                                                           ║
║     ██████╗ ████████╗███████╗██████╗  █████╗ ███╗   ███╗ █████╗         ║
║    ██╔═══██╗╚══██╔══╝██╔════╝██╔══██╗██╔══██╗████╗ ████║██╔══██╗        ║
║    ██║   ██║   ██║   █████╗  ██║  ██║███████║██╔████╔██║███████║        ║
║    ██║   ██║   ██║   ██╔══╝  ██║  ██║██╔══██║██║╚██╔╝██║██╔══██║        ║
║    ╚██████╔╝   ██║   ███████╗██████╔╝██║  ██║██║ ╚═╝ ██║██║  ██║        ║
║     ╚═════╝    ╚═╝   ╚══════╝╚═════╝ ╚═╝  ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝        ║
║                                                                           ║
║                    Professional Mining Pool Software                      ║
║                              Version 1.0.0                                ║
╚═══════════════════════════════════════════════════════════════════════════╝
${colors.reset}`);
  }
  
  async showMenu(): Promise<void> {
    console.log(`
${colors.bright}Quick Start Menu:${colors.reset}

  ${colors.green}npm run quickstart check${colors.reset}     - Check system requirements
  ${colors.green}npm run quickstart features${colors.reset}  - Show all features
  ${colors.green}npm run quickstart setup${colors.reset}     - Interactive setup wizard
  ${colors.green}npm run quickstart start${colors.reset}     - Quick start the pool

${colors.yellow}Recommended for first time users:${colors.reset}
  npm run quickstart setup
`);
  }
  
  async checkSystem(): Promise<void> {
    console.log(`\n${colors.bright}System Requirements Check${colors.reset}\n`);
    
    const checks = [
      {
        name: 'Node.js Version',
        check: async () => {
          const { stdout } = await execAsync('node --version');
          const version = stdout.trim();
          const major = parseInt(version.split('.')[0].substring(1));
          return {
            passed: major >= 18,
            value: version,
            required: '>= 18.0.0'
          };
        }
      },
      {
        name: 'NPM Available',
        check: async () => {
          try {
            const { stdout } = await execAsync('npm --version');
            return { passed: true, value: stdout.trim() };
          } catch {
            return { passed: false, value: 'Not found' };
          }
        }
      },
      {
        name: 'TypeScript',
        check: async () => {
          try {
            const { stdout } = await execAsync('npx tsc --version');
            return { passed: true, value: stdout.trim() };
          } catch {
            return { passed: false, value: 'Not installed' };
          }
        }
      },
      {
        name: 'Free Memory',
        check: async () => {
          const freeMem = require('os').freemem();
          const totalMem = require('os').totalmem();
          const freeGB = (freeMem / 1024 / 1024 / 1024).toFixed(2);
          const totalGB = (totalMem / 1024 / 1024 / 1024).toFixed(2);
          return {
            passed: freeMem > 2 * 1024 * 1024 * 1024, // 2GB
            value: `${freeGB}GB / ${totalGB}GB`,
            required: '>= 2GB'
          };
        }
      },
      {
        name: 'CPU Cores',
        check: async () => {
          const cores = require('os').cpus().length;
          return {
            passed: cores >= 2,
            value: cores.toString(),
            required: '>= 2'
          };
        }
      },
      {
        name: '.env File',
        check: async () => {
          try {
            await fs.access('.env');
            return { passed: true, value: 'Found' };
          } catch {
            return { passed: false, value: 'Not found' };
          }
        }
      }
    ];
    
    for (const check of checks) {
      process.stdout.write(`Checking ${check.name}... `);
      try {
        const result = await check.check();
        const status = result.passed ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
        const value = result.value;
        const required = result.required ? ` (required: ${result.required})` : '';
        console.log(`${status} ${value}${required}`);
      } catch (error) {
        console.log(`${colors.red}✗ Error${colors.reset}`);
      }
    }
    
    console.log('\n' + '─'.repeat(50) + '\n');
  }
  
  async showFeatures(): Promise<void> {
    const features = {
      'Core Features': [
        '⚡ Ultra-fast share processing',
        '🔄 Go-style concurrent architecture', 
        '💾 Minimal dependencies',
        '🧪 Fully testable modular design'
      ],
      'Security': [
        '🛡️ Multi-layer DDoS protection',
        '🔐 Secure miner authentication',
        '🔒 SSL/TLS encryption',
        '✅ Share validation & duplicate detection'
      ],
      'Enterprise': [
        '💰 Flexible fee structures',
        '📦 Batch payment processing',
        '🗄️ Automatic backups',
        '📊 Real-time analytics',
        '🚨 Discord/Telegram alerts',
        '🌍 Geographic distribution'
      ],
      'Performance': [
        '🚀 Parallel share validation',
        '💨 Object pooling',
        '📈 Redis caching',
        '⚙️ JIT optimization'
      ],
      'Monitoring': [
        '📊 Web dashboard',
        '📡 WebSocket real-time updates',
        '📈 Prometheus metrics',
        '🏥 Health checks',
        '📱 API endpoints'
      ],
      'Operations': [
        '🐳 Docker support',
        '⚙️ PM2 integration',
        '🔧 systemd service',
        '📝 Comprehensive logging',
        '🔄 Hot reload support'
      ]
    };
    
    console.log(`\n${colors.bright}Otedama Pool Features${colors.reset}\n`);
    
    for (const [category, items] of Object.entries(features)) {
      console.log(`${colors.cyan}${category}:${colors.reset}`);
      for (const item of items) {
        console.log(`  ${item}`);
      }
      console.log();
    }
    
    console.log(`${colors.yellow}Available Editions:${colors.reset}`);
    console.log('  1. Basic    - Minimal, highest performance');
    console.log('  2. Enhanced - Security hardened (recommended)');
    console.log('  3. Complete - All features enabled\n');
  }
  
  async setupWizard(): Promise<void> {
    console.log(`\n${colors.bright}Interactive Setup Wizard${colors.reset}\n`);
    
    // Check if .env exists
    let envExists = false;
    try {
      await fs.access('.env');
      envExists = true;
    } catch {}
    
    if (!envExists) {
      console.log('Creating .env file from template...');
      await fs.copyFile('.env.example', '.env');
      console.log(`${colors.green}✓${colors.reset} .env file created\n`);
      console.log(`${colors.yellow}⚠️  Please edit .env file with your configuration:${colors.reset}`);
      console.log('    - POOL_ADDRESS (your Bitcoin address)');
      console.log('    - RPC_URL, RPC_USER, RPC_PASSWORD (Bitcoin node)');
      console.log('\nAfter configuration, run: npm run quickstart start\n');
      return;
    }
    
    // Install dependencies if needed
    try {
      await fs.access('node_modules');
    } catch {
      console.log('Installing dependencies...');
      await execAsync('npm install');
      console.log(`${colors.green}✓${colors.reset} Dependencies installed\n`);
    }
    
    // Build if needed
    try {
      await fs.access('dist');
    } catch {
      console.log('Building application...');
      await execAsync('npm run build:complete');
      console.log(`${colors.green}✓${colors.reset} Build complete\n`);
    }
    
    // Generate configurations
    console.log('Generating process manager configurations...');
    await execAsync('npm run setup:all');
    console.log(`${colors.green}✓${colors.reset} Configurations generated\n`);
    
    console.log(`${colors.bright}Setup Complete!${colors.reset}\n`);
    console.log('You can now start the pool with:');
    console.log(`  ${colors.green}./start.sh${colors.reset}          - Automatic startup`);
    console.log(`  ${colors.green}npm run dev:complete${colors.reset} - Development mode`);
    console.log(`  ${colors.green}pm2 start${colors.reset}           - Production with PM2\n`);
  }
  
  async quickStart(): Promise<void> {
    console.log(`\n${colors.bright}Quick Starting Otedama Pool${colors.reset}\n`);
    
    // Check .env
    try {
      await fs.access('.env');
    } catch {
      console.log(`${colors.red}Error: .env file not found${colors.reset}`);
      console.log('Run: npm run quickstart setup\n');
      return;
    }
    
    // Check if already running
    try {
      const { stdout } = await execAsync('pm2 list');
      if (stdout.includes('otedama-pool')) {
        console.log(`${colors.yellow}Pool is already running in PM2${colors.reset}`);
        console.log('Use: pm2 status\n');
        return;
      }
    } catch {}
    
    console.log('Starting pool in development mode...');
    console.log(`${colors.yellow}Press Ctrl+C to stop${colors.reset}\n`);
    
    // Start in development mode
    const { spawn } = require('child_process');
    const pool = spawn('npm', ['run', 'dev:complete'], {
      stdio: 'inherit',
      shell: true
    });
    
    pool.on('error', (error: Error) => {
      console.error(`${colors.red}Failed to start:${colors.reset}`, error.message);
    });
  }
}

// Feature comparison table
function showComparison(): void {
  console.log(`
${colors.bright}Edition Comparison:${colors.reset}

┌─────────────────────┬────────┬──────────┬──────────┐
│ Feature             │ Basic  │ Enhanced │ Complete │
├─────────────────────┼────────┼──────────┼──────────┤
│ Core Mining         │   ✓    │    ✓     │    ✓     │
│ Stratum Server      │   ✓    │    ✓     │    ✓     │
│ Share Validation    │   ✓    │    ✓     │    ✓     │
│ PPLNS Payouts       │   ✓    │    ✓     │    ✓     │
├─────────────────────┼────────┼──────────┼──────────┤
│ DDoS Protection     │   -    │    ✓     │    ✓     │
│ Duplicate Detection │   -    │    ✓     │    ✓     │
│ Auto Recovery       │   -    │    ✓     │    ✓     │
│ Backup System       │   -    │    ✓     │    ✓     │
├─────────────────────┼────────┼──────────┼──────────┤
│ Redis Cache         │   -    │    -     │    ✓     │
│ Payment History     │   -    │    -     │    ✓     │
│ Flexible Fees       │   -    │    -     │    ✓     │
│ Batch Payments      │   -    │    -     │    ✓     │
│ Geographic Dist.    │   -    │    -     │    ✓     │
└─────────────────────┴────────┴──────────┴──────────┘
`);
}

// Main execution
async function main() {
  const quickstart = new OtedamaQuickStart();
  
  try {
    await quickstart.run();
    
    if (process.argv[2] === 'compare') {
      showComparison();
    }
  } catch (error) {
    console.error(`${colors.red}Error:${colors.reset}`, (error as Error).message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
