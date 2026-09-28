// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package main

import (
	"bytes"
	"os"
	"regexp"
	"strings"
	"testing"
)

func TestCompletion_EmitsPerShellScript(t *testing.T) {
	cases := []struct {
		shell    string
		mustHave []string
	}{
		{"bash", []string{"complete -F _otedama otedama", "run version config service doctor help completion"}},
		{"zsh", []string{"#compdef otedama", "compdef _otedama otedama"}},
		{"fish", []string{"__fish_use_subcommand", "complete -c otedama"}},
	}
	for _, tc := range cases {
		t.Run(tc.shell, func(t *testing.T) {
			var out, errb bytes.Buffer
			if code := cmdCompletion([]string{tc.shell}, &out, &errb); code != exitOK {
				t.Fatalf("completion %s exit=%d, want %d (stderr: %s)", tc.shell, code, exitOK, errb.String())
			}
			for _, want := range tc.mustHave {
				if !strings.Contains(out.String(), want) {
					t.Errorf("%s completion missing %q", tc.shell, want)
				}
			}
		})
	}
}

func TestCompletion_RejectsBadArgs(t *testing.T) {
	for _, args := range [][]string{{}, {"powershell"}, {"bash", "extra"}} {
		var out, errb bytes.Buffer
		if code := cmdCompletion(args, &out, &errb); code != exitUsage {
			t.Errorf("completion %v exit=%d, want exitUsage(%d)", args, code, exitUsage)
		}
		if out.Len() != 0 {
			t.Errorf("completion %v wrote a script on the error path: %q", args, out.String())
		}
	}
}

func TestRun_CompletionSubcommandDispatches(t *testing.T) {
	var out, errb bytes.Buffer
	if code := run([]string{"completion", "fish"}, &out, &errb); code != exitOK {
		t.Fatalf("run completion fish exit=%d, want %d", code, exitOK)
	}
	if !strings.Contains(out.String(), "complete -c otedama") {
		t.Error("run did not dispatch to cmdCompletion")
	}
}

// ============================================================================
// joinOr — edge cases (0-item and 1-item slices)
// ============================================================================

func TestJoinOr_EmptySliceReturnsEmpty(t *testing.T) {
	if got := joinOr(nil); got != "" {
		t.Errorf("joinOr(nil) = %q, want empty", got)
	}
	if got := joinOr([]string{}); got != "" {
		t.Errorf("joinOr([]) = %q, want empty", got)
	}
}

func TestJoinOr_SingleItemReturnsIt(t *testing.T) {
	if got := joinOr([]string{"bash"}); got != "bash" {
		t.Errorf("joinOr([bash]) = %q, want bash", got)
	}
}

func TestJoinOr_TwoItemsUsesOr(t *testing.T) {
	got := joinOr([]string{"bash", "zsh"})
	if !strings.Contains(got, "bash") || !strings.Contains(got, "zsh") || !strings.Contains(got, "or") {
		t.Errorf("joinOr([bash,zsh]) = %q, want 'bash or zsh' form", got)
	}
}

// TestCompletion_VerbListsMatchDispatch pins the sync the file header
// demands: the three static completion scripts list subcommands
// verbatim, so adding a dispatch case without updating them produces
// scripts that can never complete it (the class of drift that let a
// subcommand ship un-completable). Parses the canonical verbs out of
// run()'s switch and asserts each script's verb list covers them.
func TestCompletion_VerbListsMatchDispatch(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	// Canonical verbs = the first bare (non-dash) word of each case's
	// quoted alternatives in the dispatch switch on args[0].
	dispatch := map[string]bool{}
	for _, m := range regexp.MustCompile(`case\s+"([a-z][a-z-]*)"`).FindAllStringSubmatch(string(src), -1) {
		dispatch[m[1]] = true
	}
	if len(dispatch) < 5 {
		t.Fatalf("dispatch verb extraction found only %v — main.go layout changed?", dispatch)
	}

	// bash/zsh declare their verb list on one commands= line each;
	// fish lists one -a <verb> entry per line.
	scripts := map[string][]string{
		"bash": regexp.MustCompile(`local commands="([^"]+)"`).FindStringSubmatch(bashCompletion)[1:2],
		"zsh":  regexp.MustCompile(`commands=\(([^)]+)\)`).FindStringSubmatch(zshCompletion)[1:2],
	}
	bashVerbs := strings.Fields(scripts["bash"][0])
	zshVerbs := strings.Fields(scripts["zsh"][0])
	fishVerbs := []string{}
	for _, m := range regexp.MustCompile(`-a (\w+)\s+-d `).FindAllStringSubmatch(fishCompletion, -1) {
		fishVerbs = append(fishVerbs, m[1])
	}
	for shell, verbs := range map[string][]string{"bash": bashVerbs, "zsh": zshVerbs, "fish": fishVerbs} {
		set := map[string]bool{}
		for _, v := range verbs {
			set[v] = true
		}
		for v := range dispatch {
			if !set[v] {
				t.Errorf("%s completion missing dispatch verb %q", shell, v)
			}
		}
		for v := range set {
			if !dispatch[v] {
				t.Errorf("%s completion lists %q but no such subcommand exists", shell, v)
			}
		}
	}
}
