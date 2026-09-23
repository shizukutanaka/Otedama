// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package stratum

import (
	"bytes"
	"testing"
)

// FuzzEncryptedConnRead exercises the Noise transport read path with
// arbitrary wire bytes: a length-prefixed ciphertext stream controlled
// by a hostile peer must never panic the decoder, never allocate beyond
// the u16-bounded frame size (≤ 65535), and never desynchronise into a
// hang. Decrypt errors are the expected outcome for garbage input.
//
// Motivation: upstream Stratum (SRI) fuzz coverage over noise_sv2
// surfaced length-prefix overflow bugs (docs/RESEARCH_IMPROVEMENTS.md,
// June-2026 session-52 item 1) — the class of bug where a u16/u32
// length field is trusted before being bounds-checked.
//
// # Corpus strategy
//
// Seeds cover empty input, truncated length prefixes, zero-length and
// maximum-length frames, and a validly-framed but inauthentic
// ciphertext (tag will not verify).
func FuzzEncryptedConnRead(f *testing.F) {
	var validFrame bytes.Buffer
	// A frame whose u16 length prefix claims 32 bytes of ciphertext.
	validFrame.Write([]byte{0x20, 0x00})
	validFrame.Write(bytes.Repeat([]byte{0x42}, 32))
	// A maximum-length claim (65535) with a truncated body.
	var maxFrame bytes.Buffer
	maxFrame.Write([]byte{0xFF, 0xFF})
	maxFrame.Write(bytes.Repeat([]byte{0x07}, 64))

	seeds := [][]byte{
		{},
		{0x00},       // truncated length prefix
		{0x00, 0x00}, // zero-length frame
		{0x10, 0x00}, // 16-byte claim, no body
		validFrame.Bytes(),
		maxFrame.Bytes(),
		{0xFF, 0xFF}, // max claim, no body at all
	}
	for _, s := range seeds {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, data []byte) {
		key := [32]byte{0x11}
		cipher := &CipherState{key: key}
		// The read path never writes; wrap the input so EncryptedConn's
		// io.ReadWriter requirement is met by a discard sink.
		conn := NewEncryptedConn(readOnly{bytes.NewReader(data)}, cipher, cipher)

		// Read must never panic and must terminate.
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("EncryptedConn.Read panicked on %d input bytes: %v", len(data), r)
			}
		}()

		buf := make([]byte, 4096)
		for i := 0; i < 64; i++ {
			n, err := conn.Read(buf)
			if err != nil {
				return
			}
			if n < 0 || n > len(buf) {
				t.Fatalf("Read returned out-of-range n=%d", n)
			}
			if n == 0 {
				return
			}
		}
	})
}

// TestEncryptedConn_ReadTruncatedLengthPrefix pins the regression the
// fuzzer targets: a stream ending mid-prefix must surface an io error,
// not a panic.
func TestEncryptedConn_ReadTruncatedLengthPrefix(t *testing.T) {
	key := [32]byte{0x22}
	cipher := &CipherState{key: key}
	conn := NewEncryptedConn(readOnly{bytes.NewReader([]byte{0x05})}, cipher, cipher)
	if _, err := conn.Read(make([]byte, 16)); err == nil {
		t.Error("expected error on truncated length prefix")
	}
}

// readOnly adapts an io.Reader to io.ReadWriter for the fuzz harness;
// its Write is never exercised by the read path.
type readOnly struct{ *bytes.Reader }

func (readOnly) Write(p []byte) (int, error) { return len(p), nil }
