// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

//go:build linux

package hal

import (
	"os"
	"path/filepath"
	"testing"
)

func writeSensor(t *testing.T, root, dev, name, input, label, value string) {
	t.Helper()
	dir := filepath.Join(root, dev)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "name"), []byte(name), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, input+"_input"), []byte(value), 0o644); err != nil {
		t.Fatal(err)
	}
	if label != "" {
		if err := os.WriteFile(filepath.Join(dir, input+"_label"), []byte(label), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestReadThermalSensors_FixtureTree(t *testing.T) {
	root := t.TempDir()
	old := hwmonRoot
	hwmonRoot = root
	defer func() { hwmonRoot = old }()

	writeSensor(t, root, "hwmon0", "k10temp", "temp1", "Tctl", "71500")
	writeSensor(t, root, "hwmon0", "k10temp", "temp2", "Tccd1", "68000")
	writeSensor(t, root, "hwmon1", "amdgpu", "temp1", "edge", "61234")
	writeSensor(t, root, "hwmon2", "nvme", "temp1", "", "42000")
	// Unparsable and non-temp entries must be skipped, not reported as 0°C.
	dir := filepath.Join(root, "hwmon3")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "temp1_input"), []byte("garbage"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "fan1_input"), []byte("1200"), 0o644); err != nil {
		t.Fatal(err)
	}

	got := ReadThermalSensors()
	if len(got) != 4 {
		t.Fatalf("got %d readings, want 4: %+v", len(got), got)
	}
	seen := map[string]int64{}
	for _, r := range got {
		seen[r.Source+"/"+r.Label] = r.MilliCelsius
	}
	want := map[string]int64{
		"k10temp/Tctl":  71500,
		"k10temp/Tccd1": 68000,
		"amdgpu/edge":   61234,
		"nvme/temp1":    42000, // no temp*_label → falls back to file index
	}
	for k, v := range want {
		if seen[k] != v {
			t.Errorf("sensor %s = %d, want %d (all: %v)", k, seen[k], v, seen)
		}
	}
}

func TestReadThermalSensors_NoHwmon(t *testing.T) {
	old := hwmonRoot
	hwmonRoot = filepath.Join(t.TempDir(), "does-not-exist")
	defer func() { hwmonRoot = old }()
	if got := ReadThermalSensors(); len(got) != 0 {
		t.Errorf("got %d readings on missing hwmon root, want 0", len(got))
	}
}
