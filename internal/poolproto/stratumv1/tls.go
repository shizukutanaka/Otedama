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
	"net"
)

// defaultTLSConfig is the secure baseline for stratum+tls:// connections:
// verify the pool's certificate against the system root store and require
// TLS 1.2 or newer. The ServerName (for SNI and certificate hostname
// verification) is filled in by crypto/tls from the dial address when left
// empty here, so each connection verifies against the host it dialed.
func defaultTLSConfig() *tls.Config {
	return &tls.Config{MinVersion: tls.VersionTLS12}
}

// dialTLS opens a certificate-verified TLS connection to address. When cfg is
// nil the secure default is used. It performs the TLS handshake before
// returning (tls.Dialer.DialContext blocks until the handshake completes), so
// a verification failure surfaces here as an error rather than on first write.
// It never falls back to plaintext.
func dialTLS(ctx context.Context, address string, cfg *tls.Config) (net.Conn, error) {
	if cfg == nil {
		cfg = defaultTLSConfig()
	}
	dialer := &tls.Dialer{Config: cfg}
	return dialer.DialContext(ctx, "tcp", address)
}
