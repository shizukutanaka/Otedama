// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package poolproto abstracts the wire protocol used to talk to a
// mining pool. Its purpose is to insulate engine/, miner/, and the
// arbitration loop from the specific protocol implementation, so that
// adding a new protocol does not require touching the rest of the
// codebase.
//
// Two protocols are actually implemented today, each with a
// registered Dialer: Stratum V1 (legacy JSON-RPC over TCP, optionally
// TLS — package stratumv1) and Stratum V2 (binary framing with Noise
// NX encryption — package stratumv2). DATUM (OCEAN's protocol,
// layered on SV1 transport) has a reserved URL scheme constant
// (ProtocolDATUM) and is planned (see docs/adr/ADR-009, status
// Proposed) but has no Dialer registered anywhere and no
// implementation package — DialURL("datum://...") returns
// ErrUnknownProtocol today. See docs/KNOWN_LIMITATIONS.md for the
// current implementation-status summary.
//
// # Why this exists (the 10-year case)
//
// 2025-2026 ecosystem snapshot:
//
//   - SV2 sits at ~15-20% of network hashrate. Braiins and DEMAND
//     speak it natively. OCEAN runs DATUM (an SV1-transport variant).
//     Foundry and AntPool (combined ~50% of hashrate) still primarily
//     SV1.
//   - SV2 Reference Implementation (SRI) has moved past its early-alpha
//     phase: v1.11.0 (2026-07-08), roughly monthly release cadence
//     (verified session 251; supersedes this comment's earlier "v1.5,
//     alpha" snapshot). No production-quality Go SV2 implementation
//     exists yet, which is still the gap this package addresses.
//   - Bitcoin Core 30 shipped an experimental IPC Mining Interface
//     (unix socket, -DENABLE_IPC) letting SV2/other mining software
//     request templates and submit blocks — a cleaner target than
//     legacy getblocktemplate for future node integration.
//   - Job Declaration Protocol production support is limited to
//     Braiins and DEMAND.
//
// A 10-year project must assume SV2 will mature, that DATUM or its
// successor will gain share, and that something we cannot yet name
// will appear by 2030. The only sane response is an interface seam.
//
// # Design
//
// A Connection is an opaque transport, established by a Dialer. A
// Session represents one mining channel (SetupConnection +
// OpenMiningChannel pair, or its V1 equivalent). A Session emits
// Jobs and accepts ShareSubmissions. The protocol-specific encoding,
// framing, encryption, and message numbering all happen inside the
// implementation; callers see only typed values.
//
// # Adding a new protocol
//
// Implement the four interfaces below for the new protocol, register
// the Dialer factory in init(), and the rest of Otedama can negotiate
// or be configured to use it. No engine/ or miner/ changes required.
package poolproto

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"
	"unicode"
)

// ----- Protocol identifiers -----

// ProtocolID identifies a wire protocol.
type ProtocolID string

const (
	ProtocolStratumV1    ProtocolID = "stratum-v1"
	ProtocolStratumV1TLS ProtocolID = "stratum-v1-tls"
	ProtocolStratumV2    ProtocolID = "stratum-v2"
	ProtocolStratumV2TLS ProtocolID = "stratum-v2-tls"
	ProtocolDATUM        ProtocolID = "datum" // OCEAN, SV1-transport variant
	ProtocolUnknown      ProtocolID = ""
)

// PostQuantumReady reports whether the protocol's authenticated
// channel is believed to resist quantum attack. Only protocols
// negotiating PQ-hybrid handshakes return true; reserved for future
// SV2 extensions.
func (p ProtocolID) PostQuantumReady() bool {
	return false // no PQ-ready pool protocol exists in 2026
}

// FromURL extracts the protocol from a URL scheme, e.g.
//
//	"stratum+tcp://pool.example.com:3333"     → ProtocolStratumV1
//	"stratum+tls://pool.example.com:3334"     → ProtocolStratumV1TLS
//	"stratum+v2://pool.example.com:3336"      → ProtocolStratumV2
//	"stratum+v2tls://pool.example.com:3336"   → ProtocolStratumV2TLS
//	"datum://pool.example.com:3334"           → ProtocolDATUM
func FromURL(url string) ProtocolID {
	for _, s := range knownSchemes {
		if strings.HasPrefix(url, s.prefix) {
			return s.proto
		}
	}
	return ProtocolUnknown
}

// knownSchemes lists every pool URL scheme prefix Otedama understands,
// paired with its protocol. It is the single source of truth for both
// FromURL (which protocol?) and StripScheme (what host follows?).
var knownSchemes = []struct {
	prefix string
	proto  ProtocolID
}{
	{"stratum+v2tls://", ProtocolStratumV2TLS},
	{"stratum+v2://", ProtocolStratumV2},
	{"stratum+tls://", ProtocolStratumV1TLS},
	{"stratum+tcp://", ProtocolStratumV1},
	{"datum://", ProtocolDATUM},
}

// StripScheme removes a recognized pool URL scheme prefix and returns
// the remaining host[:port] portion. It returns ErrUnknownProtocol if
// the scheme is not recognized. This is the canonical way to get the
// dial target from a pool URL, replacing ad-hoc per-package parsing.
func StripScheme(url string) (host string, err error) {
	for _, s := range knownSchemes {
		if len(url) > len(s.prefix) && url[:len(s.prefix)] == s.prefix {
			return url[len(s.prefix):], nil
		}
	}
	return "", fmt.Errorf("%w: %q", ErrUnknownProtocol, url)
}

// StripUserinfo removes any credentials embedded in a pool URL's authority
// (scheme://user:pass@host → scheme://host) for display and logging.
// Config pool URLs today may carry userinfo, and echoing them into logs,
// doctor output, or the TUI would leak the pool password. Malformed URLs
// are returned unchanged — redaction must never corrupt diagnostics.
func StripUserinfo(url string) string {
	i := strings.Index(url, "://")
	if i < 0 {
		return url
	}
	rest := url[i+3:]
	// Redact only a '@' inside the authority (before the first '/').
	if at := strings.LastIndexByte(rest, '@'); at >= 0 {
		if slash := strings.IndexByte(rest, '/'); slash < 0 || at < slash {
			return url[:i+3] + rest[at+1:]
		}
	}
	return url
}

// ----- Core types -----

// Job is a unit of mining work delivered by the pool. Pure data; the
// fields chosen are the ones Otedama's worker actually needs to drive
// the SHA-256d hot path.
type Job struct {
	// JobID is opaque to Otedama; it must be echoed back on share
	// submission so the pool can correlate.
	JobID string

	// Version is the block-header version field.
	Version uint32

	// PrevHash is the previous block hash in the block header's
	// serialization byte order — the bytes copied verbatim into the
	// 80-byte header for hashing. The Stratum V1 wire encoding
	// (each 4-byte word byte-swapped) is normalized at decode.
	PrevHash [32]byte

	// MerkleRoot is the merkle root constructed by the pool.
	// (For Job-Declaration-Protocol use cases the miner constructs
	// this; that variant is exposed through a separate JDPSession
	// when implementations exist — currently reserved.)
	MerkleRoot [32]byte

	// NTime is the block timestamp in seconds.
	NTime uint32

	// NBits is the compact target.
	NBits uint32

	// CleanJobs, when true, indicates older jobs may be discarded.
	CleanJobs bool

	// ExtraNonce is the extranonce2 the MerkleRoot was computed with.
	// V1 only: the session picks a fresh value per job and folds it into
	// the coinbase; shares must echo it back so the pool can rebuild the
	// same coinbase. Empty for protocols that don't use it (V2).
	ExtraNonce []byte

	// Coinb1, Coinb2 and MerkleBranch are the raw Stratum V1 coinbase
	// parts from mining.notify. The session folds them into MerkleRoot
	// (with Extranonce) before handing the job to the engine. V2 leaves
	// them empty — the pool supplies a ready MerkleRoot there.
	Coinb1       []byte
	Coinb2       []byte
	MerkleBranch [][]byte

	// CoinbaseTx is the fully reassembled coinbase transaction
	// (coinb1 || extranonce1 || ExtraNonce || coinb2), stored by the
	// session when it folds the parts. It lets the engine inspect the
	// transaction's outputs positionally — e.g. verifying a declared
	// direct-payout scheme actually pays the configured address —
	// which a substring scan of the raw halves cannot do faithfully.
	// Empty for protocols that never see the coinbase (V2) and for
	// sessions that negotiated no extranonces.
	CoinbaseTx []byte

	// ReceivedAt is when Otedama received this job (for stale
	// detection in the worker).
	ReceivedAt time.Time
}

// ShareSubmission is a found share submitted upstream.
type ShareSubmission struct {
	JobID      string
	Nonce      uint32
	NTime      uint32
	Version    uint32 // for ASIC Boost overt rolling, optional
	ExtraNonce []byte // protocol-specific
}

// ShareResult reports the pool's verdict on a submission.
type ShareResult struct {
	Accepted bool
	// Reason is empty on Accepted; on rejection a short human-readable
	// reason ("low-difficulty-share", "duplicate", "stale").
	Reason string
	// Difficulty is the actual share difficulty as computed by the
	// pool, when supplied; zero otherwise.
	Difficulty float64
}

// ----- Interfaces -----

// Connection is a transport to a pool, established but not yet
// authenticated. Closing terminates the underlying socket.
type Connection interface {
	io.Closer

	// RemoteAddr returns the host:port of the pool.
	RemoteAddr() string

	// Protocol identifies the negotiated protocol after handshake.
	// Before handshake, returns ProtocolUnknown.
	Protocol() ProtocolID
}

// Session is an authenticated mining channel. One Connection may host
// multiple Sessions in protocols that support it (SV2 mining channels);
// SV1 has a 1:1 mapping.
type Session interface {
	io.Closer

	// Jobs returns a channel that delivers jobs from the pool. The
	// channel is closed when the session ends; ranging over it is the
	// idiomatic worker loop.
	Jobs() <-chan Job

	// Submit sends a share upstream and returns the pool's verdict.
	// The context controls the wait for the verdict; on expiry the
	// share is considered submitted but unconfirmed.
	Submit(ctx context.Context, sub ShareSubmission) (ShareResult, error)

	// SuggestedDifficulty returns the current target difficulty, used
	// for filtering shares before submission. Updates atomically as
	// the pool changes difficulty.
	SuggestedDifficulty() float64
}

// PoolNoticeReceiver is an optional extension to Session implemented by
// protocols that deliver human-readable operator notices (e.g.
// client.show_message in Stratum V1). Callers should type-assert a
// Session to this interface; protocols that do not implement it have no
// notice channel.
//
// The returned channel is closed when the Session ends. A nil channel
// means no notices will ever be delivered.
type PoolNoticeReceiver interface {
	// PoolNotices returns a channel on which pool-sent notices are delivered.
	// Messages are non-empty UTF-8 strings. The channel is buffered; a slow
	// consumer causes notices to be dropped silently rather than blocking
	// the read loop.
	PoolNotices() <-chan string
}

// ReconnectWaiter is implemented by sessions whose protocol supports a
// pool-directed reconnect delay (client.reconnect's wait_seconds in
// Stratum V1). Callers should type-assert a Session to this interface;
// protocols without the concept are simply absent. The returned duration
// is already clamped by the implementation — never negative, capped to a
// sane ceiling — so a hostile pool cannot hang the caller indefinitely.
type ReconnectWaiter interface {
	// ReconnectWait reports how long the pool asked us to pause before
	// reconnecting. Zero means no directive was received (or it carried
	// no wait field).
	ReconnectWait() time.Duration
}

// DifficultyWatcher is an optional extension to Session implemented by
// protocols that deliver mid-session difficulty retargets as discrete
// events (mining.set_difficulty in Stratum V1). Callers should
// type-assert a Session to this interface; protocols without the
// concept are simply absent.
//
// The returned channel is closed when the Session ends. A nil channel
// means no updates will ever be delivered. Values are the session's
// current SuggestedDifficulty at the moment of the retarget — the
// caller should treat each delivery as a hint to re-check, not as an
// authoritative stream (consecutive equal values are possible).
type DifficultyWatcher interface {
	// DifficultyUpdates returns a channel on which pool-assigned
	// difficulty changes are delivered. The channel is buffered and
	// coalesces: a slow consumer sees at most the most recent value.
	DifficultyUpdates() <-chan float64
}

// Dialer establishes a Connection to a pool. Different protocols
// register different Dialers; the registry maps URL schemes to
// implementations.
type Dialer interface {
	// Protocol returns the protocol this dialer handles.
	Protocol() ProtocolID

	// Dial opens a Connection. The url is the full pool URL; the
	// dialer parses scheme and host:port from it.
	Dial(ctx context.Context, url string, creds *Credentials) (Connection, error)

	// Negotiate performs the protocol handshake on an established
	// Connection. On success the Connection's Protocol() returns the
	// concrete negotiated protocol.
	Negotiate(ctx context.Context, conn Connection) (Session, error)
}

// Credentials carries authentication material to the pool.
type Credentials struct {
	// User is the worker name or Bitcoin address (pool-dependent).
	User string

	// Password is the pool password, often "x" or empty.
	Password string

	// PoolPubKey is the pool's static public key (SV2 Noise NX). For
	// pinning. Empty disables pinning (SV1, or trust-on-first-use).
	PoolPubKey []byte

	// TLSRootCAsPEM is an optional PEM bundle of additional certificate
	// authorities to trust for a stratum+tls:// connection, on top of the
	// system root store. It lets a private-CA or self-signed pool be verified
	// instead of failing. Empty means "system roots only". It never disables
	// verification.
	TLSRootCAsPEM []byte
}

// ----- Registry -----

var (
	registryMu sync.RWMutex
	registry   = map[ProtocolID]Dialer{}
)

// Register adds a Dialer to the registry. Called from init() in each
// protocol implementation package.
func Register(d Dialer) {
	if d == nil {
		panic("poolproto: Register called with nil Dialer")
	}
	id := d.Protocol()
	if id == ProtocolUnknown {
		panic("poolproto: Dialer returned ProtocolUnknown")
	}
	registryMu.Lock()
	defer registryMu.Unlock()
	if _, dup := registry[id]; dup {
		panic(fmt.Sprintf("poolproto: protocol %q already registered", id))
	}
	registry[id] = d
}

// Lookup returns the Dialer for a protocol, or ErrUnknownProtocol if
// none is registered. Implementations may not be linked in (SV2 is
// behind a build tag in some configurations).
func Lookup(id ProtocolID) (Dialer, error) {
	registryMu.RLock()
	defer registryMu.RUnlock()
	d, ok := registry[id]
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrUnknownProtocol, id)
	}
	return d, nil
}

// Available returns the list of protocols with registered Dialers in
// this build. Useful for `otedama doctor` and config validation.
func Available() []ProtocolID {
	registryMu.RLock()
	defer registryMu.RUnlock()
	out := make([]ProtocolID, 0, len(registry))
	for id := range registry {
		out = append(out, id)
	}
	return out
}

// DialURL is the high-level entry point: identify the protocol from
// the URL, look up its Dialer, dial, and negotiate. Returns the
// resulting Session ready to receive jobs.
func DialURL(ctx context.Context, url string, creds *Credentials) (Session, error) {
	proto := FromURL(url)
	if proto == ProtocolUnknown {
		return nil, fmt.Errorf("%w: cannot infer protocol from %q", ErrUnknownProtocol, url)
	}
	dialer, err := Lookup(proto)
	if err != nil {
		return nil, err
	}
	conn, err := dialer.Dial(ctx, url, creds)
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", url, err)
	}
	sess, err := dialer.Negotiate(ctx, conn)
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("negotiate %s: %w", url, err)
	}
	return sess, nil
}

// ----- Errors -----

var (
	// ErrUnknownProtocol is returned when a URL scheme cannot be
	// mapped to a registered Dialer.
	ErrUnknownProtocol = errors.New("poolproto: unknown protocol")

	// ErrHandshakeFailed wraps protocol-specific handshake errors.
	ErrHandshakeFailed = errors.New("poolproto: handshake failed")

	// ErrShareRejected is returned for hard share rejections (vs
	// soft rejections that come back inside ShareResult).
	ErrShareRejected = errors.New("poolproto: share rejected")
)

// maxPoolTextRunes caps sanitized pool-controlled text. Pool strings end
// up in logs (and potentially the TUI); an unbounded string is a
// log-flooding vector.
const maxPoolTextRunes = 256

// unsafePoolRune reports whether r must be stripped from display and log
// text: Cc control characters (C0, DEL, C1 — including ANSI escape
// introducers), Cf format characters (bidi overrides U+202A–U+202E and
// U+2066–U+2069, zero-width spaces/joiners, tag characters U+E0000+ —
// the Trojan Source class, CWE-838), and Zl/Zp line/paragraph
// separators that forge extra log lines without being Cc.
func unsafePoolRune(r rune) bool {
	return unicode.In(r, unicode.Cc, unicode.Cf, unicode.Zl, unicode.Zp)
}

// SanitizePoolText removes characters unsafePoolRune rejects from
// pool-controlled text and truncates it to 256 runes. Callers use it
// before logging or rendering any string the pool supplied
// (share-reject reasons, error objects, job IDs), so escape sequences
// cannot manipulate the terminal or forge log lines.
func SanitizePoolText(s string) string {
	clean := strings.Map(func(r rune) rune {
		if unsafePoolRune(r) {
			return -1
		}
		return r
	}, s)
	runes := []rune(clean)
	if len(runes) > maxPoolTextRunes {
		clean = string(runes[:maxPoolTextRunes])
	}
	return clean
}
