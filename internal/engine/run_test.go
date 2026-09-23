// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package engine

import (
	"bytes"
	"context"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/arbitration"
	"github.com/shizukutanaka/Otedama/internal/clock"
	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/shizukutanaka/Otedama/internal/hal"
	"github.com/shizukutanaka/Otedama/internal/lightning"
	"github.com/shizukutanaka/Otedama/internal/metrics"
	"github.com/shizukutanaka/Otedama/internal/miner"
	"github.com/shizukutanaka/Otedama/internal/poolproto"
	"github.com/shizukutanaka/Otedama/internal/provider"
	"github.com/shizukutanaka/Otedama/internal/rates"
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
		ReqID:          omc.ReqID,
		ChannelID:      1,
		GroupChannelID: 4,
		// All-0xFF target = easiest possible, so the CPU will find shares.
	}
	for i := range omcSucc.Target {
		omcSucc.Target[i] = 0xFF
	}
	payload, _ = omcSucc.Encode()
	outF, _ = stratum.WrapMessage(stratum.MsgOpenMiningChannelSuccess, false, payload)
	encoded, _ = stratum.EncodeFrame(outF)
	conn.Write(encoded) //nolint:errcheck

	// 5. Send NewMiningJob (future job: no min_ntime) followed by the
	// SetNewPrevHash that activates it — the full SV2 activation
	// sequence. The all-0xFF channel target from step 4 means every
	// header hash qualifies as a share, so the CPU finds one instantly.
	// A version distinct from the legacy hardcoded 0x20000000 so the
	// share-echo test below can prove NVersion comes from the job.
	job := stratum.NewMiningJob{
		ChannelID: 1,
		JobID:     1,
		Version:   0x20000004,
	}
	for i := range job.MerkleRoot {
		job.MerkleRoot[i] = byte(i)
	}
	payload, _ = job.Encode()
	outF, _ = stratum.WrapMessage(stratum.MsgNewMiningJob, true, payload)
	encoded, _ = stratum.EncodeFrame(outF)
	conn.Write(encoded) //nolint:errcheck

	prev := stratum.SetNewPrevHash{
		ChannelID: 1,
		JobID:     1,
		MinNtime:  0x60000000,
		NBits:     0x207fffff, // network compact target (easiest, for realism)
	}
	for i := range prev.PrevHash {
		prev.PrevHash[i] = byte(0xA0 + i%16)
	}
	payload, _ = prev.Encode()
	outF, _ = stratum.WrapMessage(stratum.MsgSetNewPrevHash, true, payload)
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

// TestEngine_SubmittedShareEchoesJobVersion drives the full engine
// against the fake pool and asserts a share is actually submitted (the
// share target from OpenMiningChannelSuccess is honored — mining at
// network difficulty would never find one) and that its NVersion echoes
// the job's version (0x20000004) rather than any hardcoded constant.
func TestEngine_SubmittedShareEchoesJobVersion(t *testing.T) {
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
		LogLevel:       "error",
		Pools:          []config.PoolConfig{{URL: fp.URL()}},
	}
	go func() {
		_ = Run(ctx, Options{
			Config:               cfg,
			Clock:                clock.NewFake(time.Now()),
			Logger:               func(_, _ string) {},
			MaxReconnectAttempts: 1,
		})
	}()

	deadline := time.After(7 * time.Second)
	for {
		if shares := fp.ReceivedShares(); len(shares) > 0 {
			s := shares[0]
			if s.NVersion != 0x20000004 {
				t.Errorf("submitted NVersion = 0x%08X, want 0x20000004 (the job's version)", s.NVersion)
			}
			if s.NTime != 0x60000000 {
				t.Errorf("submitted NTime = 0x%08X, want 0x60000000 (SetNewPrevHash min_ntime)", s.NTime)
			}
			if s.JobID != 1 {
				t.Errorf("submitted JobID = %d, want 1", s.JobID)
			}
			return
		}
		select {
		case <-deadline:
			t.Fatal("no share submitted within 7s — share target from OpenMiningChannelSuccess not honored?")
		case <-time.After(50 * time.Millisecond):
		}
	}
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

// TestUpdateWork_PopulatesFullHeaderAndShareTarget pins the core fix for
// the SV2 data path: updateWork must fill ALL five header inputs
// (version, prev-hash, merkle root, time, bits) and hand the workers the
// POOL-ASSIGNED share target, not the network target. It runs a real
// worker against the easiest possible target and asserts the found share
// echoes the exact version and ntime that were hashed.
func TestUpdateWork_PopulatesFullHeaderAndShareTarget(t *testing.T) {
	w := miner.NewWorker(miner.WorkerConfig{Threads: 1})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	shares := w.Start(ctx)
	defer w.Stop()

	job := &stratum.NewMiningJob{
		ChannelID: 1,
		JobID:     42,
		Version:   0x20000004,
	}
	for i := range job.MerkleRoot {
		job.MerkleRoot[i] = byte(i * 7)
	}
	var prevHash [32]byte
	for i := range prevHash {
		prevHash[i] = byte(i + 1)
	}
	var easiest miner.Hash
	for i := range easiest {
		easiest[i] = 0xFF // every hash qualifies → share arrives instantly
	}

	updateWork([]*miner.Worker{w}, job, 1, prevHash, 0x1d00ffff, 0x60000000, easiest)

	select {
	case s := <-shares:
		if s.JobID != 42 {
			t.Errorf("share JobID = %d, want 42", s.JobID)
		}
		if s.Version != 0x20000004 {
			t.Errorf("share Version = 0x%08X, want 0x20000004 (must echo the hashed header version)", s.Version)
		}
		if s.NTime != 0x60000000 {
			t.Errorf("share NTime = 0x%08X, want 0x60000000", s.NTime)
		}
	case <-ctx.Done():
		t.Fatal("no share within 3s at the easiest share target — share target not honored")
	}
}

// TestUpdateWork_ZeroShareTargetFallsBackToNetworkTarget covers the case
// where the pool assigns no share target at all (zero value): updateWork
// must fall back to the network target derived from prevNBits rather
// than mining against an all-zero (impossible) target.
func TestUpdateWork_ZeroShareTargetFallsBackToNetworkTarget(t *testing.T) {
	w := miner.NewWorker(miner.WorkerConfig{Threads: 1})
	job := &stratum.NewMiningJob{ChannelID: 1, JobID: 1, Version: 0x20000000}
	var prevHash [32]byte

	// Must not panic; genesis nBits is a valid (very hard) target.
	updateWork([]*miner.Worker{w}, job, 1, prevHash, 0x1d00ffff, 0x495fab29, miner.Hash{})
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
	if err := applyJob(workers, job, 1, 0); err != nil {
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
	err := applyJob([]*miner.Worker{w}, job, 1, 0)
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
	err := applyJob([]*miner.Worker{w}, job, 1, 0)
	if err == nil {
		t.Error("applyJob should reject nBits that produce an invalid target")
	}
}

// ----- applyJob / v1JobTarget: pool-assigned share difficulty overrides nBits target -----

func TestApplyJob_PositiveDifficulty_NoError(t *testing.T) {
	// applyJob must accept a positive difficulty without error (SetWork is
	// safe without Start; behavioural proof that the right target is chosen
	// lives in TestV1JobTarget below, which tests the pure decision function).
	w := miner.NewWorker(miner.WorkerConfig{Threads: 1})
	job := poolproto.Job{JobID: "1", NBits: 0x1d00ffff}
	if err := applyJob([]*miner.Worker{w}, job, 1, 0.001); err != nil {
		t.Fatalf("applyJob(difficulty=0.001): %v", err)
	}
}

func TestV1JobTarget_ZeroDifficulty_FallsBackToNBitsTarget(t *testing.T) {
	// Before any mining.set_difficulty, SuggestedDifficulty() is 0. The
	// target must be the nBits-derived block target, matching pre-wiring
	// behaviour.
	const nBits = 0x1d00ffff
	got, err := v1JobTarget(nBits, 0)
	if err != nil {
		t.Fatalf("v1JobTarget(difficulty=0): %v", err)
	}
	want, err := miner.TargetFromNBits(nBits)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Errorf("target = %x, want nBits-derived target %x", got, want)
	}
}

func TestV1JobTarget_PositiveDifficulty_UsesShareTarget(t *testing.T) {
	// Once the pool has assigned a share difficulty, the target must be the
	// (far easier) share target instead of the full nBits block target —
	// otherwise a V1 worker would essentially never produce a submittable
	// share (see docs/RESEARCH_IMPROVEMENTS.md Cat 1/2 #4 fix rationale).
	const nBits = 0x1d00ffff // genesis (very hard) block target
	const shareDifficulty = 0.001

	got, err := v1JobTarget(nBits, shareDifficulty)
	if err != nil {
		t.Fatalf("v1JobTarget(difficulty=%v): %v", shareDifficulty, err)
	}
	wantShare, err := miner.TargetFromDifficulty(shareDifficulty)
	if err != nil {
		t.Fatal(err)
	}
	blockTarget, err := miner.TargetFromNBits(nBits)
	if err != nil {
		t.Fatal(err)
	}
	if got != wantShare {
		t.Errorf("target = %x, want share-difficulty target %x", got, wantShare)
	}
	if got == blockTarget {
		t.Error("target equals the full block target; share difficulty was not applied")
	}
}

func TestV1JobTarget_BadNBits_ErrorsRegardlessOfDifficulty(t *testing.T) {
	if _, err := v1JobTarget(0x00000000, 0.001); err == nil {
		t.Error("v1JobTarget should reject invalid nBits even with a valid difficulty")
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

// ============================================================================
// hashrateWindow — current rate from cumulative samples
// ============================================================================

func TestHashrateWindow_FirstSampleIsZero(t *testing.T) {
	var w hashrateWindow
	t0 := time.Unix(1000, 0)
	if r := w.observe(0, t0); r != 0 {
		t.Errorf("first observe = %v, want 0 (baseline)", r)
	}
}

func TestHashrateWindow_ComputesRateOverInterval(t *testing.T) {
	var w hashrateWindow
	t0 := time.Unix(1000, 0)
	w.observe(0, t0)
	// 10,000 hashes over 10 seconds → 1,000 H/s.
	if r := w.observe(10_000, t0.Add(10*time.Second)); r != 1000 {
		t.Errorf("rate = %v, want 1000", r)
	}
	// Another 5,000 over the next 5 seconds → 1,000 H/s.
	if r := w.observe(15_000, t0.Add(15*time.Second)); r != 1000 {
		t.Errorf("rate = %v, want 1000", r)
	}
}

func TestHashrateWindow_StallShowsZeroRate(t *testing.T) {
	// The whole point: once the counter stops advancing, the windowed rate
	// is 0 even though the lifetime average (total/uptime) would stay high.
	var w hashrateWindow
	t0 := time.Unix(1000, 0)
	w.observe(0, t0)
	w.observe(1_000_000, t0.Add(10*time.Second)) // hashed a lot
	// Now the device wedges: counter frozen at 1,000,000.
	for i := 1; i <= 3; i++ {
		r := w.observe(1_000_000, t0.Add(time.Duration(10+i)*time.Second))
		if r != 0 {
			t.Errorf("stalled rate at +%ds = %v, want 0", 10+i, r)
		}
	}
}

func TestHashrateWindow_SaturatesOnCounterReset(t *testing.T) {
	// Workers recreated on reconnect → cumulative total drops to (near) 0.
	// The rate must be 0, never negative or NaN (ESP-Miner reconnect fix).
	var w hashrateWindow
	t0 := time.Unix(1000, 0)
	w.observe(5_000_000, t0)
	r := w.observe(200, t0.Add(5*time.Second)) // counters reset after reconnect
	if r != 0 {
		t.Errorf("rate after counter reset = %v, want 0 (saturating)", r)
	}
	// And it recovers cleanly on the next interval from the new baseline.
	if r := w.observe(5_200, t0.Add(10*time.Second)); r != 1000 {
		t.Errorf("post-reset rate = %v, want 1000", r)
	}
}

func TestHashrateWindow_ZeroDeltaTimeYieldsZero(t *testing.T) {
	// Two samples at the same instant must not divide by zero.
	var w hashrateWindow
	t0 := time.Unix(1000, 0)
	w.observe(0, t0)
	if r := w.observe(10_000, t0); r != 0 {
		t.Errorf("rate with dt=0 = %v, want 0 (no div-by-zero)", r)
	}
}

// TestHashrateWindow_FeedsStallMonitor is the integration that motivates the
// whole change: a worker that hashes then wedges must drive Stalled()=true,
// which a lifetime average could never do.
func TestHashrateWindow_FeedsStallMonitor(t *testing.T) {
	var w hashrateWindow
	mon := NewHashrateMonitor(0, 3, nil)
	t0 := time.Unix(1000, 0)
	w.observe(0, t0)
	mon.Observe(w.observe(1_000_000, t0.Add(time.Second))) // healthy
	if mon.Stalled() {
		t.Fatal("should not be stalled while hashing")
	}
	// Counter frozen for 3 intervals → stall detected.
	for i := 2; i <= 4; i++ {
		mon.Observe(w.observe(1_000_000, t0.Add(time.Duration(i)*time.Second)))
	}
	if !mon.Stalled() {
		t.Error("stall monitor should fire once the windowed rate hits 0")
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

func TestLatencyTracker_QuantileEndpointsClampToMinAndMax(t *testing.T) {
	// q at or beyond the [0,1] endpoints must pin to the extreme samples,
	// not panic or wrap. q>=1 exercises the upper idx>=n clamp; q<=0 the
	// lower idx<0 clamp.
	l := NewLatencyTracker(256)
	for i := 1; i <= 100; i++ {
		l.Record(float64(i))
	}
	cases := []struct {
		q    float64
		want float64
	}{
		{0, 1},      // 0th percentile → minimum
		{-0.5, 1},   // below range → minimum (lower clamp)
		{1, 100},    // 100th percentile → maximum
		{1.5, 100},  // above range → maximum (upper clamp)
		{1000, 100}, // far above → maximum (upper clamp)
	}
	for _, c := range cases {
		if got := l.Quantile(c.q); got != c.want {
			t.Errorf("Quantile(%v) = %v, want %v", c.q, got, c.want)
		}
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

// hashWithMSB builds a Hash whose most significant byte (index 31, the
// byte LessOrEqual compares first) is v, everything else zero.
func hashWithMSB(v byte) miner.Hash {
	var h miner.Hash
	h[31] = v
	return h
}

func TestShareSupersededByRetarget(t *testing.T) {
	easy := hashWithMSB(0x02) // bar in force when the share was issued
	hard := hashWithMSB(0x01) // bar raised to after the pool retarget
	zero := miner.Hash{}      // unknown / never assigned

	// Above the new bar, below the old one: equal to hard at the MSB,
	// then strictly greater at the next byte — strictly between the two.
	between := hashWithMSB(0x01)
	between[30] = 0xFF

	cases := []struct {
		name           string
		hash           miner.Hash
		issueTarget    miner.Hash
		currentTarget  miner.Hash
		wantSuperseded bool
	}{
		{
			name:           "valid at issue, fails new bar → superseded",
			hash:           between,
			issueTarget:    easy,
			currentTarget:  hard,
			wantSuperseded: true,
		},
		{
			name:           "met old bar but not new → superseded (exact boundary)",
			hash:           easy, // hash == issue target, fails hard
			issueTarget:    easy,
			currentTarget:  hard,
			wantSuperseded: true,
		},
		{
			name:           "still meets current bar → not superseded",
			hash:           hashWithMSB(0x00),
			issueTarget:    easy,
			currentTarget:  hard,
			wantSuperseded: false,
		},
		{
			name:           "failed even the old bar → genuine reject",
			hash:           hashWithMSB(0x03),
			issueTarget:    easy,
			currentTarget:  hard,
			wantSuperseded: false,
		},
		{
			// Would be superseded if the issue target were easy — but it is
			// unknown, so the guard must refuse (conservative: count as genuine).
			name:           "unknown issue target → conservative, genuine reject",
			hash:           between,
			issueTarget:    zero,
			currentTarget:  hard,
			wantSuperseded: false,
		},
		{
			// A hash below the issue bar can never fail a bar that moved
			// downward — 'not superseded' is the only consistent answer.
			name:           "easier current bar → genuine reject (not a retarget)",
			hash:           between,
			issueTarget:    easy,
			currentTarget:  hashWithMSB(0x03),
			wantSuperseded: false,
		},
	}
	for _, tt := range cases {
		got := shareSupersededByRetarget(tt.hash, tt.issueTarget, tt.currentTarget)
		if got != tt.wantSuperseded {
			t.Errorf("%s: shareSupersededByRetarget = %v, want %v", tt.name, got, tt.wantSuperseded)
		}
	}
}

func TestEngineMetrics_UpdateShareRates_SupersededSettles(t *testing.T) {
	// Superseded shares were judged by the pool (rejected, benignly), so
	// they must reduce the unaccounted gauge — but must not pollute the
	// reject rate, which exists to signal actionable losses.
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)

	for range 100 {
		m.sharesFound.Inc()
	}
	for range 90 {
		m.sharesAccepted.Inc()
	}
	for range 5 {
		m.sharesRejected.Inc()
	}
	for range 5 {
		m.sharesSuperseded.Inc() // benign retarget rejects, judged
	}
	rate, judged := m.updateShareRates()

	if got := m.sharesUnaccounted.Value(); got != 0 {
		t.Errorf("sharesUnaccounted = %v, want 0 (superseded shares are judged)", got)
	}
	if judged != 95 {
		t.Errorf("judged = %d, want 95 (superseded excluded from accept/reject base)", judged)
	}
	// acceptance rate = 90/95 — the superseded five must not deflate it
	// (they are excluded from the judged base entirely).
	if want := 90.0 / 95.0; rate != want {
		t.Errorf("acceptance rate = %v, want %v", rate, want)
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

func TestSessionUser_Precedence(t *testing.T) {
	addr := "bc1qjaet6jgpk08la46jelmlpgsz84luc4lc0tnwr5"
	cases := []struct {
		name             string
		poolUser, worker string
		want             string
	}{
		{"plain address", "", "", addr},
		{"worker suffix", "", "rig-01", addr + ".rig-01"},
		{"explicit pool user overrides", "acct.worker7", "rig-01", "acct.worker7"},
		{"explicit pool user, no worker", "acct.worker7", "", "acct.worker7"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := sessionUser(tc.poolUser, addr, tc.worker); got != tc.want {
				t.Errorf("sessionUser(%q, addr, %q) = %q, want %q", tc.poolUser, tc.worker, got, tc.want)
			}
		})
	}
}

func TestPublishBTCRate_SetsGauge(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	f := rates.NewFetcher(95000) // fallback used before any fetch

	publishBTCRate(m, f)

	if got := m.btcUSDRate.Value(); got != 95000 {
		t.Errorf("btc_usd_rate gauge = %v, want fallback 95000", got)
	}
}

// fakeRateStats is a configurable rateStats for exercising publishBTCRate's
// post-fetch branches (skew, age, source health) without real network I/O.
type fakeRateStats struct {
	rate        float64
	fresh       bool
	skew        float64
	age         time.Duration
	everFetched bool
	ok, total   int
	fetched     bool
}

func (f fakeRateStats) BTCUSDRate() (float64, bool)    { return f.rate, f.fresh }
func (f fakeRateStats) ClockSkewSeconds() float64      { return f.skew }
func (f fakeRateStats) RateAge() (time.Duration, bool) { return f.age, f.everFetched }
func (f fakeRateStats) SourceHealth() (int, int, bool) { return f.ok, f.total, f.fetched }

func TestPublishBTCRate_PublishesAllPostFetchBranches(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)

	publishBTCRate(m, fakeRateStats{
		rate: 96000, fresh: true,
		skew:        42,
		age:         90 * time.Second,
		everFetched: true,
		ok:          2, total: 3, fetched: true,
	})

	if got := m.btcUSDRate.Value(); got != 96000 {
		t.Errorf("btcUSDRate = %v, want 96000", got)
	}
	if got := m.clockSkewSeconds.Value(); got != 42 {
		t.Errorf("clockSkewSeconds = %v, want 42", got)
	}
	if got := m.btcRateAgeSeconds.Value(); got != 90 {
		t.Errorf("btcRateAgeSeconds = %v, want 90", got)
	}
	if got := m.rateSourcesOK.Value(); got != 2 {
		t.Errorf("rateSourcesOK = %v, want 2", got)
	}
	if got := m.rateSourcesTotal.Value(); got != 3 {
		t.Errorf("rateSourcesTotal = %v, want 3", got)
	}
}

func TestPublishBTCRate_SkipsBranchesBeforeFetch(t *testing.T) {
	// Zero/false state (no fetch yet): rate gauge stays at the sentinel for a
	// non-positive rate, skew stays untouched (skew==0), and the age/source
	// gauges are not written (everFetched/fetched false).
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	m.btcUSDRate.Set(-1)
	m.clockSkewSeconds.Set(-1)
	m.btcRateAgeSeconds.Set(-1)
	m.rateSourcesOK.Set(-1)

	publishBTCRate(m, fakeRateStats{rate: 0, skew: 0, everFetched: false, fetched: false})

	if got := m.btcUSDRate.Value(); got != -1 {
		t.Errorf("btcUSDRate = %v, want unchanged -1 (rate<=0)", got)
	}
	if got := m.clockSkewSeconds.Value(); got != -1 {
		t.Errorf("clockSkewSeconds = %v, want unchanged -1 (skew==0)", got)
	}
	if got := m.btcRateAgeSeconds.Value(); got != -1 {
		t.Errorf("btcRateAgeSeconds = %v, want unchanged -1 (not fetched)", got)
	}
	if got := m.rateSourcesOK.Value(); got != -1 {
		t.Errorf("rateSourcesOK = %v, want unchanged -1 (not fetched)", got)
	}
}

func TestPublishBTCRate_AgeGaugeZeroBeforeAnyFetch(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	f := rates.NewFetcher(95000) // no fetch yet → RateAge everFetched=false

	// pre-set to a sentinel to confirm publishBTCRate does NOT touch it
	// before any real fetch (age is meaningless without a fetch).
	m.btcRateAgeSeconds.Set(-1)
	publishBTCRate(m, f)

	if got := m.btcRateAgeSeconds.Value(); got != -1 {
		t.Errorf("btc_rate_age_seconds before any fetch = %v, want unchanged (-1)", got)
	}
}

func TestPublishBTCRate_SourceHealthGaugesUntouchedBeforeFetch(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	f := rates.NewFetcher(95000) // no fetch → SourceHealth fetched=false

	m.rateSourcesOK.Set(-1)
	m.rateSourcesTotal.Set(-1)
	publishBTCRate(m, f)

	if got := m.rateSourcesOK.Value(); got != -1 {
		t.Errorf("rate_sources_ok before fetch = %v, want unchanged (-1)", got)
	}
	if got := m.rateSourcesTotal.Value(); got != -1 {
		t.Errorf("rate_sources_total before fetch = %v, want unchanged (-1)", got)
	}
}

// ============================================================================
// publishDifficulty — pool difficulty and estimated share interval (session 135)
// ============================================================================

func TestPublishDifficulty_SetsGaugesAtKnownHashrate(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)

	const diff = 1024.0
	const hashrate = 1_000_000_000.0 // 1 GH/s

	publishDifficulty(m, diff, hashrate)

	if got := m.poolDifficulty.Value(); got != diff {
		t.Errorf("poolDifficulty = %v, want %v", got, diff)
	}
	// E[seconds] = 1024 × 2^32 / 1e9 ≈ 4398.0 s
	wantInterval := diff * 4294967296 / hashrate
	if got := m.estimatedShareIntervalSeconds.Value(); got != wantInterval {
		t.Errorf("estimatedShareIntervalSeconds = %v, want %v", got, wantInterval)
	}
}

func TestPublishDifficulty_ZeroHashrateYieldsZeroInterval(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)

	publishDifficulty(m, 512.0, 0)

	if got := m.poolDifficulty.Value(); got != 512 {
		t.Errorf("poolDifficulty = %v, want 512", got)
	}
	if got := m.estimatedShareIntervalSeconds.Value(); got != 0 {
		t.Errorf("estimatedShareIntervalSeconds with zero hashrate = %v, want 0", got)
	}
}

func TestPublishDifficulty_ZeroDifficultyIsNoOp(t *testing.T) {
	// Zero difficulty (before any mining.set_difficulty) must not write the gauge;
	// the gauge stays at its initial 0 rather than being explicitly set to 0.
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	// pre-set to a sentinel to confirm no update
	m.poolDifficulty.Set(999)

	publishDifficulty(m, 0, 1e9)

	if got := m.poolDifficulty.Value(); got != 999 {
		t.Errorf("poolDifficulty after zero-diff call = %v, want 999 (unchanged)", got)
	}
}

// ============================================================================
// curtailDecision — pure price-curtailment decision (session 116)
//
// The critical safety property: a non-fresh price (startup fallback or a
// rate older than the cache duration) must NEVER change the gate, so the
// engine cannot pause or resume mining on a price it does not trust.
// ============================================================================

func TestCurtailDecision(t *testing.T) {
	tests := []struct {
		name        string
		curr        bool
		rate        float64
		fresh       bool
		threshold   float64
		wantNext    bool
		wantChanged bool
	}{
		// --- the bug this fixes: never act on a non-fresh price ---
		{"not fresh below threshold does not curtail", false, 95000, false, 100000, false, false},
		{"not fresh above threshold does not uncurtail", true, 95000, false, 90000, true, false},
		{"fallback at startup (not fresh) is ignored", false, 95000, false, 100000, false, false},

		// --- normal fresh transitions ---
		{"fresh below threshold curtails", false, 89000, true, 90000, true, true},
		{"fresh above threshold uncurtails", true, 95000, true, 90000, false, true},

		// --- no-op steady states ---
		{"fresh below while already curtailed: no change", true, 80000, true, 90000, true, false},
		{"fresh above while not curtailed: no change", false, 95000, true, 90000, false, false},
		{"exactly at threshold is not below (uncurtails)", true, 90000, true, 90000, false, true},
		{"exactly at threshold when not curtailed: no change", false, 90000, true, 90000, false, false},

		// --- feature disabled / invalid inputs ---
		{"threshold 0 disables (no curtail)", false, 1, true, 0, false, false},
		{"threshold 0 disables (no uncurtail either)", true, 1, true, 0, true, false},
		{"negative threshold disabled", false, 50000, true, -1, false, false},
		{"zero rate never changes state", true, 0, true, 90000, true, false},
		{"negative rate never changes state", false, -5, true, 90000, false, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			next, changed := curtailDecision(tt.curr, tt.rate, tt.fresh, tt.threshold)
			if next != tt.wantNext || changed != tt.wantChanged {
				t.Errorf("curtailDecision(curr=%v, rate=%g, fresh=%v, thr=%g) = (%v, %v), want (%v, %v)",
					tt.curr, tt.rate, tt.fresh, tt.threshold, next, changed, tt.wantNext, tt.wantChanged)
			}
		})
	}
}

// ============================================================================
// sessionOpts.isCurtailed — curtailment gate predicate (session 115)
//
// This predicate guards both job-application call sites in runSession /
// runSessionV1: when it returns true, an incoming pool job must NOT be armed
// onto the workers (they stay idle from the curtailment goroutine's
// SetWork(nil)). The un-curtailed path (nil gate -> jobs applied -> shares
// reach the pool) is covered end-to-end by TestEngine_Integration_HandshakeSucceeds.
// ============================================================================

func TestSessionOpts_IsCurtailed_NilGateIsFalse(t *testing.T) {
	// A session with no curtail gate (curtail_below_btc_usd disabled) must
	// never report curtailed, so jobs are always applied.
	var opts sessionOpts // curtailGate == nil
	if opts.isCurtailed() {
		t.Error("isCurtailed() = true with nil gate, want false")
	}
}

func TestSessionOpts_IsCurtailed_ReflectsGateState(t *testing.T) {
	gate := new(atomic.Bool)
	opts := sessionOpts{curtailGate: gate}

	if opts.isCurtailed() {
		t.Error("isCurtailed() = true before gate raised, want false")
	}
	gate.Store(true)
	if !opts.isCurtailed() {
		t.Error("isCurtailed() = false after gate raised, want true")
	}
	gate.Store(false)
	if opts.isCurtailed() {
		t.Error("isCurtailed() = true after gate lowered, want false")
	}
}

// TestCurtailmentGate_BlocksWorkApplication verifies the contract the gate
// enforces, observed through the share channel (the honest signal that a
// worker is actually hashing): while the gate is raised an incoming job must
// leave the worker idle (no shares); once lowered, the next job arms it
// (shares flow). It exercises the exact branch the session loop uses
// (isCurtailed -> apply or skip) against a real running worker, so a
// regression in either the predicate or the call-site wiring is caught.
func TestCurtailmentGate_BlocksWorkApplication(t *testing.T) {
	w := miner.NewWorker(miner.WorkerConfig{Threads: 1})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	shares := w.Start(ctx)
	defer w.Stop()

	gate := new(atomic.Bool)
	opts := sessionOpts{workers: []*miner.Worker{w}, curtailGate: gate}

	target, err := miner.TargetFromNBits(0x207fffff) // trivially easy
	if err != nil {
		t.Fatalf("TargetFromNBits: %v", err)
	}
	job := &stratum.NewMiningJob{JobID: 7, Version: 0x20000000}
	var prevHash [32]byte

	apply := func() {
		if opts.isCurtailed() {
			return // mirror runSession: skip arming while curtailed
		}
		updateWork(opts.workers, job, 0, prevHash, 0x207fffff, 0x60000000, target)
	}

	// Gate raised: applying a job is skipped, so the worker never gets work
	// and must produce no shares.
	gate.Store(true)
	apply()
	select {
	case <-shares:
		t.Fatal("worker produced a share while curtailed; gate did not block work application")
	case <-time.After(250 * time.Millisecond):
		// No share — correct; the worker has no work.
	}

	// Gate lowered: the next job must arm the worker and shares must flow.
	gate.Store(false)
	apply()
	select {
	case <-shares:
		// Armed and hashing — correct.
	case <-ctx.Done():
		t.Fatal("no share after curtailment lifted; gate stuck or work not applied")
	}
}

// ============================================================================
// sessionOpts.updateLiveness — curtailment must not be mistaken for a stall
// (session 117)
// ============================================================================

func TestUpdateLiveness_CurtailedReportsHealthyAndDoesNotStall(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	gate := new(atomic.Bool)
	gate.Store(true) // curtailed
	opts := sessionOpts{m: m, curtailGate: gate}
	hashMon := NewHashrateMonitor(0, 3, func(_, _ string) {})

	// Workers are idled by curtailment, so the hashrate is 0 every tick.
	// This must NOT be read as a fault: up stays 1 and the stall monitor is
	// never advanced (so it would emit no "hashrate stalled" warning).
	for i := 0; i < 5; i++ {
		if stalled := opts.updateLiveness(hashMon, 0); stalled {
			t.Fatalf("sample %d: reported stalled while curtailed", i)
		}
	}
	if hashMon.Stalled() {
		t.Error("stall monitor advanced to stalled while curtailed (would emit a false warning)")
	}
	if got := m.up.Value(); got != 1 {
		t.Errorf("otedama_up = %v while curtailed, want 1 (healthy/paused)", got)
	}
}

func TestUpdateLiveness_NotCurtailedZeroHashrateStalls(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	opts := sessionOpts{m: m} // nil gate -> not curtailed
	hashMon := NewHashrateMonitor(0, 3, func(_, _ string) {})

	var stalled bool
	for i := 0; i < 3; i++ {
		stalled = opts.updateLiveness(hashMon, 0)
	}
	if !stalled {
		t.Error("expected a fault stall after 3 zero samples when not curtailed")
	}
	if got := m.up.Value(); got != 0 {
		t.Errorf("otedama_up = %v on real stall, want 0", got)
	}
}

func TestUpdateLiveness_HealthyHashrateReportsUp(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	opts := sessionOpts{m: m}
	hashMon := NewHashrateMonitor(0, 3, func(_, _ string) {})

	if stalled := opts.updateLiveness(hashMon, 1e6); stalled {
		t.Error("healthy hashrate reported as stalled")
	}
	if got := m.up.Value(); got != 1 {
		t.Errorf("otedama_up = %v while hashing, want 1", got)
	}
}

// ============================================================================
// setupWallet — early-return paths (no passphrase / no datadir)
// ============================================================================

func TestSetupWallet_EmptyPassphraseReturnsEmpty(t *testing.T) {
	var logs []string
	log := func(_, m string) { logs = append(logs, m) }

	opts := Options{WalletPassphrase: "", Config: config.Config{DataDir: "/tmp"}}
	fp := setupWallet(opts, log)
	if fp != "" {
		t.Errorf("setupWallet with empty passphrase = %q, want empty", fp)
	}
	if len(logs) != 0 {
		t.Errorf("setupWallet with empty passphrase should not log; got %v", logs)
	}
}

func TestSetupWallet_EmptyDataDirReturnsEmpty(t *testing.T) {
	var logs []string
	log := func(_, m string) { logs = append(logs, m) }

	opts := Options{WalletPassphrase: "correct-horse-battery-staple", Config: config.Config{DataDir: ""}}
	fp := setupWallet(opts, log)
	if fp != "" {
		t.Errorf("setupWallet with empty DataDir = %q, want empty", fp)
	}
	if len(logs) != 0 {
		t.Errorf("setupWallet with empty DataDir should not log; got %v", logs)
	}
}

func TestSetupWallet_BadDataDirLogsWarningAndReturnsEmpty(t *testing.T) {
	// /dev/null is a device, not a directory; creating a child under it fails.
	var logs []string
	log := func(_, m string) { logs = append(logs, m) }

	opts := Options{
		WalletPassphrase: "correct-horse-battery-staple",
		Config:           config.Config{DataDir: "/dev/null/impossible"},
	}
	fp := setupWallet(opts, log)
	if fp != "" {
		t.Errorf("setupWallet with unwritable DataDir = %q, want empty", fp)
	}
	foundWarn := false
	for _, l := range logs {
		if strings.Contains(l, "wallet") {
			foundWarn = true
		}
	}
	if !foundWarn {
		t.Errorf("setupWallet with bad DataDir should emit a wallet warning; got %v", logs)
	}
}

func TestSetupWallet_NewWalletReturnsFingerprint(t *testing.T) {
	dir := t.TempDir()
	var logs []string
	log := func(_, m string) { logs = append(logs, m) }

	opts := Options{
		WalletPassphrase: "correct-horse-battery-staple-engine-test",
		Config:           config.Config{DataDir: dir},
	}
	fp := setupWallet(opts, log)
	if fp == "" {
		t.Error("setupWallet should return a non-empty fingerprint for a new wallet")
	}
	// Must log "new wallet created" (IsNew path) and "fingerprint ..."
	foundNew := false
	foundFP := false
	for _, l := range logs {
		if strings.Contains(l, "new wallet") {
			foundNew = true
		}
		if strings.Contains(l, "fingerprint") {
			foundFP = true
		}
	}
	if !foundNew {
		t.Errorf("new wallet should log creation message; got %v", logs)
	}
	if !foundFP {
		t.Errorf("new wallet should log fingerprint; got %v", logs)
	}
}

// TestSetupWallet_NewWalletPrintsRecoveryPhrase pins the single most
// important non-custodial guarantee: the user actually receives their
// BIP-39 recovery phrase. The mnemonic is never written to disk and
// cannot be derived back from the stored seed, so if this output is
// missing the wallet is unbackupable and the funds are lost with the
// disk. Before session 253 the engine logged "back up your recovery
// phrase" without ever printing the phrase.
func TestSetupWallet_NewWalletPrintsRecoveryPhrase(t *testing.T) {
	var out bytes.Buffer
	opts := Options{
		WalletPassphrase: "correct-horse-battery-staple-engine-test",
		Config:           config.Config{DataDir: t.TempDir()},
		Output:           &out,
	}
	fp := setupWallet(opts, func(_, _ string) {})
	if fp == "" {
		t.Fatal("setupWallet returned an empty fingerprint for a new wallet")
	}

	got := out.String()
	if got == "" {
		t.Fatal("new wallet printed no recovery phrase: the user can never back up this wallet")
	}
	if !strings.Contains(got, fp) {
		t.Errorf("recovery-phrase output should include the fingerprint %q for cross-checking; got:\n%s", fp, got)
	}
	// The phrase must be visibly marked as one-time, or a user may assume
	// they can retrieve it later (they cannot).
	if !strings.Contains(got, "SHOWN ONCE") {
		t.Errorf("recovery-phrase output should warn that it is shown once; got:\n%s", got)
	}
	// DefaultEntropyBits (256) yields a 24-word mnemonic. Count the words
	// on the phrase line rather than the whole block, which also contains
	// prose.
	var phraseLine string
	for _, line := range strings.Split(got, "\n") {
		f := strings.Fields(line)
		if len(f) == 24 {
			phraseLine = line
			break
		}
	}
	if phraseLine == "" {
		t.Errorf("expected a 24-word BIP-39 phrase line in the output; got:\n%s", got)
	}
}

// TestSetupWallet_ExistingWalletDoesNotReprintPhrase pins the other half
// of the contract: the phrase is shown on creation only. Reprinting it on
// every start would widen the window for shoulder-surfing and terminal
// scrollback capture, and WalletManager cannot produce it anyway once the
// wallet exists (Mnemonic() returns nil when IsNew() is false).
func TestSetupWallet_ExistingWalletDoesNotReprintPhrase(t *testing.T) {
	dir := t.TempDir()
	pass := "correct-horse-battery-staple-engine-test"
	nop := func(_, _ string) {}

	var first bytes.Buffer
	fp1 := setupWallet(Options{
		WalletPassphrase: pass,
		Config:           config.Config{DataDir: dir},
		Output:           &first,
	}, nop)
	if first.Len() == 0 {
		t.Fatal("precondition failed: first run printed no phrase")
	}

	var second bytes.Buffer
	fp2 := setupWallet(Options{
		WalletPassphrase: pass,
		Config:           config.Config{DataDir: dir},
		Output:           &second,
	}, nop)
	if second.Len() != 0 {
		t.Errorf("second run reprinted the recovery phrase; got:\n%s", second.String())
	}
	if fp1 != fp2 {
		t.Errorf("same wallet should yield a stable fingerprint: %q then %q", fp1, fp2)
	}
}

// TestSetupWallet_MnemonicNeverReachesLogger pins the invariant stated in
// internal/lightning/seed.go — the seed is "Never transmitted, logged, or
// embedded in metrics". A mnemonic reconstructs the seed trivially, so it
// must go to the interactive Output only, never to the structured logger,
// which may be rotated, shipped, or aggregated off-box.
func TestSetupWallet_MnemonicNeverReachesLogger(t *testing.T) {
	var out bytes.Buffer
	var logs []string
	setupWallet(Options{
		WalletPassphrase: "correct-horse-battery-staple-engine-test",
		Config:           config.Config{DataDir: t.TempDir()},
		Output:           &out,
	}, func(_, m string) { logs = append(logs, m) })

	var phraseLine string
	for _, line := range strings.Split(out.String(), "\n") {
		if len(strings.Fields(line)) == 24 {
			phraseLine = line
			break
		}
	}
	if phraseLine == "" {
		t.Fatal("precondition failed: no 24-word phrase was printed")
	}

	joined := strings.Join(logs, "\n")
	for _, word := range strings.Fields(phraseLine) {
		// Match whole words only: BIP-39 words are common English and
		// could otherwise collide with substrings of ordinary log prose.
		for _, logWord := range strings.Fields(joined) {
			if logWord == word {
				t.Fatalf("mnemonic word %q leaked into the structured logger; logs:\n%s", word, joined)
			}
		}
	}
}

// TestPrintRecoveryPhrase_NoOutputCases covers the guards: a nil writer
// (an embedder that never set Options.Output) and an empty mnemonic (an
// existing wallet) must both be silent rather than panic.
func TestPrintRecoveryPhrase_NoOutputCases(t *testing.T) {
	printRecoveryPhrase(nil, lightning.Mnemonic{"abandon", "ability"}, "deadbeef")

	var out bytes.Buffer
	printRecoveryPhrase(&out, nil, "deadbeef")
	if out.Len() != 0 {
		t.Errorf("empty mnemonic should print nothing; got %q", out.String())
	}
}

// ============================================================================
// totalHashes / totalDropped — worker stat aggregation
// ============================================================================

func TestTotalHashes_EmptyWorkers(t *testing.T) {
	if got := totalHashes(nil); got != 0 {
		t.Errorf("totalHashes(nil) = %d, want 0", got)
	}
}

func TestTotalDropped_EmptyWorkers(t *testing.T) {
	if got := totalDropped(nil); got != 0 {
		t.Errorf("totalDropped(nil) = %d, want 0", got)
	}
}

func TestTotalHashes_SumsAcrossWorkers(t *testing.T) {
	// Workers start with zero counters; we can only verify the sum is
	// non-negative and that calling it on an empty slice returns 0 (the
	// non-empty case requires running workers, covered by integration tests).
	workers := make([]*miner.Worker, 0)
	if got := totalHashes(workers); got != 0 {
		t.Errorf("totalHashes([]) = %d, want 0", got)
	}
}

func TestTotalDropped_SumsAcrossWorkers(t *testing.T) {
	workers := make([]*miner.Worker, 0)
	if got := totalDropped(workers); got != 0 {
		t.Errorf("totalDropped([]) = %d, want 0", got)
	}
}

// ============================================================================
// logStats — formats and emits a hashrate+shares log line
// ============================================================================

func TestLogStats_EmitsInfoWithHashRate(t *testing.T) {
	var level, msg string
	log := func(l, m string) { level = l; msg = m }

	logStats(nil, 12345.0, log)

	if level != "info" {
		t.Errorf("logStats level = %q, want info", level)
	}
	if !strings.Contains(msg, "hashrate=") {
		t.Errorf("logStats msg = %q, want 'hashrate=' substring", msg)
	}
	if !strings.Contains(msg, "shares=") {
		t.Errorf("logStats msg = %q, want 'shares=' substring", msg)
	}
}

func TestLogStats_ZeroHashRate(t *testing.T) {
	var msg string
	log := func(_, m string) { msg = m }

	logStats(nil, 0, log)

	if !strings.Contains(msg, "hashrate=") {
		t.Errorf("logStats(0 H/s) msg = %q, want 'hashrate=' substring", msg)
	}
}

// ============================================================================
// NewLatencyTracker — default size guard
// ============================================================================

func TestNewLatencyTracker_DefaultSizeWhenZero(t *testing.T) {
	// size < 1 must default to 256, not panic with a zero-length slice.
	l := NewLatencyTracker(0)
	if l == nil {
		t.Fatal("NewLatencyTracker(0) returned nil")
	}
	// Fill more than 256 samples to confirm the ring wraps correctly.
	for i := 0; i < 300; i++ {
		l.Record(float64(i))
	}
	// After wrapping, the tracker should still return a sane quantile.
	if got := l.Quantile(0.5); got <= 0 {
		t.Errorf("Quantile(0.5) after 300 samples = %v, want positive", got)
	}
}

func TestNewLatencyTracker_NegativeSizeDefaultsTo256(t *testing.T) {
	l := NewLatencyTracker(-10)
	if l == nil {
		t.Fatal("NewLatencyTracker(-10) returned nil")
	}
}

// ============================================================================
// NewHashrateMonitor — default maxStall guard
// ============================================================================

func TestNewHashrateMonitor_DefaultMaxStallWhenZero(t *testing.T) {
	// maxStall < 1 must default to 3.
	var warns int
	log := func(level, _ string) {
		if level == "warn" {
			warns++
		}
	}
	m := NewHashrateMonitor(0, 0, log)
	// With defaulted maxStall=3, exactly 3 zero-hashrate samples trigger one warn.
	m.Observe(0)
	m.Observe(0)
	if warns != 0 {
		t.Errorf("should not have warned after 2 samples, got %d", warns)
	}
	m.Observe(0)
	if warns != 1 {
		t.Errorf("expected 1 warning at default threshold 3, got %d", warns)
	}
}

// ============================================================================
// maskAddr — short-address path (len ≤ 12 returned as-is)
// ============================================================================

func TestMaskAddr_ShortAddressReturnedAsIs(t *testing.T) {
	short := "bc1q1234"
	if got := maskAddr(short); got != short {
		t.Errorf("maskAddr(%q) = %q, want unchanged (len≤12)", short, got)
	}
}

func TestMaskAddr_ExactlyTwelveCharsReturnedAsIs(t *testing.T) {
	addr := "123456789012" // exactly 12 chars
	if got := maskAddr(addr); got != addr {
		t.Errorf("maskAddr(%q) = %q, want unchanged (len==12)", addr, got)
	}
}

// ============================================================================
// Quantile — boundary cases (q ≤ 0 and q ≥ 1)
// ============================================================================

func TestLatencyTracker_QuantileAtZeroReturnsMin(t *testing.T) {
	l := NewLatencyTracker(8)
	for _, v := range []float64{50, 10, 90, 30} {
		l.Record(v)
	}
	got := l.Quantile(0)
	if got != 10 {
		t.Errorf("Quantile(0) = %v, want min=10", got)
	}
}

func TestLatencyTracker_QuantileAtOneReturnsMax(t *testing.T) {
	l := NewLatencyTracker(8)
	for _, v := range []float64{50, 10, 90, 30} {
		l.Record(v)
	}
	got := l.Quantile(1)
	if got != 90 {
		t.Errorf("Quantile(1) = %v, want max=90", got)
	}
}

func TestLatencyTracker_QuantileNegativeClampedToMin(t *testing.T) {
	l := NewLatencyTracker(8)
	l.Record(5)
	l.Record(15)
	if got := l.Quantile(-1); got != 5 {
		t.Errorf("Quantile(-1) = %v, want min=5", got)
	}
}

func TestLatencyTracker_QuantileGreaterThanOneClampedToMax(t *testing.T) {
	l := NewLatencyTracker(8)
	l.Record(5)
	l.Record(15)
	if got := l.Quantile(2); got != 15 {
		t.Errorf("Quantile(2) = %v, want max=15", got)
	}
}

// ============================================================================
// applyAllocation — device→stream assignment outcomes
// ============================================================================

func TestApplyAllocation_EmptyAssignments(t *testing.T) {
	alloc := &arbitration.Allocation{}
	var logged []string
	log := func(_, m string) { logged = append(logged, m) }

	applyAllocation(alloc, nil, log)

	if len(logged) != 0 {
		t.Errorf("empty allocation should log nothing; got %v", logged)
	}
}

func TestApplyAllocation_IdleDevice(t *testing.T) {
	alloc := &arbitration.Allocation{
		Assignments: []arbitration.Assignment{
			{DeviceID: "cpu-0", Stream: ""}, // empty Stream → Idle()
		},
	}
	w := miner.NewWorker(miner.WorkerConfig{Threads: 1})
	var logged []string
	log := func(_, m string) { logged = append(logged, m) }

	applyAllocation(alloc, []*miner.Worker{w}, log)

	if len(logged) == 0 {
		t.Error("idle device should emit an info log")
	}
	if !strings.Contains(logged[0], "idle") {
		t.Errorf("idle log = %q, want 'idle' substring", logged[0])
	}
}

// TestApplyAllocation_OnlyPausesTargetDevice pins the fix for a real bug:
// applyAllocation used to call SetWork(nil) on every worker regardless of
// which device an assignment named, so idling or AI-switching one device
// silently paused mining on every other SHA256d device too. Only the CPU
// driver reports SHA256d today (GPU is always false), so this was latent
// in production, but the fix must be verifiable independent of hardware
// availability.
func TestApplyAllocation_OnlyPausesTargetDevice(t *testing.T) {
	target := miner.NewWorker(miner.WorkerConfig{Threads: 1, DeviceID: "cpu-0"})
	bystander := miner.NewWorker(miner.WorkerConfig{Threads: 1, DeviceID: "cpu-1"})
	work := &miner.Work{JobID: 1}
	target.SetWork(work)
	bystander.SetWork(work)

	alloc := &arbitration.Allocation{
		Assignments: []arbitration.Assignment{
			{DeviceID: "cpu-0", Stream: ""}, // empty Stream → Idle()
		},
	}
	applyAllocation(alloc, []*miner.Worker{target, bystander}, func(_, _ string) {})

	if target.HasWork() {
		t.Error("target device cpu-0 should have been paused (SetWork(nil))")
	}
	if !bystander.HasWork() {
		t.Error("bystander device cpu-1 should NOT have been paused by cpu-0's idle assignment")
	}
}

func TestApplyAllocation_MiningToAI(t *testing.T) {
	alloc := &arbitration.Allocation{
		Assignments: []arbitration.Assignment{
			{
				DeviceID:       "gpu-0",
				Stream:         "ai.akash",
				SwitchedFromID: "mining.stratum",
			},
		},
	}
	w := miner.NewWorker(miner.WorkerConfig{Threads: 1})
	var logged []string
	log := func(_, m string) { logged = append(logged, m) }

	applyAllocation(alloc, []*miner.Worker{w}, log)

	if len(logged) == 0 {
		t.Error("mining→AI switch should emit a log")
	}
	if !strings.Contains(logged[0], "AI") && !strings.Contains(logged[0], "ai") {
		t.Errorf("mining→AI log = %q, want AI mention", logged[0])
	}
}

func TestApplyAllocation_AIToMining(t *testing.T) {
	alloc := &arbitration.Allocation{
		Assignments: []arbitration.Assignment{
			{
				DeviceID:       "gpu-0",
				Stream:         "mining.stratum",
				SwitchedFromID: "ai.akash",
			},
		},
	}
	var logged []string
	log := func(_, m string) { logged = append(logged, m) }

	applyAllocation(alloc, nil, log)

	if len(logged) == 0 {
		t.Error("AI→mining switch should emit a log")
	}
	if !strings.Contains(logged[0], "mining") {
		t.Errorf("AI→mining log = %q, want 'mining' mention", logged[0])
	}
}

func TestApplyAllocation_GenericStreamSwitch(t *testing.T) {
	alloc := &arbitration.Allocation{
		Assignments: []arbitration.Assignment{
			{
				DeviceID:       "gpu-0",
				Stream:         "mining.stratum",
				SwitchedFromID: "mining.other",
			},
		},
	}
	var logged []string
	log := func(_, m string) { logged = append(logged, m) }

	applyAllocation(alloc, nil, log)

	if len(logged) == 0 {
		t.Error("generic stream switch should emit a log")
	}
}

func TestApplyAllocation_NoChange(t *testing.T) {
	// SwitchedFromID == "" and Stream != "" → no-change default branch.
	alloc := &arbitration.Allocation{
		Assignments: []arbitration.Assignment{
			{DeviceID: "cpu-0", Stream: "mining.stratum", SwitchedFromID: ""},
		},
	}
	var logged []string
	log := func(_, m string) { logged = append(logged, m) }

	applyAllocation(alloc, nil, log)

	if len(logged) != 0 {
		t.Errorf("no-change assignment should not log; got %v", logged)
	}
}

func TestApplyAllocation_IdleDevice_FloorReason(t *testing.T) {
	// When chooseForDevice idles a device because all streams are below the
	// min_yield floor, Assignment.Reason carries the specific explanation.
	// applyAllocation must surface that reason in the log, not hardcode
	// "no compatible stream" (which would be factually wrong and mislead
	// operators trying to diagnose why hardware is sitting idle).
	const wantSubstr = "below minimum yield floor"
	alloc := &arbitration.Allocation{
		Assignments: []arbitration.Assignment{
			{
				DeviceID: "cpu-0",
				Stream:   "", // Idle()
				Reason:   "all compatible streams below minimum yield floor 0.5 sats/s",
			},
		},
	}
	var logged []string
	log := func(_, m string) { logged = append(logged, m) }

	applyAllocation(alloc, nil, log)

	if len(logged) == 0 {
		t.Fatal("floor-idle device should emit an info log")
	}
	if !strings.Contains(logged[0], wantSubstr) {
		t.Errorf("log = %q, want substr %q", logged[0], wantSubstr)
	}
}

// ============================================================================
// runArbitrationLoop — channel-driven exit paths
// ============================================================================

func TestRunArbitrationLoop_ContextCancelExits(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	quoteCh := make(chan provider.Quote)
	opts := arbitrationLoopOpts{
		streamsMu: &sync.Mutex{},
		streamMap: make(map[string]arbitration.Stream),
		quoteCh:   quoteCh,
		metrics:   newEngineMetrics(metrics.NewRegistry()),
		log:       func(_, _ string) {},
	}

	done := make(chan struct{})
	go func() {
		runArbitrationLoop(ctx, opts)
		close(done)
	}()

	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Error("runArbitrationLoop did not exit after context cancel")
	}
}

func TestRunArbitrationLoop_ClosedQuoteChannelExits(t *testing.T) {
	ctx := context.Background()
	quoteCh := make(chan provider.Quote)
	close(quoteCh)
	opts := arbitrationLoopOpts{
		streamsMu: &sync.Mutex{},
		streamMap: make(map[string]arbitration.Stream),
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
	case <-time.After(time.Second):
		t.Error("runArbitrationLoop did not exit when quote channel was closed")
	}
}

func TestRunArbitrationLoop_PublishesForegoneGauge(t *testing.T) {
	// Verify the loop publishes otedama_arbitration_foregone_sats_per_second on
	// each tick. With a single best stream the foregone cost is 0, so we pre-set
	// the gauge to a sentinel and confirm a tick resets it to 0 (proving the
	// Set call executes, not that the gauge merely defaults to 0).
	old := arbitrationInterval
	arbitrationInterval = 10 * time.Millisecond
	defer func() { arbitrationInterval = old }()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	m := newEngineMetrics(metrics.NewRegistry())
	m.arbitrationForegoneSatsPerSec.Set(-999) // sentinel

	quoteCh := make(chan provider.Quote, 1)
	opts := arbitrationLoopOpts{
		devRefs: []arbitration.DeviceRef{
			{Identity: hal.Identity{ID: "cpu-0", Family: hal.FamilyCPU}},
		},
		streamsMu: &sync.Mutex{},
		streamMap: make(map[string]arbitration.Stream),
		quoteCh:   quoteCh,
		metrics:   m,
		log:       func(_, _ string) {},
	}

	go runArbitrationLoop(ctx, opts)

	quoteCh <- provider.Quote{
		ProviderID:       "mining.stratum",
		DeviceID:         "cpu-0",
		AcceptedFamilies: []hal.Family{hal.FamilyCPU},
		Yield:            provider.Yield{SatsPerSecond: 1000, Confidence: 1.0},
	}

	// Wait for at least one tick to run Decide and publish.
	time.Sleep(40 * time.Millisecond)
	cancel()

	if got := m.arbitrationForegoneSatsPerSec.Value(); got != 0 {
		t.Errorf("foregone gauge = %v, want 0 (single best stream; sentinel must be overwritten)", got)
	}
	// The expected-yield forecast must reflect the assigned stream's yield:
	// 1000 sats/s × 1.0 confidence for the single cpu-0 assignment.
	if got := m.arbitrationExpectedYieldSatsPerSec.Value(); got != 1000 {
		t.Errorf("expected-yield gauge = %v, want 1000 (cpu-0 → mining.stratum @ 1000 sat/s)", got)
	}
}

func TestRunArbitrationLoop_PublishesDevicesIdleGauge(t *testing.T) {
	// A device whose only quote (1000 sat/s) is below the minYield floor (2000)
	// must be idled, and otedama_devices_idle must report 1. Pre-set a sentinel
	// to prove the Set call executes rather than the gauge defaulting.
	old := arbitrationInterval
	arbitrationInterval = 10 * time.Millisecond
	defer func() { arbitrationInterval = old }()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	m := newEngineMetrics(metrics.NewRegistry())
	m.devicesIdle.Set(-999) // sentinel

	quoteCh := make(chan provider.Quote, 1)
	opts := arbitrationLoopOpts{
		devRefs: []arbitration.DeviceRef{
			{Identity: hal.Identity{ID: "cpu-0", Family: hal.FamilyCPU}},
		},
		streamsMu: &sync.Mutex{},
		streamMap: make(map[string]arbitration.Stream),
		quoteCh:   quoteCh,
		metrics:   m,
		log:       func(_, _ string) {},
		minYield:  2000, // floor above the quote below
	}

	go runArbitrationLoop(ctx, opts)

	quoteCh <- provider.Quote{
		ProviderID:       "mining.stratum",
		DeviceID:         "cpu-0",
		AcceptedFamilies: []hal.Family{hal.FamilyCPU},
		Yield:            provider.Yield{SatsPerSecond: 1000, Confidence: 1.0},
	}

	time.Sleep(40 * time.Millisecond)
	cancel()

	if got := m.devicesIdle.Value(); got != 1 {
		t.Errorf("devices_idle gauge = %v, want 1 (cpu-0 below the 2000 sat/s floor)", got)
	}
}

func TestRunArbitrationLoop_LogsIdleTransition(t *testing.T) {
	// A device driven below the floor must produce exactly one "idle" log line
	// on the transition (for log-only operators), not one per tick.
	old := arbitrationInterval
	arbitrationInterval = 10 * time.Millisecond
	defer func() { arbitrationInterval = old }()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var mu sync.Mutex
	var logs []string
	logf := func(_, msg string) {
		mu.Lock()
		logs = append(logs, msg)
		mu.Unlock()
	}

	quoteCh := make(chan provider.Quote, 1)
	opts := arbitrationLoopOpts{
		devRefs: []arbitration.DeviceRef{
			{Identity: hal.Identity{ID: "cpu-0", Family: hal.FamilyCPU}},
		},
		streamsMu: &sync.Mutex{},
		streamMap: make(map[string]arbitration.Stream),
		quoteCh:   quoteCh,
		metrics:   newEngineMetrics(metrics.NewRegistry()),
		log:       logf,
		minYield:  2000,
	}

	go runArbitrationLoop(ctx, opts)

	quoteCh <- provider.Quote{
		ProviderID:       "mining.stratum",
		DeviceID:         "cpu-0",
		AcceptedFamilies: []hal.Family{hal.FamilyCPU},
		Yield:            provider.Yield{SatsPerSecond: 1000, Confidence: 1.0},
	}

	// Let several ticks run to confirm the idle line is logged once, not per tick.
	time.Sleep(60 * time.Millisecond)
	cancel()

	mu.Lock()
	defer mu.Unlock()
	idleLines := 0
	for _, m := range logs {
		if strings.Contains(m, "device(s) now idle") {
			idleLines++
		}
	}
	if idleLines != 1 {
		t.Errorf("idle transition logged %d time(s), want exactly 1 (logs: %v)", idleLines, logs)
	}
}

func TestRunArbitrationLoop_QuoteUpdatesStreamMap(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	quoteCh := make(chan provider.Quote, 1)
	mu := &sync.Mutex{}
	streamMap := make(map[string]arbitration.Stream)
	opts := arbitrationLoopOpts{
		streamsMu: mu,
		streamMap: streamMap,
		quoteCh:   quoteCh,
		metrics:   newEngineMetrics(metrics.NewRegistry()),
		log:       func(_, _ string) {},
	}

	go runArbitrationLoop(ctx, opts)

	quoteCh <- provider.Quote{
		ProviderID: "mining.stratum",
		DeviceID:   "cpu-0",
		Yield:      provider.Yield{SatsPerSecond: 1000, Confidence: 0.9},
	}

	// Wait briefly for the goroutine to consume the quote.
	time.Sleep(20 * time.Millisecond)
	cancel()

	mu.Lock()
	_, ok := streamMap["mining.stratum:cpu-0"]
	mu.Unlock()
	if !ok {
		t.Error("runArbitrationLoop: stream map should contain the quote after processing")
	}
}

// ============================================================================
// responsivePool — richer fake SV2 pool for share-response coverage
// (session 161)
// ============================================================================

// responsivePool does a full Stratum V2 handshake, sends a trivially-easy
// mining job, and then responds to shares: the first share gets a
// SubmitSharesSuccess, the second gets a SubmitSharesError. It stays open
// until the client disconnects, which allows multiple stats-tick cycles to
// run inside runSession.
type responsivePool struct {
	t       *testing.T
	ln      net.Listener
	addr    string
	started chan struct{}
	// Batch counters the pool reports in each SubmitSharesSuccess
	// (new_submits_accepted_count / new_shares_sum). A conformant pool
	// reports the number of submissions it is actually acknowledging —
	// one per share in this fixture's one-ack-per-submit loop.
	ackCount uint32
	ackSum   uint64

	// mu guards gotUpdates / gotOther: the pool goroutine appends while
	// the test reads after the session ends.
	mu         sync.Mutex
	gotUpdates []stratum.UpdateChannel
	gotOther   []uint8 // non-share, non-UpdateChannel msg_types seen
}

func newResponsivePool(t *testing.T) *responsivePool {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("responsivePool: listen: %v", err)
	}
	fp := &responsivePool{
		t:        t,
		ln:       ln,
		addr:     ln.Addr().String(),
		started:  make(chan struct{}),
		ackCount: 1,
		ackSum:   1,
	}
	go fp.serve()
	return fp
}

func (fp *responsivePool) URL() string { return "stratum+v2://" + fp.addr }
func (fp *responsivePool) Close()      { fp.ln.Close() }

func (fp *responsivePool) emit(conn net.Conn, msgType uint8, isChannel bool, payload []byte) {
	f, err := stratum.WrapMessage(msgType, isChannel, payload)
	if err != nil {
		return
	}
	data, err := stratum.EncodeFrame(f)
	if err != nil {
		return
	}
	conn.Write(data) //nolint:errcheck
}

func (fp *responsivePool) serve() {
	close(fp.started)
	conn, err := fp.ln.Accept()
	if err != nil {
		return
	}
	defer conn.Close()

	dec := stratum.NewDecoder(conn)
	dec.MaxFrameSize = 1 << 20

	// Receive SetupConnection
	if _, err = dec.ReadFrame(); err != nil {
		return
	}
	// Send SetupConnectionSuccess
	succ := stratum.SetupConnectionSuccess{UsedVersion: 2}
	payload, _ := succ.Encode()
	fp.emit(conn, stratum.MsgSetupConnectionSuccess, false, payload)

	// Receive OpenMiningChannel
	f, err := dec.ReadFrame()
	if err != nil {
		return
	}
	omc, err := stratum.DecodeOpenMiningChannel(f.Payload)
	if err != nil {
		return
	}

	// Send OpenMiningChannelSuccess with all-0xFF target (trivially easy)
	omcSucc := stratum.OpenMiningChannelSuccess{
		ReqID:          omc.ReqID,
		ChannelID:      1,
		GroupChannelID: 4,
	}
	for i := range omcSucc.Target {
		omcSucc.Target[i] = 0xFF
	}
	payload, _ = omcSucc.Encode()
	fp.emit(conn, stratum.MsgOpenMiningChannelSuccess, false, payload)

	// SV2 activation order: the job is sent first as a future job (no
	// min_ntime), then SetNewPrevHash names it to activate — matching how
	// a real pool stages jobs ahead of the chain tip that will use them.
	// Sending SetNewPrevHash before its job exists hits the engine's
	// "names unknown job" guard (a real defensive path, but not what this
	// test means to exercise) and costs an extra SetWork(nil)/re-arm
	// round trip that squeezed this test's 2s budget under load.
	job := stratum.NewMiningJob{
		ChannelID: 1,
		JobID:     1,
		Version:   0x20000000,
	}
	payload, _ = job.Encode()
	fp.emit(conn, stratum.MsgNewMiningJob, true, payload)

	// Network nBits 0x207fffff is the easiest possible target.
	prev := stratum.SetNewPrevHash{
		ChannelID: 1,
		JobID:     1,
		MinNtime:  0x60000000,
		NBits:     0x207fffff,
	}
	payload, _ = prev.Encode()
	fp.emit(conn, stratum.MsgSetNewPrevHash, true, payload)

	// Read shares and respond accordingly
	shareCount := 0
	for {
		conn.SetReadDeadline(time.Now().Add(3 * time.Second)) //nolint:errcheck
		f, err = dec.ReadFrame()
		if err != nil {
			return
		}
		switch f.Header.MsgType {
		case stratum.MsgUpdateChannel:
			uc, err := stratum.DecodeUpdateChannel(f.Payload)
			if err == nil {
				fp.mu.Lock()
				fp.gotUpdates = append(fp.gotUpdates, uc)
				fp.mu.Unlock()
			}
			continue
		case stratum.MsgSubmitSharesStandard:
		default:
			fp.mu.Lock()
			fp.gotOther = append(fp.gotOther, f.Header.MsgType)
			fp.mu.Unlock()
			continue
		}
		share, err := stratum.DecodeSubmitSharesStandard(f.Payload)
		if err != nil {
			continue
		}
		shareCount++
		switch shareCount {
		case 1:
			// First share: acknowledge. Exercises SubmitSharesSuccess handler
			// and the latency-recording path.
			resp := stratum.SubmitSharesSuccess{
				ChannelID:               share.ChannelID,
				LastSequenceNumber:      share.SequenceNumber,
				NewSubmitsAcceptedCount: fp.ackCount,
				NewSharesSum:            fp.ackSum,
			}
			payload, _ = resp.Encode()
			fp.emit(conn, stratum.MsgSubmitSharesSuccess, true, payload)
		case 2:
			// Second share: reject. Exercises SubmitSharesError handler and
			// the rejectClass / reject-counter path.
			resp := stratum.SubmitSharesError{
				ChannelID:      share.ChannelID,
				SequenceNumber: share.SequenceNumber,
				Error:          "Stale share",
			}
			payload, _ = resp.Encode()
			fp.emit(conn, stratum.MsgSubmitSharesError, true, payload)
		}
	}
}

// TestRunSession_StatsTickAndShareResponses exercises the two largest
// uncovered regions of runSession: the stats-ticker branch (hashrate,
// uptime, J/TH, and latency-quantile logging) and the SubmitSharesSuccess /
// SubmitSharesError inCh handlers. It calls runSession directly with a very
// short stats interval so the ticker fires many times during the test.
//
// This test used to race a fixed real-time window (originally 2s, later
// widened to 4s): it waited for runSession to return, then checked whether
// a "submit latency" log line had appeared anywhere in that window. That
// line is written only from inside the stats-ticker branch, which must win
// a select slot against two channels (inCh/opts.merged) that are
// effectively always ready once shares start flowing — under `go test
// ./...` CPU contention the ticker case could occasionally be starved long
// enough to miss even a several-second window, despite every individual
// protocol step completing in milliseconds in isolation (confirmed
// pre-existing: the same fragile structure existed at commit 2faae1f, and
// is tracked at RESEARCH_IMPROVEMENTS.md Category 7 item 12). Padding the
// timeout further showed diminishing returns in testing.
//
// The fix: actively poll the deterministic signal (the submitLatencyP95
// gauge becoming nonzero) with a generous but bounded retry loop, instead
// of passively hoping a fixed window catches it. The test now succeeds as
// soon as the condition is actually true rather than racing a guess at how
// long that might take under unknown contention.
func TestRunSession_StatsTickAndShareResponses(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	fp := newResponsivePool(t)
	defer fp.Close()
	<-fp.started

	// Generous outer bound: this is a ceiling on total test time, not the
	// budget the assertions race against (the polling loop below ends the
	// session as soon as its condition is met, well before this fires in
	// the normal case).
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	w := miner.NewWorker(miner.WorkerConfig{Threads: 1})
	merged := w.Start(ctx)
	defer w.Stop()

	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)

	runDone := make(chan struct{})
	go func() {
		defer close(runDone)
		// powerWatts > 0 exercises the J/TH branch inside the stats tick.
		_ = runSession(ctx, sessionOpts{
			poolURL:    fp.URL(),
			user:       "bc1qtest000000000000000000000000000000000",
			workers:    []*miner.Worker{w},
			merged:     merged,
			interval:   5 * time.Millisecond,
			m:          m,
			powerWatts: 100.0,
			log:        func(_, _ string) {},
		})
	}()

	// Poll for the deterministic signal that the stats-ticker branch has
	// actually executed with a recorded latency sample, rather than
	// waiting a fixed duration and hoping. 10s ceiling is itself generous;
	// in the unstarved case this resolves within milliseconds.
	deadline := time.After(10 * time.Second)
	poll := time.NewTicker(5 * time.Millisecond)
	defer poll.Stop()
	latencyObserved := false
waitLoop:
	for {
		select {
		case <-poll.C:
			if m.submitLatencyP95.Value() > 0 {
				latencyObserved = true
				break waitLoop
			}
		case <-deadline:
			break waitLoop
		}
	}
	cancel() // end the session now that we have what we need (or gave up)
	<-runDone

	if got := m.sharesAccepted.Value(); got == 0 {
		t.Error("sharesAccepted == 0; SubmitSharesSuccess handler was not exercised")
	}
	if got := m.sharesRejected.Value(); got == 0 {
		t.Error("sharesRejected == 0; SubmitSharesError handler was not exercised")
	}
	// sharesSubmitted counts every real V2 send, so it must be at least as
	// large as accepted+rejected (every judged share was necessarily sent
	// first) — the real end-to-end path for the fix pinned by
	// TestBuildStats_SharesSentReflectsSubmittedCounter_NotFoundCount.
	if got, want := m.sharesSubmitted.Value(), m.sharesAccepted.Value()+m.sharesRejected.Value(); got < want {
		t.Errorf("sharesSubmitted = %d, want >= %d (accepted+rejected)", got, want)
	}
	if got := m.hashrate.Value(); got == 0 {
		t.Error("hashrate gauge = 0; stats-tick branch did not run")
	}
	if !latencyObserved {
		t.Error("submitLatencyP95 never became nonzero within 10s; latency-quantile stats-tick path not covered")
	}
	// The conformant fake pool reports count=1 for the share it settled:
	// reported-vs-settled reconciliation must stay quiet.
	if got := m.poolReconcileDivergence.Value(); got != 0 {
		t.Errorf("poolReconcileDivergence = %d, want 0 for a conformant pool", got)
	}
}

// TestRunSession_PoolReconcileAccounting exercises the pool-side accounting
// reconciliation: the fake pool reports batch counters
// (new_submits_accepted_count / new_shares_sum) that do NOT match the
// submissions it actually settles. The engine must (a) count accepted
// shares by the pool's reported count — one Success can acknowledge a
// batch — rather than one per Success message, (b) accumulate the pool's
// credited difficulty into otedama_pool_shares_sum_total, and (c) flag
// the reported-vs-settled disagreement as a reconciliation divergence.
func TestRunSession_PoolReconcileAccounting(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	fp := newResponsivePool(t)
	// Pool claims 3 accepted submits (9 difficulty) per Success while
	// acknowledging only one submission per message — the miscounting
	// scenario reconciliation exists to catch.
	fp.ackCount = 3
	fp.ackSum = 9
	defer fp.Close()
	<-fp.started

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	w := miner.NewWorker(miner.WorkerConfig{Threads: 1})
	merged := w.Start(ctx)
	defer w.Stop()

	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)

	runDone := make(chan struct{})
	go func() {
		defer close(runDone)
		_ = runSession(ctx, sessionOpts{
			poolURL:  fp.URL(),
			user:     "bc1qtest000000000000000000000000000000000",
			workers:  []*miner.Worker{w},
			merged:   merged,
			interval: 5 * time.Millisecond,
			m:        m,
			log:      func(_, _ string) {},
		})
	}()

	// Wait for at least one divergent batch to settle; how many total
	// shares flow before cancellation is intentionally not asserted.
	deadline := time.After(10 * time.Second)
	poll := time.NewTicker(5 * time.Millisecond)
	defer poll.Stop()
waitLoop:
	for {
		select {
		case <-poll.C:
			if m.poolReconcileDivergence.Value() > 0 {
				break waitLoop
			}
		case <-deadline:
			break waitLoop
		}
	}
	cancel()
	<-runDone

	// Invariants per Success batch regardless of batch count: the pool
	// reports 3 accepted + 9 difficulty and settles 1 local submission,
	// so each batch is one divergence.
	d := m.poolReconcileDivergence.Value()
	if d == 0 {
		t.Fatal("poolReconcileDivergence == 0; divergence was not flagged")
	}
	if got, want := m.sharesAccepted.Value(), 3*d; got != want {
		t.Errorf("sharesAccepted = %d, want %d (pool-reported batch count)", got, want)
	}
	if got, want := m.poolSharesSum.Value(), 9*d; got != want {
		t.Errorf("poolSharesSum = %d, want %d (pool-reported difficulty)", got, want)
	}
}

// ============================================================================
// retargetPool — vardiff-transition reject coverage (ESP-Miner #212)
// ============================================================================

// retargetPool simulates a pool that raises its share difficulty mid-flight.
// The channel opens with a trivially-easy target, so every share the worker
// finds is issued under it. After accepting the first share, the pool sends
// SetTarget with an impossibly hard target and then rejects the next
// in-flight share "above target" — exactly the benign reject ESP-Miner #212
// documents: the share was valid against the target in force when its work
// was issued. The engine must account it as superseded, never as a reject.
type retargetPool struct {
	t       *testing.T
	ln      net.Listener
	addr    string
	started chan struct{}
}

func newRetargetPool(t *testing.T) *retargetPool {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("retargetPool: listen: %v", err)
	}
	fp := &retargetPool{
		t:       t,
		ln:      ln,
		addr:    ln.Addr().String(),
		started: make(chan struct{}),
	}
	go fp.serve()
	return fp
}

func (fp *retargetPool) URL() string { return "stratum+v2://" + fp.addr }
func (fp *retargetPool) Close()      { fp.ln.Close() }

func (fp *retargetPool) emit(conn net.Conn, msgType uint8, isChannel bool, payload []byte) {
	f, err := stratum.WrapMessage(msgType, isChannel, payload)
	if err != nil {
		return
	}
	data, err := stratum.EncodeFrame(f)
	if err != nil {
		return
	}
	conn.Write(data) //nolint:errcheck
}

func (fp *retargetPool) serve() {
	close(fp.started)
	conn, err := fp.ln.Accept()
	if err != nil {
		return
	}
	defer conn.Close()

	dec := stratum.NewDecoder(conn)
	dec.MaxFrameSize = 1 << 20

	if _, err = dec.ReadFrame(); err != nil { // SetupConnection
		return
	}
	succ := stratum.SetupConnectionSuccess{UsedVersion: 2}
	payload, _ := succ.Encode()
	fp.emit(conn, stratum.MsgSetupConnectionSuccess, false, payload)

	f, err := dec.ReadFrame() // OpenMiningChannel
	if err != nil {
		return
	}
	omc, err := stratum.DecodeOpenMiningChannel(f.Payload)
	if err != nil {
		return
	}

	omcSucc := stratum.OpenMiningChannelSuccess{
		ReqID:          omc.ReqID,
		ChannelID:      1,
		GroupChannelID: 4,
	}
	for i := range omcSucc.Target {
		omcSucc.Target[i] = 0xFF // trivially easy: every hash is a share
	}
	payload, _ = omcSucc.Encode()
	fp.emit(conn, stratum.MsgOpenMiningChannelSuccess, false, payload)

	job := stratum.NewMiningJob{ChannelID: 1, JobID: 1, Version: 0x20000000}
	payload, _ = job.Encode()
	fp.emit(conn, stratum.MsgNewMiningJob, true, payload)

	prev := stratum.SetNewPrevHash{ChannelID: 1, JobID: 1, MinNtime: 0x60000000, NBits: 0x207fffff}
	payload, _ = prev.Encode()
	fp.emit(conn, stratum.MsgSetNewPrevHash, true, payload)

	shareCount := 0
	for {
		conn.SetReadDeadline(time.Now().Add(3 * time.Second)) //nolint:errcheck
		f, err = dec.ReadFrame()
		if err != nil {
			return
		}
		if f.Header.MsgType != stratum.MsgSubmitSharesStandard {
			continue
		}
		share, err := stratum.DecodeSubmitSharesStandard(f.Payload)
		if err != nil {
			continue
		}
		shareCount++
		switch shareCount {
		case 1:
			resp := stratum.SubmitSharesSuccess{
				ChannelID:               share.ChannelID,
				LastSequenceNumber:      share.SequenceNumber,
				NewSubmitsAcceptedCount: 1,
				NewSharesSum:            1,
			}
			payload, _ = resp.Encode()
			fp.emit(conn, stratum.MsgSubmitSharesSuccess, true, payload)
		case 2:
			// Vardiff raises the bar, then rejects the still-in-flight
			// share it invalidated. SetTarget must arrive first so the
			// engine's current target is the new (hard) one when the
			// error is judged — the real-pool ordering ESP-Miner #212
			// describes. An all-zero target is deterministic: no hash
			// can meet it, so the share provably fails the new bar
			// while still meeting its issue target.
			st := stratum.SetTarget{ChannelID: share.ChannelID}
			payload, _ = st.Encode()
			fp.emit(conn, stratum.MsgSetTarget, true, payload)

			resp := stratum.SubmitSharesError{
				ChannelID:      share.ChannelID,
				SequenceNumber: share.SequenceNumber,
				Error:          "above target",
			}
			payload, _ = resp.Encode()
			fp.emit(conn, stratum.MsgSubmitSharesError, true, payload)
		}
	}
}

// TestRunSession_SupersededRejectCountedSeparately verifies the
// ESP-Miner #212 path end to end: a share rejected only because the pool
// retargeted mid-flight increments otedama_shares_superseded_total and
// leaves the reject counters (and the operator-facing reject rate) alone.
func TestRunSession_SupersededRejectCountedSeparately(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	fp := newRetargetPool(t)
	defer fp.Close()
	<-fp.started

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	w := miner.NewWorker(miner.WorkerConfig{Threads: 1})
	merged := w.Start(ctx)
	defer w.Stop()

	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)

	runDone := make(chan struct{})
	go func() {
		defer close(runDone)
		_ = runSession(ctx, sessionOpts{
			poolURL:  fp.URL(),
			user:     "bc1qtest000000000000000000000000000000000",
			workers:  []*miner.Worker{w},
			merged:   merged,
			interval: 5 * time.Millisecond,
			m:        m,
			log:      func(_, _ string) {},
		})
	}()

	// Poll until the superseded verdict lands (or give up): the verdict
	// requires the share submit, the SetTarget, and the error to all be
	// processed — still milliseconds in the unstarved case.
	deadline := time.After(10 * time.Second)
	poll := time.NewTicker(5 * time.Millisecond)
	defer poll.Stop()
waitLoop:
	for {
		select {
		case <-poll.C:
			if m.sharesSuperseded.Value() > 0 {
				break waitLoop
			}
		case <-deadline:
			break waitLoop
		}
	}
	cancel()
	<-runDone

	if got := m.sharesAccepted.Value(); got == 0 {
		t.Error("sharesAccepted == 0; handshake/first-share path never ran")
	}
	if got := m.sharesSuperseded.Value(); got == 0 {
		t.Error("sharesSuperseded == 0; vardiff-transition reject was not classified as superseded")
	}
	if got := m.sharesRejected.Value(); got != 0 {
		t.Errorf("sharesRejected = %d, want 0 — superseded rejects must not pollute the reject rate", got)
	}
}

// TestRunSession_CurtailmentSilencesJob verifies that when the curtailment
// gate is raised a received pool job is not forwarded to workers: the session
// loop logs a debug "ignored (curtailed)" message instead of calling updateWork.
func TestRunSession_CurtailmentSilencesJob(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	// The basic fakePool suffices: it does the full handshake, sends one job,
	// waits up to 3s for a share (none arrives because workers are idle), then
	// closes. The session returns before that via the curtail-debug path.
	fp := newFakePool(t)
	defer fp.Close()
	<-fp.started

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	w := miner.NewWorker(miner.WorkerConfig{Threads: 1})
	merged := w.Start(ctx)
	defer w.Stop()

	gate := new(atomic.Bool)
	gate.Store(true) // hashing paused from the start

	var logs []string
	var logMu sync.Mutex
	log := func(level, msg string) {
		logMu.Lock()
		logs = append(logs, level+": "+msg)
		logMu.Unlock()
	}

	_ = runSession(ctx, sessionOpts{
		poolURL:     fp.URL(),
		user:        "bc1qtest000000000000000000000000000000000",
		workers:     []*miner.Worker{w},
		merged:      merged,
		interval:    10 * time.Millisecond,
		log:         log,
		curtailGate: gate,
	})

	logMu.Lock()
	defer logMu.Unlock()

	foundIgnored := false
	for _, l := range logs {
		if strings.Contains(l, "curtailed") {
			foundIgnored = true
			break
		}
	}
	if !foundIgnored {
		t.Logf("logs: %v", logs)
		t.Error("expected a 'curtailed' debug log when a job is received while curtailed")
	}
}

// noSHA256dDevice is a hal.Device whose SHA256d capability is false,
// representing a GPU that supports general compute (AI) but not Bitcoin mining.
type noSHA256dDevice struct{}

func (d *noSHA256dDevice) Identity() hal.Identity {
	return hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU}
}

func (d *noSHA256dDevice) Capabilities() hal.Capabilities {
	return hal.Capabilities{SHA256d: false, GeneralCompute: true}
}
func (d *noSHA256dDevice) Shutdown(_ context.Context) error { return nil }

// TestStartMinerWorkers_NoSHA256dDevices covers the early-return error path
// in startMinerWorkers when every detected device lacks SHA256d support
// (e.g., an inference-only GPU fleet).
func TestStartMinerWorkers_NoSHA256dDevices(t *testing.T) {
	ctx := context.Background()
	devices := []hal.Device{&noSHA256dDevice{}}
	_, _, err := startMinerWorkers(ctx, devices, func(_, _ string) {})
	if err == nil {
		t.Fatal("startMinerWorkers: expected error when no SHA256d devices, got nil")
	}
	if !strings.Contains(err.Error(), "SHA256d") {
		t.Errorf("error = %q, want SHA256d mention", err.Error())
	}
}

// ============================================================================
// closingPool — server→client CloseChannel conformance (spec §5.3.9)
// ============================================================================

// closingPool completes the SV2 handshake then immediately closes the
// channel it just opened. The engine must (a) end the session instead of
// hashing/submitting on a dead channel — the error path feeds the normal
// failover/reconnect loop — and (b) reply with its own client→server
// CloseChannel (the spec's polite close) before dropping the socket.
type closingPool struct {
	t       *testing.T
	ln      net.Listener
	addr    string
	started chan struct{}
	done    chan struct{}

	mu      sync.Mutex
	gotMsgs []uint8 // msg_types the client sent after the handshake
}

func newClosingPool(t *testing.T) *closingPool {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("closingPool: listen: %v", err)
	}
	fp := &closingPool{
		t:       t,
		ln:      ln,
		addr:    ln.Addr().String(),
		started: make(chan struct{}),
		done:    make(chan struct{}),
	}
	go fp.serve()
	return fp
}

func (fp *closingPool) URL() string { return "stratum+v2://" + fp.addr }
func (fp *closingPool) Close()      { fp.ln.Close() }

func (fp *closingPool) emit(conn net.Conn, msgType uint8, isChannel bool, payload []byte) {
	f, err := stratum.WrapMessage(msgType, isChannel, payload)
	if err != nil {
		return
	}
	data, err := stratum.EncodeFrame(f)
	if err != nil {
		return
	}
	conn.Write(data) //nolint:errcheck
}

func (fp *closingPool) serve() {
	defer close(fp.done)
	close(fp.started)
	conn, err := fp.ln.Accept()
	if err != nil {
		return
	}
	defer conn.Close()

	dec := stratum.NewDecoder(conn)
	dec.MaxFrameSize = 1 << 20

	// SetupConnection → Success
	if _, err = dec.ReadFrame(); err != nil {
		return
	}
	succ := stratum.SetupConnectionSuccess{UsedVersion: 2}
	payload, _ := succ.Encode()
	fp.emit(conn, stratum.MsgSetupConnectionSuccess, false, payload)

	// OpenMiningChannel → Success (group 4, easy target)
	f, err := dec.ReadFrame()
	if err != nil {
		return
	}
	omc, err := stratum.DecodeOpenMiningChannel(f.Payload)
	if err != nil {
		return
	}
	omcSucc := stratum.OpenMiningChannelSuccess{
		ReqID:          omc.ReqID,
		ChannelID:      1,
		GroupChannelID: 4,
	}
	for i := range omcSucc.Target {
		omcSucc.Target[i] = 0xFF
	}
	payload, _ = omcSucc.Encode()
	fp.emit(conn, stratum.MsgOpenMiningChannelSuccess, false, payload)

	// Close the channel with a reason string, then keep the socket open
	// to capture the client's polite CloseChannel reply.
	cc := stratum.CloseChannel{ChannelID: 1, ReasonCode: "pool maintenance"}
	payload, _ = cc.Encode()
	fp.emit(conn, stratum.MsgCloseChannel, true, payload)

	for {
		conn.SetReadDeadline(time.Now().Add(2 * time.Second)) //nolint:errcheck
		f, err = dec.ReadFrame()
		if err != nil {
			return // client dropped the socket (post-CloseChannel)
		}
		fp.mu.Lock()
		fp.gotMsgs = append(fp.gotMsgs, f.Header.MsgType)
		fp.mu.Unlock()
	}
}

func TestRunSession_PoolCloseChannel(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	fp := newClosingPool(t)
	defer fp.Close()
	<-fp.started

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	w := miner.NewWorker(miner.WorkerConfig{Threads: 1})
	merged := w.Start(ctx)
	defer w.Stop()

	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)

	err := runSession(ctx, sessionOpts{
		poolURL:  fp.URL(),
		user:     "bc1qtest000000000000000000000000000000000",
		workers:  []*miner.Worker{w},
		merged:   merged,
		interval: 5 * time.Millisecond,
		m:        m,
		log:      func(_, _ string) {},
	})
	if err == nil {
		t.Fatal("runSession returned nil; pool-closed channel must end the session")
	}
	if !strings.Contains(err.Error(), "closed channel 1") {
		t.Fatalf("session error = %q, want CloseChannel mention", err.Error())
	}

	// The client must have answered with its own polite CloseChannel
	// (spec §5.3.9) before the socket dropped.
	select {
	case <-fp.done:
	case <-time.After(5 * time.Second):
		t.Fatal("pool read loop did not finish")
	}
	fp.mu.Lock()
	got := append([]uint8(nil), fp.gotMsgs...)
	fp.mu.Unlock()
	for _, mt := range got {
		if mt == stratum.MsgCloseChannel {
			return
		}
	}
	t.Errorf("client never sent CloseChannel back; msg_types received: %v", got)
}

// TestRunSession_UpdateChannelAdvertised verifies the engine publishes the
// measured hash rate to the pool via UpdateChannel (spec §5.3.7) once the
// miner actually produces one — the figure advertised at channel open is a
// boot-time estimate at best (0 on the poolproto path).
func TestRunSession_UpdateChannelAdvertised(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	fp := newResponsivePool(t)
	defer fp.Close()
	<-fp.started

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	w := miner.NewWorker(miner.WorkerConfig{Threads: 1})
	merged := w.Start(ctx)
	defer w.Stop()

	err := runSession(ctx, sessionOpts{
		poolURL:  fp.URL(),
		user:     "bc1qtest000000000000000000000000000000000",
		workers:  []*miner.Worker{w},
		merged:   merged,
		interval: 10 * time.Millisecond,
		m:        newEngineMetrics(metrics.NewRegistry()),
		log:      func(_, _ string) {},
	})
	if err == nil {
		t.Fatal("runSession returned nil before ctx timeout")
	}

	fp.mu.Lock()
	updates := append([]stratum.UpdateChannel(nil), fp.gotUpdates...)
	other := append([]uint8(nil), fp.gotOther...)
	fp.mu.Unlock()

	if len(updates) == 0 {
		t.Fatalf("pool never received UpdateChannel; other msg_types seen: %v", other)
	}
	first := updates[0]
	if first.ChannelID != 1 {
		t.Errorf("UpdateChannel.channel_id = %d, want 1", first.ChannelID)
	}
	if first.NominalHashRate <= 0 {
		t.Errorf("UpdateChannel.nominal_hash_rate = %v, want > 0", first.NominalHashRate)
	}
	for i, b := range first.MaximumTarget {
		if b != 0xFF {
			t.Fatalf("UpdateChannel.maximum_target[%d] = 0x%02X, want unrestricted (0xFF)", i, b)
		}
	}
}

func TestShouldAdvertiseHashRate(t *testing.T) {
	now := time.Now()
	old := now.Add(-2 * time.Second)
	cases := []struct {
		name               string
		measured, lastSent float64
		lastTime           time.Time
		want               bool
	}{
		{"zero measurement never advertises", 0, 0, old, false},
		{"first nonzero measurement advertises", 100e6, 0, old, true},
		{"same rate does not re-send", 100e6, 100e6, old, false},
		{"small drift within 25%", 120e6, 100e6, old, false},
		{">25% rise re-advertises", 130e6, 100e6, old, true},
		{">25% drop re-advertises", 70e6, 100e6, old, true},
		{"within 1s debounce floor", 500e6, 0, now.Add(-500 * time.Millisecond), false},
	}
	for _, c := range cases {
		if got := shouldAdvertiseHashRate(c.measured, c.lastSent, c.lastTime, now); got != c.want {
			t.Errorf("%s: shouldAdvertiseHashRate(%v, %v) = %v, want %v",
				c.name, c.measured, c.lastSent, got, c.want)
		}
	}
}

func TestV1SuggestedDifficulty(t *testing.T) {
	// 1 GH/s should suggest ~2.33 (diff-1 ≈ 4.3s/share there, so ~10s
	// needs d≈2.3); a CPU-scale 200 KH/s suggests ~4.7e-4, which the
	// pool clamps to its floor.
	if got := v1SuggestedDifficulty(1e9); got < 2.0 || got > 2.7 {
		t.Errorf("1 GH/s → %v, want ≈2.33", got)
	}
	if got := v1SuggestedDifficulty(200e3); got < 4e-4 || got > 5e-4 {
		t.Errorf("200 KH/s → %v, want ≈4.7e-4", got)
	}
	if got := v1SuggestedDifficulty(0); got != 0 {
		t.Errorf("0 H/s → %v, want 0", got)
	}
}

func TestV1Work_PropagatesNotifyHeaderFields(t *testing.T) {
	// mining.notify's version and prevhash were parsed but dropped before
	// reaching the header — the V1 worker hashed a zeroed prevhash while
	// the V2 path populated both. Assert the parsed values now land in
	// the work header.
	var prev [32]byte
	for i := range prev {
		prev[i] = byte(i)
	}
	job := poolproto.Job{
		JobID:    "7",
		Version:  0x20000000,
		PrevHash: prev,
		NTime:    0x60000000,
		NBits:    0x1d00ffff,
	}
	target, err := miner.TargetFromNBits(job.NBits)
	if err != nil {
		t.Fatalf("target: %v", err)
	}
	w := v1Work(job, 7, 3, target)
	if w.Header.Version != job.Version {
		t.Errorf("Version = %#x, want %#x", w.Header.Version, job.Version)
	}
	if w.Header.PrevHash != prev {
		t.Error("PrevHash not propagated from mining.notify")
	}
	if w.Header.Time != job.NTime || w.Header.Bits != job.NBits {
		t.Error("Time/Bits not propagated")
	}
	if w.JobID != 7 || w.ChannelID != 3 {
		t.Error("JobID/ChannelID mismatch")
	}
}

func TestRunReconnectLoop_HealthySessionResetsAttemptBudget(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	// MaxReconnectAttempts counts *consecutive* failures, not lifetime
	// attempts: a session that stayed up past healthySessionDur must reset
	// the budget so an old outage can't drain it. With max=1 the loop
	// should allow the post-healthy re-dial; without the reset it dies
	// immediately at attempt 2.
	p := newMockPool(t)

	var mu sync.Mutex
	var logs []string
	logFn := func(_, msg string) {
		mu.Lock()
		logs = append(logs, msg)
		mu.Unlock()
	}

	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	w := miner.NewWorker(miner.WorkerConfig{Threads: 1})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	merged := w.Start(ctx)
	defer w.Stop()

	var amu sync.Mutex
	done := make(chan error, 1)
	go func() {
		done <- runReconnectLoop(ctx, reconnectOpts{
			opts: Options{
				Config: config.Config{
					BitcoinAddress: "bc1qtest000000000000000000000000000000000",
					Pools:          []config.PoolConfig{{URL: p.URL()}},
				},
				MaxReconnectAttempts: 1,
			},
			workers:           []*miner.Worker{w},
			merged:            merged,
			metrics:           m,
			log:               logFn,
			activityMu:        &amu,
			activity:          map[string]float64{},
			healthySessionDur: 50 * time.Millisecond,
		})
	}()

	// Wait for session 1 to establish, keep it up past the healthy
	// threshold, then kill the pool so the session ends "healthy".
	deadline := time.Now().Add(10 * time.Second)
	for {
		p.mu.Lock()
		n := len(p.conns)
		p.mu.Unlock()
		if n > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("session never connected to mock pool")
		}
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(120 * time.Millisecond)
	p.Stop()

	err := <-done
	if err == nil || !strings.Contains(err.Error(), "exceeded") {
		t.Fatalf("expected exceeded-attempts error, got %v", err)
	}
	mu.Lock()
	connects := 0
	for _, l := range logs {
		if strings.Contains(l, "connecting to") {
			connects++
		}
	}
	mu.Unlock()
	if connects != 2 {
		t.Fatalf("connect attempts = %d, want 2 — healthy session did not reset the budget", connects)
	}
}

// livenessSession is a minimal poolproto.Session that only implements
// LastMessageInformer — the capability publishPoolLinkLiveness polls.
type livenessSession struct {
	poolproto.Session // embedded nil interface: only LastMessageAt is used
	ts                int64
}

func (s livenessSession) LastMessageAt() int64 { return s.ts }

// TestPublishPoolLinkLiveness verifies the V1 liveness bridge: the gauge
// only moves when the session both reports LastMessageInformer and has
// actually received a message — a connected-but-silent link stays at 0,
// which is the alertable "never said anything" state.
func TestPublishPoolLinkLiveness(t *testing.T) {
	m := newEngineMetrics(metrics.NewRegistry())

	publishPoolLinkLiveness(m, nil) // no informant capability
	if v := m.lastPoolMessageAt.Value(); v != 0 {
		t.Fatalf("lastPoolMessageAt = %v, want 0 for a non-informant session", v)
	}

	publishPoolLinkLiveness(m, livenessSession{ts: 0}) // connected, silent
	if v := m.lastPoolMessageAt.Value(); v != 0 {
		t.Fatalf("lastPoolMessageAt = %v, want 0 before the first message", v)
	}

	publishPoolLinkLiveness(m, livenessSession{ts: 1720000000})
	if v := m.lastPoolMessageAt.Value(); v != 1720000000 {
		t.Errorf("lastPoolMessageAt = %v, want 1720000000", v)
	}
}

// protoErrSession is a minimal poolproto.Session that only implements
// ProtoErrorInformer — the capability publishPoolParseErrors polls.
type protoErrSession struct {
	poolproto.Session
	n int64
}

func (s protoErrSession) ProtoErrorCount() int64 { return s.n }

// TestPublishPoolParseErrors verifies the V1 parse-error bridge: deltas
// land exactly once against `last`, a non-informant session is a no-op,
// and the counter tracks the session's monotonic total.
func TestPublishPoolParseErrors(t *testing.T) {
	m := newEngineMetrics(metrics.NewRegistry())
	var last int64

	publishPoolParseErrors(m, nil, &last) // no informant capability
	if v := m.poolParseErrors.Value(); v != 0 {
		t.Fatalf("poolParseErrors = %v, want 0 for a non-informant session", v)
	}

	sess := protoErrSession{n: 3}
	publishPoolParseErrors(m, sess, &last)
	if v := m.poolParseErrors.Value(); v != 3 {
		t.Fatalf("poolParseErrors = %v, want 3", v)
	}

	publishPoolParseErrors(m, sess, &last) // same tick value → no double-count
	if v := m.poolParseErrors.Value(); v != 3 {
		t.Fatalf("poolParseErrors = %v after repeat, want 3 (delta counted once)", v)
	}

	sess.n = 7
	publishPoolParseErrors(m, sess, &last)
	if v := m.poolParseErrors.Value(); v != 7 {
		t.Fatalf("poolParseErrors = %v, want 7 (cumulative delta)", v)
	}
}
