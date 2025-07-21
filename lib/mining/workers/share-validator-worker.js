/**
 * Share Validator Worker Thread
 * Performs share validation in separate thread for performance
 */

import { parentPort, workerData, threadId } from 'worker_threads';
import { createHash } from 'crypto';

// Pre-computed constants
const MAX_TARGET = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');

/**
 * Validate a single share
 */
function validateShare(share, job, minerTarget, networkTarget) {
    try {
        // Construct coinbase
        const coinbase = Buffer.concat([
            Buffer.from(job.coinbase1, 'hex'),
            Buffer.from(share.extraNonce1, 'hex'),
            Buffer.from(share.extraNonce2, 'hex'),
            Buffer.from(job.coinbase2, 'hex')
        ]);
        
        // Calculate coinbase hash
        const coinbaseHash = sha256d(coinbase);
        
        // Calculate merkle root
        let merkleRoot = coinbaseHash;
        for (const branch of (job.merkleBranch || [])) {
            const branchHash = Buffer.from(branch, 'hex');
            merkleRoot = sha256d(Buffer.concat([merkleRoot, branchHash]));
        }
        
        // Construct block header
        const header = constructHeader(share, job, merkleRoot);
        
        // Calculate block hash
        const hash = sha256d(header).reverse();
        const hashBigInt = BigInt('0x' + hash.toString('hex'));
        
        // Check targets
        const minerTargetBigInt = BigInt('0x' + minerTarget);
        const networkTargetBigInt = BigInt('0x' + networkTarget);
        
        if (hashBigInt > minerTargetBigInt) {
            return {
                valid: false,
                reason: 'High hash',
                hash: hash.toString('hex')
            };
        }
        
        // Calculate share value and check for block
        const shareValue = Number(MAX_TARGET / hashBigInt);
        const isBlock = hashBigInt <= networkTargetBigInt;
        
        return {
            valid: true,
            hash: hash.toString('hex'),
            shareValue,
            isBlock,
            blockHeight: isBlock ? job.height : null
        };
        
    } catch (error) {
        return {
            valid: false,
            reason: 'Validation error: ' + error.message
        };
    }
}

/**
 * Validate a batch of shares
 */
function validateBatch(batch) {
    const results = [];
    
    for (const item of batch) {
        const result = validateShare(
            item.share,
            item.job,
            item.minerTarget,
            item.networkTarget
        );
        results.push(result);
    }
    
    return results;
}

/**
 * Construct block header
 */
function constructHeader(share, job, merkleRoot) {
    const header = Buffer.alloc(80);
    
    // Version
    header.writeUInt32LE(job.version || 0x20000000, 0);
    
    // Previous block hash
    Buffer.from(job.prevHash || job.previousblockhash, 'hex')
        .reverse()
        .copy(header, 4);
    
    // Merkle root
    merkleRoot.reverse().copy(header, 36);
    
    // Timestamp
    header.writeUInt32LE(parseInt(share.ntime, 16), 68);
    
    // Bits
    header.writeUInt32LE(parseInt(job.nbits || job.bits, 16), 72);
    
    // Nonce
    header.writeUInt32LE(parseInt(share.nonce, 16), 76);
    
    return header;
}

/**
 * Double SHA-256
 */
function sha256d(data) {
    return createHash('sha256')
        .update(createHash('sha256').update(data).digest())
        .digest();
}

// Message handler
if (parentPort) {
    parentPort.on('message', (message) => {
        const { type, batch, batchId } = message;
        
        if (type === 'validateBatch') {
            const results = validateBatch(batch);
            
            parentPort.postMessage({
                type: 'batchComplete',
                results,
                workerId: threadId,
                batchId
            });
        }
    });
}