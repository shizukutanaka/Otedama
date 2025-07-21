/**
 * Automated Penetration Testing
 * Continuous security validation for enterprise deployments
 * Performs automated security scans and vulnerability assessments
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import { getLogger } from '../core/logger.js';
import { getAuditLog } from './immutable-audit-logs.js';

// Test categories
export const TestCategory = {
  AUTHENTICATION: 'authentication',
  AUTHORIZATION: 'authorization',
  INJECTION: 'injection',
  XSS: 'xss',
  CSRF: 'csrf',
  CRYPTOGRAPHY: 'cryptography',
  SESSION_MANAGEMENT: 'session_management',
  API_SECURITY: 'api_security',
  NETWORK_SECURITY: 'network_security',
  CONFIGURATION: 'configuration'
};

// Test severity levels
export const TestSeverity = {
  INFO: 'info',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
};

// Test status
export const TestStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  PASSED: 'passed',
  FAILED: 'failed',
  ERROR: 'error',
  SKIPPED: 'skipped'
};

/**
 * Automated Penetration Tester
 */
export class PenetrationTester extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.logger = getLogger('PenetrationTester');
    this.auditLog = getAuditLog();
    this.options = {
      targetUrl: options.targetUrl || 'http://localhost:3000',
      apiEndpoints: options.apiEndpoints || [],
      authEndpoints: options.authEndpoints || ['/api/auth/login', '/api/auth/register'],
      testCategories: options.testCategories || Object.values(TestCategory),
      scanInterval: options.scanInterval || 3600000, // 1 hour
      maxConcurrentTests: options.maxConcurrentTests || 10,
      timeout: options.timeout || 30000,
      enableDestructiveTests: options.enableDestructiveTests || false,
      notificationWebhook: options.notificationWebhook || null,
      ...options
    };
    
    // Test suites
    this.testSuites = new Map();
    this.loadTestSuites();
    
    // Test results
    this.testResults = new Map();
    this.vulnerabilities = [];
    
    // Test execution state
    this.running = false;
    this.currentTests = new Set();
    
    // Statistics
    this.stats = {
      totalScans: 0,
      totalTests: 0,
      testsPassed: 0,
      testsFailed: 0,
      vulnerabilitiesFound: 0,
      lastScanTime: null,
      averageScanDuration: 0
    };
  }
  
  /**
   * Initialize penetration tester
   */
  async initialize() {
    this.logger.info('Initializing automated penetration tester...');
    
    // Start periodic scans if interval configured
    if (this.options.scanInterval > 0) {
      this.startPeriodicScans();
    }
    
    this.emit('initialized');
  }
  
  /**
   * Load test suites
   */
  loadTestSuites() {
    // Authentication tests
    this.testSuites.set(TestCategory.AUTHENTICATION, [
      {
        name: 'Brute Force Protection',
        severity: TestSeverity.HIGH,
        test: async () => this.testBruteForceProtection()
      },
      {
        name: 'Password Policy Enforcement',
        severity: TestSeverity.MEDIUM,
        test: async () => this.testPasswordPolicy()
      },
      {
        name: 'Account Lockout Mechanism',
        severity: TestSeverity.HIGH,
        test: async () => this.testAccountLockout()
      },
      {
        name: 'Session Fixation',
        severity: TestSeverity.HIGH,
        test: async () => this.testSessionFixation()
      }
    ]);
    
    // Injection tests
    this.testSuites.set(TestCategory.INJECTION, [
      {
        name: 'SQL Injection',
        severity: TestSeverity.CRITICAL,
        test: async () => this.testSQLInjection()
      },
      {
        name: 'NoSQL Injection',
        severity: TestSeverity.CRITICAL,
        test: async () => this.testNoSQLInjection()
      },
      {
        name: 'Command Injection',
        severity: TestSeverity.CRITICAL,
        test: async () => this.testCommandInjection()
      },
      {
        name: 'LDAP Injection',
        severity: TestSeverity.HIGH,
        test: async () => this.testLDAPInjection()
      }
    ]);
    
    // XSS tests
    this.testSuites.set(TestCategory.XSS, [
      {
        name: 'Reflected XSS',
        severity: TestSeverity.HIGH,
        test: async () => this.testReflectedXSS()
      },
      {
        name: 'Stored XSS',
        severity: TestSeverity.CRITICAL,
        test: async () => this.testStoredXSS()
      },
      {
        name: 'DOM-based XSS',
        severity: TestSeverity.HIGH,
        test: async () => this.testDOMXSS()
      }
    ]);
    
    // CSRF tests
    this.testSuites.set(TestCategory.CSRF, [
      {
        name: 'CSRF Token Validation',
        severity: TestSeverity.HIGH,
        test: async () => this.testCSRFTokenValidation()
      },
      {
        name: 'SameSite Cookie Protection',
        severity: TestSeverity.MEDIUM,
        test: async () => this.testSameSiteCookies()
      }
    ]);
    
    // Cryptography tests
    this.testSuites.set(TestCategory.CRYPTOGRAPHY, [
      {
        name: 'Weak Cipher Suites',
        severity: TestSeverity.HIGH,
        test: async () => this.testWeakCiphers()
      },
      {
        name: 'SSL/TLS Configuration',
        severity: TestSeverity.HIGH,
        test: async () => this.testSSLConfiguration()
      },
      {
        name: 'Certificate Validation',
        severity: TestSeverity.CRITICAL,
        test: async () => this.testCertificateValidation()
      },
      {
        name: 'Insecure Random Generation',
        severity: TestSeverity.HIGH,
        test: async () => this.testRandomGeneration()
      }
    ]);
    
    // API Security tests
    this.testSuites.set(TestCategory.API_SECURITY, [
      {
        name: 'Rate Limiting',
        severity: TestSeverity.MEDIUM,
        test: async () => this.testRateLimiting()
      },
      {
        name: 'API Key Security',
        severity: TestSeverity.HIGH,
        test: async () => this.testAPIKeySecurity()
      },
      {
        name: 'Input Validation',
        severity: TestSeverity.HIGH,
        test: async () => this.testInputValidation()
      },
      {
        name: 'Error Handling',
        severity: TestSeverity.MEDIUM,
        test: async () => this.testErrorHandling()
      }
    ]);
  }
  
  /**
   * Run full security scan
   */
  async runFullScan() {
    if (this.running) {
      throw new Error('Scan already in progress');
    }
    
    this.running = true;
    const scanId = crypto.randomBytes(16).toString('hex');
    const startTime = Date.now();
    
    this.logger.info(`Starting security scan ${scanId}`);
    this.emit('scan:started', { scanId, timestamp: startTime });
    
    const scanResults = {
      scanId,
      startTime,
      endTime: null,
      status: TestStatus.RUNNING,
      categoriesScanned: [],
      totalTests: 0,
      passed: 0,
      failed: 0,
      vulnerabilities: []
    };
    
    try {
      // Run tests by category
      for (const category of this.options.testCategories) {
        const categoryResults = await this.runCategoryTests(category);
        scanResults.categoriesScanned.push(category);
        scanResults.totalTests += categoryResults.totalTests;
        scanResults.passed += categoryResults.passed;
        scanResults.failed += categoryResults.failed;
        scanResults.vulnerabilities.push(...categoryResults.vulnerabilities);
      }
      
      scanResults.endTime = Date.now();
      scanResults.status = TestStatus.PASSED;
      scanResults.duration = scanResults.endTime - scanResults.startTime;
      
      // Update statistics
      this.stats.totalScans++;
      this.stats.lastScanTime = scanResults.endTime;
      this.updateAverageScanDuration(scanResults.duration);
      
      // Store results
      this.testResults.set(scanId, scanResults);
      
      // Log to audit
      await this.auditLog.log(
        'security_scan',
        scanResults.failed > 0 ? 3 : 1, // ERROR if vulnerabilities found
        `Security scan completed: ${scanResults.passed} passed, ${scanResults.failed} failed`,
        { scanId, vulnerabilities: scanResults.vulnerabilities.length }
      );
      
      // Send notifications if vulnerabilities found
      if (scanResults.vulnerabilities.length > 0) {
        await this.notifyVulnerabilities(scanResults);
      }
      
      this.emit('scan:completed', scanResults);
      
      return scanResults;
      
    } catch (error) {
      this.logger.error('Security scan failed:', error);
      scanResults.status = TestStatus.ERROR;
      scanResults.error = error.message;
      
      this.emit('scan:failed', { scanId, error });
      throw error;
      
    } finally {
      this.running = false;
    }
  }
  
  /**
   * Run tests for a specific category
   */
  async runCategoryTests(category) {
    const tests = this.testSuites.get(category);
    if (!tests) {
      throw new Error(`Unknown test category: ${category}`);
    }
    
    this.logger.info(`Running ${tests.length} tests for category: ${category}`);
    
    const results = {
      category,
      totalTests: tests.length,
      passed: 0,
      failed: 0,
      vulnerabilities: []
    };
    
    // Run tests with concurrency limit
    const testQueue = [...tests];
    const runningTests = [];
    
    while (testQueue.length > 0 || runningTests.length > 0) {
      // Start new tests up to concurrency limit
      while (runningTests.length < this.options.maxConcurrentTests && testQueue.length > 0) {
        const test = testQueue.shift();
        const testPromise = this.runSingleTest(test, category);
        runningTests.push(testPromise);
      }
      
      // Wait for at least one test to complete
      if (runningTests.length > 0) {
        const result = await Promise.race(runningTests);
        const index = runningTests.findIndex(p => p === result || p === await result);
        runningTests.splice(index, 1);
        
        // Process result
        const testResult = await result;
        if (testResult.status === TestStatus.PASSED) {
          results.passed++;
        } else if (testResult.status === TestStatus.FAILED) {
          results.failed++;
          results.vulnerabilities.push({
            category,
            test: testResult.name,
            severity: testResult.severity,
            details: testResult.details
          });
        }
      }
    }
    
    return results;
  }
  
  /**
   * Run single test
   */
  async runSingleTest(test, category) {
    const testId = crypto.randomBytes(8).toString('hex');
    
    this.logger.debug(`Running test: ${test.name} (${category})`);
    
    const result = {
      testId,
      name: test.name,
      category,
      severity: test.severity,
      status: TestStatus.RUNNING,
      startTime: Date.now(),
      endTime: null,
      details: null
    };
    
    try {
      const testResult = await Promise.race([
        test.test(),
        this.createTimeout(this.options.timeout)
      ]);
      
      result.status = testResult.passed ? TestStatus.PASSED : TestStatus.FAILED;
      result.details = testResult.details;
      
      this.stats.totalTests++;
      if (result.status === TestStatus.PASSED) {
        this.stats.testsPassed++;
      } else {
        this.stats.testsFailed++;
        this.stats.vulnerabilitiesFound++;
        
        // Store vulnerability
        this.vulnerabilities.push({
          ...result,
          foundAt: Date.now()
        });
      }
      
    } catch (error) {
      result.status = TestStatus.ERROR;
      result.error = error.message;
      this.logger.error(`Test failed: ${test.name}`, error);
    }
    
    result.endTime = Date.now();
    result.duration = result.endTime - result.startTime;
    
    this.emit('test:completed', result);
    
    return result;
  }
  
  /**
   * Test implementations
   */
  
  async testBruteForceProtection() {
    const endpoint = this.options.authEndpoints[0];
    const attempts = 10;
    let blocked = false;
    
    // Try multiple failed login attempts
    for (let i = 0; i < attempts; i++) {
      try {
        const response = await this.makeRequest('POST', endpoint, {
          username: 'testuser',
          password: `wrongpass${i}`
        });
        
        if (response.status === 429 || response.status === 403) {
          blocked = true;
          break;
        }
      } catch (error) {
        // Expected for failed logins
      }
    }
    
    return {
      passed: blocked,
      details: blocked 
        ? 'Brute force protection is active'
        : `No rate limiting after ${attempts} failed attempts`
    };
  }
  
  async testSQLInjection() {
    const payloads = [
      "' OR '1'='1",
      "'; DROP TABLE users; --",
      "' UNION SELECT * FROM users --",
      "admin'--",
      "' OR 1=1--"
    ];
    
    const vulnerableEndpoints = [];
    
    for (const endpoint of this.options.apiEndpoints) {
      for (const payload of payloads) {
        try {
          const response = await this.makeRequest('GET', `${endpoint}?id=${encodeURIComponent(payload)}`);
          
          // Check for SQL error messages
          const body = await response.text();
          if (this.containsSQLError(body) || response.status === 200) {
            vulnerableEndpoints.push({ endpoint, payload });
          }
        } catch (error) {
          // Ignore connection errors
        }
      }
    }
    
    return {
      passed: vulnerableEndpoints.length === 0,
      details: vulnerableEndpoints.length > 0 
        ? `SQL injection found in ${vulnerableEndpoints.length} endpoints`
        : 'No SQL injection vulnerabilities detected'
    };
  }
  
  async testXSSReflected() {
    const payloads = [
      '<script>alert("XSS")</script>',
      '"><script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      'javascript:alert(1)',
      '<svg onload=alert(1)>'
    ];
    
    const vulnerableEndpoints = [];
    
    for (const endpoint of this.options.apiEndpoints) {
      for (const payload of payloads) {
        try {
          const response = await this.makeRequest('GET', `${endpoint}?q=${encodeURIComponent(payload)}`);
          const body = await response.text();
          
          // Check if payload is reflected without encoding
          if (body.includes(payload)) {
            vulnerableEndpoints.push({ endpoint, payload });
          }
        } catch (error) {
          // Ignore
        }
      }
    }
    
    return {
      passed: vulnerableEndpoints.length === 0,
      details: vulnerableEndpoints.length > 0
        ? `Reflected XSS found in ${vulnerableEndpoints.length} endpoints`
        : 'No reflected XSS vulnerabilities detected'
    };
  }
  
  async testRateLimiting() {
    const endpoint = this.options.apiEndpoints[0];
    const requests = 100;
    let rateLimited = false;
    
    const promises = [];
    for (let i = 0; i < requests; i++) {
      promises.push(
        this.makeRequest('GET', endpoint)
          .then(response => {
            if (response.status === 429) {
              rateLimited = true;
            }
          })
          .catch(() => {})
      );
    }
    
    await Promise.all(promises);
    
    return {
      passed: rateLimited,
      details: rateLimited
        ? 'Rate limiting is properly configured'
        : `No rate limiting detected after ${requests} requests`
    };
  }
  
  async testCSRFTokenValidation() {
    // Test if CSRF tokens are required for state-changing operations
    const endpoint = this.options.apiEndpoints.find(e => e.includes('update') || e.includes('create'));
    if (!endpoint) {
      return { passed: true, details: 'No state-changing endpoints found' };
    }
    
    try {
      // Try request without CSRF token
      const response = await this.makeRequest('POST', endpoint, { test: 'data' }, {
        headers: { 'Content-Type': 'application/json' }
      });
      
      return {
        passed: response.status === 403 || response.status === 401,
        details: response.status === 403 || response.status === 401
          ? 'CSRF protection is active'
          : 'State-changing operation allowed without CSRF token'
      };
    } catch (error) {
      return { passed: true, details: 'Request failed as expected' };
    }
  }
  
  /**
   * Helper methods
   */
  
  async makeRequest(method, url, body = null, options = {}) {
    const fullUrl = url.startsWith('http') ? url : `${this.options.targetUrl}${url}`;
    
    const response = await fetch(fullUrl, {
      method,
      headers: {
        'User-Agent': 'Otedama-Security-Scanner/1.0',
        ...options.headers
      },
      body: body ? JSON.stringify(body) : undefined,
      timeout: this.options.timeout
    });
    
    return response;
  }
  
  containsSQLError(text) {
    const errorPatterns = [
      /SQL syntax/i,
      /mysql_fetch/i,
      /ORA-[0-9]+/,
      /PostgreSQL.*ERROR/i,
      /warning.*mysql/i,
      /valid MySQL result/i,
      /mssql_query/i,
      /PostgreSQL query failed/i,
      /SQL Server/i
    ];
    
    return errorPatterns.some(pattern => pattern.test(text));
  }
  
  createTimeout(ms) {
    return new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Test timeout')), ms)
    );
  }
  
  /**
   * Notify about vulnerabilities
   */
  async notifyVulnerabilities(scanResults) {
    const criticalVulns = scanResults.vulnerabilities.filter(
      v => v.severity === TestSeverity.CRITICAL
    );
    
    const notification = {
      scanId: scanResults.scanId,
      timestamp: Date.now(),
      vulnerabilities: scanResults.vulnerabilities.length,
      critical: criticalVulns.length,
      high: scanResults.vulnerabilities.filter(v => v.severity === TestSeverity.HIGH).length,
      medium: scanResults.vulnerabilities.filter(v => v.severity === TestSeverity.MEDIUM).length,
      low: scanResults.vulnerabilities.filter(v => v.severity === TestSeverity.LOW).length
    };
    
    this.emit('vulnerabilities:found', notification);
    
    // Send webhook notification if configured
    if (this.options.notificationWebhook) {
      try {
        await fetch(this.options.notificationWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(notification)
        });
      } catch (error) {
        this.logger.error('Failed to send webhook notification:', error);
      }
    }
  }
  
  /**
   * Start periodic scans
   */
  startPeriodicScans() {
    setInterval(async () => {
      try {
        await this.runFullScan();
      } catch (error) {
        this.logger.error('Periodic scan failed:', error);
      }
    }, this.options.scanInterval);
  }
  
  /**
   * Update average scan duration
   */
  updateAverageScanDuration(duration) {
    const totalDuration = this.stats.averageScanDuration * (this.stats.totalScans - 1) + duration;
    this.stats.averageScanDuration = totalDuration / this.stats.totalScans;
  }
  
  /**
   * Get scan results
   */
  getScanResults(scanId) {
    return this.testResults.get(scanId);
  }
  
  /**
   * Get all vulnerabilities
   */
  getVulnerabilities(filter = {}) {
    let vulns = [...this.vulnerabilities];
    
    if (filter.severity) {
      vulns = vulns.filter(v => v.severity === filter.severity);
    }
    
    if (filter.category) {
      vulns = vulns.filter(v => v.category === filter.category);
    }
    
    if (filter.since) {
      vulns = vulns.filter(v => v.foundAt >= filter.since);
    }
    
    return vulns;
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      currentVulnerabilities: this.vulnerabilities.length,
      criticalVulnerabilities: this.vulnerabilities.filter(
        v => v.severity === TestSeverity.CRITICAL
      ).length
    };
  }
  
  /**
   * Generate security report
   */
  generateReport(format = 'json') {
    const report = {
      generatedAt: Date.now(),
      stats: this.getStats(),
      recentScans: Array.from(this.testResults.values()).slice(-10),
      activeVulnerabilities: this.getVulnerabilities(),
      recommendations: this.generateRecommendations()
    };
    
    switch (format) {
      case 'json':
        return JSON.stringify(report, null, 2);
      case 'html':
        return this.generateHTMLReport(report);
      default:
        return report;
    }
  }
  
  /**
   * Generate recommendations based on findings
   */
  generateRecommendations() {
    const recommendations = [];
    
    const vulnsByCategory = {};
    for (const vuln of this.vulnerabilities) {
      vulnsByCategory[vuln.category] = (vulnsByCategory[vuln.category] || 0) + 1;
    }
    
    if (vulnsByCategory[TestCategory.AUTHENTICATION] > 0) {
      recommendations.push({
        category: 'Authentication',
        priority: 'High',
        recommendation: 'Implement stronger authentication mechanisms including 2FA and account lockout policies'
      });
    }
    
    if (vulnsByCategory[TestCategory.INJECTION] > 0) {
      recommendations.push({
        category: 'Input Validation',
        priority: 'Critical',
        recommendation: 'Implement parameterized queries and strict input validation for all user inputs'
      });
    }
    
    if (vulnsByCategory[TestCategory.CRYPTOGRAPHY] > 0) {
      recommendations.push({
        category: 'Cryptography',
        priority: 'High',
        recommendation: 'Update SSL/TLS configuration and ensure strong cipher suites are used'
      });
    }
    
    return recommendations;
  }
}

export default PenetrationTester;