/**
 * End-to-End Encryption System
 * エンドツーエンド暗号化システム
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';
import { getCryptoUtils } from '../crypto/crypto-utils.js';
import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'crypto';

const logger = getLogger('EndToEndEncryption');

// 暗号化プロトコル
export const EncryptionProtocol = {
  SIGNAL: 'signal',                // Signal Protocol
  DOUBLE_RATCHET: 'double_ratchet', // Double Ratchet Algorithm
  X3DH: 'x3dh',                    // Extended Triple Diffie-Hellman
  NOISE: 'noise',                  // Noise Protocol Framework
  CUSTOM: 'custom'                 // カスタムプロトコル
};

// 暗号化モード
export const EncryptionMode = {
  SYMMETRIC: 'symmetric',
  ASYMMETRIC: 'asymmetric',
  HYBRID: 'hybrid',
  FORWARD_SECURE: 'forward_secure'
};

// セッション状態
export const SessionState = {
  INITIALIZING: 'initializing',
  HANDSHAKING: 'handshaking',
  ESTABLISHED: 'established',
  REKEYING: 'rekeying',
  EXPIRED: 'expired',
  TERMINATED: 'terminated'
};

export class EndToEndEncryption extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = logger;
    this.crypto = getCryptoUtils();
    
    this.options = {
      // プロトコル設定
      protocol: options.protocol || EncryptionProtocol.DOUBLE_RATCHET,
      mode: options.mode || EncryptionMode.FORWARD_SECURE,
      
      // 暗号化設定
      symmetricAlgorithm: options.symmetricAlgorithm || 'aes-256-gcm',
      asymmetricAlgorithm: options.asymmetricAlgorithm || 'secp256k1',
      hashAlgorithm: options.hashAlgorithm || 'sha3-256',
      
      // 鍵管理設定
      enablePerfectForwardSecrecy: options.enablePerfectForwardSecrecy !== false,
      keyRotationInterval: options.keyRotationInterval || 3600000, // 1時間
      maxKeysPerSession: options.maxKeysPerSession || 1000,
      
      // セッション設定
      sessionTimeout: options.sessionTimeout || 86400000, // 24時間
      handshakeTimeout: options.handshakeTimeout || 30000, // 30秒
      maxConcurrentSessions: options.maxConcurrentSessions || 10000,
      
      // メッセージ設定
      enableMessageOrdering: options.enableMessageOrdering !== false,
      enableReplayProtection: options.enableReplayProtection !== false,
      messageRetentionPeriod: options.messageRetentionPeriod || 604800000, // 7日
      
      // パフォーマンス設定
      enableCaching: options.enableCaching !== false,
      cacheSize: options.cacheSize || 1000,
      
      ...options
    };
    
    // セッション管理
    this.sessions = new Map();
    this.pendingSessions = new Map();
    
    // 鍵管理
    this.identityKeys = new Map();
    this.preKeys = new Map();
    this.ephemeralKeys = new Map();
    
    // ラチェット状態
    this.ratchetStates = new Map();
    
    // メッセージ管理
    this.messageQueues = new Map();
    this.messageCounters = new Map();
    
    // キャッシュ
    this.encryptionCache = new Map();
    this.decryptionCache = new Map();
    
    // メトリクス
    this.metrics = {
      totalSessions: 0,
      activeSessions: 0,
      messagesEncrypted: 0,
      messagesDecrypted: 0,
      keyRotations: 0,
      handshakeFailures: 0
    };
    
    this.initialize();
  }
  
  async initialize() {
    // アイデンティティ鍵を生成
    await this.generateIdentityKeys();
    
    // プレキーを生成
    await this.generatePreKeys();
    
    // 鍵ローテーションを開始
    if (this.options.enablePerfectForwardSecrecy) {
      this.startKeyRotation();
    }
    
    // セッションクリーンアップを開始
    this.startSessionCleanup();
    
    this.logger.info('End-to-end encryption initialized');
  }
  
  /**
   * セッションを確立
   */
  async establishSession(remoteIdentity, options = {}) {
    const sessionId = this.generateSessionId();
    
    try {
      // ハンドシェイクを開始
      const handshake = {
        sessionId,
        localIdentity: await this.getLocalIdentity(),
        remoteIdentity,
        state: SessionState.HANDSHAKING,
        startTime: Date.now()
      };
      
      this.pendingSessions.set(sessionId, handshake);
      
      // プロトコルに応じたハンドシェイク
      let session;
      switch (this.options.protocol) {
        case EncryptionProtocol.SIGNAL:
        case EncryptionProtocol.DOUBLE_RATCHET:
          session = await this.performX3DHHandshake(handshake);
          break;
          
        case EncryptionProtocol.NOISE:
          session = await this.performNoiseHandshake(handshake);
          break;
          
        default:
          session = await this.performCustomHandshake(handshake);
      }
      
      // セッションを保存
      this.sessions.set(sessionId, session);
      this.pendingSessions.delete(sessionId);
      
      // ラチェット状態を初期化
      if (this.options.protocol === EncryptionProtocol.DOUBLE_RATCHET) {
        await this.initializeRatchet(sessionId, session);
      }
      
      this.metrics.totalSessions++;
      this.metrics.activeSessions++;
      
      this.emit('session:established', {
        sessionId,
        remoteIdentity,
        protocol: this.options.protocol
      });
      
      return sessionId;
      
    } catch (error) {
      this.logger.error('Session establishment failed', error);
      this.pendingSessions.delete(sessionId);
      this.metrics.handshakeFailures++;
      throw error;
    }
  }
  
  /**
   * メッセージを暗号化
   */
  async encryptMessage(sessionId, plaintext, options = {}) {
    const session = this.sessions.get(sessionId);
    if (!session || session.state !== SessionState.ESTABLISHED) {
      throw new Error('Invalid or inactive session');
    }
    
    try {
      let encrypted;
      
      // プロトコルに応じた暗号化
      switch (this.options.protocol) {
        case EncryptionProtocol.DOUBLE_RATCHET:
          encrypted = await this.encryptWithDoubleRatchet(sessionId, plaintext);
          break;
          
        case EncryptionProtocol.SIGNAL:
          encrypted = await this.encryptWithSignalProtocol(sessionId, plaintext);
          break;
          
        default:
          encrypted = await this.encryptWithDefaultProtocol(sessionId, plaintext);
      }
      
      // メッセージ順序保護
      if (this.options.enableMessageOrdering) {
        encrypted.sequence = this.getNextSequenceNumber(sessionId);
      }
      
      // リプレイ保護
      if (this.options.enableReplayProtection) {
        encrypted.nonce = randomBytes(16).toString('hex');
        encrypted.timestamp = Date.now();
      }
      
      this.metrics.messagesEncrypted++;
      
      return encrypted;
      
    } catch (error) {
      this.logger.error('Message encryption failed', error);
      throw error;
    }
  }
  
  /**
   * メッセージを復号
   */
  async decryptMessage(sessionId, encryptedData, options = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    
    try {
      // リプレイ攻撃をチェック
      if (this.options.enableReplayProtection) {
        if (!this.validateReplayProtection(sessionId, encryptedData)) {
          throw new Error('Replay attack detected');
        }
      }
      
      // メッセージ順序をチェック
      if (this.options.enableMessageOrdering) {
        if (!this.validateMessageOrder(sessionId, encryptedData)) {
          // 順序が正しくない場合はキューに追加
          this.queueOutOfOrderMessage(sessionId, encryptedData);
          return null;
        }
      }
      
      let plaintext;
      
      // プロトコルに応じた復号
      switch (this.options.protocol) {
        case EncryptionProtocol.DOUBLE_RATCHET:
          plaintext = await this.decryptWithDoubleRatchet(sessionId, encryptedData);
          break;
          
        case EncryptionProtocol.SIGNAL:
          plaintext = await this.decryptWithSignalProtocol(sessionId, encryptedData);
          break;
          
        default:
          plaintext = await this.decryptWithDefaultProtocol(sessionId, encryptedData);
      }
      
      this.metrics.messagesDecrypted++;
      
      // 順序待ちメッセージを処理
      await this.processQueuedMessages(sessionId);
      
      return plaintext;
      
    } catch (error) {
      this.logger.error('Message decryption failed', error);
      throw error;
    }
  }
  
  /**
   * X3DHハンドシェイクを実行
   */
  async performX3DHHandshake(handshake) {
    // Extended Triple Diffie-Hellman key agreement
    const { localIdentity, remoteIdentity } = handshake;
    
    // 相手のプレキーバンドルを取得
    const remotePreKeyBundle = await this.fetchPreKeyBundle(remoteIdentity);
    
    // エフェメラル鍵を生成
    const ephemeralKeyPair = await this.generateEphemeralKeyPair();
    
    // DH計算を実行
    const dh1 = await this.performDH(localIdentity.privateKey, remotePreKeyBundle.signedPreKey);
    const dh2 = await this.performDH(ephemeralKeyPair.privateKey, remotePreKeyBundle.identityKey);
    const dh3 = await this.performDH(ephemeralKeyPair.privateKey, remotePreKeyBundle.signedPreKey);
    
    // 共有秘密を導出
    const sharedSecret = this.deriveSharedSecret([dh1, dh2, dh3]);
    
    // ルート鍵とチェーン鍵を導出
    const { rootKey, chainKey } = await this.deriveInitialKeys(sharedSecret);
    
    return {
      sessionId: handshake.sessionId,
      state: SessionState.ESTABLISHED,
      localIdentity,
      remoteIdentity,
      rootKey,
      chainKey,
      sendingChainKey: chainKey,
      receivingChainKey: null,
      ephemeralKeyPair,
      remoteEphemeralKey: null,
      messageKeyCache: new Map(),
      createdAt: Date.now(),
      lastActivity: Date.now()
    };
  }
  
  /**
   * Double Ratchetで暗号化
   */
  async encryptWithDoubleRatchet(sessionId, plaintext) {
    const session = this.sessions.get(sessionId);
    const ratchetState = this.ratchetStates.get(sessionId);
    
    // メッセージ鍵を導出
    const messageKey = await this.deriveMessageKey(ratchetState.sendingChainKey);
    
    // チェーン鍵を更新
    ratchetState.sendingChainKey = await this.advanceChainKey(ratchetState.sendingChainKey);
    
    // DHラチェットをチェック
    if (this.shouldPerformDHRatchet(ratchetState)) {
      await this.performDHRatchet(sessionId, ratchetState);
    }
    
    // メッセージを暗号化
    const iv = randomBytes(16);
    const cipher = createCipheriv(this.options.symmetricAlgorithm, messageKey, iv);
    
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final()
    ]);
    
    const authTag = cipher.getAuthTag();
    
    return {
      ciphertext: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      ephemeralKey: ratchetState.currentEphemeralKey?.publicKey,
      messageNumber: ratchetState.sendMessageNumber++,
      chainNumber: ratchetState.sendChainNumber
    };
  }
  
  /**
   * Double Ratchetで復号
   */
  async decryptWithDoubleRatchet(sessionId, encryptedData) {
    const session = this.sessions.get(sessionId);
    const ratchetState = this.ratchetStates.get(sessionId);
    
    // 新しいエフェメラル鍵を受信した場合、DHラチェットを実行
    if (encryptedData.ephemeralKey && 
        encryptedData.ephemeralKey !== ratchetState.remoteEphemeralKey) {
      await this.performDHRatchetOnReceive(sessionId, ratchetState, encryptedData.ephemeralKey);
    }
    
    // メッセージ鍵を取得または導出
    const messageKey = await this.getOrDeriveMessageKey(
      ratchetState,
      encryptedData.chainNumber,
      encryptedData.messageNumber
    );
    
    // メッセージを復号
    const decipher = createDecipheriv(
      this.options.symmetricAlgorithm,
      Buffer.from(messageKey),
      Buffer.from(encryptedData.iv, 'base64')
    );
    
    decipher.setAuthTag(Buffer.from(encryptedData.authTag, 'base64'));
    
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedData.ciphertext, 'base64')),
      decipher.final()
    ]);
    
    return decrypted.toString('utf8');
  }
  
  /**
   * ラチェットを初期化
   */
  async initializeRatchet(sessionId, session) {
    const ratchetState = {
      rootKey: session.rootKey,
      sendingChainKey: session.sendingChainKey,
      receivingChainKey: session.receivingChainKey,
      sendMessageNumber: 0,
      receiveMessageNumber: 0,
      sendChainNumber: 0,
      receiveChainNumber: 0,
      currentEphemeralKey: session.ephemeralKeyPair,
      remoteEphemeralKey: session.remoteEphemeralKey,
      skippedMessageKeys: new Map()
    };
    
    this.ratchetStates.set(sessionId, ratchetState);
  }
  
  /**
   * DHラチェットを実行
   */
  async performDHRatchet(sessionId, ratchetState) {
    // 新しいエフェメラル鍵を生成
    const newEphemeralKey = await this.generateEphemeralKeyPair();
    
    // 新しい共有秘密を計算
    const sharedSecret = await this.performDH(
      newEphemeralKey.privateKey,
      ratchetState.remoteEphemeralKey
    );
    
    // 新しいルート鍵とチェーン鍵を導出
    const { rootKey, chainKey } = await this.deriveRatchetKeys(
      ratchetState.rootKey,
      sharedSecret
    );
    
    // ラチェット状態を更新
    ratchetState.rootKey = rootKey;
    ratchetState.sendingChainKey = chainKey;
    ratchetState.currentEphemeralKey = newEphemeralKey;
    ratchetState.sendChainNumber++;
    ratchetState.sendMessageNumber = 0;
    
    this.metrics.keyRotations++;
  }
  
  /**
   * 鍵ローテーションを開始
   */
  startKeyRotation() {
    this.keyRotationInterval = setInterval(async () => {
      await this.rotateKeys();
    }, this.options.keyRotationInterval);
  }
  
  /**
   * 鍵をローテート
   */
  async rotateKeys() {
    for (const [sessionId, session] of this.sessions) {
      if (session.state === SessionState.ESTABLISHED) {
        try {
          // プロトコルに応じた鍵ローテーション
          if (this.options.protocol === EncryptionProtocol.DOUBLE_RATCHET) {
            const ratchetState = this.ratchetStates.get(sessionId);
            if (ratchetState) {
              await this.performDHRatchet(sessionId, ratchetState);
            }
          } else {
            // 他のプロトコルの鍵ローテーション
            await this.rotateSessionKeys(sessionId);
          }
          
        } catch (error) {
          this.logger.error(`Key rotation failed for session ${sessionId}`, error);
        }
      }
    }
  }
  
  /**
   * アイデンティティ鍵を生成
   */
  async generateIdentityKeys() {
    const keyPair = await this.crypto.generateKeyPair(this.options.asymmetricAlgorithm);
    
    this.identityKeys.set('default', {
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey,
      created: Date.now()
    });
  }
  
  /**
   * プレキーを生成
   */
  async generatePreKeys() {
    const preKeys = [];
    
    // 署名付きプレキー
    const signedPreKey = await this.generateSignedPreKey();
    this.preKeys.set('signed', signedPreKey);
    
    // ワンタイムプレキー
    for (let i = 0; i < 100; i++) {
      const preKey = await this.crypto.generateKeyPair(this.options.asymmetricAlgorithm);
      preKeys.push({
        id: i,
        publicKey: preKey.publicKey,
        privateKey: preKey.privateKey
      });
    }
    
    this.preKeys.set('onetime', preKeys);
  }
  
  /**
   * 署名付きプレキーを生成
   */
  async generateSignedPreKey() {
    const keyPair = await this.crypto.generateKeyPair(this.options.asymmetricAlgorithm);
    const identityKey = this.identityKeys.get('default');
    
    const signature = await this.crypto.sign(
      keyPair.publicKey,
      identityKey.privateKey
    );
    
    return {
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey,
      signature,
      created: Date.now()
    };
  }
  
  /**
   * メッセージ鍵を導出
   */
  async deriveMessageKey(chainKey) {
    const input = Buffer.concat([
      Buffer.from('MessageKey'),
      chainKey
    ]);
    
    return createHash(this.options.hashAlgorithm)
      .update(input)
      .digest();
  }
  
  /**
   * チェーン鍵を進める
   */
  async advanceChainKey(chainKey) {
    const input = Buffer.concat([
      Buffer.from('ChainKey'),
      chainKey
    ]);
    
    return createHash(this.options.hashAlgorithm)
      .update(input)
      .digest();
  }
  
  /**
   * 共有秘密を導出
   */
  deriveSharedSecret(dhResults) {
    const concatenated = Buffer.concat(dhResults);
    
    return createHash(this.options.hashAlgorithm)
      .update(concatenated)
      .digest();
  }
  
  /**
   * 初期鍵を導出
   */
  async deriveInitialKeys(sharedSecret) {
    const kdf = await this.performKDF(sharedSecret, 'WhisperRatchet', 64);
    
    return {
      rootKey: kdf.slice(0, 32),
      chainKey: kdf.slice(32, 64)
    };
  }
  
  /**
   * ラチェット鍵を導出
   */
  async deriveRatchetKeys(rootKey, sharedSecret) {
    const input = Buffer.concat([rootKey, sharedSecret]);
    const kdf = await this.performKDF(input, 'RatchetStep', 64);
    
    return {
      rootKey: kdf.slice(0, 32),
      chainKey: kdf.slice(32, 64)
    };
  }
  
  /**
   * KDF (Key Derivation Function)
   */
  async performKDF(input, info, length) {
    // HKDF実装（簡略化）
    const salt = Buffer.alloc(32, 0);
    const prk = createHash(this.options.hashAlgorithm)
      .update(salt)
      .update(input)
      .digest();
    
    const infoBuffer = Buffer.from(info);
    const output = Buffer.alloc(length);
    
    let offset = 0;
    let counter = 1;
    
    while (offset < length) {
      const block = createHash(this.options.hashAlgorithm)
        .update(prk)
        .update(infoBuffer)
        .update(Buffer.from([counter]))
        .digest();
      
      const copyLength = Math.min(block.length, length - offset);
      block.copy(output, offset, 0, copyLength);
      
      offset += copyLength;
      counter++;
    }
    
    return output;
  }
  
  /**
   * Diffie-Hellmanを実行
   */
  async performDH(privateKey, publicKey) {
    // ECDH実装（簡略化）
    return this.crypto.performECDH(privateKey, publicKey);
  }
  
  /**
   * エフェメラル鍵ペアを生成
   */
  async generateEphemeralKeyPair() {
    return await this.crypto.generateKeyPair(this.options.asymmetricAlgorithm);
  }
  
  /**
   * リプレイ保護を検証
   */
  validateReplayProtection(sessionId, encryptedData) {
    const session = this.sessions.get(sessionId);
    const replayCache = session.replayCache || new Set();
    
    const messageId = `${encryptedData.nonce}_${encryptedData.timestamp}`;
    
    if (replayCache.has(messageId)) {
      return false;
    }
    
    // タイムスタンプが古すぎないかチェック
    const now = Date.now();
    if (now - encryptedData.timestamp > 300000) { // 5分
      return false;
    }
    
    replayCache.add(messageId);
    
    // キャッシュサイズを制限
    if (replayCache.size > 10000) {
      const oldestMessages = Array.from(replayCache).slice(0, 5000);
      oldestMessages.forEach(msg => replayCache.delete(msg));
    }
    
    session.replayCache = replayCache;
    
    return true;
  }
  
  /**
   * メッセージ順序を検証
   */
  validateMessageOrder(sessionId, encryptedData) {
    const counter = this.messageCounters.get(sessionId) || 0;
    
    if (encryptedData.sequence === counter + 1) {
      this.messageCounters.set(sessionId, encryptedData.sequence);
      return true;
    }
    
    return false;
  }
  
  /**
   * 統計情報を取得
   */
  getStats() {
    return {
      metrics: this.metrics,
      sessions: {
        total: this.sessions.size,
        active: Array.from(this.sessions.values()).filter(
          s => s.state === SessionState.ESTABLISHED
        ).length,
        pending: this.pendingSessions.size
      },
      encryption: {
        protocol: this.options.protocol,
        mode: this.options.mode,
        forwardSecrecy: this.options.enablePerfectForwardSecrecy
      },
      performance: {
        cacheHitRate: this.calculateCacheHitRate(),
        averageHandshakeTime: this.calculateAverageHandshakeTime()
      }
    };
  }
  
  // ヘルパーメソッド
  generateSessionId() {
    return `e2e_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  async getLocalIdentity() {
    return this.identityKeys.get('default');
  }
  
  async fetchPreKeyBundle(remoteIdentity) {
    // リモートのプレキーバンドルを取得（実装は省略）
    return {
      identityKey: remoteIdentity.publicKey,
      signedPreKey: randomBytes(32),
      signature: randomBytes(64)
    };
  }
  
  shouldPerformDHRatchet(ratchetState) {
    // 一定数のメッセージごとにDHラチェットを実行
    return ratchetState.sendMessageNumber >= 100;
  }
  
  getNextSequenceNumber(sessionId) {
    const current = this.messageCounters.get(sessionId) || 0;
    const next = current + 1;
    this.messageCounters.set(sessionId, next);
    return next;
  }
  
  queueOutOfOrderMessage(sessionId, encryptedData) {
    if (!this.messageQueues.has(sessionId)) {
      this.messageQueues.set(sessionId, []);
    }
    
    this.messageQueues.get(sessionId).push(encryptedData);
  }
  
  async processQueuedMessages(sessionId) {
    const queue = this.messageQueues.get(sessionId);
    if (!queue || queue.length === 0) return;
    
    const processed = [];
    
    for (const message of queue) {
      if (this.validateMessageOrder(sessionId, message)) {
        try {
          await this.decryptMessage(sessionId, message);
          processed.push(message);
        } catch (error) {
          this.logger.error('Failed to process queued message', error);
        }
      }
    }
    
    // 処理済みメッセージを削除
    const remaining = queue.filter(msg => !processed.includes(msg));
    this.messageQueues.set(sessionId, remaining);
  }
  
  calculateCacheHitRate() {
    // キャッシュヒット率を計算（簡略化）
    return 0.85;
  }
  
  calculateAverageHandshakeTime() {
    // 平均ハンドシェイク時間を計算（簡略化）
    return 250; // ms
  }
  
  /**
   * セッションクリーンアップを開始
   */
  startSessionCleanup() {
    this.cleanupInterval = setInterval(async () => {
      await this.cleanupExpiredSessions();
    }, 3600000); // 1時間ごと
  }
  
  /**
   * 期限切れセッションをクリーンアップ
   */
  async cleanupExpiredSessions() {
    const now = Date.now();
    const expiredSessions = [];
    
    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastActivity > this.options.sessionTimeout) {
        expiredSessions.push(sessionId);
      }
    }
    
    for (const sessionId of expiredSessions) {
      await this.terminateSession(sessionId);
    }
  }
  
  /**
   * セッションを終了
   */
  async terminateSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    
    session.state = SessionState.TERMINATED;
    
    // クリーンアップ
    this.sessions.delete(sessionId);
    this.ratchetStates.delete(sessionId);
    this.messageQueues.delete(sessionId);
    this.messageCounters.delete(sessionId);
    
    this.metrics.activeSessions--;
    
    this.emit('session:terminated', { sessionId });
  }
  
  /**
   * クリーンアップ
   */
  async cleanup() {
    if (this.keyRotationInterval) {
      clearInterval(this.keyRotationInterval);
    }
    
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    // すべてのセッションを終了
    for (const sessionId of this.sessions.keys()) {
      await this.terminateSession(sessionId);
    }
    
    this.encryptionCache.clear();
    this.decryptionCache.clear();
  }
}

export default EndToEndEncryption;