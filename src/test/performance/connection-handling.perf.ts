// Connection handling performance tests
// Testing WebSocket and TCP connection management

import { perfTest } from './performance-test-framework';
import * as net from 'net';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';

/**
 * Mock connection for testing
 */
class MockConnection extends EventEmitter {
  id: string;
  authorized: boolean = false;
  lastActivity: number = Date.now();
  difficulty: number = 1024;
  extraNonce1: string;
  
  constructor() {
    super();
    this.id = crypto.randomBytes(16).toString('hex');
    this.extraNonce1 = crypto.randomBytes(4).toString('hex');
  }
  
  write(data: any): boolean {
    // Simulate network write
    return true;
  }
  
  destroy(): void {
    this.removeAllListeners();
  }
}

/**
 * Connection pool for testing
 */
class ConnectionPool {
  private connections: Map<string, MockConnection> = new Map();
  private connectionsByMiner: Map<string, Set<string>> = new Map();
  
  add(connection: MockConnection, minerId?: string): void {
    this.connections.set(connection.id, connection);
    
    if (minerId) {
      if (!this.connectionsByMiner.has(minerId)) {
        this.connectionsByMiner.set(minerId, new Set());
      }
      this.connectionsByMiner.get(minerId)!.add(connection.id);
    }
  }
  
  remove(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    
    this.connections.delete(connectionId);
    
    // Remove from miner mapping
    for (const [minerId, connections] of this.connectionsByMiner) {
      if (connections.has(connectionId)) {
        connections.delete(connectionId);
        if (connections.size === 0) {
          this.connectionsByMiner.delete(minerId);
        }
        break;
      }
    }
  }
  
  get(connectionId: string): MockConnection | undefined {
    return this.connections.get(connectionId);
  }
  
  getByMiner(minerId: string): MockConnection[] {
    const connectionIds = this.connectionsByMiner.get(minerId);
    if (!connectionIds) return [];
    
    return Array.from(connectionIds)
      .map(id => this.connections.get(id))
      .filter(conn => conn !== undefined) as MockConnection[];
  }
  
  getAll(): MockConnection[] {
    return Array.from(this.connections.values());
  }
  
  size(): number {
    return this.connections.size;
  }
}

/**
 * Connection handling performance tests
 */
export class ConnectionHandlingPerformance {
  private pool: ConnectionPool;
  private testConnections: MockConnection[] = [];
  
  constructor() {
    this.pool = new ConnectionPool();
    this.generateTestConnections();
  }
  
  /**
   * Generate test connections
   */
  private generateTestConnections(): void {
    for (let i = 0; i < 10000; i++) {
      this.testConnections.push(new MockConnection());
    }
  }
  
  /**
   * Test connection addition
   */
  async testConnectionAddition(): Promise<void> {
    let index = 0;
    
    await perfTest.run(() => {
      const connection = this.testConnections[index % this.testConnections.length];
      const minerId = `miner-${Math.floor(index / 10)}`; // 10 connections per miner
      index++;
      
      this.pool.add(connection, minerId);
    }, {
      name: 'Connection Addition',
      iterations: 10000,
      warmupIterations: 100
    });
  }
  
  /**
   * Test connection removal
   */
  async testConnectionRemoval(): Promise<void> {
    // Pre-populate pool
    for (let i = 0; i < 5000; i++) {
      const connection = this.testConnections[i];
      const minerId = `miner-${Math.floor(i / 10)}`;
      this.pool.add(connection, minerId);
    }
    
    let index = 0;
    
    await perfTest.run(() => {
      const connection = this.testConnections[index % 5000];
      index++;
      
      this.pool.remove(connection.id);
      
      // Re-add for next iteration
      const minerId = `miner-${Math.floor(index / 10)}`;
      this.pool.add(connection, minerId);
    }, {
      name: 'Connection Removal',
      iterations: 5000,
      warmupIterations: 100
    });
  }
  
  /**
   * Test connection lookup
   */
  async testConnectionLookup(): Promise<void> {
    // Pre-populate pool
    for (let i = 0; i < 10000; i++) {
      const connection = this.testConnections[i];
      const minerId = `miner-${Math.floor(i / 10)}`;
      this.pool.add(connection, minerId);
    }
    
    const connectionIds = this.testConnections.map(c => c.id);
    let index = 0;
    
    await perfTest.run(() => {
      const connectionId = connectionIds[index % connectionIds.length];
      index++;
      
      const connection = this.pool.get(connectionId);
      return connection !== undefined;
    }, {
      name: 'Connection Lookup',
      iterations: 100000,
      warmupIterations: 1000
    });
  }
  
  /**
   * Test miner connection lookup
   */
  async testMinerConnectionLookup(): Promise<void> {
    // Pre-populate pool
    for (let i = 0; i < 10000; i++) {
      const connection = this.testConnections[i];
      const minerId = `miner-${Math.floor(i / 10)}`;
      this.pool.add(connection, minerId);
    }
    
    let minerIndex = 0;
    
    await perfTest.run(() => {
      const minerId = `miner-${minerIndex % 1000}`;
      minerIndex++;
      
      const connections = this.pool.getByMiner(minerId);
      return connections.length;
    }, {
      name: 'Miner Connection Lookup',
      iterations: 10000,
      warmupIterations: 100
    });
  }
  
  /**
   * Test broadcast to all connections
   */
  async testBroadcast(): Promise<void> {
    // Pre-populate pool with 1000 connections
    for (let i = 0; i < 1000; i++) {
      const connection = this.testConnections[i];
      const minerId = `miner-${Math.floor(i / 10)}`;
      this.pool.add(connection, minerId);
    }
    
    const message = JSON.stringify({
      id: null,
      method: 'mining.notify',
      params: [
        'job-123',
        '00000000000000000000000000000000',
        '00000000',
        '00000000',
        [],
        '00000000',
        '00000000',
        '00000000',
        true
      ]
    });
    
    await perfTest.run(() => {
      const connections = this.pool.getAll();
      for (const connection of connections) {
        connection.write(message);
      }
    }, {
      name: 'Broadcast to 1000 connections',
      iterations: 100,
      warmupIterations: 10
    });
  }
  
  /**
   * Test connection activity tracking
   */
  async testActivityTracking(): Promise<void> {
    // Pre-populate pool
    for (let i = 0; i < 10000; i++) {
      const connection = this.testConnections[i];
      const minerId = `miner-${Math.floor(i / 10)}`;
      this.pool.add(connection, minerId);
    }
    
    await perfTest.run(() => {
      const now = Date.now();
      const timeout = 300000; // 5 minutes
      let inactiveCount = 0;
      
      for (const connection of this.pool.getAll()) {
        if (now - connection.lastActivity > timeout) {
          inactiveCount++;
        }
      }
      
      return inactiveCount;
    }, {
      name: 'Activity Tracking (10k connections)',
      iterations: 100,
      warmupIterations: 10
    });
  }
  
  /**
   * Compare different connection storage strategies
   */
  async compareStorageStrategies(): Promise<void> {
    // Strategy A: Map-based storage
    class MapStorage {
      private connections = new Map<string, MockConnection>();
      
      add(conn: MockConnection): void {
        this.connections.set(conn.id, conn);
      }
      
      remove(id: string): void {
        this.connections.delete(id);
      }
      
      get(id: string): MockConnection | undefined {
        return this.connections.get(id);
      }
      
      getAll(): MockConnection[] {
        return Array.from(this.connections.values());
      }
    }
    
    // Strategy B: Array-based storage with index
    class ArrayStorage {
      private connections: MockConnection[] = [];
      private index = new Map<string, number>();
      
      add(conn: MockConnection): void {
        const idx = this.connections.length;
        this.connections.push(conn);
        this.index.set(conn.id, idx);
      }
      
      remove(id: string): void {
        const idx = this.index.get(id);
        if (idx === undefined) return;
        
        // Swap with last element and pop
        const lastIdx = this.connections.length - 1;
        if (idx !== lastIdx) {
          const lastConn = this.connections[lastIdx];
          this.connections[idx] = lastConn;
          this.index.set(lastConn.id, idx);
        }
        
        this.connections.pop();
        this.index.delete(id);
      }
      
      get(id: string): MockConnection | undefined {
        const idx = this.index.get(id);
        return idx !== undefined ? this.connections[idx] : undefined;
      }
      
      getAll(): MockConnection[] {
        return this.connections;
      }
    }
    
    const mapStorage = new MapStorage();
    const arrayStorage = new ArrayStorage();
    
    // Pre-populate both
    for (let i = 0; i < 1000; i++) {
      const conn = new MockConnection();
      mapStorage.add(conn);
      arrayStorage.add(conn);
    }
    
    const testIds = Array.from({ length: 100 }, () => 
      this.testConnections[Math.floor(Math.random() * 1000)].id
    );
    
    const result = await perfTest.compare(
      'Connection Storage Strategies',
      () => {
        for (const id of testIds) {
          mapStorage.get(id);
        }
      },
      () => {
        for (const id of testIds) {
          arrayStorage.get(id);
        }
      },
      {
        iterations: 10000,
        warmupIterations: 100
      }
    );
    
    console.log(`\nStorage comparison: ${result.comparison.winner} is ${result.comparison.speedup.toFixed(2)}x faster`);
  }
  
  /**
   * Test message parsing performance
   */
  async testMessageParsing(): Promise<void> {
    const messages = [
      '{"id":1,"method":"mining.subscribe","params":["cgminer/4.10.0",null]}',
      '{"id":2,"method":"mining.authorize","params":["worker.1","password"]}',
      '{"id":3,"method":"mining.submit","params":["worker.1","job123","00000000","5e9a5f3e","00000000"]}',
      '{"id":4,"method":"mining.get_transactions","params":["job123"]}',
      '{"id":null,"method":"mining.notify","params":["job123","prevhash","coinb1","coinb2",[],"version","nbits","ntime",true]}'
    ];
    
    let messageIndex = 0;
    
    await perfTest.run(() => {
      const message = messages[messageIndex % messages.length];
      messageIndex++;
      
      try {
        const parsed = JSON.parse(message);
        return parsed.method !== undefined;
      } catch {
        return false;
      }
    }, {
      name: 'Message Parsing',
      iterations: 100000,
      warmupIterations: 1000
    });
  }
  
  /**
   * Run all connection handling performance tests
   */
  async runAll(): Promise<void> {
    await perfTest.suite('Connection Handling Performance', [
      { name: 'Connection Add', fn: () => this.testConnectionAddition() },
      { name: 'Connection Remove', fn: () => this.testConnectionRemoval() },
      { name: 'Connection Lookup', fn: () => this.testConnectionLookup() },
      { name: 'Miner Lookup', fn: () => this.testMinerConnectionLookup() },
      { name: 'Broadcast', fn: () => this.testBroadcast() },
      { name: 'Activity Tracking', fn: () => this.testActivityTracking() },
      { name: 'Storage Comparison', fn: () => this.compareStorageStrategies() },
      { name: 'Message Parsing', fn: () => this.testMessageParsing() }
    ]);
  }
}

// Run tests if executed directly
if (require.main === module) {
  const test = new ConnectionHandlingPerformance();
  test.runAll().catch(console.error);
}
