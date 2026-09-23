// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

//go:build !linux && !darwin && !windows

// Package hal — gpu_stub.go
//
// GPU driver stub for platforms without a concrete GPU driver
// (e.g. FreeBSD). This stub satisfies the build without breaking
// cross-platform compilation.
package hal

// RegisterGPU is a no-op on platforms without a GPU driver.
func RegisterGPU(r *Registry) error {
	return nil
}
