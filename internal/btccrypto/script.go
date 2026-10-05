// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package btccrypto — script.go
//
// Address → locking-script (scriptPubKey) derivation for the standard
// output types Otedama validates: P2PKH, P2SH, P2WPKH, P2WSH and P2TR.
// A locking script is what a transaction output actually carries, so this
// is the encoding needed to check whether a given byte stream (e.g. the
// coinbase a mining pool hands out) pays to a configured payout address —
// the only spot on the wire where a non-custodial payout is observable.

package btccrypto

import (
	"bytes"
	"fmt"
)

// ScriptForAddress decodes a mainnet Bitcoin address and returns the
// standard locking script (scriptPubKey) that pays to it:
//
//	P2PKH         OP_DUP OP_HASH160 <20B hash160> OP_EQUALVERIFY OP_CHECKSIG
//	P2SH          OP_HASH160 <20B hash160> OP_EQUAL
//	P2WPKH/P2WSH  OP_0 <program>   (BIP-141: 20 or 32 bytes)
//	P2TR          OP_1 <32B program> (BIP-341)
//
// The address is checksum-validated first via ValidateAddress, so the
// returned script corresponds to exactly the well-formed address given;
// any malformed input returns the same descriptive error ValidateAddress
// produces. Witness programs are at most 40 bytes, so the push-data
// opcode is always a single byte.
//
// Callers: the engine derives the expected script once per pool session
// and checks that a pool declaring a direct-coinbase payout_scheme
// (tides/solo) actually embeds it in each job's coinbase.
func ScriptForAddress(addr string) ([]byte, error) {
	typ, err := ValidateAddress(addr)
	if err != nil {
		return nil, err
	}
	// ValidateAddress already verified the address decodes, so the second
	// pass below cannot fail on structure; it exists only to recover the
	// payload ValidateAddress deliberately does not return.
	if data, err := decodeBech32String(addr); err == nil {
		version := data[0]
		program, err := convertBits(data[1:len(data)-6], 5, 8, false)
		if err != nil {
			return nil, err
		}
		op := byte(0x00) // OP_0 for witness v0; OP_1..OP_16 for v1+.
		if version > 0 {
			op = 0x50 + byte(version)
		}
		out := make([]byte, 0, 2+len(program))
		out = append(out, op, byte(len(program))) //nolint:gosec // witness programs are ≤ 40 bytes (BIP-141)
		for _, v := range program {
			out = append(out, byte(v))
		}
		return out, nil
	}
	raw, err := base58Decode(addr)
	if err != nil {
		return nil, err
	}
	h := raw[1:21] // hash160 payload; version byte validated above
	switch typ {
	case AddressP2PKH:
		out := make([]byte, 0, 25)
		out = append(out, 0x76, 0xa9, 0x14) // OP_DUP OP_HASH160 OP_PUSH20
		out = append(out, h...)
		return append(out, 0x88, 0xac), nil // OP_EQUALVERIFY OP_CHECKSIG
	case AddressP2SH:
		out := make([]byte, 0, 23)
		out = append(out, 0xa9, 0x14) // OP_HASH160 OP_PUSH20
		out = append(out, h...)
		return append(out, 0x87), nil // OP_EQUAL
	}
	return nil, fmt.Errorf("btccrypto: no standard locking script for address type %s", typ)
}

// CoinbasePaysScript reports whether the assembled coinbase transaction
// carries an output whose locking script equals script, verified
// positionally at the transaction-output layer. A byte-wise substring
// scan is not sufficient: a hostile pool could embed the user's script
// inside an OP_RETURN push, a scriptSig, or witness data — bytes that
// look like a payout but pay nothing. Parsing the vout list and
// comparing each output's scriptPubKey closes that evasion.
//
// tx is the complete serialized transaction (for Stratum V1 jobs this is
// poolproto.Job.CoinbaseTx: coinb1 || extranonce1 || extranonce2 ||
// coinb2). The parser handles both legacy and segwit serialization and
// needs only the front of the transaction — witness data and locktime,
// which follow the outputs, are not read. A malformed or truncated
// transaction returns a descriptive error rather than a false negative.
func CoinbasePaysScript(tx, script []byte) (bool, error) {
	if len(tx) < 10 {
		return false, fmt.Errorf("btccrypto: coinbase too short (%d bytes)", len(tx))
	}
	off := 4 // version
	if tx[off] == 0x00 && tx[off+1] == 0x01 {
		off += 2 // segwit marker + flag
	}
	vin, err := readCompactSize(tx, &off)
	if err != nil || vin == 0 {
		return false, fmt.Errorf("btccrypto: bad coinbase input count")
	}
	for i := uint64(0); i < vin; i++ {
		off += 36 // prev txid + vout index
		sl, err := readCompactSize(tx, &off)
		if err != nil || sl > uint64(len(tx)-off) {
			return false, fmt.Errorf("btccrypto: bad scriptSig length")
		}
		off += int(sl) + 4 // scriptSig + sequence
	}
	if off >= len(tx) {
		return false, fmt.Errorf("btccrypto: truncated coinbase inputs")
	}
	vout, err := readCompactSize(tx, &off)
	if err != nil {
		return false, fmt.Errorf("btccrypto: bad coinbase output count")
	}
	for i := uint64(0); i < vout; i++ {
		off += 8 // value
		pkLen, err := readCompactSize(tx, &off)
		if err != nil || pkLen > uint64(len(tx)-off) {
			return false, fmt.Errorf("btccrypto: bad output script length")
		}
		if bytes.Equal(tx[off:off+int(pkLen)], script) {
			return true, nil
		}
		off += int(pkLen)
	}
	return false, nil
}

// readCompactSize decodes a Bitcoin CompactSize varint at *off and
// advances the offset past it.
func readCompactSize(b []byte, off *int) (uint64, error) {
	if *off >= len(b) {
		return 0, fmt.Errorf("btccrypto: varint out of range")
	}
	switch b[*off] {
	case 0xfd:
		if *off+3 > len(b) {
			return 0, fmt.Errorf("btccrypto: varint out of range")
		}
		v := uint64(b[*off+1]) | uint64(b[*off+2])<<8
		*off += 3
		return v, nil
	case 0xfe:
		if *off+5 > len(b) {
			return 0, fmt.Errorf("btccrypto: varint out of range")
		}
		v := uint64(b[*off+1]) | uint64(b[*off+2])<<8 |
			uint64(b[*off+3])<<16 | uint64(b[*off+4])<<24
		*off += 5
		return v, nil
	case 0xff:
		if *off+9 > len(b) {
			return 0, fmt.Errorf("btccrypto: varint out of range")
		}
		var v uint64
		for i := 0; i < 8; i++ {
			v |= uint64(b[*off+1+i]) << (8 * i) //nolint:gosec // bounded shift on a byte
		}
		*off += 9
		return v, nil
	default:
		v := uint64(b[*off])
		*off += 1
		return v, nil
	}
}
