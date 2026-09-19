---
name: testing-otedama-cli
description: How to end-to-end test the otedama CLI (wallet verify/change-passphrase, TUI width, run) on a local checkout, including PTY tricks for terminal-width assertions.
---

# Testing the Otedama CLI end-to-end

## Build

```sh
export PATH=/opt/homebrew/bin:$PATH   # repo needs Go >=1.24; do not use system go
cd /Users/devin/repos/Otedama
go build -o /tmp/otedama-test/otedama ./cmd/otedama
```

## Running `otedama run` without a network

`run` requires a checksum-valid mainnet address (config.Validate → btccrypto.ValidateAddress,
so made-up strings fail with exit 78). A known-good test vector used throughout the repo's
own tests is:

```
bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq
```

Wallet creation happens in engine Phase 1, *before* any pool dial, so it works fully
offline. To mint a wallet non-interactively:

```sh
/tmp/otedama-test/otedama run \
  --bitcoin-address bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq \
  --wallet-passphrase "<pass>" --data-dir /tmp/some-dir --no-tui \
  > /tmp/some-dir/run.out 2>&1 &
```

`run.out` then contains the one-time "WALLET RECOVERY PHRASE" box (24 words, fingerprint).
The wallet only exists if `--wallet-passphrase` is non-empty. Kill the process once
`wallet.dat` + `wallet.fingerprint` exist — pool reconnect loops forever offline.

## `wallet verify` / `change-passphrase` exit-code contract

- `verify`: 0 = fingerprint match, 1 = valid phrase but wrong wallet / missing wallet /
  unlock failure, 64 = malformed phrase (bad word count, unknown word, checksum fail) or
  flag-usage error. Phrase comes from **stdin only** — positional argv words are ignored
  by flag.Parse, so a phrase on argv + empty stdin yields exit 64, not 0.
- `storedFingerprint` tries `wallet.fingerprint` first, then decrypts `wallet.dat` using
  `--wallet-passphrase`/`OTEDAMA_WALLET_PASSPHRASE`. To exercise the decrypt path, remove
  or rename the sidecar file.
- `change-passphrase` reads `OTEDAMA_WALLET_PASSPHRASE` / `OTEDAMA_WALLET_NEW_PASSPHRASE`
  (or `--old-passphrase`/`--new-passphrase` flags). Missing wallet.dat → exit 1 and the
  directory stays empty (there is an explicit guard so a new wallet is never minted).
- Valid-but-wrong BIP-39 vectors: `"abandon "*23 + "art"` (24 words, valid checksum) and
  `"abandon "*11 + "about"` (12 words) — both must produce exit 1 MISMATCH, not 64.

## TUI width testing without resizing a real window

The dashboard pads every rendered line to exactly `cols`, so terminal width is measurable
from captured output. macOS `script(1)` allocates a PTY whose size `stty` can set:

```sh
script -q /tmp/tui.out bash -c 'stty cols 132; exec otedama run --bitcoin-address … \
  --data-dir /tmp/x --wallet-passphrase pw' &
sleep 5; pkill -INT -f 'data-dir /tmp/x'
```

Then strip ANSI escapes and measure line lengths:

```sh
perl -pe 's/\x1b\[[0-9;?]*[a-zA-Z]//g; s/[\x00-\x08\x0b-\x1f]//g' /tmp/tui.out \
  | awk '{ l=length($0); if (l>40) c[l]++ } END { for (k in c) print k, c[k] }' | sort -n
```

Dashboard frame lines appear at exactly the PTY width (132), bounded at narrow widths
(50), and at 80 when the PTY winsize is 0 (`script` under a non-tty parent reports
`stty size` = `0 0` → DetectWidth→0→80 fallback). Lines *longer* than the PTY width are
pre-dashboard startup log lines written to stdout before the TUI starts — not a bug.

For a live visual demo: run `script -q /dev/null bash -c 'stty cols 50; exec otedama run …'`
inside a real fullscreen terminal — the dashboard visibly renders in only the top-left
50 columns of a wide window. Terminal.app ignores the `\e[8;rows;cols;t` resize escape;
`script`+`stty` is the reliable alternative.

## Gotchas

- `isTerminal` checks `os.ModeCharDevice`, so `/dev/null` counts as a TTY: the
  "Enter recovery phrase…" prompt prints even with stdin=/dev/null (cosmetic only).
- A dir with only `wallet.fingerprint` (no wallet.dat) verifies exit 0 and claims the
  phrase "matches …/wallet.dat" — the sidecar alone is authoritative.
- `doctor` exit code is 0/1/2 (pass/warn/fail); on an offline box pool-reachability
  fails with exit 2 — environmental, not a regression.
