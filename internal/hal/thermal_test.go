// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package hal

import "testing"

// ReadThermalSensors is nil-safe on every platform: the caller contract is
// that an empty result means "no data", never an error and never a
// fabricated zero. This guards the stub contract on non-Linux builds and
// the scan contract on hosts with no hwmon entries.
func TestReadThermalSensors_NilSafe(t *testing.T) {
	for _, r := range ReadThermalSensors() {
		if r.Source == "" {
			t.Error("reading with empty Source must never be emitted")
		}
		if r.Label == "" {
			t.Error("reading with empty Label must never be emitted")
		}
	}
}
