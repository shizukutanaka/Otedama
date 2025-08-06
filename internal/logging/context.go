package logging

import (
	"context"

	"go.uber.org/zap"
)

// contextKey is a private type to prevent collisions with other packages' context keys.
type contextKey string

const (
	// loggerKey is the key used to store the logger in the context.
	loggerKey = contextKey("logger")
)

// ToContext embeds a zap.Logger into the provided context.
// This allows for passing a logger instance through the call stack, enabling
// request-scoped logging with contextual fields.
//
// Example:
//   logger := logging.GetLogger("my-module").With(zap.String("request_id", "123"))
//   ctx = logging.ToContext(ctx, logger)
func ToContext(ctx context.Context, logger *zap.Logger) context.Context {
	return context.WithValue(ctx, loggerKey, logger)
}

// FromContext retrieves a zap.Logger from the context.
// If no logger is found in the context, it returns the global logger.
// This makes it safe to call from any part of the application.
//
// Example:
//   logger := logging.FromContext(ctx)
//   logger.Info("Handling request")
func FromContext(ctx context.Context) *zap.Logger {
	if logger, ok := ctx.Value(loggerKey).(*zap.Logger); ok {
		return logger
	}
	// Fallback to the global logger if none is found in the context.
	return zap.L()
}

/*

NOTE: The following structs and functions (`Context`, `Trace`, `Operation`, etc.)
were part of a more complex logging abstraction.

They are temporarily commented out to favor a simpler approach using zap's built-in
features directly with context. This reduces complexity and adheres to the principle
of implementing only what is necessary right now.

These advanced patterns can be re-evaluated and potentially reintroduced
if the project's needs evolve to require them.

import (
	"fmt"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

// Context provides structured logging context
// Following Rob Pike's principle: "Don't just check errors, handle them gracefully"
type Context struct {
	logger    *zap.Logger
	fields    []zap.Field
	requestID string
}

// NewContext creates a new logging context
func NewContext(logger *zap.Logger) *Context {
	return &Context{
		logger:    logger,
		fields:    []zap.Field{},
		requestID: generateRequestID(),
	}
}

// Operation logs an operation with timing
func Operation(ctx context.Context, name string, fn func() error) error {
	logger := FromContext(ctx)

	start := time.Now()
	logger.Debug("Starting operation", zap.String("operation", name))

	err := fn()

	duration := time.Since(start)
	fields := []zap.Field{
		zap.String("operation", name),
		zap.Duration("duration", duration),
	}

	if err != nil {
		logger.Error("Operation failed", append(fields, zap.Error(err))...)
	} else {
		logger.Debug("Operation completed", fields...)
	}

	return err
}

// ... other commented out code ...

*/
