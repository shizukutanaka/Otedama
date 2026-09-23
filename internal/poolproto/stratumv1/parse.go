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

// notifyJob is a parsed mining.notify: the protocol-agnostic Job the
// session forwards to the engine plus the coinbase pieces needed to
// reconstruct the block header's merkle root. V1 miners must build the
// coinbase themselves — the pool never computes the merkle root; it
// verifies the share's hash against a header the MINER assembles.
// (Previous revisions dropped these fields, which left MerkleRoot
// zeroed and every submitted share unverifiable — see
// docs/KNOWN_LIMITATIONS.md §17.)
type notifyJob struct {
	poolproto.Job
	coinb1   []byte
	coinb2   []byte
	branches [][32]byte // merkle_branch list, each entry hex-decoded
}

// parseNotify decodes the parameters of a mining.notify message.
// V1 mining.notify format:
//
//	[job_id, prevhash, coinb1, coinb2, merkle_branch, version, nbits, ntime, clean_jobs]
func parseNotify(raw json.RawMessage) (notifyJob, error) {
	var p []json.RawMessage
	if err := json.Unmarshal(raw, &p); err != nil {
		return notifyJob{}, err
	}
	if len(p) < 9 {
		return notifyJob{}, fmt.Errorf("notify: expected 9 params, got %d", len(p))
	}

	var (
		jobID, prevHashHex, coinb1Hex, coinb2Hex, versionHex, nbitsHex, ntimeHex string
		branchHexes                                                              []string
		cleanJobs                                                                bool
	)
	if err := json.Unmarshal(p[0], &jobID); err != nil {
		return notifyJob{}, err
	}
	if err := json.Unmarshal(p[1], &prevHashHex); err != nil {
		return notifyJob{}, err
	}
	if err := json.Unmarshal(p[2], &coinb1Hex); err != nil {
		return notifyJob{}, err
	}
	if err := json.Unmarshal(p[3], &coinb2Hex); err != nil {
		return notifyJob{}, err
	}
	if err := json.Unmarshal(p[4], &branchHexes); err != nil {
		return notifyJob{}, err
	}
	if err := json.Unmarshal(p[5], &versionHex); err != nil {
		return notifyJob{}, err
	}
	if err := json.Unmarshal(p[6], &nbitsHex); err != nil {
		return notifyJob{}, err
	}
	if err := json.Unmarshal(p[7], &ntimeHex); err != nil {
		return notifyJob{}, err
	}
	if err := json.Unmarshal(p[8], &cleanJobs); err != nil {
		// Some pools encode this as 0/1 instead of true/false; tolerate.
		var n int
		if err2 := json.Unmarshal(p[8], &n); err2 == nil {
			cleanJobs = n != 0
		} else {
			return notifyJob{}, err
		}
	}

	job := notifyJob{
		Job: poolproto.Job{
			JobID:      jobID,
			CleanJobs:  cleanJobs,
			ReceivedAt: time.Now(),
		},
	}
	if v, err := strconv.ParseUint(versionHex, 16, 32); err == nil {
		job.Version = uint32(v)
	} else {
		return notifyJob{}, fmt.Errorf("notify: bad version %q: %w", versionHex, err)
	}
	if v, err := strconv.ParseUint(nbitsHex, 16, 32); err == nil {
		job.NBits = uint32(v)
	} else {
		return notifyJob{}, fmt.Errorf("notify: bad nbits %q: %w", nbitsHex, err)
	}
	if v, err := strconv.ParseUint(ntimeHex, 16, 32); err == nil {
		job.NTime = uint32(v)
	} else {
		return notifyJob{}, fmt.Errorf("notify: bad ntime %q: %w", ntimeHex, err)
	}
	// Stratum V1 transmits prevhash as the display-order hash hex.
	// The canonical conversion into header byte order is a per-word
	// (32-bit) byte swap — reverse_endianness_per_word in ESP-Miner's
	// stratum/mining.c — NOT a full reverse: each 4-byte word keeps
	// its position while its bytes are swapped. Storing it any other
	// way makes every mined header hash to a value the pool cannot
	// verify — an always-reject bug.
	b, err := hex.DecodeString(prevHashHex)
	if err != nil || len(b) != 32 {
		return notifyJob{}, fmt.Errorf("notify: bad prevhash %q (len=%d)", prevHashHex, len(b))
	}
	for i := 0; i < 32; i += 4 {
		job.PrevHash[i+0] = b[i+3]
		job.PrevHash[i+1] = b[i+2]
		job.PrevHash[i+2] = b[i+1]
		job.PrevHash[i+3] = b[i+0]
	}
	if b, err := hex.DecodeString(coinb1Hex); err == nil {
		job.coinb1 = b
	} else {
		return notifyJob{}, fmt.Errorf("notify: bad coinb1: %w", err)
	}
	if b, err := hex.DecodeString(coinb2Hex); err == nil {
		job.coinb2 = b
	} else {
		return notifyJob{}, fmt.Errorf("notify: bad coinb2: %w", err)
	}
	for _, bh := range branchHexes {
		b, err := hex.DecodeString(bh)
		if err != nil || len(b) != 32 {
			// Skip malformed branch entries rather than failing the whole
			// job — a truncated merkle path still yields a valid header
			// when the pool (incorrectly) sends padding garbage.
			continue
		}
		var branch [32]byte
		copy(branch[:], b)
		job.branches = append(job.branches, branch)
	}
	return job, nil
}

// parseDifficulty decodes mining.set_difficulty params: [diff].
// A non-positive or non-finite value is not a usable share target —
// rejected here so a malformed notification cannot poison the
// difficulty the worker filters shares against.
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
