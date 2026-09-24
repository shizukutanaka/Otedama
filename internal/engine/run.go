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
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"hash/fnv"
	"io"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shizukutanaka/Otedama/internal/arbitration"
	"github.com/shizukutanaka/Otedama/internal/clock"
	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/shizukutanaka/Otedama/internal/hal"
	"github.com/shizukutanaka/Otedama/internal/logger"
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

	// Input, when connected to an interactive terminal, enables the
	// first-run recovery-phrase backup check: after the mnemonic is
	// printed the operator is asked to re-enter a few of its words. A
	// nil reader or a non-terminal reader (pipe, /dev/null, service
	// manager) skips the check silently — unattended runs never block.
	Input io.Reader

	// NoBackupCheck disables the interactive first-run backup check even
	// when Input is a terminal (scripted interactive runs, CI demos).
	NoBackupCheck bool

	// Metrics, if set, receives runtime metrics (hashrate, shares, pool
	// latency, arbitration switches). Nil disables metrics emission.
	Metrics *metrics.Registry

	// NoPoolShareCheck disables the one-shot pool network-hashrate-share
	// lookup (mempool.space) performed when a pool session connects. When
	// the configured pool's weekly block-share meets
	// rates.PoolShareWarnThreshold the engine warns once — large-pool
	// concentration enables detection-resistant selfish mining
	// (THREAT_MODEL, Bahrani & Weinberg). Set true to keep Otedama from
	// disclosing the configured pool's hostname to the lookup endpoint.
	NoPoolShareCheck bool

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

// curtailAboveDecision is the mirrored gate for above-threshold signals
// (carbon intensity): identical hold-on-untrusted semantics, opposite
// comparator. A threshold of 0 disables.
func curtailAboveDecision(curr bool, value float64, fresh bool, threshold float64) (next, changed bool) {
	if threshold <= 0 || !fresh || value <= 0 {
		return curr, false
	}
	switch {
	case value > threshold && !curr:
		return true, true // signal rose above threshold → pause
	case value <= threshold && curr:
		return false, true // signal recovered → resume
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
	// Sanitize at the outermost wrap point: pool-controlled text reaches
	// log lines not only through session logging (traceLog already does
	// this) but also through session errors — sessionErr carries pool
	// error strings (authorize rejections, OpenMiningChannelError
	// ReasonCode) into the reconnect/failover lines at r.log, which
	// never passes through traceLog. Sanitizing here covers both paths;
	// the per-line fast path makes the double-application inside
	// traceLog a no-op.
	base := log
	log = func(level, msg string) { base(level, sanitizeLogText(msg)) }
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
	workers, merged, err := startMinerWorkers(ctx, devices, int(opts.Config.WorkerThreads), log)
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
	// paused by any curtailment gate. Three independent gates feed it: the
	// price threshold (curtail_below_btc_usd), the thermal throttle
	// (thermal_throttle_above_celsius), and the UK carbon intensity
	// (curtail_above_uk_carbon). Each gate keeps its own atomic;
	// applyCurtail folds them into the combined gate the session loop
	// consults before applying any pool job — without this shared gate
	// the next mining.notify (~30–60 s) would silently re-arm the idled
	// workers while otedama_curtailed still read 1, so the pause neither
	// held nor matched the metric.
	priceGate := new(atomic.Bool)
	thermalGate := new(atomic.Bool)
	curtailGate := new(atomic.Bool)
	carbonGate := new(atomic.Bool)
	tariffGate := new(atomic.Bool)

	// setCurtailedMetric keeps otedama_curtailed honest under two gates:
	// it is 1 while EITHER gate is raised, so a price-recovery uncurtail
	// cannot falsely report 0 while the carbon gate still pauses hashing.
	setCurtailedMetric := func() {
		if curtailGate.Load() || carbonGate.Load() || tariffGate.Load() {
			m.curtailed.Set(1)
		} else {
			m.curtailed.Set(0)
		}
	}

	// applyCurtail recomputes the combined gate (OR of all inputs) after
	// any individual gate transition, and performs the shared side
	// effects — idling workers and the otedama_curtailed gauge — only on
	// combined transitions. A gate releasing while another still holds
	// must NOT resume hashing.
	applyCurtail := func() {
		combined := priceGate.Load() || thermalGate.Load() || carbonGate.Load() ||
			tariffGate.Load()
		if curtailGate.Swap(combined) == combined {
			return
		}
		if combined {
			for _, w := range workers {
				w.SetWork(nil)
			}
		}
		if m != nil {
			if combined {
				m.curtailed.Set(1)
			} else {
				m.curtailed.Set(0)
			}
		}
	}

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
				next, changed := curtailDecision(priceGate.Load(), rate, fresh, threshold)
				if !changed {
					continue
				}
				priceGate.Store(next)
				if next {
					log("info", fmt.Sprintf(
						"engine: price gate raised — BTC/USD $%.0f below threshold $%.0f",
						rate, threshold))
				} else {
					log("info", fmt.Sprintf(
						"engine: price gate released — BTC/USD $%.0f recovered above threshold $%.0f",
						rate, threshold))
				}
				applyCurtail()
			}
		}
	}()

	// Thermal poll: publish every hwmon sensor as a labeled gauge and
	// enforce the optional thermal_throttle_above_celsius gate. Sensors
	// are published even with no threshold set (operators get the
	// temperature series for free); the gate only engages when a
	// threshold is configured. A poll with no valid readings leaves the
	// gate untouched — see thermalDecision for the untrusted-input rule.
	go func() {
		thresholdMilli := int64(opts.Config.ThermalThrottleAboveCelsius * 1000)
		poll := func() {
			readings := hal.ReadThermalSensors()
			var maxMilli int64
			for _, r := range readings {
				if m != nil {
					m.setThermalSensor(r.Source, r.Label, float64(r.MilliCelsius)/1000)
				}
				if r.MilliCelsius > maxMilli {
					maxMilli = r.MilliCelsius
				}
			}
			next, changed := thermalDecision(thermalGate.Load(), maxMilli, len(readings) > 0, thresholdMilli)
			if !changed {
				return
			}
			thermalGate.Store(next)
			if next {
				log("warn", fmt.Sprintf(
					"engine: thermal gate raised — hottest sensor %.1f°C at or above throttle threshold %.0f°C",
					float64(maxMilli)/1000, opts.Config.ThermalThrottleAboveCelsius))
			} else {
				log("info", fmt.Sprintf(
					"engine: thermal gate released — hottest sensor %.1f°C cooled below %.0f°C resume margin",
					float64(maxMilli)/1000, opts.Config.ThermalThrottleAboveCelsius-5))
			}
			applyCurtail()
		}
		poll()
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				poll()
			}
		}
	}()

	// Optional Octopus Energy tariff feed (electricity_tariff_octopus =
	// "PRODUCT/TARIFF"). Polls the keyless half-hourly unit-rate API every
	// 15 min — Agile prices settle at 16:00 for the next day and tick on
	// the half hour, so 15 min tracks both transitions promptly — and
	// publishes the current slot's price in pence/kWh on
	// otedama_electricity_tariff_pence_per_kwh. Like the other feeds it
	// acts only on a fresh reading: a failed fetch keeps the last value.
	// The curve itself is not yet consumed by arbitration (ADR-008
	// sub-domain 4 groundwork); the gauge makes the feed observable now.
	if opts.Config.ElectricityTariffOctopus != "" {
		product, tariff, _ := strings.Cut(opts.Config.ElectricityTariffOctopus, "/")
		go func() {
			var last float64
			tick := func() {
				slots, err := rates.FetchAgileRates(ctx, nil, product, tariff,
					opts.Clock.Now().Add(-30*time.Minute), 48)
				if err != nil {
					return
				}
				if lo, hi, ok := rates.AgileCurveBounds(slots); ok {
					m.tariffForwardMinPence.Set(lo)
					m.tariffForwardMaxPence.Set(hi)
				}
				slot, ok := rates.AgileRateAt(slots, opts.Clock.Now())
				if !ok {
					return
				}
				m.electricityTariffPence.Set(slot.ValueIncVATPence)
				if slot.ValueIncVATPence != last {
					last = slot.ValueIncVATPence
					log("info", fmt.Sprintf(
						"engine: electricity tariff %s = %.2f p/kWh (slot %s–%s UTC)",
						opts.Config.ElectricityTariffOctopus, slot.ValueIncVATPence,
						slot.ValidFrom.Format("15:04"), slot.ValidTo.Format("15:04")))
				}
				if opts.Config.CurtailAboveTariffPence > 0 {
					next, changed := curtailAboveDecision(tariffGate.Load(),
						slot.ValueIncVATPence, true, opts.Config.CurtailAboveTariffPence)
					if changed {
						tariffGate.Store(next)
						if next {
							for _, w := range workers {
								w.SetWork(nil)
							}
							log("info", fmt.Sprintf(
								"engine: curtailed — electricity tariff %.2f p/kWh above threshold %.2f; hashing paused",
								slot.ValueIncVATPence, opts.Config.CurtailAboveTariffPence))
						} else {
							log("info", fmt.Sprintf(
								"engine: uncurtailed — electricity tariff %.2f p/kWh recovered; hashing resumes on next job",
								slot.ValueIncVATPence))
						}
						setCurtailedMetric()
					}
				}
			}
			tick()
			t := time.NewTicker(15 * time.Minute)
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-t.C:
					tick()
				}
			}
		}()
	}

	// Optional GB-grid carbon curtailment (curtail_above_uk_carbon): mirror
	// of the price gate. A failed fetch holds the last trusted state — the
	// gate never pauses or resumes on data it could not read. Polls every
	// 10 min so the half-hourly settlement slots are tracked promptly.
	if opts.Config.CurtailAboveUKCarbon > 0 {
		go func() {
			tick := func() {
				ci, err := rates.FetchCarbonIntensity(ctx)
				if err != nil {
					return
				}
				m.carbonIntensity.Set(ci.Forecast)
				next, changed := curtailAboveDecision(carbonGate.Load(),
					ci.Forecast, true, opts.Config.CurtailAboveUKCarbon)
				if !changed {
					return
				}
				carbonGate.Store(next)
				if next {
					for _, w := range workers {
						w.SetWork(nil)
					}
					log("info", fmt.Sprintf(
						"engine: curtailed — UK grid carbon intensity %.0f gCO2/kWh (%s) above threshold %.0f; hashing paused",
						ci.Forecast, ci.Index, opts.Config.CurtailAboveUKCarbon))
				} else {
					log("info", fmt.Sprintf(
						"engine: uncurtailed — UK grid carbon intensity %.0f gCO2/kWh recovered; hashing resumes on next job",
						ci.Forecast))
				}
				setCurtailedMetric()
			}
			tick()
			t := time.NewTicker(10 * time.Minute)
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-t.C:
					tick()
				}
			}
		}()
	}

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
		clk:           opts.Clock,
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
		carbonGate:  carbonGate,
		tariffGate:  tariffGate,
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
	// incoming pool jobs while it is raised. carbonGate is the parallel
	// gate for curtail_above_uk_carbon; tariffGate likewise for
	// curtail_above_tariff_pence.
	curtailGate *atomic.Bool
	carbonGate  *atomic.Bool
	tariffGate  *atomic.Bool
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
			clk:          r.opts.Clock,
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
			carbonGate:   r.carbonGate,
			tariffGate:   r.tariffGate,
			tlsCAFile:    poolTLSCAFile,
			poolPassword: poolPassword,

			noPoolShareCheck: r.opts.NoPoolShareCheck,
			asicManage:       r.opts.Config.ASICManage,
			asicEndpoints:    r.opts.Config.ASICEndpoints,
			activityMu:       r.activityMu,
			activity:         r.activity,
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
		// Full jitter (Brooker, "Exponential Backoff And Jitter"): a
		// deterministic backoff makes every node whose session died in the
		// same pool outage retry in lockstep — sleep is drawn uniformly
		// from [0, backoff] so retries spread across the whole window.
		sleep := jitteredBackoff(backoff)
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
					"backing off %v and retrying from the primary", len(addrs), sleep))
		case len(pools) > 1:
			r.log("warn", fmt.Sprintf("engine: all %d pools failed; backing off %v", len(pools), sleep))
		default:
			r.log("warn", fmt.Sprintf("engine: session ended: %v; reconnecting in %v", sessionErr, sleep))
		}
		// time.NewTimer + explicit Stop rather than time.After: when ctx is
		// canceled (shutdown) the timer is released immediately instead of
		// lingering until backoff (up to reconnectBackoffMax) elapses — the
		// documented time.After-in-select pitfall, since pre-Go-1.23 a pending
		// timer cannot be garbage-collected until it fires.
		timer := time.NewTimer(sleep)
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
	clk        clock.Clock
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
	// carbonGate is the parallel gate raised when the UK grid carbon
	// intensity exceeds curtail_above_uk_carbon; either gate curtails.
	carbonGate *atomic.Bool
	// tariffGate is the parallel gate raised when the Octopus Agile slot
	// price exceeds curtail_above_tariff_pence.
	tariffGate *atomic.Bool
	// diffTags, when non-nil (V1 sessions only), tags each applied job
	// with the share difficulty in force so post-set_difficulty rejects
	// on old-generation shares classify as benign races rather than real
	// rejects (ESP-Miner #212). Set by runSessionV1.
	diffTags *difficultyTagger
	// tlsCAFile is the active pool's optional PEM CA bundle path (PoolConfig
	// .TLSCAFile), used to verify a private-CA/self-signed stratum+tls:// pool.
	tlsCAFile string
	// poolPassword is the active pool's configured password (PoolConfig
	// .Password), sent in the Stratum V1 mining.authorize call. Most V1
	// pools accept any value, but not all — see KNOWN_LIMITATIONS.md §10.
	poolPassword string
	// noPoolShareCheck mirrors Options.NoPoolShareCheck.
	noPoolShareCheck bool
	// asicManage mirrors Config.ASICManage — when set with asicEndpoints,
	// every successful pool connect pushes the pool onto the managed
	// cgminer-compatible miners so the fleet follows Otedama's active
	// endpoint (KNOWN_LIMITATIONS §8's opt-in actuation half).
	asicManage    bool
	asicEndpoints []string
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

// isCurtailed reports whether hashing is currently paused by either
// curtailment gate (curtail_below_btc_usd, curtail_above_uk_carbon, or
// curtail_above_tariff_pence). Safe to call with nil gates.
func (o *sessionOpts) isCurtailed() bool {
	return (o.curtailGate != nil && o.curtailGate.Load()) ||
		(o.carbonGate != nil && o.carbonGate.Load()) ||
		(o.tariffGate != nil && o.tariffGate.Load())
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

	// clk feeds the debounce timestamps so tests can drive them with a
	// fake clock instead of sleeping.
	clk clock.Clock
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

func newSessionTelemetry(log func(string, string), clk clock.Clock) *sessionTelemetry {
	if clk == nil {
		clk = clock.System{}
	}
	return &sessionTelemetry{
		hashMon: NewHashrateMonitor(0, 3, log),
		latency: NewLatencyTracker(256),

		unaccountedMon: newUnaccountedWatchdog(log),

		clk: clk,
	}
}

// observeLatencyHist records one settled share round-trip in the
// seconds-denominated submit-latency histogram, tagging the bucket with
// the share's identity as the OpenMetrics exemplar. The V2 adapter owns
// sequence-number correlation now, so {job_id} is the exemplar key on
// both protocols.
func (t *sessionTelemetry) observeLatencyHist(opts *sessionOpts, ms float64, share miner.Share) {
	if opts.m != nil && opts.m.submitLatencyHist != nil && ms > 0 {
		// JobKey is the pool's verbatim job_id — what an operator greps
		// pool-side logs for. Fall back to the decimal tag for shares
		// constructed without it (V2 numeric ids or tests).
		jobKey := share.JobKey
		if jobKey == "" {
			jobKey = fmt.Sprintf("%d", share.JobID)
		}
		opts.m.submitLatencyHist.ObserveWithExemplar(ms/1000, map[string]string{
			"job_id": jobKey,
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
		delta := dropped - t.lastDropped
		opts.log("warn", fmt.Sprintf(
			"engine: dropped %d found share(s) — share submission is not keeping up with discovery",
			delta))
		if opts.m != nil && opts.m.sharesDropped != nil {
			opts.m.sharesDropped.Add(delta)
		}
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
	now := t.clk.Now()
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

// runSession runs one pool connection: dial, handshake, then stream
// jobs to workers and shares back to the pool until the connection
// drops or ctx is cancelled. Returns the error that ended the session
// (nil if ctx was cancelled cleanly).
//
// Stratum V1 URLs (stratum+tcp://, stratum+tls://) are handled via
// poolproto.DialURL so the protocol abstraction is load-bearing for V1.
// datum:// routes the same way: DATUM gateways speak plain SV1 over TCP
// (KNOWN_LIMITATIONS §14).
func runSession(ctx context.Context, opts sessionOpts) error {
	proto := poolproto.FromURL(opts.poolURL)
	opts.log("info", fmt.Sprintf("engine: transport protocol: %s", proto))
	if proto == poolproto.ProtocolStratumV1 || proto == poolproto.ProtocolStratumV1TLS ||
		proto == poolproto.ProtocolDATUM {
		return runSessionV1(ctx, opts)
	}

	if proto == poolproto.ProtocolStratumV2 || proto == poolproto.ProtocolStratumV2TLS {
		return runSessionV2(ctx, &opts)
	}
	return fmt.Errorf("engine: no dialer for pool URL %q", opts.poolURL)
}

// sessionTraceID mints a random span-style identifier that tags one pool
// connection attempt's log lines (connect → handshake → mine → submit),
// giving operators a grep-able correlation key without pulling the
// OpenTelemetry SDK (ADR-003's dependency budget).
func sessionTraceID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "0000000000000000"
	}
	return hex.EncodeToString(b[:])
}

// jitteredBackoff draws a sleep uniformly from [0, backoff] — full jitter
// per Brooker's "Exponential Backoff And Jitter": plain exponential
// backoff makes every node that lost its session in the same pool outage
// retry in lockstep, hammering the recovering pool in synchronized
// bursts; a uniform draw over the whole window decorrelates retries.
func jitteredBackoff(backoff time.Duration) time.Duration {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return backoff / 2
	}
	v := uint64(b[0]) | uint64(b[1])<<8 | uint64(b[2])<<16 | uint64(b[3])<<24 |
		uint64(b[4])<<32 | uint64(b[5])<<40 | uint64(b[6])<<48 | uint64(b[7])<<56
	// 53-bit fraction — the largest integer range float64 covers exactly.
	frac := float64(v>>11) / (1 << 53)
	return time.Duration(frac * float64(backoff))
}

// traceLog wraps a session logger so every line emitted for one pool
// connection attempt carries the same ` trace=<id>` suffix. The
// message is sanitized of terminal control characters first: pool-
// supplied strings (share-reject reasons, client.show_message notices,
// JSON-decoded error text) can carry C0/C1 controls — ESC injects ANSI
// sequences into the operator's terminal (clear-screen, OSC 8/52) and
// newline forges log entries. JSON unmarshal turns the \u001b-style
// escapes back into real control bytes, so the threat is live.
func traceLog(log func(string, string), trace string) func(string, string) {
	return func(level, msg string) { log(level, sanitizeLogText(msg)+" trace="+trace) }
}

// sanitizeLogText delegates to logger.SanitizeLine — kept as a thin
// wrapper so the call sites below stay readable. It replaces terminal
// control characters (C0, DEL, C1) in a log line with spaces.
func sanitizeLogText(s string) string {
	return logger.SanitizeLine(s)
}

// dialPool builds the session credentials (user, password, optional TLS
// CA bundle), dials the pool via the poolproto registry, and performs
// the shared post-connect bookkeeping (connected log, connection-state
// gauge, onConnected hook). With a configured CA bundle the dialer
// verifies a private-CA/self-signed pool certificate; an unreadable
// file degrades to system roots (which cleanly fails for a private-CA
// pool) — it never falls back to plaintext.
func dialPool(ctx context.Context, opts *sessionOpts, password, protoLabel string) (poolproto.Session, error) {
	if opts.log != nil {
		opts.log = traceLog(opts.log, sessionTraceID())
	}
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
		// TLS transports expose the pool leaf certificate's expiry so a
		// scrape can alert before it kills the next reconnect — an
		// expiring cert otherwise surfaces only as sudden dial failures.
		if tc, ok := sess.(poolproto.TLSCertNotAfterer); ok {
			if notAfter, ok := tc.TLSCertNotAfter(); ok {
				if host, herr := poolproto.StripScheme(opts.poolURL); herr == nil && host != "" {
					opts.m.observePoolTLSCertNotAfter(host, notAfter)
				}
			}
		}
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
	if opts.clk == nil {
		opts.clk = clock.System{}
	}
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
	opts.warnOnPoolShare(ctx)
	opts.manageASICPools(ctx)
	opts.drainPoolNotices(ctx, sess)

	// estSats, latency and friends live on the shared sessionTelemetry
	// accumulator so both session loops tick identically.
	rt := newSessionTelemetry(opts.log, opts.clk)
	statsTicker := time.NewTicker(opts.interval)
	defer statsTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()

		case <-statsTicker.C:
			rt.tick(opts.clk.Now(), opts, sess.SuggestedDifficulty())
			rt.suggestDifficultyOnce(ctx, sess, opts.log)
			rt.updateChannelHashrate(ctx, sess, opts.log)
		case job, ok := <-sess.Jobs():
			if !ok {
				return fmt.Errorf("%s", sessionEndCause(sess))
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

// sessionEndCause enriches the generic "pool closed connection" error
// with the pool-stated end cause (V1 mining.reconnect, V2 Reconnect /
// CloseChannel) when the protocol recorded one — turning a bare TCP
// drop into "closed by pool: <reason>" for diagnostics. The detail is
// diagnostic only; an unauthenticated pool redirect is never followed.
func sessionEndCause(sess poolproto.Session) string {
	if d, ok := sess.(poolproto.SessionEndDetail); ok {
		if info, ok := d.SessionEndInfo(); ok {
			return fmt.Sprintf("engine: pool closed connection (%s)", info)
		}
	}
	return "engine: pool closed connection"
}

// dispatchJob applies one pool job to the workers unless curtailment
// is active, and stamps lastJobReceivedAt either way — the pool
// connection is alive even while curtailed. An applyJob failure only
// warns; the session loop continues.
func dispatchJob(opts *sessionOpts, job *poolproto.Job, chanID uint32, difficulty float64, tag string) {
	if opts.isCurtailed() {
		opts.log("debug", fmt.Sprintf("engine: %s job %s ignored (curtailed)", tag, job.JobID))
	} else {
		jobID, err := applyJob(opts.workers, *job, chanID, difficulty)
		if err != nil {
			opts.log("warn", err.Error())
			return
		}
		if opts.diffTags != nil {
			opts.diffTags.tag(jobID, difficulty)
		}
		opts.log("info", fmt.Sprintf("engine: %s job %s nBits=0x%08X", tag, job.JobID, job.NBits))
	}
	if opts.m != nil {
		opts.m.lastJobReceivedAt.Set(float64(opts.clk.Now().Unix()))
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
			rt.observeLatencyHist(opts, elapsed, share)
		}
		return
	}
	if result.Unconfirmed {
		opts.log("debug", fmt.Sprintf(
			"engine: V2 share verdict timed out (unconfirmed, job %d)",
			share.JobID))
		rt.latency.Record(elapsed)
		rt.observeLatencyHist(opts, elapsed, share)
		return
	}
	if !result.Accepted {
		category, diagnosis := rejectClass(result.Reason)
		opts.log("warn", fmt.Sprintf("engine: V2 share rejected: %s (%s)",
			result.Reason, diagnosis))
		if opts.m != nil {
			opts.m.sharesRejected.Inc()
			opts.m.rejectReason(category).Inc()
			opts.m.touchLastReject(category, opts.clk.Now().Unix())
		}
		return
	}
	opts.log("info", "engine: V2 share accepted")
	rt.latency.Record(elapsed)
	rt.observeLatencyHist(opts, elapsed, share)
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
	if opts.clk == nil {
		opts.clk = clock.System{}
	}
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
	opts.warnOnPoolShare(ctx)
	opts.manageASICPools(ctx)
	opts.drainPoolNotices(ctx, sess)

	// V1 is single-channel; channel ID 0 is the conventional value.
	const chanID = uint32(0)

	// estSats, latency and friends live on the shared sessionTelemetry
	// accumulator so both session loops tick identically.
	rt := newSessionTelemetry(opts.log, opts.clk)
	statsTicker := time.NewTicker(opts.interval)
	defer statsTicker.Stop()

	// Tags each applied job with the share difficulty in force so
	// post-set_difficulty rejects on old-generation shares classify as
	// benign races rather than real rejects (ESP-Miner #212). Lives on
	// sessionOpts so both dispatchJob and submitV1Share can see it.
	opts.diffTags = newDifficultyTagger(64)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()

		case <-statsTicker.C:
			rt.tick(opts.clk.Now(), &opts, sess.SuggestedDifficulty())
			rt.suggestDifficultyOnce(ctx, sess, opts.log)
			rt.updateChannelHashrate(ctx, sess, opts.log)
		case job, ok := <-sess.Jobs():
			if !ok {
				return fmt.Errorf("%s", sessionEndCause(sess))
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
		JobID: share.JobKey,
		Nonce: share.Nonce,
		NTime: share.NTime,
		// Echoed as the optional 6th submit param when the pool
		// negotiated version-rolling; ignored otherwise.
		Version: share.Version,
	})
	elapsed := float64(time.Since(sendTime).Milliseconds())
	if err != nil {
		opts.log("warn", fmt.Sprintf("engine: V1 submit: %v", err))
		// Still record the latency on error: a p99 spike caused by
		// a pool disconnect is a signal worth surfacing, not hiding.
		if elapsed > 0 {
			rt.latency.Record(elapsed)
			rt.observeLatencyHist(opts, elapsed, share)
		}
		return
	}
	if !result.Accepted {
		category, diagnosis := rejectClass(result.Reason)
		// A difficulty-class reject on a share issued under a different
		// share difficulty is a cross-generation race: the share honestly
		// met the target it was issued under and the pool moved the target
		// mid-flight (var-diff). Count it in the reason breakdown as
		// "difficulty-change" for visibility, but exclude it from
		// sharesRejected so it never inflates the reject rate
		// (ESP-Miner #212).
		if category == "difficulty" && opts.diffTags != nil &&
			opts.diffTags.benign(share.JobID, sess.SuggestedDifficulty()) {
			opts.log("info", fmt.Sprintf("engine: V1 share rejected: %s (benign: share met previous share difficulty; pool target changed mid-flight)", result.Reason))
			if opts.m != nil {
				opts.m.rejectReason("difficulty-change").Inc()
			}
			return
		}
		opts.log("warn", fmt.Sprintf("engine: V1 share rejected: %s (%s)",
			result.Reason, diagnosis))
		if opts.m != nil {
			opts.m.sharesRejected.Inc()
			opts.m.rejectReason(category).Inc()
			opts.m.touchLastReject(category, opts.clk.Now().Unix())
		}
		return
	}
	opts.log("info", "engine: V1 share accepted")
	rt.latency.Record(elapsed)
	rt.observeLatencyHist(opts, elapsed, share)
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
// (docs/KNOWN_LIMITATIONS.md §3). The job's string JobID is opaque per
// spec and carried verbatim in Work.JobKey for share submission; the
// uint32 tag on Work.JobID is internal only (metrics, reject
// classification) — non-decimal ids hash via FNV-32a rather than failing
// the job.
//
// The share target comes from job.Target when the protocol carries one
// (Stratum V2: the pool-assigned U256 from OpenMiningChannelSuccess /
// SetTarget). Otherwise it is derived from difficulty — the Stratum V1
// session's most recent mining.set_difficulty value (poolproto.Job
// carries no difficulty field: V1 delivers it on a separate notification
// that applies to every job until superseded, not attached to
// mining.notify). See v1JobTarget for how it is applied. Returns the
// parsed uint32 job ID so callers can tag cross-generation rejects.
func applyJob(workers []*miner.Worker, job poolproto.Job, chanID uint32, difficulty float64) (uint32, error) {
	target := miner.Hash(job.Target)
	if target == (miner.Hash{}) {
		var err error
		target, err = v1JobTarget(job.NBits, difficulty)
		if err != nil {
			return 0, fmt.Errorf("engine: bad target for job %q: %w", job.JobID, err)
		}
	}
	// job_id is opaque per the stratum spec — echoed back verbatim on
	// submission. The uint32 is only the internal tag (metrics, reject
	// classification); non-decimal ids hash to a tag instead of failing
	// the job (previously "unparseable job ID" stalled mining on pools
	// that send alphanumeric ids).
	var jobID uint32
	if _, err := fmt.Sscanf(job.JobID, "%d", &jobID); err != nil {
		h := fnv.New32a()
		_, _ = h.Write([]byte(job.JobID))
		jobID = h.Sum32()
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
	return jobID, nil
}

// warnOnPoolShare is the one-shot pool-share-of-hashrate awareness check
// (RESEARCH_IMPROVEMENTS Cat 4 #7): once per configured pool host it asks
// mempool.space's public weekly distribution which pool the hostname
// belongs to, records otedama_pool_network_share{pool_host} when the pool
// is identified, and emits one warn when the share meets
// rates.PoolShareWarnThreshold — large-pool concentration is what makes
// the detection-resistant selfish mining in THREAT_MODEL (Bahrani &
// Weinberg, arXiv:2309.06847) possible and weakens failover resilience.
// Unknown pools (private, untracked, unmatched hostname) and fetch errors
// stay silent: this is a nudge, never a nag.
func (opts sessionOpts) warnOnPoolShare(ctx context.Context) {
	if opts.m == nil || opts.noPoolShareCheck {
		return
	}
	host, err := poolproto.StripScheme(opts.poolURL)
	if err != nil || host == "" {
		return
	}
	opts.m.poolShareSeenMu.Lock()
	if opts.m.poolShareSeen[host] {
		opts.m.poolShareSeenMu.Unlock()
		return
	}
	opts.m.poolShareSeen[host] = true
	opts.m.poolShareSeenMu.Unlock()
	go func() {
		ps, found, err := rates.FetchPoolNetworkShare(ctx, host)
		if err != nil || !found {
			return
		}
		opts.m.reg.NewGauge(
			"otedama_pool_network_share",
			"Network-hashrate share of the connected pool (weekly block-share "+
				"via mempool.space). Alert ≳0.30: large-pool concentration "+
				"enables detection-resistant selfish mining.",
			map[string]string{"pool_host": host}).Set(ps.Share)
		if ps.Share >= rates.PoolShareWarnThreshold {
			opts.log("warn", fmt.Sprintf(
				"engine: pool %s controls ~%.0f%% of network hashrate this week — "+
					"large-pool concentration enables detection-resistant selfish mining; "+
					"consider a smaller pool",
				ps.Name, ps.Share*100))
		}
	}()
}

// manageASICPools pushes the just-connected pool to every managed ASIC
// (Config.ASICManage + ASICEndpoints) via the cgminer addpool/switchpool
// pair, so a fleet of standalone miners follows Otedama's active stratum
// endpoint — including across failovers. Only Stratum-V1-compatible
// URLs are actuated: cgminer firmwares speak SV1, and pushing a
// stratum+v2:// URL would strand the miner; datum:// is rewritten to
// stratum+tcp://, the protocol the DATUM gateway serves downstream.
// Dedup is by last-pushed host: reconnects to the same pool do not
// re-issue commands, but a failover onto a different pool does. Runs in
// a goroutine — actuation must never delay the session's first job.
func (opts sessionOpts) manageASICPools(ctx context.Context) {
	if !opts.asicManage || len(opts.asicEndpoints) == 0 || opts.m == nil {
		return
	}
	proto := poolproto.FromURL(opts.poolURL)
	switch proto {
	case poolproto.ProtocolStratumV1, poolproto.ProtocolStratumV1TLS, poolproto.ProtocolDATUM:
	default:
		opts.log("info", fmt.Sprintf(
			"engine: asic_manage set but pool %s is not SV1-compatible — managed ASICs left unchanged",
			opts.poolURL))
		return
	}
	host, err := poolproto.StripScheme(opts.poolURL)
	if err != nil || host == "" {
		return
	}
	opts.m.asicManagedMu.Lock()
	if opts.m.asicManagedHost == host {
		opts.m.asicManagedMu.Unlock()
		return
	}
	opts.m.asicManagedHost = host
	opts.m.asicManagedMu.Unlock()
	drv := &hal.ASICDriver{Endpoints: opts.asicEndpoints}
	go func() {
		switched, errs := drv.SwitchPools(ctx, opts.poolURL, opts.user, opts.poolPassword)
		for _, e := range errs {
			opts.log("warn", "engine: asic_manage: "+e.Error())
		}
		if len(switched) > 0 {
			opts.m.reg.NewCounter(
				"otedama_asic_pool_switches_total",
				"Successful cgminer switchpool pushes to managed ASICs (asic_manage), "+
					"per destination pool host.",
				map[string]string{"pool_host": host}).Add(uint64(len(switched)))
			opts.log("info", fmt.Sprintf(
				"engine: asic_manage: %d miner(s) switched to %s", len(switched), host))
		}
	}()
}

// drainPoolNotices relays pool operator notices (V1 client.show_message)
// into the session log when the transport supports
// poolproto.PoolNoticeReceiver. Without a consumer the session drops
// notices once its small buffer fills — pool maintenance warnings would
// vanish exactly when the operator most needs them. The first 16
// notices per connection log verbatim at warn; beyond that a flood
// guard collapses to a periodic suppressed-count summary so a
// notice-spamming pool can't flood the log. The goroutine exits on
// channel close (session end) or ctx.
func (opts *sessionOpts) drainPoolNotices(ctx context.Context, sess poolproto.Session) {
	rcv, ok := sess.(poolproto.PoolNoticeReceiver)
	if !ok {
		return
	}
	go func() {
		const verbatimCap = 16
		ch := rcv.PoolNotices()
		logged, suppressed := 0, 0
		flush := func() {
			if suppressed > 0 {
				opts.log("warn", fmt.Sprintf("engine: %d pool notices suppressed (flood guard)", suppressed))
				suppressed = 0
			}
		}
		for {
			select {
			case notice, ok := <-ch:
				if !ok {
					flush()
					return
				}
				if logged < verbatimCap {
					opts.log("warn", "engine: pool notice: "+notice)
					logged++
				} else {
					suppressed++
					if suppressed%64 == 0 {
						flush()
					}
				}
			case <-ctx.Done():
				return
			}
		}
	}()
}

func isFatal(err error) bool { _, ok := err.(*fatalError); return ok }

type fatalError struct{ msg string }

func (e *fatalError) Error() string { return e.msg }
