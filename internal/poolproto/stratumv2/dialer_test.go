// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package stratumv2

import (
	"context"
	"errors"
	"io"
	"math"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/poolproto"
	"github.com/shizukutanaka/Otedama/internal/stratum"
)

func TestDialer_Protocol(t *testing.T) {
	plain := &Dialer{}
	if got := plain.Protocol(); got != poolproto.ProtocolStratumV2 {
		t.Errorf("plaintext Protocol() = %q, want %q", got, poolproto.ProtocolStratumV2)
	}
	tls := &Dialer{useTLS: true}
	if got := tls.Protocol(); got != poolproto.ProtocolStratumV2TLS {
		t.Errorf("TLS Protocol() = %q, want %q", got, poolproto.ProtocolStratumV2TLS)
	}
}

func TestDialer_Dial_ParsesScheme(t *testing.T) {
	// Use an injected dialFn so no real network is touched. We only
	// verify that the scheme is stripped and the host is passed through.
	var gotAddress string
	d := &Dialer{
		dialFn: func(_ context.Context, address string) (net.Conn, error) {
			gotAddress = address
			c1, _ := net.Pipe()
			return c1, nil
		},
	}
	conn, err := d.Dial(context.Background(),
		"stratum+v2://pool.example.com:3336",
		poolproto.Credentials{User: "alice"})
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer conn.Close()

	if gotAddress != "pool.example.com:3336" {
		t.Errorf("dial address = %q, want pool.example.com:3336", gotAddress)
	}
	if conn.RemoteAddr() != "pool.example.com:3336" {
		t.Errorf("RemoteAddr() = %q", conn.RemoteAddr())
	}
	if conn.Protocol() != poolproto.ProtocolStratumV2 {
		t.Errorf("Protocol() = %q", conn.Protocol())
	}
}

func TestDialer_Dial_RejectsUnknownScheme(t *testing.T) {
	d := &Dialer{}
	_, err := d.Dial(context.Background(), "http://example.com", poolproto.Credentials{})
	if err == nil {
		t.Error("Dial with non-stratum scheme should fail")
	}
}

func TestDialer_RegisteredInRegistry(t *testing.T) {
	// init() registers both the plaintext and TLS V2 dialers. Verify
	// poolproto can look them up by protocol.
	for _, proto := range []poolproto.ProtocolID{
		poolproto.ProtocolStratumV2,
		poolproto.ProtocolStratumV2TLS,
	} {
		d, err := poolproto.Lookup(proto)
		if err != nil {
			t.Errorf("Lookup(%q) failed: %v", proto, err)
			continue
		}
		if d.Protocol() != proto {
			t.Errorf("Lookup(%q) returned dialer for %q", proto, d.Protocol())
		}
	}
}

// TestNegotiate_EmitsJobOnlyAfterSetNewPrevHash drives a full handshake
// against an in-memory fake pool and asserts the SV2 activation
// semantics: a future job (no min_ntime) is NOT emitted on its own; the
// SetNewPrevHash naming it triggers emission of a fully-populated
// poolproto.Job (version, prev-hash, ntime, nBits, clean flag).
func TestNegotiate_EmitsJobOnlyAfterSetNewPrevHash(t *testing.T) {
	client, server := net.Pipe()
	d := &Dialer{
		dialFn: func(_ context.Context, _ string) (net.Conn, error) {
			return client, nil
		},
	}

	// Fake pool: answer the handshake, then send future-job +
	// SetNewPrevHash.
	go func() {
		dec := stratum.NewDecoder(server)

		// SetupConnection → success
		if _, err := dec.ReadFrame(); err != nil {
			return
		}
		ok := stratum.SetupConnectionSuccess{UsedVersion: 2}
		payload, _ := ok.Encode()
		f, _ := stratum.WrapMessage(stratum.MsgSetupConnectionSuccess, false, payload)
		data, _ := stratum.EncodeFrame(f)
		if _, err := server.Write(data); err != nil {
			return
		}

		// OpenMiningChannel → success
		if _, err := dec.ReadFrame(); err != nil {
			return
		}
		chOK := stratum.OpenMiningChannelSuccess{ReqID: 1, ChannelID: 7}
		payload, _ = chOK.Encode()
		f, _ = stratum.WrapMessage(stratum.MsgOpenMiningChannelSuccess, true, payload)
		data, _ = stratum.EncodeFrame(f)
		if _, err := server.Write(data); err != nil {
			return
		}

		// Future job (no min_ntime): must not be emitted yet.
		job := stratum.NewMiningJob{ChannelID: 7, JobID: 5, Version: 0x20000002}
		for i := range job.MerkleRoot {
			job.MerkleRoot[i] = byte(i)
		}
		payload, _ = job.Encode()
		f, _ = stratum.WrapMessage(stratum.MsgNewMiningJob, true, payload)
		data, _ = stratum.EncodeFrame(f)
		if _, err := server.Write(data); err != nil {
			return
		}

		// SetNewPrevHash activates job 5.
		prev := stratum.SetNewPrevHash{
			ChannelID: 7, JobID: 5,
			MinNtime: 0x66000000, NBits: 0x1d00ffff,
		}
		for i := range prev.PrevHash {
			prev.PrevHash[i] = byte(0xB0 + i%16)
		}
		payload, _ = prev.Encode()
		f, _ = stratum.WrapMessage(stratum.MsgSetNewPrevHash, true, payload)
		data, _ = stratum.EncodeFrame(f)
		_, _ = server.Write(data)
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	conn, err := d.Dial(ctx, "stratum+v2://fake:3336", poolproto.Credentials{User: "bc1qtest"})
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	sess, err := d.Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}
	defer sess.Close()

	select {
	case job := <-sess.Jobs():
		if job.JobID != "5" {
			t.Errorf("JobID = %q, want \"5\"", job.JobID)
		}
		if job.Version != 0x20000002 {
			t.Errorf("Version = 0x%08X, want 0x20000002", job.Version)
		}
		if job.NBits != 0x1d00ffff {
			t.Errorf("NBits = 0x%08X, want 0x1d00ffff (from SetNewPrevHash)", job.NBits)
		}
		if job.NTime != 0x66000000 {
			t.Errorf("NTime = 0x%08X, want 0x66000000 (from SetNewPrevHash)", job.NTime)
		}
		if job.PrevHash == ([32]byte{}) {
			t.Error("PrevHash is zero — must carry SetNewPrevHash.prev_hash")
		}
		if !job.CleanJobs {
			t.Error("CleanJobs = false; a SetNewPrevHash-activated job invalidates older work")
		}
	case <-ctx.Done():
		t.Fatal("no job emitted within 3s after SetNewPrevHash")
	}
}

func TestParseJobID(t *testing.T) {
	cases := map[string]uint32{
		"0":     0,
		"1":     1,
		"42":    42,
		"65535": 65535,
		"bad":   0, // unparseable → 0
	}
	for in, want := range cases {
		if got := parseJobID(in); got != want {
			t.Errorf("parseJobID(%q) = %d, want %d", in, got, want)
		}
	}
}

// ============================================================================
// Mock pool server helpers
//
// mockPool handles the SV2 handshake on one end of a net.Pipe so that
// tests can exercise Negotiate, Jobs, Submit, and Close without a real
// TCP connection.
// ============================================================================

// poolSide is a test helper that acts as the pool side of a Stratum V2
// connection.  It reads the expected client messages, writes the standard
// success replies, and then allows the test to send additional frames.
type poolSide struct {
	conn net.Conn
	dec  *stratum.Decoder
	t    *testing.T

	// setupFlags records the SetupConnection.flags the client sent —
	// lets tests assert the declared capability bits.
	setupFlags atomic.Uint32

	// successFlags is written into SetupConnectionSuccess.flags — lets
	// tests simulate a pool requiring features the client cannot serve.
	successFlags uint32
}

// writeMsgTo encodes a Stratum V2 message and writes the framed bytes to w.
// It runs on the mock pool's goroutine, so it must use t.Errorf (safe from
// any goroutine), never t.Fatalf (which calls runtime.Goexit and is only
// valid on the test's own goroutine).
func writeMsgTo(t *testing.T, w net.Conn, msgType uint8, isChannel bool, enc interface{ Encode() ([]byte, error) }) {
	t.Helper()
	payload, err := enc.Encode()
	if err != nil {
		t.Errorf("writeMsgTo Encode(%T): %v", enc, err)
		return
	}
	f, err := stratum.WrapMessage(msgType, isChannel, payload)
	if err != nil {
		t.Errorf("writeMsgTo WrapMessage: %v", err)
		return
	}
	data, err := stratum.EncodeFrame(f)
	if err != nil {
		t.Errorf("writeMsgTo EncodeFrame: %v", err)
		return
	}
	if _, err := w.Write(data); err != nil {
		// Connection may have been closed by the other side after
		// the test is done — do not fail on write errors after the
		// happy path.
		t.Logf("writeMsgTo Write: %v (likely closed by client)", err)
	}
}

// doHandshake performs the standard SV2 handshake from the pool side and
// returns the channel ID assigned to the client. It runs on the mock
// pool's goroutine (see writeMsgTo for why errors use t.Errorf).
func (p *poolSide) doHandshake(channelID uint32) {
	p.t.Helper()
	// Read SetupConnection; record the declared flags for the test to
	// assert on.
	f, err := p.dec.ReadFrame()
	if err != nil {
		p.t.Errorf("pool: read SetupConnection: %v", err)
		return
	}
	sc, err := stratum.DecodeSetupConnection(f.Payload)
	if err != nil {
		p.t.Errorf("pool: decode SetupConnection: %v", err)
		return
	}
	p.setupFlags.Store(sc.Flags)
	// Send SetupConnectionSuccess.
	writeMsgTo(p.t, p.conn, stratum.MsgSetupConnectionSuccess, false,
		stratum.SetupConnectionSuccess{UsedVersion: 2, Flags: p.successFlags})

	// Read and discard OpenMiningChannel.
	if _, err := p.dec.ReadFrame(); err != nil {
		p.t.Errorf("pool: read OpenMiningChannel: %v", err)
		return
	}
	// Send OpenMiningChannelSuccess.
	writeMsgTo(p.t, p.conn, stratum.MsgOpenMiningChannelSuccess, false,
		stratum.OpenMiningChannelSuccess{
			ReqID:           1,
			ChannelID:       channelID,
			ExtraNonce2Size: 4,
		})
}

// doSetupOnly performs only the SetupConnection exchange: the client is
// expected to abort the handshake after SetupConnectionSuccess (e.g. an
// unsupported required-flags reply), so no OpenMiningChannel follows.
func (p *poolSide) doSetupOnly() {
	p.t.Helper()
	f, err := p.dec.ReadFrame()
	if err != nil {
		p.t.Errorf("pool: read SetupConnection: %v", err)
		return
	}
	sc, err := stratum.DecodeSetupConnection(f.Payload)
	if err != nil {
		p.t.Errorf("pool: decode SetupConnection: %v", err)
		return
	}
	p.setupFlags.Store(sc.Flags)
	writeMsgTo(p.t, p.conn, stratum.MsgSetupConnectionSuccess, false,
		stratum.SetupConnectionSuccess{UsedVersion: 2, Flags: p.successFlags})
}

// newPoolSide creates a poolSide and the client-side net.Conn from net.Pipe.
func newPoolSide(t *testing.T) (*poolSide, net.Conn) {
	t.Helper()
	server, client := net.Pipe()
	t.Cleanup(func() { server.Close(); client.Close() })
	p := &poolSide{
		conn: server,
		dec:  stratum.NewDecoder(server),
		t:    t,
	}
	return p, client
}

// makeDialer returns a Dialer that uses the given conn instead of a real TCP
// dial.  The conn is consumed once (the Dialer's dialFn returns it on the
// first call and an error on subsequent calls).
func makeDialer(clientConn net.Conn) *Dialer {
	var used bool
	return &Dialer{
		dialFn: func(_ context.Context, _ string) (net.Conn, error) {
			if used {
				return nil, net.ErrClosed
			}
			used = true
			return clientConn, nil
		},
	}
}

// ============================================================================
// Negotiate tests
// ============================================================================

func TestDialer_Negotiate_Success(t *testing.T) {
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go pool.doHandshake(42)

	conn, err := d.Dial(ctx, "stratum+v2://pool.example.com:3336", poolproto.Credentials{User: "alice"})
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	sess, err := d.Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}
	defer sess.Close()

	if sess == nil {
		t.Fatal("Negotiate returned nil session")
	}
}

// An end mining device that opens only Standard Channels must declare
// REQUIRES_STANDARD_JOBS in SetupConnection.flags (sv2-spec §5.3.1) —
// flags=0 would make a conforming pool treat the connection as a
// proxy-capable downstream able to receive extended/group jobs.
func TestDialer_Negotiate_DeclaresRequiresStandardJobs(t *testing.T) {
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go pool.doHandshake(42)

	conn, err := d.Dial(ctx, "stratum+v2://pool.example.com:3336", poolproto.Credentials{User: "alice"})
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	sess, err := d.Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}
	defer sess.Close()

	// The pool goroutine stores the received flags; the handshake is
	// complete once Negotiate returned, so no wait is needed.
	if pool.setupFlags.Load()&stratum.SetupFlagRequiresStandardJobs == 0 {
		t.Errorf("SetupConnection.flags = %#x, REQUIRES_STANDARD_JOBS (bit 0) unset", pool.setupFlags.Load())
	}
}

// A pool that sets REQUIRES_EXTENDED_CHANNELS in SetupConnectionSuccess
// demands group/extended-channel jobs a standard-channel-only end device
// cannot process — the dialer must fail the handshake instead of
// proceeding into unusable work.
func TestDialer_Negotiate_FailsWhenPoolRequiresExtendedChannels(t *testing.T) {
	pool, clientConn := newPoolSide(t)
	pool.successFlags = stratum.SetupFlagRequiresExtendedChannels
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go pool.doSetupOnly()

	conn, err := d.Dial(ctx, "stratum+v2://pool.example.com:3336", poolproto.Credentials{User: "alice"})
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	if _, err = d.Negotiate(ctx, conn); err == nil {
		t.Fatal("Negotiate succeeded despite REQUIRES_EXTENDED_CHANNELS")
	} else if !errors.Is(err, poolproto.ErrHandshakeFailed) {
		t.Fatalf("Negotiate error = %v, want ErrHandshakeFailed", err)
	}
}

func TestDialer_Negotiate_WrongConnectionType(t *testing.T) {
	// Passing a non-*connection to Negotiate must return an error.
	d := &Dialer{}
	_, err := d.Negotiate(context.Background(), &wrongConn{})
	if err == nil {
		t.Error("Negotiate with wrong connection type should error")
	}
}

// wrongConn satisfies poolproto.Connection but is not *connection.
type wrongConn struct{}

func (w *wrongConn) RemoteAddr() string             { return "wrong" }
func (w *wrongConn) Protocol() poolproto.ProtocolID { return poolproto.ProtocolStratumV2 }
func (w *wrongConn) Close() error                   { return nil }

func TestDialer_Negotiate_PoolRejectsSetup(t *testing.T) {
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go func() {
		// Read SetupConnection.
		if _, err := pool.dec.ReadFrame(); err != nil {
			return
		}
		// Respond with SetupConnectionError.
		writeMsgTo(pool.t, pool.conn, stratum.MsgSetupConnectionError, false,
			stratum.SetupConnectionError{Error: "version not supported"})
	}()

	conn, _ := d.Dial(ctx, "stratum+v2://pool.example.com:3336", poolproto.Credentials{User: "alice"})
	_, err := d.Negotiate(ctx, conn)
	if err == nil {
		t.Error("Negotiate should fail when pool sends SetupConnectionError")
	}
}

func TestDialer_Negotiate_PoolRejectsChannel(t *testing.T) {
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go func() {
		// Read SetupConnection, reply success.
		if _, err := pool.dec.ReadFrame(); err != nil {
			return
		}
		writeMsgTo(pool.t, pool.conn, stratum.MsgSetupConnectionSuccess, false,
			stratum.SetupConnectionSuccess{UsedVersion: 2})
		// Read OpenMiningChannel, reply error.
		if _, err := pool.dec.ReadFrame(); err != nil {
			return
		}
		writeMsgTo(pool.t, pool.conn, stratum.MsgOpenMiningChannelError, false,
			stratum.OpenMiningChannelError{ReqID: 1, Error: "unauthorized"})
	}()

	conn, _ := d.Dial(ctx, "stratum+v2://pool.example.com:3336", poolproto.Credentials{User: "alice"})
	_, err := d.Negotiate(ctx, conn)
	if err == nil {
		t.Error("Negotiate should fail when pool sends OpenMiningChannelError")
	}
}

// ============================================================================
// Session tests
// ============================================================================

func TestSession_Jobs_DeliversNewMiningJob(t *testing.T) {
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	const chanID = uint32(1)
	go func() {
		pool.doHandshake(chanID)
		// Send a future job (no min_ntime), then the SetNewPrevHash that
		// activates it — the SV2 pair required before a job is emittable.
		// NBits/ntime now arrive on SetNewPrevHash, not NewMiningJob.
		job := stratum.NewMiningJob{
			ChannelID: chanID,
			JobID:     100,
			Version:   0x20000000,
		}
		copy(job.MerkleRoot[:], make([]byte, 32))
		writeMsgTo(pool.t, pool.conn, stratum.MsgNewMiningJob, true, job)

		prev := stratum.SetNewPrevHash{
			ChannelID: chanID,
			JobID:     100,
			MinNtime:  0x60000000,
			NBits:     0x170d21b4,
		}
		writeMsgTo(pool.t, pool.conn, stratum.MsgSetNewPrevHash, true, prev)
	}()

	conn, _ := d.Dial(ctx, "stratum+v2://pool.example.com:3336", poolproto.Credentials{User: "alice"})
	sess, err := d.Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}
	defer sess.Close()

	select {
	case j, ok := <-sess.Jobs():
		if !ok {
			t.Fatal("Jobs() channel closed before receiving a job")
		}
		if j.JobID != "100" {
			t.Errorf("JobID = %q, want %q", j.JobID, "100")
		}
		if j.NBits != 0x170d21b4 {
			t.Errorf("NBits = 0x%08X, want 0x170d21b4", j.NBits)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for job from mock pool")
	}
}

func TestSession_Submit_SendsFrame(t *testing.T) {
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	submitted := make(chan stratum.Frame, 1)
	go func() {
		pool.doHandshake(1)
		// Read the SubmitSharesStandard frame the client sends, then
		// answer it with a success verdict.
		f, err := pool.dec.ReadFrame()
		if err != nil {
			pool.t.Logf("pool: read submit: %v", err)
			return
		}
		submitted <- f
		writeMsgTo(pool.t, pool.conn, stratum.MsgSubmitSharesSuccess, true,
			stratum.SubmitSharesSuccess{ChannelID: 1, LastSequenceNumber: 1})
	}()

	conn, _ := d.Dial(ctx, "stratum+v2://pool.example.com:3336", poolproto.Credentials{User: "alice"})
	sess, err := d.Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}
	defer sess.Close()

	result, err := sess.Submit(ctx, poolproto.ShareSubmission{
		JobID: "42",
		Nonce: 0xDEADBEEF,
		NTime: 0x60000001,
	})
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if !result.Accepted {
		t.Error("Submit verdict should be Accepted=true")
	}

	select {
	case f := <-submitted:
		if f.Header.MsgType != stratum.MsgSubmitSharesStandard {
			t.Errorf("pool received MsgType 0x%02X, want 0x%02X", f.Header.MsgType, stratum.MsgSubmitSharesStandard)
		}
		// The submit must carry sequence_number 1 (previously
		// hardcoded 0) so the pool's verdicts can correlate.
		ss, err := stratum.DecodeSubmitSharesStandard(f.Payload)
		if err != nil {
			t.Fatalf("decode SubmitSharesStandard: %v", err)
		}
		if ss.SequenceNumber != 1 {
			t.Errorf("SubmitSharesStandard.SequenceNumber = %d, want 1", ss.SequenceNumber)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("pool did not receive SubmitSharesStandard within 2s")
	}
}

func TestSession_Close_ClosesJobsChannel(t *testing.T) {
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go pool.doHandshake(1)

	conn, _ := d.Dial(ctx, "stratum+v2://pool.example.com:3336", poolproto.Credentials{User: "alice"})
	sess, err := d.Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}

	if err := sess.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// After Close the read loop exits and jobsCh is closed.
	select {
	case _, ok := <-sess.Jobs():
		if ok {
			t.Error("Jobs() should be closed after Session.Close()")
		}
	case <-time.After(2 * time.Second):
		t.Error("Jobs() channel not closed within 2s after Close()")
	}
}

func TestSession_SuggestedDifficulty_Default(t *testing.T) {
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go pool.doHandshake(1)

	conn, _ := d.Dial(ctx, "stratum+v2://pool.example.com:3336", poolproto.Credentials{})
	sess, err := d.Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}
	defer sess.Close()

	// No difficulty frame received yet; must return 0.
	if d := sess.SuggestedDifficulty(); d != 0 {
		t.Errorf("SuggestedDifficulty() = %v, want 0", d)
	}
}

func TestConnection_Close_IsIdempotent(t *testing.T) {
	_, c := net.Pipe()
	conn := &connection{raw: c, remoteAddr: "test"}
	if err := conn.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}
	// Second Close must not panic and should return an error (pipe already closed).
	_ = conn.Close()
}

// ============================================================================
// Unit tests for package-level helpers
// ============================================================================

// ============================================================================
// Dial — real-TCP and dial-error paths
// ============================================================================

func TestDialer_Dial_RealTCPListener(t *testing.T) {
	// Verify the nil-dialFn path (real net.Dialer) against a local listener.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skip("cannot bind listener")
	}
	defer ln.Close()
	go func() {
		c, _ := ln.Accept()
		if c != nil {
			c.Close()
		}
	}()

	d := &Dialer{} // no dialFn → real TCP path
	ctx := context.Background()
	conn, err := d.Dial(ctx, "stratum+v2://"+ln.Addr().String(), poolproto.Credentials{User: "test"})
	if err != nil {
		t.Fatalf("Dial with real TCP listener: %v", err)
	}
	conn.Close()
}

func TestDialer_Dial_DialFnError(t *testing.T) {
	d := &Dialer{
		dialFn: func(_ context.Context, _ string) (net.Conn, error) {
			return nil, net.ErrClosed
		},
	}
	_, err := d.Dial(context.Background(), "stratum+v2://pool.example.com:3336", poolproto.Credentials{})
	if err == nil {
		t.Error("Dial with failing dialFn should return error")
	}
}

// ============================================================================
// Negotiate — all early-exit error paths
// ============================================================================

func TestDialer_Negotiate_SendSetupConnectionFails(t *testing.T) {
	// Close the server-side pipe immediately so the client Write fails.
	server, client := net.Pipe()
	server.Close() // closed before any write from client

	d := makeDialer(client)
	conn, _ := d.Dial(context.Background(), "stratum+v2://x:3336", poolproto.Credentials{})
	_, err := d.Negotiate(context.Background(), conn)
	if err == nil {
		t.Error("Negotiate should fail when sending SetupConnection to closed conn")
	}
}

func TestDialer_Negotiate_ReadSetupResponseFails(t *testing.T) {
	// Server reads SetupConnection then closes without replying.
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go func() {
		pool.dec.ReadFrame() //nolint:errcheck — discard
		pool.conn.Close()
	}()

	conn, _ := d.Dial(ctx, "stratum+v2://x:3336", poolproto.Credentials{})
	_, err := d.Negotiate(ctx, conn)
	if err == nil {
		t.Error("Negotiate should fail when server closes without SetupConnection reply")
	}
}

func TestDialer_Negotiate_SetupResponseGarbage(t *testing.T) {
	// Send a SetupConnectionSuccess frame (0x01) with a 0-byte payload.
	// DecodeSetupConnectionSuccess requires at least 2 bytes, so DispatchFrame
	// returns an error on this truncated frame.
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go func() {
		pool.dec.ReadFrame() //nolint:errcheck
		// msg_type=0x01 (SetupConnectionSuccess), payload_length=0.
		pool.conn.Write([]byte{0x00, 0x00, 0x01, 0x00, 0x00, 0x00}) //nolint:errcheck
	}()

	conn, _ := d.Dial(ctx, "stratum+v2://x:3336", poolproto.Credentials{})
	_, err := d.Negotiate(ctx, conn)
	if err == nil {
		t.Error("Negotiate should fail when DispatchFrame returns error for SetupConnection response")
	}
}

func TestDialer_Negotiate_UnexpectedMsgDuringSetup(t *testing.T) {
	// Server replies to SetupConnection with an unexpected message type.
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go func() {
		pool.dec.ReadFrame() //nolint:errcheck
		// Send OpenMiningChannelSuccess instead of SetupConnectionSuccess/Error.
		writeMsgTo(pool.t, pool.conn, stratum.MsgOpenMiningChannelSuccess, false,
			stratum.OpenMiningChannelSuccess{ReqID: 1, ChannelID: 1, ExtraNonce2Size: 4})
	}()

	conn, _ := d.Dial(ctx, "stratum+v2://x:3336", poolproto.Credentials{})
	_, err := d.Negotiate(ctx, conn)
	if err == nil {
		t.Error("Negotiate should fail on unexpected message type during setup")
	}
}

func TestDialer_Negotiate_SendOpenMiningChannelFails(t *testing.T) {
	// Server sends SetupConnectionSuccess then closes immediately.
	// The client reads success, then tries to send OpenMiningChannel → Write fails.
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go func() {
		pool.dec.ReadFrame() //nolint:errcheck
		writeMsgTo(pool.t, pool.conn, stratum.MsgSetupConnectionSuccess, false,
			stratum.SetupConnectionSuccess{UsedVersion: 2})
		pool.conn.Close() // close right after success reply
	}()

	conn, _ := d.Dial(ctx, "stratum+v2://x:3336", poolproto.Credentials{})
	_, err := d.Negotiate(ctx, conn)
	if err == nil {
		t.Error("Negotiate should fail when connection closes after SetupConnectionSuccess")
	}
}

func TestDialer_Negotiate_ReadOpenMiningResponseFails(t *testing.T) {
	// Server reads SetupConnection+OpenMiningChannel, then closes without replying.
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go func() {
		pool.dec.ReadFrame() //nolint:errcheck
		writeMsgTo(pool.t, pool.conn, stratum.MsgSetupConnectionSuccess, false,
			stratum.SetupConnectionSuccess{UsedVersion: 2})
		pool.dec.ReadFrame() //nolint:errcheck
		pool.conn.Close()
	}()

	conn, _ := d.Dial(ctx, "stratum+v2://x:3336", poolproto.Credentials{})
	_, err := d.Negotiate(ctx, conn)
	if err == nil {
		t.Error("Negotiate should fail when server closes without OpenMiningChannel reply")
	}
}

func TestDialer_Negotiate_OpenMiningResponseGarbage(t *testing.T) {
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go func() {
		pool.dec.ReadFrame() //nolint:errcheck
		writeMsgTo(pool.t, pool.conn, stratum.MsgSetupConnectionSuccess, false,
			stratum.SetupConnectionSuccess{UsedVersion: 2})
		pool.dec.ReadFrame() //nolint:errcheck
		// OpenMiningChannelSuccess (0x11) with 0-byte payload → DispatchFrame error.
		pool.conn.Write([]byte{0x00, 0x00, 0x11, 0x00, 0x00, 0x00}) //nolint:errcheck
	}()

	conn, _ := d.Dial(ctx, "stratum+v2://x:3336", poolproto.Credentials{})
	_, err := d.Negotiate(ctx, conn)
	if err == nil {
		t.Error("Negotiate should fail when DispatchFrame returns error for OpenMiningChannel response")
	}
}

func TestDialer_Negotiate_UnexpectedMsgDuringChannelOpen(t *testing.T) {
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go func() {
		pool.dec.ReadFrame() //nolint:errcheck
		writeMsgTo(pool.t, pool.conn, stratum.MsgSetupConnectionSuccess, false,
			stratum.SetupConnectionSuccess{UsedVersion: 2})
		pool.dec.ReadFrame() //nolint:errcheck
		// Send SetupConnectionSuccess (unexpected during channel-open phase).
		writeMsgTo(pool.t, pool.conn, stratum.MsgSetupConnectionSuccess, false,
			stratum.SetupConnectionSuccess{UsedVersion: 2})
	}()

	conn, _ := d.Dial(ctx, "stratum+v2://x:3336", poolproto.Credentials{})
	_, err := d.Negotiate(ctx, conn)
	if err == nil {
		t.Error("Negotiate should fail on unexpected message type during channel open")
	}
}

// ============================================================================
// readLoop — context cancellation inside select
// ============================================================================

func TestSession_Jobs_ContextCancelExitsLoop(t *testing.T) {
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go pool.doHandshake(1)

	conn, _ := d.Dial(ctx, "stratum+v2://x:3336", poolproto.Credentials{})
	sess, err := d.Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}

	// Cancel the context while the read loop is blocking on ReadFrame.
	// The loop sees ctx.Done() at the top of its next iteration or in the select.
	cancel()

	select {
	case _, ok := <-sess.Jobs():
		if ok {
			// A job was buffered; drain until closed.
			for range sess.Jobs() {
			}
		}
		// jobsCh closed — loop exited as expected.
	case <-time.After(2 * time.Second):
		t.Error("Jobs() channel not closed after context cancellation")
	}
}

// ============================================================================
// Submit — error path when underlying connection is closed
// ============================================================================

func TestSession_Submit_ErrorOnClosedConn(t *testing.T) {
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go pool.doHandshake(1)

	conn, _ := d.Dial(ctx, "stratum+v2://x:3336", poolproto.Credentials{})
	sess, err := d.Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}

	// Close the underlying connection so the next Write fails.
	sess.Close()

	_, err = sess.Submit(ctx, poolproto.ShareSubmission{JobID: "1", Nonce: 0xDEADBEEF})
	if err == nil {
		t.Error("Submit on closed connection should return error")
	}
}

// ============================================================================
// readLoop — ctx.Done() fires while trying to forward a job (buffer full)
// ============================================================================

func TestSession_Jobs_ContextCancelDuringJobSend(t *testing.T) {
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// jobsCh has a buffer of 8. Send 12 jobs without reading from Jobs() to
	// fill the buffer, then cancel ctx so the readLoop's select fires ctx.Done().
	// SetNewPrevHash first establishes havePrev so each job (HasMinNtime=true)
	// emits immediately instead of waiting as a future job.
	done := make(chan struct{})
	// Closing the conn unblocks a mid-write pool goroutine (net.Pipe writes
	// block until the peer reads); the wait then guarantees no t.Logf races
	// past test teardown even on an early t.Fatal.
	defer func() { clientConn.Close(); <-done }()
	go func() {
		defer close(done)
		pool.doHandshake(1)
		prev := stratum.SetNewPrevHash{ChannelID: 1, JobID: 0, MinNtime: 0x60000000, NBits: 0x1d00ffff}
		writeMsgTo(pool.t, pool.conn, stratum.MsgSetNewPrevHash, true, prev)
		for i := 0; i < 12; i++ {
			job := stratum.NewMiningJob{
				ChannelID:   1,
				JobID:       uint32(i),
				HasMinNtime: true,
				MinNtime:    0x60000000,
				Version:     0x20000000,
			}
			copy(job.MerkleRoot[:], make([]byte, 32))
			writeMsgTo(pool.t, pool.conn, stratum.MsgNewMiningJob, true, job)
		}
	}()

	conn, _ := d.Dial(ctx, "stratum+v2://x:3336", poolproto.Credentials{})
	sess, err := d.Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}
	defer sess.Close()

	// Give the readLoop time to fill the buffer, then cancel.
	time.Sleep(20 * time.Millisecond)
	cancel()

	// Jobs() channel must close when the loop exits.
	select {
	case <-sess.Jobs():
		// drain remaining buffered jobs
		for range sess.Jobs() {
		}
	case <-time.After(3 * time.Second):
		t.Error("Jobs() channel not closed after ctx cancel with full buffer")
	}
}

// ============================================================================
// readLoop — unrecognised frame causes continue (not return)
// ============================================================================

func TestSession_Jobs_MalformedFrameSkipped(t *testing.T) {
	// Send a SubmitSharesSuccess frame (0x1c) with 0-byte payload.
	// DecodeSubmitSharesSuccess requires at least some bytes, so DispatchFrame
	// returns an error. The readLoop must `continue` (not exit) and still
	// deliver the subsequent valid job.
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go func() {
		pool.doHandshake(1)
		// SubmitSharesSuccess (0x1c) with 0-byte payload → DispatchFrame error.
		pool.conn.Write([]byte{0x00, 0x00, 0x1c, 0x00, 0x00, 0x00}) //nolint:errcheck
		// Then establish the chain tip and send a real (immediately-active)
		// job — readLoop should continue past the malformed frame and
		// deliver it.
		prev := stratum.SetNewPrevHash{ChannelID: 1, JobID: 77, MinNtime: 0x60000000, NBits: 0x1d00ffff}
		writeMsgTo(pool.t, pool.conn, stratum.MsgSetNewPrevHash, true, prev)
		job := stratum.NewMiningJob{ChannelID: 1, JobID: 77, HasMinNtime: true, MinNtime: 0x60000000, Version: 0x20000000}
		copy(job.MerkleRoot[:], make([]byte, 32))
		writeMsgTo(pool.t, pool.conn, stratum.MsgNewMiningJob, true, job)
	}()

	conn, _ := d.Dial(ctx, "stratum+v2://x:3336", poolproto.Credentials{})
	sess, err := d.Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}
	defer sess.Close()

	select {
	case j, ok := <-sess.Jobs():
		if !ok {
			t.Fatal("Jobs() closed before receiving the job")
		}
		if j.JobID != "77" {
			t.Errorf("JobID = %q, want 77", j.JobID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for job after malformed frame")
	}
}

// ============================================================================
// sendMsg — write-error path via closed connection, and encode-error path
// ============================================================================

func TestSendMsg_WriteError(t *testing.T) {
	server, client := net.Pipe()
	server.Close() // close server so client Write fails
	defer client.Close()

	err := sendMsg(client, stratum.MsgSetupConnection, false, &stratum.SetupConnection{
		Protocol: stratum.MiningProtocol, MinVersion: 2, MaxVersion: 2,
		Endpoint: "x:1", Vendor: "test",
	})
	if err == nil {
		t.Error("sendMsg to closed conn should return error")
	}
}

// errEncodable is a fake encodable that always returns an error from Encode.
type errEncodable struct{}

func (e errEncodable) Encode() ([]byte, error) { return nil, net.ErrClosed }

func TestSendMsg_EncodeError(t *testing.T) {
	_, client := net.Pipe()
	defer client.Close()
	if err := sendMsg(client, 0x01, false, errEncodable{}); err == nil {
		t.Error("sendMsg with failing Encode should return error")
	}
}

// bigEncodable returns a payload larger than MaxMessageLength so that
// stratum.WrapMessage returns an error.
type bigEncodable struct{}

func (b bigEncodable) Encode() ([]byte, error) {
	return make([]byte, stratum.MaxMessageLength+1), nil
}

func TestSendMsg_WrapMessageError(t *testing.T) {
	_, client := net.Pipe()
	defer client.Close()
	if err := sendMsg(client, 0x01, false, bigEncodable{}); err == nil {
		t.Error("sendMsg with oversized payload should return WrapMessage error")
	}
}

// ============================================================================
// Unit tests for package-level helpers
// ============================================================================

func TestFloat64FromBits(t *testing.T) {
	cases := []float64{0, 1, -1, 3.14, 1e100, math.Inf(1), math.Inf(-1)}
	for _, want := range cases {
		bits := math.Float64bits(want)
		got := float64FromBits(bits)
		if math.IsNaN(want) {
			if !math.IsNaN(got) {
				t.Errorf("float64FromBits(NaN bits) = %v, want NaN", got)
			}
		} else if got != want {
			t.Errorf("float64FromBits(0x%016X) = %v, want %v", bits, got, want)
		}
	}
}

// dialTCP must reach a live listener and honor context cancellation.
func TestDialTCP_ConnectsToLocalListener(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		c, err := ln.Accept()
		if err == nil {
			accepted <- c
		}
	}()

	conn, err := dialTCP(context.Background(), ln.Addr().String())
	if err != nil {
		t.Fatalf("dialTCP: %v", err)
	}
	conn.Close()
	select {
	case c := <-accepted:
		c.Close()
	case <-time.After(2 * time.Second):
		t.Fatal("listener never saw the connection")
	}
}

func TestDialTCP_RespectsCancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := dialTCP(ctx, "192.0.2.1:3333"); err == nil {
		t.Fatal("dialTCP succeeded with a cancelled context")
	}
}

// TestSession_Submit_SharesErrorVerdict checks that a pool's
// SubmitSharesError is correlated back to the submit's sequence number
// and surfaced as the ShareResult reason.
func TestSession_Submit_SharesErrorVerdict(t *testing.T) {
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go func() {
		pool.doHandshake(1)
		f, err := pool.dec.ReadFrame()
		if err != nil {
			pool.t.Logf("pool: read submit: %v", err)
			return
		}
		ss, err := stratum.DecodeSubmitSharesStandard(f.Payload)
		if err != nil {
			pool.t.Logf("pool: decode submit: %v", err)
			return
		}
		writeMsgTo(pool.t, pool.conn, stratum.MsgSubmitSharesError, true,
			stratum.SubmitSharesError{ChannelID: 1, SequenceNumber: ss.SequenceNumber, Error: "stale-share"})
	}()

	conn, _ := d.Dial(ctx, "stratum+v2://pool.example.com:3336", poolproto.Credentials{User: "alice"})
	sess, err := d.Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}
	defer sess.Close()

	result, err := sess.Submit(ctx, poolproto.ShareSubmission{JobID: "7", Nonce: 1})
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if result.Accepted {
		t.Error("rejected share should report Accepted=false")
	}
	if result.Reason != "stale-share" {
		t.Errorf("ShareResult.Reason = %q, want %q", result.Reason, "stale-share")
	}
}

// TestSession_Submit_ContextExpiry_Provisional checks that when no
// verdict arrives before the submit context expires, Submit returns the
// documented provisional result (submitted but unconfirmed) rather than
// blocking forever.
func TestSession_Submit_ContextExpiry_Provisional(t *testing.T) {
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	go func() {
		pool.doHandshake(1)
		// Read and discard the submit frame; never answer it.
		_, _ = pool.dec.ReadFrame()
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	conn, _ := d.Dial(ctx, "stratum+v2://pool.example.com:3336", poolproto.Credentials{User: "alice"})
	sess, err := d.Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}
	defer sess.Close()

	subCtx, subCancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer subCancel()
	result, err := sess.Submit(subCtx, poolproto.ShareSubmission{JobID: "9", Nonce: 2})
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if !result.Accepted {
		t.Error("unconfirmed share should report the provisional Accepted=true")
	}
	if !result.Unconfirmed {
		t.Error("provisional result should carry Unconfirmed=true")
	}
}

// TestSession_Submit_ConnCloseDrainsPending checks that closing the
// connection resolves an in-flight submit instead of hanging it.
func TestSession_Submit_ConnCloseDrainsPending(t *testing.T) {
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	go func() {
		pool.doHandshake(1)
		// Read the submit, then drop the connection without a verdict.
		_, _ = pool.dec.ReadFrame()
		pool.conn.Close()
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	conn, _ := d.Dial(ctx, "stratum+v2://pool.example.com:3336", poolproto.Credentials{User: "alice"})
	sess, err := d.Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}

	result, err := sess.Submit(ctx, poolproto.ShareSubmission{JobID: "5", Nonce: 3})
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if result.Accepted || result.Reason == "" {
		t.Errorf("closed-connection submit should report Accepted=false with a reason, got %+v", result)
	}
	if !result.Unconfirmed {
		t.Error("connection drop delivered no verdict — result should be Unconfirmed")
	}
}

// TestSession_SetTarget_UpdatesSuggestedDifficulty checks that a pool's
// SetTarget frame updates SuggestedDifficulty from the U256 max_target.
func TestSession_SetTarget_UpdatesSuggestedDifficulty(t *testing.T) {
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go func() {
		pool.doHandshake(1)
		// Assign the difficulty-1 target (nBits 0x1d00ffff equivalent)
		// as the share target: diff1Target = 0xffff << 208.
		var target [32]byte
		target[26], target[27] = 0xff, 0xff
		writeMsgTo(pool.t, pool.conn, stratum.MsgSetTarget, true,
			stratum.SetTarget{ChannelID: 1, MaxTarget: target})
	}()

	conn, _ := d.Dial(ctx, "stratum+v2://pool.example.com:3336", poolproto.Credentials{User: "alice"})
	sess, err := d.Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}
	defer sess.Close()

	deadline := time.Now().Add(2 * time.Second)
	for {
		if got := sess.SuggestedDifficulty(); got != 0 {
			if math.Abs(got-1.0) > 1e-9 {
				t.Fatalf("SuggestedDifficulty() = %v, want 1.0 (diff1 target)", got)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("SuggestedDifficulty() stayed 0 after SetTarget")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TestSession_SetTarget_ReemitsActiveJob checks that a SetTarget frame
// re-issues the currently active job carrying the new U256 share target,
// matching the engine's updateWork-on-SetTarget semantics.
func TestSession_SetTarget_ReemitsActiveJob(t *testing.T) {
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go func() {
		pool.doHandshake(1)
		writeMsgTo(pool.t, pool.conn, stratum.MsgSetNewPrevHash, true,
			stratum.SetNewPrevHash{ChannelID: 1, JobID: 0, MinNtime: 0x60000000, NBits: 0x1d00ffff})
		writeMsgTo(pool.t, pool.conn, stratum.MsgNewMiningJob, true,
			stratum.NewMiningJob{ChannelID: 1, JobID: 7, HasMinNtime: true, MinNtime: 0x60000000})
		var target [32]byte
		target[26], target[27] = 0xff, 0xff // diff1 target
		writeMsgTo(pool.t, pool.conn, stratum.MsgSetTarget, true,
			stratum.SetTarget{ChannelID: 1, MaxTarget: target})
	}()

	conn, _ := d.Dial(ctx, "stratum+v2://pool.example.com:3336", poolproto.Credentials{User: "alice"})
	sess, err := d.Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}
	defer sess.Close()

	// First delivery: the new job (target still unset — zero before any
	// SetTarget arrives).
	j1 := <-sess.Jobs()
	if j1.JobID != "7" {
		t.Fatalf("first job = %q, want 7", j1.JobID)
	}
	var zero [32]byte
	if j1.Target != zero {
		t.Fatalf("first job Target = %x, want zero (no SetTarget yet)", j1.Target)
	}

	// SetTarget re-issues the same job with the raw U256 share target.
	j2 := <-sess.Jobs()
	if j2.JobID != "7" {
		t.Fatalf("re-issued job = %q, want 7", j2.JobID)
	}
	if j2.CleanJobs {
		t.Error("target re-issue should not mark the job clean")
	}
	if j2.Target[26] != 0xff || j2.Target[27] != 0xff {
		t.Errorf("re-issued job Target = %x, want diff1 target at bytes 26-27", j2.Target)
	}
}

// TestSession_Submit_BatchCountsAttachedOnce checks that a
// SubmitSharesSuccess's batch accounting counters are attached to
// exactly one of the submits the ack resolves — aggregating across
// returned results counts the frame once.
func TestSession_Submit_BatchCountsAttachedOnce(t *testing.T) {
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go func() {
		pool.doHandshake(1)
		// Read both submits, then ack them with one frame carrying
		// batch counters.
		for i := 0; i < 2; i++ {
			if _, err := pool.dec.ReadFrame(); err != nil {
				pool.t.Logf("pool: read submit %d: %v", i, err)
				return
			}
		}
		writeMsgTo(pool.t, pool.conn, stratum.MsgSubmitSharesSuccess, true,
			stratum.SubmitSharesSuccess{ChannelID: 1, LastSequenceNumber: 2, NewSubmitsAccepted: 2, NewSharesSummed: 3})
	}()

	conn, _ := d.Dial(ctx, "stratum+v2://pool.example.com:3336", poolproto.Credentials{User: "alice"})
	sess, err := d.Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}
	defer sess.Close()

	// Two submits must be in flight before the single ack arrives.
	type outcome struct {
		res poolproto.ShareResult
		err error
	}
	results := make(chan outcome, 2)
	for i := 0; i < 2; i++ {
		go func(nonce uint32) {
			r, e := sess.Submit(ctx, poolproto.ShareSubmission{JobID: "3", Nonce: nonce})
			results <- outcome{r, e}
		}(uint32(i))
	}

	var totalAccepted, countCarriers, submits, shares int
	for i := 0; i < 2; i++ {
		o := <-results
		if o.err != nil {
			t.Fatalf("Submit: %v", o.err)
		}
		if o.res.Accepted {
			totalAccepted++
		}
		if o.res.NewSubmitsAccepted != 0 || o.res.NewSharesSummed != 0 {
			countCarriers++
			submits += int(o.res.NewSubmitsAccepted)
			shares += int(o.res.NewSharesSummed)
		}
	}
	if totalAccepted != 2 {
		t.Errorf("accepted submits = %d, want 2", totalAccepted)
	}
	if countCarriers != 1 {
		t.Errorf("results carrying batch counts = %d, want exactly 1", countCarriers)
	}
	if submits != 2 || shares != 3 {
		t.Errorf("batch counts = (%d, %d), want (2, 3)", submits, shares)
	}
}

// ============================================================================
// ChannelID + TLS dial path
// ============================================================================

// TestSession_ChannelID verifies the poolproto.ChannelIdentifier
// extension: ChannelID returns the value negotiated in
// OpenMiningChannelSuccess so consumers can label work correctly.
func TestSession_ChannelID(t *testing.T) {
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go pool.doHandshake(42)

	conn, err := d.Dial(ctx, "stratum+v2://pool.example.com:3336", poolproto.Credentials{User: "alice"})
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	sess, err := d.Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}
	defer sess.Close()

	ident, ok := sess.(poolproto.ChannelIdentifier)
	if !ok {
		t.Fatal("session does not implement poolproto.ChannelIdentifier")
	}
	if got := ident.ChannelID(); got != 42 {
		t.Errorf("ChannelID = %d, want 42 (from OpenMiningChannelSuccess)", got)
	}
}

// TestDialer_Dial_TLSAttemptsTLS pins the stratum+v2tls:// transport fix:
// a TLS dialer must attempt a real TLS handshake, never fall back to
// plaintext. Pointed at a listener that only speaks plain TCP, the dial
// fails inside the TLS handshake with a TLS-specific error.
func TestDialer_Dial_TLSAttemptsTLS(t *testing.T) {
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
		buf := make([]byte, 64)
		_, _ = c.Read(buf) // plain TCP sink: TLS ClientHello goes nowhere
	}()

	d := &Dialer{useTLS: true}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	_, err = d.Dial(ctx, "stratum+v2tls://"+ln.Addr().String(), poolproto.Credentials{})
	if err == nil {
		t.Fatal("TLS dial against a plaintext listener should fail")
	}
	if !strings.Contains(err.Error(), "TLS dial") {
		t.Errorf("error = %q, want a TLS-specific dial failure (proves TLS was attempted)", err.Error())
	}
}

// TestDialer_Dial_TLSBadCAPEM: an invalid CA bundle fails before any
// network traffic rather than silently dropping the operator's pin.
func TestDialer_Dial_TLSBadCAPEM(t *testing.T) {
	d := &Dialer{useTLS: true}
	_, err := d.Dial(context.Background(), "stratum+v2tls://127.0.0.1:1",
		poolproto.Credentials{TLSRootCAsPEM: []byte("not pem")})
	if err == nil {
		t.Fatal("TLS dial with an unreadable CA bundle should fail")
	}
	if !strings.Contains(err.Error(), "TLS dial") {
		t.Errorf("error = %q, want TLS dial CA error", err.Error())
	}
}

// A pool-directed Reconnect (sv2-spec §3.6.5) must end the session: the
// read loop records the directive, closes the connection, and Jobs()
// closes — the signal the engine's reconnect machinery waits on. We
// deliberately do NOT follow the pool-supplied host:port (same posture
// as V1 client.reconnect: an unauthenticated redirect would hand the
// hash rate to an arbitrary endpoint).
func TestDialer_Session_ReconnectDirectiveEndsSession(t *testing.T) {
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go func() {
		pool.doHandshake(7)
		writeMsgTo(pool.t, pool.conn, stratum.MsgReconnect, false,
			stratum.Reconnect{NewHost: "alt.pool.example", NewPort: 4444})
	}()

	conn, err := d.Dial(ctx, "stratum+v2://pool.example.com:3336", poolproto.Credentials{User: "alice"})
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	sess, err := d.Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}
	defer sess.Close()

	select {
	case _, ok := <-sess.Jobs():
		if ok {
			t.Error("Jobs() should close on pool Reconnect, not yield a job")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Jobs() not closed after pool Reconnect")
	}

	directive := sess.(*session).lastReconnect.Load()
	if directive == nil {
		t.Fatal("reconnect directive not recorded")
	}
	if directive.NewHost != "alt.pool.example" || directive.NewPort != 4444 {
		t.Errorf("directive = %+v, want host=alt.pool.example port=4444", directive)
	}

	// The recorded directive must surface through SessionEndDetail for
	// the engine's "pool closed connection" log line.
	info, ok := sess.(*session).SessionEndInfo()
	if !ok || !strings.Contains(info, "alt.pool.example:4444") {
		t.Errorf("SessionEndInfo = (%q, %v), want reconnect detail mentioning alt.pool.example:4444", info, ok)
	}
}

// A pool-directed CloseChannel (§5.3.9) ends the channel — the sender
// MUST stop sending on it — so the session can no longer mine and must
// terminate: the read loop records the close (with the pool's stated
// reason) and Jobs() closes, the signal the engine's reconnect
// machinery waits on.
func TestDialer_Session_CloseChannelEndsSession(t *testing.T) {
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go func() {
		pool.doHandshake(7)
		writeMsgTo(pool.t, pool.conn, stratum.MsgCloseChannel, true,
			stratum.CloseChannel{ChannelID: 7, ReasonCode: "channel migrated"})
	}()

	conn, err := d.Dial(ctx, "stratum+v2://pool.example.com:3336", poolproto.Credentials{User: "alice"})
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	sess, err := d.Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}
	defer sess.Close()

	select {
	case _, ok := <-sess.Jobs():
		if ok {
			t.Error("Jobs() should close on CloseChannel, not yield a job")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Jobs() not closed after CloseChannel")
	}

	closed := sess.(*session).lastChannelClose.Load()
	if closed == nil {
		t.Fatal("CloseChannel not recorded")
	}
	if closed.ChannelID != 7 || closed.ReasonCode != "channel migrated" {
		t.Errorf("close record = %+v, want channel 7 reason \"channel migrated\"", closed)
	}

	// CloseChannel is the more specific end cause and takes precedence
	// in SessionEndDetail (a Reconnect, if any, is secondary).
	info, ok := sess.(*session).SessionEndInfo()
	if !ok || !strings.Contains(info, "channel 7 closed by pool") || !strings.Contains(info, "channel migrated") {
		t.Errorf("SessionEndInfo = (%q, %v), want CloseChannel detail", info, ok)
	}
}

func TestSessionEndInfo_NoPoolStatedCause(t *testing.T) {
	// A session that never saw Reconnect/CloseChannel reports no end
	// detail — the engine keeps the plain "pool closed connection".
	s := &session{}
	if _, ok := s.SessionEndInfo(); ok {
		t.Error("SessionEndInfo on a fresh session should be ok=false")
	}
}

// UpdateNominalHashrate (poolproto.NominalHashrateUpdater) serialises
// UpdateChannel (msg_type 0x16, channel_msg) with the channel's ID, the
// measured hashrate as F32, and an unbounded maximum_target — the
// device makes no difficulty request; var-diff stays pool-side.
func TestDialer_Session_UpdateNominalHashrate(t *testing.T) {
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	frameCh := make(chan stratum.Frame, 1)
	go func() {
		pool.doHandshake(7)
		f, err := pool.dec.ReadFrame()
		if err == nil {
			frameCh <- f
		}
	}()

	conn, err := d.Dial(ctx, "stratum+v2://pool.example.com:3336", poolproto.Credentials{User: "alice"})
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	sess, err := d.Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}
	defer sess.Close()

	u, ok := sess.(poolproto.NominalHashrateUpdater)
	if !ok {
		t.Fatal("session does not implement NominalHashrateUpdater")
	}
	if err := u.UpdateNominalHashrate(ctx, 1234.5); err != nil {
		t.Fatalf("UpdateNominalHashrate: %v", err)
	}

	var f stratum.Frame
	select {
	case f = <-frameCh:
	case <-time.After(2 * time.Second):
		t.Fatal("pool never received UpdateChannel")
	}
	if f.Header.MsgType != stratum.MsgUpdateChannel {
		t.Fatalf("msg_type = %#x, want %#x (UpdateChannel)", f.Header.MsgType, stratum.MsgUpdateChannel)
	}
	if !f.Header.ChannelMsg() {
		t.Error("channel_msg bit not set on UpdateChannel")
	}
	uc, err := stratum.DecodeUpdateChannel(f.Payload)
	if err != nil {
		t.Fatalf("DecodeUpdateChannel: %v", err)
	}
	if uc.ChannelID != 7 {
		t.Errorf("channel_id = %d, want 7", uc.ChannelID)
	}
	if uc.NominalHashRate != float32(1234.5) {
		t.Errorf("nominal_hash_rate = %v, want 1234.5", uc.NominalHashRate)
	}
	if uc.MaximumTarget != stratum.MaxTargetUnbounded {
		t.Error("maximum_target not advertised unbounded")
	}
}

// An UpdateChannelError reply (the pool rejected our update) decodes
// cleanly and does not disturb the session — acceptance is silent, a
// rejection is advisory only.
func TestDialer_Session_UpdateChannelErrorIsAdvisory(t *testing.T) {
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go func() {
		pool.doHandshake(7)
		writeMsgTo(pool.t, pool.conn, stratum.MsgUpdateChannelError, true,
			stratum.UpdateChannelError{ChannelID: 7, ErrorCode: "invalid-channel"})
	}()

	conn, err := d.Dial(ctx, "stratum+v2://pool.example.com:3336", poolproto.Credentials{User: "alice"})
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	sess, err := d.Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}
	defer sess.Close()

	// Session must survive: Jobs() stays open (no close before timeout).
	select {
	case _, ok := <-sess.Jobs():
		if !ok {
			t.Error("Jobs() closed on advisory UpdateChannelError")
		}
	case <-time.After(300 * time.Millisecond):
	}
}

func TestTipState_PendingBounded(t *testing.T) {
	// A pool flooding NewMiningJob frames must not grow the pending map
	// without limit — entries are only cleared by SetNewPrevHash.
	tip := newTipState()
	for i := uint32(1); i <= 3*maxPendingJobs; i++ {
		tip.feed(&stratum.Message{NewMiningJob: &stratum.NewMiningJob{JobID: i}})
	}
	if got := len(tip.pending); got > maxPendingJobs {
		t.Fatalf("pending grew past bound: %d > %d", got, maxPendingJobs)
	}
	// The newest job is always retained, so a SetNewPrevHash naming it
	// still emits it as a clean job.
	last := uint32(3 * maxPendingJobs)
	job, _, clean := tip.feed(&stratum.Message{SetNewPrevHash: &stratum.SetNewPrevHash{
		JobID:    last,
		NBits:    0x1d00ffff,
		MinNtime: 100,
	}})
	if job == nil {
		t.Fatal("SetNewPrevHash naming the newest job emitted nothing")
	}
	if job.JobID != last || !clean {
		t.Fatalf("emitted job = %+v clean=%v, want job %d clean", job, clean, last)
	}
}

// ============================================================================
// readLoop — silent pool times out via the read deadline
// ============================================================================

func TestSession_Jobs_SilentPoolTimesOut(t *testing.T) {
	// A wedged pool that accepts the handshake then goes silent must not
	// hang the session forever — the per-read deadline (same policy as
	// stratumv1) ends the loop.
	old := readFrameDeadline
	readFrameDeadline = 50 * time.Millisecond
	defer func() { readFrameDeadline = old }()

	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go pool.doHandshake(1) // completes, then stays silent

	conn, _ := d.Dial(ctx, "stratum+v2://x:3336", poolproto.Credentials{})
	sess, err := d.Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}
	defer sess.Close()

	select {
	case _, ok := <-sess.Jobs():
		if ok {
			t.Fatal("expected Jobs() channel to close on read timeout, got a job")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("readLoop did not exit within the read deadline")
	}
}

// ============================================================================
// Negotiate — wedged pools fail via deadlines instead of hanging
// ============================================================================

func TestDialer_Negotiate_SilentPoolTimesOut(t *testing.T) {
	// Pool drains our writes but never responds: the handshake read must
	// fail via the deadline, not block forever.
	old := readFrameDeadline
	readFrameDeadline = 50 * time.Millisecond
	defer func() { readFrameDeadline = old }()

	server, client := net.Pipe()
	defer server.Close()
	defer client.Close()
	// Drain the client's writes so sendMsg completes, then stay silent.
	go func() { _, _ = io.Copy(io.Discard, server) }()

	d := makeDialer(client)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	conn, err := d.Dial(ctx, "stratum+v2://x:3336", poolproto.Credentials{})
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	if _, err := d.Negotiate(ctx, conn); err == nil {
		t.Fatal("Negotiate should fail when the pool never answers SetupConnection")
	}
}

func TestDialer_Negotiate_UnreadingPoolWriteTimesOut(t *testing.T) {
	// Pool never reads: the handshake write must fail via the write
	// deadline rather than block on a full pipe.
	old := writeFrameDeadline
	writeFrameDeadline = 50 * time.Millisecond
	defer func() { writeFrameDeadline = old }()

	server, client := net.Pipe()
	defer server.Close()
	defer client.Close()
	// No reader goroutine: the client's Write blocks immediately.

	d := makeDialer(client)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	conn, err := d.Dial(ctx, "stratum+v2://x:3336", poolproto.Credentials{})
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := d.Negotiate(ctx, conn)
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("Negotiate should fail when the pool never reads")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Negotiate write blocked past the write deadline")
	}
}
