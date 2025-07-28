/**
 * Core Module Tests - Otedama
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { ConnectionManager } from '../../lib/core/connection-manager.js';
import { BufferPool } from '../../lib/core/buffer-pool.js';
import { validateBTCAddress } from '../../lib/core/btc-address-validator.js';
import { POOL_OPERATOR } from '../../config/constants.js';

describe('ConnectionManager', () => {
  let connectionManager;
  
  beforeEach(() => {
    connectionManager = new ConnectionManager({
      maxConnections: 10,
      maxConnectionsPerIP: 2,
      connectionTimeout: 1000,
      cleanupInterval: 500
    });
  });
  
  afterEach(() => {
    connectionManager.shutdown();
  });
  
  describe('addConnection', () => {
    it('should add connection successfully', () => {
      const mockSocket = { destroy: jest.fn() };
      const result = connectionManager.addConnection('conn1', mockSocket, '192.168.1.1');
      
      expect(result).toBe(true);
      expect(connectionManager.connections.size).toBe(1);
      expect(connectionManager.connectionsByIP.get('192.168.1.1').size).toBe(1);
    });
    
    it('should reject connection when limit reached', () => {
      const mockSocket = { destroy: jest.fn() };
      
      // Fill up connections
      for (let i = 0; i < 10; i++) {
        connectionManager.addConnection(`conn${i}`, mockSocket, '192.168.1.1');
      }
      
      // Try to add one more
      const result = connectionManager.addConnection('conn11', mockSocket, '192.168.1.1');
      
      expect(result).toBe(false);
      expect(connectionManager.stats.rejectedConnections).toBe(1);
    });
    
    it('should enforce per-IP limits', () => {
      const mockSocket = { destroy: jest.fn() };
      
      // Add 2 connections from same IP
      connectionManager.addConnection('conn1', mockSocket, '192.168.1.1');
      connectionManager.addConnection('conn2', mockSocket, '192.168.1.1');
      
      // Third should be rejected
      const result = connectionManager.addConnection('conn3', mockSocket, '192.168.1.1');
      
      expect(result).toBe(false);
      expect(connectionManager.stats.rejectedConnections).toBe(1);
    });
  });
  
  describe('removeConnection', () => {
    it('should remove connection and clean up', () => {
      const mockSocket = { destroy: jest.fn() };
      connectionManager.addConnection('conn1', mockSocket, '192.168.1.1');
      
      const result = connectionManager.removeConnection('conn1');
      
      expect(result).toBe(true);
      expect(connectionManager.connections.size).toBe(0);
      expect(connectionManager.connectionsByIP.has('192.168.1.1')).toBe(false);
    });
    
    it('should handle non-existent connection', () => {
      const result = connectionManager.removeConnection('nonexistent');
      expect(result).toBe(false);
    });
  });
  
  describe('timeout handling', () => {
    it('should timeout inactive connections', (done) => {
      const mockSocket = { destroy: jest.fn() };
      connectionManager.addConnection('conn1', mockSocket, '192.168.1.1');
      
      // Wait for timeout
      setTimeout(() => {
        expect(mockSocket.destroy).toHaveBeenCalled();
        expect(connectionManager.connections.size).toBe(0);
        expect(connectionManager.stats.timedOutConnections).toBe(1);
        done();
      }, 1500);
    });
    
    it('should reset timeout on activity', (done) => {
      const mockSocket = { destroy: jest.fn() };
      connectionManager.addConnection('conn1', mockSocket, '192.168.1.1');
      
      // Update activity before timeout
      setTimeout(() => {
        connectionManager.updateActivity('conn1');
      }, 500);
      
      // Check connection still exists after original timeout
      setTimeout(() => {
        expect(mockSocket.destroy).not.toHaveBeenCalled();
        expect(connectionManager.connections.size).toBe(1);
        done();
      }, 1200);
    });
  });
});

describe('BufferPool', () => {
  let bufferPool;
  
  beforeEach(() => {
    bufferPool = new BufferPool({
      bufferSize: 1024,
      initialPoolSize: 5,
      maxPoolSize: 10
    });
  });
  
  afterEach(() => {
    bufferPool.shutdown();
  });
  
  describe('acquire', () => {
    it('should provide buffer from pool', () => {
      const buffer = bufferPool.acquire();
      
      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.length).toBe(1024);
      expect(bufferPool.stats.acquired).toBe(1);
      expect(bufferPool.stats.reused).toBe(1);
    });
    
    it('should create new buffer when pool empty', () => {
      // Drain the pool
      for (let i = 0; i < 5; i++) {
        bufferPool.acquire();
      }
      
      // Next should create new
      const buffer = bufferPool.acquire();
      
      expect(buffer.length).toBe(1024);
      expect(bufferPool.stats.created).toBe(6);
    });
    
    it('should clear buffer before returning', () => {
      const buffer = bufferPool.acquire();
      buffer.write('test data');
      bufferPool.release(buffer);
      
      const reusedBuffer = bufferPool.acquire();
      
      expect(reusedBuffer.toString('utf8', 0, 9)).not.toBe('test data');
      expect(reusedBuffer[0]).toBe(0);
    });
  });
  
  describe('release', () => {
    it('should return buffer to pool', () => {
      const buffer = bufferPool.acquire();
      const initialAvailable = bufferPool.available.length;
      
      bufferPool.release(buffer);
      
      expect(bufferPool.available.length).toBe(initialAvailable + 1);
      expect(bufferPool.stats.released).toBe(1);
    });
    
    it('should reject non-buffer objects', () => {
      bufferPool.release('not a buffer');
      bufferPool.release({});
      
      expect(bufferPool.stats.released).toBe(0);
    });
    
    it('should not exceed max pool size', () => {
      // Fill pool to max
      const buffers = [];
      for (let i = 0; i < 15; i++) {
        buffers.push(bufferPool.acquire());
      }
      
      // Release all
      for (const buffer of buffers) {
        bufferPool.release(buffer);
      }
      
      expect(bufferPool.available.length).toBeLessThanOrEqual(10);
    });
  });
  
  describe('statistics', () => {
    it('should track usage statistics', () => {
      const buffer1 = bufferPool.acquire();
      const buffer2 = bufferPool.acquire();
      bufferPool.release(buffer1);
      const buffer3 = bufferPool.acquire();
      
      const stats = bufferPool.getStats();
      
      expect(stats.acquired).toBe(3);
      expect(stats.released).toBe(1);
      expect(stats.reused).toBeGreaterThan(0);
      expect(stats.reuseRate).toBeDefined();
    });
  });
});

describe('BTC Address Validator', () => {
  describe('validateBTCAddress', () => {
    it('should validate legacy addresses', () => {
      expect(validateBTCAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe(true);
      expect(validateBTCAddress('1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa')).toBe(true);
    });
    
    it('should validate SegWit addresses', () => {
      expect(validateBTCAddress('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBe(true);
      expect(validateBTCAddress('bc1q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7c')).toBe(true);
    });
    
    it('should validate P2SH addresses', () => {
      expect(validateBTCAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe(true);
      expect(validateBTCAddress('342ftSRCvFHfCeFFBuz4xwbeqnDw6BGUey')).toBe(true);
    });
    
    it('should reject invalid addresses', () => {
      expect(validateBTCAddress('invalid')).toBe(false);
      expect(validateBTCAddress('1234567890')).toBe(false);
      expect(validateBTCAddress('')).toBe(false);
      expect(validateBTCAddress(null)).toBe(false);
      expect(validateBTCAddress(undefined)).toBe(false);
    });
    
    it('should handle testnet addresses', () => {
      expect(validateBTCAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', true)).toBe(true);
      expect(validateBTCAddress('2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc', true)).toBe(true);
    });
  });
});

describe('Constants', () => {
  describe('POOL_OPERATOR', () => {
    it('should be immutable', () => {
      expect(() => {
        POOL_OPERATOR.BTC_ADDRESS = 'different';
      }).toThrow();
      
      expect(() => {
        POOL_OPERATOR.NEW_FIELD = 'value';
      }).toThrow();
      
      expect(() => {
        delete POOL_OPERATOR.NAME;
      }).toThrow();
    });
    
    it('should have correct values', () => {
      expect(POOL_OPERATOR.BTC_ADDRESS).toBe('1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa');
      expect(POOL_OPERATOR.NAME).toBe('Otedama Mining Pool');
      expect(POOL_OPERATOR.VERSION).toBe('1.1.2');
    });
    
    it('should prevent nested modifications', () => {
      // This would only work if we had nested objects
      // For now, all values are primitives
      expect(Object.isFrozen(POOL_OPERATOR)).toBe(true);
    });
  });
});