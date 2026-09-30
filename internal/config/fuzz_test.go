// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
//
// Property test for numeric environment-variable resolution. Env
// values are arbitrary operator-controlled strings; the contract is:
// a value that strconv.ParseFloat accepts is applied to the matching
// field with OriginEnv recorded, and every non-empty value it rejects
// produces exactly one EnvWarnings entry and leaves the field at its
// prior layer's value. The numericEnvVars table drives both paths, so
// the two can never disagree about which keys are numeric.
package config

import (
	"math"
	"strconv"
	"strings"
	"testing"
)

// numericField extracts the Config field and Origin a numericEnvVars
// key controls, mirroring each entry's apply target.
func numericField(key string) (val func(*Config) float64, org func(*Origins) ValueOrigin) {
	switch key {
	case "OTEDAMA_ARBITRATION_HYSTERESIS_PCT":
		return func(c *Config) float64 { return c.ArbitrationHysteresisPct },
			func(o *Origins) ValueOrigin { return o.ArbitrationHysteresisPct }
	case "OTEDAMA_MIN_YIELD_SATS_PER_SEC":
		return func(c *Config) float64 { return c.MinYieldSatsPerSec },
			func(o *Origins) ValueOrigin { return o.MinYieldSatsPerSec }
	case "OTEDAMA_CURTAIL_BELOW_BTC_USD":
		return func(c *Config) float64 { return c.CurtailBelowBTCUSD },
			func(o *Origins) ValueOrigin { return o.CurtailBelowBTCUSD }
	case "OTEDAMA_POWER_WATTS":
		return func(c *Config) float64 { return c.PowerWatts },
			func(o *Origins) ValueOrigin { return o.PowerWatts }
	case "OTEDAMA_ELECTRICITY_PRICE_PER_KWH":
		return func(c *Config) float64 { return c.ElectricityPricePerKWh },
			func(o *Origins) ValueOrigin { return o.ElectricityPricePerKWh }
	}
	return nil, nil
}

func FuzzResolveNumericEnv(f *testing.F) {
	f.Add(0, "1.5")
	f.Add(1, "not-a-number")
	f.Add(2, "")
	f.Add(3, "NaN")
	f.Add(4, "300,5") // comma decimal typo
	f.Add(0, "1e999") // overflows float64
	f.Fuzz(func(t *testing.T, keyIdx int, val string) {
		// Fuzz input is one numeric key at a time so the warning count
		// and per-field origin assertions stay exact.
		keys := numericEnvVars
		i := keyIdx % len(keys)
		if i < 0 {
			i = -i
		}
		key := keys[i].key
		env := map[string]string{key: val}

		warnings := EnvWarnings(env)
		_, parseErr := strconv.ParseFloat(val, 64)
		switch {
		case val == "":
			if len(warnings) != 0 {
				t.Fatalf("empty %s produced warnings %v", key, warnings)
			}
		case parseErr != nil:
			if len(warnings) != 1 || !strings.Contains(warnings[0], key) {
				t.Fatalf("malformed %s=%q produced warnings %v (want exactly one naming %s)",
					key, val, warnings, key)
			}
		case len(warnings) != 0:
			t.Fatalf("valid %s=%q produced warnings %v", key, val, warnings)
		}

		cfg, o := ResolveWithOrigins(Config{}, env, FlagValues{})
		getVal, getOrg := numericField(key)
		if getVal == nil {
			t.Fatalf("no field mapping for %s", key)
		}
		if parseErr == nil && val != "" {
			want, _ := strconv.ParseFloat(val, 64)
			got := getVal(&cfg)
			if math.Float64bits(got) != math.Float64bits(want) {
				t.Fatalf("%s=%q applied %v, want %v", key, val, got, want)
			}
			if getOrg(&o) != OriginEnv {
				t.Fatalf("%s=%q parsed but origin is %v, want env", key, val, getOrg(&o))
			}
		} else if getOrg(&o) == OriginEnv {
			t.Fatalf("unparseable %s=%q recorded env origin", key, val)
		}
	})
}
