/**
 * Solo Mining Tests - Otedama
 * 
 * Tests for solo mining functionality alongside pool operation
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { SoloMiningManager } from '../lib/mining/solo-mining-manager.js';
import { createMiningPoolManager } from '../lib/mining/pool-manager.js';
import { EventEmitter } from 'events';

describe('Solo Mining', () => {
  let soloManager;
  
  beforeEach(() => {
    // Mock RPC calls
    global.fetch = jest.fn();
  });
  
  afterEach(async () => {
    if (soloManager && soloManager.mining) {
      await soloManager.stop();
    }
    jest.clearAllMocks();
  });
  
  describe('SoloMiningManager', () => {
    it('should initialize with valid configuration', async () => {
      soloManager = new SoloMiningManager({
        rpcUrl: 'http://localhost:8332',
        rpcUser: 'test',
        rpcPassword: 'test',
        algorithm: 'sha256',
        coinbaseAddress: 'bc1qtest',
        threads: 2,
        cpuEnabled: true,
        gpuEnabled: false,
        asicEnabled: false
      });
      
      // Mock blockchain info response
      global.fetch.mockResolvedValueOnce({
        json: async () => ({
          result: {
            chain: 'main',
            blocks: 700000,
            difficulty: 1000000
          }
        })
      });
      
      await soloManager.initialize();
      
      expect(soloManager.connected).toBe(true);
      expect(soloManager.stats.networkDifficulty).toBe(1000000);
    });
    
    it('should throw error without coinbase address', () => {
      expect(() => {
        new SoloMiningManager({
          rpcUrl: 'http://localhost:8332',
          algorithm: 'sha256'
        });
      }).toThrow('Coinbase address is required');
    });
    
    it('should handle block template updates', async () => {
      soloManager = new SoloMiningManager({
        rpcUrl: 'http://localhost:8332',
        rpcUser: 'test',
        rpcPassword: 'test',
        algorithm: 'sha256',
        coinbaseAddress: 'bc1qtest',
        threads: 1
      });
      
      // Mock blockchain info
      global.fetch.mockResolvedValueOnce({
        json: async () => ({
          result: {
            chain: 'main',
            blocks: 700000,
            difficulty: 1000000
          }
        })
      });
      
      await soloManager.initialize();
      
      // Mock block template
      global.fetch.mockResolvedValueOnce({
        json: async () => ({
          result: {
            height: 700001,
            previousblockhash: '00000000000000000001234567890abcdef',
            coinbasevalue: 625000000,
            bits: '1234abcd',
            difficulty: 1000000,
            transactions: []
          }
        })
      });
      
      await soloManager.updateBlockTemplate();
      
      expect(soloManager.currentTemplate).toBeTruthy();
      expect(soloManager.currentTemplate.height).toBe(700001);
      expect(soloManager.stats.difficulty).toBeGreaterThan(0);
    });
    
    it('should process shares and detect blocks', async () => {
      soloManager = new SoloMiningManager({
        rpcUrl: 'http://localhost:8332',
        rpcUser: 'test',
        rpcPassword: 'test',
        algorithm: 'sha256',
        coinbaseAddress: 'bc1qtest'
      });
      
      // Initialize
      global.fetch.mockResolvedValueOnce({
        json: async () => ({
          result: {
            chain: 'main',
            blocks: 700000,
            difficulty: 1
          }
        })
      });
      
      await soloManager.initialize();
      
      // Set low difficulty for testing
      soloManager.stats.networkDifficulty = 1;
      soloManager.currentTemplate = {
        height: 700001,
        prevHash: '00000000000000000001234567890abcdef',
        merkleRoot: Buffer.alloc(32),
        version: 1,
        bits: '1234abcd',
        coinbaseTx: { version: 1, inputs: [], outputs: [], lockTime: 0 },
        transactions: []
      };
      
      let blockFound = false;
      soloManager.on('block:found', () => {
        blockFound = true;
      });
      
      // Mock block submission
      global.fetch.mockResolvedValueOnce({
        json: async () => ({
          result: null // Success
        })
      });
      
      // Process a "winning" share
      await soloManager.processShare({
        time: Math.floor(Date.now() / 1000),
        nonce: '00000001'
      });
      
      expect(soloManager.stats.sharesProcessed).toBe(1);
      expect(soloManager.stats.blocksFound).toBe(1);
      expect(blockFound).toBe(true);
    });
  });
  
  describe('Pool with Solo Mining', () => {
    it('should initialize pool with solo mining enabled', async () => {
      const poolManager = createMiningPoolManager({
        poolName: 'Test Pool',
        algorithm: 'sha256',
        enableSoloMining: true,
        soloMining: {
          enabled: true,
          coinbaseAddress: 'bc1qtest',
          shareAllocationRatio: 0.3,
          threads: 2
        },
        blockchainRPC: {
          bitcoin: {
            enabled: true,
            rpcUrl: 'http://localhost:8332',
            rpcUser: 'test',
            rpcPassword: 'test'
          }
        },
        stratumPort: 13333,
        apiPort: 18080
      });
      
      // Mock storage initialization
      poolManager.storage = {
        initialize: jest.fn(),
        database: {
          migrate: jest.fn()
        }
      };
      
      // Mock monitoring
      poolManager.monitoring = {
        start: jest.fn(),
        registerGauge: jest.fn(),
        registerCounter: jest.fn(),
        setGauge: jest.fn(),
        incrementCounter: jest.fn()
      };
      
      // Mock blockchain connection for solo mining
      global.fetch.mockResolvedValueOnce({
        json: async () => ({
          result: {
            chain: 'main',
            blocks: 700000,
            difficulty: 1000000
          }
        })
      });
      
      await poolManager.initializeSoloMining();
      
      expect(poolManager.soloMiningManager).toBeTruthy();
      expect(poolManager.soloMiningManager.config.coinbaseAddress).toBe('bc1qtest');
      expect(poolManager.soloMiningManager.config.shareAllocationRatio).toBe(0.3);
    });
    
    it('should include solo mining stats in pool stats', async () => {
      const poolManager = createMiningPoolManager({
        enableSoloMining: true,
        soloMining: {
          enabled: true,
          coinbaseAddress: 'bc1qtest'
        }
      });
      
      // Mock solo mining manager
      poolManager.soloMiningManager = {
        getStats: () => ({
          hashrate: 1000000,
          blocksFound: 1,
          sharesProcessed: 100
        })
      };
      
      const stats = poolManager.getStats();
      
      expect(stats.soloMining).toBeTruthy();
      expect(stats.soloMining.hashrate).toBe(1000000);
      expect(stats.soloMining.blocksFound).toBe(1);
    });
    
    it('should handle solo mining alongside pool mining', async () => {
      const poolManager = createMiningPoolManager({
        poolName: 'Hybrid Pool',
        enableSoloMining: true,
        soloMining: {
          enabled: true,
          coinbaseAddress: 'bc1qtest',
          shareAllocationRatio: 0.5 // 50/50 split
        }
      });
      
      // Mock components
      poolManager.pool = new EventEmitter();
      poolManager.pool.start = jest.fn();
      poolManager.pool.stop = jest.fn();
      
      poolManager.soloMiningManager = new EventEmitter();
      poolManager.soloMiningManager.start = jest.fn();
      poolManager.soloMiningManager.stop = jest.fn();
      poolManager.soloMiningManager.mining = true;
      poolManager.soloMiningManager.connected = true;
      poolManager.soloMiningManager.getStats = () => ({
        hashrate: 500000,
        blocksFound: 0
      });
      
      // Simulate block found events
      let poolBlockCount = 0;
      let soloBlockCount = 0;
      
      poolManager.on('block:found', () => {
        poolBlockCount++;
      });
      
      poolManager.on('solo:block:found', () => {
        soloBlockCount++;
      });
      
      // Emit events
      poolManager.pool.emit('block:found', { height: 700001 });
      poolManager.soloMiningManager.emit('block:found', { height: 700002 });
      
      expect(poolBlockCount).toBe(1);
      expect(soloBlockCount).toBe(1);
    });
  });
  
  describe('Resource Allocation', () => {
    it('should allocate resources according to configuration', () => {
      const totalCPUs = 8;
      const shareAllocationRatio = 0.3;
      
      const soloThreads = Math.max(1, Math.floor(totalCPUs * shareAllocationRatio));
      const poolThreads = totalCPUs - soloThreads;
      
      expect(soloThreads).toBe(2); // 30% of 8 = 2.4, floor = 2
      expect(poolThreads).toBe(6);
    });
    
    it('should ensure minimum resource allocation', () => {
      const totalCPUs = 2;
      const shareAllocationRatio = 0.1; // 10%
      
      const soloThreads = Math.max(1, Math.floor(totalCPUs * shareAllocationRatio));
      const poolThreads = Math.max(1, totalCPUs - soloThreads);
      
      expect(soloThreads).toBe(1); // Minimum 1 thread
      expect(poolThreads).toBe(1); // Remaining thread
    });
  });
});