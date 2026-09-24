# Threat Model

This document describes Otedama's threat model using the STRIDE framework
(Spoofing, Tampering, Repudiation, Information disclosure, Denial of
service, Elevation of privilege).

It is intended for security auditors, integrators, and contributors
making changes that touch sensitive code paths (`lightning/`, `stratum/`,
network handling, wallet persistence).

## Scope

### In scope

- The `otedama` binary, its configuration files, its wallet file,
  and its HTTP endpoints.
- Connections to Stratum V2 pools.
- Connections to price feeds (Coinbase, Kraken, CoinGecko).
- Connections to AI inference providers (Akash Network, future).
- Interactions with the operating system (systemd, launchd, filesystem).

### Out of scope

- The Bitcoin protocol itself.
- The security of upstream pool operators.
- The security of the Lightning Network or on-chain payments once funds
  leave the user's wallet.
- Physical attacks on the user's machine (cold boot, evil maid).
- Compromise of the Go toolchain or OS kernel.

## Assets

Ranked by user-visible impact of compromise:

1. **The wallet seed** — 64 bytes of BIP-39 entropy. Loss = loss of
   all mined funds. Theft = unauthorized spending.
2. **Mining hashrate** — computation time directed at a pool. Hijacking
   redirects earnings to an attacker without the user noticing.
3. **Bitcoin address** — the payout destination. Tampering here is a
   silent theft.
4. **Earnings in flight** — unsubmitted shares on the miner or
   unfinalized payout confirmations from the pool.
5. **Operational availability** — uptime of the mining process itself.

## Adversaries

- **Network adversary.** Has passive or active control of network
  between the user and the pool. Classic MITM.
- **Remote attacker.** Has no privileged access but can interact with
  Otedama's HTTP endpoints or deliver malicious Stratum V2 frames.
- **Supply chain adversary.** Compromises a dependency, a release
  artifact, or a developer's commit signing.
- **Malicious pool.** The pool itself is evil (sends crafted jobs,
  withholds shares, manipulates difficulty). Includes *selfish* pools:
  Bahrani & Weinberg, "Undetectable Selfish Mining" (arXiv:2309.06847),
  prove a selfish-mining strategy whose orphan pattern is statistically
  indistinguishable from honest mining and profitable from ~38.2% of
  network hashrate — so a single dominant pool can withhold blocks
  *undetectably*, and the miner's local telemetry cannot reveal it.
  This is why Otedama's multi-pool failover / endpoint-diversity
  defaults are a **security** property, not merely a liveness one:
  diversifying away from any single pool is the only client-side
  defense against an attack the evidence cannot show.
- **Other local user.** A different unprivileged user on the same OS.

We explicitly *exclude* a local attacker with root/administrator
privileges. No user-space software resists that threat.

## STRIDE analysis

### Spoofing (S)

**Threat:** An attacker impersonates the pool to steal shares.

**Mitigation:** Stratum V2 Noise NX handshake authenticates the pool
to the miner via a static public key. `internal/stratum/noise.go`
implements the handshake. Falling back to V1 is not supported, so
downgrade attacks are structurally impossible.

**Residual risk:** In v3.0.0-alpha, the Noise DH uses P-256 instead of
the spec-mandated secp256k1. This does not weaken authentication but
makes the alpha technically non-conforming. Tracked for v3.1.0.

---

**Threat:** An attacker impersonates a price feed to manipulate
arbitration decisions.

**Mitigation:** Three independent price sources (Coinbase, Kraken,
CoinGecko) are queried in parallel and the median is used. An attacker
must compromise at least two sources simultaneously for their value to
influence the outcome.

Transport hardening on these connections: outbound TLS negotiates the
hybrid post-quantum key exchange **X25519MLKEM768** (Go's `tlsmlkem=1`
godebug, pinned in `go.mod`), so recorded price-feed traffic resists
future harvest-now-decrypt-later attacks. Operators in regulated
environments can additionally run with `GODEBUG=fips140=on`, which
routes crypto through Go 1.24's FIPS 140-3-validated module — the
X25519MLKEM768 exchange is part of that validated set. Both knobs are
documented in `GODEBUG_NOTES.md`.

**Residual risk:** If all three sources return nonsense, Otedama falls
back to a hard-coded fallback ($95,000). This is conservative (does not
favor any provider) but stale values may cause suboptimal arbitration.

---

### Tampering (T)

**Threat:** An attacker modifies the wallet file on disk.

**Mitigation:** Wallet file is encrypted with AES-256-GCM
(`internal/lightning/seedstore.go`). Tampering is detected by AEAD
authentication failure at decrypt time.
The file is written atomically (tempfile + rename) so a crash during
write cannot corrupt the existing file.

**Residual risk:** Root can delete the file (no Otedama-side
mitigation). The encryption's key derivation uses scrypt (N=32768);
a determined offline attacker with a modern GPU cluster can brute-force
weak passphrases. Use a strong passphrase; see CONTRIBUTING.md.

---

**Threat:** A malicious pool sends a crafted frame that causes buffer
overflow, panic, or memory exhaustion.

**Mitigation:** `MaxFrameSize` caps any single frame. The fuzz tests
`FuzzDecodeHeader` and `FuzzDecoder_ReadFrame` run nightly with
automatic crasher reporting.

**Residual risk:** Go panic safety provides strong guarantees, but
a panic in the decode path still terminates the miner (DoS, below).

---

**Threat:** Supply chain: a dependency is replaced with a malicious
version.

**Mitigation:** Three direct runtime dependencies, each pinned by exact
version with a recorded rationale in `go.mod` comments and verified by
`go.sum` checksums (Go module proxy + `sum.golang.org` transparency
log; `go mod verify` catches any post-download substitution on a clean
fetch):

- `golang.org/x/crypto v0.54.0` — chacha20poly1305 + scrypt + pbkdf2 for
  the Noise transport and wallet encryption; none exist in stdlib
  through Go 1.26. (Cat 10 item 10's "the one new crypto dep".)
- `go.yaml.in/yaml/v3 v3.0.5` — YAML-org-maintained successor of the
  archived `gopkg.in/yaml.v3` (v3 API-frozen drop-in; ADR-003's
  Erratum). Replaced the archived import path session 322.
- `golang.org/x/sys v0.47.0` — termios/TIOCGWINSZ/console-size detection
  for the wallet subcommands and TUI; promoted from indirect to direct
  session 322.

All GitHub Actions pinned by SHA. Dependabot auto-updates with review.
govulncheck runs in CI. See ADR-003.

Advisory tracking (session 269): CVE-2025-22871 / GO-2025-3563
(`net/http` bare-LF chunk-size request smuggling; fixed in go1.23.8 /
go1.24.2) affects the `/healthz` `/readyz` `/metrics` surface — covered
by the go1.25.7 toolchain pin. Escalating govulncheck to a hard CI gate
is the remaining open step.

**Residual risk:** Compromise of the Go toolchain, the Go proxy, or
one of the three direct dependencies remains possible. We have no
mitigation other than early detection.

---

**Threat:** A malicious pool embeds terminal control bytes in free-text
fields it controls (share-reject reasons, `client.show_message`
notices, JSON error text) — `\u001b`-style JSON escapes decode into
real ESC bytes, injecting ANSI sequences into the operator's terminal
(clear-screen, OSC 8 hyperlinks, OSC 52 clipboard writes) or forging
log lines with embedded newlines.

**Mitigation (session 349):** `traceLog` — the single point every
session log line passes through — sanitises messages via
`sanitizeLogText`, blanking C0 controls, DEL, and the C1 range before
emission. The TUI dashboard displays only numeric stats (no pool
free-text), and metric labels use the fixed `rejectClass` categories.

Session 350 widened the wrap point to `engine.Run`'s outermost logger:
`sessionErr` interpolates pool error strings (authorize rejections,
`OpenMiningChannelError.ReasonCode`) into the reconnect/failover lines
which never pass through `traceLog`, and the fatal path prints the raw
error from `cmdRun` — both now sanitised through the shared
`logger.SanitizeLine` the session path delegates to.

**Residual risk:** Non-session log lines (startup, config errors)
carry no pool-derived strings. Legitimate UTF-8 text passes through
unmodified.

---

### Repudiation (R)

**Threat:** A user claims "Otedama never mined for me" to dispute
operator claims.

**Mitigation:** All share submissions are logged with timestamp, nonce,
and sequence number. Prometheus metrics persist via the scrape target.
Share acknowledgment messages from the pool are logged by
`SubmitSharesSuccess` handlers.

**Residual risk:** The user can still delete logs. This is a feature,
not a bug — Otedama is the user's software, not surveillance.

---

### Information disclosure (I)

**Threat:** Wallet passphrase appears in process lists or environment
dumps.

**Mitigation:** Preferred path is `OTEDAMA_WALLET_PASSPHRASE` env var,
not the `--wallet-passphrase` flag (which shows in `ps aux`). This is
documented in `docs/API.md` and `docs/DEPLOYMENT.md`. The flag exists
for convenience on single-user systems.

**Residual risk:** Env vars are still visible to processes running as
the same user. A proper secrets manager (systemd-creds, macOS Keychain,
HashiCorp Vault) is recommended in production.

---

**Threat:** Metrics endpoint leaks information to an attacker who
reaches it.

**Mitigation:** Default bind is disabled (`--http-addr` is empty by
default). Users who enable it are encouraged to bind to `127.0.0.1`
or a private network. No authentication is provided — deliberately —
because any implementation we shipped would be weaker than delegating
to an ingress (nginx, Caddy).

**Residual risk:** Misconfigured deployments could expose metrics to
the internet. The metrics reveal hashrate, pool URL, wallet
fingerprint (8 hex chars, not the seed), and earnings estimate. None
of these allows fund theft, but they reduce user privacy.

---

**Threat:** Logs contain sensitive values.

**Mitigation:** `otedama doctor` and log outputs use `maskAddress` to
truncate Bitcoin addresses to `bc1qar0···5mdq`. Wallet passphrases are
never logged. Mnemonics are displayed exactly once on first run and
never written to a log file.

**Residual risk:** Users who manually enable `--log-level=debug` may
see more information; the threshold between "useful debug" and "leaks
secrets" is judgment-based.

---

**Threat:** Traffic-analysis side channel on the pool connection. Even
with the Stratum V2 Noise NX channel encrypting payloads, an adversary
positioned on the network path (or an ISP) can infer miner earnings
and activity from packet sizes and timestamps alone. This is not
hypothetical: Recabarren & Carbunar (arXiv:1703.06545, "Hardening
Stratum") demonstrated the StraTap and ISP-Log attacks, showing that
share submissions and their timing leak earnings even when the content
is opaque, and that encryption alone does not close the channel.

**Mitigation:** Otedama's Noise NX encryption (when secp256k1 lands,
see KNOWN_LIMITATIONS §2) protects payload confidentiality and
integrity, which defeats the *content*-reading attacks (BiteCoin-style
share hijacking) from the same paper. The paper's own countermeasure
to the timing channel — the "mining cookie" (a per-miner secret folded
into the puzzle so an observer cannot reconstruct or correlate shares)
— is the right model for a future hardening pass.

**Residual risk:** Otedama does **not** currently pad or rate-shape
Stratum traffic, so the timing/size side channel that infers *earnings*
(not funds) remains open to a network observer. Funds are not at risk
(payouts are non-custodial and on-chain/Lightning), but a determined
on-path adversary can estimate a miner's hashrate and luck. The
Lightning analogue is identical in shape: Rohrer & Tschorsch's
"Counting Down Thunder" (arXiv:2006.12143) shows HTLC-resolution timing
leaks payment endpoints, so any future LN traffic inherits the same
channel. Users who need to defeat this should tunnel the pool
connection over Tor or a VPN (Tor-by-default is planned — ADR-007 B7,
which mitigates *both* timing channels). Adding traffic shaping or a
mining-cookie-style construct is tracked as a future hardening item.

---

### Denial of service (D)

**Threat:** A malicious pool sends oversized frames to exhaust memory.

**Mitigation:** `MaxFrameSize` = 16 MiB (Stratum V2 spec maximum) in
the decoder. Frames larger than this are rejected before allocation.

**Residual risk:** 16 MiB × 1000 misbehaving channels = 16 GiB. Otedama
is a single-pool client, so this scales with concurrent connections
only if a user misconfigures multiple pools, which is bounded by the
configuration.

---

**Threat:** A pool sends jobs so rapidly that the miner falls behind.

**Mitigation:** Job channel is bounded (buffer size 32). The worker
picks the newest job, dropping older ones. Share submission is also
channel-bounded.

**Residual risk:** Legitimate high-throughput pools may trigger drops.
The design tradeoff favors freshness (no stale share penalty) over
completeness (drop old jobs rather than queue indefinitely).

---

**Threat:** A malicious pool floods `NewMiningJob` frames whose jobs are
never named by a `SetNewPrevHash`, growing the client's pending-job map
without limit (memory exhaustion over days of uptime — the map is only
cleared by `SetNewPrevHash`).

**Mitigation (session 343):** `tipState.pending` is capped at 64
entries — generous headroom over the handful honest pools keep in
flight between prev-hash updates. At capacity an arbitrary entry is
evicted so the newest job (the one most likely to be named next) is
retained. The V1 path has no equivalent: jobs flow through the bounded
job channel directly.

**Residual risk:** A pool could evict real future jobs by flooding —
worst case is those jobs never emit, identical to the pool simply not
sending them; memory stays bounded.

---

**Threat:** A hostile or broken upstream data feed (tariff / carbon /
pool-share HTTP APIs) returns an unbounded body, exhausting memory.

**Mitigation (session 347):** every external read is capped at 64 KiB
(`io.LimitReader`) — the same bound `rates/fetcher.go` already applied
to the BTC/USD fetchers. A day's Agile half-hourly rates is ~10 KB;
mempool.space pool distribution and National Grid carbon responses are
smaller still. Session 348 extended the same cap to the cgminer RPC
reply (`asic_endpoints` is operator-configured but a rogue LAN device
or mistyped IP can still stream garbage).

**Residual risk:** None material — oversized legitimate responses would
surface as decode errors, which the callers already handle as
transient fetch failures.

---

**Threat:** A wedged or malicious pool keeps the session alive — jobs
and notifications still flow, so the per-frame read deadline never
trips — while silently dropping every share verdict, leaking one
pending-map entry and one goroutine per submitted share until session
end.

**Mitigation (sessions 358, 364):** both transports bound the verdict
wait with a two-minute `submitResponseTimeout`. On expiry the share is
reported `Unconfirmed` (it did leave; its verdict is unknown) and the
pending entry is freed, matching the Session contract. V2 additionally
resolves backlogs wholesale: every `SubmitSharesSuccess` acks all
sequence numbers up to `last_sequence_number`, so one verdict drains
the map.

**Residual risk:** None — a pool that stops acking entirely just ends
the session through the normal error path.

---

**Audit coverage (session 365).** The following surfaces were audited
and verified bounded; re-audit is only warranted when their code
changes: V1/V2 job channels (depth 8), `noticeCh` (8, drop-oldest),
switch-verdict ledger (cap 64), extranonce rotation bounds (en2
1–64, even-length hex en1), `set_difficulty`/`suggest_difficulty`
degenerate-value rejection, `mining.ping` answered, `authorize` result
verified, V1 read deadline (5 min), V2 read/write/handshake deadlines,
TLS handshake deadline, submit-verdict timeouts (both), metric label
cardinality (no pool-controlled label values), `hashrateWindow` is O(1)
state, cgminer `addpool` field boundaries, `config show` masks
credentials and strips control bytes via `safeDisplay`, Octopus tariff
feed URL-escapes product and tariff codes.

**Sessions 366–370 follow-up.** Audited and either verified bounded or
fixed: config-file permission check when a pool password is set
(session 366, doctor warns on group/other-readable `config.yaml`),
systemd unit `%`-specifier escaping (session 367 — `%h`/`%i` in paths
would otherwise expand inside unit directives), launchd plist XML
escaping of `$HOME`-derived log paths (session 368), `arb explain`
`/arbitration` response body bound at 1 MiB (session 369 — closes the
last unbounded HTTP read; every other feed/probe body was already
capped: rates 64 KiB, cgminer RPC 64 KiB, clock-probe drain 8 KiB),
`SanitizeLine` covers C0 + C1 controls (0x00–0x1F, 0x7F–0x9F), logger
writes to stdout only (file rotation is the service manager's job), V2
Noise-NX read path unused in the live dialer (§2), secp256k1 scheme
stubs return `ErrSchemeNotImplemented` everywhere (no false-verify
surface), and `wallet.dat` permission probing (session 366 family).
Re-audit warranted only when those code paths change.


**Sessions 371–383 follow-up.** Tool-driven re-verification of the
published claims rather than new surface: `deadcode -test` clean after
removing the one unreachable wrapper (session 374); toolchain pinned to
go1.25.13, clearing all 15 govulncheck-reachable stdlib advisories
including GO-2026-4601 (net/url IPv6) — zero reachable findings remain
(session 375); `staticcheck` clean after two findings (session 376).
AUDIT_CHECKLIST rows corrected to reality rather than re-worded claims:
cosign signing marked *not met* (release.yml has no signing step —
artefacts ship unsigned), Actions SHA-pinning marked *not met*, Go
floor corrected to 1.25+ (`go` directive + toolchain pin + tlsmlkem),
scrypt parameters corrected to the seedstore values (N=2^17). Broken
release references repaired: README install.sh asset URL (never
uploaded) and docs/DEPLOYMENT_GUIDE.md (linked from every release
body). Upstream cross-check: SRI v1.11.1's "do not round up SV1
difficulties" (ckolivas) was verified against
`miner.TargetFromDifficulty` — it truncates the big.Float quotient, so
the rounded direction errs strict (harder shares), matching the fix.

**Sessions 414–417 CS-invariant pass.** First-principles review of the
engine's own invariants rather than published claims: session 414–416
unified every *logical* timestamp onto the injected `clock.Clock`
(session-loop tick/reject/liveness stamps, arbitration-loop stale
pruning/reliability epochs/ledger/snapshot) so a test clock governs one
time base end-to-end; measured wall time (submit RTT `sendTime`) stays
on the real clock deliberately. Verified already-correct invariants:
`Decide` is pure (no clock/RNG) and order-independent (score sort +
StreamID tie-break); `fanIn` observes ctx in both directions and closes
on drain; `streamsSlice` order cannot leak into user-visible output
(`activity` reads by ordered providers slice; ExplainRows follow
`alloc.Assignments`); share drops are deliberate non-blocking sends,
counted per-worker and — session 417 — exposed as
`otedama_shares_dropped_total` (previously log-only); `hashrateWindow`
differentiates delta/dt with reset+backward-time guards; `driftTracker`
uses relative shift bands with `expire` map pruning; `settleVerdicts`
resolves counterfactuals per (stream, device); `pendingSwitchCap` (64)
bounds the ledger; `rejectClass` normalises separators across V1/V2
spellings; `acceptanceRate` returns 1.0 at 0/0 rather than a spurious 0%
alarm.

**Sessions 418–421 CS-invariant pass, continued.** Session 419 closed a
real gap — a provider-controlled future-dated `q.At` would pin
`lastQuoteAt` ahead of the local clock forever, defeating stale-stream
pruning; `ts.IsZero() || ts.After(clk.Now())` now clamps to the local
clock (same defence posture as session 355's quote-value sanitisation).
Session 420 fixed the opaque `job_id` contract: `applyJob` previously
forced a decimal `Sscanf` and *failed* the job on non-decimal ids
(alphanumeric job ids stall mining; `"12abc"` even partial-parsed to the
wrong echo), and `submitV1Share` re-serialised the uint32 tag instead of
echoing the spec-mandated verbatim string. `miner.Work`/`miner.Share`
now carry `JobKey` verbatim end-to-end; the uint32 tag (FNV-32a on
non-decimal ids) is internal-only for metrics/reject classification.
Session 421 then pointed the submit-latency exemplar's `job_id` at
`JobKey` so the exemplar names the id the pool knows. Verified
already-correct: `difficultyTagger` is mutex-guarded with bounded FIFO
eviction; `stratumv1.Submit` pads extranonce2 to the negotiated size and
appends version_bits only when version-rolling was negotiated; CPU
workers roll only the 4-byte nonce space (adequate at CPU hashrates —
`ShareSubmission.ExtraNonce` stays empty by design, padded server-side);
exemplars are per-bucket latest-wins (no cardinality growth) and
`escapeLabel` sanitises `\`/`"`/`\n` so a hostile pool job_id cannot
inject lines into the `/metrics` exposition; `effectiveYield` guards
uptime ≤ 0 and clamps the productive fraction to [0,1].

**Session 424 CS-invariant pass.** Session 423 closed a real gap —
`provider.Yield.Effective()` lacked the NaN/Inf/clamp guards of its
arbitration twin, and the loop fed the Holt-Winters forecaster the raw
`observed * Confidence` product: one non-finite quote poisoned
level/trend forever (the `err > 2σ` reset can never fire on NaN).
Verified already-correct: `updateStreamReliability` discounts quote
confidence by `PosteriorMean()` ∈ (0,1) — the Beta decay is a no-op for
elapsed ≤ 0 and pulls pseudo-counts toward the Beta(1,1) prior, never
out of range; `markVolatility` writes `fc.StdDev()` only when the
forecaster has observations, and Decide skips non-finite stddevs;
`LatencyTracker` is a mutex-guarded ring whose Quantile sorts a copy —
exact nearest-rank on the retained window; `updateShareRates` clamps
unaccounted at 0 and never divides by zero (`judged == 0` early
return); `publishDifficulty` ignores non-positive difficulties and
reports 0 share-interval at zero hashrate rather than +Inf.

**Sessions 425–426 CS-invariant pass.** Session 425 closed a real gap —
a worker thread's nonce sequence (`threadID + k*NonceStep`, periodic mod
2³²) wrapped and rehashed covered space, emitting deterministic
duplicate shares the pool rejects; wrap now rolls ntime +1 (the cgminer
domain shift). Session 426 clamped `YieldForecaster.StdDev`'s Welford
M2 at zero — float cancellation on a near-constant series could return
NaN, which `markVolatility` stored unconditionally. Verified
already-correct: `driftTracker.observe` uses a scale-free relative
shift band (`max(prev,0)·ε` — any revival/death counts at any size)
with `expire` map pruning; `unaccountedWatchdog` warns only on a
consecutive-tick streak and logs recovery on drain; `uptimeAccountant`
and `satsAccountant` guard `elapsed ≤ 0` and the productive flag, so
the estimate never runs backwards or accrues while idle/stalled/
curtailed (`ratePerSec > 0` also filters NaN); `hashrateWindow`
saturates at 0 on counter reset instead of going negative.

---

### Elevation of privilege (E)

**Threat:** A vulnerability in Otedama leads to code execution as root.

**Mitigation:** Otedama never runs as root. The installed service is
a user service (systemd --user, LaunchAgent). No setuid binaries.
systemd unit sets `NoNewPrivileges=true`, `ProtectHome=read-only`,
`PrivateTmp=true`, and related hardening.

**Residual risk:** Privilege escalation remains possible via
OS-level bugs (kernel CVEs), which are out of scope for Otedama.

---

**Threat:** Malicious code in the binary itself.

**Mitigation:** Release artifacts are cosign-signed. The `install.sh`
script verifies SHA-256 and, when cosign is installed, verifies the
signature. Reproducible builds via `-trimpath` and fixed `-ldflags`.

**Residual risk:** The signing key can be stolen. GitHub's OIDC-based
keyless signing via Sigstore reduces this to "compromise of the
GitHub Actions runtime," which is actively monitored.

## Assumptions

- The user's operating system and filesystem are trustworthy.
- The user's shell history and screen lock are reasonable.
- The Go compiler does not contain a backdoor.
- The Go runtime's random number generator is cryptographically secure.
- TLS via `golang.org/x/crypto` is correctly implemented.

Design constraints recorded from the research ledger (not
vulnerabilities, but bounds on future design):

- Any future Lightning routing layer must not default to the dominant
  hubs: arXiv:2506.19333 shows pure cost-minimising path selection
  consolidates LN liquidity into a few hubs — the LN echo of ADR-001's
  pool-decentralisation stance (the same reasoning behind the ≥30%
  pool-network-share warning).

Any violation of these assumptions is outside Otedama's security
boundary. Users with elevated threat models (nation-state adversaries)
should consult specialists.

## Review cadence

This document is reviewed whenever:

- A new dependency is added (triggers supply-chain reassessment).
- A new network endpoint is exposed.
- A new file is written to disk.
- A new CLI flag accepts secrets.

The minimum review interval is once per major version.

## References

- ADR-001 — Non-custodial wallet model
- ADR-002 — Stratum V2 as the exclusive pool protocol
- ADR-003 — Zero runtime dependencies
- `SECURITY.md` — Vulnerability reporting
- [Stratum V2 specification](https://stratumprotocol.org/)
- [Noise Protocol Framework](https://noiseprotocol.org/)
- Recabarren & Carbunar, "Hardening Stratum, the Bitcoin Pool Mining
  Protocol" (arXiv:1703.06545) — basis for the traffic-analysis
  side-channel threat in the Information-disclosure section.
- Rohrer & Tschorsch, "Counting Down Thunder: Timing Attacks on Privacy
  in Payment Channel Networks" (arXiv:2006.12143) — the LN analogue of
  that timing channel.
- arXiv:2506.19333 — Lightning liquidity consolidation under
  cost-minimising path selection; basis for the no-hub-default
  design constraint in Assumptions.
