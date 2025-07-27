# Miner Address Setup Guide / マイナーアドレス設定ガイド

[English](#english) | [日本語](#japanese)

---

<a name="english"></a>
## 🔐 Address System Overview

Otedama uses a **dual-address system** for security and transparency:

1. **Pool Operator Address** (Fixed): `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`
   - This address receives pool fees (1%)
   - Cannot be changed or modified
   - Hardcoded for security

2. **Miner Addresses** (Flexible): Your personal wallet address
   - You can use any valid Bitcoin address
   - Supports all address formats
   - Each miner uses their own address

## 📝 Connecting as a Miner

### Basic Connection

```bash
# Connect with your Bitcoin address
cgminer -o stratum+tcp://pool.otedama.local:3333 \
        -u YOUR_BITCOIN_ADDRESS \
        -p x
```

## 💰 How Payouts Work

When you mine on Otedama:

1. **Your Mining Rewards** (99%)
   - Sent directly to YOUR_BITCOIN_ADDRESS
   - Minimum payout: 0.001 BTC
   - Daily payouts at 00:00 UTC

2. **Pool Fee** (1%)
   - Automatically deducted
   - Sent to pool operator: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`
   - Supports pool development and server costs

## 🌍 Multi-Coin Mining

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

## ⚠️ Important Notes

### What You CAN Do:
- ✅ Use any valid Bitcoin address format
- ✅ Change your mining address anytime
- ✅ Use different addresses for different workers
- ✅ Mine to exchange addresses
- ✅ Use testnet addresses for testing

### What You CANNOT Do:
- ❌ Use invalid address formats
- ❌ Mine without a valid address

## 🔍 Address Validation

Before connecting, verify your address:

```bash
# Check if your address is valid
curl -X POST http://pool.otedama.local:8081/api/v1/validate-address \
  -H "Content-Type: application/json" \
  -d '{"address": "YOUR_BITCOIN_ADDRESS"}'
```

Response:
```json
{
  "valid": true,
  "type": "SEGWIT",
  "coin": "BTC",
  "format": "segwit"
}
```

## 🛠️ Troubleshooting

### "Invalid wallet address"
- Check address format is correct
- Ensure no extra spaces or characters
- Verify it's not the pool operator address

### "Authorization failed"
- Address might be malformed
- Try with a different address format
- Check network connectivity

## 📊 Monitoring Your Mining

### Check Your Stats
```bash
curl http://pool.otedama.local:8081/api/v1/miner/YOUR_BITCOIN_ADDRESS
```

### View Pending Balance
```bash
curl http://pool.otedama.local:8081/api/v1/balance/YOUR_BITCOIN_ADDRESS
```

### Payout History
```bash
curl http://pool.otedama.local:8081/api/v1/payouts/YOUR_BITCOIN_ADDRESS
```

Remember: 
- **Your address** = Your mining rewards
- **Pool operator address** = Pool fees (automatic)
- Keep your private keys safe!

---

<a name="japanese"></a>
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

覚えておいてください：
- **あなたのアドレス** = あなたのマイニング報酬
- **プール運営者アドレス** = プール手数料（自動）
- 秘密鍵を安全に保管してください！