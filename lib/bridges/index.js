/**
 * Cross-chain Bridge Module for Otedama
 * Unified interface for cross-chain asset transfers
 */

import { EventEmitter } from 'events';
import { BridgeCore } from './bridge-core.js';
import { TokenWrapper } from './token-wrapper.js';
import { BridgeValidator } from './bridge-validator.js';
import { getLogger } from '../core/logger.js';

export class BridgeManager extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Enable/disable components
            enableBridge: config.enableBridge !== false,
            enableWrapper: config.enableWrapper !== false,
            enableValidators: config.enableValidators !== false,
            
            // Validator configuration
            validatorCount: config.validatorCount || 5,
            minValidatorSignatures: config.minValidatorSignatures || 3,
            
            ...config
        };
        
        this.logger = getLogger('BridgeManager');
        
        // Components
        this.bridgeCore = null;
        this.tokenWrapper = null;
        this.validators = [];
        
        // Statistics
        this.stats = {
            totalBridgeTransactions: 0,
            totalWrappedTokens: 0,
            totalVolume: {},
            successRate: 100
        };
        
        this.isRunning = false;
    }
    
    /**
     * Start bridge manager
     */
    async start() {
        if (this.isRunning) return;
        
        this.logger.info('Starting bridge manager...');
        
        // Initialize bridge core
        if (this.config.enableBridge) {
            this.bridgeCore = new BridgeCore(this.config.bridge);
            await this.bridgeCore.start();
            this.setupBridgeListeners();
        }
        
        // Initialize token wrapper
        if (this.config.enableWrapper) {
            this.tokenWrapper = new TokenWrapper(this.config.wrapper);
            await this.tokenWrapper.start();
            this.setupWrapperListeners();
        }
        
        // Initialize validators
        if (this.config.enableValidators) {
            await this.initializeValidators();
        }
        
        // Start monitoring
        this.startMonitoring();
        
        this.isRunning = true;
        this.logger.info('Bridge manager started');
    }
    
    /**
     * Initialize validators
     */
    async initializeValidators() {
        this.logger.info(`Initializing ${this.config.validatorCount} validators...`);
        
        for (let i = 0; i < this.config.validatorCount; i++) {
            const validator = new BridgeValidator({
                name: `Validator-${i + 1}`,
                validatorAddress: `0xvalidator${i + 1}`,
                ...this.config.validatorConfig
            });
            
            // Mock staking for validators
            await validator.stakeTokens(100000);
            
            // Start validator
            await validator.start();
            
            // Add to bridge core
            if (this.bridgeCore) {
                this.bridgeCore.addValidator(validator);
            }
            
            this.validators.push(validator);
            this.setupValidatorListeners(validator);
        }
        
        this.logger.info('Validators initialized');
    }
    
    /**
     * Setup event listeners
     */
    setupBridgeListeners() {
        this.bridgeCore.on('bridge-initiated', (data) => {
            this.stats.totalBridgeTransactions++;
            this.emit('bridge-initiated', data);
        });
        
        this.bridgeCore.on('bridge-completed', (data) => {
            this.updateVolumeStats(data);
            this.emit('bridge-completed', data);
        });
        
        this.bridgeCore.on('bridge-failed', (data) => {
            this.updateSuccessRate(false);
            this.emit('bridge-failed', data);
        });
    }
    
    setupWrapperListeners() {
        this.tokenWrapper.on('tokens-wrapped', (data) => {
            this.stats.totalWrappedTokens++;
            this.emit('tokens-wrapped', data);
        });
        
        this.tokenWrapper.on('tokens-unwrapped', (data) => {
            this.emit('tokens-unwrapped', data);
        });
        
        this.tokenWrapper.on('collateral-warning', (data) => {
            this.logger.warn('Collateral warning:', data);
            this.emit('collateral-warning', data);
        });
    }
    
    setupValidatorListeners(validator) {
        validator.on('validation-complete', (data) => {
            this.emit('validation-complete', {
                validator: validator.config.name,
                ...data
            });
        });
        
        validator.on('health-warning', (data) => {
            this.logger.warn(`Validator health warning:`, data);
            this.emit('validator-health-warning', data);
        });
    }
    
    /**
     * Bridge assets between chains
     */
    async bridgeAssets(params) {
        if (!this.bridgeCore) {
            throw new Error('Bridge is not enabled');
        }
        
        const {
            userId,
            fromChain,
            toChain,
            asset,
            amount,
            toAddress
        } = params;
        
        // Validate parameters
        this.validateBridgeParams(params);
        
        // Check if wrapping is needed
        const needsWrapping = this.needsWrapping(asset, fromChain, toChain);
        
        try {
            // Initiate bridge
            const bridgeResult = await this.bridgeCore.initiateBridge({
                userId,
                fromChain,
                toChain,
                asset,
                amount,
                toAddress,
                metadata: {
                    needsWrapping,
                    initiatedAt: Date.now()
                }
            });
            
            this.logger.info('Bridge initiated:', bridgeResult);
            
            return {
                ...bridgeResult,
                needsWrapping,
                instructions: this.getBridgeInstructions(fromChain, bridgeResult.depositAddress)
            };
            
        } catch (error) {
            this.logger.error('Bridge initiation failed:', error);
            this.updateSuccessRate(false);
            throw error;
        }
    }
    
    /**
     * Get bridge status
     */
    getBridgeStatus(bridgeId) {
        if (!this.bridgeCore) {
            throw new Error('Bridge is not enabled');
        }
        
        return this.bridgeCore.getBridgeStatus(bridgeId);
    }
    
    /**
     * Get supported chains and assets
     */
    getSupportedRoutes() {
        const routes = {
            chains: [],
            assets: {},
            routes: []
        };
        
        if (this.bridgeCore) {
            routes.chains = this.bridgeCore.getSupportedChains();
        }
        
        if (this.tokenWrapper) {
            // Get wrapped assets
            for (const [asset, chainMap] of this.tokenWrapper.wrappedTokens) {
                routes.assets[asset] = [];
                
                for (const [chain, token] of chainMap) {
                    routes.assets[asset].push({
                        chain,
                        symbol: token.symbol,
                        contractAddress: token.contractAddress
                    });
                }
            }
        }
        
        // Generate all possible routes
        for (const fromChain of routes.chains) {
            for (const toChain of routes.chains) {
                if (fromChain.chainId !== toChain.chainId) {
                    routes.routes.push({
                        from: fromChain.chainId,
                        to: toChain.chainId,
                        estimatedTime: this.estimateBridgeTime(fromChain, toChain),
                        fee: 0.003 // 0.3%
                    });
                }
            }
        }
        
        return routes;
    }
    
    /**
     * Get bridge statistics
     */
    getStatistics() {
        const stats = {
            ...this.stats,
            bridgeCore: this.bridgeCore ? this.bridgeCore.getStatistics() : null,
            tokenWrapper: this.tokenWrapper ? this.tokenWrapper.getStatistics() : null,
            validators: this.getValidatorStats()
        };
        
        return stats;
    }
    
    /**
     * Get validator statistics
     */
    getValidatorStats() {
        const stats = {
            totalValidators: this.validators.length,
            activeValidators: 0,
            totalValidations: 0,
            averageReputation: 0
        };
        
        let totalReputation = 0;
        
        for (const validator of this.validators) {
            const info = validator.getValidatorInfo();
            
            if (info.isActive) {
                stats.activeValidators++;
            }
            
            stats.totalValidations += info.statistics.totalValidations;
            totalReputation += info.reputation;
        }
        
        stats.averageReputation = this.validators.length > 0 ? 
            totalReputation / this.validators.length : 0;
        
        return stats;
    }
    
    /**
     * Emergency pause
     */
    async emergencyPause(component = 'all') {
        this.logger.warn(`Emergency pause initiated for: ${component}`);
        
        if (component === 'all' || component === 'bridge') {
            // Pause bridge operations
            if (this.bridgeCore) {
                // Would implement pause in BridgeCore
                this.logger.info('Bridge operations paused');
            }
        }
        
        if (component === 'all' || component === 'wrapper') {
            // Pause token wrapping
            if (this.tokenWrapper) {
                this.tokenWrapper.emergencyPause();
            }
        }
        
        this.emit('emergency-pause', { component });
    }
    
    /**
     * Resume operations
     */
    async resume(component = 'all') {
        this.logger.info(`Resuming operations for: ${component}`);
        
        if (component === 'all' || component === 'bridge') {
            if (this.bridgeCore) {
                // Would implement resume in BridgeCore
                this.logger.info('Bridge operations resumed');
            }
        }
        
        if (component === 'all' || component === 'wrapper') {
            if (this.tokenWrapper) {
                this.tokenWrapper.resume();
            }
        }
        
        this.emit('operations-resumed', { component });
    }
    
    /**
     * Helper functions
     */
    validateBridgeParams(params) {
        const required = ['userId', 'fromChain', 'toChain', 'asset', 'amount', 'toAddress'];
        
        for (const field of required) {
            if (!params[field]) {
                throw new Error(`Missing required field: ${field}`);
            }
        }
        
        if (params.amount <= 0) {
            throw new Error('Amount must be positive');
        }
        
        if (params.fromChain === params.toChain) {
            throw new Error('Cannot bridge to same chain');
        }
    }
    
    needsWrapping(asset, fromChain, toChain) {
        // Check if asset needs to be wrapped on destination chain
        if (!this.tokenWrapper) return false;
        
        const wrappedToken = this.tokenWrapper.getWrappedToken(asset, toChain);
        return wrappedToken !== null;
    }
    
    getBridgeInstructions(chain, depositAddress) {
        const instructions = {
            BTC: `Send BTC to address: ${depositAddress}. Minimum 6 confirmations required.`,
            ETH: `Send tokens to address: ${depositAddress}. Minimum 12 confirmations required.`,
            BSC: `Send tokens to address: ${depositAddress}. Minimum 15 confirmations required.`,
            POLYGON: `Send tokens to address: ${depositAddress}. Minimum 30 confirmations required.`
        };
        
        return instructions[chain] || 'Send tokens to the deposit address and wait for confirmations.';
    }
    
    estimateBridgeTime(fromChain, toChain) {
        // Simple estimation based on confirmation requirements
        const confirmationTime = {
            BTC: 60 * 60 * 1000, // 1 hour
            ETH: 3 * 60 * 1000, // 3 minutes
            BSC: 75 * 1000, // 75 seconds
            POLYGON: 60 * 1000 // 1 minute
        };
        
        const fromTime = confirmationTime[fromChain.chainId] || 5 * 60 * 1000;
        const toTime = 60 * 1000; // 1 minute for destination
        
        return fromTime + toTime;
    }
    
    updateVolumeStats(bridgeData) {
        const { asset, amount } = bridgeData;
        
        if (!this.stats.totalVolume[asset]) {
            this.stats.totalVolume[asset] = 0;
        }
        
        this.stats.totalVolume[asset] += amount;
    }
    
    updateSuccessRate(success) {
        const total = this.stats.totalBridgeTransactions;
        if (total === 0) return;
        
        if (success) {
            const currentSuccessful = (this.stats.successRate / 100) * (total - 1);
            this.stats.successRate = ((currentSuccessful + 1) / total) * 100;
        } else {
            const currentSuccessful = (this.stats.successRate / 100) * (total - 1);
            this.stats.successRate = (currentSuccessful / total) * 100;
        }
    }
    
    /**
     * Start monitoring
     */
    startMonitoring() {
        // Monitor bridge health
        setInterval(() => {
            this.checkBridgeHealth();
        }, 60 * 1000); // Every minute
        
        // Monitor validator consensus
        setInterval(() => {
            this.checkValidatorConsensus();
        }, 30 * 1000); // Every 30 seconds
    }
    
    async checkBridgeHealth() {
        const health = {
            bridge: this.bridgeCore ? 'healthy' : 'disabled',
            wrapper: this.tokenWrapper ? 'healthy' : 'disabled',
            validators: `${this.getValidatorStats().activeValidators}/${this.validators.length} active`,
            successRate: this.stats.successRate
        };
        
        if (this.stats.successRate < 95) {
            this.logger.warn('Bridge success rate below threshold:', health);
            this.emit('health-warning', health);
        }
    }
    
    checkValidatorConsensus() {
        const validatorStats = this.getValidatorStats();
        
        if (validatorStats.activeValidators < this.config.minValidatorSignatures) {
            this.logger.error('Insufficient active validators for consensus');
            this.emit('consensus-warning', {
                active: validatorStats.activeValidators,
                required: this.config.minValidatorSignatures
            });
        }
    }
    
    /**
     * Stop bridge manager
     */
    async stop() {
        if (!this.isRunning) return;
        
        this.logger.info('Stopping bridge manager...');
        
        // Stop components
        if (this.bridgeCore) {
            await this.bridgeCore.stop();
        }
        
        if (this.tokenWrapper) {
            await this.tokenWrapper.stop();
        }
        
        // Stop validators
        for (const validator of this.validators) {
            await validator.stop();
        }
        
        this.isRunning = false;
        this.logger.info('Bridge manager stopped');
    }
}

// Export components
export { BridgeCore } from './bridge-core.js';
export { TokenWrapper } from './token-wrapper.js';
export { BridgeValidator } from './bridge-validator.js';

export default BridgeManager;