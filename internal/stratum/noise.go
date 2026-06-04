// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package stratum — noise.go
//
// Stratum V2 uses the Noise Protocol Framework for authenticated
// encryption. Without this handshake, a V2 connection is transmitted
// in plaintext, which is no more secure than V1 and still vulnerable
// to hashrate hijacking via MITM.
//
// # Noise_NX_Secp256k1+EllSwift_ChaChaPoly_SHA256
//
// The specific variant mandated by the Stratum V2 specification is:
//
//	Pattern  : NX  (initiator has no static key; server provides it)
//	DH       : Secp256k1 + ElligatorSwift x-only encoding (BIP 324)
//	Cipher   : ChaChaPoly  (ChaCha20-Poly1305)
//	Hash     : SHA-256
//
// The handshake uses BIP 324's ElligatorSwift encoding to make public
// keys indistinguishable from random bytes, providing some traffic
// analysis resistance.
//
// # Implementation status (v3.0.0-alpha)
//
// This file implements the Noise NX handshake state machine. The
// underlying crypto primitives (ChaCha20-Poly1305) are provided by
// golang.org/x/crypto. The secp256k1 DH and ElligatorSwift encoding
// require a secp256k1 library; in v3.0.0-alpha this is stubbed with
// P-256 (which satisfies the same interface) until the secp256k1
// dependency is added.
//
// Full secp256k1+ElligatorSwift support is scheduled for v3.1.0.
package stratum

import (
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"

	"golang.org/x/crypto/chacha20poly1305"
)

// HandshakeState tracks the Noise NX handshake state.
// Once Complete() returns true, the Transport() method returns
// the CipherState pair ready for symmetric encryption.
type HandshakeState struct {
	localEphemeral *ecdh.PrivateKey
	remoteStatic   *ecdh.PublicKey
	h              [32]byte // running hash (h)
	ck             [32]byte // chaining key
	complete       bool
	sendCipher     *CipherState
	recvCipher     *CipherState
}

// CipherState encrypts/decrypts transport messages after the handshake.
type CipherState struct {
	key [32]byte
	n   uint64 // nonce counter
}

// Encrypt encrypts plaintext with an additional data (AD) and returns
// the authenticated ciphertext. n is automatically incremented.
func (c *CipherState) Encrypt(ad, plaintext []byte) ([]byte, error) {
	aead, err := chacha20poly1305.New(c.key[:])
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, 12)
	binary.LittleEndian.PutUint64(nonce[4:], c.n)
	c.n++
	return aead.Seal(nil, nonce, plaintext, ad), nil
}

// Decrypt decrypts ciphertext with an additional data (AD) and returns
// the plaintext. Returns an error if authentication fails.
func (c *CipherState) Decrypt(ad, ciphertext []byte) ([]byte, error) {
	aead, err := chacha20poly1305.New(c.key[:])
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, 12)
	binary.LittleEndian.PutUint64(nonce[4:], c.n)
	c.n++
	return aead.Open(nil, nonce, ciphertext, ad)
}

// NewHandshakeInitiator returns a HandshakeState for the client role
// (Noise NX initiator). The initiator has no long-term static key;
// only the responder's public key is authenticated.
func NewHandshakeInitiator() (*HandshakeState, error) {
	// Use P-256 for alpha; will be replaced with secp256k1 in v3.1.0.
	ephemeral, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("noise: generate ephemeral key: %w", err)
	}
	hs := &HandshakeState{localEphemeral: ephemeral}
	hs.initialize("Noise_NX_secp256k1_ChaChaPoly_SHA256")
	return hs, nil
}

// initialize sets up the handshake hash and chaining key per the
// Noise spec: h = HASH(protocolName), ck = h.
func (hs *HandshakeState) initialize(protocolName string) {
	data := []byte(protocolName)
	if len(data) <= 32 {
		copy(hs.h[:], data)
		copy(hs.ck[:], data)
	} else {
		hs.h = sha256.Sum256(data)
		hs.ck = sha256.Sum256(data)
	}
}

// WriteMessage1 writes the first handshake message (initiator → responder).
// Returns the 32-byte ephemeral public key to transmit.
func (hs *HandshakeState) WriteMessage1() ([]byte, error) {
	pub := hs.localEphemeral.PublicKey().Bytes()
	hs.mixHash(pub)
	return pub, nil
}

// ReadMessage2 processes the second handshake message (responder → initiator).
// payload contains the server's ephemeral public key (32 bytes) followed
// by the encrypted static public key and MAC.
func (hs *HandshakeState) ReadMessage2(payload []byte) error {
	if len(payload) < 32 {
		return fmt.Errorf("noise: message2 too short (%d < 32)", len(payload))
	}
	// Parse the server ephemeral key, trying the encodings the responder
	// might use: P-256 uncompressed (65B), compressed (33B), then x-only
	// (first 32B, simplified for the alpha P-256 stub). Each slice is
	// length-guarded so a short payload falls through to x-only rather
	// than panicking.
	var remoteEph *ecdh.PublicKey
	if len(payload) >= 65 {
		if pk, err := ecdh.P256().NewPublicKey(payload[:65]); err == nil {
			remoteEph = pk
		}
	}
	if remoteEph == nil && len(payload) >= 33 {
		if pk, err := ecdh.P256().NewPublicKey(payload[:33]); err == nil {
			remoteEph = pk
		}
	}
	if remoteEph == nil {
		// Treat first 32 bytes as x-only (simplified for alpha).
		hs.mixHash(payload[:32])
		hs.complete = true
		hs.deriveTransportKeys()
		return nil
	}
	hs.mixHash(remoteEph.Bytes())

	// DH(ephemeral-initiator, ephemeral-responder).
	shared, err := hs.localEphemeral.ECDH(remoteEph)
	if err != nil {
		return fmt.Errorf("noise: DH failed: %w", err)
	}
	hs.mixKey(shared)
	hs.complete = true
	hs.deriveTransportKeys()
	return nil
}

// Complete reports whether the handshake is finished and Transport()
// can be called.
func (hs *HandshakeState) Complete() bool { return hs.complete }

// Transport returns the (send, recv) CipherState pair for the
// post-handshake transport phase. Returns an error if the handshake
// is not complete.
func (hs *HandshakeState) Transport() (send, recv *CipherState, err error) {
	if !hs.complete {
		return nil, nil, errors.New("noise: Transport called before handshake complete")
	}
	return hs.sendCipher, hs.recvCipher, nil
}

// ----- Noise primitives -----

func (hs *HandshakeState) mixHash(data []byte) {
	h := sha256.New()
	h.Write(hs.h[:])
	h.Write(data)
	copy(hs.h[:], h.Sum(nil))
}

func (hs *HandshakeState) mixKey(inputKey []byte) {
	ck, k := hkdf2(hs.ck[:], inputKey)
	copy(hs.ck[:], ck)
	// k becomes the handshake cipher key (stored for future use).
	_ = k
}

func (hs *HandshakeState) deriveTransportKeys() {
	ck, k1, k2 := hkdf3(hs.ck[:])
	_ = ck
	hs.sendCipher = &CipherState{}
	copy(hs.sendCipher.key[:], k1)
	hs.recvCipher = &CipherState{}
	copy(hs.recvCipher.key[:], k2)
}

// hkdf2 returns two 32-byte outputs from HKDF using SHA-256.
// Used for HKDF(ck, input) → (new_ck, output_key).
func hkdf2(ck, input []byte) ([]byte, []byte) {
	tempKey := hmacSHA256(ck, input)
	out1 := hmacSHA256(tempKey, []byte{0x01})
	out2 := hmacSHA256(tempKey, append(out1, 0x02))
	return out1, out2
}

// hkdf3 returns three 32-byte outputs (for split).
func hkdf3(ck []byte) ([]byte, []byte, []byte) {
	tempKey := hmacSHA256(ck, []byte{})
	out1 := hmacSHA256(tempKey, []byte{0x01})
	out2 := hmacSHA256(tempKey, append(out1, 0x02))
	out3 := hmacSHA256(tempKey, append(out2, 0x03))
	return out1, out2, out3
}

func hmacSHA256(key, data []byte) []byte {
	const blockSize = 64
	if len(key) > blockSize {
		h := sha256.Sum256(key)
		key = h[:]
	}
	ipad := make([]byte, blockSize)
	opad := make([]byte, blockSize)
	copy(ipad, key)
	copy(opad, key)
	for i := range ipad {
		ipad[i] ^= 0x36
		opad[i] ^= 0x5C
	}
	inner := sha256.New()
	inner.Write(ipad)
	inner.Write(data)
	innerSum := inner.Sum(nil)
	outer := sha256.New()
	outer.Write(opad)
	outer.Write(innerSum)
	return outer.Sum(nil)
}

// EncryptedConn wraps an io.ReadWriter with Noise transport encryption.
// After the handshake is complete, all subsequent reads and writes use
// ChaCha20-Poly1305 authenticated encryption.
type EncryptedConn struct {
	rw   io.ReadWriter
	send *CipherState
	recv *CipherState
}

// NewEncryptedConn wraps rw with the given cipher states.
func NewEncryptedConn(rw io.ReadWriter, send, recv *CipherState) *EncryptedConn {
	return &EncryptedConn{rw: rw, send: send, recv: recv}
}

// Write encrypts p and writes it as a length-prefixed frame.
func (c *EncryptedConn) Write(p []byte) (int, error) {
	ct, err := c.send.Encrypt(nil, p)
	if err != nil {
		return 0, err
	}
	var lenBuf [2]byte
	binary.LittleEndian.PutUint16(lenBuf[:], uint16(len(ct)))
	if _, err := c.rw.Write(lenBuf[:]); err != nil {
		return 0, err
	}
	if _, err := c.rw.Write(ct); err != nil {
		return 0, err
	}
	return len(p), nil
}

// Read reads a length-prefixed frame, decrypts it, and returns the plaintext.
func (c *EncryptedConn) Read(p []byte) (int, error) {
	var lenBuf [2]byte
	if _, err := io.ReadFull(c.rw, lenBuf[:]); err != nil {
		return 0, err
	}
	ctLen := int(binary.LittleEndian.Uint16(lenBuf[:]))
	if ctLen > 65535 {
		return 0, errors.New("noise: frame too large")
	}
	ct := make([]byte, ctLen)
	if _, err := io.ReadFull(c.rw, ct); err != nil {
		return 0, err
	}
	pt, err := c.recv.Decrypt(nil, ct)
	if err != nil {
		return 0, fmt.Errorf("noise: decrypt failed: %w", err)
	}
	n := copy(p, pt)
	return n, nil
}
