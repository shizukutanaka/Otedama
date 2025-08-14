#!/usr/bin/env bash
# Rebuild non-English docs from English reference for 50 languages.
# Usage: ./scripts/rebuild-docs-50.sh [--dry-run]

set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
DOCS="$REPO_ROOT/docs"
EN="$DOCS/en"
EXTRA_EN="$DOCS/multilingual/en"

info() { printf "\033[36m[INFO]\033[0m %s\n" "$*"; }
ok()   { printf "\033[32m[ OK ]\033[0m %s\n" "$*"; }
warn() { printf "\033[33m[WARN]\033[0m %s\n" "$*"; }

if [[ ! -d "$EN" ]]; then
  echo "English reference not found: $EN" >&2
  exit 1
fi

# 50 languages total including English; we will rebuild 49 non-English dirs
LANGS=(
  en ja zh ko de fr es it pt ru 
  nl sv no da fi pl cs sk sl ro 
  hu bg uk el tr ar he fa hi bn 
  ur ta te ml mr th vi id ms tl 
  sr hr lt lv et az ka kk ne si
)

info "Docs root: $DOCS"
info "English ref: $EN"
[[ -d "$EXTRA_EN" ]] && info "Extras found: $EXTRA_EN"

# 1) Remove all existing non-English language directories matching list
for lang in "${LANGS[@]}"; do
  [[ "$lang" == "en" ]] && continue
  d="$DOCS/$lang"
  if [[ -d "$d" ]]; then
    if [[ $DRY_RUN -eq 1 ]]; then
      warn "Would remove: $d"
    else
      rm -rf "$d"
      ok "Removed: $d"
    fi
  fi
done

# 2) Recreate per-language directories by copying from English
for lang in "${LANGS[@]}"; do
  [[ "$lang" == "en" ]] && continue
  target="$DOCS/$lang"
  if [[ $DRY_RUN -eq 1 ]]; then
    warn "Would create: $target"
    warn "Would copy: $EN -> $target"
    if [[ -d "$EXTRA_EN" ]]; then warn "Would copy extras: $EXTRA_EN -> $target"; fi
    continue
  fi
  mkdir -p "$target"
  cp -a "$EN/." "$target/"
  if [[ -d "$EXTRA_EN" ]]; then
    cp -a "$EXTRA_EN/." "$target/" || true
  fi
  ok "Rebuilt: $lang"
done

# 3) Remove deprecated trees
for dep in "$DOCS/usage" "$DOCS/multilingual"; do
  if [[ -e "$dep" ]]; then
    if [[ $DRY_RUN -eq 1 ]]; then
      warn "Would remove deprecated: $dep"
    else
      rm -rf "$dep"
      ok "Removed deprecated: $dep"
    fi
  fi
done

ok "Languages rebuilt (preview if dry-run)."
