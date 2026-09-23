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
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shizukutanaka/Otedama/internal/miner"
	"github.com/shizukutanaka/Otedama/internal/poolproto"
	"github.com/shizukutanaka/Otedama/internal/stratum"
	"github.com/shizukutanaka/Otedama/internal/version"
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

// Dial opens a TCP (or, when configured, certificate-verified TLS)
// connection to the pool. A TLS dialer never falls back to plaintext:
// stratum+v2tls:// either yields a verified TLS connection or an error.
func (d *Dialer) Dial(ctx context.Context, url string, creds poolproto.Credentials) (poolproto.Connection, error) {
	address, err := poolproto.StripScheme(url)
	if err != nil {
		return nil, fmt.Errorf("stratumv2: %w", err)
	}
	var raw net.Conn
	if d.useTLS {
		cfg, tlsErr := stratum.TLSConfigWithExtraCAs(creds.TLSRootCAsPEM)
		if tlsErr != nil {
			return nil, fmt.Errorf("stratumv2: %w", tlsErr)
		}
		raw, err = stratum.DialTLS(ctx, address, cfg)
	} else {
		dialFn := d.dialFn
		if dialFn == nil {
			dialFn = func(ctx context.Context, address string) (net.Conn, error) {
				dialer := net.Dialer{Timeout: connectTimeout}
				return dialer.DialContext(ctx, "tcp", address)
			}
		}
		raw, err = dialFn(ctx, address)
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

// Network stall bounds. connectTimeout caps the TCP connect phase (a
// black-holed endpoint otherwise fails only at the OS TCP timeout);
// negotiateTimeout caps the whole SetupConnection+OpenMiningChannel
// exchange — the two ReadFrame calls below block on the raw conn, which a
// context cannot interrupt, so without a deadline a pool that accepts the
// TCP connection but never answers leaves Negotiate blocked forever,
// ignoring ctx cancellation and leaking the caller in DialURL (same
// blackhole-pool class the engine's inline V2 handshake bounds via
// conn.SetDeadline); sessionReadTimeout is the per-frame deadline
// refreshed in the read loop — same rationale as stratumv1's 5-minute
// per-line deadline. Vars (not consts) so tests can shrink them.
var (
	connectTimeout     = 15 * time.Second
	negotiateTimeout   = 30 * time.Second
	sessionReadTimeout = 5 * time.Minute
)

// Negotiate performs the Stratum V2 handshake (SetupConnection +
// OpenMiningChannel) and returns a Session that streams jobs.
func (d *Dialer) Negotiate(ctx context.Context, c poolproto.Connection) (poolproto.Session, error) {
	conn, ok := c.(*connection)
	if !ok {
		return nil, fmt.Errorf("stratumv2: Negotiate received non-V2 connection: %T", c)
	}

	// Bound the exchange, then clear the deadline before the session's
	// readLoop inherits the conn — the loop re-arms a per-frame read
	// deadline (sessionReadTimeout) itself from then on.
	_ = conn.raw.SetDeadline(time.Now().Add(negotiateTimeout))
	defer conn.raw.SetDeadline(time.Time{}) //nolint:errcheck

	dec := stratum.NewDecoder(conn.raw)

	// SetupConnection. remoteAddr is "host:port" so split it for the
	// spec's separate endpoint_host/endpoint_port wire fields (§3.6.1).
	epHost, epPort := splitHostPort(conn.remoteAddr)
	sc := stratum.SetupConnection{
		Protocol:   stratum.MiningProtocol,
		MinVersion: 2,
		MaxVersion: 2,
		// End mining device: we only handle NewMiningJob (standard),
		// never NewExtendedMiningJob.
		Flags:           stratum.FlagRequiresStandardJobs,
		EndpointHost:    epHost,
		EndpointPort:    epPort,
		Vendor:          "Otedama",
		HardwareVersion: version.Version,
		Firmware:        "main",
		DeviceID:        "cpu",
	}
	if err := sendMsg(conn, stratum.MsgSetupConnection, false, &sc); err != nil {
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

	// OpenMiningChannel. MaxTarget is mandatory on the wire (§5.3.2);
	// all-0xff means the device accepts whatever share target the pool
	// assigns.
	omc := stratum.OpenMiningChannel{
		ReqID:           1,
		User:            conn.user,
		NominalHashrate: 0, // engine updates real hashrate later
		MaxTarget:       stratum.MaxTargetAny(),
	}
	if err := sendMsg(conn, stratum.MsgOpenMiningChannel, false, &omc); err != nil {
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

	// writeMu serialises frame writes: a share Submit racing another send
	// must not interleave frame bytes on the wire (the stratumv1 adapter
	// carries the same mutex for the same reason).
	writeMu sync.Mutex

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
	// seq is the SubmitSharesStandard sequence counter. Pools correlate
	// SubmitSharesSuccess/Error by sequence_number and may dedupe on it —
	// a constant 0 made every share after the first look like a resend.
	seq atomic.Uint32

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
	// (no min_ntime) wait for the SetNewPrevHash that names them.
	pending := make(map[uint32]*stratum.NewMiningJob)
	var order []uint32
	var prevHash [32]byte
	var prevNBits uint32
	havePrev := false

	emit := func(j *stratum.NewMiningJob, ntime uint32, clean bool) bool {
		job := poolproto.Job{
			JobID:      fmt.Sprintf("%d", j.JobID),
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
		// Re-arm per frame: a wedged-but-open pool connection must end
		// the session rather than hang forever (V1 carries the same
		// 5-minute per-line deadline). Healthy SV2 pools push jobs on
		// every template update, far more often than the block interval.
		_ = s.conn.raw.SetReadDeadline(time.Now().Add(sessionReadTimeout))
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
			if _, dup := pending[j.JobID]; !dup {
				order = append(order, j.JobID)
			}
			pending[j.JobID] = j
			// Bound the awaiting-tip map: a pool streaming endless future
			// jobs without a chain-tip update must not grow session memory
			// without bound (same cap and oldest-first eviction as the
			// engine's inline jobs map).
			for len(order) > pendingJobsCap {
				delete(pending, order[0])
				order = order[1:]
			}
			if j.HasMinNtime && havePrev {
				if !emit(j, j.MinNtime, false) {
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
			order = order[:0]
			if named != nil {
				pending[p.JobID] = named
				order = append(order, p.JobID)
				ntime := p.MinNtime
				if named.HasMinNtime && named.MinNtime > ntime {
					ntime = named.MinNtime
				}
				if !emit(named, ntime, true) {
					return
				}
			}
		}
		if msg.SetTarget != nil {
			// Publish the pool-assigned share difficulty so
			// SuggestedDifficulty reports something real. MaxTarget is a
			// target, not a difficulty — convert via diff1/target.
			s.diff.Store(math.Float64bits(
				miner.DifficultyFromTarget(miner.Hash(msg.SetTarget.MaxTarget))))
		}
		// This adapter is not yet the live V2 path
		// (KNOWN_LIMITATIONS §3).
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
		SequenceNumber: s.seq.Add(1), // first share is 1, like the engine's inline path
		JobID:          jobID,
		Nonce:          sub.Nonce,
		NTime:          sub.NTime,
		NVersion:       sub.Version,
	}
	// SubmitSharesStandard is a channel message: the channel_msg bit must
	// be set in the frame header (the engine's inline path already does
	// this; the two paths previously disagreed).
	if err := sendMsg(s.conn, stratum.MsgSubmitSharesStandard, true, &ss); err != nil {
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

// pendingJobsCap bounds the pending-job map, mirroring the engine's
// inline loop: a pool streaming endless future jobs without a tip update
// must not grow session memory without bound.
const pendingJobsCap = 256

// sendMsg encodes, frames, and writes a Stratum V2 message. isChannel
// sets the frame header's channel_msg bit — required for channel-scoped
// messages (SubmitSharesStandard etc.), absent for connection-scoped
// ones (SetupConnection, OpenMiningChannel). Writes are serialised
// through the connection's writeMu so concurrent Submit calls cannot
// interleave frame bytes.
func sendMsg(c *connection, msgType uint8, isChannel bool, enc encodable) error {
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
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if _, err := c.raw.Write(data); err != nil {
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

// splitHostPort splits "host:port" for the SetupConnection wire fields.
// A missing or unparseable port degrades to 0 — informational only.
func splitHostPort(addr string) (string, uint16) {
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return addr, 0
	}
	port, err := strconv.ParseUint(portStr, 10, 16)
	if err != nil {
		return host, 0
	}
	return host, uint16(port)
}

// Compile-time assertions.
var (
	_ poolproto.Dialer     = (*Dialer)(nil)
	_ poolproto.Connection = (*connection)(nil)
	_ poolproto.Session    = (*session)(nil)
)
