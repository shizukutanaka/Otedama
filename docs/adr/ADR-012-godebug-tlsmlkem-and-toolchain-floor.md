# ADR-012: `tlsmlkem=1` godebug pin and the effective toolchain floor

- **Status**: Proposed (decision material for the maintainer — see
  `skills/quality-pass-opus.md` queue item 3; deliberately not settled
  by an autonomous session)
- **Date**: 2026-09-23 (session 261)

## Context

`go.mod` carries a `godebug` block with four pins. Two of them set a
parse-time floor:

| Pin | Knob introduced | Parse floor it imposes |
|-----|-----------------|------------------------|
| `tlsmlkem=1` | Go 1.24 (renamed from `tlskyber` when X25519MLKEM768 standardized) | ≥ Go 1.24 |
| `containermaxprocs=1` | Go 1.25 | ≥ Go 1.25 |
| `panicnil=0` | Go 1.21 | ≥ Go 1.21 |
| `randautoseed=1` | Go 1.20 | ≥ Go 1.20 |

Together with `toolchain go1.25.7`, the module's *effective* floor is
Go 1.25: any toolchain older than 1.24 fails at `go.mod` parse with
`unknown godebug "tlsmlkem"`, and any toolchain older than 1.25 fails
on `containermaxprocs` and the `toolchain` directive.

`GODEBUG_NOTES.md` still states the `go`/`toolchain` split exists so
that "older toolchains can still build Otedama." That intent is no
longer achievable — KNOWN_LIMITATIONS §13 records the tension — and CI
pinned to Go ≤1.23 + `GOTOOLCHAIN=local` fails before compiling (the
primary cause of today's red CI).

The security-relevant question is narrow: `tlsmlkem=1` enables the
hybrid X25519MLKEM768 key exchange in TLS handshakes. It is already the
default for Go ≥1.24 builds, so the pin's *behavioral* effect on
current toolchains is nil; its only live effects are (a) the parse-time
floor and (b) pinning the knob's documented intent against a future
upstream default flip.

## Options considered

**Option A — keep `tlsmlkem=1`, correct the documentation.**
The floor already moved to Go 1.25 deliberately at session 256 (the
`toolchain go1.25.7` + `containermaxprocs=1` pins made container-aware
GOMAXPROCS actually compile — load-bearing for CPU-mining throttling
under cgroup limits). Keeping the PQ-TLS pin preserves explicitness:
the module declares, in-file, that post-quantum TLS key exchange is
wanted, which both documents intent and guards against any future
upstream default reversal. `GODEBUG_NOTES.md`'s "older toolchains can
still build" sentence is corrected to state the real floor.

**Option B — relax `tlsmlkem=1` alone.**
Removing the pin drops the godebug floor from 1.24 to 1.25 — a
*strictly worse* floor, not better, since `containermaxprocs=1` and
`toolchain go1.25.7` still require 1.25. It buys nothing for the
"older toolchains" intent while losing the documented security
preference. Rejected as costless-but-useless.

**Option C — restore the old-toolchain floor for real.**
Would require removing `tlsmlkem=1` *and* `containermaxprocs=1` *and*
lowering `toolchain` to ≤1.23 — i.e., re-losing cgroup-aware
GOMAXPROCS (CPU miners would oversubscribe under container CPU limits;
the session-256 regression risk) and re-allowing silently-older
defaults for the knobs Otedama wants pinned. It would also conflict
with `x/crypto`'s own floor (v0.49+ declares `go 1.25`). Rejected:
trades a real runtime property for a build-time convenience CI can
already get another way (pin workflows to 1.25.x or drop
`GOTOOLCHAIN=local`).

## Recommendation (maintainer decision)

Option A — keep the pin; fix the stale documentation sentence.
The pin is honest about the security preference and the floor it sets
is already superseded by the intentionally-chosen 1.25 floor. The
docs, not the pin, were wrong.

If the maintainer prefers Option C, the *whole* floor needs
restating — `toolchain`, `containermaxprocs`, `tlsmlkem`, and the
`go` directive move together — and the lost cgroup-aware
GOMAXPROCS behavior needs an explicit sign-off, because it silently
degrades CPU-mining under container limits.

## Consequences

- If Option A is accepted: `GODEBUG_NOTES.md` sentence corrected in
  this PR already states the real floor; no code change follows.
- If Option C is accepted: a follow-up PR removes the three pins,
  lowers `toolchain`/`go`, and must document the container GOMAXPROCS
  regression as accepted.
- Either way, CI remains red until the workflows' Go versions are
  raised to 1.25.x (or `GOTOOLCHAIN=local` removed) — `.github/workflows`
  is outside the GitHub App push scope, so that is a maintainer-side
  change regardless of this decision (KNOWN_LIMITATIONS §13).
