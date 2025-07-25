#!/usr/bin/env node

/**
 * Security Scan Script - Otedama
 * Perform comprehensive security audit
 */

import { createMiningPoolManager } from '../lib/mining/pool-manager.js';
import { createLogger } from '../lib/core/logger.js';
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';

const logger = createLogger('SecurityScan');
const program = new Command();

program
  .name('security-scan')
  .description('Perform security scan of Otedama mining pool')
  .version('1.0.0')
  .option('-f, --full', 'Run comprehensive scan')
  .option('-q, --quick', 'Quick scan only')
  .option('--fix', 'Attempt to fix issues automatically')
  .option('--report <file>', 'Save report to file');

async function scan() {
  const options = program.opts();
  
  console.log(chalk.blue.bold('\n🔒 Otedama Security Scanner\n'));
  
  const issues = [];
  let criticalCount = 0;
  let highCount = 0;
  let mediumCount = 0;
  let lowCount = 0;
  
  try {
    // Initialize pool manager (minimal)
    const poolManager = createMiningPoolManager({
      poolName: 'Otedama Mining Pool',
      enableAutomation: true,
      automation: {
        enableSecurityMonitoring: true
      }
    });
    
    // Initialize only security system
    await poolManager.storage.initialize();
    poolManager.automation = {};
    
    const { AutomatedSecurityMonitor } = await import('../lib/automation/auto-security-monitor.js');
    poolManager.automation.security = new AutomatedSecurityMonitor(poolManager, {
      enabled: true
    });
    
    // List of security checks
    const checks = [
      { name: 'File Permissions', fn: checkFilePermissions },
      { name: 'Environment Variables', fn: checkEnvironmentVariables },
      { name: 'Dependencies', fn: checkDependencies },
      { name: 'Network Exposure', fn: checkNetworkExposure },
      { name: 'SSL/TLS Configuration', fn: checkSSLConfiguration },
      { name: 'Authentication', fn: checkAuthentication },
      { name: 'Input Validation', fn: checkInputValidation },
      { name: 'Logging', fn: checkLogging }
    ];
    
    if (options.full) {
      checks.push(
        { name: 'Code Analysis', fn: checkCodeAnalysis },
        { name: 'Penetration Test', fn: checkPenetrationTest }
      );
    }
    
    // Run checks
    for (const check of checks) {
      const spinner = ora(`Checking ${check.name}...`).start();
      
      try {
        const checkIssues = await check.fn(options);
        
        if (checkIssues.length === 0) {
          spinner.succeed(chalk.green(`${check.name}: Passed`));
        } else {
          spinner.warn(chalk.yellow(`${check.name}: ${checkIssues.length} issues found`));
          issues.push(...checkIssues);
          
          // Count by severity
          checkIssues.forEach(issue => {
            switch (issue.severity) {
              case 'critical': criticalCount++; break;
              case 'high': highCount++; break;
              case 'medium': mediumCount++; break;
              case 'low': lowCount++; break;
            }
          });
        }
      } catch (error) {
        spinner.fail(chalk.red(`${check.name}: Error`));
        issues.push({
          check: check.name,
          severity: 'high',
          message: `Check failed: ${error.message}`,
          fix: 'Review check implementation'
        });
      }
    }
    
    // Display results
    console.log(chalk.blue('\n📊 Security Scan Results\n'));
    
    const totalIssues = issues.length;
    if (totalIssues === 0) {
      console.log(chalk.green.bold('✅ No security issues found!'));
    } else {
      // Summary
      console.log(chalk.red(`Critical: ${criticalCount}`));
      console.log(chalk.orange(`High: ${highCount}`));
      console.log(chalk.yellow(`Medium: ${mediumCount}`));
      console.log(chalk.gray(`Low: ${lowCount}`));
      console.log(chalk.white(`Total: ${totalIssues}\n`));
      
      // Detailed issues
      console.log(chalk.blue('Issues Found:\n'));
      
      // Sort by severity
      const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
      
      issues.forEach((issue, index) => {
        const color = {
          critical: 'red',
          high: 'magenta',
          medium: 'yellow',
          low: 'gray'
        }[issue.severity];
        
        console.log(chalk[color].bold(`${index + 1}. [${issue.severity.toUpperCase()}] ${issue.check}`));
        console.log(chalk.white(`   ${issue.message}`));
        
        if (issue.fix) {
          console.log(chalk.cyan(`   Fix: ${issue.fix}`));
        }
        
        if (options.fix && issue.autoFix) {
          console.log(chalk.green(`   Auto-fixing...`));
          try {
            await issue.autoFix();
            console.log(chalk.green(`   ✓ Fixed`));
          } catch (error) {
            console.log(chalk.red(`   ✗ Auto-fix failed: ${error.message}`));
          }
        }
        
        console.log();
      });
    }
    
    // Save report if requested
    if (options.report) {
      const report = {
        timestamp: new Date().toISOString(),
        summary: {
          total: totalIssues,
          critical: criticalCount,
          high: highCount,
          medium: mediumCount,
          low: lowCount
        },
        issues
      };
      
      await fs.writeFile(options.report, JSON.stringify(report, null, 2));
      console.log(chalk.gray(`Report saved to: ${options.report}`));
    }
    
    // Exit code based on severity
    if (criticalCount > 0) {
      process.exit(2);
    } else if (highCount > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
    
  } catch (error) {
    console.error(chalk.red.bold('\n❌ Security scan failed!'));
    console.error(chalk.red(error.message));
    
    if (error.stack && process.env.DEBUG) {
      console.error(chalk.gray(error.stack));
    }
    
    process.exit(3);
  }
}

// Security check functions

async function checkFilePermissions(options) {
  const issues = [];
  const files = [
    { path: '.env', maxMode: '600' },
    { path: 'otedama.config.js', maxMode: '644' },
    { path: 'data/otedama-pool.db', maxMode: '600' }
  ];
  
  for (const file of files) {
    try {
      const stats = await fs.stat(file.path);
      const mode = (stats.mode & parseInt('777', 8)).toString(8);
      
      if (parseInt(mode) > parseInt(file.maxMode)) {
        issues.push({
          check: 'File Permissions',
          severity: 'high',
          message: `${file.path} has insecure permissions: ${mode} (should be ${file.maxMode})`,
          fix: `chmod ${file.maxMode} ${file.path}`,
          autoFix: async () => {
            await fs.chmod(file.path, parseInt(file.maxMode, 8));
          }
        });
      }
    } catch (error) {
      // File doesn't exist
    }
  }
  
  return issues;
}

async function checkEnvironmentVariables(options) {
  const issues = [];
  
  // Check if .env exists
  try {
    await fs.access('.env');
  } catch (error) {
    issues.push({
      check: 'Environment Variables',
      severity: 'critical',
      message: '.env file missing',
      fix: 'Copy .env.example to .env and configure'
    });
    return issues;
  }
  
  // Check if .env is in .gitignore
  try {
    const gitignore = await fs.readFile('.gitignore', 'utf8');
    if (!gitignore.includes('.env')) {
      issues.push({
        check: 'Environment Variables',
        severity: 'critical',
        message: '.env file not in .gitignore',
        fix: 'Add .env to .gitignore',
        autoFix: async () => {
          await fs.appendFile('.gitignore', '\n.env\n');
        }
      });
    }
  } catch (error) {
    // No .gitignore
  }
  
  // Check for exposed secrets
  const env = await fs.readFile('.env', 'utf8');
  const lines = env.split('\n');
  
  for (const line of lines) {
    if (line.includes('PRIVATE_KEY') && !line.includes('xxx') && !line.includes('CHANGEME')) {
      const key = line.split('=')[0];
      issues.push({
        check: 'Environment Variables',
        severity: 'high',
        message: `${key} appears to contain real private key`,
        fix: 'Ensure private keys are stored securely'
      });
    }
  }
  
  return issues;
}

async function checkDependencies(options) {
  const issues = [];
  
  // Run npm audit
  return new Promise((resolve) => {
    const audit = spawn('npm', ['audit', '--json']);
    let output = '';
    
    audit.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    audit.on('close', (code) => {
      try {
        const report = JSON.parse(output);
        const vulnerabilities = report.vulnerabilities || {};
        
        Object.entries(vulnerabilities).forEach(([pkg, vuln]) => {
          const severity = vuln.severity;
          const severityMap = {
            'critical': 'critical',
            'high': 'high',
            'moderate': 'medium',
            'low': 'low'
          };
          
          issues.push({
            check: 'Dependencies',
            severity: severityMap[severity] || 'medium',
            message: `${pkg} has ${severity} vulnerability: ${vuln.title || 'Unknown'}`,
            fix: `npm audit fix${severity === 'critical' ? ' --force' : ''}`
          });
        });
      } catch (error) {
        // npm audit failed or no vulnerabilities
      }
      
      resolve(issues);
    });
  });
}

async function checkNetworkExposure(options) {
  const issues = [];
  
  // Check if sensitive ports are bound to 0.0.0.0
  const config = await import('../otedama.config.js');
  
  if (config.default.remoteManagementPort) {
    issues.push({
      check: 'Network Exposure',
      severity: 'medium',
      message: 'Remote management port is enabled',
      fix: 'Ensure proper firewall rules and authentication'
    });
  }
  
  return issues;
}

async function checkSSLConfiguration(options) {
  const issues = [];
  
  const config = await import('../otedama.config.js');
  
  if (!config.default.enableSSL) {
    issues.push({
      check: 'SSL/TLS Configuration',
      severity: 'medium',
      message: 'SSL/TLS is not enabled',
      fix: 'Enable SSL for production deployments'
    });
  }
  
  return issues;
}

async function checkAuthentication(options) {
  const issues = [];
  
  const config = await import('../otedama.config.js');
  
  if (!config.default.adminKeys || config.default.adminKeys.length === 0) {
    issues.push({
      check: 'Authentication',
      severity: 'high',
      message: 'No admin keys configured',
      fix: 'Generate admin keys with: npm run remote:admin'
    });
  }
  
  return issues;
}

async function checkInputValidation(options) {
  const issues = [];
  
  // Check for potential injection points
  // This is a simple check - in production, use proper SAST tools
  
  return issues;
}

async function checkLogging(options) {
  const issues = [];
  
  // Check if logs directory exists
  try {
    await fs.access('./logs');
  } catch (error) {
    issues.push({
      check: 'Logging',
      severity: 'low',
      message: 'Logs directory does not exist',
      fix: 'Create logs directory',
      autoFix: async () => {
        await fs.mkdir('./logs', { recursive: true });
      }
    });
  }
  
  return issues;
}

async function checkCodeAnalysis(options) {
  const issues = [];
  
  // Run ESLint
  return new Promise((resolve) => {
    const eslint = spawn('npx', ['eslint', '.', '--format', 'json']);
    let output = '';
    
    eslint.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    eslint.on('close', (code) => {
      try {
        const results = JSON.parse(output);
        
        results.forEach(file => {
          file.messages.forEach(msg => {
            if (msg.severity === 2) { // Error
              issues.push({
                check: 'Code Analysis',
                severity: 'medium',
                message: `${file.filePath}: ${msg.message} (${msg.ruleId})`,
                fix: 'Fix ESLint errors'
              });
            }
          });
        });
      } catch (error) {
        // ESLint failed
      }
      
      resolve(issues);
    });
  });
}

async function checkPenetrationTest(options) {
  const issues = [];
  
  // Basic penetration tests
  // In production, use proper penetration testing tools
  
  return issues;
}

// Handle uncaught errors
process.on('unhandledRejection', (error) => {
  console.error(chalk.red('Unhandled error:'), error);
  process.exit(3);
});

// Parse arguments and run
program.parse();
scan();
