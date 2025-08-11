# Otedama - P2Pマイニングプールソフトウェア 使用ガイド

## 目次
1. [インストール](#インストール)
2. [設定](#設定)
3. [Otedamaの実行](#otedamaの実行)
4. [マイニング操作](#マイニング操作)
5. [プール管理](#プール管理)
6. [モニタリング](#モニタリング)
7. [トラブルシューティング](#トラブルシューティング)

## インストール

### システム要件
- OS: Linux、Windows、macOS
- RAM: 最小4GB、推奨8GB以上
- ストレージ: 50GB以上の空き容量
- ネットワーク: 安定したインターネット接続

### クイックインストール
```bash
# 最新リリースをダウンロード
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64

# またはソースからビルド
git clone https://github.com/otedama/otedama.git
cd otedama
go build -o otedama cmd/otedama/main.go
```

## 設定

### 基本設定
`config.yaml`を作成：
```yaml
mining:
  algorithm: sha256d
  threads: 4
  intensity: 10

pool:
  url: stratum+tcp://pool.example.com:3333
  wallet_address: あなたのウォレットアドレス
  worker_name: worker1

p2p:
  enabled: true
  listen_addr: 0.0.0.0:19333
  max_peers: 50
```

### 詳細設定
```yaml
hardware:
  cpu:
    enabled: true
    threads: 8
  gpu:
    enabled: true
    devices: [0, 1]
  asic:
    enabled: false

monitoring:
  enabled: true
  listen_addr: 0.0.0.0:8080
  prometheus_enabled: true
```

## Otedamaの実行

### ソロマイニング
```bash
./otedama --solo --algorithm sha256d --threads 8
```

### プールマイニング
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet ウォレット --worker worker1
```

### P2Pプールモード
```bash
./otedama --p2p --listen 0.0.0.0:19333 --bootstrap node1.example.com:19333,node2.example.com:19333
```

### Dockerデプロイメント
```bash
docker run -d \
  --name otedama \
  -p 19333:19333 \
  -p 8080:8080 \
  -v ./config.yaml:/config.yaml \
  otedama/otedama:latest
```

## マイニング操作

### 対応アルゴリズム
- SHA256d (ビットコイン)
- Scrypt (ライトコイン)
- Ethash (イーサリアムクラシック)
- KawPow (レイヴンコイン)
- RandomX (モネロ)
- Autolykos2 (エルゴ)

### ハードウェア最適化
```bash
# SIMD最適化によるCPUマイニング
./otedama --cpu --optimize simd

# 複数デバイスでのGPUマイニング
./otedama --gpu --devices 0,1,2,3

# ASICマイニング
./otedama --asic --model antminer-s19
```

### パフォーマンスチューニング
```bash
# 強度調整 (1-20)
./otedama --intensity 15

# メモリ最適化
./otedama --memory-pool 2048

# ネットワーク最適化
./otedama --low-latency --max-connections 100
```

## プール管理

### プールサーバーの起動
```bash
./otedama pool --listen 0.0.0.0:3333 --fee 1.0 --min-payout 0.001
```

### ワーカー管理
```bash
# ワーカー一覧
./otedama workers list

# ワーカー追加
./otedama workers add --name worker1 --wallet アドレス

# ワーカー削除
./otedama workers remove worker1

# ワーカー統計表示
./otedama workers stats worker1
```

### ペイアウト設定
```yaml
pool:
  payout_scheme: PPLNS  # または PPS、PROP
  payout_interval: 24h
  min_payout: 0.001
  fee_percent: 1.0
```

## モニタリング

### Webダッシュボード
`http://localhost:8080`でアクセス

機能：
- リアルタイムハッシュレートグラフ
- ワーカー統計
- プールパフォーマンスメトリクス
- ペイアウト履歴

### コマンドラインモニタリング
```bash
# 現在の統計を表示
./otedama stats

# リアルタイム監視
./otedama monitor

# メトリクスエクスポート
./otedama metrics export --format json
```

### Prometheus統合
```yaml
monitoring:
  prometheus_enabled: true
  prometheus_port: 9090
```

### アラート設定
```yaml
alerts:
  email:
    enabled: true
    smtp_server: smtp.gmail.com:587
    from: alerts@example.com
    to: admin@example.com
  thresholds:
    min_hashrate: 1000000
    max_temperature: 85
    min_workers: 5
```

## トラブルシューティング

### よくある問題

#### 接続問題
```bash
# プール接続テスト
./otedama test --pool stratum+tcp://pool.example.com:3333

# ネットワークデバッグ
./otedama --debug --verbose
```

#### パフォーマンス問題
```bash
# ベンチマーク実行
./otedama benchmark --duration 60

# CPU使用率プロファイル
./otedama --profile cpu.prof
```

#### ハードウェア検出
```bash
# ハードウェアスキャン
./otedama hardware scan

# 特定デバイステスト
./otedama hardware test --gpu 0
```

### ログファイル
```bash
# ログ表示
tail -f /var/log/otedama/otedama.log

# ログレベル変更
./otedama --log-level debug
```

### リカバリーモード
```bash
# セーフモードで起動
./otedama --safe-mode

# 設定リセット
./otedama --reset-config

# データベース修復
./otedama db repair
```

## APIリファレンス

### REST API
```bash
# ステータス取得
curl http://localhost:8080/api/status

# ワーカー取得
curl http://localhost:8080/api/workers

# シェア送信
curl -X POST http://localhost:8080/api/submit \
  -H "Content-Type: application/json" \
  -d '{"worker":"worker1","nonce":"12345678"}'
```

### WebSocket API
```javascript
const ws = new WebSocket('ws://localhost:8080/ws');
ws.on('message', (data) => {
  console.log('受信:', data);
});
```

## セキュリティ

### 認証
```yaml
security:
  auth_enabled: true
  jwt_secret: あなたの秘密鍵
  api_keys:
    - key: API_KEY_1
      permissions: [read, write]
```

### SSL/TLS
```yaml
security:
  tls_enabled: true
  cert_file: /path/to/cert.pem
  key_file: /path/to/key.pem
```

### ファイアウォールルール
```bash
# Stratum許可
iptables -A INPUT -p tcp --dport 3333 -j ACCEPT

# P2P許可
iptables -A INPUT -p tcp --dport 19333 -j ACCEPT

# モニタリング許可
iptables -A INPUT -p tcp --dport 8080 -j ACCEPT
```

## サポート

- GitHub: https://github.com/otedama/otedama
