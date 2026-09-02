# Otedama Solo Operations Manual
# 1人運営の完全設計書

本書は、Otedamaを1人のメンテナが長期持続可能な状態で運営するために必要な
全要素を定義する実務文書である。研究が示す冷酷な現実から出発し、
具体的な自動化・法務・収益・メンタルヘルスの各層で何を構築するかを規定する。

**読み方（session 266 で明記）。** 本書はほぼ全体が**提案**であって実装記録ではない。
以前は一部の項目が「設定済み」「実施済み」と書かれていたが、実際には未実施であった
（SHA ピン留め、cosign 署名、govulncheck の週次実行、Renovate、CI での fuzz — 5件全て）。
それらは本セッションで実状に直した。**本書に現れる YAML・JSON・シェルは全て「こう書くべき」
という案であり、リポジトリに存在するファイルの引用ではない。** 実際に存在するものだけを
知りたい場合は `.github/` を直接読むこと。未実施項目のブロッカーは
`docs/KNOWN_LIMITATIONS.md` §21 にまとめてある。

---

## 現実から始める：ソロメンテナの統計

2025年のTidelift調査によれば、OSSメンテナの60%が報酬ゼロ、
同60%が離脱を検討、バーンアウト率は44%に達する。
2025年11月にはKubernetes Ingress NGINXがメンテナバーンアウトにより
セキュリティパッチ提供を停止した。これは仮定ではなく、
実際のプロジェクト消滅の記録である。

Otedamaがこの統計に飲み込まれない条件は一つだけである：
**運営コストの大半を自動化し、残った人間の作業だけを行う設計**。
以下はその設計の全容である。

---

## 第1層：自動化により人間の作業をゼロに近づける

### 1.1 CI/CDの完全自動化

GitHub Actionsを以下の原則で設計する：

**全サードパーティActionはSHAピン留め必須**
2025年3月、tj-actions/changed-files (CVE-2025-30066) が
悪意ある更新によりCI/CDシークレットを23,000以上のリポジトリから漏洩させた。
タグ参照（`@v4`）は実行時に書き換え可能である。SHAピン留めのみが
供給チェーン攻撃を構造的に防ぐ。

```yaml
# 危険：タグは改ざん可能
- uses: actions/checkout@v4

# 安全：SHAは不変
- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683  # v4.2.2
```

**自動化すべき作業の完全リスト：**

| 作業 | ツール | 頻度 |
|------|--------|------|
| テスト実行 (全OS) | GitHub Actions matrix | push毎 |
| 静的解析・lint | golangci-lint | push毎 |
| セキュリティスキャン | gosec, govulncheck, CodeQL | push毎 |
| 依存脆弱性スキャン | Dependabot + govulncheck | 週次 |
| バイナリビルド | goreleaser | tag push時 |
| チェックサム生成 | sha256sum | tag push時 |
| GPG署名 | cosign | tag push時 |
| Docker push | GHCR | tag push時 |
| CHANGELOG生成 | git-cliff | tag push時 |
| SBOMの生成 | syft | tag push時 |

**goreleaser設定例：**
```yaml
# .goreleaser.yaml の核心部分
builds:
  - goos: [linux, darwin, windows, freebsd]
    goarch: [amd64, arm64]
    flags: [-trimpath]
    ldflags:
      - -s -w
      - -X github.com/shizukutanaka/Otedama/internal/version.Version={{.Version}}
      - -X github.com/shizukutanaka/Otedama/internal/version.Commit={{.Commit}}
      - -X github.com/shizukutanaka/Otedama/internal/version.BuildDate={{.Date}}

signs:
  - cmd: cosign
    args: ["sign-blob", "--output-signature=${signature}", "${artifact}"]
    artifacts: all

sboms:
  - artifacts: archive
```

### 1.2 Issue/PRの自動トリアージ

人間の意思決定が必要なものと、自動処理すべきものを分離する。

**GitHub Actionsで自動処理：**
- 72時間以上情報不足のIssueに`needs-info`ラベル → 7日後自動クローズ
- 依存更新PRのテスト通過 + 軽微な変更 → 自動マージ（Renovatebot）
- スパムコメントの自動非表示
- `[BUG]`プレフィックスのないIssueへの自動テンプレート再案内

**Renovatebotの設定（自動依存更新）：**
```json
{
  "extends": ["config:base"],
  "schedule": ["every weekend"],
  "automerge": true,
  "automergeType": "pr",
  "packageRules": [
    {
      "matchUpdateTypes": ["patch", "minor"],
      "matchPackagePatterns": ["golang.org/x/"],
      "automerge": true
    },
    {
      "matchUpdateTypes": ["major"],
      "automerge": false,
      "labels": ["major-update"]
    }
  ]
}
```

### 1.3 ユーザーサポートの自動化

**最重要の知見：** Daniel Stenberg（curl作者）は
毎週相当時間をサポートリクエストへの返答だけに費やしている。
Otedamaはこの問題を事前設計で解決する。

**自動サポートの階層：**
```
レベル0（ゼロタッチ）：
  - README.mdのトラブルシューティングセクション
  - FAQ（実際のIssueから自動生成、週次更新）
  - docs/で検索可能なエラーコード一覧
  - GitHub Discussions の「Q&A」カテゴリ

レベル1（Botによる一次応答）：
  - 既知エラーコード → 自動的に該当FAQリンクを返信
  - 「バージョンを教えてください」への自動テンプレート返信
  - 重複Issueの自動検出と本家Issueへの誘導

レベル2（メンテナが介入）：
  - セキュリティ脆弱性報告
  - 新規の再現可能なバグ
  - 設計上の決定が必要な機能要望
```

**GitHub Actionsで実装するBot応答：**
```yaml
name: Issue Triage
on:
  issues:
    types: [opened]
jobs:
  check-template:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/github-script@v7
        with:
          script: |
            const body = context.payload.issue.body || ''
            const hasChecklist = body.includes('- [x]')
            if (!hasChecklist) {
              github.rest.issues.createComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: context.payload.issue.number,
                body: 'Issue templateのチェックリストが完了していません。' +
                      'チェックリストを全て確認してから再送してください。'
              })
              github.rest.issues.addLabels({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: context.payload.issue.number,
                labels: ['needs-info']
              })
            }
```

---

## 第2層：セキュリティ運用の自動化

Otedamaはユーザーの資金を扱うソフトウェアである。
セキュリティインシデントは財務損失に直結する。

### 2.1 脆弱性報告の受け口

**GitHub Private Vulnerability Reportingを有効化する。**
これによりセキュリティ報告者はIssueを公開せずに直接メンテナに報告できる。
設定方法：Settings > Code security > Private vulnerability reporting > Enable

**SECURITY.md に明記すべき事項：**
```markdown
## 報告先
GitHub Private Vulnerability Reporting を使用してください。
https://github.com/shizukutanaka/Otedama/security/advisories/new

## 対応期間の約束
- 受領確認：48時間以内
- 重大度評価：7日以内
- パッチリリース：重大は7日、高は30日、中は90日

## 報奨金
現時点では金銭的報奨金を提供していません。
ただし、HALL_OF_FAME.mdへの掲載と謝辞を保証します。
```

### 2.2 継続的セキュリティスキャン

**週次で自動実行するセキュリティワークフロー：**
```yaml
name: Weekly Security Audit
on:
  schedule:
    - cron: '0 2 * * 1'  # 毎週月曜 02:00 UTC
jobs:
  govulncheck:
    runs-on: ubuntu-latest
    steps:
      - uses: golang/govulncheck-action@v1
  
  osv-scanner:
    runs-on: ubuntu-latest
    steps:
      - uses: google/osv-scanner-action@v1
        with:
          scan-args: |-
            --recursive
            ./

  scorecard:
    runs-on: ubuntu-latest
    permissions:
      security-events: write
    steps:
      - uses: ossf/scorecard-action@v2
        with:
          results_format: sarif
          publish_results: true
```

**Scorecard で監視する項目（OpenSSF Security Scorecard）** — 括弧内は session 266 時点の実状：
- Dependency-Update-Tool（**Dependabot は設定済み**。Renovate は未導入）
- Signed-Releases（**未設定**。cosign はリポジトリに存在しない）
- Branch-Protection（設定必要）
- Token-Permissions（設定必要）
- Fuzzing（**部分的**。fuzz target は `internal/stratum/frame_fuzz_test.go` に2本あるが、
  CI で `-fuzz` を回すジョブは無く、通常の seed corpus テストとしてしか実行されていない）

### 2.3 インシデント対応の事前設計

**Runbook（https://github.com/shizukutanaka/Otedama/wiki に配置）：**

```
セキュリティインシデント発生時の手順：

1. 重大度判定（15分以内）
   - CRITICAL: 資金流出可能、認証バイパス可能
   - HIGH: データ漏洩、プロセス乗っ取り
   - MEDIUM: サービス妨害、軽微な情報漏洩
   - LOW: 設定ミス、非実害的な情報開示

2. 初動（CRITICAL/HIGH の場合、1時間以内）
   - 影響バイナリをGitHub Releasesから一時削除
   - Discordの #announcements で警告投稿
   - 修正ブランチを hotfix/CVE-YYYY-NNNNN で作成

3. パッチリリース（重大は72時間以内）
   - fix コミット（詳細は非公開、脆弱性修正とのみ記述）
   - CVE番号申請（Mitre または GitHub経由）
   - patch version タグ
   - SECURITY.md のアドバイザリへのリンク追加

4. 事後公開（パッチリリース後7日）
   - 完全な技術的詳細の公開
   - 影響範囲の明示
   - 今後の再発防止策の公表
```

---

## 第3層：法的・財務的コンプライアンス

### 3.1 日本における法的位置づけ

> **本節は法的助言ではない。** 以下は記載時点での制度理解の要約であり、
> リポジトリ内のコードからは検証できない。実際の判断は資格を持つ専門家に確認すること。
> 引用している制度・判断（CAESP 登録要件、CARF、SEC の見解など）は年月とともに変わる。

**Otedamaは以下の理由でCAESP登録不要である：**

日本の資金決済法は「暗号資産の売買・交換を業として行う者」に
CAESP（Crypto Asset Exchange Service Provider）登録を義務付ける。
OtedamaはBitcoinを売買・交換・保管しない。
ユーザーのマイニング収益は直接ユーザーのウォレットに送金され、
Otedamaのサーバーを経由しない非カストディ設計である。

**ただし以下の事項を CLAUDE.md と法務メモに明記する：**
```
1. Otedamaはマイニングソフトウェアである。
   仲介業者ではない。交換業者でもない。

2. ユーザーの資金をOtedamaが一切保管しない。
   秘密鍵はユーザーデバイス上にのみ存在する。

3. PoolへのStratum V2接続を確立する際、
   Otedamaは認証情報をPoolに送信する（Bitcoinアドレス）。
   この行為はマイニングの技術的要件であり、仲介業ではない。

4. 収益はPoolからユーザーのLightningアドレスに直接送金される。
   Otedamaのコードはこの送金パスを仲介しない。
```

**CARF（Crypto-Asset Reporting Framework）への対応：**
2026年1月から、日本の暗号資産交換業者はOECDのCARFに基づき
ユーザーの取引情報を税務当局に報告義務を負う。
Otedamaはサービス業者ではないためCARF対象外だが、
ユーザー向けドキュメントに以下を明記する：
「マイニング収益は雑所得として申告義務がある可能性があります。
税務上の取り扱いについては税理士にご確認ください。」

**SEC（米国）の立場の明確化：**
2025年3月20日、SECはBitcoinのProof-of-Workマイニングは
証券法の適用対象外と明示した。これはOtedamaが米国ユーザーに
法的グレーゾーンなくサービス提供できることを意味する。

### 3.2 ライセンスと著作権

**Apache 2.0の選択根拠：**
- 特許権の明示的許諾（GPLより企業採用しやすい）
- 改変の公開義務なし（MIT同等の自由度）
- コントリビューター保護（DCOと組み合わせる）

**DCO（Developer Certificate of Origin）：**
CLA（Contributor License Agreement）の代わりにDCOを採用する。
DCOはコントリビューターが「この貢献を提出する権利を持ち、
プロジェクトのライセンス下で提出することに同意する」と
コミットメッセージに`Signed-off-by`行で宣言する仕組みである。
CLAと異なり弁護士不要、署名プラットフォーム不要、
コントリビューターへの心理的障壁が低い。

`.github/workflows/dco.yml`:
```yaml
name: DCO
on: [pull_request]
jobs:
  dco:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/dco@main
```

### 3.3 収益と税務

**GitHub Sponsors（Lightning受取）：**

GitHub SponsorsはJapanのメンテナへの支払いをStripe経由で行うが、
前述の通りGitHub Sponsorsは多くの国でキャップと手数料の問題を抱える。
Otedamaの収益モデルはLightning Networkを直接活用する：

```
推奨収益チャンネル（優先順）：

1. Lightning Network tipjar
   - README に Lightning アドレスを1行掲載する
   - 受取即時、手数料ほぼゼロ、KYCなし
   - 具体的なアドレスは本書に書かない。CLAUDE.md は検証できないアドレスの記載を
     禁じており、リポジトリ内の文書からは受取先の実在を確かめようがない。
     掲載するアドレスはメンテナ本人が README に直接置く

2. GitHub Sponsors
   - 月額ティアを設定
   - Stripe 経由、手数料あり
   - 法人スポンサーへのアピール用

3. Bug bounty からの収益
   - Immunefi または独自バグバウンティ（Phase 2以降）

採らない選択肢：**Otedama Cloud / Managed Lightning ノードのホスティング**。
以前ここに Phase 4 の収益源として挙がっていたが、カストディアルな運用主体を作ることになり、
CLAUDE.md 禁止事項第四（中央集権的コンポーネント）に抵触する。SUSTAINABILITY.md も Cloud を
「拒否する機能」に数えており、2文書が矛盾していた。矛盾は Cloud を落とす側で解消した。
```

**日本での税務処理：**
マイニングソフトウェアのメンテナとして受け取る
GitHub Sponsorsや寄付は「雑所得」となる可能性が高い。
年間収入が一定額を超えた場合に確定申告が必要になる。
Lightningで受け取ったBitcoinは受取時の時価で所得計算。
税理士（できればBTC/暗号資産対応）への年次相談を推奨する。

---

## 第4層：コミュニティの最小限の維持

### 4.1 コミュニティインフラの選択

**Discordは採用しない理由：**
リアルタイムチャットは非同期OSS開発の最大の時間泥棒である。
Discordのモデレーションと応答への期待は
ソロメンテナのバーンアウトを最速で引き起こす。

**代替：**
```
GitHub Discussions（主要チャンネル）
  - Q&A: 技術質問。ユーザー間の相互解決を促進
  - Announcements: メンテナのみ書き込み可
  - Ideas: 機能要望の議論
  - Show and tell: コミュニティの使用事例共有

Matrix（任意参加、リアルタイム補足）
  - #otedama-dev: 開発者向け
  - #otedama-general: 一般ユーザー
  - 不在時のレスポンス義務なし
```

### 4.2 貢献者管理の自動化

**Good First Issueの自動生成：**
CIで静的解析を実行した後、一部の修正提案を
`Good First Issue` として自動的にIssue化するワークフロー。
例：未使用エラーの一覧、未カバレッジの関数一覧。

**CONTRIBUTORS.mdの自動更新：**
```yaml
name: Update Contributors
on:
  push:
    branches: [main]
jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: akhilmhdh/contributors-readme-action@v2.3.6
        with:
          image_size: 100
          columns_per_row: 6
```

### 4.3 発信の自動化

1人での発信は手動では継続不可能である。
以下を自動化する：

```
リリース時の自動投稿フロー（GitHub Actions）：
1. タグpush → goreleaser でバイナリ生成
2. git-cliff で CHANGELOG 自動生成
3. GitHub Release 自動作成
4. X (旧Twitter) API への自動投稿 (日本語/英語)
5. GitHub Discussions の Announcements に自動投稿

月次レポートの自動生成（毎月1日）：
- ダウンロード数（GitHub Releases API）
- 新規Star数（GitHub API）
- クローズされたIssue数
- カバレッジの推移
→ GitHub Discussionsに自動投稿
```

---

## 第5層：インフラコストをゼロに近づける

### 5.1 サーバーを持たないことでゼロにする

**Otedama にサーバーサイドコンポーネントは無い。** ユーザーの端末で動くバイナリが1つあるだけで、
バックエンド API もデータベースも存在しない。これは節約策ではなく製品定義（非カストディ）の
帰結であり、インフラコストが小さいのはその副産物である。

以前ここには Cloudflare Workers + KV に「プール推薦エンドポイント」を置く案が書かれていたが、
それは Otedama が運用する中央集権コンポーネントであり、CLAUDE.md 禁止事項第四に抵触する。
同じ節の 5.2 が「サーバーメトリクスは不要（サーバーが無いため）」と書いていたので、
本書は自分自身と矛盾していた。矛盾はサーバーを持たない側で解消した。

```
配置先の決定：
  - CI/CD: GitHub Actions（無料枠）
  - バイナリホスティング: GitHub Releases（無料）
  - ドキュメント: GitHub Pages（無料）
  - バックエンド API: 無し（意図的）
  - DB: 無し（意図的）
  - ドメイン: 年約$10-15
  - 合計月額: ドメイン代のみ
```

### 5.2 監視の最小化

本番環境の監視は最小限にする。
Otedamaはユーザーの端末で動くソフトウェアであり、
サーバーサイドの可用性要件は極めて低い。

```
必要な監視のみ：
  - UptimeRobot（無料）: GitHub Pages のURL死活監視
  - Sentry（無料ティア）: クラッシュレポート集約
    → バイナリに opt-in のクラッシュレポートを実装
    → デフォルトOFF、ユーザーが明示的に有効化する場合のみ送信
  
  不要な監視（導入しない）：
  - サーバーメトリクス（サーバーがない）
  - ユーザー行動分析（プライバシー優先のため）
  - A/Bテスト（ソロには過剰）
```

---

## 第6層：個人の持続可能性設計

### 6.1 週次作業量の上限設定

**鉄則：週10時間を超えない。**

2024年データによれば、OSSメンテナの平均作業時間は
週8.8時間で、人気プロジェクトでは20-30時間に達する。
Otedamaがその罠に入らないために：

```
毎週の作業時間配分（最大10時間）：
  - 実装・コード: 5-6時間（最優先）
  - Issue/PRレビュー: 1-2時間
  - リリース・運用: 0-1時間
  - コミュニティ発信: 1時間
  - ドキュメント: 1時間
```

**週次チェックリスト（30分で完結）：**
```
毎週月曜日：
□ Dependabotアラートの確認（5分）
□ govulncheckの結果確認（2分）
□ 新規Issueのトリアージ（10分）
□ PRレビュー（あれば）
□ Scorecardスコアの確認（2分）
□ 週次作業ログの記録（1行）
□ 翌週の実装目標を1行で書く（5分）
```

### 6.2 メンテナ休暇プロトコル

ソロメンテナが休暇・病気・緊急事態で不在になる場合の手順：

```
2週間以上の不在が予想される場合：
1. GitHub Discussionsに「一時休止中」の告知を投稿
2. READMEのトップに休止期間とIssue対応停止を明記
3. セキュリティ報告の代理受け口を1名指定しておく
   （信頼できるコアコントリビューターが増えた場合）

不在中に重大インシデントが発生した場合：
→ GitHub Mobile通知で検知 → 最低限のホットフィックスのみ対応
→ 詳細対応は復帰後
```

### 6.3 バーンアウト早期検知

```
以下の兆候が2週間以上続く場合は意図的な休止を取る：
- Issueを開くたびに苛立ちを感じる
- コードを書く意欲が湧かない
- ユーザーからの感謝が虚ろに感じる
- 新しい機能アイデアが浮かばない

バーンアウト防止の具体策：
- 「楽しいコード」を意識的に1つ混ぜる（毎スプリント）
- リリースをお祝いする（小さくても良い）
- Issueを全て解決しようとしない
- 「このProjectに何をしたいか」を月に1回書き直す
```

---

## 第7層：段階的な権限委譲設計

今はソロだが、将来コアコントリビューターが現れた場合の
設計を事前に用意しておく。権限移譲が計画されていないプロジェクトは
メンテナが倒れた瞬間に消滅する。

### 7.1 CODEOWNERS の設計

実ファイル `.github/CODEOWNERS` の資金クリティカル部分は次の通り
（以前ここに載っていた例は `/internal/security/` と `/internal/auth/` を挙げていたが、
CLAUDE.md がどちらも「作成禁止パス」と明記しており、存在しないディレクトリを守る
CODEOWNERS 行は何も守らない）：

```
# Global fallback: メンテナが全PRをレビュー
*                             @shizukutanaka

# 資金クリティカル：メンテナ必須（将来は2名以上）
/internal/lightning/          @shizukutanaka
/internal/btccrypto/          @shizukutanaka
/internal/poolproto/          @shizukutanaka
/internal/stratum/noise*      @shizukutanaka

# ドキュメント
/docs/                        @shizukutanaka
```

### 7.2 コアコントリビューター昇格基準

```
コアコントリビューター（triage権限）への昇格条件：
- 5つ以上の有意なPRがマージされている
- 3ヶ月以上の継続的な貢献
- セキュリティ上の問題を報告したことがある（加点）

コアコントリビューター（write権限）への昇格条件：
- triage権限保有者として6ヶ月以上
- セキュリティ関連コードを正しくレビューした実績
- 本人から希望の申し出

これらの基準は今は参考文書だが、
コントリビューターが現れた際に機械的に適用する。
```

### 7.3 プロジェクト継続性の保証

```
メンテナが長期離脱した場合の連絡先と手順を
リポジトリ直下の MAINTAINERS.md に記載する（`.github/` 配下ではない）：

緊急連絡先: [プライベートな連絡先 - GitHub Discussionsで公開]

メンテナが6ヶ月以上応答しない場合の移管手順：
1. コアコントリビューターがIssueで公開議論を開始
2. 30日間のコミュニティ合意形成
3. GitHubサポートへのリポジトリ移管申請

このプロトコルの存在が、プロジェクトをソロメンテナへの
単一障害点から解放する。
```

---

## 実装優先順位マトリックス

以下の順序で即座に実装する。
すべてを同時に始めると何も完成しない。

```
今週（1-2時間で完了）：
□ GitHub Private Vulnerability Reportingの有効化
□ Dependabotの有効化（.github/dependabot.yml）
□ mainブランチのブランチ保護ルール設定
□ CODEOWNERSファイル作成

今月（5-10時間で完了）：
□ goreleaser の設定とリリースワークフロー
□ cosign によるバイナリ署名
□ DCO ワークフローの設定
□ SECURITY.md の完成（Private Reporting のリンク付き）
□ GitHub Discussions の有効化とカテゴリ設定
□ Lightning tipjarアドレスをREADMEに追加

フェーズ2（v3.0.0-alpha.1リリース後）：
□ GitHub Sponsors の設定
□ Renovatebot の設定
□ Issue自動トリアージワークフロー
□ OpenSSF Scorecard の設定
□ 週次セキュリティスキャンワークフロー
□ CONTRIBUTORS.md自動更新
```

---

## 付録：Otedama固有のリスクと対策

### リスク1：Lightning Networkのゼロデイ

LDKに重大な脆弱性が発見された場合、
ユーザーの資金が危険にさらされる。

前提の訂正（session 266）：**Otedama は LDK に依存していない。** ウォレットは BIP-39 シード生成と
AES-256-GCM + scrypt による保管のみで、Lightning ノードは実装されていない（§6）。
したがって本項のリスクは現時点では発生しない。**受取専用ウォレットを超えて Lightning ノードを
組み込む判断をした時点で**、以下が必要になる。

対策（ノード導入時）：
- `govulncheck` を週次で自動実行する（**現在どのワークフローでも実行されていない** — §21）
- 採用したライブラリのセキュリティアドバイザリを GitHub Watch 経由で監視
- ユーザーへの緊急通知は GitHub Discussions + README のバナー

### リスク2：Stratum V2プールの誤動作

ユーザーが接続するプールが不正なWork Templateを送信した場合、
ユーザーのハッシュレートが無効なブロック生成に使われる可能性がある。

対策（現状と、その先）：
- **TLS スキームでの証明書検証は実装済み**（`stratum+v2tls://` と `stratum+tls://`。検証を無効化する
  経路は存在しない）。ただし**既定というものは無い**：かつての既定 `stratum+v2://…` は平文で、
  しかもホストが解決しなかったため session 266 に撤廃した（§20）。プール未設定なら `run` は
  起動を拒否する。「stratum+v2tls:// のみデフォルト」と書いていたのは誤りで、同セッションに訂正した
- Job Declaration/Negotiation（ユーザー自身が template を構築）は**未実装**。ADR-009 の Track D、
  ROADMAP の v3.6 スコープ（§14）
- 推奨プール一覧は**持たない**。以前ここには「CDN 経由で更新可能にする」と書いてあったが、
  それは Otedama が運用する中央集権コンポーネントであり、CLAUDE.md 禁止事項第四に抵触する。
  プールはユーザーが選び、設定に書く。組み込みの既定も推奨リストも存在しない

### リスク3：供給チェーン攻撃

前述のtj-actions事件のように、使用するGitHub Actionsへの攻撃。

対策：
- 全 Action を SHA ピン留め — **未実施**。`.github/workflows/` の `uses:` は現在すべてタグまたは
  ブランチ参照であり、本節が挙げた tj-actions 型の攻撃に対して無防備である（§21）。
  以前ここには「ci.yml で実施済み」と書いてあったが、そのファイルを読めば1行目から反証される
- `Dependabot for Actions` を有効化して自動更新 — **実施済み**（`.github/dependabot.yml`）
- SBOM を全リリースに同梱 — 未実施

### リスク4：規制変更

日本の CARF 対応（2026年1月）や将来の暗号資産規制強化。

対策：
- Otedama は暗号資産交換業者（CAESP: Crypto Asset Exchange Service Provider）ではないことを
  README、CLAUDE.md、法務メモに明記
- 規制変更のモニタリング（FSAのメールマガジン登録）
- 重大な規制変更があった場合は即座にリリースノートで案内

---

本書は生きたドキュメントである。
実際の運用経験から学んだ改善点を四半期ごとに反映する。
Otedamaが「また消えたOSSプロジェクト」にならないための
唯一の保険は、この文書を読んで実行することである。
```
