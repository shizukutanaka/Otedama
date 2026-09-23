// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

//go:build !linux

package hal

// ReadThermalSensors returns nil on non-Linux platforms: temperature
// reporting lives in the Linux hwmon sysfs interface, and macOS/Windows
// temperature access requires platform APIs (IOKit SMC, WMI) that are out
// of v3 scope. Callers treat an empty result as "no data", so the thermal
// throttle gate simply stays disarmed.
func ReadThermalSensors() []ThermalReading {
	return nil
}
