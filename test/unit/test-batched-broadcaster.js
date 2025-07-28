/**
 * Unit Tests for Batched Broadcaster
 */

import { BatchedBroadcaster, PriorityBatchedBroadcaster } from '../../lib/network/batched-broadcaster.js';
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { EventEmitter } from 'events';

// Mock WebSocket connection
class MockConnection extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.sentMessages = [];
    this.isOpen = true;
  }
  
  send(message) {
    if (!this.isOpen) throw new Error('Connection closed');
    this.sentMessages.push(message);
  }
  
  close() {
    this.isOpen = false;
    this.emit('close');
  }
}

describe('BatchedBroadcaster', () => {
  let broadcaster;
  let connections;
  
  beforeEach(() => {
    broadcaster = new BatchedBroadcaster({
      batchSize: 3,
      flushInterval: 50,
      compressionThreshold: 100
    });
    
    connections = {
      conn1: new MockConnection('conn1'),
      conn2: new MockConnection('conn2'),
      conn3: new MockConnection('conn3')
    };
    
    broadcaster.start();
    
    // Add connections
    for (const [id, conn] of Object.entries(connections)) {
      broadcaster.addConnection(id, conn);
    }
  });
  
  afterEach(() => {
    broadcaster.stop();
  });
  
  describe('Basic Broadcasting', () => {
    it('should batch messages', async () => {
      broadcaster.broadcast({ type: 'test', data: 1 });
      broadcaster.broadcast({ type: 'test', data: 2 });
      
      // Messages should not be sent yet
      expect(connections.conn1.sentMessages).toHaveLength(0);
      
      // Third message triggers batch
      broadcaster.broadcast({ type: 'test', data: 3 });
      
      // Now messages should be sent
      expect(connections.conn1.sentMessages).toHaveLength(1);
      
      const batch = JSON.parse(connections.conn1.sentMessages[0]);
      expect(batch.compressed).toBe(false);
      
      const payload = JSON.parse(batch.payload);
      expect(payload.type).toBe('batch');
      expect(payload.count).toBe(3);
      expect(payload.messages).toHaveLength(3);
    });
    
    it('should flush on timer', async () => {
      broadcaster.broadcast({ type: 'test', data: 1 });
      
      expect(connections.conn1.sentMessages).toHaveLength(0);
      
      // Wait for flush interval
      await new Promise(resolve => setTimeout(resolve, 60));
      
      expect(connections.conn1.sentMessages).toHaveLength(1);
    });
    
    it('should compress large messages', () => {
      const largeData = 'x'.repeat(200);
      broadcaster.broadcast({ type: 'test', data: largeData });
      broadcaster.broadcast({ type: 'test', data: largeData });
      broadcaster.broadcast({ type: 'test', data: largeData });
      
      const batch = JSON.parse(connections.conn1.sentMessages[0]);
      expect(batch.compressed).toBe(true);
      
      // Decode to verify
      const decoded = BatchedBroadcaster.decodeFrame(connections.conn1.sentMessages[0]);
      expect(decoded.messages).toHaveLength(3);
      expect(decoded.messages[0]).toContain(largeData);
    });
    
    it('should handle connection removal', () => {
      broadcaster.broadcast({ type: 'test', data: 1 });
      
      // Remove connection
      connections.conn2.close();
      
      // Broadcast more
      broadcaster.broadcast({ type: 'test', data: 2 });
      broadcaster.broadcast({ type: 'test', data: 3 });
      
      // conn2 should only have first message
      expect(connections.conn2.sentMessages).toHaveLength(1);
      
      // Others should have both batches
      expect(connections.conn1.sentMessages).toHaveLength(1);
    });
  });
  
  describe('Unicast and Multicast', () => {
    it('should unicast to specific connection', () => {
      broadcaster.unicast('conn1', { type: 'private', data: 'secret' });
      broadcaster.unicast('conn1', { type: 'private', data: 'secret2' });
      broadcaster.unicast('conn1', { type: 'private', data: 'secret3' });
      
      expect(connections.conn1.sentMessages).toHaveLength(1);
      expect(connections.conn2.sentMessages).toHaveLength(0);
      expect(connections.conn3.sentMessages).toHaveLength(0);
    });
    
    it('should multicast to specific connections', () => {
      broadcaster.multicast(['conn1', 'conn3'], { type: 'group', data: 'shared' });
      broadcaster.multicast(['conn1', 'conn3'], { type: 'group', data: 'shared2' });
      broadcaster.multicast(['conn1', 'conn3'], { type: 'group', data: 'shared3' });
      
      expect(connections.conn1.sentMessages).toHaveLength(1);
      expect(connections.conn2.sentMessages).toHaveLength(0);
      expect(connections.conn3.sentMessages).toHaveLength(1);
    });
    
    it('should exclude specific connections', () => {
      broadcaster.broadcast({ type: 'public', data: 'all' }, { exclude: ['conn2'] });
      broadcaster.broadcast({ type: 'public', data: 'all2' }, { exclude: ['conn2'] });
      broadcaster.broadcast({ type: 'public', data: 'all3' }, { exclude: ['conn2'] });
      
      expect(connections.conn1.sentMessages).toHaveLength(1);
      expect(connections.conn2.sentMessages).toHaveLength(0);
      expect(connections.conn3.sentMessages).toHaveLength(1);
    });
  });
  
  describe('Size Limits', () => {
    it('should respect max batch size in bytes', () => {
      broadcaster.config.maxBatchBytes = 200;
      
      const message = { type: 'test', data: 'x'.repeat(50) };
      
      // Each message is ~70 bytes
      broadcaster.broadcast(message);
      broadcaster.broadcast(message);
      
      // Should not flush yet
      expect(connections.conn1.sentMessages).toHaveLength(0);
      
      // This should exceed limit and flush
      broadcaster.broadcast(message);
      
      // Should have flushed the first two
      expect(connections.conn1.sentMessages).toHaveLength(1);
      const batch = JSON.parse(JSON.parse(connections.conn1.sentMessages[0]).payload);
      expect(batch.messages).toHaveLength(2);
    });
  });
  
  describe('Statistics', () => {
    it('should track statistics', () => {
      broadcaster.broadcast({ type: 'test' });
      broadcaster.broadcast({ type: 'test' });
      broadcaster.broadcast({ type: 'test' });
      
      const stats = broadcaster.getStats();
      expect(stats.messagesSent).toBe(3);
      expect(stats.batchesSent).toBe(1);
      expect(stats.activeConnections).toBe(3);
      expect(stats.avgBatchSize).toBe(3);
    });
    
    it('should track compression ratio', () => {
      const largeMessage = { type: 'test', data: 'x'.repeat(500) };
      broadcaster.broadcast(largeMessage);
      broadcaster.broadcast(largeMessage);
      broadcaster.broadcast(largeMessage);
      
      const stats = broadcaster.getStats();
      expect(stats.compressionRatio).toBeGreaterThan(0);
      expect(stats.bytesCompressed).toBeLessThan(stats.bytesOriginal);
    });
  });
  
  describe('Error Handling', () => {
    it('should handle send errors gracefully', () => {
      const errorConn = new MockConnection('error');
      errorConn.send = jest.fn().mockImplementation(() => {
        throw new Error('Send failed');
      });
      
      broadcaster.addConnection('error', errorConn);
      
      // Should not throw
      expect(() => {
        broadcaster.broadcast({ type: 'test' });
        broadcaster.broadcast({ type: 'test' });
        broadcaster.broadcast({ type: 'test' });
      }).not.toThrow();
      
      // Batch should be cleared to prevent memory leak
      expect(broadcaster.batches.get('error')).toEqual([]);
    });
    
    it('should handle closed connections', () => {
      connections.conn1.close();
      
      // Should not throw
      expect(() => {
        broadcaster.unicast('conn1', { type: 'test' });
        broadcaster.flush('conn1');
      }).not.toThrow();
    });
  });
});

describe('PriorityBatchedBroadcaster', () => {
  let broadcaster;
  let connections;
  
  beforeEach(() => {
    broadcaster = new PriorityBatchedBroadcaster({
      batchSize: 5,
      flushInterval: 50
    });
    
    connections = {
      conn1: new MockConnection('conn1')
    };
    
    broadcaster.start();
    broadcaster.addConnection('conn1', connections.conn1);
  });
  
  afterEach(() => {
    broadcaster.stop();
  });
  
  describe('Priority Handling', () => {
    it('should send critical messages immediately', () => {
      broadcaster.broadcast({ type: 'critical', data: 'urgent' }, { priority: 'critical' });
      
      expect(connections.conn1.sentMessages).toHaveLength(1);
      expect(connections.conn1.sentMessages[0]).toContain('urgent');
    });
    
    it('should batch non-critical messages by priority', () => {
      broadcaster.broadcast({ type: 'low', data: 1 }, { priority: 'low' });
      broadcaster.broadcast({ type: 'normal', data: 2 }, { priority: 'normal' });
      broadcaster.broadcast({ type: 'high', data: 3 }, { priority: 'high' });
      broadcaster.broadcast({ type: 'normal', data: 4 }, { priority: 'normal' });
      broadcaster.broadcast({ type: 'low', data: 5 }, { priority: 'low' });
      
      // Trigger flush
      const frame = JSON.parse(connections.conn1.sentMessages[0]);
      const batch = JSON.parse(frame.payload);
      
      // Check order: high, normal, normal, low, low
      expect(batch.messages[0]).toContain('"data":3');
      expect(batch.messages[1]).toContain('"data":2');
      expect(batch.messages[2]).toContain('"data":4');
      expect(batch.messages[3]).toContain('"data":1');
      expect(batch.messages[4]).toContain('"data":5');
    });
  });
});