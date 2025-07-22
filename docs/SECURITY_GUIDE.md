# Otedama セキュリティガイド

## 概要

Otedamaは国家レベルでの使用にも対応できる堅牢なセキュリティ機能を実装しています。本ガイドでは、セキュリティ機能の詳細と設定方法を説明します。

## 認証システム

### JWT認証

Otedamaは管理機能へのアクセスにJWT（JSON Web Token）認証を使用します。

#### 設定

```bash
# 環境変数
export JWT_SECRET=your_64_character_random_string_here
export JWT_EXPIRES_IN=3600        # アクセストークン有効期限（秒）
export JWT_REFRESH_EXPIRES_IN=604800  # リフレッシュトークン有効期限（秒）
```

#### 使用方法

```javascript
// ログイン
const response = await fetch('http://localhost:8080/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: 'admin',
    password: 'secure_password'
  })
});

const { accessToken, refreshToken } = await response.json();

// 認証が必要なAPIへのアクセス
await fetch('http://localhost:8080/api/config', {
  headers: {
    'Authorization': `Bearer ${accessToken}`
  }
});
```

### 2要素認証（2FA）

TOTPベースの2要素認証をサポートしています。

#### 有効化

```bash
# 2FAを有効化
curl -X POST http://localhost:8080/api/auth/2fa/enable \
  -H "Authorization: Bearer YOUR_TOKEN"

# レスポンス
{
  "secret": "JBSWY3DPEHPK3PXP",
  "qrCode": "data:image/png;base64,..."
}
```

#### 検証

```bash
# TOTPコードを検証
curl -X POST http://localhost:8080/api/auth/2fa/verify \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"token": "123456"}'
```

### ロールベースアクセス制御（RBAC）

3つの基本ロールを提供：

1. **admin**: 全機能へのアクセス
2. **operator**: 監視と基本操作
3. **viewer**: 読み取り専用

#### ロール設定

```javascript
// lib/security/auth-manager.js
const roles = {
  admin: ['*'],
  operator: ['pool:manage', 'miner:view', 'stats:view'],
  viewer: ['stats:view', 'miner:view']
};
```

## ネットワークセキュリティ

### DDoS保護

トークンバケット方式のレート制限を実装：

```bash
# 設定
export RATE_LIMIT_WINDOW=60000    # ウィンドウサイズ（ミリ秒）
export RATE_LIMIT_MAX=100         # 最大リクエスト数
export RATE_LIMIT_BURST=150       # バーストサイズ

# カスタム設定
node index.js --rate-limit 100 --rate-window 60000 --rate-burst 150
```

### IP制限とファイアウォール

```javascript
// config/security.json
{
  "network": {
    "allowedIPs": [
      "192.168.1.0/24",
      "10.0.0.0/8"
    ],
    "blockedIPs": [
      "192.168.1.100"
    ],
    "geoBlocking": {
      "enabled": true,
      "allowedCountries": ["JP", "US", "GB"],
      "blockedCountries": []
    }
  }
}
```

### SSL/TLS設定

```bash
# HTTPS有効化
node index.js --ssl-enabled \
  --ssl-cert /path/to/cert.pem \
  --ssl-key /path/to/key.pem \
  --ssl-ca /path/to/ca.pem
```

## データ暗号化

### 保存データの暗号化

AES-256-GCMを使用した暗号化：

```bash
# 暗号化キー設定
export ENCRYPTION_KEY=your_32_character_key_here
export ENCRYPTION_ALGORITHM=aes-256-gcm
```

### キーローテーション

```javascript
// 定期的なキーローテーション
const encryptionManager = require('./lib/security/encryption-manager');

// 30日ごとにキーをローテーション
encryptionManager.setKeyRotationPeriod(30 * 24 * 60 * 60 * 1000);

// 手動でキーをローテーション
await encryptionManager.rotateKey();
```

## 入力検証とサニタイズ

### バリデーションルール

```javascript
// lib/security/input-validator.js
const rules = {
  walletAddress: {
    type: 'string',
    pattern: /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/,
    required: true
  },
  amount: {
    type: 'number',
    min: 0.00000001,
    max: 21000000,
    required: true
  },
  workerName: {
    type: 'string',
    pattern: /^[a-zA-Z0-9_-]{1,20}$/,
    sanitize: true
  }
};
```

### SQLインジェクション対策

```javascript
// パラメータ化クエリの使用
const db = require('./lib/database');

// 安全
const miner = await db.get(
  'SELECT * FROM miners WHERE address = ?',
  [address]
);

// 危険（使用禁止）
// const miner = await db.get(
//   `SELECT * FROM miners WHERE address = '${address}'`
// );
```

## セキュリティヘッダー

### 推奨設定

```javascript
// config/security.json
{
  "headers": {
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "X-XSS-Protection": "1; mode=block",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Content-Security-Policy": "default-src 'self'",
    "Referrer-Policy": "strict-origin-when-cross-origin"
  }
}
```

## 監査とログ

### セキュリティイベントログ

```javascript
// 重要なイベントを記録
const events = [
  'auth.login',
  'auth.logout',
  'auth.failed',
  'auth.2fa.enabled',
  'config.changed',
  'payout.executed',
  'block.found'
];

// ログフォーマット
{
  timestamp: '2025-01-22T10:30:00Z',
  event: 'auth.login',
  user: 'admin',
  ip: '192.168.1.100',
  userAgent: 'Mozilla/5.0...',
  success: true,
  details: {}
}
```

### ログ保護

```bash
# ログファイルの暗号化
export LOG_ENCRYPTION=true
export LOG_ENCRYPTION_KEY=your_log_encryption_key

# ログローテーション設定
export LOG_MAX_SIZE=100m
export LOG_MAX_FILES=10
export LOG_COMPRESS=true
```

## セッション管理

### セッション設定

```javascript
// config/security.json
{
  "session": {
    "timeout": 3600000,        // 1時間
    "slidingExpiration": true, // アクティビティで延長
    "maxSessions": 5,          // ユーザーあたりの最大セッション数
    "singleSession": false     // シングルセッションモード
  }
}
```

### セッション無効化

```bash
# 特定ユーザーのセッションを無効化
curl -X POST http://localhost:8080/api/auth/revoke-sessions \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"username": "user123"}'
```

## セキュリティスキャン

### 自動脆弱性スキャン

```bash
# セキュリティスキャンの実行
npm run security-scan

# 定期スキャンの設定
node index.js --security-scan-interval 86400000  # 24時間ごと
```

### 依存関係の監査

```bash
# npm audit
npm audit

# 修正の適用
npm audit fix

# 強制修正（破壊的変更の可能性）
npm audit fix --force
```

## インシデント対応

### 自動対応

```javascript
// config/security.json
{
  "incident": {
    "autoBlock": {
      "enabled": true,
      "threshold": 10,        // 10回の失敗試行
      "window": 300000,       // 5分間
      "duration": 3600000     // 1時間ブロック
    },
    "notification": {
      "enabled": true,
      "email": "security@example.com",
      "webhook": "https://example.com/security-webhook"
    }
  }
}
```

### 手動対応

```bash
# IPをブロック
curl -X POST http://localhost:8080/api/security/block-ip \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ip": "192.168.1.100", "reason": "Suspicious activity"}'

# ブロック解除
curl -X DELETE http://localhost:8080/api/security/block-ip/192.168.1.100 \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

## ベストプラクティス

### 初期設定

1. **デフォルトパスワードの変更**
   ```bash
   # 初回起動時に管理者パスワードを設定
   node index.js --init-admin-password
   ```

2. **セキュリティキーの生成**
   ```bash
   # セキュアなランダムキーを生成
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

3. **最小権限の原則**
   - 必要最小限の権限のみ付与
   - 定期的な権限レビュー
   - 不要なアカウントの削除

### 運用時の注意

1. **定期的な更新**
   - セキュリティパッチの適用
   - 依存関係の更新
   - 設定の見直し

2. **監視とアラート**
   - 異常なアクセスパターンの検出
   - リソース使用量の監視
   - セキュリティイベントの通知

3. **バックアップとリカバリ**
   - 定期的なバックアップ
   - リカバリ手順のテスト
   - オフサイトバックアップ

## トラブルシューティング

### ログイン失敗

```bash
# ログを確認
tail -f logs/security.log | grep "auth.failed"

# アカウントロック状態を確認
curl http://localhost:8080/api/auth/account-status/username \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

### パフォーマンス問題

```bash
# セキュリティ機能のオーバーヘッドを測定
curl http://localhost:8080/api/monitoring/security-metrics \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

### 設定の検証

```bash
# セキュリティ設定の検証
node index.js --validate-security-config

# 推奨設定の確認
node index.js --security-recommendations
```