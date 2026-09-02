# Otedama Architecture

本書は、Otedama v3.0の技術アーキテクチャを詳細に記述するものです。設計判断の背景、コンポーネント間の責務分担、主要なデータフロー、技術選択の根拠を明らかにし、コントリビューターがシステム全体を理解できる状態を目指します。

This document provides a detailed technical architecture of Otedama v3.0, explaining the rationale behind design decisions, the division of responsibilities among components, primary data flows, and justifications for technology choices.

> **本書の位置づけについて（session 243で追記）**
>
> 以下の記述は目標アーキテクチャであり、v3.0.0-alpha.1の実装状況を大きく上回っています。現時点の正確な実装範囲は `CLAUDE.md` のアーキテクチャマップと `docs/KNOWN_LIMITATIONS.md` を正とします。主な乖離点は次のとおりです。
>
> - パッケージ名は `internal/providers/`（複数形）ではなく `internal/provider/`（単数形）。`providers/mining/`・`providers/ai/`・`providers/render/`・`providers/scientific/` という個別サブパッケージは存在しない。
> - 収益源は実装済み1系統のみ：Stratum V2/V1経由の実ビットコイン採掘。Akashを模したシミュレーション価格のAI推論見積もりはsession 264で削除済み（実収入に変換する経路が存在せず、TUIの収益表示を汚染していたため — `docs/KNOWN_LIMITATIONS.md` §1）。分散レンダリング（Render Network）と科学計算（BOINC互換）は`CLAUDE.md`が明示するv4.0スコープで、コードは一切存在しない。
> - HALには`asic.Driver`・`cuda.Driver`・`rocm.Driver`・`cpu.Driver`という個別ドライバは存在しない。実際は`GPULinuxDriver`（Linux sysfs DRM検出のみ、コンピュートディスパッチなし）と`internal/engine`内の`cpuDriver`のみ。ASICドライバは存在しない。
> - `internal/lightning/`はBIP-39シードの生成・暗号化保管のみを提供する。LDK統合、チャネル管理、自動決済、LSP連携は実装されていない。
> - `internal/observability/`というパッケージは存在しない。メトリクス・ログはそれぞれ`internal/metrics/`・`internal/logger/`・`internal/httpserver/`に分散しており、分散トレーシング（OpenTelemetry）は実装されていない。
> - gRPC/RESTの「API層」は存在しない。外部からの制御は`internal/httpserver/`が提供する`/healthz`・`/readyz`・`/metrics`のみ。`internal/api/`・`internal/auth/`・`pkg/api/`・`pkg/plugin/`はいずれも存在せず、`pkg/`は`CLAUDE.md`が作成を禁じている。
> - **Stratumは自前実装である（session 266 で追記）。** 本書の「収益源コネクタ層」と「技術選択の根拠」は、Stratum Reference Implementation（SRI）のGoバインディングを統合利用し自前実装を避ける、と繰り返し述べていた。**実際には逆の判断が採られている**：`internal/stratum/`（フレーム・メッセージ・Noise）と`internal/poolproto/stratumv1|stratumv2/`はすべて自前のGo実装で、外部Stratumライブラリへの依存は`go.mod`に無い。`docs/SUSTAINABILITY.md` §2がその根拠を記録している——production品質のGo実装は存在せず、SRI（Rust）をcgo/FFIで抱えるとpure-Goクロスコンパイルを失うため、Go nativeで書く、という判断。監査上これは重要な差分である：Stratumのパース経路は**このリポジトリの監査対象**であって、上流ライブラリの信頼で済ませられる領域ではない。
> - プラグインフレームワーク（`internal/plugin/`）は存在しない。共有ライブラリの動的ロードもWASMも実装されておらず、`README.md`もプラグインアーキテクチャを未実装として挙げている。
> - LDKは統合されていない（`go.mod`にも無い）。「技術選択の根拠」がLDK採用の理由を述べているのは目標であって現状ではない。
>
> **On this document's status (added session 243):** the description below is a target architecture that substantially exceeds what v3.0.0-alpha.1 actually implements. `CLAUDE.md`'s architecture map and `docs/KNOWN_LIMITATIONS.md` are authoritative for current-state scope. Key divergences: the package is `internal/provider/` (singular), not `internal/providers/`, with no `mining/`/`ai/`/`render/`/`scientific/` subpackages; only one revenue stream is implemented (real Stratum V2/V1 Bitcoin mining; the simulated-price AI-inference quote was deleted in session 264), while distributed rendering and BOINC-style scientific computing are explicitly v4.0-scoped in `CLAUDE.md` and have zero code; HAL has no `asic.Driver`/`cuda.Driver`/`rocm.Driver`/`cpu.Driver` — only `GPULinuxDriver` (Linux sysfs GPU detection, no compute dispatch) and an internal `cpuDriver`, with no ASIC driver at all; `internal/lightning/` only generates and stores an encrypted BIP-39 seed (no LDK, no channels, no automated payments); there is no `internal/observability/` package (metrics/logging live in `internal/metrics/`, `internal/logger/`, `internal/httpserver/`, and there is no distributed tracing); and there is no gRPC/REST API layer — external control is limited to `internal/httpserver/`'s `/healthz`, `/readyz`, and `/metrics`.

## アーキテクチャ原則 / Architectural Principles

Otedamaのアーキテクチャは、本プロジェクトの三つの設計原則に基づいています。John Carmackの「測定可能なパフォーマンスを設計時点から組み込む」原則、Robert C. Martinの「境界と依存方向を明示する」クリーンアーキテクチャ、Rob Pikeの「少数の直交する抽象で全体を構成する」簡潔性です。これらの原則は標語ではなく、以降の全ての構成要素に具体的に反映されています。

アーキテクチャ上の最も重要な不変条件は、ハードウェア層、収益源層、裁定層、決済層の四つの独立した層が明確に分離されていることです。どの層も他の層の内部実装に依存せず、公開インターフェースのみを通じて通信します。この分離により、単一の収益源の変更が他の層に波及せず、将来的なv4.0での大規模変更（zkSNARK導入、量子耐性暗号移行）もコア本体の破壊的変更を最小化できます。

## 高レベル構成 / High-Level Structure

Otedamaは六つの主要レイヤーで構成されます。最下層は**ハードウェア抽象化層**で、物理デバイス（ASIC、NVIDIA GPU、AMD GPU、x86_64 CPU、ARM64 CPU）の統一インターフェースを提供します。その上に**収益源コネクタ層**が存在し、ビットコイン採掘、AI推論提供、分散レンダリング、科学計算委託の四系統のプロバイダアダプタが並列に存在します。**裁定エンジン層**は各収益源の期待収益を継続的に評価し、ハードウェアへの配分決定を下します。**決済層**はLightning Networkを介した非カストディ決済を処理します。**観測性層**（メトリクス、トレース、ログ）とプラグインフレームワークが全体を支え、**API層**（gRPCとREST）が外部からの制御を受け付けます。

この六層構成の重要な特徴は、上位層から下位層への依存のみが許可され、逆方向の依存は禁止されていることです。裁定エンジンはハードウェア抽象化層を知っていますが、ハードウェア抽象化層は裁定エンジンを知りません。この依存方向の規律が、各層の独立テスト可能性と将来の拡張性を担保します。

## ハードウェア抽象化層 / Hardware Abstraction Layer

ハードウェア抽象化層（HAL）は、Otedamaが対応する全ての物理デバイスを統一インターフェースで表現します。`internal/hal/`配下に配置され、主要な型は`Device`インターフェースです。`Device`は`Identify()`、`Capabilities()`、`SubmitWork(context.Context, Work) (Result, error)`、`Metrics() DeviceMetrics`、`Shutdown() error`の五つのメソッドを持ちます。

ASICデバイスは`asic.Driver`として実装され、Antminer、Whatsminer、Avalonの各シリーズに対応します。通信はStratum V2経由（または下位互換のStratum V1）で行われ、デバイス固有のプロプライエタリAPIは抽象化されます。GPUデバイスはNVIDIA向けの`cuda.Driver`とAMD向けの`rocm.Driver`として実装され、マイニング用途（hashcat、ccminer互換）とAI推論用途（CUDA/ROCm runtime経由）の両方に対応します。CPUデバイスは`cpu.Driver`として実装され、AVX2、AVX-512、ARM NEONの各拡張命令セットを検出して最適実装を選択します。

HALの設計で特に注意を要するのは、同一物理デバイスの複数用途への動的切替です。例えば、あるGPUがマイニングから AI推論に切り替わる際、CUDA contextの破棄と再初期化のオーバーヘッドが発生します。HAL層はこのオーバーヘッド（典型的に数百ミリ秒から数秒）を測定可能なメトリクスとして露出し、裁定エンジンが切替判断に組み込めるようにします。頻繁な切替が経済的に損失となる状況では、裁定エンジンは切替を抑制する決定を下します。

## 収益源コネクタ層 / Revenue Stream Connector Layer

収益源コネクタ層は、外部サービスとの通信を担う四系統のアダプタで構成されます。各アダプタは`internal/providers/`配下の独立したパッケージとして実装され、共通の`Provider`インターフェースに準拠します。`Provider`インターフェースは`Connect(context.Context) error`、`ExpectedYield(HardwareProfile) (YieldEstimate, error)`、`Submit(Work, Result) (Receipt, error)`、`Disconnect() error`のメソッドを持ちます。

ビットコイン採掘プロバイダはStratum V2プロトコルを主軸に実装されます。**プロトコル実装は自前のGo実装です**（session 266 で訂正。以前ここには「SRIのGoバインディングを統合利用し、自前実装を避ける」と書かれていましたが、採られた判断は逆で、`internal/stratum/` と `internal/poolproto/stratumv1|stratumv2/` がすべて自前実装です。理由は `docs/SUSTAINABILITY.md` §2 と ADR-003 を参照）。Job Negotiation と Template Negotiation は未実装で v3.6 スコープ（§14）、Encrypted Stratum（Noise NX）は実装済みだがどの実接続にも配線されていません（§2）。接続先はユーザーが設定します——特定プールへの「初期サポート」という概念はなく、組み込みの既定値もありません（未設定なら `run` は起動を拒否。§20）。

AI推論プロバイダは未実装です（本節は設計意図の記述であり、現状の記述ではありません）。統合先の候補は`internal/provider`のパッケージdocに記録した基準——ユーザーがプロバイダ側であり、支払いが非カストディで、価格が注文ごとに発見される市場——で選定します。この基準によりRender Network（RNDRトークンによる中央仲介）とio.net（中央価格決定）は対象外です。以前ここには「Strawberry API（並行開発中のプロジェクト）を主軸として統合」と書かれていましたが、そのようなAPIは実在せず、`CLAUDE.md`が禁じる「存在しないAPIの記載」に該当したため削除しました（session 264）。

分散レンダリングプロバイダ（`providers/render/`）は、Render Networkへの接続を実装します。3DCGレンダリング（Blender Cycles互換）、動画エンコーディング、物理シミュレーション等のワークロードを受け付けます。科学計算プロバイダ（`providers/scientific/`）は、BOINC互換クライアントとして動作し、Folding@Home、World Community Grid、SETI@home等の科学プロジェクトへの貢献と、それに対する報酬（プロジェクトによっては仮想通貨またはポイント）の受取を自動化します。

## 裁定エンジン層 / Arbitration Engine Layer

裁定エンジン（`internal/arbitration/`）は、Otedamaの差別化中核です。四系統のプロバイダから期待収益を継続的に受け取り、ユーザーのハードウェア構成とポリシー設定に基づいて最適配分を決定します。この決定は毎秒実行され、短期的な価格変動と切替オーバーヘッドの両方を考慮した予測制御として設計されています。

裁定エンジンの中核アルゴリズムは以下のように動作します。第一に、各プロバイダから直近の期待時給収益（円またはUSD換算）を取得します。第二に、各ハードウェアデバイスについて、現在の配分から他の配分への切替コスト（時間、電力、潜在的な機会損失）を算出します。第三に、切替コストを考慮した上で、向こう数分から数時間の予測累積収益が最大となる配分を線形計画法で解きます。第四に、解かれた配分を予測誤差を考慮した安全マージンでフィルタリングし、過度に頻繁な切替を抑制します。第五に、確定した配分をHAL層に指示します。

裁定エンジンはユーザーが選択可能な複数のポリシープリセットを提供します。純収益最大化ポリシーは、単純に期待収益の最大値を追求します。BTC蓄積優先ポリシーは、収益をBTC建てで最大化するため、ビットコイン採掘への配分を優先します。プライバシー最大化ポリシーは、KYC不要な経路のみを選択し、身元識別可能な配分を避けます。環境配慮ポリシーは、科学計算への配分を一定割合で確保し、純粋な収益最大化よりも社会的価値を重視します。

## 決済層 / Payment Layer

決済層（`internal/lightning/`）は、Lightning Network経由の非カストディ決済を処理します。Lightning Development Kit（LDK）を統合利用し、自前のLightningノード実装は行いません。LDKはRust実装ですが、Go向けのFFIバインディングを介して統合されます。

決済層の主要な責務は四つです。第一に、ユーザーのLightningウォレットの自動生成と管理（ただし秘密鍵はユーザーデバイスに保持され、Otedamaサーバーは預からない）。第二に、Lightning Service Provider（LSP）との自動チャネル確立と管理。第三に、各プロバイダからの受取（Incoming Payment）の自動処理。第四に、受取資金のユーザー主ウォレットへの自動転送または蓄積。

非カストディ設計の最重要事項として、Otedamaの実装者（プロジェクトメンテナ）であっても、ユーザーの秘密鍵にアクセスできない構造を保証します。秘密鍵はユーザーデバイス上で暗号化されて保存され、パスフレーズによる復号が必要な形式です。Otedamaがサービスとして提供するのは「ユーザーが自身の秘密鍵で署名するためのインターフェース」であり、「ユーザーに代わって鍵を管理する機能」ではありません。

## 観測性層 / Observability Layer

観測性層（`internal/observability/`）は、Otedamaの運用状態を外部から観測可能にします。Prometheus互換のメトリクスエクスポート、OpenTelemetry互換の分散トレーシング、構造化ログ（JSON形式）の三本柱で構成されます。

メトリクスは以下の粒度で提供されます。ハードウェア層のメトリクス（デバイス稼働状態、ハッシュレート、消費電力、温度）、プロバイダ層のメトリクス（接続状態、レイテンシ、受領されたワーク数、期待収益）、裁定エンジンのメトリクス（配分決定頻度、切替コスト、予測精度）、決済層のメトリクス（チャネル状態、受取総額、手数料）。これらのメトリクスは、ユーザーが自身の運用を監視する基盤となり、また集計によりOtedama全体の健全性指標として公開されます（ユーザー識別可能な情報は除く）。

トレーシングは、裁定決定から実際のワーク送信、結果受領、決済完了までの一連のフローを追跡可能にします。分散システムとしての性格を持つOtedamaにおいて、パフォーマンス問題の根本原因特定にトレーシングは不可欠です。

## プラグインフレームワーク / Plugin Framework

プラグインフレームワーク（`internal/plugin/`）は、コア本体への変更なしに新規収益源やカスタム機能を追加可能にします。プラグインはOtedamaのプロセス内で動作するGoのsharedライブラリ（`.so`、`.dylib`、`.dll`）として実装され、起動時に動的にロードされます。

プラグインAPIは安定性を保証するため、`pkg/plugin/`配下の公開パッケージとして提供されます。プラグインの作者は`pkg/plugin`が定義するインターフェース（`Provider`、`PolicyHook`、`MetricsExporter`等）を実装することで、Otedamaの動作を拡張できます。プラグインはサンドボックス化されており、コア本体の重要な領域（秘密鍵、設定ファイル）へのアクセスは制限されます。

将来的にはWebAssembly（WASM）ベースのプラグインも検討しています。WASMプラグインはクロスプラットフォームで、かつより強固な分離が可能ですが、性能オーバーヘッドとGo埋め込みの成熟度を考慮して、v3.0時点ではネイティブsharedライブラリを採用しています。

## API層 / API Layer

API層（`internal/api/`）は、外部からのOtedama制御インターフェースを提供します。gRPCを主軸とし、REST APIをgRPC-gatewayで自動生成します。OpenAPI 3.1仕様が自動生成され、`pkg/api/openapi.yaml`として公開されます。

認証はZKPベース（`internal/auth/`）で実装されます。ユーザーは初回起動時に秘密鍵を生成し、以降の全てのAPI呼び出しはその秘密鍵による署名で認証されます。KYCや個人情報の提供は一切不要です。APIはローカルホストでの使用を前提としており、デフォルトではUNIX domain socketまたはlocalhost限定のTCPリッスンで動作します。リモートアクセスが必要な場合、ユーザーはmTLSによる相互認証を明示的に設定します。

## データフロー / Data Flows

Otedamaの主要なデータフローは三種類です。第一は**ワーク配分フロー**で、ユーザーのハードウェアが収益源から受け取った計算タスクを実行し、結果を返却する経路です。裁定エンジンが配分を決定し、HALが物理デバイスを制御し、プロバイダが結果を受信者に送信します。第二は**決済受領フロー**で、プロバイダからLightning Network経由で決済を受け取り、ユーザーのウォレットに蓄積する経路です。LDKがチャネル管理を行い、受領イベントが決済層を経由して記録されます。第三は**観測性フロー**で、各層から発生するメトリクス、トレース、ログを集約し、Prometheus、Jaeger、または同等のシステムに送信する経路です。

これら三つのフローは独立して動作し、一つのフローの遅延や障害が他のフローに波及しない設計となっています。例えば、観測性層への送信が遅延しても、ワーク配分フローと決済受領フローは影響を受けません。

## 技術選択の根拠 / Technology Choice Rationale

Goを主要言語として選択した理由は四つです。第一に、並行処理の記述が明示的で、Otedamaのような多数のゴルーチンを扱うシステムに適しています。第二に、クロスプラットフォームの静的バイナリ生成が容易で、ユーザーへの配布が単純化されます。第三に、標準ライブラリと `golang.org/x/crypto` だけで暗号・ネットワーク・並行処理の要件が満たせ、実際にリンクされる外部モジュールは3つに収まっています（session 266 で訂正。以前ここは「SRI・LDK・BOINC等のGoバインディングが入手可能」を理由に挙げていましたが、**その3つはいずれもGoバインディングを使っておらず、`go.mod` にも存在しません**。SRI相当は自前実装、LDKとBOINCは未着手です）。第四に、強い型付けとシンプルな文法により、コミュニティからの貢献の品質が一定以上に保たれやすくなります。

Lightning Development Kit（LDK）をLightning Network実装として選択した理由は、プラガブルなアーキテクチャ、強固なセキュリティ監査履歴、活発なメンテナンス、非カストディ設計との適合性です。代替候補としてLNDやCore Lightningも検討しましたが、Otedamaのユースケース（個人デバイス上での動作、ヘッドレス運用、最小依存）にはLDKが最適と判断しました。

**Stratum V2は自前実装を選択しました**（session 266 で訂正。以前の本段落は逆——SRIを選び自前実装を避けた、と書かれていました）。判断の根拠は `docs/SUSTAINABILITY.md` §2 に記録されています：production品質のGo実装が存在せず、SRI（Rust）をcgo/FFI経由で抱えるとpure-Goのクロスコンパイルという配布上の最大の利点を失うため、Go nativeで書く。代償は明示的に引き受けています——**プロトコルのパースと暗号の正しさはこのプロジェクトの責任**であり、上流に委ねられません。だからこそフレーム解析にはfuzz targetがあり（`internal/stratum/frame_fuzz_test.go`）、ワイヤ形式は仕様書と突き合わせて検証されています（session 256）。この判断を見直すべき条件も明確です：監査済みでpure-GoのStratum V2実装が現れたら、`internal/poolproto` の抽象化はその差し替えのために存在します。

## 将来の進化 / Future Evolution

v3.0で確立されるアーキテクチャは、v4.0以降の進化を前提に設計されています。zkSNARKベースの匿名計算証明の導入は、認証層の拡張として実装可能です。Threshold Signaturesによるマルチパーティ決済は、決済層のLightning以外の決済経路として追加可能です。Braidpoolとの相互運用は、新規プロバイダとして収益源コネクタ層に追加可能です。量子耐性暗号への移行は、認証層と決済層の実装を段階的に更新することで達成可能です。

これらの将来変更が、本書で記述したアーキテクチャの骨格を破壊しないことを、定期的なアーキテクチャレビューで確認します。骨格の変更が必要になった場合、それはv4.0以降の別のメジャーバージョンとして扱われます。

## 関連文書 / Related Documents

本書は`CLAUDE.md`で規定された設計原則と禁止事項に基づいています。ロードマップとの対応は`ROADMAP.md`を参照してください。アーキテクチャ判断の詳細な記録は`docs/adr/`配下のArchitecture Decision Record（ADR）を参照してください。セキュリティ面の詳細は`SECURITY.md`を参照してください。

本書は随時更新されます。重要な変更は`CHANGELOG.md`でも通知されます。
