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
//	│  Mining     ├──────────►│              ├────────────►│   Workers    │
//	│  Provider   │           │  Arbitration │             │  (CPU/GPU)   │
//	│  AI/Akash   ├──────────►│   Engine     │             └──────┬───────┘
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
	"fmt"
	"io"
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
	"github.com/shizukutanaka/Otedama/internal/rates"
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

	// Explain, if set, receives the arbitration DecisionSnapshot after
	// every Decide cycle (ADR-010 A9). The HTTP server reads the same
	// pointer to serve /arbitration, and `otedama arb explain` renders it.
	// Nil disables snapshot recording.
	Explain *atomic.Pointer[arbitration.DecisionSnapshot]
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
	devices, err := detectDevices(ctx, opts.Config.ASICEndpoints, log)
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
	rateFetcher := rates.NewFetcher(95000) // $95k fallback
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
	miningProvider, akashProvider := startProviders(ctx, opts.Config, rateFetcher, devices, workers, log)
	defer miningProvider.Stop()
	defer akashProvider.Stop()

	// ----- Phase 6: Arbitration engine -----
	quoteCh := mergeQuotes(ctx,
		miningProvider.Quotes(),
		akashProvider.Quotes(),
	)

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
	incomeMode, err := arbitration.ParseIncomeMode(opts.Config.IncomeMode)
	if err != nil {
		log("warn", fmt.Sprintf("config: %v; falling back to income_mode=max", err))
	}
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
		incomeMode:    incomeMode,
		activityMu:    &activityMu,
		activity:      activity,
		explain:       opts.Explain,
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
		providers:   []provider.Provider{miningProvider, akashProvider},
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

// desiredShareIntervalSeconds is the share interval the engine asks the
// pool for via mining.suggest_difficulty — a typical pool-side var-diff
// target. Advisory only; pools clamp to their own bounds.
const desiredShareIntervalSeconds = 15

// sessionTelemetry carries the per-session accumulators the stats tick
// maintains — shared by the V1 and V2 session loops so their tick
// bodies stay identical.
type sessionTelemetry struct {
	estSats     uint64
	satsAcc     satsAccountant
	hashMon     *HashrateMonitor
	hashWindow  hashrateWindow
	uptime      uptimeAccountant
	lastDropped uint64
	latency     *LatencyTracker

	// unaccountedMon turns the otedama_shares_unaccounted gauge into an
	// operator-visible warning when found-but-unjudged shares persist.
	unaccountedMon *unaccountedWatchdog

	// lastHashrate retains the most recent measured hashrate so the
	// one-shot difficulty suggestion can wait for a real reading.
	lastHashrate float64
	// difficultySuggested arms the once-per-session
	// mining.suggest_difficulty hint (V1 only; sessions without a
	// client→pool suggestion mechanism mark it and skip).
	difficultySuggested bool
	// hashrateNotified* track the SV2 UpdateChannel nominal-hashrate
	// notification: sent once on first measurement, then again when the
	// measured rate drifts ±25% — debounced at once a minute.
	hashrateNotified      bool
	hashrateNotifiedValue float64
	hashrateNotifiedAt    time.Time
}

// updateChannelMinInterval debounces SV2 UpdateChannel re-notifications
// — far below the spec's ≤1/s proxy bound; an end device whose rate
// swings needs an occasional nudge, not a stream of updates.
const updateChannelMinInterval = time.Minute

// updateChannelDriftUp/Down bound the hashrate drift (as a ratio of the
// last notified value) that warrants a fresh UpdateChannel.
const (
	updateChannelDriftUp   = 1.25
	updateChannelDriftDown = 0.75
)

func newSessionTelemetry(log func(string, string)) *sessionTelemetry {
	return &sessionTelemetry{
		hashMon: NewHashrateMonitor(0, 3, log),
		latency: NewLatencyTracker(256),

		unaccountedMon: newUnaccountedWatchdog(log),
	}
}

// observeLatencyHist records one settled share round-trip in the
// seconds-denominated submit-latency histogram, tagging the bucket with
// the share's identity as the OpenMetrics exemplar. The V2 adapter owns
// sequence-number correlation now, so {job_id} is the exemplar key on
// both protocols.
func (t *sessionTelemetry) observeLatencyHist(opts *sessionOpts, ms float64, jobID uint32) {
	if opts.m != nil && opts.m.submitLatencyHist != nil && ms > 0 {
		opts.m.submitLatencyHist.ObserveWithExemplar(ms/1000, map[string]string{
			"job_id": fmt.Sprintf("%d", jobID),
		})
	}
}

// tick publishes one stats interval: hashrate + stall/liveness,
// earnings accrual, dropped-share warnings, share-acceptance rate,
// pool difficulty, and submit-latency quantiles.
func (t *sessionTelemetry) tick(now time.Time, opts *sessionOpts, suggestedDifficulty float64) {
	currentHashRate := t.hashWindow.observe(totalHashes(opts.workers), now)
	t.lastHashrate = currentHashRate
	logStats(opts.workers, currentHashRate, opts.log)
	if dropped := totalDropped(opts.workers); dropped > t.lastDropped {
		opts.log("warn", fmt.Sprintf(
			"engine: dropped %d found share(s) — share submission is not keeping up with discovery",
			dropped-t.lastDropped))
		t.lastDropped = dropped
	}
	stalled := opts.updateLiveness(t.hashMon, currentHashRate)
	// estSats is the running estimated earnings shown in the TUI,
	// integrated from the arbitration expected-yield rate over
	// productive time (satsAcc); not a per-share tally
	// (KNOWN_LIMITATIONS.md §9).
	var expectedYieldRate float64
	if opts.m != nil {
		expectedYieldRate = opts.m.arbitrationExpectedYieldSatsPerSec.Value()
	}
	t.estSats = uint64(t.satsAcc.observe(now, expectedYieldRate, currentHashRate > 0 && !stalled))
	if opts.dashboard != nil {
		opts.dashboard.Update(buildStats(*opts, currentHashRate, t.estSats, t.latency, stalled))
	}
	if opts.m != nil {
		opts.m.hashrate.Set(currentHashRate)
		t.uptime.observe(now, currentHashRate > 0 && !stalled, opts.m.productiveSeconds)
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
		rate, judged, unaccounted := opts.m.updateShareRates()
		t.unaccountedMon.observe(unaccounted)
		if judged >= 20 && rate < 0.97 {
			opts.log("warn", fmt.Sprintf(
				"engine: share acceptance %.1f%% (%d/%d) — check the reject-reason breakdown",
				rate*100, opts.m.sharesAccepted.Value(), judged))
		}
		// Publish pool difficulty and estimated share interval so
		// operators can distinguish "hardware is slow" from "the pool
		// assigned more difficulty than our hashrate can serve".
		publishDifficulty(opts.m, suggestedDifficulty, currentHashRate)
	}
	if p95 := t.latency.Quantile(0.95); p95 > 0 {
		opts.log("info", fmt.Sprintf(
			"engine: submit latency p50=%.0fms p95=%.0fms p99=%.0fms",
			t.latency.Quantile(0.50), p95, t.latency.Quantile(0.99)))
		if opts.m != nil {
			opts.m.submitLatencyP50.Set(t.latency.Quantile(0.50))
			opts.m.submitLatencyP95.Set(p95)
			opts.m.submitLatencyP99.Set(t.latency.Quantile(0.99))
		}
	}
}

// suggestDifficultyOnce sends the pool a one-shot measured-hashrate
// notification per session, on the first tick after the local hashrate
// has actually been measured — a notification made at handshake time
// (hashrate 0/unknown) would be meaningless. V1 sessions send
// mining.suggest_difficulty (targeting a share every
// desiredShareIntervalSeconds at the measured rate; low-hashrate
// devices benefit most, since a pool default difficulty calibrated for
// ASICs can otherwise be so high that the pool-side var-diff never
// observes a share rate to bootstrap from); V2 sessions send
// UpdateChannel with the measured nominal hashrate. Sessions with
// neither mechanism mark the flag and skip.
func (t *sessionTelemetry) suggestDifficultyOnce(ctx context.Context, sess poolproto.Session, log func(string, string)) {
	if t.difficultySuggested || t.lastHashrate <= 0 {
		return
	}
	t.difficultySuggested = true
	suggester, ok := sess.(poolproto.DifficultySuggester)
	if !ok {
		return
	}
	diff := t.lastHashrate * desiredShareIntervalSeconds / 4294967296
	go func() {
		if err := suggester.SuggestDifficulty(ctx, diff); err != nil {
			log("info", fmt.Sprintf("engine: share-difficulty suggestion failed: %v", err))
			return
		}
		log("info", fmt.Sprintf(
			"engine: suggested share difficulty %.4g to pool (measured %.3g H/s, target share interval %ds — advisory, pool var-diff decides)",
			diff, t.lastHashrate, desiredShareIntervalSeconds))
	}()
}

// updateChannelHashrate sends the SV2 UpdateChannel nominal-hashrate
// notification (§5.3.7) — once on the first measured hashrate, then
// again whenever the rate drifts beyond ±25% of the last notified
// value, debounced at updateChannelMinInterval. Drift re-notification
// is what lets the pool's var-diff and job sizing follow a device that
// throttles, switches streams, or loses a worker mid-session — the
// message is advisory and carries no difficulty request
// (maximum_target stays unbounded, var-diff pool-authoritative).
// Sessions without the mechanism (V1) return immediately.
func (t *sessionTelemetry) updateChannelHashrate(ctx context.Context, sess poolproto.Session, log func(string, string)) {
	u, ok := sess.(poolproto.NominalHashrateUpdater)
	if !ok || t.lastHashrate <= 0 {
		return
	}
	now := time.Now()
	if t.hashrateNotified {
		if now.Sub(t.hashrateNotifiedAt) < updateChannelMinInterval {
			return
		}
		drift := t.lastHashrate / t.hashrateNotifiedValue
		if drift < updateChannelDriftUp && drift > updateChannelDriftDown {
			return
		}
	}
	t.hashrateNotified = true
	t.hashrateNotifiedValue = t.lastHashrate
	t.hashrateNotifiedAt = now
	hashrate := t.lastHashrate
	go func() {
		if err := u.UpdateNominalHashrate(ctx, hashrate); err != nil {
			log("info", fmt.Sprintf("engine: nominal-hashrate update failed: %v", err))
			return
		}
		log("info", fmt.Sprintf("engine: notified pool of measured nominal hashrate %.3g H/s (SV2 UpdateChannel — advisory)", hashrate))
	}()
}

func runSession(ctx context.Context, opts sessionOpts) error {
	proto := poolproto.FromURL(opts.poolURL)
	opts.log("info", fmt.Sprintf("engine: transport protocol: %s", proto))
	if proto == poolproto.ProtocolStratumV1 || proto == poolproto.ProtocolStratumV1TLS {
		return runSessionV1(ctx, opts)
	}

	if proto == poolproto.ProtocolStratumV2 || proto == poolproto.ProtocolStratumV2TLS {
		return runSessionV2(ctx, &opts)
	}
	return fmt.Errorf("engine: no dialer for pool URL %q", opts.poolURL)
}

// dialPool builds the session credentials (user, password, optional TLS
// CA bundle), dials the pool via the poolproto registry, and performs
// the shared post-connect bookkeeping (connected log, connection-state
// gauge, onConnected hook). With a configured CA bundle the dialer
// verifies a private-CA/self-signed pool certificate; an unreadable
// file degrades to system roots (which cleanly fails for a private-CA
// pool) — it never falls back to plaintext.
func dialPool(ctx context.Context, opts *sessionOpts, password, protoLabel string) (poolproto.Session, error) {
	creds := poolproto.Credentials{User: opts.user, Password: password}
	if opts.tlsCAFile != "" {
		pem, rerr := os.ReadFile(opts.tlsCAFile)
		if rerr != nil {
			opts.log("warn", fmt.Sprintf("engine: cannot read tls_ca_file %q: %v; using system roots only",
				opts.tlsCAFile, rerr))
		} else {
			creds.TLSRootCAsPEM = pem
		}
	}
	sess, err := poolproto.DialURL(ctx, opts.poolURL, creds)
	if err != nil {
		return nil, fmt.Errorf("engine: %w", err)
	}
	opts.log("info", fmt.Sprintf("engine: connected to %s (%s)", opts.poolURL, protoLabel))
	if opts.m != nil {
		opts.m.poolConnectionState.Set(2)
	}
	if opts.onConnected != nil {
		opts.onConnected()
	}
	return sess, nil
}

// runSessionV2 handles one Stratum V2 pool connection via poolproto.DialURL,
// consuming the same protocol-agnostic Session interface as runSessionV1
// through the stratumv2 adapter. The adapter owns the SV2 specifics the
// inline loop used to track here: the job/chain-tip state machine
// (NewMiningJob + SetNewPrevHash activation), submit sequence numbering
// and verdict correlation, SetTarget-driven target updates (carried on
// Job.Target), and pending-share drain on disconnect.
func runSessionV2(ctx context.Context, opts *sessionOpts) error {
	if poolproto.FromURL(opts.poolURL) == poolproto.ProtocolStratumV2 {
		// Plaintext Stratum V2: no transport encryption today (§2 — the
		// Noise NX handshake exists but the connect path never invokes
		// it). Encryption for this scheme awaits the secp256k1
		// dependency decision (ADR-011); use stratum+v2tls:// for
		// confidentiality in the meantime.
		opts.log("warn", "engine: connecting over plaintext Stratum V2 — no transport encryption "+
			"(Noise NX is not yet wired into the live connect path; use stratum+v2tls:// for TLS, "+
			"or stratum+tls:// / stratum+tcp:// with the V1 fallback)")
	}
	sess, err := dialPool(ctx, opts, opts.poolPassword, "Stratum V2")
	if err != nil {
		return err
	}
	defer sess.Close()

	// The channel ID negotiated in OpenMiningChannel, used to label the
	// work workers hash on. Sessions not implementing ChannelIdentifier
	// use the conventional channel 0.
	var chanID uint32
	if ident, ok := sess.(poolproto.ChannelIdentifier); ok {
		chanID = ident.ChannelID()
	}
	opts.log("info", fmt.Sprintf("engine: channel %d opened", chanID))

	// estSats, latency and friends live on the shared sessionTelemetry
	// accumulator so both session loops tick identically.
	rt := newSessionTelemetry(opts.log)
	statsTicker := time.NewTicker(opts.interval)
	defer statsTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()

		case <-statsTicker.C:
			rt.tick(time.Now(), opts, sess.SuggestedDifficulty())
			rt.suggestDifficultyOnce(ctx, sess, opts.log)
			rt.updateChannelHashrate(ctx, sess, opts.log)
		case job, ok := <-sess.Jobs():
			if !ok {
				return fmt.Errorf("engine: pool closed connection")
			}
			dispatchJob(opts, &job, chanID, 0, "V2")

		case share, ok := <-opts.merged:
			if !ok {
				return ctx.Err()
			}
			if opts.m != nil {
				opts.m.sharesFound.Inc()
				opts.m.incSharesFoundForDevice(share.DeviceID)
			}
			// Submit waits for the pool's verdict; run it in a goroutine
			// so a slow response doesn't block the job-receive path.
			if opts.m != nil {
				// Counted at send-attempt time so "submitted" tracks the
				// transmission, distinct from the verdict (accepted/
				// rejected, or unaccounted when no verdict ever arrives).
				opts.m.sharesSubmitted.Inc()
			}
			go submitV2Share(ctx, sess, rt, opts, share)
		}
	}
}

// dispatchJob applies one pool job to the workers unless curtailment
// is active, and stamps lastJobReceivedAt either way — the pool
// connection is alive even while curtailed. An applyJob failure only
// warns; the session loop continues.
func dispatchJob(opts *sessionOpts, job *poolproto.Job, chanID uint32, difficulty float64, tag string) {
	if opts.isCurtailed() {
		opts.log("debug", fmt.Sprintf("engine: %s job %s ignored (curtailed)", tag, job.JobID))
	} else {
		if err := applyJob(opts.workers, *job, chanID, difficulty); err != nil {
			opts.log("warn", err.Error())
			return
		}
		opts.log("info", fmt.Sprintf("engine: %s job %s nBits=0x%08X", tag, job.JobID, job.NBits))
	}
	if opts.m != nil {
		opts.m.lastJobReceivedAt.Set(float64(time.Now().Unix()))
	}
}

// submitV2Share sends one share to the pool and records the verdict —
// latency sample, accept/reject counters, and reject classification.
// Unconfirmed results (deadline expired, or the connection dropped with
// the submit still pending) are left unaccounted: the pool never judged
// them, so they must not enter either judged counter.
func submitV2Share(ctx context.Context, sess poolproto.Session, rt *sessionTelemetry, opts *sessionOpts, share miner.Share) {
	sendTime := time.Now()
	result, err := sess.Submit(ctx, poolproto.ShareSubmission{
		JobID:   fmt.Sprintf("%d", share.JobID),
		Nonce:   share.Nonce,
		NTime:   share.NTime,
		Version: share.Version,
	})
	// Sub-millisecond precision: loopback RTTs are far below 1ms and
	// Milliseconds() would truncate every sample to 0.
	elapsed := float64(time.Since(sendTime).Microseconds()) / 1000.0
	if err != nil {
		opts.log("warn", fmt.Sprintf("engine: V2 submit: %v", err))
		if elapsed > 0 {
			rt.latency.Record(elapsed)
			rt.observeLatencyHist(opts, elapsed, share.JobID)
		}
		return
	}
	if result.Unconfirmed {
		opts.log("debug", fmt.Sprintf(
			"engine: V2 share verdict timed out (unconfirmed, job %d)",
			share.JobID))
		rt.latency.Record(elapsed)
		rt.observeLatencyHist(opts, elapsed, share.JobID)
		return
	}
	if !result.Accepted {
		category, diagnosis := rejectClass(result.Reason)
		opts.log("warn", fmt.Sprintf("engine: V2 share rejected: %s (%s)",
			result.Reason, diagnosis))
		if opts.m != nil {
			opts.m.sharesRejected.Inc()
			opts.m.rejectReason(category).Inc()
			opts.m.touchLastReject(category, time.Now().Unix())
		}
		return
	}
	opts.log("info", "engine: V2 share accepted")
	rt.latency.Record(elapsed)
	rt.observeLatencyHist(opts, elapsed, share.JobID)
	if opts.m != nil {
		opts.m.sharesAccepted.Inc()
	}
	if result.NewSubmitsAccepted > 0 || result.NewSharesSummed > 0 {
		// The pool's per-frame batch accounting, surfaced for
		// cross-checking; local accept counting stays per-result
		// (see poolproto.ShareResult docs).
		opts.log("debug", fmt.Sprintf(
			"engine: pool reports +%d submits +%d shares in ack batch",
			result.NewSubmitsAccepted, result.NewSharesSummed))
	}
}

// runSessionV1 handles one Stratum V1 pool connection via poolproto.DialURL.
// It consumes the protocol-agnostic poolproto.Session interface
// (Jobs() / Submit()) through the stratumv1 adapter.
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
	sess, err := dialPool(ctx, &opts, password, "Stratum V1")
	if err != nil {
		return err
	}
	defer sess.Close()

	// V1 is single-channel; channel ID 0 is the conventional value.
	const chanID = uint32(0)

	// estSats, latency and friends live on the shared sessionTelemetry
	// accumulator so both session loops tick identically.
	rt := newSessionTelemetry(opts.log)
	statsTicker := time.NewTicker(opts.interval)
	defer statsTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()

		case <-statsTicker.C:
			rt.tick(time.Now(), &opts, sess.SuggestedDifficulty())
			rt.suggestDifficultyOnce(ctx, sess, opts.log)
			rt.updateChannelHashrate(ctx, sess, opts.log)
		case job, ok := <-sess.Jobs():
			if !ok {
				return fmt.Errorf("engine: pool closed connection")
			}
			dispatchJob(&opts, &job, chanID, sess.SuggestedDifficulty(), "V1")

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
			if opts.m != nil {
				// Counted here, not after Submit returns: "submitted" means
				// the transmission was attempted, matching the V2 path's
				// increment at send time rather than at response time — a
				// slow or failing pool response is a distinct, separately
				// tracked event (sharesAccepted/sharesRejected, or the "V1
				// submit" warning log on a hard failure).
				opts.m.sharesSubmitted.Inc()
			}
			go submitV1Share(ctx, sess, rt, &opts, share)
		}
	}
}

// submitV1Share sends one share to the pool and records the verdict —
// latency sample, accept/reject counters, and reject classification.
// Unlike V2, V1 results arrive inline so no Unconfirmed case exists.
func submitV1Share(ctx context.Context, sess poolproto.Session, rt *sessionTelemetry, opts *sessionOpts, share miner.Share) {
	sendTime := time.Now()
	result, err := sess.Submit(ctx, poolproto.ShareSubmission{
		JobID: fmt.Sprintf("%d", share.JobID),
		Nonce: share.Nonce,
		NTime: share.NTime,
	})
	elapsed := float64(time.Since(sendTime).Milliseconds())
	if err != nil {
		opts.log("warn", fmt.Sprintf("engine: V1 submit: %v", err))
		// Still record the latency on error: a p99 spike caused by
		// a pool disconnect is a signal worth surfacing, not hiding.
		if elapsed > 0 {
			rt.latency.Record(elapsed)
			rt.observeLatencyHist(opts, elapsed, share.JobID)
		}
		return
	}
	if !result.Accepted {
		category, diagnosis := rejectClass(result.Reason)
		opts.log("warn", fmt.Sprintf("engine: V1 share rejected: %s (%s)",
			result.Reason, diagnosis))
		if opts.m != nil {
			opts.m.sharesRejected.Inc()
			opts.m.rejectReason(category).Inc()
			opts.m.touchLastReject(category, time.Now().Unix())
		}
		return
	}
	opts.log("info", "engine: V1 share accepted")
	rt.latency.Record(elapsed)
	rt.observeLatencyHist(opts, elapsed, share.JobID)
	if opts.m != nil {
		opts.m.sharesAccepted.Inc()
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
// (docs/KNOWN_LIMITATIONS.md §3). The job's string JobID is parsed back
// to the uint32 the miner uses; an unparseable ID yields job 0, which
// the pool will reject on submit, surfacing the problem rather than
// silently mining a malformed job.
//
// The share target comes from job.Target when the protocol carries one
// (Stratum V2: the pool-assigned U256 from OpenMiningChannelSuccess /
// SetTarget). Otherwise it is derived from difficulty — the Stratum V1
// session's most recent mining.set_difficulty value (poolproto.Job
// carries no difficulty field: V1 delivers it on a separate notification
// that applies to every job until superseded, not attached to
// mining.notify). See v1JobTarget for how it is applied.
func applyJob(workers []*miner.Worker, job poolproto.Job, chanID uint32, difficulty float64) error {
	target := miner.Hash(job.Target)
	if target == (miner.Hash{}) {
		var err error
		target, err = v1JobTarget(job.NBits, difficulty)
		if err != nil {
			return fmt.Errorf("engine: bad target for job %q: %w", job.JobID, err)
		}
	}
	var jobID uint32
	if _, err := fmt.Sscanf(job.JobID, "%d", &jobID); err != nil {
		return fmt.Errorf("engine: unparseable job ID %q: %w", job.JobID, err)
	}
	w := &miner.Work{
		JobID:     jobID,
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

func isFatal(err error) bool { _, ok := err.(*fatalError); return ok }

type fatalError struct{ msg string }

func (e *fatalError) Error() string { return e.msg }
