// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

//go:build darwin

// Package hal — gpu_darwin.go
//
// GPU detection for macOS using the system_profiler command's JSON
// output (system_profiler -json SPDisplaysDataType). No CGO, no IOKit
// bindings, no Metal framework: every macOS install ships
// system_profiler, which reports one entry per GPU — including
// headless Apple Silicon machines where the GPU has no display
// attached (entries without spdisplays_ndrvs still enumerate).
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
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

// GPUDarwinDriver enumerates GPU devices via system_profiler.
//
// LogFn is an optional callback that receives a message for each
// report entry that is skipped due to identity-validation failure.
// Nil = silent.
type GPUDarwinDriver struct {
	LogFn func(string)
}

func (d *GPUDarwinDriver) Name() string { return "gpu_darwin" }

// systemProfilerDisplays fetches the displays report. A variable so
// tests can substitute fixture output without shelling out.
var systemProfilerDisplays = func(ctx context.Context) ([]byte, error) {
	return exec.CommandContext(ctx, "system_profiler", "-json", "SPDisplaysDataType").Output()
}

// Enumerate returns all GPU devices reported by system_profiler.
// An absent tool or an empty report — e.g. inside a virtual machine,
// which exposes no SPDisplaysDataType entries — yields an empty slice
// and no error, matching the partial-failure policy of the Linux
// driver (missing /sys/class/drm).
func (d *GPUDarwinDriver) Enumerate(ctx context.Context) ([]Device, error) {
	out, err := systemProfilerDisplays(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		// system_profiler missing or failed — not an error, just no GPUs.
		return nil, nil
	}
	entries, err := parseSPDisplaysReport(out)
	if err != nil {
		return nil, fmt.Errorf("hal: gpu_darwin: %w", err)
	}

	var devices []Device
	for i := range entries {
		dev := parseDarwinGPU(i, &entries[i], d.LogFn)
		if dev != nil {
			devices = append(devices, dev)
		}
	}
	return devices, nil
}

// spDisplayEntry is one GPU record in the SPDisplaysDataType report.
// Fields are the key names system_profiler emits; all are optional
// (an entry may lack sppci_* keys on Apple Silicon).
type spDisplayEntry struct {
	Name       string `json:"_name"`
	Model      string `json:"sppci_model"`
	Vendor     string `json:"spdisplays_vendor"`
	DeviceID   string `json:"spdisplays_device-id"`
	Metal      string `json:"spdisplays_metal"`
	VRAM       string `json:"spdisplays_vram"`
	VRAMShared string `json:"spdisplays_vram_shared"`
}

type spDisplaysReport struct {
	SPDisplaysDataType []spDisplayEntry `json:"SPDisplaysDataType"`
}

func parseSPDisplaysReport(data []byte) ([]spDisplayEntry, error) {
	var report spDisplaysReport
	if err := json.Unmarshal(data, &report); err != nil {
		return nil, fmt.Errorf("parse system_profiler output: %w", err)
	}
	return report.SPDisplaysDataType, nil
}

// parseDarwinGPU builds a Device from one report entry. Entries that
// carry no identifying fields at all (Name/Model/Vendor all empty)
// are skipped; entries whose constructed Identity fails validation are
// logged and skipped.
func parseDarwinGPU(index int, e *spDisplayEntry, logFn func(string)) Device {
	vendor := inferVendorName(e.Vendor)
	model := e.Model
	if model == "" {
		model = e.Name
	}
	if model == "" && vendor == unknownGPUVendor {
		// Nothing to identify the card — skip rather than emit a
		// meaningless "Unknown GPU vendor GPU" row.
		return nil
	}
	if vendor == unknownGPUVendor {
		vendor = inferVendorFromModel(model)
	}
	if model == "" {
		model = vendor + " GPU"
	}
	if vram := firstNonEmpty(e.VRAM, e.VRAMShared); vram != "" {
		model = fmt.Sprintf("%s (%s)", model, vram)
	}

	id := Identity{
		ID:     darwinGPUID(index, e),
		Family: FamilyGPU,
		Vendor: vendor,
		Model:  model,
	}
	if err := id.Validate(); err != nil {
		if logFn != nil {
			logFn(fmt.Sprintf("hal: gpu_darwin: display entry %d skipped: %v", index, err))
		}
		return nil
	}
	return &darwinGPUDevice{
		id: id,
		caps: Capabilities{
			// See gpu_linux.go's package doc: SHA256d must stay false
			// until a real compute-dispatch path exists — a true value
			// would spawn a full CPU-only miner pool mislabeled under
			// this GPU's device ID.
			SHA256d:        false,
			GeneralCompute: true,
		},
	}
}

// darwinGPUID derives a stable per-process device ID: the PCI device
// ID when the report carries one (discrete cards), else the entry's
// position in the report, which is stable across enumerations.
func darwinGPUID(index int, e *spDisplayEntry) string {
	if e.DeviceID != "" {
		return "gpu-" + strings.ReplaceAll(e.DeviceID, " ", "-")
	}
	return fmt.Sprintf("gpu-mac-%d", index)
}

func firstNonEmpty(s ...string) string {
	for _, v := range s {
		if v != "" {
			return v
		}
	}
	return ""
}

// darwinGPUDevice implements Device for a GPU found via system_profiler.
type darwinGPUDevice struct {
	id   Identity
	caps Capabilities
}

func (d *darwinGPUDevice) Identity() Identity               { return d.id }
func (d *darwinGPUDevice) Capabilities() Capabilities       { return d.caps }
func (d *darwinGPUDevice) Shutdown(_ context.Context) error { return nil }

// RegisterGPU adds the platform GPU driver to the given registry.
func RegisterGPU(r *Registry) error {
	return r.Register(&GPUDarwinDriver{})
}
