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
	// Rationale: stdlib has no YAML decoder; required for the layered
	// config file (internal/config). MIT/Apache-2.0. yaml.v3 lives at
	// go.yaml.in now: gopkg.in/yaml.v3 was archived in April 2025 and
	// fails the maintained-dependency criterion; go.yaml.in/yaml/v3 is
	// the Yaml project's maintained continuation.
	go.yaml.in/yaml/v3 v3.0.5
	// Rationale (CLAUDE.md dependency rule): stdlib has no scrypt
	// implementation; required for the wallet KDF (AES-256-GCM key
	// derivation in internal/lightning). BSD-3-Clause, actively
	// maintained by the Go team. ADR-003 budget: stdlib + x/crypto + yaml.
	golang.org/x/crypto v0.23.0
)

// golang.org/x/sys is used by internal/tui to query the live terminal
// width (TIOCGWINSZ on Unix, GetConsoleScreenBufferInfo on Windows) —
// the frozen syscall package cannot express either portably. BSD
// licensed, maintained by the Go team, already in the module graph as
// an x/crypto dependency (no new modules added).
require golang.org/x/sys v0.20.0
