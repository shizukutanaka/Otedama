/**
 * Otedama - 統合エントリーポイント v2.1.0
 * 設計思想: John Carmack (実用的・高性能), Robert C. Martin (クリーン・保守性), Rob Pike (シンプル・効率的)
 * 
 * すべての機能を統合したメインエントリーポイント
 * 重複なし・効率的・実用的な単一システム
 */

// === メイン統合アプリケーション ===
export { OtedamaMainApplication as default, createOtedamaApp, startOtedama } from './main-unified';
export type { OtedamaConfig, OtedamaSystemStatus } from './main-unified';

// === 最高優先度機能 ===
export { AlgorithmFactory, MultiAlgorithmMiner, ProfitSwitcher } from './algorithms/mining-algorithms';
export { StratumV2Server } from './stratum-v2/stratum-v2-protocol';
export { OneClickSetup, performOneClickSetup } from './setup/one-click-setup';
export { RevenueCalculationEngine, AutoProfitSwitcher } from './revenue/real-time-revenue-calculator';

// === 高優先度機能 ===
export { HardwareMonitoringSystem, createHardwareMonitoringSystem } from './monitoring/hardware-monitoring';

// === 中優先度機能 ===
export { AIOptimizationEngine, startAIOptimization } from './ai/optimization-engine';
export { SecurityManager, initializeSecurity } from './security/security-manager';
export { MultiPoolManager, startMultiPoolMining } from './pool/multi-pool-manager';
export { Enhanced100LanguageSystem, initI18n, t, setLanguage, formatCurrency, formatNumber, formatDate } from './i18n/enhanced-100lang-system';

// === 便利な統合関数 ===

/**
 * 完全なOtedamaシステムを即座に開始
 * ワンクリックで全機能を利用可能
 */
export async function quickStart(options: {
  language?: string;
  autoSetup?: boolean;
  electricityCost?: number;
  algorithms?: string[];
} = {}) {
  const { startOtedama } = await import('./main-unified');
  
  return await startOtedama({
    app: {
      name: 'Otedama',
      version: '2.1.0',
      autoStart: options.autoSetup ?? true,
      language: options.language ?? 'en',
      debug: false
    },
    mining: {
      algorithms: options.algorithms ?? ['randomx', 'kawpow', 'ethash'],
      autoSwitch: true,
      safetyMode: true
    },
    revenue: {
      electricityCost: options.electricityCost ?? 0.12,
      profitSwitching: true
    },
    hardware: {
      monitoring: true,
      thermalProtection: true
    }
  });
}

/**
 * デモ・テスト用の軽量起動
 */
export async function demoStart() {
  const { startOtedama } = await import('./main-unified');
  
  return await startOtedama({
    app: {
      name: 'Otedama Demo',
      version: '2.1.0',
      autoStart: false,
      language: 'en',
      debug: true
    },
    mining: {
      algorithms: ['randomx'],
      autoSwitch: false,
      safetyMode: true
    },
    hardware: {
      monitoring: false
    },
    ui: {
      dashboard: true,
      webPort: 3334
    }
  });
}

console.log('🌟 Otedama v2.1.0 - World\'s First True Zero-Fee Mining Pool');
console.log('🚀 Features: Stratum V2, AI Optimization, 100 Languages, Zero Fees');
console.log('📚 Usage: import { quickStart } from \'./index\'; await quickStart();');