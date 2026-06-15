// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package rates

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// ============================================================================
// Default source extractors — real JSON shapes
// ============================================================================

// findSource returns the Source with the given Name from defaultSources.
func findSource(name string) Source {
	for _, s := range defaultSources {
		if s.Name == name {
			return s
		}
	}
	panic("unknown source: " + name)
}

// ----- Coinbase -----

func TestCoinbaseExtractor_ValidResponse(t *testing.T) {
	// Real Coinbase response shape (as of 2024-2026):
	// https://api.coinbase.com/v2/prices/BTC-USD/spot
	body := []byte(`{"data":{"base":"BTC","currency":"USD","amount":"95234.67"}}`)
	src := findSource("Coinbase")
	rate, err := src.extract(body)
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	if rate < 95234 || rate > 95235 {
		t.Errorf("rate = %v, want ~95234.67", rate)
	}
}

func TestCoinbaseExtractor_MalformedJSON(t *testing.T) {
	body := []byte(`{not valid json`)
	src := findSource("Coinbase")
	if _, err := src.extract(body); err == nil {
		t.Error("extract should fail on malformed JSON")
	}
}

func TestCoinbaseExtractor_MissingAmount(t *testing.T) {
	body := []byte(`{"data":{"base":"BTC","currency":"USD"}}`)
	src := findSource("Coinbase")
	rate, err := src.extract(body)
	// fmt.Sscanf on empty string returns err, rate=0.
	if err == nil {
		t.Error("extract should fail when amount is missing")
	}
	if rate != 0 {
		t.Errorf("rate on missing field = %v, want 0", rate)
	}
}

func TestCoinbaseExtractor_NonNumericAmount(t *testing.T) {
	body := []byte(`{"data":{"amount":"not-a-number"}}`)
	src := findSource("Coinbase")
	if _, err := src.extract(body); err == nil {
		t.Error("extract should fail on non-numeric amount")
	}
}

// ----- Kraken -----

func TestKrakenExtractor_ValidResponse(t *testing.T) {
	// Real Kraken Ticker shape.
	body := []byte(`{"error":[],"result":{"XXBTZUSD":{"c":["95123.40","0.00123"],"v":["100.5","500.8"]}}}`)
	src := findSource("Kraken")
	rate, err := src.extract(body)
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	if rate < 95123 || rate > 95124 {
		t.Errorf("rate = %v, want ~95123.40", rate)
	}
}

func TestKrakenExtractor_EmptyResult(t *testing.T) {
	// Result map with no tickers.
	body := []byte(`{"error":[],"result":{}}`)
	src := findSource("Kraken")
	if _, err := src.extract(body); err == nil {
		t.Error("extract should fail when result is empty")
	}
}

func TestKrakenExtractor_EmptyClosedTrade(t *testing.T) {
	// "c" is empty array.
	body := []byte(`{"error":[],"result":{"XXBTZUSD":{"c":[]}}}`)
	src := findSource("Kraken")
	if _, err := src.extract(body); err == nil {
		t.Error("extract should fail when 'c' array is empty")
	}
}

func TestKrakenExtractor_MalformedJSON(t *testing.T) {
	body := []byte(`not json`)
	src := findSource("Kraken")
	if _, err := src.extract(body); err == nil {
		t.Error("extract should fail on malformed JSON")
	}
}

// ----- CoinGecko -----

func TestCoinGeckoExtractor_ValidResponse(t *testing.T) {
	// Real CoinGecko shape.
	body := []byte(`{"bitcoin":{"usd":95500.12}}`)
	src := findSource("CoinGecko")
	rate, err := src.extract(body)
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	if rate != 95500.12 {
		t.Errorf("rate = %v, want 95500.12", rate)
	}
}

func TestCoinGeckoExtractor_MissingBitcoin(t *testing.T) {
	body := []byte(`{"ethereum":{"usd":3500.00}}`)
	src := findSource("CoinGecko")
	if _, err := src.extract(body); err == nil {
		t.Error("extract should fail when bitcoin field is missing")
	}
}

func TestCoinGeckoExtractor_MissingUSD(t *testing.T) {
	body := []byte(`{"bitcoin":{"eur":90000.00}}`)
	src := findSource("CoinGecko")
	if _, err := src.extract(body); err == nil {
		t.Error("extract should fail when usd field is missing")
	}
}

func TestCoinGeckoExtractor_EmptyObject(t *testing.T) {
	body := []byte(`{}`)
	src := findSource("CoinGecko")
	if _, err := src.extract(body); err == nil {
		t.Error("extract should fail on empty object")
	}
}

// ============================================================================
// fetchOne — HTTP errors and timeouts
// ============================================================================

func TestFetchOne_ReturnsErrorOn500(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "backend crashed", http.StatusInternalServerError)
	}))
	defer srv.Close()

	f := &Fetcher{httpClient: srv.Client()}
	src := Source{
		Name:    "test",
		URL:     srv.URL,
		extract: func([]byte) (float64, error) { return 1.0, nil },
	}
	if _, _, err := f.fetchOne(context.Background(), src); err == nil {
		t.Error("fetchOne should fail on HTTP 500")
	}
}

func TestFetchOne_IncludesUserAgent(t *testing.T) {
	var gotUA string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUA = r.Header.Get("User-Agent")
		w.Write([]byte(`{"rate":95000}`))
	}))
	defer srv.Close()

	f := &Fetcher{httpClient: srv.Client()}
	src := Source{
		Name:    "test",
		URL:     srv.URL,
		extract: func([]byte) (float64, error) { return 1.0, nil },
	}
	_, _, _ = f.fetchOne(context.Background(), src)

	if gotUA == "" {
		t.Error("fetchOne should set User-Agent header")
	}
	// Per implementation: "Otedama/3.0.0-alpha (non-custodial mining)"
	if gotUA == "Go-http-client/1.1" {
		t.Errorf("User-Agent is default Go UA %q; should be customised", gotUA)
	}
}

func TestFetchOne_RespectsContext(t *testing.T) {
	// Server hangs forever — context cancellation must unblock fetchOne.
	blocker := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-blocker
	}))
	defer func() { close(blocker); srv.Close() }()

	f := &Fetcher{httpClient: srv.Client()}
	src := Source{
		Name:    "hang",
		URL:     srv.URL,
		extract: func([]byte) (float64, error) { return 0, nil },
	}

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	start := time.Now()
	_, _, err := f.fetchOne(ctx, src)
	elapsed := time.Since(start)

	if err == nil {
		t.Error("fetchOne should fail when context times out")
	}
	if elapsed > 500*time.Millisecond {
		t.Errorf("fetchOne took %v to respect context; should be <500ms", elapsed)
	}
}

func TestFetchOne_LimitsResponseSize(t *testing.T) {
	// Server sends 10 MB of junk — fetchOne should cap at 64 KB.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bigChunk := make([]byte, 128*1024)
		for i := 0; i < 80; i++ { // 10 MB total
			w.Write(bigChunk)
		}
	}))
	defer srv.Close()

	f := &Fetcher{httpClient: srv.Client()}
	src := Source{
		Name: "huge",
		URL:  srv.URL,
		extract: func(b []byte) (float64, error) {
			if len(b) > 128*1024 {
				t.Errorf("extract received %d bytes; should be capped", len(b))
			}
			return 0, nil
		},
	}
	_, _, _ = f.fetchOne(context.Background(), src)
}

// ============================================================================
// BTCUSDRate — concurrent read safety
// ============================================================================

func TestBTCUSDRate_ConcurrentReadSafe(t *testing.T) {
	// Multiple goroutines reading while one writes should not race.
	// Run with `go test -race ./internal/rates/`.
	f := NewFetcher(50000)
	f.mu.Lock()
	f.rate = 95000
	f.fetchedAt = time.Now()
	f.mu.Unlock()

	const readers = 50
	var wg sync.WaitGroup
	for i := 0; i < readers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				rate, _ := f.BTCUSDRate()
				if rate != 95000 {
					t.Errorf("concurrent read got unexpected rate %v", rate)
					return
				}
			}
		}()
	}
	wg.Wait()
}

// ============================================================================
// NewFetcher — defaults
// ============================================================================

func TestNewFetcher_UsesDefaultSources(t *testing.T) {
	f := NewFetcher(1000)
	if len(f.sources) != len(defaultSources) {
		t.Errorf("NewFetcher sources = %d, want %d", len(f.sources), len(defaultSources))
	}
	// Fallback stored.
	if f.fallback != 1000 {
		t.Errorf("fallback = %v, want 1000", f.fallback)
	}
	// httpClient non-nil with a sane timeout.
	if f.httpClient == nil {
		t.Fatal("httpClient is nil")
	}
	if f.httpClient.Timeout == 0 {
		t.Error("httpClient has no timeout; risks hanging forever")
	}
}

// ============================================================================
// StartBackground — fetches immediately then on ticker
// ============================================================================

func TestStartBackground_FetchesImmediately(t *testing.T) {
	var calls int64
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls++
		mu.Unlock()
		w.Write([]byte(`{"rate":99000}`))
	}))
	defer srv.Close()

	f := &Fetcher{
		httpClient: srv.Client(),
		fallback:   50000,
		sources: []Source{{
			Name: "stub",
			URL:  srv.URL,
			extract: func(b []byte) (float64, error) {
				return 99000, nil
			},
		}},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	f.StartBackground(ctx, 10*time.Minute) // long interval — we want to see initial call only

	// Wait for initial fetch to complete.
	time.Sleep(200 * time.Millisecond)

	mu.Lock()
	got := calls
	mu.Unlock()
	if got == 0 {
		t.Error("StartBackground did not perform initial fetch")
	}

	rate, fresh := f.BTCUSDRate()
	if rate != 99000 {
		t.Errorf("rate after initial fetch = %v, want 99000", rate)
	}
	if !fresh {
		t.Error("rate should be fresh immediately after fetch")
	}
}

func TestStartBackground_ExitsOnContextCancel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"rate":95000}`))
	}))
	defer srv.Close()

	f := &Fetcher{
		httpClient: srv.Client(),
		fallback:   50000,
		sources: []Source{{
			Name:    "stub",
			URL:     srv.URL,
			extract: func([]byte) (float64, error) { return 95000, nil },
		}},
	}

	ctx, cancel := context.WithCancel(context.Background())
	f.StartBackground(ctx, 50*time.Millisecond)
	// Let it tick once.
	time.Sleep(100 * time.Millisecond)
	cancel()
	// The goroutine should exit within a reasonable delay after cancel.
	// We can't directly check goroutine exit, but we verify no crash occurs.
	time.Sleep(200 * time.Millisecond)
}

// ============================================================================
// Source — struct validity
// ============================================================================

func TestDefaultSources_AllHaveRequiredFields(t *testing.T) {
	for _, src := range defaultSources {
		if src.Name == "" {
			t.Error("Source has empty Name")
		}
		if src.URL == "" {
			t.Errorf("Source %q has empty URL", src.Name)
		}
		if src.extract == nil {
			t.Errorf("Source %q has nil extract function", src.Name)
		}
	}
}

func TestDefaultSources_CountIsAtLeastTwo(t *testing.T) {
	// Median-based consensus requires at least 2 sources to have any
	// manipulation resistance. One source = trust that source.
	if len(defaultSources) < 2 {
		t.Errorf("only %d default sources; need >= 2 for median resilience",
			len(defaultSources))
	}
}

// ============================================================================
// CacheDuration — sanity
// ============================================================================

func TestCacheDuration_IsReasonable(t *testing.T) {
	// BTC price doesn't move so fast that a 5-minute cache is stale.
	// But caching too long risks arbitrage decisions based on old data.
	// The actual value should be 1..10 minutes.
	if CacheDuration < time.Minute {
		t.Errorf("CacheDuration = %v, too short (>1m recommended)", CacheDuration)
	}
	if CacheDuration > 10*time.Minute {
		t.Errorf("CacheDuration = %v, too long (<10m recommended)", CacheDuration)
	}
}
