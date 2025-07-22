const cluster = require('cluster');
const os = require('os');
const net = require('net');
const EventEmitter = require('events');

class ClusterManager extends EventEmitter {
    constructor(config) {
        super();
        this.config = {
            workers: config.workers || os.cpus().length,
            port: config.port || 3333,
            host: config.host || '0.0.0.0',
            isMaster: config.isMaster !== false,
            peers: config.peers || [],
            sharedMemory: new Map(),
            ...config
        };
        
        this.workers = new Map();
        this.connections = 0;
        this.shareCount = 0;
    }
    
    async start() {
        if (cluster.isMaster && this.config.isMaster) {
            await this.startMaster();
        } else {
            await this.startWorker();
        }
    }
    
    async startMaster() {
        console.log(`Master ${process.pid} starting...`);
        
        // Fork workers
        for (let i = 0; i < this.config.workers; i++) {
            this.forkWorker();
        }
        
        // Handle worker messages
        cluster.on('message', (worker, message) => {
            if (message.type === 'share') {
                this.handleShare(worker, message);
            } else if (message.type === 'stats') {
                this.updateStats(worker, message);
            }
        });
        
        // Worker management
        cluster.on('exit', (worker, code, signal) => {
            console.log(`Worker ${worker.process.pid} died. Restarting...`);
            this.workers.delete(worker.id);
            this.forkWorker();
        });
        
        // Load balancing server
        this.createLoadBalancer();
        
        // Peer synchronization
        if (this.config.peers.length > 0) {
            await this.connectToPeers();
        }
        
        // Stats reporting
        setInterval(() => this.reportStats(), 10000);
    }
    
    forkWorker() {
        const worker = cluster.fork();
        this.workers.set(worker.id, {
            id: worker.id,
            process: worker,
            connections: 0,
            shares: 0,
            hashrate: 0
        });
        
        worker.send({
            type: 'config',
            config: this.config
        });
    }
    
    createLoadBalancer() {
        const server = net.createServer(socket => {
            // Find worker with least connections
            let selectedWorker = null;
            let minConnections = Infinity;
            
            for (const [id, workerInfo] of this.workers) {
                if (workerInfo.connections < minConnections) {
                    minConnections = workerInfo.connections;
                    selectedWorker = workerInfo;
                }
            }
            
            if (selectedWorker) {
                selectedWorker.connections++;
                selectedWorker.process.send({
                    type: 'connection'
                }, socket);
            } else {
                socket.end();
            }
        });
        
        server.listen(this.config.port, this.config.host, () => {
            console.log(`Load balancer listening on ${this.config.host}:${this.config.port}`);
        });
    }
    
    async connectToPeers() {
        for (const peer of this.config.peers) {
            try {
                const socket = net.connect(peer.port, peer.host);
                
                socket.on('connect', () => {
                    console.log(`Connected to peer ${peer.host}:${peer.port}`);
                    socket.write(JSON.stringify({
                        type: 'peer_hello',
                        id: process.pid,
                        workers: this.workers.size
                    }) + '\n');
                });
                
                socket.on('data', data => {
                    const messages = data.toString().split('\n').filter(m => m);
                    for (const message of messages) {
                        try {
                            const msg = JSON.parse(message);
                            this.handlePeerMessage(msg, socket);
                        } catch (err) {
                            console.error('Invalid peer message:', err);
                        }
                    }
                });
                
                socket.on('error', err => {
                    console.error(`Peer connection error (${peer.host}:${peer.port}):`, err.message);
                });
            } catch (err) {
                console.error(`Failed to connect to peer ${peer.host}:${peer.port}:`, err.message);
            }
        }
    }
    
    handleShare(worker, message) {
        this.shareCount++;
        const workerInfo = this.workers.get(worker.id);
        if (workerInfo) {
            workerInfo.shares++;
        }
        
        // Broadcast to peers
        this.broadcastToPeers({
            type: 'share',
            workerId: worker.id,
            share: message.share
        });
        
        this.emit('share', message.share);
    }
    
    updateStats(worker, message) {
        const workerInfo = this.workers.get(worker.id);
        if (workerInfo) {
            workerInfo.hashrate = message.hashrate;
            workerInfo.connections = message.connections;
        }
    }
    
    reportStats() {
        let totalHashrate = 0;
        let totalConnections = 0;
        
        for (const [id, workerInfo] of this.workers) {
            totalHashrate += workerInfo.hashrate;
            totalConnections += workerInfo.connections;
        }
        
        console.log(`Cluster Stats - Workers: ${this.workers.size}, Connections: ${totalConnections}, Hashrate: ${(totalHashrate / 1e6).toFixed(2)} MH/s, Shares: ${this.shareCount}`);
        
        this.emit('stats', {
            workers: this.workers.size,
            connections: totalConnections,
            hashrate: totalHashrate,
            shares: this.shareCount
        });
    }
    
    async startWorker() {
        console.log(`Worker ${process.pid} started`);
        
        // Import pool implementation
        const SimpleMiningPool = require('../core/simple-mining-pool');
        const pool = new SimpleMiningPool(this.config);
        
        // Handle master messages
        process.on('message', (message, socket) => {
            if (message.type === 'connection' && socket) {
                pool.handleConnection(socket);
            } else if (message.type === 'config') {
                Object.assign(pool.config, message.config);
            }
        });
        
        // Report stats to master
        setInterval(() => {
            process.send({
                type: 'stats',
                hashrate: pool.getTotalHashrate(),
                connections: pool.getConnectionCount()
            });
        }, 5000);
        
        // Forward shares to master
        pool.on('share', share => {
            process.send({
                type: 'share',
                share: share
            });
        });
        
        await pool.start();
    }
    
    broadcastToPeers(message) {
        // Implement peer broadcasting
        // This would send messages to connected peer nodes
    }
    
    handlePeerMessage(message, socket) {
        // Handle messages from peer nodes
        if (message.type === 'share') {
            // Validate and process peer shares
            this.emit('peer_share', message);
        }
    }
}

module.exports = ClusterManager;