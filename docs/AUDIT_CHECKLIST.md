# Audit Checklist

This checklist is for security auditors, OSS foundations, and enterprise
integrators evaluating Otedama. It enumerates the artefacts the project
commits to maintaining and shows how to verify each claim.

**Every row carries its status as of session 266, and the status was
produced by running the command in the row — not by assertion.** Before
that session this document listed a set of desirable properties in the
present tense; several of them (SHA-pinned actions, cosign-signed
releases, `staticcheck` and `govulncheck` in CI, nightly fuzzing) were
not true, and a checklist that misreports its own subject is worse than
no checklist, because it converts an auditor's time into false
assurance. The rows now say what is true today.

## How to use this document

For each row:

1. Read the claim.
2. Run the command in "Verification".
3. Compare against "Status".

A row marked **FAIL** is a known gap. Every one of them is written up in
`docs/KNOWN_LIMITATIONS.md` with its cause and its blocker, so finding
one reproduces a disclosed fact rather than discovering an undisclosed
one — **no advisory is needed for a FAIL row that matches this table.**
Open a security advisory (`SECURITY.md`) if you find something these
rows do not predict, including a PASS row that fails for you.

`—` in the Status column means the property could not be checked from
the session that last updated this file (usually a missing tool) and is
left for the auditor to run.

---

## Code quality

| # | Claim | Where to look | Verification | Status |
|---|-------|---------------|--------------|--------|
| 1 | Source builds with the Go toolchain the module requires | repo root | `go build ./...` | **PASS** with Go 1.24.7. See the note below on older toolchains — "Go 1.22+" is *not* accurate |
| 2 | Tests pass with the race detector | repo root | `go test -race -timeout 5m ./...` | **PASS** (24 packages) |
| 3 | `go vet` is clean | repo root | `go vet ./...` | **PASS** |
| 4 | `staticcheck` is clean | repo root | `staticcheck ./...` | **—** not installed in the verifying environment, and **not run by any CI workflow** |
| 5 | `golangci-lint` is clean | `.golangci.yml` | `golangci-lint run` | **FAIL to run** on golangci-lint v2.x: the config is in v1 format and v2 rejects it with `unsupported version of the configuration: ""`. CI pins v1.55.2, so CI is unaffected; a fresh local install is |
| 6 | No `TODO`/`FIXME`/`XXX` in committed non-test code | — | `git grep -En 'TODO\|FIXME\|XXX' -- '*.go' ':!*_test.go'` | **PASS** (no matches) |
| 7 | Test:implementation line ratio ≥ 1.0 | — | see the script below | **PASS** — 36,343 test lines : 20,552 implementation lines = **1.77** |
| 8 | Exported symbols are documented | `internal/`, `cmd/` | `go doc <pkg> <symbol>` for the packages you care about; there is no repo-wide command that proves this (`go doc -all ./...` is not a valid invocation) | **—** spot-check; not machine-enforced |
| 9 | SPDX-License-Identifier on every Go file | — | `find internal cmd -name '*.go' -exec sh -c 'head -3 "$1" \| grep -q SPDX \|\| echo "$1"' _ {} \;` | **PASS** (no output) |

**On "Go 1.22+".** `go.mod` declares `go 1.22` but also
`toolchain go1.24.0` and a `godebug` block containing `tlsmlkem=1`, a key
that exists only from Go 1.24. Listing a godebug key the toolchain does
not recognise is a hard error at `go.mod` load — measured directly:

```
$ GOTOOLCHAIN=local go build ./...          # module with an unknown godebug key
go: error loading go.mod:
go.mod:6: unknown godebug "bogusknobthatdoesnotexist"
```

With the default `GOTOOLCHAIN=auto`, an older toolchain switches to
go1.24.0 first and the build succeeds; with `GOTOOLCHAIN=local` it does
not switch and fails. Build with Go 1.24 or newer, or leave `GOTOOLCHAIN`
at its default. See `GODEBUG_NOTES.md` for why the pin is load-bearing
(removing it silently disables hybrid post-quantum TLS) and
`docs/KNOWN_LIMITATIONS.md` §13 for the CI consequence.

## Supply chain

| # | Claim | Where to look | Verification | Status |
|---|-------|---------------|--------------|--------|
| 10 | `go.sum` matches `go.mod` | — | `go mod verify` | **PASS** — "all modules verified" |
| 11 | No known vulnerabilities in dependencies | — | `govulncheck ./...` | **—** not installed in the verifying environment, and **not run by any CI workflow** (§21) |
| 12 | GitHub Actions pinned to a 40-character SHA | `.github/workflows/` | `grep -rn 'uses:' .github/workflows/` | **FAIL** — every `uses:` is a tag or a branch (`actions/checkout@v4`, `securego/gosec@master`, `aquasecurity/trivy-action@master`, `trufflesecurity/trufflehog@main`). Not one is SHA-pinned (§21) |
| 13 | Dependabot enabled for Go, Actions, Docker | `.github/dependabot.yml` | read it | **PASS** — all three ecosystems, weekly |
| 14 | Release artefacts signed with cosign | `.github/workflows/release.yml` | `grep -rn cosign .` | **FAIL** — `cosign` appears nowhere in the repository; releases are unsigned (§21) |
| 15 | Runtime dependencies limited to an audited set | — | `go list -deps ./cmd/otedama \| grep -E '^[a-z0-9.-]+\.[a-z]{2,}/' \| grep -v Otedama` | **PASS** — exactly three modules are linked: `golang.org/x/crypto`, `golang.org/x/sys`, `gopkg.in/yaml.v3`. (`go mod graph` also lists `x/net`, `x/term`, `x/text` and `check.v1`; those are graph entries from dependencies' own `go.mod` files and are not built into the binary — use the `go list -deps` form above, which answers the question actually being asked) |
| 16 | No vendored code | — | `ls vendor/` | **PASS** — no `vendor/` directory |

## Secrets and credentials

| # | Claim | Where to look | Verification | Status |
|---|-------|---------------|--------------|--------|
| 17 | No secrets in repository history | — | `git log -p \| grep -iE 'password=\|api_key=\|secret='`, plus GitHub secret scanning | **—** run it yourself; GitHub's scanner covers what a grep cannot |
| 18 | Wallet material written with 0600 perms | `internal/lightning/wallet.go` | read the `os.WriteFile`/`os.Chmod` calls | **PASS** — 0600 on both the wallet file and the fingerprint file |
| 19 | Mnemonic never logged | `internal/lightning/`, `internal/logger/` | `grep -rn mnemonic internal/logger/ internal/lightning/` | **PASS** — shown once on stdout at creation; `otedama wallet verify` reads a phrase from stdin and never echoes it (tests pin this) |
| 20 | Passphrase accepted via environment, not flag | `docs/API.md`, `cmd/otedama/wallet.go` | read | **PASS** — `OTEDAMA_WALLET_PASSPHRASE`; interactive prompts otherwise |
| 21 | No default password or pre-shared key | — | grep for hardcoded credentials | **PASS** — none. (`config.yaml.example` shows `password: "x"` for Stratum V1, which is the protocol's conventional ignored placeholder, not a credential) |

## Cryptography

| # | Claim | Where to look | Verification | Status |
|---|-------|---------------|--------------|--------|
| 22 | AEAD used for wallet encryption | `internal/lightning/seedstore.go` | read `EncryptSeed` | **PASS** — AES-256-GCM |
| 23 | Key derivation for the wallet uses scrypt | `internal/lightning/seedstore.go` | read `scryptN/scryptR/scryptP` | **PASS** — `scrypt.Key(pass, salt, N=1<<17, r=8, p=1, keyLen=32)`. **N is 131072**, not 32768; the file is `seedstore.go`, not `seed.go` — both were wrong in this table before session 266 |
| 24 | BIP-39 seed derivation | `internal/lightning/seed.go` | read the `pbkdf2.Key` call | **PASS** — PBKDF2-HMAC-SHA512, 2048 iterations, 64-byte output |
| 25 | Noise NX handshake implemented for Stratum V2 | `internal/stratum/noise*.go` | read + `go test ./internal/stratum/` | **PASS as code, NOT IN USE.** The handshake is implemented and tested but is **not wired into any live connection** (§2). Do not conclude that `stratum+v2://` traffic is encrypted — it is plaintext. `stratum+v2tls://` gets real TLS, from a different code path |
| 26 | AEAD for Stratum V2 traffic | `internal/stratum/noise.go` `EncryptedConn` | read | **Same qualification as 25** — ChaCha20-Poly1305 post-handshake, on a path no dial site takes today |
| 27 | No home-grown cryptography | all of `internal/` | code review | **PASS** — every primitive comes from `crypto/*` or `golang.org/x/crypto`. The one place that looks like hand-rolled crypto, `internal/miner/sha256d.go`, uses `crypto/sha256`'s `BinaryMarshaler` to cache a midstate; it computes no primitive of its own |

## Threat model and documentation

| # | Claim | Where to look | Verification | Status |
|---|-------|---------------|--------------|--------|
| 28 | STRIDE threat model exists and is current | `docs/THREAT_MODEL.md` | read; check git log for its last update | **PASS** |
| 29 | Architecture Decision Records for major choices | `docs/adr/` | `ls docs/adr/` | **PASS** — ADR-001 … ADR-011 |
| 30 | Security reporting process documented | `SECURITY.md` | read | **PASS** |
| 31 | Code of Conduct adopted | `CODE_OF_CONDUCT.md` | read | **PASS** — Contributor Covenant |
| 32 | Known limitations disclosed rather than implied | `docs/KNOWN_LIMITATIONS.md` | read | **PASS** — 22 entries, each with cause, impact, workaround and blocker |

---

## What CI actually runs

Inspect `.github/workflows/` and confirm. The jobs that exist today:

- `ci.yml` — golangci-lint (pinned v1.55.2), `gofmt -l`, `go mod tidy`
  diff, tests, cross-platform builds, gosec + Trivy uploading SARIF
- `test.yml` — tests across a Go matrix, lint, gosec, build, integration,
  benchmark
- `security.yml` — gosec, CodeQL, Trivy, TruffleHog, Semgrep, Anchore
- `release.yml` — tagged cross-platform builds and packaging

**Not run by any workflow, despite earlier versions of this document
saying otherwise:** `staticcheck`, `govulncheck`, nightly or PR-time
fuzzing, and benchmark comparison against `main` with a regression
threshold. The two fuzz targets that exist
(`FuzzDecodeHeader`, `FuzzDecoder_ReadFrame` in
`internal/stratum/frame_fuzz_test.go`) run only as ordinary seed-corpus
tests under `go test`.

**Several of those workflows do not currently succeed**, for reasons
recorded in `docs/KNOWN_LIMITATIONS.md` §13 (jobs referencing files and
directories that do not exist, and Go version pins interacting with the
module's `godebug` block). The fix is written out there step by step; it
needs a maintainer push because the GitHub App used by these sessions may
delete a workflow file but not modify one.

---

## Verification script

Run this at the root of a fresh clone. It covers the rows that are
machine-checkable without extra tooling.

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "[1] build"
go build ./...

echo "[2] test -race"
go test -race -timeout 5m ./...

echo "[3] vet"
go vet ./...

echo "[4] module verification"
go mod verify

echo "[5] linked external modules (expect exactly three)"
go list -deps ./cmd/otedama \
  | grep -E '^[a-z0-9.-]+\.[a-z]{2,}/' \
  | grep -v '^github.com/shizukutanaka/Otedama' \
  | sed 's#\(^[^/]*/[^/]*/[^/]*\).*#\1#' | sort -u

echo "[6] no TODO/FIXME/XXX in non-test code"
! git grep -En 'TODO|FIXME|XXX' -- '*.go' ':!*_test.go'

echo "[7] SPDX header on every Go file"
missing=$(find internal cmd -name '*.go' \
  -exec sh -c 'head -3 "$1" | grep -q SPDX || echo "$1"' _ {} \;)
[ -z "$missing" ] || { echo "missing SPDX: $missing"; exit 1; }

echo "[8] test:impl ratio"
impl=$(find internal cmd -name '*.go' ! -name '*_test.go' -exec cat {} + | wc -l)
test=$(find internal cmd -name '*_test.go' -exec cat {} + | wc -l)
ratio=$(echo "scale=3; $test / $impl" | bc)
echo "ratio: $ratio"
[ "$(echo "$ratio >= 1.0" | bc)" = "1" ]

echo "All green."
```

Optional, if you have the tools: `staticcheck ./...`,
`govulncheck ./...`, `gosec ./...`. None of the three is enforced by CI
today, so expect to be the first to see their output on a given commit.

---

## Scope of this checklist

This checklist covers the Otedama codebase. It does **not** verify:

- Production deployment posture (operator's responsibility — see
  `docs/DEPLOYMENT.md`).
- Upstream security (Go toolchain, OS kernel, hardware RNG).
- Business continuity (key recovery, passphrase backup) — user-controlled
  operational concerns.
- Third-party endpoints. Otedama connects to pools chosen by the user;
  their transport security is a property of the URL scheme the user
  configures (§2, §20).

For a full security evaluation, combine this checklist with an
operational review of the specific deployment, and read
`docs/KNOWN_LIMITATIONS.md` first — it is the shortest path to what this
product does not do.
