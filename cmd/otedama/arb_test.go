// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestCmdArbExplain_RendersSnapshot exercises the full CLI path: fetch
// the DecisionSnapshot JSON from the daemon's HTTP address and print the
// ExplainText table.
func TestCmdArbExplain_RendersSnapshot(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/arbitration" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"at": "2026-09-23T08:13:00Z",
			"policy": "maximize_earnings",
			"hysteresis_pct": 0.05,
			"total_sats_per_sec": 42.5,
			"rows": [{
				"device_id": "cpu-0",
				"stream": "mining.stratum",
				"expected_sats_per_sec": 42.5,
				"reliability": 0.97,
				"reliability_alpha": 89,
				"reliability_beta": 2.6
			}]
		}`))
	}))
	defer srv.Close()

	var out, errb bytes.Buffer
	code := cmdArbExplain([]string{"--http-addr", strings.TrimPrefix(srv.URL, "http://")}, &out, &errb)
	if code != exitOK {
		t.Fatalf("exit = %d, want 0; stderr: %s", code, errb.String())
	}
	for _, want := range []string{
		"Otedama arbitration decision (2026-09-23 08:13:00)",
		"cpu-0", "mining.stratum", "42.50 sat/s", "α=89.0, β=2.6",
	} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("output missing %q\n%s", want, out.String())
		}
	}
}

// TestCmdArbExplain_JSONPassThrough: --json emits the body's bytes
// unchanged (no decode, no render) for scripting consumers.
func TestCmdArbExplain_JSONPassThrough(t *testing.T) {
	body := []byte(`{"at":"2026-09-23T08:13:00Z","rows":[],"total_sats_per_sec":0}`)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}))
	defer srv.Close()

	var out, errb bytes.Buffer
	code := cmdArbExplain([]string{"--http-addr", strings.TrimPrefix(srv.URL, "http://"), "--json"}, &out, &errb)
	if code != exitOK {
		t.Fatalf("exit = %d, want 0; stderr: %s", code, errb.String())
	}
	if got := strings.TrimSpace(out.String()); got != string(body) {
		t.Errorf("--json must pass the body through verbatim\n got: %s\nwant: %s", got, body)
	}
	if strings.Contains(out.String(), "Otedama arbitration decision") {
		t.Error("--json must not render the table")
	}
}

// TestCmdArbExplain_503Message: a daemon that has not ticked yet returns
// 503; the command explains rather than dumping an error trace.
func TestCmdArbExplain_503Message(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("no arbitration decision recorded yet\n"))
	}))
	defer srv.Close()

	var out, errb bytes.Buffer
	code := cmdArbExplain([]string{"--http-addr", strings.TrimPrefix(srv.URL, "http://")}, &out, &errb)
	if code != exitRuntime {
		t.Errorf("exit = %d, want %d (runtime)", code, exitRuntime)
	}
	if !strings.Contains(out.String(), "no decision recorded yet") {
		t.Errorf("expected friendly 503 message, got: %s", out.String())
	}
}

// TestCmdArbExplain_Unreachable covers the daemon-down path: a refused
// connection reports the target URL and exits runtime, not usage/config.
func TestCmdArbExplain_Unreachable(t *testing.T) {
	var out, errb bytes.Buffer
	// Port 1 is never listening.
	code := cmdArbExplain([]string{"--http-addr", "127.0.0.1:1"}, &out, &errb)
	if code != exitRuntime {
		t.Errorf("exit = %d, want %d", code, exitRuntime)
	}
	if !strings.Contains(errb.String(), "cannot reach daemon") {
		t.Errorf("expected reachability hint, got: %s", errb.String())
	}
}

// TestCmdArbExplain_NoAddress: with neither a flag nor config supplying
// an HTTP address, the command exits 78 (configuration) with guidance.
func TestCmdArbExplain_NoAddress(t *testing.T) {
	var out, errb bytes.Buffer
	// --config pointing at a nonexistent file keeps the four-layer
	// resolution hermetic: no ambient config.yaml can leak an http_addr
	// into this test.
	code := cmdArbExplain([]string{"--config", t.TempDir() + "/absent.yaml"}, &out, &errb)
	if code != exitConfig {
		t.Errorf("exit = %d, want %d (config)", code, exitConfig)
	}
	if !strings.Contains(errb.String(), "no HTTP address configured") {
		t.Errorf("expected guidance about --http-addr, got: %s", errb.String())
	}
}

// TestCmdArb_UsageAndDispatch pins the group dispatcher: bare `arb` and
// unknown subcommands are usage errors; `arb help` prints on stdout.
func TestCmdArb_UsageAndDispatch(t *testing.T) {
	var out, errb bytes.Buffer
	if code := cmdArb(nil, &out, &errb); code != exitUsage {
		t.Errorf("bare arb: exit = %d, want %d", code, exitUsage)
	}
	out.Reset()
	errb.Reset()
	if code := cmdArb([]string{"bogus"}, &out, &errb); code != exitUsage {
		t.Errorf("arb bogus: exit = %d, want %d", code, exitUsage)
	}
	out.Reset()
	if code := cmdArb([]string{helpWord}, &out, &errb); code != exitOK {
		t.Errorf("arb help: exit = %d, want %d", code, exitOK)
	}
	if !strings.Contains(out.String(), "explain") {
		t.Error("arb help should list the explain subcommand")
	}
}

// TestCmdArbExplain_Help: --help exits 0 and prints to stdout (the
// parseSubcommandFlags contract every subcommand shares).
func TestCmdArbExplain_Help(t *testing.T) {
	var out, errb bytes.Buffer
	if code := cmdArbExplain([]string{"--help"}, &out, &errb); code != exitOK {
		t.Errorf("exit = %d, want %d", code, exitOK)
	}
}

// A hostile --http-addr endpoint streaming an unbounded body must not
// exhaust memory — the reader is capped at arbResponseLimit (session 369).
func TestArbExplain_BoundedResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		// Stream well past the 1 MiB cap.
		for i := 0; i < 3; i++ {
			_, _ = w.Write(make([]byte, 1<<20))
		}
	}))
	defer srv.Close()

	var out, errb bytes.Buffer
	code := cmdArbExplain([]string{"--http-addr", strings.TrimPrefix(srv.URL, "http://")}, &out, &errb)
	if code == exitOK {
		t.Errorf("oversized malformed body should fail, got exitOK with output %q", out.String())
	}
}
