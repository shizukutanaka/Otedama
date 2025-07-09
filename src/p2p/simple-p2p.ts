/**
 * P2P Distributed Mining Pool - Simple & Fast
 * Design: Carmack (Performance) + Martin (Clean) + Pike (Simple)
 * 
 * Core P2P functionality for distributed mining pool
 */

import * as net from 'net';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { createComponentLogger } from '../logging/simple-logger';

// ===== P2P NODE TYPES =====
interface PeerInfo {
  id: string;
  host: string;
  port: number;
  version: string;
  lastSeen: number;
  reputation: number;
  services: string[];
}

interface P2PMessage {
  type: 'handshake' | 'block_found' | 'share_sync' | 'peer_list' | 'ping' | 'pong';
  nodeId: string;
  timestamp: number;
  data?: any;
  signature?: string;
}

interface NetworkStats {
  connectedPeers: number;
  totalPeers: number;
  messagesReceived: number;
  messagesSent: number;
  blocksReceived: number;
  sharesSynced: number;
}

// ===== P2P PEER CONNECTION =====
class P2PPeer extends EventEmitter {
  private socket: net.Socket;
  private connected: boolean = false;
  private lastActivity: number = Date.now();
  private messageQueue: P2PMessage[] = [];
  private logger = createComponentLogger('P2PPeer');
  
  constructor(
    public peerInfo: PeerInfo,
    socket?: net.Socket
  ) {
    super();
    
    if (socket) {
      this.socket = socket;
      this.setupSocket();
    }
  }
  
  async connect(): Promise<boolean> {
    if (this.connected) return true;
    
    try {
      this.socket = new net.Socket();
      this.setupSocket();
      
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Connection timeout'));
        }, 10000);
        
        this.socket.connect(this.peerInfo.port, this.peerInfo.host, () => {
          clearTimeout(timeout);
          this.connected = true;
          resolve();
        });
        
        this.socket.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
      
      // Send handshake
      await this.sendHandshake();
      
      this.logger.info('Connected to peer', { 
        peerId: this.peerInfo.id,
        address: `${this.peerInfo.host}:${this.peerInfo.port}`
      });
      
      return true;
      
    } catch (error) {
      this.logger.warn('Failed to connect to peer', { 
        error: (error as Error).message,
        peerId: this.peerInfo.id 
      });
      return false;
    }
  }
  
  private setupSocket(): void {
    this.socket.on('data', (data) => {
      this.handleData(data);
    });
    
    this.socket.on('close', () => {
      this.connected = false;
      this.emit('disconnect', this.peerInfo.id);
      this.logger.debug('Peer disconnected', { peerId: this.peerInfo.id });
    });
    
    this.socket.on('error', (error) => {
      this.logger.warn('Peer socket error', { 
        error: error.message,
        peerId: this.peerInfo.id 
      });
      this.emit('error', error);
    });
  }
  
  private handleData(data: Buffer): void {
    this.lastActivity = Date.now();
    
    try {
      const lines = data.toString().split('\n');
      
      for (const line of lines) {
        if (line.trim()) {
          const message: P2PMessage = JSON.parse(line.trim());
          this.handleMessage(message);
        }
      }
    } catch (error) {
      this.logger.warn('Failed to parse message', { 
        error: (error as Error).message,
        peerId: this.peerInfo.id 
      });
    }
  }
  
  private handleMessage(message: P2PMessage): void {
    // Update peer activity
    this.peerInfo.lastSeen = Date.now();
    
    switch (message.type) {
      case 'handshake':
        this.handleHandshake(message);
        break;
      case 'ping':
        this.sendPong();
        break;
      case 'pong':
        // Update latency metrics
        break;
      default:
        this.emit('message', message);
    }
  }
  
  private handleHandshake(message: P2PMessage): void {
    if (message.data) {
      this.peerInfo.version = message.data.version || '1.0.0';
      this.peerInfo.services = message.data.services || [];
    }
    
    this.emit('handshake', this.peerInfo);
  }
  
  private async sendHandshake(): Promise<void> {
    const handshake: P2PMessage = {
      type: 'handshake',
      nodeId: this.getLocalNodeId(),
      timestamp: Date.now(),
      data: {
        version: '1.0.0',
        services: ['mining', 'relay'],
        userAgent: 'Otedama-Pool/1.0.0'
      }
    };
    
    await this.sendMessage(handshake);
  }
  
  private sendPong(): void {
    const pong: P2PMessage = {
      type: 'pong',
      nodeId: this.getLocalNodeId(),
      timestamp: Date.now()
    };
    
    this.sendMessage(pong);
  }
  
  async sendMessage(message: P2PMessage): Promise<boolean> {
    if (!this.connected || !this.socket.writable) {
      this.messageQueue.push(message);
      return false;
    }
    
    try {
      const data = JSON.stringify(message) + '\n';
      this.socket.write(data);
      return true;
    } catch (error) {
      this.logger.warn('Failed to send message', { 
        error: (error as Error).message,
        messageType: message.type,
        peerId: this.peerInfo.id 
      });
      return false;
    }
  }
  
  private getLocalNodeId(): string {
    // Generate consistent node ID
    return crypto.createHash('sha256')
      .update(process.env.NODE_ID || 'default')
      .digest('hex')
      .substring(0, 16);
  }
  
  async ping(): Promise<boolean> {
    const ping: P2PMessage = {
      type: 'ping',
      nodeId: this.getLocalNodeId(),
      timestamp: Date.now()
    };
    
    return await this.sendMessage(ping);
  }
  
  isActive(): boolean {
    return this.connected && (Date.now() - this.lastActivity < 300000); // 5 minutes
  }
  
  getStats(): any {
    return {
      peerId: this.peerInfo.id,
      connected: this.connected,
      lastActivity: this.lastActivity,
      reputation: this.peerInfo.reputation,
      queueSize: this.messageQueue.length
    };
  }
  
  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
    }
    this.connected = false;
  }
}

// ===== P2P NETWORK MANAGER =====
class P2PNetwork extends EventEmitter {
  private peers: Map<string, P2PPeer> = new Map();
  private server: net.Server;
  private nodeId: string;
  private stats: NetworkStats = {
    connectedPeers: 0,
    totalPeers: 0,
    messagesReceived: 0,
    messagesSent: 0,
    blocksReceived: 0,
    sharesSynced: 0
  };
  private logger = createComponentLogger('P2PNetwork');
  
  constructor(
    private config: {
      port: number;
      maxPeers: number;
      seedNodes: string[];
      nodeId?: string;
    }
  ) {
    super();
    
    this.nodeId = config.nodeId || this.generateNodeId();
    this.server = net.createServer(this.handleIncomingConnection.bind(this));
    
    this.startPeriodicTasks();
  }
  
  private generateNodeId(): string {
    return crypto.randomBytes(16).toString('hex');
  }
  
  async start(): Promise<void> {
    try {
      // Start P2P server
      await new Promise<void>((resolve, reject) => {
        this.server.listen(this.config.port, (error?: Error) => {
          if (error) {
            reject(error);
          } else {
            this.logger.info('P2P server started', { 
              port: this.config.port,
              nodeId: this.nodeId 
            });
            resolve();
          }
        });
      });
      
      // Connect to seed nodes
      await this.connectToSeedNodes();
      
    } catch (error) {
      this.logger.error('Failed to start P2P network', error as Error);
      throw error;
    }
  }
  
  private handleIncomingConnection(socket: net.Socket): void {
    const remoteAddress = socket.remoteAddress || 'unknown';
    
    // Check if we have room for more peers
    if (this.peers.size >= this.config.maxPeers) {
      this.logger.warn('Max peers reached, rejecting connection', { 
        from: remoteAddress 
      });
      socket.destroy();
      return;
    }
    
    // Create temporary peer info for incoming connection
    const tempPeerInfo: PeerInfo = {
      id: 'incoming_' + Date.now(),
      host: remoteAddress,
      port: 0, // Will be updated from handshake
      version: '0.0.0',
      lastSeen: Date.now(),
      reputation: 0,
      services: []
    };
    
    const peer = new P2PPeer(tempPeerInfo, socket);
    this.setupPeerEvents(peer);
    
    this.logger.info('Incoming P2P connection', { from: remoteAddress });
  }
  
  private async connectToSeedNodes(): Promise<void> {
    for (const seedNode of this.config.seedNodes) {
      try {
        const [host, portStr] = seedNode.split(':');
        const port = parseInt(portStr) || 8333;
        
        await this.connectToPeer(host, port);
        
        // Small delay between connections
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (error) {
        this.logger.warn('Failed to connect to seed node', { 
          seedNode,
          error: (error as Error).message 
        });
      }
    }
  }
  
  async connectToPeer(host: string, port: number): Promise<boolean> {
    // Check if already connected
    const existingPeer = Array.from(this.peers.values())
      .find(p => p.peerInfo.host === host && p.peerInfo.port === port);
    
    if (existingPeer) {
      return existingPeer.isActive();
    }
    
    // Check peer limit
    if (this.peers.size >= this.config.maxPeers) {
      this.logger.warn('Max peers reached, cannot connect to new peer');
      return false;
    }
    
    const peerInfo: PeerInfo = {
      id: this.generatePeerId(host, port),
      host,
      port,
      version: '0.0.0',
      lastSeen: Date.now(),
      reputation: 0,
      services: []
    };
    
    const peer = new P2PPeer(peerInfo);
    this.setupPeerEvents(peer);
    
    const connected = await peer.connect();
    
    if (connected) {
      this.peers.set(peerInfo.id, peer);
      this.stats.connectedPeers++;
      this.emit('peer_connected', peerInfo);
    }
    
    return connected;
  }
  
  private generatePeerId(host: string, port: number): string {
    return crypto.createHash('sha256')
      .update(`${host}:${port}`)
      .digest('hex')
      .substring(0, 16);
  }
  
  private setupPeerEvents(peer: P2PPeer): void {
    peer.on('handshake', (peerInfo: PeerInfo) => {
      // Update peer info and add to network
      if (!this.peers.has(peerInfo.id)) {
        this.peers.set(peerInfo.id, peer);
        this.stats.connectedPeers++;
      }
      
      this.logger.info('Peer handshake completed', { 
        peerId: peerInfo.id,
        version: peerInfo.version 
      });
    });
    
    peer.on('message', (message: P2PMessage) => {
      this.stats.messagesReceived++;
      this.handlePeerMessage(peer, message);
    });
    
    peer.on('disconnect', (peerId: string) => {
      this.peers.delete(peerId);
      this.stats.connectedPeers--;
      this.logger.info('Peer disconnected', { peerId });
    });
    
    peer.on('error', (error: Error) => {
      this.logger.warn('Peer error', { error: error.message });
    });
  }
  
  private handlePeerMessage(peer: P2PPeer, message: P2PMessage): void {
    switch (message.type) {
      case 'block_found':
        this.stats.blocksReceived++;
        this.emit('block_found', message.data);
        break;
        
      case 'share_sync':
        this.stats.sharesSynced++;
        this.emit('share_sync', message.data);
        break;
        
      case 'peer_list':
        this.handlePeerList(message.data);
        break;
        
      default:
        this.emit('message', peer, message);
    }
  }
  
  private handlePeerList(peerList: PeerInfo[]): void {
    // Add new peers to our list (for future connections)
    for (const peerInfo of peerList) {
      if (!this.peers.has(peerInfo.id) && 
          this.peers.size < this.config.maxPeers) {
        // Try to connect to new peer
        this.connectToPeer(peerInfo.host, peerInfo.port)
          .catch(error => {
            this.logger.debug('Failed to connect to peer from list', { 
              peerId: peerInfo.id,
              error: error.message 
            });
          });
      }
    }
  }
  
  // Broadcast message to all connected peers
  async broadcast(message: P2PMessage): Promise<number> {
    let sent = 0;
    
    for (const peer of this.peers.values()) {
      if (peer.isActive()) {
        const success = await peer.sendMessage(message);
        if (success) {
          sent++;
          this.stats.messagesSent++;
        }
      }
    }
    
    return sent;
  }
  
  // Broadcast block found to network
  async broadcastBlockFound(blockData: any): Promise<void> {
    const message: P2PMessage = {
      type: 'block_found',
      nodeId: this.nodeId,
      timestamp: Date.now(),
      data: blockData
    };
    
    const sent = await this.broadcast(message);
    this.logger.info('Block found broadcast to peers', { 
      blockHeight: blockData.height,
      peersSent: sent 
    });
  }
  
  // Sync shares with peers
  async syncShares(shares: any[]): Promise<void> {
    const message: P2PMessage = {
      type: 'share_sync',
      nodeId: this.nodeId,
      timestamp: Date.now(),
      data: { shares }
    };
    
    await this.broadcast(message);
  }
  
  private startPeriodicTasks(): void {
    // Ping peers every 60 seconds
    setInterval(() => {
      this.pingPeers();
    }, 60000);
    
    // Clean inactive peers every 5 minutes
    setInterval(() => {
      this.cleanInactivePeers();
    }, 300000);
    
    // Update stats every minute
    setInterval(() => {
      this.updateStats();
    }, 60000);
  }
  
  private async pingPeers(): Promise<void> {
    for (const peer of this.peers.values()) {
      if (peer.isActive()) {
        await peer.ping();
      }
    }
  }
  
  private cleanInactivePeers(): void {
    let cleaned = 0;
    
    for (const [peerId, peer] of this.peers.entries()) {
      if (!peer.isActive()) {
        peer.disconnect();
        this.peers.delete(peerId);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      this.stats.connectedPeers = this.peers.size;
      this.logger.info('Cleaned inactive peers', { count: cleaned });
    }
  }
  
  private updateStats(): void {
    this.stats.totalPeers = this.peers.size;
    this.stats.connectedPeers = Array.from(this.peers.values())
      .filter(peer => peer.isActive()).length;
    
    this.logger.debug('P2P network stats', this.stats);
  }
  
  // Get list of connected peers
  getPeers(): PeerInfo[] {
    return Array.from(this.peers.values())
      .filter(peer => peer.isActive())
      .map(peer => peer.peerInfo);
  }
  
  // Get network statistics
  getStats(): NetworkStats {
    return { ...this.stats };
  }
  
  async stop(): Promise<void> {
    this.logger.info('Stopping P2P network...');
    
    // Disconnect all peers
    for (const peer of this.peers.values()) {
      peer.disconnect();
    }
    
    // Stop server
    this.server.close();
    
    this.logger.info('P2P network stopped');
  }
}

export { P2PNetwork, P2PPeer, PeerInfo, P2PMessage, NetworkStats };
