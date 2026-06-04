# ADR-001: Non-custodial wallet model

**Status:** Accepted
**Date:** 2026-04-15

## Context

The entire mining software landscape fell into two camps when Otedama
was designed:

1. **Pool-custodial:** The user provides their address to the pool;
   the pool accumulates earnings and pays out periodically. Examples:
   every traditional pool.
2. **Platform-custodial:** A middleware platform holds user earnings
   in its own wallet and pays out on a schedule. Example: NiceHash,
   which famously lost **$62M of user funds in December 2017** when
   its hot wallet was compromised.

Both models share a failure mode: at some point between hash submission
and the user's Bitcoin address, someone else holds the money.

Otedama's users are individuals, often running on home hardware.
Requiring them to trust any third party with money they have not yet
received is a non-starter. A single compromise of that third party
ruins everyone simultaneously.

## Decision

**Otedama never holds user funds.** The product:

1. Generates a Lightning-compatible BIP-39 seed locally on first run.
2. Encrypts the seed on disk with a passphrase the user chooses.
3. Configures all mining to pay directly to the user's Bitcoin address.
4. Uses Stratum V2 pools that support non-custodial payouts
   (Braiins pool, demand.sv2.io, etc.).
5. Never transmits the seed, encrypted or plaintext, to any server.

The Lightning wallet is only for *receiving* small-value AI-inference
earnings (from providers like Akash) on-chain, not for pool payouts.

## Consequences

### Positive

- **No single point of failure on Otedama's side.** Compromising
  Otedama's code or updates cannot steal user funds, because Otedama
  never has them.
- **Legal simplicity.** Otedama is software, not a money services
  business. No money transmission license required.
- **User alignment.** Users know their earnings go directly to their
  wallet. No "when does the pool pay?" anxiety.
- **Regulatory resilience.** Future regulation of custodial mining
  services does not affect Otedama's users.

### Negative

- **Onboarding friction.** Users must understand Bitcoin addresses
  before they can mine. We mitigate this with `otedama doctor`
  validating the address format before any mining starts.
- **No aggregation.** Users with hashrate below a single share's
  worth earn nothing (vs. custodial pools where tiny amounts
  accumulate). This is acceptable because our target hardware
  (GPU, modern CPU) always exceeds the threshold.
- **Pool selection is narrower.** Not all pools support Stratum V2
  non-custodial payouts. See ADR-002.

### Neutral

- **Seed loss = fund loss.** If the user loses the passphrase or
  wallet file, funds mined to that seed are unrecoverable. This is
  inherent to self-custody and not specific to Otedama. `otedama run`
  prints the mnemonic exactly once on first run; we do not attempt
  to re-display it because doing so would weaken the custody story.

## Alternatives Considered

### Pool-custodial with optional self-custody

*Rejected.* Adding a custodial code path adds attack surface that
benefits only users who do not understand the tradeoff. Users who
understand self-custody are better served by a tool that does not
offer the option to hold their funds.

### Custom pool with our own payout logic

*Rejected.* Running a mining pool is a business, not a software
project. Operating one would commit us to 24/7 uptime, KYC/AML
compliance in some jurisdictions, and responsibility for funds we
have no way to recover if our infrastructure is compromised.

### Multisig vaults

*Rejected for v3.* Valuable long-term, but requires a trusted second
party (or a friend of the user) at some point. The added complexity
does not benefit solo home miners, which is our target audience.

## Related

- ADR-002 — Stratum V2 as the exclusive pool protocol
- SECURITY.md — Threat model details
- `internal/lightning/wallet.go` — Seed encryption implementation
- `internal/doctor/` — Bitcoin address validation
