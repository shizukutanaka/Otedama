// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
//
// End-to-end tests for the part of Stratum V1 that decides whether a share
// is worth anything: the job the session hands to the miner must describe
// the same block header the pool will reconstruct from the submission.
package stratumv1

import (
	"bufio"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/poolproto"
)

// notifyFixture is one mining.notify message with the coinbase halves and
// merkle branch a real pool sends. The values are structurally realistic
// rather than lifted from a specific pool: what the tests below assert is
// the relationship between the job and the submission, which holds for any
// well-formed notify.
type notifyFixture struct {
	jobID  string
	coinb1 string
	coinb2 string
	branch []string

	// clean mirrors mining.notify's clean_jobs flag. It defaults to false
	// so that a test pushing several jobs keeps them all: a clean_jobs job
	// deliberately purges everything queued ahead of it.
	clean bool
}

func (f notifyFixture) line() string {
	branch, _ := json.Marshal(f.branch)
	return fmt.Sprintf(`{"id":null,"method":"mining.notify","params":[%q,`+
		`"4d16b6f85af6e2198f44ae2a6de67f78487ae5611b77c6c0440b921e00000000",`+
		`%q,%q,%s,"20000000","1d00ffff","68d36c5e",%t]}`+"\n",
		f.jobID, f.coinb1, f.coinb2, branch, f.clean)
}

func defaultNotify(jobID string) notifyFixture {
	return notifyFixture{
		jobID:  jobID,
		coinb1: "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff20",
		coinb2: "ffffffff0100f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a679" +
			"62e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000",
		branch: []string{
			"f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16",
			"b1fea52486ce0c62bb442b530a3f0132b826c74e473d1f2c220bfa78111c5082",
		},
	}
}

// miningPool is a fake V1 pool that completes the handshake, pushes the
// given notifications, and records the mining.submit it receives.
type miningPool struct {
	extranonce1     string
	extranonce2Size int
	notifies        []notifyFixture

	submitted chan []any // params of the mining.submit that arrived
}

func (p *miningPool) run(t *testing.T, conn net.Conn) {
	t.Helper()
	p.submitted = make(chan []any, 4)
	go func() {
		defer conn.Close()
		r := bufio.NewReader(conn)

		if _, err := r.ReadString('\n'); err != nil { // mining.subscribe
			return
		}
		fmt.Fprintf(conn, `{"id":1,"result":[[["mining.notify","s1"]],%q,%d],"error":null}`+"\n",
			p.extranonce1, p.extranonce2Size)
		if _, err := r.ReadString('\n'); err != nil { // mining.authorize
			return
		}
		fmt.Fprintf(conn, `{"id":2,"result":true,"error":null}`+"\n")
		if _, err := r.ReadString('\n'); err != nil { // extranonce.subscribe
			return
		}
		fmt.Fprintf(conn, `{"id":3,"result":null,"error":[38,"Method not found",null]}`+"\n")

		for _, n := range p.notifies {
			fmt.Fprint(conn, n.line())
		}

		// Everything after the handshake is a share submission.
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				return
			}
			var msg struct {
				ID     uint64 `json:"id"`
				Method string `json:"method"`
				Params []any  `json:"params"`
			}
			if json.Unmarshal([]byte(line), &msg) != nil || msg.Method != "mining.submit" {
				continue
			}
			p.submitted <- msg.Params
			fmt.Fprintf(conn, `{"id":%d,"result":true,"error":null}`+"\n", msg.ID)
		}
	}()
}

func (p *miningPool) negotiate(t *testing.T, user string) *session {
	t.Helper()
	clientConn, serverConn := net.Pipe()
	p.run(t, serverConn)

	conn := &connection{
		raw:        clientConn,
		remoteAddr: "fake:3333",
		protocol:   poolproto.ProtocolStratumV1,
		creds:      poolproto.Credentials{User: user, Password: "x"},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	sess, err := (&Dialer{}).Negotiate(ctx, conn)
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}
	t.Cleanup(func() { _ = sess.Close() })
	return sess.(*session)
}

func nextJob(t *testing.T, sess *session) poolproto.Job {
	t.Helper()
	select {
	case job, ok := <-sess.Jobs():
		if !ok {
			t.Fatal("Jobs channel closed before a job arrived")
		}
		return job
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for a job")
		return poolproto.Job{}
	}
}

// TestSubmit_ReconstructsTheHashedHeader is the test that would have caught
// the whole defect class: it verifies that a pool given only our submission
// rebuilds exactly the header our miner hashed.
//
// A pool validates a share by rebuilding the coinbase from its own coinb1/
// coinb2 plus the extranonce1 it assigned and the extranonce2 we submit,
// folding its merkle branch, and hashing the header. So the submitted
// extranonce2 must be the one that went into Job.MerkleRoot — and the job
// ID and worker name must be the ones the pool knows.
func TestSubmit_ReconstructsTheHashedHeader(t *testing.T) {
	fixture := defaultNotify("6a4f") // non-numeric, as real pools use
	pool := &miningPool{
		extranonce1:     "c0ffee01",
		extranonce2Size: 4,
		notifies:        []notifyFixture{fixture},
	}
	sess := pool.negotiate(t, "bc1qexampleaddress.worker1")
	job := nextJob(t, sess)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, err := sess.Submit(ctx, poolproto.ShareSubmission{
		JobID: job.JobID,
		Nonce: 0x12345678,
		NTime: job.NTime,
	}); err != nil {
		t.Fatalf("Submit: %v", err)
	}

	var params []any
	select {
	case params = <-pool.submitted:
	case <-time.After(3 * time.Second):
		t.Fatal("pool never received a mining.submit")
	}
	if len(params) != 5 {
		t.Fatalf("mining.submit had %d params, want 5: %v", len(params), params)
	}

	if got := params[0]; got != "bc1qexampleaddress.worker1" {
		t.Errorf("submit worker name = %v, want the authorised user "+
			"(a pool rejects submissions from an unknown worker)", got)
	}
	if got := params[1]; got != "6a4f" {
		t.Errorf("submit job_id = %v, want 6a4f verbatim", got)
	}
	if got := params[3]; got != fmt.Sprintf("%08x", job.NTime) {
		t.Errorf("submit ntime = %v, want %08x", got, job.NTime)
	}
	if got := params[4]; got != "12345678" {
		t.Errorf("submit nonce = %v, want 12345678", got)
	}

	// The decisive check: replay the pool's own validation.
	en2Hex, ok := params[2].(string)
	if !ok {
		t.Fatalf("submit extranonce2 is %T, want string", params[2])
	}
	en2, err := hex.DecodeString(en2Hex)
	if err != nil {
		t.Fatalf("submit extranonce2 %q is not hex: %v", en2Hex, err)
	}
	if len(en2) != pool.extranonce2Size {
		t.Errorf("submit extranonce2 is %d bytes, want the negotiated %d",
			len(en2), pool.extranonce2Size)
	}
	n, err := parseNotify(json.RawMessage(mustNotifyParams(t, fixture)))
	if err != nil {
		t.Fatalf("re-parsing the fixture: %v", err)
	}
	rebuilt := merkleRoot(buildCoinbase(n.Coinb1, mustHex(t, pool.extranonce1), en2, n.Coinb2), n.Branch)
	if rebuilt != job.MerkleRoot {
		t.Errorf("pool-side merkle root %x does not match the job we mined %x:\n"+
			"the submitted extranonce2 is not the one folded into the header",
			rebuilt, job.MerkleRoot)
	}
	if job.MerkleRoot == ([32]byte{}) {
		t.Error("job merkle root is zero — no coinbase was ever committed to")
	}
}

// mustNotifyParams extracts the params array of a fixture's notify line so a
// test can re-parse it independently of the session.
func mustNotifyParams(t *testing.T, f notifyFixture) string {
	t.Helper()
	var msg struct {
		Params json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal([]byte(f.line()), &msg); err != nil {
		t.Fatalf("fixture is not valid JSON: %v", err)
	}
	return string(msg.Params)
}

// TestJobs_RotateExtranonce2 checks that two jobs carrying identical
// coinbase halves still produce different headers. Without a fresh
// extranonce2 per job the second job would be a byte-for-byte repeat of the
// first, so every share found on it would be a duplicate of one already
// submitted.
func TestJobs_RotateExtranonce2(t *testing.T) {
	first, second := defaultNotify("job-a"), defaultNotify("job-b")
	pool := &miningPool{
		extranonce1:     "c0ffee01",
		extranonce2Size: 4,
		notifies:        []notifyFixture{first, second},
	}
	sess := pool.negotiate(t, "worker")

	a, b := nextJob(t, sess), nextJob(t, sess)
	if a.MerkleRoot == b.MerkleRoot {
		t.Error("two jobs with the same coinbase produced the same merkle root; " +
			"extranonce2 is not rotating")
	}

	en2a := sess.extraNonceForJob("job-a")
	en2b := sess.extraNonceForJob("job-b")
	if hex.EncodeToString(en2a) == hex.EncodeToString(en2b) {
		t.Errorf("both jobs recorded extranonce2 %x", en2a)
	}
}

// TestSubmit_UnknownJob_UsesNegotiatedWidth covers the eviction fallback: a
// job the session no longer remembers still submits an extranonce2 of the
// negotiated size, because a pool parses that field by length.
func TestSubmit_UnknownJob_UsesNegotiatedWidth(t *testing.T) {
	pool := &miningPool{extranonce1: "c0ffee01", extranonce2Size: 4}
	sess := pool.negotiate(t, "worker")

	if got := sess.extraNonceForJob("never-seen"); len(got) != 4 {
		t.Errorf("fallback extranonce2 is %d bytes, want 4", len(got))
	}
}

// TestNextJob_BoundsExtranonceHistory keeps a long-lived session from
// growing one map entry per job forever.
func TestNextJob_BoundsExtranonceHistory(t *testing.T) {
	sess := makeBareSess()
	sess.setExtranonce([]byte{0xc0, 0xff, 0xee}, 4)
	for i := 0; i < en2HistoryLimit*3; i++ {
		sess.nextJob(notification{JobID: fmt.Sprintf("job-%d", i)})
	}
	if len(sess.en2ByJob) > en2HistoryLimit {
		t.Errorf("remembered %d jobs, want at most %d", len(sess.en2ByJob), en2HistoryLimit)
	}
	if len(sess.en2Order) != len(sess.en2ByJob) {
		t.Errorf("eviction list (%d) and map (%d) disagree", len(sess.en2Order), len(sess.en2ByJob))
	}
	// The most recent job must survive eviction — it is the one still worth
	// submitting against.
	if _, ok := sess.en2ByJob[fmt.Sprintf("job-%d", en2HistoryLimit*3-1)]; !ok {
		t.Error("the newest job was evicted")
	}
}

// TestNegotiate_RejectsNonHexExtranonce1 : a pool whose extranonce1 is not
// hex cannot be mined for — every coinbase we build would be wrong — so the
// handshake fails loudly instead of producing shares that are all rejected.
func TestNegotiate_RejectsNonHexExtranonce1(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	runFakeServer(t, serverConn, fakeServerConfig{
		subscribeResult: `[[["mining.notify","n1"]],"nothex!!",4]`,
		keepAlive:       true,
	})
	conn := &connection{
		raw:      clientConn,
		protocol: poolproto.ProtocolStratumV1,
		creds:    poolproto.Credentials{User: "worker"},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, err := (&Dialer{}).Negotiate(ctx, conn); err == nil {
		t.Error("Negotiate accepted a non-hex extranonce1")
	}
}

// TestDispatch_SetExtranonce_IgnoresNonHex keeps a malformed mid-session
// update from replacing a working extranonce1 with garbage.
func TestDispatch_SetExtranonce_IgnoresNonHex(t *testing.T) {
	sess := makeBareSess()
	sess.setExtranonce([]byte{0xc0, 0xff, 0xee}, 4)
	sess.dispatch([]byte(`{"method":"mining.set_extranonce","params":["zzzz",8]}`))
	if got := hex.EncodeToString(sess.extranonce1); got != "c0ffee" {
		t.Errorf("extranonce1 = %s, want the previous c0ffee", got)
	}
	if sess.extranonce2Size != 4 {
		t.Errorf("extranonce2Size = %d, want the previous 4", sess.extranonce2Size)
	}
}
