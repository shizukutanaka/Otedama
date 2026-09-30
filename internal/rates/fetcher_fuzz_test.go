// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package rates

import (
	"context"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// FuzzSourceExtract feeds arbitrary bytes into every built-in source's
// response extractor. The extractors run on remote-controlled JSON, so they
// must never panic, and a successful result must be finite — a "NaN" or
// "Infinity" literal parses cleanly through strconv.ParseFloat and would
// otherwise defeat the [min,max] plausibility band (comparisons against NaN
// are always false).
func FuzzSourceExtract(f *testing.F) {
	seeds := [][]byte{
		[]byte(`{"data":{"amount":"95432.10"}}`),
		[]byte(`{"data":{"amount":"NaN"}}`),
		[]byte(`{"data":{"amount":"Infinity"}}`),
		[]byte(`{"result":{"XXBTZUSD":{"c":["95432.10","0.001"]}}}`),
		[]byte(`{"result":{"XXBTZUSD":{"c":["NaN","0.001"]}}}`),
		[]byte(`{"bitcoin":{"usd":95432.10}}`),
		[]byte(`{"bitcoin":{"usd":0}}`),
		[]byte(`{}`),
		[]byte(`null`),
		[]byte(`[`),
		{0xff, 0x00, 0x01},
	}
	for _, s := range seeds {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, body []byte) {
		for _, src := range defaultSources {
			rate, err := src.extract(body)
			if err == nil && (math.IsNaN(rate) || math.IsInf(rate, 0)) {
				t.Fatalf("%s extract returned non-finite %v for %q", src.Name, rate, body)
			}
		}
	})
}

// TestFetchRejectsNonFiniteReading wires an HTTP test server returning a
// NaN price into a single-source Fetcher and asserts the reading is
// dropped (extract-level rejection), leaving the fetch to fail rather
// than caching NaN as the BTC/USD rate.
func TestFetchRejectsNonFiniteReading(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"data":{"amount":"NaN"}}`))
	}))
	defer srv.Close()

	f := &Fetcher{
		sources: []Source{{
			Name: "test-nan",
			URL:  srv.URL,
			extract: func(b []byte) (float64, error) {
				return defaultSources[0].extract(b) // coinbase-shaped body
			},
		}},
		httpClient: srv.Client(),
		fallback:   50000,
	}
	if err := f.Fetch(context.Background()); err == nil {
		t.Fatal("expected fetch to fail when the only source returns NaN")
	}
	if rate, _ := f.BTCUSDRate(); math.IsNaN(rate) {
		t.Fatalf("cached rate is NaN")
	}
}

// TestParseRate covers the strict numeric-string helper directly.
func TestParseRate(t *testing.T) {
	for _, s := range []string{"NaN", "nan", "Infinity", "-Inf", "+inf", "1e999"} {
		if v, err := parseRate(s); err == nil {
			t.Fatalf("parseRate(%q) = %v, want error", s, v)
		}
	}
	for _, s := range []string{"0", "95432.10", "1e6"} {
		if _, err := parseRate(s); err != nil {
			t.Fatalf("parseRate(%q) errored: %v", s, err)
		}
	}
}

// TestFetchBandDropsNonFinite asserts the doFetch plausibility band itself
// rejects a non-finite rate even if an extractor were to produce one
// (defense in depth for sources added later).
func TestFetchBandDropsNonFinite(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`ok`))
	}))
	defer srv.Close()

	f := &Fetcher{
		sources: []Source{{
			Name: "test-bad",
			URL:  srv.URL,
			extract: func(b []byte) (float64, error) {
				return math.NaN(), nil // hypothetical future-source bug
			},
		}},
		httpClient: srv.Client(),
		fallback:   50000,
	}
	_ = f.Fetch(context.Background())
	if f.lastOKSources != 0 {
		t.Fatalf("NaN reading counted as usable source: lastOKSources=%d", f.lastOKSources)
	}
	// Give the fetch loop a beat then confirm the fallback path held.
	time.Sleep(10 * time.Millisecond)
	if rate, fresh := f.BTCUSDRate(); math.IsNaN(rate) {
		t.Fatalf("BTCUSDRate returned NaN (fresh=%v)", fresh)
	}
}
