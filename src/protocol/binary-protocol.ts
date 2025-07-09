/**
 * バイナリプロトコル実装
 * JSON Stratumより高効率な通信プロトコル
 */

import { EventEmitter } from 'events';

// プロトコルバージョン
export const BINARY_PROTOCOL_VERSION = 1;

// メッセージタイプ
export enum MessageType {
  // 基本メッセージ
  PING = 0x01,
  PONG = 0x02,
  ERROR = 0x03,
  
  // 認証
  AUTH_REQUEST = 0x10,
  AUTH_RESPONSE = 0x11,
  AUTH_SUCCESS = 0x12,
  AUTH_FAILURE = 0x13,
  
  // ジョブ管理
  JOB_NOTIFY = 0x20,
  JOB_REQUEST = 0x21,
  
  // シェア送信
  SHARE_SUBMIT = 0x30,
  SHARE_ACCEPT = 0x31,
  SHARE_REJECT = 0x32,
  
  // 難易度調整
  DIFFICULTY_SET = 0x40,
  TARGET_SET = 0x41,
  
  // 統計情報
  STATS_REQUEST = 0x50,
  STATS_RESPONSE = 0x51,
  
  // プール情報
  POOL_INFO = 0x60,
  MINER_INFO = 0x61
}

// エラーコード
export enum ErrorCode {
  UNKNOWN_ERROR = 0x00,
  INVALID_MESSAGE = 0x01,
  INVALID_AUTH = 0x02,
  INVALID_SHARE = 0x03,
  RATE_LIMITED = 0x04,
  POOL_FULL = 0x05,
  MAINTENANCE = 0x06
}

// バイナリメッセージのヘッダー構造
export interface MessageHeader {
  version: number;    // 1バイト
  type: MessageType;  // 1バイト
  length: number;     // 2バイト（ペイロード長）
  sequence: number;   // 4バイト（シーケンス番号）
  checksum: number;   // 4バイト（CRC32チェックサム）
}

export interface BinaryMessage {
  header: MessageHeader;
  payload: Buffer;
}

export interface AuthRequest {
  username: string;
  password: string;
  workerName?: string;
  capabilities: number; // ビットフラグ
}

export interface JobNotification {
  jobId: string;
  prevHash: string;
  coinbase1: string;
  coinbase2: string;
  merkleRoots: string[];
  version: number;
  bits: number;
  timestamp: number;
  cleanJobs: boolean;
}

export interface ShareSubmission {
  jobId: string;
  nonce: number;
  timestamp: number;
  extraNonce2: string;
}

export interface StatsResponse {
  poolHashrate: number;
  minerCount: number;
  blockHeight: number;
  difficulty: number;
  lastBlockTime: number;
}

export class BinaryProtocol extends EventEmitter {
  private sequenceNumber = 0;
  private messageBuffer = Buffer.alloc(0);
  private stats = {
    messagesSent: 0,
    messagesReceived: 0,
    bytesTransmitted: 0,
    bytesReceived: 0,
    compressionRatio: 0,
    errors: 0
  };

  constructor() {
    super();
    console.log('[Binary Protocol] Initialized protocol version', BINARY_PROTOCOL_VERSION);
  }

  /**
   * メッセージをエンコード
   */
  public encode(type: MessageType, payload: any): Buffer {
    const payloadBuffer = this.encodePayload(type, payload);
    const header = this.createHeader(type, payloadBuffer.length);
    const headerBuffer = this.encodeHeader(header);
    
    const message = Buffer.concat([headerBuffer, payloadBuffer]);
    
    this.stats.messagesSent++;
    this.stats.bytesTransmitted += message.length;
    
    return message;
  }

  /**
   * バッファからメッセージをデコード
   */
  public decode(buffer: Buffer): BinaryMessage[] {
    this.messageBuffer = Buffer.concat([this.messageBuffer, buffer]);
    this.stats.bytesReceived += buffer.length;
    
    const messages: BinaryMessage[] = [];
    
    while (this.messageBuffer.length >= 12) { // ヘッダーサイズ
      const header = this.decodeHeader(this.messageBuffer);
      const totalMessageSize = 12 + header.length;
      
      // 完全なメッセージが受信されていない場合は待機
      if (this.messageBuffer.length < totalMessageSize) {
        break;
      }
      
      // ペイロードを抽出
      const payload = this.messageBuffer.slice(12, totalMessageSize);
      
      // チェックサム検証
      if (!this.verifyChecksum(header, payload)) {
        console.error('[Binary Protocol] Checksum verification failed');
        this.stats.errors++;
        this.messageBuffer = this.messageBuffer.slice(totalMessageSize);
        continue;
      }
      
      messages.push({ header, payload });
      this.messageBuffer = this.messageBuffer.slice(totalMessageSize);
      this.stats.messagesReceived++;
    }
    
    return messages;
  }

  /**
   * ヘッダーを作成
   */
  private createHeader(type: MessageType, payloadLength: number): MessageHeader {
    return {
      version: BINARY_PROTOCOL_VERSION,
      type,
      length: payloadLength,
      sequence: ++this.sequenceNumber,
      checksum: 0 // 後で計算
    };
  }

  /**
   * ヘッダーをエンコード
   */
  private encodeHeader(header: MessageHeader): Buffer {
    const buffer = Buffer.allocUnsafe(12);
    let offset = 0;
    
    buffer.writeUInt8(header.version, offset); offset += 1;
    buffer.writeUInt8(header.type, offset); offset += 1;
    buffer.writeUInt16BE(header.length, offset); offset += 2;
    buffer.writeUInt32BE(header.sequence, offset); offset += 4;
    buffer.writeUInt32BE(header.checksum, offset);
    
    return buffer;
  }

  /**
   * ヘッダーをデコード
   */
  private decodeHeader(buffer: Buffer): MessageHeader {
    let offset = 0;
    
    const version = buffer.readUInt8(offset); offset += 1;
    const type = buffer.readUInt8(offset); offset += 1;
    const length = buffer.readUInt16BE(offset); offset += 2;
    const sequence = buffer.readUInt32BE(offset); offset += 4;
    const checksum = buffer.readUInt32BE(offset);
    
    return { version, type, length, sequence, checksum };
  }

  /**
   * ペイロードをエンコード
   */
  private encodePayload(type: MessageType, payload: any): Buffer {
    switch (type) {
      case MessageType.AUTH_REQUEST:
        return this.encodeAuthRequest(payload as AuthRequest);
      
      case MessageType.JOB_NOTIFY:
        return this.encodeJobNotification(payload as JobNotification);
      
      case MessageType.SHARE_SUBMIT:
        return this.encodeShareSubmission(payload as ShareSubmission);
      
      case MessageType.STATS_RESPONSE:
        return this.encodeStatsResponse(payload as StatsResponse);
      
      case MessageType.ERROR:
        return this.encodeError(payload);
      
      case MessageType.PING:
      case MessageType.PONG:
        return Buffer.alloc(0); // 空のペイロード
      
      default:
        return this.encodeGeneric(payload);
    }
  }

  /**
   * 認証リクエストをエンコード
   */
  private encodeAuthRequest(auth: AuthRequest): Buffer {
    const usernameBuffer = Buffer.from(auth.username, 'utf8');
    const passwordBuffer = Buffer.from(auth.password, 'utf8');
    const workerNameBuffer = Buffer.from(auth.workerName || '', 'utf8');
    
    const buffer = Buffer.allocUnsafe(
      2 + usernameBuffer.length +    // username length + data
      2 + passwordBuffer.length +    // password length + data
      2 + workerNameBuffer.length +  // worker name length + data
      4                              // capabilities
    );
    
    let offset = 0;
    
    // Username
    buffer.writeUInt16BE(usernameBuffer.length, offset); offset += 2;
    usernameBuffer.copy(buffer, offset); offset += usernameBuffer.length;
    
    // Password
    buffer.writeUInt16BE(passwordBuffer.length, offset); offset += 2;
    passwordBuffer.copy(buffer, offset); offset += passwordBuffer.length;
    
    // Worker name
    buffer.writeUInt16BE(workerNameBuffer.length, offset); offset += 2;
    workerNameBuffer.copy(buffer, offset); offset += workerNameBuffer.length;
    
    // Capabilities
    buffer.writeUInt32BE(auth.capabilities, offset);
    
    return buffer;
  }

  /**
   * ジョブ通知をエンコード
   */
  private encodeJobNotification(job: JobNotification): Buffer {
    const jobIdBuffer = Buffer.from(job.jobId, 'hex');
    const prevHashBuffer = Buffer.from(job.prevHash, 'hex');
    const coinbase1Buffer = Buffer.from(job.coinbase1, 'hex');
    const coinbase2Buffer = Buffer.from(job.coinbase2, 'hex');
    
    // Merkle rootsのサイズを計算
    const merkleBuffers = job.merkleRoots.map(root => Buffer.from(root, 'hex'));
    const merkleSize = merkleBuffers.reduce((sum, buf) => sum + buf.length, 0);
    
    const buffer = Buffer.allocUnsafe(
      1 + jobIdBuffer.length +        // job ID length + data
      32 +                            // prev hash (固定32バイト)
      2 + coinbase1Buffer.length +    // coinbase1 length + data
      2 + coinbase2Buffer.length +    // coinbase2 length + data
      1 + merkleSize +                // merkle count + data
      4 +                             // version
      4 +                             // bits
      4 +                             // timestamp
      1                               // clean jobs flag
    );
    
    let offset = 0;
    
    // Job ID
    buffer.writeUInt8(jobIdBuffer.length, offset); offset += 1;
    jobIdBuffer.copy(buffer, offset); offset += jobIdBuffer.length;
    
    // Previous hash
    prevHashBuffer.copy(buffer, offset); offset += 32;
    
    // Coinbase1
    buffer.writeUInt16BE(coinbase1Buffer.length, offset); offset += 2;
    coinbase1Buffer.copy(buffer, offset); offset += coinbase1Buffer.length;
    
    // Coinbase2
    buffer.writeUInt16BE(coinbase2Buffer.length, offset); offset += 2;
    coinbase2Buffer.copy(buffer, offset); offset += coinbase2Buffer.length;
    
    // Merkle roots
    buffer.writeUInt8(merkleBuffers.length, offset); offset += 1;
    for (const merkleBuffer of merkleBuffers) {
      merkleBuffer.copy(buffer, offset); offset += merkleBuffer.length;
    }
    
    // Version, bits, timestamp
    buffer.writeUInt32BE(job.version, offset); offset += 4;
    buffer.writeUInt32BE(job.bits, offset); offset += 4;
    buffer.writeUInt32BE(job.timestamp, offset); offset += 4;
    
    // Clean jobs flag
    buffer.writeUInt8(job.cleanJobs ? 1 : 0, offset);
    
    return buffer;
  }

  /**
   * シェア送信をエンコード
   */
  private encodeShareSubmission(share: ShareSubmission): Buffer {
    const jobIdBuffer = Buffer.from(share.jobId, 'hex');
    const extraNonce2Buffer = Buffer.from(share.extraNonce2, 'hex');
    
    const buffer = Buffer.allocUnsafe(
      1 + jobIdBuffer.length +         // job ID length + data
      4 +                              // nonce
      4 +                              // timestamp
      1 + extraNonce2Buffer.length     // extra nonce2 length + data
    );
    
    let offset = 0;
    
    // Job ID
    buffer.writeUInt8(jobIdBuffer.length, offset); offset += 1;
    jobIdBuffer.copy(buffer, offset); offset += jobIdBuffer.length;
    
    // Nonce
    buffer.writeUInt32BE(share.nonce, offset); offset += 4;
    
    // Timestamp
    buffer.writeUInt32BE(share.timestamp, offset); offset += 4;
    
    // Extra nonce2
    buffer.writeUInt8(extraNonce2Buffer.length, offset); offset += 1;
    extraNonce2Buffer.copy(buffer, offset);
    
    return buffer;
  }

  /**
   * 統計レスポンスをエンコード
   */
  private encodeStatsResponse(stats: StatsResponse): Buffer {
    const buffer = Buffer.allocUnsafe(28); // 7 * 4バイト
    let offset = 0;
    
    buffer.writeDoubleLE(stats.poolHashrate, offset); offset += 8;
    buffer.writeUInt32BE(stats.minerCount, offset); offset += 4;
    buffer.writeUInt32BE(stats.blockHeight, offset); offset += 4;
    buffer.writeDoubleLE(stats.difficulty, offset); offset += 8;
    buffer.writeUInt32BE(stats.lastBlockTime, offset);
    
    return buffer;
  }

  /**
   * エラーをエンコード
   */
  private encodeError(error: { code: ErrorCode; message: string }): Buffer {
    const messageBuffer = Buffer.from(error.message, 'utf8');
    const buffer = Buffer.allocUnsafe(3 + messageBuffer.length);
    
    buffer.writeUInt8(error.code, 0);
    buffer.writeUInt16BE(messageBuffer.length, 1);
    messageBuffer.copy(buffer, 3);
    
    return buffer;
  }

  /**
   * 汎用エンコード（JSON fallback）
   */
  private encodeGeneric(payload: any): Buffer {
    const json = JSON.stringify(payload);
    return Buffer.from(json, 'utf8');
  }

  /**
   * CRC32チェックサム計算
   */
  private calculateCrc32(buffer: Buffer): number {
    const crcTable = this.getCrc32Table();
    let crc = 0xFFFFFFFF;
    
    for (let i = 0; i < buffer.length; i++) {
      crc = crcTable[(crc ^ buffer[i]) & 0xFF] ^ (crc >>> 8);
    }
    
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  /**
   * CRC32テーブル取得
   */
  private getCrc32Table(): number[] {
    const table: number[] = [];
    
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c;
    }
    
    return table;
  }

  /**
   * チェックサム検証
   */
  private verifyChecksum(header: MessageHeader, payload: Buffer): boolean {
    const calculatedChecksum = this.calculateCrc32(payload);
    return header.checksum === calculatedChecksum;
  }

  /**
   * 圧縮率計算
   */
  public calculateCompressionRatio(originalSize: number, compressedSize: number): number {
    return ((originalSize - compressedSize) / originalSize) * 100;
  }

  /**
   * プロトコル統計取得
   */
  public getStats() {
    return {
      ...this.stats,
      protocolVersion: BINARY_PROTOCOL_VERSION,
      avgMessageSize: this.stats.messagesReceived > 0 
        ? this.stats.bytesReceived / this.stats.messagesReceived 
        : 0,
      errorRate: this.stats.messagesReceived > 0 
        ? (this.stats.errors / this.stats.messagesReceived) * 100 
        : 0
    };
  }

  /**
   * 統計リセット
   */
  public resetStats(): void {
    this.stats = {
      messagesSent: 0,
      messagesReceived: 0,
      bytesTransmitted: 0,
      bytesReceived: 0,
      compressionRatio: 0,
      errors: 0
    };
  }

  /**
   * ベンチマーク：JSON vs Binary
   */
  public benchmark(testPayload: any, iterations: number = 1000): {
    jsonSize: number;
    binarySize: number;
    compressionRatio: number;
    jsonTime: number;
    binaryTime: number;
    speedup: number;
  } {
    // JSON ベンチマーク
    const jsonStart = process.hrtime.bigint();
    let jsonSize = 0;
    for (let i = 0; i < iterations; i++) {
      const jsonData = JSON.stringify(testPayload);
      jsonSize = Buffer.from(jsonData, 'utf8').length;
    }
    const jsonEnd = process.hrtime.bigint();
    const jsonTime = Number(jsonEnd - jsonStart) / 1000000; // ミリ秒

    // Binary ベンチマーク
    const binaryStart = process.hrtime.bigint();
    let binarySize = 0;
    for (let i = 0; i < iterations; i++) {
      const binaryData = this.encode(MessageType.STATS_RESPONSE, testPayload);
      binarySize = binaryData.length;
    }
    const binaryEnd = process.hrtime.bigint();
    const binaryTime = Number(binaryEnd - binaryStart) / 1000000; // ミリ秒

    const compressionRatio = this.calculateCompressionRatio(jsonSize, binarySize);
    const speedup = jsonTime / binaryTime;

    console.log(`[Binary Protocol] Benchmark Results (${iterations} iterations):`);
    console.log(`  JSON: ${jsonSize} bytes, ${jsonTime.toFixed(2)}ms`);
    console.log(`  Binary: ${binarySize} bytes, ${binaryTime.toFixed(2)}ms`);
    console.log(`  Compression: ${compressionRatio.toFixed(1)}%`);
    console.log(`  Speedup: ${speedup.toFixed(2)}x`);

    return { jsonSize, binarySize, compressionRatio, jsonTime, binaryTime, speedup };
  }
}

export default BinaryProtocol;