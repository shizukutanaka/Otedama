// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package miner — v1.go
//
// Stratum V1 share construction. Unlike Stratum V2 (where the pool ships a
// ready-made merkle root), V1's mining.notify carries the coinbase halves
// and the merkle branch list, and the miner must build the block header's
// merkle root itself:
//
//	coinbase   = coinb1 || extranonce1 || extranonce2 || coinb2
//	merkleRoot = fold(sha256d(coinbase), merkle_branches)
//
// extranonce2 differs per share — it is what lets a miner keep hashing when
// the 32-bit nonce space is exhausted — so the header cannot be a fixed
// template: every V1 Work carries the template pieces and the worker derives
// the header per extranonce2.
package miner

import (
	"fmt"
)

// V1JobTemplate carries the Stratum V1 mining.notify fields needed to
// reconstruct a block header: everything the pool sent verbatim, plus the
// negotiated extranonce1/en2 size. Non-nil on a Work means "this is a V1
// job — derive the header per extranonce2" rather than hashing the fixed
// Header field as V2 work does.
type V1JobTemplate struct {
	JobID           string   // echoed verbatim on mining.submit
	Version         uint32   // block header version
	PrevHash        [32]byte // previous block hash, wire order
	NTime           uint32   // block header time
	NBits           uint32   // compact network target
	Coinb1          []byte   // coinbase prefix (raw bytes)
	Coinb2          []byte   // coinbase suffix (raw bytes)
	MerkleBranches  [][]byte // branch hashes, wire order, verbatim
	Extranonce1     []byte   // session-negotiated, raw bytes
	Extranonce2Size int      // bytes of extranonce2 the pool expects
}

// BuildV1Header assembles the 80-byte header fields for a V1 job and the
// caller-chosen extranonce2. The pool recomputes exactly this header on
// submit, so any divergence (endianness, missing coinbase part) yields
// shares that always fail validation.
func BuildV1Header(t *V1JobTemplate, extranonce2 []byte) (Header, error) {
	if t == nil {
		return Header{}, fmt.Errorf("miner: nil V1 template")
	}
	if len(extranonce2) != t.Extranonce2Size {
		return Header{}, fmt.Errorf("miner: extranonce2 is %d bytes, pool expects %d", len(extranonce2), t.Extranonce2Size)
	}
	if len(t.Coinb1) == 0 || len(t.Coinb2) == 0 {
		return Header{}, fmt.Errorf("miner: V1 job missing coinbase halves")
	}
	coinbase := make([]byte, 0, len(t.Coinb1)+len(t.Extranonce1)+len(extranonce2)+len(t.Coinb2))
	coinbase = append(coinbase, t.Coinb1...)
	coinbase = append(coinbase, t.Extranonce1...)
	coinbase = append(coinbase, extranonce2...)
	coinbase = append(coinbase, t.Coinb2...)
	root := SHA256d(coinbase)
	for _, branch := range t.MerkleBranches {
		if len(branch) != 32 {
			return Header{}, fmt.Errorf("miner: merkle branch is %d bytes, want 32", len(branch))
		}
		buf := make([]byte, 0, 64)
		buf = append(buf, root[:]...)
		buf = append(buf, branch...)
		root = SHA256d(buf)
	}
	return Header{
		Version:    t.Version,
		PrevHash:   t.PrevHash,
		MerkleRoot: [32]byte(root),
		Time:       t.NTime,
		Bits:       t.NBits,
	}, nil
}
