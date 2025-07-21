/**
 * Production Health Monitoring System
 * Comprehensive health checks for production deployment
 */

import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import { promises as fs } from 'fs';
import { cpus, freemem, totalmem, loadavg } from 'os';

export class HealthMonitor extends EventEmitter {
    constructor(options = {}) {
        super();
        this.options = {
            checkInterval: options.checkInterval || 30000, // 30 seconds
            thresholds: {
                memory: options.memoryThreshold || 0.85, // 85% memory usage
                cpu: options.cpuThreshold || 0.80, // 80% CPU usage
                responseTime: options.responseTimeThreshold || 1000, // 1 second
                errorRate: options.errorRateThreshold || 0.05, // 5% error rate
                ...options.thresholds
            },
            ...options
        };

        this.metrics = {
            uptime: process.uptime(),
            startTime: Date.now(),
            requests: {
                total: 0,
                successful: 0,
                failed: 0,
                averageResponseTime: 0
            },
            system: {
                memory: { used: 0, total: 0, percentage: 0 },
                cpu: { usage: 0, loadAverage: [] },
                disk: { used: 0, total: 0, percentage: 0 }
            },
            database: {
                connected: false,
                responseTime: 0,
                activeConnections: 0
            },
            cache: {
                hitRate: 0,
                missRate: 0,
                size: 0
            }
        };

        this.healthStatus = 'healthy';
        this.lastCheck = null;
        this.checkInterval = null;

        this.startMonitoring();
    }

    startMonitoring() {
        this.checkInterval = setInterval(() => {
            this.performHealthCheck();
        }, this.options.checkInterval);

        // Initial health check
        this.performHealthCheck();
    }

    stopMonitoring() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
    }

    async performHealthCheck() {
        const startTime = performance.now();
        
        try {
            // System metrics
            await this.checkSystemHealth();
            
            // Database health
            await this.checkDatabaseHealth();
            
            // Cache health
            await this.checkCacheHealth();
            
            // Application health
            await this.checkApplicationHealth();
            
            // Determine overall health status
            this.determineHealthStatus();
            
            this.lastCheck = Date.now();
            const checkDuration = performance.now() - startTime;
            
            this.emit('health-check-complete', {
                status: this.healthStatus,
                metrics: this.metrics,
                checkDuration
            });
            
        } catch (error) {
            this.healthStatus = 'unhealthy';
            this.emit('health-check-error', error);
        }
    }

    async checkSystemHealth() {
        // Memory usage
        const memUsed = process.memoryUsage();
        const totalMem = totalmem();
        const freeMem = freemem();
        
        this.metrics.system.memory = {
            used: memUsed.heapUsed,
            total: totalMem,
            free: freeMem,
            percentage: (totalMem - freeMem) / totalMem
        };

        // CPU usage
        const cpuCount = cpus().length;
        const loadAvg = loadavg();
        
        this.metrics.system.cpu = {
            cores: cpuCount,
            loadAverage: loadAvg,
            usage: loadAvg[0] / cpuCount // 1-minute load average
        };

        // Disk usage (if available)
        try {
            const stats = await fs.stat(process.cwd());
            this.metrics.system.disk = {
                available: true,
                lastAccess: stats.atime
            };
        } catch (error) {
            this.metrics.system.disk = {
                available: false,
                error: error.message
            };
        }
    }

    async checkDatabaseHealth() {
        const startTime = performance.now();
        
        try {
            // Mock database health check - replace with actual DB ping
            await new Promise(resolve => setTimeout(resolve, 10));
            
            this.metrics.database = {
                connected: true,
                responseTime: performance.now() - startTime,
                activeConnections: 1, // Mock value
                lastCheck: Date.now()
            };
        } catch (error) {
            this.metrics.database = {
                connected: false,
                error: error.message,
                lastCheck: Date.now()
            };
        }
    }

    async checkCacheHealth() {
        try {
            // Mock cache health check - replace with actual cache stats
            this.metrics.cache = {
                hitRate: 0.85, // Mock 85% hit rate
                missRate: 0.15,
                size: 1024 * 1024, // 1MB mock size
                healthy: true,
                lastCheck: Date.now()
            };
        } catch (error) {
            this.metrics.cache = {
                healthy: false,
                error: error.message,
                lastCheck: Date.now()
            };
        }
    }

    async checkApplicationHealth() {
        // Update uptime
        this.metrics.uptime = process.uptime();
        
        // Check if application is responsive
        const startTime = performance.now();
        
        // Mock application response check
        await new Promise(resolve => setTimeout(resolve, 5));
        
        const responseTime = performance.now() - startTime;
        
        this.metrics.application = {
            responsive: responseTime < this.options.thresholds.responseTime,
            responseTime,
            uptime: this.metrics.uptime,
            version: process.env.npm_package_version || '2.0.0'
        };
    }

    determineHealthStatus() {
        const issues = [];
        
        // Check memory threshold
        if (this.metrics.system.memory.percentage > this.options.thresholds.memory) {
            issues.push('high-memory-usage');
        }
        
        // Check CPU threshold
        if (this.metrics.system.cpu.usage > this.options.thresholds.cpu) {
            issues.push('high-cpu-usage');
        }
        
        // Check database connection
        if (!this.metrics.database.connected) {
            issues.push('database-disconnected');
        }
        
        // Check cache health
        if (!this.metrics.cache.healthy) {
            issues.push('cache-unhealthy');
        }
        
        // Check application response time
        if (this.metrics.application && 
            this.metrics.application.responseTime > this.options.thresholds.responseTime) {
            issues.push('slow-response-time');
        }
        
        if (issues.length === 0) {
            this.healthStatus = 'healthy';
        } else if (issues.length <= 2) {
            this.healthStatus = 'degraded';
        } else {
            this.healthStatus = 'unhealthy';
        }
        
        this.metrics.issues = issues;
    }

    getHealthReport() {
        return {
            status: this.healthStatus,
            timestamp: this.lastCheck || Date.now(),
            uptime: this.metrics.uptime,
            metrics: this.metrics,
            thresholds: this.options.thresholds
        };
    }

    // Express middleware for health endpoint
    middleware() {
        return (req, res) => {
            const report = this.getHealthReport();
            const statusCode = report.status === 'healthy' ? 200 : 
                              report.status === 'degraded' ? 200 : 503;
            
            res.status(statusCode).json(report);
        };
    }

    // Record request metrics
    recordRequest(success = true, responseTime = 0) {
        this.metrics.requests.total++;
        
        if (success) {
            this.metrics.requests.successful++;
        } else {
            this.metrics.requests.failed++;
        }
        
        // Update average response time
        const totalRequests = this.metrics.requests.total;
        const currentAvg = this.metrics.requests.averageResponseTime;
        this.metrics.requests.averageResponseTime = 
            (currentAvg * (totalRequests - 1) + responseTime) / totalRequests;
    }

    // Get current error rate
    getErrorRate() {
        const total = this.metrics.requests.total;
        if (total === 0) return 0;
        return this.metrics.requests.failed / total;
    }
}

// Singleton instance
let healthMonitorInstance;

export function createHealthMonitor(options = {}) {
    if (!healthMonitorInstance) {
        healthMonitorInstance = new HealthMonitor(options);
    }
    return healthMonitorInstance;
}

export function getHealthMonitor() {
    return healthMonitorInstance;
}
