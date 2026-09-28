// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
//
// Property test for the arbitration engine. CLAUDE.md requires
// property-based tests for the arbitration invariants documented on
// Decide; this fuzzer generates randomized device/stream/policy inputs
// and asserts them on every run:
//
//   - Every input device appears exactly once in Assignments, sorted by
//     DeviceID (the documented deterministic order).
//   - No device is assigned to a stream absent from the input or one
//     that does not Accept its family.
//   - A device left idle has no compatible stream that both yields > 0
//     and clears MinYieldSatsPerSec.
//   - TotalYield equals the sum of ExpectedYield (same accumulation
//     order, so IEEE-754 equality is exact).
//   - ForegoneSatsPerSec >= 0 on every assignment.
//   - Decide is deterministic: a second identical call returns a
//     reflect.DeepEqual allocation.
//
// Inputs are kept in-contract (Policy in range, margins >= 0,
// confidence in [0,1], finite non-negative yields); out-of-contract
// numeric inputs are rejected by Decide's own validation, and
// non-finite provider yields are a separate hardening track.
package arbitration

import (
	"math/rand"
	"reflect"
	"slices"
	"testing"

	"github.com/shizukutanaka/Otedama/internal/hal"
)

var fuzzFamilies = []hal.Family{hal.FamilyASIC, hal.FamilyGPU, hal.FamilyCPU}

func fuzzDevice(r *rand.Rand, i int) DeviceRef {
	return DeviceRef{
		Identity: hal.Identity{
			ID:     "dev-" + string(rune('a'+i)),
			Family: fuzzFamilies[r.Intn(len(fuzzFamilies))],
		},
	}
}

func fuzzYield(r *rand.Rand) Yield {
	var sats float64
	switch r.Intn(4) {
	case 0:
		sats = 0 // dead stream
	case 1:
		sats = r.Float64() // sub-1 sat/s
	default:
		sats = r.Float64() * 1e4
	}
	return Yield{
		SatsPerSecond: sats,
		Confidence:    r.Float64(),
	}
}

func fuzzInput(r *rand.Rand) (in Input, greedy bool) {
	devs := make([]DeviceRef, r.Intn(7))
	for i := range devs {
		devs[i] = fuzzDevice(r, i)
	}

	streams := make([]Stream, r.Intn(6))
	for i := range streams {
		s := Stream{
			ID:                  StreamID("stream-" + string(rune('a'+i))),
			DefaultYield:        fuzzYield(r),
			PrivacyRating:       r.Intn(11),
			EnvironmentalRating: r.Intn(11),
			IsBitcoinMining:     r.Intn(2) == 0,
		}
		// Accept a random subset of families (possibly empty).
		for _, f := range fuzzFamilies {
			if r.Intn(2) == 0 {
				s.AcceptsFamilies = append(s.AcceptsFamilies, f)
			}
		}
		// Sometimes quote a device-specific override.
		if r.Intn(3) == 0 && len(devs) > 0 {
			s.YieldPerDevice = map[string]Yield{
				devs[r.Intn(len(devs))].Identity.ID: fuzzYield(r),
			}
		}
		streams[i] = s
	}

	in = Input{
		Devices:            devs,
		Streams:            streams,
		Policy:             Policy(r.Intn(4)),
		HysteresisMargin:   r.Float64() * 2,
		MinYieldSatsPerSec: r.Float64() * 100,
	}
	// A quarter of runs hit the documented optimal-greedy regime:
	// maximize-earnings, no hysteresis, no previous allocation.
	greedy = r.Intn(4) == 0
	if greedy {
		in.Policy = PolicyMaximizeEarnings
		in.HysteresisMargin = 0
	}

	// Half the time, supply a previous allocation so the hysteresis path
	// runs. Streams referenced may no longer exist — that exercises the
	// incumbent-gone path too.
	if !greedy && r.Intn(2) == 0 && len(devs) > 0 {
		prev := &Allocation{Policy: in.Policy}
		for _, d := range devs {
			var streamID StreamID
			if len(streams) > 0 && r.Intn(3) != 0 {
				streamID = streams[r.Intn(len(streams))].ID
			}
			prev.Assignments = append(prev.Assignments, Assignment{
				DeviceID: d.Identity.ID,
				Stream:   streamID,
			})
		}
		in.Previous = prev
	}
	return in, greedy
}

func FuzzDecide(f *testing.F) {
	f.Add(int64(1))
	f.Add(int64(42))
	f.Add(int64(-7))
	f.Fuzz(func(t *testing.T, seed int64) {
		r := rand.New(rand.NewSource(seed))
		in, greedy := fuzzInput(r)

		alloc, err := Decide(in)
		if err != nil {
			t.Fatalf("Decide rejected in-contract input: %v", err)
		}
		if alloc == nil {
			t.Fatal("Decide returned nil allocation")
		}

		// Bijection and sorted order.
		if len(alloc.Assignments) != len(in.Devices) {
			t.Fatalf("got %d assignments for %d devices", len(alloc.Assignments), len(in.Devices))
		}
		devByID := make(map[string]DeviceRef, len(in.Devices))
		for _, d := range in.Devices {
			devByID[d.Identity.ID] = d
		}
		if !slices.IsSortedFunc(alloc.Assignments, func(a, b Assignment) int {
			return compareStr(a.DeviceID, b.DeviceID)
		}) {
			t.Fatal("assignments not sorted by DeviceID")
		}
		streamByID := make(map[StreamID]Stream, len(in.Streams))
		for _, s := range in.Streams {
			streamByID[s.ID] = s
		}

		var total float64
		for _, a := range alloc.Assignments {
			dev, ok := devByID[a.DeviceID]
			if !ok {
				t.Fatalf("assignment for unknown device %q", a.DeviceID)
			}
			delete(devByID, a.DeviceID)
			if a.ForegoneSatsPerSec < 0 {
				t.Fatalf("negative ForegoneSatsPerSec %v on %q", a.ForegoneSatsPerSec, a.DeviceID)
			}
			if a.Idle() {
				// Every compatible stream must yield <= 0 or sit below the floor.
				for _, s := range in.Streams {
					if !s.Accepts(dev.Identity.Family) {
						continue
					}
					y := s.YieldFor(dev.Identity.ID).Effective()
					if y > 0 && y >= in.MinYieldSatsPerSec {
						t.Fatalf("device %q idle though stream %q offered %v (floor %v)",
							a.DeviceID, s.ID, y, in.MinYieldSatsPerSec)
					}
				}
				continue
			}
			s, ok := streamByID[a.Stream]
			if !ok {
				t.Fatalf("device %q assigned to unknown stream %q", a.DeviceID, a.Stream)
			}
			if !s.Accepts(dev.Identity.Family) {
				t.Fatalf("device %q (family %s) assigned to incompatible stream %q",
					a.DeviceID, dev.Identity.Family, a.Stream)
			}
			if a.ExpectedYield <= 0 {
				t.Fatalf("assigned device %q has non-positive yield %v", a.DeviceID, a.ExpectedYield)
			}
			if a.ExpectedYield < in.MinYieldSatsPerSec {
				t.Fatalf("assigned device %q yield %v below floor %v",
					a.DeviceID, a.ExpectedYield, in.MinYieldSatsPerSec)
			}
			total += a.ExpectedYield
		}
		if len(devByID) != 0 {
			t.Fatalf("%d devices missing from allocation", len(devByID))
		}
		if alloc.TotalYield != total {
			t.Fatalf("TotalYield %v != sum of ExpectedYield %v", alloc.TotalYield, total)
		}

		// Greedy-optimality invariant: under PolicyMaximizeEarnings with no
		// hysteresis and no previous allocation, every device must get the
		// best compatible stream clearing the floor, so TotalYield equals
		// the per-device greedy maximum.
		if greedy {
			var want float64
			for _, d := range in.Devices {
				var best float64
				for _, s := range in.Streams {
					if !s.Accepts(d.Identity.Family) {
						continue
					}
					y := s.YieldFor(d.Identity.ID).Effective()
					if y > 0 && y >= in.MinYieldSatsPerSec && y > best {
						best = y
					}
				}
				want += best
			}
			if alloc.TotalYield != want {
				t.Fatalf("greedy regime: TotalYield %v != optimal %v", alloc.TotalYield, want)
			}
		}

		// Determinism: identical input reproduces an identical allocation.
		again, err := Decide(in)
		if err != nil {
			t.Fatalf("second Decide rejected identical input: %v", err)
		}
		if !reflect.DeepEqual(alloc, again) {
			t.Fatal("Decide is not deterministic")
		}
	})
}

func compareStr(a, b string) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	default:
		return 0
	}
}
