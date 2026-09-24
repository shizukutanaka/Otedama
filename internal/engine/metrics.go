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
	"time"

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
	sharesSubmitted     *metrics.Counter
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
	// arbitrationConfirmationHolds counts the subset of arbitrationHolds where
	// the suppressed best candidate was an unconfirmed stream — ADR-010 A7's
	// confirmation ladder firing rather than the hysteresis margin. A rising
	// count means new streams repeatedly try to displace incumbents before
	// their k quote confirmations — eager honest entrants or yield-lure
	// attempts; the split tells them apart over time.
	arbitrationConfirmationHolds *metrics.Counter
	// arbitrationForegoneSatsPerSec is the instantaneous opportunity cost of the
	// current allocation: summed across devices, the raw sats/second sacrificed
	// versus routing purely by yield. It is the *magnitude* companion to
	// arbitrationHolds (a count): non-zero whenever hysteresis holds a device or
	// a non-earnings policy prefers a lower-yield stream, letting an operator see
	// what stability/policy preferences cost per second and tune accordingly.
	arbitrationForegoneSatsPerSec *metrics.Gauge
	// arbitrationExpectedYieldSatsPerSec is the engine's own forecast of the
	// current REAL earning rate: the summed ExpectedYield of chosen
	// assignments whose stream quotes live-market prices. Simulated streams
	// (providers still modeling prices, e.g. ai.akash in v3.0.0-alpha) are
	// excluded — they publish to arbitrationSimulatedYieldSatsPerSec — so
	// this gauge never mixes modeled revenue into real-earnings accounting
	// (it also feeds the TUI's lifetime-sats accumulator, which would
	// otherwise accrue fake income). Publishing the forecast is what makes
	// it accountable — an operator can compare this expectation against
	// realized earnings (accepted shares × difficulty value) to detect when
	// provider quotes are over-optimistic or hardware is underperforming.
	// The expectation half of the expectation-vs-realization pair.
	arbitrationExpectedYieldSatsPerSec *metrics.Gauge
	// arbitrationSimulatedYieldSatsPerSec is the summed ExpectedYield of
	// chosen assignments on streams whose provider flags its quotes as
	// Simulated — the separated half of the split above, exposed so
	// modeled revenue stays visible (for observing what the simulated
	// providers claim) without ever inflating the real-earnings total.
	arbitrationSimulatedYieldSatsPerSec *metrics.Gauge
	// effectiveYieldSatsPerSec is arbitrationExpectedYieldSatsPerSec scaled by
	// the lifetime productive fraction (productiveSeconds / uptime) — see
	// effectiveYield in stats.go. Unlike the instantaneous expected-yield
	// gauge, this reflects downtime: a device quoted at X sats/s that only
	// hashes half the time reads as X/2 here, matching what it actually nets.
	effectiveYieldSatsPerSec *metrics.Gauge
	// activeStreams is the number of live revenue streams arbitration is
	// choosing between after stale (dead-provider) streams are pruned. A
	// drop here surfaces a provider that has stopped quoting.
	activeStreams *metrics.Gauge
	// devicesIdle is the number of devices left unassigned this cycle — either
	// because no compatible stream accepts them or because no accepting stream
	// cleared the min_yield_sats_per_sec floor. A persistent non-zero value
	// after setting the floor means it is parking hardware; tune it down if that
	// is not intended.
	devicesIdle *metrics.Gauge
	btcUSDRate  *metrics.Gauge
	uptime      *metrics.Gauge
	startTime   *metrics.Gauge

	submitLatencyP50 *metrics.Gauge
	submitLatencyP95 *metrics.Gauge
	submitLatencyP99 *metrics.Gauge

	// submitLatencyHist is the native-bucket counterpart of the quantile
	// gauges: every settled share→verdict round-trip lands in a le bucket
	// carrying an exemplar ({job_id}) so a p99 spike links directly to
	// the submission that produced it — the trace-join the gauges cannot
	// express (RESEARCH_IMPROVEMENTS Cat 9/10 item 20). Registered under the canonical _seconds unit; the
	// _milliseconds gauges remain for the documented SLO contract.
	submitLatencyHist *metrics.Histogram

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
	// curtailed is 1 when hashing has been paused by either curtail gate
	// (curtail_below_btc_usd or curtail_above_uk_carbon); 0 otherwise.
	// Distinct from otedama_up (which reflects the miner stalling, not a
	// deliberate pause).
	curtailed *metrics.Gauge
	// carbonIntensity is the latest GB grid carbon intensity forecast
	// (gCO2/kWh) published by the carbon-curtailment poll; 0 until the
	// first reading when curtail_above_uk_carbon is enabled.
	carbonIntensity *metrics.Gauge
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
	// electricityTariffPence is the current unit rate of the configured
	// Octopus Energy tariff (pence/kWh, incl. VAT) published by the tariff
	// poll; 0 until the first reading when electricity_tariff_octopus is
	// configured. Named in pence to prevent silent mixing with the
	// USD-denominated electricity_price_per_kwh.
	electricityTariffPence *metrics.Gauge
	// tariffForwardMin/MaxPence are the min/max unit price across the
	// fetched forward curve (~24h of half-hourly Agile slots) — the
	// envelope an operator alerts on: max > threshold warns that a
	// curtail window is coming, min locates the cheapest upcoming slot.
	tariffForwardMinPence *metrics.Gauge
	tariffForwardMaxPence *metrics.Gauge
	// poolConnectionState is 0=disconnected, 1=connecting, 2=connected;
	// poolActiveIndex is the 0-based index of the active pool in the
	// configured failover list, so failover is observable.
	poolConnectionState *metrics.Gauge
	poolActiveIndex     *metrics.Gauge
	// poolShareSeen dedups the one-shot pool network-share lookup per pool
	// host across reconnects, so a fast reconnect loop cannot hammer the
	// public distribution endpoint. The otedama_pool_network_share gauge
	// itself is created lazily per pool_host label (like rejectReason).
	poolShareSeenMu sync.Mutex
	poolShareSeen   map[string]bool
	// asicManagedHost records which pool host was last pushed to the
	// managed ASICs so reconnects to the same pool don't re-issue the
	// cgminer switchpool — but a failover onto a *different* pool does
	// push again (the fleet follows the active endpoint). Guarded by
	// asicManagedMu; "" means nothing pushed yet this run.
	asicManagedMu   sync.Mutex
	asicManagedHost string
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

	// clockSkewSeconds is the maximum absolute offset (in seconds) observed
	// between the local system clock and the wall-clock reported by BTC/USD
	// rate-source HTTPS servers via their HTTP Date response headers. Reuses
	// existing HTTPS traffic — no NTP dependency, no new endpoints. Alert
	// when >120 s: TLS certificate validation, mining nTime fields, and
	// rate-freshness judgements all break at that magnitude.
	clockSkewSeconds *metrics.Gauge

	// btcRateAgeSeconds is how long ago the BTC/USD rate was last successfully
	// fetched. 0 until the first success. Unlike otedama_btc_usd_rate (which
	// keeps showing the last good value indefinitely when sources fail), this
	// rises monotonically during an outage — making "silent staleness" of the
	// price feed alertable (e.g. age > 2× the 5-min refresh interval).
	btcRateAgeSeconds *metrics.Gauge

	// rateSourcesOK / rateSourcesTotal expose the *redundancy health* behind the
	// BTC/USD median, not just the value it produces. ok is how many sources
	// returned a usable in-band reading in the last fetch; total is how many are
	// configured. The rate gauge reads identically whether backed by 3 sources
	// or 1, so ok < total is the only signal of silent redundancy erosion before
	// the feed fails outright (ok == 0).
	rateSourcesOK    *metrics.Gauge
	rateSourcesTotal *metrics.Gauge

	// poolDifficulty is the current share difficulty assigned by the pool via
	// mining.set_difficulty. 0 until the first set_difficulty is received. A
	// drop signals the pool is giving the miner easier work (lost var-diff
	// trust, or insufficient hashrate); a sustained high value with near-zero
	// shares_found reveals a misconfigured or malicious pool.
	poolDifficulty *metrics.Gauge
	// estimatedShareIntervalSeconds = poolDifficulty × 2^32 / hashrate.
	// The expected wall-clock seconds between consecutive found shares at the
	// current pool difficulty and hashrate. 0 when either input is unknown.
	// Use to distinguish "hardware is slow" from "difficulty is too high".
	estimatedShareIntervalSeconds *metrics.Gauge

	// reg is retained so reject counters can be created lazily, one per
	// reject category (stale/duplicate/difficulty/hardware/other).
	reg              *metrics.Registry
	rejectByReasonMu sync.Mutex
	rejectByReason   map[string]*metrics.Counter

	// lastRejectByReason holds otedama_last_reject_seconds{reason="..."} gauges,
	// one per reject category, created lazily on first rejection of that type.
	// The gauge value is the Unix timestamp of the most recent rejection in that
	// category, so operators can tell whether a high reject count represents an
	// ongoing problem (last_reject == now) or a past event that has cleared
	// (last_reject is hours old). Pairs with rejectByReason counts to distinguish
	// "count rose a while ago, has since recovered" from "still happening now".
	lastRejectByReasonMu sync.Mutex
	lastRejectByReason   map[string]*metrics.Gauge

	// sharesFoundPerDevice tracks shares found per device
	// (otedama_device_shares_found_total{device="cpu-0"}).
	// Created lazily when the first share from each device arrives;
	// the device set is bounded to detected hardware so cardinality is safe.
	sharesFoundPerDeviceMu sync.Mutex
	sharesFoundPerDevice   map[string]*metrics.Counter
	// switchVerdicts counts settled arbitration switches by outcome
	// (otedama_arbitration_switch_verdicts_total{verdict=...}); created lazily.
	switchVerdictsMu sync.Mutex
	switchVerdicts   map[string]*metrics.Counter
	// arbitrationLastSwitchGain is the realized-gain reading of the most recent
	// settled switch verdict (realized expected yield minus the abandoned
	// stream's current offer); only set on verifiable verdicts.
	arbitrationLastSwitchGain *metrics.Gauge

	// providerReliability exposes otedama_arbitration_provider_reliability
	// {provider="..."} — the Beta-Bernoulli posterior mean (ADR-010 A6) the
	// arbitration loop currently discounts each provider's quotes by. One
	// gauge per provider ID, created lazily on first epoch outcome; the
	// provider set is bounded to configured/quoting providers.
	providerReliabilityMu sync.Mutex
	providerReliability   map[string]*metrics.Gauge

	// yieldForecast / forecastMisses expose the Holt-Winters per-stream
	// forecaster (ADR-010 A1): the one-step-ahead predicted yield gauge
	// otedama_arbitration_yield_forecast_sats_per_second{stream,device} and
	// the >2σ miss counter otedama_arbitration_forecast_misses_total
	// {stream,device} — the divergence signal A8's regime reset consumes.
	yieldForecastMu  sync.Mutex
	yieldForecast    map[[2]string]*metrics.Gauge
	forecastMisses   map[[2]string]*metrics.Counter
	forecasterResets map[[2]string]*metrics.Counter

	// streamLastQuote exposes each live stream's last-quote timestamp as
	// otedama_stream_last_quote_unixtime{stream,device} — the provider
	// liveness/heartbeat half of RESEARCH_IMPROVEMENTS Cat 5 #3. Reading
	// `time() - value` gives quote age, so a dead provider is alertable
	// before (and independently of) the prune-based reliability update.
	// The series intentionally keeps its final timestamp after the stream
	// is pruned — "last quote was 10 min ago" is exactly the dead-provider
	// signal; deleting it would erase the evidence.
	streamLastQuoteMu sync.Mutex
	streamLastQuote   map[[2]string]*metrics.Gauge

	// streamDrift tracks per-(stream,device) yield-drift series: significant
	// shift counters and accumulated |Δyield| gauges, created lazily.
	streamDriftMu       sync.Mutex
	streamDriftShifts   map[string]*metrics.Counter
	streamDriftTotalVar map[string]*metrics.Gauge

	// payoutInfo exposes the active payout destination as
	// otedama_payout_info{address="bc1q…mdq"} — the series valued 1 is the
	// masked address currently receiving rewards. It lets an operator confirm,
	// via /metrics, that a non-custodial instance is paying to the address they
	// expect even after payout-address failover. Masked (first6…last4) like the
	// logs; the address set is bounded to the configured failover list.
	payoutInfoMu       sync.Mutex
	payoutInfo         map[string]*metrics.Gauge
	payoutActiveMasked string

	// thermalSensors tracks otedama_thermal_sensor_celsius{source,label},
	// one gauge per hwmon sensor (e.g. {source="k10temp",label="Tctl"}).
	// Created lazily on first observation; the sensor set is bounded to
	// whatever the OS exposes so cardinality is safe.
	thermalSensorsMu sync.Mutex
	thermalSensors   map[string]*metrics.Gauge
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
		sharesSubmitted: reg.NewCounter(
			"otedama_shares_submitted_total",
			"Total shares actually transmitted to the pool (mining.submit / "+
				"SubmitSharesStandard), incremented at send time regardless of "+
				"the pool's eventual accept/reject response. Distinct from "+
				"shares_found_total: a share can be found by a worker but never "+
				"submitted if its worker's share channel was full (a rate the "+
				"engine only currently logs, as \"dropped N found share(s)\").",
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
		arbitrationConfirmationHolds: reg.NewCounter(
			"otedama_arbitration_confirmation_holds_total",
			"Total held decisions where the suppressed candidate was an "+
				"unconfirmed stream awaiting k quote confirmations (ADR-010 "+
				"A7 confirmation ladder). Subset of "+
				"otedama_arbitration_holds_total.",
			nil),
		arbitrationLastSwitchGain: reg.NewGauge(
			"otedama_arbitration_last_switch_realized_gain_sats_per_second",
			"Realized gain of the most recent settled arbitration switch: the device's "+
				"current expected yield minus what the abandoned stream now offers it. "+
				"Negative means the switch churned yield the hysteresis margin failed to "+
				"protect. Updated only on verifiable verdicts (paid_off or churn).",
			nil),
		arbitrationForegoneSatsPerSec: reg.NewGauge(
			"otedama_arbitration_foregone_sats_per_second",
			"Instantaneous opportunity cost of the current allocation: raw sats/s "+
				"sacrificed versus routing purely by yield, summed across devices. "+
				"Non-zero when hysteresis holds a device or a non-earnings policy "+
				"prefers a lower-yield stream. The magnitude companion to "+
				"otedama_arbitration_holds_total.",
			nil),
		arbitrationExpectedYieldSatsPerSec: reg.NewGauge(
			"otedama_arbitration_expected_yield_sats_per_second",
			"The engine's forecast REAL earning rate: summed ExpectedYield of the chosen "+
				"allocation restricted to streams quoting live-market prices (simulated "+
				"streams publish to otedama_arbitration_simulated_yield_sats_per_second "+
				"instead). Compare against realized earnings to judge whether provider "+
				"quotes are accurate; combine with otedama_btc_usd_rate for an expected "+
				"$/day.",
			nil),
		arbitrationSimulatedYieldSatsPerSec: reg.NewGauge(
			"otedama_arbitration_simulated_yield_sats_per_second",
			"The engine's forecast earning rate from SIMULATED streams only — "+
				"providers whose quotes are modeled rather than live-market (e.g. "+
				"ai.akash in v3.0.0-alpha). Kept separate so modeled revenue never "+
				"inflates the real-earnings total; expect this to read 0 on rigs "+
				"with no GPUs routed to simulated providers.",
			nil),
		effectiveYieldSatsPerSec: reg.NewGauge(
			"otedama_effective_yield_sats_per_second",
			"Gross-minus-losses yield: otedama_arbitration_expected_yield_sats_per_second "+
				"scaled by the lifetime productive fraction (otedama_productive_seconds_total "+
				"/ otedama_uptime_seconds). Reliability dwarfs fee differences — a few percent "+
				"of downtime costs more than most inter-pool fee gaps — so this single number "+
				"captures both effects, unlike the instantaneous expected-yield gauge which "+
				"reads unchanged during a stall.",
			nil),
		activeStreams: reg.NewGauge(
			"otedama_active_streams",
			"Number of live revenue streams in arbitration after pruning stale "+
				"(dead-provider) quotes. A drop indicates a provider stopped quoting.",
			nil),
		devicesIdle: reg.NewGauge(
			"otedama_devices_idle",
			"Number of devices left idle this arbitration cycle (no compatible "+
				"stream, or none clearing the min_yield_sats_per_sec floor).",
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

		submitLatencyHist: reg.NewHistogram(
			"otedama_submit_latency_seconds",
			"Share-submission round-trip latency (submit→verdict). "+
				"Buckets carry an exemplar ({job_id}) "+
				"linking each observation to the submission that produced it.",
			nil,
			[]float64{0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10}),

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
			"1 if hashing is paused by curtailment (BTC/USD below curtail_below_btc_usd, or "+
				"UK grid carbon intensity above curtail_above_uk_carbon), else 0.",
			nil),
		carbonIntensity: reg.NewGauge(
			"otedama_uk_grid_carbon_intensity",
			"GB grid carbon intensity forecast in gCO2/kWh (api.carbonintensity.org.uk, "+
				"10-min poll). 0 until the first reading; only populated when "+
				"curtail_above_uk_carbon is configured.",
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
		electricityTariffPence: reg.NewGauge(
			"otedama_electricity_tariff_pence_per_kwh",
			"Current electricity unit rate in pence/kWh incl. VAT (Octopus Energy "+
				"tariff feed, 15-min poll). 0 until the first reading; only populated "+
				"when electricity_tariff_octopus is configured.",
			nil),
		tariffForwardMinPence: reg.NewGauge(
			"otedama_electricity_tariff_forward_min_pence_per_kwh",
			"Minimum unit price across the fetched forward Agile curve "+
				"(~24h of half-hourly slots) — the cheapest upcoming slot. "+
				"0 until the first reading.",
			nil),
		tariffForwardMaxPence: reg.NewGauge(
			"otedama_electricity_tariff_forward_max_pence_per_kwh",
			"Maximum unit price across the fetched forward Agile curve "+
				"(~24h of half-hourly slots) — alert when it exceeds the "+
				"curtailment threshold to get lead time on a curtail window. "+
				"0 until the first reading.",
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

		clockSkewSeconds: reg.NewGauge(
			"otedama_clock_skew_seconds",
			"Maximum absolute offset (s) between the local system clock and the "+
				"wall-clock reported by BTC/USD rate-source servers via HTTP Date "+
				"headers. 0 until the first successful fetch. Alert when >120: TLS "+
				"certificate validation, mining nTime, and rate freshness break.",
			nil),

		btcRateAgeSeconds: reg.NewGauge(
			"otedama_btc_rate_age_seconds",
			"Seconds since the BTC/USD rate was last successfully fetched. 0 until "+
				"the first success. Rises during a price-source outage even while "+
				"otedama_btc_usd_rate still shows the last good value; alert when this "+
				"exceeds ~2× the refresh interval to catch silent staleness.",
			nil),
		rateSourcesOK: reg.NewGauge(
			"otedama_rate_sources_ok",
			"Number of BTC/USD price sources that returned a usable in-band reading "+
				"in the last fetch. Compare with otedama_rate_sources_total: ok < total "+
				"means the median is running on degraded redundancy (alert before ok=0).",
			nil),
		rateSourcesTotal: reg.NewGauge(
			"otedama_rate_sources_total",
			"Number of BTC/USD price sources configured. The denominator for "+
				"otedama_rate_sources_ok.",
			nil),

		poolDifficulty: reg.NewGauge(
			"otedama_pool_difficulty",
			"Current share difficulty assigned by the pool (mining.set_difficulty). "+
				"0 until the first assignment. A sudden drop indicates lost var-diff "+
				"trust; a high value with near-zero shares_found indicates difficulty "+
				"is above what the local hashrate can serve within a reasonable interval.",
			nil),
		estimatedShareIntervalSeconds: reg.NewGauge(
			"otedama_estimated_share_interval_seconds",
			"Expected wall-clock seconds between consecutive shares: "+
				"pool_difficulty × 2^32 / hashrate. 0 when difficulty or hashrate "+
				"is unknown. Use to distinguish 'hardware is slow' from 'difficulty "+
				"is too high' when shares_found drops.",
			nil),

		reg:                  reg,
		poolShareSeen:        make(map[string]bool),
		rejectByReason:       make(map[string]*metrics.Counter),
		lastRejectByReason:   make(map[string]*metrics.Gauge),
		sharesFoundPerDevice: make(map[string]*metrics.Counter),
		providerReliability:  make(map[string]*metrics.Gauge),
		yieldForecast:        make(map[[2]string]*metrics.Gauge),
		forecastMisses:       make(map[[2]string]*metrics.Counter),
		forecasterResets:     make(map[[2]string]*metrics.Counter),
		streamLastQuote:      make(map[[2]string]*metrics.Gauge),
		switchVerdicts:       make(map[string]*metrics.Counter),
		streamDriftShifts:    make(map[string]*metrics.Counter),
		streamDriftTotalVar:  make(map[string]*metrics.Gauge),
		payoutInfo:           make(map[string]*metrics.Gauge),
		thermalSensors:       make(map[string]*metrics.Gauge),
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
// The additional label "difficulty-change" is emitted not by rejectClass
// but by the V1 submit path for benign cross-generation rejects: shares
// honestly mined under the previous share difficulty and rejected because
// mining.set_difficulty moved the target mid-flight (ESP-Miner #212).
// Those are counted here for visibility but are NOT added to
// sharesRejected, so they never inflate otedama_reject_rate.
//
// Safe for concurrent use: session submit goroutines resolve verdicts
// concurrently.
func (m *engineMetrics) rejectReason(category string) *metrics.Counter {
	m.rejectByReasonMu.Lock()
	defer m.rejectByReasonMu.Unlock()
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

// observeProviderReliability sets otedama_arbitration_provider_reliability
// {provider=pid} to the provider's Beta-Bernoulli posterior mean (ADR-010
// A6). The gauge is created lazily on first observation. Safe for
// concurrent use.
func (m *engineMetrics) observeProviderReliability(pid string, posterior float64) {
	m.providerReliabilityMu.Lock()
	g, ok := m.providerReliability[pid]
	if !ok {
		g = m.reg.NewGauge(
			"otedama_arbitration_provider_reliability",
			"Beta-Bernoulli posterior mean of this provider's reliability (ADR-010 A6); "+
				"the arbitration loop discounts the provider's quoted confidence by this factor.",
			map[string]string{"provider": pid})
		m.providerReliability[pid] = g
	}
	m.providerReliabilityMu.Unlock()
	g.Set(posterior)
}

// observeYieldForecast sets otedama_arbitration_yield_forecast_sats_per_second
// {stream,device} to the Holt-Winters one-step-ahead prediction (ADR-010 A1).
// Created lazily on first observation. Safe for concurrent use.
func (m *engineMetrics) observeYieldForecast(stream, device string, v float64) {
	key := [2]string{stream, device}
	m.yieldForecastMu.Lock()
	g, ok := m.yieldForecast[key]
	if !ok {
		g = m.reg.NewGauge(
			"otedama_arbitration_yield_forecast_sats_per_second",
			"Holt-Winters one-step-ahead predicted effective yield for this stream "+
				"(ADR-010 A1). Compare with the stream's actual quote series.",
			map[string]string{"stream": stream, "device": device})
		m.yieldForecast[key] = g
	}
	m.yieldForecastMu.Unlock()
	g.Set(v)
}

// observeStreamLastQuote sets otedama_stream_last_quote_unixtime
// {stream,device} to the wall-clock time of the stream's most recent
// quote — the provider heartbeat gauge (RESEARCH_IMPROVEMENTS Cat 5 #3).
// Quote age at scrape time is `time() - value`; a provider that stops
// quoting is alertable on `time() - otedama_stream_last_quote_unixtime`
// exceeding the stale-prune TTL, independent of the reliability update
// the prune itself issues. Created lazily; safe for concurrent use.
func (m *engineMetrics) observeStreamLastQuote(stream, device string, ts time.Time) {
	key := [2]string{stream, device}
	m.streamLastQuoteMu.Lock()
	g, ok := m.streamLastQuote[key]
	if !ok {
		g = m.reg.NewGauge(
			"otedama_stream_last_quote_unixtime",
			"Unix timestamp of this stream's most recent provider quote — the "+
				"heartbeat gauge: a stale value means the provider stopped quoting "+
				"(dead provider), well before the stale-prune TTL drops the stream.",
			map[string]string{"stream": stream, "device": device})
		m.streamLastQuote[key] = g
	}
	m.streamLastQuoteMu.Unlock()
	g.Set(float64(ts.Unix()))
}

// observeForecastMiss increments otedama_arbitration_forecast_misses_total
// {stream,device} when a quote deviates >2σ from the forecast (ADR-010 A1);
// the counter feeds the regime-change detection planned as A8. Safe for
// concurrent use.
func (m *engineMetrics) observeForecastMiss(stream, device string) {
	key := [2]string{stream, device}
	m.yieldForecastMu.Lock()
	c, ok := m.forecastMisses[key]
	if !ok {
		c = m.reg.NewCounter(
			"otedama_arbitration_forecast_misses_total",
			"Quotes deviating >2σ from the Holt-Winters forecast — the regime-change "+
				"signal for ADR-010 A8's forecaster reset.",
			map[string]string{"stream": stream, "device": device})
		m.forecastMisses[key] = c
	}
	m.yieldForecastMu.Unlock()
	c.Inc()
}

// observeForecasterReset increments otedama_arbitration_forecaster_resets_total
// {stream,device} when the A8 change-point check (median of the last-5
// absolute errors > 2σ) fires and the smoother is re-seeded (ADR-010 A8).
// Safe for concurrent use.
func (m *engineMetrics) observeForecasterReset(stream, device string) {
	key := [2]string{stream, device}
	m.yieldForecastMu.Lock()
	c, ok := m.forecasterResets[key]
	if !ok {
		c = m.reg.NewCounter(
			"otedama_arbitration_forecaster_resets_total",
			"Holt-Winters smoother resets triggered by the A8 change-point check "+
				"(median of last-5 errors > 2σ) — one per detected regime break.",
			map[string]string{"stream": stream, "device": device})
		m.forecasterResets[key] = c
	}
	m.yieldForecastMu.Unlock()
	c.Inc()
}

// touchLastReject records the current Unix timestamp as the most recent
// rejection time for category, exposed as
// otedama_last_reject_seconds{reason="..."}. The gauge is created lazily on
// first rejection of that category; subsequent calls update the value.
// Safe for concurrent use.
func (m *engineMetrics) touchLastReject(category string, now int64) {
	m.lastRejectByReasonMu.Lock()
	g, ok := m.lastRejectByReason[category]
	if !ok {
		g = m.reg.NewGauge(
			"otedama_last_reject_seconds",
			"Unix timestamp of the most recent share rejection of this category. "+
				"Pairs with otedama_shares_rejected_by_reason_total to distinguish "+
				"an ongoing rejection problem (value near now) from a past one "+
				"that has since cleared (value hours old).",
			map[string]string{"reason": category})
		m.lastRejectByReason[category] = g
	}
	m.lastRejectByReasonMu.Unlock()
	g.Set(float64(now))
}

// recordSwitchVerdict counts a settled switch under
// otedama_arbitration_switch_verdicts_total{verdict=...} and, when the
// verdict is verifiable (paid_off or churn), updates the realized-gain gauge.
func (m *engineMetrics) recordSwitchVerdict(v switchVerdict, gain float64) {
	m.switchVerdictsMu.Lock()
	c, ok := m.switchVerdicts[string(v)]
	if !ok {
		c = m.reg.NewCounter(
			"otedama_arbitration_switch_verdicts_total",
			"Settled arbitration switches by outcome: paid_off = realized yield at least "+
				"matched the abandoned stream's current offer, churn = the abandoned stream "+
				"now offers more (the switch cost yield), unverifiable = the abandoned stream "+
				"no longer quotes.",
			map[string]string{"verdict": string(v)},
		)
		m.switchVerdicts[string(v)] = c
	}
	m.switchVerdictsMu.Unlock()
	c.Inc()
	if v != verdictUnverifiable {
		m.arbitrationLastSwitchGain.Set(gain)
	}
}

// observeStreamDrift publishes one stream's yield-drift measures:
// increments otedama_stream_yield_shifts_total{stream,device} when the
// observation was a significant shift, and sets the accumulated-variation
// gauge to the tracker's running total. The stream set is bounded to live
// providers × devices, so label cardinality is safe.
func (m *engineMetrics) observeStreamDrift(stream, device string, shifted bool, totalVar float64) {
	key := stream + "/" + device
	m.streamDriftMu.Lock()
	shifts, ok := m.streamDriftShifts[key]
	if !ok {
		shifts = m.reg.NewCounter(
			"otedama_stream_yield_shifts_total",
			"Significant yield shifts for this (stream, device) pair — a change "+
				"exceeding 2% of the prior level, or a zero/positive transition. "+
				"The S (switches) drift measure of non-stationary bandit analysis; "+
				"a high count relative to drift variation means this stream moves "+
				"in regime steps and suits change-point handling.",
			map[string]string{"stream": stream, "device": device},
		)
		m.streamDriftShifts[key] = shifts
	}
	tv, ok := m.streamDriftTotalVar[key]
	if !ok {
		tv = m.reg.NewGauge(
			"otedama_stream_yield_drift_sats_per_second",
			"Accumulated absolute yield variation for this (stream, device) pair "+
				"since startup — the V_T (total variation) drift measure of "+
				"non-stationary bandit analysis. High drift with few shifts means "+
				"smooth wandering suited to a forecaster; many shifts mean jumps.",
			map[string]string{"stream": stream, "device": device},
		)
		m.streamDriftTotalVar[key] = tv
	}
	m.streamDriftMu.Unlock()
	if shifted {
		shifts.Inc()
	}
	tv.Set(totalVar)
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

// setThermalSensor records the latest temperature reading for one hwmon
// sensor, exposed as
// otedama_thermal_sensor_celsius{source="k10temp",label="Tctl"}.
// Safe for concurrent use; gauges are created lazily per sensor. The map
// key is source+"/"+label, matching the exported label pair.
func (m *engineMetrics) setThermalSensor(source, label string, celsius float64) {
	key := source + "/" + label
	m.thermalSensorsMu.Lock()
	g, ok := m.thermalSensors[key]
	if !ok {
		g = m.reg.NewGauge(
			"otedama_thermal_sensor_celsius",
			"Latest temperature reading from an OS thermal (hwmon) sensor, in "+
				"degrees Celsius. Feeds the thermal_throttle_above_celsius gate: "+
				"the hottest series is compared against the configured threshold.",
			map[string]string{"source": source, "label": label})
		m.thermalSensors[key] = g
	}
	m.thermalSensorsMu.Unlock()
	g.Set(celsius)
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
// the current share counters. Returns the acceptance rate, the number of
// judged shares, and the found-but-not-judged backlog so the caller can
// decide whether to log warnings. Safe to call with no shares judged yet
// (returns rate=1.0, judged=0, unaccounted=found).
//
// It also reconciles local discovery against the pool's numbers: shares found
// locally but not yet judged by the pool are exposed as otedama_shares_unaccounted.
// A few in-flight shares are normal (submit→accept latency); a sustained or
// growing value means found shares are not reaching the pool — submission
// failures or drops that would otherwise be invisible (the "trust the pool's
// numbers" reconciliation, RESEARCH_IMPROVEMENTS Category 1 item 10).
func (m *engineMetrics) updateShareRates() (rate float64, judged, unaccounted uint64) {
	accepted := m.sharesAccepted.Value()
	rejected := m.sharesRejected.Value()
	judged = accepted + rejected
	rate = acceptanceRate(accepted, rejected)
	m.shareAcceptanceRate.Set(rate)

	// Reconcile: found locally vs judged by the pool. Clamp at 0 — the pool
	// can briefly report more judged than we have locally counted if a stats
	// tick races a burst of accepts, and a negative "unaccounted" is meaningless.
	found := m.sharesFound.Value()
	if found > judged {
		unaccounted = found - judged
	}
	m.sharesUnaccounted.Set(float64(unaccounted))

	if judged == 0 {
		m.rejectRate.Set(0)
		m.staleRate.Set(0)
		return rate, judged, unaccounted
	}
	m.rejectRate.Set(float64(rejected) / float64(judged))
	var stale uint64
	m.rejectByReasonMu.Lock()
	if c, ok := m.rejectByReason["stale"]; ok {
		stale = c.Value()
	}
	m.rejectByReasonMu.Unlock()
	m.staleRate.Set(float64(stale) / float64(judged))
	return rate, judged, unaccounted
}
