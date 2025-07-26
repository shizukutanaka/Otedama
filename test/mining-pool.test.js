/**
 * Mining Pool Test Suite - Otedama
 * Comprehensive tests for commercial-grade mining pool
 * 
 * Design Principles:
 * - Martin: Thorough testing of all components
 * - Pike: Simple, readable test cases
 * - Carmack: Performance benchmarks included
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { P2PMiningPool } from '../lib/core/p2p-mining-pool.js';
import { LightweightMiningClient } from '../lib/mining/lightweight-mining-client.js';
import { StratumServer } from '../lib/network/stratum-server.js';
import { ZKPAuthIntegration } from '../lib/auth/zkp-auth-integration.js';
import crypto from 'crypto';

describe('P2P Mining Pool - Commercial Grade Tests', () => {
  let pool;
  let client;
  
  beforeEach(async () => {
    pool = new P2PMiningPool({
      name: 'Test Pool',
      algorithm: 'sha256',
      difficulty: 1024,
      zkpEnabled: true,
      workerThreads: 2,
      stratumPort: 13333
    });
  });
  
  afterEach(async () => {
    if (pool) {
      await pool.shutdown();
    }
    if (client) {
      await client.shutdown();
    }
  });
  
  describe('Core Functionality', () => {
    it('should initialize pool with all components', async () => {
      await pool.initialize();
      
      expect(pool.networkState).toBe('running');
      expect(pool.zkpSystem).toBeTruthy();
      expect(pool.stratumServer).toBeTruthy();
      expect(pool.workerPool).toBeTruthy();
    });
    
    it('should handle multiple concurrent connections', async () => {
      await pool.initialize();
      
      const clients = [];
      const connectionPromises = [];
      
      // Create 100 concurrent connections
      for (let i = 0; i < 100; i++) {
        const client = new LightweightMiningClient({
          poolHost: 'localhost',
          poolPort: 13333,
          minerAddress: `miner_${i}`,
          zkpEnabled: true
        });
        
        clients.push(client);
        connectionPromises.push(client.initialize());
      }
      
      await Promise.all(connectionPromises);
      
      expect(pool.miners.size).toBe(100);
      
      // Cleanup
      for (const client of clients) {
        await client.shutdown();
      }
    });
    
    it('should validate shares correctly', async () => {
      await pool.initialize();
      
      const shareData = {
        nonce: 12345,
        blockHeader: '0'.repeat(160),
        difficulty: 1024,
        algorithm: 'sha256'
      };
      
      const result = await pool.validateShare(shareData, 1024);
      
      expect(result).toHaveProperty('valid');
      expect(typeof result.valid).toBe('boolean');
    });
  });
  
  describe('Performance Tests', () => {
    it('should handle high share submission rate', async () => {
      await pool.initialize();
      
      const connection = {
        id: 'test_miner',
        minerAddress: 'test_address'
      };
      
      pool.miners.set(connection.id, {
        id: connection.id,
        address: connection.minerAddress,
        difficulty: 1024,
        shares: 0,
        lastShare: 0,
        hashrate: 0,
        connected: Date.now()
      });
      
      const startTime = Date.now();
      const sharePromises = [];
      
      // Submit 1000 shares
      for (let i = 0; i < 1000; i++) {
        const shareData = {
          nonce: i,
          blockHeader: crypto.randomBytes(80).toString('hex'),
          difficulty: 1024
        };
        
        sharePromises.push(pool.handleShare(connection, shareData));
      }
      
      const results = await Promise.all(sharePromises);
      const duration = Date.now() - startTime;
      
      const acceptedShares = results.filter(r => r.accepted).length;
      const sharesPerSecond = 1000 / (duration / 1000);
      
      console.log(`Share processing rate: ${sharesPerSecond.toFixed(2)} shares/sec`);
      
      expect(sharesPerSecond).toBeGreaterThan(100); // Should handle >100 shares/sec
      expect(acceptedShares).toBeGreaterThan(0);
    });
    
    it('should maintain performance under load', async () => {
      await pool.initialize();
      
      const metrics = [];
      const testDuration = 5000; // 5 seconds
      const startTime = Date.now();
      
      while (Date.now() - startTime < testDuration) {
        const metric = {
          timestamp: Date.now(),
          miners: pool.miners.size,
          hashrate: pool.metrics.hashrate,
          memory: process.memoryUsage().heapUsed / 1024 / 1024 // MB
        };
        
        metrics.push(metric);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      // Check memory doesn't grow excessively
      const initialMemory = metrics[0].memory;
      const finalMemory = metrics[metrics.length - 1].memory;
      const memoryGrowth = finalMemory - initialMemory;
      
      expect(memoryGrowth).toBeLessThan(50); // Less than 50MB growth
    });
  });
  
  describe('Security Tests', () => {
    it('should enforce ZKP authentication', async () => {
      const poolWithAuth = new P2PMiningPool({
        zkpEnabled: true,
        stratumPort: 13334
      });
      
      await poolWithAuth.initialize();
      
      const connection = {
        id: 'test_miner',
        authData: {} // Missing ZKP proof
      };
      
      const authResult = await poolWithAuth.authenticateWithZKP(connection);
      
      expect(authResult.verified).toBe(false);
      expect(authResult.reason).toBe('missing_zkp_proof');
      
      await poolWithAuth.shutdown();
    });
    
    it('should rate limit share submissions', async () => {
      await pool.initialize();
      
      const connection = {
        id: 'spam_miner',
        minerAddress: 'spam_address'
      };
      
      const miner = {
        id: connection.id,
        address: connection.minerAddress,
        difficulty: 1024,
        shares: 0,
        lastShare: Date.now(),
        hashrate: 0,
        connected: Date.now()
      };
      
      pool.miners.set(connection.id, miner);
      
      // Try to submit shares too quickly
      const results = [];
      for (let i = 0; i < 20; i++) {
        const result = await pool.handleShare(connection, {
          nonce: i,
          blockHeader: '0'.repeat(160)
        });
        results.push(result);
        
        // Update last share time to simulate rapid submission
        miner.lastShare = Date.now();
      }
      
      const rateLimited = results.filter(r => r.reason === 'rate_limited');
      expect(rateLimited.length).toBeGreaterThan(0);
    });
  });
  
  describe('Reliability Tests', () => {
    it('should handle worker thread failures gracefully', async () => {
      await pool.initialize();
      
      // Simulate worker failure
      const worker = pool.workerPool.workers[0];
      worker.emit('error', new Error('Worker crashed'));
      
      // Pool should still be operational
      expect(pool.networkState).toBe('running');
      
      // Should still be able to validate shares
      const shareData = {
        nonce: 12345,
        blockHeader: '0'.repeat(160),
        difficulty: 1024,
        algorithm: 'sha256'
      };
      
      const result = await pool.validateShare(shareData, 1024);
      expect(result).toBeDefined();
    });
    
    it('should recover from network disruptions', async () => {
      await pool.initialize();
      
      client = new LightweightMiningClient({
        poolHost: 'localhost',
        poolPort: 13333,
        minerAddress: 'test_miner',
        reconnectDelay: 1000,
        maxReconnectAttempts: 3
      });
      
      await client.initialize();
      await client.connect();
      
      expect(client.connected).toBe(true);
      
      // Simulate connection loss
      client.socket = null;
      client.connected = false;
      client.emit('disconnected');
      
      // Should attempt to reconnect
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Check reconnection attempts
      expect(client.reconnectAttempts).toBeGreaterThan(0);
    });
  });
  
  describe('Difficulty Adjustment', () => {
    it('should adjust miner difficulty based on performance', async () => {
      await pool.initialize();
      
      const miner = {
        id: 'test_miner',
        address: 'test_address',
        difficulty: 1024,
        shares: 0,
        lastShare: 0,
        hashrate: 0,
        connected: Date.now()
      };
      
      pool.miners.set(miner.id, miner);
      
      // Simulate fast share submissions
      const now = Date.now();
      const shares = [];
      
      for (let i = 0; i < 10; i++) {
        shares.push({
          minerId: miner.id,
          difficulty: miner.difficulty,
          timestamp: now - (i * 1000) // 1 share per second
        });
      }
      
      // Add shares to pool
      shares.forEach((share, i) => {
        pool.shares[i] = share;
      });
      
      const initialDifficulty = miner.difficulty;
      pool.adjustMinerDifficulty(miner);
      
      // Difficulty should increase for fast submissions
      expect(miner.difficulty).toBeGreaterThan(initialDifficulty);
    });
  });
  
  describe('Block Discovery', () => {
    it('should process block discovery correctly', async () => {
      await pool.initialize();
      
      let blockFound = false;
      pool.on('block:found', (block) => {
        blockFound = true;
        expect(block).toHaveProperty('hash');
        expect(block).toHaveProperty('height');
        expect(block).toHaveProperty('minerId');
      });
      
      const share = {
        minerId: 'lucky_miner',
        difficulty: 1000000,
        timestamp: Date.now(),
        blockCandidate: true,
        hash: crypto.randomBytes(32).toString('hex')
      };
      
      const validation = {
        hash: share.hash,
        difficulty: share.difficulty,
        blockCandidate: true
      };
      
      await pool.processBlock(share, validation);
      
      expect(blockFound).toBe(true);
      expect(pool.metrics.blockCount).toBe(1);
    });
  });
  
  describe('Stratum V2 Protocol', () => {
    it('should handle Stratum V2 connections', async () => {
      const server = new StratumServer({
        port: 13335,
        algorithm: 'sha256',
        difficulty: 1024
      });
      
      await server.start();
      
      expect(server.running).toBe(true);
      expect(server.getStats().port).toBe(13335);
      
      await server.stop();
    });
    
    it('should generate valid mining jobs', async () => {
      const server = new StratumServer({
        port: 13336
      });
      
      await server.start();
      
      const job = server.generateJob();
      
      expect(job).toHaveProperty('id');
      expect(job).toHaveProperty('version');
      expect(job).toHaveProperty('prevHash');
      expect(job).toHaveProperty('merkleRoot');
      expect(job).toHaveProperty('timestamp');
      expect(job).toHaveProperty('bits');
      expect(job).toHaveProperty('target');
      
      expect(job.id.length).toBe(8);
      expect(job.prevHash.length).toBe(64);
      expect(job.merkleRoot.length).toBe(64);
      expect(job.target.length).toBe(64);
      
      await server.stop();
    });
  });
});

describe('Mining Algorithm Tests', () => {
  it('should support all advertised algorithms', async () => {
    const algorithms = ['sha256', 'scrypt', 'ethash', 'randomx', 'kawpow'];
    
    for (const algo of algorithms) {
      const pool = new P2PMiningPool({
        algorithm: algo,
        stratumPort: 13340 + algorithms.indexOf(algo)
      });
      
      await pool.initialize();
      expect(pool.config.algorithm).toBe(algo);
      await pool.shutdown();
    }
  });
});

describe('Hardware Detection Tests', () => {
  it('should detect hardware capabilities', async () => {
    const client = new LightweightMiningClient();
    await client.initialize();
    
    const hardware = client.hardwareDetector.detectedHardware;
    
    expect(hardware).toHaveProperty('cpu');
    expect(hardware).toHaveProperty('gpu');
    expect(hardware).toHaveProperty('memory');
    expect(hardware).toHaveProperty('system');
    
    expect(hardware.cpu.cores).toBeGreaterThan(0);
    expect(hardware.memory.total).toBeGreaterThan(0);
    
    await client.shutdown();
  });
  
  it('should optimize configuration based on hardware', async () => {
    const client = new LightweightMiningClient({
      threads: 'auto',
      algorithm: 'auto',
      intensity: 'auto'
    });
    
    await client.initialize();
    
    expect(client.config.threads).toBeGreaterThan(0);
    expect(client.config.threads).toBeLessThanOrEqual(require('os').cpus().length);
    expect(['sha256', 'scrypt', 'ethash', 'randomx', 'kawpow']).toContain(client.config.algorithm);
    expect(['low', 'medium', 'high']).toContain(client.config.intensity);
    
    await client.shutdown();
  });
});

// Export test utilities for other test files
export const createTestPool = async (config = {}) => {
  const pool = new P2PMiningPool({
    ...config,
    stratumPort: config.stratumPort || Math.floor(Math.random() * 10000) + 20000
  });
  await pool.initialize();
  return pool;
};

export const createTestClient = async (poolPort, config = {}) => {
  const client = new LightweightMiningClient({
    poolHost: 'localhost',
    poolPort,
    ...config
  });
  await client.initialize();
  return client;
};