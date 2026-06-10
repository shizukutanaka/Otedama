// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package httpserver

import (
	"context"
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
	s := New("127.0.0.1:19801", r)
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
	s := New("127.0.0.1:19802", r)
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
	s := New("127.0.0.1:19803", r)
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
	s := New("127.0.0.1:19804", r)
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

	s := New("127.0.0.1:19805", r)
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
	s := New("127.0.0.1:19806", r)
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
	s := New("127.0.0.1:19807", r)
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

	s := New("127.0.0.1:19808", r)
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
	s := New("invalid-address-no-colon", r)
	ctx := context.Background()
	if err := s.Start(ctx); err == nil {
		t.Error("Start with invalid address should return error")
	}
}

func TestStop_GracefulShutdown(t *testing.T) {
	r := metrics.NewRegistry()
	s := New("127.0.0.1:19809", r)
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
	s := New("127.0.0.1:19810", r)
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
	s := New("127.0.0.1:0", metrics.NewRegistry())
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
	s := New("127.0.0.1:0", metrics.NewRegistry())
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
