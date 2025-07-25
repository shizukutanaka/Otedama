# Otedama クイックセットアップガイド

## 🚀 ワンクリックセットアップ＆スタート

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

## 📋 セットアップの内容

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

## 🎯 開始モード

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

## 🔧 設定オプション

### 基本設定
- **プール名**: マイニングプールの表示名
- **アルゴリズム**: sha256、scrypt、ethash、randomx、kawpow
- **コイン**: BTC、LTC、ETH、XMR、RVN
- **プール手数料**: 0-5%（デフォルト: 1%）
- **最小支払い額**: 最小支払い閾値

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

## 📊 セットアップ後

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

## 🆘 トラブルシューティング

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

## 🔐 セキュリティノート

- 初回実行時に固有のキーを生成
- ZKPはKYCなしでプライバシーを提供
- SSL証明書はデフォルトで自己署名
- 本番環境ではデフォルトパスワードを変更

## 📈 パフォーマンスのヒント

- データベースストレージにSSDを使用
- 十分なRAMを割り当て
- Linuxでhuge pagesを有効化
- 大規模展開にはエンタープライズモードを使用
- Prometheus/Grafanaで監視

## 🌍 マルチリージョンセットアップ

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