/**
 * Binary Protocol Implementation
 * High-performance binary serialization for network communication
 */

const { BaseService } = require('../common/base-service');
const crypto = require('crypto');
const varint = require('varint');

// Protocol constants
const PROTOCOL_VERSION = 1;
const MAGIC_BYTES = Buffer.from([0x4F, 0x54, 0x45, 0x44]); // OTED in hex

// Message types
const MessageTypes = {
  // Core messages
  HANDSHAKE: 0x01,
  HEARTBEAT: 0x02,
  ACK: 0x03,
  ERROR: 0x04,
  
  // Mining messages
  WORK_REQUEST: 0x10,
  WORK_RESPONSE: 0x11,
  SHARE_SUBMIT: 0x12,
  SHARE_RESULT: 0x13,
  DIFFICULTY_UPDATE: 0x14,
  
  // Pool messages
  MINER_CONNECT: 0x20,
  MINER_DISCONNECT: 0x21,
  STATS_REQUEST: 0x22,
  STATS_RESPONSE: 0x23,
  PAYMENT_NOTIFY: 0x24,
  
  // Block messages
  BLOCK_NOTIFY: 0x30,
  BLOCK_FOUND: 0x31,
  BLOCK_CONFIRMED: 0x32,
  
  // Custom messages
  CUSTOM: 0xFF
};

// Compression algorithms
const CompressionTypes = {
  NONE: 0x00,
  GZIP: 0x01,
  ZSTD: 0x02,
  LZ4: 0x03
};

class BinaryProtocol extends BaseService {
  constructor(options = {}) {
    super('BinaryProtocol', {
      // Protocol configuration
      version: options.version || PROTOCOL_VERSION,
      compressionThreshold: options.compressionThreshold || 1024, // Compress messages > 1KB
      defaultCompression: options.defaultCompression || CompressionTypes.GZIP,
      enableEncryption: options.enableEncryption !== false,
      encryptionAlgorithm: options.encryptionAlgorithm || 'aes-256-gcm',
      
      // Performance
      enableCaching: options.enableCaching !== false,
      cacheSize: options.cacheSize || 1000,
      cacheTTL: options.cacheTTL || 60000, // 1 minute
      
      // Validation
      strictMode: options.strictMode !== false,
      maxMessageSize: options.maxMessageSize || 10 * 1024 * 1024, // 10MB
      
      ...options
    });
    
    // Message handlers
    this.messageHandlers = new Map();
    
    // Schema definitions
    this.schemas = new Map();
    this.initializeSchemas();
    
    // Caching
    this.encodingCache = new Map();
    this.decodingCache = new Map();
    
    // Encryption keys
    this.encryptionKeys = new Map();
    
    // Statistics
    this.protocolStats = {
      messagesEncoded: 0,
      messagesDecoded: 0,
      bytesEncoded: 0,
      bytesDecoded: 0,
      compressionSavings: 0,
      cacheHits: 0,
      cacheMisses: 0,
      errors: 0
    };
  }
  
  /**
   * Initialize message schemas
   */
  initializeSchemas() {
    // Handshake schema
    this.defineSchema(MessageTypes.HANDSHAKE, {
      version: 'uint8',
      clientId: 'string',
      timestamp: 'uint64',
      capabilities: 'uint32',
      userAgent: 'string'
    });
    
    // Share submit schema
    this.defineSchema(MessageTypes.SHARE_SUBMIT, {
      jobId: 'bytes32',
      nonce: 'uint64',
      extraNonce: 'bytes',
      timestamp: 'uint64',
      workerId: 'string'
    });
    
    // Share result schema
    this.defineSchema(MessageTypes.SHARE_RESULT, {
      shareId: 'bytes32',
      accepted: 'bool',
      reason: 'string?', // Optional string
      difficulty: 'float64',
      reward: 'uint64?'
    });
    
    // Work response schema
    this.defineSchema(MessageTypes.WORK_RESPONSE, {
      jobId: 'bytes32',
      prevHash: 'bytes32',
      merkleRoot: 'bytes32',
      timestamp: 'uint32',
      bits: 'uint32',
      nonce: 'uint32',
      height: 'uint64',
      coinbase1: 'bytes',
      coinbase2: 'bytes',
      merkleBranch: 'array:bytes32'
    });
    
    // Stats response schema
    this.defineSchema(MessageTypes.STATS_RESPONSE, {
      hashrate: 'float64',
      sharesAccepted: 'uint64',
      sharesRejected: 'uint64',
      uptime: 'uint64',
      workers: 'array:object',
      earnings: 'object'
    });
    
    // Block notify schema
    this.defineSchema(MessageTypes.BLOCK_NOTIFY, {
      height: 'uint64',
      hash: 'bytes32',
      previousHash: 'bytes32',
      timestamp: 'uint64',
      difficulty: 'float64',
      reward: 'uint64',
      minerAddress: 'string'
    });
  }
  
  /**
   * Define a message schema
   */
  defineSchema(messageType, schema) {
    this.schemas.set(messageType, schema);
  }
  
  /**
   * Encode a message to binary format
   */
  async encode(messageType, data, options = {}) {
    try {
      // Check cache
      const cacheKey = this.getCacheKey(messageType, data);
      if (this.config.enableCaching && this.encodingCache.has(cacheKey)) {
        const cached = this.encodingCache.get(cacheKey);
        if (Date.now() - cached.timestamp < this.config.cacheTTL) {
          this.protocolStats.cacheHits++;
          return cached.buffer;
        }
      }
      
      this.protocolStats.cacheMisses++;
      
      // Get schema
      const schema = this.schemas.get(messageType);
      if (!schema && this.config.strictMode) {
        throw new Error(`Unknown message type: ${messageType}`);
      }
      
      // Create message buffer
      const messageBuffer = schema 
        ? this.encodeWithSchema(data, schema)
        : this.encodeRaw(data);
      
      // Apply compression if needed
      let finalBuffer = messageBuffer;
      let compressionType = CompressionTypes.NONE;
      
      if (messageBuffer.length > this.config.compressionThreshold) {
        const compressed = await this.compress(messageBuffer, options.compression);
        if (compressed.length < messageBuffer.length * 0.9) {
          finalBuffer = compressed;
          compressionType = options.compression || this.config.defaultCompression;
          this.protocolStats.compressionSavings += messageBuffer.length - compressed.length;
        }
      }
      
      // Create header
      const header = this.createHeader(messageType, finalBuffer.length, compressionType, options);
      
      // Combine header and body
      let completeMessage = Buffer.concat([header, finalBuffer]);
      
      // Apply encryption if enabled
      if (this.config.enableEncryption && options.encrypt !== false) {
        completeMessage = await this.encrypt(completeMessage, options.encryptionKey);
      }
      
      // Update stats
      this.protocolStats.messagesEncoded++;
      this.protocolStats.bytesEncoded += completeMessage.length;
      
      // Cache the result
      if (this.config.enableCaching) {
        this.encodingCache.set(cacheKey, {
          buffer: completeMessage,
          timestamp: Date.now()
        });
        
        // Evict old entries if cache is full
        if (this.encodingCache.size > this.config.cacheSize) {
          const firstKey = this.encodingCache.keys().next().value;
          this.encodingCache.delete(firstKey);
        }
      }
      
      return completeMessage;
      
    } catch (error) {
      this.protocolStats.errors++;
      this.recordFailure(error);
      throw error;
    }
  }
  
  /**
   * Decode a binary message
   */
  async decode(buffer, options = {}) {
    try {
      // Validate buffer
      if (!Buffer.isBuffer(buffer)) {
        throw new Error('Invalid buffer');
      }
      
      if (buffer.length < 16) { // Minimum header size
        throw new Error('Buffer too small');
      }
      
      // Decrypt if needed
      let decryptedBuffer = buffer;
      if (this.isEncrypted(buffer)) {
        decryptedBuffer = await this.decrypt(buffer, options.decryptionKey);
      }
      
      // Parse header
      const header = this.parseHeader(decryptedBuffer);
      
      // Validate magic bytes
      if (!header.magic.equals(MAGIC_BYTES)) {
        throw new Error('Invalid magic bytes');
      }
      
      // Extract message body
      const bodyStart = header.headerSize;
      const bodyEnd = bodyStart + header.messageSize;
      
      if (bodyEnd > decryptedBuffer.length) {
        throw new Error('Incomplete message');
      }
      
      let messageBuffer = decryptedBuffer.slice(bodyStart, bodyEnd);
      
      // Decompress if needed
      if (header.compressionType !== CompressionTypes.NONE) {
        messageBuffer = await this.decompress(messageBuffer, header.compressionType);
      }
      
      // Decode message based on schema
      const schema = this.schemas.get(header.messageType);
      const data = schema 
        ? this.decodeWithSchema(messageBuffer, schema)
        : this.decodeRaw(messageBuffer);
      
      // Update stats
      this.protocolStats.messagesDecoded++;
      this.protocolStats.bytesDecoded += buffer.length;
      
      return {
        type: header.messageType,
        data,
        metadata: {
          version: header.version,
          timestamp: header.timestamp,
          messageId: header.messageId,
          flags: header.flags
        }
      };
      
    } catch (error) {
      this.protocolStats.errors++;
      this.recordFailure(error);
      throw error;
    }
  }
  
  /**
   * Create message header
   */
  createHeader(messageType, messageSize, compressionType, options = {}) {
    const header = Buffer.allocUnsafe(32);
    let offset = 0;
    
    // Magic bytes (4 bytes)
    MAGIC_BYTES.copy(header, offset);
    offset += 4;
    
    // Version (1 byte)
    header.writeUInt8(this.config.version, offset);
    offset += 1;
    
    // Message type (1 byte)
    header.writeUInt8(messageType, offset);
    offset += 1;
    
    // Compression type (1 byte)
    header.writeUInt8(compressionType, offset);
    offset += 1;
    
    // Flags (1 byte)
    let flags = 0;
    if (options.reliable) flags |= 0x01;
    if (options.ordered) flags |= 0x02;
    if (options.priority) flags |= 0x04;
    header.writeUInt8(flags, offset);
    offset += 1;
    
    // Message size (4 bytes)
    header.writeUInt32LE(messageSize, offset);
    offset += 4;
    
    // Timestamp (8 bytes)
    const timestamp = Date.now();
    header.writeBigUInt64LE(BigInt(timestamp), offset);
    offset += 8;
    
    // Message ID (8 bytes)
    const messageId = options.messageId || crypto.randomBytes(8);
    messageId.copy(header, offset, 0, 8);
    offset += 8;
    
    // Reserved (4 bytes)
    header.writeUInt32LE(0, offset);
    
    return header;
  }
  
  /**
   * Parse message header
   */
  parseHeader(buffer) {
    let offset = 0;
    
    return {
      magic: buffer.slice(offset, offset + 4),
      version: buffer.readUInt8(offset + 4),
      messageType: buffer.readUInt8(offset + 5),
      compressionType: buffer.readUInt8(offset + 6),
      flags: buffer.readUInt8(offset + 7),
      messageSize: buffer.readUInt32LE(offset + 8),
      timestamp: Number(buffer.readBigUInt64LE(offset + 12)),
      messageId: buffer.slice(offset + 20, offset + 28),
      reserved: buffer.readUInt32LE(offset + 28),
      headerSize: 32
    };
  }
  
  /**
   * Encode data with schema
   */
  encodeWithSchema(data, schema) {
    const buffers = [];
    
    for (const [field, type] of Object.entries(schema)) {
      const value = data[field];
      
      if (value === undefined && type.endsWith('?')) {
        // Optional field - encode null marker
        buffers.push(Buffer.from([0]));
        continue;
      }
      
      if (value === undefined) {
        throw new Error(`Missing required field: ${field}`);
      }
      
      // Encode based on type
      buffers.push(this.encodeValue(value, type));
    }
    
    return Buffer.concat(buffers);
  }
  
  /**
   * Encode a single value
   */
  encodeValue(value, type) {
    // Remove optional marker
    const baseType = type.replace('?', '');
    
    switch (baseType) {
      case 'uint8':
        const uint8 = Buffer.allocUnsafe(1);
        uint8.writeUInt8(value, 0);
        return uint8;
        
      case 'uint16':
        const uint16 = Buffer.allocUnsafe(2);
        uint16.writeUInt16LE(value, 0);
        return uint16;
        
      case 'uint32':
        const uint32 = Buffer.allocUnsafe(4);
        uint32.writeUInt32LE(value, 0);
        return uint32;
        
      case 'uint64':
        const uint64 = Buffer.allocUnsafe(8);
        uint64.writeBigUInt64LE(BigInt(value), 0);
        return uint64;
        
      case 'int8':
        const int8 = Buffer.allocUnsafe(1);
        int8.writeInt8(value, 0);
        return int8;
        
      case 'int16':
        const int16 = Buffer.allocUnsafe(2);
        int16.writeInt16LE(value, 0);
        return int16;
        
      case 'int32':
        const int32 = Buffer.allocUnsafe(4);
        int32.writeInt32LE(value, 0);
        return int32;
        
      case 'int64':
        const int64 = Buffer.allocUnsafe(8);
        int64.writeBigInt64LE(BigInt(value), 0);
        return int64;
        
      case 'float32':
        const float32 = Buffer.allocUnsafe(4);
        float32.writeFloatLE(value, 0);
        return float32;
        
      case 'float64':
        const float64 = Buffer.allocUnsafe(8);
        float64.writeDoubleLE(value, 0);
        return float64;
        
      case 'bool':
        return Buffer.from([value ? 1 : 0]);
        
      case 'string':
        const stringBytes = Buffer.from(value, 'utf8');
        const lengthBytes = varint.encode(stringBytes.length);
        return Buffer.concat([Buffer.from(lengthBytes), stringBytes]);
        
      case 'bytes':
        const lengthBytesRaw = varint.encode(value.length);
        return Buffer.concat([Buffer.from(lengthBytesRaw), value]);
        
      case 'bytes32':
        if (value.length !== 32) {
          throw new Error('bytes32 must be exactly 32 bytes');
        }
        return value;
        
      case 'varint':
        return Buffer.from(varint.encode(value));
        
      case 'object':
        return this.encodeRaw(value);
        
      default:
        if (baseType.startsWith('array:')) {
          const elementType = baseType.substring(6);
          const arrayLength = varint.encode(value.length);
          const elements = value.map(v => this.encodeValue(v, elementType));
          return Buffer.concat([Buffer.from(arrayLength), ...elements]);
        }
        
        throw new Error(`Unknown type: ${type}`);
    }
  }
  
  /**
   * Decode data with schema
   */
  decodeWithSchema(buffer, schema) {
    const result = {};
    let offset = 0;
    
    for (const [field, type] of Object.entries(schema)) {
      if (offset >= buffer.length) {
        if (type.endsWith('?')) {
          result[field] = null;
          continue;
        }
        throw new Error(`Buffer underflow at field: ${field}`);
      }
      
      const decoded = this.decodeValue(buffer, offset, type);
      result[field] = decoded.value;
      offset = decoded.offset;
    }
    
    return result;
  }
  
  /**
   * Decode a single value
   */
  decodeValue(buffer, offset, type) {
    const baseType = type.replace('?', '');
    
    // Check for null marker in optional fields
    if (type.endsWith('?') && buffer[offset] === 0) {
      return { value: null, offset: offset + 1 };
    }
    
    switch (baseType) {
      case 'uint8':
        return { value: buffer.readUInt8(offset), offset: offset + 1 };
        
      case 'uint16':
        return { value: buffer.readUInt16LE(offset), offset: offset + 2 };
        
      case 'uint32':
        return { value: buffer.readUInt32LE(offset), offset: offset + 4 };
        
      case 'uint64':
        return { value: Number(buffer.readBigUInt64LE(offset)), offset: offset + 8 };
        
      case 'int8':
        return { value: buffer.readInt8(offset), offset: offset + 1 };
        
      case 'int16':
        return { value: buffer.readInt16LE(offset), offset: offset + 2 };
        
      case 'int32':
        return { value: buffer.readInt32LE(offset), offset: offset + 4 };
        
      case 'int64':
        return { value: Number(buffer.readBigInt64LE(offset)), offset: offset + 8 };
        
      case 'float32':
        return { value: buffer.readFloatLE(offset), offset: offset + 4 };
        
      case 'float64':
        return { value: buffer.readDoubleLE(offset), offset: offset + 8 };
        
      case 'bool':
        return { value: buffer[offset] !== 0, offset: offset + 1 };
        
      case 'string':
        const stringLength = varint.decode(buffer, offset);
        const stringLengthBytes = varint.decode.bytes;
        const stringStart = offset + stringLengthBytes;
        const stringEnd = stringStart + stringLength;
        const stringValue = buffer.slice(stringStart, stringEnd).toString('utf8');
        return { value: stringValue, offset: stringEnd };
        
      case 'bytes':
        const bytesLength = varint.decode(buffer, offset);
        const bytesLengthBytes = varint.decode.bytes;
        const bytesStart = offset + bytesLengthBytes;
        const bytesEnd = bytesStart + bytesLength;
        const bytesValue = buffer.slice(bytesStart, bytesEnd);
        return { value: bytesValue, offset: bytesEnd };
        
      case 'bytes32':
        return { value: buffer.slice(offset, offset + 32), offset: offset + 32 };
        
      case 'varint':
        const varintValue = varint.decode(buffer, offset);
        const varintBytes = varint.decode.bytes;
        return { value: varintValue, offset: offset + varintBytes };
        
      case 'object':
        const objectLength = varint.decode(buffer, offset);
        const objectLengthBytes = varint.decode.bytes;
        const objectStart = offset + objectLengthBytes;
        const objectEnd = objectStart + objectLength;
        const objectBuffer = buffer.slice(objectStart, objectEnd);
        return { value: this.decodeRaw(objectBuffer), offset: objectEnd };
        
      default:
        if (baseType.startsWith('array:')) {
          const elementType = baseType.substring(6);
          const arrayLength = varint.decode(buffer, offset);
          const arrayLengthBytes = varint.decode.bytes;
          let arrayOffset = offset + arrayLengthBytes;
          const array = [];
          
          for (let i = 0; i < arrayLength; i++) {
            const decoded = this.decodeValue(buffer, arrayOffset, elementType);
            array.push(decoded.value);
            arrayOffset = decoded.offset;
          }
          
          return { value: array, offset: arrayOffset };
        }
        
        throw new Error(`Unknown type: ${type}`);
    }
  }
  
  /**
   * Encode raw data (JSON fallback)
   */
  encodeRaw(data) {
    const json = JSON.stringify(data);
    const jsonBuffer = Buffer.from(json, 'utf8');
    const lengthBytes = varint.encode(jsonBuffer.length);
    return Buffer.concat([Buffer.from(lengthBytes), jsonBuffer]);
  }
  
  /**
   * Decode raw data (JSON fallback)
   */
  decodeRaw(buffer) {
    return JSON.parse(buffer.toString('utf8'));
  }
  
  /**
   * Compress data
   */
  async compress(buffer, compressionType) {
    const zlib = require('zlib');
    const { promisify } = require('util');
    
    switch (compressionType || this.config.defaultCompression) {
      case CompressionTypes.GZIP:
        return await promisify(zlib.gzip)(buffer);
        
      case CompressionTypes.ZSTD:
        // Requires zstd-codec package
        if (this.zstd) {
          return await this.zstd.compress(buffer);
        }
        // Fallback to gzip
        return await promisify(zlib.gzip)(buffer);
        
      case CompressionTypes.LZ4:
        // Requires lz4 package
        if (this.lz4) {
          return this.lz4.encode(buffer);
        }
        // Fallback to gzip
        return await promisify(zlib.gzip)(buffer);
        
      default:
        return buffer;
    }
  }
  
  /**
   * Decompress data
   */
  async decompress(buffer, compressionType) {
    const zlib = require('zlib');
    const { promisify } = require('util');
    
    switch (compressionType) {
      case CompressionTypes.GZIP:
        return await promisify(zlib.gunzip)(buffer);
        
      case CompressionTypes.ZSTD:
        if (this.zstd) {
          return await this.zstd.decompress(buffer);
        }
        throw new Error('ZSTD decompression not available');
        
      case CompressionTypes.LZ4:
        if (this.lz4) {
          return this.lz4.decode(buffer);
        }
        throw new Error('LZ4 decompression not available');
        
      default:
        return buffer;
    }
  }
  
  /**
   * Encrypt data
   */
  async encrypt(buffer, key) {
    const algorithm = this.config.encryptionAlgorithm;
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    
    const encrypted = Buffer.concat([
      cipher.update(buffer),
      cipher.final()
    ]);
    
    const authTag = cipher.getAuthTag();
    
    // Prepend IV and auth tag
    return Buffer.concat([
      Buffer.from([0x01]), // Encryption flag
      iv,
      authTag,
      encrypted
    ]);
  }
  
  /**
   * Decrypt data
   */
  async decrypt(buffer, key) {
    if (buffer[0] !== 0x01) {
      throw new Error('Invalid encryption flag');
    }
    
    const algorithm = this.config.encryptionAlgorithm;
    const iv = buffer.slice(1, 17);
    const authTag = buffer.slice(17, 33);
    const encrypted = buffer.slice(33);
    
    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    decipher.setAuthTag(authTag);
    
    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]);
  }
  
  /**
   * Check if buffer is encrypted
   */
  isEncrypted(buffer) {
    return buffer.length > 0 && buffer[0] === 0x01;
  }
  
  /**
   * Generate cache key
   */
  getCacheKey(messageType, data) {
    const hash = crypto.createHash('sha256');
    hash.update(Buffer.from([messageType]));
    hash.update(JSON.stringify(data));
    return hash.digest('hex');
  }
  
  /**
   * Create stream encoder
   */
  createEncoder(options = {}) {
    const { Transform } = require('stream');
    const protocol = this;
    
    return new Transform({
      writableObjectMode: true,
      
      async transform(chunk, encoding, callback) {
        try {
          const { type, data } = chunk;
          const encoded = await protocol.encode(type, data, options);
          callback(null, encoded);
        } catch (error) {
          callback(error);
        }
      }
    });
  }
  
  /**
   * Create stream decoder
   */
  createDecoder(options = {}) {
    const { Transform } = require('stream');
    const protocol = this;
    let buffer = Buffer.alloc(0);
    
    return new Transform({
      readableObjectMode: true,
      
      async transform(chunk, encoding, callback) {
        try {
          // Append to buffer
          buffer = Buffer.concat([buffer, chunk]);
          
          // Try to decode messages
          while (buffer.length >= 32) { // Minimum header size
            const header = protocol.parseHeader(buffer);
            const totalSize = header.headerSize + header.messageSize;
            
            if (buffer.length < totalSize) {
              // Wait for more data
              break;
            }
            
            // Extract complete message
            const messageBuffer = buffer.slice(0, totalSize);
            buffer = buffer.slice(totalSize);
            
            // Decode message
            const decoded = await protocol.decode(messageBuffer, options);
            this.push(decoded);
          }
          
          callback();
        } catch (error) {
          callback(error);
        }
      }
    });
  }
  
  /**
   * Register message handler
   */
  on(messageType, handler) {
    if (!this.messageHandlers.has(messageType)) {
      this.messageHandlers.set(messageType, []);
    }
    
    this.messageHandlers.get(messageType).push(handler);
    return this;
  }
  
  /**
   * Remove message handler
   */
  off(messageType, handler) {
    if (this.messageHandlers.has(messageType)) {
      const handlers = this.messageHandlers.get(messageType);
      const index = handlers.indexOf(handler);
      
      if (index !== -1) {
        handlers.splice(index, 1);
      }
      
      if (handlers.length === 0) {
        this.messageHandlers.delete(messageType);
      }
    }
    
    return this;
  }
  
  /**
   * Emit message to handlers
   */
  async emit(messageType, data) {
    const handlers = this.messageHandlers.get(messageType) || [];
    
    for (const handler of handlers) {
      try {
        await handler(data);
      } catch (error) {
        this.recordFailure(error);
      }
    }
  }
  
  /**
   * Get protocol statistics
   */
  async getStats() {
    const baseStats = await super.getStats();
    
    return {
      ...baseStats,
      protocol: {
        ...this.protocolStats,
        cacheSize: this.encodingCache.size + this.decodingCache.size,
        cacheHitRate: this.protocolStats.cacheHits > 0
          ? this.protocolStats.cacheHits / (this.protocolStats.cacheHits + this.protocolStats.cacheMisses)
          : 0,
        compressionRatio: this.protocolStats.bytesEncoded > 0
          ? 1 - (this.protocolStats.bytesEncoded - this.protocolStats.compressionSavings) / this.protocolStats.bytesEncoded
          : 0,
        averageMessageSize: this.protocolStats.messagesEncoded > 0
          ? this.protocolStats.bytesEncoded / this.protocolStats.messagesEncoded
          : 0
      }
    };
  }
  
  /**
   * Clear caches
   */
  clearCaches() {
    this.encodingCache.clear();
    this.decodingCache.clear();
  }
  
  /**
   * Cleanup on shutdown
   */
  async onShutdown() {
    this.clearCaches();
    this.messageHandlers.clear();
    this.encryptionKeys.clear();
    
    await super.onShutdown();
  }
}

// Export protocol
module.exports = {
  BinaryProtocol,
  MessageTypes,
  CompressionTypes
};