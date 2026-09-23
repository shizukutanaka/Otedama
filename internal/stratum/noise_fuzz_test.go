// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package stratum

import (
	"bytes"
	"encoding/binary"
	"testing"
)

// FuzzEncryptedConn_Read exercises the Noise transport framing — the
// u16 length prefix and the ciphertext it claims — with arbitrary bytes.
// This is the surface analogous to the noise_sv2 arithmetic overflow SRI
// found via continuous fuzzing: a malformed length must never panic the
// reader, trigger an out-of-bounds access, or grow internal buffering
// beyond one frame.
func FuzzEncryptedConn_Read(f *testing.F) {
	var key [32]byte

	// Runtime-generated seed: two valid encrypted frames back to back,
	// so the corpus reaches the decrypt-success path too.
	var valid bytes.Buffer
	sender := NewEncryptedConn(&valid, &CipherState{key: key}, &CipherState{key: key})
	if _, err := sender.Write([]byte("seed frame one")); err != nil {
		f.Fatalf("seed setup: %v", err)
	}
	if _, err := sender.Write([]byte("seed frame two")); err != nil {
		f.Fatalf("seed setup: %v", err)
	}
	validFrames := valid.Bytes()

	seeds := [][]byte{
		// Two valid frames back to back.
		validFrames,
		// Valid frame followed by garbage.
		append(append([]byte{}, validFrames...), 0xDE, 0xAD, 0xBE, 0xEF),
		// Length prefix claims 0 bytes of ciphertext.
		{0x00, 0x00},
		// Length prefix claims 8 bytes (< tag size 16), body present.
		{0x08, 0x00, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x11},
		// Length prefix claims the u16 maximum; body truncated at 4 bytes.
		{0xFF, 0xFF, 0x01, 0x02, 0x03, 0x04},
		// Length prefix claims maxNoiseFrame-16, body truncated.
		{0xEF, 0xFF, 0x99},
		// Empty stream.
		{},
		// Truncated mid-length-prefix (single byte).
		{0x42},
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

		cs := &CipherState{key: key}
		conn := NewEncryptedConn(bytes.NewBuffer(data), cs, cs)

		buf := make([]byte, 4096)
		for i := 0; i < 100; i++ {
			n, err := conn.Read(buf)
			if err != nil {
				return
			}
			if n > len(buf) {
				t.Fatalf("Read returned n=%d > buffer size %d", n, len(buf))
			}
			// A single Noise frame carries at most maxNoiseFrame-16 bytes
			// of plaintext, so retained plaintext can never exceed that.
			if len(conn.readbuf) > maxNoiseFrame-16 {
				t.Fatalf("readbuf retained %d bytes > maxNoiseFrame-16=%d",
					len(conn.readbuf), maxNoiseFrame-16)
			}
		}
	})
}

// FuzzEncryptedConn_Read_LengthPrefixArithmetic feeds the decoder a stream
// shaped as an attacker-chosen u16 length prefix followed by arbitrary
// body bytes, so the fuzzer explores the boundary where the declared
// ciphertext length meets (or doesn't meet) the bytes actually on the
// wire. Asserts no panic and no partial-frame plaintext leak.
func FuzzEncryptedConn_Read_LengthPrefixArithmetic(f *testing.F) {
	f.Add(uint16(0), []byte{})
	f.Add(uint16(1), []byte{0x00})
	f.Add(uint16(15), []byte{0xAA, 0xBB})
	f.Add(uint16(16), []byte{0xAA, 0xBB})
	f.Add(uint16(17), []byte{0xAA, 0xBB})
	f.Add(uint16(65519), []byte{})
	f.Add(uint16(65535), []byte{0xDE, 0xAD})

	f.Fuzz(func(t *testing.T, claimed uint16, body []byte) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panicked: claimed=%d body=%d bytes: %v", claimed, len(body), r)
			}
		}()

		var stream bytes.Buffer
		var lenBuf [2]byte
		binary.LittleEndian.PutUint16(lenBuf[:], claimed)
		stream.Write(lenBuf[:])
		stream.Write(body)

		var key [32]byte
		cs := &CipherState{key: key}
		conn := NewEncryptedConn(&stream, cs, cs)

		buf := make([]byte, 1024)
		for i := 0; i < 10; i++ {
			if _, err := conn.Read(buf); err != nil {
				return
			}
			if len(conn.readbuf) > maxNoiseFrame-16 {
				t.Fatalf("readbuf over one frame: %d bytes", len(conn.readbuf))
			}
		}
	})
}
