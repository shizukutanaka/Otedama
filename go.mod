module github.com/shizukutanaka/Otedama

go 1.23

toolchain go1.24.0

// Why `go 1.23` when the toolchain line says go1.24.0: read before bumping.
//
// test.yml and ci.yml run Go 1.23.x with GOTOOLCHAIN=local, so any `go`
// line above 1.23 stops every one of their jobs at go.mod load ("go.mod
// requires go >= 1.24 (running go 1.23.12; GOTOOLCHAIN=local)", the first CI
// run of this branch). The code needs nothing newer: go vet's stdversion
// check, run with a Go 1.25 vet that knows the 1.24 API, finds no use of a
// post-1.22 standard-library symbol. 1.23 rather than 1.22 keeps the Go 1.23
// timer semantics under test, which are the ones release builds ship with.
//
// A lower `go` line also lowers the default GODEBUG baseline. Built by Go
// 1.24+, a go-1.23 binary silently loses hybrid post-quantum TLS
// (tlsmlkem=0) and the 1024-bit RSA floor (rsa1024min=0), among others.
// cmd/otedama/godebug_go124.go restores the Go 1.24 baseline on toolchains
// that have one, and TestDefaultGODEBUG_KeepsGo124Baseline fails without it.
// There is no godebug block, because Go 1.23 rejects keys it does not know.
// That is what kept master's CI red (`unknown godebug "tlsmlkem"`).
//
// Once every workflow runs Go 1.24+ (or drops GOTOOLCHAIN=local), set this to
// `go 1.24` and delete godebug_go124.go. Measurements: GODEBUG_NOTES.md.

require (
	golang.org/x/crypto v0.23.0
	gopkg.in/yaml.v3 v3.0.1
)

require golang.org/x/sys v0.20.0 // indirect
