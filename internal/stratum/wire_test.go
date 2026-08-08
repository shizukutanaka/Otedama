// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package stratum

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
	"testing/iotest"
)

// ----- STR0_255 -----

func TestStr0_255_RoundTrip(t *testing.T) {
	cases := []string{"", "a", "hello", "otedama/3.0.0", strings.Repeat("x", 255)}
	for _, s := range cases {
		b, err := appendStr0_255(nil, s)
		if err != nil {
			t.Fatalf("appendStr0_255(%q): %v", s, err)
		}
		got, err := getStr0_255(newByteReader(b))
		if err != nil {
			t.Fatalf("getStr0_255(%q): %v", s, err)
		}
		if got != s {
			t.Errorf("round-trip: got %q, want %q", got, s)
		}
	}
}

func TestStr0_255_LengthPrefix(t *testing.T) {
	b, err := appendStr0_255(nil, "abc")
	if err != nil {
		t.Fatal(err)
	}
	// First byte is the length prefix.
	if b[0] != 3 {
		t.Errorf("length prefix = %d, want 3", b[0])
	}
	if len(b) != 4 { // 1 length + 3 content
		t.Errorf("total length = %d, want 4", len(b))
	}
}

func TestStr0_255_RejectsTooLong(t *testing.T) {
	long := strings.Repeat("x", 256) // exceeds 255
	if _, err := appendStr0_255(nil, long); err == nil {
		t.Error("appendStr0_255 should reject strings longer than 255")
	}
}

func TestGetStr0_255_TruncatedInput(t *testing.T) {
	// Length prefix says 5 bytes but only 2 follow.
	truncated := []byte{5, 'a', 'b'}
	_, err := getStr0_255(newByteReader(truncated))
	if err == nil {
		t.Error("getStr0_255 should error on truncated input")
	}
}

// ----- B0_255 -----

func TestB0_255_RoundTrip(t *testing.T) {
	cases := [][]byte{
		{},
		{0x00},
		{0xde, 0xad, 0xbe, 0xef},
		bytes.Repeat([]byte{0xAB}, 255),
	}
	for _, b := range cases {
		enc, err := appendB0_255(nil, b)
		if err != nil {
			t.Fatalf("appendB0_255(%d bytes): %v", len(b), err)
		}
		got, err := getB0_255(newByteReader(enc))
		if err != nil {
			t.Fatalf("getB0_255: %v", err)
		}
		if !bytes.Equal(got, b) {
			t.Errorf("round-trip: got %x, want %x", got, b)
		}
	}
}

func TestB0_255_RejectsTooLong(t *testing.T) {
	if _, err := appendB0_255(nil, bytes.Repeat([]byte{0}, 256)); err == nil {
		t.Error("appendB0_255 should reject byte slices longer than 255")
	}
}

// ----- U16LE -----

func TestU16LE_RoundTrip(t *testing.T) {
	cases := []uint16{0, 1, 255, 256, 0x1234, 0xFFFF}
	for _, v := range cases {
		got, err := getU16LE(newByteReader(appendU16LE(nil, v)))
		if err != nil {
			t.Fatalf("getU16LE: %v", err)
		}
		if got != v {
			t.Errorf("round-trip: got %d, want %d", got, v)
		}
	}
}

func TestU16LE_LittleEndianByteOrder(t *testing.T) {
	// Little-endian: low byte first.
	want := []byte{0x34, 0x12}
	if got := appendU16LE(nil, 0x1234); !bytes.Equal(got, want) {
		t.Errorf("byte order = %x, want %x", got, want)
	}
}

func TestGetU16LE_TruncatedInput(t *testing.T) {
	_, err := getU16LE(newByteReader([]byte{0x01})) // need 2 bytes
	if err == nil {
		t.Error("getU16LE should error on 1-byte input")
	}
}

// ----- U32LE -----

func TestU32LE_RoundTrip(t *testing.T) {
	cases := []uint32{0, 1, 0xFFFF, 0x10000, 0x12345678, 0xFFFFFFFF}
	for _, v := range cases {
		got, err := getU32LE(newByteReader(appendU32LE(nil, v)))
		if err != nil {
			t.Fatalf("getU32LE: %v", err)
		}
		if got != v {
			t.Errorf("round-trip: got %d, want %d", got, v)
		}
	}
}

func TestU32LE_LittleEndianByteOrder(t *testing.T) {
	want := []byte{0x78, 0x56, 0x34, 0x12}
	if got := appendU32LE(nil, 0x12345678); !bytes.Equal(got, want) {
		t.Errorf("byte order = %x, want %x", got, want)
	}
}

func TestGetU32LE_TruncatedInput(t *testing.T) {
	_, err := getU32LE(newByteReader([]byte{0x01, 0x02, 0x03})) // need 4
	if err == nil {
		t.Error("getU32LE should error on 3-byte input")
	}
}

// ----- GetB0_255 read error paths -----

func TestGetB0_255_EmptyReader_LengthByteFails(t *testing.T) {
	_, err := getB0_255(bytes.NewReader([]byte{}))
	if err == nil {
		t.Error("getB0_255 should error when length byte cannot be read")
	}
}

func TestGetB0_255_TruncatedData(t *testing.T) {
	// Length says 5, but only 2 data bytes follow.
	_, err := getB0_255(bytes.NewReader([]byte{5, 'a', 'b'}))
	if err == nil {
		t.Error("getB0_255 should error when data bytes are truncated")
	}
}

// ----- byteSliceReader (ReadByte path) -----

func TestByteSliceReader_ReadByteThenRead(t *testing.T) {
	r := newByteReader([]byte{0xAA, 0xBB, 0xCC})

	// ReadByte consumes one byte.
	b, err := r.ReadByte()
	if err != nil || b != 0xAA {
		t.Fatalf("ReadByte = %x, %v; want 0xAA, nil", b, err)
	}

	// Subsequent Read picks up where ReadByte left off.
	rest := make([]byte, 2)
	n, err := r.Read(rest)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if n != 2 || rest[0] != 0xBB || rest[1] != 0xCC {
		t.Errorf("Read = %x (n=%d), want BBCC (n=2)", rest, n)
	}
}

func TestByteSliceReader_ReadByteAtEOF(t *testing.T) {
	r := newByteReader([]byte{})
	_, err := r.ReadByte()
	if err == nil {
		t.Error("ReadByte on empty reader should return error")
	}
}

// ----- iotest.ErrReader — genuine I/O error propagation -----
//
// The truncation tests above feed a short but clean byte slice (EOF reached
// early). These tests use iotest.ErrReader to inject a genuine I/O error
// (distinct from io.EOF / io.ErrUnexpectedEOF). They verify that each
// get* primitive propagates the error rather than swallowing or panicking.
//
// Pattern recommended by Zenn (rinchsan, "Go 1.16で追加されたiotest.ErrReader
// を使ってio.Readerの異常系をテストする"): use io.MultiReader to deliver the
// length/header byte successfully, then ErrReader to fail on the body read.
// This exercises two distinct error branches per primitive.

var errIO = errors.New("simulated I/O error")

func TestGetStr0_255_IOErrorOnLengthByte(t *testing.T) {
	// The very first Read (length byte) fails.
	_, err := getStr0_255(iotest.ErrReader(errIO))
	if err == nil {
		t.Fatal("expected error when length-byte read fails")
	}
}

func TestGetStr0_255_IOErrorOnStringBytes(t *testing.T) {
	// Length byte (3) is delivered, then the string data read fails.
	r := io.MultiReader(strings.NewReader("\x03"), iotest.ErrReader(errIO))
	_, err := getStr0_255(r)
	if err == nil {
		t.Fatal("expected error when string-bytes read fails")
	}
}

func TestGetB0_255_IOErrorOnLengthByte(t *testing.T) {
	_, err := getB0_255(iotest.ErrReader(errIO))
	if err == nil {
		t.Fatal("expected error when length-byte read fails")
	}
}

func TestGetB0_255_IOErrorOnDataBytes(t *testing.T) {
	// Length byte (4) delivered, then data read fails.
	r := io.MultiReader(bytes.NewReader([]byte{4}), iotest.ErrReader(errIO))
	_, err := getB0_255(r)
	if err == nil {
		t.Fatal("expected error when data-bytes read fails")
	}
}

func TestGetU16LE_IOError(t *testing.T) {
	_, err := getU16LE(iotest.ErrReader(errIO))
	if err == nil {
		t.Fatal("expected error when U16LE read fails")
	}
}

func TestGetU32LE_IOError(t *testing.T) {
	_, err := getU32LE(iotest.ErrReader(errIO))
	if err == nil {
		t.Fatal("expected error when U32LE read fails")
	}
}
