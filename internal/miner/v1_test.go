// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package miner

import (
	"context"
	"testing"
	"time"
)

// The canonical genesis-block coinbase transaction (raw wire bytes).
const genesisCoinbaseHex = "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff4d04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73ffffffff0100f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000"

// TestBuildV1Header_GenesisBlock is the end-to-end correctness proof for
// the V1 share path: split the real genesis coinbase into arbitrary
// coinb1/extranonce1/extranonce2/coinb2 slices, rebuild the header through
// the V1 machinery, and require the header hash to be the documented
// genesis block hash. If coinbase assembly, merkle folding, or header
// byte order were wrong anywhere, this hash could not come out right.
func TestBuildV1Header_GenesisBlock(t *testing.T) {
	coinbase := decodeHex(t, genesisCoinbaseHex)

	// Arbitrary split — the fold is agnostic to where the seams fall.
	coinb1 := coinbase[:80]
	en1 := coinbase[80:88]
	en2 := coinbase[88:92]
	coinb2 := coinbase[92:]

	tmpl := &V1JobTemplate{
		JobID:           "genesis",
		Version:         1,
		PrevHash:        [32]byte{}, // genesis has no predecessor
		NTime:           0x495fab29,
		NBits:           0x1d00ffff,
		Coinb1:          coinb1,
		Coinb2:          coinb2,
		MerkleBranches:  nil, // single-tx block: coinbase hash IS the root
		Extranonce1:     en1,
		Extranonce2Size: len(en2),
	}

	hdr, err := BuildV1Header(tmpl, en2)
	if err != nil {
		t.Fatalf("BuildV1Header: %v", err)
	}
	hdr.Nonce = 0x7c2bac1d

	var want Hash
	copy(want[:], decodeHex(t, "6fe28c0ab6f1b372c1a6a246ae63f74f931e8365e15a089c68d6190000000000"))
	if got := HashHeader(hdr); got != want {
		t.Fatalf("reconstructed genesis header hashes to %s, want %s", got, want)
	}

	// The merkle root must equal the coinbase's own hash (single-tx block).
	var wantMerkle Hash
	copy(wantMerkle[:], decodeHex(t, "3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a"))
	if Hash(hdr.MerkleRoot) != wantMerkle {
		t.Errorf("merkle root = %x, want %x", hdr.MerkleRoot, wantMerkle)
	}
}

// TestBuildV1Header_MerkleBranches exercises the branch fold: for a two-tx
// block the root is sha256d(cbHash || otherHash). The genesis coinbase is
// reused as an arbitrary payload.
func TestBuildV1Header_MerkleBranches(t *testing.T) {
	coinbase := decodeHex(t, genesisCoinbaseHex)
	other := decodeHex(t, genesisCoinbaseHex) // arbitrary second leaf payload

	leaf := SHA256d(coinbase)
	branch := SHA256d(other)
	// Expected fold: sha256d(leaf || branch).
	buf := append(append([]byte{}, leaf[:]...), branch[:]...)
	want := SHA256d(buf)

	tmpl := &V1JobTemplate{
		Version:         2,
		Coinb1:          coinbase[:80],
		Extranonce1:     coinbase[80:88],
		Coinb2:          coinbase[92:],
		MerkleBranches:  [][]byte{branch[:]},
		Extranonce2Size: 4,
	}
	hdr, err := BuildV1Header(tmpl, coinbase[88:92])
	if err != nil {
		t.Fatalf("BuildV1Header: %v", err)
	}
	if Hash(hdr.MerkleRoot) != want {
		t.Errorf("merkle root = %x, want %x", hdr.MerkleRoot, want)
	}
}

func TestBuildV1Header_Errors(t *testing.T) {
	if _, err := BuildV1Header(nil, nil); err == nil {
		t.Error("nil template should error")
	}
	base := &V1JobTemplate{Coinb1: []byte{1}, Coinb2: []byte{2}, Extranonce2Size: 4}
	if _, err := BuildV1Header(base, []byte{1, 2}); err == nil {
		t.Error("wrong-size extranonce2 should error")
	}
	if _, err := BuildV1Header(&V1JobTemplate{Extranonce2Size: 0}, nil); err == nil {
		t.Error("missing coinbase halves should error")
	}
	badBranch := &V1JobTemplate{Coinb1: []byte{1}, Coinb2: []byte{2}, MerkleBranches: [][]byte{{0x01}}}
	if _, err := BuildV1Header(badBranch, nil); err == nil {
		t.Error("non-32-byte merkle branch should error")
	}
}

// TestWorker_V1JobProducesShare runs the grind loop end-to-end on a V1
// template: the emitted share must carry the opaque string job id and the
// extranonce2 it was mined with.
func TestWorker_V1JobProducesShare(t *testing.T) {
	coinbase := decodeHex(t, genesisCoinbaseHex)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	w := NewWorker(WorkerConfig{Threads: 1, DeviceID: "cpu-0"})
	shares := w.Start(ctx)
	defer w.Stop()

	// Target of all-0xff accepts every hash → first nonce wins.
	var target Hash
	for i := range target {
		target[i] = 0xff
	}
	w.SetWork(&Work{
		Target: target,
		V1: &V1JobTemplate{
			JobID:           "abc123", // non-numeric, opaque
			Version:         1,
			NTime:           0x495fab29,
			NBits:           0x1d00ffff,
			Coinb1:          coinbase[:80],
			Extranonce1:     coinbase[80:88],
			Coinb2:          coinbase[92:],
			Extranonce2Size: 4,
		},
	})

	select {
	case s := <-shares:
		if s.JobIDStr != "abc123" {
			t.Errorf("JobIDStr = %q, want abc123", s.JobIDStr)
		}
		if len(s.ExtraNonce) != 4 {
			t.Errorf("ExtraNonce len = %d, want 4", len(s.ExtraNonce))
		}
		if s.Version != 1 {
			t.Errorf("Version = %d, want 1", s.Version)
		}
	case <-ctx.Done():
		t.Fatal("no share produced")
	}
}

// TestWork_V1EN2UniqueAcrossWorkers pins the regression where each Worker
// owned a private extranonce2 counter: two devices grinding the same job
// would hand the pool identical (job, en2, ntime, nonce) tuples — the
// pool deduplicates on exactly that key and rejects the second share.
// The counter now lives on the shared Work, so allocations are unique.
func TestWork_V1EN2UniqueAcrossWorkers(t *testing.T) {
	coinbase := decodeHex(t, genesisCoinbaseHex)
	var target Hash
	for i := range target {
		target[i] = 0xff // accept every hash
	}
	work := &Work{
		Target: target,
		V1: &V1JobTemplate{
			JobID:           "dup-test",
			Version:         1,
			NTime:           0x495fab29,
			NBits:           0x1d00ffff,
			Coinb1:          coinbase[:80],
			Extranonce1:     coinbase[80:88],
			Coinb2:          coinbase[92:],
			Extranonce2Size: 4,
		},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	w1 := NewWorker(WorkerConfig{Threads: 1, DeviceID: "cpu-0"})
	w2 := NewWorker(WorkerConfig{Threads: 1, DeviceID: "cpu-1"})
	s1 := w1.Start(ctx)
	s2 := w2.Start(ctx)
	defer w1.Stop()
	defer w2.Stop()

	w1.SetWork(work)
	w2.SetWork(work)

	var a, b Share
	select {
	case a = <-s1:
	case <-ctx.Done():
		t.Fatal("worker 1 produced no share")
	}
	select {
	case b = <-s2:
	case <-ctx.Done():
		t.Fatal("worker 2 produced no share")
	}
	// Same nonce is fine only if en2 differs — that is exactly what the
	// shared counter guarantees.
	if string(a.ExtraNonce) == string(b.ExtraNonce) {
		t.Fatalf("duplicate extranonce2 %x across workers on one job", a.ExtraNonce)
	}
}
