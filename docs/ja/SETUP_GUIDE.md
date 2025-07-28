# Otedama セットアップガイド

## 目次

1. [システム要件](#システム要件)
2. [インストール](#インストール)
3. [設定](#設定)
4. [Otedamaの実行](#otedamaの実行)
5. [マイニング設定](#マイニング設定)
6. [トラブルシューティング](#トラブルシューティング)

## システム要件

### 最小要件

- **オペレーティングシステム**: Ubuntu 20.04+、Windows 10+、またはmacOS 11+
- **CPU**: x64プロセッサ（2コア以上）
- **RAM**: 4GB
- **ストレージ**: 20GB SSD
- **ネットワーク**: 安定したブロードバンド接続
- **Node.js**: v18.0.0以上

### 推奨要件

- **CPU**: CPUマイニング用に8コア以上
- **GPU**: GPUマイニング用にNVIDIA RTX 3060+またはAMD RX 6600+
- **RAM**: 16GB以上
- **ストレージ**: 100GB NVMe SSD
- **ネットワーク**: 低遅延のギガビット接続

## インストール

### 1. 前提条件

Node.jsとnpmをインストール：

**Ubuntu/Debian:**
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**Windows:**
[nodejs.org](https://nodejs.org/)からダウンロードしてインストール

**macOS:**
```bash
brew install node
```

### 2. リポジトリのクローン

```bash
git clone [repository-url]
cd Otedama
```

### 3. 依存関係のインストール

```bash
npm install
```

### 4. ネイティブモジュールのビルド（オプション）

最適化されたパフォーマンスのために：

```bash
npm run build:native
```

## 設定

### 1. 設定ファイルの作成

サンプル設定をコピー：

```bash
cp otedama.config.example.js otedama.config.js
```

### 2. 設定の編集

`otedama.config.js`を開いて設定：

```javascript
module.exports = {
  // マイニング設定
  mining: {
    // マイニングウォレットアドレス
    walletAddress: 'あなたのウォレットアドレス',
    
    // ワーカー名（オプション）
    workerName: 'worker1',
    
    // マイニングアルゴリズム
    algorithm: 'auto', // または特定: 'sha256', 'scrypt'など
    
    // プールまたはソロマイニング
    mode: 'pool', // または 'solo'
  },
  
  // ハードウェア設定
  hardware: {
    // CPUマイニング設定
    cpu: {
      enabled: true,
      threads: 'auto', // または特定の数
      intensity: 80    // 0-100
    },
    
    // GPUマイニング設定
    gpu: {
      enabled: true,
      devices: 'auto', // または特定のGPU用に[0, 1]
      intensity: 95    // 0-100
    }
  },
  
  // ネットワーク設定
  network: {
    // プールサーバー（プールモード使用時）
    pool: {
      host: 'pool.example.com',
      port: 3333
    },
    
    // P2P設定
    p2p: {
      enabled: true,
      port: 33333,
      maxPeers: 50
    }
  },
  
  // モニタリング
  monitoring: {
    enabled: true,
    port: 8080
  }
};
```

### 3. 高度な設定

上級ユーザー向けの追加オプション：

```javascript
// パフォーマンスチューニング
performance: {
  // メモリ割り当て
  memoryLimit: 8192, // MB
  
  // キャッシュ設定
  cacheSize: 1024,   // MB
  
  // ネットワーク最適化
  connectionPoolSize: 100
},

// セキュリティ設定
security: {
  // ZKP認証を有効化
  zkpAuth: true,
  
  // SSL/TLS
  ssl: {
    enabled: true,
    cert: './certs/cert.pem',
    key: './certs/key.pem'
  }
}
```

## Otedamaの実行

### 1. セットアップウィザード（初回推奨）

```bash
npm run setup
```

これにより以下が実行されます：
- ハードウェアの検出
- ベンチマークの実行
- 最適な設定の構成
- 必要なファイルの生成

### 2. マイニングの開始

**基本的な開始:**
```bash
npm start
```

**特定の設定で:**
```bash
npm start -- --config ./my-config.js
```

**本番モード:**
```bash
npm run start:production
```

### 3. Dockerの使用

イメージのビルド:
```bash
docker build -t otedama .
```

コンテナの実行:
```bash
docker run -d \
  --name otedama-miner \
  --gpus all \
  -p 8080:8080 \
  -v $(pwd)/config:/app/config \
  otedama
```

### 4. Systemdサービス（Linux）

サービスとしてインストール:
```bash
sudo npm run install:service
```

サービスの制御:
```bash
sudo systemctl start otedama
sudo systemctl stop otedama
sudo systemctl status otedama
```

## マイニング設定

### プールマイニング

1. 互換性のあるプールを選択
2. プール設定を構成：

```javascript
mining: {
  mode: 'pool',
  pool: {
    url: 'stratum+tcp://pool.example.com:3333',
    user: 'あなたのウォレットアドレス.ワーカー名',
    pass: 'x'
  }
}
```

### ソロマイニング

1. フルノードが実行されていることを確認
2. ソロ設定を構成：

```javascript
mining: {
  mode: 'solo',
  daemon: {
    host: 'localhost',
    port: 8332,
    user: 'rpcuser',
    pass: 'rpcpassword'
  }
}
```

### マルチアルゴリズムマイニング

利益スイッチングを有効化：

```javascript
mining: {
  algorithm: 'profit-switch',
  profitSwitch: {
    interval: 300, // 5分ごとにチェック
    threshold: 5   // 5%以上利益があればスイッチ
  }
}
```

### ハードウェア最適化

**CPUマイニング:**
```javascript
cpu: {
  algorithm: 'randomx',
  threads: 8,
  affinity: true,
  hugepages: true
}
```

**GPUマイニング:**
```javascript
gpu: {
  algorithm: 'ethash',
  devices: [0, 1],
  intensity: 95,
  memoryTweak: 2
}
```

## トラブルシューティング

### よくある問題

**ハードウェアが検出されない:**
```bash
npm run detect:hardware
```

**ハッシュレートが低い:**
```bash
npm run benchmark
npm run optimize
```

**接続の問題:**
```bash
npm run diagnose:network
```

**CPU使用率が高い:**
- 設定でCPUスレッドを減らす
- 強度設定を下げる
- サーマルスロットリングを確認

### デバッグモード

詳細なロギングを有効化：

```bash
DEBUG=otedama:* npm start
```

### パフォーマンス監視

ダッシュボードにアクセス: http://localhost:8080

監視項目:
- リアルタイムハッシュレート
- 温度と電力使用量
- シェア受け入れ率
- ネットワーク遅延

### ヘルプを得る

1. ログを確認:
```bash
tail -f logs/otedama.log
```

2. 診断を実行:
```bash
npm run diagnose
```

3. コミュニティサポート:
- GitHub Issues
- コミュニティフォーラム
- ドキュメント

## セキュリティに関する考慮事項

1. **秘密鍵やシードフレーズを決して共有しない**
2. **Webインターフェースには強力なパスワードを使用**
3. **ソフトウェアを最新に保つ**
4. **異常な活動を監視**
5. **ファイアウォールルールを使用してアクセスを制限**

## 次のステップ

- [APIドキュメント](./API.md)
- [高度な設定](./ADVANCED.md)
- [最適化ガイド](./OPTIMIZATION.md)
- [セキュリティベストプラクティス](./SECURITY.md)