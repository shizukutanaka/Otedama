// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package rates

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
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

func parseFloat(s string, out *float64) (int, error) {
	return fmt.Sscanf(s, "%f", out)
}
