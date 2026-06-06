// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package engine — metrics.go
//
// engineMetrics bundles all Prometheus metric handles updated during
// the run loop. Extracted from run.go so the orchestration logic and
// the metric-registration boilerplate live in separate files.
package engine

import (
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

	// up reflects whether the miner is currently producing hashrate
	// (1) or has stalled (0); a scrape can alert on a wedged miner.
	up *metrics.Gauge
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

	// reg is retained so reject counters can be created lazily, one per
	// reject category (stale/duplicate/difficulty/hardware/other).
	reg            *metrics.Registry
	rejectByReason map[string]*metrics.Counter
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

		up: reg.NewGauge(
			"otedama_up",
			"1 if the miner is producing hashrate (not stalled), else 0.",
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

		reg:            reg,
		rejectByReason: make(map[string]*metrics.Counter),
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
