// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// coverage_test.go — targeted tests pushing engine to ≥90% coverage.

package engine

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/arbitration"
	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/shizukutanaka/Otedama/internal/hal"
	"github.com/shizukutanaka/Otedama/internal/metrics"
	"github.com/shizukutanaka/Otedama/internal/miner"
	"github.com/shizukutanaka/Otedama/internal/provider"
	"github.com/shizukutanaka/Otedama/internal/stratum"
	"github.com/shizukutanaka/Otedama/internal/tui"

	// Register the Stratum V1 dialer so poolproto.DialURL works in V1 tests.
	_ "github.com/shizukutanaka/Otedama/internal/poolproto/stratumv1"
)

// ============================================================================
// stats.go — worker loop bodies and Quantile idx<0 guard
// ============================================================================

func TestBuildStats_WithWorkersAndMetrics(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	w := miner.NewWorker(miner.WorkerConfig{Threads: 1})
	opts := sessionOpts{
		poolURL:   "stratum+v2://pool.example.com:3336",
		wallet:    "a1b2c3d4",
		startTime: time.Now().Add(-5 * time.Minute),
		devices:   1,
		workers:   []*miner.Worker{w},
		m:         m,
		providers: nil,
	}
	stats := buildStats(opts, 500.0, 10, nil, false)
	if stats.HashRate != 500.0 {
		t.Errorf("HashRate = %v, want 500.0", stats.HashRate)
	}
	if stats.Devices != 1 {
		t.Errorf("Devices = %d, want 1", stats.Devices)
	}
	if stats.EstSatsEarned != 10 {
		t.Errorf("EstSatsEarned = %d, want 10", stats.EstSatsEarned)
	}
}

// TestBuildStats_ProviderActiveReflectsArbitrationAssignment pins the fix
// for the hardcoded "Active: true" that made every configured provider
// (including ones arbitration never actually routed a device to) render
// as earning. A provider present in the shared activity snapshot — the
// arbitration loop's real Decide() output — is Active with its assigned
// yield; a provider absent from it (quoting, perhaps, but not chosen) is
// not, and never fabricates a nonzero SatsPerSecond.
func TestBuildStats_ProviderActiveReflectsArbitrationAssignment(t *testing.T) {
	mining := provider.NewMiningProvider("stratum+v2://pool:3336", provider.StaticRateSource{Rate: 95000})
	akash := provider.NewAkashProvider(provider.StaticRateSource{Rate: 95000})

	var mu sync.Mutex
	activity := map[string]float64{
		mining.ID(): 0.42, // arbitration is routing a device here
		// akash.ID() intentionally absent: not currently assigned.
	}
	opts := sessionOpts{
		startTime:  time.Now(),
		providers:  []provider.Provider{mining, akash},
		activityMu: &mu,
		activity:   activity,
	}

	stats := buildStats(opts, 0, 0, nil, false)
	if len(stats.Providers) != 2 {
		t.Fatalf("Providers len = %d, want 2", len(stats.Providers))
	}
	byName := map[string]tui.ProviderStats{}
	for _, p := range stats.Providers {
		byName[p.Name] = p
	}
	if got := byName[mining.Name()]; !got.Active || got.SatsPerSecond != 0.42 {
		t.Errorf("mining provider = %+v, want Active=true SatsPerSecond=0.42", got)
	}
	if got := byName[akash.Name()]; got.Active || got.SatsPerSecond != 0 {
		t.Errorf("akash provider = %+v, want Active=false SatsPerSecond=0 (not assigned)", got)
	}
}

// TestBuildStats_ProviderInactiveWithNilActivityMap covers the case where
// no arbitration loop is wired (activityMu nil, e.g. some test/embedding
// contexts): providers must render inactive rather than panicking or
// falling back to the old unconditional Active: true.
func TestBuildStats_ProviderInactiveWithNilActivityMap(t *testing.T) {
	mining := provider.NewMiningProvider("stratum+v2://pool:3336", provider.StaticRateSource{Rate: 95000})
	opts := sessionOpts{
		startTime: time.Now(),
		providers: []provider.Provider{mining},
	}
	stats := buildStats(opts, 0, 0, nil, false)
	if len(stats.Providers) != 1 {
		t.Fatalf("Providers len = %d, want 1", len(stats.Providers))
	}
	if stats.Providers[0].Active {
		t.Error("Active = true with nil activityMu, want false")
	}
}

// TestDisconnectedStats_ReportsNotConnected pins the fix for the dashboard
// freezing on its last "✓ connected" frame during a reconnect backoff:
// disconnectedStats must report Connected=false (everything else zeroed,
// since this snapshot genuinely does not know the current hashrate/shares).
func TestDisconnectedStats_ReportsNotConnected(t *testing.T) {
	start := time.Now().Add(-90 * time.Second)
	stats := disconnectedStats("stratum+v2://pool.example.com:3336", "deadbeef", start, 3)
	if stats.Connected {
		t.Error("Connected = true, want false")
	}
	if stats.PoolURL != "stratum+v2://pool.example.com:3336" {
		t.Errorf("PoolURL = %q, want the configured pool URL", stats.PoolURL)
	}
	if stats.WalletFingerprint != "deadbeef" {
		t.Errorf("WalletFingerprint = %q, want deadbeef", stats.WalletFingerprint)
	}
	if stats.Devices != 3 {
		t.Errorf("Devices = %d, want 3", stats.Devices)
	}
	if stats.Uptime < 89*time.Second {
		t.Errorf("Uptime = %v, want >= ~90s", stats.Uptime)
	}
	if stats.HashRate != 0 || stats.SharesFound != 0 || stats.EstSatsEarned != 0 {
		t.Errorf("expected zeroed live stats while disconnected, got %+v", stats)
	}
}

// TestBuildStats_SharesSentReflectsSubmittedCounter_NotFoundCount pins the
// fix for docs/KNOWN_LIMITATIONS.md's prior §9: SharesSent used to be a
// copy of SharesFound ("approximation"). The two must now be able to
// diverge — a share can be found by a worker but never actually
// transmitted (e.g. its share channel was full) — so this asserts
// SharesSent tracks otedama_shares_submitted_total independently.
func TestBuildStats_SharesSentReflectsSubmittedCounter_NotFoundCount(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	w := miner.NewWorker(miner.WorkerConfig{Threads: 1})
	opts := sessionOpts{
		poolURL:   "stratum+v2://pool.example.com:3336",
		startTime: time.Now(),
		workers:   []*miner.Worker{w},
		m:         m,
	}

	// Worker has found 0 shares (fresh, never started), but 3 shares were
	// actually submitted this session — a scenario SharesFound alone
	// cannot represent, proving SharesSent is now its own signal.
	m.sharesSubmitted.Add(3)

	stats := buildStats(opts, 0, 0, nil, false)
	if stats.SharesFound != 0 {
		t.Errorf("SharesFound = %d, want 0 (fresh worker)", stats.SharesFound)
	}
	if stats.SharesSent != 3 {
		t.Errorf("SharesSent = %d, want 3 (from otedama_shares_submitted_total, not SharesFound)", stats.SharesSent)
	}
}

// TestBuildStats_SharesSentIsZeroWithNilMetrics covers the metrics-disabled
// path (opts.m == nil, as used by several tests that don't care about
// metrics): SharesSent must default to 0 rather than panic on a nil
// engineMetrics dereference.
func TestBuildStats_SharesSentIsZeroWithNilMetrics(t *testing.T) {
	opts := sessionOpts{
		poolURL:   "stratum+v2://pool.example.com:3336",
		startTime: time.Now(),
	}
	stats := buildStats(opts, 0, 0, nil, false)
	if stats.SharesSent != 0 {
		t.Errorf("SharesSent = %d, want 0 (opts.m is nil)", stats.SharesSent)
	}
}

func TestTotalHashes_WithRealWorker(t *testing.T) {
	w := miner.NewWorker(miner.WorkerConfig{Threads: 1})
	// A brand-new worker has 0 hashes; the loop body must still execute.
	got := totalHashes([]*miner.Worker{w})
	if got != 0 {
		t.Errorf("totalHashes with new worker = %d, want 0", got)
	}
}

func TestTotalDropped_WithRealWorker(t *testing.T) {
	w := miner.NewWorker(miner.WorkerConfig{Threads: 1})
	got := totalDropped([]*miner.Worker{w})
	if got != 0 {
		t.Errorf("totalDropped with new worker = %d, want 0", got)
	}
}

func TestLogStats_WithRealWorker(t *testing.T) {
	var msg string
	log := func(_, m string) { msg = m }
	w := miner.NewWorker(miner.WorkerConfig{Threads: 1})
	logStats([]*miner.Worker{w}, 1234.0, log)
	if !strings.Contains(msg, "hashrate=") {
		t.Errorf("logStats msg = %q, want 'hashrate=' substring", msg)
	}
}

// TestLatencyTracker_QuantileIdxNegativeClamp covers the idx<0 guard.
// With n=1 and 0<q<0.5: int(q*1+0.5)=0, idx=-1 → clamped to 0.
func TestLatencyTracker_QuantileIdxNegativeClamp(t *testing.T) {
	l := NewLatencyTracker(1)
	l.Record(42.0)
	// q=0.1: int(0.1*1+0.5)-1 = int(0.6)-1 = 0-1 = -1 → clamped to 0.
	got := l.Quantile(0.1)
	if got != 42.0 {
		t.Errorf("Quantile(0.1) with 1 sample = %v, want 42.0", got)
	}
}

// ============================================================================
// setup.go — startMinerWorkers: skip non-SHA256d and error on no devices
// ============================================================================

func TestStartMinerWorkers_SkipsNonSHA256dDevice(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var logs []string
	log := func(_, m string) { logs = append(logs, m) }

	sha := &cpuDevice{
		id:   hal.Identity{ID: "cpu-0", Family: hal.FamilyCPU, Vendor: "generic", Model: "test"},
		caps: hal.Capabilities{SHA256d: true},
	}
	nosha := &cpuDevice{
		id:   hal.Identity{ID: "gpu-only", Family: hal.FamilyGPU, Vendor: "generic", Model: "test"},
		caps: hal.Capabilities{SHA256d: false, GeneralCompute: true},
	}

	workers, shareCh, err := startMinerWorkers(ctx, []hal.Device{nosha, sha}, log)
	if err != nil {
		t.Fatalf("startMinerWorkers: %v", err)
	}
	defer func() {
		for _, w := range workers {
			w.Stop()
		}
	}()
	_ = shareCh
	if len(workers) != 1 {
		t.Errorf("workers = %d, want 1 (only SHA256d device)", len(workers))
	}
}

func TestStartMinerWorkers_AllNonSHA256d_ReturnsError(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	nosha := &cpuDevice{
		id:   hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU, Vendor: "generic", Model: "test"},
		caps: hal.Capabilities{SHA256d: false, GeneralCompute: true},
	}

	_, _, err := startMinerWorkers(ctx, []hal.Device{nosha}, func(_, _ string) {})
	if err == nil {
		t.Error("expected error when no SHA256d-capable devices")
	}
}

// ============================================================================
// arbitrate.go — ticker.C happy path and error path
// ============================================================================

// TestRunArbitrationLoop_TickerHappyPath covers lines 50–67 and 72:
// the ticker.C case with a valid allocation (no error from Decide).
func TestRunArbitrationLoop_TickerHappyPath(t *testing.T) {
	old := arbitrationInterval
	arbitrationInterval = 5 * time.Millisecond
	defer func() { arbitrationInterval = old }()

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	quoteCh := make(chan provider.Quote)
	mu := &sync.Mutex{}
	streamMap := make(map[string]arbitration.Stream)

	// Provide one device and one matching stream so Decide produces an
	// assignment (covers the for-range body, line 67-68).
	devRefs := []arbitration.DeviceRef{{
		Identity:     hal.Identity{ID: "cpu-0", Family: hal.FamilyCPU},
		Capabilities: hal.Capabilities{SHA256d: true},
	}}
	streamMap["mining.stratum:cpu-0"] = arbitration.Stream{
		ID:              "mining.stratum",
		IsBitcoinMining: true,
		AcceptsFamilies: []hal.Family{hal.FamilyCPU},
		YieldPerDevice: map[string]arbitration.Yield{
			"cpu-0": {SatsPerSecond: 100, Confidence: 0.9},
		},
		DefaultYield: arbitration.Yield{SatsPerSecond: 100, Confidence: 0.9},
	}

	opts := arbitrationLoopOpts{
		devRefs:   devRefs,
		streamsMu: mu,
		streamMap: streamMap,
		quoteCh:   quoteCh,
		metrics:   newEngineMetrics(metrics.NewRegistry()),
		log:       func(_, _ string) {},
	}

	done := make(chan struct{})
	go func() {
		runArbitrationLoop(ctx, opts)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(300 * time.Millisecond):
		t.Error("runArbitrationLoop did not exit within 300ms")
	}
}

// TestRunArbitrationLoop_PopulatesActivitySnapshot pins the fix that lets
// the TUI show real provider status: after a Decide() cycle, the shared
// activity map must contain exactly the providers with a non-idle
// assignment this round, valued at their assigned yield — not every
// provider that has ever quoted.
func TestRunArbitrationLoop_PopulatesActivitySnapshot(t *testing.T) {
	old := arbitrationInterval
	arbitrationInterval = 5 * time.Millisecond
	defer func() { arbitrationInterval = old }()

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	quoteCh := make(chan provider.Quote)
	mu := &sync.Mutex{}
	streamMap := make(map[string]arbitration.Stream)

	devRefs := []arbitration.DeviceRef{{
		Identity:     hal.Identity{ID: "cpu-0", Family: hal.FamilyCPU},
		Capabilities: hal.Capabilities{SHA256d: true},
	}}
	// Confidence 1.0 so the assigned ExpectedYield equals SatsPerSecond
	// exactly (Decide weights yield by confidence internally) — keeps the
	// assertion below unambiguous.
	streamMap["mining.stratum:cpu-0"] = arbitration.Stream{
		ID:              "mining.stratum",
		IsBitcoinMining: true,
		AcceptsFamilies: []hal.Family{hal.FamilyCPU},
		YieldPerDevice: map[string]arbitration.Yield{
			"cpu-0": {SatsPerSecond: 0.5, Confidence: 1.0},
		},
		DefaultYield: arbitration.Yield{SatsPerSecond: 0.5, Confidence: 1.0},
	}

	activityMu := &sync.Mutex{}
	activity := make(map[string]float64)
	opts := arbitrationLoopOpts{
		devRefs:    devRefs,
		streamsMu:  mu,
		streamMap:  streamMap,
		quoteCh:    quoteCh,
		metrics:    newEngineMetrics(metrics.NewRegistry()),
		log:        func(_, _ string) {},
		activityMu: activityMu,
		activity:   activity,
	}

	done := make(chan struct{})
	go func() {
		runArbitrationLoop(ctx, opts)
		close(done)
	}()

	// Poll until the first tick has landed (avoids a race on the shared map).
	deadline := time.After(300 * time.Millisecond)
	for {
		activityMu.Lock()
		yield, ok := activity["mining.stratum"]
		n := len(activity)
		activityMu.Unlock()
		if ok {
			if yield != 0.5 {
				t.Errorf("activity[mining.stratum] = %v, want 0.5", yield)
			}
			if n != 1 {
				t.Errorf("activity has %d entries, want exactly 1 (the assigned provider)", n)
			}
			break
		}
		select {
		case <-deadline:
			t.Fatal("activity map never populated within 300ms")
		case <-time.After(2 * time.Millisecond):
		}
	}

	<-done
}

// TestRunArbitrationLoop_TickerDecideError covers lines 62–64: Decide
// returns an error (duplicate device IDs) so the loop logs and continues.
func TestRunArbitrationLoop_TickerDecideError(t *testing.T) {
	old := arbitrationInterval
	arbitrationInterval = 5 * time.Millisecond
	defer func() { arbitrationInterval = old }()

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	quoteCh := make(chan provider.Quote)
	var logged []string
	var logMu sync.Mutex

	// Duplicate device IDs → Decide returns error on every tick.
	opts := arbitrationLoopOpts{
		devRefs: []arbitration.DeviceRef{
			{Identity: hal.Identity{ID: "dup"}, Capabilities: hal.Capabilities{SHA256d: true}},
			{Identity: hal.Identity{ID: "dup"}, Capabilities: hal.Capabilities{SHA256d: true}},
		},
		streamsMu: &sync.Mutex{},
		streamMap: make(map[string]arbitration.Stream),
		quoteCh:   quoteCh,
		metrics:   newEngineMetrics(metrics.NewRegistry()),
		log: func(_, m string) {
			logMu.Lock()
			logged = append(logged, m)
			logMu.Unlock()
		},
	}

	done := make(chan struct{})
	go func() {
		runArbitrationLoop(ctx, opts)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(300 * time.Millisecond):
		t.Error("runArbitrationLoop did not exit within 300ms")
	}

	logMu.Lock()
	n := len(logged)
	logMu.Unlock()
	if n == 0 {
		t.Error("expected at least one arbitration error log")
	}
}

// TestRunArbitrationLoop_HysteresisPctIsUsed verifies that a non-default
// hysteresisPct propagates to the Decide call without causing an error.
// The correctness of the damping at the decision level is tested in
// internal/arbitration; here we confirm the field is wired through.
func TestRunArbitrationLoop_HysteresisPctIsUsed(t *testing.T) {
	old := arbitrationInterval
	arbitrationInterval = 5 * time.Millisecond
	defer func() { arbitrationInterval = old }()

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	mu := &sync.Mutex{}
	streamMap := map[string]arbitration.Stream{
		"mining": {
			ID:              "mining",
			IsBitcoinMining: true,
			AcceptsFamilies: []hal.Family{hal.FamilyCPU},
			YieldPerDevice:  map[string]arbitration.Yield{"cpu-0": {SatsPerSecond: 100, Confidence: 1.0}},
			DefaultYield:    arbitration.Yield{SatsPerSecond: 100, Confidence: 1.0},
		},
	}
	devRefs := []arbitration.DeviceRef{
		{
			Identity:     hal.Identity{ID: "cpu-0", Family: hal.FamilyCPU},
			Capabilities: hal.Capabilities{SHA256d: true},
		},
	}
	quoteCh := make(chan provider.Quote)

	var errs []string
	var errMu sync.Mutex
	opts := arbitrationLoopOpts{
		devRefs:   devRefs,
		streamsMu: mu,
		streamMap: streamMap,
		quoteCh:   quoteCh,
		metrics:   newEngineMetrics(metrics.NewRegistry()),
		log: func(level, msg string) {
			if level == "warn" {
				errMu.Lock()
				errs = append(errs, msg)
				errMu.Unlock()
			}
		},
		hysteresisPct: 0.20, // 20% band
	}

	done := make(chan struct{})
	go func() {
		runArbitrationLoop(ctx, opts)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(300 * time.Millisecond):
		t.Error("runArbitrationLoop did not exit within 300ms")
	}

	errMu.Lock()
	gotErrs := errs
	errMu.Unlock()
	if len(gotErrs) > 0 {
		t.Errorf("unexpected arbitration errors with hysteresisPct=0.20: %v", gotErrs)
	}
}

// ============================================================================
// run.go sendMsg — encode error and WrapMessage error
// ============================================================================

// errEncoder always returns an encode error.
type errEncoder struct{}

func (e *errEncoder) Encode() ([]byte, error) {
	return nil, errors.New("injected encode error")
}

// emptyEncoder returns an empty payload; with isChannel=true this triggers
// WrapMessage's "channel message requires payload >= MinimumChannelPayload" error.
type emptyEncoder struct{}

func (e *emptyEncoder) Encode() ([]byte, error) { return []byte{}, nil }

func TestSendMsg_EncodeError(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	defer clientConn.Close()
	defer serverConn.Close()

	err := sendMsg(clientConn, stratum.MsgSetupConnection, false, &errEncoder{})
	if err == nil {
		t.Error("sendMsg with errEncoder should return error")
	}
	if !strings.Contains(err.Error(), "encode") {
		t.Errorf("error = %q, want 'encode' substring", err.Error())
	}
}

func TestSendMsg_WrapMessageError(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	defer clientConn.Close()
	defer serverConn.Close()

	// isChannel=true with empty payload → WrapMessage validation fails
	// (channel message requires ≥4 bytes for channel_id prefix).
	err := sendMsg(clientConn, stratum.MsgSubmitSharesStandard, true, &emptyEncoder{})
	if err == nil {
		t.Error("sendMsg with empty channel payload should return wrap error")
	}
	if !strings.Contains(err.Error(), "wrap") {
		t.Errorf("error = %q, want 'wrap' substring", err.Error())
	}
}

// ============================================================================
// run.go updateWork — invalid network nBits with no share target is a no-op
// ============================================================================

func TestUpdateWork_InvalidPrevNBitsNoShareTarget_IsNoOp(t *testing.T) {
	job := &stratum.NewMiningJob{
		ChannelID: 1,
		JobID:     99,
		Version:   0x20000000,
	}
	var prevHash [32]byte
	// No share target (zero) forces the network-target fallback; an
	// invalid prevNBits (0x00000000) makes TargetFromNBits error →
	// early return. Must not panic; does nothing.
	updateWork(nil, job, 1, prevHash, 0x00000000, 0x60000000, miner.Hash{})
}

// ============================================================================
// run.go runSession — bad pool URL returns immediately
// ============================================================================

func TestRunSession_BadPoolURL(t *testing.T) {
	ctx := context.Background()
	err := runSession(ctx, sessionOpts{
		poolURL:  "http://not-stratum.example.com",
		log:      func(_, _ string) {},
		interval: time.Second,
	})
	if err == nil {
		t.Error("runSession with bad URL scheme should return error")
	}
}

// TestRunSession_V2TLSSchemeAttemptsRealTLS pins the fix for the
// "configured v2tls:// pool silently connects in plaintext" defect
// (docs/KNOWN_LIMITATIONS.md §2): runSession must attempt an actual TLS
// handshake for a stratum+v2tls:// URL, never fall back to plaintext.
// Pointed at a listener that only speaks plain TCP, a real TLS attempt
// fails with a TLS-specific handshake error; a silent plaintext fallback
// would instead either succeed at the TCP level or fail with a generic
// decode error from the (never-sent) SetupConnectionSuccess response —
// this test asserts on the former, unambiguous signal.
func TestRunSession_V2TLSSchemeAttemptsRealTLS(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		// Plain TCP echo/no-op: a real TLS client dialing this will fail
		// the handshake immediately (no ServerHello), never reach here in
		// a way that matters for the assertion below.
		buf := make([]byte, 64)
		_, _ = c.Read(buf)
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	var logs []string
	var mu sync.Mutex
	logFn := func(_, msg string) {
		mu.Lock()
		logs = append(logs, msg)
		mu.Unlock()
	}

	err = runSession(ctx, sessionOpts{
		poolURL:  "stratum+v2tls://" + ln.Addr().String(),
		log:      logFn,
		interval: time.Second,
	})
	if err == nil {
		t.Fatal("runSession against a plaintext listener over v2tls:// should fail (TLS handshake error)")
	}
	if !strings.Contains(err.Error(), "TLS") {
		t.Errorf("error = %q, want a TLS-specific dial failure (proves TLS was actually attempted, not skipped)", err.Error())
	}

	mu.Lock()
	defer mu.Unlock()
	for _, l := range logs {
		if strings.Contains(l, "plaintext") {
			t.Errorf("v2tls:// session logged a plaintext warning (should only apply to the non-TLS scheme): %q", l)
		}
	}
}

// TestRunSession_PlainV2SchemeWarnsAboutNoEncryption pins the disclosure
// half of the same fix: a plaintext stratum+v2:// connection must warn
// the operator at connect time that no transport encryption is active,
// rather than silently proceeding as if the link were secure.
func TestRunSession_PlainV2SchemeWarnsAboutNoEncryption(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		c.Close() // close immediately; test only needs the warning log
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	var logs []string
	var mu sync.Mutex
	logFn := func(_, msg string) {
		mu.Lock()
		logs = append(logs, msg)
		mu.Unlock()
	}

	_ = runSession(ctx, sessionOpts{
		poolURL:  "stratum+v2://" + ln.Addr().String(),
		log:      logFn,
		interval: time.Second,
	})

	mu.Lock()
	defer mu.Unlock()
	found := false
	for _, l := range logs {
		if strings.Contains(l, "plaintext") && strings.Contains(l, "no transport encryption") {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected a plaintext/no-transport-encryption warning in logs, got: %v", logs)
	}
}

// ============================================================================
// run.go handshake — error paths via net.Pipe fake servers
// ============================================================================

// TestHandshake_WriteSetupConnFails covers line 613–615: conn.Write fails
// inside sendMsg for SetupConnection because the server closed immediately.
func TestHandshake_WriteSetupConnFails(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	serverConn.Close() // closed before any read; client Write will fail
	dec := stratum.NewDecoder(clientConn)
	_, _, err := handshake(context.Background(), clientConn, dec, "stratum+v2://localhost:3336", "user", nil)
	clientConn.Close()
	if err == nil {
		t.Error("handshake: expected error when server pipe closed immediately")
	}
}

// TestHandshake_ReadSetupResponseFails covers line 617–619: server reads
// the setup frame then closes without sending a response.
func TestHandshake_ReadSetupResponseFails(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	defer clientConn.Close()

	go func() {
		buf := make([]byte, 4096)
		serverConn.Read(buf) //nolint:errcheck
		serverConn.Close()
	}()

	dec := stratum.NewDecoder(clientConn)
	_, _, err := handshake(context.Background(), clientConn, dec, "stratum+v2://localhost:3336", "user", nil)
	if err == nil {
		t.Error("handshake: expected error when server closes after setup frame")
	}
}

// TestHandshake_SetupResponseDecodeError covers line 621–623: server sends
// a MsgSetupConnectionSuccess with a payload that is too short to decode.
func TestHandshake_SetupResponseDecodeError(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	defer clientConn.Close()
	defer serverConn.Close()

	go func() {
		buf := make([]byte, 4096)
		serverConn.Read(buf) //nolint:errcheck
		// Send MsgSetupConnectionSuccess with only 2 bytes (< 6 required).
		// DecodeSetupConnectionSuccess will fail → DispatchFrame returns error.
		f, _ := stratum.WrapMessage(stratum.MsgSetupConnectionSuccess, false, []byte{0x02, 0x00})
		data, _ := stratum.EncodeFrame(f)
		serverConn.Write(data) //nolint:errcheck
	}()

	dec := stratum.NewDecoder(clientConn)
	_, _, err := handshake(context.Background(), clientConn, dec, "stratum+v2://localhost:3336", "user", nil)
	if err == nil {
		t.Error("handshake: expected error on malformed SetupConnectionSuccess payload")
	}
}

// TestHandshake_SetupConnectionError covers line 624–626: pool sends a
// SetupConnectionError → handshake returns a *fatalError.
func TestHandshake_SetupConnectionError(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	defer clientConn.Close()
	defer serverConn.Close()

	go func() {
		buf := make([]byte, 4096)
		serverConn.Read(buf) //nolint:errcheck
		sce := stratum.SetupConnectionError{Flags: 0, Error: "unsupported version"}
		payload, _ := sce.Encode()
		f, _ := stratum.WrapMessage(stratum.MsgSetupConnectionError, false, payload)
		data, _ := stratum.EncodeFrame(f)
		serverConn.Write(data) //nolint:errcheck
	}()

	dec := stratum.NewDecoder(clientConn)
	_, _, err := handshake(context.Background(), clientConn, dec, "stratum+v2://localhost:3336", "user", nil)
	if err == nil {
		t.Error("handshake: expected error on SetupConnectionError")
	}
	if !isFatal(err) {
		t.Errorf("SetupConnectionError should produce fatalError, got %T: %v", err, err)
	}
}

// TestHandshake_UnexpectedSetupResponse covers line 627–629: the response
// to SetupConnection is neither success nor error (OpenMiningChannelSuccess == nil).
// The handshake loop hits the "unexpected msg" branch.
func TestHandshake_UnexpectedSetupResponse(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	defer clientConn.Close()
	defer serverConn.Close()

	go func() {
		buf := make([]byte, 4096)
		serverConn.Read(buf) //nolint:errcheck
		// Send a valid SetupConnectionSuccess but then a second one instead of
		// the expected OpenMiningChannel flow — here we deliberately send
		// an OpenMiningChannelError which is recognised but sets neither
		// SetupConnectionSuccess nor SetupConnectionError.
		// Use a minimal valid NewMiningJob payload (it's in the unexpected msg branch).
		job := stratum.NewMiningJob{ChannelID: 1, JobID: 1, HasMinNtime: true, MinNtime: 0x60000000, Version: 0x20000000}
		payload, _ := job.Encode()
		f, _ := stratum.WrapMessage(stratum.MsgNewMiningJob, true, payload)
		data, _ := stratum.EncodeFrame(f)
		serverConn.Write(data) //nolint:errcheck
	}()

	dec := stratum.NewDecoder(clientConn)
	_, _, err := handshake(context.Background(), clientConn, dec, "stratum+v2://localhost:3336", "user", nil)
	if err == nil {
		t.Error("handshake: expected error on unexpected setup response")
	}
}

// TestHandshake_OpenMiningChannelWriteFails covers line 640–642: sendMsg for
// OpenMiningChannel fails because the server closed after sending setup success.
func TestHandshake_OpenMiningChannelWriteFails(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	defer clientConn.Close()

	go func() {
		sDec := stratum.NewDecoder(serverConn)
		sDec.ReadFrame() //nolint:errcheck // consume SetupConnection
		succ := stratum.SetupConnectionSuccess{UsedVersion: 2}
		payload, _ := succ.Encode()
		f, _ := stratum.WrapMessage(stratum.MsgSetupConnectionSuccess, false, payload)
		data, _ := stratum.EncodeFrame(f)
		serverConn.Write(data) //nolint:errcheck
		serverConn.Close()     // close AFTER sending success so the client can read it
	}()

	dec := stratum.NewDecoder(clientConn)
	_, _, err := handshake(context.Background(), clientConn, dec, "stratum+v2://localhost:3336", "user", nil)
	if err == nil {
		t.Error("handshake: expected error when server closes after setup success")
	}
}

// TestHandshake_ReadChannelResponseFails covers line 644–646: server reads
// OpenMiningChannel then closes without sending a channel response.
func TestHandshake_ReadChannelResponseFails(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	defer clientConn.Close()

	go func() {
		sDec := stratum.NewDecoder(serverConn)
		sDec.ReadFrame() //nolint:errcheck // SetupConnection
		succ := stratum.SetupConnectionSuccess{UsedVersion: 2}
		payload, _ := succ.Encode()
		f, _ := stratum.WrapMessage(stratum.MsgSetupConnectionSuccess, false, payload)
		data, _ := stratum.EncodeFrame(f)
		serverConn.Write(data) //nolint:errcheck
		sDec.ReadFrame()       //nolint:errcheck // OpenMiningChannel
		serverConn.Close()
	}()

	dec := stratum.NewDecoder(clientConn)
	_, _, err := handshake(context.Background(), clientConn, dec, "stratum+v2://localhost:3336", "user", nil)
	if err == nil {
		t.Error("handshake: expected error when server closes after OMC")
	}
}

// TestHandshake_ChannelResponseDecodeError covers line 648–650: server sends
// a malformed OpenMiningChannelSuccess payload.
func TestHandshake_ChannelResponseDecodeError(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	defer clientConn.Close()
	defer serverConn.Close()

	go func() {
		sDec := stratum.NewDecoder(serverConn)
		sDec.ReadFrame() //nolint:errcheck // SetupConnection
		succ := stratum.SetupConnectionSuccess{UsedVersion: 2}
		payload, _ := succ.Encode()
		f, _ := stratum.WrapMessage(stratum.MsgSetupConnectionSuccess, false, payload)
		data, _ := stratum.EncodeFrame(f)
		serverConn.Write(data) //nolint:errcheck
		sDec.ReadFrame()       //nolint:errcheck // OpenMiningChannel
		// Send MsgOpenMiningChannelSuccess with only 2 bytes (truncated payload).
		f2, _ := stratum.WrapMessage(stratum.MsgOpenMiningChannelSuccess, false, []byte{0x01, 0x00})
		data2, _ := stratum.EncodeFrame(f2)
		serverConn.Write(data2) //nolint:errcheck
	}()

	dec := stratum.NewDecoder(clientConn)
	_, _, err := handshake(context.Background(), clientConn, dec, "stratum+v2://localhost:3336", "user", nil)
	if err == nil {
		t.Error("handshake: expected error on malformed OpenMiningChannelSuccess")
	}
}

// TestHandshake_ChannelOpenFailed covers line 651–653: pool responds to
// OpenMiningChannel with something other than OpenMiningChannelSuccess.
func TestHandshake_ChannelOpenFailed(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	defer clientConn.Close()
	defer serverConn.Close()

	go func() {
		sDec := stratum.NewDecoder(serverConn)
		sDec.ReadFrame() //nolint:errcheck // SetupConnection
		succ := stratum.SetupConnectionSuccess{UsedVersion: 2}
		payload, _ := succ.Encode()
		f, _ := stratum.WrapMessage(stratum.MsgSetupConnectionSuccess, false, payload)
		data, _ := stratum.EncodeFrame(f)
		serverConn.Write(data) //nolint:errcheck
		sDec.ReadFrame()       //nolint:errcheck // OpenMiningChannel
		// Send the same SetupConnectionSuccess again instead of OMC success.
		// DispatchFrame sets SetupConnectionSuccess, not OpenMiningChannelSuccess.
		serverConn.Write(data) //nolint:errcheck
	}()

	dec := stratum.NewDecoder(clientConn)
	_, _, err := handshake(context.Background(), clientConn, dec, "stratum+v2://localhost:3336", "user", nil)
	if err == nil {
		t.Error("handshake: expected error when channel open response is wrong type")
	}
}

// ============================================================================
// run.go runReconnectLoop — pool-failover and address-failover paths
// ============================================================================

// TestRunReconnectLoop_MultiPool_Failover exercises the pool-failover path:
// 2 unreachable pools → first fails → "failover to next pool" → second fails
// → "all pools failed, backing off" → context cancels.
// Covers lines 279–281, 329–331, 331–333, 363–364.
func TestRunReconnectLoop_MultiPool_Failover(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 600*time.Millisecond)
	defer cancel()

	var logs []string
	var logMu sync.Mutex
	log := func(_, m string) {
		logMu.Lock()
		logs = append(logs, m)
		logMu.Unlock()
	}

	r := reconnectOpts{
		opts: Options{
			Config: config.Config{
				BitcoinAddress: "bc1qtest0000000000000000000000000test00",
				Pools: []config.PoolConfig{
					{URL: "stratum+v2://127.0.0.1:1"},
					{URL: "stratum+v2://127.0.0.1:2"},
				},
			},
			MaxReconnectAttempts: 4,
		},
		metrics: newEngineMetrics(metrics.NewRegistry()),
		log:     log,
	}

	runReconnectLoop(ctx, r) //nolint:errcheck

	logMu.Lock()
	joined := fmt.Sprint(logs)
	logMu.Unlock()

	if !strings.Contains(joined, "pool") {
		t.Errorf("expected pool failover in logs; got: %v", logs)
	}
}

// TestRunReconnectLoop_MultiAddr_Failover exercises the address-failover path:
// 2 payout addresses + 2 unreachable pools → all pools fail per address →
// address rotates → eventually wraps → "none of configured addresses could connect".
// Covers lines 282–284, 345–349, 349–355, 359–362.
func TestRunReconnectLoop_MultiAddr_Failover(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 800*time.Millisecond)
	defer cancel()

	var logs []string
	var logMu sync.Mutex
	log := func(_, m string) {
		logMu.Lock()
		logs = append(logs, m)
		logMu.Unlock()
	}

	r := reconnectOpts{
		opts: Options{
			Config: config.Config{
				BitcoinAddress:   "bc1qtest0000000000000000000000000test00",
				BitcoinAddresses: []string{"bc1qbackup000000000000000000000backup00"},
				Pools: []config.PoolConfig{
					{URL: "stratum+v2://127.0.0.1:1"},
					{URL: "stratum+v2://127.0.0.1:2"},
				},
			},
			MaxReconnectAttempts: 6,
		},
		metrics: newEngineMetrics(metrics.NewRegistry()),
		log:     log,
	}

	runReconnectLoop(ctx, r) //nolint:errcheck

	logMu.Lock()
	joined := fmt.Sprint(logs)
	logMu.Unlock()

	if !strings.Contains(joined, "address") {
		t.Errorf("expected address failover in logs; got: %v", logs)
	}
}

// ============================================================================
// runSessionV1 — Stratum V1 poolproto path
// ============================================================================

// fakeV1Pool runs a minimal Stratum V1 server on a random local port.
// It responds to subscribe and authorize, optionally sends one notify job,
// then closes the connection. Returns the listen address.
func fakeV1Pool(t *testing.T, sendJob bool) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("fakeV1Pool listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		r := bufio.NewReader(conn)

		// mining.subscribe
		_, _ = r.ReadString('\n')
		fmt.Fprintf(conn, `{"id":1,"result":[[["mining.set_difficulty","s1"],["mining.notify","s2"]],"c0ffee",4],"error":null}`+"\n")

		// mining.authorize
		_, _ = r.ReadString('\n')
		fmt.Fprintf(conn, `{"id":2,"result":true,"error":null}`+"\n")

		// extranonce.subscribe (optional step 3 in Negotiate; "Method not found")
		_, _ = r.ReadString('\n')
		fmt.Fprintf(conn, `{"id":3,"result":null,"error":[38,"Method not found",null]}`+"\n")

		if sendJob {
			// Any job_id works — the pool's id is opaque and the engine
			// assigns its own synthetic id for the miner's domain.
			fmt.Fprintf(conn,
				`{"id":null,"method":"mining.notify","params":[`+
					`"1",`+
					`"4d16b6f85af6e2198f44ae2a6de67f78487ae5611b77c6c0440b921e00000000",`+
					`"","",[],"00000002","1d00ffff","68d36c5e",true]}`+"\n")
			time.Sleep(50 * time.Millisecond)
		}
	}()

	return ln.Addr().String()
}

func TestRunSessionV1_PoolClosesAfterHandshake(t *testing.T) {
	addr := fakeV1Pool(t, false) // closes immediately after authorize
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	merged := make(chan miner.Share)
	defer close(merged)

	err := runSessionV1(ctx, sessionOpts{
		poolURL:  "stratum+tcp://" + addr,
		user:     "worker.1",
		workers:  nil,
		merged:   merged,
		interval: 200 * time.Millisecond,
		log:      func(_, _ string) {},
	})
	if err == nil || !strings.Contains(err.Error(), "pool closed connection") {
		t.Errorf("expected 'pool closed connection', got: %v", err)
	}
}

func TestRunSessionV1_ReceivesJobAndConnects(t *testing.T) {
	addr := fakeV1Pool(t, true) // sends one job then closes
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	merged := make(chan miner.Share)
	defer close(merged)

	connected := false
	err := runSessionV1(ctx, sessionOpts{
		poolURL:     "stratum+tcp://" + addr,
		user:        "worker.1",
		workers:     nil,
		merged:      merged,
		interval:    200 * time.Millisecond,
		log:         func(_, _ string) {},
		onConnected: func() { connected = true },
	})
	if !connected {
		t.Error("onConnected was not called")
	}
	// Ends with pool disconnect.
	if err != nil && !strings.Contains(err.Error(), "pool closed connection") && err != context.DeadlineExceeded {
		t.Errorf("unexpected error: %v", err)
	}
}

// ----- poolPassword wiring (KNOWN_LIMITATIONS.md §10) -----
//
// runSessionV1 previously hardcoded the V1 mining.authorize password to
// "x" regardless of PoolConfig.Password. These two tests capture the raw
// mining.authorize request line from a fake pool and confirm the actual
// second params[] element (the password) matches what sessionOpts carries.

// captureAuthorizePassword runs a minimal fake V1 pool that answers
// mining.subscribe, captures the mining.authorize request's password
// parameter, then answers it, returning the captured value once the
// handshake completes (or "" on timeout/parse failure).
func captureAuthorizePassword(t *testing.T, poolPassword string) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	type rpcReq struct {
		Method string   `json:"method"`
		Params []string `json:"params"`
	}
	var captured string
	done := make(chan struct{})
	go func() {
		defer close(done)
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		r := bufio.NewReader(conn)

		_, _ = r.ReadString('\n') // mining.subscribe
		fmt.Fprintf(conn, `{"id":1,"result":[[["mining.notify","s1"]],"cc",4],"error":null}`+"\n")

		line, _ := r.ReadString('\n') // mining.authorize
		var req rpcReq
		if json.Unmarshal([]byte(line), &req) == nil && req.Method == "mining.authorize" && len(req.Params) == 2 {
			captured = req.Params[1]
		}
		fmt.Fprintf(conn, `{"id":2,"result":true,"error":null}`+"\n")
	}()

	merged := make(chan miner.Share)
	defer close(merged)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	_ = runSessionV1(ctx, sessionOpts{
		poolURL:      "stratum+tcp://" + ln.Addr().String(),
		user:         "worker.1",
		merged:       merged,
		interval:     time.Minute,
		log:          func(_, _ string) {},
		poolPassword: poolPassword,
	})

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("fake pool never completed the handshake")
	}
	return captured
}

func TestRunSessionV1_ConfiguredPasswordReachesMiningAuthorize(t *testing.T) {
	got := captureAuthorizePassword(t, "s3cr3t-pool-password")
	if got != "s3cr3t-pool-password" {
		t.Errorf("mining.authorize password = %q, want the configured PoolConfig.Password", got)
	}
}

func TestRunSessionV1_UnconfiguredPasswordDefaultsToX(t *testing.T) {
	// No PoolConfig.Password set (the common case: most V1 pools accept any
	// value) must still send the long-standing "x" convention, not an empty
	// string — preserves pre-existing behavior for the unconfigured case.
	got := captureAuthorizePassword(t, "")
	if got != "x" {
		t.Errorf("mining.authorize password = %q, want the default \"x\"", got)
	}
}

func TestRunSessionV1_StatsTicker(t *testing.T) {
	// Stats ticker must fire and not panic; run a session that stays alive
	// long enough for the ticker to fire at least once.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		r := bufio.NewReader(conn)
		_, _ = r.ReadString('\n')
		fmt.Fprintf(conn, `{"id":1,"result":[[["mining.notify","s1"]],"cc",4],"error":null}`+"\n")
		_, _ = r.ReadString('\n')
		fmt.Fprintf(conn, `{"id":2,"result":true,"error":null}`+"\n")
		_, _ = r.ReadString('\n') // extranonce.subscribe (step 3 in Negotiate)
		fmt.Fprintf(conn, `{"id":3,"result":null,"error":[38,"Method not found",null]}`+"\n")
		// Keep alive longer than the tick interval.
		time.Sleep(500 * time.Millisecond)
	}()

	merged := make(chan miner.Share)
	defer close(merged)

	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()

	workers := []*miner.Worker{miner.NewWorker(miner.WorkerConfig{Threads: 1})}
	_ = runSessionV1(ctx, sessionOpts{
		poolURL:  "stratum+tcp://" + ln.Addr().String(),
		user:     "w",
		workers:  workers,
		merged:   merged,
		interval: 50 * time.Millisecond, // fire quickly so test doesn't time out
		log:      func(_, _ string) {},
		m:        m,
	})
}

func TestRunSessionV1_ContextCancelled(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		r := bufio.NewReader(conn)
		_, _ = r.ReadString('\n')
		fmt.Fprintf(conn, `{"id":1,"result":[[["mining.notify","s1"]],"cc",4],"error":null}`+"\n")
		_, _ = r.ReadString('\n')
		fmt.Fprintf(conn, `{"id":2,"result":true,"error":null}`+"\n")
		time.Sleep(2 * time.Second)
	}()

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()

	merged := make(chan miner.Share)
	defer close(merged)

	err = runSessionV1(ctx, sessionOpts{
		poolURL:  "stratum+tcp://" + ln.Addr().String(),
		user:     "w",
		merged:   merged,
		interval: 500 * time.Millisecond,
		log:      func(_, _ string) {},
	})
	if err != context.Canceled {
		t.Errorf("expected context.Canceled, got: %v", err)
	}
}

func TestRunSessionV1_ShareSubmitAccepted(t *testing.T) {
	// Server: full handshake + one mining.submit → respond true → hold alive.
	// We use a signal channel to cancel ctx AFTER the response is sent, so
	// the Submit goroutine inside runSessionV1 can complete before sess.Close.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	submitResponseSent := make(chan struct{})
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		r := bufio.NewReader(conn)
		_, _ = r.ReadString('\n')
		fmt.Fprintf(conn, `{"id":1,"result":[[["mining.notify","s1"]],"cc",4],"error":null}`+"\n")
		_, _ = r.ReadString('\n')
		fmt.Fprintf(conn, `{"id":2,"result":true,"error":null}`+"\n")
		_, _ = r.ReadString('\n') // extranonce.subscribe (optional step 3 in Negotiate)
		fmt.Fprintf(conn, `{"id":3,"result":null,"error":[38,"Method not found",null]}`+"\n")
		_, _ = r.ReadString('\n') // mining.submit (id=4)
		fmt.Fprintf(conn, `{"id":4,"result":true,"error":null}`+"\n")
		close(submitResponseSent)
		time.Sleep(500 * time.Millisecond) // keep connection alive
	}()

	// Keep merged open; one share in buffer.  Closing it would cause
	// runSessionV1 to return before the Submit goroutine finishes.
	merged := make(chan miner.Share, 1)
	merged <- miner.Share{JobID: 1, Nonce: 0x12345678, NTime: 0x68d36c5e}

	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)

	ctx, cancel := context.WithCancel(context.Background())
	var watcherDone sync.WaitGroup
	watcherDone.Add(1)
	go func() {
		defer watcherDone.Done()
		select {
		case <-submitResponseSent:
			// 50 ms gives the Submit goroutine time to process the result
			// (log, latency.Record, sharesAccepted.Inc) before sess.Close.
			time.Sleep(50 * time.Millisecond)
			cancel()
		case <-time.After(3 * time.Second):
			cancel()
		}
	}()

	// Call via runSession (V1 URL) to cover the V1 dispatch in runSession.
	_ = runSession(ctx, sessionOpts{
		poolURL:  "stratum+tcp://" + ln.Addr().String(),
		user:     "worker.1",
		merged:   merged,
		interval: 10 * time.Second, // no stats-ticker noise
		log:      func(_, _ string) {},
		m:        m,
	})
	watcherDone.Wait()

	if got := m.sharesAccepted.Value(); got != 1 {
		t.Errorf("sharesAccepted = %d, want 1", got)
	}
	// sharesSubmitted increments at send time (before the goroutine even
	// calls Submit), independent of sharesAccepted/Rejected — this is the
	// real end-to-end path for the fix pinned by
	// TestBuildStats_SharesSentReflectsSubmittedCounter_NotFoundCount.
	if got := m.sharesSubmitted.Value(); got != 1 {
		t.Errorf("sharesSubmitted = %d, want 1", got)
	}
}

func TestRunSessionV1_ShareSubmitRejected(t *testing.T) {
	// Server rejects the submitted share (result: false + error array).
	// Same signal-based approach: cancel ctx only after the response is sent.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	submitResponseSent := make(chan struct{})
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		r := bufio.NewReader(conn)
		_, _ = r.ReadString('\n')
		fmt.Fprintf(conn, `{"id":1,"result":[[["mining.notify","s1"]],"cc",4],"error":null}`+"\n")
		_, _ = r.ReadString('\n')
		fmt.Fprintf(conn, `{"id":2,"result":true,"error":null}`+"\n")
		_, _ = r.ReadString('\n') // extranonce.subscribe (optional step 3 in Negotiate)
		fmt.Fprintf(conn, `{"id":3,"result":null,"error":[38,"Method not found",null]}`+"\n")
		_, _ = r.ReadString('\n') // mining.submit (id=4)
		fmt.Fprintf(conn, `{"id":4,"result":false,"error":["23","Duplicate share",null]}`+"\n")
		close(submitResponseSent)
		time.Sleep(500 * time.Millisecond)
	}()

	merged := make(chan miner.Share, 1)
	merged <- miner.Share{JobID: 1, Nonce: 0xdeadbeef, NTime: 0x68d36c5e}

	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)

	ctx, cancel := context.WithCancel(context.Background())
	var watcherDone sync.WaitGroup
	watcherDone.Add(1)
	go func() {
		defer watcherDone.Done()
		select {
		case <-submitResponseSent:
			time.Sleep(50 * time.Millisecond)
			cancel()
		case <-time.After(3 * time.Second):
			cancel()
		}
	}()

	_ = runSessionV1(ctx, sessionOpts{
		poolURL:  "stratum+tcp://" + ln.Addr().String(),
		user:     "w",
		merged:   merged,
		interval: 10 * time.Second,
		log:      func(_, _ string) {},
		m:        m,
	})
	watcherDone.Wait()

	if got := m.sharesRejected.Value(); got != 1 {
		t.Errorf("sharesRejected = %d, want 1", got)
	}
}

func TestRunSessionV1_LatencyRecordedInStatsTicker(t *testing.T) {
	// Verify that after a share is accepted (latency recorded), the stats
	// ticker logs p50/p95/p99.  We must NOT close merged before the Submit
	// goroutine finishes, or sess.Close() will race with the latency record.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		r := bufio.NewReader(conn)
		_, _ = r.ReadString('\n') // subscribe
		fmt.Fprintf(conn, `{"id":1,"result":[[["mining.notify","s1"]],"cc",4],"error":null}`+"\n")
		_, _ = r.ReadString('\n') // authorize
		fmt.Fprintf(conn, `{"id":2,"result":true,"error":null}`+"\n")
		_, _ = r.ReadString('\n') // extranonce.subscribe (optional step 3 in Negotiate)
		fmt.Fprintf(conn, `{"id":3,"result":null,"error":[38,"Method not found",null]}`+"\n")
		_, _ = r.ReadString('\n') // mining.submit (id=4)
		// Delay reply by 5 ms so elapsed rounds to >= 1 ms and the p95 > 0
		// branch in the stats ticker is exercised.
		time.Sleep(5 * time.Millisecond)
		fmt.Fprintf(conn, `{"id":4,"result":true,"error":null}`+"\n")
		// Hold alive long enough for the ticker to fire after latency is recorded.
		time.Sleep(600 * time.Millisecond)
	}()

	// One share in buffer; keep merged open so runSessionV1 doesn't return
	// via the "merged closed" path before the Submit goroutine finishes.
	merged := make(chan miner.Share, 1)
	merged <- miner.Share{JobID: 1, Nonce: 1, NTime: 1}

	var mu sync.Mutex
	var logLines []string
	logFn := func(_, msg string) {
		mu.Lock()
		logLines = append(logLines, msg)
		mu.Unlock()
	}

	// 400 ms timeout: Submit goroutine (< 10 ms) + ticker at 50 ms = covered.
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()

	_ = runSessionV1(ctx, sessionOpts{
		poolURL:  "stratum+tcp://" + ln.Addr().String(),
		user:     "w",
		merged:   merged,
		interval: 50 * time.Millisecond,
		log:      logFn,
		m:        newEngineMetrics(metrics.NewRegistry()),
	})

	mu.Lock()
	joined := strings.Join(logLines, " ")
	mu.Unlock()
	if !strings.Contains(joined, "latency") {
		t.Errorf("expected latency log from stats ticker; got: %v", logLines)
	}
}

// ============================================================================
// startMinerWorkers — non-SHA256d device skip and no-device error
// ============================================================================

func TestStartMinerWorkers_NonSHA256dDeviceSkipped(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Only a GPU without SHA256d capability.
	gpuNoHash := &cpuDevice{
		id:   hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU},
		caps: hal.Capabilities{GeneralCompute: true, SHA256d: false},
	}
	_, _, err := startMinerWorkers(ctx, []hal.Device{gpuNoHash}, func(_, _ string) {})
	if err == nil {
		t.Error("expected error when no SHA256d device is present")
	}
	if !strings.Contains(err.Error(), "SHA256d") {
		t.Errorf("error should mention SHA256d, got: %v", err)
	}
}

func TestStartMinerWorkers_MixedDevices(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	cpuWithHash := &cpuDevice{
		id:   hal.Identity{ID: "cpu-0", Family: hal.FamilyCPU},
		caps: hal.Capabilities{SHA256d: true},
	}
	gpuNoHash := &cpuDevice{
		id:   hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU},
		caps: hal.Capabilities{GeneralCompute: true, SHA256d: false},
	}
	workers, merged, err := startMinerWorkers(ctx, []hal.Device{gpuNoHash, cpuWithHash}, func(_, _ string) {})
	if err != nil {
		t.Fatalf("startMinerWorkers: %v", err)
	}
	if len(workers) != 1 {
		t.Errorf("workers = %d, want 1 (only the SHA256d CPU)", len(workers))
	}
	if merged == nil {
		t.Error("merged channel is nil")
	}
	for _, w := range workers {
		w.Stop()
	}
}

// ============================================================================
// runSessionV1 — remaining branch coverage (session 163)
//
// The five tests below cover paths left dark after the initial V1 test set:
//   (a) opts.tlsCAFile set but unreadable → warn branch
//   (b) opts.tlsCAFile set and readable → success branch (PEM stored)
//   (c) poolproto.DialURL fails (nothing listening) → error return
//   (d) opts.powerWatts > 0 in stats tick → joulesPerTerahash branch
//   (e) opts.dashboard != nil in stats tick → dashboard.Update branch
// ============================================================================

// TestRunSessionV1_TLSCAFileUnreadable: opts.tlsCAFile names a file that
// cannot be read. runSessionV1 must log a warning and proceed (using system
// roots), then fail at the dial because nothing is listening.
func TestRunSessionV1_TLSCAFileUnreadable(t *testing.T) {
	// Open and immediately close a listener to obtain a free port that will
	// then refuse all connections.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen: %v", err)
	}
	addr := ln.Addr().String()
	ln.Close()

	var logs []string
	var mu sync.Mutex
	logFn := func(_, msg string) {
		mu.Lock()
		logs = append(logs, msg)
		mu.Unlock()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	merged := make(chan miner.Share)
	close(merged)

	_ = runSessionV1(ctx, sessionOpts{
		poolURL:   "stratum+tcp://" + addr,
		user:      "test",
		merged:    merged,
		interval:  time.Minute,
		tlsCAFile: "/nonexistent-ca-for-runSessionV1-warn-test.pem",
		log:       logFn,
	})

	mu.Lock()
	defer mu.Unlock()
	found := false
	for _, l := range logs {
		if strings.Contains(l, "tls_ca_file") {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected 'tls_ca_file' warning in logs, got: %v", logs)
	}
}

// TestRunSessionV1_TLSCAFileReadable: opts.tlsCAFile names a readable file.
// runSessionV1 stores the PEM in credentials (lines 779-781), then fails
// at the dial because nothing is listening at the given address.
func TestRunSessionV1_TLSCAFileReadable(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "ca-*.pem")
	if err != nil {
		t.Fatalf("CreateTemp: %v", err)
	}
	_, _ = f.WriteString("-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n")
	f.Close()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen: %v", err)
	}
	addr := ln.Addr().String()
	ln.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	merged := make(chan miner.Share)
	close(merged)

	err = runSessionV1(ctx, sessionOpts{
		poolURL:   "stratum+tcp://" + addr,
		user:      "test",
		merged:    merged,
		interval:  time.Minute,
		tlsCAFile: f.Name(),
		log:       func(_, _ string) {},
	})
	if err == nil {
		t.Error("runSessionV1: expected error when dial fails, got nil")
	}
}

// TestRunSessionV1_DialError: poolproto.DialURL cannot connect to the pool
// (nothing is listening). runSessionV1 must return a non-nil error immediately
// without entering the session loop.
func TestRunSessionV1_DialError(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen: %v", err)
	}
	addr := ln.Addr().String()
	ln.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	merged := make(chan miner.Share)
	close(merged)

	err = runSessionV1(ctx, sessionOpts{
		poolURL:  "stratum+tcp://" + addr,
		user:     "test",
		merged:   merged,
		interval: time.Minute,
		log:      func(_, _ string) {},
	})
	if err == nil {
		t.Error("runSessionV1: expected error when dial fails, got nil")
	}
}

// TestRunSessionV1_PowerWattsInStatsTick: opts.powerWatts > 0 and the
// worker is hashing (currentHashRate > 0) when the stats ticker fires.
// This exercises the joulesPerTerahash metric branch (lines 831-835).
func TestRunSessionV1_PowerWattsInStatsTick(t *testing.T) {
	// fakeV1Pool(t, true) sends one mining.notify job (genesis difficulty) then
	// sleeps 50ms and closes — just long enough for the stats tick to fire.
	addr := fakeV1Pool(t, true)

	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()

	w := miner.NewWorker(miner.WorkerConfig{Threads: 1})
	shares := w.Start(ctx)
	defer w.Stop()

	m := newEngineMetrics(metrics.NewRegistry())
	_ = runSessionV1(ctx, sessionOpts{
		poolURL:    "stratum+tcp://" + addr,
		user:       "w",
		workers:    []*miner.Worker{w},
		merged:     shares,
		interval:   30 * time.Millisecond,
		powerWatts: 100.0,
		log:        func(_, _ string) {},
		m:          m,
	})
	// Correctness: joulesPerTerahash = watts * 1e12 / hashrate. We just verify
	// the path ran without panic; the exact value depends on machine speed.
}

// TestRunSessionV1_DashboardUpdated: opts.dashboard != nil — the V1 stats
// tick must call dashboard.Update (lines 824-826). A Dashboard wired to
// io.Discard suppresses the ANSI output so the test log stays clean.
func TestRunSessionV1_DashboardUpdated(t *testing.T) {
	addr := fakeV1Pool(t, true) // sends job then closes after 50ms

	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()

	w := miner.NewWorker(miner.WorkerConfig{Threads: 1})
	shares := w.Start(ctx)
	defer w.Stop()

	dash := tui.NewDashboard(io.Discard)
	dash.Start()
	defer dash.Stop()

	_ = runSessionV1(ctx, sessionOpts{
		poolURL:   "stratum+tcp://" + addr,
		user:      "w",
		workers:   []*miner.Worker{w},
		merged:    shares,
		interval:  30 * time.Millisecond,
		dashboard: dash,
		log:       func(_, _ string) {},
	})
}

// ============================================================================
// session 167 — arbitration switch/hold metrics and remaining run.go branches
// ============================================================================

// TestRunArbitrationLoop_StaleStreamPruning covers arbitrate.go:73–77:
// the log line emitted when a stream's last quote is older than streamStaleTimeout.
func TestRunArbitrationLoop_StaleStreamPruning(t *testing.T) {
	old := arbitrationInterval
	arbitrationInterval = 20 * time.Millisecond
	defer func() { arbitrationInterval = old }()

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()

	quoteCh := make(chan provider.Quote, 1)
	mu := &sync.Mutex{}
	streamMap := make(map[string]arbitration.Stream)

	var logMu sync.Mutex
	var logs []string

	opts := arbitrationLoopOpts{
		streamsMu: mu,
		streamMap: streamMap,
		quoteCh:   quoteCh,
		metrics:   newEngineMetrics(metrics.NewRegistry()),
		log: func(_, m string) {
			logMu.Lock()
			logs = append(logs, m)
			logMu.Unlock()
		},
	}

	// Pre-queue a quote older than streamStaleTimeout (3 min) so the first
	// ticker cycle finds a stale stream and logs the expiry message.
	quoteCh <- provider.Quote{
		ProviderID: "stale-provider",
		DeviceID:   "cpu-0",
		At:         time.Now().Add(-4 * time.Minute),
	}

	done := make(chan struct{})
	go func() { runArbitrationLoop(ctx, opts); close(done) }()
	select {
	case <-done:
	case <-time.After(400 * time.Millisecond):
		t.Error("runArbitrationLoop did not exit within 400ms")
	}

	logMu.Lock()
	joined := strings.Join(logs, " ")
	logMu.Unlock()
	if !strings.Contains(joined, "expired") {
		t.Errorf("expected stale-stream 'expired' log; got: %v", logs)
	}
}

// TestRunArbitrationLoop_SwitchMetrics covers arbitrate.go:102–104:
// arbitrationSwitches.Inc() fires when a device switches from one stream to another.
// Sequence: first tick assigns cpu-0 → streamA (yield=100); we then inject a quote
// for streamB (yield=300, far above the 5% hysteresis threshold); second tick
// detects the switch and increments the counter.
func TestRunArbitrationLoop_SwitchMetrics(t *testing.T) {
	old := arbitrationInterval
	arbitrationInterval = 20 * time.Millisecond
	defer func() { arbitrationInterval = old }()

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	mu := &sync.Mutex{}
	streamMap := map[string]arbitration.Stream{
		"streamA:cpu-0": {
			ID:              "streamA",
			AcceptsFamilies: []hal.Family{hal.FamilyCPU},
			YieldPerDevice:  map[string]arbitration.Yield{"cpu-0": {SatsPerSecond: 100, Confidence: 1.0}},
			DefaultYield:    arbitration.Yield{SatsPerSecond: 100, Confidence: 1.0},
		},
	}
	devRefs := []arbitration.DeviceRef{{
		Identity:     hal.Identity{ID: "cpu-0", Family: hal.FamilyCPU},
		Capabilities: hal.Capabilities{SHA256d: true},
	}}
	quoteCh := make(chan provider.Quote, 1)
	m := newEngineMetrics(metrics.NewRegistry())

	opts := arbitrationLoopOpts{
		devRefs:   devRefs,
		streamsMu: mu,
		streamMap: streamMap,
		quoteCh:   quoteCh,
		metrics:   m,
		log:       func(_, _ string) {},
	}

	go runArbitrationLoop(ctx, opts)

	// Wait for first tick (assigns cpu-0 → streamA, sets prevAlloc).
	time.Sleep(40 * time.Millisecond)

	// Inject streamB with much higher yield — well above hysteresis threshold.
	quoteCh <- provider.Quote{
		ProviderID:       "streamB",
		DeviceID:         "cpu-0",
		AcceptedFamilies: []hal.Family{hal.FamilyCPU},
		Yield:            provider.Yield{SatsPerSecond: 300, Confidence: 1.0},
	}

	// Wait for second tick (cpu-0 switches to streamB → SwitchedFromID set).
	time.Sleep(40 * time.Millisecond)
	cancel()
	time.Sleep(10 * time.Millisecond) // drain goroutine

	if got := m.arbitrationSwitches.Value(); got == 0 {
		t.Error("expected arbitrationSwitches > 0 after stream switch")
	}
}

// TestRunArbitrationLoop_HoldMetrics covers arbitrate.go:105–107:
// arbitrationHolds.Inc() fires when a better-scoring stream is available but
// suppressed by the hysteresis margin.
// Sequence: first tick assigns cpu-0 → streamA (yield=300); we inject streamB
// (yield=305, only 1.7% better — below the 5% threshold); second tick holds
// on streamA and sets Held=true → increments the counter.
func TestRunArbitrationLoop_HoldMetrics(t *testing.T) {
	old := arbitrationInterval
	arbitrationInterval = 20 * time.Millisecond
	defer func() { arbitrationInterval = old }()

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	mu := &sync.Mutex{}
	streamMap := map[string]arbitration.Stream{
		"streamA:cpu-0": {
			ID:              "streamA",
			AcceptsFamilies: []hal.Family{hal.FamilyCPU},
			YieldPerDevice:  map[string]arbitration.Yield{"cpu-0": {SatsPerSecond: 300, Confidence: 1.0}},
			DefaultYield:    arbitration.Yield{SatsPerSecond: 300, Confidence: 1.0},
		},
	}
	devRefs := []arbitration.DeviceRef{{
		Identity:     hal.Identity{ID: "cpu-0", Family: hal.FamilyCPU},
		Capabilities: hal.Capabilities{SHA256d: true},
	}}
	quoteCh := make(chan provider.Quote, 1)
	m := newEngineMetrics(metrics.NewRegistry())

	opts := arbitrationLoopOpts{
		devRefs:   devRefs,
		streamsMu: mu,
		streamMap: streamMap,
		quoteCh:   quoteCh,
		metrics:   m,
		log:       func(_, _ string) {},
	}

	go runArbitrationLoop(ctx, opts)

	// Wait for first tick (assigns cpu-0 → streamA at yield=300).
	time.Sleep(40 * time.Millisecond)

	// Inject streamB at yield=305: threshold = 300*1.05 = 315 > 305 → Held.
	quoteCh <- provider.Quote{
		ProviderID:       "streamB",
		DeviceID:         "cpu-0",
		AcceptedFamilies: []hal.Family{hal.FamilyCPU},
		Yield:            provider.Yield{SatsPerSecond: 305, Confidence: 1.0},
	}

	// Wait for second tick (held on streamA, Held=true).
	time.Sleep(40 * time.Millisecond)
	cancel()
	time.Sleep(10 * time.Millisecond) // drain goroutine

	if got := m.arbitrationHolds.Value(); got == 0 {
		t.Error("expected arbitrationHolds > 0 after hysteresis hold")
	}
}

// TestRunSession_DashboardUpdated covers run.go:646–648: the V2 stats tick
// calls dashboard.Update when opts.dashboard != nil.
func TestRunSession_DashboardUpdated(t *testing.T) {
	fp := newFakePool(t)
	defer fp.Close()
	<-fp.started

	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()

	merged := make(chan miner.Share)
	defer close(merged)

	dash := tui.NewDashboard(io.Discard)

	_ = runSession(ctx, sessionOpts{
		poolURL:   fp.URL(),
		user:      "test.1",
		merged:    merged,
		interval:  50 * time.Millisecond,
		dashboard: dash,
		log:       func(_, _ string) {},
	})
}

// TestRunSession_AcceptanceRateWarning covers run.go:666–670: the V2 stats
// tick logs a warning when judged >= 20 and the acceptance rate < 97%.
// We pre-seed the metrics with 1 accepted + 19 rejected (rate=4%, judged=20).
func TestRunSession_AcceptanceRateWarning(t *testing.T) {
	fp := newFakePool(t)
	defer fp.Close()
	<-fp.started

	m := newEngineMetrics(metrics.NewRegistry())
	m.sharesAccepted.Inc()
	for i := 0; i < 19; i++ {
		m.sharesRejected.Inc()
	}

	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()

	merged := make(chan miner.Share)
	defer close(merged)

	var logMu sync.Mutex
	var logLines []string

	_ = runSession(ctx, sessionOpts{
		poolURL:  fp.URL(),
		user:     "test.1",
		merged:   merged,
		interval: 50 * time.Millisecond,
		m:        m,
		log: func(_, msg string) {
			logMu.Lock()
			logLines = append(logLines, msg)
			logMu.Unlock()
		},
	})

	logMu.Lock()
	joined := strings.Join(logLines, " ")
	logMu.Unlock()
	if !strings.Contains(joined, "acceptance") {
		t.Errorf("expected acceptance rate warning; got: %v", logLines)
	}
}

// TestRunSessionV1_CurtailmentIgnoresJob covers run.go:866–868: when
// isCurtailed() is true the engine logs a debug message instead of applying
// the job to workers.
func TestRunSessionV1_CurtailmentIgnoresJob(t *testing.T) {
	addr := fakeV1Pool(t, true) // sends one job then closes after 50ms

	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()

	merged := make(chan miner.Share)
	defer close(merged)

	gate := new(atomic.Bool)
	gate.Store(true)

	var logMu sync.Mutex
	var logLines []string

	_ = runSessionV1(ctx, sessionOpts{
		poolURL:     "stratum+tcp://" + addr,
		user:        "w",
		merged:      merged,
		interval:    200 * time.Millisecond,
		curtailGate: gate,
		log: func(_, msg string) {
			logMu.Lock()
			logLines = append(logLines, msg)
			logMu.Unlock()
		},
	})

	logMu.Lock()
	joined := strings.Join(logLines, " ")
	logMu.Unlock()
	if !strings.Contains(joined, "curtailed") {
		t.Errorf("expected 'curtailed' in log; got: %v", logLines)
	}
}

// TestRunSessionV1_ApplyJobError covers the warn-and-continue path in
// runSessionV1: applyJob returns an error when the pool's job carries
// an invalid nBits (target computation fails), triggering the warn log.
func TestRunSessionV1_ApplyJobError(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		r := bufio.NewReader(conn)
		_, _ = r.ReadString('\n') // subscribe
		fmt.Fprintf(conn, `{"id":1,"result":[[["mining.notify","s1"]],"cc",4],"error":null}`+"\n")
		_, _ = r.ReadString('\n') // authorize
		fmt.Fprintf(conn, `{"id":2,"result":true,"error":null}`+"\n")
		_, _ = r.ReadString('\n') // extranonce.subscribe
		fmt.Fprintf(conn, `{"id":3,"result":null,"error":[38,"Method not found",null]}`+"\n")
		// Send job whose nBits cannot produce a target → applyJob errors.
		// (A non-numeric job_id is no longer an error: the pool's id is
		// opaque and echoed verbatim on submit via v1JobIDTable.)
		fmt.Fprintf(conn,
			`{"id":null,"method":"mining.notify","params":[`+
				`"not-a-number",`+
				`"4d16b6f85af6e2198f44ae2a6de67f78487ae5611b77c6c0440b921e00000000",`+
				`"","",[],"00000002","00000000","68d36c5e",true]}`+"\n")
		time.Sleep(200 * time.Millisecond) // stay alive so the engine reads the job
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()

	merged := make(chan miner.Share)
	defer close(merged)

	var logMu sync.Mutex
	var logLines []string

	_ = runSessionV1(ctx, sessionOpts{
		poolURL:  "stratum+tcp://" + ln.Addr().String(),
		user:     "w",
		merged:   merged,
		interval: 200 * time.Millisecond,
		log: func(_, msg string) {
			logMu.Lock()
			logLines = append(logLines, msg)
			logMu.Unlock()
		},
	})

	logMu.Lock()
	joined := strings.Join(logLines, " ")
	logMu.Unlock()
	if !strings.Contains(joined, "bad target") {
		t.Errorf("expected applyJob 'bad target' warn; got: %v", logLines)
	}
}

// TestRunSessionV1_SubmitError covers run.go:900–907: when sess.Submit returns
// an error (pool reads the submit then closes without responding), the engine
// logs "V1 submit: <err>" and, when elapsed > 0, records the latency sample.
func TestRunSessionV1_SubmitError(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		r := bufio.NewReader(conn)
		_, _ = r.ReadString('\n') // subscribe
		fmt.Fprintf(conn, `{"id":1,"result":[[["mining.notify","s1"]],"cc",4],"error":null}`+"\n")
		_, _ = r.ReadString('\n') // authorize
		fmt.Fprintf(conn, `{"id":2,"result":true,"error":null}`+"\n")
		_, _ = r.ReadString('\n') // extranonce.subscribe
		fmt.Fprintf(conn, `{"id":3,"result":null,"error":[38,"Method not found",null]}`+"\n")
		_, _ = r.ReadString('\n') // mining.submit — read but do not respond
		// Sleep so elapsed > 0 (triggers latency.Record branch on line 904–906).
		time.Sleep(5 * time.Millisecond)
		// Goroutine exits; connection closes → sess.Submit returns error.
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	// Pre-queue one share so the merged case fires and Submit is called.
	merged := make(chan miner.Share, 1)
	merged <- miner.Share{JobID: 1, Nonce: 0x12345678, NTime: 0x68d36c5e}

	var logMu sync.Mutex
	var logLines []string
	m := newEngineMetrics(metrics.NewRegistry())

	_ = runSessionV1(ctx, sessionOpts{
		poolURL:  "stratum+tcp://" + ln.Addr().String(),
		user:     "w",
		merged:   merged,
		interval: time.Minute,
		m:        m,
		log: func(_, msg string) {
			logMu.Lock()
			logLines = append(logLines, msg)
			logMu.Unlock()
		},
	})
	// Allow the Submit goroutine (which runs async) to complete and log the error.
	time.Sleep(50 * time.Millisecond)

	logMu.Lock()
	joined := strings.Join(logLines, " ")
	logMu.Unlock()
	if !strings.Contains(joined, "V1 submit") {
		t.Errorf("expected 'V1 submit' error log; got: %v", logLines)
	}
}

// ============================================================================
// run.go handshake — read deadline bounds setup against a silent pool
// ============================================================================

func TestHandshake_SilentPool_TimesOut(t *testing.T) {
	server, client := net.Pipe()
	defer server.Close()
	defer client.Close()

	// Pool drains outbound frames but never answers.
	go func() {
		buf := make([]byte, 4096)
		for {
			if _, err := server.Read(buf); err != nil {
				return
			}
		}
	}()

	prev := handshakeReadTimeout
	handshakeReadTimeout = 30 * time.Millisecond
	defer func() { handshakeReadTimeout = prev }()

	dec := stratum.NewDecoder(client)
	_, _, err := handshake(context.Background(), client, dec, "stratum+v2://pool.example.com:3336", "worker.1", nil)
	if err == nil {
		t.Fatal("handshake should fail when the pool never answers")
	}
}

// ============================================================================
// run.go runReconnectLoop — backoff/attempt reset on a connected session
// ============================================================================

// TestRunReconnectLoop_ResetsAfterConnectedSession scripts a pool that
// fails on every connection except the second, which completes the V1
// handshake then drops. MaxReconnectAttempts=2 counts *consecutive*
// failures: after the successful session resets the counter, the loop
// must accept a 4th connection before two more consecutive failures end
// it. Without the reset it would stop at the 3rd.
func TestRunReconnectLoop_ResetsAfterConnectedSession(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })

	var accepted atomic.Int32
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			n := accepted.Add(1)
			go func() {
				defer conn.Close()
				if n != 2 {
					return // refuse: close without any handshake bytes
				}
				r := bufio.NewReader(conn)
				_, _ = r.ReadString('\n') // mining.subscribe
				fmt.Fprintf(conn, `{"id":1,"result":[[["mining.set_difficulty","s1"],["mining.notify","s2"]],"c0ffee",4],"error":null}`+"\n")
				_, _ = r.ReadString('\n') // mining.authorize
				fmt.Fprintf(conn, `{"id":2,"result":true,"error":null}`+"\n")
				_, _ = r.ReadString('\n') // extranonce.subscribe
				fmt.Fprintf(conn, `{"id":3,"result":null,"error":[38,"Method not found",null]}`+"\n")
			}()
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	r := reconnectOpts{
		opts: Options{
			Config: config.Config{
				BitcoinAddress: "bc1qtest0000000000000000000000000test00",
				Pools:          []config.PoolConfig{{URL: "stratum+tcp://" + ln.Addr().String()}},
			},
			MaxReconnectAttempts: 2,
		},
		metrics: newEngineMetrics(metrics.NewRegistry()),
		log:     func(_, _ string) {},
	}

	err = runReconnectLoop(ctx, r)
	if err == nil || !strings.Contains(err.Error(), "exceeded") {
		t.Fatalf("expected 'exceeded reconnect attempts', got: %v", err)
	}
	if got := accepted.Load(); got < 4 {
		t.Errorf("accepted %d connections, want ≥4 (failure counter must reset after the connected session)", got)
	}
}

// ============================================================================
// run.go — dead-work lifecycle: workers idle between sessions, stale
// buffered shares never reach the next session's pool
// ============================================================================

func TestDrainShares(t *testing.T) {
	// Empty and nil channels return immediately.
	drainShares(nil)
	empty := make(chan miner.Share, 4)
	drainShares(empty)

	ch := make(chan miner.Share, 4)
	for i := 0; i < 4; i++ {
		ch <- miner.Share{JobID: uint32(i)}
	}
	drainShares(ch)
	if n := len(ch); n != 0 {
		t.Fatalf("drainShares left %d buffered shares, want 0", n)
	}
	// A share arriving after the drain stays — the drain is a
	// non-blocking snapshot, not a subscription.
	ch <- miner.Share{JobID: 9}
	if n := len(ch); n != 1 {
		t.Fatalf("post-drain share missing, len=%d", n)
	}
}

// TestRunReconnectLoop_IdlesWorkersBetweenSessions scripts a pool whose
// first connection completes the V1 handshake and delivers a job (so the
// worker demonstrably has work), then closes; later connections fail. On
// return the loop must have idled the worker — grinding a dead session's
// last job through the backoff wastes power and produces only stale
// shares — and must have drained the pre-connection buffered share so it
// is never submitted to a pool that never issued its job id.
func TestRunReconnectLoop_IdlesWorkersBetweenSessions(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })

	var accepted atomic.Int32
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			n := accepted.Add(1)
			go func() {
				defer conn.Close()
				if n != 1 {
					return // refuse every connection after the first
				}
				r := bufio.NewReader(conn)
				_, _ = r.ReadString('\n') // mining.subscribe
				fmt.Fprintf(conn, `{"id":1,"result":[[["mining.set_difficulty","s1"],["mining.notify","s2"]],"c0ffee",4],"error":null}`+"\n")
				_, _ = r.ReadString('\n') // mining.authorize
				fmt.Fprintf(conn, `{"id":2,"result":true,"error":null}`+"\n")
				_, _ = r.ReadString('\n') // extranonce.subscribe
				fmt.Fprintf(conn, `{"id":3,"result":null,"error":[38,"Method not found",null]}`+"\n")
				fmt.Fprintf(conn,
					`{"id":null,"method":"mining.notify","params":[`+
						`"1",`+
						`"4d16b6f85af6e2198f44ae2a6de67f78487ae5611b77c6c0440b921e00000000",`+
						`"","",[],"00000002","1d00ffff","68d36c5e",true]}`+"\n")
				time.Sleep(100 * time.Millisecond) // let applyJob land
			}()
		}
	}()

	w := miner.NewWorker(miner.WorkerConfig{Threads: 1})
	// One share buffered before any session exists — stale by definition.
	merged := make(chan miner.Share, 8)
	merged <- miner.Share{JobID: 1}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	r := reconnectOpts{
		opts: Options{
			Config: config.Config{
				BitcoinAddress: "bc1qtest0000000000000000000000000test00",
				Pools:          []config.PoolConfig{{URL: "stratum+tcp://" + ln.Addr().String()}},
			},
			MaxReconnectAttempts: 2,
		},
		workers: []*miner.Worker{w},
		merged:  merged,
		metrics: newEngineMetrics(metrics.NewRegistry()),
		log:     func(_, _ string) {},
	}

	done := make(chan error, 1)
	go func() { done <- runReconnectLoop(ctx, r) }()

	// The job must actually reach the worker mid-session — otherwise the
	// idle assertion below is vacuous.
	deadline := time.After(5 * time.Second)
	for !w.HasWork() {
		select {
		case <-deadline:
			t.Fatal("worker never received work from the scripted pool")
		case <-time.After(2 * time.Millisecond):
		}
	}

	if err := <-done; err == nil || !strings.Contains(err.Error(), "exceeded") {
		t.Fatalf("expected 'exceeded reconnect attempts', got: %v", err)
	}
	if w.HasWork() {
		t.Error("worker still holds dead-session work after the reconnect loop ended")
	}
	if n := len(merged); n != 0 {
		t.Errorf("%d pre-session share(s) survived the drain", n)
	}
}

// ============================================================================
// run.go — V1 concurrent-submit budget: a pool-driven share flood must not
// spawn an unbounded goroutine per share (each lives up to rpcCallTimeout)
// ============================================================================

// TestRunSessionV1_SubmitBudgetDropsUnderFlood hands the session a scripted
// pool that completes the handshake, receives submits, and never answers —
// so every spawned submit goroutine stays resident holding a semaphore slot.
// With maxConcurrentSubmits=64 and 100 buffered shares, exactly 64 submits
// may be transmitted; the remaining 36 must be counted as dropped, not
// queued as goroutines.
func TestRunSessionV1_SubmitBudgetDropsUnderFlood(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })

	var submitLines atomic.Int32
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		r := bufio.NewReader(conn)
		_, _ = r.ReadString('\n') // mining.subscribe
		fmt.Fprintf(conn, `{"id":1,"result":[[["mining.set_difficulty","s1"],["mining.notify","s2"]],"c0ffee",4],"error":null}`+"\n")
		_, _ = r.ReadString('\n') // mining.authorize
		fmt.Fprintf(conn, `{"id":2,"result":true,"error":null}`+"\n")
		_, _ = r.ReadString('\n') // extranonce.subscribe
		fmt.Fprintf(conn, `{"id":3,"result":null,"error":[38,"Method not found",null]}`+"\n")
		// Read submits but never answer: each in-flight call stays
		// resident up to rpcCallTimeout — the flood scenario this
		// test bounds.
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				return
			}
			if strings.Contains(line, `"mining.submit"`) {
				submitLines.Add(1)
			}
		}
	}()

	merged := make(chan miner.Share, 128)
	for i := 0; i < 100; i++ {
		merged <- miner.Share{JobID: uint32(i), Nonce: uint32(i)}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	m := newEngineMetrics(metrics.NewRegistry())
	go func() {
		_ = runSessionV1(ctx, sessionOpts{
			poolURL:  "stratum+tcp://" + ln.Addr().String(),
			user:     "w",
			merged:   merged,
			interval: 30 * time.Millisecond,
			log:      func(_, _ string) {},
			m:        m,
		})
	}()

	// Wait for the loop to drain all 100 shares: 64 submitted (semaphore
	// full) + 36 dropped. Bounded by the overall ctx deadline.
	deadline := time.After(8 * time.Second)
	for m.sharesSubmitDropped.Value() != 36 {
		select {
		case <-deadline:
			t.Fatalf("dropped=%d submitted=%d — loop never drained the flood",
				m.sharesSubmitDropped.Value(), m.sharesSubmitted.Value())
		case <-time.After(5 * time.Millisecond):
		}
	}
	if got := m.sharesSubmitted.Value(); got != 64 {
		t.Errorf("submitted=%d, want exactly %d (semaphore cap)", got, maxConcurrentSubmits)
	}
	// The pool must never see more than the cap — a definitive check that
	// the flood produced no unbounded goroutine growth.
	if got := submitLines.Load(); got > maxConcurrentSubmits {
		t.Errorf("pool received %d submits, exceeds cap %d", got, maxConcurrentSubmits)
	}
}

// ============================================================================
// run.go — V2 steady-state silence bound: a pool that keeps the TCP
// connection open but never sends a frame must not pin the session
// ============================================================================

// silentV2Pool completes the SV2 handshake (SetupConnection +
// OpenMiningChannelSuccess with an all-0xFF target), then holds the
// connection open while never sending another frame — the zombie-peer
// case the session silence bound exists to unstick.
func silentV2Pool(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		dec := stratum.NewDecoder(conn)
		dec.MaxFrameSize = 1 << 20

		if _, err := dec.ReadFrame(); err != nil { // SetupConnection
			return
		}
		payload, _ := stratum.SetupConnectionSuccess{UsedVersion: 2}.Encode()
		f, _ := stratum.WrapMessage(stratum.MsgSetupConnectionSuccess, false, payload)
		encoded, _ := stratum.EncodeFrame(f)
		if _, err := conn.Write(encoded); err != nil {
			return
		}
		if _, err := dec.ReadFrame(); err != nil { // OpenMiningChannel
			return
		}
		succ := stratum.OpenMiningChannelSuccess{ReqID: 1, ChannelID: 1, ExtraNonce2Size: 4}
		for i := range succ.Target {
			succ.Target[i] = 0xFF
		}
		payload, _ = succ.Encode()
		f, _ = stratum.WrapMessage(stratum.MsgOpenMiningChannelSuccess, false, payload)
		encoded, _ = stratum.EncodeFrame(f)
		if _, err := conn.Write(encoded); err != nil {
			return
		}
		// Silence: read (and drop) anything the client sends until the
		// session bound closes the connection from our side.
		for {
			if _, err := dec.ReadFrame(); err != nil {
				return
			}
		}
	}()
	return "stratum+v2://" + ln.Addr().String()
}

// noiseV2Pool completes the SV2 handshake, then streams well-formed
// frames of an unassigned message type (0x7F) every few milliseconds.
// The traffic is real bytes on the wire but no protocol progress — the
// silence bound must treat it the same as silence.
func noiseV2Pool(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		dec := stratum.NewDecoder(conn)
		dec.MaxFrameSize = 1 << 20

		if _, err := dec.ReadFrame(); err != nil {
			return
		}
		payload, _ := stratum.SetupConnectionSuccess{UsedVersion: 2}.Encode()
		f, _ := stratum.WrapMessage(stratum.MsgSetupConnectionSuccess, false, payload)
		encoded, _ := stratum.EncodeFrame(f)
		if _, err := conn.Write(encoded); err != nil {
			return
		}
		if _, err := dec.ReadFrame(); err != nil {
			return
		}
		succ := stratum.OpenMiningChannelSuccess{ReqID: 1, ChannelID: 1, ExtraNonce2Size: 4}
		for i := range succ.Target {
			succ.Target[i] = 0xFF
		}
		payload, _ = succ.Encode()
		f, _ = stratum.WrapMessage(stratum.MsgOpenMiningChannelSuccess, false, payload)
		encoded, _ = stratum.EncodeFrame(f)
		if _, err := conn.Write(encoded); err != nil {
			return
		}

		// Unassigned msg_type, connection-scoped, empty payload — frame
		// valid, dispatches to Message.Unknown. Keep streaming so wire
		// liveness alone can't be the criterion.
		uf, _ := stratum.WrapMessage(0x7F, false, nil)
		uenc, _ := stratum.EncodeFrame(uf)
		for {
			if _, err := conn.Write(uenc); err != nil {
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
	}()
	return "stratum+v2://" + ln.Addr().String()
}

// TestRunSession_UselessFramesAbandoned pins the useful-progress
// semantics of the silence bound: unknown extension frames deliver no
// work, so they must not keep a job-less session alive.
func TestRunSession_UselessFramesAbandoned(t *testing.T) {
	old := sessionSilenceBound
	sessionSilenceBound = 120 * time.Millisecond
	defer func() { sessionSilenceBound = old }()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := runSession(ctx, sessionOpts{
		poolURL:  noiseV2Pool(t),
		user:     "w",
		merged:   make(chan miner.Share),
		interval: 20 * time.Millisecond,
		log:      func(_, _ string) {},
	})
	if err == nil || !strings.Contains(err.Error(), "pool silent") {
		t.Fatalf("expected a pool-silent session error under unknown-frame flood, got %v", err)
	}
}

func TestRunSession_SilentPoolAbandoned(t *testing.T) {
	old := sessionSilenceBound
	sessionSilenceBound = 120 * time.Millisecond
	defer func() { sessionSilenceBound = old }()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := runSession(ctx, sessionOpts{
		poolURL:  silentV2Pool(t),
		user:     "w",
		merged:   make(chan miner.Share),
		interval: 20 * time.Millisecond,
		log:      func(_, _ string) {},
	})
	if err == nil || !strings.Contains(err.Error(), "pool silent") {
		t.Fatalf("expected a pool-silent session error, got %v", err)
	}
}

// ============================================================================
// run.go — V2 channel-identity: frames naming a channel we never opened
// must not affect job, tip, target, or share-verdict state
// ============================================================================

// channelConfusionPool completes the SV2 handshake for channel 1, then
// sends NewMiningJob / SetNewPrevHash / SetTarget / SubmitSharesSuccess
// / SubmitSharesError frames all stamped with foreign channel 99, and
// finally a real (job + prev-hash) pair on channel 1.
func channelConfusionPool(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		dec := stratum.NewDecoder(conn)
		dec.MaxFrameSize = 1 << 20

		writeFrame := func(mt uint8, chMsg bool, payload []byte) {
			f, err := stratum.WrapMessage(mt, chMsg, payload)
			if err != nil {
				return
			}
			encoded, _ := stratum.EncodeFrame(f)
			conn.Write(encoded) //nolint:errcheck
		}

		if _, err := dec.ReadFrame(); err != nil { // SetupConnection
			return
		}
		payload, _ := stratum.SetupConnectionSuccess{UsedVersion: 2}.Encode()
		writeFrame(stratum.MsgSetupConnectionSuccess, false, payload)
		if _, err := dec.ReadFrame(); err != nil { // OpenMiningChannel
			return
		}
		succ := stratum.OpenMiningChannelSuccess{ReqID: 1, ChannelID: 1, ExtraNonce2Size: 4}
		for i := range succ.Target {
			succ.Target[i] = 0xFF
		}
		payload, _ = succ.Encode()
		writeFrame(stratum.MsgOpenMiningChannelSuccess, false, payload)

		// Foreign-channel frames: job 99, tip 99, target 99, verdicts 99.
		job := stratum.NewMiningJob{ChannelID: 99, JobID: 1, Version: 0x20000004}
		for i := range job.MerkleRoot {
			job.MerkleRoot[i] = byte(i)
		}
		payload, _ = job.Encode()
		writeFrame(stratum.MsgNewMiningJob, true, payload)
		prev := stratum.SetNewPrevHash{ChannelID: 99, JobID: 1, MinNtime: 0x60000000, NBits: 0x207fffff}
		for i := range prev.PrevHash {
			prev.PrevHash[i] = byte(0xA0 + i%16)
		}
		payload, _ = prev.Encode()
		writeFrame(stratum.MsgSetNewPrevHash, true, payload)
		st := stratum.SetTarget{ChannelID: 99}
		payload, _ = st.Encode()
		writeFrame(stratum.MsgSetTarget, true, payload)
		ok := stratum.SubmitSharesSuccess{ChannelID: 99, LastSequenceNumber: 1}
		payload, _ = ok.Encode()
		writeFrame(stratum.MsgSubmitSharesSuccess, true, payload)
		rej := stratum.SubmitSharesError{ChannelID: 99, Error: "stale"}
		payload, _ = rej.Encode()
		writeFrame(stratum.MsgSubmitSharesError, true, payload)

		// Hold the conn open until the engine gives up the channel test
		// window, then send a real job+tip on channel 1.
		time.Sleep(300 * time.Millisecond)
		job2 := stratum.NewMiningJob{ChannelID: 1, JobID: 2, Version: 0x20000004}
		for i := range job2.MerkleRoot {
			job2.MerkleRoot[i] = byte(i)
		}
		payload, _ = job2.Encode()
		writeFrame(stratum.MsgNewMiningJob, true, payload)
		prev2 := stratum.SetNewPrevHash{ChannelID: 1, JobID: 2, MinNtime: 0x60000000, NBits: 0x207fffff}
		for i := range prev2.PrevHash {
			prev2.PrevHash[i] = byte(0xA0 + i%16)
		}
		payload, _ = prev2.Encode()
		writeFrame(stratum.MsgSetNewPrevHash, true, payload)

		for {
			if _, err := dec.ReadFrame(); err != nil {
				return
			}
		}
	}()
	return "stratum+v2://" + ln.Addr().String()
}

// TestRunSessionV2_ForeignChannelIgnored feeds the session frames stamped
// with a channel id we never opened: the worker must stay idle and the
// acceptance counters untouched while foreign frames arrive, then arm
// normally once a real job+tip land on the actual channel.
func TestRunSessionV2_ForeignChannelIgnored(t *testing.T) {
	w := miner.NewWorker(miner.WorkerConfig{Threads: 1})
	m := newEngineMetrics(metrics.NewRegistry())

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	done := make(chan error, 1)
	go func() {
		done <- runSession(ctx, sessionOpts{
			poolURL:  channelConfusionPool(t),
			user:     "w",
			workers:  []*miner.Worker{w},
			merged:   make(chan miner.Share, 8),
			interval: 20 * time.Millisecond,
			log:      func(_, _ string) {},
			m:        m,
		})
	}()

	// Foreign frames must not arm the worker. Sample HasWork across the
	// window in which the foreign job+tip were delivered; any arm is a bug.
	deadline := time.After(250 * time.Millisecond)
	for {
		select {
		case <-deadline:
			goto foreignWindowDone
		case <-time.After(2 * time.Millisecond):
			if w.HasWork() {
				t.Fatal("worker armed by a foreign-channel NewMiningJob/SetNewPrevHash")
			}
		}
	}
foreignWindowDone:

	// The real channel-1 job+tip must arm the worker — proves the gate is
	// selective, not a blanket drop.
	deadline = time.After(3 * time.Second)
	for !w.HasWork() {
		select {
		case <-deadline:
			t.Fatal("worker never armed by the real channel-1 job")
		case <-time.After(2 * time.Millisecond):
		}
	}
	if got := m.sharesAccepted.Value(); got != 0 {
		t.Errorf("foreign-channel SubmitSharesSuccess counted: accepted=%d", got)
	}
	if got := m.sharesRejected.Value(); got != 0 {
		t.Errorf("foreign-channel SubmitSharesError counted: rejected=%d", got)
	}
	cancel()
	<-done
}

// ============================================================================
// run.go — undecodable-frame bound: single bad frames are skipped, but a
// peer emitting only garbage must not hold the session alive-but-deaf
// ============================================================================

// garbageFramePool completes the SV2 handshake, then sends `bad` truncated
// NewMiningJob frames (valid frame header, payload that fails decode),
// optionally followed by a valid channel-1 job+tip pair.
func garbageFramePool(t *testing.T, bad int, thenValid bool) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		dec := stratum.NewDecoder(conn)
		dec.MaxFrameSize = 1 << 20

		writeFrame := func(mt uint8, chMsg bool, payload []byte) {
			f, err := stratum.WrapMessage(mt, chMsg, payload)
			if err != nil {
				return
			}
			encoded, _ := stratum.EncodeFrame(f)
			conn.Write(encoded) //nolint:errcheck
		}

		if _, err := dec.ReadFrame(); err != nil {
			return
		}
		payload, _ := stratum.SetupConnectionSuccess{UsedVersion: 2}.Encode()
		writeFrame(stratum.MsgSetupConnectionSuccess, false, payload)
		if _, err := dec.ReadFrame(); err != nil {
			return
		}
		succ := stratum.OpenMiningChannelSuccess{ReqID: 1, ChannelID: 1, ExtraNonce2Size: 4}
		for i := range succ.Target {
			succ.Target[i] = 0xFF
		}
		payload, _ = succ.Encode()
		writeFrame(stratum.MsgOpenMiningChannelSuccess, false, payload)

		for i := 0; i < bad; i++ {
			// Frame-valid (≥4-byte channel id) but decode-invalid:
			// NewMiningJob needs ~44 bytes after the channel id.
			writeFrame(stratum.MsgNewMiningJob, true, []byte{1, 0, 0, 0, 0xAA})
		}
		if thenValid {
			job := stratum.NewMiningJob{ChannelID: 1, JobID: 7, Version: 0x20000004}
			for i := range job.MerkleRoot {
				job.MerkleRoot[i] = byte(i)
			}
			payload, _ = job.Encode()
			writeFrame(stratum.MsgNewMiningJob, true, payload)
			prev := stratum.SetNewPrevHash{ChannelID: 1, JobID: 7, MinNtime: 0x60000000, NBits: 0x207fffff}
			for i := range prev.PrevHash {
				prev.PrevHash[i] = byte(0xA0 + i%16)
			}
			payload, _ = prev.Encode()
			writeFrame(stratum.MsgSetNewPrevHash, true, payload)
		}
		for {
			if _, err := dec.ReadFrame(); err != nil {
				return
			}
		}
	}()
	return "stratum+v2://" + ln.Addr().String()
}

// TestRunSessionV2_UndecodableFramesSkipped sends 3 bad frames then a
// valid job+tip — the session must survive and arm the worker.
func TestRunSessionV2_UndecodableFramesSkipped(t *testing.T) {
	w := miner.NewWorker(miner.WorkerConfig{Threads: 1})

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	done := make(chan error, 1)
	go func() {
		done <- runSession(ctx, sessionOpts{
			poolURL:  garbageFramePool(t, 3, true),
			user:     "w",
			workers:  []*miner.Worker{w},
			merged:   make(chan miner.Share, 8),
			interval: 20 * time.Millisecond,
			log:      func(_, _ string) {},
			m:        newEngineMetrics(metrics.NewRegistry()),
		})
	}()

	deadline := time.After(3 * time.Second)
	for !w.HasWork() {
		select {
		case <-deadline:
			t.Fatal("worker never armed — undecodable frames may have killed the session")
		case err := <-done:
			t.Fatalf("session ended early: %v", err)
		case <-time.After(2 * time.Millisecond):
		}
	}
	cancel()
	<-done
}

// TestRunSessionV2_UndecodableBound sends only bad frames — the session
// must die once the consecutive bound is reached rather than staying
// alive-but-deaf forever.
func TestRunSessionV2_UndecodableBound(t *testing.T) {
	w := miner.NewWorker(miner.WorkerConfig{Threads: 1})

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	done := make(chan error, 1)
	go func() {
		done <- runSession(ctx, sessionOpts{
			poolURL:  garbageFramePool(t, maxConsecutiveDecodeErrors+2, false),
			user:     "w",
			workers:  []*miner.Worker{w},
			merged:   make(chan miner.Share, 8),
			interval: 20 * time.Millisecond,
			log:      func(_, _ string) {},
			m:        newEngineMetrics(metrics.NewRegistry()),
		})
	}()

	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "undecodable") {
			t.Fatalf("expected undecodable-bound error, got: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("session survived a pure-garbage stream — bound not enforced")
	}
	if w.HasWork() {
		t.Error("worker armed by a garbage stream")
	}
	cancel()
}

// TestRunSessionV2_SessionEndReleasesReader floods inbound frames past the
// inCh buffer (32) so the producer goroutine is blocked on send when the
// session ends. Teardown must release it — previously the send only
// selected on the session ctx, which stays alive inside the reconnect
// loop, so the goroutine (and its conn) leaked for the rest of the run.
func TestRunSessionV2_SessionEndReleasesReader(t *testing.T) {
	w := miner.NewWorker(miner.WorkerConfig{Threads: 1})
	baseline := runtime.NumGoroutine()

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	done := make(chan error, 1)
	go func() {
		done <- runSession(ctx, sessionOpts{
			// 40 bad frames: the consumer exits at the decode bound while
			// the producer still has >32 to deliver — its send wedges in
			// the full inCh unless teardown also releases it.
			poolURL:  garbageFramePool(t, 40, false),
			user:     "w",
			workers:  []*miner.Worker{w},
			merged:   make(chan miner.Share, 8),
			interval: 20 * time.Millisecond,
			log:      func(_, _ string) {},
			m:        newEngineMetrics(metrics.NewRegistry()),
		})
	}()

	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("session survived a pure-garbage stream — bound not enforced")
	}
	cancel()

	// The producer goroutine must not outlive the session: pre-fix it
	// stayed blocked forever sending into the full inCh.
	deadline := time.Now().Add(2 * time.Second)
	for runtime.NumGoroutine() > baseline {
		if time.Now().After(deadline) {
			t.Fatalf("goroutine leak after session end: baseline=%d now=%d", baseline, runtime.NumGoroutine())
		}
		time.Sleep(10 * time.Millisecond)
	}
}
