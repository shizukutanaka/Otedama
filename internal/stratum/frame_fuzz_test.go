// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package stratum

import (
	"bytes"
	"testing"
)

// FuzzDecodeHeader exercises the 6-byte Stratum V2 header decoder with
// arbitrary bytes to ensure it never panics regardless of input.
//
// # Corpus strategy
//
// The seed corpus includes:
//   - Valid headers of each message type
//   - Zero header (all zeros)
//   - Maximum-sized header (all 0xFF bytes)
//   - Headers with the channel-msg flag set
//   - Headers claiming oversized payloads (above MaxMessageLength)
//
// Go's native fuzzing then mutates these systematically. Any input that
// causes a panic, a read past the buffer, or a hang is a bug.
func FuzzDecodeHeader(f *testing.F) {
	// Seed corpus.
	seeds := [][]byte{
		// Valid SetupConnection header.
		{0x00, 0x00, 0x00, 0x00, 0x00, 0x00},
		// Channel message flag set.
		{0x01, 0x20, 0x10, 0x00, 0x00, 0x80},
		// All zeros.
		{0, 0, 0, 0, 0, 0},
		// All ones.
		{0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF},
		// Truncated (fewer than 6 bytes).
		{0x01, 0x02, 0x03},
		// Oversized length claim.
		{0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF},
	}
	for _, s := range seeds {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) < 6 {
			return
		}
		// Decode must never panic. An error return is fine.
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("DecodeHeader panicked on input %x: %v", data, r)
			}
		}()

		h, err := DecodeHeader(data[:6])
		if err != nil {
			// Errors are the expected response to malformed inputs.
			return
		}

		// Invariants that must hold for any successfully decoded header.
		if h.MsgLength > MaxMessageLength {
			t.Errorf("decoded MsgLength %d exceeds MaxMessageLength %d",
				h.MsgLength, MaxMessageLength)
		}
		// Round-trip: encoding the decoded header should yield the
		// original bytes (or at least decode to the same header again).
		var buf [6]byte
		if err := EncodeHeader(buf[:], h); err == nil {
			h2, err := DecodeHeader(buf[:])
			if err != nil {
				t.Errorf("re-decode of encoded header failed: %v", err)
			}
			if h2 != h {
				t.Errorf("round-trip changed header: %+v → %+v", h, h2)
			}
		}
	})
}

// FuzzDecoder_ReadFrame tests the streaming frame decoder with arbitrary
// network data. Must never panic, leak goroutines, or allocate unbounded
// memory.
func FuzzDecoder_ReadFrame(f *testing.F) {
	seeds := [][]byte{
		// Valid empty frame.
		{0x00, 0x00, 0x00, 0x00, 0x00, 0x00},
		// Frame claiming a 1-byte payload, followed by 1 byte.
		{0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0xAA},
		// Two back-to-back frames.
		{
			0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
			0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		},
		// Frame claiming huge payload; truncated before payload delivered.
		{0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF},
		// Boundary: MsgLength == DefaultMaxFrameSize (16 MiB). Accepted at
		// the header layer; the read then fails on the missing payload.
		{0x00, 0x00, 0x00, 0x00, 0x00, 0x01},
		// Boundary: MsgLength == DefaultMaxFrameSize + 1. Must be rejected
		// outright — one byte past the cap is where off-by-one bugs live.
		{0x00, 0x00, 0x00, 0x01, 0x00, 0x01},
		// Garbage.
		{0xDE, 0xAD, 0xBE, 0xEF},
	}
	for _, s := range seeds {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, data []byte) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("ReadFrame panicked on input %x: %v", data, r)
			}
		}()

		dec := NewDecoder(bytes.NewReader(data))
		// Read frames until error. At most 100 iterations to guard
		// against pathological infinite loops.
		for i := 0; i < 100; i++ {
			frame, err := dec.ReadFrame()
			if err != nil {
				return
			}
			if uint64(frame.Header.MsgLength) > uint64(DefaultMaxFrameSize) {
				t.Errorf("accepted frame with MsgLength %d > DefaultMaxFrameSize %d",
					frame.Header.MsgLength, DefaultMaxFrameSize)
				return
			}
			if len(frame.Payload) != int(frame.Header.MsgLength) {
				t.Errorf("payload length mismatch: header says %d, have %d",
					frame.Header.MsgLength, len(frame.Payload))
				return
			}
		}
	})
}

// FuzzEncryptedConn_Read feeds arbitrary bytes into the Noise transport
// reader: random 2-byte length prefixes plus random ciphertext. Must
// never panic and never return plaintext for an unauthenticated frame —
// every forged ciphertext must fail Poly1305 verification with an error.
// A real Noise peer can only send frames this connection encrypted, so
// the failure mode being exercised is the corrupted/MitM stream, the
// same class the SRI fuzzers target on their framing layer.
func FuzzEncryptedConn_Read(f *testing.F) {
	seeds := [][]byte{
		// Zero-length frame (ctLen=0): decrypt must fail (no tag).
		{0x00, 0x00},
		// ctLen=1..16: all too short to carry a Poly1305 tag.
		{0x01, 0x00, 0xAA},
		{
			0x10, 0x00, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00, 0x11,
			0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99,
		},
		// ctLen=17: smallest structurally possible frame (1B pt + 16B tag)
		// with garbage contents — must fail auth.
		{
			0x11, 0x00, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00, 0x11,
			0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0x00,
		},
		// ctLen=0xFFFF: maximum claim, truncated body.
		{0xFF, 0xFF, 0xAA, 0xBB},
		// Two frames back to back: first fails auth, read must stop there.
		{
			0x11, 0x00, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00, 0x11,
			0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0x00,
			0x11, 0x00, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00, 0x11,
			0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0x00,
		},
	}
	for _, s := range seeds {
		f.Add(s)
	}

	var recvKey [32]byte
	for i := range recvKey {
		recvKey[i] = byte(i)
	}

	f.Fuzz(func(t *testing.T, data []byte) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("EncryptedConn.Read panicked on input %x: %v", data, r)
			}
		}()

		ec := NewEncryptedConn(bytes.NewBuffer(data), nil, &CipherState{key: recvKey})
		buf := make([]byte, 8) // small reader buffer exercises readbuf draining
		for i := 0; i < 100; i++ {
			if _, err := ec.Read(buf); err != nil {
				return // auth failure or EOF — the expected outcomes
			}
		}
	})
}

// FuzzHandshake_ReadMessage2 feeds arbitrary responder payloads into the
// Noise NX message-2 parser, covering the 65-byte uncompressed, 33-byte
// compressed, and 32-byte x-only public-key branches. Must never panic;
// when it succeeds the handshake must be complete and Transport() must
// yield cipher states.
func FuzzHandshake_ReadMessage2(f *testing.F) {
	seeds := [][]byte{
		{},               // empty
		{0x00},           // 1 byte
		make([]byte, 32), // x-only path, all zeros
		append([]byte{0x02}, make([]byte, 32)...), // 33B compressed candidate
		append([]byte{0x04}, make([]byte, 64)...), // 65B uncompressed candidate
		bytes.Repeat([]byte{0xFF}, 100),           // overlong, no valid key
	}
	for _, s := range seeds {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, data []byte) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("ReadMessage2 panicked on input %x: %v", data, r)
			}
		}()

		hs, err := NewHandshakeInitiator()
		if err != nil {
			t.Fatalf("NewHandshakeInitiator: %v", err)
		}
		if _, err := hs.WriteMessage1(); err != nil {
			t.Fatalf("WriteMessage1: %v", err)
		}
		if err := hs.ReadMessage2(data); err != nil {
			return // malformed responder message — the expected outcome
		}
		if !hs.Complete() {
			t.Error("ReadMessage2 succeeded but handshake not complete")
		}
		if _, _, err := hs.Transport(); err != nil {
			t.Errorf("ReadMessage2 succeeded but Transport() failed: %v", err)
		}
	})
}
