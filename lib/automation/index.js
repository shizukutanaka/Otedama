// Otedama Mining Pool - Automation Suite
// 利用者と運営者のための省力化機能統合モジュール

const AutoSetupWizard = require('../wizard/auto-setup-wizard');
const OneClickMining = require('../wizard/one-click-mining');
const AutoPoolSwitching = require('./auto-pool-switching');
const OperationsAutomation = require('./operations-automation');
const AutoTroubleshooting = require('./auto-troubleshooting');
const AutoOptimizationEngine = require('../ai/auto-optimization-engine');
const AutoReportSystem = require('../reporting/auto-report-system');
const OneClickDeploy = require('../deployment/one-click-deploy');
const MobileAPI = require('../api/mobile-api');

class OtedamaAutomation {
  constructor(config = {}) {
    // 利用者向け機能
    this.setupWizard = new AutoSetupWizard(config.setupWizard);
    this.oneClickMining = new OneClickMining(config.oneClickMining);
    this.poolSwitching = new AutoPoolSwitching(config.poolSwitching);
    this.mobileAPI = new MobileAPI(config.mobileAPI);
    
    // 運営者向け機能
    this.operations = new OperationsAutomation(config.operations);
    this.troubleshooting = new AutoTroubleshooting(config.troubleshooting);
    this.optimization = new AutoOptimizationEngine(config.optimization);
    this.reporting = new AutoReportSystem(config.reporting);
    this.deployment = new OneClickDeploy(config.deployment);
    
    // 統合設定
    this.config = {
      autoStart: config.autoStart !== false,
      mobileEnabled: config.mobileEnabled !== false,
      ...config
    };
  }
  
  async initialize() {
    console.log('🚀 Otedama Automation Suite initializing...');
    
    // 初期化処理
    const initTasks = [];
    
    if (this.config.mobileEnabled) {
      initTasks.push(this.startMobileAPI());
    }
    
    if (this.config.autoStart) {
      initTasks.push(this.startAutomation());
    }
    
    await Promise.all(initTasks);
    
    console.log('✅ Otedama Automation Suite ready!');
  }
  
  // 利用者向け - ワンクリックで開始
  async quickStartMining(walletAddress) {
    console.log('⛏️  Starting one-click mining...');
    
    try {
      // 自動設定
      const result = await this.oneClickMining.start(walletAddress);
      
      // 自動プール切り替え開始
      this.poolSwitching.start();
      
      // トラブルシューティング開始
      this.troubleshooting.start();
      
      console.log('✅ Mining started successfully!');
      console.log(`📊 Estimated earnings: ${JSON.stringify(result.estimatedEarnings)}`);
      
      return result;
      
    } catch (error) {
      console.error('❌ Failed to start mining:', error.message);
      throw error;
    }
  }
  
  // 運営者向け - 自動化開始
  async startAutomation() {
    console.log('🤖 Starting automation systems...');
    
    // 運営自動化
    await this.operations.start();
    
    // AI最適化
    await this.optimization.initialize();
    await this.optimization.start();
    
    // レポート生成
    await this.reporting.start();
    
    // トラブルシューティング
    await this.troubleshooting.start();
    
    console.log('✅ All automation systems active!');
  }
  
  // モバイルAPI開始
  async startMobileAPI() {
    this.mobileAPI.start();
    console.log('📱 Mobile API started on port 3001');
  }
  
  // ワンクリックデプロイ
  async deploy(target = 'docker') {
    console.log(`🚀 Deploying to ${target}...`);
    
    const result = await this.deployment.deploy(target);
    
    console.log(`✅ Deployment complete!`);
    return result;
  }
  
  // 統合ステータス
  getStatus() {
    return {
      mining: {
        status: this.oneClickMining.getStatus(),
        pools: this.poolSwitching.getStatus()
      },
      operations: {
        health: this.operations.getStatistics(),
        troubleshooting: this.troubleshooting.getStatus(),
        optimization: this.optimization.getStatus()
      },
      reporting: this.reporting.getStatus(),
      deployment: {
        lastDeployment: this.deployment.getLastDeployment(),
        history: this.deployment.getDeploymentHistory()
      }
    };
  }
  
  // 緊急停止
  async emergencyStop() {
    console.log('🛑 Emergency stop initiated...');
    
    await this.oneClickMining.stop();
    this.poolSwitching.stop();
    this.operations.stop();
    this.optimization.stop();
    this.troubleshooting.stop();
    this.reporting.stop();
    
    console.log('✅ All systems stopped');
  }
}

// エクスポート
module.exports = OtedamaAutomation;

// スタンドアロン実行
if (require.main === module) {
  const automation = new OtedamaAutomation({
    autoStart: true,
    mobileEnabled: true
  });
  
  automation.initialize().catch(console.error);
  
  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n📌 Shutting down gracefully...');
    await automation.emergencyStop();
    process.exit(0);
  });
}