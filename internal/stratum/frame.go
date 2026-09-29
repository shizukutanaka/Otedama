// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package stratum implements the Stratum V2 mining protocol for Otedama.
//
// # Why Stratum V2
//
// Stratum V1, introduced in 2012, remains the dominant mining protocol
// but suffers from three structural problems: plaintext JSON messages
// are bandwidth-heavy (250-400 bytes each), lack of encryption enables
// hashrate hijacking via MITM, and pool-defined block templates give
// pool operators de-facto block construction authority.
//
// Stratum V2 addresses all three: compact binary framing cuts bandwidth
// by ~60-70%, a mandatory Noise handshake encrypts all inter-role
// communication, and the Job Declaration Protocol returns block
// template authority to miners. Competitive analysis shows CGMiner has
// incomplete V2 support and Braiins OS+ supports V2 only for a narrow
// set of ASIC models. Otedama provides V2 as a first-class protocol
// for home users on any hardware.
//
// # Package Layout
//
// This file defines the frame layer: the on-the-wire byte format that
// every V2 message shares. Higher layers (handshake, mining messages,
// job declaration) sit on top of this and are implemented in sibling
// files.
//
// # Security Stance
//
// The frame parser is a direct target for malicious input from a
// potentially hostile peer. Historical precedent (CVE-2014-4501 through
// CVE-2014-4503 in CGMiner/BFGMiner/SGMinger) shows that sloppy length
// handling in mining protocol parsers enables stack overflows, heap
// corruption, and remote code execution. This parser:
//
//   - Never trusts a length field from the wire without bounding it
//     against the configured maximum (MaxFrameSize).
//   - Validates all fields before any allocation occurs.
//   - Refuses to allocate buffers larger than the claimed message size.
//   - Is fuzz-tested continuously (see frame_fuzz_test.go once wired up).
//
// # References
//
//   - Stratum V2 specification, chapter 3 (Protocol Overview):
//     https://stratumprotocol.org/specification/03-protocol-overview/
//   - Stratum Reference Implementation (SRI) framing_sv2 crate for
//     cross-reference test vectors.
package stratum

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// HeaderSize is the fixed size in bytes of every Stratum V2 frame header.
// The header consists of a U16 extension_type, a U8 msg_type, and a U24
// msg_length for a total of 6 bytes.
const HeaderSize = 6

// MaxMessageLength is the maximum value that can fit in the U24
// msg_length field (2^24 - 1). The protocol specification uses this
// value as the theoretical upper bound, but individual roles may enforce
// tighter limits via MaxFrameSize in their Decoder configuration.
const MaxMessageLength = (1 << 24) - 1

// DefaultMaxFrameSize is Otedama's default upper bound on total frame
// size (header + payload). The Stratum V2 specification does not mandate
// a single value; the Stratum Reference Implementation uses 16 MiB, and
// we match that for interoperability. Operators may configure a smaller
// bound for specific deployments via Decoder.MaxFrameSize.
const DefaultMaxFrameSize = 16 * 1024 * 1024

// MinimumChannelPayload is the minimum size, in bytes, of a channel
// message payload. When the channel_msg bit is set in extension_type,
// the first four bytes of the payload encode a U32 channel_id.
const MinimumChannelPayload = 4

// channelMsgBit is the most significant bit of extension_type. When set,
// the first four bytes of the payload are a U32 channel_id.
//
// The Stratum V2 specification labels this "bit 15 (0-indexed), also
// known as channel_msg". On the wire, extension_type is serialized in
// little-endian, so bit 15 is the high bit of the second byte.
const channelMsgBit uint16 = 0x8000

// Header is the decoded representation of a Stratum V2 frame header.
//
// The raw U24 msg_length field is expanded into a standard uint32 here;
// the encoder handles the three-byte serialization.
type Header struct {
	// ExtensionType identifies the protocol extension that owns this
	// message. Bit 15 (channel_msg) signals that the payload begins
	// with a U32 channel_id. Use ChannelMsg and ExtensionID to inspect
	// these two components separately rather than masking by hand.
	ExtensionType uint16

	// MsgType is the per-extension message discriminator.
	MsgType uint8

	// MsgLength is the length in bytes of the payload that follows
	// this header. It does not include the header itself. The value
	// fits in the protocol's U24 field and is therefore bounded by
	// MaxMessageLength.
	MsgLength uint32
}

// ChannelMsg reports whether this header's channel_msg bit is set. When
// true, the first four bytes of the payload encode a U32 channel_id.
func (h Header) ChannelMsg() bool {
	return h.ExtensionType&channelMsgBit != 0
}

// ExtensionID returns the extension identifier with the channel_msg bit
// cleared. Two frames with ExtensionType 0x8ABC and 0x0ABC address the
// same extension; ExtensionID returns 0x0ABC for both so that extension
// dispatch is uniform.
func (h Header) ExtensionID() uint16 {
	return h.ExtensionType &^ channelMsgBit
}

// Validate reports whether this header is internally consistent.
//
// A valid header has MsgLength <= MaxMessageLength. When ChannelMsg is
// set, MsgLength must be at least MinimumChannelPayload, because the
// payload must accommodate the four-byte channel_id.
func (h Header) Validate() error {
	if h.MsgLength > MaxMessageLength {
		return fmt.Errorf("stratum: MsgLength %d exceeds U24 maximum %d", h.MsgLength, MaxMessageLength)
	}
	if h.ChannelMsg() && h.MsgLength < MinimumChannelPayload {
		return fmt.Errorf("stratum: channel message requires payload >= %d bytes, got %d", MinimumChannelPayload, h.MsgLength)
	}
	return nil
}

// Frame is a fully-decoded Stratum V2 frame comprising a header and its
// raw payload. Higher layers deserialize the payload based on
// (ExtensionID, MsgType).
//
// The Payload slice is owned by Frame and must not be retained by the
// caller beyond the lifetime of the Frame, because the Decoder may
// reuse its internal buffer for the next frame.
type Frame struct {
	Header  Header
	Payload []byte
}

// ChannelID extracts the channel_id from a channel message's payload.
// It returns an error if the header's channel_msg bit is unset or the
// payload is shorter than MinimumChannelPayload.
func (f Frame) ChannelID() (uint32, error) {
	if !f.Header.ChannelMsg() {
		return 0, errors.New("stratum: frame is not a channel message")
	}
	if len(f.Payload) < MinimumChannelPayload {
		return 0, fmt.Errorf("stratum: channel message payload is %d bytes, need at least %d", len(f.Payload), MinimumChannelPayload)
	}
	return binary.LittleEndian.Uint32(f.Payload[:MinimumChannelPayload]), nil
}

// ----- Encoding -----

// EncodeHeader serializes h into dst. dst must be at least HeaderSize
// bytes long; otherwise EncodeHeader returns an error without mutating
// dst beyond what is strictly necessary for the error-free prefix.
//
// EncodeHeader validates the header before writing. Callers that have
// already called Header.Validate may skip that step mentally, but the
// check is fast and defensive.
func EncodeHeader(dst []byte, h Header) error {
	if err := h.Validate(); err != nil {
		return err
	}
	if len(dst) < HeaderSize {
		return fmt.Errorf("stratum: dst too small: need %d bytes, got %d", HeaderSize, len(dst))
	}
	binary.LittleEndian.PutUint16(dst[0:2], h.ExtensionType)
	dst[2] = h.MsgType
	// U24 little-endian: low, mid, high.
	dst[3] = byte(h.MsgLength)
	dst[4] = byte(h.MsgLength >> 8)
	dst[5] = byte(h.MsgLength >> 16)
	return nil
}

// EncodeFrame returns a new byte slice containing the serialized frame.
// The returned slice has length HeaderSize + len(f.Payload).
//
// The Header's MsgLength is overwritten with len(f.Payload) so that the
// caller cannot accidentally emit an inconsistent frame. Other header
// fields are preserved as provided.
func EncodeFrame(f Frame) ([]byte, error) {
	if len(f.Payload) > MaxMessageLength {
		return nil, fmt.Errorf("stratum: payload length %d exceeds U24 maximum %d", len(f.Payload), MaxMessageLength)
	}
	h := f.Header
	h.MsgLength = uint32(len(f.Payload))
	if err := h.Validate(); err != nil {
		return nil, err
	}

	buf := make([]byte, HeaderSize+len(f.Payload))
	// buf[:HeaderSize] is exactly HeaderSize bytes and h.Validate() already
	// passed above, so EncodeHeader cannot return an error here.
	_ = EncodeHeader(buf[:HeaderSize], h)
	copy(buf[HeaderSize:], f.Payload)
	return buf, nil
}

// ----- Decoding -----

// DecodeHeader parses a Stratum V2 header from src. src must be at least
// HeaderSize bytes long. On success, DecodeHeader returns the parsed
// header; on failure, it returns an error. DecodeHeader does not
// validate the header beyond structural decoding; callers must call
// Header.Validate to enforce semantic constraints.
func DecodeHeader(src []byte) (Header, error) {
	if len(src) < HeaderSize {
		return Header{}, fmt.Errorf("stratum: header truncated: need %d bytes, got %d", HeaderSize, len(src))
	}
	ext := binary.LittleEndian.Uint16(src[0:2])
	msgType := src[2]
	msgLen := uint32(src[3]) | uint32(src[4])<<8 | uint32(src[5])<<16
	return Header{
		ExtensionType: ext,
		MsgType:       msgType,
		MsgLength:     msgLen,
	}, nil
}

// Decoder reads Stratum V2 frames from an io.Reader, applying strict
// length and resource bounds to defend against malicious peers.
//
// A zero-value Decoder is not usable; callers must use NewDecoder to
// ensure MaxFrameSize is set to a sane default.
type Decoder struct {
	r io.Reader

	// MaxFrameSize caps the total size (header + payload) of any single
	// frame this decoder will accept. Frames claiming to be larger are
	// rejected before any allocation occurs. Defaults to
	// DefaultMaxFrameSize when the Decoder is constructed via
	// NewDecoder.
	MaxFrameSize int

	// scratch is a reusable header buffer to avoid per-frame allocation.
	scratch [HeaderSize]byte
}

// NewDecoder returns a Decoder that reads from r with default resource
// limits. For specialized callers, adjust the returned Decoder's
// MaxFrameSize before use.
func NewDecoder(r io.Reader) *Decoder {
	return &Decoder{
		r:            r,
		MaxFrameSize: DefaultMaxFrameSize,
	}
}

// ReadFrame reads a single frame from the underlying reader. On success,
// it returns the decoded Frame. The Payload slice is a freshly allocated
// buffer that the caller owns.
//
// ReadFrame returns io.EOF when the reader is cleanly closed between
// frames. A truncated frame (EOF mid-header or mid-payload) is reported
// as io.ErrUnexpectedEOF.
func (d *Decoder) ReadFrame() (Frame, error) {
	if d.MaxFrameSize <= 0 {
		return Frame{}, errors.New("stratum: Decoder.MaxFrameSize must be positive")
	}

	// Read the header.
	if _, err := io.ReadFull(d.r, d.scratch[:]); err != nil {
		return Frame{}, err
	}
	// d.scratch is [HeaderSize]byte, so the slice is always exactly HeaderSize
	// bytes; DecodeHeader's length guard can never fire here.
	h, _ := DecodeHeader(d.scratch[:])
	if err := h.Validate(); err != nil {
		return Frame{}, err
	}

	// Bound the payload size against MaxFrameSize *before* allocating
	// the buffer. This is the critical defense against memory-exhaustion
	// attacks in which a malicious peer announces a huge payload.
	// On all 64-bit targets (the project's only supported platforms), int is
	// 64-bit so HeaderSize + uint32 never overflows.
	total := HeaderSize + int(h.MsgLength)
	if total > d.MaxFrameSize {
		return Frame{}, fmt.Errorf("stratum: frame size %d exceeds MaxFrameSize %d", total, d.MaxFrameSize)
	}

	payload := make([]byte, h.MsgLength)
	if h.MsgLength > 0 {
		if _, err := io.ReadFull(d.r, payload); err != nil {
			return Frame{}, err
		}
	}
	return Frame{Header: h, Payload: payload}, nil
}
