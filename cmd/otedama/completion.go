// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Command otedama — completion.go
//
// Shell-completion script generation. Otedama uses a hand-rolled CLI
// (no cobra), so the completion scripts are static and list the known
// subcommands. Keep the command lists below in sync with the dispatch
// switch in run() and with printUsage.
package main

import (
	"fmt"
	"io"
	"strings"
)

// completionShells are the shells `otedama completion` can emit for.
var completionShells = []string{"bash", "zsh", "fish"}

// cmdCompletion writes a shell-completion script for the requested shell.
//
//	otedama completion bash  > /etc/bash_completion.d/otedama
//	otedama completion zsh   > "${fpath[1]}/_otedama"
//	otedama completion fish  > ~/.config/fish/completions/otedama.fish
func cmdCompletion(args []string, stdout, stderr io.Writer) int {
	// `otedama completion --help` is a correct invocation, not a mistake.
	// Every other subcommand gets this from parseSubcommandFlags; this one
	// defines no FlagSet, so it fell through to the "expected one shell
	// argument" error and exited 64 — the exact failure parseSubcommandFlags
	// was written to eliminate, indistinguishable to a script from a real
	// usage error. Found by TestCompletion_ListsEveryDispatchedSubcommand.
	if len(args) == 1 && hasHelpFlag(args) {
		fmt.Fprintf(stdout, "Usage: otedama completion <%s>\n\n", strings.Join(completionShells, "|"))
		fmt.Fprint(stdout, `Writes a shell-completion script to standard output.

  otedama completion bash  > /etc/bash_completion.d/otedama
  otedama completion zsh   > "${fpath[1]}/_otedama"
  otedama completion fish  > ~/.config/fish/completions/otedama.fish
`)
		return exitOK
	}
	if len(args) != 1 {
		fmt.Fprintf(stderr, "otedama completion: expected one shell argument (%s)\n", joinOr(completionShells))
		return exitUsage
	}
	switch args[0] {
	case "bash":
		fmt.Fprint(stdout, bashCompletion)
	case "zsh":
		fmt.Fprint(stdout, zshCompletion)
	case "fish":
		fmt.Fprint(stdout, fishCompletion)
	default:
		fmt.Fprintf(stderr, "otedama completion: unsupported shell %q (want %s)\n", args[0], joinOr(completionShells))
		return exitUsage
	}
	return exitOK
}

// joinOr renders a slice as "a, b or c" for human-readable error messages.
func joinOr(items []string) string {
	switch len(items) {
	case 0:
		return ""
	case 1:
		return items[0]
	}
	out := ""
	for i, s := range items {
		switch {
		case i == 0:
			out = s
		case i == len(items)-1:
			out += " or " + s
		default:
			out += ", " + s
		}
	}
	return out
}

const bashCompletion = `# bash completion for otedama
_otedama() {
    local cur="${COMP_WORDS[COMP_CWORD]}"
    local commands="run version config service doctor wallet help completion"
    if [ "${COMP_CWORD}" -eq 1 ]; then
        COMPREPLY=( $(compgen -W "${commands}" -- "${cur}") )
        return
    fi
    case "${COMP_WORDS[1]}" in
        config)     COMPREPLY=( $(compgen -W "show validate" -- "${cur}") ) ;;
        service)    COMPREPLY=( $(compgen -W "install uninstall status" -- "${cur}") ) ;;
        wallet)     COMPREPLY=( $(compgen -W "verify" -- "${cur}") ) ;;
        completion) COMPREPLY=( $(compgen -W "bash zsh fish" -- "${cur}") ) ;;
    esac
}
complete -F _otedama otedama
`

const zshCompletion = `#compdef otedama
# zsh completion for otedama
_otedama() {
    local -a commands
    commands=(run version config service doctor wallet help completion)
    if (( CURRENT == 2 )); then
        _describe 'otedama command' commands
        return
    fi
    case $words[2] in
        config)     _values 'config subcommand' show validate ;;
        service)    _values 'service subcommand' install uninstall status ;;
        wallet)     _values 'wallet subcommand' verify ;;
        completion) _values 'shell' bash zsh fish ;;
    esac
}
compdef _otedama otedama
`

const fishCompletion = `# fish completion for otedama
complete -c otedama -f
complete -c otedama -n __fish_use_subcommand -a run        -d 'Start mining and/or compute workloads'
complete -c otedama -n __fish_use_subcommand -a version    -d 'Print version information'
complete -c otedama -n __fish_use_subcommand -a config     -d 'Inspect or validate configuration'
complete -c otedama -n __fish_use_subcommand -a service    -d 'Install/uninstall background service'
complete -c otedama -n __fish_use_subcommand -a doctor     -d 'Run self-diagnostic checks'
complete -c otedama -n __fish_use_subcommand -a wallet     -d 'Verify a recovery phrase against the stored wallet'
complete -c otedama -n __fish_use_subcommand -a help       -d 'Print help'
complete -c otedama -n __fish_use_subcommand -a completion -d 'Generate shell completion'
complete -c otedama -n '__fish_seen_subcommand_from config'     -a 'show validate'
complete -c otedama -n '__fish_seen_subcommand_from service'    -a 'install uninstall status'
complete -c otedama -n '__fish_seen_subcommand_from wallet'     -a 'verify'
complete -c otedama -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish'
`
