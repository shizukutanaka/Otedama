// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// coverage_test.go — targeted tests pushing engine to ≥90% coverage.

package engine

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/arbitration"
	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/shizukutanaka/Otedama/internal/hal"
	"github.com/shizukutanaka/Otedama/internal/metrics"
	"github.com/shizukutanaka/Otedama/internal/miner"
	"github.com/shizukutanaka/Otedama/internal/provider"
	"github.com/shizukutanaka/Otedama/internal/stratum"
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
	stats := buildStats(opts, 500.0, 10)
	if stats.HashRate != 500.0 {
		t.Errorf("HashRate = %v, want 500.0", stats.HashRate)
	}
	if stats.Devices != 1 {
		t.Errorf("Devices = %d, want 1", stats.Devices)
	}
	if stats.TotalSatsEarned != 10 {
		t.Errorf("TotalSatsEarned = %d, want 10", stats.TotalSatsEarned)
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
// run.go updateWork — invalid NBits is a no-op
// ============================================================================

func TestUpdateWork_InvalidNBits_IsNoOp(t *testing.T) {
	job := &stratum.NewMiningJob{
		ChannelID: 1,
		JobID:     99,
		MinNtime:  0x60000000,
		NBits:     0x00000000, // invalid → TargetFromNBits errors → early return
	}
	// Must not panic; does nothing.
	updateWork(nil, job, 1, miner.Hash{})
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

// ============================================================================
// run.go handshake — error paths via net.Pipe fake servers
// ============================================================================

// TestHandshake_WriteSetupConnFails covers line 613–615: conn.Write fails
// inside sendMsg for SetupConnection because the server closed immediately.
func TestHandshake_WriteSetupConnFails(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	serverConn.Close() // closed before any read; client Write will fail
	dec := stratum.NewDecoder(clientConn)
	_, _, err := handshake(clientConn, dec, "stratum+v2://localhost:3336", "user", nil)
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
	_, _, err := handshake(clientConn, dec, "stratum+v2://localhost:3336", "user", nil)
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
	_, _, err := handshake(clientConn, dec, "stratum+v2://localhost:3336", "user", nil)
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
	_, _, err := handshake(clientConn, dec, "stratum+v2://localhost:3336", "user", nil)
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
		job := stratum.NewMiningJob{ChannelID: 1, JobID: 1, MinNtime: 0x60000000, NBits: 0x1d00ffff}
		payload, _ := job.Encode()
		f, _ := stratum.WrapMessage(stratum.MsgNewMiningJob, true, payload)
		data, _ := stratum.EncodeFrame(f)
		serverConn.Write(data) //nolint:errcheck
	}()

	dec := stratum.NewDecoder(clientConn)
	_, _, err := handshake(clientConn, dec, "stratum+v2://localhost:3336", "user", nil)
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
		serverConn.Close() // close AFTER sending success so the client can read it
	}()

	dec := stratum.NewDecoder(clientConn)
	_, _, err := handshake(clientConn, dec, "stratum+v2://localhost:3336", "user", nil)
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
		sDec.ReadFrame() //nolint:errcheck // OpenMiningChannel
		serverConn.Close()
	}()

	dec := stratum.NewDecoder(clientConn)
	_, _, err := handshake(clientConn, dec, "stratum+v2://localhost:3336", "user", nil)
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
		sDec.ReadFrame() //nolint:errcheck // OpenMiningChannel
		// Send MsgOpenMiningChannelSuccess with only 2 bytes (truncated payload).
		f2, _ := stratum.WrapMessage(stratum.MsgOpenMiningChannelSuccess, false, []byte{0x01, 0x00})
		data2, _ := stratum.EncodeFrame(f2)
		serverConn.Write(data2) //nolint:errcheck
	}()

	dec := stratum.NewDecoder(clientConn)
	_, _, err := handshake(clientConn, dec, "stratum+v2://localhost:3336", "user", nil)
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
		sDec.ReadFrame() //nolint:errcheck // OpenMiningChannel
		// Send the same SetupConnectionSuccess again instead of OMC success.
		// DispatchFrame sets SetupConnectionSuccess, not OpenMiningChannelSuccess.
		serverConn.Write(data) //nolint:errcheck
	}()

	dec := stratum.NewDecoder(clientConn)
	_, _, err := handshake(clientConn, dec, "stratum+v2://localhost:3336", "user", nil)
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
