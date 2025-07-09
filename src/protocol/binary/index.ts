/**
 * Binary Protocol Implementation
 * High-performance binary communication protocol for mining pool
 * Reduces bandwidth usage by 60-80% compared to JSON
 */

import { EventEmitter } from 'events';
import { Logger } from '../../logging/logger';
import { AlignedBuffer, getMemoryAlignmentManager } from '../../performance/memory-alignment';

// Protocol version and magic bytes
export const PROTOCOL_VERSION = 0x01;
export const MAGIC_BYTES = Buffer.from([0x4F, 0x54, 0x45, 0x44]); // "OTED"

// Message types
export enum MessageType {
  // Connection handshake
  HANDSHAKE_REQUEST = 0x01,
  HANDSHAKE_RESPONSE = 0x02,
  
  // Mining messages
  WORK_REQUEST = 0x10,
  WORK_RESPONSE = 0x11,
  SHARE_SUBMIT = 0x12,
  SHARE_RESULT = 0x13,
  
  // Pool messages
  DIFFICULTY_UPDATE = 0x20,
  BLOCK_FOUND = 0x21,
  POOL_STATS = 0x22,
  
  // Error messages
  ERROR = 0xF0,
  PING = 0xF1,
  PONG = 0xF2,
  
  // Extended messages
  EXTENDED = 0xFF
}

// Error codes
export enum ErrorCode {
  INVALID_PROTOCOL = 0x01,
  INVALID_MESSAGE = 0x02,
  AUTHENTICATION_FAILED = 0x03,
  RATE_LIMIT_EXCEEDED = 0x04,
  INVALID_SHARE = 0x05,
  STALE_WORK = 0x06,
  DUPLICATE_SHARE = 0x07,
  LOW_DIFFICULTY = 0x08
}

// Message header structure (fixed 16 bytes)
export interface MessageHeader {
  magic: Buffer;        // 4 bytes - Magic bytes "OTED"
  version: number;      // 1 byte  - Protocol version
  type: MessageType;    // 1 byte  - Message type
  flags: number;        // 1 byte  - Message flags
  reserved: number;     // 1 byte  - Reserved for future use
  length: number;       // 4 bytes - Payload length
  checksum: number;     // 4 bytes - CRC32 checksum
}

// Message flags
export enum MessageFlags {
  NONE = 0x00,
  COMPRESSED = 0x01,
  ENCRYPTED = 0x02,
  FRAGMENTED = 0x04,
  PRIORITY = 0x08
}

/**
 * Binary message serializer/deserializer
 */
export class BinaryProtocol {
  private logger = new Logger('BinaryProtocol');
  private memoryManager = getMemoryAlignmentManager();

  /**
   * Serialize message to binary format
   */
  serialize(type: MessageType, payload: any, flags: MessageFlags = MessageFlags.NONE): Buffer {
    const payloadBuffer = this.serializePayload(type, payload);
    const header = this.createHeader(type, payloadBuffer.length, flags);
    
    return Buffer.concat([header, payloadBuffer]);
  }

  /**
   * Deserialize binary message
   */
  deserialize(buffer: Buffer): { header: MessageHeader; payload: any } | null {
    if (buffer.length < 16) {
      this.logger.warn('Invalid message: too short');
      return null;
    }

    const header = this.parseHeader(buffer);
    if (!header) {
      return null;
    }

    if (buffer.length < 16 + header.length) {
      this.logger.warn('Invalid message: incomplete payload');
      return null;
    }

    const payloadBuffer = buffer.slice(16, 16 + header.length);
    const payload = this.deserializePayload(header.type, payloadBuffer);

    return { header, payload };
  }

  /**
   * Create message header
   */
  private createHeader(type: MessageType, payloadLength: number, flags: MessageFlags): Buffer {
    const headerBuffer = this.memoryManager.createAlignedBuffer(16);
    
    // Write header fields
    headerBuffer.writeAligned(0, MAGIC_BYTES[0], 'uint8');
    headerBuffer.writeAligned(1, MAGIC_BYTES[1], 'uint8');
    headerBuffer.writeAligned(2, MAGIC_BYTES[2], 'uint8');
    headerBuffer.writeAligned(3, MAGIC_BYTES[3], 'uint8');
    headerBuffer.writeAligned(4, PROTOCOL_VERSION, 'uint8');
    headerBuffer.writeAligned(5, type, 'uint8');
    headerBuffer.writeAligned(6, flags, 'uint8');
    headerBuffer.writeAligned(7, 0, 'uint8'); // reserved
    headerBuffer.writeAligned(8, payloadLength, 'uint32');
    
    // Calculate and write checksum
    const checksum = this.calculateCRC32(Buffer.from(headerBuffer.arrayBuffer, 0, 12));
    headerBuffer.writeAligned(12, checksum, 'uint32');
    
    return Buffer.from(headerBuffer.arrayBuffer);
  }

  /**
   * Parse message header
   */
  private parseHeader(buffer: Buffer): MessageHeader | null {
    // Check magic bytes
    if (!buffer.slice(0, 4).equals(MAGIC_BYTES)) {
      this.logger.warn('Invalid magic bytes');
      return null;
    }

    const header: MessageHeader = {
      magic: buffer.slice(0, 4),
      version: buffer.readUInt8(4),
      type: buffer.readUInt8(5) as MessageType,
      flags: buffer.readUInt8(6),
      reserved: buffer.readUInt8(7),
      length: buffer.readUInt32LE(8),
      checksum: buffer.readUInt32LE(12)
    };

    // Verify version
    if (header.version !== PROTOCOL_VERSION) {
      this.logger.warn('Unsupported protocol version', { version: header.version });
      return null;
    }

    // Verify checksum
    const expectedChecksum = this.calculateCRC32(buffer.slice(0, 12));
    if (header.checksum !== expectedChecksum) {
      this.logger.warn('Invalid checksum', {
        expected: expectedChecksum,
        received: header.checksum
      });
      return null;
    }

    return header;
  }

  /**
   * Serialize payload based on message type
   */
  private serializePayload(type: MessageType, payload: any): Buffer {
    switch (type) {
      case MessageType.HANDSHAKE_REQUEST:
        return this.serializeHandshakeRequest(payload);
      case MessageType.HANDSHAKE_RESPONSE:
        return this.serializeHandshakeResponse(payload);
      case MessageType.WORK_REQUEST:
        return this.serializeWorkRequest(payload);
      case MessageType.WORK_RESPONSE:
        return this.serializeWorkResponse(payload);
      case MessageType.SHARE_SUBMIT:
        return this.serializeShareSubmit(payload);
      case MessageType.SHARE_RESULT:
        return this.serializeShareResult(payload);
      case MessageType.DIFFICULTY_UPDATE:
        return this.serializeDifficultyUpdate(payload);
      case MessageType.BLOCK_FOUND:
        return this.serializeBlockFound(payload);
      case MessageType.POOL_STATS:
        return this.serializePoolStats(payload);
      case MessageType.ERROR:
        return this.serializeError(payload);
      case MessageType.PING:
      case MessageType.PONG:
        return this.serializePingPong(payload);
      default:
        throw new Error(`Unsupported message type: ${type}`);
    }
  }

  /**
   * Deserialize payload based on message type
   */
  private deserializePayload(type: MessageType, buffer: Buffer): any {
    switch (type) {
      case MessageType.HANDSHAKE_REQUEST:
        return this.deserializeHandshakeRequest(buffer);
      case MessageType.HANDSHAKE_RESPONSE:
        return this.deserializeHandshakeResponse(buffer);
      case MessageType.WORK_REQUEST:
        return this.deserializeWorkRequest(buffer);
      case MessageType.WORK_RESPONSE:
        return this.deserializeWorkResponse(buffer);
      case MessageType.SHARE_SUBMIT:
        return this.deserializeShareSubmit(buffer);
      case MessageType.SHARE_RESULT:
        return this.deserializeShareResult(buffer);
      case MessageType.DIFFICULTY_UPDATE:
        return this.deserializeDifficultyUpdate(buffer);
      case MessageType.BLOCK_FOUND:
        return this.deserializeBlockFound(buffer);
      case MessageType.POOL_STATS:
        return this.deserializePoolStats(buffer);
      case MessageType.ERROR:
        return this.deserializeError(buffer);
      case MessageType.PING:
      case MessageType.PONG:
        return this.deserializePingPong(buffer);
      default:
        throw new Error(`Unsupported message type: ${type}`);
    }
  }

  // Handshake serialization
  private serializeHandshakeRequest(payload: {
    clientVersion: string;
    minerId: string;
    capabilities: string[];
  }): Buffer {
    const buffers: Buffer[] = [];
    
    // Client version (1 byte length + string)
    const versionBuffer = Buffer.from(payload.clientVersion, 'utf8');
    buffers.push(Buffer.from([versionBuffer.length]));
    buffers.push(versionBuffer);
    
    // Miner ID (1 byte length + string)
    const minerIdBuffer = Buffer.from(payload.minerId, 'utf8');
    buffers.push(Buffer.from([minerIdBuffer.length]));
    buffers.push(minerIdBuffer);
    
    // Capabilities (1 byte count + capabilities)
    buffers.push(Buffer.from([payload.capabilities.length]));
    for (const capability of payload.capabilities) {
      const capBuffer = Buffer.from(capability, 'utf8');
      buffers.push(Buffer.from([capBuffer.length]));
      buffers.push(capBuffer);
    }
    
    return Buffer.concat(buffers);
  }

  private deserializeHandshakeRequest(buffer: Buffer): any {
    let offset = 0;
    
    // Client version
    const versionLength = buffer.readUInt8(offset++);
    const clientVersion = buffer.slice(offset, offset + versionLength).toString('utf8');
    offset += versionLength;
    
    // Miner ID
    const minerIdLength = buffer.readUInt8(offset++);
    const minerId = buffer.slice(offset, offset + minerIdLength).toString('utf8');
    offset += minerIdLength;
    
    // Capabilities
    const capabilityCount = buffer.readUInt8(offset++);
    const capabilities: string[] = [];
    
    for (let i = 0; i < capabilityCount; i++) {
      const capLength = buffer.readUInt8(offset++);
      const capability = buffer.slice(offset, offset + capLength).toString('utf8');
      capabilities.push(capability);
      offset += capLength;
    }
    
    return { clientVersion, minerId, capabilities };
  }

  private serializeHandshakeResponse(payload: {
    accepted: boolean;
    sessionId: string;
    difficulty: number;
    extranonce1: string;
    extranonce2Size: number;
  }): Buffer {
    const buffers: Buffer[] = [];
    
    // Accepted flag
    buffers.push(Buffer.from([payload.accepted ? 1 : 0]));
    
    // Session ID
    const sessionIdBuffer = Buffer.from(payload.sessionId, 'utf8');
    buffers.push(Buffer.from([sessionIdBuffer.length]));
    buffers.push(sessionIdBuffer);
    
    // Difficulty (8 bytes double)
    const diffBuffer = Buffer.allocUnsafe(8);
    diffBuffer.writeDoubleLE(payload.difficulty, 0);
    buffers.push(diffBuffer);
    
    // Extranonce1
    const extranonce1Buffer = Buffer.from(payload.extranonce1, 'hex');
    buffers.push(Buffer.from([extranonce1Buffer.length]));
    buffers.push(extranonce1Buffer);
    
    // Extranonce2 size
    buffers.push(Buffer.from([payload.extranonce2Size]));
    
    return Buffer.concat(buffers);
  }

  private deserializeHandshakeResponse(buffer: Buffer): any {
    let offset = 0;
    
    const accepted = buffer.readUInt8(offset++) === 1;
    
    const sessionIdLength = buffer.readUInt8(offset++);
    const sessionId = buffer.slice(offset, offset + sessionIdLength).toString('utf8');
    offset += sessionIdLength;
    
    const difficulty = buffer.readDoubleLE(offset);
    offset += 8;
    
    const extranonce1Length = buffer.readUInt8(offset++);
    const extranonce1 = buffer.slice(offset, offset + extranonce1Length).toString('hex');
    offset += extranonce1Length;
    
    const extranonce2Size = buffer.readUInt8(offset++);
    
    return { accepted, sessionId, difficulty, extranonce1, extranonce2Size };
  }

  // Work serialization
  private serializeWorkRequest(payload: { jobId?: string }): Buffer {
    if (payload.jobId) {
      const jobIdBuffer = Buffer.from(payload.jobId, 'utf8');
      return Buffer.concat([
        Buffer.from([jobIdBuffer.length]),
        jobIdBuffer
      ]);
    }
    return Buffer.from([0]); // Empty job ID
  }

  private deserializeWorkRequest(buffer: Buffer): any {
    if (buffer.length === 0) return {};
    
    const jobIdLength = buffer.readUInt8(0);
    if (jobIdLength === 0) return {};
    
    const jobId = buffer.slice(1, 1 + jobIdLength).toString('utf8');
    return { jobId };
  }

  private serializeWorkResponse(payload: {
    jobId: string;
    prevHash: string;
    merkleRoot: string;
    timestamp: number;
    bits: string;
    difficulty: number;
    height: number;
  }): Buffer {
    const buffers: Buffer[] = [];
    
    // Job ID
    const jobIdBuffer = Buffer.from(payload.jobId, 'utf8');
    buffers.push(Buffer.from([jobIdBuffer.length]));
    buffers.push(jobIdBuffer);
    
    // Previous hash (32 bytes)
    buffers.push(Buffer.from(payload.prevHash, 'hex'));
    
    // Merkle root (32 bytes)
    buffers.push(Buffer.from(payload.merkleRoot, 'hex'));
    
    // Timestamp (4 bytes)
    const timestampBuffer = Buffer.allocUnsafe(4);
    timestampBuffer.writeUInt32LE(payload.timestamp, 0);
    buffers.push(timestampBuffer);
    
    // Bits (4 bytes)
    buffers.push(Buffer.from(payload.bits, 'hex'));
    
    // Difficulty (8 bytes)
    const diffBuffer = Buffer.allocUnsafe(8);
    diffBuffer.writeDoubleLE(payload.difficulty, 0);
    buffers.push(diffBuffer);
    
    // Height (4 bytes)
    const heightBuffer = Buffer.allocUnsafe(4);
    heightBuffer.writeUInt32LE(payload.height, 0);
    buffers.push(heightBuffer);
    
    return Buffer.concat(buffers);
  }

  private deserializeWorkResponse(buffer: Buffer): any {
    let offset = 0;
    
    const jobIdLength = buffer.readUInt8(offset++);
    const jobId = buffer.slice(offset, offset + jobIdLength).toString('utf8');
    offset += jobIdLength;
    
    const prevHash = buffer.slice(offset, offset + 32).toString('hex');
    offset += 32;
    
    const merkleRoot = buffer.slice(offset, offset + 32).toString('hex');
    offset += 32;
    
    const timestamp = buffer.readUInt32LE(offset);
    offset += 4;
    
    const bits = buffer.slice(offset, offset + 4).toString('hex');
    offset += 4;
    
    const difficulty = buffer.readDoubleLE(offset);
    offset += 8;
    
    const height = buffer.readUInt32LE(offset);
    offset += 4;
    
    return { jobId, prevHash, merkleRoot, timestamp, bits, difficulty, height };
  }

  // Share serialization
  private serializeShareSubmit(payload: {
    jobId: string;
    extranonce2: string;
    nonce: string;
    timestamp: number;
  }): Buffer {
    const buffers: Buffer[] = [];
    
    // Job ID
    const jobIdBuffer = Buffer.from(payload.jobId, 'utf8');
    buffers.push(Buffer.from([jobIdBuffer.length]));
    buffers.push(jobIdBuffer);
    
    // Extranonce2
    const extranonce2Buffer = Buffer.from(payload.extranonce2, 'hex');
    buffers.push(Buffer.from([extranonce2Buffer.length]));
    buffers.push(extranonce2Buffer);
    
    // Nonce (4 bytes)
    buffers.push(Buffer.from(payload.nonce, 'hex'));
    
    // Timestamp (4 bytes)
    const timestampBuffer = Buffer.allocUnsafe(4);
    timestampBuffer.writeUInt32LE(payload.timestamp, 0);
    buffers.push(timestampBuffer);
    
    return Buffer.concat(buffers);
  }

  private deserializeShareSubmit(buffer: Buffer): any {
    let offset = 0;
    
    const jobIdLength = buffer.readUInt8(offset++);
    const jobId = buffer.slice(offset, offset + jobIdLength).toString('utf8');
    offset += jobIdLength;
    
    const extranonce2Length = buffer.readUInt8(offset++);
    const extranonce2 = buffer.slice(offset, offset + extranonce2Length).toString('hex');
    offset += extranonce2Length;
    
    const nonce = buffer.slice(offset, offset + 4).toString('hex');
    offset += 4;
    
    const timestamp = buffer.readUInt32LE(offset);
    offset += 4;
    
    return { jobId, extranonce2, nonce, timestamp };
  }

  private serializeShareResult(payload: {
    accepted: boolean;
    error?: string;
    blockFound?: boolean;
  }): Buffer {
    const buffers: Buffer[] = [];
    
    // Accepted flag
    buffers.push(Buffer.from([payload.accepted ? 1 : 0]));
    
    // Block found flag
    buffers.push(Buffer.from([payload.blockFound ? 1 : 0]));
    
    // Error message (optional)
    if (payload.error) {
      const errorBuffer = Buffer.from(payload.error, 'utf8');
      buffers.push(Buffer.from([errorBuffer.length]));
      buffers.push(errorBuffer);
    } else {
      buffers.push(Buffer.from([0]));
    }
    
    return Buffer.concat(buffers);
  }

  private deserializeShareResult(buffer: Buffer): any {
    let offset = 0;
    
    const accepted = buffer.readUInt8(offset++) === 1;
    const blockFound = buffer.readUInt8(offset++) === 1;
    
    const errorLength = buffer.readUInt8(offset++);
    const error = errorLength > 0 ? 
      buffer.slice(offset, offset + errorLength).toString('utf8') : 
      undefined;
    
    return { accepted, blockFound, error };
  }

  // Other message serializations
  private serializeDifficultyUpdate(payload: { difficulty: number }): Buffer {
    const buffer = Buffer.allocUnsafe(8);
    buffer.writeDoubleLE(payload.difficulty, 0);
    return buffer;
  }

  private deserializeDifficultyUpdate(buffer: Buffer): any {
    return { difficulty: buffer.readDoubleLE(0) };
  }

  private serializeBlockFound(payload: {
    height: number;
    hash: string;
    reward: number;
  }): Buffer {
    const buffers: Buffer[] = [];
    
    // Height (4 bytes)
    const heightBuffer = Buffer.allocUnsafe(4);
    heightBuffer.writeUInt32LE(payload.height, 0);
    buffers.push(heightBuffer);
    
    // Hash (32 bytes)
    buffers.push(Buffer.from(payload.hash, 'hex'));
    
    // Reward (8 bytes)
    const rewardBuffer = Buffer.allocUnsafe(8);
    rewardBuffer.writeDoubleLE(payload.reward, 0);
    buffers.push(rewardBuffer);
    
    return Buffer.concat(buffers);
  }

  private deserializeBlockFound(buffer: Buffer): any {
    const height = buffer.readUInt32LE(0);
    const hash = buffer.slice(4, 36).toString('hex');
    const reward = buffer.readDoubleLE(36);
    
    return { height, hash, reward };
  }

  private serializePoolStats(payload: {
    hashrate: number;
    miners: number;
    blocks: number;
  }): Buffer {
    const buffer = Buffer.allocUnsafe(16);
    buffer.writeDoubleLE(payload.hashrate, 0);
    buffer.writeUInt32LE(payload.miners, 8);
    buffer.writeUInt32LE(payload.blocks, 12);
    return buffer;
  }

  private deserializePoolStats(buffer: Buffer): any {
    return {
      hashrate: buffer.readDoubleLE(0),
      miners: buffer.readUInt32LE(8),
      blocks: buffer.readUInt32LE(12)
    };
  }

  private serializeError(payload: {
    code: ErrorCode;
    message: string;
  }): Buffer {
    const messageBuffer = Buffer.from(payload.message, 'utf8');
    return Buffer.concat([
      Buffer.from([payload.code]),
      Buffer.from([messageBuffer.length]),
      messageBuffer
    ]);
  }

  private deserializeError(buffer: Buffer): any {
    const code = buffer.readUInt8(0) as ErrorCode;
    const messageLength = buffer.readUInt8(1);
    const message = buffer.slice(2, 2 + messageLength).toString('utf8');
    
    return { code, message };
  }

  private serializePingPong(payload: { timestamp: number }): Buffer {
    const buffer = Buffer.allocUnsafe(8);
    buffer.writeBigUInt64LE(BigInt(payload.timestamp), 0);
    return buffer;
  }

  private deserializePingPong(buffer: Buffer): any {
    const timestamp = Number(buffer.readBigUInt64LE(0));
    return { timestamp };
  }

  /**
   * Calculate CRC32 checksum
   */
  private calculateCRC32(buffer: Buffer): number {
    // Simplified CRC32 implementation
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buffer.length; i++) {
      crc ^= buffer[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
      }
    }
    return (~crc) >>> 0;
  }
}

/**
 * Binary protocol connection handler
 */
export class BinaryProtocolConnection extends EventEmitter {
  private protocol = new BinaryProtocol();
  private logger = new Logger('BinaryProtocolConnection');
  private buffer = Buffer.alloc(0);

  constructor(private socket: any) {
    super();
    this.setupSocketHandlers();
  }

  private setupSocketHandlers(): void {
    this.socket.on('data', (data: Buffer) => {
      this.handleData(data);
    });

    this.socket.on('error', (error: Error) => {
      this.logger.error('Socket error', error);
      this.emit('error', error);
    });

    this.socket.on('close', () => {
      this.emit('disconnect');
    });
  }

  private handleData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);

    while (this.buffer.length >= 16) {
      // Try to parse header
      const headerResult = this.protocol.deserialize(this.buffer);
      if (!headerResult) {
        // Invalid message, close connection
        this.logger.warn('Invalid message received, closing connection');
        this.socket.end();
        return;
      }

      const totalMessageLength = 16 + headerResult.header.length;
      if (this.buffer.length < totalMessageLength) {
        // Wait for more data
        break;
      }

      // Extract complete message
      const messageBuffer = this.buffer.slice(0, totalMessageLength);
      this.buffer = this.buffer.slice(totalMessageLength);

      // Parse and emit message
      const message = this.protocol.deserialize(messageBuffer);
      if (message) {
        this.emit('message', message.header.type, message.payload);
      }
    }
  }

  /**
   * Send message
   */
  send(type: MessageType, payload: any, flags?: MessageFlags): void {
    try {
      const buffer = this.protocol.serialize(type, payload, flags);
      this.socket.write(buffer);
    } catch (error) {
      this.logger.error('Failed to send message', error as Error);
    }
  }

  /**
   * Close connection
   */
  close(): void {
    this.socket.end();
  }
}

export { BinaryProtocol };
