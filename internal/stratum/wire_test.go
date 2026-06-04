// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package stratum

import (
	"bytes"
	"strings"
	"testing"
)

// ----- STR0_255 -----

func TestStr0_255_RoundTrip(t *testing.T) {
	cases := []string{"", "a", "hello", "otedama/3.0.0", strings.Repeat("x", 255)}
	for _, s := range cases {
		var buf bytes.Buffer
		if err := putStr0_255(&buf, s); err != nil {
			t.Fatalf("putStr0_255(%q): %v", s, err)
		}
		got, err := getStr0_255(newByteReader(buf.Bytes()))
		if err != nil {
			t.Fatalf("getStr0_255(%q): %v", s, err)
		}
		if got != s {
			t.Errorf("round-trip: got %q, want %q", got, s)
		}
	}
}

func TestStr0_255_LengthPrefix(t *testing.T) {
	var buf bytes.Buffer
	if err := putStr0_255(&buf, "abc"); err != nil {
		t.Fatal(err)
	}
	// First byte is the length prefix.
	if buf.Bytes()[0] != 3 {
		t.Errorf("length prefix = %d, want 3", buf.Bytes()[0])
	}
	if buf.Len() != 4 { // 1 length + 3 content
		t.Errorf("total length = %d, want 4", buf.Len())
	}
}

func TestStr0_255_RejectsTooLong(t *testing.T) {
	var buf bytes.Buffer
	long := strings.Repeat("x", 256) // exceeds 255
	if err := putStr0_255(&buf, long); err == nil {
		t.Error("putStr0_255 should reject strings longer than 255")
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
		var buf bytes.Buffer
		if err := putB0_255(&buf, b); err != nil {
			t.Fatalf("putB0_255(%d bytes): %v", len(b), err)
		}
		got, err := getB0_255(newByteReader(buf.Bytes()))
		if err != nil {
			t.Fatalf("getB0_255: %v", err)
		}
		if !bytes.Equal(got, b) {
			t.Errorf("round-trip: got %x, want %x", got, b)
		}
	}
}

func TestB0_255_RejectsTooLong(t *testing.T) {
	var buf bytes.Buffer
	if err := putB0_255(&buf, bytes.Repeat([]byte{0}, 256)); err == nil {
		t.Error("putB0_255 should reject byte slices longer than 255")
	}
}

// ----- U16LE -----

func TestU16LE_RoundTrip(t *testing.T) {
	cases := []uint16{0, 1, 255, 256, 0x1234, 0xFFFF}
	for _, v := range cases {
		var buf bytes.Buffer
		if err := putU16LE(&buf, v); err != nil {
			t.Fatalf("putU16LE(%d): %v", v, err)
		}
		got, err := getU16LE(newByteReader(buf.Bytes()))
		if err != nil {
			t.Fatalf("getU16LE: %v", err)
		}
		if got != v {
			t.Errorf("round-trip: got %d, want %d", got, v)
		}
	}
}

func TestU16LE_LittleEndianByteOrder(t *testing.T) {
	var buf bytes.Buffer
	if err := putU16LE(&buf, 0x1234); err != nil {
		t.Fatal(err)
	}
	// Little-endian: low byte first.
	want := []byte{0x34, 0x12}
	if !bytes.Equal(buf.Bytes(), want) {
		t.Errorf("byte order = %x, want %x", buf.Bytes(), want)
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
		var buf bytes.Buffer
		if err := putU32LE(&buf, v); err != nil {
			t.Fatalf("putU32LE(%d): %v", v, err)
		}
		got, err := getU32LE(newByteReader(buf.Bytes()))
		if err != nil {
			t.Fatalf("getU32LE: %v", err)
		}
		if got != v {
			t.Errorf("round-trip: got %d, want %d", got, v)
		}
	}
}

func TestU32LE_LittleEndianByteOrder(t *testing.T) {
	var buf bytes.Buffer
	if err := putU32LE(&buf, 0x12345678); err != nil {
		t.Fatal(err)
	}
	want := []byte{0x78, 0x56, 0x34, 0x12}
	if !bytes.Equal(buf.Bytes(), want) {
		t.Errorf("byte order = %x, want %x", buf.Bytes(), want)
	}
}

func TestGetU32LE_TruncatedInput(t *testing.T) {
	_, err := getU32LE(newByteReader([]byte{0x01, 0x02, 0x03})) // need 4
	if err == nil {
		t.Error("getU32LE should error on 3-byte input")
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
