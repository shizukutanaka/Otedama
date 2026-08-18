# CLAUDE.md — Otedama開発運用書

本書は、Otedamaプロジェクトに関わるClaude Code（およびその他のAIエージェント）が従うべき製品定義、設計原則、禁止事項、ワークフローを明文化したものです。本書との不整合を生じる全ての実装提案は、議論の上で明示的に承認されるか、却下されます。

## 製品定義（不変）

Otedamaは、ユーザー所有のASIC・GPU・CPUハードウェアを、ビットコイン採掘・AI推論提供・分散レンダリング・科学計算委託の四系統にリアルタイム裁定配分する非カストディ・Stratum V2準拠のソフトウェアスイートです。この定義に含まれない機能の追加は、原則として却下されます。

## 設計原則

Otedamaの設計はJohn Carmack、Robert C. Martin、Rob Pikeの三者の原則に従います。Carmackの原則はパフォーマンスを後付けではなく最初から設計に組み込むこと、プロファイリングに基づいた最適化を行うこと、ホットパスには徹底した配慮を払うことを要求します。Martinの原則はクリーンアーキテクチャ、単一責任原則、依存関係の逆転、テスタビリティの確保を要求します。Pikeの原則は簡潔性、明示的な並行処理、少数の直交する抽象、そして「賢すぎるコードよりも、退屈で明快なコード」を要求します。

これらの原則が対立する場合の優先順位はCarmack、Pike、Martinの順です。すなわちパフォーマンスが最優先、次に簡潔性、その次にアーキテクチャの美しさです。ただし「パフォーマンス優先」はプロファイリング結果に裏付けられる場合にのみ適用され、推測に基づく早期最適化は禁止されます。

## 禁止事項

以下の機能および方針は、Otedamaにおいて明示的に禁止されます。第一に、多通貨対応の拡張（BTCを主軸とし、SHA256d以外のアルゴリズム対応は削除済みであり、再追加しません）。第二に、量子耐性演出機能（v4.0で実装を検討しますが、現段階での着手は禁止）。第三に、独自トークン発行、ICO、ガバナンストークンのいかなる形態。第四に、中央集権的コンポーネント（独自プール運営、カストディアル決済、独自KYC実装）の追加。第五に、KYC独自実装（ZKPによる代替を提供し、従来型KYCは実装しません）。第六に、競合製品名、類似製品名、著作権侵害のおそれのある名称の使用。第七に、存在しないURL・API・エンドポイント・アドレスの記載。第八に、量産実装前の思弁的機能（VRChat連携、ゲーム内通貨、NFT、メタバース等）。

違反する実装提案がコード提出された場合、レビュー段階で却下し、本書への参照を明示してフィードバックします。

## アーキテクチャマップ (v3.0.0-alpha.1)

リポジトリ構造は以下の通りです。**ここに存在しないパスへのコード追加は禁止**。変更する場合は事前にアーキテクチャレビューを経ること。

```
Otedama/
├── cmd/otedama/            # CLI エントリポイント（run/version/config/service/doctor/wallet/completion）
├── internal/
│   ├── arbitration/        # 純粋関数の裁定エンジン（副作用なし）
│   ├── btccrypto/          # アドレス検証と署名スキームの継ぎ目(secp256k1/Schnorr スタブ)
│   ├── clock/              # time 抽象化（clock.Fake でテスト可能）
│   ├── config/             # 4 層設定（デフォルト→ファイル→env→フラグ）
│   ├── daemon/             # systemd/launchd/Windows サービス管理
│   ├── doctor/             # 17 並行ヘルスチェック
│   ├── engine/             # 全パッケージを統合するメインループ
│   ├── hal/                # ハードウェア抽象化（CPU常時、Linux GPU sysfs）
│   ├── httpserver/         # /healthz /readyz /metrics /
│   ├── i18n/messages/      # メッセージカタログ（10 言語）
│   ├── lightning/          # BIP-39 シード生成・AES-GCM 暗号化ウォレット
│   ├── logger/             # log/slog ラッパー（atomic.Pointer で race-free）
│   ├── metrics/            # Prometheus exposition（外部依存ゼロ）
│   ├── miner/              # SHA-256d + CPU ワーカー
│   ├── poolproto/          # プール接続プロトコル抽象化(SV1/SV2/DATUM)
│   │   ├── stratumv1/      # Stratum V1 具体実装(JSON-RPC over TCP)
│   │   └── stratumv2/      # Stratum V2 dialer 具体実装
│   ├── provider/           # MiningProvider のみ（単数形。providers/ は誤り）
│   ├── rates/              # BTC/USD 価格（Coinbase/Kraken/CoinGecko 中央値）
│   ├── stratum/            # Stratum V2 フレーム・メッセージ・Noise NX
│   ├── tui/                # ANSI ダッシュボード（外部依存ゼロ）
│   └── version/            # ビルドメタデータ（ldflags 注入）
├── docs/adr/               # ADR-001〜011
├── skills/                 # tdd.md / code-review.md / security-audit.md / release-procedure.md
└── .github/workflows/      # ci.yml / test.yml / security.yml / release.yml（session 264 で ci-cd.yml・code-review.yml・deploy.yml を削除。残る3ファイルの死んだジョブは KNOWN_LIMITATIONS §13 に手順を記載）

# 存在しないパス（作成禁止）:
# cmd/otedamad/           → デーモンモードは service サブコマンドで代替
# internal/providers/     → provider/ が正しい（複数形は誤り）
# internal/auth/          → ZKP認証は v4.0 スコープ
# internal/render/        → 分散レンダリングは v4.0 スコープ
# internal/scientific/    → 科学計算は v4.0 スコープ
# internal/observability/ → logger/ + metrics/ + httpserver/ に分散済み
# internal/security/      → lightning/ + stratum/ に内包
# pkg/                    → 外部公開 API は計画なし
# web/                    → Web 管理 UI は計画なし
# k8s/                    → docs/DEPLOYMENT.md の YAML で代替
```

`internal/lightning/` と `internal/stratum/noise*` は資金に関わる領域です。変更時は CODEOWNERS により maintainer 必須レビューとなっています。

## 開発ワークフロー

全ての新規機能は以下の順序で開発します。第一に要件定義（GitHub Issueでの議論と合意）、第二に基本設計（アーキテクチャへの影響と依存関係の明示）、第三に詳細設計（インターフェース定義とテスト設計）、第四に開発（TDDを推奨）、第五にテスト（単体・統合・E2E）、第六にレビュー（自動解析＋AIレビュー＋人間レビュー）、第七にリリースの七段階です。この順序をスキップする提案は却下します。

コミットメッセージは Conventional Commits に準拠します。`feat:`、`fix:`、`refactor:`、`docs:`、`test:`、`chore:`、`perf:`、`security:` のプレフィックスを使用し、変更内容を英語で簡潔に記述します。ブレーキングチェンジは `BREAKING CHANGE:` フッターで明示します。

ブランチ戦略は GitHub Flow に準拠します。`main` ブランチは常にリリース可能な状態を保ち、機能開発は `feature/xxx` ブランチで行い、Pull Requestを経てmainにマージされます。`legacy-v2` ブランチは旧バージョンの保全用であり、重大セキュリティ修正以外のコミットは禁止します。

## テスト要件

テストカバレッジは90%以上を維持します。ただしカバレッジは手段であり目的ではないため、意味のないテストを追加してカバレッジを水増しすることは禁止します。以下のテスト種別を用途に応じて使い分けます。単体テストは関数・メソッドの正常系と異常系を網羅します。プロパティベーステストはアルゴリズム（裁定エンジン、Lightning決済計算）の不変条件を検証します。ファズテストはパーサ・プロトコル実装（Stratum V2メッセージ処理）に適用します。統合テストはモジュール間連携を検証します。E2Eテストは主要ユーザーフローを検証します。負荷テストはプール接続・AI推論ルーティングのスケーラビリティを検証します。

全てのテストはCI上で自動実行され、mainへのマージ前に全テストが通過することを必須とします。

## セキュリティ要件

セキュリティ関連の全ての変更は、以下の三層レビューを経ます。第一層は自動セキュリティスキャン（gosec、CodeQL、Semgrep、govulncheck）。第二層はAIレビュー（本Claude Codeまたは他のAIモデルによる差分レビュー）。第三層は人間レビュー（可能な場合は外部セキュリティ専門家を含む）。この三層のいずれも省略できません。

秘密情報（APIキー、秘密鍵、パスワード、シード）のコミットは絶対禁止です。`.gitignore` に適切なパターンを含め、コミット前フックで検出します。環境変数またはHashiCorp Vaultなどの専用シークレット管理システムを使用します。

暗号化処理は自前実装せず、標準ライブラリまたは監査済みライブラリ（`crypto/`、`btcec`、LDK）のみを使用します。独自暗号の実装は禁止します。

## 外部依存の管理

外部依存の追加は、以下の基準を全て満たす場合にのみ許可します。第一に、標準ライブラリで代替不可能であること。第二に、ライセンスがApache 2.0、MIT、BSD、またはそれらと互換性があること（GPL系は依存関係として禁止）。第三に、直近1年以内に有意義なメンテナンス活動があること。第四に、既知の脆弱性（`govulncheck` で検出）がないこと。第五に、プロジェクト全体の依存ツリーに重複する機能の依存が生じないこと。

依存追加時は `go.mod` のコメントに追加理由と選定基準を記録します。依存削減は常に歓迎されます。

## ドキュメント要件

公開API（`pkg/` 配下）の全ての型・関数・メソッドには godoc コメントを必須とします。`internal/` 配下も主要な型とパブリック関数には godoc コメントを付与します。アーキテクチャ判断（ADR: Architecture Decision Record）は `docs/adr/` に順次記録します。

ユーザー向けドキュメントは日本語と英語を同時に更新します。主要10言語（英・日・中・韓・西・仏・独・葡・露・アラビア）への翻訳はリリース前に完了させます。機械翻訳で1,000言語以上への対応を提供しますが、主要10言語は人間レビュー済みを維持します。

## Claude Code専用指示

Claude Codeが本プロジェクトで作業する際は、以下の追加ルールに従います。第一に、読んでいないコードは変更しないこと。変更前に該当ファイル全体を読み、依存する呼び出し元も確認します。第二に、ファイル作成前に類似内容のファイルが既存しないか確認し、存在する場合は統合を提案します。第三に、重複コードを発見した場合は、即座に修正せず、まずIssueとして記録し優先度を議論します。第四に、連続して実装に失敗した機能はスキップし、後で再検討します。失敗の繰り返しはコンテキスト設計の問題を示唆します。第五に、バージョンは分岐せず常に1つで管理します。第六に、存在しないURL・API・アドレスの生成を禁止します。不明な場合は「調査が必要」と明示します。

スキルベースの反復作業は `skills/` 配下に定義します。コードレビュー、リファクタリング、リリース手順、セキュリティ監査の各スキルは定期的に更新します。

## 参照リンク

- Stratum V2仕様: https://stratumprotocol.org/specification/
- Lightning Development Kit: https://lightningdevkit.org/
- gstack方法論: https://github.com/garrytan/gstack
- Apache License 2.0: https://www.apache.org/licenses/LICENSE-2.0

## 本書の更新

本書の変更はOtedama Foundation理事会（設立後）または現在のメンテナの合意により行います。全ての変更はGit履歴で追跡され、変更理由を明示します。

最終更新: 2026年8月（session 264 — アーキテクチャマップの事実修正のみ。CLI に wallet を追加、
btccrypto の ML-DSA scaffold と provider の AkashProvider を削除済みに反映、
.github/workflows の実在ファイルに更新。方針・禁止事項・設計原則は無変更。）
