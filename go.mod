module github.com/shizukutanaka/Otedama

go 1.24.0

// godebug pins behavior across Go upgrades. See GODEBUG_NOTES.md.
//   tlsmlkem=1   — enable hybrid PQ key exchange (X25519MLKEM768) in TLS
//                  handshakes (default-on Go 1.24+). Renamed from the Go 1.23
//                  draft knob tlskyber when X25519Kyber768 was standardized.
//   panicnil=0   — keep Go 1.21+ behavior of panicking on nil panic value.
//   randautoseed=1 — math/rand v1 auto-seed (Go 1.20+ default).
godebug (
	panicnil=0
	randautoseed=1
	tlsmlkem=1
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
	// Pinned at the last go1.24-compatible release; v0.49+ requires
	// go1.25, which is above the project's go directive floor.
	golang.org/x/crypto v0.48.0
)

require golang.org/x/sys v0.41.0 // indirect
