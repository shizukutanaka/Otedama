// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
package rates

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

const carbonFixture = `{"data":[{
	"from":"2026-09-23T09:30Z",
	"to":"2026-09-23T10:00Z",
	"intensity":{"forecast":58,"actual":71,"index":"low"}
}]}`

func TestFetchCarbonIntensity_Decode(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, carbonFixture)
	}))
	t.Cleanup(srv.Close)
	ci, err := fetchCarbonIntensity(context.Background(), srv.Client(), srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if ci.Forecast != 58 || ci.Actual != 71 || ci.Index != "low" {
		t.Errorf("bad decode: %+v", ci)
	}
	if ci.From.Hour() != 9 || ci.From.Minute() != 30 {
		t.Errorf("bad From: %v", ci.From)
	}
}

func TestFetchCarbonIntensity_Errors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	t.Cleanup(srv.Close)
	if _, err := fetchCarbonIntensity(context.Background(), srv.Client(), srv.URL); err == nil {
		t.Fatal("expected error on non-200")
	}

	srv2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"data":[]}`)
	}))
	t.Cleanup(srv2.Close)
	if _, err := fetchCarbonIntensity(context.Background(), srv2.Client(), srv2.URL); err == nil {
		t.Fatal("expected error on empty data")
	}
}
