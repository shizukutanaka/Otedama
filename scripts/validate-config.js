#!/usr/bin/env node
/**
 * Configuration Validator for Otedama Pool
 * Validates pool configuration before startup
 */

import { createStructuredLogger } from '../lib/core/structured-logger.js';
import { ValidationError } from '../lib/core/error-handler-unified.js';
import dotenv from 'dotenv';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config();

const logger = createStructuredLogger('ConfigValidator');

/**
 * Configuration schema
 */
const CONFIG_SCHEMA = {
  // Required environment variables
  required: [
    'POOL_ADDRESS',
    'BITCOIN_RPC_PASSWORD'
  ],
  
  // Optional with defaults
  optional: {
    'POOL_NAME': 'Otedama Mining Pool',
    'BITCOIN_RPC_URL': 'http://localhost:8332',
    'BITCOIN_RPC_USER': 'bitcoinrpc',
    'STRATUM_PORT': '3333',
    'API_PORT': '8080',
    'P2P_PORT': '33333',
    'POOL_FEE': '0.01',
    'PAYMENT_SCHEME': 'PPLNS',
    'MIN_PAYMENT': '0.001'
  },
  
  // Validation rules
  validators: {
    'POOL_ADDRESS': (value) => {
      // Basic Bitcoin address validation (simplified)
      if (!value || value.length < 26 || value.length > 35) {
        return 'Invalid Bitcoin address format';
      }
      return true;
    },
    
    'POOL_FEE': (value) => {
      const fee = parseFloat(value);
      if (isNaN(fee) || fee < 0 || fee > 0.1) {
        return 'Pool fee must be between 0 and 10%';
      }
      return true;
    },
    
    'PAYMENT_SCHEME': (value) => {
      const validSchemes = ['PPLNS', 'PPS', 'PROP', 'SOLO'];
      if (!validSchemes.includes(value)) {
        return `Payment scheme must be one of: ${validSchemes.join(', ')}`;
      }
      return true;
    },
    
    'MIN_PAYMENT': (value) => {
      const amount = parseFloat(value);
      if (isNaN(amount) || amount <= 0) {
        return 'Minimum payment must be greater than 0';
      }
      return true;
    },
    
    'STRATUM_PORT': (value) => {
      const port = parseInt(value);
      if (isNaN(port) || port < 1 || port > 65535) {
        return 'Invalid port number';
      }
      return true;
    }
  }
};

/**
 * Validate configuration
 */
async function validateConfig() {
  const errors = [];
  const warnings = [];
  
  try {
    logger.info('Starting configuration validation...');
    
    // Check required variables
    for (const key of CONFIG_SCHEMA.required) {
      if (!process.env[key]) {
        errors.push(`Missing required environment variable: ${key}`);
      }
    }
    
    // Check optional variables and set defaults
    for (const [key, defaultValue] of Object.entries(CONFIG_SCHEMA.optional)) {
      if (!process.env[key]) {
        process.env[key] = defaultValue;
        warnings.push(`Using default value for ${key}: ${defaultValue}`);
      }
    }
    
    // Run validators
    for (const [key, validator] of Object.entries(CONFIG_SCHEMA.validators)) {
      const value = process.env[key];
      if (value) {
        const result = validator(value);
        if (result !== true) {
          errors.push(`${key}: ${result}`);
        }
      }
    }
    
    // Check config file
    const configPath = path.join(__dirname, '..', 'otedama.config.js');
    try {
      await fs.access(configPath);
      logger.info('Configuration file found: otedama.config.js');
      
      // Try to import and validate
      const { default: config } = await import(configPath);
      
      if (!config.poolAddress && !process.env.POOL_ADDRESS) {
        errors.push('Pool address not configured in either .env or otedama.config.js');
      }
      
    } catch (error) {
      errors.push('Configuration file not found or invalid: otedama.config.js');
    }
    
    // Check directories
    const requiredDirs = ['data', 'logs'];
    for (const dir of requiredDirs) {
      const dirPath = path.join(__dirname, '..', dir);
      try {
        await fs.access(dirPath);
      } catch {
        warnings.push(`Creating required directory: ${dir}`);
        await fs.mkdir(dirPath, { recursive: true });
      }
    }
    
    // Check Bitcoin RPC connectivity
    if (process.env.BITCOIN_RPC_URL && process.env.BITCOIN_RPC_PASSWORD) {
      logger.info('Testing Bitcoin RPC connection...');
      // In production, would actually test the connection
      warnings.push('Bitcoin RPC connection test skipped (would test in production)');
    }
    
    // Display results
    console.log('\n=== Configuration Validation Results ===\n');
    
    if (warnings.length > 0) {
      console.log('⚠️  Warnings:');
      warnings.forEach(w => console.log(`   - ${w}`));
      console.log('');
    }
    
    if (errors.length > 0) {
      console.log('❌ Errors:');
      errors.forEach(e => console.log(`   - ${e}`));
      console.log('');
      console.log('Please fix these errors before starting the pool.');
      process.exit(1);
    } else {
      console.log('✅ Configuration is valid!');
      console.log('');
      console.log('Pool configuration:');
      console.log(`   Name: ${process.env.POOL_NAME}`);
      console.log(`   Address: ${process.env.POOL_ADDRESS}`);
      console.log(`   Fee: ${(parseFloat(process.env.POOL_FEE) * 100).toFixed(2)}%`);
      console.log(`   Payment: ${process.env.PAYMENT_SCHEME}`);
      console.log(`   Min payout: ${process.env.MIN_PAYMENT}`);
      console.log(`   Stratum port: ${process.env.STRATUM_PORT}`);
      console.log(`   API port: ${process.env.API_PORT}`);
      console.log('');
    }
    
  } catch (error) {
    logger.error('Validation error:', error);
    console.error('\n❌ Configuration validation failed:', error.message);
    process.exit(1);
  }
}

// Run validation
validateConfig().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
