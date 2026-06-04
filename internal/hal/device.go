// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package hal provides the Hardware Abstraction Layer for Otedama.
//
// HAL unifies the interface to mining devices across ASIC, GPU, and CPU
// families. Upper layers (provider connectors, arbitration engine) depend
// only on the Device interface and never on concrete device types. This
// separation allows the arbitration engine to be tested without real
// hardware and allows new device families to be added without changes to
// upper layers.
//
// # Design
//
// Device is an interface, not a concrete type. Production drivers
// (internal/hal/asic, internal/hal/cuda, internal/hal/rocm, internal/hal/cpu)
// implement Device. Tests use mock implementations without touching physical
// hardware.
//
// Detectors discover available devices at runtime. The default detector
// iterates over registered drivers and asks each to enumerate its devices.
// This avoids requiring users to manually configure device lists, which is
// one of the primary pain points of CGMiner and similar tools.
package hal

import (
	"context"
	"errors"
	"fmt"
)

// Family identifies the high-level category of a mining device.
//
// Family is used for coarse-grained classification. Fine-grained information
// (model, vendor, chip count) is available via the Capabilities method.
type Family string

const (
	// FamilyASIC denotes application-specific integrated circuits dedicated
	// to a single hashing algorithm (typically SHA-256d for Bitcoin).
	FamilyASIC Family = "asic"

	// FamilyGPU denotes graphics processing units usable for mining,
	// rendering, and AI inference.
	FamilyGPU Family = "gpu"

	// FamilyCPU denotes general-purpose central processing units.
	FamilyCPU Family = "cpu"
)

// Valid reports whether f is one of the defined Family values.
//
// Unknown Family values must be rejected by detectors and drivers to
// prevent silent misclassification.
func (f Family) Valid() bool {
	switch f {
	case FamilyASIC, FamilyGPU, FamilyCPU:
		return true
	default:
		return false
	}
}

// Identity uniquely identifies a device within a running Otedama instance.
//
// The ID is stable across process restarts when possible (for example, a
// GPU's PCI bus location), but must not be assumed to be stable across
// hardware reconfigurations. Consumers that need persistent identity
// across hardware changes must maintain their own mapping.
type Identity struct {
	// ID is a string that uniquely identifies this device within the
	// current Otedama process. The format is driver-specific but must not
	// contain whitespace or the '/' character.
	ID string

	// Family is the high-level category of this device. It must be a
	// valid Family value (see Family.Valid).
	Family Family

	// Vendor is the human-readable vendor name, for example "Bitmain",
	// "NVIDIA", "AMD", "Intel". It may be empty if unknown.
	Vendor string

	// Model is the human-readable model name, for example "Antminer S21 Pro",
	// "GeForce RTX 4090", "Ryzen 9 7950X". It may be empty if unknown.
	Model string
}

// String returns a short human-readable representation of the identity,
// suitable for logging. The format is not stable and should not be parsed.
func (i Identity) String() string {
	model := i.Model
	if model == "" {
		model = "unknown"
	}
	return fmt.Sprintf("%s[%s: %s]", i.Family, i.ID, model)
}

// Validate reports whether this Identity is well-formed.
//
// A valid Identity has a non-empty ID, a valid Family, and an ID that does
// not contain whitespace or '/' characters. Validate is called by the
// default detector to reject malformed driver output before it reaches
// upper layers.
func (i Identity) Validate() error {
	if i.ID == "" {
		return errors.New("hal: Identity.ID must not be empty")
	}
	if !i.Family.Valid() {
		return fmt.Errorf("hal: Identity.Family %q is not a valid Family", i.Family)
	}
	for _, r := range i.ID {
		if r == ' ' || r == '\t' || r == '\n' || r == '/' {
			return fmt.Errorf("hal: Identity.ID contains forbidden character %q", r)
		}
	}
	return nil
}

// Capabilities describes what workloads a device can execute.
//
// Capabilities is a capability bitmap in struct form. A device advertising
// a capability must accept work of that kind through SubmitWork. Devices
// that cannot run a particular workload must leave the corresponding field
// false; upper layers filter devices by capability when dispatching work.
type Capabilities struct {
	// SHA256d indicates support for Bitcoin's SHA-256d proof-of-work.
	SHA256d bool

	// GeneralCompute indicates support for arbitrary compute workloads
	// (AI inference, rendering, scientific computing). ASIC devices
	// typically do not have this capability; GPUs and CPUs do.
	GeneralCompute bool
}

// Device is the unified interface implemented by all mining hardware.
//
// Implementations must be safe for concurrent use. In particular,
// SubmitWork may be called from multiple goroutines, and Metrics and
// Identity may be read while work is in progress.
type Device interface {
	// Identity returns the identity of this device. The returned value
	// is stable for the lifetime of the Device.
	Identity() Identity

	// Capabilities returns the capabilities of this device. The returned
	// value is stable for the lifetime of the Device.
	Capabilities() Capabilities

	// Shutdown releases resources associated with this device.
	//
	// After Shutdown returns, further calls to SubmitWork on this device
	// must return an error. Shutdown should be idempotent: calling it
	// multiple times must not panic or corrupt state.
	Shutdown(ctx context.Context) error
}

// Driver enumerates Devices of a particular Family.
//
// A Driver represents the software responsible for interacting with one
// family of hardware. For example, the CUDA driver enumerates NVIDIA GPUs,
// the ROCm driver enumerates AMD GPUs, and the asic driver enumerates
// connected ASICs via their network interfaces.
//
// Drivers are registered with a Registry and invoked by the default
// Detector. User code typically does not call Driver.Enumerate directly.
type Driver interface {
	// Name returns the unique name of this driver, e.g. "cuda", "rocm",
	// "asic", "cpu". The name is used for logging and must be stable
	// across versions.
	Name() string

	// Enumerate returns the devices currently visible to this driver.
	//
	// Enumerate is expected to be fast (under one second on typical
	// hardware). Long-running discovery (such as network scans for ASICs)
	// should be bounded by ctx. On timeout, Enumerate must return the
	// devices found so far along with ctx.Err().
	//
	// Enumerate may return an empty slice with a nil error if no devices
	// of this driver's family are present.
	Enumerate(ctx context.Context) ([]Device, error)
}

// Detector discovers devices across all registered drivers.
//
// The default Detector (returned by NewDetector) aggregates all drivers
// from a Registry and invokes them in parallel. Upper layers typically
// depend only on Detector, not on individual drivers.
type Detector interface {
	// Detect returns all currently available devices across all drivers.
	//
	// Detect invokes each driver's Enumerate method. If a driver returns
	// an error, Detect logs it and continues with the remaining drivers.
	// This partial-success behavior ensures that, for example, a missing
	// CUDA library does not prevent CPU detection from succeeding.
	//
	// If ctx is canceled during detection, Detect returns the devices
	// found so far along with ctx.Err().
	Detect(ctx context.Context) ([]Device, error)
}
