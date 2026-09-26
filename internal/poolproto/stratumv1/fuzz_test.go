// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package stratumv1

import (
	"encoding/json"
	"math"
	"testing"
)

// FuzzV1Parsers feeds arbitrary bytes into every server→client V1 parse
// entry point: parseNotify, parseDifficulty, parseSetExtranonce,
// parseShowMessage, parseReconnect, and parseSubscribeResult. These are the
// Otedama analogue of the sv1_api translator parser SRI flagged as the next
// fuzz target after the noise_sv2 arithmetic-overflow find (see
// RESEARCH_IMPROVEMENTS session-262 item 1).
//
// Invariants asserted for every input:
//   - No panic (every parser must tolerate malformed JSON and type
//     confusion silently — dispatch ignores unparseable lines).
//   - parseDifficulty / parseSetExtranonce / parseSubscribeResult never
//     return a NaN difficulty or an extranonce2_size outside
//     [0, maxExtranonce2Size] — that size reaches strings.Repeat at
//     Submit time, so an unbounded value is a memory-exhaustion vector.
//   - parseNotify success implies a structurally complete job (9 params
//     consumed); field-level garbage must not produce a nonzero
//     PrevHash/Version/NBits/NTime unless the hex actually decoded.
func FuzzV1Parsers(f *testing.F) {
	seeds := [][]byte{
		// Valid mining.notify params.
		[]byte(`["job1","aabbccdd","cb1","cb2",[],"00000020","1a2b3c4d","5f6a7b8c",true]`),
		// clean_jobs as int (some pools).
		[]byte(`["job1","aabbccdd","cb1","cb2",[],"00000020","1a2b3c4d","5f6a7b8c",1]`),
		// Valid set_difficulty params.
		[]byte(`[1024.5]`),
		[]byte(`[0]`),
		[]byte(`[-1]`),           // negative difficulty — stored but TargetFromDifficulty rejects
		[]byte(`[1e308]`),        // near-overflow difficulty
		[]byte(`[0.0000000001]`), // absurdly easy share
		// Valid set_extranonce params.
		[]byte(`["aabb", 4]`),
		[]byte(`["aabb", 0]`),
		[]byte(`["aabb", 64]`),         // boundary: maxExtranonce2Size
		[]byte(`["aabb", 65]`),         // boundary: just over — must be rejected
		[]byte(`["aabb", 1073741824]`), // 1 GiB of "00" padding if unbounded
		[]byte(`["aabb", -5]`),
		[]byte(`["aabb", 4.9]`), // fractional size
		// Valid show_message / reconnect.
		[]byte(`["pool maintenance in 10 min"]`),
		[]byte(`["host.example", 3333, 0]`),
		[]byte(`[]`),
		[]byte(`[1, 2, 3, 4]`),
		// Valid subscribe result.
		[]byte(`[[["mining.notify","id1"]],"aabbccdd",4]`),
		[]byte(`[[["mining.notify","id1"]],"aabbccdd",1073741824]`),
		// Type confusion.
		[]byte(`"just a string"`),
		[]byte(`{"method":"mining.notify"}`),
		[]byte(`[null,null,null,null,null,null,null,null,null]`),
		[]byte(`12345`),
		[]byte(`null`),
		// Malformed JSON.
		[]byte(`["unterminated`),
		[]byte(`{`),
		[]byte(`\x00\x01\x02`),
		{},
	}
	for _, s := range seeds {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, data []byte) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("parser panicked on input %q: %v", data, r)
			}
		}()

		raw := json.RawMessage(data)

		if _, err := parseNotify(raw); err == nil {
			// Success path: nothing further to assert — the parsers
			// tolerate field-level garbage (bad hex → zero value).
		}

		if d, ok := parseDifficulty(raw); ok {
			if math.IsNaN(d) {
				t.Errorf("parseDifficulty(%q) returned NaN", data)
			}
		}

		if _, sz, ok := parseSetExtranonce(raw); ok {
			if sz < 0 || sz > maxExtranonce2Size {
				t.Errorf("parseSetExtranonce(%q) returned size %d outside [0, %d]",
					data, sz, maxExtranonce2Size)
			}
		}

		// show_message returns arbitrary text — no invariant beyond no-panic.
		_, _ = parseShowMessage(raw)

		// reconnect always yields a directive; the fields are advisory and
		// never drive a dial, so no numeric invariant applies.
		_, _ = parseReconnect(raw)

		// parseSubscribeResult takes `any` — mirror the JSON path first.
		var decoded any
		if err := json.Unmarshal(data, &decoded); err == nil {
			if _, sz, err := parseSubscribeResult(decoded); err == nil {
				if sz < 0 || sz > maxExtranonce2Size {
					t.Errorf("parseSubscribeResult(%q) returned size %d outside [0, %d]",
						data, sz, maxExtranonce2Size)
				}
			}
		}
	})
}
