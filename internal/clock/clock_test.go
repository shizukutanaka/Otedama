// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package clock

import (
	"sync"
	"testing"
	"time"
)

func TestSystem_Now_ReturnsCurrentTime(t *testing.T) {
	var c System

	before := time.Now()
	got := c.Now()
	after := time.Now()

	// System.Now must fall within the window between before and after.
	// We allow equality on both bounds because time.Now has limited
	// resolution on some platforms.
	if got.Before(before) || got.After(after) {
		t.Errorf("System.Now() = %v, want in [%v, %v]", got, before, after)
	}
}

func TestSystem_ZeroValueIsUsable(t *testing.T) {
	// System is documented as having a usable zero value. This test
	// enforces that contract: constructing via `var c System` or
	// `clock.System{}` must both work without panics.
	var c1 System
	c2 := System{}

	// If either of these panics, the test fails.
	_ = c1.Now()
	_ = c2.Now()
}

func TestFake_Now_ReturnsInitialTime(t *testing.T) {
	initial := time.Date(2026, 4, 18, 12, 0, 0, 0, time.UTC)
	c := NewFake(initial)

	if got := c.Now(); !got.Equal(initial) {
		t.Errorf("Now() = %v, want %v", got, initial)
	}
}

func TestFake_Now_DoesNotAdvanceByItself(t *testing.T) {
	initial := time.Date(2026, 4, 18, 12, 0, 0, 0, time.UTC)
	c := NewFake(initial)

	first := c.Now()
	// Any real-world elapsed time must not affect the fake clock.
	time.Sleep(10 * time.Millisecond)
	second := c.Now()

	if !first.Equal(second) {
		t.Errorf("Fake clock advanced on its own: first=%v second=%v", first, second)
	}
}

func TestFake_Advance_MovesTimeForward(t *testing.T) {
	initial := time.Date(2026, 4, 18, 12, 0, 0, 0, time.UTC)
	c := NewFake(initial)

	c.Advance(5 * time.Second)

	want := initial.Add(5 * time.Second)
	if got := c.Now(); !got.Equal(want) {
		t.Errorf("after Advance(5s): Now() = %v, want %v", got, want)
	}
}

func TestFake_Advance_SupportsNegativeDuration(t *testing.T) {
	// Per package documentation, Advance with a negative duration moves
	// time backward. This is useful for testing code that handles clock
	// skew.
	initial := time.Date(2026, 4, 18, 12, 0, 0, 0, time.UTC)
	c := NewFake(initial)

	c.Advance(-5 * time.Second)

	want := initial.Add(-5 * time.Second)
	if got := c.Now(); !got.Equal(want) {
		t.Errorf("after Advance(-5s): Now() = %v, want %v", got, want)
	}
}

func TestFake_Set_ReplacesTimeEntirely(t *testing.T) {
	initial := time.Date(2026, 4, 18, 12, 0, 0, 0, time.UTC)
	c := NewFake(initial)

	newTime := time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)
	c.Set(newTime)

	if got := c.Now(); !got.Equal(newTime) {
		t.Errorf("after Set: Now() = %v, want %v", got, newTime)
	}
}

func TestFake_ConcurrentReadsAreConsistent(t *testing.T) {
	// Verify that concurrent readers always see one of the writer's discrete
	// time values, never a partial or corrupted time.Time. This ensures the
	// RWMutex guards the entire time.Time value, not just part of it.
	initial := time.Date(2026, 4, 18, 12, 0, 0, 0, time.UTC)
	c := NewFake(initial)

	times := []time.Time{
		initial,
		initial.Add(1 * time.Second),
		initial.Add(2 * time.Second),
		initial.Add(3 * time.Second),
	}
	validSet := make(map[string]bool)
	for _, tm := range times {
		validSet[tm.String()] = true
	}

	const readers = 50
	const readsPerReader = 500

	var wg sync.WaitGroup
	invalidCh := make(chan string, readers)

	// Reader goroutines: collect time values and verify each is in the valid set
	for i := 0; i < readers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < readsPerReader; j++ {
				got := c.Now()
				if !validSet[got.String()] {
					invalidCh <- got.String()
					return
				}
			}
		}()
	}

	// Writer goroutine: advance through the discrete time values
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 1; i < len(times); i++ {
			c.Set(times[i])
			// Give readers a chance to sample this value
			time.Sleep(time.Microsecond)
		}
	}()

	wg.Wait()
	close(invalidCh)

	if len(invalidCh) > 0 {
		for invalid := range invalidCh {
			t.Logf("invalid time observed: %s", invalid)
		}
		t.Errorf("concurrent reader saw a time not in the writer's set")
	}
}

func TestFake_ConcurrentReadAndAdvance(t *testing.T) {
	// This test primarily exercises the race detector. Run it with
	// `go test -race` to verify thread safety.
	initial := time.Date(2026, 4, 18, 12, 0, 0, 0, time.UTC)
	c := NewFake(initial)

	var wg sync.WaitGroup
	done := make(chan struct{})

	// Reader goroutines
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-done:
					return
				default:
					_ = c.Now()
				}
			}
		}()
	}

	// Writer goroutine
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 100; i++ {
			c.Advance(time.Millisecond)
		}
		close(done)
	}()

	wg.Wait()
	// If the race detector is enabled and reports no data races, the test
	// passes. Explicit assertions are unnecessary.
}

func TestFake_Set_IsIdempotent(t *testing.T) {
	// Setting the same time multiple times should be a no-op.
	initial := time.Date(2026, 4, 18, 12, 0, 0, 0, time.UTC)
	c := NewFake(initial)

	// Set multiple times to the same value
	c.Set(initial)
	c.Set(initial)
	c.Set(initial)

	if got := c.Now(); !got.Equal(initial) {
		t.Errorf("after multiple Set calls with same value: Now() = %v, want %v", got, initial)
	}
}

func TestFake_Advance_ZeroIsNoop(t *testing.T) {
	// Advancing by zero duration should not change the time.
	initial := time.Date(2026, 4, 18, 12, 0, 0, 0, time.UTC)
	c := NewFake(initial)

	c.Advance(0)

	if got := c.Now(); !got.Equal(initial) {
		t.Errorf("after Advance(0): Now() = %v, want %v", got, initial)
	}
}

func TestFake_Advance_LargePositiveDuration(t *testing.T) {
	// Advancing by a large duration should work without panic or overflow.
	// time.Duration can represent up to ~290 years.
	initial := time.Date(2026, 4, 18, 12, 0, 0, 0, time.UTC)
	c := NewFake(initial)

	largeAdvance := 100 * 365 * 24 * time.Hour // ~100 years

	c.Advance(largeAdvance)

	want := initial.Add(largeAdvance)
	if got := c.Now(); !got.Equal(want) {
		t.Errorf("after Advance(100 years): Now() = %v, want %v", got, want)
	}
}

func TestFake_InterfaceCompliance(t *testing.T) {
	// Ensure both System and Fake satisfy the Clock interface. This is a
	// compile-time check, but making it a test documents the contract.
	var _ Clock = System{}
	var _ Clock = NewFake(time.Now())
}

func BenchmarkSystem_Now(b *testing.B) {
	var c System
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = c.Now()
	}
}

func BenchmarkFake_Now(b *testing.B) {
	c := NewFake(time.Now())
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = c.Now()
	}
}
