/**
 * Auto-Compound Manager - Otedama
 * 自動複利運用管理システム
 * 
 * 機能:
 * - マイニング報酬の自動複利運用
 * - 最適な複利タイミング計算
 * - ガス効率最適化
 * - 複数プロトコル対応
 * - リスク分散戦略
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import { ethers } from 'ethers';

const logger = createStructuredLogger('AutoCompoundManager');

// 複利プロトコル設定
export const CompoundProtocols = {
  YEARN: {
    name: 'Yearn Finance',
    chainId: 1,
    type: 'VAULT',
    registry: '0x50c1a2eA0a861A967D9d0FFE2AE4012c2E053804',
    gasEfficiency: 0.9,
    autoCompound: true,
    minDeposit: '100000000000000000', // 0.1 ETH
    fees: {
      performance: 0.2, // 20%
      management: 0.02 // 2%
    }
  },
  
  BEEFY: {
    name: 'Beefy Finance',
    chainId: [1, 56, 137], // Multi-chain
    type: 'VAULT',
    gasEfficiency: 0.85,
    autoCompound: true,
    minDeposit: '10000000000000000', // 0.01 ETH
    fees: {
      performance: 0.045, // 4.5%
      withdrawal: 0.001 // 0.1%
    }
  },
  
  COMPOUND: {
    name: 'Compound Finance',
    chainId: 1,
    type: 'LENDING',
    comptroller: '0x3d9819210A31b4961b30EF54bE2aeD79B9c9Cd3B',
    gasEfficiency: 0.8,
    autoCompound: false, // 手動複利
    minDeposit: '50000000000000000', // 0.05 ETH
    fees: {
      protocol: 0 // プロトコル手数料なし
    }
  },
  
  AAVE: {
    name: 'Aave',
    chainId: [1, 137],
    type: 'LENDING',
    lendingPool: '0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9',
    gasEfficiency: 0.85,
    autoCompound: false,
    minDeposit: '50000000000000000',
    fees: {
      flash: 0.0009 // 0.09%
    }
  },
  
  PANCAKE_CAKE_POOL: {
    name: 'PancakeSwap CAKE Pool',
    chainId: 56,
    type: 'STAKING',
    masterChef: '0xa80240Eb5d7E05d3F250cF000eEc0891d00b51CC',
    gasEfficiency: 0.95,
    autoCompound: true,
    minDeposit: '1000000000000000', // 0.001 BNB
    fees: {
      performance: 0.02 // 2%
    }
  }
};

// 複利戦略
export const CompoundStrategies = {
  AGGRESSIVE: {
    name: 'アグレッシブ',
    description: '高頻度複利で最大収益追求',
    compoundFrequency: 3600000, // 1時間
    minCompoundAmount: '10000000000000000', // 0.01 ETH
    gasToRewardRatio: 0.1, // ガスが報酬の10%以下なら実行
    riskLevel: 'high'
  },
  
  BALANCED: {
    name: 'バランス',
    description: 'ガス効率とリターンのバランス',
    compoundFrequency: 86400000, // 24時間
    minCompoundAmount: '50000000000000000', // 0.05 ETH
    gasToRewardRatio: 0.05, // ガスが報酬の5%以下
    riskLevel: 'medium'
  },
  
  CONSERVATIVE: {
    name: 'コンサバティブ',
    description: 'ガス効率重視の安定運用',
    compoundFrequency: 604800000, // 7日
    minCompoundAmount: '100000000000000000', // 0.1 ETH
    gasToRewardRatio: 0.02, // ガスが報酬の2%以下
    riskLevel: 'low'
  },
  
  DYNAMIC: {
    name: 'ダイナミック',
    description: 'ガス価格とAPYに基づく動的調整',
    compoundFrequency: null, // 動的に決定
    minCompoundAmount: null, // 動的に決定
    gasToRewardRatio: null, // 動的に決定
    riskLevel: 'variable'
  }
};

export class AutoCompoundManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // 基本設定
      enabled: options.enabled !== false,
      walletAddress: options.walletAddress,
      privateKey: options.privateKey,
      
      // 複利戦略
      strategy: options.strategy || 'BALANCED',
      customStrategy: options.customStrategy || null,
      
      // プロトコル設定
      enabledProtocols: options.enabledProtocols || ['YEARN', 'BEEFY', 'AAVE'],
      protocolAllocation: options.protocolAllocation || {
        YEARN: 0.4,
        BEEFY: 0.3,
        AAVE: 0.3
      },
      
      // ガス設定
      maxGasPrice: options.maxGasPrice || '100000000000', // 100 Gwei
      gasOptimization: options.gasOptimization !== false,
      priorityFee: options.priorityFee || '2000000000', // 2 Gwei
      
      // リスク管理
      emergencyStop: options.emergencyStop || false,
      maxSlippage: options.maxSlippage || 0.01, // 1%
      diversificationRequired: options.diversificationRequired !== false,
      
      // 通知設定
      notifyOnCompound: options.notifyOnCompound || false,
      notifyThreshold: options.notifyThreshold || '1000000000000000000', // 1 ETH
      
      ...options
    };
    
    // プロトコル接続
    this.protocols = new Map();
    this.protocolStates = new Map();
    
    // ポジション管理
    this.positions = new Map();
    this.pendingRewards = new Map();
    
    // 複利実行追跡
    this.compoundHistory = [];
    this.nextCompoundTimes = new Map();
    
    // ガス追跡
    this.gasTracker = {
      prices: [],
      optimal: null,
      lastUpdate: Date.now()
    };
    
    // 収益追跡
    this.earnings = {
      total: ethers.BigNumber.from(0),
      byProtocol: new Map(),
      compounded: ethers.BigNumber.from(0),
      gasSpent: ethers.BigNumber.from(0)
    };
    
    // 統計
    this.stats = {
      totalCompounds: 0,
      successfulCompounds: 0,
      failedCompounds: 0,
      averageAPY: 0,
      totalValue: ethers.BigNumber.from(0),
      gasEfficiency: 0
    };
    
    // タイマー
    this.compoundTimer = null;
    this.gasUpdateTimer = null;
    this.rewardCheckTimer = null;
  }
  
  /**
   * 初期化
   */
  async initialize() {
    logger.info('自動複利マネージャー初期化中', {
      strategy: this.options.strategy,
      protocols: this.options.enabledProtocols
    });
    
    try {
      // プロトコル初期化
      for (const protocolName of this.options.enabledProtocols) {
        await this.initializeProtocol(protocolName);
      }
      
      // 既存ポジション読み込み
      await this.loadExistingPositions();
      
      // ガス価格監視開始
      this.startGasTracking();
      
      // 報酬チェック開始
      this.startRewardChecking();
      
      // 複利実行スケジュール開始
      this.startCompoundScheduler();
      
      logger.info('自動複利マネージャー初期化完了', {
        protocols: this.protocols.size,
        positions: this.positions.size
      });
      
      this.emit('initialized', {
        strategy: this.options.strategy,
        protocols: Array.from(this.protocols.keys())
      });
      
    } catch (error) {
      logger.error('自動複利初期化失敗', { error: error.message });
      throw error;
    }
  }
  
  /**
   * 資金デポジットと複利設定
   */
  async deposit(amount, tokenAddress, options = {}) {
    const depositOptions = {
      protocol: options.protocol || null,
      autoSelect: options.autoSelect !== false,
      minAPY: options.minAPY || 0.05, // 5%
      ...options
    };
    
    logger.info('資金デポジット開始', {
      amount: ethers.utils.formatEther(amount),
      token: tokenAddress,
      autoSelect: depositOptions.autoSelect
    });
    
    try {
      // 最適プロトコル選択
      const selectedProtocols = depositOptions.protocol 
        ? [depositOptions.protocol]
        : await this.selectOptimalProtocols(amount, tokenAddress, depositOptions);
      
      const deposits = [];
      
      // 各プロトコルにデポジット
      for (const protocolName of selectedProtocols) {
        const allocation = this.options.protocolAllocation[protocolName] || 1.0;
        const depositAmount = amount.mul(Math.floor(allocation * 10000)).div(10000);
        
        if (depositAmount.gt(0)) {
          const position = await this.depositToProtocol(
            protocolName,
            depositAmount,
            tokenAddress,
            depositOptions
          );
          
          if (position) {
            deposits.push(position);
            
            // 複利スケジュール設定
            this.scheduleCompound(position);
          }
        }
      }
      
      // 統計更新
      this.stats.totalValue = this.stats.totalValue.add(amount);
      
      logger.info('資金デポジット完了', {
        protocols: deposits.length,
        totalDeposited: ethers.utils.formatEther(amount)
      });
      
      this.emit('deposited', {
        amount,
        token: tokenAddress,
        deposits
      });
      
      return deposits;
      
    } catch (error) {
      logger.error('デポジットエラー', {
        amount: ethers.utils.formatEther(amount),
        error: error.message
      });
      throw error;
    }
  }
  
  /**
   * 自動複利実行
   */
  async executeCompound(positionId) {
    const position = this.positions.get(positionId);
    if (!position) {
      throw new Error(`ポジションが見つかりません: ${positionId}`);
    }
    
    logger.info('複利実行開始', {
      positionId,
      protocol: position.protocol,
      strategy: position.strategy
    });
    
    try {
      // 緊急停止チェック
      if (this.options.emergencyStop) {
        logger.warn('緊急停止中のため複利をスキップ');
        return null;
      }
      
      // 保留報酬取得
      const pendingRewards = await this.getPendingRewards(position);
      
      // 複利実行可否チェック
      const shouldCompound = await this.shouldExecuteCompound(
        position,
        pendingRewards
      );
      
      if (!shouldCompound.execute) {
        logger.info('複利実行条件未達', {
          positionId,
          reason: shouldCompound.reason
        });
        return null;
      }
      
      // ガス見積もり
      const gasEstimate = await this.estimateCompoundGas(position);
      const gasPrice = await this.getOptimalGasPrice();
      const gasCost = gasEstimate.mul(gasPrice);
      
      // 複利実行
      const result = await this.executeProtocolCompound(
        position,
        pendingRewards,
        gasPrice
      );
      
      // 履歴記録
      this.compoundHistory.push({
        positionId,
        timestamp: Date.now(),
        rewards: pendingRewards,
        gasCost,
        gasPrice,
        success: true,
        txHash: result.txHash
      });
      
      // 統計更新
      this.updateCompoundStats(position, pendingRewards, gasCost, true);
      
      // 次回複利時刻を更新
      this.scheduleNextCompound(position);
      
      logger.info('複利実行完了', {
        positionId,
        rewards: ethers.utils.formatEther(pendingRewards),
        gasCost: ethers.utils.formatEther(gasCost),
        txHash: result.txHash
      });
      
      this.emit('compound:executed', {
        positionId,
        protocol: position.protocol,
        rewards: pendingRewards,
        gasCost,
        result
      });
      
      // 通知
      if (this.options.notifyOnCompound && pendingRewards.gte(this.options.notifyThreshold)) {
        this.emit('compound:notification', {
          positionId,
          rewards: ethers.utils.formatEther(pendingRewards),
          protocol: position.protocol
        });
      }
      
      return result;
      
    } catch (error) {
      // エラー記録
      this.compoundHistory.push({
        positionId,
        timestamp: Date.now(),
        success: false,
        error: error.message
      });
      
      this.stats.failedCompounds++;
      
      logger.error('複利実行エラー', {
        positionId,
        error: error.message
      });
      
      this.emit('compound:failed', {
        positionId,
        error: error.message
      });
      
      // 次回リトライをスケジュール
      this.scheduleRetry(position);
      
      throw error;
    }
  }
  
  /**
   * 複利実行可否判定
   */
  async shouldExecuteCompound(position, pendingRewards) {
    const strategy = this.getStrategy(position.strategy);
    
    // 最小報酬チェック
    const minAmount = strategy.minCompoundAmount || ethers.utils.parseEther('0.01');
    if (pendingRewards.lt(minAmount)) {
      return {
        execute: false,
        reason: 'rewards_too_small'
      };
    }
    
    // ガス効率チェック
    const gasEstimate = await this.estimateCompoundGas(position);
    const gasPrice = await this.getCurrentGasPrice();
    const gasCost = gasEstimate.mul(gasPrice);
    
    const gasRatio = gasCost.mul(10000).div(pendingRewards).toNumber() / 10000;
    const maxGasRatio = strategy.gasToRewardRatio || 0.05;
    
    if (gasRatio > maxGasRatio) {
      return {
        execute: false,
        reason: 'gas_too_expensive',
        gasRatio
      };
    }
    
    // ダイナミック戦略の場合、追加チェック
    if (strategy.name === 'ダイナミック') {
      const dynamicCheck = await this.dynamicStrategyCheck(position, pendingRewards, gasCost);
      if (!dynamicCheck.execute) {
        return dynamicCheck;
      }
    }
    
    return {
      execute: true,
      gasRatio,
      estimatedProfit: pendingRewards.sub(gasCost)
    };
  }
  
  /**
   * ダイナミック戦略チェック
   */
  async dynamicStrategyCheck(position, pendingRewards, gasCost) {
    // 現在のAPY取得
    const currentAPY = await this.getProtocolAPY(position.protocol);
    
    // ガス価格トレンド分析
    const gasTrend = this.analyzeGasTrend();
    
    // 最適な複利タイミング計算
    const optimalTiming = this.calculateOptimalCompoundTiming(
      pendingRewards,
      gasCost,
      currentAPY,
      gasTrend
    );
    
    if (optimalTiming.waitTime > 0) {
      return {
        execute: false,
        reason: 'wait_for_optimal_timing',
        waitTime: optimalTiming.waitTime
      };
    }
    
    return {
      execute: true,
      analysis: {
        apy: currentAPY,
        gasTrend,
        score: optimalTiming.score
      }
    };
  }
  
  /**
   * Yearn Finance複利実行
   */
  async executeYearnCompound(position) {
    const protocol = CompoundProtocols.YEARN;
    const provider = await this.getProvider(protocol.chainId);
    const wallet = new ethers.Wallet(this.options.privateKey, provider);
    
    // Yearn Vault ABI（簡略版）
    const vaultABI = [
      'function deposit(uint256 _amount) external returns (uint256)',
      'function withdraw(uint256 _shares) external returns (uint256)',
      'function pricePerShare() external view returns (uint256)',
      'function totalAssets() external view returns (uint256)',
      'function balanceOf(address account) external view returns (uint256)'
    ];
    
    const vault = new ethers.Contract(position.vaultAddress, vaultABI, wallet);
    
    // Yearnは自動複利なので、追加アクションは不要
    // ただし、パフォーマンスを確認
    const shares = await vault.balanceOf(wallet.address);
    const pricePerShare = await vault.pricePerShare();
    const currentValue = shares.mul(pricePerShare).div(ethers.utils.parseEther('1'));
    
    logger.info('Yearn自動複利確認', {
      positionId: position.id,
      currentValue: ethers.utils.formatEther(currentValue),
      shares: shares.toString()
    });
    
    return {
      success: true,
      protocol: 'YEARN',
      currentValue,
      txHash: '0x0' // 自動複利のためトランザクションなし
    };
  }
  
  /**
   * Compound Finance複利実行
   */
  async executeCompoundFinanceCompound(position) {
    const protocol = CompoundProtocols.COMPOUND;
    const provider = await this.getProvider(protocol.chainId);
    const wallet = new ethers.Wallet(this.options.privateKey, provider);
    
    // cToken ABI（簡略版）
    const cTokenABI = [
      'function mint(uint mintAmount) external returns (uint)',
      'function redeem(uint redeemTokens) external returns (uint)',
      'function redeemUnderlying(uint redeemAmount) external returns (uint)',
      'function balanceOf(address owner) external view returns (uint)',
      'function exchangeRateStored() external view returns (uint)',
      'function accrueInterest() external returns (uint)'
    ];
    
    const cToken = new ethers.Contract(position.cTokenAddress, cTokenABI, wallet);
    
    // 利息を累積
    await cToken.accrueInterest();
    
    // 現在の残高を取得
    const balance = await cToken.balanceOf(wallet.address);
    const exchangeRate = await cToken.exchangeRateStored();
    const underlyingBalance = balance.mul(exchangeRate).div(ethers.utils.parseEther('1'));
    
    // 利息分を計算
    const interest = underlyingBalance.sub(position.principal);
    
    if (interest.gt(0)) {
      // 利息を引き出して再投資
      const tx = await cToken.redeemUnderlying(interest, {
        gasPrice: await this.getOptimalGasPrice(),
        gasLimit: 200000
      });
      
      const receipt = await tx.wait();
      
      // 再投資
      const mintTx = await cToken.mint(interest, {
        gasPrice: await this.getOptimalGasPrice(),
        gasLimit: 200000
      });
      
      const mintReceipt = await mintTx.wait();
      
      // ポジション更新
      position.principal = underlyingBalance;
      
      return {
        success: true,
        protocol: 'COMPOUND',
        interest,
        txHash: mintReceipt.transactionHash,
        gasUsed: receipt.gasUsed.add(mintReceipt.gasUsed)
      };
    }
    
    return {
      success: true,
      protocol: 'COMPOUND',
      interest: ethers.BigNumber.from(0),
      txHash: '0x0'
    };
  }
  
  /**
   * 最適ガス価格取得
   */
  async getOptimalGasPrice() {
    // ガス価格履歴から最適値を計算
    if (this.gasTracker.optimal) {
      const age = Date.now() - this.gasTracker.lastUpdate;
      if (age < 60000) { // 1分以内なら cached値を使用
        return this.gasTracker.optimal;
      }
    }
    
    const provider = await this.getProvider(1); // Ethereum
    const currentGasPrice = await provider.getGasPrice();
    
    // EIP-1559対応
    const block = await provider.getBlock('latest');
    if (block.baseFeePerGas) {
      const baseFee = block.baseFeePerGas;
      const priorityFee = ethers.BigNumber.from(this.options.priorityFee);
      const maxFee = baseFee.mul(2).add(priorityFee);
      
      this.gasTracker.optimal = maxFee;
    } else {
      this.gasTracker.optimal = currentGasPrice.mul(110).div(100); // 10%バッファ
    }
    
    this.gasTracker.lastUpdate = Date.now();
    
    return this.gasTracker.optimal;
  }
  
  /**
   * 引き出し
   */
  async withdraw(positionId, percentage = 100) {
    const position = this.positions.get(positionId);
    if (!position) {
      throw new Error(`ポジションが見つかりません: ${positionId}`);
    }
    
    logger.info('引き出し開始', {
      positionId,
      percentage,
      protocol: position.protocol
    });
    
    try {
      // 複利実行（引き出し前に最終複利）
      try {
        await this.executeCompound(positionId);
      } catch (error) {
        logger.warn('引き出し前の複利実行スキップ', { error: error.message });
      }
      
      // プロトコルから引き出し
      const result = await this.withdrawFromProtocol(position, percentage);
      
      // ポジション更新または削除
      if (percentage >= 100) {
        this.positions.delete(positionId);
        this.cancelCompoundSchedule(positionId);
      } else {
        position.principal = position.principal.mul(100 - percentage).div(100);
        position.value = position.value.mul(100 - percentage).div(100);
      }
      
      // 統計更新
      this.stats.totalValue = this.stats.totalValue.sub(result.withdrawnAmount);
      
      logger.info('引き出し完了', {
        positionId,
        withdrawnAmount: ethers.utils.formatEther(result.withdrawnAmount),
        profit: ethers.utils.formatEther(result.profit)
      });
      
      this.emit('withdrawn', {
        positionId,
        result
      });
      
      return result;
      
    } catch (error) {
      logger.error('引き出しエラー', {
        positionId,
        error: error.message
      });
      throw error;
    }
  }
  
  /**
   * 統計情報取得
   */
  getStatistics() {
    const positions = Array.from(this.positions.values()).map(pos => ({
      id: pos.id,
      protocol: pos.protocol,
      value: ethers.utils.formatEther(pos.value || pos.principal),
      apy: pos.apy || 0,
      compoundCount: pos.compoundCount || 0,
      lastCompound: pos.lastCompound || null
    }));
    
    const gasEfficiency = this.stats.totalCompounds > 0
      ? (this.stats.successfulCompounds / this.stats.totalCompounds * 100).toFixed(1)
      : 0;
    
    return {
      totalValue: ethers.utils.formatEther(this.stats.totalValue),
      totalEarnings: ethers.utils.formatEther(this.earnings.total),
      totalCompounded: ethers.utils.formatEther(this.earnings.compounded),
      gasSpent: ethers.utils.formatEther(this.earnings.gasSpent),
      totalCompounds: this.stats.totalCompounds,
      successRate: gasEfficiency + '%',
      averageAPY: (this.stats.averageAPY * 100).toFixed(2) + '%',
      strategy: this.options.strategy,
      positions
    };
  }
  
  /**
   * シャットダウン
   */
  async shutdown() {
    logger.info('自動複利マネージャーシャットダウン中');
    
    // タイマー停止
    if (this.compoundTimer) clearInterval(this.compoundTimer);
    if (this.gasUpdateTimer) clearInterval(this.gasUpdateTimer);
    if (this.rewardCheckTimer) clearInterval(this.rewardCheckTimer);
    
    // スケジュールされた複利をキャンセル
    for (const [positionId, _] of this.nextCompoundTimes) {
      this.cancelCompoundSchedule(positionId);
    }
    
    logger.info('自動複利マネージャーシャットダウン完了');
  }
  
  // ユーティリティメソッド
  
  async initializeProtocol(protocolName) {
    const config = CompoundProtocols[protocolName];
    if (!config) {
      throw new Error(`未対応のプロトコル: ${protocolName}`);
    }
    
    this.protocols.set(protocolName, config);
    this.protocolStates.set(protocolName, {
      connected: true,
      lastUpdate: Date.now(),
      currentAPY: 0
    });
    
    logger.info('プロトコル初期化完了', { protocol: protocolName });
  }
  
  async loadExistingPositions() {
    // 既存ポジションの読み込み（データベースから）
    logger.info('既存ポジション読み込み完了', { count: 0 });
  }
  
  startGasTracking() {
    this.gasUpdateTimer = setInterval(async () => {
      await this.updateGasPrice();
    }, 60000); // 1分ごと
  }
  
  startRewardChecking() {
    this.rewardCheckTimer = setInterval(async () => {
      await this.checkAllPendingRewards();
    }, 300000); // 5分ごと
  }
  
  startCompoundScheduler() {
    this.compoundTimer = setInterval(async () => {
      await this.processScheduledCompounds();
    }, 60000); // 1分ごと
  }
  
  async selectOptimalProtocols(amount, tokenAddress, options) {
    const candidates = [];
    
    for (const [protocolName, config] of this.protocols) {
      const apy = await this.getProtocolAPY(protocolName);
      if (apy >= options.minAPY) {
        candidates.push({
          name: protocolName,
          apy,
          gasEfficiency: config.gasEfficiency
        });
      }
    }
    
    // APYとガス効率でソート
    candidates.sort((a, b) => {
      const scoreA = a.apy * a.gasEfficiency;
      const scoreB = b.apy * b.gasEfficiency;
      return scoreB - scoreA;
    });
    
    // 分散化が必要な場合は上位3つ、そうでなければ最適な1つ
    if (this.options.diversificationRequired) {
      return candidates.slice(0, 3).map(c => c.name);
    } else {
      return [candidates[0].name];
    }
  }
  
  async depositToProtocol(protocolName, amount, tokenAddress, options) {
    const protocol = this.protocols.get(protocolName);
    
    switch (protocolName) {
      case 'YEARN':
        return this.depositToYearn(amount, tokenAddress, protocol);
      case 'COMPOUND':
        return this.depositToCompound(amount, tokenAddress, protocol);
      case 'AAVE':
        return this.depositToAave(amount, tokenAddress, protocol);
      default:
        throw new Error(`未実装のプロトコル: ${protocolName}`);
    }
  }
  
  scheduleCompound(position) {
    const strategy = this.getStrategy(position.strategy);
    const nextTime = Date.now() + (strategy.compoundFrequency || 86400000);
    
    this.nextCompoundTimes.set(position.id, nextTime);
    
    logger.info('複利スケジュール設定', {
      positionId: position.id,
      nextTime: new Date(nextTime).toISOString()
    });
  }
  
  scheduleNextCompound(position) {
    const strategy = this.getStrategy(position.strategy);
    
    if (strategy.name === 'ダイナミック') {
      // ダイナミック戦略の場合、次回タイミングを動的に計算
      const optimalInterval = this.calculateOptimalInterval(position);
      const nextTime = Date.now() + optimalInterval;
      this.nextCompoundTimes.set(position.id, nextTime);
    } else {
      // 固定戦略の場合
      const nextTime = Date.now() + strategy.compoundFrequency;
      this.nextCompoundTimes.set(position.id, nextTime);
    }
  }
  
  cancelCompoundSchedule(positionId) {
    this.nextCompoundTimes.delete(positionId);
  }
  
  getStrategy(strategyName) {
    return CompoundStrategies[strategyName] || CompoundStrategies.BALANCED;
  }
  
  async getProvider(chainId) {
    // チェーンIDに基づくプロバイダー取得
    const rpcUrls = {
      1: 'https://mainnet.infura.io/v3/YOUR_KEY',
      56: 'https://bsc-dataseed.binance.org/',
      137: 'https://polygon-rpc.com/'
    };
    
    return new ethers.providers.JsonRpcProvider(rpcUrls[chainId]);
  }
  
  async getPendingRewards(position) {
    // プロトコル固有の保留報酬取得
    switch (position.protocol) {
      case 'YEARN':
        return this.getYearnRewards(position);
      case 'COMPOUND':
        return this.getCompoundRewards(position);
      default:
        return ethers.BigNumber.from(0);
    }
  }
  
  async estimateCompoundGas(position) {
    // プロトコル固有のガス見積もり
    const baseGas = {
      YEARN: 150000,
      COMPOUND: 200000,
      AAVE: 250000
    };
    
    return ethers.BigNumber.from(baseGas[position.protocol] || 200000);
  }
  
  async getCurrentGasPrice() {
    const provider = await this.getProvider(1);
    return provider.getGasPrice();
  }
  
  async executeProtocolCompound(position, rewards, gasPrice) {
    switch (position.protocol) {
      case 'YEARN':
        return this.executeYearnCompound(position);
      case 'COMPOUND':
        return this.executeCompoundFinanceCompound(position);
      default:
        throw new Error(`未実装のプロトコル: ${position.protocol}`);
    }
  }
  
  updateCompoundStats(position, rewards, gasCost, success) {
    this.stats.totalCompounds++;
    if (success) {
      this.stats.successfulCompounds++;
      this.earnings.compounded = this.earnings.compounded.add(rewards);
      this.earnings.gasSpent = this.earnings.gasSpent.add(gasCost);
      
      position.compoundCount = (position.compoundCount || 0) + 1;
      position.lastCompound = Date.now();
    } else {
      this.stats.failedCompounds++;
    }
  }
  
  scheduleRetry(position) {
    // 15分後にリトライ
    const retryTime = Date.now() + 900000;
    this.nextCompoundTimes.set(position.id, retryTime);
  }
  
  analyzeGasTrend() {
    if (this.gasTracker.prices.length < 10) {
      return 'stable';
    }
    
    const recent = this.gasTracker.prices.slice(-10);
    const avg = recent.reduce((sum, p) => sum + p, 0) / recent.length;
    const current = recent[recent.length - 1];
    
    if (current > avg * 1.2) return 'rising';
    if (current < avg * 0.8) return 'falling';
    return 'stable';
  }
  
  calculateOptimalCompoundTiming(rewards, gasCost, apy, gasTrend) {
    // 複雑な最適化ロジック（簡略版）
    let score = 0;
    let waitTime = 0;
    
    // ガストレンドに基づく調整
    if (gasTrend === 'rising') {
      score -= 10;
    } else if (gasTrend === 'falling') {
      waitTime = 3600000; // 1時間待つ
    }
    
    // APYに基づく調整
    if (apy > 0.5) { // 50% APY以上
      score += 20;
    }
    
    // 報酬とガスコストの比率
    const ratio = rewards.div(gasCost);
    if (ratio.gt(20)) {
      score += 30;
    }
    
    return { score, waitTime };
  }
  
  calculateOptimalInterval(position) {
    // ポジションサイズ、APY、ガス価格に基づく最適間隔計算
    const baseInterval = 86400000; // 24時間
    
    // 簡略化した計算
    return baseInterval;
  }
  
  async updateGasPrice() {
    const provider = await this.getProvider(1);
    const gasPrice = await provider.getGasPrice();
    
    this.gasTracker.prices.push(gasPrice.toNumber());
    if (this.gasTracker.prices.length > 100) {
      this.gasTracker.prices.shift();
    }
  }
  
  async checkAllPendingRewards() {
    for (const [positionId, position] of this.positions) {
      try {
        const rewards = await this.getPendingRewards(position);
        this.pendingRewards.set(positionId, rewards);
      } catch (error) {
        logger.warn('報酬チェックエラー', {
          positionId,
          error: error.message
        });
      }
    }
  }
  
  async processScheduledCompounds() {
    const now = Date.now();
    
    for (const [positionId, scheduledTime] of this.nextCompoundTimes) {
      if (scheduledTime <= now) {
        try {
          await this.executeCompound(positionId);
        } catch (error) {
          logger.error('スケジュール複利実行エラー', {
            positionId,
            error: error.message
          });
        }
      }
    }
  }
  
  async getProtocolAPY(protocolName) {
    // プロトコルの現在のAPYを取得（実装省略）
    const mockAPYs = {
      YEARN: 0.15,
      BEEFY: 0.25,
      COMPOUND: 0.08,
      AAVE: 0.06
    };
    
    return mockAPYs[protocolName] || 0.1;
  }
  
  async depositToYearn(amount, tokenAddress, protocol) {
    // Yearnへのデポジット実装
    return {
      id: `yearn-${Date.now()}`,
      protocol: 'YEARN',
      vaultAddress: '0x...',
      principal: amount,
      value: amount,
      strategy: this.options.strategy,
      timestamp: Date.now()
    };
  }
  
  async depositToCompound(amount, tokenAddress, protocol) {
    // Compoundへのデポジット実装
    return {
      id: `compound-${Date.now()}`,
      protocol: 'COMPOUND',
      cTokenAddress: '0x...',
      principal: amount,
      value: amount,
      strategy: this.options.strategy,
      timestamp: Date.now()
    };
  }
  
  async depositToAave(amount, tokenAddress, protocol) {
    // Aaveへのデポジット実装
    return {
      id: `aave-${Date.now()}`,
      protocol: 'AAVE',
      aTokenAddress: '0x...',
      principal: amount,
      value: amount,
      strategy: this.options.strategy,
      timestamp: Date.now()
    };
  }
  
  async withdrawFromProtocol(position, percentage) {
    // プロトコルからの引き出し実装
    const withdrawAmount = position.value.mul(percentage).div(100);
    const profit = withdrawAmount.sub(position.principal.mul(percentage).div(100));
    
    return {
      withdrawnAmount: withdrawAmount,
      profit,
      txHash: '0x...'
    };
  }
  
  async getYearnRewards(position) {
    // Yearnの報酬計算（自動複利のため基本的に0）
    return ethers.BigNumber.from(0);
  }
  
  async getCompoundRewards(position) {
    // Compoundの報酬計算
    return ethers.utils.parseEther('0.1'); // 仮の値
  }
}

export default AutoCompoundManager;