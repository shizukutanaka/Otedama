// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package stratumv1

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/poolproto"
)

// ============================================================================
// parseAddress
// ============================================================================

func TestParseAddress_TCPScheme(t *testing.T) {
	got, err := parseAddress("stratum+tcp://pool.example.com:3333")
	if err != nil {
		t.Fatalf("parseAddress: %v", err)
	}
	if got != "pool.example.com:3333" {
		t.Errorf("got %q, want pool.example.com:3333", got)
	}
}

func TestParseAddress_TLSScheme(t *testing.T) {
	got, err := parseAddress("stratum+tls://pool.example.com:3334")
	if err != nil {
		t.Fatalf("parseAddress: %v", err)
	}
	if got != "pool.example.com:3334" {
		t.Errorf("got %q, want pool.example.com:3334", got)
	}
}

func TestParseAddress_UnsupportedScheme(t *testing.T) {
	for _, url := range []string{
		"http://pool.example.com",
		"stratum+v2://pool.example.com",
		"pool.example.com:3333",
		"",
	} {
		_, err := parseAddress(url)
		if err == nil {
			t.Errorf("parseAddress(%q) should fail", url)
		}
	}
}

func TestParseAddress_EmptyHost(t *testing.T) {
	_, err := parseAddress("stratum+tcp://")
	if err == nil {
		t.Error("empty host should fail")
	}
}

// ============================================================================
// parseNotify — real pool fixture
// ============================================================================

func TestParseNotify_RealisticPayload(t *testing.T) {
	// Real-world mining.notify params shape (Slushpool v1 format):
	// [job_id, prevhash, coinb1, coinb2, merkle_branch, version, nbits, ntime, clean]
	raw := json.RawMessage(`[
		"60",
		"4d16b6f85af6e2198f44ae2a6de67f78487ae5611b77c6c0440b921e00000000",
		"01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff20",
		"ffffffff0100f2052a010000004341041b0e8c2567c12536aa13357b79a073dc4444acb83c4ec7a0e2f99dd7457516c5817242da796924ca4e99947d087fedf9ce467cb9f7c6287078f801df276fdf84ac00000000",
		[],
		"00000002",
		"1d00ffff",
		"68d36c5e",
		true
	]`)

	job, err := parseNotify(raw)
	if err != nil {
		t.Fatalf("parseNotify: %v", err)
	}
	if job.JobID != "60" {
		t.Errorf("JobID = %q, want 60", job.JobID)
	}
	if job.Version != 0x00000002 {
		t.Errorf("Version = 0x%08x, want 0x00000002", job.Version)
	}
	if job.NBits != 0x1d00ffff {
		t.Errorf("NBits = 0x%08x, want 0x1d00ffff", job.NBits)
	}
	if !job.CleanJobs {
		t.Error("CleanJobs = false, want true")
	}
	if job.ReceivedAt.IsZero() {
		t.Error("ReceivedAt is zero")
	}
}

func TestParseNotify_TooFewParams(t *testing.T) {
	raw := json.RawMessage(`["60", "deadbeef"]`)
	_, err := parseNotify(raw)
	if err == nil {
		t.Error("parseNotify with 2 params should fail")
	}
}

func TestParseNotify_CleanJobsAsInt(t *testing.T) {
	// Some pool implementations encode clean_jobs as 0/1 instead of bool.
	raw := json.RawMessage(`[
		"60",
		"4d16b6f85af6e2198f44ae2a6de67f78487ae5611b77c6c0440b921e00000000",
		"01", "ff", [], "00000002", "1d00ffff", "68d36c5e",
		1
	]`)
	job, err := parseNotify(raw)
	if err != nil {
		t.Fatalf("parseNotify: %v", err)
	}
	if !job.CleanJobs {
		t.Error("CleanJobs from int 1 should be true")
	}
}

func TestParseNotify_MalformedJSON(t *testing.T) {
	raw := json.RawMessage(`{not an array}`)
	_, err := parseNotify(raw)
	if err == nil {
		t.Error("malformed JSON should produce error")
	}
}

// ============================================================================
// parseDifficulty
// ============================================================================

func TestParseDifficulty_Valid(t *testing.T) {
	d, ok := parseDifficulty(json.RawMessage(`[1024.5]`))
	if !ok {
		t.Fatal("parseDifficulty returned !ok")
	}
	if d != 1024.5 {
		t.Errorf("difficulty = %v, want 1024.5", d)
	}
}

func TestParseDifficulty_Empty(t *testing.T) {
	_, ok := parseDifficulty(json.RawMessage(`[]`))
	if ok {
		t.Error("parseDifficulty with empty array should be !ok")
	}
}

func TestParseDifficulty_Malformed(t *testing.T) {
	_, ok := parseDifficulty(json.RawMessage(`not json`))
	if ok {
		t.Error("malformed input should be !ok")
	}
}

// ============================================================================
// parseSetExtranonce
// ============================================================================

func TestParseSetExtranonce_Valid(t *testing.T) {
	en1, sz, ok := parseSetExtranonce(json.RawMessage(`["abc12345", 4]`))
	if !ok {
		t.Fatal("parseSetExtranonce returned !ok")
	}
	if en1 != "abc12345" {
		t.Errorf("extranonce1 = %q, want abc12345", en1)
	}
	if sz != 4 {
		t.Errorf("size = %d, want 4", sz)
	}
}

func TestParseSetExtranonce_TooFewParams(t *testing.T) {
	_, _, ok := parseSetExtranonce(json.RawMessage(`["abc"]`))
	if ok {
		t.Error("single-element params should fail")
	}
}

// ============================================================================
// trimRight
// ============================================================================

func TestTrimRight(t *testing.T) {
	tests := map[string]string{
		"hello\n":     "hello",
		"hello\r\n":   "hello",
		"hello":       "hello",
		"\n\n\nhello": "\n\n\nhello",
		"":            "",
		"\n":          "",
	}
	for input, want := range tests {
		got := string(trimRight([]byte(input)))
		if got != want {
			t.Errorf("trimRight(%q) = %q, want %q", input, got, want)
		}
	}
}

// ============================================================================
// float64 atomic round-trip
// ============================================================================

func TestFloat64Conversion_RoundTrip(t *testing.T) {
	for _, f := range []float64{0, 1, 1024.5, 1e-9, 1e9, -42.5} {
		bits := float64ToUint64(f)
		back := uint64ToFloat64(bits)
		if back != f {
			t.Errorf("round trip %v → %d → %v failed", f, bits, back)
		}
	}
}

// ============================================================================
// rpcMessage.uintID — multiple ID types
// ============================================================================

func TestRPCMessage_UintID_FromFloat(t *testing.T) {
	m := rpcMessage{ID: float64(42)}
	if got := m.uintID(); got != 42 {
		t.Errorf("uintID() = %d, want 42", got)
	}
}

func TestRPCMessage_UintID_FromString(t *testing.T) {
	m := rpcMessage{ID: "42"}
	if got := m.uintID(); got != 42 {
		t.Errorf("uintID() = %d, want 42", got)
	}
}

func TestRPCMessage_UintID_FromInt(t *testing.T) {
	m := rpcMessage{ID: int(42)}
	if got := m.uintID(); got != 42 {
		t.Errorf("uintID() = %d, want 42", got)
	}
}

func TestRPCMessage_UintID_NonNumericStringYieldsZero(t *testing.T) {
	m := rpcMessage{ID: "abc"}
	if got := m.uintID(); got != 0 {
		t.Errorf("uintID() = %d, want 0 (parse failure)", got)
	}
}

// ============================================================================
// Dialer.Protocol
// ============================================================================

func TestDialer_Protocol_TCP(t *testing.T) {
	d := &Dialer{useTLS: false}
	if got := d.Protocol(); got != poolproto.ProtocolStratumV1 {
		t.Errorf("Protocol = %v, want StratumV1", got)
	}
}

func TestDialer_Protocol_TLS(t *testing.T) {
	d := &Dialer{useTLS: true}
	if got := d.Protocol(); got != poolproto.ProtocolStratumV1TLS {
		t.Errorf("Protocol = %v, want StratumV1TLS", got)
	}
}

func TestDialer_DialBadURL(t *testing.T) {
	d := &Dialer{}
	_, err := d.Dial(context.Background(), "ftp://example.com", poolproto.Credentials{})
	if err == nil {
		t.Error("Dial with non-stratum scheme should fail")
	}
}

// ============================================================================
// End-to-end: net.Pipe-driven session
// ============================================================================

// fakePool is a minimal V1 pool that runs over a net.Pipe.
// It accepts mining.submit and replies based on a configured verdict.
type fakePool struct {
	conn      net.Conn
	verdict   bool   // result for mining.submit
	notifyJob string // optional: job ID to send as mining.notify on start
}

func (p *fakePool) run() {
	defer p.conn.Close()
	reader := bufio.NewReader(p.conn)

	if p.notifyJob != "" {
		// Send a mining.notify shortly after connect.
		notify := `{"id":null,"method":"mining.notify","params":["` + p.notifyJob + `","4d16b6f85af6e2198f44ae2a6de67f78487ae5611b77c6c0440b921e00000000","01","ff",[],"00000002","1d00ffff","68d36c5e",true]}` + "\n"
		_, _ = p.conn.Write([]byte(notify))
		// Send difficulty too.
		_, _ = p.conn.Write([]byte(`{"id":null,"method":"mining.set_difficulty","params":[1024]}` + "\n"))
	}

	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			return
		}
		var req rpcMessage
		if err := json.Unmarshal(line, &req); err != nil {
			continue
		}
		if req.Method == "mining.submit" {
			result := "true"
			if !p.verdict {
				result = "false"
			}
			id, _ := json.Marshal(req.ID)
			resp := `{"id":` + string(id) + `,"result":` + result + `,"error":null}` + "\n"
			_, _ = p.conn.Write([]byte(resp))
		}
	}
}

func TestSession_E2E_SubscribeNotifySubmitAccepted(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	pool := &fakePool{conn: serverConn, verdict: true, notifyJob: "ABC123"}
	go pool.run()

	conn := &connection{
		raw:        clientConn,
		remoteAddr: "test:0",
		protocol:   poolproto.ProtocolStratumV1,
	}
	sess := newSession(conn)
	sess.start(context.Background())
	defer sess.Close()

	// Wait for the mining.notify to arrive.
	select {
	case job := <-sess.Jobs():
		if job.JobID != "ABC123" {
			t.Errorf("got job %q, want ABC123", job.JobID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("did not receive job within 2s")
	}

	// Difficulty should be set.
	// Allow a brief moment for set_difficulty to be processed.
	deadline := time.After(500 * time.Millisecond)
waitDifficulty:
	for {
		if sess.SuggestedDifficulty() == 1024 {
			break
		}
		select {
		case <-deadline:
			// Must break the for loop, not just the select: deadline is a
			// one-shot channel, so falling through would spin forever.
			t.Errorf("difficulty = %v, want 1024", sess.SuggestedDifficulty())
			break waitDifficulty
		case <-time.After(20 * time.Millisecond):
		}
	}

	// Submit and verify the verdict.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	res, err := sess.Submit(ctx, poolproto.ShareSubmission{
		JobID: "ABC123",
		Nonce: 0xdeadbeef,
		NTime: 0x68d36c5e,
	})
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if !res.Accepted {
		t.Errorf("share rejected: %s", res.Reason)
	}
}

func TestSession_E2E_SubmitRejected(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	pool := &fakePool{conn: serverConn, verdict: false}
	go pool.run()

	conn := &connection{
		raw:        clientConn,
		remoteAddr: "test:0",
		protocol:   poolproto.ProtocolStratumV1,
	}
	sess := newSession(conn)
	sess.start(context.Background())
	defer sess.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()
	res, err := sess.Submit(ctx, poolproto.ShareSubmission{JobID: "X", Nonce: 1, NTime: 1})
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if res.Accepted {
		t.Error("share accepted; want rejected")
	}
}

func TestSession_Close_IsIdempotent(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	defer serverConn.Close()

	conn := &connection{
		raw:        clientConn,
		remoteAddr: "test:0",
		protocol:   poolproto.ProtocolStratumV1,
	}
	sess := newSession(conn)
	sess.start(context.Background())

	if err := sess.Close(); err != nil {
		t.Errorf("first Close: %v", err)
	}
	if err := sess.Close(); err != nil {
		t.Errorf("second Close: %v", err)
	}
}

func TestSession_SubmitAfterCloseFails(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	defer serverConn.Close()

	conn := &connection{
		raw:        clientConn,
		remoteAddr: "test:0",
		protocol:   poolproto.ProtocolStratumV1,
	}
	sess := newSession(conn)
	sess.start(context.Background())
	_ = sess.Close()

	_, err := sess.Submit(context.Background(), poolproto.ShareSubmission{})
	if err == nil {
		t.Error("Submit after Close should fail")
	}
}

// ============================================================================
// Registration check
// ============================================================================

func TestInit_RegistersTCPAndTLS(t *testing.T) {
	available := poolproto.Available()
	hasV1, hasV1TLS := false, false
	for _, p := range available {
		if p == poolproto.ProtocolStratumV1 {
			hasV1 = true
		}
		if p == poolproto.ProtocolStratumV1TLS {
			hasV1TLS = true
		}
	}
	if !hasV1 {
		t.Error("ProtocolStratumV1 not registered")
	}
	if !hasV1TLS {
		t.Error("ProtocolStratumV1TLS not registered")
	}
}

func TestInit_CanBeLookedUp(t *testing.T) {
	d, err := poolproto.Lookup(poolproto.ProtocolStratumV1)
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	if d == nil {
		t.Fatal("Lookup returned nil dialer")
	}
	if d.Protocol() != poolproto.ProtocolStratumV1 {
		t.Errorf("dialer protocol mismatch: %v", d.Protocol())
	}
}

// ============================================================================
// Compile-time check
// ============================================================================

func TestCompileTimeContracts(t *testing.T) {
	var _ poolproto.Dialer = (*Dialer)(nil)
	var _ poolproto.Connection = (*connection)(nil)
	var _ poolproto.Session = (*session)(nil)
}

// avoid unused-import warnings if test pruning happens
var _ = strings.HasPrefix

// ============================================================================
// Dialer.Dial — error paths
// ============================================================================

func TestDialer_Dial_UnreachableHost_TimesOut(t *testing.T) {
	d := &Dialer{}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	// 198.51.100.1 is TEST-NET-2 (RFC 5737) — routable nowhere.
	_, err := d.Dial(ctx, "stratum+tcp://198.51.100.1:39999", poolproto.Credentials{})
	if err == nil {
		t.Error("Dial to unreachable host should fail")
	}
}

func TestDialer_Dial_InvalidURL_ReturnsError(t *testing.T) {
	d := &Dialer{}
	for _, url := range []string{
		"",
		"no-scheme-at-all",
		"http://wrong-scheme:3333",
		"stratum+tcp://",
	} {
		_, err := d.Dial(context.Background(), url, poolproto.Credentials{})
		if err == nil {
			t.Errorf("Dial(%q) should fail", url)
		}
	}
}

// ============================================================================
// Session — lifecycle edge cases
// ============================================================================

func TestSession_E2E_PoolClosedMidSession(t *testing.T) {
	clientConn, serverConn := net.Pipe()

	// The current V1 Negotiate is a stub that does not drive a client-side
	// subscribe/authorize handshake (see dialer.go), so the pool does not
	// wait for requests over the synchronous net.Pipe — it simply
	// disconnects after a moment. The session's read loop must then close
	// the Jobs channel, which is the property this test verifies.
	go func() {
		time.Sleep(50 * time.Millisecond)
		serverConn.Close()
	}()

	conn := &connection{
		raw:        clientConn,
		remoteAddr: "pipe",
		protocol:   poolproto.ProtocolStratumV1,
	}
	d := &Dialer{}
	sess, err := d.Negotiate(context.Background(), conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}

	// Jobs channel should eventually close when pool disconnects.
	select {
	case _, ok := <-sess.Jobs():
		if ok {
			// Got a job before close — acceptable.
		}
		// Channel closed — expected.
	case <-time.After(2 * time.Second):
		t.Error("Jobs channel did not close after pool disconnect")
	}
	sess.Close()
}

func TestSession_Close_Idempotent(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	go func() {
		r := bufio.NewReader(serverConn)
		_, _ = r.ReadString('\n')
		fmt.Fprintf(serverConn, `{"id":1,"result":[[],"cc",2],"error":null}`+"\n")
		_, _ = r.ReadString('\n')
		fmt.Fprintf(serverConn, `{"id":2,"result":true,"error":null}`+"\n")
		// Keep alive briefly.
		time.Sleep(200 * time.Millisecond)
		serverConn.Close()
	}()

	conn := &connection{
		raw:        clientConn,
		remoteAddr: "pipe",
		protocol:   poolproto.ProtocolStratumV1,
	}
	d := &Dialer{}
	sess, err := d.Negotiate(context.Background(), conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}

	// First Close must succeed.
	if err := sess.Close(); err != nil {
		t.Errorf("first Close: %v", err)
	}
	// Second Close must not panic.
	if err := sess.Close(); err != nil {
		t.Errorf("second Close: %v", err)
	}
}

func TestSession_SuggestedDifficulty_InitialDefault(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	go func() {
		r := bufio.NewReader(serverConn)
		_, _ = r.ReadString('\n')
		fmt.Fprintf(serverConn, `{"id":1,"result":[[],"dd",2],"error":null}`+"\n")
		_, _ = r.ReadString('\n')
		fmt.Fprintf(serverConn, `{"id":2,"result":true,"error":null}`+"\n")
		time.Sleep(500 * time.Millisecond)
		serverConn.Close()
	}()

	conn := &connection{
		raw:        clientConn,
		remoteAddr: "pipe",
		protocol:   poolproto.ProtocolStratumV1,
	}
	d := &Dialer{}
	sess, err := d.Negotiate(context.Background(), conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}
	defer sess.Close()

	// Before any mining.set_difficulty, SuggestedDifficulty should be
	// a sane default (>= 0).
	diff := sess.SuggestedDifficulty()
	if diff < 0 {
		t.Errorf("initial difficulty = %v, want >= 0", diff)
	}
}

// ============================================================================
// Connection — interface compliance
// ============================================================================

func TestConnection_RemoteAddr_NotEmpty(t *testing.T) {
	c := &connection{
		remoteAddr: "1.2.3.4:3333",
		protocol:   poolproto.ProtocolStratumV1,
	}
	if c.RemoteAddr() == "" {
		t.Error("RemoteAddr is empty")
	}
	if c.Protocol() != poolproto.ProtocolStratumV1 {
		t.Errorf("Protocol = %v, want StratumV1", c.Protocol())
	}
}

func TestConnection_Close_NilRaw_DocumentsBehavior(t *testing.T) {
	// A connection with nil raw net.Conn is a programming error.
	// We document whether Close panics or not. If it does, the
	// caller has a bug (Dial should have returned an error).
	c := &connection{
		remoteAddr: "none",
		protocol:   poolproto.ProtocolStratumV1,
		// raw is nil — this is the edge case.
	}
	defer func() {
		// Recovering is acceptable — this IS a programming error.
		_ = recover()
	}()
	_ = c.Close()
}

// ============================================================================
// client.reconnect handling
// ============================================================================

func TestParseReconnect_FullParams(t *testing.T) {
	d, ok := parseReconnect(json.RawMessage(`["us-east.pool.example",4444,30]`))
	if !ok {
		t.Fatal("parseReconnect returned ok=false")
	}
	if d.Host != "us-east.pool.example" {
		t.Errorf("Host = %q, want us-east.pool.example", d.Host)
	}
	if d.Port != 4444 {
		t.Errorf("Port = %d, want 4444", d.Port)
	}
	if d.Wait != 30 {
		t.Errorf("Wait = %d, want 30", d.Wait)
	}
}

func TestParseReconnect_PortAsString(t *testing.T) {
	// Some pools encode the port as a string.
	d, ok := parseReconnect(json.RawMessage(`["host","3333",5]`))
	if !ok {
		t.Fatal("ok=false")
	}
	if d.Port != 3333 {
		t.Errorf("Port = %d, want 3333", d.Port)
	}
}

func TestParseReconnect_EmptyAndBareParams(t *testing.T) {
	// A bare client.reconnect with no params is still a valid directive.
	for _, raw := range []string{``, `[]`, `null`, `"garbage"`} {
		d, ok := parseReconnect(json.RawMessage(raw))
		if !ok {
			t.Errorf("parseReconnect(%q) ok=false, want true", raw)
		}
		if d.Host != "" || d.Port != 0 || d.Wait != 0 {
			t.Errorf("parseReconnect(%q) = %+v, want zero directive", raw, d)
		}
	}
}

// reconnectPool sends a client.reconnect notification shortly after connect,
// then keeps the pipe open. A correct client must drop the connection itself.
type reconnectPool struct {
	conn   net.Conn
	method string // "client.reconnect" or "mining.reconnect"
	params string // JSON array literal, e.g. `["h",1,2]`
}

func (p *reconnectPool) run() {
	defer p.conn.Close()
	msg := `{"id":null,"method":"` + p.method + `","params":` + p.params + "}\n"
	_, _ = p.conn.Write([]byte(msg))
	// Hold the connection open: the client must initiate the disconnect.
	time.Sleep(2 * time.Second)
}

func TestSession_E2E_ClientReconnect_ClosesSession(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	pool := &reconnectPool{conn: serverConn, method: "client.reconnect", params: `["alt.pool.example",4444,10]`}
	go pool.run()

	conn := &connection{
		raw:        clientConn,
		remoteAddr: "test:0",
		protocol:   poolproto.ProtocolStratumV1,
	}
	sess := newSession(conn)
	sess.start(context.Background())
	defer sess.Close()

	// On client.reconnect the session must end on its own: Jobs() closes.
	// This is the signal the reconnect loop uses to re-dial.
	select {
	case _, ok := <-sess.Jobs():
		if ok {
			t.Error("expected Jobs channel to close on client.reconnect")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Jobs channel did not close after client.reconnect")
	}

	// The directive must be recorded (Host parsed but deliberately not followed).
	if d := sess.lastReconnect.Load(); d == nil {
		t.Error("lastReconnect not recorded")
	} else if d.Host != "alt.pool.example" || d.Port != 4444 || d.Wait != 10 {
		t.Errorf("lastReconnect = %+v, want {alt.pool.example 4444 10}", *d)
	}
}

func TestSession_E2E_MiningReconnect_ClosesSession(t *testing.T) {
	// Some pools use the "mining." prefix for the same directive.
	clientConn, serverConn := net.Pipe()
	pool := &reconnectPool{conn: serverConn, method: "mining.reconnect", params: `[]`}
	go pool.run()

	conn := &connection{
		raw:        clientConn,
		remoteAddr: "test:0",
		protocol:   poolproto.ProtocolStratumV1,
	}
	sess := newSession(conn)
	sess.start(context.Background())
	defer sess.Close()

	select {
	case _, ok := <-sess.Jobs():
		if ok {
			t.Error("expected Jobs channel to close on mining.reconnect")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Jobs channel did not close after mining.reconnect")
	}
}
