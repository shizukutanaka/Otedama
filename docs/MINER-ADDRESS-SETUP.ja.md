# マイナーアドレス設定ガイド

## 🔐 アドレスシステムの概要

Otedamaはセキュリティと透明性のために**デュアルアドレスシステム**を使用しています：

1. **プール運営者アドレス**（固定）: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`
   - このアドレスはプール手数料（1%）を受け取ります
   - 変更や修正はできません
   - セキュリティのためハードコードされています

2. **マイナーアドレス**（柔軟）: あなたの個人ウォレットアドレス
   - 任意の有効なBitcoinアドレスを使用できます
   - すべてのアドレス形式をサポート
   - 各マイナーは独自のアドレスを使用します

## 📝 マイナーとしての接続

### 基本的な接続

```bash
# あなたのBitcoinアドレスで接続
cgminer -o stratum+tcp://pool.otedama.local:3333 \
        -u YOUR_BITCOIN_ADDRESS \
        -p x
```


## 💰 支払いの仕組み

Otedamaでマイニングすると：

1. **あなたのマイニング報酬**（99%）
   - YOUR_BITCOIN_ADDRESSに直接送金されます
   - 最小支払い額: 0.001 BTC
   - 毎日00:00 UTCに支払い

2. **プール手数料**（1%）
   - 自動的に差し引かれます
   - プール運営者に送金: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`
   - プール開発とサーバー費用をサポート

## 🌍 マルチコインマイニング

### Bitcoin (BTC)
```bash
-u YOUR_BITCOIN_ADDRESS
```

### Litecoin (LTC)
```bash
-u YOUR_LITECOIN_ADDRESS -o stratum+tcp://pool.otedama.local:3334
```

### Ethereum Classic (ETC)
```bash
-u YOUR_ETHEREUM_ADDRESS -o stratum+tcp://pool.otedama.local:3335
```

### Monero (XMR)
```bash
-u YOUR_MONERO_ADDRESS -o stratum+tcp://pool.otedama.local:3336
```

### Ravencoin (RVN)
```bash
-u YOUR_RAVENCOIN_ADDRESS -o stratum+tcp://pool.otedama.local:3337
```

## ⚠️ 重要な注意事項

### できること：
- ✅ 任意の有効なBitcoinアドレス形式を使用
- ✅ いつでもマイニングアドレスを変更
- ✅ 異なるワーカーに異なるアドレスを使用
- ✅ 取引所アドレスへのマイニング
- ✅ テスト用にテストネットアドレスを使用

### できないこと：
- ❌ プール運営者アドレス（`1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`）を使用
- ❌ プール手数料の割合を変更（1%に固定）
- ❌ 無効なアドレス形式を使用
- ❌ 有効なアドレスなしでマイニング

## 🔍 アドレス検証

接続前にアドレスを確認：

```bash
# アドレスが有効かチェック
curl -X POST http://pool.otedama.local:8081/api/v1/validate-address \
  -H "Content-Type: application/json" \
  -d '{"address": "YOUR_BITCOIN_ADDRESS"}'
```

レスポンス：
```json
{
  "valid": true,
  "type": "SEGWIT",
  "coin": "BTC",
  "format": "segwit"
}
```

## 🛠️ トラブルシューティング

### 「無効なウォレットアドレス」
- アドレス形式が正しいことを確認
- 余分なスペースや文字がないことを確認
- プール運営者アドレスでないことを確認

### 「認証失敗」
- アドレスが不正な形式かもしれません
- 別のアドレス形式で試してください
- ネットワーク接続を確認

### 「プール運営者アドレスは使用できません」
- `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`へのマイニングはできません
- 自分のBitcoinアドレスを使用してください

## 📊 マイニングの監視

### 統計情報の確認
```bash
curl http://pool.otedama.local:8081/api/v1/miner/YOUR_BITCOIN_ADDRESS
```

### 保留中の残高を表示
```bash
curl http://pool.otedama.local:8081/api/v1/balance/YOUR_BITCOIN_ADDRESS
```

### 支払い履歴
```bash
curl http://pool.otedama.local:8081/api/v1/payouts/YOUR_BITCOIN_ADDRESS
```

## 🤝 サポート

マイナーアドレスに関する問題がある場合：
- まずこのガイドを確認
- アドレス形式を検証
- アドレスを含めてサポートに連絡（秘密鍵は絶対に聞きません！）

---

覚えておいてください：
- **あなたのアドレス** = あなたのマイニング報酬
- **プール運営者アドレス** = プール手数料（自動）
- 秘密鍵を安全に保管してください！