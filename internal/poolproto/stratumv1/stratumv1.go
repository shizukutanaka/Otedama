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
// Plus optional mining.set_extranonce and various pool-specific
// extensions (NiceHash version-rolling, ASICBoost via mining.configure,
// suggest_difficulty). We support the common subset and ignore unknown
// notifications.
//
// # What this file does NOT do
//
//   - TLS: the stratum+tls:// scheme uses tls.Dial in a sibling file.
//   - DATUM: OCEAN's variant uses different message types and lives
//     in package datum, not here.
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

	// extranonce1, extranonce2Size are negotiated at subscribe time.
	extranonce1     string
	extranonce2Size int

	// ctx controls the read-loop lifetime; cancelled on Close.
	ctxCancel context.CancelFunc
	closeOnce sync.Once
}

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
		// Malformed lines are ignored; misbehaving pools can't crash us.
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
			return
		}
		s.sendJob(job)
	case "mining.set_difficulty":
		if d, ok := parseDifficulty(msg.Params); ok {
			s.difficulty.Store(float64ToUint64(d))
		}
	case "mining.set_extranonce":
		// Some pools rotate extranonce mid-session. Update our copy.
		if en1, sz, ok := parseSetExtranonce(msg.Params); ok {
			s.extranonce1 = en1
			s.extranonce2Size = sz
		}
	case "client.show_message":
		// Pool is sending an operator notice (e.g. "maintenance in 10 min").
		// Surface it via PoolNotices(); if the caller is not draining the
		// channel, drop the oldest notice to avoid blocking the read loop.
		if notice, ok := parseShowMessage(msg.Params); ok && notice != "" {
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
		}
		go s.Close()
		// Other notifications (mining.set_version_mask, etc.) are
		// silently ignored; forward-compatible with pool extensions.
	}
}

// Jobs returns the channel of incoming jobs.
func (s *session) Jobs() <-chan poolproto.Job { return s.jobsCh }

// PoolNotices returns the channel of pool-sent operator notices
// (client.show_message). The channel is closed when the session ends.
// Implements poolproto.PoolNoticeReceiver.
func (s *session) PoolNotices() <-chan string { return s.noticeCh }

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

	en2 := hex.EncodeToString(sub.ExtraNonce)
	if en2 == "" {
		// Pad to extranonce2_size if the worker passed empty.
		en2 = strings.Repeat("00", s.extranonce2Size)
	}
	params := []any{
		"otedama", // worker name; configurable in v3.1
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

// SuggestedDifficulty returns the current target difficulty.
func (s *session) SuggestedDifficulty() float64 {
	return uint64ToFloat64(s.difficulty.Load())
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
}

// Compile-time assertion that *Dialer satisfies poolproto.Dialer.
var _ poolproto.Dialer = (*Dialer)(nil)

// Compile-time assertion that *session satisfies poolproto.PoolNoticeReceiver.
var _ poolproto.PoolNoticeReceiver = (*session)(nil)

// We deliberately keep io.Reader satisfied via bufio.Reader.
var _ io.Reader = (*bufio.Reader)(nil)
