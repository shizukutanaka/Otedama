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
)

// defaultTLSConfig is the secure baseline for stratum+tls:// connections:
// verify the pool's certificate against the system root store and require
// TLS 1.2 or newer. The ServerName (for SNI and certificate hostname
// verification) is filled in by crypto/tls from the dial address when left
// empty here, so each connection verifies against the host it dialed.
func defaultTLSConfig() *tls.Config {
	return &tls.Config{MinVersion: tls.VersionTLS12}
}

// tlsConfigWithExtraCAs returns a TLS config that trusts the system root store
// plus the given PEM certificate authorities. It is used for pools that present
// a private-CA or self-signed certificate: the extra CAs let the certificate be
// verified rather than rejected, while verification itself stays enabled. A nil
// or empty pem yields (nil, nil) so the caller uses the secure default.
//
// If the platform's SystemCertPool is unavailable (an error or nil — rare, but
// possible on minimal containers and some non-mainstream platforms), the
// returned pool contains ONLY the supplied PEM CAs, not "system roots + PEM".
// That narrows trust rather than widening it, so it fails closed: a publicly-
// signed pool certificate is then rejected (a visible dial error) rather than
// silently accepted under an unexpected trust set.
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

// connectTimeout bounds the TCP connect phase — a black-holed endpoint
// otherwise fails only at the OS TCP timeout (~minutes). The TLS
// handshake gets a child-context bound of twice that inside dialTLS.
var connectTimeout = 15 * time.Second

// dialTLS opens a certificate-verified TLS connection to address. When cfg is
// nil the secure default is used. It performs the TLS handshake before
// returning (tls.Dialer.DialContext blocks until the handshake completes), so
// a verification failure surfaces here as an error rather than on first write.
// It never falls back to plaintext.
func dialTLS(ctx context.Context, address string, cfg *tls.Config) (net.Conn, error) {
	if cfg == nil {
		cfg = defaultTLSConfig()
	}
	// Bound the handshake: a server that completes TCP connect but stalls
	// mid-TLS must fail within the connect budget, not at ctx's end. The
	// child ctx is safe to cancel on return — unlike a poolproto Session
	// ctx, nothing retains it.
	dctx, cancel := context.WithTimeout(ctx, connectTimeout*2)
	defer cancel()
	dialer := &tls.Dialer{
		Config:    cfg,
		NetDialer: &net.Dialer{Timeout: connectTimeout},
	}
	return dialer.DialContext(dctx, "tcp", address)
}
