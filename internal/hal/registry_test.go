// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package hal

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

// ----- Test helpers: mock implementations of Device and Driver. -----

type mockDevice struct {
	identity     Identity
	capabilities Capabilities
	shutdownErr  error
	shutdownOnce sync.Once
	shutdownN    int
}

func (m *mockDevice) Identity() Identity         { return m.identity }
func (m *mockDevice) Capabilities() Capabilities { return m.capabilities }
func (m *mockDevice) Shutdown(_ context.Context) error {
	m.shutdownOnce.Do(func() { m.shutdownN++ })
	return m.shutdownErr
}

type mockDriver struct {
	name    string
	devices []Device
	err     error
	delay   time.Duration
}

func (m *mockDriver) Name() string { return m.name }
func (m *mockDriver) Enumerate(ctx context.Context) ([]Device, error) {
	if m.delay > 0 {
		select {
		case <-time.After(m.delay):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return m.devices, m.err
}

func newMockDevice(id string, family Family) *mockDevice {
	return &mockDevice{
		identity: Identity{ID: id, Family: family},
	}
}

// ----- Registry tests -----

func TestRegistry_NewIsEmpty(t *testing.T) {
	r := NewRegistry()
	if got := r.Len(); got != 0 {
		t.Errorf("new Registry has %d drivers, want 0", got)
	}
	if got := r.Drivers(); len(got) != 0 {
		t.Errorf("new Registry.Drivers() = %v, want empty", got)
	}
}

func TestRegistry_RegisterAndLookup(t *testing.T) {
	r := NewRegistry()
	d := &mockDriver{name: "cuda"}

	if err := r.Register(d); err != nil {
		t.Fatalf("Register failed: %v", err)
	}

	got, ok := r.Lookup("cuda")
	if !ok {
		t.Fatal("Lookup returned false for registered driver")
	}
	if got != d {
		t.Errorf("Lookup returned different driver instance")
	}
}

func TestRegistry_RegisterRejectsNil(t *testing.T) {
	r := NewRegistry()
	if err := r.Register(nil); err == nil {
		t.Error("Register(nil) must return error")
	}
}

func TestRegistry_RegisterRejectsEmptyName(t *testing.T) {
	r := NewRegistry()
	d := &mockDriver{name: ""}
	if err := r.Register(d); err == nil {
		t.Error("Register with empty name must return error")
	}
}

func TestRegistry_RegisterRejectsDuplicate(t *testing.T) {
	// Duplicate registration signals a configuration bug (for example,
	// two init functions registering the same driver). Silently replacing
	// would hide the bug. Registry returns an error instead.
	r := NewRegistry()
	d1 := &mockDriver{name: "cuda"}
	d2 := &mockDriver{name: "cuda"}

	if err := r.Register(d1); err != nil {
		t.Fatalf("first Register failed: %v", err)
	}
	if err := r.Register(d2); err == nil {
		t.Error("second Register with same name must return error")
	}

	// The first-registered driver must still be accessible.
	got, _ := r.Lookup("cuda")
	if got != d1 {
		t.Error("after duplicate registration attempt, original driver must remain")
	}
}

func TestRegistry_LookupUnknownReturnsNotOK(t *testing.T) {
	r := NewRegistry()
	got, ok := r.Lookup("nonexistent")
	if ok {
		t.Error("Lookup of unregistered name returned ok=true")
	}
	if got != nil {
		t.Error("Lookup of unregistered name returned non-nil driver")
	}
}

func TestRegistry_DriversReturnsSortedByName(t *testing.T) {
	r := NewRegistry()
	// Register in non-alphabetical order to verify sorting.
	names := []string{"rocm", "asic", "cuda", "cpu"}
	for _, n := range names {
		if err := r.Register(&mockDriver{name: n}); err != nil {
			t.Fatalf("Register(%q) failed: %v", n, err)
		}
	}

	drivers := r.Drivers()
	want := []string{"asic", "cpu", "cuda", "rocm"}
	if len(drivers) != len(want) {
		t.Fatalf("got %d drivers, want %d", len(drivers), len(want))
	}
	for i, d := range drivers {
		if d.Name() != want[i] {
			t.Errorf("drivers[%d].Name() = %q, want %q", i, d.Name(), want[i])
		}
	}
}

func TestRegistry_DriversReturnsSnapshot(t *testing.T) {
	// The returned slice must be a new allocation so that callers modifying
	// it do not affect subsequent reads.
	r := NewRegistry()
	_ = r.Register(&mockDriver{name: "cuda"})

	first := r.Drivers()
	first[0] = &mockDriver{name: "modified"}

	second := r.Drivers()
	if second[0].Name() != "cuda" {
		t.Error("modifying slice returned by Drivers() affected registry state")
	}
}

func TestRegistry_ConcurrentRegistration(t *testing.T) {
	// Run under the race detector to verify thread safety.
	r := NewRegistry()

	const numDrivers = 100
	var wg sync.WaitGroup
	errs := make([]error, numDrivers)

	for i := 0; i < numDrivers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errs[i] = r.Register(&mockDriver{name: fmt.Sprintf("driver-%d", i)})
		}(i)
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Errorf("concurrent Register(%d) failed: %v", i, err)
		}
	}
	if got := r.Len(); got != numDrivers {
		t.Errorf("after concurrent registration: Len() = %d, want %d", got, numDrivers)
	}
}

// ----- Detector tests -----

func TestDetector_EmptyRegistryReturnsEmpty(t *testing.T) {
	r := NewRegistry()
	d := NewDetector(r, nil)

	devices, err := d.Detect(context.Background())
	if err != nil {
		t.Errorf("Detect on empty registry returned error: %v", err)
	}
	if len(devices) != 0 {
		t.Errorf("Detect on empty registry returned %d devices, want 0", len(devices))
	}
}

func TestDetector_AggregatesFromMultipleDrivers(t *testing.T) {
	r := NewRegistry()

	_ = r.Register(&mockDriver{
		name:    "asic",
		devices: []Device{newMockDevice("asic-1", FamilyASIC), newMockDevice("asic-2", FamilyASIC)},
	})
	_ = r.Register(&mockDriver{
		name:    "cuda",
		devices: []Device{newMockDevice("gpu-0", FamilyGPU)},
	})
	_ = r.Register(&mockDriver{
		name:    "cpu",
		devices: []Device{newMockDevice("cpu-0", FamilyCPU)},
	})

	d := NewDetector(r, nil)
	devices, err := d.Detect(context.Background())
	if err != nil {
		t.Fatalf("Detect returned error: %v", err)
	}
	if got := len(devices); got != 4 {
		t.Errorf("Detect returned %d devices, want 4", got)
	}
}

func TestDetector_PartialFailureIsTolerated(t *testing.T) {
	// A failing driver must not prevent other drivers from succeeding.
	// This is critical for real-world deployments where, for example,
	// a missing CUDA library should not block CPU detection.
	r := NewRegistry()

	_ = r.Register(&mockDriver{
		name: "cuda",
		err:  errors.New("cuda library not found"),
	})
	_ = r.Register(&mockDriver{
		name:    "cpu",
		devices: []Device{newMockDevice("cpu-0", FamilyCPU)},
	})

	var loggedDriver string
	var loggedErr error
	logger := func(driver, _ string, err error) {
		loggedDriver = driver
		loggedErr = err
	}

	d := NewDetector(r, logger)
	devices, err := d.Detect(context.Background())
	if err != nil {
		t.Errorf("Detect returned error despite partial success: %v", err)
	}
	if len(devices) != 1 {
		t.Errorf("Detect returned %d devices, want 1 (cpu)", len(devices))
	}
	if loggedDriver != "cuda" {
		t.Errorf("logger received driver %q, want 'cuda'", loggedDriver)
	}
	if loggedErr == nil {
		t.Error("logger did not receive error from failing driver")
	}
}

func TestDetector_RejectsInvalidIdentities(t *testing.T) {
	// Devices with invalid identities must be filtered out, not propagated.
	// This prevents buggy drivers from contaminating upper layers.
	r := NewRegistry()

	_ = r.Register(&mockDriver{
		name: "buggy",
		devices: []Device{
			&mockDevice{identity: Identity{ID: "valid-1", Family: FamilyGPU}},
			&mockDevice{identity: Identity{ID: "", Family: FamilyGPU}},          // invalid: empty ID
			&mockDevice{identity: Identity{ID: "bad space", Family: FamilyGPU}}, // invalid: whitespace
			&mockDevice{identity: Identity{ID: "valid-2", Family: FamilyGPU}},
		},
	})

	d := NewDetector(r, nil)
	devices, err := d.Detect(context.Background())
	if err != nil {
		t.Fatalf("Detect returned error: %v", err)
	}
	if got := len(devices); got != 2 {
		t.Errorf("Detect returned %d devices, want 2 (invalid ones filtered)", got)
	}
}

func TestDetector_CanceledContextReturnsPartialResults(t *testing.T) {
	r := NewRegistry()

	_ = r.Register(&mockDriver{
		name:    "fast",
		devices: []Device{newMockDevice("fast-0", FamilyCPU)},
	})
	_ = r.Register(&mockDriver{
		name:    "slow",
		devices: []Device{newMockDevice("slow-0", FamilyGPU)},
		delay:   100 * time.Millisecond,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()

	d := NewDetector(r, nil)
	devices, err := d.Detect(ctx)

	// The context should have deadline-exceeded or been canceled.
	if err == nil {
		t.Error("expected context error, got nil")
	}
	// Fast driver should have returned its device; slow driver should not.
	// We tolerate the slow driver being partially complete (returning 0 or 1 devices).
	if len(devices) < 1 {
		t.Errorf("got %d devices, want at least 1 (fast driver should have completed)", len(devices))
	}
}

func TestDetector_NilLoggerDoesNotPanic(t *testing.T) {
	// Passing nil logger is documented as valid. A failing driver must
	// not cause a panic when logger is nil.
	r := NewRegistry()
	_ = r.Register(&mockDriver{name: "failing", err: errors.New("boom")})

	d := NewDetector(r, nil)
	_, _ = d.Detect(context.Background())
	// If we reach this line without panic, the test passes.
}

func TestDetector_NilRegistryUsesEmpty(t *testing.T) {
	// NewDetector is documented to accept nil Registry and treat it as empty.
	// This simplifies callers that want a no-op detector for tests.
	d := NewDetector(nil, nil)
	devices, err := d.Detect(context.Background())
	if err != nil {
		t.Errorf("Detect on nil-registry detector returned error: %v", err)
	}
	if len(devices) != 0 {
		t.Errorf("Detect on nil-registry detector returned %d devices, want 0", len(devices))
	}
}
