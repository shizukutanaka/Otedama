// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

//go:build !linux && !darwin

// Package hal — gpu_stub.go
//
// GPU driver stub for platforms without a concrete GPU driver.
// Windows GPU enumeration requires DXGI/WMI APIs outside the scope of
// v3.0.0-alpha (tracked by docs/KNOWN_LIMITATIONS.md §4). This stub
// satisfies the build without breaking cross-platform compilation.
package hal

// RegisterGPU is a no-op on platforms without a GPU driver.
func RegisterGPU(r *Registry) error {
	return nil
}
