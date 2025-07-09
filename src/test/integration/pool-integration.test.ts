// Comprehensive integration tests for the mining pool
// Testing all components working together

import { EnhancedMiningPool } from '../../core/enhanced-pool';
import { Logger } from '../../logging/logger';
import { Database } from 'sqlite';
import { open } from 'sqlite';
import * as sqlite3 from 'sqlite3';
import * as crypto from 'crypto';
import * as net from 'net';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('Mining Pool Integration Tests', () => {
  let pool: EnhancedMiningPool;
  let db: Database;
  let logger: Logger;
  let testDbPath: string;
  let stratumClient: net.Socket;
  
  beforeAll(async () => {
    // Setup test environment
    testDbPath = path.join(process.cwd(), 'test-integration.db');
    logger = new Logger('IntegrationTest');
    
    // Remove existing test database
    try {
      await fs.unlink(testDbPath);
    } catch {
      // Ignore if doesn't exist
    }
    
    // Create database
    db = await open({
      filename: testDbPath,
      driver: sqlite3.Database
    });
    
    // Initialize pool with test configuration
    pool = new EnhancedMiningPool({
      POOL_ADDRESS: '1TestPoolAddressForIntegrationTesting',
      STRATUM_PORT: 13333, // Test port
      RPC_URL: 'http://localhost:8332',
      RPC_USER: 'test',
      RPC_PASSWORD: 'test',
      DATABASE_PATH: testDbPath,
      REDIS_ENABLED: false, // Disable for integration tests
      SSL_ENABLED: false,
      AUTH_ENABLED: true,
      MONITORING_ENABLED: true,
      API_ENABLED: true,
      API_PORT: 18080,
      DASHBOARD_ENABLED: true,
      DASHBOARD_PORT: 18081,
      ENABLE_PARALLEL_VALIDATION: true,
      PARALLEL_WORKERS: 2
    });
    
    // Start the pool
    await pool.start();
    
    // Give the pool time to fully initialize
    await new Promise(resolve => setTimeout(resolve, 1000));
  });
  
  afterAll(async () => {
    // Cleanup
    if (stratumClient && !stratumClient.destroyed) {
      stratumClient.destroy();
    }
    
    await pool.stop();
    await db.close();
    
    try {
      await fs.unlink(testDbPath);
    } catch {
      // Ignore
    }
  });
  
  describe('Stratum Server Integration', () => {
    it('should accept client connections', async () => {
      const connected = await new Promise<boolean>((resolve) => {
        stratumClient = new net.Socket();
        
        stratumClient.on('connect', () => {
          resolve(true);
        });
        
        stratumClient.on('error', () => {
          resolve(false);
        });
        
        stratumClient.connect(13333, 'localhost');
      });
      
      expect(connected).toBe(true);
    });
    
    it('should handle mining.subscribe', async () => {
      const response = await sendStratumRequest(stratumClient, {
        id: 1,
        method: 'mining.subscribe',
        params: ['integration-test/1.0', null]
      });
      
      expect(response.id).toBe(1);
      expect(response.result).toBeDefined();
      expect(Array.isArray(response.result)).toBe(true);
      expect(response.result).toHaveLength(3);
    });
    
    it('should handle mining.authorize', async () => {
      const response = await sendStratumRequest(stratumClient, {
        id: 2,
        method: 'mining.authorize',
        params: ['test.worker1', 'password']
      });
      
      expect(response.id).toBe(2);
      expect(response.result).toBe(true);
      expect(response.error).toBeNull();
    });
    
    it('should receive mining.notify', async () => {
      const notification = await waitForNotification(stratumClient, 'mining.notify', 5000);
      
      expect(notification).toBeDefined();
      expect(notification.method).toBe('mining.notify');
      expect(Array.isArray(notification.params)).toBe(true);
    });
    
    it('should handle mining.submit', async () => {
      // First get a job
      const jobNotification = await waitForNotification(stratumClient, 'mining.notify', 5000);
      const [jobId] = jobNotification.params;
      
      const response = await sendStratumRequest(stratumClient, {
        id: 3,
        method: 'mining.submit',
        params: [
          'test.worker1',
          jobId,
          crypto.randomBytes(4).toString('hex'),
          Math.floor(Date.now() / 1000).toString(16),
          crypto.randomBytes(4).toString('hex')
        ]
      });
      
      expect(response.id).toBe(3);
      expect(typeof response.result).toBe('boolean');
    });
  });
  
  describe('Database Integration', () => {
    it('should store miner information', async () => {
      const miners = await db.all('SELECT * FROM miners WHERE address LIKE ?', 'test.%');
      expect(miners.length).toBeGreaterThan(0);
    });
    
    it('should store shares', async () => {
      // Submit some shares
      for (let i = 0; i < 5; i++) {
        await sendStratumRequest(stratumClient, {
          id: 10 + i,
          method: 'mining.submit',
          params: [
            'test.worker1',
            'job-test',
            crypto.randomBytes(4).toString('hex'),
            Math.floor(Date.now() / 1000).toString(16),
            crypto.randomBytes(4).toString('hex')
          ]
        });
      }
      
      // Check database
      const shares = await db.all('SELECT * FROM shares WHERE miner_id IN (SELECT id FROM miners WHERE address LIKE ?)', 'test.%');
      expect(shares.length).toBeGreaterThan(0);
    });
    
    it('should track miner statistics', async () => {
      const stats = await db.get(`
        SELECT 
          COUNT(*) as total_shares,
          SUM(CASE WHEN is_valid = 1 THEN 1 ELSE 0 END) as valid_shares,
          SUM(difficulty) as total_difficulty
        FROM shares 
        WHERE miner_id IN (SELECT id FROM miners WHERE address LIKE ?)
      `, 'test.%');
      
      expect(stats.total_shares).toBeGreaterThan(0);
      expect(stats.total_difficulty).toBeGreaterThan(0);
    });
  });
  
  describe('API Integration', () => {
    it('should expose health endpoint', async () => {
      const response = await fetch('http://localhost:18080/health');
      const data = await response.json();
      
      expect(response.status).toBe(200);
      expect(data.status).toBe('healthy');
      expect(data.uptime).toBeGreaterThan(0);
    });
    
    it('should expose stats endpoint', async () => {
      const response = await fetch('http://localhost:18080/api/stats');
      const data = await response.json();
      
      expect(response.status).toBe(200);
      expect(data).toHaveProperty('pool');
      expect(data).toHaveProperty('network');
      expect(data).toHaveProperty('miners');
    });
    
    it('should expose miner stats', async () => {
      const response = await fetch('http://localhost:18080/api/miners/test.worker1');
      
      if (response.status === 200) {
        const data = await response.json();
        expect(data).toHaveProperty('address');
        expect(data).toHaveProperty('hashrate');
        expect(data).toHaveProperty('shares');
      } else {
        expect(response.status).toBe(404); // Miner might not exist yet
      }
    });
  });
  
  describe('Monitoring Integration', () => {
    it('should track pool metrics', async () => {
      const response = await fetch('http://localhost:18080/metrics');
      const text = await response.text();
      
      expect(response.status).toBe(200);
      expect(text).toContain('pool_hashrate');
      expect(text).toContain('pool_miners_active');
      expect(text).toContain('pool_shares_total');
    });
    
    it('should have dashboard running', async () => {
      const response = await fetch('http://localhost:18081/');
      
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
    });
  });
  
  describe('Error Handling Integration', () => {
    it('should handle invalid stratum messages', async () => {
      const invalidClient = new net.Socket();
      await new Promise<void>((resolve) => {
        invalidClient.on('connect', resolve);
        invalidClient.connect(13333, 'localhost');
      });
      
      // Send invalid JSON
      invalidClient.write('invalid json\n');
      
      // Send malformed request
      invalidClient.write(JSON.stringify({ invalid: 'request' }) + '\n');
      
      // Client should still be connected
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(invalidClient.destroyed).toBe(false);
      
      invalidClient.destroy();
    });
    
    it('should handle concurrent connections', async () => {
      const clients: net.Socket[] = [];
      const connectionPromises = [];
      
      // Create 50 concurrent connections
      for (let i = 0; i < 50; i++) {
        const client = new net.Socket();
        clients.push(client);
        
        const promise = new Promise<void>((resolve) => {
          client.on('connect', async () => {
            // Subscribe
            await sendStratumRequest(client, {
              id: 1,
              method: 'mining.subscribe',
              params: [`test-client-${i}`, null]
            });
            
            // Authorize
            await sendStratumRequest(client, {
              id: 2,
              method: 'mining.authorize',
              params: [`test.worker${i}`, 'password']
            });
            
            resolve();
          });
          
          client.connect(13333, 'localhost');
        });
        
        connectionPromises.push(promise);
      }
      
      await Promise.all(connectionPromises);
      
      // All clients should be connected
      expect(clients.every(c => !c.destroyed)).toBe(true);
      
      // Cleanup
      clients.forEach(c => c.destroy());
    });
  });
  
  describe('Performance Integration', () => {
    it('should handle high share submission rate', async () => {
      const submitPromises = [];
      const startTime = Date.now();
      
      // Submit 1000 shares as fast as possible
      for (let i = 0; i < 1000; i++) {
        const promise = sendStratumRequest(stratumClient, {
          id: 1000 + i,
          method: 'mining.submit',
          params: [
            'test.worker1',
            'job-perf-test',
            crypto.randomBytes(4).toString('hex'),
            Math.floor(Date.now() / 1000).toString(16),
            crypto.randomBytes(4).toString('hex')
          ]
        });
        
        submitPromises.push(promise);
      }
      
      const responses = await Promise.all(submitPromises);
      const endTime = Date.now();
      
      const duration = endTime - startTime;
      const sharesPerSecond = 1000 / (duration / 1000);
      
      logger.info(`Processed 1000 shares in ${duration}ms (${sharesPerSecond.toFixed(2)} shares/sec)`);
      
      expect(responses.every(r => r.id >= 1000 && r.id < 2000)).toBe(true);
      expect(sharesPerSecond).toBeGreaterThan(100); // Should handle at least 100 shares/sec
    });
  });
  
  describe('Full Workflow Integration', () => {
    it('should complete full mining workflow', async () => {
      // 1. New client connects
      const workflowClient = new net.Socket();
      await new Promise<void>((resolve) => {
        workflowClient.on('connect', resolve);
        workflowClient.connect(13333, 'localhost');
      });
      
      // 2. Subscribe
      const subscribeResponse = await sendStratumRequest(workflowClient, {
        id: 1,
        method: 'mining.subscribe',
        params: ['workflow-test/1.0', null]
      });
      
      expect(subscribeResponse.result).toBeDefined();
      const [, extraNonce1, extraNonce2Size] = subscribeResponse.result;
      expect(typeof extraNonce1).toBe('string');
      expect(typeof extraNonce2Size).toBe('number');
      
      // 3. Authorize
      const authResponse = await sendStratumRequest(workflowClient, {
        id: 2,
        method: 'mining.authorize',
        params: ['workflow.test', 'password']
      });
      
      expect(authResponse.result).toBe(true);
      
      // 4. Receive set_difficulty
      const difficultyNotification = await waitForNotification(workflowClient, 'mining.set_difficulty', 5000);
      expect(difficultyNotification).toBeDefined();
      expect(difficultyNotification.params).toHaveLength(1);
      
      // 5. Receive job
      const jobNotification = await waitForNotification(workflowClient, 'mining.notify', 5000);
      expect(jobNotification).toBeDefined();
      const [jobId] = jobNotification.params;
      
      // 6. Submit shares
      let validShares = 0;
      for (let i = 0; i < 10; i++) {
        const submitResponse = await sendStratumRequest(workflowClient, {
          id: 100 + i,
          method: 'mining.submit',
          params: [
            'workflow.test',
            jobId,
            crypto.randomBytes(extraNonce2Size).toString('hex'),
            Math.floor(Date.now() / 1000).toString(16),
            crypto.randomBytes(4).toString('hex')
          ]
        });
        
        if (submitResponse.result === true) {
          validShares++;
        }
      }
      
      expect(validShares).toBeGreaterThan(0);
      
      // 7. Check database for recorded activity
      const minerStats = await db.get(`
        SELECT 
          COUNT(*) as shares,
          SUM(CASE WHEN is_valid = 1 THEN 1 ELSE 0 END) as valid_shares
        FROM shares 
        WHERE miner_id IN (SELECT id FROM miners WHERE address = ?)
      `, 'workflow.test');
      
      expect(minerStats.shares).toBeGreaterThan(0);
      
      workflowClient.destroy();
    });
  });
});

// Helper functions
async function sendStratumRequest(client: net.Socket, request: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Request timeout'));
    }, 5000);
    
    const handler = (data: Buffer) => {
      const lines = data.toString().split('\n').filter(line => line.trim());
      
      for (const line of lines) {
        try {
          const message = JSON.parse(line);
          
          if (message.id === request.id) {
            clearTimeout(timeout);
            client.off('data', handler);
            resolve(message);
            return;
          }
        } catch {
          // Ignore parse errors
        }
      }
    };
    
    client.on('data', handler);
    client.write(JSON.stringify(request) + '\n');
  });
}

async function waitForNotification(client: net.Socket, method: string, timeout: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('data', handler);
      reject(new Error(`Timeout waiting for ${method}`));
    }, timeout);
    
    const handler = (data: Buffer) => {
      const lines = data.toString().split('\n').filter(line => line.trim());
      
      for (const line of lines) {
        try {
          const message = JSON.parse(line);
          
          if (message.method === method && message.id === null) {
            clearTimeout(timer);
            client.off('data', handler);
            resolve(message);
            return;
          }
        } catch {
          // Ignore parse errors
        }
      }
    };
    
    client.on('data', handler);
  });
}
