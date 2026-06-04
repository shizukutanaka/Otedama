// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package version

import (
	"encoding/json"
	"runtime"
	"strings"
	"testing"
)

func TestGet_ReturnsCurrentBuildInfo(t *testing.T) {
	info := Get()

	// Version, Commit, and BuildDate come from package variables. In tests
	// without ldflags, they hold the defaults. We verify they are non-empty
	// rather than asserting specific values, because the values differ
	// between local dev builds and CI release builds.
	if info.Version == "" {
		t.Error("Version must not be empty")
	}
	if info.Commit == "" {
		t.Error("Commit must not be empty")
	}
	if info.BuildDate == "" {
		t.Error("BuildDate must not be empty")
	}

	// GoVersion and Platform are derived from runtime and must match.
	if got, want := info.GoVersion, runtime.Version(); got != want {
		t.Errorf("GoVersion: got %q, want %q", got, want)
	}
	wantPlatform := runtime.GOOS + "/" + runtime.GOARCH
	if got := info.Platform; got != wantPlatform {
		t.Errorf("Platform: got %q, want %q", got, wantPlatform)
	}
}

func TestInfo_String_ContainsAllFields(t *testing.T) {
	info := Info{
		Version:   "v3.0.0-alpha.1",
		Commit:    "abc1234",
		BuildDate: "2026-04-18T12:00:00Z",
		GoVersion: "go1.22.3",
		Platform:  "linux/amd64",
	}

	got := info.String()

	// Every field must appear in the formatted string. We assert substring
	// presence rather than exact format to allow format tweaks without
	// breaking tests, while still catching accidental omissions.
	for _, want := range []string{
		info.Version, info.Commit, info.BuildDate, info.GoVersion, info.Platform,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("String() = %q, missing field %q", got, want)
		}
	}

	// The output must start with "otedama " to be identifiable in logs and
	// --version output. This is a stable contract documented in the package.
	if !strings.HasPrefix(got, "otedama ") {
		t.Errorf("String() = %q, must start with %q", got, "otedama ")
	}
}

func TestInfo_JSONRoundTrip(t *testing.T) {
	original := Info{
		Version:   "v3.0.0",
		Commit:    "deadbee",
		BuildDate: "2026-04-18T12:00:00Z",
		GoVersion: "go1.22.3",
		Platform:  "darwin/arm64",
	}

	data, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}

	var decoded Info
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Unmarshal failed: %v", err)
	}

	if decoded != original {
		t.Errorf("roundtrip mismatch:\ngot  %+v\nwant %+v", decoded, original)
	}
}

func TestInfo_JSON_UsesSnakeCase(t *testing.T) {
	info := Info{
		Version:   "v3.0.0",
		BuildDate: "2026-04-18T12:00:00Z",
		GoVersion: "go1.22.3",
	}

	data, err := json.Marshal(info)
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}

	// JSON output is consumed by external tools and APIs. Field naming
	// conventions are part of the API contract. We verify snake_case
	// because that is the convention across Otedama's external APIs.
	got := string(data)
	for _, want := range []string{
		`"build_date"`, `"go_version"`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("JSON output %q missing %q", got, want)
		}
	}

	// Conversely, camelCase field names must not appear.
	for _, unwanted := range []string{
		`"buildDate"`, `"goVersion"`,
	} {
		if strings.Contains(got, unwanted) {
			t.Errorf("JSON output %q contains forbidden camelCase %q", got, unwanted)
		}
	}
}

// BenchmarkGet measures the cost of the Get function. It is not a correctness
// test but establishes a performance baseline. If this benchmark slows down
// significantly in future changes, it signals accidental complexity.
func BenchmarkGet(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = Get()
	}
}

func BenchmarkInfo_String(b *testing.B) {
	info := Get()
	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = info.String()
	}
}
