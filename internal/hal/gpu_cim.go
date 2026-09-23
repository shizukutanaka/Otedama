// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

// Package hal — gpu_cim.go
//
// Pure parser for the Windows driver's data source: the JSON emitted by
//
//	Get-CimInstance Win32_VideoController | ConvertTo-Json -Compress
//
// Kept untagged (no //go:build) so the parsing logic compiles and tests
// run on every platform; only the powershell invocation in
// gpu_windows.go is Windows-only.
package hal

import (
	"encoding/json"
	"fmt"
	"strings"
)

// cimVideoController is one row of Win32_VideoController output.
type cimVideoController struct {
	Name          string `json:"Name"`
	Compatibility string `json:"AdapterCompatibility"`
	// AdapterRAM is signed: CIM reports it through a field some drivers
	// emit as a negative int32.
	AdapterRAM  int64  `json:"AdapterRAM"`
	PNPDeviceID string `json:"PNPDeviceID"`
}

// parseVideoControllers decodes the ConvertTo-Json payload. PowerShell
// emits a bare object — not an array — when exactly one controller
// exists, so both shapes are accepted. A null payload (no controllers)
// parses as nil.
func parseVideoControllers(data []byte) ([]cimVideoController, error) {
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" || trimmed == "null" {
		return nil, nil
	}
	var list []cimVideoController
	if trimmed[0] == '[' {
		if err := json.Unmarshal([]byte(trimmed), &list); err != nil {
			return nil, fmt.Errorf("parse video controllers: %w", err)
		}
		return list, nil
	}
	var single cimVideoController
	if err := json.Unmarshal([]byte(trimmed), &single); err != nil {
		return nil, fmt.Errorf("parse video controllers: %w", err)
	}
	return []cimVideoController{single}, nil
}

// cimIsVirtualAdapter reports whether a row is a software display
// adapter rather than physical GPU hardware — the Windows analog of
// skipping unidentifiable entries elsewhere. Such adapters report a
// Vendor of Microsoft (or none) and names from a small known set.
func cimIsVirtualAdapter(c *cimVideoController) bool {
	name := strings.ToLower(c.Name)
	for _, v := range []string{
		"microsoft basic display", "microsoft remote display",
		"remotefx", "virtual display", "vmware svga", "virtualbox graphics",
		"hyper-v video", "qemu", "virtio",
	} {
		if strings.Contains(name, v) {
			return true
		}
	}
	return false
}

// cimVendor maps AdapterCompatibility ("NVIDIA", "Advanced Micro
// Devices, Inc.", "Intel Corporation", "Microsoft Corporation") to the
// shared vendor names, falling back to the model name when the field
// is absent or unrecognized.
func cimVendor(c *cimVideoController) string {
	switch v := strings.ToLower(c.Compatibility); {
	case strings.Contains(v, "nvidia"):
		return vendorNVIDIA
	case strings.Contains(v, "advanced micro devices"), strings.Contains(v, "amd"):
		return vendorAMD
	case strings.Contains(v, "intel"):
		return vendorIntel
	case strings.Contains(v, "apple"):
		return vendorApple
	}
	if v := inferVendorFromModel(c.Name); v != unknownGPUVendor {
		return v
	}
	return unknownGPUVendor
}

// cimModel is the human-readable model: the controller Name plus a
// VRAM annotation when AdapterRAM reports a positive size.
func cimModel(c *cimVideoController) string {
	model := c.Name
	if model == "" {
		model = cimVendor(c) + " GPU"
	}
	if c.AdapterRAM > 0 {
		model = fmt.Sprintf("%s (%s)", model, humanBytes(uint64(c.AdapterRAM)))
	}
	return model
}

// humanBytes renders bytes as GiB/MiB for the model annotation.
func humanBytes(b uint64) string {
	const gib = 1 << 30
	if b >= gib {
		return fmt.Sprintf("%d GiB", b/gib)
	}
	return fmt.Sprintf("%d MiB", b/(1<<20))
}
