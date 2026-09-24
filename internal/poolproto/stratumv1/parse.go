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

	var jobID, prevHashHex, versionHex, nbitsHex, ntimeHex string
	if err := json.Unmarshal(p[0], &jobID); err != nil {
		return poolproto.Job{}, err
	}
	if err := json.Unmarshal(p[1], &prevHashHex); err != nil {
		return poolproto.Job{}, err
	}
	// p[2] coinb1, p[3] coinb2, p[4] merkle_branch feed V1 coinbase
	// reconstruction — without them the header's merkle root is zero
	// and every share the pool reconstructs fails its own hash check.
	coinb1, coinb2, branch, err := parseCoinbaseParts(p[2], p[3], p[4])
	if err != nil {
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
	cleanJobs, err := parseCleanJobs(p[8])
	if err != nil {
		return poolproto.Job{}, err
	}

	job := poolproto.Job{
		JobID:        jobID,
		CleanJobs:    cleanJobs,
		ReceivedAt:   time.Now(),
		Coinb1:       coinb1,
		Coinb2:       coinb2,
		MerkleBranch: branch,
	}
	// The numeric header fields are required on the wire. Accepting an
	// unparseable value silently zeroes it — a job that then produces
	// only rejects (bad ntime/nbits) with no diagnostic. Malformed input
	// drops here, where the job-starvation watchdog can see it.
	v, err := strconv.ParseUint(versionHex, 16, 32)
	if err != nil {
		return poolproto.Job{}, fmt.Errorf("notify: bad version %q: %w", versionHex, err)
	}
	job.Version = uint32(v)
	if v, err = strconv.ParseUint(nbitsHex, 16, 32); err != nil {
		return poolproto.Job{}, fmt.Errorf("notify: bad nbits %q: %w", nbitsHex, err)
	}
	job.NBits = uint32(v)
	if v, err = strconv.ParseUint(ntimeHex, 16, 32); err != nil {
		return poolproto.Job{}, fmt.Errorf("notify: bad ntime %q: %w", ntimeHex, err)
	}
	job.NTime = uint32(v)
	b, err := hex.DecodeString(prevHashHex)
	if err != nil || len(b) != 32 {
		return poolproto.Job{}, fmt.Errorf("notify: bad prevhash %q", prevHashHex)
	}
	copy(job.PrevHash[:], b)
	return job, nil
}

// parseCleanJobs decodes the notify clean_jobs flag. The spec says
// bool, but some pools encode it as 0/1 — tolerate both.
func parseCleanJobs(raw json.RawMessage) (bool, error) {
	var b bool
	if err := json.Unmarshal(raw, &b); err != nil {
		var n int
		if err2 := json.Unmarshal(raw, &n); err2 != nil {
			return false, err
		}
		return n != 0, nil
	}
	return b, nil
}

// parseCoinbaseParts decodes the notify params that carry the coinbase
// split and merkle branch — wire-order bytes as hex. A malformed value
// would zero the merkle root and burn the whole job into rejects, so
// they are checked as strictly as the header fields.
func parseCoinbaseParts(p2, p3, p4 json.RawMessage) (coinb1, coinb2 []byte, branch [][32]byte, err error) {
	var coinb1Hex, coinb2Hex string
	var branchHex []string
	if err := json.Unmarshal(p2, &coinb1Hex); err != nil {
		return nil, nil, nil, err
	}
	if err := json.Unmarshal(p3, &coinb2Hex); err != nil {
		return nil, nil, nil, err
	}
	if err := json.Unmarshal(p4, &branchHex); err != nil {
		return nil, nil, nil, err
	}
	if coinb1, err = hex.DecodeString(coinb1Hex); err != nil {
		return nil, nil, nil, fmt.Errorf("notify: bad coinb1 %q: %w", coinb1Hex, err)
	}
	if coinb2, err = hex.DecodeString(coinb2Hex); err != nil {
		return nil, nil, nil, fmt.Errorf("notify: bad coinb2 %q: %w", coinb2Hex, err)
	}
	branch = make([][32]byte, len(branchHex))
	for i, bh := range branchHex {
		bb, err := hex.DecodeString(bh)
		if err != nil || len(bb) != 32 {
			return nil, nil, nil, fmt.Errorf("notify: bad merkle_branch[%d] %q", i, bh)
		}
		copy(branch[i][:], bb)
	}
	return coinb1, coinb2, branch, nil
}

// parseDifficulty decodes mining.set_difficulty params: [diff].
func parseDifficulty(raw json.RawMessage) (float64, bool) {
	var p []float64
	if err := json.Unmarshal(raw, &p); err != nil || len(p) == 0 {
		return 0, false
	}
	return p[0], true
}

// maxExtranonce2Size bounds the pool-supplied extranonce2_size. Real
// pools send 4–8; 64 bytes is generous headroom — larger values are a
// malformed or hostile notification, since the size feeds
// strings.Repeat on every submit (negative = panic, huge = memory
// exhaustion).
const maxExtranonce2Size = 64

// parseSetExtranonce decodes mining.set_extranonce params:
// [extranonce1_hex, extranonce2_size_int]. The size is parsed as float64
// (like parseSubscribeResult) because JSON numbers have no int type — a
// pool encoding "4.0" would otherwise be rejected wholesale, leaving the
// stale size to mis-pad every subsequent submit into en2-length rejects.
func parseSetExtranonce(raw json.RawMessage) (string, int, bool) {
	var p []json.RawMessage
	if err := json.Unmarshal(raw, &p); err != nil || len(p) < 2 {
		return "", 0, false
	}
	var en1 string
	var sz float64
	if err := json.Unmarshal(p[0], &en1); err != nil {
		return "", 0, false
	}
	if err := json.Unmarshal(p[1], &sz); err != nil || sz < 0 || sz > maxExtranonce2Size || math.Trunc(sz) != sz {
		return "", 0, false
	}
	return en1, int(sz), true
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
	if en2Size < 0 || en2Size > maxExtranonce2Size || float64(en2Size) != en2SizeF {
		return "", 0, fmt.Errorf("stratumv1: extranonce2_size %v out of range [0,%d]", en2SizeF, maxExtranonce2Size)
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

// parseConfigureResult decodes a mining.configure response for the
// "version-rolling" extension (BIP-310). Returns the negotiated mask
// and true only when the server activated the extension
// (result["version-rolling"] == true) AND supplied a usable
// "version-rolling.mask" hex value. A rejected extension
// ("version-rolling": false), a missing mask, or a malformed mask all
// leave version rolling disabled — the miner just never rolls.
func parseConfigureResult(result any) (uint32, bool) {
	m, ok := result.(map[string]any)
	if !ok {
		return 0, false
	}
	enabled, ok := m["version-rolling"].(bool)
	if !ok || !enabled {
		return 0, false
	}
	hexMask, ok := m["version-rolling.mask"].(string)
	if !ok {
		return 0, false
	}
	v, err := strconv.ParseUint(hexMask, 16, 32)
	if err != nil {
		return 0, false
	}
	return uint32(v), true
}

// parseSetVersionMask decodes a mining.set_version_mask notification:
// params is [mask_hex]. The server may rotate the mask mid-session;
// the new mask applies immediately (BIP-310), not on the next job.
func parseSetVersionMask(raw json.RawMessage) (uint32, bool) {
	var p []string
	if err := json.Unmarshal(raw, &p); err != nil || len(p) == 0 {
		return 0, false
	}
	v, err := strconv.ParseUint(p[0], 16, 32)
	if err != nil {
		return 0, false
	}
	return uint32(v), true
}
