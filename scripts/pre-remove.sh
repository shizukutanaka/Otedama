#!/bin/sh
# pre-remove for the deb/rpm system packages (fpm --before-remove).
set -e
if command -v systemctl >/dev/null 2>&1; then
    systemctl stop otedama.service >/dev/null 2>&1 || true
    systemctl disable otedama.service >/dev/null 2>&1 || true
fi
