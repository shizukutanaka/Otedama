/**
 * DEX Integration Index - Otedama
 * DEX統合機能エクスポート
 */

// DEX統合マネージャー
export { DEXIntegrationManager } from '../financial/dex-integration-manager.js';
export { DEXConfigs, TokenAddresses } from '../financial/dex-integration-manager.js';

// 流動性プールマネージャー
export { LiquidityPoolManager } from './liquidity-pool-manager.js';
export { LiquidityPoolConfigs, PoolStrategies } from './liquidity-pool-manager.js';

// 統合DEXマネージャー
export class DEXManager {
  constructor(options = {}) {
    // DEX統合マネージャー
    this.dexIntegration = new DEXIntegrationManager({
      ...options,
      enabled: options.enableDEXIntegration !== false
    });
    
    // 流動性プールマネージャー
    this.liquidityPool = new LiquidityPoolManager({
      ...options,
      enabled: options.enableLiquidityPool !== false
    });
  }
  
  async initialize() {
    const results = await Promise.allSettled([
      this.dexIntegration.initialize(),
      this.liquidityPool.initialize()
    ]);
    
    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length > 0) {
      console.error('DEX初期化エラー:', failures);
    }
    
    return {
      dexIntegration: results[0].status === 'fulfilled',
      liquidityPool: results[1].status === 'fulfilled'
    };
  }
  
  /**
   * スワップ実行
   */
  async swap(tokenIn, tokenOut, amountIn, options = {}) {
    return this.dexIntegration.executeSwap(tokenIn, tokenOut, amountIn, options);
  }
  
  /**
   * 流動性追加
   */
  async addLiquidity(tokenA, tokenB, amountA, amountB, options = {}) {
    return this.liquidityPool.addLiquidity(tokenA, tokenB, amountA, amountB, options);
  }
  
  /**
   * 流動性除去
   */
  async removeLiquidity(positionId, percentage = 100, options = {}) {
    return this.liquidityPool.removeLiquidity(positionId, percentage, options);
  }
  
  /**
   * 最適スワップルート検索
   */
  async findBestRoute(tokenIn, tokenOut, amountIn) {
    return this.dexIntegration.findOptimalSwapRoute(tokenIn, tokenOut, amountIn);
  }
  
  /**
   * 流動性情報取得
   */
  async getLiquidityInfo(tokenA, tokenB) {
    return this.dexIntegration.getLiquidityInfo(tokenA, tokenB);
  }
  
  /**
   * 統計情報取得
   */
  getStatistics() {
    return {
      dex: this.dexIntegration.getStatus(),
      liquidity: this.liquidityPool.getStatistics()
    };
  }
  
  async shutdown() {
    await Promise.all([
      this.dexIntegration.shutdown(),
      this.liquidityPool.shutdown()
    ]);
  }
}

export default DEXManager;