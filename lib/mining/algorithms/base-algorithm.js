/**
 * Base Mining Algorithm Class
 * Abstract base class for all mining algorithms
 */

import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';

export class MiningAlgorithm extends EventEmitter {
    constructor(name, config = {}) {
        super();
        
        this.name = name;
        this.config = config;
        this.initialized = false;
        this.hashCount = 0;
        this.startTime = 0;
        this.lastHashTime = 0;
    }

    /**
     * Initialize algorithm (must be implemented by subclass)
     */
    async initialize(blockHeight) {
        throw new Error('initialize() must be implemented by subclass');
    }

    /**
     * Hash function (must be implemented by subclass)
     */
    async hash(blockHeader, nonce, target) {
        throw new Error('hash() must be implemented by subclass');
    }

    /**
     * Validate share (must be implemented by subclass)
     */
    async validateShare(share) {
        throw new Error('validateShare() must be implemented by subclass');
    }

    /**
     * Get algorithm info (must be implemented by subclass)
     */
    getInfo() {
        throw new Error('getInfo() must be implemented by subclass');
    }

    /**
     * Start mining
     */
    async startMining(job, nonceRange) {
        if (!this.initialized) {
            await this.initialize(job.height);
            this.initialized = true;
        }
        
        this.startTime = performance.now();
        this.hashCount = 0;
        
        const { blockHeader, target } = job;
        const [startNonce, endNonce] = nonceRange;
        
        for (let nonce = startNonce; nonce < endNonce; nonce++) {
            const result = await this.hash(blockHeader, nonce, target);
            this.hashCount++;
            
            if (result.valid) {
                this.emit('found', {
                    nonce,
                    hash: result.hash,
                    mixHash: result.mixHash,
                    job
                });
                return result;
            }
            
            // Emit progress every 1000 hashes
            if (this.hashCount % 1000 === 0) {
                this.emit('progress', {
                    hashCount: this.hashCount,
                    hashrate: this.calculateHashrate(),
                    nonce
                });
            }
            
            // Check if mining should stop
            if (this.shouldStop) {
                break;
            }
        }
        
        return null;
    }

    /**
     * Stop mining
     */
    stopMining() {
        this.shouldStop = true;
    }

    /**
     * Calculate current hashrate
     */
    calculateHashrate() {
        const elapsed = performance.now() - this.startTime;
        if (elapsed === 0) return 0;
        
        return Math.floor((this.hashCount / elapsed) * 1000);
    }

    /**
     * Get mining statistics
     */
    getStats() {
        return {
            algorithm: this.name,
            initialized: this.initialized,
            hashCount: this.hashCount,
            hashrate: this.calculateHashrate(),
            uptime: this.startTime ? performance.now() - this.startTime : 0
        };
    }

    /**
     * Cleanup resources
     */
    async cleanup() {
        this.initialized = false;
        this.hashCount = 0;
        this.startTime = 0;
        this.removeAllListeners();
    }
}

/**
 * Algorithm Registry
 */
export class AlgorithmRegistry {
    constructor() {
        this.algorithms = new Map();
    }

    /**
     * Register algorithm
     */
    register(name, algorithmClass) {
        this.algorithms.set(name.toLowerCase(), algorithmClass);
    }

    /**
     * Get algorithm
     */
    get(name) {
        return this.algorithms.get(name.toLowerCase());
    }

    /**
     * Create algorithm instance
     */
    create(name, config = {}) {
        const AlgorithmClass = this.get(name);
        if (!AlgorithmClass) {
            throw new Error(`Unknown algorithm: ${name}`);
        }
        
        return new AlgorithmClass(config);
    }

    /**
     * List available algorithms
     */
    list() {
        return Array.from(this.algorithms.keys());
    }

    /**
     * Get algorithm info
     */
    getInfo(name) {
        const algorithm = this.create(name);
        const info = algorithm.getInfo();
        algorithm.cleanup();
        return info;
    }
}

// Global algorithm registry
export const algorithmRegistry = new AlgorithmRegistry();

export default MiningAlgorithm;