// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

//go:build windows

// Package hal — gpu_windows.go
//
// GPU detection for Windows using PowerShell's CIM query:
//
//	powershell -NoProfile -NonInteractive -Command
//	  "Get-CimInstance Win32_VideoController | ConvertTo-Json -Compress"
//
// No CGO, no WMI/dmog bindings, no DXGI: powershell.exe ships with every
// supported Windows release and Win32_VideoController covers discrete
// and integrated GPUs. (Get-CimInstance rather than the deprecated wmic
// binary, which Microsoft removed from recent Windows builds.)
//
// The JSON parsing lives in gpu_cim.go — untagged, so its tests run on
// every platform; only this file's process invocation is Windows-only.
//
// # No GPU compute dispatch exists yet
//
// Detecting a GPU here does not mean Otedama can mine Bitcoin on it,
// for the same reason documented in gpu_linux.go: no CUDA, ROCm,
// Metal, or Vulkan compute dispatch exists anywhere in this codebase.
// Capabilities.SHA256d stays false so engine.startMinerWorkers skips
// the device; GeneralCompute stays true for the simulated
// AI-inference stream, which spawns no worker threads.
package hal

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
)

// GPUWindowsDriver enumerates GPU devices via Win32_VideoController.
//
// LogFn is an optional callback that receives a message for each
// report entry that is skipped (virtual adapters, identity-validation
// failures). Nil = silent.
type GPUWindowsDriver struct {
	LogFn func(string)
}

func (d *GPUWindowsDriver) Name() string { return "gpu_windows" }

// videoControllersJSON fetches the CIM report. A variable so tests on
// Windows can substitute fixture output without shelling out.
var videoControllersJSON = func(ctx context.Context) ([]byte, error) {
	return exec.CommandContext(ctx, "powershell",
		"-NoProfile", "-NonInteractive", "-Command",
		"Get-CimInstance Win32_VideoController | ConvertTo-Json -Compress").Output()
}

// Enumerate returns all physical GPU devices reported by CIM.
// An absent powershell.exe or an empty report yields an empty slice
// and no error, matching the partial-failure policy of the other
// platform drivers (missing /sys/class/drm, empty system_profiler).
func (d *GPUWindowsDriver) Enumerate(ctx context.Context) ([]Device, error) {
	out, err := videoControllersJSON(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		// powershell missing or failed — not an error, just no GPUs.
		return nil, nil
	}
	entries, err := parseVideoControllers(out)
	if err != nil {
		return nil, fmt.Errorf("hal: gpu_windows: %w", err)
	}

	var devices []Device
	for i := range entries {
		dev := parseWindowsGPU(i, &entries[i], d.LogFn)
		if dev != nil {
			devices = append(devices, dev)
		}
	}
	return devices, nil
}

// parseWindowsGPU builds a Device from one controller row. Virtual and
// unidentifiable adapters are skipped; rows whose constructed Identity
// fails validation are logged and skipped.
func parseWindowsGPU(index int, c *cimVideoController, logFn func(string)) Device {
	if cimIsVirtualAdapter(c) {
		if logFn != nil {
			logFn(fmt.Sprintf("hal: gpu_windows: virtual adapter %q skipped", c.Name))
		}
		return nil
	}
	vendor := cimVendor(c)
	model := cimModel(c)
	if c.Name == "" && vendor == unknownGPUVendor {
		// Nothing to identify the device with.
		return nil
	}
	id := Identity{
		ID:     windowsGPUID(index, c),
		Family: FamilyGPU,
		Vendor: vendor,
		Model:  model,
	}
	if err := id.Validate(); err != nil {
		if logFn != nil {
			logFn(fmt.Sprintf("hal: gpu_windows: controller %d skipped: %v", index, err))
		}
		return nil
	}
	return &windowsGPUDevice{
		id: id,
		caps: Capabilities{
			// See gpu_linux.go's package doc: SHA256d must stay false
			// until a real compute-dispatch path exists.
			SHA256d:        false,
			GeneralCompute: true,
		},
	}
}

// windowsGPUID derives a stable per-process ID: the PNP device ID's
// DEV_xxxx code when present (physical hardware identifier), else the
// row's position, which is stable across enumerations.
func windowsGPUID(index int, c *cimVideoController) string {
	if c.PNPDeviceID != "" {
		// PNPDeviceID looks like "PCI\VEN_10DE&DEV_2684&SUBSYS_...".
		for _, part := range strings.FieldsFunc(c.PNPDeviceID,
			func(r rune) bool { return r == '\\' || r == '&' }) {
			if dev, ok := strings.CutPrefix(strings.ToUpper(part), "DEV_"); ok {
				return "gpu-" + dev
			}
		}
	}
	return fmt.Sprintf("gpu-win-%d", index)
}

// windowsGPUDevice implements Device for a GPU found via CIM.
type windowsGPUDevice struct {
	id   Identity
	caps Capabilities
}

func (d *windowsGPUDevice) Identity() Identity               { return d.id }
func (d *windowsGPUDevice) Capabilities() Capabilities       { return d.caps }
func (d *windowsGPUDevice) Shutdown(_ context.Context) error { return nil }

// RegisterGPU adds the platform GPU driver to the given registry.
func RegisterGPU(r *Registry) error {
	return r.Register(&GPUWindowsDriver{})
}
