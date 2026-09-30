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
  withholds shares, manipulates difficulty).
- **Other local user.** A different unprivileged user on the same OS.

We explicitly *exclude* a local attacker with root/administrator
privileges. No user-space software resists that threat.

## STRIDE analysis

### Spoofing (S)

**Threat:** An attacker impersonates the pool to steal shares.

**Mitigation:** Stratum V2 Noise NX handshake authenticates the pool
to the miner via a static public key. `internal/stratum/noise.go`
implements the handshake. V1 is also supported (ADR-006): the protocol
is selected by the URL scheme the operator configures —
`stratum+v2://` / `stratum+v2tls://` get Noise/PKI authentication,
while `stratum://` (V1) is plaintext with no MITM protection at all
and `stratum+tls://` (V1) is protected only by the PKI. An attacker
cannot downgrade a configured `stratum+v2*` pool — there is no
auto-negotiation — but nothing stops an operator from configuring a
plaintext V1 pool; that is a configuration choice, and the residual
risk below applies.

**Residual risk (V1):** on a `stratum://` pool, an on-path attacker
can hijack shares and inject jobs with no authentication barrier —
the classic threat V2 was designed to close. Operators should prefer
`stratum+v2tls://` or at minimum `stratum+tls://` pools.

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
mitigation). The encryption's key derivation uses scrypt (N=2^17 = 131072);
a determined offline attacker with a modern GPU cluster can brute-force
weak passphrases. Use a strong passphrase; see CONTRIBUTING.md.

---

**Threat:** A malicious pool sends a crafted frame that causes buffer
overflow, panic, or memory exhaustion.

**Mitigation:** `MaxFrameSize` caps any single frame. Fuzz tests
cover every untrusted-input parser — V1 wire messages and
notifications, SV2 frame/header/message/handshake decoders and
primitives, address validators, target bitmath, env-var parsing,
config-file decode, arbitration inputs, and BIP-39 restore — via
`make fuzz` (a scheduled CI fuzz job is not yet wired).

**Residual risk:** Go panic safety provides strong guarantees, but
a panic in the decode path still terminates the miner (DoS, below).

---

**Threat:** Supply chain: a dependency is replaced with a malicious
version.

**Mitigation:** Only two third-party runtime dependencies:
`golang.org/x/crypto` and `gopkg.in/yaml.v3` (plus the Go standard
library). All GitHub Actions pinned by SHA. Dependabot auto-updates
with review. govulncheck runs in CI. See ADR-003.
**Mitigation:** Only three runtime dependencies: `golang.org/x/crypto`,
`gopkg.in/yaml.v3`, and the Go standard library. Dependabot auto-updates
with review. govulncheck runs in CI. See ADR-003.

**Residual risk (CI supply chain):** GitHub Actions are referenced by
release tags (`@v4`, `@v5`, …), not commit SHAs, so a compromised or
re-tagged upstream action could execute in CI. Pinning `uses:` entries
to full-length SHAs is a tracked hardening item.

**Residual risk:** Compromise of the Go toolchain, the Go proxy, or
one of the two direct dependencies remains possible. We have no
mitigation other than early detection.

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
on-path adversary can estimate a miner's hashrate and luck. Users who
need to defeat this should tunnel the pool connection over Tor or a VPN
(Tor-by-default is planned — ADR-007 B7). Adding traffic shaping or a
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

**Threat (network adversary):** An on-path attacker corrupts a single
SV2 ciphertext so the Noise nonce counters desynchronize — every
subsequent frame fails to decrypt and the session silently dies while
the miner keeps hashing stale jobs (the EROSION attack, Tran/von
Arx/Vanbever, IEEE S&P 2024 — same endpoint behavior as dropping all
V1 packets).

**Mitigation:** Otedama treats any frame/decrypt error as session
fatal: the read loop exits, the engine's reconnect loop re-dials, and
a fresh Noise handshake re-synchronizes the nonce counters. There is
no silent-degradation mode in which the miner continues on a broken
session — the desync degrades into a bounded reconnect rather than
persistent unrecoverable desynchronization.

**Residual risk:** Sustained tampering produces a reconnect loop —
bounded by the exponential reconnect backoff, but shares are lost
during each gap. No client-side fix exists: the countermeasure is
routing hygiene (pool-side RPKI/monitoring), which is the pool's and
the network's responsibility, not the client's.

---

**Threat:** A hostile or buggy SV2 pool floods *distinct* job IDs
(`NewMiningJob`) without ever rotating the chain tip, so the
outstanding-job maps grow without bound — memory exhaustion. The
per-message bound (`MaxFrameSize`) does not help: each frame is small;
the *count* is unbounded. Noise encryption is irrelevant because the
actor here is the pool itself, not a MitM.

**Mitigation:** Both outstanding-job maps are capped at 64 with FIFO
eviction: the engine loop's `jobs` map (`storeBoundedJob`, `jobsCap`)
and the stratumv2 adapter read loop's `pending` map (`pendingCap`).
A `SetNewPrevHash` still drains the map to the named job, so the bound
only bites pools that flood *without* rotating the tip. The newest jobs
— most likely to be activated — survive eviction.

**Residual risk:** None identified. A legitimate pool exceeding 64
in-flight jobs would lose the oldest ones; the tip's named job is
always retained when present, so activation still proceeds.

---

**Threat:** A malicious or compromised Stratum V1 pool negotiates an
absurd `extranonce2_size` to force a large per-job allocation, or sends
malformed coinbase hex to corrupt the merkle fold.

**Mitigation:** `completeV1Job` folds the coinbase only when en1/en2size
are negotiated and `extranonce2_size ≤ 64`; anything else falls back to
the pre-fix behaviour (zero merkle, zero-padded en2 on the wire) rather
than allocating a pool-dictated buffer. Coinbase hex that fails to
decode leaves the field empty, which also triggers the fallback — no
partial fold is ever emitted.

**Residual risk:** Because en2 is fixed per job, a worker that exhausts
the 32-bit nonce space inside one job can emit a duplicate share (same
header, same en2). Pools treat duplicates as benign; the residual is a
wasted hash, not a correctness failure. A per-job nonce-wrap en2 bump is
the documented next step if this ever becomes measurable.

---

**Threat:** A hostile or misconfigured pool drives difficulty to ~0
(`mining.set_difficulty` / `SetTarget`), so workers produce shares at
hardware speed and every share becomes a wire submission — a submit
flood that wastes this host's CPU/network and can get the account
rate-limited or banned pool-side.

**Mitigation:** A per-session token bucket (`submitLimiter`) admits at
most 8 submits/s with a burst of 32; excess shares are dropped before
they reach the wire and counted on `otedama_shares_submit_dropped_total`.
The cap is set far above any honest pool's credit rate, and shares that
would pass it are stale by the time they could send, so the drop loses
nothing real.

**Residual risk:** The cap bounds the wire rate but not the wasted
hashing itself — workers still burn cycles producing un-creditable
shares at difficulty ~0. The session-270 starvation tripwire (warn when
expected share interval > 1 h) covers the opposite pole; a
difficulty-floor disconnect is the documented next step.

---

**Threat:** A hostile pool or a MitM on cleartext Stratum V1 sets
`extranonce2_size` to a huge value at `mining.subscribe` or via a
mid-session `mining.set_extranonce`. The field flows into
`strings.Repeat` on every `mining.submit`, so one negotiation value
turns each share into a multi-gigabyte allocation — memory exhaustion.

**Mitigation:** `maxExtranonce2Size = 64` (real pools use 4–8) enforced
at both entry points: out-of-range subscribe results abort the dial;
out-of-range `set_extranonce` notifications are dropped. `Submit` also
clamps the padding to `[0, 64]` so no future entry point can re-open
the vector.

**Residual risk:** A legitimate pool requiring >64 bytes of
extranonce2 space cannot be served — no such scheme exists in
practice; known pools stay within 8.

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

**Mitigation (planned, not yet live):** the signed-release pipeline
described in `VERIFY.md` (checksums + cosign keyless signatures +
SBOMs, via `.goreleaser.yaml`) exists as configuration but is not
wired into `release.yml` — current releases ship plain tarballs. The
only available verification today is rebuilding from source per
VERIFY.md. `install.sh` fetches the release asset matching the
platform name.

**Residual risk:** until signed releases ship, downloaded artifacts
cannot be cryptographically verified — users with strict supply-chain
requirements should build from source.

**Residual risk (once live):** the signing key can be stolen.
GitHub's OIDC-based keyless signing via Sigstore reduces this to
"compromise of the GitHub Actions runtime," which is actively
monitored.
**Mitigation:** Release artifacts ship a `checksums.txt` file that
`install.sh` verifies with SHA-256 before installing. `install.sh`
also supports optional cosign `verify-blob` against
`checksums.txt.sig`/`.pem` when a signature is published, and is
written to skip that step cleanly when none exists. Reproducible
builds via `-trimpath` and fixed `-ldflags`.

**Residual risk:** As of this writing the release workflow does not
yet publish cosign signatures, so checksum verification is the only
binary-integrity check — a compromised release pipeline could ship
tampered archives. Publishing keyless Sigstore signatures (OIDC
identity bound to the release workflow) remains a release-hardening
item; when enabled, `install.sh` picks it up automatically and
`--certificate-identity-regexp` pins the signer identity to this
repository's workflows.

## Posture notes

- **FIPS 140-3:** Otedama is not FIPS-compliant by design. The
  Stratum V2 Noise NX transport (`internal/stratum/noise.go`, not yet
  wired into live connections — KNOWN_LIMITATIONS §2) uses
  ChaCha20-Poly1305 from `golang.org/x/crypto`, which is not in the
  FIPS-approved algorithm list and is outside the Go FIPS module, so
  enabling `fips140=on` does not make that transport FIPS-validated. (Wallet-at-rest encryption —
  AES-256-GCM — *is* a FIPS-validated construction; the gap is the
  transport.) Environments with a hard FIPS requirement should not
  deploy Otedama. See `GODEBUG_NOTES.md`.

## Assumptions

- The user's operating system and filesystem are trustworthy.
- The user's shell history and screen lock are reasonable.
- The Go compiler does not contain a backdoor.
- The Go runtime's random number generator is cryptographically secure.
- TLS via `golang.org/x/crypto` is correctly implemented.

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
- ADR-002 — Stratum V2 as the exclusive pool protocol (partially
  superseded by ADR-006: V1 support shipped)
- ADR-003 — Zero runtime dependencies
- `SECURITY.md` — Vulnerability reporting
- [Stratum V2 specification](https://stratumprotocol.org/)
- [Noise Protocol Framework](https://noiseprotocol.org/)
- Recabarren & Carbunar, "Hardening Stratum, the Bitcoin Pool Mining
  Protocol" (arXiv:1703.06545) — basis for the traffic-analysis
  side-channel threat in the Information-disclosure section.
