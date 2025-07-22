/**
 * Persistent Share Chain
 * Manages the P2P pool share chain with persistence
 */

import { EventEmitter } from 'events';
import knex from 'knex';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Share structure
 */
class Share {
    constructor(data) {
        this.hash = data.hash || null;
        this.previousHash = data.previousHash || null;
        this.height = data.height || 0;
        this.timestamp = data.timestamp || Date.now();
        this.minerAddress = data.minerAddress;
        this.difficulty = data.difficulty;
        this.nonce = data.nonce;
        this.jobId = data.jobId;
        this.blockHash = data.blockHash || null;
        this.coinbase = data.coinbase || null;
        this.merkleRoot = data.merkleRoot || null;
        this.version = data.version || 1;
        
        // PPLNS tracking
        this.work = data.work || this.calculateWork();
        this.cumulativeWork = data.cumulativeWork || 0n;
        
        // Validation
        this.valid = data.valid !== undefined ? data.valid : null;
        this.orphan = data.orphan || false;
    }
    
    /**
     * Calculate work from difficulty
     */
    calculateWork() {
        // Work = 2^256 / (difficulty + 1)
        const maxTarget = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
        return maxTarget / (BigInt(this.difficulty) + 1n);
    }
    
    /**
     * Serialize share
     */
    serialize() {
        return JSON.stringify({
            hash: this.hash,
            previousHash: this.previousHash,
            height: this.height,
            timestamp: this.timestamp,
            minerAddress: this.minerAddress,
            difficulty: this.difficulty.toString(),
            nonce: this.nonce,
            jobId: this.jobId,
            blockHash: this.blockHash,
            coinbase: this.coinbase,
            merkleRoot: this.merkleRoot,
            version: this.version,
            work: this.work.toString(),
            cumulativeWork: this.cumulativeWork.toString(),
            valid: this.valid,
            orphan: this.orphan
        });
    }
    
    /**
     * Calculate share hash
     */
    calculateHash() {
        const data = `${this.previousHash}${this.timestamp}${this.minerAddress}${this.difficulty}${this.nonce}${this.jobId}`;
        return crypto.createHash('sha256').update(data).digest('hex');
    }
}

/**
 * Persistent Share Chain Manager
 */
export class PersistentShareChain extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.options = {
            dbPath: options.dbPath || path.join(__dirname, '../../data/sharechain.db'),
            pplnsWindow: options.pplnsWindow || 10000, // Number of shares in PPLNS window
            maxReorgDepth: options.maxReorgDepth || 100,
            pruneInterval: options.pruneInterval || 3600000, // 1 hour
            maxAge: options.maxAge || 86400000 * 7, // 7 days
            ...options
        };
        
        this.db = null;
        this.head = null;
        this.height = 0;
        this.shares = new Map(); // In-memory cache
        this.pruneTimer = null;
        
        this.stats = {
            totalShares: 0,
            validShares: 0,
            orphanShares: 0,
            chainReorgs: 0,
            lastPruneTime: null
        };
    }
    
    /**
     * Initialize database
     */
    async initialize() {
        // Create database connection
        this.db = knex({
            client: 'better-sqlite3',
            connection: {
                filename: this.options.dbPath
            },
            useNullAsDefault: true
        });
        
        // Create tables
        await this.createTables();
        
        // Load chain head
        await this.loadChainHead();
        
        // Start pruning timer
        this.startPruning();
        
        this.emit('initialized', {
            height: this.height,
            head: this.head
        });
    }
    
    /**
     * Create database tables
     */
    async createTables() {
        // Shares table
        await this.db.schema.createTableIfNotExists('shares', (table) => {
            table.string('hash', 64).primary();
            table.string('previous_hash', 64).index();
            table.integer('height').index();
            table.bigInteger('timestamp').index();
            table.string('miner_address', 64).index();
            table.string('difficulty', 64);
            table.string('nonce', 16);
            table.string('job_id', 64);
            table.string('block_hash', 64);
            table.text('coinbase');
            table.string('merkle_root', 64);
            table.integer('version');
            table.string('work', 78);
            table.string('cumulative_work', 78);
            table.boolean('valid').defaultTo(true);
            table.boolean('orphan').defaultTo(false);
            table.index(['height', 'timestamp']);
        });
        
        // Chain metadata
        await this.db.schema.createTableIfNotExists('chain_meta', (table) => {
            table.string('key', 32).primary();
            table.text('value');
        });
        
        // PPLNS windows
        await this.db.schema.createTableIfNotExists('pplns_windows', (table) => {
            table.increments('id').primary();
            table.integer('start_height').index();
            table.integer('end_height').index();
            table.string('total_work', 78);
            table.json('shares_data');
            table.bigInteger('timestamp').index();
        });
        
        // Payouts tracking
        await this.db.schema.createTableIfNotExists('payouts', (table) => {
            table.increments('id').primary();
            table.integer('height').index();
            table.string('block_hash', 64);
            table.decimal('amount', 16, 8);
            table.json('payments');
            table.bigInteger('timestamp').index();
            table.boolean('paid').defaultTo(false);
        });
    }
    
    /**
     * Load chain head from database
     */
    async loadChainHead() {
        const headData = await this.db('chain_meta')
            .where('key', 'head')
            .first();
        
        if (headData) {
            const headHash = headData.value;
            const headShare = await this.getShare(headHash);
            
            if (headShare) {
                this.head = headHash;
                this.height = headShare.height;
                
                // Load recent shares into memory
                await this.loadRecentShares();
            }
        }
    }
    
    /**
     * Load recent shares into memory cache
     */
    async loadRecentShares() {
        const recentShares = await this.db('shares')
            .where('height', '>=', Math.max(0, this.height - this.options.maxReorgDepth))
            .orderBy('height', 'desc');
        
        for (const shareData of recentShares) {
            const share = this.deserializeShare(shareData);
            this.shares.set(share.hash, share);
        }
    }
    
    /**
     * Add share to chain
     */
    async addShare(shareData) {
        const share = new Share(shareData);
        
        // Calculate hash if not provided
        if (!share.hash) {
            share.hash = share.calculateHash();
        }
        
        // Validate share
        const validation = await this.validateShare(share);
        if (!validation.valid) {
            throw new Error(`Invalid share: ${validation.reason}`);
        }
        
        // Calculate cumulative work
        const previousShare = await this.getShare(share.previousHash);
        if (previousShare) {
            share.cumulativeWork = BigInt(previousShare.cumulativeWork) + BigInt(share.work);
        } else {
            share.cumulativeWork = share.work;
        }
        
        // Add to database
        await this.db('shares').insert(this.serializeShareForDB(share));
        
        // Add to memory cache
        this.shares.set(share.hash, share);
        
        // Update chain head if necessary
        await this.updateChainHead(share);
        
        // Update stats
        this.stats.totalShares++;
        if (share.valid) this.stats.validShares++;
        
        this.emit('share-added', {
            hash: share.hash,
            height: share.height,
            miner: share.minerAddress
        });
        
        return share;
    }
    
    /**
     * Validate share
     */
    async validateShare(share) {
        // Check previous share exists
        if (share.previousHash && share.previousHash !== '0000000000000000000000000000000000000000000000000000000000000000') {
            const previous = await this.getShare(share.previousHash);
            if (!previous) {
                return { valid: false, reason: 'Previous share not found' };
            }
            
            // Check height
            if (share.height !== previous.height + 1) {
                return { valid: false, reason: 'Invalid height' };
            }
        }
        
        // Check timestamp
        if (share.timestamp > Date.now() + 60000) { // Allow 1 minute future
            return { valid: false, reason: 'Timestamp too far in future' };
        }
        
        // Check difficulty meets minimum
        if (BigInt(share.difficulty) < BigInt(this.options.minDifficulty || 1)) {
            return { valid: false, reason: 'Difficulty too low' };
        }
        
        // More validation would go here (proof of work, etc.)
        
        return { valid: true };
    }
    
    /**
     * Update chain head
     */
    async updateChainHead(share) {
        if (!this.head || BigInt(share.cumulativeWork) > BigInt((await this.getShare(this.head)).cumulativeWork)) {
            const oldHead = this.head;
            this.head = share.hash;
            this.height = share.height;
            
            // Save to database
            await this.db('chain_meta')
                .insert({ key: 'head', value: this.head })
                .onConflict('key')
                .merge();
            
            // Handle chain reorganization
            if (oldHead && share.previousHash !== oldHead) {
                await this.handleReorg(oldHead, share);
            }
            
            this.emit('new-head', {
                hash: share.hash,
                height: share.height,
                previousHead: oldHead
            });
        }
    }
    
    /**
     * Handle chain reorganization
     */
    async handleReorg(oldHead, newHead) {
        this.stats.chainReorgs++;
        
        // Find common ancestor
        const oldChain = await this.getChainSegment(oldHead, this.options.maxReorgDepth);
        const newChain = await this.getChainSegment(newHead.hash, this.options.maxReorgDepth);
        
        let commonAncestor = null;
        for (const oldShare of oldChain) {
            if (newChain.find(s => s.hash === oldShare.hash)) {
                commonAncestor = oldShare;
                break;
            }
        }
        
        if (!commonAncestor) {
            throw new Error('No common ancestor found in reorg');
        }
        
        // Mark orphaned shares
        for (const share of oldChain) {
            if (share.hash === commonAncestor.hash) break;
            share.orphan = true;
            await this.updateShare(share);
        }
        
        this.emit('chain-reorg', {
            oldHead: oldHead,
            newHead: newHead.hash,
            commonAncestor: commonAncestor.hash,
            orphanedCount: oldChain.indexOf(commonAncestor)
        });
    }
    
    /**
     * Get chain segment
     */
    async getChainSegment(startHash, maxDepth) {
        const segment = [];
        let current = await this.getShare(startHash);
        let depth = 0;
        
        while (current && depth < maxDepth) {
            segment.push(current);
            if (!current.previousHash || current.previousHash === '0000000000000000000000000000000000000000000000000000000000000000') {
                break;
            }
            current = await this.getShare(current.previousHash);
            depth++;
        }
        
        return segment;
    }
    
    /**
     * Get share by hash
     */
    async getShare(hash) {
        // Check memory cache first
        if (this.shares.has(hash)) {
            return this.shares.get(hash);
        }
        
        // Load from database
        const shareData = await this.db('shares')
            .where('hash', hash)
            .first();
        
        if (shareData) {
            const share = this.deserializeShare(shareData);
            this.shares.set(hash, share); // Cache it
            return share;
        }
        
        return null;
    }
    
    /**
     * Update share
     */
    async updateShare(share) {
        await this.db('shares')
            .where('hash', share.hash)
            .update(this.serializeShareForDB(share));
        
        this.shares.set(share.hash, share);
    }
    
    /**
     * Get PPLNS window
     */
    async getPPLNSWindow(height = null) {
        if (!height) height = this.height;
        
        const shares = await this.db('shares')
            .where('height', '<=', height)
            .where('height', '>', Math.max(0, height - this.options.pplnsWindow))
            .where('orphan', false)
            .orderBy('height', 'desc');
        
        const window = {
            startHeight: Math.max(0, height - this.options.pplnsWindow + 1),
            endHeight: height,
            shares: shares.map(s => this.deserializeShare(s)),
            totalWork: 0n
        };
        
        // Calculate total work
        for (const share of window.shares) {
            window.totalWork += BigInt(share.work);
        }
        
        return window;
    }
    
    /**
     * Calculate payouts for block
     */
    async calculatePayouts(blockHeight, blockReward) {
        const window = await this.getPPLNSWindow(blockHeight);
        const payouts = new Map();
        
        // Calculate each miner's share
        for (const share of window.shares) {
            const minerWork = payouts.get(share.minerAddress) || 0n;
            payouts.set(share.minerAddress, minerWork + BigInt(share.work));
        }
        
        // Convert to payment amounts
        const payments = [];
        const totalWork = window.totalWork;
        
        for (const [address, work] of payouts) {
            const amount = (BigInt(blockReward) * work) / totalWork;
            payments.push({
                address: address,
                amount: amount.toString(),
                shares: window.shares.filter(s => s.minerAddress === address).length
            });
        }
        
        // Record payout
        await this.db('payouts').insert({
            height: blockHeight,
            block_hash: window.shares[window.shares.length - 1].blockHash,
            amount: blockReward,
            payments: JSON.stringify(payments),
            timestamp: Date.now(),
            paid: false
        });
        
        return payments;
    }
    
    /**
     * Prune old shares
     */
    async pruneOldShares() {
        const cutoffTime = Date.now() - this.options.maxAge;
        
        const deleted = await this.db('shares')
            .where('timestamp', '<', cutoffTime)
            .where('height', '<', this.height - this.options.pplnsWindow * 2)
            .delete();
        
        // Remove from memory cache
        for (const [hash, share] of this.shares) {
            if (share.timestamp < cutoffTime) {
                this.shares.delete(hash);
            }
        }
        
        this.stats.lastPruneTime = Date.now();
        
        this.emit('pruned', {
            deleted: deleted,
            cutoffTime: new Date(cutoffTime).toISOString()
        });
        
        return deleted;
    }
    
    /**
     * Start periodic pruning
     */
    startPruning() {
        this.pruneTimer = setInterval(async () => {
            try {
                await this.pruneOldShares();
            } catch (error) {
                this.emit('error', error);
            }
        }, this.options.pruneInterval);
    }
    
    /**
     * Stop pruning
     */
    stopPruning() {
        if (this.pruneTimer) {
            clearInterval(this.pruneTimer);
            this.pruneTimer = null;
        }
    }
    
    /**
     * Serialize share for database
     */
    serializeShareForDB(share) {
        return {
            hash: share.hash,
            previous_hash: share.previousHash,
            height: share.height,
            timestamp: share.timestamp,
            miner_address: share.minerAddress,
            difficulty: share.difficulty.toString(),
            nonce: share.nonce,
            job_id: share.jobId,
            block_hash: share.blockHash,
            coinbase: share.coinbase,
            merkle_root: share.merkleRoot,
            version: share.version,
            work: share.work.toString(),
            cumulative_work: share.cumulativeWork.toString(),
            valid: share.valid,
            orphan: share.orphan
        };
    }
    
    /**
     * Deserialize share from database
     */
    deserializeShare(data) {
        return new Share({
            hash: data.hash,
            previousHash: data.previous_hash,
            height: data.height,
            timestamp: data.timestamp,
            minerAddress: data.miner_address,
            difficulty: data.difficulty,
            nonce: data.nonce,
            jobId: data.job_id,
            blockHash: data.block_hash,
            coinbase: data.coinbase,
            merkleRoot: data.merkle_root,
            version: data.version,
            work: data.work,
            cumulativeWork: data.cumulative_work,
            valid: data.valid,
            orphan: data.orphan
        });
    }
    
    /**
     * Get statistics
     */
    getStats() {
        return {
            ...this.stats,
            currentHeight: this.height,
            headHash: this.head,
            cacheSize: this.shares.size,
            lastPrune: this.stats.lastPruneTime ? 
                new Date(this.stats.lastPruneTime).toISOString() : null
        };
    }
    
    /**
     * Close database connection
     */
    async close() {
        this.stopPruning();
        
        if (this.db) {
            await this.db.destroy();
            this.db = null;
        }
        
        this.shares.clear();
        this.emit('closed');
    }
}

/**
 * Create persistent share chain
 */
export function createPersistentShareChain(options) {
    return new PersistentShareChain(options);
}

export default {
    PersistentShareChain,
    Share,
    createPersistentShareChain
};