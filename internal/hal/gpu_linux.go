// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

//go:build linux

// Package hal — gpu_linux.go
//
// GPU detection for Linux using the sysfs DRM subsystem.
// No CGO, no CUDA SDK, no OpenCL headers required: only standard file
// system access to /sys/class/drm, which is available on all modern
// Linux kernels (5.4+) without any special permissions.
//
// # Why render nodes and not card nodes (documented session 262)
//
// This driver enumerates /sys/class/drm/renderD*, not card*. That is a
// deliberate narrowing, and it differs from what general-purpose hardware
// inventories do — jaypipes/ghw, the usual Go reference for this, scans
// card* and filters connector entries by rejecting names containing "-".
// The distinction is load-bearing here, so it is worth stating rather than
// leaving for someone to "fix" toward the more common pattern:
//
//   - The kernel always creates a primary node: "The primary node is always
//     created and called card<num>". A render node exists only when the
//     driver asks for one — "If a driver supports render nodes, it must
//     advertise it via the DRIVER_RENDER DRM driver capability"
//     (Documentation/gpu/drm-uapi.rst).
//   - So card* answers "is there a DRM device here", which includes
//     display-only hardware a compute scheduler must never consider: the
//     BMC display chips on servers (ast, mgag200), simpledrm/efifb
//     framebuffers, and similar. renderD* answers "will this device accept
//     render clients", which is the question Otedama is actually asking.
//   - Every GPU that could plausibly do compute advertises DRIVER_RENDER:
//     amdgpu, i915/xe, and nouveau in-tree, and NVIDIA's proprietary stack
//     sets it unconditionally in nvidia-drm's drm_driver
//     (DRIVER_GEM | DRIVER_RENDER, verified in NVIDIA/open-gpu-kernel-modules,
//     kernel-open/nvidia-drm/nvidia-drm-drv.c). Narrowing to render nodes
//     therefore costs no real GPU.
//
// A side benefit: connector directories are named after the card they hang
// off (card0-HDMI-A-1), so the "renderD" prefix excludes them for free —
// the trap a card* scan has to guard against explicitly.
//
// The consequence to be aware of: a DRM device whose driver does not
// advertise DRIVER_RENDER is invisible to Otedama by design, not by
// oversight (docs/KNOWN_LIMITATIONS.md §4).
//
// # Why not CGO/OpenCL?
//
// CGO adds build complexity, cross-compilation difficulty, and a larger
// dependency surface. The sysfs approach identifies GPUs reliably enough
// for Otedama's purposes: family classification (NVIDIA/AMD) and a
// human-readable model name.
//
// # No GPU compute dispatch exists yet
//
// Detecting a GPU here does not mean Otedama can mine Bitcoin on it: no
// CUDA, ROCm, or Vulkan compute dispatch is implemented anywhere in this
// codebase (checked repo-wide, session 243). A detected GPU's
// Capabilities.SHA256d is therefore false, so
// internal/engine.startMinerWorkers correctly skips it rather than
// spawning a CPU-only miner.Worker mislabeled under the GPU's device ID
// (the bug this comment replaces — SHA256d was previously hardcoded
// true). GeneralCompute stays true because it is an accurate statement
// about the hardware, but no shipped provider consumes it today: the
// simulated AI-inference market that used to has been deleted, so a
// detected GPU is compatible with no revenue stream and stays idle.
package hal

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// GPULinuxDriver enumerates GPU devices via the Linux DRM sysfs interface.
// It discovers all render nodes (/sys/class/drm/renderD*) and classifies
// each by vendor using the PCI vendor ID.
//
// LogFn is an optional callback that receives a message for each render node
// that is skipped due to identity-validation failure. Nil = silent.
type GPULinuxDriver struct {
	LogFn func(string)
}

func (d *GPULinuxDriver) Name() string { return "gpu_linux" }

// drmBasePath is the sysfs DRM directory scanned for render devices;
// overridable in tests so the loop can be exercised without real GPU hardware.
var drmBasePath = "/sys/class/drm"

// Enumerate returns all GPU devices visible via DRM. If the DRM sysfs
// tree is absent or empty, Enumerate returns an empty slice with no
// error, so that the partial-failure policy in Detector applies.
func (d *GPULinuxDriver) Enumerate(_ context.Context) ([]Device, error) {
	entries, err := os.ReadDir(drmBasePath)
	if err != nil {
		// DRM not available — not an error, just no GPUs detected.
		return nil, nil
	}

	var devices []Device
	seen := make(map[string]bool)

	for _, e := range entries {
		name := e.Name()
		// renderD* are the render nodes (one per GPU, no display connector).
		if !strings.HasPrefix(name, "renderD") {
			continue
		}
		devPath := filepath.Join(drmBasePath, name, "device")

		// Resolve the canonical device path to deduplicate multi-node GPUs.
		canonical, err := filepath.EvalSymlinks(devPath)
		if err != nil {
			canonical = devPath
		}
		if seen[canonical] {
			continue
		}
		seen[canonical] = true

		dev := parseGPUDevice(name, canonical, d.LogFn)
		if dev != nil {
			devices = append(devices, dev)
		}
	}
	return devices, nil
}

// parseGPUDevice reads the PCI vendor/device IDs and the device name
// from sysfs and constructs a Device. logFn, if non-nil, is called when
// the constructed identity fails validation and the device is skipped.
func parseGPUDevice(renderNode, devicePath string, logFn func(string)) Device {
	vendor := readSysFile(filepath.Join(devicePath, "vendor"))
	model := inferModel(devicePath, vendor)
	vendorName := inferVendorName(vendor)

	id := Identity{
		ID:     fmt.Sprintf("gpu-%s", renderNode), // e.g. "gpu-renderD128"
		Family: FamilyGPU,
		Vendor: vendorName,
		Model:  model,
	}
	if err := id.Validate(); err != nil {
		if logFn != nil {
			logFn(fmt.Sprintf("hal: gpu_linux: render node %s skipped: %v", renderNode, err))
		}
		return nil
	}
	caps := Capabilities{
		// SHA256d is deliberately false: no CUDA/ROCm/Vulkan compute
		// dispatch exists anywhere in this codebase (see the package doc
		// above). Before this fix it was hardcoded true, so
		// engine.startMinerWorkers — which spawns one full
		// runtime.NumCPU()-thread miner.Worker per SHA256d-capable device
		// — spawned a SECOND complete CPU-only hashing pool for every
		// detected GPU, on top of the real CPU device's own pool. Net
		// effect: 2x thread oversubscription, and every share that pool
		// found got attributed to the GPU's device ID in
		// otedama_device_shares_found_total and the arbitration engine's
		// live hashrate sampling — both silently reporting CPU-speed
		// numbers as if they came from the GPU. See
		// docs/KNOWN_LIMITATIONS.md for the current disclosure.
		SHA256d:        false,
		GeneralCompute: true, // an accurate statement about the hardware; no shipped provider consumes it today, so it spawns no workers and causes no oversubscription
	}
	return &linuxGPUDevice{id: id, caps: caps}
}

// inferVendorName maps PCI vendor ID strings to human-readable names.
func inferVendorName(vendorID string) string {
	switch strings.TrimSpace(vendorID) {
	case "0x10de":
		return "NVIDIA"
	case "0x1002":
		return "AMD"
	case "0x8086":
		return "Intel"
	default:
		return "Unknown GPU vendor"
	}
}

// inferModel reads the product name from sysfs, falling back to the
// PCI device ID if no name is available.
func inferModel(devicePath, vendorID string) string {
	// The PCI uevent carries PCI_ID=<vendor>:<device> (alongside DRIVER,
	// PCI_SLOT_NAME and friends). Nothing in sysfs gives a marketing name
	// without a PCI ID database, so the vendor plus that pair is the most
	// specific honest label available. (This comment used to say it read
	// DRIVER "which sometimes contains the model" — DRIVER holds the module
	// name, "amdgpu" or "nvidia", and the code has always parsed PCI_ID.)
	uevent := readSysFile(filepath.Join(devicePath, "uevent"))
	for _, line := range strings.Split(uevent, "\n") {
		if pciID, ok := strings.CutPrefix(line, "PCI_ID="); ok {
			vendor := inferVendorName(vendorID)
			return fmt.Sprintf("%s GPU (%s)", vendor, pciID)
		}
	}
	return inferVendorName(vendorID) + " GPU"
}

// readSysFile reads a sysfs attribute file and returns its content,
// with leading/trailing whitespace trimmed. Returns empty string on error.
func readSysFile(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// linuxGPUDevice implements Device for a GPU discovered via DRM.
type linuxGPUDevice struct {
	id   Identity
	caps Capabilities
}

func (d *linuxGPUDevice) Identity() Identity               { return d.id }
func (d *linuxGPUDevice) Capabilities() Capabilities       { return d.caps }
func (d *linuxGPUDevice) Shutdown(_ context.Context) error { return nil }

// RegisterGPULinux adds the Linux GPU driver to the given registry.
// Call this from engine/run.go on Linux builds.
func RegisterGPULinux(r *Registry) error {
	return r.Register(&GPULinuxDriver{})
}
