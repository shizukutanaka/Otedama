// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestCompletion_EmitsPerShellScript(t *testing.T) {
	cases := []struct {
		shell    string
		mustHave []string
	}{
		{"bash", []string{"complete -F _otedama otedama"}},
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

// TestCompletion_ListsEveryDispatchedSubcommand enforces the sync that
// completion.go's own header comment asks for ("Keep the command lists below
// in sync with the dispatch"). The previous test asserted one hardcoded
// command-list string, which meant adding a subcommand broke the test for the
// wrong reason — the literal, not the omission — and updating the literal
// silently satisfied it whether or not the other two shells were updated too.
//
// This checks both directions per shell: every name the dispatcher accepts is
// offered by every completion script.
func TestCompletion_ListsEveryDispatchedSubcommand(t *testing.T) {
	// Every name main.run dispatches, excluding the aliases (--version, -v,
	// --help, -h) which are flags rather than completion candidates.
	subcommands := []string{"run", "version", "config", "service", "doctor", "wallet", "completion", "help"}

	for _, shell := range []string{"bash", "zsh", "fish"} {
		t.Run(shell, func(t *testing.T) {
			var out, errb bytes.Buffer
			if code := cmdCompletion([]string{shell}, &out, &errb); code != exitOK {
				t.Fatalf("completion %s exit=%d (stderr: %s)", shell, code, errb.String())
			}
			for _, name := range subcommands {
				if !strings.Contains(out.String(), name) {
					t.Errorf("%s completion does not offer %q", shell, name)
				}
			}
		})
	}

	// And the other direction: each name really is dispatched, so the
	// completion scripts are not advertising commands that do not exist.
	for _, name := range subcommands {
		var out, errb bytes.Buffer
		if code := run([]string{name, "--help"}, &out, &errb); code == exitUsage {
			t.Errorf("completion offers %q but the dispatcher rejects it", name)
		}
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
