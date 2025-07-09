#!/usr/bin/env node

/**
 * Otedama Next-Gen機能デモ
 * 設計思想: John Carmack (実用的), Robert C. Martin (保守性), Rob Pike (シンプル)
 * 
 * このデモでは以下の新機能をテストできます:
 * - ワンクリック自動セットアップ
 * - リアルタイム収益計算
 * - ハードウェア監視
 * - Stratum V2プロトコル
 */

import { performOneClickSetup } from './setup/one-click-setup';
import { createProfitabilitySystem, HardwareProfile } from './profitability/realtime-profitability';
import { createHardwareMonitoringSystem } from './monitoring/hardware-monitoring';
import { StratumV2Server } from './stratum-v2/stratum-v2-protocol';

// === デモ用ロガー ===
class DemoLogger {
  private step = 1;

  logStep(title: string): void {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📊 STEP ${this.step}: ${title}`);
    console.log('='.repeat(60));
    this.step++;
  }

  success(message: string, data?: any): void {
    console.log(`✅ ${message}`, data ? JSON.stringify(data, null, 2) : '');
  }

  info(message: string, data?: any): void {
    console.log(`ℹ️  ${message}`, data ? JSON.stringify(data, null, 2) : '');
  }

  warn(message: string, data?: any): void {
    console.log(`⚠️  ${message}`, data ? JSON.stringify(data, null, 2) : '');
  }

  error(message: string, error?: any): void {
    console.log(`❌ ${message}`, error?.message || error || '');
  }

  feature(message: string): void {
    console.log(`🚀 ${message}`);
  }
}

// === ワンクリックセットアップデモ ===
async function demoAutoSetup(logger: DemoLogger): Promise<any> {
  logger.logStep('ワンクリック自動セットアップデモ');
  
  try {
    logger.info('ハードウェア検出と最適設定計算を開始します...');
    
    const setup = await performOneClickSetup();
    
    logger.success('自動セットアップ完了!');
    logger.info(`予想日次収益: $${setup.profitability.toFixed(2)}`);
    logger.info(`電力消費: ${setup.expectedPowerConsumption}W`);
    logger.info(`設定信頼度: ${setup.confidence}%`);
    
    if (setup.cpuMining.enabled) {
      logger.feature(`CPU推奨: ${setup.cpuMining.coin} (${setup.cpuMining.algorithm}) - ${setup.cpuMining.threads}スレッド`);
      logger.info(`CPU予想収益: $${setup.cpuMining.expectedRevenue.toFixed(2)}/day`);
    }
    
    if (setup.gpuMining.enabled) {
      logger.feature(`GPU推奨: ${setup.gpuMining.coin} (${setup.gpuMining.algorithm}) - ${setup.gpuMining.cards}カード`);
      logger.info(`GPU予想収益: $${setup.gpuMining.expectedRevenue.toFixed(2)}/day`);
    }
    
    if (setup.recommendations.length > 0) {
      logger.info('推奨事項:');
      setup.recommendations.forEach((rec: string) => {
        logger.info(`  • ${rec}`);
      });
    }
    
    if (setup.warnings.length > 0) {
      logger.warn('警告事項:');
      setup.warnings.forEach((warn: string) => {
        logger.warn(`  • ${warn}`);
      });
    }
    
    return setup;
    
  } catch (error) {
    logger.error('自動セットアップ失敗:', error);
    return null;
  }
}

// === リアルタイム収益計算デモ ===
async function demoProfitabilitySystem(logger: DemoLogger, setup?: any): Promise<any> {
  logger.logStep('リアルタイム収益計算・自動プロフィットスイッチングデモ');
  
  try {
    // サンプルハードウェアプロファイル作成
    const hardwareProfile: HardwareProfile = {
      type: 'GPU',
      name: 'Demo GPU',
      algorithms: {
        'randomx': { hashrate: 15000, power: 95, efficiency: 157 },
        'kawpow': { hashrate: 25000000, power: 220, efficiency: 113636 },
        'ethash': { hashrate: 60000000, power: 220, efficiency: 272727 },
        'sha256d': { hashrate: 500000, power: 95, efficiency: 5263 }
      },
      electricityCost: 0.12
    };
    
    logger.info('リアルタイム収益システムを開始中...');
    
    const profitSystem = await createProfitabilitySystem(hardwareProfile);
    
    // イベントリスナー設定
    profitSystem.on('coinSwitched', (data) => {
      logger.feature(`プロフィット切り替え: ${data.fromCoin} → ${data.toCoin}`);
      logger.success(`期待収益増加: +$${data.expectedProfit.toFixed(2)}/day`);
    });
    
    profitSystem.on('marketDataUpdated', (data) => {
      logger.info(`市場データ更新: ${data.symbol} = $${data.data.price.toFixed(4)}`);
    });
    
    // 収益性スナップショット取得
    logger.info('現在の収益性データを取得中...');
    
    await new Promise(resolve => setTimeout(resolve, 3000)); // 市場データ取得待ち
    
    const snapshot = await profitSystem.getProfitabilitySnapshot();
    
    if (snapshot.length > 0) {
      logger.success('収益性ランキング (上位5位):');
      snapshot.slice(0, 5).forEach((data, index) => {
        logger.info(`${index + 1}. ${data.coin} (${data.algorithm}): $${data.netProfit.toFixed(2)}/day (${data.profitMargin.toFixed(1)}%利益率)`);
      });
    }
    
    // 自動プロフィットスイッチング有効化
    logger.info('自動プロフィットスイッチングを有効化...');
    profitSystem.enableAutoSwitching('conservative');
    
    logger.success('リアルタイム収益システム稼働中 (デモは30秒後に終了)');
    
    // 30秒間動作を監視
    await new Promise(resolve => setTimeout(resolve, 30000));
    
    const stats = profitSystem.getSystemStats();
    logger.info('システム統計:', {
      運行状態: stats.running,
      利用可能通貨数: stats.marketData.availableCoins.length,
      自動切り替え有効: stats.autoSwitcher.enabled,
      現在の通貨: stats.autoSwitcher.currentCoin,
      今日の切り替え回数: stats.autoSwitcher.switchesToday
    });
    
    profitSystem.stop();
    
    return profitSystem;
    
  } catch (error) {
    logger.error('収益システムデモ失敗:', error);
    return null;
  }
}

// === ハードウェア監視デモ ===
async function demoHardwareMonitoring(logger: DemoLogger): Promise<any> {
  logger.logStep('ハードウェア監視・温度保護デモ');
  
  try {
    logger.info('ハードウェア監視システムを開始中...');
    
    const hwMonitoring = await createHardwareMonitoringSystem();
    
    // イベントリスナー設定
    hwMonitoring.on('alert', (alert) => {
      if (alert.level === 'EMERGENCY') {
        logger.error(`緊急アラート: ${alert.device} - ${alert.message}`);
      } else if (alert.level === 'CRITICAL') {
        logger.warn(`重要アラート: ${alert.device} - ${alert.message}`);
      } else {
        logger.info(`アラート: ${alert.device} - ${alert.message}`);
      }
    });
    
    hwMonitoring.on('emergencyShutdown', (data) => {
      logger.error(`🛑 緊急シャットダウン発動: ${data.device} (${data.triggerValue})`);
    });
    
    hwMonitoring.on('throttleRequested', (data) => {
      logger.warn(`🐌 スロットリング要求: ${data.device} を ${data.percentage}% に制限`);
    });
    
    hwMonitoring.on('thermalReading', (reading) => {
      if (reading.temperature > 70) {
        logger.warn(`高温検出: ${reading.device} ${reading.temperature}°C`);
      }
    });
    
    hwMonitoring.on('powerReading', (reading) => {
      if (reading.current > reading.limit * 0.9) {
        logger.warn(`高電力消費: ${reading.device} ${reading.current}W / ${reading.limit}W`);
      }
    });
    
    hwMonitoring.start();
    
    logger.success('ハードウェア監視開始 (30秒間データ収集)');
    
    // 30秒間監視
    await new Promise(resolve => setTimeout(resolve, 30000));
    
    // システム状態取得
    const status = hwMonitoring.getSystemStatus();
    logger.info('監視システム状態:', {
      監視中: status.running,
      アクティブモニター数: status.monitorsActive,
      総アラート数: status.alerts.total,
      最近のアラート数: status.alerts.recent,
      未確認アラート数: status.alerts.unacknowledged,
      重要アラート数: status.alerts.critical
    });
    
    // 最近のアラート表示
    const recentAlerts = hwMonitoring.getAlerts(5);
    if (recentAlerts.length > 0) {
      logger.info('最近のアラート:');
      recentAlerts.forEach((alert, index) => {
        const time = new Date(alert.timestamp).toLocaleTimeString();
        logger.info(`${index + 1}. [${time}] ${alert.level}: ${alert.message}`);
      });
    } else {
      logger.success('アラートは発生していません - システム正常');
    }
    
    hwMonitoring.stop();
    
    return hwMonitoring;
    
  } catch (error) {
    logger.error('ハードウェア監視デモ失敗:', error);
    return null;
  }
}

// === Stratum V2デモ ===
async function demoStratumV2(logger: DemoLogger): Promise<any> {
  logger.logStep('Stratum V2プロトコルデモ');
  
  try {
    logger.info('Stratum V2サーバーを開始中...');
    
    const v2Server = new StratumV2Server(5555, logger);
    
    // イベントリスナー設定
    v2Server.on('minerConnected', (data) => {
      logger.success(`V2マイナー接続: ${data.payoutAddress} (${data.workerName})`);
    });
    
    v2Server.on('shareSubmitted', (data) => {
      if (data.valid) {
        logger.info(`V2有効シェア: セッション${data.sessionId.slice(-8)} ジョブ${data.jobId}`);
      }
    });
    
    await v2Server.start();
    
    logger.success('Stratum V2サーバー稼働中 (ポート5555)');
    logger.info('特徴:');
    logger.info('  • バイナリプロトコル (95% 帯域削減)');
    logger.info('  • End-to-End暗号化 (NOISE Protocol)');
    logger.info('  • ハッシュレートハイジャック防止');
    logger.info('  • マイナーによるトランザクション選択');
    
    // デモジョブブロードキャスト
    logger.info('デモジョブをブロードキャスト中...');
    
    const demoJob = {
      id: 12345,
      prevHash: '0'.repeat(64),
      merkleRoot: '1'.repeat(64),
      timestamp: Math.floor(Date.now() / 1000),
      bits: 0x1d00ffff,
      cleanJobs: true
    };
    
    await v2Server.broadcastNewJob(demoJob);
    
    // 統計取得
    const v2Stats = v2Server.getStats();
    logger.info('V2サーバー統計:', {
      総セッション数: v2Stats.totalSessions,
      アクティブセッション数: v2Stats.activeSessions,
      認証済みセッション数: v2Stats.authenticatedSessions,
      プロトコルバージョン: v2Stats.protocolVersion,
      機能: v2Stats.features
    });
    
    logger.success('Stratum V2デモ完了 (10秒後にサーバー停止)');
    
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    await v2Server.stop();
    
    return v2Server;
    
  } catch (error) {
    logger.error('Stratum V2デモ失敗:', error);
    return null;
  }
}

// === メインデモ実行 ===
async function runFullDemo(): Promise<void> {
  const logger = new DemoLogger();
  
  console.log('🎉 OTEDAMA NEXT-GEN FEATURES DEMO 🎉');
  console.log('このデモでは最新の4つの主要機能をテストします\n');
  
  try {
    // 1. ワンクリック自動セットアップ
    const setupResult = await demoAutoSetup(logger);
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // 2. リアルタイム収益計算
    const profitResult = await demoProfitabilitySystem(logger, setupResult);
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // 3. ハードウェア監視
    const hwResult = await demoHardwareMonitoring(logger);
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // 4. Stratum V2プロトコル
    const v2Result = await demoStratumV2(logger);
    
    // 最終結果
    console.log('\n' + '='.repeat(60));
    console.log('🎊 デモ完了! 結果サマリー');
    console.log('='.repeat(60));
    
    logger.success(`自動セットアップ: ${setupResult ? '成功' : '失敗'}`);
    logger.success(`収益計算システム: ${profitResult ? '成功' : '失敗'}`);
    logger.success(`ハードウェア監視: ${hwResult ? '成功' : '失敗'}`);
    logger.success(`Stratum V2: ${v2Result ? '成功' : '失敗'}`);
    
    if (setupResult) {
      console.log(`\n💰 推奨マイニング設定:`);
      if (setupResult.cpuMining.enabled) {
        console.log(`   CPU: ${setupResult.cpuMining.coin} ($${setupResult.cpuMining.expectedRevenue.toFixed(2)}/day)`);
      }
      if (setupResult.gpuMining.enabled) {
        console.log(`   GPU: ${setupResult.gpuMining.coin} ($${setupResult.gpuMining.expectedRevenue.toFixed(2)}/day)`);
      }
      console.log(`   合計予想収益: $${setupResult.profitability.toFixed(2)}/day`);
    }
    
    console.log('\n🚀 次のステップ:');
    console.log('1. POOL_ADDRESS=your_wallet_address を設定');
    console.log('2. npm run start:nextgen でプール開始');
    console.log('3. マイニングソフトをポート3333(V1)または4444(V2)に接続');
    console.log('4. http://localhost:3000 でダッシュボード確認');
    
  } catch (error) {
    logger.error('デモ実行中にエラーが発生:', error);
  }
}

// コマンドライン引数による個別機能テスト
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const logger = new DemoLogger();
  
  if (args.length === 0) {
    await runFullDemo();
    return;
  }
  
  const feature = args[0];
  
  switch (feature) {
    case 'setup':
      await demoAutoSetup(logger);
      break;
    case 'profit':
      await demoProfitabilitySystem(logger);
      break;
    case 'hardware':
      await demoHardwareMonitoring(logger);
      break;
    case 'stratum':
      await demoStratumV2(logger);
      break;
    default:
      console.log('使用法: npm run demo [setup|profit|hardware|stratum]');
      console.log('引数なしで全機能デモを実行');
  }
}

if (require.main === module) {
  main().catch(console.error);
}

export { runFullDemo, demoAutoSetup, demoProfitabilitySystem, demoHardwareMonitoring, demoStratumV2 };