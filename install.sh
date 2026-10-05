#!/usr/bin/env bash
#
# Otedama one-line installer.
#
# Usage:
#   curl -sSL https://otedama.io/install.sh | bash
#
# Or with explicit options:
#   curl -sSL https://otedama.io/install.sh | bash -s -- --version v3.0.0-alpha.1 --prefix /usr/local
#
# What this script does:
#   1. Detects OS (Linux or macOS) and architecture (x86_64 or arm64).
#   2. Downloads the matching Otedama binary from GitHub Releases.
#   3. Verifies the SHA-256 checksum against the published checksums file
#      (a release without one is refused unless --skip-verify is given).
#   4. Optionally verifies the cosign signature of the checksums file.
#   5. Installs the binary to $PREFIX/bin (default: /usr/local/bin, or
#      $HOME/.local/bin if /usr/local is not writable).
#   6. Prints quick-start instructions.
#
# This script never requires root, never downloads from untrusted URLs,
# and fails fast with a clear error on any verification failure.

set -euo pipefail

# ---------- Defaults ----------

VERSION="${OTEDAMA_VERSION:-latest}"
PREFIX="${OTEDAMA_PREFIX:-}"
REPO="shizukutanaka/Otedama"
SKIP_VERIFY="${OTEDAMA_SKIP_VERIFY:-0}"

# ---------- Argument parsing ----------

while [[ $# -gt 0 ]]; do
    case "$1" in
        --version)
            VERSION="$2"; shift 2 ;;
        --prefix)
            PREFIX="$2"; shift 2 ;;
        --skip-verify)
            SKIP_VERIFY=1; shift ;;
        --help|-h)
            sed -n '3,25p' "$0"
            exit 0 ;;
        *)
            echo "unknown argument: $1" >&2
            exit 64 ;;
    esac
done

# ---------- Helpers ----------

die() { echo "otedama-install: error: $*" >&2; exit 1; }
log() { echo "otedama-install: $*" >&2; }

# Require a command to exist, or die with an install hint.
require() {
    command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

require curl
require tar
require sha256sum || require shasum

# ---------- OS + arch detection ----------

detect_os() {
    case "$(uname -s)" in
        Linux*)  echo "linux" ;;
        Darwin*) echo "darwin" ;;
        *)       die "unsupported OS: $(uname -s). Windows users: download the .exe from GitHub Releases." ;;
    esac
}

detect_arch() {
    case "$(uname -m)" in
        x86_64|amd64)  echo "amd64" ;;
        arm64|aarch64) echo "arm64" ;;
        *)             die "unsupported architecture: $(uname -m)" ;;
    esac
}

OS=$(detect_os)
ARCH=$(detect_arch)

# ---------- Version resolution ----------

if [[ "$VERSION" == "latest" ]]; then
    log "resolving latest version..."
    VERSION=$(
        curl -sSfL "https://api.github.com/repos/${REPO}/releases/latest" \
            | grep '"tag_name":' \
            | head -n1 \
            | sed -E 's/.*"([^"]+)".*/\1/'
    )
    [[ -z "$VERSION" ]] && die "could not determine latest version"
    log "latest version: $VERSION"
fi

# ---------- Prefix resolution ----------

if [[ -z "$PREFIX" ]]; then
    if [[ -w "/usr/local/bin" ]]; then
        PREFIX="/usr/local"
    else
        PREFIX="$HOME/.local"
        log "no write access to /usr/local/bin; installing to $PREFIX/bin"
    fi
fi

INSTALL_BIN="${PREFIX}/bin"
mkdir -p "$INSTALL_BIN"

# ---------- Download + verify ----------

# The repo has more than one release pipeline and they disagree on asset
# naming: .goreleaser.yaml produces "otedama_<ver>_<os>_<arch>.tar.gz" where
# <ver> is the tag minus its leading "v" (GoReleaser's .Version strips it),
# release.yml produces "otedama-<os>-<arch>.tar.gz", and ci-cd.yml uploads
# the bare binary "otedama-<os>-<arch>" (Windows adds ".exe"). Try each
# convention in turn so the installer works regardless of which pipeline
# produced the release.
BASE_URL="https://github.com/${REPO}/releases/download/${VERSION}"
TAGVER="${VERSION#v}"
CANDIDATES=(
    "otedama_${TAGVER}_${OS}_${ARCH}.tar.gz"
    "otedama_${VERSION}_${OS}_${ARCH}.tar.gz"
    "otedama-${OS}-${ARCH}.exe"
    "otedama-${OS}-${ARCH}"
    "otedama-${OS}-${ARCH}.tar.gz"
)

# Temporary workspace cleaned up on exit.
TMPDIR=$(mktemp -d)
trap "rm -rf '$TMPDIR'" EXIT

# ---------- Checksums ----------

# ci-cd publishes "checksums.txt"; goreleaser publishes
# "otedama_<ver>_checksums.txt". A 404 means that name simply wasn't
# published — but any other fetch failure (timeout, 5xx) must not silently
# downgrade to an unverified install, so it aborts unless --skip-verify.
CHECKSUMS_FILE=""
CHECKSUM_FETCH_ERROR=""
for cs in "checksums.txt" "otedama_${TAGVER}_checksums.txt" "otedama_${VERSION}_checksums.txt"; do
    code=$(curl -sL -o "${TMPDIR}/${cs}" -w '%{http_code}' "${BASE_URL}/${cs}" 2>/dev/null || echo "000")
    if [[ "$code" == "200" ]]; then
        CHECKSUMS_FILE="${TMPDIR}/${cs}"
        break
    elif [[ "$code" != "404" ]]; then
        CHECKSUM_FETCH_ERROR="$cs (HTTP $code)"
    fi
done
if [[ -z "$CHECKSUMS_FILE" && -n "$CHECKSUM_FETCH_ERROR" ]]; then
    if [[ "$SKIP_VERIFY" == "1" ]]; then
        log "checksums fetch failed ($CHECKSUM_FETCH_ERROR); --skip-verify given, continuing"
    else
        die "checksums download failed ($CHECKSUM_FETCH_ERROR) — refusing unverified install; retry or pass --skip-verify"
    fi
fi

# ---------- Download ----------

# When a checksums file exists, prefer the first candidate it actually
# covers: a tag published by several pipelines can offer both a verified
# asset and an unverified one — pick the verified one.
ARCHIVE=""
if [[ -n "$CHECKSUMS_FILE" ]]; then
    for name in "${CANDIDATES[@]}"; do
        grep -q " ${name}$" "$CHECKSUMS_FILE" || continue
        log "trying ${name}..."
        if curl -sSfL "${BASE_URL}/${name}" -o "${TMPDIR}/${name}"; then
            ARCHIVE="$name"
            break
        fi
    done
fi
if [[ -z "$ARCHIVE" ]]; then
    for name in "${CANDIDATES[@]}"; do
        log "trying ${name}..."
        if curl -sSfL "${BASE_URL}/${name}" -o "${TMPDIR}/${name}"; then
            ARCHIVE="$name"
            break
        fi
    done
fi
[[ -n "$ARCHIVE" ]] || die "no release asset matched (tried: ${CANDIDATES[*]})"
log "downloaded ${ARCHIVE}"

# ---------- SHA-256 verification ----------

if [[ "$SKIP_VERIFY" == "1" ]]; then
    log "SKIPPING checksum verification (--skip-verify)"
elif [[ -z "$CHECKSUMS_FILE" ]]; then
    die "no checksums file published for this release — refusing unverified install; pass --skip-verify to override"
elif ! grep -q " ${ARCHIVE}$" "$CHECKSUMS_FILE"; then
    die "${ARCHIVE} is not listed in $(basename "$CHECKSUMS_FILE") — refusing unverified install"
else
    log "verifying SHA-256..."
    cd "$TMPDIR"
    if command -v sha256sum >/dev/null 2>&1; then
        grep " ${ARCHIVE}$" "$(basename "$CHECKSUMS_FILE")" | sha256sum -c - >/dev/null 2>&1 \
            || die "SHA-256 verification FAILED. Download may be tampered."
    else
        CSNAME="$(basename "$CHECKSUMS_FILE")"
        expected=$(grep " ${ARCHIVE}$" "$CSNAME" | awk '{print $1}')
        actual=$(shasum -a 256 "${ARCHIVE}" | awk '{print $1}')
        [[ "$expected" == "$actual" ]] \
            || die "SHA-256 mismatch: expected $expected, got $actual"
    fi
    cd - >/dev/null
fi

# ---------- Cosign verification (optional, skipped if cosign missing) ----------

if command -v cosign >/dev/null 2>&1 && [[ -n "$CHECKSUMS_FILE" ]]; then
    log "verifying cosign signature..."
    CSNAME="$(basename "$CHECKSUMS_FILE")"
    cd "$TMPDIR"
    if curl -sSfL "${BASE_URL}/${CSNAME}.sig" -o "${CSNAME}.sig" 2>/dev/null \
        && curl -sSfL "${BASE_URL}/${CSNAME}.pem" -o "${CSNAME}.pem" 2>/dev/null; then
        if cosign verify-blob \
            --certificate "${CSNAME}.pem" \
            --signature "${CSNAME}.sig" \
            --certificate-identity-regexp "https://github.com/${REPO}/.github/workflows/.*" \
            --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
            "$CSNAME" >/dev/null 2>&1; then
            log "cosign verification OK"
        else
            die "cosign verification FAILED"
        fi
    else
        log "cosign signature not published for this release; skipping"
    fi
    cd - >/dev/null
fi

# ---------- Install ----------

# ci-cd releases ship the bare binary (no tarball); goreleaser ships the
# binary as "otedama" inside the tarball; release.yml tarballs keep the
# platform-named binary (otedama-<os>-<arch>) — normalise it to "otedama".
if [[ "$ARCHIVE" == *.tar.gz ]]; then
    log "extracting..."
    tar -xzf "${TMPDIR}/${ARCHIVE}" -C "$TMPDIR"
    if [[ ! -f "${TMPDIR}/otedama" ]]; then
        for f in "${TMPDIR}"/otedama-*; do
            case "$f" in
                *.tar.gz|*.txt|*.sig|*.pem) continue ;;
            esac
            if [[ -f "$f" ]]; then
                mv "$f" "${TMPDIR}/otedama"
                break
            fi
        done
    fi
else
    log "release asset is a bare binary; no extraction needed"
    mv "${TMPDIR}/${ARCHIVE}" "${TMPDIR}/otedama"
    chmod +x "${TMPDIR}/otedama"
fi

[[ -f "${TMPDIR}/otedama" ]] || die "otedama binary not found in archive"

log "installing to ${INSTALL_BIN}/otedama..."
install -m 0755 "${TMPDIR}/otedama" "${INSTALL_BIN}/otedama"

# ---------- Verify install ----------

if ! "${INSTALL_BIN}/otedama" version >/dev/null 2>&1; then
    die "installed binary failed to run — try 'file ${INSTALL_BIN}/otedama' to diagnose"
fi

# ---------- PATH hint ----------

if ! command -v otedama >/dev/null 2>&1 || [[ "$(command -v otedama)" != "${INSTALL_BIN}/otedama" ]]; then
    case ":$PATH:" in
        *":${INSTALL_BIN}:"*) ;;
        *)
            log ""
            log "NOTE: ${INSTALL_BIN} is not in your PATH."
            log "Add this line to ~/.bashrc, ~/.zshrc, or equivalent:"
            log ""
            log "    export PATH=\"${INSTALL_BIN}:\$PATH\""
            log ""
            ;;
    esac
fi

# ---------- Success message ----------

cat >&2 <<EOF

────────────────────────────────────────────────────────────────────────
  Otedama ${VERSION} installed to ${INSTALL_BIN}/otedama

  Quick start:
    otedama doctor                   # run diagnostic checks
    otedama run --bitcoin-address bc1q...

  With a Lightning wallet:
    otedama run \\
      --bitcoin-address bc1q... \\
      --wallet-passphrase "strong passphrase"

  Install as a background service (auto-start on login):
    otedama service install

  Documentation: https://github.com/${REPO}
────────────────────────────────────────────────────────────────────────
EOF
