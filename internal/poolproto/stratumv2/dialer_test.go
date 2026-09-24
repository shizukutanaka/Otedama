// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package stratumv2

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net"
	"sync/atomic"
	"syscall"
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
	// Read and discard SetupConnection.
	if _, err := p.dec.ReadFrame(); err != nil {
		p.t.Errorf("pool: read SetupConnection: %v", err)
		return
	}
	// Send SetupConnectionSuccess.
	writeMsgTo(p.t, p.conn, stratum.MsgSetupConnectionSuccess, false,
		stratum.SetupConnectionSuccess{UsedVersion: 2})

	// Read and discard OpenMiningChannel.
	if _, err := p.dec.ReadFrame(); err != nil {
		p.t.Errorf("pool: read OpenMiningChannel: %v", err)
		return
	}
	// Send OpenMiningChannelSuccess.
	writeMsgTo(p.t, p.conn, stratum.MsgOpenMiningChannelSuccess, false,
		stratum.OpenMiningChannelSuccess{
			ReqID:          1,
			ChannelID:      channelID,
			GroupChannelID: 4,
		})
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

// A consumer that never reads must not stall the frame read loop:
// while blocked the loop would miss NewMiningJob/SetNewPrevHash frames
// (the slow-client pile-up behind ESP-Miner #1913). The queue holds the
// NEWEST jobs — oldest are dropped, since a newer job always supersedes.
func TestSession_Jobs_SlowConsumerDropsOldest(t *testing.T) {
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	const chanID = uint32(1)
	const total = 20
	go func() {
		pool.doHandshake(chanID)
		// Establish the tip so jobs with min_ntime emit immediately.
		prev := stratum.SetNewPrevHash{
			ChannelID: chanID,
			JobID:     0,
			MinNtime:  0x60000000,
			NBits:     0x170d21b4,
		}
		writeMsgTo(pool.t, pool.conn, stratum.MsgSetNewPrevHash, true, prev)
		for id := 1; id <= total; id++ {
			job := stratum.NewMiningJob{
				ChannelID:   chanID,
				JobID:       uint32(id),
				Version:     0x20000000,
				HasMinNtime: true,
				MinNtime:    0x60000000,
			}
			writeMsgTo(pool.t, pool.conn, stratum.MsgNewMiningJob, true, job)
		}
	}()

	conn, _ := d.Dial(ctx, "stratum+v2://pool.example.com:3336", poolproto.Credentials{User: "alice"})
	sess, err := d.Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}
	defer sess.Close()

	// Let the read loop drain all 20 frames into the bounded queue
	// (capacity 8). If emit still blocked, the loop would wedge on job 9
	// and the later jobs would never arrive.
	time.Sleep(200 * time.Millisecond)

	got := map[string]bool{}
	deadline := time.After(2 * time.Second)
	for {
		select {
		case j, ok := <-sess.Jobs():
			if !ok {
				t.Fatal("Jobs() channel closed early")
			}
			got[j.JobID] = true
		default:
			goto drained
		case <-deadline:
			t.Fatal("timeout draining jobs channel")
		}
	}
drained:
	if len(got) > 8 {
		t.Fatalf("queued jobs = %d, exceeds channel capacity 8", len(got))
	}
	if !got["20"] {
		t.Error("newest job 20 not queued — read loop stalled or job lost")
	}
	if got["1"] {
		t.Error("oldest job 1 still queued — drop-oldest should have evicted it")
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
		// Read the SubmitSharesStandard frame the client sends, then ack it.
		f, err := pool.dec.ReadFrame()
		if err != nil {
			pool.t.Logf("pool: read submit: %v", err)
			return
		}
		submitted <- f
		if ss, err := stratum.DecodeSubmitSharesStandard(f.Payload); err == nil {
			writeMsgTo(pool.t, pool.conn, stratum.MsgSubmitSharesSuccess, true,
				stratum.SubmitSharesSuccess{
					ChannelID:          ss.ChannelID,
					LastSequenceNumber: ss.SequenceNumber,
					NewSubmitsAccepted: 1,
				})
		}
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
		t.Error("Submit provisional result should be Accepted=true")
	}

	select {
	case f := <-submitted:
		if f.Header.MsgType != stratum.MsgSubmitSharesStandard {
			t.Errorf("pool received MsgType 0x%02X, want 0x%02X", f.Header.MsgType, stratum.MsgSubmitSharesStandard)
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
			stratum.OpenMiningChannelSuccess{ReqID: 1, ChannelID: 1, GroupChannelID: 4})
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
	go func() {
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
// readLoop — unrecognized frame causes continue (not return)
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

// ============================================================================
// Session — verdict correlation, SetTarget, initial target (session 259)
// ============================================================================

// TestSession_Submit_VerdictAccepted: Submit waits for the pool's
// SubmitSharesSuccess correlated by SequenceNumber and reports Accepted.
func TestSession_Submit_VerdictAccepted(t *testing.T) {
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go func() {
		pool.doHandshake(1)
		f, err := pool.dec.ReadFrame()
		if err != nil {
			return
		}
		ss, err := stratum.DecodeSubmitSharesStandard(f.Payload)
		if err != nil {
			return
		}
		writeMsgTo(pool.t, pool.conn, stratum.MsgSubmitSharesSuccess, true,
			stratum.SubmitSharesSuccess{
				ChannelID:          ss.ChannelID,
				LastSequenceNumber: ss.SequenceNumber,
				NewSubmitsAccepted: 1,
			})
	}()

	conn, _ := d.Dial(ctx, "stratum+v2://x:3336", poolproto.Credentials{})
	sess, err := d.Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}
	defer sess.Close()

	res, err := sess.Submit(ctx, poolproto.ShareSubmission{JobID: "1", Nonce: 7, NTime: 1})
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if !res.Accepted {
		t.Error("SubmitSharesSuccess should report Accepted=true")
	}
}

// TestSession_Submit_VerdictRejected: SubmitSharesError reports
// Accepted=false with the pool's error string as the reason.
func TestSession_Submit_VerdictRejected(t *testing.T) {
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go func() {
		pool.doHandshake(1)
		f, err := pool.dec.ReadFrame()
		if err != nil {
			return
		}
		ss, err := stratum.DecodeSubmitSharesStandard(f.Payload)
		if err != nil {
			return
		}
		writeMsgTo(pool.t, pool.conn, stratum.MsgSubmitSharesError, true,
			stratum.SubmitSharesError{
				ChannelID:      ss.ChannelID,
				SequenceNumber: ss.SequenceNumber,
				Error:          "low-difficulty-share",
			})
	}()

	conn, _ := d.Dial(ctx, "stratum+v2://x:3336", poolproto.Credentials{})
	sess, err := d.Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}
	defer sess.Close()

	res, err := sess.Submit(ctx, poolproto.ShareSubmission{JobID: "1", Nonce: 7, NTime: 1})
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if res.Accepted {
		t.Error("SubmitSharesError should report Accepted=false")
	}
	if res.Reason != "low-difficulty-share" {
		t.Errorf("Reason = %q, want pool error string", res.Reason)
	}
}

// TestSession_Submit_NoVerdict_CancelReturnsCtxErr: with no pool verdict,
// Submit blocks until ctx cancellation surfaces ctx.Err rather than the
// misleading provisional accept the pre-259 code returned immediately.
func TestSession_Submit_NoVerdict_CancelReturnsCtxErr(t *testing.T) {
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	go func() {
		pool.doHandshake(1)
		// Read and ignore the submit frame; never send a verdict.
		_, _ = pool.dec.ReadFrame()
	}()

	conn, _ := d.Dial(ctx, "stratum+v2://x:3336", poolproto.Credentials{})
	sess, err := d.Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}
	defer sess.Close()

	subCtx, subCancel := context.WithTimeout(ctx, 300*time.Millisecond)
	defer subCancel()
	_, err = sess.Submit(subCtx, poolproto.ShareSubmission{JobID: "1", Nonce: 7})
	if err == nil {
		t.Fatal("Submit with no verdict should fail on ctx cancel")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("Submit should return ctx.Err (deadline), got %v", err)
	}
}

// TestSession_SetTarget_UpdatesShareTargetAndDifficulty: a live SetTarget
// message re-points ShareTarget and SuggestedDifficulty mid-session.
func TestSession_SetTarget_UpdatesShareTargetAndDifficulty(t *testing.T) {
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	var tgt [32]byte
	for i := range tgt {
		tgt[i] = 0xFF
	}
	go func() {
		pool.doHandshake(1)
		writeMsgTo(pool.t, pool.conn, stratum.MsgSetTarget, true,
			stratum.SetTarget{ChannelID: 1, MaxTarget: tgt})
	}()

	conn, _ := d.Dial(ctx, "stratum+v2://x:3336", poolproto.Credentials{})
	sess, err := d.Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}
	defer sess.Close()

	st, ok := sess.(interface{ ShareTarget() [32]byte })
	if !ok {
		t.Fatal("session does not expose ShareTarget")
	}
	deadline := time.After(2 * time.Second)
	for st.ShareTarget() != tgt {
		select {
		case <-deadline:
			t.Fatal("SetTarget never updated ShareTarget")
		case <-time.After(5 * time.Millisecond):
		}
	}
	if sess.SuggestedDifficulty() <= 0 {
		t.Error("SetTarget should update SuggestedDifficulty")
	}
}

// TestNegotiate_InitialShareTarget_FromOpenMiningChannelSuccess: the
// OpenMiningChannelSuccess.target is the initial share target —
// zero target stays unassigned (jobs fall back to nBits).
func TestNegotiate_InitialShareTarget_FromOpenMiningChannelSuccess(t *testing.T) {
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	var tgt [32]byte
	tgt[31] = 0x7F // small nonzero target
	go func() {
		if _, err := pool.dec.ReadFrame(); err != nil {
			return
		}
		writeMsgTo(pool.t, pool.conn, stratum.MsgSetupConnectionSuccess, false,
			stratum.SetupConnectionSuccess{UsedVersion: 2})
		if _, err := pool.dec.ReadFrame(); err != nil {
			return
		}
		writeMsgTo(pool.t, pool.conn, stratum.MsgOpenMiningChannelSuccess, false,
			stratum.OpenMiningChannelSuccess{ReqID: 1, ChannelID: 9, Target: tgt, GroupChannelID: 4})
	}()

	conn, _ := d.Dial(ctx, "stratum+v2://x:3336", poolproto.Credentials{})
	sess, err := d.Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}
	defer sess.Close()

	st := sess.(interface{ ShareTarget() [32]byte })
	if st.ShareTarget() != tgt {
		t.Error("ShareTarget should equal the OpenMiningChannelSuccess target")
	}
	if sess.SuggestedDifficulty() <= 0 {
		t.Error("SuggestedDifficulty should reflect the initial target")
	}
}

// TestNegotiate_ZeroInitialTarget_StaysUnassigned: a zero
// OpenMiningChannelSuccess.target leaves ShareTarget unset so the engine
// applies the nBits block target.
func TestNegotiate_ZeroInitialTarget_StaysUnassigned(t *testing.T) {
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go pool.doHandshake(1) // zero Target

	conn, _ := d.Dial(ctx, "stratum+v2://x:3336", poolproto.Credentials{})
	sess, err := d.Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}
	defer sess.Close()

	st := sess.(interface{ ShareTarget() [32]byte })
	if st.ShareTarget() != ([32]byte{}) {
		t.Error("zero initial target must leave ShareTarget unassigned")
	}
	if sess.SuggestedDifficulty() != 0 {
		t.Error("zero initial target must leave SuggestedDifficulty at 0")
	}
}

// TestSession_Jobs_StampedWithChannelAndTarget: emitted jobs carry the
// channel ID and the current share target (the poolproto.Job fields the
// engine consumes).
func TestSession_Jobs_StampedWithChannelAndTarget(t *testing.T) {
	pool, clientConn := newPoolSide(t)
	d := makeDialer(clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	var tgt [32]byte
	for i := range tgt {
		tgt[i] = 0xFF
	}
	go func() {
		if _, err := pool.dec.ReadFrame(); err != nil {
			return
		}
		writeMsgTo(pool.t, pool.conn, stratum.MsgSetupConnectionSuccess, false,
			stratum.SetupConnectionSuccess{UsedVersion: 2})
		if _, err := pool.dec.ReadFrame(); err != nil {
			return
		}
		writeMsgTo(pool.t, pool.conn, stratum.MsgOpenMiningChannelSuccess, false,
			stratum.OpenMiningChannelSuccess{ReqID: 1, ChannelID: 5, Target: tgt, GroupChannelID: 4})
		writeMsgTo(pool.t, pool.conn, stratum.MsgNewMiningJob, true,
			stratum.NewMiningJob{ChannelID: 5, JobID: 42, Version: 0x20000000})
		writeMsgTo(pool.t, pool.conn, stratum.MsgSetNewPrevHash, true,
			stratum.SetNewPrevHash{ChannelID: 5, JobID: 42})
	}()

	conn, _ := d.Dial(ctx, "stratum+v2://x:3336", poolproto.Credentials{})
	sess, err := d.Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}
	defer sess.Close()

	select {
	case job := <-sess.Jobs():
		if job.ChannelID != 5 {
			t.Errorf("job.ChannelID = %d, want 5", job.ChannelID)
		}
		if !job.TargetAssigned {
			t.Error("job.TargetAssigned should be true (initial target set)")
		}
		if job.ShareTarget != tgt {
			t.Error("job.ShareTarget should equal the assigned target")
		}
		if job.JobID != "42" {
			t.Errorf("job.JobID = %q, want 42", job.JobID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no job emitted after SetNewPrevHash")
	}
}

// TestDialer_Dial_SetsTCPNoDelay pins ESP-Miner #1722 parity: the
// plaintext dial must set TCP_NODELAY so a share submission is not held
// behind Nagle + delayed ACKs.
func TestDialer_Dial_SetsTCPNoDelay(t *testing.T) {
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
	conn, err := d.Dial(context.Background(), "stratum+v2://"+ln.Addr().String(), poolproto.Credentials{})
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer conn.Close()

	raw, ok := conn.(*connection).raw.(*net.TCPConn)
	if !ok {
		t.Fatalf("raw conn is %T, want *net.TCPConn", conn.(*connection).raw)
	}
	sc, err := raw.SyscallConn()
	if err != nil {
		t.Fatalf("SyscallConn: %v", err)
	}
	val, gerr := 0, error(nil)
	if err := sc.Control(func(fd uintptr) {
		val, gerr = syscall.GetsockoptInt(int(fd), syscall.IPPROTO_TCP, syscall.TCP_NODELAY)
	}); err != nil {
		t.Fatalf("Control: %v", err)
	}
	if gerr != nil {
		t.Fatalf("getsockopt: %v", gerr)
	}
	if val == 0 {
		t.Error("TCP_NODELAY not set on the pool socket (ESP-Miner #1722)")
	}
}

// ============================================================================
// jobState pending bound — a hostile/buggy upstream streaming
// NewMiningJob frames between tips must not grow memory unboundedly.
// ============================================================================

func TestJobState_PendingBounded(t *testing.T) {
	s := &session{jobsCh: make(chan poolproto.Job, 4)}
	state := &jobState{pending: make(map[uint32]*stratum.NewMiningJob)}
	ctx := context.Background()

	// Flood 2×cap future jobs (HasMinNtime=false → none emit).
	const total = 2 * maxPendingJobs
	for i := 0; i < total; i++ {
		j := &stratum.NewMiningJob{ChannelID: 1, JobID: uint32(i)}
		if !s.onNewMiningJob(ctx, state, j) {
			t.Fatalf("onNewMiningJob(%d) returned false", i)
		}
	}
	if got := len(state.pending); got != maxPendingJobs {
		t.Fatalf("pending size = %d, want capped at %d", got, maxPendingJobs)
	}
	if len(state.order) != len(state.pending) {
		t.Fatalf("order len %d != pending len %d", len(state.order), len(state.pending))
	}
	// Oldest evicted, newest retained.
	if _, ok := state.pending[0]; ok {
		t.Error("job 0 should have been evicted (oldest)")
	}
	newest := uint32(total - 1)
	if _, ok := state.pending[newest]; !ok {
		t.Error("newest job evicted — eviction should drop oldest first")
	}

	// SetNewPrevHash naming the newest must still emit it.
	p := &stratum.SetNewPrevHash{ChannelID: 1, JobID: newest, MinNtime: 1, NBits: 0x1d00ffff}
	if !s.onSetNewPrevHash(ctx, state, p) {
		t.Fatal("onSetNewPrevHash returned false")
	}
	select {
	case job := <-s.jobsCh:
		if job.JobID != fmt.Sprintf("%d", newest) {
			t.Errorf("emitted JobID = %q, want %d", job.JobID, newest)
		}
	case <-time.After(time.Second):
		t.Fatal("named job not emitted after SetNewPrevHash")
	}
	// After promotion the pending set holds only the named job.
	if len(state.pending) != 1 {
		t.Errorf("pending after tip = %d, want 1 (named job retained)", len(state.pending))
	}
}

func TestJobState_InsertJobOverwriteSameID(t *testing.T) {
	state := &jobState{pending: make(map[uint32]*stratum.NewMiningJob)}
	for i := 0; i < 3; i++ {
		j := &stratum.NewMiningJob{ChannelID: 1, JobID: 7, Version: uint32(i)}
		state.insertJob(j)
	}
	if len(state.pending) != 1 || len(state.order) != 1 {
		t.Fatalf("duplicate JobID grew pending: map=%d order=%d", len(state.pending), len(state.order))
	}
	if state.pending[7].Version != 2 {
		t.Errorf("overwrite: Version = %d, want latest 2", state.pending[7].Version)
	}
}

// deadlineRecordingConn records SetReadDeadline calls so a test can
// assert the read loop arms a per-read deadline without waiting the
// full 5-minute interval.
type deadlineRecordingConn struct {
	net.Conn
	deadlines atomic.Int64
}

func (c *deadlineRecordingConn) SetReadDeadline(t time.Time) error {
	c.deadlines.Add(1)
	return c.Conn.SetReadDeadline(t)
}

// TestReadLoop_ArmsReadDeadline pins the zombie-session defense: every
// ReadFrame must be preceded by a read deadline so a pool that keeps
// the TCP connection open but never sends frames eventually surfaces
// a read error and the engine reconnects.
func TestReadLoop_ArmsReadDeadline(t *testing.T) {
	server, client := net.Pipe()
	defer server.Close()
	raw := &deadlineRecordingConn{Conn: client}
	conn := &connection{raw: raw, remoteAddr: "test", protocol: poolproto.ProtocolStratumV2}
	sess := &session{
		conn:   conn,
		dec:    stratum.NewDecoder(raw),
		jobsCh: make(chan poolproto.Job, 8),
		done:   make(chan struct{}),
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go sess.readLoop(ctx)

	deadline := time.After(2 * time.Second)
	for raw.deadlines.Load() == 0 {
		select {
		case <-deadline:
			t.Fatal("readLoop never armed a read deadline")
		default:
			time.Sleep(5 * time.Millisecond)
		}
	}

	// Closing the peer must end the loop — the same exit path a
	// deadline expiry takes.
	_ = server.Close()
	select {
	case <-sess.done:
	case <-time.After(2 * time.Second):
		t.Fatal("readLoop did not exit after connection close")
	}
}

// TestReadLoop_CloseChannelEndsSession pins the spec path: a
// CloseChannel addressed to this session's channel ends the session
// (engine reconnects on a fresh channel), while a close for another
// channel id is ignored.
func TestReadLoop_CloseChannelEndsSession(t *testing.T) {
	server, client := net.Pipe()
	defer server.Close()
	conn := &connection{raw: client, remoteAddr: "test", protocol: poolproto.ProtocolStratumV2}
	sess := &session{
		conn:   conn,
		dec:    stratum.NewDecoder(client),
		chanID: 7,
		jobsCh: make(chan poolproto.Job, 8),
		done:   make(chan struct{}),
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go sess.readLoop(ctx)

	writeClose := func(channelID uint32) {
		t.Helper()
		payload, err := stratum.CloseChannel{ChannelID: channelID, ReasonCode: "pool reorg"}.Encode()
		if err != nil {
			t.Fatalf("CloseChannel.Encode: %v", err)
		}
		f, err := stratum.WrapMessage(stratum.MsgCloseChannel, true, payload)
		if err != nil {
			t.Fatalf("WrapMessage: %v", err)
		}
		data, err := stratum.EncodeFrame(f)
		if err != nil {
			t.Fatalf("EncodeFrame: %v", err)
		}
		if _, err := server.Write(data); err != nil {
			t.Fatalf("write CloseChannel: %v", err)
		}
	}

	// A close for a different channel must not end this session.
	writeClose(42)
	select {
	case <-sess.done:
		t.Fatal("readLoop exited on a CloseChannel for another channel")
	case <-time.After(300 * time.Millisecond):
	}

	// A close for our channel ends the session.
	writeClose(7)
	select {
	case <-sess.done:
	case <-time.After(2 * time.Second):
		t.Fatal("readLoop did not exit after CloseChannel for its channel")
	}
}

// TestReadLoop_ForeignChannelFiltered pins the channel_id guard: a
// channel_msg addressed to a channel this session does not own is
// ignored — a foreign SetTarget must not move our share target, and a
// foreign job must never reach the job channel.
func TestReadLoop_ForeignChannelFiltered(t *testing.T) {
	server, client := net.Pipe()
	defer server.Close()
	conn := &connection{raw: client, remoteAddr: "test", protocol: poolproto.ProtocolStratumV2}
	sess := &session{
		conn:   conn,
		dec:    stratum.NewDecoder(client),
		chanID: 7,
		jobsCh: make(chan poolproto.Job, 8),
		done:   make(chan struct{}),
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go sess.readLoop(ctx)

	writeMsg := func(msgType uint8, payload []byte) {
		t.Helper()
		f, err := stratum.WrapMessage(msgType, true, payload)
		if err != nil {
			t.Fatalf("WrapMessage: %v", err)
		}
		data, err := stratum.EncodeFrame(f)
		if err != nil {
			t.Fatalf("EncodeFrame: %v", err)
		}
		if _, err := server.Write(data); err != nil {
			t.Fatalf("write msg 0x%02X: %v", msgType, err)
		}
	}

	// Foreign SetTarget (channel 42): must not touch our target.
	var tgt [32]byte
	tgt[0] = 0xFF
	st, _ := stratum.SetTarget{ChannelID: 42, MaxTarget: tgt}.Encode()
	writeMsg(stratum.MsgSetTarget, st)

	// Foreign future job + prevhash (channel 42): must not emit.
	j, _ := stratum.NewMiningJob{ChannelID: 42, JobID: 9, Version: 0x20000000}.Encode()
	writeMsg(stratum.MsgNewMiningJob, j)
	ph, _ := stratum.SetNewPrevHash{ChannelID: 42, JobID: 9, MinNtime: 1, NBits: 0x1d00ffff}.Encode()
	writeMsg(stratum.MsgSetNewPrevHash, ph)

	// Give the loop a moment to process the three frames.
	select {
	case job := <-sess.jobsCh:
		t.Fatalf("foreign-channel job emitted: %+v", job)
	case <-time.After(300 * time.Millisecond):
	}
	sess.targetMu.RLock()
	assigned := sess.targetAssigned
	sess.targetMu.RUnlock()
	if assigned {
		t.Fatal("foreign SetTarget assigned our share target")
	}
	_ = server.Close()
}

// writeDeadlineRecordingConn records SetWriteDeadline calls so a test
// can assert Submit arms a per-write deadline without blocking a real
// socket until expiry.
type writeDeadlineRecordingConn struct {
	net.Conn
	writeDeadlines atomic.Int64
}

func (c *writeDeadlineRecordingConn) SetWriteDeadline(t time.Time) error {
	c.writeDeadlines.Add(1)
	return c.Conn.SetWriteDeadline(t)
}

// TestSubmit_ArmsWriteDeadline pins the V1-parity defense: every frame
// write on the session socket is preceded by a write deadline, so a
// pool that keeps reading direction alive but stops consuming our
// submits cannot wedge Submit inside a full send buffer forever.
func TestSubmit_ArmsWriteDeadline(t *testing.T) {
	server, client := net.Pipe()
	defer server.Close()
	raw := &writeDeadlineRecordingConn{Conn: client}
	conn := &connection{raw: raw, remoteAddr: "test", protocol: poolproto.ProtocolStratumV2}
	sess := &session{
		conn:   conn,
		dec:    stratum.NewDecoder(raw),
		chanID: 7,
		jobsCh: make(chan poolproto.Job, 8),
		done:   make(chan struct{}),
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Drain whatever the client writes; the verdict never comes, so
	// cancel ctx to release the waiting Submit.
	go func() {
		buf := make([]byte, 256)
		for {
			if _, err := server.Read(buf); err != nil {
				return
			}
		}
	}()

	go sess.Submit(ctx, poolproto.ShareSubmission{
		JobID:   "9",
		Nonce:   1,
		NTime:   1,
		Version: 0x20000000,
	})
	deadline := time.After(2 * time.Second)
	for raw.writeDeadlines.Load() == 0 {
		select {
		case <-deadline:
			t.Fatal("Submit never armed a write deadline")
		default:
			time.Sleep(5 * time.Millisecond)
		}
	}
	cancel()
}
