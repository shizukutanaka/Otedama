/**
 * Horizontal Scaling Manager
 * 水平スケーリング管理システム
 */

const { EventEmitter } = require('events');
const cluster = require('cluster');
const os = require('os');
const net = require('net');

class HorizontalScalingManager extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Cluster configuration
            workers: config.workers || os.cpus().length,
            minWorkers: config.minWorkers || 2,
            maxWorkers: config.maxWorkers || os.cpus().length * 2,
            
            // Auto-scaling
            enableAutoScaling: config.enableAutoScaling !== false,
            scaleUpThreshold: config.scaleUpThreshold || 0.8, // 80% CPU
            scaleDownThreshold: config.scaleDownThreshold || 0.3, // 30% CPU
            scalingInterval: config.scalingInterval || 30000, // 30 seconds
            scalingCooldown: config.scalingCooldown || 60000, // 1 minute
            
            // Load balancing
            loadBalancingStrategy: config.loadBalancingStrategy || 'round-robin',
            stickySession: config.stickySession || false,
            sessionTimeout: config.sessionTimeout || 300000, // 5 minutes
            
            // Health monitoring
            healthCheckInterval: config.healthCheckInterval || 10000,
            unhealthyThreshold: config.unhealthyThreshold || 3,
            healthyThreshold: config.healthyThreshold || 2,
            
            // Worker management
            gracefulShutdown: config.gracefulShutdown !== false,
            shutdownTimeout: config.shutdownTimeout || 30000,
            respawnDelay: config.respawnDelay || 1000,
            maxRespawnAttempts: config.maxRespawnAttempts || 5,
            
            // IPC configuration
            ipcTimeout: config.ipcTimeout || 5000,
            
            // Service discovery
            enableServiceDiscovery: config.enableServiceDiscovery || false,
            servicePort: config.servicePort || 8080,
            discoveryInterval: config.discoveryInterval || 10000,
            
            ...config
        };
        
        // Cluster state
        this.workers = new Map();
        this.workerStats = new Map();
        this.lastScalingAction = 0;
        
        // Load balancing
        this.currentWorkerIndex = 0;
        this.sessionMap = new Map();
        
        // Service registry
        this.services = new Map();
        
        // Statistics
        this.stats = {
            totalRequests: 0,
            requestsPerWorker: new Map(),
            errors: 0,
            respawns: 0,
            scalingActions: 0
        };
        
        // Initialize based on role
        if (cluster.isMaster || cluster.isPrimary) {
            this.initializeMaster();
        } else {
            this.initializeWorker();
        }
    }
    
    /**
     * Initialize master process
     */
    initializeMaster() {
        console.log('水平スケーリングマスターを初期化中...');
        
        // Fork initial workers
        this.spawnWorkers(this.config.workers);
        
        // Setup cluster event handlers
        this.setupClusterHandlers();
        
        // Start auto-scaling
        if (this.config.enableAutoScaling) {
            this.startAutoScaling();
        }
        
        // Start health monitoring
        this.startHealthMonitoring();
        
        // Start service discovery
        if (this.config.enableServiceDiscovery) {
            this.startServiceDiscovery();
        }
        
        // Setup IPC server
        this.setupIPCServer();
        
        console.log(`✓ ${this.config.workers}個のワーカーでクラスター起動完了`);
    }
    
    /**
     * Initialize worker process
     */
    initializeWorker() {
        // Setup worker-specific handlers
        this.setupWorkerHandlers();
        
        // Register with master
        this.registerWorker();
    }
    
    /**
     * Spawn worker processes
     */
    spawnWorkers(count) {
        for (let i = 0; i < count; i++) {
            this.spawnWorker();
        }
    }
    
    /**
     * Spawn a single worker
     */
    spawnWorker() {
        const worker = cluster.fork({
            WORKER_TYPE: 'scaled',
            CLUSTER_CONFIG: JSON.stringify(this.config)
        });
        
        const workerInfo = {
            id: worker.id,
            pid: worker.process.pid,
            startTime: Date.now(),
            status: 'starting',
            health: 'unknown',
            failedHealthChecks: 0,
            respawnAttempts: 0,
            stats: {
                requests: 0,
                errors: 0,
                avgResponseTime: 0,
                cpuUsage: 0,
                memoryUsage: 0
            }
        };
        
        this.workers.set(worker.id, worker);
        this.workerStats.set(worker.id, workerInfo);
        
        // Setup worker message handler
        worker.on('message', (msg) => {
            this.handleWorkerMessage(worker, msg);
        });
        
        this.emit('worker-spawned', { workerId: worker.id });
    }
    
    /**
     * Setup cluster event handlers
     */
    setupClusterHandlers() {
        cluster.on('exit', (worker, code, signal) => {
            console.log(`ワーカー ${worker.id} が終了 (${signal || code})`);
            
            this.workers.delete(worker.id);
            const workerInfo = this.workerStats.get(worker.id);
            
            // Check if should respawn
            if (code !== 0 && !worker.exitedAfterDisconnect) {
                if (workerInfo && workerInfo.respawnAttempts < this.config.maxRespawnAttempts) {
                    setTimeout(() => {
                        console.log(`ワーカー ${worker.id} を再起動中...`);
                        workerInfo.respawnAttempts++;
                        this.stats.respawns++;
                        this.spawnWorker();
                    }, this.config.respawnDelay);
                } else {
                    console.error(`ワーカー ${worker.id} の再起動上限に達しました`);
                }
            }
            
            this.workerStats.delete(worker.id);
        });
        
        cluster.on('online', (worker) => {
            const workerInfo = this.workerStats.get(worker.id);
            if (workerInfo) {
                workerInfo.status = 'online';
                workerInfo.health = 'healthy';
            }
            
            this.emit('worker-online', { workerId: worker.id });
        });
        
        cluster.on('disconnect', (worker) => {
            console.log(`ワーカー ${worker.id} が切断されました`);
            const workerInfo = this.workerStats.get(worker.id);
            if (workerInfo) {
                workerInfo.status = 'disconnected';
            }
        });
    }
    
    /**
     * Handle worker messages
     */
    handleWorkerMessage(worker, message) {
        switch (message.type) {
            case 'stats':
                this.updateWorkerStats(worker.id, message.stats);
                break;
                
            case 'health':
                this.updateWorkerHealth(worker.id, message.health);
                break;
                
            case 'request-complete':
                this.recordRequestComplete(worker.id, message);
                break;
                
            case 'error':
                this.recordWorkerError(worker.id, message.error);
                break;
                
            case 'register-service':
                this.registerService(worker.id, message.service);
                break;
                
            case 'broadcast':
                this.broadcastToWorkers(message.data, worker.id);
                break;
                
            default:
                this.emit('worker-message', { workerId: worker.id, message });
        }
    }
    
    /**
     * Update worker statistics
     */
    updateWorkerStats(workerId, stats) {
        const workerInfo = this.workerStats.get(workerId);
        if (workerInfo) {
            Object.assign(workerInfo.stats, stats);
        }
    }
    
    /**
     * Update worker health
     */
    updateWorkerHealth(workerId, health) {
        const workerInfo = this.workerStats.get(workerId);
        if (workerInfo) {
            const previousHealth = workerInfo.health;
            workerInfo.health = health.status;
            
            if (health.status === 'unhealthy') {
                workerInfo.failedHealthChecks++;
                
                if (workerInfo.failedHealthChecks >= this.config.unhealthyThreshold) {
                    this.handleUnhealthyWorker(workerId);
                }
            } else if (health.status === 'healthy' && previousHealth === 'unhealthy') {
                workerInfo.failedHealthChecks = 0;
            }
        }
    }
    
    /**
     * Start auto-scaling monitoring
     */
    startAutoScaling() {
        setInterval(() => {
            if (Date.now() - this.lastScalingAction < this.config.scalingCooldown) {
                return; // Still in cooldown
            }
            
            const metrics = this.calculateClusterMetrics();
            
            if (metrics.avgCpuUsage > this.config.scaleUpThreshold) {
                this.scaleUp();
            } else if (metrics.avgCpuUsage < this.config.scaleDownThreshold) {
                this.scaleDown();
            }
        }, this.config.scalingInterval);
    }
    
    /**
     * Calculate cluster-wide metrics
     */
    calculateClusterMetrics() {
        let totalCpu = 0;
        let totalMemory = 0;
        let totalRequests = 0;
        let activeWorkers = 0;
        
        for (const [workerId, workerInfo] of this.workerStats) {
            if (workerInfo.status === 'online' && workerInfo.health === 'healthy') {
                totalCpu += workerInfo.stats.cpuUsage || 0;
                totalMemory += workerInfo.stats.memoryUsage || 0;
                totalRequests += workerInfo.stats.requests || 0;
                activeWorkers++;
            }
        }
        
        return {
            avgCpuUsage: activeWorkers > 0 ? totalCpu / activeWorkers : 0,
            avgMemoryUsage: activeWorkers > 0 ? totalMemory / activeWorkers : 0,
            totalRequests,
            activeWorkers
        };
    }
    
    /**
     * Scale up (add workers)
     */
    scaleUp() {
        const currentWorkers = this.workers.size;
        
        if (currentWorkers >= this.config.maxWorkers) {
            console.log('最大ワーカー数に達しています');
            return;
        }
        
        const newWorkers = Math.min(
            Math.ceil(currentWorkers * 0.5), // Add 50% more
            this.config.maxWorkers - currentWorkers
        );
        
        console.log(`スケールアップ: ${newWorkers}個のワーカーを追加`);
        
        this.spawnWorkers(newWorkers);
        this.lastScalingAction = Date.now();
        this.stats.scalingActions++;
        
        this.emit('scaled-up', { 
            previousWorkers: currentWorkers,
            newWorkers: currentWorkers + newWorkers
        });
    }
    
    /**
     * Scale down (remove workers)
     */
    scaleDown() {
        const currentWorkers = this.workers.size;
        
        if (currentWorkers <= this.config.minWorkers) {
            return;
        }
        
        const removeWorkers = Math.min(
            Math.floor(currentWorkers * 0.25), // Remove 25%
            currentWorkers - this.config.minWorkers
        );
        
        console.log(`スケールダウン: ${removeWorkers}個のワーカーを削除`);
        
        // Select workers to remove (least loaded)
        const workersByLoad = Array.from(this.workerStats.entries())
            .filter(([id, info]) => info.status === 'online')
            .sort((a, b) => a[1].stats.requests - b[1].stats.requests)
            .slice(0, removeWorkers);
        
        for (const [workerId] of workersByLoad) {
            this.gracefullyShutdownWorker(workerId);
        }
        
        this.lastScalingAction = Date.now();
        this.stats.scalingActions++;
        
        this.emit('scaled-down', {
            previousWorkers: currentWorkers,
            newWorkers: currentWorkers - removeWorkers
        });
    }
    
    /**
     * Gracefully shutdown a worker
     */
    async gracefullyShutdownWorker(workerId) {
        const worker = this.workers.get(workerId);
        if (!worker) return;
        
        // Send shutdown signal
        worker.send({ type: 'shutdown' });
        
        // Set timeout for forced shutdown
        const shutdownTimeout = setTimeout(() => {
            worker.kill();
        }, this.config.shutdownTimeout);
        
        // Wait for worker to exit
        worker.once('exit', () => {
            clearTimeout(shutdownTimeout);
        });
        
        worker.disconnect();
    }
    
    /**
     * Start health monitoring
     */
    startHealthMonitoring() {
        setInterval(() => {
            for (const [workerId, worker] of this.workers) {
                worker.send({ type: 'health-check' });
            }
        }, this.config.healthCheckInterval);
    }
    
    /**
     * Handle unhealthy worker
     */
    handleUnhealthyWorker(workerId) {
        console.error(`ワーカー ${workerId} が異常です。再起動します。`);
        
        const worker = this.workers.get(workerId);
        if (worker) {
            worker.disconnect();
            
            setTimeout(() => {
                if (!worker.isDead()) {
                    worker.kill();
                }
            }, 5000);
        }
    }
    
    /**
     * Route request to worker
     */
    routeRequest(request, socket) {
        const workerId = this.selectWorker(request);
        const worker = this.workers.get(workerId);
        
        if (!worker) {
            throw new Error('No available workers');
        }
        
        // Send request to worker
        worker.send({
            type: 'request',
            request: {
                id: this.generateRequestId(),
                ...request
            }
        }, socket);
        
        this.stats.totalRequests++;
        
        const workerRequests = this.stats.requestsPerWorker.get(workerId) || 0;
        this.stats.requestsPerWorker.set(workerId, workerRequests + 1);
    }
    
    /**
     * Select worker based on load balancing strategy
     */
    selectWorker(request) {
        const availableWorkers = Array.from(this.workers.entries())
            .filter(([id, worker]) => {
                const info = this.workerStats.get(id);
                return info && info.status === 'online' && info.health === 'healthy';
            });
        
        if (availableWorkers.length === 0) {
            throw new Error('No healthy workers available');
        }
        
        let selectedWorkerId;
        
        switch (this.config.loadBalancingStrategy) {
            case 'round-robin':
                selectedWorkerId = this.selectRoundRobin(availableWorkers);
                break;
                
            case 'least-connections':
                selectedWorkerId = this.selectLeastConnections(availableWorkers);
                break;
                
            case 'ip-hash':
                selectedWorkerId = this.selectIPHash(request, availableWorkers);
                break;
                
            case 'weighted':
                selectedWorkerId = this.selectWeighted(availableWorkers);
                break;
                
            default:
                selectedWorkerId = this.selectRoundRobin(availableWorkers);
        }
        
        // Handle sticky sessions
        if (this.config.stickySession && request.sessionId) {
            const stickyWorkerId = this.sessionMap.get(request.sessionId);
            if (stickyWorkerId && this.workers.has(stickyWorkerId)) {
                selectedWorkerId = stickyWorkerId;
            } else {
                this.sessionMap.set(request.sessionId, selectedWorkerId);
                
                // Clean up old sessions
                setTimeout(() => {
                    this.sessionMap.delete(request.sessionId);
                }, this.config.sessionTimeout);
            }
        }
        
        return selectedWorkerId;
    }
    
    /**
     * Round-robin selection
     */
    selectRoundRobin(workers) {
        const worker = workers[this.currentWorkerIndex % workers.length];
        this.currentWorkerIndex++;
        return worker[0];
    }
    
    /**
     * Least connections selection
     */
    selectLeastConnections(workers) {
        let minRequests = Infinity;
        let selectedId = null;
        
        for (const [id] of workers) {
            const info = this.workerStats.get(id);
            if (info && info.stats.requests < minRequests) {
                minRequests = info.stats.requests;
                selectedId = id;
            }
        }
        
        return selectedId;
    }
    
    /**
     * IP hash selection
     */
    selectIPHash(request, workers) {
        const hash = this.hashString(request.ip || '');
        const index = hash % workers.length;
        return workers[index][0];
    }
    
    /**
     * Weighted selection based on capacity
     */
    selectWeighted(workers) {
        const weights = workers.map(([id]) => {
            const info = this.workerStats.get(id);
            const cpu = info?.stats.cpuUsage || 0;
            const memory = info?.stats.memoryUsage || 0;
            
            // Higher weight for less loaded workers
            return 100 - (cpu + memory) / 2;
        });
        
        const totalWeight = weights.reduce((sum, w) => sum + w, 0);
        let random = Math.random() * totalWeight;
        
        for (let i = 0; i < workers.length; i++) {
            random -= weights[i];
            if (random <= 0) {
                return workers[i][0];
            }
        }
        
        return workers[0][0];
    }
    
    /**
     * Setup IPC server for inter-process communication
     */
    setupIPCServer() {
        const server = net.createServer((socket) => {
            socket.on('data', (data) => {
                try {
                    const message = JSON.parse(data.toString());
                    this.handleIPCMessage(message, socket);
                } catch (error) {
                    console.error('IPC message error:', error);
                }
            });
        });
        
        const ipcPath = process.platform === 'win32' ? 
            '\\\\.\\pipe\\otedama-cluster' : 
            '/tmp/otedama-cluster.sock';
        
        server.listen(ipcPath);
    }
    
    /**
     * Handle IPC messages
     */
    handleIPCMessage(message, socket) {
        switch (message.type) {
            case 'status':
                socket.write(JSON.stringify(this.getClusterStatus()));
                break;
                
            case 'scale':
                if (message.direction === 'up') {
                    this.scaleUp();
                } else if (message.direction === 'down') {
                    this.scaleDown();
                }
                break;
                
            case 'broadcast':
                this.broadcastToWorkers(message.data);
                break;
        }
    }
    
    /**
     * Broadcast message to all workers
     */
    broadcastToWorkers(data, excludeWorkerId = null) {
        for (const [workerId, worker] of this.workers) {
            if (workerId !== excludeWorkerId) {
                worker.send({ type: 'broadcast', data });
            }
        }
    }
    
    /**
     * Setup worker handlers
     */
    setupWorkerHandlers() {
        // Handle messages from master
        process.on('message', (message) => {
            this.handleMasterMessage(message);
        });
        
        // Handle shutdown
        process.on('SIGTERM', () => {
            this.gracefulShutdown();
        });
        
        process.on('SIGINT', () => {
            this.gracefulShutdown();
        });
    }
    
    /**
     * Handle messages from master (in worker)
     */
    handleMasterMessage(message) {
        switch (message.type) {
            case 'shutdown':
                this.gracefulShutdown();
                break;
                
            case 'health-check':
                this.sendHealthStatus();
                break;
                
            case 'request':
                this.handleRequest(message.request);
                break;
                
            case 'broadcast':
                this.emit('broadcast', message.data);
                break;
        }
    }
    
    /**
     * Send health status to master
     */
    sendHealthStatus() {
        const health = {
            status: 'healthy', // Would include actual health checks
            timestamp: Date.now(),
            metrics: {
                cpuUsage: process.cpuUsage(),
                memoryUsage: process.memoryUsage()
            }
        };
        
        process.send({ type: 'health', health });
    }
    
    /**
     * Register worker with master
     */
    registerWorker() {
        process.send({
            type: 'register',
            workerId: cluster.worker.id,
            pid: process.pid
        });
    }
    
    /**
     * Graceful shutdown (worker)
     */
    async gracefulShutdown() {
        console.log('ワーカーの正常なシャットダウンを開始...');
        
        // Stop accepting new requests
        this.emit('shutdown-start');
        
        // Wait for ongoing requests to complete
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Clean up resources
        this.emit('shutdown-complete');
        
        process.exit(0);
    }
    
    /**
     * Get cluster status
     */
    getClusterStatus() {
        const metrics = this.calculateClusterMetrics();
        
        const workerStatuses = [];
        for (const [id, info] of this.workerStats) {
            workerStatuses.push({
                id,
                pid: info.pid,
                status: info.status,
                health: info.health,
                uptime: Date.now() - info.startTime,
                stats: info.stats
            });
        }
        
        return {
            workers: {
                total: this.workers.size,
                healthy: workerStatuses.filter(w => w.health === 'healthy').length,
                unhealthy: workerStatuses.filter(w => w.health === 'unhealthy').length
            },
            metrics,
            stats: this.stats,
            workerDetails: workerStatuses,
            config: {
                minWorkers: this.config.minWorkers,
                maxWorkers: this.config.maxWorkers,
                autoScaling: this.config.enableAutoScaling,
                loadBalancing: this.config.loadBalancingStrategy
            }
        };
    }
    
    /**
     * Utility functions
     */
    generateRequestId() {
        return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    
    hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return Math.abs(hash);
    }
}

module.exports = HorizontalScalingManager;