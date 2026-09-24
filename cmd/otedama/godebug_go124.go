// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

//go:build go1.24

// go.mod declares `go 1.23` so that CI's Go 1.23 runners, which set
// GOTOOLCHAIN=local, can load the module at all (the comment there has the
// details). The `go` line also sets the default GODEBUG baseline, and a Go
// 1.24+ toolchain building a go-1.23 module reverts every behaviour change Go
// 1.24 made, including hybrid post-quantum TLS key exchange (tlsmlkem=0) and
// the refusal of RSA keys under 1024 bits (rsa1024min=0). Nothing fails when
// that happens. This directive puts the otedama binary back on the Go 1.24
// baseline wherever the toolchain has one.
//
// The build constraint is what makes it safe on Go 1.23. go/build ignores
// //go:debug lines in files a constraint excludes, while a toolchain that
// does read `default=` refuses a version newer than itself (go1.24.7 refuses
// default=go1.25 in exactly that way).
//
// Measured with `go version -m` on the built binary: with this file, a
// go1.24.7 build's DefaultGODEBUG is empty and a go1.25.1 build lists only
// Go 1.25's own changes, identical to a `go 1.24` line. Without it both gain
// tlsmlkem=0, rsa1024min=0, x509rsacrt=0, x509usepolicies=0, multipathtcp=0,
// randseednop=0 and gotestjsonbuildtext=1. TestDefaultGODEBUG_KeepsGo124Baseline
// fails if this file goes missing.
//
// Delete this file, and raise go.mod to `go 1.24`, once CI runs Go 1.24+.

//go:debug default=go1.24

package main
