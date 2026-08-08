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
	"net"
	"strconv"
)

// ------------------------------------------------------------------
// SetupConnection (client → server, msg_type 0x00)
// ------------------------------------------------------------------

// SetupConnection is the first message sent by the client to negotiate
// the protocol version and capabilities.
//
// Wire layout: protocol U8, min_version U16, max_version U16, flags U32,
// endpoint_host STR0_255, endpoint_port U16, vendor STR0_255,
// hardware_version STR0_255, firmware STR0_255, device_id STR0_255.
//
// endpoint_port is a field of its own, not part of endpoint_host. Until
// session 256 this struct had no port at all and callers passed the whole
// "host:port" string as the host — so a conformant pool read two bytes of
// the vendor string as the port and every field after it was garbage,
// which is to say the V2 handshake could not complete against a real pool.
type SetupConnection struct {
	Protocol        Protocol
	MinVersion      uint16
	MaxVersion      uint16
	Flags           uint32
	EndpointHost    string // STR0_255, host only
	EndpointPort    uint16
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
	if b, err = appendStr0_255(b, m.EndpointHost); err != nil {
		return nil, err
	}
	b = appendU16LE(b, m.EndpointPort)
	for _, s := range []string{m.Vendor, m.HardwareVersion, m.Firmware, m.DeviceID} {
		if b, err = appendStr0_255(b, s); err != nil {
			return nil, err
		}
	}
	return b, nil
}

// SplitEndpoint splits a dial address into the host and port halves
// SetupConnection needs. An address with no port, or an unparseable one,
// yields the input as the host and port 0 — the pool uses these fields for
// diagnostics, so a missing port must not stop the handshake.
func SplitEndpoint(address string) (host string, port uint16) {
	h, p, err := net.SplitHostPort(address)
	if err != nil {
		return address, 0
	}
	n, err := strconv.ParseUint(p, 10, 16)
	if err != nil {
		return h, 0
	}
	return h, uint16(n)
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
	if m.EndpointHost, err = getStr0_255(r); err != nil {
		return m, fmt.Errorf("stratum: SetupConnection.EndpointHost: %w", err)
	}
	if m.EndpointPort, err = getU16LE(r); err != nil {
		return m, fmt.Errorf("stratum: SetupConnection.EndpointPort: %w", err)
	}
	fields := []*string{&m.Vendor, &m.HardwareVersion, &m.Firmware, &m.DeviceID}
	names := []string{"Vendor", "HardwareVersion", "Firmware", "DeviceID"}
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
//
// Wire layout: request_id U32, user_identity STR0_255,
// nominal_hash_rate F32, max_target U256.
//
// max_target is mandatory — SV2 messages are fixed-layout binary, so a
// field cannot be left out the way an optional JSON key can. Until
// session 256 Encode stopped after nominal_hash_rate on the grounds that
// Otedama has no target preference to advertise, which left a conformant
// pool 32 bytes short of a complete message. "No preference" is expressed
// instead by the largest possible target (see MaxTargetUnconstrained):
// every target the pool might assign is at or below it, so the pool is
// free to choose, which is the behaviour the omission was reaching for.
type OpenMiningChannel struct {
	ReqID           uint32  // caller-assigned, echoed in response
	User            string  // STR0_255: worker identifier (usually Bitcoin address)
	NominalHashrate float32 // H/s, informational

	// MaxTarget is the easiest target this device can work with, in the
	// same byte order as miner.Hash (LE, MSB at [31]). The zero value is
	// encoded as MaxTargetUnconstrained: a literal all-zero max_target
	// would tell the pool that only a hash of zero is acceptable, which
	// no pool can satisfy — never a meaning a caller intends.
	MaxTarget [32]byte
}

// MaxTargetUnconstrained is the largest representable U256 target: it
// accepts any share difficulty the pool cares to assign.
func MaxTargetUnconstrained() [32]byte {
	var t [32]byte
	for i := range t {
		t[i] = 0xFF
	}
	return t
}

// Encode serialises OpenMiningChannel.
func (m OpenMiningChannel) Encode() ([]byte, error) {
	b := appendU32LE(make([]byte, 0, 4+1+len(m.User)+4+32), m.ReqID)
	b, err := appendStr0_255(b, m.User)
	if err != nil {
		return nil, err
	}
	// NominalHashrate: IEEE 754 float32 little-endian.
	b = appendU32LE(b, float32bits(m.NominalHashrate))
	maxTarget := m.MaxTarget
	if maxTarget == ([32]byte{}) {
		maxTarget = MaxTargetUnconstrained()
	}
	return append(b, maxTarget[:]...), nil
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
	if _, err := io.ReadFull(r, m.MaxTarget[:]); err != nil {
		return m, fmt.Errorf("stratum: OpenMiningChannel.MaxTarget: %w", err)
	}
	return m, nil
}

// ------------------------------------------------------------------
// OpenMiningChannelSuccess (server → client, msg_type 0x11)
// ------------------------------------------------------------------

// OpenMiningChannelSuccess is sent by the pool to confirm the channel
// and provide the initial difficulty target.
//
// Wire layout: request_id U32, channel_id U32, target U256,
// extranonce_prefix B0_32, group_channel_id U32.
//
// The trailing field was decoded as a U16 "extranonce2_size" until
// session 256 — a Stratum V1 concept that does not exist in V2, where the
// pool builds the coinbase for a standard channel. A real pool's 4-byte
// group_channel_id was therefore read as two bytes of nonsense with two
// bytes left over.
type OpenMiningChannelSuccess struct {
	ReqID     uint32   // echoes OpenMiningChannel.ReqID
	ChannelID uint32   // assigned by pool
	Target    [32]byte // U256 (fixed 32 bytes, no length prefix): initial target hash
	// ExtranoncePrefix is B0_32 per the SV2 spec (1-byte length prefix,
	// max 32 bytes). Postel's law applies here: Encode is strict
	// (appendB0_32 rejects >32 bytes, since a value Otedama generates must
	// be conformant), but Decode stays lenient (getB0_255 below) — a
	// non-conformant pool sending a 33..255-byte prefix is still bounded
	// and allocation-safe, so we accept and use it rather than dropping an
	// otherwise-working connection over a spec-length nit.
	ExtranoncePrefix []byte
	// GroupChannelID names the group channel this standard channel joins
	// (see SetGroupChannel). Otedama opens a single standard channel and
	// does not act on groups, but the field is part of the message and is
	// decoded so the rest of the payload lines up.
	GroupChannelID uint32
}

// Encode serialises OpenMiningChannelSuccess.
func (m OpenMiningChannelSuccess) Encode() ([]byte, error) {
	b := make([]byte, 0, 4+4+32+1+len(m.ExtranoncePrefix)+4)
	b = appendU32LE(b, m.ReqID)
	b = appendU32LE(b, m.ChannelID)
	b = append(b, m.Target[:]...)
	b, err := appendB0_32(b, m.ExtranoncePrefix)
	if err != nil {
		return nil, err
	}
	return appendU32LE(b, m.GroupChannelID), nil
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
	// extranonce_prefix is spec'd B0_32, but we read it with getB0_255 on
	// purpose (lenient decode; see the field comment above). A conformant
	// pool never exceeds 32 bytes anyway.
	if m.ExtranoncePrefix, err = getB0_255(r); err != nil {
		return m, err
	}
	if m.GroupChannelID, err = getU32LE(r); err != nil {
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
