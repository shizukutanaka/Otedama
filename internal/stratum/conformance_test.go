// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
//
// Byte-exact conformance tests for the Stratum V2 wire format.
//
// The round-trip tests elsewhere in this package prove Otedama can decode
// what Otedama encodes — which is exactly the property that stayed green
// while five fields were missing, misnamed, or misnumbered relative to the
// specification. These tests instead assert the *absolute* layout: total
// payload length and the offset of each field, as specified in
// stratum-mining/sv2-spec (03-Protocol-Overview.md §3.2 and framing table,
// 05-Mining-Protocol.md §5.3, 08-Message-Types.md).
package stratum

import (
	"bytes"
	"encoding/binary"
	"testing"
)

// TestMessageTypeNumbers pins every msg_type against the spec's
// message-type table. 0x1e — which SubmitSharesError used until session
// 256 — is Reserved: a pool never sends it, so share rejections arrived as
// unknown frames and vanished.
func TestMessageTypeNumbers(t *testing.T) {
	for _, tt := range []struct {
		name string
		got  uint8
		want uint8
	}{
		{"SetupConnection", MsgSetupConnection, 0x00},
		{"SetupConnection.Success", MsgSetupConnectionSuccess, 0x01},
		{"SetupConnection.Error", MsgSetupConnectionError, 0x02},
		{"OpenStandardMiningChannel", MsgOpenMiningChannel, 0x10},
		{"OpenStandardMiningChannel.Success", MsgOpenMiningChannelSuccess, 0x11},
		{"OpenMiningChannel.Error", MsgOpenMiningChannelError, 0x12},
		{"NewMiningJob", MsgNewMiningJob, 0x15},
		{"SubmitSharesStandard", MsgSubmitSharesStandard, 0x1a},
		{"SubmitShares.Success", MsgSubmitSharesSuccess, 0x1c},
		{"SubmitShares.Error", MsgSubmitSharesError, 0x1d},
		{"SetNewPrevHash", MsgSetNewPrevHash, 0x20},
		{"SetTarget", MsgSetTarget, 0x21},
	} {
		if tt.got != tt.want {
			t.Errorf("%s msg_type = 0x%02x, want 0x%02x", tt.name, tt.got, tt.want)
		}
	}
}

// TestSetupConnection_WireLayout pins the field order and total size:
// protocol U8, min_version U16, max_version U16, flags U32,
// endpoint_host STR0_255, endpoint_port U16, then four more STR0_255.
//
// endpoint_port sits between the host and the vendor string. Omitting it
// (as this encoder did before session 256) does not merely lose a field:
// every byte after it shifts, so the pool reads the vendor's length prefix
// as the port and the message decodes as garbage from there on.
func TestSetupConnection_WireLayout(t *testing.T) {
	m := SetupConnection{
		Protocol:        MiningProtocol,
		MinVersion:      2,
		MaxVersion:      2,
		Flags:           0,
		EndpointHost:    "pool.example.com",
		EndpointPort:    3336,
		Vendor:          "Otedama",
		HardwareVersion: "v3.0.0",
		Firmware:        "main",
		DeviceID:        "cpu",
	}
	b, err := m.Encode()
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}

	wantLen := 1 + 2 + 2 + 4 + // protocol, min, max, flags
		1 + len(m.EndpointHost) + 2 + // endpoint_host, endpoint_port
		1 + len(m.Vendor) + 1 + len(m.HardwareVersion) +
		1 + len(m.Firmware) + 1 + len(m.DeviceID)
	if len(b) != wantLen {
		t.Fatalf("payload is %d bytes, want %d", len(b), wantLen)
	}

	off := 1 + 2 + 2 + 4
	if int(b[off]) != len(m.EndpointHost) {
		t.Fatalf("endpoint_host length prefix = %d, want %d", b[off], len(m.EndpointHost))
	}
	off += 1 + len(m.EndpointHost)
	if got := binary.LittleEndian.Uint16(b[off : off+2]); got != 3336 {
		t.Errorf("endpoint_port at offset %d = %d, want 3336", off, got)
	}
	off += 2
	if int(b[off]) != len(m.Vendor) || string(b[off+1:off+1+len(m.Vendor)]) != m.Vendor {
		t.Errorf("vendor does not start at offset %d — the port field is misplaced", off)
	}

	// And the decoder agrees with the encoder on every field.
	got, err := DecodeSetupConnection(b)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if got != m {
		t.Errorf("round trip: got %+v, want %+v", got, m)
	}
}

// TestOpenMiningChannel_WireLayout pins request_id U32,
// user_identity STR0_255, nominal_hash_rate F32, max_target U256 — 32
// bytes of which the encoder used to omit entirely, leaving a conformant
// pool waiting for a message that never ended.
func TestOpenMiningChannel_WireLayout(t *testing.T) {
	m := OpenMiningChannel{ReqID: 1, User: "bc1qexample.worker1", NominalHashrate: 1234.5}
	b, err := m.Encode()
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	wantLen := 4 + 1 + len(m.User) + 4 + 32
	if len(b) != wantLen {
		t.Fatalf("payload is %d bytes, want %d (max_target is mandatory)", len(b), wantLen)
	}

	// An unset MaxTarget must go out as "any target is acceptable", never
	// as 32 zero bytes (which would ask the pool for an impossible target).
	maxTarget := b[len(b)-32:]
	if bytes.Equal(maxTarget, make([]byte, 32)) {
		t.Error("max_target encoded as all zeros: no pool can assign a target at or below zero")
	}
	if !bytes.Equal(maxTarget, bytes.Repeat([]byte{0xFF}, 32)) {
		t.Errorf("unset max_target = %x, want all 0xFF (unconstrained)", maxTarget)
	}

	// An explicit preference is encoded verbatim.
	var explicit [32]byte
	explicit[31] = 0x7F
	m.MaxTarget = explicit
	b, err = m.Encode()
	if err != nil {
		t.Fatalf("Encode with explicit MaxTarget: %v", err)
	}
	if !bytes.Equal(b[len(b)-32:], explicit[:]) {
		t.Errorf("explicit max_target = %x, want %x", b[len(b)-32:], explicit)
	}

	got, err := DecodeOpenMiningChannel(b)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if got.ReqID != m.ReqID || got.User != m.User || got.MaxTarget != explicit {
		t.Errorf("round trip: got %+v, want %+v", got, m)
	}
}

// TestOpenMiningChannelSuccess_WireLayout pins request_id U32,
// channel_id U32, target U256, extranonce_prefix B0_32,
// group_channel_id U32. The trailing field was decoded as a U16
// "extranonce2_size" — a Stratum V1 concept absent from V2 — until
// session 256, so half of a real pool's group_channel_id was read as that
// field and two bytes were left unconsumed.
func TestOpenMiningChannelSuccess_WireLayout(t *testing.T) {
	m := OpenMiningChannelSuccess{
		ReqID:            7,
		ChannelID:        9,
		ExtranoncePrefix: []byte{0xde, 0xad},
		GroupChannelID:   0x11223344,
	}
	m.Target[31] = 0x1d
	b, err := m.Encode()
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	wantLen := 4 + 4 + 32 + 1 + len(m.ExtranoncePrefix) + 4
	if len(b) != wantLen {
		t.Fatalf("payload is %d bytes, want %d", len(b), wantLen)
	}
	if got := binary.LittleEndian.Uint32(b[len(b)-4:]); got != m.GroupChannelID {
		t.Errorf("group_channel_id = 0x%08x, want 0x%08x", got, m.GroupChannelID)
	}

	got, err := DecodeOpenMiningChannelSuccess(b)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if got.ReqID != m.ReqID || got.ChannelID != m.ChannelID ||
		got.Target != m.Target || got.GroupChannelID != m.GroupChannelID ||
		!bytes.Equal(got.ExtranoncePrefix, m.ExtranoncePrefix) {
		t.Errorf("round trip: got %+v, want %+v", got, m)
	}
}

// TestSubmitSharesSuccess_WireLayout pins new_shares_sum as a U64: as a
// U32 the message was four bytes short and the pool's figure was
// truncated to its low half.
func TestSubmitSharesSuccess_WireLayout(t *testing.T) {
	const bigSum = uint64(1) << 40 // beyond what a U32 can hold
	m := SubmitSharesSuccess{
		ChannelID:          1,
		LastSequenceNumber: 42,
		NewSubmitsAccepted: 3,
		NewSharesSummed:    bigSum,
	}
	b, err := m.Encode()
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	if len(b) != 20 {
		t.Fatalf("payload is %d bytes, want 20", len(b))
	}
	got, err := DecodeSubmitSharesSuccess(b)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if got.NewSharesSummed != bigSum {
		t.Errorf("new_shares_sum = %d, want %d (truncated to 32 bits?)", got.NewSharesSummed, bigSum)
	}
	if got != m {
		t.Errorf("round trip: got %+v, want %+v", got, m)
	}
}

// TestSubmitSharesStandard_WireLayout pins the 24-byte submission layout
// the pool uses to rebuild and re-hash the header.
func TestSubmitSharesStandard_WireLayout(t *testing.T) {
	m := SubmitSharesStandard{
		ChannelID:      1,
		SequenceNumber: 2,
		JobID:          3,
		Nonce:          4,
		NTime:          5,
		NVersion:       0x20000000,
	}
	b, err := m.Encode()
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	if len(b) != 24 {
		t.Fatalf("payload is %d bytes, want 24", len(b))
	}
	for i, want := range []uint32{1, 2, 3, 4, 5, 0x20000000} {
		if got := binary.LittleEndian.Uint32(b[i*4 : i*4+4]); got != want {
			t.Errorf("field %d at offset %d = %d, want %d", i, i*4, got, want)
		}
	}
}

// TestChannelMessagesCarryChannelIDFirst checks the framing rule that goes
// with the channel_msg bit: when it is set, the first four payload bytes
// are the channel_id.
func TestChannelMessagesCarryChannelIDFirst(t *testing.T) {
	const chanID = uint32(0xA1B2C3D4)
	encoders := map[string]func() ([]byte, error){
		"NewMiningJob":         NewMiningJob{ChannelID: chanID}.Encode,
		"SetNewPrevHash":       SetNewPrevHash{ChannelID: chanID}.Encode,
		"SetTarget":            SetTarget{ChannelID: chanID}.Encode,
		"SubmitSharesStandard": SubmitSharesStandard{ChannelID: chanID}.Encode,
		"SubmitSharesSuccess":  SubmitSharesSuccess{ChannelID: chanID}.Encode,
		"SubmitSharesError":    SubmitSharesError{ChannelID: chanID}.Encode,
	}
	for name, enc := range encoders {
		b, err := enc()
		if err != nil {
			t.Errorf("%s: Encode: %v", name, err)
			continue
		}
		if len(b) < 4 || binary.LittleEndian.Uint32(b[0:4]) != chanID {
			t.Errorf("%s: payload does not start with channel_id", name)
		}
	}

	// And the frame header's channel_msg bit is bit 15 of extension_type.
	f, err := WrapMessage(MsgSubmitSharesStandard, true, make([]byte, 24))
	if err != nil {
		t.Fatalf("WrapMessage: %v", err)
	}
	if f.Header.ExtensionType != 0x8000 {
		t.Errorf("extension_type = 0x%04x, want 0x8000 (channel_msg is bit 15)", f.Header.ExtensionType)
	}
	if !f.Header.ChannelMsg() {
		t.Error("ChannelMsg() = false for a frame wrapped as a channel message")
	}
}

// TestSplitEndpoint covers the host/port split SetupConnection needs,
// including the addresses that must not break a handshake.
func TestSplitEndpoint(t *testing.T) {
	tests := []struct {
		in       string
		wantHost string
		wantPort uint16
	}{
		{"pool.example.com:3336", "pool.example.com", 3336},
		{"127.0.0.1:3333", "127.0.0.1", 3333},
		{"[2001:db8::1]:3333", "2001:db8::1", 3333},
		{"pool.example.com", "pool.example.com", 0}, // no port: not fatal
		{"pool.example.com:notaport", "pool.example.com", 0},
		{"pool.example.com:99999", "pool.example.com", 0}, // out of U16 range
		{"", "", 0},
	}
	for _, tt := range tests {
		host, port := SplitEndpoint(tt.in)
		if host != tt.wantHost || port != tt.wantPort {
			t.Errorf("SplitEndpoint(%q) = (%q, %d), want (%q, %d)",
				tt.in, host, port, tt.wantHost, tt.wantPort)
		}
	}
}
