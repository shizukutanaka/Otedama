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

// ----- helpers -----

// parseAddress extracts host:port from a stratum+tcp:// or stratum+tls:// URL.
func parseAddress(url string) (string, error) {
	for _, prefix := range []string{"stratum+tcp://", "stratum+tls://"} {
		if strings.HasPrefix(url, prefix) {
			rest := url[len(prefix):]
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
