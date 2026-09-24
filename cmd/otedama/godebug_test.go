// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package main

import (
	"runtime/debug"
	"strings"
	"testing"
)

// TestDefaultGODEBUG_KeepsGo124Baseline guards godebug_go124.go. go.mod
// declares `go 1.23` for CI's sake, and without that file a Go 1.24+ build
// quietly falls back to Go 1.23's defaults (post-quantum TLS key exchange off,
// sub-1024-bit RSA keys accepted) with nothing else failing. The test binary
// for package main is built with the package's //go:debug lines, so its
// DefaultGODEBUG is the one the otedama binary gets.
//
// On Go 1.23 none of these settings exist and the file is excluded by its
// build constraint, so there is nothing to guard and the test passes.
func TestDefaultGODEBUG_KeepsGo124Baseline(t *testing.T) {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		t.Skip("no build info in this test binary")
	}
	var defaults string
	for _, s := range info.Settings {
		if s.Key == "DefaultGODEBUG" {
			defaults = s.Value
		}
	}
	set := strings.Split(defaults, ",")
	// The pre-1.24 values of the runtime settings Go 1.24 changed
	// (src/internal/godebugs/table.go, Changed: 24).
	for _, reverted := range []string{
		"tlsmlkem=0", "rsa1024min=0", "x509rsacrt=0",
		"x509usepolicies=0", "multipathtcp=0", "randseednop=0",
	} {
		for _, kv := range set {
			if kv == reverted {
				t.Errorf("DefaultGODEBUG has %s, so the binary is on the Go 1.23 baseline; "+
					"is cmd/otedama/godebug_go124.go missing? (DefaultGODEBUG=%q)", reverted, defaults)
			}
		}
	}
}
