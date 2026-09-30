// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package rates

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func hashFetcherWith(t *testing.T, sources []HashrateSource) *HashrateFetcher {
	t.Helper()
	return &HashrateFetcher{
		sources:    sources,
		httpClient: srvClient(),
	}
}

// srvClient borrows the default http client; httptest servers are
// plain HTTP so no TLS config is needed.
func srvClient() *http.Client {
	return &http.Client{Timeout: 5 * time.Second}
}

func mempoolBody(h float64) string {
	return fmt.Sprintf(`{"hashrates":[],"currentHashrate":%g}`, h)
}

func TestHashrateFetcher_ZeroBeforeFirstFetch(t *testing.T) {
	f := NewHashrateFetcher()
	if h, fresh := f.CurrentHashrate(); h != 0 || fresh {
		t.Errorf("CurrentHashrate = (%v, %v), want (0, false)", h, fresh)
	}
}

func TestHashrateFetcher_ParsesMempoolJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(mempoolBody(9.3e20)))
	}))
	defer srv.Close()

	f := hashFetcherWith(t, []HashrateSource{{
		Name: "fake-mempool", URL: srv.URL,
		extract: defaultHashrateSources[0].extract,
	}})
	if err := f.Fetch(context.Background()); err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	h, fresh := f.CurrentHashrate()
	if !fresh {
		t.Fatal("fresh = false after successful fetch")
	}
	if h != 9.3e20 {
		t.Errorf("hashrate = %e, want 9.3e20", h)
	}
}

func TestHashrateFetcher_ParsesPlainTextGHs(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("930000000000")) // GH/s → 9.3e20 H/s
	}))
	defer srv.Close()

	f := hashFetcherWith(t, []HashrateSource{{
		Name: "fake-bci", URL: srv.URL,
		extract: defaultHashrateSources[1].extract,
	}})
	if err := f.Fetch(context.Background()); err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	h, _ := f.CurrentHashrate()
	if h != 9.3e20 {
		t.Errorf("hashrate = %e, want 9.3e20 (GH/s→H/s conversion)", h)
	}
}

// Two agreeing sources → mean; one implausible outlier is excluded
// from the median entirely.
func TestHashrateFetcher_MedianAndPlausibilityBand(t *testing.T) {
	srvA := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(mempoolBody(9.0e20)))
	}))
	defer srvA.Close()
	srvB := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(mempoolBody(9.6e20)))
	}))
	defer srvB.Close()
	srvBad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(mempoolBody(42))) // implausibly low
	}))
	defer srvBad.Close()

	extract := defaultHashrateSources[0].extract
	f := hashFetcherWith(t, []HashrateSource{
		{Name: "a", URL: srvA.URL, extract: extract},
		{Name: "b", URL: srvB.URL, extract: extract},
		{Name: "bad", URL: srvBad.URL, extract: extract},
	})
	if err := f.Fetch(context.Background()); err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	h, _ := f.CurrentHashrate()
	if h != 9.3e20 {
		t.Errorf("hashrate = %e, want 9.3e20 (mean of the two in-band sources)", h)
	}
}

func TestHashrateFetcher_AllSourcesFail(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	f := hashFetcherWith(t, []HashrateSource{{
		Name: "down", URL: srv.URL,
		extract: defaultHashrateSources[0].extract,
	}})
	if err := f.Fetch(context.Background()); err == nil {
		t.Fatal("Fetch succeeded with all sources down")
	}
	if h, fresh := f.CurrentHashrate(); h != 0 || fresh {
		t.Errorf("CurrentHashrate = (%v, %v), want (0, false) after total failure", h, fresh)
	}
}
