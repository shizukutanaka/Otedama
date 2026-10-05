// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package stratumv1

import (
	"bufio"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/btccrypto"
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
// parseNotify — malformed required fields (fail closed)
// ============================================================================

// A notify whose required fields fail to decode must be rejected:
// a zero-filled or partially-degraded job produces shares that all
// fail self-verification — silent wasted work. V1 has no pool-side
// merkle path (that field exists only on the V2 NewMiningJob wire).
func TestParseNotify_MalformedRequiredFields(t *testing.T) {
	prev := `"4d16b6f85af6e2198f44ae2a6de67f78487ae5611b77c6c0440b921e00000000"`
	base := func(p1, p2, p3, p4, p5, p6, p7 string) json.RawMessage {
		return json.RawMessage(`["60",` + p1 + `,` + p2 + `,` + p3 + `,` + p4 + `,` + p5 + `,` + p6 + `,` + p7 + `,true]`)
	}
	cases := map[string]json.RawMessage{
		"prevhash bad hex":      base(`"zz"`, `"01"`, `"ff"`, `[]`, `"00000002"`, `"1d00ffff"`, `"68d36c5e"`),
		"prevhash short":        base(`"01"`, `"01"`, `"ff"`, `[]`, `"00000002"`, `"1d00ffff"`, `"68d36c5e"`),
		"coinb1 bad hex":        base(prev, `"zz"`, `"ff"`, `[]`, `"00000002"`, `"1d00ffff"`, `"68d36c5e"`),
		"coinb1 empty":          base(prev, `""`, `"ff"`, `[]`, `"00000002"`, `"1d00ffff"`, `"68d36c5e"`),
		"coinb2 bad hex":        base(prev, `"01"`, `"zz"`, `[]`, `"00000002"`, `"1d00ffff"`, `"68d36c5e"`),
		"coinb2 empty":          base(prev, `"01"`, `""`, `[]`, `"00000002"`, `"1d00ffff"`, `"68d36c5e"`),
		"merkle bad hex":        base(prev, `"01"`, `"ff"`, `["zz"]`, `"00000002"`, `"1d00ffff"`, `"68d36c5e"`),
		"merkle wrong length":   base(prev, `"01"`, `"ff"`, `["aabb"]`, `"00000002"`, `"1d00ffff"`, `"68d36c5e"`),
		"version bad hex":       base(prev, `"01"`, `"ff"`, `[]`, `"gg"`, `"1d00ffff"`, `"68d36c5e"`),
		"nbits bad hex":         base(prev, `"01"`, `"ff"`, `[]`, `"00000002"`, `"xx"`, `"68d36c5e"`),
		"ntime bad hex":         base(prev, `"01"`, `"ff"`, `[]`, `"00000002"`, `"1d00ffff"`, `"zz"`),
		"ntime too wide (>32b)": base(prev, `"01"`, `"ff"`, `[]`, `"00000002"`, `"1d00ffff"`, `"1ffffffff"`),
	}
	for name, raw := range cases {
		if _, err := parseNotify(raw); err == nil {
			t.Errorf("%s: expected parseNotify error, got nil", name)
		}
	}
	// Fully well-formed params still parse.
	if _, err := parseNotify(base(prev, `"01"`, `"ff"`, `[]`, `"00000002"`, `"1d00ffff"`, `"68d36c5e"`)); err != nil {
		t.Fatalf("well-formed fixture should parse: %v", err)
	}
}

// extranonce1 must be non-empty valid hex and extranonce2_size must be
// > 0 at both entry points — completeV1Job silently skips the job
// otherwise (zero MerkleRoot → every share self-verifies invalid).
func TestExtranonce_ParseBoundaries(t *testing.T) {
	for _, raw := range []string{
		`["zz", 4]`,   // non-hex en1
		`["abc", 4]`,  // odd-length en1
		`["", 4]`,     // empty en1
		`["dead", 0]`, // en2_size 0 — completeV1Job requires sz > 0
	} {
		if _, _, ok := parseSetExtranonce(json.RawMessage(raw)); ok {
			t.Errorf("parseSetExtranonce(%s) ok=true, want false", raw)
		}
	}
	for _, result := range []any{
		[]any{[]any{}, "zz", float64(4)},       // non-hex en1
		[]any{[]any{}, "abc", float64(4)},      // odd-length en1
		[]any{[]any{}, "deadbeef", float64(0)}, // en2_size 0
	} {
		if _, _, err := parseSubscribeResult(result); err == nil {
			t.Errorf("parseSubscribeResult(%v) err=nil, want error", result)
		}
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

func TestParseDifficulty_NonPositive(t *testing.T) {
	// d <= 0 collapses the share target to "accept every hash" — a pool
	// (or MitM on cleartext V1) setting it floods the submit path.
	for _, raw := range []string{`[0]`, `[-1.5]`, `[-0.0]`, `[1e999]`} {
		if _, ok := parseDifficulty(json.RawMessage(raw)); ok {
			t.Errorf("parseDifficulty(%s) should be !ok", raw)
		}
	}
	// Fractional and very small positive difficulties stay valid
	// (ESP-Miner #1594/#1779 show real pools use them).
	for _, raw := range []string{`[0.5]`, `[0.001]`, `[5e-324]`} {
		if _, ok := parseDifficulty(json.RawMessage(raw)); !ok {
			t.Errorf("parseDifficulty(%s) should be ok", raw)
		}
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
	_, err := d.Dial(context.Background(), "ftp://example.com", &poolproto.Credentials{})
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
	sess.authorized.Store(true) // test drives an established (post-authorize) session
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
	for sess.SuggestedDifficulty() != 1024 {
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
	sess.authorized.Store(true) // test drives an established (post-authorize) session
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

func TestSession_OversizedLineTerminatesSession(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	conn := &connection{
		raw:        clientConn,
		remoteAddr: "test:0",
		protocol:   poolproto.ProtocolStratumV1,
	}
	sess := newSession(conn)
	sess.start(context.Background())
	sess.authorized.Store(true) // test drives an established (post-authorize) session
	defer sess.Close()

	// A misbehaving pool streams more than maxLineBytes with no newline.
	// readLine must cap it (ReadSlice → ErrBufferFull) and end the session,
	// rather than ReadBytes accumulating the whole stream into memory.
	go func() {
		junk := make([]byte, maxLineBytes+4096)
		for i := range junk {
			junk[i] = 'a' // no '\n' anywhere
		}
		_, _ = serverConn.Write(junk) // unblocked by sess.Close() on teardown
	}()

	// readLoop returning closes Jobs(); that is our signal the session ended.
	select {
	case _, ok := <-sess.Jobs():
		if ok {
			t.Fatal("unexpected job parsed from a junk stream")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("session did not terminate on an oversized line (possible unbounded read)")
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
	sess.authorized.Store(true) // test drives an established (post-authorize) session

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
	sess.authorized.Store(true) // test drives an established (post-authorize) session
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
// rpcMessage.uintID — additional type cases (int64, unknown)
// ============================================================================

func TestRPCMessage_UintID_FromInt64(t *testing.T) {
	m := rpcMessage{ID: int64(77)}
	if got := m.uintID(); got != 77 {
		t.Errorf("uintID(int64) = %d, want 77", got)
	}
}

func TestRPCMessage_UintID_UnknownType_ReturnsZero(t *testing.T) {
	m := rpcMessage{ID: true} // bool is not a handled type
	if got := m.uintID(); got != 0 {
		t.Errorf("uintID(bool) = %d, want 0", got)
	}
}

// ============================================================================
// parseNotify — per-field unmarshal error paths
// ============================================================================

func TestParseNotify_P0NonString_Errors(t *testing.T) {
	raw := json.RawMessage(`[123,"hash","c1","c2",[],"00000002","1d00ffff","68d36c5e",true]`)
	_, err := parseNotify(raw)
	if err == nil {
		t.Error("non-string job_id should produce error")
	}
}

func TestParseNotify_P1NonString_Errors(t *testing.T) {
	raw := json.RawMessage(`["jid",456,"c1","c2",[],"00000002","1d00ffff","68d36c5e",true]`)
	_, err := parseNotify(raw)
	if err == nil {
		t.Error("non-string prevhash should produce error")
	}
}

func TestParseNotify_P5NonString_Errors(t *testing.T) {
	raw := json.RawMessage(`["jid","hash","c1","c2",[],789,"1d00ffff","68d36c5e",true]`)
	_, err := parseNotify(raw)
	if err == nil {
		t.Error("non-string version should produce error")
	}
}

func TestParseNotify_P6NonString_Errors(t *testing.T) {
	raw := json.RawMessage(`["jid","hash","c1","c2",[],"00000002",789,"68d36c5e",true]`)
	_, err := parseNotify(raw)
	if err == nil {
		t.Error("non-string nbits should produce error")
	}
}

func TestParseNotify_P7NonString_Errors(t *testing.T) {
	raw := json.RawMessage(`["jid","hash","c1","c2",[],"00000002","1d00ffff",789,true]`)
	_, err := parseNotify(raw)
	if err == nil {
		t.Error("non-string ntime should produce error")
	}
}

func TestParseNotify_CleanJobsBothFail_Errors(t *testing.T) {
	// p[8] is neither bool nor int — both unmarshal attempts fail.
	raw := json.RawMessage(`["jid","hash","c1","c2",[],"00000002","1d00ffff","68d36c5e","bad"]`)
	_, err := parseNotify(raw)
	if err == nil {
		t.Error("non-bool, non-int cleanJobs should produce error")
	}
}

// ============================================================================
// parseSetExtranonce — per-field unmarshal error paths
// ============================================================================

func TestParseSetExtranonce_P0NonString_NotOK(t *testing.T) {
	_, _, ok := parseSetExtranonce(json.RawMessage(`[123, 4]`))
	if ok {
		t.Error("non-string extranonce1 should return !ok")
	}
}

func TestParseSetExtranonce_P1NonInt_NotOK(t *testing.T) {
	_, _, ok := parseSetExtranonce(json.RawMessage(`["abc", "not-int"]`))
	if ok {
		t.Error("non-int extranonce2_size should return !ok")
	}
}

// ============================================================================
// Dialer — extra error paths
// ============================================================================

func TestDialer_Dial_DialFnError_ReturnsError(t *testing.T) {
	d := &Dialer{
		dialFn: func(_ context.Context, _ string) (net.Conn, error) {
			return nil, fmt.Errorf("injected dial error")
		},
	}
	_, err := d.Dial(context.Background(), "stratum+tcp://any.example:3333", &poolproto.Credentials{})
	if err == nil {
		t.Error("Dial with failing dialFn should return error")
	}
}

// ============================================================================
// session 170 — Negotiate error paths (dialer.go:68-70, 121-124, 125-128,
// 130-133, 145-148, 166-170)
// ============================================================================

// TestDialer_Dial_TLSBadPEM_ReturnsError covers dialer.go:68-70 —
// tlsConfigWithExtraCAs fails when the PEM buffer contains no valid certificate
// (x509.CertPool.AppendCertsFromPEM returns false for arbitrary bytes).
func TestDialer_Dial_TLSBadPEM_ReturnsError(t *testing.T) {
	d := &Dialer{useTLS: true} // dialFn and tlsConfig are nil: production path
	creds := poolproto.Credentials{TLSRootCAsPEM: []byte("not-a-pem-certificate")}
	_, err := d.Dial(context.Background(), "stratum+tls://pool.example.test:3334", &creds)
	if err == nil {
		t.Error("Dial with invalid TLS CA PEM should return an error")
	}
}

// makeNegotiateConn sets up a net.Pipe-backed connection and a Dialer whose
// dialFn returns clientConn. The caller controls the server side via serverConn.
func makeNegotiateConn(t *testing.T) (*Dialer, poolproto.Connection, net.Conn) {
	t.Helper()
	clientConn, serverConn := net.Pipe()
	d := &Dialer{
		dialFn: func(_ context.Context, _ string) (net.Conn, error) {
			return clientConn, nil
		},
	}
	conn, err := d.Dial(context.Background(), "stratum+tcp://test.local:3333", &poolproto.Credentials{})
	if err != nil {
		clientConn.Close()
		serverConn.Close()
		t.Fatalf("makeNegotiateConn Dial: %v", err)
	}
	return d, conn, serverConn
}

// TestNegotiate_SubscribeCallError covers dialer.go:121-124 —
// sess.call returns an error when the server closes the connection without
// responding to mining.subscribe (readLoop EOF cancels the pending call).
func TestNegotiate_SubscribeCallError(t *testing.T) {
	d, conn, serverConn := makeNegotiateConn(t)
	go func() {
		defer serverConn.Close()
		reader := bufio.NewReader(serverConn)
		_, _ = reader.ReadBytes('\n') // drain subscribe request; then close
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, err := d.Negotiate(ctx, conn); err == nil {
		t.Error("Negotiate: expected error when subscribe call fails (server closed)")
	}
}

// TestNegotiate_SubscribeErrResult covers dialer.go:125-128 —
// the pool responds to mining.subscribe with a non-nil JSON-RPC error field.
func TestNegotiate_SubscribeErrResult(t *testing.T) {
	d, conn, serverConn := makeNegotiateConn(t)
	go func() {
		defer serverConn.Close()
		reader := bufio.NewReader(serverConn)
		line, _ := reader.ReadBytes('\n')
		var req rpcMessage
		_ = json.Unmarshal(line, &req)
		id, _ := json.Marshal(req.ID)
		resp := `{"id":` + string(id) + `,"result":null,"error":["20","Pool full",null]}` + "\n"
		_, _ = serverConn.Write([]byte(resp))
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, err := d.Negotiate(ctx, conn); err == nil {
		t.Error("Negotiate: expected error when subscribe response contains errResult")
	}
}

// TestNegotiate_SubscribeResultUnparseable covers dialer.go:130-133 —
// parseSubscribeResult fails when the pool returns result:null with no error.
func TestNegotiate_SubscribeResultUnparseable(t *testing.T) {
	d, conn, serverConn := makeNegotiateConn(t)
	go func() {
		defer serverConn.Close()
		reader := bufio.NewReader(serverConn)
		line, _ := reader.ReadBytes('\n')
		var req rpcMessage
		_ = json.Unmarshal(line, &req)
		id, _ := json.Marshal(req.ID)
		resp := `{"id":` + string(id) + `,"result":null,"error":null}` + "\n"
		_, _ = serverConn.Write([]byte(resp))
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, err := d.Negotiate(ctx, conn); err == nil {
		t.Error("Negotiate: expected error when subscribe result cannot be parsed")
	}
}

// TestNegotiate_AuthorizeCallError covers dialer.go:145-148 —
// sess.call returns an error when the server closes the connection instead
// of responding to mining.authorize.
func TestNegotiate_AuthorizeCallError(t *testing.T) {
	d, conn, serverConn := makeNegotiateConn(t)
	go func() {
		defer serverConn.Close()
		reader := bufio.NewReader(serverConn)
		// Respond OK to subscribe.
		line, _ := reader.ReadBytes('\n')
		var req rpcMessage
		_ = json.Unmarshal(line, &req)
		id, _ := json.Marshal(req.ID)
		subscribeResp := `{"id":` + string(id) + `,"result":[[["mining.notify","s1"]],"deadbeef00",4],"error":null}` + "\n"
		_, _ = serverConn.Write([]byte(subscribeResp))
		// Read authorize then close without responding.
		_, _ = reader.ReadBytes('\n')
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, err := d.Negotiate(ctx, conn); err == nil {
		t.Error("Negotiate: expected error when authorize call fails (server closed)")
	}
}

// TestNegotiate_ExtraNonceSubscribeError covers dialer.go:166-170 —
// extranonce.subscribe fails (eerr != nil) when the server closes after
// successful subscribe/authorize; Negotiate still returns a valid session.
func TestNegotiate_ExtraNonceSubscribeError(t *testing.T) {
	d, conn, serverConn := makeNegotiateConn(t)
	go func() {
		defer serverConn.Close()
		reader := bufio.NewReader(serverConn)
		var req rpcMessage
		// Subscribe OK.
		line, _ := reader.ReadBytes('\n')
		_ = json.Unmarshal(line, &req)
		id, _ := json.Marshal(req.ID)
		_, _ = serverConn.Write([]byte(
			`{"id":` + string(id) + `,"result":[[["mining.notify","s1"]],"deadbeef00",4],"error":null}` + "\n",
		))
		// Authorize OK.
		line, _ = reader.ReadBytes('\n')
		_ = json.Unmarshal(line, &req)
		id, _ = json.Marshal(req.ID)
		_, _ = serverConn.Write([]byte(
			`{"id":` + string(id) + `,"result":true,"error":null}` + "\n",
		))
		// Read extranonce.subscribe then close without responding.
		_, _ = reader.ReadBytes('\n')
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	sess, err := d.Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: expected success (extranonce failure is non-fatal); got %v", err)
	}
	_ = sess.Close()
}

func TestDialer_Dial_DialFnSuccess_ReturnsConnection(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	defer serverConn.Close()

	d := &Dialer{
		dialFn: func(_ context.Context, _ string) (net.Conn, error) {
			return clientConn, nil
		},
	}
	c, err := d.Dial(context.Background(), "stratum+tcp://any.example:3333", &poolproto.Credentials{})
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	if c == nil {
		t.Fatal("Dial returned nil connection")
	}
	if c.RemoteAddr() == "" {
		t.Error("RemoteAddr should be non-empty")
	}
	c.Close()
}

// fakePoolConn satisfies poolproto.Connection but is NOT *connection.
type fakePoolConn struct{}

func (f *fakePoolConn) RemoteAddr() string             { return "fake:0" }
func (f *fakePoolConn) Protocol() poolproto.ProtocolID { return poolproto.ProtocolStratumV1 }
func (f *fakePoolConn) Close() error                   { return nil }

func TestDialer_Negotiate_NonV1Connection_ReturnsError(t *testing.T) {
	d := &Dialer{}
	_, err := d.Negotiate(context.Background(), &fakePoolConn{})
	if err == nil {
		t.Error("Negotiate with non-*connection should return error")
	}
}

// ============================================================================
// session.dispatch — direct unit tests (no goroutine / no pool needed)
// ============================================================================

// makeBareSess builds a minimal session for direct dispatch testing.
// It models an established session, i.e. post-authorize — the job gate
// treats notifies as delivered work, not pre-auth stash candidates.
func makeBareSess() *session {
	s := &session{
		jobsCh:   make(chan poolproto.Job, 8),
		noticeCh: make(chan string, 8),
		pending:  map[uint64]chan rpcResponse{},
	}
	s.authorized.Store(true)
	return s
}

func TestSession_Dispatch_EmptyLine_IsIgnored(t *testing.T) {
	sess := makeBareSess()
	sess.dispatch([]byte("\n"))
	if len(sess.jobsCh) != 0 {
		t.Error("empty line should not enqueue a job")
	}
}

func TestSession_Dispatch_MalformedJSON_IsIgnored(t *testing.T) {
	sess := makeBareSess()
	sess.dispatch([]byte("not valid json\n"))
	if len(sess.jobsCh) != 0 {
		t.Error("malformed JSON should not enqueue a job")
	}
}

func TestSession_Dispatch_NotifyParseError_IsIgnored(t *testing.T) {
	sess := makeBareSess()
	// mining.notify with one param instead of 9 → parseNotify error → silently ignored.
	sess.dispatch([]byte(`{"method":"mining.notify","params":["only-one"]}`))
	if len(sess.jobsCh) != 0 {
		t.Error("notify parse error should not enqueue a job")
	}
}

func TestSession_Dispatch_SetExtranonce_UpdatesFields(t *testing.T) {
	sess := makeBareSess()
	sess.dispatch([]byte(`{"method":"mining.set_extranonce","params":["deadbeef01",4]}`))
	if got := sess.extranonce1.Load(); got == nil || *got != "deadbeef01" {
		t.Errorf("extranonce1 = %v, want deadbeef01", got)
	}
	if sess.extranonce2Size.Load() != 4 {
		t.Errorf("extranonce2Size = %d, want 4", sess.extranonce2Size.Load())
	}
}

func TestSession_Dispatch_FullChannel_DropsOldest(t *testing.T) {
	sess := makeBareSess()
	// Fill channel to capacity (8) before dispatch.
	for i := 0; i < cap(sess.jobsCh); i++ {
		sess.jobsCh <- poolproto.Job{JobID: fmt.Sprintf("fill%d", i)}
	}
	// One more job: triggers the drop-oldest / push-newest path.
	sess.dispatch([]byte(`{"method":"mining.notify","params":["NEW","4d16b6f85af6e2198f44ae2a6de67f78487ae5611b77c6c0440b921e00000000","01","ff",[],"00000002","1d00ffff","68d36c5e",true]}`))
	if len(sess.jobsCh) == 0 {
		t.Error("channel empty after drop-oldest dispatch")
	}
}

func TestSession_NotifyBeforeAuthorize_IsStashedNotArmed(t *testing.T) {
	// A notify arriving before mining.authorize succeeds must not arm
	// workers: the pool has not authenticated the session, so hashpower
	// spent on it is never credited (notify-harvesting attack).
	sess := &session{
		jobsCh:   make(chan poolproto.Job, 8),
		noticeCh: make(chan string, 8),
		pending:  map[uint64]chan rpcResponse{},
	}
	notify := []byte(`{"method":"mining.notify","params":["PRE","4d16b6f85af6e2198f44ae2a6de67f78487ae5611b77c6c0440b921e00000000","01","ff",[],"00000002","1d00ffff","68d36c5e",true]}`)
	sess.dispatch(notify)
	select {
	case j := <-sess.jobsCh:
		t.Fatalf("pre-auth notify armed job %q — unauthenticated hashpower harvest", j.JobID)
	default:
	}

	// Authorization lands: the stashed job replays into the queue.
	sess.authorized.Store(true)
	sess.flushPreAuth()
	select {
	case j := <-sess.jobsCh:
		if j.JobID != "PRE" {
			t.Fatalf("replayed job %q, want PRE", j.JobID)
		}
	default:
		t.Fatal("stashed pre-auth job was not replayed after authorize")
	}
}

func TestSession_PreAuthStashPreservesOrder(t *testing.T) {
	// Notify PRE arrives pre-auth, POST after. The replay must not let the
	// older job re-arm behind the newer one.
	sess := &session{
		jobsCh:   make(chan poolproto.Job, 8),
		noticeCh: make(chan string, 8),
		pending:  map[uint64]chan rpcResponse{},
	}
	sess.dispatch([]byte(`{"method":"mining.notify","params":["PRE","4d16b6f85af6e2198f44ae2a6de67f78487ae5611b77c6c0440b921e00000000","01","ff",[],"00000002","1d00ffff","68d36c5e",true]}`))
	sess.authorized.Store(true)
	// POST has clean_jobs=false so it queues rather than superseding PRE —
	// with true it would correctly discard PRE and ordering is moot.
	sess.dispatch([]byte(`{"method":"mining.notify","params":["POST","4d16b6f85af6e2198f44ae2a6de67f78487ae5611b77c6c0440b921e00000000","01","ff",[],"00000002","1d00ffff","68d36c5e",false]}`))
	first := <-sess.jobsCh
	if first.JobID != "PRE" {
		t.Fatalf("first delivered job %q, want PRE (stash replays before later notifies)", first.JobID)
	}
	second := <-sess.jobsCh
	if second.JobID != "POST" {
		t.Fatalf("second delivered job %q, want POST", second.JobID)
	}
}

// ============================================================================
// session.call — error paths
// ============================================================================

func TestSession_Call_UnmarshalableParams_ReturnsError(t *testing.T) {
	// json.Marshal fails before any I/O: no conn needed.
	sess := &session{pending: map[uint64]chan rpcResponse{}}
	_, err := sess.call(context.Background(), 1, "test", []any{make(chan int)})
	if err == nil {
		t.Error("non-marshalable params should return error")
	}
}

func TestSession_Call_WriteError_ReturnsError(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	serverConn.Close() // close server end so Write on client fails

	conn := &connection{raw: clientConn, remoteAddr: "test:0", protocol: poolproto.ProtocolStratumV1}
	sess := newSession(conn)
	sess.start(context.Background())
	sess.authorized.Store(true) // test drives an established (post-authorize) session
	defer sess.Close()

	_, err := sess.call(context.Background(), 1, "mining.submit", nil)
	if err == nil {
		t.Error("call with closed connection should return write error")
	}
}

func TestSession_Call_ContextTimeout_ReturnsCtxError(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	defer serverConn.Close()

	conn := &connection{raw: clientConn, remoteAddr: "test:0", protocol: poolproto.ProtocolStratumV1}
	sess := newSession(conn)
	sess.start(context.Background())
	sess.authorized.Store(true) // test drives an established (post-authorize) session
	defer sess.Close()

	// Server reads the request but never responds; test ctx times out first.
	go func() {
		buf := make([]byte, 4096)
		_, _ = serverConn.Read(buf)
		time.Sleep(500 * time.Millisecond)
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	_, err := sess.call(ctx, 1, "mining.subscribe", []any{"agent"})
	if err == nil {
		t.Error("call should fail when context times out with no response")
	}
}

func TestSession_Call_SessionClosedWhileWaiting_ReturnsError(t *testing.T) {
	clientConn, serverConn := net.Pipe()

	conn := &connection{raw: clientConn, remoteAddr: "test:0", protocol: poolproto.ProtocolStratumV1}
	sess := newSession(conn)
	sess.start(context.Background())
	sess.authorized.Store(true) // test drives an established (post-authorize) session

	// Server reads the request, then close the session — this cancels the pending
	// channel so call returns "session closed before response".
	go func() {
		buf := make([]byte, 4096)
		_, _ = serverConn.Read(buf)
		time.Sleep(30 * time.Millisecond)
		sess.Close()
		serverConn.Close()
	}()

	_, err := sess.call(context.Background(), 2, "mining.subscribe", []any{"agent"})
	if err == nil {
		t.Error("call should fail when session is closed while waiting for response")
	}
}

// ============================================================================
// session.Close — cancels in-flight pending calls
// ============================================================================

func TestSession_Close_CancelsPendingCalls(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	defer serverConn.Close()

	conn := &connection{raw: clientConn, remoteAddr: "test:0", protocol: poolproto.ProtocolStratumV1}
	sess := newSession(conn)

	// Register a pending channel directly (simulates an in-flight call).
	respCh := make(chan rpcResponse, 1)
	sess.pendingMu.Lock()
	sess.pending[777] = respCh
	sess.pendingMu.Unlock()

	if err := sess.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	select {
	case _, ok := <-respCh:
		if ok {
			t.Error("pending channel should be closed (not deliver a value) after Close")
		}
	case <-time.After(500 * time.Millisecond):
		t.Error("pending call not canceled within 500ms")
	}
}

// ============================================================================
// session.Submit — pool returns error / call itself errors
// ============================================================================

func TestSession_Submit_PoolReturnsError_ReportsReason(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	go func() {
		defer serverConn.Close()
		reader := bufio.NewReader(serverConn)
		for {
			line, err := reader.ReadBytes('\n')
			if err != nil {
				return
			}
			var req rpcMessage
			if json.Unmarshal(line, &req) != nil {
				continue
			}
			if req.Method == "mining.submit" {
				id, _ := json.Marshal(req.ID)
				resp := `{"id":` + string(id) + `,"result":null,"error":["21","Job not found",null]}` + "\n"
				_, _ = serverConn.Write([]byte(resp))
			}
		}
	}()

	conn := &connection{raw: clientConn, remoteAddr: "test:0", protocol: poolproto.ProtocolStratumV1}
	sess := newSession(conn)
	sess.start(context.Background())
	sess.authorized.Store(true) // test drives an established (post-authorize) session
	defer sess.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	res, err := sess.Submit(ctx, poolproto.ShareSubmission{JobID: "X", Nonce: 1, NTime: 1})
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if res.Accepted {
		t.Error("share should not be accepted when pool returns error result")
	}
	if res.Reason == "" {
		t.Error("Reason should be non-empty when pool returns error")
	}
}

func TestSession_PreAuthDifficultyAndExtranonce_GatedAndReplayed(t *testing.T) {
	// Pre-auth messages must not mutate negotiated session state either:
	// a hostile pool holding authorize open could otherwise set a
	// starvation difficulty or poison extranonce1 before authentication.
	sess := &session{
		jobsCh:   make(chan poolproto.Job, 8),
		diffCh:   make(chan float64, 1),
		noticeCh: make(chan string, 8),
		pending:  map[uint64]chan rpcResponse{},
	}
	sess.dispatch([]byte(`{"method":"mining.set_difficulty","params":[0.0001]}`))
	sess.dispatch([]byte(`{"method":"mining.set_extranonce","params":["aa11",2]}`))
	if got := math.Float64frombits(sess.difficulty.Load()); got != 0 {
		t.Fatalf("pre-auth set_difficulty applied difficulty %v", got)
	}
	if en1 := sess.extranonce1.Load(); en1 != nil {
		t.Fatalf("pre-auth set_extranonce applied extranonce1 %q", *en1)
	}

	// Authorization lands: the stashed messages replay in wire order.
	sess.authorized.Store(true)
	sess.flushPreAuth()
	if got := math.Float64frombits(sess.difficulty.Load()); got != 0.0001 {
		t.Fatalf("stashed set_difficulty not replayed, got %v", got)
	}
	if en1 := sess.extranonce1.Load(); en1 == nil || *en1 != "aa11" {
		t.Fatalf("stashed set_extranonce not replayed, got %v", en1)
	}
	if got := sess.extranonce2Size.Load(); got != 2 {
		t.Fatalf("stashed extranonce2_size not replayed, got %v", got)
	}
}

func TestSession_Submit_EchoesAuthorizedWorkerName(t *testing.T) {
	// ckpool-derived pools resolve the share's worker by name and reject
	// names that were never authorized — Submit must echo the username
	// mining.authorize succeeded with, not a hardcoded literal.
	gotWorker := make(chan string, 1)
	clientConn, serverConn := net.Pipe()
	go func() {
		defer serverConn.Close()
		reader := bufio.NewReader(serverConn)
		for {
			line, err := reader.ReadBytes('\n')
			if err != nil {
				return
			}
			var req rpcMessage
			if json.Unmarshal(line, &req) != nil {
				continue
			}
			if req.Method == "mining.submit" {
				var params []json.RawMessage
				_ = json.Unmarshal(req.Params, &params)
				var worker string
				if len(params) > 0 {
					_ = json.Unmarshal(params[0], &worker)
				}
				gotWorker <- worker
				id, _ := json.Marshal(req.ID)
				resp := `{"id":` + string(id) + `,"result":true,"error":null}` + "\n"
				_, _ = serverConn.Write([]byte(resp))
			}
		}
	}()

	conn := &connection{raw: clientConn, remoteAddr: "test:0", protocol: poolproto.ProtocolStratumV1}
	sess := newSession(conn)
	sess.start(context.Background())
	sess.authorized.Store(true) // test drives an established (post-authorize) session
	user := "bc1qworker.rig1"
	sess.authorizedUser.Store(&user)
	defer sess.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, err := sess.Submit(ctx, poolproto.ShareSubmission{JobID: "X", Nonce: 1, NTime: 1}); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	select {
	case w := <-gotWorker:
		if w != user {
			t.Fatalf("submit worker_name %q, want authorized user %q", w, user)
		}
	default:
		t.Fatal("pool received no mining.submit params")
	}
}

func TestSession_Submit_CallError_ReturnsError(t *testing.T) {
	// Closing the server before any submission causes Write in call to fail;
	// Submit must propagate that error rather than silently swallowing it.
	clientConn, serverConn := net.Pipe()
	serverConn.Close()

	conn := &connection{raw: clientConn, remoteAddr: "test:0", protocol: poolproto.ProtocolStratumV1}
	sess := newSession(conn)
	sess.start(context.Background())
	sess.authorized.Store(true) // test drives an established (post-authorize) session
	defer sess.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()
	_, err := sess.Submit(ctx, poolproto.ShareSubmission{JobID: "X", Nonce: 1, NTime: 1})
	if err == nil {
		t.Error("Submit should propagate the underlying call write error")
	}
}

// ============================================================================
// Dialer.Dial — error paths
// ============================================================================

func TestDialer_Dial_UnreachableHost_TimesOut(t *testing.T) {
	d := &Dialer{}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	// 198.51.100.1 is TEST-NET-2 (RFC 5737) — routable nowhere.
	_, err := d.Dial(ctx, "stratum+tcp://198.51.100.1:39999", &poolproto.Credentials{})
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
		_, err := d.Dial(context.Background(), url, &poolproto.Credentials{})
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

	// Server completes the V1 handshake (subscribe + authorize +
	// extranonce.subscribe) then disconnects to simulate a mid-session pool
	// failure. The session's read loop must close the Jobs channel — the
	// signal the engine's reconnect loop uses to re-dial.
	go func() {
		defer serverConn.Close()
		r := bufio.NewReader(serverConn)
		_, _ = r.ReadString('\n') // consume subscribe request
		fmt.Fprintf(serverConn, `{"id":1,"result":[[["mining.set_difficulty","s1"],["mining.notify","s2"]],"abc123",4],"error":null}`+"\n")
		_, _ = r.ReadString('\n') // consume authorize request
		fmt.Fprintf(serverConn, `{"id":2,"result":true,"error":null}`+"\n")
		_, _ = r.ReadString('\n') // consume extranonce.subscribe request
		fmt.Fprintf(serverConn, `{"id":3,"result":null,"error":[38,"Method not found",null]}`+"\n")
		// Close mid-session without sending any jobs.
		time.Sleep(50 * time.Millisecond)
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

	// Jobs channel should close when pool disconnects.
	select {
	case _, ok := <-sess.Jobs():
		if ok {
			t.Log("a job arrived before close — acceptable")
		}
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
		_, _ = r.ReadString('\n') // extranonce.subscribe
		fmt.Fprintf(serverConn, `{"id":3,"result":null,"error":[38,"Method not found",null]}`+"\n")
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
		_, _ = r.ReadString('\n') // extranonce.subscribe
		fmt.Fprintf(serverConn, `{"id":3,"result":null,"error":[38,"Method not found",null]}`+"\n")
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
	d := parseReconnect(json.RawMessage(`["us-east.pool.example",4444,30]`))
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
	d := parseReconnect(json.RawMessage(`["host","3333",5]`))
	if d.Port != 3333 {
		t.Errorf("Port = %d, want 3333", d.Port)
	}
}

func TestParseReconnect_EmptyAndBareParams(t *testing.T) {
	// A bare client.reconnect with no params is still a valid directive.
	for _, raw := range []string{``, `[]`, `null`, `"garbage"`} {
		d := parseReconnect(json.RawMessage(raw))
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
	sess.authorized.Store(true) // test drives an established (post-authorize) session
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
	sess.authorized.Store(true) // test drives an established (post-authorize) session
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

// ============================================================================
// parseSubscribeResult
// ============================================================================

func TestParseSubscribeResult_Valid(t *testing.T) {
	result := []any{
		[]any{
			[]any{"mining.set_difficulty", "sub1"},
			[]any{"mining.notify", "sub2"},
		},
		"deadbeef01",
		float64(4),
	}
	en1, en2Size, err := parseSubscribeResult(result)
	if err != nil {
		t.Fatalf("parseSubscribeResult: %v", err)
	}
	if en1 != "deadbeef01" {
		t.Errorf("extranonce1 = %q, want deadbeef01", en1)
	}
	if en2Size != 4 {
		t.Errorf("extranonce2Size = %d, want 4", en2Size)
	}
}

func TestParseSubscribeResult_EmptySubscriptionsArray(t *testing.T) {
	result := []any{
		[]any{},
		"abc123",
		float64(8),
	}
	en1, en2Size, err := parseSubscribeResult(result)
	if err != nil {
		t.Fatalf("parseSubscribeResult with empty subscriptions: %v", err)
	}
	if en1 != "abc123" || en2Size != 8 {
		t.Errorf("got (%q, %d), want (abc123, 8)", en1, en2Size)
	}
}

func TestParseSubscribeResult_TooShort(t *testing.T) {
	_, _, err := parseSubscribeResult([]any{"only-one"})
	if err == nil {
		t.Error("too-short result should error")
	}
}

func TestParseSubscribeResult_WrongType(t *testing.T) {
	_, _, err := parseSubscribeResult("not an array")
	if err == nil {
		t.Error("non-array result should error")
	}
}

func TestParseSubscribeResult_Extranonce1NotString(t *testing.T) {
	result := []any{[]any{}, float64(42), float64(4)}
	_, _, err := parseSubscribeResult(result)
	if err == nil {
		t.Error("non-string extranonce1 should error")
	}
}

func TestParseSubscribeResult_Extranonce2SizeNotNumber(t *testing.T) {
	result := []any{[]any{}, "abc", "not-a-number"}
	_, _, err := parseSubscribeResult(result)
	if err == nil {
		t.Error("non-number extranonce2_size should error")
	}
}

// ============================================================================
// Dialer.Negotiate — full handshake paths
// ============================================================================

// newFakeServer creates a fake pool goroutine that responds to
// subscribe (id=1) and authorize (id=2) requests, then optionally
// keeps the connection open. The server's pipe end is returned so
// callers can Close() it to simulate disconnect.
type fakeServerConfig struct {
	subscribeResult string // JSON for the subscribe result field (nil → use default)
	subscribeError  string // JSON for the error field (replaces result)
	authorizeResult string // "true" or "false"
	authorizeError  string // JSON for the error field (replaces result)
	keepAlive       bool   // hold connection open after handshake
}

func runFakeServer(t *testing.T, serverConn net.Conn, cfg fakeServerConfig) {
	t.Helper()
	go func() {
		defer serverConn.Close()
		r := bufio.NewReader(serverConn)

		// respond to subscribe
		_, err := r.ReadString('\n')
		if err != nil {
			return
		}
		if cfg.subscribeError != "" {
			fmt.Fprintf(serverConn, `{"id":1,"result":null,"error":%s}`+"\n", cfg.subscribeError)
		} else {
			sr := cfg.subscribeResult
			if sr == "" {
				sr = `[[["mining.set_difficulty","s1"],["mining.notify","s2"]],"c0ffee",4]`
			}
			fmt.Fprintf(serverConn, `{"id":1,"result":%s,"error":null}`+"\n", sr)
		}
		if cfg.subscribeError != "" {
			return // handshake terminated at subscribe
		}

		// respond to authorize
		_, err = r.ReadString('\n')
		if err != nil {
			return
		}
		if cfg.authorizeError != "" {
			fmt.Fprintf(serverConn, `{"id":2,"result":null,"error":%s}`+"\n", cfg.authorizeError)
		} else {
			ar := cfg.authorizeResult
			if ar == "" {
				ar = "true"
			}
			fmt.Fprintf(serverConn, `{"id":2,"result":%s,"error":null}`+"\n", ar)
		}
		if cfg.authorizeError != "" || cfg.authorizeResult == "false" {
			return // handshake terminated at authorize
		}

		// Step 3: extranonce.subscribe (optional). Read it and respond with
		// "Method not found" (the default for pools that predate extranonce
		// rotation). The client must proceed normally regardless of this error.
		_, err = r.ReadString('\n')
		if err != nil {
			return
		}
		fmt.Fprintf(serverConn, `{"id":3,"result":null,"error":[38,"Method not found",null]}`+"\n")

		if !cfg.keepAlive {
			return
		}
		time.Sleep(500 * time.Millisecond)
	}()
}

func TestNegotiate_Success_ExtranonceParsed(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	runFakeServer(t, serverConn, fakeServerConfig{
		subscribeResult: `[[["mining.notify","n1"]],"deadbeef01",8]`,
		keepAlive:       true,
	})

	conn := &connection{
		raw:        clientConn,
		remoteAddr: "fake:3333",
		protocol:   poolproto.ProtocolStratumV1,
		creds:      poolproto.Credentials{User: "worker.1", Password: "x"},
	}
	d := &Dialer{}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	sess, err := d.Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}
	defer sess.Close()

	sv1 := sess.(*session)
	if got := sv1.extranonce1.Load(); got == nil || *got != "deadbeef01" {
		t.Errorf("extranonce1 = %v, want deadbeef01", got)
	}
	if sv1.extranonce2Size.Load() != 8 {
		t.Errorf("extranonce2Size = %d, want 8", sv1.extranonce2Size.Load())
	}
}

func TestNegotiate_Success_EmptyPasswordDefaultsToX(t *testing.T) {
	// Verify that an empty password in Credentials is transmitted as "x".
	clientConn, serverConn := net.Pipe()
	var capturedAuthorize []byte
	go func() {
		defer serverConn.Close()
		r := bufio.NewReader(serverConn)
		_, _ = r.ReadString('\n') // subscribe
		fmt.Fprintf(serverConn, `{"id":1,"result":[[[],"deadbeef",4]],"error":null}`+"\n")
		// Oops — that subscribe result is malformed (len=1), so the test below
		// verifies that a minimal valid result still works. Let's fix it:
		// We'll just read the authorize line but not respond (simulate immediate
		// close after subscribe). Actually we need a valid subscribe response.
		// Rebuild correctly.
		line, _ := r.ReadBytes('\n')
		capturedAuthorize = append([]byte(nil), line...)
		fmt.Fprintf(serverConn, `{"id":2,"result":true,"error":null}`+"\n")
	}()

	// Start over with a proper server.
	_ = capturedAuthorize
	clientConn.Close()

	// Real test with correct server.
	clientConn2, serverConn2 := net.Pipe()
	var gotAuth string
	go func() {
		defer serverConn2.Close()
		r := bufio.NewReader(serverConn2)
		_, _ = r.ReadString('\n') // subscribe
		fmt.Fprintf(serverConn2, `{"id":1,"result":[[["mining.notify","n1"]],"aabb",4],"error":null}`+"\n")
		line, _ := r.ReadString('\n') // authorize
		gotAuth = line
		fmt.Fprintf(serverConn2, `{"id":2,"result":true,"error":null}`+"\n")
		_, _ = r.ReadString('\n') // extranonce.subscribe
		fmt.Fprintf(serverConn2, `{"id":3,"result":null,"error":[38,"Method not found",null]}`+"\n")
		time.Sleep(100 * time.Millisecond)
	}()

	conn2 := &connection{
		raw:        clientConn2,
		remoteAddr: "fake:0",
		protocol:   poolproto.ProtocolStratumV1,
		creds:      poolproto.Credentials{User: "myworker", Password: ""},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	sess2, err := (&Dialer{}).Negotiate(ctx, conn2)
	if err != nil {
		t.Fatalf("Negotiate with empty password: %v", err)
	}
	defer sess2.Close()

	// Verify the authorize request used "x" as password.
	if !strings.Contains(gotAuth, `"x"`) {
		t.Errorf("authorize params should contain 'x' as password, got: %s", gotAuth)
	}
}

func TestNegotiate_SubscribeRejected_ReturnsHandshakeFailed(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	runFakeServer(t, serverConn, fakeServerConfig{
		subscribeError: `[20,"Other/Unknown",null]`,
	})

	conn := &connection{
		raw:        clientConn,
		remoteAddr: "fake:0",
		protocol:   poolproto.ProtocolStratumV1,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, err := (&Dialer{}).Negotiate(ctx, conn)
	if err == nil {
		t.Fatal("expected error from rejected subscribe")
	}
	if !strings.Contains(err.Error(), "handshake") {
		t.Errorf("error should mention handshake, got: %v", err)
	}
}

func TestNegotiate_AuthorizeFailed_ReturnsHandshakeFailed(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	runFakeServer(t, serverConn, fakeServerConfig{
		authorizeResult: "false",
	})

	conn := &connection{
		raw:        clientConn,
		remoteAddr: "fake:0",
		protocol:   poolproto.ProtocolStratumV1,
		creds:      poolproto.Credentials{User: "bad", Password: "wrong"},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, err := (&Dialer{}).Negotiate(ctx, conn)
	if err == nil {
		t.Fatal("expected error when authorize returns false")
	}
	if !strings.Contains(err.Error(), "not authorized") {
		t.Errorf("error should mention 'not authorized', got: %v", err)
	}
}

func TestNegotiate_AuthorizeError_ReturnsHandshakeFailed(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	runFakeServer(t, serverConn, fakeServerConfig{
		authorizeError: `[24,"Unauthorized worker",null]`,
	})

	conn := &connection{
		raw:        clientConn,
		remoteAddr: "fake:0",
		protocol:   poolproto.ProtocolStratumV1,
		creds:      poolproto.Credentials{User: "u", Password: "p"},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, err := (&Dialer{}).Negotiate(ctx, conn)
	if err == nil {
		t.Fatal("expected error from authorize error response")
	}
	if !strings.Contains(err.Error(), "handshake") {
		t.Errorf("error should mention handshake, got: %v", err)
	}
}

func TestNegotiate_NonV1Connection_ReturnsError(t *testing.T) {
	// A connection that is not *connection should be rejected immediately.
	type otherConn struct{ poolproto.Connection }
	_, err := (&Dialer{}).Negotiate(context.Background(), otherConn{})
	if err == nil {
		t.Error("Negotiate with non-V1 connection should return error")
	}
}

func TestNegotiate_ExtranonceSubscribe_MethodNotFound_HandshakeSucceeds(t *testing.T) {
	// Pool responds "Method not found" to extranonce.subscribe — this is the
	// common case for pools that predate extranonce rotation. Negotiate must
	// succeed and not count the error as a share rejection.
	clientConn, serverConn := net.Pipe()
	runFakeServer(t, serverConn, fakeServerConfig{keepAlive: true})

	conn := &connection{
		raw:        clientConn,
		remoteAddr: "fake:3333",
		protocol:   poolproto.ProtocolStratumV1,
		creds:      poolproto.Credentials{User: "w", Password: "x"},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	sess, err := (&Dialer{}).Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate should succeed even when pool rejects extranonce.subscribe: %v", err)
	}
	_ = sess.Close()
}

func TestNegotiate_ExtranonceSubscribe_Accepted_HandshakeSucceeds(t *testing.T) {
	// Pool accepts extranonce.subscribe (returns true) — handshake must
	// also succeed. We already handle mining.set_extranonce in dispatch.
	clientConn, serverConn := net.Pipe()
	go func() {
		defer serverConn.Close()
		r := bufio.NewReader(serverConn)
		_, _ = r.ReadString('\n')
		fmt.Fprintf(serverConn, `{"id":1,"result":[[["mining.notify","n1"]],"ff00",4],"error":null}`+"\n")
		_, _ = r.ReadString('\n')
		fmt.Fprintf(serverConn, `{"id":2,"result":true,"error":null}`+"\n")
		_, _ = r.ReadString('\n') // extranonce.subscribe
		fmt.Fprintf(serverConn, `{"id":3,"result":true,"error":null}`+"\n")
		time.Sleep(200 * time.Millisecond)
	}()

	conn := &connection{
		raw:        clientConn,
		remoteAddr: "fake:3333",
		protocol:   poolproto.ProtocolStratumV1,
		creds:      poolproto.Credentials{User: "w", Password: "x"},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	sess, err := (&Dialer{}).Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate should succeed when pool accepts extranonce.subscribe: %v", err)
	}
	_ = sess.Close()
}

// ============================================================================
// sendJob — clean_jobs purge and normal queueing behavior
// ============================================================================

// makeTestSession returns a bare *session with a jobsCh of the given capacity.
// The conn field is nil; only jobsCh is used in sendJob.
func makeTestSession(capacity int) *session {
	return &session{jobsCh: make(chan poolproto.Job, capacity)}
}

func TestSendJob_NormalQueueingWhenChannelEmpty(t *testing.T) {
	s := makeTestSession(4)
	s.sendJob(&poolproto.Job{JobID: "j1", CleanJobs: false})
	if got := len(s.jobsCh); got != 1 {
		t.Errorf("jobsCh len = %d, want 1", got)
	}
	j := <-s.jobsCh
	if j.JobID != "j1" {
		t.Errorf("JobID = %q, want j1", j.JobID)
	}
}

func TestSendJob_DropsOldestWhenFullAndCleanJobsFalse(t *testing.T) {
	s := makeTestSession(2)
	s.sendJob(&poolproto.Job{JobID: "old1"})
	s.sendJob(&poolproto.Job{JobID: "old2"})
	// Channel is now full (cap 2). Sending with clean_jobs=false must drop old1.
	s.sendJob(&poolproto.Job{JobID: "new"})

	// Drain channel; should contain old2 and new (old1 was dropped).
	var got []string
	for len(s.jobsCh) > 0 {
		got = append(got, (<-s.jobsCh).JobID)
	}
	if len(got) != 2 {
		t.Fatalf("got %d jobs, want 2: %v", len(got), got)
	}
	if got[0] != "old2" || got[1] != "new" {
		t.Errorf("jobs = %v, want [old2 new]", got)
	}
}

func TestSendJob_PurgesAllPendingJobsWhenCleanJobs(t *testing.T) {
	s := makeTestSession(8)
	// Pre-fill with 5 stale jobs.
	for i := range 5 {
		s.sendJob(&poolproto.Job{JobID: fmt.Sprintf("stale%d", i), CleanJobs: false})
	}
	if got := len(s.jobsCh); got != 5 {
		t.Fatalf("pre-fill: jobsCh len = %d, want 5", got)
	}

	// New block: clean_jobs=true must discard all 5 stale jobs.
	s.sendJob(&poolproto.Job{JobID: "newblock", CleanJobs: true})

	if got := len(s.jobsCh); got != 1 {
		t.Fatalf("after clean_jobs: jobsCh len = %d, want 1", got)
	}
	j := <-s.jobsCh
	if j.JobID != "newblock" {
		t.Errorf("JobID = %q, want newblock", j.JobID)
	}
}

func TestSendJob_CleanJobsOnEmptyChannelJustSends(t *testing.T) {
	s := makeTestSession(4)
	s.sendJob(&poolproto.Job{JobID: "only", CleanJobs: true})
	if got := len(s.jobsCh); got != 1 {
		t.Errorf("jobsCh len = %d, want 1", got)
	}
}

// ============================================================================
// client.show_message handling
// ============================================================================

func TestParseShowMessage_Valid(t *testing.T) {
	msg, ok := parseShowMessage(json.RawMessage(`["Pool maintenance in 10 minutes"]`))
	if !ok {
		t.Fatal("parseShowMessage returned ok=false")
	}
	if msg != "Pool maintenance in 10 minutes" {
		t.Errorf("msg = %q, want 'Pool maintenance in 10 minutes'", msg)
	}
}

func TestParseShowMessage_Empty(t *testing.T) {
	_, ok := parseShowMessage(json.RawMessage(`[]`))
	if ok {
		t.Error("empty params should return ok=false")
	}
}

func TestParseShowMessage_MalformedJSON(t *testing.T) {
	_, ok := parseShowMessage(json.RawMessage(`not json`))
	if ok {
		t.Error("malformed JSON should return ok=false")
	}
}

func TestSession_Dispatch_ShowMessage_DeliveredOnNoticeChannel(t *testing.T) {
	sess := makeBareSess()
	sess.dispatch([]byte(`{"method":"client.show_message","params":["Scheduled downtime in 5 min"]}`))

	select {
	case got, ok := <-sess.noticeCh:
		if !ok {
			t.Fatal("noticeCh closed unexpectedly")
		}
		if got != "Scheduled downtime in 5 min" {
			t.Errorf("notice = %q, want 'Scheduled downtime in 5 min'", got)
		}
	default:
		t.Error("expected notice on noticeCh after client.show_message dispatch")
	}
}

func TestSession_Dispatch_ShowMessage_EmptyMessage_NotDelivered(t *testing.T) {
	// An empty message string should not be sent on the channel.
	sess := makeBareSess()
	sess.dispatch([]byte(`{"method":"client.show_message","params":[""]}`))
	if len(sess.noticeCh) != 0 {
		t.Error("empty message should not be delivered on noticeCh")
	}
}

func TestSession_Dispatch_ShowMessage_FullChannel_DropsOldest(t *testing.T) {
	sess := makeBareSess()
	// Fill the notice channel to capacity.
	for i := range cap(sess.noticeCh) {
		sess.noticeCh <- fmt.Sprintf("old-%d", i)
	}
	// One more notice: must displace the oldest rather than blocking.
	sess.dispatch([]byte(`{"method":"client.show_message","params":["newest notice"]}`))

	// Channel must still hold cap(noticeCh) messages and "newest notice" must be present.
	var found bool
	for len(sess.noticeCh) > 0 {
		if n := <-sess.noticeCh; n == "newest notice" {
			found = true
		}
	}
	if !found {
		t.Error("newest notice not found in notice channel after drop-oldest")
	}
}

func TestSession_PoolNotices_ImplementsInterface(t *testing.T) {
	sess := makeBareSess()
	// PoolNotices must satisfy poolproto.PoolNoticeReceiver.
	var _ poolproto.PoolNoticeReceiver = sess
	ch := sess.PoolNotices()
	if ch == nil {
		t.Error("PoolNotices() returned nil channel")
	}
}

func TestSession_Dispatch_UnknownNotification_SilentlyIgnored(t *testing.T) {
	// Unknown method must not produce any job, notice, or error.
	sess := makeBareSess()
	sess.dispatch([]byte(`{"method":"mining.set_version_mask","params":["1fffe000"]}`))
	if len(sess.jobsCh) != 0 {
		t.Error("unknown method enqueued a job")
	}
	if len(sess.noticeCh) != 0 {
		t.Error("unknown method enqueued a notice")
	}
}

// set_extranonce runs on the read goroutine while Submit reads
// extranonce2Size on the caller's — exercise both concurrently so the
// race detector catches a regression to plain fields.
func TestSession_SetExtranonce_ConcurrentReaders(t *testing.T) {
	sess := makeBareSess()
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < 200; j++ {
				sess.dispatch([]byte(fmt.Sprintf(
					`{"method":"mining.set_extranonce","params":["%08x",%d]}`,
					i*1000+j, j%65)))
			}
		}(i)
	}
	for i := 0; i < 2000; i++ {
		_ = sess.extranonce2Size.Load()
		if p := sess.extranonce1.Load(); p != nil {
			_ = *p
		}
	}
	wg.Wait()
}

func TestDialer_DialTimeout(t *testing.T) {
	// A dialFn that never completes must not pin Dial on the caller's
	// ctx — the per-attempt dialTimeout bounds it so failover can proceed.
	prev := dialTimeout
	dialTimeout = 50 * time.Millisecond
	defer func() { dialTimeout = prev }()

	d := &Dialer{dialFn: func(ctx context.Context, address string) (net.Conn, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}}
	start := time.Now()
	_, err := d.Dial(context.Background(), "stratum+tcp://127.0.0.1:1", &poolproto.Credentials{})
	if err == nil {
		t.Fatal("Dial should fail when the dial attempt times out")
	}
	if !strings.Contains(err.Error(), "dial timeout") {
		t.Errorf("expected dial-timeout error, got %v", err)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("Dial took %v; want <5s", elapsed)
	}
}

func TestSession_Call_CallTimeout_ReleasesPending(t *testing.T) {
	old := callTimeout
	callTimeout = 50 * time.Millisecond
	defer func() { callTimeout = old }()

	clientConn, serverConn := net.Pipe()
	defer serverConn.Close()

	conn := &connection{raw: clientConn, remoteAddr: "test:0", protocol: poolproto.ProtocolStratumV1}
	sess := newSession(conn)
	sess.start(context.Background())
	sess.authorized.Store(true) // test drives an established (post-authorize) session
	defer sess.Close()

	// Server drains the request but never responds.
	go func() {
		buf := make([]byte, 4096)
		_, _ = serverConn.Read(buf)
	}()

	start := time.Now()
	_, err := sess.call(context.Background(), 7, "mining.submit", nil)
	if err == nil {
		t.Fatal("call should return timeout error")
	}
	if !strings.Contains(err.Error(), "timed out") {
		t.Errorf("err = %v, want timeout", err)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("call blocked %v, want <5s", elapsed)
	}
	// Pending entry must be released, not leaked.
	sess.pendingMu.Lock()
	n := len(sess.pending)
	sess.pendingMu.Unlock()
	if n != 0 {
		t.Errorf("pending map has %d entries after timeout, want 0", n)
	}
}

func TestCompleteV1Job_BuildsMerkleAndRollsEN2(t *testing.T) {
	sess := makeBareSess()
	en1str := "c0ffee01"
	sess.extranonce1.Store(&en1str)
	sess.extranonce2Size.Store(4)

	notify := func(id string) poolproto.Job {
		sess.dispatch([]byte(fmt.Sprintf(
			`{"method":"mining.notify","params":[%q,`+
				`"4d16b6f85af6e2198f44ae2a6de67f78487ae5611b77c6c0440b921e00000000",`+
				`"0100000001ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",`+
				`"ffffffff01aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899ac00000000",`+
				`[],"00000002","1d00ffff","68d36c5e",true]}`, id)))
		select {
		case j := <-sess.jobsCh:
			return j
		default:
			t.Fatal("notify did not enqueue a job")
			return poolproto.Job{}
		}
	}

	j1 := notify("1")
	if j1.MerkleRoot == ([32]byte{}) {
		t.Fatal("MerkleRoot not computed — coinbase fold did not run")
	}
	if len(j1.ExtraNonce) != 4 || hex.EncodeToString(j1.ExtraNonce) != "00000001" {
		t.Fatalf("ExtraNonce = %x, want 00000001", j1.ExtraNonce)
	}

	j2 := notify("2")
	if j2.MerkleRoot == j1.MerkleRoot {
		t.Fatal("consecutive jobs share a merkle root — en2 did not roll")
	}
	if hex.EncodeToString(j2.ExtraNonce) != "00000002" {
		t.Fatalf("job 2 ExtraNonce = %x, want 00000002", j2.ExtraNonce)
	}

	// Verify the fold end-to-end: merkle == dsha(coinb1|en1|en2|coinb2)
	// with an empty branch list.
	en1, _ := hex.DecodeString(*sess.extranonce1.Load())
	coinb1, _ := hex.DecodeString("0100000001ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")
	coinb2, _ := hex.DecodeString("ffffffff01aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899ac00000000")
	want := btccrypto.Hash256(append(append(append(append([]byte{}, coinb1...), en1...), j1.ExtraNonce...), coinb2...))
	if j1.MerkleRoot != want {
		t.Fatalf("MerkleRoot = %x, want %x", j1.MerkleRoot, want)
	}
}

func TestCompleteV1Job_SkipsWithoutParts(t *testing.T) {
	sess := makeBareSess()
	// No negotiated extranonces: notify arrives "unprepared".
	sess.dispatch([]byte(`{"method":"mining.notify","params":["1","4d16b6f85af6e2198f44ae2a6de67f78487ae5611b77c6c0440b921e00000000","aa","bb",[],"00000002","1d00ffff","68d36c5e",true]}`))
	j := <-sess.jobsCh
	if j.MerkleRoot != ([32]byte{}) {
		t.Errorf("MerkleRoot = %x, want zero (no negotiated en1)", j.MerkleRoot)
	}
}

// ============================================================================
// extranonce2_size bounds — a hostile/MitM pool could request a huge
// padding size that strings.Repeat would turn into gigabytes per submit.
// ============================================================================

func TestParseSetExtranonce_SizeBounds(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want bool
	}{
		{`["ab", 0]`, false},
		{`["ab", 4]`, true},
		{`["ab", 64]`, true},
		{`["ab", 65]`, false},
		{`["ab", -1]`, false},
		{`["ab", 1073741824]`, false},
	} {
		if _, _, ok := parseSetExtranonce(json.RawMessage(tc.raw)); ok != tc.want {
			t.Errorf("parseSetExtranonce(%s) ok=%v, want %v", tc.raw, ok, tc.want)
		}
	}
}

func TestParseSubscribeResult_Extranonce2SizeBounds(t *testing.T) {
	for _, tc := range []struct {
		sz   float64
		want bool
	}{
		{0, false},
		{8, true},
		{64, true},
		{65, false},
		{-1, false},
		{1e9, false},
		// Fractional values must not pass via int() truncation.
		{64.5, false},
		{-0.5, false},
		{4.5, false},
	} {
		result := []any{[]any{}, "ab", tc.sz}
		_, _, err := parseSubscribeResult(result)
		if (err == nil) != tc.want {
			t.Errorf("parseSubscribeResult en2_size=%v err=%v, wantErr=%v", tc.sz, err, !tc.want)
		}
	}
}

func TestSanitizeNotice_StripsControlChars(t *testing.T) {
	// ANSI escape sequence + newline that would forge a log line.
	got := sanitizeNotice("maintenance\x1b[2J\x1b[H\nforged log line")
	if strings.ContainsAny(got, "\x1b\n\r\t") {
		t.Errorf("control characters survived: %q", got)
	}
	if !strings.Contains(got, "maintenance") || !strings.Contains(got, "forged log line") {
		t.Errorf("printable content lost: %q", got)
	}
}

func TestSanitizeNotice_PreservesUnicode(t *testing.T) {
	got := sanitizeNotice("メンテナンス 10分後")
	if got != "メンテナンス 10分後" {
		t.Errorf("unicode text mangled: %q", got)
	}
}

func TestSanitizeNotice_TruncatesLongNotices(t *testing.T) {
	long := strings.Repeat("x", maxNoticeRunes*2)
	got := sanitizeNotice(long)
	if len([]rune(got)) != maxNoticeRunes {
		t.Errorf("len = %d runes, want %d", len([]rune(got)), maxNoticeRunes)
	}
}

func TestSanitizeNotice_StripsC1AndDEL(t *testing.T) {
	got := sanitizeNotice("a\x7fb\u0085c\u009fd")
	if got != "abcd" {
		t.Errorf("C1/DEL not stripped: %q", got)
	}
}

func TestSanitizeNotice_StripsFormatAndSeparators(t *testing.T) {
	// Bidi overrides, line separators, tag chars — the Trojan Source
	// class, which is Cf/Zl/Zp and slips past Cc-only filters.
	got := sanitizeNotice("ok\u202Eevil\u202C\u2028forged\U000E0061x\u200By")
	if got != "okevilforgedxy" {
		t.Errorf("format/separator chars survived: %q", got)
	}
}

func TestSession_DifficultyUpdates_DeliversRetargets(t *testing.T) {
	s := newSession(&connection{})
	s.handleSetDifficulty(json.RawMessage(`[1024]`))
	select {
	case d := <-s.DifficultyUpdates():
		if d != 1024 {
			t.Errorf("delivered difficulty = %v, want 1024", d)
		}
	default:
		t.Error("set_difficulty did not reach DifficultyUpdates")
	}

	// Undelivered values coalesce: two retargets without a consumer drain
	// leave only the newest — the channel never blocks the read loop.
	s.handleSetDifficulty(json.RawMessage(`[2048]`))
	s.handleSetDifficulty(json.RawMessage(`[4096]`))
	select {
	case d := <-s.DifficultyUpdates():
		if d != 4096 {
			t.Errorf("coalesced difficulty = %v, want 4096", d)
		}
	default:
		t.Error("coalescing retarget missing")
	}
	select {
	case d := <-s.DifficultyUpdates():
		t.Errorf("unexpected extra delivery: %v", d)
	default:
	}
}
