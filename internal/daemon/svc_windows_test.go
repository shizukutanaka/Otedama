// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
//go:build windows

package daemon

import (
	"context"
	"testing"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
)

// exercise runs Execute against synthetic SCM channels, feeding drive the
// request channel once the handler is live, and returns the exit code plus
// every status the handler emitted.
func exercise(t *testing.T, run func(ctx context.Context) int, drive func(r chan<- svc.ChangeRequest)) (int, []svc.Status) {
	t.Helper()
	h := &serviceHandler{run: run}
	r := make(chan svc.ChangeRequest, 8)
	s := make(chan svc.Status, 16)
	done := make(chan struct{})
	go func() {
		h.Execute(nil, r, s)
		close(done)
	}()
	if drive != nil {
		drive(r)
	}
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("serviceHandler.Execute did not return")
	}
	close(s)
	var states []svc.Status
	for st := range s {
		states = append(states, st)
	}
	return h.code, states
}

func TestServiceHandler_StopCancelsContext(t *testing.T) {
	ctxDone := make(chan struct{})
	code, states := exercise(t, func(ctx context.Context) int {
		<-ctx.Done()
		close(ctxDone)
		return 0
	}, func(r chan<- svc.ChangeRequest) {
		// Wait for the Running status so Stop isn't consumed before the
		// handler is accepting control requests.
		time.Sleep(100 * time.Millisecond)
		r <- svc.ChangeRequest{Cmd: svc.Stop, CurrentStatus: svc.Status{State: svc.Running}}
	})
	select {
	case <-ctxDone:
	default:
		t.Fatal("SCM Stop did not cancel the run context")
	}
	if code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}
	var sawRunning, sawStopPending, sawStopped bool
	for _, st := range states {
		switch st.State {
		case svc.Running:
			sawRunning = true
		case svc.StopPending:
			sawStopPending = true
		case svc.Stopped:
			sawStopped = true
		}
	}
	if !sawRunning || !sawStopPending || !sawStopped {
		t.Fatalf("status sequence missing transitions: %+v", states)
	}
}

func TestServiceHandler_RunExitsOnOwn(t *testing.T) {
	code, states := exercise(t, func(ctx context.Context) int { return 42 }, nil)
	if code != 42 {
		t.Fatalf("exit code = %d, want 42", code)
	}
	var last svc.Status
	for _, st := range states {
		last = st
	}
	if last.State != svc.Stopped || last.ServiceSpecificExitCode != 42 {
		t.Fatalf("final status = %+v, want Stopped with code 42", last)
	}
}

func TestStoppedStatus_MapsExitCode(t *testing.T) {
	if got := stoppedStatus(0); got.State != svc.Stopped || got.Win32ExitCode != 0 {
		t.Fatalf("stoppedStatus(0) = %+v", got)
	}
	got := stoppedStatus(78)
	if got.Win32ExitCode != uint32(windows.ERROR_SERVICE_SPECIFIC_ERROR) || got.ServiceSpecificExitCode != 78 {
		t.Fatalf("stoppedStatus(78) = %+v", got)
	}
}
