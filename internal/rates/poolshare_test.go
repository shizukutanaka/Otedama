// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
package rates

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const poolsFixture = `{"pools":[
	{"poolId":112,"name":"Foundry USA","link":"https://foundrydigital.com","blockCount":236,"slug":"foundryusa"},
	{"poolId":45,"name":"AntPool","link":"https://www.antpool.com","blockCount":204,"slug":"antpool"},
	{"poolId":3,"name":"CKPool","link":"https://ckpool.org","blockCount":12,"slug":"ckpool"},
	{"poolId":8,"name":"Public Pool","link":"https://public-pool.io","blockCount":4,"slug":"publicpool"}
],"blockCount":500,"lastEstimatedHashrate":700000000000}`

func fixtureServer(t *testing.T, body string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestFetchPoolShare_MatchAndShare(t *testing.T) {
	srv := fixtureServer(t, poolsFixture)
	for _, tc := range []struct {
		host      string
		wantFound bool
		wantName  string
		wantShare float64
	}{
		{"public-pool.io", true, "Public Pool", 0.008},
		{"stratum.public-pool.io", true, "Public Pool", 0.008},
		{"solo.ckpool.org", true, "CKPool", 0.024},
		{"stratum.antpool.com", true, "AntPool", 0.408},
		{"mining.antpool.com:3333", true, "AntPool", 0.408},
		{"foundrydigital.com", true, "Foundry USA", 0.472},
		{"my-vps.example.com", false, "", 0},
		{"pool.btc.com", false, "", 0}, // "pool" label too generic to match antpool
		{"localhost:3333", false, "", 0},
	} {
		ps, found, err := fetchPoolShare(context.Background(), srv.Client(), srv.URL, tc.host)
		if err != nil {
			t.Fatalf("%s: %v", tc.host, err)
		}
		if found != tc.wantFound {
			t.Errorf("%s: found=%v want %v", tc.host, found, tc.wantFound)
			continue
		}
		if found && (ps.Name != tc.wantName || ps.Share != tc.wantShare) {
			t.Errorf("%s: got %+v want name=%s share=%v", tc.host, ps, tc.wantName, tc.wantShare)
		}
	}
}

func TestFetchPoolShare_HTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	t.Cleanup(srv.Close)
	_, _, err := fetchPoolShare(context.Background(), srv.Client(), srv.URL, "antpool.com")
	if err == nil {
		t.Fatal("expected error on non-200")
	}
}

func TestFetchPoolShare_EmptyDistribution(t *testing.T) {
	srv := fixtureServer(t, `{"pools":[],"blockCount":0}`)
	_, _, err := fetchPoolShare(context.Background(), srv.Client(), srv.URL, "antpool.com")
	if err == nil {
		t.Fatal("expected error on empty distribution")
	}
}

func TestHostLabels(t *testing.T) {
	got := hostLabels("us-east.stratum.braiins.com")
	want := []string{"useast", "stratum", "braiins"}
	if len(got) != len(want) {
		t.Fatalf("got %v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v want %v", got, want)
		}
	}
	if l := hostLabels("host:3333"); len(l) != 1 || l[0] != "host" {
		t.Fatalf("port strip: %v", l)
	}
}

func TestFetchPoolShare_HugeBodyBounded(t *testing.T) {
	entry := `{"poolId":1,"name":"P","link":"https://p.example","blockCount":1,"slug":"p"}`
	big := `{"pools":[` + entry + strings.Repeat(","+entry, 4096) + `],"blockCount":4096}`
	srv := fixtureServer(t, big)
	if _, _, err := fetchPoolShare(context.Background(), srv.Client(), srv.URL, "p.example"); err == nil {
		t.Fatal("oversized response should error under the body cap")
	}
}
