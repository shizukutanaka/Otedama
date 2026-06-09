// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package hal

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
)

// Registry holds the set of Drivers available to a Detector.
//
// Registry is safe for concurrent use. Drivers are typically registered
// once at program startup (for example, from an init function or from
// main) and then read many times during detection.
//
// The zero value of Registry is not usable; callers must use NewRegistry.
// This is intentional: the zero value would appear to work but would have
// no drivers, leading to confusing "no devices found" errors. Requiring
// construction forces the caller to acknowledge that registration must
// occur.
type Registry struct {
	mu      sync.RWMutex
	drivers map[string]Driver
}

// NewRegistry returns an empty Registry ready to accept driver registrations.
func NewRegistry() *Registry {
	return &Registry{
		drivers: make(map[string]Driver),
	}
}

// Register adds a driver to the registry.
//
// Register returns an error if the driver's name is empty or if a driver
// with the same name is already registered. Duplicate registration is
// treated as an error (rather than silently replacing) to surface
// configuration bugs early.
func (r *Registry) Register(d Driver) error {
	if d == nil {
		return errors.New("hal: cannot register nil driver")
	}
	name := d.Name()
	if name == "" {
		return errors.New("hal: driver must have a non-empty name")
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	if _, exists := r.drivers[name]; exists {
		return fmt.Errorf("hal: driver %q is already registered", name)
	}
	r.drivers[name] = d
	return nil
}

// Drivers returns a snapshot of the registered drivers, sorted by name.
//
// The returned slice is a new allocation; callers may modify it without
// affecting the registry. Sorting by name provides deterministic iteration
// order, which simplifies logging and testing.
func (r *Registry) Drivers() []Driver {
	r.mu.RLock()
	defer r.mu.RUnlock()

	names := make([]string, 0, len(r.drivers))
	for name := range r.drivers {
		names = append(names, name)
	}
	sort.Strings(names)

	result := make([]Driver, 0, len(names))
	for _, name := range names {
		result = append(result, r.drivers[name])
	}
	return result
}

// Lookup returns the driver registered under the given name.
//
// If no driver is registered under that name, Lookup returns nil and
// false. Callers must check the boolean result before using the driver.
func (r *Registry) Lookup(name string) (Driver, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	d, ok := r.drivers[name]
	return d, ok
}

// Len returns the number of drivers currently registered.
//
// Len is primarily useful for logging and diagnostics; it should not be
// used as the basis for control flow that depends on specific drivers
// being present.
func (r *Registry) Len() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.drivers)
}

// detector is the default Detector implementation.
//
// It invokes each driver's Enumerate method in parallel and aggregates
// the results. Errors from individual drivers are collected but do not
// prevent other drivers from succeeding.
type detector struct {
	registry *Registry
	logger   func(driver, msg string, err error)
}

// NewDetector returns a Detector backed by the given Registry.
//
// If logger is nil, driver errors are silently discarded. For production
// use, pass a logger that records errors to the Otedama observability
// pipeline. For tests, nil is usually appropriate.
func NewDetector(r *Registry, logger func(driver, msg string, err error)) Detector {
	if r == nil {
		r = NewRegistry()
	}
	return &detector{
		registry: r,
		logger:   logger,
	}
}

// Detect implements Detector.Detect.
//
// Each driver's Enumerate is invoked in its own goroutine. Results are
// collected via a channel. If ctx is canceled before all drivers have
// finished, Detect returns the devices accumulated so far and the
// context's error.
func (d *detector) Detect(ctx context.Context) ([]Device, error) {
	drivers := d.registry.Drivers()
	if len(drivers) == 0 {
		return nil, nil
	}

	type result struct {
		devices []Device
		err     error
		driver  string
	}

	resultsCh := make(chan result, len(drivers))

	var wg sync.WaitGroup
	for _, dr := range drivers {
		wg.Add(1)
		go func(dr Driver) {
			defer wg.Done()
			devs, err := dr.Enumerate(ctx)
			resultsCh <- result{
				devices: devs,
				err:     err,
				driver:  dr.Name(),
			}
		}(dr)
	}

	// Close the channel once all drivers have finished.
	go func() {
		wg.Wait()
		close(resultsCh)
	}()

	var all []Device
loop:
	for {
		select {
		case res, ok := <-resultsCh:
			if !ok {
				break loop
			}
			if res.err != nil && d.logger != nil {
				d.logger(res.driver, "enumerate failed", res.err)
			}
			for _, dev := range res.devices {
				if err := dev.Identity().Validate(); err != nil {
					if d.logger != nil {
						d.logger(res.driver, "device rejected due to invalid identity", err)
					}
					continue
				}
				all = append(all, dev)
			}
		case <-ctx.Done():
			break loop
		}
	}

	if err := ctx.Err(); err != nil {
		return all, err
	}
	return all, nil
}
