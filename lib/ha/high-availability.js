const EventEmitter = require('events');
const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');

class HighAvailabilityManager extends EventEmitter {
    constructor(config) {
        super();
        this.config = {
            nodeId: config.nodeId || crypto.randomBytes(16).toString('hex'),
            role: 'candidate', // master, backup, candidate
            heartbeatInterval: config.heartbeatInterval || 1000,
            electionTimeout: config.electionTimeout || 5000,
            nodes: config.nodes || [],
            multicastAddress: config.multicastAddress || '239.255.0.1',
            multicastPort: config.multicastPort || 5555,
            dataPort: config.dataPort || 5556,
            ...config
        };
        
        this.currentTerm = 0;
        this.votedFor = null;
        this.lastHeartbeat = Date.now();
        this.votes = new Set();
        this.nodes = new Map();
        this.isRunning = false;
        
        // State replication
        this.replicationLog = [];
        this.lastAppliedIndex = 0;
    }
    
    async start() {
        this.isRunning = true;
        
        // Initialize node list
        for (const node of this.config.nodes) {
            this.nodes.set(node.id, {
                ...node,
                lastSeen: 0,
                status: 'unknown'
            });
        }
        
        // Start multicast discovery
        await this.startMulticast();
        
        // Start data replication server
        await this.startReplicationServer();
        
        // Start election timeout
        this.startElectionTimer();
        
        // Start heartbeat
        this.startHeartbeat();
        
        console.log(`HA Node ${this.config.nodeId} started as ${this.config.role}`);
    }
    
    async startMulticast() {
        this.multicastSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        
        this.multicastSocket.on('message', (msg, rinfo) => {
            try {
                const message = JSON.parse(msg.toString());
                this.handleMulticastMessage(message, rinfo);
            } catch (err) {
                console.error('Invalid multicast message:', err);
            }
        });
        
        this.multicastSocket.bind(this.config.multicastPort, () => {
            this.multicastSocket.addMembership(this.config.multicastAddress);
            console.log(`Joined multicast group ${this.config.multicastAddress}:${this.config.multicastPort}`);
        });
    }
    
    async startReplicationServer() {
        this.replicationServer = net.createServer(socket => {
            socket.on('data', data => {
                try {
                    const messages = data.toString().split('\n').filter(m => m);
                    for (const message of messages) {
                        const msg = JSON.parse(message);
                        this.handleReplicationMessage(msg, socket);
                    }
                } catch (err) {
                    console.error('Replication error:', err);
                }
            });
        });
        
        this.replicationServer.listen(this.config.dataPort, () => {
            console.log(`Replication server listening on port ${this.config.dataPort}`);
        });
    }
    
    startElectionTimer() {
        this.electionTimer = setInterval(() => {
            if (this.config.role === 'candidate' || this.config.role === 'backup') {
                const timeSinceHeartbeat = Date.now() - this.lastHeartbeat;
                if (timeSinceHeartbeat > this.config.electionTimeout) {
                    this.startElection();
                }
            }
        }, this.config.electionTimeout / 2);
    }
    
    startHeartbeat() {
        this.heartbeatInterval = setInterval(() => {
            if (this.config.role === 'master') {
                this.sendHeartbeat();
            } else {
                // Send discovery message
                this.sendDiscovery();
            }
        }, this.config.heartbeatInterval);
    }
    
    sendHeartbeat() {
        const message = {
            type: 'heartbeat',
            nodeId: this.config.nodeId,
            term: this.currentTerm,
            role: this.config.role,
            timestamp: Date.now(),
            stats: this.getNodeStats()
        };
        
        this.broadcast(message);
    }
    
    sendDiscovery() {
        const message = {
            type: 'discovery',
            nodeId: this.config.nodeId,
            role: this.config.role,
            dataPort: this.config.dataPort,
            timestamp: Date.now()
        };
        
        this.broadcast(message);
    }
    
    broadcast(message) {
        const buffer = Buffer.from(JSON.stringify(message));
        this.multicastSocket.send(
            buffer,
            0,
            buffer.length,
            this.config.multicastPort,
            this.config.multicastAddress
        );
    }
    
    handleMulticastMessage(message, rinfo) {
        if (message.nodeId === this.config.nodeId) return;
        
        switch (message.type) {
            case 'heartbeat':
                this.handleHeartbeat(message);
                break;
            case 'discovery':
                this.handleDiscovery(message, rinfo);
                break;
            case 'vote_request':
                this.handleVoteRequest(message);
                break;
            case 'vote':
                this.handleVote(message);
                break;
        }
    }
    
    handleHeartbeat(message) {
        if (message.term > this.currentTerm) {
            this.currentTerm = message.term;
            this.config.role = 'backup';
            this.votedFor = null;
        }
        
        if (message.role === 'master') {
            this.lastHeartbeat = Date.now();
            this.updateNodeStatus(message.nodeId, 'active', message.stats);
        }
    }
    
    handleDiscovery(message, rinfo) {
        if (!this.nodes.has(message.nodeId)) {
            this.nodes.set(message.nodeId, {
                id: message.nodeId,
                address: rinfo.address,
                dataPort: message.dataPort,
                lastSeen: Date.now(),
                status: 'active'
            });
            
            console.log(`Discovered new node: ${message.nodeId} at ${rinfo.address}:${message.dataPort}`);
        } else {
            this.updateNodeStatus(message.nodeId, 'active');
        }
    }
    
    startElection() {
        console.log(`Node ${this.config.nodeId} starting election for term ${this.currentTerm + 1}`);
        
        this.currentTerm++;
        this.config.role = 'candidate';
        this.votedFor = this.config.nodeId;
        this.votes.clear();
        this.votes.add(this.config.nodeId);
        
        const message = {
            type: 'vote_request',
            nodeId: this.config.nodeId,
            term: this.currentTerm,
            lastLogIndex: this.replicationLog.length,
            timestamp: Date.now()
        };
        
        this.broadcast(message);
        
        // Election timeout
        setTimeout(() => {
            if (this.config.role === 'candidate') {
                const requiredVotes = Math.floor(this.nodes.size / 2) + 1;
                if (this.votes.size >= requiredVotes) {
                    this.becomeLeader();
                } else {
                    console.log(`Election failed. Got ${this.votes.size} votes, needed ${requiredVotes}`);
                    this.config.role = 'backup';
                }
            }
        }, this.config.electionTimeout);
    }
    
    handleVoteRequest(message) {
        if (message.term > this.currentTerm) {
            this.currentTerm = message.term;
            this.votedFor = null;
            this.config.role = 'backup';
        }
        
        if (message.term === this.currentTerm && 
            (this.votedFor === null || this.votedFor === message.nodeId)) {
            
            // Vote for the candidate
            this.votedFor = message.nodeId;
            
            const vote = {
                type: 'vote',
                nodeId: this.config.nodeId,
                term: this.currentTerm,
                voteFor: message.nodeId,
                timestamp: Date.now()
            };
            
            this.broadcast(vote);
        }
    }
    
    handleVote(message) {
        if (message.term === this.currentTerm && 
            message.voteFor === this.config.nodeId &&
            this.config.role === 'candidate') {
            
            this.votes.add(message.nodeId);
        }
    }
    
    becomeLeader() {
        console.log(`Node ${this.config.nodeId} became leader for term ${this.currentTerm}`);
        this.config.role = 'master';
        this.emit('role_change', 'master');
        
        // Send immediate heartbeat
        this.sendHeartbeat();
    }
    
    updateNodeStatus(nodeId, status, stats = {}) {
        const node = this.nodes.get(nodeId);
        if (node) {
            node.status = status;
            node.lastSeen = Date.now();
            node.stats = stats;
        }
    }
    
    // State replication methods
    async replicate(operation) {
        if (this.config.role !== 'master') {
            throw new Error('Only master can initiate replication');
        }
        
        const entry = {
            index: this.replicationLog.length,
            term: this.currentTerm,
            operation: operation,
            timestamp: Date.now()
        };
        
        this.replicationLog.push(entry);
        
        // Send to all backup nodes
        const promises = [];
        for (const [nodeId, node] of this.nodes) {
            if (node.status === 'active' && nodeId !== this.config.nodeId) {
                promises.push(this.sendReplication(node, entry));
            }
        }
        
        // Wait for majority
        const results = await Promise.allSettled(promises);
        const successes = results.filter(r => r.status === 'fulfilled').length;
        const required = Math.floor(this.nodes.size / 2);
        
        if (successes >= required) {
            this.lastAppliedIndex = entry.index;
            this.emit('replicated', entry);
            return true;
        } else {
            // Rollback if not enough replicas
            this.replicationLog.pop();
            throw new Error('Replication failed - insufficient replicas');
        }
    }
    
    async sendReplication(node, entry) {
        return new Promise((resolve, reject) => {
            const socket = net.connect(node.dataPort, node.address);
            
            socket.on('connect', () => {
                socket.write(JSON.stringify({
                    type: 'replicate',
                    entry: entry,
                    nodeId: this.config.nodeId
                }) + '\n');
            });
            
            socket.on('data', data => {
                const response = JSON.parse(data.toString());
                if (response.success) {
                    resolve();
                } else {
                    reject(new Error(response.error));
                }
                socket.end();
            });
            
            socket.on('error', reject);
            
            socket.setTimeout(5000, () => {
                reject(new Error('Replication timeout'));
                socket.destroy();
            });
        });
    }
    
    handleReplicationMessage(message, socket) {
        if (message.type === 'replicate') {
            try {
                this.replicationLog.push(message.entry);
                this.lastAppliedIndex = message.entry.index;
                
                socket.write(JSON.stringify({ success: true }) + '\n');
                this.emit('replicated', message.entry);
            } catch (err) {
                socket.write(JSON.stringify({ 
                    success: false, 
                    error: err.message 
                }) + '\n');
            }
        }
    }
    
    getNodeStats() {
        return {
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            cpu: process.cpuUsage(),
            replicationIndex: this.lastAppliedIndex
        };
    }
    
    getClusterStatus() {
        const activeNodes = Array.from(this.nodes.values())
            .filter(n => n.status === 'active').length;
        
        return {
            nodeId: this.config.nodeId,
            role: this.config.role,
            term: this.currentTerm,
            activeNodes: activeNodes + 1, // Include self
            totalNodes: this.nodes.size + 1,
            replicationLog: this.replicationLog.length,
            lastAppliedIndex: this.lastAppliedIndex,
            nodes: Array.from(this.nodes.values())
        };
    }
    
    async stop() {
        this.isRunning = false;
        
        clearInterval(this.electionTimer);
        clearInterval(this.heartbeatInterval);
        
        if (this.multicastSocket) {
            this.multicastSocket.close();
        }
        
        if (this.replicationServer) {
            this.replicationServer.close();
        }
        
        console.log(`HA Node ${this.config.nodeId} stopped`);
    }
}

module.exports = HighAvailabilityManager;