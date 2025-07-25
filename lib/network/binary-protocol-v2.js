/**
 * High-Performance Binary Protocol for Otedama
 * Zero-copy, low-latency network protocol
 * 
 * Design: 
 * - Carmack: Zero-copy operations, minimal allocations
 * - Pike: Simple but efficient wire format
 * - Martin: Clean protocol abstraction
 */

import { Buffer } from 'buffer';
import { EventEmitter } from 'events';
import crypto from 'crypto';

// Protocol constants
const PROTOCOL_VERSION = 2;
const MAGIC_BYTES = Buffer.from([0x4F, 0x54, 0x45, 0x44]); // "OTED"
const MAX_PACKET_SIZE = 16 * 1024 * 1024; // 16MB
const HEADER_SIZE = 20; // 4 magic + 2 version + 2 type + 4 length + 8 checksum

// Message types
export const MessageType = {
  // Core messages
  HANDSHAKE: 0x01,
  HANDSHAKE_ACK: 0x02,
  PING: 0x03,
  PONG: 0x04,
  ERROR: 0x05,
  
  // Mining messages  
  MINING_SUBSCRIBE: 0x10,
  MINING_NOTIFY: 0x11,
  MINING_SUBMIT: 0x12,
  MINING_SET_DIFFICULTY: 0x13,
  MINING_SET_EXTRANONCE: 0x14,
  
  // Pool messages
  POOL_STATUS: 0x20,
  POOL_STATS: 0x21,
  MINER_STATS: 0x22,
  SHARE_ACCEPTED: 0x23,
  SHARE_REJECTED: 0x24,
  
  // Payment messages
  PAYMENT_INFO: 0x30,
  BALANCE_UPDATE: 0x31,
  PAYOUT_NOTIFICATION: 0x32,
  
  // P2P messages
  PEER_ANNOUNCE: 0x40,
  PEER_REQUEST: 0x41,
  PEER_RESPONSE: 0x42,
  BLOCK_FOUND: 0x43,
  
  // Binary data
  BINARY_CHUNK: 0xF0,
  BINARY_STREAM_START: 0xF1,
  BINARY_STREAM_DATA: 0xF2,
  BINARY_STREAM_END: 0xF3
};

// Compression types
export const CompressionType = {
  NONE: 0x00,
  ZLIB: 0x01,
  LZ4: 0x02,
  ZSTD: 0x03
};

/**
 * Optimized buffer pool for zero-copy operations
 */
class BufferPool {
  constructor() {
    this.pools = new Map([
      [256, []],
      [1024, []],
      [4096, []],
      [16384, []],
      [65536, []]
    ]);
    this.maxPoolSize = 100;
  }
  
  acquire(size) {
    // Find the smallest pool that fits
    for (const [poolSize, pool] of this.pools) {
      if (poolSize >= size && pool.length > 0) {
        return pool.pop();
      }
    }
    
    // Allocate new buffer
    const allocSize = this.getAllocSize(size);
    return Buffer.allocUnsafe(allocSize);
  }
  
  release(buffer) {
    const size = buffer.length;
    
    // Find matching pool
    for (const [poolSize, pool] of this.pools) {
      if (poolSize === size && pool.length < this.maxPoolSize) {
        buffer.fill(0); // Clear sensitive data
        pool.push(buffer);
        return;
      }
    }
    
    // Buffer doesn't fit any pool, let GC handle it
  }
  
  getAllocSize(size) {
    for (const [poolSize] of this.pools) {
      if (poolSize >= size) return poolSize;
    }
    return size; // Custom size
  }
  
  clear() {
    for (const pool of this.pools.values()) {
      pool.length = 0;
    }
  }
}

// Global buffer pool
const bufferPool = new BufferPool();

/**
 * High-performance message encoder/decoder
 */
export class BinaryProtocol {
  constructor(options = {}) {
    this.version = options.version || PROTOCOL_VERSION;
    this.compression = options.compression || CompressionType.NONE;
    this.checksumEnabled = options.checksum !== false;
  }
  
  /**
   * Encode message to binary format
   */
  encode(type, payload, options = {}) {
    // Serialize payload
    const payloadBuffer = this.serializePayload(payload);
    
    // Compress if needed
    const compressed = this.compress(payloadBuffer, options.compression || this.compression);
    
    // Allocate header buffer
    const header = bufferPool.acquire(HEADER_SIZE);
    let offset = 0;
    
    // Write magic bytes
    MAGIC_BYTES.copy(header, offset);
    offset += 4;
    
    // Write version
    header.writeUInt16BE(this.version, offset);
    offset += 2;
    
    // Write message type
    header.writeUInt16BE(type, offset);
    offset += 2;
    
    // Write payload length
    header.writeUInt32BE(compressed.length, offset);
    offset += 4;
    
    // Calculate and write checksum
    if (this.checksumEnabled) {
      const checksum = this.calculateChecksum(compressed);
      checksum.copy(header, offset, 0, 8);
    } else {
      header.fill(0, offset, offset + 8);
    }
    
    // Return combined buffer (zero-copy)
    return {
      header: header.slice(0, HEADER_SIZE),
      payload: compressed,
      release: () => {
        bufferPool.release(header);
        if (compressed !== payloadBuffer) {
          bufferPool.release(compressed);
        }
        bufferPool.release(payloadBuffer);
      }
    };
  }
  
  /**
   * Decode binary message
   */
  decode(header, payload) {
    if (header.length < HEADER_SIZE) {
      throw new Error('Invalid header size');
    }
    
    let offset = 0;
    
    // Verify magic bytes
    if (!header.slice(offset, offset + 4).equals(MAGIC_BYTES)) {
      throw new Error('Invalid magic bytes');
    }
    offset += 4;
    
    // Read version
    const version = header.readUInt16BE(offset);
    if (version !== this.version) {
      throw new Error(`Unsupported protocol version: ${version}`);
    }
    offset += 2;
    
    // Read message type
    const type = header.readUInt16BE(offset);
    offset += 2;
    
    // Read payload length
    const length = header.readUInt32BE(offset);
    offset += 4;
    
    // Verify checksum if enabled
    if (this.checksumEnabled) {
      const expectedChecksum = header.slice(offset, offset + 8);
      const actualChecksum = this.calculateChecksum(payload);
      
      if (!expectedChecksum.slice(0, 8).equals(actualChecksum.slice(0, 8))) {
        throw new Error('Checksum mismatch');
      }
    }
    
    // Decompress payload
    const decompressed = this.decompress(payload);
    
    // Deserialize payload
    const data = this.deserializePayload(decompressed);
    
    return {
      type,
      data,
      version,
      length
    };
  }
  
  /**
   * Stream encoder for large messages
   */
  createEncoder(type, streamId = crypto.randomBytes(16)) {
    const encoder = new EventEmitter();
    let sequence = 0;
    
    encoder.start = () => {
      const msg = this.encode(MessageType.BINARY_STREAM_START, {
        streamId,
        type,
        timestamp: Date.now()
      });
      encoder.emit('data', msg);
    };
    
    encoder.write = (chunk) => {
      const msg = this.encode(MessageType.BINARY_STREAM_DATA, {
        streamId,
        sequence: sequence++,
        data: chunk
      });
      encoder.emit('data', msg);
    };
    
    encoder.end = () => {
      const msg = this.encode(MessageType.BINARY_STREAM_END, {
        streamId,
        sequence,
        checksum: null // TODO: Add stream checksum
      });
      encoder.emit('data', msg);
    };
    
    return encoder;
  }
  
  /**
   * Stream decoder for large messages
   */
  createDecoder() {
    const decoder = new EventEmitter();
    const streams = new Map();
    
    decoder.handleMessage = (msg) => {
      switch (msg.type) {
        case MessageType.BINARY_STREAM_START: {
          const stream = {
            id: msg.data.streamId,
            type: msg.data.type,
            chunks: [],
            started: msg.data.timestamp
          };
          streams.set(msg.data.streamId.toString('hex'), stream);
          decoder.emit('stream:start', stream);
          break;
        }
        
        case MessageType.BINARY_STREAM_DATA: {
          const streamKey = msg.data.streamId.toString('hex');
          const stream = streams.get(streamKey);
          if (stream) {
            stream.chunks[msg.data.sequence] = msg.data.data;
            decoder.emit('stream:data', stream, msg.data);
          }
          break;
        }
        
        case MessageType.BINARY_STREAM_END: {
          const streamKey = msg.data.streamId.toString('hex');
          const stream = streams.get(streamKey);
          if (stream) {
            // Combine chunks
            const combined = Buffer.concat(stream.chunks);
            streams.delete(streamKey);
            decoder.emit('stream:end', stream, combined);
          }
          break;
        }
      }
    };
    
    return decoder;
  }
  
  // Private methods
  
  serializePayload(payload) {
    if (Buffer.isBuffer(payload)) {
      return payload;
    }
    
    const json = JSON.stringify(payload);
    const buffer = bufferPool.acquire(Buffer.byteLength(json));
    buffer.write(json, 0, 'utf8');
    return buffer.slice(0, Buffer.byteLength(json));
  }
  
  deserializePayload(buffer) {
    try {
      return JSON.parse(buffer.toString('utf8'));
    } catch {
      return buffer; // Return as raw buffer if not JSON
    }
  }
  
  compress(buffer, type) {
    if (type === CompressionType.NONE) {
      return buffer;
    }
    
    // Implement compression based on type
    // For now, return uncompressed
    return buffer;
  }
  
  decompress(buffer) {
    // Implement decompression
    // For now, return as-is
    return buffer;
  }
  
  calculateChecksum(buffer) {
    return crypto.createHash('sha256').update(buffer).digest();
  }
}

/**
 * Optimized message framer for TCP streams
 */
export class MessageFramer extends EventEmitter {
  constructor(protocol = new BinaryProtocol()) {
    super();
    
    this.protocol = protocol;
    this.headerBuffer = Buffer.allocUnsafe(HEADER_SIZE);
    this.headerOffset = 0;
    this.payloadBuffer = null;
    this.payloadOffset = 0;
    this.expectedLength = 0;
    this.state = 'header'; // 'header' or 'payload'
  }
  
  /**
   * Process incoming data
   */
  processData(chunk) {
    let offset = 0;
    
    while (offset < chunk.length) {
      if (this.state === 'header') {
        // Read header
        const headerRemaining = HEADER_SIZE - this.headerOffset;
        const toCopy = Math.min(headerRemaining, chunk.length - offset);
        
        chunk.copy(this.headerBuffer, this.headerOffset, offset, offset + toCopy);
        this.headerOffset += toCopy;
        offset += toCopy;
        
        if (this.headerOffset === HEADER_SIZE) {
          // Header complete, parse it
          try {
            this.expectedLength = this.headerBuffer.readUInt32BE(8);
            
            if (this.expectedLength > MAX_PACKET_SIZE) {
              this.emit('error', new Error('Packet too large'));
              this.reset();
              continue;
            }
            
            this.payloadBuffer = bufferPool.acquire(this.expectedLength);
            this.payloadOffset = 0;
            this.state = 'payload';
          } catch (error) {
            this.emit('error', error);
            this.reset();
          }
        }
      } else {
        // Read payload
        const payloadRemaining = this.expectedLength - this.payloadOffset;
        const toCopy = Math.min(payloadRemaining, chunk.length - offset);
        
        chunk.copy(this.payloadBuffer, this.payloadOffset, offset, offset + toCopy);
        this.payloadOffset += toCopy;
        offset += toCopy;
        
        if (this.payloadOffset === this.expectedLength) {
          // Message complete
          try {
            const message = this.protocol.decode(
              this.headerBuffer,
              this.payloadBuffer.slice(0, this.expectedLength)
            );
            
            this.emit('message', message);
          } catch (error) {
            this.emit('error', error);
          } finally {
            bufferPool.release(this.payloadBuffer);
            this.reset();
          }
        }
      }
    }
  }
  
  reset() {
    this.headerOffset = 0;
    this.payloadBuffer = null;
    this.payloadOffset = 0;
    this.expectedLength = 0;
    this.state = 'header';
  }
}

/**
 * Message builder for common protocol messages
 */
export class MessageBuilder {
  constructor(protocol = new BinaryProtocol()) {
    this.protocol = protocol;
  }
  
  // Core messages
  handshake(peerId, capabilities = {}) {
    return this.protocol.encode(MessageType.HANDSHAKE, {
      peerId,
      version: PROTOCOL_VERSION,
      capabilities,
      timestamp: Date.now()
    });
  }
  
  handshakeAck(peerId, accepted = true) {
    return this.protocol.encode(MessageType.HANDSHAKE_ACK, {
      peerId,
      accepted,
      timestamp: Date.now()
    });
  }
  
  ping(nonce = crypto.randomBytes(8)) {
    return this.protocol.encode(MessageType.PING, {
      nonce,
      timestamp: Date.now()
    });
  }
  
  pong(nonce) {
    return this.protocol.encode(MessageType.PONG, {
      nonce,
      timestamp: Date.now()
    });
  }
  
  error(code, message, details = {}) {
    return this.protocol.encode(MessageType.ERROR, {
      code,
      message,
      details,
      timestamp: Date.now()
    });
  }
  
  // Mining messages
  miningSubscribe(minerName, sessionId = null) {
    return this.protocol.encode(MessageType.MINING_SUBSCRIBE, {
      minerName,
      sessionId,
      timestamp: Date.now()
    });
  }
  
  miningNotify(jobId, prevHash, merkleRoot, timestamp, bits, cleanJobs = false) {
    return this.protocol.encode(MessageType.MINING_NOTIFY, {
      jobId,
      prevHash,
      merkleRoot,
      timestamp,
      bits,
      cleanJobs
    });
  }
  
  miningSubmit(minerName, jobId, extranonce2, ntime, nonce) {
    return this.protocol.encode(MessageType.MINING_SUBMIT, {
      minerName,
      jobId,
      extranonce2,
      ntime,
      nonce,
      timestamp: Date.now()
    });
  }
  
  setDifficulty(difficulty) {
    return this.protocol.encode(MessageType.MINING_SET_DIFFICULTY, {
      difficulty,
      timestamp: Date.now()
    });
  }
  
  // Pool messages
  poolStatus(miners, hashrate, lastBlock) {
    return this.protocol.encode(MessageType.POOL_STATUS, {
      miners,
      hashrate,
      lastBlock,
      timestamp: Date.now()
    });
  }
  
  minerStats(minerId, hashrate, shares, balance) {
    return this.protocol.encode(MessageType.MINER_STATS, {
      minerId,
      hashrate,
      shares,
      balance,
      timestamp: Date.now()
    });
  }
  
  shareAccepted(shareId, difficulty, reward = null) {
    return this.protocol.encode(MessageType.SHARE_ACCEPTED, {
      shareId,
      difficulty,
      reward,
      timestamp: Date.now()
    });
  }
  
  shareRejected(shareId, reason) {
    return this.protocol.encode(MessageType.SHARE_REJECTED, {
      shareId,
      reason,
      timestamp: Date.now()
    });
  }
}

// Export buffer pool for external use
export { bufferPool };

export default {
  BinaryProtocol,
  MessageFramer,
  MessageBuilder,
  MessageType,
  CompressionType,
  bufferPool,
  PROTOCOL_VERSION,
  MAX_PACKET_SIZE
};
