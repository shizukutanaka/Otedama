// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package engine — metrics.go
//
// engineMetrics bundles all Prometheus metric handles updated during
// the run loop. Extracted from run.go so the orchestration logic and
// the metric-registration boilerplate live in separate files.
package engine

import (
	"sync"

	"github.com/shizukutanaka/Otedama/internal/metrics"
	"github.com/shizukutanaka/Otedama/internal/version"
)

// ----- Engine metrics -----
//
// engineMetrics bundles all metric handles that are updated during the
// run loop. Grouping them in one struct keeps the hot path free of
// registry lookups — each metric is a pointer cached at startup.
type engineMetrics struct {
	hashrate            *metrics.Gauge
	sharesFound         *metrics.Counter
	sharesAccepted      *metrics.Counter
	sharesRejected      *metrics.Counter
	poolConnectAttempts *metrics.Counter
	poolConnectFailures *metrics.Counter
	arbitrationSwitches *metrics.Counter
	// arbitrationHolds counts decisions where a strictly better stream existed
	// but hysteresis kept the device on its current one. Together with
	// arbitrationSwitches it makes the hysteresis margin tunable: many holds
	// mean yield is being left on the table; zero holds mean the margin never
	// binds. (The "road not taken" — decisions the engine declined.)
	arbitrationHolds *metrics.Counter
	// activeStreams is the number of live revenue streams arbitration is
	// choosing between after stale (dead-provider) streams are pruned. A
	// drop here surfaces a provider that has stopped quoting.
	activeStreams *metrics.Gauge
	btcUSDRate    *metrics.Gauge
	uptime        *metrics.Gauge
	startTime     *metrics.Gauge

	submitLatencyP50 *metrics.Gauge
	submitLatencyP95 *metrics.Gauge
	submitLatencyP99 *metrics.Gauge

	shareAcceptanceRate *metrics.Gauge

	// sharesUnaccounted is shares found locally but not yet judged by the pool
	// (found − accepted − rejected, clamped at 0). Small values are normal
	// in-flight latency; a sustained/growing value means found shares are not
	// reaching the pool — the local-vs-pool reconciliation signal.
	sharesUnaccounted *metrics.Gauge

	// productiveSeconds accumulates wall-clock seconds the miner actually
	// produced hashrate (not stalled, not curtailed). Effective uptime =
	// productive_seconds_total / uptime_seconds — the reliability number that
	// dominates yield more than fee differences do.
	productiveSeconds *metrics.Counter

	// rejectRate is the complement of shareAcceptanceRate: rejected /
	// (accepted + rejected). Having it as an explicit gauge lets operators
	// build simple threshold alerts without PromQL arithmetic. Maps to the
	// <0.5% excellent … >3% act-now thresholds from D-Central's guide.
	rejectRate *metrics.Gauge
	// staleRate is the fraction of total judged shares that were rejected
	// with a "stale" reason (network-latency driven). Separating it from
	// the overall reject rate makes it easy to distinguish latency problems
	// from hardware errors in Grafana without parsing label sets.
	staleRate *metrics.Gauge

	// up reflects whether the miner is currently producing hashrate
	// (1) or has stalled (0); a scrape can alert on a wedged miner.
	up *metrics.Gauge
	// curtailed is 1 when hashing has been paused due to the
	// curtail_below_btc_usd threshold; 0 otherwise. Distinct from
	// otedama_up (which reflects the miner stalling, not a deliberate pause).
	curtailed *metrics.Gauge
	// powerWatts is the user-configured system power draw in watts.
	// 0 when not configured (power_watts = 0).
	powerWatts *metrics.Gauge
	// joulesPerTerahash = powerWatts × 1e12 / hashrate. Only meaningful
	// when powerWatts > 0; set to 0 otherwise.
	joulesPerTerahash *metrics.Gauge
	// powerCostUSDPerHour = powerWatts/1000 × electricity_price_per_kwh, the
	// cost half of profitability. Constant for a run; set once at startup when
	// both power and price are configured.
	powerCostUSDPerHour *metrics.Gauge
	// poolConnectionState is 0=disconnected, 1=connecting, 2=connected;
	// poolActiveIndex is the 0-based index of the active pool in the
	// configured failover list, so failover is observable.
	poolConnectionState *metrics.Gauge
	poolActiveIndex     *metrics.Gauge
	// payoutActiveIndex is the 0-based index of the active payout address
	// in the configured failover list, so address failover is observable.
	payoutActiveIndex *metrics.Gauge
	// buildInfo is the standard `_info` metric: constant 1, with the
	// version/commit/goversion carried as labels for fleet tracking.
	buildInfo *metrics.Gauge

	// lastJobReceivedAt is a Unix-timestamp gauge updated on every
	// mining.notify / NewMiningJob message from the pool.  A scrape can
	// alert when the value is older than, say, 2× the pool's expected
	// notify interval (typically 30–60 s), which reliably surfaces stale
	// pool connections that look "connected" but deliver no work.
	lastJobReceivedAt *metrics.Gauge

	// reg is retained so reject counters can be created lazily, one per
	// reject category (stale/duplicate/difficulty/hardware/other).
	reg            *metrics.Registry
	rejectByReason map[string]*metrics.Counter

	// sharesFoundPerDevice tracks shares found per device
	// (otedama_device_shares_found_total{device="cpu-0"}).
	// Created lazily when the first share from each device arrives;
	// the device set is bounded to detected hardware so cardinality is safe.
	sharesFoundPerDeviceMu sync.Mutex
	sharesFoundPerDevice   map[string]*metrics.Counter

	// payoutInfo exposes the active payout destination as
	// otedama_payout_info{address="bc1q…mdq"} — the series valued 1 is the
	// masked address currently receiving rewards. It lets an operator confirm,
	// via /metrics, that a non-custodial instance is paying to the address they
	// expect even after payout-address failover. Masked (first6…last4) like the
	// logs; the address set is bounded to the configured failover list.
	payoutInfoMu       sync.Mutex
	payoutInfo         map[string]*metrics.Gauge
	payoutActiveMasked string
}

func newEngineMetrics(reg *metrics.Registry) *engineMetrics {
	info := version.Get()
	m := &engineMetrics{
		hashrate: reg.NewGauge(
			"otedama_hashrate_hashes_per_second",
			"Current aggregate hashrate in hashes per second.",
			nil),
		sharesFound: reg.NewCounter(
			"otedama_shares_found_total",
			"Total shares found locally by all workers.",
			nil),
		sharesAccepted: reg.NewCounter(
			"otedama_shares_total",
			"Total shares reported by the pool.",
			map[string]string{"status": "accepted"}),
		sharesRejected: reg.NewCounter(
			"otedama_shares_total",
			"Total shares reported by the pool.",
			map[string]string{"status": "rejected"}),
		poolConnectAttempts: reg.NewCounter(
			"otedama_pool_connect_attempts_total",
			"Total pool-connection attempts, including reconnects.",
			nil),
		poolConnectFailures: reg.NewCounter(
			"otedama_pool_connect_failures_total",
			"Total pool-connection failures.",
			nil),
		arbitrationSwitches: reg.NewCounter(
			"otedama_arbitration_switches_total",
			"Total arbitration workload switches (mining ↔ AI).",
			nil),
		arbitrationHolds: reg.NewCounter(
			"otedama_arbitration_holds_total",
			"Total decisions where a higher-yielding stream existed but hysteresis "+
				"kept the current one. Rising vs switches indicates the hysteresis "+
				"margin may be too high (yield left on the table).",
			nil),
		activeStreams: reg.NewGauge(
			"otedama_active_streams",
			"Number of live revenue streams in arbitration after pruning stale "+
				"(dead-provider) quotes. A drop indicates a provider stopped quoting.",
			nil),
		btcUSDRate: reg.NewGauge(
			"otedama_btc_usd_rate",
			"Current BTC/USD rate from provider consensus.",
			nil),
		uptime: reg.NewGauge(
			"otedama_uptime_seconds",
			"Seconds since engine start.",
			nil),
		startTime: reg.NewGauge(
			"otedama_start_time_seconds",
			"Unix timestamp at which engine started.",
			nil),

		submitLatencyP50: reg.NewGauge(
			"otedama_submit_latency_milliseconds",
			"Share-submission round-trip latency (submit→accept).",
			map[string]string{"quantile": "0.5"}),
		submitLatencyP95: reg.NewGauge(
			"otedama_submit_latency_milliseconds",
			"Share-submission round-trip latency (submit→accept).",
			map[string]string{"quantile": "0.95"}),
		submitLatencyP99: reg.NewGauge(
			"otedama_submit_latency_milliseconds",
			"Share-submission round-trip latency (submit→accept).",
			map[string]string{"quantile": "0.99"}),

		shareAcceptanceRate: reg.NewGauge(
			"otedama_share_acceptance_rate",
			"Accepted shares / total judged shares (1.0 = all accepted).",
			nil),
		sharesUnaccounted: reg.NewGauge(
			"otedama_shares_unaccounted",
			"Shares found locally but not yet judged by the pool (found − accepted − "+
				"rejected, clamped at 0). A sustained or growing value means found shares "+
				"are not reaching the pool (submission failures or drops).",
			nil),
		productiveSeconds: reg.NewCounter(
			"otedama_productive_seconds_total",
			"Cumulative wall-clock seconds the miner actually produced hashrate "+
				"(not stalled, not curtailed). Effective uptime = this / otedama_uptime_seconds.",
			nil),
		rejectRate: reg.NewGauge(
			"otedama_reject_rate",
			"Rejected shares / total judged shares (complement of acceptance_rate). "+
				"<0.005 excellent, >0.03 investigate immediately.",
			nil),
		staleRate: reg.NewGauge(
			"otedama_stale_rate",
			"Stale-rejected shares / total judged shares. "+
				"High values indicate network latency or a pool that is too far away.",
			nil),

		up: reg.NewGauge(
			"otedama_up",
			"1 if the miner is healthy (hashing, or intentionally paused by "+
				"curtailment), 0 if it has stalled when it should be hashing. "+
				"Use otedama_curtailed to distinguish a deliberate pause.",
			nil),
		curtailed: reg.NewGauge(
			"otedama_curtailed",
			"1 if hashing is paused because BTC/USD is below curtail_below_btc_usd threshold, else 0.",
			nil),
		powerWatts: reg.NewGauge(
			"otedama_power_watts",
			"Configured total system power draw in watts (from power_watts config). 0 when not set.",
			nil),
		joulesPerTerahash: reg.NewGauge(
			"otedama_joules_per_terahash",
			"Energy efficiency: watts × 1e12 / hashrate. 0 when power_watts is not configured.",
			nil),
		powerCostUSDPerHour: reg.NewGauge(
			"otedama_power_cost_usd_per_hour",
			"Estimated electricity cost: power_watts/1000 × electricity_price_per_kwh. "+
				"Combine with the BTC/USD rate and revenue to see net profit. "+
				"0 when power_watts or electricity_price_per_kwh is unset.",
			nil),
		poolConnectionState: reg.NewGauge(
			"otedama_pool_connection_state",
			"Pool connection state: 0=disconnected, 1=connecting, 2=connected.",
			nil),
		poolActiveIndex: reg.NewGauge(
			"otedama_pool_active_index",
			"0-based index of the active pool in the configured failover list.",
			nil),
		payoutActiveIndex: reg.NewGauge(
			"otedama_payout_active_index",
			"0-based index of the active payout address in the failover list.",
			nil),
		buildInfo: reg.NewGauge(
			"otedama_build_info",
			"Build information (constant 1); version/commit/goversion are labels.",
			map[string]string{
				"version":   info.Version,
				"commit":    info.Commit,
				"goversion": info.GoVersion,
			}),

		lastJobReceivedAt: reg.NewGauge(
			"otedama_last_job_received_seconds",
			"Unix timestamp of the most recent mining job received from the pool. "+
				"Alert when this is older than 2× the pool's expected notify interval "+
				"(~30–60 s) to detect a stale connection that looks connected but delivers no work.",
			nil),

		reg:                  reg,
		rejectByReason:       make(map[string]*metrics.Counter),
		sharesFoundPerDevice: make(map[string]*metrics.Counter),
		payoutInfo:           make(map[string]*metrics.Gauge),
	}
	// build_info is a constant series; its value carries no information,
	// only its label set does (standard Prometheus `_info` convention).
	m.buildInfo.Set(1)
	return m
}

// rejectReason returns (creating on first use) the counter for rejected
// shares of a given category, exposed as
// otedama_shares_rejected_by_reason_total{reason="..."}. Categories come
// from rejectClass (stale/duplicate/difficulty/hardware/other), giving
// operators a breakdown of *why* shares are being rejected — the signal
// that maps directly to the fix (latency vs hardware vs config).
func (m *engineMetrics) rejectReason(category string) *metrics.Counter {
	if c, ok := m.rejectByReason[category]; ok {
		return c
	}
	c := m.reg.NewCounter(
		"otedama_shares_rejected_by_reason_total",
		"Rejected shares broken down by inferred root cause.",
		map[string]string{"reason": category})
	m.rejectByReason[category] = c
	return c
}

// incSharesFoundForDevice increments the per-device shares-found counter
// (otedama_device_shares_found_total{device="cpu-0"}).
// Safe for concurrent use; counters are created lazily on first call for
// a given deviceID. If deviceID is empty, the call is a no-op.
func (m *engineMetrics) incSharesFoundForDevice(deviceID string) {
	if deviceID == "" {
		return
	}
	m.sharesFoundPerDeviceMu.Lock()
	c, ok := m.sharesFoundPerDevice[deviceID]
	if !ok {
		c = m.reg.NewCounter(
			"otedama_device_shares_found_total",
			"Total shares found by this device. "+
				"Per-device breakdown of otedama_shares_found_total.",
			map[string]string{"device": deviceID},
		)
		m.sharesFoundPerDevice[deviceID] = c
	}
	m.sharesFoundPerDeviceMu.Unlock()
	c.Inc()
}

// setActivePayout marks masked as the active payout destination:
// otedama_payout_info{address="<masked>"} = 1, with the previously-active
// series set to 0 so exactly one series reads 1 at a time. Gauges are created
// lazily per masked address (bounded to the configured failover list) and the
// no-op fast path avoids churn when the active address is unchanged. Safe for
// concurrent use. An empty masked string is ignored.
func (m *engineMetrics) setActivePayout(masked string) {
	if masked == "" {
		return
	}
	m.payoutInfoMu.Lock()
	defer m.payoutInfoMu.Unlock()
	if masked == m.payoutActiveMasked {
		return
	}
	if prev := m.payoutActiveMasked; prev != "" {
		if g, ok := m.payoutInfo[prev]; ok {
			g.Set(0)
		}
	}
	g, ok := m.payoutInfo[masked]
	if !ok {
		g = m.reg.NewGauge(
			"otedama_payout_info",
			"Active payout destination (masked). The series valued 1 is the address "+
				"currently receiving rewards; tracks payout-address failover.",
			map[string]string{"address": masked},
		)
		m.payoutInfo[masked] = g
	}
	g.Set(1)
	m.payoutActiveMasked = masked
}

// updateShareRates recomputes the acceptance/reject/stale rate gauges from
// the current share counters. Returns the acceptance rate and the number of
// judged shares so the caller can decide whether to log a warning. Safe to
// call with no shares judged yet (returns rate=1.0, judged=0).
//
// It also reconciles local discovery against the pool's numbers: shares found
// locally but not yet judged by the pool are exposed as otedama_shares_unaccounted.
// A few in-flight shares are normal (submit→accept latency); a sustained or
// growing value means found shares are not reaching the pool — submission
// failures or drops that would otherwise be invisible (the "trust the pool's
// numbers" reconciliation, RESEARCH_IMPROVEMENTS Category 1 item 10).
func (m *engineMetrics) updateShareRates() (rate float64, judged uint64) {
	accepted := m.sharesAccepted.Value()
	rejected := m.sharesRejected.Value()
	judged = accepted + rejected
	rate = acceptanceRate(accepted, rejected)
	m.shareAcceptanceRate.Set(rate)

	// Reconcile: found locally vs judged by the pool. Clamp at 0 — the pool
	// can briefly report more judged than we have locally counted if a stats
	// tick races a burst of accepts, and a negative "unaccounted" is meaningless.
	found := m.sharesFound.Value()
	var unaccounted uint64
	if found > judged {
		unaccounted = found - judged
	}
	m.sharesUnaccounted.Set(float64(unaccounted))

	if judged == 0 {
		m.rejectRate.Set(0)
		m.staleRate.Set(0)
		return rate, judged
	}
	m.rejectRate.Set(float64(rejected) / float64(judged))
	var stale uint64
	if c, ok := m.rejectByReason["stale"]; ok {
		stale = c.Value()
	}
	m.staleRate.Set(float64(stale) / float64(judged))
	return rate, judged
}
