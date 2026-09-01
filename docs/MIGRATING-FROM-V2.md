# Migrating from Otedama v2 to v3

Otedama v3.0 is a strategic reset: the product has been redefined from
a multi-algorithm mining pool operator to a non-custodial Stratum V2
compute arbitration client. This document helps v2 users evaluate
whether v3 is right for them and how to migrate if so.

## Should you migrate?

**Yes, if you want to:**

- Mine Bitcoin non-custodially with your hardware.
- Run a small, single-binary miner (no pool operator overhead).
- Speak Stratum V2 to a pool that supports it, with Stratum V1 still
  available for the pools that do not.

**No, if you need any of:**

- Multi-algorithm support (Scrypt, Ethash, RandomX, etc.). v3 is
  SHA-256d only.
- Running a mining pool for others. v3 is a client, not a pool
  operator.
- Custodial accumulation (user A and user B share a balance managed
  by the pool). v3 is single-user by design.
- KYC/AML features. v3 is designed around self-custody.
- GPU work of any kind. v3 detects GPUs on Linux but dispatches no
  compute to them, for mining or anything else.

> **Corrected in session 266.** This list previously offered two reasons
> to migrate that v3 does not deliver: *"benefit from Stratum V2's Noise
> encryption"* — the Noise handshake is implemented but wired into no
> live connection, so a `stratum+v2://` session is plaintext
> (`docs/KNOWN_LIMITATIONS.md` §2); and *"route GPU capacity to AI
> inference when that pays more than mining"* — the AI-inference market
> was a simulated price with no path to income and was deleted in session
> 264 (§1), and GPU compute dispatch does not exist (§4). It also listed
> *"Stratum V1 compatibility"* as a reason **not** to migrate, on the
> grounds that v3 has no V1 fallback. v3 does speak Stratum V1
> (`internal/poolproto/stratumv1`, `stratum+tcp://` and `stratum+tls://`),
> and its V1 mining path was corrected against primary sources in session
> 255 — so that line was steering users away for a reason that was not
> true.

If any of those is a hard requirement, **stay on v2.x**. The
`legacy-v2` branch is maintained for security fixes until October 2026.

## What changed in v3

### Architecture
- **Custody model:** v2 was a pool operator that held balances; v3 is
  a client that routes earnings directly to the user's address.
- **Algorithms:** v2 supported Scrypt, Ethash, RandomX, and others;
  v3 is SHA-256d only.
- **Protocol:** v2 spoke Stratum V1 primarily; v3 is V2-first, with V1
  implemented and supported (`stratum+tcp://`, `stratum+tls://`) because
  the large majority of pools still speak it.

### Operational
- **Binary name:** `otedama` (same).
- **Binary size:** v3 is 14.3 MB as `go build` produces it, 9.8 MB with
  `-ldflags "-s -w"` as the release build uses (measured, linux/amd64,
  Go 1.24.7). The v2 figure is not measured here.
- **Dependencies:** v3 links three external modules — `golang.org/x/crypto`,
  `golang.org/x/sys` and `gopkg.in/yaml.v3`. (This line said two; `x/sys`
  is an indirect dependency that is genuinely linked. `go list -deps
  ./cmd/otedama` is the check.)
- **Config format:** still YAML, but schema completely different.
- **Service installer:** new in v3 (`otedama service install`).

### Security
- **Transport encryption:** use `stratum+v2tls://` or `stratum+tls://`.
  These get real TLS with verification that cannot be disabled. **A
  `stratum+v2://` session is plaintext** — the Noise NX handshake exists
  in `internal/stratum` but no dial site calls it (§2). This line
  previously read "Noise encryption: Stratum V2 handshake on every pool
  connection", which was the opposite of the truth and is the kind of
  claim a migrating user would act on.
- **Wallet:** BIP-39 seed encrypted with scrypt (N=2¹⁷, r=8, p=1) +
  AES-256-GCM, and `otedama wallet verify` lets you confirm your written
  backup actually restores it.
- **CI:** Dependabot is configured. SHA-pinned actions, nightly fuzzing
  and cosign signing are **not** — this line claimed all four (§21).

## Migration procedure

### 1. Back up your v2 state

```bash
tar czf otedama-v2-backup-$(date +%Y%m%d).tar.gz \
    ~/.config/otedama \
    ~/.local/share/otedama
```

Keep this archive until you are sure v3 works for you and your v2
balances (if any) have been withdrawn from the pool.

### 2. Withdraw custodial balances

If you were using v2 as a pool operator or participant with a
custodial balance:

- As an operator: withdraw the pool's reserves per your internal
  policy.
- As a participant: trigger a payout to your own address. v3 will
  never touch these funds.

### 3. Extract your Bitcoin address

v2's config stored the payout address in `~/.config/otedama/pool.toml`
under `[payout]`. Copy the address — you will paste it into v3.

### 4. Install v3

```bash
# Building from source is the reliable path today (see the note below).
git clone https://github.com/shizukutanaka/Otedama.git && cd Otedama && make build

# The installer script, for reference:
curl -sSL https://raw.githubusercontent.com/shizukutanaka/Otedama/main/install.sh | bash
```

> The installer aborts as things stand: it fetches `checksums.txt` to
> verify the download, and the release workflow publishes none (§21).
> `--skip-verify` installs anyway, unverified. Building from source
> avoids the question entirely.

Or download from [releases][releases]. Note that release artefacts are
**not** signed today — `cosign` is not wired into the release workflow
(§21) — so there is no signature to verify; check the published checksums
instead.

[releases]: https://github.com/shizukutanaka/Otedama/releases

### 5. Verify with doctor

```bash
otedama doctor --bitcoin-address bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq
```

Address all failures and warnings before moving on.

### 6. Create a new wallet

v3 uses a fresh wallet file; v2 wallets are not compatible. On first
run with `--wallet-passphrase`, v3 generates a new BIP-39 seed and
prints the mnemonic **exactly once**. Write it down on paper; it is
the only recovery path.

```bash
otedama run \
  --bitcoin-address bc1q... \
  --wallet-passphrase 'strong passphrase' \
  --dry-run
```

If you prefer to skip the Lightning wallet (v3 works without it for
pure mining), omit `--wallet-passphrase`.

### 7. Start mining

```bash
# Interactive (terminal dashboard visible).
otedama run --bitcoin-address bc1q...

# As a background service.
otedama service install
otedama service status
```

### 8. Point monitoring at the new metrics endpoint

v2 exposed metrics at a different URL and schema. v3 uses standard
Prometheus format on `--http-addr host:port`. See `docs/API.md` for
the complete metric list.

## Configuration diff reference

Fields that have been **removed**:

- `algorithms:` — v3 is SHA-256d only.
- `pool_operator:` — v3 is not a pool.
- `[stratum_v1]` — no V1 support.
- `[custody]` — non-custodial only.
- `[kyc]` / `[aml]` — no KYC infrastructure.

Fields that have been **renamed**:

- `payout.address` → `bitcoin_address` (top-level).
- `log.level` → `log_level` (top-level).
- `pool.urls[]` → `pools[].url`.

Fields that are **new**:

- `data_dir:` — for wallet and persistent state (absolute path; `~` is
  not expanded).
- `language:` — startup-log language.
- `pools[]` — failover order is **list position**; there is no
  `priority:` field (this list claimed one).
- `workers:` — a single object with a `name`, not a list. There is no
  per-device worker configuration: Otedama spawns one worker per detected
  SHA256d-capable device automatically, and `name` only affects how the
  miner identifies itself to the pool.

The authoritative schema is §3.1 of `docs/SPECIFICATION.md`, and
`config.yaml.example` is parsed by a test on every run, so it cannot
drift from the decoder.

See `config.yaml.example` in the v3 repository for a fully commented
template.

## Getting help

- Review `docs/TROUBLESHOOTING.md` for common issues.
- Ask in [GitHub Discussions][discussions].
- File a bug via the issue template if you believe v3 misbehaves.

[discussions]: https://github.com/shizukutanaka/Otedama/discussions

## What happens to v2?

- `legacy-v2` branch receives **security fixes only** until 2026-10-24.
- No new features, no compatibility bridges.
- The `v2.x` series is marked End-of-Life on the release page.

If you cannot migrate within six months, contact the maintainer via
GitHub Discussions to coordinate. Known dependency situations (e.g.
embedded systems with long certification cycles) can be accommodated
case by case.
