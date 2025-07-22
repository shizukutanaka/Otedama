// Zero-Copy Network Protocol for High-Performance P2P Communication
// Minimizes memory allocations and copies for maximum throughput

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';
import net from 'net';
import { Buffer } from 'buffer';

const logger = createLogger('zero-copy-protocol');

// Protocol constants
const PROTOCOL_VERSION = 1;
const HEADER_SIZE = 16; // 4 bytes magic + 4 bytes version + 4 bytes type + 4 bytes length
const MAGIC_BYTES = Buffer.from([0x4F, 0x54, 0x44, 0x4D]); // 'OTDM'
const MAX_MESSAGE_SIZE = 16 * 1024 * 1024; // 16MB

// Message types
const MessageType = {
  // Core messages
  PING: 0x01,
  PONG: 0x02,
  HANDSHAKE: 0x03,
  DISCONNECT: 0x04,
  
  // Mining messages
  SHARE: 0x10,
  BLOCK: 0x11,
  WORK: 0x12,
  DIFFICULTY: 0x13,
  
  // P2P messages
  PEER_ANNOUNCE: 0x20,
  PEER_REQUEST: 0x21,
  PEER_RESPONSE: 0x22,
  
  // Data messages
  DATA_STORE: 0x30,
  DATA_RETRIEVE: 0x31,
  DATA_RESPONSE: 0x32,
  
  // Consensus messages
  CONSENSUS_PREPARE: 0x40,
  CONSENSUS_COMMIT: 0x41,
  CONSENSUS_VIEW_CHANGE: 0x42
};

export class ZeroCopyProtocol extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      poolSize: options.poolSize || 1000,
      bufferSize: options.bufferSize || 65536, // 64KB buffers
      compression: options.compression !== false,
      encryption: options.encryption !== false,
      ...options
    };
    
    // Buffer pools for zero-copy operation
    this.bufferPools = new Map();
    this.activeBuffers = new WeakMap();
    
    // Message handlers
    this.handlers = new Map();
    
    // Statistics
    this.stats = {
      messagesSent: 0,
      messagesReceived: 0,
      bytesTransmitted: 0,
      bytesReceived: 0,
      compressionRatio: 1.0,
      poolHits: 0,
      poolMisses: 0
    };
    
    this.initializeBufferPools();
    this.registerDefaultHandlers();
  }

  initializeBufferPools() {
    // Create buffer pools for different sizes
    const poolSizes = [
      1024,      // 1KB - small messages
      4096,      // 4KB - medium messages
      16384,     // 16KB - large messages
      65536,     // 64KB - extra large messages
      262144     // 256KB - huge messages
    ];
    
    for (const size of poolSizes) {
      this.bufferPools.set(size, {
        size: size,
        buffers: [],
        allocated: 0,
        inUse: 0
      });
      
      // Pre-allocate some buffers
      const preAllocCount = Math.max(10, Math.floor(this.config.poolSize / poolSizes.length));
      for (let i = 0; i < preAllocCount; i++) {
        this.allocateBuffer(size);
      }
    }
    
    logger.info(`Initialized buffer pools with ${poolSizes.length} size classes`);
  }

  allocateBuffer(size) {
    const pool = this.bufferPools.get(size);
    if (!pool) {
      throw new Error(`No buffer pool for size ${size}`);
    }
    
    const buffer = Buffer.allocUnsafe(size);
    pool.buffers.push(buffer);
    pool.allocated++;
    
    return buffer;
  }

  acquireBuffer(minSize) {
    // Find the smallest buffer pool that can accommodate the size
    let selectedPool = null;
    let selectedSize = Infinity;
    
    for (const [size, pool] of this.bufferPools) {
      if (size >= minSize && size < selectedSize) {
        selectedSize = size;
        selectedPool = pool;
      }
    }
    
    if (!selectedPool) {
      // No suitable pool, allocate directly
      this.stats.poolMisses++;
      return Buffer.allocUnsafe(minSize);
    }
    
    // Try to get a buffer from the pool
    if (selectedPool.buffers.length > 0) {
      this.stats.poolHits++;
      selectedPool.inUse++;
      return selectedPool.buffers.pop();
    }
    
    // Pool empty, allocate new buffer
    this.stats.poolMisses++;
    selectedPool.inUse++;
    return this.allocateBuffer(selectedSize);
  }

  releaseBuffer(buffer) {
    // Find which pool this buffer belongs to
    for (const [size, pool] of this.bufferPools) {
      if (buffer.length === size) {
        pool.inUse--;
        
        // Return to pool if not too many
        if (pool.buffers.length < this.config.poolSize / this.bufferPools.size) {
          pool.buffers.push(buffer);
        }
        return;
      }
    }
    
    // Buffer doesn't belong to any pool, let GC handle it
  }

  // Zero-copy message serialization
  serializeMessage(type, data, targetBuffer = null) {
    let payload;
    let payloadOffset = HEADER_SIZE;
    
    // Serialize based on message type
    switch (type) {
      case MessageType.SHARE:
        payload = this.serializeShare(data);
        break;
        
      case MessageType.BLOCK:
        payload = this.serializeBlock(data);
        break;
        
      case MessageType.PEER_ANNOUNCE:
        payload = this.serializePeerAnnounce(data);
        break;
        
      default:
        // Generic JSON serialization for unknown types
        payload = Buffer.from(JSON.stringify(data));
    }
    
    // Apply compression if enabled
    if (this.config.compression && payload.length > 1024) {
      payload = this.compress(payload);
    }
    
    // Calculate total size
    const totalSize = HEADER_SIZE + payload.length;
    
    // Use provided buffer or acquire new one
    const buffer = targetBuffer || this.acquireBuffer(totalSize);
    
    // Write header (zero-copy)
    MAGIC_BYTES.copy(buffer, 0);
    buffer.writeUInt32BE(PROTOCOL_VERSION, 4);
    buffer.writeUInt32BE(type, 8);
    buffer.writeUInt32BE(payload.length, 12);
    
    // Copy payload (this is the only copy operation)
    payload.copy(buffer, HEADER_SIZE);
    
    return buffer.slice(0, totalSize);
  }

  // Zero-copy message deserialization
  deserializeMessage(buffer, offset = 0) {
    if (buffer.length - offset < HEADER_SIZE) {
      throw new Error('Buffer too small for header');
    }
    
    // Read header without copying
    const magic = buffer.slice(offset, offset + 4);
    if (!magic.equals(MAGIC_BYTES)) {
      throw new Error('Invalid magic bytes');
    }
    
    const version = buffer.readUInt32BE(offset + 4);
    if (version !== PROTOCOL_VERSION) {
      throw new Error(`Unsupported protocol version: ${version}`);
    }
    
    const type = buffer.readUInt32BE(offset + 8);
    const length = buffer.readUInt32BE(offset + 12);
    
    if (length > MAX_MESSAGE_SIZE) {
      throw new Error(`Message too large: ${length} bytes`);
    }
    
    if (buffer.length - offset - HEADER_SIZE < length) {
      throw new Error('Incomplete message');
    }
    
    // Extract payload without copying (slice creates a view)
    let payload = buffer.slice(offset + HEADER_SIZE, offset + HEADER_SIZE + length);
    
    // Decompress if needed
    if (this.isCompressed(payload)) {
      payload = this.decompress(payload);
    }
    
    // Deserialize based on type
    let data;
    switch (type) {
      case MessageType.SHARE:
        data = this.deserializeShare(payload);
        break;
        
      case MessageType.BLOCK:
        data = this.deserializeBlock(payload);
        break;
        
      case MessageType.PEER_ANNOUNCE:
        data = this.deserializePeerAnnounce(payload);
        break;
        
      default:
        // Generic JSON deserialization
        data = JSON.parse(payload.toString());
    }
    
    return {
      type,
      data,
      consumed: HEADER_SIZE + length
    };
  }

  // Specialized serializers for zero-copy operation
  serializeShare(share) {
    // Fixed-size binary format for shares
    const buffer = Buffer.allocUnsafe(168); // Fixed size for share data
    let offset = 0;
    
    // Write share fields
    buffer.write(share.id || '', offset, 32, 'hex'); offset += 32;
    buffer.write(share.minerId || '', offset, 32, 'hex'); offset += 32;
    buffer.write(share.jobId || '', offset, 16, 'hex'); offset += 16;
    buffer.writeBigUInt64BE(BigInt(share.nonce || 0), offset); offset += 8;
    buffer.write(share.hash || '', offset, 32, 'hex'); offset += 32;
    buffer.write(share.difficulty || '', offset, 32, 'hex'); offset += 32;
    buffer.writeBigUInt64BE(BigInt(share.timestamp || Date.now()), offset); offset += 8;
    
    return buffer;
  }

  deserializeShare(buffer) {
    let offset = 0;
    
    return {
      id: buffer.toString('hex', offset, offset + 32), offset += 32,
      minerId: buffer.toString('hex', offset, offset + 32), offset += 32,
      jobId: buffer.toString('hex', offset, offset + 16), offset += 16,
      nonce: buffer.readBigUInt64BE(offset), offset += 8,
      hash: buffer.toString('hex', offset, offset + 32), offset += 32,
      difficulty: buffer.toString('hex', offset, offset + 32), offset += 32,
      timestamp: Number(buffer.readBigUInt64BE(offset))
    };
  }

  serializeBlock(block) {
    // Variable-size binary format for blocks
    const headerSize = 80; // Standard block header size
    const txCount = block.transactions ? block.transactions.length : 0;
    const buffer = Buffer.allocUnsafe(headerSize + 4 + txCount * 32);
    
    let offset = 0;
    
    // Block header
    buffer.writeUInt32LE(block.version || 1, offset); offset += 4;
    buffer.write(block.previousHash || '', offset, 32, 'hex'); offset += 32;
    buffer.write(block.merkleRoot || '', offset, 32, 'hex'); offset += 32;
    buffer.writeUInt32LE(block.timestamp || Math.floor(Date.now() / 1000), offset); offset += 4;
    buffer.writeUInt32LE(block.bits || 0, offset); offset += 4;
    buffer.writeUInt32LE(block.nonce || 0, offset); offset += 4;
    
    // Transaction count
    buffer.writeUInt32LE(txCount, offset); offset += 4;
    
    // Transaction hashes (simplified)
    if (block.transactions) {
      for (const tx of block.transactions) {
        buffer.write(tx.hash || tx, offset, 32, 'hex');
        offset += 32;
      }
    }
    
    return buffer.slice(0, offset);
  }

  deserializeBlock(buffer) {
    let offset = 0;
    
    const block = {
      version: buffer.readUInt32LE(offset), offset += 4,
      previousHash: buffer.toString('hex', offset, offset + 32), offset += 32,
      merkleRoot: buffer.toString('hex', offset, offset + 32), offset += 32,
      timestamp: buffer.readUInt32LE(offset), offset += 4,
      bits: buffer.readUInt32LE(offset), offset += 4,
      nonce: buffer.readUInt32LE(offset), offset += 4
    };
    
    const txCount = buffer.readUInt32LE(offset); offset += 4;
    block.transactions = [];
    
    for (let i = 0; i < txCount && offset + 32 <= buffer.length; i++) {
      block.transactions.push(buffer.toString('hex', offset, offset + 32));
      offset += 32;
    }
    
    return block;
  }

  serializePeerAnnounce(peer) {
    // Fixed-size format for peer announcements
    const buffer = Buffer.allocUnsafe(54);
    let offset = 0;
    
    // Node ID (32 bytes)
    buffer.write(peer.id || '', offset, 32, 'hex'); offset += 32;
    
    // IP address (4 bytes for IPv4, using 0s for padding)
    const ipParts = (peer.address || '0.0.0.0').split('.');
    for (let i = 0; i < 4; i++) {
      buffer.writeUInt8(parseInt(ipParts[i] || 0), offset++);
    }
    
    // Port (2 bytes)
    buffer.writeUInt16BE(peer.port || 0, offset); offset += 2;
    
    // Flags (4 bytes)
    buffer.writeUInt32BE(peer.flags || 0, offset); offset += 4;
    
    // Timestamp (8 bytes)
    buffer.writeBigUInt64BE(BigInt(peer.timestamp || Date.now()), offset);
    
    return buffer;
  }

  deserializePeerAnnounce(buffer) {
    let offset = 0;
    
    const peer = {
      id: buffer.toString('hex', offset, offset + 32), offset += 32,
      address: `${buffer[offset]}.${buffer[offset+1]}.${buffer[offset+2]}.${buffer[offset+3]}`,
      port: buffer.readUInt16BE(offset + 4),
      flags: buffer.readUInt32BE(offset + 6),
      timestamp: Number(buffer.readBigUInt64BE(offset + 10))
    };
    
    return peer;
  }

  // Compression support
  compress(buffer) {
    // Use built-in zlib for compression
    const zlib = require('zlib');
    const compressed = zlib.deflateSync(buffer);
    
    // Add compression header
    const result = Buffer.allocUnsafe(compressed.length + 1);
    result[0] = 0x01; // Compression flag
    compressed.copy(result, 1);
    
    this.stats.compressionRatio = compressed.length / buffer.length;
    
    return result;
  }

  decompress(buffer) {
    const zlib = require('zlib');
    return zlib.inflateSync(buffer.slice(1));
  }

  isCompressed(buffer) {
    return buffer.length > 0 && buffer[0] === 0x01;
  }

  // Network handling with zero-copy
  createConnection(host, port) {
    const socket = net.createConnection({ host, port });
    
    // Set socket options for performance
    socket.setNoDelay(true); // Disable Nagle's algorithm
    socket.setKeepAlive(true, 60000); // Keep-alive every 60 seconds
    
    // Use a single large buffer for receiving
    const receiveBuffer = this.acquireBuffer(1024 * 1024); // 1MB receive buffer
    let receiveOffset = 0;
    
    socket.on('data', (chunk) => {
      // Copy incoming data to receive buffer
      if (receiveOffset + chunk.length > receiveBuffer.length) {
        // Buffer full, process messages
        this.processReceiveBuffer(socket, receiveBuffer, receiveOffset);
        receiveOffset = 0;
      }
      
      chunk.copy(receiveBuffer, receiveOffset);
      receiveOffset += chunk.length;
      
      // Try to process complete messages
      receiveOffset = this.processReceiveBuffer(socket, receiveBuffer, receiveOffset);
    });
    
    socket.on('close', () => {
      this.releaseBuffer(receiveBuffer);
    });
    
    // Store socket reference for zero-copy sending
    this.activeBuffers.set(socket, new Map());
    
    return socket;
  }

  processReceiveBuffer(socket, buffer, length) {
    let offset = 0;
    
    while (offset < length) {
      try {
        const remaining = length - offset;
        if (remaining < HEADER_SIZE) {
          // Incomplete header, wait for more data
          break;
        }
        
        // Peek at message length
        const messageLength = buffer.readUInt32BE(offset + 12) + HEADER_SIZE;
        
        if (remaining < messageLength) {
          // Incomplete message, wait for more data
          break;
        }
        
        // Process complete message
        const message = this.deserializeMessage(buffer, offset);
        offset += message.consumed;
        
        // Handle message
        this.handleMessage(socket, message.type, message.data);
        
        this.stats.messagesReceived++;
        this.stats.bytesReceived += message.consumed;
        
      } catch (error) {
        logger.error('Error processing message:', error);
        offset = length; // Skip remaining data
      }
    }
    
    // Move remaining data to beginning of buffer
    if (offset < length) {
      buffer.copy(buffer, 0, offset, length);
      return length - offset;
    }
    
    return 0;
  }

  // Zero-copy send implementation
  send(socket, type, data) {
    try {
      // Get or create send buffer for this socket
      let sendBuffers = this.activeBuffers.get(socket);
      if (!sendBuffers) {
        sendBuffers = new Map();
        this.activeBuffers.set(socket, sendBuffers);
      }
      
      // Serialize message
      const message = this.serializeMessage(type, data);
      
      // Send directly without copying
      socket.write(message, (error) => {
        if (error) {
          logger.error('Send error:', error);
        } else {
          this.stats.messagesSent++;
          this.stats.bytesTransmitted += message.length;
        }
        
        // Return buffer to pool
        this.releaseBuffer(message);
      });
      
    } catch (error) {
      logger.error('Error sending message:', error);
      throw error;
    }
  }

  // Batch send for efficiency
  sendBatch(socket, messages) {
    // Calculate total size
    let totalSize = 0;
    const serialized = [];
    
    for (const { type, data } of messages) {
      const msg = this.serializeMessage(type, data);
      serialized.push(msg);
      totalSize += msg.length;
    }
    
    // Allocate single buffer for entire batch
    const batchBuffer = this.acquireBuffer(totalSize);
    let offset = 0;
    
    // Copy all messages to batch buffer
    for (const msg of serialized) {
      msg.copy(batchBuffer, offset);
      offset += msg.length;
      this.releaseBuffer(msg);
    }
    
    // Send entire batch in one syscall
    socket.write(batchBuffer.slice(0, offset), (error) => {
      if (error) {
        logger.error('Batch send error:', error);
      } else {
        this.stats.messagesSent += messages.length;
        this.stats.bytesTransmitted += offset;
      }
      
      this.releaseBuffer(batchBuffer);
    });
  }

  // Message handling
  registerDefaultHandlers() {
    this.handlers.set(MessageType.PING, (socket, data) => {
      this.send(socket, MessageType.PONG, { timestamp: Date.now() });
    });
    
    this.handlers.set(MessageType.PONG, (socket, data) => {
      const latency = Date.now() - data.timestamp;
      this.emit('latency', { socket, latency });
    });
  }

  registerHandler(type, handler) {
    this.handlers.set(type, handler);
  }

  handleMessage(socket, type, data) {
    const handler = this.handlers.get(type);
    if (handler) {
      handler(socket, data);
    } else {
      this.emit('message', { socket, type, data });
    }
  }

  // Statistics
  getStatistics() {
    const poolStats = {};
    
    for (const [size, pool] of this.bufferPools) {
      poolStats[size] = {
        allocated: pool.allocated,
        inUse: pool.inUse,
        available: pool.buffers.length
      };
    }
    
    return {
      ...this.stats,
      pools: poolStats,
      poolEfficiency: this.stats.poolHits / (this.stats.poolHits + this.stats.poolMisses)
    };
  }

  // Cleanup
  cleanup() {
    // Clear all buffer pools
    for (const pool of this.bufferPools.values()) {
      pool.buffers = [];
      pool.allocated = 0;
      pool.inUse = 0;
    }
    
    logger.info('Zero-copy protocol cleaned up');
  }
}

export { MessageType };
export default ZeroCopyProtocol;