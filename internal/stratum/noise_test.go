// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package stratum

import (
	"bytes"
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

// ----- HMAC-SHA256 (internal) -----

func TestHmacSHA256_KnownVector(t *testing.T) {
	// HMAC-SHA256(key="key", data="The quick brown fox ...") is a standard
	// test vector from RFC 4231.
	key := []byte("key")
	data := []byte("The quick brown fox jumps over the lazy dog")
	got := hmacSHA256(key, data)

	// Expected from RFC/test-vector tools:
	want := []byte{0xf7, 0xbc, 0x83, 0xf4, 0x30, 0x53, 0x84, 0x24,
		0xb1, 0x32, 0x98, 0xe6, 0xaa, 0x6f, 0xb1, 0x43,
		0xef, 0x4d, 0x59, 0xa1, 0x49, 0x46, 0x17, 0x59,
		0x97, 0x47, 0x9d, 0xbc, 0x2d, 0x1a, 0x3c, 0xd8}
	if !bytes.Equal(got, want) {
		t.Errorf("hmacSHA256 = %x\nwant %x", got, want)
	}
}
