// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package clock provides an abstraction over the system clock to enable
// deterministic testing of time-dependent code.
//
// # Rationale
//
// Directly calling time.Now() in production code makes that code untestable:
// tests cannot control what "now" means, cannot advance time to test
// timeouts, and cannot test behavior around specific timestamps. This
// package provides a Clock interface that production code depends on
// instead of calling time.Now() directly.
//
// # Usage
//
// Production code that needs the current time should accept a Clock as a
// dependency, typically through its constructor:
//
//	type RateLimiter struct {
//		clock clock.Clock
//		// ...
//	}
//
//	func NewRateLimiter(c clock.Clock) *RateLimiter {
//		return &RateLimiter{clock: c}
//	}
//
// In production, pass clock.System{}. In tests, pass a *clock.Fake, which
// allows the test to advance time explicitly:
//
//	c := clock.NewFake(time.Date(2026, 4, 18, 12, 0, 0, 0, time.UTC))
//	limiter := NewRateLimiter(c)
//	// ... operations
//	c.Advance(time.Second)
//	// ... verify behavior after 1 second
package clock

import (
	"sync"
	"time"
)

// Clock is the interface that abstracts time-dependent operations.
//
// Implementations must be safe for concurrent use from multiple goroutines,
// as Otedama's scheduling and monitoring code reads the clock from many
// goroutines simultaneously.
type Clock interface {
	// Now returns the current time according to this clock.
	Now() time.Time
}

// System is the production implementation of Clock that delegates to the
// standard library's time package. Its zero value is usable; no
// construction is required.
type System struct{}

// Now returns time.Now().
func (System) Now() time.Time {
	return time.Now()
}

// Fake is a Clock implementation whose time is explicitly controlled by
// the caller. It is intended for use in tests.
//
// Fake is safe for concurrent use.
type Fake struct {
	mu  sync.RWMutex
	now time.Time
}

// NewFake returns a Fake clock set to the given initial time.
//
// Typical usage sets the initial time to a specific, meaningful value
// rather than time.Now(), so that tests are fully deterministic:
//
//	c := clock.NewFake(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
func NewFake(initial time.Time) *Fake {
	return &Fake{now: initial}
}

// Now returns the current time as set by the most recent Set or Advance
// call (or the initial time passed to NewFake).
func (c *Fake) Now() time.Time {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.now
}

// Set changes the current time to t.
//
// Set allows time to move backward, which is useful for testing code that
// must handle clock skew or system clock adjustments. Production code
// should not rely on monotonic time ordering when using a Clock, as this
// package does not guarantee monotonicity.
func (c *Fake) Set(t time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = t
}

// Advance moves the current time forward by d.
//
// If d is negative, time moves backward. See Set for notes on monotonicity.
func (c *Fake) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

// Compile-time interface satisfaction checks. A build error here means a
// Clock implementation is missing a method — caught at go build, not only
// go test.
var (
	_ Clock = System{}
	_ Clock = (*Fake)(nil)
)
