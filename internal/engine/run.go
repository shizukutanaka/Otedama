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
	"net"
	"os"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/shizukutanaka/Otedama/internal/arbitration"
	"github.com/shizukutanaka/Otedama/internal/clock"
	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/shizukutanaka/Otedama/internal/hal"
	"github.com/shizukutanaka/Otedama/internal/lightning"
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

	// arbitrationInterval is how often the engine re-evaluates the
	// device→stream assignment in the absence of a fresh quote.
	arbitrationInterval = 30 * time.Second
)

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
	rateFetcher := rates.NewFetcher(95000) // $95k fallback
	rateFetcher.StartBackground(ctx, 5*time.Minute)

	// Publish the BTC/USD rate to its gauge as it refreshes, so
	// otedama_btc_usd_rate is populated (it was registered but never set).
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
			}
		}
	}()

	// ----- Phase 5: Providers -----
	miningProvider, akashProvider := startProviders(ctx, opts.Config, rateFetcher, devices, log)
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

	// Arbitration loop: re-run Decide whenever quotes change.
	go runArbitrationLoop(ctx, arbitrationLoopOpts{
		devRefs:   devRefs,
		streamsMu: &streamsMu,
		streamMap: streamMap,
		quoteCh:   quoteCh,
		workers:   workers,
		metrics:   m,
		log:       log,
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
		opts:      opts,
		workers:   workers,
		merged:    merged,
		dashboard: dashboard,
		startTime: startTime,
		wallet:    walletFingerprint,
		deviceN:   len(devices),
		providers: []provider.Provider{miningProvider, akashProvider},
		metrics:   m,
		log:       log,
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
		var poolUser string
		if poolIdx < len(r.opts.Config.Pools) {
			poolUser = r.opts.Config.Pools[poolIdx].User
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
		r.metrics.poolConnectionState.Set(1) // connecting
		sessionErr := runSession(ctx, sessionOpts{
			poolURL:   poolURL,
			user:      user,
			workers:   r.workers,
			merged:    r.merged,
			interval:  statsInterval,
			dashboard: r.dashboard,
			startTime: r.startTime,
			wallet:    r.wallet,
			devices:   r.deviceN,
			log:       r.log,
			providers: r.providers,
			m:         r.metrics,
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
		select {
		case <-time.After(backoff):
		case <-ctx.Done():
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
	poolURL   string
	user      string
	workers   []*miner.Worker
	merged    <-chan miner.Share
	interval  time.Duration
	dashboard *tui.Dashboard
	startTime time.Time
	wallet    string
	devices   int
	log       func(level, msg string)
	providers []provider.Provider
	m         *engineMetrics
	// onConnected, if set, is called once the handshake completes and the
	// session is established. The reconnect loop uses it to mark the
	// active payout address as "known good" so it is not failed over.
	onConnected func()
}

type poolMsg struct {
	msg stratum.Message
	err error
}

// setupWallet initialises the optional Lightning wallet. Returns the
// wallet fingerprint, or an empty string if no wallet was configured
// or initialisation failed (errors are logged, not propagated, so the
// engine can run mining without a wallet).
// detectDevices initialises the HAL registry, registers CPU and GPU
// drivers, and runs detection. Returns the list of detected devices,
// or an error if registration fails or no devices are found.
// arbitrationLoopOpts bundles the arguments to runArbitrationLoop.
type arbitrationLoopOpts struct {
	devRefs   []arbitration.DeviceRef
	streamsMu *sync.Mutex
	streamMap map[string]arbitration.Stream
	quoteCh   <-chan provider.Quote
	workers   []*miner.Worker
	metrics   *engineMetrics
	log       func(level, msg string)
}

// runArbitrationLoop re-evaluates device→stream assignment every 30s,
// or whenever a fresh quote arrives. Blocks until ctx is cancelled or
// the quote channel is closed.
func runArbitrationLoop(ctx context.Context, opts arbitrationLoopOpts) {
	ticker := time.NewTicker(arbitrationInterval)
	defer ticker.Stop()
	var prevAlloc *arbitration.Allocation
	for {
		select {
		case <-ctx.Done():
			return
		case q, ok := <-opts.quoteCh:
			if !ok {
				return
			}
			updateStream(opts.streamsMu, opts.streamMap, q)
		case <-ticker.C:
			opts.streamsMu.Lock()
			streams := streamsSlice(opts.streamMap)
			opts.streamsMu.Unlock()

			alloc, err := arbitration.Decide(arbitration.Input{
				Devices:          opts.devRefs,
				Streams:          streams,
				Previous:         prevAlloc,
				Policy:           arbitration.PolicyMaximizeEarnings,
				HysteresisMargin: 0.05,
			})
			if err != nil {
				opts.log("warn", fmt.Sprintf("arbitration: %v", err))
				continue
			}
			prevAlloc = alloc
			for _, a := range alloc.Assignments {
				if a.SwitchedFromID != "" {
					opts.metrics.arbitrationSwitches.Inc()
				}
			}
			applyAllocation(alloc, opts.workers, opts.log)
		}
	}
}

func detectDevices(ctx context.Context, log func(level, msg string)) ([]hal.Device, error) {
	reg := hal.NewRegistry()
	if err := reg.Register(&cpuDriver{}); err != nil {
		return nil, fmt.Errorf("engine: register cpu driver: %w", err)
	}
	if err := hal.RegisterGPULinux(reg); err != nil {
		log("warn", fmt.Sprintf("engine: register gpu driver: %v", err))
	}
	detector := hal.NewDetector(reg, func(driver, msg string, err error) {
		log("warn", fmt.Sprintf("hal: %s: %s: %v", driver, msg, err))
	})
	devices, _ := detector.Detect(ctx)
	if len(devices) == 0 {
		return nil, fmt.Errorf("engine: no devices detected")
	}
	return devices, nil
}

// startMinerWorkers spawns one miner worker per SHA256d-capable device,
// returns the workers and a merged share channel. Returns an error if
// no SHA256d-capable device is present. The caller owns worker shutdown.
func startMinerWorkers(ctx context.Context, devices []hal.Device, log func(level, msg string)) ([]*miner.Worker, <-chan miner.Share, error) {
	var workers []*miner.Worker
	var shareChans []<-chan miner.Share
	for _, dev := range devices {
		if !dev.Capabilities().SHA256d {
			continue
		}
		w := miner.NewWorker(miner.DefaultWorkerConfig())
		workers = append(workers, w)
		shareChans = append(shareChans, w.Start(ctx))
		log("info", fmt.Sprintf("engine: worker for %s", dev.Identity()))
	}
	if len(workers) == 0 {
		return nil, nil, fmt.Errorf("engine: no SHA256d-capable devices found")
	}
	return workers, mergeShares(ctx, shareChans), nil
}

// startProviders constructs and starts the mining and Akash providers.
// Start errors are logged (not fatal): the engine can run with a degraded
// provider set. The caller owns provider shutdown.
func startProviders(ctx context.Context, cfg config.Config, rateFetcher provider.RateSource, devices []hal.Device, log func(level, msg string)) (*provider.MiningProvider, *provider.AkashProvider) {
	miningProvider := provider.NewMiningProvider(defaultPoolURL(cfg), rateFetcher)
	akashProvider := provider.NewAkashProvider(rateFetcher)
	if err := miningProvider.Start(ctx, devices); err != nil {
		log("warn", fmt.Sprintf("provider: mining: %v", err))
	}
	if err := akashProvider.Start(ctx, devices); err != nil {
		log("warn", fmt.Sprintf("provider: akash: %v", err))
	}
	return miningProvider, akashProvider
}

func setupWallet(opts Options, log func(level, msg string)) string {
	if opts.WalletPassphrase == "" || opts.Config.DataDir == "" {
		return ""
	}
	wl, err := lightning.NewEnglishWordList()
	if err != nil {
		log("warn", fmt.Sprintf("wallet: wordlist: %v", err))
		return ""
	}
	wm, err := lightning.NewWalletManager(
		opts.Config.DataDir, opts.WalletPassphrase, nil, wl)
	if err != nil {
		log("warn", fmt.Sprintf("wallet: %v", err))
		return ""
	}
	fingerprint := wm.Fingerprint()
	if wm.IsNew() {
		log("info", "wallet: new wallet created — back up your recovery phrase")
	}
	log("info", fmt.Sprintf("wallet: fingerprint %s", fingerprint))
	return fingerprint
}

// runSession runs one pool connection: dial, handshake, then stream
// jobs to workers and shares back to the pool until the connection
// drops or ctx is cancelled. Returns the error that ended the session
// (nil if ctx was cancelled cleanly).
func runSession(ctx context.Context, opts sessionOpts) error {
	host, err := parseHost(opts.poolURL)
	if err != nil {
		return fmt.Errorf("engine: bad pool URL %q: %w", opts.poolURL, err)
	}
	var d net.Dialer
	conn, err := d.DialContext(ctx, "tcp", host)
	if err != nil {
		return fmt.Errorf("engine: dial %s: %w", host, err)
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
	var totalSats uint64
	statsTicker := time.NewTicker(opts.interval)
	defer statsTicker.Stop()

	// Watch for a stalled miner (zero hashrate sustained across samples).
	hashMon := NewHashrateMonitor(0, 3, opts.log)
	// Differentiate the cumulative hash counter into a current rate; the
	// stall monitor and the hashrate gauge both consume this, not the
	// lifetime average (which can never reach the stall floor).
	var hashWindow hashrateWindow

	// Track share-submission round-trip latency. submitTimes maps a
	// sequence number to the time the share was sent; on accept we
	// compute the RTT. Bounded by pruning on read.
	latency := NewLatencyTracker(256)
	submitTimes := make(map[uint32]time.Time)

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()

		case <-statsTicker.C:
			currentHashRate := hashWindow.observe(totalHashes(opts.workers), time.Now())
			if opts.dashboard != nil {
				opts.dashboard.Update(buildStats(opts, currentHashRate, totalSats))
			}
			logStats(opts.workers, currentHashRate, opts.log)
			hashMon.Observe(currentHashRate)
			if opts.m != nil {
				opts.m.hashrate.Set(currentHashRate)
				if hashMon.Stalled() {
					opts.m.up.Set(0)
				} else {
					opts.m.up.Set(1)
				}
				rate := acceptanceRate(opts.m.sharesAccepted.Value(), opts.m.sharesRejected.Value())
				opts.m.shareAcceptanceRate.Set(rate)
				// Warn once-per-tick if acceptance has dropped below the
				// "acceptable" band (industry guidance: >1% reject ≈
				// <99% acceptance warrants attention).
				judged := opts.m.sharesAccepted.Value() + opts.m.sharesRejected.Value()
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
				updateWork(opts.workers, pm.msg.NewMiningJob, chanID, shareTarget)
				opts.log("info", fmt.Sprintf("engine: job %d nBits=0x%08X",
					pm.msg.NewMiningJob.JobID, pm.msg.NewMiningJob.NBits))
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
				}
			}

		case share, ok := <-opts.merged:
			if !ok {
				return ctx.Err()
			}
			seqNum++
			totalSats++ // approximation; real value comes from pool SubmitSharesSuccess
			if opts.m != nil {
				opts.m.sharesFound.Inc()
			}
			sub := stratum.SubmitSharesStandard{
				ChannelID:      chanID,
				SequenceNumber: seqNum,
				JobID:          share.JobID,
				Nonce:          share.Nonce,
				NTime:          share.NTime,
				NVersion:       0x20000000,
			}
			if err := sendMsg(conn, stratum.MsgSubmitSharesStandard, true, &sub); err != nil {
				return fmt.Errorf("engine: submit share: %w", err)
			}
			submitTimes[seqNum] = time.Now()
			opts.log("info", fmt.Sprintf("engine: share seq=%d nonce=0x%08X", seqNum, share.Nonce))
		}
	}
}

// buildStats assembles a tui.Stats snapshot from live engine state.
// Also updates the uptime gauge. hashRate is the current (windowed) rate
// computed once per stats tick by hashrateWindow; the hashrate gauge is set
// by the caller from the same value, so display, log, gauge, and stall
// monitor all agree.
func buildStats(opts sessionOpts, hashRate float64, totalSats uint64) tui.Stats {
	var sharesSent, sharesFound uint64
	for _, w := range opts.workers {
		sharesFound += w.Stats().SharesFound
	}
	if opts.m != nil {
		opts.m.uptime.Set(time.Since(opts.startTime).Seconds())
	}
	sharesSent = sharesFound // approximation

	var providerStats []tui.ProviderStats
	for _, p := range opts.providers {
		// Sample latest quote from provider — simplified.
		ps := tui.ProviderStats{
			Name:   p.Name(),
			Active: true,
		}
		providerStats = append(providerStats, ps)
	}

	return tui.Stats{
		HashRate:          hashRate,
		SharesFound:       sharesFound,
		SharesSent:        sharesSent,
		PoolURL:           opts.poolURL,
		Connected:         true,
		TotalSatsEarned:   totalSats,
		WalletFingerprint: opts.wallet,
		Uptime:            time.Since(opts.startTime),
		Devices:           opts.devices,
		Providers:         providerStats,
	}
}

// ----- Arbitration helpers -----

func updateStream(mu *sync.Mutex, m map[string]arbitration.Stream, q provider.Quote) {
	mu.Lock()
	defer mu.Unlock()
	key := q.ProviderID + ":" + q.DeviceID
	existing := m[key]
	existing.ID = arbitration.StreamID(q.ProviderID)
	existing.AcceptsFamilies = q.AcceptedFamilies
	if existing.YieldPerDevice == nil {
		existing.YieldPerDevice = make(map[string]arbitration.Yield)
	}
	if q.DeviceID != "" {
		existing.YieldPerDevice[q.DeviceID] = arbitration.Yield{
			SatsPerSecond: q.Yield.SatsPerSecond,
			Confidence:    q.Yield.Confidence,
		}
	}
	existing.DefaultYield = arbitration.Yield{
		SatsPerSecond: q.Yield.SatsPerSecond,
		Confidence:    q.Yield.Confidence,
	}
	existing.IsBitcoinMining = q.ProviderID == "mining.stratum"
	m[key] = existing
}

func streamsSlice(m map[string]arbitration.Stream) []arbitration.Stream {
	seen := make(map[arbitration.StreamID]bool)
	var result []arbitration.Stream
	for _, s := range m {
		if !seen[s.ID] {
			seen[s.ID] = true
			result = append(result, s)
		}
	}
	return result
}

func applyAllocation(alloc *arbitration.Allocation, workers []*miner.Worker, log func(string, string)) {
	for _, a := range alloc.Assignments {
		switch {
		case a.Idle():
			// Device has no compatible stream; pause SHA256d to save power.
			for _, w := range workers {
				w.SetWork(nil)
			}
			log("info", fmt.Sprintf("arbitration: %s idle (no compatible stream)", a.DeviceID))

		case a.SwitchedFromID != "":
			// Stream changed. If switching away from mining, signal workers to pause.
			// Switching TO mining re-enables them; the pool connection delivers new work.
			wasAI := strings.HasPrefix(string(a.SwitchedFromID), "ai.")
			nowAI := strings.HasPrefix(string(a.Stream), "ai.")
			switch {
			case !wasAI && nowAI:
				// Mining → AI: pause SHA256d workers.
				for _, w := range workers {
					w.SetWork(nil)
				}
				log("info", fmt.Sprintf("arbitration: %s → AI inference (%.0f sat/s)",
					a.DeviceID, a.ExpectedYield))
			case wasAI && !nowAI:
				// AI → Mining: workers will receive new work from the pool on next job.
				log("info", fmt.Sprintf("arbitration: %s → mining (%.0f sat/s)",
					a.DeviceID, a.ExpectedYield))
			default:
				log("info", fmt.Sprintf("arbitration: %s switched to %s (%.0f sat/s)",
					a.DeviceID, a.Stream, a.ExpectedYield))
			}

		default:
			// No change; assignment held per hysteresis.
		}
	}
}

// fanIn merges N input channels into a single output channel.
// It closes the output when all inputs are drained or ctx is done.
// Buffer size is bufFactor * len(channels), capped at 64 for small N.
func fanIn[T any](ctx context.Context, channels []<-chan T, bufFactor int) <-chan T {
	bufSize := bufFactor * len(channels)
	if bufSize > 64 {
		bufSize = 64
	}
	if bufSize < 1 {
		bufSize = 1
	}
	out := make(chan T, bufSize)
	var wg sync.WaitGroup
	for _, ch := range channels {
		wg.Add(1)
		go func(c <-chan T) {
			defer wg.Done()
			for {
				// The receive must also observe ctx: a stuck input (never
				// written, never closed) would otherwise pin this goroutine
				// open after cancellation and keep out from ever closing.
				select {
				case v, ok := <-c:
					if !ok {
						return // input closed
					}
					select {
					case out <- v:
					case <-ctx.Done():
						return
					}
				case <-ctx.Done():
					return
				}
			}
		}(ch)
	}
	go func() { wg.Wait(); close(out) }()
	return out
}

// mergeQuotes is a typed convenience wrapper for fanIn.
func mergeQuotes(ctx context.Context, channels ...<-chan provider.Quote) <-chan provider.Quote {
	return fanIn(ctx, channels, 64)
}

// mergeShares is a typed convenience wrapper for fanIn.
func mergeShares(ctx context.Context, channels []<-chan miner.Share) <-chan miner.Share {
	return fanIn(ctx, channels, 4)
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
	_, err = conn.Write(data)
	return err
}

func updateWork(workers []*miner.Worker, job *stratum.NewMiningJob, chanID uint32, shareTarget miner.Hash) {
	target, err := miner.TargetFromNBits(job.NBits)
	if err != nil {
		return
	}
	// Grind to the pool-assigned share target, not the block target. The
	// share target is far easier; a hash meeting it is exactly what the
	// pool credits, and every comparable miner submits against it. Using
	// the block target here would mean a worker only ever emits a share on
	// an actual block solve — effectively never, so the pool would see no
	// shares at all. Fall back to the block target only when the pool
	// assigned none (zero target).
	if shareTarget != (miner.Hash{}) {
		target = shareTarget
	}
	w := &miner.Work{
		JobID:     job.JobID,
		ChannelID: chanID,
		Header: miner.Header{
			MerkleRoot: job.MerkleRoot,
			Time:       job.MinNtime,
			Bits:       job.NBits,
		},
		NBits:  job.NBits,
		Target: target,
	}
	for _, wr := range workers {
		wr.SetWork(w)
	}
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
func applyJob(workers []*miner.Worker, job poolproto.Job, chanID uint32) error {
	target, err := miner.TargetFromNBits(job.NBits)
	if err != nil {
		return fmt.Errorf("engine: bad nBits 0x%08X in job %q: %w", job.NBits, job.JobID, err)
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

// (mergeShares: see fanIn-based wrapper above)

// totalHashes sums the lifetime cumulative hash count across all workers.
// This is the raw counter that hashrateWindow differentiates into a
// *current* rate — as opposed to a lifetime average (total/uptime), which
// barely moves once a worker has run for a while and so can never fall to
// the stall floor after startup, defeating HashrateMonitor.
func totalHashes(workers []*miner.Worker) uint64 {
	var total uint64
	for _, w := range workers {
		total += w.Stats().HashesTotal
	}
	return total
}

// hashrateWindow turns successive cumulative hash-count samples into a
// current hashrate (hashes/sec over the last interval). This is what every
// comparable miner reports (cgminer/bfgminer/ESP-Miner rolling averages)
// and what the stall monitor must consume: a lifetime average (total/uptime)
// stays positive forever after the first hash, so it can never signal a
// stall — only a windowed rate can.
//
// It is saturating: when the cumulative total *decreases* — which happens
// when workers are recreated on reconnect and their counters reset to zero
// (ESP-Miner reconnect fix) — the rate is 0, never negative or NaN. The
// first observation primes the baseline and returns 0.
type hashrateWindow struct {
	lastTotal uint64
	lastTime  time.Time
	primed    bool
}

// observe records one cumulative sample and returns the hashrate since the
// previous sample. The first call returns 0 (baseline).
func (w *hashrateWindow) observe(total uint64, now time.Time) float64 {
	if !w.primed {
		w.primed = true
		w.lastTotal = total
		w.lastTime = now
		return 0
	}
	dt := now.Sub(w.lastTime).Seconds()
	var rate float64
	if dt > 0 && total >= w.lastTotal {
		rate = float64(total-w.lastTotal) / dt
	}
	// total < lastTotal → counters reset (reconnect): leave rate at 0.
	w.lastTotal = total
	w.lastTime = now
	return rate
}

func logStats(workers []*miner.Worker, hashRate float64, log func(string, string)) {
	var shares uint64
	for _, w := range workers {
		shares += w.Stats().SharesFound
	}
	log("info", fmt.Sprintf("engine: hashrate=%s shares=%d",
		miner.HashRateString(hashRate), shares))
}

// classifyReject maps a pool's share-rejection reason to the likely
// root cause, following the field taxonomy used across the mining
// community (e.g. D-Central's reject-share guide): "stale" points to
// network latency, "invalid"/"above target" to hardware or difficulty
// config, "duplicate" to firmware/connectivity. This turns an opaque
// pool string into an actionable diagnosis in the logs.
// rejectClass categorises a pool's share-rejection reason. The category
// string is short and stable, suitable as a metric label; the diagnosis
// is the human-readable hint for logs. Both derive from the same
// classification (community field taxonomy, e.g. D-Central's guide):
// stale→latency, duplicate→firmware, above-target→difficulty,
// invalid→hardware.
func rejectClass(reason string) (category, diagnosis string) {
	r := strings.ToLower(reason)
	switch {
	case strings.Contains(r, "stale") || strings.Contains(r, "job not found") || strings.Contains(r, "unknown job"):
		return "stale", "likely cause: network latency / stale work"
	case strings.Contains(r, "duplicate"):
		return "duplicate", "likely cause: firmware or connectivity (duplicate submission)"
	case strings.Contains(r, "above") || strings.Contains(r, "target") || strings.Contains(r, "low difficulty") || strings.Contains(r, "high-hash"):
		return "difficulty", "likely cause: difficulty configuration or hardware error"
	case strings.Contains(r, "invalid") || strings.Contains(r, "bad"):
		return "hardware", "likely cause: hardware error (failing chip / overheating)"
	default:
		return "other", "cause unclassified — check pool documentation"
	}
}

// classifyReject returns just the human-readable diagnosis (kept for the
// log line; see rejectClass for the metric-label category).
func classifyReject(reason string) string {
	_, diagnosis := rejectClass(reason)
	return diagnosis
}

// acceptanceRate computes the share acceptance rate — accepted /
// (accepted + rejected) — as a fraction in [0,1]. This is the metric
// that maps to "net BTC retained": every rejected share is work the
// pool will not pay for, so a falling acceptance rate is lost revenue
// (see docs/RESEARCH_IMPROVEMENTS.md Cat 3). Returns 1.0 when no shares
// have been judged yet (nothing rejected = nothing lost), avoiding a
// 0/0 that would otherwise read as a catastrophic 0% on a fresh start.
func acceptanceRate(accepted, rejected uint64) float64 {
	total := accepted + rejected
	if total == 0 {
		return 1.0
	}
	return float64(accepted) / float64(total)
}

// LatencyTracker records share-submission round-trip times (submit →
// pool accept/reject) in a fixed-size ring buffer and computes
// quantiles on demand. Submit latency is the direct driver of stale
// shares — the #1 reject cause — so surfacing p50/p95/p99 tells an
// operator when their pool is too far away (high RTT) before it shows
// up as lost revenue in the reject rate.
//
// It is intentionally allocation-free in steady state and lock-protected
// so the submit path (which records) and the stats loop (which reads
// quantiles) can run on different goroutines.
type LatencyTracker struct {
	mu      sync.Mutex
	samples []float64 // milliseconds, ring buffer
	next    int
	filled  bool
}

// NewLatencyTracker creates a tracker holding the most recent `size`
// samples (default 256 if size < 1).
func NewLatencyTracker(size int) *LatencyTracker {
	if size < 1 {
		size = 256
	}
	return &LatencyTracker{samples: make([]float64, size)}
}

// Record adds one round-trip sample in milliseconds.
func (l *LatencyTracker) Record(ms float64) {
	if ms < 0 {
		return
	}
	l.mu.Lock()
	l.samples[l.next] = ms
	l.next = (l.next + 1) % len(l.samples)
	if l.next == 0 {
		l.filled = true
	}
	l.mu.Unlock()
}

// Quantile returns the q-th (0..1) percentile of the recorded samples in
// milliseconds, or 0 if no samples yet. Uses nearest-rank on a sorted
// copy — exact for the retained window, no streaming-estimator error.
func (l *LatencyTracker) Quantile(q float64) float64 {
	l.mu.Lock()
	n := len(l.samples)
	if !l.filled {
		n = l.next
	}
	if n == 0 {
		l.mu.Unlock()
		return 0
	}
	cp := make([]float64, n)
	copy(cp, l.samples[:n])
	l.mu.Unlock()

	sort.Float64s(cp)
	if q <= 0 {
		return cp[0]
	}
	if q >= 1 {
		return cp[n-1]
	}
	idx := int(q*float64(n)+0.5) - 1
	if idx < 0 {
		idx = 0
	}
	if idx >= n {
		idx = n - 1
	}
	return cp[idx]
}

// HashrateMonitor watches for a stalled miner: a hashrate that has been
// at or below a floor for several consecutive samples. This is the
// safety net every comparable miner has (cgminer/Awesome Miner
// hashrate-drop triggers) — without it, a miner that silently stops
// hashing (driver wedged, thermal shutdown, work starvation) keeps the
// process alive while earning nothing, and the user never finds out.
//
// The monitor is intentionally stateful and single-goroutine: it is
// driven from the same stats loop that logs hashrate, so no locking is
// needed.
type HashrateMonitor struct {
	floor      float64 // hashes/sec at or below which a sample counts as stalled
	maxStall   int     // consecutive stalled samples before warning
	stallCount int
	warned     bool
	log        func(level, msg string)
}

// NewHashrateMonitor creates a monitor that warns after maxStall
// consecutive samples at or below floor hashes/sec. A floor of 0 means
// "warn only on a complete stall (zero hashrate)".
func NewHashrateMonitor(floor float64, maxStall int, log func(level, msg string)) *HashrateMonitor {
	if maxStall < 1 {
		maxStall = 3
	}
	return &HashrateMonitor{floor: floor, maxStall: maxStall, log: log}
}

// Observe records one hashrate sample and emits a warning the first
// time the stall threshold is crossed. Once the hashrate recovers above
// the floor, the monitor resets and will warn again on the next stall.
func (m *HashrateMonitor) Observe(hashrate float64) {
	if hashrate <= m.floor {
		m.stallCount++
		if m.stallCount >= m.maxStall && !m.warned {
			m.warned = true
			if m.log != nil {
				m.log("warn", fmt.Sprintf(
					"engine: hashrate stalled at %s for %d consecutive samples — "+
						"check device health, cooling, and pool connection",
					miner.HashRateString(hashrate), m.stallCount))
			}
		}
		return
	}
	// Recovered.
	if m.warned && m.log != nil {
		m.log("info", "engine: hashrate recovered")
	}
	m.stallCount = 0
	m.warned = false
}

// Stalled reports whether the monitor is currently in a warned-stall
// state (useful for health endpoints / readiness).
func (m *HashrateMonitor) Stalled() bool { return m.warned }

func defaultPoolURL(cfg config.Config) string {
	if len(cfg.Pools) > 0 {
		return cfg.Pools[0].URL
	}
	return "stratum+v2://public.stratum.slushpool.com:3336"
}

// poolURLs returns the ordered list of pool URLs to try, for failover.
// The order is the user's configured priority; the engine rotates to
// the next pool when the current one fails (matching the multi-pool
// failover behaviour of cgminer/bfgminer/Braiins). Falls back to the
// built-in default when no pools are configured.
func poolURLs(cfg config.Config) []string {
	if len(cfg.Pools) == 0 {
		return []string{"stratum+v2://public.stratum.slushpool.com:3336"}
	}
	urls := make([]string, 0, len(cfg.Pools))
	for _, p := range cfg.Pools {
		urls = append(urls, p.URL)
	}
	return urls
}

// publishBTCRate copies the fetcher's current BTC/USD rate into its gauge.
// The fetcher returns its fallback before the first successful fetch, so the
// gauge is never left at zero once a fetcher exists.
func publishBTCRate(m *engineMetrics, f *rates.Fetcher) {
	if rate, _ := f.BTCUSDRate(); rate > 0 {
		m.btcUSDRate.Set(rate)
	}
}

// payoutAddresses returns the ordered, de-duplicated list of payout
// addresses to try, for failover: BitcoinAddress first (the primary),
// then BitcoinAddresses in order. Empty entries are skipped. The engine
// rotates to the next address only when the current one has never
// established a session (see runReconnectLoop), so a working payout
// address is never abandoned due to a transient pool or network failure.
func payoutAddresses(cfg config.Config) []string {
	seen := make(map[string]bool)
	var addrs []string
	add := func(a string) {
		if a == "" || seen[a] {
			return
		}
		seen[a] = true
		addrs = append(addrs, a)
	}
	add(cfg.BitcoinAddress)
	for _, a := range cfg.BitcoinAddresses {
		add(a)
	}
	return addrs
}

// sessionUser builds the Stratum user_identity sent in OpenMiningChannel,
// honouring the documented config precedence:
//   - an explicit per-pool User overrides everything (operator's choice);
//   - otherwise the active payout address is used, suffixed with the
//     configured worker name as "address.worker" — the standard Stratum
//     convention for per-rig stats at the pool — when a name is set.
func sessionUser(poolUser, addr, worker string) string {
	if poolUser != "" {
		return poolUser
	}
	if worker != "" {
		return addr + "." + worker
	}
	return addr
}

// maskAddr renders a payout address for logs without printing it in full,
// so operator logs do not needlessly expose the complete address.
func maskAddr(a string) string {
	if len(a) <= 12 {
		return a
	}
	return a[:6] + "…" + a[len(a)-4:]
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

// ----- Built-in CPU driver -----

type cpuDriver struct{}

func (d *cpuDriver) Name() string { return "cpu" }

func (d *cpuDriver) Enumerate(_ context.Context) ([]hal.Device, error) {
	return []hal.Device{&cpuDevice{
		id: hal.Identity{
			ID:     "cpu-0",
			Family: hal.FamilyCPU,
			Vendor: "generic",
			Model:  fmt.Sprintf("%d-core CPU", runtime.NumCPU()),
		},
		caps: hal.Capabilities{SHA256d: true, GeneralCompute: true},
	}}, nil
}

type cpuDevice struct {
	id   hal.Identity
	caps hal.Capabilities
}

func (d *cpuDevice) Identity() hal.Identity           { return d.id }
func (d *cpuDevice) Capabilities() hal.Capabilities   { return d.caps }
func (d *cpuDevice) Shutdown(_ context.Context) error { return nil }
