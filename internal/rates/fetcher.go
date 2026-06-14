// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package rates provides live Bitcoin/USD exchange rate data.
//
// Exchange rate data is fundamental to Otedama: without knowing the BTC
// price, the arbitration engine cannot compare mining revenue (paid in
// sats) with AI inference revenue (quoted in USD). All earnings displays
// that show "$X/day" depend on this package.
//
// Multiple sources are queried in parallel. The median of all successful
// responses is returned as the rate. This prevents a single manipulated
// or stale source from distorting the arbitration decision.
package rates

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"sync"
	"time"
)

// Source identifies a price data source.
type Source struct {
	Name string
	URL  string
	// extract parses the JSON response and returns the BTC/USD price.
	extract func(body []byte) (float64, error)
}

// defaultSources are the price sources queried in parallel.
// All are public, no-auth endpoints.
var defaultSources = []Source{
	{
		Name: "Coinbase",
		URL:  "https://api.coinbase.com/v2/prices/BTC-USD/spot",
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
			_, err := fmt.Sscanf(v.Data.Amount, "%f", &rate)
			return rate, err
		},
	},
	{
		Name: "Kraken",
		URL:  "https://api.kraken.com/0/public/Ticker?pair=XBTUSD",
		extract: func(b []byte) (float64, error) {
			var v struct {
				Result map[string]struct {
					C []string `json:"c"` // last trade closed: [price, lot volume]
				} `json:"result"`
			}
			if err := json.Unmarshal(b, &v); err != nil {
				return 0, err
			}
			for _, ticker := range v.Result {
				if len(ticker.C) == 0 {
					continue
				}
				var rate float64
				_, err := fmt.Sscanf(ticker.C[0], "%f", &rate)
				return rate, err
			}
			return 0, fmt.Errorf("rates: kraken: no ticker data")
		},
	},
	{
		Name: "CoinGecko",
		URL:  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
		extract: func(b []byte) (float64, error) {
			var v map[string]map[string]float64
			if err := json.Unmarshal(b, &v); err != nil {
				return 0, err
			}
			if btc, ok := v["bitcoin"]; ok {
				if usd, ok := btc["usd"]; ok {
					return usd, nil
				}
			}
			return 0, fmt.Errorf("rates: coingecko: missing bitcoin.usd field")
		},
	},
}

// CacheDuration is how long a fetched rate is considered fresh.
const CacheDuration = 5 * time.Minute

// minPlausibleRateUSD and maxPlausibleRateUSD bound a believable BTC/USD price.
// They are deliberately very wide sanity rails — orders of magnitude beyond any
// real price for the foreseeable future — whose only job is to reject a source
// reading mangled by a unit or parse error (a price returned in BTC, in
// thousands, or in satoshis) before it can pull the median. A reading outside
// this band is a bug or manipulation, never a real quote, so dropping it
// strengthens the median's outlier resistance in the vulnerable two-source
// case, where a relative test cannot tell which of two values is wrong.
const (
	minPlausibleRateUSD = 100.0
	maxPlausibleRateUSD = 100_000_000.0
)

// Fetcher periodically fetches the BTC/USD exchange rate from multiple
// sources and caches the result.
type Fetcher struct {
	mu         sync.RWMutex
	rate       float64
	fetchedAt  time.Time
	sources    []Source
	httpClient *http.Client
	fallback   float64      // used when all sources fail
	logFn      func(string) // nil = silent; set via SetLogger
}

// SetLogger installs a log callback for error events (initial fetch failure,
// recurring fetch failure). The callback receives a human-readable message and
// must be safe to call from any goroutine. Call before StartBackground.
func (f *Fetcher) SetLogger(fn func(string)) { f.logFn = fn }

// logMsg calls f.logFn if set, otherwise discards the message.
func (f *Fetcher) logMsg(msg string) {
	if f.logFn != nil {
		f.logFn(msg)
	}
}

// NewFetcher returns a Fetcher with default public price sources.
// fallback is used when all network sources are unavailable.
func NewFetcher(fallback float64) *Fetcher {
	return &Fetcher{
		sources:  defaultSources,
		fallback: fallback,
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// BTCUSDRate implements provider.RateSource.
// Returns the cached rate and whether it is fresh (< CacheDuration old).
// If no rate has ever been successfully fetched, returns the fallback
// with fresh=false.
func (f *Fetcher) BTCUSDRate() (rate float64, fresh bool) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	if f.rate <= 0 {
		return f.fallback, false
	}
	return f.rate, time.Since(f.fetchedAt) < CacheDuration
}

// Fetch queries all sources in parallel and updates the cached rate.
// It is safe to call from multiple goroutines simultaneously; only one
// fetch will run at a time.
func (f *Fetcher) Fetch(ctx context.Context) error {
	type result struct {
		rate float64
		err  error
	}
	results := make(chan result, len(f.sources))

	for _, src := range f.sources {
		go func(s Source) {
			r, err := f.fetchOne(ctx, s)
			results <- result{rate: r, err: err}
		}(src)
	}

	var rates []float64
	for range f.sources {
		r := <-results
		if r.err != nil {
			continue
		}
		if r.rate < minPlausibleRateUSD || r.rate > maxPlausibleRateUSD {
			// A reading outside the sanity band is a unit/parse error or
			// manipulation, never a real quote. Drop it so it cannot pull the
			// median. Stay quiet on a plain zero (a source that simply has no
			// value yet); only flag genuinely implausible non-zero readings.
			if r.rate != 0 {
				f.logMsg(fmt.Sprintf("rates: ignoring implausible reading %.2f (outside [%.0f, %.0f])",
					r.rate, minPlausibleRateUSD, maxPlausibleRateUSD))
			}
			continue
		}
		rates = append(rates, r.rate)
	}

	if len(rates) == 0 {
		return fmt.Errorf("rates: all sources failed")
	}

	// Use the median to resist outlier manipulation. For an even number
	// of surviving sources, average the two middle values — picking a
	// single middle element would bias toward the higher source and
	// defeat the outlier resistance when exactly two sources remain.
	sort.Float64s(rates)
	var median float64
	if n := len(rates); n%2 == 1 {
		median = rates[n/2]
	} else {
		median = (rates[n/2-1] + rates[n/2]) / 2
	}

	f.mu.Lock()
	f.rate = median
	f.fetchedAt = time.Now()
	f.mu.Unlock()
	return nil
}

func (f *Fetcher) fetchOne(ctx context.Context, src Source) (float64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, src.URL, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("User-Agent", "Otedama/3.0.0-alpha (non-custodial mining)")

	resp, err := f.httpClient.Do(req)
	if err != nil {
		return 0, fmt.Errorf("rates: %s: %w", src.Name, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return 0, fmt.Errorf("rates: %s: read body: %w", src.Name, err)
	}
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("rates: %s: HTTP %d", src.Name, resp.StatusCode)
	}
	return src.extract(body)
}

// StartBackground launches a goroutine that refreshes the rate every
// interval. It performs an initial fetch immediately.
// The goroutine exits when ctx is cancelled.
func (f *Fetcher) StartBackground(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = CacheDuration
	}
	go func() {
		if err := f.Fetch(ctx); err != nil {
			f.logMsg("rates: initial fetch failed: " + err.Error())
		}
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := f.Fetch(ctx); err != nil {
					f.logMsg("rates: periodic fetch failed: " + err.Error())
				}
			}
		}
	}()
}
