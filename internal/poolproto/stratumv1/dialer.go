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
// dialer). Credentials are stashed on the returned Connection so that
// Negotiate can use them without requiring a second credentials argument.
func (d *Dialer) Dial(ctx context.Context, url string, creds poolproto.Credentials) (poolproto.Connection, error) {
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
		creds:      creds,
	}, nil
}

// Negotiate performs the SV1 handshake: mining.subscribe (extranonce
// negotiation) followed by mining.authorize (worker authentication).
// On success the returned Session is ready to deliver Jobs and accept
// shares. A failed authorize terminates the connection and returns
// poolproto.ErrHandshakeFailed.
func (d *Dialer) Negotiate(ctx context.Context, c poolproto.Connection) (poolproto.Session, error) {
	conn, ok := c.(*connection)
	if !ok {
		return nil, fmt.Errorf("stratumv1: Negotiate received non-V1 connection: %T", c)
	}

	sess := newSession(conn)
	sess.start(ctx)

	// Step 1: mining.subscribe — negotiate extranonce1 / extranonce2_size.
	id := sess.nextID.Add(1)
	resp, err := sess.call(ctx, id, "mining.subscribe", []any{"Otedama/3.0.0"})
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
	sess.extranonce1 = en1
	sess.extranonce2Size = en2Size

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

	return sess, nil
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
