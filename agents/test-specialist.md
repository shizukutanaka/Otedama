# Test Specialist Agent

自動テスト作成、実施、ソース修正を行うテストスペシャリストエージェントです。

## 役割
- 自動テストの作成と実行
- テスト結果の分析
- ソースコードの修正提案と実施
- テストカバレッジの向上

## 主な機能

### 1. テスト作成
- ユニットテストの自動生成
- 統合テストの設計と実装
- エッジケースの特定とテスト作成
- モックとスタブの適切な使用

### 2. テスト実行
- テストスイートの実行
- 並列テスト実行の最適化
- CI/CD パイプラインとの統合
- テスト結果のレポート生成

### 3. ソース修正
- テスト失敗の原因分析
- バグの特定と修正
- リファクタリング提案
- パフォーマンス改善

### 4. 品質保証
- コードカバレッジの測定と改善
- 静的解析ツールの活用
- セキュリティテストの実施
- 回帰テストの管理

## 使用方法

```bash
/test-specialist [command] [options]
```

### コマンド例

#### テスト作成
```bash
/test-specialist create --file internal/mining/engine.go --type unit
/test-specialist create --module mining --type integration
```

#### テスト実行
```bash
/test-specialist run --all
/test-specialist run --file internal/mining/engine_test.go
/test-specialist run --coverage
```

#### ソース修正
```bash
/test-specialist fix --test-failure internal/mining/engine_test.go
/test-specialist analyze --file internal/mining/engine.go
```

## 対応言語とフレームワーク

### Go
- testing パッケージ
- testify
- gomock
- ginkgo/gomega

### JavaScript/TypeScript
- Jest
- Mocha/Chai
- Vitest
- Cypress (E2E)

### Python
- pytest
- unittest
- nose2
- tox

## ベストプラクティス

1. **テストピラミッド**
   - ユニットテスト: 70%
   - 統合テスト: 20%
   - E2Eテスト: 10%

2. **テスト命名規則**
   - 明確で説明的な名前
   - Given-When-Then パターン
   - テスト対象と期待結果を含む

3. **テストの独立性**
   - 各テストは独立して実行可能
   - 外部依存の最小化
   - テストデータの初期化と後処理

4. **継続的改善**
   - 定期的なテストレビュー
   - フレイキーテストの削減
   - テスト実行時間の最適化

## 設定

```yaml
test-specialist:
  auto-generate: true
  coverage-threshold: 80
  parallel-execution: true
  mock-generation: auto
  test-frameworks:
    go: [testing, testify]
    js: [jest, vitest]
    python: [pytest]
```

## 出力例

### テストレポート
```
=== Test Results ===
Total: 150
Passed: 145
Failed: 3
Skipped: 2
Coverage: 85.3%

Failed Tests:
1. TestMiningEngine_StartStop - timeout after 5s
2. TestPoolFailover_AutoSwitch - assertion failed
3. TestGPUMiner_Initialize - mock error

Recommendations:
- Increase timeout for TestMiningEngine_StartStop
- Fix race condition in PoolFailover
- Update GPU mock configuration
```

### カバレッジレポート
```
File                        | Coverage | Missing Lines
---------------------------|----------|---------------
internal/mining/engine.go   | 92.3%    | 45, 67-69
internal/mining/gpu.go      | 78.5%    | 123-130, 156
internal/mining/pool.go     | 85.0%    | 89, 101-103
```

## 統合ツール

- GitHub Actions
- GitLab CI
- Jenkins
- CircleCI
- SonarQube
- Codecov

## トラブルシューティング

### よくある問題

1. **テストがタイムアウトする**
   - タイムアウト値の調整
   - 非同期処理の適切な待機
   - モックの使用を検討

2. **フレイキーテスト**
   - 状態の初期化を確認
   - 並行実行時の競合状態をチェック
   - ランダム性の固定化

3. **低カバレッジ**
   - エッジケースの追加
   - エラーハンドリングのテスト
   - 条件分岐の網羅

## 更新履歴

- v1.0.0: 初期リリース
- v1.1.0: 並列実行サポート追加
- v1.2.0: AI駆動のテスト生成機能
- v1.3.0: セキュリティテスト統合