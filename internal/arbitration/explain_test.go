// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
package arbitration

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
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
