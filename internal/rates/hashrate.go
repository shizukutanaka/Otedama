// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package rates

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strconv"
	"sync"
	"time"
)

// HashrateSource identifies one public Bitcoin network-hashrate
// endpoint. extract parses the response body and returns hashes per
// second (H/s).
type HashrateSource struct {
	Name string
	URL  string
	// extract parses the response body and returns H/s.
	extract func(body []byte) (float64, error)
}

// maxHashrateBody caps a hashrate-endpoint response body — the same
// 64 KiB ceiling the price fetcher uses. Public JSON endpoints are
// untrusted input: without a limit, a hostile or malfunctioning
// endpoint could stream an unbounded body into memory.
const maxHashrateBody = 64 << 10

// hashratePlausibility bounds accepted readings. The real network sat
// at ~930 EH/s (9.3e20 H/s) in 2026; the band [1e18, 1e23] H/s
// tolerates orders of magnitude of legitimate drift while rejecting
// garbage (parse artifacts, unit confusion, malicious payloads)
// before it can distort a mining-yield estimate.
const (
	minPlausibleHashrate = 1e18
	maxPlausibleHashrate = 1e23
)

// defaultHashrateSources are public, no-auth endpoints. mempool.space
// reports H/s directly; blockchain.info reports GH/s.
var defaultHashrateSources = []HashrateSource{
	{
		Name: "mempool.space",
		URL:  "https://mempool.space/api/v1/mining/hashrate/1d",
		extract: func(b []byte) (float64, error) {
			var v struct {
				CurrentHashrate float64 `json:"currentHashrate"`
			}
			if err := json.Unmarshal(b, &v); err != nil {
				return 0, err
			}
			if v.CurrentHashrate <= 0 {
				return 0, fmt.Errorf("currentHashrate %v not positive", v.CurrentHashrate)
			}
			return v.CurrentHashrate, nil
		},
	},
	{
		Name: "blockchain.info",
		URL:  "https://blockchain.info/q/hashrate",
		extract: func(b []byte) (float64, error) {
			// Plain-text GH/s, e.g. "930513978214".
			ghs, err := strconv.ParseFloat(string(b), 64)
			if err != nil {
				return 0, err
			}
			return ghs * 1e9, nil
		},
	},
}

// HashrateFetcher polls public endpoints for the Bitcoin network's
// estimated total hashrate, which MiningProvider divides device
// hashrate by to estimate sats/sec. Multiple sources are queried and
// the median of successful responses is used so a single manipulated
// or malformed endpoint cannot distort the arbitration input. This is
// the live difficulty feed KNOWN_LIMITATIONS §7 defers to; the
// provider keeps its compile-time fallback whenever the fetcher is
// cold or stale.
type HashrateFetcher struct {
	sources    []HashrateSource
	httpClient *http.Client
	logFn      func(string)

	mu        sync.RWMutex
	hashrate  float64   // H/s
	fetchedAt time.Time // last successful fetch
}

// HashrateCacheDuration is the freshness window for a cached reading.
// Network hashrate moves slowly (difficulty retargets roughly
// fortnightly, a few percent each), so a reading stays meaningful far
// longer than a fiat price does.
const HashrateCacheDuration = 30 * time.Minute

// NewHashrateFetcher returns a fetcher with the default public
// endpoints and a 10-second HTTP timeout.
func NewHashrateFetcher() *HashrateFetcher {
	return &HashrateFetcher{
		sources: defaultHashrateSources,
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// SetLogger installs a message sink for fetch diagnostics (one string
// per line, level embedded).
func (f *HashrateFetcher) SetLogger(fn func(string)) { f.logFn = fn }

func (f *HashrateFetcher) logMsg(msg string) {
	if f.logFn != nil {
		f.logFn(msg)
	}
}

// CurrentHashrate returns the cached network hashrate (H/s) and
// whether it is fresh (< HashrateCacheDuration old). Returns
// (0, false) before the first successful fetch.
func (f *HashrateFetcher) CurrentHashrate() (hps float64, fresh bool) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	if f.hashrate <= 0 {
		return 0, false
	}
	return f.hashrate, time.Since(f.fetchedAt) < HashrateCacheDuration
}

// FetchAge returns the age of the last successful fetch and whether a
// fetch has ever succeeded. Before the first fetch it returns (0, false)
// so callers can distinguish "never fetched" from "just fetched".
func (f *HashrateFetcher) FetchAge() (age time.Duration, fetched bool) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	if f.fetchedAt.IsZero() {
		return 0, false
	}
	return time.Since(f.fetchedAt), true
}

// Fetch queries all sources in parallel and caches the median of
// successful, in-band readings.
func (f *HashrateFetcher) Fetch(ctx context.Context) error {
	results := make(chan float64, len(f.sources))
	var wg sync.WaitGroup
	for _, src := range f.sources {
		wg.Add(1)
		go func(s HashrateSource) {
			defer wg.Done()
			v, err := f.fetchOne(ctx, s)
			if err != nil {
				f.logMsg(fmt.Sprintf("rates: hashrate source %s: %v", s.Name, err))
				return
			}
			results <- v
		}(src)
	}
	wg.Wait()
	close(results)

	var vals []float64
	for v := range results {
		vals = append(vals, v)
	}
	if len(vals) == 0 {
		return fmt.Errorf("rates: all %d hashrate sources failed", len(f.sources))
	}
	slices.Sort(vals)
	// Median; for an even number of sources average the middle two,
	// matching the price fetcher's convention.
	n := len(vals)
	h := vals[n/2]
	if n%2 == 0 {
		h = (vals[n/2-1] + vals[n/2]) / 2
	}

	f.mu.Lock()
	f.hashrate = h
	f.fetchedAt = time.Now()
	f.mu.Unlock()
	return nil
}

// fetchOne reads one endpoint, enforcing the body-size ceiling and the
// plausibility band.
func (f *HashrateFetcher) fetchOne(ctx context.Context, src HashrateSource) (float64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, src.URL, nil)
	if err != nil {
		return 0, err
	}
	resp, err := f.httpClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		// Drain a bounded slice so keep-alive can reuse the connection.
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxHashrateBody))
		return 0, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxHashrateBody))
	if err != nil {
		return 0, err
	}
	v, err := src.extract(body)
	if err != nil {
		return 0, err
	}
	if v < minPlausibleHashrate || v > maxPlausibleHashrate {
		return 0, fmt.Errorf("hashrate %e H/s outside plausibility band", v)
	}
	return v, nil
}

// StartBackground polls at the given interval until ctx is cancelled.
// The first fetch runs immediately so the provider sees a live value
// within the first seconds of operation rather than after a full
// interval.
func (f *HashrateFetcher) StartBackground(ctx context.Context, interval time.Duration) {
	go func() {
		if err := f.Fetch(ctx); err != nil {
			f.logMsg(fmt.Sprintf("rates: hashrate fetch: %v", err))
		}
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := f.Fetch(ctx); err != nil {
					f.logMsg(fmt.Sprintf("rates: hashrate fetch: %v", err))
				}
			}
		}
	}()
}
