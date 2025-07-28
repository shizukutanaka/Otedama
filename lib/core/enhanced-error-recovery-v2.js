const { EventEmitter } = require('events');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

class EnhancedErrorRecoveryV2 extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.config = {
            maxRetries: options.maxRetries || 3,
            retryDelay: options.retryDelay || 1000,
            backoffMultiplier: options.backoffMultiplier || 2,
            maxBackoff: options.maxBackoff || 60000,
            errorThreshold: options.errorThreshold || 10,
            errorWindow: options.errorWindow || 300000, // 5 minutes
            autoRestart: options.autoRestart !== false,
            preserveState: options.preserveState !== false,
            diagnosticMode: options.diagnosticMode !== false,
            ...options
        };
        
        this.errorHistory = [];
        this.recoveryStrategies = new Map();
        this.circuitBreakers = new Map();
        this.stateSnapshots = new Map();
        this.diagnosticData = new Map();
        
        // Recovery metrics
        this.metrics = {
            totalErrors: 0,
            recoveredErrors: 0,
            failedRecoveries: 0,
            avgRecoveryTime: 0,
            systemRestarts: 0,
            currentHealth: 100
        };
        
        this.initializeRecoveryStrategies();
        this.setupSystemMonitoring();
    }

    initializeRecoveryStrategies() {
        // Network errors
        this.registerStrategy('ECONNREFUSED', this.handleConnectionRefused.bind(this));
        this.registerStrategy('ETIMEDOUT', this.handleTimeout.bind(this));
        this.registerStrategy('ENOTFOUND', this.handleHostNotFound.bind(this));
        this.registerStrategy('ECONNRESET', this.handleConnectionReset.bind(this));
        
        // Resource errors
        this.registerStrategy('ENOMEM', this.handleOutOfMemory.bind(this));
        this.registerStrategy('EMFILE', this.handleTooManyFiles.bind(this));
        this.registerStrategy('ENOSPC', this.handleDiskFull.bind(this));
        
        // Application errors
        this.registerStrategy('ValidationError', this.handleValidationError.bind(this));
        this.registerStrategy('DatabaseError', this.handleDatabaseError.bind(this));
        this.registerStrategy('CryptoError', this.handleCryptoError.bind(this));
        
        // Mining specific errors
        this.registerStrategy('ShareRejected', this.handleShareRejected.bind(this));
        this.registerStrategy('PoolDisconnected', this.handlePoolDisconnected.bind(this));
        this.registerStrategy('GPUError', this.handleGPUError.bind(this));
        this.registerStrategy('HashrateDrop', this.handleHashrateDrop.bind(this));
        
        // Critical errors
        this.registerStrategy('UnhandledRejection', this.handleUnhandledRejection.bind(this));
        this.registerStrategy('UncaughtException', this.handleUncaughtException.bind(this));
    }

    registerStrategy(errorType, handler) {
        this.recoveryStrategies.set(errorType, handler);
    }

    async handleError(error, context = {}) {
        const errorInfo = {
            type: error.code || error.name || 'UnknownError',
            message: error.message,
            stack: error.stack,
            timestamp: Date.now(),
            context,
            pid: process.pid,
            memory: process.memoryUsage(),
            cpu: process.cpuUsage()
        };
        
        // Record error
        this.recordError(errorInfo);
        
        // Run diagnostics
        if (this.config.diagnosticMode) {
            await this.runDiagnostics(errorInfo);
        }
        
        // Check circuit breaker
        if (this.isCircuitOpen(errorInfo.type)) {
            this.emit('circuit:open', { type: errorInfo.type });
            return { recovered: false, reason: 'circuit-breaker-open' };
        }
        
        // Attempt recovery
        const result = await this.attemptRecovery(errorInfo);
        
        // Update metrics
        this.updateMetrics(result);
        
        return result;
    }

    async attemptRecovery(errorInfo) {
        const startTime = Date.now();
        let attempt = 0;
        let lastError = null;
        
        while (attempt < this.config.maxRetries) {
            try {
                // Save state before recovery
                if (this.config.preserveState) {
                    await this.saveStateSnapshot(errorInfo);
                }
                
                // Get recovery strategy
                const strategy = this.recoveryStrategies.get(errorInfo.type) || 
                               this.defaultRecoveryStrategy.bind(this);
                
                // Execute recovery
                const result = await strategy(errorInfo, attempt);
                
                if (result.success) {
                    const recoveryTime = Date.now() - startTime;
                    
                    this.emit('recovery:success', {
                        error: errorInfo,
                        attempt: attempt + 1,
                        time: recoveryTime
                    });
                    
                    return {
                        recovered: true,
                        attempt: attempt + 1,
                        time: recoveryTime,
                        action: result.action
                    };
                }
                
                lastError = result.error;
                
            } catch (recoveryError) {
                lastError = recoveryError;
                this.emit('recovery:error', {
                    original: errorInfo,
                    recovery: recoveryError
                });
            }
            
            // Calculate backoff delay
            const delay = Math.min(
                this.config.retryDelay * Math.pow(this.config.backoffMultiplier, attempt),
                this.config.maxBackoff
            );
            
            await this.sleep(delay);
            attempt++;
        }
        
        // Recovery failed
        this.handleRecoveryFailure(errorInfo, lastError);
        
        return {
            recovered: false,
            attempts: attempt,
            lastError: lastError?.message,
            time: Date.now() - startTime
        };
    }

    async handleConnectionRefused(errorInfo, attempt) {
        this.emit('recovery:attempt', { type: 'connection-refused', attempt });
        
        // Check if service is running
        const serviceRunning = await this.checkServiceStatus(errorInfo.context.service);
        
        if (!serviceRunning) {
            // Attempt to restart service
            const restarted = await this.restartService(errorInfo.context.service);
            if (restarted) {
                return { success: true, action: 'service-restarted' };
            }
        }
        
        // Try alternative endpoints
        if (errorInfo.context.alternativeEndpoints) {
            const endpoint = errorInfo.context.alternativeEndpoints[attempt];
            if (endpoint) {
                errorInfo.context.currentEndpoint = endpoint;
                return { success: true, action: 'switched-endpoint' };
            }
        }
        
        return { success: false, error: new Error('All connection attempts failed') };
    }

    async handleTimeout(errorInfo, attempt) {
        this.emit('recovery:attempt', { type: 'timeout', attempt });
        
        // Increase timeout progressively
        const newTimeout = errorInfo.context.timeout * (attempt + 2);
        errorInfo.context.timeout = newTimeout;
        
        // Check network connectivity
        const networkOk = await this.checkNetworkConnectivity();
        if (!networkOk) {
            await this.resetNetworkStack();
        }
        
        return { success: true, action: 'timeout-increased' };
    }

    async handleHostNotFound(errorInfo, attempt) {
        this.emit('recovery:attempt', { type: 'host-not-found', attempt });
        
        // Check DNS resolution
        const dnsOk = await this.checkDNS();
        if (!dnsOk) {
            await this.flushDNSCache();
            
            // Try alternative DNS servers
            if (attempt > 0) {
                await this.switchDNSServer(attempt);
            }
        }
        
        return { success: attempt < 2, action: 'dns-retry' };
    }

    async handleConnectionReset(errorInfo, attempt) {
        this.emit('recovery:attempt', { type: 'connection-reset', attempt });
        
        // Add connection pooling delay
        await this.sleep(1000 * (attempt + 1));
        
        // Reset connection pool
        if (errorInfo.context.connectionPool) {
            await errorInfo.context.connectionPool.reset();
        }
        
        return { success: true, action: 'connection-pool-reset' };
    }

    async handleOutOfMemory(errorInfo, attempt) {
        this.emit('recovery:attempt', { type: 'out-of-memory', attempt });
        
        // Force garbage collection if available
        if (global.gc) {
            global.gc();
            await this.sleep(1000);
        }
        
        // Clear caches
        await this.clearAllCaches();
        
        // Reduce memory usage
        if (attempt > 0) {
            await this.reduceMemoryUsage(attempt);
        }
        
        const memoryAfter = process.memoryUsage();
        const freed = errorInfo.memory.heapUsed - memoryAfter.heapUsed;
        
        return { 
            success: freed > 50 * 1024 * 1024, // 50MB freed
            action: 'memory-cleanup'
        };
    }

    async handleTooManyFiles(errorInfo, attempt) {
        this.emit('recovery:attempt', { type: 'too-many-files', attempt });
        
        // Close unused file descriptors
        await this.closeUnusedFileDescriptors();
        
        // Increase ulimit if possible
        if (attempt > 0 && process.platform !== 'win32') {
            await this.increaseFileLimit();
        }
        
        return { success: true, action: 'file-descriptors-cleaned' };
    }

    async handleDiskFull(errorInfo, attempt) {
        this.emit('recovery:attempt', { type: 'disk-full', attempt });
        
        // Clean temporary files
        await this.cleanTemporaryFiles();
        
        // Archive old logs
        await this.archiveOldLogs();
        
        // Check available space
        const freeSpace = await this.getFreeDiskSpace();
        
        return {
            success: freeSpace > 100 * 1024 * 1024, // 100MB free
            action: 'disk-cleanup'
        };
    }

    async handleValidationError(errorInfo, attempt) {
        this.emit('recovery:attempt', { type: 'validation-error', attempt });
        
        // Attempt to fix common validation issues
        if (errorInfo.context.data) {
            const fixed = await this.attemptDataRepair(errorInfo.context.data);
            if (fixed) {
                errorInfo.context.data = fixed;
                return { success: true, action: 'data-repaired' };
            }
        }
        
        return { success: false, error: new Error('Validation cannot be auto-fixed') };
    }

    async handleDatabaseError(errorInfo, attempt) {
        this.emit('recovery:attempt', { type: 'database-error', attempt });
        
        // Check database connection
        if (errorInfo.context.database) {
            const connected = await this.checkDatabaseConnection(errorInfo.context.database);
            
            if (!connected) {
                // Attempt reconnection
                const reconnected = await this.reconnectDatabase(errorInfo.context.database);
                if (reconnected) {
                    return { success: true, action: 'database-reconnected' };
                }
            }
            
            // Try repair if corruption suspected
            if (errorInfo.message.includes('corrupt')) {
                const repaired = await this.repairDatabase(errorInfo.context.database);
                if (repaired) {
                    return { success: true, action: 'database-repaired' };
                }
            }
        }
        
        return { success: false, error: new Error('Database recovery failed') };
    }

    async handleCryptoError(errorInfo, attempt) {
        this.emit('recovery:attempt', { type: 'crypto-error', attempt });
        
        // Regenerate crypto materials if needed
        if (errorInfo.context.regenerable) {
            await this.regenerateCryptoMaterials(errorInfo.context);
            return { success: true, action: 'crypto-regenerated' };
        }
        
        return { success: false, error: new Error('Crypto error not recoverable') };
    }

    async handleShareRejected(errorInfo, attempt) {
        this.emit('recovery:attempt', { type: 'share-rejected', attempt });
        
        // Adjust mining parameters
        if (errorInfo.context.miner) {
            await this.adjustMiningDifficulty(errorInfo.context.miner);
            
            // Check for stale shares
            if (errorInfo.message.includes('stale')) {
                await this.optimizeNetworkLatency(errorInfo.context.miner);
            }
            
            return { success: true, action: 'mining-adjusted' };
        }
        
        return { success: false };
    }

    async handlePoolDisconnected(errorInfo, attempt) {
        this.emit('recovery:attempt', { type: 'pool-disconnected', attempt });
        
        // Switch to backup pool
        if (errorInfo.context.backupPools && attempt < errorInfo.context.backupPools.length) {
            const backupPool = errorInfo.context.backupPools[attempt];
            errorInfo.context.currentPool = backupPool;
            return { success: true, action: 'switched-to-backup-pool' };
        }
        
        // Reconnect to primary after delay
        if (attempt === this.config.maxRetries - 1) {
            await this.sleep(30000); // 30 seconds
            return { success: true, action: 'reconnect-primary' };
        }
        
        return { success: true, action: 'pool-retry' };
    }

    async handleGPUError(errorInfo, attempt) {
        this.emit('recovery:attempt', { type: 'gpu-error', attempt });
        
        const gpuId = errorInfo.context.gpuId;
        
        // Reset GPU
        const reset = await this.resetGPU(gpuId);
        if (reset) {
            return { success: true, action: 'gpu-reset' };
        }
        
        // Reduce GPU load
        if (attempt > 0) {
            await this.reduceGPULoad(gpuId, attempt * 10);
            return { success: true, action: 'gpu-load-reduced' };
        }
        
        // Disable problematic GPU
        if (attempt === this.config.maxRetries - 1) {
            await this.disableGPU(gpuId);
            return { success: true, action: 'gpu-disabled' };
        }
        
        return { success: false };
    }

    async handleHashrateDrop(errorInfo, attempt) {
        this.emit('recovery:attempt', { type: 'hashrate-drop', attempt });
        
        // Check temperature throttling
        const temps = await this.checkGPUTemperatures();
        if (temps.some(t => t > 85)) {
            await this.improveGPUCooling();
            return { success: true, action: 'cooling-improved' };
        }
        
        // Check power limits
        const powerOk = await this.checkPowerDelivery();
        if (!powerOk) {
            await this.optimizePowerSettings();
            return { success: true, action: 'power-optimized' };
        }
        
        // Restart mining software
        if (attempt > 1) {
            await this.restartMiningEngine();
            return { success: true, action: 'mining-restarted' };
        }
        
        return { success: true, action: 'monitoring' };
    }

    async handleUnhandledRejection(errorInfo, attempt) {
        this.emit('recovery:attempt', { type: 'unhandled-rejection', attempt });
        
        // Log for analysis
        await this.logCriticalError(errorInfo);
        
        // Attempt graceful restart
        if (this.config.autoRestart && attempt > 0) {
            await this.gracefulRestart();
            return { success: true, action: 'process-restarted' };
        }
        
        return { success: false };
    }

    async handleUncaughtException(errorInfo, attempt) {
        this.emit('recovery:attempt', { type: 'uncaught-exception', attempt });
        
        // Save crash dump
        await this.saveCrashDump(errorInfo);
        
        // Attempt recovery based on error type
        if (errorInfo.message.includes('SIGSEGV')) {
            // Memory corruption - restart required
            await this.emergencyRestart();
            return { success: true, action: 'emergency-restart' };
        }
        
        return { success: false };
    }

    async defaultRecoveryStrategy(errorInfo, attempt) {
        this.emit('recovery:attempt', { type: 'default', attempt });
        
        // Generic recovery attempts
        if (attempt === 0) {
            // Simple retry
            return { success: true, action: 'retry' };
        } else if (attempt === 1) {
            // Reset relevant components
            await this.resetComponents(errorInfo.context);
            return { success: true, action: 'components-reset' };
        } else {
            // Last resort - restart service
            if (this.config.autoRestart) {
                await this.restartAffectedService(errorInfo);
                return { success: true, action: 'service-restarted' };
            }
        }
        
        return { success: false };
    }

    async runDiagnostics(errorInfo) {
        const diagnostics = {
            timestamp: Date.now(),
            error: errorInfo,
            system: {
                platform: os.platform(),
                arch: os.arch(),
                cpus: os.cpus().length,
                memory: {
                    total: os.totalmem(),
                    free: os.freemem(),
                    usage: process.memoryUsage()
                },
                uptime: os.uptime(),
                loadavg: os.loadavg()
            },
            process: {
                pid: process.pid,
                uptime: process.uptime(),
                versions: process.versions,
                env: this.sanitizeEnv(process.env)
            }
        };
        
        // Run specific diagnostics based on error type
        if (errorInfo.type.includes('Network') || errorInfo.type.includes('CONN')) {
            diagnostics.network = await this.networkDiagnostics();
        }
        
        if (errorInfo.type.includes('Memory') || errorInfo.type.includes('NOMEM')) {
            diagnostics.memory = await this.memoryDiagnostics();
        }
        
        this.diagnosticData.set(errorInfo.timestamp, diagnostics);
        this.emit('diagnostics:complete', diagnostics);
        
        return diagnostics;
    }

    recordError(errorInfo) {
        this.errorHistory.push(errorInfo);
        this.metrics.totalErrors++;
        
        // Maintain window
        const cutoff = Date.now() - this.config.errorWindow;
        this.errorHistory = this.errorHistory.filter(e => e.timestamp > cutoff);
        
        // Check error threshold
        const recentErrors = this.errorHistory.filter(
            e => e.type === errorInfo.type && e.timestamp > cutoff
        );
        
        if (recentErrors.length >= this.config.errorThreshold) {
            this.openCircuitBreaker(errorInfo.type);
        }
        
        // Update health score
        this.updateHealthScore();
    }

    openCircuitBreaker(errorType) {
        this.circuitBreakers.set(errorType, {
            open: true,
            openedAt: Date.now(),
            halfOpenAfter: Date.now() + 60000 // 1 minute
        });
        
        this.emit('circuit:opened', { type: errorType });
    }

    isCircuitOpen(errorType) {
        const breaker = this.circuitBreakers.get(errorType);
        if (!breaker || !breaker.open) return false;
        
        // Check if should transition to half-open
        if (Date.now() > breaker.halfOpenAfter) {
            breaker.open = false;
            breaker.halfOpen = true;
            return false;
        }
        
        return true;
    }

    updateHealthScore() {
        const recentErrors = this.errorHistory.filter(
            e => e.timestamp > Date.now() - 300000 // 5 minutes
        ).length;
        
        const errorRate = recentErrors / 5; // errors per minute
        
        let health = 100;
        health -= errorRate * 10;
        health -= this.circuitBreakers.size * 5;
        
        const recoveryRate = this.metrics.recoveredErrors / (this.metrics.totalErrors || 1);
        health *= recoveryRate;
        
        this.metrics.currentHealth = Math.max(0, Math.min(100, health));
    }

    async saveStateSnapshot(errorInfo) {
        const snapshot = {
            timestamp: Date.now(),
            error: {
                type: errorInfo.type,
                message: errorInfo.message
            },
            state: errorInfo.context.state || {},
            memory: process.memoryUsage(),
            activeRequests: errorInfo.context.activeRequests || []
        };
        
        this.stateSnapshots.set(errorInfo.timestamp, snapshot);
        
        // Persist to disk for crash recovery
        const snapshotPath = path.join(
            os.tmpdir(),
            `otedama-snapshot-${errorInfo.timestamp}.json`
        );
        
        try {
            await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2));
        } catch (error) {
            // Snapshot save failed - non-critical
        }
    }

    async handleRecoveryFailure(errorInfo, lastError) {
        this.metrics.failedRecoveries++;
        
        this.emit('recovery:failed', {
            original: errorInfo,
            final: lastError,
            attempts: this.config.maxRetries
        });
        
        // Save failure report
        await this.saveFailureReport(errorInfo, lastError);
        
        // Check if critical failure
        if (this.isCriticalError(errorInfo)) {
            await this.handleCriticalFailure(errorInfo);
        }
    }

    isCriticalError(errorInfo) {
        const criticalTypes = [
            'UncaughtException',
            'UnhandledRejection',
            'ENOMEM',
            'SIGSEGV',
            'SIGABRT'
        ];
        
        return criticalTypes.some(type => 
            errorInfo.type.includes(type) || 
            errorInfo.message.includes(type)
        );
    }

    async handleCriticalFailure(errorInfo) {
        // Notify administrators
        this.emit('critical:failure', errorInfo);
        
        // Save core dump if available
        if (process.platform !== 'win32') {
            await this.saveCoreDump();
        }
        
        // Attempt emergency restart
        if (this.config.autoRestart) {
            setTimeout(() => {
                this.emergencyRestart();
            }, 5000);
        }
    }

    updateMetrics(result) {
        if (result.recovered) {
            this.metrics.recoveredErrors++;
            
            // Update average recovery time
            const totalTime = this.metrics.avgRecoveryTime * (this.metrics.recoveredErrors - 1);
            this.metrics.avgRecoveryTime = (totalTime + result.time) / this.metrics.recoveredErrors;
        } else {
            this.metrics.failedRecoveries++;
        }
        
        this.updateHealthScore();
        this.emit('metrics:updated', { ...this.metrics });
    }

    // Utility methods
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    sanitizeEnv(env) {
        const sanitized = {};
        const sensitive = ['PASSWORD', 'KEY', 'SECRET', 'TOKEN'];
        
        for (const [key, value] of Object.entries(env)) {
            if (sensitive.some(s => key.includes(s))) {
                sanitized[key] = '***';
            } else {
                sanitized[key] = value;
            }
        }
        
        return sanitized;
    }

    async checkServiceStatus(service) {
        // Implementation depends on service type
        return true;
    }

    async restartService(service) {
        // Implementation depends on service type
        return true;
    }

    async checkNetworkConnectivity() {
        // Simple connectivity check
        try {
            const dns = require('dns').promises;
            await dns.resolve4('google.com');
            return true;
        } catch {
            return false;
        }
    }

    async resetNetworkStack() {
        // Platform specific network reset
        if (process.platform === 'win32') {
            await this.exec('ipconfig /release && ipconfig /renew');
        } else {
            await this.exec('sudo systemctl restart networking');
        }
    }

    async checkDNS() {
        try {
            const dns = require('dns').promises;
            await dns.resolve4('localhost');
            return true;
        } catch {
            return false;
        }
    }

    async flushDNSCache() {
        if (process.platform === 'win32') {
            await this.exec('ipconfig /flushdns');
        } else if (process.platform === 'darwin') {
            await this.exec('sudo dscacheutil -flushcache');
        } else {
            await this.exec('sudo systemctl restart systemd-resolved');
        }
    }

    async clearAllCaches() {
        // Emit event for cache clearing
        this.emit('cache:clear-all');
    }

    async reduceMemoryUsage(level) {
        // Emit event for memory reduction
        this.emit('memory:reduce', { level });
    }

    async gracefulRestart() {
        this.emit('restart:graceful');
        this.metrics.systemRestarts++;
        
        // Allow time for cleanup
        await this.sleep(5000);
        
        // Restart process
        process.exit(0);
    }

    async emergencyRestart() {
        this.emit('restart:emergency');
        this.metrics.systemRestarts++;
        
        // Force immediate restart
        process.exit(1);
    }

    async exec(command) {
        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execAsync = promisify(exec);
        
        try {
            await execAsync(command);
            return true;
        } catch {
            return false;
        }
    }

    getStatus() {
        return {
            health: this.metrics.currentHealth,
            metrics: { ...this.metrics },
            circuitBreakers: Array.from(this.circuitBreakers.entries()).map(([type, state]) => ({
                type,
                ...state
            })),
            recentErrors: this.errorHistory.slice(-10)
        };
    }
}

module.exports = EnhancedErrorRecoveryV2;