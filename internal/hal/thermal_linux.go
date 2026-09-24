// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

//go:build linux

package hal

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// hwmonRoot is the sysfs hwmon mount point; a variable so tests can point
// the scanner at a fixture tree.
var hwmonRoot = "/sys/class/hwmon"

// ReadThermalSensors scans every hwmon device under hwmonRoot and returns
// one reading per tempN_input file that parses. Unreadable or
// unparsable entries are skipped rather than reported as zero — a missing
// sensor is "unknown", never "0°C". On a host with no hwmon support (VMs,
// containers without /sys, drivers that expose no temperature channel) the
// result is empty, which callers must treat as "no data", not "cool".
func ReadThermalSensors() []ThermalReading {
	entries, err := os.ReadDir(hwmonRoot)
	if err != nil {
		return nil
	}
	var out []ThermalReading
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(hwmonRoot, e.Name())
		source := readSysfsString(filepath.Join(dir, "name"))
		if source == "" {
			source = e.Name()
		}
		matches, err := filepath.Glob(filepath.Join(dir, "temp*_input"))
		if err != nil {
			continue
		}
		for _, inputPath := range matches {
			v, ok := readSysfsInt(inputPath)
			if !ok {
				continue
			}
			// tempN_input pairs with optional tempN_label in the same dir.
			base := filepath.Base(inputPath)
			label := ""
			if idx := strings.TrimSuffix(strings.TrimPrefix(base, "temp"), "_input"); idx != "" {
				label = readSysfsString(filepath.Join(dir, "temp"+idx+"_label"))
			}
			if label == "" {
				label = strings.TrimSuffix(base, "_input")
			}
			out = append(out, ThermalReading{
				Source:       source,
				Label:        label,
				MilliCelsius: v,
			})
		}
	}
	return out
}

func readSysfsString(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func readSysfsInt(path string) (int64, bool) {
	s := readSysfsString(path)
	if s == "" {
		return 0, false
	}
	v, err := strconv.ParseInt(s, 10, 64)
	return v, err == nil
}
