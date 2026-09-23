// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
package rates

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Pool-share-of-hashrate awareness (RESEARCH_IMPROVEMENTS Cat 4 #7):
// the public mining-pool distribution lets the engine nudge the user when
// the configured pool holds a dangerously large share of the network.
// Bahrani & Weinberg (arXiv:2309.06847, cited in THREAT_MODEL) show a pool
// at ~38.2% of hashrate can run *undetectable* selfish mining — withholding
// blocks at a profit with no observable signal — and heavy concentration
// also weakens pool-failure resilience. Data comes from mempool.space's
// public REST API; no API key and no new dependency (ADR-003/005 kept).

// poolShareURL is mempool.space's one-week mining-pool distribution
// endpoint: per-pool block counts plus the network total.
const poolShareURL = "https://mempool.space/api/v1/mining/pools/1w"

// PoolShareWarnThreshold is the network-share fraction at or above which the
// engine warns. 0.30 sits below the ~38.2% undetectable-selfish-mining
// onset while still catching only genuinely concentrated pools — a nudge
// toward decentralisation, not an alarm.
const PoolShareWarnThreshold = 0.30

// PoolShare is one pool's network-hashrate share over the trailing window.
type PoolShare struct {
	// Name is the pool's public name (e.g. "Foundry USA") as reported by
	// the distribution source — useful for logs because the configured
	// hostname and the public name often differ.
	Name string
	// Share is the fraction of network blocks the pool found over the
	// window (0–1), i.e. its approximate hashrate share.
	Share float64
}

type miningPool struct {
	Name       string `json:"name"`
	Slug       string `json:"slug"`
	Link       string `json:"link"`
	BlockCount int    `json:"blockCount"`
}

type poolsResponse struct {
	Pools      []miningPool `json:"pools"`
	BlockCount int          `json:"blockCount"`
}

var poolShareHTTP = &http.Client{Timeout: 10 * time.Second}

// FetchPoolNetworkShare looks up which public mining pool a configured
// pool hostname belongs to and returns its network-hashrate share. The
// boolean is false when the hostname cannot be matched to a known pool —
// private/self-hosted pools, new pools, and pools the source does not
// track all land here, and callers should stay silent rather than nag.
func FetchPoolNetworkShare(ctx context.Context, poolHost string) (PoolShare, bool, error) {
	return fetchPoolShare(ctx, poolShareHTTP, poolShareURL, poolHost)
}

func fetchPoolShare(ctx context.Context, client *http.Client, endpoint, poolHost string) (PoolShare, bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, http.NoBody)
	if err != nil {
		return PoolShare{}, false, fmt.Errorf("poolshare: build request: %w", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		return PoolShare{}, false, fmt.Errorf("poolshare: fetch: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return PoolShare{}, false, fmt.Errorf("poolshare: HTTP %d", resp.StatusCode)
	}
	var pr poolsResponse
	if err := json.NewDecoder(resp.Body).Decode(&pr); err != nil {
		return PoolShare{}, false, fmt.Errorf("poolshare: decode: %w", err)
	}
	if pr.BlockCount <= 0 || len(pr.Pools) == 0 {
		return PoolShare{}, false, fmt.Errorf("poolshare: empty distribution")
	}
	best := -1
	for i := range pr.Pools {
		if poolHostMatches(poolHost, pr.Pools[i]) &&
			(best < 0 || pr.Pools[i].BlockCount > pr.Pools[best].BlockCount) {
			best = i
		}
	}
	if best < 0 {
		return PoolShare{}, false, nil
	}
	return PoolShare{
		Name:  pr.Pools[best].Name,
		Share: float64(pr.Pools[best].BlockCount) / float64(pr.BlockCount),
	}, true, nil
}

// poolHostMatches reports whether a configured pool hostname plausibly
// identifies pool p: any hostname label (minus the TLD) matching the pool's
// normalised name, slug, or link-domain label. Substring rules require
// ≥5 runes so generic labels like "pool" or "stratum" cannot false-match
// (e.g. "pool.btc.com" must not match "antpool").
func poolHostMatches(host string, p miningPool) bool {
	for _, u := range hostLabels(host) {
		for _, a := range poolAliases(p) {
			if labelMatch(u, a) {
				return true
			}
		}
	}
	return false
}

// hostLabels returns the normalised hostname labels below the TLD:
// "solo.ckpool.org" → {"solo", "ckpool"}, "public-pool.io" → {"publicpool"},
// "us-east.stratum.braiins.com" → {"useast", "stratum", "braiins"}.
func hostLabels(host string) []string {
	host = strings.ToLower(strings.TrimSpace(host))
	// Strip a trailing :port if present (parseHost may leave host:port).
	if i := strings.LastIndexByte(host, ':'); i > 0 {
		host = host[:i]
	}
	parts := strings.Split(host, ".")
	if len(parts) > 1 {
		parts = parts[:len(parts)-1] // drop TLD
	}
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if n := normToken(p); n != "" {
			out = append(out, n)
		}
	}
	return out
}

// poolAliases is the normalised identity set of a pool: its display name,
// slug, and every sub-TLD label of its homepage link.
func poolAliases(p miningPool) []string {
	out := []string{normToken(p.Name), normToken(p.Slug)}
	link := strings.TrimPrefix(strings.TrimPrefix(p.Link, "https://"), "http://")
	return append(out, hostLabels(link)...)
}

func labelMatch(u, a string) bool {
	switch {
	case len(u) < 4 || len(a) < 4:
		return false
	case u == a:
		return true
	case len(u) >= 5 && strings.Contains(a, u):
		return true
	case len(a) >= 5 && strings.Contains(u, a):
		return true
	}
	return false
}

// normToken lowercases and strips everything that is not [a-z0-9], so
// "Public Pool", "public-pool", and "publicpool" all compare equal.
func normToken(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}
