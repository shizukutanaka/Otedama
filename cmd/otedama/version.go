// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"

	"github.com/shizukutanaka/Otedama/internal/version"
)

func cmdVersion(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("version", flag.ContinueOnError)
	fs.SetOutput(stderr)
	jsonOut := fs.Bool("json", false, "Output as JSON.")
	if err := fs.Parse(args); err != nil {
		return exitUsage
	}
	info := version.Get()
	if *jsonOut {
		enc := json.NewEncoder(stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(info); err != nil {
			fmt.Fprintf(stderr, "otedama: version: %v\n", err)
			return exitRuntime
		}
	} else {
		fmt.Fprintln(stdout, info.String())
	}
	return exitOK
}
