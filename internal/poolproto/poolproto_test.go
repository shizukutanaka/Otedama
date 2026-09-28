// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package poolproto

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// ============================================================================
// FromURL — protocol detection from URL scheme
// ============================================================================

func TestFromURL_StandardSchemes(t *testing.T) {
	tests := map[string]ProtocolID{
		"stratum+tcp://pool.example.com:3333":   ProtocolStratumV1,
		"stratum+tls://pool.example.com:3334":   ProtocolStratumV1TLS,
		"stratum+v2://pool.example.com:3336":    ProtocolStratumV2,
		"stratum+v2tls://pool.example.com:3336": ProtocolStratumV2TLS,
		"datum://ocean.xyz:3334":                ProtocolDATUM,
		"http://pool.example.com":               ProtocolUnknown,
		"":                                      ProtocolUnknown,
	}
	for url, want := range tests {
		if got := FromURL(url); got != want {
			t.Errorf("FromURL(%q) = %q, want %q", url, got, want)
		}
	}
}

func TestFromURL_CaseSensitive(t *testing.T) {
	// FromURL is case-sensitive (per HTTP-URL convention; pools always
	// advertise lowercase). Document this by test.
	if got := FromURL("STRATUM+TCP://pool.example.com:3333"); got != ProtocolUnknown {
		t.Errorf("FromURL uppercase = %q, want ProtocolUnknown (case-sensitive)", got)
	}
}

// ============================================================================
// ProtocolID.PostQuantumReady — anticipates BIP-360 era
// ============================================================================

func TestPostQuantumReady_AllCurrentProtocolsReturnFalse(t *testing.T) {
	// 2026: no production pool protocol negotiates a PQ-hybrid handshake.
	// This test will need updating when an SV2 PQ extension ships.
	for _, id := range []ProtocolID{
		ProtocolStratumV1,
		ProtocolStratumV1TLS,
		ProtocolStratumV2,
		ProtocolStratumV2TLS,
		ProtocolDATUM,
	} {
		if id.PostQuantumReady() {
			t.Errorf("%q.PostQuantumReady() = true, want false (no PQ pool protocol exists in 2026)", id)
		}
	}
}

// ============================================================================
// Register / Lookup / Available — registry contract
// ============================================================================

// stubDialer is a minimal Dialer for registry testing.
type stubDialer struct {
	id ProtocolID
}

func (d *stubDialer) Protocol() ProtocolID { return d.id }

func (d *stubDialer) Dial(_ context.Context, _ string, _ Credentials) (Connection, error) {
	return nil, errors.New("stub: Dial not implemented")
}

func (d *stubDialer) Negotiate(_ context.Context, _ Connection) (Session, error) {
	return nil, errors.New("stub: Negotiate not implemented")
}

// withTestRegistry replaces the package-level registry with a fresh empty
// map for the duration of the test, restoring on cleanup. This isolates
// tests from each other and from production registrations (init() calls).
func withTestRegistry(t *testing.T) {
	t.Helper()
	registryMu.Lock()
	saved := registry
	registry = map[ProtocolID]Dialer{}
	registryMu.Unlock()
	t.Cleanup(func() {
		registryMu.Lock()
		registry = saved
		registryMu.Unlock()
	})
}

func TestRegister_BasicSuccess(t *testing.T) {
	withTestRegistry(t)

	d := &stubDialer{id: "test-proto"}
	Register(d)

	got, err := Lookup("test-proto")
	if err != nil {
		t.Fatalf("Lookup after Register: %v", err)
	}
	if got != d {
		t.Errorf("Lookup returned %v, want %v", got, d)
	}
}

func TestRegister_NilDialerPanics(t *testing.T) {
	withTestRegistry(t)
	defer func() {
		if r := recover(); r == nil {
			t.Error("Register(nil) did not panic")
		}
	}()
	Register(nil)
}

func TestRegister_UnknownProtocolPanics(t *testing.T) {
	withTestRegistry(t)
	defer func() {
		if r := recover(); r == nil {
			t.Error("Register with ProtocolUnknown did not panic")
		}
	}()
	Register(&stubDialer{id: ProtocolUnknown})
}

func TestRegister_DuplicatePanics(t *testing.T) {
	withTestRegistry(t)

	Register(&stubDialer{id: "dup-proto"})

	defer func() {
		if r := recover(); r == nil {
			t.Error("duplicate Register did not panic")
		}
	}()
	Register(&stubDialer{id: "dup-proto"})
}

func TestLookup_UnknownReturnsError(t *testing.T) {
	withTestRegistry(t)

	_, err := Lookup("nonexistent")
	if !errors.Is(err, ErrUnknownProtocol) {
		t.Errorf("err = %v, want ErrUnknownProtocol", err)
	}
}

func TestAvailable_EmptyRegistryReturnsEmpty(t *testing.T) {
	withTestRegistry(t)

	got := Available()
	if len(got) != 0 {
		t.Errorf("Available on empty registry returned %v, want []", got)
	}
}

func TestAvailable_ListsRegisteredProtocols(t *testing.T) {
	withTestRegistry(t)

	Register(&stubDialer{id: "alpha"})
	Register(&stubDialer{id: "beta"})
	Register(&stubDialer{id: "gamma"})

	got := Available()
	if len(got) != 3 {
		t.Errorf("got %d protocols, want 3", len(got))
	}
	// Order is not guaranteed; verify set membership.
	seen := make(map[ProtocolID]bool, len(got))
	for _, id := range got {
		seen[id] = true
	}
	for _, want := range []ProtocolID{"alpha", "beta", "gamma"} {
		if !seen[want] {
			t.Errorf("Available missing %q", want)
		}
	}
}

// ============================================================================
// Concurrent registry access — required for go test -race cleanliness
// ============================================================================

func TestRegistry_ConcurrentLookupSafe(t *testing.T) {
	withTestRegistry(t)

	Register(&stubDialer{id: "concurrent"})

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 200; j++ {
				_, _ = Lookup("concurrent")
				_ = Available()
			}
		}()
	}
	wg.Wait()
}

// ============================================================================
// DialURL — the high-level entry point
// ============================================================================

func TestDialURL_UnknownSchemeReturnsError(t *testing.T) {
	withTestRegistry(t)

	_, err := DialURL(context.Background(), "ftp://nope", Credentials{})
	if !errors.Is(err, ErrUnknownProtocol) {
		t.Errorf("err = %v, want ErrUnknownProtocol", err)
	}
}

func TestDialURL_KnownSchemeNoDialerReturnsError(t *testing.T) {
	withTestRegistry(t)

	// Scheme is recognized by FromURL but no dialer is registered.
	_, err := DialURL(context.Background(),
		"stratum+tcp://pool.example.com:3333", Credentials{})
	if !errors.Is(err, ErrUnknownProtocol) {
		t.Errorf("err = %v, want ErrUnknownProtocol", err)
	}
}

// dialFailingDialer is a Dialer whose Dial step fails.
type dialFailingDialer struct{}

func (d *dialFailingDialer) Protocol() ProtocolID { return ProtocolStratumV1 }

func (d *dialFailingDialer) Dial(_ context.Context, _ string, _ Credentials) (Connection, error) {
	return nil, errors.New("simulated network error")
}

func (d *dialFailingDialer) Negotiate(_ context.Context, _ Connection) (Session, error) {
	t := &testing.T{}
	t.Fatal("Negotiate should not be called when Dial fails")
	return nil, nil
}

func TestDialURL_DialFailurePropagates(t *testing.T) {
	withTestRegistry(t)

	Register(&dialFailingDialer{})
	_, err := DialURL(context.Background(),
		"stratum+tcp://pool.example.com:3333", Credentials{})
	if err == nil {
		t.Fatal("expected error from failing Dial")
	}
	if !contains(err.Error(), "simulated network error") {
		t.Errorf("error should wrap underlying message: %v", err)
	}
}

// negotiateFailingDialer dials successfully but fails to negotiate.
type negotiateFailingDialer struct {
	closeCalled bool
}

func (d *negotiateFailingDialer) Protocol() ProtocolID { return ProtocolStratumV2 }

func (d *negotiateFailingDialer) Dial(_ context.Context, _ string, _ Credentials) (Connection, error) {
	return &fakeConn{onClose: func() { d.closeCalled = true }}, nil
}

func (d *negotiateFailingDialer) Negotiate(_ context.Context, _ Connection) (Session, error) {
	return nil, errors.New("negotiation timeout")
}

type fakeConn struct {
	onClose func()
}

func (c *fakeConn) Close() error         { c.onClose(); return nil }
func (c *fakeConn) RemoteAddr() string   { return "fake:0" }
func (c *fakeConn) Protocol() ProtocolID { return ProtocolStratumV2 }

func TestDialURL_NegotiateFailureClosesConnection(t *testing.T) {
	withTestRegistry(t)

	d := &negotiateFailingDialer{}
	Register(d)

	_, err := DialURL(context.Background(),
		"stratum+v2://pool.example.com:3336", Credentials{})
	if err == nil {
		t.Fatal("expected negotiation error")
	}
	if !d.closeCalled {
		t.Error("DialURL did not close Connection after Negotiate failure (resource leak)")
	}
}

// fakeSession is a minimal Session for exercising DialURL's success path.
type fakeSession struct{}

func (fakeSession) Close() error     { return nil }
func (fakeSession) Jobs() <-chan Job { return nil }
func (fakeSession) Submit(context.Context, ShareSubmission) (ShareResult, error) {
	return ShareResult{}, nil
}
func (fakeSession) SuggestedDifficulty() float64 { return 1.0 }

// succeedingDialer dials and negotiates successfully, returning a Session.
type succeedingDialer struct {
	closeCalled bool
	session     Session
}

func (d *succeedingDialer) Protocol() ProtocolID { return ProtocolStratumV2 }

func (d *succeedingDialer) Dial(_ context.Context, _ string, _ Credentials) (Connection, error) {
	return &fakeConn{onClose: func() { d.closeCalled = true }}, nil
}

func (d *succeedingDialer) Negotiate(_ context.Context, _ Connection) (Session, error) {
	return d.session, nil
}

func TestDialURL_SuccessReturnsSessionAndKeepsConnectionOpen(t *testing.T) {
	withTestRegistry(t)

	want := fakeSession{}
	d := &succeedingDialer{session: want}
	Register(d)

	sess, err := DialURL(context.Background(),
		"stratum+v2://pool.example.com:3336", Credentials{})
	if err != nil {
		t.Fatalf("DialURL on a fully-succeeding dialer returned error: %v", err)
	}
	if sess != want {
		t.Errorf("DialURL returned %v, want the negotiated session %v", sess, want)
	}
	// On success the Connection must NOT be closed — it is owned by the live
	// Session and closing it would break the session immediately.
	if d.closeCalled {
		t.Error("DialURL closed the Connection on the success path (would kill the live session)")
	}
}

// ============================================================================
// Credentials — zero value usability
// ============================================================================

func TestCredentials_ZeroValue(t *testing.T) {
	var c Credentials
	if c.User != "" || c.Password != "" || len(c.PoolPubKey) != 0 {
		t.Errorf("zero Credentials has unexpected non-zero fields: %+v", c)
	}
}

// ============================================================================
// Job / ShareSubmission / ShareResult — pure data types
// ============================================================================

func TestJob_ZeroValueIsUsable(t *testing.T) {
	var j Job
	if !j.ReceivedAt.IsZero() {
		t.Error("zero Job.ReceivedAt is not zero")
	}
	if j.Version != 0 || j.NTime != 0 || j.NBits != 0 {
		t.Error("zero Job has unexpected non-zero numeric fields")
	}
}

func TestShareResult_AcceptedZeroIsRejected(t *testing.T) {
	// Document: zero ShareResult means rejected (Accepted=false). This
	// matters because Submit error paths return zero values.
	var r ShareResult
	if r.Accepted {
		t.Error("zero ShareResult.Accepted = true, want false")
	}
}

// ============================================================================
// Helper
// ============================================================================

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

// Sanity: Credentials can hold a real-looking pubkey (32 bytes).
func TestCredentials_HoldsLargePubKey(t *testing.T) {
	pubkey := make([]byte, 32)
	for i := range pubkey {
		pubkey[i] = byte(i)
	}
	c := Credentials{
		User:       "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
		Password:   "x",
		PoolPubKey: pubkey,
	}
	if len(c.PoolPubKey) != 32 {
		t.Errorf("PoolPubKey length = %d, want 32", len(c.PoolPubKey))
	}
}

// Compile-time assertion that stubDialer satisfies Dialer.
var (
	_ Dialer     = (*stubDialer)(nil)
	_ Connection = (*fakeConn)(nil)
)

// Sanity: registry isolation actually works across tests.
// (If withTestRegistry leaks, this test would observe stale state.)
func TestRegistry_IsolationWorks(t *testing.T) {
	withTestRegistry(t)
	got := Available()
	if len(got) != 0 {
		t.Errorf("registry isolation broken: %v leaked in", got)
	}
	_ = time.Now() // touch time package to silence unused import on early exit
}

// ----- StripScheme -----

func TestStripScheme_AllKnownSchemes(t *testing.T) {
	cases := map[string]string{
		"stratum+tcp://pool.example.com:3333":   "pool.example.com:3333",
		"stratum+tls://pool.example.com:3334":   "pool.example.com:3334",
		"stratum+v2://pool.example.com:3336":    "pool.example.com:3336",
		"stratum+v2tls://pool.example.com:3337": "pool.example.com:3337",
		"datum://ocean.xyz:2020":                "ocean.xyz:2020",
	}
	for url, wantHost := range cases {
		got, err := StripScheme(url)
		if err != nil {
			t.Errorf("StripScheme(%q) error: %v", url, err)
			continue
		}
		if got != wantHost {
			t.Errorf("StripScheme(%q) = %q, want %q", url, got, wantHost)
		}
	}
}

func TestStripScheme_UnknownScheme(t *testing.T) {
	_, err := StripScheme("http://example.com")
	if !errors.Is(err, ErrUnknownProtocol) {
		t.Errorf("StripScheme(unknown) error = %v, want ErrUnknownProtocol", err)
	}
}

func TestStripScheme_EmptyHost(t *testing.T) {
	// A scheme with no host after it is not a valid target: the prefix
	// match requires len(url) > len(prefix), so bare scheme is rejected.
	_, err := StripScheme("stratum+v2://")
	if !errors.Is(err, ErrUnknownProtocol) {
		t.Errorf("StripScheme(bare scheme) error = %v, want ErrUnknownProtocol", err)
	}
}

// TestStripScheme_ConsistentWithFromURL verifies the two functions
// share the same scheme knowledge: any URL StripScheme accepts must
// also be classified by FromURL as a known (non-Unknown) protocol.
func TestStripScheme_ConsistentWithFromURL(t *testing.T) {
	urls := []string{
		"stratum+tcp://h:1", "stratum+tls://h:1",
		"stratum+v2://h:1", "stratum+v2tls://h:1", "datum://h:1",
	}
	for _, url := range urls {
		if _, err := StripScheme(url); err != nil {
			t.Errorf("StripScheme(%q) failed: %v", url, err)
		}
		if FromURL(url) == ProtocolUnknown {
			t.Errorf("FromURL(%q) = Unknown but StripScheme accepted it", url)
		}
	}
}
