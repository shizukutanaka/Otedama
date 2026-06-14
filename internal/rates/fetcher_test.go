// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package rates

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestFetcher_ReturnsZeroAndFallbackBeforeFirstFetch(t *testing.T) {
	f := NewFetcher(95000.0)
	rate, fresh := f.BTCUSDRate()
	if rate != 95000.0 {
		t.Errorf("BTCUSDRate before fetch = %v, want fallback 95000", rate)
	}
	if fresh {
		t.Error("rate should not be fresh before any fetch")
	}
}

func TestFetcher_FetchFromFakeServer(t *testing.T) {
	// Stand up a fake Coinbase-like endpoint.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := json.Marshal(map[string]any{
			"data": map[string]string{"amount": "97500.00"},
		})
		w.Write(body)
	}))
	defer srv.Close()

	f := &Fetcher{
		fallback:   50000,
		httpClient: srv.Client(),
		sources: []Source{{
			Name: "fake",
			URL:  srv.URL,
			extract: func(b []byte) (float64, error) {
				var v struct {
					Data struct {
						Amount string `json:"amount"`
					} `json:"data"`
				}
				if err := json.Unmarshal(b, &v); err != nil {
					return 0, err
				}
				var rate float64
				_, err := parseFloat(v.Data.Amount, &rate)
				return rate, err
			},
		}},
	}

	if err := f.Fetch(context.Background()); err != nil {
		t.Fatalf("Fetch failed: %v", err)
	}
	rate, fresh := f.BTCUSDRate()
	if rate != 97500.0 {
		t.Errorf("rate = %v, want 97500", rate)
	}
	if !fresh {
		t.Error("rate should be fresh after successful fetch")
	}
}

func TestFetcher_UsesMedianAcrossSources(t *testing.T) {
	// Three fake sources returning different rates; median should be selected.
	makeHandler := func(rate string) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprintf(w, `{"rate": %s}`, rate)
		})
	}
	srv1 := httptest.NewServer(makeHandler("90000"))
	srv2 := httptest.NewServer(makeHandler("95000"))
	srv3 := httptest.NewServer(makeHandler("100000"))
	defer srv1.Close()
	defer srv2.Close()
	defer srv3.Close()

	makeSource := func(name, url string) Source {
		return Source{
			Name: name,
			URL:  url,
			extract: func(b []byte) (float64, error) {
				var v struct {
					Rate float64 `json:"rate"`
				}
				if err := json.Unmarshal(b, &v); err != nil {
					return 0, err
				}
				return v.Rate, nil
			},
		}
	}

	f := &Fetcher{
		fallback:   50000,
		httpClient: srv1.Client(),
		sources:    []Source{makeSource("s1", srv1.URL), makeSource("s2", srv2.URL), makeSource("s3", srv3.URL)},
	}

	if err := f.Fetch(context.Background()); err != nil {
		t.Fatalf("Fetch failed: %v", err)
	}
	rate, _ := f.BTCUSDRate()
	// Median of [90000, 95000, 100000] = 95000
	if rate != 95000 {
		t.Errorf("median rate = %v, want 95000", rate)
	}
}

func TestFetcher_MedianOfTwoSourcesAverages(t *testing.T) {
	// With an even number of surviving sources the median must be the
	// average of the two middle values, not the upper one — otherwise the
	// result is biased toward the higher source and loses outlier
	// resistance. This is the common case when one of three sources fails.
	makeHandler := func(rate string) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprintf(w, `{"rate": %s}`, rate)
		})
	}
	srv1 := httptest.NewServer(makeHandler("90000"))
	srv2 := httptest.NewServer(makeHandler("100000"))
	defer srv1.Close()
	defer srv2.Close()

	makeSource := func(name, url string) Source {
		return Source{
			Name: name,
			URL:  url,
			extract: func(b []byte) (float64, error) {
				var v struct {
					Rate float64 `json:"rate"`
				}
				if err := json.Unmarshal(b, &v); err != nil {
					return 0, err
				}
				return v.Rate, nil
			},
		}
	}

	f := &Fetcher{
		fallback:   50000,
		httpClient: srv1.Client(),
		sources:    []Source{makeSource("s1", srv1.URL), makeSource("s2", srv2.URL)},
	}
	if err := f.Fetch(context.Background()); err != nil {
		t.Fatalf("Fetch failed: %v", err)
	}
	rate, _ := f.BTCUSDRate()
	// Median of [90000, 100000] = 95000 (the average), not 100000.
	if rate != 95000 {
		t.Errorf("median of two sources = %v, want 95000 (average)", rate)
	}
}

func TestFetcher_ImplausibleReadingExcludedFromMedian(t *testing.T) {
	// Three sources, one returning a unit-mangled value (price in BTC ≈ 0.95
	// instead of USD). It must be dropped before the median so it cannot pull
	// the result, leaving the median of the two honest sources.
	makeHandler := func(rate string) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprintf(w, `{"rate": %s}`, rate)
		})
	}
	srvA := httptest.NewServer(makeHandler("95000"))
	srvB := httptest.NewServer(makeHandler("95200"))
	srvBad := httptest.NewServer(makeHandler("0.95")) // implausible
	defer srvA.Close()
	defer srvB.Close()
	defer srvBad.Close()

	makeSource := func(name, url string) Source {
		return Source{
			Name: name,
			URL:  url,
			extract: func(b []byte) (float64, error) {
				var v struct {
					Rate float64 `json:"rate"`
				}
				if err := json.Unmarshal(b, &v); err != nil {
					return 0, err
				}
				return v.Rate, nil
			},
		}
	}

	f := &Fetcher{
		fallback:   50000,
		httpClient: srvA.Client(),
		sources: []Source{
			makeSource("a", srvA.URL),
			makeSource("b", srvB.URL),
			makeSource("bad", srvBad.URL),
		},
	}
	if err := f.Fetch(context.Background()); err != nil {
		t.Fatalf("Fetch failed: %v", err)
	}
	rate, _ := f.BTCUSDRate()
	// Median of the two in-band readings [95000, 95200] = 95100; the 0.95
	// reading must have been dropped (a plain median of all three would be 95000).
	if rate != 95100 {
		t.Errorf("rate = %v, want 95100 (implausible 0.95 reading must be excluded)", rate)
	}
}

func TestFetcher_TwoSourcesOneImplausibleKeepsGoodOne(t *testing.T) {
	// The vulnerable two-source case: one honest, one wildly wrong. The band
	// rescues it — without filtering, the average would be dragged halfway.
	makeHandler := func(rate string) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprintf(w, `{"rate": %s}`, rate)
		})
	}
	srvGood := httptest.NewServer(makeHandler("95000"))
	srvBad := httptest.NewServer(makeHandler("950000000")) // ~1e9, out of band
	defer srvGood.Close()
	defer srvBad.Close()

	makeSource := func(name, url string) Source {
		return Source{
			Name: name,
			URL:  url,
			extract: func(b []byte) (float64, error) {
				var v struct {
					Rate float64 `json:"rate"`
				}
				if err := json.Unmarshal(b, &v); err != nil {
					return 0, err
				}
				return v.Rate, nil
			},
		}
	}

	f := &Fetcher{
		fallback:   50000,
		httpClient: srvGood.Client(),
		sources:    []Source{makeSource("good", srvGood.URL), makeSource("bad", srvBad.URL)},
	}
	if err := f.Fetch(context.Background()); err != nil {
		t.Fatalf("Fetch failed: %v", err)
	}
	rate, _ := f.BTCUSDRate()
	if rate != 95000 {
		t.Errorf("rate = %v, want 95000 (out-of-band source must be dropped, not averaged)", rate)
	}
}

func TestFetcher_AllSourcesFailReturnsFallback(t *testing.T) {
	f := &Fetcher{
		fallback:   80000,
		httpClient: &http.Client{Timeout: 100 * time.Millisecond},
		sources: []Source{{
			Name:    "bad",
			URL:     "http://192.0.2.1:9999", // unreachable
			extract: func([]byte) (float64, error) { return 0, nil },
		}},
	}
	err := f.Fetch(context.Background())
	if err == nil {
		t.Error("Fetch with unreachable source should return error")
	}
	// BTCUSDRate must still return fallback.
	rate, fresh := f.BTCUSDRate()
	if rate != 80000 {
		t.Errorf("fallback rate = %v, want 80000", rate)
	}
	if fresh {
		t.Error("rate should not be fresh when all fetches failed")
	}
}

func TestFetcher_RateIsStaleAfterCacheDuration(t *testing.T) {
	f := NewFetcher(50000)
	// Simulate a cached rate that is older than CacheDuration.
	f.mu.Lock()
	f.rate = 95000
	f.fetchedAt = time.Now().Add(-CacheDuration - time.Second)
	f.mu.Unlock()

	rate, fresh := f.BTCUSDRate()
	if rate != 95000 {
		t.Errorf("rate = %v, want cached 95000", rate)
	}
	if fresh {
		t.Error("expired rate should not be fresh")
	}
}

func TestFetcher_StartBackground_LogsInitialFetchError(t *testing.T) {
	// A server that returns 503 causes all sources to fail; the swallowed
	// error must reach the log callback installed via SetLogger.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	logged := make(chan string, 1)
	f := &Fetcher{
		fallback:   50000,
		httpClient: srv.Client(),
		sources: []Source{{
			Name:    "fake-503",
			URL:     srv.URL,
			extract: func([]byte) (float64, error) { return 0, nil },
		}},
	}
	f.SetLogger(func(msg string) {
		select {
		case logged <- msg:
		default:
		}
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	f.StartBackground(ctx, 10*time.Minute) // long interval; only initial fetch matters

	select {
	case msg := <-logged:
		if !strings.Contains(msg, "initial fetch failed") {
			t.Errorf("log message = %q, want to contain 'initial fetch failed'", msg)
		}
	case <-time.After(3 * time.Second):
		t.Error("timeout: SetLogger callback never received error from StartBackground")
	}
}

func TestFetcher_SetLogger_NilIsSilent(t *testing.T) {
	// No logger set — StartBackground must not panic when the fetch fails.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()

	f := &Fetcher{
		fallback:   50000,
		httpClient: srv.Client(),
		sources: []Source{{
			Name:    "boom",
			URL:     srv.URL,
			extract: func([]byte) (float64, error) { return 0, nil },
		}},
	}
	// Intentionally do NOT call SetLogger.
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	f.StartBackground(ctx, 10*time.Minute)
	<-ctx.Done() // let the goroutine run and exit; must not panic
}

func parseFloat(s string, out *float64) (int, error) {
	return fmt.Sscanf(s, "%f", out)
}
