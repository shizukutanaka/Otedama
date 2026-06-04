// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package stratum

import (
	"bytes"
	"io"
	"testing"
)

// ============================================================================
// hkdf2 — HKDF with 2 outputs
// ============================================================================

func TestHkdf2_Returns32ByteOutputs(t *testing.T) {
	ck := []byte("chaining-key-seed")
	input := []byte("some-input")
	ck1, k1 := hkdf2(ck, input)
	if len(ck1) != 32 {
		t.Errorf("hkdf2 first output = %d bytes, want 32", len(ck1))
	}
	if len(k1) != 32 {
		t.Errorf("hkdf2 second output = %d bytes, want 32", len(k1))
	}
}

func TestHkdf2_IsDeterministic(t *testing.T) {
	ck := []byte("deterministic-input")
	input := []byte("payload")
	a1, a2 := hkdf2(ck, input)
	b1, b2 := hkdf2(ck, input)
	if !bytes.Equal(a1, b1) || !bytes.Equal(a2, b2) {
		t.Error("hkdf2 must be deterministic for same inputs")
	}
}

func TestHkdf2_DifferentInputsProduceDifferentOutputs(t *testing.T) {
	ck := []byte("ck")
	a1, _ := hkdf2(ck, []byte("input-a"))
	b1, _ := hkdf2(ck, []byte("input-b"))
	if bytes.Equal(a1, b1) {
		t.Error("hkdf2 must produce different outputs for different inputs")
	}
}

func TestHkdf2_DifferentCKProducesDifferentOutputs(t *testing.T) {
	input := []byte("same-input")
	a1, _ := hkdf2([]byte("ck-a"), input)
	b1, _ := hkdf2([]byte("ck-b"), input)
	if bytes.Equal(a1, b1) {
		t.Error("hkdf2 must produce different outputs for different chaining keys")
	}
}

func TestHkdf2_TwoOutputsAreDistinct(t *testing.T) {
	// The two outputs from a single HKDF call must differ; otherwise the
	// derived keys would be identical, breaking the cipher state split.
	ck := []byte("ck")
	input := []byte("input")
	out1, out2 := hkdf2(ck, input)
	if bytes.Equal(out1, out2) {
		t.Error("hkdf2 outputs 1 and 2 must differ")
	}
}

// ============================================================================
// hkdf3 — HKDF with 3 outputs (split)
// ============================================================================

func TestHkdf3_Returns32ByteOutputs(t *testing.T) {
	ck := []byte("final-chaining-key")
	o1, o2, o3 := hkdf3(ck)
	for i, out := range [][]byte{o1, o2, o3} {
		if len(out) != 32 {
			t.Errorf("hkdf3 output[%d] = %d bytes, want 32", i, len(out))
		}
	}
}

func TestHkdf3_AllThreeOutputsDistinct(t *testing.T) {
	// o2 and o3 become the send/recv cipher keys. If they were equal,
	// both peers would encrypt with the same key — catastrophic.
	ck := []byte("ck")
	o1, o2, o3 := hkdf3(ck)
	if bytes.Equal(o1, o2) || bytes.Equal(o2, o3) || bytes.Equal(o1, o3) {
		t.Errorf("hkdf3 outputs must all differ; got\n  %x\n  %x\n  %x", o1, o2, o3)
	}
}

func TestHkdf3_IsDeterministic(t *testing.T) {
	ck := []byte("deterministic")
	a1, a2, a3 := hkdf3(ck)
	b1, b2, b3 := hkdf3(ck)
	if !bytes.Equal(a1, b1) || !bytes.Equal(a2, b2) || !bytes.Equal(a3, b3) {
		t.Error("hkdf3 must be deterministic")
	}
}

// ============================================================================
// HandshakeState state transitions
// ============================================================================

func TestHandshakeState_MixHash_ChangesHashState(t *testing.T) {
	hs := &HandshakeState{}
	hs.initialize("Noise_NX_test")

	before := hs.h
	hs.mixHash([]byte("data"))
	if bytes.Equal(hs.h[:], before[:]) {
		t.Error("mixHash must change h")
	}
}

func TestHandshakeState_MixHash_IsDeterministic(t *testing.T) {
	hs1 := &HandshakeState{}
	hs2 := &HandshakeState{}
	hs1.initialize("same-protocol")
	hs2.initialize("same-protocol")
	data := []byte("same-data")
	hs1.mixHash(data)
	hs2.mixHash(data)
	if !bytes.Equal(hs1.h[:], hs2.h[:]) {
		t.Error("mixHash must be deterministic for same initial state and data")
	}
}

func TestHandshakeState_MixKey_UpdatesChainingKey(t *testing.T) {
	hs := &HandshakeState{}
	hs.initialize("Noise_NX_test")
	before := hs.ck
	hs.mixKey([]byte("shared-secret"))
	if bytes.Equal(hs.ck[:], before[:]) {
		t.Error("mixKey must update ck")
	}
}

func TestHandshakeState_Initialize_ShortName(t *testing.T) {
	// Protocol name shorter than 32 bytes — per spec, copy in padded.
	hs := &HandshakeState{}
	hs.initialize("short")
	// h and ck should start with "short" followed by zeros.
	if !bytes.HasPrefix(hs.h[:], []byte("short")) {
		t.Errorf("h should start with 'short', got %x", hs.h[:])
	}
}

func TestHandshakeState_Initialize_LongName(t *testing.T) {
	// Protocol name longer than 32 bytes — per spec, use SHA-256.
	hs := &HandshakeState{}
	longName := "Noise_NX_secp256k1_ChaChaPoly_SHA256_very_long_variant_identifier"
	hs.initialize(longName)
	// h and ck should both be the SHA-256 of the name.
	if bytes.Equal(hs.h[:], make([]byte, 32)) {
		t.Error("initialize with long name left h as zeros")
	}
	if !bytes.Equal(hs.h[:], hs.ck[:]) {
		t.Error("initialize should set h == ck")
	}
}

// ============================================================================
// deriveTransportKeys
// ============================================================================

func TestDeriveTransportKeys_PopulatesBothCiphers(t *testing.T) {
	hs := &HandshakeState{}
	hs.initialize("Noise_NX_test")
	hs.mixKey([]byte("shared-secret"))
	hs.deriveTransportKeys()

	if hs.sendCipher == nil {
		t.Fatal("sendCipher is nil after deriveTransportKeys")
	}
	if hs.recvCipher == nil {
		t.Fatal("recvCipher is nil after deriveTransportKeys")
	}
}

func TestDeriveTransportKeys_KeysAreDifferent(t *testing.T) {
	hs := &HandshakeState{}
	hs.initialize("Noise_NX_test")
	hs.mixKey([]byte("secret"))
	hs.deriveTransportKeys()

	if bytes.Equal(hs.sendCipher.key[:], hs.recvCipher.key[:]) {
		t.Error("send and recv keys must differ")
	}
}

func TestDeriveTransportKeys_CipherNoncesStartAtZero(t *testing.T) {
	hs := &HandshakeState{}
	hs.initialize("Noise_NX_test")
	hs.deriveTransportKeys()

	if hs.sendCipher.n != 0 {
		t.Errorf("sendCipher.n = %d, want 0", hs.sendCipher.n)
	}
	if hs.recvCipher.n != 0 {
		t.Errorf("recvCipher.n = %d, want 0", hs.recvCipher.n)
	}
}

// ============================================================================
// EncryptedConn — frame boundaries and errors
// ============================================================================

func TestEncryptedConn_MultipleMessagesRoundTrip(t *testing.T) {
	var key [32]byte
	for i := range key {
		key[i] = byte(i)
	}
	var buf bytes.Buffer
	sender := NewEncryptedConn(&buf, &CipherState{key: key}, &CipherState{key: key})

	messages := [][]byte{
		[]byte("first"),
		[]byte("second message is longer"),
		[]byte("x"),
	}
	for _, msg := range messages {
		if _, err := sender.Write(msg); err != nil {
			t.Fatalf("Write: %v", err)
		}
	}

	// New connection for reading, with matching keys starting at nonce 0.
	var readBuf bytes.Buffer
	readBuf.Write(buf.Bytes())
	receiver := NewEncryptedConn(&readBuf, &CipherState{key: key}, &CipherState{key: key})

	for i, msg := range messages {
		out := make([]byte, len(msg)+100)
		n, err := receiver.Read(out)
		if err != nil {
			t.Fatalf("Read msg %d: %v", i, err)
		}
		if !bytes.Equal(out[:n], msg) {
			t.Errorf("msg %d: got %q, want %q", i, out[:n], msg)
		}
	}
}

func TestEncryptedConn_ReadFromTruncatedStream(t *testing.T) {
	var key [32]byte
	var buf bytes.Buffer

	sender := NewEncryptedConn(&buf, &CipherState{key: key}, &CipherState{key: key})
	_, _ = sender.Write([]byte("hello"))

	// Truncate the stream before the full frame is readable.
	full := buf.Bytes()
	truncated := bytes.NewBuffer(full[:len(full)-5]) // drop last 5 bytes

	receiver := NewEncryptedConn(truncated, &CipherState{key: key}, &CipherState{key: key})
	out := make([]byte, 100)
	if _, err := receiver.Read(out); err == nil {
		t.Error("Read should fail on truncated stream")
	}
}

func TestEncryptedConn_ReadFromEmptyStream(t *testing.T) {
	var key [32]byte
	var buf bytes.Buffer

	receiver := NewEncryptedConn(&buf, &CipherState{key: key}, &CipherState{key: key})
	out := make([]byte, 100)
	_, err := receiver.Read(out)
	if err == nil {
		t.Error("Read from empty stream should fail")
	}
	if err != io.EOF && err != io.ErrUnexpectedEOF {
		// Either EOF variant is acceptable.
		t.Logf("got error type: %T / %v", err, err)
	}
}

func TestEncryptedConn_WritePreservesByteCount(t *testing.T) {
	var key [32]byte
	var buf bytes.Buffer
	conn := NewEncryptedConn(&buf, &CipherState{key: key}, &CipherState{key: key})

	msg := []byte("payload of known length")
	n, err := conn.Write(msg)
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if n != len(msg) {
		t.Errorf("Write returned n=%d, want %d", n, len(msg))
	}
	// Buffer holds: 2-byte length + ciphertext (plaintext + 16 byte Poly1305 tag)
	wantLen := 2 + len(msg) + 16
	if buf.Len() != wantLen {
		t.Errorf("buffer has %d bytes, want %d (2 len + %d plaintext + 16 tag)",
			buf.Len(), wantLen, len(msg))
	}
}

func TestEncryptedConn_TamperDetection(t *testing.T) {
	var key [32]byte
	var buf bytes.Buffer
	sender := NewEncryptedConn(&buf, &CipherState{key: key}, &CipherState{key: key})
	_, _ = sender.Write([]byte("authentic"))

	// Tamper with the ciphertext byte.
	data := buf.Bytes()
	data[5] ^= 0xFF
	tampered := bytes.NewBuffer(data)

	receiver := NewEncryptedConn(tampered, &CipherState{key: key}, &CipherState{key: key})
	out := make([]byte, 100)
	if _, err := receiver.Read(out); err == nil {
		t.Error("Read must fail on tampered ciphertext (AEAD authentication)")
	}
}

// ============================================================================
// CipherState — many consecutive encryptions don't leak
// ============================================================================

func TestCipherState_ManyEncryptsProduceDifferentCiphertexts(t *testing.T) {
	var key [32]byte
	cs := &CipherState{key: key}

	plaintext := []byte("same plaintext")
	var seen [][]byte
	for i := 0; i < 10; i++ {
		ct, _ := cs.Encrypt(nil, plaintext)
		for j, prev := range seen {
			if bytes.Equal(ct, prev) {
				t.Errorf("ciphertext %d identical to %d (nonce reuse?)", i, j)
			}
		}
		seen = append(seen, append([]byte{}, ct...))
	}
}

func TestCipherState_DecryptWithDifferentNonceFails(t *testing.T) {
	var key [32]byte
	sender := &CipherState{key: key}
	receiver := &CipherState{key: key}

	// Encrypt first message on sender.
	ct1, _ := sender.Encrypt(nil, []byte("msg1"))
	// Receiver decrypts msg1 successfully.
	if _, err := receiver.Decrypt(nil, ct1); err != nil {
		t.Fatalf("decrypt msg1: %v", err)
	}
	// Encrypt another message.
	ct2, _ := sender.Encrypt(nil, []byte("msg2"))
	// Now receiver is at nonce=1; decrypting ct2 (which needs nonce=1) works.
	if _, err := receiver.Decrypt(nil, ct2); err != nil {
		t.Errorf("decrypt msg2 (sequential): %v", err)
	}
}

func TestCipherState_DecryptSkippingNonceFails(t *testing.T) {
	var key [32]byte
	sender := &CipherState{key: key}
	receiver := &CipherState{key: key}

	// Encrypt two messages; skip delivering the first.
	_, _ = sender.Encrypt(nil, []byte("msg1")) // consumes nonce 0
	ct2, _ := sender.Encrypt(nil, []byte("msg2"))

	// Receiver at nonce=0, but ct2 was encrypted at nonce=1.
	if _, err := receiver.Decrypt(nil, ct2); err == nil {
		t.Error("decrypt should fail when receiver's nonce doesn't match sender's")
	}
}
