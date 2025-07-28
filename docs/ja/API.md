# Otedama API ドキュメント

## 目次

1. [概要](#概要)
2. [認証](#認証)
3. [ベースURL](#ベースurl)
4. [共通レスポンス形式](#共通レスポンス形式)
5. [エンドポイント](#エンドポイント)
   - [マイニング操作](#マイニング操作)
   - [プール統計](#プール統計)
   - [マイナー管理](#マイナー管理)
   - [支払い操作](#支払い操作)
   - [システム情報](#システム情報)

## 概要

Otedama APIは、マイニングプールの操作、統計、管理機能へのプログラマティックアクセスを提供します。すべてのAPIレスポンスはJSON形式で、RESTとWebSocketの両方の接続をサポートしています。

## 認証

Otedamaは、プライバシーを保護するアクセス制御のためにゼロ知識証明（ZKP）認証を使用します。

### ZKP認証フロー

```http
POST /api/v1/auth/zkp/challenge
```

リクエストボディ:
```json
{
  "minerId": "your_miner_id"
}
```

レスポンス:
```json
{
  "challenge": "random_challenge_string",
  "timestamp": 1234567890
}
```

### 証明の送信

```http
POST /api/v1/auth/zkp/verify
```

リクエストボディ:
```json
{
  "minerId": "your_miner_id",
  "proof": "zkp_proof_data",
  "challenge": "random_challenge_string"
}
```

レスポンス:
```json
{
  "token": "jwt_access_token",
  "expiresIn": 3600
}
```

## ベースURL

```
http://localhost:8080/api/v1
```

本番環境では、`localhost:8080`をサーバーアドレスに置き換えてください。

## 共通レスポンス形式

すべてのAPIレスポンスは次の形式に従います：

```json
{
  "success": true,
  "data": {},
  "timestamp": 1234567890
}
```

エラーレスポンス:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "人間が読めるエラーメッセージ"
  },
  "timestamp": 1234567890
}
```

## エンドポイント

### マイニング操作

#### シェアの送信

```http
POST /api/v1/mining/share
```

検証のためにマイニングシェアを送信します。

リクエスト:
```json
{
  "minerId": "miner_123",
  "jobId": "job_456",
  "nonce": "0x12345678",
  "hash": "0xabcdef...",
  "difficulty": 1000000
}
```

レスポンス:
```json
{
  "success": true,
  "data": {
    "accepted": true,
    "difficulty": 1000000,
    "reward": 0.00001234
  }
}
```

#### マイニングジョブの取得

```http
GET /api/v1/mining/job/:minerId
```

特定のマイナーの現在のマイニングジョブを取得します。

レスポンス:
```json
{
  "success": true,
  "data": {
    "jobId": "job_789",
    "prevHash": "0x123...",
    "coinbase": "0x456...",
    "merkleRoot": "0x789...",
    "difficulty": 1000000,
    "algorithm": "sha256"
  }
}
```

### プール統計

#### プール概要の取得

```http
GET /api/v1/pool/stats
```

プール全体の統計を取得します。

レスポンス:
```json
{
  "success": true,
  "data": {
    "hashrate": 1234567890000,
    "miners": 1234,
    "blocksFound": 567,
    "luck": 98.5,
    "networkDifficulty": 23456789012345,
    "poolDifficulty": 1000000
  }
}
```

#### マイニング履歴の取得

```http
GET /api/v1/pool/blocks?limit=10&offset=0
```

最近発見されたブロックを取得します。

レスポンス:
```json
{
  "success": true,
  "data": {
    "blocks": [
      {
        "height": 123456,
        "hash": "0x123...",
        "reward": 6.25,
        "foundBy": "miner_123",
        "timestamp": 1234567890
      }
    ],
    "total": 567
  }
}
```

### マイナー管理

#### マイナー統計の取得

```http
GET /api/v1/miner/:minerId/stats
```

特定のマイナーの統計を取得します。

レスポンス:
```json
{
  "success": true,
  "data": {
    "minerId": "miner_123",
    "hashrate": 1234567890,
    "shares": {
      "accepted": 1000,
      "rejected": 10,
      "stale": 5
    },
    "uptime": 86400,
    "lastSeen": 1234567890,
    "earnings": {
      "total": 0.12345678,
      "pending": 0.00123456,
      "paid": 0.12222222
    }
  }
}
```

#### マイナー設定の更新

```http
PUT /api/v1/miner/:minerId/settings
```

マイナーの設定を更新します。

リクエスト:
```json
{
  "difficulty": 1000000,
  "payoutAddress": "bc1q...",
  "minPayout": 0.001
}
```

### 支払い操作

#### 支払い履歴の取得

```http
GET /api/v1/payments/:minerId?limit=10
```

マイナーの支払い履歴を取得します。

レスポンス:
```json
{
  "success": true,
  "data": {
    "payments": [
      {
        "txid": "0x123...",
        "amount": 0.01234567,
        "timestamp": 1234567890,
        "status": "confirmed"
      }
    ]
  }
}
```

#### 支払いリクエスト

```http
POST /api/v1/payments/payout
```

手動支払いをリクエストします（残高が最小値を満たしている場合）。

リクエスト:
```json
{
  "minerId": "miner_123",
  "amount": 0.01,
  "address": "bc1q..."
}
```

### システム情報

#### ヘルスチェック

```http
GET /api/v1/health
```

APIのヘルスステータスを確認します。

レスポンス:
```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "version": "1.1.8",
    "uptime": 86400
  }
}
```

## WebSocket API

リアルタイム更新のために接続：

```
ws://localhost:8080/ws
```

### 更新の購読

```json
{
  "type": "subscribe",
  "channels": ["stats", "blocks", "miner:miner_123"]
}
```

### リアルタイムイベント

プール統計の更新:
```json
{
  "type": "stats",
  "data": {
    "hashrate": 1234567890000,
    "miners": 1234
  }
}
```

新しいブロックの発見:
```json
{
  "type": "block",
  "data": {
    "height": 123456,
    "reward": 6.25,
    "foundBy": "miner_123"
  }
}
```

## レート制限

APIリクエストは以下に制限されます：
- 認証済みユーザー：1分あたり100リクエスト
- 未認証ユーザー：1分あたり20リクエスト

レート制限ヘッダー:
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1234567890
```

## エラーコード

| コード | 説明 |
|------|------|
| `AUTH_REQUIRED` | 認証が必要です |
| `INVALID_PROOF` | 無効なZKP証明 |
| `RATE_LIMITED` | レート制限を超過しました |
| `INVALID_SHARE` | シェアの検証に失敗しました |
| `INSUFFICIENT_BALANCE` | 支払いには残高が不足しています |
| `MINER_NOT_FOUND` | マイナーIDが見つかりません |
| `INTERNAL_ERROR` | サーバーエラー |

## SDK サンプル

### Node.js

```javascript
const OtedamaAPI = require('otedama-sdk');

const client = new OtedamaAPI({
  baseUrl: 'http://localhost:8080',
  minerId: 'miner_123'
});

// 認証
await client.authenticate();

// 統計の取得
const stats = await client.getMinerStats();
console.log('ハッシュレート:', stats.hashrate);
```

### Python

```python
from otedama_sdk import OtedamaClient

client = OtedamaClient(
    base_url='http://localhost:8080',
    miner_id='miner_123'
)

# 認証
client.authenticate()

# シェアの送信
result = client.submit_share(
    job_id='job_456',
    nonce='0x12345678',
    hash='0xabcdef...'
)
```

## サポート

APIサポートについては：
- `/docs`のドキュメントを確認してください
- GitHub Issuesで問題を報告してください
- コミュニティフォーラムに参加してください