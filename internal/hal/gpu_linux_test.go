// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

//go:build linux

package hal

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ============================================================================
// inferVendorName — PCI vendor ID → human name mapping
// ============================================================================

func TestInferVendorName_KnownVendors(t *testing.T) {
	tests := map[string]string{
		"0x10de": "NVIDIA",
		"0x1002": "AMD",
		"0x8086": "Intel",
	}
	for id, want := range tests {
		if got := inferVendorName(id); got != want {
			t.Errorf("inferVendorName(%q) = %q, want %q", id, got, want)
		}
	}
}

func TestInferVendorName_UnknownReturnsFallback(t *testing.T) {
	got := inferVendorName("0xdead")
	if got == "" {
		t.Error("unknown vendor returned empty string")
	}
	// The fallback should be descriptive, not the raw ID.
	if got == "0xdead" {
		t.Error("unknown vendor should map to a human-readable fallback, not the raw ID")
	}
}

func TestInferVendorName_HandlesWhitespace(t *testing.T) {
	// sysfs values often have trailing newlines. inferVendorName should
	// either strip or not affect the mapping.
	got := inferVendorName("0x10de\n")
	if got != "NVIDIA" {
		t.Errorf("inferVendorName with trailing newline = %q, want NVIDIA", got)
	}
}

func TestInferVendorName_EmptyInput(t *testing.T) {
	got := inferVendorName("")
	if got == "" {
		t.Error("empty input produced empty vendor name")
	}
}

// ============================================================================
// readSysFile — missing files and unreadable paths
// ============================================================================

func TestReadSysFile_NonexistentPathReturnsEmpty(t *testing.T) {
	got := readSysFile("/nonexistent/path/that/should/not/exist/123")
	if got != "" {
		t.Errorf("readSysFile on missing path = %q, want empty", got)
	}
}

func TestReadSysFile_TrimsTrailingNewlines(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "content-with-newline")
	if err := os.WriteFile(path, []byte("0x10de\n\n"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	got := readSysFile(path)
	if got != "0x10de" {
		t.Errorf("readSysFile = %q, want %q (trimmed)", got, "0x10de")
	}
}

func TestReadSysFile_PreservesInternalNewlines(t *testing.T) {
	// uevent files have multiple newlines internally that the caller
	// parses. readSysFile should only trim the outer edges.
	dir := t.TempDir()
	path := filepath.Join(dir, "uevent")
	content := "DRIVER=amdgpu\nPCI_ID=1002:731F\nMODALIAS=pci:v00001002d0000731F\n"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	got := readSysFile(path)
	if !strings.Contains(got, "DRIVER=amdgpu") {
		t.Errorf("readSysFile lost content: %q", got)
	}
	if !strings.Contains(got, "PCI_ID=1002:731F") {
		t.Errorf("readSysFile lost internal newlines: %q", got)
	}
}

// ============================================================================
// parseGPUDevice — identity extraction
// ============================================================================

func TestParseGPUDevice_WithValidSysfs(t *testing.T) {
	// Simulate a sysfs device tree.
	root := t.TempDir()
	devicePath := filepath.Join(root, "device")
	if err := os.MkdirAll(devicePath, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(devicePath, "vendor"), []byte("0x10de\n"), 0644); err != nil {
		t.Fatalf("write vendor: %v", err)
	}
	if err := os.WriteFile(filepath.Join(devicePath, "uevent"),
		[]byte("PCI_ID=10DE:2684\n"), 0644); err != nil {
		t.Fatalf("write uevent: %v", err)
	}

	dev := parseGPUDevice("renderD128", devicePath)
	if dev == nil {
		t.Fatal("parseGPUDevice returned nil for valid input")
	}

	id := dev.Identity()
	if id.Family != FamilyGPU {
		t.Errorf("Family = %v, want GPU", id.Family)
	}
	if id.Vendor != "NVIDIA" {
		t.Errorf("Vendor = %q, want NVIDIA", id.Vendor)
	}
	if !strings.Contains(id.Model, "NVIDIA") {
		t.Errorf("Model %q should contain 'NVIDIA'", id.Model)
	}
	// ID uses render node name.
	if id.ID != "gpu-renderD128" {
		t.Errorf("ID = %q, want gpu-renderD128", id.ID)
	}
}

func TestParseGPUDevice_MissingVendorFile(t *testing.T) {
	// If the vendor file is missing, readSysFile returns empty string,
	// inferVendorName returns a fallback, and we still produce a device
	// (just with unknown vendor).
	root := t.TempDir()
	devicePath := filepath.Join(root, "device")
	_ = os.MkdirAll(devicePath, 0755)

	dev := parseGPUDevice("renderD129", devicePath)
	// Even without vendor info, the device should be created.
	if dev == nil {
		t.Fatal("parseGPUDevice returned nil when vendor missing")
	}
	id := dev.Identity()
	if id.Family != FamilyGPU {
		t.Errorf("Family = %v, want GPU", id.Family)
	}
}

// ============================================================================
// GPULinuxDriver.Name
// ============================================================================

func TestGPULinuxDriver_Name(t *testing.T) {
	d := &GPULinuxDriver{}
	if name := d.Name(); name != "gpu_linux" {
		t.Errorf("Name() = %q, want gpu_linux", name)
	}
}

// ============================================================================
// GPULinuxDriver.Enumerate — environment tolerance
// ============================================================================

func TestGPULinuxDriver_Enumerate_ReturnsWithoutError(t *testing.T) {
	// Whether or not /sys/class/drm exists on the test host, Enumerate
	// must never return an error — absence of GPUs is not a failure.
	d := &GPULinuxDriver{}
	devs, err := d.Enumerate(context.Background())
	if err != nil {
		t.Errorf("Enumerate returned error (should tolerate missing sysfs): %v", err)
	}
	// Every returned device should be a GPU with valid identity.
	for _, dev := range devs {
		id := dev.Identity()
		if id.Family != FamilyGPU {
			t.Errorf("non-GPU in Enumerate result: %v", id)
		}
		if id.ID == "" {
			t.Errorf("device with empty ID: %+v", id)
		}
	}
}

func TestGPULinuxDriver_Enumerate_HandlesCanceledContext(t *testing.T) {
	// Canceled context should not cause panic (current impl doesn't
	// check ctx, but this test documents expected behavior).
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	d := &GPULinuxDriver{}
	_, err := d.Enumerate(ctx)
	if err != nil {
		t.Errorf("canceled context unexpected error: %v", err)
	}
}

// ============================================================================
// linuxGPUDevice — Device interface implementation
// ============================================================================

func TestLinuxGPUDevice_ImplementsDevice(t *testing.T) {
	dev := &linuxGPUDevice{
		id: Identity{
			ID:     "gpu-renderD128",
			Family: FamilyGPU,
			Vendor: "NVIDIA",
			Model:  "test",
		},
		caps: Capabilities{SHA256d: true, GeneralCompute: true},
	}

	// Identity.
	if dev.Identity().Family != FamilyGPU {
		t.Error("Identity family mismatch")
	}
	// Capabilities.
	if !dev.Capabilities().SHA256d {
		t.Error("Capabilities lost SHA256d")
	}
	if !dev.Capabilities().GeneralCompute {
		t.Error("Capabilities lost GeneralCompute")
	}
	// Shutdown is a no-op and must not error.
	if err := dev.Shutdown(context.Background()); err != nil {
		t.Errorf("Shutdown returned: %v", err)
	}
}

// ============================================================================
// RegisterGPULinux — registry integration
// ============================================================================

func TestRegisterGPULinux_AddsDriver(t *testing.T) {
	r := NewRegistry()
	if err := RegisterGPULinux(r); err != nil {
		t.Fatalf("RegisterGPULinux: %v", err)
	}
	if _, ok := r.Lookup("gpu_linux"); !ok {
		t.Error("GPU Linux driver not registered")
	}
}

func TestRegisterGPULinux_RejectsDoubleRegistration(t *testing.T) {
	r := NewRegistry()
	if err := RegisterGPULinux(r); err != nil {
		t.Fatalf("first: %v", err)
	}
	if err := RegisterGPULinux(r); err == nil {
		t.Error("second RegisterGPULinux should fail (duplicate)")
	}
}

// ============================================================================
// inferModel — PCI_ID parsing
// ============================================================================

func TestInferModel_WithPCIID(t *testing.T) {
	dir := t.TempDir()
	uevent := filepath.Join(dir, "uevent")
	if err := os.WriteFile(uevent, []byte("DRIVER=nvidia\nPCI_ID=10DE:2684\n"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	got := inferModel(dir, "0x10de")
	if !strings.Contains(got, "NVIDIA") {
		t.Errorf("inferModel = %q, should contain 'NVIDIA'", got)
	}
}

func TestInferModel_WithoutPCIID(t *testing.T) {
	// If uevent is missing or has no PCI_ID, fall back to vendor-only.
	dir := t.TempDir()
	got := inferModel(dir, "0x10de")
	if !strings.Contains(got, "NVIDIA") {
		t.Errorf("inferModel = %q, should contain 'NVIDIA' as fallback", got)
	}
	if got == "" {
		t.Error("inferModel returned empty string")
	}
}

// ============================================================================
// isBech32Char semantics — ensure Bech32 is strictly lowercase
// ============================================================================

func TestParseGPUDevice_UsesCorrectRenderNodeInID(t *testing.T) {
	// Different render nodes produce different IDs (deduplication key).
	root := t.TempDir()
	devicePath := filepath.Join(root, "device")
	_ = os.MkdirAll(devicePath, 0755)
	_ = os.WriteFile(filepath.Join(devicePath, "vendor"), []byte("0x10de"), 0644)

	d1 := parseGPUDevice("renderD128", devicePath)
	d2 := parseGPUDevice("renderD129", devicePath)

	if d1 == nil || d2 == nil {
		t.Fatal("parseGPUDevice returned nil")
	}
	if d1.Identity().ID == d2.Identity().ID {
		t.Errorf("different render nodes produced same ID: %s", d1.Identity().ID)
	}
}
