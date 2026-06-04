// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package hal

import (
	"strings"
	"testing"
)

func TestFamily_Valid(t *testing.T) {
	tests := []struct {
		name   string
		family Family
		want   bool
	}{
		{"ASIC is valid", FamilyASIC, true},
		{"GPU is valid", FamilyGPU, true},
		{"CPU is valid", FamilyCPU, true},
		{"empty string is invalid", Family(""), false},
		{"unknown family is invalid", Family("quantum"), false},
		{"case-sensitive: 'ASIC' is invalid", Family("ASIC"), false},
		{"whitespace is invalid", Family(" cpu"), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := tt.family.Valid(); got != tt.want {
				t.Errorf("Family(%q).Valid() = %v, want %v", tt.family, got, tt.want)
			}
		})
	}
}

func TestIdentity_String_ContainsFamilyAndID(t *testing.T) {
	id := Identity{
		ID:     "bus-0000:01:00.0",
		Family: FamilyGPU,
		Vendor: "NVIDIA",
		Model:  "GeForce RTX 4090",
	}

	got := id.String()

	for _, want := range []string{string(FamilyGPU), "bus-0000:01:00.0", "GeForce RTX 4090"} {
		if !strings.Contains(got, want) {
			t.Errorf("String() = %q, missing %q", got, want)
		}
	}
}

func TestIdentity_String_HandlesEmptyModel(t *testing.T) {
	// An Identity with an empty Model should still produce a non-empty,
	// human-readable string. This guards against nil-like formatting bugs
	// in logs.
	id := Identity{
		ID:     "cpu-0",
		Family: FamilyCPU,
	}

	got := id.String()

	if got == "" {
		t.Fatal("String() returned empty for identity with empty Model")
	}
	if !strings.Contains(got, "cpu-0") {
		t.Errorf("String() = %q, missing ID", got)
	}
	// "unknown" is the documented fallback for an empty Model.
	if !strings.Contains(got, "unknown") {
		t.Errorf("String() = %q, expected 'unknown' fallback for empty Model", got)
	}
}

func TestIdentity_Validate(t *testing.T) {
	tests := []struct {
		name    string
		id      Identity
		wantErr bool
	}{
		{
			name:    "valid ASIC identity",
			id:      Identity{ID: "asic-192.168.1.10", Family: FamilyASIC, Model: "Antminer S21"},
			wantErr: false,
		},
		{
			name:    "valid GPU identity",
			id:      Identity{ID: "gpu-0", Family: FamilyGPU, Model: "RTX 4090"},
			wantErr: false,
		},
		{
			name:    "valid minimal identity",
			id:      Identity{ID: "cpu-0", Family: FamilyCPU},
			wantErr: false,
		},
		{
			name:    "empty ID rejected",
			id:      Identity{ID: "", Family: FamilyGPU},
			wantErr: true,
		},
		{
			name:    "invalid family rejected",
			id:      Identity{ID: "x", Family: Family("unknown")},
			wantErr: true,
		},
		{
			name:    "ID with space rejected",
			id:      Identity{ID: "gpu 0", Family: FamilyGPU},
			wantErr: true,
		},
		{
			name:    "ID with tab rejected",
			id:      Identity{ID: "gpu\t0", Family: FamilyGPU},
			wantErr: true,
		},
		{
			name:    "ID with newline rejected",
			id:      Identity{ID: "gpu\n0", Family: FamilyGPU},
			wantErr: true,
		},
		{
			name:    "ID with slash rejected",
			id:      Identity{ID: "path/to/gpu", Family: FamilyGPU},
			wantErr: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			err := tt.id.Validate()
			if (err != nil) != tt.wantErr {
				t.Errorf("Validate() error = %v, wantErr %v", err, tt.wantErr)
			}
			// When validation fails, the error message must reference
			// the Identity to aid debugging.
			if err != nil && !strings.Contains(err.Error(), "hal:") {
				t.Errorf("error %q should start with package prefix 'hal:'", err)
			}
		})
	}
}

func TestCapabilities_ZeroValueIsNoCapabilities(t *testing.T) {
	// A zero-value Capabilities struct must represent "no capabilities".
	// This matters because uninitialized structs appearing in test mocks
	// or default configurations should not accidentally claim capabilities.
	var c Capabilities

	if c.SHA256d {
		t.Error("zero-value Capabilities.SHA256d must be false")
	}
	if c.GeneralCompute {
		t.Error("zero-value Capabilities.GeneralCompute must be false")
	}
}
