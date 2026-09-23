// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package hal

import "testing"

// Real ConvertTo-Json shapes: an array when >1 controller, a bare
// object when exactly one, null when none.
const fixtureArray = `[
	{
		"Name": "NVIDIA GeForce RTX 4090",
		"AdapterCompatibility": "NVIDIA",
		"AdapterRAM": 4293918720,
		"PNPDeviceID": "PCI\\VEN_10DE&DEV_2684&SUBSYS_51071462&REV_A1\\4&2F2357E9&0&0009"
	},
	{
		"Name": "Intel(R) UHD Graphics 770",
		"AdapterCompatibility": "Intel Corporation",
		"AdapterRAM": 1073741824,
		"PNPDeviceID": "PCI\\VEN_8086&DEV_4680&SUBSYS_86941043&REV_0C\\3&11583659&0&10"
	},
	{
		"Name": "Microsoft Basic Display Adapter",
		"AdapterCompatibility": "Microsoft Corporation",
		"AdapterRAM": 0,
		"PNPDeviceID": "PCI\\VEN_1234&DEV_1111&SUBSYS_00000000&REV_00\\3&11583659&0&11"
	}
]`

const fixtureSingle = `{
	"Name": "AMD Radeon RX 6800",
	"AdapterCompatibility": "Advanced Micro Devices, Inc.",
	"AdapterRAM": 17163091968,
	"PNPDeviceID": "PCI\\VEN_1002&DEV_73BF&SUBSYS_0E361002&REV_C1\\6&1AB6C12D&0&00000010"
}`

func TestParseVideoControllers_ArraySkipsVirtual(t *testing.T) {
	rows, err := parseVideoControllers([]byte(fixtureArray))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("got %d rows, want 3", len(rows))
	}
	if cimIsVirtualAdapter(&rows[2]) != true {
		t.Error("Microsoft Basic Display Adapter should classify as virtual")
	}
	if cimIsVirtualAdapter(&rows[0]) || cimIsVirtualAdapter(&rows[1]) {
		t.Error("physical GPUs wrongly classified as virtual")
	}
}

func TestParseVideoControllers_BareObjectAndNull(t *testing.T) {
	rows, err := parseVideoControllers([]byte(fixtureSingle))
	if err != nil || len(rows) != 1 {
		t.Fatalf("bare object = (%v,%d), want (nil,1)", err, len(rows))
	}
	if rows[0].Name != "AMD Radeon RX 6800" {
		t.Errorf("name = %q", rows[0].Name)
	}
	for _, in := range []string{`null`, ``, `  `} {
		rows, err := parseVideoControllers([]byte(in))
		if err != nil || len(rows) != 0 {
			t.Errorf("input %q = (%v,%d), want (nil,0)", in, err, len(rows))
		}
	}
	if _, err := parseVideoControllers([]byte(`{broken`)); err == nil {
		t.Error("malformed JSON should error")
	}
}

func TestCIMVendor(t *testing.T) {
	for label, tc := range map[string]struct {
		compat, name, want string
	}{
		"compat-nvidia": {"NVIDIA", "NVIDIA GeForce RTX 4090", "NVIDIA"},
		"compat-amd":    {"Advanced Micro Devices, Inc.", "AMD Radeon RX 6800", "AMD"},
		"compat-intel":  {"Intel Corporation", "UHD Graphics", "Intel"},
		"model-only":    {"", "NVIDIA GeForce GTX 1060", "NVIDIA"},
		"unknown":       {"", "Some Obscure Card", "Unknown GPU vendor"},
	} {
		c := &cimVideoController{Name: tc.name, Compatibility: tc.compat}
		if got := cimVendor(c); got != tc.want {
			t.Errorf("%s: vendor = %q, want %q", label, got, tc.want)
		}
	}
}

func TestCIMModel(t *testing.T) {
	c := &cimVideoController{Name: "NVIDIA GeForce RTX 4090", AdapterRAM: 4293918720}
	if got := cimModel(c); got != "NVIDIA GeForce RTX 4090 (3 GiB)" {
		t.Errorf("model = %q", got)
	}
	// Negative AdapterRAM (driver quirk) and zero both suppress the annotation.
	c.AdapterRAM = -1
	if got := cimModel(c); got != "NVIDIA GeForce RTX 4090" {
		t.Errorf("negative-RAM model = %q", got)
	}
	// Nameless row still yields a descriptive model.
	c2 := &cimVideoController{Compatibility: "Advanced Micro Devices, Inc."}
	if got := cimModel(c2); got != "AMD GPU" {
		t.Errorf("nameless model = %q", got)
	}
}

func TestHumanBytes(t *testing.T) {
	for b, want := range map[uint64]string{
		17163091968: "15 GiB",
		1073741824:  "1 GiB",
		536870912:   "512 MiB",
	} {
		if got := humanBytes(b); got != want {
			t.Errorf("humanBytes(%d) = %q, want %q", b, got, want)
		}
	}
}
