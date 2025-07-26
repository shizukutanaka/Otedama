#!/usr/bin/env node
/**
 * Otedama Universal Start Script
 * Cross-platform launcher with automatic mode detection
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Console colors
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

async function checkConfig() {
  try {
    await fs.access(path.join(__dirname, 'otedama.config.js'));
    return true;
  } catch {
    return false;
  }
}

async function checkDependencies() {
  try {
    await fs.access(path.join(__dirname, 'node_modules'));
    return true;
  } catch {
    return false;
  }
}

async function detectMode() {
  // Check command line arguments
  const args = process.argv.slice(2);
  
  if (args.includes('--ultra') || args.includes('-u')) {
    return 'ultra';
  }
  
  if (args.includes('--enterprise') || args.includes('-e')) {
    return 'enterprise';
  }
  
  if (args.includes('--dev') || args.includes('-d')) {
    return 'development';
  }
  
  // Auto-detect based on system resources
  const cpus = os.cpus().length;
  const totalMemory = os.totalmem();
  const memoryGB = totalMemory / (1024 * 1024 * 1024);
  
  if (cpus >= 16 && memoryGB >= 32) {
    log('🚀 High-performance system detected. Using Ultra mode.', 'cyan');
    return 'ultra';
  } else if (cpus >= 8 && memoryGB >= 16) {
    log('💼 Enterprise system detected. Using Enterprise mode.', 'cyan');
    return 'enterprise';
  } else {
    return 'standard';
  }
}

async function start() {
  log('🎌 Otedama Mining Pool Launcher', 'bright');
  log('Version 1.1.1 - Enterprise Edition\n', 'cyan');
  
  // Check if setup has been run
  const hasConfig = await checkConfig();
  const hasDeps = await checkDependencies();
  
  if (!hasConfig || !hasDeps) {
    log('⚠️  Setup required!', 'yellow');
    log('Please run one of the following:', 'yellow');
    log('  Windows: setup.cmd', 'cyan');
    log('  Linux/macOS: ./setup.sh', 'cyan');
    log('  All platforms: node setup.js', 'cyan');
    process.exit(1);
  }
  
  // Detect mode
  const mode = await detectMode();
  
  // Prepare environment
  const env = { ...process.env };
  
  if (mode === 'ultra') {
    log('⚡ Starting in ULTRA PERFORMANCE mode', 'green');
    env.NODE_ENV = 'production';
    env.UV_THREADPOOL_SIZE = '128';
    env.NODE_OPTIONS = '--max-old-space-size=8192';
  } else if (mode === 'enterprise') {
    log('🏢 Starting in ENTERPRISE mode', 'green');
    env.NODE_ENV = 'production';
    env.UV_THREADPOOL_SIZE = '64';
    env.NODE_OPTIONS = '--max-old-space-size=4096';
  } else if (mode === 'development') {
    log('🔧 Starting in DEVELOPMENT mode', 'yellow');
    env.NODE_ENV = 'development';
    env.DEBUG = 'otedama:*';
  } else {
    log('✅ Starting in STANDARD mode', 'green');
    env.NODE_ENV = 'production';
  }
  
  // Select entry point
  const entryPoint = mode === 'ultra' ? 'index-ultra.js' : 'index.js';
  
  // Display startup info
  log('\n📊 System Information:', 'cyan');
  log(`   Platform: ${os.platform()} ${os.arch()}`);
  log(`   CPUs: ${os.cpus().length} cores`);
  log(`   Memory: ${(os.totalmem() / (1024 * 1024 * 1024)).toFixed(1)}GB`);
  log(`   Node.js: ${process.version}`);
  
  log('\n🔗 Service Endpoints:', 'cyan');
  log('   Stratum: stratum+tcp://localhost:3333');
  log('   API: http://localhost:8081');
  log('   Dashboard: http://localhost:8082');
  
  log('\n' + '='.repeat(50), 'bright');
  log('Starting Otedama services...\n', 'green');
  
  // Start the application
  const child = spawn('node', [entryPoint, ...process.argv.slice(2)], {
    env,
    stdio: 'inherit'
  });
  
  // Handle shutdown
  process.on('SIGINT', () => {
    log('\n\n🛑 Shutting down Otedama...', 'yellow');
    child.kill('SIGINT');
  });
  
  process.on('SIGTERM', () => {
    child.kill('SIGTERM');
  });
  
  child.on('exit', (code) => {
    if (code !== 0) {
      log(`\n❌ Otedama exited with code ${code}`, 'red');
    } else {
      log('\n✅ Otedama stopped successfully', 'green');
    }
    process.exit(code);
  });
}

// Run
start().catch(error => {
  log(`\n❌ Failed to start: ${error.message}`, 'red');
  process.exit(1);
});