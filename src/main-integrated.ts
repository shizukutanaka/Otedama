/**
 * Otedama - メイン統合システム エントリーポイント
 * 設計思想: John Carmack (効率性), Robert C. Martin (保守性), Rob Pike (シンプルさ)
 * 
 * 統合された軽量実装:
 * - ワンクリックセットアップ
 * - Stratum V2プロトコル  
 * - 最適化マイニングアルゴリズム
 * - リアルタイム収益計算
 * - 統合ハードウェア監視
 * - 軽量モバイルダッシュボード
 * - 100言語対応システム
 */

import { startOtedama, OtedamaSystemConfig } from './otedama-integrated-system';

// === 設定ファイル読み込み ===
function loadConfig(): Partial<OtedamaSystemConfig> {
  try {
    // 環境変数から設定を読み込み
    const config: Partial<OtedamaSystemConfig> = {
      network: {
        stratumPort: parseInt(process.env.STRATUM_PORT || '4444'),
        webPort: parseInt(process.env.WEB_PORT || '8080'),
        p2pPort: parseInt(process.env.P2P_PORT || '8333')
      },
      mining: {
        autoStart: process.env.AUTO_START === 'true',
        algorithms: (process.env.ALGORITHMS || 'randomx,kawpow,sha256d').split(','),
        profitSwitching: process.env.PROFIT_SWITCHING !== 'false',
        profitSwitchThreshold: parseFloat(process.env.PROFIT_THRESHOLD || '5')
      },
      hardware: {
        enabled: process.env.HARDWARE_MONITORING !== 'false',
        updateIntervalMs: parseInt(process.env.HARDWARE_INTERVAL || '3000'),
        temperatureThresholds: {
          cpu: {
            warn: parseInt(process.env.CPU_TEMP_WARN || '75'),
            critical: parseInt(process.env.CPU_TEMP_CRITICAL || '85'),
            emergency: parseInt(process.env.CPU_TEMP_EMERGENCY || '95')
          },
          gpu: {
            warn: parseInt(process.env.GPU_TEMP_WARN || '80'),
            critical: parseInt(process.env.GPU_TEMP_CRITICAL || '88'),
            emergency: parseInt(process.env.GPU_TEMP_EMERGENCY || '95')
          }
        },
        autoThrottle: process.env.AUTO_THROTTLE !== 'false',
        emergencyShutdown: process.env.EMERGENCY_SHUTDOWN !== 'false'
      },
      revenue: {
        enabled: process.env.REVENUE_CALCULATION !== 'false',
        electricityCostKwh: parseFloat(process.env.ELECTRICITY_COST || '0.12'),
        currency: process.env.CURRENCY || 'USD',
        updateIntervalMs: parseInt(process.env.REVENUE_INTERVAL || '30000')
      },
      ui: {
        language: process.env.LANGUAGE || 'en',
        theme: (process.env.THEME || 'auto') as 'light' | 'dark' | 'auto',
        enableMobile: process.env.MOBILE_DASHBOARD !== 'false',
        enableWebSocket: process.env.WEBSOCKET !== 'false'
      },
      advanced: {
        logLevel: (process.env.LOG_LEVEL || 'info') as 'error' | 'warn' | 'info' | 'debug',
        enableMetrics: process.env.METRICS !== 'false',
        enableAutoUpdate: process.env.AUTO_UPDATE === 'true'
      }
    };
    
    return config;
  } catch (error) {
    console.warn('設定読み込みエラー、デフォルト設定を使用:', error);
    return {};
  }
}

// === メイン実行関数 ===
async function main(): Promise<void> {
  try {
    console.log('🎯 Otedama - World\'s First True Zero-Fee P2P Mining Pool');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('⚡ 軽量統合システム起動中...');
    
    // 設定読み込み
    const config = loadConfig();
    console.log('📋 設定読み込み完了');
    
    // システム起動
    const system = await startOtedama(config);
    
    // システム情報表示
    const info = system.getSystemInfo();
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ Otedama Ready!');
    console.log(`📱 Mobile Dashboard: http://localhost:${config.network?.webPort || 8080}`);
    console.log(`⛏️ Stratum V2 Server: stratum+tcp://localhost:${config.network?.stratumPort || 4444}`);
    console.log(`🔗 P2P Network: p2p://localhost:${config.network?.p2pPort || 8333}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🚀 実装済み機能:');
    info.features.forEach((feature: string) => {
      console.log(`   ✓ ${feature}`);
    });
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    // グレースフルシャットダウン
    process.on('SIGINT', async () => {
      console.log('\n🛑 シャットダウンシグナル受信...');
      await system.stop();
      process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
      console.log('\n⏹️ 終了シグナル受信...');
      await system.stop();
      process.exit(0);
    });
    
    // 未処理エラー対応
    process.on('unhandledRejection', (reason, promise) => {
      console.error('未処理のPromise拒否:', reason);
    });
    
    process.on('uncaughtException', (error) => {
      console.error('未処理の例外:', error);
      process.exit(1);
    });
    
  } catch (error) {
    console.error('❌ システム起動失敗:', error);
    process.exit(1);
  }
}

// === CLI引数処理 ===
function parseArguments(): void {
  const args = process.argv.slice(2);
  
  args.forEach(arg => {
    switch (arg) {
      case '--help':
      case '-h':
        showHelp();
        process.exit(0);
        break;
      case '--version':
      case '-v':
        console.log('Otedama v1.0.0');
        process.exit(0);
        break;
      case '--setup-only':
        process.env.SETUP_ONLY = 'true';
        break;
      case '--no-web':
        process.env.MOBILE_DASHBOARD = 'false';
        break;
      case '--no-hardware':
        process.env.HARDWARE_MONITORING = 'false';
        break;
      case '--debug':
        process.env.LOG_LEVEL = 'debug';
        break;
    }
  });
}

function showHelp(): void {
  console.log(`
🎯 Otedama - Zero-Fee P2P Mining Pool

使用方法:
  npm start                  # 標準起動
  npm run start:quick        # クイック起動
  npm run setup             # セットアップのみ

オプション:
  --help, -h                ヘルプ表示
  --version, -v             バージョン表示
  --setup-only              セットアップのみ実行
  --no-web                  Webダッシュボード無効
  --no-hardware             ハードウェア監視無効
  --debug                   デバッグモード

環境変数:
  STRATUM_PORT=4444         Stratumサーバーポート
  WEB_PORT=8080             Webサーバーポート
  AUTO_START=false          マイニング自動開始
  LANGUAGE=en               言語設定
  ELECTRICITY_COST=0.12     電気代 ($/kWh)
  
詳細: https://github.com/shizukutanaka/Otedama
`);
}

// === 実行開始 ===
if (require.main === module) {
  parseArguments();
  main().catch(console.error);
}

export { main as startOtedamaMain };