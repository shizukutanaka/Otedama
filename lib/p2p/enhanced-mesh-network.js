const EventEmitter = require('events');
const Libp2p = require('libp2p');
const TCP = require('libp2p-tcp');
const WebSockets = require('libp2p-websockets');
const WebRTCStar = require('libp2p-webrtc-star');
const Mplex = require('libp2p-mplex');
const { NOISE } = require('libp2p-noise');
const KadDHT = require('libp2p-kad-dht');
const GossipSub = require('libp2p-gossipsub');
const Bootstrap = require('libp2p-bootstrap');
const PeerInfo = require('peer-info');
const crypto = require('crypto');

class EnhancedMeshNetwork extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      // Network settings
      port: options.port || 6001,
      wsPort: options.wsPort || 6002,
      
      // Bootstrap nodes
      bootstrapNodes: options.bootstrapNodes || [
        '/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ',
        '/ip4/104.236.179.241/tcp/4001/p2p/QmSoLPppuBtQSGwKDZT2M73ULpjvfd3aZ6ha4oFGL1KrGM'
      ],
      
      // Network topology
      minPeers: options.minPeers || 10,
      maxPeers: options.maxPeers || 50,
      targetPeers: options.targetPeers || 25,
      
      // Performance
      messageCache: options.messageCache || 1000,
      messageTTL: options.messageTTL || 120, // seconds
      heartbeatInterval: options.heartbeatInterval || 1000,
      
      // Security
      enableEncryption: options.enableEncryption !== false,
      enableAuthentication: options.enableAuthentication !== false,
      
      // Features
      enableRelayHop: options.enableRelayHop !== false,
      enableAutoNAT: options.enableAutoNAT !== false,
      enableDHT: options.enableDHT !== false,
      enablePubSub: options.enablePubSub !== false
    };
    
    this.node = null;
    this.peers = new Map();
    this.topics = new Map();
    this.messageHandlers = new Map();
    
    // Network statistics
    this.stats = {
      messagesReceived: 0,
      messagesSent: 0,
      bytesReceived: 0,
      bytesSent: 0,
      connectedPeers: 0,
      discoveredPeers: 0,
      latencies: new Map()
    };
    
    // Mesh network state
    this.meshState = {
      topology: new Map(),
      routes: new Map(),
      reliability: new Map()
    };
  }
  
  async initialize() {
    this.emit('initializing');
    
    try {
      // Create libp2p node
      this.node = await this.createNode();
      
      // Setup event handlers
      this.setupEventHandlers();
      
      // Start the node
      await this.node.start();
      
      console.log('P2P node started with ID:', this.node.peerId.toB58String());
      console.log('Listening on:');
      this.node.multiaddrs.forEach(addr => {
        console.log(`  ${addr.toString()}/p2p/${this.node.peerId.toB58String()}`);
      });
      
      // Start network services
      await this.startNetworkServices();
      
      this.emit('initialized', {
        peerId: this.node.peerId.toB58String(),
        addresses: this.node.multiaddrs.map(addr => addr.toString())
      });
      
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
  
  async createNode() {
    // Node configuration
    const nodeConfig = {
      addresses: {
        listen: [
          `/ip4/0.0.0.0/tcp/${this.config.port}`,
          `/ip4/0.0.0.0/tcp/${this.config.wsPort}/ws`
        ]
      },
      
      modules: {
        transport: [TCP, WebSockets],
        streamMuxer: [Mplex],
        connEncryption: [NOISE],
        dht: this.config.enableDHT ? KadDHT : undefined,
        pubsub: this.config.enablePubSub ? GossipSub : undefined,
        peerDiscovery: [Bootstrap]
      },
      
      config: {
        dht: {
          enabled: this.config.enableDHT,
          randomWalk: {
            enabled: true,
            interval: 300000 // 5 minutes
          }
        },
        
        pubsub: {
          enabled: this.config.enablePubSub,
          emitSelf: false,
          signMessages: true,
          strictSigning: true
        },
        
        peerDiscovery: {
          bootstrap: {
            enabled: true,
            list: this.config.bootstrapNodes
          }
        },
        
        relay: {
          enabled: this.config.enableRelayHop,
          hop: {
            enabled: this.config.enableRelayHop,
            active: true
          }
        },
        
        nat: {
          enabled: this.config.enableAutoNAT,
          description: 'Otedama P2P Mining Node'
        }
      }
    };
    
    // Add WebRTC for browser compatibility
    if (typeof window !== 'undefined') {
      nodeConfig.modules.transport.push(WebRTCStar);
      nodeConfig.addresses.listen.push('/ip4/0.0.0.0/tcp/9090/ws/p2p-webrtc-star');
    }
    
    return await Libp2p.create(nodeConfig);
  }
  
  setupEventHandlers() {
    // Connection events
    this.node.connectionManager.on('peer:connect', (connection) => {
      this.handlePeerConnect(connection);
    });
    
    this.node.connectionManager.on('peer:disconnect', (connection) => {
      this.handlePeerDisconnect(connection);
    });
    
    // Discovery events
    this.node.on('peer:discovery', (peerId) => {
      this.handlePeerDiscovery(peerId);
    });
    
    // DHT events
    if (this.config.enableDHT) {
      this.node.dht.on('peer', (peerId) => {
        this.handleDHTDiscovery(peerId);
      });
    }
    
    // PubSub events
    if (this.config.enablePubSub) {
      this.setupPubSubHandlers();
    }
    
    // Protocol handlers
    this.setupProtocolHandlers();
  }
  
  setupPubSubHandlers() {
    // Handle incoming messages
    this.node.pubsub.on('message', (msg) => {
      this.handlePubSubMessage(msg);
    });
    
    // Subscribe to default topics
    const defaultTopics = [
      'otedama:blocks',
      'otedama:shares',
      'otedama:jobs',
      'otedama:stats'
    ];
    
    defaultTopics.forEach(topic => {
      this.subscribe(topic);
    });
  }
  
  setupProtocolHandlers() {
    // Mesh network protocol
    this.node.handle('/otedama/mesh/1.0.0', async ({ stream }) => {
      this.handleMeshProtocol(stream);
    });
    
    // Direct messaging protocol
    this.node.handle('/otedama/message/1.0.0', async ({ stream }) => {
      this.handleMessageProtocol(stream);
    });
    
    // State sync protocol
    this.node.handle('/otedama/sync/1.0.0', async ({ stream }) => {
      this.handleSyncProtocol(stream);
    });
    
    // Health check protocol
    this.node.handle('/otedama/health/1.0.0', async ({ stream }) => {
      this.handleHealthProtocol(stream);
    });
  }
  
  async startNetworkServices() {
    // Start peer discovery
    this.startPeerDiscovery();
    
    // Start topology maintenance
    this.startTopologyMaintenance();
    
    // Start health monitoring
    this.startHealthMonitoring();
    
    // Start route optimization
    this.startRouteOptimization();
  }
  
  // Peer Management
  
  async handlePeerConnect(connection) {
    const peerId = connection.remotePeer.toB58String();
    
    const peerInfo = {
      id: peerId,
      connection,
      connectedAt: Date.now(),
      latency: 0,
      reliability: 1.0,
      capabilities: new Set(),
      stats: {
        messagesSent: 0,
        messagesReceived: 0,
        bytesSent: 0,
        bytesReceived: 0
      }
    };
    
    this.peers.set(peerId, peerInfo);
    this.stats.connectedPeers++;
    
    // Exchange capabilities
    await this.exchangeCapabilities(peerId);
    
    // Update mesh topology
    this.updateMeshTopology();
    
    this.emit('peer:connected', {
      peerId,
      address: connection.remoteAddr.toString()
    });
  }
  
  handlePeerDisconnect(connection) {
    const peerId = connection.remotePeer.toB58String();
    
    if (this.peers.has(peerId)) {
      this.peers.delete(peerId);
      this.stats.connectedPeers--;
      
      // Remove from topology
      this.meshState.topology.delete(peerId);
      this.meshState.routes.delete(peerId);
      this.meshState.reliability.delete(peerId);
      
      // Update routes
      this.updateMeshTopology();
      
      this.emit('peer:disconnected', { peerId });
    }
  }
  
  async handlePeerDiscovery(peerId) {
    this.stats.discoveredPeers++;
    
    // Auto-connect if below target peers
    if (this.peers.size < this.config.targetPeers) {
      try {
        await this.node.dial(peerId);
      } catch (error) {
        console.error('Failed to dial peer:', error);
      }
    }
  }
  
  // Mesh Network Protocol
  
  async handleMeshProtocol(stream) {
    try {
      const data = await this.readStream(stream);
      const message = JSON.parse(data.toString());
      
      switch (message.type) {
        case 'topology_update':
          await this.handleTopologyUpdate(message);
          break;
          
        case 'route_request':
          await this.handleRouteRequest(message, stream);
          break;
          
        case 'capability_exchange':
          await this.handleCapabilityExchange(message, stream);
          break;
          
        default:
          console.warn('Unknown mesh message type:', message.type);
      }
      
    } catch (error) {
      console.error('Error handling mesh protocol:', error);
    }
  }
  
  async exchangeCapabilities(peerId) {
    const capabilities = {
      version: '1.0.0',
      protocols: Array.from(this.node.protocols()),
      features: {
        dht: this.config.enableDHT,
        pubsub: this.config.enablePubSub,
        relay: this.config.enableRelayHop
      },
      resources: {
        cpu: process.cpuUsage(),
        memory: process.memoryUsage(),
        bandwidth: this.estimateBandwidth()
      }
    };
    
    try {
      const { stream } = await this.node.dialProtocol(peerId, '/otedama/mesh/1.0.0');
      
      await this.writeStream(stream, JSON.stringify({
        type: 'capability_exchange',
        capabilities
      }));
      
      const response = await this.readStream(stream);
      const peerCapabilities = JSON.parse(response.toString());
      
      if (this.peers.has(peerId)) {
        this.peers.get(peerId).capabilities = new Set(peerCapabilities.protocols);
      }
      
    } catch (error) {
      console.error('Failed to exchange capabilities:', error);
    }
  }
  
  // Topology Management
  
  updateMeshTopology() {
    // Build adjacency list
    const topology = new Map();
    
    for (const [peerId, peerInfo] of this.peers) {
      const neighbors = this.findNearestPeers(peerId, 5);
      topology.set(peerId, neighbors);
    }
    
    this.meshState.topology = topology;
    
    // Calculate optimal routes
    this.calculateOptimalRoutes();
    
    // Broadcast topology update
    this.broadcastTopologyUpdate();
  }
  
  findNearestPeers(peerId, count) {
    const distances = [];
    
    for (const [otherId, otherInfo] of this.peers) {
      if (otherId !== peerId) {
        distances.push({
          id: otherId,
          distance: this.calculatePeerDistance(peerId, otherId),
          latency: otherInfo.latency
        });
      }
    }
    
    // Sort by distance and latency
    distances.sort((a, b) => {
      const scoreA = a.distance + (a.latency / 1000);
      const scoreB = b.distance + (b.latency / 1000);
      return scoreA - scoreB;
    });
    
    return distances.slice(0, count).map(d => d.id);
  }
  
  calculatePeerDistance(peerId1, peerId2) {
    // XOR distance in DHT
    const id1 = Buffer.from(peerId1, 'base58');
    const id2 = Buffer.from(peerId2, 'base58');
    
    let distance = 0;
    for (let i = 0; i < Math.min(id1.length, id2.length); i++) {
      distance += Math.abs(id1[i] - id2[i]);
    }
    
    return distance;
  }
  
  calculateOptimalRoutes() {
    // Dijkstra's algorithm for shortest paths
    const routes = new Map();
    
    for (const source of this.peers.keys()) {
      const distances = new Map();
      const previous = new Map();
      const unvisited = new Set(this.peers.keys());
      
      // Initialize distances
      for (const peer of this.peers.keys()) {
        distances.set(peer, peer === source ? 0 : Infinity);
      }
      
      while (unvisited.size > 0) {
        // Find nearest unvisited
        let current = null;
        let minDistance = Infinity;
        
        for (const peer of unvisited) {
          if (distances.get(peer) < minDistance) {
            current = peer;
            minDistance = distances.get(peer);
          }
        }
        
        if (current === null) break;
        
        unvisited.delete(current);
        
        // Update distances to neighbors
        const neighbors = this.meshState.topology.get(current) || [];
        for (const neighbor of neighbors) {
          if (unvisited.has(neighbor)) {
            const alt = distances.get(current) + this.getEdgeWeight(current, neighbor);
            if (alt < distances.get(neighbor)) {
              distances.set(neighbor, alt);
              previous.set(neighbor, current);
            }
          }
        }
      }
      
      // Store routes
      const sourceRoutes = new Map();
      for (const [dest, dist] of distances) {
        if (dest !== source) {
          const path = this.reconstructPath(previous, source, dest);
          sourceRoutes.set(dest, {
            path,
            distance: dist,
            nextHop: path.length > 1 ? path[1] : null
          });
        }
      }
      
      routes.set(source, sourceRoutes);
    }
    
    this.meshState.routes = routes;
  }
  
  getEdgeWeight(peer1, peer2) {
    const info1 = this.peers.get(peer1);
    const info2 = this.peers.get(peer2);
    
    if (!info1 || !info2) return Infinity;
    
    // Weight based on latency and reliability
    const latency = (info1.latency + info2.latency) / 2;
    const reliability = (info1.reliability + info2.reliability) / 2;
    
    return latency / reliability;
  }
  
  reconstructPath(previous, source, dest) {
    const path = [dest];
    let current = dest;
    
    while (previous.has(current) && current !== source) {
      current = previous.get(current);
      path.unshift(current);
    }
    
    return path[0] === source ? path : [];
  }
  
  // Message Routing
  
  async sendMessage(destPeerId, message, options = {}) {
    const {
      protocol = '/otedama/message/1.0.0',
      timeout = 30000,
      retry = 3,
      priority = 'normal'
    } = options;
    
    // Check if direct connection exists
    if (this.peers.has(destPeerId)) {
      return await this.sendDirectMessage(destPeerId, message, protocol);
    }
    
    // Use mesh routing
    const route = this.findRoute(this.node.peerId.toB58String(), destPeerId);
    if (!route || route.path.length === 0) {
      throw new Error('No route to destination');
    }
    
    // Send via next hop
    const nextHop = route.nextHop;
    const routedMessage = {
      type: 'routed_message',
      source: this.node.peerId.toB58String(),
      destination: destPeerId,
      hopCount: 0,
      maxHops: route.path.length + 2,
      message,
      timestamp: Date.now()
    };
    
    return await this.sendDirectMessage(nextHop, routedMessage, '/otedama/mesh/1.0.0');
  }
  
  async sendDirectMessage(peerId, message, protocol) {
    try {
      const { stream } = await this.node.dialProtocol(peerId, protocol);
      
      const data = typeof message === 'string' ? message : JSON.stringify(message);
      await this.writeStream(stream, data);
      
      // Update stats
      this.stats.messagesSent++;
      this.stats.bytesSent += Buffer.byteLength(data);
      
      if (this.peers.has(peerId)) {
        const peer = this.peers.get(peerId);
        peer.stats.messagesSent++;
        peer.stats.bytesSent += Buffer.byteLength(data);
      }
      
      return { success: true };
      
    } catch (error) {
      console.error(`Failed to send message to ${peerId}:`, error);
      return { success: false, error: error.message };
    }
  }
  
  findRoute(sourcePeerId, destPeerId) {
    const sourceRoutes = this.meshState.routes.get(sourcePeerId);
    if (!sourceRoutes) return null;
    
    return sourceRoutes.get(destPeerId);
  }
  
  // PubSub Operations
  
  async subscribe(topic, handler) {
    if (!this.config.enablePubSub) {
      throw new Error('PubSub is not enabled');
    }
    
    await this.node.pubsub.subscribe(topic);
    
    if (handler) {
      if (!this.messageHandlers.has(topic)) {
        this.messageHandlers.set(topic, new Set());
      }
      this.messageHandlers.get(topic).add(handler);
    }
    
    this.topics.set(topic, {
      subscribedAt: Date.now(),
      messageCount: 0
    });
    
    this.emit('subscribed', { topic });
  }
  
  async unsubscribe(topic) {
    if (!this.config.enablePubSub) return;
    
    await this.node.pubsub.unsubscribe(topic);
    this.topics.delete(topic);
    this.messageHandlers.delete(topic);
    
    this.emit('unsubscribed', { topic });
  }
  
  async publish(topic, data) {
    if (!this.config.enablePubSub) {
      throw new Error('PubSub is not enabled');
    }
    
    const message = {
      data,
      timestamp: Date.now(),
      sender: this.node.peerId.toB58String()
    };
    
    await this.node.pubsub.publish(topic, Buffer.from(JSON.stringify(message)));
    
    this.stats.messagesSent++;
    this.emit('published', { topic, data });
  }
  
  handlePubSubMessage(msg) {
    try {
      const message = JSON.parse(msg.data.toString());
      const topic = msg.topicIDs[0];
      
      this.stats.messagesReceived++;
      
      if (this.topics.has(topic)) {
        this.topics.get(topic).messageCount++;
      }
      
      // Call handlers
      const handlers = this.messageHandlers.get(topic);
      if (handlers) {
        handlers.forEach(handler => {
          try {
            handler(message, msg.from);
          } catch (error) {
            console.error('Handler error:', error);
          }
        });
      }
      
      this.emit('message', {
        topic,
        data: message.data,
        from: msg.from
      });
      
    } catch (error) {
      console.error('Failed to parse pubsub message:', error);
    }
  }
  
  // Health Monitoring
  
  startHealthMonitoring() {
    this.healthInterval = setInterval(() => {
      this.checkPeerHealth();
    }, this.config.heartbeatInterval);
  }
  
  async checkPeerHealth() {
    const checks = [];
    
    for (const [peerId, peerInfo] of this.peers) {
      checks.push(this.pingPeer(peerId));
    }
    
    const results = await Promise.allSettled(checks);
    
    results.forEach((result, index) => {
      const peerId = Array.from(this.peers.keys())[index];
      
      if (result.status === 'fulfilled') {
        const latency = result.value;
        this.updatePeerHealth(peerId, latency);
      } else {
        this.updatePeerHealth(peerId, -1);
      }
    });
  }
  
  async pingPeer(peerId) {
    const start = Date.now();
    
    try {
      const { stream } = await this.node.dialProtocol(peerId, '/otedama/health/1.0.0');
      
      await this.writeStream(stream, JSON.stringify({
        type: 'ping',
        timestamp: start
      }));
      
      const response = await this.readStream(stream);
      const latency = Date.now() - start;
      
      return latency;
      
    } catch (error) {
      throw error;
    }
  }
  
  updatePeerHealth(peerId, latency) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    
    if (latency > 0) {
      // Update latency (moving average)
      peer.latency = peer.latency * 0.8 + latency * 0.2;
      
      // Update reliability
      peer.reliability = Math.min(1.0, peer.reliability * 1.01);
      
      // Store in stats
      this.stats.latencies.set(peerId, peer.latency);
    } else {
      // Failed ping
      peer.reliability = Math.max(0.1, peer.reliability * 0.9);
    }
    
    this.meshState.reliability.set(peerId, peer.reliability);
  }
  
  // Utility Methods
  
  async readStream(stream) {
    const chunks = [];
    
    for await (const chunk of stream.source) {
      chunks.push(chunk);
    }
    
    return Buffer.concat(chunks);
  }
  
  async writeStream(stream, data) {
    await stream.sink([Buffer.from(data)]);
  }
  
  estimateBandwidth() {
    const duration = (Date.now() - this.startTime) / 1000; // seconds
    
    return {
      upload: this.stats.bytesSent / duration,
      download: this.stats.bytesReceived / duration
    };
  }
  
  // Public API
  
  getPeers() {
    return Array.from(this.peers.entries()).map(([id, info]) => ({
      id,
      latency: info.latency,
      reliability: info.reliability,
      connected: Date.now() - info.connectedAt,
      stats: info.stats
    }));
  }
  
  getTopology() {
    const topology = [];
    
    for (const [peer, neighbors] of this.meshState.topology) {
      topology.push({
        peer,
        neighbors,
        reliability: this.meshState.reliability.get(peer) || 0
      });
    }
    
    return topology;
  }
  
  getStats() {
    return {
      ...this.stats,
      uptime: Date.now() - this.startTime,
      avgLatency: this.calculateAverageLatency(),
      bandwidth: this.estimateBandwidth()
    };
  }
  
  calculateAverageLatency() {
    if (this.stats.latencies.size === 0) return 0;
    
    let sum = 0;
    for (const latency of this.stats.latencies.values()) {
      sum += latency;
    }
    
    return sum / this.stats.latencies.size;
  }
  
  async stop() {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
    }
    
    await this.node.stop();
    
    this.emit('stopped');
  }
}

module.exports = EnhancedMeshNetwork;