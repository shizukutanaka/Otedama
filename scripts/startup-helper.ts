#!/usr/bin/env node
// Interactive Startup Helper for Otedama Pool
import * as fs from 'fs/promises';
import * as readline from 'readline';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query: string): Promise<string> => {
  return new Promise(resolve => rl.question(query, resolve));
};

class StartupHelper {
  async run(): Promise<void> {
    console.clear();
    await this.showWelcome();
    
    // Check environment
    const envExists = await this.checkEnvFile();
    
    if (!envExists) {
      await this.createEnvFile();
    }
    
    // Show menu
    await this.showMainMenu();
  }
  
  private async showWelcome(): Promise<void> {
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   🎉 Welcome to Otedama Mining Pool Setup Wizard! 🎉         ║
║                                                               ║
║   This wizard will help you get your mining pool             ║
║   up and running in just a few minutes.                      ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
`);
  }
  
  private async checkEnvFile(): Promise<boolean> {
    try {
      await fs.access('.env');
      console.log('✅ Configuration file found\n');
      return true;
    } catch {
      console.log('⚠️  No configuration file found\n');
      return false;
    }
  }
  
  private async createEnvFile(): Promise<void> {
    console.log('Let\'s create your pool configuration:\n');
    
    // Get pool address
    const poolAddress = await question('Enter your Bitcoin address for pool rewards: ');
    if (!poolAddress || !this.isValidBitcoinAddress(poolAddress)) {
      console.log('❌ Invalid Bitcoin address. Please run the setup again.');
      process.exit(1);
    }
    
    // Get RPC details
    console.log('\nBitcoin node connection details:');
    const rpcHost = await question('RPC Host [localhost]: ') || 'localhost';
    const rpcPort = await question('RPC Port [8332]: ') || '8332';
    const rpcUser = await question('RPC Username: ');
    const rpcPassword = await question('RPC Password: ');
    
    if (!rpcUser || !rpcPassword) {
      console.log('❌ RPC credentials are required. Please run the setup again.');
      process.exit(1);
    }
    
    // Pool settings
    console.log('\nPool settings:');
    const poolFee = await question('Pool fee percentage [1.0]: ') || '1.0';
    const stratumPort = await question('Stratum port [3333]: ') || '3333';
    
    // Create .env file
    const envContent = `# Otedama Pool Configuration
# Generated by setup wizard

# Required Settings
POOL_ADDRESS=${poolAddress}
RPC_URL=http://${rpcHost}:${rpcPort}
RPC_USER=${rpcUser}
RPC_PASSWORD=${rpcPassword}

# Pool Settings
POOL_FEE=${poolFee}
STRATUM_PORT=${stratumPort}

# Data Storage
DATA_DIR=./data
LOG_DIR=./logs
BACKUP_DIR=./backups

# Dashboard
DASHBOARD_ENABLED=true
DASHBOARD_PORT=8080

# Monitoring
MONITORING_ENABLED=true
MONITOR_PORT=8090

# API
API_ENABLED=true
API_PORT=8088

# Basic Settings
LOG_LEVEL=INFO
MAX_CONNECTIONS=1000
BACKUP_ENABLED=true
`;
    
    await fs.writeFile('.env', envContent);
    console.log('\n✅ Configuration file created successfully!\n');
  }
  
  private isValidBitcoinAddress(address: string): boolean {
    // Basic validation - starts with 1, 3, or bc1
    return /^(1|3|bc1)[a-zA-Z0-9]{25,62}$/.test(address);
  }
  
  private async showMainMenu(): Promise<void> {
    while (true) {
      console.log(`
What would you like to do?

  1. 🚀 Start pool (development mode)
  2. 🏭 Deploy to production
  3. 📊 Start monitoring dashboard
  4. 🧪 Run pool simulator
  5. 📋 Check system requirements
  6. 📖 View documentation
  7. 🔧 Edit configuration
  8. 🚪 Exit

`);
      
      const choice = await question('Enter your choice (1-8): ');
      
      switch (choice) {
        case '1':
          await this.startPool();
          break;
        case '2':
          await this.deployProduction();
          break;
        case '3':
          await this.startMonitoring();
          break;
        case '4':
          await this.runSimulator();
          break;
        case '5':
          await this.checkRequirements();
          break;
        case '6':
          await this.viewDocumentation();
          break;
        case '7':
          await this.editConfiguration();
          break;
        case '8':
          console.log('\nGoodbye! Happy mining! ⛏️\n');
          rl.close();
          process.exit(0);
        default:
          console.log('\n❌ Invalid choice. Please try again.\n');
      }
    }
  }
  
  private async startPool(): Promise<void> {
    console.log('\n🚀 Starting Otedama Pool...\n');
    
    // Check if dependencies are installed
    try {
      await fs.access('node_modules');
    } catch {
      console.log('Installing dependencies...');
      await execAsync('npm install');
    }
    
    console.log('Pool is starting in development mode...');
    console.log('Press Ctrl+C to stop\n');
    
    console.log('Access points:');
    console.log('  Stratum: stratum+tcp://localhost:3333');
    console.log('  Dashboard: http://localhost:8080');
    console.log('  Monitoring: http://localhost:8090');
    console.log('  API: http://localhost:8088\n');
    
    // Start the pool
    const { spawn } = require('child_process');
    const pool = spawn('npm', ['run', 'dev:integrated'], {
      stdio: 'inherit',
      shell: true
    });
    
    pool.on('close', () => {
      console.log('\nPool stopped');
    });
  }
  
  private async deployProduction(): Promise<void> {
    console.log('\n🏭 Production Deployment Options:\n');
    console.log('  1. Docker (recommended)');
    console.log('  2. PM2');
    console.log('  3. Systemd');
    console.log('  4. Back to main menu\n');
    
    const choice = await question('Select deployment method (1-4): ');
    
    if (choice === '4') return;
    
    const methods = ['', 'docker', 'pm2', 'systemd'];
    const method = methods[parseInt(choice)] || '';
    
    if (!method) {
      console.log('❌ Invalid choice');
      return;
    }
    
    console.log(`\nDeploying with ${method}...\n`);
    
    try {
      await execAsync(`npm run deploy:production ${method}`);
      console.log('\n✅ Deployment complete!');
    } catch (error) {
      console.log('❌ Deployment failed:', error);
    }
  }
  
  private async startMonitoring(): Promise<void> {
    console.log('\n📊 Starting monitoring dashboard...\n');
    
    const { spawn } = require('child_process');
    const monitor = spawn('npm', ['run', 'monitor'], {
      stdio: 'inherit',
      shell: true
    });
    
    console.log('Dashboard will be available at: http://localhost:8090\n');
    console.log('Press Ctrl+C to stop\n');
    
    monitor.on('close', () => {
      console.log('\nMonitoring stopped');
    });
  }
  
  private async runSimulator(): Promise<void> {
    console.log('\n🧪 Pool Simulator Options:\n');
    console.log('  1. Basic test (10 miners)');
    console.log('  2. Stress test (1000 miners)');
    console.log('  3. Custom configuration');
    console.log('  4. Back to main menu\n');
    
    const choice = await question('Select test type (1-4): ');
    
    if (choice === '4') return;
    
    let command = '';
    
    switch (choice) {
      case '1':
        command = 'npm run simulate:basic';
        break;
      case '2':
        command = 'npm run simulate:stress';
        break;
      case '3':
        const miners = await question('Number of miners [100]: ') || '100';
        const hashrate = await question('Total hashrate in TH/s [1]: ') || '1';
        command = `npm run simulate -- --miners ${miners} --hashrate ${parseFloat(hashrate) * 1e12}`;
        break;
      default:
        console.log('❌ Invalid choice');
        return;
    }
    
    console.log('\nStarting simulator...\n');
    
    const { spawn } = require('child_process');
    const simulator = spawn(command, {
      stdio: 'inherit',
      shell: true
    });
    
    simulator.on('close', () => {
      console.log('\nSimulator stopped');
    });
  }
  
  private async checkRequirements(): Promise<void> {
    console.log('\n📋 Checking system requirements...\n');
    
    try {
      await execAsync('npm run quickstart check');
    } catch (error) {
      console.log('Failed to run requirements check');
    }
    
    await question('\nPress Enter to continue...');
  }
  
  private async viewDocumentation(): Promise<void> {
    console.log('\n📖 Documentation:\n');
    console.log('  1. README.md - General information');
    console.log('  2. PRODUCTION_GUIDE.md - Production deployment');
    console.log('  3. INTEGRATION_COMPLETE.md - Feature list');
    console.log('  4. Online documentation (opens browser)');
    console.log('  5. Back to main menu\n');
    
    const choice = await question('Select document (1-5): ');
    
    if (choice === '5') return;
    
    const files = ['', 'README.md', 'PRODUCTION_GUIDE.md', 'INTEGRATION_COMPLETE.md'];
    
    if (choice === '4') {
      console.log('Opening documentation in browser...');
      const { exec } = require('child_process');
      exec('start https://github.com/otedama/pool');
      return;
    }
    
    const file = files[parseInt(choice)] || '';
    
    if (!file) {
      console.log('❌ Invalid choice');
      return;
    }
    
    try {
      const content = await fs.readFile(file, 'utf-8');
      console.log('\n' + '─'.repeat(60) + '\n');
      console.log(content.substring(0, 2000) + '...\n');
      console.log('─'.repeat(60) + '\n');
      console.log(`Full file: ${file}`);
    } catch (error) {
      console.log('❌ Could not read file');
    }
    
    await question('\nPress Enter to continue...');
  }
  
  private async editConfiguration(): Promise<void> {
    console.log('\n🔧 Opening configuration file...\n');
    
    // Try to open in default editor
    const { exec } = require('child_process');
    
    if (process.platform === 'win32') {
      exec('notepad .env');
    } else if (process.platform === 'darwin') {
      exec('open -t .env');
    } else {
      exec('${EDITOR:-nano} .env');
    }
    
    console.log('Configuration file opened in your default editor.');
    console.log('Make your changes and save the file.\n');
    
    await question('Press Enter when done...');
  }
}

// ASCII art banner
function showBanner(): void {
  console.log(`
     ██████╗ ████████╗███████╗██████╗  █████╗ ███╗   ███╗ █████╗ 
    ██╔═══██╗╚══██╔══╝██╔════╝██╔══██╗██╔══██╗████╗ ████║██╔══██╗
    ██║   ██║   ██║   █████╗  ██║  ██║███████║██╔████╔██║███████║
    ██║   ██║   ██║   ██╔══╝  ██║  ██║██╔══██║██║╚██╔╝██║██╔══██║
    ╚██████╔╝   ██║   ███████╗██████╔╝██║  ██║██║ ╚═╝ ██║██║  ██║
     ╚═════╝    ╚═╝   ╚══════╝╚═════╝ ╚═╝  ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝
`);
}

// Main execution
async function main() {
  showBanner();
  
  const helper = new StartupHelper();
  
  try {
    await helper.run();
  } catch (error) {
    console.error('\n❌ Error:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
