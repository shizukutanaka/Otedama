# Otedama プロジェクトへのコントリビューション

Otedamaプロジェクトへの貢献を検討していただき、ありがとうございます！このガイドでは、効果的に貢献する方法について説明します。

## 🎯 設計思想

Otedamaは以下の設計思想に基づいて開発されています：

- **John Carmack**: 実用的・高性能・最適化重視
- **Robert C. Martin**: クリーンコード・SOLID原則
- **Rob Pike**: シンプル・効率的・保守性

コントリビューションの際は、これらの原則を意識してください。

## 🚀 クイックスタート

### 1. 開発環境のセットアップ

```bash
# リポジトリをフォーク・クローン
git clone https://github.com/YOUR_USERNAME/Otedama.git
cd Otedama

# 依存関係インストール
npm install

# 開発モードで起動
npm run start:dev
```

### 2. 開発ルール

- **TypeScript**: 型安全性を重視
- **ESLint + Prettier**: コード品質保持
- **テスト**: 新機能には必ずテストを追加
- **ドキュメント**: 適切なコメントとドキュメント

## 📝 コントリビューションの種類

### 🐛 バグ報告

バグを発見した場合は、[GitHub Issues](https://github.com/shizukutanaka/Otedama/issues) で報告してください。

**必要な情報:**
- 環境情報 (OS, Node.js バージョン等)
- 再現手順
- 期待される動作
- 実際の動作
- エラーメッセージ

### 💡 機能提案

新機能の提案は [GitHub Discussions](https://github.com/shizukutanaka/Otedama/discussions) で議論してください。

**考慮事項:**
- 実用性: 実際に多くのユーザーが利用するか
- 保守性: 長期的に維持できるか
- シンプルさ: 複雑すぎないか

### 🔧 コード貢献

#### ブランチ戦略

```bash
# 新機能
git checkout -b feature/new-feature

# バグ修正
git checkout -b fix/bug-description

# ドキュメント
git checkout -b docs/update-readme
```

#### コミットメッセージ

```
type(scope): description

[optional body]

[optional footer]
```

**例:**
```
feat(mining): add RandomX algorithm optimization
fix(ui): resolve dashboard layout issue
docs(readme): update installation instructions
```

### 🌍 翻訳・国際化

100言語対応の維持・拡張にご協力ください。

```bash
# 翻訳ファイルの場所
src/i18n/locales/

# 新言語追加
src/i18n/enhanced-100lang-system.ts
```

## 🧪 テスト

### テストの実行

```bash
# 全テスト実行
npm test

# カバレッジ付き
npm run test:coverage

# 監視モード
npm run test:watch
```

### テストの作成

```typescript
// 例: アルゴリズムテスト
describe('RandomX Algorithm', () => {
  it('should calculate correct hash', () => {
    const algorithm = new RandomXAlgorithm();
    const result = algorithm.hash(testData);
    expect(result).toBe(expectedHash);
  });
});
```

## 📊 パフォーマンス

### ベンチマーク

```bash
# アルゴリズムベンチマーク
npm run algorithms:benchmark

# 全体パフォーマンステスト
npm run performance:test
```

### 最適化ガイドライン

- **メモリ効率**: 不要なオブジェクト生成を避ける
- **CPU効率**: 計算量の最適化
- **ネットワーク効率**: 帯域使用量の最小化

## 🔒 セキュリティ

### セキュリティ脆弱性の報告

セキュリティ関連の問題は公開のIssueではなく、直接メールで報告してください：
**shizukutanaka@proton.me**

### セキュリティガイドライン

- 暗号化: 機密データは必ず暗号化
- 入力検証: 全ての入力を検証
- 権限管理: 最小権限の原則

## 📚 ドキュメント

### コードコメント

```typescript
/**
 * RandomXアルゴリズムによるハッシュ計算
 * @param data - ハッシュ化するデータ
 * @returns 32バイトのハッシュ値
 */
hash(data: Buffer): Buffer {
  // 実装...
}
```

### README更新

- 新機能追加時はREADMEも更新
- 使用例の追加
- スクリーンショットの更新

## 🔄 プルリクエストプロセス

### 1. 準備

```bash
# コード品質チェック
npm run lint
npm run type-check
npm run test

# フォーマット適用
npm run format
```

### 2. プルリクエスト作成

**テンプレート:**
```markdown
## 概要
このPRの目的と変更内容を説明

## 変更内容
- [ ] 新機能追加
- [ ] バグ修正
- [ ] ドキュメント更新
- [ ] リファクタリング

## テスト
- [ ] 新しいテストを追加
- [ ] 既存テストがパス
- [ ] 手動テスト実施

## 確認項目
- [ ] 設計思想に準拠
- [ ] パフォーマンス影響なし
- [ ] セキュリティ問題なし
- [ ] ドキュメント更新済み
```

### 3. レビュープロセス

- コードレビュー実施
- テスト結果確認
- ドキュメント確認
- マージ

## 🏆 認定コントリビューター

定期的に貢献してくださる方を認定コントリビューターとして認定します。

**特典:**
- 直接プッシュ権限
- リリース判断への参加
- プロジェクト方向性の決定参加

## 📞 質問・サポート

- **GitHub Discussions**: 一般的な質問
- **GitHub Issues**: バグ・機能要求
- **Email**: shizukutanaka@proton.me

## 📄 行動規範

### 尊重と包括性

- 全ての参加者を尊重
- 建設的なフィードバック
- 多様性の受け入れ

### プロフェッショナリズム

- 技術的な議論に集中
- 個人攻撃の禁止
- 事実に基づく議論

## 🎉 謝辞

Otedamaプロジェクトは、コミュニティの皆様の貢献によって成り立っています。
あなたの貢献が、世界中のマイナーの収益向上に繋がります。

---

**ありがとうございます！** 🙏

あなたの貢献により、Otedamaはより良いソフトウェアになります。
