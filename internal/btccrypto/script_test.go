// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package btccrypto

import (
	"bytes"
	"encoding/hex"
	"testing"
)

func mustHexBytes(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("bad hex vector %q: %v", s, err)
	}
	return b
}

func TestScriptForAddress_Vectors(t *testing.T) {
	cases := []struct {
		name string
		addr string
		want string // expected locking script, hex
	}{
		{
			"P2PKH (genesis)",
			"1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
			"76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac",
		},
		{
			"P2SH",
			"3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy",
			"a914b472a266d0bd89c13706a4132ccfb16f7c3b9fcb87",
		},
		{
			"P2WPKH (BIP-173)",
			"bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
			"0014751e76e8199196d454941c45d1b3a323f1433bd6",
		},
		{
			"P2WSH (BIP-173)",
			"bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3",
			"00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262",
		},
		{
			"P2TR (BIP-350)",
			"bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr",
			"5120a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ScriptForAddress(tc.addr)
			if err != nil {
				t.Fatalf("ScriptForAddress(%q): %v", tc.addr, err)
			}
			if want := mustHexBytes(t, tc.want); !bytes.Equal(got, want) {
				t.Errorf("ScriptForAddress(%q) = %x, want %x", tc.addr, got, want)
			}
		})
	}
}

func TestScriptForAddress_RejectsInvalid(t *testing.T) {
	for _, addr := range []string{
		"",
		"bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kg3g4ty", // bad checksum
		"tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kg3g4ty", // testnet hrp
		"1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb",         // base58 typo
		"notanaddress",
	} {
		if s, err := ScriptForAddress(addr); err == nil {
			t.Errorf("ScriptForAddress(%q) = %x, want error", addr, s)
		}
	}
}
