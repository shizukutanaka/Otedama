// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package stratum

import (
	"bytes"
	"testing"
)

// readOnly adapts a bytes.Reader to io.ReadWriter for NewEncryptedConn;
// Write is never exercised by the Read path under test.
type readOnly struct{ *bytes.Reader }

func (readOnly) Write(p []byte) (int, error) { return len(p), nil }

// FuzzEncryptedConn_Read exercises the Noise transport's u16 length-prefix
// path with arbitrary wire bytes — the same surface as the SRI noise_sv2
// length-field overflow lesson (docs/RESEARCH_IMPROVEMENTS.md). The prefix
// is a u16, so the allocation is inherently bounded at 65535 bytes; the
// fuzz invariants are that Read never panics, never returns more than the
// caller's buffer holds, and survives a mutated/corrupt ciphertext with a
// plain authentication error rather than a state-corrupting path.
//
// The seed corpus pairs valid frames (encrypted with a known key so the
// decrypt and readbuf-drain path is exercised, not only the error path)
// with boundary length prefixes: 0, 1, tag-only (16), maxNoiseFrame, and
// prefixes claiming more bytes than the wire supplies.
func FuzzEncryptedConn_Read(f *testing.F) {
	key := [32]byte{0x42}
	// A valid frame for a known key: u16 length prefix + ciphertext of
	// "ping" under the recv cipher's first nonce. Mutations from this seed
	// explore the successful-decrypt path and its neighbors.
	valid := func() []byte {
		cs := &CipherState{key: key}
		ct, err := cs.Encrypt(nil, []byte("ping"))
		if err != nil {
			f.Fatalf("seed encrypt: %v", err)
		}
		out := []byte{byte(len(ct)), byte(len(ct) >> 8)}
		return append(out, ct...)
	}()

	seeds := [][]byte{
		valid,
		{0x00, 0x00},             // zero-length frame → decrypt fails on empty ct
		{0x01, 0x00, 0xAA},       // 1-byte ct → too short for the tag, fails
		{0x10, 0x00},             // claims tag-sized ct but supplies nothing
		{0xFF, 0xFF},             // maxNoiseFrame claim, no bytes behind it
		{0x14, 0x00},             // valid-sized claim (4+tag) but absent body
		{0xDE, 0xAD, 0xBE, 0xEF}, // garbage
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

		conn := NewEncryptedConn(readOnly{bytes.NewReader(data)}, &CipherState{key: key}, &CipherState{key: key})

		// Read with a small buffer so a successfully-decrypted frame also
		// exercises the readbuf drain loop. Two reads cover frame 1 + its
		// retained remainder or the start of a second frame.
		buf := make([]byte, 8)
		for i := 0; i < 2; i++ {
			n, err := conn.Read(buf)
			if err != nil {
				return
			}
			if n < 0 || n > len(buf) {
				t.Fatalf("Read returned %d for a %d-byte buffer", n, len(buf))
			}
		}
	})
}

// FuzzEncryptedConn_Write exercises the Write path's length check with
// arbitrary plaintext sizes. The fuzzer cannot realistically reach the
// 65535-byte overflow boundary through random mutation — that boundary is
// covered by TestEncryptedConn_Write_PayloadExceedsMaxFrame — so this
// target only asserts the always-true invariants: never panic, and on
// success the returned count equals the plaintext length.
func FuzzEncryptedConn_Write(f *testing.F) {
	key := [32]byte{0x42}
	seeds := [][]byte{
		{},
		{0x00},
		bytes.Repeat([]byte{0xAA}, 65519), // largest plaintext that fits (65519+16 = 65535)
	}
	for _, s := range seeds {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, data []byte) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("EncryptedConn.Write panicked on %d bytes: %v", len(data), r)
			}
		}()

		var sink bytes.Buffer
		conn := NewEncryptedConn(&sink, &CipherState{key: key}, &CipherState{key: key})
		n, err := conn.Write(data)
		if err != nil {
			if len(data)+16 <= maxNoiseFrame {
				t.Fatalf("Write failed on a %d-byte payload that fits the u16 prefix: %v", len(data), err)
			}
			return
		}
		if n != len(data) {
			t.Fatalf("Write returned n=%d for %d input bytes", n, len(data))
		}
		// On success the wire must hold prefix(2) + plaintext + tag(16).
		if want := 2 + len(data) + 16; sink.Len() != want {
			t.Fatalf("wrote %d wire bytes, want %d", sink.Len(), want)
		}
	})
}
