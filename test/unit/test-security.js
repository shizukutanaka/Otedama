#!/usr/bin/env node

/**
 * Otedama Security Test Suite
 * セキュリティ機能の包括的テスト
 */

import { Logger } from '../src/logger.js';

class SecurityTestSuite {
  constructor() {
    this.logger = new Logger('SecurityTest');
    this.results = {
      passed: 0,
      failed: 0,
      tests: []
    };
  }

  /**
   * Test DDoS Protection
   */
  async testDDoSProtection() {
    console.log('\n🔒 Testing DDoS Protection...');
    
    try {
      const { DDoSProtection } = await import('../src/ddos-protection.js');
      const ddos = new DDoSProtection({
        maxRequestsPerWindow: 10,
        windowSize: 1000, // 1 second for testing
        enableChallenge: true
      });
      
      // Test 1: Normal requests should pass
      let testPassed = true;
      for (let i = 0; i < 5; i++) {
        const result = await ddos.checkRequest('192.168.1.1', '/api/test');
        if (!result.allowed) {
          testPassed = false;
          break;
        }
      }
      this.recordTest('DDoS: Normal requests', testPassed);
      
      // Test 2: Excessive requests should be blocked
      testPassed = false;
      for (let i = 0; i < 15; i++) {
        const result = await ddos.checkRequest('192.168.1.2', '/api/test');
        if (!result.allowed && result.reason === 'rate_limit_window') {
          testPassed = true;
          break;
        }
      }
      this.recordTest('DDoS: Rate limit blocking', testPassed);
      
      // Test 3: Blacklist functionality
      ddos.blacklistIP('192.168.1.3');
      const blacklistResult = await ddos.checkRequest('192.168.1.3', '/api/test');
      this.recordTest('DDoS: Blacklist blocking', !blacklistResult.allowed && blacklistResult.reason === 'blacklisted');
      
      // Test 4: Challenge system
      for (let i = 0; i < 3; i++) {
        await ddos.checkRequest('192.168.1.4', '/api/test');
        ddos.recordViolation('192.168.1.4', 'test');
      }
      const challengeResult = await ddos.checkRequest('192.168.1.4', '/api/test');
      this.recordTest('DDoS: Challenge required', 
        !challengeResult.allowed && challengeResult.reason === 'challenge_required' && challengeResult.challenge);
      
      // Test 5: Pattern detection
      const suspiciousResult = await ddos.checkRequest('192.168.1.5', '/../../../etc/passwd');
      this.recordTest('DDoS: Suspicious pattern detection', 
        !suspiciousResult.allowed && suspiciousResult.reason === 'suspicious_pattern');
      
      ddos.stop();
      
    } catch (error) {
      this.logger.error('DDoS protection test failed:', error);
      this.recordTest('DDoS Protection', false);
    }
  }

  /**
   * Test Rate Limiter
   */
  async testRateLimiter() {
    console.log('\n🚦 Testing Rate Limiter...');
    
    try {
      const { RateLimiter } = await import('../src/rate-limiter.js');
      const limiter = new RateLimiter({
        api: { windowMs: 1000, maxRequests: 5 }
      });
      
      // Test 1: API rate limiting
      let testPassed = true;
      const req = { ip: '192.168.1.10' };
      
      for (let i = 0; i < 5; i++) {
        const result = limiter.checkAPILimit(req);
        if (!result.allowed) {
          testPassed = false;
          break;
        }
      }
      
      const limitedResult = limiter.checkAPILimit(req);
      this.recordTest('Rate Limiter: API limits', 
        testPassed && !limitedResult.allowed && limitedResult.reason === 'rate_limit');
      
      // Test 2: Stratum connection limits
      const ip = '192.168.1.11';
      testPassed = true;
      
      for (let i = 0; i < 10; i++) {
        const result = limiter.checkStratumConnection(ip);
        if (result.allowed) {
          limiter.releaseStratumConnection(ip);
        }
      }
      
      const stratumResult = limiter.checkStratumConnection(ip);
      this.recordTest('Rate Limiter: Stratum connections', stratumResult.allowed);
      
      // Test 3: DEX transaction limits
      const dexResult = limiter.checkDEXTransaction('0xuser', '1000000');
      this.recordTest('Rate Limiter: DEX transactions', dexResult.allowed);
      
      // Test 4: Mining share limits
      const minerResult = limiter.checkMiningShare('miner123', true);
      this.recordTest('Rate Limiter: Mining shares', minerResult.allowed);
      
      limiter.stop();
      
    } catch (error) {
      this.logger.error('Rate limiter test failed:', error);
      this.recordTest('Rate Limiter', false);
    }
  }

  /**
   * Test Authentication System
   */
  async testAuthentication() {
    console.log('\n🔐 Testing Authentication System...');
    
    try {
      const { OtedamaDB } = await import('../src/database.js');
      const { AuthenticationSystem } = await import('../src/authentication.js');
      
      // Create test database
      const db = new OtedamaDB({ filename: ':memory:', memory: true });
      await db.initialize();
      
      const auth = new AuthenticationSystem(db, {
        jwtSecret: 'test_secret',
        mfaEnabled: false // Disable MFA for basic tests
      });
      await auth.initialize();
      
      // Test 1: User creation
      const userData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'TestPass123!',
        roles: ['miner']
      };
      
      const createResult = await auth.createUser(userData);
      this.recordTest('Auth: User creation', createResult.userId && createResult.username === 'testuser');
      
      // Test 2: Authentication success
      const authResult = await auth.authenticate({
        username: 'testuser',
        password: 'TestPass123!'
      });
      this.recordTest('Auth: Successful login', 
        authResult.success && authResult.session && authResult.session.token);
      
      // Test 3: Authentication failure
      let failAuth = false;
      try {
        await auth.authenticate({
          username: 'testuser',
          password: 'WrongPassword'
        });
      } catch (error) {
        failAuth = true;
      }
      this.recordTest('Auth: Failed login', failAuth);
      
      // Test 4: Token validation
      if (authResult.session) {
        const tokenResult = await auth.validateToken(authResult.session.token);
        this.recordTest('Auth: Token validation', 
          tokenResult.valid && tokenResult.userId === createResult.userId);
      }
      
      // Test 5: Permission checking
      const hasPermission = auth.hasPermission(['miner'], 'mining:submit');
      const noPermission = auth.hasPermission(['miner'], 'admin:manage');
      this.recordTest('Auth: Permission checking', hasPermission && !noPermission);
      
      // Test 6: API key creation
      const apiKeyResult = await auth.createAPIKey(createResult.userId, {
        name: 'Test API Key',
        permissions: ['api:read']
      });
      this.recordTest('Auth: API key creation', apiKeyResult.apiKey && apiKeyResult.keyId);
      
      // Test 7: API key validation
      const apiValidation = await auth.validateAPIKey(apiKeyResult.apiKey);
      this.recordTest('Auth: API key validation', 
        apiValidation.valid && apiValidation.userId === createResult.userId);
      
      await auth.stop();
      await db.close();
      
    } catch (error) {
      this.logger.error('Authentication test failed:', error);
      this.recordTest('Authentication System', false);
    }
  }

  /**
   * Test Integration
   */
  async testSecurityIntegration() {
    console.log('\n🔗 Testing Security Integration...');
    
    try {
      // Test that all components work together
      const { DDoSProtection } = await import('../src/ddos-protection.js');
      const { RateLimiter } = await import('../src/rate-limiter.js');
      
      const ddos = new DDoSProtection();
      const limiter = new RateLimiter();
      
      // Simulate request flow
      const ip = '192.168.1.100';
      const req = { ip };
      
      // First check DDoS
      const ddosResult = await ddos.checkRequest(ip, '/api/stats');
      
      // Then check rate limit
      let rateLimitResult = { allowed: false };
      if (ddosResult.allowed) {
        rateLimitResult = limiter.checkAPILimit(req);
      }
      
      this.recordTest('Security Integration: Request flow', 
        ddosResult.allowed && rateLimitResult.allowed);
      
      ddos.stop();
      limiter.stop();
      
    } catch (error) {
      this.logger.error('Security integration test failed:', error);
      this.recordTest('Security Integration', false);
    }
  }

  /**
   * Record test result
   */
  recordTest(name, passed) {
    this.results.tests.push({ name, passed });
    if (passed) {
      this.results.passed++;
      console.log(`  ✅ ${name}`);
    } else {
      this.results.failed++;
      console.log(`  ❌ ${name}`);
    }
  }

  /**
   * Run all tests
   */
  async runTests() {
    console.log('🔒 Starting Otedama Security Tests...\n');
    
    const startTime = Date.now();
    
    // Run test suites
    await this.testDDoSProtection();
    await this.testRateLimiter();
    await this.testAuthentication();
    await this.testSecurityIntegration();
    
    const duration = Date.now() - startTime;
    
    // Display results
    console.log('\n' + '='.repeat(50));
    console.log('📊 TEST RESULTS');
    console.log('='.repeat(50));
    console.log(`Total Tests: ${this.results.tests.length}`);
    console.log(`Passed: ${this.results.passed} ✅`);
    console.log(`Failed: ${this.results.failed} ❌`);
    console.log(`Duration: ${duration}ms`);
    console.log('='.repeat(50));
    
    if (this.results.failed > 0) {
      console.log('\n❌ FAILED TESTS:');
      this.results.tests
        .filter(t => !t.passed)
        .forEach(t => console.log(`  - ${t.name}`));
    }
    
    console.log('\n' + (this.results.failed === 0 ? '✅ All tests passed!' : '❌ Some tests failed!'));
    
    return this.results.failed === 0;
  }
}

// Run tests if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const tester = new SecurityTestSuite();
  tester.runTests()
    .then(success => process.exit(success ? 0 : 1))
    .catch(error => {
      console.error('Test suite error:', error);
      process.exit(1);
    });
}

export default SecurityTestSuite;
