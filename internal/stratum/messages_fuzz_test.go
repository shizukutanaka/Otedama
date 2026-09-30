// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package stratum

import (
	"bytes"
	"encoding/binary"
	"testing"
)

// FuzzMessageDecoders feeds arbitrary payloads into every server→client
// SV2 message decoder plus the wire-level primitive readers. These run on
// post-handshake, pool-controlled bytes inside the Noise-encrypted channel,
// so a panic or unbounded allocation is a pool-driven crash vector.
func FuzzMessageDecoders(f *testing.F) {
	seeds := [][]byte{
		// Minimally-shaped valid-ish payloads.
		mkBytes(49, 0x20), // NewMiningJob without min_ntime
		append(append(mkBytes(8, 0x00), 0x01), mkBytes(4+4+32, 0x30)...), // OPTION=1 shape
		mkBytes(48, 0x20), // SetNewPrevHash
		mkBytes(36, 0x21), // SetTarget
		mkBytes(24, 0x22), // SubmitSharesStandard
		mkBytes(16, 0x23), // SubmitSharesSuccess
		append(append(mkBytes(8, 0x24), 5), []byte("stale")...), // SubmitSharesError + STR0_255
		append(append(mkBytes(8, 0x24), 255), bytes.Repeat([]byte{0x41}, 255)...),
		append(append(mkBytes(8, 0x24), 255), []byte("short")...), // over-claimed length
		mkBytes(0, 0x00),
		{},
		nil,
		{0xff},
		{0xff, 0xff, 0xff, 0xff, 0xff},
	}
	for _, s := range seeds {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, payload []byte) {
		// Every decoder: must return (value, err) — never panic, never hang.
		_, _ = DecodeNewMiningJob(payload)
		_, _ = DecodeSetNewPrevHash(payload)
		_, _ = DecodeSetTarget(payload)
		_, _ = DecodeSubmitSharesStandard(payload)
		_, _ = DecodeSubmitSharesSuccess(payload)
		_, _ = DecodeSubmitSharesError(payload)
		if len(payload) >= 4 {
			_, _ = DecodeOpenMiningChannelError(payload[4:])
		}
		_, _ = getStr0_255(newByteReader(payload))
		_, _ = getB0_255(newByteReader(payload))
		_, _ = getU16LE(newByteReader(payload))
		_, _ = getU32LE(newByteReader(payload))
	})
}

// mkBytes returns a length-n slice filled with a constant byte.
func mkBytes(n int, b byte) []byte {
	return bytes.Repeat([]byte{b}, n)
}

// TestMessageDecoderBounds pins the short-payload contract directly so a
// regression fails loudly even without the fuzzer.
func TestMessageDecoderBounds(t *testing.T) {
	if _, err := DecodeNewMiningJob(mkBytes(44, 0)); err == nil {
		t.Fatal("NewMiningJob accepted 44-byte payload")
	}
	if _, err := DecodeNewMiningJob(mkBytes(45, 0)); err != nil {
		t.Fatalf("NewMiningJob rejected minimal valid shape: %v", err)
	}
	// OPTION flag = 1 but body too short for present min_ntime.
	bad := append(mkBytes(8, 0), 0x01)
	bad = append(bad, mkBytes(10, 0)...)
	if _, err := DecodeNewMiningJob(bad); err == nil {
		t.Fatal("NewMiningJob accepted truncated min_ntime payload")
	}
	if _, err := DecodeSetNewPrevHash(mkBytes(47, 0)); err == nil {
		t.Fatal("SetNewPrevHash accepted 47-byte payload")
	}
	if _, err := DecodeSetTarget(mkBytes(35, 0)); err == nil {
		t.Fatal("SetTarget accepted 35-byte payload")
	}
	// STR0_255 length prefix claiming more than remains.
	overclaimed := append(binary.LittleEndian.AppendUint32(nil, 7), append(binary.LittleEndian.AppendUint32(nil, 3), 200, 'x')...)
	if _, err := DecodeSubmitSharesError(overclaimed); err == nil {
		t.Fatal("SubmitSharesError accepted over-claimed STR0_255")
	}
}
