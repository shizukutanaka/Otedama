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
