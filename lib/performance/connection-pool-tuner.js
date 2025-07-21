/**
 * Connection Pool Tuner for Otedama
 * Dynamically adjusts connection pool parameters based on workload
 */

import { EventEmitter } from 'events';
import { logger } from '../core/logger.js';
import os from 'os';

export class ConnectionPoolTuner extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.options = {
            minConnections: options.minConnections || 2,
            maxConnections: options.maxConnections || Math.max(10, os.cpus().length * 2),
            targetUtilization: options.targetUtilization || 0.7,
            checkInterval: options.checkInterval || 30000, // 30 seconds
            scaleUpThreshold: options.scaleUpThreshold || 0.8,
            scaleDownThreshold: options.scaleDownThreshold || 0.3,
            scaleUpIncrement: options.scaleUpIncrement || 2,
            scaleDownDecrement: options.scaleDownDecrement || 1,
            idleTimeout: options.idleTimeout || 300000, // 5 minutes
            ...options
        };

        this.pools = new Map();
        this.metrics = new Map();
        this.tuningInterval = null;
        this.isRunning = false;
    }

    /**
     * Register a connection pool for tuning
     */
    registerPool(name, pool) {
        this.pools.set(name, pool);
        this.metrics.set(name, {
            connectionCount: 0,
            activeConnections: 0,
            waitingRequests: 0,
            totalRequests: 0,
            totalWaitTime: 0,
            errors: 0,
            history: []
        });

        // Hook into pool events
        this.instrumentPool(name, pool);
        
        logger.info(`Registered pool '${name}' for tuning`);
    }

    /**
     * Start automatic tuning
     */
    start() {
        if (this.isRunning) return;

        this.isRunning = true;
        this.tuningInterval = setInterval(() => {
            this.tunePools();
        }, this.options.checkInterval);

        // Initial tuning
        this.tunePools();
        
        logger.info('Connection pool tuner started');
    }

    /**
     * Stop automatic tuning
     */
    stop() {
        if (!this.isRunning) return;

        this.isRunning = false;
        if (this.tuningInterval) {
            clearInterval(this.tuningInterval);
            this.tuningInterval = null;
        }

        logger.info('Connection pool tuner stopped');
    }

    /**
     * Instrument pool to collect metrics
     */
    instrumentPool(name, pool) {
        const metrics = this.metrics.get(name);
        
        // Override pool methods to collect metrics
        const originalAcquire = pool.acquire?.bind(pool);
        const originalRelease = pool.release?.bind(pool);

        if (originalAcquire) {
            pool.acquire = async (...args) => {
                const startTime = Date.now();
                metrics.totalRequests++;

                if (pool.available === 0) {
                    metrics.waitingRequests++;
                }

                try {
                    const connection = await originalAcquire(...args);
                    const waitTime = Date.now() - startTime;
                    metrics.totalWaitTime += waitTime;
                    metrics.activeConnections++;
                    
                    return connection;
                } catch (error) {
                    metrics.errors++;
                    throw error;
                } finally {
                    if (metrics.waitingRequests > 0) {
                        metrics.waitingRequests--;
                    }
                }
            };
        }

        if (originalRelease) {
            pool.release = (...args) => {
                const result = originalRelease(...args);
                metrics.activeConnections = Math.max(0, metrics.activeConnections - 1);
                return result;
            };
        }

        // Monitor pool size changes
        if (pool.on) {
            pool.on('create', () => {
                metrics.connectionCount++;
            });

            pool.on('destroy', () => {
                metrics.connectionCount = Math.max(0, metrics.connectionCount - 1);
            });
        }
    }

    /**
     * Tune all registered pools
     */
    async tunePools() {
        for (const [name, pool] of this.pools) {
            try {
                await this.tunePool(name, pool);
            } catch (error) {
                logger.error(`Error tuning pool '${name}':`, error);
            }
        }
    }

    /**
     * Tune a specific pool
     */
    async tunePool(name, pool) {
        const metrics = this.metrics.get(name);
        if (!metrics) return;

        // Calculate current utilization
        const utilization = metrics.connectionCount > 0 
            ? metrics.activeConnections / metrics.connectionCount 
            : 0;

        // Calculate average wait time
        const avgWaitTime = metrics.totalRequests > 0
            ? metrics.totalWaitTime / metrics.totalRequests
            : 0;

        // Record metrics history
        metrics.history.push({
            timestamp: Date.now(),
            utilization,
            avgWaitTime,
            connectionCount: metrics.connectionCount,
            activeConnections: metrics.activeConnections,
            waitingRequests: metrics.waitingRequests
        });

        // Keep only recent history (last hour)
        const oneHourAgo = Date.now() - 3600000;
        metrics.history = metrics.history.filter(h => h.timestamp > oneHourAgo);

        // Make tuning decision
        const decision = this.makeTuningDecision(name, metrics, utilization, avgWaitTime);
        
        if (decision.action !== 'none') {
            await this.applyTuningDecision(name, pool, decision);
        }

        // Emit metrics event
        this.emit('metrics', {
            pool: name,
            utilization,
            avgWaitTime,
            connectionCount: metrics.connectionCount,
            activeConnections: metrics.activeConnections,
            decision
        });
    }

    /**
     * Make tuning decision based on metrics
     */
    makeTuningDecision(name, metrics, utilization, avgWaitTime) {
        const currentSize = metrics.connectionCount || this.options.minConnections;

        // Check if we need to scale up
        if (utilization > this.options.scaleUpThreshold || 
            metrics.waitingRequests > 0 || 
            avgWaitTime > 100) { // More than 100ms wait time
            
            const newSize = Math.min(
                currentSize + this.options.scaleUpIncrement,
                this.options.maxConnections
            );

            if (newSize > currentSize) {
                return {
                    action: 'scale_up',
                    currentSize,
                    newSize,
                    reason: `High utilization (${(utilization * 100).toFixed(1)}%) or wait time (${avgWaitTime.toFixed(0)}ms)`
                };
            }
        }

        // Check if we need to scale down
        if (utilization < this.options.scaleDownThreshold && 
            metrics.waitingRequests === 0 &&
            currentSize > this.options.minConnections) {
            
            // Check trend to avoid oscillation
            const recentHistory = metrics.history.slice(-5);
            const avgRecentUtilization = recentHistory.reduce((sum, h) => sum + h.utilization, 0) / recentHistory.length;

            if (avgRecentUtilization < this.options.scaleDownThreshold) {
                const newSize = Math.max(
                    currentSize - this.options.scaleDownDecrement,
                    this.options.minConnections
                );

                return {
                    action: 'scale_down',
                    currentSize,
                    newSize,
                    reason: `Low utilization (${(utilization * 100).toFixed(1)}%)`
                };
            }
        }

        // Check for idle connections
        const idleConnections = currentSize - metrics.activeConnections;
        if (idleConnections > 0) {
            const oldestHistory = metrics.history[0];
            if (oldestHistory && Date.now() - oldestHistory.timestamp > this.options.idleTimeout) {
                return {
                    action: 'cleanup_idle',
                    idleCount: idleConnections,
                    reason: 'Idle connections detected'
                };
            }
        }

        return { action: 'none' };
    }

    /**
     * Apply tuning decision to pool
     */
    async applyTuningDecision(name, pool, decision) {
        logger.info(`Tuning pool '${name}': ${decision.action} - ${decision.reason}`);

        switch (decision.action) {
            case 'scale_up':
                await this.scaleUpPool(pool, decision.newSize - decision.currentSize);
                break;

            case 'scale_down':
                await this.scaleDownPool(pool, decision.currentSize - decision.newSize);
                break;

            case 'cleanup_idle':
                await this.cleanupIdleConnections(pool, decision.idleCount);
                break;
        }

        this.emit('tuning', {
            pool: name,
            decision
        });
    }

    /**
     * Scale up pool by adding connections
     */
    async scaleUpPool(pool, count) {
        if (pool.setSize) {
            // If pool supports dynamic sizing
            const currentSize = pool.size || pool.getSize();
            await pool.setSize(currentSize + count);
        } else if (pool.create) {
            // Manually create connections
            for (let i = 0; i < count; i++) {
                try {
                    await pool.create();
                } catch (error) {
                    logger.error('Failed to create connection:', error);
                    break;
                }
            }
        }
    }

    /**
     * Scale down pool by removing connections
     */
    async scaleDownPool(pool, count) {
        if (pool.setSize) {
            // If pool supports dynamic sizing
            const currentSize = pool.size || pool.getSize();
            await pool.setSize(Math.max(this.options.minConnections, currentSize - count));
        } else if (pool.destroy) {
            // Manually destroy idle connections
            let destroyed = 0;
            const connections = pool.getAllConnections ? pool.getAllConnections() : [];
            
            for (const conn of connections) {
                if (destroyed >= count) break;
                if (conn.idle || conn.state === 'idle') {
                    try {
                        await pool.destroy(conn);
                        destroyed++;
                    } catch (error) {
                        logger.error('Failed to destroy connection:', error);
                    }
                }
            }
        }
    }

    /**
     * Cleanup idle connections
     */
    async cleanupIdleConnections(pool, maxToClean) {
        if (pool.destroyAllNow) {
            // Some pools have bulk cleanup
            await pool.destroyAllNow();
        } else if (pool.clear) {
            // Clear idle connections
            await pool.clear();
        } else {
            // Manual cleanup
            await this.scaleDownPool(pool, maxToClean);
        }
    }

    /**
     * Get tuning recommendations
     */
    getRecommendations() {
        const recommendations = [];

        for (const [name, metrics] of this.metrics) {
            const pool = this.pools.get(name);
            if (!pool) continue;

            // Analyze error rate
            const errorRate = metrics.totalRequests > 0 
                ? metrics.errors / metrics.totalRequests 
                : 0;

            if (errorRate > 0.05) { // More than 5% errors
                recommendations.push({
                    pool: name,
                    type: 'high_error_rate',
                    severity: 'high',
                    message: `Pool '${name}' has high error rate (${(errorRate * 100).toFixed(1)}%)`,
                    suggestion: 'Check connection health and increase pool size'
                });
            }

            // Analyze wait times
            const avgWaitTime = metrics.totalRequests > 0
                ? metrics.totalWaitTime / metrics.totalRequests
                : 0;

            if (avgWaitTime > 500) { // More than 500ms average wait
                recommendations.push({
                    pool: name,
                    type: 'high_wait_time',
                    severity: 'medium',
                    message: `Pool '${name}' has high average wait time (${avgWaitTime.toFixed(0)}ms)`,
                    suggestion: 'Increase pool size or optimize query performance'
                });
            }

            // Check pool efficiency
            const utilization = metrics.connectionCount > 0 
                ? metrics.activeConnections / metrics.connectionCount 
                : 0;

            if (utilization < 0.1 && metrics.connectionCount > this.options.minConnections) {
                recommendations.push({
                    pool: name,
                    type: 'low_utilization',
                    severity: 'low',
                    message: `Pool '${name}' has very low utilization (${(utilization * 100).toFixed(1)}%)`,
                    suggestion: 'Consider reducing pool size to save resources'
                });
            }
        }

        return recommendations;
    }

    /**
     * Get current metrics for all pools
     */
    getMetrics() {
        const result = {};

        for (const [name, metrics] of this.metrics) {
            const utilization = metrics.connectionCount > 0 
                ? metrics.activeConnections / metrics.connectionCount 
                : 0;

            const avgWaitTime = metrics.totalRequests > 0
                ? metrics.totalWaitTime / metrics.totalRequests
                : 0;

            result[name] = {
                connectionCount: metrics.connectionCount,
                activeConnections: metrics.activeConnections,
                waitingRequests: metrics.waitingRequests,
                utilization: Math.round(utilization * 100) / 100,
                avgWaitTime: Math.round(avgWaitTime),
                errorRate: metrics.totalRequests > 0 
                    ? Math.round((metrics.errors / metrics.totalRequests) * 10000) / 100 
                    : 0
            };
        }

        return result;
    }

    /**
     * Reset metrics
     */
    resetMetrics(poolName) {
        if (poolName && this.metrics.has(poolName)) {
            const metrics = this.metrics.get(poolName);
            metrics.totalRequests = 0;
            metrics.totalWaitTime = 0;
            metrics.errors = 0;
            metrics.history = [];
        } else if (!poolName) {
            // Reset all
            for (const metrics of this.metrics.values()) {
                metrics.totalRequests = 0;
                metrics.totalWaitTime = 0;
                metrics.errors = 0;
                metrics.history = [];
            }
        }
    }
}

export default ConnectionPoolTuner;