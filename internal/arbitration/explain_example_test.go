// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
package arbitration

import (
	"fmt"
	"time"
)

// ExampleExplainText shows the table `otedama arb explain` renders.
func ExampleExplainText() {
	forecast, sigma, reliability := 1.42, 0.18, 0.92
	snap := &DecisionSnapshot{
		At:                 time.Date(2027, 8, 14, 14, 32, 11, 0, time.UTC),
		Policy:             PolicyMaximizeEarnings.String(),
		HysteresisPct:      0.05,
		MinYieldSatsPerSec: 0.01,
		TotalSatsPerSec:    1.51,
		Skipped:            1,
		Rows: []ExplainRow{
			{DeviceID: "asic-0", Stream: "pool:asic-0", ExpectedSatsPerSec: 1.51,
				ForecastSatsPerSec: &forecast, ForecastSigmaSatsPerSec: &sigma,
				Reliability: &reliability, ReliabilityAlpha: 89, ReliabilityBeta: 2.6},
			{DeviceID: "gpu-0", Reason: "no viable stream"},
		},
	}
	fmt.Print(ExplainText(snap))
	// Output:
	// === Otedama arbitration decision (2027-08-14 14:32:11) ===
	// Policy: maximize_earnings · hysteresis 5% · min yield 0.01 sat/s
	// Devices: 2 · idle: 1 · expected: 1.51 sat/s
	//
	// Device  Stream       Yield       Forecast     Reliability             Detail
	// ──────  ───────────  ──────────  ───────────  ──────────────────────  ────────────────
	// asic-0  pool:asic-0  1.51 sat/s  1.42 ±0.18   0.92 (α=89.0, β=2.6)    stay
	// gpu-0   (idle)       —           —            —                       no viable stream
}
