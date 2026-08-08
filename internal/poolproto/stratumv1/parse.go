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

// notification is a decoded mining.notify message, before the miner-side
// work (coinbase assembly, merkle fold) that turns it into a
// poolproto.Job. It exists because that work needs session state the
// parser has no business knowing — extranonce1 and the extranonce2 the
// session picks for this job.
type notification struct {
	JobID string

	// PrevHash is already converted from the notify byte order into the
	// order a serialised block header uses (see work.go).
	PrevHash [32]byte

	// Coinb1/Coinb2 sandwich extranonce1‖extranonce2 to form the
	// coinbase transaction; Branch folds that leaf into the merkle root.
	Coinb1 []byte
	Coinb2 []byte
	Branch [][32]byte

	Version   uint32
	NBits     uint32
	NTime     uint32
	CleanJobs bool
}

// parseNotify decodes the parameters of a mining.notify message.
// V1 mining.notify format:
//
//	[job_id, prevhash, coinb1, coinb2, merkle_branch, version, nbits, ntime, clean_jobs]
//
// Every hex field is validated to its exact expected length, mirroring
// cpuminer's stratum_notify (which requires 64 hex chars of prevhash and 8
// each of version/nbits/ntime, and rejects the whole notification
// otherwise). A job with any field missing or malformed cannot produce a
// header a pool would accept, so it is refused here rather than mined into
// the void with zeroed fields.
func parseNotify(raw json.RawMessage) (notification, error) {
	var p []json.RawMessage
	if err := json.Unmarshal(raw, &p); err != nil {
		return notification{}, err
	}
	if len(p) < 9 {
		return notification{}, fmt.Errorf("notify: expected 9 params, got %d", len(p))
	}

	var (
		n                                        notification
		jobID, prevHashHex, coinb1Hex, coinb2Hex string
		versionHex, nbitsHex, ntimeHex           string
		cleanJobs                                bool
		branchHex                                []string
	)
	for _, f := range []struct {
		raw  json.RawMessage
		dest *string
		name string
	}{
		{p[0], &jobID, "job_id"},
		{p[1], &prevHashHex, "prevhash"},
		{p[2], &coinb1Hex, "coinb1"},
		{p[3], &coinb2Hex, "coinb2"},
		{p[5], &versionHex, "version"},
		{p[6], &nbitsHex, "nbits"},
		{p[7], &ntimeHex, "ntime"},
	} {
		if err := json.Unmarshal(f.raw, f.dest); err != nil {
			return notification{}, fmt.Errorf("notify: %s: %w", f.name, err)
		}
	}
	if err := json.Unmarshal(p[4], &branchHex); err != nil {
		return notification{}, fmt.Errorf("notify: merkle_branch: %w", err)
	}
	if err := json.Unmarshal(p[8], &cleanJobs); err != nil {
		// Some pools encode this as 0/1 instead of true/false; tolerate.
		var v int
		if err2 := json.Unmarshal(p[8], &v); err2 != nil {
			return notification{}, fmt.Errorf("notify: clean_jobs: %w", err)
		}
		cleanJobs = v != 0
	}

	prevHash, err := decodeHex32(prevHashHex, "prevhash")
	if err != nil {
		return notification{}, err
	}
	n.PrevHash = headerPrevHash(prevHash)

	if n.Coinb1, err = hex.DecodeString(coinb1Hex); err != nil {
		return notification{}, fmt.Errorf("notify: coinb1: %w", err)
	}
	if n.Coinb2, err = hex.DecodeString(coinb2Hex); err != nil {
		return notification{}, fmt.Errorf("notify: coinb2: %w", err)
	}
	n.Branch = make([][32]byte, len(branchHex))
	for i, h := range branchHex {
		if n.Branch[i], err = decodeHex32(h, "merkle_branch"); err != nil {
			return notification{}, err
		}
	}

	for _, f := range []struct {
		hex  string
		dest *uint32
		name string
	}{
		{versionHex, &n.Version, "version"},
		{nbitsHex, &n.NBits, "nbits"},
		{ntimeHex, &n.NTime, "ntime"},
	} {
		v, perr := strconv.ParseUint(f.hex, 16, 32)
		if perr != nil || len(f.hex) != 8 {
			return notification{}, fmt.Errorf("notify: %s: want 8 hex digits, got %q", f.name, f.hex)
		}
		*f.dest = uint32(v)
	}

	n.JobID = jobID
	n.CleanJobs = cleanJobs
	return n, nil
}

// decodeHex32 decodes a 64-character hex string into a 32-byte array,
// rejecting anything of the wrong length (the pool is untrusted input).
func decodeHex32(s, field string) ([32]byte, error) {
	var out [32]byte
	b, err := hex.DecodeString(s)
	if err != nil {
		return out, fmt.Errorf("notify: %s: %w", field, err)
	}
	if len(b) != 32 {
		return out, fmt.Errorf("notify: %s: want 32 bytes, got %d", field, len(b))
	}
	copy(out[:], b)
	return out, nil
}

// buildJob turns a decoded notification into the protocol-agnostic
// poolproto.Job the engine mines, using the session's extranonce1 and the
// extranonce2 chosen for this job to assemble the coinbase and fold the
// merkle root.
func (n notification) buildJob(extranonce1, extranonce2 []byte) poolproto.Job {
	return poolproto.Job{
		JobID:      n.JobID,
		Version:    n.Version,
		PrevHash:   n.PrevHash,
		MerkleRoot: merkleRoot(buildCoinbase(n.Coinb1, extranonce1, extranonce2, n.Coinb2), n.Branch),
		NTime:      n.NTime,
		NBits:      n.NBits,
		CleanJobs:  n.CleanJobs,
		ReceivedAt: time.Now(),
	}
}

// parseDifficulty decodes mining.set_difficulty params: [diff].
func parseDifficulty(raw json.RawMessage) (float64, bool) {
	var p []float64
	if err := json.Unmarshal(raw, &p); err != nil || len(p) == 0 {
		return 0, false
	}
	return p[0], true
}

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
	return en1, int(en2SizeF), nil
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
