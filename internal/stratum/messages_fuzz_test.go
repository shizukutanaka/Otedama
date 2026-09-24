// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
package stratum

// Fuzz targets for the V2 message-payload decoders. The frame fuzz
// (frame_fuzz_test.go) covers header/transport boundaries; these
// Decode* functions are the next trust boundary in — a hostile or
// malformed pool controls every payload byte, and each decoder must
// return an error on a short/corrupt buffer, never panic or read out
// of bounds.
//
// A single dispatch target keeps one corpus covering every decoder —
// the fuzzer mutates the selector byte alongside the payload.
import (
	"bytes"
	"testing"
)

// decodeBySelector runs every payload decoder the selector indexes;
// each arm returns a re-encoded []byte for the round-trip check.
func decodeBySelector(sel byte, p []byte) ([]byte, error) {
	switch sel % 12 {
	case 0:
		m, err := DecodeNewMiningJob(p)
		if err != nil {
			return nil, err
		}
		return m.Encode()
	case 1:
		m, err := DecodeSetNewPrevHash(p)
		if err != nil {
			return nil, err
		}
		return m.Encode()
	case 2:
		m, err := DecodeSetTarget(p)
		if err != nil {
			return nil, err
		}
		return m.Encode()
	case 3:
		m, err := DecodeSubmitSharesStandard(p)
		if err != nil {
			return nil, err
		}
		return m.Encode()
	case 4:
		m, err := DecodeSubmitSharesSuccess(p)
		if err != nil {
			return nil, err
		}
		return m.Encode()
	case 5:
		m, err := DecodeSubmitSharesError(p)
		if err != nil {
			return nil, err
		}
		return m.Encode()
	case 6:
		m, err := DecodeSetupConnection(p)
		if err != nil {
			return nil, err
		}
		return m.Encode()
	case 7:
		m, err := DecodeSetupConnectionSuccess(p)
		if err != nil {
			return nil, err
		}
		return m.Encode()
	case 8:
		m, err := DecodeSetupConnectionError(p)
		if err != nil {
			return nil, err
		}
		return m.Encode()
	case 9:
		m, err := DecodeOpenMiningChannel(p)
		if err != nil {
			return nil, err
		}
		return m.Encode()
	case 10:
		m, err := DecodeOpenMiningChannelSuccess(p)
		if err != nil {
			return nil, err
		}
		return m.Encode()
	default:
		m, err := DecodeOpenMiningChannelError(p)
		if err != nil {
			return nil, err
		}
		return m.Encode()
	}
}

// FuzzDecodeV2Message asserts: decode never panics, and a successfully
// decoded payload re-encodes to the consumed wire bytes — encode is the
// decoders' declared inverse for every fixed-layout field. Decoders
// accept trailing junk on some types (lenient); the check therefore
// compares the re-encoded output as a *prefix* of the input.
func FuzzDecodeV2Message(f *testing.F) {
	f.Add(byte(0), []byte("\x01\x00\x00\x00\x02\x00\x00\x00\x00\x20\x00\x00\x00"))
	f.Add(byte(1), []byte("\x01\x00\x00\x00\x02\x00\x00\x00"+string(make([]byte, 44))))
	f.Add(byte(5), []byte("\x01\x00\x00\x00\x02\x00\x00\x00\x05stale-share"))
	f.Add(byte(9), []byte("\x01\x00\x00\x00\x04user\x00\x00\x00\x00"))
	f.Fuzz(func(t *testing.T, sel byte, payload []byte) {
		enc, err := decodeBySelector(sel, payload)
		if err != nil {
			return
		}
		if !bytes.HasPrefix(payload, enc) && !bytes.Equal(payload, enc) {
			t.Fatalf("selector %d: re-encode (%d B) does not match decoded prefix of %d B input",
				sel%12, len(enc), len(payload))
		}
	})
}
