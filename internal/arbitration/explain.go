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

	// ForegoneSatsPerSec is the raw yield left on the table by not taking
	// the max-earnings stream (hysteresis hold or policy deviation), the
	// headline number for "what did the safety margin cost this cycle".
	ForegoneSatsPerSec float64 `json:"foregone_sats_per_sec"`

	// Reason is Decide's own human-readable rationale for the assignment.
	Reason string `json:"reason,omitempty"`
}

// DecisionSnapshot is the read-model of the most recent Decide cycle.
type DecisionSnapshot struct {
	// At is when Decide ran. A stale At tells the reader the arbitration
	// loop has not ticked since that time (e.g. providers stopped quoting).
	At time.Time `json:"at"`

	// Policy, HysteresisPct, and MinYieldSatsPerSec echo the Decide inputs
	// that shaped this allocation so the table can state the knobs it was
	// produced under.
	Policy             string  `json:"policy"`
	HysteresisPct      float64 `json:"hysteresis_pct"`
	MinYieldSatsPerSec float64 `json:"min_yield_sats_per_sec"`

	// Rows is one ExplainRow per device, in the Allocation's deterministic
	// DeviceID order. Skipped counts rows with no viable stream.
	Rows    []ExplainRow `json:"rows"`
	Skipped int          `json:"skipped"`

	// TotalSatsPerSec is the summed expected yield across assignments.
	TotalSatsPerSec float64 `json:"total_sats_per_sec"`
}

// ExplainText renders a DecisionSnapshot as the operator-facing table
// ADR-010 A9 specifies. It is pure — cmd/otedama formats the result and
// nothing here touches output handles, so the rendering is testable.
func ExplainText(s *DecisionSnapshot) string {
	var b strings.Builder
	fmt.Fprintf(&b, "=== Otedama arbitration decision (%s) ===\n",
		s.At.Format("2006-01-02 15:04:05"))
	fmt.Fprintf(&b, "Policy: %s · hysteresis %.0f%% · min yield %.2f sat/s\n",
		s.Policy, s.HysteresisPct*100, s.MinYieldSatsPerSec)
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
		switch {
		case r.SwitchedFrom != "":
			detail = fmt.Sprintf("switch from %s", r.SwitchedFrom)
		case r.Held && r.ForegoneSatsPerSec > 0:
			detail = fmt.Sprintf("held (%.2f sat/s declined)", r.ForegoneSatsPerSec)
		case r.Held:
			detail = "held (tie or sub-margin alternative)"
		case r.ForegoneSatsPerSec > 0:
			detail = fmt.Sprintf("policy: %.2f sat/s foregone", r.ForegoneSatsPerSec)
		default:
			detail = "stay"
		}
	}
	return []string{r.DeviceID, stream, yield, forecast, reliability, detail}
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
