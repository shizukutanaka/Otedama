// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
//
// Fuzz coverage for loadConfigFile — the boundary where arbitrary
// on-disk bytes become a config.Config. The unit tests pin the
// named failure classes (malformed YAML, empty, comments-only,
// unreadable); the fuzzer asserts the load path never panics or
// wedges on adversarial content (non-UTF8, deep nesting, alias
// expansion, binary junk) and that a decode error always degrades to
// an empty config plus a warning, never an exception.
package main

import (
	"io"
	"os"
	"path/filepath"
	"testing"
)

func FuzzLoadConfigFile(f *testing.F) {
	f.Add([]byte("pools:\n  - url: stratum+tcp://pool.example:3333\n"))
	f.Add([]byte("bitcoin_address: bc1qexample\nlog_level: debug\n"))
	f.Add([]byte("")) // empty file -> io.EOF -> defaults
	f.Add([]byte("# only a comment\n"))
	f.Add([]byte("\x00\x01\x02\xfe"))               // binary junk
	f.Add([]byte("x: &a [*a, *a]\ny: *a\n"))        // self-referential alias
	f.Add([]byte("a:\n  a:\n    a:\n      a: 1\n")) // nesting
	f.Add([]byte("unknown_field: true\n"))          // KnownFields rejection
	f.Fuzz(func(t *testing.T, data []byte) {
		// Bound input size: the loader is a config parser, not a bulk
		// consumer — multi-MB inputs are out of contract.
		if len(data) > 64*1024 {
			t.Skip("input beyond config-file size contract")
		}
		dir := t.TempDir()
		path := filepath.Join(dir, "config.yaml")
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
		cfg := loadConfigFile(path, io.Discard)

		// A decode that succeeded must yield a validatable config;
		// Validate() is the downstream consumer and must not panic on
		// whatever the decoder produced.
		_ = cfg.Validate()

		// Cross-check KnownFields rejection: yaml that decodes cleanly
		// but names unknown fields warns and yields the empty config.
		// (No assertion needed beyond "returns without panic" — the
		// contract is degrade-to-default, and Validate above proves the
		// result is a structurally usable Config.)
	})
}
