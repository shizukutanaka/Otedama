// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

//go:build darwin

package hal

import (
	"context"
	"errors"
	"testing"
)

// Real-world shapes: Apple Silicon reports sppci_vendor_Apple with no
// sppci_model and no spdisplays_device-id; Intel-era discrete cards
// carry the PCI fields.
const fixtureAppleSilicon = `{
	"SPDisplaysDataType": [{
		"_name": "Apple M4 Pro",
		"spdisplays_cores": "20",
		"spdisplays_metal": "spdisplays_metal_featuresetfamily_mac_2",
		"spdisplays_vendor": "sppci_vendor_Apple",
		"spdisplays_vram_shared": "24 GB",
		"spdisplays_ndrvs": [{"_name": "Color LCD"}]
	}]
}`

const entryIntelAMD = `{
		"_name": "Radeon Pro 580X",
		"spdisplays_device-id": "0x67df",
		"spdisplays_metal": "spdisplays_metal_supported",
		"spdisplays_vendor": "0x1002",
		"spdisplays_vram": "8 GB",
		"sppci_bus": "sppci_pcie_device",
		"sppci_model": "Radeon Pro 580X"
	}`

const entryNVIDIA = `{
		"_name": "GeForce GT 750M",
		"spdisplays_device-id": "0x0fe9",
		"spdisplays_vendor": "0x10de",
		"spdisplays_vram": "2 GB",
		"sppci_model": "NVIDIA GeForce GT 750M"
	}`

const fixtureVM = `{"SPDisplaysDataType": []}`

func stubProfiler(t *testing.T, out []byte, err error) {
	t.Helper()
	orig := systemProfilerDisplays
	systemProfilerDisplays = func(context.Context) ([]byte, error) { return out, err }
	t.Cleanup(func() { systemProfilerDisplays = orig })
}

func TestGPUDarwinDriver_AppleSilicon(t *testing.T) {
	stubProfiler(t, []byte(fixtureAppleSilicon), nil)
	devs, err := (&GPUDarwinDriver{}).Enumerate(context.Background())
	if err != nil {
		t.Fatalf("Enumerate: %v", err)
	}
	if len(devs) != 1 {
		t.Fatalf("got %d devices, want 1", len(devs))
	}
	id := devs[0].Identity()
	if id.Family != FamilyGPU || id.Vendor != "Apple" {
		t.Errorf("identity = %+v", id)
	}
	if id.ID != "gpu-mac-0" {
		t.Errorf("ID = %q, want gpu-mac-0 (Apple Silicon has no PCI device-id)", id.ID)
	}
	if id.Model != "Apple M4 Pro (24 GB)" {
		t.Errorf("Model = %q, want shared-VRAM annotation", id.Model)
	}
	caps := devs[0].Capabilities()
	if caps.SHA256d {
		t.Error("SHA256d must stay false — no compute dispatch exists")
	}
	if !caps.GeneralCompute {
		t.Error("GeneralCompute should be true for a GPU")
	}
}

func TestGPUDarwinDriver_DiscreteCards(t *testing.T) {
	stubProfiler(t, []byte(`{"SPDisplaysDataType": [`+entryIntelAMD+`,`+entryNVIDIA+`]}`), nil)
	devs, err := (&GPUDarwinDriver{}).Enumerate(context.Background())
	if err != nil {
		t.Fatalf("Enumerate: %v", err)
	}
	if len(devs) != 2 {
		t.Fatalf("got %d devices, want 2", len(devs))
	}
	amd, nv := devs[0].Identity(), devs[1].Identity()
	if amd.Vendor != "AMD" || amd.ID != "gpu-0x67df" {
		t.Errorf("amd = %+v", amd)
	}
	if amd.Model != "Radeon Pro 580X (8 GB)" {
		t.Errorf("amd.Model = %q", amd.Model)
	}
	if nv.Vendor != "NVIDIA" || nv.Model != "NVIDIA GeForce GT 750M (2 GB)" {
		t.Errorf("nvidia = %+v", nv)
	}
}

func TestGPUDarwinDriver_EmptyReport(t *testing.T) {
	// Virtual machines and headless boots report an empty category —
	// no GPUs, no error, matching the Linux driver's missing-sysfs policy.
	stubProfiler(t, []byte(fixtureVM), nil)
	devs, err := (&GPUDarwinDriver{}).Enumerate(context.Background())
	if err != nil || len(devs) != 0 {
		t.Errorf("empty report = (%v,%d), want (nil,0)", err, len(devs))
	}
}

func TestGPUDarwinDriver_CommandFailureIsNotFatal(t *testing.T) {
	stubProfiler(t, nil, errors.New("exit status 1"))
	devs, err := (&GPUDarwinDriver{}).Enumerate(context.Background())
	if err != nil || devs != nil {
		t.Errorf("command failure = (%v,%v), want (nil,nil)", err, devs)
	}
}

func TestGPUDarwinDriver_MalformedJSONIsAnError(t *testing.T) {
	stubProfiler(t, []byte(`not json`), nil)
	if _, err := (&GPUDarwinDriver{}).Enumerate(context.Background()); err == nil {
		t.Error("malformed report should surface as a driver error")
	}
}

func TestGPUDarwinDriver_SkipsUnidentifiableEntries(t *testing.T) {
	var logs []string
	stubProfiler(t, []byte(`{"SPDisplaysDataType": [{"spdisplays_ndrvs": []}]}`), nil)
	devs, err := (&GPUDarwinDriver{LogFn: func(s string) { logs = append(logs, s) }}).Enumerate(context.Background())
	if err != nil {
		t.Fatalf("Enumerate: %v", err)
	}
	if len(devs) != 0 {
		t.Errorf("unidentifiable entry produced %d devices", len(devs))
	}
}

func TestInferVendorFromModel(t *testing.T) {
	for model, want := range map[string]string{
		"NVIDIA GeForce GTX 780": "NVIDIA",
		"AMD Radeon RX 580":      "AMD",
		"Intel Iris Pro":         "Intel",
		"Apple M1 Pro":           "Apple",
		"GM204":                  "Unknown GPU vendor", // die name, not a model
		"Matrox G200eW":          "Unknown GPU vendor",
	} {
		if got := inferVendorFromModel(model); got != want {
			t.Errorf("inferVendorFromModel(%q) = %q, want %q", model, got, want)
		}
	}
}
