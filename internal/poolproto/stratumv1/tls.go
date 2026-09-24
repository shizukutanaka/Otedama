// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package stratumv1 — tls.go
//
// TLS transport for the stratum+tls:// scheme. Previously the TLS Dialer
// variant was registered but Dial always opened a plaintext TCP connection —
// a silent downgrade that exposed worker traffic (including the payout address
// carried as the Stratum username) to any network eavesdropper while the
// operator believed the link was encrypted. dialTLS closes that hole: a TLS
// scheme now means an actual, certificate-verified TLS connection, or a clean
// error — never plaintext.
//
// This uses only crypto/tls from the standard library (no custom cryptography)
// and verifies the pool certificate against the system root store by default.

package stratumv1

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net"
	"time"

	"github.com/shizukutanaka/Otedama/internal/poolproto"
)

// defaultTLSConfig is the secure baseline for stratum+tls:// connections:
// verify the pool's certificate against the system root store and require
// TLS 1.2 or newer. ServerName is left empty here; dialTLS derives it
// from the dial address (tls.Client does not auto-fill it), so each
// connection verifies against the host it dialed.
func defaultTLSConfig() *tls.Config {
	return &tls.Config{MinVersion: tls.VersionTLS12}
}

// tlsConfigWithExtraCAs returns a TLS config that trusts the system root store
// plus the given PEM certificate authorities. It is used for pools that present
// a private-CA or self-signed certificate: the extra CAs let the certificate be
// verified rather than rejected, while verification itself stays enabled. A nil
// or empty pem yields (nil, nil) so the caller uses the secure default.
func tlsConfigWithExtraCAs(pem []byte) (*tls.Config, error) {
	if len(pem) == 0 {
		return nil, nil
	}
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		pool = x509.NewCertPool()
	}
	if !pool.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("stratumv1: tls_ca_file contains no valid PEM certificates")
	}
	return &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}, nil
}

// tlsHandshakeTimeout bounds the TLS handshake itself: net.Dialer.Timeout
// covers only the TCP connect phase, so without this a peer that accepts
// TCP then stalls mid-handshake could hold Dial open until the session
// context ends. A variable so tests can shorten it.
var tlsHandshakeTimeout = poolproto.DialConnectTimeout

// dialTLS opens a certificate-verified TLS connection to address. When cfg is
// nil the secure default is used. It performs the TLS handshake before
// returning (bounded by tlsHandshakeTimeout), so a verification failure
// surfaces here as an error rather than on first write. It never falls back
// to plaintext.
func dialTLS(ctx context.Context, address string, cfg *tls.Config) (net.Conn, error) {
	if cfg == nil {
		cfg = defaultTLSConfig()
	}
	raw, err := (&net.Dialer{Timeout: poolproto.DialConnectTimeout}).DialContext(ctx, "tcp", address)
	if err != nil {
		return nil, err
	}
	// tls.Client does not populate ServerName from the address (unlike
	// tls.Dial, which clones the config and fills it in). An empty
	// ServerName with verification on fails the handshake outright, so
	// derive it from the dial address on a clone — never mutate the
	// caller's config.
	if cfg.ServerName == "" {
		host, _, herr := net.SplitHostPort(address)
		if herr != nil {
			_ = raw.Close()
			return nil, fmt.Errorf("stratumv1: bad address %q: %w", address, herr)
		}
		cfg = cfg.Clone()
		cfg.ServerName = host
	}
	conn := tls.Client(raw, cfg)
	_ = conn.SetDeadline(time.Now().Add(tlsHandshakeTimeout))
	if err := conn.HandshakeContext(ctx); err != nil {
		_ = raw.Close()
		return nil, err
	}
	// Clear the handshake deadline: steady-state I/O uses the session's
	// per-read/per-write deadlines instead.
	_ = conn.SetDeadline(time.Time{})
	return conn, nil
}
