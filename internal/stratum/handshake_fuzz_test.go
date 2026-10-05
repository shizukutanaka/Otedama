// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
//
// Fuzz coverage for the connection-handshake decoders — the first bytes
// a pool sends after connecting (SetupConnectionSuccess/Error,
// OpenMiningChannelSuccess) and the client→server shapes used by tests.
// FuzzMessageDecoders covers the steady-state mining messages; this file
// covers the handshake-phase payloads they compose the same bounded
// readers over.
package stratum

import (
	"bytes"
	"testing"
)

// FuzzHandshakeDecoders feeds arbitrary payloads into every handshake
// decoder. Contract: any byte sequence returns an error or a decoded
// struct — never a panic (length-prefix overruns, short fixed fields).
func FuzzHandshakeDecoders(f *testing.F) {
	// Real encodings as seeds so mutations start past the length guards.
	if enc, err := (&SetupConnection{
		Protocol: MiningProtocol, MinVersion: 2, MaxVersion: 2,
		Endpoint: "pool.example.com:3333", Vendor: "otedama",
		HardwareVersion: "asic-x", Firmware: "1.0", DeviceID: "dev0",
	}).Encode(); err == nil {
		f.Add(enc)
	}
	f.Add([]byte{0x00})                         // proto only
	f.Add(make([]byte, 64))                     // all-zero: valid-ish setup
	f.Add([]byte{2, 0, 2, 0, 0, 0, 0, 0})       // SetupConnectionSuccess-shape
	f.Add([]byte{0, 0, 0, 0, 3, 'e', 'r', 'r'}) // SetupConnectionError-shape
	if enc, err := (OpenMiningChannel{ReqID: 7, User: "w", NominalHashrate: 1.5e9}).Encode(); err == nil {
		f.Add(enc)
	}
	if enc, err := (OpenMiningChannelSuccess{
		ReqID: 7, ChannelID: 3, Extranonce: []byte{1, 2, 3}, GroupChannelID: 4,
	}).Encode(); err == nil {
		f.Add(enc)
	}
	f.Add(make([]byte, 256)) // all-zero: max-length success shape

	f.Fuzz(func(t *testing.T, payload []byte) {
		_, _ = DecodeSetupConnection(payload)
		_, _ = DecodeSetupConnectionSuccess(payload)
		_, _ = DecodeSetupConnectionError(payload)
		_, _ = DecodeOpenMiningChannel(payload)
		succ, err := DecodeOpenMiningChannelSuccess(payload)
		if err != nil {
			return
		}
		// Round-trip: a successfully decoded success message must
		// re-encode and decode identically (lenient Extranonce >32B is
		// documented — Encode rejects it, which is also fine).
		enc, err := succ.Encode()
		if err != nil {
			if len(succ.Extranonce) <= 32 {
				t.Fatalf("decoded success with <=32B extranonce failed re-encode: %v", err)
			}
			return
		}
		again, err := DecodeOpenMiningChannelSuccess(enc)
		if err != nil {
			t.Fatalf("re-decoding own encoding failed: %v", err)
		}
		if again.ReqID != succ.ReqID || again.ChannelID != succ.ChannelID ||
			again.Target != succ.Target || again.GroupChannelID != succ.GroupChannelID ||
			!bytes.Equal(again.Extranonce, succ.Extranonce) {
			t.Fatal("OpenMiningChannelSuccess round-trip not stable")
		}
	})
}
