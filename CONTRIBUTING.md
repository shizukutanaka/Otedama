# Contributing to Otedama

Otedamaへのコントリビューションをご検討いただきありがとうございます。本書はコード、ドキュメント、翻訳、テスト、バグ報告など、あらゆる形式の貢献を歓迎し、その方法を案内するものです。

Thank you for considering a contribution to Otedama. This document welcomes and guides all forms of contribution, including code, documentation, translation, testing, and bug reports.

## 貢献の種類 / Types of Contribution

Otedamaプロジェクトは多様な形式の貢献を歓迎します。コードの追加・修正、ドキュメントの改善・翻訳、バグの報告、機能要望の提案、セキュリティ脆弱性の報告（`SECURITY.md`参照）、他のコントリビューターの支援、ブログ記事・チュートリアルの執筆、カンファレンスでの発表。金銭的な貢献は現在受け付けていませんが、Otedama Foundation設立後にスポンサーシッププログラムを開始予定です。

## 開始前の確認事項 / Before You Start

貢献を開始する前に、以下の文書に目を通していただくことを推奨します。`README.md`で製品の全体像を理解し、`CLAUDE.md`で設計原則と禁止事項を確認し、`ROADMAP.md`で現在の開発フェーズと優先順位を把握し、`docs/architecture.md`で技術アーキテクチャを理解してください。既存のIssueとDiscussionsも参照し、同様の提案や議論が既に存在しないかを確認してください。

大規模な変更を提案する場合は、実装を開始する前にGitHub Discussionsで議論を開始してください。数時間の議論が、数週間の手戻りを防ぎます。小規模な修正（タイポ、明らかなバグ修正、ドキュメントの小改善）は、直接Pull Requestを作成していただいて構いません。

## 開発環境のセットアップ / Development Environment Setup

Otedamaの開発には以下の環境が必要です。Go 1.22以上、Git、Docker（オプション、統合テスト用）、Make（ビルド自動化）、テキストエディタまたはIDE（VSCode、GoLand、Vim、Emacsなど任意）。クローンとビルドは以下のコマンドで実行できます。

```bash
git clone https://github.com/shizukutanaka/Otedama.git
cd Otedama
make setup      # 開発ツールのインストール
make build      # バイナリのビルド
make test       # テストの実行
make lint       # 静的解析の実行
```

開発用の設定ファイルは`config.yaml.example`をコピーして`config.yaml`として使用してください。`config.yaml`は`.gitignore`に登録されているため、秘密情報を含めてもコミットされることはありません。

## コーディング規約 / Coding Standards

Otedamaのコーディング規約はJohn Carmack、Robert C. Martin、Rob Pikeの三者の原則に基づいています。具体的な規約は以下の通りです。

Goコードは`gofmt`でフォーマットし、`golangci-lint`の厳格設定を通過する必要があります。`.golangci.yml`に設定された全てのルールを遵守してください。関数の引数数は原則として3以下に制限し、それ以上必要な場合は構造体にまとめることを検討してください。冗長なif文やネスト構造はガード節や早期returnで整理してください。

命名規則は以下の通りです。パッケージ名は小文字の単一単語（例：`stratum`、`lightning`、`arbitration`）。型名はPascalCase（例：`ArbitrationEngine`、`LightningWallet`）。公開関数・メソッドはPascalCase（例：`Connect`、`CalculateExpectedYield`）。非公開関数・メソッドはcamelCase（例：`parseMessage`、`validateConfig`）。定数はSCREAMING_SNAKE_CASEまたは適切な場合はPascalCase。

コメントはgodoc形式で記述してください。公開されている全ての型、関数、メソッドにはgodocコメントを必須とします。コメントは「何をするか」ではなく「なぜそうするか」を記述してください。「何をするか」はコード自体で明らかであるべきです。

## テストの書き方 / Writing Tests

新規機能は必ずテストを伴ってコミットしてください。テストのないコードはレビュー対象外とします。単体テスト、プロパティベーステスト、統合テスト、E2Eテストの使い分けは`CLAUDE.md`に記載されています。

テストファイルは対象ファイルと同じディレクトリに`_test.go`サフィックスで配置してください。テスト関数名は`Test<対象関数名>_<シナリオ>`の形式を推奨します（例：`TestConnect_InvalidURL`、`TestCalculateExpectedYield_EmptyPriceData`）。

テーブル駆動テストを積極的に使用してください。複数のシナリオを一つのテスト関数で網羅することで、追加シナリオの発見と記述が容易になります。外部依存（ネットワーク、ファイルシステム、時刻）は`interface`を介してモック可能な設計にしてください。

## コミットメッセージ / Commit Messages

コミットメッセージはConventional Commitsに準拠してください。プレフィックスは以下を使用します。`feat:`（新機能）、`fix:`（バグ修正）、`refactor:`（リファクタリング、機能変更なし）、`docs:`（ドキュメント）、`test:`（テスト追加・修正）、`chore:`（ビルド・ツール設定）、`perf:`（パフォーマンス改善）、`security:`（セキュリティ修正）。

コミットメッセージの本文は英語で、50文字以内の要約行、空行、72文字で折り返した詳細説明の形式を推奨します。ブレーキングチェンジは`BREAKING CHANGE:`フッターで明示してください。Issue参照は`Closes #123`または`Fixes #456`の形式でフッターに記載してください。

良い例を以下に示します。

```
feat(stratum): add Job Negotiation support for Stratum V2

Implement the Job Negotiation sub-protocol as defined in the
Stratum V2 specification. This allows miners to construct their
own block templates, reducing reliance on pool operator transaction
selection.

The implementation follows the reference spec at stratumprotocol.org
and has been tested against Braiins Pool and DEMAND.

Closes #42
```

## Pull Request手順 / Pull Request Process

新機能または大規模修正のPRは、以下の手順で提出してください。第一に、自身のフォークで`feature/<short-description>`形式のブランチを作成します。第二に、変更を実装し、テストを追加または更新します。第三に、`make test`と`make lint`をローカルで実行し、全て通過することを確認します。第四に、コミットを論理的にまとめ（必要に応じて`git rebase -i`で整理）、プッシュします。第五に、Pull Requestを作成し、PRテンプレートに従って必要情報を記入します。

PRには以下の情報を含めてください。変更の概要と動機、関連するIssue番号、テスト方法（自動テストに加えて手動確認方法がある場合）、スクリーンショット（UI変更の場合）、ブレーキングチェンジの有無と影響範囲。

PRのタイトルはコミットメッセージと同じConventional Commits形式を使用してください。これによりリリースノートの自動生成が容易になります。

## レビュープロセス / Review Process

全てのPRは以下のレビューを経てマージされます。自動化されたCI（ビルド、テスト、静的解析、セキュリティスキャン）の全通過。少なくとも一人のメンテナによる人間レビュー。セキュリティ関連の変更（`internal/security/`、`internal/lightning/`、`internal/auth/`への変更）は、二人のメンテナによる二重レビュー。

レビュアーは以下の観点で確認します。コードの正確性と設計の妥当性、テストの充実度、ドキュメントの更新、セキュリティへの影響、パフォーマンスへの影響、`CLAUDE.md`で禁止されている機能や方針への抵触の有無。

レビューコメントには建設的に応答してください。意見の相違がある場合は、技術的な理由と共に議論します。レビュアーの指摘は完璧ではなく、合意できない場合は議論の継続が適切です。ただし、最終的にマージの可否はメンテナが決定します。

## ドキュメントの貢献 / Documentation Contribution

ドキュメントの改善は、コードと同等に重要な貢献です。誤字脱字の修正、表現の改善、新規セクションの追加、新言語への翻訳、チュートリアルの執筆を歓迎します。

主要言語（英語、日本語、中国語、韓国語、スペイン語、フランス語、ドイツ語、ポルトガル語、ロシア語、アラビア語）への翻訳は、人間レビュー済みの品質を維持するため、ネイティブスピーカーまたは堪能な方からの貢献を特に歓迎します。その他の言語は機械翻訳で対応していますが、品質改善の貢献は歓迎します。

## プラグインの貢献 / Plugin Contribution

Otedamaはプラグインアーキテクチャを提供しており、コア本体への変更なしに新規収益源やカスタム機能を追加できます。プラグインの公式認証（Otedama Compatible認証）を希望される場合、以下の基準を満たす必要があります。Apache License 2.0、MIT、BSDのいずれかのライセンスでの公開。公式プラグインAPIへの準拠。セキュリティレビューの通過。メンテナンスの継続性（直近6ヶ月以内の更新）。

認証を受けていないプラグインもコミュニティで流通できますが、`SECURITY.md`に記載の通り、未認証プラグインの使用はユーザー自己責任となります。

## 行動規範 / Code of Conduct

Otedamaコミュニティは、全ての参加者が尊重され、安全に参加できる環境を目指します。以下の行為は禁止されます。ハラスメント、差別的言動、人格攻撃、スパム、荒らし行為、他者のプライバシー侵害。建設的な批判と個人攻撃を区別してください。技術的な意見の相違は議論の対象ですが、個人への攻撃は対象ではありません。

問題のある行為に遭遇した場合、メンテナにご報告ください。報告者のプライバシーは守られ、適切な対応が取られます。重大な違反者には、プロジェクトからの永久追放を含む処分が下される場合があります。

## AI支援コードのポリシー / AI-Assisted Code Policy

Otedamaは、AI支援ツール（GitHub Copilot、Claude、Cursor等）の使用を歓迎しますが、以下の規律を要求します。

**You are responsible for AI output as if you wrote it.**
AIが生成したコードであっても、コミットした時点であなたがその著者です。レビュー責任、保守責任、ライセンス整合責任は、すべてコミッターにあります。「AIが書いたから」は弁解として認められません。

**Meaningful review and modification required.**
AI出力をそのままコミットすることを禁止します。各行を読み、ロジックを理解し、Otedamaのコーディング規約に合わせて修正してください。**10行を超える逐語的なAI出力のコミットは禁止**します。

**Copilot duplication filter must be enabled.**
GitHub Copilotを使用する場合、Settings > Copilot > Duplication detection を **strict** に設定してください。これは、Doe v. GitHub訴訟（2025年11月和解）以降、GPL/AGPL/LGPLコードの逐語コピーを防ぐためのデフォルト推奨設定です。

**Tag AI-assisted commits.**
AI支援によるコミットには、コミットメッセージ末尾に共著者表記を加えてください。

```
fix: correct stratum frame parsing edge case

Co-authored-by: GitHub Copilot <noreply@github.com>
```

法的に必須ではありませんが、将来の規制変更（特にEU AI Act の下流ユーザー要件）に備えた安全策です。

**No verbatim copying of license-incompatible code.**
GPL、AGPL、LGPLコード、または出所不明のコードをAIが提案した場合、それを採用してはなりません。Apache 2.0、MIT、BSD、ISC、MPL-2.0のいずれかであることを確認してください。判断に迷う場合は、PRに `needs-license-review` ラベルを付けて議論してください。

**The clause applies to all forms of AI assistance,** including but not limited to: コード補完、リファクタリング提案、テスト生成、ドキュメント生成、コミットメッセージ生成。

このポリシーの目的は、AI支援を禁止することではなく、AI支援を **責任ある形で** 利用するための明示的な枠組みを提供することです。AIは生産性を大幅に向上させますが、責任の所在を曖昧にすることは許されません。

---

## ライセンス / License

Otedamaへの貢献は、プロジェクトの`LICENSE`ファイルに記載されたApache License 2.0の下で公開されることに同意したものとみなされます。貢献前に、あなたがその変更をオープンソースライセンスで公開する権利を持っていることを確認してください。雇用主の知的財産権に関わる場合、事前に雇用主の許可を得てください。

**DCO (Developer Certificate of Origin):** 全コミットには `git commit -s` による Signed-off-by 行が必要です。これにより、Apache 2.0 §3 の特許付与条項の対象となる貢献であることを宣言します。CLA（Contributor License Agreement）は採用しません — DCOのほうが、ソロメンテナにとって運用負担が軽く、Apache 2.0 のライセンス条項自体が同等の保護を提供します。

### SPDX ヘッダー / SPDX Headers

新規作成する全 Go ファイル(実装・テスト共)は冒頭2行に以下のヘッダーを記載してください:

```go
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
```

Every newly-created Go file (implementation and tests alike) must
begin with these two lines. This is verified by automated tooling and
is checked during PR review. The reason: SPDX headers let downstream
distributions (Linux distros, security scanners, license-compliance
tools) determine each file's license without parsing the entire repo.

第三者コードを含める場合(極めて稀ですが)、その出所と元のライセンスを明示する追加コメントを付け、`NOTICE` ファイルに帰属表記を追加してください。

## 質問と支援 / Questions and Support

貢献プロセスに関する質問は、GitHub Discussionsの「Contributors」カテゴリで受け付けています。初めての貢献者には特に手厚く支援いたしますので、遠慮なくご質問ください。技術的な議論は該当するIssueまたはDiscussionsで行い、一般的な質問はDiscussionsの「Q&A」カテゴリをご利用ください。

## 最後に / Final Note

貢献者の皆様に深く感謝いたします。Otedamaはコミュニティの貢献なしには成立しません。一つ一つの貢献が、プロジェクトの長期的な価値を形成しています。
