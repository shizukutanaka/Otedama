// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package miner

import (
	"encoding/hex"
	"testing"
)

// The vectors below were computed with an independent implementation
// (Python hashlib SHA256d over the same construction), so a regression
// here means the Go construction diverged from the canonical recipe —
// not that both moved together.
//
// Fixture is a realistic Slushpool-format notify: coinb1 carries the
// coinbase prefix through the extranonce slots, coinb2 the suffix.

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("bad hex fixture: %v", err)
	}
	return b
}

func mustHash(t *testing.T, s string) Hash {
	t.Helper()
	b := mustHex(t, s)
	if len(b) != 32 {
		t.Fatalf("hash fixture is %d bytes, want 32", len(b))
	}
	var h Hash
	copy(h[:], b)
	return h
}

func TestCoinbaseHash_Vector(t *testing.T) {
	coinb1 := mustHex(t, "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff20")
	coinb2 := mustHex(t, "ffffffff0100f2052a010000004341041b0e8c2567c12536aa13357b79a073dc4444acb83c4ec7a0e2f99dd7457516c5817242da796924ca4e99947d087fedf9ce467cb9f7c6287078f801df276fdf84ac00000000")
	en1 := mustHex(t, "cc")
	en2 := make([]byte, 4) // all-zero extranonce2 (Otedama does not rotate it)

	got := CoinbaseHash(coinb1, en1, en2, coinb2)
	want := mustHash(t, "4c8e3abc70cd20bdb86fe7df3095ba9a4166f192eeb91f6cce72946e5b216202")
	if got != want {
		t.Errorf("CoinbaseHash = %x, want %x", got, want)
	}
}

func TestMerkleRootFromCoinbase_EmptyBranches(t *testing.T) {
	cb := mustHash(t, "4c8e3abc70cd20bdb86fe7df3095ba9a4166f192eeb91f6cce72946e5b216202")
	// A single-transaction template: merkle root IS the coinbase hash.
	if got := MerkleRootFromCoinbase(cb, nil); got != cb {
		t.Errorf("MerkleRootFromCoinbase(empty) = %x, want coinbase hash %x", got, cb)
	}
}

func TestMerkleRootFromCoinbase_TwoBranches(t *testing.T) {
	cb := mustHash(t, "4c8e3abc70cd20bdb86fe7df3095ba9a4166f192eeb91f6cce72946e5b216202")
	b1 := mustHash(t, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	b2 := mustHash(t, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")

	got := MerkleRootFromCoinbase(cb, [][32]byte{b1, b2})
	want := mustHash(t, "7696f344c0cd6bede8914453910f7deff16646e545e11a2eabc909b3019c2a58")
	if got != want {
		t.Errorf("MerkleRootFromCoinbase = %x, want %x", got, want)
	}
}
