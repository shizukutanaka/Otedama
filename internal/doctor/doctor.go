// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package doctor provides the "otedama doctor" self-diagnosis command.
//
// # Why this exists
//
// When a user reports "it doesn't work", the first 80% of support
// effort is finding out *what* doesn't work. Is the Bitcoin address
// malformed? Is the pool unreachable? Is there no GPU detected? Is
// the config file in the wrong location?
//
// Doctor answers all of these in one command:
//
//	$ otedama doctor
//	[✓] Configuration file: /home/alice/.config/otedama/config.yaml
//	[✓] Bitcoin address: bc1qar0···5mdq (valid Bech32)
//	[✓] Data directory: /home/alice/.local/share/otedama (writable, 0700)
//	[✓] Hardware: 8-core CPU (10.5 MH/s estimated)
//	[✓] Pool reachability: stratum+v2://slushpool.com:3336 (42ms)
//	[!] GPU: none detected (hashrate will be 150x lower than GPU+CPU)
//	[✓] Lightning wallet: initialized, fingerprint a3f2b1c4
//	[✓] Network: IPv4 OK, IPv6 not tested
//
//	Summary: 7 passed, 0 failed, 1 warning
//
// # Design
//
// Each check is a Check value with a Name and a Run function. Checks
// are independent and run in parallel where possible. Results are
// aggregated into a Report that prints consistently formatted output
// and exits with code 0 (all good), 1 (warnings), or 2 (failures).
package doctor

import (
	"context"
	"fmt"
	"io"
	"sync"
	"time"
)

// Status is the outcome of a single check.
type Status int

const (
	// StatusPass means the check succeeded.
	StatusPass Status = iota
	// StatusWarn means the check found a non-fatal issue.
	StatusWarn
	// StatusFail means the check found a blocking issue.
	StatusFail
	// StatusSkip means the check was not applicable.
	StatusSkip
)

func (s Status) symbol() string {
	switch s {
	case StatusPass:
		return "✓"
	case StatusWarn:
		return "!"
	case StatusFail:
		return "✗"
	default:
		return "-"
	}
}

// Result is one check's outcome.
type Result struct {
	Name    string
	Status  Status
	Detail  string // what was checked and how
	Fix     string // how to fix if not passing; blank on success
	Elapsed time.Duration
}

// Check is a single diagnostic probe.
type Check struct {
	Name string
	Run  func(ctx context.Context) Result
}

// Report summarises all Check results.
type Report struct {
	Results  []Result
	Duration time.Duration
}

// ExitCode returns 0 if all checks passed or skipped, 1 if any warned,
// 2 if any failed. Suitable for `os.Exit(report.ExitCode())`.
func (r *Report) ExitCode() int {
	has := struct {
		warn, fail bool
	}{}
	for _, res := range r.Results {
		switch res.Status {
		case StatusWarn:
			has.warn = true
		case StatusFail:
			has.fail = true
		}
	}
	switch {
	case has.fail:
		return 2
	case has.warn:
		return 1
	default:
		return 0
	}
}

// Print writes the report to w in a human-readable format.
func (r *Report) Print(w io.Writer) {
	var passed, warned, failed, skipped int
	for _, res := range r.Results {
		fmt.Fprintf(w, "[%s] %s: %s\n", res.Status.symbol(), res.Name, res.Detail)
		if res.Fix != "" {
			fmt.Fprintf(w, "    → fix: %s\n", res.Fix)
		}
		switch res.Status {
		case StatusPass:
			passed++
		case StatusWarn:
			warned++
		case StatusFail:
			failed++
		case StatusSkip:
			skipped++
		}
	}
	fmt.Fprintln(w)
	fmt.Fprintf(w, "Summary: %d passed, %d failed, %d warning",
		passed, failed, warned)
	if warned != 1 {
		fmt.Fprint(w, "s")
	}
	if skipped > 0 {
		fmt.Fprintf(w, ", %d skipped", skipped)
	}
	fmt.Fprintf(w, " (completed in %s)\n", r.Duration.Round(time.Millisecond))
}

// Runner executes a set of checks and produces a Report.
type Runner struct {
	Checks []Check
}

// Run executes all checks concurrently and returns the Report.
// The order of results in the Report matches the order of Checks.
func (r *Runner) Run(ctx context.Context) *Report {
	start := time.Now()
	results := make([]Result, len(r.Checks))
	var wg sync.WaitGroup

	for i, c := range r.Checks {
		wg.Add(1)
		go func(idx int, chk Check) {
			defer wg.Done()
			t0 := time.Now()
			res := chk.Run(ctx)
			res.Name = chk.Name
			res.Elapsed = time.Since(t0)
			results[idx] = res
		}(i, c)
	}
	wg.Wait()
	return &Report{Results: results, Duration: time.Since(start)}
}
