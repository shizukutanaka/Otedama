// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package rates

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// octopusBaseURL is the public, keyless Octopus Energy product API. The
// standard-unit-rates endpoint is documented upstream and requires no
// authentication for read-only tariff data; the URL is a variable so
// tests can point the fetcher at a stub server.
var octopusBaseURL = "https://api.octopus.energy"

// AgileRate is one half-hourly unit-rate slot of an Octopus Agile
// (or compatible time-of-use) tariff. Values are in pence per kWh —
// the UK's native billing unit — so the field names carry the unit
// explicitly to prevent silent mixing with the USD-denominated
// electricity_price_per_kwh config field.
type AgileRate struct {
	ValueIncVATPence float64
	ValueExcVATPence float64
	ValidFrom        time.Time
	ValidTo          time.Time
}

// octopusRateResponse is the upstream wire shape: a paginated envelope
// whose results[] are newest-first half-hourly slots.
type octopusRateResponse struct {
	Results []struct {
		ValueIncVat float64 `json:"value_inc_vat"`
		ValueExcVat float64 `json:"value_exc_vat"`
		ValidFrom   string  `json:"valid_from"`
		ValidTo     string  `json:"valid_to"`
	} `json:"results"`
}

// FetchAgileRates returns the tariff's unit-rate curve for slots ending
// after `from`. It deliberately returns a *forward curve*, not a spot
// price: a horizon-aware scheduler (ADR-008 sub-domain 4) plans
// curtailment windows ahead of time, which a single current price cannot
// express. The Octopus/Tibber/Amber feeds all expose forward curves, so
// that is the shape every tariff source is expected to have.
//
// `product` and `tariff` are the Octopus identifiers, e.g.
// "AGILE-24-10-01" / "E-1R-AGILE-24-10-01-A". At most `pageSize` slots
// are returned (48 covers a full day of half-hourly prices).
func FetchAgileRates(ctx context.Context, client *http.Client, product, tariff string, from time.Time, pageSize int) ([]AgileRate, error) {
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	u, err := url.Parse(octopusBaseURL + "/v1/products/" + url.PathEscape(product) +
		"/electricity-tariffs/" + url.PathEscape(tariff) + "/standard-unit-rates/")
	if err != nil {
		return nil, fmt.Errorf("octopus: bad tariff identifiers: %w", err)
	}
	q := u.Query()
	q.Set("period_from", from.UTC().Format(time.RFC3339))
	if pageSize > 0 {
		q.Set("page_size", fmt.Sprintf("%d", pageSize))
	}
	u.RawQuery = q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), http.NoBody)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("octopus: fetch unit rates: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("octopus: unit rates returned HTTP %d", resp.StatusCode)
	}
	// Bound the read like fetcher.go's 64 KiB cap: a hostile or broken
	// upstream returning an unbounded body would otherwise exhaust
	// memory. A day's Agile half-hourly rates is ~10 KB.
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return nil, fmt.Errorf("octopus: read unit rates: %w", err)
	}
	var body octopusRateResponse
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, fmt.Errorf("octopus: decode unit rates: %w", err)
	}
	if len(body.Results) == 0 {
		return nil, fmt.Errorf("octopus: unit rates returned no slots (bad product/tariff?)")
	}
	rates := make([]AgileRate, 0, len(body.Results))
	for _, r := range body.Results {
		fromT, err1 := time.Parse(time.RFC3339, r.ValidFrom)
		toT, err2 := time.Parse(time.RFC3339, r.ValidTo)
		if err1 != nil || err2 != nil {
			return nil, fmt.Errorf("octopus: bad slot timestamps %q/%q", r.ValidFrom, r.ValidTo)
		}
		rates = append(rates, AgileRate{
			ValueIncVATPence: r.ValueIncVat,
			ValueExcVATPence: r.ValueExcVat,
			ValidFrom:        fromT,
			ValidTo:          toT,
		})
	}
	return rates, nil
}

// AgileRateAt selects the slot valid at `t` from a fetched curve
// (ValidFrom <= t < ValidTo). Returns false when the curve covers no
// such slot — the caller keeps the previous reading rather than acting
// on an out-of-window value.
func AgileRateAt(rates []AgileRate, t time.Time) (AgileRate, bool) {
	for _, r := range rates {
		if !t.Before(r.ValidFrom) && t.Before(r.ValidTo) {
			return r, true
		}
	}
	return AgileRate{}, false
}

// AgileCurveBounds returns the min and max VAT-inclusive unit price across
// the fetched curve — the forward envelope a scheduler (or an alert) plans
// around: the max tells you the worst price coming, the min the cheapest
// upcoming slot. ok=false on an empty curve; callers keep prior values.
func AgileCurveBounds(curve []AgileRate) (lo, hi float64, ok bool) {
	if len(curve) == 0 {
		return 0, 0, false
	}
	lo, hi = curve[0].ValueIncVATPence, curve[0].ValueIncVATPence
	for _, r := range curve[1:] {
		if r.ValueIncVATPence < lo {
			lo = r.ValueIncVATPence
		}
		if r.ValueIncVATPence > hi {
			hi = r.ValueIncVATPence
		}
	}
	return lo, hi, true
}
