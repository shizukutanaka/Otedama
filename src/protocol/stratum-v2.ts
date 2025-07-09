/**
 * Stratum V2 Protocol Implementation
 * 設計思想: Carmack (効率性), Martin (クリーン), Pike (シンプル)
 * 
 * 特徴:
 * - バイナリプロトコル (効率的データ転送)
 * - 暗号化サポート (セキュリティ強化)
 * - ジョブネゴシエーション (柔軟性向上)
 * - 低レイテンシ通信
 * - 拡張可能アーキテクチャ
 */

import { EventEmitter } from 'events';
import { createServer, Socket } from 'net';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'crypto';

// === 型定義 ===
interface StratumV2Message {
  messageType: number;
  messageLength: number;
  requestId?: number;
  payload: Buffer;
}

interface StratumV2Connection {
  id: string;
  socket: Socket;
  version: number;
  flags: number;
  encrypted: boolean;
  authenticated: boolean;
  subscriptions: Set<string>;
  lastActivity: number;
  cipher?: any;
  decipher?: any;
  sharedSecret?: Buffer;
}

interface JobTemplate {
  templateId: number;
  futureJob: boolean;
  version: number;
  coinbaseOutputMaxAdditionalSize: number;
  coinbaseOutputs: Buffer[];
  coinbaseTransactionVersion: number;
  coinbasePrefix: Buffer;
  coinbaseSuffix: Buffer;
  merkleRoot: Buffer;
  timestamp: number;
  bits: number;
  target: Buffer;
}

interface WorkerInfo {
  workerId: string;
  workerName: string;
  address: string;
  currency: string;
  difficulty: number;
  hashrate: number;
  shares: number;
  validShares: number;
  lastSubmission: number;
}

// === Stratum V2 メッセージタイプ定数 ===
const MessageTypes = {
  // Setup Connection
  SETUP_CONNECTION: 0x00,
  SETUP_CONNECTION_SUCCESS: 0x01,
  SETUP_CONNECTION_ERROR: 0x02,

  // Channel Management
  OPEN_STANDARD_MINING_CHANNEL: 0x10,
  OPEN_STANDARD_MINING_CHANNEL_SUCCESS: 0x11,
  OPEN_STANDARD_MINING_CHANNEL_ERROR: 0x12,
  CLOSE_CHANNEL: 0x13,

  // Mining
  NEW_TEMPLATE: 0x71,
  SET_NEW_PREV_HASH: 0x72,
  SET_TARGET: 0x73,
  SUBMIT_SHARES_STANDARD: 0x1a,
  SUBMIT_SHARES_SUCCESS: 0x1c,
  SUBMIT_SHARES_ERROR: 0x1d,

  // Job Management
  NEW_MINING_JOB: 0x15,
  SET_DIFFICULTY: 0x16,

  // Status
  UPDATE_CHANNEL: 0x17,
  RECONNECT: 0x18
} as const;

// === バイナリプロトコルユーティリティ ===
class BinaryProtocol {
  static encodeMessage(messageType: number, payload: Buffer, requestId?: number): Buffer {
    const hasRequestId = requestId !== undefined;
    const flags = hasRequestId ? 0x01 : 0x00;
    const headerSize = hasRequestId ? 7 : 5;
    const messageLength = payload.length;
    
    const buffer = Buffer.allocUnsafe(headerSize + messageLength);
    let offset = 0;

    // Message type (1 byte)
    buffer.writeUInt8(messageType, offset);
    offset += 1;

    // Flags (1 byte)
    buffer.writeUInt8(flags, offset);
    offset += 1;

    // Message length (3 bytes, little endian)
    buffer.writeUIntLE(messageLength, offset, 3);
    offset += 3;

    // Request ID (2 bytes, little endian) - optional
    if (hasRequestId) {
      buffer.writeUInt16LE(requestId!, offset);
      offset += 2;
    }

    // Payload
    payload.copy(buffer, offset);

    return buffer;
  }

  static decodeMessage(buffer: Buffer): StratumV2Message | null {
    if (buffer.length < 5) return null;

    let offset = 0;

    // Message type
    const messageType = buffer.readUInt8(offset);
    offset += 1;

    // Flags
    const flags = buffer.readUInt8(offset);
    offset += 1;
    const hasRequestId = (flags & 0x01) !== 0;

    // Message length
    const messageLength = buffer.readUIntLE(offset, 3);
    offset += 3;

    // Request ID (optional)
    let requestId: number | undefined;
    if (hasRequestId) {
      requestId = buffer.readUInt16LE(offset);
      offset += 2;
    }

    // Check if we have the complete message
    const expectedTotalLength = offset + messageLength;
    if (buffer.length < expectedTotalLength) return null;

    // Payload
    const payload = buffer.slice(offset, offset + messageLength);

    return {
      messageType,
      messageLength,
      requestId,
      payload
    };
  }

  static encodeVarInt(value: number): Buffer {
    const buffers: Buffer[] = [];
    
    while (value >= 0x80) {
      buffers.push(Buffer.from([value & 0xff | 0x80]));
      value >>>= 7;
    }
    buffers.push(Buffer.from([value & 0xff]));
    
    return Buffer.concat(buffers);
  }

  static decodeVarInt(buffer: Buffer, offset: number = 0): { value: number; offset: number } {
    let value = 0;
    let shift = 0;
    let currentOffset = offset;

    while (currentOffset < buffer.length) {
      const byte = buffer[currentOffset];
      value |= (byte & 0x7f) << shift;
      currentOffset++;

      if ((byte & 0x80) === 0) {
        break;
      }

      shift += 7;
      if (shift >= 32) {
        throw new Error('VarInt too long');
      }
    }

    return { value, offset: currentOffset };
  }

  static encodeString(str: string): Buffer {
    const stringBuffer = Buffer.from(str, 'utf8');
    const lengthBuffer = this.encodeVarInt(stringBuffer.length);
    return Buffer.concat([lengthBuffer, stringBuffer]);
  }

  static decodeString(buffer: Buffer, offset: number = 0): { value: string; offset: number } {
    const lengthResult = this.decodeVarInt(buffer, offset);
    const stringStart = lengthResult.offset;
    const stringEnd = stringStart + lengthResult.value;
    
    if (stringEnd > buffer.length) {
      throw new Error('String extends beyond buffer');
    }

    const value = buffer.slice(stringStart, stringEnd).toString('utf8');
    return { value, offset: stringEnd };
  }
}

// === 暗号化ユーティリティ ===
class EncryptionUtils {
  static generateKeyPair(): { publicKey: Buffer; privateKey: Buffer } {
    // 簡易実装 - 実際の実装ではECDHを使用
    const privateKey = randomBytes(32);
    const publicKey = createHash('sha256').update(privateKey).digest();
    
    return { publicKey, privateKey };
  }

  static deriveSharedSecret(privateKey: Buffer, publicKey: Buffer): Buffer {
    // 簡易実装 - 実際の実装ではECDH共有秘密計算
    return createHash('sha256').update(Buffer.concat([privateKey, publicKey])).digest();
  }

  static createCipher(sharedSecret: Buffer): { cipher: any; decipher: any } {
    const key = createHash('sha256').update(sharedSecret).digest();
    const iv = randomBytes(16);

    const cipher = createCipheriv('aes-256-cbc', key, iv);
    const decipher = createDecipheriv('aes-256-cbc', key, iv);

    return { cipher, decipher };
  }

  static encrypt(data: Buffer, cipher: any): Buffer {
    const encrypted = cipher.update(data);
    const final = cipher.final();
    return Buffer.concat([encrypted, final]);
  }

  static decrypt(data: Buffer, decipher: any): Buffer {
    const decrypted = decipher.update(data);
    const final = decipher.final();
    return Buffer.concat([decrypted, final]);
  }
}

// === ジョブテンプレート管理 ===
class JobTemplateManager {
  private templates = new Map<number, JobTemplate>();
  private currentTemplateId = 1;
  private logger: any;

  constructor(logger: any) {
    this.logger = logger;
  }

  createTemplate(blockTemplate: any): JobTemplate {
    const templateId = this.currentTemplateId++;
    
    const template: JobTemplate = {
      templateId,
      futureJob: false,
      version: blockTemplate.version || 0x20000000,
      coinbaseOutputMaxAdditionalSize: 100,
      coinbaseOutputs: [],
      coinbaseTransactionVersion: 1,
      coinbasePrefix: this.createCoinbasePrefix(blockTemplate),
      coinbaseSuffix: this.createCoinbaseSuffix(blockTemplate),
      merkleRoot: Buffer.from(blockTemplate.merkleRoot || '0'.repeat(64), 'hex'),
      timestamp: Math.floor(Date.now() / 1000),
      bits: parseInt(blockTemplate.bits || '207fffff', 16),
      target: this.bitsToTarget(parseInt(blockTemplate.bits || '207fffff', 16))
    };

    this.templates.set(templateId, template);
    this.logger.info(`Created job template ${templateId}`);
    
    return template;
  }

  private createCoinbasePrefix(blockTemplate: any): Buffer {
    // Coinbase transaction prefix
    const version = Buffer.allocUnsafe(4);
    version.writeUInt32LE(1, 0);

    const inputCount = Buffer.from([0x01]); // 1 input
    const prevTxHash = Buffer.alloc(32); // All zeros for coinbase
    const prevTxIndex = Buffer.allocUnsafe(4);
    prevTxIndex.writeUInt32LE(0xffffffff, 0);

    const height = blockTemplate.height || 0;
    const heightScript = this.encodeHeight(height);
    const scriptSig = Buffer.concat([
      Buffer.from([heightScript.length]),
      heightScript,
      Buffer.from('Otedama Pool', 'ascii')
    ]);

    const scriptSigLength = BinaryProtocol.encodeVarInt(scriptSig.length);
    const sequence = Buffer.allocUnsafe(4);
    sequence.writeUInt32LE(0xffffffff, 0);

    return Buffer.concat([
      version,
      inputCount,
      prevTxHash,
      prevTxIndex,
      scriptSigLength,
      scriptSig,
      sequence
    ]);
  }

  private createCoinbaseSuffix(blockTemplate: any): Buffer {
    const outputCount = Buffer.from([0x01]); // 1 output
    
    const value = Buffer.allocUnsafe(8);
    value.writeBigUInt64LE(BigInt(blockTemplate.coinbaseValue || 625000000), 0);

    const scriptPubKey = Buffer.from('76a914' + '00'.repeat(20) + '88ac', 'hex');
    const scriptLength = BinaryProtocol.encodeVarInt(scriptPubKey.length);

    const lockTime = Buffer.allocUnsafe(4);
    lockTime.writeUInt32LE(0, 0);

    return Buffer.concat([
      outputCount,
      value,
      scriptLength,
      scriptPubKey,
      lockTime
    ]);
  }

  private encodeHeight(height: number): Buffer {
    if (height < 0x100) {
      return Buffer.from([0x01, height]);
    } else if (height < 0x10000) {
      const buffer = Buffer.allocUnsafe(3);
      buffer.writeUInt8(0x02, 0);
      buffer.writeUInt16LE(height, 1);
      return buffer;
    } else if (height < 0x1000000) {
      const buffer = Buffer.allocUnsafe(4);
      buffer.writeUInt8(0x03, 0);
      buffer.writeUIntLE(height, 1, 3);
      return buffer;
    } else {
      const buffer = Buffer.allocUnsafe(5);
      buffer.writeUInt8(0x04, 0);
      buffer.writeUInt32LE(height, 1);
      return buffer;
    }
  }

  private bitsToTarget(bits: number): Buffer {
    const exponent = bits >>> 24;
    const mantissa = bits & 0x00ffffff;
    
    const target = Buffer.alloc(32);
    if (exponent <= 3) {
      const value = mantissa >>> (8 * (3 - exponent));
      target.writeUIntBE(value, 29, 3);
    } else {
      const value = mantissa;
      target.writeUIntBE(value, 32 - exponent, 3);
    }
    
    return target;
  }

  getTemplate(templateId: number): JobTemplate | undefined {
    return this.templates.get(templateId);
  }

  getAllTemplates(): JobTemplate[] {
    return Array.from(this.templates.values());
  }

  cleanupOldTemplates(): void {
    const now = Date.now();
    const maxAge = 10 * 60 * 1000; // 10 minutes

    for (const [templateId, template] of this.templates) {
      if (now - template.timestamp * 1000 > maxAge) {
        this.templates.delete(templateId);
        this.logger.debug(`Cleaned up old template ${templateId}`);
      }
    }
  }
}

// === Stratum V2 サーバー ===
export class StratumV2Server extends EventEmitter {
  private server?: any;
  private connections = new Map<string, StratumV2Connection>();
  private workers = new Map<string, WorkerInfo>();
  private jobTemplateManager: JobTemplateManager;
  private logger: any;
  private port: number;
  private currentDifficulty = 1;

  constructor(port: number, logger: any) {
    super();
    this.port = port;
    this.logger = logger;
    this.jobTemplateManager = new JobTemplateManager(logger);
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        this.handleNewConnection(socket);
      });

      this.server.on('error', (error: Error) => {
        this.logger.error('Stratum V2 server error:', error);
        reject(error);
      });

      this.server.listen(this.port, () => {
        this.logger.success(`Stratum V2 server listening on port ${this.port}`);
        this.startCleanupTimer();
        resolve();
      });
    });
  }

  private handleNewConnection(socket: Socket): void {
    const connectionId = `conn_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
    
    const connection: StratumV2Connection = {
      id: connectionId,
      socket,
      version: 2,
      flags: 0,
      encrypted: false,
      authenticated: false,
      subscriptions: new Set(),
      lastActivity: Date.now(),
      sharedSecret: undefined
    };

    this.connections.set(connectionId, connection);
    
    this.logger.info(`New Stratum V2 connection: ${connectionId} from ${socket.remoteAddress}:${socket.remotePort}`);

    // データ受信ハンドラ
    let buffer = Buffer.alloc(0);
    socket.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      this.processMessages(connection, buffer);
    });

    // 切断ハンドラ
    socket.on('close', () => {
      this.handleConnectionClose(connectionId);
    });

    socket.on('error', (error: Error) => {
      this.logger.error(`Connection error for ${connectionId}:`, error);
      this.handleConnectionClose(connectionId);
    });

    // アクティビティ更新
    connection.lastActivity = Date.now();
  }

  private processMessages(connection: StratumV2Connection, buffer: Buffer): void {
    let offset = 0;

    while (offset < buffer.length) {
      const remainingBuffer = buffer.slice(offset);
      const message = BinaryProtocol.decodeMessage(remainingBuffer);
      
      if (!message) {
        // 不完全なメッセージ - 次のデータを待つ
        break;
      }

      const messageSize = 5 + (message.requestId !== undefined ? 2 : 0) + message.messageLength;
      offset += messageSize;

      // メッセージ処理
      this.handleMessage(connection, message);
      
      // アクティビティ更新
      connection.lastActivity = Date.now();
    }

    // 処理済みデータを削除
    if (offset > 0) {
      buffer = buffer.slice(offset);
    }
  }

  private async handleMessage(connection: StratumV2Connection, message: StratumV2Message): Promise<void> {
    try {
      switch (message.messageType) {
        case MessageTypes.SETUP_CONNECTION:
          await this.handleSetupConnection(connection, message);
          break;

        case MessageTypes.OPEN_STANDARD_MINING_CHANNEL:
          await this.handleOpenMiningChannel(connection, message);
          break;

        case MessageTypes.SUBMIT_SHARES_STANDARD:
          await this.handleSubmitShares(connection, message);
          break;

        default:
          this.logger.warn(`Unknown message type: ${message.messageType}`);
          break;
      }
    } catch (error) {
      this.logger.error(`Error handling message type ${message.messageType}:`, error);
    }
  }

  private async handleSetupConnection(connection: StratumV2Connection, message: StratumV2Message): Promise<void> {
    try {
      let offset = 0;
      const payload = message.payload;

      // Protocol version
      const versionResult = BinaryProtocol.decodeVarInt(payload, offset);
      const protocolVersion = versionResult.value;
      offset = versionResult.offset;

      // Flags
      const flags = payload.readUInt32LE(offset);
      offset += 4;

      // Endpoint host
      const endpointResult = BinaryProtocol.decodeString(payload, offset);
      const endpointHost = endpointResult.value;
      offset = endpointResult.offset;

      // Endpoint port
      const endpointPort = payload.readUInt16LE(offset);
      offset += 2;

      // Device information
      const deviceResult = BinaryProtocol.decodeString(payload, offset);
      const deviceInfo = deviceResult.value;
      offset = deviceResult.offset;

      this.logger.info(`Setup connection: version=${protocolVersion}, endpoint=${endpointHost}:${endpointPort}, device=${deviceInfo}`);

      // 接続承認
      connection.version = protocolVersion;
      connection.flags = flags;

      // 暗号化が要求されている場合
      if (flags & 0x01) {
        await this.setupEncryption(connection);
      }

      // 成功レスポンス送信
      const responsePayload = Buffer.concat([
        BinaryProtocol.encodeVarInt(2), // Server version
        Buffer.allocUnsafe(4) // Flags (0)
      ]);

      const response = BinaryProtocol.encodeMessage(
        MessageTypes.SETUP_CONNECTION_SUCCESS,
        responsePayload,
        message.requestId
      );

      this.sendMessage(connection, response);
      
      this.emit('connectionSetup', {
        connectionId: connection.id,
        version: protocolVersion,
        device: deviceInfo
      });

    } catch (error) {
      this.logger.error('Setup connection failed:', error);
      
      const errorPayload = BinaryProtocol.encodeString('Setup failed');
      const errorResponse = BinaryProtocol.encodeMessage(
        MessageTypes.SETUP_CONNECTION_ERROR,
        errorPayload,
        message.requestId
      );
      
      this.sendMessage(connection, errorResponse);
    }
  }

  private async setupEncryption(connection: StratumV2Connection): Promise<void> {
    // 暗号化セットアップの簡易実装
    const keyPair = EncryptionUtils.generateKeyPair();
    
    // 共有秘密の計算（実際の実装ではクライアントの公開鍵が必要）
    connection.sharedSecret = keyPair.privateKey; // 簡易実装
    
    const cipherPair = EncryptionUtils.createCipher(connection.sharedSecret);
    connection.cipher = cipherPair.cipher;
    connection.decipher = cipherPair.decipher;
    connection.encrypted = true;

    this.logger.info(`Encryption enabled for connection ${connection.id}`);
  }

  private async handleOpenMiningChannel(connection: StratumV2Connection, message: StratumV2Message): Promise<void> {
    try {
      let offset = 0;
      const payload = message.payload;

      // Request ID
      const requestIdResult = BinaryProtocol.decodeVarInt(payload, offset);
      const requestId = requestIdResult.value;
      offset = requestIdResult.offset;

      // User identity
      const userResult = BinaryProtocol.decodeString(payload, offset);
      const userIdentity = userResult.value;
      offset = userResult.offset;

      // Nominal hash rate
      const nominalHashrate = payload.readBigUInt64LE(offset);
      offset += 8;

      // Max target
      const maxTarget = payload.slice(offset, offset + 32);
      offset += 32;

      this.logger.info(`Open mining channel: user=${userIdentity}, hashrate=${nominalHashrate}, maxTarget=${maxTarget.toString('hex')}`);

      // ユーザー情報解析
      const [address, currency, workerName] = userIdentity.split('.');
      
      // ワーカー登録
      const workerId = `worker_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
      const worker: WorkerInfo = {
        workerId,
        workerName: workerName || 'worker1',
        address,
        currency: currency || 'BTC',
        difficulty: this.currentDifficulty,
        hashrate: Number(nominalHashrate),
        shares: 0,
        validShares: 0,
        lastSubmission: Date.now()
      };

      this.workers.set(workerId, worker);
      connection.authenticated = true;

      // チャンネルID生成
      const channelId = Math.floor(Math.random() * 0xffffffff);

      // 成功レスポンス
      const responsePayload = Buffer.concat([
        BinaryProtocol.encodeVarInt(requestId),
        Buffer.allocUnsafe(4), // Channel ID
        BinaryProtocol.encodeString(workerId),
        Buffer.allocUnsafe(32) // Target
      ]);

      responsePayload.writeUInt32LE(channelId, 1 + BinaryProtocol.encodeVarInt(requestId).length);
      maxTarget.copy(responsePayload, responsePayload.length - 32);

      const response = BinaryProtocol.encodeMessage(
        MessageTypes.OPEN_STANDARD_MINING_CHANNEL_SUCCESS,
        responsePayload,
        message.requestId
      );

      this.sendMessage(connection, response);

      // 初期ジョブ送信
      await this.sendNewJob(connection, channelId);

      this.emit('workerConnected', {
        connectionId: connection.id,
        workerId,
        worker
      });

    } catch (error) {
      this.logger.error('Open mining channel failed:', error);
      
      const errorPayload = BinaryProtocol.encodeString('Channel open failed');
      const errorResponse = BinaryProtocol.encodeMessage(
        MessageTypes.OPEN_STANDARD_MINING_CHANNEL_ERROR,
        errorPayload,
        message.requestId
      );
      
      this.sendMessage(connection, errorResponse);
    }
  }

  private async handleSubmitShares(connection: StratumV2Connection, message: StratumV2Message): Promise<void> {
    try {
      let offset = 0;
      const payload = message.payload;

      // Channel ID
      const channelId = payload.readUInt32LE(offset);
      offset += 4;

      // Sequence number
      const sequenceNumber = payload.readUInt32LE(offset);
      offset += 4;

      // Job ID
      const jobId = payload.readUInt32LE(offset);
      offset += 4;

      // Nonce
      const nonce = payload.readUInt32LE(offset);
      offset += 4;

      // Timestamp
      const timestamp = payload.readUInt32LE(offset);
      offset += 4;

      // Version (optional)
      const version = payload.length > offset ? payload.readUInt32LE(offset) : 0x20000000;

      this.logger.debug(`Share submission: channel=${channelId}, job=${jobId}, nonce=${nonce}, timestamp=${timestamp}`);

      // シェア検証
      const isValid = await this.validateShare(channelId, jobId, nonce, timestamp);
      
      // ワーカー統計更新
      const worker = this.findWorkerByConnection(connection.id);
      if (worker) {
        worker.shares++;
        worker.lastSubmission = Date.now();
        
        if (isValid) {
          worker.validShares++;
        }
      }

      if (isValid) {
        // 成功レスポンス
        const responsePayload = Buffer.concat([
          Buffer.allocUnsafe(4), // Channel ID
          Buffer.allocUnsafe(4), // Sequence number
          Buffer.allocUnsafe(32) // Last template ID
        ]);

        responsePayload.writeUInt32LE(channelId, 0);
        responsePayload.writeUInt32LE(sequenceNumber, 4);

        const response = BinaryProtocol.encodeMessage(
          MessageTypes.SUBMIT_SHARES_SUCCESS,
          responsePayload
        );

        this.sendMessage(connection, response);

        this.emit('shareAccepted', {
          connectionId: connection.id,
          workerId: worker?.workerId,
          channelId,
          jobId,
          nonce,
          difficulty: worker?.difficulty || this.currentDifficulty
        });

      } else {
        // エラーレスポンス
        const errorPayload = Buffer.concat([
          Buffer.allocUnsafe(4), // Channel ID
          Buffer.allocUnsafe(4), // Sequence number
          BinaryProtocol.encodeString('Invalid share')
        ]);

        errorPayload.writeUInt32LE(channelId, 0);
        errorPayload.writeUInt32LE(sequenceNumber, 4);

        const response = BinaryProtocol.encodeMessage(
          MessageTypes.SUBMIT_SHARES_ERROR,
          errorPayload
        );

        this.sendMessage(connection, response);

        this.emit('shareRejected', {
          connectionId: connection.id,
          workerId: worker?.workerId,
          channelId,
          jobId,
          nonce,
          reason: 'Invalid share'
        });
      }

    } catch (error) {
      this.logger.error('Submit shares failed:', error);
    }
  }

  private async validateShare(channelId: number, jobId: number, nonce: number, timestamp: number): Promise<boolean> {
    // シェア検証の簡易実装
    // 実際の実装では、ジョブテンプレートと難易度に基づいて検証
    
    const template = this.jobTemplateManager.getTemplate(jobId);
    if (!template) {
      return false;
    }

    // 簡易検証 - 実際にはSHA-256計算とターゲット比較が必要
    const shareHash = createHash('sha256')
      .update(Buffer.concat([
        Buffer.allocUnsafe(4).fill(nonce),
        Buffer.allocUnsafe(4).fill(timestamp),
        template.merkleRoot
      ]))
      .digest();

    // ターゲットとの比較（簡易）
    return shareHash[0] === 0; // 簡易: 最初のバイトが0
  }

  private async sendNewJob(connection: StratumV2Connection, channelId: number): Promise<void> {
    // 新しいジョブテンプレート作成
    const template = this.jobTemplateManager.createTemplate({
      height: 750000,
      version: 0x20000000,
      bits: '207fffff',
      coinbaseValue: 625000000
    });

    // ジョブメッセージ作成
    const payload = Buffer.concat([
      Buffer.allocUnsafe(4), // Channel ID
      Buffer.allocUnsafe(4), // Job ID
      Buffer.allocUnsafe(4), // Version
      template.coinbasePrefix,
      template.coinbaseSuffix,
      template.merkleRoot,
      Buffer.allocUnsafe(4), // Timestamp
      Buffer.allocUnsafe(4), // Bits
      template.target
    ]);

    payload.writeUInt32LE(channelId, 0);
    payload.writeUInt32LE(template.templateId, 4);
    payload.writeUInt32LE(template.version, 8);

    const timestampOffset = 12 + template.coinbasePrefix.length + template.coinbaseSuffix.length + 32;
    payload.writeUInt32LE(template.timestamp, timestampOffset);
    payload.writeUInt32LE(template.bits, timestampOffset + 4);

    const message = BinaryProtocol.encodeMessage(MessageTypes.NEW_MINING_JOB, payload);
    this.sendMessage(connection, message);

    this.logger.debug(`Sent new job ${template.templateId} to connection ${connection.id}`);
  }

  private sendMessage(connection: StratumV2Connection, message: Buffer): void {
    try {
      if (connection.socket.destroyed) {
        return;
      }

      let dataToSend = message;

      // 暗号化が有効な場合
      if (connection.encrypted && connection.cipher) {
        dataToSend = EncryptionUtils.encrypt(message, connection.cipher);
      }

      connection.socket.write(dataToSend);
    } catch (error) {
      this.logger.error(`Failed to send message to ${connection.id}:`, error);
    }
  }

  private findWorkerByConnection(connectionId: string): WorkerInfo | undefined {
    // 接続IDからワーカーを見つける（簡易実装）
    return Array.from(this.workers.values())[0]; // 簡易実装
  }

  private handleConnectionClose(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (connection) {
      this.connections.delete(connectionId);
      
      // 関連ワーカーを削除
      const worker = this.findWorkerByConnection(connectionId);
      if (worker) {
        this.workers.delete(worker.workerId);
        
        this.emit('workerDisconnected', {
          connectionId,
          workerId: worker.workerId
        });
      }

      this.logger.info(`Connection closed: ${connectionId}`);
    }
  }

  private startCleanupTimer(): void {
    setInterval(() => {
      // 古いテンプレートのクリーンアップ
      this.jobTemplateManager.cleanupOldTemplates();

      // 非アクティブ接続のクリーンアップ
      const now = Date.now();
      const timeout = 5 * 60 * 1000; // 5分

      for (const [connectionId, connection] of this.connections) {
        if (now - connection.lastActivity > timeout) {
          this.logger.warn(`Closing inactive connection: ${connectionId}`);
          connection.socket.destroy();
          this.handleConnectionClose(connectionId);
        }
      }
    }, 60000); // 1分間隔
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        // 全接続を閉じる
        for (const connection of this.connections.values()) {
          connection.socket.destroy();
        }

        this.server.close(() => {
          this.logger.info('Stratum V2 server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  // 統計情報取得
  getStats(): any {
    const connections = Array.from(this.connections.values());
    const workers = Array.from(this.workers.values());

    return {
      connections: {
        total: connections.length,
        encrypted: connections.filter(c => c.encrypted).length,
        authenticated: connections.filter(c => c.authenticated).length
      },
      workers: {
        total: workers.length,
        totalShares: workers.reduce((sum, w) => sum + w.shares, 0),
        validShares: workers.reduce((sum, w) => sum + w.validShares, 0),
        totalHashrate: workers.reduce((sum, w) => sum + w.hashrate, 0)
      },
      templates: this.jobTemplateManager.getAllTemplates().length,
      protocol: 'Stratum V2',
      version: 2
    };
  }

  // 新しいブロックテンプレート設定
  updateBlockTemplate(blockTemplate: any): void {
    const template = this.jobTemplateManager.createTemplate(blockTemplate);
    
    // 全接続に新しいジョブを送信
    for (const connection of this.connections.values()) {
      if (connection.authenticated) {
        this.sendNewJob(connection, 1); // 簡易実装: チャンネルID=1
      }
    }

    this.emit('newTemplate', { templateId: template.templateId });
    this.logger.info(`Updated block template: ${template.templateId}`);
  }

  // 難易度変更
  setDifficulty(difficulty: number): void {
    this.currentDifficulty = difficulty;
    
    // 全ワーカーの難易度を更新
    for (const worker of this.workers.values()) {
      worker.difficulty = difficulty;
    }

    this.logger.info(`Set difficulty to ${difficulty}`);
  }

  // ワーカー一覧取得
  getWorkers(): WorkerInfo[] {
    return Array.from(this.workers.values());
  }

  // 接続一覧取得
  getConnections(): StratumV2Connection[] {
    return Array.from(this.connections.values());
  }
}

export { StratumV2Connection, WorkerInfo, JobTemplate, MessageTypes, BinaryProtocol };
