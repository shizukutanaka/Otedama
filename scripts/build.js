#!/usr/bin/env node

/**
 * Build Script - アプリケーションビルド自動化
 * 
 * 機能:
 * - TypeScript コンパイル
 * - HTML ファイルコピー  
 * - アセットコピー
 * - 依存関係チェック
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('🚀 Otedama Mining App Build Script');
console.log('=====================================');

const rootDir = process.cwd();
const srcDir = path.join(rootDir, 'src');
const distDir = path.join(rootDir, 'dist');
const publicDir = path.join(rootDir, 'public');

// ディレクトリ作成
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`📁 Created directory: ${dir}`);
  }
}

// ファイルコピー
function copyFile(src, dest) {
  try {
    fs.copyFileSync(src, dest);
    console.log(`📋 Copied: ${path.relative(rootDir, src)} → ${path.relative(rootDir, dest)}`);
  } catch (error) {
    console.error(`❌ Failed to copy ${src}:`, error.message);
  }
}

// ディレクトリコピー
function copyDirectory(src, dest) {
  ensureDir(dest);
  
  const items = fs.readdirSync(src);
  
  for (const item of items) {
    const srcPath = path.join(src, item);
    const destPath = path.join(dest, item);
    
    const stat = fs.statSync(srcPath);
    
    if (stat.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else {
      copyFile(srcPath, destPath);
    }
  }
}

// メイン ビルド関数
async function build() {
  try {
    console.log('\n🔧 Step 1: Cleaning dist directory...');
    if (fs.existsSync(distDir)) {
      fs.rmSync(distDir, { recursive: true, force: true });
      console.log('🗑️ Cleaned dist directory');
    }
    ensureDir(distDir);

    console.log('\n📦 Step 2: Compiling TypeScript...');
    try {
      execSync('tsc', { 
        stdio: 'inherit',
        cwd: rootDir 
      });
      console.log('✅ TypeScript compilation completed');
    } catch (error) {
      console.error('❌ TypeScript compilation failed');
      throw error;
    }

    console.log('\n📄 Step 3: Copying HTML and assets...');
    
    // Public ディレクトリのコピー
    if (fs.existsSync(publicDir)) {
      const publicItems = fs.readdirSync(publicDir);
      for (const item of publicItems) {
        const srcPath = path.join(publicDir, item);
        const destPath = path.join(distDir, item);
        
        if (fs.statSync(srcPath).isDirectory()) {
          copyDirectory(srcPath, destPath);
        } else {
          copyFile(srcPath, destPath);
        }
      }
    }

    // package.json をdistにコピー
    const packageJsonSrc = path.join(rootDir, 'package.json');
    const packageJsonDest = path.join(distDir, 'package.json');
    if (fs.existsSync(packageJsonSrc)) {
      copyFile(packageJsonSrc, packageJsonDest);
    }

    console.log('\n🔍 Step 4: Validating build...');
    
    // 主要ファイルの存在確認
    const requiredFiles = [
      'main-app.js',
      'preload.js',
      'index.html'
    ];

    let missingFiles = [];
    for (const file of requiredFiles) {
      const filePath = path.join(distDir, file);
      if (!fs.existsSync(filePath)) {
        missingFiles.push(file);
      }
    }

    if (missingFiles.length > 0) {
      console.warn('⚠️ Missing files:', missingFiles);
    } else {
      console.log('✅ All required files present');
    }

    // ビルド統計
    const distStats = getDirectoryStats(distDir);
    console.log('\n📊 Build Statistics:');
    console.log(`   Files: ${distStats.files}`);
    console.log(`   Directories: ${distStats.directories}`);
    console.log(`   Total size: ${formatBytes(distStats.size)}`);

    console.log('\n🎉 Build completed successfully!');
    console.log(`📁 Output directory: ${distDir}`);
    
  } catch (error) {
    console.error('\n❌ Build failed:', error.message);
    process.exit(1);
  }
}

// ディレクトリ統計取得
function getDirectoryStats(dir) {
  let files = 0;
  let directories = 0;
  let size = 0;

  function walk(currentDir) {
    const items = fs.readdirSync(currentDir);
    
    for (const item of items) {
      const itemPath = path.join(currentDir, item);
      const stat = fs.statSync(itemPath);
      
      if (stat.isDirectory()) {
        directories++;
        walk(itemPath);
      } else {
        files++;
        size += stat.size;
      }
    }
  }

  walk(dir);
  return { files, directories, size };
}

// バイト数フォーマット
function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) {
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  } else if (bytes >= 1024) {
    return (bytes / 1024).toFixed(2) + ' KB';
  } else {
    return bytes + ' B';
  }
}

// 開発モード用のwatchビルド
function watch() {
  console.log('👀 Starting watch mode...');
  
  // TypeScript watch
  const tscWatch = require('child_process').spawn('tsc', ['--watch'], {
    stdio: 'inherit',
    cwd: rootDir
  });

  // ファイル変更監視
  fs.watch(publicDir, { recursive: true }, (eventType, filename) => {
    if (filename) {
      console.log(`🔄 ${filename} changed, copying...`);
      const srcPath = path.join(publicDir, filename);
      const destPath = path.join(distDir, filename);
      
      if (fs.existsSync(srcPath)) {
        ensureDir(path.dirname(destPath));
        copyFile(srcPath, destPath);
      }
    }
  });

  process.on('SIGINT', () => {
    console.log('\n🛑 Stopping watch mode...');
    tscWatch.kill();
    process.exit(0);
  });
}

// コマンドライン引数の処理
const args = process.argv.slice(2);

if (args.includes('--watch') || args.includes('-w')) {
  watch();
} else {
  build();
}
