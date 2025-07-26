#!/usr/bin/env node
/**
 * Comprehensive Health Check - Otedama
 * Validates all system components and dependencies
 */

import { createStructuredLogger } from '../lib/core/structured-logger.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const logger = createStructuredLogger('HealthCheck');

class HealthChecker {
  constructor() {
    this.checks = [];
    this.results = {
      passed: 0,
      failed: 0,
      warnings: 0,
      details: []
    };
  }

  async runAllChecks() {
    console.log('🏥 Running comprehensive health check...\n');
    
    await this.checkProjectStructure();
    await this.checkDependencies();
    await this.checkConfigurations();
    await this.checkDatabase();
    await this.checkSecurity();
    await this.checkPerformance();
    
    this.printResults();
    return this.results.failed === 0;
  }

  async checkProjectStructure() {
    console.log('📁 Checking project structure...');
    
    const requiredDirs = [
      'lib/core',
      'lib/mining',
      'lib/network',
      'lib/security',
      'lib/monitoring',
      'config',
      'scripts'
    ];

    for (const dir of requiredDirs) {
      try {
        const dirPath = path.join(projectRoot, dir);
        await fs.access(dirPath);
        this.pass(`Directory exists: ${dir}`);
      } catch (error) {
        this.fail(`Missing directory: ${dir}`);
      }
    }

    const requiredFiles = [
      'package.json',
      'index.js',
      'start-mining-pool.js',
      'README.md'
    ];

    for (const file of requiredFiles) {
      try {
        const filePath = path.join(projectRoot, file);
        await fs.access(filePath);
        this.pass(`File exists: ${file}`);
      } catch (error) {
        this.fail(`Missing file: ${file}`);
      }
    }
  }

  async checkDependencies() {
    console.log('📦 Checking dependencies...');
    
    try {
      const packagePath = path.join(projectRoot, 'package.json');
      const packageContent = await fs.readFile(packagePath, 'utf8');
      const packageJson = JSON.parse(packageContent);
      
      const requiredDeps = [
        'express',
        'ws',
        'better-sqlite3',
        'winston',
        'prom-client'
      ];

      for (const dep of requiredDeps) {
        if (packageJson.dependencies[dep]) {
          this.pass(`Dependency found: ${dep}`);
        } else {
          this.fail(`Missing dependency: ${dep}`);
        }
      }

      this.pass('package.json is valid JSON');
    } catch (error) {
      this.fail(`Package.json error: ${error.message}`);
    }
  }

  async checkConfigurations() {
    console.log('⚙️  Checking configurations...');
    
    const configFiles = [
      'config/production.json',
      'config/default.json'
    ];

    for (const configFile of configFiles) {
      try {
        const configPath = path.join(projectRoot, configFile);
        const configContent = await fs.readFile(configPath, 'utf8');
        JSON.parse(configContent);
        this.pass(`Config valid: ${configFile}`);
      } catch (error) {
        if (error.code === 'ENOENT') {
          this.warn(`Config missing: ${configFile}`);
        } else {
          this.fail(`Config invalid: ${configFile} - ${error.message}`);
        }
      }
    }
  }

  async checkDatabase() {
    console.log('🗄️  Checking database...');
    
    try {
      const dbPath = path.join(projectRoot, 'data/otedama.db');
      await fs.access(dbPath);
      this.pass('Database file exists');
      
      const stats = await fs.stat(dbPath);
      if (stats.size > 0) {
        this.pass('Database has content');
      } else {
        this.warn('Database is empty');
      }
    } catch (error) {
      this.warn('Database file not found (will be created on startup)');
    }
  }

  async checkSecurity() {
    console.log('🔒 Checking security components...');
    
    const securityFiles = [
      'lib/security/crypto-utils.js',
      'lib/security/unified-security-system.js',
      'lib/zkp/enhanced-zkp-system.js'
    ];

    for (const file of securityFiles) {
      try {
        const filePath = path.join(projectRoot, file);
        await fs.access(filePath);
        this.pass(`Security component: ${file}`);
      } catch (error) {
        this.fail(`Missing security component: ${file}`);
      }
    }
  }

  async checkPerformance() {
    console.log('⚡ Checking performance components...');
    
    const perfFiles = [
      'lib/core/optimized-object-pool.js',
      'lib/optimization/performance-optimizer.js',
      'lib/mining/algorithms/native-worker.js'
    ];

    for (const file of perfFiles) {
      try {
        const filePath = path.join(projectRoot, file);
        await fs.access(filePath);
        this.pass(`Performance component: ${file}`);
      } catch (error) {
        this.fail(`Missing performance component: ${file}`);
      }
    }
  }

  pass(message) {
    this.results.passed++;
    this.results.details.push({ status: 'PASS', message });
    console.log(`  ✅ ${message}`);
  }

  fail(message) {
    this.results.failed++;
    this.results.details.push({ status: 'FAIL', message });
    console.log(`  ❌ ${message}`);
  }

  warn(message) {
    this.results.warnings++;
    this.results.details.push({ status: 'WARN', message });
    console.log(`  ⚠️  ${message}`);
  }

  printResults() {
    console.log('\n📊 Health Check Results:');
    console.log(`  ✅ Passed: ${this.results.passed}`);
    console.log(`  ❌ Failed: ${this.results.failed}`);
    console.log(`  ⚠️  Warnings: ${this.results.warnings}`);
    
    const total = this.results.passed + this.results.failed + this.results.warnings;
    const successRate = ((this.results.passed / total) * 100).toFixed(1);
    
    console.log(`  📈 Success Rate: ${successRate}%`);
    
    if (this.results.failed === 0) {
      console.log('\n🎉 All critical checks passed! System is healthy.');
    } else {
      console.log(`\n⚠️  ${this.results.failed} critical issues found. Please address them before production.`);
    }
  }
}

// Run health check if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const checker = new HealthChecker();
  checker.runAllChecks().then(success => {
    process.exit(success ? 0 : 1);
  }).catch(error => {
    console.error('Health check failed:', error);
    process.exit(1);
  });
}

export default HealthChecker;