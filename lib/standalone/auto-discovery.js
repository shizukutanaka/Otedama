/**
 * Auto Discovery System
 * Automatically discovers and connects to other Otedama nodes
 * Uses UDP broadcast/multicast and DHT for peer discovery
 */

const { EventEmitter } = require('events');
const dgram = require('dgram');
const net = require('net');
const crypto = require('crypto');

class AutoDiscovery extends EventEmitter {
    constructor(config) {
        super();
        
        this.config = {
            // Discovery settings
            port: config.port || 6634,
            multicastAddress: config.multicastAddress || '239.255.255.250',
            broadcastInterval: config.broadcastInterval || 30000, // 30 seconds
            discoveryTimeout: config.discoveryTimeout || 60000, // 60 seconds
            
            // Pool info
            poolId: config.poolId || crypto.randomBytes(32).toString('hex'),
            poolInfo: config.poolInfo || {},
            
            // Connection settings
            maxPeers: config.maxPeers || 50,
            reconnectDelay: config.reconnectDelay || 5000,
            
            // DHT settings (optional)
            dhtBootstrap: config.dhtBootstrap || [],
            useDHT: config.useDHT || false,
            
            ...config
        };
        
        // Discovery state
        this.socket = null;
        this.peers = new Map();
        this.knownPeers = new Set();
        this.connections = new Map();
        
        // Message handlers
        this.messageHandlers = new Map();
        this.setupDefaultHandlers();
    }
    
    // Start discovery service
    async start() {
        try {
            // Create UDP socket for discovery
            this.socket = dgram.createSocket({
                type: 'udp4',
                reuseAddr: true
            });
            
            // Bind to discovery port
            await new Promise((resolve, reject) => {
                this.socket.bind(this.config.port, () => {
                    resolve();
                });
                this.socket.on('error', reject);
            });
            
            // Enable broadcast
            this.socket.setBroadcast(true);
            
            // Join multicast group
            try {
                this.socket.addMembership(this.config.multicastAddress);
            } catch (error) {
                // Multicast might not be available
                console.warn('Multicast not available, using broadcast only');
            }
            
            // Handle incoming messages
            this.socket.on('message', (msg, rinfo) => {
                this.handleDiscoveryMessage(msg, rinfo);
            });
            
            // Start broadcasting our presence
            this.startBroadcasting();
            
            // Start P2P server
            await this.startP2PServer();
            
            this.emit('started', {
                poolId: this.config.poolId,
                port: this.config.port
            });
            
        } catch (error) {
            this.emit('error', { type: 'start', error });
            throw error;
        }
    }
    
    // Setup default message handlers
    setupDefaultHandlers() {
        // Handle peer announcement
        this.messageHandlers.set('announce', async (data, peer) => {
            if (data.poolId === this.config.poolId) {
                return; // Ignore our own announcements
            }
            
            const peerInfo = {
                id: data.poolId,
                address: peer.address,
                port: data.p2pPort || 6633,
                poolInfo: data.poolInfo || {},
                lastSeen: Date.now()
            };
            
            // Check if new peer
            if (!this.knownPeers.has(data.poolId)) {
                this.knownPeers.add(data.poolId);
                this.emit('peer:discovered', peerInfo);
                
                // Auto-connect if below max peers
                if (this.connections.size < this.config.maxPeers) {
                    this.connectToPeer(peerInfo);
                }
            } else {
                // Update last seen
                const existing = this.peers.get(data.poolId);
                if (existing) {
                    existing.lastSeen = Date.now();
                }
            }
        });
        
        // Handle direct peer request
        this.messageHandlers.set('peer-request', async (data, peer) => {
            // Send list of known peers
            const peers = Array.from(this.peers.values())
                .filter(p => p.id !== data.poolId)
                .slice(0, 10); // Send up to 10 peers
            
            this.sendDiscoveryMessage(peer.address, {
                type: 'peer-response',
                poolId: this.config.poolId,
                peers
            });
        });
        
        // Handle peer response
        this.messageHandlers.set('peer-response', async (data, peer) => {
            for (const peerInfo of data.peers || []) {
                if (!this.knownPeers.has(peerInfo.id)) {
                    this.knownPeers.add(peerInfo.id);
                    this.emit('peer:discovered', peerInfo);
                }
            }
        });
    }
    
    // Handle discovery message
    handleDiscoveryMessage(msg, rinfo) {
        try {
            const data = JSON.parse(msg.toString());
            
            // Validate message
            if (!data.type || !data.poolId) {
                return;
            }
            
            // Handle based on type
            const handler = this.messageHandlers.get(data.type);
            if (handler) {
                handler(data, {
                    address: rinfo.address,
                    port: rinfo.port
                });
            }
            
        } catch (error) {
            // Invalid message, ignore
        }
    }
    
    // Start broadcasting our presence
    startBroadcasting() {
        const broadcast = () => {
            const message = {
                type: 'announce',
                poolId: this.config.poolId,
                poolInfo: this.config.poolInfo,
                p2pPort: this.config.poolInfo.p2pPort || 6633,
                timestamp: Date.now()
            };
            
            // Broadcast to local network
            this.sendBroadcast(message);
            
            // Multicast to group
            this.sendMulticast(message);
        };
        
        // Initial broadcast
        broadcast();
        
        // Regular broadcasts
        this.broadcastInterval = setInterval(broadcast, this.config.broadcastInterval);
    }
    
    // Send broadcast message
    sendBroadcast(message) {
        const data = Buffer.from(JSON.stringify(message));
        
        // Get broadcast address for each interface
        const interfaces = require('os').networkInterfaces();
        
        for (const [name, addresses] of Object.entries(interfaces)) {
            for (const addr of addresses) {
                if (addr.family === 'IPv4' && !addr.internal) {
                    const parts = addr.address.split('.');
                    parts[3] = '255';
                    const broadcastAddr = parts.join('.');
                    
                    this.socket.send(data, this.config.port, broadcastAddr, (err) => {
                        if (err) {
                            console.error(`Broadcast error on ${name}:`, err.message);
                        }
                    });
                }
            }
        }
    }
    
    // Send multicast message
    sendMulticast(message) {
        const data = Buffer.from(JSON.stringify(message));
        
        this.socket.send(data, this.config.port, this.config.multicastAddress, (err) => {
            if (err) {
                console.error('Multicast error:', err.message);
            }
        });
    }
    
    // Send discovery message to specific peer
    sendDiscoveryMessage(address, message) {
        const data = Buffer.from(JSON.stringify(message));
        
        this.socket.send(data, this.config.port, address, (err) => {
            if (err) {
                console.error(`Failed to send to ${address}:`, err.message);
            }
        });
    }
    
    // Start P2P server for incoming connections
    async startP2PServer() {
        const server = net.createServer((socket) => {
            this.handleIncomingConnection(socket);
        });
        
        const port = this.config.poolInfo.p2pPort || 6633;
        
        await new Promise((resolve, reject) => {
            server.listen(port, () => {
                this.p2pServer = server;
                resolve();
            });
            server.on('error', reject);
        });
        
        this.emit('p2p:listening', { port });
    }
    
    // Handle incoming P2P connection
    handleIncomingConnection(socket) {
        const peer = {
            id: null,
            socket,
            address: socket.remoteAddress,
            port: socket.remotePort,
            connected: true,
            lastActivity: Date.now()
        };
        
        // Setup socket handlers
        this.setupPeerHandlers(peer);
        
        // Send handshake
        this.sendToPeer(peer, {
            type: 'handshake',
            poolId: this.config.poolId,
            poolInfo: this.config.poolInfo,
            version: '1.0.0'
        });
    }
    
    // Connect to discovered peer
    async connectToPeer(peerInfo) {
        // Check if already connected
        if (this.connections.has(peerInfo.id)) {
            return;
        }
        
        try {
            const socket = new net.Socket();
            
            // Set timeout
            socket.setTimeout(30000);
            
            // Connect to peer
            await new Promise((resolve, reject) => {
                socket.connect(peerInfo.port, peerInfo.address, () => {
                    resolve();
                });
                socket.on('error', reject);
            });
            
            const peer = {
                id: peerInfo.id,
                socket,
                address: peerInfo.address,
                port: peerInfo.port,
                info: peerInfo,
                connected: true,
                lastActivity: Date.now()
            };
            
            // Setup handlers
            this.setupPeerHandlers(peer);
            
            // Add to connections
            this.connections.set(peerInfo.id, peer);
            this.peers.set(peerInfo.id, peerInfo);
            
            // Send handshake
            this.sendToPeer(peer, {
                type: 'handshake',
                poolId: this.config.poolId,
                poolInfo: this.config.poolInfo,
                version: '1.0.0'
            });
            
            this.emit('peer:connected', peer);
            
        } catch (error) {
            this.emit('peer:error', { peer: peerInfo, error });
            
            // Retry after delay
            setTimeout(() => {
                if (!this.connections.has(peerInfo.id)) {
                    this.connectToPeer(peerInfo);
                }
            }, this.config.reconnectDelay);
        }
    }
    
    // Setup peer connection handlers
    setupPeerHandlers(peer) {
        let buffer = Buffer.alloc(0);
        
        // Handle incoming data
        peer.socket.on('data', (data) => {
            buffer = Buffer.concat([buffer, data]);
            
            // Process messages
            while (buffer.length >= 4) {
                const length = buffer.readUInt32BE(0);
                
                if (buffer.length < 4 + length) {
                    break; // Wait for more data
                }
                
                const messageData = buffer.slice(4, 4 + length);
                buffer = buffer.slice(4 + length);
                
                try {
                    const message = JSON.parse(messageData.toString());
                    this.handlePeerMessage(peer, message);
                } catch (error) {
                    console.error('Invalid peer message:', error);
                }
            }
            
            peer.lastActivity = Date.now();
        });
        
        // Handle socket close
        peer.socket.on('close', () => {
            peer.connected = false;
            if (peer.id) {
                this.connections.delete(peer.id);
                this.emit('peer:disconnected', peer.id);
            }
        });
        
        // Handle socket error
        peer.socket.on('error', (error) => {
            console.error(`Peer socket error (${peer.address}):`, error.message);
        });
    }
    
    // Handle peer message
    handlePeerMessage(peer, message) {
        switch (message.type) {
            case 'handshake':
                peer.id = message.poolId;
                peer.info = message.poolInfo;
                this.connections.set(peer.id, peer);
                
                // Send handshake response if needed
                if (!message.response) {
                    this.sendToPeer(peer, {
                        type: 'handshake',
                        response: true,
                        poolId: this.config.poolId,
                        poolInfo: this.config.poolInfo,
                        version: '1.0.0'
                    });
                }
                break;
                
            case 'share':
                this.emit('share:received', message.data);
                break;
                
            case 'work':
                this.emit('work:received', message.data);
                break;
                
            case 'block':
                this.emit('block:received', message.data);
                break;
                
            case 'ping':
                this.sendToPeer(peer, { type: 'pong', timestamp: Date.now() });
                break;
                
            case 'pong':
                peer.latency = Date.now() - message.timestamp;
                break;
                
            default:
                this.emit('message', { peer, message });
        }
    }
    
    // Send message to peer
    sendToPeer(peer, message) {
        if (!peer.connected || !peer.socket) {
            return false;
        }
        
        try {
            const data = Buffer.from(JSON.stringify(message));
            const length = Buffer.allocUnsafe(4);
            length.writeUInt32BE(data.length, 0);
            
            peer.socket.write(Buffer.concat([length, data]));
            return true;
            
        } catch (error) {
            console.error('Failed to send to peer:', error);
            return false;
        }
    }
    
    // Broadcast message to all peers
    broadcast(message) {
        for (const peer of this.connections.values()) {
            this.sendToPeer(peer, message);
        }
    }
    
    // Get connected peers
    getConnectedPeers() {
        return Array.from(this.connections.values())
            .filter(p => p.connected)
            .map(p => ({
                id: p.id,
                address: p.address,
                port: p.port,
                info: p.info,
                latency: p.latency || null
            }));
    }
    
    // Request peers from network
    requestPeers() {
        this.sendBroadcast({
            type: 'peer-request',
            poolId: this.config.poolId,
            timestamp: Date.now()
        });
    }
    
    // Ping all peers
    pingPeers() {
        for (const peer of this.connections.values()) {
            this.sendToPeer(peer, {
                type: 'ping',
                timestamp: Date.now()
            });
        }
    }
    
    // Stop discovery service
    async stop() {
        // Stop broadcasting
        if (this.broadcastInterval) {
            clearInterval(this.broadcastInterval);
        }
        
        // Close all peer connections
        for (const peer of this.connections.values()) {
            if (peer.socket) {
                peer.socket.destroy();
            }
        }
        
        // Close P2P server
        if (this.p2pServer) {
            await new Promise((resolve) => {
                this.p2pServer.close(resolve);
            });
        }
        
        // Close discovery socket
        if (this.socket) {
            await new Promise((resolve) => {
                this.socket.close(resolve);
            });
        }
        
        this.emit('stopped');
    }
}

module.exports = AutoDiscovery;