// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package version provides build-time version information for Otedama.
//
// The variables in this package are set by the Go linker during build via
// ldflags. See the Makefile for the actual injection. When built without
// ldflags (for example, with `go build` directly), the defaults in this file
// are used.
package version

import (
	"fmt"
	"runtime"
)

// These variables are populated at build time via ldflags. They are declared
// as var (not const) so that the linker can set them. The defaults allow
// local development builds without requiring ldflags to be specified.
var (
	// Version is the semantic version of this build, e.g. "v3.0.0-alpha.1".
	// For unreleased development builds, it may contain suffixes like
	// "-dev" or "-dirty".
	Version = "v3.0.0-alpha.0-dev"

	// Commit is the short git commit hash of this build, e.g. "a1b2c3d".
	// For builds without git metadata, it is "unknown".
	Commit = "unknown"

	// BuildDate is the UTC timestamp of this build in RFC 3339 format,
	// e.g. "2026-04-18T12:00:00Z". For builds without a set build date,
	// it is "unknown".
	BuildDate = "unknown"
)

// Info holds a structured summary of the build information.
//
// Use Info instead of formatting the raw variables directly, as Info may be
// extended with additional fields in the future (such as build flags or
// platform detail) while preserving backward compatibility.
type Info struct {
	Version   string `json:"version"`
	Commit    string `json:"commit"`
	BuildDate string `json:"build_date"`
	GoVersion string `json:"go_version"`
	Platform  string `json:"platform"`
}

// Get returns the build information for the current binary.
//
// The returned Info is a snapshot; subsequent modifications to the package
// variables (which should not occur in practice) are not reflected.
func Get() Info {
	return Info{
		Version:   Version,
		Commit:    Commit,
		BuildDate: BuildDate,
		GoVersion: runtime.Version(),
		Platform:  fmt.Sprintf("%s/%s", runtime.GOOS, runtime.GOARCH),
	}
}

// String returns a human-readable single-line summary of the build info,
// suitable for display in CLI --version output.
//
// The format is:
//
//	otedama <Version> (<Commit>) built <BuildDate> with <GoVersion> for <Platform>
//
// This format is stable; tools that parse CLI output may rely on it.
func (i Info) String() string {
	return fmt.Sprintf(
		"otedama %s (%s) built %s with %s for %s",
		i.Version, i.Commit, i.BuildDate, i.GoVersion, i.Platform,
	)
}
