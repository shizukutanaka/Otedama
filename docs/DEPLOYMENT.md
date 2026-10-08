# Deployment Guide

This document covers running Otedama in production environments. For
getting-started instructions, see `README.md`. For issues during
deployment, see `TROUBLESHOOTING.md`.

---

## Deployment matrix

| Environment       | Recommended approach              | Notes |
|-------------------|-----------------------------------|-------|
| Home desktop      | `otedama service install`         | systemd user service / LaunchAgent |
| Home server       | `otedama service install`         | Enable lingering on Linux |
| Cloud VM          | systemd + EnvironmentFile         | One Otedama per VM; no sharding needed |
| Kubernetes        | Deployment + liveness probes      | Scrape `/metrics` with Prometheus |
| Docker Compose    | `docker run --restart unless-stopped` | Volume-mount data dir |
| Embedded (RasPi)  | `otedama service install`         | `CPUQuota=80%` to leave OS headroom |

---

## systemd (Linux)

### User service (recommended)

```bash
otedama service install \
  --config /home/alice/.config/otedama/config.yaml \
  --data-dir /home/alice/.local/share/otedama
```

This writes `~/.config/systemd/user/otedama.service` and enables it.
The unit applies these security hardening options by default:

- `NoNewPrivileges=true`
- `ProtectHome=read-only`
- `PrivateTmp=true`
- `Restart=on-failure`, `RestartSec=10s`

On headless machines without persistent GUI sessions, enable
lingering so the service survives logout:

```bash
sudo loginctl enable-linger alice
```

### System service (not recommended)

Running Otedama as root is overkill — Bitcoin mining does not need
any privilege the user's own account does not have. If your
organisation requires a system service:

```ini
[Unit]
Description=Otedama (system service)
After=network-online.target

[Service]
Type=simple
User=otedama
Group=otedama
ExecStart=/usr/local/bin/otedama run --config /etc/otedama/config.yaml
Restart=on-failure

# Hardening
NoNewPrivileges=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/otedama
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
RestrictNamespaces=true
RestrictAddressFamilies=AF_INET AF_INET6
SystemCallArchitectures=native
SystemCallFilter=@system-service

[Install]
WantedBy=multi-user.target
```

Create a dedicated user first:

```bash
sudo useradd --system --home /var/lib/otedama --shell /usr/sbin/nologin otedama
sudo mkdir -p /var/lib/otedama /etc/otedama
sudo chown otedama:otedama /var/lib/otedama
```

---

## launchd (macOS)

### User agent

```bash
otedama service install \
  --data-dir ~/Library/Application\ Support/Otedama
```

This writes `~/Library/LaunchAgents/com.otedama.daemon.plist` and
loads it immediately. The agent starts at login and is terminated
at logout — this is the correct model for a home-mining tool.

### Restart policy

The plist includes `KeepAlive=true` so Otedama restarts on crash.
Stop it cleanly with:

```bash
otedama service uninstall
```

---

## Windows

### As a Windows service

`sc.exe` registration requires administrator privileges:

```powershell
# Run as Administrator
otedama service install --config C:\ProgramData\Otedama\config.yaml
```

Otedama registers itself under the service name `Otedama` with
`DisplayName=Otedama Mining Service` and `start=auto`.

To view logs:

**Correction (session 485):** this section previously suggested
`Get-EventLog -LogName Application -Source Otedama`, but Otedama
never registers a Windows event source — that command fails with
"Cannot find source". The SCM-launched service's stdout is also
discarded (the generated `binPath` passes no `--log-file`), so
today there is no persistent log for the Windows service. To
capture logs, run `otedama run --log-file C:\ProgramData\Otedama\otedama.log`
in a console, or wrap the service binary in a redirecting
launcher. Service-side log capture is a maintainer-owned gap.

---

## Docker

### Image

Pull the official image (built from `Dockerfile`):

```bash
docker pull ghcr.io/shizukutanaka/otedama:v3.0.0-alpha.1
```

Images are built on a distroless base. Cosign/Sigstore image signing is
**not yet implemented** — it is a planned v3.1.0 item
(`ROADMAP.md` "Real protocols"; no current workflow signs images). Do not
rely on `cosign verify` until that ships; verify provenance via the
GitHub Actions build log in the meantime.

### Run

```bash
docker run -d \
  --name otedama \
  --restart unless-stopped \
  -v otedama-data:/var/lib/otedama \
  -p 127.0.0.1:9090:9090 \
  -e OTEDAMA_BITCOIN_ADDRESS=<your-bitcoin-address> \
  -e OTEDAMA_DATA_DIR=/var/lib/otedama \
  ghcr.io/shizukutanaka/otedama:v3.0.0-alpha.1 \
  run --http-addr=0.0.0.0:9090
```

`OTEDAMA_DATA_DIR` must point at the mounted volume — without it, Otedama
falls back to its OS-default data directory (`config.DefaultDataDir()`),
which inside the container is not the volume you mounted, so the
Lightning wallet would be written to the container's writable layer and
lost on recreate.

### docker-compose.yaml

```yaml
services:
  otedama:
    image: ghcr.io/shizukutanaka/otedama:v3.0.0-alpha.1
    restart: unless-stopped
    command:
      - run
      - --http-addr=0.0.0.0:9090
    environment:
      # Replace with YOUR address — the placeholder fails config
      # validation loudly. (Previously this file shipped the real
      # genesis-block coinbase address as the example; a verbatim copy
      # would pass validation and send all rewards to an unspendable
      # address. — session 500)
      OTEDAMA_BITCOIN_ADDRESS: "<your-bitcoin-address>"
      OTEDAMA_LOG_FORMAT: json
      OTEDAMA_DATA_DIR: /var/lib/otedama
    ports:
      - "127.0.0.1:9090:9090"
    volumes:
      - otedama-data:/var/lib/otedama
    # `otedama doctor` exits 1 on warnings and 2 on failures, so a
    # routine single-pool config (which warns on "Pool diversity")
    # reports the container as unhealthy. That is intentional if you
    # want warn-as-degraded; drop the healthcheck or gate on exit 2
    # in an orchestrator if you only want hard failures.
    healthcheck:
      test: ["CMD", "/usr/local/bin/otedama", "doctor"]
      interval: 5m
      timeout: 30s
      retries: 3

volumes:
  otedama-data:
```

---

## Kubernetes

### Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: otedama
  labels:
    app: otedama
spec:
  replicas: 1  # Otedama does not shard; one replica per mining target.
  selector:
    matchLabels:
      app: otedama
  template:
    metadata:
      labels:
        app: otedama
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
        prometheus.io/path: "/metrics"
    spec:
      containers:
      - name: otedama
        image: ghcr.io/shizukutanaka/otedama:v3.0.0-alpha.1
        args:
        - run
        - --http-addr=0.0.0.0:9090
        - --log-format=json
        env:
        - name: OTEDAMA_BITCOIN_ADDRESS
          valueFrom:
            secretKeyRef:
              name: otedama-secrets
              key: bitcoin-address
        - name: OTEDAMA_WALLET_PASSPHRASE
          valueFrom:
            secretKeyRef:
              name: otedama-secrets
              key: wallet-passphrase
        - name: OTEDAMA_DATA_DIR
          value: /var/lib/otedama
        ports:
        - name: metrics
          containerPort: 9090
        livenessProbe:
          httpGet:
            path: /healthz
            port: metrics
          initialDelaySeconds: 10
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /readyz
            port: metrics
          initialDelaySeconds: 5
          periodSeconds: 10
        resources:
          requests:
            cpu: "1"
            memory: "32Mi"
          limits:
            memory: "128Mi"
        securityContext:
          runAsNonRoot: true
          runAsUser: 65532
          readOnlyRootFilesystem: true
          allowPrivilegeEscalation: false
          capabilities:
            drop: ["ALL"]
        volumeMounts:
        - name: data
          mountPath: /var/lib/otedama
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: otedama-data
```

### Secret

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: otedama-secrets
type: Opaque
stringData:
  # Replace with YOUR address — see the note in docker-compose.yaml above.
  bitcoin-address: "<your-bitcoin-address>"
  wallet-passphrase: your-strong-passphrase-here
```

### PersistentVolumeClaim

The Deployment above mounts `otedama-data` — it must exist:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: otedama-data
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 1Gi
```

### Service

The `ServiceMonitor` below selects `app: otedama`, so a `Service` fronting
the pod is required for scraping to work (previously missing from this
example — a ServiceMonitor selects Services, not pods):

```yaml
apiVersion: v1
kind: Service
metadata:
  name: otedama
  labels:
    app: otedama
spec:
  selector:
    app: otedama
  ports:
  - name: metrics   # must match ServiceMonitor.endpoints[].port
    port: 9090
    targetPort: metrics
```

### ServiceMonitor (Prometheus Operator)

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: otedama
spec:
  selector:
    matchLabels:
      app: otedama
  endpoints:
  - port: metrics
    interval: 30s
    path: /metrics
```

---

## Observability

### Metrics

All exported metrics live under the `otedama_` prefix:

- `otedama_hashrate_hashes_per_second` — gauge, live aggregate hash rate
- `otedama_shares_total{status}` — counter, pool-reported shares
  (`status` is `accepted` or `rejected` only; **correction, session
  1727:** submitted shares are a separate metric,
  `otedama_shares_submitted_total` — this row previously implied a
  `status="submitted"` label that does not exist)
- `otedama_shares_submitted_total` — counter, shares sent to the pool
- `otedama_pool_connection_state` — gauge, 0=disconnected, 1=connecting, 2=connected
- `otedama_submit_latency_milliseconds{quantile}` — gauge, share submit round-trip time (p50/p95/p99)
- `otedama_arbitration_switches_total` — counter, workload reroutes (mining ↔ AI)
- `otedama_btc_usd_rate` — gauge, current BTC/USD rate from provider consensus

See docs/SPECIFICATION.md §6 for the full, CI-verified metric catalogue
(`internal/engine.TestMetricsDocumentedInSpecification` fails the build if a
registered metric is undocumented there). This section is a curated subset
for dashboard/alert authors and is not itself CI-checked, so if in doubt
trust docs/SPECIFICATION.md §6.

### Dashboards

A reference Grafana dashboard is planned for `contrib/grafana/`
in v3.1.0 — **correction (session 485):** this section previously
said the dashboard "lives at" `contrib/grafana/otedama-dashboard.json`,
but `contrib/` does not exist yet; the path is a target, not a
current file.

### Alerts

Minimal alert set:

```yaml
- alert: OtedamaDown
  expr: up{job="otedama"} == 0
  for: 5m
  annotations:
    summary: "Otedama instance {{ $labels.instance }} is down"

- alert: OtedamaPoolDisconnected
  expr: otedama_pool_connection_state == 0
  for: 10m
  annotations:
    summary: "Otedama lost pool connection on {{ $labels.instance }}"

- alert: OtedamaShareRejectionHigh
  expr: |
    (
      rate(otedama_shares_total{status="rejected"}[5m])
      /
      rate(otedama_shares_total[5m])
    ) > 0.05
  for: 10m
  annotations:
    summary: "Share rejection rate above 5% on {{ $labels.instance }}"
```

### SLO guidance

Suggested service-level objectives for a healthy deployment. These are
guidance values, not guarantees — tune to your pool's vardiff behaviour
and link quality. The alerts above implement the first three.

| Objective | Target | Metric / signal |
|-----------|--------|-----------------|
| Process availability | `otedama_up` = 1 ≥ 99% per 30d | scrape `up` / `otedama_up` |
| Pool connectivity | `otedama_pool_connection_state` = 2 ≥ 99% per 24h | `otedama_pool_connection_state` |
| Share acceptance | rejects ≤ 5% of submits per 10m window | `otedama_shares_total{status}` ratio |
| Submit latency | p50 < 200 ms, p99 < 500 ms per 24h | `otedama_submit_latency_milliseconds{quantile}` |

Submit round-trip time is the leading driver of stale shares — the
slower a share's accept, the likelier the job it answers has been
superseded. A sustained p99 above ~500 ms warrants checking the pool
endpoint, path quality, or the per-session submit limiter before
concluding the pool is at fault.

---

## Upgrading

1. Read the [CHANGELOG.md](../CHANGELOG.md) for breaking changes.
2. Back up `~/.local/share/otedama/wallet.dat` (or equivalent).
3. Run the new version against `otedama doctor` before switching
   the main service.
4. Use the same wallet passphrase; seeds are forward-compatible
   across minor versions.

`wallet.fingerprint` needs no backup — the daemon recreates it the
first time it opens a wallet.dat that lacks one.

---

## Backup and recovery

Two files are valuable:

- `wallet.dat` — encrypted BIP-39 seed. Losing it loses all mined
  funds on that seed unless you have the mnemonic.
- `config.yaml` — easy to recreate, but keeping a copy saves time.

Back up at creation time:

```bash
cp ~/.local/share/otedama/wallet.dat /path/to/offsite/backup/
```

**The mnemonic printed on first run is the canonical backup.** Write
it on paper, store it in a fireproof location. A lost wallet.dat
recoverable from mnemonic. A lost mnemonic AND wallet.dat is not.

Verify the written phrase actually derives to the stored wallet before
relying on it — `otedama wallet verify` reads the phrase from stdin and
compares public fingerprints without decrypting `wallet.dat`:

```bash
otedama wallet verify
# paste the 24-word phrase at the prompt — exit 0 on match
```

---

## Hardening checklist

For production deployments:

- [ ] Binary SHA-256 verified against published checksums.
  (Note, session 485: today's `release.yml` does not produce
  checksums, signatures, or SBOMs — see KNOWN_LIMITATIONS. Until
  the release pipeline ships them, verify provenance via the
  GitHub Actions build log instead.)
- [ ] Binary cosign signature verified — **not currently possible:**
  no release pipeline signs binaries (correction, session 485).
- [ ] Running as a dedicated, non-root user.
- [ ] Wallet passphrase passed via secret store (not `--wallet-passphrase` on command line).
- [ ] Data directory permissions are 0700.
- [ ] Firewall restricts inbound traffic; only outbound to pool + rate sources.
- [ ] Prometheus scrape port bound to localhost or private network.
- [ ] Pin the deployed container image to an immutable tag/digest and
  update it deliberately. (Correction, session 485: this item
  previously suggested "Dependabot for the Otedama container image
  tag" — the repo's Dependabot `docker` ecosystem only updates the
  *build* base-image pins in `Dockerfile`; it does not update an
  operator's deployed image.)
- [ ] Monthly review of `otedama doctor` output.
