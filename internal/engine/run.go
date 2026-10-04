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
	"cmp"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shizukutanaka/Otedama/internal/arbitration"
	"github.com/shizukutanaka/Otedama/internal/clock"
	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/shizukutanaka/Otedama/internal/hal"
	"github.com/shizukutanaka/Otedama/internal/metrics"
	"github.com/shizukutanaka/Otedama/internal/miner"
	"github.com/shizukutanaka/Otedama/internal/poolproto"
	"github.com/shizukutanaka/Otedama/internal/provider"
	"github.com/shizukutanaka/Otedama/internal/rates"
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

// jobStallWarnAfter is how long the engine tolerates a connected pool not
// delivering any job before warning once per episode — a silent pool starves
// revenue the same way extreme difficulty does, but without rejects. It is a
// var (not const) so tests can shrink it to milliseconds.
var jobStallWarnAfter = 10 * time.Minute

// poolDialTimeout bounds a single pool dial attempt — TCP connect for
// plaintext, connect + TLS handshake for TLS schemes. A blackholed
// endpoint without it stalls each failover hop for the OS connect
// timeout (~127s on Linux). Var so tests can shrink it.
var poolDialTimeout = 15 * time.Second

// jobsCap bounds the outstanding SV2 job map: a hostile or buggy pool that
// floods distinct job IDs without rotating the tip would otherwise grow
// memory without limit. 64 is far above legitimate churn (pools rarely hold
// more than a handful of pending jobs). storeBoundedJob keeps insertion
// order so eviction is FIFO — the newest jobs, most likely to be named by the
// next SetNewPrevHash, survive.
const jobsCap = 64

// storeBoundedJob inserts j into jobs bounded at jobsCap, evicting the
// oldest-inserted job IDs first; order tracks insertion order and the
// returned slice is the updated order.
func storeBoundedJob(jobs map[uint32]*stratum.NewMiningJob, order []uint32, j *stratum.NewMiningJob) []uint32 {
	if _, ok := jobs[j.JobID]; !ok {
		order = append(order, j.JobID)
	}
	jobs[j.JobID] = j
	for len(order) > jobsCap {
		delete(jobs, order[0])
		order = order[1:]
	}
	return order
}

// Options configures a Run session.
type Options struct {
	Config config.Config
	Clock  clock.Clock
	Output io.Writer // where TUI writes; defaults to os.Stdout

	// Input reads interactive confirmations; defaults to os.Stdin.
	// Today it is consulted only by the first-run wallet backup
	// verification, and only when it is a terminal — headless starts
	// (systemd, docker, piped stdin) never see a prompt.
	Input  io.Reader
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
func curtailDecision(curr bool, rate float64, fresh bool, threshold float64) (next, changed bool) {
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

// applyDefaults fills the optional dependencies of Options when unset:
// the wall clock, stdout/stdin, and a no-op logger.
func (o *Options) applyDefaults() {
	if o.Clock == nil {
		o.Clock = clock.System{}
	}
	if o.Output == nil {
		o.Output = os.Stdout
	}
	o.Input = cmp.Or[io.Reader](o.Input, os.Stdin)
	if o.Logger == nil {
		o.Logger = func(_, _ string) {}
	}
}

// Run starts a full mining session and blocks until ctx is cancelled.
// It orchestrates every subsystem: wallet, HAL, providers, arbitration,
// TUI, and the Stratum V2 pool connection.
func Run(ctx context.Context, opts Options) error {
	opts.applyDefaults()
	log := opts.Logger
	startTime := opts.Clock.Now()
	m := startRunMetrics(ctx, &opts, startTime)

	// ----- Phase 1: Lightning wallet -----
	walletFingerprint := setupWallet(&opts, log)

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

	// Nominal hashrate for the SV2 OpenMiningChannel handshake: live worker
	// stats are ~0 at handshake time because no job has been hashed yet, so
	// the declared value comes from device capability families instead.
	nominalHR := nominalMiningHashrate(devices, workers)
	defer func() {
		for _, w := range workers {
			w.Stop()
		}
	}()

	// ----- Phase 4: Price + network-stat feeds -----
	rateFetcher, hashFetcher := startFeeds(ctx, log)

	// curtailGate is the single source of truth for whether hashing is
	// paused by the curtail_below_btc_usd threshold. The price goroutine
	// monitorCurtailment flips it, and the session loop consults it before
	// applying any pool job — without this shared gate the next
	// mining.notify (~30–60 s) would silently re-arm the idled workers
	// while otedama_curtailed still read 1, so the pause neither held nor
	// matched the metric.
	curtailGate := new(atomic.Bool)

	// arbPaused is the per-device counterpart of curtailGate: the set of
	// device IDs arbitration has paused (idle below the yield floor, or
	// routed to a non-mining stream). applyAllocation pauses a worker once,
	// but without a shared set the next pool job's updateWork/applyJob
	// would silently re-arm it and mine until the next Decide tick — the
	// same re-arm hole the curtail gate documents above.
	arbPaused := &pauseSet{}

	go monitorCurtailment(ctx, &opts, log, m, rateFetcher, workers, curtailGate)

	// ----- Phase 5: Providers -----
	miningProvider, akashProvider := startProviders(ctx, &opts.Config, rateFetcher, hashFetcher, devices, workers, log)
	defer miningProvider.Stop()
	defer akashProvider.Stop()

	// ----- Phase 6: Arbitration engine -----
	// Shared provider-activity snapshot: which providers arbitration is
	// actually routing devices to right now, and at what yield. Written by
	// runArbitrationLoop, read by buildStats via sessionOpts so the TUI's
	// provider lines reflect real allocation instead of a hardcoded
	// Active: true.
	activityMu := sync.Mutex{}
	activity := make(map[string]float64)
	launchArbitration(ctx, &opts, workers, devices, miningProvider, akashProvider,
		rateFetcher, m, log, arbPaused, &activityMu, activity)

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
		opts:            opts,
		workers:         workers,
		merged:          merged,
		dashboard:       dashboard,
		startTime:       startTime,
		wallet:          walletFingerprint,
		deviceN:         len(devices),
		providers:       []provider.Provider{miningProvider, akashProvider},
		metrics:         m,
		log:             log,
		curtailGate:     curtailGate,
		arbPaused:       arbPaused,
		nominalHashrate: nominalHR,
		activityMu:      &activityMu,
		activity:        activity,
	})
}

// startRunMetrics registers the engine metric series and launches the
// per-second uptime publisher. A nil registry falls back to a throwaway
// one so call sites need no nil checks.
func startRunMetrics(ctx context.Context, opts *Options, startTime time.Time) *engineMetrics {
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
	go runUptimeTicker(ctx, m, startTime)
	return m
}

// runUptimeTicker updates otedama_uptime_seconds every second so scrapers
// always see a fresh value, not just the stale value from the last stats
// tick.
func runUptimeTicker(ctx context.Context, m *engineMetrics, startTime time.Time) {
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
}

// startFeeds launches the BTC/USD price feed and the network-hashrate
// feed (KNOWN_LIMITATIONS §7): the hashrate feed supplies the mining
// provider's yield estimate with the live network size instead of the
// compile-time ~1000 EH/s constant. It polls every 10 min — difficulty
// retargets are ~fortnightly, so freshness needs are modest.
func startFeeds(ctx context.Context, log func(level, msg string)) (*rates.Fetcher, *rates.HashrateFetcher) {
	rateFetcher := rates.NewFetcher(95000) // $95k fallback
	rateFetcher.StartBackground(ctx, 5*time.Minute)
	hashFetcher := rates.NewHashrateFetcher()
	hashFetcher.SetLogger(func(msg string) { log("debug", msg) })
	hashFetcher.StartBackground(ctx, 10*time.Minute)
	return rateFetcher, hashFetcher
}

// monitorCurtailment publishes the BTC/USD rate to its gauge and enforces
// the optional curtailment threshold (curtail_below_btc_usd). When the
// price falls below the threshold all workers are idled (SetWork(nil)) and
// the gate is raised so incoming jobs are not applied; they resume on the
// next pool notify after the price recovers and the gate is lowered.
func monitorCurtailment(ctx context.Context, opts *Options, log func(level, msg string),
	m *engineMetrics, rateFetcher *rates.Fetcher, workers []*miner.Worker, gate *atomic.Bool,
) {
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
			next, changed := curtailDecision(gate.Load(), rate, fresh, threshold)
			if !changed {
				continue
			}
			gate.Store(next)
			if next {
				for _, w := range workers {
					w.SetWork(nil)
				}
				log("info", fmt.Sprintf(
					"engine: curtailed — BTC/USD $%.0f below threshold $%.0f; hashing paused",
					rate, threshold,
				))
				if m != nil {
					m.curtailed.Set(1)
				}
			} else {
				log("info", fmt.Sprintf(
					"engine: uncurtailed — BTC/USD $%.0f above threshold $%.0f; hashing resumes on next job",
					rate, threshold,
				))
				if m != nil {
					m.curtailed.Set(0)
				}
			}
		}
	}
}

// launchArbitration wires the merged quote stream into the Decide loop
// for this run: provider quote fan-in, device refs, the live streams map,
// and the shared provider-activity snapshot the TUI reads.
func launchArbitration(ctx context.Context, opts *Options,
	workers []*miner.Worker, devices []hal.Device,
	miningProvider, akashProvider provider.Provider,
	rateFetcher *rates.Fetcher, m *engineMetrics, log func(level, msg string),
	arbPaused *pauseSet, activityMu *sync.Mutex, activity map[string]float64,
) {
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
		powerWatts:    opts.Config.PowerWatts,
		// powerPricePerKWh completes the power-breakeven floor; both must be
		// set for the derived constraint to engage (see arbitrationLoopOpts).
		powerPricePerKWh: opts.Config.ElectricityPricePerKWh,
		rateSource:       rateFetcher,
		activityMu:       activityMu,
		activity:         activity,
		paused:           arbPaused,
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
	// nominalHashrate is the capability-derived hashrate estimate declared
	// in OpenMiningChannel when live worker stats are still zero.
	nominalHashrate float64
	// arbPaused, when non-nil, is the per-device pause set written by the
	// arbitration loop; job dispatch must not arm a paused worker.
	arbPaused *pauseSet
	// activityMu/activity: see sessionOpts. Threaded through unchanged
	// across reconnects since the arbitration loop (the writer) runs for
	// the lifetime of Run(), independent of any one pool session.
	activityMu *sync.Mutex
	activity   map[string]float64
}

// reconnectState tracks the failover cursors and the backoff for one
// runReconnectLoop invocation: which pool and which payout address are
// active, whether the active address has ever established a session, and
// the current retry delay.
type reconnectState struct {
	poolIdx int
	addrIdx int
	// addrConnected records whether the active address has ever
	// established a session; address failover is only attempted while it
	// has not.
	addrConnected bool
	attempt       int
	backoff       time.Duration
}

// attemptLabel renders the "attempt N[, pool i/m][, address j/k]"
// annotation for the connect log line.
func (s *reconnectState) attemptLabel(numPools, numAddrs int) string {
	loc := fmt.Sprintf("attempt %d", s.attempt)
	if numPools > 1 {
		loc += fmt.Sprintf(", pool %d/%d", s.poolIdx+1, numPools)
	}
	if numAddrs > 1 {
		loc += fmt.Sprintf(", address %d/%d", s.addrIdx+1, numAddrs)
	}
	return loc
}

// markConnecting publishes the "connecting" gauges for this attempt.
func (s *reconnectState) markConnecting(r *reconnectOpts, addrs []string) {
	r.metrics.poolConnectAttempts.Inc()
	r.metrics.poolActiveIndex.Set(float64(s.poolIdx))
	r.metrics.payoutActiveIndex.Set(float64(s.addrIdx))
	if s.addrIdx < len(addrs) {
		r.metrics.setActivePayout(maskAddr(addrs[s.addrIdx]))
	}
	r.metrics.poolConnectionState.Set(1) // connecting
}

// sessionOptsFor assembles the sessionOpts for one connection attempt:
// the active pool's per-pool overrides (user, CA bundle, password) and
// the run's shared plumbing.
func (r *reconnectOpts) sessionOptsFor(s *reconnectState, pools, addrs []string,
	statsInterval time.Duration, onConnected func(),
) sessionOpts {
	var poolUser, poolTLSCAFile, poolPassword string
	if s.poolIdx < len(r.opts.Config.Pools) {
		poolUser = r.opts.Config.Pools[s.poolIdx].User
		poolTLSCAFile = r.opts.Config.Pools[s.poolIdx].TLSCAFile
		poolPassword = r.opts.Config.Pools[s.poolIdx].Password
	}
	return sessionOpts{
		poolURL:         pools[s.poolIdx],
		user:            sessionUser(poolUser, addrs[s.addrIdx], r.opts.Config.Workers.Name),
		workers:         r.workers,
		merged:          r.merged,
		interval:        statsInterval,
		dashboard:       r.dashboard,
		startTime:       r.startTime,
		wallet:          r.wallet,
		devices:         r.deviceN,
		log:             r.log,
		providers:       r.providers,
		m:               r.metrics,
		powerWatts:      r.opts.Config.PowerWatts,
		curtailGate:     r.curtailGate,
		arbPaused:       r.arbPaused,
		nominalHashrate: r.nominalHashrate,
		tlsCAFile:       poolTLSCAFile,
		poolPassword:    poolPassword,
		activityMu:      r.activityMu,
		activity:        r.activity,
		onConnected:     onConnected,
	}
}

// finishAttempt records the end of a session attempt: the failure
// counter, the disconnected gauge, the readiness flip, and a dashboard
// refresh so the TUI does not freeze on the last connected frame for the
// entire backoff/reconnect window (the session's own stats tick stops the
// instant it returns).
func (r *reconnectOpts) finishAttempt(sessionErr error, poolURL string) {
	if sessionErr != nil {
		r.metrics.poolConnectFailures.Inc()
	}
	r.metrics.poolConnectionState.Set(0) // session ended → disconnected
	if r.opts.OnReady != nil {
		r.opts.OnReady(false) // session ended → not ready
	}
	if r.dashboard != nil {
		r.dashboard.Update(disconnectedStats(poolURL, r.wallet, r.startTime, r.deviceN))
	}
}

// advanceEndpoint applies the failover policy after a failed session and
// reports whether to retry immediately without a backoff sleep.
func (s *reconnectState) advanceEndpoint(r *reconnectOpts, pools, addrs []string, sessionErr error) bool {
	// Pool failover (fast): advance to the next pool in priority order
	// before touching the payout address or backing off. A single-pool
	// config skips this and falls through to address failover / backoff.
	if len(pools) > 1 {
		s.poolIdx = (s.poolIdx + 1) % len(pools)
		if s.poolIdx != 0 {
			r.log("warn", fmt.Sprintf("engine: session ended: %v; failing over to next pool", sessionErr))
			return true // next pool immediately, no backoff
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
	case !s.addrConnected && len(addrs) > 1:
		prev := s.addrIdx
		s.addrIdx = (s.addrIdx + 1) % len(addrs)
		s.poolIdx = 0
		if s.addrIdx != 0 {
			r.log("warn", fmt.Sprintf(
				"engine: payout address %s (%d/%d) could not establish a session on any pool; "+
					"failing over to %s (%d/%d)",
				maskAddr(addrs[prev]), prev+1, len(addrs),
				maskAddr(addrs[s.addrIdx]), s.addrIdx+1, len(addrs),
			))
			return true // try next address immediately, no backoff
		}
		// Wrapped through every address; none connected. Back off and
		// retry from the primary so a recovered network resumes there.
		s.addrConnected = false
		r.log("warn", fmt.Sprintf(
			"engine: none of the %d configured payout addresses could connect; "+
				"backing off %v and retrying from the primary", len(addrs), s.backoff,
		))
	case len(pools) > 1:
		r.log("warn", fmt.Sprintf("engine: all %d pools failed; backing off %v", len(pools), s.backoff))
	default:
		r.log("warn", fmt.Sprintf("engine: session ended: %v; reconnecting in %v", sessionErr, s.backoff))
	}
	return false
}

// sleep waits out the current backoff (or returns early when ctx is
// cancelled) and then doubles it up to reconnectBackoffMax.
func (s *reconnectState) sleep(ctx context.Context) error {
	// time.NewTimer + explicit Stop rather than time.After: when ctx is
	// cancelled (shutdown) the timer is released immediately instead of
	// lingering until backoff (up to reconnectBackoffMax) elapses — the
	// documented time.After-in-select pitfall, since pre-Go-1.23 a pending
	// timer cannot be garbage-collected until it fires.
	timer := time.NewTimer(s.backoff)
	select {
	case <-timer.C:
	case <-ctx.Done():
		timer.Stop()
		return ctx.Err()
	}
	if s.backoff < reconnectBackoffMax {
		s.backoff *= 2
	}
	return nil
}

// runReconnectLoop dials the pool, runs a session, and reconnects with
// exponential backoff (capped at reconnectBackoffMax) until ctx is cancelled, a fatal
// error occurs, or MaxReconnectAttempts is exceeded.
func runReconnectLoop(ctx context.Context, r reconnectOpts) error {
	pools := poolURLs(&r.opts.Config)
	addrs := payoutAddresses(&r.opts.Config)
	st := reconnectState{backoff: reconnectBackoffInitial}

	statsInterval := r.opts.StatsInterval
	if statsInterval <= 0 {
		statsInterval = 10 * time.Second
	}

	for {
		if ctx.Err() != nil {
			break
		}
		st.attempt++
		if r.opts.MaxReconnectAttempts > 0 && st.attempt > r.opts.MaxReconnectAttempts {
			return fmt.Errorf("engine: exceeded %d reconnect attempts", r.opts.MaxReconnectAttempts)
		}
		poolURL := pools[st.poolIdx]
		r.log("info", fmt.Sprintf("engine: connecting to %s (%s)",
			poolproto.StripUserinfo(poolURL), st.attemptLabel(len(pools), len(addrs))))
		st.markConnecting(&r, addrs)

		connectedThisAttempt := false
		sessionErr := runSession(ctx, r.sessionOptsFor(&st, pools, addrs, statsInterval, func() {
			st.addrConnected = true
			connectedThisAttempt = true
			if r.opts.OnReady != nil {
				r.opts.OnReady(true) // pool session established → ready
			}
		}))
		r.finishAttempt(sessionErr, poolURL)

		if ctx.Err() != nil {
			break
		}
		if isFatal(sessionErr) {
			return sessionErr
		}

		// A session that actually established resets the backoff: the delay
		// exists to stop hammering a dead endpoint, not to defer reconnects
		// after a healthy (possibly hours-long) session dropped. Done before
		// the failover branches so both the immediate-retry continue and the
		// log lines below see the post-reset value.
		if connectedThisAttempt {
			st.backoff = reconnectBackoffInitial
		}
		if st.advanceEndpoint(&r, pools, addrs, sessionErr) {
			continue
		}
		if err := st.sleep(ctx); err != nil {
			return err
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
	// arbPaused, when non-nil, is the per-device pause set written by the
	// arbitration loop's reconcileArbPauses; updateWork/applyJob skip a
	// paused worker so its arbitration-assigned state survives new jobs.
	arbPaused *pauseSet
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
	// nominalHashrate is the capability-derived hashrate estimate used in
	// OpenMiningChannel when live worker stats are still zero.
	nominalHashrate float64
}

// isCurtailed reports whether hashing is currently paused by the
// curtail_below_btc_usd threshold. Safe to call with a nil gate.
func (o *sessionOpts) isCurtailed() bool {
	return o.curtailGate != nil && o.curtailGate.Load()
}

// allArbPaused reports whether every worker is currently paused by
// arbitration (idle below the yield floor or routed to a non-mining
// stream). A nil set, or no workers, reports false.
func (o sessionOpts) allArbPaused() bool {
	if o.arbPaused == nil || len(o.workers) == 0 {
		return false
	}
	for _, w := range o.workers {
		if !o.arbPaused.Paused(w.DeviceID()) {
			return false
		}
	}
	return true
}

// updateLiveness feeds the stall monitor and sets the otedama_up gauge,
// honouring curtailment and arbitration idling. While curtailed — or while
// every worker is arbitration-paused — the miner is intentionally idle, so a
// zero hashrate is *expected*, not a fault: the stall monitor is not advanced
// (no false "hashrate stalled — check device health" warning) and otedama_up
// stays 1 (healthy, deliberately paused). otedama_curtailed / the idle-device
// log line carry the paused signal separately, so operators can alert on
// otedama_up==0 for real stalls without being paged during a price-driven or
// yield-floor pause. Returns whether the miner is in a fault stall (for the
// dashboard badge); always false while intentionally idle.
func (o *sessionOpts) updateLiveness(hashMon *HashrateMonitor, currentHashRate float64) bool {
	if o.isCurtailed() || o.allArbPaused() {
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

// sessionTick bundles the per-session counters sampled on every stats
// tick by both the V2 (runSessionV2) and V1 (runSessionV1) loops:
// hash-rate sampling, stall/liveness bookkeeping, earnings accounting,
// dashboard and metric updates, and the starvation tripwires.
type sessionTick struct {
	opts       *sessionOpts
	hashWindow hashrateWindow // differentiates the cumulative hash counter into a current rate
	hashMon    *HashrateMonitor
	satsAcc    satsAccountant
	uptime     uptimeAccountant
	latency    *LatencyTracker
	// Track dropped shares so a consumer that cannot keep up surfaces as a
	// warning rather than silently losing found shares.
	lastDropped uint64
	// estSats is the running estimated earnings shown in the TUI, produced by
	// integrating the arbitration expected-yield rate over productive time
	// (satsAcc). It is not a per-share tally — a share carries no sat value on
	// the wire (KNOWN_LIMITATIONS.md §9).
	estSats uint64
	// lastJobAt is the tripwire for a silent pool: jobs stop arriving while
	// the connection stays open. The clock starts at session start — a
	// pool that never sends a first job is equally starved.
	lastJobAt        time.Time
	jobStarvedWarned bool
	// starvedWarned is the tripwire for pool-assigned difficulty starving
	// share production.
	starvedWarned bool
}

func newSessionTick(opts *sessionOpts) *sessionTick {
	return &sessionTick{
		opts:      opts,
		hashMon:   NewHashrateMonitor(0, 3, opts.log),
		latency:   NewLatencyTracker(256),
		lastJobAt: time.Now(),
	}
}

// observe runs one stats tick. difficulty is the pool's current share
// difficulty (Stratum V1: SuggestedDifficulty; V2: derived from the U256
// share target).
func (t *sessionTick) observe(now time.Time, difficulty float64) {
	opts := t.opts
	currentHashRate := t.hashWindow.observe(totalHashes(opts.workers), now)
	logStats(opts.workers, currentHashRate, opts.log)
	if dropped := totalDropped(opts.workers); dropped > t.lastDropped {
		opts.log("warn", fmt.Sprintf(
			"engine: dropped %d found share(s) — share submission is not keeping up with discovery",
			dropped-t.lastDropped,
		))
		t.lastDropped = dropped
	}
	stalled := opts.updateLiveness(t.hashMon, currentHashRate)
	// Accumulate estimated earnings before building the dashboard
	// snapshot so the displayed figure reflects this tick. The rate is
	// the arbitration expected yield (0 when metrics are disabled or no
	// quote has arrived yet); the productive flag gates out idle/stalled
	// time so downtime never accrues phantom earnings.
	var expectedYieldRate float64
	if opts.m != nil {
		expectedYieldRate = opts.m.arbitrationExpectedYieldSatsPerSec.Value()
	}
	t.estSats = uint64(t.satsAcc.observe(now, expectedYieldRate, currentHashRate > 0 && !stalled))
	if opts.dashboard != nil {
		opts.dashboard.Update(buildStats(opts, currentHashRate, t.estSats, t.latency, stalled))
	}
	if opts.m != nil {
		t.observeMetrics(now, currentHashRate, difficulty, stalled)
	}
	if p95 := t.latency.Quantile(0.95); p95 > 0 {
		opts.log("info", fmt.Sprintf(
			"engine: submit latency p50=%.0fms p95=%.0fms p99=%.0fms",
			t.latency.Quantile(0.50), p95, t.latency.Quantile(0.99),
		))
		if opts.m != nil {
			opts.m.submitLatencyP50.Set(t.latency.Quantile(0.50))
			opts.m.submitLatencyP95.Set(p95)
			opts.m.submitLatencyP99.Set(t.latency.Quantile(0.99))
		}
	}
}

// observeMetrics updates the metric series sampled on each tick
// (hashrate, productive time, effective yield, power efficiency, the
// share-rate gauges, and pool difficulty) and drives the two starvation
// tripwires.
func (t *sessionTick) observeMetrics(now time.Time, currentHashRate, difficulty float64, stalled bool) {
	opts := t.opts
	opts.m.hashrate.Set(currentHashRate)
	t.uptime.observe(now, currentHashRate > 0 && !stalled, opts.m.productiveSeconds)
	opts.m.effectiveYieldSatsPerSec.Set(effectiveYield(
		opts.m.arbitrationExpectedYieldSatsPerSec.Value(),
		float64(opts.m.productiveSeconds.Value()),
		opts.m.uptime.Value(),
	))
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
			rate*100, opts.m.sharesAccepted.Value(), judged,
		))
	}
	// Publish pool difficulty and estimated share interval so
	// operators can distinguish "hardware is slow" from "the pool
	// assigned more difficulty than our hashrate can serve".
	// V2's share target arrives as a raw U256 from
	// OpenMiningChannelSuccess/SetTarget — convert it to the
	// same Stratum difficulty the V1 path publishes.
	publishDifficulty(opts.m, difficulty, currentHashRate)
	// A pool that stops sending jobs starves the same way but
	// silently: warn once per episode until jobs resume.
	if quiet := time.Since(t.lastJobAt); !opts.isCurtailed() && quiet > jobStallWarnAfter {
		if !t.jobStarvedWarned {
			t.jobStarvedWarned = true
			opts.log("warn", fmt.Sprintf(
				"engine: no new job from pool in %v — hashing continues on stale work; the pool may be starving this connection",
				quiet.Truncate(time.Second)))
		}
	} else {
		t.jobStarvedWarned = false
	}
	// Difficulty starvation: a pool-assigned difficulty so high that the
	// expected share interval exceeds an hour starves income silently —
	// no rejects, no disconnect, just nothing credited. Warn once per
	// episode and re-arm when the interval recovers.
	if iv := opts.m.estimatedShareIntervalSeconds.Value(); iv > 3600 {
		if !t.starvedWarned {
			t.starvedWarned = true
			opts.log("warn", fmt.Sprintf(
				"engine: pool difficulty implies ~%.0f min between shares — income is effectively zero; the pool should lower difficulty or retarget",
				iv/60))
		}
	} else {
		t.starvedWarned = false
	}
}

// runSession runs one pool connection: dial, handshake, then stream
// jobs to workers and shares back to the pool until the connection
// drops or ctx is cancelled. Returns the error that ended the session
// (nil if ctx was cancelled cleanly).
//
// Stratum V1 URLs (stratum+tcp://, stratum+tls://) are handled via
// poolproto.DialURL so the protocol abstraction is load-bearing for V1.
// The Stratum V2 path keeps the existing inline framing: the
// poolproto/stratumv2 dialer exists (KNOWN_LIMITATIONS §3, resolved), but
// bridging it into the engine's session loop is a separate piece of work
// still pending.
func runSession(ctx context.Context, opts sessionOpts) error {
	proto := poolproto.FromURL(opts.poolURL)
	opts.log("info", fmt.Sprintf("engine: transport protocol: %s", proto))
	if proto == poolproto.ProtocolStratumV1 || proto == poolproto.ProtocolStratumV1TLS {
		return runSessionV1(ctx, opts)
	}
	// Schemes poolproto recognises but Otedama does not implement —
	// currently datum:// (ADR-009, OCEAN's SV1-transport variant) — must
	// fail fast here rather than fall through to the plaintext SV2 dial
	// and speak binary V2 frames to a pool expecting a different
	// protocol, which only surfaces as a confusing connect/handshake
	// timeout.
	if proto != poolproto.ProtocolStratumV2 && proto != poolproto.ProtocolStratumV2TLS {
		return fmt.Errorf("engine: pool URL %q has unsupported protocol %q "+
			"(supported schemes: stratum+tcp://, stratum+tls://, stratum+v2://, stratum+v2tls://; "+
			"datum:// is recognised but not implemented — ADR-009)",
			opts.poolURL, proto)
	}
	return runSessionV2(ctx, &opts, proto)
}

// dialV2 establishes the transport for a Stratum V2 session: a real,
// certificate-verified TLS connection for stratum+v2tls:// (never a
// silent plaintext downgrade — KNOWN_LIMITATIONS §2), or a bounded
// plaintext TCP dial for stratum+v2://.
func dialV2(ctx context.Context, proto poolproto.ProtocolID, opts *sessionOpts) (net.Conn, error) {
	host, err := parseHost(opts.poolURL)
	if err != nil {
		return nil, fmt.Errorf("engine: bad pool URL %q: %w", poolproto.StripUserinfo(opts.poolURL), err)
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
				return nil, fmt.Errorf("engine: %w", cerr)
			} else {
				tlsCfg = cfg
			}
		}
		// Bound the TCP connect + TLS handshake so a blackholed endpoint
		// cannot hold the failover hop hostage (same 15s bound the
		// poolproto dialers and the V2 handshake deadline use).
		dialCtx, dialCancel := context.WithTimeout(ctx, poolDialTimeout)
		conn, err = stratum.DialTLS(dialCtx, host, tlsCfg)
		dialCancel()
		if err != nil {
			return nil, fmt.Errorf("engine: TLS dial %s: %w", host, err)
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
		d.Timeout = poolDialTimeout
		conn, err = d.DialContext(ctx, "tcp", host)
		if err != nil {
			return nil, fmt.Errorf("engine: dial %s: %w", host, err)
		}
	}
	opts.log("info", fmt.Sprintf("engine: connected to %s", host))
	return conn, nil
}

// readV2Frames pumps decoded SV2 frames onto the returned channel until
// the connection fails or ctx is cancelled, then closes it.
func readV2Frames(ctx context.Context, dec *stratum.Decoder) <-chan poolMsg {
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
	return inCh
}

// submitTimesCap bounds the pending-submit bookkeeping (submitTimes and
// submitTargets) so a pool that never acknowledges cannot grow the maps
// without bound over a long session.
const submitTimesCap = 1024

// v2Session holds the mutable per-connection state of a Stratum V2 pool
// session: the opened channel, the job/chain-tip table, share-submit
// bookkeeping, and the shared stats-tick counters.
type v2Session struct {
	opts        *sessionOpts
	conn        net.Conn
	chanID      uint32
	shareTarget miner.Hash
	seqNum      uint32

	// SV2 job / chain-tip state. A block header cannot be hashed until
	// BOTH a job (merkle root + version, via NewMiningJob) and the chain
	// tip (prev_hash + network nBits + ntime, via SetNewPrevHash) are
	// known. Jobs without ntime_start are *future jobs*: they activate only
	// when a SetNewPrevHash names their job_id. SetNewPrevHash also
	// invalidates every other outstanding job (they extend a stale tip).
	jobs        map[uint32]*stratum.NewMiningJob
	jobOrder    []uint32              // insertion order for jobsCap FIFO eviction
	active      *stratum.NewMiningJob // job the workers are currently hashing
	prevHash    [32]byte
	prevNBits   uint32
	activeNTime uint32
	havePrev    bool

	// Track share-submission round-trip latency. submitTimes maps a
	// sequence number to the time the share was sent; entries are
	// settled (and deleted) on SubmitSharesSuccess, and additionally
	// capped at submitTimesCap so a pool that never acknowledges
	// cannot grow the map without bound over a long session.
	submitTimes map[uint32]time.Time
	// submitTargets maps a submitted share's SequenceNumber to the share
	// target it was produced under (miner.Share.Target). Read on
	// SubmitSharesError to detect retarget rejects (transitionReject),
	// and reaped alongside submitTimes so the map stays bounded.
	submitTargets map[uint32]miner.Hash
	submits       *submitLimiter
	tick          *sessionTick
}

// runSessionV2 runs one Stratum V2 pool session: dial, handshake, then
// stream jobs to workers and shares back to the pool until the
// connection drops or ctx is cancelled.
func runSessionV2(ctx context.Context, opts *sessionOpts, proto poolproto.ProtocolID) error {
	conn, err := dialV2(ctx, proto, opts)
	if err != nil {
		return err
	}
	defer conn.Close()

	dec := stratum.NewDecoder(conn)
	chanID, shareTarget, err := handshake(conn, dec, opts.poolURL, opts.user, opts.workers, opts.nominalHashrate)
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

	statsTicker := time.NewTicker(opts.interval)
	defer statsTicker.Stop()

	limiterCtx, stopLimiter := context.WithCancel(ctx)
	defer stopLimiter()

	s := &v2Session{
		opts:          opts,
		conn:          conn,
		chanID:        chanID,
		shareTarget:   shareTarget,
		jobs:          make(map[uint32]*stratum.NewMiningJob),
		submitTimes:   make(map[uint32]time.Time),
		submitTargets: make(map[uint32]miner.Hash),
		submits:       newSubmitLimiter(limiterCtx),
		tick:          newSessionTick(opts),
	}
	inCh := readV2Frames(ctx, dec)

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()

		case <-statsTicker.C:
			s.onTick()

		case pm, ok := <-inCh:
			if err := s.onFrame(pm, ok); err != nil {
				return err
			}

		case share, ok := <-opts.merged:
			if err := s.onShare(ctx, share, ok); err != nil {
				return err
			}
		}
	}
}

// onTick samples the per-session counters on each stats tick and keeps
// the in-flight-submits gauge current.
func (s *v2Session) onTick() {
	s.tick.observe(time.Now(), miner.DifficultyFromTarget(s.shareTarget))
	if s.opts.m != nil {
		s.opts.m.sharesSubmitInFlight.Set(float64(len(s.submitTimes)))
	}
}

// startJob points the workers at job j against the current chain tip
// and share target. Callers must ensure havePrev is true. While
// curtailed (BTC/USD below threshold) the job/tip state is still
// tracked but the workers stay idle — hashing resumes on the next
// activation event after the price recovers, matching the documented
// "resumes on next job" semantics.
func (s *v2Session) startJob(j *stratum.NewMiningJob, ntime uint32) {
	s.active = j
	s.activeNTime = ntime
	if s.opts.isCurtailed() {
		s.opts.log("debug", fmt.Sprintf("engine: job %d ignored (curtailed)", j.JobID))
		return
	}
	updateWork(s.opts.workers, s.opts.arbPaused, j, s.chanID, s.prevHash, s.prevNBits, ntime, s.shareTarget)
	s.opts.log("info", fmt.Sprintf("engine: job %d version=0x%08X active", j.JobID, j.Version))
}

// onNewJob applies one NewMiningJob frame to the job table and, when the
// job is immediately valid, arms the workers.
func (s *v2Session) onNewJob(j *stratum.NewMiningJob) {
	s.tick.lastJobAt = time.Now()
	prevLen := len(s.jobs)
	s.jobOrder = storeBoundedJob(s.jobs, s.jobOrder, j)
	if len(s.jobs) < prevLen {
		s.opts.log("debug", fmt.Sprintf("engine: evicted oldest pending job (cap %d)", jobsCap))
	}
	switch {
	case j.HasNtimeStart && s.havePrev:
		// Job for the current chain tip: mine it now. Its own
		// ntime_start supersedes the tip's (it is never older).
		s.startJob(j, j.NtimeStart)
	case !j.HasNtimeStart:
		// Future job: valid only for a chain tip we have not
		// seen yet. Hold until SetNewPrevHash names it.
		s.opts.log("info", fmt.Sprintf("engine: job %d stored (future job, awaiting prev-hash)", j.JobID))
	default:
		// Job claims to be currently valid but we have never
		// received a SetNewPrevHash, so the header's prev_hash
		// is unknown. Hashing now would produce garbage.
		s.opts.log("info", fmt.Sprintf("engine: job %d held (no prev-hash yet)", j.JobID))
	}
	// The pool connection is alive regardless of whether the job
	// was armed (curtailment, future job): lastJobReceivedAt
	// tracks pool liveness, not hashing.
	if s.opts.m != nil {
		s.opts.m.lastJobReceivedAt.Set(float64(time.Now().Unix()))
	}
}

// onPrevHash applies a SetNewPrevHash frame: the new tip invalidates
// every outstanding job except the one it names, which is activated (or,
// when the named job was never received, hashing is paused until the
// next job).
func (s *v2Session) onPrevHash(p *stratum.SetNewPrevHash) {
	s.prevHash = p.PrevHash
	s.prevNBits = p.NBits
	s.havePrev = true
	// The new tip invalidates every job except the one it names.
	named := s.jobs[p.JobID]
	s.jobs = map[uint32]*stratum.NewMiningJob{}
	s.jobOrder = s.jobOrder[:0]
	if named == nil {
		// Tip references a job we never received — stop hashing
		// the stale job rather than mining a wrong header.
		s.active = nil
		for _, w := range s.opts.workers {
			w.SetWork(nil)
		}
		s.opts.log("warn", fmt.Sprintf("engine: SetNewPrevHash names unknown job %d; pausing until next job", p.JobID))
		return
	}
	s.jobs[p.JobID] = named
	s.jobOrder = append(s.jobOrder, p.JobID)
	ntime := p.NtimeStart
	if named.HasNtimeStart && named.NtimeStart > ntime {
		ntime = named.NtimeStart
	}
	s.startJob(named, ntime)
	s.opts.log("info", fmt.Sprintf("engine: new prev-hash, job %d nBits=0x%08X",
		p.JobID, p.NBits))
}

// onSetTarget applies a SetTarget frame: the share target workers must
// grind to. The current job is re-issued so workers compare against the
// new target immediately.
func (s *v2Session) onSetTarget(t *stratum.SetTarget) {
	s.shareTarget = miner.Hash(t.Target)
	if s.active != nil && s.havePrev {
		s.startJob(s.active, s.activeNTime)
	}
	s.opts.log("info", "engine: share target updated by pool")
}

// onShareAccept settles submit bookkeeping for a SubmitSharesSuccess
// frame and credits locally-observed accepts.
func (s *v2Session) onShareAccept(a *stratum.SubmitSharesSuccess) {
	last := a.LastSequenceNumber
	if last > s.seqNum {
		// The pool acknowledged a share we never sent — a
		// bogus or misrouted frame. Crediting it would inflate
		// sharesAccepted and drain submitTimes for shares that
		// were never acknowledged, skewing acceptance rate and
		// latency the same way a forged reject skews them
		// downward. Drop it like the SubmitSharesError check.
		s.opts.log("debug", fmt.Sprintf(
			"engine: share accept with future seq %d ignored (sent %d)",
			last, s.seqNum))
		return
	}
	// Settle round-trip latency for every submitted share
	// up to LastSequenceNumber, then drop those entries.
	// The pool may batch-acknowledge: NewSubmitsAccepted
	// carries how many submits this message accepts, so
	// counting one accept per message would undercount.
	now := time.Now()
	var settled uint64
	for seq, sent := range s.submitTimes {
		if seq <= last {
			s.tick.latency.Record(float64(now.Sub(sent).Microseconds()) / 1000.0)
			delete(s.submitTimes, seq)
			settled++
			delete(s.submitTargets, seq)
		}
	}
	n := uint64(a.NewSubmitsAccepted)
	if n == 0 || n > settled {
		// Pool sent no explicit count, or claims more
		// accepts than submits it settled; locally observed
		// settlements are both the floor and the ceiling —
		// never credit shares that were never sent.
		n = settled
	}
	s.opts.log("info", fmt.Sprintf("engine: share accepted (+%d)", n))
	if s.opts.m != nil && n > 0 {
		s.opts.m.sharesAccepted.Add(n)
	}
}

// onShareReject settles submit bookkeeping for a SubmitSharesError
// frame, drops frames that name a never-sent sequence number, and
// suppresses retarget-transition rejects from the reject rate.
func (s *v2Session) onShareReject(e *stratum.SubmitSharesError) {
	if e.SequenceNumber > s.seqNum {
		// The pool rejected a submit that never happened —
		// SV2 assigns one response per SequenceNumber, so a
		// seq beyond what we sent is unambiguously bogus.
		// A hostile pool could otherwise inflate the reject
		// rate and trip the curtailment gate at will.
		s.opts.log("debug", fmt.Sprintf(
			"engine: share reject with future seq %d ignored (sent %d)",
			e.SequenceNumber, s.seqNum))
		return
	}
	// Settle the outstanding submit if still tracked: an
	// error is the share's final response too, and leaving
	// the entry would leak it until some later success.
	if sent, ok := s.submitTimes[e.SequenceNumber]; ok {
		s.tick.latency.Record(float64(time.Since(sent).Microseconds()) / 1000.0)
		delete(s.submitTimes, e.SequenceNumber)
	}
	reason := poolproto.SanitizePoolText(e.Error)
	issued, tracked := s.submitTargets[e.SequenceNumber]
	delete(s.submitTargets, e.SequenceNumber)
	category, diagnosis := rejectClass(reason)
	if tracked && transitionReject(category, issued, s.shareTarget) {
		// ESP-Miner #212: the share was ground under a target the
		// pool has since replaced via SetTarget — a retarget
		// artifact, not a real reject. Counted in the per-reason
		// breakdown only, never in the reject-rate counters.
		s.opts.log("info", fmt.Sprintf(
			"engine: share rejected under superseded share target: %s (excluded from reject rate)",
			reason))
		if s.opts.m != nil {
			s.opts.m.rejectReason("difficulty-transition").Inc()
		}
		return
	}
	s.opts.log("warn", fmt.Sprintf("engine: share rejected: %s (%s)",
		reason, diagnosis))
	if s.opts.m != nil {
		s.opts.m.sharesRejected.Inc()
		s.opts.m.rejectReason(category).Inc()
		s.opts.m.touchLastReject(category, time.Now().Unix())
	}
}

// onFrame dispatches one decoded pool frame. Channel-scoped frames for a
// foreign channel are dropped; a closed channel or a read error ends the
// session.
func (s *v2Session) onFrame(pm poolMsg, ok bool) error {
	if !ok {
		return fmt.Errorf("engine: pool closed connection")
	}
	if pm.err != nil {
		return fmt.Errorf("engine: pool read: %w", pm.err)
	}
	// Channel-scoped frames must name our channel. A frame
	// addressed to a different channel would corrupt job,
	// prev-hash, or share-target state. SetNewPrevHash is
	// exempt: SV2 lets the pool address it to the group
	// channel our standard channel belongs to, whose ID the
	// handshake does not expose.
	if cid, ok := channelIDOf(pm.msg); ok && cid != s.chanID && pm.msg.SetNewPrevHash == nil {
		s.opts.log("warn", fmt.Sprintf("engine: frame for foreign channel %d ignored (channel %d)", cid, s.chanID))
		return nil
	}
	if pm.msg.NewMiningJob != nil {
		s.onNewJob(pm.msg.NewMiningJob)
	}
	if pm.msg.SetNewPrevHash != nil {
		s.onPrevHash(pm.msg.SetNewPrevHash)
	}
	if pm.msg.SetTarget != nil {
		s.onSetTarget(pm.msg.SetTarget)
	}
	if pm.msg.SubmitSharesSuccess != nil {
		s.onShareAccept(pm.msg.SubmitSharesSuccess)
	}
	if pm.msg.SubmitSharesError != nil {
		s.onShareReject(pm.msg.SubmitSharesError)
	}
	return nil
}

// onShare submits one locally-found share to the pool, bounded by the
// submit rate limiter and the in-flight bookkeeping cap.
func (s *v2Session) onShare(ctx context.Context, share miner.Share, ok bool) error {
	if !ok {
		return ctx.Err()
	}
	s.seqNum++
	if s.opts.m != nil {
		s.opts.m.sharesFound.Inc()
		s.opts.m.incSharesFoundForDevice(share.DeviceID)
	}
	if !s.submits.take() {
		if s.opts.m != nil {
			s.opts.m.sharesSubmitDropped.Inc()
		}
		s.opts.log("debug", "engine: share dropped by submit rate cap")
		return nil
	}
	sub := stratum.SubmitSharesStandard{
		ChannelID:      s.chanID,
		SequenceNumber: s.seqNum,
		JobID:          share.JobID,
		Nonce:          share.Nonce,
		NTime:          share.NTime,
		// The version that was actually hashed, carried on the
		// share itself — the pool recomputes the header hash from
		// these fields, so any mismatch means a rejected share.
		NVersion: share.Version,
	}
	if err := sendMsg(s.conn, stratum.MsgSubmitSharesStandard, true, &sub); err != nil {
		return fmt.Errorf("engine: submit share: %w", err)
	}
	if s.opts.m != nil {
		s.opts.m.sharesSubmitted.Inc()
	}
	s.submitTimes[s.seqNum] = time.Now()
	s.submitTargets[s.seqNum] = share.Target
	if len(s.submitTimes) > submitTimesCap {
		// Pool is not acknowledging; drop the oldest half so the
		// map stays bounded. Latency for dropped entries is lost,
		// which is the honest outcome — it was never measured.
		cutoff := s.seqNum - submitTimesCap/2
		for seq := range s.submitTimes {
			if seq < cutoff {
				delete(s.submitTimes, seq)
				delete(s.submitTargets, seq)
			}
		}
	}
	if s.opts.m != nil {
		s.opts.m.sharesSubmitInFlight.Set(float64(len(s.submitTimes)))
	}
	s.opts.log("info", fmt.Sprintf("engine: share seq=%d nonce=0x%08X", s.seqNum, share.Nonce))
	return nil
}

// v1Credentials builds the poolproto credentials for a Stratum V1 dial:
// the configured password or the long-standing "x" convention (see
// KNOWN_LIMITATIONS.md §10), plus the optional CA bundle for
// stratum+tls:// private-CA pools.
func v1Credentials(opts *sessionOpts) poolproto.Credentials {
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
	return creds
}

// v1Session bundles the per-connection state of a Stratum V1 pool
// session: the poolproto session, the submit rate limiter, and the
// shared stats-tick counters.
type v1Session struct {
	opts    *sessionOpts
	sess    poolproto.Session
	submits *submitLimiter
	tick    *sessionTick
}

// onJob applies one pool job unless hashing is curtailed, and keeps the
// job-starvation clock current. A closed Jobs channel honours any
// pool-requested reconnect delay, then ends the session.
func (s *v1Session) onJob(ctx context.Context, job poolproto.Job, ok bool, chanID uint32) error {
	if !ok {
		// A pool that sent client.reconnect/mining.reconnect may
		// have asked for a pause before we reconnect; honor the
		// (already-clamped) delay. Capped by ReconnectWait itself
		// and cancellable via ctx, so shutdown stays instant.
		if rw, isWaiter := s.sess.(poolproto.ReconnectWaiter); isWaiter {
			if w := rw.ReconnectWait(); w > 0 {
				s.opts.log("info", fmt.Sprintf("engine: pool requested %s reconnect delay", w))
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(w):
				}
			}
		}
		return fmt.Errorf("engine: pool closed connection")
	}
	// While curtailed, keep workers idle and ignore the job (see the
	// V2 path for rationale). lastJobReceivedAt still updates because
	// the pool connection remains alive.
	if s.opts.isCurtailed() {
		s.opts.log("debug", fmt.Sprintf("engine: V1 job %q ignored (curtailed)", job.JobID))
	} else {
		if err := applyJob(s.opts.workers, s.opts.arbPaused, &job, chanID, s.sess.SuggestedDifficulty()); err != nil {
			s.opts.log("warn", err.Error())
			return nil // skip this job; do not count it as pool liveness
		}
		s.opts.log("info", fmt.Sprintf("engine: V1 job %q nBits=0x%08X", job.JobID, job.NBits))
	}
	if s.opts.m != nil {
		s.opts.m.lastJobReceivedAt.Set(float64(time.Now().Unix()))
	}
	s.tick.lastJobAt = time.Now()
	return nil
}

// onShare queues one locally-found share for asynchronous submission:
// V1 Submit is synchronous, so it runs in a goroutine (bounded by the
// submit rate limiter) to keep the job-receive path unblocked.
func (s *v1Session) onShare(ctx context.Context, share miner.Share, ok bool) error {
	if !ok {
		return ctx.Err()
	}
	if s.opts.m != nil {
		s.opts.m.sharesFound.Inc()
		s.opts.m.incSharesFoundForDevice(share.DeviceID)
	}
	if !s.submits.take() {
		if s.opts.m != nil {
			s.opts.m.sharesSubmitDropped.Inc()
		}
		s.opts.log("debug", "engine: share dropped by submit rate cap")
		return nil
	}
	if s.opts.m != nil {
		// Counted here, not after Submit returns: "submitted" means
		// the transmission was attempted, matching the V2 path's
		// increment at send time rather than at response time — a
		// slow or failing pool response is a distinct, separately
		// tracked event (sharesAccepted/sharesRejected, or the "V1
		// submit" warning log on a hard failure).
		s.opts.m.sharesSubmitted.Inc()
	}
	go s.submitResult(ctx, share)
	return nil
}

// submitResult delivers one share to the pool and records its outcome:
// latency on every response, accepted/rejected counters, and suppressing
// retarget-transition rejects from the reject rate. Runs as a goroutine
// spawned by onShare.
func (s *v1Session) submitResult(ctx context.Context, share miner.Share) {
	sendTime := time.Now()
	result, err := s.sess.Submit(ctx, poolproto.ShareSubmission{
		JobID:      strconv.FormatUint(uint64(share.JobID), 10),
		Nonce:      share.Nonce,
		NTime:      share.NTime,
		ExtraNonce: share.ExtraNonce,
	})
	elapsed := float64(time.Since(sendTime).Milliseconds())
	if err != nil {
		s.opts.log("warn", fmt.Sprintf("engine: V1 submit: %v", err))
		// Still record the latency on error: a p99 spike caused by
		// a pool disconnect is a signal worth surfacing, not hiding.
		if elapsed > 0 {
			s.tick.latency.Record(elapsed)
		}
		return
	}
	if result.Accepted {
		s.opts.log("info", "engine: V1 share accepted")
		s.tick.latency.Record(elapsed)
		if s.opts.m != nil {
			s.opts.m.sharesAccepted.Inc()
		}
		return
	}
	reason := poolproto.SanitizePoolText(result.Reason)
	category, diagnosis := rejectClass(reason)
	// ESP-Miner #212: a share rejected as above-target may
	// have been ground under a difficulty the pool has
	// since replaced via set_difficulty — a retarget
	// artifact, not a real reject. Compare the share's
	// issue-time target against the current share target;
	// counted in the per-reason breakdown only.
	if current, ok := v1ShareTarget(s.sess.SuggestedDifficulty()); ok &&
		transitionReject(category, share.Target, current) {
		s.opts.log("info", fmt.Sprintf(
			"engine: V1 share rejected under superseded difficulty epoch: %s (excluded from reject rate)",
			reason))
		if s.opts.m != nil {
			s.opts.m.rejectReason("difficulty-transition").Inc()
		}
		return
	}
	s.opts.log("warn", fmt.Sprintf("engine: V1 share rejected: %s (%s)",
		reason, diagnosis))
	if s.opts.m != nil {
		s.opts.m.sharesRejected.Inc()
		s.opts.m.rejectReason(category).Inc()
		s.opts.m.touchLastReject(category, time.Now().Unix())
	}
}

// runSessionV1 handles one Stratum V1 pool connection via poolproto.DialURL.
// It mirrors the structure of the V2 runSession loop but consumes the
// protocol-agnostic poolproto.Session interface (Jobs() / Submit()) instead
// of the Stratum V2 framing directly.
func runSessionV1(ctx context.Context, opts sessionOpts) error {
	creds := v1Credentials(&opts)
	sess, err := poolproto.DialURL(ctx, opts.poolURL, &creds)
	if err != nil {
		return fmt.Errorf("engine: %w", err)
	}
	defer sess.Close()
	opts.log("info", fmt.Sprintf("engine: connected to %s (Stratum V1)", poolproto.StripUserinfo(opts.poolURL)))
	if opts.m != nil {
		opts.m.poolConnectionState.Set(2)
	}
	if opts.onConnected != nil {
		opts.onConnected()
	}

	// V1 is single-channel; channel ID 0 is the conventional value.
	const chanID = uint32(0)

	statsTicker := time.NewTicker(opts.interval)
	defer statsTicker.Stop()

	limiterCtx, stopLimiter := context.WithCancel(ctx)
	defer stopLimiter()

	s := &v1Session{
		opts:    &opts,
		sess:    sess,
		submits: newSubmitLimiter(limiterCtx),
		tick:    newSessionTick(&opts),
	}

	// Pools send operator notices via client.show_message (maintenance
	// windows, credential errors, migration hints). Nil channel when the
	// session type has no notices — a nil case channel is never ready.
	var notices <-chan string
	if nr, ok := sess.(poolproto.PoolNoticeReceiver); ok {
		notices = nr.PoolNotices()
	}

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()

		case notice, ok := <-notices:
			if !ok {
				notices = nil // pool is gone; never ready again
			} else {
				opts.log("info", fmt.Sprintf("engine: pool notice: %s", notice))
			}

		case <-statsTicker.C:
			s.tick.observe(time.Now(), sess.SuggestedDifficulty())

		case job, ok := <-sess.Jobs():
			if err := s.onJob(ctx, job, ok, chanID); err != nil {
				return err
			}

		case share, ok := <-opts.merged:
			if err := s.onShare(ctx, share, ok); err != nil {
				return err
			}
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
// handshakeTimeout bounds the SV2 SetupConnection + OpenMiningChannel
// exchange. Var so tests can shrink it.
var handshakeTimeout = 15 * time.Second

func handshake(conn net.Conn, dec *stratum.Decoder, poolURL, user string, workers []*miner.Worker, nominalHashrate float64) (uint32, miner.Hash, error) {
	host, _ := parseHost(poolURL)
	// Bound the entire handshake: a peer that accepts the connection but
	// never answers SetupConnection would otherwise hold the failover
	// loop forever. The deadline is cleared before returning so the
	// session's steady-state reads are unbounded.
	_ = conn.SetDeadline(time.Now().Add(handshakeTimeout))
	defer func() { _ = conn.SetDeadline(time.Time{}) }()
	sc := stratum.SetupConnection{
		Protocol:        stratum.MiningProtocol,
		MinVersion:      2,
		MaxVersion:      2,
		Endpoint:        host,
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
		return 0, miner.Hash{}, &fatalError{fmt.Sprintf("pool rejected: %q", msg.SetupConnectionError.Error)}
	}
	if msg.SetupConnectionSuccess == nil {
		return 0, miner.Hash{}, fmt.Errorf("engine: unexpected msg 0x%02X during setup", f.Header.MsgType)
	}

	var hashRate float32
	for _, w := range workers {
		hashRate += float32(w.Stats().HashRate)
	}
	// Workers have not hashed anything on a fresh session, so their live
	// rate is ~0; declaring 0 would tell the pool to seed vardiff for a
	// zero-rate miner. Fall back to the capability-derived nominal estimate
	// (on reconnect the live rate is non-zero and wins, reflecting the
	// sustained — possibly thermally throttled — throughput).
	if hashRate <= 0 {
		hashRate = float32(nominalHashrate)
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
	if msg.OpenMiningChannelError != nil {
		return 0, miner.Hash{}, &fatalError{fmt.Sprintf("pool rejected channel open: %q", msg.OpenMiningChannelError.Error)}
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

// channelIDOf reports the channel_id carried by a channel-scoped SV2
// message. ok is false for frames with no channel field (unknown or
// connection-scoped types), which callers should let through.
func channelIDOf(m stratum.Message) (uint32, bool) {
	switch {
	case m.NewMiningJob != nil:
		return m.NewMiningJob.ChannelID, true
	case m.SetNewPrevHash != nil:
		return m.SetNewPrevHash.ChannelID, true
	case m.SetTarget != nil:
		return m.SetTarget.ChannelID, true
	case m.SubmitSharesSuccess != nil:
		return m.SubmitSharesSuccess.ChannelID, true
	case m.SubmitSharesError != nil:
		return m.SubmitSharesError.ChannelID, true
	}
	return 0, false
}

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
func updateWork(workers []*miner.Worker, paused *pauseSet, job *stratum.NewMiningJob, chanID uint32,
	prevHash [32]byte, prevNBits, ntime uint32, shareTarget miner.Hash,
) {
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
			Time:       rollNTime(ntime),
			Bits:       prevNBits,
		},
		NBits:  prevNBits,
		Target: target,
	}
	for _, wr := range workers {
		if paused != nil && paused.Paused(wr.DeviceID()) {
			continue // arbitration paused this device; the next Decide may resume it
		}
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

// v1ShareTarget resolves the share target implied by the pool's latest
// mining.set_difficulty value — the "current" side of a transitionReject
// comparison. ok is false when no difficulty has been assigned yet
// (difficulty 0, meaning workers fall back to the nBits target via
// v1JobTarget) or the difficulty fails conversion; either way the pool's
// current target epoch cannot be established and a reject must take the
// ordinary path.
func v1ShareTarget(difficulty float64) (miner.Hash, bool) {
	if difficulty <= 0 {
		return miner.Hash{}, false
	}
	t, err := miner.TargetFromDifficulty(difficulty)
	if err != nil {
		return miner.Hash{}, false
	}
	return t, true
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
// difficulty is the Stratum V1 session's most recent mining.set_difficulty
// value (poolproto.Job carries no difficulty field: V1 delivers it on a
// separate notification that applies to every job until superseded, not
// attached to mining.notify). See v1JobTarget for how it is applied.
func applyJob(workers []*miner.Worker, paused *pauseSet, job *poolproto.Job, chanID uint32, difficulty float64) error {
	target, err := v1JobTarget(job.NBits, difficulty)
	if err != nil {
		return fmt.Errorf("engine: bad target for job %q: %w", job.JobID, err)
	}
	var jobID uint32
	if _, err := fmt.Sscanf(job.JobID, "%d", &jobID); err != nil {
		return fmt.Errorf("engine: unparseable job ID %q: %w", job.JobID, err)
	}
	w := &miner.Work{
		JobID:     jobID,
		ChannelID: chanID,
		Header: miner.Header{
			MerkleRoot: job.MerkleRoot,
			Time:       rollNTime(job.NTime),
			Bits:       job.NBits,
		},
		NBits:      job.NBits,
		Target:     target,
		ExtraNonce: job.ExtraNonce,
	}
	for _, wr := range workers {
		if paused != nil && paused.Paused(wr.DeviceID()) {
			continue
		}
		wr.SetWork(w)
	}
	return nil
}

// rollNTime rolls a stale pool-declared ntime forward to the local wall
// clock. SRI 1.12.0 tightened share validation to enforce ntime_start/nTime
// bounds on every channel type: a share stamped with the job's original
// (aging) ntime lands outside the pool's acceptance window once the job
// has been grinding for a while — a guaranteed reject that burns
// hashrate for nothing. Rolling ntime forward is standard miner
// behaviour (it is part of the effective nonce space); a future ntime
// is kept verbatim since undershooting ntime_start is itself a reject.
func rollNTime(declared uint32) uint32 {
	if now := uint32(time.Now().Unix()); declared < now {
		return now
	}
	return declared
}

func parseHost(url string) (string, error) {
	host, err := poolproto.StripScheme(url)
	if err != nil {
		return "", fmt.Errorf("engine: %w", err)
	}
	return host, nil
}

func isFatal(err error) bool {
	var fe *fatalError
	return errors.As(err, &fe)
}

type fatalError struct{ msg string }

// submitRateInterval / submitBurst bound the rate of share submissions
// reaching the wire per pool session. Workers can find shares arbitrarily
// fast when the pool's difficulty collapses (a hostile or misconfigured
// mining.set_difficulty → 0); without a cap, every found share spawns a
// Submit goroutine and a wire frame, flooding the pool and this process.
// The cap is deliberately far above any honest pool's credit rate —
// shares past it are stale by the time they would send anyway.
const (
	submitRateInterval = 125 * time.Millisecond // one token per tick: 8/s
	submitBurst        = 32
)

// submitLimiter is a token bucket that refills at submitRateInterval up to
// submitBurst. take() never blocks: no token means the share is dropped.
type submitLimiter struct {
	tokens chan struct{}
}

func newSubmitLimiter(ctx context.Context) *submitLimiter {
	l := &submitLimiter{tokens: make(chan struct{}, submitBurst)}
	// Start full: a normal trickle of shares must never wait for a tick.
	for i := 0; i < submitBurst; i++ {
		l.tokens <- struct{}{}
	}
	go func() {
		t := time.NewTicker(submitRateInterval)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				select {
				case l.tokens <- struct{}{}:
				default:
				}
			case <-ctx.Done():
				return
			}
		}
	}()
	return l
}

func (l *submitLimiter) take() bool {
	select {
	case <-l.tokens:
		return true
	default:
		return false
	}
}

func (e *fatalError) Error() string { return e.msg }
