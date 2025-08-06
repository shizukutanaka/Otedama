# Otedama エンタープライズP2Pマイニングプール - API ドキュメント

**バージョン**: 2.1.5  
**APIバージョン**: v1  
**最終更新日**: 2025-08-06  

## 概要

Otedama APIは、P2Pマイニングプール管理、リアルタイム統計、エンタープライズ監視、マイニング操作のための包括的なRESTfulエンドポイントを提供します。すべてのAPIレスポンスはJSON形式で、包括的なエラーハンドリングとレート制限機能を備えています。

## ベースURL

プロダクション環境:
```
https://your-pool.com/api/v1
```

開発環境:
```
http://localhost:8080/api/v1
```

## 認証

APIは異なるセキュリティレベルに対応する複数の認証方法をサポートしています：

### APIキー認証（推奨）
```
Authorization: Bearer YOUR_API_KEY
```

### JWTトークン認証
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### ベーシック認証（開発環境のみ）
```
Authorization: Basic dXNlcm5hbWU6cGFzc3dvcmQ=
```

### APIキーの取得
```bash
curl -X POST /auth/api-key \
  -H "Content-Type: application/json" \
  -d '{"username": "your_username", "password": "your_password"}'
```

レスポンス:
```json
{
  "success": true,
  "data": {
    "api_key": "otedama_live_sk_...",
    "expires_at": "2025-01-15T12:00:00Z",
    "permissions": ["read", "write", "admin"]
  }
}
```

## 共通レスポンス形式

### 成功レスポンス
```json
{
  "success": true,
  "data": { ... },
  "meta": {
    "timestamp": "2024-01-15T12:00:00Z",
    "version": "1.0"
  }
}
```

### エラーレスポンス
```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "人間が読めるエラーメッセージ",
    "details": { ... }
  }
}
```

## エンドポイント

### プール情報

#### プール統計の取得
```
GET /stats
```

レスポンス:
```json
{
  "success": true,
  "data": {
    "hashrate": 1250000000000,
    "miners": 1523,
    "workers": 4821,
    "blocks_found": 142,
    "last_block": {
      "height": 850123,
      "hash": "0000000000000000000123...",
      "found_at": "2024-01-15T11:45:00Z",
      "reward": 6.25
    },
    "currencies": ["BTC", "ETH", "LTC", "XMR", "RVN"],
    "algorithms": ["SHA256d", "Ethash", "Scrypt", "RandomX", "KawPow"],
    "federation": {
      "peers": 15,
      "shared_hashrate": 450000000000,
      "reputation": 0.95
    },
    "hardware_stats": {
      "cpu_miners": 823,
      "gpu_miners": 634,
      "asic_miners": 66
    }
  }
}
```

#### サポートされるアルゴリズムの取得
```
GET /algorithms
```

レスポンス:
```json
{
  "success": true,
  "data": [
    {
      "name": "SHA256d",
      "currencies": ["BTC", "BCH"],
      "ports": [3333],
      "difficulty": 65536,
      "hashrate": 850000000000,
      "hardware_types": ["CPU", "GPU", "ASIC"],
      "stratum_version": "v1/v2"
    },
    {
      "name": "Ethash",
      "currencies": ["ETH", "ETC"],
      "ports": [3334],
      "difficulty": 4096,
      "hashrate": 400000000000,
      "hardware_types": ["GPU"],
      "stratum_version": "v1"
    },
    {
      "name": "RandomX",
      "currencies": ["XMR"],
      "ports": [3335],
      "difficulty": 256,
      "hashrate": 125000000,
      "hardware_types": ["CPU"],
      "stratum_version": "v1"
    },
    {
      "name": "KawPow",
      "currencies": ["RVN"],
      "ports": [3336],
      "difficulty": 1024,
      "hashrate": 85000000000,
      "hardware_types": ["GPU"],
      "stratum_version": "v1"
    },
    {
      "name": "Scrypt",
      "currencies": ["LTC", "DOGE"],
      "ports": [3337],
      "difficulty": 16384,
      "hashrate": 250000000000,
      "hardware_types": ["CPU", "GPU", "ASIC"],
      "stratum_version": "v1"
    }
  ]
}
```

### マイナー操作

#### マイナー統計の取得
```
GET /miners/{address}
```

パラメータ:
- `address`: ウォレットアドレス

レスポンス:
```json
{
  "success": true,
  "data": {
    "address": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
    "hashrate": 125000000,
    "hashrate_24h": 123500000,
    "workers": 3,
    "shares": {
      "accepted": 15234,
      "rejected": 42,
      "stale": 18
    },
    "balance": 0.00125634,
    "paid": 1.25634521,
    "last_share": "2024-01-15T12:00:00Z"
  }
}
```

#### マイナーワーカーの取得
```
GET /miners/{address}/workers
```

レスポンス:
```json
{
  "success": true,
  "data": [
    {
      "name": "worker1",
      "hashrate": 45000000,
      "shares_accepted": 5123,
      "shares_rejected": 15,
      "last_share": "2024-01-15T11:59:45Z",
      "status": "active"
    },
    {
      "name": "worker2",
      "hashrate": 40000000,
      "shares_accepted": 4821,
      "shares_rejected": 12,
      "last_share": "2024-01-15T11:59:30Z",
      "status": "active"
    }
  ]
}
```

#### マイナー支払いの取得
```
GET /miners/{address}/payments
```

パラメータ:
- `page`: ページ番号（デフォルト: 1）
- `limit`: ページあたりのアイテム数（デフォルト: 50、最大: 100）

レスポンス:
```json
{
  "success": true,
  "data": [
    {
      "id": "pay_123456",
      "amount": 0.1,
      "tx_hash": "abc123...",
      "timestamp": "2024-01-14T10:00:00Z",
      "status": "confirmed"
    }
  ],
  "meta": {
    "page": 1,
    "limit": 50,
    "total": 125,
    "total_pages": 3
  }
}
```

### ワーカー管理

#### ワーカーの登録
```
POST /workers
```

リクエスト:
```json
{
  "name": "my_worker",
  "hardware_type": "GPU",
  "algorithm": "Ethash",
  "currency": "ETH"
}
```

レスポンス:
```json
{
  "success": true,
  "data": {
    "id": "worker_123456",
    "name": "my_worker",
    "token": "secret_token_here",
    "stratum_url": "stratum+tcp://your-pool.com:3334"
  }
}
```

#### ワーカーの更新
```
PUT /workers/{id}
```

リクエスト:
```json
{
  "name": "new_worker_name",
  "config": {
    "intensity": 20,
    "threads": 4
  }
}
```

#### ワーカーの削除
```
DELETE /workers/{id}
```

#### ワーカーコマンドの実行
```
POST /workers/{id}/commands
```

リクエスト:
```json
{
  "command": "restart",
  "parameters": {}
}
```

### ブロック情報

#### 最近のブロックの取得
```
GET /blocks
```

パラメータ:
- `currency`: 通貨によるフィルタ（オプション）
- `limit`: ブロック数（デフォルト: 50）

レスポンス:
```json
{
  "success": true,
  "data": [
    {
      "height": 850123,
      "hash": "0000000000000000000123...",
      "currency": "BTC",
      "reward": 6.25,
      "found_by": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
      "found_at": "2024-01-15T11:45:00Z",
      "confirmations": 6,
      "status": "confirmed"
    }
  ]
}
```

### エンタープライズ監視

#### システムメトリクスの取得
```
GET /monitoring/metrics
```

レスポンス:
```json
{
  "success": true,
  "data": {
    "system": {
      "cpu_usage": 45.2,
      "memory_usage": 62.1,
      "disk_usage": 38.5,
      "network_io": {
        "in": 125.6,
        "out": 89.3
      }
    },
    "mining": {
      "total_hashrate": 1250000000000,
      "active_workers": 4821,
      "shares_per_second": 156.8,
      "rejection_rate": 0.02
    },
    "stratum": {
      "connections": 4821,
      "jobs_sent": 45623,
      "shares_received": 156789
    },
    "p2p": {
      "peers_connected": 15,
      "federation_health": "healthy",
      "sync_status": "synchronized"
    }
  }
}
```

#### ハードウェア統計の取得
```
GET /monitoring/hardware
```

レスポンス:
```json
{
  "success": true,
  "data": {
    "cpu_miners": {
      "count": 823,
      "total_hashrate": 125000000,
      "avg_temperature": 65.2,
      "power_consumption": 1250
    },
    "gpu_miners": {
      "count": 634,
      "total_hashrate": 950000000000,
      "avg_temperature": 72.5,
      "power_consumption": 95000
    },
    "asic_miners": {
      "count": 66,
      "total_hashrate": 175000000000,
      "avg_temperature": 85.1,
      "power_consumption": 125000
    }
  }
}
```

### リアルタイムデータ（WebSocket）

#### WebSocketへの接続
```
wss://your-pool.com/api/ws
```

#### WebSocket認証
```json
{
  "type": "auth",
  "token": "YOUR_API_KEY"
}
```

#### 更新の購読
```json
{
  "type": "subscribe",
  "channels": ["stats", "blocks", "miner:YOUR_ADDRESS", "hardware", "federation"]
}
```

#### リアルタイムメッセージ

**統計更新:**
```json
{
  "type": "stats",
  "data": {
    "hashrate": 1250000000000,
    "miners": 1523,
    "difficulty": 65536
  }
}
```

**新しいブロック:**
```json
{
  "type": "block",
  "data": {
    "height": 850124,
    "hash": "0000000000000000000456...",
    "reward": 6.25,
    "currency": "BTC"
  }
}
```

**マイナー更新:**
```json
{
  "type": "miner",
  "data": {
    "hashrate": 125000000,
    "balance": 0.00125634,
    "shares_accepted": 15235
  }
}
```

**ハードウェア更新:**
```json
{
  "type": "hardware",
  "data": {
    "gpu_miners": {
      "count": 634,
      "avg_temperature": 72.5
    }
  }
}
```

### モバイルAPI

#### プッシュ通知登録
```
POST /mobile/register
```

リクエスト:
```json
{
  "device_token": "firebase_token_here",
  "platform": "ios",
  "miner_address": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
}
```

#### 通知設定の更新
```
PUT /mobile/notifications
```

リクエスト:
```json
{
  "worker_offline": true,
  "payment_sent": true,
  "block_found": false,
  "hashrate_drop": true,
  "threshold_percentage": 20
}
```

### フェデレーションAPI

#### フェデレーション状態の取得
```
GET /federation/status
```

レスポンス:
```json
{
  "success": true,
  "data": {
    "node_id": "node_abc123",
    "peers": 15,
    "reputation": 0.95,
    "shared_hashrate": 450000000000,
    "settlements": {
      "pending": 3,
      "completed": 142
    }
  }
}
```

#### フェデレーションピアの一覧
```
GET /federation/peers
```

レスポンス:
```json
{
  "success": true,
  "data": [
    {
      "id": "peer_123",
      "name": "Partner Pool 1",
      "hashrate": 150000000000,
      "reputation": 0.98,
      "location": "US-East",
      "latency": 15
    }
  ]
}
```

### マイニング最適化API

#### 最適化の開始
```
POST /optimization/start
```

リクエスト:
```json
{
  "hardware_type": "GPU",
  "algorithm": "Ethash",
  "optimization_level": "aggressive",
  "safety_mode": true
}
```

レスポンス:
```json
{
  "success": true,
  "data": {
    "optimization_id": "opt_123456",
    "status": "running",
    "estimated_duration": 300
  }
}
```

#### 最適化状態の取得
```
GET /optimization/{id}/status
```

レスポンス:
```json
{
  "success": true,
  "data": {
    "id": "opt_123456",
    "status": "completed",
    "progress": 100,
    "results": {
      "hashrate_improvement": 12.5,
      "power_efficiency_gain": 8.3,
      "memory_optimization": "applied",
      "thermal_optimization": "applied"
    }
  }
}
```

### セキュリティAPI

#### セキュリティ監査の取得
```
GET /security/audit
```

レスポンス:
```json
{
  "success": true,
  "data": {
    "last_audit": "2024-01-15T10:00:00Z",
    "security_level": "high",
    "threats_detected": 0,
    "ddos_protection": "active",
    "rate_limiting": "enforced",
    "ssl_certificate": "valid",
    "firewall_status": "active"
  }
}
```

#### 脅威インテリジェンスの取得
```
GET /security/threats
```

レスポンス:
```json
{
  "success": true,
  "data": {
    "active_threats": 0,
    "blocked_ips": ["192.168.1.100", "10.0.0.50"],
    "suspicious_activity": {
      "failed_authentications": 3,
      "rate_limit_violations": 12,
      "malformed_requests": 1
    }
  }
}
```

### 管理API

#### システムヘルスの取得
```
GET /admin/health
```

レスポンス:
```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "components": {
      "database": "healthy",
      "stratum": "healthy",
      "payment_processor": "healthy",
      "federation": "degraded"
    },
    "metrics": {
      "cpu_usage": 45.2,
      "memory_usage": 62.1,
      "disk_usage": 38.5,
      "network_in": 125.6,
      "network_out": 89.3
    }
  }
}
```

#### バックアップの実行
```
POST /admin/backup
```

リクエスト:
```json
{
  "type": "full",
  "destination": "s3",
  "encrypt": true
}
```

#### 設定の更新
```
PUT /admin/config
```

リクエスト:
```json
{
  "section": "mining",
  "settings": {
    "minimum_payout": 0.001,
    "pool_fee": 1.0
  }
}
```

## レート制限

APIリクエストは悪用を防ぐためにレート制限されています：

- **匿名**: 1分あたり100リクエスト
- **認証済み**: 1分あたり1000リクエスト  
- **プレミアム**: 1分あたり5000リクエスト
- **エンタープライズ**: 1分あたり10000リクエスト
- **WebSocket**: 1分あたり100メッセージ

レート制限ヘッダー:
```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 998
X-RateLimit-Reset: 1705320000
X-RateLimit-Tier: authenticated
```

## エラーコード

| コード | 説明 |
|------|-------------|
| `INVALID_REQUEST` | リクエスト形式が無効 |
| `UNAUTHORIZED` | 認証が必要 |
| `FORBIDDEN` | アクセス拒否 |
| `NOT_FOUND` | リソースが見つからない |
| `RATE_LIMITED` | リクエスト過多 |
| `INTERNAL_ERROR` | サーバーエラー |
| `MAINTENANCE` | APIがメンテナンス中 |

## SDK例

### JavaScript/Node.js
```javascript
const { OtedamaAPI } = require('@otedama/api-client');

const client = new OtedamaAPI({
  apiKey: 'otedama_live_sk_...',
  baseURL: 'https://your-pool.com/api/v1',
  environment: 'production'
});

// プール統計の取得
const poolStats = await client.getStats();
console.log(`プールハッシュレート: ${poolStats.hashrate} H/s`);
console.log(`アクティブマイナー: ${poolStats.miners}`);

// マイナー情報の取得
const minerStats = await client.getMinerStats('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
console.log(`マイナーハッシュレート: ${minerStats.hashrate} H/s`);
console.log(`残高: ${minerStats.balance} BTC`);

// WebSocketでリアルタイム更新を購読
const wsClient = client.createWebSocketClient();
wsClient.on('connect', () => {
  wsClient.subscribe(['stats', 'blocks', 'hardware']);
});

wsClient.on('stats', (data) => {
  console.log('プール統計更新:', data);
});

wsClient.on('block', (data) => {
  console.log('新しいブロック発見:', data);
});

// ハードウェア最適化の開始
const optimization = await client.startOptimization({
  hardware_type: 'GPU',
  algorithm: 'Ethash',
  optimization_level: 'balanced',
  safety_mode: true
});
console.log(`最適化開始: ${optimization.optimization_id}`);
```

### Python
```python
import asyncio
from otedama_client import OtedamaClient, OtedamaWebSocket

# クライアント初期化
client = OtedamaClient(
    api_key='otedama_live_sk_...',
    base_url='https://your-pool.com/api/v1',
    environment='production'
)

async def main():
    # プール情報の取得
    pool_stats = await client.get_stats()
    print(f"プールハッシュレート: {pool_stats['hashrate']:,} H/s")
    print(f"総マイナー数: {pool_stats['miners']:,}")
    
    # 特定マイナーの監視
    miner_address = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'
    miner_stats = await client.get_miner(miner_address)
    print(f"マイナー残高: {miner_stats['balance']} BTC")
    
    # ハードウェア統計の取得
    hardware_stats = await client.get_hardware_stats()
    print(f"GPUマイナー: {hardware_stats['gpu_miners']['count']}")
    print(f"ASICマイナー: {hardware_stats['asic_miners']['count']}")
    
    # WebSocket監視
    ws = OtedamaWebSocket(client)
    
    @ws.on('stats')
    async def on_stats_update(data):
        print(f"ハッシュレート更新: {data['hashrate']:,} H/s")
    
    @ws.on('hardware')
    async def on_hardware_update(data):
        print(f"ハードウェア更新: {data}")
    
    await ws.connect()
    await ws.subscribe(['stats', 'hardware', 'federation'])
    
    # 実行継続
    await asyncio.sleep(3600)

# クライアント実行
asyncio.run(main())
```

### Go
```go
package main

import (
    "context"
    "fmt"
    "log"
    "time"
    
    "github.com/otedama/otedama-go-client"
)

func main() {
    // クライアント初期化
    client := otedama.NewClient(&otedama.Config{
        APIKey:      "otedama_live_sk_...",
        BaseURL:     "https://your-pool.com/api/v1",
        Environment: "production",
        Timeout:     30 * time.Second,
    })
    
    ctx := context.Background()
    
    // プール統計取得
    stats, err := client.GetStats(ctx)
    if err != nil {
        log.Fatal("統計取得に失敗:", err)
    }
    
    fmt.Printf("プールハッシュレート: %d H/s\n", stats.Hashrate)
    fmt.Printf("アクティブマイナー: %d\n", stats.Miners)
    fmt.Printf("フェデレーションピア: %d\n", stats.Federation.Peers)
    
    // サポートアルゴリズム取得
    algorithms, err := client.GetAlgorithms(ctx)
    if err != nil {
        log.Fatal("アルゴリズム取得に失敗:", err)
    }
    
    for _, algo := range algorithms {
        fmt.Printf("アルゴリズム: %s, ハッシュレート: %d H/s\n", 
            algo.Name, algo.Hashrate)
    }
    
    // マイナー監視
    minerAddr := "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
    miner, err := client.GetMiner(ctx, minerAddr)
    if err != nil {
        log.Fatal("マイナー取得に失敗:", err)
    }
    
    fmt.Printf("マイナー %s: %d H/s, 残高: %.8f BTC\n", 
        minerAddr, miner.Hashrate, miner.Balance)
    
    // ハードウェア最適化開始
    optimization, err := client.StartOptimization(ctx, &otedama.OptimizationRequest{
        HardwareType:      "GPU",
        Algorithm:         "Ethash",
        OptimizationLevel: "balanced",
        SafetyMode:        true,
    })
    if err != nil {
        log.Fatal("最適化開始に失敗:", err)
    }
    
    fmt.Printf("最適化開始: %s\n", optimization.ID)
    
    // リアルタイム更新用WebSocketクライアント
    wsClient := client.NewWebSocketClient()
    
    wsClient.OnConnect(func() {
        log.Println("WebSocket接続完了")
        wsClient.Subscribe([]string{"stats", "hardware", "federation"})
    })
    
    wsClient.OnStats(func(data *otedama.StatsUpdate) {
        fmt.Printf("統計更新: %d H/s\n", data.Hashrate)
    })
    
    wsClient.OnHardware(func(data *otedama.HardwareUpdate) {
        fmt.Printf("ハードウェア更新: GPUマイナー: %d\n", 
            data.GPUMiners.Count)
    })
    
    // 接続と待機
    if err := wsClient.Connect(ctx); err != nil {
        log.Fatal("WebSocket接続に失敗:", err)
    }
    
    // 待機継続
    select {}
}
```

## 変更履歴

### v2.1.5 (2025-08-05)
- 包括的な多言語サポート（30言語）
- 完全な国際化インフラストラクチャ
- すべての言語でのドキュメント更新

### v2.1.4 (2025-08-20)
- エンタープライズ監視エンドポイントの追加
- ハードウェア最適化APIの強化
- セキュリティ監査機能の改善
- 多言語SDK対応（JavaScript、Python、Go、Rust）
- 高度なフェデレーション管理
- リアルタイム脅威インテリジェンス
- ゼロコピー最適化機能
- NUMA対応メモリ管理
- 包括的レート制限

### v2.1.3 (2025-08-15)
- P2Pフェデレーションプロトコル実装
- エンタープライズセキュリティ強化
- マルチアルゴリズムサポート（SHA256d、Ethash、RandomX、KawPow、Scrypt）
- ハードウェア固有の最適化
- 高度なWebSocket機能

### v2.1.0 (2025-08-01)
- エンタープライズ使用向けの大幅なAPI再設計
- マルチハードウェアサポート（CPU/GPU/ASIC）
- 強化された監視と分析
- プロダクション対応デプロイメント機能

### v1.0 (2024-01-15)
- 初期APIリリース
- RESTfulエンドポイント
- WebSocketサポート
- モバイルAPI
- フェデレーションエンドポイント

---

**ドキュメントバージョン**: v2.1.5  
**最終更新**: 2025-01-15  
**API安定性**: プロダクション対応