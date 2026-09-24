// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package stratum — tls.go
//
// TLS transport for the stratum+v2tls:// scheme. Previously the engine's
// Stratum V2 session loop dialed every non-V1 pool URL with a plain
// net.Dialer regardless of scheme, so a stratum+v2tls:// pool silently
// connected in plaintext — a configured "TLS" pool gave no transport
// security at all, and the operator had no way to tell (see
// docs/KNOWN_LIMITATIONS.md §2). DialTLS closes that hole: the v2tls
// scheme now means an actual, certificate-verified TLS connection, or a
// clean error — never a silent plaintext downgrade. This mirrors the
// identical fix already applied to internal/poolproto/stratumv1's
// stratum+tls:// scheme (see that package's tls.go).
//
// This uses only crypto/tls from the standard library (no custom
// cryptography) and verifies the pool certificate against the system
// root store by default, per CLAUDE.md's "no self-rolled crypto" rule.
package stratum

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net"
	"time"
)

// dialConnectTimeout bounds the TCP connect phase; mirrors
// poolproto.DialConnectTimeout. It is kept local because stratum
// deliberately sits below poolproto in the dependency graph.
const dialConnectTimeout = 15 * time.Second

// defaultTLSConfig is the secure baseline for stratum+v2tls://
// connections: verify the pool's certificate against the system root
// store and require TLS 1.2 or newer. ServerName is left empty so
// crypto/tls fills it in from the dial address, verifying against the
// host actually dialed.
func defaultTLSConfig() *tls.Config {
	return &tls.Config{MinVersion: tls.VersionTLS12}
}

// TLSConfigWithExtraCAs returns a TLS config that trusts the system root
// store plus the given PEM certificate authorities, for pools presenting
// a private-CA or self-signed certificate. Verification itself stays
// enabled — the extra CAs let it succeed rather than disabling it. A nil
// or empty pem yields (nil, nil) so the caller falls back to the secure
// default.
func TLSConfigWithExtraCAs(pem []byte) (*tls.Config, error) {
	if len(pem) == 0 {
		return nil, nil
	}
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		pool = x509.NewCertPool()
	}
	if !pool.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("stratum: tls_ca_file contains no valid PEM certificates")
	}
	return &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}, nil
}

// tlsHandshakeTimeout bounds the TLS handshake itself: net.Dialer.Timeout
// covers only the TCP connect phase, so without this a peer that accepts
// TCP then stalls mid-handshake could hold Dial open until the session
// context ends. A variable so tests can shorten it.
var tlsHandshakeTimeout = dialConnectTimeout

// DialTLS opens a certificate-verified TLS connection to address. When
// cfg is nil the secure default is used. It performs the TLS handshake
// before returning (bounded by tlsHandshakeTimeout), so a verification
// failure surfaces here as an error rather than on first write. It never
// falls back to plaintext.
func DialTLS(ctx context.Context, address string, cfg *tls.Config) (net.Conn, error) {
	if cfg == nil {
		cfg = defaultTLSConfig()
	}
	raw, err := (&net.Dialer{Timeout: dialConnectTimeout}).DialContext(ctx, "tcp", address)
	if err != nil {
		return nil, err
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
