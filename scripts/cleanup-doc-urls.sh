#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")"/.. && pwd)"
usage_dir="$repo_root/docs/usage"

echo "[cleanup] Normalizing URLs in $usage_dir" >&2

# Function to sanitize a single markdown file
sanitize_md() {
  local f="$1"
  [ -f "$f" ] || return 0
  sed -i -E \
    -e 's|https://github.com/otedama/otedama|https://github.com/shizukutanaka/Otedama|g' \
    -e 's|https://docs\.otedama\.io|../README.md|g' \
    -e 's|(https?)://([A-Za-z0-9-]+)\.otedama\.io|\1://\2.otedama.local|g' \
    -e 's|(https?)://otedama\.io|\1://otedama.local|g' \
    -e 's|^([[:space:]]*)wget https://github.com/otedama/releases/latest/otedama-linux-amd64[[:space:]]*$|\1bash ./scripts/install.sh|g' \
    -e '/^[[:space:]]*chmod \+x otedama-linux-amd64[[:space:]]*$/d' \
    -e 's|stratum\+tcp://pool\.example\.com:3333|stratum+tcp://127.0.0.1:3333|g' \
    -e 's|node[0-9]+\.example\.com(:[0-9]+)?|127.0.0.1\1|g' \
    -e 's|[A-Za-z0-9.-]+\.example\.com(:[0-9]+)?|127.0.0.1\1|g' \
    -e 's|@example\.com|@otedama.local|g' \
    "$f"
  echo "[cleanup] Updated: ${f#$repo_root/}" >&2
}

# Sanitize all usage README translations
if [ -d "$usage_dir" ]; then
  find "$usage_dir" -maxdepth 1 -type f -name 'README_*.md' -print0 | while IFS= read -r -d '' f; do
    sanitize_md "$f"
  done
fi

# Sanitize generator script here-doc content as well
gen="$usage_dir/generate_remaining_docs.sh"
if [ -f "$gen" ]; then
  sed -i -E \
    -e 's|https://github.com/otedama/otedama|https://github.com/shizukutanaka/Otedama|g' \
    -e 's|https://docs\.otedama\.io|../README.md|g' \
    -e 's|(https?)://([A-Za-z0-9-]+)\.otedama\.io|\1://\2.otedama.local|g' \
    -e 's|(https?)://otedama\.io|\1://otedama.local|g' \
    -e 's|(^[[:space:]]*)wget https://github.com/otedama/releases/latest/otedama-linux-amd64[[:space:]]*$|\1bash ./scripts/install.sh|g' \
    -e '/^[[:space:]]*chmod \+x otedama-linux-amd64[[:space:]]*$/d' \
    -e 's|stratum\+tcp://pool\.example\.com:3333|stratum+tcp://127.0.0.1:3333|g' \
    -e 's|node[0-9]+\.example\.com(:[0-9]+)?|127.0.0.1\1|g' \
    -e 's|[A-Za-z0-9.-]+\.example\.com(:[0-9]+)?|127.0.0.1\1|g' \
    -e 's|@example\.com|@otedama.local|g' \
    "$gen"
  echo "[cleanup] Updated: ${gen#$repo_root/}" >&2
fi

# Also sanitize all docs subdirectories (e.g., docs/ja/*.md)
docs_root="$repo_root/docs"
if [ -d "$docs_root" ]; then
  find "$docs_root" -mindepth 2 -maxdepth 2 -type f -name '*.md' -print0 | while IFS= read -r -d '' f; do
    sanitize_md "$f"
  done
fi

echo "[cleanup] Documentation URL cleanup complete." >&2
