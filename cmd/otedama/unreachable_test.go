// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Command otedama — unreachable_test.go
//
// A repo-wide guard against code that is written, tested, and called by
// nothing. It lives here because this package is the product's integration
// point (every internal package is reachable from cmd/otedama or from nothing
// at all) and because CLAUDE.md's architecture map does not permit inventing a
// package to hold it.

package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// knownTestOnlyFuncs is the baseline: exported functions and methods whose only
// callers today are tests. The guard fails when this set GROWS, so adding a
// symbol nothing calls is a build failure rather than a discovery three
// sessions later.
//
// Why this exists. Three times now this repository has carried code that was
// implemented, unit-tested, and reachable from no production call site:
//
//   - The Noise NX handshake. Fully tested, wired into no dial path, so every
//     stratum+v2:// connection ran in the clear while THREAT_MODEL described
//     pool authentication as mitigated (KNOWN_LIMITATIONS §2).
//   - wallet change-passphrase. Implemented and tested in internal/lightning,
//     with no CLI path to it until session 264 (§16).
//   - metrics.RuntimeCollector. Twelve go_* series, unit-tested, registered by
//     nothing until session 266, so /metrics served none of them.
//
// Coverage does not catch this: all three were "covered". A test proves a
// function works; it says nothing about whether the product calls it.
//
// Each entry below is here for one of two reasons, and the difference matters:
// a test seam is fine forever, a stranded capability is a defect with a
// disclosure. Removing an entry (by wiring it up or deleting it) is always
// welcome and never fails this test.
var knownTestOnlyFuncs = map[string]string{
	// --- Deliberate test seams: exported so tests can drive them. Fine. ---
	"clock.NewFake": "fake clock constructor, exists for tests by design",
	"clock.Advance": "fake clock control, same",

	// --- Stranded capability, disclosed: KNOWN_LIMITATIONS §2. ---
	// The whole Noise NX surface. These are the mechanical proof of §2: if
	// the handshake were wired into a dial path, they would not be here.
	"stratum.NewHandshakeInitiator": "Noise NX unwired — §2",
	"stratum.NewEncryptedConn":      "Noise NX unwired — §2",
	"stratum.WriteMessage1":         "Noise NX unwired — §2",
	"stratum.ReadMessage2":          "Noise NX unwired — §2",
	"stratum.Complete":              "Noise NX unwired — §2",
	"stratum.Transport":             "HandshakeState.Transport — Noise NX unwired — §2",
	"stratum.Read":                  "EncryptedConn.Read — Noise NX unwired — §2",

	// --- Pure helpers kept as a tested vocabulary for the packages that own
	// them. Not defects, but not load-bearing either; delete on sight if a
	// refactor orphans them for good. ---
	"btccrypto.SchemeForAddressType": "address-type dispatch, reachable API",
	"btccrypto.Schemes":              "scheme enumeration",
	"btccrypto.TaggedHash":           "BIP-340 tagged hash, no caller yet",
	"miner.MeetsTarget":              "target comparison helper",
	"miner.NBitsFromTarget":          "inverse of TargetFromNBits",
	"miner.ParseHeader":              "header decode helper",
	"miner.CurrentWork":              "worker introspection",
	"miner.HasWork":                  "worker introspection",
	"stratum.ExtensionID":            "frame header accessor",
	"stratum.ValidateSetupConnection": "semantic validator for a message " +
		"Otedama only ever sends; would matter in a server role, which " +
		"ADR-001 rules out",
	"tui.FormatDuration": "exported formatter, used via its package-internal caller",
	"tui.FormatHashRate": "same",
	"tui.SatsToDisplay":  "same",
	"tui.SetWidth":       "width override, exercised by the PTY tests",
	"logger.FromContext": "context plumbing, no caller yet",
	"logger.IntoContext": "context plumbing, no caller yet",
	"logger.SetDefault":  "global logger override",
	"i18n.Languages":     "catalogue introspection",
	"i18n.MissingTranslations": "reports untranslated IDs; nothing calls it, " +
		"so the completeness check runs only in tests",
	"messages.AllIDs":            "catalogue introspection",
	"poolproto.Available":        "registry introspection",
	"poolproto.PostQuantumReady": "always false since the PQ scaffold was deleted (§5)",
	"httpserver.ServeError":      "startup-error accessor",
}

// TestNoNewTestOnlyExportedFuncs fails when an exported function or method in
// internal/ or cmd/ has no non-test caller and is not in the baseline above.
func TestNoNewTestOnlyExportedFuncs(t *testing.T) {
	root := filepath.Join("..", "..")

	type decl struct{ pkg, name string }
	decls := map[string]decl{}          // "pkg.Name" -> decl
	prodUses := map[string]int{}        // "pkg.Name" -> non-test reference count
	testUses := map[string]int{}        // "pkg.Name" -> test reference count
	nameToKeys := map[string][]string{} // bare identifier -> candidate keys

	fset := token.NewFileSet()
	var files []string
	for _, dir := range []string{"internal", "cmd"} {
		err := filepath.Walk(filepath.Join(root, dir), func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return err
			}
			if !info.IsDir() && strings.HasSuffix(path, ".go") {
				files = append(files, path)
			}
			return nil
		})
		if err != nil {
			t.Fatalf("walk %s: %v", dir, err)
		}
	}
	if len(files) == 0 {
		t.Fatal("no Go files found — run from the package directory; this guard needs the repo tree")
	}

	// Pass 1: collect exported declarations from non-test files.
	for _, path := range files {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", path, err)
		}
		pkg := f.Name.Name
		for _, d := range f.Decls {
			fn, ok := d.(*ast.FuncDecl)
			if !ok || fn.Name == nil || !fn.Name.IsExported() {
				continue
			}
			if pkg == "main" && fn.Name.Name == "Main" {
				continue
			}
			key := pkg + "." + fn.Name.Name
			if _, seen := decls[key]; !seen {
				decls[key] = decl{pkg: pkg, name: fn.Name.Name}
				nameToKeys[fn.Name.Name] = append(nameToKeys[fn.Name.Name], key)
			}
		}
	}

	// Pass 2: count identifier uses, skipping each declaration's own name node.
	for _, path := range files {
		f, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", path, err)
		}
		isTest := strings.HasSuffix(path, "_test.go")
		declNames := map[*ast.Ident]bool{}
		for _, d := range f.Decls {
			if fn, ok := d.(*ast.FuncDecl); ok && fn.Name != nil {
				declNames[fn.Name] = true
			}
		}
		ast.Inspect(f, func(n ast.Node) bool {
			id, ok := n.(*ast.Ident)
			if !ok || declNames[id] {
				return true
			}
			for _, key := range nameToKeys[id.Name] {
				if isTest {
					testUses[key]++
				} else {
					prodUses[key]++
				}
			}
			return true
		})
	}

	var stranded []string
	for key := range decls {
		if prodUses[key] == 0 && testUses[key] > 0 {
			stranded = append(stranded, key)
		}
	}
	sort.Strings(stranded)

	for _, key := range stranded {
		if _, known := knownTestOnlyFuncs[key]; !known {
			t.Errorf("%s is exported, exercised by tests, and called by no non-test code.\n"+
				"    Either wire it into the product, delete it, or — if it is a deliberate test seam or a\n"+
				"    disclosed gap — add it to knownTestOnlyFuncs with the reason. Three real defects in this\n"+
				"    repository had exactly this shape; see the comment on that map.", key)
		}
	}

	// The baseline must not rot either: an entry that no longer applies is a
	// stale exemption that would hide the next instance.
	for key := range knownTestOnlyFuncs {
		if _, exists := decls[key]; !exists {
			t.Errorf("knownTestOnlyFuncs lists %q, which no longer exists — remove the entry", key)
			continue
		}
		if prodUses[key] > 0 {
			t.Errorf("knownTestOnlyFuncs lists %q, but it now has %d non-test callers — remove the entry",
				key, prodUses[key])
		}
	}
}
