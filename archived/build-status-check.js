#!/usr/bin/env node

/**
 * Otedama ビルドステータスチェッカー
 * コンパイルエラーと警告を確認
 */

const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log('🔍 Otedama ビルドステータスチェック開始...\n');

// TypeScriptコンパイラチェック
exec('npx tsc --noEmit', (error, stdout, stderr) => {
  if (error) {
    console.log('❌ TypeScript コンパイルエラーが見つかりました:\n');
    console.error(stderr || stdout);
    
    // エラーを分析
    const errors = stderr.split('\n').filter(line => line.includes('error TS'));
    console.log(`\n合計 ${errors.length} 個のエラー`);
    
    // 最も多いエラータイプを集計
    const errorTypes = {};
    errors.forEach(error => {
      const match = error.match(/error TS(\d+):/);
      if (match) {
        const code = match[1];
        errorTypes[code] = (errorTypes[code] || 0) + 1;
      }
    });
    
    console.log('\nエラータイプ別集計:');
    Object.entries(errorTypes)
      .sort((a, b) => b[1] - a[1])
      .forEach(([code, count]) => {
        console.log(`  TS${code}: ${count}個`);
      });
  } else {
    console.log('✅ TypeScript コンパイル: エラーなし');
  }
  
  // 依存関係チェック
  checkDependencies();
});

function checkDependencies() {
  console.log('\n🔍 依存関係チェック...\n');
  
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const deps = Object.keys(packageJson.dependencies || {});
  const devDeps = Object.keys(packageJson.devDependencies || {});
  
  console.log(`本番依存関係: ${deps.length}個`);
  deps.forEach(dep => console.log(`  - ${dep}`));
  
  console.log(`\n開発依存関係: ${devDeps.length}個`);
  
  // node_modulesの存在確認
  const nodeModulesPath = path.join(process.cwd(), 'node_modules');
  if (!fs.existsSync(nodeModulesPath)) {
    console.log('\n⚠️  node_modules が見つかりません。npm install を実行してください。');
  } else {
    // 各依存関係の実際のインストール状況を確認
    let missingDeps = [];
    deps.forEach(dep => {
      if (!fs.existsSync(path.join(nodeModulesPath, dep))) {
        missingDeps.push(dep);
      }
    });
    
    if (missingDeps.length > 0) {
      console.log('\n⚠️  以下の依存関係がインストールされていません:');
      missingDeps.forEach(dep => console.log(`  - ${dep}`));
    } else {
      console.log('\n✅ すべての依存関係がインストールされています');
    }
  }
  
  // ファイル構造チェック
  checkFileStructure();
}

function checkFileStructure() {
  console.log('\n🔍 ファイル構造チェック...\n');
  
  const requiredDirs = [
    'src',
    'src/core',
    'src/mining',
    'src/p2p',
    'src/api',
    'src/defi',
    'src/utils',
    'config',
    'test'
  ];
  
  const missingDirs = requiredDirs.filter(dir => !fs.existsSync(dir));
  
  if (missingDirs.length > 0) {
    console.log('⚠️  以下のディレクトリが見つかりません:');
    missingDirs.forEach(dir => console.log(`  - ${dir}`));
  } else {
    console.log('✅ 必要なディレクトリがすべて存在します');
  }
  
  // 重要なファイルの存在確認
  const requiredFiles = [
    'src/index.ts',
    'src/core/OtedamaCore.ts',
    'src/mining/engine.ts',
    'src/p2p/network.ts',
    'src/api/server.ts',
    'src/defi/dex.ts',
    'package.json',
    'tsconfig.json'
  ];
  
  const missingFiles = requiredFiles.filter(file => !fs.existsSync(file));
  
  if (missingFiles.length > 0) {
    console.log('\n⚠️  以下のファイルが見つかりません:');
    missingFiles.forEach(file => console.log(`  - ${file}`));
  } else {
    console.log('✅ 必要なファイルがすべて存在します');
  }
  
  // 削除済みファイルのカウント
  countDeletedFiles();
}

function countDeletedFiles() {
  console.log('\n🔍 削除済みファイルの確認...\n');
  
  let deletedCount = 0;
  let oldCount = 0;
  
  function walkDir(dir) {
    const files = fs.readdirSync(dir);
    files.forEach(file => {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      
      if (stat.isDirectory() && !file.startsWith('.') && file !== 'node_modules') {
        walkDir(filePath);
      } else if (stat.isFile()) {
        if (file.endsWith('.deleted')) deletedCount++;
        if (file.endsWith('.old')) oldCount++;
      }
    });
  }
  
  walkDir('.');
  
  if (deletedCount > 0 || oldCount > 0) {
    console.log(`⚠️  クリーンアップが必要なファイル:`);
    if (deletedCount > 0) console.log(`  - .deleted ファイル: ${deletedCount}個`);
    if (oldCount > 0) console.log(`  - .old ファイル: ${oldCount}個`);
    console.log('\n  npm run cleanup を実行してクリーンアップしてください。');
  } else {
    console.log('✅ クリーンアップ済み（不要ファイルなし）');
  }
  
  console.log('\n========================================');
  console.log('ビルドステータスチェック完了');
  console.log('========================================\n');
}
