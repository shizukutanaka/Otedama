/**
 * P2Pool方式シェアチェーン実装
 * 分散型マイニングプールのシェア管理
 * 
 * 設計思想：
 * - Carmack: 高速で効率的なシェアチェーン処理
 * - Martin: 拡張可能なシェア検証アーキテクチャ
 * - Pike: シンプルで理解しやすいチェーン構造
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';

// === 型定義 ===
export interface ShareChainConfig {
  // チェーン設定
  targetShareTime: number;        // 目標シェア間隔（秒）
  shareChainLength: number;       // シェアチェーンの長さ
  minShareDifficulty: number;     // 最小シェア難易度
  difficultyWindow: number;       // 難易度調整ウィンドウ
  
  // 報酬設定
  blockRewardShare: number;       // ブロック報酬のシェア割合
  donationPercent: number;        // デフォルト寄付率
  spreadPercent: number;          // スプレッド（前のシェアへの報酬）
  
  // セキュリティ設定
  maxUncles: number;             // 最大アンクル数
  maxTimeDrift: number;          // 最大時刻ドリフト（秒）
  orphanTimeout: number;         // オーファンタイムアウト（秒）
}

export interface P2PoolShare {
  // 基本情報
  shareId: string;
  version: number;
  previousShareId: string;
  coinbase: string;              // コインベーストランザクション
  nonce: number;
  timestamp: number;
  bits: number;                  // 圧縮された難易度
  
  // マイナー情報
  minerId: string;
  minerAddress: string;
  minerDonation: number;         // マイナーの寄付率
  
  // シェアチェーン情報
  shareInfo: {
    shareData: string;           // シェアデータのハッシュ
    maxBits: number;            // 最大難易度
    bitsForShare: number;       // このシェアの難易度
    newTransactionHashes: string[]; // 新しいトランザクション
    transactionHashRefs: number[]; // トランザクション参照
  };
  
  // 報酬情報
  rewards: Map<string, number>;   // アドレス -> 報酬額
  totalReward: number;
  height: number;
  
  // 検証情報
  hash?: string;
  powHash?: string;
  valid?: boolean;
  uncles: string[];              // アンクルシェアのID
}

export interface ShareValidationResult {
  valid: boolean;
  error?: string;
  warnings?: string[];
  score: number;                 // シェアのスコア（0-100）
}

export interface ChainState {
  tip: P2PoolShare | null;
  height: number;
  totalDifficulty: bigint;
  activeMiners: Set<string>;
  recentShares: P2PoolShare[];
  orphans: Map<string, P2PoolShare>;
}

export interface MinerStats {
  minerId: string;
  address: string;
  shares: number;
  hashrate: number;
  efficiency: number;
  lastShare: number;
  donation: number;
  estimatedReward: number;
}

// === シェアチェーンマネージャー ===
export class ShareChainManager extends EventEmitter {
  private config: ShareChainConfig;
  private shares: Map<string, P2PoolShare> = new Map();
  private chainTips: Map<string, P2PoolShare> = new Map();
  private orphans: Map<string, P2PoolShare> = new Map();
  private minerStats: Map<string, MinerStats> = new Map();
  private currentTip?: P2PoolShare;
  
  // インデックス
  private heightIndex: Map<number, Set<string>> = new Map();
  private minerIndex: Map<string, Set<string>> = new Map();
  private timeIndex: Map<number, Set<string>> = new Map();
  
  // メトリクス
  private metrics = {
    totalShares: 0,
    validShares: 0,
    orphanShares: 0,
    uncleShares: 0,
    reorgs: 0,
    averageShareTime: 0
  };
  
  constructor(config: ShareChainConfig) {
    super();
    this.config = config;
    
    // オーファンクリーンアップ
    setInterval(() => this.cleanupOrphans(), 60000);
  }
  
  // シェアの追加
  async addShare(share: P2PoolShare): Promise<ShareValidationResult> {
    try {
      // 基本検証
      const validation = await this.validateShare(share);
      if (!validation.valid) {
        return validation;
      }
      
      // ハッシュ計算
      share.hash = this.calculateShareHash(share);
      share.powHash = this.calculatePowHash(share);
      
      // 既存チェックP
      if (this.shares.has(share.shareId)) {
        return {
          valid: false,
          error: 'Share already exists',
          score: 0
        };
      }
      
      // 親シェアの確認
      const parent = this.shares.get(share.previousShareId);
      if (!parent && share.height > 1) {
        // オーファンとして保存
        this.orphans.set(share.shareId, share);
        this.metrics.orphanShares++;
        
        this.emit('orphanShare', share);
        
        // 親シェアをリクエスト
        this.requestParentShare(share.previousShareId);
        
        return {
          valid: true,
          warnings: ['Share is orphaned, waiting for parent'],
          score: validation.score
        };
      }
      
      // チェーンに追加
      this.addToChain(share);
      
      // インデックス更新
      this.updateIndices(share);
      
      // 統計更新
      this.updateMinerStats(share);
      
      // メトリクス更新
      this.metrics.totalShares++;
      if (share.valid) {
        this.metrics.validShares++;
      }
      
      // チェーンの再編成チェック
      if (await this.checkReorganization(share)) {
        await this.reorganizeChain(share);
      }
      
      // オーファンの解決
      await this.resolveOrphans(share);
      
      this.emit('shareAdded', share);
      
      return {
        valid: true,
        score: validation.score
      };
      
    } catch (error: any) {
      this.emit('error', { error, context: 'addShare' });
      return {
        valid: false,
        error: error.message,
        score: 0
      };
    }
  }
  
  // シェアの検証
  private async validateShare(share: P2PoolShare): Promise<ShareValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    let score = 100;
    
    // 基本フィールドチェック
    if (!share.shareId || !share.minerAddress || !share.coinbase) {
      errors.push('Missing required fields');
      return { valid: false, error: errors.join(', '), score: 0 };
    }
    
    // バージョンチェック
    if (share.version < 1 || share.version > 2) {
      errors.push('Invalid share version');
      score -= 50;
    }
    
    // タイムスタンプ検証
    const now = Date.now() / 1000;
    const timeDiff = Math.abs(share.timestamp - now);
    
    if (timeDiff > this.config.maxTimeDrift) {
      errors.push('Timestamp drift too large');
      score -= 30;
    } else if (timeDiff > 60) {
      warnings.push('Timestamp drift detected');
      score -= 10;
    }
    
    // 難易度検証
    if (share.bits < this.config.minShareDifficulty) {
      errors.push('Share difficulty too low');
      score -= 40;
    }
    
    // 親シェアとの整合性チェック
    if (share.previousShareId && share.previousShareId !== '0') {
      const parent = this.shares.get(share.previousShareId);
      if (parent) {
        // 高さの検証
        if (share.height !== parent.height + 1) {
          errors.push('Invalid share height');
          score -= 30;
        }
        
        // タイムスタンプの順序
        if (share.timestamp <= parent.timestamp) {
          errors.push('Share timestamp before parent');
          score -= 20;
        }
      }
    }
    
    // アンクル検証
    if (share.uncles.length > this.config.maxUncles) {
      errors.push('Too many uncle shares');
      score -= 20;
    }
    
    // アンクルの有効性チェック
    for (const uncleId of share.uncles) {
      const uncle = this.shares.get(uncleId);
      if (!uncle) {
        warnings.push(`Uncle ${uncleId} not found`);
        score -= 5;
      } else if (uncle.height >= share.height) {
        errors.push('Invalid uncle height');
        score -= 15;
      }
    }
    
    // 報酬検証
    const expectedReward = await this.calculateExpectedReward(share);
    const actualReward = share.totalReward;
    const rewardDiff = Math.abs(expectedReward - actualReward);
    
    if (rewardDiff > expectedReward * 0.01) { // 1%以上の差
      errors.push('Invalid reward calculation');
      score -= 25;
    }
    
    // 寄付率検証
    if (share.minerDonation < 0 || share.minerDonation > 100) {
      errors.push('Invalid donation percentage');
      score -= 20;
    }
    
    // POW検証（簡略化）
    const powValid = await this.validatePow(share);
    if (!powValid) {
      errors.push('Invalid proof of work');
      return { valid: false, error: errors.join(', '), score: 0 };
    }
    
    // 最終判定
    const valid = errors.length === 0;
    
    return {
      valid,
      error: errors.length > 0 ? errors.join(', ') : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
      score: Math.max(0, score)
    };
  }
  
  // チェーンへの追加
  private addToChain(share: P2PoolShare): void {
    // シェアを保存
    this.shares.set(share.shareId, share);
    
    // チェーンtipの更新
    if (!this.currentTip || share.height > this.currentTip.height) {
      this.currentTip = share;
      this.chainTips.set(share.shareId, share);
    } else if (share.height === this.currentTip.height) {
      // 同じ高さの競合するチェーン
      this.chainTips.set(share.shareId, share);
    }
    
    // 古いシェアの削除
    this.pruneOldShares();
  }
  
  // チェーン再編成のチェック
  private async checkReorganization(share: P2PoolShare): Promise<boolean> {
    if (!this.currentTip) return false;
    
    // 新しいシェアが現在のtipより良いかチェック
    const currentWork = await this.calculateChainWork(this.currentTip);
    const newWork = await this.calculateChainWork(share);
    
    return newWork > currentWork;
  }
  
  // チェーンの再編成
  private async reorganizeChain(newTip: P2PoolShare): Promise<void> {
    if (!this.currentTip) return;
    
    this.metrics.reorgs++;
    
    const oldTip = this.currentTip;
    const commonAncestor = this.findCommonAncestor(oldTip, newTip);
    
    // 再編成するシェアのリスト
    const toRemove: P2PoolShare[] = [];
    const toAdd: P2PoolShare[] = [];
    
    // 削除するシェアを収集
    let current: P2PoolShare | undefined = oldTip;
    while (current && current.shareId !== commonAncestor.shareId) {
      toRemove.push(current);
      current = this.shares.get(current.previousShareId);
    }
    
    // 追加するシェアを収集
    current = newTip;
    while (current && current.shareId !== commonAncestor.shareId) {
      toAdd.unshift(current);
      current = this.shares.get(current.previousShareId);
    }
    
    // 再編成の実行
    for (const share of toRemove) {
      this.removeFromIndices(share);
      // アンクル化
      this.metrics.uncleShares++;
    }
    
    for (const share of toAdd) {
      this.updateIndices(share);
    }
    
    // 新しいtipを設定
    this.currentTip = newTip;
    
    this.emit('reorganization', {
      oldTip: oldTip.shareId,
      newTip: newTip.shareId,
      depth: toRemove.length,
      commonAncestor: commonAncestor.shareId
    });
  }
  
  // 共通祖先の検索
  private findCommonAncestor(share1: P2PoolShare, share2: P2PoolShare): P2PoolShare {
    const ancestors1 = new Set<string>();
    const ancestors2 = new Set<string>();
    
    let current1: P2PoolShare | undefined = share1;
    let current2: P2PoolShare | undefined = share2;
    
    while (current1 || current2) {
      if (current1) {
        if (ancestors2.has(current1.shareId)) {
          return current1;
        }
        ancestors1.add(current1.shareId);
        current1 = this.shares.get(current1.previousShareId);
      }
      
      if (current2) {
        if (ancestors1.has(current2.shareId)) {
          return current2;
        }
        ancestors2.add(current2.shareId);
        current2 = this.shares.get(current2.previousShareId);
      }
    }
    
    // ジェネシスシェアを返す
    return this.getGenesisShare();
  }
  
  // オーファンの解決
  private async resolveOrphans(parentShare: P2PoolShare): Promise<void> {
    const resolved: P2PoolShare[] = [];
    
    // 親として待っているオーファンを探す
    for (const [orphanId, orphan] of this.orphans) {
      if (orphan.previousShareId === parentShare.shareId) {
        resolved.push(orphan);
      }
    }
    
    // 解決されたオーファンを処理
    for (const orphan of resolved) {
      this.orphans.delete(orphan.shareId);
      
      // 再度追加を試みる
      await this.addShare(orphan);
    }
  }
  
  // 報酬計算
  private async calculateExpectedReward(share: P2PoolShare): Promise<number> {
    // PPLNS方式での報酬計算
    const window = await this.getRewardWindow(share);
    let totalDifficulty = 0;
    const minerDifficulties = new Map<string, number>();
    
    for (const windowShare of window) {
      totalDifficulty += windowShare.bits;
      const current = minerDifficulties.get(windowShare.minerAddress) || 0;
      minerDifficulties.set(windowShare.minerAddress, current + windowShare.bits);
    }
    
    // ブロック報酬の分配計算
    const blockReward = 6.25; // BTC（例）
    const poolReward = blockReward * this.config.blockRewardShare;
    
    let expectedTotal = 0;
    for (const [address, difficulty] of minerDifficulties) {
      const share = difficulty / totalDifficulty;
      const reward = poolReward * share;
      expectedTotal += reward;
    }
    
    return expectedTotal;
  }
  
  // 報酬ウィンドウの取得
  private async getRewardWindow(tipShare: P2PoolShare): Promise<P2PoolShare[]> {
    const window: P2PoolShare[] = [];
    let current: P2PoolShare | undefined = tipShare;
    
    while (current && window.length < this.config.shareChainLength) {
      window.push(current);
      current = this.shares.get(current.previousShareId);
    }
    
    return window;
  }
  
  // インデックスの更新
  private updateIndices(share: P2PoolShare): void {
    // 高さインデックス
    const heightShares = this.heightIndex.get(share.height) || new Set();
    heightShares.add(share.shareId);
    this.heightIndex.set(share.height, heightShares);
    
    // マイナーインデックス
    const minerShares = this.minerIndex.get(share.minerId) || new Set();
    minerShares.add(share.shareId);
    this.minerIndex.set(share.minerId, minerShares);
    
    // 時間インデックス
    const timeBucket = Math.floor(share.timestamp / 3600); // 1時間単位
    const timeShares = this.timeIndex.get(timeBucket) || new Set();
    timeShares.add(share.shareId);
    this.timeIndex.set(timeBucket, timeShares);
  }
  
  // インデックスからの削除
  private removeFromIndices(share: P2PoolShare): void {
    // 高さインデックス
    const heightShares = this.heightIndex.get(share.height);
    if (heightShares) {
      heightShares.delete(share.shareId);
      if (heightShares.size === 0) {
        this.heightIndex.delete(share.height);
      }
    }
    
    // マイナーインデックス
    const minerShares = this.minerIndex.get(share.minerId);
    if (minerShares) {
      minerShares.delete(share.shareId);
      if (minerShares.size === 0) {
        this.minerIndex.delete(share.minerId);
      }
    }
    
    // 時間インデックス
    const timeBucket = Math.floor(share.timestamp / 3600);
    const timeShares = this.timeIndex.get(timeBucket);
    if (timeShares) {
      timeShares.delete(share.shareId);
      if (timeShares.size === 0) {
        this.timeIndex.delete(timeBucket);
      }
    }
  }
  
  // マイナー統計の更新
  private updateMinerStats(share: P2PoolShare): void {
    const stats = this.minerStats.get(share.minerId) || {
      minerId: share.minerId,
      address: share.minerAddress,
      shares: 0,
      hashrate: 0,
      efficiency: 1,
      lastShare: 0,
      donation: share.minerDonation,
      estimatedReward: 0
    };
    
    stats.shares++;
    stats.lastShare = share.timestamp;
    stats.donation = share.minerDonation;
    
    // ハッシュレートの推定（簡略化）
    const recentShares = this.getRecentSharesForMiner(share.minerId, 3600); // 1時間
    stats.hashrate = this.estimateHashrate(recentShares);
    
    // 推定報酬の計算
    stats.estimatedReward = this.estimateMinerReward(share.minerId);
    
    this.minerStats.set(share.minerId, stats);
  }
  
  // ハッシュレートの推定
  private estimateHashrate(shares: P2PoolShare[]): number {
    if (shares.length < 2) return 0;
    
    // 時間範囲の計算
    const timeRange = shares[shares.length - 1].timestamp - shares[0].timestamp;
    if (timeRange <= 0) return 0;
    
    // 総難易度の計算
    const totalDifficulty = shares.reduce((sum, share) => sum + share.bits, 0);
    
    // ハッシュレート = 難易度 * 2^32 / 時間
    return (totalDifficulty * Math.pow(2, 32)) / timeRange;
  }
  
  // マイナーの推定報酬
  private estimateMinerReward(minerId: string): number {
    if (!this.currentTip) return 0;
    
    const window = this.getRewardWindow(this.currentTip);
    let minerDifficulty = 0;
    let totalDifficulty = 0;
    
    for (const share of window) {
      totalDifficulty += share.bits;
      if (share.minerId === minerId) {
        minerDifficulty += share.bits;
      }
    }
    
    if (totalDifficulty === 0) return 0;
    
    const blockReward = 6.25; // BTC（例）
    const poolReward = blockReward * this.config.blockRewardShare;
    
    return poolReward * (minerDifficulty / totalDifficulty);
  }
  
  // 古いシェアの削除
  private pruneOldShares(): void {
    if (!this.currentTip) return;
    
    const minHeight = this.currentTip.height - this.config.shareChainLength * 2;
    
    // 古い高さのシェアを削除
    for (const [height, shareIds] of this.heightIndex) {
      if (height < minHeight) {
        for (const shareId of shareIds) {
          const share = this.shares.get(shareId);
          if (share) {
            this.shares.delete(shareId);
            this.removeFromIndices(share);
          }
        }
      }
    }
  }
  
  // オーファンのクリーンアップ
  private cleanupOrphans(): void {
    const now = Date.now() / 1000;
    const timeout = this.config.orphanTimeout;
    
    for (const [orphanId, orphan] of this.orphans) {
      if (now - orphan.timestamp > timeout) {
        this.orphans.delete(orphanId);
        this.emit('orphanTimeout', orphan);
      }
    }
  }
  
  // ユーティリティメソッド
  private calculateShareHash(share: P2PoolShare): string {
    const data = JSON.stringify({
      version: share.version,
      previousShareId: share.previousShareId,
      coinbase: share.coinbase,
      nonce: share.nonce,
      timestamp: share.timestamp,
      bits: share.bits,
      minerId: share.minerId,
      minerAddress: share.minerAddress
    });
    
    return createHash('sha256').update(data).digest('hex');
  }
  
  private calculatePowHash(share: P2PoolShare): string {
    // 実際のPOWハッシュ計算（アルゴリズムに依存）
    return this.calculateShareHash(share); // 簡略化
  }
  
  private async validatePow(share: P2PoolShare): Promise<boolean> {
    // POWの検証（実装依存）
    return true; // 簡略化
  }
  
  private async calculateChainWork(tip: P2PoolShare): Promise<bigint> {
    let work = BigInt(0);
    let current: P2PoolShare | undefined = tip;
    let count = 0;
    
    while (current && count < this.config.shareChainLength) {
      work += BigInt(current.bits);
      current = this.shares.get(current.previousShareId);
      count++;
    }
    
    return work;
  }
  
  private getGenesisShare(): P2PoolShare {
    // ジェネシスシェアを返す
    return {
      shareId: '0',
      version: 1,
      previousShareId: '',
      coinbase: '',
      nonce: 0,
      timestamp: 0,
      bits: this.config.minShareDifficulty,
      minerId: 'genesis',
      minerAddress: '',
      minerDonation: 0,
      shareInfo: {
        shareData: '',
        maxBits: 0,
        bitsForShare: 0,
        newTransactionHashes: [],
        transactionHashRefs: []
      },
      rewards: new Map(),
      totalReward: 0,
      height: 0,
      uncles: []
    };
  }
  
  private getRecentSharesForMiner(minerId: string, timeWindow: number): P2PoolShare[] {
    const shares: P2PoolShare[] = [];
    const minTime = Date.now() / 1000 - timeWindow;
    
    const minerShareIds = this.minerIndex.get(minerId);
    if (!minerShareIds) return shares;
    
    for (const shareId of minerShareIds) {
      const share = this.shares.get(shareId);
      if (share && share.timestamp >= minTime) {
        shares.push(share);
      }
    }
    
    return shares.sort((a, b) => a.timestamp - b.timestamp);
  }
  
  private requestParentShare(shareId: string): void {
    // 親シェアのリクエスト（P2Pネットワーク経由）
    this.emit('requestShare', shareId);
  }
  
  // 公開API
  getCurrentTip(): P2PoolShare | null {
    return this.currentTip || null;
  }
  
  getShare(shareId: string): P2PoolShare | null {
    return this.shares.get(shareId) || null;
  }
  
  getSharesByHeight(height: number): P2PoolShare[] {
    const shareIds = this.heightIndex.get(height);
    if (!shareIds) return [];
    
    const shares: P2PoolShare[] = [];
    for (const shareId of shareIds) {
      const share = this.shares.get(shareId);
      if (share) shares.push(share);
    }
    
    return shares;
  }
  
  getMinerStats(minerId: string): MinerStats | null {
    return this.minerStats.get(minerId) || null;
  }
  
  getAllMinerStats(): MinerStats[] {
    return Array.from(this.minerStats.values());
  }
  
  getChainState(): ChainState {
    const recentShares = this.currentTip ? 
      this.getRewardWindow(this.currentTip).slice(0, 10) : [];
    
    return {
      tip: this.currentTip || null,
      height: this.currentTip?.height || 0,
      totalDifficulty: this.currentTip ? 
        this.calculateChainWork(this.currentTip) : BigInt(0),
      activeMiners: new Set(this.minerStats.keys()),
      recentShares,
      orphans: new Map(this.orphans)
    };
  }
  
  getMetrics(): typeof this.metrics {
    // 平均シェア時間の計算
    if (this.currentTip) {
      const recentShares = this.getRewardWindow(this.currentTip).slice(0, 100);
      if (recentShares.length > 1) {
        const timeSpan = recentShares[0].timestamp - recentShares[recentShares.length - 1].timestamp;
        this.metrics.averageShareTime = timeSpan / (recentShares.length - 1);
      }
    }
    
    return { ...this.metrics };
  }
  
  // 難易度調整
  async adjustDifficulty(): Promise<number> {
    if (!this.currentTip) return this.config.minShareDifficulty;
    
    const window = this.getRewardWindow(this.currentTip).slice(0, this.config.difficultyWindow);
    if (window.length < 2) return this.config.minShareDifficulty;
    
    // 実際の時間と目標時間の比較
    const actualTime = window[0].timestamp - window[window.length - 1].timestamp;
    const targetTime = this.config.targetShareTime * (window.length - 1);
    
    // 新しい難易度の計算
    const currentDifficulty = window[0].bits;
    const ratio = targetTime / actualTime;
    let newDifficulty = currentDifficulty * ratio;
    
    // 変更の制限（最大4倍、最小1/4）
    newDifficulty = Math.max(currentDifficulty / 4, newDifficulty);
    newDifficulty = Math.min(currentDifficulty * 4, newDifficulty);
    
    // 最小難易度の確保
    newDifficulty = Math.max(this.config.minShareDifficulty, newDifficulty);
    
    return Math.floor(newDifficulty);
  }
}

export default ShareChainManager;