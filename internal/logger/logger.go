// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package logger provides structured logging for Otedama.
//
// # Why this exists
//
// Until now, Otedama printed plain text like "[info] engine: worker started"
// which is human-readable but not machine-queryable. For a long-running
// mining service, users need to answer questions like:
//
//   - "When was the last share accepted?"
//   - "How often does the pool reconnect?"
//   - "Which device is idle right now?"
//
// Plain text requires grep-and-pray. Structured logs make each question
// a one-line query. This package uses Go 1.22's stdlib log/slog so that
// no external dependency is introduced.
//
// # Output formats
//
//	Text (default, for humans in terminals):
//	  2026-04-24T10:15:30Z [INFO ] engine: worker started dev=cpu-0
//
//	JSON (for machines, --log-format=json):
//	  {"time":"2026-04-24T10:15:30Z","level":"INFO","msg":"engine: worker started","dev":"cpu-0"}
//
// # TUI coexistence
//
// When the TUI dashboard is active, log output is silently dropped to
// stdout (which the TUI controls) to avoid mangling the display.
// Logs still reach a log file if --log-file is set. This gives users
// both a pretty dashboard and an audit trail.
package logger

import (
	"context"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync/atomic"
)

// Format selects the output format of log records.
type Format int

const (
	// FormatText is the human-readable default. Each record is one line
	// with aligned level tags and key=value pairs for attributes.
	FormatText Format = iota

	// FormatJSON emits one JSON object per record, suitable for log
	// aggregation systems like Loki, Elasticsearch, or Datadog.
	FormatJSON
)

// Level filters out records below a threshold. Levels match slog's
// built-in levels: DEBUG (-4), INFO (0), WARN (4), ERROR (8).
type Level = slog.Level

// Predefined levels re-exported so callers need not import slog directly.
const (
	LevelDebug = slog.LevelDebug
	LevelInfo  = slog.LevelInfo
	LevelWarn  = slog.LevelWarn
	LevelError = slog.LevelError
)

// ParseLevel converts a human string to a Level.
// Accepts: "debug", "info", "warn", "warning", "error".
// Unknown values default to LevelInfo.
func ParseLevel(s string) Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return LevelDebug
	case "warn", "warning":
		return LevelWarn
	case "error":
		return LevelError
	default:
		return LevelInfo
	}
}

// Config describes how to construct a Logger.
type Config struct {
	// Level is the minimum level to emit.
	Level Level

	// Format selects text or JSON output.
	Format Format

	// Writer is where log records go. Typically os.Stdout or a file.
	// If nil, os.Stderr is used.
	Writer io.Writer

	// AddSource includes file:line in each record. Useful in development,
	// noisy in production.
	AddSource bool
}

// Logger wraps slog.Logger with Otedama-specific conveniences.
// It is safe for concurrent use.
type Logger struct {
	*slog.Logger
}

// New returns a Logger built from cfg.
func New(cfg Config) *Logger {
	w := cfg.Writer
	if w == nil {
		w = os.Stderr
	}
	opts := &slog.HandlerOptions{
		Level:     cfg.Level,
		AddSource: cfg.AddSource,
	}
	var h slog.Handler
	switch cfg.Format {
	case FormatJSON:
		h = slog.NewJSONHandler(w, opts)
	default:
		h = slog.NewTextHandler(w, opts)
	}
	return &Logger{Logger: slog.New(h)}
}

// Discard returns a Logger that silently drops all records.
// Useful when the TUI owns stdout and log output would corrupt the screen.
func Discard() *Logger {
	return New(Config{
		Level:  LevelError + 1, // higher than any real level
		Writer: io.Discard,
	})
}

// Adapter returns a function compatible with the engine.Options.Logger
// signature (func(level, msg string)). Use this to pass a Logger to
// subsystems that predate structured logging.
func (l *Logger) Adapter() func(level, msg string) {
	return func(level, msg string) {
		switch strings.ToLower(level) {
		case "debug":
			l.Debug(msg)
		case "warn", "warning":
			l.Warn(msg)
		case "error":
			l.Error(msg)
		default:
			l.Info(msg)
		}
	}
}

// ----- Context keys -----

type ctxKey int

const loggerKey ctxKey = 0

// IntoContext returns ctx with l attached. Subsystems can retrieve the
// logger with FromContext so they do not need to plumb it through every
// function signature.
func IntoContext(ctx context.Context, l *Logger) context.Context {
	// Injecting a nil logger is a no-op: a typed-nil stored in the
	// context would satisfy FromContext's type assertion and shadow the
	// default logger with nil. Callers that pass nil get the default.
	if l == nil {
		return ctx
	}
	return context.WithValue(ctx, loggerKey, l)
}

// FromContext extracts a Logger from ctx, or returns a default Logger
// writing to stderr at INFO level if none is attached.
func FromContext(ctx context.Context) *Logger {
	if l, ok := ctx.Value(loggerKey).(*Logger); ok && l != nil {
		return l
	}
	return defaultLogger()
}

// ----- Default logger singleton -----
//
// The default logger is stored in an atomic.Pointer so that
// concurrent reads (FromContext from goroutines) and writes
// (SetDefault from main) are race-free under `go test -race`.

var defaultPtr atomic.Pointer[Logger]

func defaultLogger() *Logger {
	if l := defaultPtr.Load(); l != nil {
		return l
	}
	// Lazily initialise on first call.
	l := New(Config{Level: LevelInfo, Format: FormatText})
	if !defaultPtr.CompareAndSwap(nil, l) {
		// Another goroutine beat us to it; use that one.
		return defaultPtr.Load()
	}
	return l
}

// SetDefault overrides the default logger returned by FromContext when
// no logger is attached to the context. Intended for use in main().
//
// Passing nil is a no-op: it never clobbers the current logger with
// nil, because downstream callers assume the default is always usable.
func SetDefault(l *Logger) {
	if l == nil {
		return
	}
	defaultPtr.Store(l)
}
