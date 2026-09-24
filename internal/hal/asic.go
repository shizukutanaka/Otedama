// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package hal — asic.go
//
// ASIC detection via the de-facto-standard cgminer RPC API (TCP port
// 4028), spoken by Antminer/bmminer, Whatsminer, Avalon, and Braiins
// firmware families. Detection is strictly opt-in: the operator lists
// explicit host:port endpoints in `asic_endpoints` and the driver probes
// exactly those addresses. Otedama deliberately never scans subnets —
// unsolicited LAN probing at startup is both slow and hostile on shared
// networks; cgminer itself ships the same posture (API access requires
// `api-allow` on the miner).
//
// Scope is presence and identity only — the same posture as the GPU
// drivers (see gpu_linux.go): no work-dispatch path to a networked ASIC
// exists anywhere in the codebase, so Capabilities.SHA256d is left false
// even though the device itself is hashing. Wiring real ASIC share
// dispatch is the remaining half of docs/KNOWN_LIMITATIONS.md §8.
package hal

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"
)

// CGMinerAPIPort is the IANA-free port cgminer and its descendants
// (bmminer, Braiins OS, Awesome Miner agents) expose for RPC. Bare
// hostnames in ASICDriver.Endpoints get this port appended.
const CGMinerAPIPort = "4028"

// DefaultASICProbeTimeout bounds one probe round-trip (dial + command +
// reply). cgminer closes the connection after each reply, so a healthy
// miner answers in tens of milliseconds; the budget exists for
// firewalled/blackholed endpoints.
const DefaultASICProbeTimeout = 1500 * time.Millisecond

// ASICDriver enumerates standalone ASIC miners via the cgminer RPC API.
//
// The zero value enumerates nothing: Endpoints is required. Endpoints
// are "host:port" strings; a bare host (or host without a port) is
// given CGMinerAPIPort.
type ASICDriver struct {
	// Endpoints lists the miners to probe, "host:port" (or bare "host"
	// for the default cgminer API port).
	Endpoints []string

	// Timeout bounds each endpoint probe. Zero uses
	// DefaultASICProbeTimeout.
	Timeout time.Duration
}

// Name returns "asic_cgminer".
func (d *ASICDriver) Name() string { return "asic_cgminer" }

// Enumerate probes each configured endpoint in parallel and returns one
// device per responding miner. Endpoints that are unreachable, slow, or
// answer garbage are skipped — per the Detector's partial-failure
// policy they are not errors.
func (d *ASICDriver) Enumerate(ctx context.Context) ([]Device, error) {
	timeout := d.Timeout
	if timeout <= 0 {
		timeout = DefaultASICProbeTimeout
	}
	type result struct {
		dev *asicDevice
	}
	resCh := make(chan result, len(d.Endpoints))
	var pending int
	for _, ep := range d.Endpoints {
		addr, err := normalizeASICEndpoint(ep)
		if err != nil {
			continue
		}
		pending++
		go func(addr string) {
			dev, err := probeCGMiner(ctx, addr, timeout)
			if err != nil {
				dev = nil
			}
			resCh <- result{dev: dev}
		}(addr)
	}
	var devices []Device
	for i := 0; i < pending; i++ {
		select {
		case r := <-resCh:
			if r.dev != nil {
				devices = append(devices, r.dev)
			}
		case <-ctx.Done():
			return devices, ctx.Err()
		}
	}
	return devices, nil
}

// normalizeASICEndpoint accepts "host:port" or a bare host/IP and
// returns a canonical "host:port". The host must not be empty; the port
// must be numeric. Validation rejects anything else so config errors
// surface at load time rather than as silent no-ASICs.
func normalizeASICEndpoint(ep string) (string, error) {
	ep = strings.TrimSpace(ep)
	if ep == "" {
		return "", fmt.Errorf("hal: empty asic endpoint")
	}
	if host, port, err := net.SplitHostPort(ep); err == nil {
		if host == "" || port == "" || strings.ContainsAny(host, "/\t \n") {
			return "", fmt.Errorf("hal: invalid asic endpoint %q (want host:port or host)", ep)
		}
		return ep, nil
	}
	// Bare host ("192.168.1.50", "antminer"). Bracketed bare IPv6
	// ("[fd00::1]") is unbracketed and re-joined by JoinHostPort;
	// bare unbracketed IPv6 is rejected by the ':' filter.
	host := ep
	bracketed := strings.HasPrefix(ep, "[") && strings.HasSuffix(ep, "]")
	if bracketed {
		host = ep[1 : len(ep)-1]
	}
	reject := ":/\t \n"
	if bracketed {
		reject = "/\t \n" // ':' is legal inside a bracketed IPv6 literal
	}
	if host == "" || strings.ContainsAny(host, reject) {
		return "", fmt.Errorf("hal: invalid asic endpoint %q (want host:port or host)", ep)
	}
	return net.JoinHostPort(host, CGMinerAPIPort), nil
}

// asicDevice is a detected cgminer-compatible miner. Detection only —
// Shutdown is a no-op since the probe opens no persistent resources.
type asicDevice struct {
	id   Identity
	hash float64 // self-reported hashrate in H/s; kept for future dispatch
}

func (d *asicDevice) Identity() Identity             { return d.id }
func (d *asicDevice) Capabilities() Capabilities     { return Capabilities{} }
func (d *asicDevice) Shutdown(context.Context) error { return nil }

// ReportedHashrate returns the device's self-reported hashrate in H/s
// (0 when the miner did not report one). Not part of Device — ASIC
// dispatch does not exist yet, so nothing consumes it today.
func (d *asicDevice) ReportedHashrate() float64 { return d.hash }

// cgminerReply is the union of the response shapes a miner may return.
// cgminer answers {"command":"version+stats"} with both arrays merged
// into one JSON object (plus "id" and the STATUS block); single-command
// replies contain just their own array. Firmwares differ: Antminer
// bmminer fills STATS[0].Type, Avalon cgminer fills VERSION[0].Miner,
// and some builds answer neither, in which case the device is still an
// ASIC — presence is proven by a well-formed STATUS block alone.
type cgminerReply struct {
	Status []struct {
		Status      string `json:"STATUS"`
		Description string `json:"Description"`
	} `json:"STATUS"`
	Version []struct {
		Miner string `json:"Miner"`
	} `json:"VERSION"`
	Stats []struct {
		Type  string `json:"Type"`
		Model string `json:"Model"`
	} `json:"STATS"`
	Summary []map[string]json.RawMessage `json:"SUMMARY"`
	Pools   []struct {
		Pool int    `json:"POOL"`
		URL  string `json:"URL"`
	} `json:"POOLS"`
}

// probeCGMiner queries one endpoint and returns a detected device, or an
// error if the endpoint did not answer like a cgminer API.
func probeCGMiner(ctx context.Context, addr string, timeout time.Duration) (*asicDevice, error) {
	var rep cgminerReply
	// "version+stats" is cgminer's multi-command syntax — one round trip.
	// Older builds that reject it get a plain "version" retry.
	if err := cgminerCommand(ctx, addr, timeout, "version+stats", &rep); err != nil ||
		(len(rep.Version) == 0 && len(rep.Stats) == 0) {
		rep = cgminerReply{}
		if err := cgminerCommand(ctx, addr, timeout, "version", &rep); err != nil {
			return nil, err
		}
	}
	// Summary is best-effort: hashrate is informative but not required to
	// call this an ASIC.
	var sum cgminerReply
	if err := cgminerCommand(ctx, addr, timeout, "summary", &sum); err == nil {
		rep.Summary = sum.Summary
	}
	model := cgminerModel(&rep)
	return &asicDevice{
		id: Identity{
			ID:     "asic-" + sanitizeASICID(addr),
			Family: FamilyASIC,
			Vendor: asicVendor(model),
			Model:  model,
		},
		hash: cgminerHashrate(&rep),
	}, nil
}

// cgminerCommand sends one cgminer RPC command and decodes the first
// JSON object of the reply. cgminer answers then closes; some firmwares
// append a NUL byte or glue a second object on, so decoding goes through
// json.Decoder on the raw buffer rather than json.Unmarshal (which would
// reject the trailing bytes).
func cgminerCommand(ctx context.Context, addr string, timeout time.Duration, command string, rep *cgminerReply) error {
	return cgminerCommandParam(ctx, addr, timeout, command, "", rep)
}

// cgminerCommandParam is cgminerCommand with an optional "parameter"
// field — management commands (addpool, switchpool) take one.
func cgminerCommandParam(ctx context.Context, addr string, timeout time.Duration, command, parameter string, rep *cgminerReply) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var dialer net.Dialer
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout))
	payload := fmt.Sprintf(`{"command":%q`, command)
	if parameter != "" {
		payload += fmt.Sprintf(`,"parameter":%q`, parameter)
	}
	if _, err := fmt.Fprint(conn, payload+"}\n"); err != nil {
		return err
	}
	// Bound the reply like the external feed fetches: the endpoint is
	// operator-configured but still network input (a rogue LAN device or
	// a mistyped IP can stream garbage). cgminer replies are a few KiB.
	dec := json.NewDecoder(io.LimitReader(conn, 64*1024))
	if err := dec.Decode(rep); err != nil {
		return err
	}
	// STATUS "S" = success, "E" = error, "I" = info. A reply with no
	// STATUS block at all is not a cgminer peer.
	if len(rep.Status) == 0 {
		return fmt.Errorf("hal: %s: reply lacks STATUS block", addr)
	}
	if rep.Status[0].Status == "E" {
		return fmt.Errorf("hal: %s: cgminer error: %s", addr, rep.Status[0].Description)
	}
	return nil
}

// SwitchPools directs every configured endpoint at poolURL: each
// cgminer-compatible miner gets the pool added when absent
// (addpool|URL,USER,PASS) and then switched onto it (switchpool|N).
// This is the opt-in actuation half of KNOWN_LIMITATIONS §8 — detection
// probes read-only commands; switching rewrites each miner's active
// pool, so callers must only invoke it when the operator enabled
// `asic_manage`. Per-endpoint failures are collected rather than
// failing the batch; switched lists the endpoints that accepted.
//
// Only Stratum-V1-compatible URLs are pushed: cgminer-family firmware
// speaks SV1, so a stratum+v2:// URL would strand the miner. datum://
// maps to stratum+tcp:// (the DATUM gateway's miner-facing protocol is
// SV1); stratum+tls:// passes through for firmwares that support it.
func (d *ASICDriver) SwitchPools(ctx context.Context, poolURL, user, pass string) (switched []string, errs []error) {
	// cgminer parses addpool's parameter as a comma-separated
	// URL,USERNAME,PASSWORD triple — a comma inside any field cannot be
	// represented faithfully (it would shift the field boundaries and
	// store corrupt credentials on the miner), so reject upfront
	// rather than push garbage.
	for _, f := range []struct{ name, v string }{
		{"poolURL", poolURL}, {"user", user}, {"pass", pass},
	} {
		if strings.Contains(f.v, ",") {
			return nil, []error{fmt.Errorf("hal: %s contains ',' which cgminer's comma-separated addpool parameter cannot represent", f.name)}
		}
	}
	timeout := d.Timeout
	if timeout <= 0 {
		timeout = DefaultASICProbeTimeout
	}
	for _, ep := range d.Endpoints {
		addr, err := normalizeASICEndpoint(ep)
		if err != nil {
			continue // same posture as Enumerate: bad entries are skipped
		}
		if err := switchCGMinerPool(ctx, addr, poolURL, user, pass, timeout); err != nil {
			errs = append(errs, fmt.Errorf("hal: %s: %w", addr, err))
			continue
		}
		switched = append(switched, addr)
	}
	return switched, errs
}

// switchCGMinerPool moves one miner onto poolURL. addpool appends but
// does not activate, so the sequence is pools → (addpool → pools) →
// switchpool, keyed off the POOLS table the miner reports.
func switchCGMinerPool(ctx context.Context, addr, poolURL, user, pass string, timeout time.Duration) error {
	var rep cgminerReply
	if err := cgminerCommand(ctx, addr, timeout, "pools", &rep); err != nil {
		return err
	}
	id, found := poolIndexFor(&rep, poolURL)
	if !found {
		var add cgminerReply
		if err := cgminerCommandParam(ctx, addr, timeout, "addpool",
			poolURLForASIC(poolURL)+","+user+","+pass, &add); err != nil {
			return fmt.Errorf("addpool: %w", err)
		}
		rep = cgminerReply{}
		if err := cgminerCommand(ctx, addr, timeout, "pools", &rep); err != nil {
			return err
		}
		if id, found = poolIndexFor(&rep, poolURL); !found {
			return fmt.Errorf("pool %q absent after addpool", poolURL)
		}
	}
	var sw cgminerReply
	if err := cgminerCommandParam(ctx, addr, timeout, "switchpool",
		strconv.Itoa(id), &sw); err != nil {
		return fmt.Errorf("switchpool: %w", err)
	}
	return nil
}

// poolIndexFor returns the cgminer pool index whose stored URL names
// the same target as poolURL, comparing scheme-normalised host:port.
func poolIndexFor(rep *cgminerReply, poolURL string) (int, bool) {
	want := normPoolURLKey(poolURL)
	for _, p := range rep.Pools {
		if normPoolURLKey(p.URL) == want {
			return p.Pool, true
		}
	}
	return 0, false
}

// poolURLForASIC renders a configured pool URL the way cgminer expects:
// schemes pass through (datum:// is rewritten to stratum+tcp://, the
// protocol a DATUM gateway actually serves downstream miners), and a
// bare host:port gets the stratum+tcp:// prefix cgminer requires.
func poolURLForASIC(url string) string {
	switch {
	case strings.HasPrefix(url, "datum://"):
		return "stratum+tcp://" + url[len("datum://"):]
	case strings.Contains(url, "://"):
		return url
	default:
		return "stratum+tcp://" + url
	}
}

// normPoolURLKey reduces a pool URL to a comparison key: lowercase
// host:port with any scheme prefix and trailing slash dropped.
func normPoolURLKey(url string) string {
	if i := strings.Index(url, "://"); i >= 0 {
		url = url[i+3:]
	}
	return strings.TrimSuffix(strings.ToLower(url), "/")
}

// cgminerModel picks the best model string a miner offered.
func cgminerModel(rep *cgminerReply) string {
	for _, s := range rep.Stats {
		if s.Type != "" {
			return s.Type
		}
		if s.Model != "" {
			return s.Model
		}
	}
	for _, v := range rep.Version {
		if v.Miner != "" {
			return v.Miner
		}
	}
	return ""
}

// asicVendor guesses the vendor from the model string.
func asicVendor(model string) string {
	switch m := strings.ToLower(model); {
	case strings.Contains(m, "antminer"):
		return "Bitmain"
	case strings.Contains(m, "whatsminer"):
		return "MicroBT"
	case strings.Contains(m, "avalon"):
		return "Canaan"
	case strings.Contains(m, "bitaxe"), strings.Contains(m, "nerdaxe"):
		return "Open-Source"
	case strings.Contains(m, "braiins"):
		return "Braiins"
	default:
		return ""
	}
}

// cgminerHashrate extracts the best hashrate field (H/s) from a SUMMARY
// block. Firmwares disagree on units and keys; try the most common in
// order of preference.
func cgminerHashrate(rep *cgminerReply) float64 {
	if len(rep.Summary) == 0 {
		return 0
	}
	fields := []struct {
		key  string
		mult float64
	}{
		{"GHS av", 1e9},
		{"GHS 5s", 1e9},
		{"MHS av", 1e6},
		{"MHS 5s", 1e6},
		{"KHS av", 1e3},
		{"KHS 5s", 1e3},
	}
	for _, f := range fields {
		raw, ok := rep.Summary[0][f.key]
		if !ok {
			continue
		}
		var v float64
		if json.Unmarshal(raw, &v) == nil {
			return v * f.mult
		}
	}
	return 0
}

// sanitizeASICID renders an endpoint (host:port) as an Identity.ID-safe
// suffix: Identity forbids whitespace and '/', so keep
// [A-Za-z0-9._:-] and collapse anything else.
func sanitizeASICID(addr string) string {
	var b strings.Builder
	for _, r := range addr {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '.', r == '_', r == '-':
			b.WriteRune(r)
		case r == ':':
			b.WriteByte('-')
		default:
			b.WriteByte('-')
		}
	}
	return b.String()
}
