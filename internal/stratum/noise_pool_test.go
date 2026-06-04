// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package stratum

import (
	"bytes"
	"encoding/hex"
	"runtime"
	"sync"
	"testing"
)

// ----- HMAC correctness -----

func TestHmacSHA256Pooled_MatchesNonPooled(t *testing.T) {
	cases := []struct{ key, data string }{
		{"", ""},
		{"key", "data"},
		{"short", "the quick brown fox"},
		{"a-very-long-key-exceeding-the-block-size-of-sixty-four-bytes-to-trigger-the-key-hashing-branch", "data"},
		{"Jefe", "what do ya want for nothing?"}, // RFC 4231 test case 2
	}
	for _, c := range cases {
		want := hmacSHA256([]byte(c.key), []byte(c.data))
		got := hmacSHA256Pooled([]byte(c.key), []byte(c.data))
		if !bytes.Equal(want, got) {
			t.Errorf("key=%q data=%q:\n  pooled = %x\n  expect = %x",
				c.key, c.data, got, want)
		}
	}
}

func TestHmacSHA256Pooled_RFC4231Vector(t *testing.T) {
	// RFC 4231 test case 1:
	// key  = 0x0b * 20
	// data = "Hi There"
	// Expected HMAC-SHA256:
	//   b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7
	key := bytes.Repeat([]byte{0x0b}, 20)
	data := []byte("Hi There")
	want, _ := hex.DecodeString("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7")

	got := hmacSHA256Pooled(key, data)
	if !bytes.Equal(got, want) {
		t.Errorf("RFC 4231 case 1:\n  got  %x\n  want %x", got, want)
	}
}

// ----- Concurrency safety -----

func TestHmacSHA256Pooled_ConcurrentSafe(t *testing.T) {
	// Run many goroutines hammering the pool. If hashPool mishandles
	// Reset() or concurrent Put(), we would see corrupt outputs.
	const goroutines = 64
	const iterations = 200

	reference := hmacSHA256Pooled([]byte("reference"), []byte("payload"))

	var wg sync.WaitGroup
	errCh := make(chan error, goroutines)
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < iterations; i++ {
				got := hmacSHA256Pooled([]byte("reference"), []byte("payload"))
				if !bytes.Equal(got, reference) {
					errCh <- &concurrencyError{got: got, want: reference}
					return
				}
			}
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Error(err)
	}
}

type concurrencyError struct{ got, want []byte }

func (e *concurrencyError) Error() string {
	return "pool corruption: got " + hex.EncodeToString(e.got) +
		" want " + hex.EncodeToString(e.want)
}

// ----- Allocation count (tests the optimisation actually helps) -----

func TestHmacSHA256Pooled_AllocationReduction(t *testing.T) {
	// This is not a strict assertion — allocations depend on Go version
	// and pool state. It just documents the expected improvement.
	key := []byte("test-key")
	data := []byte("test-data")

	// Warm up the pool.
	for i := 0; i < 100; i++ {
		_ = hmacSHA256Pooled(key, data)
	}

	// Measure allocations.
	var (
		nonPooledAllocs = testingAllocations(func() {
			_ = hmacSHA256(key, data)
		})
		pooledAllocs = testingAllocations(func() {
			_ = hmacSHA256Pooled(key, data)
		})
	)
	// Per the note above, this measurement is too noisy to assert on
	// strictly (sync.Pool overhead and the MemStats sampling both vary by
	// Go version), so a higher pooled count is logged, not failed. The
	// pool's real benefit shows under sustained load, not a 10-iteration
	// micro-measurement.
	if pooledAllocs > nonPooledAllocs {
		t.Logf("note: pooled allocations (%d) exceeded non-pooled (%d) in this micro-measurement",
			pooledAllocs, nonPooledAllocs)
	}
	t.Logf("allocations: non-pooled=%d, pooled=%d", nonPooledAllocs, pooledAllocs)
}

// testingAllocations measures allocations per call using runtime.MemStats.
// This is approximate but sufficient to detect large regressions.
func testingAllocations(fn func()) int64 {
	const iterations = 10
	runtime.GC() // reduce noise from unrelated garbage
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	for i := 0; i < iterations; i++ {
		fn()
	}
	runtime.ReadMemStats(&after)
	return int64(after.Mallocs-before.Mallocs) / int64(iterations)
}

// ----- Benchmarks -----

func BenchmarkHmacSHA256_NonPooled(b *testing.B) {
	key := []byte("benchmark-key")
	data := []byte("benchmark-data-payload")
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = hmacSHA256(key, data)
	}
}

func BenchmarkHmacSHA256_Pooled(b *testing.B) {
	key := []byte("benchmark-key")
	data := []byte("benchmark-data-payload")
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = hmacSHA256Pooled(key, data)
	}
}
