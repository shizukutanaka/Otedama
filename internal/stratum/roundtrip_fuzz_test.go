// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package stratum

import (
	"bytes"
	"encoding/binary"
	"testing"
)

// FuzzMessageRoundTrip covers the encode direction of the six steady-state
// mining-channel messages — the complement of the decode-side fuzzers, which
// only prove arbitrary bytes never wedge the parser. Here, every struct the
// fuzzer builds must satisfy three invariants: Encode never fails, Decode of
// the output returns an identical value, and re-encoding the decoded value is
// byte-identical (canonical-form stability in both directions).
func FuzzMessageRoundTrip(f *testing.F) {
	f.Add([]byte{0x01, 0x02, 0x03, 0x04})
	f.Add(bytes.Repeat([]byte{0xAB}, 128))
	f.Add([]byte{})
	f.Add(bytes.Repeat([]byte{0xFF}, 300))

	f.Fuzz(func(t *testing.T, data []byte) {
		u32 := func(off int) uint32 {
			if len(data) < off+4 {
				return 0
			}
			return binary.LittleEndian.Uint32(data[off:])
		}
		b32 := func(off int) (out [32]byte) {
			if len(data) >= off+32 {
				copy(out[:], data[off:off+32])
			}
			return out
		}
		str255 := func() string {
			n := len(data)
			if n > 255 {
				n = 255
			}
			return string(data[:n])
		}

		job := NewMiningJob{
			ChannelID:  u32(0),
			JobID:      u32(4),
			Version:    u32(8),
			MerkleRoot: b32(12),
		}
		if len(data) > 0 && data[0]&1 == 1 {
			job.HasMinNtime = true
			job.MinNtime = u32(44)
		}
		enc, err := job.Encode()
		if err != nil {
			t.Fatalf("NewMiningJob.Encode: %v", err)
		}
		dec, err := DecodeNewMiningJob(enc)
		if err != nil {
			t.Fatalf("DecodeNewMiningJob(own output): %v", err)
		}
		if dec != job {
			t.Fatalf("NewMiningJob round trip: %+v != %+v", dec, job)
		}
		if enc2, _ := dec.Encode(); !bytes.Equal(enc2, enc) {
			t.Fatal("NewMiningJob re-encode differs")
		}

		prev := SetNewPrevHash{
			ChannelID: u32(48),
			JobID:     u32(52),
			PrevHash:  b32(56),
			MinNtime:  u32(88),
			NBits:     u32(92),
		}
		enc, err = prev.Encode()
		if err != nil {
			t.Fatalf("SetNewPrevHash.Encode: %v", err)
		}
		decP, err := DecodeSetNewPrevHash(enc)
		if err != nil {
			t.Fatalf("DecodeSetNewPrevHash(own output): %v", err)
		}
		if decP != prev {
			t.Fatalf("SetNewPrevHash round trip: %+v != %+v", decP, prev)
		}
		if enc2, _ := decP.Encode(); !bytes.Equal(enc2, enc) {
			t.Fatal("SetNewPrevHash re-encode differs")
		}

		tgt := SetTarget{ChannelID: u32(96), MaxTarget: b32(100)}
		enc, err = tgt.Encode()
		if err != nil {
			t.Fatalf("SetTarget.Encode: %v", err)
		}
		decT, err := DecodeSetTarget(enc)
		if err != nil {
			t.Fatalf("DecodeSetTarget(own output): %v", err)
		}
		if decT != tgt {
			t.Fatalf("SetTarget round trip: %+v != %+v", decT, tgt)
		}
		if enc2, _ := decT.Encode(); !bytes.Equal(enc2, enc) {
			t.Fatal("SetTarget re-encode differs")
		}

		sub := SubmitSharesStandard{
			ChannelID:      u32(132),
			SequenceNumber: u32(136),
			JobID:          u32(140),
			Nonce:          u32(144),
			NTime:          u32(148),
			NVersion:       u32(152),
		}
		enc, err = sub.Encode()
		if err != nil {
			t.Fatalf("SubmitSharesStandard.Encode: %v", err)
		}
		decS, err := DecodeSubmitSharesStandard(enc)
		if err != nil {
			t.Fatalf("DecodeSubmitSharesStandard(own output): %v", err)
		}
		if decS != sub {
			t.Fatalf("SubmitSharesStandard round trip: %+v != %+v", decS, sub)
		}
		if enc2, _ := decS.Encode(); !bytes.Equal(enc2, enc) {
			t.Fatal("SubmitSharesStandard re-encode differs")
		}

		succ := SubmitSharesSuccess{
			ChannelID:          u32(156),
			LastSequenceNumber: u32(160),
			NewSubmitsAccepted: u32(164),
			NewSharesSummed:    u32(168),
		}
		enc, err = succ.Encode()
		if err != nil {
			t.Fatalf("SubmitSharesSuccess.Encode: %v", err)
		}
		decU, err := DecodeSubmitSharesSuccess(enc)
		if err != nil {
			t.Fatalf("DecodeSubmitSharesSuccess(own output): %v", err)
		}
		if decU != succ {
			t.Fatalf("SubmitSharesSuccess round trip: %+v != %+v", decU, succ)
		}
		if enc2, _ := decU.Encode(); !bytes.Equal(enc2, enc) {
			t.Fatal("SubmitSharesSuccess re-encode differs")
		}

		serr := SubmitSharesError{
			ChannelID:      u32(172),
			SequenceNumber: u32(176),
			Error:          str255(),
		}
		enc, err = serr.Encode()
		if err != nil {
			t.Fatalf("SubmitSharesError.Encode: %v", err)
		}
		decE, err := DecodeSubmitSharesError(enc)
		if err != nil {
			t.Fatalf("DecodeSubmitSharesError(own output): %v", err)
		}
		if decE != serr {
			t.Fatalf("SubmitSharesError round trip: %+v != %+v", decE, serr)
		}
		if enc2, _ := decE.Encode(); !bytes.Equal(enc2, enc) {
			t.Fatal("SubmitSharesError re-encode differs")
		}
	})
}
