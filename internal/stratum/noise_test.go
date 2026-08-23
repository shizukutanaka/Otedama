// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package stratum

import (
	"bytes"
	"crypto/ecdh"
	"crypto/rand"
	"errors"
	"io"
	"testing"
)

// ----- CipherState -----

func TestCipherState_EncryptDecryptRoundtrip(t *testing.T) {
	var key [32]byte
	copy(key[:], []byte("test-key-12345678901234567890123"))

	cs := &CipherState{key: key}
	plaintext := []byte("hello otedama")
	ad := []byte("additional data")

	ct, err := cs.Encrypt(ad, plaintext)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	if bytes.Equal(ct, plaintext) {
		t.Fatal("ciphertext equals plaintext")
	}

	cs2 := &CipherState{key: key}
	pt, err := cs2.Decrypt(ad, ct)
	if err != nil {
		t.Fatalf("Decrypt: %v", err)
	}
	if !bytes.Equal(pt, plaintext) {
		t.Errorf("decrypted = %q, want %q", pt, plaintext)
	}
}

func TestCipherState_NonceIncrements(t *testing.T) {
	var key [32]byte
	cs := &CipherState{key: key}
	if cs.n != 0 {
		t.Error("initial nonce should be 0")
	}
	_, _ = cs.Encrypt(nil, []byte("x"))
	if cs.n != 1 {
		t.Errorf("nonce after one encrypt = %d, want 1", cs.n)
	}
	_, _ = cs.Encrypt(nil, []byte("y"))
	if cs.n != 2 {
		t.Errorf("nonce after two encrypts = %d, want 2", cs.n)
	}
}

func TestCipherState_TamperedCiphertextFails(t *testing.T) {
	var key [32]byte
	enc := &CipherState{key: key}
	ct, _ := enc.Encrypt(nil, []byte("secret"))

	ct[0] ^= 0xFF // tamper

	dec := &CipherState{key: key}
	if _, err := dec.Decrypt(nil, ct); err == nil {
		t.Error("Decrypt should fail on tampered ciphertext")
	}
}

func TestCipherState_WrongADFails(t *testing.T) {
	var key [32]byte
	enc := &CipherState{key: key}
	ct, _ := enc.Encrypt([]byte("correct-ad"), []byte("secret"))

	dec := &CipherState{key: key}
	if _, err := dec.Decrypt([]byte("wrong-ad"), ct); err == nil {
		t.Error("Decrypt should fail with wrong additional data")
	}
}

// ----- HandshakeState -----

func TestHandshakeInitiator_Creates(t *testing.T) {
	hs, err := NewHandshakeInitiator()
	if err != nil {
		t.Fatalf("NewHandshakeInitiator: %v", err)
	}
	if hs.localEphemeral == nil {
		t.Error("ephemeral key not generated")
	}
	if hs.Complete() {
		t.Error("handshake should not be complete at creation")
	}
}

func TestHandshakeInitiator_WriteMessage1(t *testing.T) {
	hs, err := NewHandshakeInitiator()
	if err != nil {
		t.Fatalf("NewHandshakeInitiator: %v", err)
	}
	msg1, err := hs.WriteMessage1()
	if err != nil {
		t.Fatalf("WriteMessage1: %v", err)
	}
	if len(msg1) == 0 {
		t.Error("WriteMessage1 returned empty key material")
	}
}

func TestHandshakeInitiator_ReadMessage2_SimplifiedAlpha(t *testing.T) {
	// In alpha, ReadMessage2 accepts a 32-byte x-only key
	// and completes the handshake.
	hs, _ := NewHandshakeInitiator()
	_, _ = hs.WriteMessage1()

	fakeMsg2 := make([]byte, 32)
	for i := range fakeMsg2 {
		fakeMsg2[i] = byte(i + 1)
	}
	if err := hs.ReadMessage2(fakeMsg2); err != nil {
		t.Fatalf("ReadMessage2: %v", err)
	}
	if !hs.Complete() {
		t.Error("handshake should be complete after ReadMessage2")
	}
}

func TestHandshakeInitiator_TransportReturnsErrorBeforeComplete(t *testing.T) {
	hs, _ := NewHandshakeInitiator()
	_, _, err := hs.Transport()
	if err == nil {
		t.Error("Transport before complete should return error")
	}
}

// ----- EncryptedConn -----

func TestEncryptedConn_RoundTrip(t *testing.T) {
	var k1, k2 [32]byte
	for i := range k1 {
		k1[i] = byte(i)
		k2[i] = byte(255 - i)
	}
	alice := &CipherState{key: k1} // alice sends
	bob := &CipherState{key: k1}   // bob decrypts alice's messages
	_, _ = alice, bob

	// Simulate pipe: alice writes to buf, bob reads from buf.
	var buf bytes.Buffer
	sendCS := &CipherState{key: k1}
	recvCS := &CipherState{key: k1}

	conn := NewEncryptedConn(&buf, sendCS, recvCS)

	original := []byte("non-custodial mining: your hardware, your keys")
	if _, err := conn.Write(original); err != nil {
		t.Fatalf("Write: %v", err)
	}

	// Read back with matching keys.
	var buf2 bytes.Buffer
	buf2.Write(buf.Bytes())
	sendCS2 := &CipherState{key: k1}
	recvCS2 := &CipherState{key: k1}
	conn2 := NewEncryptedConn(&buf2, sendCS2, recvCS2)

	out := make([]byte, len(original)+100)
	n, err := conn2.Read(out)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if !bytes.Equal(out[:n], original) {
		t.Errorf("decrypted = %q, want %q", out[:n], original)
	}
}

// ----- HandshakeState — ReadMessage2 paths -----

func TestHandshakeState_ReadMessage2_TooShort(t *testing.T) {
	hs, _ := NewHandshakeInitiator()
	_, _ = hs.WriteMessage1()
	err := hs.ReadMessage2([]byte("short")) // 5 bytes < 32
	if err == nil {
		t.Error("ReadMessage2 with payload < 32 should return error")
	}
}

func TestHandshakeState_ReadMessage2_With65BUncompressedKey(t *testing.T) {
	hs, _ := NewHandshakeInitiator()
	_, _ = hs.WriteMessage1()

	// 65-byte uncompressed P-256 key (04 || X || Y) — the path taken when
	// the responder sends a full uncompressed point.
	serverEph, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate server ephemeral: %v", err)
	}
	payload := serverEph.PublicKey().Bytes() // 65 bytes
	if len(payload) != 65 {
		t.Fatalf("expected 65-byte P-256 key, got %d", len(payload))
	}

	if err := hs.ReadMessage2(payload); err != nil {
		t.Fatalf("ReadMessage2 with 65-byte uncompressed key: %v", err)
	}
	if !hs.Complete() {
		t.Error("handshake should be complete after 65B key")
	}
}

func TestHandshakeState_ReadMessage2_With33BCompressedKey(t *testing.T) {
	hs, _ := NewHandshakeInitiator()
	_, _ = hs.WriteMessage1()

	// Build a compressed (33-byte) P-256 public key from an uncompressed one.
	// Go's ecdh.P256().NewPublicKey accepts SEC 1 compressed (0x02/0x03 || X).
	serverEph, _ := ecdh.P256().GenerateKey(rand.Reader)
	raw := serverEph.PublicKey().Bytes() // 65 bytes: [04, X(32), Y(32)]
	compressed := make([]byte, 33)
	if raw[64]&1 != 0 { // last byte of Y determines odd/even
		compressed[0] = 0x03
	} else {
		compressed[0] = 0x02
	}
	copy(compressed[1:], raw[1:33]) // copy X coordinate

	// Sanity check: ecdh must accept this compressed key.
	if _, err := ecdh.P256().NewPublicKey(compressed); err != nil {
		t.Skipf("ecdh.P256 does not accept compressed keys in this Go build: %v", err)
	}

	if err := hs.ReadMessage2(compressed); err != nil {
		t.Fatalf("ReadMessage2 with 33-byte compressed key: %v", err)
	}
	if !hs.Complete() {
		t.Error("handshake should be complete after 33B compressed key")
	}
}

// ----- HandshakeState — Transport happy path -----

func TestHandshakeState_Transport_AfterComplete(t *testing.T) {
	hs, _ := NewHandshakeInitiator()
	_, _ = hs.WriteMessage1()

	// Complete via x-only fallback (32-byte payload).
	payload := make([]byte, 32)
	for i := range payload {
		payload[i] = byte(i + 1)
	}
	if err := hs.ReadMessage2(payload); err != nil {
		t.Fatalf("ReadMessage2: %v", err)
	}

	send, recv, err := hs.Transport()
	if err != nil {
		t.Fatalf("Transport after complete: %v", err)
	}
	if send == nil || recv == nil {
		t.Error("Transport should return non-nil CipherState pair after complete handshake")
	}
}

// ----- EncryptedConn additional paths -----

// errorReadWriter always returns an error on both Read and Write.
type errorReadWriter struct{ err error }

func (e errorReadWriter) Write(_ []byte) (int, error) { return 0, e.err }
func (e errorReadWriter) Read(_ []byte) (int, error)  { return 0, e.err }

// failAfterFirstWriter succeeds on the first Write (the length prefix) and
// then fails, letting us cover the ciphertext-write error path independently.
type failAfterFirstWriter struct {
	first bool
	buf   bytes.Buffer
}

func (f *failAfterFirstWriter) Write(p []byte) (int, error) {
	if !f.first {
		f.first = true
		return f.buf.Write(p) // length prefix succeeds
	}
	return 0, errors.New("ciphertext write error")
}
func (f *failAfterFirstWriter) Read(p []byte) (int, error) { return f.buf.Read(p) }

func TestEncryptedConn_Write_PayloadExceedsMaxFrame(t *testing.T) {
	var buf bytes.Buffer
	var key [32]byte
	conn := NewEncryptedConn(&buf, &CipherState{key: key}, &CipherState{key: key})

	// Plaintext > maxNoiseFrame - poly1305 tag (16 B) = 65519 B produces
	// a ciphertext > 65535 which overflows the u16 length prefix.
	bigPayload := make([]byte, maxNoiseFrame) // 65535 plaintext → 65551-byte CT
	_, err := conn.Write(bigPayload)
	if err == nil {
		t.Error("Write with payload exceeding maxNoiseFrame should return error")
	}
}

func TestEncryptedConn_Write_LengthPrefixWriteError(t *testing.T) {
	var key [32]byte
	conn := NewEncryptedConn(
		errorReadWriter{errors.New("write error")},
		&CipherState{key: key},
		&CipherState{key: key},
	)
	_, err := conn.Write([]byte("x"))
	if err == nil {
		t.Error("Write when underlying length-prefix write fails should return error")
	}
}

func TestEncryptedConn_Write_CiphertextWriteError(t *testing.T) {
	var key [32]byte
	w := &failAfterFirstWriter{}
	conn := NewEncryptedConn(w, &CipherState{key: key}, &CipherState{key: key})
	_, err := conn.Write([]byte("hello"))
	if err == nil {
		t.Error("Write when ciphertext write fails should return error")
	}
}

func TestEncryptedConn_Read_TamperedCiphertext(t *testing.T) {
	var writeBuf bytes.Buffer
	var key [32]byte
	writer := NewEncryptedConn(&writeBuf, &CipherState{key: key}, &CipherState{key: key})

	if _, err := writer.Write([]byte("secret message")); err != nil {
		t.Fatalf("Write: %v", err)
	}

	// Flip the last byte of the buffer — that's within the Poly1305 auth tag.
	raw := writeBuf.Bytes()
	tampered := make([]byte, len(raw))
	copy(tampered, raw)
	tampered[len(tampered)-1] ^= 0xFF

	reader := NewEncryptedConn(bytes.NewBuffer(tampered), &CipherState{key: key}, &CipherState{key: key})
	out := make([]byte, 64)
	_, err := reader.Read(out)
	if err == nil {
		t.Error("Read should fail when ciphertext authentication tag is tampered")
	}
}

func TestEncryptedConn_Read_SmallBuffer_DrainsProperly(t *testing.T) {
	var writeBuf bytes.Buffer
	var key [32]byte
	writer := NewEncryptedConn(&writeBuf, &CipherState{key: key}, &CipherState{key: key})

	original := []byte("hello noise protocol world")
	if _, err := writer.Write(original); err != nil {
		t.Fatalf("Write: %v", err)
	}

	// Read in two chunks smaller than the plaintext, exercising the readbuf
	// draining path that retains leftover plaintext across Read calls.
	reader := NewEncryptedConn(
		bytes.NewBuffer(writeBuf.Bytes()),
		&CipherState{key: key},
		&CipherState{key: key},
	)

	first := make([]byte, 5) // partial read — leaves 21 bytes in readbuf
	n1, err := reader.Read(first)
	if err != nil {
		t.Fatalf("first Read: %v", err)
	}

	rest := make([]byte, len(original))
	n2, err := reader.Read(rest)
	if err != nil && err != io.EOF {
		t.Fatalf("second Read: %v", err)
	}

	reassembled := append(first[:n1], rest[:n2]...)
	if !bytes.Equal(reassembled, original) {
		t.Errorf("reassembled = %q, want %q", reassembled, original)
	}
}

// ----- HMAC-SHA256 (internal) -----

func TestHmacSHA256_KnownVector(t *testing.T) {
	// HMAC-SHA256(key="key", data="The quick brown fox ...") is a standard
	// test vector from RFC 4231.
	key := []byte("key")
	data := []byte("The quick brown fox jumps over the lazy dog")
	got := hmacSHA256(key, data)

	// Expected from RFC/test-vector tools:
	want := []byte{
		0xf7, 0xbc, 0x83, 0xf4, 0x30, 0x53, 0x84, 0x24,
		0xb1, 0x32, 0x98, 0xe6, 0xaa, 0x6f, 0xb1, 0x43,
		0xef, 0x4d, 0x59, 0xa1, 0x49, 0x46, 0x17, 0x59,
		0x97, 0x47, 0x9d, 0xbc, 0x2d, 0x1a, 0x3c, 0xd8,
	}
	if !bytes.Equal(got, want) {
		t.Errorf("hmacSHA256 = %x\nwant %x", got, want)
	}
}
