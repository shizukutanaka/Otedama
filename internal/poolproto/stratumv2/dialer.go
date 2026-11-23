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
	"strconv"
	"sync"
	"sync/atomic"
	"time"

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

// dialTimeout bounds one pool dial attempt — TCP connect — so failover
// is not stalled by a blackhole endpoint when the caller's context
// carries no deadline. Var (not const) so tests can shorten it.
var dialTimeout = 15 * time.Second

// Dial opens a TCP (or, when configured, TLS) connection to the pool.
func (d *Dialer) Dial(ctx context.Context, url string, creds *poolproto.Credentials) (poolproto.Connection, error) {
	address, err := poolproto.StripScheme(url)
	if err != nil {
		return nil, fmt.Errorf("stratumv2: %w", err)
	}
	dctx, cancel := context.WithTimeout(ctx, dialTimeout)
	defer cancel()
	dialFn := d.dialFn
	if dialFn == nil {
		if d.useTLS {
			cfg, err := stratum.TLSConfigWithExtraCAs(creds.TLSRootCAsPEM)
			if err != nil {
				return nil, err
			}
			dialFn = func(ctx context.Context, address string) (net.Conn, error) {
				conn, err := stratum.DialTLS(ctx, address, cfg)
				if err != nil {
					return nil, fmt.Errorf("TLS dial: %w", err)
				}
				return conn, nil
			}
		} else {
			dialFn = func(ctx context.Context, address string) (net.Conn, error) {
				var dialer net.Dialer
				return dialer.DialContext(ctx, "tcp", address)
			}
		}
	}
	raw, err := dialFn(dctx, address)
	if err != nil && errors.Is(err, context.DeadlineExceeded) {
		err = fmt.Errorf("dial timeout after %s: %w", dialTimeout, err)
	}
	if err != nil {
		return nil, fmt.Errorf("stratumv2: dial %s: %w", address, err)
	}
	return &connection{
		raw:             raw,
		remoteAddr:      address,
		protocol:        d.Protocol(),
		user:            creds.User,
		nominalHashrate: creds.NominalHashrate,
	}, nil
}

// handshakeTimeout bounds the whole Negotiate handshake. The steady-state
// read loop is unblocked via Close()/ctx cancellation, but during the
// handshake nothing closes the socket — a peer that accepts TCP yet never
// answers SetupConnection would otherwise hang DialURL (and the engine's
// reconnect loop inside it) forever.
var handshakeTimeout = 15 * time.Second

// Rejection is an explicit refusal of connection setup or channel open.
type Rejection struct{ reason string }

func (e *Rejection) Error() string { return e.reason }
func (e *Rejection) Unwrap() error { return poolproto.ErrHandshakeFailed }

// Negotiate performs the Stratum V2 handshake (SetupConnection +
// OpenMiningChannel) and returns a Session that streams jobs.
func (d *Dialer) Negotiate(ctx context.Context, c poolproto.Connection) (poolproto.Session, error) {
	conn, ok := c.(*connection)
	if !ok {
		return nil, fmt.Errorf("stratumv2: Negotiate received non-V2 connection: %T", c)
	}

	_ = conn.raw.SetDeadline(time.Now().Add(handshakeTimeout))
	defer func() { _ = conn.raw.SetDeadline(time.Time{}) }()

	dec := stratum.NewDecoder(conn.raw)

	if err := conn.setup(dec); err != nil {
		return nil, err
	}
	channel, err := conn.openMiningChannel(dec)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	return &session{
		conn:    conn,
		dec:     dec,
		channel: *channel,
		ctx:     ctx,
		cancel:  cancel,
	}, nil
}

func (conn *connection) setup(dec *stratum.Decoder) error {
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
		return fmt.Errorf("stratumv2: send SetupConnection: %w", err)
	}
	f, err := dec.ReadFrame()
	if err != nil {
		return fmt.Errorf("stratumv2: read SetupConnection response: %w", err)
	}
	msg, err := stratum.DispatchFrame(f)
	if err != nil {
		return err
	}
	if msg.SetupConnectionError != nil {
		return &Rejection{fmt.Sprintf("pool rejected: %q", msg.SetupConnectionError.Error)}
	}
	if msg.SetupConnectionSuccess == nil {
		return fmt.Errorf("stratumv2: unexpected msg 0x%02X during setup", f.Header.MsgType)
	}
	if v := msg.SetupConnectionSuccess.UsedVersion; v < sc.MinVersion || v > sc.MaxVersion {
		return fmt.Errorf("stratumv2: pool negotiated version %d outside declared range [%d, %d]", v, sc.MinVersion, sc.MaxVersion)
	}
	// SetupConnectionSuccess.flags is the subset of the offered flags the
	// server requires. We offer none, so any nonzero value demands a
	// feature we cannot honor — reject rather than silently ignore.
	if msg.SetupConnectionSuccess.Flags&^sc.Flags != 0 {
		return fmt.Errorf("%w: pool requires flags 0x%08x outside offered set 0x%08x",
			poolproto.ErrHandshakeFailed, msg.SetupConnectionSuccess.Flags, sc.Flags)
	}
	return nil
}

func (conn *connection) openMiningChannel(dec *stratum.Decoder) (*stratum.OpenMiningChannelSuccess, error) {
	omc := stratum.OpenMiningChannel{
		ReqID:     1,
		User:      conn.user,
		MaxTarget: stratum.MaxTargetUnconstrained,
	}
	if conn.nominalHashrate != nil {
		omc.NominalHashrate = conn.nominalHashrate()
	}
	if err := sendMsg(conn.raw, stratum.MsgOpenMiningChannel, false, &omc); err != nil {
		return nil, fmt.Errorf("stratumv2: send OpenMiningChannel: %w", err)
	}
	f, err := dec.ReadFrame()
	if err != nil {
		return nil, fmt.Errorf("stratumv2: read OpenMiningChannel response: %w", err)
	}
	msg, err := stratum.DispatchFrame(f)
	if err != nil {
		return nil, err
	}
	if msg.OpenMiningChannelError != nil {
		return nil, &Rejection{fmt.Sprintf("pool rejected channel open: %q", msg.OpenMiningChannelError.Error)}
	}
	if msg.OpenMiningChannelSuccess == nil {
		return nil, fmt.Errorf("stratumv2: unexpected msg 0x%02X during channel open", f.Header.MsgType)
	}
	if msg.OpenMiningChannelSuccess.ReqID != omc.ReqID {
		return nil, fmt.Errorf("stratumv2: channel response echoes req_id %d, sent %d",
			msg.OpenMiningChannelSuccess.ReqID, omc.ReqID)
	}
	return msg.OpenMiningChannelSuccess, nil
}

// ----- connection -----

type connection struct {
	raw             net.Conn
	remoteAddr      string
	protocol        poolproto.ProtocolID
	user            string
	nominalHashrate func() float32

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

// MiningSession exposes the ordered SV2 messages and sequenced shares
// needed for channel state, retargets, and batched share acknowledgments.
// Use ReadMessage from a single reader, instead of Session.Jobs.
type MiningSession interface {
	poolproto.Session
	Channel() stratum.OpenMiningChannelSuccess
	ReadMessage() (stratum.Message, error)
	SubmitStandard(*stratum.SubmitSharesStandard) error
}

// Bound reads from half-open pools that stop sending any frames.
const poolSilenceTimeout = 30 * time.Minute

// pendingCap bounds the read loop's outstanding-job map: a hostile or buggy
// pool flooding distinct job IDs without rotating the tip would otherwise
// grow memory without limit. 64 is far above legitimate churn; eviction is
// FIFO so the newest jobs — most likely named by the next SetNewPrevHash —
// survive.
const pendingCap = 64

type session struct {
	conn    *connection
	dec     *stratum.Decoder
	channel stratum.OpenMiningChannelSuccess
	ctx     context.Context
	cancel  context.CancelFunc
	jobsCh  chan poolproto.Job

	diff atomic.Uint64 // suggested difficulty as math.Float64bits

	startOnce sync.Once
}

func (s *session) Channel() stratum.OpenMiningChannelSuccess { return s.channel }

func (s *session) readFrame() (stratum.Frame, error) {
	_ = s.conn.raw.SetReadDeadline(time.Now().Add(poolSilenceTimeout))
	return s.dec.ReadFrame()
}

func (s *session) ReadMessage() (stratum.Message, error) {
	f, err := s.readFrame()
	if err != nil {
		return stratum.Message{}, err
	}
	return stratum.DispatchFrame(f)
}

func (s *session) readLoop(ctx context.Context) {
	defer close(s.jobsCh)
	// SV2 job/tip state lives in the assembler: a job is emittable only
	// once both NewMiningJob (merkle root + version) and SetNewPrevHash
	// (prev-hash + nBits + ntime) are known. Future jobs (no ntime_start)
	// wait for the SetNewPrevHash that names them.
	a := &sv2JobAssembler{pending: make(map[uint32]*stratum.NewMiningJob)}
	a.emit = func(j *stratum.NewMiningJob, ntime uint32, clean bool) bool {
		job := poolproto.Job{
			JobID:      strconv.FormatUint(uint64(j.JobID), 10),
			Version:    j.Version,
			PrevHash:   a.prevHash,
			MerkleRoot: j.MerkleRoot,
			NTime:      ntime,
			NBits:      a.prevNBits,
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
		f, err := s.readFrame()
		if err != nil {
			return
		}
		msg, err := stratum.DispatchFrame(f)
		if err != nil {
			continue // skip undecodable frame, keep reading
		}
		if msg.NewMiningJob != nil {
			if !a.onNewMiningJob(msg.NewMiningJob) {
				return
			}
		}
		if msg.SetNewPrevHash != nil {
			if !a.onSetNewPrevHash(msg.SetNewPrevHash) {
				return
			}
		}
		// Note: SetTarget (share difficulty) has no carrier on
		// poolproto.Job; the engine consumes ordered messages instead.
	}
}

// sv2JobAssembler accumulates NewMiningJob/SetNewPrevHash frames into a
// stream of complete poolproto.Jobs. emit returns false when the receiver
// should stop (ctx done / channel closed).
type sv2JobAssembler struct {
	pending      map[uint32]*stratum.NewMiningJob
	pendingOrder []uint32 // insertion order for pendingCap FIFO eviction
	prevHash     [32]byte
	prevNBits    uint32
	havePrev     bool
	emit         func(j *stratum.NewMiningJob, ntime uint32, clean bool) bool
}

func (a *sv2JobAssembler) onNewMiningJob(j *stratum.NewMiningJob) bool {
	if _, ok := a.pending[j.JobID]; !ok {
		a.pendingOrder = append(a.pendingOrder, j.JobID)
	}
	a.pending[j.JobID] = j
	for len(a.pendingOrder) > pendingCap {
		delete(a.pending, a.pendingOrder[0])
		a.pendingOrder = a.pendingOrder[1:]
	}
	if j.HasNtimeStart && a.havePrev {
		return a.emit(j, j.NtimeStart, false)
	}
	// Future job (or no tip yet): held until SetNewPrevHash.
	return true
}

func (a *sv2JobAssembler) onSetNewPrevHash(p *stratum.SetNewPrevHash) bool {
	a.prevHash = p.PrevHash
	a.prevNBits = p.NBits
	a.havePrev = true
	named := a.pending[p.JobID]
	a.pending = map[uint32]*stratum.NewMiningJob{}
	a.pendingOrder = a.pendingOrder[:0]
	if named == nil {
		return true
	}
	a.pending[p.JobID] = named
	a.pendingOrder = append(a.pendingOrder, p.JobID)
	ntime := p.NtimeStart
	if named.HasNtimeStart && named.NtimeStart > ntime {
		ntime = named.NtimeStart
	}
	return a.emit(named, ntime, true)
}

// Jobs starts and returns the protocol-agnostic job stream.
func (s *session) Jobs() <-chan poolproto.Job {
	s.startOnce.Do(func() {
		s.jobsCh = make(chan poolproto.Job, 8)
		go s.readLoop(s.ctx)
	})
	return s.jobsCh
}

// Submit returns provisional success after writing a share. Callers
// needing authoritative asynchronous verdicts use the MiningSession view.
func (s *session) Submit(ctx context.Context, sub poolproto.ShareSubmission) (poolproto.ShareResult, error) {
	jobID := parseJobID(sub.JobID)
	ss := stratum.SubmitSharesStandard{
		ChannelID:      s.channel.ChannelID,
		SequenceNumber: 0,
		JobID:          jobID,
		Nonce:          sub.Nonce,
		NTime:          sub.NTime,
		NVersion:       sub.Version,
	}
	if err := s.SubmitStandard(&ss); err != nil {
		return poolproto.ShareResult{}, fmt.Errorf("stratumv2: submit share: %w", err)
	}
	return poolproto.ShareResult{Accepted: true}, nil
}

func (s *session) SubmitStandard(sub *stratum.SubmitSharesStandard) error {
	return sendMsg(s.conn.raw, stratum.MsgSubmitSharesStandard, true, sub)
}

// SuggestedDifficulty returns the current target difficulty.
func (s *session) SuggestedDifficulty() float64 {
	return float64FromBits(s.diff.Load())
}

// Close terminates the session's underlying connection.
func (s *session) Close() error {
	s.cancel()
	return s.conn.Close()
}

// ----- helpers -----

// Compile-time interface satisfaction checks.
var (
	_ poolproto.Dialer     = (*Dialer)(nil)
	_ poolproto.Connection = (*connection)(nil)
	_ MiningSession        = (*session)(nil)
)

// encodable is satisfied by every Stratum V2 message type (they all
// have an Encode method). Defined locally to avoid coupling the
// poolproto adapter to an exported interface in internal/stratum.
type encodable interface {
	Encode() ([]byte, error)
}

// writeTimeout bounds every write on the pool socket. Without a
// deadline a pool that keeps the TCP connection open but stops reading
// stalls the session loop on a full kernel send buffer — the V1 path
// already applies the same bound (10s). Declared a var so tests can
// shorten it.
var writeTimeout = 10 * time.Second

// sendMsg encodes, frames, and writes a Stratum V2 message. isChannel
// sets the frame header's channel_msg bit — required for channel-scoped
// messages (SubmitSharesStandard etc.), absent for connection-scoped
// ones (SetupConnection, OpenMiningChannel).
func sendMsg(w net.Conn, msgType uint8, isChannel bool, enc encodable) error {
	payload, err := enc.Encode()
	if err != nil {
		return fmt.Errorf("stratumv2: encode 0x%02X: %w", msgType, err)
	}
	f, err := stratum.WrapMessage(msgType, isChannel, payload)
	if err != nil {
		return fmt.Errorf("stratumv2: wrap 0x%02X: %w", msgType, err)
	}
	data, err := stratum.EncodeFrame(f)
	if err != nil {
		return err
	}
	_ = w.SetWriteDeadline(time.Now().Add(writeTimeout))
	if _, err := w.Write(data); err != nil {
		return err
	}
	return nil
}

// parseJobID converts the unified ShareSubmission string into the U32 the
// V2 wire expects. V2 job IDs are numeric per spec, so strict ParseUint —
// Sscanf(%d) silently truncates ("1a" → 1), colliding with a real ID.
// Garbage yields 0.
func parseJobID(s string) uint32 {
	n, _ := strconv.ParseUint(s, 10, 32)
	return uint32(n) //nolint:gosec // bounded by ParseUint bitSize 32
}

// float64FromBits is the inverse of math.Float64bits, used to read the
// difficulty stored in the session's atomic.Uint64.
func float64FromBits(bits uint64) float64 {
	return math.Float64frombits(bits)
}
