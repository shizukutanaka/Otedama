/**
 * Security Module Tests
 */

import { test, describe, assert, assertEqual, assertDeepEqual } from './test-runner.js';
import { 
  rateLimit, 
  sanitize, 
  password, 
  session, 
  csrf,
  apiKey,
  signing,
  IPFilter,
  twoFactor
} from '../lib/security/index.js';

export async function run(results) {
  describe('Security Module Tests', () => {
    
    describe('Rate Limiting', () => {
      test('should allow requests within limit', async () => {
        const result = rateLimit('test-ip', 5);
        assert(result.allowed, 'First request should be allowed');
        assertEqual(result.remaining, 4, 'Should have 4 requests remaining');
      });
      
      test('should block requests exceeding limit', async () => {
        // Exhaust rate limit
        for (let i = 0; i < 5; i++) {
          rateLimit('test-ip-2', 5);
        }
        
        const result = rateLimit('test-ip-2', 5);
        assert(!result.allowed, 'Request should be blocked');
        assertEqual(result.remaining, 0, 'Should have 0 requests remaining');
        assert(result.retryAfter > 0, 'Should provide retry after time');
      });
    });
    
    describe('Input Sanitization', () => {
      test('should sanitize SQL injection attempts', async () => {
        const input = "'; DROP TABLE users; --";
        const sanitized = sanitize.sql(input);
        assert(!sanitized.includes('DROP'), 'Should remove SQL keywords');
        assert(!sanitized.includes("'"), 'Should remove quotes');
      });
      
      test('should sanitize XSS attempts', async () => {
        const input = '<script>alert("XSS")</script>';
        const sanitized = sanitize.html(input);
        assert(!sanitized.includes('<script>'), 'Should escape script tags');
        assert(sanitized.includes('&lt;'), 'Should convert < to &lt;');
      });
      
      test('should validate wallet addresses', async () => {
        const btcAddress = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
        const validBtc = sanitize.wallet(btcAddress, 'BTC');
        assertEqual(validBtc, btcAddress, 'Valid BTC address should pass');
        
        const invalidBtc = sanitize.wallet('invalid-address', 'BTC');
        assertEqual(invalidBtc, null, 'Invalid address should return null');
      });
      
      test('should sanitize numbers', async () => {
        assertEqual(sanitize.number('123', 0, 1000), 123);
        assertEqual(sanitize.number('abc', 0, 1000), null);
        assertEqual(sanitize.number('1500', 0, 1000), null);
        assertEqual(sanitize.number('-5', 0, 1000), null);
      });
    });
    
    describe('Password Hashing', () => {
      test('should hash passwords securely', async () => {
        const plainPassword = 'SecurePassword123!';
        const hash = password.hash(plainPassword);
        
        assert(hash.includes(':'), 'Hash should contain salt separator');
        assert(hash.length > 100, 'Hash should be sufficiently long');
      });
      
      test('should verify correct passwords', async () => {
        const plainPassword = 'TestPassword456@';
        const hash = password.hash(plainPassword);
        
        assert(password.verify(plainPassword, hash), 'Should verify correct password');
        assert(!password.verify('WrongPassword', hash), 'Should reject wrong password');
      });
    });
    
    describe('JWT Session Management', () => {
      test('should create valid session tokens', async () => {
        const token = session.create('user123', { role: 'miner' });
        assert(typeof token === 'string', 'Token should be a string');
        assert(token.split('.').length === 3, 'JWT should have 3 parts');
      });
      
      test('should verify valid tokens', async () => {
        const userId = 'user456';
        const token = session.create(userId, { currency: 'BTC' });
        const decoded = session.verify(token);
        
        assert(decoded !== null, 'Should decode valid token');
        assertEqual(decoded.userId, userId, 'Should contain correct userId');
        assertEqual(decoded.currency, 'BTC', 'Should contain additional data');
      });
      
      test('should reject invalid tokens', async () => {
        const decoded = session.verify('invalid.token.here');
        assertEqual(decoded, null, 'Should return null for invalid token');
      });
      
      test('should refresh tokens', async () => {
        const originalToken = session.create('user789', { data: 'test' });
        const refreshedToken = session.refresh(originalToken);
        
        assert(refreshedToken !== null, 'Should refresh valid token');
        assert(refreshedToken !== originalToken, 'Should generate new token');
        
        const decoded = session.verify(refreshedToken);
        assertEqual(decoded.userId, 'user789', 'Should maintain userId');
        assertEqual(decoded.data, 'test', 'Should maintain additional data');
      });
    });
    
    describe('CSRF Protection', () => {
      test('should generate unique CSRF tokens', async () => {
        const token1 = csrf.generate('session1');
        const token2 = csrf.generate('session2');
        
        assert(token1 !== token2, 'Tokens should be unique');
        assert(token1.length === 64, 'Token should be 32 bytes hex');
      });
      
      test('should verify valid CSRF tokens', async () => {
        const sessionId = 'session123';
        const token = csrf.generate(sessionId);
        
        assert(csrf.verify(sessionId, token), 'Should verify valid token');
        assert(!csrf.verify(sessionId, 'wrong-token'), 'Should reject invalid token');
        assert(!csrf.verify('wrong-session', token), 'Should reject wrong session');
      });
    });
    
    describe('API Key Management', () => {
      test('should generate secure API keys', async () => {
        const key1 = apiKey.generate();
        const key2 = apiKey.generate();
        
        assert(key1 !== key2, 'Keys should be unique');
        assertEqual(key1.length, 64, 'Key should be 32 bytes hex');
      });
      
      test('should hash and verify API keys', async () => {
        const key = apiKey.generate();
        const hashed = apiKey.hash(key);
        
        assert(apiKey.verify(key, hashed), 'Should verify correct key');
        assert(!apiKey.verify('wrong-key', hashed), 'Should reject wrong key');
      });
    });
    
    describe('Request Signing', () => {
      test('should sign requests', async () => {
        const data = { action: 'payout', amount: 0.001 };
        const secret = 'secret-key';
        const signed = signing.sign(data, secret);
        
        assert(signed.timestamp, 'Should include timestamp');
        assert(signed.signature, 'Should include signature');
        assert(signed.payload, 'Should include payload');
      });
      
      test('should verify valid signatures', async () => {
        const data = { test: 'data' };
        const secret = 'secret-key';
        const signed = signing.sign(data, secret);
        
        const result = signing.verify(signed, secret);
        assert(result.valid, 'Should verify valid signature');
        assertDeepEqual(result.data, data, 'Should return original data');
      });
      
      test('should reject expired signatures', async () => {
        const data = { test: 'data' };
        const secret = 'secret-key';
        const signed = signing.sign(data, secret);
        
        // Modify timestamp to be expired
        signed.timestamp = Date.now() - 400000; // 6+ minutes ago
        
        const result = signing.verify(signed, secret, 300000); // 5 minute max age
        assert(!result.valid, 'Should reject expired signature');
        assertEqual(result.reason, 'Request expired');
      });
    });
    
    describe('IP Filtering', () => {
      test('should manage whitelist and blacklist', async () => {
        const filter = new IPFilter();
        
        // Test default behavior (allow all)
        assert(filter.isAllowed('192.168.1.1'), 'Should allow by default');
        
        // Test blacklist
        filter.addToBlacklist('10.0.0.1');
        assert(!filter.isAllowed('10.0.0.1'), 'Should block blacklisted IP');
        assert(filter.isAllowed('10.0.0.2'), 'Should allow non-blacklisted IP');
        
        // Test whitelist (exclusive)
        filter.addToWhitelist('172.16.0.1');
        assert(filter.isAllowed('172.16.0.1'), 'Should allow whitelisted IP');
        assert(!filter.isAllowed('172.16.0.2'), 'Should block non-whitelisted IP when whitelist exists');
        
        // Test removal
        filter.removeFromBlacklist('10.0.0.1');
        filter.removeFromWhitelist('172.16.0.1');
        assert(filter.isAllowed('10.0.0.1'), 'Should allow after removing from blacklist');
      });
    });
    
    describe('Two-Factor Authentication', () => {
      test('should generate TOTP codes', async () => {
        const secret = twoFactor.generateSecret();
        const code1 = twoFactor.generateCode(secret);
        const code2 = twoFactor.generateCode(secret, 1); // Next window
        
        assertEqual(code1.length, 6, 'Code should be 6 digits');
        assert(/^\d{6}$/.test(code1), 'Code should be numeric');
        assert(code1 !== code2, 'Different windows should generate different codes');
      });
      
      test('should verify valid TOTP codes', async () => {
        const secret = twoFactor.generateSecret();
        const code = twoFactor.generateCode(secret);
        
        assert(twoFactor.verifyCode(secret, code), 'Should verify current code');
        assert(!twoFactor.verifyCode(secret, '000000'), 'Should reject invalid code');
      });
    });
  });
}