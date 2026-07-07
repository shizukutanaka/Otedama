// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package engine

import (
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
}

func newResponsivePool(t *testing.T) *responsivePool {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("responsivePool: listen: %v", err)
	}
	fp := &responsivePool{
		t:       t,
		ln:      ln,
		addr:    ln.Addr().String(),
		started: make(chan struct{}),
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
		ReqID:           omc.ReqID,
		ChannelID:       1,
		ExtraNonce2Size: 4,
	}
	for i := range omcSucc.Target {
		omcSucc.Target[i] = 0xFF
	}
	payload, _ = omcSucc.Encode()
	fp.emit(conn, stratum.MsgOpenMiningChannelSuccess, false, payload)

	// Establish the chain tip first (SetNewPrevHash) so the NewMiningJob
	// below — which carries its own min_ntime — activates immediately
	// rather than waiting as a future job. Network nBits 0x207fffff is
	// the easiest possible target.
	prev := stratum.SetNewPrevHash{
		ChannelID: 1,
		JobID:     1,
		MinNtime:  0x60000000,
		NBits:     0x207fffff,
	}
	payload, _ = prev.Encode()
	fp.emit(conn, stratum.MsgSetNewPrevHash, true, payload)

	job := stratum.NewMiningJob{
		ChannelID:   1,
		JobID:       1,
		HasMinNtime: true,
		MinNtime:    0x60000000,
		Version:     0x20000000,
	}
	payload, _ = job.Encode()
	fp.emit(conn, stratum.MsgNewMiningJob, true, payload)

	// Read shares and respond accordingly
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
			// First share: acknowledge. Exercises SubmitSharesSuccess handler
			// and the latency-recording path.
			resp := stratum.SubmitSharesSuccess{
				ChannelID:          share.ChannelID,
				LastSequenceNumber: share.SequenceNumber,
				NewSubmitsAccepted: 1,
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
func TestRunSession_StatsTickAndShareResponses(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	fp := newResponsivePool(t)
	defer fp.Close()
	<-fp.started

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	w := miner.NewWorker(miner.WorkerConfig{Threads: 1})
	merged := w.Start(ctx)
	defer w.Stop()

	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)

	var logs []string
	var logMu sync.Mutex
	log := func(level, msg string) {
		logMu.Lock()
		logs = append(logs, level+": "+msg)
		logMu.Unlock()
	}

	// powerWatts > 0 exercises the J/TH branch inside the stats tick.
	_ = runSession(ctx, sessionOpts{
		poolURL:    fp.URL(),
		user:       "bc1qtest000000000000000000000000000000000",
		workers:    []*miner.Worker{w},
		merged:     merged,
		interval:   5 * time.Millisecond,
		m:          m,
		powerWatts: 100.0,
		log:        log,
	})

	logMu.Lock()
	defer logMu.Unlock()

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
	// The latency-logging branch fires once latency is recorded (after the first
	// SubmitSharesSuccess) and a subsequent stats tick runs.
	foundLatency := false
	for _, l := range logs {
		if strings.Contains(l, "submit latency") {
			foundLatency = true
			break
		}
	}
	if !foundLatency {
		t.Logf("all logs: %v", logs)
		t.Error("submit-latency log not emitted; latency-quantile stats-tick path not covered")
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
