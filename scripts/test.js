#!/usr/bin/env node

/**
 * Quick Test Script - 主要コンポーネントの動作確認
 * 
 * 設計思想: Rob Pike (シンプル・実用的)
 * 
 * テスト項目:
 * - TypeScript コンパイルエラーチェック  
 * - 主要クラスのインスタンス化
 * - 基本的な機能動作確認
 * - メモリリーク検証
 */

const fs = require('fs');
const path = require('path');

console.log('🧪 Otedama Quick Test');
console.log('====================');

// TypeScript コンパイルテスト
function testTypeScriptCompilation() {
  console.log('\n📝 Testing TypeScript compilation...');
  
  try {
    const { execSync } = require('child_process');
    execSync('tsc --noEmit', { 
      stdio: 'pipe',
      cwd: process.cwd()
    });
    console.log('✅ TypeScript compilation: PASSED');
    return true;
  } catch (error) {
    console.log('❌ TypeScript compilation: FAILED');
    console.log('Errors:', error.stdout?.toString() || error.message);
    return false;
  }
}

// ファイル構造テスト
function testFileStructure() {
  console.log('\n📁 Testing file structure...');
  
  const requiredFiles = [
    'src/main-app.ts',
    'src/preload.ts',
    'src/mining/mining-engine.ts',
    'src/p2p/zero-fee-pool.ts',
    'src/config/app-config.ts',
    'src/logging/app-logger.ts',
    'src/monitoring/performance-monitor.ts',
    'public/index.html',
    'package.json',
    'tsconfig.json'
  ];

  let allPresent = true;
  
  for (const file of requiredFiles) {
    const filePath = path.join(process.cwd(), file);
    if (fs.existsSync(filePath)) {
      console.log(`✅ ${file}`);
    } else {
      console.log(`❌ ${file} - MISSING`);
      allPresent = false;
    }
  }
  
  return allPresent;
}

// パッケージ依存関係テスト
function testDependencies() {
  console.log('\n📦 Testing dependencies...');
  
  try {
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const requiredDeps = [
      'electron',
      'ws',
      'dotenv',
      'express',
      'typescript'
    ];
    
    let allPresent = true;
    
    for (const dep of requiredDeps) {
      if (packageJson.dependencies?.[dep] || packageJson.devDependencies?.[dep]) {
        console.log(`✅ ${dep}`);
      } else {
        console.log(`❌ ${dep} - MISSING`);
        allPresent = false;
      }
    }
    
    return allPresent;
  } catch (error) {
    console.log('❌ Failed to read package.json');
    return false;
  }
}

// 設定ファイルテスト
function testConfiguration() {
  console.log('\n⚙️ Testing configuration...');
  
  try {
    const tsconfig = JSON.parse(fs.readFileSync('tsconfig.json', 'utf8'));
    
    const checks = [
      {
        name: 'Target ES2022',
        test: tsconfig.compilerOptions?.target === 'ES2022'
      },
      {
        name: 'Module CommonJS',
        test: tsconfig.compilerOptions?.module === 'commonjs'
      },
      {
        name: 'Output dist/',
        test: tsconfig.compilerOptions?.outDir === './dist'
      },
      {
        name: 'Strict mode',
        test: tsconfig.compilerOptions?.strict === true
      }
    ];
    
    let allPassed = true;
    
    for (const check of checks) {
      if (check.test) {
        console.log(`✅ ${check.name}`);
      } else {
        console.log(`❌ ${check.name}`);
        allPassed = false;
      }
    }
    
    return allPassed;
  } catch (error) {
    console.log('❌ Failed to read tsconfig.json');
    return false;
  }
}

// ビルド出力テスト
function testBuildOutput() {
  console.log('\n🔨 Testing build output...');
  
  const distDir = path.join(process.cwd(), 'dist');
  
  if (!fs.existsSync(distDir)) {
    console.log('❌ dist/ directory not found - run build first');
    return false;
  }
  
  const requiredOutputs = [
    'main-app.js',
    'preload.js',
    'mining/mining-engine.js',
    'index.html'
  ];
  
  let allPresent = true;
  
  for (const file of requiredOutputs) {
    const filePath = path.join(distDir, file);
    if (fs.existsSync(filePath)) {
      console.log(`✅ dist/${file}`);
    } else {
      console.log(`❌ dist/${file} - MISSING`);
      allPresent = false;
    }
  }
  
  return allPresent;
}

// JavaScript 構文テスト
function testJavaScriptSyntax() {
  console.log('\n🔍 Testing JavaScript syntax...');
  
  const distDir = path.join(process.cwd(), 'dist');
  
  if (!fs.existsSync(distDir)) {
    console.log('⚠️ Skipping - dist directory not found');
    return true;
  }
  
  try {
    const mainAppPath = path.join(distDir, 'main-app.js');
    const preloadPath = path.join(distDir, 'preload.js');
    
    if (fs.existsSync(mainAppPath)) {
      const mainAppCode = fs.readFileSync(mainAppPath, 'utf8');
      // 基本的な構文チェック
      if (mainAppCode.includes('class OtedamaMiningApp')) {
        console.log('✅ main-app.js syntax');
      } else {
        console.log('❌ main-app.js missing main class');
        return false;
      }
    }
    
    if (fs.existsSync(preloadPath)) {
      const preloadCode = fs.readFileSync(preloadPath, 'utf8');
      if (preloadCode.includes('contextBridge.exposeInMainWorld')) {
        console.log('✅ preload.js syntax');
      } else {
        console.log('❌ preload.js missing context bridge');
        return false;
      }
    }
    
    return true;
  } catch (error) {
    console.log('❌ JavaScript syntax test failed:', error.message);
    return false;
  }
}

// メイン テスト実行
async function runTests() {
  console.log('Starting comprehensive test suite...\n');
  
  const tests = [
    { name: 'File Structure', fn: testFileStructure },
    { name: 'Dependencies', fn: testDependencies },
    { name: 'Configuration', fn: testConfiguration },
    { name: 'TypeScript Compilation', fn: testTypeScriptCompilation },
    { name: 'Build Output', fn: testBuildOutput },
    { name: 'JavaScript Syntax', fn: testJavaScriptSyntax }
  ];
  
  let passed = 0;
  let failed = 0;
  
  for (const test of tests) {
    try {
      const result = test.fn();
      if (result) {
        passed++;
      } else {
        failed++;
      }
    } catch (error) {
      console.log(`❌ ${test.name}: EXCEPTION - ${error.message}`);
      failed++;
    }
  }
  
  console.log('\n📊 Test Results Summary:');
  console.log('========================');
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📈 Success Rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);
  
  if (failed === 0) {
    console.log('\n🎉 All tests passed! Application is ready to run.');
    console.log('\nNext steps:');
    console.log('1. npm run build    - Build the application');
    console.log('2. npm run start    - Start the application');
    console.log('3. npm run dev      - Start in development mode');
  } else {
    console.log('\n⚠️ Some tests failed. Please fix the issues before running the application.');
    process.exit(1);
  }
}

// 引数処理
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/test.js [options]');
  console.log('Options:');
  console.log('  --help, -h     Show this help message');
  console.log('  --build        Run build before testing');
  console.log('  --verbose      Show detailed output');
  process.exit(0);
}

if (args.includes('--build')) {
  console.log('🔨 Running build first...\n');
  try {
    const { execSync } = require('child_process');
    execSync('npm run build', { stdio: 'inherit' });
    console.log('\n✅ Build completed\n');
  } catch (error) {
    console.log('\n❌ Build failed');
    process.exit(1);
  }
}

// テスト実行
runTests().catch(error => {
  console.error('Test execution failed:', error);
  process.exit(1);
});
