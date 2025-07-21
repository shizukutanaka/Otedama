/**
 * Zero-Copy Binary Protocol for Otedama
 * 
 * High-performance binary serialization without memory allocation
 * Following Rob Pike's simplicity and John Carmack's performance principles
 */

import { globalBufferPool } from './buffer-pool.js';

/**
 * Message types for binary protocol
 */
export const MessageType = {
    SHARE: 0x01,
    BLOCK: 0x02,
    ORDER: 0x03,
    TRADE: 0x04,
    HEARTBEAT: 0x05,
    WORK: 0x06,
    SUBMIT: 0x07,
    RESULT: 0x08,
    BATCH_ORDER: 0x09,
    ORDERBOOK_UPDATE: 0x0A
};

/**
 * Zero-copy binary protocol encoder/decoder
 */
export class ZeroCopyProtocol {
    constructor() {
        // Pre-allocated buffers for common operations
        this.scratchBuffer = Buffer.allocUnsafe(1024);
        this.uint32Buffer = Buffer.allocUnsafe(4);
        this.uint64Buffer = Buffer.allocUnsafe(8);
        
        // Reusable DataView for efficient number operations
        this.dataView = new DataView(this.scratchBuffer.buffer);
    }
    
    /**
     * Encode mining share with zero-copy
     */
    encodeShare(share, targetBuffer, offset = 0) {
        let pos = offset;
        
        // Message type
        targetBuffer[pos++] = MessageType.SHARE;
        
        // Length placeholder (will fill later)
        const lengthPos = pos;
        pos += 4;
        
        // Nonce (4 bytes)
        targetBuffer.writeUInt32BE(parseInt(share.nonce, 16), pos);
        pos += 4;
        
        // Ntime (4 bytes)
        targetBuffer.writeUInt32BE(parseInt(share.ntime, 16), pos);
        pos += 4;
        
        // ExtraNonce1 length + data
        const extraNonce1 = Buffer.from(share.extraNonce1, 'hex');
        targetBuffer[pos++] = extraNonce1.length;
        extraNonce1.copy(targetBuffer, pos);
        pos += extraNonce1.length;
        
        // ExtraNonce2 length + data
        const extraNonce2 = Buffer.from(share.extraNonce2, 'hex');
        targetBuffer[pos++] = extraNonce2.length;
        extraNonce2.copy(targetBuffer, pos);
        pos += extraNonce2.length;
        
        // Job ID length + data
        if (share.jobId) {
            const jobIdBytes = Buffer.from(share.jobId);
            targetBuffer[pos++] = jobIdBytes.length;
            jobIdBytes.copy(targetBuffer, pos);
            pos += jobIdBytes.length;
        } else {
            targetBuffer[pos++] = 0;
        }
        
        // Write total length
        targetBuffer.writeUInt32BE(pos - lengthPos - 4, lengthPos);
        
        return pos;
    }
    
    /**
     * Decode mining share with zero-copy
     */
    decodeShare(buffer, offset = 0) {
        let pos = offset;
        
        // Skip message type
        pos++;
        
        // Read length
        const length = buffer.readUInt32BE(pos);
        pos += 4;
        
        // Read nonce
        const nonce = buffer.readUInt32BE(pos).toString(16).padStart(8, '0');
        pos += 4;
        
        // Read ntime
        const ntime = buffer.readUInt32BE(pos).toString(16).padStart(8, '0');
        pos += 4;
        
        // Read extraNonce1
        const extraNonce1Len = buffer[pos++];
        const extraNonce1 = buffer.slice(pos, pos + extraNonce1Len).toString('hex');
        pos += extraNonce1Len;
        
        // Read extraNonce2
        const extraNonce2Len = buffer[pos++];
        const extraNonce2 = buffer.slice(pos, pos + extraNonce2Len).toString('hex');
        pos += extraNonce2Len;
        
        // Read job ID
        const jobIdLen = buffer[pos++];
        const jobId = jobIdLen > 0 
            ? buffer.slice(pos, pos + jobIdLen).toString() 
            : null;
        pos += jobIdLen;
        
        return {
            nonce,
            ntime,
            extraNonce1,
            extraNonce2,
            jobId
        };
    }
    
    /**
     * Encode order with zero-copy
     */
    encodeOrder(order, targetBuffer, offset = 0) {
        let pos = offset;
        
        // Message type
        targetBuffer[pos++] = MessageType.ORDER;
        
        // Length placeholder
        const lengthPos = pos;
        pos += 4;
        
        // Order ID (16 bytes)
        const orderId = Buffer.from(order.id.replace(/-/g, ''), 'hex');
        orderId.copy(targetBuffer, pos);
        pos += 16;
        
        // Timestamp (8 bytes)
        targetBuffer.writeBigInt64BE(BigInt(order.timestamp), pos);
        pos += 8;
        
        // Type (1 byte: 0=limit, 1=market, 2=stop)
        targetBuffer[pos++] = order.type === 'limit' ? 0 : 
                             order.type === 'market' ? 1 : 2;
        
        // Side (1 byte: 0=buy, 1=sell)
        targetBuffer[pos++] = order.side === 'buy' ? 0 : 1;
        
        // Price (8 bytes as fixed point)
        const priceFixed = Math.floor(order.price * 100000000);
        targetBuffer.writeBigInt64BE(BigInt(priceFixed), pos);
        pos += 8;
        
        // Quantity (8 bytes as fixed point)
        const quantityFixed = Math.floor(order.quantity * 100000000);
        targetBuffer.writeBigInt64BE(BigInt(quantityFixed), pos);
        pos += 8;
        
        // Pair (variable length)
        const pairBytes = Buffer.from(order.pair);
        targetBuffer[pos++] = pairBytes.length;
        pairBytes.copy(targetBuffer, pos);
        pos += pairBytes.length;
        
        // Write total length
        targetBuffer.writeUInt32BE(pos - lengthPos - 4, lengthPos);
        
        return pos;
    }
    
    /**
     * Encode batch of orders efficiently
     */
    encodeBatchOrders(orders, targetBuffer, offset = 0) {
        let pos = offset;
        
        // Message type
        targetBuffer[pos++] = MessageType.BATCH_ORDER;
        
        // Length placeholder
        const lengthPos = pos;
        pos += 4;
        
        // Order count
        targetBuffer.writeUInt16BE(orders.length, pos);
        pos += 2;
        
        // Encode each order
        for (const order of orders) {
            pos = this.encodeOrder(order, targetBuffer, pos);
        }
        
        // Write total length
        targetBuffer.writeUInt32BE(pos - lengthPos - 4, lengthPos);
        
        return pos;
    }
    
    /**
     * Fast number encoding without allocation
     */
    encodeUInt32(value, targetBuffer, offset) {
        targetBuffer.writeUInt32BE(value, offset);
        return offset + 4;
    }
    
    encodeUInt64(value, targetBuffer, offset) {
        targetBuffer.writeBigInt64BE(BigInt(value), offset);
        return offset + 8;
    }
    
    encodeFloat64(value, targetBuffer, offset) {
        targetBuffer.writeDoubleLE(value, offset);
        return offset + 8;
    }
    
    /**
     * Encode string without allocation
     */
    encodeString(str, targetBuffer, offset) {
        const length = Buffer.byteLength(str);
        targetBuffer.writeUInt16BE(length, offset);
        targetBuffer.write(str, offset + 2, length);
        return offset + 2 + length;
    }
    
    /**
     * Decode string with zero-copy (returns slice)
     */
    decodeString(buffer, offset) {
        const length = buffer.readUInt16BE(offset);
        const str = buffer.slice(offset + 2, offset + 2 + length).toString();
        return { value: str, bytesRead: 2 + length };
    }
    
    /**
     * Create header for WebSocket frame (zero-copy)
     */
    createWebSocketHeader(opcode, payloadLength, mask = false) {
        const header = globalBufferPool.allocate(14); // Max header size
        let pos = 0;
        
        // FIN (1) + RSV (000) + Opcode
        header[pos++] = 0x80 | (opcode & 0x0F);
        
        // Mask bit + Payload length
        if (payloadLength < 126) {
            header[pos++] = (mask ? 0x80 : 0) | payloadLength;
        } else if (payloadLength < 65536) {
            header[pos++] = (mask ? 0x80 : 0) | 126;
            header.writeUInt16BE(payloadLength, pos);
            pos += 2;
        } else {
            header[pos++] = (mask ? 0x80 : 0) | 127;
            header.writeBigUInt64BE(BigInt(payloadLength), pos);
            pos += 8;
        }
        
        // Masking key (if needed)
        if (mask) {
            // Generate random mask
            crypto.randomFillSync(header, pos, 4);
            pos += 4;
        }
        
        return header.slice(0, pos);
    }
    
    /**
     * High-performance block header encoding
     */
    encodeBlockHeader(header, targetBuffer, offset = 0) {
        // Version (4 bytes)
        targetBuffer.writeUInt32LE(header.version, offset);
        
        // Previous hash (32 bytes) - already in buffer format
        header.prevHash.copy(targetBuffer, offset + 4);
        
        // Merkle root (32 bytes)
        header.merkleRoot.copy(targetBuffer, offset + 36);
        
        // Timestamp (4 bytes)
        targetBuffer.writeUInt32LE(header.timestamp, offset + 68);
        
        // Bits (4 bytes)
        targetBuffer.writeUInt32LE(header.bits, offset + 72);
        
        // Nonce (4 bytes)
        targetBuffer.writeUInt32LE(header.nonce, offset + 76);
        
        return offset + 80;
    }
    
    /**
     * Zero-copy message framing
     */
    frame(messageBuffer) {
        const totalLength = messageBuffer.length + 4;
        const framedBuffer = globalBufferPool.allocate(totalLength);
        
        // Write length prefix
        framedBuffer.writeUInt32BE(messageBuffer.length, 0);
        
        // Copy message (this is the only copy, could be avoided with scatter-gather I/O)
        messageBuffer.copy(framedBuffer, 4);
        
        return framedBuffer;
    }
    
    /**
     * Extract frame without copying payload
     */
    unframe(buffer, offset = 0) {
        if (buffer.length - offset < 4) {
            return null; // Not enough data
        }
        
        const length = buffer.readUInt32BE(offset);
        
        if (buffer.length - offset - 4 < length) {
            return null; // Incomplete frame
        }
        
        // Return slice (no copy)
        return {
            payload: buffer.slice(offset + 4, offset + 4 + length),
            bytesConsumed: 4 + length
        };
    }
}

/**
 * Binary protocol for P2P share propagation
 */
export class ShareProtocol {
    constructor() {
        this.protocol = new ZeroCopyProtocol();
    }
    
    /**
     * Encode share submission for P2P
     */
    encodeSubmission(share, job, workerInfo) {
        const buffer = globalBufferPool.allocate(512);
        let pos = 0;
        
        // Protocol version
        buffer[pos++] = 1;
        
        // Message type
        buffer[pos++] = MessageType.SUBMIT;
        
        // Timestamp
        buffer.writeBigInt64BE(BigInt(Date.now()), pos);
        pos += 8;
        
        // Worker info
        pos = this.protocol.encodeString(workerInfo.id, buffer, pos);
        pos = this.protocol.encodeString(workerInfo.address, buffer, pos);
        
        // Share data
        pos = this.protocol.encodeShare(share, buffer, pos);
        
        // Job info (compact)
        buffer.writeUInt32BE(job.height, pos);
        pos += 4;
        
        // Difficulty
        buffer.writeFloatBE(job.difficulty, pos);
        pos += 4;
        
        return buffer.slice(0, pos);
    }
    
    /**
     * Decode share submission
     */
    decodeSubmission(buffer) {
        let pos = 0;
        
        // Protocol version
        const version = buffer[pos++];
        
        // Message type
        const messageType = buffer[pos++];
        
        // Timestamp
        const timestamp = Number(buffer.readBigInt64BE(pos));
        pos += 8;
        
        // Worker info
        const workerId = this.protocol.decodeString(buffer, pos);
        pos += workerId.bytesRead;
        
        const workerAddress = this.protocol.decodeString(buffer, pos);
        pos += workerAddress.bytesRead;
        
        // Share data
        const share = this.protocol.decodeShare(buffer, pos);
        
        // Calculate position after share
        pos = buffer.indexOf(0, pos) + 1; // Simple way, in production use proper length
        
        // Job info
        const height = buffer.readUInt32BE(pos);
        pos += 4;
        
        const difficulty = buffer.readFloatBE(pos);
        
        return {
            version,
            timestamp,
            worker: {
                id: workerId.value,
                address: workerAddress.value
            },
            share,
            job: {
                height,
                difficulty
            }
        };
    }
}

// Export singleton instances
export const zeroCopyProtocol = new ZeroCopyProtocol();
export const shareProtocol = new ShareProtocol();

export default ZeroCopyProtocol;