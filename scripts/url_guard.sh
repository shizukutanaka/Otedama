#!/usr/bin/env bash
# URL Guard: fail if disallowed external URLs or placeholder domains are present
# Allowed URLs:
#   - https://otedama.local, https://api.otedama.local, https://monitoring.otedama.local
#   - http(s)://localhost[:port], http(s)://127.0.0.1[:port]
# Disallowed patterns:
#   - http(s)://... anything not in the allow-list
#   - example.com occurrences (including pool.example.com, node*.example.com)
#   - staging.otedama.io, *.otedama.io (except allowed local hostnames above)

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO_ROOT"

# Collect tracked files and filter out heavy/binary directories
FILES=$(git ls-files | grep -Ev '^(vendor/|node_modules/|build/|dist/|.git/|.vscode/|.idea/)' || true)

if [[ -z "$FILES" ]]; then
  echo "No files to scan."
  exit 0
fi

# Exclude files that intentionally contain legacy URLs for replacement logic
EXCLUDES_REGEX='^(scripts/cleanup-doc-urls\.ps1|scripts/cleanup-doc-urls\.sh)$'

# Grep helper that respects excludes
_grep() {
  local pattern="$1"; shift
  echo "$FILES" | grep -Ev "$EXCLUDES_REGEX" | xargs -r grep -RInE -- "$pattern" || true
}

fail=0

# 1) Detect legacy GitHub org path (should be shizukutanaka/Otedama)
LEGACY_GH=$(_grep 'https?://github\.com/otedama/otedama[^[:space:]]*')
if [[ -n "$LEGACY_GH" ]]; then
  echo "Legacy GitHub org URL detected (use github.com/shizukutanaka/Otedama):" >&2
  echo "$LEGACY_GH" >&2
  fail=1
fi

# 2) Detect docs.otedama.io site references (should use relative docs path)
DOCS_SITE=$(_grep 'https?://docs\.otedama\.io[^[:space:]]*')
if [[ -n "$DOCS_SITE" ]]; then
  echo "Public docs site URLs detected (use relative docs links like ../README.md):" >&2
  echo "$DOCS_SITE" >&2
  fail=1
fi

# 3) Detect placeholder/example domains (regardless of scheme)
EXAMPLE_OCCURS=$(_grep '(^|[^A-Za-z0-9_.-])example\.com([^A-Za-z0-9_.-]|$)')
if [[ -n "$EXAMPLE_OCCURS" ]]; then
  echo "Placeholder domain 'example.com' detected:" >&2
  echo "$EXAMPLE_OCCURS" >&2
  fail=1
fi

# 4) Detect otedama.io over-the-internet references (not emails), only URLs
OTEDAMA_IO_URLS=$(_grep 'https?://[^ ]*otedama\.io[^[:space:]]*')
if [[ -n "$OTEDAMA_IO_URLS" ]]; then
  echo "Public otedama.io URLs detected (use local/internal or relative docs links):" >&2
  echo "$OTEDAMA_IO_URLS" >&2
  fail=1
fi

if [[ $fail -ne 0 ]]; then
  cat >&2 <<'EOF'
Fix guidelines:
- Replace http(s) URLs with internal/local:
  * https://otedama.local, https://api.otedama.local, https://monitoring.otedama.local
  * http(s)://localhost[:port] or http(s)://127.0.0.1[:port]
- Replace stratum examples with: stratum+tcp://127.0.0.1:3333
- Remove example.com and staging.otedama.io placeholders.
- Replace docs links with relative: ../README.md (from docs/multilingual/<lang>) or appropriate relative path.
EOF
  exit 1
fi

echo "URL guard passed."
