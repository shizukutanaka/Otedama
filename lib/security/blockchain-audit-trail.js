/**
 * Blockchain-Based Audit Trail System
 * ブロックチェーンベースの監査証跡システム
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';
import { getCryptoUtils } from '../crypto/crypto-utils.js';
import { createHash, randomBytes } from 'crypto';

const logger = getLogger('BlockchainAuditTrail');

// 監査イベントタイプ
export const AuditEventType = {
  // アクセス関連
  ACCESS_GRANTED: 'access_granted',
  ACCESS_DENIED: 'access_denied',
  LOGIN_ATTEMPT: 'login_attempt',
  LOGOUT: 'logout',
  
  // データ操作
  DATA_CREATE: 'data_create',
  DATA_READ: 'data_read',
  DATA_UPDATE: 'data_update',
  DATA_DELETE: 'data_delete',
  
  // システム操作
  CONFIG_CHANGE: 'config_change',
  PERMISSION_CHANGE: 'permission_change',
  SYSTEM_START: 'system_start',
  SYSTEM_STOP: 'system_stop',
  
  // セキュリティイベント
  SECURITY_ALERT: 'security_alert',
  THREAT_DETECTED: 'threat_detected',
  ANOMALY_DETECTED: 'anomaly_detected',
  INCIDENT_RESPONSE: 'incident_response',
  
  // トランザクション
  TRANSACTION_INITIATED: 'transaction_initiated',
  TRANSACTION_COMPLETED: 'transaction_completed',
  TRANSACTION_FAILED: 'transaction_failed',
  
  // コンプライアンス
  COMPLIANCE_CHECK: 'compliance_check',
  POLICY_VIOLATION: 'policy_violation',
  AUDIT_PERFORMED: 'audit_performed'
};

// ブロックステータス
export const BlockStatus = {
  PENDING: 'pending',
  VALIDATED: 'validated',
  CONFIRMED: 'confirmed',
  FINALIZED: 'finalized'
};

export class BlockchainAuditTrail extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = logger;
    this.crypto = getCryptoUtils();
    
    this.options = {
      // ブロックチェーン設定
      blockSize: options.blockSize || 100,              // トランザクション/ブロック
      blockTime: options.blockTime || 60000,            // 1分
      confirmationsRequired: options.confirmationsRequired || 3,
      
      // 暗号化設定
      enableEncryption: options.enableEncryption !== false,
      hashAlgorithm: options.hashAlgorithm || 'sha3-256',
      
      // 分散設定
      enableDistribution: options.enableDistribution !== false,
      replicationFactor: options.replicationFactor || 3,
      
      // 保存設定
      retentionPeriod: options.retentionPeriod || 7 * 365 * 24 * 60 * 60 * 1000, // 7年
      archiveOldBlocks: options.archiveOldBlocks !== false,
      
      // パフォーマンス設定
      enableIndexing: options.enableIndexing !== false,
      cacheSize: options.cacheSize || 1000,
      
      // 検証設定
      enableRealTimeValidation: options.enableRealTimeValidation !== false,
      validationThreshold: options.validationThreshold || 0.51, // 51%
      
      ...options
    };
    
    // ブロックチェーン
    this.blockchain = [];
    this.pendingTransactions = [];
    this.currentBlock = null;
    
    // インデックス
    this.blockIndex = new Map();
    this.transactionIndex = new Map();
    this.eventTypeIndex = new Map();
    this.userIndex = new Map();
    
    // 検証ノード
    this.validators = new Map();
    this.validationQueue = [];
    
    // メトリクス
    this.metrics = {
      totalBlocks: 0,
      totalTransactions: 0,
      pendingTransactions: 0,
      validatedBlocks: 0,
      rejectedTransactions: 0,
      averageBlockTime: 0
    };
    
    this.initialize();
  }
  
  async initialize() {
    // ジェネシスブロックを作成
    await this.createGenesisBlock();
    
    // ブロック生成を開始
    this.startBlockGeneration();
    
    // 検証プロセスを開始
    if (this.options.enableRealTimeValidation) {
      this.startValidation();
    }
    
    this.logger.info('Blockchain audit trail initialized');
  }
  
  /**
   * 監査イベントを記録
   */
  async recordAuditEvent(event) {
    const transaction = {
      id: this.generateTransactionId(),
      timestamp: Date.now(),
      type: event.type || AuditEventType.ACCESS_GRANTED,
      
      // イベント詳細
      details: {
        userId: event.userId,
        resource: event.resource,
        action: event.action,
        result: event.result,
        metadata: event.metadata || {}
      },
      
      // コンテキスト情報
      context: {
        ip: event.ip,
        userAgent: event.userAgent,
        sessionId: event.sessionId,
        location: event.location
      },
      
      // 暗号化署名
      signature: null,
      hash: null
    };
    
    try {
      // トランザクションに署名
      transaction.signature = await this.signTransaction(transaction);
      
      // トランザクションハッシュを計算
      transaction.hash = this.calculateTransactionHash(transaction);
      
      // 暗号化（必要な場合）
      if (this.options.enableEncryption && event.sensitive) {
        transaction.details = await this.encryptSensitiveData(transaction.details);
      }
      
      // ペンディングトランザクションに追加
      this.pendingTransactions.push(transaction);
      this.metrics.pendingTransactions++;
      
      // インデックスを更新
      this.updateIndices(transaction);
      
      // リアルタイム検証
      if (this.options.enableRealTimeValidation) {
        this.validationQueue.push(transaction);
      }
      
      this.emit('audit:recorded', transaction);
      
      return {
        transactionId: transaction.id,
        hash: transaction.hash,
        status: 'pending'
      };
      
    } catch (error) {
      this.logger.error('Failed to record audit event', error);
      this.metrics.rejectedTransactions++;
      throw error;
    }
  }
  
  /**
   * ジェネシスブロックを作成
   */
  async createGenesisBlock() {
    const genesisBlock = {
      index: 0,
      timestamp: Date.now(),
      transactions: [{
        id: 'genesis',
        type: 'GENESIS_BLOCK',
        details: {
          message: 'Blockchain Audit Trail Genesis Block',
          version: '1.0',
          created: new Date().toISOString()
        }
      }],
      previousHash: '0',
      hash: null,
      nonce: 0,
      status: BlockStatus.FINALIZED
    };
    
    genesisBlock.hash = this.calculateBlockHash(genesisBlock);
    
    this.blockchain.push(genesisBlock);
    this.blockIndex.set(genesisBlock.hash, genesisBlock);
    
    this.logger.info('Genesis block created', {
      hash: genesisBlock.hash
    });
  }
  
  /**
   * ブロック生成を開始
   */
  startBlockGeneration() {
    this.blockGenerationInterval = setInterval(async () => {
      if (this.pendingTransactions.length >= this.options.blockSize) {
        await this.generateBlock();
      }
    }, this.options.blockTime);
    
    // タイムアウトでもブロックを生成
    this.blockTimeoutInterval = setInterval(async () => {
      if (this.pendingTransactions.length > 0) {
        await this.generateBlock();
      }
    }, this.options.blockTime * 2);
  }
  
  /**
   * ブロックを生成
   */
  async generateBlock() {
    if (this.pendingTransactions.length === 0) {
      return;
    }
    
    const startTime = Date.now();
    
    try {
      // トランザクションを取得
      const transactions = this.pendingTransactions.splice(
        0,
        Math.min(this.options.blockSize, this.pendingTransactions.length)
      );
      
      // 新しいブロックを作成
      const block = {
        index: this.blockchain.length,
        timestamp: Date.now(),
        transactions,
        previousHash: this.getLatestBlock().hash,
        hash: null,
        nonce: 0,
        merkleRoot: null,
        status: BlockStatus.PENDING,
        validations: []
      };
      
      // マークルルートを計算
      block.merkleRoot = this.calculateMerkleRoot(transactions);
      
      // ブロックハッシュを計算（簡易版）
      block.hash = this.calculateBlockHash(block);
      
      // ブロックチェーンに追加
      this.blockchain.push(block);
      this.blockIndex.set(block.hash, block);
      
      // メトリクスを更新
      this.metrics.totalBlocks++;
      this.metrics.totalTransactions += transactions.length;
      this.metrics.pendingTransactions = this.pendingTransactions.length;
      
      const blockTime = Date.now() - startTime;
      this.updateAverageBlockTime(blockTime);
      
      // 検証を開始
      if (this.options.enableDistribution) {
        await this.distributeBlockForValidation(block);
      } else {
        block.status = BlockStatus.VALIDATED;
      }
      
      this.emit('block:generated', {
        blockNumber: block.index,
        hash: block.hash,
        transactionCount: transactions.length,
        blockTime
      });
      
      // 古いブロックをアーカイブ
      await this.archiveOldBlocks();
      
    } catch (error) {
      this.logger.error('Block generation failed', error);
      
      // 失敗したトランザクションを戻す
      this.pendingTransactions.unshift(...transactions);
    }
  }
  
  /**
   * 監査証跡を検索
   */
  async searchAuditTrail(criteria) {
    const results = [];
    
    try {
      // インデックスを使用した高速検索
      if (criteria.userId && this.userIndex.has(criteria.userId)) {
        const userTransactions = this.userIndex.get(criteria.userId);
        results.push(...this.filterTransactions(userTransactions, criteria));
        
      } else if (criteria.eventType && this.eventTypeIndex.has(criteria.eventType)) {
        const typeTransactions = this.eventTypeIndex.get(criteria.eventType);
        results.push(...this.filterTransactions(typeTransactions, criteria));
        
      } else {
        // フルスキャン
        for (const block of this.blockchain) {
          if (block.status !== BlockStatus.FINALIZED) continue;
          
          for (const transaction of block.transactions) {
            if (this.matchesCriteria(transaction, criteria)) {
              results.push({
                ...transaction,
                blockNumber: block.index,
                blockHash: block.hash,
                blockTimestamp: block.timestamp
              });
            }
          }
        }
      }
      
      // ソートと制限
      results.sort((a, b) => b.timestamp - a.timestamp);
      
      if (criteria.limit) {
        return results.slice(0, criteria.limit);
      }
      
      return results;
      
    } catch (error) {
      this.logger.error('Audit trail search failed', error);
      throw error;
    }
  }
  
  /**
   * 監査証跡を検証
   */
  async verifyAuditTrail(startBlock = 0, endBlock = null) {
    const end = endBlock || this.blockchain.length - 1;
    const verificationResults = {
      valid: true,
      errors: [],
      blocksVerified: 0,
      transactionsVerified: 0
    };
    
    try {
      for (let i = startBlock; i <= end; i++) {
        const block = this.blockchain[i];
        
        // ブロックハッシュを検証
        const calculatedHash = this.calculateBlockHash(block);
        if (block.hash !== calculatedHash) {
          verificationResults.valid = false;
          verificationResults.errors.push({
            type: 'invalid_block_hash',
            blockIndex: i,
            expected: calculatedHash,
            actual: block.hash
          });
        }
        
        // 前のブロックとのリンクを検証
        if (i > 0) {
          const previousBlock = this.blockchain[i - 1];
          if (block.previousHash !== previousBlock.hash) {
            verificationResults.valid = false;
            verificationResults.errors.push({
              type: 'broken_chain',
              blockIndex: i,
              expected: previousBlock.hash,
              actual: block.previousHash
            });
          }
        }
        
        // マークルルートを検証
        const calculatedMerkleRoot = this.calculateMerkleRoot(block.transactions);
        if (block.merkleRoot !== calculatedMerkleRoot) {
          verificationResults.valid = false;
          verificationResults.errors.push({
            type: 'invalid_merkle_root',
            blockIndex: i
          });
        }
        
        // トランザクションを検証
        for (const transaction of block.transactions) {
          const isValid = await this.verifyTransaction(transaction);
          if (!isValid) {
            verificationResults.valid = false;
            verificationResults.errors.push({
              type: 'invalid_transaction',
              blockIndex: i,
              transactionId: transaction.id
            });
          }
          verificationResults.transactionsVerified++;
        }
        
        verificationResults.blocksVerified++;
      }
      
      return verificationResults;
      
    } catch (error) {
      this.logger.error('Audit trail verification failed', error);
      throw error;
    }
  }
  
  /**
   * 監査レポートを生成
   */
  async generateAuditReport(criteria) {
    const report = {
      generatedAt: Date.now(),
      criteria,
      summary: {
        totalEvents: 0,
        eventsByType: {},
        eventsByUser: {},
        timeRange: {
          start: null,
          end: null
        }
      },
      details: [],
      compliance: {
        violations: [],
        checks: []
      }
    };
    
    try {
      // 監査証跡を検索
      const auditTrails = await this.searchAuditTrail(criteria);
      
      // サマリーを作成
      for (const trail of auditTrails) {
        report.summary.totalEvents++;
        
        // イベントタイプ別
        report.summary.eventsByType[trail.type] = 
          (report.summary.eventsByType[trail.type] || 0) + 1;
        
        // ユーザー別
        if (trail.details.userId) {
          report.summary.eventsByUser[trail.details.userId] = 
            (report.summary.eventsByUser[trail.details.userId] || 0) + 1;
        }
        
        // 時間範囲
        if (!report.summary.timeRange.start || trail.timestamp < report.summary.timeRange.start) {
          report.summary.timeRange.start = trail.timestamp;
        }
        if (!report.summary.timeRange.end || trail.timestamp > report.summary.timeRange.end) {
          report.summary.timeRange.end = trail.timestamp;
        }
      }
      
      // 詳細を追加
      report.details = auditTrails.slice(0, 1000); // 最大1000件
      
      // コンプライアンスチェック
      const complianceResults = await this.performComplianceChecks(auditTrails);
      report.compliance = complianceResults;
      
      // 整合性検証
      const integrity = await this.verifyAuditTrail();
      report.integrity = {
        valid: integrity.valid,
        blocksVerified: integrity.blocksVerified,
        errors: integrity.errors.length
      };
      
      return report;
      
    } catch (error) {
      this.logger.error('Audit report generation failed', error);
      throw error;
    }
  }
  
  /**
   * コンプライアンスチェックを実行
   */
  async performComplianceChecks(auditTrails) {
    const results = {
      violations: [],
      checks: [],
      compliant: true
    };
    
    // アクセス制御チェック
    const accessViolations = this.checkAccessControlCompliance(auditTrails);
    if (accessViolations.length > 0) {
      results.violations.push(...accessViolations);
      results.compliant = false;
    }
    results.checks.push({
      type: 'access_control',
      passed: accessViolations.length === 0
    });
    
    // データ保護チェック
    const dataProtectionViolations = this.checkDataProtectionCompliance(auditTrails);
    if (dataProtectionViolations.length > 0) {
      results.violations.push(...dataProtectionViolations);
      results.compliant = false;
    }
    results.checks.push({
      type: 'data_protection',
      passed: dataProtectionViolations.length === 0
    });
    
    // 監査ログ完全性チェック
    const integrityCheck = await this.checkAuditLogIntegrity();
    results.checks.push({
      type: 'audit_integrity',
      passed: integrityCheck.valid
    });
    
    return results;
  }
  
  /**
   * トランザクションに署名
   */
  async signTransaction(transaction) {
    const data = JSON.stringify({
      id: transaction.id,
      timestamp: transaction.timestamp,
      type: transaction.type,
      details: transaction.details
    });
    
    return this.crypto.sign(data);
  }
  
  /**
   * トランザクションを検証
   */
  async verifyTransaction(transaction) {
    try {
      // 署名を検証
      const data = JSON.stringify({
        id: transaction.id,
        timestamp: transaction.timestamp,
        type: transaction.type,
        details: transaction.details
      });
      
      const signatureValid = await this.crypto.verify(data, transaction.signature);
      
      // ハッシュを検証
      const calculatedHash = this.calculateTransactionHash(transaction);
      const hashValid = transaction.hash === calculatedHash;
      
      return signatureValid && hashValid;
      
    } catch (error) {
      this.logger.error('Transaction verification failed', error);
      return false;
    }
  }
  
  /**
   * マークルルートを計算
   */
  calculateMerkleRoot(transactions) {
    if (transactions.length === 0) return null;
    
    let hashes = transactions.map(tx => tx.hash);
    
    while (hashes.length > 1) {
      const newHashes = [];
      
      for (let i = 0; i < hashes.length; i += 2) {
        const left = hashes[i];
        const right = hashes[i + 1] || left;
        
        const combined = createHash(this.options.hashAlgorithm)
          .update(left + right)
          .digest('hex');
        
        newHashes.push(combined);
      }
      
      hashes = newHashes;
    }
    
    return hashes[0];
  }
  
  /**
   * ブロックハッシュを計算
   */
  calculateBlockHash(block) {
    const data = JSON.stringify({
      index: block.index,
      timestamp: block.timestamp,
      transactions: block.transactions.map(tx => tx.hash),
      previousHash: block.previousHash,
      merkleRoot: block.merkleRoot,
      nonce: block.nonce
    });
    
    return createHash(this.options.hashAlgorithm)
      .update(data)
      .digest('hex');
  }
  
  /**
   * トランザクションハッシュを計算
   */
  calculateTransactionHash(transaction) {
    const data = JSON.stringify({
      id: transaction.id,
      timestamp: transaction.timestamp,
      type: transaction.type,
      details: transaction.details,
      context: transaction.context
    });
    
    return createHash(this.options.hashAlgorithm)
      .update(data)
      .digest('hex');
  }
  
  /**
   * インデックスを更新
   */
  updateIndices(transaction) {
    // トランザクションインデックス
    this.transactionIndex.set(transaction.id, transaction);
    
    // イベントタイプインデックス
    if (!this.eventTypeIndex.has(transaction.type)) {
      this.eventTypeIndex.set(transaction.type, []);
    }
    this.eventTypeIndex.get(transaction.type).push(transaction);
    
    // ユーザーインデックス
    if (transaction.details.userId) {
      if (!this.userIndex.has(transaction.details.userId)) {
        this.userIndex.set(transaction.details.userId, []);
      }
      this.userIndex.get(transaction.details.userId).push(transaction);
    }
  }
  
  /**
   * 最新のブロックを取得
   */
  getLatestBlock() {
    return this.blockchain[this.blockchain.length - 1];
  }
  
  /**
   * 古いブロックをアーカイブ
   */
  async archiveOldBlocks() {
    if (!this.options.archiveOldBlocks) return;
    
    const cutoffTime = Date.now() - this.options.retentionPeriod;
    const blocksToArchive = [];
    
    for (const block of this.blockchain) {
      if (block.timestamp < cutoffTime && block.status === BlockStatus.FINALIZED) {
        blocksToArchive.push(block);
      }
    }
    
    if (blocksToArchive.length > 0) {
      // アーカイブ処理（実装は省略）
      this.logger.info(`Archiving ${blocksToArchive.length} old blocks`);
    }
  }
  
  /**
   * 統計情報を取得
   */
  getStats() {
    return {
      blockchain: {
        totalBlocks: this.blockchain.length,
        latestBlock: this.getLatestBlock().index,
        pendingTransactions: this.pendingTransactions.length
      },
      metrics: this.metrics,
      indices: {
        transactions: this.transactionIndex.size,
        eventTypes: this.eventTypeIndex.size,
        users: this.userIndex.size
      },
      performance: {
        averageBlockTime: this.metrics.averageBlockTime
      }
    };
  }
  
  // ヘルパーメソッド
  generateTransactionId() {
    return `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  updateAverageBlockTime(blockTime) {
    const alpha = 0.1; // 指数移動平均の平滑化係数
    this.metrics.averageBlockTime = 
      alpha * blockTime + (1 - alpha) * this.metrics.averageBlockTime;
  }
  
  matchesCriteria(transaction, criteria) {
    if (criteria.userId && transaction.details.userId !== criteria.userId) {
      return false;
    }
    
    if (criteria.eventType && transaction.type !== criteria.eventType) {
      return false;
    }
    
    if (criteria.startTime && transaction.timestamp < criteria.startTime) {
      return false;
    }
    
    if (criteria.endTime && transaction.timestamp > criteria.endTime) {
      return false;
    }
    
    if (criteria.resource && transaction.details.resource !== criteria.resource) {
      return false;
    }
    
    return true;
  }
  
  filterTransactions(transactions, criteria) {
    return transactions.filter(tx => this.matchesCriteria(tx, criteria));
  }
  
  checkAccessControlCompliance(auditTrails) {
    const violations = [];
    
    // 不正アクセスの検出
    const deniedAccesses = auditTrails.filter(
      trail => trail.type === AuditEventType.ACCESS_DENIED
    );
    
    // 短時間での複数回の失敗
    const failuresByUser = {};
    for (const trail of deniedAccesses) {
      const userId = trail.details.userId;
      if (!failuresByUser[userId]) {
        failuresByUser[userId] = [];
      }
      failuresByUser[userId].push(trail);
    }
    
    for (const [userId, failures] of Object.entries(failuresByUser)) {
      if (failures.length > 5) {
        violations.push({
          type: 'excessive_access_failures',
          userId,
          count: failures.length,
          timeRange: {
            start: failures[0].timestamp,
            end: failures[failures.length - 1].timestamp
          }
        });
      }
    }
    
    return violations;
  }
  
  checkDataProtectionCompliance(auditTrails) {
    const violations = [];
    
    // 機密データへのアクセス
    const sensitiveAccess = auditTrails.filter(
      trail => trail.details.metadata?.sensitive === true
    );
    
    // 暗号化されていないアクセス
    for (const trail of sensitiveAccess) {
      if (!trail.details.metadata?.encrypted) {
        violations.push({
          type: 'unencrypted_sensitive_access',
          transactionId: trail.id,
          resource: trail.details.resource
        });
      }
    }
    
    return violations;
  }
  
  async checkAuditLogIntegrity() {
    const sampleSize = Math.min(100, this.blockchain.length);
    const startBlock = Math.max(0, this.blockchain.length - sampleSize);
    
    return await this.verifyAuditTrail(startBlock);
  }
  
  /**
   * クリーンアップ
   */
  async cleanup() {
    if (this.blockGenerationInterval) {
      clearInterval(this.blockGenerationInterval);
    }
    
    if (this.blockTimeoutInterval) {
      clearInterval(this.blockTimeoutInterval);
    }
    
    if (this.validationInterval) {
      clearInterval(this.validationInterval);
    }
  }
}

export default BlockchainAuditTrail;