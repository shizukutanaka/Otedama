/**
 * Network Manager - Otedama
 * Central network management and coordination
 */

import { EventEmitter } from 'events';
import { createLogger } from '../core/logger.js';
import { P2PNetwork } from './p2p-network.js';
import { StratumServer } from './stratum-server.js';
import { StratumV2Server } from './stratum-v2-server.js';
import { LoadBalancer } from './load-balancer.js';
import { ConnectionPool } from './connection-pool.js';

const logger = createLogger('NetworkManager');

export class NetworkManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      // Stratum settings
      stratumPort: options.stratumPort || 3333,
      stratumV2Port: options.stratumV2Port || 3336,
      enableStratumV2: options.enableStratumV2 !== false,
      
      // P2P settings
      p2pEnabled: options.p2pEnabled !== false,
      p2pPort: options.p2pPort || 8333,
      maxPeers: options.maxPeers || 50,
      
      // Connection settings
      maxConnections: options.maxConnections || 10000,
      connectionTimeout: options.connectionTimeout || 300000,
      
      // Security settings
      enableBanList: options.enableBanList !== false,
      banDuration: options.banDuration || 3600000, // 1 hour
      maxInvalidShares: options.maxInvalidShares || 50
    };
    
    // Components
    this.stratumServer = null;
    this.stratumV2Server = null;
    this.p2pNetwork = null;
    this.loadBalancer = null;
    this.connectionPool = new ConnectionPool({
      maxConnections: this.config.maxConnections
    });
    
    // State
    this.connections = new Map();
    this.banList = new Map();
    this.stats = {
      totalConnections: 0,
      activeConnections: 0,
      messagesReceived: 0,
      messagesSent: 0,
      invalidShares: 0,
      bansIssued: 0
    };
  }
  
  async start() {
    logger.info('Starting network manager');
    
    try {
      // Start connection pool
      await this.connectionPool.start();
      
      // Start Stratum server
      this.stratumServer = new StratumServer({
        port: this.config.stratumPort
      });
      await this.stratumServer.start();
      
      // Start Stratum V2 if enabled
      if (this.config.enableStratumV2) {
        this.stratumV2Server = new StratumV2Server({
          port: this.config.stratumV2Port
        });
        await this.stratumV2Server.start();
      }
      
      // Start P2P network if enabled
      if (this.config.p2pEnabled) {
        this.p2pNetwork = new P2PNetwork({
          port: this.config.p2pPort,
          maxPeers: this.config.maxPeers
        });
        await this.p2pNetwork.start();
      }
      
      // Setup event handlers
      this.setupEventHandlers();
      
      // Start ban cleanup
      this.startBanCleanup();
      
      logger.info('Network manager started successfully');
      this.emit('started');
      
    } catch (error) {
      logger.error('Failed to start network manager:', error);
      throw error;
    }
  }
  
  async stop() {
    logger.info('Stopping network manager');
    
    // Stop ban cleanup
    this.stopBanCleanup();
    
    // Disconnect all connections
    for (const connection of this.connections.values()) {
      await this.disconnect(connection.id);
    }
    
    // Stop components
    if (this.stratumServer) await this.stratumServer.stop();
    if (this.stratumV2Server) await this.stratumV2Server.stop();
    if (this.p2pNetwork) await this.p2pNetwork.stop();
    await this.connectionPool.stop();
    
    logger.info('Network manager stopped');
    this.emit('stopped');
  }
  
  setupEventHandlers() {
    // Stratum server events
    if (this.stratumServer) {
      this.stratumServer.on('client:connected', (client) => {
        this.handleConnection(client, 'stratum');
      });
      
      this.stratumServer.on('client:disconnected', (client) => {
        this.handleDisconnection(client.id);
      });
      
      this.stratumServer.on('share:submitted', (data) => {
        this.handleShareSubmitted(data);
      });
    }
    
    // Stratum V2 events
    if (this.stratumV2Server) {
      this.stratumV2Server.on('client:connected', (client) => {
        this.handleConnection(client, 'stratumv2');
      });
      
      this.stratumV2Server.on('client:disconnected', (client) => {
        this.handleDisconnection(client.id);
      });
      
      this.stratumV2Server.on('share:submitted', (data) => {
        this.handleShareSubmitted(data);
      });
    }
    
    // P2P network events
    if (this.p2pNetwork) {
      this.p2pNetwork.on('peer:connected', (peer) => {
        this.handleConnection(peer, 'p2p');
      });
      
      this.p2pNetwork.on('peer:disconnected', (peer) => {
        this.handleDisconnection(peer.id);
      });
      
      this.p2pNetwork.on('share:received', (share) => {
        this.emit('p2p:share', share);
      });
    }
  }
  
  handleConnection(client, type) {
    const connectionId = client.id || `${type}-${Date.now()}`;
    
    // Check ban list
    if (this.isBanned(client.address || client.ip)) {
      logger.warn(`Rejected connection from banned address: ${client.address}`);
      this.disconnect(connectionId);
      return;
    }
    
    // Check connection limit
    if (this.connections.size >= this.config.maxConnections) {
      logger.warn('Maximum connections reached, rejecting new connection');
      this.disconnect(connectionId);
      return;
    }
    
    // Add connection
    const connection = {
      id: connectionId,
      type,
      address: client.address || client.ip,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      invalidShares: 0,
      client
    };
    
    this.connections.set(connectionId, connection);
    this.stats.totalConnections++;
    this.stats.activeConnections++;
    
    logger.info(`New ${type} connection: ${connectionId} from ${connection.address}`);
    this.emit('connection:added', connection);
  }
  
  handleDisconnection(connectionId) {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    
    this.connections.delete(connectionId);
    this.stats.activeConnections--;
    
    logger.info(`Disconnected: ${connectionId}`);
    this.emit('connection:removed', connection);
  }
  
  handleShareSubmitted(data) {
    const connection = this.connections.get(data.clientId);
    if (!connection) return;
    
    connection.lastActivity = Date.now();
    
    if (!data.valid) {
      connection.invalidShares++;
      this.stats.invalidShares++;
      
      // Check for ban threshold
      if (connection.invalidShares >= this.config.maxInvalidShares) {
        this.ban(connection.address, 'Too many invalid shares');
      }
    }
    
    this.emit('share:processed', {
      connectionId: connection.id,
      valid: data.valid,
      share: data.share
    });
  }
  
  // Connection management
  
  async disconnect(connectionId) {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    
    try {
      switch (connection.type) {
        case 'stratum':
          if (this.stratumServer) {
            await this.stratumServer.disconnectClient(connectionId);
          }
          break;
          
        case 'stratumv2':
          if (this.stratumV2Server) {
            await this.stratumV2Server.disconnectClient(connectionId);
          }
          break;
          
        case 'p2p':
          if (this.p2pNetwork) {
            await this.p2pNetwork.disconnectPeer(connectionId);
          }
          break;
      }
    } catch (error) {
      logger.error(`Error disconnecting ${connectionId}:`, error);
    }
    
    this.handleDisconnection(connectionId);
  }
  
  // Ban management
  
  ban(address, reason) {
    if (!this.config.enableBanList) return;
    
    logger.warn(`Banning address ${address}: ${reason}`);
    
    this.banList.set(address, {
      reason,
      timestamp: Date.now(),
      expires: Date.now() + this.config.banDuration
    });
    
    this.stats.bansIssued++;
    
    // Disconnect all connections from this address
    for (const connection of this.connections.values()) {
      if (connection.address === address) {
        this.disconnect(connection.id);
      }
    }
    
    this.emit('address:banned', { address, reason });
  }
  
  unban(address) {
    const removed = this.banList.delete(address);
    if (removed) {
      logger.info(`Unbanned address: ${address}`);
      this.emit('address:unbanned', { address });
    }
    return removed;
  }
  
  isBanned(address) {
    if (!this.config.enableBanList) return false;
    
    const ban = this.banList.get(address);
    if (!ban) return false;
    
    // Check if ban expired
    if (Date.now() > ban.expires) {
      this.banList.delete(address);
      return false;
    }
    
    return true;
  }
  
  startBanCleanup() {
    this.banCleanupTimer = setInterval(() => {
      const now = Date.now();
      
      for (const [address, ban] of this.banList) {
        if (now > ban.expires) {
          this.unban(address);
        }
      }
    }, 60000); // Every minute
  }
  
  stopBanCleanup() {
    if (this.banCleanupTimer) {
      clearInterval(this.banCleanupTimer);
      this.banCleanupTimer = null;
    }
  }
  
  // Broadcasting
  
  async broadcast(message, excludeId = null) {
    const promises = [];
    
    // Broadcast to Stratum clients
    if (this.stratumServer) {
      promises.push(this.stratumServer.broadcast(message, excludeId));
    }
    
    // Broadcast to Stratum V2 clients
    if (this.stratumV2Server) {
      promises.push(this.stratumV2Server.broadcast(message, excludeId));
    }
    
    // Broadcast to P2P peers
    if (this.p2pNetwork && message.type === 'job') {
      promises.push(this.p2pNetwork.broadcastJob(message.data));
    }
    
    await Promise.allSettled(promises);
    
    this.stats.messagesSent += this.connections.size;
  }
  
  // Statistics
  
  getStats() {
    const stats = {
      ...this.stats,
      connections: {
        stratum: 0,
        stratumv2: 0,
        p2p: 0
      },
      bans: this.banList.size
    };
    
    // Count connections by type
    for (const connection of this.connections.values()) {
      stats.connections[connection.type]++;
    }
    
    // Add component stats
    if (this.stratumServer) {
      stats.stratumServer = this.stratumServer.getStats();
    }
    
    if (this.stratumV2Server) {
      stats.stratumV2Server = this.stratumV2Server.getStats();
    }
    
    if (this.p2pNetwork) {
      stats.p2pNetwork = this.p2pNetwork.getStats();
    }
    
    return stats;
  }
  
  getConnections() {
    return Array.from(this.connections.values());
  }
  
  getBans() {
    return Array.from(this.banList.entries()).map(([address, ban]) => ({
      address,
      ...ban
    }));
  }
}

export default NetworkManager;
