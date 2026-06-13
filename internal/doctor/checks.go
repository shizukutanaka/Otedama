// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package doctor — checks.go
//
// The built-in diagnostic checks (DefaultChecks) and the small private
// helpers they rely on. The check framework itself — Status, Result,
// Check, Report, Runner — lives in doctor.go.

package doctor

import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/shizukutanaka/Otedama/internal/btccrypto"
	"github.com/shizukutanaka/Otedama/internal/config"
)

// DefaultChecks returns the built-in check set for a config.
// Additional checks can be appended by callers before running.
func DefaultChecks(cfg config.Config, configPath string) []Check {
	return []Check{
		checkConfig(cfg, configPath),
		checkBitcoinAddress(cfg.BitcoinAddress),
		checkFailoverAddresses(cfg.BitcoinAddresses),
		checkDataDir(cfg.DataDir),
		checkWallet(cfg.DataDir),
		checkPoolReachability(cfg),
		checkPoolDiversity(cfg),
		checkPoolEndpointDiversity(cfg),
		checkPayoutScheme(cfg),
		checkHardware(),
		checkNetwork(),
	}
}

func checkConfig(cfg config.Config, path string) Check {
	return Check{
		Name: "Configuration",
		Run: func(_ context.Context) Result {
			if path == "" {
				return Result{
					Status: StatusWarn,
					Detail: "no config file found; using defaults and env vars",
					Fix:    "create ~/.config/otedama/config.yaml (see config.yaml.example)",
				}
			}
			if _, err := os.Stat(path); err != nil {
				return Result{
					Status: StatusWarn,
					Detail: fmt.Sprintf("config file %q not found", path),
					Fix:    "pass --config /path/to/config.yaml or create the default file",
				}
			}
			if err := cfg.Validate(); err != nil {
				return Result{
					Status: StatusFail,
					Detail: fmt.Sprintf("config invalid: %v", err),
					Fix:    "edit the config file or pass missing flags on the command line",
				}
			}
			return Result{
				Status: StatusPass,
				Detail: fmt.Sprintf("loaded from %s", path),
			}
		},
	}
}

func checkBitcoinAddress(addr string) Check {
	return Check{
		Name: "Bitcoin address",
		Run: func(_ context.Context) Result {
			if addr == "" {
				return Result{
					Status: StatusFail,
					Detail: "no address configured",
					Fix:    "pass --bitcoin-address bc1q... or set OTEDAMA_BITCOIN_ADDRESS",
				}
			}
			if !isLikelyBitcoinAddress(addr) {
				return Result{
					Status: StatusFail,
					Detail: fmt.Sprintf("%q does not look like a valid address", addr),
					Fix:    "verify the address — typos here would send your earnings to strangers",
				}
			}
			// Verify the address checksum (bech32/bech32m for bc1…,
			// Base58Check for 1…/3…). This catches a single-character typo
			// that the prefix-and-charset check above cannot — the kind of
			// mistake that silently sends earnings to a wrong or undecodable
			// address.
			if _, err := btccrypto.ValidateAddress(strings.TrimSpace(addr)); err != nil {
				return Result{
					Status: StatusFail,
					Detail: fmt.Sprintf("%s: %v", maskAddress(addr), err),
					Fix:    "re-check the address character by character; the checksum does not match (likely a typo)",
				}
			}
			return Result{
				Status: StatusPass,
				Detail: fmt.Sprintf("%s (%s, likely valid)", maskAddress(addr), addressKind(addr)),
			}
		},
	}
}

// addressKind returns a short human-readable label for the payout address
// type so `doctor` confirms it understood the address — in particular that a
// bech32m Taproot (bc1p…) address is recognised, not just bech32 v0 (bc1q…).
func addressKind(addr string) string {
	switch btccrypto.ClassifyAddress(strings.TrimSpace(addr)) {
	case btccrypto.AddressP2PKH:
		return "P2PKH legacy"
	case btccrypto.AddressP2SH:
		return "P2SH"
	case btccrypto.AddressP2WPKH:
		return "P2WPKH SegWit v0"
	case btccrypto.AddressP2WSH:
		return "P2WSH SegWit v0"
	case btccrypto.AddressP2TR:
		return "P2TR Taproot"
	default:
		return "unrecognised type"
	}
}

// checkFailoverAddresses validates the optional bitcoin_addresses failover
// list (session 56) so doctor catches a typo in a backup address, not just
// the primary. A typo here would silently send earnings elsewhere if
// failover ever reached it.
func checkFailoverAddresses(addrs []string) Check {
	return Check{
		Name: "Failover payout addresses",
		Run: func(_ context.Context) Result {
			if len(addrs) == 0 {
				return Result{Status: StatusSkip, Detail: "none configured"}
			}
			for i, a := range addrs {
				if a == "" || !isLikelyBitcoinAddress(a) {
					return Result{
						Status: StatusFail,
						Detail: fmt.Sprintf("bitcoin_addresses[%d] %q does not look valid", i, a),
						Fix:    "verify every failover address — a typo would send earnings to strangers",
					}
				}
				// Verify the checksum (bech32 or Base58Check) for every failover
				// address too, so a mistyped backup is caught at diagnosis
				// rather than only if failover ever reaches it.
				if _, err := btccrypto.ValidateAddress(strings.TrimSpace(a)); err != nil {
					return Result{
						Status: StatusFail,
						Detail: fmt.Sprintf("bitcoin_addresses[%d] %s: %v", i, maskAddress(a), err),
						Fix:    "re-check the failover address; its checksum does not match (likely a typo)",
					}
				}
			}
			return Result{
				Status: StatusPass,
				Detail: fmt.Sprintf("%d failover address(es), all likely valid", len(addrs)),
			}
		},
	}
}

func checkDataDir(dir string) Check {
	return Check{
		Name: "Data directory",
		Run: func(_ context.Context) Result {
			if dir == "" {
				// Use the default location.
				home, err := os.UserHomeDir()
				if err != nil {
					return Result{Status: StatusSkip, Detail: "no home directory"}
				}
				dir = filepath.Join(home, ".local", "share", "otedama")
			}

			info, err := os.Stat(dir)
			if os.IsNotExist(err) {
				return Result{
					Status: StatusWarn,
					Detail: fmt.Sprintf("%s does not exist (will be created on first run)", dir),
				}
			}
			if err != nil {
				return Result{
					Status: StatusFail,
					Detail: fmt.Sprintf("cannot stat %s: %v", dir, err),
					Fix:    "check filesystem permissions",
				}
			}
			if !info.IsDir() {
				return Result{
					Status: StatusFail,
					Detail: fmt.Sprintf("%s is not a directory", dir),
					Fix:    "remove the file and restart Otedama",
				}
			}
			// On Unix, verify the permissions are restrictive (wallet lives here).
			if runtime.GOOS != "windows" {
				perm := info.Mode().Perm()
				if perm&0077 != 0 {
					return Result{
						Status: StatusWarn,
						Detail: fmt.Sprintf("%s has permissions %04o (world/group readable)", dir, perm),
						Fix:    fmt.Sprintf("run: chmod 0700 %s", dir),
					}
				}
			}
			return Result{
				Status: StatusPass,
				Detail: fmt.Sprintf("%s (exists, writable)", dir),
			}
		},
	}
}

// walletDatFile and walletFingerprintFile mirror the constants in
// internal/lightning so doctor can inspect wallet state without importing
// the full lightning package (and its crypto dependencies).
const (
	walletDatFile         = "wallet.dat"
	walletFingerprintFile = "wallet.fingerprint"
)

// checkWallet verifies that the Lightning wallet is initialised and surfaces
// its public fingerprint so operators can cross-check against a hardware
// wallet without exposing the seed. The fingerprint is a best-effort
// convenience — its absence is non-fatal (it regenerates on next run).
func checkWallet(dataDir string) Check {
	return Check{
		Name: "Lightning wallet",
		Run: func(_ context.Context) Result {
			dir := dataDir
			if dir == "" {
				home, err := os.UserHomeDir()
				if err != nil {
					return Result{Status: StatusSkip, Detail: "no home directory; cannot locate wallet"}
				}
				dir = filepath.Join(home, ".local", "share", "otedama")
			}

			walletPath := filepath.Join(dir, walletDatFile)
			if _, err := os.Stat(walletPath); os.IsNotExist(err) {
				return Result{
					Status: StatusWarn,
					Detail: "no wallet found in " + dir,
					Fix:    "set wallet-passphrase in config.yaml or via OTEDAMA_WALLET_PASSPHRASE to create a wallet on next run",
				}
			} else if err != nil {
				return Result{
					Status: StatusFail,
					Detail: fmt.Sprintf("cannot stat %s: %v", walletPath, err),
					Fix:    "check filesystem permissions",
				}
			}

			// Wallet exists — read the public fingerprint file for display.
			fpPath := filepath.Join(dir, walletFingerprintFile)
			fp, err := os.ReadFile(fpPath)
			if err != nil {
				return Result{
					Status: StatusPass,
					Detail: "initialized (fingerprint file missing; re-run to regenerate)",
				}
			}
			fingerprint := strings.TrimSpace(string(fp))
			return Result{
				Status: StatusPass,
				Detail: fmt.Sprintf("initialized, fingerprint: %s", fingerprint),
			}
		},
	}
}

func checkPoolReachability(cfg config.Config) Check {
	return Check{
		Name: "Pool reachability",
		Run: func(ctx context.Context) Result {
			var url string
			if len(cfg.Pools) > 0 {
				url = cfg.Pools[0].URL
			} else {
				url = config.DefaultPoolURL
			}
			host := stripScheme(url)
			if host == "" {
				return Result{
					Status: StatusFail,
					Detail: fmt.Sprintf("cannot parse pool URL %q", url),
					Fix:    "check the pool URL in config.yaml",
				}
			}
			d := net.Dialer{Timeout: 5 * time.Second}
			start := time.Now()
			conn, err := d.DialContext(ctx, "tcp", host)
			if err != nil {
				return Result{
					Status: StatusFail,
					Detail: fmt.Sprintf("%s: %v", host, err),
					Fix:    "check internet connection or try a different pool",
				}
			}
			_ = conn.Close()
			latency := time.Since(start).Round(time.Millisecond)
			return Result{
				Status: StatusPass,
				Detail: fmt.Sprintf("%s (%s)", host, latency),
			}
		},
	}
}

// checkPoolDiversity warns when only one pool is configured so operators
// are aware they have no automatic failover. A single pool is a single
// point of failure: if it goes down, mining stops until the operator
// manually updates the config. Two or more pools give the reconnect loop
// a failover target without human intervention.
func checkPoolDiversity(cfg config.Config) Check {
	return Check{
		Name: "Pool diversity",
		Run: func(_ context.Context) Result {
			n := len(cfg.Pools)
			if n == 0 {
				// No pools configured → using built-in default. Mention it.
				return Result{
					Status: StatusWarn,
					Detail: "using built-in default pool (no failover configured)",
					Fix:    "add at least two pools under 'pools:' in config.yaml for automatic failover",
				}
			}
			if n == 1 {
				return Result{
					Status: StatusWarn,
					Detail: fmt.Sprintf("only one pool configured (%s) — no automatic failover", cfg.Pools[0].URL),
					Fix:    "add a second pool under 'pools:' in config.yaml; mining stops if this pool goes down",
				}
			}
			return Result{
				Status: StatusPass,
				Detail: fmt.Sprintf("%d pools configured; failover available", n),
			}
		},
	}
}

// poolIPResolver resolves a host (or host:port) to its IP addresses.
// Overridable in tests so checkPoolEndpointDiversity does not hit real DNS.
// Defaults to the system resolver, honouring the check's context deadline.
var poolIPResolver = func(ctx context.Context, host string) ([]string, error) {
	h := host
	if hh, _, err := net.SplitHostPort(host); err == nil {
		h = hh
	}
	return net.DefaultResolver.LookupHost(ctx, h)
}

// checkPoolEndpointDiversity resolves each configured pool to its IP
// addresses and warns when two or more pools share an address. Two pool
// URLs that resolve to the same endpoint provide no real failover: a single
// machine (or operator) outage takes both down at once. This complements
// checkPoolDiversity, which only counts URLs — this catches the case where
// the URLs differ but the endpoints behind them do not.
//
// A proper "same ASN / same operator" check needs an external IP-to-ASN
// dataset, which Otedama does not bundle; sharing a resolved IP is a strong,
// dependency-free centralisation signal that covers the common misconfig
// (two hostnames that are CNAMEs/round-robin for the same pool node).
func checkPoolEndpointDiversity(cfg config.Config) Check {
	return Check{
		Name: "Pool endpoint diversity",
		Run: func(ctx context.Context) Result {
			if len(cfg.Pools) < 2 {
				// Counting diversity is handled by checkPoolDiversity; with
				// fewer than two pools there is nothing to compare.
				return Result{Status: StatusSkip, Detail: "fewer than two pools configured"}
			}
			ipToPools := map[string][]string{}
			resolved := 0
			for _, p := range cfg.Pools {
				host := stripScheme(p.URL)
				if host == "" {
					continue
				}
				ips, err := poolIPResolver(ctx, host)
				if err != nil {
					continue // unresolvable host: reachability check reports it
				}
				resolved++
				for _, ip := range ips {
					ipToPools[ip] = appendUnique(ipToPools[ip], p.URL)
				}
			}
			if resolved < 2 {
				// Offline / sandbox / DNS failure: not enough data to judge.
				return Result{
					Status: StatusSkip,
					Detail: "could not resolve enough pool endpoints to compare",
				}
			}
			for ip, urls := range ipToPools {
				if len(urls) >= 2 {
					return Result{
						Status: StatusWarn,
						Detail: fmt.Sprintf("pools %s resolve to the same endpoint %s — failover is illusory",
							strings.Join(urls, ", "), ip),
						Fix: "configure pools run by different operators so one outage cannot take down both",
					}
				}
			}
			return Result{
				Status: StatusPass,
				Detail: fmt.Sprintf("%d pools resolve to distinct endpoints", resolved),
			}
		},
	}
}

// appendUnique appends s to xs only if it is not already present.
func appendUnique(xs []string, s string) []string {
	for _, x := range xs {
		if x == s {
			return xs
		}
	}
	return append(xs, s)
}

// gpuDRMPath is the sysfs path scanned for render devices; overridable in tests.
var gpuDRMPath = "/sys/class/drm"

// checkPayoutScheme surfaces the payout scheme trade-offs for each configured
// pool so operators understand the variance/custody implications of their
// choice. The check is advisory (StatusPass or StatusSkip only — the scheme
// field is optional and has no effect on the mining protocol).
func checkPayoutScheme(cfg config.Config) Check {
	return Check{
		Name: "Pool payout schemes",
		Run: func(_ context.Context) Result {
			if len(cfg.Pools) == 0 {
				return Result{Status: StatusSkip, Detail: "no pools configured; using built-in default"}
			}
			// Collect per-scheme summaries, noting when any pool is unconfigured.
			var lines []string
			anyUnknown := false
			for _, p := range cfg.Pools {
				host := stripScheme(p.URL)
				if host == "" {
					host = p.URL
				}
				switch p.PayoutScheme {
				case "fpps":
					lines = append(lines, fmt.Sprintf("%s: FPPS — smooth payouts, pool absorbs variance (typically higher fee)", host))
				case "pplns":
					lines = append(lines, fmt.Sprintf("%s: PPLNS — lower fee, miner absorbs variance; expect payout variability", host))
				case "tides":
					lines = append(lines, fmt.Sprintf("%s: TIDES — non-custodial coinbase payouts (OCEAN); best alignment with Otedama's sovereignty stance", host))
				case "solo":
					lines = append(lines, fmt.Sprintf("%s: Solo — full block reward or nothing; only viable for large miners", host))
				default:
					lines = append(lines, fmt.Sprintf("%s: scheme not set", host))
					anyUnknown = true
				}
			}
			detail := strings.Join(lines, "; ")
			if anyUnknown {
				return Result{
					Status: StatusPass,
					Detail: detail,
					Fix:    "set payout_scheme: fpps/pplns/tides/solo in config.yaml for variance/custody context",
				}
			}
			return Result{Status: StatusPass, Detail: detail}
		},
	}
}

func checkHardware() Check {
	return Check{
		Name: "Hardware",
		Run: func(_ context.Context) Result {
			cpus := runtime.NumCPU()
			detail := fmt.Sprintf("%d-core CPU", cpus)
			status := StatusPass
			fix := ""

			// On Linux, see if /sys/class/drm exposes a GPU.
			if runtime.GOOS == "linux" {
				if entries, err := os.ReadDir(gpuDRMPath); err == nil {
					var gpus int
					for _, e := range entries {
						if strings.HasPrefix(e.Name(), "renderD") {
							gpus++
						}
					}
					if gpus > 0 {
						detail += fmt.Sprintf(", %d GPU(s) detected", gpus)
					} else {
						detail += ", no GPU detected"
						status = StatusWarn
						fix = "installing a GPU increases hashrate ~150x; without it earnings will be tiny"
					}
				}
			}
			return Result{Status: status, Detail: detail, Fix: fix}
		},
	}
}

// networkCheckEndpoint is the TCP address used by checkNetwork; overridable in tests.
var networkCheckEndpoint = "1.1.1.1:53"

func checkNetwork() Check {
	return Check{
		Name: "Network",
		Run: func(ctx context.Context) Result {
			d := net.Dialer{Timeout: 3 * time.Second}
			// Cloudflare DNS (1.1.1.1:53) is a reliable reachability test.
			conn, err := d.DialContext(ctx, "tcp", networkCheckEndpoint)
			if err != nil {
				return Result{
					Status: StatusFail,
					Detail: fmt.Sprintf("cannot reach %s: %v", networkCheckEndpoint, err),
					Fix:    "check your firewall, proxy, or VPN",
				}
			}
			_ = conn.Close()
			return Result{Status: StatusPass, Detail: "IPv4 OK"}
		},
	}
}

// ----- Helpers -----

// isLikelyBitcoinAddress performs a cheap format validity check.
// Full address validation requires base58/bech32 decoding, which is
// out of scope for doctor (we trust the user's runtime validation).
// The length bounds (26–90) match internal/config.validateAddress, so an
// address that passes `config validate` is never flagged by `doctor`
// (longer bech32m outputs reach up to 90 characters).
func isLikelyBitcoinAddress(s string) bool {
	s = strings.TrimSpace(s)
	if len(s) < 26 || len(s) > 90 {
		return false
	}
	switch {
	case strings.HasPrefix(s, "bc1"):
		// Bech32: bc1 followed by base32 chars (lowercase).
		for _, c := range s[3:] {
			if !isBech32Char(c) {
				return false
			}
		}
		return true
	case strings.HasPrefix(s, "1"), strings.HasPrefix(s, "3"):
		// Base58: no 0, O, I, l.
		for _, c := range s[1:] {
			if !isBase58Char(c) {
				return false
			}
		}
		return true
	default:
		return false
	}
}

func isBech32Char(c rune) bool {
	const charset = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
	return strings.ContainsRune(charset, c)
}

func isBase58Char(c rune) bool {
	const charset = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
	return strings.ContainsRune(charset, c)
}

func maskAddress(s string) string {
	if len(s) <= 10 {
		return s
	}
	return s[:6] + strings.Repeat("·", 3) + s[len(s)-4:]
}

func stripScheme(url string) string {
	for _, p := range []string{
		"stratum+v2tls://", "stratum+v2://",
		"stratum+tls://", "stratum+tcp://",
	} {
		if strings.HasPrefix(url, p) {
			return strings.TrimPrefix(url, p)
		}
	}
	return ""
}

// (Report.Results is already deterministic: Runner.Run writes results
// by check index, so output order always matches the curated order of
// DefaultChecks regardless of goroutine scheduling.)
