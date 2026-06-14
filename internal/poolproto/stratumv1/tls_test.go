// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package stratumv1

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"net"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/poolproto"
)

// newSelfSignedTLSListener starts a TLS listener on 127.0.0.1 with a freshly
// generated self-signed certificate, and returns the listener plus an x509
// pool that trusts it. The listener accepts connections and immediately closes
// them after the handshake — enough to verify the transport is TLS.
func newSelfSignedTLSListener(t *testing.T) (net.Listener, *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	tmpl := x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "otedama-test"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1")},
		IsCA:                  true,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create cert: %v", err)
	}
	cert := tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}

	pool := x509.NewCertPool()
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("parse cert: %v", err)
	}
	pool.AddCert(parsed)

	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS12,
	})
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			// Force the handshake then close.
			if tc, ok := c.(*tls.Conn); ok {
				_ = tc.HandshakeContext(context.Background())
			}
			_ = c.Close()
		}
	}()
	return ln, pool
}

func TestDialTLS_VerifiedHandshakeSucceeds(t *testing.T) {
	ln, pool := newSelfSignedTLSListener(t)
	defer ln.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	conn, err := dialTLS(ctx, ln.Addr().String(), &tls.Config{
		RootCAs:    pool,
		ServerName: "127.0.0.1",
		MinVersion: tls.VersionTLS12,
	})
	if err != nil {
		t.Fatalf("dialTLS with trusting config failed: %v", err)
	}
	defer conn.Close()

	tc, ok := conn.(*tls.Conn)
	if !ok {
		t.Fatalf("dialTLS returned %T, want *tls.Conn (connection is not encrypted)", conn)
	}
	if !tc.ConnectionState().HandshakeComplete {
		t.Error("TLS handshake did not complete")
	}
}

func TestDialTLS_DefaultConfigRejectsUntrustedCert(t *testing.T) {
	// The secure default verifies against the system roots, so a self-signed
	// certificate must be rejected. This proves verification is NOT disabled —
	// the whole point of using TLS rather than plaintext.
	ln, _ := newSelfSignedTLSListener(t)
	defer ln.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	conn, err := dialTLS(ctx, ln.Addr().String(), nil) // nil → secure default
	if err == nil {
		conn.Close()
		t.Fatal("dialTLS accepted an untrusted self-signed cert; certificate verification is not enforced")
	}
}

func TestDialer_UseTLSProducesEncryptedConnection(t *testing.T) {
	// End-to-end through the Dialer: the useTLS variant must open a *tls.Conn,
	// not a plaintext one (the silent-downgrade regression guard).
	ln, pool := newSelfSignedTLSListener(t)
	defer ln.Close()

	d := &Dialer{
		useTLS:    true,
		tlsConfig: &tls.Config{RootCAs: pool, ServerName: "127.0.0.1", MinVersion: tls.VersionTLS12},
	}
	if d.Protocol() != poolproto.ProtocolStratumV1TLS {
		t.Fatalf("Protocol() = %v, want ProtocolStratumV1TLS", d.Protocol())
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	c, err := d.Dial(ctx, "stratum+tls://"+ln.Addr().String(), poolproto.Credentials{User: "x"})
	if err != nil {
		t.Fatalf("Dial(stratum+tls) failed: %v", err)
	}
	defer c.Close()

	conn, ok := c.(*connection)
	if !ok {
		t.Fatalf("Dial returned %T, want *connection", c)
	}
	if _, ok := conn.raw.(*tls.Conn); !ok {
		t.Errorf("underlying transport is %T, want *tls.Conn (TLS scheme must not downgrade to plaintext)", conn.raw)
	}
}
