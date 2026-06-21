// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package stratum — wire.go
//
// Low-level binary encoding primitives shared by every message type
// in the Stratum V2 Mining Protocol. Extracted from messages.go to
// keep that file focused on protocol message types alone.
//
// All integers are little-endian (LE), per Stratum V2 §3.
package stratum

import (
	"encoding/binary"
	"fmt"
	"io"
	"math"
)

// ------------------------------------------------------------------
// Low-level encoding primitives
// ------------------------------------------------------------------

// appendStr0_255 appends a STR0_255 (1-byte-length-prefixed UTF-8 string)
// to b and returns the extended slice. It returns an error only when s
// exceeds the 255-byte maximum the length prefix can represent; appending to
// a slice cannot otherwise fail (the io.Writer-returning predecessor's write
// errors were unreachable because every caller targets an in-memory buffer).
func appendStr0_255(b []byte, s string) ([]byte, error) {
	if len(s) > 255 {
		return nil, fmt.Errorf("stratum: string too long (%d > 255 bytes)", len(s))
	}
	b = append(b, byte(len(s)))
	return append(b, s...), nil
}

// getStr0_255 reads a STR0_255 from r.
func getStr0_255(r io.Reader) (string, error) {
	var lenBuf [1]byte
	if _, err := io.ReadFull(r, lenBuf[:]); err != nil {
		return "", fmt.Errorf("stratum: reading string length: %w", err)
	}
	n := int(lenBuf[0])
	if n == 0 {
		return "", nil
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return "", fmt.Errorf("stratum: reading string bytes: %w", err)
	}
	return string(buf), nil
}

// appendB0_255 appends a B0_255 (1-byte-length-prefixed byte slice) to dst and
// returns the extended slice. It returns an error only when v exceeds the
// 255-byte maximum the length prefix can represent.
func appendB0_255(dst, v []byte) ([]byte, error) {
	if len(v) > 255 {
		return nil, fmt.Errorf("stratum: byte slice too long (%d > 255)", len(v))
	}
	dst = append(dst, byte(len(v)))
	return append(dst, v...), nil
}

// getB0_255 reads a B0_255 from r.
func getB0_255(r io.Reader) ([]byte, error) {
	var lenBuf [1]byte
	if _, err := io.ReadFull(r, lenBuf[:]); err != nil {
		return nil, err
	}
	n := int(lenBuf[0])
	if n == 0 {
		return []byte{}, nil
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

// appendU16LE appends a uint16 in little-endian order.
func appendU16LE(b []byte, v uint16) []byte {
	return binary.LittleEndian.AppendUint16(b, v)
}

// getU16LE reads a uint16 in little-endian order.
func getU16LE(r io.Reader) (uint16, error) {
	var b [2]byte
	if _, err := io.ReadFull(r, b[:]); err != nil {
		return 0, err
	}
	return binary.LittleEndian.Uint16(b[:]), nil
}

// appendU32LE appends a uint32 in little-endian order.
func appendU32LE(b []byte, v uint32) []byte {
	return binary.LittleEndian.AppendUint32(b, v)
}

// getU32LE reads a uint32 in little-endian order.
func getU32LE(r io.Reader) (uint32, error) {
	var b [4]byte
	if _, err := io.ReadFull(r, b[:]); err != nil {
		return 0, err
	}
	return binary.LittleEndian.Uint32(b[:]), nil
}

// ------------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------------

// newByteReader wraps a []byte as a *byteSliceReader. The concrete
// type (rather than io.Reader) is returned so callers can use the
// io.ByteReader-satisfying ReadByte method below.
func newByteReader(b []byte) *byteSliceReader {
	return &byteSliceReader{b: b}
}

type byteSliceReader struct {
	b   []byte
	pos int
}

func (r *byteSliceReader) Read(p []byte) (int, error) {
	if r.pos >= len(r.b) {
		return 0, io.EOF
	}
	n := copy(p, r.b[r.pos:])
	r.pos += n
	return n, nil
}

func (r *byteSliceReader) ReadByte() (byte, error) {
	if r.pos >= len(r.b) {
		return 0, io.EOF
	}
	c := r.b[r.pos]
	r.pos++
	return c, nil
}

// float32bits returns the IEEE 754 binary representation of f.
// Uses math.Float32bits to avoid undefined behavior from pointer casts.
func float32bits(f float32) uint32 { return math.Float32bits(f) }

// float32frombits returns the float32 with the given IEEE 754 bit pattern.
func float32frombits(v uint32) float32 { return math.Float32frombits(v) }
