# Otedama 運用管理ガイド

## 概要

本ガイドでは、Otedamaマイニングプールの日常的な運用管理、監視、メンテナンス、トラブルシューティングについて説明します。

## 起動と停止

### 基本的な起動

```bash
# スタンドアロンモードで起動
npm run standalone -- --coinbase-address YOUR_WALLET_ADDRESS

# バックグラウンドで起動（systemd使用）
sudo systemctl start otedama

# プロセスマネージャー（PM2）を使用
pm2 start index.js --name otedama -- --mode standalone --coinbase-address YOUR_ADDRESS
```

### 安全な停止

```bash
# グレースフルシャットダウン
kill -SIGTERM $(pgrep -f "node.*otedama")

# systemd
sudo systemctl stop otedama

# PM2
pm2 stop otedama
```

## プロセス管理

### Systemdサービス設定

```ini
# /etc/systemd/system/otedama.service
[Unit]
Description=Otedama Mining Pool
After=network.target

[Service]
Type=simple
User=otedama
WorkingDirectory=/opt/otedama
ExecStart=/usr/bin/node /opt/otedama/index.js --mode standalone --coinbase-address YOUR_ADDRESS
Restart=always
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=otedama

[Install]
WantedBy=multi-user.target
```

### PM2設定

```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'otedama',
    script: './index.js',
    args: '--mode standalone --coinbase-address YOUR_ADDRESS',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '2G',
    env: {
      NODE_ENV: 'production',
      LOG_LEVEL: 'info'
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_file: './logs/pm2-combined.log',
    time: true
  }]
};
```

## 監視とアラート

### ヘルスチェック

```bash
# 基本的なヘルスチェック
curl http://localhost:8080/api/health

# 詳細なヘルスチェック
curl http://localhost:8080/api/health/detailed

# レスポンス例
{
  "status": "healthy",
  "uptime": 86400,
  "services": {
    "stratum": "running",
    "p2p": "running",
    "blockchain": "connected",
    "database": "healthy"
  },
  "metrics": {
    "cpu": 45.2,
    "memory": 2048,
    "connections": 150
  }
}
```

### メトリクス収集

```bash
# Prometheus形式のメトリクス
curl http://localhost:9090/metrics

# 主要メトリクス
otedama_hashrate_total{algorithm="sha256"} 1234567890
otedama_miners_active 150
otedama_shares_valid_total 98765
otedama_shares_invalid_total 123
otedama_blocks_found_total 3
otedama_peers_connected 5
```

### アラート設定

```yaml
# prometheus/alerts.yml
groups:
  - name: otedama
    rules:
      - alert: HighInvalidShareRate
        expr: rate(otedama_shares_invalid_total[5m]) / rate(otedama_shares_valid_total[5m]) > 0.1
        for: 5m
        annotations:
          summary: "High invalid share rate detected"
          
      - alert: LowHashrate
        expr: otedama_hashrate_total < 1000000000
        for: 10m
        annotations:
          summary: "Pool hashrate below threshold"
          
      - alert: BlockchainDisconnected
        expr: otedama_blockchain_connected == 0
        for: 1m
        annotations:
          summary: "Blockchain connection lost"
```

## ログ管理

### ログ設定

```javascript
// config/logging.json
{
  "logging": {
    "level": "info",
    "format": "json",
    "files": {
      "enabled": true,
      "path": "./logs",
      "maxSize": "100m",
      "maxFiles": 10,
      "compress": true
    },
    "syslog": {
      "enabled": true,
      "host": "localhost",
      "port": 514,
      "facility": "local0"
    }
  }
}
```

### ログローテーション

```bash
# logrotate設定 (/etc/logrotate.d/otedama)
/opt/otedama/logs/*.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    create 0644 otedama otedama
    sharedscripts
    postrotate
        systemctl reload otedama > /dev/null 2>&1 || true
    endscript
}
```

### ログ分析

```bash
# エラーログの確認
grep ERROR logs/otedama.log | tail -20

# 特定のマイナーのログ
grep "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa" logs/otedama.log

# ブロック発見イベント
grep "Block found" logs/otedama.log

# 統計情報の抽出
jq '.level=="info" and .event=="stats"' logs/otedama.log
```

## バックアップとリストア

### 自動バックアップ

```bash
#!/bin/bash
# /opt/otedama/scripts/backup.sh

BACKUP_DIR="/backup/otedama"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_PATH="$BACKUP_DIR/otedama_$TIMESTAMP"

# ディレクトリ作成
mkdir -p $BACKUP_PATH

# データベースバックアップ
cp -r /opt/otedama/data $BACKUP_PATH/

# 設定ファイルバックアップ
cp -r /opt/otedama/config $BACKUP_PATH/

# シェアチェーンバックアップ
cp -r /opt/otedama/shares $BACKUP_PATH/

# 圧縮
tar -czf $BACKUP_PATH.tar.gz -C $BACKUP_DIR otedama_$TIMESTAMP

# 古いバックアップを削除（30日以上）
find $BACKUP_DIR -name "otedama_*.tar.gz" -mtime +30 -delete
```

### リストア手順

```bash
# サービス停止
sudo systemctl stop otedama

# バックアップから復元
tar -xzf /backup/otedama/otedama_20250122_120000.tar.gz -C /tmp
cp -r /tmp/otedama_20250122_120000/* /opt/otedama/

# 権限設定
chown -R otedama:otedama /opt/otedama

# サービス再起動
sudo systemctl start otedama
```

## パフォーマンスチューニング

### CPU最適化

```bash
# CPUアフィニティ設定
taskset -c 0-7 node index.js --mode standalone

# NUMA最適化
numactl --cpunodebind=0 --membind=0 node index.js
```

### メモリ最適化

```bash
# Node.jsヒープサイズ設定
export NODE_OPTIONS="--max-old-space-size=4096"

# メモリ使用量の監視
node --expose-gc index.js --mode standalone
```

### ネットワーク最適化

```bash
# TCP設定の最適化
sudo sysctl -w net.core.somaxconn=1024
sudo sysctl -w net.ipv4.tcp_max_syn_backlog=2048
sudo sysctl -w net.ipv4.tcp_fin_timeout=30
```

## データベースメンテナンス

### SQLite最適化

```bash
# VACUUM実行（データベース最適化）
sqlite3 /opt/otedama/data/otedama.db "VACUUM;"

# インデックスの再構築
sqlite3 /opt/otedama/data/otedama.db "REINDEX;"

# 統計情報の更新
sqlite3 /opt/otedama/data/otedama.db "ANALYZE;"
```

### データベース統計

```sql
-- テーブルサイズ確認
SELECT 
    name,
    SUM(pgsize) as size_bytes,
    ROUND(SUM(pgsize)/1024.0/1024.0, 2) as size_mb
FROM dbstat
GROUP BY name
ORDER BY size_bytes DESC;

-- シェア数の確認
SELECT COUNT(*) FROM shares;
SELECT COUNT(*) FROM shares WHERE timestamp > datetime('now', '-1 day');
```

## トラブルシューティング

### 一般的な問題

#### 1. ブロックチェーン接続エラー

```bash
# 接続状態確認
curl http://localhost:8080/api/blockchain/status

# ブロックチェーンノードの確認
bitcoin-cli getblockchaininfo

# 設定確認
grep -E "blockchain|rpc" logs/otedama.log
```

#### 2. 高い無効シェア率

```bash
# 無効シェアの分析
curl http://localhost:8080/api/shares/invalid/analysis

# 特定のマイナーの確認
curl http://localhost:8080/api/miner/ADDRESS/shares/invalid
```

#### 3. メモリリーク

```bash
# メモリ使用量の監視
node --trace-gc index.js > gc.log 2>&1

# ヒープダンプの取得
kill -USR2 $(pgrep -f "node.*otedama")

# ヒープダンプの分析
node --inspect index.js
```

### 診断ツール

```bash
# 診断レポートの生成
curl http://localhost:8080/api/diagnostics/report > diagnostics.json

# システム状態のスナップショット
./scripts/diagnostic-snapshot.sh

# パフォーマンスプロファイリング
node --prof index.js
node --prof-process isolate-*.log > profile.txt
```

## セキュリティ運用

### 定期的なセキュリティチェック

```bash
# セキュリティスキャン
npm audit
./scripts/security-scan.sh

# 設定の検証
node index.js --validate-security-config

# ログの監査
grep -E "auth\.failed|security\.violation" logs/security.log
```

### インシデント対応

```bash
# 不審なアクティビティの調査
./scripts/investigate-ip.sh 192.168.1.100

# 緊急時のアクセス制限
iptables -A INPUT -s SUSPICIOUS_IP -j DROP

# セキュリティログのエクスポート
./scripts/export-security-logs.sh --from "2025-01-20" --to "2025-01-22"
```

## 災害復旧

### 災害復旧計画

1. **RPO（目標復旧時点）**: 1時間
2. **RTO（目標復旧時間）**: 4時間

### 復旧手順

```bash
# 1. 新しいサーバーの準備
./scripts/prepare-dr-server.sh

# 2. バックアップからの復元
./scripts/restore-from-backup.sh --latest

# 3. 設定の検証
node index.js --validate-config

# 4. サービスの起動
sudo systemctl start otedama

# 5. 動作確認
./scripts/post-recovery-check.sh
```

## 定期メンテナンス

### 日次タスク

```bash
# cronジョブ設定
0 0 * * * /opt/otedama/scripts/daily-maintenance.sh
```

### 週次タスク

```bash
# データベース最適化
0 2 * * 0 sqlite3 /opt/otedama/data/otedama.db "VACUUM;"

# ログのアーカイブ
0 3 * * 0 /opt/otedama/scripts/archive-logs.sh
```

### 月次タスク

```bash
# セキュリティ更新の確認
0 4 1 * * /opt/otedama/scripts/check-updates.sh

# パフォーマンスレポートの生成
0 5 1 * * /opt/otedama/scripts/generate-monthly-report.sh
```

## 監視ダッシュボード

### Grafanaダッシュボード設定

```json
{
  "dashboard": {
    "title": "Otedama Mining Pool",
    "panels": [
      {
        "title": "Total Hashrate",
        "targets": [{
          "expr": "otedama_hashrate_total"
        }]
      },
      {
        "title": "Active Miners",
        "targets": [{
          "expr": "otedama_miners_active"
        }]
      },
      {
        "title": "Share Validity",
        "targets": [{
          "expr": "rate(otedama_shares_valid_total[5m])"
        }]
      }
    ]
  }
}
```

## ベストプラクティス

1. **定期的なモニタリング**
   - 15分ごとのヘルスチェック
   - 1時間ごとの統計レポート
   - 日次のログレビュー

2. **プロアクティブなメンテナンス**
   - 週次のデータベース最適化
   - 月次のセキュリティ更新
   - 四半期ごとの災害復旧訓練

3. **ドキュメント化**
   - 全ての変更を記録
   - インシデントレポートの作成
   - 運用手順書の更新