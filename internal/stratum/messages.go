// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package stratum — messages.go
//
// This file defines the Stratum V2 Mining Protocol message types and
// their binary (de)serialisation. The Mining Protocol is the V2
// successor of Stratum V1 and is the only sub-protocol Otedama
// implements in v3.0.0. Job Declaration and Template Distribution
// are deferred to a later milestone.
//
// # Message numbering (from the official specification)
//
//	0x00  SetupConnection        (client → server)
//	0x01  SetupConnectionSuccess (server → client)
//	0x02  SetupConnectionError   (server → client)
//	0x10  OpenMiningChannel      (client → server)
//	0x11  OpenMiningChannelSuccess
//	0x12  OpenMiningChannelError
//	0x15  NewMiningJob           (server → client, channel_msg)
//	0x1a  SubmitSharesStandard   (client → server, channel_msg)
//	0x1c  SubmitSharesSuccess    (server → client, channel_msg)
//	0x1e  SubmitSharesError      (server → client, channel_msg)
//
// # Encoding conventions (from spec chapter 3)
//
//	All integers: little-endian.
//	BOOL:   1 byte, 0x00 false / 0x01 true.
//	STR0_255: 1-byte length prefix followed by UTF-8 bytes (max 255).
//	B0_255:   1-byte length prefix followed by raw bytes (max 255).
//	B0_32:    32 raw bytes (fixed, no length prefix).
//	B0_16M:  3-byte little-endian length prefix followed by raw bytes.
//
// Otedama does not implement all fields of every message; fields that
// are not used in the home-mining use-case are present as zero values
// and correctly serialised/deserialised so that interoperability with
// compliant pools is maintained.
package stratum

import (
	"bytes"
	"encoding/binary"
	"fmt"
)

// msg_type constants for Mining Protocol messages.
const (
	MsgSetupConnection          uint8 = 0x00
	MsgSetupConnectionSuccess   uint8 = 0x01
	MsgSetupConnectionError     uint8 = 0x02
	MsgOpenMiningChannel        uint8 = 0x10
	MsgOpenMiningChannelSuccess uint8 = 0x11
	MsgOpenMiningChannelError   uint8 = 0x12
	MsgNewMiningJob             uint8 = 0x15
	MsgSubmitSharesStandard     uint8 = 0x1a
	MsgSubmitSharesSuccess      uint8 = 0x1c
	MsgSubmitSharesError        uint8 = 0x1e
)

// Protocol identifies which sub-protocol is being negotiated.
// Otedama uses MiningProtocol exclusively.
type Protocol uint8

const (
	MiningProtocol Protocol = 0
)

// ------------------------------------------------------------------
// NewMiningJob (server → client, msg_type 0x15, channel_msg)
// ------------------------------------------------------------------

// NewMiningJob carries a new block template for the miner to work on.
// It is a channel_msg: the first four bytes of the payload are channel_id.
type NewMiningJob struct {
	ChannelID  uint32
	JobID      uint32
	MinNtime   uint32   // nTime lower bound
	NBits      uint32   // compact target
	MerkleRoot [32]byte // B0_32
}

// Encode serialises NewMiningJob (includes channel_id prefix).
func (m NewMiningJob) Encode() ([]byte, error) {
	buf := make([]byte, 4+4+4+4+32)
	binary.LittleEndian.PutUint32(buf[0:4], m.ChannelID)
	binary.LittleEndian.PutUint32(buf[4:8], m.JobID)
	binary.LittleEndian.PutUint32(buf[8:12], m.MinNtime)
	binary.LittleEndian.PutUint32(buf[12:16], m.NBits)
	copy(buf[16:48], m.MerkleRoot[:])
	return buf, nil
}

// DecodeNewMiningJob parses a NewMiningJob payload (channel_id included).
func DecodeNewMiningJob(payload []byte) (NewMiningJob, error) {
	const need = 4 + 4 + 4 + 4 + 32
	if len(payload) < need {
		return NewMiningJob{}, fmt.Errorf("stratum: NewMiningJob: short payload (%d < %d)", len(payload), need)
	}
	var m NewMiningJob
	m.ChannelID = binary.LittleEndian.Uint32(payload[0:4])
	m.JobID = binary.LittleEndian.Uint32(payload[4:8])
	m.MinNtime = binary.LittleEndian.Uint32(payload[8:12])
	m.NBits = binary.LittleEndian.Uint32(payload[12:16])
	copy(m.MerkleRoot[:], payload[16:48])
	return m, nil
}

// ------------------------------------------------------------------
// SubmitSharesStandard (client → server, msg_type 0x1a, channel_msg)
// ------------------------------------------------------------------

// SubmitSharesStandard carries a miner's share submission.
type SubmitSharesStandard struct {
	ChannelID      uint32
	SequenceNumber uint32
	JobID          uint32
	Nonce          uint32
	NTime          uint32
	NVersion       uint32
}

// Encode serialises SubmitSharesStandard.
func (m SubmitSharesStandard) Encode() ([]byte, error) {
	buf := make([]byte, 24)
	binary.LittleEndian.PutUint32(buf[0:4], m.ChannelID)
	binary.LittleEndian.PutUint32(buf[4:8], m.SequenceNumber)
	binary.LittleEndian.PutUint32(buf[8:12], m.JobID)
	binary.LittleEndian.PutUint32(buf[12:16], m.Nonce)
	binary.LittleEndian.PutUint32(buf[16:20], m.NTime)
	binary.LittleEndian.PutUint32(buf[20:24], m.NVersion)
	return buf, nil
}

// DecodeSubmitSharesStandard parses a SubmitSharesStandard payload.
func DecodeSubmitSharesStandard(payload []byte) (SubmitSharesStandard, error) {
	if len(payload) < 24 {
		return SubmitSharesStandard{}, fmt.Errorf("stratum: SubmitSharesStandard: short payload (%d < 24)", len(payload))
	}
	return SubmitSharesStandard{
		ChannelID:      binary.LittleEndian.Uint32(payload[0:4]),
		SequenceNumber: binary.LittleEndian.Uint32(payload[4:8]),
		JobID:          binary.LittleEndian.Uint32(payload[8:12]),
		Nonce:          binary.LittleEndian.Uint32(payload[12:16]),
		NTime:          binary.LittleEndian.Uint32(payload[16:20]),
		NVersion:       binary.LittleEndian.Uint32(payload[20:24]),
	}, nil
}

// ------------------------------------------------------------------
// SubmitSharesSuccess (server → client, msg_type 0x1c, channel_msg)
// ------------------------------------------------------------------

// SubmitSharesSuccess acknowledges accepted shares.
type SubmitSharesSuccess struct {
	ChannelID          uint32
	LastSequenceNumber uint32
	NewSubmitsAccepted uint32
	NewSharesSummed    uint32
}

// Encode serialises SubmitSharesSuccess. It is the symmetric inverse of
// DecodeSubmitSharesSuccess, used by the server side (and tests that stand
// in for a pool) to acknowledge accepted shares.
func (m SubmitSharesSuccess) Encode() ([]byte, error) {
	buf := make([]byte, 16)
	binary.LittleEndian.PutUint32(buf[0:4], m.ChannelID)
	binary.LittleEndian.PutUint32(buf[4:8], m.LastSequenceNumber)
	binary.LittleEndian.PutUint32(buf[8:12], m.NewSubmitsAccepted)
	binary.LittleEndian.PutUint32(buf[12:16], m.NewSharesSummed)
	return buf, nil
}

// DecodeSubmitSharesSuccess parses a SubmitSharesSuccess payload.
func DecodeSubmitSharesSuccess(payload []byte) (SubmitSharesSuccess, error) {
	if len(payload) < 16 {
		return SubmitSharesSuccess{}, fmt.Errorf("stratum: SubmitSharesSuccess: short payload (%d < 16)", len(payload))
	}
	return SubmitSharesSuccess{
		ChannelID:          binary.LittleEndian.Uint32(payload[0:4]),
		LastSequenceNumber: binary.LittleEndian.Uint32(payload[4:8]),
		NewSubmitsAccepted: binary.LittleEndian.Uint32(payload[8:12]),
		NewSharesSummed:    binary.LittleEndian.Uint32(payload[12:16]),
	}, nil
}

// ------------------------------------------------------------------
// SubmitSharesError (server → client, msg_type 0x1e, channel_msg)
// ------------------------------------------------------------------

// SubmitSharesError is returned when the pool rejects a share.
type SubmitSharesError struct {
	ChannelID      uint32
	SequenceNumber uint32
	Error          string // STR0_255
}

// Encode serialises SubmitSharesError (symmetric inverse of DecodeSubmitSharesError).
func (m SubmitSharesError) Encode() ([]byte, error) {
	var buf bytes.Buffer
	w := &byteWriter{&buf}
	if err := putU32LE(w, m.ChannelID); err != nil {
		return nil, err
	}
	if err := putU32LE(w, m.SequenceNumber); err != nil {
		return nil, err
	}
	if err := putStr0_255(w, m.Error); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// DecodeSubmitSharesError parses a SubmitSharesError payload.
func DecodeSubmitSharesError(payload []byte) (SubmitSharesError, error) {
	if len(payload) < 8 {
		return SubmitSharesError{}, fmt.Errorf("stratum: SubmitSharesError: short payload (%d < 8)", len(payload))
	}
	m := SubmitSharesError{
		ChannelID:      binary.LittleEndian.Uint32(payload[0:4]),
		SequenceNumber: binary.LittleEndian.Uint32(payload[4:8]),
	}
	if len(payload) > 8 {
		r := newByteReader(payload[8:])
		var err error
		if m.Error, err = getStr0_255(r); err != nil {
			return m, err
		}
	}
	return m, nil
}

// ------------------------------------------------------------------
// Helper: wrap a message in a Frame
// ------------------------------------------------------------------

// WrapMessage creates a Frame for the given message type and encoded payload.
// For channel messages, the payload must already include the 4-byte channel_id
// prefix (it is part of the encoded payload, not the frame header).
func WrapMessage(msgType uint8, isChannelMsg bool, payload []byte) (Frame, error) {
	ext := uint16(0)
	if isChannelMsg {
		ext = channelMsgBit
	}
	h := Header{
		ExtensionType: ext,
		MsgType:       msgType,
		MsgLength:     uint32(len(payload)),
	}
	if err := h.Validate(); err != nil {
		return Frame{}, err
	}
	return Frame{Header: h, Payload: payload}, nil
}

// ------------------------------------------------------------------
// DispatchFrame decodes a frame into a concrete message type.
// ------------------------------------------------------------------

// Message is a sum type over all decoded Mining Protocol messages.
type Message struct {
	SetupConnection          *SetupConnection
	SetupConnectionSuccess   *SetupConnectionSuccess
	SetupConnectionError     *SetupConnectionError
	OpenMiningChannel        *OpenMiningChannel
	OpenMiningChannelSuccess *OpenMiningChannelSuccess
	OpenMiningChannelError   *OpenMiningChannelError
	NewMiningJob             *NewMiningJob
	SubmitSharesStandard     *SubmitSharesStandard
	SubmitSharesSuccess      *SubmitSharesSuccess
	SubmitSharesError        *SubmitSharesError
	Unknown                  *UnknownMessage
}

// UnknownMessage wraps a frame whose msg_type is not recognised.
type UnknownMessage struct {
	MsgType uint8
	Payload []byte
}

// DispatchFrame decodes the payload of f into the appropriate Message field.
//
// DispatchFrame never returns an error for unknown message types; instead
// it populates Message.Unknown. This ensures the client loop can continue
// operating after receiving extension messages it has not yet implemented,
// which is a requirement for forward compatibility with future pool software.
func DispatchFrame(f Frame) (Message, error) {
	var m Message
	switch f.Header.MsgType {
	case MsgSetupConnection:
		v, err := DecodeSetupConnection(f.Payload)
		if err != nil {
			return m, err
		}
		m.SetupConnection = &v
	case MsgSetupConnectionSuccess:
		v, err := DecodeSetupConnectionSuccess(f.Payload)
		if err != nil {
			return m, err
		}
		m.SetupConnectionSuccess = &v
	case MsgSetupConnectionError:
		v, err := DecodeSetupConnectionError(f.Payload)
		if err != nil {
			return m, err
		}
		m.SetupConnectionError = &v
	case MsgOpenMiningChannel:
		v, err := DecodeOpenMiningChannel(f.Payload)
		if err != nil {
			return m, err
		}
		m.OpenMiningChannel = &v
	case MsgOpenMiningChannelSuccess:
		v, err := DecodeOpenMiningChannelSuccess(f.Payload)
		if err != nil {
			return m, err
		}
		m.OpenMiningChannelSuccess = &v
	case MsgOpenMiningChannelError:
		v, err := DecodeOpenMiningChannelError(f.Payload)
		if err != nil {
			return m, err
		}
		m.OpenMiningChannelError = &v
	case MsgNewMiningJob:
		v, err := DecodeNewMiningJob(f.Payload)
		if err != nil {
			return m, err
		}
		m.NewMiningJob = &v
	case MsgSubmitSharesStandard:
		v, err := DecodeSubmitSharesStandard(f.Payload)
		if err != nil {
			return m, err
		}
		m.SubmitSharesStandard = &v
	case MsgSubmitSharesSuccess:
		v, err := DecodeSubmitSharesSuccess(f.Payload)
		if err != nil {
			return m, err
		}
		m.SubmitSharesSuccess = &v
	case MsgSubmitSharesError:
		v, err := DecodeSubmitSharesError(f.Payload)
		if err != nil {
			return m, err
		}
		m.SubmitSharesError = &v
	default:
		m.Unknown = &UnknownMessage{MsgType: f.Header.MsgType, Payload: f.Payload}
	}
	return m, nil
}

// ------------------------------------------------------------------
// Validation helpers
// ------------------------------------------------------------------

// ValidateSetupConnection checks semantic constraints beyond byte format.
func ValidateSetupConnection(m SetupConnection) error {
	if m.Protocol != MiningProtocol {
		return fmt.Errorf("stratum: unsupported protocol %d (only MiningProtocol=0 supported)", m.Protocol)
	}
	if m.MinVersion > m.MaxVersion {
		return fmt.Errorf("stratum: MinVersion %d > MaxVersion %d", m.MinVersion, m.MaxVersion)
	}
	return nil
}
