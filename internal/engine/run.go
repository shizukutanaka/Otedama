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
	"crypto/rand"
	"crypto/tls"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"math/big"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shizukutanaka/Otedama/internal/arbitration"
	"github.com/shizukutanaka/Otedama/internal/btccrypto"
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

// Engine timing constants. Centralized here so the reconnection and
// re-arbitration cadence is documented in one place rather than buried
// as magic numbers in the run loops.
const (
	// reconnectBackoffInitial is the first delay after a session ends
	// before reconnecting. Doubles on each consecutive failure.
	reconnectBackoffInitial = time.Second

	// reconnectBackoffMax caps the exponential reconnect backoff.
	reconnectBackoffMax = 64 * time.Second

	// reconnectBackoffJitterPct is the uniform ±percentage applied to each
	// backoff sleep. The exponential base still doubles on schedule, but the
	// actual sleep is spread across the window so a fleet of miners
	// reconnecting after a shared outage does not hammer the pool in
	// lockstep (thundering herd).
	reconnectBackoffJitterPct = 25
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

// poolSilenceTimeout bounds how long the V2 read loop tolerates a
// completely silent connection. The V1 path gets the same protection from
// its 5-minute per-line read deadline (stratumv1.go); without one here a
// half-open connection that never sends another frame would pin the
// engine to a dead pool forever — the stall warn fires but the session
// never ends, so failover could never happen. 30 minutes sits well beyond
// inter-block silence while still bounding a wedged connection.
var poolSilenceTimeout = 30 * time.Minute

// poolDialTimeout bounds a single pool dial attempt — TCP connect for
// plaintext, connect + TLS handshake for TLS schemes. A blackholed
// endpoint without it stalls each failover hop for the OS connect
// timeout (~127s on Linux). Var so tests can shrink it.
var poolDialTimeout = 15 * time.Second

// yieldFailoverMinJudged is how many shares a session must have judged
// (accepted + rejected) before its acceptance rate is trusted enough to
// abandon the pool — below that, early-session reject bursts (retarget
// races, stale-job stragglers) would churn failover instead of recovering
// revenue.
const yieldFailoverMinJudged = 32

// yieldFailoverAcceptanceFloor is the per-session share acceptance below
// which the pool is measurably destroying revenue: every rejected share
// is hashes spent but never credited. 90% is far below the >99% a
// healthy pool delivers, so any configured alternate is the better bet.
const yieldFailoverAcceptanceFloor = 0.90

// errYieldDegraded ends a session whose pool provably wastes hashpower.
// It is not fatal: the reconnect loop treats it like any session end and
// fails over to the next configured pool.
var errYieldDegraded = errors.New("engine: pool share acceptance below yield floor")

// yieldDegraded reports whether a session's own accepted/rejected counts
// have fallen below the revenue floor after enough judged shares to be
// trustworthy.
func yieldDegraded(accepted, rejected uint64) bool {
	return accepted+rejected >= yieldFailoverMinJudged &&
		acceptanceRate(accepted, rejected) < yieldFailoverAcceptanceFloor
}

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

// resolveRunDefaults fills in Run's nil-able options in place and
// returns the effective logger (a no-op when none was configured).
func resolveRunDefaults(opts *Options) func(level, msg string) {
	if opts.Clock == nil {
		opts.Clock = clock.System{}
	}
	if opts.Output == nil {
		opts.Output = os.Stdout
	}
	opts.Input = cmp.Or[io.Reader](opts.Input, os.Stdin)
	if opts.Logger != nil {
		return opts.Logger
	}
	return func(_, _ string) {}
}

// Run starts a full mining session and blocks until ctx is canceled.
// It orchestrates every subsystem: wallet, HAL, providers, arbitration,
// TUI, and the Stratum V2 pool connection.
func Run(ctx context.Context, opts *Options) error {
	log := resolveRunDefaults(opts)
	startTime := opts.Clock.Now()

	m := registerRunMetrics(opts, startTime)

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

	// ----- Phases 1–3: wallet, hardware detection, miner workers -----
	walletFingerprint, devices, workers, merged, err := setupWalletAndWorkers(ctx, opts, log)
	if err != nil {
		return err
	}

	// Nominal hashrate for the SV2 OpenMiningChannel handshake: live worker
	// stats are ~0 at handshake time because no job has been hashed yet, so
	// the declared value comes from device capability families instead.
	nominalHR := nominalMiningHashrate(devices, workers)
	defer stopWorkers(workers)

	// ----- Phase 4: Price + network-stat feeds -----
	rateFetcher := rates.NewFetcher(95000) // $95k fallback
	rateFetcher.StartBackground(ctx, 5*time.Minute)

	// Network hashrate feed (KNOWN_LIMITATIONS §7): supplies the mining
	// provider's yield estimate with the live network size instead of the
	// compile-time ~1000 EH/s constant. Poll every 10 min — difficulty
	// retargets are ~fortnightly, so freshness needs are modest.
	hashFetcher := rates.NewHashrateFetcher()
	hashFetcher.SetLogger(func(msg string) { log("debug", msg) })
	hashFetcher.StartBackground(ctx, 10*time.Minute)

	// curtailGate is the single source of truth for whether hashing is
	// paused by the curtail_below_btc_usd threshold. The price goroutine
	// below flips it, and the session loop consults it before applying any
	// pool job — without this shared gate the next mining.notify (~30–60 s)
	// would silently re-arm the idled workers while otedama_curtailed still
	// read 1, so the pause neither held nor matched the metric.
	curtailGate := new(atomic.Bool)

	// arbPaused is the per-device counterpart of curtailGate: the set of
	// device IDs arbitration has paused (idle below the yield floor, or
	// routed to a non-mining stream). applyAllocation pauses a worker once,
	// but without a shared set the next pool job's updateWork/applyJob
	// would silently re-arm it and mine until the next Decide tick — the
	// same re-arm hole the curtail gate documents above.
	arbPaused := &pauseSet{}

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
	}()

	// ----- Phase 5: Providers -----
	miningProvider, akashProvider := startProviders(ctx, &opts.Config, rateFetcher, hashFetcher, devices, workers, log)
	defer miningProvider.Stop()
	defer akashProvider.Stop()

	// ----- Phase 6: Arbitration engine -----
	quoteCh := mergeQuotes(ctx,
		miningProvider.Quotes(),
		akashProvider.Quotes(),
	)

	// Build device refs for the arbitration engine.
	devRefs := deviceRefs(devices)

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

	// Arbitration loop: re-run Decide on a fixed tick (the loop's select
	// only wakes on the ticker or ctx — quotes only refresh the streams map,
	// they do not trigger decisions; see runArbitrationLoop).
	go runArbitrationLoop(ctx, &arbitrationLoopOpts{
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
		activityMu:       &activityMu,
		activity:         activity,
		paused:           arbPaused,
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

	return runReconnectLoop(ctx, &reconnectOpts{
		opts:            *opts,
		workers:         workers,
		merged:          merged,
		dashboard:       dashboard,
		startTime:       startTime,
		wallet:          walletFingerprint,
		deviceN:         len(devices),
		providers:       []provider.Provider{miningProvider, akashProvider},
		miningProvider:  miningProvider,
		metrics:         m,
		log:             log,
		curtailGate:     curtailGate,
		arbPaused:       arbPaused,
		nominalHashrate: nominalHR,
		activityMu:      &activityMu,
		activity:        activity,
	})
}

// registerRunMetrics builds the run's metrics set on the configured
// registry — or a throwaway one when none is provided, so the rest of
// engine.Run does not need nil-checks at every call site — and publishes
// the constant gauges (start time, power cost).
func registerRunMetrics(opts *Options, startTime time.Time) *engineMetrics {
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
	return m
}

// deviceRefs builds the arbitration engine's view of the detected
// devices (identity + capabilities).
func deviceRefs(devices []hal.Device) []arbitration.DeviceRef {
	refs := make([]arbitration.DeviceRef, len(devices))
	for i, d := range devices {
		refs[i] = arbitration.DeviceRef{
			Identity:     d.Identity(),
			Capabilities: d.Capabilities(),
		}
	}
	return refs
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
	// miningProvider is the same object as providers[0], held concretely so
	// the session loop can re-point its payout scheme at the pool being
	// dialed on each attempt.
	miningProvider *provider.MiningProvider
	metrics        *engineMetrics
	log            func(level, msg string)
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

// jitteredBackoff perturbs d by a uniform ±reconnectBackoffJitterPct drawn
// from crypto/rand. The reconnect loop sleeps this value while tracking the
// un-jittered exponential base, so consecutive failures still double on
// schedule while concurrent attempts spread across the window. A crypto/rand
// failure or a degenerate base falls back to d — degraded spread, still
// correct timing.
func jitteredBackoff(d time.Duration) time.Duration {
	span := int64(d) * 2 * reconnectBackoffJitterPct / 100 // uniform range centered on d
	if span <= 0 {
		return d
	}
	n, err := rand.Int(rand.Reader, big.NewInt(span))
	if err != nil {
		return d
	}
	return d - time.Duration(int64(d)*reconnectBackoffJitterPct/100) + time.Duration(n.Int64())
}

// runReconnectLoop dials the pool, runs a session, and reconnects with
// exponential backoff (capped at reconnectBackoffMax) until ctx is canceled, a fatal
// error occurs, or MaxReconnectAttempts is exceeded.
func runReconnectLoop(ctx context.Context, r *reconnectOpts) error {
	pools := poolURLs(&r.opts.Config)
	addrs := payoutAddresses(&r.opts.Config)
	poolIdx := 0
	addrIdx := 0
	addrConnected := false // has the active address ever established a session?
	attempt := 0
	backoff := reconnectBackoffInitial
	// Pools proven to waste hashpower are excluded from failover rotation
	// for the rest of the epoch (the bfgminer --disable-rejecting
	// strategy): without memory, a pure round-robin re-dials a degraded
	// pool after every other pool merely disconnects.
	yieldDegradedPools := make(map[int]bool, len(pools))

	statsInterval := r.opts.StatsInterval
	if statsInterval <= 0 {
		statsInterval = 10 * time.Second
	}

	for ctx.Err() == nil {
		attempt++
		if r.opts.MaxReconnectAttempts > 0 && attempt > r.opts.MaxReconnectAttempts {
			return fmt.Errorf("engine: exceeded %d reconnect attempts", r.opts.MaxReconnectAttempts)
		}
		params := r.resolveAttempt(poolIdx, addrIdx, pools, addrs)
		poolURL := params.poolURL

		r.announceAttempt(attempt, poolIdx, addrIdx, pools, addrs, poolURL)
		connectedThisAttempt := false
		sessionErr := runSession(ctx, &sessionOpts{
			poolURL:         poolURL,
			user:            params.user,
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
			tlsCAFile:       params.tlsCAFile,
			poolPassword:    params.password,
			payoutAddr:      params.payoutAddr,
			payoutScheme:    params.payoutScheme,
			yieldFailover:   len(pools) > 1,
			activityMu:      r.activityMu,
			activity:        r.activity,
			onConnected: func() {
				addrConnected = true
				connectedThisAttempt = true
				if r.opts.OnReady != nil {
					r.opts.OnReady(true) // pool session established → ready
				}
			},
		})
		r.recordSessionOutcome(sessionErr, ctx.Err() == nil, poolIdx, len(pools), yieldDegradedPools)
		r.finishSession(poolURL)

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
			backoff = reconnectBackoffInitial
		}

		// Pool failover (fast): advance to the next pool in priority
		// order before touching the payout address or backing off.
		var retryNow bool
		poolIdx, retryNow = r.advancePoolFailover(poolIdx, pools, yieldDegradedPools, sessionErr)
		if retryNow {
			continue
		}

		// Payout-address failover (slow, deliberately conservative)
		// and the retry-decision log lines.
		//
		// Draw the jittered sleep once here so the log lines report
		// the actual delay, not the nominal exponential base.
		sleep := jitteredBackoff(backoff)
		addrIdx, poolIdx, addrConnected, retryNow = r.rotatePayoutAddress(addrs, pools, addrIdx, poolIdx, addrConnected, sessionErr, sleep)
		if retryNow {
			continue
		}
		if err := waitBackoff(ctx, sleep); err != nil {
			return err
		}
		if backoff < reconnectBackoffMax {
			backoff *= 2
		}
	}
	return ctx.Err()
}

// attemptParams holds the per-attempt connection parameters resolved
// from the active pool/address indices.
type attemptParams struct {
	poolURL      string
	user         string
	tlsCAFile    string
	password     string
	payoutAddr   string
	payoutScheme string
}

// resolveAttempt resolves the connection parameters for one reconnect
// attempt from the active pool and payout-address indices, and reprices
// the mining provider for the pool this attempt dials.
func (r *reconnectOpts) resolveAttempt(poolIdx, addrIdx int, pools, addrs []string) attemptParams {
	p := attemptParams{poolURL: pools[poolIdx]}
	var poolUser string
	if poolIdx < len(r.opts.Config.Pools) {
		poolUser = r.opts.Config.Pools[poolIdx].User
		p.tlsCAFile = r.opts.Config.Pools[poolIdx].TLSCAFile
		p.password = r.opts.Config.Pools[poolIdx].Password
		p.payoutScheme = r.opts.Config.Pools[poolIdx].PayoutScheme
	}
	p.user = sessionUser(poolUser, addrs[addrIdx], r.opts.Config.Workers.Name)
	// A direct-coinbase scheme (tides/solo) must place the user's locking
	// script in the coinbase itself; that is only verifiable when the user
	// identity derives from the configured address rather than an opaque
	// pools[].user override.
	if poolUser == "" && addrIdx < len(addrs) {
		p.payoutAddr = addrs[addrIdx]
	}
	// The quote's net-fee factor must price the pool this session dials,
	// not the pool configured at startup: failover across differently
	// schemed pools (e.g. fpps -> solo) reprices subsequent quotes.
	r.miningProvider.SetPayoutScheme(p.payoutScheme)
	return p
}

// announceAttempt logs the connection attempt and updates the
// active-pool/address gauges.
func (r *reconnectOpts) announceAttempt(attempt, poolIdx, addrIdx int, pools, addrs []string, poolURL string) {
	loc := fmt.Sprintf("attempt %d", attempt)
	if len(pools) > 1 {
		loc += fmt.Sprintf(", pool %d/%d", poolIdx+1, len(pools))
	}
	if len(addrs) > 1 {
		loc += fmt.Sprintf(", address %d/%d", addrIdx+1, len(addrs))
	}
	r.log("info", fmt.Sprintf("engine: connecting to %s (%s)", poolproto.StripUserinfo(poolURL), loc))

	r.metrics.poolConnectAttempts.Inc()
	r.metrics.poolActiveIndex.Set(float64(poolIdx))
	r.metrics.payoutActiveIndex.Set(float64(addrIdx))
	if addrIdx < len(addrs) {
		r.metrics.setActivePayout(maskAddr(addrs[addrIdx]))
	}
	r.metrics.poolConnectionState.Set(1) // connecting
}

// recordSessionOutcome accounts for a finished session: a yield-degraded
// exit marks the pool and counts a yield failover; any other exit counts
// a connect failure.
func (r *reconnectOpts) recordSessionOutcome(sessionErr error, engineRunning bool, poolIdx, nPools int, yieldDegradedPools map[int]bool) {
	// sessionErr is non-nil on every session exit — including a clean
	// ctx-canceled shutdown, where it is "pool closed connection" or
	// ctx.Err(). A graceful stop is not a connect failure; only count
	// exits that happened while the engine still intended to run.
	if sessionErr != nil && engineRunning {
		if errors.Is(sessionErr, errYieldDegraded) {
			r.metrics.poolYieldFailovers.Inc()
			yieldDegradedPools[poolIdx] = true
			r.log("warn", fmt.Sprintf(
				"engine: pool %d/%d share acceptance below yield floor; excluded from failover rotation",
				poolIdx+1, nPools))
		} else {
			r.metrics.poolConnectFailures.Inc()
		}
	}
}

// finishSession performs the post-session teardown: connection-state
// gauge, readiness callback, worker idling, and a final dashboard frame
// so the TUI does not freeze on its last "connected" frame for the
// entire backoff/reconnect window.
func (r *reconnectOpts) finishSession(poolURL string) {
	r.metrics.poolConnectionState.Set(0) // session ended → disconnected
	if r.opts.OnReady != nil {
		r.opts.OnReady(false) // session ended → not ready
	}
	// Idle the workers until the next session issues fresh work. A
	// dead session's last job is guaranteed-superseded under the new
	// session's IDs (V1 negotiates new extranonces, V2 a new
	// channel), so hashing it through the backoff window burns power
	// on shares the submit gate will always drop.
	for _, w := range r.workers {
		w.SetWork(nil)
	}
	if r.dashboard != nil {
		// The session's own stats tick stops the instant it returns, so
		// without this push the dashboard freezes on its last
		// "✓ connected" frame for the entire backoff/reconnect window.
		r.dashboard.Update(disconnectedStats(poolURL, r.wallet, r.startTime, r.deviceN))
	}
}

// advancePoolFailover applies the fast pool-failover step after a
// session ends: it returns the pool index to dial next and whether the
// caller should retry immediately (a strictly later unmarked pool was
// selected). When every pool carries a degradation mark, the epoch is
// spent: marks are cleared and the caller falls through to backoff
// from the primary pool.
func (r *reconnectOpts) advancePoolFailover(poolIdx int, pools []string, yieldDegradedPools map[int]bool, sessionErr error) (int, bool) {
	// Pool failover (fast): advance to the next pool in priority order
	// before touching the payout address or backing off. A single-pool
	// config skips this and falls through to address failover / backoff.
	if len(pools) <= 1 {
		return poolIdx, false
	}
	prevPool := poolIdx
	poolIdx = nextFailoverPool(poolIdx, len(pools), yieldDegradedPools)
	switch {
	case poolIdx == prevPool && yieldDegradedPools[prevPool]:
		// Every pool carries a degradation mark: the epoch is
		// spent. Clear it so recovered pools get a fresh
		// judgment window, and retry from the primary after
		// the backoff below.
		clear(yieldDegradedPools)
		poolIdx = 0
		r.log("warn", fmt.Sprintf(
			"engine: all %d pools measured below the share-acceptance yield floor; "+
				"clearing degradation marks", len(pools)))
	case poolIdx > prevPool:
		r.log("warn", fmt.Sprintf("engine: session ended: %v; failing over to next pool", sessionErr))
		return poolIdx, true // next pool immediately, no backoff
	}
	// The walk wrapped (or the current pool is the only unmarked
	// one): every eligible pool failed for this address, so back
	// off — skipping a marked primary must not skip the backoff.
	return poolIdx, false
}

// rotatePayoutAddress applies the slow payout-address failover policy
// and logs the retry decision. Rotation is deliberately conservative:
// the active address rotates ONLY when it has never established a
// session — a working address is never abandoned, so an outage can
// never silently redirect earnings to a different address (no session
// establishes during an outage). retryNow reports that a fresh address
// should be dialed immediately, without backoff.
func (r *reconnectOpts) rotatePayoutAddress(addrs, pools []string, addrIdx, poolIdx int, addrConnected bool, sessionErr error, sleep time.Duration) (newAddrIdx, newPoolIdx int, newAddrConnected, retryNow bool) {
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
				maskAddr(addrs[addrIdx]), addrIdx+1, len(addrs),
			))
			return addrIdx, poolIdx, addrConnected, true // try next address immediately, no backoff
		}
		// Wrapped through every address; none connected. Back off and
		// retry from the primary so a recovered network resumes there.
		addrConnected = false
		r.log("warn", fmt.Sprintf(
			"engine: none of the %d configured payout addresses could connect; "+
				"backing off %v and retrying from the primary", len(addrs), sleep,
		))
	case len(pools) > 1:
		r.log("warn", fmt.Sprintf("engine: all %d pools failed; backing off %v", len(pools), sleep))
	default:
		r.log("warn", fmt.Sprintf("engine: session ended: %v; reconnecting in %v", sessionErr, sleep))
	}
	return addrIdx, poolIdx, addrConnected, false
}

// waitBackoff sleeps for the reconnect backoff, returning early with
// ctx.Err() when ctx is canceled.
func waitBackoff(ctx context.Context, sleep time.Duration) error {
	// time.NewTimer + explicit Stop rather than time.After: when ctx is
	// canceled (shutdown) the timer is released immediately instead of
	// lingering until backoff (up to reconnectBackoffMax) elapses — the
	// documented time.After-in-select pitfall, since pre-Go-1.23 a pending
	// timer cannot be garbage-collected until it fires.
	timer := time.NewTimer(sleep)
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		timer.Stop()
		return ctx.Err()
	}
}

// nextFailoverPool walks failover selection to the next pool that does not
// carry a yield-degradation mark, preserving priority order. It returns the
// start index when every other pool is marked; if start is marked too the
// epoch is spent and marks should be reset so recovered pools get a fresh
// judgment window.
func nextFailoverPool(start, n int, degraded map[int]bool) int {
	next := start
	for {
		next = (next + 1) % n
		if !degraded[next] || next == start {
			return next
		}
	}
}

// ----- Session -----

type sessionOpts struct {
	poolURL  string
	user     string
	workers  []*miner.Worker
	merged   <-chan miner.Share
	interval time.Duration
	// statsTick, when non-nil, supplies the session's stats ticks instead
	// of a real-time ticker on opts.interval. Tests use it to drive the
	// stats branch deterministically: on a heavily oversubscribed CI
	// runner the real-time ticker's case can go the whole session without
	// being scheduled after the events the test waits on, which made
	// tick-published gauges a scheduling lottery (see
	// TestRunSession_StatsTickAndShareResponses).
	statsTick  <-chan time.Time
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
	// payoutAddr is the configured payout address when the session's user
	// identity derives from it (no pools[].user override). For pools whose
	// payout_scheme pays the coinbase directly (tides/solo) runSessionV1
	// verifies each job's coinbase carries this address's locking script —
	// the only spot on the wire where a non-custodial payout is observable.
	payoutAddr string
	// payoutScheme is the active pool's configured payout_scheme
	// (fpps/pplns/tides/solo; empty = unset).
	payoutScheme string
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
	// yieldFailover enables the low-acceptance session exit; set only when
	// the config lists an alternate pool to move to — on the only pool a
	// degraded session must stay, since there is nowhere better to go.
	yieldFailover bool
}

// isCurtailed reports whether hashing is currently paused by the
// curtail_below_btc_usd threshold. Safe to call with a nil gate.
func (o *sessionOpts) isCurtailed() bool {
	return o.curtailGate != nil && o.curtailGate.Load()
}

// allArbPaused reports whether every worker is currently paused by
// arbitration (idle below the yield floor or routed to a non-mining
// stream). A nil set, or no workers, reports false.
func (o *sessionOpts) allArbPaused() bool {
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
// honoring curtailment and arbitration idling. While curtailed — or while
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

// runSession runs one pool connection: dial, handshake, then stream
// jobs to workers and shares back to the pool until the connection
// drops or ctx is canceled. Returns the error that ended the session
// (nil if ctx was canceled cleanly).
//
// Stratum V1 URLs (stratum+tcp://, stratum+tls://) are handled via
// poolproto.DialURL so the protocol abstraction is load-bearing for V1.
// The Stratum V2 path keeps the existing inline framing: the
// poolproto/stratumv2 dialer exists (KNOWN_LIMITATIONS §3, resolved), but
// bridging it into the engine's session loop is a separate piece of work
// still pending.
func runSession(ctx context.Context, opts *sessionOpts) error {
	proto := poolproto.FromURL(opts.poolURL)
	opts.log("info", fmt.Sprintf("engine: transport protocol: %s", proto))
	if proto == poolproto.ProtocolStratumV1 || proto == poolproto.ProtocolStratumV1TLS {
		return runSessionV1(ctx, opts)
	}
	// Schemes poolproto recognizes but Otedama does not implement —
	// currently datum:// (ADR-009, OCEAN's SV1-transport variant) — must
	// fail fast here rather than fall through to the plaintext SV2 dial
	// and speak binary V2 frames to a pool expecting a different
	// protocol, which only surfaces as a confusing connect/handshake
	// timeout.
	if proto != poolproto.ProtocolStratumV2 && proto != poolproto.ProtocolStratumV2TLS {
		return fmt.Errorf("engine: pool URL %q has unsupported protocol %q "+
			"(supported schemes: stratum+tcp://, stratum+tls://, stratum+v2://, stratum+v2tls://; "+
			"datum:// is recognized but not implemented — ADR-009)",
			opts.poolURL, proto)
	}

	host, err := parseHost(opts.poolURL)
	if err != nil {
		return fmt.Errorf("engine: bad pool URL %q: %w", poolproto.StripUserinfo(opts.poolURL), err)
	}

	conn, err := dialPoolConn(ctx, opts, proto, host)
	if err != nil {
		return err
	}
	defer conn.Close()
	opts.log("info", fmt.Sprintf("engine: connected to %s", host))

	dec := stratum.NewDecoder(conn)
	chanID, groupID, shareTarget, err := handshake(conn, dec, opts.poolURL, opts.user, opts.workers, opts.nominalHashrate)
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
	go readPoolFrames(ctx, conn, dec, inCh)

	s := newV2Session(ctx, opts, conn, chanID, groupID, shareTarget)
	defer s.finish()
	return s.run(inCh)
}

// dialPoolConn establishes the Stratum V2 transport connection for a
// v2:// or v2tls:// pool: a certificate-verified TLS connection for
// v2tls:// — never a silent plaintext downgrade — and plaintext TCP
// otherwise.
func dialPoolConn(ctx context.Context, opts *sessionOpts, proto poolproto.ProtocolID, host string) (net.Conn, error) {
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
		conn, err := stratum.DialTLS(dialCtx, host, tlsCfg)
		dialCancel()
		if err != nil {
			return nil, fmt.Errorf("engine: TLS dial %s: %w", host, err)
		}
		return conn, nil
	}
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
	conn, err := d.DialContext(ctx, "tcp", host)
	if err != nil {
		return nil, fmt.Errorf("engine: dial %s: %w", host, err)
	}
	return conn, nil
}

// readPoolFrames is the SV2 session's reader goroutine: it decodes
// frames from conn and forwards them to inCh until a read fails or ctx
// is canceled, closing inCh on exit.
func readPoolFrames(ctx context.Context, conn net.Conn, dec *stratum.Decoder, inCh chan<- poolMsg) {
	defer close(inCh)
	for {
		// Generous per-frame read deadline, same idea as the V1
		// loop's 5-minute bound: a zombie connection that stays
		// open but goes silent ends the session so the reconnect
		// loop can fail over — without it the engine would hash
		// stale work on a dead pool indefinitely.
		_ = conn.SetReadDeadline(time.Now().Add(poolSilenceTimeout))
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
}

// accountDroppedShares surfaces worker-dropped shares as a warning
// and a metric delta since the previous tick, returning the new
// last-observed dropped total.
func accountDroppedShares(opts *sessionOpts, lastDropped uint64) uint64 {
	if dropped := totalDropped(opts.workers); dropped != lastDropped {
		if dropped > lastDropped {
			opts.log("warn", fmt.Sprintf(
				"engine: dropped %d found share(s) — share submission is not keeping up with discovery",
				dropped-lastDropped,
			))
			if opts.m != nil {
				opts.m.sharesWorkerDropped.Add(dropped - lastDropped)
			}
		} else if opts.m != nil {
			// Worker counters reset on reconnect; the new total
			// holds drops already made in this session.
			opts.m.sharesWorkerDropped.Add(dropped)
		}
		return dropped
	}
	return lastDropped
}

// submitTimesCap bounds the in-flight submit bookkeeping maps: a pool
// that never acknowledges cannot grow them without bound over a long
// session.
const submitTimesCap = 1024

// v2Session holds the mutable state of one Stratum V2 pool session:
// the select loop in run dispatches each channel event — stats tick,
// pool frame, found share — to the method that handles it.
type v2Session struct {
	ctx  context.Context
	opts *sessionOpts
	conn net.Conn

	chanID      uint32
	groupID     uint32
	shareTarget miner.Hash

	statsTick <-chan time.Time
	ticker    *time.Ticker // nil when statsTick was injected via sessionOpts
	stopLimit func()
	submits   *submitLimiter

	seqNum uint32
	// estSats is the running estimated earnings shown in the TUI, produced by
	// integrating the arbitration expected-yield rate over productive time
	// (satsAcc). It is not a per-share tally — a share carries no sat value on
	// the wire (KNOWN_LIMITATIONS.md §9).
	estSats uint64
	satsAcc satsAccountant

	// Watch for a stalled miner (zero hashrate sustained across samples).
	hashMon *HashrateMonitor
	// Differentiate the cumulative hash counter into a current rate; the
	// stall monitor and the hashrate gauge both consume this, not the
	// lifetime average (which can never reach the stall floor).
	hashWindow hashrateWindow
	// Accumulate productive (actually-hashing) time for effective-uptime accounting.
	uptime uptimeAccountant
	// Tripwire for a silent pool: jobs stop arriving while the connection
	// stays open. The clock starts at session start — a pool that never
	// sends a first job is equally starved.
	lastJobAt        time.Time
	jobStarvedWarned bool
	// Tripwire for pool-assigned difficulty starving share production.
	starvedWarned bool

	// Track dropped shares so a consumer that cannot keep up surfaces as a
	// warning rather than silently losing found shares.
	lastDropped uint64

	// Track share-submission round-trip latency. submitTimes maps a
	// sequence number to the time the share was sent; entries are
	// settled (and deleted) on SubmitSharesSuccess, and additionally
	// capped at submitTimesCap so a pool that never acknowledges
	// cannot grow the map without bound over a long session.
	latency *LatencyTracker
	// submitTargets maps a submitted share's SequenceNumber to the share
	// target it was produced under (miner.Share.Target). Read on
	// SubmitSharesError to detect retarget rejects (transitionReject),
	// and reaped alongside submitTimes so the map stays bounded.
	submitTimes   map[uint32]time.Time
	submitTargets map[uint32]miner.Hash

	// Per-session share verdicts: the counters are engine-lifetime, so a
	// prior healthy pool must not mask this pool's rejects.
	startAccepted uint64
	startRejected uint64

	// seenUnknown keys the once-per-type warning for unrecognized SV2
	// msg_types (forward-compat drops). Bounded at 256 by the uint8
	// msg_type space — a pool cannot grow it past the type space.
	seenUnknown map[uint8]bool
	// seenMisplaced keys the same once-per-type warning for decoded but
	// out-of-place types (handshake-phase and client→server messages a
	// pool must never send mid-session).
	seenMisplaced map[uint8]bool

	// SV2 job / chain-tip state. A block header cannot be hashed until
	// BOTH a job (merkle root + version, via NewMiningJob) and the chain
	// tip (prev_hash + network nBits + ntime, via SetNewPrevHash) are
	// known. Jobs without ntime_start are *future jobs*: they activate only
	// when a SetNewPrevHash names their job_id. SetNewPrevHash also
	// invalidates every other outstanding job (they extend a stale tip).
	jobs      map[uint32]*stratum.NewMiningJob
	jobOrder  []uint32 // insertion order for jobsCap FIFO eviction
	active    *stratum.NewMiningJob
	prevHash  [32]byte
	prevNBits uint32
	// activeNTime is the ntime the active job is being hashed with.
	activeNTime uint32
	havePrev    bool
}

func newV2Session(ctx context.Context, opts *sessionOpts, conn net.Conn, chanID, groupID uint32, shareTarget miner.Hash) *v2Session {
	s := &v2Session{
		ctx:           ctx,
		opts:          opts,
		conn:          conn,
		chanID:        chanID,
		groupID:       groupID,
		shareTarget:   shareTarget,
		statsTick:     opts.statsTick,
		hashMon:       NewHashrateMonitor(0, 3, opts.log),
		latency:       NewLatencyTracker(256),
		submitTimes:   make(map[uint32]time.Time),
		submitTargets: make(map[uint32]miner.Hash),
		seenUnknown:   make(map[uint8]bool),
		seenMisplaced: make(map[uint8]bool),
		jobs:          make(map[uint32]*stratum.NewMiningJob),
		lastJobAt:     time.Now(),
	}
	if s.statsTick == nil {
		s.ticker = time.NewTicker(opts.interval)
		s.statsTick = s.ticker.C
	}
	if opts.m != nil {
		s.startAccepted = opts.m.sharesAccepted.Value()
		s.startRejected = opts.m.sharesRejected.Value()
	}
	limiterCtx, stopLimiter := context.WithCancel(ctx)
	s.stopLimit = stopLimiter
	s.submits = newSubmitLimiter(limiterCtx)
	return s
}

// finish releases the session's resources in the original defer order:
// the submit limiter's context, the in-flight gauge, and the stats
// ticker (when the session owns one).
func (s *v2Session) finish() {
	s.stopLimit()
	// Zero the in-flight gauge on every exit — including the yield-failover
	// return — so a following (possibly V1) session doesn't inherit a stale
	// pending depth.
	if s.opts.m != nil {
		s.opts.m.sharesSubmitInFlight.Set(0)
	}
	if s.ticker != nil {
		s.ticker.Stop()
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

// run is the session's event loop: it returns when the session ends —
// the error is what ended it.
func (s *v2Session) run(inCh <-chan poolMsg) error {
	for {
		select {
		case <-s.ctx.Done():
			return s.ctx.Err()

		case <-s.statsTick:
			if done, err := s.onStatsTick(); done {
				return err
			}

		case pm, ok := <-inCh:
			if !ok {
				return fmt.Errorf("engine: pool closed connection")
			}
			if done, err := s.onPoolMsg(&pm); done {
				return err
			}

		case share, ok := <-s.opts.merged:
			if done, err := s.onShare(&share, ok); done {
				return err
			}
		}
	}
}

// onStatsTick publishes one round of session statistics. done reports
// that the session must end (yield failover), with err as its cause.
func (s *v2Session) onStatsTick() (done bool, err error) {
	opts := s.opts
	currentHashRate, stalled := s.tickSnapshot()
	if opts.m != nil {
		if s.publishTickMetrics(currentHashRate, stalled) {
			return true, errYieldDegraded
		}
	}
	if p95 := s.latency.Quantile(0.95); p95 > 0 {
		opts.log("info", fmt.Sprintf(
			"engine: submit latency p50=%.0fms p95=%.0fms p99=%.0fms",
			s.latency.Quantile(0.50), p95, s.latency.Quantile(0.99),
		))
		publishLatencyGauges(opts.m, s.latency)
	}
	return false, nil
}

// publishTickMetrics updates the hashrate / yield / difficulty gauges
// for one stats tick and runs the starvation warnings. It reports
// whether the session's share acceptance fell below the yield floor
// (the caller then ends the session with errYieldDegraded). Callers
// must guarantee opts.m is non-nil.
func (s *v2Session) publishTickMetrics(currentHashRate float64, stalled bool) (failover bool) {
	opts := s.opts
	opts.m.hashrate.Set(currentHashRate)
	s.uptime.observe(time.Now(), currentHashRate > 0 && !stalled, opts.m.productiveSeconds)
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
	// Yield failover: a pool crediting under ~90% of this session's
	// shares burns hashpower without revenue; exit so the reconnect
	// loop fails over to the next configured pool.
	if opts.yieldFailover {
		sessAccepted := opts.m.sharesAccepted.Value() - s.startAccepted
		sessRejected := opts.m.sharesRejected.Value() - s.startRejected
		if yieldDegraded(sessAccepted, sessRejected) {
			opts.log("warn", fmt.Sprintf(
				"engine: session share acceptance %.1f%% — failing over to a different pool",
				acceptanceRate(sessAccepted, sessRejected)*100))
			return true
		}
	}
	opts.m.sharesSubmitInFlight.Set(float64(len(s.submitTimes)))
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
	publishDifficulty(opts.m, miner.DifficultyFromTarget(s.shareTarget), currentHashRate)
	s.warnStarvation()
	return false
}

// warnStarvation runs the two once-per-episode starvation tripwires:
// a pool-assigned difficulty whose expected share interval exceeds an
// hour, and a pool that stops sending jobs.
func (s *v2Session) warnStarvation() {
	opts := s.opts
	if iv := opts.m.estimatedShareIntervalSeconds.Value(); iv > 3600 {
		if !s.starvedWarned {
			s.starvedWarned = true
			opts.log("warn", fmt.Sprintf(
				"engine: pool difficulty implies ~%.0f min between shares — income is effectively zero; the pool should lower difficulty or retarget",
				iv/60))
		}
	} else if iv > 0 {
		// A measured interval back under the threshold ends
		// the episode. iv == 0 is not a measurement:
		// publishDifficulty zeroes the gauge whenever this
		// tick's hashrate sample is 0 (the window's priming
		// sample, or an interval with no new hashes), which
		// says nothing about the pool's difficulty — letting
		// it clear the latch re-armed the warning inside the
		// same episode (the StarvationWarnsOnce flake).
		s.starvedWarned = false
	}
	// A pool that stops sending jobs starves the same way but
	// silently: warn once per episode until jobs resume.
	if quiet := time.Since(s.lastJobAt); !opts.isCurtailed() && quiet > jobStallWarnAfter {
		if !s.jobStarvedWarned {
			s.jobStarvedWarned = true
			opts.log("warn", fmt.Sprintf(
				"engine: no new job from pool in %v — hashing continues on stale work; the pool may be starving this connection",
				quiet.Truncate(time.Second)))
		}
	} else {
		s.jobStarvedWarned = false
	}
}

// onPoolMsg dispatches one decoded pool frame to its handler. done
// reports that the session must end, with err as its cause.
func (s *v2Session) onPoolMsg(pm *poolMsg) (done bool, err error) {
	opts := s.opts
	if pm.err != nil {
		return true, fmt.Errorf("engine: pool read: %w", pm.err)
	}
	if s.foreignChannelFrame(&pm.msg) {
		return false, nil
	}
	if pm.msg.Unknown != nil {
		// Forward-compat drop is deliberate — but log once per
		// type so an operator can see which extension or
		// direction-invalid directive the pool is speaking that we
		// do not implement (e.g. Reconnect, deliberately never
		// honored since we never dial pool-provided endpoints).
		if !s.seenUnknown[pm.msg.Unknown.MsgType] {
			s.seenUnknown[pm.msg.Unknown.MsgType] = true
			opts.log("warn", fmt.Sprintf("engine: ignoring unrecognized SV2 msg_type 0x%02X (%d bytes)", pm.msg.Unknown.MsgType, len(pm.msg.Unknown.Payload)))
		}
		return false, nil
	}
	// Handshake-phase and client→server types decoded
	// mid-session are protocol violations: the setup/open
	// sequence completed before this loop ran and
	// SubmitSharesStandard is ours. They carry no channel_id,
	// so the foreign-channel guard above passes them through;
	// warn once per type like the unrecognized arm, then drop.
	if mt, bad := misplacedMsgType(&pm.msg); bad {
		if !s.seenMisplaced[mt] {
			s.seenMisplaced[mt] = true
			opts.log("warn", fmt.Sprintf("engine: ignoring out-of-place SV2 msg_type 0x%02X mid-session", mt))
		}
		return false, nil
	}
	if pm.msg.NewMiningJob != nil {
		s.onJobFrame(pm.msg.NewMiningJob)
	}
	if pm.msg.SetNewPrevHash != nil {
		s.onPrevHash(pm.msg.SetNewPrevHash)
	}
	if pm.msg.SetTarget != nil {
		s.onSetTarget(pm.msg.SetTarget)
	}
	if pm.msg.SubmitSharesSuccess != nil {
		s.onSubmitSuccess(pm.msg.SubmitSharesSuccess)
	}
	if pm.msg.SubmitSharesError != nil {
		s.onSubmitError(pm.msg.SubmitSharesError)
	}
	if pm.msg.CloseChannel != nil {
		cc := pm.msg.CloseChannel
		// SV2 §5.3.9: the pool has ended this channel — without it
		// a single-channel client has no jobs, no accepts, and no
		// reason to keep the session alive. Surface it the same
		// way as a connection close so the failover loop can take
		// over instead of grinding a dead channel until the
		// job-stall warning fires.
		return true, fmt.Errorf("engine: pool closed channel %d (%s)",
			cc.ChannelID, poolproto.SanitizePoolText(cc.Reason))
	}
	return false, nil
}

// foreignChannelFrame reports whether a frame is addressed to a
// channel other than ours and must be dropped (logging the drop).
func (s *v2Session) foreignChannelFrame(msg *stratum.Message) bool {
	// Channel-scoped frames must name our channel. A frame
	// addressed to a different channel would corrupt job,
	// prev-hash, or share-target state. SetNewPrevHash is
	// exempt: SV2 lets the pool address it to the group
	// channel our standard channel belongs to.
	if cid, ok := channelIDOf(msg); ok && cid != s.chanID && msg.SetNewPrevHash == nil {
		// A CloseChannel addressed to our group closes every
		// member channel (SV2 §5.3.9) — let it through so the
		// teardown arm below can end the session.
		if msg.CloseChannel == nil || cid != s.groupID {
			s.opts.log("warn", fmt.Sprintf("engine: frame for foreign channel %d ignored (channel %d)", cid, s.chanID))
			return true
		}
	}
	return false
}

// onJobFrame stores one NewMiningJob and activates it when it is
// valid for the current chain tip.
func (s *v2Session) onJobFrame(j *stratum.NewMiningJob) {
	opts := s.opts
	s.lastJobAt = time.Now()
	prevLen := len(s.jobs)
	s.jobOrder = storeBoundedJob(s.jobs, s.jobOrder, j)
	if len(s.jobs) < prevLen {
		opts.log("debug", fmt.Sprintf("engine: evicted oldest pending job (cap %d)", jobsCap))
	}
	switch {
	case j.HasNtimeStart && s.havePrev:
		// Job for the current chain tip: mine it now. Its own
		// ntime_start supersedes the tip's (it is never older).
		s.startJob(j, j.NtimeStart)
	case !j.HasNtimeStart:
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

// onPrevHash applies a new chain tip: every job except the one it
// names is invalidated, and the named job (if known) starts.
func (s *v2Session) onPrevHash(p *stratum.SetNewPrevHash) {
	opts := s.opts
	s.prevHash = p.PrevHash
	s.prevNBits = p.NBits
	s.havePrev = true
	// The new tip invalidates every job except the one it names.
	named := s.jobs[p.JobID]
	s.jobs = map[uint32]*stratum.NewMiningJob{}
	s.jobOrder = s.jobOrder[:0]
	if named != nil {
		s.jobs[p.JobID] = named
		s.jobOrder = append(s.jobOrder, p.JobID)
		ntime := p.NtimeStart
		if named.HasNtimeStart && named.NtimeStart > ntime {
			ntime = named.NtimeStart
		}
		s.startJob(named, ntime)
		opts.log("info", fmt.Sprintf("engine: new prev-hash, job %d nBits=0x%08X",
			p.JobID, p.NBits))
	} else {
		// Tip references a job we never received — stop hashing
		// the stale job rather than mining a wrong header.
		s.active = nil
		for _, w := range opts.workers {
			w.SetWork(nil)
		}
		opts.log("warn", fmt.Sprintf("engine: SetNewPrevHash names unknown job %d; pausing until next job", p.JobID))
	}
}

// onSetTarget applies a pool-assigned share-target update, re-issuing
// the active job so workers compare against the new target immediately.
func (s *v2Session) onSetTarget(t *stratum.SetTarget) {
	s.shareTarget = miner.Hash(t.Target)
	if s.active != nil && s.havePrev {
		// Re-issue the current job so workers compare against
		// the new share target immediately.
		s.startJob(s.active, s.activeNTime)
	}
	s.opts.log("info", "engine: share target updated by pool")
}

// onSubmitSuccess settles every outstanding submit the pool's
// batched acknowledgement covers and credits the accepted count.
func (s *v2Session) onSubmitSuccess(ss *stratum.SubmitSharesSuccess) {
	opts := s.opts
	last := ss.LastSequenceNumber
	if last > s.seqNum {
		// The pool acknowledged a share we never sent — a
		// bogus or misrouted frame. Crediting it would inflate
		// sharesAccepted and drain submitTimes for shares that
		// were never acknowledged, skewing acceptance rate and
		// latency the same way a forged reject skews them
		// downward. Drop it like the SubmitSharesError check.
		opts.log("debug", fmt.Sprintf(
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
			// Full nanosecond precision: truncating to
			// whole microseconds first records a literal
			// 0 sample for a sub-microsecond settle, and
			// an all-zero tracker publishes nothing (see
			// LatencyTracker.Record).
			s.latency.Record(float64(now.Sub(sent)) / float64(time.Millisecond))
			delete(s.submitTimes, seq)
			settled++
			delete(s.submitTargets, seq)
		}
	}
	// Publish now, not only on the next stats tick: a
	// sample has landed, and the tick's scheduling is
	// not guaranteed (see publishLatencyGauges).
	publishLatencyGauges(opts.m, s.latency)
	n := uint64(ss.NewSubmitsAccepted)
	if n == 0 || n > settled {
		// Pool sent no explicit count, or claims more
		// accepts than submits it settled; locally observed
		// settlements are both the floor and the ceiling —
		// never credit shares that were never sent.
		n = settled
	}
	opts.log("info", fmt.Sprintf("engine: share accepted (+%d)", n))
	if opts.m != nil {
		if n > 0 {
			opts.m.sharesAccepted.Add(n)
		}
		// Re-sync the in-flight gauge: it is refreshed at
		// send time, and without this it keeps showing the
		// pre-settle depth until the next submit arrives.
		opts.m.sharesSubmitInFlight.Set(float64(len(s.submitTimes)))
	}
}

// onSubmitError settles one rejected submit and records the verdict,
// dropping bogus or replayed rejects (a hostile pool must not be able
// to inflate the reject rate with fabricated frames).
func (s *v2Session) onSubmitError(e *stratum.SubmitSharesError) {
	opts := s.opts
	if e.SequenceNumber > s.seqNum {
		// The pool rejected a submit that never happened —
		// SV2 assigns one response per SequenceNumber, so a
		// seq beyond what we sent is unambiguously bogus.
		// A hostile pool could otherwise inflate the reject
		// rate and trip the curtailment gate at will.
		opts.log("debug", fmt.Sprintf(
			"engine: share reject with future seq %d ignored (sent %d)",
			e.SequenceNumber, s.seqNum))
		return
	}
	sent, outstanding := s.submitTimes[e.SequenceNumber]
	if !outstanding {
		// SV2 assigns one response per SequenceNumber, so an
		// error for a seq with no outstanding submit is either
		// a replay (already settled by a Success or an earlier
		// Error), a fabricated mid-range seq, or an entry the
		// submitTimesCap reaper evicted. Counting it would let
		// a hostile pool inflate the reject rate by replaying
		// one error frame; drop it like the future-seq check.
		opts.log("debug", fmt.Sprintf(
			"engine: share reject for already-settled seq %d ignored",
			e.SequenceNumber))
		return
	}
	// Settle the outstanding submit: an error is the share's
	// final response too, and leaving the entry would leak it
	// until some later success.
	s.latency.Record(float64(time.Since(sent)) / float64(time.Millisecond))
	delete(s.submitTimes, e.SequenceNumber)
	publishLatencyGauges(opts.m, s.latency)
	reason := poolproto.SanitizePoolText(e.Error)
	issued, hadTarget := s.submitTargets[e.SequenceNumber]
	delete(s.submitTargets, e.SequenceNumber)
	if opts.m != nil {
		opts.m.sharesSubmitInFlight.Set(float64(len(s.submitTimes)))
	}
	category, diagnosis := rejectClass(reason)
	if hadTarget && transitionReject(category, issued, s.shareTarget) {
		// ESP-Miner #212: the share was ground under a target the
		// pool has since replaced via SetTarget — a retarget
		// artifact, not a real reject. Counted in the per-reason
		// breakdown only, never in the reject-rate counters.
		opts.log("info", fmt.Sprintf(
			"engine: share rejected under superseded share target: %s (excluded from reject rate)",
			reason))
		if opts.m != nil {
			opts.m.rejectReason("difficulty-transition").Inc()
		}
		return
	}
	opts.log("warn", fmt.Sprintf("engine: share rejected: %s (%s)",
		reason, diagnosis))
	if opts.m != nil {
		opts.m.sharesRejected.Inc()
		opts.m.rejectReason(category).Inc()
		opts.m.touchLastReject(category, time.Now().Unix())
	}
}

// onShare submits one found share to the pool. done reports that the
// session must end (the share channel closed, or the submit write
// failed), with err as its cause.
func (s *v2Session) onShare(share *miner.Share, ok bool) (done bool, err error) {
	opts := s.opts
	if !ok {
		return true, s.ctx.Err()
	}
	s.seqNum++
	if opts.m != nil {
		opts.m.sharesFound.Inc()
		opts.m.incSharesFoundForDevice(share.DeviceID)
	}
	// SetNewPrevHash invalidates every job it doesn't name, so a
	// share ground under a superseded job is rejected by the pool
	// before it can even be evaluated — don't submit it. This also
	// covers session start: the merged share channel outlives
	// sessions, so before the first job any share in it is a
	// leftover from the dead session — submitting it under the new
	// channel can only produce reject noise.
	if s.active == nil || share.JobID != s.active.JobID {
		if opts.m != nil {
			opts.m.sharesSubmitDropped.Inc()
		}
		var activeID uint32
		if s.active != nil {
			activeID = s.active.JobID
		}
		opts.log("debug", fmt.Sprintf(
			"engine: share for superseded job %d dropped (active job %d)",
			share.JobID, activeID))
		return false, nil
	}
	if !s.submits.take() {
		if opts.m != nil {
			opts.m.sharesSubmitDropped.Inc()
		}
		opts.log("debug", "engine: share dropped by submit rate cap")
		return false, nil
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
		return true, fmt.Errorf("engine: submit share: %w", err)
	}
	if opts.m != nil {
		opts.m.sharesSubmitted.Inc()
	}
	s.submitTimes[s.seqNum] = time.Now()
	s.submitTargets[s.seqNum] = share.Target
	s.reapSubmitTimes()
	if opts.m != nil {
		opts.m.sharesSubmitInFlight.Set(float64(len(s.submitTimes)))
	}
	opts.log("info", fmt.Sprintf("engine: share seq=%d nonce=0x%08X", s.seqNum, share.Nonce))
	return false, nil
}

// reapSubmitTimes bounds the in-flight submit bookkeeping: when the
// pool is not acknowledging, the oldest half of the entries is dropped
// so the maps stay bounded. Latency for dropped entries is lost, which
// is the honest outcome — it was never measured.
func (s *v2Session) reapSubmitTimes() {
	if len(s.submitTimes) <= submitTimesCap {
		return
	}
	// Pool is not acknowledging; drop the oldest half so the
	// map stays bounded.
	cutoff := s.seqNum - submitTimesCap/2
	for seq := range s.submitTimes {
		if seq < cutoff {
			delete(s.submitTimes, seq)
			delete(s.submitTargets, seq)
		}
	}
}

// runSessionV1 handles one Stratum V1 pool connection via poolproto.DialURL.
// It mirrors the structure of the V2 runSession loop but consumes the
// protocol-agnostic poolproto.Session interface (Jobs() / Submit()) instead
// of the Stratum V2 framing directly.
func runSessionV1(ctx context.Context, opts *sessionOpts) error {
	// "x" is the long-standing convention for "no real password" across V1
	// pools/miners (most accept any value, some require non-empty), so an
	// unconfigured PoolConfig.Password keeps sending it — only a pool
	// operator who explicitly set password: in their config gets that value
	// instead. Previously this was hardcoded to "x" unconditionally, so a
	// configured password silently had no effect (KNOWN_LIMITATIONS.md §10).
	password := cmp.Or(opts.poolPassword, "x")
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
	sess, err := poolproto.DialURL(ctx, opts.poolURL, &creds)
	if err != nil {
		return fmt.Errorf("engine: %w", err)
	}
	defer sess.Close()
	if !strings.HasPrefix(opts.poolURL, "stratum+tls://") {
		// Plaintext V1 carries the Stratum username — the payout address —
		// and every submitted share unencrypted (the same exposure
		// stratumv1/tls.go documents for the previous silent-downgrade bug).
		// V2 warns identically in the v2:// path above.
		opts.log("warn", "engine: plaintext Stratum V1 connection — shares and the payout address traverse in cleartext; prefer stratum+tls:// where the pool supports it")
	}
	opts.log("info", fmt.Sprintf("engine: connected to %s (Stratum V1)", poolproto.StripUserinfo(opts.poolURL)))
	if opts.m != nil {
		opts.m.poolConnectionState.Set(2)
	}
	if opts.onConnected != nil {
		opts.onConnected()
	}

	s := newV1Session(ctx, opts, sess)
	defer s.close()
	return s.run()
}

// v1ChannelID is the Stratum V1 channel ID: V1 is single-channel and 0
// is the conventional value.
const v1ChannelID = uint32(0)

// v1Session holds the mutable state of one Stratum V1 pool session:
// the select loop in run dispatches each channel event to the method
// that handles it.
type v1Session struct {
	ctx  context.Context
	opts *sessionOpts
	sess poolproto.Session

	statsTick <-chan time.Time
	ticker    *time.Ticker // nil when statsTick was injected via sessionOpts
	stopLimit func()

	hashMon     *HashrateMonitor
	hashWindow  hashrateWindow
	uptime      uptimeAccountant
	satsAcc     satsAccountant
	estSats     uint64
	lastDropped uint64
	latency     *LatencyTracker

	// Session-owned share verdicts for yield failover: V1 verdicts land in
	// submit goroutines that can outlive this session, so deltas over the
	// engine-lifetime counters would attribute this pool's late replies to
	// the next pool (or hide its rejects behind old accepts).
	sessAccepted atomic.Uint64
	sessRejected atomic.Uint64

	// Tripwire for a silent pool: jobs stop arriving while the connection
	// stays open. The clock starts at session start — a pool that never
	// sends a first job is equally starved.
	lastJobAt        time.Time
	jobStarvedWarned bool
	// Starvation tripwire: a pool-assigned difficulty so high that the
	// expected share interval exceeds an hour starves income silently —
	// no rejects, no disconnect, just nothing credited. Warn once per
	// episode and re-arm when the interval recovers.
	starvedWarned bool

	// The most recently applied job's ID gates share submission: once a
	// newer notify replaces the work, shares ground under the superseded
	// job arrive back as stale rejects — submitting them only inflates
	// the reject counters.
	currentJobID    uint32
	currentJobIDStr string
	haveJob         bool

	submits *submitLimiter
	notices <-chan string
	diffCh  <-chan float64

	lastJob           poolproto.Job
	appliedDifficulty float64

	payoutScript        []byte
	payoutMissingWarned bool
}

func newV1Session(ctx context.Context, opts *sessionOpts, sess poolproto.Session) *v1Session {
	s := &v1Session{
		ctx:       ctx,
		opts:      opts,
		sess:      sess,
		statsTick: opts.statsTick,
		hashMon:   NewHashrateMonitor(0, 3, opts.log),
		latency:   NewLatencyTracker(256),
		lastJobAt: time.Now(),
	}
	if s.statsTick == nil {
		s.ticker = time.NewTicker(opts.interval)
		s.statsTick = s.ticker.C
	}
	limiterCtx, stopLimiter := context.WithCancel(ctx)
	s.stopLimit = stopLimiter
	s.submits = newSubmitLimiter(limiterCtx)

	// Pools send operator notices via client.show_message (maintenance
	// windows, credential errors, migration hints). Nil channel when the
	// session type has no notices — a nil case channel is never ready.
	if nr, ok := sess.(poolproto.PoolNoticeReceiver); ok {
		s.notices = nr.PoolNotices()
	}

	// V1 pools may retarget mid-job via mining.set_difficulty: without a
	// push, workers keep grinding the old share target until the next
	// notify — every find in that window is a guaranteed stale-target
	// reject. Sessions that can push retargets (DifficultyWatcher)
	// re-issue the current job's work immediately, mirroring the V2
	// SetTarget path. Nil channel when the session cannot push.
	if dw, ok := sess.(poolproto.DifficultyWatcher); ok {
		s.diffCh = dw.DifficultyUpdates()
	}

	// Direct-coinbase schemes (tides/solo) promise the user's locking script
	// verbatim inside every job's coinbase — the only spot where the
	// non-custodial payout path is observable on the wire. A missing script
	// means hashpower pays the pool's wallet, not the user's; warn once per
	// episode rather than silently mining for nothing. V2 carries only a
	// merkle_root, so no equivalent check exists there (the JDP extension,
	// sv2-spec #203, is the protocol answer — tracked in ADR-009).
	if (opts.payoutScheme == "tides" || opts.payoutScheme == "solo") && opts.payoutAddr != "" {
		if script, err := btccrypto.ScriptForAddress(opts.payoutAddr); err == nil {
			s.payoutScript = script
		} else {
			opts.log("warn", fmt.Sprintf(
				"engine: cannot verify %q payouts — configured address %s derives no locking script (%v)",
				opts.payoutScheme, maskAddr(opts.payoutAddr), err))
		}
	}
	return s
}

// close releases the session's ticker (when it owns one) and the submit
// limiter's context, mirroring the defers of the original inline loop.
func (s *v1Session) close() {
	s.stopLimit()
	if s.ticker != nil {
		s.ticker.Stop()
	}
}

// run is the session's event loop: it returns when the session ends —
// the error is what ended it.
func (s *v1Session) run() error {
	for {
		select {
		case <-s.ctx.Done():
			return s.ctx.Err()

		case notice, ok := <-s.notices:
			if !ok {
				s.notices = nil // pool is gone; never ready again
			} else {
				s.opts.log("info", fmt.Sprintf("engine: pool notice: %s", notice))
			}

		case <-s.statsTick:
			if done, err := s.onStatsTick(); done {
				return err
			}

		case job, ok := <-s.sess.Jobs():
			if done, err := s.onJob(&job, ok); done {
				return err
			}

		case d, ok := <-s.diffCh:
			s.onDifficulty(d, ok)

		case share, ok := <-s.opts.merged:
			if done, err := s.onShare(&share, ok); done {
				return err
			}
		}
	}
}

// onStatsTick publishes one round of session statistics. done reports
// that the session must end (yield failover), with err as its cause.
func (s *v1Session) onStatsTick() (done bool, err error) {
	opts := s.opts
	currentHashRate, stalled := s.tickSnapshot()
	if opts.m != nil {
		if s.publishTickMetrics(currentHashRate, stalled) {
			return true, errYieldDegraded
		}
	}
	if p95 := s.latency.Quantile(0.95); p95 > 0 {
		opts.log("info", fmt.Sprintf(
			"engine: submit latency p50=%.0fms p95=%.0fms p99=%.0fms",
			s.latency.Quantile(0.50), p95, s.latency.Quantile(0.99),
		))
		publishLatencyGauges(opts.m, s.latency)
	}
	return false, nil
}

// publishTickMetrics updates the hashrate / yield / difficulty gauges
// for one stats tick and runs the starvation warnings. It reports
// whether the session's share acceptance fell below the yield floor
// (the caller then ends the session with errYieldDegraded). Callers
// must guarantee opts.m is non-nil.
func (s *v1Session) publishTickMetrics(currentHashRate float64, stalled bool) (failover bool) {
	opts := s.opts
	opts.m.hashrate.Set(currentHashRate)
	s.uptime.observe(time.Now(), currentHashRate > 0 && !stalled, opts.m.productiveSeconds)
	opts.m.effectiveYieldSatsPerSec.Set(effectiveYield(
		opts.m.arbitrationExpectedYieldSatsPerSec.Value(),
		float64(opts.m.productiveSeconds.Value()),
		opts.m.uptime.Value(),
	))
	// otedama_up is set by updateLiveness (curtailment-aware).
	if opts.powerWatts > 0 {
		opts.m.powerWatts.Set(opts.powerWatts)
		if currentHashRate > 0 {
			opts.m.joulesPerTerahash.Set(opts.powerWatts * 1e12 / currentHashRate)
		}
	}
	rate, judged := opts.m.updateShareRates()
	if opts.yieldFailover {
		accepted := s.sessAccepted.Load()
		rejected := s.sessRejected.Load()
		if yieldDegraded(accepted, rejected) {
			opts.log("warn", fmt.Sprintf(
				"engine: session share acceptance %.1f%% — failing over to a different pool",
				acceptanceRate(accepted, rejected)*100))
			return true
		}
	}
	if judged >= 20 && rate < 0.97 {
		opts.log("warn", fmt.Sprintf(
			"engine: share acceptance %.1f%% (%d/%d) — check the reject-reason breakdown",
			rate*100, opts.m.sharesAccepted.Value(), judged,
		))
	}
	// Publish pool difficulty and estimated share interval so
	// operators can distinguish "hardware is slow" from "the pool
	// assigned more difficulty than our hashrate can serve".
	publishDifficulty(opts.m, s.sess.SuggestedDifficulty(), currentHashRate)
	s.warnStarvation()
	return false
}

// warnStarvation runs the two once-per-episode starvation tripwires:
// a pool that stops sending jobs, and a pool-assigned difficulty whose
// expected share interval exceeds an hour.
func (s *v1Session) warnStarvation() {
	opts := s.opts
	// A pool that stops sending jobs starves the same way but
	// silently: warn once per episode until jobs resume.
	if quiet := time.Since(s.lastJobAt); !opts.isCurtailed() && quiet > jobStallWarnAfter {
		if !s.jobStarvedWarned {
			s.jobStarvedWarned = true
			opts.log("warn", fmt.Sprintf(
				"engine: no new job from pool in %v — hashing continues on stale work; the pool may be starving this connection",
				quiet.Truncate(time.Second)))
		}
	} else {
		s.jobStarvedWarned = false
	}
	if iv := opts.m.estimatedShareIntervalSeconds.Value(); iv > 3600 {
		if !s.starvedWarned {
			s.starvedWarned = true
			opts.log("warn", fmt.Sprintf(
				"engine: pool difficulty implies ~%.0f min between shares — income is effectively zero; the pool should lower difficulty or retarget",
				iv/60))
		}
	} else if iv > 0 {
		// A measured interval back under the threshold ends
		// the episode. iv == 0 is not a measurement:
		// publishDifficulty zeroes the gauge whenever this
		// tick's hashrate sample is 0 (the window's priming
		// sample, or an interval with no new hashes), which
		// says nothing about the pool's difficulty — letting
		// it clear the latch re-armed the warning inside the
		// same episode (the StarvationWarnsOnce flake).
		s.starvedWarned = false
	}
}

// onJob applies one pool job to the workers. done reports that the
// session must end (the jobs channel closed), with err as its cause.
func (s *v1Session) onJob(job *poolproto.Job, ok bool) (done bool, err error) {
	opts := s.opts
	if !ok {
		// A pool that sent client.reconnect/mining.reconnect may
		// have asked for a pause before we reconnect; honor the
		// (already-clamped) delay. Capped by ReconnectWait itself
		// and cancellable via ctx, so shutdown stays instant.
		if rw, isWaiter := s.sess.(poolproto.ReconnectWaiter); isWaiter {
			if w := rw.ReconnectWait(); w > 0 {
				opts.log("info", fmt.Sprintf("engine: pool requested %s reconnect delay", w))
				select {
				case <-s.ctx.Done():
					return true, s.ctx.Err()
				case <-time.After(w):
				}
			}
		}
		return true, fmt.Errorf("engine: pool closed connection")
	}
	// While curtailed, keep workers idle and ignore the job (see the
	// V2 path for rationale). lastJobReceivedAt still updates because
	// the pool connection remains alive.
	if opts.isCurtailed() {
		opts.log("debug", fmt.Sprintf("engine: V1 job %q ignored (curtailed)", job.JobID))
	} else {
		s.verifyCoinbasePayout(job)
		applied := s.sess.SuggestedDifficulty()
		if err := applyJob(opts.workers, opts.arbPaused, job, v1ChannelID, applied); err != nil {
			opts.log("warn", err.Error())
			return false, nil
		}
		s.lastJob = *job
		s.appliedDifficulty = applied
		s.currentJobID = v1JobWireID(job.JobID)
		s.currentJobIDStr = job.JobID
		s.haveJob = true
		opts.log("info", fmt.Sprintf("engine: V1 job %q nBits=0x%08X", job.JobID, job.NBits))
	}
	if opts.m != nil {
		opts.m.lastJobReceivedAt.Set(float64(time.Now().Unix()))
	}
	s.lastJobAt = time.Now()
	return false, nil
}

// verifyCoinbasePayout checks, for direct-coinbase schemes (tides/solo),
// that the job's coinbase pays the configured address's locking script,
// warning once per episode when it does not (or cannot be parsed).
func (s *v1Session) verifyCoinbasePayout(job *poolproto.Job) {
	opts := s.opts
	if len(s.payoutScript) == 0 || len(job.CoinbaseTx) == 0 {
		return
	}
	pays, cerr := btccrypto.CoinbasePaysScript(job.CoinbaseTx, s.payoutScript)
	switch {
	case cerr != nil:
		if !s.payoutMissingWarned {
			s.payoutMissingWarned = true
			opts.log("warn", fmt.Sprintf(
				"engine: pool's coinbase is malformed (%v) — cannot verify %q payouts",
				cerr, opts.payoutScheme))
		}
	case !pays:
		if !s.payoutMissingWarned {
			s.payoutMissingWarned = true
			opts.log("warn", fmt.Sprintf(
				"engine: pool's coinbase does not pay to %s — payout_scheme %q promises direct coinbase payouts; your shares may fund the pool's wallet, not yours",
				maskAddr(opts.payoutAddr), opts.payoutScheme))
		}
	default:
		s.payoutMissingWarned = false
	}
}

// onDifficulty re-issues the current job's work after a mid-job
// difficulty retarget pushed by the pool.
func (s *v1Session) onDifficulty(d float64, ok bool) {
	opts := s.opts
	if !ok {
		s.diffCh = nil // session ended; never ready again
		return
	}
	// Pool retargeted mid-job: re-issue the current job's work so
	// workers compare against the new share target immediately
	// instead of grinding the superseded one until the next
	// notify (finds in that window are wasted work). Paused and
	// curtailed workers are skipped by applyJob as usual.
	if !s.haveJob || opts.isCurtailed() || d == s.appliedDifficulty {
		return
	}
	s.appliedDifficulty = d
	if err := applyJob(opts.workers, opts.arbPaused, &s.lastJob, v1ChannelID, d); err != nil {
		opts.log("warn", err.Error())
		return
	}
	opts.log("info", fmt.Sprintf("engine: V1 pool retargeted to difficulty %.6g — workers retargeted", d))
}

// onShare submits one found share to the pool (in a goroutine: V1
// Submit is synchronous and a slow pool must not block the job path).
// done reports that the session must end (the share channel closed).
func (s *v1Session) onShare(share *miner.Share, ok bool) (done bool, err error) {
	opts := s.opts
	if !ok {
		return true, s.ctx.Err()
	}
	if opts.m != nil {
		opts.m.sharesFound.Inc()
		opts.m.incSharesFoundForDevice(share.DeviceID)
	}
	// Same cross-session rule as the V2 path: before the first
	// notify, haveJob is false and any share in the merged channel
	// is a leftover from the dead session — drop it rather than
	// submit it under the new session's job IDs.
	if !s.haveJob || share.JobID != s.currentJobID {
		if opts.m != nil {
			opts.m.sharesSubmitDropped.Inc()
		}
		opts.log("debug", fmt.Sprintf(
			"engine: share for superseded V1 job %d dropped (current job %d)",
			share.JobID, s.currentJobID))
		return false, nil
	}
	// V1 Submit is synchronous. Run it in a goroutine so a slow
	// pool response doesn't block the job-receive path.
	if !s.submits.take() {
		if opts.m != nil {
			opts.m.sharesSubmitDropped.Inc()
		}
		opts.log("debug", "engine: share dropped by submit rate cap")
		return false, nil
	}
	jobIDStr := s.currentJobIDStr
	if opts.m != nil {
		// Counted here, not after Submit returns: "submitted" means
		// the transmission was attempted, matching the V2 path's
		// increment at send time rather than at response time — a
		// slow or failing pool response is a distinct, separately
		// tracked event (sharesAccepted/sharesRejected, or the "V1
		// submit" warning log on a hard failure).
		opts.m.sharesSubmitted.Inc()
	}
	go s.submitShare(share, jobIDStr)
	return false, nil
}

// submitShare performs one V1 share submission and settles its verdict
// (latency, accept/reject accounting). It runs in its own goroutine.
func (s *v1Session) submitShare(capturedShare *miner.Share, capturedJobID string) {
	opts := s.opts
	sendTime := time.Now()
	result, err := s.sess.Submit(s.ctx, poolproto.ShareSubmission{
		JobID:      capturedJobID,
		Nonce:      capturedShare.Nonce,
		NTime:      capturedShare.NTime,
		ExtraNonce: capturedShare.ExtraNonce,
	})
	// Full nanosecond precision, matching the V2 path:
	// truncating to whole milliseconds (or even whole
	// microseconds) records a literal 0 sample for any
	// round trip below the truncation grain, and a tracker
	// holding only zeros yields a 0 quantile — the latency
	// gauges would never publish for a fast pool.
	elapsed := float64(time.Since(sendTime)) / float64(time.Millisecond)
	if err != nil {
		opts.log("warn", fmt.Sprintf("engine: V1 submit: %v", err))
		// Still record the latency on error: a p99 spike caused by
		// a pool disconnect is a signal worth surfacing, not hiding.
		s.latency.Record(elapsed)
		publishLatencyGauges(opts.m, s.latency)
		return
	}
	// A reject is a final response too — settle latency for
	// accept and reject alike (the V2 path does the same for
	// SubmitSharesError), or slow pools that answer only with
	// rejects would skew the percentiles flattering.
	s.latency.Record(elapsed)
	publishLatencyGauges(opts.m, s.latency)
	if result.Accepted {
		opts.log("info", "engine: V1 share accepted")
		s.sessAccepted.Add(1)
		if opts.m != nil {
			opts.m.sharesAccepted.Inc()
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
		transitionReject(category, capturedShare.Target, current) {
		opts.log("info", fmt.Sprintf(
			"engine: V1 share rejected under superseded difficulty epoch: %s (excluded from reject rate)",
			reason))
		if opts.m != nil {
			opts.m.rejectReason("difficulty-transition").Inc()
		}
		return
	}
	opts.log("warn", fmt.Sprintf("engine: V1 share rejected: %s (%s)",
		reason, diagnosis))
	s.sessRejected.Add(1)
	if opts.m != nil {
		opts.m.sharesRejected.Inc()
		opts.m.rejectReason(category).Inc()
		opts.m.touchLastReject(category, time.Now().Unix())
	}
}

// tickSnapshot computes the per-tick values the V2 session loop
// publishes: the current hashrate differentiated from the cumulative
// counter, the stall state, and the updated estimated-earnings figure
// (also pushed to the dashboard when one is wired).
func (s *v2Session) tickSnapshot() (currentHashRate float64, stalled bool) {
	currentHashRate = s.hashWindow.observe(totalHashes(s.opts.workers), time.Now())
	logStats(s.opts.workers, currentHashRate, s.opts.log)
	s.lastDropped = accountDroppedShares(s.opts, s.lastDropped)
	stalled = s.opts.updateLiveness(s.hashMon, currentHashRate)
	s.estSats = accumulateEstSats(s.opts, &s.satsAcc, currentHashRate, stalled)
	if s.opts.dashboard != nil {
		s.opts.dashboard.Update(buildStats(s.opts, currentHashRate, s.estSats, s.latency, stalled))
	}
	return currentHashRate, stalled
}

// tickSnapshot is the V1 counterpart of v2Session.tickSnapshot; both
// session loops publish the same per-tick snapshot.
func (s *v1Session) tickSnapshot() (currentHashRate float64, stalled bool) {
	currentHashRate = s.hashWindow.observe(totalHashes(s.opts.workers), time.Now())
	logStats(s.opts.workers, currentHashRate, s.opts.log)
	s.lastDropped = accountDroppedShares(s.opts, s.lastDropped)
	stalled = s.opts.updateLiveness(s.hashMon, currentHashRate)
	s.estSats = accumulateEstSats(s.opts, &s.satsAcc, currentHashRate, stalled)
	if s.opts.dashboard != nil {
		s.opts.dashboard.Update(buildStats(s.opts, currentHashRate, s.estSats, s.latency, stalled))
	}
	return currentHashRate, stalled
}

// accumulateEstSats integrates the arbitration expected-yield rate
// over productive time into the running estimated-earnings figure.
// The productive flag gates out idle/stalled time so downtime never
// accrues phantom earnings; the rate is 0 when metrics are disabled
// or no quote has arrived yet.
func accumulateEstSats(opts *sessionOpts, satsAcc *satsAccountant, currentHashRate float64, stalled bool) uint64 {
	var expectedYieldRate float64
	if opts.m != nil {
		expectedYieldRate = opts.m.arbitrationExpectedYieldSatsPerSec.Value()
	}
	return uint64(satsAcc.observe(time.Now(), expectedYieldRate, currentHashRate > 0 && !stalled))
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

func handshake(conn net.Conn, dec *stratum.Decoder, poolURL, user string, workers []*miner.Worker, nominalHashrate float64) (uint32, uint32, miner.Hash, error) {
	host, _ := parseHost(poolURL)
	// Bound the entire handshake: a peer that accepts the connection but
	// never answers SetupConnection would otherwise hold the failover
	// loop forever. The deadline is cleared before returning so the
	// session's steady-state reads are unbounded.
	_ = conn.SetDeadline(time.Now().Add(handshakeTimeout))
	defer func() { _ = conn.SetDeadline(time.Time{}) }()
	if err := exchangeSetupConnection(conn, dec, host); err != nil {
		return 0, 0, miner.Hash{}, err
	}
	return openMiningChannel(conn, dec, user, workers, nominalHashrate)
}

// exchangeSetupConnection sends the SV2 SetupConnection frame and
// validates the pool's response: the exchange must succeed, the
// negotiated version must stay inside the declared range, and the pool
// must not require flags outside the offered set.
func exchangeSetupConnection(conn net.Conn, dec *stratum.Decoder, host string) error {
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
		return err
	}
	f, err := dec.ReadFrame()
	if err != nil {
		return fmt.Errorf("engine: setup response: %w", err)
	}
	msg, err := stratum.DispatchFrame(f)
	if err != nil {
		return err
	}
	if msg.SetupConnectionError != nil {
		return &fatalError{fmt.Sprintf("pool rejected: %q", msg.SetupConnectionError.Error)}
	}
	if msg.SetupConnectionSuccess == nil {
		return fmt.Errorf("engine: unexpected msg 0x%02X during setup", f.Header.MsgType)
	}
	if v := msg.SetupConnectionSuccess.UsedVersion; v < sc.MinVersion || v > sc.MaxVersion {
		return fmt.Errorf("engine: pool negotiated version %d outside declared range [%d, %d]", v, sc.MinVersion, sc.MaxVersion)
	}
	// SetupConnectionSuccess.flags is the subset of offered flags the server
	// requires. We offer none, so any nonzero value is unhonorable — fail
	// closed rather than silently proceed (sv2-apps #695 class).
	if msg.SetupConnectionSuccess.Flags&^sc.Flags != 0 {
		return fmt.Errorf("engine: pool requires flags 0x%08x outside offered set 0x%08x",
			msg.SetupConnectionSuccess.Flags, sc.Flags)
	}
	return nil
}

// openMiningChannel sends the OpenMiningChannel request (declaring the
// workers' live hashrate, or the nominal estimate while it is still
// zero) and validates the pool's response, returning the opened channel
// ID, group channel ID, and the pool-assigned share target.
func openMiningChannel(conn net.Conn, dec *stratum.Decoder, user string, workers []*miner.Worker, nominalHashrate float64) (uint32, uint32, miner.Hash, error) {
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
		MaxTarget:       stratum.MaxTargetUnconstrained,
	}
	if err := sendMsg(conn, stratum.MsgOpenMiningChannel, false, &omc); err != nil {
		return 0, 0, miner.Hash{}, err
	}
	f, err := dec.ReadFrame()
	if err != nil {
		return 0, 0, miner.Hash{}, fmt.Errorf("engine: channel response: %w", err)
	}
	msg, err := stratum.DispatchFrame(f)
	if err != nil {
		return 0, 0, miner.Hash{}, err
	}
	if msg.OpenMiningChannelError != nil {
		return 0, 0, miner.Hash{}, &fatalError{fmt.Sprintf("pool rejected channel open: %q", msg.OpenMiningChannelError.Error)}
	}
	if msg.OpenMiningChannelSuccess == nil {
		return 0, 0, miner.Hash{}, fmt.Errorf("engine: channel open failed")
	}
	if msg.OpenMiningChannelSuccess.ReqID != omc.ReqID {
		return 0, 0, miner.Hash{}, fmt.Errorf("engine: channel response echoes req_id %d, sent %d",
			msg.OpenMiningChannelSuccess.ReqID, omc.ReqID)
	}
	omcs := msg.OpenMiningChannelSuccess
	// SV2 target and miner.Hash are both little-endian U256s, so the bytes
	// map directly.
	return omcs.ChannelID, omcs.GroupChannelID, miner.Hash(omcs.Target), nil
}

// ----- Shared helpers -----

// channelIDOf reports the channel_id carried by a channel-scoped SV2
// message. ok is false for frames with no channel field (unknown or
// connection-scoped types), which callers should let through.
func channelIDOf(m *stratum.Message) (uint32, bool) {
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
	case m.CloseChannel != nil:
		return m.CloseChannel.ChannelID, true
	}
	return 0, false
}

// misplacedMsgType reports the wire msg_type of a decoded message that
// is inapplicable in the steady-state loop: handshake-phase types
// (SetupConnection and both channel-open responses — the setup/open
// sequence finished before this loop ran) and SubmitSharesStandard,
// which only the client may send.
func misplacedMsgType(m *stratum.Message) (uint8, bool) {
	switch {
	case m.SetupConnection != nil:
		return stratum.MsgSetupConnection, true
	case m.SetupConnectionSuccess != nil:
		return stratum.MsgSetupConnectionSuccess, true
	case m.SetupConnectionError != nil:
		return stratum.MsgSetupConnectionError, true
	case m.OpenMiningChannel != nil:
		return stratum.MsgOpenMiningChannel, true
	case m.OpenMiningChannelSuccess != nil:
		return stratum.MsgOpenMiningChannelSuccess, true
	case m.OpenMiningChannelError != nil:
		return stratum.MsgOpenMiningChannelError, true
	case m.SubmitSharesStandard != nil:
		return stratum.MsgSubmitSharesStandard, true
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
// falls back to the nBits target, matching pre-wiring behavior. A positive
// difficulty that fails conversion (astronomical values underflow the
// target to zero; sub-~1e-77 values overflow 256 bits) is an error, not
// an nBits fallback: silently grinding the block target when the pool
// declared an unconvertible share difficulty burns hashrate on shares the
// pool never credits, with nothing in the metrics showing why.
// Extracted as a pure function so the target-selection logic is
// unit-testable without a running Worker.
func v1JobTarget(nBits uint32, difficulty float64) (miner.Hash, error) {
	target, err := miner.TargetFromNBits(nBits)
	if err != nil {
		return miner.Hash{}, err
	}
	if difficulty > 0 {
		dt, derr := miner.TargetFromDifficulty(difficulty)
		if derr != nil {
			return miner.Hash{}, fmt.Errorf("miner: pool difficulty %v unusable: %w", difficulty, derr)
		}
		target = dt
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
// (docs/KNOWN_LIMITATIONS.md §3). The job's opaque string ID is mapped
// to the uint32 the miner uses internally via v1JobWireID — V1 job_id is
// an arbitrary string echoed verbatim at submit time, so the wire never
// sees this derived value.
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
	w := &miner.Work{
		JobID:     v1JobWireID(job.JobID),
		ChannelID: chanID,
		Header: miner.Header{
			Version:    job.Version,
			PrevHash:   job.PrevHash,
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

// v1JobWireID derives the internal uint32 job identifier from a V1
// pool's opaque job_id. Bare decimals keep their numeric value (the
// common pool convention); anything else — hex, UUIDs, mixed strings
// like "1a" — is hashed. The value is only ever compared for equality
// by the stale-share gate; the pool always gets its original string
// echoed back verbatim at submit time. strconv.ParseUint (not Sscanf)
// so "1a" cannot silently truncate to job 1 and collide with a real
// job 1 — previously that produced wrong-ID echoes and all-rejects.
func v1JobWireID(jobID string) uint32 {
	if n, err := strconv.ParseUint(jobID, 10, 32); err == nil {
		return uint32(n) //nolint:gosec // bounded by ParseUint bitSize 32
	}
	h := fnv.New32a()
	h.Write([]byte(jobID)) //nolint:errcheck // hash.Hash Write never fails
	return h.Sum32()
}

// rollNTime rolls a stale pool-declared ntime forward to the local wall
// clock. SRI 1.12.0 tightened share validation to enforce ntime_start/nTime
// bounds on every channel type: a share stamped with the job's original
// (aging) ntime lands outside the pool's acceptance window once the job
// has been grinding for a while — a guaranteed reject that burns
// hashrate for nothing. Rolling ntime forward is standard miner
// behavior (it is part of the effective nonce space); a future ntime
// is kept verbatim since undershooting ntime_start is itself a reject.
func rollNTime(declared uint32) uint32 {
	// #nosec G115 -- ntime is a u32 wire field per SV2 spec; wraps at 2106
	if now := uint32(time.Now().Unix()); declared < now { //nolint:gosec // ntime is a u32 wire field per SV2 spec; wraps at 2106
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
