// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package engine

import (
	"bytes"
	"strings"
	"testing"

	"github.com/shizukutanaka/Otedama/internal/metrics"
	"github.com/shizukutanaka/Otedama/internal/provider"
)

func TestDriftTracker_Observe(t *testing.T) {
	d := newDriftTracker()
	k := "ai.akash:cpu-0"

	// First observation seeds the baseline — never a shift, no variation.
	shifted, count, tv := d.observe(k, 100)
	if shifted || count != 0 || tv != 0 {
		t.Fatalf("first observe = (%v,%d,%g), want (false,0,0)", shifted, count, tv)
	}
	// Quote noise inside the epsilon band accumulates variation but not shifts.
	shifted, count, tv = d.observe(k, 101) // +1 = 1% of 100 < 2%
	if shifted || count != 0 || tv != 1 {
		t.Fatalf("noise observe = (%v,%d,%g), want (false,0,1)", shifted, count, tv)
	}
	// A jump beyond the band is a significant shift.
	shifted, count, tv = d.observe(k, 90) // −11 = ~10.9% of 101
	if !shifted || count != 1 || tv != 12 {
		t.Fatalf("shift observe = (%v,%d,%g), want (true,1,12)", shifted, count, tv)
	}
	// Death to zero counts at any size.
	shifted, count, _ = d.observe(k, 0)
	if !shifted || count != 2 {
		t.Fatalf("death observe = (%v,%d), want (true,2)", shifted, count)
	}
	// Revival from zero counts at any size.
	shifted, count, _ = d.observe(k, 0.5)
	if !shifted || count != 3 {
		t.Fatalf("revival observe = (%v,%d), want (true,3)", shifted, count)
	}
}

func TestDriftTracker_Expire(t *testing.T) {
	d := newDriftTracker()
	d.observe("a:d1", 10)
	d.observe("a:d1", 5)
	d.observe("b:d1", 7)
	d.expire("a:d1")
	if _, count, tv := d.observe("a:d1", 9); count != 0 || tv != 0 {
		t.Fatalf("expired stream kept state: count=%d tv=%g", count, tv)
	}
	if d.last["b:d1"] != 7 {
		t.Fatal("expire wiped a different stream's state")
	}
}

func TestObservedEffective(t *testing.T) {
	q := provider.Quote{Yield: provider.Yield{SatsPerSecond: 10, NetSatsPerSecond: 9, Confidence: 0.5}}
	// Mirrors arbitration.Yield.Effective on the folded fields: SatsPerSecond
	// × Confidence (gross, not net) — the quantity Decide compares.
	if got := observedEffective(&q); got != 5 {
		t.Errorf("observedEffective = %g, want 5", got)
	}
}

func TestSplitStreamKey(t *testing.T) {
	s, d := splitStreamKey("mining.stratum:cpu-0")
	if s != "mining.stratum" || d != "cpu-0" {
		t.Errorf("split = (%q,%q)", s, d)
	}
	s, d = splitStreamKey("ai.akash:")
	if s != "ai.akash" || d != "" {
		t.Errorf("device-less split = (%q,%q)", s, d)
	}
}

func TestObserveStreamDrift_Metric(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	m.observeStreamDrift("ai.akash", "cpu-0", false, 1.5)
	m.observeStreamDrift("ai.akash", "cpu-0", true, 9.0)
	var buf bytes.Buffer
	if err := reg.WriteText(&buf); err != nil {
		t.Fatalf("WriteText: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, `otedama_stream_yield_shifts_total{device="cpu-0",stream="ai.akash"} 1`) {
		t.Errorf("shift counter missing/wrong (want 1 after one shifted observe):\n%s", out)
	}
	if !strings.Contains(out, `otedama_stream_yield_drift_sats_per_second{device="cpu-0",stream="ai.akash"} 9`) {
		t.Errorf("drift gauge missing/wrong (want 9, the running total):\n%s", out)
	}
}
