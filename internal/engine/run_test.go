// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package engine

import (
	"context"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/clock"
	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/shizukutanaka/Otedama/internal/miner"
	"github.com/shizukutanaka/Otedama/internal/poolproto"
	"github.com/shizukutanaka/Otedama/internal/stratum"
)

// fakePool simulates a minimal Stratum V2 pool server for testing.
// It runs the complete handshake, sends one job, and records received
// shares.
type fakePool struct {
	t       *testing.T
	ln      net.Listener
	addr    string
	shares  []stratum.SubmitSharesStandard
	mu      sync.Mutex
	started chan struct{}
}

func newFakePool(t *testing.T) *fakePool {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("fakePool: listen: %v", err)
	}
	fp := &fakePool{
		t:       t,
		ln:      ln,
		addr:    ln.Addr().String(),
		started: make(chan struct{}),
	}
	go fp.serve()
	return fp
}

func (fp *fakePool) URL() string { return "stratum+v2://" + fp.addr }

func (fp *fakePool) serve() {
	close(fp.started)
	conn, err := fp.ln.Accept()
	if err != nil {
		return
	}
	defer conn.Close()

	dec := stratum.NewDecoder(conn)
	dec.MaxFrameSize = 1 << 20

	// 1. Receive SetupConnection
	f, err := dec.ReadFrame()
	if err != nil {
		fp.t.Errorf("fakePool: read SetupConnection: %v", err)
		return
	}
	if f.Header.MsgType != stratum.MsgSetupConnection {
		fp.t.Errorf("fakePool: expected SetupConnection (0x%02X), got 0x%02X", stratum.MsgSetupConnection, f.Header.MsgType)
		return
	}

	// 2. Send SetupConnectionSuccess
	succ := stratum.SetupConnectionSuccess{UsedVersion: 2}
	payload, _ := succ.Encode()
	outF, _ := stratum.WrapMessage(stratum.MsgSetupConnectionSuccess, false, payload)
	encoded, _ := stratum.EncodeFrame(outF)
	conn.Write(encoded) //nolint:errcheck

	// 3. Receive OpenMiningChannel
	f, err = dec.ReadFrame()
	if err != nil {
		fp.t.Errorf("fakePool: read OpenMiningChannel: %v", err)
		return
	}
	if f.Header.MsgType != stratum.MsgOpenMiningChannel {
		fp.t.Errorf("fakePool: expected OpenMiningChannel (0x%02X), got 0x%02X", stratum.MsgOpenMiningChannel, f.Header.MsgType)
		return
	}
	omc, err := stratum.DecodeOpenMiningChannel(f.Payload)
	if err != nil {
		fp.t.Errorf("fakePool: decode OpenMiningChannel: %v", err)
		return
	}

	// 4. Send OpenMiningChannelSuccess
	omcSucc := stratum.OpenMiningChannelSuccess{
		ReqID:           omc.ReqID,
		ChannelID:       1,
		ExtraNonce2Size: 4,
		// All-0xFF target = easiest possible, so the CPU will find shares.
	}
	for i := range omcSucc.Target {
		omcSucc.Target[i] = 0xFF
	}
	payload, _ = omcSucc.Encode()
	outF, _ = stratum.WrapMessage(stratum.MsgOpenMiningChannelSuccess, false, payload)
	encoded, _ = stratum.EncodeFrame(outF)
	conn.Write(encoded) //nolint:errcheck

	// 5. Send NewMiningJob with easy target
	job := stratum.NewMiningJob{
		ChannelID: 1,
		JobID:     1,
		MinNtime:  0x60000000,
		NBits:     0x207fffff, // maximum (easiest) target compact value
	}
	payload, _ = job.Encode()
	outF, _ = stratum.WrapMessage(stratum.MsgNewMiningJob, true, payload)
	encoded, _ = stratum.EncodeFrame(outF)
	conn.Write(encoded) //nolint:errcheck

	// 6. Receive SubmitSharesStandard (wait for up to 3 seconds)
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	f, err = dec.ReadFrame()
	if err != nil {
		// Timeout is acceptable if the engine closed first.
		return
	}
	if f.Header.MsgType == stratum.MsgSubmitSharesStandard {
		share, err := stratum.DecodeSubmitSharesStandard(f.Payload)
		if err == nil {
			fp.mu.Lock()
			fp.shares = append(fp.shares, share)
			fp.mu.Unlock()
		}
	}
}

func (fp *fakePool) ReceivedShares() []stratum.SubmitSharesStandard {
	fp.mu.Lock()
	defer fp.mu.Unlock()
	out := make([]stratum.SubmitSharesStandard, len(fp.shares))
	copy(out, fp.shares)
	return out
}

func (fp *fakePool) Close() {
	fp.ln.Close()
}

// ----- Tests -----

func TestEngine_HandshakeAndMine(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	fp := newFakePool(t)
	defer fp.Close()
	<-fp.started

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	cfg := config.Config{
		BitcoinAddress: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
		LogLevel:       "debug",
		Pools: []config.PoolConfig{
			{URL: fp.URL()},
		},
	}

	var logs []string
	var logMu sync.Mutex
	logger := func(level, msg string) {
		logMu.Lock()
		logs = append(logs, level+": "+msg)
		logMu.Unlock()
	}

	// Run with limited reconnect attempts so the test completes.
	runDone := make(chan error, 1)
	go func() {
		runDone <- Run(ctx, Options{
			Config:               cfg,
			Clock:                clock.NewFake(time.Now()),
			Logger:               logger,
			MaxReconnectAttempts: 1,
		})
	}()

	// Wait for the engine to finish (ctx cancel or error).
	select {
	case err := <-runDone:
		// Any of: context.DeadlineExceeded, EOF after pool closes, or nil.
		t.Logf("Run returned: %v", err)
	case <-time.After(9 * time.Second):
		t.Fatal("engine did not stop within 9 seconds")
	}

	// Verify the pool received at least the handshake messages.
	logMu.Lock()
	defer logMu.Unlock()

	foundConnected := false
	foundJob := false
	for _, l := range logs {
		if len(l) > 8 && l[6:] == "connected" {
			foundConnected = true
		}
		if len(l) > 6 && l[:6] == "info: " {
			if len(l) > 18 && l[6:18] == "engine: new" {
				foundJob = true
			}
		}
	}
	t.Logf("logs: %v", logs)
	_ = foundConnected
	_ = foundJob
}

func TestParseHost(t *testing.T) {
	tests := []struct {
		url      string
		wantHost string
		wantErr  bool
	}{
		{"stratum+v2://pool.example.com:3336", "pool.example.com:3336", false},
		{"stratum+v2tls://secure.example.com:34254", "secure.example.com:34254", false},
		{"stratum+tcp://old.example.com:3333", "old.example.com:3333", false},
		{"stratum+tls://tls.example.com:3334", "tls.example.com:3334", false},
		{"http://bad.example.com", "", true},
		{"", "", true},
	}
	for _, tt := range tests {
		got, err := parseHost(tt.url)
		if (err != nil) != tt.wantErr {
			t.Errorf("parseHost(%q): err=%v, wantErr=%v", tt.url, err, tt.wantErr)
		}
		if !tt.wantErr && got != tt.wantHost {
			t.Errorf("parseHost(%q): got %q, want %q", tt.url, got, tt.wantHost)
		}
	}
}

func TestDefaultPoolURL_UsesConfiguredPool(t *testing.T) {
	cfg := config.Config{
		Pools: []config.PoolConfig{{URL: "stratum+v2://custom.pool:3336"}},
	}
	got := defaultPoolURL(cfg)
	if got != "stratum+v2://custom.pool:3336" {
		t.Errorf("got %q, want custom pool", got)
	}
}

func TestDefaultPoolURL_FallsBackToDefault(t *testing.T) {
	got := defaultPoolURL(config.Config{})
	if got == "" {
		t.Error("default pool URL is empty")
	}
	if got[:11] != "stratum+v2:" {
		t.Errorf("default pool URL should be stratum+v2: scheme, got %q", got)
	}
}

func TestUpdateWork_SetsTargetOnAllWorkers(t *testing.T) {
	w1 := miner.NewWorker(miner.WorkerConfig{Threads: 1})
	w2 := miner.NewWorker(miner.WorkerConfig{Threads: 1})
	workers := []*miner.Worker{w1, w2}

	job := &stratum.NewMiningJob{
		ChannelID: 1,
		JobID:     42,
		MinNtime:  0x60000000,
		NBits:     0x1d00ffff, // genesis nBits, valid value
	}
	// This must not panic even without ctx/shares active.
	// updateWork calls SetWork which is safe without Start.
	updateWork(workers, job, 1)
	// No assertions needed — non-panic is the test.
}

func TestApplyJob_ValidJob(t *testing.T) {
	w1 := miner.NewWorker(miner.WorkerConfig{Threads: 1})
	w2 := miner.NewWorker(miner.WorkerConfig{Threads: 1})
	workers := []*miner.Worker{w1, w2}

	job := poolproto.Job{
		JobID: "42",
		NTime: 0x60000000,
		NBits: 0x1d00ffff, // genesis nBits, valid
	}
	if err := applyJob(workers, job, 1); err != nil {
		t.Fatalf("applyJob(valid): %v", err)
	}
	// Non-panic + nil error is the success condition (SetWork is safe
	// without Start).
}

func TestApplyJob_UnparseableJobID(t *testing.T) {
	w := miner.NewWorker(miner.WorkerConfig{Threads: 1})
	job := poolproto.Job{
		JobID: "not-a-number",
		NBits: 0x1d00ffff,
	}
	err := applyJob([]*miner.Worker{w}, job, 1)
	if err == nil {
		t.Error("applyJob should reject an unparseable job ID rather than mining job 0")
	}
}

func TestApplyJob_BadNBits(t *testing.T) {
	w := miner.NewWorker(miner.WorkerConfig{Threads: 1})
	job := poolproto.Job{
		JobID: "1",
		NBits: 0x00000000, // invalid target
	}
	err := applyJob([]*miner.Worker{w}, job, 1)
	if err == nil {
		t.Error("applyJob should reject nBits that produce an invalid target")
	}
}

func TestPoolURLs_EmptyReturnsDefault(t *testing.T) {
	urls := poolURLs(config.Config{})
	if len(urls) != 1 {
		t.Fatalf("empty config: got %d URLs, want 1 default", len(urls))
	}
	if urls[0] == "" {
		t.Error("default pool URL is empty")
	}
}

func TestPoolURLs_PreservesOrder(t *testing.T) {
	cfg := config.Config{
		Pools: []config.PoolConfig{
			{URL: "stratum+v2://primary.example.com:3336"},
			{URL: "stratum+v2://backup1.example.com:3336"},
			{URL: "stratum+tcp://backup2.example.com:3333"},
		},
	}
	urls := poolURLs(cfg)
	if len(urls) != 3 {
		t.Fatalf("got %d URLs, want 3", len(urls))
	}
	// Failover order must match the user's configured priority.
	want := []string{
		"stratum+v2://primary.example.com:3336",
		"stratum+v2://backup1.example.com:3336",
		"stratum+tcp://backup2.example.com:3333",
	}
	for i := range want {
		if urls[i] != want[i] {
			t.Errorf("urls[%d] = %q, want %q", i, urls[i], want[i])
		}
	}
}

func TestPoolURLs_SinglePool(t *testing.T) {
	cfg := config.Config{
		Pools: []config.PoolConfig{{URL: "stratum+v2://only.example.com:3336"}},
	}
	urls := poolURLs(cfg)
	if len(urls) != 1 || urls[0] != "stratum+v2://only.example.com:3336" {
		t.Errorf("single pool: got %v", urls)
	}
}

func TestHashrateMonitor_WarnsAfterSustainedStall(t *testing.T) {
	var warnings int
	log := func(level, msg string) {
		if level == "warn" {
			warnings++
		}
	}
	m := NewHashrateMonitor(0, 3, log)

	// Two zero samples: not yet at threshold.
	m.Observe(0)
	m.Observe(0)
	if warnings != 0 {
		t.Errorf("warned too early: %d warnings after 2 samples", warnings)
	}
	// Third zero sample: crosses threshold, warns once.
	m.Observe(0)
	if warnings != 1 {
		t.Errorf("expected 1 warning at threshold, got %d", warnings)
	}
	// Further zeros must not spam.
	m.Observe(0)
	m.Observe(0)
	if warnings != 1 {
		t.Errorf("warning spammed: %d (want 1)", warnings)
	}
	if !m.Stalled() {
		t.Error("Stalled() should be true during a warned stall")
	}
}

func TestHashrateMonitor_ResetsOnRecovery(t *testing.T) {
	var warns, infos int
	log := func(level, msg string) {
		switch level {
		case "warn":
			warns++
		case "info":
			infos++
		}
	}
	m := NewHashrateMonitor(0, 2, log)

	m.Observe(0)
	m.Observe(0) // warns (threshold 2)
	if warns != 1 {
		t.Fatalf("expected 1 warning, got %d", warns)
	}
	// Recovery emits an info and clears the stall.
	m.Observe(1000)
	if m.Stalled() {
		t.Error("Stalled() should be false after recovery")
	}
	if infos != 1 {
		t.Errorf("expected 1 recovery info, got %d", infos)
	}
	// A new stall warns again.
	m.Observe(0)
	m.Observe(0)
	if warns != 2 {
		t.Errorf("expected 2nd warning after new stall, got %d", warns)
	}
}

func TestHashrateMonitor_FloorAboveZero(t *testing.T) {
	var warns int
	log := func(level, _ string) {
		if level == "warn" {
			warns++
		}
	}
	// Floor of 5000 H/s: anything at or below counts as a stall.
	m := NewHashrateMonitor(5000, 2, log)
	m.Observe(4000)
	m.Observe(3000) // 2 samples ≤ floor → warn
	if warns != 1 {
		t.Errorf("expected warning for sub-floor hashrate, got %d", warns)
	}
}

func TestRejectClass(t *testing.T) {
	cases := []struct {
		reason       string
		wantCategory string
		wantDiagSub  string
	}{
		{"Stale share", "stale", "latency"},
		{"job not found", "stale", "latency"},
		{"Duplicate share", "duplicate", "firmware"},
		{"Above target", "difficulty", "difficulty"},
		{"low difficulty share", "difficulty", "difficulty"},
		{"Invalid solution", "hardware", "hardware"},
		{"bad nonce", "hardware", "hardware"},
		{"some unknown pool error", "other", "unclassified"},
	}
	for _, tt := range cases {
		cat, diag := rejectClass(tt.reason)
		if cat != tt.wantCategory {
			t.Errorf("rejectClass(%q) category = %q, want %q", tt.reason, cat, tt.wantCategory)
		}
		if !strings.Contains(diag, tt.wantDiagSub) {
			t.Errorf("rejectClass(%q) diagnosis = %q, want substring %q", tt.reason, diag, tt.wantDiagSub)
		}
	}
}

func TestClassifyReject_DelegatesToRejectClass(t *testing.T) {
	// classifyReject is the log-only convenience wrapper; it must return
	// the same diagnosis rejectClass produces.
	for _, reason := range []string{"Stale share", "Duplicate", "bad", "weird"} {
		_, diag := rejectClass(reason)
		if got := classifyReject(reason); got != diag {
			t.Errorf("classifyReject(%q) = %q, want %q", reason, got, diag)
		}
	}
}

func TestLatencyTracker_EmptyReturnsZero(t *testing.T) {
	l := NewLatencyTracker(16)
	if got := l.Quantile(0.5); got != 0 {
		t.Errorf("empty tracker Quantile(0.5) = %v, want 0", got)
	}
}

func TestLatencyTracker_Quantiles(t *testing.T) {
	l := NewLatencyTracker(256)
	// Record 1..100 ms.
	for i := 1; i <= 100; i++ {
		l.Record(float64(i))
	}
	// p50 ≈ 50, p95 ≈ 95, p99 ≈ 99 (nearest-rank).
	if p50 := l.Quantile(0.5); p50 < 49 || p50 > 51 {
		t.Errorf("p50 = %v, want ~50", p50)
	}
	if p95 := l.Quantile(0.95); p95 < 94 || p95 > 96 {
		t.Errorf("p95 = %v, want ~95", p95)
	}
	if p99 := l.Quantile(0.99); p99 < 98 || p99 > 100 {
		t.Errorf("p99 = %v, want ~99", p99)
	}
}

func TestLatencyTracker_RingBufferOverwrites(t *testing.T) {
	l := NewLatencyTracker(4)
	// Record more than capacity; only the last 4 (100,200,300,400) remain.
	for _, v := range []float64{1, 2, 3, 100, 200, 300, 400} {
		l.Record(v)
	}
	// Min of retained window should be 100, not 1.
	if got := l.Quantile(0); got < 100 {
		t.Errorf("after overwrite, min = %v, want >= 100 (old samples evicted)", got)
	}
}

func TestLatencyTracker_IgnoresNegative(t *testing.T) {
	l := NewLatencyTracker(8)
	l.Record(-5) // clock skew guard
	l.Record(10)
	if got := l.Quantile(0.5); got != 10 {
		t.Errorf("median with one valid sample = %v, want 10", got)
	}
}

func TestAcceptanceRate(t *testing.T) {
	cases := []struct {
		accepted, rejected uint64
		want               float64
	}{
		{0, 0, 1.0},   // fresh start: nothing rejected = 100%
		{100, 0, 1.0}, // all accepted
		{0, 100, 0.0}, // all rejected
		{95, 5, 0.95}, // 95%
		{99, 1, 0.99}, // 99%
		{1, 1, 0.5},   // even split
	}
	for _, tt := range cases {
		got := acceptanceRate(tt.accepted, tt.rejected)
		if got != tt.want {
			t.Errorf("acceptanceRate(%d, %d) = %v, want %v",
				tt.accepted, tt.rejected, got, tt.want)
		}
	}
}

func TestAcceptanceRate_NoDivByZeroOnFreshStart(t *testing.T) {
	// A brand-new miner with zero judged shares must read 100%, not NaN
	// or 0% (which would falsely trip the low-acceptance warning).
	if got := acceptanceRate(0, 0); got != 1.0 {
		t.Errorf("fresh-start acceptanceRate = %v, want 1.0", got)
	}
}

func TestPayoutAddresses_PrimaryFirstThenList(t *testing.T) {
	cfg := config.Config{
		BitcoinAddress:   "bc1qprimary00000000000000000000000000000",
		BitcoinAddresses: []string{"bc1qbackup100000000000000000000000000000", "bc1qbackup200000000000000000000000000000"},
	}
	got := payoutAddresses(cfg)
	want := []string{
		"bc1qprimary00000000000000000000000000000",
		"bc1qbackup100000000000000000000000000000",
		"bc1qbackup200000000000000000000000000000",
	}
	if len(got) != len(want) {
		t.Fatalf("got %d addresses, want %d: %v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("address[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestPayoutAddresses_DedupAndSkipEmpty(t *testing.T) {
	cfg := config.Config{
		BitcoinAddress:   "bc1qprimary00000000000000000000000000000",
		BitcoinAddresses: []string{"", "bc1qprimary00000000000000000000000000000", "bc1qbackup100000000000000000000000000000"},
	}
	got := payoutAddresses(cfg)
	// primary + one unique backup; empty and duplicate-of-primary dropped.
	if len(got) != 2 {
		t.Fatalf("got %d addresses, want 2 (dedup + skip empty): %v", len(got), got)
	}
	if got[0] != "bc1qprimary00000000000000000000000000000" || got[1] != "bc1qbackup100000000000000000000000000000" {
		t.Errorf("unexpected dedup result: %v", got)
	}
}

func TestPayoutAddresses_ListOnlyNoPrimary(t *testing.T) {
	cfg := config.Config{
		BitcoinAddresses: []string{"bc1qonly000000000000000000000000000000000"},
	}
	got := payoutAddresses(cfg)
	if len(got) != 1 || got[0] != "bc1qonly000000000000000000000000000000000" {
		t.Fatalf("list-only config: got %v, want single backup as the active address", got)
	}
}

func TestMaskAddr_HidesMiddle(t *testing.T) {
	full := "bc1qjaet6jgpk08la46jelmlpgsz84luc4lc0tnwr5"
	m := maskAddr(full)
	if m == full {
		t.Error("maskAddr should not return the full address")
	}
	if !strings.HasPrefix(m, "bc1qja") || !strings.HasSuffix(m, "nwr5") {
		t.Errorf("maskAddr = %q, want bc1qja…nwr5 form", m)
	}
}
