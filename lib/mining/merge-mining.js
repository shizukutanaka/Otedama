/**
 * Merge Mining Handler
 * Wrapper for MergeMiningManager with simplified interface
 */

import MergeMiningManager from './merge-mining/merge-mining-manager.js';
import { logger } from '../core/logger.js';

export class MergeMiningHandler {
    constructor(config = {}) {
        this.config = {
            enabled: config.enabled !== false,
            primaryChain: config.primaryChain || 'BTC',
            auxiliaryChains: config.auxiliaryChains || ['NMC', 'ELA'],
            rpcEndpoints: config.rpcEndpoints || {},
            ...config
        };
        
        this.manager = null;
        this.isRunning = false;
        this.chainClients = new Map();
    }
    
    /**
     * Start merge mining
     */
    async start() {
        if (!this.config.enabled) {
            logger.info('Merge mining is disabled');
            return;
        }
        
        if (this.isRunning) return;
        
        try {
            // Initialize manager
            this.manager = new MergeMiningManager({
                primaryChain: this.config.primaryChain,
                auxiliaryChains: this.config.auxiliaryChains
            });
            
            // Connect to blockchain nodes
            await this.connectToChains();
            
            this.isRunning = true;
            logger.info('Merge mining started');
            
        } catch (error) {
            logger.error('Failed to start merge mining:', error);
            throw error;
        }
    }
    
    /**
     * Connect to blockchain RPC endpoints
     */
    async connectToChains() {
        const rpcClients = {};
        
        // Create RPC clients for each configured chain
        for (const [chain, endpoint] of Object.entries(this.config.rpcEndpoints)) {
            if (endpoint) {
                // In production, would use actual RPC client library
                rpcClients[chain] = this.createRPCClient(endpoint);
            }
        }
        
        // Connect manager to chains
        await this.manager.connect(rpcClients);
    }
    
    /**
     * Create RPC client (mock for now)
     */
    createRPCClient(endpoint) {
        return {
            endpoint,
            getBlockchainInfo: async () => ({
                blocks: Math.floor(Math.random() * 800000),
                difficulty: Math.random() * 1e12
            }),
            getBlockTemplate: async () => ({
                previousblockhash: this.generateRandomHash(),
                coinbasevalue: 625000000,
                target: '00000000ffff0000000000000000000000000000000000000000000000000000',
                height: Math.floor(Math.random() * 800000),
                transactions: []
            }),
            submitBlock: async (block) => {
                logger.info('Block submitted to chain');
                return true;
            }
        };
    }
    
    /**
     * Create merged mining job
     */
    async createJob(primaryTemplate) {
        if (!this.manager || !this.isRunning) {
            throw new Error('Merge mining not running');
        }
        
        return await this.manager.createMergedJob(primaryTemplate);
    }
    
    /**
     * Process share for merge mining
     */
    async processShare(share, job) {
        if (!this.manager || !this.isRunning) {
            return { primary: false, auxiliary: new Map() };
        }
        
        return await this.manager.processShare(share, job);
    }
    
    /**
     * Get merge mining statistics
     */
    getStats() {
        if (!this.manager) {
            return {
                enabled: false,
                chains: {},
                totalBlocks: 0
            };
        }
        
        return {
            enabled: this.config.enabled,
            isRunning: this.isRunning,
            ...this.manager.getStats()
        };
    }
    
    /**
     * Shutdown merge mining
     */
    async shutdown() {
        if (!this.isRunning) return;
        
        this.isRunning = false;
        
        if (this.manager) {
            await this.manager.shutdown();
            this.manager = null;
        }
        
        logger.info('Merge mining stopped');
    }
    
    /**
     * Utility method to generate random hash
     */
    generateRandomHash() {
        const chars = '0123456789abcdef';
        let hash = '';
        for (let i = 0; i < 64; i++) {
            hash += chars[Math.floor(Math.random() * 16)];
        }
        return hash;
    }
}

export default MergeMiningHandler;