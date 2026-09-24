#!/bin/sh
# post-install for the deb/rpm system packages (fpm --after-install).
set -e

# Dedicated system user for the unit's User=otedama.
if ! getent passwd otedama >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin otedama || true
fi
mkdir -p /var/lib/otedama /etc/otedama
chown otedama:otedama /var/lib/otedama 2>/dev/null || true
chmod 750 /var/lib/otedama

if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload >/dev/null 2>&1 || true
fi
echo "otedama installed. Edit /etc/otedama/config.yaml (bitcoin_address is"
echo "required), then: systemctl enable --now otedama.service"
