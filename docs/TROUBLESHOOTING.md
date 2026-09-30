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
2. **CPU-only mining in 2026.** A single CPU produces roughly
   $0.0000004 per day at current Bitcoin difficulty. Shares may take
   days to appear even if everything is working.
3. **Stale jobs.** If your network latency to the pool exceeds the
   pool's stale threshold (usually 1-2 seconds), shares are rejected
   as "too late."

### Fix

1. Switch to a pool that accepts low-difficulty shares, or use a
   pool with a difficulty-tuning mode. Braiins pool and demand.sv2.io
   both auto-tune.
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

Related CLI tools: `otedama wallet verify` confirms a written-down
recovery phrase derives to the stored wallet without decrypting
`wallet.dat`; `otedama wallet change-passphrase` rotates the passphrase
once you are able to unlock it. See `docs/API.md#otedama-wallet`.

---

## Otedama uses 100% CPU and the system becomes unresponsive

### Symptom

Desktop freezes or slows dramatically while Otedama runs.

### Cause

Otedama's CPU worker uses all available cores by default, and Go's
scheduler does not yield to other processes the way OS processes do.

### Fix

Limit the number of mining threads:

```bash
otedama run --bitcoin-address bc1q... --worker-threads 4
```

Or set a CPU limit at the OS level:

- **systemd (Linux):** `CPUQuota=50%` in the service unit.
- **launchd (macOS):** no direct quota; use `nice`.
- **Windows:** Task Manager > Details > right-click otedama.exe > Set
  affinity.

On laptops you can also run Otedama under a systemd user unit or launchd
agent via `otedama service install`, then apply the OS-level limits above
to the installed unit. **Correction (session 491):** this paragraph
previously claimed the `service` option "binds Otedama to an idle
scheduling class automatically" — no service definition sets a scheduling
class or priority; the units only provide restart-on-failure and
auto-start.

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

1. Check `otedama doctor` output for pool latency variance. Anything
   above 500ms average suggests a routing issue.
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

The metrics registry has been created but the engine has not yet
emitted any metrics. At startup, this is normal — first metrics
appear after the first successful pool handshake (~2-5 seconds).

### Fix

Wait for 10 seconds after starting and retry. If still empty, check
logs for `engine:` entries — the engine loop may not have started.

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
LaunchDaemon (requires root and changes the security model — see
ADR-001).

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

1. Re-run `otedama doctor` — it already prints every check result
   (there is no quieter mode; **Correction (session 491):** the previous
   suggestion `otedama --log-level=debug doctor` could not work — flags
   belong after the subcommand, so that invocation fails with
   `unknown subcommand`, and `doctor` defines no `--log-level` flag
   anyway; only `run` and `service install` do). For verbose run-time
   logs, use `otedama run --log-level=debug ...`.
2. Search existing issues:
   https://github.com/shizukutanaka/Otedama/issues
3. Open a new issue using the bug-report template. Include:
   - Full `otedama doctor` output (scrub Bitcoin address if you wish)
   - Exact command line
   - 30-60 seconds of log output
   - OS and architecture
