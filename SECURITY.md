# Otedama セキュリティポリシー / Security Policy

## 🛡️ サポートされるバージョン / Supported Versions

以下のバージョンでセキュリティアップデートを提供しています：

| Version | Supported          |
| ------- | ------------------ |
| 2.1.x   | ✅ Yes             |
| 2.0.x   | ✅ Yes             |
| < 2.0   | ❌ No              |

## 🚨 脆弱性の報告 / Reporting a Vulnerability

### 🔒 機密性の重要性 / Importance of Confidentiality

### 📧 報告先 / Contact Information

### 📋 報告に含めるべき情報 / Information to Include

効果的なセキュリティ報告には、以下の情報を含めてください：

1. **脆弱性の概要 / Vulnerability Summary**
   - 問題の簡潔な説明
   - 影響を受けるコンポーネント

2. **技術的詳細 / Technical Details**
   - 脆弱性の具体的な場所（ファイル名、行番号等）
   - 攻撃ベクトル
   - 悪用方法（可能であれば）

3. **影響度 / Impact Assessment**
   - 機密性への影響
   - 完全性への影響
   - 可用性への影響
   - 予想される被害規模

4. **再現手順 / Proof of Concept**
   - 段階的な再現手順
   - 必要に応じてコード例
   - スクリーンショットやログ

5. **環境情報 / Environment**
   - OS・バージョン
   - Node.js バージョン
   - Otedama バージョン
   - その他関連ソフトウェア

6. **提案する修正方法 / Suggested Fix**
   - 可能であれば修正案を提供
   - 回避策がある場合は記載

### ⏱️ 対応タイムライン / Response Timeline

| フェーズ | タイムライン | 対応内容 |
|---------|------------|---------|
| **初期確認** | 24時間以内 | 報告の受領確認メール送信 |
| **詳細分析** | 72時間以内 | 脆弱性の確認と重要度評価 |
| **修正開発** | 7-14日 | パッチの開発と内部テスト |
| **リリース** | 修正完了後48時間以内 | セキュリティアップデートのリリース |
| **公開** | リリース後7日 | 責任ある開示による詳細公開 |

### 🏆 脆弱性重要度の分類 / Vulnerability Severity Classification

#### 🔴 Critical (緊急)
- **対応時間**: 24時間以内
- **例**:
  - リモートコード実行
  - 秘密鍵・ウォレット情報の漏洩
  - 認証バイパス

#### 🟡 High (高)
- **対応時間**: 72時間以内
- **例**:
  - 権限昇格
  - 個人情報の漏洩
  - サービス拒否攻撃

#### 🟢 Medium (中)
- **対応時間**: 1週間以内
- **例**:
  - 情報漏洩（非機密）
  - クロスサイトスクリプティング
  - 設定の不備

#### 🔵 Low (低)
- **対応時間**: 2週間以内
- **例**:
  - 情報の開示
  - UIの不具合によるセキュリティ影響

## 🏅 謝辞プログラム / Acknowledgment Program

### 🎖️ セキュリティ研究者への謝辞

有効なセキュリティ脆弱性を報告していただいた研究者の方には、以下の謝辞を提供いたします：

1. **公式謝辞**: CHANGELOGおよびリリースノートでの謝辞
2. **Hall of Fame**: プロジェクトWikiでの永続的な記録
3. **早期アクセス**: 新機能への早期アクセス権

### 🚫 対象外の報告 / Out of Scope

以下は対象外となります：

- 古いバージョン（サポート対象外）の脆弱性
- サードパーティライブラリの既知の脆弱性（直接影響がない場合）
- 物理的アクセスが必要な攻撃
- ソーシャルエンジニアリング
- DoS攻撃（資源枯渇によるもの）

## 🔧 セキュリティベストプラクティス / Security Best Practices

### 👥 開発者向け / For Developers

1. **入力検証**: すべての外部入力を検証
2. **最小権限の原則**: 必要最小限の権限のみ付与
3. **暗号化**: 機密データは必ず暗号化
4. **依存関係**: 定期的な依存関係の更新
5. **コードレビュー**: セキュリティ観点でのレビュー

### 👤 ユーザー向け / For Users

1. **定期更新**: 常に最新バージョンを使用
2. **権限管理**: 不要な管理者権限での実行を避ける
3. **ネットワーク**: ファイアウォールの適切な設定
4. **バックアップ**: 重要データの定期バックアップ
5. **監視**: 異常な動作の監視

## 📚 セキュリティリソース / Security Resources

### 🔗 参考文献 / References

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [CWE (Common Weakness Enumeration)](https://cwe.mitre.org/)
- [CVE (Common Vulnerabilities and Exposures)](https://cve.mitre.org/)
- [NIST Cybersecurity Framework](https://www.nist.gov/cyberframework)

### 🛠️ セキュリティツール / Security Tools

プロジェクトで使用しているセキュリティツール：

- **静的解析**: ESLint Security Plugin
- **依存関係**: npm audit, Snyk
- **暗号化**: Node.js Crypto Module
- **テスト**: Jest Security Tests

## 📞 追加サポート / Additional Support

セキュリティ関連の質問や懸念がある場合は、お気軽にお問い合わせください：

- **Email**: shizukutanaka@proton.me
- **GitHub**: [Discussions](https://github.com/shizukutanaka/Otedama/discussions) (非機密事項のみ)

---

**セキュリティは私たちの最優先事項です。** 🛡️
**Security is our top priority.**

ご協力いただき、ありがとうございます！
Thank you for helping keep Otedama secure!
