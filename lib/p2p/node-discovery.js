/**
 * Advanced Node Discovery
 * Implements DHT, bootstrap nodes, and peer discovery mechanisms
 */

import { EventEmitter } from 'events';
import { createHash, randomBytes } from 'crypto';
import dgram from 'dgram';
import { getLogger } from '../core/logger.js';

const logger = getLogger('NodeDiscovery');

// K-bucket size for Kademlia
const K_BUCKET_SIZE = 20;
const ALPHA = 3; // Concurrency parameter
const NODE_ID_LENGTH = 160; // bits

export class NodeDiscovery extends EventEmitter {
  constructor(nodeInfo, options = {}) {
    super();
    this.nodeId = nodeInfo.nodeId || this.generateNodeId();
    this.nodeInfo = {
      ...nodeInfo,
      nodeId: this.nodeId,
      timestamp: Date.now()
    };
    
    this.logger = options.logger || logger;
    this.options = {
      bootstrapNodes: options.bootstrapNodes || [],
      pingInterval: options.pingInterval || 30000, // 30 seconds
      refreshInterval: options.refreshInterval || 3600000, // 1 hour
      natTraversal: options.natTraversal !== false,
      geoAware: options.geoAware !== false,
      maxPeers: options.maxPeers || 100,
      ...options
    };
    
    // Kademlia routing table
    this.routingTable = new Array(NODE_ID_LENGTH).fill(null).map(() => []);
    
    // Active peers map
    this.peers = new Map();
    
    // Pending lookups
    this.pendingLookups = new Map();
    
    // Geographic index
    this.geoIndex = new Map();
    
    // Initialize
    this.initialize();
  }
  
  /**
   * Initialize node discovery
   */
  async initialize() {
    // Add bootstrap nodes
    for (const bootstrap of this.options.bootstrapNodes) {
      await this.addNode(bootstrap);
    }
    
    // Start maintenance routines
    this.startPingRoutine();
    this.startRefreshRoutine();
    
    // Announce self to network
    await this.announce();
    
    this.logger.info(`Node discovery initialized with ID: ${this.nodeId}`);
  }
  
  /**
   * Generate node ID
   */
  generateNodeId() {
    return createHash('sha1').update(randomBytes(20)).digest('hex');
  }
  
  /**
   * Calculate XOR distance between node IDs
   */
  distance(id1, id2) {
    const buf1 = Buffer.from(id1, 'hex');
    const buf2 = Buffer.from(id2, 'hex');
    const dist = Buffer.alloc(NODE_ID_LENGTH / 8);
    
    for (let i = 0; i < buf1.length; i++) {
      dist[i] = buf1[i] ^ buf2[i];
    }
    
    return dist;
  }
  
  /**
   * Get bucket index for a node ID
   */
  getBucketIndex(nodeId) {
    const dist = this.distance(this.nodeId, nodeId);
    
    // Find first non-zero bit
    for (let i = 0; i < NODE_ID_LENGTH; i++) {
      const byteIndex = Math.floor(i / 8);
      const bitIndex = 7 - (i % 8);
      
      if ((dist[byteIndex] >> bitIndex) & 1) {
        return NODE_ID_LENGTH - i - 1;
      }
    }
    
    return 0; // Same node
  }
  
  /**
   * Add node to routing table
   */
  async addNode(nodeInfo) {
    if (nodeInfo.nodeId === this.nodeId) return;
    
    const bucketIndex = this.getBucketIndex(nodeInfo.nodeId);
    const bucket = this.routingTable[bucketIndex];
    
    // Check if node already exists
    const existingIndex = bucket.findIndex(n => n.nodeId === nodeInfo.nodeId);
    
    if (existingIndex !== -1) {
      // Move to end (most recently seen)
      bucket.splice(existingIndex, 1);
      bucket.push({
        ...nodeInfo,
        lastSeen: Date.now()
      });
    } else if (bucket.length < K_BUCKET_SIZE) {
      // Add new node
      bucket.push({
        ...nodeInfo,
        lastSeen: Date.now(),
        rtt: null,
        failures: 0
      });
      
      // Add to peers map
      this.peers.set(nodeInfo.nodeId, nodeInfo);
      
      // Update geographic index
      if (this.options.geoAware && nodeInfo.location) {
        this.updateGeoIndex(nodeInfo);
      }
      
      this.emit('node:added', nodeInfo);
    } else {
      // Bucket full - ping oldest node
      const oldestNode = bucket[0];
      const isAlive = await this.pingNode(oldestNode);
      
      if (!isAlive) {
        // Replace with new node
        bucket.shift();
        bucket.push({
          ...nodeInfo,
          lastSeen: Date.now(),
          rtt: null,
          failures: 0
        });
        
        this.peers.delete(oldestNode.nodeId);
        this.peers.set(nodeInfo.nodeId, nodeInfo);
        
        this.emit('node:replaced', { old: oldestNode, new: nodeInfo });
      }
    }
  }
  
  /**
   * Find K closest nodes to target ID
   */
  findClosestNodes(targetId, k = K_BUCKET_SIZE) {
    const candidates = [];
    
    // Collect all nodes from routing table
    for (const bucket of this.routingTable) {
      candidates.push(...bucket);
    }
    
    // Sort by distance to target
    candidates.sort((a, b) => {
      const distA = this.distance(targetId, a.nodeId);
      const distB = this.distance(targetId, b.nodeId);
      return Buffer.compare(distA, distB);
    });
    
    return candidates.slice(0, k);
  }
  
  /**
   * Iterative node lookup
   */
  async lookup(targetId, type = 'node') {
    const lookupId = randomBytes(8).toString('hex');
    const seen = new Set();
    const queried = new Set();
    let closest = this.findClosestNodes(targetId, ALPHA);
    
    this.pendingLookups.set(lookupId, {
      targetId,
      type,
      startTime: Date.now()
    });
    
    try {
      while (true) {
        // Find unqueried nodes
        const toQuery = closest
          .filter(node => !queried.has(node.nodeId))
          .slice(0, ALPHA);
        
        if (toQuery.length === 0) break;
        
        // Query nodes in parallel
        const queries = toQuery.map(node => this.queryNode(node, targetId, type));
        const results = await Promise.allSettled(queries);
        
        // Process results
        for (let i = 0; i < results.length; i++) {
          const node = toQuery[i];
          queried.add(node.nodeId);
          
          if (results[i].status === 'fulfilled') {
            const response = results[i].value;
            
            // Add discovered nodes
            for (const discovered of response.nodes || []) {
              if (!seen.has(discovered.nodeId)) {
                seen.add(discovered.nodeId);
                await this.addNode(discovered);
              }
            }
            
            // Check if we found the value
            if (type === 'value' && response.value) {
              return response.value;
            }
          }
        }
        
        // Update closest nodes
        closest = this.findClosestNodes(targetId, K_BUCKET_SIZE);
        
        // Check if we're making progress
        const newClosest = closest.filter(n => !seen.has(n.nodeId));
        if (newClosest.length === 0) break;
      }
      
      return type === 'node' ? closest : null;
      
    } finally {
      this.pendingLookups.delete(lookupId);
    }
  }
  
  /**
   * Query a node
   */
  async queryNode(node, targetId, type) {
    const request = {
      type: type === 'node' ? 'FIND_NODE' : 'FIND_VALUE',
      targetId,
      senderId: this.nodeId,
      senderInfo: this.nodeInfo
    };
    
    try {
      const response = await this.sendRequest(node, request);
      
      // Update node RTT
      if (response.rtt) {
        node.rtt = response.rtt;
      }
      
      return response;
    } catch (error) {
      // Handle failed query
      node.failures = (node.failures || 0) + 1;
      
      if (node.failures >= 3) {
        this.removeNode(node.nodeId);
      }
      
      throw error;
    }
  }
  
  /**
   * Ping node to check if alive
   */
  async pingNode(node) {
    try {
      const start = Date.now();
      const response = await this.sendRequest(node, {
        type: 'PING',
        senderId: this.nodeId
      });
      
      const rtt = Date.now() - start;
      node.rtt = rtt;
      node.lastSeen = Date.now();
      node.failures = 0;
      
      return true;
    } catch (error) {
      return false;
    }
  }
  
  /**
   * Announce self to network
   */
  async announce() {
    // Find nodes close to our ID
    const closest = await this.lookup(this.nodeId);
    
    // Store our info on closest nodes
    const storeRequests = closest.map(node => 
      this.sendRequest(node, {
        type: 'STORE',
        key: this.nodeId,
        value: this.nodeInfo,
        senderId: this.nodeId
      })
    );
    
    await Promise.allSettled(storeRequests);
    
    this.emit('announced', { nodes: closest.length });
  }
  
  /**
   * Find geographically close nodes
   */
  findGeoCloseNodes(location, maxDistance = 100) { // km
    if (!this.options.geoAware || !location) {
      return [];
    }
    
    const nearby = [];
    
    for (const [nodeId, nodeInfo] of this.peers) {
      if (nodeInfo.location) {
        const distance = this.calculateGeoDistance(location, nodeInfo.location);
        
        if (distance <= maxDistance) {
          nearby.push({
            ...nodeInfo,
            geoDistance: distance
          });
        }
      }
    }
    
    // Sort by distance
    nearby.sort((a, b) => a.geoDistance - b.geoDistance);
    
    return nearby;
  }
  
  /**
   * Calculate geographic distance (Haversine formula)
   */
  calculateGeoDistance(loc1, loc2) {
    const R = 6371; // Earth radius in km
    const dLat = this.toRad(loc2.lat - loc1.lat);
    const dLon = this.toRad(loc2.lon - loc1.lon);
    
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(this.toRad(loc1.lat)) * Math.cos(this.toRad(loc2.lat)) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    
    return R * c;
  }
  
  toRad(deg) {
    return deg * (Math.PI / 180);
  }
  
  /**
   * Update geographic index
   */
  updateGeoIndex(nodeInfo) {
    if (!nodeInfo.location) return;
    
    // Create geo hash for efficient lookup
    const geoHash = this.createGeoHash(nodeInfo.location);
    
    if (!this.geoIndex.has(geoHash)) {
      this.geoIndex.set(geoHash, new Set());
    }
    
    this.geoIndex.get(geoHash).add(nodeInfo.nodeId);
  }
  
  /**
   * Create geo hash from coordinates
   */
  createGeoHash(location, precision = 5) {
    // Simplified geohash - in production use proper geohash library
    const lat = Math.floor(location.lat * Math.pow(10, precision)) / Math.pow(10, precision);
    const lon = Math.floor(location.lon * Math.pow(10, precision)) / Math.pow(10, precision);
    return `${lat},${lon}`;
  }
  
  /**
   * Remove node from routing table
   */
  removeNode(nodeId) {
    const bucketIndex = this.getBucketIndex(nodeId);
    const bucket = this.routingTable[bucketIndex];
    
    const index = bucket.findIndex(n => n.nodeId === nodeId);
    if (index !== -1) {
      bucket.splice(index, 1);
      this.peers.delete(nodeId);
      
      this.emit('node:removed', { nodeId });
    }
  }
  
  /**
   * Get optimal peers for mining
   */
  getOptimalPeers(options = {}) {
    const {
      count = 10,
      preferGeographic = true,
      maxLatency = 100,
      minReputation = 0.5
    } = options;
    
    let candidates = Array.from(this.peers.values());
    
    // Filter by criteria
    candidates = candidates.filter(peer => {
      if (maxLatency && peer.rtt && peer.rtt > maxLatency) return false;
      if (minReputation && peer.reputation && peer.reputation < minReputation) return false;
      return true;
    });
    
    // Sort by preference
    candidates.sort((a, b) => {
      // Prefer low latency
      if (a.rtt && b.rtt) {
        const latencyDiff = a.rtt - b.rtt;
        if (Math.abs(latencyDiff) > 10) return latencyDiff;
      }
      
      // Prefer geographic proximity
      if (preferGeographic && this.nodeInfo.location) {
        const distA = a.location ? 
          this.calculateGeoDistance(this.nodeInfo.location, a.location) : Infinity;
        const distB = b.location ? 
          this.calculateGeoDistance(this.nodeInfo.location, b.location) : Infinity;
        
        return distA - distB;
      }
      
      return 0;
    });
    
    return candidates.slice(0, count);
  }
  
  /**
   * Start ping routine
   */
  startPingRoutine() {
    setInterval(async () => {
      const nodes = [];
      
      // Collect random nodes from each bucket
      for (const bucket of this.routingTable) {
        if (bucket.length > 0) {
          const randomNode = bucket[Math.floor(Math.random() * bucket.length)];
          nodes.push(randomNode);
        }
      }
      
      // Ping nodes
      const pingPromises = nodes.map(node => this.pingNode(node));
      await Promise.allSettled(pingPromises);
      
    }, this.options.pingInterval);
  }
  
  /**
   * Start refresh routine
   */
  startRefreshRoutine() {
    setInterval(async () => {
      // Refresh random bucket
      const randomBucket = Math.floor(Math.random() * NODE_ID_LENGTH);
      
      // Generate random ID in bucket range
      const randomId = this.generateRandomIdInBucket(randomBucket);
      
      // Perform lookup to populate bucket
      await this.lookup(randomId);
      
    }, this.options.refreshInterval);
  }
  
  /**
   * Generate random ID for specific bucket
   */
  generateRandomIdInBucket(bucketIndex) {
    const id = Buffer.from(this.nodeId, 'hex');
    const random = randomBytes(NODE_ID_LENGTH / 8);
    
    // Set appropriate bit for bucket
    const byteIndex = Math.floor((NODE_ID_LENGTH - bucketIndex - 1) / 8);
    const bitIndex = 7 - ((NODE_ID_LENGTH - bucketIndex - 1) % 8);
    
    // XOR to get ID in bucket range
    for (let i = 0; i < id.length; i++) {
      if (i === byteIndex) {
        id[i] = id[i] ^ (1 << bitIndex);
      } else if (i > byteIndex) {
        id[i] = random[i];
      }
    }
    
    return id.toString('hex');
  }
  
  /**
   * Send request to node (placeholder)
   */
  async sendRequest(node, request) {
    // In production, implement actual network communication
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (Math.random() > 0.1) { // 90% success rate
          resolve({
            type: request.type + '_RESPONSE',
            nodes: this.findClosestNodes(request.targetId || node.nodeId, K_BUCKET_SIZE),
            rtt: 10 + Math.random() * 40
          });
        } else {
          reject(new Error('Request timeout'));
        }
      }, 10 + Math.random() * 50);
    });
  }
  
  /**
   * Get discovery statistics
   */
  getStats() {
    const stats = {
      nodeId: this.nodeId,
      totalPeers: this.peers.size,
      activeBuckets: 0,
      totalNodes: 0,
      averageRTT: 0,
      geographicClusters: this.geoIndex.size
    };
    
    let totalRTT = 0;
    let rttCount = 0;
    
    for (const bucket of this.routingTable) {
      if (bucket.length > 0) {
        stats.activeBuckets++;
        stats.totalNodes += bucket.length;
        
        for (const node of bucket) {
          if (node.rtt) {
            totalRTT += node.rtt;
            rttCount++;
          }
        }
      }
    }
    
    if (rttCount > 0) {
      stats.averageRTT = totalRTT / rttCount;
    }
    
    return stats;
  }
}