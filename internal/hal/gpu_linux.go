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
// # Why not CGO/OpenCL?
//
// CGO adds build complexity, cross-compilation difficulty, and a larger
// dependency surface. The sysfs approach identifies GPUs reliably enough
// for Otedama's purposes: family classification (NVIDIA/AMD) and a
// human-readable model name. The actual compute dispatch (CUDA, ROCm,
// Vulkan compute) is implemented in the provider layer, not here.
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
type GPULinuxDriver struct{}

func (d *GPULinuxDriver) Name() string { return "gpu_linux" }

// Enumerate returns all GPU devices visible via DRM. If the DRM sysfs
// tree is absent or empty, Enumerate returns an empty slice with no
// error, so that the partial-failure policy in Detector applies.
func (d *GPULinuxDriver) Enumerate(_ context.Context) ([]Device, error) {
	const drmBase = "/sys/class/drm"
	entries, err := os.ReadDir(drmBase)
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
		devPath := filepath.Join(drmBase, name, "device")

		// Resolve the canonical device path to deduplicate multi-node GPUs.
		canonical, err := filepath.EvalSymlinks(devPath)
		if err != nil {
			canonical = devPath
		}
		if seen[canonical] {
			continue
		}
		seen[canonical] = true

		dev := parseGPUDevice(name, canonical)
		if dev != nil {
			devices = append(devices, dev)
		}
	}
	return devices, nil
}

// parseGPUDevice reads the PCI vendor/device IDs and the device name
// from sysfs and constructs a Device.
func parseGPUDevice(renderNode, devicePath string) Device {
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
		return nil
	}
	caps := Capabilities{
		SHA256d:        true, // all GPUs can run SHA256d
		GeneralCompute: true, // GPU implies general compute capability
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
	// Try uevent for DRIVER, which sometimes contains the model.
	uevent := readSysFile(filepath.Join(devicePath, "uevent"))
	for _, line := range strings.Split(uevent, "\n") {
		if strings.HasPrefix(line, "PCI_ID=") {
			pciID := strings.TrimPrefix(line, "PCI_ID=")
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
