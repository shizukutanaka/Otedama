# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for Otedama.
Each ADR documents a significant design decision, the context at the time
the decision was made, and the consequences.

## Why ADRs?

Code shows *what* a system does. Comments show *how*. ADRs show *why*.

When someone asks "why is Otedama non-custodial?" or "why use P-256 in
alpha instead of secp256k1?", the answer should not require archaeology
through Git history or asking the maintainer. It should be one click away.

## Format

Each ADR follows the [Michael Nygard template][nygard]:

- **Title**: short declarative sentence ("001: Use Stratum V2 as
  exclusive pool protocol")
- **Status**: `Proposed`, `Accepted`, `Deprecated`, `Superseded by ADR-NNN`
- **Context**: what was going on when the decision was needed
- **Decision**: what was decided
- **Consequences**: what follows from the decision, positive and negative

Once an ADR is accepted, it is immutable. If circumstances change, write
a new ADR that supersedes the old one; do not edit the old one.

[nygard]: https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [001](ADR-001-non-custodial-wallet.md) | Non-custodial wallet model | Accepted |
| [002](ADR-002-stratum-v2-only.md) | Stratum V2 as the exclusive pool protocol | Accepted (partially superseded by ADR-006) |
| [003](ADR-003-zero-runtime-dependencies.md) | Zero runtime dependencies beyond stdlib + x/crypto + yaml | Accepted |
| [004](ADR-004-terminal-ui-custom-ansi.md) | Custom ANSI TUI instead of BubbleTea | Accepted |
| [005](ADR-005-prometheus-format-no-client.md) | Prometheus exposition without the official client library | Accepted |
| [006](ADR-006-protocol-abstraction.md) | Abstract every cryptographic scheme and wire protocol behind interfaces | Accepted |
| [007](ADR-007-lightning-capability-expansion.md) | Lightning capability expansion (BOLT12, external/embedded node, swaps) | Accepted |
| [008](ADR-008-hardware-power-awareness-layer.md) | Hardware & power-awareness layer (DVFS, tariffs, solar) | Accepted |
| [009](ADR-009-pool-decentralization-integration.md) | Pool-decentralisation integration (JDC, DATUM, solo) | Accepted |
| [010](ADR-010-arbitration-engine-evolution.md) | Arbitration-engine evolution (forecasting, bandits, change detection) | Accepted |
| [011](ADR-011-secp256k1-for-stratum-v2-noise.md) | secp256k1 for the Stratum V2 Noise handshake (4th dependency) | Accepted |
