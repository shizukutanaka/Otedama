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
	"crypto/tls"
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

// dialTCP is the default transport for stratum+v2:// pools.
// poolproto.DialConnectTimeout bounds the connect phase so a blackholed
// pool fails over in seconds rather than the OS TCP timeout (minutes).
func dialTCP(ctx context.Context, address string) (net.Conn, error) {
	dialer := net.Dialer{Timeout: poolproto.DialConnectTimeout}
	return dialer.DialContext(ctx, "tcp", address)
}

// Dial opens a TCP (or, when the scheme is stratum+v2tls://, a
// certificate-verified TLS) connection to the pool. A configured
// CA bundle (creds.TLSRootCAsPEM) extends the root store so a
// private-CA/self-signed pool verifies; TLS never falls back to
// plaintext.
func (d *Dialer) Dial(ctx context.Context, url string, creds poolproto.Credentials) (poolproto.Connection, error) {
	address, err := poolproto.StripScheme(url)
	if err != nil {
		return nil, fmt.Errorf("stratumv2: %w", err)
	}
	var raw net.Conn
	switch {
	case d.dialFn != nil:
		// Test hook: bypass both transports.
		raw, err = d.dialFn(ctx, address)
	case d.useTLS:
		var cfg *tls.Config
		cfg, err = stratum.TLSConfigWithExtraCAs(creds.TLSRootCAsPEM)
		if err == nil {
			raw, err = stratum.DialTLS(ctx, address, cfg)
		}
		if err != nil {
			return nil, fmt.Errorf("stratumv2: TLS dial %s: %w", address, err)
		}
	default:
		raw, err = dialTCP(ctx, address)
	}
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
		Protocol:   stratum.MiningProtocol,
		MinVersion: 2,
		MaxVersion: 2,
		Endpoint:   conn.remoteAddr,
		// sv2-spec §5.3.1: an end mining device that opens only Standard
		// Channels (Otedama never handles extended/group jobs) must
		// declare REQUIRES_STANDARD_JOBS so the pool does not treat this
		// connection as a proxy-capable downstream.
		Flags:           stratum.SetupFlagRequiresStandardJobs,
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
	if msg.SetupConnectionSuccess.Flags&stratum.SetupFlagRequiresExtendedChannels != 0 {
		// The upstream requires extended/group channels, which a
		// standard-channel-only end device cannot serve (see the
		// SetupFlagRequiresStandardJobs declaration). Failing the
		// handshake beats proceeding into jobs we cannot process.
		return nil, fmt.Errorf("%w: pool requires extended channels (SetupConnectionSuccess.flags=%#x)",
			poolproto.ErrHandshakeFailed, msg.SetupConnectionSuccess.Flags)
	}

	// OpenMiningChannel.
	omc := stratum.OpenMiningChannel{
		ReqID:           1,
		User:            conn.user,
		NominalHashrate: 0, // engine updates real hashrate later
		MaxTarget:       stratum.MaxTargetUnbounded,
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
		conn:    conn,
		dec:     dec,
		chanID:  msg.OpenMiningChannelSuccess.ChannelID,
		jobsCh:  make(chan poolproto.Job, 8),
		pending: make(map[uint32]chan poolproto.ShareResult),
	}
	// Seed the suggested difficulty and share target from the channel's
	// initial target when the pool assigned one; subsequent SetTarget
	// frames update both. A zero target means "unset" (SRI v1.5.0
	// lesson: it is unusable), so leave the documented zero defaults.
	var zeroTarget [32]byte
	if msg.OpenMiningChannelSuccess.Target != zeroTarget {
		sess.shareTarget = msg.OpenMiningChannelSuccess.Target
		sess.diff.Store(math.Float64bits(
			miner.DifficultyFromTarget(miner.Hash(msg.OpenMiningChannelSuccess.Target))))
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

	// shareTarget is the current pool-assigned U256 share target carried
	// onto every emitted Job. Written and read only by the read loop.
	shareTarget [32]byte

	// seq issues the SV2 sequence_number each submit carries so the
	// pool's SubmitSharesSuccess/Error frames can be correlated back to
	// their request. pending holds a buffered result chan per in-flight
	// sequence number; the read loop resolves them as verdicts arrive
	// (request/response correlation, replacing the previous fire-and-
	// forget submit that hardcoded sequence_number=0).
	seq       atomic.Uint32
	pending   map[uint32]chan poolproto.ShareResult
	pendingMu sync.Mutex

	// lastReconnect records the most recent pool-directed Reconnect
	// (msg_type 0x04, §3.6.5), nil until one is seen. Read race-free;
	// useful for diagnostics and tests.
	lastReconnect atomic.Pointer[stratum.Reconnect]

	// lastChannelClose records the pool-directed CloseChannel (msg_type
	// 0x18, §5.3.9) that ended the session, nil until one is seen.
	lastChannelClose atomic.Pointer[stratum.CloseChannel]

	startOnce sync.Once
}

// start launches the read loop that decodes NewMiningJob frames and
// forwards them onto jobsCh. The loop exits on read error, ctx
// cancellation, or connection close, closing jobsCh on the way out.
func (s *session) start(ctx context.Context) {
	s.startOnce.Do(func() {
		go s.readLoop(ctx)
	})
}

func (s *session) readLoop(ctx context.Context) {
	defer close(s.jobsCh)
	// Unblock every in-flight submit so callers aren't left waiting
	// for a verdict that will never arrive.
	defer s.drainPending()
	tip := newTipState()

	emit := func(j *stratum.NewMiningJob, ntime uint32, clean bool) bool {
		job := poolproto.Job{
			JobID:      fmt.Sprintf("%d", j.JobID),
			Version:    j.Version,
			PrevHash:   tip.prevHash,
			MerkleRoot: j.MerkleRoot,
			NTime:      ntime,
			NBits:      tip.prevNBits,
			CleanJobs:  clean,
			Target:     s.shareTarget,
			ReceivedAt: time.Now(),
		}
		select {
		case s.jobsCh <- job:
			return true
		case <-ctx.Done():
			return false
		}
	}

	for {
		if ctx.Err() != nil || s.conn.closed.Load() {
			return
		}
		f, err := s.dec.ReadFrame()
		if err != nil {
			return
		}
		msg, err := stratum.DispatchFrame(f)
		if err != nil {
			continue // skip undecodable frame, keep reading
		}
		if j, ntime, clean := tip.feed(&msg); j != nil {
			if !emit(j, ntime, clean) {
				return
			}
		}
		if msg.SetTarget != nil {
			s.applySetTarget(msg.SetTarget.MaxTarget)
			// Re-issue the active job so consumers apply the new share
			// target immediately, matching the engine's inline loop
			// (updateWork with the live job + new target) rather than
			// waiting for the next NewMiningJob.
			if tip.active != nil {
				if !emit(tip.active, tip.activeNTime, false) {
					return
				}
			}
		}
		if msg.SubmitSharesSuccess != nil {
			s.resolveSubmits(msg.SubmitSharesSuccess)
		}
		if msg.SubmitSharesError != nil {
			s.rejectSubmit(msg.SubmitSharesError)
		}
		// A pool-directed Reconnect or CloseChannel ends the
		// session — see noteReconnect / noteChannelClosed. Closing
		// the conn makes the top-of-loop closed check exit, so no
		// explicit branch is needed here.
		s.noteReconnect(&msg)
		s.noteChannelClosed(&msg)
	}
}

// noteChannelClosed records a pool-directed CloseChannel (§5.3.9) and
// ends the session: the sender MUST stop sending on the channel, so the
// session can no longer mine — closing the connection lets the read
// loop's closed check / next ReadFrame exit and Jobs() close, the signal
// the engine's reconnect machinery uses to re-dial the configured pool
// list. The recorded ReasonCode keeps the pool's stated cause for
// diagnostics.
func (s *session) noteChannelClosed(m *stratum.Message) {
	if m.CloseChannel == nil {
		return
	}
	s.lastChannelClose.Store(m.CloseChannel)
	s.conn.Close()
}

// noteReconnect records a pool-directed Reconnect (sv2-spec §3.6.5) and
// ends the session: closing the connection makes the read loop's next
// closed check / ReadFrame fail and Jobs() close — the signal the
// engine's reconnect machinery uses to re-dial the configured pool
// list. The pool is asking us to move to another node (load balancing,
// maintenance, failover); we deliberately do NOT follow the
// pool-supplied NewHost:NewPort: an unauthenticated redirect would hand
// the hash rate to an arbitrary endpoint (the same posture as V1
// client.reconnect).
func (s *session) noteReconnect(m *stratum.Message) {
	if m.Reconnect == nil {
		return
	}
	s.lastReconnect.Store(m.Reconnect)
	s.conn.Close()
}

// tipState tracks SV2 job/tip state for the read loop, mirroring the
// engine's inline loop: a job is emittable only once both NewMiningJob
// (merkle root + version) and SetNewPrevHash (prev-hash + nBits + ntime)
// are known. Future jobs (no min_ntime) wait for the SetNewPrevHash that
// names them.
type tipState struct {
	pending   map[uint32]*stratum.NewMiningJob
	prevHash  [32]byte
	prevNBits uint32
	havePrev  bool
	// active is the last emitted job and its ntime, kept so a SetTarget
	// frame can re-issue it at the new share target.
	active      *stratum.NewMiningJob
	activeNTime uint32
}

func newTipState() *tipState {
	return &tipState{pending: make(map[uint32]*stratum.NewMiningJob)}
}

// feed consumes one decoded message and returns the job to emit, if
// any: NewMiningJob emits immediately when it carries min_ntime and a
// tip is known, otherwise it is held; SetNewPrevHash clears stale jobs
// and emits the named one as a clean job.
func (t *tipState) feed(msg *stratum.Message) (job *stratum.NewMiningJob, ntime uint32, clean bool) {
	if msg.NewMiningJob != nil {
		j := msg.NewMiningJob
		t.pending[j.JobID] = j
		if j.HasMinNtime && t.havePrev {
			t.active, t.activeNTime = j, j.MinNtime
			return j, j.MinNtime, false
		}
		return nil, 0, false
	}
	if msg.SetNewPrevHash != nil {
		p := msg.SetNewPrevHash
		t.prevHash = p.PrevHash
		t.prevNBits = p.NBits
		t.havePrev = true
		named := t.pending[p.JobID]
		t.pending = map[uint32]*stratum.NewMiningJob{}
		if named == nil {
			return nil, 0, false
		}
		t.pending[p.JobID] = named
		ntime = p.MinNtime
		if named.HasMinNtime && named.MinNtime > ntime {
			ntime = named.MinNtime
		}
		t.active, t.activeNTime = named, ntime
		return named, ntime, true
	}
	return nil, 0, false
}

// applySetTarget records the pool's new share target: SuggestedDifficulty
// reports the converted difficulty and emitted Jobs carry the raw U256.
// Called only from the read loop, so shareTarget needs no synchronisation.
func (s *session) applySetTarget(maxTarget [32]byte) {
	s.shareTarget = maxTarget
	s.diff.Store(math.Float64bits(
		miner.DifficultyFromTarget(miner.Hash(maxTarget))))
}

// resolveSubmits accepts every in-flight submit with sequence number up
// to the ack's last_sequence_number. The ack's batch accounting counters
// (new_submits_accepted/new_shares_summed) apply once to the whole frame,
// so they are attached to exactly one of the resolved results —
// aggregating across returned results counts the frame exactly once.
func (s *session) resolveSubmits(ack *stratum.SubmitSharesSuccess) {
	s.pendingMu.Lock()
	defer s.pendingMu.Unlock()
	countsAttached := false
	for seq, ch := range s.pending {
		if seq > ack.LastSequenceNumber {
			continue
		}
		res := poolproto.ShareResult{Accepted: true}
		if !countsAttached {
			res.NewSubmitsAccepted = ack.NewSubmitsAccepted
			res.NewSharesSummed = ack.NewSharesSummed
			countsAttached = true
		}
		ch <- res
		delete(s.pending, seq)
	}
}

// rejectSubmit fails the in-flight submit a SubmitSharesError names.
func (s *session) rejectSubmit(e *stratum.SubmitSharesError) {
	s.pendingMu.Lock()
	defer s.pendingMu.Unlock()
	if ch, ok := s.pending[e.SequenceNumber]; ok {
		ch <- poolproto.ShareResult{Accepted: false, Reason: e.Error}
		delete(s.pending, e.SequenceNumber)
	}
}

// drainPending resolves every still-pending submit when the connection
// ends. No verdict was ever observed, so the results are Unconfirmed —
// consumers must not count a connection drop as a pool rejection.
func (s *session) drainPending() {
	s.pendingMu.Lock()
	defer s.pendingMu.Unlock()
	for seq, ch := range s.pending {
		ch <- poolproto.ShareResult{Accepted: false, Reason: "connection closed", Unconfirmed: true}
		delete(s.pending, seq)
	}
}

// Jobs returns the channel of incoming jobs.
func (s *session) Jobs() <-chan poolproto.Job { return s.jobsCh }

// ChannelID returns the channel ID assigned by the pool in
// OpenMiningChannelSuccess. Satisfies poolproto.ChannelIdentifier.
func (s *session) ChannelID() uint32 { return s.chanID }

// Submit sends a share upstream and waits for the pool's verdict: each
// submit carries a monotonically increasing sequence_number, and the
// read loop resolves the matching SubmitSharesSuccess (acked by
// last_sequence_number) or SubmitSharesError (matched by
// sequence_number). When ctx expires the share is considered submitted
// but unconfirmed — the provisional result is Accepted=true, per the
// Session contract.
func (s *session) Submit(ctx context.Context, sub poolproto.ShareSubmission) (poolproto.ShareResult, error) {
	jobID := parseJobID(sub.JobID)
	n := s.seq.Add(1)
	resultCh := make(chan poolproto.ShareResult, 1)
	s.pendingMu.Lock()
	s.pending[n] = resultCh
	s.pendingMu.Unlock()
	ss := stratum.SubmitSharesStandard{
		ChannelID:      s.chanID,
		SequenceNumber: n,
		JobID:          jobID,
		Nonce:          sub.Nonce,
		NTime:          sub.NTime,
		NVersion:       sub.Version,
	}
	// SubmitSharesStandard is a channel message: the channel_msg bit must
	// be set in the frame header (the engine's inline path already does
	// this; the two paths previously disagreed).
	if err := sendMsg(s.conn.raw, stratum.MsgSubmitSharesStandard, true, &ss); err != nil {
		s.pendingMu.Lock()
		delete(s.pending, n)
		s.pendingMu.Unlock()
		return poolproto.ShareResult{}, fmt.Errorf("stratumv2: submit share: %w", err)
	}
	select {
	case res := <-resultCh:
		return res, nil
	case <-ctx.Done():
		s.pendingMu.Lock()
		delete(s.pending, n)
		s.pendingMu.Unlock()
		return poolproto.ShareResult{Accepted: true, Unconfirmed: true}, nil
	}
}

// SuggestedDifficulty returns the current target difficulty.
func (s *session) SuggestedDifficulty() float64 {
	return float64FromBits(s.diff.Load())
}

// UpdateNominalHashrate implements poolproto.NominalHashrateUpdater:
// sends UpdateChannel (msg_type 0x16, §5.3.7) with the measured
// hashrate — the SV2 counterpart of V1 mining.suggest_difficulty.
// MaximumTarget is advertised unbounded (no device-side request), same
// posture as OpenMiningChannel: var-diff stays pool-authoritative.
func (s *session) UpdateNominalHashrate(_ context.Context, hashrate float64) error {
	uc := stratum.UpdateChannel{
		ChannelID:       s.chanID,
		NominalHashRate: float32(hashrate),
		MaximumTarget:   stratum.MaxTargetUnbounded,
	}
	if err := sendMsg(s.conn.raw, stratum.MsgUpdateChannel, true, uc); err != nil {
		return fmt.Errorf("stratumv2: update channel: %w", err)
	}
	return nil
}

// TLSCertNotAfter reports the pool leaf certificate's expiry when the
// transport is stratum+v2tls://; plaintext and Noise sessions return
// ok=false.
func (s *session) TLSCertNotAfter() (time.Time, bool) {
	return poolproto.PeerCertNotAfter(s.conn.raw)
}

// Close terminates the session's underlying connection.
func (s *session) Close() error { return s.conn.Close() }

// ----- helpers -----

// encodable is satisfied by every Stratum V2 message type (they all
// have an Encode method). Defined locally to avoid coupling the
// poolproto adapter to an exported interface in internal/stratum.
type encodable interface {
	Encode() ([]byte, error)
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
	_ poolproto.Dialer            = (*Dialer)(nil)
	_ poolproto.Connection        = (*connection)(nil)
	_ poolproto.Session           = (*session)(nil)
	_ poolproto.ChannelIdentifier = (*session)(nil)
	_ poolproto.TLSCertNotAfterer = (*session)(nil)
)
