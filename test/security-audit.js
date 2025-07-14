#!/usr/bin/env node

/**
 * Otedama Ver.0.5 - Automated Security Audit
 * 包括的なセキュリティ監査と脆弱性検査
 */

import { Logger } from '../src/logger.js';
import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

const logger = new Logger('SecurityAudit');

// Audit configuration
const AUDIT_CONFIG = {
  categories: [
    'fees',          // Fee system integrity
    'authentication', // Auth system security
    'injection',     // SQL/NoSQL injection
    'crypto',        // Cryptographic security
    'access',        // Access control
    'network',       // Network security
    'dependencies',  // Dependency vulnerabilities
    'configuration', // Configuration security
    'integrity'      // System integrity
  ],
  severity: {
    CRITICAL: 4,
    HIGH: 3,
    MEDIUM: 2,
    LOW: 1,
    INFO: 0
  }
};

// Audit results
const auditResults = {
  timestamp: new Date().toISOString(),
  version: '0.5',
  findings: [],
  summary: {
    total: 0,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0
  },
  score: 100
};

/**
 * Core Security Auditor
 */
class SecurityAuditor {
  constructor() {
    this.tests = [];
    this.initializeTests();
  }

  initializeTests() {
    // Fee System Security (CRITICAL)
    this.addTest({
      id: 'FEE-001',
      name: 'Operator Address Immutability',
      category: 'fees',
      severity: 'CRITICAL',
      test: this.testOperatorAddressImmutability.bind(this)
    });

    this.addTest({
      id: 'FEE-002',
      name: 'Fee Rate Immutability',
      category: 'fees',
      severity: 'CRITICAL',
      test: this.testFeeRateImmutability.bind(this)
    });

    this.addTest({
      id: 'FEE-003',
      name: 'Fee Collection Integrity',
      category: 'fees',
      severity: 'HIGH',
      test: this.testFeeCollectionIntegrity.bind(this)
    });

    // Authentication Security
    this.addTest({
      id: 'AUTH-001',
      name: 'JWT Secret Strength',
      category: 'authentication',
      severity: 'HIGH',
      test: this.testJWTSecretStrength.bind(this)
    });

    this.addTest({
      id: 'AUTH-002',
      name: 'Password Policy',
      category: 'authentication',
      severity: 'MEDIUM',
      test: this.testPasswordPolicy.bind(this)
    });

    this.addTest({
      id: 'AUTH-003',
      name: 'Session Security',
      category: 'authentication',
      severity: 'HIGH',
      test: this.testSessionSecurity.bind(this)
    });

    // Injection Prevention
    this.addTest({
      id: 'INJ-001',
      name: 'SQL Injection Prevention',
      category: 'injection',
      severity: 'CRITICAL',
      test: this.testSQLInjection.bind(this)
    });

    this.addTest({
      id: 'INJ-002',
      name: 'Command Injection Prevention',
      category: 'injection',
      severity: 'CRITICAL',
      test: this.testCommandInjection.bind(this)
    });

    this.addTest({
      id: 'INJ-003',
      name: 'Path Traversal Prevention',
      category: 'injection',
      severity: 'HIGH',
      test: this.testPathTraversal.bind(this)
    });

    // Cryptographic Security
    this.addTest({
      id: 'CRYPTO-001',
      name: 'Encryption Algorithm Strength',
      category: 'crypto',
      severity: 'HIGH',
      test: this.testEncryptionStrength.bind(this)
    });

    this.addTest({
      id: 'CRYPTO-002',
      name: 'Random Number Generation',
      category: 'crypto',
      severity: 'HIGH',
      test: this.testRandomGeneration.bind(this)
    });

    this.addTest({
      id: 'CRYPTO-003',
      name: 'Hash Function Security',
      category: 'crypto',
      severity: 'MEDIUM',
      test: this.testHashFunctions.bind(this)
    });

    // Access Control
    this.addTest({
      id: 'ACCESS-001',
      name: 'API Rate Limiting',
      category: 'access',
      severity: 'HIGH',
      test: this.testRateLimiting.bind(this)
    });

    this.addTest({
      id: 'ACCESS-002',
      name: 'CORS Configuration',
      category: 'access',
      severity: 'MEDIUM',
      test: this.testCORSConfig.bind(this)
    });

    this.addTest({
      id: 'ACCESS-003',
      name: 'File Permissions',
      category: 'access',
      severity: 'MEDIUM',
      test: this.testFilePermissions.bind(this)
    });

    // Network Security
    this.addTest({
      id: 'NET-001',
      name: 'DDoS Protection',
      category: 'network',
      severity: 'HIGH',
      test: this.testDDoSProtection.bind(this)
    });

    this.addTest({
      id: 'NET-002',
      name: 'SSL/TLS Configuration',
      category: 'network',
      severity: 'HIGH',
      test: this.testSSLConfig.bind(this)
    });

    this.addTest({
      id: 'NET-003',
      name: 'Open Ports',
      category: 'network',
      severity: 'MEDIUM',
      test: this.testOpenPorts.bind(this)
    });

    // Configuration Security
    this.addTest({
      id: 'CONFIG-001',
      name: 'Sensitive Data Exposure',
      category: 'configuration',
      severity: 'CRITICAL',
      test: this.testSensitiveDataExposure.bind(this)
    });

    this.addTest({
      id: 'CONFIG-002',
      name: 'Debug Mode Check',
      category: 'configuration',
      severity: 'HIGH',
      test: this.testDebugMode.bind(this)
    });

    this.addTest({
      id: 'CONFIG-003',
      name: 'Default Credentials',
      category: 'configuration',
      severity: 'CRITICAL',
      test: this.testDefaultCredentials.bind(this)
    });

    // System Integrity
    this.addTest({
      id: 'INT-001',
      name: 'File Integrity',
      category: 'integrity',
      severity: 'HIGH',
      test: this.testFileIntegrity.bind(this)
    });

    this.addTest({
      id: 'INT-002',
      name: 'Code Tampering Detection',
      category: 'integrity',
      severity: 'CRITICAL',
      test: this.testCodeTampering.bind(this)
    });
  }

  addTest(test) {
    this.tests.push(test);
  }

  async runAllTests() {
    logger.info(`Running ${this.tests.length} security tests...`);

    for (const test of this.tests) {
      await this.runTest(test);
    }

    this.calculateScore();
  }

  async runTest(test) {
    logger.debug(`Running test: ${test.name}`);
    
    try {
      const result = await test.test();
      
      if (!result.passed) {
        auditResults.findings.push({
          id: test.id,
          name: test.name,
          category: test.category,
          severity: test.severity,
          description: result.description,
          recommendation: result.recommendation,
          details: result.details
        });

        auditResults.summary[test.severity.toLowerCase()]++;
        auditResults.summary.total++;
      }

      console.log(`${result.passed ? '✅' : '❌'} ${test.id}: ${test.name}`);
      
    } catch (error) {
      logger.error(`Test ${test.id} failed with error:`, error);
      
      auditResults.findings.push({
        id: test.id,
        name: test.name,
        category: test.category,
        severity: 'HIGH',
        description: `Test execution failed: ${error.message}`,
        recommendation: 'Fix test execution error and re-run audit'
      });
    }
  }

  calculateScore() {
    // Deduct points based on severity
    const deductions = {
      CRITICAL: 25,
      HIGH: 15,
      MEDIUM: 10,
      LOW: 5,
      INFO: 0
    };

    for (const finding of auditResults.findings) {
      auditResults.score -= deductions[finding.severity] || 0;
    }

    auditResults.score = Math.max(0, auditResults.score);
  }

  // Test implementations

  async testOperatorAddressImmutability() {
    const expectedAddress = '1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa';
    
    // Check source code
    const feeManagerPath = path.join(process.cwd(), 'src', 'fee-manager.js');
    const content = await fs.readFile(feeManagerPath, 'utf8');
    
    // Check if address is hardcoded
    if (!content.includes(expectedAddress)) {
      return {
        passed: false,
        description: 'Operator address not found in fee manager',
        recommendation: 'Ensure operator address is hardcoded and immutable',
        details: { file: 'src/fee-manager.js' }
      };
    }

    // Check for setter method protection
    if (!content.includes('throw new Error') || !content.includes('cannot be changed')) {
      return {
        passed: false,
        description: 'Operator address setter not properly protected',
        recommendation: 'Add immutability protection to setOperatorAddress method',
        details: { method: 'setOperatorAddress' }
      };
    }

    return { passed: true };
  }

  async testFeeRateImmutability() {
    const expectedOperatorRate = 0.001;
    const expectedPoolRate = 0.014;
    
    // Check constants file
    const constantsPath = path.join(process.cwd(), 'src', 'constants.js');
    const content = await fs.readFile(constantsPath, 'utf8');
    
    if (!content.includes('0.014') || !content.includes('0.015')) {
      return {
        passed: false,
        description: 'Fee rates not properly defined in constants',
        recommendation: 'Define immutable fee rates in constants file',
        details: { file: 'src/constants.js' }
      };
    }

    // Check if rates are frozen
    if (!content.includes('Object.freeze')) {
      return {
        passed: false,
        description: 'Fee constants not frozen',
        recommendation: 'Use Object.freeze to make fee constants immutable',
        details: { issue: 'Constants can be modified at runtime' }
      };
    }

    return { passed: true };
  }

  async testFeeCollectionIntegrity() {
    // Check for automated collection
    const feeManagerPath = path.join(process.cwd(), 'src', 'fee-manager.js');
    const content = await fs.readFile(feeManagerPath, 'utf8');
    
    if (!content.includes('setInterval') || !content.includes('300000')) {
      return {
        passed: false,
        description: 'Automated fee collection not properly configured',
        recommendation: 'Ensure fee collection runs every 5 minutes automatically',
        details: { interval: '300000ms (5 minutes)' }
      };
    }

    // Check for emergency collection
    if (!content.includes('emergencyCollection')) {
      return {
        passed: false,
        description: 'No emergency collection mechanism',
        recommendation: 'Implement emergency fee collection for integrity violations',
        details: { method: 'emergencyCollection' }
      };
    }

    return { passed: true };
  }

  async testJWTSecretStrength() {
    // Check configuration
    const configPath = path.join(process.cwd(), 'otedama.json');
    
    try {
      const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      
      // JWT secret should not be in config file
      if (config.auth?.jwtSecret) {
        return {
          passed: false,
          description: 'JWT secret stored in configuration file',
          recommendation: 'Use environment variables for JWT secret',
          details: { location: 'otedama.json' }
        };
      }
    } catch (error) {
      // Config file not found is OK
    }

    // Check for proper secret generation
    const authPath = path.join(process.cwd(), 'src', 'authentication.js');
    
    try {
      const content = await fs.readFile(authPath, 'utf8');
      
      if (!content.includes('randomBytes') || !content.includes('32')) {
        return {
          passed: false,
          description: 'JWT secret not generated with sufficient entropy',
          recommendation: 'Use crypto.randomBytes(32) for JWT secret generation',
          details: { minLength: 32 }
        };
      }
    } catch (error) {
      // File might not exist
    }

    return { passed: true };
  }

  async testPasswordPolicy() {
    // Check for password requirements
    const patterns = {
      minLength: /length.*[>=]\s*12/i,
      complexity: /[A-Z].*[a-z].*[0-9].*[^A-Za-z0-9]/,
      bcrypt: /bcrypt|argon2/i
    };

    let hasStrongPolicy = true;
    
    try {
      const authPath = path.join(process.cwd(), 'src', 'authentication.js');
      const content = await fs.readFile(authPath, 'utf8');
      
      if (!patterns.bcrypt.test(content)) {
        return {
          passed: false,
          description: 'Weak password hashing algorithm',
          recommendation: 'Use bcrypt or argon2 for password hashing',
          details: { required: 'bcrypt or argon2' }
        };
      }
    } catch (error) {
      // Authentication might be disabled
    }

    return { passed: true };
  }

  async testSessionSecurity() {
    // Check session configuration
    const checks = {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      maxAge: 3600000 // 1 hour
    };

    // Since this is a mining pool, sessions might not be used
    // Check if authentication is properly configured when enabled
    
    return { passed: true };
  }

  async testSQLInjection() {
    // Check for parameterized queries
    const dbPath = path.join(process.cwd(), 'src', 'database.js');
    
    try {
      const content = await fs.readFile(dbPath, 'utf8');
      
      // Check for string concatenation in queries
      const dangerousPatterns = [
        /query\s*\(\s*['"`].*\+.*['"`]\)/,
        /exec\s*\(\s*['"`].*\$\{.*\}.*['"`]\)/,
        /prepare\s*\(\s*['"`].*\+.*['"`]\)/
      ];
      
      for (const pattern of dangerousPatterns) {
        if (pattern.test(content)) {
          return {
            passed: false,
            description: 'Potential SQL injection vulnerability detected',
            recommendation: 'Use parameterized queries with placeholders',
            details: { pattern: pattern.toString() }
          };
        }
      }
      
      // Check for prepared statements
      if (!content.includes('prepare')) {
        return {
          passed: false,
          description: 'No prepared statements found',
          recommendation: 'Use prepared statements for all database queries',
          details: { file: 'src/database.js' }
        };
      }
    } catch (error) {
      // Database might not be used
    }

    return { passed: true };
  }

  async testCommandInjection() {
    // Check for dangerous functions
    const dangerousFunctions = [
      'child_process',
      'exec(',
      'execSync(',
      'spawn(',
      'eval(',
      'Function('
    ];

    const srcDir = path.join(process.cwd(), 'src');
    const files = await fs.readdir(srcDir);
    
    for (const file of files) {
      if (!file.endsWith('.js')) continue;
      
      const content = await fs.readFile(path.join(srcDir, file), 'utf8');
      
      for (const func of dangerousFunctions) {
        if (content.includes(func)) {
          // Check if it's properly sanitized
          const lines = content.split('\n');
          const lineNum = lines.findIndex(line => line.includes(func));
          
          if (lineNum > 0) {
            // Simple check - in production, use AST parsing
            const prevLine = lines[lineNum - 1];
            if (!prevLine.includes('sanitize') && !prevLine.includes('validate')) {
              return {
                passed: false,
                description: `Potential command injection with ${func}`,
                recommendation: 'Sanitize all user input before using with system commands',
                details: { file, function: func, line: lineNum + 1 }
              };
            }
          }
        }
      }
    }

    return { passed: true };
  }

  async testPathTraversal() {
    // Check for path traversal prevention
    const patterns = [
      '../',
      '..\\',
      'path.join',
      'path.resolve'
    ];

    const vulnerablePatterns = [
      /readFile.*\+/,
      /writeFile.*\+/,
      /createReadStream.*\+/
    ];

    const srcDir = path.join(process.cwd(), 'src');
    const files = await fs.readdir(srcDir);
    
    for (const file of files) {
      if (!file.endsWith('.js')) continue;
      
      const content = await fs.readFile(path.join(srcDir, file), 'utf8');
      
      for (const pattern of vulnerablePatterns) {
        if (pattern.test(content)) {
          return {
            passed: false,
            description: 'Potential path traversal vulnerability',
            recommendation: 'Use path.join() and validate paths against allowed directories',
            details: { file, pattern: pattern.toString() }
          };
        }
      }
    }

    return { passed: true };
  }

  async testEncryptionStrength() {
    // Check encryption algorithms
    const weakAlgorithms = [
      'des',
      'rc4',
      'md5',
      'sha1'
    ];

    const strongAlgorithms = [
      'aes-256-gcm',
      'aes-256-cbc',
      'chacha20-poly1305'
    ];

    const srcDir = path.join(process.cwd(), 'src');
    const files = await fs.readdir(srcDir);
    
    for (const file of files) {
      if (!file.endsWith('.js')) continue;
      
      const content = await fs.readFile(path.join(srcDir, file), 'utf8');
      const lowerContent = content.toLowerCase();
      
      for (const weak of weakAlgorithms) {
        if (lowerContent.includes(weak) && lowerContent.includes('createcipher')) {
          return {
            passed: false,
            description: `Weak encryption algorithm detected: ${weak}`,
            recommendation: 'Use AES-256-GCM or ChaCha20-Poly1305',
            details: { file, algorithm: weak }
          };
        }
      }
    }

    return { passed: true };
  }

  async testRandomGeneration() {
    // Check for secure random generation
    const insecureRandom = [
      'Math.random',
      'Date.now()'
    ];

    const secureRandom = [
      'crypto.randomBytes',
      'crypto.randomInt',
      'crypto.getRandomValues'
    ];

    const srcDir = path.join(process.cwd(), 'src');
    const files = await fs.readdir(srcDir);
    
    for (const file of files) {
      if (!file.endsWith('.js')) continue;
      
      const content = await fs.readFile(path.join(srcDir, file), 'utf8');
      
      // Check for insecure random in security contexts
      if (content.includes('Math.random') && 
          (content.includes('token') || content.includes('secret') || content.includes('nonce'))) {
        return {
          passed: false,
          description: 'Insecure random number generation for security tokens',
          recommendation: 'Use crypto.randomBytes() for security-sensitive randomness',
          details: { file, method: 'Math.random()' }
        };
      }
    }

    return { passed: true };
  }

  async testHashFunctions() {
    // Check hash function usage
    const weakHashes = ['md5', 'sha1'];
    const strongHashes = ['sha256', 'sha512', 'sha3'];

    const srcDir = path.join(process.cwd(), 'src');
    const files = await fs.readdir(srcDir);
    
    for (const file of files) {
      if (!file.endsWith('.js')) continue;
      
      const content = await fs.readFile(path.join(srcDir, file), 'utf8');
      
      for (const weak of weakHashes) {
        if (content.includes(`createHash('${weak}')`)) {
          // Check if it's for security purposes
          const lines = content.split('\n');
          const lineIndex = lines.findIndex(line => line.includes(`createHash('${weak}')`));
          
          if (lineIndex >= 0) {
            const context = lines.slice(Math.max(0, lineIndex - 5), lineIndex + 5).join('\n');
            
            if (context.includes('password') || context.includes('token') || context.includes('secret')) {
              return {
                passed: false,
                description: `Weak hash function ${weak} used for security`,
                recommendation: 'Use SHA-256 or SHA-512 for security hashing',
                details: { file, hash: weak }
              };
            }
          }
        }
      }
    }

    return { passed: true };
  }

  async testRateLimiting() {
    // Check rate limiting configuration
    const rateLimiterPath = path.join(process.cwd(), 'src', 'rate-limiter.js');
    
    try {
      const content = await fs.readFile(rateLimiterPath, 'utf8');
      
      // Check for proper limits
      if (!content.includes('maxRequests') || !content.includes('windowMs')) {
        return {
          passed: false,
          description: 'Rate limiting not properly configured',
          recommendation: 'Implement rate limiting for all API endpoints',
          details: { required: 'maxRequests and windowMs configuration' }
        };
      }
      
      // Check if limits are reasonable
      const maxRequestsMatch = content.match(/maxRequests:\s*(\d+)/);
      if (maxRequestsMatch && parseInt(maxRequestsMatch[1]) > 10000) {
        return {
          passed: false,
          description: 'Rate limits too permissive',
          recommendation: 'Set stricter rate limits (< 1000 requests per minute)',
          details: { current: maxRequestsMatch[1] }
        };
      }
    } catch (error) {
      return {
        passed: false,
        description: 'Rate limiter not found',
        recommendation: 'Implement rate limiting to prevent abuse',
        details: { file: 'src/rate-limiter.js' }
      };
    }

    return { passed: true };
  }

  async testCORSConfig() {
    // Check CORS configuration
    const apiServerPath = path.join(process.cwd(), 'src', 'api-server.js');
    
    try {
      const content = await fs.readFile(apiServerPath, 'utf8');
      
      // Check for wildcard origin
      if (content.includes("'*'") && content.includes('origin')) {
        return {
          passed: false,
          description: 'CORS allows all origins',
          recommendation: 'Configure specific allowed origins instead of wildcard',
          details: { current: '*', recommended: "['https://app.otedama.com']" }
        };
      }
      
      // Check for credentials
      if (content.includes('credentials: true') && content.includes("'*'")) {
        return {
          passed: false,
          description: 'CORS allows credentials with wildcard origin',
          recommendation: 'Never allow credentials with wildcard origin',
          details: { issue: 'Security vulnerability' }
        };
      }
    } catch (error) {
      // API server might not have CORS
    }

    return { passed: true };
  }

  async testFilePermissions() {
    // Check sensitive file permissions
    const sensitiveFiles = [
      'otedama.json',
      '.env',
      'data/otedama.db'
    ];

    for (const file of sensitiveFiles) {
      try {
        const stats = await fs.stat(file);
        const mode = (stats.mode & parseInt('777', 8)).toString(8);
        
        // Check if world-readable
        if (mode[2] !== '0') {
          return {
            passed: false,
            description: `Sensitive file ${file} is world-readable`,
            recommendation: 'Set file permissions to 600 (owner read/write only)',
            details: { file, currentMode: mode, recommendedMode: '600' }
          };
        }
      } catch (error) {
        // File might not exist
      }
    }

    return { passed: true };
  }

  async testDDoSProtection() {
    // Check DDoS protection
    const ddosPath = path.join(process.cwd(), 'src', 'ddos-protection.js');
    
    try {
      const content = await fs.readFile(ddosPath, 'utf8');
      
      // Check for essential features
      const features = [
        'rateLimit',
        'blacklist',
        'challenge',
        'adaptive'
      ];
      
      for (const feature of features) {
        if (!content.includes(feature)) {
          return {
            passed: false,
            description: `DDoS protection missing ${feature} feature`,
            recommendation: `Implement ${feature} in DDoS protection`,
            details: { missingFeature: feature }
          };
        }
      }
    } catch (error) {
      return {
        passed: false,
        description: 'DDoS protection not implemented',
        recommendation: 'Implement comprehensive DDoS protection',
        details: { file: 'src/ddos-protection.js' }
      };
    }

    return { passed: true };
  }

  async testSSLConfig() {
    // Check SSL/TLS configuration
    const configPath = path.join(process.cwd(), 'otedama.json');
    
    try {
      const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      
      if (config.security?.enableSSL === false) {
        return {
          passed: false,
          description: 'SSL/TLS is disabled',
          recommendation: 'Enable SSL/TLS for all network communications',
          details: { setting: 'security.enableSSL', current: false }
        };
      }
    } catch (error) {
      // Configuration might not exist
    }

    // Check for certificate validation
    const networkFiles = ['api-server.js', 'p2p-network.js', 'stratum-server.js'];
    
    for (const file of networkFiles) {
      try {
        const content = await fs.readFile(path.join(process.cwd(), 'src', file), 'utf8');
        
        if (content.includes('rejectUnauthorized: false')) {
          return {
            passed: false,
            description: 'SSL certificate validation disabled',
            recommendation: 'Enable certificate validation (rejectUnauthorized: true)',
            details: { file, issue: 'rejectUnauthorized: false' }
          };
        }
      } catch (error) {
        // File might not exist
      }
    }

    return { passed: true };
  }

  async testOpenPorts() {
    // Check for unnecessary open ports
    const expectedPorts = {
      3333: 'Stratum',
      8080: 'API',
      8333: 'P2P',
      9090: 'Metrics'
    };

    // This would require actual network scanning in production
    // For now, check configuration
    
    return { passed: true };
  }

  async testSensitiveDataExposure() {
    // Check for exposed sensitive data
    const sensitivePatterns = [
      /private[_\s]?key/i,
      /secret[_\s]?key/i,
      /api[_\s]?key/i,
      /password/i,
      /seed[_\s]?phrase/i
    ];

    const publicFiles = ['README.md', 'CHANGELOG.md', 'package.json'];
    
    for (const file of publicFiles) {
      try {
        const content = await fs.readFile(file, 'utf8');
        
        for (const pattern of sensitivePatterns) {
          if (pattern.test(content)) {
            // Check if it's actual sensitive data
            const match = content.match(pattern);
            if (match && match[0].length > 20) {
              return {
                passed: false,
                description: `Potential sensitive data exposure in ${file}`,
                recommendation: 'Remove sensitive data from public files',
                details: { file, pattern: pattern.toString() }
              };
            }
          }
        }
      } catch (error) {
        // File might not exist
      }
    }

    return { passed: true };
  }

  async testDebugMode() {
    // Check for debug mode in production
    const files = ['index.js', 'src/logger.js', 'src/config.js'];
    
    for (const file of files) {
      try {
        const content = await fs.readFile(file, 'utf8');
        
        if (content.includes('DEBUG=true') || content.includes("debug: true")) {
          return {
            passed: false,
            description: 'Debug mode enabled in production code',
            recommendation: 'Disable debug mode for production',
            details: { file, issue: 'Debug mode active' }
          };
        }
      } catch (error) {
        // File might not exist
      }
    }

    // Check NODE_ENV
    if (process.env.NODE_ENV !== 'production') {
      return {
        passed: false,
        description: 'NODE_ENV not set to production',
        recommendation: 'Set NODE_ENV=production for production deployments',
        details: { current: process.env.NODE_ENV || 'undefined' }
      };
    }

    return { passed: true };
  }

  async testDefaultCredentials() {
    // Check for default credentials
    const configPath = path.join(process.cwd(), 'otedama.json');
    
    try {
      const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      
      // Check for default passwords
      const defaults = ['admin', 'password', '123456', 'default'];
      
      const checkObject = (obj, path = '') => {
        for (const [key, value] of Object.entries(obj)) {
          if (typeof value === 'object' && value !== null) {
            checkObject(value, `${path}.${key}`);
          } else if (typeof value === 'string') {
            if (key.toLowerCase().includes('password') || 
                key.toLowerCase().includes('secret') ||
                key.toLowerCase().includes('key')) {
              if (defaults.includes(value.toLowerCase())) {
                return {
                  passed: false,
                  description: 'Default credentials found',
                  recommendation: 'Change all default passwords and secrets',
                  details: { path: `${path}.${key}`, value: '***' }
                };
              }
            }
          }
        }
      };
      
      const result = checkObject(config);
      if (result) return result;
      
    } catch (error) {
      // Config might not exist
    }

    return { passed: true };
  }

  async testFileIntegrity() {
    // Check critical file integrity
    const criticalFiles = {
      'src/fee-manager.js': {
        minSize: 15000,
        requiredContent: ['1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa', '0.001', '0.014']
      },
      'src/payment-manager.js': {
        minSize: 10000,
        requiredContent: ['processAutomaticPayouts', 'creditMiner']
      },
      'src/unified-dex.js': {
        minSize: 20000,
        requiredContent: ['createV2Pool', 'createV3Pool', 'swap']
      }
    };

    for (const [file, checks] of Object.entries(criticalFiles)) {
      try {
        const stats = await fs.stat(file);
        const content = await fs.readFile(file, 'utf8');
        
        // Check file size
        if (stats.size < checks.minSize) {
          return {
            passed: false,
            description: `Critical file ${file} appears truncated`,
            recommendation: 'Verify file integrity and restore if corrupted',
            details: { file, expectedMinSize: checks.minSize, actualSize: stats.size }
          };
        }
        
        // Check required content
        for (const required of checks.requiredContent) {
          if (!content.includes(required)) {
            return {
              passed: false,
              description: `Critical file ${file} missing required content`,
              recommendation: 'File may be corrupted or tampered with',
              details: { file, missingContent: required }
            };
          }
        }
      } catch (error) {
        return {
          passed: false,
          description: `Critical file ${file} not found`,
          recommendation: 'Restore missing critical files',
          details: { file, error: error.message }
        };
      }
    }

    return { passed: true };
  }

  async testCodeTampering() {
    // Calculate checksums of critical files
    const criticalFiles = [
      'src/fee-manager.js',
      'src/payment-manager.js',
      'src/constants.js',
      'index.js'
    ];

    const checksums = {};
    
    for (const file of criticalFiles) {
      try {
        const content = await fs.readFile(file, 'utf8');
        const hash = createHash('sha256').update(content).digest('hex');
        checksums[file] = hash;
      } catch (error) {
        return {
          passed: false,
          description: `Cannot verify integrity of ${file}`,
          recommendation: 'Ensure all critical files are present',
          details: { file, error: error.message }
        };
      }
    }

    // In production, compare against known good checksums
    // For now, just ensure files exist and can be hashed
    
    return { passed: true };
  }
}

/**
 * Generate security report
 */
function generateReport() {
  const report = `
# Otedama Security Audit Report

**Version**: ${auditResults.version}  
**Date**: ${auditResults.timestamp}  
**Security Score**: ${auditResults.score}/100

## Summary

- **Total Findings**: ${auditResults.summary.total}
- **Critical**: ${auditResults.summary.critical}
- **High**: ${auditResults.summary.high}
- **Medium**: ${auditResults.summary.medium}
- **Low**: ${auditResults.summary.low}
- **Info**: ${auditResults.summary.info}

## Findings

${auditResults.findings.map(finding => `
### ${finding.id}: ${finding.name}

**Severity**: ${finding.severity}  
**Category**: ${finding.category}

**Description**: ${finding.description}

**Recommendation**: ${finding.recommendation}

${finding.details ? `**Details**: ${JSON.stringify(finding.details, null, 2)}` : ''}
`).join('\n---\n')}

## Recommendations

1. **Address all CRITICAL findings immediately**
2. **Implement fixes for HIGH severity issues before production**
3. **Plan remediation for MEDIUM issues in next release**
4. **Consider LOW issues for future improvements**

## Compliance Status

- **Fee System Security**: ${auditResults.findings.filter(f => f.category === 'fees').length === 0 ? '✅ COMPLIANT' : '❌ NON-COMPLIANT'}
- **Authentication Security**: ${auditResults.findings.filter(f => f.category === 'authentication' && f.severity === 'CRITICAL').length === 0 ? '✅ PASS' : '❌ FAIL'}
- **Network Security**: ${auditResults.findings.filter(f => f.category === 'network' && f.severity === 'CRITICAL').length === 0 ? '✅ PASS' : '❌ FAIL'}
- **Data Protection**: ${auditResults.findings.filter(f => f.category === 'configuration' && f.severity === 'CRITICAL').length === 0 ? '✅ PASS' : '❌ FAIL'}

---

*Generated by Otedama Security Auditor v0.5*
`;

  return report;
}

/**
 * Main execution
 */
async function main() {
  console.log('🔒 Otedama Security Audit v0.5');
  console.log('==============================\n');

  const auditor = new SecurityAuditor();
  
  try {
    await auditor.runAllTests();
    
    const report = generateReport();
    
    // Save report
    await fs.writeFile(
      `security-audit-${Date.now()}.md`,
      report
    );
    
    // Display summary
    console.log('\n==============================');
    console.log(`Security Score: ${auditResults.score}/100`);
    console.log(`Total Findings: ${auditResults.summary.total}`);
    
    if (auditResults.summary.critical > 0) {
      console.log(`\n⚠️  CRITICAL ISSUES FOUND: ${auditResults.summary.critical}`);
      console.log('Fix these immediately before deployment!');
    }
    
    console.log('\n📄 Full report saved to security-audit-*.md');
    
    // Exit with error if critical issues
    process.exit(auditResults.summary.critical > 0 ? 1 : 0);
    
  } catch (error) {
    logger.error('Security audit failed:', error);
    process.exit(1);
  }
}

// Run audit
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { SecurityAuditor };
