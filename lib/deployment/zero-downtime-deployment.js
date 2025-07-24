/**
 * Zero-Downtime Deployment System
 * ゼロダウンタイムデプロイメントシステム
 */

const { EventEmitter } = require('events');
const cluster = require('cluster');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');

class ZeroDowntimeDeployment extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Deployment strategy
            strategy: config.strategy || 'rolling', // rolling, blue-green, canary
            
            // Rolling update configuration
            maxUnavailable: config.maxUnavailable || 1,
            maxSurge: config.maxSurge || 1,
            updateBatchSize: config.updateBatchSize || 1,
            pauseBetweenBatches: config.pauseBetweenBatches || 5000,
            
            // Health check configuration
            healthCheckPath: config.healthCheckPath || '/health',
            healthCheckInterval: config.healthCheckInterval || 5000,
            healthCheckTimeout: config.healthCheckTimeout || 3000,
            startupGracePeriod: config.startupGracePeriod || 30000,
            
            // Rollback configuration
            enableAutoRollback: config.enableAutoRollback !== false,
            rollbackThreshold: config.rollbackThreshold || 0.5, // 50% failure rate
            rollbackWindow: config.rollbackWindow || 300000, // 5 minutes
            
            // Canary deployment
            canaryPercentage: config.canaryPercentage || 10,
            canaryDuration: config.canaryDuration || 600000, // 10 minutes
            canaryMetrics: config.canaryMetrics || ['error_rate', 'response_time'],
            
            // Blue-green deployment
            blueGreenSwitchDelay: config.blueGreenSwitchDelay || 10000,
            keepOldVersionRunning: config.keepOldVersionRunning || 300000, // 5 minutes
            
            // Version management
            versionsDirectory: config.versionsDirectory || './versions',
            currentVersionFile: config.currentVersionFile || './current-version',
            maxVersionsKept: config.maxVersionsKept || 5,
            
            // Connection draining
            drainTimeout: config.drainTimeout || 30000,
            gracefulShutdownTimeout: config.gracefulShutdownTimeout || 45000,
            
            ...config
        };
        
        // Deployment state
        this.deploymentState = {
            status: 'idle', // idle, deploying, rolling-back, completed, failed
            currentVersion: null,
            targetVersion: null,
            startTime: null,
            progress: 0,
            errors: []
        };
        
        // Worker tracking
        this.workers = new Map();
        this.workerVersions = new Map();
        
        // Metrics tracking
        this.deploymentMetrics = {
            successCount: 0,
            failureCount: 0,
            rollbackCount: 0,
            avgDeploymentTime: 0,
            lastDeployment: null
        };
        
        // Initialize
        this.initialize();
    }
    
    async initialize() {
        console.log('ゼロダウンタイムデプロイメントシステムを初期化中...');
        
        // Load current version
        await this.loadCurrentVersion();
        
        // Ensure directories exist
        await this.ensureDirectories();
        
        // Setup deployment strategies
        this.strategies = {
            'rolling': new RollingUpdateStrategy(this),
            'blue-green': new BlueGreenStrategy(this),
            'canary': new CanaryDeploymentStrategy(this)
        };
        
        console.log('✓ デプロイメントシステムの初期化完了');
    }
    
    /**
     * Deploy new version
     */
    async deploy(version, options = {}) {
        if (this.deploymentState.status !== 'idle') {
            throw new Error('Deployment already in progress');
        }
        
        console.log(`新しいバージョンをデプロイ中: ${version}`);
        
        this.deploymentState = {
            status: 'deploying',
            currentVersion: this.deploymentState.currentVersion,
            targetVersion: version,
            startTime: Date.now(),
            progress: 0,
            errors: []
        };
        
        this.emit('deployment-started', {
            version,
            strategy: this.config.strategy,
            timestamp: Date.now()
        });
        
        try {
            // Validate new version
            await this.validateVersion(version);
            
            // Get deployment strategy
            const strategy = this.strategies[this.config.strategy];
            if (!strategy) {
                throw new Error(`Unknown deployment strategy: ${this.config.strategy}`);
            }
            
            // Execute deployment
            await strategy.deploy(version, options);
            
            // Update current version
            await this.updateCurrentVersion(version);
            
            // Cleanup old versions
            await this.cleanupOldVersions();
            
            // Update metrics
            this.deploymentMetrics.successCount++;
            this.updateAverageDeploymentTime();
            this.deploymentMetrics.lastDeployment = {
                version,
                timestamp: Date.now(),
                duration: Date.now() - this.deploymentState.startTime,
                strategy: this.config.strategy
            };
            
            this.deploymentState.status = 'completed';
            this.deploymentState.progress = 100;
            
            this.emit('deployment-completed', {
                version,
                duration: Date.now() - this.deploymentState.startTime
            });
            
            console.log(`✓ バージョン ${version} のデプロイ完了`);
            
        } catch (error) {
            this.deploymentState.status = 'failed';
            this.deploymentState.errors.push(error.message);
            this.deploymentMetrics.failureCount++;
            
            console.error('デプロイメントエラー:', error);
            
            this.emit('deployment-failed', {
                version,
                error: error.message
            });
            
            // Auto rollback if enabled
            if (this.config.enableAutoRollback && this.deploymentState.currentVersion) {
                await this.rollback();
            }
            
            throw error;
        }
    }
    
    /**
     * Rollback to previous version
     */
    async rollback() {
        if (!this.deploymentState.currentVersion) {
            throw new Error('No previous version to rollback to');
        }
        
        console.log(`前のバージョンにロールバック中: ${this.deploymentState.currentVersion}`);
        
        const previousVersion = this.deploymentState.currentVersion;
        
        this.deploymentState.status = 'rolling-back';
        this.emit('rollback-started', { version: previousVersion });
        
        try {
            // Use rolling update for rollback
            const strategy = this.strategies['rolling'];
            await strategy.deploy(previousVersion, { isRollback: true });
            
            this.deploymentMetrics.rollbackCount++;
            
            this.emit('rollback-completed', { version: previousVersion });
            
            console.log(`✓ バージョン ${previousVersion} へのロールバック完了`);
            
        } catch (error) {
            console.error('ロールバックエラー:', error);
            this.emit('rollback-failed', { error: error.message });
            throw error;
        }
    }
    
    /**
     * Validate version before deployment
     */
    async validateVersion(version) {
        const versionPath = path.join(this.config.versionsDirectory, version);
        
        try {
            const stats = await fs.stat(versionPath);
            if (!stats.isDirectory()) {
                throw new Error('Version directory not found');
            }
            
            // Check required files
            const requiredFiles = ['package.json', 'index.js'];
            for (const file of requiredFiles) {
                await fs.access(path.join(versionPath, file));
            }
            
            // Validate package.json
            const packageJson = JSON.parse(
                await fs.readFile(path.join(versionPath, 'package.json'), 'utf8')
            );
            
            if (packageJson.version !== version) {
                throw new Error('Version mismatch in package.json');
            }
            
        } catch (error) {
            throw new Error(`Version validation failed: ${error.message}`);
        }
    }
    
    /**
     * Load current version
     */
    async loadCurrentVersion() {
        try {
            const version = await fs.readFile(this.config.currentVersionFile, 'utf8');
            this.deploymentState.currentVersion = version.trim();
        } catch (error) {
            console.log('現在のバージョンファイルが見つかりません');
        }
    }
    
    /**
     * Update current version
     */
    async updateCurrentVersion(version) {
        await fs.writeFile(this.config.currentVersionFile, version);
        this.deploymentState.currentVersion = version;
    }
    
    /**
     * Ensure required directories exist
     */
    async ensureDirectories() {
        await fs.mkdir(this.config.versionsDirectory, { recursive: true });
    }
    
    /**
     * Cleanup old versions
     */
    async cleanupOldVersions() {
        const versions = await fs.readdir(this.config.versionsDirectory);
        const sortedVersions = versions.sort().reverse();
        
        if (sortedVersions.length > this.config.maxVersionsKept) {
            const versionsToDelete = sortedVersions.slice(this.config.maxVersionsKept);
            
            for (const version of versionsToDelete) {
                const versionPath = path.join(this.config.versionsDirectory, version);
                await fs.rm(versionPath, { recursive: true, force: true });
                console.log(`古いバージョンを削除: ${version}`);
            }
        }
    }
    
    /**
     * Update average deployment time
     */
    updateAverageDeploymentTime() {
        const totalDeployments = this.deploymentMetrics.successCount;
        const currentDuration = Date.now() - this.deploymentState.startTime;
        
        this.deploymentMetrics.avgDeploymentTime = 
            (this.deploymentMetrics.avgDeploymentTime * (totalDeployments - 1) + currentDuration) / 
            totalDeployments;
    }
    
    /**
     * Get deployment status
     */
    getStatus() {
        return {
            state: this.deploymentState,
            metrics: this.deploymentMetrics,
            workers: Array.from(this.workers.values()).map(w => ({
                id: w.id,
                version: this.workerVersions.get(w.id),
                status: w.status
            }))
        };
    }
    
    /**
     * Perform health check on worker
     */
    async performHealthCheck(worker) {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                resolve(false);
            }, this.config.healthCheckTimeout);
            
            worker.send({ type: 'health-check' });
            
            worker.once('message', (msg) => {
                if (msg.type === 'health-check-response' && msg.status === 'healthy') {
                    clearTimeout(timeout);
                    resolve(true);
                }
            });
        });
    }
    
    /**
     * Drain connections from worker
     */
    async drainConnections(worker) {
        console.log(`ワーカー ${worker.id} の接続をドレイン中...`);
        
        worker.send({ type: 'drain-connections' });
        
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                resolve();
            }, this.config.drainTimeout);
            
            worker.once('message', (msg) => {
                if (msg.type === 'connections-drained') {
                    clearTimeout(timeout);
                    resolve();
                }
            });
        });
    }
    
    /**
     * Gracefully shutdown worker
     */
    async gracefulShutdown(worker) {
        await this.drainConnections(worker);
        
        worker.send({ type: 'shutdown' });
        
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                worker.kill();
                resolve();
            }, this.config.gracefulShutdownTimeout);
            
            worker.once('exit', () => {
                clearTimeout(timeout);
                resolve();
            });
            
            worker.disconnect();
        });
    }
}

/**
 * Rolling Update Strategy
 */
class RollingUpdateStrategy {
    constructor(deployment) {
        this.deployment = deployment;
    }
    
    async deploy(version, options = {}) {
        const workers = Array.from(this.deployment.workers.values());
        const batchSize = this.deployment.config.updateBatchSize;
        
        for (let i = 0; i < workers.length; i += batchSize) {
            const batch = workers.slice(i, i + batchSize);
            
            // Update progress
            this.deployment.deploymentState.progress = Math.floor((i / workers.length) * 100);
            
            // Deploy to batch
            await this.deployBatch(batch, version);
            
            // Pause between batches
            if (i + batchSize < workers.length) {
                await new Promise(resolve => 
                    setTimeout(resolve, this.deployment.config.pauseBetweenBatches)
                );
            }
        }
    }
    
    async deployBatch(workers, version) {
        const deployPromises = workers.map(async (worker) => {
            // Create new worker with new version
            const newWorker = cluster.fork({
                WORKER_VERSION: version,
                WORKER_REPLACE_ID: worker.id
            });
            
            // Wait for new worker to be ready
            await this.waitForWorkerReady(newWorker);
            
            // Perform health check
            const isHealthy = await this.deployment.performHealthCheck(newWorker);
            if (!isHealthy) {
                throw new Error(`Worker ${newWorker.id} health check failed`);
            }
            
            // Drain old worker
            await this.deployment.drainConnections(worker);
            
            // Shutdown old worker
            await this.deployment.gracefulShutdown(worker);
            
            // Update tracking
            this.deployment.workers.set(newWorker.id, newWorker);
            this.deployment.workers.delete(worker.id);
            this.deployment.workerVersions.set(newWorker.id, version);
            this.deployment.workerVersions.delete(worker.id);
        });
        
        await Promise.all(deployPromises);
    }
    
    async waitForWorkerReady(worker) {
        return new Promise((resolve) => {
            worker.once('online', () => {
                setTimeout(resolve, this.deployment.config.startupGracePeriod);
            });
        });
    }
}

/**
 * Blue-Green Deployment Strategy
 */
class BlueGreenStrategy {
    constructor(deployment) {
        this.deployment = deployment;
    }
    
    async deploy(version, options = {}) {
        // Start green environment with new version
        const greenWorkers = await this.startGreenEnvironment(version);
        
        // Validate green environment
        await this.validateEnvironment(greenWorkers);
        
        // Switch traffic to green
        await this.switchTraffic(greenWorkers);
        
        // Keep blue running for rollback
        setTimeout(() => {
            this.shutdownBlueEnvironment();
        }, this.deployment.config.keepOldVersionRunning);
    }
    
    async startGreenEnvironment(version) {
        const workerCount = this.deployment.workers.size;
        const greenWorkers = [];
        
        for (let i = 0; i < workerCount; i++) {
            const worker = cluster.fork({
                WORKER_VERSION: version,
                WORKER_ENV: 'green'
            });
            
            await this.deployment.waitForWorkerReady(worker);
            greenWorkers.push(worker);
        }
        
        return greenWorkers;
    }
    
    async validateEnvironment(workers) {
        const healthChecks = workers.map(w => this.deployment.performHealthCheck(w));
        const results = await Promise.all(healthChecks);
        
        if (!results.every(r => r === true)) {
            throw new Error('Green environment validation failed');
        }
    }
    
    async switchTraffic(greenWorkers) {
        // Simulate traffic switch delay
        await new Promise(resolve => 
            setTimeout(resolve, this.deployment.config.blueGreenSwitchDelay)
        );
        
        // Update worker tracking
        const oldWorkers = Array.from(this.deployment.workers.values());
        
        greenWorkers.forEach(worker => {
            this.deployment.workers.set(worker.id, worker);
            this.deployment.workerVersions.set(worker.id, this.deployment.deploymentState.targetVersion);
        });
        
        // Mark old workers for shutdown
        this.blueWorkers = oldWorkers;
    }
    
    async shutdownBlueEnvironment() {
        if (!this.blueWorkers) return;
        
        for (const worker of this.blueWorkers) {
            await this.deployment.gracefulShutdown(worker);
            this.deployment.workers.delete(worker.id);
            this.deployment.workerVersions.delete(worker.id);
        }
    }
}

/**
 * Canary Deployment Strategy
 */
class CanaryDeploymentStrategy {
    constructor(deployment) {
        this.deployment = deployment;
    }
    
    async deploy(version, options = {}) {
        const totalWorkers = this.deployment.workers.size;
        const canaryCount = Math.ceil(totalWorkers * (this.deployment.config.canaryPercentage / 100));
        
        // Deploy canary instances
        await this.deployCanaryInstances(version, canaryCount);
        
        // Monitor canary metrics
        const metricsOk = await this.monitorCanaryMetrics();
        
        if (!metricsOk) {
            throw new Error('Canary metrics validation failed');
        }
        
        // Gradually roll out to remaining instances
        await this.completeRollout(version, canaryCount);
    }
    
    async deployCanaryInstances(version, count) {
        const workers = Array.from(this.deployment.workers.values());
        const canaryWorkers = workers.slice(0, count);
        
        for (const worker of canaryWorkers) {
            const newWorker = cluster.fork({
                WORKER_VERSION: version,
                WORKER_TYPE: 'canary'
            });
            
            await this.deployment.waitForWorkerReady(newWorker);
            
            await this.deployment.drainConnections(worker);
            await this.deployment.gracefulShutdown(worker);
            
            this.deployment.workers.set(newWorker.id, newWorker);
            this.deployment.workers.delete(worker.id);
            this.deployment.workerVersions.set(newWorker.id, version);
        }
    }
    
    async monitorCanaryMetrics() {
        const startTime = Date.now();
        
        while (Date.now() - startTime < this.deployment.config.canaryDuration) {
            const metrics = await this.collectCanaryMetrics();
            
            if (!this.validateMetrics(metrics)) {
                return false;
            }
            
            await new Promise(resolve => setTimeout(resolve, 10000)); // Check every 10 seconds
        }
        
        return true;
    }
    
    async collectCanaryMetrics() {
        // Collect metrics from canary instances
        // This would integrate with monitoring system
        return {
            error_rate: Math.random() * 0.05, // Simulated
            response_time: 50 + Math.random() * 50 // Simulated
        };
    }
    
    validateMetrics(metrics) {
        // Validate against thresholds
        if (metrics.error_rate > 0.05) return false; // 5% error rate threshold
        if (metrics.response_time > 200) return false; // 200ms threshold
        
        return true;
    }
    
    async completeRollout(version, canaryCount) {
        const workers = Array.from(this.deployment.workers.values());
        const remainingWorkers = workers.filter(w => 
            this.deployment.workerVersions.get(w.id) !== version
        );
        
        // Use rolling update for remaining workers
        const rollingStrategy = new RollingUpdateStrategy(this.deployment);
        await rollingStrategy.deployBatch(remainingWorkers, version);
    }
}

module.exports = ZeroDowntimeDeployment;