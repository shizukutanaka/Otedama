// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package stratum

import (
	"bytes"
	"encoding/binary"
	"testing"
)

// ----- SetupConnection -----

func TestSetupConnection_Roundtrip(t *testing.T) {
	orig := SetupConnection{
		Protocol:        MiningProtocol,
		MinVersion:      2,
		MaxVersion:      2,
		Flags:           0,
		Endpoint:        "pool.example.com:3336",
		Vendor:          "Otedama",
		HardwareVersion: "v3.0.0",
		Firmware:        "main",
		DeviceID:        "cpu-0",
	}
	payload, err := orig.Encode()
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	got, err := DecodeSetupConnection(payload)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if got.Protocol != orig.Protocol {
		t.Errorf("Protocol: got %d, want %d", got.Protocol, orig.Protocol)
	}
	if got.MinVersion != orig.MinVersion || got.MaxVersion != orig.MaxVersion {
		t.Errorf("Version: got %d/%d, want %d/%d", got.MinVersion, got.MaxVersion, orig.MinVersion, orig.MaxVersion)
	}
	if got.Endpoint != orig.Endpoint {
		t.Errorf("Endpoint: got %q, want %q", got.Endpoint, orig.Endpoint)
	}
	if got.DeviceID != orig.DeviceID {
		t.Errorf("DeviceID: got %q, want %q", got.DeviceID, orig.DeviceID)
	}
}

func TestSetupConnection_EmptyStrings(t *testing.T) {
	orig := SetupConnection{Protocol: MiningProtocol, MinVersion: 2, MaxVersion: 2}
	payload, err := orig.Encode()
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	got, err := DecodeSetupConnection(payload)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if got.Endpoint != "" || got.Vendor != "" {
		t.Errorf("empty strings not preserved: Endpoint=%q Vendor=%q", got.Endpoint, got.Vendor)
	}
}

func TestSetupConnection_StringTooLong(t *testing.T) {
	m := SetupConnection{
		Protocol: MiningProtocol,
		Endpoint: string(make([]byte, 256)), // 256 > 255 max
	}
	if _, err := m.Encode(); err == nil {
		t.Error("Encode accepted string > 255 bytes")
	}
}

func TestDecodeSetupConnection_Truncated(t *testing.T) {
	orig := SetupConnection{Protocol: MiningProtocol, MinVersion: 2, MaxVersion: 2}
	payload, _ := orig.Encode()
	// truncate to half
	if _, err := DecodeSetupConnection(payload[:len(payload)/2]); err == nil {
		t.Error("Decode accepted truncated payload")
	}
}

func TestValidateSetupConnection(t *testing.T) {
	good := SetupConnection{Protocol: MiningProtocol, MinVersion: 2, MaxVersion: 2}
	if err := ValidateSetupConnection(good); err != nil {
		t.Errorf("valid SetupConnection rejected: %v", err)
	}

	badProto := SetupConnection{Protocol: Protocol(99), MinVersion: 2, MaxVersion: 2}
	if err := ValidateSetupConnection(badProto); err == nil {
		t.Error("unknown protocol accepted")
	}

	badVersion := SetupConnection{Protocol: MiningProtocol, MinVersion: 3, MaxVersion: 2}
	if err := ValidateSetupConnection(badVersion); err == nil {
		t.Error("min > max version accepted")
	}
}

// ----- SetupConnectionSuccess -----

func TestSetupConnectionSuccess_Roundtrip(t *testing.T) {
	orig := SetupConnectionSuccess{UsedVersion: 2, Flags: 0x0001}
	payload, _ := orig.Encode()
	got, err := DecodeSetupConnectionSuccess(payload)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if got != orig {
		t.Errorf("got %+v, want %+v", got, orig)
	}
}

func TestDecodeSetupConnectionSuccess_Short(t *testing.T) {
	if _, err := DecodeSetupConnectionSuccess([]byte{0x01, 0x02}); err == nil {
		t.Error("short payload accepted")
	}
}

// ----- SetupConnectionError -----

func TestSetupConnectionError_Roundtrip(t *testing.T) {
	orig := SetupConnectionError{Flags: 0, Error: "unsupported-version"}
	payload, _ := orig.Encode()
	got, err := DecodeSetupConnectionError(payload)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if got.Error != orig.Error {
		t.Errorf("Error: got %q, want %q", got.Error, orig.Error)
	}
}

// ----- OpenMiningChannel -----

func TestOpenMiningChannel_Roundtrip(t *testing.T) {
	orig := OpenMiningChannel{
		ReqID:           42,
		User:            "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
		NominalHashrate: 1e6, // 1 MH/s
	}
	payload, err := orig.Encode()
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	got, err := DecodeOpenMiningChannel(payload)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if got.ReqID != orig.ReqID {
		t.Errorf("ReqID: got %d, want %d", got.ReqID, orig.ReqID)
	}
	if got.User != orig.User {
		t.Errorf("User: got %q, want %q", got.User, orig.User)
	}
	// float32 may differ slightly; we accept within 1%
	if diff := got.NominalHashrate - orig.NominalHashrate; diff > 1e4 || diff < -1e4 {
		t.Errorf("NominalHashrate: got %f, want %f", got.NominalHashrate, orig.NominalHashrate)
	}
}

// ----- OpenMiningChannelSuccess -----

func TestOpenMiningChannelSuccess_Roundtrip(t *testing.T) {
	orig := OpenMiningChannelSuccess{
		ReqID:           42,
		ChannelID:       1,
		ExtraNonce2Size: 4,
	}
	// Set a non-zero target
	for i := range orig.Target {
		orig.Target[i] = byte(i)
	}
	orig.Extranonce = []byte{0xDE, 0xAD, 0xBE, 0xEF}

	payload, err := orig.Encode()
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	got, err := DecodeOpenMiningChannelSuccess(payload)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if got.ReqID != orig.ReqID || got.ChannelID != orig.ChannelID {
		t.Errorf("IDs mismatch: got req=%d chan=%d, want req=%d chan=%d",
			got.ReqID, got.ChannelID, orig.ReqID, orig.ChannelID)
	}
	if got.Target != orig.Target {
		t.Error("Target mismatch")
	}
	if !bytes.Equal(got.Extranonce, orig.Extranonce) {
		t.Errorf("Extranonce: got %X, want %X", got.Extranonce, orig.Extranonce)
	}
	if got.ExtraNonce2Size != orig.ExtraNonce2Size {
		t.Errorf("ExtraNonce2Size: got %d, want %d", got.ExtraNonce2Size, orig.ExtraNonce2Size)
	}
}

// ----- NewMiningJob -----

func TestNewMiningJob_Roundtrip(t *testing.T) {
	orig := NewMiningJob{
		ChannelID: 1,
		JobID:     7,
		MinNtime:  0x60000000,
		NBits:     0x17130000,
	}
	for i := range orig.MerkleRoot {
		orig.MerkleRoot[i] = byte(255 - i)
	}
	payload, err := orig.Encode()
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	got, err := DecodeNewMiningJob(payload)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if got.ChannelID != orig.ChannelID || got.JobID != orig.JobID {
		t.Errorf("IDs: got %+v, want %+v", got, orig)
	}
	if got.MerkleRoot != orig.MerkleRoot {
		t.Error("MerkleRoot mismatch")
	}
	if got.NBits != orig.NBits {
		t.Errorf("NBits: got 0x%08X, want 0x%08X", got.NBits, orig.NBits)
	}
}

func TestDecodeNewMiningJob_Short(t *testing.T) {
	if _, err := DecodeNewMiningJob(make([]byte, 10)); err == nil {
		t.Error("short payload accepted")
	}
}

// ----- SubmitSharesStandard -----

func TestSubmitSharesStandard_Roundtrip(t *testing.T) {
	orig := SubmitSharesStandard{
		ChannelID:      1,
		SequenceNumber: 3,
		JobID:          7,
		Nonce:          0xDEADBEEF,
		NTime:          0x60000001,
		NVersion:       0x20000000,
	}
	payload, err := orig.Encode()
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	got, err := DecodeSubmitSharesStandard(payload)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if got != orig {
		t.Errorf("got %+v, want %+v", got, orig)
	}
}

// ----- SubmitSharesSuccess -----

func TestDecodeSubmitSharesSuccess_Basic(t *testing.T) {
	buf := make([]byte, 16)
	binary.LittleEndian.PutUint32(buf[0:4], 1)   // ChannelID
	binary.LittleEndian.PutUint32(buf[4:8], 3)   // LastSeq
	binary.LittleEndian.PutUint32(buf[8:12], 2)  // Accepted
	binary.LittleEndian.PutUint32(buf[12:16], 5) // Summed

	got, err := DecodeSubmitSharesSuccess(buf)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if got.ChannelID != 1 || got.LastSequenceNumber != 3 {
		t.Errorf("got %+v", got)
	}
}

// ----- DispatchFrame -----

func TestDispatchFrame_SetupConnectionSuccess(t *testing.T) {
	orig := SetupConnectionSuccess{UsedVersion: 2}
	payload, _ := orig.Encode()
	f := Frame{
		Header:  Header{MsgType: MsgSetupConnectionSuccess, MsgLength: uint32(len(payload))},
		Payload: payload,
	}
	msg, err := DispatchFrame(f)
	if err != nil {
		t.Fatalf("DispatchFrame: %v", err)
	}
	if msg.SetupConnectionSuccess == nil {
		t.Fatal("expected SetupConnectionSuccess to be populated")
	}
	if msg.SetupConnectionSuccess.UsedVersion != 2 {
		t.Errorf("UsedVersion: got %d, want 2", msg.SetupConnectionSuccess.UsedVersion)
	}
}

func TestDispatchFrame_UnknownMsgType(t *testing.T) {
	f := Frame{
		Header:  Header{MsgType: 0xFF, MsgLength: 3},
		Payload: []byte{0x01, 0x02, 0x03},
	}
	msg, err := DispatchFrame(f)
	if err != nil {
		t.Fatalf("DispatchFrame should not fail on unknown: %v", err)
	}
	if msg.Unknown == nil {
		t.Fatal("expected Unknown to be populated")
	}
	if msg.Unknown.MsgType != 0xFF {
		t.Errorf("Unknown.MsgType: got 0x%02X, want 0xFF", msg.Unknown.MsgType)
	}
}

func TestWrapMessage_ChannelMsg(t *testing.T) {
	payload := make([]byte, 24) // SubmitSharesStandard length
	f, err := WrapMessage(MsgSubmitSharesStandard, true, payload)
	if err != nil {
		t.Fatalf("WrapMessage: %v", err)
	}
	if !f.Header.ChannelMsg() {
		t.Error("channel_msg bit not set for channel message")
	}
	if f.Header.MsgType != MsgSubmitSharesStandard {
		t.Errorf("MsgType: got 0x%02X, want 0x%02X", f.Header.MsgType, MsgSubmitSharesStandard)
	}
}

func TestWrapMessage_NonChannelMsg(t *testing.T) {
	payload, _ := (SetupConnection{Protocol: MiningProtocol, MinVersion: 2, MaxVersion: 2}).Encode()
	f, err := WrapMessage(MsgSetupConnection, false, payload)
	if err != nil {
		t.Fatalf("WrapMessage: %v", err)
	}
	if f.Header.ChannelMsg() {
		t.Error("channel_msg bit set on non-channel message")
	}
}

// ----- float32 encoding consistency -----

func TestFloat32Encoding(t *testing.T) {
	// Verify float32bits / float32frombits are inverses.
	values := []float32{0, 1, 1e6, 3.14159, -1, 1e12}
	for _, v := range values {
		bits := float32bits(v)
		back := float32frombits(bits)
		if v != back {
			t.Errorf("float32 roundtrip: %f -> 0x%08X -> %f", v, bits, back)
		}
	}
}

// ----- SubmitSharesSuccess.Encode -----

func TestSubmitSharesSuccess_Encode_Roundtrip(t *testing.T) {
	orig := SubmitSharesSuccess{
		ChannelID:          7,
		LastSequenceNumber: 99,
		NewSubmitsAccepted: 3,
		NewSharesSummed:    10,
	}
	payload, err := orig.Encode()
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	got, err := DecodeSubmitSharesSuccess(payload)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if got != orig {
		t.Errorf("roundtrip mismatch: got %+v, want %+v", got, orig)
	}
}

func TestSubmitSharesSuccess_Encode_ShortPayload(t *testing.T) {
	_, err := DecodeSubmitSharesSuccess(make([]byte, 3))
	if err == nil {
		t.Error("DecodeSubmitSharesSuccess(3 bytes) should error")
	}
}

// ----- SubmitSharesError -----

func TestDecodeSubmitSharesError_Basic(t *testing.T) {
	buf := make([]byte, 8)
	binary.LittleEndian.PutUint32(buf[0:4], 5)  // ChannelID
	binary.LittleEndian.PutUint32(buf[4:8], 12) // SequenceNumber

	got, err := DecodeSubmitSharesError(buf)
	if err != nil {
		t.Fatalf("DecodeSubmitSharesError: %v", err)
	}
	if got.ChannelID != 5 || got.SequenceNumber != 12 {
		t.Errorf("got %+v, want ChannelID=5 SequenceNumber=12", got)
	}
	if got.Error != "" {
		t.Errorf("Error = %q, want empty (no string bytes)", got.Error)
	}
}

func TestDecodeSubmitSharesError_WithMessage(t *testing.T) {
	msg := "duplicate share"
	raw := make([]byte, 8, 8+1+len(msg))
	binary.LittleEndian.PutUint32(raw[0:4], 2)
	binary.LittleEndian.PutUint32(raw[4:8], 7)
	raw = append(raw, byte(len(msg)))
	raw = append(raw, []byte(msg)...)

	got, err := DecodeSubmitSharesError(raw)
	if err != nil {
		t.Fatalf("DecodeSubmitSharesError: %v", err)
	}
	if got.Error != msg {
		t.Errorf("Error = %q, want %q", got.Error, msg)
	}
}

func TestDecodeSubmitSharesError_ShortPayload(t *testing.T) {
	_, err := DecodeSubmitSharesError(make([]byte, 4))
	if err == nil {
		t.Error("DecodeSubmitSharesError(4 bytes) should error (need ≥8)")
	}
}

// ----- OpenMiningChannelError -----

func TestDecodeOpenMiningChannelError_Basic(t *testing.T) {
	buf := make([]byte, 4)
	binary.LittleEndian.PutUint32(buf[0:4], 1) // ReqID

	got, err := DecodeOpenMiningChannelError(buf)
	if err != nil {
		t.Fatalf("DecodeOpenMiningChannelError: %v", err)
	}
	if got.ReqID != 1 {
		t.Errorf("ReqID = %d, want 1", got.ReqID)
	}
	if got.Error != "" {
		t.Errorf("Error = %q, want empty", got.Error)
	}
}

func TestDecodeOpenMiningChannelError_WithMessage(t *testing.T) {
	msg := "unauthorized"
	raw := make([]byte, 4, 4+1+len(msg))
	binary.LittleEndian.PutUint32(raw[0:4], 3) // ReqID
	raw = append(raw, byte(len(msg)))
	raw = append(raw, []byte(msg)...)

	got, err := DecodeOpenMiningChannelError(raw)
	if err != nil {
		t.Fatalf("DecodeOpenMiningChannelError: %v", err)
	}
	if got.ReqID != 3 || got.Error != msg {
		t.Errorf("got %+v, want ReqID=3 Error=%q", got, msg)
	}
}

func TestDecodeOpenMiningChannelError_ShortPayload(t *testing.T) {
	_, err := DecodeOpenMiningChannelError(make([]byte, 3))
	if err == nil {
		t.Error("DecodeOpenMiningChannelError(3 bytes) should error (need ≥4)")
	}
}

// ----- DispatchFrame — additional message types -----

func TestDispatchFrame_SubmitSharesSuccess(t *testing.T) {
	orig := SubmitSharesSuccess{ChannelID: 1, LastSequenceNumber: 5, NewSubmitsAccepted: 1, NewSharesSummed: 1}
	payload, _ := orig.Encode()
	f := Frame{Header: Header{MsgType: MsgSubmitSharesSuccess, MsgLength: uint32(len(payload))}, Payload: payload}
	msg, err := DispatchFrame(f)
	if err != nil {
		t.Fatalf("DispatchFrame: %v", err)
	}
	if msg.SubmitSharesSuccess == nil {
		t.Fatal("SubmitSharesSuccess not populated")
	}
	if msg.SubmitSharesSuccess.ChannelID != 1 {
		t.Errorf("ChannelID = %d, want 1", msg.SubmitSharesSuccess.ChannelID)
	}
}

func TestDispatchFrame_SubmitSharesError(t *testing.T) {
	raw := make([]byte, 8)
	binary.LittleEndian.PutUint32(raw[0:4], 2)
	binary.LittleEndian.PutUint32(raw[4:8], 3)
	f := Frame{Header: Header{MsgType: MsgSubmitSharesError, MsgLength: 8}, Payload: raw}
	msg, err := DispatchFrame(f)
	if err != nil {
		t.Fatalf("DispatchFrame: %v", err)
	}
	if msg.SubmitSharesError == nil {
		t.Fatal("SubmitSharesError not populated")
	}
	if msg.SubmitSharesError.ChannelID != 2 {
		t.Errorf("ChannelID = %d, want 2", msg.SubmitSharesError.ChannelID)
	}
}

func TestDispatchFrame_OpenMiningChannelError(t *testing.T) {
	raw := make([]byte, 4)
	binary.LittleEndian.PutUint32(raw[0:4], 9) // ReqID
	f := Frame{Header: Header{MsgType: MsgOpenMiningChannelError, MsgLength: 4}, Payload: raw}
	msg, err := DispatchFrame(f)
	if err != nil {
		t.Fatalf("DispatchFrame: %v", err)
	}
	if msg.OpenMiningChannelError == nil {
		t.Fatal("OpenMiningChannelError not populated")
	}
	if msg.OpenMiningChannelError.ReqID != 9 {
		t.Errorf("ReqID = %d, want 9", msg.OpenMiningChannelError.ReqID)
	}
}

func TestDispatchFrame_SetupConnection(t *testing.T) {
	orig := SetupConnection{Protocol: MiningProtocol, MinVersion: 2, MaxVersion: 2}
	payload, _ := orig.Encode()
	f := Frame{Header: Header{MsgType: MsgSetupConnection, MsgLength: uint32(len(payload))}, Payload: payload}
	msg, err := DispatchFrame(f)
	if err != nil {
		t.Fatalf("DispatchFrame: %v", err)
	}
	if msg.SetupConnection == nil {
		t.Fatal("SetupConnection not populated")
	}
}

func TestDispatchFrame_SetupConnectionError(t *testing.T) {
	orig := SetupConnectionError{Flags: 0, Error: "unsupported version"}
	payload, _ := orig.Encode()
	f := Frame{Header: Header{MsgType: MsgSetupConnectionError, MsgLength: uint32(len(payload))}, Payload: payload}
	msg, err := DispatchFrame(f)
	if err != nil {
		t.Fatalf("DispatchFrame: %v", err)
	}
	if msg.SetupConnectionError == nil {
		t.Fatal("SetupConnectionError not populated")
	}
	if msg.SetupConnectionError.Error != "unsupported version" {
		t.Errorf("Error = %q", msg.SetupConnectionError.Error)
	}
}

func TestDispatchFrame_OpenMiningChannel(t *testing.T) {
	orig := OpenMiningChannel{ReqID: 1, User: "alice", NominalHashrate: 1e6}
	payload, _ := orig.Encode()
	f := Frame{Header: Header{MsgType: MsgOpenMiningChannel, MsgLength: uint32(len(payload))}, Payload: payload}
	msg, err := DispatchFrame(f)
	if err != nil {
		t.Fatalf("DispatchFrame: %v", err)
	}
	if msg.OpenMiningChannel == nil {
		t.Fatal("OpenMiningChannel not populated")
	}
}

func TestDispatchFrame_MalformedKnownMsg_ReturnsError(t *testing.T) {
	// A known message type with a truncated payload must return an error,
	// not silently produce a zero-value message.
	f := Frame{
		Header:  Header{MsgType: MsgSetupConnectionSuccess, MsgLength: 2},
		Payload: []byte{0x01, 0x00}, // too short: need 6 bytes
	}
	_, err := DispatchFrame(f)
	if err == nil {
		t.Error("DispatchFrame with truncated SetupConnectionSuccess payload should error")
	}
}

