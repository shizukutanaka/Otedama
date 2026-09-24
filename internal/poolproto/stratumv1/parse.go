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

	"github.com/shizukutanaka/Otedama/internal/miner"
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
		jobID, prevHashHex, _, _, versionHex, nbitsHex, ntimeHex string
		cleanJobs                                                bool
	)
	if err := json.Unmarshal(p[0], &jobID); err != nil {
		return poolproto.Job{}, err
	}
	if err := json.Unmarshal(p[1], &prevHashHex); err != nil {
		return poolproto.Job{}, err
	}
	// p[2] coinb1, p[3] coinb2, p[4] merkle_branch — Otedama doesn't
	// reconstruct the coinbase in the V1 path (the pool does). We
	// could in a future JDP variant.
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
	if v, err := strconv.ParseUint(versionHex, 16, 32); err == nil {
		job.Version = uint32(v)
	}
	if v, err := strconv.ParseUint(nbitsHex, 16, 32); err == nil {
		job.NBits = uint32(v)
	}
	if v, err := strconv.ParseUint(ntimeHex, 16, 32); err == nil {
		job.NTime = uint32(v)
	}
	if b, err := hex.DecodeString(prevHashHex); err == nil && len(b) == 32 {
		copy(job.PrevHash[:], b)
	}
	// MerkleRoot remains zero in the V1 path; the pool computes it.
	return job, nil
}

// parseDifficulty decodes mining.set_difficulty params: [diff].
// Degenerate values (zero, negative, NaN, +Inf) are rejected: storing
// one would make TargetFromDifficulty fail on every subsequent share,
// letting a buggy or hostile pool DoS the session.
func parseDifficulty(raw json.RawMessage) (float64, bool) {
	var p []float64
	if err := json.Unmarshal(raw, &p); err != nil || len(p) == 0 {
		return 0, false
	}
	if d := p[0]; d > 0 && !math.IsInf(d, 0) && !math.IsNaN(d) {
		return d, true
	}
	return 0, false
}

// parseSetTarget decodes a pool→client target notification's params:
// [target_hex] — the vardiff variant some pools (braiins/bosminer,
// ckpool-family, BFGMiner-era software) send instead of set_difficulty,
// as mining.set_target (and occasionally mining.suggest_target in the
// same notification shape). The wire value is a 256-bit target as 64
// hex digits in BIG-endian order (zip-0301 §mining.set_target); we
// convert it to the difficulty number our callers expect from
// SuggestedDifficulty(). A malformed or zero/degenerate target is
// rejected (a zero target would mean infinite difficulty — the same
// guard as the SV2 zero-target lesson).
func parseSetTarget(raw json.RawMessage) (float64, bool) {
	var p []string
	if err := json.Unmarshal(raw, &p); err != nil || len(p) == 0 {
		return 0, false
	}
	hexStr := p[0]
	if len(hexStr) != 64 {
		return 0, false
	}
	be, err := hex.DecodeString(hexStr)
	if err != nil || len(be) != 32 {
		return 0, false
	}
	var h miner.Hash
	for i := 0; i < 32; i++ {
		h[i] = be[31-i] // wire is big-endian; Hash/DifficultyFromTarget expect little-endian
	}
	d := miner.DifficultyFromTarget(h)
	if math.IsInf(d, 0) || math.IsNaN(d) || d <= 0 {
		return 0, false
	}
	return d, true
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
	if !validExtranonce(en1, sz) {
		return "", 0, false
	}
	return en1, sz, true
}

// parseVersionMask decodes a mining.set_version_mask notification.
// Params format: ["1fffe000"] — a hex bitmask of the version bits the
// pool permits the miner to roll. Returns false on any parse error;
// the caller ignores malformed pushes rather than tearing down the
// session (same convention as the other optional notifications).
func parseVersionMask(raw json.RawMessage) (uint32, bool) {
	var p []json.RawMessage
	if err := json.Unmarshal(raw, &p); err != nil || len(p) < 1 {
		return 0, false
	}
	var hexMask string
	if err := json.Unmarshal(p[0], &hexMask); err != nil || hexMask == "" {
		return 0, false
	}
	v, err := strconv.ParseUint(hexMask, 16, 32)
	if err != nil {
		return 0, false
	}
	return uint32(v), true
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
	if en2SizeF != math.Trunc(en2SizeF) {
		return "", 0, fmt.Errorf("stratumv1: extranonce2_size not an integer: %v", en2SizeF)
	}
	if !validExtranonce(en1, int(en2SizeF)) {
		return "", 0, fmt.Errorf("stratumv1: extranonce values out of range (en1 len=%d, en2_size=%v)", len(en1), en2SizeF)
	}
	return en1, int(en2SizeF), nil
}

// validExtranonce bounds the extranonce pair at subscribe time and on
// mining.set_extranonce pushes. Bounds: extranonce2 lives inside the
// coinbase script (≤100 bytes total with extranonce1), and a negative
// size would panic strings.Repeat at submit time — a hostile pool could
// crash the session. Pools in the wild use 4–8; 64 is the generous
// ceiling. extranonce1 is hex-encoded when present.
func validExtranonce(en1 string, en2Size int) bool {
	if en2Size < 1 || en2Size > 64 {
		return false
	}
	if en1 == "" {
		return true
	}
	if len(en1) > 128 || len(en1)%2 != 0 {
		return false
	}
	_, err := hex.DecodeString(en1)
	return err == nil
}

// ----- helpers -----

// parseAddress extracts host:port from a stratum+tcp://, stratum+tls://
// or datum:// URL (DATUM gateways speak plain SV1 over TCP).
func parseAddress(url string) (string, error) {
	for _, prefix := range []string{"stratum+tcp://", "stratum+tls://", "datum://"} {
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
