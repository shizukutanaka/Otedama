module github.com/shizukutanaka/Otedama

go 1.25.0

toolchain go1.25.13

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
	// go.yaml.in/yaml/v3: upstream gopkg.in/yaml.v3 was archived
	// 2025-04; the YAML org maintains this successor path (near drop-in,
	// security-fixes-only on v3). Satisfies the "meaningful maintenance
	// within the last year" dependency criterion the archived path failed.
	go.yaml.in/yaml/v3 v3.0.5
	// x/crypto: chacha20poly1305 + scrypt remain x-only through Go 1.26
	// (stdlib gained hkdf/mlkem but not these). v0.55.0 is the newest
	// release still requiring only Go 1.25 (v0.56+ needs Go 1.26).
	golang.org/x/crypto v0.55.0
)

require golang.org/x/sys v0.47.0 // indirect
