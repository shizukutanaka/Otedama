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

## Errata

**Erratum 1 (session 1236, recorded 2026-10):** The headline decision —
"No V1 fallback is provided" — predates the shipped V1 dialer. Since
v3.0.0-alpha.1, `internal/poolproto/stratumv1/` implements Stratum V1
(JSON-RPC over TCP/TLS) and `poolproto.DialURL` accepts `stratum+tcp://`
and `stratum+ssl://` URLs alongside `stratum+v2://`. Otedama is
therefore **V2-preference, not V2-only**: V2 remains the designed-for
protocol and the only one with miner-sovereignty properties, but V1
sessions work for pools that lack V2. The security rationale in this
ADR (V1 downgrade risk, plaintext share submission) still stands and is
documented in `docs/KNOWN_LIMITATIONS.md` — V1 connections remain the
user's explicit choice via the configured URL scheme, never an
automatic downgrade. ADR-009's positioning note already records this
erratum's substance from the integration side.

**Erratum 2 (session 2693, recorded 2026-10):** "demand.sv2.io" in the
Negative-consequences pool list does not resolve — `sv2.io` and
`demand.sv2.io` are both NXDOMAIN today (the pool the text means is
**DMND**, which operates under the `dmnd.work` domain). Per the
project's no-phantom-URLs rule this is recorded as naming drift; the
V2-capable-pool list it appears in remains directionally right
(Braiins Pool, DMND, SRI nodes are all real and V2-capable).

The same sweep found the other example hostnames were dead too —
`public.stratum.slushpool.com` (config.yaml.example, docs/API.md) and
`demand.fun` (config.yaml.example's commented failover line) were also
NXDOMAIN. Those are corrected in place: `stratum+v2://
stratum.braiins.com:3336` is the documented Braiins Pool V2 endpoint
(Braiins Academy: stratum2+tcp defaults to :3336; the port accepts TCP
today and does not speak TLS, so the scheme is `stratum+v2://`, not
`stratum+v2tls://`).

## Related

- ADR-001 — Non-custodial wallet model
- Stratum V2 specification: https://stratumprotocol.org/
- Noise Protocol Framework: https://noiseprotocol.org/
