// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
//go:build windows

package main

import (
	"context"
	"fmt"
	"io"

	"github.com/shizukutanaka/Otedama/internal/daemon"
)

// maybeRunAsWindowsService returns (exitCode, true) when the process was
// launched by the Windows Service Control Manager, having run the service
// under SCM control; it returns (_, false) for every ordinary invocation so
// `otedama run` from a console is unaffected.
//
// The distinction matters: a binary registered via `sc.exe create` must call
// StartServiceCtrlDispatcher quickly or SCM kills it with error 1053 — the
// service previously could never start. Under SCM, Stop/Shutdown requests
// cancel the ctx handed to cmdRun, driving the same graceful shutdown path
// SIGINT/SIGTERM drive on Unix.
func maybeRunAsWindowsService(args []string, stdout, stderr io.Writer) (int, bool) {
	if !daemon.IsWindowsService() {
		return 0, false
	}
	code, err := daemon.RunWindowsService(daemon.ServiceName, func(ctx context.Context) int {
		return cmdRun(ctx, args, stdout, stderr)
	})
	if err != nil {
		fmt.Fprintf(stderr, "otedama: windows service: %v\n", err)
		return exitRuntime, true
	}
	return code, true
}
