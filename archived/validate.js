#!/usr/bin/env node

/**
 * Otedama v6.0.0 - Comprehensive System Validation
 * Ensures commercial-grade quality and readiness
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class SystemValidator {
  constructor() {
    this.errors = [];
    this.warnings = [];
    this.info = [];
  }

  async validate() {
    console.log('🔍 Otedama v6.0.0 - Comprehensive System Validation\n');
    
    // 1. Validate core files
    await this.validateCoreFiles();
    
    // 2. Validate configuration
    await this.validateConfiguration();
    
    // 3. Validate package.json
    await this.validatePackageJson();
    
    // 4. Validate deployment files
    await this.validateDeploymentFiles();
    
    // 5. Validate monitoring setup
    await this.validateMonitoring();
    
    // 6. Validate optimization components
    await this.validateOptimizations();
    
    // 7. Validate security components
    await this.validateSecurity();
    
    // 8. Final report
    this.generateReport();
  }

  async validateCoreFiles() {
    console.log('📋 Validating core files...');
    
    const requiredFiles = [
      'index.js',
      'package.json',
      'otedama.json',
      'README.md',
      'LICENSE',
      'Dockerfile',
      'docker-compose.yml',
      'start.bat',
      'start.sh'
    ];

    for (const file of requiredFiles) {
      const filePath = path.join(__dirname, file);
      try {
        await fs.access(filePath);
        this.info.push(`✅ Core file exists: ${file}`);
      } catch (error) {
        this.errors.push(`❌ Missing core file: ${file}`);
      }
    }

    // Check src directory
    const srcFiles = [
      'src/core.js',
      'src/config.js',
      'src/constants.js',
      'src/logger.js',
      'src/fee-manager.js'
    ];

    for (const file of srcFiles) {
      const filePath = path.join(__dirname, file);
      try {
        await fs.access(filePath);
        this.info.push(`✅ Source file exists: ${file}`);
      } catch (error) {
        this.warnings.push(`⚠️  Missing source file: ${file}`);
      }
    }
  }

  async validateConfiguration() {
    console.log('⚙️ Validating configuration...');
    
    try {
      const configPath = path.join(__dirname, 'otedama.json');
      const configContent = await fs.readFile(configPath, 'utf8');
      const config = JSON.parse(configContent);

      // Validate operator fee settings
      if (config.operatorFees?.address !== 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh') {
        this.errors.push('❌ Invalid operator BTC address in config');
      } else {
        this.info.push('✅ Operator BTC address correctly configured');
      }

      if (config.operatorFees?.rate !== 0.001) {
        this.errors.push('❌ Invalid operator fee rate in config');
      } else {
        this.info.push('✅ Operator fee rate correctly set to 0.1%');
      }

      // Validate required sections
      const requiredSections = ['pool', 'mining', 'network', 'dex', 'defi', 'operatorFees'];
      for (const section of requiredSections) {
        if (config[section]) {
          this.info.push(`✅ Config section present: ${section}`);
        } else {
          this.errors.push(`❌ Missing config section: ${section}`);
        }
      }

    } catch (error) {
      this.errors.push('❌ Failed to validate configuration: ' + error.message);
    }
  }

  async validatePackageJson() {
    console.log('📦 Validating package.json...');
    
    try {
      const packagePath = path.join(__dirname, 'package.json');
      const packageContent = await fs.readFile(packagePath, 'utf8');
      const pkg = JSON.parse(packageContent);

      // Validate basic fields
      if (pkg.name === 'otedama') {
        this.info.push('✅ Package name is correct');
      } else {
        this.errors.push('❌ Invalid package name');
      }

      if (pkg.version === '6.0.0') {
        this.info.push('✅ Package version is correct');
      } else {
        this.warnings.push('⚠️  Package version mismatch');
      }

      // Validate dependencies
      const expectedDeps = ['ws', 'better-sqlite3'];
      for (const dep of expectedDeps) {
        if (pkg.dependencies?.[dep]) {
          this.info.push(`✅ Required dependency: ${dep}`);
        } else {
          this.errors.push(`❌ Missing dependency: ${dep}`);
        }
      }

      // Check for excessive dependencies
      const depCount = Object.keys(pkg.dependencies || {}).length;
      if (depCount <= 5) {
        this.info.push('✅ Minimal dependency count maintained');
      } else {
        this.warnings.push(`⚠️  High dependency count: ${depCount}`);
      }

    } catch (error) {
      this.errors.push('❌ Failed to validate package.json: ' + error.message);
    }
  }

  async validateDeploymentFiles() {
    console.log('🚀 Validating deployment files...');
    
    // Check Docker files
    try {
      const dockerfilePath = path.join(__dirname, 'Dockerfile');
      const dockerfileContent = await fs.readFile(dockerfilePath, 'utf8');
      
      if (dockerfileContent.includes('node:18-alpine')) {
        this.info.push('✅ Dockerfile uses correct Node.js version');
      } else {
        this.warnings.push('⚠️  Dockerfile may not use optimal Node.js version');
      }

      if (dockerfileContent.includes('HEALTHCHECK')) {
        this.info.push('✅ Dockerfile includes health check');
      } else {
        this.warnings.push('⚠️  Dockerfile missing health check');
      }

    } catch (error) {
      this.warnings.push('⚠️  Failed to validate Dockerfile');
    }

    // Check start scripts
    const scripts = ['start.bat', 'start.sh'];
    for (const script of scripts) {
      try {
        const scriptPath = path.join(__dirname, script);
        const scriptContent = await fs.readFile(scriptPath, 'utf8');
        
        if (scriptContent.includes('node index.js')) {
          this.info.push(`✅ ${script} correctly starts application`);
        } else {
          this.warnings.push(`⚠️  ${script} may not start application correctly`);
        }
      } catch (error) {
        this.warnings.push(`⚠️  Failed to validate ${script}`);
      }
    }
  }

  async validateMonitoring() {
    console.log('📊 Validating monitoring setup...');
    
    const monitoringFiles = [
      'monitoring/prometheus.yml',
      'monitoring/alerts.yml',
      'monitoring/grafana/dashboard.json'
    ];

    for (const file of monitoringFiles) {
      try {
        const filePath = path.join(__dirname, file);
        await fs.access(filePath);
        this.info.push(`✅ Monitoring file exists: ${file}`);
      } catch (error) {
        this.warnings.push(`⚠️  Missing monitoring file: ${file}`);
      }
    }

    // Validate Prometheus config
    try {
      const prometheusPath = path.join(__dirname, 'monitoring/prometheus.yml');
      const prometheusContent = await fs.readFile(prometheusPath, 'utf8');
      
      if (prometheusContent.includes('otedama')) {
        this.info.push('✅ Prometheus config includes Otedama targets');
      } else {
        this.warnings.push('⚠️  Prometheus config may be incomplete');
      }
    } catch (error) {
      // File doesn't exist, already reported above
    }
  }

  async validateOptimizations() {
    console.log('⚡ Validating performance optimizations...');
    
    const optimizationFiles = [
      'src/database-batcher.js',
      'src/network-optimizer.js',
      'src/cache-manager.js',
      'src/performance-optimizer.js',
      'src/buffer-pool.js'
    ];
    
    for (const file of optimizationFiles) {
      const filePath = path.join(__dirname, file);
      try {
        await fs.access(filePath);
        this.info.push(`✅ Optimization component exists: ${file}`);
      } catch (error) {
        this.errors.push(`❌ Missing optimization component: ${file}`);
      }
    }
    
    // Check test files
    try {
      await fs.access(path.join(__dirname, 'test/unit/test-performance-optimization.js'));
      this.info.push('✅ Performance optimization tests present');
    } catch (error) {
      this.warnings.push('⚠️  Missing performance optimization tests');
    }
    
    // Check benchmark script
    try {
      await fs.access(path.join(__dirname, 'scripts/performance-benchmark.js'));
      this.info.push('✅ Performance benchmark script present');
    } catch (error) {
      this.warnings.push('⚠️  Missing performance benchmark script');
    }
  }
  
  async validateSecurity() {
    console.log('🔒 Validating security components...');
    
    const securityFiles = [
      'src/ddos-protection.js',
      'src/rate-limiter.js',
      'src/authentication.js',
      'src/security-manager.js'
    ];
    
    for (const file of securityFiles) {
      const filePath = path.join(__dirname, file);
      try {
        await fs.access(filePath);
        this.info.push(`✅ Security component exists: ${file}`);
      } catch (error) {
        this.errors.push(`❌ Missing security component: ${file}`);
      }
    }
    
    // Check security test files
    try {
      await fs.access(path.join(__dirname, 'test/unit/test-security.js'));
      this.info.push('✅ Security tests present');
    } catch (error) {
      this.warnings.push('⚠️  Missing security tests');
    }
    
    // Validate authentication configuration
    try {
      const configPath = path.join(__dirname, 'otedama.json');
      const configContent = await fs.readFile(configPath, 'utf8');
      const config = JSON.parse(configContent);
      
      if (config.auth) {
        this.info.push('✅ Authentication configuration present');
      } else {
        this.warnings.push('⚠️  Missing authentication configuration');
      }
    } catch (error) {
      // Config validation already handled elsewhere
    }
  }

  generateReport() {
    console.log('\n📋 VALIDATION REPORT');
    console.log('=' .repeat(60));
    
    console.log(`\n✅ Successful validations: ${this.info.length}`);
    if (this.info.length > 0) {
      this.info.forEach(item => console.log(`  ${item}`));
    }
    
    console.log(`\n⚠️  Warnings: ${this.warnings.length}`);
    if (this.warnings.length > 0) {
      this.warnings.forEach(item => console.log(`  ${item}`));
    }
    
    console.log(`\n❌ Errors: ${this.errors.length}`);
    if (this.errors.length > 0) {
      this.errors.forEach(item => console.log(`  ${item}`));
    }
    
    console.log('\n' + '=' .repeat(60));
    
    if (this.errors.length === 0) {
      console.log('🎉 VALIDATION PASSED - System ready for commercial deployment!');
      console.log('\n🚀 Quick Start:');
      console.log('   Windows: start.bat');
      console.log('   Linux:   ./start.sh');
      console.log('   Docker:  docker-compose up -d');
      console.log('\n💰 Operator fee system: ACTIVE and IMMUTABLE');
      console.log('🔒 BTC Address: bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh');
      console.log('📊 Fee Rate: 0.1% (automatically collected every 5 minutes)');
      console.log('\n✨ NEW FEATURES:');
      console.log('   ⚡ Performance: Database batching, network optimization, advanced caching');
      console.log('   🔒 Security: DDoS protection, authentication, rate limiting');
      console.log('   📊 Monitoring: Real-time metrics and alerts');
      console.log('\n📊 Run benchmarks: npm run benchmark');
      console.log('🧪 Run tests: npm test');
    } else {
      console.log('❌ VALIDATION FAILED - Please fix errors before deployment');
      process.exit(1);
    }
  }
}

// Run validation
const validator = new SystemValidator();
validator.validate().catch(console.error);
