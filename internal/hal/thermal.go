// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package hal

// ThermalReading is one hwmon temperature observation.
//
// Source is the hwmon device name (e.g. "k10temp", "coretemp", "amdgpu",
// "nvme"); Label is the sensor's temp*_label when the driver provides one
// (e.g. "Tctl", "edge") or the file index otherwise (e.g. "temp1").
// MilliCelsius is the raw sysfs value — drivers report thousandths of a
// degree Celsius.
//
// ReadThermalSensors is implemented per-platform: Linux scans sysfs
// hwmon (thermal_linux.go); other platforms return nil (thermal_stub.go)
// because their temperature APIs are out of v3 scope.
type ThermalReading struct {
	Source       string
	Label        string
	MilliCelsius int64
}
