// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package stratum

import (
	"bytes"
	"errors"
	"io"
	"testing"
	"testing/iotest"
)

// ----- Header basics -----

func TestHeader_ChannelMsg(t *testing.T) {
	tests := []struct {
		name string
		ext  uint16
		want bool
	}{
		{"bit unset low", 0x0000, false},
		{"bit unset mid", 0x0ABC, false},
		{"bit unset high", 0x7FFF, false},
		{"bit set low", 0x8000, true},
		{"bit set mid", 0x8ABC, true},
		{"bit set high", 0xFFFF, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			h := Header{ExtensionType: tt.ext}
			if got := h.ChannelMsg(); got != tt.want {
				t.Errorf("ChannelMsg() for ExtensionType=0x%04X = %v, want %v", tt.ext, got, tt.want)
			}
		})
	}
}

func TestHeader_ExtensionID_MasksChannelBit(t *testing.T) {
	// 0x8ABC and 0x0ABC address the same extension; ExtensionID must
	// return the same value for both so dispatch tables work uniformly.
	tests := []struct {
		ext  uint16
		want uint16
	}{
		{0x0000, 0x0000},
		{0x0ABC, 0x0ABC},
		{0x8000, 0x0000},
		{0x8ABC, 0x0ABC},
		{0xFFFF, 0x7FFF},
	}
	for _, tt := range tests {
		h := Header{ExtensionType: tt.ext}
		if got := h.ExtensionID(); got != tt.want {
			t.Errorf("ExtensionID for 0x%04X = 0x%04X, want 0x%04X", tt.ext, got, tt.want)
		}
	}
}

func TestHeader_Validate(t *testing.T) {
	tests := []struct {
		name    string
		h       Header
		wantErr bool
	}{
		{"zero header", Header{}, false},
		{"max U24 length", Header{MsgLength: MaxMessageLength}, false},
		{"over U24", Header{MsgLength: MaxMessageLength + 1}, true},
		{"channel msg with sufficient payload", Header{ExtensionType: channelMsgBit, MsgLength: 4}, false},
		{"channel msg with oversized payload", Header{ExtensionType: channelMsgBit, MsgLength: 100}, false},
		{"channel msg with 3-byte payload rejected", Header{ExtensionType: channelMsgBit, MsgLength: 3}, true},
		{"channel msg with empty payload rejected", Header{ExtensionType: channelMsgBit, MsgLength: 0}, true},
		{"non-channel msg with empty payload OK", Header{MsgLength: 0}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			err := tt.h.Validate()
			if (err != nil) != tt.wantErr {
				t.Errorf("Validate() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

// ----- Encode / Decode round-trip -----

func TestEncodeDecodeHeader_Roundtrip(t *testing.T) {
	headers := []Header{
		{ExtensionType: 0x0000, MsgType: 0x00, MsgLength: 0},
		{ExtensionType: 0x0001, MsgType: 0x10, MsgLength: 32},
		{ExtensionType: 0x0ABC, MsgType: 0xFF, MsgLength: 100},
		{ExtensionType: 0x8ABC, MsgType: 0x7E, MsgLength: 64}, // channel msg
		{ExtensionType: 0x7FFF, MsgType: 0x00, MsgLength: MaxMessageLength},
	}
	for _, h := range headers {
		buf := make([]byte, HeaderSize)
		if err := EncodeHeader(buf, h); err != nil {
			t.Fatalf("EncodeHeader(%+v) failed: %v", h, err)
		}
		got, err := DecodeHeader(buf)
		if err != nil {
			t.Fatalf("DecodeHeader failed: %v", err)
		}
		if got != h {
			t.Errorf("roundtrip: got %+v, want %+v", got, h)
		}
	}
}

func TestEncodeHeader_UsesLittleEndian(t *testing.T) {
	// The Stratum V2 specification mandates little-endian for all
	// multi-byte integers. This test pins that contract against
	// accidental regression.
	h := Header{
		ExtensionType: 0x8ABC,
		MsgType:       0x42,
		MsgLength:     0x123456,
	}
	buf := make([]byte, HeaderSize)
	if err := EncodeHeader(buf, h); err != nil {
		t.Fatalf("EncodeHeader failed: %v", err)
	}
	// ExtensionType 0x8ABC in little-endian: 0xBC 0x8A
	// MsgType 0x42 as-is.
	// MsgLength 0x123456 as U24 little-endian: 0x56 0x34 0x12.
	want := []byte{0xBC, 0x8A, 0x42, 0x56, 0x34, 0x12}
	if !bytes.Equal(buf, want) {
		t.Errorf("encoded bytes = %X, want %X", buf, want)
	}
}

func TestEncodeHeader_RejectsOversizedLength(t *testing.T) {
	h := Header{MsgLength: MaxMessageLength + 1}
	buf := make([]byte, HeaderSize)
	if err := EncodeHeader(buf, h); err == nil {
		t.Error("EncodeHeader accepted over-U24 length")
	}
}

func TestEncodeHeader_RejectsShortDst(t *testing.T) {
	h := Header{MsgLength: 0}
	buf := make([]byte, HeaderSize-1)
	if err := EncodeHeader(buf, h); err == nil {
		t.Error("EncodeHeader accepted dst shorter than HeaderSize")
	}
}

func TestDecodeHeader_RejectsShortInput(t *testing.T) {
	for i := 0; i < HeaderSize; i++ {
		buf := make([]byte, i)
		if _, err := DecodeHeader(buf); err == nil {
			t.Errorf("DecodeHeader with %d bytes accepted; want error", i)
		}
	}
}

// ----- Frame encode/decode -----

func TestEncodeFrame_SetsMsgLengthFromPayload(t *testing.T) {
	// Even if the caller passes a Header with the wrong MsgLength,
	// EncodeFrame overwrites it with the actual payload length so that
	// produced frames are always self-consistent.
	f := Frame{
		Header:  Header{ExtensionType: 1, MsgType: 2, MsgLength: 999},
		Payload: []byte{0xAA, 0xBB, 0xCC},
	}
	data, err := EncodeFrame(f)
	if err != nil {
		t.Fatalf("EncodeFrame failed: %v", err)
	}
	h, err := DecodeHeader(data[:HeaderSize])
	if err != nil {
		t.Fatalf("DecodeHeader failed: %v", err)
	}
	if h.MsgLength != 3 {
		t.Errorf("encoded MsgLength = %d, want 3 (from payload)", h.MsgLength)
	}
}

func TestEncodeFrame_RejectsOversizedPayload(t *testing.T) {
	// Construct a payload header + slice that would overflow U24.
	// Allocating the actual slice is expensive and unnecessary; we
	// simulate the check path by constructing a slice larger than the
	// maximum. Using len() on a fabricated backing array would be more
	// complex than the test warrants, so we test an above-limit size
	// via the direct code path instead.
	//
	// We use a small payload but an illegal length claim; however,
	// EncodeFrame sets length from len(Payload), so we must actually
	// create a large slice. To keep the test fast, we choose the
	// smallest illegal size: MaxMessageLength+1.
	if testing.Short() {
		t.Skip("allocating MaxMessageLength+1 byte slice is slow")
	}
	big := make([]byte, MaxMessageLength+1)
	f := Frame{Payload: big}
	if _, err := EncodeFrame(f); err == nil {
		t.Error("EncodeFrame accepted payload longer than MaxMessageLength")
	}
}

// ----- Decoder: normal reads -----

func TestDecoder_ReadsSingleFrame(t *testing.T) {
	want := Frame{
		Header:  Header{ExtensionType: 0x0001, MsgType: 0x10, MsgLength: 4},
		Payload: []byte{0xDE, 0xAD, 0xBE, 0xEF},
	}
	encoded, err := EncodeFrame(want)
	if err != nil {
		t.Fatalf("EncodeFrame setup failed: %v", err)
	}

	d := NewDecoder(bytes.NewReader(encoded))
	got, err := d.ReadFrame()
	if err != nil {
		t.Fatalf("ReadFrame failed: %v", err)
	}
	if got.Header != want.Header {
		t.Errorf("Header = %+v, want %+v", got.Header, want.Header)
	}
	if !bytes.Equal(got.Payload, want.Payload) {
		t.Errorf("Payload = %X, want %X", got.Payload, want.Payload)
	}
}

func TestDecoder_ReadsMultipleFramesInOrder(t *testing.T) {
	frames := []Frame{
		{Header: Header{ExtensionType: 1, MsgType: 10, MsgLength: 2}, Payload: []byte{0x01, 0x02}},
		{Header: Header{ExtensionType: 2, MsgType: 20, MsgLength: 0}, Payload: []byte{}},
		{Header: Header{ExtensionType: 3, MsgType: 30, MsgLength: 5}, Payload: []byte{0x11, 0x22, 0x33, 0x44, 0x55}},
	}

	var buf bytes.Buffer
	for _, f := range frames {
		b, err := EncodeFrame(f)
		if err != nil {
			t.Fatalf("setup EncodeFrame: %v", err)
		}
		buf.Write(b)
	}

	d := NewDecoder(&buf)
	for i, want := range frames {
		got, err := d.ReadFrame()
		if err != nil {
			t.Fatalf("frame %d ReadFrame failed: %v", i, err)
		}
		if got.Header != want.Header {
			t.Errorf("frame %d Header: got %+v, want %+v", i, got.Header, want.Header)
		}
		if !bytes.Equal(got.Payload, want.Payload) {
			t.Errorf("frame %d Payload: got %X, want %X", i, got.Payload, want.Payload)
		}
	}
	// After all frames are read, the reader should be exhausted.
	if _, err := d.ReadFrame(); !errors.Is(err, io.EOF) {
		t.Errorf("expected io.EOF at end, got %v", err)
	}
}

func TestDecoder_ZeroLengthPayloadOK(t *testing.T) {
	// Frames with empty payloads are valid (some control messages have
	// no body). The decoder must not attempt a zero-length read that
	// mistakenly reports EOF.
	f := Frame{
		Header:  Header{ExtensionType: 0x0001, MsgType: 0x01, MsgLength: 0},
		Payload: []byte{},
	}
	encoded, err := EncodeFrame(f)
	if err != nil {
		t.Fatalf("EncodeFrame: %v", err)
	}
	d := NewDecoder(bytes.NewReader(encoded))
	got, err := d.ReadFrame()
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	if len(got.Payload) != 0 {
		t.Errorf("Payload length = %d, want 0", len(got.Payload))
	}
}

// ----- Decoder: truncation and corruption -----

func TestDecoder_ReturnsEOFOnCleanClose(t *testing.T) {
	d := NewDecoder(bytes.NewReader(nil))
	_, err := d.ReadFrame()
	if !errors.Is(err, io.EOF) {
		t.Errorf("clean empty reader: got %v, want io.EOF", err)
	}
}

func TestDecoder_ReturnsUnexpectedEOFMidHeader(t *testing.T) {
	// Half a header.
	d := NewDecoder(bytes.NewReader([]byte{0x01, 0x02, 0x03}))
	_, err := d.ReadFrame()
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Errorf("mid-header close: got %v, want io.ErrUnexpectedEOF", err)
	}
}

func TestDecoder_ReturnsUnexpectedEOFMidPayload(t *testing.T) {
	// Header promises 100 bytes; reader provides 10.
	h := Header{ExtensionType: 1, MsgType: 1, MsgLength: 100}
	buf := make([]byte, HeaderSize+10)
	_ = EncodeHeader(buf[:HeaderSize], h)

	d := NewDecoder(bytes.NewReader(buf))
	_, err := d.ReadFrame()
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Errorf("mid-payload close: got %v, want io.ErrUnexpectedEOF", err)
	}
}

// ----- Decoder: malicious input defenses -----

func TestDecoder_RejectsOversizedFrame(t *testing.T) {
	// A malicious peer announces a huge MsgLength. The decoder must
	// reject this before allocating any payload buffer. This is the
	// direct defense against CVE-2014-4502-style heap exhaustion.
	h := Header{ExtensionType: 1, MsgType: 1, MsgLength: MaxMessageLength}
	buf := make([]byte, HeaderSize)
	_ = EncodeHeader(buf, h)

	d := NewDecoder(bytes.NewReader(buf))
	d.MaxFrameSize = 1024 // small bound
	_, err := d.ReadFrame()
	if err == nil {
		t.Fatal("ReadFrame accepted frame exceeding MaxFrameSize")
	}
	// Crucially, the error must occur before any attempt to read the payload.
	if !bytes.Contains([]byte(err.Error()), []byte("MaxFrameSize")) {
		t.Errorf("error %q does not mention MaxFrameSize", err)
	}
}

func TestDecoder_RejectsChannelMsgWithInsufficientPayload(t *testing.T) {
	// Crafted header: channel_msg bit set, but MsgLength < 4.
	// Bypass EncodeHeader (which validates) by writing bytes directly.
	buf := []byte{
		0x00, 0x80, // ExtensionType = 0x8000 (channel_msg set)
		0x01,             // MsgType
		0x02, 0x00, 0x00, // MsgLength = 2 (should be >= 4)
	}
	d := NewDecoder(bytes.NewReader(buf))
	_, err := d.ReadFrame()
	if err == nil {
		t.Fatal("ReadFrame accepted channel message with 2-byte payload")
	}
}

func TestDecoder_ZeroMaxFrameSizeRejected(t *testing.T) {
	// A zero-value Decoder (forgotten construction) would otherwise
	// accept any size. ReadFrame must refuse to proceed.
	d := &Decoder{r: bytes.NewReader([]byte{0, 0, 0, 0, 0, 0})}
	_, err := d.ReadFrame()
	if err == nil {
		t.Error("zero-value Decoder accepted ReadFrame call")
	}
}

func TestDecoder_HandlesOneByteReader(t *testing.T) {
	// io.ReadFull must be used correctly: a reader that returns one
	// byte per call must not cause the decoder to misinterpret
	// partial reads.
	want := Frame{
		Header:  Header{ExtensionType: 0x0001, MsgType: 0x10, MsgLength: 5},
		Payload: []byte{0x11, 0x22, 0x33, 0x44, 0x55},
	}
	encoded, err := EncodeFrame(want)
	if err != nil {
		t.Fatalf("EncodeFrame: %v", err)
	}
	slow := iotest.OneByteReader(bytes.NewReader(encoded))
	d := NewDecoder(slow)
	got, err := d.ReadFrame()
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	if got.Header != want.Header {
		t.Errorf("Header: got %+v, want %+v", got.Header, want.Header)
	}
	if !bytes.Equal(got.Payload, want.Payload) {
		t.Errorf("Payload: got %X, want %X", got.Payload, want.Payload)
	}
}

// ----- Frame.ChannelID -----

func TestFrame_ChannelID_ExtractsFromChannelMessage(t *testing.T) {
	// channel_id 0x01020304 in little-endian prefix.
	f := Frame{
		Header:  Header{ExtensionType: channelMsgBit | 0x0001, MsgType: 0x10, MsgLength: 8},
		Payload: []byte{0x04, 0x03, 0x02, 0x01, 0xAA, 0xBB, 0xCC, 0xDD},
	}
	got, err := f.ChannelID()
	if err != nil {
		t.Fatalf("ChannelID: %v", err)
	}
	if got != 0x01020304 {
		t.Errorf("ChannelID = 0x%08X, want 0x01020304", got)
	}
}

func TestFrame_ChannelID_RejectsNonChannelMessage(t *testing.T) {
	f := Frame{
		Header:  Header{MsgLength: 4},
		Payload: []byte{0x01, 0x02, 0x03, 0x04},
	}
	if _, err := f.ChannelID(); err == nil {
		t.Error("ChannelID on non-channel message returned no error")
	}
}

func TestFrame_ChannelID_RejectsShortPayload(t *testing.T) {
	// channel_msg bit set but payload trimmed after decode (unusual,
	// but we guard against it rather than panic).
	f := Frame{
		Header:  Header{ExtensionType: channelMsgBit, MsgLength: 4},
		Payload: []byte{0x01, 0x02},
	}
	if _, err := f.ChannelID(); err == nil {
		t.Error("ChannelID on short payload returned no error")
	}
}

func TestEncodeFrame_ChannelMsgValidationError(t *testing.T) {
	// ChannelMsg bit set with payload smaller than MinimumChannelPayload
	// triggers Header.Validate() error inside EncodeFrame.
	f := Frame{
		Header:  Header{ExtensionType: channelMsgBit},
		Payload: []byte{0x01, 0x02}, // 2 bytes < MinimumChannelPayload (4)
	}
	_, err := EncodeFrame(f)
	if err == nil {
		t.Error("EncodeFrame should reject channel message with payload < MinimumChannelPayload")
	}
}
