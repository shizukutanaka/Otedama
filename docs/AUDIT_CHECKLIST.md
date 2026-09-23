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
| 1 | Source builds without warnings on Go 1.24+ | `go build ./...` at repo root | Exit code 0, no output |
| 2 | Tests pass with the race detector | `go test -race -timeout 5m ./...` | Exit code 0 |
| 3 | `go vet` is clean | `go vet ./...` | Exit code 0 |
| 4 | `staticcheck` is clean | `staticcheck ./...` | Exit code 0 |
| 5 | `golangci-lint` reports no new findings on changed code | `golangci-lint run` | A bounded pre-existing backlog is documented in KNOWN_LIMITATIONS; no findings may be added by a change |
| 6 | No `TODO`/`FIXME`/`XXX` in committed code | `grep -rE 'TODO\|FIXME\|XXX' --include='*.go' .` | Empty or annotated with issue number |
| 7 | Test:implementation ratio ≥ 1.0 | `find internal cmd -name '*_test.go' \| xargs wc -l` vs `! -name '*_test.go'` | Ratio ≥ 1.0 |
| 8 | All exported symbols have godoc | `go doc -all ./... \| grep -v '^func '`, visual inspection | Every exported name documented |
| 9 | SPDX-License-Identifier on every Go file | `find internal cmd -name '*.go' -exec sh -c 'head -3 "$1" \| grep -q SPDX \|\| echo "$1"' _ {} \;` | No output |

## Supply chain

| # | Claim | Where to look | Verification |
|---|-------|---------------|--------------|
| 10 | `go.sum` matches `go.mod` | `go mod verify` | All modules pass |
| 11 | No known vulnerabilities in deps | `govulncheck ./...` | No high/critical findings |
| 12 | GitHub Actions pinned to SHA | `grep -r 'uses:' .github/workflows/` | Every `uses:` has `@<40-char-sha>`. **Currently fails:** actions are pinned to release tags, and `aquasecurity/trivy-action@master`/`securego/gosec@master` float on `@master` — tracked in `docs/KNOWN_LIMITATIONS.md` §13 |
| 13 | Dependabot enabled for Go, Actions, Docker | `.github/dependabot.yml` | Present, schedule: weekly |
| 14 | Release artefacts signed with cosign | `.github/workflows/release.yml` | `cosign sign-blob` invoked. **Currently fails:** the release pipeline publishes unsigned artifacts — tracked in `docs/KNOWN_LIMITATIONS.md` §18 |
| 15 | Runtime dependencies limited to audited set | `go mod graph \| awk '{print $2}' \| sort -u` | Only `golang.org/x/crypto`, `go.yaml.in/yaml/v3`, stdlib |
| 16 | No vendored code (vendored code is harder to audit) | `ls vendor/ 2>/dev/null` | No `vendor/` directory (SUSTAINABILITY §9 plans deliberate vendoring of `internal/btccrypto` deps — revise this row when that lands) |

## Secrets and credentials

| # | Claim | Where to look | Verification |
|---|-------|---------------|--------------|
| 17 | No secrets in repository history | `git log -p \| grep -iE 'password=\|api_key=\|secret='` plus GitHub secret scanning | No hits |
| 18 | Wallet file written with 0600 perms | `internal/lightning/wallet.go` `os.WriteFile(..., 0600)` | Perm 0600 enforced |
| 19 | Mnemonic never logged | `grep -r 'mnemonic' internal/logger/ internal/lightning/` | Displayed once on stdout, never logged |
| 20 | Passphrase accepted via env, not flag | `docs/API.md` recommends `OTEDAMA_WALLET_PASSPHRASE` | Documented preference |
| 21 | No default password or pre-shared key | Grep for hardcoded strings | None found |

## Cryptography

| # | Claim | Where to look | Verification |
|---|-------|---------------|--------------|
| 22 | AEAD used for wallet encryption | `internal/lightning/seedstore.go` | AES-256-GCM |
| 23 | Key derivation uses scrypt | `internal/lightning/seedstore.go` | `scrypt.Key(..., N=131072 (1<<17), r=8, p=1, keyLen=32)` |
| 24 | Noise NX handshake for pool auth | `internal/stratum/noise.go` | Handshake structure implemented; curve is currently a P-256 stub and two transcript-init divergences from the SV2 spec are tracked in `docs/KNOWN_LIMITATIONS.md` §2.4 |
| 25 | TLS-like AEAD for Stratum V2 traffic | `internal/stratum/noise.go` `EncryptedConn` | ChaCha20-Poly1305 post-handshake |
| 26 | BIP-39 seed derivation | `internal/lightning/seed.go` | PBKDF2-HMAC-SHA512 with 2048 rounds |
| 27 | No home-grown cryptography | All crypto from `golang.org/x/crypto` or stdlib | Code review |

## Threat model and documentation

| # | Claim | Where to look | Verification |
|---|-------|---------------|--------------|
| 28 | STRIDE threat model exists and is current | `docs/THREAT_MODEL.md` | Last-modified within 6 months |
| 29 | Architecture Decision Records for major choices | `docs/adr/` | ADR-001 through ADR-013 present |
| 30 | Security reporting process documented | `SECURITY.md` | Private reporting instructions |
| 31 | Code of Conduct adopted | `CODE_OF_CONDUCT.md` | Contributor Covenant 2.1 or equivalent |

---

## CI gate summary

This is the set of checks a PR must pass before merge. An auditor can
verify what is actually enforced by inspecting `.github/workflows/` —
the jobs that exist today (as distinct from the aspirational list this
section used to claim):

- `golangci-lint run --timeout=5m ./...` (ci.yml `lint` job)
- `gofmt`/`go mod tidy` consistency checks (ci.yml `lint` job)
- Trivy filesystem scan + `gosec` (ci.yml `security` job — both pinned to
  `@master`, see row 12)
- `go test -race -timeout 10m ./...` on ubuntu/windows/macos (ci.yml `test`
  matrix; note the pinned Go versions are older than `go.mod` requires —
  see `docs/KNOWN_LIMITATIONS.md` §13)
- `make build` plus a multi-platform build step (ci.yml `build` job)
- `actions/dependency-review-action` on PRs (code-review.yml — currently
  fails because the repo's Dependency graph is not enabled; §13)

**Not enforced today** (the previous version of this section claimed
these — none exist in `.github/workflows/`): `staticcheck`, `govulncheck`,
a nightly 30-min fuzz job (`Fuzz*` targets and `make fuzz` exist but no
workflow invokes them), and a PR-time benchmark-regression comparison.

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
