/**
 * Otedama Mining Pool - Main Application
 * ゼロ手数料P2P分散型マイニングプール
 * 
 * Version: 1.0.0
 * License: MIT
 */

import * as dotenv from 'dotenv';
import * as cluster from 'cluster';
import * as os from 'os';
import * as path from 'path';
import { program } from 'commander';

// コンポーネントのインポート
import { OtedamaCoreSystem } from './core/otedama-core-system';
import { OneClickSetup } from './setup/one-click-setup';
import { ModernAlgorithmFactory } from './algorithms/modern/modern-mining-algorithms';

// 環境変数の読み込み
dotenv.config();

// === CLIコマンド定義 ===
program
  .name('otedama')
  .description('Otedama - Zero Fee P2P Mining Pool')
  .version('1.0.0');

// セットアップコマンド
program
  .command('setup')
  .description('Run one-click setup wizard')
  .option('-c, --coin <coin>', 'Preferred coin (BTC, XMR, RVN, etc.)')
  .option('-w, --wallet <address>', 'Wallet address')
  .option('-n, --name <name>', 'Worker name')
  .option('--cpu-only', 'Use CPU mining only')
  .option('--gpu-only', 'Use GPU mining only')
  .action(async (options) => {
    console.log(`
╔═══════════════════════════════════════╗
║     🎯 Otedama Mining Pool Setup      ║
║         Zero Fee • P2P • Simple       ║
╚═══════════════════════════════════════╝
    `);

    const setup = new OneClickSetup();
    const config: any = {
      mining: {}
    };

    if (options.coin) {
      config.mining.autoSelectCoin = false;
      config.mining.preferredCoin = options.coin.toUpperCase();
    }

    if (options.wallet) {
      config.wallet = { [`${options.coin?.toLowerCase() || 'xmr'}Address`]: options.wallet };
    }

    if (options.name) {
      config.mining.workerName = options.name;
    }

    if (options.cpuOnly) {
      config.hardware = { gpuEnabled: false };
    } else if (options.gpuOnly) {
      config.hardware = { cpuThreads: 0 };
    }

    const result = await setup.setup(config);
    
    if (result.success) {
      console.log('\n✅ Setup completed successfully!');
      console.log('\nNext steps:');
      console.log('1. Start mining: otedama start');
      console.log('2. View dashboard: otedama dashboard');
      console.log('3. Check status: otedama status');
    } else {
      console.error('\n❌ Setup failed. Please check the errors above.');
      process.exit(1);
    }
  });

// マイニング開始コマンド
program
  .command('start')
  .description('Start mining')
  .option('-c, --config <path>', 'Config file path')
  .option('-d, --daemon', 'Run as daemon')
  .option('--stratum-port <port>', 'Stratum V2 port', '4444')
  .option('--p2p-port <port>', 'P2P network port', '8333')
  .option('--api-port <port>', 'API port', '8080')
  .action(async (options) => {
    console.log(`
╔═══════════════════════════════════════╗
║      🚀 Starting Otedama Mining       ║
║         Zero Fee P2P Pool             ║
╚═══════════════════════════════════════╝
    `);

    const poolConfig = {
      stratum: {
        v2Port: parseInt(options.stratumPort),
        v1Port: parseInt(options.stratumPort) - 1
      },
      p2p: {
        port: parseInt(options.p2pPort)
      },
      api: {
        port: parseInt(options.apiPort),
        enabled: true
      }
    };

    try {
      const pool = new OtedamaCoreSystem(poolConfig);
      
      // グレースフルシャットダウン
      process.on('SIGINT', async () => {
        console.log('\n\nShutting down gracefully...');
        await pool.stop();
        process.exit(0);
      });

      process.on('SIGTERM', async () => {
        await pool.stop();
        process.exit(0);
      });

      // プール開始
      await pool.start();
      
      // 統計表示
      setInterval(() => {
        const stats = pool.getStats();
        console.log('\n📊 Pool Statistics:');
        console.log(`   Miners: ${stats.miners.active}/${stats.miners.total}`);
        console.log(`   Hashrate: ${(stats.hashrate.total / 1e9).toFixed(2)} GH/s`);
        console.log(`   Shares: ${stats.shares.valid} valid, ${stats.shares.invalid} invalid`);
        console.log(`   Blocks: ${stats.shares.blocks} found`);
        console.log(`   P2P Nodes: ${stats.network.p2pNodes}`);
      }, 30000); // 30秒ごと

      // デーモンモードでない場合は、コンソールを開いたままにする
      if (!options.daemon) {
        console.log('\nPress Ctrl+C to stop mining\n');
      }

    } catch (error) {
      console.error('Failed to start pool:', error);
      process.exit(1);
    }
  });

// ステータス確認コマンド
program
  .command('status')
  .description('Check mining status')
  .action(async () => {
    try {
      // APIに接続して状態を確認
      const response = await fetch('http://localhost:8080/api/stats');
      const stats = await response.json();
      
      console.log('\n📊 Mining Status:');
      console.log(`   Status: ${stats.isRunning ? '🟢 Running' : '🔴 Stopped'}`);
      console.log(`   Uptime: ${Math.floor(stats.uptime / 3600000)} hours`);
      console.log(`   Active Miners: ${stats.miners.active}`);
      console.log(`   Total Hashrate: ${(stats.hashrate.total / 1e9).toFixed(2)} GH/s`);
      console.log(`   Blocks Found: ${stats.shares.blocks}`);
      console.log(`   Total Revenue: $${stats.revenue.total.toFixed(2)}`);
      
    } catch (error) {
      console.error('❌ Could not connect to mining pool. Is it running?');
    }
  });

// ダッシュボード起動コマンド
program
  .command('dashboard')
  .description('Open web dashboard')
  .action(() => {
    console.log('🌐 Opening dashboard at http://localhost:8080');
    
    // ブラウザを開く
    const platform = os.platform();
    const command = platform === 'win32' ? 'start' : 
                   platform === 'darwin' ? 'open' : 'xdg-open';
    
    require('child_process').exec(`${command} http://localhost:8080`);
  });

// アルゴリズム一覧コマンド
program
  .command('algorithms')
  .description('List supported algorithms')
  .action(() => {
    console.log('\n📋 Supported Mining Algorithms:\n');
    
    const configs = ModernAlgorithmFactory.getConfigs();
    
    configs.forEach(config => {
      console.log(`${config.name} (${config.symbol})`);
      console.log(`   Coins: ${config.coins.join(', ')}`);
      console.log(`   CPU: ${config.hashrate.cpu.min}-${config.hashrate.cpu.max} ${config.hashrate.cpu.unit}`);
      console.log(`   GPU: ${config.hashrate.gpu.min}-${config.hashrate.gpu.max} ${config.hashrate.gpu.unit}`);
      if (config.hashrate.asic) {
        console.log(`   ASIC: ${config.hashrate.asic.min}-${config.hashrate.asic.max} ${config.hashrate.asic.unit}`);
      }
      console.log(`   Memory: ${config.memoryRequirement} MB`);
      console.log();
    });
  });

// ベンチマークコマンド
program
  .command('benchmark')
  .description('Run hardware benchmark')
  .option('-a, --algorithm <algo>', 'Specific algorithm to test')
  .option('-d, --duration <seconds>', 'Test duration', '60')
  .action(async (options) => {
    console.log('\n🏃 Running hardware benchmark...\n');
    
    const algorithms = options.algorithm ? [options.algorithm] : ModernAlgorithmFactory.list();
    const duration = parseInt(options.duration) * 1000;
    
    for (const algo of algorithms) {
      console.log(`Testing ${algo}...`);
      
      const algorithm = ModernAlgorithmFactory.get(algo);
      if (!algorithm) {
        console.log(`   ❌ Algorithm not found`);
        continue;
      }
      
      // 簡易ベンチマーク
      const startTime = Date.now();
      let hashes = 0;
      
      while (Date.now() - startTime < duration) {
        const data = Buffer.from(Math.random().toString());
        algorithm.hash(data);
        hashes++;
      }
      
      const elapsed = (Date.now() - startTime) / 1000;
      const hashrate = hashes / elapsed;
      
      console.log(`   Hashrate: ${hashrate.toFixed(2)} H/s`);
      console.log();
    }
  });

// === メイン関数 ===
async function main() {
  // ASCIIアート
  if (process.argv.length === 2) {
    console.log(`
    ╔═══════════════════════════════════════════════════════╗
    ║                                                       ║
    ║      ██████╗ ████████╗███████╗██████╗  █████╗        ║
    ║     ██╔═══██╗╚══██╔══╝██╔════╝██╔══██╗██╔══██╗       ║
    ║     ██║   ██║   ██║   █████╗  ██║  ██║███████║       ║
    ║     ██║   ██║   ██║   ██╔══╝  ██║  ██║██╔══██║       ║
    ║     ╚██████╔╝   ██║   ███████╗██████╔╝██║  ██║       ║
    ║      ╚═════╝    ╚═╝   ╚══════╝╚═════╝ ╚═╝  ╚═╝       ║
    ║                                                       ║
    ║           Zero Fee P2P Mining Pool v1.0               ║
    ║                                                       ║
    ╚═══════════════════════════════════════════════════════╝

    Quick Start:
      otedama setup     - Run one-click setup wizard
      otedama start     - Start mining
      otedama status    - Check mining status
      otedama --help    - Show all commands

    `);
  }

  // コマンド解析
  program.parse(process.argv);
}

// エラーハンドリング
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

// アプリケーション起動
if (require.main === module) {
  main().catch(console.error);
}

export { OtedamaCoreSystem, OneClickSetup, ModernAlgorithmFactory };