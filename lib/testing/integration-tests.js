/**
 * Integration Test Suite for Otedama
 * Tests interactions between components
 * 
 * Design principles:
 * - Carmack: Fast integration tests
 * - Martin: Test clean interfaces
 * - Pike: Simple test scenarios
 */

import { describe, it } from './test-framework.js';
import { createTestServer, createTestData, wait, waitFor } from './test-utils.js';
import { WebSocket } from 'ws';
import fetch from 'node-fetch';
import { logger } from '../core/logger.js';

/**
 * API Integration Tests
 */
export const apiIntegrationTests = describe('API Integration', function() {
  let server;
  let baseURL;
  
  this.before(async () => {
    server = createTestServer();
    baseURL = await server.startHTTP(async (req, res) => {
      // Mock API handler
      const url = new URL(req.url, `http://${req.headers.host}`);
      
      if (url.pathname === '/api/v1/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'healthy' }));
      } else if (url.pathname === '/api/v1/users') {
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ users: [] }));
        } else if (req.method === 'POST') {
          let body = '';
          req.on('data', chunk => body += chunk);
          req.on('end', () => {
            const user = JSON.parse(body);
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id: '123', ...user }));
          });
        }
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });
  });
  
  this.after(async () => {
    await server.stop();
  });
  
  this.it('should check health endpoint', async ({ expect }) => {
    const response = await fetch(`${baseURL}/api/v1/health`);
    const data = await response.json();
    
    expect(response.status).toBe(200);
    expect(data.status).toBe('healthy');
  });
  
  this.it('should create and retrieve users', async ({ expect }) => {
    // Create user
    const newUser = { name: 'Test User', email: 'test@example.com' };
    const createResponse = await fetch(`${baseURL}/api/v1/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newUser)
    });
    
    const createdUser = await createResponse.json();
    expect(createResponse.status).toBe(201);
    expect(createdUser.id).toBeTruthy();
    expect(createdUser.name).toBe(newUser.name);
    
    // Get users
    const getResponse = await fetch(`${baseURL}/api/v1/users`);
    const data = await getResponse.json();
    
    expect(getResponse.status).toBe(200);
    expect(data.users).toEqual([]);
  });
  
  this.it('should handle 404 errors', async ({ expect }) => {
    const response = await fetch(`${baseURL}/api/v1/nonexistent`);
    expect(response.status).toBe(404);
  });
});

/**
 * WebSocket Integration Tests
 */
export const websocketIntegrationTests = describe('WebSocket Integration', function() {
  let server;
  let wsURL;
  
  this.before(async () => {
    server = createTestServer();
    wsURL = await server.startWebSocket((ws) => {
      ws.on('message', (message) => {
        const data = JSON.parse(message);
        
        switch (data.type) {
          case 'ping':
            ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            break;
            
          case 'echo':
            ws.send(JSON.stringify({ type: 'echo', payload: data.payload }));
            break;
            
          case 'broadcast':
            // Broadcast to all clients
            server.wss.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                  type: 'broadcast',
                  payload: data.payload,
                  from: ws.id
                }));
              }
            });
            break;
        }
      });
      
      // Assign ID to connection
      ws.id = Math.random().toString(36).substr(2, 9);
      ws.send(JSON.stringify({ type: 'connected', id: ws.id }));
    });
  });
  
  this.after(async () => {
    await server.stop();
  });
  
  this.it('should establish WebSocket connection', async ({ expect }) => {
    const ws = new WebSocket(wsURL);
    
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    
    const message = await new Promise(resolve => {
      ws.on('message', (data) => resolve(JSON.parse(data)));
    });
    
    expect(message.type).toBe('connected');
    expect(message.id).toBeTruthy();
    
    ws.close();
  });
  
  this.it('should handle ping-pong', async ({ expect }) => {
    const ws = new WebSocket(wsURL);
    await waitFor(() => ws.readyState === WebSocket.OPEN);
    
    ws.send(JSON.stringify({ type: 'ping' }));
    
    const response = await new Promise(resolve => {
      ws.on('message', (data) => {
        const message = JSON.parse(data);
        if (message.type === 'pong') resolve(message);
      });
    });
    
    expect(response.type).toBe('pong');
    expect(response.timestamp).toBeGreaterThan(0);
    
    ws.close();
  });
  
  this.it('should echo messages', async ({ expect }) => {
    const ws = new WebSocket(wsURL);
    await waitFor(() => ws.readyState === WebSocket.OPEN);
    
    const testPayload = { data: 'test', number: 42 };
    ws.send(JSON.stringify({ type: 'echo', payload: testPayload }));
    
    const response = await new Promise(resolve => {
      ws.on('message', (data) => {
        const message = JSON.parse(data);
        if (message.type === 'echo') resolve(message);
      });
    });
    
    expect(response.type).toBe('echo');
    expect(response.payload).toEqual(testPayload);
    
    ws.close();
  });
  
  this.it('should broadcast to multiple clients', async ({ expect }) => {
    const ws1 = new WebSocket(wsURL);
    const ws2 = new WebSocket(wsURL);
    
    await Promise.all([
      waitFor(() => ws1.readyState === WebSocket.OPEN),
      waitFor(() => ws2.readyState === WebSocket.OPEN)
    ]);
    
    // Clear initial messages
    await wait(100);
    
    const received = [];
    ws2.on('message', (data) => {
      const message = JSON.parse(data);
      if (message.type === 'broadcast') received.push(message);
    });
    
    ws1.send(JSON.stringify({
      type: 'broadcast',
      payload: 'Hello everyone!'
    }));
    
    await wait(100);
    
    expect(received.length).toBe(1);
    expect(received[0].payload).toBe('Hello everyone!');
    
    ws1.close();
    ws2.close();
  });
});

/**
 * Database Integration Tests
 */
export const databaseIntegrationTests = describe('Database Integration', function() {
  let db;
  const testData = createTestData();
  
  this.before(async () => {
    // Mock database connection
    db = {
      users: new Map(),
      posts: new Map(),
      
      async createUser(user) {
        const id = testData.uuid();
        const newUser = { id, ...user, createdAt: new Date() };
        this.users.set(id, newUser);
        return newUser;
      },
      
      async getUser(id) {
        return this.users.get(id) || null;
      },
      
      async updateUser(id, updates) {
        const user = this.users.get(id);
        if (!user) throw new Error('User not found');
        
        const updated = { ...user, ...updates, updatedAt: new Date() };
        this.users.set(id, updated);
        return updated;
      },
      
      async deleteUser(id) {
        return this.users.delete(id);
      },
      
      async createPost(userId, post) {
        const id = testData.uuid();
        const newPost = { id, userId, ...post, createdAt: new Date() };
        this.posts.set(id, newPost);
        return newPost;
      },
      
      async getUserPosts(userId) {
        return Array.from(this.posts.values())
          .filter(post => post.userId === userId);
      }
    };
  });
  
  this.it('should perform CRUD operations', async ({ expect }) => {
    // Create
    const userData = {
      name: testData.string(),
      email: testData.email()
    };
    
    const user = await db.createUser(userData);
    expect(user.id).toBeTruthy();
    expect(user.name).toBe(userData.name);
    expect(user.email).toBe(userData.email);
    expect(user.createdAt).toBeTruthy();
    
    // Read
    const retrieved = await db.getUser(user.id);
    expect(retrieved).toEqual(user);
    
    // Update
    const updates = { name: 'Updated Name' };
    const updated = await db.updateUser(user.id, updates);
    expect(updated.name).toBe(updates.name);
    expect(updated.updatedAt).toBeTruthy();
    
    // Delete
    const deleted = await db.deleteUser(user.id);
    expect(deleted).toBe(true);
    
    const notFound = await db.getUser(user.id);
    expect(notFound).toBe(null);
  });
  
  this.it('should handle relationships', async ({ expect }) => {
    // Create user
    const user = await db.createUser({
      name: 'Post Author',
      email: 'author@example.com'
    });
    
    // Create posts
    const post1 = await db.createPost(user.id, {
      title: 'First Post',
      content: 'Hello World'
    });
    
    const post2 = await db.createPost(user.id, {
      title: 'Second Post',
      content: 'Another post'
    });
    
    // Get user posts
    const userPosts = await db.getUserPosts(user.id);
    expect(userPosts).toHaveLength(2);
    expect(userPosts[0].userId).toBe(user.id);
    expect(userPosts[1].userId).toBe(user.id);
  });
  
  this.it('should handle errors', async ({ expect }) => {
    await expect(() => 
      db.updateUser('nonexistent', { name: 'Test' })
    ).toThrow('User not found');
  });
});

/**
 * Cache Integration Tests
 */
export const cacheIntegrationTests = describe('Cache Integration', function() {
  let cache;
  let db;
  
  this.before(async () => {
    // Mock cache
    cache = {
      storage: new Map(),
      
      async get(key) {
        const entry = this.storage.get(key);
        if (!entry) return null;
        
        if (entry.expiry && entry.expiry < Date.now()) {
          this.storage.delete(key);
          return null;
        }
        
        return entry.value;
      },
      
      async set(key, value, ttl = 0) {
        const entry = {
          value,
          expiry: ttl > 0 ? Date.now() + ttl : null
        };
        
        this.storage.set(key, entry);
        return true;
      },
      
      async delete(key) {
        return this.storage.delete(key);
      },
      
      async clear() {
        this.storage.clear();
      }
    };
    
    // Mock database
    db = {
      data: new Map(),
      
      async get(id) {
        // Simulate slow database query
        await wait(50);
        return this.data.get(id) || null;
      },
      
      async set(id, value) {
        await wait(50);
        this.data.set(id, value);
        return true;
      }
    };
  });
  
  this.afterEach(async () => {
    await cache.clear();
  });
  
  this.it('should cache database queries', async ({ expect }) => {
    const getData = async (id) => {
      // Check cache first
      const cached = await cache.get(`data:${id}`);
      if (cached) return cached;
      
      // Fetch from database
      const data = await db.get(id);
      if (data) {
        await cache.set(`data:${id}`, data, 1000); // 1 second TTL
      }
      
      return data;
    };
    
    // Set data in database
    await db.set('123', { name: 'Test Data' });
    
    // First call - hits database
    const start1 = performance.now();
    const data1 = await getData('123');
    const time1 = performance.now() - start1;
    
    expect(data1.name).toBe('Test Data');
    expect(time1).toBeGreaterThan(40); // Database delay
    
    // Second call - hits cache
    const start2 = performance.now();
    const data2 = await getData('123');
    const time2 = performance.now() - start2;
    
    expect(data2).toEqual(data1);
    expect(time2).toBeLessThan(10); // Cache is fast
  });
  
  this.it('should handle cache expiration', async ({ expect }) => {
    await cache.set('temp', 'value', 100); // 100ms TTL
    
    // Should exist immediately
    const value1 = await cache.get('temp');
    expect(value1).toBe('value');
    
    // Wait for expiration
    await wait(150);
    
    // Should be expired
    const value2 = await cache.get('temp');
    expect(value2).toBe(null);
  });
  
  this.it('should invalidate cache on updates', async ({ expect }) => {
    const updateData = async (id, value) => {
      // Update database
      await db.set(id, value);
      
      // Invalidate cache
      await cache.delete(`data:${id}`);
    };
    
    // Set initial data
    await db.set('456', { version: 1 });
    await cache.set('data:456', { version: 1 });
    
    // Update data
    await updateData('456', { version: 2 });
    
    // Cache should be invalidated
    const cached = await cache.get('data:456');
    expect(cached).toBe(null);
    
    // Database should have new value
    const dbValue = await db.get('456');
    expect(dbValue.version).toBe(2);
  });
});

/**
 * Message Queue Integration Tests
 */
export const messageQueueIntegrationTests = describe('Message Queue Integration', function() {
  let queue;
  
  this.before(async () => {
    // Mock message queue
    queue = {
      messages: [],
      handlers: new Map(),
      processing: false,
      
      async publish(topic, message) {
        this.messages.push({
          id: Math.random().toString(36).substr(2, 9),
          topic,
          message,
          timestamp: Date.now(),
          attempts: 0
        });
        
        // Process messages async
        if (!this.processing) {
          this.processing = true;
          setImmediate(() => this.processMessages());
        }
      },
      
      subscribe(topic, handler) {
        if (!this.handlers.has(topic)) {
          this.handlers.set(topic, []);
        }
        this.handlers.get(topic).push(handler);
      },
      
      async processMessages() {
        while (this.messages.length > 0) {
          const msg = this.messages.shift();
          const handlers = this.handlers.get(msg.topic) || [];
          
          for (const handler of handlers) {
            try {
              await handler(msg.message, msg);
            } catch (error) {
              msg.attempts++;
              if (msg.attempts < 3) {
                // Retry
                this.messages.push(msg);
              } else {
                // Dead letter
                logger.error('Message processing failed', error);
              }
            }
          }
        }
        
        this.processing = false;
      }
    };
  });
  
  this.it('should publish and subscribe to messages', async ({ expect }) => {
    const received = [];
    
    queue.subscribe('test.topic', async (message) => {
      received.push(message);
    });
    
    await queue.publish('test.topic', { data: 'Hello' });
    await queue.publish('test.topic', { data: 'World' });
    
    await wait(100); // Allow processing
    
    expect(received).toHaveLength(2);
    expect(received[0].data).toBe('Hello');
    expect(received[1].data).toBe('World');
  });
  
  this.it('should handle multiple subscribers', async ({ expect }) => {
    const handler1Results = [];
    const handler2Results = [];
    
    queue.subscribe('broadcast', async (message) => {
      handler1Results.push(message);
    });
    
    queue.subscribe('broadcast', async (message) => {
      handler2Results.push(message);
    });
    
    await queue.publish('broadcast', { event: 'test' });
    await wait(100);
    
    expect(handler1Results).toHaveLength(1);
    expect(handler2Results).toHaveLength(1);
    expect(handler1Results[0]).toEqual(handler2Results[0]);
  });
  
  this.it('should retry failed messages', async ({ expect }) => {
    let attempts = 0;
    
    queue.subscribe('retry.test', async (message) => {
      attempts++;
      if (attempts < 2) {
        throw new Error('Processing failed');
      }
    });
    
    await queue.publish('retry.test', { retry: true });
    await wait(200);
    
    expect(attempts).toBe(2); // First attempt + 1 retry
  });
});

/**
 * Export all test suites
 */
export default [
  apiIntegrationTests,
  websocketIntegrationTests,
  databaseIntegrationTests,
  cacheIntegrationTests,
  messageQueueIntegrationTests
];