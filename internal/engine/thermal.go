// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package engine

// thermalResumeHysteresisMilliC is the resume margin below the configured
// thermal_throttle_above_celsius threshold. Without it a sensor hovering
// at the boundary would flap hashing off/on every poll (a ~30 s
// curtail/resume oscillation is exactly the churn hysteresis exists to
// prevent); 5°C is a comfortably observable margin for chip sensors
// (Awesome Miner uses a comparable dead-band in its thermal triggers).
const thermalResumeHysteresisMilliC int64 = 5000

// thermalDecision is the pure decision function for the thermal-throttle
// gate — the thermal counterpart of curtailDecision. Given the current
// gate state and the hottest observed sensor, it returns the next state
// and whether it changed.
//
// Safety rule (same untrusted-input semantics as the price gate): a poll
// that produced no valid reading (ok=false — hwmon absent, every sensor
// unparsable, or the platform stub) NEVER changes the gate. Missing data
// must not pause hashing, and must not resume it either: a sensor that
// vanishes while we are already paused could mean exactly the thermal
// distress we are protecting against, so the last trusted state holds.
//
// A threshold <= 0 disables the gate entirely.
func thermalDecision(curr bool, maxMilliC int64, ok bool, thresholdMilli int64) (next, changed bool) {
	if thresholdMilli <= 0 || !ok {
		return curr, false
	}
	switch {
	case !curr && maxMilliC >= thresholdMilli:
		return true, true // hottest sensor crossed the threshold → pause
	case curr && maxMilliC < thresholdMilli-thermalResumeHysteresisMilliC:
		return false, true // cooled 5°C below threshold → resume
	default:
		return curr, false
	}
}
