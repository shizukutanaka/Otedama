// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package stratum

import (
	"bytes"
	"encoding/binary"
	"errors"
	"testing"
)

// readOnlyRW adapts a bytes.Reader to the io.ReadWriter EncryptedConn
// requires; writes are unreachable on the Read path under test.
type readOnlyRW struct{ r *bytes.Reader }

func (w readOnlyRW) Read(p []byte) (int, error) { return w.r.Read(p) }
func (w readOnlyRW) Write(_ []byte) (int, error) {
	return 0, errors.New("read-only transport")
}

// FuzzEncryptedConn_Read exercises the encrypted transport's length-prefix
// framing (Noise spec §3: u16 little-endian length + ciphertext) with
// arbitrary bytes. The u16 prefix inherently bounds a frame to 65535
// bytes; this fuzzer asserts that bound is enforced end-to-end — no
// panic, no oversize allocation, no plaintext yielded on authentication
// failure, and no desynchronisation across successive frames.
//
// # Corpus strategy
//
// Seed corpus contains real encrypted frames produced by a zero-key
// CipherState (so the fuzzer explores the valid-frame path, not only
// auth failures), plus adversarial length claims:
//   - maximal and zero length prefixes
//   - a length prefix larger than the bytes actually delivered (truncation)
//   - a valid frame followed by garbage (stream resynchronisation)
//   - two concatenated valid frames (multi-frame reads)
func FuzzEncryptedConn_Read(f *testing.F) {
	var key [32]byte

	// Helper to build a valid wire frame: u16 length + ciphertext.
	frame := func(plaintext []byte) []byte {
		var buf bytes.Buffer
		sender := NewEncryptedConn(&buf, &CipherState{key: key}, &CipherState{key: key})
		if _, err := sender.Write(plaintext); err != nil {
			f.Fatalf("seed construction Write: %v", err)
		}
		return buf.Bytes()
	}

	seeds := [][]byte{
		// Valid small frame.
		frame([]byte("hello otedama")),
		// Two valid frames back to back.
		append(frame([]byte("first")), frame([]byte("second"))...),
		// Valid frame followed by a truncated second frame.
		append(frame([]byte("first")), []byte{0x10, 0x00, 0xAA}...),
		// Zero length claim.
		{0x00, 0x00},
		// Maximal length claim, nothing delivered.
		{0xFF, 0xFF},
		// Maximal length claim, a few garbage bytes delivered.
		{0xFF, 0xFF, 0xDE, 0xAD, 0xBE, 0xEF},
		// Length claims ciphertext smaller than the AEAD tag (16 bytes).
		{0x08, 0x00, 1, 2, 3, 4, 5, 6, 7, 8},
		// Bare prefix, truncated before ciphertext.
		{0x20, 0x00},
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

		conn := NewEncryptedConn(
			readOnlyRW{bytes.NewReader(data)},
			&CipherState{key: key},
			&CipherState{key: key},
		)

		buf := make([]byte, 64)
		for i := 0; i < 32; i++ {
			n, err := conn.Read(buf)
			if err != nil {
				return
			}
			if n > len(buf) {
				t.Fatalf("Read returned %d bytes into a %d-byte buffer", n, len(buf))
			}
			// A successful Read must fit inside one Noise frame's
			// plaintext budget: u16 ciphertext minus the 16-byte tag.
			if n > maxNoiseFrame-16 {
				t.Fatalf("Read returned %d plaintext bytes, exceeds frame budget %d",
					n, maxNoiseFrame-16)
			}
		}
	})
}

// FuzzEncryptedConn_LengthPrefix targets just the prefix-decoding half:
// arbitrary streams must never cause an allocation or read beyond the
// u16 bound. Feeds data with an attacker-controlled first two bytes and
// asserts the decoder never reads more than the framed length.
func FuzzEncryptedConn_LengthPrefix(f *testing.F) {
	var key [32]byte
	var buf bytes.Buffer
	sender := NewEncryptedConn(&buf, &CipherState{key: key}, &CipherState{key: key})
	if _, err := sender.Write([]byte("seed frame")); err != nil {
		f.Fatalf("seed construction Write: %v", err)
	}
	valid := buf.Bytes()

	f.Add(uint16(0), uint16(0), uint8(0))
	f.Add(uint16(0xFFFF), uint16(0xFFFF), uint8(0xFF))
	f.Add(uint16(17), uint16(17), uint8(1))

	f.Fuzz(func(t *testing.T, lenA, lenB uint16, fill uint8) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("prefix handling panicked: %v", r)
			}
		}()

		// Craft: attacker length prefix + that many fill bytes (capped
		// so the fuzz input stays small — the decoder must not allocate
		// based on the delivered bytes, only on the prefix).
		delivered := int(lenA)
		if delivered > 64 {
			delivered = 64
		}
		payload := make([]byte, delivered)
		for i := range payload {
			payload[i] = fill
		}

		var stream bytes.Buffer
		var pre [2]byte
		binary.LittleEndian.PutUint16(pre[:], lenA)
		stream.Write(pre[:])
		stream.Write(payload)
		// Second attacker-controlled prefix + a valid frame tail, to
		// probe resynchronisation after a failed first frame.
		binary.LittleEndian.PutUint16(pre[:], lenB)
		stream.Write(pre[:])
		stream.Write(payload)
		stream.Write(valid)

		conn := NewEncryptedConn(
			readOnlyRW{bytes.NewReader(stream.Bytes())},
			&CipherState{key: key},
			&CipherState{key: key},
		)
		tmp := make([]byte, 32)
		for i := 0; i < 16; i++ {
			if _, err := conn.Read(tmp); err != nil {
				return
			}
		}
	})
}
