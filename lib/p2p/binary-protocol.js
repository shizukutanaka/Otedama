/**
 * Binary Protocol for P2P Communication
 * High-performance binary serialization following Carmack's principles
 * Replaces JSON with fixed-size binary structures for critical paths
 */

import { BufferPool } from '../performance/buffer-pool.js';

// Message types (1 byte)
export const MessageType = {
  SHARE: 0x01,
  BLOCK: 0x02,
  WORK: 0x03,
  STATS: 0x04,
  SYNC: 0x05,
  PEER_INFO: 0x06,
  MINER_JOIN: 0x07,
  MINER_LEAVE: 0x08,
  REPUTATION: 0x09,
  GOSSIP: 0x0A,
  PARTITION: 0x0B,
  REORG: 0x0C,
  HEARTBEAT: 0x0D,
  ACK: 0x0E,
  ERROR: 0x0F
};

// Protocol version
const PROTOCOL_VERSION = 1;

// Fixed sizes for common structures
const SIZES = {
  HEADER: 16,           // version(1) + type(1) + flags(2) + length(4) + timestamp(8)
  SHARE_HEADER: 144,    // jobId(32) + nonce(8) + timestamp(8) + difficulty(8) + hash(32) + prevHash(32) + merkleRoot(32) + height(4)
  BLOCK_HEADER: 176,    // share_header(144) + reward(8) + txCount(4) + size(4) + version(4) + bits(4) + weight(8)
  WORK_HEADER: 128,     // jobId(32) + target(32) + prevHash(32) + merkleRoot(32)
  PEER_ID: 16,          // 128-bit peer ID
  MINER_ID: 16,         // 128-bit miner ID
  HASH: 32              // 256-bit hash
};

export class BinaryProtocol {
  constructor(options = {}) {
    this.bufferPool = new BufferPool({
      bufferSize: options.bufferSize || 65536, // 64KB buffers
      maxPoolSize: options.maxPoolSize || 100
    });
    
    // Pre-allocate frequently used buffers
    this.headerBuffer = Buffer.allocUnsafe(SIZES.HEADER);
    this.tempBuffer = Buffer.allocUnsafe(1024);
    
    // Encoding/decoding functions map
    this.encoders = new Map();
    this.decoders = new Map();
    
    this.setupEncoders();
    this.setupDecoders();
  }
  
  /**
   * Setup encoder functions for each message type
   */
  setupEncoders() {
    // Share encoder
    this.encoders.set(MessageType.SHARE, (data, buffer, offset) => {
      let pos = offset;
      
      // Write share header
      this.writeHash(buffer, pos, data.jobId); pos += 32;
      buffer.writeBigUInt64BE(BigInt(data.nonce), pos); pos += 8;
      buffer.writeBigUInt64BE(BigInt(data.timestamp), pos); pos += 8;
      buffer.writeDoubleLE(data.difficulty, pos); pos += 8;
      this.writeHash(buffer, pos, data.hash); pos += 32;
      this.writeHash(buffer, pos, data.prevHash); pos += 32;
      this.writeHash(buffer, pos, data.merkleRoot); pos += 32;
      buffer.writeUInt32BE(data.height, pos); pos += 4;
      
      // Write variable data (extraNonce, minerData)
      if (data.extraNonce) {
        buffer.writeUInt16BE(data.extraNonce.length, pos); pos += 2;
        buffer.write(data.extraNonce, pos); pos += data.extraNonce.length;
      } else {
        buffer.writeUInt16BE(0, pos); pos += 2;
      }
      
      return pos - offset;
    });
    
    // Block encoder
    this.encoders.set(MessageType.BLOCK, (data, buffer, offset) => {
      let pos = offset;
      
      // Write share header first (blocks contain shares)
      const shareSize = this.encoders.get(MessageType.SHARE)(data.share, buffer, pos);
      pos += shareSize;
      
      // Write block-specific data
      buffer.writeBigUInt64BE(BigInt(data.reward || 0), pos); pos += 8;
      buffer.writeUInt32BE(data.txCount || 0, pos); pos += 4;
      buffer.writeUInt32BE(data.size || 0, pos); pos += 4;
      buffer.writeUInt32BE(data.version || 1, pos); pos += 4;
      buffer.writeUInt32BE(data.bits || 0, pos); pos += 4;
      buffer.writeBigUInt64BE(BigInt(data.weight || 0), pos); pos += 8;
      
      return pos - offset;
    });
    
    // Work encoder
    this.encoders.set(MessageType.WORK, (data, buffer, offset) => {
      let pos = offset;
      
      this.writeHash(buffer, pos, data.jobId); pos += 32;
      this.writeHash(buffer, pos, data.target); pos += 32;
      this.writeHash(buffer, pos, data.prevHash); pos += 32;
      this.writeHash(buffer, pos, data.merkleRoot); pos += 32;
      
      // Write algorithm and extra data
      buffer.writeUInt8(data.algorithm || 0, pos); pos += 1;
      buffer.writeUInt32BE(data.height || 0, pos); pos += 4;
      buffer.writeBigUInt64BE(BigInt(data.timestamp || Date.now()), pos); pos += 8;
      
      return pos - offset;
    });
    
    // Stats encoder
    this.encoders.set(MessageType.STATS, (data, buffer, offset) => {
      let pos = offset;
      
      buffer.writeDoubleLE(data.hashrate || 0, pos); pos += 8;
      buffer.writeUInt32BE(data.shares || 0, pos); pos += 4;
      buffer.writeUInt32BE(data.blocks || 0, pos); pos += 4;
      buffer.writeUInt32BE(data.miners || 0, pos); pos += 4;
      buffer.writeUInt32BE(data.difficulty || 0, pos); pos += 4;
      buffer.writeBigUInt64BE(BigInt(data.uptime || 0), pos); pos += 8;
      
      return pos - offset;
    });
    
    // Peer info encoder
    this.encoders.set(MessageType.PEER_INFO, (data, buffer, offset) => {
      let pos = offset;
      
      this.writePeerId(buffer, pos, data.peerId); pos += 16;
      buffer.writeUInt32BE(this.ipToInt(data.address), pos); pos += 4;
      buffer.writeUInt16BE(data.port, pos); pos += 2;
      buffer.writeDoubleLE(data.reputation || 1.0, pos); pos += 8;
      buffer.writeBigUInt64BE(BigInt(data.lastSeen || Date.now()), pos); pos += 8;
      
      return pos - offset;
    });
  }
  
  /**
   * Setup decoder functions for each message type
   */
  setupDecoders() {
    // Share decoder
    this.decoders.set(MessageType.SHARE, (buffer, offset, length) => {
      let pos = offset;
      
      const share = {
        jobId: this.readHash(buffer, pos), pos: pos += 32,
        nonce: buffer.readBigUInt64BE(pos), pos: pos += 8,
        timestamp: buffer.readBigUInt64BE(pos), pos: pos += 8,
        difficulty: buffer.readDoubleLE(pos), pos: pos += 8,
        hash: this.readHash(buffer, pos), pos: pos += 32,
        prevHash: this.readHash(buffer, pos), pos: pos += 32,
        merkleRoot: this.readHash(buffer, pos), pos: pos += 32,
        height: buffer.readUInt32BE(pos), pos: pos += 4
      };
      
      // Read variable data
      const extraNonceLen = buffer.readUInt16BE(pos); pos += 2;
      if (extraNonceLen > 0) {
        share.extraNonce = buffer.toString('hex', pos, pos + extraNonceLen);
        pos += extraNonceLen;
      }
      
      return share;
    });
    
    // Block decoder
    this.decoders.set(MessageType.BLOCK, (buffer, offset, length) => {
      let pos = offset;
      
      // Decode share part first
      const share = this.decoders.get(MessageType.SHARE)(buffer, pos, length);
      pos += this.getMessageSize(MessageType.SHARE, share);
      
      const block = {
        share,
        reward: buffer.readBigUInt64BE(pos), pos: pos += 8,
        txCount: buffer.readUInt32BE(pos), pos: pos += 4,
        size: buffer.readUInt32BE(pos), pos: pos += 4,
        version: buffer.readUInt32BE(pos), pos: pos += 4,
        bits: buffer.readUInt32BE(pos), pos: pos += 4,
        weight: buffer.readBigUInt64BE(pos), pos: pos += 8
      };
      
      return block;
    });
    
    // Work decoder
    this.decoders.set(MessageType.WORK, (buffer, offset, length) => {
      let pos = offset;
      
      return {
        jobId: this.readHash(buffer, pos), pos: pos += 32,
        target: this.readHash(buffer, pos), pos: pos += 32,
        prevHash: this.readHash(buffer, pos), pos: pos += 32,
        merkleRoot: this.readHash(buffer, pos), pos: pos += 32,
        algorithm: buffer.readUInt8(pos), pos: pos += 1,
        height: buffer.readUInt32BE(pos), pos: pos += 4,
        timestamp: buffer.readBigUInt64BE(pos), pos: pos += 8
      };
    });
    
    // Stats decoder
    this.decoders.set(MessageType.STATS, (buffer, offset, length) => {
      let pos = offset;
      
      return {
        hashrate: buffer.readDoubleLE(pos), pos: pos += 8,
        shares: buffer.readUInt32BE(pos), pos: pos += 4,
        blocks: buffer.readUInt32BE(pos), pos: pos += 4,
        miners: buffer.readUInt32BE(pos), pos: pos += 4,
        difficulty: buffer.readUInt32BE(pos), pos: pos += 4,
        uptime: buffer.readBigUInt64BE(pos), pos: pos += 8
      };
    });
    
    // Peer info decoder
    this.decoders.set(MessageType.PEER_INFO, (buffer, offset, length) => {
      let pos = offset;
      
      return {
        peerId: this.readPeerId(buffer, pos), pos: pos += 16,
        address: this.intToIp(buffer.readUInt32BE(pos)), pos: pos += 4,
        port: buffer.readUInt16BE(pos), pos: pos += 2,
        reputation: buffer.readDoubleLE(pos), pos: pos += 8,
        lastSeen: buffer.readBigUInt64BE(pos), pos: pos += 8
      };
    });
  }
  
  /**
   * Encode message to binary format
   */
  encode(type, data) {
    const encoder = this.encoders.get(type);
    if (!encoder) {
      throw new Error(`Unknown message type: ${type}`);
    }
    
    // Get buffer from pool
    const buffer = this.bufferPool.acquire();
    
    try {
      // Write header
      let pos = 0;
      buffer.writeUInt8(PROTOCOL_VERSION, pos); pos += 1;
      buffer.writeUInt8(type, pos); pos += 1;
      buffer.writeUInt16BE(0, pos); pos += 2; // flags
      
      // Skip length field, write it later
      const lengthPos = pos;
      pos += 4;
      
      // Write timestamp
      buffer.writeBigUInt64BE(BigInt(Date.now()), pos); pos += 8;
      
      // Write message body
      const bodySize = encoder(data, buffer, pos);
      const totalSize = SIZES.HEADER + bodySize;
      
      // Write length
      buffer.writeUInt32BE(totalSize, lengthPos);
      
      // Return a copy of the used portion
      return Buffer.from(buffer.subarray(0, totalSize));
      
    } finally {
      // Release buffer back to pool
      this.bufferPool.release(buffer);
    }
  }
  
  /**
   * Decode binary message
   */
  decode(buffer) {
    if (buffer.length < SIZES.HEADER) {
      throw new Error('Buffer too small for header');
    }
    
    // Read header
    let pos = 0;
    const version = buffer.readUInt8(pos); pos += 1;
    const type = buffer.readUInt8(pos); pos += 1;
    const flags = buffer.readUInt16BE(pos); pos += 2;
    const length = buffer.readUInt32BE(pos); pos += 4;
    const timestamp = buffer.readBigUInt64BE(pos); pos += 8;
    
    // Validate
    if (version !== PROTOCOL_VERSION) {
      throw new Error(`Unsupported protocol version: ${version}`);
    }
    
    if (buffer.length < length) {
      throw new Error(`Buffer too small: expected ${length}, got ${buffer.length}`);
    }
    
    // Decode body
    const decoder = this.decoders.get(type);
    if (!decoder) {
      throw new Error(`Unknown message type: ${type}`);
    }
    
    const data = decoder(buffer, SIZES.HEADER, length - SIZES.HEADER);
    
    return {
      type,
      flags,
      timestamp: Number(timestamp),
      data
    };
  }
  
  /**
   * Create a zero-copy view of binary data
   */
  createView(buffer, type) {
    // Return a proxy object that reads directly from buffer
    switch (type) {
      case MessageType.SHARE:
        return new ShareView(buffer, SIZES.HEADER);
      case MessageType.BLOCK:
        return new BlockView(buffer, SIZES.HEADER);
      case MessageType.WORK:
        return new WorkView(buffer, SIZES.HEADER);
      default:
        return null;
    }
  }
  
  /**
   * Helper methods
   */
  writeHash(buffer, offset, hash) {
    if (typeof hash === 'string') {
      buffer.write(hash.padStart(64, '0'), offset, 32, 'hex');
    } else if (Buffer.isBuffer(hash)) {
      hash.copy(buffer, offset, 0, 32);
    } else {
      buffer.fill(0, offset, offset + 32);
    }
  }
  
  readHash(buffer, offset) {
    return buffer.toString('hex', offset, offset + 32);
  }
  
  writePeerId(buffer, offset, peerId) {
    if (typeof peerId === 'string') {
      buffer.write(peerId.padStart(32, '0'), offset, 16, 'hex');
    } else if (Buffer.isBuffer(peerId)) {
      peerId.copy(buffer, offset, 0, 16);
    } else {
      buffer.fill(0, offset, offset + 16);
    }
  }
  
  readPeerId(buffer, offset) {
    return buffer.toString('hex', offset, offset + 16);
  }
  
  ipToInt(ip) {
    const parts = ip.split('.');
    return (parseInt(parts[0]) << 24) | 
           (parseInt(parts[1]) << 16) | 
           (parseInt(parts[2]) << 8) | 
           parseInt(parts[3]);
  }
  
  intToIp(int) {
    return `${(int >>> 24) & 255}.${(int >>> 16) & 255}.${(int >>> 8) & 255}.${int & 255}`;
  }
  
  getMessageSize(type, data) {
    switch (type) {
      case MessageType.SHARE:
        return SIZES.SHARE_HEADER + (data.extraNonce ? data.extraNonce.length + 2 : 2);
      case MessageType.BLOCK:
        return SIZES.BLOCK_HEADER + this.getMessageSize(MessageType.SHARE, data.share);
      case MessageType.WORK:
        return SIZES.WORK_HEADER + 13; // algorithm + height + timestamp
      case MessageType.STATS:
        return 32;
      case MessageType.PEER_INFO:
        return 38;
      default:
        return 0;
    }
  }
  
  /**
   * Batch encode multiple messages
   */
  batchEncode(messages) {
    const buffers = [];
    let totalSize = 0;
    
    // Encode each message
    for (const { type, data } of messages) {
      const encoded = this.encode(type, data);
      buffers.push(encoded);
      totalSize += encoded.length + 4; // +4 for message length prefix
    }
    
    // Combine into single buffer
    const combined = Buffer.allocUnsafe(totalSize);
    let offset = 0;
    
    for (const buffer of buffers) {
      combined.writeUInt32BE(buffer.length, offset);
      offset += 4;
      buffer.copy(combined, offset);
      offset += buffer.length;
    }
    
    return combined;
  }
  
  /**
   * Batch decode multiple messages
   */
  batchDecode(buffer) {
    const messages = [];
    let offset = 0;
    
    while (offset < buffer.length - 4) {
      const length = buffer.readUInt32BE(offset);
      offset += 4;
      
      if (offset + length > buffer.length) {
        break;
      }
      
      const messageBuffer = buffer.subarray(offset, offset + length);
      messages.push(this.decode(messageBuffer));
      offset += length;
    }
    
    return messages;
  }
}

/**
 * Zero-copy view classes for reading directly from buffer
 */
class ShareView {
  constructor(buffer, offset) {
    this.buffer = buffer;
    this.offset = offset;
  }
  
  get jobId() {
    return this.buffer.toString('hex', this.offset, this.offset + 32);
  }
  
  get nonce() {
    return this.buffer.readBigUInt64BE(this.offset + 32);
  }
  
  get timestamp() {
    return this.buffer.readBigUInt64BE(this.offset + 40);
  }
  
  get difficulty() {
    return this.buffer.readDoubleLE(this.offset + 48);
  }
  
  get hash() {
    return this.buffer.toString('hex', this.offset + 56, this.offset + 88);
  }
  
  get height() {
    return this.buffer.readUInt32BE(this.offset + 140);
  }
}

class BlockView extends ShareView {
  get reward() {
    return this.buffer.readBigUInt64BE(this.offset + 144);
  }
  
  get txCount() {
    return this.buffer.readUInt32BE(this.offset + 152);
  }
}

class WorkView {
  constructor(buffer, offset) {
    this.buffer = buffer;
    this.offset = offset;
  }
  
  get jobId() {
    return this.buffer.toString('hex', this.offset, this.offset + 32);
  }
  
  get target() {
    return this.buffer.toString('hex', this.offset + 32, this.offset + 64);
  }
  
  get prevHash() {
    return this.buffer.toString('hex', this.offset + 64, this.offset + 96);
  }
  
  get algorithm() {
    return this.buffer.readUInt8(this.offset + 128);
  }
}

export default BinaryProtocol;