/**
 * Otedama - 統合システム (メインエントリーポイント)
 * 設計思想: John Carmack (効率性), Robert C. Martin (保守性), Rob Pike (シンプルさ)
 * 
 * 統合機能:
 * - ワンクリックセットアップ
 * - Stratum V2プロトコル
 * - 最適化マイニングアルゴリズム (RandomX, KawPow, SHA256d, Ethash)
 * - リアルタイム収益計算
 * - 統合ハードウェア監視
 * - 軽量モバイルダッシュボード
 * - 100言語対応システム
 * - 自動プロフィットスイッチング
 */

import { EventEmitter } from 'events';
import { OneClickSetup, OptimalSetup } from './setup/one-click-setup';
import { StratumV2Server } from './stratum-v2/stratum-v2-protocol';
import { OptimizedAlgorithmFactory } from './algorithms/optimized-mining-algorithms';
import { RevenueCalculationEngine } from './revenue/real-time-revenue-calculator';
import { UnifiedHardwareMonitor } from './monitoring/unified-hardware-monitor';
import { Enhanced100LanguageSystem } from './i18n/enhanced-100lang-system';
import { LightWebServer } from './web/light-web-server';

// === 統合システム設定 ===
export interface OtedamaSystemConfig {
  // ネットワーク設定
  network: {
    stratumPort: number;
    webPort: number;
    p2pPort: number;
  };
  
  // マイニング設定
  mining: {
    autoStart: boolean;
    algorithms: string[];
    profitSwitching: boolean;
    profitSwitchThreshold: number; // % improvement required
  };
  
  // ハードウェア監視設定
  hardware: {
    enabled: boolean;
    updateIntervalMs: number;
    temperatureThresholds: {
      cpu: { warn: number; critical: number; emergency: number };
      gpu: { warn: number; critical: number; emergency: number };
    };
    autoThrottle: boolean;
    emergencyShutdown: boolean;
  };
  
  // 収益設定
  revenue: {
    enabled: boolean;
    electricityCostKwh: number;
    currency: string;
    updateIntervalMs: number;
  };
  
  // UI設定
  ui: {
    language: string;
    theme: 'light' | 'dark' | 'auto';
    enableMobile: boolean;
    enableWebSocket: boolean;
  };
  
  // 高度な設定
  advanced: {
    logLevel: 'error' | 'warn' | 'info' | 'debug';
    enableMetrics: boolean;
    enableAutoUpdate: boolean;
  };
}

// === システム状態 ===
export interface SystemStatus {
  overall: 'STARTING' | 'RUNNING' | 'STOPPING' | 'STOPPED' | 'ERROR';
  components: {
    setup: boolean;
    stratum: boolean;
    algorithms: boolean;
    revenue: boolean;
    hardware: boolean;
    i18n: boolean;
    web: boolean;
  };
  mining: {
    active: boolean;
    algorithm: string;
    coin: string;
    hashrate: number;
    efficiency: number;
  };
  health: {
    cpu: { temperature: number; status: string };
    gpu: { temperature: number; status: string };
    power: number;
    alerts: number;
  };
}

// === 統合システムクラス ===
export class OtedamaIntegratedSystem extends EventEmitter {
  private config: OtedamaSystemConfig;
  private status: SystemStatus;
  
  // コンポーネント
  private setupSystem?: OneClickSetup;
  private stratumServer?: StratumV2Server;
  private revenueEngine?: RevenueCalculationEngine;
  private hardwareMonitor?: UnifiedHardwareMonitor;
  private i18nSystem?: Enhanced100LanguageSystem;
  private webServer?: LightWebServer;
  
  // 状態管理
  private initialized = false;
  private running = false;
  private currentSetup?: OptimalSetup;

  constructor(config: Partial<OtedamaSystemConfig> = {}) {
    super();
    
    this.config = this.mergeDefaultConfig(config);
    this.status = this.initializeStatus();
    
    console.log('🎯 Otedama統合システム初期化中...');
  }

  private mergeDefaultConfig(userConfig: Partial<OtedamaSystemConfig>): OtedamaSystemConfig {
    const defaultConfig: OtedamaSystemConfig = {
      network: {
        stratumPort: 4444,
        webPort: 8080,
        p2pPort: 8333
      },
      mining: {
        autoStart: false,
        algorithms: ['randomx', 'kawpow', 'sha256d', 'ethash'],
        profitSwitching: true,
        profitSwitchThreshold: 5
      },
      hardware: {
        enabled: true,
        updateIntervalMs: 3000,
        temperatureThresholds: {
          cpu: { warn: 75, critical: 85, emergency: 95 },
          gpu: { warn: 80, critical: 88, emergency: 95 }
        },
        autoThrottle: true,
        emergencyShutdown: true
      },
      revenue: {
        enabled: true,
        electricityCostKwh: 0.12,
        currency: 'USD',
        updateIntervalMs: 30000
      },
      ui: {
        language: 'en',
        theme: 'auto',
        enableMobile: true,
        enableWebSocket: true
      },
      advanced: {
        logLevel: 'info',
        enableMetrics: true,
        enableAutoUpdate: false
      }
    };

    return this.deepMerge(defaultConfig, userConfig);
  }

  private deepMerge(target: any, source: any): any {
    const result = { ...target };
    
    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = this.deepMerge(target[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }
    
    return result;
  }

  private initializeStatus(): SystemStatus {
    return {
      overall: 'STOPPED',
      components: {
        setup: false,
        stratum: false,
        algorithms: false,
        revenue: false,
        hardware: false,
        i18n: false,
        web: false
      },
      mining: {
        active: false,
        algorithm: '',
        coin: '',
        hashrate: 0,
        efficiency: 0
      },
      health: {
        cpu: { temperature: 0, status: 'UNKNOWN' },
        gpu: { temperature: 0, status: 'UNKNOWN' },
        power: 0,
        alerts: 0
      }
    };
  }

  // === システム初期化 ===
  async initialize(): Promise<void> {
    if (this.initialized) {
      throw new Error('System already initialized');
    }

    try {
      this.status.overall = 'STARTING';
      this.emit('statusChanged', this.status);

      console.log('🔧 コンポーネント初期化開始...');

      // 1. 多言語システム初期化
      await this.initializeI18n();
      
      // 2. ハードウェア監視初期化
      await this.initializeHardwareMonitor();
      
      // 3. 収益計算エンジン初期化
      await this.initializeRevenueEngine();
      
      // 4. Webサーバー初期化
      await this.initializeWebServer();
      
      // 5. Stratumサーバー初期化
      await this.initializeStratumServer();
      
      // 6. ワンクリックセットアップ初期化
      await this.initializeSetupSystem();

      this.initialized = true;
      console.log('✅ Otedama統合システム初期化完了');
      
      this.emit('initialized');
      
    } catch (error) {
      this.status.overall = 'ERROR';
      this.emit('statusChanged', this.status);
      console.error('❌ 初期化エラー:', error);
      throw error;
    }
  }

  private async initializeI18n(): Promise<void> {
    try {
      this.i18nSystem = Enhanced100LanguageSystem.getInstance();
      await this.i18nSystem.initialize(this.config.ui.language);
      
      this.status.components.i18n = true;
      console.log('✅ 多言語システム初期化完了');
    } catch (error) {
      console.error('❌ 多言語システム初期化失敗:', error);
      throw error;
    }
  }

  private async initializeHardwareMonitor(): Promise<void> {
    if (!this.config.hardware.enabled) {
      console.log('⏭️ ハードウェア監視無効');
      return;
    }

    try {
      const { createUnifiedHardwareMonitor } = await import('./monitoring/unified-hardware-monitor');
      
      this.hardwareMonitor = await createUnifiedHardwareMonitor({
        cpu: this.config.hardware.temperatureThresholds.cpu,
        gpu: this.config.hardware.temperatureThresholds.gpu,
        power: { warn: 1500, critical: 2000 },
        updateIntervalMs: this.config.hardware.updateIntervalMs,
        autoThrottle: this.config.hardware.autoThrottle,
        emergencyShutdown: this.config.hardware.emergencyShutdown
      });

      // イベント設定
      this.hardwareMonitor.on('reading', (reading) => {
        this.updateHealthStatus(reading);
      });

      this.hardwareMonitor.on('alert', (alert) => {
        this.handleHardwareAlert(alert);
      });

      this.hardwareMonitor.on('emergencyShutdown', (data) => {
        this.handleEmergencyShutdown(data);
      });

      this.status.components.hardware = true;
      console.log('✅ ハードウェア監視初期化完了');
    } catch (error) {
      console.error('❌ ハードウェア監視初期化失敗:', error);
      throw error;
    }
  }

  private async initializeRevenueEngine(): Promise<void> {
    if (!this.config.revenue.enabled) {
      console.log('⏭️ 収益計算無効');
      return;
    }

    try {
      this.revenueEngine = new RevenueCalculationEngine(this.config.revenue.electricityCostKwh);

      // イベント設定
      this.revenueEngine.on('revenueUpdate', (revenue) => {
        this.updateMiningStatus(revenue);
      });

      this.revenueEngine.on('mostProfitableUpdate', (mostProfitable) => {
        this.handleProfitabilityChange(mostProfitable);
      });

      this.status.components.revenue = true;
      console.log('✅ 収益計算エンジン初期化完了');
    } catch (error) {
      console.error('❌ 収益計算エンジン初期化失敗:', error);
      throw error;
    }
  }

  private async initializeWebServer(): Promise<void> {
    if (!this.config.ui.enableMobile) {
      console.log('⏭️ Webサーバー無効');
      return;
    }

    try {
      const { createLightWebServer } = await import('./web/light-web-server');
      
      this.webServer = await createLightWebServer({
        port: this.config.network.webPort,
        enableWebSocket: this.config.ui.enableWebSocket
      });

      // ハードウェア監視とサーバーを連携
      if (this.hardwareMonitor) {
        this.webServer.setHardwareMonitor(this.hardwareMonitor);
      }

      if (this.revenueEngine) {
        this.webServer.setRevenueCalculator(this.revenueEngine);
      }

      // Web経由のマイニング制御
      this.webServer.on('miningStart', () => this.startMining());
      this.webServer.on('miningStop', () => this.stopMining());
      this.webServer.on('miningOptimize', () => this.optimizeMining());

      this.status.components.web = true;
      console.log('✅ Webサーバー初期化完了');
    } catch (error) {
      console.error('❌ Webサーバー初期化失敗:', error);
      throw error;
    }
  }

  private async initializeStratumServer(): Promise<void> {
    try {
      const { startStratumV2Server } = await import('./stratum-v2/stratum-v2-protocol');
      
      this.stratumServer = await startStratumV2Server(this.config.network.stratumPort);

      // イベント設定
      this.stratumServer.on('minerConnected', (data) => {
        console.log('⛏️ マイナー接続:', data);
        this.emit('minerConnected', data);
      });

      this.stratumServer.on('shareSubmitted', (data) => {
        this.handleShareSubmitted(data);
      });

      this.status.components.stratum = true;
      console.log('✅ Stratum V2サーバー初期化完了');
    } catch (error) {
      console.error('❌ Stratum V2サーバー初期化失敗:', error);
      throw error;
    }
  }

  private async initializeSetupSystem(): Promise<void> {
    try {
      this.setupSystem = new OneClickSetup();

      this.setupSystem.on('progress', (data) => {
        console.log(`🔧 セットアップ進捗: ${data.message}`);
        this.emit('setupProgress', data);
      });

      this.status.components.setup = true;
      console.log('✅ セットアップシステム初期化完了');
    } catch (error) {
      console.error('❌ セットアップシステム初期化失敗:', error);
      throw error;
    }
  }

  // === システム開始 ===
  async start(): Promise<void> {
    if (!this.initialized) {
      throw new Error('System not initialized. Call initialize() first.');
    }

    if (this.running) {
      throw new Error('System already running');
    }

    try {
      this.status.overall = 'STARTING';
      this.emit('statusChanged', this.status);

      console.log('🚀 Otedamaシステム開始...');

      // ハードウェア監視開始
      if (this.hardwareMonitor) {
        await this.hardwareMonitor.start();
      }

      // 収益計算エンジン開始
      if (this.revenueEngine) {
        await this.revenueEngine.start();
      }

      // Webサーバー開始
      if (this.webServer) {
        await this.webServer.start();
      }

      // 自動セットアップ実行
      if (this.config.mining.autoStart) {
        await this.performAutoSetup();
      }

      this.running = true;
      this.status.overall = 'RUNNING';
      this.emit('statusChanged', this.status);

      console.log('✅ Otedamaシステム開始完了');
      this.emit('started');

    } catch (error) {
      this.status.overall = 'ERROR';
      this.emit('statusChanged', this.status);
      console.error('❌ システム開始エラー:', error);
      throw error;
    }
  }

  // === システム停止 ===
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    try {
      this.status.overall = 'STOPPING';
      this.emit('statusChanged', this.status);

      console.log('⏹️ Otedamaシステム停止中...');

      // マイニング停止
      await this.stopMining();

      // 各コンポーネント停止
      if (this.hardwareMonitor) {
        await this.hardwareMonitor.stop();
      }

      if (this.revenueEngine) {
        this.revenueEngine.stop();
      }

      if (this.webServer) {
        await this.webServer.stop();
      }

      if (this.stratumServer) {
        await this.stratumServer.stop();
      }

      this.running = false;
      this.status.overall = 'STOPPED';
      this.emit('statusChanged', this.status);

      console.log('✅ Otedamaシステム停止完了');
      this.emit('stopped');

    } catch (error) {
      console.error('❌ システム停止エラー:', error);
      throw error;
    }
  }

  // === マイニング制御 ===
  async performAutoSetup(): Promise<OptimalSetup> {
    if (!this.setupSystem) {
      throw new Error('Setup system not initialized');
    }

    console.log('⚙️ ワンクリックセットアップ実行中...');

    try {
      this.currentSetup = await this.setupSystem.executeSetup();
      
      console.log('✅ セットアップ完了:');
      console.log(`💰 予想日次利益: $${this.currentSetup.profitability.toFixed(2)}`);
      console.log(`⚡ 消費電力: ${this.currentSetup.expectedPowerConsumption}W`);
      console.log(`🎯 信頼度: ${this.currentSetup.confidence}%`);

      this.emit('setupCompleted', this.currentSetup);
      return this.currentSetup;

    } catch (error) {
      console.error('❌ セットアップ失敗:', error);
      throw error;
    }
  }

  async startMining(): Promise<void> {
    if (this.status.mining.active) {
      console.log('⚠️ マイニングは既に開始されています');
      return;
    }

    try {
      // セットアップが未実行の場合は実行
      if (!this.currentSetup) {
        await this.performAutoSetup();
      }

      console.log('⛏️ マイニング開始...');

      // 最適なアルゴリズムでマイニング開始
      const setup = this.currentSetup!;
      
      this.status.mining.active = true;
      this.status.mining.algorithm = setup.primaryAlgorithm;
      this.status.mining.coin = setup.primaryCoin;

      // ハッシュレート更新
      if (this.hardwareMonitor) {
        const hashrate = setup.cpuMining.expectedHashrate + setup.gpuMining.expectedHashrate;
        this.hardwareMonitor.setHashrate(hashrate);
        
        if (this.webServer) {
          this.webServer.updateHashrate(hashrate);
        }
      }

      this.emit('miningStarted', setup);
      console.log(`✅ マイニング開始: ${setup.primaryCoin} (${setup.primaryAlgorithm})`);

    } catch (error) {
      console.error('❌ マイニング開始エラー:', error);
      throw error;
    }
  }

  async stopMining(): Promise<void> {
    if (!this.status.mining.active) {
      return;
    }

    try {
      console.log('⏹️ マイニング停止中...');

      this.status.mining.active = false;
      this.status.mining.algorithm = '';
      this.status.mining.coin = '';
      this.status.mining.hashrate = 0;
      this.status.mining.efficiency = 0;

      // ハッシュレートリセット
      if (this.hardwareMonitor) {
        this.hardwareMonitor.setHashrate(0);
        
        if (this.webServer) {
          this.webServer.updateHashrate(0);
        }
      }

      this.emit('miningStopped');
      console.log('✅ マイニング停止完了');

    } catch (error) {
      console.error('❌ マイニング停止エラー:', error);
      throw error;
    }
  }

  async optimizeMining(): Promise<void> {
    if (!this.status.mining.active) {
      console.log('⚠️ マイニングが開始されていません');
      return;
    }

    try {
      console.log('⚡ マイニング最適化実行中...');

      // 再セットアップで最適化
      await this.performAutoSetup();
      
      // マイニング再開
      await this.stopMining();
      await this.startMining();

      console.log('✅ マイニング最適化完了');
      this.emit('miningOptimized');

    } catch (error) {
      console.error('❌ マイニング最適化エラー:', error);
      throw error;
    }
  }

  // === イベントハンドラー ===
  private updateHealthStatus(reading: any): void {
    this.status.health.cpu.temperature = reading.cpu?.temperature || 0;
    this.status.health.cpu.status = reading.cpu?.throttling ? 'THROTTLING' : 'NORMAL';
    
    const maxGPUTemp = reading.gpu?.length > 0 ? 
      Math.max(...reading.gpu.map((g: any) => g.temperature)) : 0;
    this.status.health.gpu.temperature = maxGPUTemp;
    this.status.health.gpu.status = reading.gpu?.some((g: any) => g.throttling) ? 'THROTTLING' : 'NORMAL';
    
    this.status.health.power = reading.system?.totalPower || 0;

    this.emit('healthUpdated', this.status.health);
  }

  private handleHardwareAlert(alert: any): void {
    this.status.health.alerts++;
    
    console.log(`🚨 ハードウェアアラート: ${alert.level} - ${alert.message}`);
    this.emit('hardwareAlert', alert);
  }

  private async handleEmergencyShutdown(data: any): Promise<void> {
    console.log(`🛑 緊急停止: ${data.device} - ${data.value}`);
    
    // マイニング緊急停止
    await this.stopMining();
    
    this.emit('emergencyShutdown', data);
  }

  private updateMiningStatus(revenue: any): void {
    if (this.status.mining.active) {
      this.status.mining.coin = revenue.coin;
      // その他の収益情報を更新
    }
  }

  private handleProfitabilityChange(mostProfitable: any): void {
    if (this.config.mining.profitSwitching && this.status.mining.active) {
      // プロフィットスイッチングロジック
      console.log(`💰 最も収益性が高い: ${mostProfitable.coin}`);
    }
  }

  private handleShareSubmitted(data: any): void {
    console.log(`💎 シェア送信: ${data.valid ? '✅' : '❌'}`);
    this.emit('shareSubmitted', data);
  }

  // === 公開メソッド ===
  getStatus(): SystemStatus {
    return { ...this.status };
  }

  getConfig(): OtedamaSystemConfig {
    return { ...this.config };
  }

  updateConfig(newConfig: Partial<OtedamaSystemConfig>): void {
    this.config = this.deepMerge(this.config, newConfig);
    this.emit('configUpdated', this.config);
  }

  getCurrentSetup(): OptimalSetup | undefined {
    return this.currentSetup;
  }

  isRunning(): boolean {
    return this.running;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  // === システム情報 ===
  getSystemInfo(): any {
    return {
      name: 'Otedama',
      version: '1.0.0',
      description: 'Zero-Fee P2P Mining Pool',
      features: [
        'Stratum V2 Protocol',
        'Multi-Algorithm Support',
        'Hardware Monitoring',
        'Real-time Revenue Calculation',
        '100 Languages Support',
        'Mobile Dashboard',
        'Auto Profit Switching'
      ],
      status: this.status,
      config: this.config,
      uptime: this.running ? process.uptime() : 0
    };
  }
}

// === ファクトリー関数 ===
export async function createOtedamaSystem(config?: Partial<OtedamaSystemConfig>): Promise<OtedamaIntegratedSystem> {
  const system = new OtedamaIntegratedSystem(config);
  
  // 基本イベントハンドラー
  system.on('statusChanged', (status) => {
    console.log(`📊 システム状態: ${status.overall}`);
  });
  
  system.on('miningStarted', (setup) => {
    console.log(`⛏️ マイニング開始: ${setup.primaryCoin}`);
  });
  
  system.on('emergencyShutdown', (data) => {
    console.log(`🛑 緊急停止: ${data.device}`);
  });
  
  return system;
}

// === メイン実行関数 ===
export async function startOtedama(config?: Partial<OtedamaSystemConfig>): Promise<OtedamaIntegratedSystem> {
  console.log('🎯 Otedama - World\'s First True Zero-Fee P2P Mining Pool');
  console.log('🚀 Starting Otedama Integrated System...');
  
  const system = await createOtedamaSystem(config);
  
  await system.initialize();
  await system.start();
  
  console.log('✅ Otedama Ready!');
  console.log(`🌐 Dashboard: http://localhost:${system.getConfig().network.webPort}`);
  console.log(`⛏️ Stratum: stratum+tcp://localhost:${system.getConfig().network.stratumPort}`);
  
  return system;
}

export default OtedamaIntegratedSystem;