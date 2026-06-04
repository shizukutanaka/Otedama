# ADR-011: secp256k1 for the Stratum V2 Noise handshake

- **Status:** Accepted
- **Date:** 2026-06-02
- **Supersedes:** the P-256 stub decision implicit in the v3.0.0-alpha
  Noise NX implementation (see KNOWN_LIMITATIONS §2)
- **Relates to:** ADR-002 (Stratum V2 only), ADR-003 (zero runtime
  dependencies)

## Context

Otedama's Stratum V2 transport encryption uses the Noise NX pattern.
The Stratum V2 specification mandates **secp256k1** Diffie-Hellman with
**ElligatorSwift** public-key encoding for the handshake. The
v3.0.0-alpha implementation stubs this with NIST **P-256** (available
via `golang.org/x/crypto/ecdh`), which satisfies the same Go interface
but is **not wire-compatible** with a real Stratum V2 server's
encrypted channel (KNOWN_LIMITATIONS §2). As a result the encrypted
transport cannot interoperate with production V2 pools; only plaintext
V2 and V1 work today.

To ship a real encrypted V2 channel we need secp256k1 ECDH (and,
subsequently, ElligatorSwift). The Go standard library does **not**
provide secp256k1, and neither does `golang.org/x/crypto`. This forces
a decision that touches ADR-003 (zero runtime dependencies): we either
take a new dependency or implement the curve ourselves.

ADR-003 permits exactly three runtime dependencies (`x/crypto`,
`yaml.v3`, stdlib) and requires that any addition "removes ongoing
maintenance burden" rather than merely saving initial effort. A
hand-rolled secp256k1 is precisely the kind of high-stakes,
easy-to-get-subtly-wrong cryptographic code where owning every line is
a *liability*, not an asset (CLAUDE.md I7: AI-generated code carries an
elevated logic-error rate, and auth/crypto code must be held to a
higher bar).

## Options considered

### Option A — Adopt `github.com/decred/dcrd/dcrec/secp256k1/v4`

The canonical pure-Go secp256k1 implementation.

- **Pros:** Pure Go, no cgo, no transitive runtime dependencies. ISC
  licence (permissive, copyfree, GPL/MIT/Apache-compatible). Used by
  150+ public modules including btcd/lnd-adjacent tooling; battle-tested
  on mainnet value for years. Constant-time field arithmetic. Provides
  ECDH and Schnorr. Maintained by the Decred project (active, security-
  conscious).
- **Cons:** A fourth runtime dependency, against the letter of ADR-003.
  We do not control its release cadence.

### Option B — Implement secp256k1 ourselves

- **Pros:** Keeps the three-dependency rule intact. Full code ownership.
- **Cons:** secp256k1 done safely requires constant-time field
  arithmetic, correct point validation (to avoid invalid-curve and
  small-subgroup attacks), and ElligatorSwift — hundreds of lines of
  the most security-sensitive code in the project. A subtle bug
  (non-constant-time inversion, missing point-on-curve check) can leak
  the private key or enable a downgrade. This is the *opposite* of the
  ADR-003 intent: the rule exists to reduce the cost of a compromise,
  and a DIY curve *raises* it. CLAUDE.md I7 says auth/crypto code needs
  manual verification we are not positioned to provide at audit grade.
  **Rejected** as the highest-risk option.

### Option C — Keep the P-256 stub indefinitely

- **Pros:** No new code, no new dependency.
- **Cons:** The encrypted V2 channel never interoperates with real
  pools — a permanent, user-facing protocol-compliance gap that
  contradicts ADR-002 (Stratum V2 as the exclusive, *real* pool
  protocol). **Rejected:** it forecloses the product's core transport.

## Decision

**Adopt Option A:** add `github.com/decred/dcrd/dcrec/secp256k1/v4` as
the **fourth** permitted runtime dependency, scoped strictly to the
Stratum V2 Noise handshake (and any future Schnorr needs that the same
package already covers).

This is consistent with the *spirit* of ADR-003 even though it adds a
dependency, because:

1. **It removes ongoing maintenance burden of exactly the kind ADR-003
   wants us to avoid.** A correct, constant-time, audited secp256k1 is
   maintenance we are not equipped to carry safely; delegating it to the
   canonical implementation *reduces* our risk surface rather than
   expanding it. This is the documented exception in ADR-003
   ("…unless the dependency removes ongoing maintenance burden").
2. **It is pure Go with no transitive runtime dependencies**, so the
   supply-chain blast radius is one well-known, widely-vetted module —
   not a tree.
3. **The alternative (DIY crypto) is strictly worse** for the wallet-
   security threat model that motivated ADR-003 in the first place.

ADR-003 will be annotated to record this as a deliberate, scoped fourth
dependency rather than an erosion of the policy.

## Consequences

### Positive
- Real, spec-compliant Stratum V2 encrypted transport becomes possible
  (closes KNOWN_LIMITATIONS §2).
- secp256k1 Schnorr is then available in-tree should later features
  (e.g. taproot payout descriptors) want it.

### Negative
- Dependency count goes from 3 to 4; ADR-003's headline number changes.
- Binary size grows modestly (pure-Go field arithmetic, tens of KB).

### Mitigations (supply-chain, per THREAT_MODEL)
- Pin the exact version in `go.mod` and commit `go.sum`; rely on Go
  module checksum verification and the checksum DB.
- Run `govulncheck` in CI against the new dependency (already in the
  pipeline).
- Vendor the dependency if upstream availability ever becomes a concern;
  the ISC licence permits this.
- Document the dependency and its rationale in THREAT_MODEL's
  dependency-assumptions section.

## Follow-up work (implementation, not part of this decision)
1. Replace the P-256 ECDH in `internal/stratum/noise.go` with secp256k1
   ECDH from the new package.
2. Implement ElligatorSwift public-key encoding for the NX handshake.
3. Remove KNOWN_LIMITATIONS §2 once the encrypted channel interoperates
   with a real V2 pool in a live test.
4. Update ADR-003's dependency list and THREAT_MODEL assumptions in the
   same change that adds the import.
