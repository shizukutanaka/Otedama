# GODEBUG Notes

This file tracks every Go GODEBUG setting Otedama depends on. The Go
team guarantees a GODEBUG knob will remain functional for at least
two years after the corresponding behavior change, and most knobs
remain indefinitely. Tracking them explicitly lets Otedama survive
a decade of Go releases without surprise breakage.

## How GODEBUG works (refresher)

Starting in Go 1.21, when the standard library or runtime makes a
behavior change that could break existing code, the team ships a
GODEBUG knob (e.g. `GODEBUG=httpcookiemaxnum=0`) that restores the
prior behavior. The default is whichever behavior matches the
compiled-in `go` directive in `go.mod`:

- If `go.mod` says `go 1.21`, code built today gets pre-1.22
  defaults even on a Go 1.30 toolchain.
- If `go.mod` says `go 1.30`, code gets the new behavior.

A `//go:debug` comment at the top of `main` files, or a `godebug`
directive in `go.mod`, can override individual knobs at the module
level. This is preferable to relying on environment variables at
runtime because it is reproducible across operators.

References:
- https://go.dev/doc/godebug
- https://pkg.go.dev/internal/godebugs (canonical list)

## Otedama's `go.mod` baseline

```
go 1.22
toolchain go1.24.0

godebug (
    panicnil=0
    randautoseed=1
    tlsmlkem=1
)
```

**Why split `go` from `toolchain`:** the `go 1.22` directive declares
the **language semantics** Otedama's source assumes, while
`toolchain go1.24.0` is the **build toolchain** used in CI and
recommended for users. This split lets users with older toolchains
(Linux distros, NixOS pinning) still build Otedama, while CI gets
the latest crypto and runtime fixes.

The `go` line is bumped roughly once a year, six months after each
Go minor's release, on a dedicated PR. The `toolchain` line is
bumped quarterly to track the latest stable Go.

## Active knobs

As of 2026-04-30:

- **`tlsmlkem=1`** — explicitly enable hybrid post-quantum TLS key
  exchange (X25519MLKEM768) for outbound connections to price feeds.
  Default on Go 1.24+, but pinning here makes the choice visible to
  downstream reviewers and survives future default flips. This knob
  was named `tlskyber` on the Go 1.23 draft (X25519Kyber768) and was
  renamed `tlsmlkem` in Go 1.24 when the construction was
  standardized; our `toolchain go1.24.0` therefore requires the new
  name (the old name is an "unknown godebug" build error on 1.24).

- **`panicnil=0`** — keep Go 1.21+'s behavior of `recover()` returning
  a synthetic non-nil error from `panic(nil)`, rather than reverting
  to the pre-1.21 "recover() sees nil" behavior. Otedama's own code
  never calls `panic(nil)`, and no known transitive dependency does
  either, so this pin has no observable effect today — it is set
  explicitly so a future dependency change cannot silently flip our
  effective behavior on a `go` directive bump.

- **`randautoseed=1`** — keep Go 1.20+'s auto-seeding of `math/rand`
  from a cryptographically random source (rather than the historical
  fixed seed 1). Otedama does not rely on `math/rand`'s determinism
  for anything security-relevant (`crypto/rand` is used there;
  `math/rand/v2` only for non-security uses), so this pin also has no
  observable effect today — same visibility rationale as `panicnil`.

## Knobs we may need in the next 10 years

### `gocachetest` — affects `go test -count`

Go 1.24 changed `go test` caching to consider build flags more
strictly. We have not seen breakage but if a CI run exhibits
spurious cache misses on `go test -count=N`, this knob can pin the
old behavior.

- Added: Go 1.24 (Feb 2025).
- Otedama impact: none observed.
- Removal risk: medium-term (likely Go 1.28+).

### `tlsmlkem` (was `tlskyber`) — hybrid post-quantum TLS key exchange

Go 1.23 added a draft hybrid key exchange (X25519Kyber768) behind
`tlskyber`; Go 1.24 standardized it as X25519MLKEM768 and **renamed
the knob to `tlsmlkem`**, removing `tlskyber`. Both default on. If a
pinned remote endpoint cannot tolerate the larger ClientHello, set
`tlsmlkem=0`. We do not control any pool servers, so we keep this
on the default (`1`).

- Added: Go 1.23 (Aug 2024) as `tlskyber`; renamed `tlsmlkem` in
  Go 1.24 (Feb 2025). On the `go1.24.0` toolchain only `tlsmlkem`
  is recognized — `tlskyber` is a hard "unknown godebug" error.
- Otedama impact: outbound TLS to Coinbase / Kraken / CoinGecko
  for price feeds. All three handle hybrid PQ ClientHello correctly
  as of late 2025.
- Removal risk: low — the team commits to keeping this for years
  given the quantum-readiness purpose.

### `httplaxcontentlength` — accept content-length with leading spaces

Go 1.24 tightened HTTP parsing. If a price feed returns a
non-conformant `Content-Length` header, we may need
`httplaxcontentlength=1`. Set in `go.mod`, not env, so users do
not need to know.

- Added: Go 1.24.
- Otedama impact: theoretical only.
- Removal risk: medium-term (Go 1.27+).

### `containermaxprocs` — `GOMAXPROCS` from container limits

Go 1.25 introduced container-aware `GOMAXPROCS` defaults so that
Otedama running in Kubernetes with `cpu: 2` no longer schedules
NumCPU goroutines for the host's 64 cores. We rely on this for
correct CPU mining throttling under cgroup constraints.

- Added: Go 1.25 (Aug 2025).
- Otedama impact: positive — fixes a class of "miner saturates
  noisy-neighbor pod limit" reports we expect from Kubernetes
  users.
- Removal risk: very low — this is a fix, not a deprecation. The
  knob to revert (`containermaxprocs=0`) will exist for years.

### `winreadlinkvolume` — Windows symlink target paths

Go 1.23 changed how `os.Readlink` reports drive paths on Windows.
We do not currently use symlinks on Windows; if a future feature
does, document the knob here.

- Added: Go 1.23.
- Otedama impact: none.
- Removal risk: low.

### `fips140` — FIPS 140-3 compliance mode

Go 1.24 introduced `fips140=on` which restricts crypto algorithms
to the validated subset. Otedama's Stratum V2 Noise NX transport
(`internal/stratum/noise.go`) uses ChaCha20-Poly1305 (not FIPS-
listed); enabling FIPS would break it. (The wallet's own encryption,
`internal/lightning/seedstore.go`, uses AES-256-GCM, which *is*
FIPS-140 validated — this knob is about the Noise transport, not
wallet-at-rest encryption.) **Do not enable.** Document for users
who ask: Otedama is not FIPS-compliant by design — see
`docs/THREAT_MODEL.md` for the rationale.

- Added: Go 1.24.
- Otedama impact: opting in would break us.
- Removal risk: zero — FIPS is permanent.

## Process for adding a knob

1. Reproduce the breakage in a small test, including the exact Go
   minor version that introduced it.
2. Open an issue with title `godebug: pin <knob>=<value>` documenting
   the breakage and the upstream Go release notes link.
3. Add the knob to `go.mod`'s `godebug` block.
4. Update this file with the same template as the entries above.
5. In the same PR or a follow-up, write a test that fails without
   the knob, so future maintainers know when it can be removed.
6. After the upstream Go team announces removal of the corresponding
   compatibility shim, schedule a cleanup PR for the major Otedama
   release at least 6 months before the Go removal date.

## Process for upgrading the `go` directive

The `go` directive in `go.mod` is bumped twice a year, roughly six
months after each Go minor release. The procedure:

1. Run all tests on a Go N version 6+ months after release (e.g. wait
   until Go 1.27.6 before adopting `go 1.27`).
2. Read the release notes' "Compatibility" section for new GODEBUG
   knobs.
3. Run `go vet ./...` and `staticcheck ./...` on the new version.
4. Bump the directive in a dedicated PR titled `chore: bump go directive
   to 1.27`.
5. Add any newly-relevant knobs to this file before merging.

This means Otedama's `go` directive lags the latest Go release by
6–12 months. That is intentional — it gives the ecosystem time to
fix bugs and gives downstream Linux distros time to ship the new
toolchain.

## Annual review

Every January, the lead maintainer:

1. Reads the Go team's "What's coming in Go 1.X" blog posts for the
   year ahead.
2. Reviews this file for entries whose "Removal risk" has progressed.
3. Closes any obsolete entries with a final note documenting when
   they were removed and from which Otedama version.

This 30-minute exercise keeps the `go.mod` clean for a decade.
