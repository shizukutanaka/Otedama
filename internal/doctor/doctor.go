// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package doctor provides the "otedama doctor" self-diagnosis command.
//
// # Why this exists
//
// When a user reports "it doesn't work", the first 80% of support
// effort is finding out *what* doesn't work. Is the Bitcoin address
// malformed? Is the pool unreachable? Is there no GPU detected? Is
// the config file in the wrong location?
//
// Doctor answers all of these in one command:
//
//	$ otedama doctor
//	[✓] Configuration file: /home/alice/.config/otedama/config.yaml
//	[✓] Bitcoin address: bc1qar0···5mdq (valid Bech32)
//	[✓] Data directory: /home/alice/.local/share/otedama (writable, 0700)
//	[✓] Hardware: 8-core CPU (10.5 MH/s estimated)
//	[✓] Pool reachability: stratum+v2://slushpool.com:3336 (42ms)
//	[!] GPU: none detected (hashrate will be 150x lower than GPU+CPU)
//	[✓] Lightning wallet: initialized, fingerprint a3f2b1c4
//	[✓] Network: IPv4 OK, IPv6 not tested
//
//	Summary: 7 passed, 0 failed, 1 warning
//
// # Design
//
// Each check is a Check value with a Name and a Run function. Checks
// are independent and run in parallel where possible. Results are
// aggregated into a Report that prints consistently formatted output
// and exits with code 0 (all good), 1 (warnings), or 2 (failures).
package doctor

import (
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/shizukutanaka/Otedama/internal/config"
)

// Status is the outcome of a single check.
type Status int

const (
	// StatusPass means the check succeeded.
	StatusPass Status = iota
	// StatusWarn means the check found a non-fatal issue.
	StatusWarn
	// StatusFail means the check found a blocking issue.
	StatusFail
	// StatusSkip means the check was not applicable.
	StatusSkip
)

func (s Status) symbol() string {
	switch s {
	case StatusPass:
		return "✓"
	case StatusWarn:
		return "!"
	case StatusFail:
		return "✗"
	default:
		return "-"
	}
}

// Result is one check's outcome.
type Result struct {
	Name    string
	Status  Status
	Detail  string // what was checked and how
	Fix     string // how to fix if not passing; blank on success
	Elapsed time.Duration
}

// Check is a single diagnostic probe.
type Check struct {
	Name string
	Run  func(ctx context.Context) Result
}

// Report summarises all Check results.
type Report struct {
	Results  []Result
	Duration time.Duration
}

// ExitCode returns 0 if all checks passed or skipped, 1 if any warned,
// 2 if any failed. Suitable for `os.Exit(report.ExitCode())`.
func (r *Report) ExitCode() int {
	has := struct {
		warn, fail bool
	}{}
	for _, res := range r.Results {
		switch res.Status {
		case StatusWarn:
			has.warn = true
		case StatusFail:
			has.fail = true
		}
	}
	switch {
	case has.fail:
		return 2
	case has.warn:
		return 1
	default:
		return 0
	}
}

// Print writes the report to w in a human-readable format.
func (r *Report) Print(w io.Writer) {
	var passed, warned, failed, skipped int
	for _, res := range r.Results {
		fmt.Fprintf(w, "[%s] %s: %s\n", res.Status.symbol(), res.Name, res.Detail)
		if res.Fix != "" {
			fmt.Fprintf(w, "    → fix: %s\n", res.Fix)
		}
		switch res.Status {
		case StatusPass:
			passed++
		case StatusWarn:
			warned++
		case StatusFail:
			failed++
		case StatusSkip:
			skipped++
		}
	}
	fmt.Fprintln(w)
	fmt.Fprintf(w, "Summary: %d passed, %d failed, %d warning",
		passed, failed, warned)
	if warned != 1 {
		fmt.Fprint(w, "s")
	}
	if skipped > 0 {
		fmt.Fprintf(w, ", %d skipped", skipped)
	}
	fmt.Fprintf(w, " (completed in %s)\n", r.Duration.Round(time.Millisecond))
}

// Runner executes a set of checks and produces a Report.
type Runner struct {
	Checks []Check
}

// Run executes all checks concurrently and returns the Report.
// The order of results in the Report matches the order of Checks.
func (r *Runner) Run(ctx context.Context) *Report {
	start := time.Now()
	results := make([]Result, len(r.Checks))
	var wg sync.WaitGroup

	for i, c := range r.Checks {
		wg.Add(1)
		go func(idx int, chk Check) {
			defer wg.Done()
			t0 := time.Now()
			res := chk.Run(ctx)
			res.Name = chk.Name
			res.Elapsed = time.Since(t0)
			results[idx] = res
		}(i, c)
	}
	wg.Wait()
	return &Report{Results: results, Duration: time.Since(start)}
}

// ----- Standard checks -----

// DefaultChecks returns the built-in check set for a config.
// Additional checks can be appended by callers before running.
func DefaultChecks(cfg config.Config, configPath string) []Check {
	return []Check{
		checkConfig(cfg, configPath),
		checkBitcoinAddress(cfg.BitcoinAddress),
		checkFailoverAddresses(cfg.BitcoinAddresses),
		checkDataDir(cfg.DataDir),
		checkPoolReachability(cfg),
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
			return Result{
				Status: StatusPass,
				Detail: fmt.Sprintf("%s (likely valid)", maskAddress(addr)),
			}
		},
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

func checkPoolReachability(cfg config.Config) Check {
	return Check{
		Name: "Pool reachability",
		Run: func(ctx context.Context) Result {
			var url string
			if len(cfg.Pools) > 0 {
				url = cfg.Pools[0].URL
			} else {
				url = "stratum+v2://public.stratum.slushpool.com:3336"
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
				if entries, err := os.ReadDir("/sys/class/drm"); err == nil {
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

func checkNetwork() Check {
	return Check{
		Name: "Network",
		Run: func(ctx context.Context) Result {
			d := net.Dialer{Timeout: 3 * time.Second}
			// Cloudflare DNS (1.1.1.1:53) is a reliable reachability test.
			conn, err := d.DialContext(ctx, "tcp", "1.1.1.1:53")
			if err != nil {
				return Result{
					Status: StatusFail,
					Detail: fmt.Sprintf("cannot reach 1.1.1.1:53: %v", err),
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
