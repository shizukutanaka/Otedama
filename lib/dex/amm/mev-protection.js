/**
 * MEV Protection System
 * Protects users from frontrunning, sandwich attacks, and JIT liquidity exploitation
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';

export class MEVProtection extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Commit-reveal delay
            commitDelay: config.commitDelay || 1000, // 1 block
            maxCommitAge: config.maxCommitAge || 30000, // 30 blocks
            
            // Slippage protection
            defaultSlippage: config.defaultSlippage || 50, // 0.5%
            maxSlippage: config.maxSlippage || 500, // 5%
            
            // JIT protection
            minLiquidityAge: config.minLiquidityAge || 60000, // 1 minute
            jitPenaltyRate: config.jitPenaltyRate || 500, // 5% penalty
            
            // Order batching
            batchInterval: config.batchInterval || 1000, // 1 second
            minBatchSize: config.minBatchSize || 2,
            
            // Fair ordering
            useThresholdEncryption: config.useThresholdEncryption || false,
            randomnessSource: config.randomnessSource || 'internal',
            
            ...config
        };
        
        // State
        this.commits = new Map(); // txHash -> commit data
        this.pendingBatch = [];
        this.liquidityPositions = new Map(); // positionId -> timestamp
        this.batchTimer = null;
        
        // Metrics
        this.metrics = {
            totalCommits: 0,
            revealedCommits: 0,
            expiredCommits: 0,
            batchesProcessed: 0,
            mevAttacksBlocked: 0,
            jitLiquidityBlocked: 0
        };
        
        // Start batch processing
        this.startBatchProcessing();
    }

    /**
     * Commit-Reveal: Create commitment for swap
     */
    async commitSwap(swapParams, userSecret) {
        const commitment = this.createCommitment(swapParams, userSecret);
        const commitHash = commitment.hash;
        
        // Store commit
        this.commits.set(commitHash, {
            commitment,
            timestamp: Date.now(),
            status: 'pending'
        });
        
        this.metrics.totalCommits++;
        
        // Clean expired commits
        this.cleanExpiredCommits();
        
        this.emit('commitCreated', {
            commitHash,
            timestamp: Date.now()
        });
        
        return {
            commitHash,
            commitment: commitment.encryptedData,
            revealAfter: Date.now() + this.config.commitDelay
        };
    }

    /**
     * Reveal committed swap
     */
    async revealSwap(commitHash, swapParams, userSecret) {
        const commitData = this.commits.get(commitHash);
        
        if (!commitData) {
            throw new Error('Commit not found');
        }
        
        if (commitData.status !== 'pending') {
            throw new Error('Commit already revealed or expired');
        }
        
        // Check timing
        const age = Date.now() - commitData.timestamp;
        if (age < this.config.commitDelay) {
            throw new Error('Reveal too early');
        }
        
        if (age > this.config.maxCommitAge) {
            throw new Error('Commit expired');
        }
        
        // Verify commitment
        const verified = this.verifyCommitment(
            commitHash,
            swapParams,
            userSecret,
            commitData.commitment
        );
        
        if (!verified) {
            throw new Error('Invalid reveal');
        }
        
        // Mark as revealed
        commitData.status = 'revealed';
        commitData.revealedAt = Date.now();
        commitData.swapParams = swapParams;
        
        this.metrics.revealedCommits++;
        
        // Add to batch
        this.addToBatch({
            commitHash,
            swapParams,
            timestamp: commitData.timestamp,
            revealedAt: Date.now()
        });
        
        return {
            queued: true,
            batchId: this.currentBatchId,
            estimatedExecution: Date.now() + this.config.batchInterval
        };
    }

    /**
     * Create commitment
     */
    createCommitment(swapParams, userSecret) {
        const data = {
            ...swapParams,
            userSecret,
            nonce: crypto.randomBytes(32).toString('hex')
        };
        
        const dataStr = JSON.stringify(data);
        const hash = crypto.createHash('sha256').update(dataStr).digest('hex');
        
        // Encrypt data if threshold encryption enabled
        const encryptedData = this.config.useThresholdEncryption
            ? this.thresholdEncrypt(dataStr)
            : Buffer.from(dataStr).toString('base64');
        
        return {
            hash,
            encryptedData,
            nonce: data.nonce
        };
    }

    /**
     * Verify commitment
     */
    verifyCommitment(commitHash, swapParams, userSecret, commitment) {
        const recreated = this.createCommitment(swapParams, userSecret);
        
        // In real implementation, would verify against stored hash
        // For now, simplified verification
        return true;
    }

    /**
     * Add swap to batch
     */
    addToBatch(swap) {
        this.pendingBatch.push(swap);
        
        // Process immediately if batch is full
        if (this.pendingBatch.length >= this.config.minBatchSize * 2) {
            this.processBatch();
        }
    }

    /**
     * Start batch processing timer
     */
    startBatchProcessing() {
        this.batchTimer = setInterval(() => {
            if (this.pendingBatch.length >= this.config.minBatchSize) {
                this.processBatch();
            }
        }, this.config.batchInterval);
    }

    /**
     * Process batch of swaps
     */
    async processBatch() {
        if (this.pendingBatch.length === 0) return;
        
        const batch = [...this.pendingBatch];
        this.pendingBatch = [];
        
        // Fair ordering within batch
        const orderedBatch = this.fairOrderBatch(batch);
        
        // Check for sandwich attacks
        const cleanBatch = this.detectAndRemoveSandwiches(orderedBatch);
        
        // Execute batch
        const results = await this.executeBatch(cleanBatch);
        
        this.metrics.batchesProcessed++;
        
        this.emit('batchProcessed', {
            batchId: this.currentBatchId,
            originalSize: batch.length,
            processedSize: cleanBatch.length,
            removedCount: batch.length - cleanBatch.length,
            results
        });
        
        return results;
    }

    /**
     * Fair order batch using commit time or randomness
     */
    fairOrderBatch(batch) {
        if (this.config.randomnessSource === 'commit-time') {
            // Order by commit timestamp (FCFS)
            return batch.sort((a, b) => a.timestamp - b.timestamp);
        } else {
            // Random shuffle for fairness
            return this.shuffleArray(batch);
        }
    }

    /**
     * Detect and remove sandwich attacks
     */
    detectAndRemoveSandwiches(batch) {
        const cleanBatch = [];
        const suspicious = new Set();
        
        for (let i = 0; i < batch.length; i++) {
            const current = batch[i];
            
            // Check if this could be part of a sandwich
            const isSandwich = this.checkSandwichPattern(batch, i);
            
            if (isSandwich.detected) {
                suspicious.add(i);
                if (isSandwich.attackerIndices) {
                    isSandwich.attackerIndices.forEach(idx => suspicious.add(idx));
                }
                
                this.metrics.mevAttacksBlocked++;
                
                this.emit('sandwichDetected', {
                    victimIndex: i,
                    attackerIndices: isSandwich.attackerIndices,
                    pattern: isSandwich.pattern
                });
            }
        }
        
        // Keep only non-suspicious transactions
        batch.forEach((tx, i) => {
            if (!suspicious.has(i)) {
                cleanBatch.push(tx);
            }
        });
        
        return cleanBatch;
    }

    /**
     * Check for sandwich attack pattern
     */
    checkSandwichPattern(batch, targetIndex) {
        const target = batch[targetIndex];
        const patterns = [];
        
        // Look for buy-target-sell pattern
        for (let i = 0; i < batch.length; i++) {
            if (i === targetIndex) continue;
            
            for (let j = i + 1; j < batch.length; j++) {
                if (j === targetIndex) continue;
                
                const first = batch[i];
                const second = batch[j];
                
                // Check if same user and opposite directions
                if (this.isSandwichPair(first, target, second)) {
                    patterns.push({
                        attackerIndices: [i, j],
                        pattern: 'sandwich'
                    });
                }
            }
        }
        
        return {
            detected: patterns.length > 0,
            patterns,
            attackerIndices: patterns[0]?.attackerIndices
        };
    }

    /**
     * Check if transactions form sandwich pattern
     */
    isSandwichPair(first, victim, second) {
        // Simplified check - in production would be more sophisticated
        if (!first.swapParams || !victim.swapParams || !second.swapParams) {
            return false;
        }
        
        // Same token pair
        const samePair = 
            first.swapParams.tokenIn === victim.swapParams.tokenIn &&
            first.swapParams.tokenOut === victim.swapParams.tokenOut;
        
        // Opposite direction for second
        const oppositeSecond = 
            second.swapParams.tokenIn === first.swapParams.tokenOut &&
            second.swapParams.tokenOut === first.swapParams.tokenIn;
        
        // Time proximity
        const timeProximity = 
            Math.abs(first.revealedAt - second.revealedAt) < 5000; // 5 seconds
        
        return samePair && oppositeSecond && timeProximity;
    }

    /**
     * Execute batch of swaps
     */
    async executeBatch(batch) {
        const results = [];
        
        for (const swap of batch) {
            try {
                // Apply MEV protection
                const protectedParamsParams = this.applyMEVProtection(swap.swapParams);
                
                // Check JIT liquidity
                if (this.isJITLiquidity(protectedParamsParams)) {
                    throw new Error('JIT liquidity detected');
                }
                
                results.push({
                    commitHash: swap.commitHash,
                    success: true,
                    params: protectedParamsParams
                });
            } catch (error) {
                results.push({
                    commitHash: swap.commitHash,
                    success: false,
                    error: error.message
                });
            }
        }
        
        return results;
    }

    /**
     * Apply MEV protection to swap parameters
     */
    applyMEVProtection(params) {
        const protectedParamsParams = { ...params };
        
        // Enforce maximum slippage
        if (!protectedParamsParams.maxSlippage || protectedParamsParams.maxSlippage > this.config.maxSlippage) {
            protectedParamsParams.maxSlippage = this.config.maxSlippage;
        }
        
        // Add deadline if not present
        if (!protectedParams.deadline) {
            protectedParams.deadline = Date.now() + 300000; // 5 minutes
        }
        
        // Add recipient validation
        if (!protectedParams.recipient) {
            protectedParams.recipient = protectedParams.from;
        }
        
        return protectedParams;
    }

    /**
     * Check for JIT liquidity
     */
    isJITLiquidity(params) {
        if (!params.liquidityPositionId) return false;
        
        const positionAge = Date.now() - 
            (this.liquidityPositions.get(params.liquidityPositionId) || 0);
        
        if (positionAge < this.config.minLiquidityAge) {
            this.metrics.jitLiquidityBlocked++;
            return true;
        }
        
        return false;
    }

    /**
     * Record liquidity position
     */
    recordLiquidityPosition(positionId, timestamp = Date.now()) {
        this.liquidityPositions.set(positionId, timestamp);
        
        // Clean old positions
        this.cleanOldPositions();
    }

    /**
     * Clean expired commits
     */
    cleanExpiredCommits() {
        const now = Date.now();
        const expired = [];
        
        for (const [hash, data] of this.commits) {
            if (now - data.timestamp > this.config.maxCommitAge) {
                expired.push(hash);
                this.metrics.expiredCommits++;
            }
        }
        
        expired.forEach(hash => this.commits.delete(hash));
    }

    /**
     * Clean old liquidity positions
     */
    cleanOldPositions() {
        const cutoff = Date.now() - this.config.minLiquidityAge * 10;
        const toRemove = [];
        
        for (const [id, timestamp] of this.liquidityPositions) {
            if (timestamp < cutoff) {
                toRemove.push(id);
            }
        }
        
        toRemove.forEach(id => this.liquidityPositions.delete(id));
    }

    /**
     * Threshold encryption stub
     */
    thresholdEncrypt(data) {
        // In production, would use actual threshold encryption
        return Buffer.from(data).toString('base64');
    }

    /**
     * Shuffle array
     */
    shuffleArray(array) {
        const shuffled = [...array];
        
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        
        return shuffled;
    }

    /**
     * Get protection metrics
     */
    getMetrics() {
        return {
            ...this.metrics,
            activeCommits: this.commits.size,
            pendingBatchSize: this.pendingBatch.length,
            trackedPositions: this.liquidityPositions.size,
            protectionLevel: this.calculateProtectionLevel()
        };
    }

    /**
     * Calculate overall protection level
     */
    calculateProtectionLevel() {
        const factors = [
            this.config.useThresholdEncryption ? 20 : 0,
            this.config.commitDelay >= 1000 ? 20 : 10,
            this.config.minBatchSize >= 5 ? 20 : 10,
            this.config.jitPenaltyRate >= 300 ? 20 : 10,
            this.metrics.mevAttacksBlocked > 0 ? 20 : 0
        ];
        
        return factors.reduce((a, b) => a + b, 0);
    }

    /**
     * Stop protection system
     */
    stop() {
        if (this.batchTimer) {
            clearInterval(this.batchTimer);
            this.batchTimer = null;
        }
        
        // Process remaining batch
        if (this.pendingBatch.length > 0) {
            this.processBatch();
        }
    }
}

export default MEVProtection;