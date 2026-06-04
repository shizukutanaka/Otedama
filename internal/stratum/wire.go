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
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"math"
)

// ------------------------------------------------------------------
// Low-level encoding primitives
// ------------------------------------------------------------------

// putStr0_255 writes a STR0_255 (1-byte-length-prefixed UTF-8 string)
// into w. Returns an error if s is longer than 255 bytes.
func putStr0_255(w io.Writer, s string) error {
	b := []byte(s)
	if len(b) > 255 {
		return fmt.Errorf("stratum: string too long (%d > 255 bytes)", len(b))
	}
	if _, err := w.Write([]byte{byte(len(b))}); err != nil {
		return err
	}
	if len(b) > 0 {
		_, err := w.Write(b)
		return err
	}
	return nil
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

// putB0_255 writes a B0_255 (1-byte-length-prefixed byte slice) into w.
func putB0_255(w io.Writer, b []byte) error {
	if len(b) > 255 {
		return fmt.Errorf("stratum: byte slice too long (%d > 255)", len(b))
	}
	if _, err := w.Write([]byte{byte(len(b))}); err != nil {
		return err
	}
	if len(b) > 0 {
		_, err := w.Write(b)
		return err
	}
	return nil
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

// putU16LE writes a uint16 in little-endian order.
func putU16LE(w io.Writer, v uint16) error {
	var b [2]byte
	binary.LittleEndian.PutUint16(b[:], v)
	_, err := w.Write(b[:])
	return err
}

// getU16LE reads a uint16 in little-endian order.
func getU16LE(r io.Reader) (uint16, error) {
	var b [2]byte
	if _, err := io.ReadFull(r, b[:]); err != nil {
		return 0, err
	}
	return binary.LittleEndian.Uint16(b[:]), nil
}

// putU32LE writes a uint32 in little-endian order.
func putU32LE(w io.Writer, v uint32) error {
	var b [4]byte
	binary.LittleEndian.PutUint32(b[:], v)
	_, err := w.Write(b[:])
	return err
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

// byteWriter wraps a bytes.Buffer to satisfy io.Writer with WriteByte.
type byteWriter struct{ *bytes.Buffer }

func (bw *byteWriter) WriteByte(c byte) error {
	return bw.Buffer.WriteByte(c)
}

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
