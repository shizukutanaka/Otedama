/**
 * Unit tests for EnhancedRateLimiter
 * Tests multiple rate limiting algorithms and system load adaptation
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { 
  EnhancedRateLimiter, 
  getRateLimiter, 
  RateLimitAlgorithm, 
  RateLimitType 
} from '../lib/security/enhanced-rate-limiter.js';

describe('EnhancedRateLimiter', () => {
  let rateLimiter;

  beforeEach(() => {
    rateLimiter = new EnhancedRateLimiter({
      cleanupInterval: 100, // Fast cleanup for testing
      enableSystemLoadTracking: false // Disable for deterministic tests
    });
  });

  afterEach(async () => {
    if (rateLimiter) {
      rateLimiter.stop();
    }
    // Wait a bit for cleanup
    await new Promise(resolve => setTimeout(resolve, 50));
  });

  describe('Sliding Window Rate Limiter', () => {
    beforeEach(() => {
      rateLimiter.addLimit('sliding_test', {
        type: RateLimitType.IP,
        algorithm: RateLimitAlgorithm.SLIDING_WINDOW,
        limit: 5,
        windowMs: 1000
      });
    });

    it('should allow requests within limit', async () => {
      for (let i = 0; i < 5; i++) {
        const result = await rateLimiter.checkLimit('sliding_test', '192.168.1.1');
        expect(result.allowed).to.be.true;
        expect(result.remaining).to.equal(4 - i);
      }
    });

    it('should reject requests exceeding limit', async () => {
      // Fill up the limit
      for (let i = 0; i < 5; i++) {
        await rateLimiter.checkLimit('sliding_test', '192.168.1.1');
      }

      // Next request should be rejected
      const result = await rateLimiter.checkLimit('sliding_test', '192.168.1.1');
      expect(result.allowed).to.be.false;
      expect(result.remaining).to.equal(0);
      expect(result.retryAfter).to.be.a('number');
    });

    it('should reset after window expires', async () => {
      // Fill up the limit
      for (let i = 0; i < 5; i++) {
        await rateLimiter.checkLimit('sliding_test', '192.168.1.1');
      }

      // Should be blocked
      let result = await rateLimiter.checkLimit('sliding_test', '192.168.1.1');
      expect(result.allowed).to.be.false;

      // Wait for window to expire
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Should be allowed again
      result = await rateLimiter.checkLimit('sliding_test', '192.168.1.1');
      expect(result.allowed).to.be.true;
    });

    it('should handle different keys independently', async () => {
      // Fill limit for first IP
      for (let i = 0; i < 5; i++) {
        await rateLimiter.checkLimit('sliding_test', '192.168.1.1');
      }

      // Second IP should still be allowed
      const result = await rateLimiter.checkLimit('sliding_test', '192.168.1.2');
      expect(result.allowed).to.be.true;
    });

    it('should maintain accurate sliding window', async () => {
      const requests = [];
      
      // Make requests at specific times
      for (let i = 0; i < 3; i++) {
        requests.push(await rateLimiter.checkLimit('sliding_test', '192.168.1.1'));
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      // All should be allowed
      requests.forEach(result => {
        expect(result.allowed).to.be.true;
      });

      // Wait for first requests to fall outside window
      await new Promise(resolve => setTimeout(resolve, 500));

      // Should allow more requests as old ones expired
      const newResult = await rateLimiter.checkLimit('sliding_test', '192.168.1.1');
      expect(newResult.allowed).to.be.true;
    });
  });

  describe('Token Bucket Rate Limiter', () => {
    beforeEach(() => {
      rateLimiter.addLimit('bucket_test', {
        type: RateLimitType.USER,
        algorithm: RateLimitAlgorithm.TOKEN_BUCKET,
        capacity: 10,
        refillRate: 2,
        refillPeriod: 1000
      });
    });

    it('should allow burst up to capacity', async () => {
      for (let i = 0; i < 10; i++) {
        const result = await rateLimiter.checkLimit('bucket_test', 'user1');
        expect(result.allowed).to.be.true;
        expect(result.remaining).to.equal(9 - i);
      }
    });

    it('should reject when bucket is empty', async () => {
      // Consume all tokens
      for (let i = 0; i < 10; i++) {
        await rateLimiter.checkLimit('bucket_test', 'user1');
      }

      // Should be rejected
      const result = await rateLimiter.checkLimit('bucket_test', 'user1');
      expect(result.allowed).to.be.false;
      expect(result.remaining).to.equal(0);
      expect(result.retryAfter).to.be.a('number');
    });

    it('should refill tokens over time', async () => {
      // Consume all tokens
      for (let i = 0; i < 10; i++) {
        await rateLimiter.checkLimit('bucket_test', 'user1');
      }

      // Wait for refill (2 tokens per second)
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Should have 2 new tokens
      let result = await rateLimiter.checkLimit('bucket_test', 'user1');
      expect(result.allowed).to.be.true;

      result = await rateLimiter.checkLimit('bucket_test', 'user1');
      expect(result.allowed).to.be.true;

      // Third should be rejected
      result = await rateLimiter.checkLimit('bucket_test', 'user1');
      expect(result.allowed).to.be.false;
    });

    it('should handle variable cost requests', async () => {
      const result1 = await rateLimiter.checkLimit('bucket_test', 'user1', { cost: 5 });
      expect(result1.allowed).to.be.true;
      expect(result1.remaining).to.equal(5);

      const result2 = await rateLimiter.checkLimit('bucket_test', 'user1', { cost: 6 });
      expect(result2.allowed).to.be.false; // Not enough tokens
    });

    it('should not exceed capacity during refill', async () => {
      // Start with full bucket, wait for refill period
      await new Promise(resolve => setTimeout(resolve, 1100));

      const result = await rateLimiter.checkLimit('bucket_test', 'user1');
      expect(result.remaining).to.be.at.most(9); // Should not exceed capacity-1
    });
  });

  describe('Adaptive Rate Limiter', () => {
    beforeEach(() => {
      rateLimiter = new EnhancedRateLimiter({
        enableSystemLoadTracking: true,
        cleanupInterval: 100
      });

      rateLimiter.addLimit('adaptive_test', {
        type: RateLimitType.USER,
        algorithm: RateLimitAlgorithm.ADAPTIVE,
        limit: 10,
        windowMs: 1000
      });
    });

    it('should adjust limits based on trust score', async () => {
      // New user starts with neutral trust (50), so gets base limit
      const result1 = await rateLimiter.checkLimit('adaptive_test', 'newuser');
      expect(result1.allowed).to.be.true;
      expect(result1.adaptiveLimit).to.equal(10); // Base limit

      // After good behavior, trust should improve
      for (let i = 0; i < 3; i++) {
        await rateLimiter.checkLimit('adaptive_test', 'gooduser');
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      const result2 = await rateLimiter.checkLimit('adaptive_test', 'gooduser');
      expect(result2.trustScore).to.be.greaterThan(50);
    });

    it('should penalize violations', async () => {
      // Fill up the limit to trigger violation
      for (let i = 0; i < 10; i++) {
        await rateLimiter.checkLimit('adaptive_test', 'baduser');
      }

      // Trigger violation
      const violationResult = await rateLimiter.checkLimit('adaptive_test', 'baduser');
      expect(violationResult.allowed).to.be.false;
      expect(violationResult.trustScore).to.be.lessThan(50);

      // Wait for window reset
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Should have reduced limit due to lower trust score
      const reducedResult = await rateLimiter.checkLimit('adaptive_test', 'baduser');
      expect(reducedResult.adaptiveLimit).to.be.lessThan(10);
    });

    it('should respond to system load', async () => {
      // Simulate high system load
      rateLimiter.systemLoad = 0.8; // 80% load

      // Update the adaptive limiter with high load
      for (const [name, { limiter, algorithm }] of rateLimiter.limits) {
        if (algorithm === RateLimitAlgorithm.ADAPTIVE) {
          limiter.updateSystemLoad(0.8);
        }
      }

      const result = await rateLimiter.checkLimit('adaptive_test', 'user1');
      expect(result.adaptiveLimit).to.be.lessThan(10); // Should be reduced due to high load
    });

    it('should track user profiles', async () => {
      const result1 = await rateLimiter.checkLimit('adaptive_test', 'tracked_user');
      expect(result1.trustScore).to.equal(50); // Initial trust score

      // Make several requests
      for (let i = 0; i < 3; i++) {
        await rateLimiter.checkLimit('adaptive_test', 'tracked_user');
      }

      const result2 = await rateLimiter.checkLimit('adaptive_test', 'tracked_user');
      expect(result2.trustScore).to.be.a('number');
      expect(result2.adaptiveLimit).to.be.a('number');
    });
  });

  describe('Multiple Rate Limits', () => {
    beforeEach(() => {
      rateLimiter.addLimit('api_general', {
        type: RateLimitType.IP,
        algorithm: RateLimitAlgorithm.SLIDING_WINDOW,
        limit: 100,
        windowMs: 60000
      });

      rateLimiter.addLimit('api_specific', {
        type: RateLimitType.USER,
        algorithm: RateLimitAlgorithm.TOKEN_BUCKET,
        capacity: 10,
        refillRate: 2,
        refillPeriod: 1000
      });
    });

    it('should check multiple limits simultaneously', async () => {
      const result = await rateLimiter.checkMultipleLimits(
        ['api_general', 'api_specific'], 
        'testkey'
      );

      expect(result.allowed).to.be.true;
      expect(result.results).to.have.lengthOf(2);
      expect(result.limitNames).to.include.members(['api_general', 'api_specific']);
    });

    it('should block if any limit is exceeded', async () => {
      // Exhaust the token bucket
      for (let i = 0; i < 10; i++) {
        await rateLimiter.checkLimit('api_specific', 'testkey');
      }

      const result = await rateLimiter.checkMultipleLimits(
        ['api_general', 'api_specific'], 
        'testkey'
      );

      expect(result.allowed).to.be.false;
      expect(result.retryAfter).to.be.greaterThan(0);
    });

    it('should return minimum remaining across all limits', async () => {
      // Use some tokens from bucket
      for (let i = 0; i < 7; i++) {
        await rateLimiter.checkLimit('api_specific', 'testkey');
      }

      const result = await rateLimiter.checkMultipleLimits(
        ['api_general', 'api_specific'], 
        'testkey'
      );

      expect(result.remaining).to.equal(3); // Token bucket has 3 remaining, sliding window has more
    });
  });

  describe('Rate Limit Management', () => {
    beforeEach(() => {
      rateLimiter.addLimit('management_test', {
        type: RateLimitType.IP,
        algorithm: RateLimitAlgorithm.SLIDING_WINDOW,
        limit: 5,
        windowMs: 1000
      });
    });

    it('should get rate limit status', async () => {
      // Make some requests
      await rateLimiter.checkLimit('management_test', '192.168.1.1');
      await rateLimiter.checkLimit('management_test', '192.168.1.1');

      const status = await rateLimiter.getStatus('management_test', '192.168.1.1');
      
      expect(status).to.be.an('object');
      expect(status.limitName).to.equal('management_test');
      expect(status.algorithm).to.equal(RateLimitAlgorithm.SLIDING_WINDOW);
      expect(status.status).to.have.property('remaining');
      expect(status.stats).to.have.property('requests');
    });

    it('should reset rate limits', async () => {
      // Fill up the limit
      for (let i = 0; i < 5; i++) {
        await rateLimiter.checkLimit('management_test', '192.168.1.1');
      }

      // Should be blocked
      let result = await rateLimiter.checkLimit('management_test', '192.168.1.1');
      expect(result.allowed).to.be.false;

      // Reset the limit
      const resetResult = rateLimiter.resetLimit('management_test', '192.168.1.1');
      expect(resetResult).to.be.true;

      // Should be allowed again
      result = await rateLimiter.checkLimit('management_test', '192.168.1.1');
      expect(result.allowed).to.be.true;
    });

    it('should handle non-existent limits gracefully', async () => {
      const result = await rateLimiter.checkLimit('nonexistent', 'key');
      expect(result.allowed).to.be.true;
      expect(result.remaining).to.equal(Infinity);

      const status = await rateLimiter.getStatus('nonexistent', 'key');
      expect(status).to.be.null;

      const resetResult = rateLimiter.resetLimit('nonexistent', 'key');
      expect(resetResult).to.be.false;
    });
  });

  describe('Statistics and Monitoring', () => {
    beforeEach(() => {
      rateLimiter.addLimit('stats_test', {
        type: RateLimitType.IP,
        algorithm: RateLimitAlgorithm.SLIDING_WINDOW,
        limit: 5,
        windowMs: 1000
      });
    });

    it('should track global statistics', async () => {
      // Make some requests (allowed)
      for (let i = 0; i < 3; i++) {
        await rateLimiter.checkLimit('stats_test', '192.168.1.1');
      }

      // Make requests that will be denied
      for (let i = 0; i < 3; i++) {
        await rateLimiter.checkLimit('stats_test', '192.168.1.1');
      }

      const stats = rateLimiter.getGlobalStats();
      
      expect(stats).to.have.property('limits');
      expect(stats.limits).to.have.property('stats_test');
      expect(stats.limits.stats_test.requests).to.equal(6);
      expect(stats.limits.stats_test.allowed).to.equal(5);
      expect(stats.limits.stats_test.denied).to.equal(1);
      expect(stats.limits.stats_test.successRate).to.be.a('string');
      expect(parseFloat(stats.limits.stats_test.successRate)).to.be.closeTo(83.33, 0.1);
    });

    it('should track system metrics when enabled', () => {
      const systemTrackingLimiter = new EnhancedRateLimiter({
        enableSystemLoadTracking: true,
        cleanupInterval: 100
      });

      const stats = systemTrackingLimiter.getGlobalStats();
      expect(stats).to.have.property('system');
      expect(stats.system).to.have.property('load');
      expect(stats.system).to.have.property('cpuUsage');
      expect(stats.system).to.have.property('memoryUsage');

      systemTrackingLimiter.stop();
    });

    it('should provide limit configuration info', async () => {
      const stats = rateLimiter.getGlobalStats();
      expect(stats.totalLimits).to.equal(1);
    });
  });

  describe('Event Emissions', () => {
    beforeEach(() => {
      rateLimiter.addLimit('event_test', {
        type: RateLimitType.IP,
        algorithm: RateLimitAlgorithm.SLIDING_WINDOW,
        limit: 2,
        windowMs: 1000
      });
    });

    it('should emit events on limit exceeded', (done) => {
      rateLimiter.on('limit:exceeded', (data) => {
        expect(data).to.have.property('limitName');
        expect(data).to.have.property('key');
        expect(data).to.have.property('algorithm');
        expect(data).to.have.property('result');
        expect(data.limitName).to.equal('event_test');
        done();
      });

      // Fill up the limit and trigger event
      rateLimiter.checkLimit('event_test', '192.168.1.1')
        .then(() => rateLimiter.checkLimit('event_test', '192.168.1.1'))
        .then(() => rateLimiter.checkLimit('event_test', '192.168.1.1'));
    });

    it('should emit cleanup events', (done) => {
      rateLimiter.on('cleanup:completed', (data) => {
        expect(data).to.have.property('timestamp');
        expect(data).to.have.property('limitsProcessed');
        expect(data.limitsProcessed).to.be.a('number');
        done();
      });

      // Wait for cleanup to run
    });

    it('should emit system monitoring events when enabled', (done) => {
      const systemLimiter = new EnhancedRateLimiter({
        enableSystemLoadTracking: true,
        cleanupInterval: 100
      });

      systemLimiter.on('system:monitored', (data) => {
        expect(data).to.have.property('load');
        expect(data).to.have.property('cpu');
        expect(data).to.have.property('memory');
        systemLimiter.stop();
        done();
      });
    });
  });

  describe('Key Generation', () => {
    beforeEach(() => {
      rateLimiter.addLimit('key_test', {
        type: RateLimitType.IP,
        algorithm: RateLimitAlgorithm.SLIDING_WINDOW,
        limit: 5,
        windowMs: 1000
      });
    });

    it('should generate correct keys for different types', () => {
      expect(rateLimiter.generateKey(RateLimitType.IP, '192.168.1.1', 'test')).to.equal('ip:192.168.1.1');
      expect(rateLimiter.generateKey(RateLimitType.USER, 'user123', 'test')).to.equal('user:user123');
      expect(rateLimiter.generateKey(RateLimitType.ENDPOINT, 'api_key', 'test')).to.equal('endpoint:test:api_key');
      expect(rateLimiter.generateKey(RateLimitType.GLOBAL, 'anything', 'test')).to.equal('global:test');
      expect(rateLimiter.generateKey('custom', 'value', 'test')).to.equal('custom:custom:value');
    });

    it('should use generated keys for rate limiting', async () => {
      const ipResult1 = await rateLimiter.checkLimit('key_test', '192.168.1.1');
      const ipResult2 = await rateLimiter.checkLimit('key_test', '192.168.1.2');

      expect(ipResult1.key).to.equal('ip:192.168.1.1');
      expect(ipResult2.key).to.equal('ip:192.168.1.2');
    });
  });

  describe('Cleanup and Memory Management', () => {
    it('should cleanup expired data', async () => {
      rateLimiter.addLimit('cleanup_test', {
        type: RateLimitType.IP,
        algorithm: RateLimitAlgorithm.SLIDING_WINDOW,
        limit: 5,
        windowMs: 100 // Very short window
      });

      // Make requests
      await rateLimiter.checkLimit('cleanup_test', '192.168.1.1');
      await rateLimiter.checkLimit('cleanup_test', '192.168.1.2');

      // Wait for cleanup
      await new Promise(resolve => setTimeout(resolve, 200));

      // Data should be cleaned up (we can't directly verify internal state,
      // but we can verify that the limiter still works correctly)
      const result = await rateLimiter.checkLimit('cleanup_test', '192.168.1.1');
      expect(result.allowed).to.be.true;
    });

    it('should stop all intervals on shutdown', async () => {
      const limiter = new EnhancedRateLimiter({
        enableSystemLoadTracking: true,
        cleanupInterval: 50
      });

      limiter.addLimit('shutdown_test', {
        algorithm: RateLimitAlgorithm.SLIDING_WINDOW,
        limit: 5,
        windowMs: 1000
      });

      // Make a request to initialize
      await limiter.checkLimit('shutdown_test', 'test');

      // Stop should not throw
      expect(() => limiter.stop()).to.not.throw();

      // Should emit stopped event
      let stoppedEmitted = false;
      limiter.on('stopped', () => {
        stoppedEmitted = true;
      });

      limiter.stop();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(stoppedEmitted).to.be.true;
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid configurations gracefully', () => {
      expect(() => {
        rateLimiter.addLimit('invalid', {
          algorithm: 'nonexistent_algorithm',
          limit: 10
        });
      }).to.not.throw();
    });

    it('should handle system monitoring errors gracefully', async () => {
      const limiter = new EnhancedRateLimiter({
        enableSystemLoadTracking: true,
        cleanupInterval: 50
      });

      // Monitoring should not crash on errors
      await new Promise(resolve => setTimeout(resolve, 100));
      
      limiter.stop();
    });

    it('should handle cleanup errors gracefully', async () => {
      // Cleanup should not crash even if there are internal errors
      await new Promise(resolve => setTimeout(resolve, 150));
    });
  });
});

describe('Rate Limiter Singleton', () => {
  afterEach(() => {
    // Clean up singleton
    const limiter = getRateLimiter();
    if (limiter) {
      limiter.stop();
    }
  });

  it('should return same instance', () => {
    const limiter1 = getRateLimiter();
    const limiter2 = getRateLimiter();
    expect(limiter1).to.equal(limiter2);
  });

  it('should have pre-configured limits', async () => {
    const limiter = getRateLimiter();
    
    // Should have common limits pre-configured
    const apiResult = await limiter.checkLimit('api:general', '192.168.1.1');
    expect(apiResult).to.have.property('allowed');
    
    const authResult = await limiter.checkLimit('auth:login', '192.168.1.1');
    expect(authResult).to.have.property('allowed');
    
    const tradingResult = await limiter.checkLimit('trading:orders', 'user123');
    expect(tradingResult).to.have.property('allowed');
    
    const miningResult = await limiter.checkLimit('mining:shares', '192.168.1.1');
    expect(miningResult).to.have.property('allowed');
  });

  it('should maintain state across calls', async () => {
    const limiter1 = getRateLimiter();
    await limiter1.checkLimit('api:general', '192.168.1.1');
    
    const limiter2 = getRateLimiter();
    const stats = limiter2.getGlobalStats();
    expect(stats.limits['api:general'].requests).to.be.greaterThan(0);
  });
});