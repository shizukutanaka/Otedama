// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package stratum — handshake.go
//
// Stratum V2 Mining Protocol connection-establishment messages:
// SetupConnection (+Success/+Error) and OpenMiningChannel
// (+Success/+Error). Extracted from messages.go to separate the
// connection-handshake phase from the steady-state mining phase
// (NewMiningJob / SubmitShares*), which remain in messages.go.
//
// Message numbering (from the spec):
//
//	0x00  SetupConnection        (client → server)
//	0x01  SetupConnectionSuccess (server → client)
//	0x02  SetupConnectionError   (server → client)
//	0x10  OpenMiningChannel      (client → server)
//	0x11  OpenMiningChannelSuccess
//	0x12  OpenMiningChannelError
package stratum

import (
	"encoding/binary"
	"fmt"
	"io"
)

// ------------------------------------------------------------------
// SetupConnection (client → server, msg_type 0x00)
// ------------------------------------------------------------------

// SetupConnection is the first message sent by the client to negotiate
// the protocol version and capabilities.
type SetupConnection struct {
	Protocol        Protocol
	MinVersion      uint16
	MaxVersion      uint16
	Flags           uint32
	Endpoint        string // STR0_255
	Vendor          string // STR0_255
	HardwareVersion string // STR0_255
	Firmware        string // STR0_255
	DeviceID        string // STR0_255
}

// Encode serialises the message into a payload byte slice.
func (m SetupConnection) Encode() ([]byte, error) {
	b := make([]byte, 0, 32)
	b = append(b, byte(m.Protocol))
	b = appendU16LE(b, m.MinVersion)
	b = appendU16LE(b, m.MaxVersion)
	b = appendU32LE(b, m.Flags)
	var err error
	for _, s := range []string{m.Endpoint, m.Vendor, m.HardwareVersion, m.Firmware, m.DeviceID} {
		if b, err = appendStr0_255(b, s); err != nil {
			return nil, err
		}
	}
	return b, nil
}

// DecodeSetupConnection parses a SetupConnection from a payload byte slice.
func DecodeSetupConnection(payload []byte) (SetupConnection, error) {
	r := newByteReader(payload)
	var m SetupConnection
	proto, err := r.ReadByte()
	if err != nil {
		return m, fmt.Errorf("stratum: SetupConnection.Protocol: %w", err)
	}
	m.Protocol = Protocol(proto)
	if m.MinVersion, err = getU16LE(r); err != nil {
		return m, fmt.Errorf("stratum: SetupConnection.MinVersion: %w", err)
	}
	if m.MaxVersion, err = getU16LE(r); err != nil {
		return m, fmt.Errorf("stratum: SetupConnection.MaxVersion: %w", err)
	}
	if m.Flags, err = getU32LE(r); err != nil {
		return m, fmt.Errorf("stratum: SetupConnection.Flags: %w", err)
	}
	fields := []*string{&m.Endpoint, &m.Vendor, &m.HardwareVersion, &m.Firmware, &m.DeviceID}
	names := []string{"Endpoint", "Vendor", "HardwareVersion", "Firmware", "DeviceID"}
	for i, f := range fields {
		if *f, err = getStr0_255(r); err != nil {
			return m, fmt.Errorf("stratum: SetupConnection.%s: %w", names[i], err)
		}
	}
	return m, nil
}

// ------------------------------------------------------------------
// SetupConnectionSuccess (server → client, msg_type 0x01)
// ------------------------------------------------------------------

// SetupConnectionSuccess signals that the pool accepted the connection
// and agreed on a protocol version.
type SetupConnectionSuccess struct {
	UsedVersion uint16
	Flags       uint32
}

// Encode serialises SetupConnectionSuccess.
func (m SetupConnectionSuccess) Encode() ([]byte, error) {
	buf := make([]byte, 6)
	binary.LittleEndian.PutUint16(buf[0:2], m.UsedVersion)
	binary.LittleEndian.PutUint32(buf[2:6], m.Flags)
	return buf, nil
}

// DecodeSetupConnectionSuccess parses SetupConnectionSuccess.
func DecodeSetupConnectionSuccess(payload []byte) (SetupConnectionSuccess, error) {
	if len(payload) < 6 {
		return SetupConnectionSuccess{}, fmt.Errorf("stratum: SetupConnectionSuccess: short payload (%d < 6)", len(payload))
	}
	return SetupConnectionSuccess{
		UsedVersion: binary.LittleEndian.Uint16(payload[0:2]),
		Flags:       binary.LittleEndian.Uint32(payload[2:6]),
	}, nil
}

// ------------------------------------------------------------------
// SetupConnectionError (server → client, msg_type 0x02)
// ------------------------------------------------------------------

// SetupConnectionError is returned when the pool rejects a connection.
type SetupConnectionError struct {
	Flags uint32
	Error string // STR0_255: human-readable reason
}

// Encode serialises SetupConnectionError.
func (m SetupConnectionError) Encode() ([]byte, error) {
	b := appendU32LE(make([]byte, 0, 8), m.Flags)
	return appendStr0_255(b, m.Error)
}

// DecodeSetupConnectionError parses SetupConnectionError.
func DecodeSetupConnectionError(payload []byte) (SetupConnectionError, error) {
	r := newByteReader(payload)
	var m SetupConnectionError
	var err error
	if m.Flags, err = getU32LE(r); err != nil {
		return m, fmt.Errorf("stratum: SetupConnectionError.Flags: %w", err)
	}
	if m.Error, err = getStr0_255(r); err != nil {
		return m, fmt.Errorf("stratum: SetupConnectionError.Error: %w", err)
	}
	return m, nil
}

// ------------------------------------------------------------------
// OpenMiningChannel (client → server, msg_type 0x10)
// ------------------------------------------------------------------

// OpenMiningChannel requests a new mining channel on an established
// connection. Each channel corresponds to one "mining device".
type OpenMiningChannel struct {
	ReqID           uint32  // caller-assigned, echoed in response
	User            string  // STR0_255: worker identifier (usually Bitcoin address)
	NominalHashrate float32 // H/s, informational
	MaxTargetNBits  uint32  // caller's preferred max target
}

// Encode serialises OpenMiningChannel.
func (m OpenMiningChannel) Encode() ([]byte, error) {
	b := appendU32LE(make([]byte, 0, 16), m.ReqID)
	b, err := appendStr0_255(b, m.User)
	if err != nil {
		return nil, err
	}
	// NominalHashrate: IEEE 754 float32 little-endian.
	return appendU32LE(b, float32bits(m.NominalHashrate)), nil
}

// DecodeOpenMiningChannel parses OpenMiningChannel.
func DecodeOpenMiningChannel(payload []byte) (OpenMiningChannel, error) {
	r := newByteReader(payload)
	var m OpenMiningChannel
	var err error
	if m.ReqID, err = getU32LE(r); err != nil {
		return m, fmt.Errorf("stratum: OpenMiningChannel.ReqID: %w", err)
	}
	if m.User, err = getStr0_255(r); err != nil {
		return m, fmt.Errorf("stratum: OpenMiningChannel.User: %w", err)
	}
	var f [4]byte
	if _, err := io.ReadFull(r, f[:]); err != nil {
		return m, fmt.Errorf("stratum: OpenMiningChannel.NominalHashrate: %w", err)
	}
	m.NominalHashrate = float32frombits(binary.LittleEndian.Uint32(f[:]))
	return m, nil
}

// ------------------------------------------------------------------
// OpenMiningChannelSuccess (server → client, msg_type 0x11)
// ------------------------------------------------------------------

// OpenMiningChannelSuccess is sent by the pool to confirm the channel
// and provide the initial difficulty target.
type OpenMiningChannelSuccess struct {
	ReqID           uint32   // echoes OpenMiningChannel.ReqID
	ChannelID       uint32   // assigned by pool
	Target          [32]byte // B0_32: initial target hash
	Extranonce      []byte   // B0_32 (variable); may be empty
	ExtraNonce2Size uint16
}

// Encode serialises OpenMiningChannelSuccess.
func (m OpenMiningChannelSuccess) Encode() ([]byte, error) {
	b := make([]byte, 0, 4+4+32+1+len(m.Extranonce)+2)
	b = appendU32LE(b, m.ReqID)
	b = appendU32LE(b, m.ChannelID)
	b = append(b, m.Target[:]...)
	b, err := appendB0_255(b, m.Extranonce)
	if err != nil {
		return nil, err
	}
	return appendU16LE(b, m.ExtraNonce2Size), nil
}

// DecodeOpenMiningChannelSuccess parses OpenMiningChannelSuccess.
func DecodeOpenMiningChannelSuccess(payload []byte) (OpenMiningChannelSuccess, error) {
	r := newByteReader(payload)
	var m OpenMiningChannelSuccess
	var err error
	if m.ReqID, err = getU32LE(r); err != nil {
		return m, err
	}
	if m.ChannelID, err = getU32LE(r); err != nil {
		return m, err
	}
	if _, err := io.ReadFull(r, m.Target[:]); err != nil {
		return m, fmt.Errorf("stratum: OpenMiningChannelSuccess.Target: %w", err)
	}
	if m.Extranonce, err = getB0_255(r); err != nil {
		return m, err
	}
	if m.ExtraNonce2Size, err = getU16LE(r); err != nil {
		return m, err
	}
	return m, nil
}

// ------------------------------------------------------------------
// OpenMiningChannelError (server → client, msg_type 0x12)
// ------------------------------------------------------------------

// OpenMiningChannelError is returned when the pool rejects a channel request.
type OpenMiningChannelError struct {
	ReqID uint32
	Error string // STR0_255
}

// Encode serialises OpenMiningChannelError (symmetric inverse of DecodeOpenMiningChannelError).
func (m OpenMiningChannelError) Encode() ([]byte, error) {
	b := appendU32LE(make([]byte, 0, 8), m.ReqID)
	return appendStr0_255(b, m.Error)
}

// DecodeOpenMiningChannelError parses an OpenMiningChannelError payload.
func DecodeOpenMiningChannelError(payload []byte) (OpenMiningChannelError, error) {
	if len(payload) < 4 {
		return OpenMiningChannelError{}, fmt.Errorf("stratum: OpenMiningChannelError: short payload (%d < 4)", len(payload))
	}
	m := OpenMiningChannelError{
		ReqID: binary.LittleEndian.Uint32(payload[0:4]),
	}
	if len(payload) > 4 {
		r := newByteReader(payload[4:])
		var err error
		if m.Error, err = getStr0_255(r); err != nil {
			return m, fmt.Errorf("stratum: OpenMiningChannelError.Error: %w", err)
		}
	}
	return m, nil
}
