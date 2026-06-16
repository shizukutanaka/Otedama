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
	"sync"
	"sync/atomic"
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

func TestFetcher_ClockSkewSeconds_ZeroBeforeAnyFetch(t *testing.T) {
	f := NewFetcher(95000)
	if skew := f.ClockSkewSeconds(); skew != 0 {
		t.Errorf("ClockSkewSeconds before any fetch = %v, want 0", skew)
	}
}

func TestFetcher_ClockSkewSeconds_DetectsAccurateDate(t *testing.T) {
	// Server returns a Date header matching "now". Skew must be < 2 s even
	// accounting for test execution time.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Date", time.Now().UTC().Format(http.TimeFormat))
		fmt.Fprintf(w, `{"rate": 95000}`)
	}))
	defer srv.Close()

	f := &Fetcher{
		fallback:   50000,
		httpClient: srv.Client(),
		sources: []Source{{
			Name: "accurate-date",
			URL:  srv.URL,
			extract: func(b []byte) (float64, error) {
				var v struct {
					Rate float64 `json:"rate"`
				}
				if err := json.Unmarshal(b, &v); err != nil {
					return 0, err
				}
				return v.Rate, nil
			},
		}},
	}
	if err := f.Fetch(context.Background()); err != nil {
		t.Fatalf("Fetch failed: %v", err)
	}
	if skew := f.ClockSkewSeconds(); skew >= 2 {
		t.Errorf("ClockSkewSeconds = %.2f, want < 2 for an accurate server Date header", skew)
	}
}

func TestFetcher_ClockSkewSeconds_DetectsLargeSkew(t *testing.T) {
	// Server returns a Date header 300 s in the past.  Observed skew must be
	// roughly 300 s (allow ±5 s for test-execution jitter).
	const fakeOffsetSecs = 300
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		past := time.Now().Add(-fakeOffsetSecs * time.Second).UTC()
		w.Header().Set("Date", past.Format(http.TimeFormat))
		fmt.Fprintf(w, `{"rate": 95000}`)
	}))
	defer srv.Close()

	f := &Fetcher{
		fallback:   50000,
		httpClient: srv.Client(),
		sources: []Source{{
			Name: "stale-date",
			URL:  srv.URL,
			extract: func(b []byte) (float64, error) {
				var v struct {
					Rate float64 `json:"rate"`
				}
				if err := json.Unmarshal(b, &v); err != nil {
					return 0, err
				}
				return v.Rate, nil
			},
		}},
	}
	if err := f.Fetch(context.Background()); err != nil {
		t.Fatalf("Fetch failed: %v", err)
	}
	skew := f.ClockSkewSeconds()
	if skew < fakeOffsetSecs-5 || skew > fakeOffsetSecs+5 {
		t.Errorf("ClockSkewSeconds = %.2f, want ~%d (±5 s jitter)", skew, fakeOffsetSecs)
	}
}

// stripDateTransport wraps an http.RoundTripper and removes the Date header
// from every response, simulating an HTTP server that omits the Date header
// (or a proxy that strips it). Used to test the "no skew observation" path.
type stripDateTransport struct{ inner http.RoundTripper }

func (t *stripDateTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := t.inner.RoundTrip(req)
	if resp != nil {
		resp.Header.Del("Date")
	}
	return resp, err
}

func TestFetcher_ClockSkewSeconds_MissingDateHeaderYieldsZero(t *testing.T) {
	// Simulate a server whose Date header is stripped in transit.
	// ClockSkewSeconds must remain 0 — no observation, not a spurious value.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `{"rate": 95000}`)
	}))
	defer srv.Close()

	inner := srv.Client().Transport
	if inner == nil {
		inner = http.DefaultTransport
	}
	stripped := &http.Client{Transport: &stripDateTransport{inner: inner}}

	f := &Fetcher{
		fallback:   50000,
		httpClient: stripped,
		sources: []Source{{
			Name: "no-date",
			URL:  srv.URL,
			extract: func(b []byte) (float64, error) {
				var v struct {
					Rate float64 `json:"rate"`
				}
				if err := json.Unmarshal(b, &v); err != nil {
					return 0, err
				}
				return v.Rate, nil
			},
		}},
	}
	if err := f.Fetch(context.Background()); err != nil {
		t.Fatalf("Fetch failed: %v", err)
	}
	if skew := f.ClockSkewSeconds(); skew != 0 {
		t.Errorf("ClockSkewSeconds with stripped Date header = %v, want 0", skew)
	}
}

func TestFetcher_ClockSkewSeconds_WarnLoggedWhenThresholdExceeded(t *testing.T) {
	// Server returns a Date header far in the future (well beyond
	// clockSkewWarnThreshold). The logger callback must receive a warning.
	const bigOffset = 300
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		future := time.Now().Add(bigOffset * time.Second).UTC()
		w.Header().Set("Date", future.Format(http.TimeFormat))
		fmt.Fprintf(w, `{"rate": 95000}`)
	}))
	defer srv.Close()

	warned := make(chan string, 1)
	f := &Fetcher{
		fallback:   50000,
		httpClient: srv.Client(),
		sources: []Source{{
			Name: "big-skew",
			URL:  srv.URL,
			extract: func(b []byte) (float64, error) {
				var v struct {
					Rate float64 `json:"rate"`
				}
				if err := json.Unmarshal(b, &v); err != nil {
					return 0, err
				}
				return v.Rate, nil
			},
		}},
	}
	f.SetLogger(func(msg string) {
		select {
		case warned <- msg:
		default:
		}
	})
	if err := f.Fetch(context.Background()); err != nil {
		t.Fatalf("Fetch failed: %v", err)
	}
	select {
	case msg := <-warned:
		if !strings.Contains(msg, "WARNING") || !strings.Contains(msg, "clock") {
			t.Errorf("expected clock-skew WARNING in log, got: %q", msg)
		}
	default:
		t.Error("expected a clock-skew warning log; none received")
	}
}

func TestFetcher_RateAge_FalseBeforeAnyFetch(t *testing.T) {
	f := NewFetcher(95000)
	age, ever := f.RateAge()
	if ever {
		t.Error("RateAge everFetched should be false before any fetch")
	}
	if age != 0 {
		t.Errorf("RateAge age before fetch = %v, want 0", age)
	}
}

func TestFetcher_RateAge_RisesAfterFetch(t *testing.T) {
	f := NewFetcher(95000)
	// Simulate a successful fetch 90 seconds ago.
	f.mu.Lock()
	f.rate = 95000
	f.fetchedAt = time.Now().Add(-90 * time.Second)
	f.mu.Unlock()

	age, ever := f.RateAge()
	if !ever {
		t.Fatal("RateAge everFetched should be true after a fetch")
	}
	if age < 89*time.Second || age > 92*time.Second {
		t.Errorf("RateAge = %v, want ~90s", age)
	}
}

func TestFetcher_RateAge_SmallAfterRealFetch(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `{"rate": 95000}`)
	}))
	defer srv.Close()

	f := &Fetcher{
		fallback:   50000,
		httpClient: srv.Client(),
		sources: []Source{{
			Name: "s",
			URL:  srv.URL,
			extract: func(b []byte) (float64, error) {
				var v struct {
					Rate float64 `json:"rate"`
				}
				if err := json.Unmarshal(b, &v); err != nil {
					return 0, err
				}
				return v.Rate, nil
			},
		}},
	}
	if err := f.Fetch(context.Background()); err != nil {
		t.Fatalf("Fetch failed: %v", err)
	}
	age, ever := f.RateAge()
	if !ever {
		t.Fatal("RateAge everFetched should be true after Fetch")
	}
	if age > 5*time.Second {
		t.Errorf("RateAge right after fetch = %v, want < 5s", age)
	}
}

func TestFetcher_SourceHealth_FalseBeforeAnyFetch(t *testing.T) {
	f := NewFetcher(95000)
	ok, total, fetched := f.SourceHealth()
	if fetched {
		t.Error("SourceHealth fetched should be false before any fetch")
	}
	if ok != 0 {
		t.Errorf("ok before fetch = %d, want 0", ok)
	}
	if total != len(defaultSources) {
		t.Errorf("total = %d, want %d (configured sources)", total, len(defaultSources))
	}
}

func TestFetcher_SourceHealth_CountsInBandSources(t *testing.T) {
	// Three sources: two return good readings, one returns an implausible value
	// that is dropped by the band. ok must be 2, total 3 — the redundancy is
	// degraded even though the fetch succeeds.
	makeHandler := func(rate string) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprintf(w, `{"rate": %s}`, rate)
		})
	}
	srvA := httptest.NewServer(makeHandler("95000"))
	srvB := httptest.NewServer(makeHandler("95200"))
	srvBad := httptest.NewServer(makeHandler("0.95")) // out of band
	defer srvA.Close()
	defer srvB.Close()
	defer srvBad.Close()

	mk := func(name, url string) Source {
		return Source{Name: name, URL: url, extract: func(b []byte) (float64, error) {
			var v struct {
				Rate float64 `json:"rate"`
			}
			if err := json.Unmarshal(b, &v); err != nil {
				return 0, err
			}
			return v.Rate, nil
		}}
	}
	f := &Fetcher{
		fallback:   50000,
		httpClient: srvA.Client(),
		sources:    []Source{mk("a", srvA.URL), mk("b", srvB.URL), mk("bad", srvBad.URL)},
	}
	if err := f.Fetch(context.Background()); err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	ok, total, fetched := f.SourceHealth()
	if !fetched {
		t.Fatal("fetched should be true after Fetch")
	}
	if ok != 2 {
		t.Errorf("ok = %d, want 2 (implausible source dropped)", ok)
	}
	if total != 3 {
		t.Errorf("total = %d, want 3", total)
	}
}

func TestFetcher_SourceHealth_ZeroOKButFetchedWhenAllFail(t *testing.T) {
	// All sources fail: fetched becomes true, ok is 0. This distinguishes
	// "feed has collapsed" (fetched=true, ok=0) from "never fetched" (fetched=false).
	f := &Fetcher{
		fallback:   80000,
		httpClient: &http.Client{Timeout: 100 * time.Millisecond},
		sources: []Source{{
			Name:    "bad",
			URL:     "http://192.0.2.1:9999", // unreachable (TEST-NET-1)
			extract: func([]byte) (float64, error) { return 0, nil },
		}},
	}
	if err := f.Fetch(context.Background()); err == nil {
		t.Error("Fetch with unreachable source should return error")
	}
	ok, total, fetched := f.SourceHealth()
	if !fetched {
		t.Error("fetched should be true even when all sources fail")
	}
	if ok != 0 {
		t.Errorf("ok = %d, want 0 (all failed)", ok)
	}
	if total != 1 {
		t.Errorf("total = %d, want 1", total)
	}
}

// TestFetcher_Fetch_CoalescesConcurrentCalls verifies the single-flight
// contract: while one fetch is in progress, concurrent callers share its
// result instead of each issuing their own HTTP requests. Without coalescing,
// N concurrent Fetch calls would produce N hits per source — the failure mode
// that risks an HTTP 429 ban from rate-limited price APIs.
func TestFetcher_Fetch_CoalescesConcurrentCalls(t *testing.T) {
	var hits int32
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		<-release // block so all callers pile up on the one in-flight fetch
		fmt.Fprintf(w, `{"rate": 95000}`)
	}))
	defer srv.Close()

	f := &Fetcher{
		fallback:   50000,
		httpClient: srv.Client(),
		sources: []Source{{
			Name: "s",
			URL:  srv.URL,
			extract: func(b []byte) (float64, error) {
				var v struct {
					Rate float64 `json:"rate"`
				}
				if err := json.Unmarshal(b, &v); err != nil {
					return 0, err
				}
				return v.Rate, nil
			},
		}},
	}

	const callers = 8
	var wg sync.WaitGroup
	errs := make([]error, callers)
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			errs[idx] = f.Fetch(context.Background())
		}(i)
	}

	// Give the goroutines time to all enter Fetch and coalesce onto one leader,
	// then release the single in-flight HTTP request.
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Errorf("caller %d: Fetch returned error: %v", i, err)
		}
	}
	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Errorf("server saw %d requests, want 1 (concurrent fetches must coalesce)", got)
	}
	if rate, _ := f.BTCUSDRate(); rate != 95000 {
		t.Errorf("rate = %v, want 95000", rate)
	}
}

// TestFetcher_Fetch_CoalescedCallerHonorsOwnContext verifies that a caller
// which coalesces onto an in-flight fetch is released when its own context is
// cancelled, rather than being pinned to the leader's lifetime.
func TestFetcher_Fetch_CoalescedCallerHonorsOwnContext(t *testing.T) {
	// The leader's request takes ~200ms; a fixed delay (rather than an
	// indefinite block) keeps the server's in-flight request bounded so the
	// deferred srv.Close() cannot deadlock.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
		fmt.Fprintf(w, `{"rate": 95000}`)
	}))
	defer srv.Close()

	f := &Fetcher{
		fallback:   50000,
		httpClient: srv.Client(),
		sources: []Source{{
			Name:    "s",
			URL:     srv.URL,
			extract: func(b []byte) (float64, error) { return 95000, nil },
		}},
	}

	// Leader starts a fetch that will block on the server for ~200ms.
	leaderDone := make(chan struct{})
	go func() {
		_ = f.Fetch(context.Background())
		close(leaderDone)
	}()
	time.Sleep(50 * time.Millisecond) // let the leader claim the in-flight slot

	// A second caller with a short-deadline context must not block for the
	// leader's full duration; it should return its own context error promptly.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	start := time.Now()
	err := f.Fetch(ctx)
	if err == nil {
		t.Fatal("coalesced caller with cancelled context should return an error")
	}
	if elapsed := time.Since(start); elapsed > 150*time.Millisecond {
		t.Errorf("coalesced caller blocked %v, expected prompt (~30ms) context cancellation", elapsed)
	}

	<-leaderDone // let the leader finish before the deferred srv.Close()
}

func parseFloat(s string, out *float64) (int, error) {
	return fmt.Sscanf(s, "%f", out)
}
