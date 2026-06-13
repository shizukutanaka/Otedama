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
	btcUSDRate          *metrics.Gauge
	uptime              *metrics.Gauge
	startTime           *metrics.Gauge

	submitLatencyP50 *metrics.Gauge
	submitLatencyP95 *metrics.Gauge
	submitLatencyP99 *metrics.Gauge

	shareAcceptanceRate *metrics.Gauge

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
			"1 if the miner is producing hashrate (not stalled), else 0.",
			nil),
		curtailed: reg.NewGauge(
			"otedama_curtailed",
			"1 if hashing is paused because BTC/USD is below curtail_below_btc_usd threshold, else 0.",
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

// updateShareRates recomputes the acceptance/reject/stale rate gauges from
// the current share counters. Returns the acceptance rate and the number of
// judged shares so the caller can decide whether to log a warning. Safe to
// call with no shares judged yet (returns rate=1.0, judged=0).
func (m *engineMetrics) updateShareRates() (rate float64, judged uint64) {
	accepted := m.sharesAccepted.Value()
	rejected := m.sharesRejected.Value()
	judged = accepted + rejected
	rate = acceptanceRate(accepted, rejected)
	m.shareAcceptanceRate.Set(rate)
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
