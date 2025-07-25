#!/usr/bin/env node
/**
 * Otedama Pool Monitor CLI
 * Simple command-line monitoring tool for pool statistics
 * 
 * Usage:
 *   otedama-monitor [options]
 *   otedama-monitor --watch
 *   otedama-monitor --json
 */

import { Command } from 'commander';
import axios from 'axios';
import chalk from 'chalk';
import Table from 'cli-table3';
import ora from 'ora';
import { createLogger } from '../lib/core/logger.js';

const logger = createLogger('PoolMonitor');

/**
 * Pool Monitor CLI
 */
class PoolMonitorCLI {
  constructor(config = {}) {
    this.config = {
      apiUrl: config.apiUrl || process.env.POOL_API_URL || 'http://localhost:8080',
      updateInterval: config.updateInterval || 5000,
      timeout: config.timeout || 5000
    };
    
    this.watchMode = false;
    this.jsonMode = false;
  }
  
  /**
   * Fetch pool statistics
   */
  async fetchPoolStats() {
    try {
      const response = await axios.get(`${this.config.apiUrl}/api/stats`, {
        timeout: this.config.timeout
      });
      return response.data;
    } catch (error) {
      throw new Error(`Failed to fetch pool stats: ${error.message}`);
    }
  }
  
  /**
   * Fetch miner statistics
   */
  async fetchMinerStats(limit = 10) {
    try {
      const response = await axios.get(`${this.config.apiUrl}/api/miners`, {
        params: { limit },
        timeout: this.config.timeout
      });
      return response.data;
    } catch (error) {
      throw new Error(`Failed to fetch miner stats: ${error.message}`);
    }
  }
  
  /**
   * Fetch recent blocks
   */
  async fetchRecentBlocks(limit = 5) {
    try {
      const response = await axios.get(`${this.config.apiUrl}/api/blocks/recent`, {
        params: { limit },
        timeout: this.config.timeout
      });
      return response.data;
    } catch (error) {
      throw new Error(`Failed to fetch recent blocks: ${error.message}`);
    }
  }
  
  /**
   * Display pool overview
   */
  displayPoolOverview(stats) {
    console.log(chalk.cyan('\n═══ Pool Overview ═══\n'));
    
    const table = new Table({
      chars: { 'mid': '', 'left-mid': '', 'mid-mid': '', 'right-mid': '' }
    });
    
    table.push(
      [chalk.gray('Pool Name:'), chalk.white(stats.poolName || 'Otedama Pool')],
      [chalk.gray('Status:'), stats.isRunning ? chalk.green('Online') : chalk.red('Offline')],
      [chalk.gray('Uptime:'), this.formatUptime(stats.uptime || 0)],
      [chalk.gray('Algorithm:'), chalk.white(stats.algorithm || 'SHA256')],
      [chalk.gray('Payment Scheme:'), chalk.white(stats.paymentScheme || 'PPLNS')],
      [chalk.gray('Pool Fee:'), chalk.white(`${(stats.poolFee * 100 || 0).toFixed(2)}%`)]
    );
    
    console.log(table.toString());
  }
  
  /**
   * Display mining statistics
   */
  displayMiningStats(stats) {
    console.log(chalk.cyan('\n═══ Mining Statistics ═══\n'));
    
    const table = new Table({
      chars: { 'mid': '', 'left-mid': '', 'mid-mid': '', 'right-mid': '' }
    });
    
    table.push(
      [chalk.gray('Total Hashrate:'), chalk.yellow(this.formatHashrate(stats.totalHashrate || 0))],
      [chalk.gray('Active Miners:'), chalk.white(stats.connectedMiners || 0)],
      [chalk.gray('Total Workers:'), chalk.white(stats.totalWorkers || 0)],
      [chalk.gray('Blocks Found:'), chalk.green(stats.totalBlocks || 0)],
      [chalk.gray('Total Shares:'), chalk.white(this.formatNumber(stats.totalShares || 0))],
      [chalk.gray('Valid Share Rate:'), chalk.white(`${(stats.validShareRate || 0).toFixed(2)}%`)]
    );
    
    console.log(table.toString());
  }
  
  /**
   * Display top miners
   */
  displayTopMiners(minerData) {
    console.log(chalk.cyan('\n═══ Top Miners ═══\n'));
    
    if (!minerData.miners || minerData.miners.length === 0) {
      console.log(chalk.gray('No miners connected'));
      return;
    }
    
    const table = new Table({
      head: [
        chalk.gray('Address'),
        chalk.gray('Hashrate'),
        chalk.gray('Shares'),
        chalk.gray('Efficiency')
      ],
      colWidths: [40, 15, 15, 12]
    });
    
    minerData.miners.forEach(miner => {
      table.push([
        this.truncateAddress(miner.address),
        chalk.yellow(this.formatHashrate(miner.hashrate || 0)),
        this.formatNumber(miner.validShares || 0),
        `${(miner.efficiency || 0).toFixed(2)}%`
      ]);
    });
    
    console.log(table.toString());
  }
  
  /**
   * Display recent blocks
   */
  displayRecentBlocks(blocks) {
    console.log(chalk.cyan('\n═══ Recent Blocks ═══\n'));
    
    if (!blocks || blocks.length === 0) {
      console.log(chalk.gray('No blocks found yet'));
      return;
    }
    
    const table = new Table({
      head: [
        chalk.gray('Height'),
        chalk.gray('Hash'),
        chalk.gray('Reward'),
        chalk.gray('Time')
      ],
      colWidths: [10, 20, 15, 20]
    });
    
    blocks.forEach(block => {
      table.push([
        block.height,
        this.truncateHash(block.hash),
        `${block.reward} BTC`,
        new Date(block.timestamp).toLocaleString()
      ]);
    });
    
    console.log(table.toString());
  }
  
  /**
   * Display JSON output
   */
  displayJSON(data) {
    console.log(JSON.stringify(data, null, 2));
  }
  
  /**
   * Run monitor once
   */
  async runOnce() {
    const spinner = ora('Fetching pool statistics...').start();
    
    try {
      // Fetch all data
      const [poolStats, minerStats, recentBlocks] = await Promise.all([
        this.fetchPoolStats(),
        this.fetchMinerStats(),
        this.fetchRecentBlocks()
      ]);
      
      spinner.stop();
      
      if (this.jsonMode) {
        this.displayJSON({
          pool: poolStats,
          miners: minerStats,
          blocks: recentBlocks
        });
      } else {
        // Clear screen
        console.clear();
        
        // Display header
        console.log(chalk.blue.bold(`
╔═══════════════════════════════════════════╗
║         Otedama Pool Monitor              ║
╚═══════════════════════════════════════════╝
        `));
        
        // Display stats
        this.displayPoolOverview(poolStats);
        this.displayMiningStats(poolStats);
        this.displayTopMiners(minerStats);
        this.displayRecentBlocks(recentBlocks);
        
        // Display footer
        console.log(chalk.gray(`\nLast updated: ${new Date().toLocaleString()}`));
        
        if (this.watchMode) {
          console.log(chalk.gray(`Refreshing in ${this.config.updateInterval / 1000} seconds... (Press Ctrl+C to exit)`));
        }
      }
      
    } catch (error) {
      spinner.stop();
      console.error(chalk.red(`Error: ${error.message}`));
      
      if (!this.watchMode) {
        process.exit(1);
      }
    }
  }
  
  /**
   * Run in watch mode
   */
  async runWatch() {
    this.watchMode = true;
    
    // Initial run
    await this.runOnce();
    
    // Setup interval
    setInterval(() => {
      this.runOnce();
    }, this.config.updateInterval);
    
    // Handle Ctrl+C
    process.on('SIGINT', () => {
      console.log(chalk.yellow('\n\nStopping monitor...'));
      process.exit(0);
    });
  }
  
  /**
   * Format hashrate
   */
  formatHashrate(hashrate) {
    const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
    let unitIndex = 0;
    let value = parseFloat(hashrate) || 0;
    
    while (value >= 1000 && unitIndex < units.length - 1) {
      value /= 1000;
      unitIndex++;
    }
    
    return `${value.toFixed(2)} ${units[unitIndex]}`;
  }
  
  /**
   * Format number
   */
  formatNumber(num) {
    return new Intl.NumberFormat().format(num);
  }
  
  /**
   * Format uptime
   */
  formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    
    return parts.join(' ') || '0m';
  }
  
  /**
   * Truncate address
   */
  truncateAddress(address) {
    if (!address) return 'Unknown';
    if (address.length <= 40) return address;
    return `${address.substring(0, 20)}...${address.substring(address.length - 17)}`;
  }
  
  /**
   * Truncate hash
   */
  truncateHash(hash) {
    if (!hash) return 'Unknown';
    return `${hash.substring(0, 16)}...`;
  }
}

/**
 * Main CLI
 */
async function main() {
  const program = new Command();
  
  program
    .name('otedama-monitor')
    .description('Monitor Otedama mining pool statistics')
    .version('1.0.0')
    .option('-u, --url <url>', 'Pool API URL', 'http://localhost:8080')
    .option('-w, --watch', 'Watch mode - refresh automatically')
    .option('-i, --interval <seconds>', 'Update interval in seconds', '5')
    .option('-j, --json', 'Output as JSON')
    .option('-m, --miners <count>', 'Number of top miners to show', '10')
    .option('-b, --blocks <count>', 'Number of recent blocks to show', '5')
    .parse();
  
  const options = program.opts();
  
  // Create monitor
  const monitor = new PoolMonitorCLI({
    apiUrl: options.url,
    updateInterval: parseInt(options.interval) * 1000
  });
  
  monitor.jsonMode = options.json;
  
  // Run
  if (options.watch) {
    await monitor.runWatch();
  } else {
    await monitor.runOnce();
  }
}

// Run CLI
main().catch(error => {
  console.error(chalk.red('Fatal error:'), error.message);
  process.exit(1);
});
