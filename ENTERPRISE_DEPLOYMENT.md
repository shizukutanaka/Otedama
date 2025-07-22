# Otedama エンタープライズデプロイメントガイド

## 概要

このガイドでは、Otedamaを大規模環境で運用するための設定とデプロイメント方法を説明します。

## システム要件（エンタープライズ）

### ハードウェア要件

#### マスターノード（最小3台）
- CPU: 16コア以上
- RAM: 64GB以上
- ストレージ: NVMe SSD 1TB以上
- ネットワーク: 10Gbps以上

#### ワーカーノード
- CPU: 8コア以上
- RAM: 32GB以上
- ストレージ: SSD 500GB以上
- ネットワーク: 1Gbps以上

### ソフトウェア要件
- OS: Ubuntu 20.04 LTS または CentOS 8
- Node.js: 18.x LTS
- 開放ポート: 3333, 5556, 6633, 8080

## インストール手順

### 1. 全ノードでの準備

```bash
# 依存関係のインストール
sudo apt-get update
sudo apt-get install -y build-essential git python3

# Node.js 18のインストール
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Otedamaのクローン
git clone https://github.com/otedama/otedama.git
cd otedama

# 依存関係のインストール
npm install

# ネイティブモジュールのビルド
npm run build:native
```

### 2. マスターノードの設定

マスターノード1での起動：

```bash
node index.js \
  --enterprise \
  --mode pool \
  --cluster-workers 16 \
  --shard-count 32 \
  --ha-nodes master2.example.com:5556,master3.example.com:5556 \
  --config ./config/enterprise.json
```

マスターノード2、3でも同様に起動（IPアドレスを適切に変更）。

### 3. ロードバランサーの設定

nginx設定例：

```nginx
upstream otedama_pool {
    least_conn;
    server master1.example.com:3333 weight=1;
    server master2.example.com:3333 weight=1;
    server master3.example.com:3333 weight=1;
}

server {
    listen 3333;
    
    location / {
        proxy_pass http://otedama_pool;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_connect_timeout 10s;
        proxy_send_timeout 10s;
        proxy_read_timeout 10s;
    }
}
```

## 監視設定

### Prometheusエクスポーター

```yaml
# prometheus.yml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'otedama'
    static_configs:
      - targets: 
        - 'master1.example.com:8080'
        - 'master2.example.com:8080'
        - 'master3.example.com:8080'
```

### アラート設定

```yaml
# alerts.yml
groups:
  - name: otedama
    rules:
      - alert: HighCPUUsage
        expr: otedama_cpu_usage > 80
        for: 5m
        annotations:
          summary: "High CPU usage detected"
          
      - alert: LowHashrate
        expr: otedama_hashrate < 1000000000
        for: 10m
        annotations:
          summary: "Hashrate below threshold"
```

## バックアップとリカバリ

### 自動バックアップスクリプト

```bash
#!/bin/bash
# backup.sh

BACKUP_DIR="/backup/otedama"
DATE=$(date +%Y%m%d_%H%M%S)

# データベースのバックアップ
mkdir -p $BACKUP_DIR/$DATE
cp -r /opt/otedama/data/shards $BACKUP_DIR/$DATE/

# 設定ファイルのバックアップ
cp -r /opt/otedama/config $BACKUP_DIR/$DATE/

# 古いバックアップの削除（30日以上）
find $BACKUP_DIR -type d -mtime +30 -exec rm -rf {} \;
```

### リカバリ手順

1. バックアップからデータを復元
2. 全ノードを停止
3. データを配置
4. ノードを順次起動

## パフォーマンスチューニング

### カーネルパラメータ

```bash
# /etc/sysctl.conf
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.ip_local_port_range = 1024 65535
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15
```

### Node.jsパラメータ

```bash
# 起動時の環境変数
export NODE_OPTIONS="--max-old-space-size=8192"
export UV_THREADPOOL_SIZE=128
```

## セキュリティ設定

### ファイアウォール

```bash
# UFW設定
sudo ufw allow 3333/tcp  # Stratum
sudo ufw allow 5556/tcp  # HA データ
sudo ufw allow 6633/tcp  # P2P
sudo ufw allow 8080/tcp  # API
sudo ufw enable
```

### TLS設定

```bash
# Let's Encryptでの証明書取得
sudo certbot certonly --standalone -d pool.example.com
```

## トラブルシューティング

### ログの確認

```bash
# マスターノードのログ
tail -f /var/log/otedama/master.log

# クラスタステータスの確認
curl http://localhost:8080/api/health

# HAステータスの確認
curl http://localhost:8080/api/stats | jq .enterprise.ha
```

### よくある問題

1. **ノードが同期しない**
   - ネットワーク接続を確認
   - ファイアウォール設定を確認
   - 時刻同期を確認（NTP）

2. **パフォーマンスが低い**
   - CPUガバナーをperformanceに設定
   - スワップを無効化
   - ネットワークMTUを最適化

3. **メモリ不足**
   - ワーカー数を削減
   - キャッシュサイズを調整
   - Node.jsヒープサイズを増加

## 運用のベストプラクティス

1. **定期メンテナンス**
   - 週次でのログローテーション
   - 月次でのパフォーマンスレビュー
   - 四半期ごとのセキュリティ監査

2. **キャパシティプランニング**
   - 成長率を監視
   - リソース使用率のトレンド分析
   - スケールアウト計画の策定

3. **障害対策**
   - 定期的な障害訓練
   - リカバリ手順の文書化
   - バックアップの定期テスト

## サポート

エンタープライズサポートについては、以下にお問い合わせください：
- Email: enterprise@otedama.io
- Slack: otedama-enterprise.slack.com