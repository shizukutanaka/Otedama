// Package common provides shared utilities and base implementations
package common

import (
	"context"
	"net"
	"net/http"
	"sync"
	"time"

	"go.uber.org/zap"
)

// ServerBase provides common functionality for all server implementations
type ServerBase struct {
	// Basic server info
	Name    string
	Addr    string
	Logger  *zap.Logger
	
	// Server state
	server   *http.Server
	listener net.Listener
	mu       sync.RWMutex
	running  bool
	
	// Graceful shutdown
	shutdownTimeout time.Duration
}

// NewServerBase creates a new base server instance
func NewServerBase(name, addr string, logger *zap.Logger) *ServerBase {
	return &ServerBase{
		Name:            name,
		Addr:            addr,
		Logger:          logger,
		shutdownTimeout: 30 * time.Second,
	}
}

// IsRunning returns whether the server is running
func (s *ServerBase) IsRunning() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.running
}

// SetRunning sets the running state
func (s *ServerBase) SetRunning(running bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.running = running
}

// Start starts the HTTP server with the provided handler
func (s *ServerBase) Start(handler http.Handler) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	
	if s.running {
		return nil
	}
	
	// Create HTTP server
	s.server = &http.Server{
		Addr:         s.Addr,
		Handler:      handler,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}
	
	// Start listening
	listener, err := net.Listen("tcp", s.Addr)
	if err != nil {
		return err
	}
	s.listener = listener
	
	// Start server in goroutine
	go func() {
		s.Logger.Info("Server starting", 
			zap.String("name", s.Name),
			zap.String("addr", s.Addr))
			
		if err := s.server.Serve(listener); err != nil && err != http.ErrServerClosed {
			s.Logger.Error("Server error", 
				zap.String("name", s.Name),
				zap.Error(err))
		}
	}()
	
	s.running = true
	return nil
}

// Stop gracefully stops the server
func (s *ServerBase) Stop(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	
	if !s.running {
		return nil
	}
	
	s.Logger.Info("Server stopping", zap.String("name", s.Name))
	
	// Create shutdown context with timeout
	shutdownCtx, cancel := context.WithTimeout(ctx, s.shutdownTimeout)
	defer cancel()
	
	// Shutdown server
	if err := s.server.Shutdown(shutdownCtx); err != nil {
		s.Logger.Error("Server shutdown error", 
			zap.String("name", s.Name),
			zap.Error(err))
		return err
	}
	
	s.running = false
	s.Logger.Info("Server stopped", zap.String("name", s.Name))
	return nil
}

// HealthCheck provides a basic health check handler
func (s *ServerBase) HealthCheck() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.IsRunning() {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"status":"healthy"}`))
		} else {
			w.WriteHeader(http.StatusServiceUnavailable)
			w.Write([]byte(`{"status":"unhealthy"}`))
		}
	}
}

// LogMiddleware provides request logging
func (s *ServerBase) LogMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		
		// Wrap response writer to capture status
		wrapped := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}
		
		// Process request
		next.ServeHTTP(wrapped, r)
		
		// Log request
		s.Logger.Info("HTTP request",
			zap.String("method", r.Method),
			zap.String("path", r.URL.Path),
			zap.Int("status", wrapped.statusCode),
			zap.Duration("duration", time.Since(start)),
			zap.String("remote", r.RemoteAddr),
		)
	})
}

// responseWriter wraps http.ResponseWriter to capture status code
type responseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.statusCode = code
	rw.ResponseWriter.WriteHeader(code)
}

// CORSMiddleware provides CORS headers
func (s *ServerBase) CORSMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		
		next.ServeHTTP(w, r)
	})
}

// RecoveryMiddleware recovers from panics
func (s *ServerBase) RecoveryMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if err := recover(); err != nil {
				s.Logger.Error("Panic recovered",
					zap.Any("error", err),
					zap.String("path", r.URL.Path),
				)
				http.Error(w, "Internal server error", http.StatusInternalServerError)
			}
		}()
		
		next.ServeHTTP(w, r)
	})
}