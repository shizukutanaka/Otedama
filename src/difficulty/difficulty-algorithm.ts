/**
 * 難易度計算アルゴリズムの実装
 * 設計思想: シンプルで効率的（Carmack）、クリーンアーキテクチャ（Martin）、明瞭性（Pike）
 */

import { EventEmitter } from 'events';

// === 型定義 ===
export interface DifficultyConfig {
  // 基本設定
  minDifficulty: number;
  maxDifficulty: number;
  initialDifficulty: number;
  
  // 調整パラメータ
  targetBlockTime: number; // 秒単位
  adjustmentInterval: number; // ブロック数
  maxAdjustmentFactor: number; // 最大調整率
  
  // アルゴリズム選択
  algorithm: 'bitcoin' | 'ethereum' | 'custom';
  
  // VarDiff設定
  varDiffEnabled: boolean;
  varDiffVariance: number;
  varDiffMinTarget: number;
  varDiffMaxTarget: number;
  varDiffRetargetTime: number; // 秒単位
}

export interface MinerDifficulty {
  minerId: string;
  currentDifficulty: number;
  targetDifficulty: number;
  lastShareTime: number;
  shareCount: number;
  validShares: number;
  avgShareTime: number;
}

export interface NetworkStats {
  hashrate: number;
  difficulty: number;
  blockTime: number;
  height: number;
}

// === 難易度計算アルゴリズム基底クラス ===
export abstract class DifficultyAlgorithm {
  protected config: DifficultyConfig;
  
  constructor(config: DifficultyConfig) {
    this.config = config;
  }
  
  abstract calculateNetworkDifficulty(
    currentDifficulty: number,
    actualTime: number,
    expectedTime: number
  ): number;
  
  abstract calculateMinerDifficulty(
    minerStats: MinerDifficulty,
    poolHashrate: number
  ): number;
  
  // 共通ユーティリティ
  protected clampDifficulty(difficulty: number): number {
    return Math.max(
      this.config.minDifficulty,
      Math.min(this.config.maxDifficulty, difficulty)
    );
  }
  
  protected clampAdjustment(factor: number): number {
    const max = this.config.maxAdjustmentFactor;
    return Math.max(1 / max, Math.min(max, factor));
  }
}

// === Bitcoin式難易度計算 ===
export class BitcoinDifficultyAlgorithm extends DifficultyAlgorithm {
  calculateNetworkDifficulty(
    currentDifficulty: number,
    actualTime: number,
    expectedTime: number
  ): number {
    // Bitcoin: difficulty = difficulty * (expected_time / actual_time)
    // 2週間ごとに調整、最大4倍まで
    const adjustmentFactor = this.clampAdjustment(expectedTime / actualTime);
    const newDifficulty = currentDifficulty * adjustmentFactor;
    
    return this.clampDifficulty(newDifficulty);
  }
  
  calculateMinerDifficulty(
    minerStats: MinerDifficulty,
    poolHashrate: number
  ): number {
    if (!this.config.varDiffEnabled) {
      return minerStats.currentDifficulty;
    }
    
    // VarDiffアルゴリズム
    const targetTime = this.config.varDiffRetargetTime;
    const variance = this.config.varDiffVariance;
    
    // 目標: N秒ごとにシェアを受け取る
    if (minerStats.avgShareTime === 0) {
      return minerStats.currentDifficulty;
    }
    
    const ratio = targetTime / minerStats.avgShareTime;
    
    // 変動が小さい場合は調整しない
    if (Math.abs(1 - ratio) < variance) {
      return minerStats.currentDifficulty;
    }
    
    // 新しい難易度を計算
    let newDifficulty = minerStats.currentDifficulty * ratio;
    
    // 最小/最大制限
    newDifficulty = Math.max(
      this.config.varDiffMinTarget,
      Math.min(this.config.varDiffMaxTarget, newDifficulty)
    );
    
    return Math.floor(newDifficulty);
  }
}

// === Ethereum式難易度計算 ===
export class EthereumDifficultyAlgorithm extends DifficultyAlgorithm {
  calculateNetworkDifficulty(
    currentDifficulty: number,
    actualTime: number,
    expectedTime: number
  ): number {
    // Ethereum: より複雑な難易度爆弾を含む計算
    // 簡略化版
    const diff = actualTime - expectedTime;
    const adjustment = Math.floor(currentDifficulty / 2048) * Math.max(1 - Math.floor(diff / 10), -99);
    
    const newDifficulty = currentDifficulty + adjustment;
    
    // 最小難易度を保証
    return Math.max(131072, newDifficulty);
  }
  
  calculateMinerDifficulty(
    minerStats: MinerDifficulty,
    poolHashrate: number
  ): number {
    // Ethereumスタイルの調整（GPUマイニング向け）
    if (!this.config.varDiffEnabled) {
      return minerStats.currentDifficulty;
    }
    
    const targetShares = 4; // 4 shares per minute
    const timePeriod = 60; // 1 minute
    const expectedTime = timePeriod / targetShares;
    
    if (minerStats.avgShareTime === 0) {
      return minerStats.currentDifficulty;
    }
    
    const ratio = expectedTime / minerStats.avgShareTime;
    const adjustment = Math.pow(ratio, 0.5); // より緩やかな調整
    
    let newDifficulty = minerStats.currentDifficulty * adjustment;
    
    return Math.floor(this.clampDifficulty(newDifficulty));
  }
}

// === カスタム難易度計算（高度な実装）===
export class CustomDifficultyAlgorithm extends DifficultyAlgorithm {
  private readonly WINDOW_SIZE = 144; // 1日分のブロック
  private blockTimes: number[] = [];
  
  calculateNetworkDifficulty(
    currentDifficulty: number,
    actualTime: number,
    expectedTime: number
  ): number {
    // 移動平均を使用した滑らかな調整
    this.blockTimes.push(actualTime);
    
    if (this.blockTimes.length > this.WINDOW_SIZE) {
      this.blockTimes.shift();
    }
    
    if (this.blockTimes.length < 10) {
      // データ不足時はBitcoin式にフォールバック
      const adjustmentFactor = this.clampAdjustment(expectedTime / actualTime);
      return this.clampDifficulty(currentDifficulty * adjustmentFactor);
    }
    
    // 加重移動平均
    let weightedSum = 0;
    let weightSum = 0;
    
    for (let i = 0; i < this.blockTimes.length; i++) {
      const weight = i + 1; // 新しいブロックほど重要
      weightedSum += this.blockTimes[i] * weight;
      weightSum += weight;
    }
    
    const avgTime = weightedSum / weightSum;
    const adjustmentFactor = this.clampAdjustment(expectedTime / avgTime);
    
    // 急激な変化を防ぐためのダンピング
    const dampingFactor = 0.25;
    const smoothedFactor = 1 + (adjustmentFactor - 1) * dampingFactor;
    
    return this.clampDifficulty(currentDifficulty * smoothedFactor);
  }
  
  calculateMinerDifficulty(
    minerStats: MinerDifficulty,
    poolHashrate: number
  ): number {
    if (!this.config.varDiffEnabled) {
      return minerStats.currentDifficulty;
    }
    
    // 高度なVarDiff: マイナーのハッシュレートを推定
    const estimatedHashrate = this.estimateMinerHashrate(minerStats);
    const poolShare = estimatedHashrate / poolHashrate;
    
    // プールシェアに基づいた難易度設定
    const targetSharesPerMinute = 10;
    const sharesPerSecond = targetSharesPerMinute / 60;
    const targetDifficulty = (estimatedHashrate * Math.pow(2, 32)) / sharesPerSecond;
    
    // 段階的な調整
    const currentDiff = minerStats.currentDifficulty;
    const diffRatio = targetDifficulty / currentDiff;
    
    let newDifficulty: number;
    
    if (diffRatio > 2) {
      // 大幅増加が必要な場合は段階的に
      newDifficulty = currentDiff * 1.5;
    } else if (diffRatio < 0.5) {
      // 大幅減少が必要な場合も段階的に
      newDifficulty = currentDiff * 0.75;
    } else {
      // 小幅調整
      newDifficulty = currentDiff * (0.8 + 0.4 * diffRatio);
    }
    
    return Math.floor(this.clampDifficulty(newDifficulty));
  }
  
  private estimateMinerHashrate(minerStats: MinerDifficulty): number {
    if (minerStats.avgShareTime === 0 || minerStats.validShares === 0) {
      // デフォルト値: 1 MH/s
      return 1_000_000;
    }
    
    // hashrate = (shares * difficulty * 2^32) / time
    const totalDifficulty = minerStats.validShares * minerStats.currentDifficulty;
    const totalTime = minerStats.validShares * minerStats.avgShareTime;
    
    return (totalDifficulty * Math.pow(2, 32)) / totalTime;
  }
}

// === 難易度マネージャー ===
export class DifficultyManager extends EventEmitter {
  private algorithm: DifficultyAlgorithm;
  private config: DifficultyConfig;
  private miners = new Map<string, MinerDifficulty>();
  private networkDifficulty: number;
  private lastAdjustmentBlock: number = 0;
  private blockTimes: number[] = [];
  
  constructor(config: DifficultyConfig) {
    super();
    this.config = config;
    this.networkDifficulty = config.initialDifficulty;
    
    // アルゴリズムの選択
    switch (config.algorithm) {
      case 'bitcoin':
        this.algorithm = new BitcoinDifficultyAlgorithm(config);
        break;
      case 'ethereum':
        this.algorithm = new EthereumDifficultyAlgorithm(config);
        break;
      case 'custom':
        this.algorithm = new CustomDifficultyAlgorithm(config);
        break;
      default:
        this.algorithm = new BitcoinDifficultyAlgorithm(config);
    }
  }
  
  // ネットワーク難易度の更新
  updateNetworkDifficulty(blockHeight: number, blockTime: number): void {
    this.blockTimes.push(blockTime);
    
    // 調整間隔に達したかチェック
    if (blockHeight - this.lastAdjustmentBlock >= this.config.adjustmentInterval) {
      const actualTime = this.blockTimes.reduce((sum, time) => sum + time, 0);
      const expectedTime = this.config.targetBlockTime * this.blockTimes.length;
      
      const oldDifficulty = this.networkDifficulty;
      this.networkDifficulty = this.algorithm.calculateNetworkDifficulty(
        oldDifficulty,
        actualTime,
        expectedTime
      );
      
      this.emit('networkDifficultyChanged', {
        oldDifficulty,
        newDifficulty: this.networkDifficulty,
        blockHeight,
        adjustment: this.networkDifficulty / oldDifficulty
      });
      
      // リセット
      this.lastAdjustmentBlock = blockHeight;
      this.blockTimes = [];
    }
  }
  
  // マイナーの難易度を取得/更新
  getMinerDifficulty(minerId: string): number {
    const miner = this.miners.get(minerId);
    if (!miner) {
      return this.config.initialDifficulty;
    }
    return miner.currentDifficulty;
  }
  
  // シェア提出時の処理
  recordShare(minerId: string, valid: boolean, timestamp: number): void {
    let miner = this.miners.get(minerId);
    
    if (!miner) {
      miner = {
        minerId,
        currentDifficulty: this.config.initialDifficulty,
        targetDifficulty: this.config.initialDifficulty,
        lastShareTime: timestamp,
        shareCount: 0,
        validShares: 0,
        avgShareTime: 0
      };
      this.miners.set(minerId, miner);
    }
    
    // 統計更新
    miner.shareCount++;
    if (valid) {
      miner.validShares++;
    }
    
    // 平均シェア時間の計算（移動平均）
    if (miner.lastShareTime > 0) {
      const shareTime = timestamp - miner.lastShareTime;
      const alpha = 0.2; // 平滑化係数
      miner.avgShareTime = miner.avgShareTime * (1 - alpha) + shareTime * alpha;
    }
    
    miner.lastShareTime = timestamp;
    
    // VarDiff調整のタイミングチェック
    if (this.config.varDiffEnabled && miner.shareCount % 10 === 0) {
      this.adjustMinerDifficulty(minerId);
    }
  }
  
  // マイナーの難易度調整
  private adjustMinerDifficulty(minerId: string): void {
    const miner = this.miners.get(minerId);
    if (!miner) return;
    
    const poolHashrate = this.calculatePoolHashrate();
    const newDifficulty = this.algorithm.calculateMinerDifficulty(miner, poolHashrate);
    
    if (newDifficulty !== miner.currentDifficulty) {
      const oldDifficulty = miner.currentDifficulty;
      miner.currentDifficulty = newDifficulty;
      miner.targetDifficulty = newDifficulty;
      
      this.emit('minerDifficultyChanged', {
        minerId,
        oldDifficulty,
        newDifficulty,
        adjustment: newDifficulty / oldDifficulty
      });
    }
  }
  
  // プール全体のハッシュレート計算
  private calculatePoolHashrate(): number {
    let totalHashrate = 0;
    const now = Date.now() / 1000;
    const window = 600; // 10分
    
    for (const [minerId, miner] of this.miners) {
      if (now - miner.lastShareTime > window) {
        continue; // 非アクティブなマイナーは除外
      }
      
      if (miner.avgShareTime > 0) {
        const hashrate = (miner.currentDifficulty * Math.pow(2, 32)) / miner.avgShareTime;
        totalHashrate += hashrate;
      }
    }
    
    return totalHashrate;
  }
  
  // 統計情報の取得
  getStats(): any {
    const activeMiners = Array.from(this.miners.values())
      .filter(m => Date.now() / 1000 - m.lastShareTime < 300);
    
    return {
      networkDifficulty: this.networkDifficulty,
      poolHashrate: this.calculatePoolHashrate(),
      activeMiners: activeMiners.length,
      totalMiners: this.miners.size,
      difficulties: activeMiners.map(m => ({
        minerId: m.minerId,
        difficulty: m.currentDifficulty,
        shares: m.validShares,
        avgShareTime: m.avgShareTime
      }))
    };
  }
  
  // クリーンアップ（非アクティブマイナーの削除）
  cleanup(): void {
    const now = Date.now() / 1000;
    const timeout = 3600; // 1時間
    
    for (const [minerId, miner] of this.miners) {
      if (now - miner.lastShareTime > timeout) {
        this.miners.delete(minerId);
        this.emit('minerRemoved', { minerId, reason: 'timeout' });
      }
    }
  }
}

// エクスポート
export default DifficultyManager;