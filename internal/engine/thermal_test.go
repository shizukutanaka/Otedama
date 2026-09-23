// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package engine

import (
	"bytes"
	"strings"
	"testing"

	"github.com/shizukutanaka/Otedama/internal/metrics"
)

// ============================================================================
// thermalDecision — pure thermal-throttle decision (session 273)
//
// Mirrors curtailDecision's safety contract for the thermal gate: a poll
// with no valid sensor data NEVER changes the gate, and resume requires
// cooling 5°C below the threshold (hysteresis — a boundary-hovering
// sensor must not flap hashing off/on every 30s poll).
// ============================================================================

func TestThermalDecision(t *testing.T) {
	const thr = 80000 // 80°C in millicelsius
	tests := []struct {
		name        string
		curr        bool
		maxMilli    int64
		ok          bool
		threshold   int64
		wantNext    bool
		wantChanged bool
	}{
		// --- untrusted-input rule: no valid reading never acts ---
		{"no data does not curtail", false, 0, false, thr, false, false},
		{"no data does not release a raised gate", true, 0, false, thr, true, false},

		// --- raise ---
		{"hot sensor raises gate", false, 85000, true, thr, true, true},
		{"exactly at threshold raises", false, 80000, true, thr, true, true},
		{"already hot and raised: no change", true, 90000, true, thr, true, false},

		// --- release requires the full hysteresis margin ---
		{"cool below threshold-5°C releases", true, 70000, true, thr, false, true},
		{"just under threshold-5°C boundary releases", true, 74999, true, thr, false, true},
		{"at threshold-5°C does NOT release (margin is strict)", true, 75000, true, thr, true, false},
		{"between margin and threshold holds (no flap)", true, 78000, true, thr, true, false},
		{"still hot after release band: holds raised", true, 81000, true, thr, true, false},

		// --- steady states ---
		{"cool and lowered: no change", false, 40000, true, thr, false, false},

		// --- disabled / invalid ---
		{"threshold 0 disables raise", false, 120000, true, 0, false, false},
		{"threshold 0 disables release", true, 10000, true, 0, true, false},
		{"negative threshold disabled", false, 120000, true, -1, false, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			next, changed := thermalDecision(tt.curr, tt.maxMilli, tt.ok, tt.threshold)
			if next != tt.wantNext || changed != tt.wantChanged {
				t.Errorf("thermalDecision(curr=%v, max=%d, ok=%v, thr=%d) = (%v, %v), want (%v, %v)",
					tt.curr, tt.maxMilli, tt.ok, tt.threshold, next, changed, tt.wantNext, tt.wantChanged)
			}
		})
	}
}

func TestThermalDecision_HysteresisSequence(t *testing.T) {
	// Drive a realistic oscillation: sensor hovering at the threshold must
	// produce exactly one raise and then hold — no flapping while it jitters
	// between 78-81°C.
	curr := false
	var changed bool
	_, changed = thermalDecision(curr, 81000, true, 80000)
	if !changed {
		t.Fatal("expected raise at 81°C")
	}
	curr = true
	for _, v := range []int64{78000, 80000, 76000, 82000, 75000} {
		_, changed = thermalDecision(curr, v, true, 80000)
		if changed {
			t.Fatalf("gate flapped at %d m°C while inside hysteresis band", v)
		}
	}
	if _, changed = thermalDecision(curr, 74000, true, 80000); !changed {
		t.Fatal("expected release at 74°C (below 75°C margin)")
	}
}

func TestSetThermalSensor_LazyGauge(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	m.setThermalSensor("k10temp", "Tctl", 71.5)
	m.setThermalSensor("k10temp", "Tctl", 72.25) // update same series
	m.setThermalSensor("amdgpu", "edge", 65.0)
	var buf bytes.Buffer
	if err := reg.WriteText(&buf); err != nil {
		t.Fatalf("WriteText: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, "otedama_thermal_sensor_celsius") ||
		!strings.Contains(out, `source="k10temp"`) ||
		!strings.Contains(out, `label="Tctl"`) ||
		!strings.Contains(out, "72.25") {
		t.Errorf("thermal sensor series missing or wrong:\n%s", out)
	}
}
