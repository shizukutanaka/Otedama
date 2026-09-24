// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

// Package stratumv2 implements the poolproto.Dialer and poolproto.Session
// interfaces for the Stratum V2 Mining Protocol, reusing the wire codec
// in internal/stratum.
//
// This is the piece that lets internal/engine route pool connections
// through poolproto.DialURL instead of hand-rolling the Stratum V2
// handshake inline (see docs/KNOWN_LIMITATIONS.md §3). The message
// encode/decode logic is NOT duplicated here — it lives in
// internal/stratum (wire.go, handshake.go, messages.go) and is called
// from this adapter.
package stratumv2

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shizukutanaka/Otedama/internal/miner"
	"github.com/shizukutanaka/Otedama/internal/poolproto"
	"github.com/shizukutanaka/Otedama/internal/stratum"
)

func init() {
	poolproto.Register(&Dialer{})
	poolproto.Register(&Dialer{useTLS: true})
}

// Dialer establishes Stratum V2 connections. Two instances are
// registered: plaintext (stratum+v2://) and TLS (stratum+v2tls://).
type Dialer struct {
	useTLS bool

	// dialFn is overridable in tests; nil uses a real TCP dial.
	dialFn func(ctx context.Context, address string) (net.Conn, error)
}

// Protocol returns the protocol this dialer handles.
func (d *Dialer) Protocol() poolproto.ProtocolID {
	if d.useTLS {
		return poolproto.ProtocolStratumV2TLS
	}
	return poolproto.ProtocolStratumV2
}

// Dial opens a TCP (or, when configured, TLS) connection to the pool.
func (d *Dialer) Dial(ctx context.Context, url string, creds poolproto.Credentials) (poolproto.Connection, error) {
	address, err := poolproto.StripScheme(url)
	if err != nil {
		return nil, fmt.Errorf("stratumv2: %w", err)
	}
	dialFn := d.dialFn
	if dialFn == nil {
		if d.useTLS {
			// Build the verifier up front so a malformed per-pool CA bundle
			// fails here rather than mid-handshake. An empty bundle means
			// system roots only — never a plaintext fallback (this replaces
			// the engine-side v2tls:// TLS dial that KNOWN_LIMITATIONS §2
			// documented).
			cfg, err := stratum.TLSConfigWithExtraCAs(creds.TLSRootCAsPEM)
			if err != nil {
				return nil, fmt.Errorf("stratumv2: %w", err)
			}
			dialFn = func(ctx context.Context, address string) (net.Conn, error) {
				c, err := stratum.DialTLS(ctx, address, cfg)
				if err != nil {
					// Name TLS in the error so callers can tell a real
					// handshake failure from a silent plaintext fallback.
					return nil, fmt.Errorf("TLS handshake: %w", err)
				}
				return c, nil
			}
		} else {
			dialFn = func(ctx context.Context, address string) (net.Conn, error) {
				var dialer net.Dialer
				conn, err := dialer.DialContext(ctx, "tcp", address)
				if err != nil {
					return nil, err
				}
				// Nagle off: submits are latency-sensitive request/response
				// traffic — batching can hold a share tens of ms behind a
				// delayed ACK (ESP-Miner #1722).
				if tc, ok := conn.(*net.TCPConn); ok {
					_ = tc.SetNoDelay(true)
				}
				return conn, nil
			}
		}
	}
	raw, err := dialFn(ctx, address)
	if err != nil {
		return nil, fmt.Errorf("stratumv2: dial %s: %w", address, err)
	}
	return &connection{
		raw:        raw,
		remoteAddr: address,
		protocol:   d.Protocol(),
		user:       creds.User,
	}, nil
}

// Negotiate performs the Stratum V2 handshake (SetupConnection +
// OpenMiningChannel) and returns a Session that streams jobs.
func (d *Dialer) Negotiate(ctx context.Context, c poolproto.Connection) (poolproto.Session, error) {
	conn, ok := c.(*connection)
	if !ok {
		return nil, fmt.Errorf("stratumv2: Negotiate received non-V2 connection: %T", c)
	}

	dec := stratum.NewDecoder(conn.raw)

	// SetupConnection.
	sc := stratum.SetupConnection{
		Protocol:        stratum.MiningProtocol,
		MinVersion:      2,
		MaxVersion:      2,
		Endpoint:        conn.remoteAddr,
		Vendor:          "Otedama",
		HardwareVersion: "v3.0.0",
		Firmware:        "main",
		DeviceID:        "cpu",
	}
	if err := sendMsg(conn.raw, stratum.MsgSetupConnection, false, &sc); err != nil {
		return nil, fmt.Errorf("stratumv2: send SetupConnection: %w", err)
	}
	f, err := dec.ReadFrame()
	if err != nil {
		return nil, fmt.Errorf("stratumv2: read SetupConnection response: %w", err)
	}
	msg, err := stratum.DispatchFrame(f)
	if err != nil {
		return nil, err
	}
	if msg.SetupConnectionError != nil {
		return nil, fmt.Errorf("%w: %s", poolproto.ErrHandshakeFailed, msg.SetupConnectionError.Error)
	}
	if msg.SetupConnectionSuccess == nil {
		return nil, fmt.Errorf("stratumv2: unexpected msg 0x%02X during setup", f.Header.MsgType)
	}

	// OpenMiningChannel.
	omc := stratum.OpenMiningChannel{
		ReqID:           1,
		User:            conn.user,
		NominalHashrate: 0, // engine updates real hashrate later
	}
	if err := sendMsg(conn.raw, stratum.MsgOpenMiningChannel, false, &omc); err != nil {
		return nil, fmt.Errorf("stratumv2: send OpenMiningChannel: %w", err)
	}
	f, err = dec.ReadFrame()
	if err != nil {
		return nil, fmt.Errorf("stratumv2: read OpenMiningChannel response: %w", err)
	}
	msg, err = stratum.DispatchFrame(f)
	if err != nil {
		return nil, err
	}
	if msg.OpenMiningChannelError != nil {
		return nil, fmt.Errorf("%w: %s", poolproto.ErrHandshakeFailed, msg.OpenMiningChannelError.Error)
	}
	if msg.OpenMiningChannelSuccess == nil {
		return nil, fmt.Errorf("stratumv2: unexpected msg 0x%02X during channel open", f.Header.MsgType)
	}

	sess := &session{
		conn:   conn,
		dec:    dec,
		chanID: msg.OpenMiningChannelSuccess.ChannelID,
		jobsCh: make(chan poolproto.Job, 8),
		done:   make(chan struct{}),
	}
	// The channel's initial share target arrives in the success response;
	// a zero target means the pool assigned none — recorded as
	// unassigned so the engine falls back without warning.
	omcs := msg.OpenMiningChannelSuccess
	if omcs.Target != ([32]byte{}) {
		sess.shareTarget = omcs.Target
		sess.targetAssigned = true
		sess.diff.Store(math.Float64bits(
			miner.DifficultyFromTarget(miner.Hash(omcs.Target))))
	}
	sess.start(ctx)
	return sess, nil
}

// ----- connection -----

type connection struct {
	raw        net.Conn
	remoteAddr string
	protocol   poolproto.ProtocolID
	user       string

	closeOnce sync.Once
	closed    atomic.Bool
}

func (c *connection) RemoteAddr() string             { return c.remoteAddr }
func (c *connection) Protocol() poolproto.ProtocolID { return c.protocol }

func (c *connection) Close() error {
	var err error
	c.closeOnce.Do(func() {
		c.closed.Store(true)
		err = c.raw.Close()
	})
	return err
}

// ----- session -----

type session struct {
	conn   *connection
	dec    *stratum.Decoder
	chanID uint32
	jobsCh chan poolproto.Job

	diff atomic.Uint64 // suggested difficulty as math.Float64bits

	// targetMu guards shareTarget/targetAssigned, read by emit (same
	// goroutine as the writers) and by Submit callers via ShareTarget.
	targetMu       sync.RWMutex
	shareTarget    [32]byte // current pool-assigned share target (LE U256)
	targetAssigned bool     // pool explicitly sent a target (incl. zero)

	seq      atomic.Uint32 // submit sequence numbers (1-based)
	verdicts sync.Map      // seq uint32 → chan poolproto.ShareResult (cap 1)

	done      chan struct{} // closed when readLoop exits
	startOnce sync.Once

	// writeMu serializes frame writes (Submit runs on the caller's
	// goroutine, potentially several at once) and pairs with the write
	// deadline: a pool that keeps sending jobs but stops reading could
	// otherwise wedge Submit in a full socket send buffer forever —
	// reads keep succeeding, so the read deadline and job watchdog
	// never notice. Same 10s bound as the V1 session's write path.
	writeMu sync.Mutex
}

// start launches the read loop that decodes NewMiningJob frames and
// forwards them onto jobsCh. The loop exits on read error, ctx
// cancellation, or connection close, closing jobsCh on the way out.
//
// A ctx cancel must unblock the loop even while it sits inside
// ReadFrame — a net.Conn read is not ctx-aware — so a watcher closes
// the connection, which surfaces a read error on any goroutine
// currently blocked on the socket.
func (s *session) start(ctx context.Context) {
	s.startOnce.Do(func() {
		go func() {
			select {
			case <-ctx.Done():
				_ = s.conn.Close()
			case <-s.done: // readLoop exited; do not outlive the session
			}
		}()
		go s.readLoop(ctx)
	})
}

func (s *session) readLoop(ctx context.Context) {
	defer close(s.jobsCh)
	defer close(s.done)
	// SV2 job/tip state, mirroring the engine's old inline loop: a job is
	// emittable only once both NewMiningJob (merkle root + version) and
	// SetNewPrevHash (prev-hash + nBits + ntime) are known. Future jobs
	// (no min_ntime) wait for the SetNewPrevHash that names them.
	state := &jobState{pending: make(map[uint32]*stratum.NewMiningJob)}

	for {
		if ctx.Err() != nil || s.conn.closed.Load() {
			return
		}
		// Same generous read deadline as the V1 loop: a wedged pool that
		// keeps the TCP connection open but stops sending frames would
		// otherwise leave this session a zombie forever — the read error
		// surfaces as a normal disconnect and the engine reconnects.
		_ = s.conn.raw.SetReadDeadline(time.Now().Add(5 * time.Minute))
		f, err := s.dec.ReadFrame()
		if err != nil {
			return
		}
		msg, err := stratum.DispatchFrame(f)
		if err != nil {
			continue // skip undecodable frame, keep reading
		}
		if !s.handleMessage(ctx, state, &msg) {
			return
		}
	}
}

// handleMessage dispatches one decoded frame. Channel messages are
// filtered on channel_id: this session owns exactly one channel on the
// connection, so a frame addressed to any other id can only come from a
// confused or hostile pool — accepting it would let a foreign SetTarget
// hijack our share difficulty or foreign jobs/verdicts corrupt our
// state. Returns false when the session should end.
func (s *session) handleMessage(ctx context.Context, state *jobState, msg *stratum.Message) bool {
	switch {
	case msg.NewMiningJob != nil:
		if msg.NewMiningJob.ChannelID == s.chanID {
			return s.onNewMiningJob(ctx, state, msg.NewMiningJob)
		}
	case msg.SetNewPrevHash != nil:
		if msg.SetNewPrevHash.ChannelID == s.chanID {
			return s.onSetNewPrevHash(ctx, state, msg.SetNewPrevHash)
		}
	case msg.SetTarget != nil:
		if msg.SetTarget.ChannelID == s.chanID {
			s.onSetTarget(msg.SetTarget)
		}
	case msg.CloseChannel != nil:
		// The pool closed the channel: pending jobs are dead and
		// further submits reject. This session only ever holds one
		// channel, so a close addressed to it ends the session —
		// exit the loop and let the engine reconnect on a fresh
		// channel rather than sitting as a zombie until the read
		// deadline or job watchdog notices.
		if msg.CloseChannel.ChannelID == s.chanID {
			return false
		}
	case msg.SubmitSharesSuccess != nil:
		if msg.SubmitSharesSuccess.ChannelID == s.chanID {
			s.settleVerdicts(msg.SubmitSharesSuccess.LastSequenceNumber, true,
				poolproto.ShareResult{Accepted: true})
		}
	case msg.SubmitSharesError != nil:
		if e := msg.SubmitSharesError; e.ChannelID == s.chanID {
			s.settleVerdicts(e.SequenceNumber, false,
				poolproto.ShareResult{Accepted: false, Reason: e.Error})
		}
	}
	return true
}

// jobState accumulates the two-piece SV2 job announcement
// (NewMiningJob + SetNewPrevHash) into a complete emittable job.
type jobState struct {
	pending   map[uint32]*stratum.NewMiningJob
	order     []uint32 // insertion order of pending keys, for oldest-first eviction
	prevHash  [32]byte
	prevNBits uint32
	havePrev  bool
}

// maxPendingJobs bounds jobState.pending. Only the job the next
// SetNewPrevHash names ever becomes minable — every other entry is
// discarded unread — so a large map only ever holds work that cannot be
// used. Between tips a hostile or buggy upstream can stream NewMiningJob
// frames indefinitely; the cap turns that into bounded memory instead of
// unbounded growth. Real pools keep at most a handful of future jobs
// open, so 256 is generous headroom.
const maxPendingJobs = 256

// insertJob records j in the bounded pending set, evicting the oldest
// unseen job when the cap is reached (the newest arrivals are the most
// likely to be named by the next SetNewPrevHash).
func (state *jobState) insertJob(j *stratum.NewMiningJob) {
	if _, exists := state.pending[j.JobID]; exists {
		state.pending[j.JobID] = j
		return
	}
	if len(state.pending) >= maxPendingJobs {
		oldest := state.order[0]
		state.order = state.order[1:]
		delete(state.pending, oldest)
	}
	state.pending[j.JobID] = j
	state.order = append(state.order, j.JobID)
}

// emit enqueues a job without blocking the frame read loop. A slow
// consumer must never stall the loop: while blocked it would miss
// further NewMiningJob/SetNewPrevHash frames (making everything it
// later dequeues stale anyway) — the slow-client pile-up ESP-Miner
// fixed in #1913. Same policy as the V1 session's sendJob: when the
// new job makes pending work obsolete (clean=true, a new tip), purge
// all queued jobs first; when the channel is full, drop the oldest —
// the newest job is always the most current work. Return false only
// on shutdown so the loop exits.
func (s *session) emit(ctx context.Context, state *jobState, j *stratum.NewMiningJob, ntime uint32, clean bool) bool {
	s.targetMu.RLock()
	target, assigned := s.shareTarget, s.targetAssigned
	s.targetMu.RUnlock()
	job := poolproto.Job{
		JobID:          fmt.Sprintf("%d", j.JobID),
		Version:        j.Version,
		PrevHash:       state.prevHash,
		MerkleRoot:     j.MerkleRoot,
		NTime:          ntime,
		NBits:          state.prevNBits,
		CleanJobs:      clean,
		ChannelID:      s.chanID,
		ShareTarget:    target,
		TargetAssigned: assigned,
		ReceivedAt:     time.Now(),
	}
	if ctx.Err() != nil {
		return false
	}
	if clean {
		for {
			select {
			case <-s.jobsCh:
			default:
				goto purgeDone
			}
		}
	}
purgeDone:
	select {
	case s.jobsCh <- job:
	default:
		select {
		case <-s.jobsCh:
		default:
		}
		select {
		case s.jobsCh <- job:
		default:
		}
	}
	return true
}

// onNewMiningJob holds the job until the tip's prev-hash is known.
// Returns false when emit rejected a send (session closing).
func (s *session) onNewMiningJob(ctx context.Context, state *jobState, j *stratum.NewMiningJob) bool {
	state.insertJob(j)
	if j.HasMinNtime && state.havePrev {
		return s.emit(ctx, state, j, j.MinNtime, false)
	}
	// Future job (or no tip yet): held until SetNewPrevHash.
	return true
}

// onSetNewPrevHash installs the new tip and emits the job it names.
// Returns false when emit rejected a send (session closing).
func (s *session) onSetNewPrevHash(ctx context.Context, state *jobState, p *stratum.SetNewPrevHash) bool {
	state.prevHash = p.PrevHash
	state.prevNBits = p.NBits
	state.havePrev = true
	named := state.pending[p.JobID]
	state.pending = map[uint32]*stratum.NewMiningJob{}
	state.order = state.order[:0]
	if named == nil {
		return true
	}
	state.pending[p.JobID] = named
	state.order = append(state.order, p.JobID)
	ntime := p.MinNtime
	if named.HasMinNtime && named.MinNtime > ntime {
		ntime = named.MinNtime
	}
	return s.emit(ctx, state, named, ntime, true)
}

// onSetTarget applies a live pool target change: the raw U256 becomes
// the share target for subsequent jobs, and SuggestedDifficulty is
// re-derived for the metrics paths that still speak float64.
func (s *session) onSetTarget(st *stratum.SetTarget) {
	s.targetMu.Lock()
	s.shareTarget = st.MaxTarget
	s.targetAssigned = true
	s.targetMu.Unlock()
	s.diff.Store(math.Float64bits(
		miner.DifficultyFromTarget(miner.Hash(st.MaxTarget))))
}

// settleVerdicts delivers share verdicts to the Submit callers waiting on
// them. SubmitSharesSuccess is cumulative: it settles every outstanding
// sequence number ≤ LastSequenceNumber. SubmitSharesError settles exactly
// the one sequence it names. Unknown or already-settled sequence numbers
// (a late verdict after a Submit's ctx expired) are dropped silently —
// correctness is preserved because each submit owns a distinct seq key,
// never a positional queue.
func (s *session) settleVerdicts(lastSeq uint32, cumulative bool, res poolproto.ShareResult) {
	s.verdicts.Range(func(k, v any) bool {
		seq, ok1 := k.(uint32)
		ch, ok2 := v.(chan poolproto.ShareResult)
		if !ok1 || !ok2 {
			return true
		}
		if (cumulative && seq <= lastSeq) || (!cumulative && seq == lastSeq) {
			ch <- res // buffered cap 1: never blocks
			s.verdicts.Delete(seq)
		}
		return true
	})
}

// Jobs returns the channel of incoming jobs.
func (s *session) Jobs() <-chan poolproto.Job { return s.jobsCh }

// Submit sends a share upstream and waits for the pool's verdict.
// Each submit owns a distinct sequence number; the read loop's
// settleVerdicts correlates SubmitSharesSuccess (a cumulative ACK up
// to that sequence) and SubmitSharesError back to the waiting caller.
func (s *session) Submit(ctx context.Context, sub poolproto.ShareSubmission) (poolproto.ShareResult, error) {
	jobID := parseJobID(sub.JobID)
	seq := s.seq.Add(1)
	verdictCh := make(chan poolproto.ShareResult, 1)
	s.verdicts.Store(seq, verdictCh)
	defer s.verdicts.Delete(seq)
	ss := stratum.SubmitSharesStandard{
		ChannelID:      s.chanID,
		SequenceNumber: seq,
		JobID:          jobID,
		Nonce:          sub.Nonce,
		NTime:          sub.NTime,
		NVersion:       sub.Version,
	}
	// SubmitSharesStandard is a channel message: the channel_msg bit must
	// be set in the frame header (the engine's inline path already does
	// this; the two paths previously disagreed).
	if err := s.sendMsg(stratum.MsgSubmitSharesStandard, true, &ss); err != nil {
		return poolproto.ShareResult{}, fmt.Errorf("stratumv2: submit share: %w", err)
	}
	// Wait for the pool's verdict so the caller's accept/reject accounting
	// sees the real outcome — the previous return-immediately behavior
	// dropped every verdict. Expiry means "submitted but unconfirmed"
	// (the share may still be judged upstream; the shares_pending gauge
	// captures the gap). Session teardown unblocks a waiting Submit the
	// same way ctx cancellation does.
	select {
	case res := <-verdictCh:
		return res, nil
	case <-ctx.Done():
		return poolproto.ShareResult{}, ctx.Err()
	case <-s.done:
		return poolproto.ShareResult{}, errors.New("stratumv2: session closed before verdict")
	}
}

// SuggestedDifficulty returns the current target difficulty.
func (s *session) SuggestedDifficulty() float64 {
	return float64FromBits(s.diff.Load())
}

// ShareTarget returns the raw pool-assigned share target (LE U256), or
// all-zero when none has been assigned. Callers needing the exact target
// (the engine's benign-transition check) read this rather than re-deriving
// it from the float64 difficulty, which cannot represent all 256 bits.
func (s *session) ShareTarget() [32]byte {
	s.targetMu.RLock()
	defer s.targetMu.RUnlock()
	return s.shareTarget
}

// Close terminates the session's underlying connection.
func (s *session) Close() error { return s.conn.Close() }

// ----- helpers -----

// Compile-time interface satisfaction checks.
var (
	_ poolproto.Dialer     = (*Dialer)(nil)
	_ poolproto.Connection = (*connection)(nil)
	_ poolproto.Session    = (*session)(nil)
)

// encodable is satisfied by every Stratum V2 message type (they all
// have an Encode method). Defined locally to avoid coupling the
// poolproto adapter to an exported interface in internal/stratum.
type encodable interface {
	Encode() ([]byte, error)
}

// sendMsg serializes a frame write on the session socket: the write
// mutex keeps concurrent Submits' frames apart, and the write deadline
// bounds how long a blocked send can hold a caller (V1 write-path
// parity).
func (s *session) sendMsg(msgType uint8, isChannel bool, enc encodable) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_ = s.conn.raw.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return sendMsg(s.conn.raw, msgType, isChannel, enc)
}

// sendMsg encodes, frames, and writes a Stratum V2 message. isChannel
// sets the frame header's channel_msg bit — required for channel-scoped
// messages (SubmitSharesStandard etc.), absent for connection-scoped
// ones (SetupConnection, OpenMiningChannel).
func sendMsg(w net.Conn, msgType uint8, isChannel bool, enc encodable) error {
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
	if _, err := w.Write(data); err != nil {
		return err
	}
	return nil
}

func parseJobID(s string) uint32 {
	var id uint32
	_, _ = fmt.Sscanf(s, "%d", &id)
	return id
}

// float64FromBits is the inverse of math.Float64bits, used to read the
// difficulty stored in the session's atomic.Uint64.
func float64FromBits(bits uint64) float64 {
	return math.Float64frombits(bits)
}

// Compile-time assertions.
var (
	_ poolproto.Dialer     = (*Dialer)(nil)
	_ poolproto.Connection = (*connection)(nil)
	_ poolproto.Session    = (*session)(nil)
)
