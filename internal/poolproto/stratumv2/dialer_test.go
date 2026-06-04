// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package stratumv2

import (
	"context"
	"net"
	"testing"

	"github.com/shizukutanaka/Otedama/internal/poolproto"
)

func TestDialer_Protocol(t *testing.T) {
	plain := &Dialer{}
	if got := plain.Protocol(); got != poolproto.ProtocolStratumV2 {
		t.Errorf("plaintext Protocol() = %q, want %q", got, poolproto.ProtocolStratumV2)
	}
	tls := &Dialer{useTLS: true}
	if got := tls.Protocol(); got != poolproto.ProtocolStratumV2TLS {
		t.Errorf("TLS Protocol() = %q, want %q", got, poolproto.ProtocolStratumV2TLS)
	}
}

func TestDialer_Dial_ParsesScheme(t *testing.T) {
	// Use an injected dialFn so no real network is touched. We only
	// verify that the scheme is stripped and the host is passed through.
	var gotAddress string
	d := &Dialer{
		dialFn: func(_ context.Context, address string) (net.Conn, error) {
			gotAddress = address
			c1, _ := net.Pipe()
			return c1, nil
		},
	}
	conn, err := d.Dial(context.Background(),
		"stratum+v2://pool.example.com:3336",
		poolproto.Credentials{User: "alice"})
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer conn.Close()

	if gotAddress != "pool.example.com:3336" {
		t.Errorf("dial address = %q, want pool.example.com:3336", gotAddress)
	}
	if conn.RemoteAddr() != "pool.example.com:3336" {
		t.Errorf("RemoteAddr() = %q", conn.RemoteAddr())
	}
	if conn.Protocol() != poolproto.ProtocolStratumV2 {
		t.Errorf("Protocol() = %q", conn.Protocol())
	}
}

func TestDialer_Dial_RejectsUnknownScheme(t *testing.T) {
	d := &Dialer{}
	_, err := d.Dial(context.Background(), "http://example.com", poolproto.Credentials{})
	if err == nil {
		t.Error("Dial with non-stratum scheme should fail")
	}
}

func TestDialer_RegisteredInRegistry(t *testing.T) {
	// init() registers both the plaintext and TLS V2 dialers. Verify
	// poolproto can look them up by protocol.
	for _, proto := range []poolproto.ProtocolID{
		poolproto.ProtocolStratumV2,
		poolproto.ProtocolStratumV2TLS,
	} {
		d, err := poolproto.Lookup(proto)
		if err != nil {
			t.Errorf("Lookup(%q) failed: %v", proto, err)
			continue
		}
		if d.Protocol() != proto {
			t.Errorf("Lookup(%q) returned dialer for %q", proto, d.Protocol())
		}
	}
}

func TestParseJobID(t *testing.T) {
	cases := map[string]uint32{
		"0":     0,
		"1":     1,
		"42":    42,
		"65535": 65535,
		"bad":   0, // unparseable → 0
	}
	for in, want := range cases {
		if got := parseJobID(in); got != want {
			t.Errorf("parseJobID(%q) = %d, want %d", in, got, want)
		}
	}
}
