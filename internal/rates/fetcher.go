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

// clockSkewWarnThreshold is the skew magnitude (in seconds) at which a warning
// is logged. Beyond this TLS certificate validation, mining nTime fields, and
// rate-freshness judgements all become unreliable.
const clockSkewWarnThreshold = 120.0

// Fetcher periodically fetches the BTC/USD exchange rate from multiple
// sources and caches the result.
type Fetcher struct {
	mu            sync.RWMutex
	rate          float64
	fetchedAt     time.Time
	clockSkewSecs float64      // max |local − server Date header| seen this fetch cycle
	sources       []Source
	httpClient    *http.Client
	fallback      float64      // used when all sources fail
	logFn         func(string) // nil = silent; set via SetLogger
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

// ClockSkewSeconds returns the maximum observed absolute offset (in seconds)
// between the local system clock and the wall-clock reported by rate-source
// HTTPS servers via their HTTP Date response header. Returns 0 until the first
// successful fetch that included a Date header. Safe for concurrent use.
func (f *Fetcher) ClockSkewSeconds() float64 {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.clockSkewSecs
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

// RateAge returns how long ago the cached rate was last successfully fetched,
// and whether any successful fetch has occurred. everFetched is false before
// the first success (age is then meaningless and returned as 0). This exposes
// "silent staleness": the rate value can look healthy long after sources stop
// responding, but a monotonically rising age reveals the stall. Safe for
// concurrent use.
func (f *Fetcher) RateAge() (age time.Duration, everFetched bool) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	if f.fetchedAt.IsZero() {
		return 0, false
	}
	return time.Since(f.fetchedAt), true
}

// Fetch queries all sources in parallel and updates the cached rate.
// It is safe to call from multiple goroutines simultaneously; only one
// fetch will run at a time.
func (f *Fetcher) Fetch(ctx context.Context) error {
	type result struct {
		rate     float64
		skewSecs float64
		err      error
	}
	results := make(chan result, len(f.sources))

	for _, src := range f.sources {
		go func(s Source) {
			r, sk, err := f.fetchOne(ctx, s)
			results <- result{rate: r, skewSecs: sk, err: err}
		}(src)
	}

	var rates []float64
	var maxSkew float64
	var skewSeen bool
	for range f.sources {
		r := <-results
		// Aggregate skew regardless of whether the rate fetch succeeded:
		// a non-200 response still carries a valid server Date header.
		if r.skewSecs > 0 {
			skewSeen = true
			if r.skewSecs > maxSkew {
				maxSkew = r.skewSecs
			}
		}
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

	// Persist the clock skew and warn loudly if it exceeds the threshold.
	// This is done before the rate check so skew is always updated even
	// when all rate sources fail (useful for clock-health alerting).
	if skewSeen {
		f.mu.Lock()
		f.clockSkewSecs = maxSkew
		f.mu.Unlock()
		if maxSkew > clockSkewWarnThreshold {
			f.logMsg(fmt.Sprintf(
				"rates: WARNING: local clock is %.0f s off server time "+
					"(threshold %.0f s); TLS certificate validation, mining "+
					"nTime fields, and rate-freshness judgements may be incorrect",
				maxSkew, clockSkewWarnThreshold))
		}
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

// fetchOne performs a single HTTP GET against src and returns the parsed
// BTC/USD rate, the absolute clock skew observed from the HTTP Date response
// header (0 if absent or unparseable), and any error.
func (f *Fetcher) fetchOne(ctx context.Context, src Source) (rate float64, skewSecs float64, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, src.URL, nil)
	if err != nil {
		return 0, 0, err
	}
	req.Header.Set("User-Agent", "Otedama/3.0.0-alpha (non-custodial mining)")

	resp, err := f.httpClient.Do(req)
	if err != nil {
		return 0, 0, fmt.Errorf("rates: %s: %w", src.Name, err)
	}
	defer resp.Body.Close()

	// Measure clock skew from the HTTP Date header before reading the body.
	// http.ParseTime understands RFC 7231 / 850 / ANSI-C date formats that
	// all major CDNs and API servers emit. A missing or malformed header
	// yields skewSecs = 0, which the caller treats as "no observation".
	if dateHdr := resp.Header.Get("Date"); dateHdr != "" {
		if serverTime, parseErr := http.ParseTime(dateHdr); parseErr == nil {
			diff := time.Since(serverTime)
			if diff < 0 {
				diff = -diff
			}
			skewSecs = diff.Seconds()
		}
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return 0, skewSecs, fmt.Errorf("rates: %s: read body: %w", src.Name, err)
	}
	if resp.StatusCode != http.StatusOK {
		return 0, skewSecs, fmt.Errorf("rates: %s: HTTP %d", src.Name, resp.StatusCode)
	}
	rate, err = src.extract(body)
	return rate, skewSecs, err
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
