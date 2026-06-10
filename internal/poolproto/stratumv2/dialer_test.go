// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package stratumv2

import (
	"context"
	"math"
	"net"
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
			ReqID:           1,
			ChannelID:       channelID,
			ExtraNonce2Size: 4,
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
		// Send a NewMiningJob after the handshake.
		job := stratum.NewMiningJob{
			ChannelID: chanID,
			JobID:     100,
			MinNtime:  0x60000000,
			NBits:     0x170d21b4,
		}
		copy(job.MerkleRoot[:], make([]byte, 32))
		writeMsgTo(pool.t, pool.conn, stratum.MsgNewMiningJob, true, job)
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
		// Read the SubmitSharesStandard frame the client sends.
		f, err := pool.dec.ReadFrame()
		if err != nil {
			pool.t.Logf("pool: read submit: %v", err)
			return
		}
		submitted <- f
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
