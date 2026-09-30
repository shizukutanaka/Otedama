// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
//
// Fuzz coverage for the V1 notification parsers not reached by
// FuzzDispatchLine/FuzzParseSubscribeResult: mining.notify,
// client.reconnect, mining.set_extranonce, client.show_message. All are
// pool-controlled inputs on the read path; the contract is that any
// byte sequence returns an error or a bounded result — never a panic
// (index arithmetic), never a wedge.
package stratumv1

import (
	"encoding/json"
	"testing"
)

// FuzzParseNotify feeds arbitrary params payloads to the mining.notify
// parser. The 9-slot format means most random inputs reject at the
// length guard; seeds include well-formed and near-miss arrays to get
// past it into the per-field unmarshals and hex/dec paths.
func FuzzParseNotify(f *testing.F) {
	f.Add(`["job42","4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b","0101","0202",["ab","cd"],"20000000","1d00ffff","5f5e1000",true]`)
	f.Add(`["j","","","","","1","1","1",1]`)                            // minimal types
	f.Add(`[null,null,null,null,null,null,null,null,null]`)             // all-null
	f.Add(`[]`)                                                         // empty array
	f.Add(`["j"]`)                                                      // length-guard
	f.Add(`["j","00","c1","c2",[],"zz","zz","zz",false]`)               // bad hex
	f.Add(`["j","00","c1","c2",[],"ffffffff","ffffffff","ffffffff",0]`) // max u32
	f.Fuzz(func(t *testing.T, data string) {
		// Contract: never panics; accepted results are simply returned.
		_, _ = parseNotify(json.RawMessage(data))
	})
}

// FuzzParseReconnect feeds arbitrary params to the client.reconnect
// parser. Host/Port are recorded but deliberately never dialed (see
// reconnectDirective's doc); the contract is no panic and a directive for
// every input, garbage included — the bare notification is itself the signal.
func FuzzParseReconnect(f *testing.F) {
	f.Add(`["pool.example.com",3333,30]`)
	f.Add(`["host","notaport","notawait"]`)
	f.Add(`[]`)
	f.Add(`"notanarray"`)
	f.Add(`[{"a":1},[1],{"b":2}]`)
	f.Fuzz(func(t *testing.T, data string) {
		d := parseReconnect(json.RawMessage(data))
		_ = d // Host/Port/Wait are advisory-only; bounds enforced by consumers
	})
}

// FuzzParseSetExtranonce feeds arbitrary params to the
// mining.set_extranonce parser. Consumers bound extranonce2_size; the
// parser's contract is no panic and ok=false on malformed input.
func FuzzParseSetExtranonce(f *testing.F) {
	f.Add(`["aabbcc",4]`)
	f.Add(`["aabbcc","4"]`) // size as string — must reject
	f.Add(`[123,4]`)        // en1 non-string — must reject
	f.Add(`["onlyone"]`)    // length-guard
	f.Add(`["",-1]`)        // empty en1, negative size — parser accepts, consumer bounds
	f.Fuzz(func(t *testing.T, data string) {
		_, _, _ = parseSetExtranonce(json.RawMessage(data))
	})
}

// FuzzParseShowMessage feeds arbitrary params to the client.show_message
// parser — the text is operator-visible, so control bytes must at least
// parse without panic (sanitization happens at the display boundary).
func FuzzParseShowMessage(f *testing.F) {
	f.Add(`["pool maintenance in 5 minutes"]`)
	f.Add(`["\u001b[31mred\x00nul"]`)
	f.Add(`[]`)
	f.Add(`[1,2,3]`)
	f.Add(`["multi","element","array"]`)
	f.Fuzz(func(t *testing.T, data string) {
		msg, ok := parseShowMessage(json.RawMessage(data))
		if !ok {
			return
		}
		// Contract: ok ⟹ non-panic; message text is whatever the pool sent.
		_ = msg
	})
}
