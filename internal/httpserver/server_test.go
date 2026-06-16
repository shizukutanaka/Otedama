// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package httpserver

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/metrics"
)

// Tests use fixed loopback ports (and Skip when unavailable) because
// Server stores only the configured address, not the bound listener's.

func TestHealthz_Returns200(t *testing.T) {
	r := metrics.NewRegistry()
	s := New("127.0.0.1:19801", r, false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := s.Start(ctx); err != nil {
		t.Skip("port unavailable:", err)
	}
	defer s.Stop()

	time.Sleep(50 * time.Millisecond) // let listener become ready

	resp, err := http.Get("http://127.0.0.1:19801/healthz")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("healthz status = %d, want 200", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "ok") {
		t.Errorf("healthz body = %q", body)
	}
	// Content-Type should be text.
	ct := resp.Header.Get("Content-Type")
	if !strings.HasPrefix(ct, "text/plain") {
		t.Errorf("Content-Type = %q, want text/plain*", ct)
	}
}

func TestReadyz_503_WhenNotReady(t *testing.T) {
	r := metrics.NewRegistry()
	s := New("127.0.0.1:19802", r, false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := s.Start(ctx); err != nil {
		t.Skip("port unavailable:", err)
	}
	defer s.Stop()
	time.Sleep(50 * time.Millisecond)

	resp, err := http.Get("http://127.0.0.1:19802/readyz")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("readyz (not ready) status = %d, want 503", resp.StatusCode)
	}
}

func TestReadyz_200_WhenReady(t *testing.T) {
	r := metrics.NewRegistry()
	s := New("127.0.0.1:19803", r, false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := s.Start(ctx); err != nil {
		t.Skip("port unavailable:", err)
	}
	defer s.Stop()
	time.Sleep(50 * time.Millisecond)

	s.SetReady(true)

	resp, err := http.Get("http://127.0.0.1:19803/readyz")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("readyz (ready) status = %d, want 200", resp.StatusCode)
	}
}

func TestReadyz_FlipsBackTo503WhenSetFalse(t *testing.T) {
	r := metrics.NewRegistry()
	s := New("127.0.0.1:19804", r, false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := s.Start(ctx); err != nil {
		t.Skip("port unavailable:", err)
	}
	defer s.Stop()
	time.Sleep(50 * time.Millisecond)

	s.SetReady(true)
	s.SetReady(false)

	resp, err := http.Get("http://127.0.0.1:19804/readyz")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("readyz after toggling = %d, want 503", resp.StatusCode)
	}
}

func TestMetrics_ServesPrometheusFormat(t *testing.T) {
	r := metrics.NewRegistry()
	r.NewCounter("test_total", "help", nil).Add(5)

	s := New("127.0.0.1:19805", r, false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := s.Start(ctx); err != nil {
		t.Skip("port unavailable:", err)
	}
	defer s.Stop()
	time.Sleep(50 * time.Millisecond)

	resp, err := http.Get("http://127.0.0.1:19805/metrics")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("metrics status = %d, want 200", resp.StatusCode)
	}
	ct := resp.Header.Get("Content-Type")
	if !strings.Contains(ct, "version=0.0.4") {
		t.Errorf("Content-Type missing Prometheus version: %q", ct)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "test_total 5") {
		t.Errorf("metrics body missing counter value:\n%s", body)
	}
}

func TestIndex_Returns200WithHTML(t *testing.T) {
	r := metrics.NewRegistry()
	s := New("127.0.0.1:19806", r, false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := s.Start(ctx); err != nil {
		t.Skip("port unavailable:", err)
	}
	defer s.Stop()
	time.Sleep(50 * time.Millisecond)

	resp, err := http.Get("http://127.0.0.1:19806/")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("index status = %d, want 200", resp.StatusCode)
	}
	ct := resp.Header.Get("Content-Type")
	if !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type = %q, want text/html*", ct)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "/metrics") {
		t.Errorf("index should link to /metrics:\n%s", body)
	}
}

func TestUnknownPath_Returns404(t *testing.T) {
	r := metrics.NewRegistry()
	s := New("127.0.0.1:19807", r, false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := s.Start(ctx); err != nil {
		t.Skip("port unavailable:", err)
	}
	defer s.Stop()
	time.Sleep(50 * time.Millisecond)

	resp, err := http.Get("http://127.0.0.1:19807/nonexistent")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("unknown path status = %d, want 404", resp.StatusCode)
	}
}

func TestConcurrentRequests_NoRace(t *testing.T) {
	r := metrics.NewRegistry()
	counter := r.NewCounter("hits_total", "help", nil)

	s := New("127.0.0.1:19808", r, false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := s.Start(ctx); err != nil {
		t.Skip("port unavailable:", err)
	}
	defer s.Stop()
	time.Sleep(50 * time.Millisecond)

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 10; j++ {
				counter.Inc()
				resp, err := http.Get("http://127.0.0.1:19808/metrics")
				if err != nil {
					return
				}
				_, _ = io.Copy(io.Discard, resp.Body)
				resp.Body.Close()
			}
		}()
	}
	wg.Wait()
	// Run with -race to catch concurrent map access in the registry.
}

func TestStart_InvalidAddressReturnsError(t *testing.T) {
	r := metrics.NewRegistry()
	s := New("invalid-address-no-colon", r, false)
	ctx := context.Background()
	if err := s.Start(ctx); err == nil {
		t.Error("Start with invalid address should return error")
	}
}

func TestStop_GracefulShutdown(t *testing.T) {
	r := metrics.NewRegistry()
	s := New("127.0.0.1:19809", r, false)
	ctx := context.Background()
	if err := s.Start(ctx); err != nil {
		t.Skip("port unavailable:", err)
	}
	time.Sleep(50 * time.Millisecond)

	// Stop should return nil on clean shutdown.
	if err := s.Stop(); err != nil {
		t.Errorf("Stop returned: %v", err)
	}
}

func TestContextCancellation_TriggersShutdown(t *testing.T) {
	r := metrics.NewRegistry()
	s := New("127.0.0.1:19810", r, false)
	ctx, cancel := context.WithCancel(context.Background())
	if err := s.Start(ctx); err != nil {
		t.Skip("port unavailable:", err)
	}
	time.Sleep(50 * time.Millisecond)

	cancel()
	// Give the goroutine a moment to shut down.
	time.Sleep(200 * time.Millisecond)

	// After shutdown, new requests should fail.
	_, err := http.Get("http://127.0.0.1:19810/healthz")
	if err == nil {
		t.Error("server still accepting connections after ctx cancel")
	}
}

func TestServeError_NilWhenHealthy(t *testing.T) {
	s := New("127.0.0.1:0", metrics.NewRegistry(), false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if err := s.Start(ctx); err != nil {
		t.Skip("port unavailable:", err)
	}
	defer s.Stop()
	time.Sleep(50 * time.Millisecond)

	// A healthy, running server has no serve error.
	if err := s.ServeError(); err != nil {
		t.Errorf("ServeError on healthy server = %v, want nil", err)
	}
}

func TestServeError_NilAfterCleanStop(t *testing.T) {
	s := New("127.0.0.1:0", metrics.NewRegistry(), false)
	ctx := context.Background()

	if err := s.Start(ctx); err != nil {
		t.Skip("port unavailable:", err)
	}
	time.Sleep(50 * time.Millisecond)
	s.Stop()
	time.Sleep(50 * time.Millisecond)

	// A clean Stop (ErrServerClosed) must NOT be recorded as a serve error.
	if err := s.ServeError(); err != nil {
		t.Errorf("ServeError after clean Stop = %v, want nil", err)
	}
}

func TestAddr_ReturnsBindAddress(t *testing.T) {
	s := New("127.0.0.1:0", metrics.NewRegistry(), false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := s.Start(ctx); err != nil {
		t.Skip("port unavailable:", err)
	}
	defer s.Stop()
	addr := s.Addr()
	if addr == "" {
		t.Error("Addr() returned empty string after successful Start")
	}
}

func TestMetrics_NilRegistry_Returns500(t *testing.T) {
	// New accepts a nil registry; accessing /metrics should return 500.
	s := New("127.0.0.1:0", nil, false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := s.Start(ctx); err != nil {
		t.Skip("port unavailable:", err)
	}
	defer s.Stop()
	time.Sleep(20 * time.Millisecond)

	resp, err := http.Get("http://" + s.Addr() + "/metrics")
	if err != nil {
		t.Fatalf("GET /metrics: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusInternalServerError {
		t.Errorf("/metrics with nil registry = %d, want 500", resp.StatusCode)
	}
}

func TestPprof_DisabledByDefault(t *testing.T) {
	s := New("127.0.0.1:0", metrics.NewRegistry(), false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := s.Start(ctx); err != nil {
		t.Skip("port unavailable:", err)
	}
	defer s.Stop()
	time.Sleep(20 * time.Millisecond)

	resp, err := http.Get("http://" + s.Addr() + "/debug/pprof/")
	if err != nil {
		t.Fatalf("GET /debug/pprof/: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("/debug/pprof/ when pprof disabled = %d, want 404", resp.StatusCode)
	}
}

func TestPprof_EnabledServesIndex(t *testing.T) {
	s := New("127.0.0.1:0", metrics.NewRegistry(), true)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := s.Start(ctx); err != nil {
		t.Skip("port unavailable:", err)
	}
	defer s.Stop()
	time.Sleep(20 * time.Millisecond)

	resp, err := http.Get("http://" + s.Addr() + "/debug/pprof/")
	if err != nil {
		t.Fatalf("GET /debug/pprof/: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("/debug/pprof/ when pprof enabled = %d, want 200", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "goroutine") {
		t.Errorf("/debug/pprof/ missing goroutine profile link:\n%s", body)
	}
}

func TestPprof_NamedProfilesAccessible(t *testing.T) {
	s := New("127.0.0.1:0", metrics.NewRegistry(), true)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := s.Start(ctx); err != nil {
		t.Skip("port unavailable:", err)
	}
	defer s.Stop()
	time.Sleep(20 * time.Millisecond)

	for _, profile := range []string{"heap", "goroutine", "allocs"} {
		resp, err := http.Get("http://" + s.Addr() + "/debug/pprof/" + profile)
		if err != nil {
			t.Fatalf("GET /debug/pprof/%s: %v", profile, err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Errorf("/debug/pprof/%s = %d, want 200", profile, resp.StatusCode)
		}
	}
}

// ============================================================================
// session 169 — cover Addr() fallback and ServeError() non-nil path
// ============================================================================

func TestAddr_BeforeStart_ReturnsConfiguredAddress(t *testing.T) {
	// Addr() returns the configured address string when Start has not been
	// called yet (boundAddr is nil). This covers server.go:152.
	const addr = "127.0.0.1:12399"
	s := New(addr, metrics.NewRegistry(), false)
	if got := s.Addr(); got != addr {
		t.Errorf("Addr() before Start = %q, want %q", got, addr)
	}
}

func TestServeError_ReturnsStoredError(t *testing.T) {
	// ServeError() returns the error stored by the Serve goroutine when
	// it terminates with a non-ErrServerClosed error. We inject the error
	// directly (white-box) to cover server.go:160-162 without needing to
	// race the background goroutine.
	s := New("127.0.0.1:0", metrics.NewRegistry(), false)
	injected := errors.New("injected serve error")
	s.serveErr.Store(&injected)
	got := s.ServeError()
	if got == nil {
		t.Fatal("ServeError() returned nil, want stored error")
	}
	if got.Error() != "injected serve error" {
		t.Errorf("ServeError() = %q, want 'injected serve error'", got.Error())
	}
}
