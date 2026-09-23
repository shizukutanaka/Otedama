# ADR-013: Real Akash provider integration — client surface, auth, and scope

- **Status**: Proposed (design for maintainer review — quality-pass queue
  item 5; implementation deliberately not attempted by an autonomous
  session because it introduces network calls and a dependency decision)
- **Date**: 2026-09-23 (session 263)

## Context

`AkashProvider` (`internal/provider/ai_inference.go`) returns a fixed
simulated quote — KNOWN_LIMITATIONS §1. ROADMAP v3.1.0 names "real Akash
REST API" as the target. Four primary-verified facts from the research
log constrain the design more than earlier sessions assumed:

1. **The SDK moved.** `akash-network/akash-api` is deprecated/archived
   (2026-01-05); the successor is `akash-network/chain-sdk` — protobuf
   definitions plus a Go reference client.
2. **Bidding is on-chain, not REST.** The provider daemon's "Bidengine"
   queries open orders on-chain and places bids per the provider's
   on-chain configuration. ADR-010 A4's output is therefore a *bid-price
   policy fed to the provider daemon's config* — Otedama never submits
   a per-order sealed bid over an API. (session 251 fetch of
   `akash-network/provider`)
3. **Provider REST now requires JWT.** AEP-64 (Mainnet 14, 2025-10-28)
   puts token authentication on the provider status/lease surface —
   `GetStatus`/lease calls must mint and attach a JWT.
4. **The read surface is genuinely thin.** Provider REST `/status` +
   `/version`, manifest POST on lease-won, and gRPC
   `akash.provider.v1.ProviderRPC.GetStatus` (per-node GPU model,
   allocatable vs allocated) plus `getLeases(owner,state)` cover
   everything Otedama needs to turn simulated yield into real yield:
   availability, live lease count, and confirmation a routed GPU is
   actually leased.

Constraints already on record: ADR-001 non-custodial (Akash provider
payout is on-chain — fits); ADR-003 zero runtime dependencies (the gRPC
client and chain-sdk both collide — this ADR weighs the options);
CLAUDE.md bars custodial components (Render and io.net were evaluated
and ruled out — centrally-priced/custodial, recorded session 251).

## Options considered

**Option A — vendor `akash-network/chain-sdk` (full client).**
Most future-proof for on-chain write paths (lease queries, eventually
bid-policy introspection), but it pulls a large dependency tree —
gRPC, Cosmos-SDK-adjacent types — squarely against ADR-003's "every
dependency must justify itself" rule for what is, today, a read-only
monitoring need. Cost is front-loaded; benefit is deferred to features
not yet scheduled.

**Option B — generate only the needed protobufs.** Generate
`akash.provider.v1` (GetStatus) and the market/lease query types from
the chain-sdk proto sources, without vendoring the SDK client. Lighter
than A but still requires a gRPC/protobuf toolchain in the build — a
new class of generated code to maintain, again for a read-mostly need.

**Option C — REST `/status`-only client on stdlib (recommended first
step).** `net/http` + `encoding/json` only — zero new dependencies,
fully consistent with ADR-003. Covers the KNOWN_LIMITATIONS §1 core:
real GPU availability + live lease state → real yield signal, plus the
Cat-5 #11 verification that a routed GPU is actually leased before its
yield is counted. JWT per AEP-64 is minted in-process (standard
claims; the signing key path becomes a `provider_akash` config field).
The on-chain write paths are *out of scope by design* — bidding goes
through the provider daemon's Bidengine regardless (fact 2), so no SDK
is needed for the v3.1.0 scope at all.

**Escalator:** if a later milestone needs on-chain reads the REST
gateway does not expose (e.g., direct lease-state queries richer than
`/status`), re-evaluate B against the concrete gap — A remains the
fallback if the needed surface keeps growing.

## Recommendation (maintainer decision)

Option C: `internal/provider/akashrest/` — a stdlib-only client
(`/status`, `/version`, JWT per AEP-64), wired behind the existing
`provider.Provider` interface so the arbitration loop sees a real
`AkashProvider` quote stream unchanged. Simulated provider remains as
the default until the operator supplies `provider_akash.endpoint` +
JWT key material; `(simulated)` name suffix drops only when real calls
succeed (KNOWN_LIMITATIONS §1 contract).

Phasing:

1. **Read-only status/lease client + config** (`provider_akash.endpoint`,
   `provider_akash.jwt_key_file`) — replaces the fixed-quote simulation
   with availability-weighted real yield.
2. **Lease-state gating** — count a routed GPU's yield only while the
   provider reports an active lease (Cat 5 #11); a lost lease raises
   the effective switch cost for that stream (preemption is the
   dominant failure mode — Duan et al., arXiv:2509.11134, report a
   33% eviction reduction from demand-aware reserve).
3. **Bid-policy output (ADR-010 A4)** — emit a bid-price policy file
   for the provider daemon's on-chain config. No API dependency at
   all — pure computation + file output.
4. **Preemption-risk term in the switch-cost ledger** — learned, per
   ADR-010 A2's direction.

**Parallel/alternative track:** Vast.ai (Cat 5 #12) offers a Bearer-token
REST API with a direct-bid market — a simpler second non-simulated
backend fitting the same `provider.Provider` interface, useful as a
live testbed for real preemption. Not mutually exclusive; both plug
into the same quote channel.

**Testing:** Akash testnet endpoints only for integration tests; unit
tests against an in-process `httptest` server. No mainnet keys or
funds are exercised — consistent with the non-custodial stance.

## Consequences

- If accepted: KNOWN_LIMITATIONS §1 gains a concrete implementation
  path; ROADMAP v3.1.0 retargets `akash-api` → REST-gateway-first +
  `chain-sdk` only if the write path later demands it; ADR-010 A4's
  on-chain reframe is confirmed as the bidding model.
- ADR-003 needs no amendment for Option C (zero new dependencies);
  Option B/A adoption would require an explicit ADR-003 exception
  recorded with the justification CLAUDE.md §外部依存 demands.
- The simulated provider is not deleted — it stays as the no-config
  default and for tests, preserving the arbitration-loop test coverage
  that depends on a deterministic quote source.
