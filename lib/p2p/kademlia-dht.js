// Kademlia Distributed Hash Table Implementation
// For efficient peer discovery and data storage in P2P mining pools

import EventEmitter from 'events';
import crypto from 'crypto';
import { createLogger } from '../core/logger.js';

const logger = createLogger('kademlia-dht');

// Kademlia constants
const K = 20; // Bucket size
const ALPHA = 3; // Parallelism parameter
const ID_LENGTH = 256; // 256-bit node IDs
const REFRESH_INTERVAL = 3600000; // 1 hour
const REPLICATE_INTERVAL = 3600000; // 1 hour
const REPUBLISH_INTERVAL = 86400000; // 24 hours
const EXPIRE_TIME = 86400000; // 24 hours

export class KademliaDHT extends EventEmitter {
  constructor(nodeId, options = {}) {
    super();
    
    this.nodeId = nodeId || this.generateNodeId();
    this.config = {
      k: options.k || K,
      alpha: options.alpha || ALPHA,
      refreshInterval: options.refreshInterval || REFRESH_INTERVAL,
      replicateInterval: options.replicateInterval || REPLICATE_INTERVAL,
      republishInterval: options.republishInterval || REPUBLISH_INTERVAL,
      expireTime: options.expireTime || EXPIRE_TIME,
      ...options
    };
    
    // Routing table
    this.routingTable = new RoutingTable(this.nodeId, this.config.k);
    
    // Storage
    this.storage = new Map();
    this.storageTimestamps = new Map();
    
    // RPC tracking
    this.rpcCallbacks = new Map();
    this.rpcTimeout = options.rpcTimeout || 5000;
    
    // Timers
    this.timers = new Map();
  }

  async initialize() {
    logger.info(`Initializing Kademlia DHT with node ID: ${this.nodeId.toString('hex')}`);
    
    // Start maintenance tasks
    this.startMaintenanceTasks();
    
    return this;
  }

  // Core Kademlia operations
  async ping(nodeInfo) {
    return this.sendRPC(nodeInfo, 'PING', {});
  }

  async store(key, value) {
    const keyId = this.hash(key);
    
    // Store locally
    this.storage.set(keyId.toString('hex'), value);
    this.storageTimestamps.set(keyId.toString('hex'), Date.now());
    
    // Find k closest nodes
    const closest = await this.findNode(keyId);
    
    // Store on k closest nodes
    const storePromises = closest.map(node => 
      this.sendRPC(node, 'STORE', { key: keyId.toString('hex'), value })
    );
    
    await Promise.allSettled(storePromises);
    
    logger.info(`Stored key ${key} on ${closest.length} nodes`);
  }

  async findValue(key) {
    const keyId = this.hash(key);
    const keyHex = keyId.toString('hex');
    
    // Check local storage first
    if (this.storage.has(keyHex)) {
      return this.storage.get(keyHex);
    }
    
    // Perform iterative find value
    const visited = new Set();
    const active = new Map();
    const shortlist = this.routingTable.findClosest(keyId, this.config.alpha);
    
    for (const node of shortlist) {
      active.set(node.id.toString('hex'), node);
    }
    
    while (active.size > 0) {
      // Get alpha closest unvisited nodes
      const targets = Array.from(active.values())
        .filter(n => !visited.has(n.id.toString('hex')))
        .sort((a, b) => this.distance(keyId, a.id) - this.distance(keyId, b.id))
        .slice(0, this.config.alpha);
      
      if (targets.length === 0) break;
      
      // Query targets in parallel
      const queries = targets.map(async (node) => {
        visited.add(node.id.toString('hex'));
        
        try {
          const response = await this.sendRPC(node, 'FIND_VALUE', { key: keyHex });
          
          if (response.value) {
            // Found value
            return { found: true, value: response.value };
          } else if (response.nodes) {
            // Got closer nodes
            for (const closeNode of response.nodes) {
              const id = Buffer.from(closeNode.id, 'hex');
              if (!visited.has(closeNode.id) && !active.has(closeNode.id)) {
                active.set(closeNode.id, {
                  id: id,
                  address: closeNode.address,
                  port: closeNode.port
                });
              }
            }
          }
        } catch (error) {
          // Node didn't respond, remove from routing table
          this.routingTable.remove(node);
        }
        
        return null;
      });
      
      const results = await Promise.all(queries);
      
      // Check if value was found
      for (const result of results) {
        if (result && result.found) {
          // Cache the value locally
          this.storage.set(keyHex, result.value);
          this.storageTimestamps.set(keyHex, Date.now());
          
          return result.value;
        }
      }
      
      // Remove queried nodes from active set
      for (const node of targets) {
        active.delete(node.id.toString('hex'));
      }
    }
    
    return null; // Value not found
  }

  async findNode(targetId) {
    const target = Buffer.isBuffer(targetId) ? targetId : Buffer.from(targetId, 'hex');
    
    const visited = new Set();
    const active = new Map();
    const closest = new Map();
    
    // Start with alpha closest nodes from routing table
    const initial = this.routingTable.findClosest(target, this.config.alpha);
    for (const node of initial) {
      active.set(node.id.toString('hex'), node);
      closest.set(node.id.toString('hex'), node);
    }
    
    let closestDistance = initial.length > 0 
      ? this.distance(target, initial[0].id)
      : Infinity;
    
    while (active.size > 0) {
      // Get alpha closest unvisited nodes
      const targets = Array.from(active.values())
        .filter(n => !visited.has(n.id.toString('hex')))
        .sort((a, b) => this.distance(target, a.id) - this.distance(target, b.id))
        .slice(0, this.config.alpha);
      
      if (targets.length === 0) break;
      
      // Query targets in parallel
      const queries = targets.map(async (node) => {
        visited.add(node.id.toString('hex'));
        
        try {
          const response = await this.sendRPC(node, 'FIND_NODE', {
            target: target.toString('hex')
          });
          
          if (response.nodes) {
            // Add closer nodes
            for (const closeNode of response.nodes) {
              const id = Buffer.from(closeNode.id, 'hex');
              const dist = this.distance(target, id);
              
              if (dist < closestDistance) {
                closestDistance = dist;
              }
              
              if (!visited.has(closeNode.id) && !active.has(closeNode.id)) {
                const nodeInfo = {
                  id: id,
                  address: closeNode.address,
                  port: closeNode.port
                };
                
                active.set(closeNode.id, nodeInfo);
                closest.set(closeNode.id, nodeInfo);
                
                // Update routing table
                this.routingTable.add(nodeInfo);
              }
            }
          }
        } catch (error) {
          // Node didn't respond
          this.routingTable.remove(node);
        }
      });
      
      await Promise.all(queries);
      
      // Remove queried nodes from active set
      for (const node of targets) {
        active.delete(node.id.toString('hex'));
      }
      
      // Stop if no closer nodes found
      const currentClosest = Array.from(closest.values())
        .sort((a, b) => this.distance(target, a.id) - this.distance(target, b.id))[0];
      
      if (currentClosest && this.distance(target, currentClosest.id) >= closestDistance) {
        break;
      }
    }
    
    // Return k closest nodes
    return Array.from(closest.values())
      .sort((a, b) => this.distance(target, a.id) - this.distance(target, b.id))
      .slice(0, this.config.k);
  }

  // RPC handlers
  async handleRPC(message, sender) {
    const { id, method, params } = message;
    
    try {
      let result;
      
      switch (method) {
        case 'PING':
          result = await this.handlePing(params, sender);
          break;
        case 'STORE':
          result = await this.handleStore(params, sender);
          break;
        case 'FIND_NODE':
          result = await this.handleFindNode(params, sender);
          break;
        case 'FIND_VALUE':
          result = await this.handleFindValue(params, sender);
          break;
        default:
          throw new Error(`Unknown method: ${method}`);
      }
      
      return {
        id: id,
        result: result,
        error: null
      };
    } catch (error) {
      return {
        id: id,
        result: null,
        error: error.message
      };
    }
  }

  async handlePing(params, sender) {
    // Update routing table with sender
    this.routingTable.add(sender);
    
    return {
      nodeId: this.nodeId.toString('hex')
    };
  }

  async handleStore(params, sender) {
    const { key, value } = params;
    
    // Store the value
    this.storage.set(key, value);
    this.storageTimestamps.set(key, Date.now());
    
    // Update routing table with sender
    this.routingTable.add(sender);
    
    return { stored: true };
  }

  async handleFindNode(params, sender) {
    const { target } = params;
    const targetId = Buffer.from(target, 'hex');
    
    // Update routing table with sender
    this.routingTable.add(sender);
    
    // Find k closest nodes
    const closest = this.routingTable.findClosest(targetId, this.config.k);
    
    return {
      nodes: closest.map(node => ({
        id: node.id.toString('hex'),
        address: node.address,
        port: node.port
      }))
    };
  }

  async handleFindValue(params, sender) {
    const { key } = params;
    
    // Update routing table with sender
    this.routingTable.add(sender);
    
    // Check if we have the value
    if (this.storage.has(key)) {
      return { value: this.storage.get(key) };
    }
    
    // Otherwise return closest nodes
    const keyId = Buffer.from(key, 'hex');
    const closest = this.routingTable.findClosest(keyId, this.config.k);
    
    return {
      nodes: closest.map(node => ({
        id: node.id.toString('hex'),
        address: node.address,
        port: node.port
      }))
    };
  }

  // Utility methods
  generateNodeId() {
    return crypto.randomBytes(ID_LENGTH / 8);
  }

  hash(data) {
    return crypto.createHash('sha256').update(data).digest();
  }

  distance(a, b) {
    // XOR distance metric
    const aBuffer = Buffer.isBuffer(a) ? a : Buffer.from(a, 'hex');
    const bBuffer = Buffer.isBuffer(b) ? b : Buffer.from(b, 'hex');
    
    let distance = 0;
    for (let i = 0; i < aBuffer.length; i++) {
      const xor = aBuffer[i] ^ bBuffer[i];
      if (xor !== 0) {
        // Find position of most significant bit
        distance = (i * 8) + Math.floor(Math.log2(xor));
        break;
      }
    }
    
    return distance;
  }

  async sendRPC(node, method, params) {
    const messageId = crypto.randomBytes(16).toString('hex');
    
    const message = {
      id: messageId,
      method: method,
      params: params
    };
    
    return new Promise((resolve, reject) => {
      // Set timeout
      const timeout = setTimeout(() => {
        this.rpcCallbacks.delete(messageId);
        reject(new Error('RPC timeout'));
      }, this.rpcTimeout);
      
      // Store callback
      this.rpcCallbacks.set(messageId, {
        resolve: resolve,
        reject: reject,
        timeout: timeout
      });
      
      // Send message (in production, implement actual network send)
      this.emit('send-message', {
        to: node,
        message: message
      });
    });
  }

  handleRPCResponse(response) {
    const callback = this.rpcCallbacks.get(response.id);
    if (!callback) return;
    
    clearTimeout(callback.timeout);
    this.rpcCallbacks.delete(response.id);
    
    if (response.error) {
      callback.reject(new Error(response.error));
    } else {
      callback.resolve(response.result);
    }
  }

  // Maintenance tasks
  startMaintenanceTasks() {
    // Bucket refresh
    this.timers.set('refresh', setInterval(() => {
      this.refreshBuckets();
    }, this.config.refreshInterval));
    
    // Storage cleanup
    this.timers.set('cleanup', setInterval(() => {
      this.cleanupStorage();
    }, 3600000)); // Every hour
    
    // Replication
    this.timers.set('replicate', setInterval(() => {
      this.replicateData();
    }, this.config.replicateInterval));
  }

  async refreshBuckets() {
    // Refresh buckets that haven't been accessed recently
    const bucketsToRefresh = this.routingTable.getBucketsToRefresh();
    
    for (const bucketIndex of bucketsToRefresh) {
      // Generate random ID in bucket range
      const randomId = this.routingTable.getRandomIdInBucket(bucketIndex);
      
      // Perform lookup to refresh bucket
      await this.findNode(randomId);
    }
  }

  cleanupStorage() {
    const now = Date.now();
    const expired = [];
    
    for (const [key, timestamp] of this.storageTimestamps) {
      if (now - timestamp > this.config.expireTime) {
        expired.push(key);
      }
    }
    
    for (const key of expired) {
      this.storage.delete(key);
      this.storageTimestamps.delete(key);
    }
    
    if (expired.length > 0) {
      logger.info(`Cleaned up ${expired.length} expired entries`);
    }
  }

  async replicateData() {
    // Replicate all stored data to k closest nodes
    for (const [key, value] of this.storage) {
      const keyId = Buffer.from(key, 'hex');
      const closest = await this.findNode(keyId);
      
      // Store on closest nodes
      const storePromises = closest.map(node =>
        this.sendRPC(node, 'STORE', { key, value })
      );
      
      await Promise.allSettled(storePromises);
    }
  }

  // Mining pool specific methods
  async registerMiner(minerId, minerInfo) {
    const key = `miner:${minerId}`;
    await this.store(key, {
      ...minerInfo,
      timestamp: Date.now()
    });
  }

  async findMiner(minerId) {
    const key = `miner:${minerId}`;
    return this.findValue(key);
  }

  async registerShare(shareId, shareInfo) {
    const key = `share:${shareId}`;
    await this.store(key, {
      ...shareInfo,
      timestamp: Date.now()
    });
  }

  async findShare(shareId) {
    const key = `share:${shareId}`;
    return this.findValue(key);
  }

  getStatistics() {
    return {
      nodeId: this.nodeId.toString('hex'),
      routingTable: this.routingTable.getStatistics(),
      storage: {
        entries: this.storage.size,
        size: JSON.stringify(Array.from(this.storage.values())).length
      },
      rpc: {
        pending: this.rpcCallbacks.size
      }
    };
  }

  stop() {
    // Clear all timers
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
    
    // Clear RPC callbacks
    for (const callback of this.rpcCallbacks.values()) {
      clearTimeout(callback.timeout);
    }
    this.rpcCallbacks.clear();
  }
}

// Routing table implementation
class RoutingTable {
  constructor(nodeId, k) {
    this.nodeId = nodeId;
    this.k = k;
    this.buckets = Array(ID_LENGTH).fill(null).map(() => new KBucket(k));
    this.lastAccess = Array(ID_LENGTH).fill(Date.now());
  }

  add(nodeInfo) {
    const bucketIndex = this.getBucketIndex(nodeInfo.id);
    const bucket = this.buckets[bucketIndex];
    
    bucket.add(nodeInfo);
    this.lastAccess[bucketIndex] = Date.now();
  }

  remove(nodeInfo) {
    const bucketIndex = this.getBucketIndex(nodeInfo.id);
    const bucket = this.buckets[bucketIndex];
    
    bucket.remove(nodeInfo.id);
  }

  findClosest(targetId, count) {
    const results = [];
    
    // Start from the target bucket
    const targetBucket = this.getBucketIndex(targetId);
    
    // Search in expanding rings
    for (let distance = 0; distance < ID_LENGTH; distance++) {
      // Check bucket at distance in both directions
      for (const direction of [-1, 1]) {
        const bucketIndex = targetBucket + (direction * distance);
        
        if (bucketIndex >= 0 && bucketIndex < ID_LENGTH) {
          const nodes = this.buckets[bucketIndex].getNodes();
          results.push(...nodes);
          
          if (results.length >= count) {
            // Sort by distance and return
            return results
              .sort((a, b) => this.distance(targetId, a.id) - this.distance(targetId, b.id))
              .slice(0, count);
          }
        }
      }
    }
    
    return results.sort((a, b) => 
      this.distance(targetId, a.id) - this.distance(targetId, b.id)
    );
  }

  getBucketIndex(nodeId) {
    // Find the bucket index based on XOR distance
    const distance = this.distance(this.nodeId, nodeId);
    return Math.min(distance, ID_LENGTH - 1);
  }

  distance(a, b) {
    // XOR distance - find position of most significant differing bit
    for (let i = 0; i < a.length; i++) {
      const xor = a[i] ^ b[i];
      if (xor !== 0) {
        return (i * 8) + Math.floor(Math.log2(xor));
      }
    }
    return 0;
  }

  getBucketsToRefresh() {
    const now = Date.now();
    const buckets = [];
    
    for (let i = 0; i < this.buckets.length; i++) {
      if (now - this.lastAccess[i] > REFRESH_INTERVAL) {
        buckets.push(i);
      }
    }
    
    return buckets;
  }

  getRandomIdInBucket(bucketIndex) {
    // Generate random ID that would fall into the specified bucket
    const id = Buffer.alloc(ID_LENGTH / 8);
    
    // Copy node ID
    this.nodeId.copy(id);
    
    // Flip bit at bucket position
    const byteIndex = Math.floor(bucketIndex / 8);
    const bitIndex = bucketIndex % 8;
    
    id[byteIndex] ^= (1 << (7 - bitIndex));
    
    // Randomize remaining bits
    for (let i = byteIndex + 1; i < id.length; i++) {
      id[i] = Math.floor(Math.random() * 256);
    }
    
    return id;
  }

  getStatistics() {
    let totalNodes = 0;
    let fullBuckets = 0;
    
    for (const bucket of this.buckets) {
      const count = bucket.getNodes().length;
      totalNodes += count;
      if (count === this.k) fullBuckets++;
    }
    
    return {
      totalNodes: totalNodes,
      fullBuckets: fullBuckets,
      buckets: this.buckets.length
    };
  }
}

// K-bucket implementation
class KBucket {
  constructor(k) {
    this.k = k;
    this.nodes = [];
    this.replacementCache = [];
  }

  add(nodeInfo) {
    // Check if node already exists
    const existingIndex = this.nodes.findIndex(n => 
      n.id.equals(nodeInfo.id)
    );
    
    if (existingIndex !== -1) {
      // Move to end (most recently seen)
      this.nodes.splice(existingIndex, 1);
      this.nodes.push(nodeInfo);
      return;
    }
    
    // Add new node
    if (this.nodes.length < this.k) {
      this.nodes.push(nodeInfo);
    } else {
      // Bucket full, add to replacement cache
      this.replacementCache.push(nodeInfo);
      
      // Keep replacement cache size limited
      if (this.replacementCache.length > this.k) {
        this.replacementCache.shift();
      }
    }
  }

  remove(nodeId) {
    const index = this.nodes.findIndex(n => n.id.equals(nodeId));
    
    if (index !== -1) {
      this.nodes.splice(index, 1);
      
      // Replace with node from cache if available
      if (this.replacementCache.length > 0) {
        this.nodes.push(this.replacementCache.shift());
      }
    }
  }

  getNodes() {
    return [...this.nodes];
  }
}

export default KademliaDHT;