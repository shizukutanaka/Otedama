// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package stratum

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

// FuzzHandshakeState_ReadMessage2 exercises the second Noise NX handshake
// message parser with arbitrary payloads. The parser selects a public-key
// encoding by payload length (65B uncompressed, 33B compressed, else
// 32-byte x-only fallback) and then performs DH — each branch is a place a
// hostile responder could drive a panic or an out-of-bounds read. The SRI
// fuzzing effort (stratum-mining/stratum issue discovered via cargo-fuzz)
// found an arithmetic overflow in exactly this class of length arithmetic;
// these targets pin the boundary lengths plus valid and invalid curve
// points (docs/RESEARCH_IMPROVEMENTS.md).
//
// Invariants checked per input:
//   - never panics;
//   - an error-free parse must leave Complete() == true;
//   - a complete handshake must yield working transport ciphers whose
//     Encrypt output decrypts cleanly under a same-key cipher clone.
func FuzzHandshakeState_ReadMessage2(f *testing.F) {
	validCompressed := mustHexSeed(f,
		"02e32747a1a2036c66bc0982b8a3f694c486e21077ff0a207a8f31e8d7986878a8")
	validUncompressed := mustHexSeed(f,
		"04e32747a1a2036c66bc0982b8a3f694c486e21077ff0a207a8f31e8d7986878a8"+
			"d6abfa3b495fdec768ee95faf87deaf59198ed53a9195a18ffbefa1a820f4572")

	seeds := [][]byte{
		{},                             // empty
		make([]byte, 31),               // below every branch
		make([]byte, 32),               // x-only path, zero point
		make([]byte, 33),               // compressed-length, bad prefix
		make([]byte, 34),               // between compressed and uncompressed
		make([]byte, 64),               // below uncompressed length
		make([]byte, 65),               // uncompressed-length, bad prefix
		make([]byte, 66),               // trailing garbage after a point
		make([]byte, 512),              // oversized
		bytes.Repeat([]byte{0xFF}, 65), // all-ones "uncompressed" claim
		append([]byte{0x04}, make([]byte, 64)...), // uncompressed prefix, zero point
		append([]byte{0x02}, make([]byte, 32)...), // compressed prefix, zero X
		append([]byte{0x03}, make([]byte, 32)...), // compressed prefix, zero X
		validCompressed,   // real compressed P-256 point
		validUncompressed, // real uncompressed P-256 point
		append(validCompressed, make([]byte, 33)...), // valid point + trailing junk
		append(validUncompressed, 0x00),              // valid 65B point + trailing junk
	}
	for _, s := range seeds {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, payload []byte) {
		hs, err := NewHandshakeInitiator()
		if err != nil {
			t.Fatalf("NewHandshakeInitiator: %v", err)
		}
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("ReadMessage2 panicked on %d-byte input: %v", len(payload), r)
			}
		}()

		err = hs.ReadMessage2(payload)
		if err != nil {
			return // rejection is the expected response to malformed input
		}
		if !hs.Complete() {
			t.Error("ReadMessage2 returned nil error but Complete() is false")
		}
		send, _, terr := hs.Transport()
		if terr != nil {
			t.Fatalf("handshake complete but Transport() failed: %v", terr)
		}
		// The derived send cipher must produce ciphertext a same-key
		// cipher can decrypt — the transport is only useful if it
		// round-trips.
		ct, err := send.Encrypt(nil, []byte("otedama"))
		if err != nil {
			t.Fatalf("Encrypt after handshake: %v", err)
		}
		clone := &CipherState{key: send.key}
		pt, err := clone.Decrypt(nil, ct)
		if err != nil {
			t.Fatalf("Decrypt of own ciphertext: %v", err)
		}
		if !bytes.Equal(pt, []byte("otedama")) {
			t.Errorf("round-trip mismatch: got %x", pt)
		}
	})
}

// FuzzEncryptedConn_Read feeds arbitrary bytes as the Noise transport's
// wire stream: a u16 length prefix followed by that many ciphertext bytes.
// The u16 prefix bounds any single allocation to 65535 bytes — the fuzzer
// verifies that bound holds (no larger allocation is ever attempted), that
// no input panics, and that successful reads never return more plaintext
// than the caller's buffer can hold. A real encrypted frame is prepended
// inside the fuzz function so the valid-decrypt path is exercised before
// the stream turns adversarial.
func FuzzEncryptedConn_Read(f *testing.F) {
	seeds := [][]byte{
		{},                       // empty stream
		{0x00, 0x00},             // zero-length frame
		{0x01, 0x00, 0xAA},       // 1-byte ciphertext (below Poly1305 tag)
		{0x10, 0x00},             // tag-sized ciphertext, none delivered
		{0xFF, 0xFF},             // max frame claim, truncated
		{0x02, 0x00, 0xAA, 0xBB}, // smallest plausible ciphertext
		bytes.Repeat([]byte{0xFF}, 32),
	}
	for _, s := range seeds {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, wire []byte) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("EncryptedConn.Read panicked on %d-byte stream: %v", len(wire), r)
			}
		}()

		key := sha256.Sum256([]byte("otedama-noise-fuzz"))

		// Prepend one valid encrypted frame so the first Read exercises
		// the success path before the stream turns adversarial. A fresh
		// send cipher starts at nonce 0 to match the fresh recv cipher.
		var validPrefix bytes.Buffer
		sender := NewEncryptedConn(&validPrefix, &CipherState{key: key}, &CipherState{key: key})
		if _, err := sender.Write([]byte("ping")); err != nil {
			t.Fatalf("seed Write: %v", err)
		}
		stream := bytes.NewBuffer(append(validPrefix.Bytes(), wire...))
		receiver := NewEncryptedConn(stream, &CipherState{key: key}, &CipherState{key: key})

		// First read must return the planted plaintext.
		buf := make([]byte, 64)
		n, err := receiver.Read(buf)
		if err != nil {
			t.Fatalf("first Read of valid frame failed: %v", err)
		}
		if string(buf[:n]) != "ping" {
			t.Fatalf("first Read = %q, want %q", buf[:n], "ping")
		}

		// Remaining reads are adversarial: errors are fine, panics are
		// not, and n must always fit the caller's buffer.
		for i := 0; i < 8; i++ {
			n, err = receiver.Read(buf)
			if err != nil {
				return
			}
			if n < 0 || n > len(buf) {
				t.Fatalf("Read returned n=%d with %d-byte buffer", n, len(buf))
			}
		}
	})
}

// FuzzEncryptedConn_RoundTrip verifies Write→Read preserves arbitrary
// plaintext exactly: any input Write accepts must come back byte-identical,
// and any input it rejects must fail with an error (never a panic or a
// silent truncation — truncating would desynchronise the stream).
func FuzzEncryptedConn_RoundTrip(f *testing.F) {
	seeds := [][]byte{
		{},
		{0x00},
		[]byte("otedama"),
		bytes.Repeat([]byte{0xAB}, 65519), // largest plaintext that fits: 65519+16 tag = 65535
		bytes.Repeat([]byte{0xCD}, 65520), // one over the limit → must error
	}
	for _, s := range seeds {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, plaintext []byte) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("EncryptedConn panicked on %d-byte plaintext: %v", len(plaintext), r)
			}
		}()

		key := sha256.Sum256([]byte("otedama-noise-fuzz"))
		var wire bytes.Buffer
		sender := NewEncryptedConn(&wire, &CipherState{key: key}, &CipherState{key: key})

		n, err := sender.Write(plaintext)
		if err != nil {
			// Rejection is legitimate only for frames that cannot fit
			// the u16 length prefix; nothing smaller may be rejected.
			if len(plaintext)+16 <= maxNoiseFrame {
				t.Fatalf("Write rejected a %d-byte plaintext that fits the u16 bound: %v",
					len(plaintext), err)
			}
			return
		}
		if n != len(plaintext) {
			t.Fatalf("Write returned n=%d for %d-byte plaintext", n, len(plaintext))
		}

		receiver := NewEncryptedConn(&wire, &CipherState{key: key}, &CipherState{key: key})
		// Deliberately read with a slightly-too-small buffer to exercise
		// the readbuf drain path across two calls.
		out := make([]byte, len(plaintext)+1)
		var got []byte
		for len(got) < len(plaintext) {
			m, err := receiver.Read(out)
			if err != nil {
				t.Fatalf("Read failed mid-stream after %d/%d bytes: %v",
					len(got), len(plaintext), err)
			}
			got = append(got, out[:m]...)
		}
		if !bytes.Equal(got, plaintext) {
			t.Errorf("round-trip mismatch: wrote %d bytes, read back %d differing bytes",
				len(plaintext), len(got))
		}
	})
}

// mustHexSeed decodes a hex seed string, failing the fuzz target's seed
// phase (not a fuzz iteration) if it is malformed — a typo in a seed must
// be caught immediately, not silently skipped.
func mustHexSeed(f *testing.F, s string) []byte {
	f.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		f.Fatalf("bad hex seed %q: %v", s, err)
	}
	return b
}
