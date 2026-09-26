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

**Threat:** The chosen pool itself mines selfishly against the user's
submitted work — withholding found blocks to gain an advantage. Unlike
share stealing, this is *undetectable*: Bahrani & Weinberg prove a
selfish-mining strategy whose orphan pattern is statistically
indistinguishable from honest mining and profitable from 38.2% of
network hashrate (arXiv:2309.06847). No client-side observation can
prove or disprove it.

**Mitigation:** None direct — the attack is definitionally invisible to
the miner. What Otedama provides is *cheap defection*: multi-pool
failover and endpoint diversity (`otedama doctor`'s pool-diversity
checks) keep the cost of leaving a pool low, and the pool-vs-local
share reconciliation (session 260) surfaces sustained payout-vs-work
divergence that, while it cannot distinguish selfish mining from bad
luck, is the closest observable signal.

**Residual risk:** A miner on a selfish-mining pool loses revenue and
cannot know it. The honest advice is to prefer pools whose own revenue
model disincentivises withholding (PPLNS-family schemes penalise
withheld blocks; FPPS pools absorb the risk instead) and to rotate
periodically — both are operator choices, not code.

---

**Threat:** Supply chain: a dependency is replaced with a malicious
version.

**Mitigation:** Only two runtime dependencies: `golang.org/x/crypto`
and `go.yaml.in/yaml/v3`, plus the Go standard library. All GitHub
Actions pinned by SHA. Dependabot auto-updates with review. govulncheck
runs in CI. See ADR-003.

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

The same class of timing channel exists on the payout side: Rohrer &
Tschorsch, "Counting Down Thunder" (arXiv:2006.12143), show that
HTLC-resolution timing leaks payment endpoints in payment-channel
networks — the Lightning analogue of the Stratum leak above.
Tor-by-default (ADR-007 B7) mitigates both channels at once.

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
channel-bounded. Every job *store* upstream of the channel is bounded
too: the engine's jobs map is capped at `jobsCap` = 64 with oldest-first
eviction (session 257), and the `stratumv2` adapter's `pending` map —
which collects NewMiningJob frames between SetNewPrevHash tips — is
capped at the same `pendingCap` = 64 (session 265), so a pool flooding
distinct job IDs without rotating the tip cannot grow memory without
bound.

**Residual risk:** Legitimate high-throughput pools may trigger drops.
The design tradeoff favors freshness (no stale share penalty) over
completeness (drop old jobs rather than queue indefinitely).

---

**Threat:** A malicious pool negotiates an absurd `extranonce2_size`
(Stratum V1 `mining.subscribe` / `mining.set_extranonce`), which the
client then repeats into a hex padding string on every share submit —
a per-submit memory-exhaustion vector (e.g. size = 1 GiB → ~2 GiB
allocation per `mining.submit`).

**Mitigation:** `extranonce2_size` is bounded at both negotiation entry
points (`parseSetExtranonce`, `parseSubscribeResult`) to
`[0, maxExtranonce2Size]` where `maxExtranonce2Size` = 64 — generous
headroom over the 4–8 bytes real pools use, since the value lives
inside the ≤100-byte coinbase scriptSig. `Submit` re-checks the bound
before allocating (defense in depth). `FuzzV1Parsers` asserts no parser
ever yields an out-of-range size.

**Residual risk:** A pool negotiated within the bound can still send
marginal values (e.g. 64 bytes) that produce odd shares the pool then
rejects — a reject-rate signal, not a memory risk.

---

**Threat:** A malicious pool — or a MitM on cleartext Stratum V1 —
manipulates `mining.set_difficulty` in either direction. Pushed
absurdly low, nearly every hash "meets" the share target and the miner
floods itself generating submits (CPU burn, log spam, likely pool ban).
Pushed absurdly high, the miner silently earns nothing — no rejects,
no disconnect, just no shares.

**Mitigation:** Upward: `clampShareTarget` (session 256) bounds the
share target by the block target so an oversized difficulty cannot be
weaponised into block-solve grinding, and the engine warns once per
episode when the pool's difficulty implies an expected share interval
> 1 h at the observed hashrate ("revenue starvation" warn, session
270) — the tripwire the `otedama_estimated_share_interval_seconds`
gauge already exposes. Downward: the per-worker share channel is
bounded and drops excess found shares (logged as "dropped N found
share(s)"), so a flood degrades to bounded CPU burn on the submit loop
rather than memory growth or unbounded pool traffic.

**Residual risk:** A submit-rate cap keyed to expected share interval
(e.g. refuse effective diff that implies > N submits/s) would bound
the downward direction tighter, at the cost of a false-positive surface
for pools legitimately assigning sub-1 difficulties to weak devices —
recorded as a candidate rather than implemented unilaterally.

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
- TLS via `crypto/tls` is correctly implemented — including the hybrid
  post-quantum key exchanges (`X25519MLKEM768`/`SecP256r1MLKEM768`/
  `SecP384r1MLKEM1024`) that Otedama enables by default via the
  `tlsmlkem=1`/`tlssecpmlkem=1` godebug pins (see `GODEBUG_NOTES.md`).
  These hybrids remain in the approved set under `GODEBUG=fips140=on`;
  `otedama doctor`'s "Crypto compliance" check reports the live FIPS
  140-3 mode and warns on `fips140=only`, which would panic on the
  non-approved Noise AEAD and wallet scrypt KDF.

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
- Bahrani & Weinberg, "Undetectable Selfish Mining" (arXiv:2309.06847)
  — basis for the pool-selfishness threat in the Tampering section.
- Rohrer & Tschorsch, "Counting Down Thunder: Timing Attacks on
  Privacy in Payment Channel Networks" (arXiv:2006.12143) — the
  Lightning analogue of the Stratum timing side channel.
