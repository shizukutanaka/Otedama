# Skill: Quality-Pass Continuation — Sonnet用指示書

本書は、Otedamaの「市販レベル品質パス」（2026年、250+セッション）を、過去の
チャット履歴を持たない新しい**Claude Sonnet**セッションが継続するための指示書です。
Sonnetには、ドキュメント是正・回帰テスト追加・検証ループの反復実行・一次ソース
検証つきリサーチ・記録作成といった、明確な手順で高速に回せる作業を優先的に
割り当てます。記載事実は全てコードとテストを直接検証した上で記録されたものです。
（深い推論・資金クリティカル領域・アーキテクチャ判断は
`skills/quality-pass-opus.md` 側のタスクキューを参照。）

## 0. 読む順序

1. `CLAUDE.md` — 製品定義・禁止事項・アーキテクチャマップ（絶対規範）
2. `docs/KNOWN_LIMITATIONS.md` — ユーザー向けの正直な現状開示
3. `docs/CATEGORY_AUDIT.md` — セッション別監査ログ（excess/deficiencyトリアージ表）
4. `docs/SPECIFICATION.md` ギャップ表（G1–G19）
5. `ROADMAP.md` — 確定/**削除済み**マイルストーン（削除済み＝再導入禁止）
6. 本書

## 1. 現状サマリー（検証済みの事実）

**長所**: 全24パッケージ build/vet/test green。カバレッジ全域90%超（最低
internal/lightning 91.2%）。監査済みclean領域は arbitration / rates / miner /
stratum wire / btccrypto / lightning/wallet.go / cmd/otedama/completion.go。
成果はPR #4（→master、209コミット）で公開済み。docsが実装を超える主張を
しない「誠実な自己開示」状態が最大の資産 — **Sonnetの主戦場はまさにこの
doc-vs-code整合性の維持**である。

**短所（ブロック要因つき）**:

| 短所 | ブロック要因 |
|---|---|
| CI全Goジョブ赤（Go 1.23.x/1.21ピン vs go.modの`go 1.25.0`ディレクティブ、toolchain go1.25.13） | `.github/workflows/`へのpush権限なし — §13 |
| ~~依存陳腐化~~ ✅ session 322/375で解消（go.yaml.in移行・x/crypto v0.54.0・go1.25.13・govulncheck reachable 0件） | — |
| ~~skills/code-review.md・security-audit.mdの存在しないパス記述~~ ✅ session 254で是正済み | — |
| ~~`wallet`サブコマンドなし~~ ✅ session 314/373で解消（§16 RESOLVED） | — |
| Noise NX未配線／secp256k1スタブ／Akashシミュレーション／~~DATUM未実装~~（miner面は§14解消、upstream template はADR-009残） | CODEOWNERS or v3.1.0+/ADRスコープ（Opus側タスク） |
| ~~TUI 80カラム固定~~（§15解消）／~~ASIC検出なし~~（検出+pool-follow解消、dispatchはADR-008残）／CIにfuzzなし（§13） | ADR-008/§13 |

## 2. Sonnet優先タスクキュー（手順が明確なもの）

1. ~~**skills/のstale記述是正**~~ ✅ **session 254で完了。**
   `skills/code-review.md`・`skills/security-audit.md` が挙げていた存在しない
   パス（`internal/security/`・`internal/auth/`）、却下済み`internal/plugin/`、
   未実装LDK決済前提の記述を、実CODEOWNERS対象（`internal/lightning/`と
   `internal/stratum/noise*.go`）と現状の実装範囲へ是正済み。
   **教訓（次セッションへ）**: 同じ「実装を超える主張」クラスは、docsが
   *約束している* 挙動をコードが持たない形でも現れる——session 254 は
   リカバリフレーズ提示がまさにそれだった（docs 4箇所が「表示される」と
   明記、実装は0件）。**docの主張を見つけたら、その挙動を実際に実行する
   本番コード経路をgrepで確認する**こと。
2. ~~**依存3件更新**~~ ✅ **session 322/375で完了。** go.yaml.in/yaml/v3 移行・
   x/crypto v0.54.0・toolchain go1.25.13 pin 全て適用済み（govulncheck reachable 0件）。
3. **doc相互参照の継続検査**: markdownリンク・backtickファイル参照が実在
   ファイルに解決するか、SPECIFICATIONのギャップ表番号・KNOWN_LIMITATIONSの
   §番号の相互参照が一致するか。（session 253時点で全解決済み — 変更後に再検査。）
4. **回帰テスト追加**: 挙動修正には必ず対応する回帰テストを添える。ただし
   カバレッジ水増し（意味のないテスト）は禁止 — 現在全パッケージ90%超なので、
   新規テストは「実バグを固定する」ものに限る。
5. **一次ソース検証つきリサーチ**: 依頼時はWebSearch/WebFetchで、FETCHED
   （ページを実取得）とSNIPPET（検索断片のみ）を峻別。SNIPPETは
   RESEARCH_IMPROVEMENTSに「要検証」ラベルでのみ記録し、リポジトリ本文に事実
   として書かない。

## 3. 作業規律（全モデル共通）

**検証第一**
- 読んでいないコードを変更しない。**docの主張だけを根拠に修正しない**
  （docが誤りでコードが正しい例が多数: NonceStep「0→1」、BIP-39「wordlist
  未同梱」等）。
- URL捏造は絶対禁止（捏造URL`otedama.io`を発見・除去した前歴あり）。

**検証ループ（変更のたびに全実行 — doc変更のみでも実行）**
```
gofmt -l . && go build ./... && go vet ./...
go clean -testcache && go test ./...   # 24パッケージ全green必須
```

**記録**: CHANGELOG.mdはセッション番号継続（日本語詳細形式で「何を・なぜ・
どう検証したか」）。監査結果はCATEGORY_AUDIT（clean確認も記録）。リサーチは
RESEARCH_IMPROVEMENTS。ユーザー向けギャップはKNOWN_LIMITATIONS。
**Accepted ADRは本文不変、是正はErratum追記**（ADR-003/006/011に前例）。

**git**: Conventional Commits。コミット前に`git status`で対象確認、push前に
`git fetch origin <branch>`でリモート未変更を確認。`.github/workflows/`は
push不可（検証済み）。セキュリティゲートの弱体化はユーザー明示承認なしに
行わない。

**禁止**: カバレッジ水増しテスト。却下済み機能の再導入（プラグイン・多通貨・
独自プール・Marketplace等 — ROADMAP「削除されたマイルストーン」が正）。
資金領域（`internal/lightning/`、`internal/stratum/noise*`）のレビューなし
挙動変更（docコメント是正は可）。

## 4. 完了の定義

①検証ループ通過（24 green）②記録完了 ③commit→fetch→push、`git status`
clean ④未完了項目は次セッションが再開できる形でブロック要因つき記録
⑤**実証済みの実欠陥が尽きたら、低価値変更を捏造せず正直にそう報告する**。
