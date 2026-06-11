// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package engine

import (
	"context"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/shizukutanaka/Otedama/internal/metrics"
	"github.com/shizukutanaka/Otedama/internal/stratum"
)

// mockPool is a minimal Stratum V2 pool for integration testing.
// It accepts TCP connections, performs a handshake, and can be driven
// by the test to emit jobs or acknowledge shares.
type mockPool struct {
	listener net.Listener
	addr     string

	mu     sync.Mutex
	shares int
	jobs   int
	closed bool
	conns  []net.Conn // tracked connections, closed on Stop
}

func newMockPool(t *testing.T) *mockPool {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	p := &mockPool{
		listener: ln,
		addr:     ln.Addr().String(),
	}
	go p.acceptLoop()
	t.Cleanup(p.Stop) // guarantee no goroutine leak across tests
	return p
}

func (p *mockPool) URL() string {
	return "stratum+v2://" + p.addr
}

func (p *mockPool) Stop() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	conns := append([]net.Conn(nil), p.conns...)
	p.mu.Unlock()
	_ = p.listener.Close()
	for _, c := range conns {
		_ = c.Close()
	}
}

func (p *mockPool) SharesReceived() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.shares
}

func (p *mockPool) acceptLoop() {
	for {
		conn, err := p.listener.Accept()
		if err != nil {
			return
		}
		go p.handleConn(conn)
	}
}

// handleConn runs the Stratum V2 server side of one connection.
// It receives SetupConnection, replies SetupConnectionSuccess, receives
// OpenMiningChannel, replies OpenMiningChannelSuccess, sends one
// NewMiningJob, and acknowledges submitted shares.
func (p *mockPool) handleConn(conn net.Conn) {
	defer conn.Close()
	p.mu.Lock()
	p.conns = append(p.conns, conn)
	p.mu.Unlock()
	dec := stratum.NewDecoder(conn)

	// 1. Read SetupConnection
	f, err := dec.ReadFrame()
	if err != nil {
		return
	}
	msg, err := stratum.DispatchFrame(f)
	if err != nil || msg.SetupConnection == nil {
		return
	}

	// 2. Send SetupConnectionSuccess
	ok := stratum.SetupConnectionSuccess{
		UsedVersion: 2,
		Flags:       0,
	}
	if err := sendServerMsg(conn, stratum.MsgSetupConnectionSuccess, false, &ok); err != nil {
		return
	}

	// 3. Read OpenMiningChannel
	f, err = dec.ReadFrame()
	if err != nil {
		return
	}
	msg, err = stratum.DispatchFrame(f)
	if err != nil || msg.OpenMiningChannel == nil {
		return
	}

	// 4. Send OpenMiningChannelSuccess
	okChan := stratum.OpenMiningChannelSuccess{
		ReqID:     msg.OpenMiningChannel.ReqID,
		ChannelID: 1,
	}
	// Set an easy target (high value = more shares accepted).
	for i := range okChan.Target {
		okChan.Target[i] = 0xFF
	}
	if err := sendServerMsg(conn, stratum.MsgOpenMiningChannelSuccess, true, &okChan); err != nil {
		return
	}

	// 5. Send a single NewMiningJob so the worker has something to hash.
	job := stratum.NewMiningJob{
		ChannelID: 1,
		JobID:     100,
		MinNtime:  uint32(time.Now().Unix()),
		NBits:     0x1d00ffff, // very easy target for testing
	}
	for i := range job.MerkleRoot {
		job.MerkleRoot[i] = byte(i)
	}
	p.mu.Lock()
	p.jobs++
	p.mu.Unlock()
	if err := sendServerMsg(conn, stratum.MsgNewMiningJob, true, &job); err != nil {
		return
	}

	// 6. Loop: ack any submitted shares.
	for {
		f, err := dec.ReadFrame()
		if err != nil {
			return
		}
		msg, err := stratum.DispatchFrame(f)
		if err != nil {
			continue
		}
		if msg.SubmitSharesStandard != nil {
			p.mu.Lock()
			p.shares++
			p.mu.Unlock()
			// Acknowledge.
			ack := stratum.SubmitSharesSuccess{
				ChannelID:          1,
				LastSequenceNumber: msg.SubmitSharesStandard.SequenceNumber,
			}
			_ = sendServerMsg(conn, stratum.MsgSubmitSharesSuccess, true, &ack)
		}
	}
}

// sendServerMsg encodes and writes a server-to-client Stratum V2 message.
func sendServerMsg(w io.Writer, msgType uint8, isChannel bool, enc interface {
	Encode() ([]byte, error)
}) error {
	payload, err := enc.Encode()
	if err != nil {
		return err
	}
	f, err := stratum.WrapMessage(msgType, isChannel, payload)
	if err != nil {
		return err
	}
	data, err := stratum.EncodeFrame(f)
	if err != nil {
		return err
	}
	_, err = w.Write(data)
	return err
}

// ============================================================================
// End-to-end engine integration tests
// ============================================================================

func TestEngine_Integration_HandshakeSucceeds(t *testing.T) {
	// Start a mock pool and verify engine.Run connects and sets up a channel.
	pool := newMockPool(t)
	defer pool.Stop()

	reg := metrics.NewRegistry()
	var readyStates []bool
	var readyMu sync.Mutex

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	done := make(chan struct{})
	go func() {
		_ = Run(ctx, Options{
			Config: config.Config{
				BitcoinAddress: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
				Pools: []config.PoolConfig{
					{URL: pool.URL()},
				},
			},
			NoTUI:                true,
			MaxReconnectAttempts: 2,
			Metrics:              reg,
			OnReady: func(ready bool) {
				readyMu.Lock()
				readyStates = append(readyStates, ready)
				readyMu.Unlock()
			},
			Logger: func(_, _ string) {},
		})
		close(done)
	}()

	// Allow time for handshake and at least one share submission on easy target.
	time.Sleep(1500 * time.Millisecond)

	// Pool connect attempt counter must be >= 1.
	connAttempts := reg.NewCounter("otedama_pool_connect_attempts_total", "", nil)
	if v := connAttempts.Value(); v < 1 {
		t.Errorf("pool connect attempts = %d, want >= 1", v)
	}

	// OnReady must have fired with true at least once.
	readyMu.Lock()
	sawReady := false
	for _, r := range readyStates {
		if r {
			sawReady = true
			break
		}
	}
	readyMu.Unlock()
	if !sawReady {
		t.Errorf("OnReady(true) never called; states=%v", readyStates)
	}

	// Shares must actually reach the pool. The pool assigned an easy share
	// target (0xFF…FF) in OpenMiningChannelSuccess, so every hash is a valid
	// share — provided the engine grinds to that share target. If it instead
	// used the block target (NBits 0x1d00ffff, ~4e9 hashes/share), no share
	// could land in this window. This is the regression guard for the
	// share-target fix.
	if got := pool.SharesReceived(); got < 1 {
		t.Errorf("pool received %d shares, want >= 1 (engine must grind to the assigned share target)", got)
	}

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("engine.Run did not return within 2s of cancel")
	}
}

func TestEngine_Integration_ReconnectsOnPoolFailure(t *testing.T) {
	// Pool refuses connections — engine should retry with backoff.
	// Bind to a port then immediately close so dial fails.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := ln.Addr().String()
	_ = ln.Close() // nothing is listening now

	reg := metrics.NewRegistry()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	done := make(chan struct{})
	go func() {
		_ = Run(ctx, Options{
			Config: config.Config{
				BitcoinAddress: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
				Pools: []config.PoolConfig{
					{URL: "stratum+v2://" + addr},
				},
			},
			NoTUI:                true,
			MaxReconnectAttempts: 3,
			Metrics:              reg,
			Logger:               func(_, _ string) {},
		})
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2900 * time.Millisecond):
		cancel()
		<-done
	}

	attempts := reg.NewCounter("otedama_pool_connect_attempts_total", "", nil)
	failures := reg.NewCounter("otedama_pool_connect_failures_total", "", nil)

	if attempts.Value() < 2 {
		t.Errorf("reconnect count = %d, want >= 2", attempts.Value())
	}
	if failures.Value() == 0 {
		t.Error("pool_connect_failures_total should record failures")
	}
}

// ============================================================================
// Metrics surface tests
// ============================================================================

func TestEngineMetrics_AllRegisteredOnInit(t *testing.T) {
	// Verify that every expected metric is registered when engine starts,
	// even before any mining activity.
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)

	// Touch each handle to confirm they exist.
	if m.hashrate == nil {
		t.Error("hashrate gauge not registered")
	}
	if m.sharesFound == nil {
		t.Error("shares_found_total not registered")
	}
	if m.sharesAccepted == nil {
		t.Error("shares_total{status=accepted} not registered")
	}
	if m.sharesRejected == nil {
		t.Error("shares_total{status=rejected} not registered")
	}
	if m.poolConnectAttempts == nil {
		t.Error("pool_connect_attempts_total not registered")
	}
	if m.poolConnectFailures == nil {
		t.Error("pool_connect_failures_total not registered")
	}
	if m.arbitrationSwitches == nil {
		t.Error("arbitration_switches_total not registered")
	}
	if m.btcUSDRate == nil {
		t.Error("btc_usd_rate gauge not registered")
	}
	if m.uptime == nil {
		t.Error("uptime_seconds gauge not registered")
	}
	if m.startTime == nil {
		t.Error("start_time_seconds gauge not registered")
	}
	if m.rejectRate == nil {
		t.Error("reject_rate gauge not registered")
	}
	if m.staleRate == nil {
		t.Error("stale_rate gauge not registered")
	}
}

func TestEngineMetrics_MetricNamesFollowPrometheusConvention(t *testing.T) {
	// Counters must end with _total; seconds with _seconds; etc.
	reg := metrics.NewRegistry()
	_ = newEngineMetrics(reg)

	var buf strLikeBuilder
	_ = reg.WriteText(&buf)
	out := buf.String()

	// Counter naming.
	for _, name := range []string{
		"otedama_shares_found_total",
		"otedama_shares_total",
		"otedama_pool_connect_attempts_total",
		"otedama_pool_connect_failures_total",
		"otedama_arbitration_switches_total",
	} {
		if !containsString(out, "# TYPE "+name+" counter") {
			t.Errorf("counter %q not declared with TYPE counter", name)
		}
	}

	// Gauge naming.
	for _, name := range []string{
		"otedama_hashrate_hashes_per_second",
		"otedama_btc_usd_rate",
		"otedama_uptime_seconds",
		"otedama_start_time_seconds",
	} {
		if !containsString(out, "# TYPE "+name+" gauge") {
			t.Errorf("gauge %q not declared with TYPE gauge", name)
		}
	}
}

// ============================================================================
// Test helpers
// ============================================================================

type strLikeBuilder struct {
	data []byte
}

func (b *strLikeBuilder) Write(p []byte) (int, error) {
	b.data = append(b.data, p...)
	return len(p), nil
}

func (b *strLikeBuilder) String() string {
	return string(b.data)
}

func containsString(haystack, needle string) bool {
	n := len(needle)
	for i := 0; i+n <= len(haystack); i++ {
		if haystack[i:i+n] == needle {
			return true
		}
	}
	return false
}

func TestEngineMetrics_RejectReasonLazyCreateAndReuse(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)

	// First call for a category creates the counter.
	c1 := m.rejectReason("stale")
	if c1 == nil {
		t.Fatal("rejectReason(stale) returned nil")
	}
	// Second call for the same category must return the SAME counter,
	// not a duplicate (registry would otherwise reject the re-register).
	c2 := m.rejectReason("stale")
	if c1 != c2 {
		t.Error("rejectReason(stale) created a second counter instead of reusing")
	}
	// A different category is a distinct counter.
	if m.rejectReason("hardware") == c1 {
		t.Error("rejectReason(hardware) aliased the stale counter")
	}

	// Incrementing is reflected in the value.
	c1.Inc()
	c1.Inc()
	if got := c1.Value(); got != 2 {
		t.Errorf("stale reject counter = %d, want 2", got)
	}
}

func TestEngineMetrics_RejectReasonAppearsInOutput(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	m.rejectReason("difficulty").Inc()

	var buf strings.Builder
	if err := reg.WriteText(&buf); err != nil {
		t.Fatalf("WriteText: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, "otedama_shares_rejected_by_reason_total") {
		t.Error("reject-by-reason metric missing from /metrics output")
	}
	if !strings.Contains(out, `reason="difficulty"`) {
		t.Errorf("reason label missing from output:\n%s", out)
	}
}

func TestEngineMetrics_ShareAcceptanceRateRegistered(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	m.shareAcceptanceRate.Set(0.99)

	var buf strings.Builder
	if err := reg.WriteText(&buf); err != nil {
		t.Fatalf("WriteText: %v", err)
	}
	if !strings.Contains(buf.String(), "otedama_share_acceptance_rate") {
		t.Error("acceptance-rate gauge missing from /metrics output")
	}
}

func TestEngineMetrics_UpdateShareRates_NoSharesJudged(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)

	// With nothing judged yet, acceptance is 1.0 (nothing lost) and the
	// reject/stale rates are 0 — no division-by-zero.
	rate, judged := m.updateShareRates()
	if rate != 1.0 {
		t.Errorf("acceptance rate with no shares = %v, want 1.0", rate)
	}
	if judged != 0 {
		t.Errorf("judged with no shares = %d, want 0", judged)
	}
	if got := m.rejectRate.Value(); got != 0 {
		t.Errorf("rejectRate with no shares = %v, want 0", got)
	}
	if got := m.staleRate.Value(); got != 0 {
		t.Errorf("staleRate with no shares = %v, want 0", got)
	}
}

func TestEngineMetrics_UpdateShareRates_ComputesRejectAndStale(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)

	// 90 accepted, 10 rejected (6 of them stale) → 100 judged.
	for range 90 {
		m.sharesAccepted.Inc()
	}
	for range 10 {
		m.sharesRejected.Inc()
	}
	for range 6 {
		m.rejectReason("stale").Inc()
	}

	rate, judged := m.updateShareRates()
	if judged != 100 {
		t.Fatalf("judged = %d, want 100", judged)
	}
	if rate != 0.90 {
		t.Errorf("acceptance rate = %v, want 0.90", rate)
	}
	if got := m.rejectRate.Value(); got != 0.10 {
		t.Errorf("rejectRate = %v, want 0.10", got)
	}
	if got := m.staleRate.Value(); got != 0.06 {
		t.Errorf("staleRate = %v, want 0.06", got)
	}
}

func TestEngineMetrics_RejectAndStaleRateAppearInOutput(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	m.updateShareRates() // ensure the gauges are emitted (set to 0)

	var buf strings.Builder
	if err := reg.WriteText(&buf); err != nil {
		t.Fatalf("WriteText: %v", err)
	}
	out := buf.String()
	for _, want := range []string{"otedama_reject_rate", "otedama_stale_rate"} {
		if !strings.Contains(out, want) {
			t.Errorf("metric %q missing from /metrics output", want)
		}
	}
}

func TestEngineMetrics_ObservabilityBundleAppearsInOutput(t *testing.T) {
	// Session-54 observability bundle: build_info (constant 1 with labels),
	// up, and the pool connection-state / active-index gauges.
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	m.up.Set(1)
	m.poolConnectionState.Set(2)
	m.poolActiveIndex.Set(1)

	var buf strings.Builder
	if err := reg.WriteText(&buf); err != nil {
		t.Fatalf("WriteText: %v", err)
	}
	out := buf.String()

	for _, want := range []string{
		"otedama_build_info",
		"otedama_up",
		"otedama_pool_connection_state",
		"otedama_pool_active_index",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("metric %q missing from /metrics output", want)
		}
	}
	// build_info follows the _info convention: a constant-1 series whose
	// version/commit/goversion live in labels.
	if !strings.Contains(out, `version=`) || !strings.Contains(out, `goversion=`) {
		t.Errorf("build_info should carry version/goversion labels:\n%s", out)
	}
	if !strings.Contains(out, "otedama_build_info{") {
		t.Errorf("build_info should be a labeled series:\n%s", out)
	}
}

// TestEngineRun_NotReadyWithoutPoolConnect verifies the session-61 fix:
// /readyz (via OnReady) must NOT report ready until an actual pool session
// is established. With an unreachable pool, OnReady(true) must never fire.
func TestEngineRun_NotReadyWithoutPoolConnect(t *testing.T) {
	var mu sync.Mutex
	var states []bool

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_ = Run(ctx, Options{
		Config: config.Config{
			BitcoinAddress: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
			// Port 1 is reserved; the dial is refused immediately, so no
			// session ever establishes.
			Pools: []config.PoolConfig{{URL: "stratum+v2://127.0.0.1:1"}},
		},
		NoTUI:                true,
		MaxReconnectAttempts: 1,
		OnReady: func(ready bool) {
			mu.Lock()
			states = append(states, ready)
			mu.Unlock()
		},
		Logger: func(_, _ string) {},
	})

	mu.Lock()
	defer mu.Unlock()
	for _, r := range states {
		if r {
			t.Errorf("OnReady(true) fired without an established pool session; states=%v", states)
		}
	}
}
