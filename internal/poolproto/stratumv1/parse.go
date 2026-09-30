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
	"unicode"

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
		merkleBranchHexs                                                         []string
		cleanJobs                                                                bool
	)
	if err := json.Unmarshal(p[0], &jobID); err != nil {
		return poolproto.Job{}, err
	}
	if err := json.Unmarshal(p[1], &prevHashHex); err != nil {
		return poolproto.Job{}, err
	}
	// p[2] coinb1, p[3] coinb2, p[4] merkle_branch — the session folds
	// these into the job's MerkleRoot (see completeV1Job). V1 notify has
	// no pool-supplied merkle field, so malformed hex is fatal: an empty
	// coinb or dropped branch yields a wrong root and every share fails
	// self-verification — silent wasted work. (The "pool-side merkle"
	// path on poolproto.Job is the V2 NewMiningJob wire field, not V1.)
	if err := json.Unmarshal(p[2], &coinb1Hex); err != nil {
		return poolproto.Job{}, err
	}
	if err := json.Unmarshal(p[3], &coinb2Hex); err != nil {
		return poolproto.Job{}, err
	}
	if err := json.Unmarshal(p[4], &merkleBranchHexs); err != nil {
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
	b, err := hex.DecodeString(coinb1Hex)
	if err != nil || len(b) == 0 {
		return poolproto.Job{}, fmt.Errorf("notify: coinb1: malformed or empty")
	}
	job.Coinb1 = b
	if b, err = hex.DecodeString(coinb2Hex); err != nil || len(b) == 0 {
		return poolproto.Job{}, fmt.Errorf("notify: coinb2: malformed or empty")
	}
	job.Coinb2 = b
	for _, h := range merkleBranchHexs {
		b, err := hex.DecodeString(h)
		if err != nil || len(b) != 32 {
			return poolproto.Job{}, fmt.Errorf("notify: merkle_branch: malformed or wrong length")
		}
		job.MerkleBranch = append(job.MerkleBranch, b)
	}
	// Header fields are required: a malformed value would zero-fill and
	// produce a job whose every share fails self-verification — silent
	// wasted work until the next notify. Reject the notify instead.
	v, err := strconv.ParseUint(versionHex, 16, 32)
	if err != nil {
		return poolproto.Job{}, fmt.Errorf("notify: version: %w", err)
	}
	job.Version = uint32(v)
	if v, err = strconv.ParseUint(nbitsHex, 16, 32); err != nil {
		return poolproto.Job{}, fmt.Errorf("notify: nbits: %w", err)
	}
	job.NBits = uint32(v)
	if v, err = strconv.ParseUint(ntimeHex, 16, 32); err != nil {
		return poolproto.Job{}, fmt.Errorf("notify: ntime: %w", err)
	}
	job.NTime = uint32(v)
	if b, err := hex.DecodeString(prevHashHex); err == nil && len(b) == 32 {
		copy(job.PrevHash[:], b)
	} else {
		return poolproto.Job{}, fmt.Errorf("notify: prevhash: malformed or wrong length")
	}
	// MerkleRoot is completed by the session (completeV1Job) once the
	// negotiated extranonce1/2 are folded into the coinbase.
	return job, nil
}

// parseDifficulty decodes mining.set_difficulty params: [diff].
// Difficulty must be a positive, finite float: NaN/±Inf would poison the
// share-target computation downstream, and d <= 0 collapses the target
// to "accept every hash" — a share-flood vector on cleartext V1.
func parseDifficulty(raw json.RawMessage) (float64, bool) {
	var p []float64
	if err := json.Unmarshal(raw, &p); err != nil || len(p) == 0 {
		return 0, false
	}
	d := p[0]
	if d <= 0 || math.IsNaN(d) || math.IsInf(d, 0) {
		return 0, false
	}
	return d, true
}

// maxExtranonce2Size bounds the pool-supplied extranonce2_size. The value
// flows into strings.Repeat on every mining.submit, so an unbounded value
// is a memory-exhaustion vector on cleartext V1 (hostile pool or MitM).
// Real pools use 4–8; 64 leaves generous headroom for pool-side schemes
// while capping the padding at 128 hex chars.
const maxExtranonce2Size = 64

// extranonce2SizeOK reports whether sz is a usable extranonce2_size.
// completeV1Job requires sz > 0 to fold the client's en2 into the
// coinbase — 0 would leave MerkleRoot zeroed and every share invalid.
func extranonce2SizeOK(sz int) bool { return sz > 0 && sz <= maxExtranonce2Size }

// extranonce1OK reports whether en1 is usable hex: completeV1Job
// hex-decodes it and silently skips the job when decode fails, so a
// non-hex or empty extranonce1 must be rejected at the parse boundary.
func extranonce1OK(en1 string) bool {
	if en1 == "" {
		return false
	}
	b, err := hex.DecodeString(en1)
	return err == nil && len(b) > 0
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
	if !extranonce1OK(en1) || !extranonce2SizeOK(sz) {
		return "", 0, false
	}
	return en1, sz, true
}

// maxNoticeRunes caps the length of a pool-sent notice. Notices end up
// in the log (and potentially the TUI), so an unbounded pool string is a
// log-flooding vector.
const maxNoticeRunes = 256

// sanitizeNotice removes control characters (C0, DEL, C1 — including
// ANSI escape introducers) and truncates to maxNoticeRunes runes. The
// text is pool-controlled; consumers write it to terminals and log
// files, where escape sequences could manipulate the display or forge
// log lines.
func sanitizeNotice(s string) string {
	clean := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
	runes := []rune(clean)
	if len(runes) > maxNoticeRunes {
		clean = string(runes[:maxNoticeRunes])
	}
	return clean
}

// parseShowMessage decodes a client.show_message notification.
// Params format: ["human-readable message text"].
// Returns the message and true on success; empty string and false on any parse error.
func parseShowMessage(raw json.RawMessage) (string, bool) {
	var p []string
	if err := json.Unmarshal(raw, &p); err != nil || len(p) == 0 {
		return "", false
	}
	return sanitizeNotice(p[0]), true
}

// reconnectDirective is a parsed client.reconnect notification.
//
// V1 client.reconnect params: [hostname, port, wait] — all optional.
// A pool sends this to gracefully move a miner to another node (load
// balancing / maintenance / failover). Otedama deliberately records but
// does NOT follow the pool-supplied Host:Port: honoring an arbitrary
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
func parseReconnect(raw json.RawMessage) reconnectDirective {
	var d reconnectDirective
	if len(raw) == 0 {
		return d
	}
	var p []json.RawMessage
	if err := json.Unmarshal(raw, &p); err != nil {
		// A bare "client.reconnect" with no/garbage params is still a
		// valid directive — the method alone means "reconnect".
		return d
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
	return d
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
	if !extranonce1OK(en1) {
		return "", 0, fmt.Errorf("stratumv1: extranonce1 not hex: %q", en1)
	}
	en2SizeF, ok := arr[2].(float64)
	if !ok {
		return "", 0, fmt.Errorf("stratumv1: extranonce2_size not a number: %T", arr[2])
	}
	// Validate on the float: int() truncation would let 64.5 or -0.5 pass
	// the bounds check below as 64 or 0. completeV1Job requires sz > 0,
	// so 0 is rejected at the boundary too.
	if en2SizeF != math.Trunc(en2SizeF) || en2SizeF <= 0 || en2SizeF > maxExtranonce2Size {
		return "", 0, fmt.Errorf("stratumv1: extranonce2_size %v out of range (0, %d]", en2SizeF, maxExtranonce2Size)
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
