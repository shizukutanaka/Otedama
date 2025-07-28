/**
 * P2P Pool Integration Tests for Otedama
 * Comprehensive testing of all P2P pool components
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { P2PPoolManager } from '../../lib/p2p/p2p-pool-manager.js';
import { OptimizedSharePropagation } from '../../lib/p2p/optimized-share-propagation.js';
import { AdvancedPeerDiscovery } from '../../lib/p2p/advanced-peer-discovery.js';
import { OptimizedMiningEngine } from '../../lib/mining/optimized-mining-engine.js';
import { DistributedShareValidator } from '../../lib/network/distributed-share-validator.js';
import { P2PRealtimeDashboard } from '../../lib/monitoring/p2p-realtime-dashboard.js';
import { AutomaticFailoverManager } from '../../lib/p2p/automatic-failover-manager.js';
import crypto from 'crypto';

describe('P2P Pool Integration Tests', () => {
  let poolManager;
  let dashboard;
  let failoverManager;
  
  const testConfig = {
    poolName: 'Test P2P Pool',
    poolAddress: 'bc1qtest' + crypto.randomBytes(20).toString('hex'),
    poolFee: 0.01,
    p2pPort: 30303,
    stratumPort: 3333,
    blockchain: 'BITCOIN',
    bootstrapNodes: [],
    workerCount: 2,
    enableWebSocket: false
  };
  
  beforeEach(async () => {
    // Initialize pool manager
    poolManager = new P2PPoolManager(testConfig);
    
    // Initialize dashboard
    dashboard = new P2PRealtimeDashboard({
      port: 8081,
      enableWebSocket: false
    });
    
    // Initialize failover manager
    failoverManager = new AutomaticFailoverManager({
      healthCheckInterval: 1000,
      failoverStrategy: 'adaptive'
    });
  });
  
  afterEach(async () => {
    if (poolManager) await poolManager.stop();
    if (dashboard) await dashboard.stop();
    if (failoverManager) await failoverManager.stop();
  });
  
  describe('Pool Manager Tests', () => {
    it('should initialize pool manager successfully', async () => {
      await poolManager.initialize();
      
      assert.strictEqual(poolManager.initialized, true);
      assert.ok(poolManager.shareChain);
      assert.ok(poolManager.nodeDiscovery);
      assert.ok(poolManager.stratumProxy);
      assert.ok(poolManager.workCoordinator);
    });
    
    it('should start and stop pool', async () => {
      await poolManager.initialize();
      await poolManager.start();
      
      assert.strictEqual(poolManager.running, true);
      
      await poolManager.stop();
      assert.strictEqual(poolManager.running, false);
    });
    
    it('should handle share submission', async () => {
      await poolManager.initialize();
      await poolManager.start();
      
      const share = {
        minerId: 'miner1',
        hash: crypto.randomBytes(32).toString('hex'),
        difficulty: 1000,
        nonce: 12345,
        timestamp: Date.now()
      };
      
      poolManager.shareChain.addShare(share);
      
      assert.strictEqual(poolManager.shareChain.pendingShares.length, 1);
      assert.strictEqual(poolManager.shareChain.pendingShares[0].minerId, 'miner1');
    });
  });
  
  describe('Share Propagation Tests', () => {
    let propagation;
    
    beforeEach(() => {
      propagation = new OptimizedSharePropagation({
        strategy: 'adaptive',
        maxPeers: 10
      });
    });
    
    afterEach(async () => {
      if (propagation) await propagation.shutdown();
    });
    
    it('should initialize share propagation', async () => {
      await propagation.initialize();
      
      assert.ok(propagation.timeSeries);
      assert.ok(propagation.bloomFilter);
    });
    
    it('should handle share propagation', async () => {
      await propagation.initialize();
      
      const share = {
        height: 100,
        hash: crypto.randomBytes(32).toString('hex'),
        nonce: 12345,
        minerId: 'miner1',
        difficulty: 1000
      };
      
      const result = await propagation.propagateShare(share);
      
      assert.strictEqual(result.propagated, true);
      assert.ok(result.hash);
    });
    
    it('should detect duplicate shares', async () => {
      await propagation.initialize();
      
      const share = {
        height: 100,
        hash: crypto.randomBytes(32).toString('hex'),
        nonce: 12345,
        minerId: 'miner1',
        difficulty: 1000
      };
      
      // First submission
      const result1 = await propagation.propagateShare(share);
      assert.strictEqual(result1.propagated, true);
      
      // Duplicate submission
      const result2 = await propagation.propagateShare(share);
      assert.strictEqual(result2.propagated, false);
      assert.strictEqual(result2.reason, 'duplicate');
    });
  });
  
  describe('Peer Discovery Tests', () => {
    let discovery;
    
    beforeEach(() => {
      discovery = new AdvancedPeerDiscovery({
        nodeId: crypto.randomBytes(32).toString('hex'),
        listenPort: 30304,
        mechanisms: ['dht', 'gossip']
      });
    });
    
    afterEach(async () => {
      if (discovery) await discovery.shutdown();
    });
    
    it('should initialize peer discovery', async () => {
      await discovery.initialize();
      
      assert.ok(discovery.dht);
      assert.ok(discovery.server);
    });
    
    it('should handle peer registration', () => {
      const peerId = crypto.randomBytes(32).toString('hex');
      const peer = discovery.addPeer(peerId, '127.0.0.1', 30305);
      
      assert.ok(peer);
      assert.strictEqual(peer.id, peerId);
      assert.strictEqual(peer.state, 'discovered');
    });
  });
  
  describe('Mining Engine Tests', () => {
    let miningEngine;
    
    beforeEach(() => {
      miningEngine = new OptimizedMiningEngine({
        workerCount: 2,
        strategies: ['adaptive_nonce', 'work_stealing']
      });
    });
    
    afterEach(async () => {
      if (miningEngine) await miningEngine.shutdown();
    });
    
    it('should initialize mining engine', async () => {
      await miningEngine.initialize();
      
      assert.strictEqual(miningEngine.workers.size, 2);
    });
    
    it('should handle mining job', async () => {
      await miningEngine.initialize();
      
      const template = {
        height: 100,
        previousblockhash: crypto.randomBytes(32).toString('hex'),
        merkleroot: crypto.randomBytes(32).toString('hex'),
        curtime: Math.floor(Date.now() / 1000),
        bits: '1d00ffff',
        target: 'ffff'.repeat(16)
      };
      
      await miningEngine.startMining(template, 1000);
      assert.strictEqual(miningEngine.isRunning, true);
      
      miningEngine.stopMining();
      assert.strictEqual(miningEngine.isRunning, false);
    });
  });
  
  describe('Share Validation Tests', () => {
    let validator;
    
    beforeEach(() => {
      validator = new DistributedShareValidator({
        nodeId: crypto.randomUUID(),
        minValidators: 1,
        validationTimeout: 1000,
        enablePrediction: true,
        enableBatching: true
      });
    });
    
    afterEach(async () => {
      if (validator) await validator.shutdown();
    });
    
    it('should initialize validator', async () => {
      await validator.initialize();
      
      assert.ok(validator.localNode);
      assert.ok(validator.validationCache);
    });
    
    it('should validate share', async () => {
      await validator.initialize();
      
      const share = {
        hash: crypto.randomBytes(32).toString('hex'),
        difficulty: 1000,
        nonce: 12345
      };
      
      const result = await validator.validateShare(share, 'sha256');
      
      assert.ok(result.taskId);
      assert.strictEqual(result.queued, true);
    });
  });
  
  describe('Dashboard Tests', () => {
    it('should initialize dashboard', async () => {
      await dashboard.start();
      
      assert.ok(dashboard.metrics);
      assert.ok(dashboard.timeSeries);
    });
    
    it('should update metrics', () => {
      dashboard.updateMetrics({
        'network.peers.total': 10,
        'mining.hashrate.total': 1000000000,
        'shares.submitted.total': 100
      });
      
      const data = dashboard.getDashboardData('overview');
      
      assert.ok(data.metrics);
      assert.ok(data.timestamp);
    });
    
    it('should handle alerts', () => {
      dashboard.alertManager.setThreshold('network.peers.total', 'lt', 5, 'warning');
      
      dashboard.updateMetric('network.peers.total', 3);
      
      const alerts = dashboard.alertManager.getActiveAlerts();
      assert.strictEqual(alerts.length, 1);
      assert.strictEqual(alerts[0].severity, 'warning');
    });
  });
  
  describe('Failover Manager Tests', () => {
    it('should register components', () => {
      failoverManager.registerComponent('pool-manager', {
        type: 'critical',
        critical: true,
        healthCheck: async () => true,
        failoverCandidates: ['backup-pool-1', 'backup-pool-2']
      });
      
      failoverManager.registerComponent('backup-pool-1', {
        type: 'backup',
        healthCheck: async () => true
      });
      
      assert.strictEqual(failoverManager.components.size, 2);
    });
    
    it('should handle component failure', async () => {
      let failureDetected = false;
      
      failoverManager.on('componentFailed', (event) => {
        failureDetected = true;
      });
      
      failoverManager.registerComponent('test-component', {
        type: 'service',
        healthCheck: async () => { throw new Error('Health check failed'); },
        failoverCandidates: []
      });
      
      await failoverManager.start();
      
      // Wait for health check
      await new Promise(resolve => setTimeout(resolve, 4000));
      
      assert.strictEqual(failureDetected, true);
    });
  });
  
  describe('Integration Benchmark', () => {
    it('should handle high load', async function() {
      this.timeout(10000);
      
      await poolManager.initialize();
      await poolManager.start();
      
      const startTime = Date.now();
      const shareCount = 1000;
      
      // Submit many shares
      for (let i = 0; i < shareCount; i++) {
        const share = {
          minerId: `miner${i % 10}`,
          hash: crypto.randomBytes(32).toString('hex'),
          difficulty: 1000 + i,
          nonce: i,
          timestamp: Date.now()
        };
        
        poolManager.shareChain.addShare(share);
      }
      
      const duration = Date.now() - startTime;
      const throughput = shareCount / (duration / 1000);
      
      console.log(`Share submission throughput: ${throughput.toFixed(2)} shares/second`);
      
      assert.ok(throughput > 100, 'Should handle at least 100 shares/second');
    });
    
    it('should maintain low latency', async function() {
      this.timeout(5000);
      
      await poolManager.initialize();
      await poolManager.start();
      
      const latencies = [];
      
      for (let i = 0; i < 100; i++) {
        const start = performance.now();
        
        const share = {
          minerId: 'miner1',
          hash: crypto.randomBytes(32).toString('hex'),
          difficulty: 1000,
          nonce: i,
          timestamp: Date.now()
        };
        
        poolManager.shareChain.addShare(share);
        
        const latency = performance.now() - start;
        latencies.push(latency);
      }
      
      const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      const p95Latency = latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)];
      
      console.log(`Average latency: ${avgLatency.toFixed(2)}ms`);
      console.log(`P95 latency: ${p95Latency.toFixed(2)}ms`);
      
      assert.ok(avgLatency < 10, 'Average latency should be under 10ms');
      assert.ok(p95Latency < 50, 'P95 latency should be under 50ms');
    });
  });
});

// Run tests
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('Running P2P Pool Integration Tests...');
}