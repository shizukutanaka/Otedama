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
go 1.24
toolchain go1.24.0
```

No `godebug` block. That is the point of the baseline, and it took a
measurement to get here.

Until session 266 the module declared `go 1.22` and pinned three settings.
GODEBUG defaults follow the `go` directive, so a `go 1.22` module compiled
by a Go 1.24 toolchain bakes in **Go-1.22-era behaviour** for every setting
introduced since. The built binary said so plainly — `go version -m` on it
reported seventeen entries in `DefaultGODEBUG`:

```
asynctimerchan=1  gotestjsonbuildtext=1  gotypesalias=0
httpservecontentkeepheaders=1  multipathtcp=0  panicnil=0  randautoseed=1
randseednop=0  rsa1024min=0  tls3des=1  tlsmlkem=1  winreadlinkvolume=0
winsymlink=0  x509keypairleaf=0  x509negativeserial=1  x509rsacrt=0
x509usepolicies=0
```

Under `go 1.24` with no pins at all, the same command reports
**`DefaultGODEBUG=` — empty**: every setting sits at the toolchain's current
default, including `tlsmlkem=1`. Fourteen of the seventeen actually change
value; the three that do not are exactly the three that used to be pinned,
because the pins were holding them at what became the default.

**Why split `go` from `toolchain`:** the `go` directive declares the
language and behaviour baseline the source assumes; `toolchain` is the
build toolchain. They now agree because they must: `godebug tlsmlkem=1`
under a `go 1.22` line is an unrecognised key on any toolchain older than
1.24 (the Go 1.23 name was `tlskyber`; Go's own `doc/godebug.md` records
the rename and removal), and an unrecognised godebug key is a hard error
at `go.mod` load. The split was buying compatibility the godebug block had
already spent.

The `go` line is bumped roughly once a year, six months or more after the
corresponding Go release. Go 1.24.0 shipped in February 2025 and was
adopted here in September 2026 — nineteen months, comfortably inside the
policy below.

## Active knobs

**None.** As of session 266 the module pins nothing, and that is the
desired state: a pin is a divergence from the toolchain's judgement and
should exist only while it buys something.

The three that used to be here, and why each is gone:

- **`tlsmlkem=1`** (hybrid post-quantum TLS key exchange, X25519MLKEM768,
  for `stratum+v2tls://` pools and price-feed HTTPS) — **was load-bearing
  under `go 1.22`, and is the reason this section needs a history.** The
  key did not exist in the Go 1.22 era, so its `go 1.22` default resolved
  to *off*; deleting the line as a "redundant restatement of a default"
  would have silently disabled post-quantum key exchange with nothing
  failing and no log line. Measured in session 264: removing it flipped the
  binary's `DefaultGODEBUG` from `tlsmlkem=1` to `tlsmlkem=0`. Under
  `go 1.24` it is the native default, confirmed by the empty
  `DefaultGODEBUG` above and by `tls.X25519MLKEM768` being present in the
  toolchain's curve set. The trap is gone because the condition that
  created it is gone.
- **`panicnil=0`** — Go 1.21+ behaviour, already the default under
  `go 1.24`. Otedama never calls `panic(nil)`; the pin was for visibility.
- **`randautoseed=1`** — Go 1.20+ behaviour, already the default under
  `go 1.24`. Nothing security-relevant depends on `math/rand`
  determinism (`crypto/rand` is used where it matters).

### What the bump moved, and how it was checked

The fourteen settings that changed value are mostly stricter crypto
defaults, which for a binary that handles payout addresses is the
direction to travel: `tls3des` 1→0, `x509negativeserial` 1→0,
`rsa1024min` 0→1, `x509rsacrt` 0→1, `x509usepolicies` 0→1,
`x509keypairleaf` 0→1. Several are inert here — `winsymlink`,
`winreadlinkvolume` (Windows link handling), `gotypesalias` (`go/types`
consumers), `gotestjsonbuildtext` (`go test -json` output),
`httpservecontentkeepheaders` (`http.ServeContent`), `randseednop`
(`rand.Seed`), `multipathtcp`. Checked by grep: this codebase calls none
of `rand.Seed`, `ServeContent`, `os.Symlink`/`os.Readlink`, the MPTCP
setters, 3DES, or `crypto/rsa` directly.

The one with real runtime consequences is **`asynctimerchan` 1→0**: Go
1.23 changed `time.Timer`/`time.Ticker` channel semantics, and this
codebase has 25 timer and ticker sites, including the reconnect backoff,
the stats tick, the uptime publisher and the price-feed poller. Evidence
it is safe here, all under the new directive: three consecutive clean
full-suite runs (24/24 packages), the race suite (24/24, no data races),
`internal/engine` — the timer-heaviest package, and the home of the one
test with a known contention flake — green five consecutive times, and
`miner`, `httpserver`, `rates` and `tui` green three times each. The
binary still refuses a run without a pool (exit 78) and accepts one with
a pool.

That is one machine. It is not a substitute for review, but it is the
evidence a reviewer would otherwise have to gather themselves.

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
- **Not yet in effect (verified session 251):** `go.mod` still pins
  `toolchain go1.24.0`, which predates this feature — so the
  container-aware default is **not compiled into current builds**.
  A Kubernetes miner today still sees the host's full core count. This
  benefit only materializes once the `toolchain` line is bumped to
  go1.25.x (per the quarterly-toolchain policy above; go1.24.0 is now
  over a year old). The bump was scoped but not performed in session
  251 because this environment's module proxy denies the Go toolchain
  download (`sum.golang.org` Forbidden). Tracked in
  RESEARCH_IMPROVEMENTS session-251 item 3.
- Otedama impact: positive once the toolchain bump lands — fixes a
  class of "miner saturates noisy-neighbor pod limit" reports we
  expect from Kubernetes users.
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
3. Run `go vet ./...` and `staticcheck ./...` on the new version. (For
   the 1.24 bump, `go vet` was clean; `staticcheck` is not installed in
   the session that made the change and is not run by CI either — see
   docs/KNOWN_LIMITATIONS.md §21 — so that half was not performed.)
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
