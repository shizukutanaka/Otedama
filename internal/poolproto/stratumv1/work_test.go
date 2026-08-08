// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
package stratumv1

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"testing"
)

// genesisCoinbaseHex is the raw coinbase transaction of the Bitcoin genesis
// block — the one carrying the Times headline. It is used here as a real
// coinbase whose hash is independently known: the genesis block contains no
// other transaction, so SHA256d(coinbase) IS the block's merkle root. That
// makes the vector self-certifying — a wrong byte anywhere in the constant
// cannot produce the right root.
const genesisCoinbaseHex = "01000000010000000000000000000000000000000000000000000000000000000000000000" +
	"ffffffff4d04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f" +
	"72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73ffffffff0100" +
	"f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6" +
	"bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000"

// genesisMerkleRootHex is the genesis block header's merkle-root field, in
// header (internal) byte order.
const genesisMerkleRootHex = "3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a"

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("bad hex fixture %q: %v", s, err)
	}
	return b
}

// TestMerkleRoot_GenesisCoinbase_EmptyBranch checks the whole miner-side
// coinbase path against real block data: the four pieces a pool sends must
// reassemble into the exact transaction bytes, and hashing them must land on
// the genesis merkle root. The split points below are arbitrary — a pool
// picks them wherever its extranonce placeholder sits — which is precisely
// what makes this a test of concatenation order.
func TestMerkleRoot_GenesisCoinbase_EmptyBranch(t *testing.T) {
	full := mustHex(t, genesisCoinbaseHex)
	coinb1, extranonce1, extranonce2, coinb2 := full[:40], full[40:44], full[44:52], full[52:]

	if got := buildCoinbase(coinb1, extranonce1, extranonce2, coinb2); !bytes.Equal(got, full) {
		t.Fatalf("buildCoinbase reassembled %x, want %x", got, full)
	}

	root := merkleRoot(buildCoinbase(coinb1, extranonce1, extranonce2, coinb2), nil)
	if got := hex.EncodeToString(root[:]); got != genesisMerkleRootHex {
		t.Errorf("merkle root of the genesis coinbase = %s, want %s", got, genesisMerkleRootHex)
	}
}

// TestMerkleRoot_FoldsBranchOnTheRight pins the fold's operand order. The
// coinbase is always the leftmost leaf, so each branch hash is appended on
// the right — swapping the operands yields a different root, and a pool
// would reject every share built on it. The expected value was cross-checked
// against an independent SHA-256d implementation (python hashlib).
func TestMerkleRoot_FoldsBranchOnTheRight(t *testing.T) {
	coinbase := mustHex(t, genesisCoinbaseHex)
	var sibling [32]byte
	copy(sibling[:], mustHex(t, "f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16"))

	const want = "ce48cdc658e9102406ca147dfedf183262a80246ee61642d256c36466cb44e8f"
	root := merkleRoot(coinbase, [][32]byte{sibling})
	if got := hex.EncodeToString(root[:]); got != want {
		t.Errorf("folded root = %s, want %s", got, want)
	}

	// Folding in the other order must not accidentally agree.
	leaf := sha256d(coinbase)
	swapped := sha256d(append(append([]byte{}, sibling[:]...), leaf[:]...))
	if swapped == root {
		t.Error("sibling-on-the-left produced the same root; the fold is not order-sensitive")
	}
}

// TestMerkleRoot_FoldsEveryBranchLevel guards against a fold that stops
// early: with two levels the result must differ from the one-level result.
func TestMerkleRoot_FoldsEveryBranchLevel(t *testing.T) {
	coinbase := mustHex(t, genesisCoinbaseHex)
	var a, b [32]byte
	a[0], b[0] = 0x11, 0x22

	one := merkleRoot(coinbase, [][32]byte{a})
	two := merkleRoot(coinbase, [][32]byte{a, b})
	if one == two {
		t.Error("second branch level was ignored")
	}
}

// TestHeaderPrevHash_Block125552 walks the previous-block hash through both
// sides of the protocol on real block data.
//
// Block 125552 is the canonical worked example of Bitcoin block hashing: its
// header fields and resulting hash are fixed, public facts. The test starts
// from that block's *display* previous-hash, applies the pool-side transform
// exactly as node-stratum-pool's util.reverseByteOrder implements it (byte-
// reverse each of the 8 words, then reverse the whole buffer) to obtain what
// a pool would put in mining.notify, feeds that through headerPrevHash — the
// client-side rule taken from cpuminer — and asserts the assembled header
// hashes to the block's real hash.
//
// Because the two transforms come from independent implementations, one on
// each side of the wire, agreement here is evidence about the protocol, not
// just internal consistency: any error in either direction changes the hash.
func TestHeaderPrevHash_Block125552(t *testing.T) {
	const (
		prevDisplay   = "00000000000008a3a41b85b8b29ad444def299fee21793cd8b9e567eab02cd81"
		merkleDisplay = "2b12fcf1b09288fcaff797d71e950e71ae42b91e8bdb2304758dfcffc2b620e3"
		blockHash     = "00000000000000001e8d6829a8a21adc5d38d0a473b144b6765798e61f98bd1d"
		version       = uint32(1)
		nTime         = uint32(1305998791)
		nBits         = uint32(0x1a44b9f2)
		nonce         = uint32(2504433986)
	)

	// Pool side: previousblockhash (big-endian display) → mining.notify form.
	poolSide := mustHex(t, prevDisplay)
	for w := 0; w < 8; w++ {
		word := poolSide[w*4 : w*4+4]
		word[0], word[1], word[2], word[3] = word[3], word[2], word[1], word[0]
	}
	for i, j := 0, len(poolSide)-1; i < j; i, j = i+1, j-1 {
		poolSide[i], poolSide[j] = poolSide[j], poolSide[i]
	}
	var notify [32]byte
	copy(notify[:], poolSide)

	// Client side: mining.notify form → block-header field.
	prevField := headerPrevHash(notify)

	// Assemble the 80-byte header and hash it. Bitcoin's header is
	// little-endian throughout: the merkle root and prev-hash fields are the
	// reverse of their displayed forms.
	merkleField := mustHex(t, merkleDisplay)
	for i, j := 0, len(merkleField)-1; i < j; i, j = i+1, j-1 {
		merkleField[i], merkleField[j] = merkleField[j], merkleField[i]
	}
	header := make([]byte, 0, 80)
	header = binary.LittleEndian.AppendUint32(header, version)
	header = append(header, prevField[:]...)
	header = append(header, merkleField...)
	header = binary.LittleEndian.AppendUint32(header, nTime)
	header = binary.LittleEndian.AppendUint32(header, nBits)
	header = binary.LittleEndian.AppendUint32(header, nonce)

	got := sha256d(header)
	for i, j := 0, 31; i < j; i, j = i+1, j-1 { // internal → display order
		got[i], got[j] = got[j], got[i]
	}
	if hex.EncodeToString(got[:]) != blockHash {
		t.Errorf("block 125552 hashed to %x, want %s\n(prev-hash byte order is wrong)", got, blockHash)
	}
}

// TestHeaderPrevHash_IsItsOwnInverse documents the transform's shape: it
// reverses bytes within each word and never moves a word, so applying it
// twice is the identity.
func TestHeaderPrevHash_IsItsOwnInverse(t *testing.T) {
	var in [32]byte
	for i := range in {
		in[i] = byte(i)
	}
	if got := headerPrevHash(headerPrevHash(in)); got != in {
		t.Errorf("headerPrevHash applied twice = %x, want %x", got, in)
	}
	// First word must be byte-reversed in place, not relocated.
	once := headerPrevHash(in)
	if once[0] != 3 || once[1] != 2 || once[2] != 1 || once[3] != 0 {
		t.Errorf("first word = %x, want 03020100 (byte-reversed in place)", once[0:4])
	}
	if once[4] != 7 {
		t.Errorf("second word starts with %#x, want 0x07 — words must keep their positions", once[4])
	}
}

func TestExtraNonce2_LittleEndianAndSize(t *testing.T) {
	tests := []struct {
		counter uint64
		size    int
		want    string
	}{
		{0, 4, "00000000"},
		{1, 4, "01000000"},
		{258, 4, "02010000"},
		{1, 8, "0100000000000000"},
		{0xff, 2, "ff00"},
		{0, 0, ""},
		{0, -1, ""},
		// Sizes above 8 bytes are zero-padded, not truncated garbage.
		{1, 12, "010000000000000000000000"},
	}
	for _, tt := range tests {
		if got := hex.EncodeToString(extraNonce2(tt.counter, tt.size)); got != tt.want {
			t.Errorf("extraNonce2(%d, %d) = %q, want %q", tt.counter, tt.size, got, tt.want)
		}
	}
}
