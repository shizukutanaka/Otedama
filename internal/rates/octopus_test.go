// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package rates

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

const agileFixture = `{"count":3,"next":null,"previous":null,"results":[
{"value_exc_vat":28.09,"value_inc_vat":29.4945,"valid_from":"2026-09-23T21:30:00Z","valid_to":"2026-09-23T22:00:00Z","payment_method":null},
{"value_exc_vat":28.05,"value_inc_vat":29.4525,"valid_from":"2026-09-23T21:00:00Z","valid_to":"2026-09-23T21:30:00Z","payment_method":null},
{"value_exc_vat":-1.2,"value_inc_vat":-1.26,"valid_from":"2026-09-23T20:30:00Z","valid_to":"2026-09-23T21:00:00Z","payment_method":null}]}`

func fetchWithStub(t *testing.T, body string, status int) ([]AgileRate, *http.Request, error) {
	t.Helper()
	var got *http.Request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	old := octopusBaseURL
	octopusBaseURL = srv.URL
	defer func() { octopusBaseURL = old }()

	from := time.Date(2026, 9, 23, 20, 0, 0, 0, time.UTC)
	rates, err := FetchAgileRates(context.Background(), srv.Client(),
		"AGILE-24-10-01", "E-1R-AGILE-24-10-01-A", from, 48)
	return rates, got, err
}

func TestFetchAgileRates_DecodesAndBuildsURL(t *testing.T) {
	rates, got, err := fetchWithStub(t, agileFixture, http.StatusOK)
	if err != nil {
		t.Fatalf("FetchAgileRates: %v", err)
	}
	if len(rates) != 3 {
		t.Fatalf("got %d slots, want 3", len(rates))
	}
	// Path carries both identifiers.
	u, _ := url.Parse(got.URL.String())
	wantPath := "/v1/products/AGILE-24-10-01/electricity-tariffs/E-1R-AGILE-24-10-01-A/standard-unit-rates/"
	if u.Path != wantPath {
		t.Errorf("request path = %q, want %q", u.Path, wantPath)
	}
	if got.URL.Query().Get("period_from") == "" {
		t.Error("period_from query missing")
	}
	if got.URL.Query().Get("page_size") != "48" {
		t.Errorf("page_size = %q, want 48", got.URL.Query().Get("page_size"))
	}
	// Negative prices are real on Agile (overnight plunge pricing) and must
	// survive decoding rather than being clamped.
	if rates[2].ValueIncVATPence != -1.26 {
		t.Errorf("negative slot lost: got %v", rates[2].ValueIncVATPence)
	}
	wantFrom := time.Date(2026, 9, 23, 21, 30, 0, 0, time.UTC)
	if !rates[0].ValidFrom.Equal(wantFrom) {
		t.Errorf("ValidFrom = %v, want %v", rates[0].ValidFrom, wantFrom)
	}
}

func TestFetchAgileRates_Errors(t *testing.T) {
	if _, _, err := fetchWithStub(t, "not-json", http.StatusOK); err == nil {
		t.Error("malformed JSON should error")
	}
	if _, _, err := fetchWithStub(t, `{"results":[]}`, http.StatusOK); err == nil {
		t.Error("empty results should error")
	}
	if _, _, err := fetchWithStub(t, `{}`, http.StatusNotFound); err == nil {
		t.Error("HTTP 404 should error")
	}
	badTime := `{"results":[{"value_inc_vat":1,"value_exc_vat":1,"valid_from":"bogus","valid_to":"bogus"}]}`
	if _, _, err := fetchWithStub(t, badTime, http.StatusOK); err == nil {
		t.Error("bad timestamps should error")
	}
}

func TestAgileRateAt(t *testing.T) {
	mk := func(h, m int, v float64) AgileRate {
		return AgileRate{
			ValueIncVATPence: v,
			ValidFrom:        time.Date(2026, 9, 23, h, m, 0, 0, time.UTC),
			ValidTo:          time.Date(2026, 9, 23, h, m+30, 0, 0, time.UTC),
		}
	}
	rates := []AgileRate{mk(21, 30, 29.49), mk(21, 0, 29.45), mk(20, 30, -1.26)}

	at := func(h, m int) (AgileRate, bool) {
		return AgileRateAt(rates, time.Date(2026, 9, 23, h, m, 0, 0, time.UTC))
	}

	if r, ok := at(21, 45); !ok || r.ValueIncVATPence != 29.49 {
		t.Errorf("21:45 -> %v/%v, want 29.49/true", r.ValueIncVATPence, ok)
	}
	// Boundary: ValidFrom inclusive.
	if r, ok := at(21, 30); !ok || r.ValueIncVATPence != 29.49 {
		t.Errorf("21:30 boundary -> %v/%v, want 29.49/true", r.ValueIncVATPence, ok)
	}
	// Boundary: ValidTo exclusive.
	if r, ok := at(22, 0); ok {
		t.Errorf("22:00 should miss (ValidTo exclusive), got %v", r.ValueIncVATPence)
	}
	if _, ok := AgileRateAt(nil, time.Now()); ok {
		t.Error("empty curve should report no slot")
	}
}

func TestAgileCurveBounds(t *testing.T) {
	mk := func(v float64) AgileRate {
		return AgileRate{ValueIncVATPence: v}
	}
	curve := []AgileRate{mk(29.49), mk(-1.26), mk(54.10), mk(12.0)}
	lo, hi, ok := AgileCurveBounds(curve)
	if !ok {
		t.Fatal("non-empty curve should report bounds")
	}
	if lo != -1.26 {
		t.Errorf("lo = %v, want -1.26", lo)
	}
	if hi != 54.10 {
		t.Errorf("hi = %v, want 54.10", hi)
	}
	if _, _, ok := AgileCurveBounds(nil); ok {
		t.Error("empty curve should report no bounds")
	}
	if lo, hi, ok := AgileCurveBounds([]AgileRate{mk(7.5)}); !ok || lo != 7.5 || hi != 7.5 {
		t.Errorf("single slot -> lo=%v hi=%v ok=%v, want 7.5/7.5/true", lo, hi, ok)
	}
}
