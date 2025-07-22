/**
 * Memory Optimizer for Otedama
 * Implements memory optimization strategies and automatic tuning
 */

import { EventEmitter } from 'events';
import v8 from 'v8';
import os from 'os';
import { getLogger } from '../core/logger.js';

const logger = getLogger('MemoryOptimizer');

export class MemoryOptimizer extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.options = {
            maxHeapSize: options.maxHeapSize || Math.floor(os.totalmem() * 0.75), // 75% of system memory
            targetHeapUsage: options.targetHeapUsage || 0.7, // 70% heap usage target
            gcInterval: options.gcInterval || 60000, // 1 minute
            optimizeInterval: options.optimizeInterval || 30000, // 30 seconds
            enableAutoGC: options.enableAutoGC !== false,
            enableHeapCompaction: options.enableHeapCompaction !== false,
            ...options
        };

        this.isRunning = false;
        this.gcInterval = null;
        this.optimizeInterval = null;
        this.lastGC = Date.now();
        this.optimizations = {
            gcRuns: 0,
            compactions: 0,
            cacheClears: 0,
            bufferRecycles: 0
        };
    }

    /**
     * Start memory optimization
     */
    start() {
        if (this.isRunning) return;
        
        this.isRunning = true;

        // Configure V8 heap settings
        this.configureV8();

        // Start optimization cycle
        this.optimizeInterval = setInterval(() => {
            this.optimize();
        }, this.options.optimizeInterval);

        // Start GC cycle if enabled
        if (this.options.enableAutoGC) {
            this.gcInterval = setInterval(() => {
                this.runGarbageCollection();
            }, this.options.gcInterval);
        }

        // Initial optimization
        this.optimize();
        
        logger.info('Memory optimizer started');
    }

    /**
     * Stop memory optimization
     */
    stop() {
        if (!this.isRunning) return;
        
        this.isRunning = false;
        
        if (this.gcInterval) {
            clearInterval(this.gcInterval);
            this.gcInterval = null;
        }
        
        if (this.optimizeInterval) {
            clearInterval(this.optimizeInterval);
            this.optimizeInterval = null;
        }
        
        logger.info('Memory optimizer stopped');
    }

    /**
     * Configure V8 heap settings
     */
    configureV8() {
        try {
            // Set heap size limit
            const heapSizeMB = Math.floor(this.options.maxHeapSize / 1024 / 1024);
            
            if (global.gc) {
                // If --expose-gc flag is set
                v8.setFlagsFromString(`--max-old-space-size=${heapSizeMB}`);
                v8.setFlagsFromString('--optimize-for-size');
                v8.setFlagsFromString('--always-compact');
                logger.info(`V8 heap size set to ${heapSizeMB}MB`);
            }
        } catch (error) {
            logger.warn('Failed to configure V8 settings:', error.message);
        }
    }

    /**
     * Run optimization cycle
     */
    async optimize() {
        const memBefore = process.memoryUsage();
        const startTime = Date.now();
        
        try {
            // 1. Check memory pressure
            const pressure = this.getMemoryPressure();
            
            if (pressure > 0.9) {
                this.emit('memory:critical', { pressure, usage: memBefore });
                await this.emergencyOptimization();
            } else if (pressure > this.options.targetHeapUsage) {
                await this.standardOptimization();
            }
            
            // 2. Optimize specific areas
            await this.optimizeBuffers();
            await this.optimizeCaches();
            await this.compactHeap();
            
            const memAfter = process.memoryUsage();
            const freed = memBefore.heapUsed - memAfter.heapUsed;
            
            if (freed > 0) {
                this.emit('memory:optimized', {
                    freed,
                    duration: Date.now() - startTime,
                    before: memBefore,
                    after: memAfter
                });
            }
            
        } catch (error) {
            logger.error('Memory optimization error:', error);
            this.emit('error', error);
        }
    }

    /**
     * Get current memory pressure (0-1)
     */
    getMemoryPressure() {
        const usage = process.memoryUsage();
        const heapPressure = usage.heapUsed / usage.heapTotal;
        const systemPressure = usage.rss / this.options.maxHeapSize;
        
        return Math.max(heapPressure, systemPressure);
    }

    /**
     * Emergency optimization for critical memory situations
     */
    async emergencyOptimization() {
        logger.warn('Emergency memory optimization triggered');
        
        // 1. Force garbage collection
        if (global.gc) {
            global.gc(true); // Full GC
            this.optimizations.gcRuns++;
        }
        
        // 2. Clear all caches
        this.emit('cache:clear', { reason: 'memory_pressure' });
        this.optimizations.cacheClears++;
        
        // 3. Compact heap
        if (this.options.enableHeapCompaction) {
            v8.writeHeapSnapshot();
            this.optimizations.compactions++;
        }
        
        // 4. Reduce buffer sizes
        this.emit('buffer:reduce', { reason: 'memory_pressure' });
        
        // 5. Request external cleanup
        this.emit('memory:cleanup:required');
    }

    /**
     * Standard optimization for normal memory pressure
     */
    async standardOptimization() {
        // Run incremental GC if needed
        const timeSinceGC = Date.now() - this.lastGC;
        if (timeSinceGC > this.options.gcInterval && global.gc) {
            global.gc(false); // Incremental GC
            this.lastGC = Date.now();
            this.optimizations.gcRuns++;
        }
        
        // Clear old cache entries
        this.emit('cache:prune', { maxAge: 300000 }); // 5 minutes
    }

    /**
     * Optimize buffer usage
     */
    async optimizeBuffers() {
        // Get all ArrayBuffer allocations
        const heapStats = v8.getHeapStatistics();
        const arrayBufferSize = heapStats.total_available_size - heapStats.used_heap_size;
        
        if (arrayBufferSize > 50 * 1024 * 1024) { // More than 50MB in buffers
            this.emit('buffer:optimize', {
                currentSize: arrayBufferSize,
                recommendation: 'recycle'
            });
            this.optimizations.bufferRecycles++;
        }
    }

    /**
     * Optimize cache usage
     */
    async optimizeCaches() {
        const usage = process.memoryUsage();
        const heapUsagePercent = (usage.heapUsed / usage.heapTotal) * 100;
        
        if (heapUsagePercent > 80) {
            // Aggressive cache pruning
            this.emit('cache:resize', { 
                factor: 0.5,
                reason: 'high_memory_usage' 
            });
            this.optimizations.cacheClears++;
        } else if (heapUsagePercent > 60) {
            // Moderate cache pruning
            this.emit('cache:resize', { 
                factor: 0.8,
                reason: 'moderate_memory_usage' 
            });
        }
    }

    /**
     * Compact heap if beneficial
     */
    async compactHeap() {
        if (!this.options.enableHeapCompaction) return;
        
        const stats = v8.getHeapStatistics();
        const fragmentationRatio = 1 - (stats.used_heap_size / stats.total_heap_size);
        
        if (fragmentationRatio > 0.3) { // More than 30% fragmentation
            logger.info(`Heap fragmentation at ${(fragmentationRatio * 100).toFixed(1)}%, compacting...`);
            
            if (global.gc) {
                global.gc(true); // Full GC with compaction
                this.optimizations.compactions++;
            }
        }
    }

    /**
     * Run garbage collection
     */
    runGarbageCollection() {
        if (!global.gc) {
            logger.warn('Garbage collection not exposed. Run with --expose-gc flag');
            return;
        }
        
        const before = process.memoryUsage();
        const startTime = Date.now();
        
        global.gc(false); // Incremental GC
        
        const after = process.memoryUsage();
        const duration = Date.now() - startTime;
        const freed = before.heapUsed - after.heapUsed;
        
        this.optimizations.gcRuns++;
        this.lastGC = Date.now();
        
        if (freed > 1024 * 1024) { // More than 1MB freed
            this.emit('gc:completed', {
                freed,
                duration,
                before,
                after
            });
        }
    }

    /**
     * Get memory optimization statistics
     */
    getStats() {
        const usage = process.memoryUsage();
        const stats = v8.getHeapStatistics();
        
        return {
            current: {
                heapUsed: Math.round(usage.heapUsed / 1024 / 1024),
                heapTotal: Math.round(usage.heapTotal / 1024 / 1024),
                rss: Math.round(usage.rss / 1024 / 1024),
                external: Math.round(usage.external / 1024 / 1024),
                arrayBuffers: Math.round(usage.arrayBuffers / 1024 / 1024)
            },
            heap: {
                totalSize: Math.round(stats.total_heap_size / 1024 / 1024),
                usedSize: Math.round(stats.used_heap_size / 1024 / 1024),
                limit: Math.round(stats.heap_size_limit / 1024 / 1024),
                fragmentation: Math.round((1 - (stats.used_heap_size / stats.total_heap_size)) * 100)
            },
            optimizations: { ...this.optimizations },
            pressure: Math.round(this.getMemoryPressure() * 100)
        };
    }

    /**
     * Get memory usage recommendations
     */
    getRecommendations() {
        const stats = this.getStats();
        const recommendations = [];
        
        // Check heap usage
        if (stats.pressure > 90) {
            recommendations.push({
                severity: 'critical',
                category: 'heap',
                message: 'Critical memory pressure detected',
                action: 'Increase heap size or reduce memory usage immediately'
            });
        } else if (stats.pressure > 80) {
            recommendations.push({
                severity: 'high',
                category: 'heap',
                message: 'High memory pressure detected',
                action: 'Consider optimizing memory usage or increasing heap size'
            });
        }
        
        // Check fragmentation
        if (stats.heap.fragmentation > 30) {
            recommendations.push({
                severity: 'medium',
                category: 'fragmentation',
                message: `Heap fragmentation at ${stats.heap.fragmentation}%`,
                action: 'Enable heap compaction or restart application periodically'
            });
        }
        
        // Check external memory
        if (stats.current.external > 100) { // More than 100MB external
            recommendations.push({
                severity: 'low',
                category: 'external',
                message: 'High external memory usage',
                action: 'Review native module usage and buffer allocations'
            });
        }
        
        // Check array buffers
        if (stats.current.arrayBuffers > 50) { // More than 50MB in buffers
            recommendations.push({
                severity: 'low',
                category: 'buffers',
                message: 'High ArrayBuffer usage',
                action: 'Implement buffer pooling or recycling'
            });
        }
        
        return recommendations;
    }

    /**
     * Force memory optimization
     */
    async forceOptimize() {
        logger.info('Forcing memory optimization');
        await this.emergencyOptimization();
        return this.getStats();
    }

    /**
     * Take heap snapshot
     */
    takeHeapSnapshot(filepath) {
        try {
            v8.writeHeapSnapshot(filepath);
            logger.info(`Heap snapshot written to ${filepath}`);
            return true;
        } catch (error) {
            logger.error('Failed to write heap snapshot:', error);
            return false;
        }
    }
}

export default MemoryOptimizer;