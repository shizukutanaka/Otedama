const EventEmitter = require('events');
const crypto = require('crypto');

// Protocol constants
const PROTOCOL_VERSION = 1;
const MAGIC_BYTES = Buffer.from([0x4F, 0x54, 0x45, 0x44]); // "OTED"

// Message types
const MessageType = {
  // Control messages
  HANDSHAKE: 0x01,
  HEARTBEAT: 0x02,
  CLOSE: 0x03,
  ERROR: 0x04,
  
  // Mining messages
  JOB: 0x10,
  SHARE: 0x11,
  BLOCK: 0x12,
  DIFFICULTY: 0x13,
  
  // Pool messages
  SUBSCRIBE: 0x20,
  AUTHORIZE: 0x21,
  WORKER_STATUS: 0x22,
  STATS: 0x23,
  
  // Data messages
  HASH_SUBMIT: 0x30,
  HASH_ACCEPT: 0x31,
  HASH_REJECT: 0x32,
  
  // P2P messages
  PEER_ANNOUNCE: 0x40,
  PEER_REQUEST: 0x41,
  PEER_RESPONSE: 0x42,
  
  // Custom messages
  CUSTOM: 0xFF
};

// Compression algorithms
const CompressionType = {
  NONE: 0x00,
  ZLIB: 0x01,
  LZ4: 0x02,
  ZSTD: 0x03
};

class BinaryProtocol extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      version: options.version || PROTOCOL_VERSION,
      compression: options.compression || CompressionType.NONE,
      encryption: options.encryption !== false,
      maxMessageSize: options.maxMessageSize || 10 * 1024 * 1024, // 10MB
      
      // Crypto settings
      algorithm: options.algorithm || 'aes-256-gcm',
      keyDerivation: options.keyDerivation || 'pbkdf2',
      
      // Performance
      enableVarInt: options.enableVarInt !== false,
      enableStringTable: options.enableStringTable !== false,
      stringTableSize: options.stringTableSize || 1024
    };
    
    // State
    this.sessionKey = null;
    this.sequenceNumber = 0;
    this.stringTable = new Map();
    this.reverseStringTable = new Map();
    this.nextStringId = 0;
    
    // Buffer pools
    this.bufferPool = [];
    this.maxPoolSize = 100;
    
    // Statistics
    this.stats = {
      encoded: 0,
      decoded: 0,
      compressed: 0,
      encrypted: 0,
      errors: 0,
      bytesIn: 0,
      bytesOut: 0,
      compressionRatio: 1.0
    };
  }
  
  // Initialization
  
  async initialize(sharedSecret) {
    if (this.config.encryption && sharedSecret) {
      // Derive session key from shared secret
      this.sessionKey = await this.deriveKey(sharedSecret);
    }
    
    // Initialize string table with common strings
    this.initializeStringTable();
    
    this.emit('initialized');
  }
  
  initializeStringTable() {
    const commonStrings = [
      'id', 'type', 'method', 'params', 'result', 'error',
      'timestamp', 'version', 'worker', 'job', 'share',
      'difficulty', 'hashrate', 'accepted', 'rejected',
      'height', 'hash', 'previousHash', 'nonce', 'target'
    ];
    
    for (const str of commonStrings) {
      this.addToStringTable(str);
    }
  }
  
  // Encoding
  
  encode(message) {
    try {
      const startTime = Date.now();
      
      // Create message buffer
      let payload = this.encodePayload(message);
      
      // Compress if enabled
      if (this.config.compression !== CompressionType.NONE) {
        const compressed = this.compress(payload);
        if (compressed.length < payload.length) {
          payload = compressed;
          this.stats.compressed++;
        }
      }
      
      // Encrypt if enabled
      if (this.config.encryption && this.sessionKey) {
        payload = this.encrypt(payload);
        this.stats.encrypted++;
      }
      
      // Create final message with header
      const header = this.createHeader(message.type || MessageType.CUSTOM, payload.length);
      const finalMessage = Buffer.concat([header, payload]);
      
      // Update statistics
      this.stats.encoded++;
      this.stats.bytesOut += finalMessage.length;
      
      const encodingTime = Date.now() - startTime;
      this.emit('message:encoded', {
        size: finalMessage.length,
        time: encodingTime,
        compressed: this.config.compression !== CompressionType.NONE,
        encrypted: this.config.encryption
      });
      
      return finalMessage;
      
    } catch (error) {
      this.stats.errors++;
      this.emit('error', error);
      throw error;
    }
  }
  
  encodePayload(message) {
    const writer = new BufferWriter(this.getBuffer());
    
    // Write message data based on type
    switch (message.type) {
      case MessageType.JOB:
        this.encodeJob(writer, message);
        break;
        
      case MessageType.SHARE:
        this.encodeShare(writer, message);
        break;
        
      case MessageType.STATS:
        this.encodeStats(writer, message);
        break;
        
      default:
        // Generic encoding
        this.encodeGeneric(writer, message);
    }
    
    return writer.getBuffer();
  }
  
  encodeJob(writer, job) {
    writer.writeString(job.jobId);
    writer.writeBytes(Buffer.from(job.prevHash, 'hex'));
    writer.writeString(job.coinbase1);
    writer.writeString(job.coinbase2);
    writer.writeVarInt(job.merkleBranch.length);
    
    for (const branch of job.merkleBranch) {
      writer.writeBytes(Buffer.from(branch, 'hex'));
    }
    
    writer.writeUInt32(job.version);
    writer.writeString(job.nbits);
    writer.writeUInt32(job.ntime);
    writer.writeBoolean(job.cleanJobs);
  }
  
  encodeShare(writer, share) {
    writer.writeString(share.workerId);
    writer.writeString(share.jobId);
    writer.writeBytes(Buffer.from(share.nonce, 'hex'));
    writer.writeString(share.extraNonce2);
    writer.writeUInt32(share.ntime);
  }
  
  encodeStats(writer, stats) {
    writer.writeVarInt(Object.keys(stats).length);
    
    for (const [key, value] of Object.entries(stats)) {
      writer.writeString(key);
      
      if (typeof value === 'number') {
        writer.writeDouble(value);
      } else if (typeof value === 'string') {
        writer.writeString(value);
      } else if (typeof value === 'boolean') {
        writer.writeBoolean(value);
      } else {
        writer.writeString(JSON.stringify(value));
      }
    }
  }
  
  encodeGeneric(writer, message) {
    // Remove type field for encoding
    const { type, ...data } = message;
    
    // Encode as JSON for generic messages
    const json = JSON.stringify(data);
    writer.writeString(json);
  }
  
  // Decoding
  
  decode(buffer) {
    try {
      const startTime = Date.now();
      
      // Validate minimum size
      if (buffer.length < 16) {
        throw new Error('Message too short');
      }
      
      // Parse header
      const header = this.parseHeader(buffer);
      
      // Validate header
      if (!header.valid) {
        throw new Error('Invalid message header');
      }
      
      // Extract payload
      let payload = buffer.slice(header.size, header.size + header.payloadSize);
      
      // Decrypt if needed
      if (header.encrypted && this.sessionKey) {
        payload = this.decrypt(payload);
      }
      
      // Decompress if needed
      if (header.compressed) {
        payload = this.decompress(payload);
      }
      
      // Decode payload
      const message = this.decodePayload(header.type, payload);
      message.type = header.type;
      
      // Update statistics
      this.stats.decoded++;
      this.stats.bytesIn += buffer.length;
      
      const decodingTime = Date.now() - startTime;
      this.emit('message:decoded', {
        size: buffer.length,
        time: decodingTime,
        type: header.type
      });
      
      return message;
      
    } catch (error) {
      this.stats.errors++;
      this.emit('error', error);
      throw error;
    }
  }
  
  decodePayload(type, buffer) {
    const reader = new BufferReader(buffer);
    
    switch (type) {
      case MessageType.JOB:
        return this.decodeJob(reader);
        
      case MessageType.SHARE:
        return this.decodeShare(reader);
        
      case MessageType.STATS:
        return this.decodeStats(reader);
        
      default:
        return this.decodeGeneric(reader);
    }
  }
  
  decodeJob(reader) {
    const job = {
      jobId: reader.readString(),
      prevHash: reader.readBytes(32).toString('hex'),
      coinbase1: reader.readString(),
      coinbase2: reader.readString(),
      merkleBranch: [],
      version: reader.readUInt32(),
      nbits: reader.readString(),
      ntime: reader.readUInt32(),
      cleanJobs: reader.readBoolean()
    };
    
    const branchCount = reader.readVarInt();
    for (let i = 0; i < branchCount; i++) {
      job.merkleBranch.push(reader.readBytes(32).toString('hex'));
    }
    
    return job;
  }
  
  decodeShare(reader) {
    return {
      workerId: reader.readString(),
      jobId: reader.readString(),
      nonce: reader.readBytes(4).toString('hex'),
      extraNonce2: reader.readString(),
      ntime: reader.readUInt32()
    };
  }
  
  decodeStats(reader) {
    const stats = {};
    const count = reader.readVarInt();
    
    for (let i = 0; i < count; i++) {
      const key = reader.readString();
      const value = reader.readDouble(); // Simplified for demo
      stats[key] = value;
    }
    
    return stats;
  }
  
  decodeGeneric(reader) {
    const json = reader.readString();
    return JSON.parse(json);
  }
  
  // Header handling
  
  createHeader(type, payloadSize) {
    const header = Buffer.allocUnsafe(16);
    let offset = 0;
    
    // Magic bytes
    MAGIC_BYTES.copy(header, offset);
    offset += 4;
    
    // Version
    header.writeUInt8(this.config.version, offset);
    offset += 1;
    
    // Flags
    let flags = 0;
    if (this.config.compression !== CompressionType.NONE) flags |= 0x01;
    if (this.config.encryption && this.sessionKey) flags |= 0x02;
    header.writeUInt8(flags, offset);
    offset += 1;
    
    // Message type
    header.writeUInt8(type, offset);
    offset += 1;
    
    // Compression type
    header.writeUInt8(this.config.compression, offset);
    offset += 1;
    
    // Sequence number
    header.writeUInt32BE(this.sequenceNumber++, offset);
    offset += 4;
    
    // Payload size
    header.writeUInt32BE(payloadSize, offset);
    
    return header;
  }
  
  parseHeader(buffer) {
    const header = {
      valid: false,
      size: 16
    };
    
    // Check magic bytes
    if (!buffer.slice(0, 4).equals(MAGIC_BYTES)) {
      return header;
    }
    
    header.version = buffer.readUInt8(4);
    
    const flags = buffer.readUInt8(5);
    header.compressed = (flags & 0x01) !== 0;
    header.encrypted = (flags & 0x02) !== 0;
    
    header.type = buffer.readUInt8(6);
    header.compressionType = buffer.readUInt8(7);
    header.sequenceNumber = buffer.readUInt32BE(8);
    header.payloadSize = buffer.readUInt32BE(12);
    
    header.valid = true;
    
    return header;
  }
  
  // Compression
  
  compress(buffer) {
    const zlib = require('zlib');
    
    switch (this.config.compression) {
      case CompressionType.ZLIB:
        return zlib.deflateSync(buffer);
        
      case CompressionType.LZ4:
        // Would use lz4 library
        return buffer;
        
      case CompressionType.ZSTD:
        // Would use zstd library
        return buffer;
        
      default:
        return buffer;
    }
  }
  
  decompress(buffer) {
    const zlib = require('zlib');
    
    switch (this.config.compression) {
      case CompressionType.ZLIB:
        return zlib.inflateSync(buffer);
        
      case CompressionType.LZ4:
        // Would use lz4 library
        return buffer;
        
      case CompressionType.ZSTD:
        // Would use zstd library
        return buffer;
        
      default:
        return buffer;
    }
  }
  
  // Encryption
  
  encrypt(buffer) {
    if (!this.sessionKey) return buffer;
    
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(this.config.algorithm, this.sessionKey, iv);
    
    const encrypted = Buffer.concat([
      cipher.update(buffer),
      cipher.final()
    ]);
    
    // Prepend IV and auth tag
    const authTag = cipher.getAuthTag();
    
    return Buffer.concat([iv, authTag, encrypted]);
  }
  
  decrypt(buffer) {
    if (!this.sessionKey) return buffer;
    
    const iv = buffer.slice(0, 16);
    const authTag = buffer.slice(16, 32);
    const encrypted = buffer.slice(32);
    
    const decipher = crypto.createDecipheriv(this.config.algorithm, this.sessionKey, iv);
    decipher.setAuthTag(authTag);
    
    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]);
  }
  
  async deriveKey(sharedSecret) {
    return new Promise((resolve, reject) => {
      crypto.pbkdf2(sharedSecret, 'otedama-salt', 100000, 32, 'sha256', (err, derivedKey) => {
        if (err) reject(err);
        else resolve(derivedKey);
      });
    });
  }
  
  // String table management
  
  addToStringTable(str) {
    if (this.stringTable.has(str)) {
      return this.stringTable.get(str);
    }
    
    if (this.nextStringId >= this.config.stringTableSize) {
      // Table full, evict oldest
      const oldestStr = this.reverseStringTable.get(0);
      this.stringTable.delete(oldestStr);
      this.reverseStringTable.delete(0);
      
      // Shift all IDs down
      for (let i = 1; i < this.config.stringTableSize; i++) {
        const str = this.reverseStringTable.get(i);
        if (str) {
          this.reverseStringTable.delete(i);
          this.reverseStringTable.set(i - 1, str);
          this.stringTable.set(str, i - 1);
        }
      }
      
      this.nextStringId--;
    }
    
    const id = this.nextStringId++;
    this.stringTable.set(str, id);
    this.reverseStringTable.set(id, str);
    
    return id;
  }
  
  // Buffer management
  
  getBuffer(size = 1024) {
    if (this.bufferPool.length > 0) {
      const buffer = this.bufferPool.pop();
      if (buffer.length >= size) {
        return buffer;
      }
    }
    
    return Buffer.allocUnsafe(size);
  }
  
  releaseBuffer(buffer) {
    if (this.bufferPool.length < this.maxPoolSize) {
      buffer.fill(0);
      this.bufferPool.push(buffer);
    }
  }
  
  // Statistics
  
  getStats() {
    const compressionRatio = this.stats.compressed > 0
      ? this.stats.bytesOut / this.stats.compressed
      : 1.0;
    
    return {
      ...this.stats,
      compressionRatio,
      stringTableSize: this.stringTable.size
    };
  }
  
  resetStats() {
    this.stats = {
      encoded: 0,
      decoded: 0,
      compressed: 0,
      encrypted: 0,
      errors: 0,
      bytesIn: 0,
      bytesOut: 0,
      compressionRatio: 1.0
    };
  }
}

// Buffer writer helper
class BufferWriter {
  constructor(buffer) {
    this.buffer = buffer;
    this.offset = 0;
  }
  
  writeUInt8(value) {
    this.buffer.writeUInt8(value, this.offset);
    this.offset += 1;
  }
  
  writeUInt16(value) {
    this.buffer.writeUInt16BE(value, this.offset);
    this.offset += 2;
  }
  
  writeUInt32(value) {
    this.buffer.writeUInt32BE(value, this.offset);
    this.offset += 4;
  }
  
  writeDouble(value) {
    this.buffer.writeDoubleBE(value, this.offset);
    this.offset += 8;
  }
  
  writeVarInt(value) {
    // Variable-length integer encoding
    while (value >= 0x80) {
      this.writeUInt8((value & 0x7F) | 0x80);
      value >>>= 7;
    }
    this.writeUInt8(value);
  }
  
  writeString(str) {
    const bytes = Buffer.from(str, 'utf8');
    this.writeVarInt(bytes.length);
    bytes.copy(this.buffer, this.offset);
    this.offset += bytes.length;
  }
  
  writeBytes(bytes) {
    this.writeVarInt(bytes.length);
    bytes.copy(this.buffer, this.offset);
    this.offset += bytes.length;
  }
  
  writeBoolean(value) {
    this.writeUInt8(value ? 1 : 0);
  }
  
  getBuffer() {
    return this.buffer.slice(0, this.offset);
  }
}

// Buffer reader helper
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
  
  readUInt16() {
    const value = this.buffer.readUInt16BE(this.offset);
    this.offset += 2;
    return value;
  }
  
  readUInt32() {
    const value = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }
  
  readDouble() {
    const value = this.buffer.readDoubleBE(this.offset);
    this.offset += 8;
    return value;
  }
  
  readVarInt() {
    let value = 0;
    let shift = 0;
    let byte;
    
    do {
      byte = this.readUInt8();
      value |= (byte & 0x7F) << shift;
      shift += 7;
    } while (byte >= 0x80);
    
    return value;
  }
  
  readString() {
    const length = this.readVarInt();
    const str = this.buffer.toString('utf8', this.offset, this.offset + length);
    this.offset += length;
    return str;
  }
  
  readBytes(length) {
    if (length === undefined) {
      length = this.readVarInt();
    }
    const bytes = this.buffer.slice(this.offset, this.offset + length);
    this.offset += length;
    return bytes;
  }
  
  readBoolean() {
    return this.readUInt8() !== 0;
  }
}

module.exports = {
  BinaryProtocol,
  MessageType,
  CompressionType
};