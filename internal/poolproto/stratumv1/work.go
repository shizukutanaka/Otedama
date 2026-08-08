// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package stratumv1 — work.go
//
// Block-header construction for Stratum V1. Unlike Stratum V2 — where the
// pool sends a ready-made merkle root — V1 makes the *miner* assemble the
// coinbase transaction and fold the merkle branch itself. Everything in
// this file is pure: bytes in, bytes out, no session state, so each rule
// can be unit-tested against real block data.
//
// # Provenance of the byte-order rules
//
// Stratum V1 has no standardisation document, so the rules below are taken
// from the two canonical implementations, one on each side of the wire.
// They agree, which is what makes the round trip verifiable:
//
//   - Client side — pooler/cpuminer, cpu-miner.c stratum_gen_work() and
//     util.c stratum_notify(). stratum_notify stores prevhash, version,
//     nbits, ntime and each merkle branch entry as raw hex2bin bytes with
//     no reordering; stratum_gen_work then loads the header words with
//     le32dec() into a buffer that the SHA-256 core consumes as
//     big-endian words (confirmed by the padding words it writes:
//     data[20] = 0x80000000 and data[31] = 0x00000280, the big-endian
//     SHA-256 padding for an 80-byte message). Loading little-endian and
//     serialising big-endian is a byte reversal *within each 4-byte word*,
//     word order preserved. The merkle root is loaded with be32dec()
//     instead, i.e. it enters the header exactly as SHA256d produced it.
//
//   - Pool side — zone117x/node-stratum-pool, blockTemplate.js:
//     `prevHashReversed = util.reverseByteOrder(previousblockhash)`, where
//     reverseByteOrder byte-reverses each of the 8 words in place and then
//     reverses the whole 32-byte buffer. Applied to the RPC's big-endian
//     display hash d0‖d1‖…‖d7 that yields d7‖d6‖…‖d0 — the display hash
//     with its 4-byte words in reverse order, each word's own bytes
//     untouched.
//
// Composing the two: reversing each word of d7‖d6‖…‖d0 gives
// rev(d7)‖rev(d6)‖…‖rev(d0), which is the full 32-byte reversal of the
// display hash — exactly the previous-block-hash field of a serialised
// Bitcoin block header. TestHeaderPrevHash_Block125552 walks that round
// trip on a real block and hashes the result.
package stratumv1

import (
	"crypto/sha256"
	"encoding/binary"
)

// sha256d computes SHA256(SHA256(b)), Bitcoin's double-SHA256.
//
// stratumv1 deliberately does not import internal/miner for this: the
// protocol packages sit below the miner in the dependency graph (the
// engine wires them together), and a one-line standard-library call is
// cheaper than the coupling.
func sha256d(b []byte) [32]byte {
	first := sha256.Sum256(b)
	return sha256.Sum256(first[:])
}

// buildCoinbase concatenates the four pieces of a Stratum V1 coinbase
// transaction in wire order:
//
//	coinb1 ‖ extranonce1 ‖ extranonce2 ‖ coinb2
//
// coinb1/coinb2 come from mining.notify, extranonce1 from the
// mining.subscribe response (or a later mining.set_extranonce), and
// extranonce2 is chosen by the miner — it is the miner's private search
// space, and whatever value is used here MUST be echoed back in
// mining.submit or the pool reconstructs a different coinbase, computes a
// different merkle root, and rejects the share.
func buildCoinbase(coinb1, extranonce1, extranonce2, coinb2 []byte) []byte {
	out := make([]byte, 0, len(coinb1)+len(extranonce1)+len(extranonce2)+len(coinb2))
	out = append(out, coinb1...)
	out = append(out, extranonce1...)
	out = append(out, extranonce2...)
	out = append(out, coinb2...)
	return out
}

// merkleRoot computes the block's merkle root from the assembled coinbase
// transaction and the pool-supplied merkle branch.
//
// The branch holds the sibling hashes on the path from the coinbase leaf
// to the root, in order, so the fold is
//
//	root = SHA256d(coinbase)
//	root = SHA256d(root ‖ branch[i])   for each i
//
// The coinbase is always the leftmost leaf, so the sibling is always
// appended on the right — there is no ordering decision to make per level.
// An empty branch (a block containing only the coinbase, e.g. genesis)
// leaves the coinbase hash as the root.
//
// The result is in Bitcoin's internal byte order, ready to be copied
// straight into the header's merkle-root field.
func merkleRoot(coinbase []byte, branch [][32]byte) [32]byte {
	root := sha256d(coinbase)
	var buf [64]byte
	for _, sibling := range branch {
		copy(buf[0:32], root[:])
		copy(buf[32:64], sibling[:])
		root = sha256d(buf[:])
	}
	return root
}

// headerPrevHash converts the previous-block hash as it arrives in
// mining.notify into the byte order the serialised block header uses.
//
// The notify form is the display hash with its eight 4-byte words in
// reverse order (see the package-level provenance note); reversing the
// bytes *within* each word, leaving word order alone, produces the header
// field. The transform is its own inverse.
func headerPrevHash(notify [32]byte) [32]byte {
	var out [32]byte
	for w := 0; w < 8; w++ {
		for b := 0; b < 4; b++ {
			out[w*4+b] = notify[w*4+3-b]
		}
	}
	return out
}

// extraNonce2 encodes a counter as a size-byte extranonce2, little-endian,
// matching cpuminer's in-place increment over the extranonce2 buffer
// (`for (i = 0; i < xnonce2_size && !++xnonce2[i]; i++)`, which carries
// from the lowest-addressed byte upward).
//
// A fresh value per job widens the search space beyond the 2^32 nonces a
// single header offers, and — more importantly in practice — keeps two
// jobs that carry identical coinbase halves (a pool re-issuing work on the
// same template) from producing byte-identical headers, which would make
// the second job's shares duplicates of the first's.
//
// size is the extranonce2_size the pool asked for in its mining.subscribe
// response; a pool that asks for 0 gets an empty extranonce2. Counter bits
// above 8*size are truncated, which simply means the sequence wraps.
func extraNonce2(counter uint64, size int) []byte {
	if size <= 0 {
		return nil
	}
	var full [8]byte
	binary.LittleEndian.PutUint64(full[:], counter)
	out := make([]byte, size)
	copy(out, full[:min(size, 8)])
	return out
}
