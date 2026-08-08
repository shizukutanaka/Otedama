// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package stratum

import (
	"crypto/sha256"
	"hash"
	"sync"
)

// hashPool reuses sha256.New hashers across handshake operations.
//
// During a Noise handshake, hkdf2 and hkdf3 call hmacSHA256 multiple
// times, each of which creates two new sha256 hashers. A single
// handshake allocates ~12 hasher objects, all discarded immediately.
// For hot reconnect scenarios (flaky networks, mobile miners, small
// pool failover), this is measurable GC pressure.
//
// sync.Pool reduces the allocation rate to near-zero for steady-state
// operation. The pool is keyed on the hasher interface so the same
// pool can be used for the inner and outer hash in HMAC.
//
// Status: hmacSHA256Pooled is implemented, correctness-tested, and
// benchmarked (see noise_pool_test.go), but hkdf2/hkdf3 in noise.go
// still call the unpooled hmacSHA256 — this pooling is not yet wired
// into the live handshake path. noise.go and noise_pool.go together
// fall under CLAUDE.md's CODEOWNERS-gated funds-critical review
// requirement, so wiring hmacSHA256Pooled into hkdf2/hkdf3 is left as
// a deliberate, reviewed follow-up rather than made here.
var hashPool = sync.Pool{
	New: func() any {
		return sha256.New()
	},
}

// getHasher borrows a reset sha256 hasher from the pool.
func getHasher() hash.Hash {
	h, ok := hashPool.Get().(hash.Hash)
	if !ok {
		return sha256.New()
	}
	h.Reset()
	return h
}

// putHasher returns a hasher to the pool.
func putHasher(h hash.Hash) {
	hashPool.Put(h)
}

// hmacSHA256Pooled is an allocation-minimising version of hmacSHA256.
// The result is a freshly allocated 32-byte slice; the hashers are
// pooled.
func hmacSHA256Pooled(key, data []byte) []byte {
	const blockSize = 64
	if len(key) > blockSize {
		h := getHasher()
		h.Write(key)
		hashed := h.Sum(nil)
		putHasher(h)
		key = hashed
	}
	// Using stack-allocated arrays here costs the same as []byte(...)
	// because they escape to the heap; we keep []byte for readability.
	ipad := make([]byte, blockSize)
	opad := make([]byte, blockSize)
	copy(ipad, key)
	copy(opad, key)
	for i := range ipad {
		ipad[i] ^= 0x36
		opad[i] ^= 0x5C
	}

	inner := getHasher()
	inner.Write(ipad)
	inner.Write(data)
	innerSum := inner.Sum(nil)
	putHasher(inner)

	outer := getHasher()
	outer.Write(opad)
	outer.Write(innerSum)
	result := outer.Sum(nil)
	putHasher(outer)

	return result
}
