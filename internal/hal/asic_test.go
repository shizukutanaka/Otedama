// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
package hal

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// cgminerFixture is a loopback listener impersonating one cgminer RPC
// peer. Each accepted connection gets reply[command] (a default is used
// for unknown commands), then the connection is closed like real
// cgminer firmware does.
type cgminerFixture struct {
	t       *testing.T
	ln      net.Listener
	replies map[string]string
	def     string
}

func newCGMinerFixture(t *testing.T, replies map[string]string, def string) *cgminerFixture {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	f := &cgminerFixture{t: t, ln: ln, replies: replies, def: def}
	go f.serve()
	t.Cleanup(func() { f.ln.Close() })
	return f
}

func (f *cgminerFixture) addr() string { return f.ln.Addr().String() }

func (f *cgminerFixture) serve() {
	for {
		conn, err := f.ln.Accept()
		if err != nil {
			return
		}
		go func(conn net.Conn) {
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
			line, err := bufio.NewReader(conn).ReadString('\n')
			if err != nil {
				return
			}
			var req struct {
				Command string `json:"command"`
			}
			if json.Unmarshal([]byte(line), &req) != nil {
				return
			}
			reply, ok := f.replies[req.Command]
			if !ok {
				reply = f.def
			}
			// Some firmwares append a NUL byte; mimic it.
			_, _ = conn.Write(append([]byte(reply), 0x00))
		}(conn)
	}
}

func TestASICDriver_Name(t *testing.T) {
	if (&ASICDriver{}).Name() != "asic_cgminer" {
		t.Error("unexpected driver name")
	}
}

func TestNormalizeASICEndpoint(t *testing.T) {
	cases := []struct {
		in, want string
		ok       bool
	}{
		{"192.168.1.50:4028", "192.168.1.50:4028", true},
		{"192.168.1.50", "192.168.1.50:4028", true},
		{"antminer.lan", "antminer.lan:4028", true},
		{"[fd00::1]:4028", "[fd00::1]:4028", true},
		{"[fd00::1]", "[fd00::1]:4028", true}, // bare bracketed IPv6 → default port
		{"", "", false},
		{"   ", "", false},
		{"a/b:4028", "", false},
		{":4028", "", false},
		{"fd00::1", "", false},         // bare unbracketed IPv6 rejected
		{"host:abc", "host:abc", true}, // named ports pass normalisation; dial fails
	}
	for _, c := range cases {
		got, err := normalizeASICEndpoint(c.in)
		if c.ok && (err != nil || got != c.want) {
			t.Errorf("normalize(%q) = %q, %v; want %q", c.in, got, err, c.want)
		}
		if !c.ok && err == nil {
			t.Errorf("normalize(%q) = %q, want error", c.in, got)
		}
	}
}

func TestASICDriver_Enumerate(t *testing.T) {
	ant := newCGMinerFixture(t, map[string]string{
		"version+stats": `{"STATUS":[{"STATUS":"S","Description":"bmminer 2.0.0"}],"VERSION":[{"CGMiner":"4.9.0","API":"3.1","Miner":""}],"STATS":[{"Type":"Antminer S19 Pro","Model":""}],"id":1}`,
		"summary":       `{"STATUS":[{"STATUS":"S","Description":"bmminer 2.0.0"}],"SUMMARY":[{"Elapsed":3600,"GHS av":110000.0}],"id":1}`,
	}, `{"STATUS":[{"STATUS":"E","Description":"unknown command"}],"id":1}`)

	drv := &ASICDriver{Endpoints: []string{ant.addr()}}
	devs, err := drv.Enumerate(context.Background())
	if err != nil {
		t.Fatalf("Enumerate: %v", err)
	}
	if len(devs) != 1 {
		t.Fatalf("got %d devices, want 1", len(devs))
	}
	id := devs[0].Identity()
	if id.Family != FamilyASIC {
		t.Errorf("family = %q, want asic", id.Family)
	}
	if id.Model != "Antminer S19 Pro" {
		t.Errorf("model = %q, want Antminer S19 Pro", id.Model)
	}
	if id.Vendor != "Bitmain" {
		t.Errorf("vendor = %q, want Bitmain", id.Vendor)
	}
	if err := id.Validate(); err != nil {
		t.Errorf("identity invalid: %v", err)
	}
	if devs[0].Capabilities().SHA256d {
		t.Error("detected-only ASIC must not advertise SHA256d (no dispatch path)")
	}
	if h := devs[0].(*asicDevice).ReportedHashrate(); h != 110000e9 {
		t.Errorf("reported hashrate = %v, want 1.1e14", h)
	}
}

func TestASICDriver_Enumerate_BareHostAndFallback(t *testing.T) {
	// Miner rejects the multi-command syntax → driver falls back to
	// plain "version"; model comes from VERSION[0].Miner.
	aval := newCGMinerFixture(t, map[string]string{
		"version": `{"STATUS":[{"STATUS":"S","Description":"cgminer 4.11.1"}],"VERSION":[{"CGMiner":"4.11.1","API":"3.7","Miner":"AvalonMiner 1246"}],"id":1}`,
		"summary": `{"STATUS":[{"STATUS":"S","Description":"cgminer 4.11.1"}],"SUMMARY":[{"Elapsed":10,"MHS av":90000.0}],"id":1}`,
	}, `{"STATUS":[{"STATUS":"E","Description":"missing"}],"id":1}`)

	// Exercise the bare-host → :4028 path for real: bind a second fixture
	// on the actual cgminer API port and point a bare hostname at it.
	// Skip when 4028 is occupied on this machine (e.g. a real miner).
	apiLn, err := net.Listen("tcp", "127.0.0.1:4028")
	if err != nil {
		t.Skipf("cannot bind 127.0.0.1:4028 for bare-host test: %v", err)
	}
	bare := &cgminerFixture{
		t: t, ln: apiLn,
		replies: aval.replies, def: aval.def,
	}
	go bare.serve()
	t.Cleanup(func() { apiLn.Close() })

	drv := &ASICDriver{Endpoints: []string{"127.0.0.1"}} // bare host → :4028
	devs, err := drv.Enumerate(context.Background())
	if err != nil || len(devs) != 1 {
		t.Fatalf("Enumerate = %v devices, err %v", len(devs), err)
	}
	id := devs[0].Identity()
	if id.Model != "AvalonMiner 1246" {
		t.Errorf("model = %q, want AvalonMiner 1246", id.Model)
	}
	if id.Vendor != "Canaan" {
		t.Errorf("vendor = %q, want Canaan", id.Vendor)
	}
	if devs[0].(*asicDevice).ReportedHashrate() != 90000e6 {
		t.Error("MHS av not converted to H/s")
	}
}

func TestASICDriver_Enumerate_SkipsDeadEndpoints(t *testing.T) {
	// One live miner, one closed port, one garbage peer, one invalid
	// endpoint string — only the live one may enumerate.
	live := newCGMinerFixture(t, nil,
		`{"STATUS":[{"STATUS":"S","Description":"cgminer"}],"VERSION":[{"Miner":"Whatsminer M50"}],"id":1}`)

	dead := newCGMinerFixture(t, nil, `{"STATUS":[{"STATUS":"S"}],"VERSION":[{"Miner":"x"}],"id":1}`)
	deadAddr := dead.addr()
	dead.ln.Close() // port now refuses connections

	garbage := newCGMinerFixture(t, nil, `this is not json at all`)

	drv := &ASICDriver{
		Endpoints: []string{live.addr(), deadAddr, garbage.addr(), "not a host"},
		Timeout:   500 * time.Millisecond,
	}
	devs, err := drv.Enumerate(context.Background())
	if err != nil {
		t.Fatalf("Enumerate: %v", err)
	}
	if len(devs) != 1 {
		t.Fatalf("got %d devices, want 1 (dead/garbage endpoints skipped)", len(devs))
	}
	if devs[0].Identity().Vendor != "MicroBT" {
		t.Errorf("vendor = %q, want MicroBT", devs[0].Identity().Vendor)
	}
}

func TestASICDriver_Enumerate_EmptyAndTimeout(t *testing.T) {
	devs, err := (&ASICDriver{}).Enumerate(context.Background())
	if err != nil || len(devs) != 0 {
		t.Fatalf("empty driver = %v, %v", devs, err)
	}

	// A listener that accepts but never replies → bounded by Timeout.
	stuck, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer stuck.Close()
	go func() {
		for {
			c, err := stuck.Accept()
			if err != nil {
				return
			}
			// Hold the conn open without replying until the listener dies.
			_ = c
		}
	}()
	drv := &ASICDriver{Endpoints: []string{stuck.Addr().String()}, Timeout: 150 * time.Millisecond}
	start := time.Now()
	devs, err = drv.Enumerate(context.Background())
	if err != nil || len(devs) != 0 {
		t.Fatalf("stuck endpoint = %v, %v", devs, err)
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Errorf("probe of blackholed endpoint took %v, want bounded by timeout", elapsed)
	}
	if !strings.Contains(drv.Name(), "asic") {
		t.Error("driver name changed")
	}
}

// mgmtFixture is a stateful cgminer peer for the management commands:
// it records each (command, parameter) pair and answers via a handler
// that sees the call count, so tests can model "pools empty until
// addpool lands".
type mgmtFixture struct {
	t       *testing.T
	ln      net.Listener
	mu      sync.Mutex
	calls   [][2]string
	handler func(call int, command, parameter string) string
}

func newMgmtFixture(t *testing.T, handler func(call int, command, parameter string) string) *mgmtFixture {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	f := &mgmtFixture{t: t, ln: ln, handler: handler}
	go f.serve()
	t.Cleanup(func() { f.ln.Close() })
	return f
}

func (f *mgmtFixture) addr() string { return f.ln.Addr().String() }

func (f *mgmtFixture) serve() {
	for {
		conn, err := f.ln.Accept()
		if err != nil {
			return
		}
		go func(conn net.Conn) {
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
			line, err := bufio.NewReader(conn).ReadString('\n')
			if err != nil {
				return
			}
			var req struct {
				Command   string `json:"command"`
				Parameter string `json:"parameter"`
			}
			if json.Unmarshal([]byte(line), &req) != nil {
				return
			}
			f.mu.Lock()
			f.calls = append(f.calls, [2]string{req.Command, req.Parameter})
			n := len(f.calls)
			f.mu.Unlock()
			if _, err := conn.Write([]byte(f.handler(n, req.Command, req.Parameter) + "\n")); err != nil {
				return
			}
		}(conn)
	}
}

func (f *mgmtFixture) recorded() [][2]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([][2]string(nil), f.calls...)
}

const statusOK = `{"STATUS":[{"STATUS":"S","Description":"ok"}],"id":1}`

// TestSwitchPools_ExistingPoolSwitchesOnly: the pool is already in the
// miner's table — no addpool, straight to switchpool with its index.
func TestSwitchPools_ExistingPoolSwitchesOnly(t *testing.T) {
	fx := newMgmtFixture(t, func(_ int, command, _ string) string {
		switch command {
		case "pools":
			return `{"STATUS":[{"STATUS":"S"}],"POOLS":[{"POOL":0,"URL":"stratum+tcp://old:3333"},{"POOL":1,"URL":"stratum+tcp://pool.example:3334"}],"id":1}`
		default:
			return statusOK
		}
	})
	d := &ASICDriver{Endpoints: []string{fx.addr()}}
	switched, errs := d.SwitchPools(context.Background(), "stratum+tcp://pool.example:3334", "u", "x")
	if len(errs) != 0 {
		t.Fatalf("errs = %v", errs)
	}
	if len(switched) != 1 || switched[0] != fx.addr() {
		t.Fatalf("switched = %v", switched)
	}
	calls := fx.recorded()
	if len(calls) != 2 || calls[0][0] != "pools" || calls[1][0] != "switchpool" || calls[1][1] != "1" {
		t.Fatalf("calls = %v, want [pools, switchpool|1]", calls)
	}
}

// TestSwitchPools_AddsThenSwitches: pool absent → addpool|URL,USER,PASS
// first, then switchpool on the index the miner reports afterwards.
func TestSwitchPools_AddsThenSwitches(t *testing.T) {
	poolsCalls := 0
	fx := newMgmtFixture(t, func(_ int, command, parameter string) string {
		switch command {
		case "pools":
			poolsCalls++
			if poolsCalls == 1 {
				return `{"STATUS":[{"STATUS":"S"}],"POOLS":[{"POOL":0,"URL":"stratum+tcp://old:3333"}],"id":1}`
			}
			return `{"STATUS":[{"STATUS":"S"}],"POOLS":[{"POOL":0,"URL":"stratum+tcp://old:3333"},{"POOL":1,"URL":"stratum+tcp://pool.example:3334"}],"id":1}`
		case "addpool":
			if parameter != "stratum+tcp://pool.example:3334,user,pw" {
				t.Errorf("addpool parameter = %q", parameter)
			}
			return statusOK
		default:
			return statusOK
		}
	})
	d := &ASICDriver{Endpoints: []string{fx.addr()}}
	switched, errs := d.SwitchPools(context.Background(), "stratum+tcp://pool.example:3334", "user", "pw")
	if len(errs) != 0 || len(switched) != 1 {
		t.Fatalf("switched=%v errs=%v", switched, errs)
	}
	calls := fx.recorded()
	if len(calls) != 4 || calls[0][0] != "pools" || calls[1][0] != "addpool" ||
		calls[2][0] != "pools" || calls[3][0] != "switchpool" || calls[3][1] != "1" {
		t.Fatalf("calls = %v, want pools→addpool→pools→switchpool|1", calls)
	}
}

// TestSwitchPools_BareHostAndDatumURLs: a bare host:port gets the
// stratum+tcp:// prefix cgminer needs; datum:// is rewritten the same
// way (DATUM's downstream protocol is SV1).
func TestSwitchPools_BareHostAndDatumURLs(t *testing.T) {
	for _, cfg := range []struct{ in, want string }{
		{"pool.example:3334", "stratum+tcp://pool.example:3334"},
		{"datum://ocean.xyz:3334", "stratum+tcp://ocean.xyz:3334"},
		{"stratum+tls://pool.example:443", "stratum+tls://pool.example:443"},
	} {
		if got := poolURLForASIC(cfg.in); got != cfg.want {
			t.Errorf("poolURLForASIC(%q) = %q, want %q", cfg.in, got, cfg.want)
		}
	}
	fx := newMgmtFixture(t, func(_ int, command, parameter string) string {
		if command == "pools" {
			return `{"STATUS":[{"STATUS":"S"}],"POOLS":[{"POOL":0,"URL":"stratum+tcp://ocean.xyz:3334"}],"id":1}`
		}
		return statusOK
	})
	d := &ASICDriver{Endpoints: []string{fx.addr()}}
	if _, errs := d.SwitchPools(context.Background(), "datum://ocean.xyz:3334", "u", "x"); len(errs) != 0 {
		t.Fatalf("datum URL switch errs = %v", errs)
	}
	calls := fx.recorded()
	if calls[len(calls)-1][0] != "switchpool" || calls[len(calls)-1][1] != "0" {
		t.Fatalf("calls = %v, want switchpool|0 on the datum-mapped URL", calls)
	}
}

// TestSwitchPools_DeadEndpointCollects: unreachable miners land in errs
// without aborting the batch.
func TestSwitchPools_DeadEndpointCollects(t *testing.T) {
	dead, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	deadAddr := dead.Addr().String()
	dead.Close()
	d := &ASICDriver{Endpoints: []string{deadAddr}, Timeout: 200 * time.Millisecond}
	switched, errs := d.SwitchPools(context.Background(), "stratum+tcp://pool.example:3334", "u", "x")
	if len(switched) != 0 || len(errs) != 1 {
		t.Fatalf("switched=%v errs=%v", switched, errs)
	}
}

func TestPoolIndexFor(t *testing.T) {
	var rep cgminerReply
	if err := json.Unmarshal([]byte(
		`{"POOLS":[{"POOL":0,"URL":"stratum+tcp://a:1"},{"POOL":1,"URL":"stratum+tcp://B.example:3334/"}]}`), &rep); err != nil {
		t.Fatal(err)
	}
	if id, ok := poolIndexFor(&rep, "stratum+tcp://b.example:3334"); !ok || id != 1 {
		t.Errorf("poolIndexFor = %d,%v, want 1,true (scheme+case+slash normalised)", id, ok)
	}
	if _, ok := poolIndexFor(&rep, "stratum+tcp://missing:1"); ok {
		t.Error("absent pool reported present")
	}
}

func TestCGMinerCommand_HugeReplyBounded(t *testing.T) {
	// A >64 KiB reply exceeds the bounded read — decoding must error
	// rather than allocating the whole body (rogue LAN device guard).
	big := `{"STATUS":[{"STATUS":"S","When":1,"Code":1,"Msg":"ok","Description":"` +
		strings.Repeat("x", 200*1024) + `"}],"id":1}`
	f := newCGMinerFixture(t, nil, big)
	var rep cgminerReply
	if err := cgminerCommand(context.Background(), f.addr(), 2*time.Second, "summary", &rep); err == nil {
		t.Fatal("oversized reply should error under the body cap")
	}
}

// TestSwitchPools_RejectsCommaFields covers the addpool parameter
// boundary: cgminer splits its parameter on commas, so a comma inside
// any field cannot be represented and must be rejected before any
// endpoint is touched.
func TestSwitchPools_RejectsCommaFields(t *testing.T) {
	cases := []struct{ url, user, pass string }{
		{"stratum+tcp://pool:3333/x,y", "u", "p"},
		{"stratum+tcp://pool:3333", "u,w", "p"},
		{"stratum+tcp://pool:3333", "u", "p,x"},
	}
	for _, c := range cases {
		d := &ASICDriver{Endpoints: []string{"127.0.0.1:4028"}}
		switched, errs := d.SwitchPools(context.Background(), c.url, c.user, c.pass)
		if len(errs) != 1 {
			t.Fatalf("url=%q user=%q pass=%q: want 1 error, got %v", c.url, c.user, c.pass, errs)
		}
		if switched != nil {
			t.Fatalf("url=%q: unexpected switches %v", c.url, switched)
		}
	}
}
