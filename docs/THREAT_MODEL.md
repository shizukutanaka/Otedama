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
- Connections to Stratum V1 and Stratum V2 pools.
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

**Mitigation:** Pool authentication exists **only** through the TLS
certificate on the `stratum+tls://` and `stratum+v2tls://` transports
(optionally pinned to a custom CA via `tls_ca_file`). The Noise NX
handshake in `internal/stratum/noise*.go` is implemented and tested
but is **not wired into the live dial path** — `stratum+v2://` is
plaintext binary framing and `stratum+tcp://` is plaintext JSON-RPC,
so on those schemes a network adversary can impersonate the pool and
redirect shares (stratum-hijacking; KNOWN_LIMITATIONS §2). V1 fallback
**is** supported, so downgrade resistance is a deployment property,
not a protocol guarantee: use a `*tls://` scheme and run
`otedama doctor`, whose pool-encryption check flags plaintext schemes.

**Residual risk:** Until Noise NX (spec: secp256k1; see ADR-011) is
wired into the session path, authentication coverage is TLS-only and
plaintext schemes offer none. Users on `stratum+v2://` or
`stratum+tcp://` remain exposed to on-path share theft.

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
mitigation). The encryption's key derivation uses scrypt
(N=131072, r=8, p=1);
a determined offline attacker with a modern GPU cluster can brute-force
weak passphrases. Use a strong passphrase; see CONTRIBUTING.md.

---

**Threat:** A malicious pool sends a crafted frame that causes buffer
overflow, panic, or memory exhaustion.

**Mitigation:** `MaxFrameSize` caps any single frame. Fuzz targets
exist for the riskiest parsers (`FuzzDecodeHeader`,
`FuzzDecoder_ReadFrame`, `FuzzV1ReadLine`, `FuzzV1Dispatch`,
`FuzzEncryptedConnRead`); they run in CI on every push/PR as
seed-corpus regression tests. Nightly duration fuzzing and automatic
crasher reporting are **not** wired — tracked in
KNOWN_LIMITATIONS §13 for the maintainer.

**Residual risk:** Go panic safety provides strong guarantees, but
a panic in the decode path still terminates the miner (DoS, below).

---

**Threat:** Supply chain: a dependency is replaced with a malicious
version.

**Mitigation:** Only two direct runtime dependencies beyond the Go
standard library: `golang.org/x/crypto` and `go.yaml.in/yaml/v3`
(the maintained successor of `gopkg.in/yaml.v3`; see ADR-003 erratum).
Most GitHub Actions are pinned by SHA; known floating `@master`
references (`trivy-action`, `gosec`) are recorded in
KNOWN_LIMITATIONS §13 and remain the maintainer's to pin.
Dependabot auto-updates with review. `govulncheck` is **not** wired
into CI today — also tracked in §13.

**Residual risk:** Compromise of the Go toolchain, the Go proxy, or
one of the two direct dependencies remains possible — as does
compromise of an unpinned Action's `@master` ref between updates.
We have no mitigation other than early detection and dependency
minimalism.

---

**Threat:** Selfish mining (block withholding): a pool accepts valid
shares and withholds blocks that a miner's shares found, keeping the
reward for itself. Bahrani & Weinberg's "Undetectable Selfish Mining"
(arXiv:2309.06847) show a variant whose orphan pattern is
statistically indistinguishable from honest mining and profitable
from 38.2% hashrate — so a miner's local counters cannot prove the
pool is withholding.

**Mitigation:** None exists in-protocol, and the attack is
**undetectable from the miner's side**: a share that found a withheld
block is indistinguishable from one that found nothing. Defences are
out-of-band: pool transparency/audited orphan statistics, and miners
diversifying across pools so a withholding pool's relative share does
not grow unchecked.

**Residual risk:** Fully residual. This is the security rationale for
keeping more than one pool configured and for the arbitration
defaults: if one pool's reported yields drift below the alternatives,
switching limits the attacker's reach. It cannot be removed by client
software.

---

### Repudiation (R)

**Threat:** A user claims "Otedama never mined for me" to dispute
operator claims.

**Mitigation:** Share submissions and pool verdicts are logged. On the
V2 path the log lines carry the share's sequence number and nonce
(`engine: share seq=N nonce=0x…`); V1 verdicts are logged by class
(accepted / rejected-with-reason / unresolved). Prometheus metrics
persist via the scrape target. Pool batch acknowledgements are
reconciled against the submitted count and logged
(`otedama_pool_shares_sum_total`,
`otedama_pool_reconcile_divergences_total`).

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
truncate Bitcoin addresses to `bc1qar···5mdq` (first 6 + last 4
chars). Wallet passphrases are never logged. Mnemonics are displayed
exactly once on first run (interactive TTY only — output is refused
when stdout is not a terminal, so the phrase cannot end up in a log
file) and never written to a log file.

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

**Mitigation:** `MaxFrameSize` = 16 MiB in the decoder — the bound
the Stratum Reference Implementation uses (the V2 spec mandates no
single value). Frames larger than this are rejected before
allocation.

**Residual risk:** 16 MiB × 1000 misbehaving channels = 16 GiB. Otedama
is a single-pool client, so this scales with concurrent connections
only if a user misconfigures multiple pools, which is bounded by the
configuration.

---

**Threat:** A pool sends jobs so rapidly that the miner falls behind.

**Mitigation:** The engine's job store is bounded (256 entries, FIFO
eviction of the oldest) and per-session pending-job maps are capped
(256) — a flooding pool cannot grow memory without bound. The worker
consumes the newest job, dropping older ones, and share submission is
channel-bounded (4 per worker thread).

**Residual risk:** Legitimate high-throughput pools may trigger drops.
The design tradeoff favors freshness (no stale share penalty) over
completeness (drop old jobs rather than queue indefinitely).

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

**Mitigation:** `install.sh` verifies the archive's SHA-256 against the
release's `checksums.txt` when the release publishes one, and — when
cosign is installed and a signature is published — verifies the
keyless Sigstore signature of the checksums file against the
GitHub Actions OIDC identity. Builds use `-trimpath` and fixed
`-ldflags`. Today the release pipeline publishes the archives but
**not** `checksums.txt` or signatures; the installer detects that and
warns loudly rather than claiming verification that did not happen.
Signing and provenance attestation remain a tracked improvement item
(`docs/RESEARCH_IMPROVEMENTS.md`, category 4 #22).

**Residual risk:** Until release signing ships, a compromised release
or lookalike asset is only detectable by out-of-band hash comparison.
Download assets directly from the repository's Releases page.

## Assumptions

- The user's operating system and filesystem are trustworthy.
- The user's shell history and screen lock are reasonable.
- The Go compiler does not contain a backdoor.
- The Go runtime's random number generator is cryptographically secure.
- TLS via the standard library's `crypto/tls` is correctly implemented
  (`golang.org/x/crypto` supplies scrypt and related primitives, not
  the TLS stack).

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
- Eyal & Sirer, "Majority is not Enough: Bitcoin Mining is Vulnerable"
  (arXiv:1311.0243) and Bahrani & Weinberg, "Undetectable Selfish
  Mining" (arXiv:2309.06847) — basis for the selfish-mining threat in
  the Tampering section.
