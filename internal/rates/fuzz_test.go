// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package rates

import (
	"context"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
)

// ============================================================================
// Non-finite rate readings — ParseFloat accepts "NaN"/"Inf" where JSON
// numbers cannot express them, so string-typed sources (Coinbase, Kraken)
// are the trust boundary. A NaN price poisons the median because every
// ordered comparison against it is false.
// ============================================================================

func plausibleBand(r float64) bool {
	return !math.IsNaN(r) && r >= minPlausibleRateUSD && r <= maxPlausibleRateUSD
}

func TestExtractors_NonFiniteReadingsDropped(t *testing.T) {
	cases := []struct {
		source string
		body   string
	}{
		{"Coinbase", `{"data":{"amount":"NaN"}}`},
		{"Coinbase", `{"data":{"amount":"nan"}}`},
		{"Coinbase", `{"data":{"amount":"+Inf"}}`},
		{"Coinbase", `{"data":{"amount":"-Inf"}}`},
		{"Coinbase", `{"data":{"amount":"Infinity"}}`},
		{"Kraken", `{"result":{"XXBTZUSD":{"c":["NaN","1"]}}}`},
		{"Kraken", `{"result":{"XXBTZUSD":{"c":["Inf","1"]}}}`},
		{"Kraken", `{"result":{"XXBTZUSD":{"c":["-Infinity","1"]}}}`},
	}
	for _, tc := range cases {
		src := findSource(tc.source)
		rate, err := src.extract([]byte(tc.body))
		// The extractor may return the non-finite value (ParseFloat
		// accepts these tokens); the sanity band is the gate that must
		// reject them.
		if err == nil && plausibleBand(rate) {
			t.Errorf("%s %s: non-finite reading %v passed the plausibility band", tc.source, tc.body, rate)
		}
	}
}

// TestFetch_DropsNaNReading exercises the full doFetch path: a fake source
// answering a well-formed response carrying "NaN" must be dropped, leaving
// the fetch to fail rather than cache NaN as the BTC/USD rate.
func TestFetch_DropsNaNReading(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"data":{"amount":"NaN"}}`)) //nolint:errcheck // test body
	}))
	defer srv.Close()

	f := NewFetcher(0)
	f.sources = []Source{{Name: "NaNSource", URL: srv.URL, extract: findSource("Coinbase").extract}}
	f.httpClient = srv.Client()

	err := f.Fetch(context.Background())
	if err == nil {
		t.Fatal("Fetch should fail: all readings implausible")
	}
	rate, _ := f.BTCUSDRate()
	if math.IsNaN(rate) {
		t.Fatal("NaN rate was cached — band check failed")
	}
}

// FuzzRateExtractors feeds arbitrary bodies to each exchange extractor.
// Invariants: no panic, and any successfully parsed reading that survives
// the plausibility band is finite.
func FuzzRateExtractors(f *testing.F) {
	seeds := [][]byte{
		[]byte(`{"data":{"amount":"NaN"}}`),
		[]byte(`{"data":{"amount":"95000.5"}}`),
		[]byte(`{"data":{"amount":"+Inf"}}`),
		[]byte(`{"result":{"XXBTZUSD":{"c":["NaN","1"],"a":["95001","2"]}}}`),
		[]byte(`{"result":{"XXBTZUSD":{"c":["1e999","1"]}}}`),
		[]byte(`{"bitcoin":{"usd":95000}}`),
		[]byte(`{"bitcoin":{"usd":1e999}}`),
		[]byte(`not json`),
		[]byte(``),
	}
	for i, s := range seeds {
		f.Add(byte(i), s)
	}
	f.Fuzz(func(t *testing.T, sel byte, body []byte) {
		src := defaultSources[int(sel)%len(defaultSources)]
		rate, err := src.extract(body)
		if err != nil {
			return
		}
		if plausibleBand(rate) && (math.IsNaN(rate) || math.IsInf(rate, 0)) {
			t.Fatalf("non-finite rate %v passed the band for %s", rate, src.Name)
		}
	})
}
