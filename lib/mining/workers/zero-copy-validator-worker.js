/**
 * Zero-Copy Validator Worker
 * 
 * Worker thread for high-performance share validation
 * Uses pre-allocated buffers and zero-copy techniques
 */

import { parentPort, workerData } from 'worker_threads';
import { createHash } from 'crypto';

// Pre-allocated buffers for this worker
const headerBuffer = Buffer.allocUnsafe(80);
const coinbaseBuffer = Buffer.allocUnsafe(1024);
const hash1Buffer = Buffer.allocUnsafe(32);
const hash2Buffer = Buffer.allocUnsafe(32);
const merkleBuffer = Buffer.allocUnsafe(64);

// Cached values
const hexCache = new Map();
const targetCache = new Map();

// Constants
const MAX_TARGET = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');

/**
 * Fast hex parsing with cache
 */
function parseHex(hexStr) {
    let value = hexCache.get(hexStr);
    if (value !== undefined) return value;
    
    value = parseInt(hexStr, 16);
    
    if (hexCache.size < 10000) {
        hexCache.set(hexStr, value);
    }
    
    return value;
}

/**
 * Convert difficulty to target with cache
 */
function difficultyToTarget(difficulty) {
    let target = targetCache.get(difficulty);
    if (target) return target;
    
    const targetBigInt = MAX_TARGET / BigInt(Math.floor(difficulty));
    target = {
        hex: targetBigInt.toString(16).padStart(64, '0'),
        bigint: targetBigInt
    };
    
    if (targetCache.size < 1000) {
        targetCache.set(difficulty, target);
    }
    
    return target;
}

/**
 * Hex to buffer conversion (in-place)
 */
function hexToBuffer(hex, buffer, offset = 0, reverse = false) {
    const bytes = hex.length / 2;
    
    if (reverse) {
        for (let i = 0; i < bytes; i++) {
            buffer[offset + bytes - 1 - i] = parseInt(hex.substr(i * 2, 2), 16);
        }
    } else {
        for (let i = 0; i < bytes; i++) {
            buffer[offset + i] = parseInt(hex.substr(i * 2, 2), 16);
        }
    }
}

/**
 * Buffer to BigInt (no string allocation)
 */
function bufferToBigInt(buffer, start = 0, length = 32) {
    let result = 0n;
    for (let i = start; i < start + length; i++) {
        result = (result << 8n) | BigInt(buffer[i]);
    }
    return result;
}

/**
 * Reverse buffer in-place
 */
function reverseInPlace(buffer, start = 0, length = 32) {
    let left = start;
    let right = start + length - 1;
    
    while (left < right) {
        const temp = buffer[left];
        buffer[left] = buffer[right];
        buffer[right] = temp;
        left++;
        right--;
    }
}

/**
 * Calculate double SHA256 using pre-allocated buffers
 */
function sha256d(data, dataLength, outputBuffer) {
    // First hash
    const hash1 = createHash('sha256');
    hash1.update(data.slice(0, dataLength));
    hash1.digest(hash1Buffer);
    
    // Second hash
    const hash2 = createHash('sha256');
    hash2.update(hash1Buffer);
    hash2.digest(outputBuffer);
}

/**
 * Validate share batch
 */
function validateBatch(batch) {
    const results = [];
    
    for (const item of batch) {
        const { share, job, minerTarget, networkTarget } = item;
        
        try {
            // Construct header in pre-allocated buffer
            headerBuffer.writeUInt32LE(job.version || 0x20000000, 0);
            hexToBuffer(job.prevHash || job.previousblockhash, headerBuffer, 4, true);
            
            // Calculate coinbase
            let cbPos = 0;
            const cb1 = job.coinbase1 || '';
            hexToBuffer(cb1, coinbaseBuffer, cbPos);
            cbPos += cb1.length / 2;
            
            hexToBuffer(share.extraNonce1 || '', coinbaseBuffer, cbPos);
            cbPos += (share.extraNonce1 || '').length / 2;
            
            hexToBuffer(share.extraNonce2 || '', coinbaseBuffer, cbPos);
            cbPos += (share.extraNonce2 || '').length / 2;
            
            const cb2 = job.coinbase2 || '';
            hexToBuffer(cb2, coinbaseBuffer, cbPos);
            cbPos += cb2.length / 2;
            
            // Hash coinbase
            sha256d(coinbaseBuffer, cbPos, hash2Buffer);
            
            // Calculate merkle root
            let currentHash = hash2Buffer;
            
            for (const branch of (job.merkleBranch || job.merklebranch || [])) {
                // Copy current hash to first half of merkle buffer
                currentHash.copy(merkleBuffer, 0);
                
                // Add branch to second half
                hexToBuffer(branch, merkleBuffer, 32);
                
                // Hash concatenated data
                sha256d(merkleBuffer, 64, hash2Buffer);
                currentHash = hash2Buffer;
            }
            
            // Copy merkle root to header (reversed)
            reverseInPlace(currentHash);
            currentHash.copy(headerBuffer, 36);
            
            // Add timestamp, bits, nonce
            headerBuffer.writeUInt32LE(parseHex(share.ntime), 68);
            headerBuffer.writeUInt32LE(parseHex(job.nbits || job.bits), 72);
            headerBuffer.writeUInt32LE(parseHex(share.nonce), 76);
            
            // Calculate block hash
            sha256d(headerBuffer, 80, hash2Buffer);
            reverseInPlace(hash2Buffer);
            
            // Validate against targets
            const hashBigInt = bufferToBigInt(hash2Buffer);
            const minerTargetBigInt = BigInt('0x' + minerTarget);
            const networkTargetBigInt = BigInt('0x' + networkTarget);
            
            if (hashBigInt > minerTargetBigInt) {
                results.push({
                    valid: false,
                    reason: 'High hash'
                });
                continue;
            }
            
            const shareValue = Number(MAX_TARGET / hashBigInt);
            const isBlock = hashBigInt <= networkTargetBigInt;
            
            // Convert hash to hex
            let hashHex = '';
            for (let i = 0; i < 32; i++) {
                hashHex += hash2Buffer[i].toString(16).padStart(2, '0');
            }
            
            results.push({
                valid: true,
                hash: hashHex,
                shareValue,
                isBlock,
                blockHeight: isBlock ? job.height : null
            });
            
        } catch (error) {
            results.push({
                valid: false,
                reason: 'Validation error: ' + error.message
            });
        }
    }
    
    return results;
}

/**
 * Validate single share
 */
function validateShare(data) {
    const { share, job, minerDifficulty, networkDifficulty } = data;
    
    const minerTarget = difficultyToTarget(minerDifficulty);
    const networkTarget = difficultyToTarget(networkDifficulty);
    
    const batch = [{
        share,
        job,
        minerTarget: minerTarget.hex,
        networkTarget: networkTarget.hex
    }];
    
    return validateBatch(batch)[0];
}

// Message handler
parentPort.on('message', (message) => {
    const { type, batchId } = message;
    
    try {
        let results;
        
        switch (type) {
            case 'validateBatch':
                results = validateBatch(message.batch);
                parentPort.postMessage({
                    type: 'batchComplete',
                    results,
                    workerId: workerData.workerId,
                    batchId
                });
                break;
                
            case 'validateShare':
                const result = validateShare(message);
                parentPort.postMessage({
                    type: 'shareComplete',
                    result,
                    workerId: workerData.workerId,
                    shareId: message.shareId
                });
                break;
                
            default:
                parentPort.postMessage({
                    type: 'error',
                    error: 'Unknown message type: ' + type,
                    workerId: workerData.workerId
                });
        }
        
    } catch (error) {
        parentPort.postMessage({
            type: 'error',
            error: error.message,
            workerId: workerData.workerId,
            batchId
        });
    }
});