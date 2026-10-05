// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package stratum — messages.go
//
// This file defines the Stratum V2 Mining Protocol message types and
// their binary (de)serialization. The Mining Protocol is the V2
// successor of Stratum V1 and is the only sub-protocol Otedama
// implements in v3.0.0. Job Declaration and Template Distribution
// are deferred to a later milestone.
//
// The specification's source of truth is the independently-versioned
// repository github.com/stratum-mining/sv2-spec (SRI split the roles
// code out after v1.5.0); stratumprotocol.org renders it. When the
// codec and the site disagree, trust the repo.
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
// and correctly serialized/deserialised so that interoperability with
// compliant pools is maintained.
package stratum

import (
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
	MsgCloseChannel             uint8 = 0x18
	MsgSubmitSharesStandard     uint8 = 0x1a
	MsgSubmitSharesSuccess      uint8 = 0x1c
	MsgSubmitSharesError        uint8 = 0x1e
	MsgSetNewPrevHash           uint8 = 0x20
	MsgSetTarget                uint8 = 0x21
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
//
// Wire layout (Stratum V2 Mining Protocol, msg_type 0x15):
//
//	channel_id  U32
//	job_id      U32
//	ntime_start   OPTION[u32]  (1-byte 0/1 count, then the u32 if present)
//	version     U32          (block-header version the miner must hash)
//	merkle_root B32          (32 bytes)
//
// An ABSENT ntime_start marks a *future job*: it must not be mined until a
// SetNewPrevHash arrives naming this job_id (which supplies the ntime).
// A PRESENT ntime_start marks a job valid against the already-known
// prev-hash. Note there is deliberately no nBits here — the network
// target always arrives via SetNewPrevHash, and the share target via
// SetTarget / OpenMiningChannelSuccess.
type NewMiningJob struct {
	ChannelID     uint32
	JobID         uint32
	HasNtimeStart bool   // whether the OPTION[u32] ntime_start is present
	NtimeStart    uint32 // nTime lower bound; meaningful only if HasNtimeStart
	Version       uint32 // block-header version
	MerkleRoot    [32]byte
}

// Encode serializes NewMiningJob (includes channel_id prefix).
func (m NewMiningJob) Encode() ([]byte, error) {
	size := 4 + 4 + 1 + 4 + 32
	if m.HasNtimeStart {
		size += 4
	}
	buf := make([]byte, 0, size)
	var u32 [4]byte
	binary.LittleEndian.PutUint32(u32[:], m.ChannelID)
	buf = append(buf, u32[:]...)
	binary.LittleEndian.PutUint32(u32[:], m.JobID)
	buf = append(buf, u32[:]...)
	if m.HasNtimeStart {
		buf = append(buf, 1)
		binary.LittleEndian.PutUint32(u32[:], m.NtimeStart)
		buf = append(buf, u32[:]...)
	} else {
		buf = append(buf, 0)
	}
	binary.LittleEndian.PutUint32(u32[:], m.Version)
	buf = append(buf, u32[:]...)
	buf = append(buf, m.MerkleRoot[:]...)
	return buf, nil
}

// DecodeNewMiningJob parses a NewMiningJob payload (channel_id included).
func DecodeNewMiningJob(payload []byte) (NewMiningJob, error) {
	// Minimum size: absent ntime_start → 4+4+1+4+32.
	const minNeed = 4 + 4 + 1 + 4 + 32
	if len(payload) < minNeed {
		return NewMiningJob{}, fmt.Errorf("stratum: NewMiningJob: short payload (%d < %d)", len(payload), minNeed)
	}
	var m NewMiningJob
	m.ChannelID = binary.LittleEndian.Uint32(payload[0:4])
	m.JobID = binary.LittleEndian.Uint32(payload[4:8])
	off := 8
	switch payload[off] {
	case 0:
		off++
	case 1:
		off++
		if len(payload) < off+4+4+32 {
			return NewMiningJob{}, fmt.Errorf("stratum: NewMiningJob: short payload for present ntime_start (%d)", len(payload))
		}
		m.HasNtimeStart = true
		m.NtimeStart = binary.LittleEndian.Uint32(payload[off : off+4])
		off += 4
	default:
		return NewMiningJob{}, fmt.Errorf("stratum: NewMiningJob: invalid OPTION count %d for ntime_start", payload[off])
	}
	m.Version = binary.LittleEndian.Uint32(payload[off : off+4])
	off += 4
	copy(m.MerkleRoot[:], payload[off:off+32])
	return m, nil
}

// ------------------------------------------------------------------
// SetNewPrevHash (server → client, msg_type 0x20, channel_msg)
// ------------------------------------------------------------------

// SetNewPrevHash announces the new chain tip after a block is found.
// It activates the future job named by JobID and invalidates all other
// outstanding jobs on the channel. Until the first SetNewPrevHash
// arrives, the miner does not know prev_hash or the network nBits and
// MUST NOT hash anything.
//
// Wire layout: channel_id U32, job_id U32, prev_hash U256,
// ntime_start U32, nbits U32.
type SetNewPrevHash struct {
	ChannelID  uint32
	JobID      uint32   // the job this prev-hash activates
	PrevHash   [32]byte // U256, little-endian (header wire order)
	NtimeStart uint32
	NBits      uint32 // network compact target
}

// Encode serializes SetNewPrevHash (includes channel_id prefix).
func (m SetNewPrevHash) Encode() ([]byte, error) {
	buf := make([]byte, 4+4+32+4+4)
	binary.LittleEndian.PutUint32(buf[0:4], m.ChannelID)
	binary.LittleEndian.PutUint32(buf[4:8], m.JobID)
	copy(buf[8:40], m.PrevHash[:])
	binary.LittleEndian.PutUint32(buf[40:44], m.NtimeStart)
	binary.LittleEndian.PutUint32(buf[44:48], m.NBits)
	return buf, nil
}

// DecodeSetNewPrevHash parses a SetNewPrevHash payload.
func DecodeSetNewPrevHash(payload []byte) (SetNewPrevHash, error) {
	const need = 4 + 4 + 32 + 4 + 4
	if len(payload) < need {
		return SetNewPrevHash{}, fmt.Errorf("stratum: SetNewPrevHash: short payload (%d < %d)", len(payload), need)
	}
	var m SetNewPrevHash
	m.ChannelID = binary.LittleEndian.Uint32(payload[0:4])
	m.JobID = binary.LittleEndian.Uint32(payload[4:8])
	copy(m.PrevHash[:], payload[8:40])
	m.NtimeStart = binary.LittleEndian.Uint32(payload[40:44])
	m.NBits = binary.LittleEndian.Uint32(payload[44:48])
	return m, nil
}

// ------------------------------------------------------------------
// SetTarget (server → client, msg_type 0x21, channel_msg)
// ------------------------------------------------------------------

// SetTarget updates the channel's share target: any header hash
// numerically ≤ Target is a valid share. This is the pool-controlled
// difficulty knob; it replaces the initial target delivered in
// OpenMiningChannelSuccess.
//
// Wire layout: channel_id U32, target U256.
type SetTarget struct {
	ChannelID uint32
	Target    [32]byte // U256, same byte order as miner.Hash (LE, MSB at [31])
}

// Encode serializes SetTarget (includes channel_id prefix).
func (m SetTarget) Encode() ([]byte, error) {
	buf := make([]byte, 4+32)
	binary.LittleEndian.PutUint32(buf[0:4], m.ChannelID)
	copy(buf[4:36], m.Target[:])
	return buf, nil
}

// DecodeSetTarget parses a SetTarget payload.
func DecodeSetTarget(payload []byte) (SetTarget, error) {
	const need = 4 + 32
	if len(payload) < need {
		return SetTarget{}, fmt.Errorf("stratum: SetTarget: short payload (%d < %d)", len(payload), need)
	}
	var m SetTarget
	m.ChannelID = binary.LittleEndian.Uint32(payload[0:4])
	copy(m.Target[:], payload[4:36])
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

// Encode serializes SubmitSharesStandard.
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
	NewSharesSummed    uint64
}

// Encode serializes SubmitSharesSuccess. It is the symmetric inverse of
// DecodeSubmitSharesSuccess, used by the server side (and tests that stand
// in for a pool) to acknowledge accepted shares.
func (m SubmitSharesSuccess) Encode() ([]byte, error) {
	buf := make([]byte, 20)
	binary.LittleEndian.PutUint32(buf[0:4], m.ChannelID)
	binary.LittleEndian.PutUint32(buf[4:8], m.LastSequenceNumber)
	binary.LittleEndian.PutUint32(buf[8:12], m.NewSubmitsAccepted)
	binary.LittleEndian.PutUint64(buf[12:20], m.NewSharesSummed)
	return buf, nil
}

// DecodeSubmitSharesSuccess parses a SubmitSharesSuccess payload.
func DecodeSubmitSharesSuccess(payload []byte) (SubmitSharesSuccess, error) {
	if len(payload) < 20 {
		return SubmitSharesSuccess{}, fmt.Errorf("stratum: SubmitSharesSuccess: short payload (%d < 20)", len(payload))
	}
	return SubmitSharesSuccess{
		ChannelID:          binary.LittleEndian.Uint32(payload[0:4]),
		LastSequenceNumber: binary.LittleEndian.Uint32(payload[4:8]),
		NewSubmitsAccepted: binary.LittleEndian.Uint32(payload[8:12]),
		NewSharesSummed:    binary.LittleEndian.Uint64(payload[12:20]),
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

// Encode serializes SubmitSharesError (symmetric inverse of DecodeSubmitSharesError).
func (m SubmitSharesError) Encode() ([]byte, error) {
	b := appendU32LE(make([]byte, 0, 16), m.ChannelID)
	b = appendU32LE(b, m.SequenceNumber)
	return appendStr0_255(b, m.Error)
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
// CloseChannel (server → client AND client → server, msg_type 0x18, channel_msg)
// ------------------------------------------------------------------

// CloseChannel ends a mining channel (SV2 spec §5.3.9). When the server
// sends it, the channel is dead: the client must stop using it.
type CloseChannel struct {
	ChannelID uint32
	Reason    string // reason_code, STR0_255
}

// Encode serializes CloseChannel (includes channel_id prefix).
func (m CloseChannel) Encode() ([]byte, error) {
	b := appendU32LE(make([]byte, 0, 5+len(m.Reason)), m.ChannelID)
	return appendStr0_255(b, m.Reason)
}

// DecodeCloseChannel parses a CloseChannel payload.
func DecodeCloseChannel(payload []byte) (CloseChannel, error) {
	var m CloseChannel
	r := newByteReader(payload)
	var err error
	if m.ChannelID, err = getU32LE(r); err != nil {
		return m, fmt.Errorf("stratum: CloseChannel.ChannelID: %w", err)
	}
	if m.Reason, err = getStr0_255(r); err != nil {
		return m, fmt.Errorf("stratum: CloseChannel.Reason: %w", err)
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
		MsgLength:     uint32(len(payload)), //nolint:gosec // payload is bounded by MaxFrameSize at construction
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
	SetNewPrevHash           *SetNewPrevHash
	SetTarget                *SetTarget
	CloseChannel             *CloseChannel
	SubmitSharesStandard     *SubmitSharesStandard
	SubmitSharesSuccess      *SubmitSharesSuccess
	SubmitSharesError        *SubmitSharesError
	Unknown                  *UnknownMessage
}

// UnknownMessage wraps a frame whose msg_type is not recognized.
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
// frameDecoders maps a MsgType to the decoder that fills the matching
// Message field. Unknown types fall through to Message.Unknown — see
// DispatchFrame.
var frameDecoders = map[uint8]func([]byte, *Message) error{
	MsgSetupConnection: func(p []byte, m *Message) error {
		v, err := DecodeSetupConnection(p)
		if err != nil {
			return err
		}
		m.SetupConnection = &v
		return nil
	},
	MsgSetupConnectionSuccess: func(p []byte, m *Message) error {
		v, err := DecodeSetupConnectionSuccess(p)
		if err != nil {
			return err
		}
		m.SetupConnectionSuccess = &v
		return nil
	},
	MsgSetupConnectionError: func(p []byte, m *Message) error {
		v, err := DecodeSetupConnectionError(p)
		if err != nil {
			return err
		}
		m.SetupConnectionError = &v
		return nil
	},
	MsgOpenMiningChannel: func(p []byte, m *Message) error {
		v, err := DecodeOpenMiningChannel(p)
		if err != nil {
			return err
		}
		m.OpenMiningChannel = &v
		return nil
	},
	MsgOpenMiningChannelSuccess: func(p []byte, m *Message) error {
		v, err := DecodeOpenMiningChannelSuccess(p)
		if err != nil {
			return err
		}
		m.OpenMiningChannelSuccess = &v
		return nil
	},
	MsgOpenMiningChannelError: func(p []byte, m *Message) error {
		v, err := DecodeOpenMiningChannelError(p)
		if err != nil {
			return err
		}
		m.OpenMiningChannelError = &v
		return nil
	},
	MsgNewMiningJob: func(p []byte, m *Message) error {
		v, err := DecodeNewMiningJob(p)
		if err != nil {
			return err
		}
		m.NewMiningJob = &v
		return nil
	},
	MsgSetNewPrevHash: func(p []byte, m *Message) error {
		v, err := DecodeSetNewPrevHash(p)
		if err != nil {
			return err
		}
		m.SetNewPrevHash = &v
		return nil
	},
	MsgSetTarget: func(p []byte, m *Message) error {
		v, err := DecodeSetTarget(p)
		if err != nil {
			return err
		}
		m.SetTarget = &v
		return nil
	},
	MsgSubmitSharesStandard: func(p []byte, m *Message) error {
		v, err := DecodeSubmitSharesStandard(p)
		if err != nil {
			return err
		}
		m.SubmitSharesStandard = &v
		return nil
	},
	MsgSubmitSharesSuccess: func(p []byte, m *Message) error {
		v, err := DecodeSubmitSharesSuccess(p)
		if err != nil {
			return err
		}
		m.SubmitSharesSuccess = &v
		return nil
	},
	MsgSubmitSharesError: func(p []byte, m *Message) error {
		v, err := DecodeSubmitSharesError(p)
		if err != nil {
			return err
		}
		m.SubmitSharesError = &v
		return nil
	},
	MsgCloseChannel: func(p []byte, m *Message) error {
		v, err := DecodeCloseChannel(p)
		if err != nil {
			return err
		}
		m.CloseChannel = &v
		return nil
	},
}

func DispatchFrame(f Frame) (Message, error) {
	var m Message
	d, ok := frameDecoders[f.Header.MsgType]
	if !ok {
		m.Unknown = &UnknownMessage{MsgType: f.Header.MsgType, Payload: f.Payload}
		return m, nil
	}
	if err := d(f.Payload, &m); err != nil {
		return m, err
	}
	return m, nil
}

// ------------------------------------------------------------------
// Validation helpers
// ------------------------------------------------------------------

// ValidateSetupConnection checks semantic constraints beyond byte format.
func ValidateSetupConnection(m *SetupConnection) error {
	if m.Protocol != MiningProtocol {
		return fmt.Errorf("stratum: unsupported protocol %d (only MiningProtocol=0 supported)", m.Protocol)
	}
	if m.MinVersion > m.MaxVersion {
		return fmt.Errorf("stratum: MinVersion %d > MaxVersion %d", m.MinVersion, m.MaxVersion)
	}
	return nil
}
