const { EventEmitter } = require('events');
const os = require('os');
const fs = require('fs').promises;
const path = require('path');

/**
 * Health Monitoring System
 * Comprehensive health checks and automatic recovery
 */
class HealthMonitor extends EventEmitter {
    constructor(config) {
        super();
        this.config = {
            // Check intervals
            checkInterval: config.checkInterval || 30000, // 30 seconds
            deepCheckInterval: config.deepCheckInterval || 300000, // 5 minutes
            
            // Health thresholds
            minHealthScore: config.minHealthScore || 70,
            criticalHealthScore: config.criticalHealthScore || 50,
            
            // Component weights
            weights: {
                system: config.weights?.system || 0.2,
                database: config.weights?.database || 0.2,
                network: config.weights?.network || 0.2,
                blockchain: config.weights?.blockchain || 0.2,
                mining: config.weights?.mining || 0.2
            },
            
            // Recovery settings
            autoRecover: config.autoRecover !== false,
            maxRecoveryAttempts: config.maxRecoveryAttempts || 3,
            recoveryDelay: config.recoveryDelay || 60000, // 1 minute
            
            ...config
        };
        
        // Component health status
        this.health = {
            overall: 100,
            components: {
                system: { score: 100, status: 'healthy', lastCheck: null },
                database: { score: 100, status: 'healthy', lastCheck: null },
                network: { score: 100, status: 'healthy', lastCheck: null },
                blockchain: { score: 100, status: 'healthy', lastCheck: null },
                mining: { score: 100, status: 'healthy', lastCheck: null }
            },
            history: [],
            incidents: []
        };
        
        // Recovery tracking
        this.recoveryAttempts = new Map();
        this.dependencies = new Map();
        
        // Start monitoring
        this.startMonitoring();
    }
    
    // Start health monitoring
    startMonitoring() {
        // Regular health checks
        this.checkTimer = setInterval(() => {
            this.performHealthCheck();
        }, this.config.checkInterval);
        
        // Deep health checks
        this.deepCheckTimer = setInterval(() => {
            this.performDeepHealthCheck();
        }, this.config.deepCheckInterval);
        
        // Initial check
        this.performHealthCheck();
    }
    
    // Perform health check
    async performHealthCheck() {
        const startTime = Date.now();
        const checks = [];
        
        // Run all checks in parallel
        checks.push(this.checkSystemHealth());
        checks.push(this.checkDatabaseHealth());
        checks.push(this.checkNetworkHealth());
        checks.push(this.checkBlockchainHealth());
        checks.push(this.checkMiningHealth());
        
        await Promise.all(checks);
        
        // Calculate overall health
        this.calculateOverallHealth();
        
        // Record health history
        this.recordHealthHistory();
        
        // Check for issues
        this.detectHealthIssues();
        
        // Emit health status
        this.emit('health-check', {
            overall: this.health.overall,
            components: this.health.components,
            duration: Date.now() - startTime
        });
    }
    
    // System health check
    async checkSystemHealth() {
        try {
            const checks = {
                cpu: await this.checkCPU(),
                memory: await this.checkMemory(),
                disk: await this.checkDisk(),
                processes: await this.checkProcesses()
            };
            
            // Calculate system score
            let score = 100;
            
            if (checks.cpu.usage > 90) score -= 30;
            else if (checks.cpu.usage > 80) score -= 20;
            else if (checks.cpu.usage > 70) score -= 10;
            
            if (checks.memory.percent > 90) score -= 30;
            else if (checks.memory.percent > 80) score -= 20;
            else if (checks.memory.percent > 70) score -= 10;
            
            if (checks.disk.percent > 90) score -= 20;
            else if (checks.disk.percent > 80) score -= 10;
            
            if (!checks.processes.healthy) score -= 20;
            
            this.updateComponentHealth('system', Math.max(0, score), checks);
            
        } catch (error) {
            this.updateComponentHealth('system', 0, { error: error.message });
        }
    }
    
    // Database health check
    async checkDatabaseHealth() {
        try {
            const checks = {
                connection: false,
                queryTime: Infinity,
                replication: 'unknown',
                size: 0
            };
            
            // Check database connection
            if (this.config.database) {
                const start = Date.now();
                try {
                    await this.config.database.query('SELECT 1');
                    checks.connection = true;
                    checks.queryTime = Date.now() - start;
                } catch (error) {
                    checks.error = error.message;
                }
                
                // Check database size
                if (checks.connection) {
                    try {
                        const result = await this.config.database.query(`
                            SELECT 
                                table_schema AS 'database',
                                SUM(data_length + index_length) AS size
                            FROM information_schema.tables 
                            WHERE table_schema = DATABASE()
                            GROUP BY table_schema
                        `);
                        checks.size = result[0]?.size || 0;
                    } catch (error) {
                        // Size check failed
                    }
                }
            }
            
            // Calculate score
            let score = 100;
            if (!checks.connection) score = 0;
            else {
                if (checks.queryTime > 100) score -= 30;
                else if (checks.queryTime > 50) score -= 20;
                else if (checks.queryTime > 20) score -= 10;
            }
            
            this.updateComponentHealth('database', score, checks);
            
        } catch (error) {
            this.updateComponentHealth('database', 0, { error: error.message });
        }
    }
    
    // Network health check
    async checkNetworkHealth() {
        try {
            const checks = {
                connectivity: false,
                latency: Infinity,
                packetLoss: 0,
                bandwidth: 0
            };
            
            // Check network connectivity
            if (this.config.networkTargets) {
                const latencies = [];
                let successCount = 0;
                
                for (const target of this.config.networkTargets) {
                    const start = Date.now();
                    try {
                        // Simplified connectivity check
                        await this.pingTarget(target);
                        latencies.push(Date.now() - start);
                        successCount++;
                    } catch (error) {
                        // Target unreachable
                    }
                }
                
                if (successCount > 0) {
                    checks.connectivity = true;
                    checks.latency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
                    checks.packetLoss = ((this.config.networkTargets.length - successCount) / 
                                        this.config.networkTargets.length) * 100;
                }
            }
            
            // Calculate score
            let score = 100;
            if (!checks.connectivity) score = 20;
            else {
                if (checks.latency > 200) score -= 30;
                else if (checks.latency > 100) score -= 20;
                else if (checks.latency > 50) score -= 10;
                
                if (checks.packetLoss > 10) score -= 30;
                else if (checks.packetLoss > 5) score -= 20;
                else if (checks.packetLoss > 1) score -= 10;
            }
            
            this.updateComponentHealth('network', Math.max(0, score), checks);
            
        } catch (error) {
            this.updateComponentHealth('network', 0, { error: error.message });
        }
    }
    
    // Blockchain health check
    async checkBlockchainHealth() {
        try {
            const checks = {
                connected: false,
                syncStatus: 'unknown',
                blockHeight: 0,
                peers: 0,
                lastBlockTime: null
            };
            
            // Check blockchain connection
            if (this.config.blockchainRPC) {
                try {
                    // Get blockchain info
                    const info = await this.config.blockchainRPC.getBlockchainInfo();
                    checks.connected = true;
                    checks.blockHeight = info.blocks;
                    checks.syncStatus = info.verificationprogress >= 0.9999 ? 'synced' : 'syncing';
                    
                    // Get peer info
                    const peerInfo = await this.config.blockchainRPC.getPeerInfo();
                    checks.peers = peerInfo.length;
                    
                    // Get last block time
                    const bestBlockHash = await this.config.blockchainRPC.getBestBlockHash();
                    const block = await this.config.blockchainRPC.getBlock(bestBlockHash);
                    checks.lastBlockTime = new Date(block.time * 1000);
                    
                } catch (error) {
                    checks.error = error.message;
                }
            }
            
            // Calculate score
            let score = 100;
            if (!checks.connected) score = 0;
            else {
                if (checks.syncStatus !== 'synced') score -= 30;
                if (checks.peers < 3) score -= 30;
                else if (checks.peers < 5) score -= 20;
                else if (checks.peers < 8) score -= 10;
                
                // Check if last block is recent
                if (checks.lastBlockTime) {
                    const blockAge = Date.now() - checks.lastBlockTime.getTime();
                    if (blockAge > 3600000) score -= 20; // More than 1 hour old
                }
            }
            
            this.updateComponentHealth('blockchain', Math.max(0, score), checks);
            
        } catch (error) {
            this.updateComponentHealth('blockchain', 0, { error: error.message });
        }
    }
    
    // Mining health check
    async checkMiningHealth() {
        try {
            const checks = {
                hashrate: 0,
                efficiency: 0,
                activeMiners: 0,
                rejectedShares: 0,
                temperature: 0
            };
            
            // Check mining statistics
            if (this.config.miningPool) {
                const stats = await this.config.miningPool.getStats();
                checks.hashrate = stats.hashrate || 0;
                checks.activeMiners = stats.miners || 0;
                checks.efficiency = stats.efficiency || 0;
                checks.rejectedShares = stats.rejectedSharesPercent || 0;
                
                // Get average temperature
                const temps = stats.temperatures || [];
                if (temps.length > 0) {
                    checks.temperature = temps.reduce((a, b) => a + b, 0) / temps.length;
                }
            }
            
            // Calculate score
            let score = 100;
            
            if (checks.hashrate === 0) score -= 50;
            if (checks.activeMiners === 0) score -= 30;
            if (checks.efficiency < 90) score -= 20;
            else if (checks.efficiency < 95) score -= 10;
            
            if (checks.rejectedShares > 5) score -= 20;
            else if (checks.rejectedShares > 2) score -= 10;
            
            if (checks.temperature > 85) score -= 30;
            else if (checks.temperature > 80) score -= 20;
            else if (checks.temperature > 75) score -= 10;
            
            this.updateComponentHealth('mining', Math.max(0, score), checks);
            
        } catch (error) {
            this.updateComponentHealth('mining', 0, { error: error.message });
        }
    }
    
    // Deep health check
    async performDeepHealthCheck() {
        this.emit('deep-check-start');
        
        try {
            // Check log files for errors
            await this.checkLogs();
            
            // Verify data integrity
            await this.verifyDataIntegrity();
            
            // Check for resource leaks
            await this.checkResourceLeaks();
            
            // Validate configurations
            await this.validateConfigurations();
            
            this.emit('deep-check-complete');
            
        } catch (error) {
            this.emit('deep-check-error', error);
        }
    }
    
    // Helper methods
    async checkCPU() {
        const cpus = os.cpus();
        let totalIdle = 0;
        let totalTick = 0;
        
        for (const cpu of cpus) {
            for (const type in cpu.times) {
                totalTick += cpu.times[type];
            }
            totalIdle += cpu.times.idle;
        }
        
        const usage = 100 - ~~(100 * totalIdle / totalTick);
        
        return {
            usage,
            count: cpus.length,
            model: cpus[0].model
        };
    }
    
    async checkMemory() {
        const total = os.totalmem();
        const free = os.freemem();
        const used = total - free;
        
        return {
            total,
            free,
            used,
            percent: (used / total) * 100
        };
    }
    
    async checkDisk() {
        // Simplified disk check - would use df command or similar
        try {
            const stats = await fs.stat(this.config.dataDir || './');
            return {
                available: stats.blocks * stats.blksize,
                percent: 0 // Would calculate actual usage
            };
        } catch (error) {
            return { available: 0, percent: 100 };
        }
    }
    
    async checkProcesses() {
        // Check critical processes
        const critical = this.config.criticalProcesses || [];
        const running = [];
        
        for (const processName of critical) {
            // Would check if process is running
            running.push(processName);
        }
        
        return {
            healthy: running.length === critical.length,
            running,
            missing: critical.filter(p => !running.includes(p))
        };
    }
    
    async pingTarget(target) {
        // Simplified ping - would use actual network ping
        return new Promise((resolve, reject) => {
            setTimeout(() => {
                if (Math.random() > 0.1) resolve();
                else reject(new Error('Timeout'));
            }, Math.random() * 100);
        });
    }
    
    // Update component health
    updateComponentHealth(component, score, details) {
        const status = score >= 90 ? 'healthy' : 
                      score >= 70 ? 'degraded' : 
                      score >= 50 ? 'unhealthy' : 'critical';
        
        this.health.components[component] = {
            score,
            status,
            lastCheck: Date.now(),
            details
        };
        
        // Trigger recovery if needed
        if (this.config.autoRecover && status === 'critical') {
            this.triggerRecovery(component);
        }
    }
    
    // Calculate overall health
    calculateOverallHealth() {
        let weightedSum = 0;
        let totalWeight = 0;
        
        for (const [component, data] of Object.entries(this.health.components)) {
            const weight = this.config.weights[component] || 0;
            weightedSum += data.score * weight;
            totalWeight += weight;
        }
        
        this.health.overall = totalWeight > 0 ? weightedSum / totalWeight : 0;
    }
    
    // Record health history
    recordHealthHistory() {
        const snapshot = {
            timestamp: Date.now(),
            overall: this.health.overall,
            components: {}
        };
        
        for (const [name, data] of Object.entries(this.health.components)) {
            snapshot.components[name] = {
                score: data.score,
                status: data.status
            };
        }
        
        this.health.history.push(snapshot);
        
        // Keep only last 24 hours
        const cutoff = Date.now() - 86400000;
        this.health.history = this.health.history.filter(h => h.timestamp > cutoff);
    }
    
    // Detect health issues
    detectHealthIssues() {
        const issues = [];
        
        // Check overall health
        if (this.health.overall < this.config.criticalHealthScore) {
            issues.push({
                severity: 'critical',
                message: `Overall health critical: ${this.health.overall.toFixed(1)}%`,
                timestamp: Date.now()
            });
        } else if (this.health.overall < this.config.minHealthScore) {
            issues.push({
                severity: 'warning',
                message: `Overall health low: ${this.health.overall.toFixed(1)}%`,
                timestamp: Date.now()
            });
        }
        
        // Check components
        for (const [component, data] of Object.entries(this.health.components)) {
            if (data.status === 'critical') {
                issues.push({
                    severity: 'critical',
                    component,
                    message: `${component} health critical: ${data.score}%`,
                    timestamp: Date.now()
                });
            } else if (data.status === 'unhealthy') {
                issues.push({
                    severity: 'error',
                    component,
                    message: `${component} unhealthy: ${data.score}%`,
                    timestamp: Date.now()
                });
            }
        }
        
        // Record new incidents
        for (const issue of issues) {
            this.recordIncident(issue);
        }
        
        if (issues.length > 0) {
            this.emit('health-issues', issues);
        }
    }
    
    // Record incident
    recordIncident(issue) {
        const incident = {
            id: Date.now().toString(),
            ...issue,
            resolved: false
        };
        
        this.health.incidents.push(incident);
        
        // Keep only last 100 incidents
        if (this.health.incidents.length > 100) {
            this.health.incidents = this.health.incidents.slice(-100);
        }
    }
    
    // Trigger recovery
    async triggerRecovery(component) {
        const attempts = this.recoveryAttempts.get(component) || 0;
        
        if (attempts >= this.config.maxRecoveryAttempts) {
            this.emit('recovery-failed', { component, attempts });
            return;
        }
        
        this.recoveryAttempts.set(component, attempts + 1);
        this.emit('recovery-start', { component, attempt: attempts + 1 });
        
        try {
            await this.performRecovery(component);
            this.recoveryAttempts.delete(component);
            this.emit('recovery-success', { component });
        } catch (error) {
            this.emit('recovery-error', { component, error: error.message });
            
            // Schedule retry
            setTimeout(() => {
                this.triggerRecovery(component);
            }, this.config.recoveryDelay);
        }
    }
    
    // Perform recovery
    async performRecovery(component) {
        switch (component) {
            case 'database':
                await this.recoverDatabase();
                break;
            case 'network':
                await this.recoverNetwork();
                break;
            case 'blockchain':
                await this.recoverBlockchain();
                break;
            case 'mining':
                await this.recoverMining();
                break;
            case 'system':
                await this.recoverSystem();
                break;
            default:
                throw new Error(`Unknown component: ${component}`);
        }
    }
    
    // Recovery procedures
    async recoverDatabase() {
        // Attempt to reconnect
        if (this.config.database?.reconnect) {
            await this.config.database.reconnect();
        }
    }
    
    async recoverNetwork() {
        // Reset network connections
        this.emit('reset-network');
    }
    
    async recoverBlockchain() {
        // Restart blockchain connection
        if (this.config.blockchainRPC?.reconnect) {
            await this.config.blockchainRPC.reconnect();
        }
    }
    
    async recoverMining() {
        // Restart mining processes
        this.emit('restart-mining');
    }
    
    async recoverSystem() {
        // Clear caches and garbage collect
        if (global.gc) {
            global.gc();
        }
        this.emit('clear-caches');
    }
    
    // Get health report
    getHealthReport() {
        return {
            timestamp: Date.now(),
            overall: this.health.overall,
            components: this.health.components,
            incidents: this.health.incidents.filter(i => !i.resolved),
            history: this.getHealthTrend()
        };
    }
    
    // Get health trend
    getHealthTrend() {
        if (this.health.history.length < 2) return 'stable';
        
        const recent = this.health.history.slice(-10);
        const avg = recent.reduce((sum, h) => sum + h.overall, 0) / recent.length;
        const first = recent[0].overall;
        
        if (avg > first + 10) return 'improving';
        if (avg < first - 10) return 'degrading';
        return 'stable';
    }
    
    // Shutdown
    shutdown() {
        if (this.checkTimer) clearInterval(this.checkTimer);
        if (this.deepCheckTimer) clearInterval(this.deepCheckTimer);
        this.removeAllListeners();
    }
}

module.exports = HealthMonitor;