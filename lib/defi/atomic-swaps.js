/**
 * Cross-Chain Atomic Swaps for Otedama
 * Trustless cross-chain trading using HTLC (Hash Time-Locked Contracts)
 * 
 * Design principles:
 * - Fast atomic execution (Carmack)
 * - Clean swap protocol (Martin)
 * - Simple cross-chain logic (Pike)
 */

import { EventEmitter } from 'events';
import { logger } from '../core/logger.js';
import crypto from 'crypto';

export class AtomicSwapManager extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Swap settings
            defaultLockTime: config.defaultLockTime || 3600000, // 1 hour
            minLockTime: config.minLockTime || 600000, // 10 minutes
            maxLockTime: config.maxLockTime || 86400000, // 24 hours
            
            // Fee settings
            swapFee: config.swapFee || 0.003, // 0.3%
            minSwapValue: config.minSwapValue || 100, // $100 minimum
            
            // Security settings
            confirmationBlocks: config.confirmationBlocks || {
                ETH: 12,
                BTC: 3,
                BNB: 15,
                MATIC: 100
            },
            
            // Network settings
            supportedChains: config.supportedChains || ['ETH', 'BTC', 'BNB', 'MATIC'],
            rpcEndpoints: config.rpcEndpoints || {},
            
            // Monitoring
            checkInterval: config.checkInterval || 30000, // 30 seconds
            retryAttempts: config.retryAttempts || 3,
            retryDelay: config.retryDelay || 5000,
            
            ...config
        };
        
        // Swap registry
        this.swaps = new Map(); // swapId -> SwapData
        this.userSwaps = new Map(); // userId -> Set<swapId>
        
        // Chain adapters
        this.chainAdapters = new Map(); // chainId -> ChainAdapter
        
        // Pending operations
        this.pendingLocks = new Map(); // lockId -> PendingLock
        this.pendingRedeems = new Map(); // redeemId -> PendingRedeem
        
        // Statistics
        this.stats = {
            totalSwaps: 0,
            completedSwaps: 0,
            failedSwaps: 0,
            totalVolume: {},
            averageSwapTime: 0,
            activeSwaps: 0
        };
        
        // Start monitoring
        this.startMonitoring();
    }
    
    /**
     * Register chain adapter
     */
    registerChainAdapter(chainId, adapter) {
        if (!this.config.supportedChains.includes(chainId)) {
            throw new Error(`Chain ${chainId} not supported`);
        }
        
        // Validate adapter interface
        const requiredMethods = [
            'createHTLC',
            'lockFunds',
            'redeemFunds',
            'refundFunds',
            'getHTLCState',
            'verifyTransaction'
        ];
        
        for (const method of requiredMethods) {
            if (typeof adapter[method] !== 'function') {
                throw new Error(`Chain adapter missing required method: ${method}`);
            }
        }
        
        this.chainAdapters.set(chainId, adapter);
        logger.info(`Chain adapter registered: ${chainId}`);
    }
    
    /**
     * Initiate atomic swap
     */
    async initiateSwap(params) {
        const {
            userId,
            fromChain,
            toChain,
            fromAsset,
            toAsset,
            fromAmount,
            expectedToAmount,
            counterpartyAddress,
            lockTime
        } = params;
        
        // Validate chains
        if (!this.chainAdapters.has(fromChain) || !this.chainAdapters.has(toChain)) {
            throw new Error('Chain not supported');
        }
        
        // Validate amounts
        const fromValue = await this.getAssetValue(fromChain, fromAsset, fromAmount);
        if (fromValue < this.config.minSwapValue) {
            throw new Error(`Minimum swap value is $${this.config.minSwapValue}`);
        }
        
        // Generate swap secret
        const secret = crypto.randomBytes(32);
        const secretHash = crypto.createHash('sha256').update(secret).digest('hex');
        
        // Calculate lock times
        const initiatorLockTime = lockTime || this.config.defaultLockTime;
        const counterpartyLockTime = initiatorLockTime / 2; // Half time for counterparty
        
        // Validate lock times
        if (initiatorLockTime < this.config.minLockTime || initiatorLockTime > this.config.maxLockTime) {
            throw new Error('Invalid lock time');
        }
        
        // Create swap data
        const swapId = this.generateSwapId();
        const swap = {
            id: swapId,
            userId,
            role: 'initiator',
            status: 'pending',
            
            // Chain data
            fromChain,
            toChain,
            
            // Asset data
            fromAsset,
            toAsset,
            fromAmount,
            expectedToAmount,
            
            // HTLC data
            secret: secret.toString('hex'),
            secretHash,
            
            // Addresses
            initiatorAddress: userId, // Simplified, would be chain-specific
            counterpartyAddress,
            
            // Lock times
            initiatorLockTime,
            counterpartyLockTime,
            lockExpiry: Date.now() + initiatorLockTime,
            
            // Transaction data
            initiatorLockTx: null,
            counterpartyLockTx: null,
            initiatorRedeemTx: null,
            counterpartyRedeemTx: null,
            
            // Timestamps
            createdAt: Date.now(),
            completedAt: null
        };
        
        // Store swap
        this.swaps.set(swapId, swap);
        if (!this.userSwaps.has(userId)) {
            this.userSwaps.set(userId, new Set());
        }
        this.userSwaps.get(userId).add(swapId);
        
        // Update stats
        this.stats.totalSwaps++;
        this.stats.activeSwaps++;
        
        logger.info(`Atomic swap initiated: ${swapId}`);
        
        this.emit('swap:initiated', {
            swap,
            timestamp: Date.now()
        });
        
        // Create HTLC contract
        await this.createInitiatorHTLC(swap);
        
        return {
            swapId,
            secretHash,
            lockTime: initiatorLockTime,
            counterpartyLockTime
        };
    }
    
    /**
     * Accept atomic swap as counterparty
     */
    async acceptSwap(params) {
        const {
            userId,
            swapId,
            secretHash,
            fromChain,
            toChain,
            fromAsset,
            toAsset,
            fromAmount,
            toAmount,
            initiatorAddress,
            lockTime
        } = params;
        
        // Validate chains
        if (!this.chainAdapters.has(fromChain) || !this.chainAdapters.has(toChain)) {
            throw new Error('Chain not supported');
        }
        
        // Create counterparty swap data
        const swap = {
            id: swapId,
            userId,
            role: 'counterparty',
            status: 'pending',
            
            // Chain data (reversed for counterparty)
            fromChain: toChain,
            toChain: fromChain,
            
            // Asset data (reversed for counterparty)
            fromAsset: toAsset,
            toAsset: fromAsset,
            fromAmount: toAmount,
            expectedToAmount: fromAmount,
            
            // HTLC data
            secret: null, // Unknown to counterparty
            secretHash,
            
            // Addresses
            initiatorAddress,
            counterpartyAddress: userId,
            
            // Lock times
            initiatorLockTime: lockTime * 2, // Double time for initiator
            counterpartyLockTime: lockTime,
            lockExpiry: Date.now() + lockTime,
            
            // Transaction data
            initiatorLockTx: null,
            counterpartyLockTx: null,
            initiatorRedeemTx: null,
            counterpartyRedeemTx: null,
            
            // Timestamps
            createdAt: Date.now(),
            completedAt: null
        };
        
        // Store swap
        this.swaps.set(swapId, swap);
        if (!this.userSwaps.has(userId)) {
            this.userSwaps.set(userId, new Set());
        }
        this.userSwaps.get(userId).add(swapId);
        
        // Update stats
        this.stats.totalSwaps++;
        this.stats.activeSwaps++;
        
        logger.info(`Atomic swap accepted: ${swapId}`);
        
        this.emit('swap:accepted', {
            swap,
            timestamp: Date.now()
        });
        
        // Create counterparty HTLC
        await this.createCounterpartyHTLC(swap);
        
        return {
            swapId,
            status: 'accepted'
        };
    }
    
    /**
     * Create initiator HTLC and lock funds
     */
    async createInitiatorHTLC(swap) {
        try {
            const adapter = this.chainAdapters.get(swap.fromChain);
            
            // Create HTLC contract
            const htlcAddress = await adapter.createHTLC({
                secretHash: swap.secretHash,
                recipient: swap.counterpartyAddress,
                refundAddress: swap.initiatorAddress,
                lockTime: swap.initiatorLockTime,
                asset: swap.fromAsset
            });
            
            swap.initiatorHTLCAddress = htlcAddress;
            
            // Lock funds
            const lockTx = await adapter.lockFunds({
                htlcAddress,
                amount: swap.fromAmount,
                asset: swap.fromAsset,
                from: swap.initiatorAddress
            });
            
            swap.initiatorLockTx = lockTx;
            swap.status = 'locked_initiator';
            
            // Add to monitoring
            this.pendingLocks.set(lockTx.hash, {
                swapId: swap.id,
                chain: swap.fromChain,
                type: 'initiator',
                confirmations: 0,
                requiredConfirmations: this.config.confirmationBlocks[swap.fromChain]
            });
            
            logger.info(`Initiator HTLC created: ${swap.id}, tx: ${lockTx.hash}`);
            
            this.emit('htlc:created', {
                swapId: swap.id,
                type: 'initiator',
                htlcAddress,
                lockTx,
                timestamp: Date.now()
            });
            
        } catch (error) {
            swap.status = 'failed';
            swap.error = error.message;
            this.stats.failedSwaps++;
            this.stats.activeSwaps--;
            
            logger.error(`Failed to create initiator HTLC: ${swap.id}`, error);
            
            this.emit('swap:failed', {
                swapId: swap.id,
                error: error.message,
                timestamp: Date.now()
            });
            
            throw error;
        }
    }
    
    /**
     * Create counterparty HTLC after verifying initiator lock
     */
    async createCounterpartyHTLC(swap) {
        try {
            // Wait for initiator lock confirmation
            await this.waitForLockConfirmation(swap.id, 'initiator');
            
            const adapter = this.chainAdapters.get(swap.fromChain);
            
            // Create HTLC contract
            const htlcAddress = await adapter.createHTLC({
                secretHash: swap.secretHash,
                recipient: swap.initiatorAddress,
                refundAddress: swap.counterpartyAddress,
                lockTime: swap.counterpartyLockTime,
                asset: swap.fromAsset
            });
            
            swap.counterpartyHTLCAddress = htlcAddress;
            
            // Lock funds
            const lockTx = await adapter.lockFunds({
                htlcAddress,
                amount: swap.fromAmount,
                asset: swap.fromAsset,
                from: swap.counterpartyAddress
            });
            
            swap.counterpartyLockTx = lockTx;
            swap.status = 'locked_both';
            
            // Add to monitoring
            this.pendingLocks.set(lockTx.hash, {
                swapId: swap.id,
                chain: swap.fromChain,
                type: 'counterparty',
                confirmations: 0,
                requiredConfirmations: this.config.confirmationBlocks[swap.fromChain]
            });
            
            logger.info(`Counterparty HTLC created: ${swap.id}, tx: ${lockTx.hash}`);
            
            this.emit('htlc:created', {
                swapId: swap.id,
                type: 'counterparty',
                htlcAddress,
                lockTx,
                timestamp: Date.now()
            });
            
        } catch (error) {
            swap.status = 'failed';
            swap.error = error.message;
            this.stats.failedSwaps++;
            this.stats.activeSwaps--;
            
            logger.error(`Failed to create counterparty HTLC: ${swap.id}`, error);
            
            this.emit('swap:failed', {
                swapId: swap.id,
                error: error.message,
                timestamp: Date.now()
            });
            
            throw error;
        }
    }
    
    /**
     * Redeem funds using secret
     */
    async redeemFunds(swapId, secret, isInitiator = true) {
        const swap = this.swaps.get(swapId);
        if (!swap) {
            throw new Error('Swap not found');
        }
        
        // Verify secret
        const secretHash = crypto.createHash('sha256').update(Buffer.from(secret, 'hex')).digest('hex');
        if (secretHash !== swap.secretHash) {
            throw new Error('Invalid secret');
        }
        
        try {
            if (isInitiator) {
                // Initiator redeems from counterparty HTLC
                await this.waitForLockConfirmation(swapId, 'counterparty');
                
                const adapter = this.chainAdapters.get(swap.toChain);
                const redeemTx = await adapter.redeemFunds({
                    htlcAddress: swap.counterpartyHTLCAddress,
                    secret,
                    recipient: swap.initiatorAddress
                });
                
                swap.initiatorRedeemTx = redeemTx;
                swap.secret = secret; // Store revealed secret
                
                logger.info(`Initiator redeemed: ${swapId}, tx: ${redeemTx.hash}`);
                
                this.emit('funds:redeemed', {
                    swapId,
                    type: 'initiator',
                    redeemTx,
                    timestamp: Date.now()
                });
                
            } else {
                // Counterparty redeems from initiator HTLC
                const adapter = this.chainAdapters.get(swap.toChain);
                const redeemTx = await adapter.redeemFunds({
                    htlcAddress: swap.initiatorHTLCAddress,
                    secret,
                    recipient: swap.counterpartyAddress
                });
                
                swap.counterpartyRedeemTx = redeemTx;
                
                logger.info(`Counterparty redeemed: ${swapId}, tx: ${redeemTx.hash}`);
                
                this.emit('funds:redeemed', {
                    swapId,
                    type: 'counterparty',
                    redeemTx,
                    timestamp: Date.now()
                });
            }
            
            // Check if swap is complete
            if (swap.initiatorRedeemTx && swap.counterpartyRedeemTx) {
                swap.status = 'completed';
                swap.completedAt = Date.now();
                this.stats.completedSwaps++;
                this.stats.activeSwaps--;
                
                // Update average swap time
                const swapTime = swap.completedAt - swap.createdAt;
                this.stats.averageSwapTime = 
                    (this.stats.averageSwapTime * (this.stats.completedSwaps - 1) + swapTime) / 
                    this.stats.completedSwaps;
                
                logger.info(`Swap completed: ${swapId}`);
                
                this.emit('swap:completed', {
                    swap,
                    duration: swapTime,
                    timestamp: Date.now()
                });
            }
            
        } catch (error) {
            logger.error(`Failed to redeem funds: ${swapId}`, error);
            throw error;
        }
    }
    
    /**
     * Refund locked funds after timeout
     */
    async refundFunds(swapId, isInitiator = true) {
        const swap = this.swaps.get(swapId);
        if (!swap) {
            throw new Error('Swap not found');
        }
        
        // Check if refund is allowed
        const lockExpiry = isInitiator ? 
            swap.createdAt + swap.initiatorLockTime :
            swap.createdAt + swap.counterpartyLockTime;
            
        if (Date.now() < lockExpiry) {
            throw new Error('Lock time not expired');
        }
        
        try {
            const chain = isInitiator ? swap.fromChain : swap.toChain;
            const adapter = this.chainAdapters.get(chain);
            const htlcAddress = isInitiator ? 
                swap.initiatorHTLCAddress : 
                swap.counterpartyHTLCAddress;
            
            const refundTx = await adapter.refundFunds({
                htlcAddress,
                refundAddress: isInitiator ? swap.initiatorAddress : swap.counterpartyAddress
            });
            
            swap.status = 'refunded';
            swap[isInitiator ? 'initiatorRefundTx' : 'counterpartyRefundTx'] = refundTx;
            
            this.stats.failedSwaps++;
            this.stats.activeSwaps--;
            
            logger.info(`Funds refunded: ${swapId}, tx: ${refundTx.hash}`);
            
            this.emit('funds:refunded', {
                swapId,
                type: isInitiator ? 'initiator' : 'counterparty',
                refundTx,
                timestamp: Date.now()
            });
            
        } catch (error) {
            logger.error(`Failed to refund funds: ${swapId}`, error);
            throw error;
        }
    }
    
    /**
     * Extract secret from blockchain transaction
     */
    async extractSecret(swapId) {
        const swap = this.swaps.get(swapId);
        if (!swap) {
            throw new Error('Swap not found');
        }
        
        // Only counterparty needs to extract secret
        if (swap.role !== 'counterparty') {
            throw new Error('Only counterparty can extract secret');
        }
        
        try {
            // Monitor initiator's redeem transaction
            const adapter = this.chainAdapters.get(swap.toChain);
            const htlcState = await adapter.getHTLCState(swap.counterpartyHTLCAddress);
            
            if (htlcState.redeemed && htlcState.secret) {
                swap.secret = htlcState.secret;
                
                logger.info(`Secret extracted: ${swapId}`);
                
                this.emit('secret:extracted', {
                    swapId,
                    secret: htlcState.secret,
                    timestamp: Date.now()
                });
                
                // Automatically redeem counterparty funds
                await this.redeemFunds(swapId, htlcState.secret, false);
                
                return htlcState.secret;
            }
            
            throw new Error('Secret not yet revealed');
            
        } catch (error) {
            logger.error(`Failed to extract secret: ${swapId}`, error);
            throw error;
        }
    }
    
    /**
     * Helper methods
     */
    
    async waitForLockConfirmation(swapId, type) {
        const swap = this.swaps.get(swapId);
        if (!swap) {
            throw new Error('Swap not found');
        }
        
        const txHash = type === 'initiator' ? 
            swap.initiatorLockTx?.hash : 
            swap.counterpartyLockTx?.hash;
            
        if (!txHash) {
            throw new Error(`${type} lock transaction not found`);
        }
        
        const pendingLock = this.pendingLocks.get(txHash);
        if (!pendingLock) {
            throw new Error('Pending lock not found');
        }
        
        // Wait for confirmations
        const maxWaitTime = 600000; // 10 minutes
        const startTime = Date.now();
        
        while (pendingLock.confirmations < pendingLock.requiredConfirmations) {
            if (Date.now() - startTime > maxWaitTime) {
                throw new Error('Lock confirmation timeout');
            }
            
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
        
        return true;
    }
    
    async getAssetValue(chain, asset, amount) {
        // Simplified - in production would use price oracles
        const prices = {
            'ETH': 3000,
            'BTC': 50000,
            'BNB': 400,
            'MATIC': 1,
            'USDT': 1,
            'USDC': 1
        };
        
        return amount * (prices[asset] || 0);
    }
    
    generateSwapId() {
        return `SWAP${Date.now()}${Math.random().toString(36).substr(2, 9)}`;
    }
    
    /**
     * Monitoring loop
     */
    startMonitoring() {
        this.monitoringInterval = setInterval(async () => {
            // Check pending locks
            for (const [txHash, pendingLock] of this.pendingLocks) {
                try {
                    const chain = pendingLock.chain;
                    const adapter = this.chainAdapters.get(chain);
                    
                    const txStatus = await adapter.verifyTransaction(txHash);
                    pendingLock.confirmations = txStatus.confirmations;
                    
                    if (pendingLock.confirmations >= pendingLock.requiredConfirmations) {
                        this.pendingLocks.delete(txHash);
                        
                        logger.info(`Lock confirmed: ${txHash}, confirmations: ${pendingLock.confirmations}`);
                        
                        this.emit('lock:confirmed', {
                            swapId: pendingLock.swapId,
                            type: pendingLock.type,
                            txHash,
                            timestamp: Date.now()
                        });
                    }
                } catch (error) {
                    logger.error(`Error monitoring lock ${txHash}:`, error);
                }
            }
            
            // Check for expired swaps
            for (const [swapId, swap] of this.swaps) {
                if (swap.status === 'pending' || swap.status.startsWith('locked_')) {
                    if (Date.now() > swap.lockExpiry) {
                        // Trigger refund process
                        this.emit('swap:expired', {
                            swapId,
                            timestamp: Date.now()
                        });
                    }
                }
            }
            
            // Clean up completed swaps
            const cutoff = Date.now() - 86400000; // 24 hours
            for (const [swapId, swap] of this.swaps) {
                if (swap.completedAt && swap.completedAt < cutoff) {
                    this.swaps.delete(swapId);
                }
            }
            
        }, this.config.checkInterval);
        
        logger.info('Atomic swap monitoring started');
    }
    
    /**
     * Stop monitoring
     */
    stop() {
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
        }
        
        logger.info('Atomic swap monitoring stopped');
    }
    
    /**
     * Get swap status
     */
    getSwapStatus(swapId) {
        const swap = this.swaps.get(swapId);
        if (!swap) {
            return null;
        }
        
        return {
            id: swap.id,
            status: swap.status,
            role: swap.role,
            fromChain: swap.fromChain,
            toChain: swap.toChain,
            fromAsset: swap.fromAsset,
            toAsset: swap.toAsset,
            fromAmount: swap.fromAmount,
            expectedToAmount: swap.expectedToAmount,
            secretHash: swap.secretHash,
            lockExpiry: swap.lockExpiry,
            initiatorLockTx: swap.initiatorLockTx?.hash,
            counterpartyLockTx: swap.counterpartyLockTx?.hash,
            initiatorRedeemTx: swap.initiatorRedeemTx?.hash,
            counterpartyRedeemTx: swap.counterpartyRedeemTx?.hash,
            createdAt: swap.createdAt,
            completedAt: swap.completedAt
        };
    }
    
    /**
     * Get user swaps
     */
    getUserSwaps(userId) {
        const swapIds = this.userSwaps.get(userId);
        if (!swapIds) {
            return [];
        }
        
        return Array.from(swapIds)
            .map(id => this.getSwapStatus(id))
            .filter(s => s !== null)
            .sort((a, b) => b.createdAt - a.createdAt);
    }
    
    /**
     * Get statistics
     */
    getStats() {
        return {
            ...this.stats,
            pendingLocks: this.pendingLocks.size,
            chains: Array.from(this.chainAdapters.keys()),
            timestamp: Date.now()
        };
    }
}

export default AtomicSwapManager;