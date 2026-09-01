# ADR-005: Prometheus exposition without the official client library

**Status:** Accepted
**Date:** 2026-04-22

## Context

Otedama exposes runtime metrics for production monitoring. Prometheus
is the de facto standard scrape target in 2026, and most Go programs
import `github.com/prometheus/client_golang/prometheus` plus its
`promhttp` HTTP handler.

Adopting `client_golang`:

- adds ~15 transitive dependencies, including `protobuf`, `golang/x/sys`
  paths Otedama doesn't otherwise need, and `expfmt` for the
  exposition format;
- adds ~8 MB to the binary (most of it never reached in the hot path);
- ties the project's release schedule to upstream client releases;
- exposes summary, histogram, and exemplar types Otedama doesn't use.

For Otedama's needs — counters and gauges, ten metric definitions —
the Prometheus *text exposition format* is documented and stable, and
implementing it ourselves is on the order of 250 lines of straightforward
code.

## Decision

We implement a minimal metrics package in `internal/metrics/metrics.go`
that:

- Provides `Registry`, `Counter`, `Gauge` types.
- Supports labels with arbitrary string values (correctly escaped per
  the exposition spec).
- Implements `WriteText(io.Writer)` emitting valid Prometheus text
  exposition format version 0.0.4.
- Handles edge cases: NaN, ±Inf, label values containing `"`, `\`, or
  newline.
- Is fully thread-safe under `go test -race`.

We do **not** implement summaries, histograms, or exemplars because
Otedama does not use them. If a future need arises, we will reconsider.

## Consequences

### Positive

- **Two fewer transitive dependencies.** Our `go.mod` direct line
  count remains at three (`x/crypto`, `yaml.v3`, plus stdlib).
- **Binary size unaffected by metrics.** The metrics package compiles
  to a few KB.
- **Format compliance is testable.** Our `WriteText` output is
  byte-compared against expected strings in `metrics_test.go` for every
  important case (label escaping, NaN, Inf, deterministic ordering).
- **Forward compatibility.** The text exposition format has not made
  a breaking change since 2014. We are unlikely to face a churn event.

### Negative

- **No automatic Go runtime metrics.** `client_golang` ships with
  pre-built collectors for `runtime.MemStats`, GC pauses, and
  goroutine count. We have to write these ourselves if needed.
  Currently we only export Otedama-specific metrics; users wanting
  Go runtime metrics can add an exporter sidecar (cAdvisor, node\_exporter).
- **No HTTP middleware.** `promhttp.Handler()` provides a tested HTTP
  handler with content negotiation. Our `httpserver` writes plain text
  with the right Content-Type header — but if Prometheus ever switches
  to a content-negotiated format (the long-discussed OpenMetrics
  protobuf), we will need to add support manually.

### Neutral

- **No labels normalization.** `client_golang` validates that label
  names match `[a-zA-Z_][a-zA-Z0-9_]*` at registration. We trust the
  caller. Otedama only registers a handful of labels at known call
  sites, so the risk is low.

## Alternatives Considered

### Use `prometheus/client_golang`

*Rejected per ADR-003.* The dependency cost outweighs the benefit
for Otedama's modest metrics surface.

### Use `victoriametrics/metrics`

*Considered.* This is a smaller alternative client (~3 dependencies)
designed for the same niche we are filling. We chose to write our own
for two reasons:

1. We cannot validate every dependency's behavior. Owning ~250 lines
   of code is cheaper than auditing an external library.
2. Our metric needs are stable and small. The library's full feature
   set would be unused.

If we added histograms or summaries in v3.x, we would re-evaluate.

### OpenTelemetry SDK

*Rejected.* OpenTelemetry's metrics SDK is the strategic future for
Go observability, but in 2026 it is heavier than `client_golang` and
its API is still in churn. Otedama's metrics are simple enough that
we can adopt OTel incrementally if it becomes the unambiguous winner.

## Implementation Notes

- The exposition format spec lives at
  https://prometheus.io/docs/instrumenting/exposition_formats/
- We emit `# HELP` and `# TYPE` lines once per metric name, then
  one sample line per label permutation, sorted lexicographically
  to make CI diffs stable.
- Special floats are handled in `formatFloat`: NaN renders as `NaN`,
  positive infinity as `+Inf`, negative as `-Inf`.

## Related

- ADR-003 — Zero runtime dependencies
- `internal/metrics/metrics.go` — Implementation
- `internal/metrics/metrics_test.go` — Format conformance tests
- `internal/httpserver/server.go` — `/metrics` HTTP handler

## Erratum (added session 266, does not alter the accepted decision)

Per `docs/adr/README.md`'s immutability rule, the text above stands. Two
of its stated consequences are no longer accurate:

1. **"No automatic Go runtime metrics … we have to write these ourselves
   if needed."** They were written — `internal/metrics/runtime.go`'s
   `RuntimeCollector()` emits twelve `go_*` series (`go_goroutines`,
   `go_info{version}`, `go_memstats_*`, `go_gc_*`) using only stdlib
   `runtime`, with names matching `prometheus/client_golang` so existing
   dashboards work unmodified. **They were also not registered by anything
   outside their own unit tests until session 266**, so `/metrics` served
   none of them while `RESEARCH_IMPROVEMENTS.md` recorded the work as
   shipped. `cmd/otedama`'s `startHTTPServer` now registers the collector
   once per process, and `TestStartHTTPServer_WithAddrStartsServer`
   asserts on the exposition output rather than on the registration call,
   so removing the wiring fails the suite. The advice to add a sidecar
   exporter is no longer needed for basic Go runtime visibility.

2. **"No labels normalization … we trust the caller."** The registry now
   validates both metric names (`isValidMetricName`) and label names
   (`isValidLabelName`, which is stricter — no colons) at registration and
   panics on violation, because a malformed name makes Prometheus discard
   the entire scrape rather than the offending series. Every name is a
   compile-time constant, so the panic is a developer-time error.

The decision itself — emit the text exposition format directly rather
than importing `client_golang` — is unaffected and still holds.
