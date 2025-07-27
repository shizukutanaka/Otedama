# Otedama Quick Setup Guide / Otedama クイックセットアップガイド

[English](#english) | [日本語](#japanese)

---

<a name="english"></a>
## One-Click Setup & Start

### Windows
```cmd
# Setup (first time only)
setup.cmd

# Start the pool
start.cmd
```

### Linux/macOS
```bash
# Setup (first time only)
chmod +x setup.sh
./setup.sh

# Start the pool
./start.sh
```

### Universal (All Platforms)
```bash
# Setup
node setup.js

# Start
node start.js
```

## 📋 What the Setup Does

1. **System Check**
   - Verifies Node.js 18+ and npm 8+
   - Checks available memory and disk space
   - Detects build tools for native modules

2. **Dependency Installation**
   - Installs all required npm packages
   - Compiles native modules if needed

3. **Configuration**
   - Interactive configuration wizard
   - Sets up pool parameters (name, algorithm, fees)
   - Configures network ports
   - Enables security features (ZKP, SSL)

4. **Database Setup**
   - Creates SQLite database
   - Initializes tables and indexes

5. **SSL Certificates** (optional)
   - Generates self-signed certificates
   - Enables secure connections

6. **System Optimization**
   - Applies OS-specific performance tweaks
   - Configures network parameters

7. **Service Installation** (optional)
   - Windows: Creates Windows service
   - Linux: Creates systemd service
   - macOS: Creates launchd plist

## 🎯 Start Modes

### Auto-Detection
The start script automatically selects the best mode based on your system:
- **Ultra Mode**: 16+ CPUs, 32GB+ RAM
- **Enterprise Mode**: 8+ CPUs, 16GB+ RAM
- **Standard Mode**: All other systems

### Manual Selection
```bash
# Ultra performance mode
node start.js --ultra

# Enterprise mode
node start.js --enterprise

# Development mode
node start.js --dev
```

## 🔧 Configuration Options

### Basic Configuration
- **Pool Name**: Your mining pool's display name
- **Algorithm**: sha256, scrypt, ethash, randomx, kawpow
- **Coin**: BTC, LTC, ETH, XMR, RVN
- **Pool Fee**: 0-5% (default: 1%)
- **Min Payout**: Minimum payout threshold

### Network Configuration
- **Stratum Port**: Mining connection port (default: 3333)
- **API Port**: REST API port (default: 8081)
- **Dashboard Port**: Web dashboard port (default: 8082)

### Security Options
- **ZKP Authentication**: Zero-knowledge proof (no KYC)
- **SSL/TLS**: Encrypted connections

### Advanced Options
- **Max Connections**: Up to 10 million
- **Target Latency**: Performance target in ms
- **Worker Processes**: CPU cores to use
- **Enterprise Mode**: Multi-region, auto-scaling

## 📊 After Setup

### Connect Miners
```
stratum+tcp://your-server:3333
Username: YOUR_WALLET_ADDRESS
Password: x
```

### View Dashboard
Open in browser: `http://localhost:8082`

### API Access
REST API: `http://localhost:8081/api/v1`

### Check Status
```bash
# View logs
node start.js --dev

# Run benchmarks
npm run benchmark

# Health check
npm run health
```

## 🆘 Troubleshooting

### Setup Issues
- **Permission denied**: Run as administrator/sudo
- **Port in use**: Change ports in configuration
- **Dependencies fail**: Install build tools

### Start Issues
- **Config not found**: Run setup first
- **Database locked**: Stop other instances
- **Performance issues**: Try different mode

### Common Commands
```bash
# Reconfigure
node setup.js

# Reset database
rm -rf data/otedama.db
node setup.js

# Update dependencies
npm update

# Check system
npm run health:full
```

## 🔐 Security Notes

- First run generates unique keys
- ZKP provides privacy without KYC
- SSL certificates are self-signed by default
- Change default passwords in production

## 📈 Performance Tips

- Use SSD for database storage
- Allocate sufficient RAM
- Enable huge pages on Linux
- Use enterprise mode for large deployments
- Monitor with Prometheus/Grafana

## 🌍 Multi-Region Setup

For enterprise deployments across regions:
1. Run setup on each server
2. Configure same pool parameters
3. Use different ports if needed
4. Enable enterprise mode
5. Set up load balancer

---

Need help? Check the full documentation:
- [README.md](README.md) - Complete guide
- [docs/API.md](docs/API.md) - API reference
- [CHANGELOG.md](CHANGELOG.md) - Version history

GitHub: https://github.com/shizukutanaka/Otedama

---

<a name="japanese"></a>
## ワンクリックセットアップ＆スタート

### Windows
```cmd
# セットアップ（初回のみ）
setup.cmd

# プールを開始
start.cmd
```

### Linux/macOS
```bash
# セットアップ（初回のみ）
chmod +x setup.sh
./setup.sh

# プールを開始
./start.sh
```

### ユニバーサル（全プラットフォーム）
```bash
# セットアップ
node setup.js

# 開始
node start.js
```

## セットアップの内容

1. **システムチェック**
   - Node.js 18+ と npm 8+ を確認
   - 利用可能なメモリとディスク容量をチェック
   - ネイティブモジュール用のビルドツールを検出

2. **依存関係のインストール**
   - 必要なすべてのnpmパッケージをインストール
   - 必要に応じてネイティブモジュールをコンパイル

3. **設定**
   - 対話式設定ウィザード
   - プールパラメータの設定（名前、アルゴリズム、手数料）
   - ネットワークポートの設定
   - セキュリティ機能を有効化（ZKP、SSL）

4. **データベース設定**
   - SQLiteデータベースを作成
   - テーブルとインデックスを初期化

5. **SSL証明書**（オプション）
   - 自己署名証明書を生成
   - セキュア接続を有効化

6. **システム最適化**
   - OS固有のパフォーマンス調整を適用
   - ネットワークパラメータを設定

7. **サービスインストール**（オプション）
   - Windows: Windowsサービスを作成
   - Linux: systemdサービスを作成
   - macOS: launchd plistを作成

## 開始モード

### 自動検出
開始スクリプトはシステムに基づいて最適なモードを自動選択：
- **ウルトラモード**: 16+ CPU、32GB+ RAM
- **エンタープライズモード**: 8+ CPU、16GB+ RAM
- **標準モード**: その他のシステム

### 手動選択
```bash
# ウルトラパフォーマンスモード
node start.js --ultra

# エンタープライズモード
node start.js --enterprise

# 開発モード
node start.js --dev
```

## 設定オプション

### 基本設定
- **プール名**: マイニングプールの表示名
- **アルゴリズム**: sha256、scrypt、ethash、randomx、kawpow
- **コイン**: BTC、LTC、ETH、XMR、RVN
- **プール手数料**: 0-5%（デフォルト: 1%）
- **最小支払い額**: 最小支払い闾値

### ネットワーク設定
- **Stratumポート**: マイニング接続ポート（デフォルト: 3333）
- **APIポート**: REST APIポート（デフォルト: 8081）
- **ダッシュボードポート**: Webダッシュボードポート（デフォルト: 8082）

### セキュリティオプション
- **ZKP認証**: ゼロ知識証明（KYC不要）
- **SSL/TLS**: 暗号化接続

### 高度なオプション
- **最大接続数**: 最大1,000万
- **目標レイテンシ**: ミリ秒単位のパフォーマンス目標
- **ワーカープロセス**: 使用するCPUコア
- **エンタープライズモード**: マルチリージョン、自動スケーリング

## セットアップ後

### マイナーを接続
```
stratum+tcp://your-server:3333
ユーザー名: YOUR_WALLET_ADDRESS
パスワード: x
```

### ダッシュボードを表示
ブラウザで開く: `http://localhost:8082`

### APIアクセス
REST API: `http://localhost:8081/api/v1`

### ステータスチェック
```bash
# ログを表示
node start.js --dev

# ベンチマークを実行
npm run benchmark

# ヘルスチェック
npm run health
```

## トラブルシューティング

### セットアップの問題
- **権限拒否**: 管理者/sudoとして実行
- **ポート使用中**: 設定でポートを変更
- **依存関係の失敗**: ビルドツールをインストール

### 開始の問題
- **設定が見つからない**: 最初にセットアップを実行
- **データベースロック**: 他のインスタンスを停止
- **パフォーマンスの問題**: 別のモードを試す

### 一般的なコマンド
```bash
# 再設定
node setup.js

# データベースリセット
rm -rf data/otedama.db
node setup.js

# 依存関係を更新
npm update

# システムチェック
npm run health:full
```

## セキュリティノート

- 初回実行時に固有のキーを生成
- ZKPはKYCなしでプライバシーを提供
- SSL証明書はデフォルトで自己署名
- 本番環境ではデフォルトパスワードを変更

## パフォーマンスのヒント

- データベースストレージにSSDを使用
- 十分なRAMを割り当て
- Linuxでhuge pagesを有効化
- 大規模展開にはエンタープライズモードを使用
- Prometheus/Grafanaで監視

## マルチリージョンセットアップ

リージョン間でのエンタープライズ展開：
1. 各サーバーでセットアップを実行
2. 同じプールパラメータを設定
3. 必要に応じて異なるポートを使用
4. エンタープライズモードを有効化
5. ロードバランサーを設定

---

ヘルプが必要ですか？完全なドキュメントを確認してください：
- [README.md](README.md) - 完全ガイド
- [docs/API.md](docs/API.md) - APIリファレンス
- [CHANGELOG.md](CHANGELOG.md) - バージョン履歴

GitHub: https://github.com/shizukutanaka/Otedama