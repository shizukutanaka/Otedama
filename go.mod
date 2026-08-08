module github.com/shizukutanaka/Otedama

go 1.22

toolchain go1.24.0

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
	golang.org/x/crypto v0.23.0
	gopkg.in/yaml.v3 v3.0.1
)

require golang.org/x/sys v0.20.0 // indirect
