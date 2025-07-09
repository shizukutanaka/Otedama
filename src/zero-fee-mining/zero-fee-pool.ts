/**
 * 手数料0%のマイナーアドレス直接配布システム
 * 設計思想: Rob Pike (シンプル), John Carmack (高性能), Robert C. Martin (クリーン)
 * 
 * プールの取り分は0%で、マイナーのアドレスを登録して
 * マイニングするとその通貨を制限なしでそのまま受け取れるシステム
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { Database } from 'sqlite3';
import axios from 'axios';
import { ethers } from 'ethers';

// === 型定義 ===
export interface MinerRegistration {
  minerId: string;
  workerName: string | undefined;
  payoutAddress: string;
  currency: string;
  joinedAt: number;
  totalShares: number;
  validShares: number;
  totalEarned: number;
  lastPayout: number;
  active: boolean;
}

export interface ShareRecord {
  id: string;
  minerId: string;
  minerAddress: string;
  shareHash: string;
  difficulty: number;
  blockHeight: number;
  nonce: string;
  timestamp: number;
  valid: boolean;
  rewardAmount: number;
  paid: boolean;
  txHash?: string;
}

export interface BlockReward {
  blockHash: string;
  blockHeight: number;
  finderMinerId: string;
  totalReward: number;
  distributedAt: number;
  shareDistribution: ShareDistribution[];
}

export interface ShareDistribution {
  minerId: string;
  address: string;
  shares: number;
  percentage: number;
  amount: number;
  txHash?: string;
  paid: boolean;
}

export interface PayoutConfig {
  currency: string;
  minimumPayout: number;
  maxRetries: number;
  batchSize: number;
  confirmationBlocks: number;
}

export interface ZeroFeeStats {
  totalMiners: number;
  activeMiners: number;
  totalShares: number;
  totalBlocks: number;
  totalDistributed: number;
  avgBlockTime: number;
  networkHashrate: number;
  poolHashrate: number;
  efficiency: number;
}

// === 手数料0%マイニングプール ===
export class ZeroFeeMiningPool extends EventEmitter {
  private miners = new Map<string, MinerRegistration>();
  private shareRecords = new Map<string, ShareRecord>();
  private blockRewards = new Map<string, BlockReward>();
  private payoutConfigs = new Map<string, PayoutConfig>();
  private database: Database;
  private stats: ZeroFeeStats;
  private isInitialized = false;
  private payoutProcessor?: NodeJS.Timeout;

  constructor(dbPath: string = './data/zero-fee-pool.db') {
    super();
    this.database = new Database(dbPath);
    this.stats = {
      totalMiners: 0,
      activeMiners: 0,
      totalShares: 0,
      totalBlocks: 0,
      totalDistributed: 0,
      avgBlockTime: 0,
      networkHashrate: 0,
      poolHashrate: 0,
      efficiency: 100 // 手数料0%なので効率は100%
    };

    this.setupDefaultPayoutConfigs();
  }

  // === 初期化 ===
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    await this.createTables();
    await this.loadMiners();
    await this.loadShareRecords();
    await this.loadBlockRewards();
    this.startPayoutProcessor();
    
    this.isInitialized = true;
    this.emit('initialized');
  }

  private async createTables(): Promise<void> {
    return new Promise((resolve) => {
      this.database.serialize(() => {
        // マイナー登録テーブル
        this.database.run(`
          CREATE TABLE IF NOT EXISTS miners (
            minerId TEXT PRIMARY KEY,
            workerName TEXT,
            payoutAddress TEXT NOT NULL,
            currency TEXT NOT NULL,
            joinedAt INTEGER NOT NULL,
            totalShares INTEGER DEFAULT 0,
            validShares INTEGER DEFAULT 0,
            totalEarned REAL DEFAULT 0,
            lastPayout INTEGER DEFAULT 0,
            active BOOLEAN DEFAULT 1
          )
        `);

        // シェア記録テーブル
        this.database.run(`
          CREATE TABLE IF NOT EXISTS shares (
            id TEXT PRIMARY KEY,
            minerId TEXT NOT NULL,
            minerAddress TEXT NOT NULL,
            shareHash TEXT NOT NULL,
            difficulty REAL NOT NULL,
            blockHeight INTEGER NOT NULL,
            nonce TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            valid BOOLEAN NOT NULL,
            rewardAmount REAL DEFAULT 0,
            paid BOOLEAN DEFAULT 0,
            txHash TEXT
          )
        `);

        // ブロック報酬テーブル
        this.database.run(`
          CREATE TABLE IF NOT EXISTS block_rewards (
            blockHash TEXT PRIMARY KEY,
            blockHeight INTEGER NOT NULL,
            finderMinerId TEXT NOT NULL,
            totalReward REAL NOT NULL,
            distributedAt INTEGER NOT NULL,
            shareDistribution TEXT NOT NULL
          )
        `);

        // インデックス作成
        this.database.run(`CREATE INDEX IF NOT EXISTS idx_shares_miner ON shares(minerId)`);
        this.database.run(`CREATE INDEX IF NOT EXISTS idx_shares_timestamp ON shares(timestamp)`);
        this.database.run(`CREATE INDEX IF NOT EXISTS idx_shares_paid ON shares(paid)`);
        
        resolve();
      });
    });
  }

  // === マイナー登録 ===
  async registerMiner(
    minerId: string,
    payoutAddress: string,
    currency: string,
    workerName?: string
  ): Promise<boolean> {
    try {
      // アドレス検証
      if (!this.validateAddress(payoutAddress, currency)) {
        throw new Error(`Invalid ${currency} address: ${payoutAddress}`);
      }

      const registration: MinerRegistration = {
        minerId,
        workerName,
        payoutAddress,
        currency: currency.toUpperCase(),
        joinedAt: Date.now(),
        totalShares: 0,
        validShares: 0,
        totalEarned: 0,
        lastPayout: 0,
        active: true
      };

      // データベースに保存
      await this.saveMiner(registration);
      this.miners.set(minerId, registration);

      this.updateStats();
      this.emit('minerRegistered', registration);

      console.log(`✅ Miner ${minerId} registered for ${currency} payouts to ${payoutAddress}`);
      return true;

    } catch (error) {
      console.error(`❌ Failed to register miner ${minerId}:`, error);
      return false;
    }
  }

  async updateMinerAddress(minerId: string, newAddress: string): Promise<boolean> {
    const miner = this.miners.get(minerId);
    if (!miner) {
      return false;
    }

    if (!this.validateAddress(newAddress, miner.currency)) {
      return false;
    }

    miner.payoutAddress = newAddress;
    await this.saveMiner(miner);

    this.emit('minerAddressUpdated', { minerId, newAddress });
    return true;
  }

  // === シェア処理 ===
  async submitShare(
    minerId: string,
    shareHash: string,
    difficulty: number,
    blockHeight: number,
    nonce: string,
    valid: boolean
  ): Promise<ShareRecord | null> {
    const miner = this.miners.get(minerId);
    if (!miner) {
      console.warn(`⚠️ Unknown miner ${minerId} submitted share`);
      return null;
    }

    const shareRecord: ShareRecord = {
      id: this.generateShareId(),
      minerId,
      minerAddress: miner.payoutAddress,
      shareHash,
      difficulty,
      blockHeight,
      nonce,
      timestamp: Date.now(),
      valid,
      rewardAmount: 0, // 後で計算
      paid: false
    };

    // データベースに保存
    await this.saveShare(shareRecord);
    this.shareRecords.set(shareRecord.id, shareRecord);

    // マイナー統計更新
    miner.totalShares++;
    if (valid) {
      miner.validShares++;
    }
    await this.saveMiner(miner);

    this.updateStats();
    this.emit('shareSubmitted', shareRecord);

    if (valid) {
      console.log(`✅ Valid share from ${minerId} (difficulty: ${difficulty})`);
    }

    return shareRecord;
  }

  // === ブロック発見処理 ===
  async processBlockFound(
    blockHash: string,
    blockHeight: number,
    finderMinerId: string,
    totalReward: number
  ): Promise<void> {
    console.log(`🎉 Block found! Height: ${blockHeight}, Finder: ${finderMinerId}, Reward: ${totalReward}`);

    try {
      // 最近のシェアを取得（例：過去1時間）
      const recentShares = await this.getRecentValidShares(3600000); // 1時間
      
      if (recentShares.length === 0) {
        console.warn('⚠️ No recent shares found for reward distribution');
        return;
      }

      // シェア配分計算
      const distribution = this.calculateShareDistribution(recentShares, totalReward);

      // ブロック報酬記録
      const blockReward: BlockReward = {
        blockHash,
        blockHeight,
        finderMinerId,
        totalReward,
        distributedAt: Date.now(),
        shareDistribution: distribution
      };

      await this.saveBlockReward(blockReward);
      this.blockRewards.set(blockHash, blockReward);

      // 各マイナーの報酬を更新
      for (const dist of distribution) {
        const miner = this.miners.get(dist.minerId);
        if (miner) {
          miner.totalEarned += dist.amount;
          await this.saveMiner(miner);
        }

        // シェア記録の報酬を更新
        await this.updateShareRewards(dist.minerId, blockHeight, dist.amount);
      }

      // 即座に支払い処理を実行
      await this.processPayouts();

      this.updateStats();
      this.emit('blockProcessed', blockReward);

      console.log(`💰 Block reward distributed to ${distribution.length} miners`);

    } catch (error) {
      console.error('❌ Error processing block reward:', error);
    }
  }

  private calculateShareDistribution(shares: ShareRecord[], totalReward: number): ShareDistribution[] {
    // マイナー別シェア集計
    const minerShares = new Map<string, { shares: number; address: string }>();
    let totalValidShares = 0;

    for (const share of shares) {
      if (share.valid) {
        const existing = minerShares.get(share.minerId) || { shares: 0, address: share.minerAddress };
        existing.shares += share.difficulty;
        existing.address = share.minerAddress; // 最新のアドレスを使用
        minerShares.set(share.minerId, existing);
        totalValidShares += share.difficulty;
      }
    }

    // 配分計算（手数料0%）
    const distribution: ShareDistribution[] = [];
    for (const [minerId, data] of minerShares) {
      const percentage = data.shares / totalValidShares;
      const amount = totalReward * percentage;

      distribution.push({
        minerId,
        address: data.address,
        shares: data.shares,
        percentage,
        amount,
        paid: false
      });
    }

    return distribution;
  }

  // === 支払い処理 ===
  async processPayouts(): Promise<void> {
    console.log('💳 Processing payouts...');

    for (const [currency, config] of this.payoutConfigs) {
      await this.processCurrencyPayouts(currency, config);
    }
  }

  private async processCurrencyPayouts(currency: string, config: PayoutConfig): Promise<void> {
    // 未払いの報酬を集計
    const pendingPayouts = new Map<string, number>();
    
    for (const [minerId, miner] of this.miners) {
      if (miner.currency === currency && miner.active) {
        const unpaidAmount = await this.getUnpaidAmount(minerId);
        if (unpaidAmount >= config.minimumPayout) {
          pendingPayouts.set(minerId, unpaidAmount);
        }
      }
    }

    if (pendingPayouts.size === 0) {
      return;
    }

    console.log(`💰 Processing ${pendingPayouts.size} ${currency} payouts`);

    // バッチ支払い処理
    const payoutBatches = this.createPayoutBatches(pendingPayouts, config.batchSize);
    
    for (const batch of payoutBatches) {
      await this.processBatchPayout(batch, currency);
    }
  }

  private async processBatchPayout(
    batch: Map<string, number>,
    currency: string
  ): Promise<void> {
    try {
      const transactions: Array<{ address: string; amount: number; minerId: string }> = [];
      
      for (const [minerId, amount] of batch) {
        const miner = this.miners.get(minerId);
        if (miner) {
          transactions.push({
            address: miner.payoutAddress,
            amount,
            minerId
          });
        }
      }

      // ブロックチェーンに送金
      const txHashes = await this.sendBatchTransaction(transactions, currency);

      // 支払い記録更新
      for (let i = 0; i < transactions.length; i++) {
        const tx = transactions[i];
        const txHash = txHashes[i];

        if (tx && txHash) {
          await this.markSharesAsPaid(tx.minerId, txHash);
          
          const miner = this.miners.get(tx.minerId);
          if (miner) {
            miner.lastPayout = Date.now();
            await this.saveMiner(miner);
          }

          this.emit('payoutSent', {
            minerId: tx.minerId,
            address: tx.address,
            amount: tx.amount,
            currency,
            txHash
          });

          console.log(`✅ Paid ${tx.amount} ${currency} to ${tx.minerId} (${tx.address}) - TX: ${txHash}`);
        }
      }

    } catch (error) {
      console.error(`❌ Batch payout failed for ${currency}:`, error);
    }
  }

  private async sendBatchTransaction(
    transactions: Array<{ address: string; amount: number; minerId: string }>,
    currency: string
  ): Promise<(string | undefined)[]> {
    // 実際のブロックチェーン送金処理
    // ここでは各通貨のRPCまたはAPIを使用して送金
    const txHashes: (string | undefined)[] = [];

    for (const tx of transactions) {
      try {
        const txHash = await this.sendSingleTransaction(tx.address, tx.amount, currency);
        txHashes.push(txHash);
      } catch (error) {
        console.error(`❌ Failed to send to ${tx.address}:`, error);
        txHashes.push(undefined); // 失敗した場合はundefined
      }
    }

    return txHashes;
  }

  private async sendSingleTransaction(address: string, amount: number, currency: string): Promise<string | undefined> {
    switch (currency.toUpperCase()) {
      case 'XMR': {
        const rpcUrl = process.env['MONERO_RPC_URL'];
        if (!rpcUrl) {
          console.error('❌ MONERO_RPC_URL is not set in environment variables.');
          return undefined;
        }

        try {
          // Moneroの量はatomic unit (piconero)で指定
          const atomicAmount = Math.floor(amount * 1e12);

          const response = await axios.post(rpcUrl, {
            jsonrpc: '2.0',
            id: '0',
            method: 'transfer',
            params: {
              destinations: [{ amount: atomicAmount, address: address }],
              priority: 0, // Default priority
              unlock_time: 0
            }
          });

          if (response.data.error) {
            console.error(`❌ Monero RPC Error: ${response.data.error.message}`);
            return undefined;
          }

          const txHash = response.data.result.tx_hash;
          console.log(`💸 Sent ${amount} XMR to ${address}. TX Hash: ${txHash}`);
          return txHash;

        } catch (error) {
          console.error(`❌ Failed to send XMR transaction via RPC:`, error);
          return undefined;
        }
      }

      case 'ETH': {
        const rpcUrl = process.env['ETHEREUM_RPC_URL'];
        const privateKey = process.env['ETHEREUM_PRIVATE_KEY'];

        if (!rpcUrl || !privateKey) {
          console.error('❌ ETHEREUM_RPC_URL or ETHEREUM_PRIVATE_KEY is not set.');
          return undefined;
        }

        try {
          const provider = new ethers.JsonRpcProvider(rpcUrl);
          const wallet = new ethers.Wallet(privateKey, provider);
          
          const tx = await wallet.sendTransaction({
            to: address,
            value: ethers.parseEther(amount.toString())
          });

          console.log(`💸 Sent ${amount} ETH to ${address}. TX Hash: ${tx.hash}`);
          await tx.wait(); // Wait for transaction confirmation
          console.log(`✅ ETH Transaction confirmed: ${tx.hash}`);
          return tx.hash;

        } catch (error) {
          console.error('❌ Failed to send ETH transaction:', error);
          return undefined;
        }
      }

      // 他の通貨のケースをここに追加

      default: {
        // デフォルトはシミュレーションのまま
        console.log(`Simulating sending ${amount} ${currency} to ${address}`);
        const txHash = `sim_tx_${createHash('sha256').update(Date.now().toString() + address).digest('hex')}`;
        if (Math.random() < 0.1) {
            console.error(`Simulated transaction failure for ${address}`);
            return undefined;
        }
        return Promise.resolve(txHash);
      }
    }
  }

  // === ユーティリティ ===
  private validateAddress(address: string, currency: string): boolean {
    // 簡易的なアドレス検証
    switch (currency.toUpperCase()) {
      case 'BTC':
        return /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^bc1[a-z0-9]{39,59}$/.test(address);
      case 'ETH':
        return /^0x[a-fA-F0-9]{40}$/.test(address);
      case 'LTC':
        return /^[LM3][a-km-zA-HJ-NP-Z1-9]{26,33}$|^ltc1[a-z0-9]{39,59}$/.test(address);
      case 'XMR':
        return /^4[0-9AB][1-9A-HJ-NP-Za-km-z]{93}$/.test(address);
      default:
        return true; // 未知の通貨は一旦許可
    }
  }

  private generateShareId(): string {
    const timestamp = Date.now().toString();
    const random = Math.random().toString(36).substring(2);
    return createHash('sha256').update(timestamp + random).digest('hex').substring(0, 16);
  }

  private createPayoutBatches<T>(map: Map<string, T>, batchSize: number): Map<string, T>[] {
    const batches: Map<string, T>[] = [];
    let currentBatch = new Map<string, T>();
    let count = 0;

    for (const [key, value] of map) {
      currentBatch.set(key, value);
      count++;

      if (count >= batchSize) {
        batches.push(currentBatch);
        currentBatch = new Map<string, T>();
        count = 0;
      }
    }

    if (currentBatch.size > 0) {
      batches.push(currentBatch);
    }

    return batches;
  }

  private setupDefaultPayoutConfigs(): void {
    this.payoutConfigs.set('BTC', {
      currency: 'BTC',
      minimumPayout: 0.001, // 0.001 BTC最小支払い
      maxRetries: 3,
      batchSize: 10,
      confirmationBlocks: 6
    });

    this.payoutConfigs.set('ETH', {
      currency: 'ETH',
      minimumPayout: 0.01, // 0.01 ETH最小支払い
      maxRetries: 3,
      batchSize: 20,
      confirmationBlocks: 12
    });

    this.payoutConfigs.set('LTC', {
      currency: 'LTC',
      minimumPayout: 0.1, // 0.1 LTC最小支払い
      maxRetries: 3,
      batchSize: 15,
      confirmationBlocks: 6
    });

     this.payoutConfigs.set('XMR', {
      currency: 'XMR',
      minimumPayout: 0.1, 
      maxRetries: 3,
      batchSize: 15,
      confirmationBlocks: 10
    });
  }

  private startPayoutProcessor(): void {
    // 5分間隔で支払い処理を実行
    this.payoutProcessor = setInterval(async () => {
      await this.processPayouts();
    }, 300000);
  }

  stopPayoutProcessor(): void {
    if (this.payoutProcessor) {
      clearInterval(this.payoutProcessor);
      delete this.payoutProcessor;
    }
  }

  private updateStats(): void {
    this.stats.totalMiners = this.miners.size;
    this.stats.activeMiners = Array.from(this.miners.values()).filter(m => m.active).length;
    this.stats.totalShares = Array.from(this.miners.values()).reduce((sum, m) => sum + m.totalShares, 0);
    this.stats.totalBlocks = this.blockRewards.size;
    this.stats.totalDistributed = Array.from(this.miners.values()).reduce((sum, m) => sum + m.totalEarned, 0);
    this.stats.efficiency = 100; // 手数料0%なので常に100%
  }

  // === データベース操作 ===
  private async saveMiner(miner: MinerRegistration): Promise<void> {
    return new Promise((resolve, reject) => {
      const stmt = this.database.prepare(`
        INSERT OR REPLACE INTO miners 
        (minerId, workerName, payoutAddress, currency, joinedAt, totalShares, validShares, totalEarned, lastPayout, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run([
        miner.minerId,
        miner.workerName,
        miner.payoutAddress,
        miner.currency,
        miner.joinedAt,
        miner.totalShares,
        miner.validShares,
        miner.totalEarned,
        miner.lastPayout,
        miner.active ? 1 : 0
      ], (err) => {
        stmt.finalize();
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private async saveShare(share: ShareRecord): Promise<void> {
    return new Promise((resolve, reject) => {
      const stmt = this.database.prepare(`
        INSERT INTO shares 
        (id, minerId, minerAddress, shareHash, difficulty, blockHeight, nonce, timestamp, valid, rewardAmount, paid, txHash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run([
        share.id,
        share.minerId,
        share.minerAddress,
        share.shareHash,
        share.difficulty,
        share.blockHeight,
        share.nonce,
        share.timestamp,
        share.valid ? 1 : 0,
        share.rewardAmount,
        share.paid ? 1 : 0,
        share.txHash
      ], (err) => {
        stmt.finalize();
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private async saveBlockReward(blockReward: BlockReward): Promise<void> {
    return new Promise((resolve, reject) => {
      const stmt = this.database.prepare(`
        INSERT OR REPLACE INTO block_rewards 
        (blockHash, blockHeight, finderMinerId, totalReward, distributedAt, shareDistribution)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      stmt.run([
        blockReward.blockHash,
        blockReward.blockHeight,
        blockReward.finderMinerId,
        blockReward.totalReward,
        blockReward.distributedAt,
        JSON.stringify(blockReward.shareDistribution)
      ], (err) => {
        stmt.finalize();
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private async loadMiners(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.database.all('SELECT * FROM miners', (err, rows: any[]) => {
        if (err) {
          console.error('❌ Failed to load miners:', err);
          return reject(err);
        }

        (rows as MinerRegistration[]).forEach(miner => {
          // SQLiteはBOOLEANを0/1で保存するため、変換する
          miner.active = Boolean(miner.active);
          this.miners.set(miner.minerId, miner);
        });

        this.updateStats();
        console.log(`✅ Loaded ${this.miners.size} miners from database.`);
        resolve();
      });
    });
  }

  private async loadShareRecords(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.database.all('SELECT * FROM shares ORDER BY timestamp DESC LIMIT 10000', (err, rows: any[]) => {
        if (err) {
          console.error('❌ Failed to load share records:', err);
          return reject(err);
        }

        (rows as ShareRecord[]).forEach(share => {
          share.valid = Boolean(share.valid);
          share.paid = Boolean(share.paid);
          this.shareRecords.set(share.id, share);
        });

        console.log(`✅ Loaded ${this.shareRecords.size} share records from database.`);
        resolve();
      });
    });
  }

  private async loadBlockRewards(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.database.all('SELECT * FROM block_rewards ORDER BY distributedAt DESC LIMIT 1000', (err, rows: any[]) => {
        if (err) {
          console.error('❌ Failed to load block rewards:', err);
          return reject(err);
        }

        (rows as BlockReward[]).forEach(reward => {
          // JSON文字列をパースする
          if (typeof reward.shareDistribution === 'string') {
            try {
              reward.shareDistribution = JSON.parse(reward.shareDistribution);
            } catch (e) {
              console.error(`Failed to parse shareDistribution for block ${reward.blockHash}:`, e);
              reward.shareDistribution = [];
            }
          }
          this.blockRewards.set(reward.blockHash, reward);
        });

        console.log(`✅ Loaded ${this.blockRewards.size} block rewards from database.`);
        resolve();
      });
    });
  }

  private async getRecentValidShares(timeWindowMs: number): Promise<ShareRecord[]> {
    const cutoff = Date.now() - timeWindowMs;
    
    return new Promise((resolve, reject) => {
        this.database.all('SELECT * FROM shares WHERE valid = 1 AND timestamp > ?', [cutoff], (err, rows: any[]) => {
            if (err) {
                console.error('❌ Failed to get recent valid shares:', err);
                return reject(err);
            }
            const shares = (rows as ShareRecord[]).map(s => ({
                ...s,
                valid: Boolean(s.valid),
                paid: Boolean(s.paid)
            }));
            resolve(shares);
        });
    });
  }

  private async getUnpaidAmount(minerId: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.database.get(
        'SELECT SUM(rewardAmount) as total FROM shares WHERE minerId = ? AND paid = 0',
        [minerId],
        (err, row) => {
          if (err) return reject(err);
          resolve((row as { total: number })?.total || 0);
        }
      );
    });
  }

  private async updateShareRewards(minerId: string, blockHeight: number, totalAmount: number): Promise<void> {
    // そのマイナーの該当ブロック高度付近のシェアに報酬を配分
    return new Promise((resolve, reject) => {
      this.database.run(
        'UPDATE shares SET rewardAmount = ? WHERE minerId = ? AND blockHeight <= ? AND paid = 0',
        [totalAmount, minerId, blockHeight],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  private async markSharesAsPaid(minerId: string, txHash: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.database.run(
        'UPDATE shares SET paid = 1, txHash = ? WHERE minerId = ? AND paid = 0',
        [txHash, minerId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  // === 公開API ===
  getMiner(minerId: string): MinerRegistration | undefined {
    return this.miners.get(minerId);
  }

  getStats(): ZeroFeeStats {
    this.updateStats();
    return { ...this.stats };
  }

  getAllMiners(): MinerRegistration[] {
    return Array.from(this.miners.values());
  }

  getActiveMiners(): MinerRegistration[] {
    return Array.from(this.miners.values()).filter(m => m.active);
  }

  async getPayoutHistory(minerId: string, limit: number = 50): Promise<ShareRecord[]> {
    return new Promise((resolve, reject) => {
      this.database.all(
        'SELECT * FROM shares WHERE minerId = ? AND paid = 1 ORDER BY timestamp DESC LIMIT ?',
        [minerId, limit],
        (err, rows: any[]) => {
          if (err) {
            return reject(err);
          }

          const history = (rows as ShareRecord[]).map(row => ({
            ...row,
            valid: Boolean(row.valid),
            paid: Boolean(row.paid),
          }));

          resolve(history);
        }
      );
    });
  }

  async stop(): Promise<void> {
    this.stopPayoutProcessor();
    
    return new Promise((resolve, reject) => {
        this.database.close((err) => {
            if (err) {
                console.error('❌ Failed to close database:', err);
                return reject(err);
            }
            this.emit('stopped');
            resolve();
        });
    });
  }
}

// === ヘルパークラス ===
export class ZeroFeePoolHelper {
  static createDefaultPool(): ZeroFeeMiningPool {
    return new ZeroFeeMiningPool();
  }

  static validateMinerSetup(payoutAddress: string, currency: string): { valid: boolean; message: string } {
    const pool = new ZeroFeeMiningPool();
    
    // プライベートメソッドへのアクセスのため、ここでは簡易検証
    const isValid = (pool as any).validateAddress(payoutAddress, currency);
    
    return {
      valid: isValid,
      message: isValid ? 'Valid setup' : `Invalid ${currency} address format`
    };
  }

  static calculateEstimatedEarnings(hashrate: number, networkHashrate: number, blockReward: number): number {
    // 簡易的な収益計算（手数料0%）
    if (networkHashrate === 0) return 0;

    const blocksPerDay = 86400 / 120; // 2分ブロックタイムと仮定
    const poolShare = hashrate / networkHashrate;
    const dailyBlocks = blocksPerDay * poolShare;
    const dailyEarnings = dailyBlocks * blockReward;
    
    return dailyEarnings;
  }
}

export default ZeroFeeMiningPool;