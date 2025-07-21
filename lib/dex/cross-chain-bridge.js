/**
 * Cross-Chain Bridge for Otedama DEX
 * Enables trustless asset transfers between different blockchains
 * 
 * Design principles:
 * - Security-first approach with atomic swaps (Carmack's performance meets security)
 * - Clean interfaces for multiple chain support (Martin)
 * - Simple and reliable cross-chain protocol (Pike)
 */

import { EventEmitter } from 'events';
import { randomBytes, createHash } from 'crypto';
import { logger } from '../core/logger.js';

// Supported blockchain networks
export const SupportedChains = {
    BITCOIN: 'bitcoin',
    ETHEREUM: 'ethereum',
    BINANCE_SMART_CHAIN: 'bsc',
    POLYGON: 'polygon',
    AVALANCHE: 'avalanche',
    ARBITRUM: 'arbitrum',
    OPTIMISM: 'optimism',
    SOLANA: 'solana',
    POLKADOT: 'polkadot',
    COSMOS: 'cosmos'
};

// Bridge transfer states
const TransferStatus = {
    INITIATED: 'initiated',
    LOCKED: 'locked',
    CONFIRMED: 'confirmed',
    REDEEMED: 'redeemed',
    REFUNDED: 'refunded',
    FAILED: 'failed'
};

export class CrossChainBridge extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            confirmationBlocks: config.confirmationBlocks || {
                [SupportedChains.BITCOIN]: 6,
                [SupportedChains.ETHEREUM]: 12,
                [SupportedChains.BINANCE_SMART_CHAIN]: 15,
                default: 20
            },
            bridgeFees: config.bridgeFees || {
                [SupportedChains.BITCOIN]: 0.001,
                [SupportedChains.ETHEREUM]: 0.002,
                default: 0.0015
            },
            minTransferAmount: config.minTransferAmount || 0.001,
            maxTransferAmount: config.maxTransferAmount || 1000,
            atomicSwapTimeout: config.atomicSwapTimeout || 3600000, // 1 hour
            ...config
        };
        
        // Chain connectors
        this.chainConnectors = new Map(); // chainId -> connector
        
        // Active transfers
        this.transfers = new Map(); // transferId -> transfer
        this.userTransfers = new Map(); // userId -> Set of transferIds
        
        // Atomic swap contracts
        this.atomicSwaps = new Map(); // swapId -> swap
        
        // Liquidity pools for instant swaps
        this.liquidityPools = new Map(); // poolId -> pool
        
        // Statistics
        this.stats = {
            totalTransfers: 0,
            totalVolume: 0,
            successfulTransfers: 0,
            failedTransfers: 0,
            avgTransferTime: 0,
            chainVolumes: new Map()
        };
        
        // Start monitoring
        this.startMonitoring();
    }
    
    /**
     * Register chain connector
     */
    registerChainConnector(chainId, connector) {
        if (!connector.getBalance || !connector.sendTransaction || !connector.monitorAddress) {
            throw new Error('Invalid chain connector');
        }
        
        this.chainConnectors.set(chainId, {
            chainId,
            name: connector.name || chainId,
            type: connector.type,
            ...connector
        });
        
        logger.info(`Registered chain connector: ${chainId}`);
        
        this.emit('chain:registered', { chainId });
    }
    
    /**
     * Initiate cross-chain transfer
     */
    async initiateTransfer(params) {
        const {
            userId,
            fromChain,
            toChain,
            fromAsset,
            toAsset,
            amount,
            toAddress
        } = params;
        
        // Validate parameters
        const validation = this.validateTransfer(params);
        if (!validation.valid) {
            throw new Error(validation.reason);
        }
        
        // Check chain connectors
        if (!this.chainConnectors.has(fromChain) || !this.chainConnectors.has(toChain)) {
            throw new Error('Chain not supported');
        }
        
        // Generate transfer ID
        const transferId = this.generateTransferId();
        
        // Create transfer record
        const transfer = {
            id: transferId,
            userId,
            fromChain,
            toChain,
            fromAsset,
            toAsset,
            amount,
            toAddress,
            status: TransferStatus.INITIATED,
            createdAt: Date.now(),
            fee: this.calculateBridgeFee(fromChain, toChain, amount),
            estimatedTime: this.estimateTransferTime(fromChain, toChain),
            events: []
        };
        
        // Store transfer
        this.transfers.set(transferId, transfer);
        
        // Track user transfers
        if (!this.userTransfers.has(userId)) {
            this.userTransfers.set(userId, new Set());
        }
        this.userTransfers.get(userId).add(transferId);
        
        // Check if instant swap is available
        const instantSwap = this.checkInstantSwapAvailable(
            fromChain,
            toChain,
            fromAsset,
            toAsset,
            amount
        );
        
        if (instantSwap) {
            // Execute instant swap
            await this.executeInstantSwap(transfer);
        } else {
            // Create atomic swap
            await this.createAtomicSwap(transfer);
        }
        
        // Update stats
        this.stats.totalTransfers++;
        
        // Emit event
        this.emit('transfer:initiated', transfer);
        
        return transfer;
    }
    
    /**
     * Create atomic swap for trustless transfer
     */
    async createAtomicSwap(transfer) {
        // Generate secret and hash
        const secret = randomBytes(32);
        const secretHash = createHash('sha256').update(secret).digest('hex');
        
        // Calculate timeouts
        const now = Date.now();
        const lockTime = now + this.config.atomicSwapTimeout;
        const refundTime = lockTime + (this.config.atomicSwapTimeout / 2);
        
        // Create atomic swap contract
        const atomicSwap = {
            transferId: transfer.id,
            secretHash,
            secret: secret.toString('hex'),
            lockTime,
            refundTime,
            fromContract: null,
            toContract: null,
            status: 'created'
        };
        
        this.atomicSwaps.set(transfer.id, atomicSwap);
        
        try {
            // Deploy/use atomic swap contracts on both chains
            const fromConnector = this.chainConnectors.get(transfer.fromChain);
            const toConnector = this.chainConnectors.get(transfer.toChain);
            
            // Lock funds on source chain
            const lockTx = await fromConnector.lockFunds({
                amount: transfer.amount,
                asset: transfer.fromAsset,
                secretHash,
                refundTime,
                recipient: transfer.toAddress
            });
            
            atomicSwap.fromContract = lockTx.contractAddress;
            transfer.status = TransferStatus.LOCKED;
            transfer.events.push({
                type: 'funds_locked',
                chain: transfer.fromChain,
                txHash: lockTx.hash,
                timestamp: Date.now()
            });
            
            this.emit('transfer:locked', { transfer, lockTx });
            
            // Monitor for secret reveal on destination chain
            this.monitorSecretReveal(transfer, atomicSwap);
            
        } catch (error) {
            logger.error(`Failed to create atomic swap:`, error);
            transfer.status = TransferStatus.FAILED;
            transfer.error = error.message;
            throw error;
        }
    }
    
    /**
     * Execute instant swap using liquidity pools
     */
    async executeInstantSwap(transfer) {
        const poolId = `${transfer.fromChain}:${transfer.fromAsset}:${transfer.toChain}:${transfer.toAsset}`;
        const pool = this.liquidityPools.get(poolId);
        
        if (!pool || pool.available < transfer.amount) {
            throw new Error('Insufficient liquidity');
        }
        
        try {
            // Lock user funds
            const fromConnector = this.chainConnectors.get(transfer.fromChain);
            const lockTx = await fromConnector.lockFunds({
                amount: transfer.amount,
                asset: transfer.fromAsset,
                poolAddress: pool.addresses[transfer.fromChain]
            });
            
            transfer.status = TransferStatus.LOCKED;
            
            // Release funds on destination chain
            const toConnector = this.chainConnectors.get(transfer.toChain);
            const releaseTx = await toConnector.releaseFunds({
                amount: transfer.amount - transfer.fee,
                asset: transfer.toAsset,
                recipient: transfer.toAddress,
                poolAddress: pool.addresses[transfer.toChain]
            });
            
            transfer.status = TransferStatus.REDEEMED;
            transfer.completedAt = Date.now();
            transfer.events.push(
                {
                    type: 'instant_swap_locked',
                    chain: transfer.fromChain,
                    txHash: lockTx.hash,
                    timestamp: Date.now()
                },
                {
                    type: 'instant_swap_released',
                    chain: transfer.toChain,
                    txHash: releaseTx.hash,
                    timestamp: Date.now()
                }
            );
            
            // Update pool balances
            pool.balances[transfer.fromChain] += transfer.amount;
            pool.balances[transfer.toChain] -= (transfer.amount - transfer.fee);
            
            // Update stats
            this.updateTransferStats(transfer);
            
            this.emit('transfer:completed', transfer);
            
        } catch (error) {
            logger.error(`Failed to execute instant swap:`, error);
            transfer.status = TransferStatus.FAILED;
            transfer.error = error.message;
            throw error;
        }
    }
    
    /**
     * Monitor for secret reveal in atomic swap
     */
    monitorSecretReveal(transfer, atomicSwap) {
        const toConnector = this.chainConnectors.get(transfer.toChain);
        
        // Set up monitoring
        const monitor = toConnector.monitorAddress(transfer.toAddress, async (event) => {
            if (event.type === 'secret_revealed' && event.secretHash === atomicSwap.secretHash) {
                // Secret revealed, complete the transfer
                await this.completeAtomicSwap(transfer, event.secret);
                monitor.stop();
            }
        });
        
        // Set timeout for refund
        setTimeout(async () => {
            if (transfer.status === TransferStatus.LOCKED) {
                await this.refundAtomicSwap(transfer);
                monitor.stop();
            }
        }, this.config.atomicSwapTimeout);
    }
    
    /**
     * Complete atomic swap after secret reveal
     */
    async completeAtomicSwap(transfer, secret) {
        const atomicSwap = this.atomicSwaps.get(transfer.id);
        if (!atomicSwap) return;
        
        try {
            const toConnector = this.chainConnectors.get(transfer.toChain);
            
            // Redeem funds on destination chain
            const redeemTx = await toConnector.redeemFunds({
                secretHash: atomicSwap.secretHash,
                secret,
                amount: transfer.amount - transfer.fee,
                asset: transfer.toAsset,
                recipient: transfer.toAddress
            });
            
            transfer.status = TransferStatus.REDEEMED;
            transfer.completedAt = Date.now();
            transfer.events.push({
                type: 'funds_redeemed',
                chain: transfer.toChain,
                txHash: redeemTx.hash,
                timestamp: Date.now()
            });
            
            // Update stats
            this.updateTransferStats(transfer);
            
            this.emit('transfer:completed', transfer);
            
        } catch (error) {
            logger.error(`Failed to complete atomic swap:`, error);
            transfer.error = error.message;
        }
    }
    
    /**
     * Create cross-chain liquidity pool
     */
    async createLiquidityPool(params) {
        const {
            chain1,
            asset1,
            chain2,
            asset2,
            initialLiquidity
        } = params;
        
        const poolId = `${chain1}:${asset1}:${chain2}:${asset2}`;
        
        if (this.liquidityPools.has(poolId)) {
            throw new Error('Pool already exists');
        }
        
        const pool = {
            id: poolId,
            chain1,
            asset1,
            chain2,
            asset2,
            balances: {
                [chain1]: initialLiquidity[chain1] || 0,
                [chain2]: initialLiquidity[chain2] || 0
            },
            addresses: {
                [chain1]: null, // To be set after deployment
                [chain2]: null
            },
            available: Math.min(
                initialLiquidity[chain1] || 0,
                initialLiquidity[chain2] || 0
            ),
            createdAt: Date.now(),
            stats: {
                totalSwaps: 0,
                totalVolume: 0
            }
        };
        
        // Deploy pool contracts on both chains
        // This would involve actual smart contract deployment
        
        this.liquidityPools.set(poolId, pool);
        
        logger.info(`Created cross-chain liquidity pool: ${poolId}`);
        
        this.emit('pool:created', pool);
        
        return pool;
    }
    
    /**
     * Check if instant swap is available
     */
    checkInstantSwapAvailable(fromChain, toChain, fromAsset, toAsset, amount) {
        const poolId = `${fromChain}:${fromAsset}:${toChain}:${toAsset}`;
        const reversePoolId = `${toChain}:${toAsset}:${fromChain}:${fromAsset}`;
        
        const pool = this.liquidityPools.get(poolId) || this.liquidityPools.get(reversePoolId);
        
        if (!pool) return false;
        
        // Check if pool has sufficient liquidity
        const requiredLiquidity = amount - this.calculateBridgeFee(fromChain, toChain, amount);
        
        return pool.available >= requiredLiquidity;
    }
    
    /**
     * Validate transfer parameters
     */
    validateTransfer(params) {
        const { amount, fromChain, toChain } = params;
        
        if (amount < this.config.minTransferAmount) {
            return { valid: false, reason: 'Amount below minimum' };
        }
        
        if (amount > this.config.maxTransferAmount) {
            return { valid: false, reason: 'Amount above maximum' };
        }
        
        if (fromChain === toChain) {
            return { valid: false, reason: 'Same chain transfer not supported' };
        }
        
        if (!Object.values(SupportedChains).includes(fromChain)) {
            return { valid: false, reason: 'Source chain not supported' };
        }
        
        if (!Object.values(SupportedChains).includes(toChain)) {
            return { valid: false, reason: 'Destination chain not supported' };
        }
        
        return { valid: true };
    }
    
    /**
     * Calculate bridge fee
     */
    calculateBridgeFee(fromChain, toChain, amount) {
        const baseFee = this.config.bridgeFees[fromChain] || this.config.bridgeFees.default;
        const multiplier = fromChain === SupportedChains.ETHEREUM || toChain === SupportedChains.ETHEREUM
            ? 1.5 // Higher fees for Ethereum due to gas costs
            : 1.0;
        
        return amount * baseFee * multiplier;
    }
    
    /**
     * Estimate transfer time
     */
    estimateTransferTime(fromChain, toChain) {
        const fromConfirmations = this.config.confirmationBlocks[fromChain] || this.config.confirmationBlocks.default;
        const toConfirmations = this.config.confirmationBlocks[toChain] || this.config.confirmationBlocks.default;
        
        // Estimate block times (in seconds)
        const blockTimes = {
            [SupportedChains.BITCOIN]: 600, // 10 minutes
            [SupportedChains.ETHEREUM]: 12,
            [SupportedChains.BINANCE_SMART_CHAIN]: 3,
            default: 15
        };
        
        const fromBlockTime = blockTimes[fromChain] || blockTimes.default;
        const toBlockTime = blockTimes[toChain] || blockTimes.default;
        
        // Calculate total time in milliseconds
        return (fromConfirmations * fromBlockTime + toConfirmations * toBlockTime) * 1000;
    }
    
    /**
     * Update transfer statistics
     */
    updateTransferStats(transfer) {
        const duration = transfer.completedAt - transfer.createdAt;
        
        this.stats.successfulTransfers++;
        this.stats.totalVolume += transfer.amount;
        this.stats.avgTransferTime = 
            (this.stats.avgTransferTime * (this.stats.successfulTransfers - 1) + duration) / 
            this.stats.successfulTransfers;
        
        // Update chain volumes
        const fromVolume = this.stats.chainVolumes.get(transfer.fromChain) || 0;
        const toVolume = this.stats.chainVolumes.get(transfer.toChain) || 0;
        
        this.stats.chainVolumes.set(transfer.fromChain, fromVolume + transfer.amount);
        this.stats.chainVolumes.set(transfer.toChain, toVolume + transfer.amount);
    }
    
    /**
     * Start monitoring transfers
     */
    startMonitoring() {
        // Monitor pending transfers
        setInterval(() => {
            this.checkPendingTransfers();
        }, 30000); // Every 30 seconds
        
        // Clean up old transfers
        setInterval(() => {
            this.cleanupOldTransfers();
        }, 3600000); // Every hour
    }
    
    /**
     * Check pending transfers
     */
    async checkPendingTransfers() {
        for (const [transferId, transfer] of this.transfers) {
            if (transfer.status === TransferStatus.LOCKED) {
                // Check if transfer should be refunded
                const atomicSwap = this.atomicSwaps.get(transferId);
                if (atomicSwap && Date.now() > atomicSwap.refundTime) {
                    await this.refundAtomicSwap(transfer);
                }
            }
        }
    }
    
    /**
     * Refund atomic swap
     */
    async refundAtomicSwap(transfer) {
        const atomicSwap = this.atomicSwaps.get(transfer.id);
        if (!atomicSwap) return;
        
        try {
            const fromConnector = this.chainConnectors.get(transfer.fromChain);
            
            const refundTx = await fromConnector.refundLockedFunds({
                contractAddress: atomicSwap.fromContract,
                secretHash: atomicSwap.secretHash
            });
            
            transfer.status = TransferStatus.REFUNDED;
            transfer.refundedAt = Date.now();
            transfer.events.push({
                type: 'funds_refunded',
                chain: transfer.fromChain,
                txHash: refundTx.hash,
                timestamp: Date.now()
            });
            
            this.stats.failedTransfers++;
            
            this.emit('transfer:refunded', transfer);
            
        } catch (error) {
            logger.error(`Failed to refund atomic swap:`, error);
        }
    }
    
    /**
     * Clean up old transfers
     */
    cleanupOldTransfers() {
        const cutoffTime = Date.now() - (7 * 24 * 60 * 60 * 1000); // 7 days
        
        for (const [transferId, transfer] of this.transfers) {
            if (transfer.createdAt < cutoffTime && 
                (transfer.status === TransferStatus.REDEEMED || 
                 transfer.status === TransferStatus.REFUNDED ||
                 transfer.status === TransferStatus.FAILED)) {
                
                this.transfers.delete(transferId);
                this.atomicSwaps.delete(transferId);
                
                // Remove from user transfers
                const userTransfers = this.userTransfers.get(transfer.userId);
                if (userTransfers) {
                    userTransfers.delete(transferId);
                }
            }
        }
    }
    
    /**
     * Helper methods
     */
    
    generateTransferId() {
        return `XFER-${Date.now()}-${randomBytes(8).toString('hex')}`;
    }
    
    getUserTransfers(userId, status = null) {
        const userTransferIds = this.userTransfers.get(userId);
        if (!userTransferIds) return [];
        
        const transfers = Array.from(userTransferIds)
            .map(id => this.transfers.get(id))
            .filter(t => t && (!status || t.status === status));
        
        return transfers;
    }
    
    getTransfer(transferId) {
        return this.transfers.get(transferId);
    }
    
    getStats() {
        return {
            ...this.stats,
            chainVolumes: Object.fromEntries(this.stats.chainVolumes),
            activeTransfers: this.transfers.size,
            liquidityPools: this.liquidityPools.size,
            successRate: this.stats.totalTransfers > 0
                ? this.stats.successfulTransfers / this.stats.totalTransfers
                : 0
        };
    }
}

export default CrossChainBridge;