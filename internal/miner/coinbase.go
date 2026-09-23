// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package miner

// CoinbaseHash returns SHA256d(coinbase) where the coinbase is the
// concatenation of the Stratum V1 mining.notify parts:
//
//	coinbase = coinb1 || extranonce1 || extranonce2 || coinb2
//
// coinb1/coinb2 are the raw (hex-decoded) byte strings from the notify,
// extranonce1 is the session's hex-decoded bytes, and extranonce2 is
// whatever the miner chose for this job (zero bytes when not rotated).
// The result is the coinbase transaction hash — the leaf the merkle
// fold starts from. (Bitcoin hashing convention, e.g. ESP-Miner's
// calculate_coinbase_tx_hash.)
func CoinbaseHash(coinb1, extranonce1, extranonce2, coinb2 []byte) Hash {
	total := len(coinb1) + len(extranonce1) + len(extranonce2) + len(coinb2)
	coinbase := make([]byte, 0, total)
	coinbase = append(coinbase, coinb1...)
	coinbase = append(coinbase, extranonce1...)
	coinbase = append(coinbase, extranonce2...)
	coinbase = append(coinbase, coinb2...)
	return SHA256d(coinbase)
}

// MerkleRootFromCoinbase folds the coinbase transaction hash through
// the notify's merkle_branch array:
//
//	acc = coinbaseHash
//	for each branch b: acc = SHA256d(acc || b)
//
// The result is the block header's merkle root, stored in the header
// as-is (no endianness swap — the chain of SHA256d outputs already
// lands in header byte order). An empty branch list returns the
// coinbase hash itself (a single-transaction block template).
func MerkleRootFromCoinbase(coinbaseHash Hash, branches [][32]byte) Hash {
	acc := coinbaseHash
	for _, b := range branches {
		buf := make([]byte, 0, 64)
		buf = append(buf, acc[:]...)
		buf = append(buf, b[:]...)
		acc = SHA256d(buf)
	}
	return acc
}
