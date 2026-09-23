// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

//go:build windows

package hal

import (
	"context"
	"errors"
	"testing"
)

func stubCIM(t *testing.T, out []byte, err error) {
	t.Helper()
	orig := videoControllersJSON
	videoControllersJSON = func(context.Context) ([]byte, error) { return out, err }
	t.Cleanup(func() { videoControllersJSON = orig })
}

func TestGPUWindowsDriver_PhysicalAndVirtual(t *testing.T) {
	stubCIM(t, []byte(fixtureArray), nil)
	var logs []string
	devs, err := (&GPUWindowsDriver{LogFn: func(s string) { logs = append(logs, s) }}).Enumerate(context.Background())
	if err != nil {
		t.Fatalf("Enumerate: %v", err)
	}
	if len(devs) != 2 {
		t.Fatalf("got %d devices, want 2 (virtual adapter skipped)", len(devs))
	}
	if len(logs) == 0 {
		t.Error("virtual-adapter skip should be logged")
	}
	nv, intel := devs[0].Identity(), devs[1].Identity()
	if nv.Vendor != "NVIDIA" || nv.ID != "gpu-2684" {
		t.Errorf("nvidia = %+v", nv)
	}
	if nv.Model != "NVIDIA GeForce RTX 4090 (3 GiB)" {
		t.Errorf("nvidia.Model = %q", nv.Model)
	}
	if intel.Vendor != "Intel" || intel.ID != "gpu-4680" {
		t.Errorf("intel = %+v", intel)
	}
	if devs[0].Capabilities().SHA256d {
		t.Error("SHA256d must stay false — no compute dispatch exists")
	}
	if !devs[0].Capabilities().GeneralCompute {
		t.Error("GeneralCompute should be true for a GPU")
	}
}

func TestGPUWindowsDriver_SingleRowAndEmpty(t *testing.T) {
	stubCIM(t, []byte(fixtureSingle), nil)
	devs, err := (&GPUWindowsDriver{}).Enumerate(context.Background())
	if err != nil || len(devs) != 1 {
		t.Fatalf("single row = (%v,%d)", err, len(devs))
	}
	if devs[0].Identity().Vendor != "AMD" {
		t.Errorf("vendor = %q", devs[0].Identity().Vendor)
	}

	stubCIM(t, []byte(`null`), nil)
	devs, err = (&GPUWindowsDriver{}).Enumerate(context.Background())
	if err != nil || len(devs) != 0 {
		t.Errorf("null report = (%v,%d), want (nil,0)", err, len(devs))
	}
}

func TestGPUWindowsDriver_CommandFailureIsNotFatal(t *testing.T) {
	stubCIM(t, nil, errors.New("exit status 1"))
	devs, err := (&GPUWindowsDriver{}).Enumerate(context.Background())
	if err != nil || devs != nil {
		t.Errorf("command failure = (%v,%v), want (nil,nil)", err, devs)
	}
}

func TestWindowsGPUID(t *testing.T) {
	c := &cimVideoController{PNPDeviceID: `PCI\VEN_10DE&DEV_2684&SUBSYS_X\4&X&0&0009`}
	if got := windowsGPUID(0, c); got != "gpu-2684" {
		t.Errorf("id = %q, want gpu-2684", got)
	}
	// Lowercase dev_ is accepted; a row without PNPDeviceID falls back
	// to its report position.
	c.PNPDeviceID = `pci\ven_8086&dev_46a0`
	if got := windowsGPUID(3, c); got != "gpu-46A0" {
		t.Errorf("lowercase id = %q, want gpu-46A0", got)
	}
	c.PNPDeviceID = ""
	if got := windowsGPUID(3, c); got != "gpu-win-3" {
		t.Errorf("fallback id = %q, want gpu-win-3", got)
	}
}
