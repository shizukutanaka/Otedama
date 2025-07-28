const { EventEmitter } = require('events');
const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');

class ConnectionStabilityManager extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.config = {
            maxPeers: options.maxPeers || 50,
            minPeers: options.minPeers || 10,
            connectionTimeout: options.connectionTimeout || 10000,
            pingInterval: options.pingInterval || 30000,
            reconnectDelay: options.reconnectDelay || 5000,
            maxReconnectAttempts: options.maxReconnectAttempts || 5,
            peerScoreThreshold: options.peerScoreThreshold || 0.5,
            redundancyFactor: options.redundancyFactor || 3,
            ...options
        };
        
        this.peers = new Map();
        this.connections = new Map();
        this.connectionAttempts = new Map();
        this.messageQueue = new Map();
        this.peerScores = new Map();
        
        // Connection metrics
        this.metrics = {
            totalConnections: 0,
            activeConnections: 0,
            failedConnections: 0,
            reconnections: 0,
            avgLatency: 0,
            networkHealth: 100
        };
        
        // Connection strategies
        this.strategies = {
            geographic: this.geographicDistribution.bind(this),
            latency: this.latencyOptimized.bind(this),
            reliability: this.reliabilityFocused.bind(this),
            hybrid: this.hybridStrategy.bind(this)
        };
        
        this.currentStrategy = 'hybrid';
        this.isRunning = false;
    }

    async start() {
        if (this.isRunning) return;
        
        this.isRunning = true;
        this.emit('manager:started');
        
        // Start connection monitoring
        this.startConnectionMonitoring();
        
        // Start peer discovery
        this.startPeerDiscovery();
        
        // Start health checks
        this.startHealthChecks();
    }

    async stop() {
        this.isRunning = false;
        
        // Close all connections gracefully
        for (const [peerId, connection] of this.connections) {
            await this.closeConnection(peerId, 'manager-shutdown');
        }
        
        this.emit('manager:stopped');
    }

    startConnectionMonitoring() {
        setInterval(() => {
            this.checkConnectionHealth();
            this.optimizeConnections();
            this.updateMetrics();
        }, 5000);
    }

    startPeerDiscovery() {
        // UDP broadcast for peer discovery
        this.discoverySocket = dgram.createSocket('udp4');
        
        this.discoverySocket.on('message', (msg, rinfo) => {
            try {
                const data = JSON.parse(msg.toString());
                if (data.type === 'peer-announce') {
                    this.handlePeerAnnouncement(data, rinfo);
                }
            } catch (error) {
                // Invalid message
            }
        });
        
        this.discoverySocket.bind(() => {
            this.discoverySocket.setBroadcast(true);
            this.broadcastPresence();
        });
        
        // Periodic broadcast
        setInterval(() => {
            if (this.isRunning) {
                this.broadcastPresence();
            }
        }, 60000);
    }

    broadcastPresence() {
        const announcement = {
            type: 'peer-announce',
            peerId: this.generatePeerId(),
            timestamp: Date.now(),
            capabilities: {
                maxConnections: this.config.maxPeers,
                supportedProtocols: ['stratum', 'p2p-v2'],
                features: ['redundancy', 'compression', 'encryption']
            }
        };
        
        const message = Buffer.from(JSON.stringify(announcement));
        this.discoverySocket.send(message, 0, message.length, 9999, '255.255.255.255');
    }

    handlePeerAnnouncement(data, rinfo) {
        const peerId = data.peerId;
        
        if (!this.peers.has(peerId) && this.peers.size < this.config.maxPeers) {
            this.peers.set(peerId, {
                id: peerId,
                address: rinfo.address,
                port: rinfo.port,
                capabilities: data.capabilities,
                discoveredAt: Date.now(),
                score: 1.0
            });
            
            this.emit('peer:discovered', { peerId, address: rinfo.address });
            
            // Attempt connection based on strategy
            this.evaluatePeerConnection(peerId);
        }
    }

    async evaluatePeerConnection(peerId) {
        const peer = this.peers.get(peerId);
        if (!peer) return;
        
        const strategy = this.strategies[this.currentStrategy];
        const shouldConnect = await strategy(peer);
        
        if (shouldConnect && !this.connections.has(peerId)) {
            await this.connectToPeer(peer);
        }
    }

    async connectToPeer(peer) {
        const peerId = peer.id;
        
        // Check connection attempts
        const attempts = this.connectionAttempts.get(peerId) || 0;
        if (attempts >= this.config.maxReconnectAttempts) {
            this.removePeer(peerId, 'max-attempts-reached');
            return;
        }
        
        this.connectionAttempts.set(peerId, attempts + 1);
        
        return new Promise((resolve, reject) => {
            const socket = new net.Socket();
            let connected = false;
            
            // Set connection timeout
            const timeout = setTimeout(() => {
                if (!connected) {
                    socket.destroy();
                    reject(new Error('Connection timeout'));
                }
            }, this.config.connectionTimeout);
            
            socket.on('connect', () => {
                connected = true;
                clearTimeout(timeout);
                
                this.connections.set(peerId, {
                    socket,
                    peer,
                    connectedAt: Date.now(),
                    latency: 0,
                    bytesReceived: 0,
                    bytesSent: 0,
                    lastActivity: Date.now()
                });
                
                this.connectionAttempts.set(peerId, 0);
                this.metrics.totalConnections++;
                this.metrics.activeConnections++;
                
                this.setupConnectionHandlers(peerId, socket);
                this.emit('peer:connected', { peerId, address: peer.address });
                
                resolve(socket);
            });
            
            socket.on('error', (error) => {
                clearTimeout(timeout);
                this.handleConnectionError(peerId, error);
                reject(error);
            });
            
            socket.connect(peer.port || 9333, peer.address);
        });
    }

    setupConnectionHandlers(peerId, socket) {
        const connection = this.connections.get(peerId);
        
        socket.on('data', (data) => {
            connection.bytesReceived += data.length;
            connection.lastActivity = Date.now();
            this.handlePeerMessage(peerId, data);
        });
        
        socket.on('close', () => {
            this.handleConnectionClose(peerId);
        });
        
        socket.on('error', (error) => {
            this.handleConnectionError(peerId, error);
        });
        
        // Start ping/pong for latency measurement
        this.startPingPong(peerId);
    }

    startPingPong(peerId) {
        const pingInterval = setInterval(() => {
            const connection = this.connections.get(peerId);
            if (!connection) {
                clearInterval(pingInterval);
                return;
            }
            
            const pingId = crypto.randomBytes(4).toString('hex');
            const pingTime = Date.now();
            
            this.sendToPeer(peerId, {
                type: 'ping',
                id: pingId,
                timestamp: pingTime
            });
            
            // Store ping data for latency calculation
            connection.pendingPing = { id: pingId, time: pingTime };
        }, this.config.pingInterval);
        
        // Store interval reference for cleanup
        if (this.connections.has(peerId)) {
            this.connections.get(peerId).pingInterval = pingInterval;
        }
    }

    handlePeerMessage(peerId, data) {
        try {
            const message = JSON.parse(data.toString());
            
            switch (message.type) {
                case 'ping':
                    this.handlePing(peerId, message);
                    break;
                case 'pong':
                    this.handlePong(peerId, message);
                    break;
                case 'share':
                    this.emit('share:received', { peerId, share: message.data });
                    break;
                case 'block':
                    this.emit('block:received', { peerId, block: message.data });
                    break;
                default:
                    this.emit('message:received', { peerId, message });
            }
            
            // Update peer score based on valid messages
            this.updatePeerScore(peerId, 0.01);
            
        } catch (error) {
            // Invalid message format
            this.updatePeerScore(peerId, -0.05);
        }
    }

    handlePing(peerId, message) {
        this.sendToPeer(peerId, {
            type: 'pong',
            id: message.id,
            timestamp: message.timestamp
        });
    }

    handlePong(peerId, message) {
        const connection = this.connections.get(peerId);
        if (!connection || !connection.pendingPing) return;
        
        if (connection.pendingPing.id === message.id) {
            const latency = Date.now() - connection.pendingPing.time;
            connection.latency = latency;
            
            // Update latency history
            if (!connection.latencyHistory) {
                connection.latencyHistory = [];
            }
            connection.latencyHistory.push(latency);
            
            // Keep only last 10 measurements
            if (connection.latencyHistory.length > 10) {
                connection.latencyHistory.shift();
            }
            
            delete connection.pendingPing;
        }
    }

    sendToPeer(peerId, message) {
        const connection = this.connections.get(peerId);
        if (!connection || !connection.socket) return false;
        
        try {
            const data = JSON.stringify(message);
            connection.socket.write(data + '\n');
            connection.bytesSent += data.length;
            connection.lastActivity = Date.now();
            return true;
        } catch (error) {
            this.handleConnectionError(peerId, error);
            return false;
        }
    }

    broadcastMessage(message, excludePeers = []) {
        const results = new Map();
        
        for (const [peerId, connection] of this.connections) {
            if (!excludePeers.includes(peerId)) {
                const sent = this.sendToPeer(peerId, message);
                results.set(peerId, sent);
            }
        }
        
        return results;
    }

    handleConnectionError(peerId, error) {
        this.emit('connection:error', { peerId, error: error.message });
        this.metrics.failedConnections++;
        
        // Update peer score
        this.updatePeerScore(peerId, -0.1);
        
        // Schedule reconnection if appropriate
        const peer = this.peers.get(peerId);
        if (peer && peer.score > this.config.peerScoreThreshold) {
            setTimeout(() => {
                if (this.isRunning && !this.connections.has(peerId)) {
                    this.connectToPeer(peer);
                }
            }, this.config.reconnectDelay);
        }
    }

    handleConnectionClose(peerId) {
        const connection = this.connections.get(peerId);
        if (!connection) return;
        
        // Clean up resources
        if (connection.pingInterval) {
            clearInterval(connection.pingInterval);
        }
        
        this.connections.delete(peerId);
        this.metrics.activeConnections--;
        
        this.emit('peer:disconnected', { peerId });
        
        // Ensure minimum connections
        if (this.connections.size < this.config.minPeers) {
            this.maintainMinimumConnections();
        }
    }

    async closeConnection(peerId, reason) {
        const connection = this.connections.get(peerId);
        if (!connection) return;
        
        try {
            // Send disconnect message
            this.sendToPeer(peerId, {
                type: 'disconnect',
                reason
            });
            
            // Close socket
            connection.socket.end();
            connection.socket.destroy();
        } catch (error) {
            // Force close
            connection.socket.destroy();
        }
        
        this.handleConnectionClose(peerId);
    }

    updatePeerScore(peerId, delta) {
        const currentScore = this.peerScores.get(peerId) || 1.0;
        const newScore = Math.max(0, Math.min(1, currentScore + delta));
        this.peerScores.set(peerId, newScore);
        
        const peer = this.peers.get(peerId);
        if (peer) {
            peer.score = newScore;
        }
        
        // Remove peer if score too low
        if (newScore < 0.1) {
            this.removePeer(peerId, 'low-score');
        }
    }

    removePeer(peerId, reason) {
        this.closeConnection(peerId, reason);
        this.peers.delete(peerId);
        this.peerScores.delete(peerId);
        this.connectionAttempts.delete(peerId);
        
        this.emit('peer:removed', { peerId, reason });
    }

    checkConnectionHealth() {
        const now = Date.now();
        const unhealthyConnections = [];
        
        for (const [peerId, connection] of this.connections) {
            // Check for stale connections
            if (now - connection.lastActivity > 120000) { // 2 minutes
                unhealthyConnections.push(peerId);
                continue;
            }
            
            // Check latency
            if (connection.latencyHistory && connection.latencyHistory.length > 5) {
                const avgLatency = connection.latencyHistory.reduce((a, b) => a + b) / connection.latencyHistory.length;
                if (avgLatency > 1000) { // 1 second
                    this.updatePeerScore(peerId, -0.02);
                }
            }
        }
        
        // Remove unhealthy connections
        for (const peerId of unhealthyConnections) {
            this.closeConnection(peerId, 'unhealthy');
        }
    }

    optimizeConnections() {
        // Ensure minimum connections
        if (this.connections.size < this.config.minPeers) {
            this.maintainMinimumConnections();
        }
        
        // Replace poor performing peers
        if (this.connections.size >= this.config.maxPeers * 0.8) {
            this.replacePoorPerformers();
        }
        
        // Balance geographic distribution
        this.balanceGeographicDistribution();
    }

    maintainMinimumConnections() {
        const needed = this.config.minPeers - this.connections.size;
        if (needed <= 0) return;
        
        // Sort unconnected peers by score
        const availablePeers = Array.from(this.peers.values())
            .filter(peer => !this.connections.has(peer.id))
            .sort((a, b) => b.score - a.score);
        
        // Connect to best available peers
        for (let i = 0; i < Math.min(needed, availablePeers.length); i++) {
            this.connectToPeer(availablePeers[i]);
        }
    }

    replacePoorPerformers() {
        // Find worst performing connected peers
        const connectedPeers = Array.from(this.connections.keys())
            .map(peerId => ({ peerId, score: this.peerScores.get(peerId) || 0 }))
            .sort((a, b) => a.score - b.score);
        
        // Find best unconnected peers
        const availablePeers = Array.from(this.peers.values())
            .filter(peer => !this.connections.has(peer.id))
            .sort((a, b) => b.score - a.score);
        
        // Replace if significant improvement possible
        for (let i = 0; i < Math.min(3, connectedPeers.length, availablePeers.length); i++) {
            if (availablePeers[i].score > connectedPeers[i].score + 0.2) {
                this.closeConnection(connectedPeers[i].peerId, 'optimization');
                this.connectToPeer(availablePeers[i]);
            }
        }
    }

    balanceGeographicDistribution() {
        // Implement geographic distribution logic
        // This would use IP geolocation to ensure diverse peer locations
    }

    startHealthChecks() {
        setInterval(() => {
            this.calculateNetworkHealth();
            this.emit('health:updated', {
                health: this.metrics.networkHealth,
                metrics: { ...this.metrics }
            });
        }, 10000);
    }

    calculateNetworkHealth() {
        let health = 100;
        
        // Connection ratio
        const connectionRatio = this.connections.size / this.config.minPeers;
        if (connectionRatio < 1) {
            health -= (1 - connectionRatio) * 30;
        }
        
        // Average latency
        const avgLatency = this.calculateAverageLatency();
        if (avgLatency > 500) {
            health -= Math.min(20, (avgLatency - 500) / 50);
        }
        
        // Peer quality
        const avgPeerScore = this.calculateAveragePeerScore();
        health *= avgPeerScore;
        
        // Recent failures
        const recentFailureRate = this.metrics.failedConnections / (this.metrics.totalConnections || 1);
        if (recentFailureRate > 0.1) {
            health -= recentFailureRate * 20;
        }
        
        this.metrics.networkHealth = Math.max(0, Math.min(100, health));
    }

    calculateAverageLatency() {
        let totalLatency = 0;
        let count = 0;
        
        for (const connection of this.connections.values()) {
            if (connection.latency) {
                totalLatency += connection.latency;
                count++;
            }
        }
        
        this.metrics.avgLatency = count > 0 ? totalLatency / count : 0;
        return this.metrics.avgLatency;
    }

    calculateAveragePeerScore() {
        let totalScore = 0;
        let count = 0;
        
        for (const score of this.peerScores.values()) {
            totalScore += score;
            count++;
        }
        
        return count > 0 ? totalScore / count : 0.5;
    }

    updateMetrics() {
        this.metrics.activeConnections = this.connections.size;
        this.calculateAverageLatency();
        
        this.emit('metrics:updated', { ...this.metrics });
    }

    // Connection strategies
    async geographicDistribution(peer) {
        // Prefer geographically diverse peers
        return true; // Simplified
    }

    async latencyOptimized(peer) {
        // Test latency before deciding
        const testLatency = await this.testPeerLatency(peer);
        return testLatency < 100; // 100ms threshold
    }

    async reliabilityFocused(peer) {
        // Check peer history and reputation
        return peer.score > 0.7;
    }

    async hybridStrategy(peer) {
        // Combine multiple factors
        const latencyOk = await this.latencyOptimized(peer);
        const reliable = peer.score > 0.5;
        
        return latencyOk && reliable;
    }

    async testPeerLatency(peer) {
        return new Promise((resolve) => {
            const start = Date.now();
            const socket = new net.Socket();
            
            socket.setTimeout(5000);
            
            socket.on('connect', () => {
                const latency = Date.now() - start;
                socket.destroy();
                resolve(latency);
            });
            
            socket.on('error', () => {
                socket.destroy();
                resolve(Infinity);
            });
            
            socket.on('timeout', () => {
                socket.destroy();
                resolve(Infinity);
            });
            
            socket.connect(peer.port || 9333, peer.address);
        });
    }

    generatePeerId() {
        return crypto.randomBytes(20).toString('hex');
    }

    getConnectionStatus() {
        return {
            peers: this.peers.size,
            connections: this.connections.size,
            health: this.metrics.networkHealth,
            avgLatency: this.metrics.avgLatency,
            strategy: this.currentStrategy
        };
    }

    setStrategy(strategyName) {
        if (this.strategies[strategyName]) {
            this.currentStrategy = strategyName;
            this.emit('strategy:changed', strategyName);
            
            // Re-evaluate connections with new strategy
            this.optimizeConnections();
        }
    }
}

module.exports = ConnectionStabilityManager;