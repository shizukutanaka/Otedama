// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package stratumv1 — dialer.go
//
// The Dialer (poolproto.Dialer implementation) and the connection
// wrapper. Separated from stratumv1.go so that file can focus on the
// session lifecycle and message dispatch. Registration happens in
// stratumv1.go's init().
package stratumv1

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"strconv"
	"sync"
	"sync/atomic"

	"github.com/shizukutanaka/Otedama/internal/poolproto"
)

// ----- Public registration -----

// Dialer is the V1 implementation of poolproto.Dialer. It is registered
// at package init time for both plaintext and TLS variants; users never
// instantiate it directly.
type Dialer struct {
	// dialFn is the underlying network dialer. Override in tests to
	// inject net.Pipe()-based fake transports.
	dialFn func(ctx context.Context, address string) (net.Conn, error)

	// useTLS is true for the stratum+tls:// scheme variant: Dial then opens a
	// certificate-verified TLS connection (see tls.go) instead of plaintext.
	useTLS bool

	// datum is true for the datum:// scheme variant: OCEAN's DATUM
	// Gateway speaks plain Stratum V1 over TCP (verified against the
	// gateway README, session 251 — miners connect via SV1 + version-
	// rolling; the gateway does NOT speak SV2), so the scheme maps onto
	// this same dialer and only differs in the ProtocolID it reports.
	datum bool

	// tlsConfig overrides the TLS settings used when useTLS is true. nil means
	// the secure default (verify against the system roots, TLS 1.2+). Exposed
	// for tests to trust a self-signed certificate; production leaves it nil.
	tlsConfig *tls.Config
}

// Protocol identifies which scheme this Dialer handles.
func (d *Dialer) Protocol() poolproto.ProtocolID {
	if d.datum {
		return poolproto.ProtocolDATUM
	}
	if d.useTLS {
		return poolproto.ProtocolStratumV1TLS
	}
	return poolproto.ProtocolStratumV1
}

// dialTCP is the default transport for stratum+tcp:// / datum:// pools.
// poolproto.DialConnectTimeout bounds the connect phase so a blackholed
// pool fails over in seconds rather than the OS TCP timeout (minutes).
func dialTCP(ctx context.Context, address string) (net.Conn, error) {
	dialer := net.Dialer{Timeout: poolproto.DialConnectTimeout}
	return dialer.DialContext(ctx, "tcp", address)
}

// Dial opens a TCP connection to the pool. The URL must be of the form
// stratum+tcp://host:port (or stratum+tls://host:port for the TLS
// dialer). Credentials are stashed on the returned Connection so that
// Negotiate can use them without requiring a second credentials argument.
func (d *Dialer) Dial(ctx context.Context, url string, creds poolproto.Credentials) (poolproto.Connection, error) {
	address, err := parseAddress(url)
	if err != nil {
		return nil, err
	}
	dialFn := d.dialFn
	if dialFn == nil {
		if d.useTLS {
			// Precedence: an explicit test-injected config wins; otherwise build
			// one from any per-pool CA bundle the caller supplied; otherwise nil
			// (secure default — system roots only). Verification is always on.
			cfg := d.tlsConfig
			if cfg == nil {
				c, err := tlsConfigWithExtraCAs(creds.TLSRootCAsPEM)
				if err != nil {
					return nil, err
				}
				cfg = c
			}
			dialFn = func(ctx context.Context, address string) (net.Conn, error) {
				return dialTLS(ctx, address, cfg)
			}
		} else {
			dialFn = dialTCP
		}
	}
	conn, err := dialFn(ctx, address)
	if err != nil {
		return nil, fmt.Errorf("stratumv1: dial %s: %w", address, err)
	}

	return &connection{
		raw:        conn,
		remoteAddr: address,
		protocol:   d.Protocol(),
		creds:      creds,
	}, nil
}

// Negotiate performs the SV1 handshake:
//  1. mining.subscribe — extranonce negotiation.
//  2. mining.authorize — worker authentication.
//  3. extranonce.subscribe (optional) — announce support for mid-session
//     extranonce rotation. Pools that support it will push new extranonce
//     values via mining.set_extranonce without requiring a reconnect. Pools
//     that do not support it (OCEAN, older Antpool, etc.) respond with
//     "Method not found"; we treat that as informational and proceed. This
//     response is correlated by JSON-RPC id and handled here — it never
//     reaches rejectClass or the share counters (fixing ESP-Miner #1383).
//
// On success the returned Session is ready to deliver Jobs and accept shares.
// A failed mandatory step (subscribe/authorize) terminates the connection and
// returns poolproto.ErrHandshakeFailed.
func (d *Dialer) Negotiate(ctx context.Context, c poolproto.Connection) (poolproto.Session, error) {
	conn, ok := c.(*connection)
	if !ok {
		return nil, fmt.Errorf("stratumv1: Negotiate received non-V1 connection: %T", c)
	}

	sess := newSession(conn)
	sess.start(ctx)

	// Step 1: mining.subscribe — negotiate extranonce1 / extranonce2_size.
	// params[2] advertises the "xnsub" extension flag (NiceHash family):
	// pools honouring it enable mining.set_extranonce pushes without the
	// separate extranonce.subscribe call, which we also send in step 3.
	id := sess.nextID.Add(1)
	resp, err := sess.call(ctx, id, "mining.subscribe", []any{clientAgent, nil, "xnsub"})
	if err != nil {
		_ = sess.Close()
		return nil, fmt.Errorf("stratumv1: subscribe: %w", err)
	}
	if resp.errResult != nil {
		_ = sess.Close()
		return nil, fmt.Errorf("%w: subscribe rejected: %v", poolproto.ErrHandshakeFailed, resp.errResult)
	}
	en1, en2Size, err := parseSubscribeResult(resp.result)
	if err != nil {
		_ = sess.Close()
		return nil, fmt.Errorf("%w: %v", poolproto.ErrHandshakeFailed, err)
	}
	sess.enMu.Lock()
	sess.extranonce1 = en1
	sess.extranonce2Size = en2Size
	sess.enMu.Unlock()

	// Step 2: mining.authorize — authenticate the worker.
	user := conn.creds.User
	password := conn.creds.Password
	if password == "" {
		password = "x" // most pools accept "x" as the password
	}
	id = sess.nextID.Add(1)
	resp, err = sess.call(ctx, id, "mining.authorize", []any{user, password})
	if err != nil {
		_ = sess.Close()
		return nil, fmt.Errorf("stratumv1: authorize: %w", err)
	}
	if resp.errResult != nil {
		_ = sess.Close()
		return nil, fmt.Errorf("%w: authorization rejected: %v", poolproto.ErrHandshakeFailed, resp.errResult)
	}
	if accepted, _ := resp.result.(bool); !accepted {
		_ = sess.Close()
		return nil, fmt.Errorf("%w: worker not authorized", poolproto.ErrHandshakeFailed)
	}

	// Step 3 (optional): mining.configure — negotiate the
	// version-rolling extension. Sent after authorize: extension
	// negotiation is permitted at any point before mining.
	sess.configureVersionRolling(ctx)

	// Step 4 (optional): extranonce.subscribe — announce that we handle
	// mining.set_extranonce notifications. Write errors (connection dropped)
	// and pool-level errors ("Method not found") both mean the pool does not
	// support extranonce rotation; we proceed without it. A network error here
	// does NOT close the session — the mandatory steps succeeded, so the
	// session is in a valid state and the engine will detect stale connections
	// through the normal Jobs-channel lifecycle.
	id = sess.nextID.Add(1)
	if _, eerr := sess.call(ctx, id, "extranonce.subscribe", []any{}); eerr != nil {
		// Write failed (connection closed) or context expired: proceed without
		// extranonce rotation — not a fatal condition.
		_ = eerr
	}
	// resp.errResult ("Method not found") is also silently ignored here.

	return sess, nil
}

// configureVersionRolling offers the version-rolling extension via
// mining.configure (the cgminer/ESP-Miner convention: mask 1fffe000,
// min-bit-count 2). Pools that don't implement the method answer
// -32601 or fail the call — both ignored since the extension is
// opt-in.
func (s *session) configureVersionRolling(ctx context.Context) {
	id := s.nextID.Add(1)
	resp, err := s.call(ctx, id, "mining.configure",
		[]any{
			[]string{"version-rolling"},
			map[string]any{
				"version-rolling.mask":          "1fffe000",
				"version-rolling.min-bit-count": 2,
			},
		})
	if err != nil || resp.errResult != nil {
		return
	}
	res, ok := resp.result.(map[string]any)
	if !ok {
		return
	}
	if en, _ := res["version-rolling"].(bool); !en {
		return
	}
	s.versionRolling.Store(true)
	if hexMask, _ := res["version-rolling.mask"].(string); hexMask != "" {
		if v, perr := strconv.ParseUint(hexMask, 16, 32); perr == nil {
			s.versionMask.Store(uint32(v))
		}
	}
}

// ----- connection -----

// connection wraps a net.Conn with stratum-specific framing (newline-
// delimited JSON) and the negotiated protocol identity.
type connection struct {
	raw        net.Conn
	remoteAddr string
	protocol   poolproto.ProtocolID
	creds      poolproto.Credentials // stashed from Dial for use in Negotiate

	closeOnce sync.Once
	closed    atomic.Bool
}

// RemoteAddr returns the host:port of the pool.
func (c *connection) RemoteAddr() string { return c.remoteAddr }

// Protocol returns the negotiated protocol.
func (c *connection) Protocol() poolproto.ProtocolID { return c.protocol }

// Close terminates the underlying TCP connection. Idempotent.
func (c *connection) Close() error {
	var err error
	c.closeOnce.Do(func() {
		c.closed.Store(true)
		err = c.raw.Close()
	})
	return err
}

// Compile-time interface satisfaction checks.
var (
	_ poolproto.Dialer     = (*Dialer)(nil)
	_ poolproto.Connection = (*connection)(nil)
)
