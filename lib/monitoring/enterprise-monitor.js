const EventEmitter = require('events');
const os = require('os');
const fs = require('fs').promises;
const path = require('path');

class EnterpriseMonitor extends EventEmitter {
    constructor(config) {
        super();
        this.config = {
            metricsInterval: config.metricsInterval || 10000, // 10 seconds
            alertThresholds: {
                cpuUsage: 80,
                memoryUsage: 85,
                diskUsage: 90,
                errorRate: 5, // per minute
                responseTime: 1000, // ms
                ...config.alertThresholds
            },
            retentionDays: config.retentionDays || 30,
            metricsDir: config.metricsDir || './data/metrics',
            ...config
        };
        
        this.metrics = {
            system: {
                cpu: [],
                memory: [],
                disk: [],
                network: []
            },
            application: {
                requests: [],
                errors: [],
                latency: [],
                throughput: []
            },
            mining: {
                hashrate: [],
                shares: [],
                difficulty: [],
                efficiency: []
            },
            business: {
                revenue: [],
                costs: [],
                miners: [],
                payouts: []
            }
        };
        
        this.alerts = [];
        this.healthStatus = 'healthy';
        this.startTime = Date.now();
    }
    
    async start() {
        // Create metrics directory
        await fs.mkdir(this.config.metricsDir, { recursive: true });
        
        // Start metric collection
        this.metricsInterval = setInterval(() => {
            this.collectMetrics();
        }, this.config.metricsInterval);
        
        // Start alert checking
        this.alertInterval = setInterval(() => {
            this.checkAlerts();
        }, 60000); // Check every minute
        
        // Load historical metrics
        await this.loadHistoricalMetrics();
        
        console.log('Enterprise monitoring started');
    }
    
    async collectMetrics() {
        const timestamp = Date.now();
        
        // System metrics
        await this.collectSystemMetrics(timestamp);
        
        // Application metrics
        this.collectApplicationMetrics(timestamp);
        
        // Mining metrics
        this.collectMiningMetrics(timestamp);
        
        // Business metrics
        this.collectBusinessMetrics(timestamp);
        
        // Persist metrics
        await this.persistMetrics(timestamp);
        
        // Emit metrics event
        this.emit('metrics', this.getCurrentMetrics());
    }
    
    async collectSystemMetrics(timestamp) {
        // CPU usage
        const cpuUsage = process.cpuUsage();
        const cpuPercent = (cpuUsage.user + cpuUsage.system) / 1000000 * 100;
        this.addMetric('system', 'cpu', {
            timestamp,
            value: cpuPercent,
            cores: os.cpus().length
        });
        
        // Memory usage
        const totalMemory = os.totalmem();
        const freeMemory = os.freemem();
        const usedMemory = totalMemory - freeMemory;
        const memoryPercent = (usedMemory / totalMemory) * 100;
        
        this.addMetric('system', 'memory', {
            timestamp,
            value: memoryPercent,
            used: usedMemory,
            total: totalMemory
        });
        
        // Disk usage (simplified - would use df in production)
        const diskStats = await this.getDiskUsage();
        this.addMetric('system', 'disk', {
            timestamp,
            value: diskStats.usedPercent,
            used: diskStats.used,
            total: diskStats.total
        });
        
        // Network usage
        const netStats = this.getNetworkStats();
        this.addMetric('system', 'network', {
            timestamp,
            rx: netStats.rx,
            tx: netStats.tx,
            connections: netStats.connections
        });
    }
    
    collectApplicationMetrics(timestamp) {
        // These would be collected from actual application
        this.addMetric('application', 'requests', {
            timestamp,
            value: Math.floor(Math.random() * 1000), // Placeholder
            rate: Math.floor(Math.random() * 100)
        });
        
        this.addMetric('application', 'errors', {
            timestamp,
            value: Math.floor(Math.random() * 10),
            rate: Math.random() * 5
        });
        
        this.addMetric('application', 'latency', {
            timestamp,
            p50: 10 + Math.random() * 20,
            p95: 50 + Math.random() * 50,
            p99: 100 + Math.random() * 100
        });
    }
    
    collectMiningMetrics(timestamp) {
        // These would be collected from mining pool
        this.addMetric('mining', 'hashrate', {
            timestamp,
            value: 1000000000 + Math.random() * 100000000, // 1-1.1 GH/s
            unit: 'H/s'
        });
        
        this.addMetric('mining', 'shares', {
            timestamp,
            valid: Math.floor(Math.random() * 100),
            invalid: Math.floor(Math.random() * 5),
            stale: Math.floor(Math.random() * 2)
        });
        
        this.addMetric('mining', 'difficulty', {
            timestamp,
            network: 1000000,
            pool: 10000,
            avgShareTime: 10 + Math.random() * 5
        });
    }
    
    collectBusinessMetrics(timestamp) {
        // These would be calculated from actual data
        this.addMetric('business', 'revenue', {
            timestamp,
            daily: 1000 + Math.random() * 200,
            fees: 50 + Math.random() * 10,
            currency: 'USD'
        });
        
        this.addMetric('business', 'miners', {
            timestamp,
            active: 1000 + Math.floor(Math.random() * 100),
            total: 5000 + Math.floor(Math.random() * 500),
            new: Math.floor(Math.random() * 50)
        });
    }
    
    addMetric(category, subcategory, data) {
        const metrics = this.metrics[category][subcategory];
        
        // Keep only recent metrics in memory
        const cutoff = Date.now() - (24 * 60 * 60 * 1000); // 24 hours
        while (metrics.length > 0 && metrics[0].timestamp < cutoff) {
            metrics.shift();
        }
        
        metrics.push(data);
    }
    
    async persistMetrics(timestamp) {
        const date = new Date(timestamp);
        const filename = `metrics_${date.toISOString().split('T')[0]}.json`;
        const filepath = path.join(this.config.metricsDir, filename);
        
        try {
            // Read existing data
            let existingData = {};
            try {
                const content = await fs.readFile(filepath, 'utf8');
                existingData = JSON.parse(content);
            } catch (err) {
                // File doesn't exist yet
            }
            
            // Append new metrics
            const hourKey = date.getHours();
            if (!existingData[hourKey]) {
                existingData[hourKey] = [];
            }
            
            existingData[hourKey].push({
                timestamp,
                metrics: this.getCurrentMetrics()
            });
            
            // Write back
            await fs.writeFile(filepath, JSON.stringify(existingData, null, 2));
        } catch (err) {
            console.error('Failed to persist metrics:', err);
        }
    }
    
    async loadHistoricalMetrics() {
        try {
            const files = await fs.readdir(this.config.metricsDir);
            const recentFiles = files
                .filter(f => f.startsWith('metrics_'))
                .sort()
                .slice(-7); // Last 7 days
            
            for (const file of recentFiles) {
                try {
                    const content = await fs.readFile(
                        path.join(this.config.metricsDir, file),
                        'utf8'
                    );
                    const data = JSON.parse(content);
                    
                    // Process historical data
                    for (const hour in data) {
                        for (const entry of data[hour]) {
                            // Add to in-memory metrics
                            this.processHistoricalEntry(entry);
                        }
                    }
                } catch (err) {
                    console.error(`Failed to load ${file}:`, err);
                }
            }
        } catch (err) {
            console.error('Failed to load historical metrics:', err);
        }
    }
    
    processHistoricalEntry(entry) {
        // Add historical metrics to in-memory storage
        // This is simplified - real implementation would be more sophisticated
    }
    
    checkAlerts() {
        const current = this.getCurrentMetrics();
        const newAlerts = [];
        
        // CPU usage alert
        if (current.system.cpu.value > this.config.alertThresholds.cpuUsage) {
            newAlerts.push({
                type: 'cpu_high',
                severity: 'warning',
                message: `CPU usage is ${current.system.cpu.value.toFixed(1)}%`,
                timestamp: Date.now()
            });
        }
        
        // Memory usage alert
        if (current.system.memory.percent > this.config.alertThresholds.memoryUsage) {
            newAlerts.push({
                type: 'memory_high',
                severity: 'warning',
                message: `Memory usage is ${current.system.memory.percent.toFixed(1)}%`,
                timestamp: Date.now()
            });
        }
        
        // Error rate alert
        const errorRate = this.calculateErrorRate();
        if (errorRate > this.config.alertThresholds.errorRate) {
            newAlerts.push({
                type: 'error_rate_high',
                severity: 'critical',
                message: `Error rate is ${errorRate.toFixed(1)} errors/minute`,
                timestamp: Date.now()
            });
        }
        
        // Add new alerts
        for (const alert of newAlerts) {
            this.alerts.push(alert);
            this.emit('alert', alert);
        }
        
        // Update health status
        this.updateHealthStatus();
        
        // Clean old alerts
        const alertCutoff = Date.now() - (60 * 60 * 1000); // 1 hour
        this.alerts = this.alerts.filter(a => a.timestamp > alertCutoff);
    }
    
    calculateErrorRate() {
        const recentErrors = this.metrics.application.errors
            .filter(e => e.timestamp > Date.now() - 60000); // Last minute
        
        if (recentErrors.length === 0) return 0;
        
        const totalErrors = recentErrors.reduce((sum, e) => sum + e.value, 0);
        return totalErrors;
    }
    
    updateHealthStatus() {
        const criticalAlerts = this.alerts.filter(a => a.severity === 'critical');
        const warningAlerts = this.alerts.filter(a => a.severity === 'warning');
        
        if (criticalAlerts.length > 0) {
            this.healthStatus = 'critical';
        } else if (warningAlerts.length > 2) {
            this.healthStatus = 'degraded';
        } else {
            this.healthStatus = 'healthy';
        }
    }
    
    getCurrentMetrics() {
        const latest = (arr) => arr.length > 0 ? arr[arr.length - 1] : null;
        
        return {
            timestamp: Date.now(),
            health: this.healthStatus,
            uptime: Date.now() - this.startTime,
            system: {
                cpu: latest(this.metrics.system.cpu),
                memory: latest(this.metrics.system.memory),
                disk: latest(this.metrics.system.disk),
                network: latest(this.metrics.system.network)
            },
            application: {
                requests: latest(this.metrics.application.requests),
                errors: latest(this.metrics.application.errors),
                latency: latest(this.metrics.application.latency)
            },
            mining: {
                hashrate: latest(this.metrics.mining.hashrate),
                shares: latest(this.metrics.mining.shares),
                difficulty: latest(this.metrics.mining.difficulty)
            },
            business: {
                revenue: latest(this.metrics.business.revenue),
                miners: latest(this.metrics.business.miners)
            }
        };
    }
    
    async getDiskUsage() {
        // Simplified disk usage - in production would use df or similar
        return {
            used: 50 * 1024 * 1024 * 1024, // 50GB
            total: 100 * 1024 * 1024 * 1024, // 100GB
            usedPercent: 50
        };
    }
    
    getNetworkStats() {
        // Simplified network stats
        return {
            rx: Math.floor(Math.random() * 1000000), // bytes
            tx: Math.floor(Math.random() * 1000000),
            connections: Math.floor(Math.random() * 1000)
        };
    }
    
    async generateReport(type = 'daily') {
        const report = {
            generated: new Date().toISOString(),
            type: type,
            period: this.getReportPeriod(type),
            summary: await this.generateSummary(type),
            details: await this.generateDetails(type),
            alerts: this.alerts.filter(a => this.isInPeriod(a.timestamp, type)),
            recommendations: this.generateRecommendations()
        };
        
        return report;
    }
    
    getReportPeriod(type) {
        const end = new Date();
        const start = new Date();
        
        switch (type) {
            case 'hourly':
                start.setHours(start.getHours() - 1);
                break;
            case 'daily':
                start.setDate(start.getDate() - 1);
                break;
            case 'weekly':
                start.setDate(start.getDate() - 7);
                break;
            case 'monthly':
                start.setMonth(start.getMonth() - 1);
                break;
        }
        
        return { start, end };
    }
    
    async generateSummary(type) {
        // Generate executive summary
        return {
            health: this.healthStatus,
            uptime: this.getUptimePercentage(),
            totalRequests: this.getTotalRequests(type),
            totalHashrate: this.getAverageHashrate(type),
            totalRevenue: this.getTotalRevenue(type),
            activeMiners: this.getAverageMiners(type)
        };
    }
    
    async generateDetails(type) {
        // Generate detailed metrics
        return {
            system: this.aggregateMetrics('system', type),
            application: this.aggregateMetrics('application', type),
            mining: this.aggregateMetrics('mining', type),
            business: this.aggregateMetrics('business', type)
        };
    }
    
    generateRecommendations() {
        const recommendations = [];
        
        if (this.healthStatus !== 'healthy') {
            recommendations.push({
                priority: 'high',
                category: 'health',
                action: 'Investigate and resolve current alerts'
            });
        }
        
        // Add more intelligent recommendations based on metrics
        
        return recommendations;
    }
    
    // Helper methods
    getUptimePercentage() {
        return 99.9; // Placeholder
    }
    
    getTotalRequests(type) {
        return 1000000; // Placeholder
    }
    
    getAverageHashrate(type) {
        return 1050000000; // Placeholder
    }
    
    getTotalRevenue(type) {
        return 25000; // Placeholder
    }
    
    getAverageMiners(type) {
        return 1050; // Placeholder
    }
    
    isInPeriod(timestamp, type) {
        const period = this.getReportPeriod(type);
        return timestamp >= period.start.getTime() && timestamp <= period.end.getTime();
    }
    
    aggregateMetrics(category, type) {
        // Aggregate metrics for the period
        return {}; // Placeholder
    }
    
    async stop() {
        clearInterval(this.metricsInterval);
        clearInterval(this.alertInterval);
        console.log('Enterprise monitoring stopped');
    }
}

module.exports = EnterpriseMonitor;