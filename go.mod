module github.com/shizukutanaka/Otedama

go 1.24.0

toolchain go1.25.7

// godebug pins behavior across Go upgrades. See GODEBUG_NOTES.md.
//   tlsmlkem=1   — enable hybrid PQ key exchange (X25519MLKEM768) in TLS
//                  handshakes (default-on Go 1.24+). Renamed from the Go 1.23
//                  draft knob tlskyber when X25519Kyber768 was standardized.
//   panicnil=0   — keep Go 1.21+ behavior of panicking on nil panic value.
//   randautoseed=1 — math/rand v1 auto-seed (Go 1.20+ default).
//   containermaxprocs=1 — cgroup-aware GOMAXPROCS default (Go 1.25+);
//                  load-bearing for correct CPU-mining throttling under
//                  container CPU limits (GODEBUG_NOTES.md).
godebug (
	containermaxprocs=1
	panicnil=0
	randautoseed=1
	tlsmlkem=1
)

// golang.org/x/crypto — ChaCha20-Poly1305, scrypt, ECDH (stdlib cannot
// replace; confirmed in RESEARCH_IMPROVEMENTS dep-hygiene #4). Pinned at
// v0.48.0: v0.49+ declares `go 1.25` and would raise this module's own
// `go` directive to 1.25 — that floor change is a maintainer policy
// decision (GODEBUG_NOTES.md's go/toolchain split), so it stays a
// separate PR from the toolchain bump.
require golang.org/x/crypto v0.48.0

require (
	// go.yaml.in/yaml/v3 — config parsing. gopkg.in/yaml.v3 was archived
	// by its author 2025-04-01; this is the YAML org's maintained,
	// API-identical successor (v3 line, security-fixes-only upstream —
	// chosen over v4 to keep the existing API surface). Satisfies
	// CLAUDE.md §外部依存 criterion 3. See ADR-003 erratum.
	go.yaml.in/yaml/v3 v3.0.5
	golang.org/x/sys v0.41.0
)
