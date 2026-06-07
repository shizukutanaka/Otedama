# Otedama — Specification (v3.0.0-alpha.1)

This document specifies the *observable behaviour* of Otedama as it is
actually implemented on this branch. It is descriptive (matches the code),
not aspirational — forward-looking work lives in `ROADMAP.md`, and honest
shortfalls in `docs/KNOWN_LIMITATIONS.md`. The product definition and
design principles are normative in `CLAUDE.md`.

The final section, **Gaps found while writing this spec**, lists concrete
discrepancies between intended and actual behaviour, with their status.

---

## 1. Product scope

Otedama is a non-custodial, Stratum-V2-first software suite that arbitrates
user-owned ASIC/GPU/CPU hardware across Bitcoin mining (real) and AI-inference
provision (currently simulated — see KNOWN_LIMITATIONS §1). Bitcoin only
(SHA-256d); no custody of others' funds; no token issuance. (CLAUDE.md.)

## 2. Command-line interface

```
otedama <command> [flags]
```

| Command | Behaviour |
|---|---|
| `run` | Detect hardware, optionally create a Lightning wallet, connect to a pool, and mine. |
| `version [--json]` | Print version/commit/build-date/go-version/platform; `--json` emits the `version.Info` object. |
| `config show` | Print the **effective** configuration after layering (see §3). |
| `config validate` | Validate the effective configuration; print `configuration is valid` or the issues. |
| `service install\|uninstall\|status` | Manage the background service (systemd/launchd/Task Scheduler). |
| `doctor` | Run self-diagnostic checks. |
| `completion bash\|zsh\|fish` | Emit a shell-completion script. |
| `help` / `--help` / `-h` | Print usage. |

### 2.1 Exit-code contract

| Code | Name | Meaning |
|---|---|---|
| `0` | OK | Success. |
| `1` | runtime | Runtime failure after a valid start (e.g. unrecoverable session error). |
| `64` | usage | Bad/unknown command, flag, or argument (`EX_USAGE`). |
| `78` | config | Invalid configuration (`EX_CONFIG`). |

Scripts may rely on these. `run` returns `78` if the resolved config fails
validation, `64` for flag-parse errors, `1` for a runtime error, `0` on clean
shutdown (SIGINT/SIGTERM).

## 3. Configuration

Fields (YAML keys): `bitcoin_address`, `bitcoin_addresses` (failover list),
`pools[]` (`url`,`user`,`password`), `workers.name`, `language`, `log_level`,
`log_format`, `data_dir`.

**Precedence (highest→lowest):** flags → environment
(`OTEDAMA_BITCOIN_ADDRESS`, `OTEDAMA_LOG_LEVEL`, `OTEDAMA_LOG_FORMAT`,
`OTEDAMA_LANGUAGE`, `OTEDAMA_DATA_DIR`) → config file → built-in defaults.
The address failover **list** is config-file-only; flags/env set the primary.

**Validation rules:** at least one payout address is required (primary or a
backup); every address must be a plausible mainnet address (length 26–90,
prefix `1`/`3`/`bc1`; checksum is *not* verified here); `log_level` ∈
{debug,info,warn,error}; each `pools[].url` must use a supported scheme
(`stratum+tcp|tls|v2|v2tls://`) with a non-empty host. An empty/comments-only
file is valid (defaults apply).

`config show` prints all effective fields including the failover addresses and
the configured pool URLs.

## 4. Mining session lifecycle

1. **Resolve + validate** config; abort with exit 78 on failure.
2. **Detect devices** (CPU always; GPU via Linux DRM sysfs — Linux-only,
   KNOWN_LIMITATIONS §4).
3. **Optional wallet** (only if `--wallet-passphrase` given): BIP-39 seed,
   scrypt+AES-GCM encrypted at rest, receive-only (KNOWN_LIMITATIONS §6).
4. **Reconnect loop** (`runReconnectLoop`):
   - Ordered pool list (`poolURLs`) and ordered payout-address list
     (`payoutAddresses`: primary first, de-duplicated, empties skipped).
   - For each attempt: dial TCP → Stratum V2 handshake (SetupConnection +
     OpenMiningChannel) → on success the address is marked *known-good*.
     The channel's `user_identity` is the per-pool `User` if set, otherwise
     the active payout address, suffixed with `.worker` when `Workers.Name`
     is configured.
   - **Pool failover (fast):** on session failure, advance to the next pool
     immediately; back off only after every pool has been tried.
   - **Payout-address failover (slow, safe):** rotate to the next address
     **only while the active address has never established a session**. A
     known-good address is never abandoned, and no session establishes during
     an outage, so an outage cannot silently redirect earnings.
   - **Backoff:** exponential from `reconnectBackoffInitial` to
     `reconnectBackoffMax`; honoured between full cycles.
5. **In-session:** decode frames; apply `NewMiningJob` to workers; submit
   found shares (`SubmitSharesStandard`); on `SubmitSharesSuccess` settle
   submit→accept latency and increment accepted; on `SubmitSharesError`
   classify the reason (`rejectClass` → stale/duplicate/difficulty/hardware/
   other) and increment the per-reason counter.
6. **Graceful shutdown** on SIGINT/SIGTERM.

## 5. Transport (Stratum V2)

Binary frame layer (`internal/stratum`): 6-byte header (u16 ext_type, u8
msg_type, u24 msg_length), length-bounded against `MaxFrameSize`
(default 16 MiB) with explicit overflow guards before allocation. Optional
Noise NX transport encryption (ChaCha20-Poly1305, SHA-256); the DH primitive
is **P-256 in this alpha**, not secp256k1 (KNOWN_LIMITATIONS §2). The
encrypted-frame codec is u16-length-prefixed, rejects oversize writes, and
buffers partial reads so no plaintext is dropped (session 53).

## 6. Metrics (`/metrics`, Prometheus text format, no client dependency)

Counters: `otedama_shares_found_total`, `otedama_shares_total{status}`,
`otedama_shares_rejected_by_reason_total{reason}`,
`otedama_pool_connect_attempts_total`, `otedama_pool_connect_failures_total`,
`otedama_arbitration_switches_total`.
Gauges: `otedama_hashrate_hashes_per_second`, `otedama_btc_usd_rate`,
`otedama_uptime_seconds`, `otedama_start_time_seconds`,
`otedama_submit_latency_milliseconds{quantile}`,
`otedama_share_acceptance_rate`, `otedama_up`,
`otedama_pool_connection_state` (0/1/2), `otedama_pool_active_index`,
`otedama_payout_active_index`, `otedama_build_info{version,commit,goversion}`.
HTTP endpoints: `/metrics`, `/healthz`, `/readyz`, `/`.

## 7. Known limitations

Authoritative list in `docs/KNOWN_LIMITATIONS.md`: (1) AI-inference yield is
simulated; (2) Noise NX uses P-256, not secp256k1; (3) engine does not yet
route through the `poolproto` abstraction; (4) GPU detection is Linux-only;
(5) post-quantum schemes are scaffolded; (6) Lightning is receive-only.

---

## 8. Gaps found while writing this spec

| # | Gap | Status |
|---|---|---|
| G1 | `config show` omitted the failover addresses, `log_format`, `worker_name`, and the actual pool URLs (showed only a count) — it did not show the *effective* configuration as documented. | **Fixed this session** (session 57): `config show` now prints all effective fields incl. `bitcoin_addresses` and pool URLs. |
| G2 | The exit-code contract was defined in code but undocumented for scripting. | **Fixed (session 57)**: documented in §2.1. |
| G11 | `otedama_btc_usd_rate` was registered and listed in §6 but never `Set` — the rate fetcher ran and exposed `BTCUSDRate()`, yet the gauge stayed at 0, so a dashboard/alert on BTC price saw nothing. | **Fixed (session 62)**: a publisher copies the fetcher's rate (its fallback before the first fetch, then live medians) into the gauge on a 30s cadence. |
| G10 | `/readyz` reported ready as soon as the process started (`OnReady(true)` fired before any pool connection), contradicting its documented "ready only if pool connected" semantics — a k8s readiness probe would treat a miner that can reach no pool as ready. | **Fixed (session 61)**: readiness is now driven from the session lifecycle — `OnReady(true)` on handshake completion, `OnReady(false)` on disconnect/shutdown — so `/readyz` tracks an actual pool connection and flips back when it drops. |
| G9 | `doctor` validated only the primary `bitcoin_address`, not the session-56 `bitcoin_addresses` failover list — a typo in a backup went uncaught by the diagnostic tool. | **Fixed (session 60)**: added a "Failover payout addresses" check that validates every entry (skips when none configured, fails on any malformed entry). |
| G8 | `log_format` from the config file/env was silently ignored: `--log-format` bound to a standalone flag with a non-empty `"text"` default and the logger read the flag, not the resolved `cfg.LogFormat` — and `Validate` never checked it. | **Fixed (session 59)**: `--log-format` now binds to `FlagValues.LogFormat` (empty default → correct flag>env>file>default precedence), `buildLogger` uses `cfg.LogFormat`, and `Validate` rejects values outside {text,json}. |
| G7 | `PoolConfig.User` and `Workers.Name` were documented config fields the engine never read — the Stratum user_identity was always the bare payout address. | **Fixed (session 58)**: `sessionUser` now honours an explicit per-pool `User`, else uses `address.worker` when `Workers.Name` is set, else the address. `PoolConfig.Password` is documented as V1-only/unused (no password in the V2 transport). |
| G3 | Engine bypasses the `poolproto` dialer abstraction (inline handshake). | Open — KNOWN_LIMITATIONS §3; deferred (would regress submit-latency/reject telemetry until `poolproto.Session` is extended — see CHANGELOG session 55). |
| G4 | Noise NX DH uses P-256, not secp256k1 + ElligatorSwift. | Open — KNOWN_LIMITATIONS §2; decided in ADR-011, implementation pending the dependency. |
| G5 | AI-inference yield is simulated (no live Akash API). | Open — KNOWN_LIMITATIONS §1; concrete integration surface catalogued (RESEARCH_IMPROVEMENTS session-51 #11, session-52 #3). |
| G6 | GPU detection is Linux-only. | Open — KNOWN_LIMITATIONS §4. |

This spec is updated alongside the code; new gaps are added here as they are
found and removed in the same change that closes them.
