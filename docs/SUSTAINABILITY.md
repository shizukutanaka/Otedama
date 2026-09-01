# Sustainability Strategy: Otedama at Ten Years

このドキュメントは、Otedamaを2026年から2036年まで10年運用するための戦略を、外部研究調査の結論と Otedama 固有の判断を組み合わせて記録します。`ROADMAP.md` の上位に位置する設計指針です。

This document records the 10-year sustainability strategy for Otedama (2026 → 2036), combining external research findings with Otedama-specific design decisions. It is upstream of `ROADMAP.md`.

---

## 結論サマリー / Bottom Line

研究調査の最重要発見は次の3点です:

1. **抽象化を今やる、後ではない。** クリプト・プロトコル抽象化を今組み込むコストは1四半期、5年後にretrofitするコストは1年、10年後の不在のコストはプロジェクト死亡。
2. **最大のリスクは技術ではない、人間である。** Go言語自体・Bitcoin core RPC・Prometheus exposition formatは10年スパンで安定。Stratum V2の不確実性、メンテナのバスファクター、署名鍵の継続性が真の存続リスク。
3. **既に予定された3つの遷移に備える。** 2028年4月のhalving、BIP-360のpost-quantum活性化（2028-2032、±2年）、Stratum V2のproduction maturity。これらに対し、コア書き換えではなく interface swap で対応できる設計を今確立する。

The single highest-leverage observation: **the cost of building these foundations in today is roughly one engineer-quarter; the cost of retrofitting them in 2030 is roughly one engineer-year, and the cost of recovering from their absence after a maintainer crisis is project death.**

---

## 領域別の指針 / Domain-by-domain Guidance

### 1. Go言語のロングテール / Go Language Long Tail

**研究結論:** Go の6ヶ月リリース・Russ Cox/Austin Clements/Cherry Mui の制度的継続性・Go 1互換性保証により、Go 2のhard breakは2036年まで実質ゼロ。GODEBUG knobによる behavior pinning が2021年以降強化された。

**Otedamaの判断:**
- `go 1.22` をベースライン、`toolchain go1.24.0` を最低toolchain pin（FIPS 140-3 + tool directive機能取得）。
- `go.mod` の `godebug` directive で `tlsmlkem=1`, `panicnil=0`, `randautoseed=1` を明示固定
  （`tlsmlkem`はGo 1.24でのX25519Kyber768標準化に伴い、旧`tlskyber`から改名された値）。
- `GOEXPERIMENT` 機能（`greenteagc`, `jsonv2`等）はproductionで使用しない。
- `GODEBUG_NOTES.md` に依存knobの一覧と廃止予定日を記録。

**実装状況:** 完了（`go.mod`、`GODEBUG_NOTES.md`）。

### 2. Stratum V2のエコシステム不確実性 / SV2 Ecosystem Uncertainty

**研究結論:** SV2は2026年Q1時点で~15-20%のhashrateシェア。Braiins/DEMANDがネイティブ対応、OCEAN は SV1-transport の DATUM、Foundry/AntPool（合計~50%）はSV1のまま。SRI（Rust）は alpha-beta 段階、**production-quality な Go 実装は存在しない**。Bitcoin Core 30 (2025/10) で Template Provider IPC が実験的に追加された段階。

**Otedamaの判断:**
- `internal/poolproto/` 抽象化レイヤを今作成（`v3.0.0-alpha.1`で実装済み、v3.2.0でstratum/から完全分離）。
- **デュアルプロトコル戦略**: SV1 first（>99%プールがSV1のまま、ユーザー基盤拡大のため必須）、SV2 をpluggable transportとして並走。
- **JDPは延期**: 3つのメジャープールが対応するまで実装しない（2026/Q2時点でBraiinsとDEMANDのみ）。
- **SRI を cgo/FFI 経由で組み込まない**: pure-Go cross-compilationを失う。Go native実装を3-6エンジニアヶ月で書く。

**実装状況（session 266 で更新）:** 抽象化 `internal/poolproto/poolproto.go` に加え、**SV1
（`internal/poolproto/stratumv1/`）と SV2 dialer（`internal/poolproto/stratumv2/`）は実装済み**。
本行は長らく「v3.2.0 スコープ」と書かれていたが、SV1 のマイニング経路は session 255、SV2 の
ワイヤ形式は session 256 に一次仕様と突き合わせて修正済みで、記述が実装より2世代遅れていた。
未了なのは Noise NX の実接続への配線（§2）と DATUM（§14）。

### 3. Bitcoin エコシステム longevity / Bitcoin Ecosystem Longevity

**研究結論:** Bitcoin Core JSON-RPC は実質的に stable（5+ 年変更なし）、6ヶ月リリースで3メジャー並行サポート。Mining-relevantなRPC (`getblocktemplate`, `submitblock`, `getmininginfo`) は何年もABI互換。**変動領域は mempool policy** (Core 30 の OP_RETURN サイズ制限撤廃でKnots分裂、394→2,909ノード)。**2028 halving**: block 1,050,000 (~2028年3-4月)、subsidy 3.125→1.5625 BTC。Hashprice 2026/Q1 で~$27-29/PH/day (史上最低)、CoinShares予測 $35-50/PH/day レンジ。

**Otedamaの判断:**
- block subsidy は **計算式で導出** (`50e8 >> (height/210000)`)、**ハードコードしない**（既に対応済み）。
- アドレスパーサは witness-version dispatch で**全 prefix 対応**、Bech32m/Bech32 polymod 厳密に区別（混同で資金喪失するため）。
- ハンドメイドの consensus rule を持たない → CTV/CSFS/OP_CAT/BIP-360 をコード変更なしで吸収。
- 自ノードに接続する形態を将来採る場合、coinbase は `getblocktemplate` 出力から構築し、
  `bitcoind` と Knots のどちらでも動くようにする（**将来の判断**）。

**実装状況（session 266 で訂正）:** subsidy の計算式導出は方針として維持。
ただし **Otedama は現在 Bitcoin ノードに接続しない** — Stratum クライアントであり、coinbase の
断片はプールから受け取る。`getblocktemplate` を呼ぶコードは存在せず（`internal/poolproto/poolproto.go`
に将来計画としての言及があるのみ）、以前の「coinbase は常に `getblocktemplate` 出力から構築」は
現在の実装の記述としては誤りだったため、将来形に直した。ノード直結は ADR-009 の Track D スコープ。

### 4. 暗号ライブラリ stability / Crypto Library Stability

**研究結論:** `golang.org/x/crypto` は Go 1.24/1.25/1.26 を通じて **stdlib に段階移行中**。`crypto/sha3`, `crypto/mlkem`, `crypto/hkdf`, `crypto/pbkdf2`, `crypto/ecdh` は既に std。secp256k1 は **stdlib 入り見送り** (Go core team は NIST曲線のみサポート)。Go ecosystem winner: **`github.com/decred/dcrd/dcrec/secp256k1/v4`** (pure Go, constant-time, ISC license, btcd v2/lnd で使用)。**ChaCha20-Poly1305 は post-quantum 安全** (Grover半減でも 128-bit security、2050年まで)。

**Otedamaの判断:**
- `decred/dcrd/dcrec/secp256k1/v4` を `internal/btccrypto/` interface 経由で使用する（**将来の判断**。
  現在 `go.mod` にこの依存は無い）。
- BIP-39 wordlist は埋め込み + `init()` での SHA-256 アサート。drift したら起動拒否。

**実装状況（session 266 で訂正）:** `internal/btccrypto/` は抽象化のみで、実暗号 swap は未着手。
**at-rest 暗号化の現物は AES-256-GCM + scrypt**（`internal/lightning/seedstore.go`、N=1<<17, r=8, p=1）
であり、本節が以前挙げていた XChaCha20-Poly1305 と Argon2id は**採用されていない**。
「新規 password 派生は Argon2id」は判断としても未決であり、実装済みと読める書き方だったため削除した。
`crypto/mldsa` skeleton の記述も削除した — その scaffold は session 264 に削除済みで、かつ
CLAUDE.md は現段階での量子耐性着手を明確に禁止している（v4.0 での検討事項）。
本節の残りは**方針であって実装ではない**。

### 5. サプライチェーン10年 / Supply Chain over 10 Years

**研究結論:** SLSA v1.1 承認 (2025/4)、L3 は GitHub Actions の `slsa-framework/slsa-github-generator` で**無料達成可能**。SBOM: CycloneDX 1.6+ または SPDX 3.0.1+ (EU CRA要件)、両方発行が低コスト。Sigstore: Cosign v3.x、Rekor v2 GA (2025-2026)、v1 と12ヶ月並走。GitHub Actions: 2025/8 から SHA-pinning enforcement がリポレベルポリシー化。**2026/3 の TeamPCP/trivy-action force-push攻撃 (76タグ中75改竄)** で SHA pinning の必須性が再確認。

**Otedamaの判断:**
- SLSA L3 Go builder workflow を v3.5.0 で導入。
- `cyclonedx-gomod` (Go深度) + Syft SPDX (license compliance) 両方発行。
- `cosign sign-blob --bundle --new-bundle-format --use-signed-timestamps` で offline verifyable に。`VERIFY.md` に identity/issuer明記。
- 全 third-party action を 40-char SHA で pin、`sethvargo/ratchet` で `# v1.2.3` trailer 維持。
- StepSecurity Harden-Runner audit mode (OSS無料)、repo-level "require SHA pinning" 有効化。
- govulncheck + osv-scanner + Dependency Review を全 PR で実行。
- OSS-Fuzz 統合申請（無料、Google運用）。
- **action 更新は 7-day cooldown** で day-zero compromised tag 回避。

**実装状況（session 266 で訂正）:** **実装済みは Dependabot のみ**（`.github/dependabot.yml`、
gomod/actions/docker の週次）。**SHA pinning は1件も無く**（`.github/workflows/` の `uses:` は全て
タグまたはブランチ — `actions/checkout@v4`、`securego/gosec@master` 等）、**cosign 署名も存在しない**
（`cosign` の文字列がリポジトリ内に1件も無い）。すなわちリリース成果物は未署名である。
本行は「実装済み」と書いていたが、上の「判断」欄が SHA pinning 必須の根拠として挙げている
tj-actions 事件そのものに対して無防備なままだった。詳細と手当てのブロッカーは
`docs/KNOWN_LIMITATIONS.md` §21。SLSA L3 と SBOM dual-format は依然 v3.5.0 スコープ。

### 6. Solo Maintainer の現実 / Solo Maintainer Reality

**研究結論:** Tidelift 2024レポート: OSS maintainer の60%が無償、60%が辞職検討、44%がburnout報告。**企業支援プロジェクトすら2025-2026で崩壊** (Kubernetes Ingress NGINX EOL 2026/3、External Secrets Operator が4/5 maintainerでburnout化)。10時間/週生存例: fzf (junegunn, 13年), GoReleaser (caarlos0, 10年), vim-plug。共通パターン: **single binary、依存近ゼロ、conventional commits + tag-driven release、機能の "done" 宣言と reasonable but out-of-scope な依頼の拒絶**。Renovate > Dependabot (grouping で review負担80%減、依存ダッシュボード)。Funding 期待値: niche tooling は数年 $0-500/月。

**Otedamaの判断:**
- **`MAINTAINERS.md` と `GOVERNANCE.md` を Day 1 で書く** (1名でも triager → committer → co-maintainer の昇格パスを定義)。
- 署名鍵を 1Password/Vault 共有 + 信頼できる backup person 1名 + 封印した紙backup。
- Renovate を採用 (grouping for `go.opentelemetry.io/*`, `github.com/prometheus/*`, GHA `pinDigests: true`、patch auto-merge)。Dependabot security alerts は CVE pipeline として並行運用。security PR は never auto-merge。
- GoReleaser v2 + tag-driven Actions release。release-please は overkill で不採用。
- `actions/stale@v9` (issue 90/30、PR 60/21、`pinned`/`security`/`good-first-issue` 例外)。
- 週時間予算: 3h reviews + 3h features + 1h triage + 1h release + 1h docs + 1h community。

**実装状況:** `MAINTAINERS.md`, `GOVERNANCE.md` 作成済み。Dependabot 配置済み (Renovate へのswapはv3.3.0)。

### 7. Observability の安定モデル / Observability Stability Model

**研究結論:** OpenTelemetry Go SDK は Traces/Metrics 安定 (v1.x)、Logs SDK は 2026/Q1 でv1到達も実装は "subject to change"。**single-process CLI なら**: stdlib `log/slog` + `prometheus/client_golang` + OTLP/HTTP は build tag opt-in がベスト。Prometheus exposition format は2036年まで生存可能性最高 (全TSDB対応、wire protocol が「GET /metrics → text」と単純)。Prometheus 3.x が OTLP push をネイティブ受信 (`--web.enable-otlp-receiver`)。OTLP/gRPC でなく **OTLP/HTTP 推奨** (binary 5MB節約、proxy透過、grpc-go の patch CVE 流をスキップ)。

**Otedamaの判断:**
- 2 build artifacts: `otedama` (default、Prometheus single、<15MB、<40 deps) と `otedama-full` (OTel via `-tags otel`、<30MB、<80 deps)。
- 機密 type に `LogValuer` 実装 (private key、address、credentials を source で redact)。
- 全 metric `otedama_*` prefix、minor release 間で名前/label set を維持、削除は6ヶ月 deprecation。
- label cardinality を `WithCardinalityLimit(2000)` で明示cap。
- `--metrics-addr`, `--otlp-endpoint`, `--pprof-addr` は全て opt-in、デフォルト無効。
- **絶対に phone home しない**。

**実装状況:** Prometheus `internal/metrics` + httpserver `--http-addr` は実装済み。OTel build tag は v3.3.0 スコープ。

### 8. プラットフォーム matrix の現実 / Platform Matrix Reality

**研究結論:** Pure-Go (`CGO_ENABLED=0`) static binary が10年最強。Apple Silicon/Linux ARM64/Windows ARM64 はGo tier-1。RISC-V (`linux/riscv64`) はGo 1.21+ 公式対応だが2025年hardware が現代AppleやAMDの**20-50倍遅い** (mining不可、monitoring用途のみ)。Linux LTS: Greg KH が 6.6/6.12/6.18 を3-4年延長。Linux 6.1 が現実的minimum (RHEL 9, Debian 12, Ubuntu 22.04 HWE+ 全てカバー)。Apple notarization: 単独 binary ではなく DMG/PKG/app-bundle が必要 (Gatekeeper 要件)。Windows: SmartScreen reputation は時間で蓄積、cert overlap 90+ days at expiry。

**Otedamaの判断:**
- **Tier-1 (full CI、blocking):** linux/amd64 (glibc + musl), linux/arm64, darwin/arm64, darwin/amd64 (2028年でdrop), windows/amd64。
- **Tier-2 (built and signed、軽テスト):** windows/arm64, freebsd/amd64, linux/amd64 GOAMD64=v3 (AVX2)。
- **Tier-3 (best-effort):** linux/riscv64 (RV64GC); 2028 RVA23 hardware で Tier-2 昇格検討。
- **Drop:** linux/386, windows/386, windows/arm (32-bit、Go 1.24で broken), kernel < 6.1。
- 署名予算 ~$300-900/年 = Apple Developer ($99) + Windows OV/EV cert with cloud HSM ($200-800)。
- macOS notarize は signed CLI を含む DMG で行う。
- Windows は SmartScreen reputation を 90+ days overlap で維持。

**実装状況:** v3.0.0-alpha は linux/amd64 + linux/arm64 + darwin/* + windows/amd64 サポート。RISC-V と musl Tier-1 化は v3.3.0 以降。

### 9. テスト infrastructure の10年 / Testing Infrastructure over 10 Years

**研究結論:** Go native fuzzing (`testing.F`、1.18+) は安定、OSS-Fuzz統合無料。Property-based testing winner: **`pgregory.net/rapid`** (gopter優位、自動shrinking、generics、`testing.F`連携)。Mutation testing: **`github.com/go-gremlins/gremlins`** v0.6 (2025/12)、pre-1.0でCI pin必須、security-critical packageに範囲限定。`testcontainers-go` 0.x stable production、minor pin、`//go:build integration` tag。

**Otedamaの判断:**
- 全 parser に `Fuzz*` test (Stratum messages, share-submission JSON, BIP-39 phrase, Bech32/Bech32m, transaction serialization)。
- CI で 60秒 fuzz on PR、nightly で multi-hour。
- `pgregory.net/rapid` で round-trip property test (mnemonic→seed→derivation→re-encode equality, serialize-and-reparse Stratum frames, share difficulty monotonicity)。
- Gremlins を informational quality gate (target ≥75% mutation kill rate) on `internal/btccrypto`, `internal/stratum`, `internal/lightning`。
- **`internal/btccrypto/` と依存を vendor する** (`go mod vendor`) — 2032年に module proxy outage で2026 build が再現できなくなる事態を防止。
- **annual "rebuild from cold" 演習**: 全 released tag を fresh VM (caches なし) で再ビルドし checksum 一致を年1回検証。
- Docker images は digest pin、tag pin しない。

**実装状況:** Fuzz test は v3.0.0-alpha で `internal/stratum/` に2つ実装済み。`pgregory.net/rapid` 採用と Gremlins 導入は v3.3.0 スコープ。Vendoring と annual rebuild 演習は今すぐ採用可能。

### 10. ライセンスと法的安定性 / Licensing and Legal Sustainability

**研究結論:** 2025-2026で法的状況明確化。Thaler v. Perlmutter — SCOTUSが2026/3/2に cert 却下、純粋AI生成物は人間作者性必要で確定。Doe v. GitHub Copilot 訴訟: 2025/11 和解、GitHub は training-data-match filter 提供義務、ユーザー output owner ship なし、breach-of-contract 2件は係属。EU AI Act GPAI 義務 2025/8/2 適用、**Otedamaは下流ユーザーで Article 53 該当しない**。OFAC は 2025/3/21 に Tornado Cash delist、Van Loon v. Treasury 後で **GitHub に CLI 公開は OFAC 懸念から遠い**。Apache 2.0 > MIT for Bitcoin tooling: explicit patent grant (§3) と patent retaliation でASICBoost等の active patent 領域での defense-in-depth。DCO > CLA for solo maintainer。

**Otedamaの判断:**
- Apache 2.0 (LICENSE), NOTICE で copyright attribution, 全 .go ファイルに SPDX header (`// SPDX-License-Identifier: Apache-2.0`)。
- DCO ( `git commit -s` ) を CONTRIBUTING.md で要求、CLA は採用しない。
- **AI-assisted code clause (CONTRIBUTING.md):** 貢献者がAI出力に責任、meaningful review必須、10行超のverbatim AI output禁止、Copilot duplication-filter strict mode + GPL/AGPL/LGPL blocklist 必須、AI支援コミットは `Co-authored-by:` tag。
- SECURITY.md: **Project Zero 90+30 model** (90日default + 30日grace + active exploitationで7日)、GitHub Private Vulnerability Reporting で受付。
- LEGAL.md: OFAC/EAR 自己compliance期待を文書化。
- 商標 free search と ドメイン確保。USPTO Class 9 + 42 file は material adoption後 (~$700)。
  （以前は `otedama.org`/`otedama.dev` を「確保」と書いていた。session 266 に DNS を引くと
  **`otedama.dev` は解決せず**、`otedama.org` は解決するが**それが本プロジェクトのものかは
  リポジトリからは確認できない**。また `install.sh` の使用例が指していた `otedama.io` も
  解決しなかったため、GitHub の raw URL に差し替えた。ドメイン保有はリポジトリ内の成果物では
  裏づけられない種類の主張なので、以後ここでは実施済みと書かない。）

**実装状況（session 266 で訂正）:** Apache 2.0 + DCO は採用済み。AI-assisted code clause は
CONTRIBUTING.md にあり。**SECURITY.md は既に存在する**（v3.1.0 スコープと書いていたのは誤り）。
LEGAL.md は未作成で v3.1.0 スコープのまま。

---

## 10年スパンの最大単一リスクと対応 / Single Biggest 10-Year Risk

研究レポートの結論をそのまま記載:

> "**The riskiest single decision Otedama can make today is the one most projects make by default: treating bus-factor and signing-key continuity as future problems.** The author of fzf is one person, thirteen years in, because he wrote the boring documents and refused the interesting features. That is the model."

直訳: 「Otedamaが今日下せる最大のリスク決定は、ほとんどのプロジェクトがデフォルトで下しているもの — bus-factorと署名鍵継続性を未来の問題として扱うこと。fzfの著者は1人で13年続けている。退屈な文書を書き、面白い機能を拒否したから。それがモデルである。」

Otedamaが採用する戦略:
1. 退屈な文書（MAINTAINERS、GOVERNANCE、AUDIT_CHECKLIST、THREAT_MODEL、SUSTAINABILITY、ROADMAP）を書く。
2. 面白いがスコープ外の機能（Foundation、Cloud、Marketplace、Academy、ZKP-KYC、multi-currency）を拒否する。
3. 抽象化（btccrypto, poolproto）を retrofit ではなく day-1 で導入する。
4. 署名鍵を bus-factor 1 から 2 に上げる（信頼できる backup person を確保）。
5. 自動化を最大化（Renovate grouping、tag-driven release、SBOM自動生成、Sigstore keyless）。

---

## 改訂と参照 / Revisions and References

**初版:** 2026年4月下旬。外部研究レポートの結論を Otedama-specific 判断と統合したもの。
そのレポート本体は本リポジトリにコミットされていない（以前ここは
`SUSTAINABILITY_RESEARCH_2026Q1.md` を参照していたが、**その file は存在しない**）。
したがって本書の「研究結論」欄は**本リポジトリ内では検証できない**。検証できるのは
「Otedamaの判断」と「実装状況」の各欄であり、session 266 はそこだけを実装と突き合わせた。

**参照ドキュメント:**
- `ROADMAP.md` — 本書の判断を時系列マイルストーンに具体化
- `MAINTAINERS.md` — bus-factor 改善の現状
- `GOVERNANCE.md` — 昇格パスとgreater stake holder 管理
- `docs/THREAT_MODEL.md` — STRIDE 脅威モデル
- `docs/AUDIT_CHECKLIST.md` — 監査チェックリスト（32行。session 266 から各行が
  PASS/FAIL の実測状態を持つ）
- `docs/KNOWN_LIMITATIONS.md` — 製品がしないことの一覧（各項目に原因・影響・回避策・ブロッカー）
- `GODEBUG_NOTES.md` — Go behavior pinning
- `docs/adr/ADR-001` 〜 `ADR-005` — 主要設計判断

本書は **6ヶ月毎に再評価** します。研究結論や Otedama の状況に変化があれば、対応する判断と実装状況を改訂します。
