// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package arbitration

import (
	"fmt"
	"math"
	"reflect"
	"testing"

	"github.com/shizukutanaka/Otedama/internal/hal"
)

// FuzzDecide feeds arbitrary bytes into Decide, decoding them into
// devices, streams (deliberately including NaN/±Inf/negative yields),
// policies, hysteresis, min-yield, and a possible previous allocation.
// No input may panic the engine, malformed input must error rather than
// silently misbehave, and every allocation produced must satisfy the
// invariants documented in the package's engine doc block.
func FuzzDecide(f *testing.F) {
	f.Add([]byte{})
	f.Add([]byte{1, 1, 1, 0, 0, 0, 0, 0, 0, 240, 63, 0, 0, 0, 0, 0, 0, 240, 63})
	f.Add(make([]byte, 256))
	f.Add([]byte{3, 5, 255, 255, 255, 255, 255, 255, 248, 127, 255, 255, 255, 255, 255, 255, 248, 127})
	f.Fuzz(func(t *testing.T, data []byte) {
		in := decodeFuzzInput(data)
		alloc, err := Decide(in)
		if err != nil {
			return // malformed input must error, not panic
		}
		if alloc == nil {
			t.Fatal("nil allocation with nil error")
		}
		if len(alloc.Assignments) != len(in.Devices) {
			t.Fatalf("assignments %d != devices %d", len(alloc.Assignments), len(in.Devices))
		}

		// Decide is documented deterministic: identical input, identical output.
		again, err := Decide(in)
		if err != nil {
			t.Fatalf("identical input errored on second call: %v", err)
		}
		if !reflect.DeepEqual(alloc, again) {
			t.Fatal("non-deterministic allocation for identical input")
		}

		streams := make(map[StreamID]Stream, len(in.Streams))
		for _, s := range in.Streams {
			streams[s.ID] = s
		}
		devs := make(map[string]DeviceRef, len(in.Devices))
		for _, d := range in.Devices {
			devs[d.Identity.ID] = d
		}
		prev := make(map[string]Assignment)
		if in.Previous != nil {
			for _, a := range in.Previous.Assignments {
				prev[a.DeviceID] = a
			}
		}

		var total float64
		for _, a := range alloc.Assignments {
			total += a.ExpectedYield
			if a.ForegoneSatsPerSec < 0 {
				t.Fatalf("ForegoneSatsPerSec %v < 0", a.ForegoneSatsPerSec)
			}
			if a.Stream == "" {
				continue
			}
			s, ok := streams[a.Stream]
			if !ok {
				t.Fatalf("assigned unknown stream %q", a.Stream)
			}
			if !s.Accepts(devs[a.DeviceID].Identity.Family) {
				t.Fatalf("stream %q does not accept family %q", a.Stream, devs[a.DeviceID].Identity.Family)
			}
			if math.IsNaN(a.ExpectedYield) || math.IsInf(a.ExpectedYield, 0) {
				t.Fatalf("non-finite ExpectedYield %v assigned", a.ExpectedYield)
			}
			if a.ExpectedYield < in.MinYieldSatsPerSec {
				t.Fatalf("assigned yield %v below floor %v", a.ExpectedYield, in.MinYieldSatsPerSec)
			}
			if a.Held {
				p, ok := prev[a.DeviceID]
				if !ok || p.Stream != a.Stream {
					t.Fatalf("held on %q but previous assignment was %q", a.Stream, p.Stream)
				}
			}
		}
		if alloc.TotalYield != total {
			t.Fatalf("TotalYield %v != sum of ExpectedYield %v", alloc.TotalYield, total)
		}
	})
}

// fuzzCursor decodes the raw fuzz byte stream into input fields. It
// mixes "realistic" small scalars with wild Float64frombits values so
// NaN and ±Inf actually reach the engine (uniform random bytes almost
// never produce them near the range that matters).
type fuzzCursor struct {
	data []byte
	pos  int
}

func (c *fuzzCursor) byte() byte {
	if c.pos >= len(c.data) {
		return 0
	}
	b := c.data[c.pos]
	c.pos++
	return b
}

func (c *fuzzCursor) u16() uint64 {
	return uint64(c.byte())<<8 | uint64(c.byte())
}

func (c *fuzzCursor) scalar() float64 {
	switch c.byte() % 4 {
	case 0: // small realistic value (0 .. ~4096)
		return float64(c.u16()) / 16.0
	case 1: // wild bits — NaN, ±Inf, subnormals all reach the engine
		var u uint64
		for range 8 {
			u = u<<8 | uint64(c.byte())
		}
		return math.Float64frombits(u)
	case 2: // negative — invalid for floors/margins, dead yield for quotes
		return -float64(c.u16()) / 16.0
	default:
		return 0
	}
}

var fuzzFamilies = []hal.Family{hal.FamilyCPU, hal.FamilyGPU, hal.FamilyASIC}

func decodeFuzzInput(data []byte) Input {
	c := &fuzzCursor{data: data}
	in := Input{}

	nDev := int(c.byte())%4 + 1
	in.Devices = make([]DeviceRef, nDev)
	for i := range in.Devices {
		in.Devices[i] = DeviceRef{
			Identity: hal.Identity{
				ID:     fmt.Sprintf("dev%d", i),
				Family: fuzzFamilies[c.byte()%byte(len(fuzzFamilies))],
			},
		}
	}

	nStreams := int(c.byte()) % 7
	for i := 0; i < nStreams; i++ {
		s := Stream{ID: StreamID(fmt.Sprintf("s%d", i))}
		mask := c.byte()
		for b := range 3 {
			if mask&(1<<b) != 0 {
				s.AcceptsFamilies = append(s.AcceptsFamilies, fuzzFamilies[b])
			}
		}
		s.DefaultYield = Yield{SatsPerSecond: c.scalar(), Confidence: c.scalar()}
		s.PrivacyRating = int(c.byte() % 11)
		s.EnvironmentalRating = int(c.byte() % 11)
		s.IsBitcoinMining = c.byte()%2 == 0
		s.PreemptionRisk = c.scalar()
		if c.byte()%3 == 0 {
			s.YieldPerDevice = map[string]Yield{
				in.Devices[int(c.byte())%nDev].Identity.ID: {
					SatsPerSecond: c.scalar(),
					Confidence:    c.scalar(),
				},
			}
		}
		in.Streams = append(in.Streams, s)
	}

	in.Policy = Policy(c.byte() % 4)
	in.HysteresisMargin = c.scalar()
	in.MinYieldSatsPerSec = c.scalar()

	if c.byte()%2 == 0 && len(in.Streams) > 0 {
		prev := &Allocation{}
		for _, d := range in.Devices {
			if c.byte()%2 == 0 {
				prev.Assignments = append(prev.Assignments, Assignment{
					DeviceID: d.Identity.ID,
					Stream:   in.Streams[int(c.byte())%len(in.Streams)].ID,
				})
			}
		}
		in.Previous = prev
	}
	return in
}
