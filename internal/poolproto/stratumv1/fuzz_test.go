// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
package stratumv1

// Fuzz targets for the Stratum V1 parsers. The V2 framing/Noise path
// gained fuzz coverage in earlier sessions (internal/stratum); these
// functions are the equivalent untrusted-input surface on the V1 side —
// every byte a pool sends after the handshake flows through them, and a
// malformed or hostile notification must return an error, never panic
// or corrupt session state.
//
// Run a quick sweep with:
//
//	go test -fuzz=FuzzParseNotify -fuzztime=30s ./internal/poolproto/stratumv1/
import (
	"encoding/json"
	"testing"
)

// FuzzParseNotify feeds arbitrary bytes as mining.notify params.
// Contract: any input either parses to a Job or returns an error —
// never a panic. A parsed Job's JobID echoes the first param exactly
// (no silent mutation of the pool's job identifier).
func FuzzParseNotify(f *testing.F) {
	f.Add(`["1","4d16b6f85af6e2198f44ae2a6de67f78487ae5611b77c6c0440b921e00000000","","",[],"00000002","1d00ffff","68d36c5e",true]`)
	f.Add(`["abc","00","","",[],"zz","xx","yy",1]`)
	f.Add(`[]`)
	f.Add(`["1"]`)
	f.Fuzz(func(t *testing.T, params string) {
		job, err := parseNotify(json.RawMessage(params))
		if err != nil {
			return
		}
		// jobID is set verbatim from params[0]; a non-empty decoded job
		// must carry it unchanged.
		var p []json.RawMessage
		if json.Unmarshal([]byte(params), &p) == nil && len(p) >= 1 {
			var want string
			if json.Unmarshal(p[0], &want) == nil && job.JobID != want {
				t.Fatalf("JobID mutated: got %q, want %q", job.JobID, want)
			}
		}
	})
}

// FuzzParseDifficulty: mining.set_difficulty params must decode to a
// finite-or-infinite float64 slice or fail; negative/huge values are
// legal at the parser layer (miner.TargetFromDifficulty rejects
// non-positive and infinite difficulty downstream — that boundary is
// the contract being fuzzed here: no panic, no silent clamp).
func FuzzParseDifficulty(f *testing.F) {
	f.Add(`[1024]`)
	f.Add(`[0]`)
	f.Add(`[-1.5]`)
	f.Add(`[1e300]`)
	f.Add(`[]`)
	f.Add(`"nope"`)
	f.Fuzz(func(t *testing.T, params string) {
		d, ok := parseDifficulty(json.RawMessage(params))
		if !ok {
			return
		}
		var p []float64
		if err := json.Unmarshal([]byte(params), &p); err != nil || len(p) == 0 {
			t.Fatalf("parseDifficulty ok=%v but params %q did not decode", ok, params)
		}
		if d != p[0] {
			t.Fatalf("parseDifficulty returned %v, params[0] is %v", d, p[0])
		}
	})
}

// FuzzParseSetExtranonce: mining.set_extranonce params decode to
// (en1 string, en2Size int) or fail — never panic on hostile shapes.
// en2Size feeds strings.Repeat on every submit, so the parser bounds it
// to [0, maxExtranonce2Size]; negative or huge values must not parse.
func FuzzParseSetExtranonce(f *testing.F) {
	f.Add(`["c0ffee",4]`)
	f.Add(`["",0]`)
	f.Add(`[123,"x"]`)
	f.Add(`[]`)
	f.Add(`["aa",-1]`)
	f.Add(`["aa",1000000]`)
	f.Fuzz(func(t *testing.T, params string) {
		en1, sz, ok := parseSetExtranonce(json.RawMessage(params))
		if !ok {
			return
		}
		if sz < 0 || sz > maxExtranonce2Size {
			t.Fatalf("extranonce2 size %d outside [0,%d] accepted from %q", sz, maxExtranonce2Size, params)
		}
		_ = en1
	})
}

// FuzzParseReconnect: parseReconnect never fails by contract — the bare
// notification is itself the directive. Fuzz asserts that contract:
// ok must always be true and the call must never panic.
func FuzzParseReconnect(f *testing.F) {
	f.Add(`["pool.example.com",3333,60]`)
	f.Add(`["host","4444","wait"]`)
	f.Add(`[]`)
	f.Add(`{"not":"an array"}`)
	f.Fuzz(func(t *testing.T, params string) {
		d, ok := parseReconnect(json.RawMessage(params))
		if !ok {
			t.Fatalf("parseReconnect violated its never-fail contract on %q", params)
		}
		if d.Port < 0 || d.Port > 65535 {
			// Not a crash — but a port outside the valid range is always
			// a parse artifact worth knowing about.
			t.Logf("port %d out of range from %q", d.Port, params)
		}
	})
}

// FuzzParseSubscribeResult exercises the loosely-typed `any` decode of
// the mining.subscribe result envelope — the one parser that takes a
// pre-decoded value rather than raw bytes.
func FuzzParseSubscribeResult(f *testing.F) {
	f.Add(`[[["mining.set_difficulty","s1"],["mining.notify","s2"]],"c0ffee",4]`)
	f.Add(`[null,null,null]`)
	f.Add(`{}`)
	f.Add(`"str"`)
	f.Fuzz(func(t *testing.T, raw string) {
		var result any
		if err := json.Unmarshal([]byte(raw), &result); err != nil {
			return // parser contract starts post-Unmarshal
		}
		en1, sz, err := parseSubscribeResult(result)
		if err != nil {
			return
		}
		if sz < 0 || sz > maxExtranonce2Size {
			t.Fatalf("extranonce2 size %d outside [0,%d] accepted from %q", sz, maxExtranonce2Size, raw)
		}
		_ = en1
	})
}

// FuzzParseShowMessage: client.show_message params → first string or
// failure. The session layer drops empty messages (`notice != ""`), so
// the parser's contract is only: ok ⇒ the params were a non-empty
// []string — no panic on hostile shapes.
func FuzzParseShowMessage(f *testing.F) {
	f.Add(`["maintenance in 10 min"]`)
	f.Add(`[]`)
	f.Add(`[123]`)
	f.Add(`[""]`)
	f.Fuzz(func(t *testing.T, params string) {
		msg, ok := parseShowMessage(json.RawMessage(params))
		if !ok {
			return
		}
		var p []string
		if err := json.Unmarshal([]byte(params), &p); err != nil || len(p) == 0 || p[0] != msg {
			t.Fatalf("inconsistent result msg=%q ok=%v from %q", msg, ok, params)
		}
	})
}

// TestExtranonce2SizeBounds — the pool-supplied size feeding
// strings.Repeat must be bounded in both entry points (mid-session
// set_extranonce and the subscribe handshake).
func TestExtranonce2SizeBounds(t *testing.T) {
	for _, params := range []string{
		`["aa",-1]`, `["aa",65]`, `["aa",1000000000]`,
	} {
		if _, sz, ok := parseSetExtranonce(json.RawMessage(params)); ok {
			t.Errorf("set_extranonce %s accepted size %d", params, sz)
		}
	}
	if _, sz, ok := parseSetExtranonce(json.RawMessage(`["aa",8]`)); !ok || sz != 8 {
		t.Errorf("legit size 8 rejected: ok=%v sz=%d", ok, sz)
	}
	for _, raw := range []string{
		`[["s"],"aa",-1]`, `[["s"],"aa",1e9]`, `[["s"],"aa",4.5]`,
	} {
		var result any
		if err := json.Unmarshal([]byte(raw), &result); err != nil {
			t.Fatal(err)
		}
		if _, sz, err := parseSubscribeResult(result); err == nil {
			t.Errorf("subscribe result %s accepted size %d", raw, sz)
		}
	}
}
