#!/usr/bin/env node
/**
 * Otedama Project Validator
 * Validates project structure, dependencies, and configuration
 * 
 * Usage: node scripts/validate-project.js
 */

import { createLogger } from '../lib/core/logger.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

const logger = createLogger('ProjectValidator');

/**
 * Required directories
 */
const REQUIRED_DIRECTORIES = [
  'lib/core',
  'lib/network',
  'lib/storage',
  'lib/mining',
  'lib/dex',
  'lib/security',
  'lib/monitoring',
  'lib/api',
  'lib/utils',
  'lib/automation',
  'config',
  'scripts',
  'test',
  'public',
  'deploy'
];

/**
 * Required core files
 */
const REQUIRED_FILES = [
  'index.js',
  'package.json',
  'README.md',
  'LICENSE',
  '.env.example',
  'otedama.config.example.js',
  'start-mining-pool.js',
  'otedama-miner.js',
  'lib/core/logger.js',
  'lib/core/errors.js',
  'lib/core/memory-manager.js',
  'lib/core/validator.js',
  'lib/core/config-manager.js',
  'lib/mining/pool-manager.js',
  'lib/mining/enhanced-p2p-mining-pool.js',
  'lib/mining/enhanced-payment-processor.js',
  'lib/mining/enhanced-asic-controller.js',
  'lib/storage/index.js',
  'lib/monitoring/index.js',
  'lib/api/index.js'
];

/**
 * Validate project structure
 */
async function validateStructure() {
  console.log(chalk.blue('\n📁 Validating project structure...\n'));
  
  let valid = true;
  
  // Check directories
  for (const dir of REQUIRED_DIRECTORIES) {
    const dirPath = path.join(projectRoot, dir);
    try {
      await fs.access(dirPath);
      console.log(chalk.green(`✓ ${dir}`));
    } catch {
      console.log(chalk.red(`✗ ${dir} - Missing`));
      valid = false;
    }
  }
  
  console.log(chalk.blue('\n📄 Validating required files...\n'));
  
  // Check files
  for (const file of REQUIRED_FILES) {
    const filePath = path.join(projectRoot, file);
    try {
      await fs.access(filePath);
      console.log(chalk.green(`✓ ${file}`));
    } catch {
      console.log(chalk.red(`✗ ${file} - Missing`));
      valid = false;
    }
  }
  
  return valid;
}

/**
 * Validate dependencies
 */
async function validateDependencies() {
  console.log(chalk.blue('\n📦 Validating dependencies...\n'));
  
  const packageJsonPath = path.join(projectRoot, 'package.json');
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  
  const requiredDeps = [
    'express',
    'ws',
    'better-sqlite3',
    'winston',
    'dotenv',
    'bitcoinjs-lib',
    'axios',
    'jsonwebtoken'
  ];
  
  let valid = true;
  
  for (const dep of requiredDeps) {
    if (packageJson.dependencies[dep]) {
      console.log(chalk.green(`✓ ${dep}`));
    } else {
      console.log(chalk.red(`✗ ${dep} - Missing`));
      valid = false;
    }
  }
  
  return valid;
}

/**
 * Validate configuration
 */
async function validateConfiguration() {
  console.log(chalk.blue('\n⚙️  Validating configuration...\n'));
  
  let valid = true;
  
  // Check .env.example
  try {
    const envExample = await fs.readFile(path.join(projectRoot, '.env.example'), 'utf8');
    const requiredEnvVars = [
      'POOL_NAME',
      'POOL_ADDRESS',
      'BITCOIN_RPC_URL',
      'BITCOIN_RPC_USER',
      'BITCOIN_RPC_PASSWORD'
    ];
    
    for (const envVar of requiredEnvVars) {
      if (envExample.includes(envVar)) {
        console.log(chalk.green(`✓ ${envVar} in .env.example`));
      } else {
        console.log(chalk.red(`✗ ${envVar} missing from .env.example`));
        valid = false;
      }
    }
  } catch (error) {
    console.log(chalk.red('✗ Could not read .env.example'));
    valid = false;
  }
  
  // Check otedama.config.example.js
  try {
    await import(path.join(projectRoot, 'otedama.config.example.js'));
    console.log(chalk.green('✓ otedama.config.example.js is valid'));
  } catch (error) {
    console.log(chalk.red('✗ otedama.config.example.js has errors'));
    valid = false;
  }
  
  return valid;
}

/**
 * Check for duplicate files
 */
async function checkDuplicates() {
  console.log(chalk.blue('\n🔍 Checking for duplicate files...\n'));
  
  const duplicatePatterns = [
    '**/payment-processor*.js',
    '**/p2p-mining-pool*.js',
    '**/asic-controller*.js',
    '**/*-national.*',
    '**/*-enhanced.*'
  ];
  
  // Simple check for common duplicate patterns
  const libDir = path.join(projectRoot, 'lib');
  const files = await getAllFiles(libDir);
  
  const fileBasenames = {};
  let duplicatesFound = false;
  
  for (const file of files) {
    const basename = path.basename(file, path.extname(file));
    if (!fileBasenames[basename]) {
      fileBasenames[basename] = [];
    }
    fileBasenames[basename].push(file);
  }
  
  for (const [basename, paths] of Object.entries(fileBasenames)) {
    if (paths.length > 1) {
      console.log(chalk.yellow(`⚠️  Potential duplicates for "${basename}":`));
      paths.forEach(p => console.log(chalk.yellow(`   - ${path.relative(projectRoot, p)}`)));
      duplicatesFound = true;
    }
  }
  
  if (!duplicatesFound) {
    console.log(chalk.green('✓ No duplicate files found'));
  }
  
  return !duplicatesFound;
}

/**
 * Get all files recursively
 */
async function getAllFiles(dir) {
  const files = [];
  
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        files.push(...await getAllFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        files.push(fullPath);
      }
    }
  } catch (error) {
    // Ignore errors
  }
  
  return files;
}

/**
 * Run module imports test
 */
async function testModuleImports() {
  console.log(chalk.blue('\n🧪 Testing module imports...\n'));
  
  const modules = [
    { name: 'Core', path: '../lib/core/index.js' },
    { name: 'Network', path: '../lib/network/index.js' },
    { name: 'Storage', path: '../lib/storage/index.js' },
    { name: 'Mining', path: '../lib/mining/index.js' },
    { name: 'Security', path: '../lib/security/index.js' },
    { name: 'Monitoring', path: '../lib/monitoring/index.js' },
    { name: 'API', path: '../lib/api/index.js' },
    { name: 'Utils', path: '../lib/utils/index.js' }
  ];
  
  let valid = true;
  
  for (const module of modules) {
    try {
      await import(module.path);
      console.log(chalk.green(`✓ ${module.name} module imports successfully`));
    } catch (error) {
      console.log(chalk.red(`✗ ${module.name} module import failed: ${error.message}`));
      valid = false;
    }
  }
  
  return valid;
}

/**
 * Generate report
 */
async function generateReport(results) {
  console.log(chalk.blue('\n📊 Validation Report\n'));
  console.log('═══════════════════════════════════════════');
  
  let totalChecks = 0;
  let passedChecks = 0;
  
  for (const [check, passed] of Object.entries(results)) {
    totalChecks++;
    if (passed) passedChecks++;
    
    const status = passed ? chalk.green('PASS') : chalk.red('FAIL');
    console.log(`${check}: ${status}`);
  }
  
  console.log('═══════════════════════════════════════════');
  
  const percentage = Math.round((passedChecks / totalChecks) * 100);
  const overallStatus = percentage === 100 ? chalk.green('PASS') : 
                       percentage >= 80 ? chalk.yellow('PARTIAL') : 
                       chalk.red('FAIL');
  
  console.log(`\nOverall: ${overallStatus} (${passedChecks}/${totalChecks} checks passed - ${percentage}%)`);
  
  if (percentage < 100) {
    console.log(chalk.yellow('\n⚠️  Some issues were found. Please fix them before running in production.'));
  } else {
    console.log(chalk.green('\n✅ All checks passed! The project is ready for use.'));
  }
}

/**
 * Main validation
 */
async function main() {
  console.log(chalk.cyan(`
╔═══════════════════════════════════════════╗
║       Otedama Project Validator           ║
╚═══════════════════════════════════════════╝
  `));
  
  const results = {
    'Structure Validation': await validateStructure(),
    'Dependencies Check': await validateDependencies(),
    'Configuration Check': await validateConfiguration(),
    'Duplicate Files Check': await checkDuplicates(),
    'Module Import Test': await testModuleImports()
  };
  
  await generateReport(results);
}

// Run validation
main().catch(error => {
  logger.error('Validation failed:', error);
  process.exit(1);
});
