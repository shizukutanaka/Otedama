// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package stratumv1

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/poolproto"
)

// A pool that accepts the connection but never answers subscribe must not
// wedge Negotiate — the handshake timeout fires instead of the steady-state
// 5-minute per-line deadline.
func TestNegotiate_HandshakeTimeout(t *testing.T) {
	prev := handshakeTimeout
	handshakeTimeout = 50 * time.Millisecond
	defer func() { handshakeTimeout = prev }()

	server, client := net.Pipe()
	defer server.Close()
	defer client.Close()
	// Drain the client's writes; never respond.
	go func() {
		buf := make([]byte, 4096)
		for {
			if _, err := server.Read(buf); err != nil {
				return
			}
		}
	}()

	d := &Dialer{}
	conn := &connection{
		raw: client, remoteAddr: "pool.invalid:3333",
		protocol: poolproto.ProtocolStratumV1,
		creds:    poolproto.Credentials{User: "w.user"},
	}
	start := time.Now()
	_, err := d.Negotiate(context.Background(), conn)
	if err == nil {
		t.Fatal("expected handshake timeout error, got nil")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error = %v, want context deadline", err)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("handshake took %v, want < 5s", elapsed)
	}
}
