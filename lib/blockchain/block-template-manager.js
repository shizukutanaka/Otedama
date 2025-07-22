/**
 * Block Template Manager
 * Manages block templates and job generation for mining
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';

/**
 * Block Template Manager
 */
export class BlockTemplateManager extends EventEmitter {
    constructor(rpcClient, options = {}) {
        super();
        
        this.rpcClient = rpcClient;
        this.options = {
            updateInterval: options.updateInterval || 30000, // 30 seconds
            coinbaseAddress: options.coinbaseAddress || null,
            coinbaseMessage: options.coinbaseMessage || '/Otedama/',
            reserveSize: options.reserveSize || 1000,
            ...options
        };
        
        this.currentTemplate = null;
        this.currentJob = null;
        this.updateTimer = null;
        this.jobCounter = 0;
        this.extraNonce1 = crypto.randomBytes(4).toString('hex');
        this.extraNonce2Size = 4;
        
        this.stats = {
            templatesReceived: 0,
            jobsGenerated: 0,
            blocksFound: 0,
            lastTemplateTime: null
        };
    }
    
    /**
     * Start template updates
     */
    async start() {
        // Get initial template
        await this.updateTemplate();
        
        // Start periodic updates
        this.updateTimer = setInterval(async () => {
            try {
                await this.updateTemplate();
            } catch (error) {
                this.emit('error', error);
            }
        }, this.options.updateInterval);
        
        this.emit('started');
    }
    
    /**
     * Stop template updates
     */
    stop() {
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
            this.updateTimer = null;
        }
        
        this.emit('stopped');
    }
    
    /**
     * Update block template
     */
    async updateTemplate() {
        try {
            // Get new template from node
            const template = await this.rpcClient.getBlockTemplate({
                capabilities: ['coinbasetxn', 'workid', 'coinbase/append'],
                rules: ['segwit']
            });
            
            this.currentTemplate = template;
            this.stats.templatesReceived++;
            this.stats.lastTemplateTime = Date.now();
            
            // Generate new job from template
            const job = this.generateJob(template);
            this.currentJob = job;
            
            this.emit('template-updated', {
                template: template,
                job: job
            });
            
            return template;
            
        } catch (error) {
            throw new Error(`Failed to get block template: ${error.message}`);
        }
    }
    
    /**
     * Generate mining job from template
     */
    generateJob(template) {
        const jobId = `job_${++this.jobCounter}_${Date.now()}`;
        
        // Create coinbase transaction
        const coinbase = this.createCoinbaseTransaction(template);
        
        // Calculate merkle root
        const merkleRoot = this.calculateMerkleRoot([coinbase.hash, ...template.transactions.map(tx => tx.hash || tx.txid)]);
        
        // Build block header
        const blockHeader = this.buildBlockHeader(template, merkleRoot);
        
        // Calculate target
        const target = this.bitsToTarget(template.bits);
        
        const job = {
            id: jobId,
            height: template.height,
            previousBlockHash: template.previousblockhash,
            coinbase1: coinbase.part1,
            coinbase2: coinbase.part2,
            merkleBranch: this.getMerkleBranch(template.transactions),
            version: template.version,
            bits: template.bits,
            target: target,
            curtime: template.curtime,
            clean: true,
            submitOld: false
        };
        
        this.stats.jobsGenerated++;
        
        return job;
    }
    
    /**
     * Create coinbase transaction
     */
    createCoinbaseTransaction(template) {
        // Simplified coinbase creation
        // Real implementation would properly serialize the transaction
        
        const coinbaseValue = template.coinbasevalue;
        const height = template.height;
        
        // Build coinbase script
        const heightBuffer = Buffer.alloc(4);
        heightBuffer.writeUInt32LE(height, 0);
        
        const coinbaseScript = Buffer.concat([
            heightBuffer,
            Buffer.from(this.options.coinbaseMessage, 'utf8'),
            crypto.randomBytes(8) // Extra nonce placeholder
        ]);
        
        // Create transaction (simplified)
        const tx = {
            version: 1,
            inputs: [{
                prevout: {
                    hash: '0000000000000000000000000000000000000000000000000000000000000000',
                    index: 0xFFFFFFFF
                },
                script: coinbaseScript,
                sequence: 0xFFFFFFFF
            }],
            outputs: [{
                value: coinbaseValue,
                script: this.addressToScript(this.options.coinbaseAddress)
            }],
            locktime: 0
        };
        
        // Split into two parts for extranonce
        const serialized = this.serializeCoinbase(tx);
        const splitIndex = serialized.indexOf('ffffffff') + 8 + coinbaseScript.length;
        
        return {
            part1: serialized.substring(0, splitIndex),
            part2: serialized.substring(splitIndex + this.extraNonce2Size * 2),
            hash: this.doubleSha256(serialized)
        };
    }
    
    /**
     * Build block header
     */
    buildBlockHeader(template, merkleRoot) {
        const header = Buffer.alloc(80);
        
        // Version (4 bytes)
        header.writeInt32LE(template.version, 0);
        
        // Previous block hash (32 bytes)
        Buffer.from(template.previousblockhash, 'hex').reverse().copy(header, 4);
        
        // Merkle root (32 bytes)
        Buffer.from(merkleRoot, 'hex').reverse().copy(header, 36);
        
        // Timestamp (4 bytes)
        header.writeUInt32LE(template.curtime, 68);
        
        // Bits (4 bytes)
        Buffer.from(template.bits, 'hex').reverse().copy(header, 72);
        
        // Nonce (4 bytes) - will be filled by miner
        header.writeUInt32LE(0, 76);
        
        return header.toString('hex');
    }
    
    /**
     * Calculate merkle root
     */
    calculateMerkleRoot(txHashes) {
        if (txHashes.length === 0) return null;
        if (txHashes.length === 1) return txHashes[0];
        
        const tree = [...txHashes];
        
        while (tree.length > 1) {
            const newLevel = [];
            
            for (let i = 0; i < tree.length; i += 2) {
                const left = tree[i];
                const right = tree[i + 1] || left;
                
                const combined = Buffer.concat([
                    Buffer.from(left, 'hex').reverse(),
                    Buffer.from(right, 'hex').reverse()
                ]);
                
                const hash = this.doubleSha256(combined);
                newLevel.push(hash);
            }
            
            tree.splice(0, tree.length, ...newLevel);
        }
        
        return tree[0];
    }
    
    /**
     * Get merkle branch for transactions
     */
    getMerkleBranch(transactions) {
        const branch = [];
        const hashes = transactions.map(tx => tx.hash || tx.txid);
        
        // Simplified - would need full merkle tree calculation
        return branch;
    }
    
    /**
     * Convert bits to target
     */
    bitsToTarget(bits) {
        const bitsBuf = Buffer.from(bits, 'hex');
        const exponent = bitsBuf[3];
        const mantissa = bitsBuf[2] * 65536 + bitsBuf[1] * 256 + bitsBuf[0];
        
        const target = Buffer.alloc(32, 0);
        if (exponent <= 3) {
            target[29 - exponent] = mantissa >>> 0;
            target[30 - exponent] = mantissa >>> 8;
            target[31 - exponent] = mantissa >>> 16;
        } else {
            const offset = exponent - 3;
            target[32 - offset] = mantissa >>> 0;
            target[31 - offset] = mantissa >>> 8;
            target[30 - offset] = mantissa >>> 16;
        }
        
        return target.toString('hex');
    }
    
    /**
     * Submit block
     */
    async submitBlock(jobId, nonce, extraNonce2, time) {
        if (!this.currentJob || this.currentJob.id !== jobId) {
            throw new Error('Invalid or expired job');
        }
        
        try {
            // Reconstruct block
            const block = this.constructBlock(this.currentTemplate, nonce, extraNonce2, time);
            
            // Submit to blockchain
            const result = await this.rpcClient.submitBlock(block);
            
            if (!result) {
                // Success (null result means accepted)
                this.stats.blocksFound++;
                this.emit('block-found', {
                    height: this.currentTemplate.height,
                    hash: this.doubleSha256(block.substring(0, 160)), // Header only
                    reward: this.currentTemplate.coinbasevalue
                });
                return true;
            } else {
                // Rejected
                this.emit('block-rejected', {
                    reason: result,
                    height: this.currentTemplate.height
                });
                return false;
            }
            
        } catch (error) {
            throw new Error(`Failed to submit block: ${error.message}`);
        }
    }
    
    /**
     * Construct full block
     */
    constructBlock(template, nonce, extraNonce2, time) {
        // This is a simplified version
        // Real implementation would properly construct the entire block
        
        const header = Buffer.alloc(80);
        
        // Copy from template and update nonce/time
        Buffer.from(this.currentJob.blockHeader, 'hex').copy(header);
        header.writeUInt32LE(nonce, 76);
        if (time) {
            header.writeUInt32LE(time, 68);
        }
        
        // Would need to include all transactions
        return header.toString('hex');
    }
    
    /**
     * Utility functions
     */
    doubleSha256(data) {
        const hash1 = crypto.createHash('sha256').update(data).digest();
        const hash2 = crypto.createHash('sha256').update(hash1).digest();
        return hash2.toString('hex');
    }
    
    addressToScript(address) {
        // Simplified - would need proper address decoding
        return Buffer.from(`76a914${address}88ac`, 'hex');
    }
    
    serializeCoinbase(tx) {
        // Simplified transaction serialization
        return '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff';
    }
    
    /**
     * Get current job
     */
    getCurrentJob() {
        return this.currentJob;
    }
    
    /**
     * Get stats
     */
    getStats() {
        return {
            ...this.stats,
            currentHeight: this.currentTemplate ? this.currentTemplate.height : null,
            lastUpdate: this.stats.lastTemplateTime ? 
                new Date(this.stats.lastTemplateTime).toISOString() : null
        };
    }
}

/**
 * Create block template manager
 */
export function createBlockTemplateManager(rpcClient, options) {
    return new BlockTemplateManager(rpcClient, options);
}

export default {
    BlockTemplateManager,
    createBlockTemplateManager
};