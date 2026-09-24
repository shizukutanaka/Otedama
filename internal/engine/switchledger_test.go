// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package engine

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/arbitration"
	"github.com/shizukutanaka/Otedama/internal/metrics"
)

func allocWith(deviceID string, stream arbitration.StreamID, yield float64, switchedFrom arbitration.StreamID) *arbitration.Allocation {
	return &arbitration.Allocation{
		Assignments: []arbitration.Assignment{{
			DeviceID:       deviceID,
			Stream:         stream,
			ExpectedYield:  yield,
			SwitchedFromID: switchedFrom,
		}},
	}
}

func streamOffering(id arbitration.StreamID, deviceID string, satsPerSec float64) arbitration.Stream {
	return arbitration.Stream{
		ID: id,
		YieldPerDevice: map[string]arbitration.Yield{
			deviceID: {SatsPerSecond: satsPerSec, Confidence: 1},
		},
	}
}

func TestRecordSwitches(t *testing.T) {
	now := time.Now()
	pending := recordSwitches(nil, allocWith("cpu-0", "ai.akash", 5, "mining.pool"), now)
	if len(pending) != 1 || pending[0].fromStream != "mining.pool" || pending[0].toStream != "ai.akash" {
		t.Fatalf("expected one pending switch mining.pool→ai.akash, got %+v", pending)
	}
	// Non-switched assignment records nothing.
	pending = recordSwitches(pending, allocWith("cpu-0", "ai.akash", 5, ""), now)
	if len(pending) != 1 {
		t.Fatalf("non-switched assignment must not append: %+v", pending)
	}
	// Nil allocation is a no-op, not a panic.
	pending = recordSwitches(pending, nil, now)
	if len(pending) != 1 {
		t.Fatal("nil alloc changed the ledger")
	}
	// The ledger is bounded at pendingSwitchCap, oldest dropped first.
	for i := 0; i < pendingSwitchCap+10; i++ {
		pending = recordSwitches(pending, allocWith("cpu-0", "ai.akash", 5, "mining.pool"), now)
	}
	if len(pending) != pendingSwitchCap {
		t.Fatalf("ledger grew to %d, want cap %d", len(pending), pendingSwitchCap)
	}
}

func TestSettleVerdicts_BeforeWindow(t *testing.T) {
	now := time.Now()
	pending := []pendingSwitch{{deviceID: "cpu-0", fromStream: "a", toStream: "b", at: now}}
	keep, settled := settleVerdicts(pending, nil, nil, now.Add(switchSettleWindow-time.Second))
	if len(settled) != 0 || len(keep) != 1 {
		t.Fatalf("unsettled switch must be kept: keep=%v settled=%v", keep, settled)
	}
}

func TestSettleVerdicts_PaidOffChurnUnverifiable(t *testing.T) {
	now := time.Now()
	at := now.Add(-switchSettleWindow - time.Second)
	pending := []pendingSwitch{
		{deviceID: "d1", fromStream: "old", toStream: "new", at: at},  // realized 6 > old offer 5 → paid_off, +1
		{deviceID: "d2", fromStream: "old", toStream: "new", at: at},  // realized 4 < old offer 7 → churn, −3
		{deviceID: "d3", fromStream: "gone", toStream: "new", at: at}, // old stream vanished → unverifiable
	}
	alloc := &arbitration.Allocation{Assignments: []arbitration.Assignment{
		{DeviceID: "d1", Stream: "new", ExpectedYield: 6},
		{DeviceID: "d2", Stream: "new", ExpectedYield: 4},
		{DeviceID: "d3", Stream: "new", ExpectedYield: 9},
	}}
	// One provider can appear as several same-ID streams (one per device it
	// quotes) — the counterfactual must pick the entry for THIS device, not
	// whichever stream happens to sort last.
	streams := []arbitration.Stream{
		streamOffering("old", "d1", 5),
		streamOffering("old", "d2", 7),
	}
	// "gone" is absent: no counterfactual exists.
	keep, settled := settleVerdicts(pending, alloc, streams, now)
	if len(keep) != 0 {
		t.Fatalf("all pending should settle past the window; kept %v", keep)
	}
	if len(settled) != 3 {
		t.Fatalf("want 3 settled, got %v", settled)
	}
	if settled[0].verdict != verdictPaidOff || settled[0].gain != 1 {
		t.Errorf("d1: verdict=%s gain=%v, want paid_off/+1", settled[0].verdict, settled[0].gain)
	}
	if settled[1].verdict != verdictChurn || settled[1].gain != -3 {
		t.Errorf("d2: verdict=%s gain=%v, want churn/−3", settled[1].verdict, settled[1].gain)
	}
	if settled[2].verdict != verdictUnverifiable {
		t.Errorf("d3: verdict=%s, want unverifiable", settled[2].verdict)
	}
}

func TestSettleVerdicts_IdleRealizesZero(t *testing.T) {
	now := time.Now()
	pending := []pendingSwitch{{
		deviceID: "d1", fromStream: "old", toStream: "gone-idle",
		at: now.Add(-switchSettleWindow - time.Second),
	}}
	alloc := &arbitration.Allocation{Assignments: []arbitration.Assignment{
		{DeviceID: "d1"}, // idle: realized 0
	}}
	streams := []arbitration.Stream{streamOffering("old", "d1", 3)}
	_, settled := settleVerdicts(pending, alloc, streams, now)
	if len(settled) != 1 || settled[0].verdict != verdictChurn || settled[0].gain != -3 {
		t.Fatalf("idle device vs live offer should churn at −3: %+v", settled)
	}
}

func TestRecordSwitchVerdict_Metric(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	m.recordSwitchVerdict(verdictPaidOff, 1.5)
	m.recordSwitchVerdict(verdictChurn, -2)
	m.recordSwitchVerdict(verdictUnverifiable, 0)
	var buf bytes.Buffer
	if err := reg.WriteText(&buf); err != nil {
		t.Fatalf("WriteText: %v", err)
	}
	out := buf.String()
	for _, want := range []string{
		`otedama_arbitration_switch_verdicts_total{verdict="paid_off"}`,
		`otedama_arbitration_switch_verdicts_total{verdict="churn"}`,
		`otedama_arbitration_switch_verdicts_total{verdict="unverifiable"}`,
		"otedama_arbitration_last_switch_realized_gain_sats_per_second -2",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in exposition:\n%s", want, out)
		}
	}
}

func TestDescribeVerdict(t *testing.T) {
	if got := describeVerdict("cpu-0", "a", "b", verdictChurn, -1.5); !strings.Contains(got, "churned") {
		t.Errorf("churn description: %q", got)
	}
	if got := describeVerdict("cpu-0", "a", "b", verdictPaidOff, 2); !strings.Contains(got, "paid off") {
		t.Errorf("paid_off description: %q", got)
	}
	if got := describeVerdict("cpu-0", "a", "b", verdictUnverifiable, 0); !strings.Contains(got, "unverifiable") {
		t.Errorf("unverifiable description: %q", got)
	}
}
