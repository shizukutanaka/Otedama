// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package logger

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
)

// ----- ParseLevel -----

func TestParseLevel(t *testing.T) {
	tests := map[string]Level{
		"debug":    LevelDebug,
		"DEBUG":    LevelDebug,
		"info":     LevelInfo,
		"INFO":     LevelInfo,
		"":         LevelInfo,
		"warn":     LevelWarn,
		"warning":  LevelWarn,
		"error":    LevelError,
		"nonsense": LevelInfo, // unknown → info
	}
	for s, want := range tests {
		if got := ParseLevel(s); got != want {
			t.Errorf("ParseLevel(%q) = %v, want %v", s, got, want)
		}
	}
}

// ----- Format: Text -----

func TestLogger_TextFormat(t *testing.T) {
	var buf bytes.Buffer
	l := New(Config{Level: LevelInfo, Format: FormatText, Writer: &buf})
	l.Info("engine started", "dev", "cpu-0")

	out := buf.String()
	if !strings.Contains(out, "engine started") {
		t.Errorf("text output missing message: %q", out)
	}
	if !strings.Contains(out, "dev=cpu-0") {
		t.Errorf("text output missing attribute: %q", out)
	}
	if !strings.Contains(out, "INFO") {
		t.Errorf("text output missing level: %q", out)
	}
}

// ----- Format: JSON -----

func TestLogger_JSONFormat(t *testing.T) {
	var buf bytes.Buffer
	l := New(Config{Level: LevelInfo, Format: FormatJSON, Writer: &buf})
	l.Info("pool connected", "url", "stratum+v2://example:3336", "latency_ms", 15)

	var rec map[string]any
	if err := json.Unmarshal(buf.Bytes(), &rec); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, buf.String())
	}
	if rec["msg"] != "pool connected" {
		t.Errorf("msg field = %v, want %q", rec["msg"], "pool connected")
	}
	if rec["url"] != "stratum+v2://example:3336" {
		t.Errorf("url field = %v", rec["url"])
	}
	if rec["level"] != "INFO" {
		t.Errorf("level field = %v", rec["level"])
	}
}

// ----- Level filtering -----

func TestLogger_LevelFilter(t *testing.T) {
	var buf bytes.Buffer
	l := New(Config{Level: LevelWarn, Format: FormatText, Writer: &buf})

	l.Debug("should be dropped")
	l.Info("should be dropped")
	l.Warn("should appear")
	l.Error("should appear")

	out := buf.String()
	if strings.Contains(out, "should be dropped") {
		t.Errorf("debug/info leaked through WARN filter:\n%s", out)
	}
	if !strings.Contains(out, "should appear") {
		t.Errorf("WARN and ERROR did not appear:\n%s", out)
	}
}

// ----- Discard -----

func TestLogger_Discard(t *testing.T) {
	// Discard must never panic and must drop everything.
	l := Discard()
	l.Debug("x")
	l.Info("y")
	l.Warn("z")
	l.Error("w")
}

// ----- Adapter -----

func TestLogger_Adapter_RoutesByLevel(t *testing.T) {
	var buf bytes.Buffer
	l := New(Config{Level: LevelDebug, Format: FormatText, Writer: &buf})
	adapter := l.Adapter()

	adapter("debug", "dbg-msg")
	adapter("info", "info-msg")
	adapter("warn", "warn-msg")
	adapter("error", "err-msg")
	adapter("INFO", "upper-msg")    // case-insensitive
	adapter("weird", "default-msg") // unknown → info

	out := buf.String()
	for _, want := range []string{
		"dbg-msg", "info-msg", "warn-msg", "err-msg", "upper-msg", "default-msg",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("adapter dropped %q:\n%s", want, out)
		}
	}
	// Level tags applied correctly.
	for _, pair := range []struct{ level, msg string }{
		{"DEBUG", "dbg-msg"},
		{"INFO", "info-msg"},
		{"WARN", "warn-msg"},
		{"ERROR", "err-msg"},
	} {
		for _, line := range strings.Split(out, "\n") {
			if strings.Contains(line, pair.msg) && !strings.Contains(line, pair.level) {
				t.Errorf("line %q missing level %q", line, pair.level)
			}
		}
	}
}

// ----- Context propagation -----

func TestLogger_FromContext_DefaultsWhenMissing(t *testing.T) {
	l := FromContext(context.Background())
	if l == nil {
		t.Fatal("FromContext returned nil")
	}
	// Must not panic.
	l.Info("works")
}

func TestDefaultLoggerSlow_CASLoserReturnsSameInstanceAsWinner(t *testing.T) {
	// Deterministically exercise the CAS-loser branch of defaultLoggerSlow():
	// pre-populate defaultPtr so that defaultLoggerSlow()'s CAS fails and it
	// must fall back to the already-stored value. The goroutine-racing test
	// below cannot reliably hit this branch — when run after other tests the
	// pointer is already populated (fast path), and when run alone the
	// scheduler tends to let the first goroutine win before others reach the
	// nil-check. Extracting the slow path lets us test it without racing.
	winner := New(Config{Level: LevelInfo, Format: FormatText, Writer: new(bytes.Buffer)})
	defaultPtr.Store(winner)
	t.Cleanup(func() { defaultPtr.Store(nil) })

	// defaultLoggerSlow() calls New() then CAS(nil, l), which FAILS because
	// defaultPtr already holds winner, so it must return defaultPtr.Load().
	got := defaultLoggerSlow()
	if got != winner {
		t.Errorf("CAS loser returned %p, want winner %p", got, winner)
	}
}

func TestDefaultLogger_ConcurrentInitNeverReturnsNil(t *testing.T) {
	// Stress-test: many goroutines call defaultLogger() simultaneously after a
	// Store(nil) reset. Every goroutine must receive a non-nil logger. Run with
	// -race to verify the atomic.Pointer guards are correct. (The deterministic
	// CAS-loser assertion lives in the test above.)
	defaultPtr.Store(nil)
	const n = 100
	loggers := make([]*Logger, n)
	startGate := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func() {
			defer wg.Done()
			<-startGate // wait until all goroutines are ready
			loggers[i] = defaultLogger()
		}()
	}
	close(startGate) // release all goroutines simultaneously
	wg.Wait()
	for i, l := range loggers {
		if l == nil {
			t.Errorf("goroutine %d: defaultLogger() returned nil", i)
		}
	}
}

func TestLogger_IntoContext(t *testing.T) {
	var buf bytes.Buffer
	custom := New(Config{Level: LevelDebug, Format: FormatText, Writer: &buf})
	ctx := IntoContext(context.Background(), custom)

	retrieved := FromContext(ctx)
	if retrieved != custom {
		t.Error("FromContext did not return the attached Logger")
	}
	retrieved.Info("roundtrip")
	if !strings.Contains(buf.String(), "roundtrip") {
		t.Errorf("message did not reach writer: %s", buf.String())
	}
}

// ----- With-style attribute reuse -----

func TestLogger_With_AddsAttributesToAllRecords(t *testing.T) {
	var buf bytes.Buffer
	base := New(Config{Level: LevelInfo, Format: FormatJSON, Writer: &buf})
	scoped := base.With("subsystem", "engine", "worker_id", "cpu-0")
	scoped.Info("share found")

	var rec map[string]any
	if err := json.Unmarshal(buf.Bytes(), &rec); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if rec["subsystem"] != "engine" {
		t.Errorf("missing subsystem attr: %v", rec)
	}
	if rec["worker_id"] != "cpu-0" {
		t.Errorf("missing worker_id attr: %v", rec)
	}
}
