// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
//
// Fuzz/property tests for the difficulty↔target bitmath that converts
// pool-supplied values (mining.set_difficulty / SetTarget nBits) into
// the 256-bit targets shares are compared against. Malformed wire
// values must error, never panic or silently wrap; accepted values
// must satisfy the ordering and round-trip invariants the unit tests
// only cover at a handful of fixed points.
package miner

import (
	"math"
	"math/big"
	"testing"
)

// hashToBig interprets a Hash (little-endian, MSB at index 31) as a
// big-endian integer magnitude for property comparisons.
func hashToBig(h Hash) *big.Int {
	var be [32]byte
	for i := 0; i < 32; i++ {
		be[i] = h[31-i]
	}
	return new(big.Int).SetBytes(be[:])
}

func FuzzTargetFromNBits(f *testing.F) {
	f.Add(uint32(0x1d00ffff)) // genesis
	f.Add(uint32(0x17034219))
	f.Add(uint32(0))          // zero
	f.Add(uint32(0xffffffff)) // everything set
	f.Add(uint32(0x01003456)) // exponent 1 (below minimum)
	f.Add(uint32(0x20800000)) // negative mantissa bit
	f.Fuzz(func(t *testing.T, nBits uint32) {
		target, err := TargetFromNBits(nBits)
		if err != nil {
			return
		}
		if hashToBig(target).Sign() <= 0 {
			t.Fatalf("nBits 0x%08X accepted but produced non-positive target", nBits)
		}
		// Value round-trip: re-encoding the target and decoding again
		// must reproduce the identical target. NBitsFromTarget may pick
		// a different (non-canonical) nBits encoding, so compare targets,
		// not nBits values.
		rt, err := TargetFromNBits(NBitsFromTarget(target))
		if err != nil {
			t.Fatalf("nBits 0x%08X: re-encoded target 0x%08X rejected: %v",
				nBits, NBitsFromTarget(target), err)
		}
		if rt != target {
			t.Fatalf("nBits 0x%08X round-trip changed target", nBits)
		}
		// The all-zero hash meets every valid target.
		var zero Hash
		ok, err := MeetsTarget(zero, nBits)
		if err != nil || !ok {
			t.Fatalf("nBits 0x%08X: zero hash failed MeetsTarget (ok=%v err=%v)", nBits, ok, err)
		}
	})
}

func FuzzTargetFromDifficulty(f *testing.F) {
	f.Add(float64(1))
	f.Add(float64(0.001))  // fractional pool share difficulty
	f.Add(float64(1e15))   // huge
	f.Add(float64(1e-300)) // sub-normal tiny
	f.Add(float64(math.NaN()))
	f.Add(float64(math.Inf(1)))
	f.Fuzz(func(t *testing.T, d float64) {
		target, err := TargetFromDifficulty(d)
		if !(d > 0) || math.IsInf(d, 0) {
			if err == nil {
				t.Fatalf("invalid difficulty %v accepted (target %v)", d, target)
			}
			return
		}
		if err != nil {
			// A positive finite difficulty is legitimately rejected only
			// when the resulting target overflows 256 bits.
			return
		}
		tb := hashToBig(target)
		if tb.Sign() <= 0 {
			t.Fatalf("difficulty %v produced non-positive target", d)
		}
	})
}

func FuzzTargetFromDifficultyMonotonic(f *testing.F) {
	f.Add(float64(1), float64(2))
	f.Fuzz(func(t *testing.T, d1, d2 float64) {
		t1, err1 := TargetFromDifficulty(d1)
		t2, err2 := TargetFromDifficulty(d2)
		if err1 != nil || err2 != nil || d1 == d2 {
			return
		}
		b1, b2 := hashToBig(t1), hashToBig(t2)
		if d1 < d2 && b1.Cmp(b2) < 0 {
			t.Fatalf("non-monotonic: d1=%v t1=%v < d2=%v t2=%v", d1, t1, d2, t2)
		}
		if d1 > d2 && b1.Cmp(b2) > 0 {
			t.Fatalf("non-monotonic: d1=%v t1=%v > d2=%v t2=%v", d1, t1, d2, t2)
		}
	})
}
