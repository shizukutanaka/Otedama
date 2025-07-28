const { EventEmitter } = require('events');
const os = require('os');
const cluster = require('cluster');

class AutoScalingManager extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.config = {
            minWorkers: options.minWorkers || 1,
            maxWorkers: options.maxWorkers || os.cpus().length,
            targetCPU: options.targetCPU || 0.7,
            targetMemory: options.targetMemory || 0.8,
            scaleUpThreshold: options.scaleUpThreshold || 0.8,
            scaleDownThreshold: options.scaleDownThreshold || 0.3,
            cooldownPeriod: options.cooldownPeriod || 60000, // 1 minute
            checkInterval: options.checkInterval || 10000, // 10 seconds
            responseTimeTarget: options.responseTimeTarget || 100, // ms
            ...options
        };
        
        this.workers = new Map();
        this.metrics = new Map();
        this.scalingHistory = [];
        this.lastScaleAction = 0;
        
        // Resource tracking
        this.resourceMetrics = {
            cpu: [],
            memory: [],
            responseTime: [],
            throughput: []
        };
        
        // Prediction models
        this.predictions = {
            cpu: null,
            memory: null,
            load: null
        };
        
        this.isRunning = false;
    }

    async start() {
        if (cluster.isMaster) {
            this.setupMaster();
        } else {
            this.setupWorker();
        }
        
        this.isRunning = true;
        this.emit('started');
    }

    setupMaster() {
        // Initialize with minimum workers
        for (let i = 0; i < this.config.minWorkers; i++) {
            this.spawnWorker();
        }
        
        // Setup monitoring
        this.startMonitoring();
        
        // Setup auto-scaling
        this.startAutoScaling();
        
        // Handle worker events
        cluster.on('exit', (worker, code, signal) => {
            this.handleWorkerExit(worker, code, signal);
        });
        
        cluster.on('message', (worker, message) => {
            this.handleWorkerMessage(worker, message);
        });
        
        // Setup load balancing
        this.setupLoadBalancing();
    }

    setupWorker() {
        // Worker-specific setup
        process.on('message', (message) => {
            this.handleMasterMessage(message);
        });
        
        // Send periodic metrics to master
        setInterval(() => {
            this.sendWorkerMetrics();
        }, 5000);
    }

    spawnWorker() {
        const worker = cluster.fork();
        
        const workerInfo = {
            id: worker.id,
            pid: worker.process.pid,
            startTime: Date.now(),
            status: 'starting',
            metrics: {
                cpu: 0,
                memory: 0,
                requests: 0,
                responseTime: []
            }
        };
        
        this.workers.set(worker.id, workerInfo);
        
        worker.on('online', () => {
            workerInfo.status = 'online';
            this.emit('worker:spawned', { workerId: worker.id });
        });
        
        return worker;
    }

    handleWorkerExit(worker, code, signal) {
        const workerInfo = this.workers.get(worker.id);
        
        if (workerInfo) {
            this.workers.delete(worker.id);
            
            this.emit('worker:exit', {
                workerId: worker.id,
                code,
                signal,
                uptime: Date.now() - workerInfo.startTime
            });
            
            // Replace worker if not scaling down
            if (this.workers.size < this.config.minWorkers) {
                this.spawnWorker();
            }
        }
    }

    handleWorkerMessage(worker, message) {
        if (message.type === 'metrics') {
            this.updateWorkerMetrics(worker.id, message.data);
        } else if (message.type === 'request') {
            this.handleWorkerRequest(worker.id, message.data);
        }
    }

    updateWorkerMetrics(workerId, metrics) {
        const workerInfo = this.workers.get(workerId);
        if (!workerInfo) return;
        
        // Update worker metrics
        Object.assign(workerInfo.metrics, metrics);
        
        // Update global metrics
        this.updateGlobalMetrics();
    }

    updateGlobalMetrics() {
        const now = Date.now();
        let totalCPU = 0;
        let totalMemory = 0;
        let totalRequests = 0;
        let allResponseTimes = [];
        
        for (const [_, worker] of this.workers) {
            totalCPU += worker.metrics.cpu;
            totalMemory += worker.metrics.memory;
            totalRequests += worker.metrics.requests;
            allResponseTimes.push(...(worker.metrics.responseTime || []));
        }
        
        const avgCPU = totalCPU / this.workers.size;
        const avgMemory = totalMemory / this.workers.size;
        const avgResponseTime = allResponseTimes.length > 0 ?
            allResponseTimes.reduce((a, b) => a + b, 0) / allResponseTimes.length : 0;
        
        // Store metrics
        this.resourceMetrics.cpu.push({ timestamp: now, value: avgCPU });
        this.resourceMetrics.memory.push({ timestamp: now, value: avgMemory });
        this.resourceMetrics.responseTime.push({ timestamp: now, value: avgResponseTime });
        this.resourceMetrics.throughput.push({ timestamp: now, value: totalRequests });
        
        // Keep only recent metrics (last 5 minutes)
        const cutoff = now - 300000;
        for (const metric of Object.values(this.resourceMetrics)) {
            while (metric.length > 0 && metric[0].timestamp < cutoff) {
                metric.shift();
            }
        }
        
        this.emit('metrics:updated', {
            cpu: avgCPU,
            memory: avgMemory,
            responseTime: avgResponseTime,
            throughput: totalRequests,
            workers: this.workers.size
        });
    }

    startMonitoring() {
        this.monitoringInterval = setInterval(() => {
            this.collectSystemMetrics();
            this.predictResourceUsage();
        }, this.config.checkInterval);
    }

    async collectSystemMetrics() {
        const cpus = os.cpus();
        const totalMemory = os.totalmem();
        const freeMemory = os.freemem();
        
        // Calculate CPU usage
        const cpuUsage = cpus.reduce((acc, cpu) => {
            const total = Object.values(cpu.times).reduce((a, b) => a + b);
            const idle = cpu.times.idle;
            return acc + (1 - idle / total);
        }, 0) / cpus.length;
        
        // Calculate memory usage
        const memoryUsage = 1 - (freeMemory / totalMemory);
        
        // Update system metrics
        this.systemMetrics = {
            cpuUsage,
            memoryUsage,
            loadAverage: os.loadavg(),
            uptime: os.uptime()
        };
        
        return this.systemMetrics;
    }

    startAutoScaling() {
        this.scalingInterval = setInterval(() => {
            if (this.shouldScale()) {
                this.performScaling();
            }
        }, this.config.checkInterval);
    }

    shouldScale() {
        const now = Date.now();
        
        // Check cooldown period
        if (now - this.lastScaleAction < this.config.cooldownPeriod) {
            return false;
        }
        
        // Get current metrics
        const metrics = this.getCurrentMetrics();
        
        // Check if scaling is needed
        if (metrics.cpu > this.config.scaleUpThreshold ||
            metrics.memory > this.config.scaleUpThreshold ||
            metrics.responseTime > this.config.responseTimeTarget * 1.5) {
            return true;
        }
        
        if (metrics.cpu < this.config.scaleDownThreshold &&
            metrics.memory < this.config.scaleDownThreshold &&
            metrics.responseTime < this.config.responseTimeTarget * 0.5) {
            return true;
        }
        
        return false;
    }

    getCurrentMetrics() {
        const recent = (metric) => {
            if (metric.length === 0) return 0;
            const last5 = metric.slice(-5);
            return last5.reduce((a, b) => a + b.value, 0) / last5.length;
        };
        
        return {
            cpu: recent(this.resourceMetrics.cpu),
            memory: recent(this.resourceMetrics.memory),
            responseTime: recent(this.resourceMetrics.responseTime),
            throughput: recent(this.resourceMetrics.throughput)
        };
    }

    async performScaling() {
        const metrics = this.getCurrentMetrics();
        const currentWorkers = this.workers.size;
        let targetWorkers = currentWorkers;
        
        // Determine scaling direction
        if (metrics.cpu > this.config.scaleUpThreshold ||
            metrics.memory > this.config.scaleUpThreshold) {
            // Scale up
            targetWorkers = Math.min(
                currentWorkers + this.calculateScaleUpAmount(metrics),
                this.config.maxWorkers
            );
        } else if (metrics.cpu < this.config.scaleDownThreshold &&
                   metrics.memory < this.config.scaleDownThreshold) {
            // Scale down
            targetWorkers = Math.max(
                currentWorkers - this.calculateScaleDownAmount(metrics),
                this.config.minWorkers
            );
        }
        
        // Perform scaling
        if (targetWorkers !== currentWorkers) {
            await this.scaleToWorkers(targetWorkers);
        }
    }

    calculateScaleUpAmount(metrics) {
        // Calculate how many workers to add
        const cpuBased = Math.ceil((metrics.cpu - this.config.targetCPU) * this.workers.size);
        const memoryBased = Math.ceil((metrics.memory - this.config.targetMemory) * this.workers.size);
        const responseBased = metrics.responseTime > this.config.responseTimeTarget * 2 ? 2 : 1;
        
        return Math.max(1, Math.min(cpuBased, memoryBased, responseBased));
    }

    calculateScaleDownAmount(metrics) {
        // Conservative scale down
        if (metrics.cpu < this.config.scaleDownThreshold * 0.5 &&
            metrics.memory < this.config.scaleDownThreshold * 0.5) {
            return Math.floor(this.workers.size * 0.25); // Remove 25% of workers
        }
        
        return 1; // Remove one worker at a time
    }

    async scaleToWorkers(targetCount) {
        const currentCount = this.workers.size;
        
        this.emit('scaling:start', {
            from: currentCount,
            to: targetCount,
            reason: this.getScalingReason()
        });
        
        if (targetCount > currentCount) {
            // Scale up
            for (let i = 0; i < targetCount - currentCount; i++) {
                this.spawnWorker();
            }
        } else {
            // Scale down
            const workersToRemove = currentCount - targetCount;
            const workersList = Array.from(this.workers.values())
                .sort((a, b) => a.metrics.requests - b.metrics.requests)
                .slice(0, workersToRemove);
            
            for (const worker of workersList) {
                await this.gracefulShutdownWorker(worker.id);
            }
        }
        
        this.lastScaleAction = Date.now();
        
        this.scalingHistory.push({
            timestamp: this.lastScaleAction,
            from: currentCount,
            to: targetCount,
            metrics: this.getCurrentMetrics()
        });
        
        this.emit('scaling:complete', {
            from: currentCount,
            to: targetCount,
            duration: Date.now() - this.lastScaleAction
        });
    }

    async gracefulShutdownWorker(workerId) {
        const worker = cluster.workers[workerId];
        if (!worker) return;
        
        // Send shutdown signal
        worker.send({ type: 'shutdown' });
        
        // Wait for graceful shutdown
        await new Promise((resolve) => {
            const timeout = setTimeout(() => {
                worker.kill();
                resolve();
            }, 30000); // 30 seconds timeout
            
            worker.on('exit', () => {
                clearTimeout(timeout);
                resolve();
            });
        });
    }

    getScalingReason() {
        const metrics = this.getCurrentMetrics();
        const reasons = [];
        
        if (metrics.cpu > this.config.scaleUpThreshold) {
            reasons.push(`High CPU: ${(metrics.cpu * 100).toFixed(1)}%`);
        }
        if (metrics.memory > this.config.scaleUpThreshold) {
            reasons.push(`High Memory: ${(metrics.memory * 100).toFixed(1)}%`);
        }
        if (metrics.responseTime > this.config.responseTimeTarget) {
            reasons.push(`Slow Response: ${metrics.responseTime.toFixed(0)}ms`);
        }
        
        if (reasons.length === 0) {
            if (metrics.cpu < this.config.scaleDownThreshold) {
                reasons.push(`Low CPU: ${(metrics.cpu * 100).toFixed(1)}%`);
            }
            if (metrics.memory < this.config.scaleDownThreshold) {
                reasons.push(`Low Memory: ${(metrics.memory * 100).toFixed(1)}%`);
            }
        }
        
        return reasons.join(', ');
    }

    predictResourceUsage() {
        // Simple linear prediction
        const predictNext = (metric, minutes = 5) => {
            if (metric.length < 2) return null;
            
            const recent = metric.slice(-10);
            const firstPoint = recent[0];
            const lastPoint = recent[recent.length - 1];
            
            const slope = (lastPoint.value - firstPoint.value) / 
                         (lastPoint.timestamp - firstPoint.timestamp);
            
            const futureTime = Date.now() + (minutes * 60 * 1000);
            const prediction = lastPoint.value + slope * (futureTime - lastPoint.timestamp);
            
            return Math.max(0, Math.min(1, prediction));
        };
        
        this.predictions = {
            cpu: predictNext(this.resourceMetrics.cpu),
            memory: predictNext(this.resourceMetrics.memory),
            load: this.predictLoadPattern()
        };
        
        // Proactive scaling based on predictions
        if (this.predictions.cpu > this.config.scaleUpThreshold ||
            this.predictions.memory > this.config.scaleUpThreshold) {
            this.emit('scaling:predicted', this.predictions);
        }
    }

    predictLoadPattern() {
        // Detect patterns in throughput
        const throughput = this.resourceMetrics.throughput;
        if (throughput.length < 20) return null;
        
        // Simple pattern detection
        const hourOfDay = new Date().getHours();
        const dayOfWeek = new Date().getDay();
        
        // Placeholder for pattern-based prediction
        return {
            hourOfDay,
            dayOfWeek,
            expectedLoad: 'normal'
        };
    }

    setupLoadBalancing() {
        // Simple round-robin load balancing
        let currentWorker = 0;
        
        this.getNextWorker = () => {
            const workers = Array.from(this.workers.keys());
            if (workers.length === 0) return null;
            
            const workerId = workers[currentWorker % workers.length];
            currentWorker++;
            
            return cluster.workers[workerId];
        };
    }

    distributeWork(task) {
        const worker = this.selectWorkerForTask(task);
        
        if (worker) {
            worker.send({
                type: 'task',
                data: task
            });
            
            return true;
        }
        
        return false;
    }

    selectWorkerForTask(task) {
        // Select worker based on current load
        let selectedWorker = null;
        let minLoad = Infinity;
        
        for (const [workerId, workerInfo] of this.workers) {
            if (workerInfo.status !== 'online') continue;
            
            const load = workerInfo.metrics.cpu + workerInfo.metrics.memory;
            if (load < minLoad) {
                minLoad = load;
                selectedWorker = cluster.workers[workerId];
            }
        }
        
        return selectedWorker;
    }

    handleMasterMessage(message) {
        if (message.type === 'shutdown') {
            this.gracefulShutdown();
        } else if (message.type === 'task') {
            this.processTask(message.data);
        }
    }

    sendWorkerMetrics() {
        if (!cluster.isWorker) return;
        
        const usage = process.cpuUsage();
        const memory = process.memoryUsage();
        
        process.send({
            type: 'metrics',
            data: {
                cpu: (usage.user + usage.system) / 1000000, // Convert to seconds
                memory: memory.heapUsed / memory.heapTotal,
                requests: this.requestCount || 0,
                responseTime: this.responseTimeBuffer || []
            }
        });
        
        // Reset buffers
        this.requestCount = 0;
        this.responseTimeBuffer = [];
    }

    gracefulShutdown() {
        // Worker graceful shutdown
        if (this.server) {
            this.server.close(() => {
                process.exit(0);
            });
        } else {
            process.exit(0);
        }
    }

    processTask(task) {
        // Process task in worker
        const startTime = Date.now();
        
        // Task processing logic here
        
        const responseTime = Date.now() - startTime;
        this.responseTimeBuffer = this.responseTimeBuffer || [];
        this.responseTimeBuffer.push(responseTime);
        this.requestCount = (this.requestCount || 0) + 1;
    }

    // Resource limits management
    setResourceLimits(limits) {
        this.config.maxWorkers = limits.maxWorkers || this.config.maxWorkers;
        this.config.targetCPU = limits.targetCPU || this.config.targetCPU;
        this.config.targetMemory = limits.targetMemory || this.config.targetMemory;
        
        this.emit('limits:updated', limits);
    }

    // Health checks
    performHealthCheck() {
        const unhealthyWorkers = [];
        
        for (const [workerId, workerInfo] of this.workers) {
            if (workerInfo.status !== 'online') {
                unhealthyWorkers.push(workerId);
                continue;
            }
            
            // Check if worker is responsive
            const worker = cluster.workers[workerId];
            worker.send({ type: 'ping' });
            
            setTimeout(() => {
                if (!workerInfo.lastPong || Date.now() - workerInfo.lastPong > 10000) {
                    unhealthyWorkers.push(workerId);
                }
            }, 5000);
        }
        
        // Replace unhealthy workers
        for (const workerId of unhealthyWorkers) {
            this.replaceWorker(workerId);
        }
    }

    async replaceWorker(workerId) {
        await this.gracefulShutdownWorker(workerId);
        this.spawnWorker();
    }

    getStatus() {
        return {
            workers: {
                current: this.workers.size,
                min: this.config.minWorkers,
                max: this.config.maxWorkers,
                details: Array.from(this.workers.values()).map(w => ({
                    id: w.id,
                    status: w.status,
                    uptime: Date.now() - w.startTime,
                    metrics: w.metrics
                }))
            },
            metrics: this.getCurrentMetrics(),
            predictions: this.predictions,
            scalingHistory: this.scalingHistory.slice(-10),
            systemMetrics: this.systemMetrics
        };
    }

    async stop() {
        this.isRunning = false;
        
        if (this.monitoringInterval) clearInterval(this.monitoringInterval);
        if (this.scalingInterval) clearInterval(this.scalingInterval);
        
        // Shutdown all workers
        for (const workerId of this.workers.keys()) {
            await this.gracefulShutdownWorker(workerId);
        }
        
        this.emit('stopped');
    }
}

module.exports = AutoScalingManager;