/**
 * DeFi Integration Index - Otedama
 * DeFi統合機能エクスポート
 */

// マイニング報酬DeFi統合
export { MiningRewardsDeFiIntegration } from './mining-rewards-defi-integration.js';
export { DeFiStrategies, DeFiPlatforms } from './mining-rewards-defi-integration.js';

// 自動複利マネージャー
export { AutoCompoundManager } from './auto-compound-manager.js';
export { CompoundProtocols, CompoundStrategies } from './auto-compound-manager.js';

// クロスチェーンブリッジ統合
export { CrossChainBridgeIntegration } from './cross-chain-bridge-integration.js';
export { BridgeProtocols, ChainConfigs, BridgeStrategies } from './cross-chain-bridge-integration.js';

// 統合DeFiマネージャー
export class DeFiIntegrationManager {
  constructor(options = {}) {
    // マイニング報酬DeFi統合
    this.miningRewardsDeFi = new MiningRewardsDeFiIntegration({
      ...options,
      enabled: options.enableMiningRewardsDeFi !== false
    });
    
    // 自動複利マネージャー
    this.autoCompound = new AutoCompoundManager({
      ...options,
      enabled: options.enableAutoCompound !== false
    });
    
    // クロスチェーンブリッジ
    this.crossChainBridge = new CrossChainBridgeIntegration({
      ...options,
      enabled: options.enableCrossChainBridge !== false
    });
  }
  
  async initialize() {
    const results = await Promise.allSettled([
      this.miningRewardsDeFi.initialize(),
      this.autoCompound.initialize(),
      this.crossChainBridge.initialize()
    ]);
    
    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length > 0) {
      console.error('DeFi初期化エラー:', failures);
    }
    
    return {
      miningRewardsDeFi: results[0].status === 'fulfilled',
      autoCompound: results[1].status === 'fulfilled',
      crossChainBridge: results[2].status === 'fulfilled'
    };
  }
  
  async shutdown() {
    await Promise.all([
      this.miningRewardsDeFi.shutdown(),
      this.autoCompound.shutdown(),
      this.crossChainBridge.shutdown()
    ]);
  }
}

export default DeFiIntegrationManager;