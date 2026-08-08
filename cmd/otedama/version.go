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
	jsonOut := fs.Bool("json", false, "Output as JSON.")
	if ok, code := parseSubcommandFlags(fs, args, stdout, stderr); !ok {
		return code
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
