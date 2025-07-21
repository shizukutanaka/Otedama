/**
 * Mesh Network Topology for P2P Mining Pool
 * Self-healing network with redundancy and automatic failover
 * Now with binary protocol support for improved performance
 */

import { EventEmitter } from 'events';
import { Logger } from '../logger.js';
import { BinaryProtocol, MessageType } from './binary-protocol.js';
import { EncryptedTransport } from './encrypted-transport.js';

// Connection states
export const ConnectionState = {
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  FAILED: 'failed',
  RECONNECTING: 'reconnecting'
};

// Node roles in mesh network
export const NodeRole = {
  FULL: 'full',        // Full node with all capabilities
  MINER: 'miner',      // Mining node
  RELAY: 'relay',      // Relay node for routing
  BOOTSTRAP: 'bootstrap' // Bootstrap node for initial connections
};

export class MeshTopology extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = options.logger || new Logger('MeshTopology');
    this.options = {
      nodeId: options.nodeId || this.generateNodeId(),
      minConnections: options.minConnections || 3,
      maxConnections: options.maxConnections || 20,
      redundancy: options.redundancy || 3,
      healingInterval: options.healingInterval || 30000,
      heartbeatInterval: options.heartbeatInterval || 10000,
      connectionTimeout: options.connectionTimeout || 30000,
      maxRetries: options.maxRetries || 3,
      nodeRole: options.nodeRole || NodeRole.FULL,
      useBinaryProtocol: options.useBinaryProtocol !== false,
      useEncryption: options.useEncryption !== false,
      ...options
    };
    
    this.nodeId = this.options.nodeId;
    
    // Initialize binary protocol
    this.binaryProtocol = new BinaryProtocol({
      bufferSize: 65536,
      maxPoolSize: 100
    });
    
    // Initialize encrypted transport if enabled
    if (this.options.useEncryption) {
      this.encryptedTransport = new EncryptedTransport({
        protocol: options.encryptionProtocol || 'noise-xx',
        keyExchange: options.keyExchange || 'x25519'
      });
    }
    
    // Network state
    this.connections = new Map();
    this.nodes = new Map();
    this.routingTable = new Map();
    this.pendingConnections = new Map();
    
    // Message type mapping
    this.messageTypeMap = {
      'share': MessageType.SHARE,
      'block': MessageType.BLOCK,
      'work': MessageType.WORK,
      'stats': MessageType.STATS,
      'sync': MessageType.SYNC,
      'peer:info': MessageType.PEER_INFO,
      'miner:join': MessageType.MINER_JOIN,
      'miner:leave': MessageType.MINER_LEAVE,
      'heartbeat': MessageType.HEARTBEAT,
      'partition': MessageType.PARTITION,
      'reorg': MessageType.REORG
    };
    
    // Network health monitoring
    this.healthMetrics = {
      totalNodes: 0,
      activeConnections: 0,
      avgLatency: 0,
      reliability: 1.0,
      networkFragmentation: 0,
      lastHealing: 0
    };
    
    // Message routing
    this.messageCache = new Map();
    this.routingCache = new Map();
    
    // Performance stats
    this.performanceStats = {
      messagesEncoded: 0,
      messagesDecoded: 0,
      bytesEncoded: 0,
      bytesDecoded: 0,
      encodingErrors: 0,
      decodingErrors: 0
    };
  }
  
  async initialize() {
    if (this.options.useEncryption) {
      await this.encryptedTransport.initialize();
    }
    
    // Start network maintenance
    this.startNetworkHealing();
    this.startHeartbeat();
    this.startRoutingTableMaintenance();
    
    this.logger.info('Mesh topology initialized with binary protocol support');
    this.emit('initialized');
  }
  
  /**
   * Connect to a peer
   */
  async connectToPeer(peer) {
    const peerId = peer.id || peer.nodeId;
    
    if (this.connections.has(peerId)) {
      return; // Already connected
    }
    
    this.logger.info(`Connecting to peer ${peerId}`);
    
    try {
      // Create connection
      const socket = await this.createSocket(peer.endpoint);
      
      // Apply encryption if enabled
      let connection = socket;
      if (this.options.useEncryption) {
        connection = await this.encryptedTransport.establishSecureConnection(
          socket, true, peerId
        );
      }
      
      // Wrap with binary protocol support
      const wrappedConnection = this.wrapConnection(connection, peerId);
      
      this.connections.set(peerId, wrappedConnection);
      this.updateRoutingTable(peerId, 1);
      
      this.emit('peer:connected', peer);
      
    } catch (error) {
      this.logger.error(`Failed to connect to peer ${peerId}:`, error);
      this.emit('peer:error', { peerId, error });
      throw error;
    }
  }
  
  /**
   * Wrap connection with binary protocol support
   */
  wrapConnection(socket, peerId) {
    const self = this;
    
    return {
      socket,
      peerId,
      
      send: async (message) => {
        try {
          let data;
          
          if (self.options.useBinaryProtocol && message.type) {
            // Use binary protocol
            const binaryType = self.messageTypeMap[message.type];
            if (binaryType !== undefined) {
              data = self.binaryProtocol.encode(binaryType, message.data || message);
              self.performanceStats.messagesEncoded++;
              self.performanceStats.bytesEncoded += data.length;
            } else {
              // Fall back to JSON for unknown types
              data = Buffer.from(JSON.stringify(message));
            }
          } else {
            // Use JSON
            data = Buffer.from(JSON.stringify(message));
          }
          
          // Send through socket
          return new Promise((resolve, reject) => {
            socket.write(data, (error) => {
              if (error) {
                self.performanceStats.encodingErrors++;
                reject(error);
              } else {
                resolve();
              }
            });
          });
          
        } catch (error) {
          self.logger.error('Failed to send message:', error);
          self.performanceStats.encodingErrors++;
          throw error;
        }
      },
      
      close: () => {
        socket.destroy();
        self.connections.delete(peerId);
        self.emit('peer:disconnected', peerId);
      }
    };
  }
  
  /**
   * Send message to peer
   */
  async sendToPeer(peerId, message) {
    const connection = this.connections.get(peerId);
    if (!connection) {
      throw new Error(`Not connected to peer ${peerId}`);
    }
    
    return connection.send(message);
  }
  
  /**
   * Broadcast message to all peers
   */
  async broadcast(message, excludePeers = []) {
    const promises = [];
    
    for (const [peerId, connection] of this.connections) {
      if (!excludePeers.includes(peerId)) {
        promises.push(
          connection.send(message).catch(error => {
            this.logger.error(`Failed to send to ${peerId}:`, error);
          })
        );
      }
    }
    
    await Promise.allSettled(promises);
  }
  
  /**
   * Disconnect from peer
   */
  async disconnectFromPeer(peerId) {
    const connection = this.connections.get(peerId);
    if (connection) {
      connection.close();
    }
  }
  
  /**
   * Handle incoming data
   */
  handleIncomingData(connection, data) {
    try {
      let message;
      
      // Try binary protocol first
      if (this.options.useBinaryProtocol) {
        try {
          message = this.binaryProtocol.decode(data);
          this.performanceStats.messagesDecoded++;
          this.performanceStats.bytesDecoded += data.length;
        } catch (binaryError) {
          // Fall back to JSON
          try {
            message = JSON.parse(data.toString());
          } catch (jsonError) {
            throw new Error('Failed to decode message as binary or JSON');
          }
        }
      } else {
        message = JSON.parse(data.toString());
      }
      
      // Emit message event
      this.emit('message:received', {
        from: connection.peerId,
        message,
        timestamp: Date.now()
      });
      
    } catch (error) {
      this.logger.error('Failed to handle incoming data:', error);
      this.performanceStats.decodingErrors++;
    }
  }
  
  /**
   * Update routing table
   */
  updateRoutingTable(peerId, distance, nextHop = peerId) {
    if (!this.routingTable.has(peerId)) {
      this.routingTable.set(peerId, []);
    }
    
    const routes = this.routingTable.get(peerId);
    const existingRoute = routes.find(r => r.nextHop === nextHop);
    
    if (existingRoute) {
      existingRoute.distance = distance;
      existingRoute.lastUpdated = Date.now();
    } else {
      routes.push({
        nextHop,
        distance,
        lastUpdated: Date.now()
      });
    }
    
    routes.sort((a, b) => a.distance - b.distance);
  }
  
  /**
   * Get route to peer
   */
  getRoute(targetPeerId) {
    // Direct connection
    if (this.connections.has(targetPeerId)) {
      return [targetPeerId];
    }
    
    // Check routing table
    const routes = this.routingTable.get(targetPeerId);
    if (routes && routes.length > 0) {
      return [routes[0].nextHop, targetPeerId];
    }
    
    return null;
  }
  
  /**
   * Start network healing
   */
  startNetworkHealing() {
    setInterval(() => {
      this.healNetwork();
    }, this.options.healingInterval);
  }
  
  /**
   * Heal network
   */
  healNetwork() {
    this.healthMetrics.lastHealing = Date.now();
    
    // Update metrics
    this.healthMetrics.totalNodes = this.nodes.size;
    this.healthMetrics.activeConnections = this.connections.size;
    
    // Check connection health
    for (const [peerId, connection] of this.connections) {
      // Ping to check if still alive
      this.sendToPeer(peerId, {
        type: 'heartbeat',
        timestamp: Date.now()
      }).catch(() => {
        // Connection failed, remove it
        this.disconnectFromPeer(peerId);
      });
    }
    
    this.emit('network:healed', this.healthMetrics);
  }
  
  /**
   * Start heartbeat
   */
  startHeartbeat() {
    setInterval(() => {
      this.sendHeartbeats();
    }, this.options.heartbeatInterval);
  }
  
  /**
   * Send heartbeats
   */
  async sendHeartbeats() {
    const heartbeat = {
      type: 'heartbeat',
      data: {
        nodeId: this.nodeId,
        timestamp: Date.now(),
        role: this.options.nodeRole,
        connections: this.connections.size
      }
    };
    
    await this.broadcast(heartbeat);
  }
  
  /**
   * Start routing table maintenance
   */
  startRoutingTableMaintenance() {
    setInterval(() => {
      this.maintainRoutingTable();
    }, 60000); // Every minute
  }
  
  /**
   * Maintain routing table
   */
  maintainRoutingTable() {
    const now = Date.now();
    const staleThreshold = 300000; // 5 minutes
    
    for (const [peerId, routes] of this.routingTable) {
      const freshRoutes = routes.filter(route => 
        now - route.lastUpdated < staleThreshold
      );
      
      if (freshRoutes.length > 0) {
        this.routingTable.set(peerId, freshRoutes);
      } else {
        this.routingTable.delete(peerId);
      }
    }
  }
  
  /**
   * Create socket connection (stub for actual implementation)
   */
  async createSocket(endpoint) {
    // This would be replaced with actual socket creation
    // For now, return a mock socket
    return {
      write: (data, callback) => {
        setTimeout(() => callback(), 10);
      },
      on: (event, handler) => {},
      destroy: () => {}
    };
  }
  
  /**
   * Generate node ID
   */
  generateNodeId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }
  
  /**
   * Get topology statistics
   */
  getStats() {
    return {
      health: this.healthMetrics,
      connections: this.connections.size,
      routingTableSize: this.routingTable.size,
      performance: this.performanceStats,
      binaryProtocolEnabled: this.options.useBinaryProtocol,
      encryptionEnabled: this.options.useEncryption
    };
  }
  
  /**
   * Shutdown topology
   */
  async shutdown() {
    this.logger.info('Shutting down mesh topology...');
    
    // Disconnect all peers
    for (const peerId of this.connections.keys()) {
      await this.disconnectFromPeer(peerId);
    }
    
    // Clear all data
    this.connections.clear();
    this.nodes.clear();
    this.routingTable.clear();
    
    this.emit('shutdown');
  }
}

export default MeshTopology;