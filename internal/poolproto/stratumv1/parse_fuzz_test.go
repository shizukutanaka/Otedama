// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package stratumv1

import (
	"bufio"
	"bytes"
	"testing"
)

// FuzzSession_ReadLine exercises the V1 line reader — the unbounded-line
// memory surface — with arbitrary bytes. A stream with no newline must
// hit the maxLineBytes ceiling (error), never grow memory unboundedly;
// short lines must be returned whole and never panic.
func FuzzSession_ReadLine(f *testing.F) {
	seeds := [][]byte{
		// Normal JSON-RPC line.
		[]byte("{\"id\":1,\"result\":true}\n"),
		// No newline — stream ends before terminator.
		[]byte("{\"id\":1,\"result\":true}"),
		// Empty.
		{},
		// Bare newline.
		{'\n'},
		// Binary garbage with embedded newlines.
		{0xDE, 0xAD, '\n', 0xBE, 0xEF, '\n'},
		// Very long line without newline (built at runtime below).
	}
	// A line just over the ceiling forces the ErrBufferFull path.
	over := bytes.Repeat([]byte{'a'}, maxLineBytes+1)
	seeds = append(seeds, over)
	// A line exactly at the ceiling.
	at := append(bytes.Repeat([]byte{'b'}, maxLineBytes-1), '\n')
	seeds = append(seeds, at)

	for _, s := range seeds {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, data []byte) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("readLine panicked on input (%d bytes): %v", len(data), r)
			}
		}()

		s := &session{reader: bufio.NewReaderSize(bytes.NewReader(data), maxLineBytes)}
		for i := 0; i < 100; i++ {
			line, err := s.readLine()
			if err != nil {
				return
			}
			if len(line) > maxLineBytes {
				t.Fatalf("readLine returned %d bytes > maxLineBytes %d", len(line), maxLineBytes)
			}
		}
	})
}

// FuzzParseNotification feeds arbitrary bytes through every JSON-RPC
// notification parser. None may panic on malformed JSON or unexpected
// shapes — every path must return an error or a zero/ok=false result.
func FuzzParseNotification(f *testing.F) {
	seeds := [][]byte{
		// Well-formed mining.notify params.
		[]byte(`{"params":["j1","prev","c1","c2",[],"v","nb","nt",true]}`),
		// Well-formed mining.set_difficulty.
		[]byte(`{"params":[1024.5]}`),
		// Well-formed client.show_message.
		[]byte(`{"params":["pool maintenance in 1h"]}`),
		// Valid JSON, wrong shape.
		[]byte(`{"params":{"unexpected":"object"}}`),
		[]byte(`[1,2,3]`),
		[]byte(`"just a string"`),
		[]byte(`12345`),
		// Truncated JSON.
		[]byte(`{"params":["j1","pre`),
		// Garbage.
		{0xDE, 0xAD, 0xBE, 0xEF},
		// Empty.
		{},
	}
	for _, s := range seeds {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, data []byte) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("notification parser panicked on %q: %v", data, r)
			}
		}()
		_, _ = parseNotify(data)
		_, _ = parseDifficulty(data)
		_, _, _ = parseSetExtranonce(data)
		_, _ = parseShowMessage(data)
		_, _ = parseReconnect(data)
	})
}
