# ADR-002: Stratum V2 as the exclusive pool protocol

**Status:** Accepted
**Date:** 2026-04-15

## Context

The Bitcoin mining pool protocol landscape in 2026:

- **Stratum V1**: The original protocol from 2012. Plaintext JSON-RPC
  over TCP. No authentication, no integrity, no encryption. Subject
  to hashrate hijacking attacks that can steal earnings transparently.
- **Stratum V2**: Successor protocol with binary framing, Noise
  handshake encryption (ChaCha20-Poly1305), pool authentication via
  static public keys, and optional client-side template construction
  (Job Declaration Protocol).

When Otedama's design began, most existing miners (CGMiner, BFGMiner)
supported only V1. Braiins and a few others supported both. A new
non-custodial miner had to pick.

## Decision

**Otedama speaks Stratum V2 only.** No V1 fallback is provided, either
as a configuration option or as a compatibility shim.

## Consequences

### Positive

- **Hashrate hijacking is structurally impossible** on Otedama
  connections. The Noise NX handshake authenticates the pool to the
  miner via a static pre-shared public key. A MITM cannot silently
  redirect the connection.
- **Plaintext share leakage is impossible.** Every byte on the wire
  is encrypted with ChaCha20-Poly1305.
- **Implementation simplicity.** We write one codec, one handshake,
  one message set. V1+V2 codebases double the surface area.
- **Forward compatibility.** Job Declaration Protocol (future V2
  sub-protocol) enables truly non-custodial template construction:
  miners build blocks themselves, pools only validate and pay.

### Negative

- **Pool selection is narrower.** Only V2-capable pools work:
  Braiins pool, demand.sv2.io, Stratum V2 Reference Implementation
  nodes, and the growing list of V2-upgrading pools. Users cannot
  use a favourite V1-only pool.
- **Onboarding requires a V2-aware pool URL.** `config.yaml.example`
  addresses this by documenting known-good pools.

### Neutral

- **No V1 telemetry.** We do not collect data about V1 usage (we
  refuse to implement it). Competitors that claim "V2 preferred" but
  fall back to V1 silently are more permissive but less secure.

## Alternatives Considered

### V1 + V2 with auto-negotiation

*Rejected.* Any V1 path defeats the whole point: a MITM attacker can
force V1 downgrade. Users believe they have V2 security and do not.

### V1 only with explicit warning

*Rejected.* V1 is 14 years old in 2026 and has known unfixable
vulnerabilities. Otedama's non-custodial stance is meaningless if
the connection is hijackable.

### V2 with planned V1 support in v4

*Rejected.* Committing to V1 support later creates migration debt.
The question is settled once.

## Implementation Notes

- `internal/stratum/` implements the V2 framing, messages, and Noise
  handshake.
- Alpha release uses P-256 in the Noise DH to avoid a secp256k1
  dependency; v3.1.0 switches to secp256k1 + ElligatorSwift per the
  V2 specification.
- `internal/stratum/noise_pool.go` reduces allocation pressure during
  frequent reconnection.

## Erratum (added session 472, supersedes the "no V1" absolute)

Per `docs/adr/README.md`'s immutability rule this is recorded as an
erratum rather than an edit, but the code has since outgrown the
decision's absolute form: **v3.0.0-alpha.1 (import commit `106aebc`)
reintroduced a bounded Stratum V1 dialer** at
`internal/poolproto/stratumv1/`, and the engine dispatches V1 pool URLs
to it (`runSessionV1`; KNOWN_LIMITATIONS records the rollout in
sessions 90-91).

What survives of the original decision:

- **V2 remains the preferred and default protocol** — the built-in
  `DefaultPoolURL` is `stratum+v2://`, docs steer operators to
  V2-capable pools, and every security claim above (Noise NX,
  pool authentication, encrypted shares) still holds for V2
  connections.
- **The threat analysis was not wrong** — V1 is plaintext and
  hijackable. The v3 re-add accepts that consciously: pool coverage
  (the "Negative" consequence — most pools were V1-only) outweighed
  protocol purity for a miner that earns nothing without a pool.
  V1's residual risk is disclosed in KNOWN_LIMITATIONS rather than
  denied.

What is superseded:

- "No V1 fallback is provided, either as a configuration option or as
  a compatibility shim" — a V1 compatibility path exists today,
  confined behind the `poolproto` abstraction so no V1 code leaks
  into the engine or TUI.
- The three "Rejected" alternatives below (V1+V2 negotiation, V1 with
  warning, planned V1 in v4) — the shipped shape is closest to the
  third, arrived at v3.0.0 rather than v4.

## Related

- ADR-001 — Non-custodial wallet model
- Stratum V2 specification: https://stratumprotocol.org/
- Noise Protocol Framework: https://noiseprotocol.org/
