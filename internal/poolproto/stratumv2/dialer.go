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

// Dial opens a TCP (or, when configured, TLS) connection to the pool.
func (d *Dialer) Dial(ctx context.Context, url string, creds poolproto.Credentials) (poolproto.Connection, error) {
	address, err := poolproto.StripScheme(url)
	if err != nil {
		return nil, fmt.Errorf("stratumv2: %w", err)
	}
	dialFn := d.dialFn
	if dialFn == nil {
		dialFn = dialTCP
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
	// Seed the suggested difficulty from the channel's initial target
	// when the pool assigned one; subsequent SetTarget frames update it.
	// A zero target means "unset" (SRI v1.5.0 lesson: it is unusable),
	// so leave SuggestedDifficulty at its documented zero default.
	var zeroTarget [32]byte
	if msg.OpenMiningChannelSuccess.Target != zeroTarget {
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

	// seq issues the SV2 sequence_number each submit carries so the
	// pool's SubmitSharesSuccess/Error frames can be correlated back to
	// their request. pending holds a buffered result chan per in-flight
	// sequence number; the read loop resolves them as verdicts arrive
	// (request/response correlation, replacing the previous fire-and-
	// forget submit that hardcoded sequence_number=0).
	seq       atomic.Uint32
	pending   map[uint32]chan poolproto.ShareResult
	pendingMu sync.Mutex

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
	defer func() {
		// Unblock every in-flight submit so callers aren't left waiting
		// for a verdict that will never arrive.
		s.pendingMu.Lock()
		defer s.pendingMu.Unlock()
		for seq, ch := range s.pending {
			ch <- poolproto.ShareResult{Accepted: false, Reason: "connection closed"}
			delete(s.pending, seq)
		}
	}()
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
		}
		if msg.SubmitSharesSuccess != nil {
			s.resolveSubmits(msg.SubmitSharesSuccess.LastSequenceNumber)
		}
		if msg.SubmitSharesError != nil {
			s.rejectSubmit(msg.SubmitSharesError)
		}
	}
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
		return named, ntime, true
	}
	return nil, 0, false
}

// applySetTarget records the pool's new share target as the suggested
// difficulty so SuggestedDifficulty reflects it.
func (s *session) applySetTarget(maxTarget [32]byte) {
	s.diff.Store(math.Float64bits(
		miner.DifficultyFromTarget(miner.Hash(maxTarget))))
}

// resolveSubmits accepts every in-flight submit with sequence number up
// to last: a SubmitSharesSuccess ack covers all of them.
func (s *session) resolveSubmits(last uint32) {
	s.pendingMu.Lock()
	defer s.pendingMu.Unlock()
	for seq, ch := range s.pending {
		if seq <= last {
			ch <- poolproto.ShareResult{Accepted: true}
			delete(s.pending, seq)
		}
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

// Jobs returns the channel of incoming jobs.
func (s *session) Jobs() <-chan poolproto.Job { return s.jobsCh }

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
		return poolproto.ShareResult{Accepted: true}, nil
	}
}

// SuggestedDifficulty returns the current target difficulty.
func (s *session) SuggestedDifficulty() float64 {
	return float64FromBits(s.diff.Load())
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
