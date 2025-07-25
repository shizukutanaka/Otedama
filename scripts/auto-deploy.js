#!/usr/bin/env node

/**
 * Automated Deployment Script - Otedama
 * Execute zero-downtime deployment
 */

import { createMiningPoolManager } from '../lib/mining/pool-manager.js';
import { createLogger } from '../lib/core/logger.js';
import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';

const logger = createLogger('Deploy');
const program = new Command();

program
  .name('auto-deploy')
  .description('Deploy Otedama mining pool with zero downtime')
  .version('1.0.0')
  .option('-y, --yes', 'Skip confirmation')
  .option('--no-git', 'Skip git pull')
  .option('--no-rollback', 'Disable automatic rollback')
  .option('--dry-run', 'Simulate deployment without changes');

async function deploy() {
  const options = program.opts();
  
  console.log(chalk.blue.bold('\n🚀 Otedama Automated Deployment\n'));
  
  // Confirmation
  if (!options.yes && !options.dryRun) {
    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: 'Deploy new version to production?',
      default: false
    }]);
    
    if (!confirm) {
      console.log(chalk.yellow('Deployment cancelled'));
      process.exit(0);
    }
  }
  
  try {
    // Initialize pool manager (minimal)
    const poolManager = createMiningPoolManager({
      poolName: 'Otedama Mining Pool',
      enableAutomation: true,
      automation: {
        enableAutoDeployment: true
      }
    });
    
    // Initialize only deployment system
    await poolManager.storage.initialize();
    poolManager.automation = {};
    
    const { AutomatedDeploymentSystem } = await import('../lib/automation/auto-deploy.js');
    poolManager.automation.deployment = new AutomatedDeploymentSystem({
      rollbackOnFailure: !options.noRollback
    });
    
    await poolManager.automation.deployment.initialize();
    
    console.log(chalk.cyan('Starting deployment process...\n'));
    
    // Deployment steps visualization
    poolManager.automation.deployment.on('deployment:started', (deployment) => {
      console.log(chalk.green(`✓ Deployment ${deployment.id} started`));
    });
    
    let currentStep = null;
    const originalRunStep = poolManager.automation.deployment.runStep.bind(poolManager.automation.deployment);
    
    poolManager.automation.deployment.runStep = async function(deployment, name, fn) {
      currentStep = name;
      process.stdout.write(chalk.cyan(`  ${name}... `));
      
      try {
        await originalRunStep(deployment, name, fn);
        console.log(chalk.green('✓'));
      } catch (error) {
        console.log(chalk.red('✗'));
        throw error;
      }
    };
    
    if (options.dryRun) {
      console.log(chalk.yellow('DRY RUN MODE - No changes will be made\n'));
    }
    
    // Execute deployment
    const deployment = await poolManager.automation.deployment.deploy({
      gitPull: !options.noGit,
      dryRun: options.dryRun
    });
    
    console.log(chalk.green.bold('\n✅ Deployment completed successfully!'));
    console.log(chalk.gray(`Deployment ID: ${deployment.id}`));
    console.log(chalk.gray(`Duration: ${deployment.duration}ms`));
    
    // Show deployment summary
    console.log(chalk.blue('\nDeployment Summary:'));
    deployment.steps.forEach(step => {
      const icon = step.status === 'success' ? '✓' : '✗';
      const color = step.status === 'success' ? 'green' : 'red';
      console.log(chalk[color](`  ${icon} ${step.name} (${step.duration}ms)`));
    });
    
    process.exit(0);
    
  } catch (error) {
    console.error(chalk.red.bold('\n❌ Deployment failed!'));
    console.error(chalk.red(error.message));
    
    if (error.stack && process.env.DEBUG) {
      console.error(chalk.gray(error.stack));
    }
    
    process.exit(1);
  }
}

// Handle uncaught errors
process.on('unhandledRejection', (error) => {
  console.error(chalk.red('Unhandled error:'), error);
  process.exit(1);
});

// Parse arguments and run
program.parse();
deploy();
