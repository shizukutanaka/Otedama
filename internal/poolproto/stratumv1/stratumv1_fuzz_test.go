// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package stratumv1

import (
	"bufio"
	"net"
	"testing"

	"github.com/shizukutanaka/Otedama/internal/poolproto"
)

// FuzzV1ReadLine exercises session.readLine — the newline-delimited
// JSON-RPC reader — with arbitrary pool-controlled bytes. A misbehaving
// pool must never panic the reader, never force an allocation beyond
// maxLineBytes, and never wedge it (every input must terminate: a line,
// an oversized-line error, or an EOF/short-read error).
//
// Motivation: upstream Stratum fuzzing (SRI, June-2026 research item)
// surfaced length-prefix arithmetic bugs — the class of bug where a
// declared length is trusted before being bounds-checked. readLine's
// defence is bufio.ReadSlice + ErrBufferFull; this target proves the
// defence holds under adversarial input.
//
// A net.Pipe stands in for the TCP connection; the peer goroutine
// writes the fuzz input then closes so the reader always observes a
// termination. Inputs are capped at 96 KiB — the interesting boundary
// is the 64 KiB line cap, and pathological multi-MB inputs would only
// slow the fuzzer without covering new behaviour.
func FuzzV1ReadLine(f *testing.F) {
	seeds := [][]byte{
		{},
		{'\n'},
		[]byte("not json at all\n"),
		[]byte(`{"id":1,"result":true,"error":null}` + "\n"),
		// Lines straddling the 64 KiB cap.
		append(make([]byte, maxLineBytes-2), '\n'),
		append(make([]byte, maxLineBytes+8), '\n'),
		// No newline at all — the oversized-line path.
		make([]byte, maxLineBytes+16),
		// Two lines: first valid, second oversized.
		append([]byte("{\"id\":1}\n"), make([]byte, maxLineBytes)...),
	}
	for _, s := range seeds {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) > 96<<10 {
			return
		}
		c1, c2 := net.Pipe()
		defer c1.Close()
		// Deferred close unblocks a peer writer still flushing the
		// remainder once the reader stops consuming.
		defer c2.Close()
		go func() {
			_, _ = c2.Write(data)
			_ = c2.Close()
		}()

		s := &session{
			conn:   &connection{raw: c1},
			reader: bufio.NewReaderSize(c1, maxLineBytes),
		}

		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("readLine panicked on %d input bytes: %v", len(data), r)
			}
		}()

		line, err := s.readLine()
		if err == nil && len(line) > maxLineBytes {
			t.Fatalf("readLine returned %d-byte line exceeding the %d-byte cap",
				len(line), maxLineBytes)
		}
	})
}

// FuzzV1Dispatch feeds arbitrary bytes to session.dispatch — the
// JSON-RPC decode + routing path for every pool-sent message. The
// decoder must never panic and never block on a channel (jobsCh and
// noticeCh are bounded with drop-oldest semantics, and sendJob never
// blocks).
//
// The session is constructed with a live net.Pipe so the
// client.reconnect branch's `go s.Close()` exercises a real close.
func FuzzV1Dispatch(f *testing.F) {
	seeds := [][]byte{
		{},
		{'{'},
		[]byte("not json"),
		[]byte(`{"id":4,"result":true,"error":null}`),
		[]byte(`{"id":null,"method":"mining.set_difficulty","params":[8192]}`),
		[]byte(`{"id":null,"method":"mining.set_difficulty","params":[1e-9]}`),
		[]byte(`{"id":null,"method":"mining.notify","params":["bf","4d16b6f85af6e2198f44ae2a6de67f78487ae5611b77c6c0440b921e00000000","01","ff",[],"00000002","1d00ffff","68d36c5e",true]}`),
		[]byte(`{"id":null,"method":"mining.notify","params":["bf","zz","01","ff",[],"00000002","1d00ffff","68d36c5e",true]}`),
		[]byte(`{"id":null,"method":"mining.set_extranonce","params":["deadbeef",8]}`),
		[]byte(`{"id":null,"method":"client.show_message","params":["maintenance in 10 min"]}`),
		[]byte(`{"id":null,"method":"client.reconnect","params":["pool.example.com",3333,[]]}`),
		[]byte(`{"id":null,"method":"mining.unknown_extension","params":[]}`),
		// Adversarial JSON shapes.
		[]byte(`{"id":null,"method":"mining.notify","params":[[[[[[[["a"]]]]]]]]}`),
		[]byte(`{"id":"0xFFFFFFFFFFFFFFFF","result":null,"error":null}`),
		[]byte(`{"id":1e308,"result":null,"error":null}`),
	}
	for _, s := range seeds {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) > 96<<10 {
			return
		}
		c1, c2 := net.Pipe()
		defer c1.Close()
		defer c2.Close()

		s := &session{
			conn:     &connection{raw: c1},
			jobsCh:   make(chan poolproto.Job, 8),
			noticeCh: make(chan string, 8),
			pending:  map[uint64]chan rpcResponse{},
		}

		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("dispatch panicked on input %q: %v", data[:min(len(data), 200)], r)
			}
		}()

		s.dispatch(data)

		// Drain anything dispatch produced so the channels carry no
		// state into the deferred closes.
	drain:
		for {
			select {
			case <-s.jobsCh:
			case <-s.noticeCh:
			default:
				break drain
			}
		}
	})
}
