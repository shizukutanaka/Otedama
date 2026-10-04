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
		dialFn = func(ctx context.Context, address string) (net.Conn, error) {
			if d.useTLS {
				// A stratum+v2tls:// scheme must produce a certificate-verified
				// TLS transport — never a silent plaintext downgrade. nil config
				// = system roots, TLS 1.2+, ServerName from the dial address
				// (stratum.DialTLS never falls back to plaintext).
				return stratum.DialTLS(ctx, address, nil)
			}
			var dialer net.Dialer
			return dialer.DialContext(ctx, "tcp", address)
		}
	}
	raw, err := dialFn(dctx, address)
	if err != nil && errors.Is(err, context.DeadlineExceeded) {
		err = fmt.Errorf("dial timeout after %s", dialTimeout)
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

// handshakeTimeout bounds the whole Negotiate handshake. The steady-state
// read loop is unblocked via Close()/ctx cancellation, but during the
// handshake nothing closes the socket — a peer that accepts TCP yet never
// answers SetupConnection would otherwise hang DialURL (and the engine's
// reconnect loop inside it) forever.
var handshakeTimeout = 15 * time.Second

// Negotiate performs the Stratum V2 handshake (SetupConnection +
// OpenMiningChannel) and returns a Session that streams jobs.
func (d *Dialer) Negotiate(ctx context.Context, c poolproto.Connection) (poolproto.Session, error) {
	conn, ok := c.(*connection)
	if !ok {
		return nil, fmt.Errorf("stratumv2: Negotiate received non-V2 connection: %T", c)
	}

	// Bound the handshake reads; cleared on return since the session read
	// loop is governed by Close/ctx, not deadlines.
	_ = conn.raw.SetReadDeadline(time.Now().Add(handshakeTimeout))
	defer func() { _ = conn.raw.SetReadDeadline(time.Time{}) }()

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
		return nil, fmt.Errorf("%w: %q", poolproto.ErrHandshakeFailed, msg.SetupConnectionError.Error)
	}
	if msg.SetupConnectionSuccess == nil {
		return nil, fmt.Errorf("stratumv2: unexpected msg 0x%02X during setup", f.Header.MsgType)
	}
	if v := msg.SetupConnectionSuccess.UsedVersion; v < sc.MinVersion || v > sc.MaxVersion {
		return nil, fmt.Errorf("%w: pool negotiated version %d outside declared range [%d, %d]",
			poolproto.ErrHandshakeFailed, v, sc.MinVersion, sc.MaxVersion)
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
		return nil, fmt.Errorf("%w: %q", poolproto.ErrHandshakeFailed, msg.OpenMiningChannelError.Error)
	}
	if msg.OpenMiningChannelSuccess == nil {
		return nil, fmt.Errorf("stratumv2: unexpected msg 0x%02X during channel open", f.Header.MsgType)
	}

	sess := &session{
		conn:   conn,
		dec:    dec,
		chanID: msg.OpenMiningChannelSuccess.ChannelID,
		jobsCh: make(chan poolproto.Job, 8),
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

// pendingCap bounds the read loop's outstanding-job map: a hostile or buggy
// pool flooding distinct job IDs without rotating the tip would otherwise
// grow memory without limit. 64 is far above legitimate churn; eviction is
// FIFO so the newest jobs — most likely named by the next SetNewPrevHash —
// survive.
const pendingCap = 64

type session struct {
	conn   *connection
	dec    *stratum.Decoder
	chanID uint32
	jobsCh chan poolproto.Job

	diff atomic.Uint64 // suggested difficulty as math.Float64bits

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
	// SV2 job/tip state, mirroring the engine's inline loop: a job is
	// emittable only once both NewMiningJob (merkle root + version) and
	// SetNewPrevHash (prev-hash + nBits + ntime) are known. Future jobs
	// (no ntime_start) wait for the SetNewPrevHash that names them.
	pending := make(map[uint32]*stratum.NewMiningJob)
	var pendingOrder []uint32 // insertion order for pendingCap FIFO eviction
	var prevHash [32]byte
	var prevNBits uint32
	havePrev := false

	emit := func(j *stratum.NewMiningJob, ntime uint32, clean bool) bool {
		job := poolproto.Job{
			JobID:      strconv.FormatUint(uint64(j.JobID), 10),
			Version:    j.Version,
			PrevHash:   prevHash,
			MerkleRoot: j.MerkleRoot,
			NTime:      ntime,
			NBits:      prevNBits,
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
		if msg.NewMiningJob != nil {
			j := msg.NewMiningJob
			if _, ok := pending[j.JobID]; !ok {
				pendingOrder = append(pendingOrder, j.JobID)
			}
			pending[j.JobID] = j
			for len(pendingOrder) > pendingCap {
				delete(pending, pendingOrder[0])
				pendingOrder = pendingOrder[1:]
			}
			if j.HasNtimeStart && havePrev {
				if !emit(j, j.NtimeStart, false) {
					return
				}
			}
			// Future job (or no tip yet): held until SetNewPrevHash.
		}
		if msg.SetNewPrevHash != nil {
			p := msg.SetNewPrevHash
			prevHash = p.PrevHash
			prevNBits = p.NBits
			havePrev = true
			named := pending[p.JobID]
			pending = map[uint32]*stratum.NewMiningJob{}
			pendingOrder = pendingOrder[:0]
			if named != nil {
				pending[p.JobID] = named
				pendingOrder = append(pendingOrder, p.JobID)
				ntime := p.NtimeStart
				if named.HasNtimeStart && named.NtimeStart > ntime {
					ntime = named.NtimeStart
				}
				if !emit(named, ntime, true) {
					return
				}
			}
		}
		// Note: SetTarget (share difficulty) has no carrier on
		// poolproto.Job; the engine's inline V2 loop handles it. This
		// adapter is not yet the live V2 path (KNOWN_LIMITATIONS §3).
	}
}

// Jobs returns the channel of incoming jobs.
func (s *session) Jobs() <-chan poolproto.Job { return s.jobsCh }

// Submit sends a share upstream. The verdict is read by the engine's
// frame loop today; this adapter performs a best-effort synchronous
// submit and returns a provisional accepted result (the authoritative
// accept/reject arrives asynchronously via SubmitSharesSuccess/Error
// frames, which the engine already handles). When the full integration
// lands, this becomes a request/response correlation.
func (s *session) Submit(ctx context.Context, sub poolproto.ShareSubmission) (poolproto.ShareResult, error) {
	jobID := parseJobID(sub.JobID)
	ss := stratum.SubmitSharesStandard{
		ChannelID:      s.chanID,
		SequenceNumber: 0,
		JobID:          jobID,
		Nonce:          sub.Nonce,
		NTime:          sub.NTime,
		NVersion:       sub.Version,
	}
	// SubmitSharesStandard is a channel message: the channel_msg bit must
	// be set in the frame header (the engine's inline path already does
	// this; the two paths previously disagreed).
	if err := sendMsg(s.conn.raw, stratum.MsgSubmitSharesStandard, true, &ss); err != nil {
		return poolproto.ShareResult{}, fmt.Errorf("stratumv2: submit share: %w", err)
	}
	return poolproto.ShareResult{Accepted: true}, nil
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
	_ = w.SetWriteDeadline(time.Now().Add(writeTimeout))
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
