// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

//go:build !linux

// Package hal — gpu_stub.go
//
// GPU driver stub for non-Linux platforms. On macOS and Windows, GPU
// enumeration requires platform-specific APIs (IOKit, DXGI) that are
// outside the scope of v3.0.0-alpha. This stub satisfies the build
// without breaking cross-platform compilation.
package hal

// RegisterGPULinux is a no-op on non-Linux platforms.
// GPU support for macOS (Metal) and Windows (DirectX/Vulkan) is tracked
// in the v3.5.0 roadmap milestone.
func RegisterGPULinux(r *Registry) error {
	return nil
}
