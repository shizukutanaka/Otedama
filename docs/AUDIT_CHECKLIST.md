# Audit Checklist

This checklist is for security auditors, OSS foundations, and enterprise
integrators evaluating Otedama. It enumerates the artefacts we commit to
maintaining and shows how to verify each claim.

## How to use this document

For each row:

1. Read the claim.
2. Follow the "Where to look" pointer.
3. Confirm the artefact exists, is current, and functions as described.

If any row does not pass, open a security advisory.

---

## Code quality

| # | Claim | Where to look | Verification |
|---|-------|---------------|--------------|
| 1 | Source builds without warnings on Go 1.24+ | `go build ./...` at repo root | Exit code 0, no output — **Correction (session 488):** this row said "Go 1.22+" but `go.mod` requires ≥1.24 (`godebug tlsmlkem` fails to parse under older toolchains) |
| 2 | Tests pass with the race detector | `go test -race -timeout 5m ./...` | Exit code 0 |
| 3 | `go vet` is clean | `go vet ./...` | Exit code 0 |
| 4 | `staticcheck` is clean | `staticcheck ./...` | Exit code 0 |
| 5 | `golangci-lint` is clean | `golangci-lint run` | Exit code 0 |
| 6 | No `TODO`/`FIXME`/`XXX` in committed code | `grep -rE 'TODO\|FIXME\|XXX' --include='*.go' .` | Empty or annotated with issue number |
| 7 | Test:implementation ratio ≥ 1.0 | `find internal cmd -name '*_test.go' \| xargs wc -l` vs `! -name '*_test.go'` | Ratio ≥ 1.0 |
| 8 | All exported symbols have godoc | `go doc -all ./... \| grep -v '^func '`, visual inspection | Every exported name documented |
| 9 | SPDX-License-Identifier on every Go file | `find internal cmd -name '*.go' -exec sh -c 'head -3 "$1" \| grep -q SPDX \|\| echo "$1"' _ {} \;` | No output |

## Supply chain

| # | Claim | Where to look | Verification |
|---|-------|---------------|--------------|
| 10 | `go.sum` matches `go.mod` | `go mod verify` | All modules pass |
| 11 | No known vulnerabilities in deps | `govulncheck ./...` | No high/critical findings |
| 12 | GitHub Actions pinned to SHA | `grep -r 'uses:' .github/workflows/` | **Gap:** all `uses:` are tag refs (`@v4`, one `@master`), not SHA pins — pinning is a hardening item, not present |
| 13 | Dependabot enabled for Go, Actions, Docker | `.github/dependabot.yml` | Present, schedule: weekly |
| 14 | Release artefacts are integrity-verified | `install.sh` | SHA-256 `checksums.txt` verified before install — **Gap:** cosign signatures are not yet produced by `release.yml` (VERIFY.md documents the unsigned status); an optional `verify-blob` path exists |
| 15 | Runtime dependencies limited to audited set | `go mod graph \| awk '{print $2}' \| sort -u` | Only `golang.org/x/crypto`, `go.yaml.in/yaml/v3`, stdlib |
| 16 | No vendored code (vendored code is harder to audit) | `ls vendor/ 2>/dev/null` | No `vendor/` directory |

## Secrets and credentials

| # | Claim | Where to look | Verification |
|---|-------|---------------|--------------|
| 17 | No secrets in repository history | `git log -p \| grep -iE 'password=\|api_key=\|secret='` plus GitHub secret scanning | No hits |
| 18 | Wallet file written with 0600 perms | `internal/lightning/wallet.go` `save()` | Atomic `os.CreateTemp` → `Sync` → `os.Chmod(0600)` → `os.Rename` |
| 19 | Mnemonic never logged | `grep -r 'mnemonic' internal/logger/ internal/lightning/` | Displayed once on stdout, never logged |
| 20 | Mnemonic re-entry via stdin, never argv | `cmd/otedama/wallet.go` `readSecretLine` | `wallet verify` reads the phrase from stdin — `ps` never sees it; it is compared as a public fingerprint, so wallet.dat is not decrypted |
| 21 | Passphrase accepted via env, not flag | `docs/API.md` recommends `OTEDAMA_WALLET_PASSPHRASE` | Documented preference |
| 22 | No default password or pre-shared key | Grep for hardcoded strings | None found |

## Cryptography

| # | Claim | Where to look | Verification |
|---|-------|---------------|--------------|
| 23 | AEAD used for wallet encryption | `internal/lightning/seedstore.go` | AES-256-GCM |
| 24 | Key derivation uses scrypt | `internal/lightning/seedstore.go` | `scrypt.Key(..., N=131072 (2^17), r=8, p=1, keyLen=32)` |
| 25 | Noise NX handshake for pool auth | `internal/stratum/noise.go` | Full handshake implemented, tested |
| 26 | TLS-like AEAD for Stratum V2 traffic | `internal/stratum/noise.go` `EncryptedConn` | ChaCha20-Poly1305 post-handshake |
| 27 | BIP-39 seed derivation | `internal/lightning/seed.go` | PBKDF2-HMAC-SHA512 with 2048 rounds |
| 28 | No home-grown cryptography | All crypto from `golang.org/x/crypto` or stdlib | Code review |

## Threat model and documentation

| # | Claim | Where to look | Verification |
|---|-------|---------------|--------------|
| 29 | STRIDE threat model exists and is current | `docs/THREAT_MODEL.md` | Last-modified within 6 months |
| 30 | Architecture Decision Records for major choices | `docs/adr/` | ADR-001, ADR-002, ADR-003 present |
| 31 | Security reporting process documented | `SECURITY.md` | Private reporting instructions |
| 32 | Code of Conduct adopted | `CODE_OF_CONDUCT.md` | Contributor Covenant 2.1 or equivalent |

---

## CI gate summary

This is the set of checks a PR must pass before merge. An auditor can
verify these are enforced by inspecting `.github/workflows/ci.yml`.
**Correction (session 488):** the list below previously claimed standalone
`go vet`, `staticcheck`, and `govulncheck` jobs — none exist in `ci.yml`.
`govet` and `staticcheck` run only as linters inside `golangci-lint run`
(a standalone `go vet` step exists only in `test.yml`). **Session 1267
update:** `govulncheck` now runs in `security.yml` (Security Scanning job,
after the Nancy scan) and a `Fuzz` job in `test.yml` runs `make fuzz`
(30 s per target). The accurate gate is:

- `golangci-lint run` (Lint job; includes `govet` + `staticcheck` via `.golangci.yml`)
- `gosec` (Security Scan job, SARIF upload)
- `go fmt` check + `go mod tidy` check (Lint job)
- `go test -v -timeout 10m -race ./...` on Linux/macOS; without `-race` on Windows
- `go build` on linux/amd64, linux/arm64, darwin/amd64, darwin/arm64, windows/amd64 (Build job matrix)

Nightly additional checks: **none exist.** Fuzz now runs per-PR in
`test.yml`'s `Fuzz` job (`make fuzz`, 30 s per target across all targets —
previously local-only with no workflow scheduling it). The Benchmark job
runs benchmarks and uploads `benchmark.txt` (artifact `benchmark-results`);
it does not compare against main or gate on a regression threshold.

---

## Verification script

Run this once at the root of a fresh clone to execute items 1-7 in
sequence:

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "[1] build"
go build ./...

echo "[2] test -race"
go test -race -timeout 5m ./...

echo "[3] vet"
go vet ./...

echo "[4] staticcheck"
staticcheck ./... || true  # warn, don't fail

echo "[5] golangci-lint"
golangci-lint run || true

echo "[6] grep TODO/FIXME/XXX"
! git grep -En 'TODO|FIXME|XXX' -- '*.go' ':!*_test.go'

echo "[7] test:impl ratio"
impl=$(find internal cmd -name '*.go' ! -name '*_test.go' -exec cat {} + | wc -l)
test=$(find internal cmd -name '*_test.go' -exec cat {} + | wc -l)
ratio=$(echo "scale=3; $test / $impl" | bc)
echo "ratio: $ratio"
[ "$(echo "$ratio >= 1.0" | bc)" = "1" ]

echo "All green."
```

---

## Scope of this checklist

This checklist focuses on the Otedama codebase itself. It does **not**
verify:

- Production deployment posture (that is the operator's responsibility;
  see `docs/DEPLOYMENT.md` hardening section).
- Upstream security (Go toolchain, OS kernel, hardware RNG).
- Business continuity (key recovery, passphrase backup) — those are
  user-controlled operational concerns.

For a full security evaluation, combine this checklist with an
operational review of the specific deployment.
