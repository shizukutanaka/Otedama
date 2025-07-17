#!/usr/bin/env node

/**
 * Data Export CLI for Otedama
 * Export data in various formats from command line
 */

import { createExportManager, ExportFormat } from '../lib/export.js';
import { Logger } from '../lib/logger.js';
import { readFile } from 'fs/promises';
import { join } from 'path';

// Parse command line arguments
const args = process.argv.slice(2);
const command = args[0];

const logger = new Logger();

// Initialize export manager
const exportManager = createExportManager({
  logger,
  outputPath: './exports'
});

async function exportData(source, format, options = {}) {
  try {
    logger.info(`Exporting data from ${source} as ${format}...`);
    
    // Load data
    const data = await loadData(source);
    
    if (!data) {
      logger.error('No data to export');
      process.exit(1);
    }
    
    // Export data
    const result = await exportManager.export(data, format, options);
    
    logger.info('Export completed successfully', {
      path: result.path,
      size: formatSize(result.size),
      format: result.format,
      compressed: result.compressed
    });
    
    console.log(`\nExport saved to: ${result.path}`);
    console.log(`Size: ${formatSize(result.size)}`);
    
  } catch (error) {
    logger.error('Export failed', { error });
    process.exit(1);
  }
}

async function loadData(source) {
  // Check if source is a file
  if (source.endsWith('.json')) {
    const content = await readFile(source, 'utf8');
    return JSON.parse(content);
  }
  
  // Otherwise, load from database/API
  // This is a mock implementation
  logger.info('Loading data from source...', { source });
  
  switch (source) {
    case 'miners':
      return generateMockMiners();
      
    case 'transactions':
      return generateMockTransactions();
      
    case 'blocks':
      return generateMockBlocks();
      
    case 'stats':
      return generateMockStats();
      
    default:
      throw new Error(`Unknown data source: ${source}`);
  }
}

function generateMockMiners() {
  const miners = [];
  
  for (let i = 1; i <= 100; i++) {
    miners.push({
      id: `miner_${i}`,
      name: `Miner ${i}`,
      wallet: `bc1q${Math.random().toString(36).substring(2, 15)}`,
      hashrate: Math.floor(Math.random() * 1000) * 1e12, // TH/s
      shares: Math.floor(Math.random() * 10000),
      efficiency: 95 + Math.random() * 5,
      lastSeen: new Date(Date.now() - Math.random() * 3600000).toISOString(),
      totalEarnings: Math.random() * 10,
      pendingBalance: Math.random() * 0.1,
      workers: Math.floor(Math.random() * 10) + 1
    });
  }
  
  return miners;
}

function generateMockTransactions() {
  const transactions = [];
  
  for (let i = 1; i <= 500; i++) {
    transactions.push({
      id: `tx_${i}`,
      type: Math.random() > 0.5 ? 'payout' : 'fee',
      amount: Math.random() * 0.1,
      currency: 'BTC',
      from: `wallet_${Math.floor(Math.random() * 100)}`,
      to: `bc1q${Math.random().toString(36).substring(2, 15)}`,
      status: Math.random() > 0.1 ? 'confirmed' : 'pending',
      timestamp: new Date(Date.now() - Math.random() * 86400000 * 30).toISOString(),
      blockHeight: Math.floor(Math.random() * 1000) + 700000,
      fee: Math.random() * 0.0001
    });
  }
  
  return transactions;
}

function generateMockBlocks() {
  const blocks = [];
  
  for (let i = 1; i <= 50; i++) {
    blocks.push({
      height: 700000 + i,
      hash: '0x' + Math.random().toString(16).substring(2).padEnd(64, '0'),
      previousHash: '0x' + Math.random().toString(16).substring(2).padEnd(64, '0'),
      timestamp: new Date(Date.now() - i * 600000).toISOString(),
      difficulty: Math.floor(Math.random() * 1e12),
      nonce: Math.floor(Math.random() * 4294967296),
      minerReward: 6.25,
      transactionCount: Math.floor(Math.random() * 3000),
      size: Math.floor(Math.random() * 1000000) + 500000,
      foundBy: `miner_${Math.floor(Math.random() * 100) + 1}`
    });
  }
  
  return blocks;
}

function generateMockStats() {
  return {
    pool: {
      totalHashrate: 2.5e15, // 2.5 PH/s
      activeMiners: 1234,
      totalWorkers: 5678,
      blocksFound24h: 12,
      efficiency: 98.5,
      uptime: 99.9
    },
    revenue: {
      total24h: 12.5,
      fees24h: 0.25,
      payouts24h: 11.8,
      pendingPayouts: 2.3
    },
    network: {
      difficulty: 35.36e12,
      hashrate: 350e18, // 350 EH/s
      blockHeight: 750123,
      avgBlockTime: 9.8,
      mempoolSize: 45000
    },
    currencies: {
      BTC: {
        price: 36742.50,
        change24h: 2.4
      },
      ETH: {
        price: 1985.20,
        change24h: -1.2
      }
    }
  };
}

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  
  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

function showHelp() {
  console.log(`
Otedama Data Export Tool

Usage:
  node export-data.js <source> <format> [options]

Data Sources:
  miners         Export miner data
  transactions   Export transaction history
  blocks         Export block data
  stats          Export statistics
  <file.json>    Export from JSON file

Export Formats:
  json    JSON format
  csv     CSV format
  xml     XML format
  sql     SQL insert statements
  archive ZIP archive with multiple formats

Options:
  --output, -o <file>     Output filename
  --compress, -c          Compress output
  --columns <cols>        Comma-separated list of columns (CSV)
  --pretty                Pretty print (JSON/XML)
  --table <name>          Table name (SQL)
  --formats <formats>     Formats to include in archive

Examples:
  node export-data.js miners csv
  node export-data.js transactions json --pretty
  node export-data.js blocks sql --table mining_blocks
  node export-data.js stats archive --formats json,csv,xml
  node export-data.js data.json csv --columns id,amount,status
`);
}

// Parse options
function parseOptions(args) {
  const options = {};
  
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--output':
      case '-o':
        options.filename = args[++i];
        break;
        
      case '--compress':
      case '-c':
        options.compress = true;
        break;
        
      case '--columns':
        options.columns = args[++i].split(',');
        break;
        
      case '--pretty':
        options.pretty = true;
        break;
        
      case '--table':
        options.tableName = args[++i];
        break;
        
      case '--formats':
        options.formats = args[++i].split(',');
        break;
        
      case '--no-header':
        options.header = false;
        break;
        
      case '--delimiter':
        options.delimiter = args[++i];
        break;
    }
  }
  
  return options;
}

// Main execution
async function main() {
  if (args.length < 2) {
    showHelp();
    process.exit(0);
  }
  
  const source = args[0];
  const format = args[1];
  
  if (!format || !Object.values(ExportFormat).includes(format)) {
    console.error(`Invalid format: ${format}`);
    showHelp();
    process.exit(1);
  }
  
  const options = parseOptions(args.slice(2));
  
  await exportData(source, format, options);
  process.exit(0);
}

// Handle errors
process.on('unhandledRejection', (error) => {
  logger.error('Unhandled rejection', { error });
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error });
  process.exit(1);
});

// Run main
main();