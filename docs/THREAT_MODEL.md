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
- Connections to mining pools over Stratum V2 **and Stratum V1** — all
  four schemes Otedama dials (`stratum+v2tls://`, `stratum+tls://`,
  `stratum+v2://`, `stratum+tcp://`), two of which are plaintext.
- Connections to price feeds (Coinbase, Kraken, CoinGecko).
- Connections to AI inference providers — future only. No such connection
  exists today: the simulated provider was deleted in session 264 and the
  product opens no AI-market network connection of any kind, so this row
  currently contributes no attack surface.
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

**Mitigation — TLS schemes only.** `stratum+v2tls://` and
`stratum+tls://` authenticate the pool with ordinary TLS certificate
verification, which is never disabled and uses system roots plus any
`tls_ca_file` the user configures. **`stratum+v2://` and `stratum+tcp://`
authenticate the pool not at all.**

**This section previously claimed the opposite** (corrected session 266).
It said the Noise NX handshake authenticates the pool via a static public
key, and that "falling back to V1 is not supported, so downgrade attacks
are structurally impossible". Both halves were wrong, and an auditor
acting on them would have skipped the most important question about this
product:

- `internal/stratum/noise.go` implements the handshake, but **no dial
  site calls it** (`docs/KNOWN_LIMITATIONS.md` §2). The engine's
  `stratum+v2://` path uses a plain `net.Dialer`. There is no pool
  authentication on that path, and the payout address
  (`OpenMiningChannel.User`) crosses the network in the clear, where an
  active adversary can rewrite it. That is asset #3 in the list above,
  and its compromise is described there as "a silent theft".
- Stratum V1 **is** supported (`internal/poolproto/stratumv1`), so the
  structural argument against downgrade does not hold either. What
  protects against downgrade is the user's scheme choice: Otedama dials
  exactly the scheme configured and never negotiates upward or downward
  from it.

**Residual risk:** every user on a non-TLS scheme is exposed to pool
impersonation and payout-address rewriting. The mitigation available
today is to configure a TLS scheme. Within the unreachable Noise code the
DH primitive is P-256 rather than the spec-mandated secp256k1 +
ElligatorSwift (ADR-011), which is why wiring it up is not a small
change.

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
mitigation). The key derivation uses scrypt with **N=2¹⁷ = 131072**,
r=8, p=1 (this section said N=32768, a quarter of the real cost
parameter — corrected session 266 from `internal/lightning/seedstore.go`);
a determined offline attacker can still brute-force a weak passphrase.
Use a strong passphrase; see CONTRIBUTING.md.

---

**Threat:** A malicious pool sends a crafted frame that causes buffer
overflow, panic, or memory exhaustion.

**Mitigation:** `MaxFrameSize` caps any single frame, and the declared
length is checked before the payload buffer is allocated. The fuzz
targets `FuzzDecodeHeader` and `FuzzDecoder_ReadFrame` exist
(`internal/stratum/frame_fuzz_test.go`) and run as seed-corpus tests on
every `go test`. **They do not run as fuzzing in CI** — this section
claimed a nightly fuzz job with automatic crasher reporting, and no such
job exists (§21, corrected session 266). New inputs are explored only
when someone runs `go test -fuzz` by hand.

**Residual risk:** Go panic safety provides strong guarantees, but
a panic in the decode path still terminates the miner (DoS, below).

---

**Threat:** Supply chain: a dependency is replaced with a malicious
version.

**Mitigation:** a deliberately tiny dependency surface — three external
modules are linked (`golang.org/x/crypto`, `golang.org/x/sys`,
`gopkg.in/yaml.v3`) plus the standard library; `go mod verify` passes;
Dependabot is configured for Go modules, Actions and Docker. See ADR-003.

**Corrected session 266:** this section also claimed "All GitHub Actions
pinned by SHA" and "govulncheck runs in CI". **Neither is true.** Every
`uses:` in `.github/workflows/` is a tag or a branch — including
`securego/gosec@master` and `aquasecurity/trivy-action@master`, which are
mutable references of exactly the kind the March 2025 `tj-actions`
compromise abused — and `govulncheck` appears in no workflow. See §21.

**Residual risk:** materially higher than this document previously
implied. A compromised upstream action executes in CI with the workflow's
token; dependency vulnerabilities are found only when a human runs
`govulncheck`; and compromise of the Go toolchain or proxy remains
unmitigated beyond early detection.

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

**Mitigation:** TLS on `stratum+v2tls://` / `stratum+tls://` protects
payload confidentiality and integrity today, which defeats the
*content*-reading attacks (BiteCoin-style share hijacking) from the same
paper. Noise NX would do the same on `stratum+v2://` once it is wired in
and moved to secp256k1 (§2) — until then that scheme has no
confidentiality at all, so on it the paper's content attacks are not
merely a side channel but directly available. The paper's own
countermeasure
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

**Mitigation — intended, and not currently in place.** `install.sh` is
written to download `checksums.txt`, verify the archive's SHA-256 against
it, and (when `cosign` is present) verify a signature over the checksums
file. That script is correct.

**What is missing is the other end.** `release.yml` publishes the
per-platform tarballs and nothing else: no `checksums.txt`, no
`checksums.txt.sig`, no certificate. So the verification path has nothing
to verify against — and because the script treats a failed checksums
download as fatal, the documented one-line install would abort rather
than silently skip verification. Corrected session 266; recorded in §21.
Reproducible builds via `-trimpath` and fixed `-ldflags` are likewise not
what the release workflow does (it passes `-s -w` plus `-X` flags that
name symbols this binary does not have — §13).

**Residual risk:** users cannot verify what they downloaded, and there is
no signing key to steal because nothing is signed. Publishing checksums
is the smallest useful step and needs no key material; keyless Sigstore
signing via GitHub OIDC is the next one.

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
- ADR-002 — Stratum V2 as the exclusive pool protocol
- ADR-003 — Zero runtime dependencies
- `SECURITY.md` — Vulnerability reporting
- [Stratum V2 specification](https://stratumprotocol.org/)
- [Noise Protocol Framework](https://noiseprotocol.org/)
- Recabarren & Carbunar, "Hardening Stratum, the Bitcoin Pool Mining
  Protocol" (arXiv:1703.06545) — basis for the traffic-analysis
  side-channel threat in the Information-disclosure section.
