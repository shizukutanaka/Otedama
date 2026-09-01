#!/usr/bin/env bash
#
# Otedama one-line installer.
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/shizukutanaka/Otedama/main/install.sh | bash
#
# Or with explicit options:
#   curl -sSL https://raw.githubusercontent.com/shizukutanaka/Otedama/main/install.sh | bash -s -- --version v3.0.0-alpha.1 --prefix /usr/local
#
# (These lines named https://otedama.io/install.sh until session 266.
# That host does not resolve, so the documented command could not run at
# all. The repository URL is the one that exists.)
#
# What this script does:
#   1. Detects OS (Linux or macOS) and architecture (x86_64 or arm64).
#   2. Downloads the matching Otedama binary from GitHub Releases.
#   3. Verifies the SHA-256 checksum against the published checksums.txt.
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

ARCHIVE="otedama_${VERSION}_${OS}_${ARCH}.tar.gz"
BASE_URL="https://github.com/${REPO}/releases/download/${VERSION}"

# Temporary workspace cleaned up on exit.
TMPDIR=$(mktemp -d)
trap "rm -rf '$TMPDIR'" EXIT

log "downloading ${ARCHIVE}..."
curl -sSfL "${BASE_URL}/${ARCHIVE}" -o "${TMPDIR}/${ARCHIVE}" \
    || die "download failed"

# ---------- SHA-256 verification ----------
#
# The checksums download sits inside the verification branch on purpose.
# It used to run unconditionally, one step earlier, and abort the whole
# install if the file was missing — which made --skip-verify a flag that
# could not do what it says, since the fatal step happened before the
# flag was ever consulted. That is not hypothetical: the release workflow
# publishes no checksums.txt today (docs/KNOWN_LIMITATIONS.md §21), so
# every invocation of this script, with or without the flag, died at that
# line.
#
# Failing without the flag is still the correct behaviour: if the
# checksums cannot be fetched, there is nothing to verify against, and a
# silent unverified install is exactly what this script exists to
# prevent. --skip-verify remains an explicit, logged opt-out.

if [[ "$SKIP_VERIFY" == "1" ]]; then
    log "SKIPPING checksum verification (--skip-verify) — the download is UNVERIFIED"
else
    log "downloading checksums..."
    curl -sSfL "${BASE_URL}/checksums.txt" -o "${TMPDIR}/checksums.txt" \
        || die "checksums download failed (no checksums.txt in this release; re-run with --skip-verify to install without verification, at your own risk)"

    log "verifying SHA-256..."
    cd "$TMPDIR"
    if command -v sha256sum >/dev/null 2>&1; then
        grep " ${ARCHIVE}$" checksums.txt | sha256sum -c - >/dev/null 2>&1 \
            || die "SHA-256 verification FAILED. Download may be tampered."
    else
        expected=$(grep " ${ARCHIVE}$" checksums.txt | awk '{print $1}')
        actual=$(shasum -a 256 "${ARCHIVE}" | awk '{print $1}')
        [[ "$expected" == "$actual" ]] \
            || die "SHA-256 mismatch: expected $expected, got $actual"
    fi
    cd - >/dev/null
fi

# ---------- Cosign verification (optional, skipped if cosign missing) ----------

if command -v cosign >/dev/null 2>&1; then
    log "verifying cosign signature..."
    cd "$TMPDIR"
    if curl -sSfL "${BASE_URL}/checksums.txt.sig" -o checksums.txt.sig 2>/dev/null \
        && curl -sSfL "${BASE_URL}/checksums.txt.pem" -o checksums.txt.pem 2>/dev/null; then
        if cosign verify-blob \
            --certificate checksums.txt.pem \
            --signature checksums.txt.sig \
            --certificate-identity-regexp "https://github.com/${REPO}/.github/workflows/.*" \
            --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
            checksums.txt >/dev/null 2>&1; then
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

log "extracting..."
tar -xzf "${TMPDIR}/${ARCHIVE}" -C "$TMPDIR"

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
