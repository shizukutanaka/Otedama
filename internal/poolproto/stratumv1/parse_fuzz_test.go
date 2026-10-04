// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package stratumv1

import (
	"encoding/json"
	"net"
	"testing"

	"github.com/shizukutanaka/Otedama/internal/poolproto"
)

// FuzzDispatchLine drives the session's JSON-RPC dispatcher with arbitrary
// wire bytes. The dispatcher runs on cleartext, pool-controlled input, so it
// must never panic or block: every branch is either non-blocking or bounded.
func FuzzDispatchLine(f *testing.F) {
	seeds := [][]byte{
		[]byte(`{"id":1,"result":[[["mining.set_difficulty","x"]],"aabbcc",4],"error":null}`),
		[]byte(`{"id":2,"result":true,"error":null}`),
		[]byte(`{"id":3,"result":null,"error":[21,"stale"]}`),
		[]byte(`{"method":"mining.notify","params":["job1","abcd","cb1","cb2",["m1"],"1a2b3c","50406030","5f3e2d1c",true]}`),
		[]byte(`{"method":"mining.notify","params":[]}`),
		[]byte(`{"method":"mining.set_difficulty","params":[512.5]}`),
		[]byte(`{"method":"mining.set_difficulty","params":[0]}`),
		[]byte(`{"method":"mining.set_difficulty","params":[-1]}`),
		[]byte(`{"method":"mining.set_extranonce","params":["deadbeef",8]}`),
		[]byte(`{"method":"client.show_message","params":["maintenance in 10 min"]}`),
		[]byte(`{"method":"client.reconnect","params":["pool.example.com",3333,30]}`),
		[]byte(`{"method":"client.reconnect","params":[]}`),
		[]byte(`{"method":"unknown.method","params":{"x":1}}`),
		[]byte(`{"id":"not-a-number","result":null}`),
		[]byte(`not json at all`),
		[]byte(``),
		[]byte("\x00\x01\x02"),
	}
	for _, s := range seeds {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, line []byte) {
		srv, cli := net.Pipe()
		defer srv.Close()
		sess := &session{
			conn:     &connection{raw: cli},
			jobsCh:   make(chan poolproto.Job, 8),
			noticeCh: make(chan string, 4),
			pending:  make(map[uint64]chan rpcResponse),
		}
		sess.dispatch(line)
		_ = sess.Close()
		cli.Close()
	})
}

// FuzzParseSubscribeResult fuzzes the subscribe-response shape parser with
// arbitrary decoded-JSON values.
func FuzzParseSubscribeResult(f *testing.F) {
	seeds := [][]byte{
		[]byte(`[[["mining.notify","id"]],"aabbccdd",8]`),
		[]byte(`[]`),
		[]byte(`[null,null,null]`),
		[]byte(`[["x"],"en1","8"]`),
		[]byte(`[["x"],123,-4]`),
		[]byte(`{"en1":"abc"}`),
		[]byte(`"plain string"`),
	}
	for _, s := range seeds {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		var result any
		if err := json.Unmarshal(data, &result); err != nil {
			return
		}
		en1, en2Size, err := parseSubscribeResult(result)
		if err == nil {
			if en1 == "" {
				t.Fatalf("ok result with empty extranonce1 for %q", data)
			}
			_ = en2Size
		}
	})
}
