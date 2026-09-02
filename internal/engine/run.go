// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package engine wires together all of Otedama's internal packages.
//
// This is the integration point. Every package in internal/ is either
// called from here or called by something called from here. Previously
// the arbitration engine, provider system, TUI dashboard, and Lightning
// wallet were all implemented but completely disconnected. This file
// connects them.
//
// # Session architecture
//
//	┌─────────────┐   quotes  ┌──────────────┐  allocation ┌──────────────┐
//	│   Mining    ├──────────►│  Arbitration ├────────────►│   Workers    │
//	│  Provider   │           │    Engine    │             │    (CPU)     │
//	│(only market)│           │              │             └──────┬───────┘
//	└─────────────┘           └──────────────┘                    │shares
//	                                                                ▼
//	┌─────────────┐                                       ┌──────────────┐
//	│  Lightning  │◄──────────────────────────────────────│   Pool       │
//	│  Wallet     │   payouts                             │  (Stratum V2)│
//	└─────────────┘                                       └──────────────┘
//	                                  ▲
//	┌─────────────┐    stats          │
//	│  TUI        │◄──────────────────┘
//	│  Dashboard  │
//	└─────────────┘
package engine

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shizukutanaka/Otedama/internal/arbitration"
	"github.com/shizukutanaka/Otedama/internal/clock"
	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/shizukutanaka/Otedama/internal/metrics"
	"github.com/shizukutanaka/Otedama/internal/miner"
	"github.com/shizukutanaka/Otedama/internal/poolproto"
	"github.com/shizukutanaka/Otedama/internal/provider"
	"github.com/shizukutanaka/Otedama/internal/stratum"
	"github.com/shizukutanaka/Otedama/internal/tui"
)

// Engine timing constants. Centralised here so the reconnection and
// re-arbitration cadence is documented in one place rather than buried
// as magic numbers in the run loops.
const (
	// reconnectBackoffInitial is the first delay after a session ends
	// before reconnecting. Doubles on each consecutive failure.
	reconnectBackoffInitial = time.Second

	// reconnectBackoffMax caps the exponential reconnect backoff.
	reconnectBackoffMax = 64 * time.Second
)

// arbitrationInterval is how often the engine re-evaluates the
// device→stream assignment in the absence of a fresh quote.
// It is a var (not const) so tests can shrink it to milliseconds.
var arbitrationInterval = 30 * time.Second

// Options configures a Run session.
type Options struct {
	Config config.Config
	Clock  clock.Clock
	Output io.Writer // where TUI writes; defaults to os.Stdout
	Logger func(level, msg string)
	NoTUI  bool // disable the terminal dashboard

	// StatsInterval controls how often hash-rate statistics are logged.
	// Zero defaults to 10 seconds.
	StatsInterval time.Duration

	// MaxReconnectAttempts caps the reconnect loop. Zero means unlimited.
	MaxReconnectAttempts int

	// WalletPassphrase unlocks (or creates) the Lightning wallet.
	// If empty, wallet initialisation is skipped.
	WalletPassphrase string

	// WalletMnemonicPassphrase is the optional BIP-39 "25th word" passphrase
	// applied only when a NEW wallet is created (first run). It is a
	// distinct secret from WalletPassphrase: WalletPassphrase encrypts the
	// seed at rest, while this changes which seed the mnemonic derives to
	// in the first place. See lightning.WithMnemonicPassphrase. Has no
	// effect when loading an existing wallet.dat — the passphrase is
	// already folded into the seed stored there.
	WalletMnemonicPassphrase string

	// Metrics, if set, receives runtime metrics (hashrate, shares, pool
	// latency, arbitration switches). Nil disables metrics emission.
	Metrics *metrics.Registry

	// OnReady, if set, is called with true each time a pool session is
	// established and with false when that session ends (and on shutdown).
	// Used to flip HTTP /readyz between 200 and 503, so readiness tracks an
	// actual pool connection rather than mere process start. It may be
	// called multiple times over a run as the connection drops and recovers.
	OnReady func(ready bool)
}

// curtailDecision is the pure decision function for the price-curtailment
// gate. Given the current gate state and a price observation, it returns the
// next state and whether it changed.
//
// Safety rule: a price that is not fresh (the fallback value before any
// successful fetch, or a rate older than rates.CacheDuration) NEVER changes
// the gate. Otedama must not pause or resume mining based on a price it does
// not trust — acting on the startup fallback would spuriously curtail before
// the real price is even known, and acting on a stale rate during a sources
// outage could pause (or resume) mining against a price that has since moved.
// When the data is untrustworthy the engine holds the last trusted state.
//
// A threshold of 0 (or negative) disables curtailment entirely.
func curtailDecision(curr bool, rate float64, fresh bool, threshold float64) (next bool, changed bool) {
	if threshold <= 0 || !fresh || rate <= 0 {
		return curr, false
	}
	switch {
	case rate < threshold && !curr:
		return true, true // price dropped below threshold → pause
	case rate >= threshold && curr:
		return false, true // price recovered → resume
	default:
		return curr, false
	}
}

// Run starts a full mining session and blocks until ctx is cancelled.
// It orchestrates every subsystem: wallet, HAL, providers, arbitration,
// TUI, and the Stratum V2 pool connection.
func Run(ctx context.Context, opts Options) error {
	if opts.Clock == nil {
		opts.Clock = clock.System{}
	}
	if opts.Output == nil {
		opts.Output = os.Stdout
	}
	log := opts.Logger
	if log == nil {
		log = func(_, _ string) {}
	}
	startTime := opts.Clock.Now()

	// Register metrics. If no registry is provided, use a throwaway one
	// so the rest of engine.Run does not need nil-checks at every call site.
	reg := opts.Metrics
	if reg == nil {
		reg = metrics.NewRegistry()
	}
	m := newEngineMetrics(reg)
	m.uptime.Set(0)
	m.startTime.Set(float64(startTime.Unix()))
	// Power cost is a constant for the run (config × config); publish it once so
	// a profitability dashboard can subtract it from revenue. Needs both inputs.
	if opts.Config.PowerWatts > 0 && opts.Config.ElectricityPricePerKWh > 0 {
		m.powerCostUSDPerHour.Set(opts.Config.PowerWatts / 1000 * opts.Config.ElectricityPricePerKWh)
	}

	// Update otedama_uptime_seconds every second so scrapers always see a
	// fresh value, not just the stale value from the last stats tick.
	go func() {
		t := time.NewTicker(time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				m.uptime.Set(time.Since(startTime).Seconds())
			}
		}
	}()

	// ----- Phase 1: Lightning wallet -----
	walletFingerprint := setupWallet(opts, log)

	// ----- Phase 2: Hardware detection (CPU + GPU) -----
	devices, err := detectDevices(ctx, log)
	if err != nil {
		return err
	}
	log("info", fmt.Sprintf("engine: detected %d device(s)", len(devices)))

	// ----- Phase 3: Miner workers (one per SHA256d-capable device) -----
	workers, merged, err := startMinerWorkers(ctx, devices, log)
	if err != nil {
		return err
	}
	defer func() {
		for _, w := range workers {
			w.Stop()
		}
	}()

	// ----- Phase 4: Price feed -----
	rateFetcher := newRateFetcher(95000, log) // $95k fallback
	rateFetcher.StartBackground(ctx, 5*time.Minute)

	// curtailGate is the single source of truth for whether hashing is
	// paused by the curtail_below_btc_usd threshold. The price goroutine
	// below flips it, and the session loop consults it before applying any
	// pool job — without this shared gate the next mining.notify (~30–60 s)
	// would silently re-arm the idled workers while otedama_curtailed still
	// read 1, so the pause neither held nor matched the metric.
	curtailGate := new(atomic.Bool)

	// Publish the BTC/USD rate to its gauge and enforce the optional
	// curtailment threshold (curtail_below_btc_usd). When the price falls
	// below the threshold all workers are idled (SetWork(nil)) and the gate
	// is raised so incoming jobs are not applied; they resume on the next
	// pool notify after the price recovers and the gate is lowered.
	go func() {
		publishBTCRate(m, rateFetcher)
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				publishBTCRate(m, rateFetcher)
				threshold := opts.Config.CurtailBelowBTCUSD
				rate, fresh := rateFetcher.BTCUSDRate()
				next, changed := curtailDecision(curtailGate.Load(), rate, fresh, threshold)
				if !changed {
					continue
				}
				curtailGate.Store(next)
				if next {
					for _, w := range workers {
						w.SetWork(nil)
					}
					log("info", fmt.Sprintf(
						"engine: curtailed — BTC/USD $%.0f below threshold $%.0f; hashing paused",
						rate, threshold))
					if m != nil {
						m.curtailed.Set(1)
					}
				} else {
					log("info", fmt.Sprintf(
						"engine: uncurtailed — BTC/USD $%.0f above threshold $%.0f; hashing resumes on next job",
						rate, threshold))
					if m != nil {
						m.curtailed.Set(0)
					}
				}
			}
		}
	}()

	// ----- Phase 5: Providers -----
	miningProvider := startProviders(ctx, opts.Config, rateFetcher, devices, workers, log)
	defer miningProvider.Stop()

	// ----- Phase 6: Arbitration engine -----
	quoteCh := mergeQuotes(ctx, miningProvider.Quotes())

	// Build device refs for the arbitration engine.
	devRefs := make([]arbitration.DeviceRef, len(devices))
	for i, d := range devices {
		devRefs[i] = arbitration.DeviceRef{
			Identity:     d.Identity(),
			Capabilities: d.Capabilities(),
		}
	}

	// Live streams map, updated as quotes arrive.
	streamsMu := sync.Mutex{}
	streamMap := make(map[string]arbitration.Stream)

	// Shared provider-activity snapshot: which providers arbitration is
	// actually routing devices to right now, and at what yield. Written by
	// runArbitrationLoop, read by buildStats via sessionOpts so the TUI's
	// provider lines reflect real allocation instead of a hardcoded
	// Active: true.
	activityMu := sync.Mutex{}
	activity := make(map[string]float64)

	// Arbitration loop: re-run Decide whenever quotes change.
	go runArbitrationLoop(ctx, arbitrationLoopOpts{
		devRefs:       devRefs,
		streamsMu:     &streamsMu,
		streamMap:     streamMap,
		quoteCh:       quoteCh,
		workers:       workers,
		metrics:       m,
		log:           log,
		hysteresisPct: opts.Config.ArbitrationHysteresisPct,
		minYield:      opts.Config.MinYieldSatsPerSec,
		activityMu:    &activityMu,
		activity:      activity,
	})

	// ----- Phase 7: TUI dashboard -----
	var dashboard *tui.Dashboard
	if !opts.NoTUI {
		dashboard = tui.NewDashboard(opts.Output)
		dashboard.Start()
		defer dashboard.Stop()
	}

	// ----- Phase 8: Pool connection with reconnect -----
	// Readiness reflects an *established pool session* (driven inside
	// runReconnectLoop via OnReady), not merely a started process, so
	// /readyz only goes green once mining can actually proceed and flips
	// back on disconnect. Mark not-ready on shutdown.
	if opts.OnReady != nil {
		defer opts.OnReady(false)
	}

	return runReconnectLoop(ctx, reconnectOpts{
		opts:        opts,
		workers:     workers,
		merged:      merged,
		dashboard:   dashboard,
		startTime:   startTime,
		wallet:      walletFingerprint,
		deviceN:     len(devices),
		providers:   []provider.Provider{miningProvider},
		metrics:     m,
		log:         log,
		curtailGate: curtailGate,
		activityMu:  &activityMu,
		activity:    activity,
	})
}

// reconnectOpts bundles the state runReconnectLoop needs across
// reconnection attempts.
type reconnectOpts struct {
	opts      Options
	workers   []*miner.Worker
	merged    <-chan miner.Share
	dashboard *tui.Dashboard
	startTime time.Time
	wallet    string
	deviceN   int
	providers []provider.Provider
	metrics   *engineMetrics
	log       func(level, msg string)
	// curtailGate, when non-nil and true, means hashing is paused by the
	// curtail_below_btc_usd threshold; the session loop must not apply
	// incoming pool jobs while it is raised.
	curtailGate *atomic.Bool
	// activityMu/activity: see sessionOpts. Threaded through unchanged
	// across reconnects since the arbitration loop (the writer) runs for
	// the lifetime of Run(), independent of any one pool session.
	activityMu *sync.Mutex
	activity   map[string]float64
}

// runReconnectLoop dials the pool, runs a session, and reconnects with
// exponential backoff (capped at reconnectBackoffMax) until ctx is cancelled, a fatal
// error occurs, or MaxReconnectAttempts is exceeded.
func runReconnectLoop(ctx context.Context, r reconnectOpts) error {
	pools := poolURLs(r.opts.Config)
	if len(pools) == 0 {
		// Backstop. cmd/otedama refuses to start without a pool and prints
		// the instructions, so reaching here means a caller embedded the
		// engine directly. Failing beats looping over an empty pool list.
		return fmt.Errorf("engine: no mining pool configured (set pools: in config.yaml)")
	}
	addrs := payoutAddresses(r.opts.Config)
	poolIdx := 0
	addrIdx := 0
	addrConnected := false // has the active address ever established a session?
	attempt := 0
	backoff := reconnectBackoffInitial

	statsInterval := r.opts.StatsInterval
	if statsInterval <= 0 {
		statsInterval = 10 * time.Second
	}

	for {
		if ctx.Err() != nil {
			break
		}
		attempt++
		if r.opts.MaxReconnectAttempts > 0 && attempt > r.opts.MaxReconnectAttempts {
			return fmt.Errorf("engine: exceeded %d reconnect attempts", r.opts.MaxReconnectAttempts)
		}
		poolURL := pools[poolIdx]
		var poolUser, poolTLSCAFile, poolPassword string
		if poolIdx < len(r.opts.Config.Pools) {
			poolUser = r.opts.Config.Pools[poolIdx].User
			poolTLSCAFile = r.opts.Config.Pools[poolIdx].TLSCAFile
			poolPassword = r.opts.Config.Pools[poolIdx].Password
		}
		user := sessionUser(poolUser, addrs[addrIdx], r.opts.Config.Workers.Name)

		loc := fmt.Sprintf("attempt %d", attempt)
		if len(pools) > 1 {
			loc += fmt.Sprintf(", pool %d/%d", poolIdx+1, len(pools))
		}
		if len(addrs) > 1 {
			loc += fmt.Sprintf(", address %d/%d", addrIdx+1, len(addrs))
		}
		r.log("info", fmt.Sprintf("engine: connecting to %s (%s)", poolURL, loc))

		r.metrics.poolConnectAttempts.Inc()
		r.metrics.poolActiveIndex.Set(float64(poolIdx))
		r.metrics.payoutActiveIndex.Set(float64(addrIdx))
		if addrIdx < len(addrs) {
			r.metrics.setActivePayout(maskAddr(addrs[addrIdx]))
		}
		r.metrics.poolConnectionState.Set(1) // connecting
		sessionErr := runSession(ctx, sessionOpts{
			poolURL:      poolURL,
			user:         user,
			workers:      r.workers,
			merged:       r.merged,
			interval:     statsInterval,
			dashboard:    r.dashboard,
			startTime:    r.startTime,
			wallet:       r.wallet,
			devices:      r.deviceN,
			log:          r.log,
			providers:    r.providers,
			m:            r.metrics,
			powerWatts:   r.opts.Config.PowerWatts,
			curtailGate:  r.curtailGate,
			tlsCAFile:    poolTLSCAFile,
			poolPassword: poolPassword,
			activityMu:   r.activityMu,
			activity:     r.activity,
			onConnected: func() {
				addrConnected = true
				if r.opts.OnReady != nil {
					r.opts.OnReady(true) // pool session established → ready
				}
			},
		})
		if sessionErr != nil {
			r.metrics.poolConnectFailures.Inc()
		}
		r.metrics.poolConnectionState.Set(0) // session ended → disconnected
		if r.opts.OnReady != nil {
			r.opts.OnReady(false) // session ended → not ready
		}
		if r.dashboard != nil {
			// The session's own stats tick stops the instant it returns, so
			// without this push the dashboard freezes on its last
			// "✓ connected" frame for the entire backoff/reconnect window.
			r.dashboard.Update(disconnectedStats(poolURL, r.wallet, r.startTime, r.deviceN))
		}

		if ctx.Err() != nil {
			break
		}
		if isFatal(sessionErr) {
			return sessionErr
		}

		// Pool failover (fast): advance to the next pool in priority order
		// before touching the payout address or backing off. A single-pool
		// config skips this and falls through to address failover / backoff.
		if len(pools) > 1 {
			poolIdx = (poolIdx + 1) % len(pools)
			if poolIdx != 0 {
				r.log("warn", fmt.Sprintf("engine: session ended: %v; failing over to next pool", sessionErr))
				continue // next pool immediately, no backoff
			}
			// poolIdx wrapped to 0: every pool failed for this address.
		}

		// Payout-address failover (slow, deliberately conservative): rotate
		// to a backup address ONLY when the active address has never
		// established a session. A working address is never abandoned —
		// transient pool/network failures are handled by pool failover and
		// backoff above — so an outage can never silently redirect earnings
		// to a different address (no session establishes during an outage).
		switch {
		case !addrConnected && len(addrs) > 1:
			prev := addrIdx
			addrIdx = (addrIdx + 1) % len(addrs)
			poolIdx = 0
			if addrIdx != 0 {
				r.log("warn", fmt.Sprintf(
					"engine: payout address %s (%d/%d) could not establish a session on any pool; "+
						"failing over to %s (%d/%d)",
					maskAddr(addrs[prev]), prev+1, len(addrs),
					maskAddr(addrs[addrIdx]), addrIdx+1, len(addrs)))
				continue // try next address immediately, no backoff
			}
			// Wrapped through every address; none connected. Back off and
			// retry from the primary so a recovered network resumes there.
			addrConnected = false
			r.log("warn", fmt.Sprintf(
				"engine: none of the %d configured payout addresses could connect; "+
					"backing off %v and retrying from the primary", len(addrs), backoff))
		case len(pools) > 1:
			r.log("warn", fmt.Sprintf("engine: all %d pools failed; backing off %v", len(pools), backoff))
		default:
			r.log("warn", fmt.Sprintf("engine: session ended: %v; reconnecting in %v", sessionErr, backoff))
		}
		// time.NewTimer + explicit Stop rather than time.After: when ctx is
		// cancelled (shutdown) the timer is released immediately instead of
		// lingering until backoff (up to reconnectBackoffMax) elapses — the
		// documented time.After-in-select pitfall, since pre-Go-1.23 a pending
		// timer cannot be garbage-collected until it fires.
		timer := time.NewTimer(backoff)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		}
		if backoff < reconnectBackoffMax {
			backoff *= 2
		}
	}
	return ctx.Err()
}

// ----- Session -----

type sessionOpts struct {
	poolURL    string
	user       string
	workers    []*miner.Worker
	merged     <-chan miner.Share
	interval   time.Duration
	dashboard  *tui.Dashboard
	startTime  time.Time
	wallet     string
	devices    int
	log        func(level, msg string)
	providers  []provider.Provider
	m          *engineMetrics
	powerWatts float64 // from config.PowerWatts; used for J/TH metric
	// curtailGate, when non-nil and raised, suppresses applying pool jobs to
	// workers (they stay idle) because BTC/USD is below the curtail threshold.
	curtailGate *atomic.Bool
	// tlsCAFile is the active pool's optional PEM CA bundle path (PoolConfig
	// .TLSCAFile), used to verify a private-CA/self-signed stratum+tls:// pool.
	tlsCAFile string
	// poolPassword is the active pool's configured password (PoolConfig
	// .Password), sent in the Stratum V1 mining.authorize call. Most V1
	// pools accept any value, but not all — see KNOWN_LIMITATIONS.md §10.
	poolPassword string
	// onConnected, if set, is called once the handshake completes and the
	// session is established. The reconnect loop uses it to mark the
	// active payout address as "known good" so it is not failed over.
	onConnected func()
	// activityMu/activity are the shared, arbitration-loop-owned view of
	// which providers are currently earning (see arbitrationLoopOpts).
	// buildStats reads them to populate ProviderStats.Active/SatsPerSecond
	// honestly instead of hardcoding Active: true. Either may be nil (no
	// arbitration loop wired, e.g. some tests), in which case every
	// provider renders inactive.
	activityMu *sync.Mutex
	activity   map[string]float64
}

// isCurtailed reports whether hashing is currently paused by the
// curtail_below_btc_usd threshold. Safe to call with a nil gate.
func (o sessionOpts) isCurtailed() bool {
	return o.curtailGate != nil && o.curtailGate.Load()
}

// updateLiveness feeds the stall monitor and sets the otedama_up gauge,
// honouring curtailment. While curtailed the miner is intentionally idle, so a
// zero hashrate is *expected*, not a fault: the stall monitor is not advanced
// (no false "hashrate stalled — check device health" warning) and otedama_up
// stays 1 (healthy, deliberately paused). otedama_curtailed carries the paused
// signal separately, so operators can alert on otedama_up==0 for real stalls
// without being paged during a price-driven pause. Returns whether the miner
// is in a fault stall (for the dashboard badge); always false while curtailed.
func (o sessionOpts) updateLiveness(hashMon *HashrateMonitor, currentHashRate float64) bool {
	if o.isCurtailed() {
		if o.m != nil {
			o.m.up.Set(1)
		}
		return false
	}
	hashMon.Observe(currentHashRate)
	stalled := hashMon.Stalled()
	if o.m != nil {
		if stalled {
			o.m.up.Set(0)
		} else {
			o.m.up.Set(1)
		}
	}
	return stalled
}

type poolMsg struct {
	msg stratum.Message
	err error
}

// runSession runs one pool connection: dial, handshake, then stream
// jobs to workers and shares back to the pool until the connection
// drops or ctx is cancelled. Returns the error that ended the session
// (nil if ctx was cancelled cleanly).
//
// Stratum V1 URLs (stratum+tcp://, stratum+tls://) are handled via
// poolproto.DialURL so the protocol abstraction is load-bearing for V1.
// The Stratum V2 path uses the existing inline framing code until the
// V2 poolproto dialer completes Step 3b (docs/KNOWN_LIMITATIONS.md §3).
func runSession(ctx context.Context, opts sessionOpts) error {
	proto := poolproto.FromURL(opts.poolURL)
	opts.log("info", fmt.Sprintf("engine: transport protocol: %s", proto))
	if proto == poolproto.ProtocolStratumV1 || proto == poolproto.ProtocolStratumV1TLS {
		return runSessionV1(ctx, opts)
	}

	host, err := parseHost(opts.poolURL)
	if err != nil {
		return fmt.Errorf("engine: bad pool URL %q: %w", opts.poolURL, err)
	}

	var conn net.Conn
	if proto == poolproto.ProtocolStratumV2TLS {
		// A configured v2tls:// pool gets an actual, certificate-verified
		// TLS connection — never a silent plaintext downgrade (see
		// docs/KNOWN_LIMITATIONS.md §2). Mirrors the identical fix already
		// applied to stratumv1's stratum+tls:// scheme.
		var tlsCfg *tls.Config
		if opts.tlsCAFile != "" {
			if pem, rerr := os.ReadFile(opts.tlsCAFile); rerr != nil {
				opts.log("warn", fmt.Sprintf("engine: cannot read tls_ca_file %q: %v; using system roots only",
					opts.tlsCAFile, rerr))
			} else if cfg, cerr := stratum.TLSConfigWithExtraCAs(pem); cerr != nil {
				return fmt.Errorf("engine: %w", cerr)
			} else {
				tlsCfg = cfg
			}
		}
		conn, err = stratum.DialTLS(ctx, host, tlsCfg)
		if err != nil {
			return fmt.Errorf("engine: TLS dial %s: %w", host, err)
		}
	} else {
		// Plaintext Stratum V2: no transport encryption today (§2 — the
		// Noise NX handshake exists but the engine's connect path never
		// invokes it). Encryption for this scheme awaits the secp256k1
		// dependency decision (ADR-011); use stratum+v2tls:// for
		// confidentiality in the meantime.
		opts.log("warn", "engine: connecting over plaintext Stratum V2 — no transport encryption "+
			"(Noise NX is not yet wired into the live connect path; use stratum+v2tls:// for TLS, "+
			"or stratum+tls:// / stratum+tcp:// with the V1 fallback)")
		var d net.Dialer
		conn, err = d.DialContext(ctx, "tcp", host)
		if err != nil {
			return fmt.Errorf("engine: dial %s: %w", host, err)
		}
	}
	defer conn.Close()
	opts.log("info", fmt.Sprintf("engine: connected to %s", host))

	dec := stratum.NewDecoder(conn)
	chanID, shareTarget, err := handshake(conn, dec, opts.poolURL, opts.user, opts.workers)
	if err != nil {
		return err
	}
	opts.log("info", fmt.Sprintf("engine: channel %d opened", chanID))
	if opts.m != nil {
		opts.m.poolConnectionState.Set(2) // handshake complete → connected
	}
	if opts.onConnected != nil {
		opts.onConnected()
	}

	// Spawn reader goroutine.
	inCh := make(chan poolMsg, 32)
	go func() {
		defer close(inCh)
		for {
			f, err := dec.ReadFrame()
			if err != nil {
				select {
				case inCh <- poolMsg{err: err}:
				case <-ctx.Done():
				}
				return
			}
			msg, err := stratum.DispatchFrame(f)
			select {
			case inCh <- poolMsg{msg: msg, err: err}:
			case <-ctx.Done():
				return
			}
		}
	}()

	var seqNum uint32
	// estSats is the running estimated earnings shown in the TUI, produced by
	// integrating the arbitration expected-yield rate over productive time
	// (satsAcc). It is not a per-share tally — a share carries no sat value on
	// the wire (KNOWN_LIMITATIONS.md §9).
	var estSats uint64
	var satsAcc satsAccountant
	statsTicker := time.NewTicker(opts.interval)
	defer statsTicker.Stop()

	// Watch for a stalled miner (zero hashrate sustained across samples).
	hashMon := NewHashrateMonitor(0, 3, opts.log)
	// Differentiate the cumulative hash counter into a current rate; the
	// stall monitor and the hashrate gauge both consume this, not the
	// lifetime average (which can never reach the stall floor).
	var hashWindow hashrateWindow
	// Accumulate productive (actually-hashing) time for effective-uptime accounting.
	var uptime uptimeAccountant

	// Track dropped shares so a consumer that cannot keep up surfaces as a
	// warning rather than silently losing found shares.
	var lastDropped uint64

	// Track share-submission round-trip latency. submitTimes maps a
	// sequence number to the time the share was sent; entries are
	// settled (and deleted) on SubmitSharesSuccess, and additionally
	// capped at submitTimesCap below so a pool that never acknowledges
	// cannot grow the map without bound over a long session.
	latency := NewLatencyTracker(256)
	submitTimes := make(map[uint32]time.Time)
	const submitTimesCap = 1024

	// SV2 job / chain-tip state. A block header cannot be hashed until
	// BOTH a job (merkle root + version, via NewMiningJob) and the chain
	// tip (prev_hash + network nBits + ntime, via SetNewPrevHash) are
	// known. Jobs without min_ntime are *future jobs*: they activate only
	// when a SetNewPrevHash names their job_id. SetNewPrevHash also
	// invalidates every other outstanding job (they extend a stale tip).
	jobs := make(map[uint32]*stratum.NewMiningJob)
	var active *stratum.NewMiningJob // job the workers are currently hashing
	var prevHash [32]byte
	var prevNBits uint32
	var activeNTime uint32
	havePrev := false

	// startJob points the workers at job j against the current chain tip
	// and share target. Callers must ensure havePrev is true. While
	// curtailed (BTC/USD below threshold) the job/tip state is still
	// tracked but the workers stay idle — hashing resumes on the next
	// activation event after the price recovers, matching the documented
	// "resumes on next job" semantics.
	startJob := func(j *stratum.NewMiningJob, ntime uint32) {
		active = j
		activeNTime = ntime
		if opts.isCurtailed() {
			opts.log("debug", fmt.Sprintf("engine: job %d ignored (curtailed)", j.JobID))
			return
		}
		updateWork(opts.workers, j, chanID, prevHash, prevNBits, ntime, shareTarget)
		opts.log("info", fmt.Sprintf("engine: job %d version=0x%08X active", j.JobID, j.Version))
	}

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()

		case <-statsTicker.C:
			currentHashRate := hashWindow.observe(totalHashes(opts.workers), time.Now())
			logStats(opts.workers, currentHashRate, opts.log)
			if dropped := totalDropped(opts.workers); dropped > lastDropped {
				opts.log("warn", fmt.Sprintf(
					"engine: dropped %d found share(s) — share submission is not keeping up with discovery",
					dropped-lastDropped))
				lastDropped = dropped
			}
			stalled := opts.updateLiveness(hashMon, currentHashRate)
			// Accumulate estimated earnings before building the dashboard
			// snapshot so the displayed figure reflects this tick. The rate is
			// the arbitration expected yield (0 when metrics are disabled or no
			// quote has arrived yet); the productive flag gates out idle/stalled
			// time so downtime never accrues phantom earnings.
			var expectedYieldRate float64
			if opts.m != nil {
				expectedYieldRate = opts.m.arbitrationExpectedYieldSatsPerSec.Value()
			}
			estSats = uint64(satsAcc.observe(time.Now(), expectedYieldRate, currentHashRate > 0 && !stalled))
			if opts.dashboard != nil {
				opts.dashboard.Update(buildStats(opts, currentHashRate, estSats, latency, stalled))
			}
			if opts.m != nil {
				opts.m.hashrate.Set(currentHashRate)
				uptime.observe(time.Now(), currentHashRate > 0 && !stalled, opts.m.productiveSeconds)
				opts.m.effectiveYieldSatsPerSec.Set(effectiveYield(
					opts.m.arbitrationExpectedYieldSatsPerSec.Value(),
					float64(opts.m.productiveSeconds.Value()),
					opts.m.uptime.Value()))
				// otedama_up is set by updateLiveness (curtailment-aware).
				// J/TH efficiency: only meaningful when power is configured and
				// the miner is running (avoids division-by-zero and spurious 0).
				if opts.powerWatts > 0 {
					opts.m.powerWatts.Set(opts.powerWatts)
					if currentHashRate > 0 {
						opts.m.joulesPerTerahash.Set(opts.powerWatts * 1e12 / currentHashRate)
					}
				}
				// Recompute acceptance / reject / stale rate gauges.
				// Warn once-per-tick if acceptance has dropped below the
				// "acceptable" band (industry guidance: >1% reject ≈
				// <99% acceptance warrants attention).
				rate, judged := opts.m.updateShareRates()
				if judged >= 20 && rate < 0.97 {
					opts.log("warn", fmt.Sprintf(
						"engine: share acceptance %.1f%% (%d/%d) — check the reject-reason breakdown",
						rate*100, opts.m.sharesAccepted.Value(), judged))
				}
			}
			if p95 := latency.Quantile(0.95); p95 > 0 {
				opts.log("info", fmt.Sprintf(
					"engine: submit latency p50=%.0fms p95=%.0fms p99=%.0fms",
					latency.Quantile(0.50), p95, latency.Quantile(0.99)))
				if opts.m != nil {
					opts.m.submitLatencyP50.Set(latency.Quantile(0.50))
					opts.m.submitLatencyP95.Set(p95)
					opts.m.submitLatencyP99.Set(latency.Quantile(0.99))
				}
			}

		case pm, ok := <-inCh:
			if !ok {
				return fmt.Errorf("engine: pool closed connection")
			}
			if pm.err != nil {
				return fmt.Errorf("engine: pool read: %w", pm.err)
			}
			if pm.msg.NewMiningJob != nil {
				j := pm.msg.NewMiningJob
				jobs[j.JobID] = j
				switch {
				case j.HasMinNtime && havePrev:
					// Job for the current chain tip: mine it now. Its own
					// min_ntime supersedes the tip's (it is never older).
					startJob(j, j.MinNtime)
				case !j.HasMinNtime:
					// Future job: valid only for a chain tip we have not
					// seen yet. Hold until SetNewPrevHash names it.
					opts.log("info", fmt.Sprintf("engine: job %d stored (future job, awaiting prev-hash)", j.JobID))
				default:
					// Job claims to be currently valid but we have never
					// received a SetNewPrevHash, so the header's prev_hash
					// is unknown. Hashing now would produce garbage.
					opts.log("info", fmt.Sprintf("engine: job %d held (no prev-hash yet)", j.JobID))
				}
				// The pool connection is alive regardless of whether the job
				// was armed (curtailment, future job): lastJobReceivedAt
				// tracks pool liveness, not hashing.
				if opts.m != nil {
					opts.m.lastJobReceivedAt.Set(float64(time.Now().Unix()))
				}
			}
			if pm.msg.SetNewPrevHash != nil {
				p := pm.msg.SetNewPrevHash
				prevHash = p.PrevHash
				prevNBits = p.NBits
				havePrev = true
				// The new tip invalidates every job except the one it names.
				named := jobs[p.JobID]
				jobs = map[uint32]*stratum.NewMiningJob{}
				if named != nil {
					jobs[p.JobID] = named
					ntime := p.MinNtime
					if named.HasMinNtime && named.MinNtime > ntime {
						ntime = named.MinNtime
					}
					startJob(named, ntime)
					opts.log("info", fmt.Sprintf("engine: new prev-hash, job %d nBits=0x%08X",
						p.JobID, p.NBits))
				} else {
					// Tip references a job we never received — stop hashing
					// the stale job rather than mining a wrong header.
					active = nil
					for _, w := range opts.workers {
						w.SetWork(nil)
					}
					opts.log("warn", fmt.Sprintf("engine: SetNewPrevHash names unknown job %d; pausing until next job", p.JobID))
				}
			}
			if pm.msg.SetTarget != nil {
				shareTarget = miner.Hash(pm.msg.SetTarget.MaxTarget)
				// A new target applies to jobs received from now on, and to
				// already-received *future* jobs (those that arrived with an
				// empty min_ntime). It explicitly does NOT apply to a job
				// that arrived with min_ntime set: the spec fixes that job's
				// target for its lifetime, so re-targeting it would make the
				// pool and the miner judge the same share differently — too
				// easy a target produces low-difficulty rejections, too hard
				// a one silently withholds shares the pool would have paid
				// for. (sv2-spec 05-Mining-Protocol.md §5.3.21.)
				if active != nil && havePrev && !active.HasMinNtime {
					startJob(active, activeNTime)
					opts.log("info", "engine: share target updated by pool; active future job re-targeted")
				} else {
					opts.log("info", "engine: share target updated by pool; applies from the next job")
				}
			}
			if pm.msg.SubmitSharesSuccess != nil {
				opts.log("info", "engine: share accepted")
				if opts.m != nil {
					opts.m.sharesAccepted.Inc()
				}
				// Settle round-trip latency for every submitted share up
				// to LastSequenceNumber, then drop those entries.
				now := time.Now()
				last := pm.msg.SubmitSharesSuccess.LastSequenceNumber
				for seq, sent := range submitTimes {
					if seq <= last {
						latency.Record(float64(now.Sub(sent).Microseconds()) / 1000.0)
						delete(submitTimes, seq)
					}
				}
			}
			if pm.msg.SubmitSharesError != nil {
				reason := pm.msg.SubmitSharesError.Error
				category, diagnosis := rejectClass(reason)
				opts.log("warn", fmt.Sprintf("engine: share rejected: %s (%s)",
					reason, diagnosis))
				if opts.m != nil {
					opts.m.sharesRejected.Inc()
					opts.m.rejectReason(category).Inc()
					opts.m.touchLastReject(category, time.Now().Unix())
				}
			}

		case share, ok := <-opts.merged:
			if !ok {
				return ctx.Err()
			}
			seqNum++
			if opts.m != nil {
				opts.m.sharesFound.Inc()
				opts.m.incSharesFoundForDevice(share.DeviceID)
			}
			sub := stratum.SubmitSharesStandard{
				ChannelID:      chanID,
				SequenceNumber: seqNum,
				JobID:          share.JobID,
				Nonce:          share.Nonce,
				NTime:          share.NTime,
				// The version that was actually hashed, carried on the
				// share itself — the pool recomputes the header hash from
				// these fields, so any mismatch means a rejected share.
				NVersion: share.Version,
			}
			if err := sendMsg(conn, stratum.MsgSubmitSharesStandard, true, &sub); err != nil {
				return fmt.Errorf("engine: submit share: %w", err)
			}
			if opts.m != nil {
				opts.m.sharesSubmitted.Inc()
			}
			submitTimes[seqNum] = time.Now()
			if len(submitTimes) > submitTimesCap {
				// Pool is not acknowledging; drop the oldest half so the
				// map stays bounded. Latency for dropped entries is lost,
				// which is the honest outcome — it was never measured.
				cutoff := seqNum - submitTimesCap/2
				for seq := range submitTimes {
					if seq < cutoff {
						delete(submitTimes, seq)
					}
				}
			}
			opts.log("info", fmt.Sprintf("engine: share seq=%d nonce=0x%08X", seqNum, share.Nonce))
		}
	}
}

// runSessionV1 handles one Stratum V1 pool connection via poolproto.DialURL.
// It mirrors the structure of the V2 runSession loop but consumes the
// protocol-agnostic poolproto.Session interface (Jobs() / Submit()) instead
// of the Stratum V2 framing directly.
func runSessionV1(ctx context.Context, opts sessionOpts) error {
	// "x" is the long-standing convention for "no real password" across V1
	// pools/miners (most accept any value, some require non-empty), so an
	// unconfigured PoolConfig.Password keeps sending it — only a pool
	// operator who explicitly set password: in their config gets that value
	// instead. Previously this was hardcoded to "x" unconditionally, so a
	// configured password silently had no effect (KNOWN_LIMITATIONS.md §10).
	password := opts.poolPassword
	if password == "" {
		password = "x"
	}
	creds := poolproto.Credentials{
		User:     opts.user,
		Password: password,
	}
	// For a stratum+tls:// pool with a configured CA bundle, load it so the
	// dialer can verify a private-CA/self-signed certificate. An unreadable
	// file degrades to system-roots verification (which will cleanly fail for a
	// private-CA pool) — it never falls back to plaintext.
	if opts.tlsCAFile != "" {
		if pem, rerr := os.ReadFile(opts.tlsCAFile); rerr != nil {
			opts.log("warn", fmt.Sprintf("engine: cannot read tls_ca_file %q: %v; using system roots only",
				opts.tlsCAFile, rerr))
		} else {
			creds.TLSRootCAsPEM = pem
		}
	}
	sess, err := poolproto.DialURL(ctx, opts.poolURL, creds)
	if err != nil {
		return fmt.Errorf("engine: %w", err)
	}
	defer sess.Close()
	opts.log("info", fmt.Sprintf("engine: connected to %s (Stratum V1)", opts.poolURL))
	if opts.m != nil {
		opts.m.poolConnectionState.Set(2)
	}
	if opts.onConnected != nil {
		opts.onConnected()
	}

	// V1 is single-channel; channel ID 0 is the conventional value.
	const chanID = uint32(0)

	// estSats is the running estimated earnings shown in the TUI, integrated
	// from the arbitration expected-yield rate over productive time (satsAcc);
	// not a per-share tally (KNOWN_LIMITATIONS.md §9).
	var estSats uint64
	var satsAcc satsAccountant
	statsTicker := time.NewTicker(opts.interval)
	defer statsTicker.Stop()

	hashMon := NewHashrateMonitor(0, 3, opts.log)
	var hashWindow hashrateWindow
	var uptime uptimeAccountant
	var lastDropped uint64
	latency := NewLatencyTracker(256)

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()

		case <-statsTicker.C:
			currentHashRate := hashWindow.observe(totalHashes(opts.workers), time.Now())
			logStats(opts.workers, currentHashRate, opts.log)
			if dropped := totalDropped(opts.workers); dropped > lastDropped {
				opts.log("warn", fmt.Sprintf(
					"engine: dropped %d found share(s) — share submission is not keeping up with discovery",
					dropped-lastDropped))
				lastDropped = dropped
			}
			stalled := opts.updateLiveness(hashMon, currentHashRate)
			// Accumulate estimated earnings before building the dashboard
			// snapshot (see the V2 loop for the rationale). productive gates
			// out idle/stalled time; the rate is the arbitration expected yield.
			var expectedYieldRate float64
			if opts.m != nil {
				expectedYieldRate = opts.m.arbitrationExpectedYieldSatsPerSec.Value()
			}
			estSats = uint64(satsAcc.observe(time.Now(), expectedYieldRate, currentHashRate > 0 && !stalled))
			if opts.dashboard != nil {
				opts.dashboard.Update(buildStats(opts, currentHashRate, estSats, latency, stalled))
			}
			if opts.m != nil {
				opts.m.hashrate.Set(currentHashRate)
				uptime.observe(time.Now(), currentHashRate > 0 && !stalled, opts.m.productiveSeconds)
				opts.m.effectiveYieldSatsPerSec.Set(effectiveYield(
					opts.m.arbitrationExpectedYieldSatsPerSec.Value(),
					float64(opts.m.productiveSeconds.Value()),
					opts.m.uptime.Value()))
				// otedama_up is set by updateLiveness (curtailment-aware).
				if opts.powerWatts > 0 {
					opts.m.powerWatts.Set(opts.powerWatts)
					if currentHashRate > 0 {
						opts.m.joulesPerTerahash.Set(opts.powerWatts * 1e12 / currentHashRate)
					}
				}
				rate, judged := opts.m.updateShareRates()
				if judged >= 20 && rate < 0.97 {
					opts.log("warn", fmt.Sprintf(
						"engine: share acceptance %.1f%% (%d/%d) — check the reject-reason breakdown",
						rate*100, opts.m.sharesAccepted.Value(), judged))
				}
				// Publish pool difficulty and estimated share interval so
				// operators can distinguish "hardware is slow" from "the pool
				// assigned more difficulty than our hashrate can serve".
				publishDifficulty(opts.m, sess.SuggestedDifficulty(), currentHashRate)
			}
			if p95 := latency.Quantile(0.95); p95 > 0 {
				opts.log("info", fmt.Sprintf(
					"engine: submit latency p50=%.0fms p95=%.0fms p99=%.0fms",
					latency.Quantile(0.50), p95, latency.Quantile(0.99)))
				if opts.m != nil {
					opts.m.submitLatencyP50.Set(latency.Quantile(0.50))
					opts.m.submitLatencyP95.Set(p95)
					opts.m.submitLatencyP99.Set(latency.Quantile(0.99))
				}
			}

		case job, ok := <-sess.Jobs():
			if !ok {
				return fmt.Errorf("engine: pool closed connection")
			}
			// While curtailed, keep workers idle and ignore the job (see the
			// V2 path for rationale). lastJobReceivedAt still updates because
			// the pool connection remains alive.
			if opts.isCurtailed() {
				opts.log("debug", fmt.Sprintf("engine: V1 job %s ignored (curtailed)", job.JobID))
			} else {
				if err := applyJob(opts.workers, job, chanID, sess.SuggestedDifficulty()); err != nil {
					opts.log("warn", err.Error())
					continue
				}
				opts.log("info", fmt.Sprintf("engine: V1 job %s nBits=0x%08X", job.JobID, job.NBits))
			}
			if opts.m != nil {
				opts.m.lastJobReceivedAt.Set(float64(time.Now().Unix()))
			}

		case share, ok := <-opts.merged:
			if !ok {
				return ctx.Err()
			}
			if opts.m != nil {
				opts.m.sharesFound.Inc()
				opts.m.incSharesFoundForDevice(share.DeviceID)
			}
			// V1 Submit is synchronous. Run it in a goroutine so a slow
			// pool response doesn't block the job-receive path.
			capturedShare := share
			capturedSess := sess
			if opts.m != nil {
				// Counted here, not after Submit returns: "submitted" means
				// the transmission was attempted, matching the V2 path's
				// increment at send time rather than at response time — a
				// slow or failing pool response is a distinct, separately
				// tracked event (sharesAccepted/sharesRejected, or the "V1
				// submit" warning log on a hard failure).
				opts.m.sharesSubmitted.Inc()
			}
			go func() {
				sendTime := time.Now()
				// JobKey is the pool's own job ID string, carried through
				// the worker untouched: V1 job IDs are not numbers, so
				// reformatting the numeric JobID here would submit an ID
				// the pool never issued. ExtraNonce is left empty on
				// purpose — the V1 session knows which extranonce2 went
				// into this job's merkle root and fills it in.
				result, err := capturedSess.Submit(ctx, poolproto.ShareSubmission{
					JobID: capturedShare.JobKey,
					Nonce: capturedShare.Nonce,
					NTime: capturedShare.NTime,
				})
				elapsed := float64(time.Since(sendTime).Milliseconds())
				if err != nil {
					opts.log("warn", fmt.Sprintf("engine: V1 submit: %v", err))
					// Still record the latency on error: a p99 spike caused by
					// a pool disconnect is a signal worth surfacing, not hiding.
					if elapsed > 0 {
						latency.Record(elapsed)
					}
					return
				}
				if result.Accepted {
					opts.log("info", "engine: V1 share accepted")
					latency.Record(elapsed)
					if opts.m != nil {
						opts.m.sharesAccepted.Inc()
					}
				} else {
					category, diagnosis := rejectClass(result.Reason)
					opts.log("warn", fmt.Sprintf("engine: V1 share rejected: %s (%s)",
						result.Reason, diagnosis))
					if opts.m != nil {
						opts.m.sharesRejected.Inc()
						opts.m.rejectReason(category).Inc()
						opts.m.touchLastReject(category, time.Now().Unix())
					}
				}
			}()
		}
	}
}

// ----- Handshake -----

// handshake performs the SV2 SetupConnection + OpenMiningChannel exchange
// and returns the opened channel ID and the pool-assigned initial share
// target (OpenMiningChannelSuccess.Target). The share target is what
// workers must grind to: it is far easier than the block target, and a hash
// meeting it is exactly what the pool credits. A zero target means the pool
// did not assign one; the caller falls back to the block target.
func handshake(conn net.Conn, dec *stratum.Decoder, poolURL, user string, workers []*miner.Worker) (uint32, miner.Hash, error) {
	host, _ := parseHost(poolURL)
	endpointHost, endpointPort := stratum.SplitEndpoint(host)
	sc := stratum.SetupConnection{
		Protocol:        stratum.MiningProtocol,
		MinVersion:      2,
		MaxVersion:      2,
		EndpointHost:    endpointHost,
		EndpointPort:    endpointPort,
		Vendor:          "Otedama",
		HardwareVersion: "v3.0.0",
		Firmware:        "main",
		DeviceID:        "cpu",
	}
	if err := sendMsg(conn, stratum.MsgSetupConnection, false, &sc); err != nil {
		return 0, miner.Hash{}, err
	}
	f, err := dec.ReadFrame()
	if err != nil {
		return 0, miner.Hash{}, fmt.Errorf("engine: setup response: %w", err)
	}
	msg, err := stratum.DispatchFrame(f)
	if err != nil {
		return 0, miner.Hash{}, err
	}
	if msg.SetupConnectionError != nil {
		return 0, miner.Hash{}, &fatalError{"pool rejected: " + msg.SetupConnectionError.Error}
	}
	if msg.SetupConnectionSuccess == nil {
		return 0, miner.Hash{}, fmt.Errorf("engine: unexpected msg 0x%02X during setup", f.Header.MsgType)
	}

	var hashRate float32
	for _, w := range workers {
		hashRate += float32(w.Stats().HashRate)
	}
	omc := stratum.OpenMiningChannel{
		ReqID:           1,
		User:            user,
		NominalHashrate: hashRate,
	}
	if err := sendMsg(conn, stratum.MsgOpenMiningChannel, false, &omc); err != nil {
		return 0, miner.Hash{}, err
	}
	f, err = dec.ReadFrame()
	if err != nil {
		return 0, miner.Hash{}, fmt.Errorf("engine: channel response: %w", err)
	}
	msg, err = stratum.DispatchFrame(f)
	if err != nil {
		return 0, miner.Hash{}, err
	}
	if msg.OpenMiningChannelSuccess == nil {
		return 0, miner.Hash{}, fmt.Errorf("engine: channel open failed")
	}
	omcs := msg.OpenMiningChannelSuccess
	// SV2 target and miner.Hash are both little-endian U256s, so the bytes
	// map directly.
	return omcs.ChannelID, miner.Hash(omcs.Target), nil
}

// ----- Shared helpers -----

type encodable interface{ Encode() ([]byte, error) }

func sendMsg(conn net.Conn, msgType uint8, isChannel bool, enc encodable) error {
	payload, err := enc.Encode()
	if err != nil {
		return fmt.Errorf("engine: encode 0x%02X: %w", msgType, err)
	}
	f, err := stratum.WrapMessage(msgType, isChannel, payload)
	if err != nil {
		return fmt.Errorf("engine: wrap 0x%02X: %w", msgType, err)
	}
	data, err := stratum.EncodeFrame(f)
	if err != nil {
		return err
	}
	// A wedged/half-open socket must not block the session loop forever:
	// fail the write, let the reconnect loop take over.
	_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	_, err = conn.Write(data)
	return err
}

// updateWork points every worker at the given job, hashed against the
// current chain tip (prevHash + network prevNBits) at timestamp ntime,
// comparing hashes against shareTarget — the POOL-ASSIGNED share
// difficulty from OpenMiningChannelSuccess/SetTarget, not the network
// target. All five header inputs (version, prev-hash, merkle root, time,
// bits) are populated; a header missing any of them hashes to a value no
// pool can accept.
//
// Grind to the pool-assigned share target, not the block target. The
// share target is far easier; a hash meeting it is exactly what the pool
// credits, and every comparable miner submits against it. Using the block
// target here would mean a worker only ever emits a share on an actual
// block solve — effectively never, so the pool would see no shares at
// all. Fall back to the block target only when the pool assigned none
// (zero target).
func updateWork(workers []*miner.Worker, job *stratum.NewMiningJob, chanID uint32,
	prevHash [32]byte, prevNBits uint32, ntime uint32, shareTarget miner.Hash) {
	target := shareTarget
	if target == (miner.Hash{}) {
		t, err := miner.TargetFromNBits(prevNBits)
		if err != nil {
			return
		}
		target = t
	}
	w := &miner.Work{
		JobID:     job.JobID,
		ChannelID: chanID,
		Header: miner.Header{
			Version:    job.Version,
			PrevHash:   prevHash,
			MerkleRoot: job.MerkleRoot,
			Time:       ntime,
			Bits:       prevNBits,
		},
		NBits:  prevNBits,
		Target: target,
	}
	for _, wr := range workers {
		wr.SetWork(w)
	}
}

// v1JobTarget computes the mining target for a Stratum V1 job: the
// pool-assigned share target when difficulty > 0, or the nBits-derived
// block target otherwise.
//
// Stratum V1 difficulty arrives on its own mining.set_difficulty
// notification, not attached to mining.notify, and applies to every
// subsequent job until superseded. Grinding to the full nBits block target
// instead of the (far easier) pool-assigned share target — the bug this
// closes — means a worker essentially never produces a share the pool
// credits, since ordinary hardware cannot solve a real block. A difficulty
// of 0 (no set_difficulty received yet, e.g. the first job of a session)
// falls back to the nBits target, matching pre-wiring behaviour. Extracted
// as a pure function so the target-selection logic is unit-testable without
// a running Worker.
func v1JobTarget(nBits uint32, difficulty float64) (miner.Hash, error) {
	target, err := miner.TargetFromNBits(nBits)
	if err != nil {
		return miner.Hash{}, err
	}
	if difficulty > 0 {
		if dt, derr := miner.TargetFromDifficulty(difficulty); derr == nil {
			target = dt
		}
	}
	return target, nil
}

// applyJob converts a poolproto.Job (the protocol-agnostic job type
// delivered by poolproto.Session.Jobs()) into a miner.Work and pushes
// it to every worker. This is the bridge that lets the engine consume
// jobs from the poolproto abstraction rather than from a raw stratum
// decoder — the connection point for the engine→poolproto integration
// (docs/KNOWN_LIMITATIONS.md §3).
//
// All five header inputs are populated — version, prev-hash, merkle root,
// time, bits — because a header missing any of them hashes to a value no
// pool can accept. (The same defect was fixed on the Stratum V2 path in
// session 238; see KNOWN_LIMITATIONS §11.)
//
// The job's identifier travels as Work.JobKey, the pool's own string, and
// is echoed verbatim on submission. Stratum V1 job IDs are arbitrary
// strings — "6a4f", "1a3b0c", ids with leading zeros — so the numeric
// Work.JobID that Stratum V2 uses is only a best-effort convenience here
// (0 when the ID is not decimal) and nothing submits it.
//
// difficulty is the Stratum V1 session's most recent mining.set_difficulty
// value (poolproto.Job carries no difficulty field: V1 delivers it on a
// separate notification that applies to every job until superseded, not
// attached to mining.notify). See v1JobTarget for how it is applied.
func applyJob(workers []*miner.Worker, job poolproto.Job, chanID uint32, difficulty float64) error {
	target, err := v1JobTarget(job.NBits, difficulty)
	if err != nil {
		return fmt.Errorf("engine: bad target for job %q: %w", job.JobID, err)
	}
	var jobID uint32
	if n, serr := fmt.Sscanf(job.JobID, "%d", &jobID); n != 1 || serr != nil {
		jobID = 0
	}
	w := &miner.Work{
		JobID:     jobID,
		JobKey:    job.JobID,
		ChannelID: chanID,
		Header: miner.Header{
			Version:    job.Version,
			PrevHash:   job.PrevHash,
			MerkleRoot: job.MerkleRoot,
			Time:       job.NTime,
			Bits:       job.NBits,
		},
		NBits:  job.NBits,
		Target: target,
	}
	for _, wr := range workers {
		wr.SetWork(w)
	}
	return nil
}

func parseHost(url string) (string, error) {
	host, err := poolproto.StripScheme(url)
	if err != nil {
		return "", fmt.Errorf("engine: %w", err)
	}
	return host, nil
}

func isFatal(err error) bool { _, ok := err.(*fatalError); return ok }

type fatalError struct{ msg string }

func (e *fatalError) Error() string { return e.msg }
