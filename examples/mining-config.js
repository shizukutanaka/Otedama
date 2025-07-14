#!/usr/bin/env node

/**
 * Otedama - Example: Mining Configuration
 * This example demonstrates different mining configurations
 */

import fs from 'fs';

// Example configurations for different scenarios

// 1. Basic Ravencoin mining configuration
const ravencoinConfig = {
  "pool": {
    "name": "My RVN Mining Pool",
    "fee": 1.0,
    "minPayout": {
      "BTC": 0.001,
      "RVN": 100,
      "XMR": 0.1,
      "ETC": 1,
      "LTC": 0.1,
      "DOGE": 100
    },
    "payoutInterval": 3600000
  },
  "mining": {
    "enabled": true,
    "currency": "RVN",
    "algorithm": "kawpow",
    "walletAddress": "RYourRavencoinWalletAddressHere",
    "threads": 0,
    "intensity": 100
  },
  "network": {
    "p2pPort": 8333,
    "stratumPort": 3333,
    "apiPort": 8080,
    "maxPeers": 50,
    "maxMiners": 1000
  },
  "dex": {
    "enabled": true,
    "tradingFee": 0.3,
    "minLiquidity": 0.001,
    "maxSlippage": 5.0
  }
};

// 2. Bitcoin mining configuration
const bitcoinConfig = {
  ...ravencoinConfig,
  "pool": {
    ...ravencoinConfig.pool,
    "name": "My BTC Mining Pool"
  },
  "mining": {
    ...ravencoinConfig.mining,
    "currency": "BTC",
    "algorithm": "sha256",
    "walletAddress": "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"
  }
};

// 3. Monero mining configuration
const moneroConfig = {
  ...ravencoinConfig,
  "pool": {
    ...ravencoinConfig.pool,
    "name": "My XMR Mining Pool"
  },
  "mining": {
    ...ravencoinConfig.mining,
    "currency": "XMR",
    "algorithm": "randomx",
    "walletAddress": "4AdUndXHHZ6cfufTMvppY6JwXNouMBzSkbLYfpAV5Usx2P5HYipNgZtqBrMmPLtqHGYzEDPXG5JHdW5pBF2VzjPGKs5N5y2",
    "threads": 8  // RandomX benefits from more threads
  }
};

// 4. High-performance configuration
const performanceConfig = {
  ...ravencoinConfig,
  "mining": {
    ...ravencoinConfig.mining,
    "threads": 16,  // Use more threads
    "intensity": 100  // Maximum intensity
  },
  "network": {
    ...ravencoinConfig.network,
    "maxMiners": 5000  // Support more miners
  },
  "monitoring": {
    "enableMetrics": true,
    "metricsPort": 9090,
    "alertThresholds": {
      "cpuUsage": 95,
      "memoryUsage": 90,
      "minerDisconnectRate": 10
    }
  }
};

// 5. Security-focused configuration
const secureConfig = {
  ...ravencoinConfig,
  "security": {
    "enableRateLimit": true,
    "maxRequestsPerMinute": 60,
    "enableAuth": true,
    "apiKey": ""  // Will be generated on first run
  },
  "network": {
    ...ravencoinConfig.network,
    "maxPeers": 20,  // Limit peers
    "maxMiners": 100  // Limit miners
  }
};

// Function to save configuration
function saveConfig(config, filename = 'otedama.json') {
  try {
    fs.writeFileSync(filename, JSON.stringify(config, null, 2));
    console.log(`Configuration saved to ${filename}`);
  } catch (error) {
    console.error('Failed to save configuration:', error.message);
  }
}

// Function to display configuration
function displayConfig(name, config) {
  console.log(`\n=== ${name} ===`);
  console.log(`Currency: ${config.mining.currency}`);
  console.log(`Algorithm: ${config.mining.algorithm}`);
  console.log(`Pool Fee: ${config.pool.fee}%`);
  console.log(`Threads: ${config.mining.threads || 'Auto'}`);
  console.log(`Stratum Port: ${config.network.stratumPort}`);
  console.log(`API Port: ${config.network.apiPort}`);
}

// Main function
function main() {
  console.log('Otedama Mining Configuration Examples\n');
  
  // Display all configurations
  displayConfig('Ravencoin Mining', ravencoinConfig);
  displayConfig('Bitcoin Mining', bitcoinConfig);
  displayConfig('Monero Mining', moneroConfig);
  displayConfig('High Performance', performanceConfig);
  displayConfig('Security Focused', secureConfig);
  
  // Prompt for configuration choice
  console.log('\n' + '='.repeat(50));
  console.log('To use one of these configurations:');
  console.log('1. Edit the wallet address in the configuration');
  console.log('2. Save it as otedama.json');
  console.log('3. Run: node index.js');
  
  console.log('\nExample command to start with Ravencoin:');
  console.log('node index.js --wallet RYourWalletAddress --currency RVN');
  
  // Save example configuration
  console.log('\nSaving example configuration to otedama-example.json...');
  saveConfig(ravencoinConfig, 'otedama-example.json');
}

// Run the example
main();
