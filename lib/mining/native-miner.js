/**
 * Native Miner Wrapper
 * Provides JavaScript interface to native mining implementation
 */

import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Try to load native addon
let nativeAddon = null;
try {
    // In production, the native addon would be built and available
    nativeAddon = await import('../../native/build/Release/otedama_native.node');
} catch (error) {
    console.warn('Native mining addon not available. Using fallback implementation.');
}

/**
 * Native Miner class
 * Wraps the C++ mining implementation
 */
export class NativeMiner extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.options = {
            algorithm: options.algorithm || 'sha256',
            threads: options.threads || 0, // 0 = auto-detect
            hardware: options.hardware || 'cpu',
            deviceId: options.deviceId || 0,
            ...options
        };
        
        this.nativeMiner = null;
        this.pollInterval = null;
        this.isRunning = false;
        this.stats = {
            hashrate: 0,
            totalHashes: 0,
            shares: {
                accepted: 0,
                rejected: 0,
                stale: 0
            },
            temperature: 0,
            power: 0
        };
    }
    
    /**
     * Initialize the miner
     */
    async initialize() {
        if (!nativeAddon) {
            throw new Error('Native mining not available. Please build the native addon.');
        }
        
        try {
            // Create native miner instance
            this.nativeMiner = new nativeAddon.NativeMiner();
            
            // Map hardware type
            const hardwareMap = {
                'cpu': nativeAddon.HardwareType.CPU,
                'gpu': nativeAddon.HardwareType.GPU_NVIDIA,
                'nvidia': nativeAddon.HardwareType.GPU_NVIDIA,
                'amd': nativeAddon.HardwareType.GPU_AMD
            };
            
            const hwType = hardwareMap[this.options.hardware.toLowerCase()] || nativeAddon.HardwareType.CPU;
            
            // Initialize with hardware
            const success = this.nativeMiner.initialize(hwType, this.options.deviceId);
            if (!success) {
                throw new Error('Failed to initialize native miner');
            }
            
            // Set algorithm
            const algoMap = {
                'sha256': nativeAddon.Algorithm.SHA256,
                'scrypt': nativeAddon.Algorithm.SCRYPT,
                'ethash': nativeAddon.Algorithm.ETHASH,
                'randomx': nativeAddon.Algorithm.RANDOMX,
                'kawpow': nativeAddon.Algorithm.KAWPOW
            };
            
            const algo = algoMap[this.options.algorithm.toLowerCase()];
            if (algo !== undefined) {
                this.nativeMiner.setAlgorithm(algo);
            }
            
            // Set thread count
            if (this.options.threads > 0) {
                this.nativeMiner.setThreadCount(this.options.threads);
            }
            
            // Get hardware info
            const hwInfo = this.nativeMiner.getHardwareInfo();
            this.emit('initialized', { hardware: hwInfo });
            
        } catch (error) {
            throw new Error(`Native miner initialization failed: ${error.message}`);
        }
    }
    
    /**
     * Start mining
     */
    async start(job) {
        if (!this.nativeMiner) {
            throw new Error('Miner not initialized');
        }
        
        if (this.isRunning) {
            throw new Error('Miner already running');
        }
        
        try {
            // Convert algorithm name to enum
            const algoMap = {
                'sha256': nativeAddon.Algorithm.SHA256,
                'scrypt': nativeAddon.Algorithm.SCRYPT,
                'ethash': nativeAddon.Algorithm.ETHASH,
                'randomx': nativeAddon.Algorithm.RANDOMX,
                'kawpow': nativeAddon.Algorithm.KAWPOW
            };
            
            // Prepare job for native miner
            const nativeJob = {
                jobId: job.id || job.jobId,
                blockHeader: job.blockHeader || job.header,
                target: job.target,
                nonceStart: job.nonceStart || 0,
                nonceEnd: job.nonceEnd || 0xFFFFFFFF,
                algorithm: algoMap[this.options.algorithm.toLowerCase()] || nativeAddon.Algorithm.SHA256
            };
            
            // Start mining
            const success = this.nativeMiner.startMining(nativeJob);
            if (!success) {
                throw new Error('Failed to start mining');
            }
            
            this.isRunning = true;
            this.emit('started', { job: job.id });
            
            // Start polling for results and stats
            this.startPolling();
            
        } catch (error) {
            throw new Error(`Failed to start mining: ${error.message}`);
        }
    }
    
    /**
     * Stop mining
     */
    async stop() {
        if (!this.nativeMiner || !this.isRunning) {
            return;
        }
        
        try {
            this.nativeMiner.stopMining();
            this.isRunning = false;
            this.stopPolling();
            this.emit('stopped');
        } catch (error) {
            throw new Error(`Failed to stop mining: ${error.message}`);
        }
    }
    
    /**
     * Get current stats
     */
    getStats() {
        if (!this.nativeMiner) {
            return this.stats;
        }
        
        try {
            this.stats.hashrate = this.nativeMiner.getHashrate();
            this.stats.totalHashes = this.nativeMiner.getTotalHashes();
            this.stats.temperature = this.nativeMiner.getTemperature();
            this.stats.power = this.nativeMiner.getPowerUsage();
        } catch (error) {
            console.error('Failed to get stats:', error);
        }
        
        return this.stats;
    }
    
    /**
     * Start polling for results and stats
     */
    startPolling() {
        this.pollInterval = setInterval(() => {
            if (!this.nativeMiner || !this.isRunning) {
                return;
            }
            
            // Check for mining results
            try {
                const result = this.nativeMiner.getResult();
                if (result) {
                    this.stats.shares.accepted++;
                    this.emit('share', {
                        jobId: result.jobId,
                        nonce: result.nonce,
                        hash: result.hash,
                        valid: result.valid,
                        hashrate: result.hashrate
                    });
                }
            } catch (error) {
                console.error('Failed to get result:', error);
            }
            
            // Update stats
            const stats = this.getStats();
            this.emit('stats', stats);
            
        }, 1000); // Poll every second
    }
    
    /**
     * Stop polling
     */
    stopPolling() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    }
    
    /**
     * Detect available hardware
     */
    static async detectHardware() {
        if (!nativeAddon) {
            return [];
        }
        
        try {
            const devices = nativeAddon.detectHardware();
            return devices.map(device => ({
                type: device.type === nativeAddon.HardwareType.CPU ? 'cpu' : 
                      device.type === nativeAddon.HardwareType.GPU_NVIDIA ? 'nvidia' :
                      device.type === nativeAddon.HardwareType.GPU_AMD ? 'amd' : 'unknown',
                name: device.name,
                id: device.deviceId,
                memory: device.memorySize,
                computeUnits: device.computeUnits,
                available: device.available
            }));
        } catch (error) {
            console.error('Hardware detection failed:', error);
            return [];
        }
    }
    
    /**
     * Clean up resources
     */
    async cleanup() {
        await this.stop();
        this.nativeMiner = null;
        this.removeAllListeners();
    }
}

/**
 * Create a native miner instance
 */
export async function createNativeMiner(options) {
    const miner = new NativeMiner(options);
    await miner.initialize();
    return miner;
}

/**
 * Check if native mining is available
 */
export function isNativeAvailable() {
    return nativeAddon !== null;
}

export default {
    NativeMiner,
    createNativeMiner,
    isNativeAvailable
};