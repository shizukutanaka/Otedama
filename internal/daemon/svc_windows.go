// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
//go:build windows

package daemon

import (
	"context"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
)

// IsWindowsService reports whether the current process was launched by the
// Windows Service Control Manager (rather than an interactive console).
// Detection failure is conservatively treated as "not a service".
func IsWindowsService() bool {
	isSvc, err := svc.IsWindowsService()
	return err == nil && isSvc
}

// RunWindowsService performs the SCM handshake every Windows service binary
// must complete: register the service with StartServiceCtrlDispatcher (via
// svc.Run), report StartPending → Running → StopPending → Stopped, and drive
// run's context cancellation on SCM Stop/Shutdown so the engine shuts down
// gracefully. Returns run's exit code once the service stops.
//
// Without this handshake a service registered via `sc.exe create` always
// fails to start: SCM kills the process with error 1053
// (ERROR_SERVICE_START_TIMEOUT) because it never calls
// StartServiceCtrlDispatcher.
func RunWindowsService(name string, run func(ctx context.Context) int) (int, error) {
	h := &serviceHandler{run: run}
	if err := svc.Run(name, h); err != nil {
		return 0, err
	}
	return h.code, nil
}

type serviceHandler struct {
	run  func(ctx context.Context) int
	code int
}

// Execute implements svc.Handler. It starts run on a cancellable context,
// reports Running accepting Stop/Shutdown, then either relays graceful-stop
// requests as ctx cancellation or observes run exiting on its own.
func (h *serviceHandler) Execute(_ []string, r <-chan svc.ChangeRequest, s chan<- svc.Status) (bool, uint32) {
	s <- svc.Status{State: svc.StartPending}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan int, 1)
	go func() { done <- h.run(ctx) }()
	s <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case c := <-r:
			switch c.Cmd {
			case svc.Interrogate:
				s <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				s <- svc.Status{State: svc.StopPending}
				cancel()
				h.code = <-done
				s <- stoppedStatus(h.code)
				return false, 0
			}
		case h.code = <-done:
			s <- stoppedStatus(h.code)
			return false, 0
		}
	}
}

// stoppedStatus maps run's exit code onto an SCM Stopped status: a non-zero
// exit is reported as a service-specific error so SCM event logging shows the
// real exit code instead of a generic failure.
func stoppedStatus(code int) svc.Status {
	if code == 0 {
		return svc.Status{State: svc.Stopped}
	}
	return svc.Status{
		State:                   svc.Stopped,
		Win32ExitCode:           uint32(windows.ERROR_SERVICE_SPECIFIC_ERROR),
		ServiceSpecificExitCode: uint32(code),
	}
}
