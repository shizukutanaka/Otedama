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
