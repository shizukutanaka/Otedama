// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
package rates

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Optional carbon-intensity curtailment (RESEARCH_IMPROVEMENTS Cat 8 #10,
// SUSTAINABILITY.md): the UK National Grid ESO publishes a free, key-less
// half-hourly carbon-intensity reading for Great Britain — the only such
// public feed that requires no account — letting UK operators pause
// hashing during dirty grid windows. It is a national *index*, not the
// marginal-emissions (MOER) signal ideal for curtailment decisions (Cat
// 8/9's WattTime note); MOER sources need keys and remain future work.

const carbonIntensityURL = "https://api.carbonintensity.org.uk/intensity"

// CarbonIntensity is Great Britain's grid carbon intensity for the
// current half-hour settlement slot.
type CarbonIntensity struct {
	// Forecast is the ESO's forecast gCO2/kWh for the slot — used for the
	// curtail gate because Actual is often absent until the slot closes.
	Forecast float64
	// Actual is the metered gCO2/kWh when published; 0 when unavailable.
	Actual float64
	// Index is the ESO band: "very low", "low", "moderate", "high",
	// "very high".
	Index string
	// From/To bound the settlement slot (UTC).
	From time.Time
	To   time.Time
}

type carbonResponse struct {
	Data []struct {
		From      string `json:"from"`
		To        string `json:"to"`
		Intensity struct {
			Forecast float64 `json:"forecast"`
			Actual   float64 `json:"actual"`
			Index    string  `json:"index"`
		} `json:"intensity"`
	} `json:"data"`
}

var carbonHTTP = &http.Client{Timeout: 10 * time.Second}

// FetchCarbonIntensity returns the current half-hour GB grid intensity.
// Callers must treat the reading as UK-only: it says nothing about other
// grids, so the gate stays disabled unless the operator opted in.
func FetchCarbonIntensity(ctx context.Context) (CarbonIntensity, error) {
	return fetchCarbonIntensity(ctx, carbonHTTP, carbonIntensityURL)
}

func fetchCarbonIntensity(ctx context.Context, client *http.Client, endpoint string) (CarbonIntensity, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, http.NoBody)
	if err != nil {
		return CarbonIntensity{}, fmt.Errorf("carbon: build request: %w", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		return CarbonIntensity{}, fmt.Errorf("carbon: fetch: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return CarbonIntensity{}, fmt.Errorf("carbon: HTTP %d", resp.StatusCode)
	}
	var cr carbonResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64*1024)).Decode(&cr); err != nil {
		return CarbonIntensity{}, fmt.Errorf("carbon: decode: %w", err)
	}
	if len(cr.Data) == 0 {
		return CarbonIntensity{}, fmt.Errorf("carbon: empty response")
	}
	slot := cr.Data[0]
	ci := CarbonIntensity{
		Forecast: slot.Intensity.Forecast,
		Actual:   slot.Intensity.Actual,
		Index:    slot.Intensity.Index,
	}
	if t, err := time.Parse("2006-01-02T15:04Z", slot.From); err == nil {
		ci.From = t
	}
	if t, err := time.Parse("2006-01-02T15:04Z", slot.To); err == nil {
		ci.To = t
	}
	return ci, nil
}
