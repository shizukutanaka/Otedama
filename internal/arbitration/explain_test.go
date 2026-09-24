// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
package arbitration

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/hal"
)

func f64(v float64) *float64 { return &v }

// TestExplainText_RendersHeaderAndRows pins the ADR-010 A9 table shape:
// a header block stating the decision inputs, then one row per device
// with yield, forecast ± sigma, posterior reliability, and the detail
// reason for holds/switches/idles.
func TestExplainText_RendersHeaderAndRows(t *testing.T) {
	snap := &DecisionSnapshot{
		At:                 time.Date(2026, 9, 23, 8, 13, 0, 0, time.UTC),
		Policy:             PolicyMaximizeEarnings.String(),
		HysteresisPct:      0.05,
		MinYieldSatsPerSec: 0.25,
		TotalSatsPerSec:    42.5,
		Skipped:            1,
		Rows: []ExplainRow{
			{
				DeviceID:                "cpu-0",
				Stream:                  "mining.stratum",
				ExpectedSatsPerSec:      42.5,
				ForecastSatsPerSec:      f64(41.9),
				ForecastSigmaSatsPerSec: f64(0.4),
				Reliability:             f64(0.972),
				ReliabilityAlpha:        89,
				ReliabilityBeta:         2.6,
			},
			{
				DeviceID: "gpu-0",
				Reason:   "below min_yield floor",
			},
		},
	}
	out := ExplainText(snap)
	for _, want := range []string{
		"=== Otedama arbitration decision (2026-09-23 08:13:00) ===",
		"Policy: maximize_earnings · hysteresis 5% · min yield 0.25 sat/s",
		"Devices: 2 · idle: 1 · expected: 42.50 sat/s",
		"cpu-0", "mining.stratum", "42.50 sat/s", "41.90 ±0.40",
		"0.97 (α=89.0, β=2.6)", "stay",
		"gpu-0", "(idle)", "below min_yield floor",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("ExplainText missing %q\n%s", want, out)
		}
	}
	// Table shape: 3 header lines, a blank line, the column header, a ─
	// rule, then one line per device.
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) != 3+1+1+1+2 {
		t.Errorf("expected 8 lines (3 header + blank + cols + rule + 2 rows), got %d\n%s", len(lines), out)
	}
	if !strings.Contains(lines[5], "─") {
		t.Error("expected a ─ rule line after the column header")
	}
}

// TestExplainText_DetailVariants covers each Detail cell branch: switch,
// hold with foregone yield, tie-hold, and the policy-deviation foregone.
func TestExplainText_DetailVariants(t *testing.T) {
	snap := &DecisionSnapshot{
		At: time.Now(),
		Rows: []ExplainRow{
			{DeviceID: "a", Stream: "ai.akash", ExpectedSatsPerSec: 10, SwitchedFrom: "mining.stratum"},
			{DeviceID: "b", Stream: "mining.stratum", ExpectedSatsPerSec: 9, Held: true, ForegoneSatsPerSec: 0.5},
			{DeviceID: "c", Stream: "mining.stratum", ExpectedSatsPerSec: 9, Held: true},
			{DeviceID: "d", Stream: "ai.akash", ExpectedSatsPerSec: 8, ForegoneSatsPerSec: 0.25},
		},
	}
	out := ExplainText(snap)
	for _, want := range []string{
		"switch from mining.stratum",
		"held (0.50 sat/s declined)",
		"held (tie or sub-margin alternative)",
		"policy: 0.25 sat/s foregone",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("ExplainText missing %q\n%s", want, out)
		}
	}
}

// TestExplainText_MissingOptionalFields renders "—" cells when no
// forecast or posterior exists yet (first ticks, pre-seeded streams).
func TestExplainText_MissingOptionalFields(t *testing.T) {
	snap := &DecisionSnapshot{
		At: time.Now(),
		Rows: []ExplainRow{
			{DeviceID: "cpu-0", Stream: "mining.stratum", ExpectedSatsPerSec: 1},
		},
	}
	out := ExplainText(snap)
	if !strings.Contains(out, "—") {
		t.Error("expected em-dash placeholders for absent forecast/reliability")
	}
	if strings.Contains(out, "±") || strings.Contains(out, "α=") {
		t.Error("forecast/reliability decoration must not appear without data")
	}
}

// TestExplainRow_Idle pins the empty-stream convention.
func TestExplainRow_Idle(t *testing.T) {
	if !(&ExplainRow{DeviceID: "x"}).Idle() {
		t.Error("empty Stream should mean idle")
	}
	if (&ExplainRow{DeviceID: "x", Stream: "s"}).Idle() {
		t.Error("assigned stream should not be idle")
	}
}

// TestExplainText_Reasoning covers the trailing Reasoning block: one
// clause per row that deviated from a plain stay — switch with both
// yields, switch with an unquotable previous stream, hysteresis hold,
// and policy foregone — plus the forecast-noise clause when both sides
// have calibrated error scales.
func TestExplainText_Reasoning(t *testing.T) {
	snap := &DecisionSnapshot{
		At:            time.Now(),
		HysteresisPct: 0.05,
		Rows: []ExplainRow{
			{
				DeviceID:                       "a",
				Stream:                         "ai.akash",
				ExpectedSatsPerSec:             1.51,
				SwitchedFrom:                   "mining.stratum",
				SwitchedFromExpectedSatsPerSec: f64(1.20),
				ForecastSigmaSatsPerSec:        f64(0.10),
				AltForecastSigmaSatsPerSec:     f64(0.10),
			},
			{
				DeviceID:     "b",
				Stream:       "ai.akash",
				SwitchedFrom: "defunct.provider",
			},
			{
				DeviceID:           "c",
				Stream:             "mining.stratum",
				ExpectedSatsPerSec: 9,
				Held:               true,
				ForegoneSatsPerSec: 0.30,
				ForegoneStream:     "ai.akash",
			},
			{
				DeviceID:           "d",
				Stream:             "mining.stratum",
				ExpectedSatsPerSec: 8,
				ForegoneSatsPerSec: 0.25,
				ForegoneStream:     "ai.akash",
			},
			{DeviceID: "e", Stream: "mining.stratum", ExpectedSatsPerSec: 9},
		},
	}
	out := ExplainText(snap)
	for _, want := range []string{
		"Reasoning:",
		"a: switched from mining.stratum (1.20 sat/s) to ai.akash (1.51 sat/s), +26%",
		"gap exceeds combined forecast error ±0.20 sat/s",
		"b: switched from defunct.provider to ai.akash — previous stream no longer quoted",
		"c: held on mining.stratum — ai.akash's 0.30 sat/s advantage declined (hysteresis 5%)",
		"d: policy kept mining.stratum — declined ai.akash's 0.25 sat/s advantage",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("Reasoning missing %q\n%s", want, out)
		}
	}
	if strings.Contains(out, "e:") && strings.Contains(out, "e: held") {
		t.Error("plain stay rows must not produce reasoning clauses\n" + out)
	}
}

// TestExplainText_ReasoningQuietWhenNothingHappened shows no Reasoning
// block at all when every device stayed on the clearly-best stream.
func TestExplainText_ReasoningQuietWhenNothingHappened(t *testing.T) {
	snap := &DecisionSnapshot{
		At:   time.Now(),
		Rows: []ExplainRow{{DeviceID: "a", Stream: "s", ExpectedSatsPerSec: 1}},
	}
	if strings.Contains(ExplainText(snap), "Reasoning:") {
		t.Error("Reasoning block must not appear for all-stay decisions")
	}
}

// TestExplainText_ReasoningErrorBandWithin covers the complementary CI
// clause: a gap the forecasters cannot separate.
func TestExplainText_ReasoningErrorBandWithin(t *testing.T) {
	snap := &DecisionSnapshot{
		At:            time.Now(),
		HysteresisPct: 0.05,
		Rows: []ExplainRow{{
			DeviceID:                   "a",
			Stream:                     "s1",
			ExpectedSatsPerSec:         9,
			Held:                       true,
			ForegoneSatsPerSec:         0.05,
			ForegoneStream:             "s2",
			ForecastSigmaSatsPerSec:    f64(0.10),
			AltForecastSigmaSatsPerSec: f64(0.10),
		}},
	}
	if out := ExplainText(snap); !strings.Contains(out, "gap within combined forecast error ±0.20 sat/s") {
		t.Errorf("expected within-band clause\n%s", out)
	}
}

// TestDecide_ForegoneStreamID pins the declined-stream identity: when a
// device's incumbent wins the hysteresis comparison, ForegoneStreamID
// names the suppressed higher-yield stream; when the incumbent is itself
// the max-earnings candidate, the field stays empty.
func TestDecide_ForegoneStreamID(t *testing.T) {
	gpu := DeviceRef{Identity: hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU}}
	incumbent := Stream{
		ID:              "mining.braiins",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 100, Confidence: 1.0}},
	}
	challenger := Stream{
		ID:              "ai.akash",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 105, Confidence: 1.0}},
	}
	prev := &Allocation{Assignments: []Assignment{
		{DeviceID: "gpu-0", Stream: "mining.braiins", ExpectedYield: 100},
	}}

	// 5% improvement < 10% margin: held, declining ai.akash.
	alloc, err := Decide(Input{
		Devices: []DeviceRef{gpu}, Streams: []Stream{incumbent, challenger},
		Previous: prev, Policy: PolicyMaximizeEarnings, HysteresisMargin: 0.10,
	})
	if err != nil {
		t.Fatalf("held Decide: %v", err)
	}
	a := alloc.Assignments[0]
	if !a.Held || a.ForegoneStreamID != "ai.akash" || a.ForegoneSatsPerSec != 5 {
		t.Errorf("expected held declining ai.akash by 5, got held=%v foregone=%q %.2f",
			a.Held, a.ForegoneStreamID, a.ForegoneSatsPerSec)
	}

	// Challenger below the incumbent: the incumbent is itself the raw
	// argmax, so nothing was declined and the field stays empty.
	weaker := Stream{
		ID:              "ai.slow",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 90, Confidence: 1.0}},
	}
	alloc, err = Decide(Input{
		Devices: []DeviceRef{gpu}, Streams: []Stream{incumbent, weaker},
		Previous: prev, Policy: PolicyMaximizeEarnings, HysteresisMargin: 0.50,
	})
	if err != nil {
		t.Fatalf("uncontested Decide: %v", err)
	}
	a = alloc.Assignments[0]
	if a.ForegoneStreamID != "" {
		t.Errorf("no alternative should be recorded when incumbent is max, got %q", a.ForegoneStreamID)
	}
}

// TestDecisionSnapshot_JSONRoundTrip keeps the wire contract stable: the
// HTTP endpoint marshals this type and `arb explain` decodes it.
func TestDecisionSnapshot_JSONRoundTrip(t *testing.T) {
	snap := &DecisionSnapshot{
		At:            time.Date(2026, 9, 23, 8, 0, 0, 0, time.UTC),
		Policy:        "maximize_earnings",
		HysteresisPct: 0.05,
		Rows: []ExplainRow{
			{
				DeviceID:           "cpu-0",
				Stream:             "mining.stratum",
				ExpectedSatsPerSec: 12.5,
				Reliability:        f64(0.5),
				ReliabilityAlpha:   1,
				ReliabilityBeta:    1,
			},
		},
		TotalSatsPerSec: 12.5,
	}
	raw, err := json.Marshal(snap)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var back DecisionSnapshot
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(back.Rows) != 1 || back.Rows[0].DeviceID != "cpu-0" ||
		back.Rows[0].Stream != "mining.stratum" ||
		back.Rows[0].Reliability == nil || *back.Rows[0].Reliability != 0.5 ||
		back.TotalSatsPerSec != 12.5 || !back.At.Equal(snap.At) {
		t.Errorf("round-trip mismatch: %+v", back)
	}
}

// Cat 5 #8: a row on a simulated stream is rendered with a "(sim)"
// suffix on the Stream cell so `arb explain` keeps modeled revenue
// visually distinct from real earnings.
func TestExplainRowCells_SimulatedSuffix(t *testing.T) {
	r := &ExplainRow{
		DeviceID:           "gpu-0",
		Stream:             "ai.akash",
		ExpectedSatsPerSec: 14.25,
		Simulated:          true,
	}
	cells := explainRowCells(r)
	if cells[1] != "ai.akash (sim)" {
		t.Errorf("stream cell = %q, want %q", cells[1], "ai.akash (sim)")
	}
	r2 := &ExplainRow{
		DeviceID:           "cpu-0",
		Stream:             "mining.stratum",
		ExpectedSatsPerSec: 1.5,
	}
	if got := explainRowCells(r2)[1]; got != "mining.stratum" {
		t.Errorf("real stream cell = %q, want mining.stratum", got)
	}
}
