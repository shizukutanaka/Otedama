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
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
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
		checkPoolEncryption(cfg),
		checkPoolTLSCA(cfg),
		checkPayoutScheme(cfg),
		checkPowerEconomics(cfg),
		checkProfitabilityFloor(cfg),
		checkHardware(),
		checkNetwork(),
		checkClockSkew(),
		checkEnvVars(),
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
				// Mirrors config.ResolveWithOrigins's OS-appropriate default
				// (Linux XDG, macOS Application Support, Windows %APPDATA%)
				// so doctor reports on the same path the engine actually uses.
				dir = config.DefaultDataDir()
				if dir == "" {
					return Result{Status: StatusSkip, Detail: "no home directory"}
				}
			}

			info, err := os.Stat(dir)
			if errors.Is(err, os.ErrNotExist) {
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
			// Actually try to write. Until session 264 this check reported
			// "(exists, writable)" on the strength of os.Stat plus a
			// permission-bit inspection, neither of which establishes that
			// *this process* can write: ownership, ACLs, a read-only mount, or
			// an immutable flag all leave the mode bits looking fine. The
			// directory holds wallet.dat, so a wrong answer here surfaces at
			// wallet-write time — exactly the moment `doctor` exists to get
			// ahead of. The probe is a temp file removed immediately, in a
			// directory the product owns.
			if err := probeWritable(dir); err != nil {
				return Result{
					Status: StatusFail,
					Detail: fmt.Sprintf("%s exists but is not writable: %v", dir, err),
					Fix:    "check ownership and mount options; Otedama must be able to create wallet.dat here",
				}
			}

			return Result{
				Status: StatusPass,
				Detail: fmt.Sprintf("%s (exists, writable)", dir),
			}
		},
	}
}

// probeWritable reports whether the current process can create a file in dir,
// by doing it. Nothing else answers the question: mode bits describe intent,
// not the effect of ownership, ACLs, a read-only mount, or an immutable flag.
// The probe file is removed before returning, including on the error paths.
func probeWritable(dir string) error {
	f, err := os.CreateTemp(dir, ".otedama-writable-probe-*")
	if err != nil {
		return err
	}
	name := f.Name()
	closeErr := f.Close()
	rmErr := os.Remove(name)
	if closeErr != nil {
		return closeErr
	}
	return rmErr
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
				dir = config.DefaultDataDir()
				if dir == "" {
					return Result{Status: StatusSkip, Detail: "no home directory; cannot locate wallet"}
				}
			}

			walletPath := filepath.Join(dir, walletDatFile)
			if _, err := os.Stat(walletPath); errors.Is(err, os.ErrNotExist) {
				return Result{
					Status: StatusWarn,
					Detail: "no wallet found in " + dir,
					Fix:    "set --wallet-passphrase or OTEDAMA_WALLET_PASSPHRASE to create a wallet on next run",
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
			// No pool configured is its own failure, not a connectivity one.
			// There is no built-in fallback to dial any more (the one that
			// existed pointed at a host that does not resolve), so there is
			// nothing to reach and the network is not the suspect.
			if len(cfg.Pools) == 0 {
				return Result{
					Status: StatusFail,
					Detail: "no pool configured",
					Fix: "add a pools: entry to config.yaml with an endpoint from your " +
						"pool's own documentation, e.g.\n    pools:\n      - url: \"stratum+v2tls://your-pool.example:3336\"\n" +
						"  Prefer a TLS scheme: stratum+v2:// and stratum+tcp:// send your " +
						"payout address in the clear (docs/KNOWN_LIMITATIONS.md §2).",
				}
			}
			url := cfg.Pools[0].URL
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
				// Nothing to diversify. Warning about missing failover here
				// would be the second voice telling the user the same thing:
				// with no built-in default (§20), "no pool configured" is
				// already a hard failure from the reachability check, and
				// advising two pools to someone who has zero buries the one
				// instruction that matters. This check earns its keep on
				// configurations that can actually mine.
				return Result{
					Status: StatusSkip,
					Detail: "no pool configured — see the reachability check",
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
// checkPoolEncryption warns when a configured pool uses the plaintext
// stratum+tcp:// transport. Plaintext stratum is not merely an eavesdropping
// concern: a network attacker (rogue Wi-Fi, compromised router, hostile ISP)
// can rewrite the mining.authorize username or share submissions in flight and
// redirect every payout to their own address — a well-known stratum-hijacking
// attack. The encrypted transports (stratum+tls:// V1-over-TLS, stratum+v2://
// which carries an AEAD Noise session, and stratum+v2tls://) defeat it.
// schemeIsEncrypted reports whether a pool URL scheme gets transport
// encryption on the path the engine actually dials.
//
// # Why this table, and why it is not "anything but stratum+tcp://"
//
// Until session 264 this check treated every scheme except
// stratum+tcp:// as encrypted. That was wrong about stratum+v2://, which
// is the built-in default, so `otedama doctor` reported PASS — "all N
// pool(s) use an encrypted transport" — for connections that carry the
// user's payout address in the clear, and its Fix text recommended
// switching *to* stratum+v2:// to solve exactly that problem.
//
// The engine's own connect path is the authority, and it already says so
// out loud: engine.runSession logs "connecting over plaintext Stratum V2
// — no transport encryption" before dialing that scheme with a bare
// net.Dialer. Noise NX exists in internal/stratum but no live path
// invokes it (docs/KNOWN_LIMITATIONS.md §2). Doctor and the runtime
// disagreed, and doctor — the tool a user runs to check their posture
// before mining — was the one that was wrong.
//
// Verified against the dial sites rather than the scheme names:
//
//	stratum+tcp://    poolproto/stratumv1, plain TCP          not encrypted
//	stratum+tls://    poolproto/stratumv1 tls.Dialer          encrypted
//	stratum+v2://     engine net.Dialer (+ its warning log)   not encrypted
//	stratum+v2tls://  engine stratum.DialTLS                  encrypted
//
// When Noise NX is wired into the stratum+v2:// path, move it to the
// encrypted side here and drop the note from §2.
func schemeIsEncrypted(url string) bool {
	switch {
	case strings.HasPrefix(url, "stratum+v2tls://"):
		return true
	case strings.HasPrefix(url, "stratum+tls://"):
		return true
	default:
		// stratum+tcp:// and stratum+v2:// both travel in the clear.
		return false
	}
}

func checkPoolEncryption(cfg config.Config) Check {
	return Check{
		Name: "Pool connection encryption",
		Run: func(_ context.Context) Result {
			pools := cfg.Pools
			if len(pools) == 0 {
				// Nothing to report on: with no built-in fallback there is no
				// transport to classify. The reachability check already tells
				// the user to configure a pool; repeating it here would just
				// be a second copy of the same instruction.
				return Result{
					Status: StatusSkip,
					Detail: "no pool configured — nothing to assess",
				}
			}

			var plaintext []string
			for _, p := range pools {
				if !schemeIsEncrypted(p.URL) {
					plaintext = append(plaintext, stripScheme(p.URL))
				}
			}

			const fix = "use stratum+v2tls:// (Stratum V2 over TLS) or stratum+tls:// " +
				"(V1 over TLS). stratum+v2:// is NOT encrypted today — Noise NX is " +
				"implemented but not wired into the connect path (KNOWN_LIMITATIONS §2)."

			if len(plaintext) > 0 {
				which := fmt.Sprintf("%d of %d pool(s) use", len(plaintext), len(pools))
				return Result{
					Status: StatusWarn,
					Detail: fmt.Sprintf(
						"%s an unencrypted transport (%s) — a network attacker can read and "+
							"rewrite your payout address and steal earnings",
						which, strings.Join(plaintext, ", ")),
					Fix: fix,
				}
			}
			return Result{
				Status: StatusPass,
				Detail: fmt.Sprintf("all %d pool(s) use an encrypted transport (TLS)", len(pools)),
			}
		},
	}
}

// checkPoolTLSCA validates each pool's optional tls_ca_file (session 128) at
// diagnosis time, so a mistyped path or a non-certificate file is reported here
// rather than silently degrading to system-roots verification at dial time
// (where it would then fail confusingly for the private-CA pool it was meant to
// trust). The PEM is parsed with the same x509.CertPool.AppendCertsFromPEM the
// dialer uses, so doctor and the live path agree on what "valid" means.
func checkPoolTLSCA(cfg config.Config) Check {
	return Check{
		Name: "Pool TLS CA files",
		Run: func(_ context.Context) Result {
			var configured int
			for _, p := range cfg.Pools {
				if p.TLSCAFile == "" {
					continue
				}
				configured++
				// tls_ca_file is only honoured for stratum+tls:// (V1 over TLS);
				// for any other scheme it is silently ignored at runtime.
				if !strings.HasPrefix(p.URL, "stratum+tls://") {
					return Result{
						Status: StatusWarn,
						Detail: fmt.Sprintf("tls_ca_file set on %s but only stratum+tls:// honours it; it will be ignored",
							stripScheme(p.URL)),
						Fix: "remove tls_ca_file, or use a stratum+tls:// URL for this pool",
					}
				}
				pem, err := os.ReadFile(p.TLSCAFile)
				if err != nil {
					return Result{
						Status: StatusFail,
						Detail: fmt.Sprintf("cannot read tls_ca_file %q: %v", p.TLSCAFile, err),
						Fix:    "fix the path, or remove tls_ca_file to use the system root store",
					}
				}
				if !x509.NewCertPool().AppendCertsFromPEM(pem) {
					return Result{
						Status: StatusFail,
						Detail: fmt.Sprintf("tls_ca_file %q contains no valid PEM certificates", p.TLSCAFile),
						Fix:    "ensure the file is a PEM-encoded certificate bundle",
					}
				}
			}
			if configured == 0 {
				return Result{Status: StatusSkip, Detail: "no pool sets tls_ca_file"}
			}
			return Result{
				Status: StatusPass,
				Detail: fmt.Sprintf("%d pool CA file(s) valid", configured),
			}
		},
	}
}

// checkPowerEconomics verifies the coherence of the power/cost configuration
// pair, not just each field's individual validity. power_watts and
// electricity_price_per_kwh are each valid alone, but the cost metric
// (otedama_power_cost_usd_per_hour) needs both — so one set without the other is
// a "half-configured feature" that silently does nothing the operator expects.
// This is the cross-field-intent perspective: do these values, together, achieve
// what the operator apparently wanted?
func checkPowerEconomics(cfg config.Config) Check {
	return Check{
		Name: "Power & cost config",
		Run: func(_ context.Context) Result {
			hasW := cfg.PowerWatts > 0
			hasP := cfg.ElectricityPricePerKWh > 0
			switch {
			case !hasW && !hasP:
				return Result{
					Status: StatusSkip,
					Detail: "power_watts and electricity_price_per_kwh unset (efficiency/cost metrics off)",
				}
			case hasW && hasP:
				return Result{
					Status: StatusPass,
					Detail: "power_watts and electricity_price_per_kwh both set; J/TH and power-cost metrics available",
				}
			case hasW: // && !hasP
				return Result{
					Status: StatusWarn,
					Detail: "power_watts is set but electricity_price_per_kwh is not — otedama_power_cost_usd_per_hour cannot be computed (J/TH still works)",
					Fix:    "set electricity_price_per_kwh to see power cost and net profit",
				}
			default: // !hasW && hasP
				return Result{
					Status: StatusWarn,
					Detail: "electricity_price_per_kwh is set but power_watts is not — it has no effect (no J/TH, no power cost)",
					Fix:    "set power_watts (your measured wattage) to enable the efficiency and cost metrics",
				}
			}
		},
	}
}

// checkEnvVars reports OTEDAMA_* numeric environment variables that are set but
// could not be parsed. Such a variable is silently dropped during config
// resolution (the default stands), so without this an operator who set, say,
// OTEDAMA_POWER_WATTS=300w would run `otedama doctor` to find out why their cost
// metrics are missing and learn nothing. This mirrors the warnings `run` and
// `config validate` print (session 147), making doctor a complete diagnostic.
func checkEnvVars() Check {
	return Check{
		Name: "Environment variables",
		Run: func(_ context.Context) Result {
			warnings := config.EnvWarnings(nil)
			if len(warnings) == 0 {
				return Result{
					Status: StatusPass,
					Detail: "no malformed OTEDAMA_* numeric environment variables",
				}
			}
			return Result{
				Status: StatusWarn,
				Detail: strings.Join(warnings, "; "),
				Fix:    "correct or unset the listed variable(s); a malformed value is ignored and the default is used",
			}
		},
	}
}

// checkProfitabilityFloor surfaces the min_yield_sats_per_sec setting so
// `doctor` confirms it understood the floor and explains its effect, rather
// than staying silent about a setting that can leave hardware idle. The floor
// idles any device whose best compatible stream yields below it; set high
// enough, it idles *every* device and the miner does nothing — a silent
// foot-gun an operator would otherwise discover only by noticing zero hashrate.
//
// The check is advisory: it cannot know live per-device yields (those arrive
// from provider quotes at runtime, not config), so it does not guess a
// "too high" threshold. Instead it points the operator at the observable that
// settles the question — the otedama_devices_idle gauge — which reports how
// many devices the floor actually idled each arbitration cycle.
func checkProfitabilityFloor(cfg config.Config) Check {
	return Check{
		Name: "Profitability floor",
		Run: func(_ context.Context) Result {
			if cfg.MinYieldSatsPerSec == 0 {
				return Result{
					Status: StatusSkip,
					Detail: "min_yield_sats_per_sec unset (0); every positive-yield stream qualifies",
				}
			}
			return Result{
				Status: StatusPass,
				Detail: fmt.Sprintf(
					"min_yield_sats_per_sec = %.4g sat/s; devices whose best stream yields less will idle",
					cfg.MinYieldSatsPerSec),
				Fix: "if more devices idle than you expect, watch the otedama_devices_idle metric and lower the floor",
			}
		},
	}
}

func checkPayoutScheme(cfg config.Config) Check {
	return Check{
		Name: "Pool payout schemes",
		Run: func(_ context.Context) Result {
			if len(cfg.Pools) == 0 {
				return Result{Status: StatusSkip, Detail: "no pool configured"}
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
						// Corrected session 243: a GPU does not increase
						// Bitcoin-mining hashrate today — no CUDA/ROCm/Vulkan
						// compute dispatch exists anywhere in this codebase
						// (internal/hal/gpu_linux.go reports SHA256d: false),
						// so this is informational, not a warning. A detected
						// GPU only makes the device eligible for the
						// simulated AI-inference quote stream
						// (docs/KNOWN_LIMITATIONS.md).
						detail += ", no GPU detected"
						fix = "hashrate today comes entirely from the CPU; a GPU would not increase it (no compute dispatch is implemented yet — see docs/KNOWN_LIMITATIONS.md)"
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

// clockSkewProbeURL is the endpoint used to measure local clock skew. It is
// a public, no-auth HTTPS endpoint whose servers return accurate Date headers
// and has high global availability. We reuse the same source the rate fetcher
// uses so the doctor check validates the same network path. Overridable in tests.
var clockSkewProbeURL = "https://api.coinbase.com/v2/time"

// clockSkewHTTPClient is the HTTP client used by checkClockSkew. Nil means
// use http.DefaultClient. Tests replace this with a fake-server client.
var clockSkewHTTPClient *http.Client

// clockSkewWarnSecs is the skew magnitude at which we warn; beyond this TLS
// certificate validation windows, mining nTime fields, and rate-freshness
// judgements all become unreliable. Matches rates.clockSkewWarnThreshold.
const clockSkewWarnSecs = 120.0

// clockSkewFailSecs is the magnitude at which we escalate to Fail. At >5 min
// most TLS stacks begin rejecting certificates as "not yet valid" or "expired",
// so mining cannot start regardless of other settings.
const clockSkewFailSecs = 300.0

func checkClockSkew() Check {
	return Check{
		Name: "System clock accuracy",
		Run: func(ctx context.Context) Result {
			reqCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()

			req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, clockSkewProbeURL, nil)
			if err != nil {
				return Result{
					Status: StatusWarn,
					Detail: fmt.Sprintf("could not build request: %v", err),
					Fix:    "this is an internal error; report it",
				}
			}
			req.Header.Set("User-Agent", "Otedama/3.0.0-alpha (doctor)")

			client := clockSkewHTTPClient
			if client == nil {
				client = http.DefaultClient
			}
			resp, err := client.Do(req)
			if err != nil {
				return Result{
					Status: StatusWarn,
					Detail: fmt.Sprintf("cannot reach clock probe endpoint: %v", err),
					Fix:    "check internet connectivity; re-run when online to verify clock accuracy",
				}
			}
			// This check needs only the Date header, but the body must still be
			// drained before Close so the underlying TCP/TLS connection can be
			// returned to the keep-alive pool (the production fallback uses
			// http.DefaultClient, which reuses connections). An undrained body
			// forces the transport to abandon the connection — and under HTTP/2
			// can emit a spurious RST_STREAM. The drain is bounded (the probe
			// response is a tiny JSON time object) so a hostile or runaway server
			// cannot turn cleanup into an unbounded read.
			defer func() {
				_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 8<<10))
				_ = resp.Body.Close()
			}()

			dateHdr := resp.Header.Get("Date")
			if dateHdr == "" {
				return Result{
					Status: StatusWarn,
					Detail: "server returned no Date header; cannot measure clock skew",
					Fix:    "try again; if persistent, the probe endpoint may have changed",
				}
			}
			serverTime, err := http.ParseTime(dateHdr)
			if err != nil {
				return Result{
					Status: StatusWarn,
					Detail: fmt.Sprintf("cannot parse server Date header %q: %v", dateHdr, err),
					Fix:    "try again; if persistent, the probe endpoint date format may have changed",
				}
			}

			skew := math.Abs(time.Since(serverTime).Seconds())
			switch {
			case skew > clockSkewFailSecs:
				return Result{
					Status: StatusFail,
					Detail: fmt.Sprintf("local clock is %.0f s off server time (threshold %.0f s)", skew, clockSkewFailSecs),
					Fix: fmt.Sprintf(
						"synchronise your system clock (e.g. `timedatectl set-ntp true` on Linux, "+
							"`w32tm /resync` on Windows). Skew >%.0f s breaks TLS certificate "+
							"validation and mining nTime checks.", clockSkewFailSecs),
				}
			case skew > clockSkewWarnSecs:
				return Result{
					Status: StatusWarn,
					Detail: fmt.Sprintf("local clock is %.0f s off server time (warn threshold %.0f s)", skew, clockSkewWarnSecs),
					Fix:    "synchronise your system clock; skew above 120 s may cause TLS errors or stale rate judgements",
				}
			default:
				return Result{
					Status: StatusPass,
					Detail: fmt.Sprintf("clock skew %.1f s (within %.0f s threshold)", skew, clockSkewWarnSecs),
				}
			}
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
		if rest, ok := strings.CutPrefix(url, p); ok {
			return rest
		}
	}
	return ""
}

// (Report.Results is already deterministic: Runner.Run writes results
// by check index, so output order always matches the curated order of
// DefaultChecks regardless of goroutine scheduling.)
