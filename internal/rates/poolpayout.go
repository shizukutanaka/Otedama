// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
package rates

// Pool minimum-payout awareness (RESEARCH_IMPROVEMENTS Cat 11 #3):
// balances below a pool's minimum payout stay trapped with the operator.
// Stratum exposes no threshold field, so the doctor check surfaces the
// documented minimum for pools we can identify (FetchPoolNetworkShare)
// and nudges the operator to verify the rest.

import "strings"

// MinPayout is a pool's documented minimum payout and the rail it
// applies to.
type MinPayout struct {
	// Sats is the minimum payout in satoshis.
	Sats int64
	// Rail names the payout rail the minimum applies to ("on-chain",
	// "Lightning", ...). Pools can differ per rail; the detail names the
	// one the figure documents.
	Rail string
	// Note records where the figure came from (docs page/policy name)
	// so reviewers can re-verify it.
	Note string
}

// minPayouts maps the normalised pool name (as returned by
// mempool.space — lowercase, non-alphanumeric stripped) to its
// documented minimum payout. Only entries we can cite are included;
// anything absent yields the "verify with the pool" advisory instead of
// a guessed number.
var minPayouts = map[string]MinPayout{
	// OCEAN (ocean.xyz) — pays sub-threshold balances over Lightning;
	// the 0.00001 BTC LN minimum is documented in its payout policy and
	// cited by RESEARCH_IMPROVEMENTS Cat 11 item 3.
	"ocean":    {Sats: 1_000, Rail: "Lightning", Note: "OCEAN payout policy"},
	"oceanxyz": {Sats: 1_000, Rail: "Lightning", Note: "OCEAN payout policy"},
}

// LookupMinPayout returns the documented minimum payout for a pool
// identified by FetchPoolNetworkShare's Name, or false when the pool is
// not in the curated table (callers should advise verification rather
// than print a guess).
func LookupMinPayout(poolName string) (MinPayout, bool) {
	var b strings.Builder
	for _, r := range strings.ToLower(poolName) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	mp, ok := minPayouts[b.String()]
	return mp, ok
}
