# Skill: Quality-Pass Continuation — Opus用指示書

本書は、Otedamaの「市販レベル品質パス」（2026年、250+セッション）を、過去の
チャット履歴を持たない新しい**Claude Opus**セッションが継続するための指示書です。
Opusには、資金クリティカル領域の監査・並行性/暗号/プロトコルの正しさ検証・
アーキテクチャ判断といった、深い推論を要する作業を優先的に割り当てます。
記載事実は全てコードとテストを直接検証した上で記録されたものです。
（Sonnet向けの並行タスクは `skills/quality-pass-sonnet.md` を参照。）

## 0. 読む順序

1. `CLAUDE.md` — 製品定義・禁止事項・アーキテクチャマップ（絶対規範）
2. `docs/KNOWN_LIMITATIONS.md` — ユーザー向けの正直な現状開示
3. `docs/CATEGORY_AUDIT.md` — セッション別監査ログ（excess/deficiencyトリアージ表）
4. `docs/SPECIFICATION.md` ギャップ表（G1–G19）
5. `ROADMAP.md` — 確定/**削除済み**マイルストーン（削除済み＝再導入禁止）
6. 本書

## 1. 現状サマリー（検証済みの事実）

**長所**: 全24パッケージ build/vet/test green。カバレッジ全域90%超（最低
internal/lightning 91.2%）。以下はコード直読で clean 確認済み — arbitration
（純関数・境界テスト完備）、rates（median・single-flight）、miner（SHA-256dは
genesisベクタ検証、nonce完全分割、target比較正確、SetWork同期安全）、stratum
wire（境界安全・round-trip一致）、btccrypto（BIP-173/350準拠）、
lightning/wallet.go（atomic write）。成果はPR #4（→master、209コミット）で公開済み。
docsが実装を超える主張をしない「誠実な自己開示」状態が最大の資産であり、
**これを劣化させないことがOpusの第一の責務**。

**短所（ブロック要因つき）**:

| 短所 | ブロック要因 |
|---|---|
| CI全Goジョブ赤: workflowはGo 1.23.x/1.21ピン、go.modの`tlsmlkem`はGo 1.24 knob → parse即失敗。コードは1.24.7でgreen | `.github/workflows/`へのpush権限なし（GitHub App、複数回検証済み） |
| Noise NX未配線（既定`stratum+v2://`は平文） | CODEOWNERS + 監査済みellswift Go実装が世に存在しない（ADR-011 Erratum） |
| secp256k1がスタブ（decred v4はBIP-340でもellswiftでもない — EC-Schnorr-DCRv0） | 依存追加が環境制約で不可 + v3.1.0スコープ |
| 依存陳腐化: yaml.v3アーカイブ済（後継go.yaml.in）、x/crypto 31版遅れ（CVEはssh/openpgp配下で到達不能）、toolchain 1.24（containermaxprocs未享受） | 実行環境がsum.golang.orgをForbiddenで拒否 |
| Akash統合はシミュレーション。実APIは廃止akash-apiでなく`chain-sdk`、入札はon-chain Bidengine | v3.1.0・設計判断（ADR-010 A4再フレーム済み） |
| ~~skills/code-review.md・security-audit.mdの存在しないパス記述~~ ✅ session 254で是正済み | — |
| `wallet`サブコマンドがなく、書き取ったリカバリフレーズを検証できない／実装済みの`ChangePassphrase`に本番導線がない | CLIアーキテクチャマップに関わるためメンテナ判断（KNOWN_LIMITATIONS §16） |
| DATUM未実装／ASIC検出なし／TUI 80カラム固定／CIにfuzzなし | KNOWN_LIMITATIONS §14/§8/§15/§13 |

## 2. Opus優先タスクキュー（深い推論を要するもの）

1. **hmacSHA256Pooled の配線判断**: `internal/stratum/noise_pool.go` に実装・
   テスト・ベンチ済みだが `hkdf2`/`hkdf3`（noise.go）から未呼出。noise* は
   CODEOWNERS必須領域 — 配線PRの起案には、割当プロファイル・ハンドシェイク頻度
   の定量根拠と危険性ゼロの論証を添えること。
2. **Noise NX / ellswift 実装計画（v3.1.0の核心）**: 受け入れ基準は
   sv2-spec `04-Protocol-Security.md`（Noise_NX_Secp256k1+EllSwift_ChaChaPoly_SHA256、
   BIP324の64バイトellswift、2-level PKIサーバ認証）。監査済みGo実装が存在しない
   ため手書き移植になる — bitcoin-core `examples/ellswift.c` のベクタで
   クロステスト必須。ADR-011 Erratumに全論点記録済み。工数見積の再提示から着手。
3. **tlsmlkemピンの設計判断の起案**: go.modの`tlsmlkem=1`はGo1.24未満での
   ビルドを不可能にし、GODEBUG_NOTES.mdの「旧toolchainでもビルド可能」意図と
   矛盾（KNOWN_LIMITATIONS §13に記録済み）。維持/緩和の判断材料を整理し
   メンテナに提示するADR/Erratum草案を書く。**独断で変更しない**。
4. **資金クリティカル領域の継続監査**: 未踏の深掘り候補は
   `internal/stratum/noise.go`のハンドシェイク状態機械（mixKey出力破棄・
   responder静的鍵未認証はKNOWN_LIMITATIONS §2に既知として記録済み — 新規発見
   のみ価値がある）、`internal/engine/run.go`のセッション状態機械の異常系。
5. **実Akash統合の設計**（chain-sdkベース、ADR-003の依存方針との整合検討）。

## 3. 作業規律（違反すると過去250セッションの資産を毀損する）

**検証第一**
- 読んでいないコードを変更しない。**docの主張だけを根拠に修正しない**
  （docが誤りでコードが正しい例が多数: NonceStep「0→1」、BIP-39「wordlist
  未同梱」等 — 逆方向の"修正"は実害を生む）。
- リサーチはFETCHED（一次ソース取得済み）/SNIPPET（検索断片のみ）を峻別し、
  SNIPPETを事実としてリポジトリに書かない。URL捏造は絶対禁止（捏造URL
  `otedama.io` を発見・除去した前歴あり）。

**検証ループ（変更のたびに全実行）**
```
gofmt -l . && go build ./... && go vet ./...
go clean -testcache && go test ./...   # 24パッケージ全green必須
```
並行負荷での偶発failは単独再実行（`-run`指定・`-count=5`）で再現確認して
から判断する。

**記録**: CHANGELOG.mdはセッション番号継続（日本語詳細形式）。監査結果は
clean確認も含めCATEGORY_AUDITへ。外部リサーチはRESEARCH_IMPROVEMENTSへ。
ユーザー向けギャップはKNOWN_LIMITATIONSへ（What/Impact/Workaround/Target形式）。
**Accepted ADRの本文は不変 — 是正はErratum追記**（ADR-003/006/011に前例）。

**git**: Conventional Commits。push前に`git fetch origin <branch>`。
`.github/workflows/`はpush不可（workflow修正はブランチ
`workflow-fixes-pending-permission`方式で退避した前例あり）。セキュリティ
ゲートの弱体化はユーザー明示承認なしに行わない（分類器拒否の前例＝正当）。

**禁止**: カバレッジ水増しテスト（現在90%超、不要）。却下済み機能の再導入
（プラグイン・多通貨・独自プール・Marketplace等 — ROADMAP「削除された
マイルストーン」が正）。lightning/noise*のレビューなし挙動変更（docコメント
是正のみ可）。

## 4. 完了の定義

①検証ループ通過（24 green）②記録完了 ③commit→fetch→push、`git status`
clean ④未完了項目は次セッションが再開できる形でブロック要因つき記録
⑤**実証済みの実欠陥が尽きたら、低価値変更を捏造せず正直にそう報告する**
（これも規律の一部）。
