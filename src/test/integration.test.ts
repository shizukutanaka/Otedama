// Integration tests for Otedama Pool Complete Edition
import { OtedamaCompletePool } from '../main-complete';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import axios from 'axios';
import WebSocket from 'ws';

const execAsync = promisify(exec);

describe('Otedama Pool Integration Tests', () => {
  let pool: OtedamaCompletePool;
  let redisProcess: any;
  
  // Test configuration
  const testConfig = {
    poolAddress: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
    rpcUrl: 'http://localhost:18332', // testnet
    rpcUser: 'test',
    rpcPassword: 'test',
    stratumPort: 13333,
    apiPort: 14000,
    dashboardPort: 18081,
    wsPort: 18080,
    redisUrl: 'redis://localhost:16379'
  };
  
  beforeAll(async () => {
    // Start Redis for testing
    try {
      await execAsync('redis-server --port 16379 --daemonize yes');
      redisProcess = true;
    } catch (error) {
      console.warn('Could not start Redis, some tests may fail');
    }
    
    // Set test environment variables
    process.env.POOL_ADDRESS = testConfig.poolAddress;
    process.env.RPC_URL = testConfig.rpcUrl;
    process.env.RPC_USER = testConfig.rpcUser;
    process.env.RPC_PASSWORD = testConfig.rpcPassword;
    process.env.STRATUM_PORT = String(testConfig.stratumPort);
    process.env.API_PORT = String(testConfig.apiPort);
    process.env.DASHBOARD_PORT = String(testConfig.dashboardPort);
    process.env.WS_PORT = String(testConfig.wsPort);
    process.env.REDIS_URL = testConfig.redisUrl;
    process.env.REDIS_ENABLED = 'true';
    process.env.NODE_ENV = 'test';
  });
  
  afterAll(async () => {
    // Cleanup
    if (pool) {
      await pool.stop();
    }
    
    // Stop Redis
    if (redisProcess) {
      try {
        await execAsync('redis-cli -p 16379 shutdown');
      } catch (error) {
        // Ignore errors
      }
    }
  });
  
  describe('Pool Startup', () => {
    test('should start all services successfully', async () => {
      pool = new OtedamaCompletePool();
      
      await expect(pool.start()).resolves.not.toThrow();
      
      // Give services time to start
      await new Promise(resolve => setTimeout(resolve, 2000));
    }, 30000);
    
    test('should have API server running', async () => {
      const response = await axios.get(`http://localhost:${testConfig.apiPort}/health`);
      
      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('status', 'healthy');
    });
    
    test('should have dashboard server running', async () => {
      const response = await axios.get(`http://localhost:${testConfig.dashboardPort}/`);
      
      expect(response.status).toBe(200);
    });
    
    test('should accept Stratum connections', async () => {
      const client = new WebSocket(`ws://localhost:${testConfig.stratumPort}`);
      
      await new Promise((resolve, reject) => {
        client.on('open', resolve);
        client.on('error', reject);
      });
      
      // Send mining.subscribe
      client.send(JSON.stringify({
        id: 1,
        method: 'mining.subscribe',
        params: ['Otedama-Miner/1.0']
      }));
      
      const response = await new Promise<any>((resolve) => {
        client.on('message', (data) => {
          resolve(JSON.parse(data.toString()));
        });
      });
      
      expect(response).toHaveProperty('id', 1);
      expect(response).toHaveProperty('result');
      
      client.close();
    });
  });
  
  describe('API Endpoints', () => {
    test('GET /api/stats should return pool statistics', async () => {
      const response = await axios.get(`http://localhost:${testConfig.apiPort}/api/stats`);
      
      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('hashrate');
      expect(response.data).toHaveProperty('miners');
      expect(response.data).toHaveProperty('workers');
      expect(response.data).toHaveProperty('blocks');
    });
    
    test('GET /api/miners should return miner list', async () => {
      const response = await axios.get(`http://localhost:${testConfig.apiPort}/api/miners`);
      
      expect(response.status).toBe(200);
      expect(Array.isArray(response.data)).toBe(true);
    });
    
    test('GET /api/blocks should return block history', async () => {
      const response = await axios.get(`http://localhost:${testConfig.apiPort}/api/blocks`);
      
      expect(response.status).toBe(200);
      expect(Array.isArray(response.data)).toBe(true);
    });
  });
  
  describe('WebSocket Communication', () => {
    let ws: WebSocket;
    
    beforeEach(async () => {
      ws = new WebSocket(`ws://localhost:${testConfig.wsPort}`);
      await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });
    });
    
    afterEach(() => {
      ws.close();
    });
    
    test('should receive real-time updates', async () => {
      const updates: any[] = [];
      
      ws.on('message', (data) => {
        updates.push(JSON.parse(data.toString()));
      });
      
      // Wait for updates
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      expect(updates.length).toBeGreaterThan(0);
      expect(updates.some(u => u.type === 'stats')).toBe(true);
    });
    
    test('should handle subscription requests', async () => {
      ws.send(JSON.stringify({
        type: 'subscribe',
        channels: ['miners', 'blocks']
      }));
      
      const response = await new Promise<any>((resolve) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'subscribed') {
            resolve(msg);
          }
        });
      });
      
      expect(response.channels).toContain('miners');
      expect(response.channels).toContain('blocks');
    });
  });
  
  describe('Anomaly Detection', () => {
    test('should detect hashrate anomalies', async () => {
      // Simulate a miner with abnormal hashrate
      const mockMiner = {
        id: 'test-miner-1',
        address: '1TestAddress',
        hashrate: 1000000000000, // 1 TH/s
        shares: 0,
        lastShare: Date.now()
      };
      
      // Monitor anomaly events
      const anomalies: any[] = [];
      pool.on('anomaly', (anomaly) => {
        anomalies.push(anomaly);
      });
      
      // Simulate sudden hashrate spike
      for (let i = 0; i < 10; i++) {
        mockMiner.hashrate *= 10; // Exponential increase
        await pool.updateMinerStats(mockMiner);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      // Check if anomaly was detected
      expect(anomalies.length).toBeGreaterThan(0);
      expect(anomalies.some(a => a.type === 'HASHRATE_SPIKE')).toBe(true);
    });
  });
  
  describe('Auto Scaling', () => {
    test('should scale up under high load', async () => {
      if (process.env.AUTO_SCALING_ENABLED !== 'true') {
        console.log('Auto scaling not enabled, skipping test');
        return;
      }
      
      // Monitor scaling events
      const scalingEvents: any[] = [];
      pool.on('scaling', (event) => {
        scalingEvents.push(event);
      });
      
      // Simulate high load
      const connections = [];
      for (let i = 0; i < 100; i++) {
        const client = new WebSocket(`ws://localhost:${testConfig.stratumPort}`);
        connections.push(client);
      }
      
      // Wait for scaling decision
      await new Promise(resolve => setTimeout(resolve, 35000)); // Wait for monitoring interval
      
      // Check if scaling was triggered
      expect(scalingEvents.length).toBeGreaterThan(0);
      expect(scalingEvents.some(e => e.action === 'SCALE_UP')).toBe(true);
      
      // Cleanup connections
      connections.forEach(c => c.close());
    }, 60000);
  });
  
  describe('Backup and Recovery', () => {
    test('should create backup successfully', async () => {
      const backupDir = './test-backups';
      await fs.mkdir(backupDir, { recursive: true });
      
      const result = await pool.createBackup(backupDir);
      
      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('filename');
      
      // Verify backup file exists
      const backupPath = path.join(backupDir, result.filename);
      await expect(fs.access(backupPath)).resolves.not.toThrow();
      
      // Cleanup
      await fs.rm(backupDir, { recursive: true });
    });
    
    test('should restore from backup', async () => {
      const backupDir = './test-backups';
      await fs.mkdir(backupDir, { recursive: true });
      
      // Create a backup first
      const backupResult = await pool.createBackup(backupDir);
      
      // Clear current data
      await pool.clearAllData();
      
      // Restore from backup
      const restoreResult = await pool.restoreFromBackup(
        path.join(backupDir, backupResult.filename)
      );
      
      expect(restoreResult).toHaveProperty('success', true);
      
      // Cleanup
      await fs.rm(backupDir, { recursive: true });
    });
  });
  
  describe('Payment Processing', () => {
    test('should calculate fees correctly', async () => {
      const amount = 1.0; // 1 BTC
      const feePercent = 1.0; // 1%
      
      const fee = pool.calculateFee(amount, feePercent);
      
      expect(fee).toBe(0.01);
    });
    
    test('should batch payments efficiently', async () => {
      const payments = [
        { address: '1Address1', amount: 0.1 },
        { address: '1Address2', amount: 0.2 },
        { address: '1Address3', amount: 0.15 }
      ];
      
      const batch = await pool.createPaymentBatch(payments);
      
      expect(batch).toHaveProperty('totalAmount', 0.45);
      expect(batch).toHaveProperty('recipientCount', 3);
      expect(batch).toHaveProperty('estimatedFee');
    });
  });
  
  describe('Security Features', () => {
    test('should enforce rate limiting', async () => {
      const requests = [];
      
      // Send many requests rapidly
      for (let i = 0; i < 200; i++) {
        requests.push(
          axios.get(`http://localhost:${testConfig.apiPort}/api/stats`)
            .catch(err => err.response)
        );
      }
      
      const responses = await Promise.all(requests);
      
      // Some requests should be rate limited
      expect(responses.some(r => r.status === 429)).toBe(true);
    });
    
    test('should validate share submissions', async () => {
      const invalidShare = {
        jobId: 'invalid',
        nonce: 'invalid',
        extranonce2: 'invalid',
        ntime: 'invalid'
      };
      
      const result = await pool.submitShare('test-miner', invalidShare);
      
      expect(result).toHaveProperty('error');
      expect(result.error).toContain('invalid');
    });
  });
  
  describe('Graceful Shutdown', () => {
    test('should shutdown gracefully', async () => {
      const shutdownResult = await pool.stop();
      
      expect(shutdownResult).toHaveProperty('success', true);
      
      // Verify all services are stopped
      await expect(
        axios.get(`http://localhost:${testConfig.apiPort}/health`)
      ).rejects.toThrow();
    });
  });
});
