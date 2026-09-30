// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package httpserver exposes Otedama's health and metrics HTTP endpoints.
//
// # Endpoints
//
//	GET /healthz     Liveness probe. Returns 200 OK with "ok" body as long
//	                 as the server goroutine is alive. Used by container
//	                 orchestrators (Kubernetes, systemd) to restart on hang.
//
//	GET /readyz      Readiness probe. Returns 200 OK once the engine has
//	                 an established pool session (SetupConnection/
//	                 OpenMiningChannel completed, or V1's equivalent
//	                 handshake) — not merely a started process, but also
//	                 not gated on a job having been received or a hash
//	                 actually produced yet. Returns 503 otherwise. See
//	                 engine.Run's OnReady wiring (internal/engine/run.go).
//
//	GET /metrics     Prometheus text exposition format. Scrape this with
//	                 Prometheus / Grafana Agent / OTel Collector to get
//	                 hashrate, shares, pool latency, arbitration switches,
//	                 and BTC/USD rate over time.
//
// # Security
//
// The server binds to the configured address. For most users, 127.0.0.1
// is appropriate — no incoming firewall changes needed, and the metrics
// are not authenticated. For multi-host setups, bind to a private IP
// and place behind a reverse proxy that adds authentication.
//
// There is no built-in auth because any auth we ship would be worse than
// delegating to a proper ingress (nginx, Caddy, Tailscale serve).
package httpserver

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"

	// pprof registers its handlers via its init(); we do NOT blank-import it
	// because that would register on http.DefaultServeMux. Instead we call
	// the pprof handler functions explicitly so they land on our custom mux.
	// The import is here to make the usage visible to linters.
	"net/http/pprof" //nolint:gosec
	"sync/atomic"
	"time"

	"github.com/shizukutanaka/Otedama/internal/metrics"
)

// Server serves health and metrics endpoints.
type Server struct {
	addr     string
	registry *metrics.Registry

	// ready is 1 when the engine is fully started and hashing.
	// Atomic so it is safe to update from the engine goroutine.
	ready atomic.Bool

	httpSrv *http.Server

	// boundAddr is the actual address the listener bound to, set in Start.
	// Differs from addr when port 0 was requested.
	boundAddr atomic.Pointer[string]

	// serveErr holds the error returned by the background Serve
	// goroutine, if any (other than the expected ErrServerClosed).
	// Readable via ServeError() for observability.
	serveErr atomic.Pointer[error]
}

// New creates an HTTP server that exposes metrics from the given registry.
// The server is not started until Start is called.
//
// If enablePprof is true the standard Go pprof profiling endpoints are
// mounted at /debug/pprof/. Only enable this on localhost or a private
// network: pprof exposes goroutine stacks, heap contents, and CPU profiles
// — do not expose it publicly without authentication.
func New(addr string, registry *metrics.Registry, enablePprof bool) *Server {
	s := &Server{
		addr:     addr,
		registry: registry,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealthz)
	mux.HandleFunc("/readyz", s.handleReadyz)
	mux.HandleFunc("/metrics", s.handleMetrics)
	if enablePprof {
		registerPprofHandlers(mux)
	}
	mux.HandleFunc("/", s.handleIndex)

	s.httpSrv = &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second, // slowloris mitigation
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	return s
}

// Start begins listening. Returns an error if the listener cannot bind.
// The server runs in a background goroutine; Stop terminates it cleanly.
func (s *Server) Start(ctx context.Context) error {
	ln, err := net.Listen("tcp", s.addr)
	if err != nil {
		return fmt.Errorf("httpserver: listen on %s: %w", s.addr, err)
	}
	bound := ln.Addr().String()
	s.boundAddr.Store(&bound)

	// Serve in background.
	go func() {
		if err := s.httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			// Record for observability: callers cannot receive an
			// error from a background goroutine directly, but they can
			// poll ServeError() (e.g. in a health check).
			s.serveErr.Store(&err)
		}
	}()

	// Shutdown on context cancellation.
	go func() {
		<-ctx.Done()
		_ = s.Stop()
	}()
	return nil
}

// Stop shuts down the server, giving in-flight requests up to 5 seconds
// to complete.
func (s *Server) Stop() error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return s.httpSrv.Shutdown(ctx)
}

// SetReady marks the server as ready. Called by the engine after pool
// connection succeeds and workers start producing hashes.
func (s *Server) SetReady(ready bool) {
	s.ready.Store(ready)
}

// Addr returns the actual bind address (useful when port 0 was requested
// and the OS chose an ephemeral port). Returns the configured address
// before Start is called.
func (s *Server) Addr() string {
	if p := s.boundAddr.Load(); p != nil {
		return *p
	}
	return s.addr
}

// ServeError returns the error from the background Serve goroutine, if
// the server terminated unexpectedly (i.e. not via Stop). Returns nil
// if the server is running normally or was shut down cleanly. Useful in
// a supervisor or health check to detect a crashed HTTP server.
func (s *Server) ServeError() error {
	if p := s.serveErr.Load(); p != nil {
		return *p
	}
	return nil
}

// ----- Handlers -----

func (s *Server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, "ok\n")
}

func (s *Server) handleReadyz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	if s.ready.Load() {
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ready\n")
		return
	}
	w.WriteHeader(http.StatusServiceUnavailable)
	_, _ = io.WriteString(w, "not ready\n")
}

func (s *Server) handleMetrics(w http.ResponseWriter, _ *http.Request) {
	if s.registry == nil {
		http.Error(w, "metrics registry not configured", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_ = s.registry.WriteText(w)
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = io.WriteString(w, indexHTML)
}

// registerPprofHandlers mounts the stdlib pprof profiling endpoints on mux.
// It must only be called when the caller has verified that the server is
// not internet-facing: pprof can leak sensitive runtime data.
func registerPprofHandlers(mux *http.ServeMux) {
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	// Named profiles: heap, goroutine, allocs, block, mutex, threadcreate.
	for _, name := range []string{"heap", "goroutine", "allocs", "block", "mutex", "threadcreate"} {
		mux.Handle("/debug/pprof/"+name, pprof.Handler(name))
	}
}

// indexHTML is a minimal landing page listing available endpoints.
const indexHTML = `<!DOCTYPE html>
<html>
<head><title>Otedama</title></head>
<body>
<h1>Otedama</h1>
<p>Non-custodial compute arbitration — HTTP management interface.</p>
<ul>
<li><a href="/metrics">/metrics</a> — Prometheus scrape endpoint</li>
<li><a href="/healthz">/healthz</a> — liveness probe</li>
<li><a href="/readyz">/readyz</a> — readiness probe</li>
</ul>
</body>
</html>
`
