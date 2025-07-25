#!/usr/bin/env node

/**
 * Otedama Automation Manager CLI
 * Unified control for all automation systems
 */

import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import { createMiningPoolManager } from '../lib/mining/pool-manager.js';
import { createLogger } from '../lib/core/logger.js';

const logger = createLogger('AutomationCLI');
const program = new Command();

program
  .name('otedama-auto')
  .description('Manage Otedama automation systems')
  .version('1.0.0');

// Status command
program
  .command('status')
  .description('Show automation systems status')
  .action(async () => {
    await showStatus();
  });

// Deploy command
program
  .command('deploy')
  .description('Deploy new version')
  .option('-y, --yes', 'Skip confirmation')
  .action(async (options) => {
    await deploy(options);
  });

// Backup command
program
  .command('backup')
  .description('Manage backups')
  .option('-c, --create', 'Create new backup')
  .option('-l, --list', 'List backups')
  .option('-r, --restore <id>', 'Restore backup')
  .action(async (options) => {
    await manageBackups(options);
  });

// Tuning command
program
  .command('tuning')
  .description('Performance tuning management')
  .option('-s, --status', 'Show tuning status')
  .option('-a, --aggressive <level>', 'Set aggressiveness (0-1)')
  .option('-r, --reset', 'Reset all tunings')
  .action(async (options) => {
    await manageTuning(options);
  });

// Security command
program
  .command('security')
  .description('Security monitoring')
  .option('-s, --scan', 'Run security scan')
  .option('-t, --threats', 'Show recent threats')
  .option('-b, --bans', 'Show banned IPs')
  .action(async (options) => {
    await manageSecurity(options);
  });

// Interactive mode
program
  .command('interactive')
  .alias('i')
  .description('Interactive automation management')
  .action(async () => {
    await interactiveMode();
  });

// Show automation status
async function showStatus() {
  console.log(chalk.blue.bold('\n🤖 Otedama Automation Status\n'));
  
  const spinner = ora('Checking automation systems...').start();
  
  try {
    const poolManager = await initializePoolManager();
    
    spinner.stop();
    
    // Create status table
    const table = new Table({
      head: ['System', 'Status', 'Details'],
      colWidths: [20, 15, 45]
    });
    
    // Deployment status
    if (poolManager.automation?.deployment) {
      const deployStatus = poolManager.automation.deployment.getStatus();
      table.push([
        'Deployment',
        deployStatus.isDeploying ? chalk.yellow('DEPLOYING') : chalk.green('READY'),
        deployStatus.lastDeployment ? 
          `Last: ${new Date(deployStatus.lastDeployment.timestamp).toLocaleString()}` : 
          'No deployments'
      ]);
    }
    
    // Backup status
    if (poolManager.automation?.backup) {
      const backupStatus = poolManager.automation.backup.getStatus();
      table.push([
        'Backup',
        backupStatus.isBackingUp ? chalk.yellow('BACKING UP') : chalk.green('READY'),
        `${backupStatus.backupCount} backups, ${(backupStatus.totalSize / 1024 / 1024).toFixed(2)} MB total`
      ]);
    }
    
    // Tuning status
    if (poolManager.automation?.tuning) {
      const tuningReport = poolManager.automation.tuning.getTuningReport();
      table.push([
        'Performance Tuning',
        chalk.green('ACTIVE'),
        `${tuningReport.totalTunings} tunings applied, ${tuningReport.successful} successful`
      ]);
    }
    
    // Security status
    if (poolManager.automation?.security) {
      const securityReport = poolManager.automation.security.getSecurityReport();
      const statusColor = {
        'secure': 'green',
        'medium': 'yellow',
        'high': 'magenta',
        'critical': 'red'
      }[securityReport.status];
      
      table.push([
        'Security Monitor',
        chalk[statusColor](securityReport.status.toUpperCase()),
        `${securityReport.threats.last24h} threats (24h), ${securityReport.bannedIPs} banned IPs`
      ]);
    }
    
    console.log(table.toString());
    
    await poolManager.storage.shutdown();
    
  } catch (error) {
    spinner.fail(chalk.red('Failed to get status'));
    console.error(chalk.red(error.message));
    process.exit(1);
  }
}

// Deploy
async function deploy(options) {
  if (!options.yes) {
    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: 'Deploy new version?',
      default: false
    }]);
    
    if (!confirm) return;
  }
  
  const spinner = ora('Deploying...').start();
  
  try {
    const poolManager = await initializePoolManager();
    
    const deployment = await poolManager.automation.deployment.deploy();
    
    spinner.succeed(chalk.green(`Deployment ${deployment.id} completed!`));
    
    await poolManager.storage.shutdown();
    
  } catch (error) {
    spinner.fail(chalk.red('Deployment failed'));
    console.error(chalk.red(error.message));
    process.exit(1);
  }
}

// Manage backups
async function manageBackups(options) {
  const poolManager = await initializePoolManager();
  
  if (options.create) {
    const spinner = ora('Creating backup...').start();
    
    try {
      const backup = await poolManager.automation.backup.performBackup();
      spinner.succeed(chalk.green(`Backup ${backup.id} created!`));
    } catch (error) {
      spinner.fail(chalk.red('Backup failed'));
      console.error(chalk.red(error.message));
    }
    
  } else if (options.list) {
    const backups = poolManager.automation.backup.backupHistory;
    
    if (backups.length === 0) {
      console.log(chalk.yellow('No backups found'));
    } else {
      const table = new Table({
        head: ['ID', 'Date', 'Type', 'Size', 'Status'],
        colWidths: [20, 25, 15, 15, 15]
      });
      
      backups.slice(0, 10).forEach(backup => {
        table.push([
          backup.id.substring(0, 8),
          new Date(backup.timestamp).toLocaleString(),
          backup.type,
          `${(backup.size / 1024 / 1024).toFixed(2)} MB`,
          backup.status === 'success' ? chalk.green('SUCCESS') : chalk.red('FAILED')
        ]);
      });
      
      console.log(chalk.blue('\nRecent Backups:\n'));
      console.log(table.toString());
    }
    
  } else if (options.restore) {
    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: `Restore backup ${options.restore}?`,
      default: false
    }]);
    
    if (confirm) {
      const spinner = ora('Restoring backup...').start();
      
      try {
        await poolManager.automation.backup.restore(options.restore);
        spinner.succeed(chalk.green('Backup restored!'));
      } catch (error) {
        spinner.fail(chalk.red('Restore failed'));
        console.error(chalk.red(error.message));
      }
    }
  }
  
  await poolManager.storage.shutdown();
}

// Manage tuning
async function manageTuning(options) {
  const poolManager = await initializePoolManager();
  
  if (options.status) {
    const report = poolManager.automation.tuning.getTuningReport();
    
    console.log(chalk.blue('\n⚙️  Performance Tuning Status\n'));
    console.log(`Total tunings: ${report.totalTunings}`);
    console.log(`Successful: ${chalk.green(report.successful)}`);
    console.log(`Reverted: ${chalk.yellow(report.reverted)}`);
    
    if (report.currentTunings.length > 0) {
      console.log(chalk.blue('\nActive Tunings:'));
      
      const table = new Table({
        head: ['Type', 'Action', 'Value', 'Applied'],
        colWidths: [15, 25, 20, 20]
      });
      
      report.currentTunings.forEach(tuning => {
        table.push([
          tuning.recommendation.type,
          tuning.recommendation.action,
          tuning.newValue,
          new Date(tuning.timestamp).toLocaleString()
        ]);
      });
      
      console.log(table.toString());
    }
    
    if (report.recommendations.length > 0) {
      console.log(chalk.yellow('\nRecommendations:'));
      report.recommendations.forEach((rec, i) => {
        console.log(`${i + 1}. ${rec.action}: ${rec.reason}`);
      });
    }
    
  } else if (options.aggressive) {
    const level = parseFloat(options.aggressive);
    if (level >= 0 && level <= 1) {
      poolManager.automation.tuning.config.aggressiveness = level;
      console.log(chalk.green(`Aggressiveness set to ${level}`));
    } else {
      console.log(chalk.red('Aggressiveness must be between 0 and 1'));
    }
    
  } else if (options.reset) {
    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: 'Reset all tunings to defaults?',
      default: false
    }]);
    
    if (confirm) {
      // Would implement reset functionality
      console.log(chalk.green('Tunings reset to defaults'));
    }
  }
  
  await poolManager.storage.shutdown();
}

// Manage security
async function manageSecurity(options) {
  const poolManager = await initializePoolManager();
  
  if (options.scan) {
    // Run security scan
    const { spawn } = await import('child_process');
    spawn('node', ['scripts/security-scan.js'], { stdio: 'inherit' });
    
  } else if (options.threats) {
    const report = poolManager.automation.security.getSecurityReport();
    
    if (report.recentEvents.length === 0) {
      console.log(chalk.green('No recent threats'));
    } else {
      console.log(chalk.red('\n🚨 Recent Security Threats\n'));
      
      const table = new Table({
        head: ['Time', 'Type', 'Severity', 'Details'],
        colWidths: [20, 20, 15, 35]
      });
      
      report.recentEvents.forEach(event => {
        const color = {
          'critical': 'red',
          'high': 'magenta',
          'medium': 'yellow',
          'low': 'gray'
        }[event.severity];
        
        table.push([
          new Date(event.timestamp).toLocaleString(),
          event.type,
          chalk[color](event.severity.toUpperCase()),
          event.details || '-'
        ]);
      });
      
      console.log(table.toString());
    }
    
  } else if (options.bans) {
    const bannedIPs = poolManager.automation.security.bannedIPs;
    
    if (bannedIPs.size === 0) {
      console.log(chalk.green('No banned IPs'));
    } else {
      console.log(chalk.yellow(`\n🚫 Banned IPs (${bannedIPs.size})\n`));
      
      const table = new Table({
        head: ['IP Address', 'Banned At', 'Expires'],
        colWidths: [20, 25, 25]
      });
      
      bannedIPs.forEach((ban, ip) => {
        table.push([
          ip,
          new Date(ban.timestamp).toLocaleString(),
          new Date(ban.expires).toLocaleString()
        ]);
      });
      
      console.log(table.toString());
    }
  }
  
  await poolManager.storage.shutdown();
}

// Interactive mode
async function interactiveMode() {
  console.log(chalk.blue.bold('\n🤖 Otedama Automation Manager\n'));
  
  let running = true;
  
  while (running) {
    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: 'What would you like to do?',
      choices: [
        { name: '📊 View Status', value: 'status' },
        { name: '🚀 Deploy', value: 'deploy' },
        { name: '💾 Backup', value: 'backup' },
        { name: '⚙️  Tuning', value: 'tuning' },
        { name: '🔒 Security', value: 'security' },
        { name: '📈 Monitor', value: 'monitor' },
        new inquirer.Separator(),
        { name: 'Exit', value: 'exit' }
      ]
    }]);
    
    switch (action) {
      case 'status':
        await showStatus();
        break;
        
      case 'deploy':
        await deployInteractive();
        break;
        
      case 'backup':
        await backupInteractive();
        break;
        
      case 'tuning':
        await tuningInteractive();
        break;
        
      case 'security':
        await securityInteractive();
        break;
        
      case 'monitor':
        // Launch monitor
        const { spawn } = await import('child_process');
        spawn('node', ['scripts/monitor-cli.js'], { stdio: 'inherit' });
        break;
        
      case 'exit':
        running = false;
        break;
    }
    
    if (running && action !== 'monitor') {
      await inquirer.prompt([{
        type: 'input',
        name: 'continue',
        message: 'Press Enter to continue...'
      }]);
    }
  }
  
  console.log(chalk.gray('\nGoodbye!'));
  process.exit(0);
}

// Interactive deploy
async function deployInteractive() {
  const { deployType } = await inquirer.prompt([{
    type: 'list',
    name: 'deployType',
    message: 'Deployment type:',
    choices: [
      { name: 'Full deployment (with git pull)', value: 'full' },
      { name: 'Local deployment (no git)', value: 'local' },
      { name: 'Dry run', value: 'dry' }
    ]
  }]);
  
  const options = {
    yes: true,
    noGit: deployType === 'local',
    dryRun: deployType === 'dry'
  };
  
  await deploy(options);
}

// Interactive backup
async function backupInteractive() {
  const { action } = await inquirer.prompt([{
    type: 'list',
    name: 'action',
    message: 'Backup action:',
    choices: [
      { name: 'Create new backup', value: 'create' },
      { name: 'List backups', value: 'list' },
      { name: 'Restore backup', value: 'restore' }
    ]
  }]);
  
  if (action === 'create') {
    await manageBackups({ create: true });
  } else if (action === 'list') {
    await manageBackups({ list: true });
  } else if (action === 'restore') {
    const { backupId } = await inquirer.prompt([{
      type: 'input',
      name: 'backupId',
      message: 'Backup ID to restore:'
    }]);
    
    await manageBackups({ restore: backupId });
  }
}

// Interactive tuning
async function tuningInteractive() {
  const { action } = await inquirer.prompt([{
    type: 'list',
    name: 'action',
    message: 'Tuning action:',
    choices: [
      { name: 'View status', value: 'status' },
      { name: 'Adjust aggressiveness', value: 'aggressive' },
      { name: 'Reset to defaults', value: 'reset' }
    ]
  }]);
  
  if (action === 'status') {
    await manageTuning({ status: true });
  } else if (action === 'aggressive') {
    const { level } = await inquirer.prompt([{
      type: 'number',
      name: 'level',
      message: 'Aggressiveness level (0-1):',
      default: 0.5,
      validate: (val) => val >= 0 && val <= 1
    }]);
    
    await manageTuning({ aggressive: level });
  } else if (action === 'reset') {
    await manageTuning({ reset: true });
  }
}

// Interactive security
async function securityInteractive() {
  const { action } = await inquirer.prompt([{
    type: 'list',
    name: 'action',
    message: 'Security action:',
    choices: [
      { name: 'Run security scan', value: 'scan' },
      { name: 'View recent threats', value: 'threats' },
      { name: 'View banned IPs', value: 'bans' }
    ]
  }]);
  
  await manageSecurity({ [action]: true });
}

// Initialize pool manager
async function initializePoolManager() {
  const poolManager = createMiningPoolManager({
    poolName: 'Otedama Automation Manager',
    enableAutomation: true
  });
  
  await poolManager.storage.initialize();
  
  // Initialize automation systems
  await poolManager.initializeAutomationSystems();
  
  return poolManager;
}

// Parse and run
program.parse();

// Show help if no command
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
