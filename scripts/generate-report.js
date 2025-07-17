#!/usr/bin/env node

/**
 * Report Generation CLI for Otedama
 * Generate analytics reports from command line
 */

import { createAnalytics } from '../lib/analytics.js';
import { Logger } from '../lib/logger.js';
import { writeFile } from 'fs/promises';
import { join } from 'path';

// Parse command line arguments
const args = process.argv.slice(2);
const command = args[0];

const logger = new Logger();

// Initialize analytics
const analytics = createAnalytics({
  logger,
  reportsPath: './reports'
});

async function generateReport(type, period = 'daily') {
  try {
    logger.info(`Generating ${type} report for ${period} period...`);
    
    const report = await analytics.generateReport(type, { period });
    
    // Save to file
    const filename = `${type}_${period}_${new Date().toISOString().split('T')[0]}.json`;
    const filepath = join('./reports', filename);
    
    await writeFile(filepath, JSON.stringify(report, null, 2));
    
    logger.info(`Report generated successfully: ${filepath}`);
    
    // Print summary
    console.log('\nReport Summary:');
    console.log('================');
    console.log(`Type: ${report.type}`);
    console.log(`Period: ${report.period}`);
    console.log(`Generated: ${new Date(report.generatedAt).toLocaleString()}`);
    
    if (type === 'mining' && report.data.overview) {
      console.log('\nMining Overview:');
      console.log(`- Average Hashrate: ${formatHashrate(report.data.overview.totalHashrate)}`);
      console.log(`- Active Miners: ${report.data.overview.totalMiners}`);
      console.log(`- Blocks Found: ${report.data.overview.blocksFound}`);
      console.log(`- Efficiency: ${report.data.overview.efficiency?.toFixed(2)}%`);
    } else if (type === 'revenue' && report.data.overview) {
      console.log('\nRevenue Overview:');
      console.log(`- Total Revenue: ${formatBTC(report.data.overview.totalRevenue)} BTC`);
      console.log(`- Mining Revenue: ${formatBTC(report.data.overview.miningRevenue)} BTC`);
      console.log(`- Fee Revenue: ${formatBTC(report.data.overview.feeRevenue)} BTC`);
      console.log(`- Total Payouts: ${formatBTC(report.data.overview.totalPayouts)} BTC`);
    }
    
  } catch (error) {
    logger.error('Report generation failed', { error });
    process.exit(1);
  }
}

async function listReports(type = null) {
  try {
    const reports = await analytics.listReports(type);
    
    console.log('\nAvailable Reports:');
    console.log('==================');
    
    if (reports.length === 0) {
      console.log('No reports found.');
      return;
    }
    
    reports.forEach(report => {
      const date = new Date(report.generatedAt).toLocaleString();
      console.log(`- ${report.id}`);
      console.log(`  Type: ${report.type}`);
      console.log(`  Period: ${report.period}`);
      console.log(`  Generated: ${date}`);
      console.log('');
    });
    
  } catch (error) {
    logger.error('Failed to list reports', { error });
    process.exit(1);
  }
}

async function exportMetrics(format = 'json', output = null) {
  try {
    logger.info(`Exporting metrics in ${format} format...`);
    
    const data = await analytics.exportMetrics(format, {
      start: Date.now() - 86400000, // Last 24 hours
      end: Date.now()
    });
    
    if (output) {
      await writeFile(output, data);
      logger.info(`Metrics exported to: ${output}`);
    } else {
      console.log(data);
    }
    
  } catch (error) {
    logger.error('Metrics export failed', { error });
    process.exit(1);
  }
}

// Helper functions
function formatHashrate(hashrate) {
  if (!hashrate) return '0 H/s';
  
  const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
  let value = hashrate;
  let unitIndex = 0;
  
  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex++;
  }
  
  return `${value.toFixed(2)} ${units[unitIndex]}`;
}

function formatBTC(satoshis) {
  if (!satoshis) return '0';
  return (satoshis / 100000000).toFixed(8);
}

// Show help
function showHelp() {
  console.log(`
Otedama Report Generator

Usage:
  node generate-report.js <command> [options]

Commands:
  generate <type> [period]   Generate a report
  list [type]               List available reports
  export [format] [output]  Export metrics data
  help                      Show this help message

Report Types:
  mining      Mining statistics and performance
  revenue     Revenue and payout analytics
  performance System performance metrics
  security    Security audit and threat analysis
  custom      Custom report with specified metrics

Periods:
  hourly      Last hour
  daily       Last 24 hours (default)
  weekly      Last 7 days
  monthly     Last 30 days

Export Formats:
  json        JSON format (default)
  csv         CSV format
  prometheus  Prometheus format

Examples:
  node generate-report.js generate mining daily
  node generate-report.js generate revenue weekly
  node generate-report.js list
  node generate-report.js export csv metrics.csv
`);
}

// Main execution
async function main() {
  switch (command) {
    case 'generate':
      if (!args[1]) {
        console.error('Error: Report type required');
        showHelp();
        process.exit(1);
      }
      await generateReport(args[1], args[2]);
      break;
      
    case 'list':
      await listReports(args[1]);
      break;
      
    case 'export':
      await exportMetrics(args[1], args[2]);
      break;
      
    case 'help':
    case '--help':
    case '-h':
      showHelp();
      break;
      
    default:
      console.error(`Unknown command: ${command}`);
      showHelp();
      process.exit(1);
  }
  
  // Cleanup
  await analytics.cleanup();
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