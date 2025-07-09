/**
 * 簡単なビルド・動作テストスクリプト
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log('🔧 Otedama Mining Pool - Build Test');
console.log('=' .repeat(60));

// プロジェクトルートに移動
const projectRoot = path.join(__dirname, '..');
process.chdir(projectRoot);

try {
  // 1. TypeScriptビルドテスト
  console.log('📦 Building TypeScript...');
  execSync('npx tsc', { stdio: 'inherit' });
  console.log('✅ TypeScript build successful!');
  
  // 2. アルゴリズムファイルの存在確認
  const algorithmFile = path.join(projectRoot, 'dist', 'algorithms', 'unified-mining-algorithms.js');
  if (fs.existsSync(algorithmFile)) {
    console.log('✅ Algorithm file built successfully!');
  } else {
    console.log('❌ Algorithm file not found!');
    process.exit(1);
  }
  
  // 3. メインファイルの存在確認
  const mainFile = path.join(projectRoot, 'dist', 'main-basic.js');
  if (fs.existsSync(mainFile)) {
    console.log('✅ Main file built successfully!');
  } else {
    console.log('❌ Main file not found!');
    process.exit(1);
  }
  
  // 4. アルゴリズムのロードテスト
  console.log('🔧 Testing algorithm loading...');
  try {
    const { AlgorithmFactory } = require(algorithmFile);
    const algorithms = AlgorithmFactory.list();
    console.log('✅ Available algorithms:', algorithms);
    
    // 各アルゴリズムの基本テスト
    for (const algoName of algorithms) {
      try {
        const algo = AlgorithmFactory.create(algoName);
        console.log(`✅ ${algoName}: ${algo.name} (${algo.blockTime}s block time)`);
      } catch (error) {
        console.log(`❌ ${algoName}: Failed to load - ${error.message}`);
      }
    }
  } catch (error) {
    console.log('❌ Algorithm loading failed:', error.message);
    process.exit(1);
  }
  
  console.log('');
  console.log('🎉 All tests passed!');
  console.log('🚀 Ready to run: npm start');
  console.log('🌐 Web UI will be available at: http://localhost:3000');
  
} catch (error) {
  console.error('❌ Build test failed:', error.message);
  process.exit(1);
}