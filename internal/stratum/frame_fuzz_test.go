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

// fuzzReadOnlyRW adapts a *bytes.Reader to the io.ReadWriter that
// NewEncryptedConn requires; writes are discarded (the fuzz only
// exercises Read).
type fuzzReadOnlyRW struct{ *bytes.Reader }

func (fuzzReadOnlyRW) Write(p []byte) (int, error) { return len(p), nil }

// FuzzEncryptedConn_Read drives the Noise transport read path with
// arbitrary bytes. The u16 length prefix is inherently bounded (so no
// huge allocation is possible), but the read loop must still never
// panic on truncated prefixes, short ciphertexts, or AEAD rejections —
// the arithmetic-overflow class the SRI grant found in noise_sv2.
// A failed decrypt leaves the conn in a defined error state; each Read
// returns an error rather than looping forever on partial input.
func FuzzEncryptedConn_Read(f *testing.F) {
	seeds := [][]byte{
		// Empty input — immediate EOF on the length prefix.
		{},
		// Truncated prefix.
		{0x05},
		// Prefix claims 5 bytes of ciphertext, only 3 follow.
		{0x05, 0x00, 0xAA, 0xBB, 0xCC},
		// Maximum u16 claim with no ciphertext.
		{0xFF, 0xFF},
		// All zeros — a 0-length transport message (AEAD reject: tag only).
		{0x00, 0x00},
		// Random garbage with several plausible prefixes.
		{0x10, 0x00, 0xDE, 0xAD, 0xBE, 0xEF, 0x02, 0x00, 0x42},
	}
	for _, s := range seeds {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, data []byte) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("EncryptedConn.Read panicked on input %x: %v", data, r)
			}
		}()

		var key [32]byte
		conn := NewEncryptedConn(
			fuzzReadOnlyRW{Reader: bytes.NewReader(data)},
			&CipherState{key: key},
			&CipherState{key: key},
		)
		buf := make([]byte, 64)
		// Errors are expected (truncated or undecryptable input); only
		// panics, hangs, or reads beyond the input would be bugs. Cap
		// iterations so a hypothetical non-advancing loop shows up.
		for i := 0; i < 100; i++ {
			if _, err := conn.Read(buf); err != nil {
				return
			}
		}
	})
}
