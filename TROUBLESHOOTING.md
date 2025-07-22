# Otedama トラブルシューティングガイド

## 目次

1. [起動時の問題](#起動時の問題)
2. [接続の問題](#接続の問題)
3. [マイニングの問題](#マイニングの問題)
4. [パフォーマンスの問題](#パフォーマンスの問題)
5. [セキュリティの問題](#セキュリティの問題)
6. [データベースの問題](#データベースの問題)
7. [診断ツール](#診断ツール)
8. [よくある質問（FAQ）](#faq)

## 起動時の問題

### エラー: "Cannot find module"

**症状**: モジュールが見つからないエラー

```
Error: Cannot find module 'sqlite3'
```

**解決方法**:

```bash
# 依存関係を再インストール
npm install

# 特定のモジュールのみインストール
npm install sqlite3

# ネイティブモジュールの再ビルド
npm rebuild
```

### エラー: "Address already in use"

**症状**: ポートが既に使用中

```
Error: listen EADDRINUSE: address already in use :::3333
```

**解決方法**:

```bash
# 使用中のポートを確認
netstat -tlnp | grep 3333
lsof -i :3333

# プロセスを終了
kill -9 <PID>

# 別のポートを使用
node index.js --stratum-port 3334
```

### エラー: "Permission denied"

**症状**: 権限エラー

**解決方法**:

```bash
# ファイル権限を修正
chmod +x index.js
chown -R $USER:$USER .

# 特権ポート（<1024）を使用する場合
sudo setcap 'cap_net_bind_service=+ep' $(which node)
```

## 接続の問題

### マイナーが接続できない

**症状**: マイナーがプールに接続できない

**診断**:

```bash
# ポートが開いているか確認
nc -zv localhost 3333

# ファイアウォールの確認
sudo ufw status
sudo iptables -L

# Stratumサーバーの状態確認
curl http://localhost:8080/api/stratum/status
```

**解決方法**:

```bash
# ファイアウォールでポートを開放
sudo ufw allow 3333/tcp

# iptablesで開放
sudo iptables -A INPUT -p tcp --dport 3333 -j ACCEPT
```

### ブロックチェーンに接続できない

**症状**: "Blockchain connection failed"エラー

**診断**:

```bash
# ブロックチェーンノードの確認
bitcoin-cli getblockchaininfo

# RPC設定の確認
cat ~/.bitcoin/bitcoin.conf
```

**解決方法**:

```bash
# bitcoin.confの設定
server=1
rpcuser=your_username
rpcpassword=your_password
rpcallowip=127.0.0.1
rpcport=8332

# Otedamaの起動時に正しい認証情報を指定
node index.js --blockchain-user your_username --blockchain-pass your_password
```

### P2Pネットワークに参加できない

**症状**: 他のピアが見つからない

**診断**:

```bash
# UDPポートの確認
nc -u -zv localhost 6633

# マルチキャストの確認
ip maddr show
```

**解決方法**:

```bash
# UDPポートを開放
sudo ufw allow 6633/udp

# マルチキャストルーティングを有効化
sudo route add -net 224.0.0.0 netmask 240.0.0.0 dev eth0
```

## マイニングの問題

### 高い無効シェア率

**症状**: 無効シェアが多い（>5%）

**診断**:

```bash
# シェア統計の確認
curl http://localhost:8080/api/shares/stats

# 特定のマイナーの確認
curl http://localhost:8080/api/miner/YOUR_ADDRESS/invalid-shares
```

**解決方法**:

1. **難易度が高すぎる場合**:
   ```bash
   # 初期難易度を下げる
   node index.js --diff-initial 8
   ```

2. **ネットワーク遅延が大きい場合**:
   ```bash
   # タイムアウトを延長
   node index.js --share-timeout 30000
   ```

3. **マイナーソフトウェアの設定**:
   ```bash
   # マイナー側で適切な難易度を設定
   xmrig -o localhost:3333 -u ADDRESS --pass d=16
   ```

### ブロックが見つからない

**症状**: 長期間ブロックが見つからない

**診断**:

```bash
# プールのハッシュレート確認
curl http://localhost:8080/api/stats | jq .hashrate

# ネットワーク難易度の確認
bitcoin-cli getmininginfo
```

**解決方法**:

- ハッシュレートが低い場合は、より多くのマイナーを集める
- 難易度が高すぎる通貨の場合は、別の通貨を検討
- P2Pモードで他のプールと協力

### 報酬が支払われない

**症状**: 残高があるのに支払いがされない

**診断**:

```bash
# 支払い状態の確認
curl http://localhost:8080/api/payments/pending

# 支払い設定の確認
curl http://localhost:8080/api/config | jq .payouts
```

**解決方法**:

```bash
# 最小支払額を確認・調整
node index.js --min-payout 0.0001

# 手動で支払いを実行
curl -X POST http://localhost:8080/api/payments/process \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

## パフォーマンスの問題

### CPU使用率が高い

**症状**: CPU使用率が常に100%近い

**診断**:

```bash
# プロセスの確認
top -p $(pgrep -f "node.*otedama")

# Node.jsプロファイリング
node --prof index.js
```

**解決方法**:

```bash
# ワーカースレッド数を調整
node index.js --workers 4

# シェア検証の最適化
node index.js --fast-validation
```

### メモリ使用量が増加し続ける

**症状**: メモリリークの可能性

**診断**:

```bash
# メモリ使用量の監視
node --trace-gc index.js

# ヒープダンプの取得
kill -USR2 $(pgrep -f "node.*otedama")
```

**解決方法**:

```bash
# Node.jsのメモリ制限を設定
export NODE_OPTIONS="--max-old-space-size=2048"

# ガベージコレクションの調整
node --expose-gc --gc-interval=100 index.js
```

### レスポンスが遅い

**症状**: API応答時間が長い

**診断**:

```bash
# レスポンスタイムの測定
time curl http://localhost:8080/api/stats

# データベースクエリの確認
sqlite3 data/otedama.db "EXPLAIN QUERY PLAN SELECT * FROM shares;"
```

**解決方法**:

```bash
# キャッシュサイズを増やす
node index.js --cache-size 1024

# データベースの最適化
sqlite3 data/otedama.db "VACUUM; ANALYZE;"
```

## セキュリティの問題

### 不正なアクセス試行

**症状**: ログに多数の認証失敗

**診断**:

```bash
# セキュリティログの確認
grep "auth.failed" logs/security.log | tail -20

# IPアドレス別の失敗回数
grep "auth.failed" logs/security.log | awk '{print $5}' | sort | uniq -c | sort -rn
```

**解決方法**:

```bash
# 特定のIPをブロック
iptables -A INPUT -s MALICIOUS_IP -j DROP

# fail2banの設定
sudo apt install fail2ban
sudo cp /opt/otedama/config/fail2ban.conf /etc/fail2ban/jail.d/otedama.conf
sudo systemctl restart fail2ban
```

### DDoS攻撃

**症状**: 大量の接続要求

**診断**:

```bash
# 接続数の確認
netstat -an | grep :3333 | wc -l

# 接続元IPの分析
netstat -an | grep :3333 | awk '{print $5}' | cut -d: -f1 | sort | uniq -c | sort -rn
```

**解決方法**:

```bash
# レート制限を強化
node index.js --rate-limit 10 --rate-window 60000

# CloudflareやDDoS防御サービスの利用を検討
```

## データベースの問題

### データベースが破損

**症状**: "database disk image is malformed"

**診断**:

```bash
# データベースの整合性チェック
sqlite3 data/otedama.db "PRAGMA integrity_check;"
```

**解決方法**:

```bash
# バックアップから復元
cp backup/otedama.db data/otedama.db

# 破損したデータベースの修復を試みる
sqlite3 data/otedama.db ".dump" | sqlite3 data/otedama_new.db
mv data/otedama_new.db data/otedama.db
```

### データベースがロックされる

**症状**: "database is locked"エラー

**解決方法**:

```bash
# WALモードを有効化（config/default.json）
{
  "database": {
    "options": {
      "wal": true,
      "busyTimeout": 5000
    }
  }
}

# ロックされたプロセスを特定
fuser data/otedama.db
```

## 診断ツール

### 総合診断

```bash
# 診断スクリプトの実行
./scripts/diagnose.sh

# 出力例：
=== Otedama Diagnostics ===
[✓] Node.js version: v18.17.0
[✓] Port 3333: Open
[✓] Port 8080: Open
[✓] Database: Accessible
[✓] Blockchain: Connected
[✗] P2P: No peers found
[!] High invalid share rate: 8.5%
```

### ログ分析

```bash
# エラーパターンの分析
./scripts/analyze-logs.sh --since "1 hour ago"

# 特定のイベントの追跡
grep -A5 -B5 "ERROR" logs/otedama.log
```

### パフォーマンス分析

```bash
# リアルタイムモニタリング
./scripts/monitor.sh

# ボトルネックの特定
node --inspect index.js
# Chrome DevToolsで chrome://inspect にアクセス
```

## FAQ

### Q: どのくらいのハッシュレートが必要ですか？

A: 通貨と難易度によりますが、安定した収益を得るには：
- Bitcoin: 最低100 TH/s
- Litecoin: 最低1 GH/s
- Monero: 最低100 KH/s

### Q: 電気代を考慮しても利益は出ますか？

A: 以下の計算式で確認してください：
```
日次利益 = (ブロック報酬 × プール発見率) - (消費電力kW × 24時間 × 電気代/kWh)
```

### Q: 最適なワーカー数は？

A: CPUコア数の2倍程度が目安です：
```bash
# CPUコア数の確認
nproc

# 推奨ワーカー数
echo $(($(nproc) * 2))
```

### Q: バックアップはどのくらいの頻度で？

A: 推奨頻度：
- データベース: 1時間ごと
- 設定ファイル: 変更時
- シェアチェーン: 6時間ごと

### Q: メモリ不足の対処法は？

A: 以下の順に試してください：
1. スワップファイルの追加
2. キャッシュサイズの削減
3. ワーカー数の削減
4. 物理メモリの増設

### Q: ログファイルが大きくなりすぎる

A: ログローテーションを設定：
```bash
# logrotateの設定
sudo vim /etc/logrotate.d/otedama

# 手動でローテーション
sudo logrotate -f /etc/logrotate.d/otedama
```

## サポート

問題が解決しない場合は：

1. **ログを確認**: `logs/`ディレクトリの最新ログ
2. **診断情報を収集**: `./scripts/collect-diagnostics.sh`
3. **GitHubでIssueを作成**: 診断情報を添付
4. **コミュニティフォーラム**: より詳しい支援

緊急時の連絡先：
- GitHub Issues: https://github.com/otedama/otedama/issues
- Discord: https://discord.gg/otedama