// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
//
// ADR-010 feature A9 (explainability), data-model half: a DecisionSnapshot
// captures everything needed to answer "why did Otedama choose X right
// now?" — the allocation itself plus the forecast, posterior reliability,
// and held/foregone context Decide() had at the time. The engine records
// one snapshot per decision tick (see internal/engine/arbitrate.go); the
// HTTP server exposes it as JSON at /arbitration and `otedama arb explain`
// renders it as a table via ExplainText.
package arbitration

import (
	"fmt"
	"strings"
	"time"
)

// ExplainRow is one device line of an arbitration explanation.
type ExplainRow struct {
	// DeviceID identifies the hardware unit this row describes.
	DeviceID string `json:"device_id"`

	// Stream is the StreamID the device was assigned to, empty when the
	// device is idle. Idleness is a deliberate outcome (no compatible
	// stream, or every candidate below the profitability floor), never an
	// error, so idle rows render explicitly rather than being omitted.
	Stream StreamID `json:"stream,omitempty"`

	// ExpectedSatsPerSec is the confidence-adjusted yield of the assigned
	// stream at decision time.
	ExpectedSatsPerSec float64 `json:"expected_sats_per_sec"`

	// ForecastSatsPerSec and ForecastSigmaSatsPerSec carry the A1
	// Holt-Winters one-step prediction ± running MAE for the assigned
	// (stream, device) pair. Both are nil while the stream has too little
	// history to forecast — a new provider's first Decide already has a
	// snapshot but no smoother state.
	ForecastSatsPerSec      *float64 `json:"forecast_sats_per_sec,omitempty"`
	ForecastSigmaSatsPerSec *float64 `json:"forecast_sigma_sats_per_sec,omitempty"`

	// Reliability is the provider's Beta-Bernoulli posterior mean;
	// ReliabilityAlpha/Beta are its accumulated pseudo-counts (the ADR's
	// "α=89, β=2.6" display). Reliability is nil when no posterior exists
	// yet for the provider.
	Reliability      *float64 `json:"reliability,omitempty"`
	ReliabilityAlpha float64  `json:"reliability_alpha,omitempty"`
	ReliabilityBeta  float64  `json:"reliability_beta,omitempty"`

	// SwitchedFrom is the stream the device was on before this decision,
	// empty when it did not switch. Held mirrors Assignment.Held (a
	// same-or-better alternative was suppressed by the hysteresis margin).
	SwitchedFrom StreamID `json:"switched_from,omitempty"`
	Held         bool     `json:"held,omitempty"`
	// AwaitingConfirmation mirrors Assignment.AwaitingConfirmation: the
	// held row's suppressed best candidate was an unconfirmed stream, so
	// ADR-010 A7's confirmation ladder (not the hysteresis margin) kept
	// the incumbent.
	AwaitingConfirmation bool `json:"awaiting_confirmation,omitempty"`

	// Simulated marks rows whose chosen stream quotes modeled rather than
	// live-market yield — the row-level disclosure that keeps modeled
	// revenue visually distinct from real earnings (the counterpart of
	// the expected/simulated metrics split).
	Simulated bool `json:"simulated,omitempty"`

	// ForegoneSatsPerSec is the raw yield left on the table by not taking
	// the max-earnings stream (hysteresis hold or policy deviation), the
	// headline number for "what did the safety margin cost this cycle".
	ForegoneSatsPerSec float64 `json:"foregone_sats_per_sec"`

	// ForegoneStream identifies the declined max-earnings stream when it
	// differs from the assigned one; ForegoneExpectedSatsPerSec is that
	// stream's current expected yield for this device. Both empty when no
	// alternative was on the table.
	ForegoneStream             StreamID `json:"foregone_stream,omitempty"`
	ForegoneExpectedSatsPerSec *float64 `json:"foregone_expected_sats_per_sec,omitempty"`

	// SwitchedFromExpectedSatsPerSec is the previous stream's current
	// expected yield for this device — the "what it left" half of a
	// switch. Nil when the previous stream is no longer quoted: the
	// counterfactual is then genuinely unknowable, so callers should not
	// guess a number for it.
	SwitchedFromExpectedSatsPerSec *float64 `json:"switched_from_expected_sats_per_sec,omitempty"`

	// AltForecastSigmaSatsPerSec is the forecaster error scale of the
	// alternative stream (the foregone candidate, or the switched-from
	// stream for a switch row) — the second half of the "does the yield
	// gap exceed forecast noise" reasoning clause. Nil when the
	// alternative has no smoother history.
	AltForecastSigmaSatsPerSec *float64 `json:"alt_forecast_sigma_sats_per_sec,omitempty"`

	// Reason is Decide's own human-readable rationale for the assignment.
	Reason string `json:"reason,omitempty"`

	// QuoteAgeSeconds is the age of the assigned stream's most recent
	// quote at decision time — the same freshness signal the
	// otedama_stream_last_quote_unixtime gauge exports. It lets the
	// reader distinguish "stream lost on yield" from "provider went
	// quiet" (a large or ever-growing age means the stream's quote feed
	// stalled even though it still sits in the allocation). Nil when no
	// quote timestamp is recorded for the pair.
	QuoteAgeSeconds *float64 `json:"quote_age_seconds,omitempty"`
}

// DecisionSnapshot is the read-model of the most recent Decide cycle.
type DecisionSnapshot struct {
	// At is when Decide ran. A stale At tells the reader the arbitration
	// loop has not ticked since that time (e.g. providers stopped quoting).
	At time.Time `json:"at"`

	// Policy, HysteresisPct, and MinYieldSatsPerSec echo the Decide inputs
	// that shaped this allocation so the table can state the knobs it was
	// produced under. IncomeMode is the A5 criterion ("max"/"smooth"/
	// "balanced"); omitted when empty so old snapshots stay readable.
	Policy             string  `json:"policy"`
	HysteresisPct      float64 `json:"hysteresis_pct"`
	MinYieldSatsPerSec float64 `json:"min_yield_sats_per_sec"`
	IncomeMode         string  `json:"income_mode,omitempty"`

	// Rows is one ExplainRow per device, in the Allocation's deterministic
	// DeviceID order. Skipped counts rows with no viable stream.
	Rows    []ExplainRow `json:"rows"`
	Skipped int          `json:"skipped"`

	// TotalSatsPerSec is the summed expected yield across assignments.
	TotalSatsPerSec float64 `json:"total_sats_per_sec"`
}

// incomeModeOr renders the snapshot's mode for the header line — an
// empty field (snapshots recorded before A5) displays "max", the value
// it effectively decided with.
func incomeModeOr(s string) string {
	if s == "" {
		return "max"
	}
	return s
}

// ExplainText renders a DecisionSnapshot as the operator-facing table
// ADR-010 A9 specifies. It is pure — cmd/otedama formats the result and
// nothing here touches output handles, so the rendering is testable.
func ExplainText(s *DecisionSnapshot) string {
	var b strings.Builder
	fmt.Fprintf(&b, "=== Otedama arbitration decision (%s) ===\n",
		s.At.Format("2006-01-02 15:04:05"))
	fmt.Fprintf(&b, "Policy: %s · hysteresis %.0f%% · min yield %.2f sat/s · income %s\n",
		s.Policy, s.HysteresisPct*100, s.MinYieldSatsPerSec, incomeModeOr(s.IncomeMode))
	fmt.Fprintf(&b, "Devices: %d · idle: %d · expected: %.2f sat/s\n\n",
		len(s.Rows), s.Skipped, s.TotalSatsPerSec)

	// Fixed-width table like the ADR example; column widths follow the
	// longest cell in each column (computed in two passes).
	headers := []string{"Device", "Stream", "Yield", "Forecast", "Reliability", "Detail"}
	widths := make([]int, len(headers))
	for i, h := range headers {
		widths[i] = len(h)
	}
	cells := make([][]string, len(s.Rows))
	for i := range s.Rows {
		cells[i] = explainRowCells(&s.Rows[i])
		for j, c := range cells[i] {
			if len(c) > widths[j] {
				widths[j] = len(c)
			}
		}
	}
	writeTableLine(&b, headers, widths)
	writeTableRule(&b, widths)
	for _, c := range cells {
		writeTableLine(&b, c, widths)
	}

	if lines := s.reasoningLines(); len(lines) > 0 {
		b.WriteString("\nReasoning:\n")
		for _, l := range lines {
			b.WriteString("  ")
			b.WriteString(l)
			b.WriteByte('\n')
		}
	}
	return b.String()
}

// explainRowCells renders one row's cell values; kept separate so the
// width pass and the emit pass share the same formatting.
func explainRowCells(r *ExplainRow) []string {
	stream := string(r.Stream)
	yield := "—"
	forecast := "—"
	reliability := "—"
	detail := r.Reason
	if r.Idle() {
		stream = "(idle)"
		if detail == "" {
			detail = "no viable stream"
		}
	} else {
		yield = fmt.Sprintf("%.2f sat/s", r.ExpectedSatsPerSec)
		if r.Simulated {
			stream += " (sim)"
		}
		if r.ForecastSatsPerSec != nil {
			forecast = fmt.Sprintf("%.2f", *r.ForecastSatsPerSec)
			if r.ForecastSigmaSatsPerSec != nil && *r.ForecastSigmaSatsPerSec > 0 {
				forecast += fmt.Sprintf(" ±%.2f", *r.ForecastSigmaSatsPerSec)
			}
		}
		if r.Reliability != nil {
			reliability = fmt.Sprintf("%.2f (α=%.1f, β=%.1f)",
				*r.Reliability, r.ReliabilityAlpha, r.ReliabilityBeta)
		}
		detail = explainRowDetail(r)
		if r.QuoteAgeSeconds != nil {
			detail += fmt.Sprintf(" · last quote %s ago", formatQuoteAge(*r.QuoteAgeSeconds))
		}
	}
	return []string{r.DeviceID, stream, yield, forecast, reliability, detail}
}

// formatQuoteAge renders a quote age compactly: whole seconds under a
// minute, "Xm Ys" beyond it.
func formatQuoteAge(s float64) string {
	if s < 60 {
		return fmt.Sprintf("%.0fs", s)
	}
	return fmt.Sprintf("%.0fm %.0fs", s/60, float64(int(s)%60))
}

// explainRowDetail renders the non-idle row's Detail cell — the
// one-phrase summary of what the decision did (switch / hold /
// policy-foregone / stay) plus the magnitude when one exists. Non-idle
// rows always render this summary; Decide's own Reason text only
// survives into the Detail cell of idle rows (which have no summary).
func explainRowDetail(r *ExplainRow) string {
	switch {
	case r.SwitchedFrom != "":
		return fmt.Sprintf("switch from %s", r.SwitchedFrom)
	case r.Held && r.ForegoneSatsPerSec > 0 && r.AwaitingConfirmation:
		return fmt.Sprintf("held (%.2f sat/s declined; challenger unconfirmed)", r.ForegoneSatsPerSec)
	case r.Held && r.ForegoneSatsPerSec > 0:
		return fmt.Sprintf("held (%.2f sat/s declined)", r.ForegoneSatsPerSec)
	case r.Held:
		return "held (tie or sub-margin alternative)"
	case r.ForegoneSatsPerSec > 0:
		return fmt.Sprintf("policy: %.2f sat/s foregone", r.ForegoneSatsPerSec)
	default:
		return "stay"
	}
}

// reasoningLines produces the trailing "Reasoning:" paragraph from
// ADR-010 A9's mockup — one clause per device that deviated from a plain
// stay (switched, hysteresis-held, or foregone yield under the policy),
// with a forecast-noise clause appended whenever both sides have enough
// history to say whether the gap exceeds what the forecasters can tell
// apart. Rows that stayed on the clearly-best stream produce no line.
func (s *DecisionSnapshot) reasoningLines() []string {
	var lines []string
	for i := range s.Rows {
		r := &s.Rows[i]
		var clause string
		switch {
		case r.SwitchedFrom != "" && r.SwitchedFromExpectedSatsPerSec != nil:
			old, now := *r.SwitchedFromExpectedSatsPerSec, r.ExpectedSatsPerSec
			clause = fmt.Sprintf("%s: switched from %s (%.2f sat/s) to %s (%.2f sat/s), %+.0f%%",
				r.DeviceID, r.SwitchedFrom, old, r.Stream, now, pctDelta(now, old))
			clause += r.errorBandClause(now - old)
		case r.SwitchedFrom != "":
			clause = fmt.Sprintf("%s: switched from %s to %s — previous stream no longer quoted",
				r.DeviceID, r.SwitchedFrom, r.Stream)
		case r.Held && r.ForegoneStream != "":
			clause = fmt.Sprintf("%s: held on %s — %s's %.2f sat/s advantage declined (hysteresis %.0f%%)",
				r.DeviceID, r.Stream, r.ForegoneStream, r.ForegoneSatsPerSec, s.HysteresisPct*100)
			clause += r.errorBandClause(r.ForegoneSatsPerSec)
		case r.ForegoneSatsPerSec > 0 && r.ForegoneStream != "":
			clause = fmt.Sprintf("%s: policy kept %s — declined %s's %.2f sat/s advantage",
				r.DeviceID, r.Stream, r.ForegoneStream, r.ForegoneSatsPerSec)
			clause += r.errorBandClause(r.ForegoneSatsPerSec)
		}
		if clause != "" {
			lines = append(lines, clause)
		}
	}
	return lines
}

// errorBandClause appends the "does the gap exceed forecast noise" half
// of a reasoning clause: the two streams' one-step error scales, summed,
// are the widest band inside which the forecasters cannot distinguish
// their yields. Empty when either side lacks forecast history — claiming
// a separation without a calibrated σ would be a false-precision claim.
func (r *ExplainRow) errorBandClause(gap float64) string {
	if r.ForecastSigmaSatsPerSec == nil || r.AltForecastSigmaSatsPerSec == nil {
		return ""
	}
	band := *r.ForecastSigmaSatsPerSec + *r.AltForecastSigmaSatsPerSec
	if band <= 0 {
		return ""
	}
	if gap > band {
		return fmt.Sprintf("; gap exceeds combined forecast error ±%.2f sat/s", band)
	}
	return fmt.Sprintf("; gap within combined forecast error ±%.2f sat/s", band)
}

// pctDelta renders the percent change from old to now, guarding the
// division on a zero previous yield (infinite advantage).
func pctDelta(now, old float64) float64 {
	if old <= 0 {
		return 0
	}
	return (now - old) / old * 100
}

// Idle reports whether the row's device is unassigned.
func (r *ExplainRow) Idle() bool { return r.Stream == "" }

func writeTableLine(b *strings.Builder, cells []string, widths []int) {
	for i, c := range cells {
		if i > 0 {
			b.WriteString("  ")
		}
		// The last column is left unpadded: trailing whitespace carries no
		// alignment information and trips copy-paste consumers.
		if i == len(cells)-1 {
			b.WriteString(c)
			continue
		}
		fmt.Fprintf(b, "%-*s", widths[i], c)
	}
	b.WriteByte('\n')
}

func writeTableRule(b *strings.Builder, widths []int) {
	for i, w := range widths {
		if i > 0 {
			b.WriteString("  ")
		}
		b.WriteString(strings.Repeat("─", w))
	}
	b.WriteByte('\n')
}
