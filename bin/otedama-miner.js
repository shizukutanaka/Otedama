#!/usr/bin/env node

/**
 * Otedama Miner CLI
 * Command-line interface for the Otedama mining client
 */

const { program } = require('commander');
const MinerClient = require('../lib/mining/miner-client');
const { createLogger } = require('../lib/core/logger');
const inquirer = require('inquirer');
const chalk = require('chalk');
const ora = require('ora');
const Table = require('cli-table3');
const path = require('path');
const fs = require('fs').promises;

const logger = createLogger('otedama-miner-cli');
const version = require('../package.json').version;

// ASCII Art Banner
const banner = `
██████╗ ████████╗███████╗██████╗  █████╗ ███╗   ███╗ █████╗ 
██╔═══██╗╚══██╔══╝██╔════╝██╔══██╗██╔══██╗████╗ ████║██╔══██╗
██║   ██║   ██║   █████╗  ██║  ██║███████║██╔████╔██║███████║
██║   ██║   ██║   ██╔══╝  ██║  ██║██╔══██║██║╚██╔╝██║██╔══██║
██████╔╝   ██║   ███████╗██████╔╝██║  ██║██║ ╚═╝ ██║██║  ██║
╚═════╝    ╚═╝   ╚══════╝╚═════╝ ╚═╝  ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝
                                MINER v${version}
`;

// Initialize miner client
let minerClient;

program
  .name('otedama-miner')
  .description('Otedama P2P Mining Pool - Miner Client')
  .version(version);

// Start command
program
  .command('start')
  .description('Start mining')
  .option('-c, --config <path>', 'Config file path', './config/miner-client-config.json')
  .option('-m, --minimized', 'Start minimized to system tray')
  .option('-b, --background', 'Run in background')
  .option('-i, --idle', 'Enable idle mining')
  .action(async (options) => {
    console.log(chalk.cyan(banner));
    
    const spinner = ora('Initializing miner...').start();
    
    try {
      minerClient = new MinerClient(options.config);
      
      // Apply command line options
      if (options.minimized || options.background || options.idle) {
        await minerClient.loadConfig();
        
        if (options.minimized) {
          minerClient.config.miner.startup.minimized = true;
        }
        if (options.background) {
          minerClient.config.miner.startup.runInBackground = true;
        }
        if (options.idle) {
          minerClient.config.miner.idleMining.enabled = true;
        }
        
        await minerClient.saveConfig();
      }
      
      await minerClient.initialize();
      spinner.succeed('Miner initialized');
      
      // Check if BTC address is configured
      if (!minerClient.config.miner.btcAddress) {
        spinner.stop();
        console.log(chalk.yellow('\n⚠  BTC address not configured'));
        await configureAddress();
      }
      
      // Start mining
      console.log(chalk.green('\n✓ Starting miner...'));
      await minerClient.start();
      
      // Display status
      displayStatus();
      
      // Setup event handlers
      setupEventHandlers();
      
      // Keep process running
      process.on('SIGINT', async () => {
        console.log(chalk.yellow('\n\nShutting down...'));
        await minerClient.stop();
        process.exit(0);
      });
      
    } catch (error) {
      spinner.fail(`Failed to start miner: ${error.message}`);
      process.exit(1);
    }
  });

// Stop command
program
  .command('stop')
  .description('Stop mining')
  .action(async () => {
    console.log(chalk.yellow('Stopping miner...'));
    // In a real implementation, this would communicate with a running instance
    console.log(chalk.green('✓ Miner stopped'));
  });

// Config command
program
  .command('config')
  .description('Configure miner settings')
  .option('-c, --config <path>', 'Config file path', './config/miner-client-config.json')
  .action(async (options) => {
    console.log(chalk.cyan(banner));
    
    minerClient = new MinerClient(options.config);
    await minerClient.loadConfig();
    
    const choices = [
      'Set BTC Address',
      'Hardware Settings',
      'Performance Settings',
      'Idle Mining Settings',
      'Startup Settings',
      'View Current Config',
      'Exit'
    ];
    
    let exit = false;
    while (!exit) {
      const { action } = await inquirer.prompt([
        {
          type: 'list',
          name: 'action',
          message: 'What would you like to configure?',
          choices
        }
      ]);
      
      switch (action) {
        case 'Set BTC Address':
          await configureAddress();
          break;
        case 'Hardware Settings':
          await configureHardware();
          break;
        case 'Performance Settings':
          await configurePerformance();
          break;
        case 'Idle Mining Settings':
          await configureIdleMining();
          break;
        case 'Startup Settings':
          await configureStartup();
          break;
        case 'View Current Config':
          displayConfig();
          break;
        case 'Exit':
          exit = true;
          break;
      }
    }
  });

// Status command
program
  .command('status')
  .description('Show miner status')
  .action(async () => {
    console.log(chalk.cyan(banner));
    // In a real implementation, this would check the status of a running instance
    console.log(chalk.yellow('Miner is not running'));
  });

// Configure BTC address
async function configureAddress() {
  const { address } = await inquirer.prompt([
    {
      type: 'input',
      name: 'address',
      message: 'Enter your BTC address:',
      validate: (input) => {
        if (!input) return 'BTC address is required';
        if (!minerClient.isValidBitcoinAddress(input)) {
          return 'Invalid BTC address format';
        }
        return true;
      }
    }
  ]);
  
  await minerClient.updateBTCAddress(address);
  console.log(chalk.green(`✓ BTC address updated: ${address}`));
}

// Configure hardware settings
async function configureHardware() {
  const current = minerClient.config.miner.hardware;
  
  const answers = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'useCPU',
      message: 'Use CPU for mining?',
      default: current.useCPU
    },
    {
      type: 'number',
      name: 'cpuThreads',
      message: 'Number of CPU threads (0 for auto):',
      default: current.cpuThreads,
      when: (answers) => answers.useCPU
    },
    {
      type: 'confirm',
      name: 'useGPU',
      message: 'Use GPU for mining?',
      default: current.useGPU
    },
    {
      type: 'input',
      name: 'gpuDevices',
      message: 'GPU devices to use ("all" or comma-separated indices):',
      default: current.gpuDevices,
      when: (answers) => answers.useGPU
    }
  ]);
  
  await minerClient.updateHardwareSettings(answers);
  console.log(chalk.green('✓ Hardware settings updated'));
}

// Configure performance settings
async function configurePerformance() {
  const current = minerClient.config.miner.performance;
  
  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'priority',
      message: 'Process priority:',
      choices: ['low', 'normal', 'high'],
      default: current.priority
    },
    {
      type: 'number',
      name: 'cpuIntensity',
      message: 'CPU intensity (0-100):',
      default: current.cpuIntensity,
      validate: (input) => input >= 0 && input <= 100 || 'Must be between 0 and 100'
    },
    {
      type: 'number',
      name: 'gpuIntensity',
      message: 'GPU intensity (0-100):',
      default: current.gpuIntensity,
      validate: (input) => input >= 0 && input <= 100 || 'Must be between 0 and 100'
    },
    {
      type: 'number',
      name: 'temperatureLimit',
      message: 'Temperature limit (°C):',
      default: current.temperatureLimit
    },
    {
      type: 'confirm',
      name: 'pauseOnBattery',
      message: 'Pause mining when on battery power?',
      default: current.pauseOnBattery
    }
  ]);
  
  minerClient.config.miner.performance = { ...current, ...answers };
  await minerClient.saveConfig();
  console.log(chalk.green('✓ Performance settings updated'));
}

// Configure idle mining
async function configureIdleMining() {
  const current = minerClient.config.miner.idleMining;
  
  const answers = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'enabled',
      message: 'Enable idle mining?',
      default: current.enabled
    },
    {
      type: 'number',
      name: 'idleTime',
      message: 'Idle time before starting (minutes):',
      default: Math.floor(current.idleTime / 60000),
      when: (answers) => answers.enabled,
      filter: (input) => input * 60000
    },
    {
      type: 'confirm',
      name: 'pauseOnActivity',
      message: 'Pause mining when activity detected?',
      default: current.pauseOnActivity,
      when: (answers) => answers.enabled
    }
  ]);
  
  minerClient.config.miner.idleMining = { ...current, ...answers };
  await minerClient.saveConfig();
  console.log(chalk.green('✓ Idle mining settings updated'));
}

// Configure startup settings
async function configureStartup() {
  const current = minerClient.config.miner.startup;
  
  const answers = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'minimized',
      message: 'Start minimized to tray?',
      default: current.minimized
    },
    {
      type: 'confirm',
      name: 'runInBackground',
      message: 'Run in background?',
      default: current.runInBackground
    },
    {
      type: 'confirm',
      name: 'startOnBoot',
      message: 'Start on system boot?',
      default: current.startOnBoot
    },
    {
      type: 'confirm',
      name: 'hideToTray',
      message: 'Hide to system tray when closed?',
      default: current.hideToTray
    }
  ]);
  
  minerClient.config.miner.startup = { ...current, ...answers };
  await minerClient.saveConfig();
  console.log(chalk.green('✓ Startup settings updated'));
}

// Display current configuration
function displayConfig() {
  const config = minerClient.config;
  
  console.log(chalk.cyan('\n=== Current Configuration ===\n'));
  
  // Miner settings
  console.log(chalk.yellow('Miner Settings:'));
  console.log(`  BTC Address: ${config.miner.btcAddress || chalk.red('Not configured')}`);
  console.log(`  Worker Name: ${config.miner.workerName}`);
  
  // Hardware settings
  console.log(chalk.yellow('\nHardware Settings:'));
  console.log(`  Use CPU: ${config.miner.hardware.useCPU ? chalk.green('Yes') : chalk.red('No')}`);
  if (config.miner.hardware.useCPU) {
    console.log(`  CPU Threads: ${config.miner.hardware.cpuThreads || 'Auto'}`);
  }
  console.log(`  Use GPU: ${config.miner.hardware.useGPU ? chalk.green('Yes') : chalk.red('No')}`);
  if (config.miner.hardware.useGPU) {
    console.log(`  GPU Devices: ${config.miner.hardware.gpuDevices}`);
  }
  
  // Performance settings
  console.log(chalk.yellow('\nPerformance Settings:'));
  console.log(`  Priority: ${config.miner.performance.priority}`);
  console.log(`  CPU Intensity: ${config.miner.performance.cpuIntensity}%`);
  console.log(`  GPU Intensity: ${config.miner.performance.gpuIntensity}%`);
  console.log(`  Temperature Limit: ${config.miner.performance.temperatureLimit}°C`);
  console.log(`  Pause on Battery: ${config.miner.performance.pauseOnBattery ? 'Yes' : 'No'}`);
  
  // Idle mining settings
  console.log(chalk.yellow('\nIdle Mining Settings:'));
  console.log(`  Enabled: ${config.miner.idleMining.enabled ? chalk.green('Yes') : chalk.red('No')}`);
  if (config.miner.idleMining.enabled) {
    console.log(`  Idle Time: ${Math.floor(config.miner.idleMining.idleTime / 60000)} minutes`);
    console.log(`  Pause on Activity: ${config.miner.idleMining.pauseOnActivity ? 'Yes' : 'No'}`);
  }
  
  // Startup settings
  console.log(chalk.yellow('\nStartup Settings:'));
  console.log(`  Start Minimized: ${config.miner.startup.minimized ? 'Yes' : 'No'}`);
  console.log(`  Run in Background: ${config.miner.startup.runInBackground ? 'Yes' : 'No'}`);
  console.log(`  Start on Boot: ${config.miner.startup.startOnBoot ? 'Yes' : 'No'}`);
  console.log(`  Hide to Tray: ${config.miner.startup.hideToTray ? 'Yes' : 'No'}`);
  
  // Pool settings
  console.log(chalk.yellow('\nPool Settings:'));
  config.pools.forEach((pool, index) => {
    console.log(`  Pool ${index + 1}: ${pool.name} (${pool.url})`);
  });
  
  console.log();
}

// Display miner status
function displayStatus() {
  const status = minerClient.getStatus();
  
  const table = new Table({
    head: ['Metric', 'Value'],
    colWidths: [20, 40]
  });
  
  table.push(
    ['Status', status.isRunning ? chalk.green('Running') : chalk.red('Stopped')],
    ['BTC Address', status.btcAddress || chalk.red('Not configured')],
    ['Hashrate', formatHashrate(status.stats.hashrate)],
    ['Shares', `${status.stats.shares.accepted}/${status.stats.shares.total} (${status.stats.shares.rejected} rejected)`],
    ['CPU Temp', `${status.stats.temperature.cpu}°C`],
    ['GPU Temp', status.stats.temperature.gpu.join(', ') + '°C' || 'N/A']
  );
  
  console.log('\n' + table.toString());
}

// Setup event handlers
function setupEventHandlers() {
  minerClient.on('hashrate-update', (hashrate) => {
    process.stdout.write(`\r${chalk.cyan('Hashrate:')} ${formatHashrate(hashrate)}`);
  });
  
  minerClient.on('share-accepted', () => {
    console.log(chalk.green('\n✓ Share accepted'));
  });
  
  minerClient.on('share-rejected', () => {
    console.log(chalk.red('\n✗ Share rejected'));
  });
  
  minerClient.on('temperature-warning', (temp) => {
    console.log(chalk.yellow(`\n⚠  Temperature warning: ${temp}°C`));
  });
  
  minerClient.on('exited', ({ code, signal }) => {
    console.log(chalk.red(`\n✗ Miner exited with code ${code} and signal ${signal}`));
  });
}

// Format hashrate
function formatHashrate(hashrate) {
  if (hashrate === 0) return '0 H/s';
  
  const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
  let unitIndex = 0;
  
  while (hashrate >= 1000 && unitIndex < units.length - 1) {
    hashrate /= 1000;
    unitIndex++;
  }
  
  return `${hashrate.toFixed(2)} ${units[unitIndex]}`;
}

// Parse command line arguments
program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  console.log(chalk.cyan(banner));
  program.outputHelp();
}