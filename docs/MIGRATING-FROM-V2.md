# Migrating from Otedama v2 to v3

Otedama v3.0 is a strategic reset: the product has been redefined from
a multi-algorithm mining pool operator to a non-custodial Stratum V2
compute arbitration client. This document helps v2 users evaluate
whether v3 is right for them and how to migrate if so.

## Should you migrate?

**Yes, if you want to:**

- Mine Bitcoin non-custodially with your hardware.
- Benefit from Stratum V2's Noise encryption and hashrate-hijack
  resistance.
- Route GPU capacity to AI inference when that pays more than mining.
- Run a small, single-binary miner (no pool operator overhead).

**No, if you need any of:**

- Multi-algorithm support (Scrypt, Ethash, RandomX, etc.). v3 is
  SHA-256d only.
- Running a mining pool for others. v3 is a client, not a pool
  operator.
- Custodial accumulation (user A and user B share a balance managed
  by the pool). v3 is single-user by design.
- Stratum V1 compatibility. v3 has no V1 fallback.
- KYC/AML features. v3 is designed around self-custody.

If any of those is a hard requirement, **stay on v2.x**. The
`legacy-v2` branch is maintained for security fixes until October 2026.

## What changed in v3

### Architecture
- **Custody model:** v2 was a pool operator that held balances; v3 is
  a client that routes earnings directly to the user's address.
- **Algorithms:** v2 supported Scrypt, Ethash, RandomX, and others;
  v3 is SHA-256d only.
- **Protocol:** v2 spoke Stratum V1 primarily; v3 is V2-only.

### Operational
- **Binary name:** `otedama` (same).
- **Binary size:** v2 ~65 MB → v3 ~15 MB (distroless).
- **Dependencies:** v2 had ~50 Go modules; v3 has 2 (`x/crypto`, `yaml.v3`).
- **Config format:** still YAML, but schema completely different.
- **Service installer:** new in v3 (`otedama service install`).

### Security
- **Noise encryption:** Stratum V2 handshake on every pool connection.
- **Wallet:** BIP-39 seed encrypted with scrypt + AES-256-GCM.
- **CI:** SHA-pinned GitHub Actions, Dependabot, nightly fuzz, cosign
  signing.

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
curl -sSL https://github.com/shizukutanaka/Otedama/releases/latest/download/install.sh | bash
```

Or download from [releases][releases] and verify the signature.

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

- `data_dir:` — for wallet and persistent state.
- `language:` — UI language, BCP 47.
- `pools[].priority:` — failover order.
- `workers[]:` — per-device worker configuration.

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
