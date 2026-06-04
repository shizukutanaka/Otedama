// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package miner implements Bitcoin SHA-256d proof-of-work computation.
//
// Bitcoin mining is the process of finding a block header nonce such
// that SHA256(SHA256(header)) < target. This package provides:
//
//   - Header: the 80-byte block header layout
//   - Hash:   SHA-256d of an 80-byte header
//   - Target: conversion between nBits compact format and [32]byte target
//   - Worker: a goroutine that grinds nonces and reports found shares
//
// # Why pure Go (no CGO, no SIMD)?
//
// Home users run Otedama on CPUs with unknown capabilities. CGO and
// hand-written assembly constrain the build matrix and add supply-chain
// surface. Go 1.22's crypto/sha256 already uses SIMD instructions on
// amd64 and arm64 when available, so the performance gap to hand-tuned
// assembly is modest for a CPU miner. GPU acceleration and ASIC support
// are handled at the HAL layer; this package targets CPU mining only.
package miner

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"math/big"
)

// HeaderSize is the exact byte length of a Bitcoin block header.
const HeaderSize = 80

// Header represents an 80-byte Bitcoin block header in its canonical
// little-endian wire format.
//
// Fields are stored in the order they appear on the wire so that
// asBytes() can be a simple slice (not a marshalling call).
//
// Offsets (from Bitcoin's serialisation format):
//
//	[0:4]   Version   uint32 LE
//	[4:36]  PrevHash  [32]byte (LE, so already reversed vs RPC)
//	[36:68] MerkleRoot [32]byte
//	[68:72] Time      uint32 LE
//	[72:76] Bits      uint32 LE (nBits compact target)
//	[76:80] Nonce     uint32 LE
type Header struct {
	Version    uint32
	PrevHash   [32]byte
	MerkleRoot [32]byte
	Time       uint32
	Bits       uint32 // nBits compact target
	Nonce      uint32
}

// Bytes serialises the header to its canonical 80-byte wire representation.
func (h Header) Bytes() [HeaderSize]byte {
	var b [HeaderSize]byte
	binary.LittleEndian.PutUint32(b[0:4], h.Version)
	copy(b[4:36], h.PrevHash[:])
	copy(b[36:68], h.MerkleRoot[:])
	binary.LittleEndian.PutUint32(b[68:72], h.Time)
	binary.LittleEndian.PutUint32(b[72:76], h.Bits)
	binary.LittleEndian.PutUint32(b[76:80], h.Nonce)
	return b
}

// ParseHeader decodes an 80-byte wire-format block header.
func ParseHeader(b [HeaderSize]byte) Header {
	var h Header
	h.Version = binary.LittleEndian.Uint32(b[0:4])
	copy(h.PrevHash[:], b[4:36])
	copy(h.MerkleRoot[:], b[36:68])
	h.Time = binary.LittleEndian.Uint32(b[68:72])
	h.Bits = binary.LittleEndian.Uint32(b[72:76])
	h.Nonce = binary.LittleEndian.Uint32(b[76:80])
	return h
}

// Hash is a 32-byte Bitcoin hash value (SHA-256d output).
// The zero value is a valid hash of all-zeros.
type Hash [32]byte

// String returns the hash as a lowercase hex string.
func (h Hash) String() string { return hex.EncodeToString(h[:]) }

// LessOrEqual reports whether h is numerically less than or equal to other.
// Both hashes are treated as big-endian 256-bit unsigned integers,
// which is Bitcoin's convention for comparing hash values to targets.
func (h Hash) LessOrEqual(other Hash) bool {
	for i := 31; i >= 0; i-- {
		if h[i] < other[i] {
			return true
		}
		if h[i] > other[i] {
			return false
		}
	}
	return true // equal
}

// SHA256d computes SHA256(SHA256(data)), the double-SHA256 function
// used throughout Bitcoin.
func SHA256d(data []byte) Hash {
	first := sha256.Sum256(data)
	return sha256.Sum256(first[:])
}

// HashHeader computes SHA256d of the 80-byte serialised header.
// This is the core inner loop of Bitcoin mining.
func HashHeader(h Header) Hash {
	b := h.Bytes()
	return SHA256d(b[:])
}

// ----- nBits compact target -----

// TargetFromNBits converts the nBits compact representation to a
// 32-byte target hash in little-endian byte order (most-significant
// byte at index 31), matching the Hash layout produced by SHA256d /
// HashHeader (see TestSHA256d_GenesisBlock). Storing the target in the
// same order as the hash lets the worker compare a header hash directly
// against the target with Hash.LessOrEqual. The algorithm is:
//
//	exponent = nBits >> 24
//	mantissa = nBits & 0x007fffff
//	target   = mantissa * 2^(8*(exponent-3))
//
// A hash is "valid" (meets the proof-of-work requirement) if it is
// numerically less than or equal to the target.
func TargetFromNBits(nBits uint32) (Hash, error) {
	exp := int(nBits >> 24)
	mant := nBits & 0x007fffff

	// Negative mantissa is invalid in this context.
	if nBits&0x00800000 != 0 {
		return Hash{}, fmt.Errorf("miner: nBits 0x%08X has negative mantissa bit set", nBits)
	}
	if exp < 3 {
		return Hash{}, fmt.Errorf("miner: nBits 0x%08X exponent %d is below minimum 3", nBits, exp)
	}

	// Build a *big.Int: mantissa * 2^(8*(exp-3))
	v := new(big.Int).SetUint64(uint64(mant))
	shift := uint(8 * (exp - 3))
	v.Lsh(v, shift)

	// v.Bytes() is the big-endian magnitude. Place it big-endian first,
	// then reverse the whole 32 bytes into the little-endian order the
	// Hash type uses (MSB at index 31), so target and hash are comparable.
	b := v.Bytes()
	if len(b) > 32 {
		return Hash{}, fmt.Errorf("miner: nBits 0x%08X target overflows 256 bits", nBits)
	}
	var be Hash
	copy(be[32-len(b):], b)
	var target Hash
	for i := 0; i < 32; i++ {
		target[i] = be[31-i]
	}
	return target, nil
}

// NBitsFromTarget converts a 32-byte little-endian target (the byte
// order produced by TargetFromNBits and used by the Hash type) back to
// the nBits compact representation. It is the inverse of TargetFromNBits.
func NBitsFromTarget(target Hash) uint32 {
	var be [32]byte
	for i := 0; i < 32; i++ {
		be[i] = target[31-i]
	}
	v := new(big.Int).SetBytes(be[:])
	if v.Sign() == 0 {
		return 0
	}
	b := v.Bytes()
	// Adjust for sign bit: if the high byte has the sign bit set, pad.
	if b[0]&0x80 != 0 {
		b = append([]byte{0x00}, b...)
	}
	exp := byte(len(b))
	var mant uint32
	switch len(b) {
	case 0:
		mant = 0
	case 1:
		mant = uint32(b[0])
	case 2:
		mant = uint32(b[0])<<8 | uint32(b[1])
	default:
		mant = uint32(b[0])<<16 | uint32(b[1])<<8 | uint32(b[2])
	}
	return uint32(exp)<<24 | mant
}

// MeetsTarget reports whether the given hash value meets the difficulty
// target represented by nBits.
func MeetsTarget(hash Hash, nBits uint32) (bool, error) {
	target, err := TargetFromNBits(nBits)
	if err != nil {
		return false, err
	}
	return hash.LessOrEqual(target), nil
}
