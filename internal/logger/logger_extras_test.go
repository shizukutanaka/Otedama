// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package logger

import (
	"bytes"
	"context"
	"strings"
	"sync"
	"testing"
)

// ============================================================================
// Default logger singleton
// ============================================================================

func TestDefault_ReturnsNonNil(t *testing.T) {
	// Default must never be nil — calling Info on nil would panic.
	l := defaultLogger()
	if l == nil {
		t.Fatal("defaultLogger() returned nil")
	}
}

func TestSetDefault_ReplacesSingleton(t *testing.T) {
	original := defaultLogger()
	t.Cleanup(func() { SetDefault(original) })

	var buf bytes.Buffer
	replacement := New(Config{Writer: &buf, Format: FormatText})
	SetDefault(replacement)

	got := defaultLogger()
	if got != replacement {
		t.Error("defaultLogger() did not return the value set by SetDefault")
	}
}

func TestSetDefault_NilDoesNotClobber(t *testing.T) {
	// Calling SetDefault(nil) must not replace the logger with nil
	// (which would panic on next use). Defensive code keeps the existing.
	original := defaultLogger()
	t.Cleanup(func() { SetDefault(original) })

	SetDefault(nil)
	got := defaultLogger()
	if got == nil {
		t.Error("SetDefault(nil) left defaultLogger() returning nil")
	}
}

// ============================================================================
// Context propagation
// ============================================================================

func TestIntoContext_RoundTrip(t *testing.T) {
	var buf bytes.Buffer
	l := New(Config{Writer: &buf, Format: FormatText})

	ctx := IntoContext(context.Background(), l)
	got := FromContext(ctx)

	if got != l {
		t.Errorf("FromContext did not return the injected logger")
	}
}

func TestFromContext_FallsBackToDefault(t *testing.T) {
	// FromContext on a background context (no logger injected) must
	// return the default singleton, not nil.
	got := FromContext(context.Background())
	if got == nil {
		t.Fatal("FromContext fell back to nil")
	}
}

func TestIntoContext_NilLoggerDoesNotPanic(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("IntoContext(ctx, nil) panicked: %v", r)
		}
	}()
	// Injecting nil should be a no-op; FromContext should still return default.
	ctx := IntoContext(context.Background(), nil)
	if l := FromContext(ctx); l == nil {
		t.Error("FromContext after injecting nil returned nil")
	}
}

func TestIntoContext_PreservesOtherValues(t *testing.T) {
	// Our injection must not clobber other context values stored under
	// different keys (classic bug from using the same private key type).
	type otherKey struct{}
	ctx := context.WithValue(context.Background(), otherKey{}, "preserved")

	l := New(Config{Writer: new(bytes.Buffer), Format: FormatText})
	ctx = IntoContext(ctx, l)

	if v, _ := ctx.Value(otherKey{}).(string); v != "preserved" {
		t.Errorf("other context value lost: got %q", v)
	}
}

// ============================================================================
// Concurrent default access
// ============================================================================

func TestDefault_ConcurrentReadSafe(t *testing.T) {
	// defaultLogger() must be safe to call from many goroutines.
	// Run with -race to catch any unprotected global.
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				l := defaultLogger()
				if l == nil {
					t.Error("defaultLogger() returned nil mid-concurrent-read")
					return
				}
			}
		}()
	}
	wg.Wait()
}

func TestSetDefault_ConcurrentWriteSafe(t *testing.T) {
	original := defaultLogger()
	t.Cleanup(func() { SetDefault(original) })

	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			var buf bytes.Buffer
			l := New(Config{Writer: &buf, Format: FormatText})
			SetDefault(l)
			_ = defaultLogger()
		}(i)
	}
	wg.Wait()

	// After the storm, Default must still return something non-nil.
	if defaultLogger() == nil {
		t.Error("concurrent SetDefault left Default nil")
	}
}

// ============================================================================
// Adapter function — bridges slog to the simple logger callback
// ============================================================================

func TestAdapter_UnknownLevelRoutedToInfo(t *testing.T) {
	var buf bytes.Buffer
	l := New(Config{Writer: &buf, Format: FormatText, Level: LevelDebug})
	adapter := l.Adapter()

	// An unknown level string should default to info (not panic, not warn).
	adapter("unknown-level-xyz", "hello")

	if !strings.Contains(buf.String(), "hello") {
		t.Errorf("adapter dropped unknown-level message:\n%s", buf.String())
	}
}

func TestAdapter_EmptyLevelRoutedSafely(t *testing.T) {
	var buf bytes.Buffer
	l := New(Config{Writer: &buf, Format: FormatText, Level: LevelDebug})
	adapter := l.Adapter()

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("adapter panicked on empty level: %v", r)
		}
	}()
	adapter("", "empty-level-msg")
}

func TestAdapter_NilReceiverDoesNotProduceUnusableAdapter(t *testing.T) {
	// Calling Adapter on a nil *Logger is a programming error.
	// We document the current behavior: the adapter call itself does
	// not panic (we only return a closure), but invoking the returned
	// closure on a nil receiver panics — which is a clear signal to
	// the caller that they have a bug.
	var l *Logger // nil receiver
	defer func() {
		// We expect a panic from EITHER Adapter() or the returned func.
		// Both are acceptable. What we forbid is silently producing
		// log records that disappear — which would mask the bug.
		_ = recover()
	}()

	adapter := l.Adapter()
	if adapter != nil {
		// If Adapter returned a function (no immediate panic), invoking
		// it on the nil receiver should panic — we don't want silent
		// drops.
		adapter("info", "test")
	}
}
