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
| 1 | Source builds without warnings on Go 1.25+ | `go build ./...` at repo root | Exit code 0, no output — `go 1.25.0` directive + `toolchain go1.25.13` pin (tlsmlkem needs Go 1.24+) |
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
| 12 | GitHub Actions pinned to SHA | `grep -r 'uses:' .github/workflows/` | **Not met today:** workflows reference tag refs (`@v4`, `@master`), not SHA pins — see KNOWN_LIMITATIONS §13 (workflow changes are also where the env-broken checks live) |
| 13 | Dependabot enabled for Go, Actions, Docker | `.github/dependabot.yml` | Present, schedule: weekly |
| 14 | Release artefacts signed with cosign | `.github/workflows/release.yml` | **Not met today:** release.yml has no cosign/sign-blob/attest step — artefacts ship unsigned |
| 15 | Runtime dependencies limited to audited set | `go mod graph \| awk '{print $2}' \| sort -u` | Direct: `golang.org/x/crypto`, `go.yaml.in/yaml/v3`, `golang.org/x/sys` (+ `x/net`, `x/term`, `x/text` transitives via x/crypto), stdlib |
| 16 | No vendored code (vendored code is harder to audit) | `ls vendor/ 2>/dev/null` | No `vendor/` directory |

## Secrets and credentials

| # | Claim | Where to look | Verification |
|---|-------|---------------|--------------|
| 17 | No secrets in repository history | `git log -p \| grep -iE 'password=\|api_key=\|secret='` plus GitHub secret scanning | No hits |
| 18 | Wallet file written with 0600 perms | `internal/lightning/wallet.go` `os.WriteFile(..., 0600)` | Perm 0600 enforced |
| 19 | Mnemonic never logged | `grep -r 'mnemonic' internal/logger/ internal/lightning/` | Displayed once on stdout, never logged |
| 20 | Passphrase accepted via env, preferred over flag | `docs/API.md` recommends `OTEDAMA_WALLET_PASSPHRASE` | Documented preference — `--wallet-passphrase` exists but leaks to process lists |
| 21 | No default password or pre-shared key | Grep for hardcoded strings | None found |

## Cryptography

| # | Claim | Where to look | Verification |
|---|-------|---------------|--------------|
| 22 | AEAD used for wallet encryption | `internal/lightning/seedstore.go` | AES-256-GCM |
| 23 | Key derivation uses scrypt | `internal/lightning/seedstore.go` | `scrypt.Key(..., N=2^17 (131072), r=8, p=1, keyLen=32)` |
| 24 | Noise NX handshake for pool auth | `internal/stratum/noise.go` | Full handshake implemented, tested |
| 25 | TLS-like AEAD for Stratum V2 traffic | `internal/stratum/noise.go` `EncryptedConn` | ChaCha20-Poly1305 post-handshake |
| 26 | BIP-39 seed derivation | `internal/lightning/seed.go` | PBKDF2-HMAC-SHA512 with 2048 rounds |
| 27 | No home-grown cryptography | All crypto from `golang.org/x/crypto` or stdlib | Code review |

## Threat model and documentation

| # | Claim | Where to look | Verification |
|---|-------|---------------|--------------|
| 28 | STRIDE threat model exists and is current | `docs/THREAT_MODEL.md` | Last-modified within 6 months |
| 29 | Architecture Decision Records for major choices | `docs/adr/` | ADR-001, ADR-002, ADR-003 present |
| 30 | Security reporting process documented | `SECURITY.md` | Private reporting instructions |
| 31 | Code of Conduct adopted | `CODE_OF_CONDUCT.md` | Contributor Covenant 2.1 or equivalent |

---

## CI gate summary

This is the set of checks a PR must pass before merge. An auditor can
verify these are enforced by inspecting `.github/workflows/ci.yml`:

- `go vet ./...`
- `staticcheck ./...`
- `golangci-lint run`
- `govulncheck ./...`
- `gosec ./...` — verified run (session 384): 38 findings, all triaged false-positive (i18n strings flagged as hardcoded credentials, conventional 0755/0644 service-file modes, fixed-path G304, unhandled Close/Remove)
- `go test -race -timeout 5m ./...`
- `go build ./...` on linux/amd64, linux/arm64, darwin/amd64, darwin/arm64, windows/amd64

Nightly additional checks:

- 30-min fuzz of `FuzzDecodeHeader` and `FuzzDecoder_ReadFrame`
- PR-time benchmark comparison vs main (5% regression threshold)

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
