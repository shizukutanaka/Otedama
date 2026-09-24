// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package stratumv1 — parse.go
//
// Pure parsing functions for Stratum V1 server→client notifications
// (mining.notify, mining.set_difficulty, mining.set_extranonce) plus
// small address/byte/float helpers. Extracted from stratumv1.go to
// separate stateless decoding from the stateful session machinery.
//
// These functions are unexported but live in their own file so the
// session logic in stratumv1.go reads as protocol orchestration, not
// JSON plumbing.
package stratumv1

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/shizukutanaka/Otedama/internal/poolproto"
)

// ----- parsers (exported only for tests in this package) -----

// parseNotify decodes the parameters of a mining.notify message.
// V1 mining.notify format:
//
//	[job_id, prevhash, coinb1, coinb2, merkle_branch, version, nbits, ntime, clean_jobs]
func parseNotify(raw json.RawMessage) (poolproto.Job, error) {
	var p []json.RawMessage
	if err := json.Unmarshal(raw, &p); err != nil {
		return poolproto.Job{}, err
	}
	if len(p) < 9 {
		return poolproto.Job{}, fmt.Errorf("notify: expected 9 params, got %d", len(p))
	}

	var (
		jobID, prevHashHex, coinb1Hex, coinb2Hex, versionHex, nbitsHex, ntimeHex string
		branchHex                                                                []string
		cleanJobs                                                                bool
	)
	if err := json.Unmarshal(p[0], &jobID); err != nil {
		return poolproto.Job{}, err
	}
	if err := json.Unmarshal(p[1], &prevHashHex); err != nil {
		return poolproto.Job{}, err
	}
	if err := json.Unmarshal(p[2], &coinb1Hex); err != nil {
		return poolproto.Job{}, err
	}
	if err := json.Unmarshal(p[3], &coinb2Hex); err != nil {
		return poolproto.Job{}, err
	}
	if err := json.Unmarshal(p[4], &branchHex); err != nil {
		return poolproto.Job{}, err
	}
	if err := json.Unmarshal(p[5], &versionHex); err != nil {
		return poolproto.Job{}, err
	}
	if err := json.Unmarshal(p[6], &nbitsHex); err != nil {
		return poolproto.Job{}, err
	}
	if err := json.Unmarshal(p[7], &ntimeHex); err != nil {
		return poolproto.Job{}, err
	}
	if err := json.Unmarshal(p[8], &cleanJobs); err != nil {
		// Some pools encode this as 0/1 instead of true/false; tolerate.
		var n int
		if err2 := json.Unmarshal(p[8], &n); err2 == nil {
			cleanJobs = n != 0
		} else {
			return poolproto.Job{}, err
		}
	}

	job := poolproto.Job{
		JobID:      jobID,
		CleanJobs:  cleanJobs,
		ReceivedAt: time.Now(),
	}
	// The hex fields are required by the protocol: silently defaulting any
	// of them to zero would emit a structurally valid but worthless job —
	// workers would grind a header with a zero prevhash/nbits/ntime and
	// every produced share would be rejected, burning hashrate invisibly.
	// Reject the notification instead so the engine keeps its last good
	// job (or pauses) rather than mining garbage.
	v, err := strconv.ParseUint(versionHex, 16, 32)
	if err != nil {
		return poolproto.Job{}, fmt.Errorf("notify: bad version %q: %w", versionHex, err)
	}
	job.Version = uint32(v)
	v, err = strconv.ParseUint(nbitsHex, 16, 32)
	if err != nil {
		return poolproto.Job{}, fmt.Errorf("notify: bad nbits %q: %w", nbitsHex, err)
	}
	job.NBits = uint32(v)
	v, err = strconv.ParseUint(ntimeHex, 16, 32)
	if err != nil {
		return poolproto.Job{}, fmt.Errorf("notify: bad ntime %q: %w", ntimeHex, err)
	}
	job.NTime = uint32(v)
	b, err := hex.DecodeString(prevHashHex)
	if err != nil {
		return poolproto.Job{}, fmt.Errorf("notify: bad prevhash: %w", err)
	}
	if len(b) != 32 {
		return poolproto.Job{}, fmt.Errorf("notify: bad prevhash length %d, want 32 bytes", len(b))
	}
	copy(job.PrevHash[:], b)
	// The coinbase halves are likewise required fields — the session
	// computes the merkle root from them, and a missing or malformed
	// half would produce a root the pool never rebuilds, invalidating
	// every share ground against it.
	if job.Coinb1, err = hex.DecodeString(coinb1Hex); err != nil || len(job.Coinb1) == 0 {
		return poolproto.Job{}, fmt.Errorf("notify: bad coinb1: %w", err)
	}
	if job.Coinb2, err = hex.DecodeString(coinb2Hex); err != nil || len(job.Coinb2) == 0 {
		return poolproto.Job{}, fmt.Errorf("notify: bad coinb2: %w", err)
	}
	// The merkle branch may legitimately be empty (a coinbase-only
	// block), but every element must be a 32-byte hash — the session
	// folds them verbatim, so a malformed element corrupts the root
	// and invalidates all resulting shares.
	job.MerkleBranch = make([][]byte, len(branchHex))
	for i, h := range branchHex {
		if job.MerkleBranch[i], err = hex.DecodeString(h); err != nil {
			return poolproto.Job{}, fmt.Errorf("notify: bad merkle_branch[%d]: %w", i, err)
		}
		if len(job.MerkleBranch[i]) != 32 {
			return poolproto.Job{}, fmt.Errorf("notify: merkle_branch[%d] length %d, want 32 bytes", i, len(job.MerkleBranch[i]))
		}
	}
	// The session computes MerkleRoot in sendJob from these parts and
	// the negotiated extranonces (see stratumv1.go).
	return job, nil
}

// parseDifficulty decodes mining.set_difficulty params: [diff].
//
// Values that are not strictly positive (zero, negative, ±Inf — NaN
// cannot appear in JSON) are rejected: the engine falls back to the
// nBits *block* target whenever the session difficulty is non-positive,
// and a persisted bad value would pin every subsequent job at that
// near-impossible target — the pool would see no credited shares again
// until the next valid set_difficulty. Ignoring the update preserves the
// previous good difficulty instead.
func parseDifficulty(raw json.RawMessage) (float64, bool) {
	var p []float64
	if err := json.Unmarshal(raw, &p); err != nil || len(p) == 0 {
		return 0, false
	}
	if !(p[0] > 0) || math.IsInf(p[0], 0) {
		return 0, false
	}
	return p[0], true
}

// maxExtranonce2Size bounds the pool-supplied extranonce2 size (bytes).
// Real pools assign 4–8; the bound is generous headroom, not a protocol
// limit. Without it a malicious or broken pool could crash Submit via
// strings.Repeat (negative count panics) or grow each submission by
// megabytes (memory amplification).
const maxExtranonce2Size = 64

// validExtranonce2Size reports whether sz is a usable extranonce2 size:
// at least one byte of miner-rolled variance (a zero size would let the
// miner never roll, so every share collides) and small enough that
// per-submit padding stays trivial.
func validExtranonce2Size(sz int) bool { return sz >= 1 && sz <= maxExtranonce2Size }

// parseSetExtranonce decodes mining.set_extranonce params:
// [extranonce1_hex, extranonce2_size_int].
func parseSetExtranonce(raw json.RawMessage) (string, int, bool) {
	var p []json.RawMessage
	if err := json.Unmarshal(raw, &p); err != nil || len(p) < 2 {
		return "", 0, false
	}
	var en1 string
	var sz int
	if err := json.Unmarshal(p[0], &en1); err != nil {
		return "", 0, false
	}
	if err := json.Unmarshal(p[1], &sz); err != nil {
		return "", 0, false
	}
	if !validExtranonce2Size(sz) {
		return "", 0, false
	}
	return en1, sz, true
}

// parseShowMessage decodes a client.show_message notification.
// Params format: ["human-readable message text"].
// Returns the message and true on success; empty string and false on any parse error.
func parseShowMessage(raw json.RawMessage) (string, bool) {
	var p []string
	if err := json.Unmarshal(raw, &p); err != nil || len(p) == 0 {
		return "", false
	}
	return p[0], true
}

// reconnectDirective is a parsed client.reconnect notification.
//
// V1 client.reconnect params: [hostname, port, wait] — all optional.
// A pool sends this to gracefully move a miner to another node (load
// balancing / maintenance / failover). Otedama deliberately records but
// does NOT follow the pool-supplied Host:Port: honouring an arbitrary
// endpoint from an unauthenticated notification is a redirection vector,
// and the reconnect loop already owns the operator-configured pool list.
// Wait is advisory (seconds to pause before reconnecting).
type reconnectDirective struct {
	Host string
	Port int
	Wait int
}

// parseReconnect decodes mining.reconnect / client.reconnect params.
// All three fields are optional; an empty or malformed params list still
// yields a valid (zero-value) directive with ok=true, because the bare
// notification itself is the signal to reconnect.
func parseReconnect(raw json.RawMessage) (reconnectDirective, bool) {
	var d reconnectDirective
	if len(raw) == 0 {
		return d, true
	}
	var p []json.RawMessage
	if err := json.Unmarshal(raw, &p); err != nil {
		// A bare "client.reconnect" with no/garbage params is still a
		// valid directive — the method alone means "reconnect".
		return d, true
	}
	if len(p) >= 1 {
		_ = json.Unmarshal(p[0], &d.Host) // best-effort; tolerate non-string
	}
	if len(p) >= 2 {
		if err := json.Unmarshal(p[1], &d.Port); err != nil {
			// Some pools encode the port as a string.
			var s string
			if json.Unmarshal(p[1], &s) == nil {
				d.Port, _ = strconv.Atoi(s)
			}
		}
	}
	if len(p) >= 3 {
		_ = json.Unmarshal(p[2], &d.Wait)
	}
	return d, true
}

// parseSubscribeResult extracts extranonce1 and extranonce2Size from a
// mining.subscribe response. The V1 result envelope is:
//
//	[[[sub_type, sub_id], ...], extranonce1_hex, extranonce2_size_int]
//
// The subscriptions array (index 0) is advisory and ignored; only the
// extranonce fields at indices 1 and 2 are needed for share construction.
func parseSubscribeResult(result any) (en1 string, en2Size int, err error) {
	arr, ok := result.([]any)
	if !ok || len(arr) < 3 {
		// len(arr) is 0 when the assertion failed (nil slice), otherwise the
		// actual element count — both are the right value for the diagnostic.
		return "", 0, fmt.Errorf("stratumv1: unexpected subscribe result (type=%T, len=%d)", result, len(arr))
	}
	en1, ok = arr[1].(string)
	if !ok {
		return "", 0, fmt.Errorf("stratumv1: extranonce1 not a string: %T", arr[1])
	}
	en2SizeF, ok := arr[2].(float64)
	if !ok {
		return "", 0, fmt.Errorf("stratumv1: extranonce2_size not a number: %T", arr[2])
	}
	en2Size = int(en2SizeF)
	if !validExtranonce2Size(en2Size) {
		return "", 0, fmt.Errorf("stratumv1: extranonce2_size %v out of range [1,%d]", en2SizeF, maxExtranonce2Size)
	}
	return en1, en2Size, nil
}

// ----- helpers -----

// parseAddress extracts host:port from a stratum+tcp:// or stratum+tls:// URL.
func parseAddress(url string) (string, error) {
	for _, prefix := range []string{"stratum+tcp://", "stratum+tls://"} {
		if rest, ok := strings.CutPrefix(url, prefix); ok {
			if rest == "" {
				return "", fmt.Errorf("stratumv1: empty host in %q", url)
			}
			return rest, nil
		}
	}
	return "", fmt.Errorf("stratumv1: unsupported scheme in %q", url)
}

// trimRight strips trailing \r and \n.
func trimRight(b []byte) []byte {
	for len(b) > 0 && (b[len(b)-1] == '\n' || b[len(b)-1] == '\r') {
		b = b[:len(b)-1]
	}
	return b
}

// float64ToUint64 / uint64ToFloat64 are atomic.Uint64 helpers for
// storing a float without an extra mutex. These wrap math.Float64bits
// and math.Float64frombits, which use the well-defined IEEE 754 bit
// pattern reinterpretation.
func float64ToUint64(f float64) uint64 { return math.Float64bits(f) }
func uint64ToFloat64(u uint64) float64 { return math.Float64frombits(u) }
