# ADR-006: Abstract every cryptographic scheme and wire protocol behind interfaces

**Status:** Accepted, amended 2026-08-18 (session 264)

**Date:** 2026-04-27

## Amendment (session 264): the post-quantum scaffolding was removed; the seam was kept

The decision this ADR records — abstract schemes behind interfaces so a
future signature algorithm is a local change — stands unchanged. What was
removed is the *speculative placeholder* built on top of it: the
`AddressP2MR` constant, its `String()` case, and the `SchemeForAddressType`
case returning "not yet implemented".

Two premises below have since been falsified by primary-source research
(session 251) and should be read with that in mind:

- **"Post-quantum signature support (BIP-360 / P2MR) … the realistic
  window is 2028–2032."** BIP-360 is Status: Draft, is titled
  "Pay-to-Merkle-Root (P2MR)", and its own text defers post-quantum
  signatures to a separate proposal that has not been written. BIP-360
  activation would not give the network ML-DSA, so no date can be attached
  to it from here.
- **"Adding P2MR support after BIP-360 activation is a single commit: add
  `case AddressP2MR: return Lookup("mldsa65-sphincs128f")`."** This remains
  true in shape and is the point of the ADR — but it is equally true
  without the placeholder, which is why the placeholder was removable. No
  ML-DSA or SPHINCS+ scheme was ever registered; only the two secp256k1
  stubs are. Nothing could produce `AddressP2MR` either: the bech32 parser
  rejects witness versions 2–16, so the constant was unreachable.

CLAUDE.md prohibits starting quantum-resistance work at this stage, and
scaffolding is starting it in the way that costs most and delivers least.
The seam (`Scheme`, `SchemeForAddressType`) is what makes the future
addition cheap, and it is intact.

## Context

Otedama is designed for a 10-year operational lifespan (2026–2036).
Over that window, three changes to the surrounding ecosystem are
already on the calendar:

1. **The 2028 Bitcoin halving** (block 1,050,000, ≈late March 2028).
   Cuts subsidy from 3.125 to 1.5625 BTC. Drives consolidation among
   miners and stresses pool selection economics.

2. **Post-quantum signature support** (BIP-360 / P2MR). Merged into
   the BIPs repository in February 2026. Activation timing has ±2-year
   uncertainty, but the realistic window is 2028–2032. When it
   activates, Otedama will encounter Bitcoin addresses, transactions,
   and blocks signed under a hybrid scheme combining secp256k1 +
   ML-DSA + SPHINCS+. ML-DSA in Go's standard library is expected in
   Go 1.27 or 1.28.

3. **Stratum V2 maturation**. Today (April 2026), V2 covers ~15–20%
   of network hashrate. The Stratum V2 Reference Implementation
   classifies its protocol crates as **beta** and its role apps as
   **alpha**; there is no production Go implementation. By 2030 V2
   is plausibly dominant but the Job Declaration Protocol may have
   evolved further. Pools may also adopt incompatible variations
   (OCEAN's DATUM is the precedent).

The naive way for Otedama to handle these is to write secp256k1 calls
directly, write Stratum V2 message parsers directly, and rewrite when
the world changes. We've seen what happens to Bitcoin tools that took
that path: most of them died between 2018 and 2024 because the
maintenance burden of every transition compounded.

## Decision

**Otedama puts every signature scheme and every wire protocol behind
a Go interface.**

Specifically:

### Cryptography

- A new package, `internal/btccrypto/`, defines `Scheme` and
  `SignerScheme` interfaces. ECDSA-secp256k1 and Schnorr-secp256k1
  are concrete implementations registered at init time. ML-DSA and
  SPHINCS+ are reserved namespace entries that return
  `ErrSchemeNotImplemented` until the Bitcoin protocol activates
  them and Go's stdlib ships the primitives.
- Address-type-to-scheme dispatch lives in `SchemeForAddressType()`.
  Adding P2MR support after BIP-360 activation is a single commit:
  add `case AddressP2MR: return Lookup("mldsa65-sphincs128f")`.
- All signing/verifying call sites in the rest of the codebase use
  the interface, never concrete types from `decred/dcrd/dcrec/`.

### Transport protocols

- Stratum V1 ships first, because >99% of pools speak it today and
  translation proxies will keep it operational throughout the 10-year
  window.
- Stratum V2 lives behind the same `Pool` interface, in a separate
  build path. Otedama can speak both depending on URL scheme; it
  never mixes them on the same connection.
- The Job Declaration Protocol is deferred until at least three major
  pools support it in production. JDP is conceptually appealing but
  practically unfinished as of mid-2026.

### Hash construction

- `Hash256` (double-SHA256) and `TaggedHash` (BIP-340) live in
  `internal/btccrypto/`. Bitcoin's hashing conventions are stable,
  but having them in one place means a future migration to e.g.
  SHA-3 (extremely unlikely but not impossible) is a one-file change.

## Consequences

### Positive

- **The 2028–2032 PQ migration is prepared for.** When ML-DSA arrives
  in Go's stdlib and BIP-360 activates, Otedama's change is: register
  the new scheme, flip one case in `SchemeForAddressType`, run the
  test suite. No call-site changes anywhere else.
- **Stratum V1 → V2 transition is gradual.** Users on V1-only pools
  keep working; users on V2 pools get the security upgrade. The
  switch is per-connection, not per-binary.
- **OCEAN's DATUM and any future protocol fragmentation can be
  added** without reorganising the codebase.
- **Test coverage of the interface boundary is sustainable.** Each
  scheme has its own test file with its own test vectors; the
  interface tests (registry, dispatch, error handling) are scheme-
  independent.

### Negative

- **One layer of indirection on every signature operation.** This
  is not free, but signatures are not Otedama's hot path — SHA-256d
  hashing is, and that goes through `internal/miner/sha256d.go`
  directly without abstraction. Profile data confirms the
  cost is below 0.1% of CPU time.
- **The interface set must be designed for the future, not just the
  present.** ML-DSA signatures are ~3 KB; if our `Signature` interface
  had assumed ≤80-byte signatures (a reasonable choice in 2026 for
  ECDSA + Schnorr), we'd have to rewrite it. We've sized things to
  cover known schemes plus a generous margin.

### Neutral

- **The abstraction does not aim for cryptographic agility in TLS's
  sense.** Otedama does not negotiate signature algorithms over the
  wire; the choice is determined by the address type, which is
  determined by the user's wallet. This is simpler than TLS's
  cipher-suite negotiation and avoids downgrade attacks.

## Alternatives Considered

### Just write secp256k1 calls inline

*Rejected.* See "Context" — every Bitcoin tool that took this path
either died or had to be rewritten.

### Use `btcsuite/btcd/btcec/v2` directly without a wrapper

*Rejected.* `btcec` is excellent and is what `btccrypto` will likely
delegate to internally for secp256k1, but binding our call sites to
its concrete types would defeat the abstraction. Wrap, don't depend.

### Ship a generic "BitcoinAddress" type that handles all variants

*Considered, partially adopted.* Address parsing absolutely benefits
from a single entry point. But the *signature* dispatch is a
separate concern; we've done both.

### Plan to rewrite when the time comes

*Rejected.* This is what most projects do. It works only if the
project has a budget for "stop and rewrite" episodes. Otedama is
solo-maintained at ~10 hours per week; we don't have that budget.

## When this ADR will need to change

- When the first ML-DSA or SPHINCS+ scheme is registered, a follow-up
  ADR describes the implementation choices (constant-time guarantees,
  side-channel posture, hybrid-mode policy).
- When Job Declaration Protocol is implemented, it gets its own ADR.
- If the cost of the abstraction ever shows up in profile data above
  1% of total CPU, this ADR is revisited and we may inline the hot
  paths while keeping the cold ones abstract.

## Erratum (added session 248, does not alter the accepted decision)

Per `docs/adr/README.md`'s immutability rule, this ADR's original text
is left unchanged, but one factual claim in it has since proven
inaccurate and needs a pointer to the correction rather than a silent
edit: the Cryptography subsection above says "ECDSA-secp256k1 and
Schnorr-secp256k1 are concrete implementations registered at init
time." As of this writing they are **namespace-reserving stubs**
(`internal/btccrypto/secp256k1.go`) whose `Verify`,
`PublicKeyFromBytes`, and `SignatureFromBytes` all return
`ErrSchemeNotImplemented` — the real secp256k1 dependency ADR-011
decided on (`decred/dcrd/dcrec/secp256k1/v4`) has not yet been added
to `go.mod`. Current state is tracked in
`docs/KNOWN_LIMITATIONS.md` §5. Note this has zero production impact
today: no call site in the codebase invokes `Lookup`,
`SchemeForAddressType`, `Verify`, or `Sign` yet (`internal/doctor` and
`internal/config` only use the address-classification helpers,
`ValidateAddress`/`ClassifyAddress`, which do not touch the stub
schemes) — the stub exists purely as forward-compatible scaffolding
for signing functionality (e.g. Lightning payout authorization) that
does not exist yet either.

## Related

- ADR-001 — Non-custodial wallet model (depends on this for future
  PQ wallet support)
- ADR-002 — Stratum V2 as the exclusive pool protocol (this ADR
  partially supersedes by allowing V1 + V2 + future variants)
- ADR-003 — Zero runtime dependencies (this ADR justifies the
  internal interfaces because we cannot swap external libraries)
- `internal/btccrypto/` — Implementation
- The 10-year sustainability research (April 2026, `docs/research/`)
  that motivated this restructuring
