# Verifying Otedama Release Artifacts

Every Otedama release ships with cryptographic provenance. This document
explains how to verify that the binary you downloaded was built by the
Otedama project's GitHub Actions, was not tampered with in transit, and
contains the source code documented in the corresponding tag.

If any verification step fails, **do not run the binary**. Open a
security advisory per `SECURITY.md`.

## What to verify

For each release, four artifacts can be verified:

1. The **binary** itself (e.g. `otedama_v3.0.0-alpha.1_linux_amd64.tar.gz`).
2. The **checksums file** (`checksums.txt`) listing SHA-256 of every
   binary in the release.
3. The **Sigstore signature** of the checksums file
   (`checksums.txt.sig` + `checksums.txt.pem`) or the equivalent
   `*.bundle` file.
4. The **SBOM** files (`*.sbom.cyclonedx.json` and `*.sbom.spdx.json`)
   listing every dependency.

## Quick verification (most users)

```bash
# Pick the version you downloaded.
VERSION="v3.0.0-alpha.1"
ARCHIVE="otedama_${VERSION}_linux_amd64.tar.gz"

# 1. Download the artifact, the checksums, and the signature.
gh release download "${VERSION}" --repo shizukutanaka/Otedama \
  -p "${ARCHIVE}" \
  -p "checksums.txt" \
  -p "checksums.txt.sig" \
  -p "checksums.txt.pem"

# 2. Verify the signature on checksums.txt.
cosign verify-blob \
  --certificate-identity-regexp 'https://github.com/shizukutanaka/Otedama/.github/workflows/release.yml@.*' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  --signature checksums.txt.sig \
  --certificate checksums.txt.pem \
  checksums.txt

# 3. Verify the binary matches its checksum.
sha256sum --check --ignore-missing checksums.txt
```

If both `cosign verify-blob` and `sha256sum --check` exit 0, the
binary is genuine.

## Offline verification (air-gapped systems)

Sigstore's "new bundle format" with embedded signed timestamps lets
verification work without contacting Rekor or Fulcio at runtime.

```bash
# Use the all-in-one bundle file instead of separate .sig + .pem.
gh release download "${VERSION}" --repo shizukutanaka/Otedama \
  -p "${ARCHIVE}" \
  -p "checksums.txt" \
  -p "checksums.txt.bundle"

cosign verify-blob \
  --certificate-identity-regexp 'https://github.com/shizukutanaka/Otedama/.github/workflows/release.yml@.*' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  --bundle checksums.txt.bundle \
  --offline \
  checksums.txt
```

The `--offline` flag tells cosign to verify using only the bundle's
embedded signed timestamp, without contacting any external service.

## SBOM verification

Each release ships two SBOMs:

- `sbom.cyclonedx.json` (CycloneDX 1.6) — preferred for security
  scanners (`grype`, `osv-scanner`).
- `sbom.spdx.json` (SPDX 3.0.1) — preferred for license-compliance
  workflows.

Both are signed alongside `checksums.txt` and can be verified with the
same `cosign verify-blob` invocation above.

To check the binary you have for known vulnerabilities:

```bash
osv-scanner --sbom sbom.cyclonedx.json
```

## Identity values: how to know what to use

The `--certificate-identity-regexp` value depends on **which maintainer
signed the release**. Sigstore keyless signing binds each signature to a
short-lived OIDC certificate; the certificate's subject identifies the
exact GitHub Actions workflow run that produced the artifact.

Current expected values:

| Field | Value |
|-------|-------|
| `--certificate-oidc-issuer` | `https://token.actions.githubusercontent.com` |
| `--certificate-identity-regexp` | `https://github.com/shizukutanaka/Otedama/.github/workflows/release.yml@.*` |

When the maintainer roster changes (see `MAINTAINERS.md`), the identity
regex updates accordingly. The regex form (`@.*` matches any tag/branch)
tolerates any release tag while still pinning to the specific
repository and workflow file.

## Verifying the source matches the release

For paranoid (or audit-required) verification, build from source and
compare:

```bash
# 1. Clone at the exact tag.
git clone --depth=1 --branch "${VERSION}" \
  https://github.com/shizukutanaka/Otedama.git
cd Otedama

# 2. Verify the tag's GPG signature (signed by the maintainer).
git tag -v "${VERSION}"

# 3. Build with reproducible flags.
CGO_ENABLED=0 \
  GOOS=linux GOARCH=amd64 \
  go build -trimpath -ldflags="-s -w" -o otedama ./cmd/otedama

# 4. Compare against the release binary.
sha256sum otedama
sha256sum <(tar xOf "${ARCHIVE}" otedama)
```

Go binaries built with `-trimpath` and identical Go toolchain versions
are bit-for-bit reproducible (Go 1.21+). If your locally-built binary
hashes differently, your toolchain version or build flags differ.

## Long-term verification (10-year horizon)

Sigstore signatures have several time-horizon considerations for
long-running projects:

- **Fulcio CA root rotates approximately every 5 years.** Cosign
  bundles with embedded chains continue to verify against rotated
  roots, but the verification command may need updated trust roots.
  Cosign ships pinned roots; keep a recent cosign installed.
- **Rekor v1 is being deprecated** in favor of Rekor v2 (tile-based,
  witnessed). The transition runs in parallel through 2026; v1
  remains queryable for at least 12 months after v2 GA.
- **OIDC issuer URLs are stable** — `token.actions.githubusercontent.com`
  has not changed since 2021 and is not expected to change.

For artifacts older than five years, retain a copy of the cosign binary
that was current at the time of release alongside the artifact. The
project retains tagged copies of its `cosign` build version in each
release's `cosign.txt` file.

## What if Sigstore goes down

Sigstore is operated by the Linux Foundation and has high availability,
but is not infallible. If `cosign verify-blob` fails with network errors:

- **Retry with `--offline`** if you have a `*.bundle` file (recommended
  default for releases since v3.0.0).
- **Fall back to checksums** as a degraded check: if you trust the
  `checksums.txt` you obtained from a separate channel (e.g. another
  maintainer's mirror), verify the binary against it directly.
- **Wait** — Sigstore outages are typically resolved within hours.

The checksums file itself is multiply protected: signed by Sigstore,
recorded in the public Rekor transparency log, included in the GitHub
release page, and reproducible from source. Compromising all of these
simultaneously requires nation-state-level resources.

## Reporting verification failures

If you observe a verification failure that is not a transient network
issue:

1. Do not run the binary.
2. Save the artifacts and command output.
3. Report via GitHub Private Vulnerability Reporting (see `SECURITY.md`).

A genuine verification failure on a publicly-released binary indicates
either a serious supply-chain compromise or a bug in the release
pipeline. Either way, it is high priority.
