/**
 * Binary Protocol - Otedama Stratum V2
 * Efficient binary encoding/decoding for mining protocol
 * 
 * Design principles:
 * - Zero-copy operations where possible (Carmack)
 * - Type-safe encoding/decoding (Martin)
 * - Simple, efficient implementation (Pike)
 */

import { createLogger } from '../../core/logger.js';

const logger = createLogger('BinaryProtocol');

/**
 * Binary message encoder
 */
export class BinaryEncoder {
  constructor() {
    this.buffer = Buffer.allocUnsafe(65536); // 64KB initial
    this.offset = 0;
  }
  
  /**
   * Encode message
   */
  encode(type, payload) {
    this.reset();
    
    // Message header: [length(4)] [type(1)] [payload(...)]
    this.offset = 4; // Reserve space for length
    this.writeUInt8(type);
    
    // Encode payload based on type
    this.encodePayload(type, payload);
    
    // Write length
    const length = this.offset - 4;
    this.buffer.writeUInt32LE(length, 0);
    
    return this.buffer.slice(0, this.offset);
  }
  
  /**
   * Encode payload based on message type
   */
  encodePayload(type, payload) {
    // This would have specific encoding for each message type
    // For now, simple implementation
    switch (type) {
      case 0x11: // MINING_SUBSCRIBE_SUCCESS
        this.writeUInt32(payload.flags);
        this.writeUInt32(payload.channelId);
        this.writeUInt256(payload.target);
        this.writeBytes(payload.extranonce1);
        this.writeUInt8(payload.extranonce2Size);
        break;
        
      case 0x12: // NEW_MINING_JOB
        this.writeUInt32(payload.channelId);
        this.writeUInt32(payload.jobId);
        this.writeBoolean(payload.futureJob);
        this.writeUInt32(payload.version);
        this.writeBoolean(payload.versionRollingAllowed);
        this.writeBytes(payload.prevHash);
        this.writeBytes(payload.coinbase1);
        this.writeBytes(payload.coinbase2);
        this.writeBytes(payload.merkleRoot);
        this.writeUInt32(payload.time);
        this.writeUInt32(payload.bits);
        this.writeUInt256(payload.target);
        break;
        
      default:
        // Generic encoding
        this.writeBytes(Buffer.from(JSON.stringify(payload)));
    }
  }
  
  reset() {
    this.offset = 0;
  }
  
  ensureCapacity(size) {
    if (this.offset + size > this.buffer.length) {
      const newBuffer = Buffer.allocUnsafe(this.buffer.length * 2);
      this.buffer.copy(newBuffer);
      this.buffer = newBuffer;
    }
  }
  
  writeUInt8(value) {
    this.ensureCapacity(1);
    this.buffer.writeUInt8(value, this.offset);
    this.offset += 1;
  }
  
  writeUInt32(value) {
    this.ensureCapacity(4);
    this.buffer.writeUInt32LE(value, this.offset);
    this.offset += 4;
  }
  
  writeUInt256(value) {
    this.ensureCapacity(32);
    const bigIntValue = BigInt(value);
    const hex = bigIntValue.toString(16).padStart(64, '0');
    Buffer.from(hex, 'hex').copy(this.buffer, this.offset);
    this.offset += 32;
  }
  
  writeBoolean(value) {
    this.writeUInt8(value ? 1 : 0);
  }
  
  writeBytes(data) {
    this.ensureCapacity(2 + data.length);
    this.buffer.writeUInt16LE(data.length, this.offset);
    this.offset += 2;
    data.copy(this.buffer, this.offset);
    this.offset += data.length;
  }
}

/**
 * Binary message decoder
 */
export class BinaryDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.messages = [];
  }
  
  /**
   * Push data to decoder
   */
  push(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    this.extractMessages();
  }
  
  /**
   * Extract complete messages
   */
  extractMessages() {
    while (this.buffer.length >= 5) { // Minimum message size
      // Read length
      const length = this.buffer.readUInt32LE(0);
      
      if (this.buffer.length < 4 + length) {
        break; // Incomplete message
      }
      
      // Extract message
      const type = this.buffer.readUInt8(4);
      const payload = this.buffer.slice(5, 4 + length);
      
      this.messages.push({
        type,
        payload: this.decodePayload(type, payload)
      });
      
      // Remove processed message
      this.buffer = this.buffer.slice(4 + length);
    }
  }
  
  /**
   * Get next message
   */
  nextMessage() {
    return this.messages.shift() || null;
  }
  
  /**
   * Decode payload based on message type
   */
  decodePayload(type, buffer) {
    const reader = new BufferReader(buffer);
    
    switch (type) {
      case 0x10: // MINING_SUBSCRIBE
        return {
          version: reader.readUInt32(),
          userAgent: reader.readString(),
          extranonce1Size: reader.readUInt8()
        };
        
      case 0x14: // SUBMIT_SHARES_STANDARD
        return {
          channelId: reader.readUInt32(),
          jobId: reader.readUInt32(),
          nonce: reader.readBytes(4),
          time: reader.readUInt32(),
          version: reader.readUInt32(),
          extranonce2: reader.readBytes()
        };
        
      default:
        // Generic decoding
        try {
          return JSON.parse(buffer.toString());
        } catch {
          return { rawData: buffer };
        }
    }
  }
}

/**
 * Buffer reader helper
 */
class BufferReader {
  constructor(buffer) {
    this.buffer = buffer;
    this.offset = 0;
  }
  
  readUInt8() {
    const value = this.buffer.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }
  
  readUInt32() {
    const value = this.buffer.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }
  
  readBytes(length) {
    if (length === undefined) {
      length = this.buffer.readUInt16LE(this.offset);
      this.offset += 2;
    }
    const value = this.buffer.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  
  readString() {
    const length = this.buffer.readUInt16LE(this.offset);
    this.offset += 2;
    const value = this.buffer.toString('utf8', this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
}

export default { BinaryEncoder, BinaryDecoder };