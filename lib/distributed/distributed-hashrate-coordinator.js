const { EventEmitter } = require('events');
const cluster = require('cluster');
const dgram = require('dgram');
const crypto = require('crypto');

class DistributedHashrateCoordinator extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.config = {
            nodeId: options.nodeId || this.generateNodeId(),
            coordinatorPort: options.coordinatorPort || 9999,
            heartbeatInterval: options.heartbeatInterval || 5000,
            nodeTimeout: options.nodeTimeout || 30000,
            rebalanceThreshold: options.rebalanceThreshold || 0.2,
            enableAutoScaling: options.enableAutoScaling !== false,
            targetEfficiency: options.targetEfficiency || 0.95,
            ...options
        };
        
        this.nodes = new Map();
        this.localWorkers = new Map();
        this.workDistribution = new Map();
        
        // Global hashrate tracking
        this.globalHashrate = {
            total: 0,
            perNode: new Map(),
            perAlgorithm: new Map(),
            history: []
        };
        
        // Work allocation
        this.workQueue = [];
        this.completedWork = new Map();
        
        // Consensus state
        this.consensusState = {
            leader: null,
            term: 0,
            votedFor: null,
            lastHeartbeat: 0
        };
        
        this.isCoordinator = false;
        this.socket = null;
    }

    async start() {
        if (cluster.isMaster) {
            await this.startCoordinator();
        } else {
            await this.startWorker();
        }
        
        this.emit('started', { nodeId: this.config.nodeId, role: cluster.isMaster ? 'coordinator' : 'worker' });
    }

    async startCoordinator() {
        // Setup UDP socket for node discovery
        this.socket = dgram.createSocket('udp4');
        
        this.socket.on('message', (msg, rinfo) => {
            this.handleNodeMessage(msg, rinfo);
        });
        
        this.socket.bind(this.config.coordinatorPort, () => {
            this.socket.setBroadcast(true);
        });
        
        // Start leader election
        this.startLeaderElection();
        
        // Start monitoring
        this.startNodeMonitoring();
        this.startWorkDistribution();
        this.startAutoScaling();
        
        // Fork initial workers
        const numCPUs = require('os').cpus().length;
        for (let i = 0; i < numCPUs; i++) {
            this.forkWorker();
        }
    }

    async startWorker() {
        // Worker process - connect to coordinator
        process.on('message', (msg) => {
            this.handleCoordinatorMessage(msg);
        });
        
        // Report capabilities
        process.send({
            type: 'worker-ready',
            workerId: process.pid,
            capabilities: await this.detectCapabilities()
        });
        
        // Start work processing
        this.startWorkProcessing();
    }

    forkWorker() {
        const worker = cluster.fork();
        
        this.localWorkers.set(worker.id, {
            id: worker.id,
            pid: worker.process.pid,
            state: 'starting',
            hashrate: 0,
            shares: { accepted: 0, rejected: 0 },
            startTime: Date.now()
        });
        
        worker.on('message', (msg) => {
            this.handleWorkerMessage(worker.id, msg);
        });
        
        worker.on('exit', (code, signal) => {
            this.handleWorkerExit(worker.id, code, signal);
        });
        
        return worker;
    }

    handleNodeMessage(msg, rinfo) {
        try {
            const data = JSON.parse(msg.toString());
            
            switch (data.type) {
                case 'node-announce':
                    this.handleNodeAnnounce(data, rinfo);
                    break;
                case 'heartbeat':
                    this.handleHeartbeat(data, rinfo);
                    break;
                case 'vote-request':
                    this.handleVoteRequest(data, rinfo);
                    break;
                case 'vote-response':
                    this.handleVoteResponse(data);
                    break;
                case 'work-report':
                    this.handleWorkReport(data);
                    break;
            }
        } catch (error) {
            // Invalid message
        }
    }

    handleNodeAnnounce(data, rinfo) {
        const nodeId = data.nodeId;
        
        if (!this.nodes.has(nodeId)) {
            this.nodes.set(nodeId, {
                id: nodeId,
                address: rinfo.address,
                port: data.port || rinfo.port,
                capabilities: data.capabilities,
                hashrate: 0,
                lastSeen: Date.now(),
                workload: 0
            });
            
            this.emit('node:joined', { nodeId });
            
            // Send current state
            this.sendToNode(nodeId, {
                type: 'state-sync',
                leader: this.consensusState.leader,
                nodes: Array.from(this.nodes.keys()),
                work: this.getCurrentWorkState()
            });
        }
        
        this.nodes.get(nodeId).lastSeen = Date.now();
    }

    handleHeartbeat(data, rinfo) {
        const node = this.nodes.get(data.nodeId);
        if (!node) return;
        
        node.lastSeen = Date.now();
        node.hashrate = data.hashrate || 0;
        node.workload = data.workload || 0;
        
        // Update global hashrate
        this.updateGlobalHashrate(data.nodeId, data.hashrate);
        
        // Leader heartbeat
        if (data.nodeId === this.consensusState.leader) {
            this.consensusState.lastHeartbeat = Date.now();
        }
    }

    startLeaderElection() {
        // Simple leader election based on highest node ID
        setInterval(() => {
            const now = Date.now();
            
            // Check if leader is alive
            if (this.consensusState.leader && 
                now - this.consensusState.lastHeartbeat > this.config.nodeTimeout) {
                this.initiateElection();
            }
            
            // If no leader, initiate election
            if (!this.consensusState.leader) {
                this.initiateElection();
            }
        }, this.config.heartbeatInterval);
    }

    initiateElection() {
        this.consensusState.term++;
        this.consensusState.votedFor = this.config.nodeId;
        
        const voteRequest = {
            type: 'vote-request',
            nodeId: this.config.nodeId,
            term: this.consensusState.term,
            lastWork: this.completedWork.size
        };
        
        this.broadcast(voteRequest);
        
        // Vote for self
        let votes = 1;
        const majority = Math.floor(this.nodes.size / 2) + 1;
        
        // Set election timeout
        setTimeout(() => {
            if (votes >= majority) {
                this.becomeLeader();
            }
        }, 2000);
    }

    becomeLeader() {
        this.consensusState.leader = this.config.nodeId;
        this.isCoordinator = true;
        
        this.emit('leader:elected', { nodeId: this.config.nodeId });
        
        // Send leader announcement
        this.broadcast({
            type: 'leader-announce',
            nodeId: this.config.nodeId,
            term: this.consensusState.term
        });
        
        // Start leader duties
        this.startLeaderHeartbeat();
    }

    startLeaderHeartbeat() {
        this.leaderHeartbeat = setInterval(() => {
            if (this.isCoordinator) {
                this.broadcast({
                    type: 'heartbeat',
                    nodeId: this.config.nodeId,
                    term: this.consensusState.term,
                    hashrate: this.getLocalHashrate(),
                    workload: this.getLocalWorkload()
                });
            }
        }, this.config.heartbeatInterval / 2);
    }

    startNodeMonitoring() {
        setInterval(() => {
            const now = Date.now();
            const deadNodes = [];
            
            for (const [nodeId, node] of this.nodes) {
                if (now - node.lastSeen > this.config.nodeTimeout) {
                    deadNodes.push(nodeId);
                }
            }
            
            // Remove dead nodes
            for (const nodeId of deadNodes) {
                this.nodes.delete(nodeId);
                this.globalHashrate.perNode.delete(nodeId);
                this.emit('node:left', { nodeId });
                
                // Redistribute work from dead node
                this.redistributeWork(nodeId);
            }
            
            // Update metrics
            this.updateMetrics();
        }, 10000);
    }

    startWorkDistribution() {
        setInterval(() => {
            if (!this.isCoordinator) return;
            
            this.balanceWorkload();
            this.optimizeDistribution();
            
        }, 30000);
    }

    balanceWorkload() {
        const nodes = Array.from(this.nodes.values());
        if (nodes.length === 0) return;
        
        // Calculate average workload
        const totalHashrate = nodes.reduce((sum, node) => sum + node.hashrate, 0);
        const avgWorkload = 1 / nodes.length;
        
        // Find imbalanced nodes
        const overloaded = [];
        const underloaded = [];
        
        for (const node of nodes) {
            const workloadRatio = node.workload;
            
            if (workloadRatio > avgWorkload * (1 + this.config.rebalanceThreshold)) {
                overloaded.push(node);
            } else if (workloadRatio < avgWorkload * (1 - this.config.rebalanceThreshold)) {
                underloaded.push(node);
            }
        }
        
        // Rebalance work
        for (const overNode of overloaded) {
            for (const underNode of underloaded) {
                const work = this.findTransferableWork(overNode.id, underNode.id);
                if (work) {
                    this.transferWork(work, overNode.id, underNode.id);
                }
            }
        }
    }

    optimizeDistribution() {
        // Group nodes by capability
        const nodesByCapability = new Map();
        
        for (const [nodeId, node] of this.nodes) {
            const key = this.getCapabilityKey(node.capabilities);
            if (!nodesByCapability.has(key)) {
                nodesByCapability.set(key, []);
            }
            nodesByCapability.get(key).push(nodeId);
        }
        
        // Assign work based on capabilities
        for (const work of this.workQueue) {
            const optimalNodes = this.findOptimalNodes(work, nodesByCapability);
            if (optimalNodes.length > 0) {
                this.assignWork(work, optimalNodes);
            }
        }
    }

    startAutoScaling() {
        if (!this.config.enableAutoScaling) return;
        
        setInterval(() => {
            const metrics = this.calculateEfficiencyMetrics();
            
            if (metrics.efficiency < this.config.targetEfficiency) {
                // Scale up
                if (this.localWorkers.size < require('os').cpus().length * 2) {
                    this.forkWorker();
                    this.emit('scaling:up', { workers: this.localWorkers.size });
                }
            } else if (metrics.efficiency > this.config.targetEfficiency + 0.05) {
                // Scale down
                if (this.localWorkers.size > 1) {
                    const worker = this.selectWorkerToTerminate();
                    if (worker) {
                        this.terminateWorker(worker.id);
                        this.emit('scaling:down', { workers: this.localWorkers.size });
                    }
                }
            }
        }, 60000);
    }

    handleWorkerMessage(workerId, msg) {
        const worker = this.localWorkers.get(workerId);
        if (!worker) return;
        
        switch (msg.type) {
            case 'hashrate-update':
                worker.hashrate = msg.hashrate;
                this.updateLocalHashrate();
                break;
                
            case 'share-found':
                worker.shares.accepted++;
                this.handleShareFound(msg.share);
                break;
                
            case 'share-rejected':
                worker.shares.rejected++;
                break;
                
            case 'work-completed':
                this.handleWorkCompleted(workerId, msg.work);
                break;
        }
    }

    handleWorkerExit(workerId, code, signal) {
        const worker = this.localWorkers.get(workerId);
        if (!worker) return;
        
        this.localWorkers.delete(workerId);
        this.emit('worker:exit', { workerId, code, signal });
        
        // Restart worker if unexpected exit
        if (code !== 0 && this.localWorkers.size < require('os').cpus().length) {
            setTimeout(() => this.forkWorker(), 1000);
        }
    }

    assignWork(work, nodeIds) {
        const assignments = [];
        
        for (const nodeId of nodeIds) {
            const assignment = {
                id: this.generateWorkId(),
                work: work,
                nodeId: nodeId,
                assignedAt: Date.now(),
                status: 'pending'
            };
            
            this.workDistribution.set(assignment.id, assignment);
            assignments.push(assignment);
            
            // Send work to node
            if (nodeId === this.config.nodeId) {
                this.distributeToLocalWorkers(assignment);
            } else {
                this.sendToNode(nodeId, {
                    type: 'work-assignment',
                    assignment: assignment
                });
            }
        }
        
        return assignments;
    }

    distributeToLocalWorkers(assignment) {
        // Distribute work among local workers
        const workers = Array.from(this.localWorkers.values())
            .filter(w => w.state === 'ready')
            .sort((a, b) => a.hashrate - b.hashrate);
        
        if (workers.length === 0) return;
        
        // Assign to least loaded worker
        const worker = workers[0];
        const workerProcess = cluster.workers[worker.id];
        
        if (workerProcess) {
            workerProcess.send({
                type: 'work-assignment',
                work: assignment.work
            });
        }
    }

    handleShareFound(share) {
        // Validate share
        if (this.validateShare(share)) {
            // Broadcast to network
            this.broadcast({
                type: 'share-found',
                nodeId: this.config.nodeId,
                share: share,
                timestamp: Date.now()
            });
            
            this.emit('share:found', share);
        }
    }

    validateShare(share) {
        // Implement share validation logic
        return true;
    }

    updateGlobalHashrate(nodeId, hashrate) {
        this.globalHashrate.perNode.set(nodeId, hashrate);
        
        // Calculate total
        let total = 0;
        for (const rate of this.globalHashrate.perNode.values()) {
            total += rate;
        }
        
        this.globalHashrate.total = total;
        
        // Update history
        this.globalHashrate.history.push({
            timestamp: Date.now(),
            total: total,
            nodes: this.nodes.size
        });
        
        // Keep only recent history
        if (this.globalHashrate.history.length > 1000) {
            this.globalHashrate.history.shift();
        }
        
        this.emit('hashrate:updated', {
            total: total,
            perNode: Object.fromEntries(this.globalHashrate.perNode)
        });
    }

    getLocalHashrate() {
        let total = 0;
        for (const worker of this.localWorkers.values()) {
            total += worker.hashrate || 0;
        }
        return total;
    }

    getLocalWorkload() {
        const assigned = Array.from(this.workDistribution.values())
            .filter(w => w.nodeId === this.config.nodeId && w.status === 'pending')
            .length;
        
        const capacity = this.localWorkers.size * 10; // Arbitrary capacity
        return assigned / capacity;
    }

    calculateEfficiencyMetrics() {
        const workers = Array.from(this.localWorkers.values());
        
        let totalHashrate = 0;
        let totalShares = 0;
        let totalRejected = 0;
        
        for (const worker of workers) {
            totalHashrate += worker.hashrate || 0;
            totalShares += worker.shares.accepted;
            totalRejected += worker.shares.rejected;
        }
        
        const rejectionRate = totalShares > 0 ? totalRejected / totalShares : 0;
        const efficiency = 1 - rejectionRate;
        
        return {
            hashrate: totalHashrate,
            efficiency: efficiency,
            workers: workers.length,
            sharesPerHour: (totalShares / ((Date.now() - Math.min(...workers.map(w => w.startTime))) / 3600000))
        };
    }

    selectWorkerToTerminate() {
        // Select worker with lowest efficiency
        let worstWorker = null;
        let worstEfficiency = 1;
        
        for (const [id, worker] of this.localWorkers) {
            const efficiency = worker.shares.accepted / 
                (worker.shares.accepted + worker.shares.rejected || 1);
            
            if (efficiency < worstEfficiency) {
                worstEfficiency = efficiency;
                worstWorker = { id, efficiency };
            }
        }
        
        return worstWorker;
    }

    terminateWorker(workerId) {
        const worker = cluster.workers[workerId];
        if (worker) {
            worker.send({ type: 'shutdown' });
            setTimeout(() => worker.kill(), 5000);
        }
    }

    async detectCapabilities() {
        const os = require('os');
        const cpus = os.cpus();
        
        return {
            cpu: {
                model: cpus[0]?.model,
                cores: cpus.length,
                speed: cpus[0]?.speed
            },
            memory: {
                total: os.totalmem(),
                free: os.freemem()
            },
            algorithms: ['sha256', 'scrypt', 'ethash', 'kawpow', 'randomx'],
            features: {
                gpu: await this.detectGPU(),
                avx: true,
                aes: true
            }
        };
    }

    async detectGPU() {
        // Simplified GPU detection
        try {
            const { exec } = require('child_process').promises;
            await exec('nvidia-smi');
            return true;
        } catch {
            return false;
        }
    }

    broadcast(message) {
        const msg = Buffer.from(JSON.stringify(message));
        this.socket.send(msg, 0, msg.length, this.config.coordinatorPort, '255.255.255.255');
    }

    sendToNode(nodeId, message) {
        const node = this.nodes.get(nodeId);
        if (!node) return;
        
        const msg = Buffer.from(JSON.stringify(message));
        this.socket.send(msg, 0, msg.length, node.port, node.address);
    }

    generateNodeId() {
        return crypto.randomBytes(16).toString('hex');
    }

    generateWorkId() {
        return `${this.config.nodeId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    getCapabilityKey(capabilities) {
        return `${capabilities.cpu.cores}-${capabilities.features.gpu ? 'gpu' : 'cpu'}`;
    }

    getStatus() {
        return {
            nodeId: this.config.nodeId,
            role: this.isCoordinator ? 'leader' : 'follower',
            leader: this.consensusState.leader,
            nodes: this.nodes.size,
            workers: this.localWorkers.size,
            hashrate: {
                local: this.getLocalHashrate(),
                global: this.globalHashrate.total
            },
            workload: this.getLocalWorkload(),
            efficiency: this.calculateEfficiencyMetrics()
        };
    }

    stop() {
        // Stop all workers
        for (const workerId of this.localWorkers.keys()) {
            this.terminateWorker(workerId);
        }
        
        // Close socket
        if (this.socket) {
            this.socket.close();
        }
        
        // Clear intervals
        if (this.leaderHeartbeat) {
            clearInterval(this.leaderHeartbeat);
        }
        
        this.emit('stopped');
    }
}

module.exports = DistributedHashrateCoordinator;