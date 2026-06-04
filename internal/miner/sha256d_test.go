// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package miner

import (
	"encoding/hex"
	"testing"
)

// decodeHex is a test helper that panics on invalid hex.
func decodeHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("hex.DecodeString(%q): %v", s, err)
	}
	return b
}

// ----- SHA256d -----

func TestSHA256d_GenesisBlock(t *testing.T) {
	// The Bitcoin genesis block header is one of the most well-known
	// test vectors in existence. If our SHA256d returns anything other
	// than the documented hash, something fundamental is broken.
	//
	// Genesis block header (hex, 80 bytes):
	// 01000000 0000...0000 3ba3edfd...d6fb9e2b 29ab5f49 ffff001d 1dac2b7c
	//
	// Expected hash (little-endian as Bitcoin displays it):
	// 000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f
	//
	// Note: Bitcoin displays block hashes in reversed byte order for
	// human display. The actual bytes stored in the header's PrevHash
	// field are the reverse. Here we test the raw SHA256d output, which
	// matches the "internal" representation (not reversed for display).

	genesisHeaderHex := "0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c"
	headerBytes := decodeHex(t, genesisHeaderHex)
	if len(headerBytes) != HeaderSize {
		t.Fatalf("genesis header is %d bytes, want %d", len(headerBytes), HeaderSize)
	}

	hash := SHA256d(headerBytes)

	// The expected hash in internal (non-display) byte order:
	// The well-known display hash is 000000000019d6689c..., which is the
	// byte-reversed form. The raw SHA256d result has the bytes in this order.
	wantHex := "6fe28c0ab6f1b372c1a6a246ae63f74f931e8365e15a089c68d6190000000000"
	wantBytes := decodeHex(t, wantHex)
	var want Hash
	copy(want[:], wantBytes)

	if hash != want {
		t.Errorf("genesis SHA256d:\n got  %s\n want %s", hash, want)
	}
}

func TestSHA256d_KnownVector(t *testing.T) {
	// SHA256d of empty input.
	// SHA256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
	// SHA256(above) = 5df6e0e2761359d30a8275058e299fcc0381534545f55cf43e41983f5d4c9456
	want := "5df6e0e2761359d30a8275058e299fcc0381534545f55cf43e41983f5d4c9456"
	hash := SHA256d([]byte{})
	if hash.String() != want {
		t.Errorf("SHA256d(empty):\n got  %s\n want %s", hash, want)
	}
}

// ----- Header serialisation -----

func TestHeader_Bytes_Roundtrip(t *testing.T) {
	orig := Header{
		Version: 0x20000000,
		Time:    0x60000000,
		Bits:    0x17130000,
		Nonce:   0xDEADBEEF,
	}
	for i := range orig.PrevHash {
		orig.PrevHash[i] = byte(i)
	}
	for i := range orig.MerkleRoot {
		orig.MerkleRoot[i] = byte(255 - i)
	}

	b := orig.Bytes()
	got := ParseHeader(b)

	if got.Version != orig.Version {
		t.Errorf("Version: got 0x%08X, want 0x%08X", got.Version, orig.Version)
	}
	if got.Nonce != orig.Nonce {
		t.Errorf("Nonce: got 0x%08X, want 0x%08X", got.Nonce, orig.Nonce)
	}
	if got.PrevHash != orig.PrevHash {
		t.Error("PrevHash mismatch")
	}
	if got.MerkleRoot != orig.MerkleRoot {
		t.Error("MerkleRoot mismatch")
	}
	if got.Bits != orig.Bits {
		t.Errorf("Bits: got 0x%08X, want 0x%08X", got.Bits, orig.Bits)
	}
}

func TestHeader_NonceIsAtOffset76(t *testing.T) {
	// The nonce occupies bytes [76:80] per the Bitcoin specification.
	// Mining software that increments the wrong bytes will produce no valid shares.
	h := Header{Nonce: 0x01020304}
	b := h.Bytes()
	nonce := uint32(b[76]) | uint32(b[77])<<8 | uint32(b[78])<<16 | uint32(b[79])<<24
	if nonce != h.Nonce {
		t.Errorf("nonce at offset 76: got 0x%08X, want 0x%08X", nonce, h.Nonce)
	}
}

// ----- TargetFromNBits -----

func TestTargetFromNBits_KnownTargets(t *testing.T) {
	tests := []struct {
		name  string
		nBits uint32
		// wantBE is the canonical big-endian target. TargetFromNBits stores
		// it little-endian (MSB at index 31) to match the Hash byte order,
		// so we compare against the reversed form.
		wantBE string
	}{
		{
			name:   "genesis block nBits",
			nBits:  0x1d00ffff,
			wantBE: "00000000ffff0000000000000000000000000000000000000000000000000000",
		},
		{
			name:   "high difficulty",
			nBits:  0x17130000,
			wantBE: "0000000000000000001300000000000000000000000000000000000000000000",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			target, err := TargetFromNBits(tt.nBits)
			if err != nil {
				t.Fatalf("TargetFromNBits(0x%08X): %v", tt.nBits, err)
			}
			be := decodeHex(t, tt.wantBE)
			var want Hash
			for i := 0; i < 32; i++ {
				want[i] = be[31-i] // reverse big-endian → little-endian
			}
			if target != want {
				t.Errorf("TargetFromNBits(0x%08X):\n got  %x\n want %x (LE of %s)",
					tt.nBits, target, want, tt.wantBE)
			}
		})
	}
}

func TestTargetFromNBits_RejectsNegativeMantissa(t *testing.T) {
	// nBits with bit 23 set indicates negative mantissa, which is invalid.
	badNBits := uint32(0x1d800000)
	if _, err := TargetFromNBits(badNBits); err == nil {
		t.Errorf("TargetFromNBits(0x%08X) accepted negative mantissa", badNBits)
	}
}

func TestTargetFromNBits_RejectsSmallExponent(t *testing.T) {
	// Exponent < 3 is not representable in Bitcoin's target format.
	badNBits := uint32(0x01123456)
	if _, err := TargetFromNBits(badNBits); err == nil {
		t.Errorf("TargetFromNBits(0x%08X) accepted exponent < 3", badNBits)
	}
}

// ----- Hash comparison -----

func TestHash_LessOrEqual(t *testing.T) {
	var zero Hash
	var ones Hash
	for i := range ones {
		ones[i] = 0xFF
	}
	var mid Hash
	mid[31] = 0x80 // only the lowest byte (big-endian LSB) is set

	if !zero.LessOrEqual(zero) {
		t.Error("zero should be <= zero")
	}
	if !zero.LessOrEqual(ones) {
		t.Error("zero should be <= ones")
	}
	if ones.LessOrEqual(zero) {
		t.Error("ones should NOT be <= zero")
	}
	if !mid.LessOrEqual(ones) {
		t.Error("mid should be <= ones")
	}
	if mid.LessOrEqual(zero) {
		t.Error("mid should NOT be <= zero (mid > zero)")
	}
}

// ----- MeetsTarget -----

func TestMeetsTarget_VeryEasyTarget(t *testing.T) {
	// nBits 0x207fffff is the maximum (easiest) target.
	// Almost any hash should meet it.
	var almostMaxHash Hash
	for i := range almostMaxHash {
		almostMaxHash[i] = 0x01 // very low hash value
	}
	meets, err := MeetsTarget(almostMaxHash, 0x207fffff)
	if err != nil {
		t.Fatalf("MeetsTarget: %v", err)
	}
	if !meets {
		t.Error("low hash should meet the easiest (max) target 0x207fffff")
	}
}

func TestMeetsTarget_HashTooHigh(t *testing.T) {
	// A hash of all-0xFF should not meet any realistic target.
	var maxHash Hash
	for i := range maxHash {
		maxHash[i] = 0xFF
	}
	meets, err := MeetsTarget(maxHash, 0x17130000)
	if err != nil {
		t.Fatalf("MeetsTarget: %v", err)
	}
	if meets {
		t.Error("all-FF hash should not meet high difficulty target")
	}
}

// ----- Benchmarks -----

func BenchmarkHashHeader(b *testing.B) {
	h := Header{Version: 1, Time: 0x60000000, Bits: 0x1d00ffff, Nonce: 0}
	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		h.Nonce = uint32(i)
		_ = HashHeader(h)
	}
}

func BenchmarkSHA256d(b *testing.B) {
	data := make([]byte, 80)
	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = SHA256d(data)
	}
}
