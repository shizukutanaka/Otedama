# 重複ファイル整理計画 / Duplicate File Cleanup Plan
# Otedama v1.1.8

## 分析結果 / Analysis Results

- **重複ファイルグループ**: 24個
- **重複ファイル総数**: 42個  
- **削減可能ファイル数**: 約30-35個

## 整理優先度 / Cleanup Priority

### 🔴 高優先度 (即座に統合/削除)

#### 1. Constants Files (4個 → 1個)
```
config/constants.js          → 保持 (グローバル設定)
lib/core/constants.js        → 統合
lib/mining/constants.js      → 統合  
lib/storage/constants.js     → 統合
```
**統合先**: `config/constants.js` に階層化して統合

#### 2. Connection Pool Files (4個 → 1個)
```
lib/core/connection-pool.js      → 保持 (統合版)
lib/database/connection-pool.js  → 削除
lib/network/connection-pool.js   → 削除
lib/storage/connection-pool.js   → 削除
```

#### 3. Rate Limiter Files (2個 → 1個)
```
lib/core/rate-limiter.js         → 削除 (古い実装)
lib/security/rate-limiter.js     → 保持 (最新実装)
```

#### 4. Stratum Server Files (2個 → 1個)
```
lib/mining/stratum-server.js     → 削除 (古い実装)
lib/network/stratum-server.js    → 保持 (最新実装)
```

#### 5. Stratum V2 Server Files (2個 → 1個)
```
lib/mining/stratum-v2/stratum-v2-server.js  → 削除
lib/network/stratum-v2-server.js            → 保持
```

### 🟡 中優先度 (機能確認後に統合)

#### 6. Health Check Files (3個 → 1個)
```
lib/core/health-check.js         → 統合
lib/monitoring/health-check.js   → 保持 (メイン実装)
scripts/health-check.js          → 保持 (スクリプト用)
```

#### 7. Auto Scaling Files (2個 → 1個)
```
lib/core/auto-scaling.js         → 削除
lib/monitoring/auto-scaling.js   → 保持
```

#### 8. Cache Manager Files (2個 → 1個)
```
lib/core/cache-manager.js        → 削除
lib/optimization/cache-manager.js → 保持
```

#### 9. Load Balancer Files (2個 → 1個)
```
lib/core/load-balancer.js        → 統合
lib/network/load-balancer.js     → 保持 (メイン実装)
```

### 🟢 低優先度 (互換性確認後に整理)

#### 10. Index Files (14個)
各ディレクトリのindex.jsは基本的に保持（モジュールエクスポート用）

#### 11. Mining Worker Files
```
lib/mining/cpu-mining-worker.js          → 削除
lib/mining/workers/cpu-mining-worker.js  → 保持

lib/mining/mining-worker.js              → 統合
lib/workers/mining-worker.js             → 保持
```

## 実行計画 / Execution Plan

### Phase 1: 高優先度ファイルの統合
1. Constants統合
2. Connection Pool統合  
3. Rate Limiter整理
4. Stratum Server整理

### Phase 2: 中優先度ファイルの統合
5. Health Check統合
6. Auto Scaling整理
7. Cache Manager整理
8. Load Balancer統合

### Phase 3: 低優先度ファイルの整理
9. Mining Worker整理
10. その他重複ファイルの確認

### Phase 4: インポート修正
11. 削除ファイルを参照するimport文の修正
12. テスト実行と動作確認

## 期待効果 / Expected Benefits

- **ファイル数削減**: 30-35ファイル削除
- **保守性向上**: 機能の重複解消
- **コード一貫性**: 統一された実装
- **ビルド高速化**: ファイル数減少による効果

## リスク軽減策 / Risk Mitigation

1. **バックアップ**: 削除前に全ファイルバックアップ
2. **段階実行**: フェーズ毎の動作確認
3. **テスト**: 各段階でのテスト実行
4. **インポート検証**: 依存関係の徹底確認