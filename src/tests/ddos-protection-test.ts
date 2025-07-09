// DDoS Protection Test Script
// Tests the DDoS protection features including rate limiting, IP blocking, and whitelisting

import * as net from 'net';
import { DDoSProtection, ShareThrottler, SynFloodProtection } from '../security/ddos';
import { DDoSProtectionConfig, ShareThrottlerConfig, SynFloodConfig } from '../config/security';

// Test configuration
const testConfig = {
  ddosProtection: {
    maxConnectionsPerIP: 5,         // Lower for testing
    maxTotalConnections: 100,       // Lower for testing
    maxRequestsPerMinute: 60,       // 1 per second for testing
    maxRequestBurst: 5,             // Small burst for testing
    blockDuration: 10000,           // 10 seconds for testing
    autoBlockThreshold: 3,          // Block after 3 violations
    ipReputationEnabled: false,
    geographicFilteringEnabled: false,
    whitelistedIPs: ['127.0.0.1', '192.168.1.100']
  },
  shareThrottler: {
    maxSharesPerSecond: 5,          // Lower for testing
    burstSize: 10,                  // Lower for testing
    penaltyDuration: 5000           // 5 seconds for testing
  },
  synFlood: {
    maxSynPerIP: 5,                 // Lower for testing
    synTimeout: 5000                // 5 seconds for testing
  }
};

// Test class
class DDoSProtectionTest {
  private ddosProtection: DDoSProtection;
  private shareThrottler: ShareThrottler;
  private synFloodProtection: SynFloodProtection;
  
  constructor() {
    this.ddosProtection = new DDoSProtection(testConfig.ddosProtection);
    this.shareThrottler = new ShareThrottler(testConfig.shareThrottler);
    this.synFloodProtection = new SynFloodProtection(testConfig.synFlood);
    
    console.log('DDoS Protection Test initialized with test configuration');
  }
  
  // Test rate limiting
  async testRateLimiting() {
    console.log('\n--- Testing Rate Limiting ---');
    const testIP = '192.168.1.1';
    const iterations = 20; // Try 20 requests
    
    console.log(`Sending ${iterations} requests from ${testIP}...`);
    
    let allowed = 0;
    let blocked = 0;
    
    for (let i = 0; i < iterations; i++) {
      if (this.ddosProtection.checkRateLimit(testIP)) {
        allowed++;
      } else {
        blocked++;
      }
      
      // Small delay between requests
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    console.log(`Results: ${allowed} allowed, ${blocked} blocked`);
    console.log(`Expected: Around ${testConfig.ddosProtection.maxRequestBurst} allowed initially, then rate limited to ${testConfig.ddosProtection.maxRequestsPerMinute / 60} per second`);
    
    return { allowed, blocked };
  }
  
  // Test connection limits
  testConnectionLimits() {
    console.log('\n--- Testing Connection Limits ---');
    const testIP = '192.168.1.2';
    const iterations = 10; // Try 10 connections
    
    console.log(`Creating ${iterations} connections from ${testIP}...`);
    
    let allowed = 0;
    let blocked = 0;
    
    // Mock socket objects
    const sockets: net.Socket[] = [];
    
    for (let i = 0; i < iterations; i++) {
      const socket = new net.Socket();
      // @ts-ignore - Mock the remoteAddress property
      socket.remoteAddress = testIP;
      
      if (this.ddosProtection.canConnect(socket)) {
        this.ddosProtection.addConnection(socket);
        sockets.push(socket);
        allowed++;
      } else {
        blocked++;
      }
    }
    
    console.log(`Results: ${allowed} allowed, ${blocked} blocked`);
    console.log(`Expected: ${testConfig.ddosProtection.maxConnectionsPerIP} allowed, ${iterations - testConfig.ddosProtection.maxConnectionsPerIP} blocked`);
    
    // Cleanup connections
    sockets.forEach(socket => {
      socket.emit('close');
    });
    
    return { allowed, blocked };
  }
  
  // Test whitelist functionality
  testWhitelist() {
    console.log('\n--- Testing Whitelist Functionality ---');
    const whitelistedIP = testConfig.ddosProtection.whitelistedIPs[1]; // Use the non-localhost IP
    const iterations = 20; // Try 20 connections/requests
    
    console.log(`Creating ${iterations} connections from whitelisted IP ${whitelistedIP}...`);
    
    let connectionsAllowed = 0;
    let requestsAllowed = 0;
    
    // Test connections
    for (let i = 0; i < iterations; i++) {
      const socket = new net.Socket();
      // @ts-ignore - Mock the remoteAddress property
      socket.remoteAddress = whitelistedIP;
      
      if (this.ddosProtection.canConnect(socket)) {
        connectionsAllowed++;
      }
    }
    
    // Test requests
    for (let i = 0; i < iterations; i++) {
      if (this.ddosProtection.checkRateLimit(whitelistedIP)) {
        requestsAllowed++;
      }
    }
    
    console.log(`Results: ${connectionsAllowed}/${iterations} connections allowed, ${requestsAllowed}/${iterations} requests allowed`);
    console.log(`Expected: All connections and requests should be allowed for whitelisted IP`);
    
    return { connectionsAllowed, requestsAllowed };
  }
  
  // Test auto-blocking
  async testAutoBlocking() {
    console.log('\n--- Testing Auto-Blocking ---');
    const testIP = '192.168.1.3';
    
    console.log(`Triggering violations from ${testIP}...`);
    
    // Create violations by exceeding connection limits
    for (let i = 0; i < testConfig.ddosProtection.autoBlockThreshold + 1; i++) {
      console.log(`Triggering violation ${i + 1}/${testConfig.ddosProtection.autoBlockThreshold + 1}`);
      
      // Create more connections than allowed to trigger violations
      for (let j = 0; j < testConfig.ddosProtection.maxConnectionsPerIP + 1; j++) {
        const socket = new net.Socket();
        // @ts-ignore - Mock the remoteAddress property
        socket.remoteAddress = testIP;
        
        this.ddosProtection.canConnect(socket);
      }
      
      // Small delay between violation attempts
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Check if IP is blocked
    const socket = new net.Socket();
    // @ts-ignore - Mock the remoteAddress property
    socket.remoteAddress = testIP;
    const isBlocked = !this.ddosProtection.canConnect(socket);
    
    console.log(`IP ${testIP} is ${isBlocked ? 'blocked' : 'not blocked'}`);
    console.log(`Expected: IP should be blocked after ${testConfig.ddosProtection.autoBlockThreshold} violations`);
    
    // Wait for auto-unblock
    console.log(`Waiting ${testConfig.ddosProtection.blockDuration / 1000} seconds for auto-unblock...`);
    await new Promise(resolve => setTimeout(resolve, testConfig.ddosProtection.blockDuration + 500));
    
    // Check if IP is unblocked
    const socket2 = new net.Socket();
    // @ts-ignore - Mock the remoteAddress property
    socket2.remoteAddress = testIP;
    const isUnblocked = this.ddosProtection.canConnect(socket2);
    
    console.log(`After waiting, IP ${testIP} is ${isUnblocked ? 'unblocked' : 'still blocked'}`);
    console.log(`Expected: IP should be unblocked after ${testConfig.ddosProtection.blockDuration / 1000} seconds`);
    
    return { initiallyBlocked: isBlocked, laterUnblocked: isUnblocked };
  }
  
  // Test share throttling
  async testShareThrottling() {
    console.log('\n--- Testing Share Throttling ---');
    const testMinerId = 'test-miner-123';
    const iterations = 20; // Try 20 share submissions
    
    console.log(`Submitting ${iterations} shares from miner ${testMinerId}...`);
    
    let allowed = 0;
    let blocked = 0;
    
    for (let i = 0; i < iterations; i++) {
      if (this.shareThrottler.canSubmitShare(testMinerId)) {
        allowed++;
      } else {
        blocked++;
      }
      
      // Small delay between submissions
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    console.log(`Results: ${allowed} allowed, ${blocked} blocked`);
    console.log(`Expected: Around ${testConfig.shareThrottler.burstSize} allowed initially, then rate limited`);
    
    // Test penalty expiration
    console.log(`Waiting ${testConfig.shareThrottler.penaltyDuration / 1000} seconds for penalty to expire...`);
    await new Promise(resolve => setTimeout(resolve, testConfig.shareThrottler.penaltyDuration + 500));
    
    const canSubmitAfterWaiting = this.shareThrottler.canSubmitShare(testMinerId);
    console.log(`After waiting, miner can submit: ${canSubmitAfterWaiting}`);
    console.log(`Expected: Miner should be able to submit again after penalty expires`);
    
    return { allowed, blocked, canSubmitAfterWaiting };
  }
  
  // Test SYN flood protection
  testSynFloodProtection() {
    console.log('\n--- Testing SYN Flood Protection ---');
    const testIP = '192.168.1.4';
    const iterations = 10; // Try 10 SYN packets
    
    console.log(`Sending ${iterations} SYN packets from ${testIP}...`);
    
    let allowed = 0;
    let blocked = 0;
    
    for (let i = 0; i < iterations; i++) {
      if (this.synFloodProtection.checkSyn(testIP)) {
        allowed++;
      } else {
        blocked++;
      }
    }
    
    console.log(`Results: ${allowed} allowed, ${blocked} blocked`);
    console.log(`Expected: ${testConfig.synFlood.maxSynPerIP} allowed, ${iterations - testConfig.synFlood.maxSynPerIP} blocked`);
    
    // Complete some SYNs to simulate established connections
    for (let i = 0; i < 3; i++) {
      this.synFloodProtection.completeSyn(testIP);
    }
    
    // Try one more
    const canSendMoreSyn = this.synFloodProtection.checkSyn(testIP);
    console.log(`After completing 3 SYNs, can send more: ${canSendMoreSyn}`);
    console.log(`Expected: Should be able to send more SYNs after completing some`);
    
    return { allowed, blocked, canSendMoreSyn };
  }
  
  // Run all tests
  async runAllTests() {
    console.log('=== Starting DDoS Protection Tests ===');
    
    await this.testRateLimiting();
    this.testConnectionLimits();
    this.testWhitelist();
    await this.testAutoBlocking();
    await this.testShareThrottling();
    this.testSynFloodProtection();
    
    console.log('\n=== DDoS Protection Tests Completed ===');
    
    // Cleanup
    this.ddosProtection.shutdown();
    this.shareThrottler.shutdown();
    this.synFloodProtection.shutdown();
  }
}

// Run the tests
const tester = new DDoSProtectionTest();
tester.runAllTests().catch(err => {
  console.error('Test error:', err);
});
