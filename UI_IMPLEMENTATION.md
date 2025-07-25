# Otedama - UI実装の変更

## HTMLダッシュボードからの移行

HTMLベースのWebダッシュボードを削除し、以下の代替手段を実装しました：

### 1. ターミナルダッシュボード
```bash
# 高機能なターミナルUI
npm run dashboard
```

特徴：
- blessed/blessed-contribによるリッチなCLI UI
- リアルタイムWebSocket接続
- ハッシュレートグラフ
- マイナー統計表
- キーボードショートカット対応

### 2. CLIモニタリングツール
```bash
# シンプルなモニタリング
npm run monitor

# 自動更新モード
npm run monitor -- --watch

# JSON出力
npm run monitor -- --json
```

特徴：
- 軽量なコマンドラインツール
- APIベースのデータ取得
- ウォッチモード対応
- JSON出力対応

### 3. RESTful API
完全なAPIドキュメント（`API_DOCUMENTATION.md`）を提供：

- **REST API**: 統計情報、マイナー管理、支払い管理
- **WebSocket API**: リアルタイム更新
- **認証**: JWT/APIキー対応
- **レート制限**: DDoS保護

### クライアント実装の自由度

APIを使用して、任意のクライアントUIを実装可能：

#### React/Vue.js Example
```javascript
// プール統計を取得
const response = await fetch('http://localhost:8080/api/stats');
const stats = await response.json();
```

#### Mobile App
- React Native
- Flutter
- Native iOS/Android

#### Desktop App
- Electron
- Qt
- Native applications

## 利点

1. **柔軟性**: クライアントは任意の技術スタックを選択可能
2. **セキュリティ**: APIベースの分離により、セキュリティが向上
3. **パフォーマンス**: 不要なWebアセットの配信を削減
4. **保守性**: UI とビジネスロジックの完全な分離

## 使用方法

### ターミナルダッシュボード
```bash
# 起動
npm run dashboard

# キーボードショートカット
# q - 終了
# r - 更新
# h - ヘルプ
# Tab - ウィジェット切り替え
```

### APIモニタリング
```bash
# 基本的な使用
npm run monitor

# カスタムURL
npm run monitor -- --url http://pool.example.com:8080

# 継続的な監視
npm run monitor -- --watch --interval 10
```

### API統合
```javascript
// JavaScript SDK例
import { OtedamaClient } from 'otedama-client';

const client = new OtedamaClient({
  apiUrl: 'http://localhost:8080',
  wsUrl: 'ws://localhost:8081'
});

// 統計情報の取得
const stats = await client.getPoolStats();

// リアルタイム更新の購読
client.subscribe('pool_stats', (data) => {
  console.log('Pool hashrate:', data.hashrate);
});
```

## まとめ

HTMLダッシュボードを削除し、より柔軟で安全なアーキテクチャを採用しました。これにより、Otedamaは真のヘッドレスマイニングプールプラットフォームとなり、あらゆるクライアント実装に対応できます。
