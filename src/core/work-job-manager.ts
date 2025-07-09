/**
 * ワークジョブマネージャー実装
 * 効率的なジョブキューとタスク分配システム
 * 
 * 設計思想：
 * - Carmack: 低レイテンシで効率的なジョブ分配
 * - Martin: ジョブとワーカーの明確な分離
 * - Pike: シンプルで理解しやすいキューイング
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';

// === 型定義 ===
export interface WorkJob {
  id: string;
  height: number;
  prevHash: string;
  coinbase1: string;
  coinbase2: string;
  merkleBranch: string[];
  version: string;
  nbits: string;
  ntime: string;
  cleanJobs: boolean;
  extraNonce1Size: number;
  extraNonce2Size: number;
  createdAt: number;
  expiresAt: number;
  difficulty?: number;
  targetPool?: Buffer;
}

export interface WorkTemplate {
  height: number;
  previousBlockHash: string;
  transactions: string[];
  coinbaseValue: number;
  bits: string;
  curtime: number;
  mintime?: number;
  mutable?: string[];
  noncerange?: string;
  sigoplimit?: number;
  sizelimit?: number;
  weightlimit?: number;
}

export interface MinerJob {
  minerId: string;
  jobId: string;
  extraNonce1: string;
  difficulty: number;
  assignedAt: number;
  submittedAt?: number;
  shares: number;
  validShares: number;
}

export interface JobStats {
  totalJobs: number;
  activeJobs: number;
  expiredJobs: number;
  totalShares: number;
  validShares: number;
  jobsPerMinute: number;
  avgJobLifetime: number;
}

export interface JobManagerConfig {
  jobTimeout: number;           // ジョブのタイムアウト（秒）
  maxActiveJobs: number;        // 最大アクティブジョブ数
  cleanJobsInterval: number;    // クリーンジョブの間隔（秒）
  extraNonce1Size: number;      // ExtraNonce1のサイズ
  extraNonce2Size: number;      // ExtraNonce2のサイズ
  coinbaseSignature: string;    // コインベース署名
  poolAddress: string;          // プールアドレス
}

// === ジョブキュー ===
export class JobQueue {
  private jobs: Map<string, WorkJob> = new Map();
  private jobOrder: string[] = [];
  private maxSize: number;
  
  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
  }
  
  add(job: WorkJob): void {
    // 既存のジョブを削除
    if (this.jobs.has(job.id)) {
      this.remove(job.id);
    }
    
    // サイズ制限チェック
    if (this.jobOrder.length >= this.maxSize) {
      const oldestId = this.jobOrder.shift();
      if (oldestId) {
        this.jobs.delete(oldestId);
      }
    }
    
    // ジョブを追加
    this.jobs.set(job.id, job);
    this.jobOrder.push(job.id);
  }
  
  get(jobId: string): WorkJob | undefined {
    return this.jobs.get(jobId);
  }
  
  remove(jobId: string): boolean {
    if (this.jobs.delete(jobId)) {
      const index = this.jobOrder.indexOf(jobId);
      if (index > -1) {
        this.jobOrder.splice(index, 1);
      }
      return true;
    }
    return false;
  }
  
  getLatest(): WorkJob | undefined {
    if (this.jobOrder.length === 0) return undefined;
    const latestId = this.jobOrder[this.jobOrder.length - 1];
    return this.jobs.get(latestId);
  }
  
  getActive(): WorkJob[] {
    const now = Date.now();
    return Array.from(this.jobs.values())
      .filter(job => job.expiresAt > now);
  }
  
  cleanup(): number {
    const now = Date.now();
    let removed = 0;
    
    for (const [jobId, job] of this.jobs) {
      if (job.expiresAt <= now) {
        this.remove(jobId);
        removed++;
      }
    }
    
    return removed;
  }
  
  clear(): void {
    this.jobs.clear();
    this.jobOrder = [];
  }
  
  size(): number {
    return this.jobs.size;
  }
}

// === ExtraNonceカウンター ===
export class ExtraNonceCounter {
  private counter: number = 0;
  private size: number;
  private maxValue: number;
  
  constructor(size: number) {
    this.size = size;
    this.maxValue = Math.pow(256, size) - 1;
  }
  
  next(): string {
    this.counter++;
    if (this.counter > this.maxValue) {
      this.counter = 0;
    }
    
    return this.counter.toString(16).padStart(this.size * 2, '0');
  }
  
  reset(): void {
    this.counter = 0;
  }
}

// === マークルツリー計算 ===
export class MerkleTree {
  static calculateMerkleRoot(transactions: string[]): string {
    if (transactions.length === 0) {
      return '0'.repeat(64);
    }
    
    // トランザクションハッシュをBufferに変換
    let hashes = transactions.map(tx => Buffer.from(tx, 'hex'));
    
    // マークルツリーを構築
    while (hashes.length > 1) {
      const newHashes: Buffer[] = [];
      
      for (let i = 0; i < hashes.length; i += 2) {
        const left = hashes[i];
        const right = hashes[i + 1] || left; // 奇数の場合は最後を複製
        
        const combined = Buffer.concat([left, right]);
        const hash = this.doubleHash(combined);
        newHashes.push(hash);
      }
      
      hashes = newHashes;
    }
    
    return hashes[0].toString('hex');
  }
  
  static calculateMerkleBranch(transactions: string[], index: number): string[] {
    const branch: string[] = [];
    let hashes = transactions.map(tx => Buffer.from(tx, 'hex'));
    let currentIndex = index;
    
    while (hashes.length > 1) {
      const newHashes: Buffer[] = [];
      
      for (let i = 0; i < hashes.length; i += 2) {
        const left = hashes[i];
        const right = hashes[i + 1] || left;
        
        // ブランチに追加
        if (i === currentIndex || i === currentIndex - 1) {
          const branchHash = (currentIndex % 2 === 0) ? right : left;
          branch.push(branchHash.toString('hex'));
        }
        
        const combined = Buffer.concat([left, right]);
        const hash = this.doubleHash(combined);
        newHashes.push(hash);
      }
      
      hashes = newHashes;
      currentIndex = Math.floor(currentIndex / 2);
    }
    
    return branch;
  }
  
  private static doubleHash(data: Buffer): Buffer {
    const hash1 = createHash('sha256').update(data).digest();
    return createHash('sha256').update(hash1).digest();
  }
}

// === ワークジョブマネージャー ===
export class WorkJobManager extends EventEmitter {
  private config: JobManagerConfig;
  private jobQueue: JobQueue;
  private minerJobs: Map<string, MinerJob> = new Map();
  private extraNonceCounter: ExtraNonceCounter;
  private currentTemplate?: WorkTemplate;
  private stats: JobStats = {
    totalJobs: 0,
    activeJobs: 0,
    expiredJobs: 0,
    totalShares: 0,
    validShares: 0,
    jobsPerMinute: 0,
    avgJobLifetime: 0
  };
  private cleanupTimer?: NodeJS.Timeout;
  private statsTimer?: NodeJS.Timeout;
  
  constructor(config: JobManagerConfig) {
    super();
    this.config = config;
    this.jobQueue = new JobQueue(config.maxActiveJobs);
    this.extraNonceCounter = new ExtraNonceCounter(config.extraNonce1Size);
    
    // 定期的なクリーンアップ
    this.cleanupTimer = setInterval(() => this.cleanup(), 60000); // 1分ごと
    this.statsTimer = setInterval(() => this.updateStats(), 10000); // 10秒ごと
  }
  
  // ブロックテンプレートの更新
  updateBlockTemplate(template: WorkTemplate): void {
    this.currentTemplate = template;
    
    // 新しいジョブを作成
    const job = this.createJob(template);
    
    // キューに追加
    this.jobQueue.add(job);
    
    // 統計更新
    this.stats.totalJobs++;
    
    // イベント発行
    this.emit('newJob', job);
    this.emit('templateUpdated', template);
  }
  
  // ジョブの作成
  private createJob(template: WorkTemplate): WorkJob {
    const jobId = this.generateJobId();
    const now = Date.now();
    
    // コインベーストランザクションの作成
    const { coinbase1, coinbase2 } = this.createCoinbaseTransaction(
      template.height,
      template.coinbaseValue,
      this.config.poolAddress
    );
    
    // マークルブランチの計算
    const merkleBranch = template.transactions.length > 0
      ? MerkleTree.calculateMerkleBranch(template.transactions, 0)
      : [];
    
    return {
      id: jobId,
      height: template.height,
      prevHash: template.previousBlockHash,
      coinbase1,
      coinbase2,
      merkleBranch,
      version: '20000000', // Version 2
      nbits: template.bits,
      ntime: Math.floor(template.curtime).toString(16),
      cleanJobs: true,
      extraNonce1Size: this.config.extraNonce1Size,
      extraNonce2Size: this.config.extraNonce2Size,
      createdAt: now,
      expiresAt: now + (this.config.jobTimeout * 1000)
    };
  }
  
  // ジョブIDの生成
  private generateJobId(): string {
    return Date.now().toString(16) + Math.random().toString(16).substr(2, 8);
  }
  
  // コインベーストランザクションの作成
  private createCoinbaseTransaction(
    height: number,
    value: number,
    address: string
  ): { coinbase1: string; coinbase2: string } {
    // 簡略化されたコインベース作成
    // 実際の実装ではBIP34などに準拠する必要がある
    
    // コインベース1: バージョン + 入力カウント + 前のTX + 前のインデックス + スクリプト長
    let coinbase1 = '01000000' + // バージョン
                     '01' +       // 入力カウント
                     '0'.repeat(64) + // 前のトランザクション（null）
                     'ffffffff';  // 前のアウトプットインデックス
    
    // 高さをエンコード
    const heightBuffer = Buffer.alloc(4);
    heightBuffer.writeUInt32LE(height, 0);
    const heightHex = heightBuffer.toString('hex');
    
    // スクリプトシグ: 高さ + ExtraNonce + 署名
    const scriptSig = heightHex + 
                      '00'.repeat(this.config.extraNonce1Size + this.config.extraNonce2Size) +
                      Buffer.from(this.config.coinbaseSignature).toString('hex');
    
    const scriptSigSize = Buffer.from([(scriptSig.length / 2)]).toString('hex');
    coinbase1 += scriptSigSize + scriptSig.substring(0, scriptSig.length - 
                 (this.config.extraNonce1Size + this.config.extraNonce2Size) * 2);
    
    // コインベース2: シーケンス + アウトプットカウント + 値 + スクリプト
    const coinbase2 = 'ffffffff' + // シーケンス
                      '01' +        // アウトプットカウント
                      this.encodeValue(value) + // 値
                      '19' +        // スクリプト長（P2PKH = 25バイト）
                      '76a914' +    // OP_DUP OP_HASH160
                      this.addressToScriptHash(address) +
                      '88ac' +      // OP_EQUALVERIFY OP_CHECKSIG
                      '00000000';   // ロックタイム
    
    return { coinbase1, coinbase2 };
  }
  
  // 値のエンコード（リトルエンディアン8バイト）
  private encodeValue(value: number): string {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(BigInt(value), 0);
    return buffer.toString('hex');
  }
  
  // アドレスをスクリプトハッシュに変換（簡略化）
  private addressToScriptHash(address: string): string {
    // 実際の実装ではBase58デコードが必要
    return '0'.repeat(40); // 仮の実装
  }
  
  // マイナーへのジョブ割り当て
  assignJob(minerId: string, workerName?: string): MinerJob | null {
    const latestJob = this.jobQueue.getLatest();
    if (!latestJob) {
      return null;
    }
    
    // ExtraNonce1を生成
    const extraNonce1 = this.extraNonceCounter.next();
    
    // マイナージョブを作成
    const minerJob: MinerJob = {
      minerId,
      jobId: latestJob.id,
      extraNonce1,
      difficulty: 1, // デフォルト難易度
      assignedAt: Date.now(),
      shares: 0,
      validShares: 0
    };
    
    // 保存
    this.minerJobs.set(minerId, minerJob);
    
    // イベント発行
    this.emit('jobAssigned', { minerId, jobId: latestJob.id, extraNonce1 });
    
    return minerJob;
  }
  
  // ジョブの取得
  getJob(jobId: string): WorkJob | undefined {
    return this.jobQueue.get(jobId);
  }
  
  // マイナーのジョブ取得
  getMinerJob(minerId: string): MinerJob | undefined {
    return this.minerJobs.get(minerId);
  }
  
  // 現在のジョブ取得
  getCurrentJob(): WorkJob | undefined {
    return this.jobQueue.getLatest();
  }
  
  // シェア提出の記録
  recordShare(minerId: string, jobId: string, valid: boolean): void {
    const minerJob = this.minerJobs.get(minerId);
    if (!minerJob || minerJob.jobId !== jobId) {
      return;
    }
    
    minerJob.shares++;
    if (valid) {
      minerJob.validShares++;
      this.stats.validShares++;
    }
    this.stats.totalShares++;
    
    if (!minerJob.submittedAt) {
      minerJob.submittedAt = Date.now();
    }
  }
  
  // ジョブの検証
  validateJob(jobId: string): boolean {
    const job = this.jobQueue.get(jobId);
    if (!job) {
      return false;
    }
    
    const now = Date.now();
    return job.expiresAt > now;
  }
  
  // クリーンアップ
  private cleanup(): void {
    // 期限切れジョブの削除
    const removed = this.jobQueue.cleanup();
    this.stats.expiredJobs += removed;
    
    // 非アクティブなマイナージョブの削除
    const timeout = this.config.jobTimeout * 1000 * 2; // ジョブタイムアウトの2倍
    const now = Date.now();
    
    for (const [minerId, minerJob] of this.minerJobs) {
      if (now - minerJob.assignedAt > timeout) {
        this.minerJobs.delete(minerId);
      }
    }
    
    this.emit('cleanup', { removedJobs: removed });
  }
  
  // 統計の更新
  private updateStats(): void {
    const activeJobs = this.jobQueue.getActive();
    this.stats.activeJobs = activeJobs.length;
    
    // ジョブ/分の計算
    const recentJobs = Array.from(this.minerJobs.values())
      .filter(job => Date.now() - job.assignedAt < 60000);
    this.stats.jobsPerMinute = recentJobs.length;
    
    // 平均ジョブ寿命
    if (activeJobs.length > 0) {
      const totalLifetime = activeJobs.reduce((sum, job) => 
        sum + (Date.now() - job.createdAt), 0);
      this.stats.avgJobLifetime = totalLifetime / activeJobs.length / 1000; // 秒単位
    }
    
    this.emit('statsUpdated', this.stats);
  }
  
  // 統計の取得
  getStats(): JobStats {
    return { ...this.stats };
  }
  
  // すべてのジョブをクリア（新ブロック時など）
  clearJobs(): void {
    this.jobQueue.clear();
    this.minerJobs.clear();
    this.emit('jobsCleared');
  }
  
  // マイナーの難易度設定
  setMinerDifficulty(minerId: string, difficulty: number): void {
    const minerJob = this.minerJobs.get(minerId);
    if (minerJob) {
      minerJob.difficulty = difficulty;
      this.emit('difficultySet', { minerId, difficulty });
    }
  }
  
  // 破棄
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
    }
    
    this.jobQueue.clear();
    this.minerJobs.clear();
    this.removeAllListeners();
  }
}

// === ワーク分配器 ===
export class WorkDistributor {
  private jobManager: WorkJobManager;
  private miners: Map<string, { 
    socket: any; 
    difficulty: number; 
    extraNonce1?: string;
  }> = new Map();
  
  constructor(jobManager: WorkJobManager) {
    this.jobManager = jobManager;
    
    // 新しいジョブが作成されたら全マイナーに配布
    this.jobManager.on('newJob', (job) => this.distributeJob(job));
  }
  
  // マイナーの登録
  registerMiner(minerId: string, socket: any, difficulty: number = 1): void {
    const minerJob = this.jobManager.assignJob(minerId);
    
    if (minerJob) {
      this.miners.set(minerId, {
        socket,
        difficulty,
        extraNonce1: minerJob.extraNonce1
      });
      
      // 現在のジョブを送信
      const currentJob = this.jobManager.getCurrentJob();
      if (currentJob) {
        this.sendJobToMiner(minerId, currentJob);
      }
    }
  }
  
  // マイナーの登録解除
  unregisterMiner(minerId: string): void {
    this.miners.delete(minerId);
  }
  
  // ジョブの配布
  private distributeJob(job: WorkJob): void {
    for (const [minerId, miner] of this.miners) {
      this.sendJobToMiner(minerId, job);
    }
  }
  
  // 個別マイナーへのジョブ送信
  private sendJobToMiner(minerId: string, job: WorkJob): void {
    const miner = this.miners.get(minerId);
    if (!miner || !miner.socket) return;
    
    const minerJob = this.jobManager.getMinerJob(minerId);
    if (!minerJob) return;
    
    // Stratum形式のジョブ通知
    const notification = JSON.stringify({
      id: null,
      method: 'mining.notify',
      params: [
        job.id,
        job.prevHash,
        job.coinbase1,
        job.coinbase2,
        job.merkleBranch,
        job.version,
        job.nbits,
        job.ntime,
        job.cleanJobs
      ]
    }) + '\n';
    
    try {
      miner.socket.write(notification);
    } catch (error) {
      // ソケットエラーの場合はマイナーを削除
      this.unregisterMiner(minerId);
    }
  }
  
  // 難易度の更新
  updateMinerDifficulty(minerId: string, difficulty: number): void {
    const miner = this.miners.get(minerId);
    if (miner) {
      miner.difficulty = difficulty;
      this.jobManager.setMinerDifficulty(minerId, difficulty);
      
      // 難易度変更を通知
      const notification = JSON.stringify({
        id: null,
        method: 'mining.set_difficulty',
        params: [difficulty]
      }) + '\n';
      
      try {
        miner.socket.write(notification);
      } catch (error) {
        this.unregisterMiner(minerId);
      }
    }
  }
  
  // アクティブマイナー数
  getActiveMinersCount(): number {
    return this.miners.size;
  }
}

// エクスポート
export default WorkJobManager;