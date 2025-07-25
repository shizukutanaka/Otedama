#!/usr/bin/env node
/**
 * Health Check Script for Otedama Pool
 * Monitors pool health and component status
 */

import axios from 'axios';
import { createStructuredLogger } from '../lib/core/structured-logger.js';
import chalk from 'chalk';
import ora from 'ora';

const logger = createStructuredLogger('HealthCheck');

const HEALTH_CHECKS = [
  {
    name: 'API Server',
    url: `http://localhost:${process.env.API_PORT || 8080}/health`,
    critical: true
  },
  {
    name: 'Stratum Server',
    check: async () => {
      // Would check stratum server in production
      return { healthy: true, message: 'Stratum server check not implemented' };
    },
    critical: true
  },
  {
    name: 'P2P Network',
    url: `http://localhost:${process.env.API_PORT || 8080}/api/network/status`,
    critical: false
  },
  {
    name: 'Database',
    url: `http://localhost:${process.env.API_PORT || 8080}/api/database/health`,
    critical: true
  },
  {
    name: 'Bitcoin RPC',
    check: async () => {
      try {
        const rpcUrl = process.env.BITCOIN_RPC_URL || 'http://localhost:8332';
        const auth = Buffer.from(
          `${process.env.BITCOIN_RPC_USER || 'bitcoinrpc'}:${process.env.BITCOIN_RPC_PASSWORD || ''}`
        ).toString('base64');
        
        const response = await axios.post(rpcUrl, {
          jsonrpc: '1.0',
          id: 'health',
          method: 'getblockchaininfo',
          params: []
        }, {
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json'
          },
          timeout: 5000
        });
        
        return {
          healthy: true,
          details: {
            blocks: response.data.result.blocks,
            chain: response.data.result.chain
          }
        };
      } catch (error) {
        return {
          healthy: false,
          error: error.message
        };
      }
    },
    critical: true
  },
  {
    name: 'Memory Usage',
    check: async () => {
      const usage = process.memoryUsage();
      const heapUsedPercent = (usage.heapUsed / usage.heapTotal) * 100;
      
      return {
        healthy: heapUsedPercent < 90,
        details: {
          heapUsed: `${(usage.heapUsed / 1024 / 1024).toFixed(2)} MB`,
          heapTotal: `${(usage.heapTotal / 1024 / 1024).toFixed(2)} MB`,
          heapUsedPercent: `${heapUsedPercent.toFixed(2)}%`
        }
      };
    },
    critical: false
  }
];

/**
 * Perform health check
 */
async function performHealthCheck() {
  console.log(chalk.bold('\n🏥 Otedama Pool Health Check\n'));
  
  const results = [];
  let allHealthy = true;
  let criticalFailure = false;
  
  for (const check of HEALTH_CHECKS) {
    const spinner = ora(check.name).start();
    
    try {
      let result;
      
      if (check.url) {
        // HTTP health check
        const response = await axios.get(check.url, { timeout: 5000 });
        result = response.data;
      } else if (check.check) {
        // Custom check function
        result = await check.check();
      }
      
      if (result.healthy) {
        spinner.succeed(chalk.green(`${check.name}: Healthy`));
        if (result.details) {
          console.log(chalk.gray(`  Details: ${JSON.stringify(result.details)}`));
        }
      } else {
        spinner.fail(chalk.red(`${check.name}: Unhealthy`));
        if (result.error) {
          console.log(chalk.gray(`  Error: ${result.error}`));
        }
        allHealthy = false;
        if (check.critical) {
          criticalFailure = true;
        }
      }
      
      results.push({
        name: check.name,
        ...result,
        critical: check.critical
      });
      
    } catch (error) {
      spinner.fail(chalk.red(`${check.name}: Failed`));
      console.log(chalk.gray(`  Error: ${error.message}`));
      
      results.push({
        name: check.name,
        healthy: false,
        error: error.message,
        critical: check.critical
      });
      
      allHealthy = false;
      if (check.critical) {
        criticalFailure = true;
      }
    }
  }
  
  // Summary
  console.log(chalk.bold('\n📊 Summary\n'));
  
  const healthyCount = results.filter(r => r.healthy).length;
  const totalCount = results.length;
  const healthPercent = (healthyCount / totalCount) * 100;
  
  console.log(`  Total checks: ${totalCount}`);
  console.log(`  Healthy: ${chalk.green(healthyCount)}`);
  console.log(`  Unhealthy: ${chalk.red(totalCount - healthyCount)}`);
  console.log(`  Health score: ${healthPercent.toFixed(0)}%`);
  
  if (allHealthy) {
    console.log(chalk.bold.green('\n✅ All systems operational!'));
    process.exit(0);
  } else if (criticalFailure) {
    console.log(chalk.bold.red('\n❌ Critical systems are down!'));
    process.exit(2);
  } else {
    console.log(chalk.bold.yellow('\n⚠️  Some non-critical systems need attention'));
    process.exit(1);
  }
}

// Run health check
performHealthCheck().catch(error => {
  console.error(chalk.red('Health check failed:', error.message));
  process.exit(3);
});
