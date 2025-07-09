/**
 * Stratum マージマイニング統合
 * 
 * Stratumサーバーにマージマイニングをシームレスに統合するための拡張
 */

import { EventEmitter } from 'events';
import { createComponentLogger } from '../logging/logging';
import { StratumServer } from '../network/stratum';
import { Job } from './entities';
import { StratumMergeMiningAdapter } from '../merge-mining/stratum-merge-mining-adapter';
import { MergeMiningManager } from '../merge-mining/merge-mining-manager';
import { AuxChainInfo } from '../merge-mining/merge-mining-interface';
import { loadMergeMiningConfig, saveMergeMiningConfig, MergeMiningConfig } from '../merge-mining/merge-mining-config';
import { DatabaseManager } from '../database/database';

export class StratumMergeMining extends EventEmitter {
  private logger = createComponentLogger('StratumMergeMining');
  private adapter: StratumMergeMiningAdapter;
  private config: MergeMiningConfig;
  private configPath: string;
  
  constructor(
    private stratumServer: StratumServer,
    private db: DatabaseManager,
    configPath: string
  ) {
    super();
    this.configPath = configPath;
    
    // 設定を読み込む
    this.config = loadMergeMiningConfig(configPath);
    
    // マージマイニングマネージャーを作成
    const manager = new MergeMiningManager(db);
    
    // アダプターを作成
    this.adapter = new StratumMergeMiningAdapter(manager);
    
    // イベントをリッスン
    this.setupEventListeners();
  }
  
  /**
   * イベントリスナーを設定
   */
  private setupEventListeners(): void {
    // マージマイニングイベントをリッスン
    this.adapter.on('auxBlockFound', (data) => {
      this.emit('auxBlockFound', data);
      this.logger.info('Aux block found', data);
    });
    
    this.adapter.on('auxChainAdded', (chainInfo) => {
      this.emit('auxChainAdded', chainInfo);
      this.logger.info('Aux chain added', { chainId: chainInfo.chainId, chainName: chainInfo.chainName });
    });
    
    this.adapter.on('auxChainRemoved', (chainInfo) => {
      this.emit('auxChainRemoved', chainInfo);
      this.logger.info('Aux chain removed', { chainId: chainInfo.chainId });
    });
    
    this.adapter.on('auxChainStatusChanged', (data) => {
      this.emit('auxChainStatusChanged', data);
      this.logger.info('Aux chain status changed', data);
    });
    
    // Stratumサーバーのシェア受信イベントをリッスン
    this.stratumServer.on('shareAccepted', async (data) => {
      try {
        if (this.adapter.isActive()) {
          // マージマイニングシェアを処理
          const result = await this.adapter.processShare({
            mainChainJobId: parseInt(data.share.jobId),
            mainChainNonce: data.share.nonce,
            auxChainIds: [], // アダプター内で設定される
            timestamp: Math.floor(Date.now() / 1000),
            blockHash: Buffer.from(data.share.hash || '', 'hex'),
            difficulty: data.share.difficulty,
            isBlockCandidate: data.share.isBlockCandidate || false
          });
          
          if (result.auxResults && result.auxResults.isValid) {
            this.logger.debug('Processed merged mining share', {
              acceptedChains: result.auxResults.acceptedChains.length,
              rejectedChains: result.auxResults.rejectedChains.length
            });
          }
        }
      } catch (error) {
        this.logger.error('Failed to process merged mining share', error as Error);
      }
    });
  }
  
  /**
   * マージマイニングを初期化
   */
  async initialize(): Promise<void> {
    try {
      await this.adapter.initialize();
      
      // 設定に基づいて有効/無効を設定
      this.adapter.setEnabled(this.config.enabled);
      
      // 設定からAuxチェーンを読み込む
      for (const chainInfo of this.config.auxChains) {
        try {
          await this.adapter.addAuxChain(chainInfo);
          this.logger.debug('Added aux chain from config', { chainId: chainInfo.chainId });
        } catch (error) {
          this.logger.warn('Failed to add aux chain from config', {
            chainId: chainInfo.chainId,
            error: (error as Error).message
          });
        }
      }
      
      this.logger.info('Stratum Merge Mining initialized', {
        enabled: this.config.enabled,
        auxChains: this.config.auxChains.length
      });
    } catch (error) {
      this.logger.error('Failed to initialize Stratum Merge Mining', error as Error);
      throw error;
    }
  }
  
  /**
   * マージマイニングを有効/無効に設定
   * @param enabled 有効にするかどうか
   */
  setEnabled(enabled: boolean): void {
    this.adapter.setEnabled(enabled);
    this.config.enabled = enabled;
    saveMergeMiningConfig(this.config, this.configPath);
    this.logger.info('Merge mining ' + (enabled ? 'enabled' : 'disabled'));
  }
  
  /**
   * マージマイニングが有効かどうかを取得
   */
  isEnabled(): boolean {
    return this.adapter.isActive();
  }
  
  /**
   * Auxチェーンを追加
   * @param chainInfo Auxチェーン情報
   */
  async addAuxChain(chainInfo: AuxChainInfo): Promise<void> {
    await this.adapter.addAuxChain(chainInfo);
    
    // 設定を更新
    if (!this.config.auxChains.some(chain => chain.chainId === chainInfo.chainId)) {
      this.config.auxChains.push(chainInfo);
      saveMergeMiningConfig(this.config, this.configPath);
    }
  }
  
  /**
   * Auxチェーンを削除
   * @param chainId チェーンID
   */
  async removeAuxChain(chainId: string): Promise<void> {
    await this.adapter.removeAuxChain(chainId);
    
    // 設定を更新
    this.config.auxChains = this.config.auxChains.filter(chain => chain.chainId !== chainId);
    saveMergeMiningConfig(this.config, this.configPath);
  }
  
  /**
   * Auxチェーンの有効/無効を切り替え
   * @param chainId チェーンID
   * @param isActive 有効にするかどうか
   */
  async setAuxChainActive(chainId: string, isActive: boolean): Promise<void> {
    await this.adapter.setAuxChainActive(chainId, isActive);
    
    // 設定を更新
    const chainIndex = this.config.auxChains.findIndex(chain => chain.chainId === chainId);
    if (chainIndex >= 0) {
      this.config.auxChains[chainIndex].isActive = isActive;
      saveMergeMiningConfig(this.config, this.configPath);
    }
  }
  
  /**
   * 全Auxチェーン情報を取得
   */
  async getAuxChains(): Promise<AuxChainInfo[]> {
    return this.adapter.getAuxChains();
  }
  
  /**
   * ジョブをマージマイニング対応に拡張
   * @param job 元のジョブ
   */
  async augmentJob(job: Job): Promise<Job> {
    if (!this.adapter.isActive()) {
      return job;
    }
    
    try {
      // マージマイニング情報を追加
      const augmentedJob = await this.adapter.augmentJobWithMergeMining(job, parseInt(job.id));
      return augmentedJob;
    } catch (error) {
      this.logger.error('Failed to augment job with merge mining data', error as Error);
      return job;
    }
  }
  
  /**
   * マージマイニングの統計情報を取得
   */
  async getStats(): Promise<any> {
    return this.adapter.getStats();
  }
  
  /**
   * リソースを解放
   */
  destroy(): void {
    this.adapter.destroy();
    this.removeAllListeners();
    this.logger.info('Stratum Merge Mining destroyed');
  }
}
