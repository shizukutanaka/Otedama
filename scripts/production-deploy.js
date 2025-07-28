#!/usr/bin/env node

import { program } from 'commander';
import { logger } from '../lib/core/logger.js';
import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

/**
 * Production Deployment Script for Otedama
 * Handles security checks, setup, and deployment
 */

program
  .name('production-deploy')
  .description('Deploy Otedama to production with security checks')
  .version('1.0.0')
  .option('-e, --env <environment>', 'Deployment environment', 'production')
  .option('-c, --check-only', 'Only run security checks without deploying')
  .option('-s, --skip-tests', 'Skip test execution (not recommended)')
  .option('-f, --force', 'Force deployment even with warnings');

const securityChecks = {
  secrets: {
    name: 'Secret Configuration',
    critical: true,
    check: async () => {
      const envPath = '.env.production';
      try {
        const envContent = await fs.readFile(envPath, 'utf-8');
        const issues = [];
        
        // Check for default secrets
        const defaultSecrets = [
          'CHANGE_THIS',
          'change-in-production',
          'otedama-jwt-secret',
          'otedama-session-secret'
        ];
        
        for (const defaultSecret of defaultSecrets) {
          if (envContent.includes(defaultSecret)) {
            issues.push(`Default secret found: ${defaultSecret}`);
          }
        }
        
        // Check for empty values
        const requiredVars = [
          'JWT_SECRET',
          'SESSION_SECRET',
          'CSRF_SECRET',
          'ENCRYPTION_KEY'
        ];
        
        for (const varName of requiredVars) {
          const regex = new RegExp(`^${varName}=\\s*$`, 'm');
          if (regex.test(envContent)) {
            issues.push(`Empty value for ${varName}`);
          }
        }
        
        return {
          passed: issues.length === 0,
          issues
        };
      } catch (error) {
        return {
          passed: false,
          issues: [`Could not read ${envPath}: ${error.message}`]
        };
      }
    }
  },
  
  cors: {
    name: 'CORS Configuration',
    critical: true,
    check: async () => {
      const configPath = 'config/security.json';
      try {
        const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
        const issues = [];
        
        if (config.security.cors.origins.includes('*')) {
          issues.push('CORS allows all origins (*)');
        }
        
        if (config.security.cors.origins.includes('http://localhost')) {
          issues.push('CORS includes localhost origins');
        }
        
        return {
          passed: issues.length === 0,
          issues
        };
      } catch (error) {
        return {
          passed: false,
          issues: [`Could not read security config: ${error.message}`]
        };
      }
    }
  },
  
  ssl: {
    name: 'SSL/TLS Configuration',
    critical: false,
    check: async () => {
      const issues = [];
      
      try {
        const envContent = await fs.readFile('.env.production', 'utf-8');
        
        if (!envContent.includes('SSL_CERT_PATH=') || !envContent.includes('SSL_KEY_PATH=')) {
          issues.push('SSL certificate paths not configured');
        }
        
        // Check if HTTPS is enforced
        const securityConfig = JSON.parse(await fs.readFile('config/security.json', 'utf-8'));
        if (!securityConfig.security.headers.hsts.enabled) {
          issues.push('HSTS not enabled');
        }
        
      } catch (error) {
        issues.push(`Configuration check failed: ${error.message}`);
      }
      
      return {
        passed: issues.length === 0,
        issues
      };
    }
  },
  
  database: {
    name: 'Database Security',
    critical: true,
    check: async () => {
      const issues = [];
      
      try {
        // Check if database is initialized
        const dbSetupPath = 'data/.database-setup.json';
        try {
          await fs.access(dbSetupPath);
        } catch {
          issues.push('Database not initialized - run npm run db:setup');
        }
        
        // Check Redis password
        const envContent = await fs.readFile('.env.production', 'utf-8');
        if (envContent.includes('REDIS_PASSWORD=\n') || envContent.includes('REDIS_PASSWORD=$')) {
          issues.push('Redis password not set');
        }
        
      } catch (error) {
        issues.push(`Database check failed: ${error.message}`);
      }
      
      return {
        passed: issues.length === 0,
        issues
      };
    }
  },
  
  dependencies: {
    name: 'Dependency Vulnerabilities',
    critical: false,
    check: async () => {
      const issues = [];
      
      try {
        logger.info('Running npm audit...');
        const auditResult = execSync('npm audit --json', { encoding: 'utf-8' });
        const audit = JSON.parse(auditResult);
        
        if (audit.metadata.vulnerabilities.high > 0) {
          issues.push(`${audit.metadata.vulnerabilities.high} high severity vulnerabilities`);
        }
        
        if (audit.metadata.vulnerabilities.critical > 0) {
          issues.push(`${audit.metadata.vulnerabilities.critical} critical vulnerabilities`);
        }
        
      } catch (error) {
        // npm audit returns non-zero exit code if vulnerabilities found
        try {
          const audit = JSON.parse(error.stdout);
          if (audit.metadata.vulnerabilities.critical > 0) {
            issues.push(`${audit.metadata.vulnerabilities.critical} critical vulnerabilities`);
          }
          if (audit.metadata.vulnerabilities.high > 0) {
            issues.push(`${audit.metadata.vulnerabilities.high} high severity vulnerabilities`);
          }
        } catch {
          issues.push('Could not run npm audit');
        }
      }
      
      return {
        passed: issues.length === 0,
        issues
      };
    }
  },
  
  permissions: {
    name: 'File Permissions',
    critical: false,
    check: async () => {
      const issues = [];
      
      const sensitiveFiles = [
        '.env.production',
        'config/production.json',
        'data/otedama.db'
      ];
      
      for (const file of sensitiveFiles) {
        try {
          const stats = await fs.stat(file);
          const mode = (stats.mode & parseInt('777', 8)).toString(8);
          
          if (mode !== '600' && mode !== '400') {
            issues.push(`${file} has loose permissions: ${mode}`);
          }
        } catch {
          // File doesn't exist yet, that's ok
        }
      }
      
      return {
        passed: issues.length === 0,
        issues
      };
    }
  }
};

async function runSecurityChecks() {
  logger.info('🔒 Running security checks...\n');
  
  const results = {
    passed: 0,
    warnings: 0,
    critical: 0,
    details: []
  };
  
  for (const [key, check] of Object.entries(securityChecks)) {
    logger.info(`Checking ${check.name}...`);
    
    const result = await check.check();
    results.details.push({
      name: check.name,
      critical: check.critical,
      ...result
    });
    
    if (result.passed) {
      logger.info(`✅ ${check.name}: PASSED`);
      results.passed++;
    } else {
      if (check.critical) {
        logger.error(`❌ ${check.name}: FAILED (CRITICAL)`);
        result.issues.forEach(issue => logger.error(`   - ${issue}`));
        results.critical++;
      } else {
        logger.warn(`⚠️  ${check.name}: WARNING`);
        result.issues.forEach(issue => logger.warn(`   - ${issue}`));
        results.warnings++;
      }
    }
    
    console.log('');
  }
  
  return results;
}

async function runTests() {
  logger.info('🧪 Running tests...\n');
  
  try {
    execSync('npm test', { stdio: 'inherit' });
    logger.info('✅ All tests passed\n');
    return true;
  } catch (error) {
    logger.error('❌ Tests failed\n');
    return false;
  }
}

async function generateSecrets() {
  logger.info('🔑 Generating secure secrets...\n');
  
  const secrets = {
    JWT_SECRET: crypto.randomBytes(64).toString('base64'),
    SESSION_SECRET: crypto.randomBytes(64).toString('base64'),
    CSRF_SECRET: crypto.randomBytes(64).toString('base64'),
    ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    REDIS_PASSWORD: crypto.randomBytes(32).toString('base64')
  };
  
  logger.info('Generated secrets (save these securely):');
  Object.entries(secrets).forEach(([key, value]) => {
    logger.info(`${key}=${value}`);
  });
  
  return secrets;
}

async function setupProduction() {
  logger.info('🚀 Setting up production environment...\n');
  
  // Create required directories
  const dirs = ['data', 'logs', 'backups', 'reports'];
  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
  }
  
  // Set up database
  logger.info('Setting up database...');
  execSync('npm run db:setup', { stdio: 'inherit' });
  
  // Build assets if needed
  logger.info('Building production assets...');
  // Add build commands here if needed
  
  logger.info('✅ Production setup complete\n');
}

async function deploymentChecklist() {
  const checklist = [
    '1. Update .env.production with generated secrets',
    '2. Configure SSL certificates',
    '3. Update CORS origins in config/security.json',
    '4. Set up Redis with authentication',
    '5. Configure firewall rules',
    '6. Set up monitoring (Sentry, New Relic, etc.)',
    '7. Configure backup schedule',
    '8. Set up log rotation',
    '9. Configure reverse proxy (nginx/Apache)',
    '10. Enable rate limiting at infrastructure level',
    '11. Set up DDoS protection',
    '12. Configure alerting',
    '13. Document emergency procedures',
    '14. Set up staging environment for testing',
    '15. Configure CI/CD pipeline'
  ];
  
  logger.info('📋 Deployment Checklist:\n');
  checklist.forEach(item => logger.info(item));
}

async function main() {
  try {
    program.parse();
    const options = program.opts();
    
    logger.info('🎯 Otedama Production Deployment\n');
    
    // Run security checks
    const securityResults = await runSecurityChecks();
    
    logger.info('📊 Security Check Summary:');
    logger.info(`   Passed: ${securityResults.passed}`);
    logger.info(`   Warnings: ${securityResults.warnings}`);
    logger.info(`   Critical: ${securityResults.critical}\n`);
    
    if (securityResults.critical > 0 && !options.force) {
      logger.error('❌ Critical security issues found. Fix these before deploying.');
      logger.error('   Use --force to deploy anyway (NOT RECOMMENDED)\n');
      
      if (options.checkOnly) {
        process.exit(1);
      }
      
      // Generate secrets to help fix issues
      logger.info('💡 Here are secure secrets you can use:\n');
      await generateSecrets();
      
      process.exit(1);
    }
    
    if (options.checkOnly) {
      logger.info('✅ Security checks completed (check-only mode)');
      process.exit(securityResults.critical > 0 ? 1 : 0);
    }
    
    // Run tests unless skipped
    if (!options.skipTests) {
      const testsPass = await runTests();
      if (!testsPass && !options.force) {
        logger.error('❌ Tests failed. Fix tests before deploying.');
        process.exit(1);
      }
    }
    
    // Setup production environment
    await setupProduction();
    
    // Show deployment checklist
    await deploymentChecklist();
    
    logger.info('\n✅ Deployment preparation complete!');
    logger.info('   Review the checklist above and complete all items.');
    logger.info('   Then start the application with: npm run start:production');
    
  } catch (error) {
    logger.error('❌ Deployment failed:', error);
    process.exit(1);
  }
}

// Run deployment
main();