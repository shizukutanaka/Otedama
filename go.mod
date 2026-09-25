module github.com/shizukutanaka/Otedama

go 1.26.0

toolchain go1.26.8

// godebug pins behavior across Go upgrades. See GODEBUG_NOTES.md.
//   tlsmlkem=1   — enable hybrid PQ key exchange (X25519MLKEM768) in TLS
//                  handshakes (default-on Go 1.24+). Renamed from the Go 1.23
//                  draft knob tlskyber when X25519Kyber768 was standardized.
//   panicnil=0   — keep Go 1.21+ behavior of panicking on nil panic value.
//   randautoseed=1 — math/rand v1 auto-seed (Go 1.20+ default).
//   containermaxprocs=1 — GOMAXPROCS respects cgroup CPU limits (default-on
//                  go1.25+; pinned so the behavior survives directive bumps).
//   updatemaxprocs=1 — GOMAXPROCS re-reads cgroup limits periodically
//                  (default-on go1.25+; same rationale).
//   tlssecpmlkem=1 — keep go1.26's hybrid PQ key exchanges
//                  (SecP256r1MLKEM768 / SecP384r1MLKEM1024) enabled alongside
//                  tlsmlkem's X25519MLKEM768.
godebug (
	containermaxprocs=1
	panicnil=0
	randautoseed=1
	tlsmlkem=1
	tlssecpmlkem=1
	updatemaxprocs=1
)

require (
	// go.yaml.in/yaml/v3 — YAML config-file decoding. Successor module of
	// the archived gopkg.in/yaml.v3 (drop-in same API; the go-yaml org
	// renamed gopkg.in imports to go.yaml.in in v3.0.4+). MIT/Apache-2.0,
	// actively maintained (yamlfmt/k8s ecosystem standard). See the
	// ADR-003 erratum in docs/adr/.
	go.yaml.in/yaml/v3 v3.0.5
	// golang.org/x/crypto — ChaCha20-Poly1305 for the Noise NX transport
	// cipher. Audited crypto only (CLAUDE.md forbids self-rolled ciphers).
	// v0.57.0 is the newest release and the first carrying the x/crypto/ssh
	// DoS fixes (CVE-2026-56855/-78662); both require go1.26, which the
	// module floor now provides.
	golang.org/x/crypto v0.57.0
)

require golang.org/x/sys v0.48.0 // indirect
