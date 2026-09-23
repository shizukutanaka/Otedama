// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

// Package hal — gpu_vendor.go
//
// Vendor-name normalisation shared by the per-platform GPU drivers
// (Linux sysfs PCI IDs, macOS system_profiler vendor fields).
package hal

import "strings"

// Vendor display names shared by the GPU drivers.
const (
	vendorNVIDIA     = "NVIDIA"
	vendorAMD        = "AMD"
	vendorIntel      = "Intel"
	vendorApple      = "Apple"
	unknownGPUVendor = "Unknown GPU vendor"
)

// inferVendorName maps PCI vendor ID strings to human-readable names.
// It also accepts macOS system_profiler vendor tokens such as
// "sppci_vendor_Apple" and already-plain names like "NVIDIA Corporation".
func inferVendorName(vendorID string) string {
	v := strings.TrimSpace(vendorID)
	v = strings.TrimPrefix(v, "sppci_vendor_")
	v = strings.TrimPrefix(v, "spdisplays_vendor_")
	switch v {
	case "0x10de":
		return vendorNVIDIA
	case "0x1002", "0x1022":
		return vendorAMD
	case "0x8086":
		return vendorIntel
	case vendorApple:
		return vendorApple
	case "":
		return unknownGPUVendor
	}
	if strings.HasPrefix(v, "0x") {
		return unknownGPUVendor
	}
	// Already a plain name (e.g. "NVIDIA Corporation").
	return v
}

// inferVendorFromModel guesses the vendor from a GPU's product name —
// the fallback when the platform reports no explicit vendor field.
func inferVendorFromModel(model string) string {
	switch m := strings.ToLower(model); {
	case strings.Contains(m, "nvidia"), strings.Contains(m, "geforce"),
		strings.Contains(m, "quadro"):
		return vendorNVIDIA
	case strings.Contains(m, "radeon"), strings.Contains(m, "amd"),
		strings.Contains(m, "ati "):
		return vendorAMD
	case strings.Contains(m, "intel"), strings.Contains(m, "iris"),
		strings.Contains(m, "uhd graphics"), strings.Contains(m, "hd graphics"):
		return vendorIntel
	case strings.Contains(m, "apple"):
		return vendorApple
	default:
		// Whole-token M-series chips ("Apple M1 Pro", "M2 Ultra") — a
		// bare "m1"/"m2" substring would false-positive on NVIDIA die
		// names like "GM204".
		for _, f := range strings.Fields(m) {
			switch f {
			case "m1", "m2", "m3", "m4", "m1pro", "m2pro", "m3pro", "m4pro",
				"m1max", "m2max", "m3max", "m4max", "m1ultra", "m2ultra",
				"m3ultra", "m4ultra":
				return vendorApple
			}
		}
		return unknownGPUVendor
	}
}
