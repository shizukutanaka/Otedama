# Troubleshooting

Most problems can be diagnosed automatically by running:

```bash
otedama doctor
```

This section covers issues that doctor cannot fix on its own.

---

## Mining starts but no shares are accepted

### Symptom

Otedama connects to the pool, but every share is rejected, or no share
is ever found.

### Cause

1. **Difficulty too high for your hardware.** Each pool sets a minimum
   share difficulty. If your hashrate produces shares slower than the
   pool's minimum, you appear idle.
2. **CPU-only mining in 2026.** The reference machine in
   `BENCHMARKS.md` (4 vCPU Xeon 2.10GHz, no SHA-NI) produces about
   $0.00000094 per day at current Bitcoin difficulty — the arithmetic
   and its inputs are in that file. Shares may take days to appear even
   when everything is working.
3. **Stale jobs.** If your network latency to the pool exceeds the
   pool's stale threshold (usually 1-2 seconds), shares are rejected
   as "too late."

### Fix

1. Switch to a pool that accepts low-difficulty shares, or one that
   tunes share difficulty to the connected miner (commonly called
   vardiff). Whether a given pool does this, and down to what minimum,
   is the pool's property and not something Otedama can report — check
   the pool's own documentation before switching.
2. There is no GPU speedup available today: Otedama detects GPUs
   (`otedama doctor`) but implements no CUDA/ROCm/Vulkan compute
   dispatch, so a GPU does not increase SHA-256d hashrate (see
   `docs/KNOWN_LIMITATIONS.md`). At current difficulty, CPU-only
   mining earnings are near-zero regardless of pool settings; this is
   a hardware/economics limit, not a configuration problem.
3. For high-latency connections (satellite, cellular), choose a pool
   geographically close to you. Check `otedama doctor`'s pool
   latency reading; anything above 200ms is likely to cause stale
   shares.

---

## "wallet: decrypt seed: invalid passphrase" after typing the correct passphrase

### Symptom

You are sure the passphrase is correct, but Otedama refuses to unlock
the wallet.

### Cause

1. **Keyboard layout mismatch.** The passphrase was typed with a
   different keyboard layout than the current session.
2. **Clipboard paste inserted invisible characters.** Some password
   managers paste a trailing newline or a zero-width character.
3. **Wallet file was moved between machines with different
   architectures.** This is fine — the encrypted seed is
   architecture-independent — but moving between OSes sometimes
   causes line-ending translation on copy. Verify the file is
   byte-identical to the original.

### Fix

1. Retype the passphrase manually in the current layout. Do not paste.
2. If using a password manager, disable "trim whitespace" or
   similar automation.
3. If you suspect file corruption, verify `shasum wallet.dat` matches
   what it was on the source machine.

**If none of the above help and you have lost the passphrase,** the
seed is unrecoverable. This is by design: the seed is encrypted with
scrypt + AES-GCM, and the passphrase is the only decryption key.
See `docs/adr/ADR-001-non-custodial-wallet.md` for why.

---

## Otedama uses 100% CPU and the system becomes unresponsive

### Symptom

Desktop freezes or slows dramatically while Otedama runs.

### Cause

Otedama starts one mining thread per logical CPU and keeps every one of
them busy: `miner.DefaultWorkerConfig` sets `Threads: runtime.NumCPU()`
(`internal/miner/worker.go`), and nothing lowers it. Hashing is a tight
loop with no idle time, so the scheduler has nothing to hand your
desktop between hashes.

### Fix

**There is no flag or config field for the thread count** — see
`docs/KNOWN_LIMITATIONS.md` §22. Constrain the process from outside
instead.

**Linux — restrict which CPUs the process may run on:**

```bash
taskset -c 0-3 otedama run --bitcoin-address bc1q...
```

`runtime.NumCPU()` reports the CPUs available to the process, so the
affinity mask sets the thread count directly. Measured on the reference
machine (4 vCPU, Go 1.24.7): unrestricted reports 4, `taskset -c 0`
reports 1, `taskset -c 0-1` reports 2.

**Linux, installed as a service — use a systemd drop-in, not an edit:**

```bash
systemctl --user edit otedama          # opens override.conf
# [Service]
# CPUAffinity=0-3
systemctl --user restart otedama
```

Edit the unit file itself and `otedama service install` will overwrite
your change the next time it runs — it regenerates
`~/.config/systemd/user/otedama.service` from a template
(`internal/daemon/service.go`). A drop-in lives in a separate
`otedama.service.d/` directory and survives. `CPUQuota=` works here too,
but only if the cpu controller is delegated to your user manager; if the
quota appears to do nothing, that delegation is why, and `CPUAffinity=`
is the reliable option.

**macOS:** there is no `taskset` equivalent. `nice` lowers priority but
does not reduce the thread count, so it helps interactivity and not much
else.

**Windows:** Task Manager > Details > right-click otedama.exe > Set
affinity, or launch with `start /affinity`.

---

## Pool connection drops every few minutes

### Symptom

Logs show repeated `engine: connecting to ...` messages.

### Cause

1. **Intermittent network.** Home ISPs, hotel wifi, and mobile
   hotspots often drop connections every 5-30 minutes.
2. **Pool rate-limiting.** Some pools terminate idle-looking
   connections aggressively.
3. **Firewall timeouts.** Corporate or router-level stateful firewalls
   drop long-lived TCP connections silently.

### Fix

1. Check the "Pool reachability" line in `otedama doctor` output. It
   reports the time of a single TCP connect to the pool, not a variance
   or an average over samples — run it a few times if you want a sense
   of the spread. Anything consistently above 500ms suggests a routing
   issue.
2. Use a pool closer to you geographically.
3. If behind a corporate firewall, see if your admin can whitelist
   the pool address.

Otedama reconnects automatically with exponential backoff (1s, 2s,
4s, ... up to 64s). Intermittent disconnects reduce earnings but do
not require manual intervention.

---

## Metrics endpoint returns empty

### Symptom

`curl http://127.0.0.1:9090/metrics` returns no metrics, only comments.

### Cause

The engine is not running. Metric registration is the first thing
`engine.Run` does — before the wallet, hardware detection, or any pool
connection (`internal/engine/run.go`) — so a live engine serves the full
set of counters and gauges immediately, with zero values until work
starts. An endpoint that returns only comments means the HTTP server is
up but the engine never got past startup, or exited.

### Fix

Check the log for `engine:` entries. `engine: detected N device(s)` means
registration already happened and the endpoint should be populated; no
`engine:` lines at all means startup failed earlier — the error is on
stderr. Note that zero-valued metrics are not an empty endpoint: a
freshly started miner legitimately reports
`otedama_shares_total{status="accepted"} 0`.

---

## Service does not start on login

### Symptom

`otedama service status` shows "installed, stopped" after login.

### Cause

The systemd user unit requires lingering to be enabled for users
who log out without an active session (e.g. headless SSH servers).

### Fix (Linux)

```bash
loginctl enable-linger $USER
```

Without lingering, the user service stops when the last session ends.
This is a feature (no zombie processes on multi-user systems) but
surprising on personal machines.

### Fix (macOS)

macOS LaunchAgents run when the user is logged in via the GUI. If
you SSH in without a GUI login, the agent does not start. Log in
via the desktop at least once, or switch to a system-level
LaunchDaemon. Otedama does not install a LaunchDaemon and no ADR
covers that choice: `otedama service install` writes a per-user
LaunchAgent to `~/Library/LaunchAgents`
(`internal/daemon/service.go`). Running as root changes the security
model — the wallet would be created and owned by root — so that is a
decision to make deliberately, not a supported configuration.

---

## Build fails with "cannot find module"

### Symptom

`go build ./...` prints "cannot find module for path ..."

### Cause

`go.sum` is out of date or `GOPROXY` is misconfigured.

### Fix

```bash
go mod download
go mod verify
go mod tidy
```

If this still fails, ensure `go env GOPROXY` includes `https://proxy.golang.org`.

---

## Still stuck?

1. Collect machine-readable diagnostics and a debug-level run log:
   ```bash
   otedama doctor --json
   otedama run --bitcoin-address bc1q... --log-level debug
   ```
   `--log-level` belongs to `run`, not to `doctor`, and Otedama has no
   global flags before the subcommand: the first argument must be the
   subcommand name, so `otedama --log-level=debug doctor` exits 64 with
   "unknown subcommand". `doctor` takes `--json` for a structured
   report.
2. Search existing issues:
   https://github.com/shizukutanaka/Otedama/issues
3. Open a new issue using the bug-report template. Include:
   - Full `otedama doctor` output (scrub Bitcoin address if you wish)
   - Exact command line
   - 30-60 seconds of log output
   - OS and architecture
