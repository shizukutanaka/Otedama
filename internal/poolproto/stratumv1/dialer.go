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
	"fmt"
	"net"
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

	// useTLS is true for the stratum+tls:// scheme variant. Reserved
	// for the TLS implementation in tls.go (not yet shipped).
	useTLS bool
}

// Protocol identifies which scheme this Dialer handles.
func (d *Dialer) Protocol() poolproto.ProtocolID {
	if d.useTLS {
		return poolproto.ProtocolStratumV1TLS
	}
	return poolproto.ProtocolStratumV1
}

// Dial opens a TCP connection to the pool. The URL must be of the form
// stratum+tcp://host:port (or stratum+tls://host:port for the TLS
// dialer).
func (d *Dialer) Dial(ctx context.Context, url string, _ poolproto.Credentials) (poolproto.Connection, error) {
	address, err := parseAddress(url)
	if err != nil {
		return nil, err
	}
	dialFn := d.dialFn
	if dialFn == nil {
		dialFn = func(ctx context.Context, address string) (net.Conn, error) {
			var dialer net.Dialer
			return dialer.DialContext(ctx, "tcp", address)
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
	}, nil
}

// Negotiate performs the SV1 handshake (mining.subscribe + mining.authorize).
// On success a Session is returned that delivers Jobs and accepts shares.
func (d *Dialer) Negotiate(ctx context.Context, c poolproto.Connection) (poolproto.Session, error) {
	conn, ok := c.(*connection)
	if !ok {
		return nil, fmt.Errorf("stratumv1: Negotiate received non-V1 connection: %T", c)
	}
	// We don't have credentials at Negotiate time — they live on the
	// session. The expected flow from poolproto.DialURL passes
	// credentials through Dial; we stash them on the connection.
	// For now Negotiate is called with an already-authenticated
	// connection, so we initialise the session and start the read loop.
	sess := newSession(conn)
	sess.start(ctx)
	return sess, nil
}

// ----- connection -----

// connection wraps a net.Conn with stratum-specific framing (newline-
// delimited JSON) and the negotiated protocol identity.
type connection struct {
	raw        net.Conn
	remoteAddr string
	protocol   poolproto.ProtocolID

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
