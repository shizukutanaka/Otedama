// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package stratumv1 implements the Stratum V1 mining protocol per the
// de-facto specification used by Bitcoin pools since 2012.
//
// # Why V1 still matters in 2026
//
// Stratum V1 is a 14-year-old plaintext JSON-RPC-over-TCP protocol with
// no standardisation document, no encryption, and no authentication of
// the pool to the miner. It is also what >99% of Bitcoin mining pools
// speak in 2026, and it will remain operational well beyond Otedama's
// 10-year horizon because pool translation proxies make every SV2 pool
// also a V1 endpoint.
//
// Otedama supports V1 because the alternative — refusing to mine on
// any pool that hasn't completed its V2 migration — would shrink our
// addressable universe to two pools. We make the security tradeoffs
// explicit (see docs/THREAT_MODEL.md) and let users choose.
//
// # Protocol shape
//
// V1 is a synchronous JSON-RPC dialect with three core methods:
//
//	client → pool: mining.subscribe                  (handshake)
//	pool → client: mining.subscribe response         (extranonce1, size)
//	client → pool: mining.authorize                  (worker login)
//	pool → client: result: true | false
//	pool → client: mining.set_difficulty             (notification)
//	pool → client: mining.notify                     (job)
//	client → pool: mining.submit                     (share)
//	pool → client: result: true | false              (verdict)
//
// Plus optional mining.set_extranonce and pool→client *requests* answered
// via respond() — mining.ping (keepalive) and client.get_version (agent
// string) — plus various pool-specific extensions (NiceHash
// version-rolling, ASICBoost via mining.configure, suggest_difficulty).
// We support the common subset and ignore unknown notifications.
//
// # What this file does NOT do
//
//   - TLS: the stratum+tls:// scheme uses tls.Dial in a sibling file.
//   - DATUM: the datum:// scheme is served by this same dialer — the
//     OCEAN gateway's miner-facing wire is plain Stratum V1 (the
//     decentralised-template work happens gateway-side; see
//     KNOWN_LIMITATIONS §14 and ADR-009). No separate wire format.
//   - Job Declaration Protocol: SV2 only; not relevant to V1.
package stratumv1

import (
	"bufio"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shizukutanaka/Otedama/internal/poolproto"
	"github.com/shizukutanaka/Otedama/internal/version"
)

// ----- session -----

// maxLineBytes caps a single newline-delimited JSON-RPC line from the pool.
// Real Stratum V1 messages (mining.notify, set_difficulty, share responses)
// are well under 1 KiB; 64 KiB is generous. The cap matters because the pool
// is untrusted input: bufio.Reader.ReadBytes would otherwise accumulate an
// unbounded line (a stream with no newline) into memory until OOM. readLine
// enforces this limit via ReadSlice, which never grows past the buffer.
const maxLineBytes = 64 << 10 // 64 KiB

// session is one V1 mining channel. Stratum V1 is single-channel per
// connection, so session and connection are 1:1.
type session struct {
	conn *connection

	// reader splits the inbound stream on newlines. JSON-RPC objects
	// arrive one per line.
	reader *bufio.Reader

	// writer is mutex-protected because Submit() and the read loop
	// both write (the latter does not, but future heartbeats might).
	writeMu sync.Mutex

	// jobsCh delivers parsed Jobs to the worker.
	jobsCh chan poolproto.Job

	// nextID assigns rising numeric IDs to outgoing JSON-RPC calls.
	// SV1's id field correlates request and response.
	nextID atomic.Uint64

	// pending tracks in-flight calls awaiting a response. Keyed by id.
	pendingMu sync.Mutex
	pending   map[uint64]chan rpcResponse

	// difficulty is the most recent set_difficulty value.
	difficulty atomic.Uint64 // float64 bits

	// noticeCh delivers pool-sent client.show_message notices to the caller.
	// Buffered so the read loop never blocks on a slow consumer; closed when
	// the session ends. The caller may type-assert the Session to
	// poolproto.PoolNoticeReceiver and range over PoolNotices().
	noticeCh chan string

	// lastReconnect records the most recent pool-directed reconnect
	// (client.reconnect), nil until one is seen. Read race-free; useful
	// for diagnostics and tests.
	lastReconnect atomic.Pointer[reconnectDirective]

	// lastMsgAt is the Unix time the read loop last received ANY inbound
	// message — job, notification, request, or response. The session's
	// only engine-facing channel is jobs, so without this the link's
	// liveness is invisible to the caller whenever the pool is alive but
	// sending no work. Surfaced via poolproto.LastMessageInformer.
	lastMsgAt atomic.Int64

	// protoErrors counts inbound lines that failed to parse — malformed
	// JSON and messages whose params did not decode. The session keeps
	// no logger (the caller owns diagnostics), so these drops would
	// otherwise leave zero trace: a pool delivering corrupt jobs (drift,
	// MITM mangling) looks exactly like "the pool sends no work".
	// Surfaced via poolproto.ProtoErrorInformer.
	protoErrors atomic.Int64

	// extranonce1, extranonce2Size are negotiated at subscribe time and
	// can rotate mid-session (mining.set_extranonce). extranonce2Size is
	// read by Submit on a different goroutine than the read loop that
	// writes it — atomic to keep the race detector honest.
	extranonce1     string
	extranonce2Size atomic.Int32

	// extranonce2Ctr cycles the client-owned half of the coinbase
	// nonce (extranonce2) across submissions. V1 splits coinbase entropy
	// into pool-issued extranonce1 and a client-chosen extranonce2 of
	// extranonce2Size bytes; standard clients increment it (cgminer /
	// bfgminer / ESP-Miner) so every share is a distinct coinbase. A
	// fixed en2 means the 32-bit nonce is the entire work domain — once
	// a fast worker wraps it, it grinds byte-identical work and the
	// pool rejects the result as "duplicate". Monotonic across the
	// session (never reset): uniqueness is all the pool verifies.
	extranonce2Ctr atomic.Uint64

	// ctx controls the read-loop lifetime; cancelled on Close.
	ctxCancel context.CancelFunc
	closeOnce sync.Once
}

// Compile-time interface satisfaction checks.
var (
	_ poolproto.Session             = (*session)(nil)
	_ poolproto.PoolNoticeReceiver  = (*session)(nil)
	_ poolproto.LastMessageInformer = (*session)(nil)
	_ poolproto.ProtoErrorInformer  = (*session)(nil)
)

func newSession(conn *connection) *session {
	return &session{
		conn:     conn,
		reader:   bufio.NewReaderSize(conn.raw, maxLineBytes), // bounds readLine
		jobsCh:   make(chan poolproto.Job, 8),
		noticeCh: make(chan string, 8),
		pending:  map[uint64]chan rpcResponse{},
	}
}

// start launches the read loop. Idempotent.
func (s *session) start(ctx context.Context) {
	ctx, cancel := context.WithCancel(ctx)
	s.ctxCancel = cancel
	go s.readLoop(ctx)
}

// readLoop is the single goroutine that reads and dispatches V1 messages.
// It runs until the connection closes or the context is cancelled.
func (s *session) readLoop(ctx context.Context) {
	defer close(s.jobsCh)
	defer close(s.noticeCh)
	// When the loop exits for any reason (EOF, network error, or ctx cancel),
	// cancel all in-flight call() invocations so they return immediately
	// instead of blocking until the caller's context expires. This mirrors
	// what Close() does but without closing the network connection (which
	// is already closed or will be closed by the caller).
	defer s.cancelPending()
	for {
		// Cooperative cancellation check.
		select {
		case <-ctx.Done():
			return
		default:
		}

		// Apply a generous read deadline so a wedged pool doesn't hang
		// us forever.
		_ = s.conn.raw.SetReadDeadline(time.Now().Add(5 * time.Minute))
		line, err := s.readLine()
		if err != nil {
			// EOF, network error, or an oversized line: terminate cleanly.
			return
		}
		// Any received line proves the link is alive — including a
		// malformed one dispatch will drop — so timestamp before routing.
		s.lastMsgAt.Store(time.Now().Unix())
		s.dispatch(line)
	}
}

// readLine reads one newline-terminated line, enforcing maxLineBytes as a hard
// ceiling. ReadSlice returns bufio.ErrBufferFull (not more data) once the
// buffer fills without a delimiter, so a pool that streams bytes with no
// newline can never grow our memory — unlike ReadBytes, which would accumulate
// the whole line. The returned slice is copied out of the bufio buffer because
// ReadSlice aliases it (invalidated by the next read); the copy keeps dispatch's
// previous "owns its line" contract and matches ReadBytes's old allocation cost.
func (s *session) readLine() ([]byte, error) {
	line, err := s.reader.ReadSlice('\n')
	if errors.Is(err, bufio.ErrBufferFull) {
		return nil, fmt.Errorf("stratumv1: line exceeds %d bytes; terminating session (misbehaving pool)", maxLineBytes)
	}
	if err != nil {
		return nil, err
	}
	out := make([]byte, len(line))
	copy(out, line)
	return out, nil
}

// cancelPending closes all in-flight call() channels so those callers
// receive "session closed before response" immediately. Safe to call
// from both readLoop and Close() — the mutex ensures no double-close.
func (s *session) cancelPending() {
	s.pendingMu.Lock()
	for id, ch := range s.pending {
		close(ch)
		delete(s.pending, id)
	}
	s.pendingMu.Unlock()
}

// dispatch parses one JSON-RPC line and routes it.
func (s *session) dispatch(line []byte) {
	line = trimRight(line)
	if len(line) == 0 {
		return
	}
	var msg rpcMessage
	if err := json.Unmarshal(line, &msg); err != nil {
		// Malformed lines are ignored; misbehaving pools can't crash us,
		// but the drop is counted — silent corruption must stay visible.
		s.protoErrors.Add(1)
		return
	}
	// Response (has id, no method).
	if msg.Method == "" && msg.ID != nil {
		id := msg.uintID()
		s.pendingMu.Lock()
		ch, ok := s.pending[id]
		delete(s.pending, id)
		s.pendingMu.Unlock()
		if ok {
			ch <- rpcResponse{result: msg.Result, errResult: msg.Error}
			close(ch)
		}
		return
	}
	// Notification or request from pool.
	switch msg.Method {
	case "mining.notify":
		job, err := parseNotify(msg.Params)
		if err != nil {
			// A malformed notify is the worst silent outcome: the pool
			// is sending work and we drop all of it. Count the drop.
			s.protoErrors.Add(1)
			return
		}
		s.sendJob(job)
	case "mining.set_difficulty":
		if d, ok := parseDifficulty(msg.Params); ok {
			s.difficulty.Store(float64ToUint64(d))
		} else {
			s.protoErrors.Add(1)
		}
	case "mining.set_target":
		// NiceHash-style direct target assignment (hex U256) instead of
		// set_difficulty — stores the difficulty equivalent so the whole
		// downstream path (validation, metrics, suggested share cadence)
		// stays single-semantic.
		if d, ok := parseSetTarget(msg.Params); ok {
			s.difficulty.Store(float64ToUint64(d))
		} else {
			s.protoErrors.Add(1)
		}
	case "mining.set_extranonce":
		// Some pools rotate extranonce mid-session. Update our copy.
		if en1, sz, ok := parseSetExtranonce(msg.Params); ok {
			s.extranonce1 = en1
			s.extranonce2Size.Store(int32(sz))
		} else {
			s.protoErrors.Add(1)
		}
	case "client.show_message":
		// Pool is sending an operator notice (e.g. "maintenance in 10 min").
		// Surface it via PoolNotices(); if the caller is not draining the
		// channel, drop the oldest notice to avoid blocking the read loop.
		if notice, ok := parseShowMessage(msg.Params); !ok {
			s.protoErrors.Add(1)
		} else if notice != "" {
			select {
			case s.noticeCh <- notice:
			default:
				select {
				case <-s.noticeCh:
				default:
				}
				select {
				case s.noticeCh <- notice:
				default:
				}
			}
		}
	case "client.reconnect", "mining.reconnect":
		// The pool is asking us to move to another node (load balancing,
		// maintenance, failover). Record the directive, then end the
		// session cleanly: closing the connection makes the read loop
		// return and Jobs() close, which is exactly the signal the
		// reconnect machinery uses to re-dial the configured pool list.
		// We deliberately do NOT follow the pool-supplied Host:Port — see
		// reconnectDirective for the rationale.
		if d, ok := parseReconnect(msg.Params); ok {
			s.lastReconnect.Store(&d)
		} else {
			s.protoErrors.Add(1)
		}
		go s.Close()
	case "mining.ping":
		// Application-level keepalive used by Braiins, NiceHash and
		// ckpool-style pools: the pool sends a request carrying an id and
		// expects {"id":<id>,"result":"pong","error":null} back. Strict
		// pools disconnect clients that never answer (the connection then
		// looks half-open: TCP alive, application dead). A ping without an
		// id is a malformed notification — count and ignore it.
		if msg.ID != nil {
			s.respond(msg.ID, "pong")
		} else {
			s.protoErrors.Add(1)
		}
	case "client.get_version":
		// Pool→client request for the miner agent string (Braiins uses
		// it for compatibility tracking; cgminer/bfgminer/ESP-Miner all
		// answer). Same unanswered-request class as mining.ping — echo
		// the agent we advertised in mining.subscribe.
		if msg.ID != nil {
			s.respond(msg.ID, agentString)
		} else {
			s.protoErrors.Add(1)
		}
	default:
		// A pool→client message carrying an id is a *request* and must
		// get a reply — silently dropping it is the same half-open bug
		// class as an unanswered mining.ping: strict pools time out and
		// disconnect. Answer unimplemented methods (mining.get_transactions,
		// pool-specific extensions) with an explicit JSON-RPC
		// "Method not found" rather than silence. Notifications without
		// an id stay ignored; forward-compatible with pool extensions.
		if msg.ID != nil {
			s.respondError(msg.ID, -32601, "Method not found")
		}
	}
	// Other notifications (mining.set_version_mask, etc.) are
	// silently ignored; forward-compatible with pool extensions.
}

// respond writes a JSON-RPC result reply for a server→client request
// (mining.ping, client.get_version).
func (s *session) respond(id any, result any) {
	s.writeReply(id, result, nil)
}

// respondError writes a JSON-RPC error reply for a server→client request
// we do not implement, in the same [code, "message", data] array shape V1
// pools use (e.g. [38, "Method not found", null]).
func (s *session) respondError(id any, code int, message string) {
	s.writeReply(id, nil, []any{code, message, nil})
}

// writeReply emits one JSON-RPC response line. Best-effort: a write
// failure is swallowed because the broken connection is surfaced by the
// read loop anyway, and there is nothing actionable to do mid-parse.
func (s *session) writeReply(id any, result any, errVal any) {
	body, err := json.Marshal(map[string]any{
		"id":     id,
		"result": result,
		"error":  errVal,
	})
	if err != nil {
		return
	}
	body = append(body, '\n')

	s.writeMu.Lock()
	_ = s.conn.raw.SetWriteDeadline(time.Now().Add(10 * time.Second))
	_, _ = s.conn.raw.Write(body)
	s.writeMu.Unlock()
}

// Jobs returns the channel of incoming jobs.
func (s *session) Jobs() <-chan poolproto.Job { return s.jobsCh }

// LastReconnect returns the most recent client.reconnect directive
// the pool sent this session, or nil if none arrived. Implements
// poolproto.ReconnectInformant.
func (s *session) LastReconnect() *poolproto.ReconnectDirective {
	d := s.lastReconnect.Load()
	if d == nil {
		return nil
	}
	return &poolproto.ReconnectDirective{Host: d.Host, Port: d.Port, Wait: d.Wait}
}

// PoolNotices returns the channel of pool-sent operator notices
// (client.show_message). The channel is closed when the session ends.
// Implements poolproto.PoolNoticeReceiver.
func (s *session) PoolNotices() <-chan string { return s.noticeCh }

// LastMessageAt returns the Unix time the read loop last received any
// inbound message, or 0 before the first. Implements
// poolproto.LastMessageInformer.
func (s *session) LastMessageAt() int64 { return s.lastMsgAt.Load() }

// ProtoErrorCount returns the number of inbound messages that failed to
// parse since session start. Implements poolproto.ProtoErrorInformer.
func (s *session) ProtoErrorCount() int64 { return s.protoErrors.Load() }

// sendJob enqueues a new job, respecting the clean_jobs flag.
// When clean_jobs=true the pool signals a new block has been found;
// all pending jobs must be discarded immediately — submitting them would
// produce stale (rejected) shares, which is the #1 reject cause after
// network latency. When clean_jobs=false, only the oldest job is dropped
// if the worker cannot keep up (the new job is always more current).
func (s *session) sendJob(job poolproto.Job) {
	if job.CleanJobs {
		// Purge all pending jobs before queueing the new block's work.
		for {
			select {
			case <-s.jobsCh:
			default:
				goto send // channel empty
			}
		}
	}
send:
	select {
	case s.jobsCh <- job:
	default:
		// Channel still full (clean_jobs=false, slow worker):
		// drop oldest, push newest.
		select {
		case <-s.jobsCh:
		default:
		}
		select {
		case s.jobsCh <- job:
		default:
		}
	}
}

// Submit sends a share via mining.submit and returns the pool's verdict.
// Stratum V1 submission format: ["worker", "job_id", "extranonce2",
// "ntime", "nonce"], all hex strings.
func (s *session) Submit(ctx context.Context, sub poolproto.ShareSubmission) (poolproto.ShareResult, error) {
	if s.conn.closed.Load() {
		return poolproto.ShareResult{}, errors.New("stratumv1: session closed")
	}
	id := s.nextID.Add(1)

	en2 := ""
	if len(sub.ExtraNonce) > 0 {
		en2 = hex.EncodeToString(sub.ExtraNonce)
	} else if n := int(s.extranonce2Size.Load()); n > 0 {
		// Cycle extranonce2 so each share is a distinct coinbase — a
		// fixed en2 makes the 32-bit nonce the entire work domain and
		// produces literal duplicate shares once it wraps. The counter
		// occupies the low bytes of the negotiated en2_size field.
		en2 = hex.EncodeToString(extranonce2Bytes(s.extranonce2Ctr.Add(1), n))
	}
	// worker name must be the identity mining.authorize used — pools that
	// validate submit params[0] against the authorized worker (ckpool,
	// NiceHash) reject every share under a different name as
	// "unauthorized-worker".
	workerName := s.conn.creds.User
	if workerName == "" {
		workerName = "otedama"
	}
	params := []any{
		workerName,
		sub.JobID,
		en2,
		fmt.Sprintf("%08x", sub.NTime),
		fmt.Sprintf("%08x", sub.Nonce),
	}
	resp, err := s.call(ctx, id, "mining.submit", params)
	if err != nil {
		return poolproto.ShareResult{}, err
	}
	if resp.errResult != nil {
		return poolproto.ShareResult{
			Accepted: false,
			Reason:   fmt.Sprintf("%v", resp.errResult),
		}, nil
	}
	// Pool returned `result: true|false`. Decode.
	if accepted, ok := resp.result.(bool); ok && accepted {
		return poolproto.ShareResult{
			Accepted:   true,
			Difficulty: s.SuggestedDifficulty(),
		}, nil
	}
	return poolproto.ShareResult{Accepted: false, Reason: "rejected"}, nil
}

// extranonce2Bytes renders n as exactly size big-endian bytes: the
// counter occupies the low-order bytes (left-padded, matching the
// hex-string convention pools decode for the coinbase tail).
func extranonce2Bytes(n uint64, size int) []byte {
	buf := make([]byte, size)
	for i := size - 1; i >= 0 && n > 0; i-- {
		buf[i] = byte(n)
		n >>= 8
	}
	return buf
}

// SuggestedDifficulty returns the current target difficulty.
func (s *session) SuggestedDifficulty() float64 {
	return uint64ToFloat64(s.difficulty.Load())
}

// SuggestDifficulty sends mining.suggest_difficulty, the V1 mechanism
// for proposing a share difficulty (the counterpart to SV2's
// nominal_hash_rate in UpdateChannel — see poolproto.DifficultySuggester
// for the advisory semantics). Pools that don't implement the method —
// OCEAN answers "Method not found" — produce a JSON-RPC error result,
// which surfaces here as a non-fatal error for the caller to log.
func (s *session) SuggestDifficulty(ctx context.Context, difficulty float64) error {
	id := s.nextID.Add(1)
	resp, err := s.call(ctx, id, "mining.suggest_difficulty", []any{difficulty})
	if err != nil {
		return fmt.Errorf("stratumv1: suggest_difficulty: %w", err)
	}
	if resp.errResult != nil {
		return fmt.Errorf("stratumv1: suggest_difficulty declined: %v", resp.errResult)
	}
	return nil
}

// Close terminates the session and underlying connection. Idempotent.
func (s *session) Close() error {
	var err error
	s.closeOnce.Do(func() {
		if s.ctxCancel != nil {
			s.ctxCancel()
		}
		s.cancelPending()
		err = s.conn.Close()
	})
	return err
}

// ----- low-level RPC plumbing -----

type rpcMessage struct {
	ID     any             `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result any             `json:"result"`
	Error  any             `json:"error"`
}

func (m rpcMessage) uintID() uint64 {
	switch v := m.ID.(type) {
	case float64:
		return uint64(v)
	case int:
		return uint64(v)
	case int64:
		return uint64(v)
	case string:
		n, _ := strconv.ParseUint(v, 10, 64)
		return n
	}
	return 0
}

type rpcResponse struct {
	result    any
	errResult any
}

// agentString is the client identity sent in mining.subscribe and echoed
// to pools that ask client.get_version — keep them identical so a pool
// never sees two different agents from one session. It reports the real
// build (ldflags-injected version.Version, e.g. "v3.0.0-alpha.0-dev"
// for development builds) rather than a frozen literal — pool-side agent
// strings are how operators correlate behaviour to client builds, and a
// hardcoded "3.0.0" made every dev build indistinguishable from release.
var agentString = "Otedama/" + strings.TrimPrefix(version.Version, "v")

// call sends a JSON-RPC request and waits for the response, honoring ctx.
// Returns ErrSessionClosed if the session terminates first.
func (s *session) call(ctx context.Context, id uint64, method string, params []any) (rpcResponse, error) {
	respCh := make(chan rpcResponse, 1)
	s.pendingMu.Lock()
	s.pending[id] = respCh
	s.pendingMu.Unlock()

	req := map[string]any{
		"id":     id,
		"method": method,
		"params": params,
	}
	body, err := json.Marshal(req)
	if err != nil {
		return rpcResponse{}, err
	}
	body = append(body, '\n')

	s.writeMu.Lock()
	_ = s.conn.raw.SetWriteDeadline(time.Now().Add(10 * time.Second))
	_, err = s.conn.raw.Write(body)
	s.writeMu.Unlock()
	if err != nil {
		s.pendingMu.Lock()
		delete(s.pending, id)
		s.pendingMu.Unlock()
		return rpcResponse{}, fmt.Errorf("stratumv1: write: %w", err)
	}

	select {
	case r, ok := <-respCh:
		if !ok {
			return rpcResponse{}, errors.New("stratumv1: session closed before response")
		}
		return r, nil
	case <-ctx.Done():
		s.pendingMu.Lock()
		delete(s.pending, id)
		s.pendingMu.Unlock()
		return rpcResponse{}, ctx.Err()
	}
}

// ----- registration -----

func init() {
	poolproto.Register(&Dialer{})
	poolproto.Register(&Dialer{useTLS: true})
	// The DATUM gateway's miner-facing wire is Stratum V1 (its
	// decentralised-template work happens gateway-side — see
	// KNOWN_LIMITATIONS §14), so datum:// routes through the same
	// plaintext V1 session; only the reported ProtocolID differs.
	poolproto.Register(&Dialer{datum: true})
}

// Compile-time assertion that *Dialer satisfies poolproto.Dialer.
var _ poolproto.Dialer = (*Dialer)(nil)

// Compile-time assertion that *session satisfies poolproto.PoolNoticeReceiver.
var _ poolproto.PoolNoticeReceiver = (*session)(nil)

var _ poolproto.ReconnectInformant = (*session)(nil)

// We deliberately keep io.Reader satisfied via bufio.Reader.
var _ io.Reader = (*bufio.Reader)(nil)
